'use strict';

// Direct-to-APNs sender for iOS 26 WidgetKit push subscriptions.
//
// Core registers a widget's push token + tracked entities and, when one of those
// entities changes, POSTs a { push_subscription, push_token, registration_info }
// payload to this relay (the same push_url as normal notifications).
//
// The push_token here is a WidgetKit widget push token — a raw APNs token that
// FCM has no mapping for, so messaging.send() can't deliver it. This module
// bypasses the FCM SDK for this one path and talks to APNs directly over HTTP/2,
// authenticating with the APNs auth key (.p8) provided as a Functions secret.

const http2 = require('node:http2');
const crypto = require('node:crypto');

// Xcode/dev builds get sandbox tokens; App Store / TestFlight get production ones.
// The token itself doesn't say which, so we try production and fall back to
// sandbox when APNs replies BadDeviceToken (wrong environment).
const APNS_HOST_PRODUCTION = 'api.push.apple.com';
const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';

// iOS 26 WidgetKit push: apns-push-type is "widgets" and the topic is the app's
// bundle id with a ".push-type.widgets" suffix.
const APNS_PUSH_TYPE = 'widgets';
const WIDGET_TOPIC_SUFFIX = '.push-type.widgets';

// Provider JWTs are valid up to 1 hour and APNs rate-limits token creation, so we
// sign once and reuse well within the window.
const JWT_TTL_MS = 40 * 60 * 1000;

// The token and app id go straight into the APNs :path and apns-topic, so reject
// anything malformed before building the request: device tokens are hex, bundle
// ids are reverse-DNS labels (letters, digits, dots, hyphens).
const HEX_TOKEN = /^[0-9a-f]+$/i;
const BUNDLE_ID = /^[A-Za-z0-9.-]+$/;

// Secret Manager names, injected as env vars at runtime via defineSecret/runWith.
const SECRETS = ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID'];

let cachedJwt = null;
let cachedJwtAt = 0;

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// Builds an APNs provider-auth JWT signed with the .p8 key (ES256). The private
// key never leaves the function; only this signature travels to Apple.
function signProviderToken() {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID }));
  const payload = base64url(
    JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }),
  );
  const signingInput = `${header}.${payload}`;

  // dsaEncoding 'ieee-p1363' yields the raw R||S signature that JWS/ES256 expects
  // (Node's default is DER, which APNs would reject).
  const signature = crypto
    .sign('sha256', Buffer.from(signingInput), {
      key: process.env.APNS_KEY_P8,
      dsaEncoding: 'ieee-p1363',
    })
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${signingInput}.${signature}`;
}

function providerToken() {
  const now = Date.now();
  if (!cachedJwt || now - cachedJwtAt > JWT_TTL_MS) {
    cachedJwt = signProviderToken();
    cachedJwtAt = now;
  }
  return cachedJwt;
}

// Sends one request to APNs over HTTP/2 and resolves with { status, apnsId, body }.
function postToApns(host, deviceToken, headers, body) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    client.on('error', (err) => {
      client.close();
      reject(err);
    });

    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      ...headers,
    });

    let status;
    let apnsId;
    let data = '';
    request.on('response', (responseHeaders) => {
      status = responseHeaders[':status'];
      apnsId = responseHeaders['apns-id'];
    });
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      data += chunk;
    });
    request.on('end', () => {
      client.close();
      resolve({ status, apnsId, body: data });
    });
    request.on('error', (err) => {
      client.close();
      reject(err);
    });

    request.end(body);
  });
}

// Records the send outcome for a token, best-effort — the push has already been
// sent, so a rate-limiter write failure here must not change the response.
async function recordOutcome(rateLimiter, token, succeeded) {
  try {
    await (succeeded ? rateLimiter.recordSuccess(token) : rateLimiter.recordError(token));
  } catch {
    // Accounting is best-effort and must not affect delivery.
  }
}

// Handles a widget push_subscription payload by sending a silent WidgetKit
// refresh straight to APNs.
async function sendWidgetPush(req, res) {
  const token = req.body.push_token;
  const appId = req.body.registration_info && req.body.registration_info.app_id;

  if (!token) {
    return res.status(403).send({ errorMessage: 'You did not send a token!' });
  }
  if (!appId) {
    return res.status(400).send({ errorMessage: 'Missing registration_info.app_id' });
  }
  if (!HEX_TOKEN.test(token)) {
    return res.status(400).send({ errorMessage: 'Invalid push token format' });
  }
  if (!BUNDLE_ID.test(appId)) {
    return res.status(400).send({ errorMessage: 'Invalid app id format' });
  }
  if (!process.env.APNS_KEY_P8 || !process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID) {
    return res.status(500).send({ errorMessage: 'APNs credentials are not configured' });
  }

  // Widget pushes are rate-limited per token (with their own daily cap) so a
  // widget push token can't be used to hammer APNs (cost, throttling, device
  // battery drain). Required lazily so it uses the instance index.js initialises
  // once the environment is set.
  const { widgetRateLimiter: rateLimiter } = require('./handlers');
  let attempt;
  try {
    attempt = await rateLimiter.recordAttempt(token);
  } catch (err) {
    return res.status(500).send({ errorMessage: `Rate limit check failed: ${err.message}` });
  }
  if (attempt.isRateLimited) {
    return res.status(429).send({
      errorType: 'RateLimited',
      message:
        'The given target has reached the maximum number of notifications allowed per day. Please try again later.',
      target: token,
      rateLimits: attempt.rateLimits,
    });
  }

  const headers = {
    'apns-topic': `${appId}${WIDGET_TOPIC_SUFFIX}`,
    'apns-push-type': APNS_PUSH_TYPE,
    'apns-priority': '5',
  };
  // Silent and data-free: WidgetKit just reloads the widget's timeline.
  const body = JSON.stringify({ aps: { 'content-changed': true } });

  let result;
  try {
    result = await postToApns(
      APNS_HOST_PRODUCTION,
      token,
      { ...headers, authorization: `bearer ${providerToken()}` },
      body,
    );

    if (result.status === 400 && result.body.includes('BadDeviceToken')) {
      result = await postToApns(
        APNS_HOST_SANDBOX,
        token,
        { ...headers, authorization: `bearer ${providerToken()}` },
        body,
      );
    }
  } catch (err) {
    return res.status(502).send({ errorMessage: `Failed to reach APNs: ${err.message}` });
  }

  if (result.status === 200) {
    await recordOutcome(rateLimiter, token, true);
    return res.status(201).send({
      target: token,
      messageId: result.apnsId,
      pushType: APNS_PUSH_TYPE,
    });
  }

  await recordOutcome(rateLimiter, token, false);
  return res.status(result.status || 502).send({
    errorMessage: `APNs rejected the widget push: ${result.body || 'unknown error'}`,
  });
}

module.exports = { sendWidgetPush, SECRETS };
