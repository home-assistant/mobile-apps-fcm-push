'use strict';

// Direct APNs HTTP/2 client used for iOS Live Activity push notifications.
//
// Live Activity push tokens are hex-encoded direct APNs tokens — they are NOT FCM tokens.
// FCM tokens always contain a colon and are routed through Firebase; Live Activity tokens
// bypass Firebase entirely and must be delivered directly to api.push.apple.com via HTTP/2.
// Additionally, FCM does not support apns-push-type: liveactivity, so this path is required.
//
// Required environment variables:
//   APNS_TEAM_ID     - 10-character Apple Developer Team ID
//   APNS_KEY_ID      - 10-character key ID for the .p8 signing key
//   APNS_PRIVATE_KEY - Contents of the .p8 file (newlines may be escaped as \n)

const crypto = require('crypto');
const http2 = require('http2');

const APNS_HOST_PRODUCTION = 'api.push.apple.com';
const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';

// JWT is valid for up to 60 minutes; rotate at 45 to stay well within that window.
const JWT_ROTATION_MS = 45 * 60 * 1000;

let jwtCache = null;
let jwtGeneratedAt = 0;

// Cached HTTP/2 sessions keyed by environment.
const sessions = {};

function getApnsHost(environment) {
  return environment === 'sandbox' ? APNS_HOST_SANDBOX : APNS_HOST_PRODUCTION;
}

function generateJWT() {
  if (jwtCache && Date.now() - jwtGeneratedAt < JWT_ROTATION_MS) {
    return jwtCache;
  }

  const teamId = process.env.APNS_TEAM_ID;
  const keyId = process.env.APNS_KEY_ID;
  const privateKey = (process.env.APNS_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!teamId || !keyId || !privateKey) {
    throw new Error('Missing APNs credentials: APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY required');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: teamId, iat: now })).toString('base64url');
  const signingInput = `${header}.${payload}`;

  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  // ieee-p1363 produces the raw r||s format required for JWT ES256 (not DER-encoded).
  const signature = sign.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');

  jwtCache = `${signingInput}.${signature}`;
  jwtGeneratedAt = Date.now();

  return jwtCache;
}

// Returns a cached HTTP/2 session for the given APNs environment.
// Sessions are cached at module level so warm Cloud Function instances reuse the same
// persistent connection rather than re-establishing a TLS handshake on every request.
// Sandbox and production use separate sessions because they connect to different hosts;
// APNs will reject a production token sent to the sandbox endpoint and vice versa.
function getSession(environment) {
  const existing = sessions[environment];
  if (existing && !existing.destroyed && !existing.closed) {
    return existing;
  }

  const host = getApnsHost(environment);
  const session = http2.connect(`https://${host}`);
  session.on('error', () => {
    // Clean up the cached reference so the next call creates a fresh session.
    session.destroy();
    delete sessions[environment];
  });
  sessions[environment] = session;
  return session;
}

/**
 * Sends a payload directly to the APNs HTTP/2 API.
 *
 * @param {string} token - Hex-encoded APNs push token.
 * @param {object} payload - APNs JSON payload object.
 * @param {object} extraHeaders - Platform-specific APNs headers (apns-push-type, apns-topic, etc.).
 * @param {string} environment - 'sandbox' or 'production'.
 * @returns {Promise<{ apnsId: string, status: number, body: object }>}
 */
async function send(token, payload, extraHeaders, environment) {
  const jwt = generateJWT();
  const host = getApnsHost(environment);
  const session = getSession(environment);
  const body = JSON.stringify(payload);

  const reqHeaders = {
    ':method': 'POST',
    ':path': `/3/device/${token}`,
    ':scheme': 'https',
    ':authority': host,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    authorization: `bearer ${jwt}`,
    ...extraHeaders,
  };

  return new Promise((resolve, reject) => {
    const req = session.request(reqHeaders);

    let responseHeaders = {};
    let responseBody = '';

    req.on('response', (headers) => {
      responseHeaders = headers;
    });

    req.on('data', (chunk) => {
      responseBody += chunk;
    });

    req.on('end', () => {
      const status = responseHeaders[':status'];
      let parsedBody;
      if (!responseBody) {
        parsedBody = {};
      } else {
        try {
          parsedBody = JSON.parse(responseBody);
        } catch (e) {
          // APNs or an intermediary returned a non-JSON body; preserve the raw text.
          parsedBody = { raw: responseBody };
        }
      }
      resolve({ status, apnsId: responseHeaders['apns-id'] ?? null, body: parsedBody });
    });

    req.on('error', reject);

    req.write(body);
    req.end();
  });
}

module.exports = { send };
