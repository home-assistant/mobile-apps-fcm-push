'use strict';

const crypto = require('node:crypto');

const { ApnsProvider } = require('./apns-provider');

// Apple's push-to-start event, `start`, is deliberately absent. A Home Assistant Now Playing
// session exists because the user chose Follow on a media player, so there is nothing to start.
const SUPPORTED_EVENTS = Object.freeze(['update', 'end']);

// Apple routes a Now Playing push by this suffix on the *containing app's* bundle identifier,
// not the extension's: `<app id>.RemoteMedia` as the topic fails.
const NOW_PLAYING_TOPIC_SUFFIX = '.push-type.nowplaying';
const NOW_PLAYING_PUSH_TYPE = 'nowplaying';

// A bundle identifier is reverse-DNS: alphanumerics and hyphens per label, at least two labels.
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const MAX_APP_ID_LENGTH = 155;

// Home Assistant's Apple apps all ship under one App Store identifier, TestFlight builds and Mac
// Catalyst included, so it is built in. Anything else, including the `.dev` identifier debug
// builds use, has to be named by the deployment: comma-separated, exact identifiers only.
const OFFICIAL_APP_ID = 'io.robbie.HomeAssistant';
const ALLOWED_APP_IDS_VARIABLE = 'NOW_PLAYING_APNS_ALLOWED_APP_IDS';

// Apple's documented maximum notification payload. Checked before a connection is opened,
// because an oversized payload can only be refused.
const MAX_PAYLOAD_BYTES = 4096;

// A destination token is a device-scoped identifier that can be pushed to. Logs and responses
// carry this many characters of its SHA-256 instead of the token itself.
const TOKEN_FINGERPRINT_LENGTH = 16;

/**
 * Whether this request wants Now Playing delivery rather than FCM.
 *
 * @param {object} body
 */
function isNowPlayingRequest(body) {
  return Boolean(body && body.now_playing_token);
}

/**
 * Validates a Now Playing request and returns the APNs send it implies, or the reason it cannot.
 *
 * Validation stops at what is needed to build safe APNs traffic. The attributes themselves are
 * Home Assistant's versioned contract with the iOS app: this checks that `id` is present, because
 * iOS routes the push by it and a payload without one is silently discarded by the device, and
 * otherwise forwards the object untouched so a newer schema passes through an older relay.
 *
 * @param {object} body
 * @returns {{ ok: boolean, status?: number, error?: object, event?: string,
 *             request?: { token: string, topic: string, pushType: string, body: Buffer } }}
 */
function prepareNowPlaying(body) {
  const token = body.now_playing_token;

  if (body.live_activity_token) {
    // One request cannot mean both, and guessing would send the wrong thing to the wrong token.
    return invalid(
      400,
      'AmbiguousRequest',
      'A request may not carry both live_activity_token and now_playing_token.',
    );
  }

  if (typeof token !== 'string' || !/^[0-9a-fA-F]+$/.test(token) || token.length % 2 !== 0) {
    return invalid(400, 'InvalidNowPlayingToken', 'now_playing_token must be a hex string.');
  }

  const request = body.now_playing;
  if (!isPlainObject(request)) {
    return invalid(400, 'InvalidNowPlayingRequest', 'now_playing must be an object.');
  }

  const { event, timestamp, attributes } = request;

  if (!SUPPORTED_EVENTS.includes(event)) {
    return invalid(
      400,
      'UnsupportedNowPlayingEvent',
      `now_playing.event must be one of: ${SUPPORTED_EVENTS.join(', ')}.`,
    );
  }

  // Home Assistant owns the ordering clock. APNs sequences a session's pushes by this value and
  // several state changes can land inside one second, so the relay forwards what it is given
  // rather than stamping its own. It is not the media position timestamp inside the attributes.
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return invalid(
      400,
      'InvalidNowPlayingTimestamp',
      'now_playing.timestamp must be a positive integer of Unix seconds.',
    );
  }

  if (!isPlainObject(attributes)) {
    return invalid(400, 'InvalidNowPlayingAttributes', 'now_playing.attributes must be an object.');
  }
  if (typeof attributes.id !== 'string' || attributes.id.length === 0) {
    // iOS matches the push to a live session by this. Without it APNs still answers 200 and the
    // device throws the push away, which is indistinguishable from a delivery failure.
    return invalid(
      400,
      'MissingNowPlayingSessionId',
      'now_playing.attributes.id must be a non-empty string.',
    );
  }

  const topic = nowPlayingTopic(body.registration_info);
  if (!topic) {
    // 403 rather than 400: the request is well formed, this relay just does not serve that app.
    // The refusal does not name the configured apps.
    return invalid(
      403,
      'UnsupportedApp',
      'This relay is not configured to send Now Playing updates for that app.',
    );
  }

  const payload = Buffer.from(JSON.stringify({ aps: { event, timestamp, attributes } }));
  if (payload.length > MAX_PAYLOAD_BYTES) {
    return invalid(
      413,
      'PayloadTooLarge',
      `Now Playing payload is ${payload.length} bytes; APNs allows ${MAX_PAYLOAD_BYTES}.`,
    );
  }

  return {
    ok: true,
    event,
    request: { token, topic, pushType: NOW_PLAYING_PUSH_TYPE, body: payload },
  };
}

/**
 * The APNs topic for a registration, or `null` when this relay will not address that app.
 *
 * The topic is derived here and never taken from the request: `registration_info.app_id` arrives
 * in a body to a public endpoint, and it selects an APNs topic under a team-scoped signing key,
 * so a syntactically valid bundle identifier is not an authorized one. Otherwise anything the
 * team can sign would be reachable through this endpoint. Matching is exact, and the syntax check
 * is kept as well, which is what makes a configured `*` harmless: it can only ever match the
 * literal string `*`, and that is not a bundle identifier.
 *
 * Configuration is read per call so a deployment change takes effect without a cold start.
 *
 * @param {unknown} registrationInfo
 * @returns {string | null}
 */
function nowPlayingTopic(registrationInfo) {
  const appId = isPlainObject(registrationInfo) ? registrationInfo.app_id : undefined;
  if (
    typeof appId !== 'string' ||
    appId.length > MAX_APP_ID_LENGTH ||
    !APP_ID_PATTERN.test(appId)
  ) {
    return null;
  }
  const configured = (process.env[ALLOWED_APP_IDS_VARIABLE] || '')
    .split(',')
    .map((value) => value.trim());
  if (appId !== OFFICIAL_APP_ID && !configured.includes(appId)) {
    return null;
  }
  return `${appId}${NOW_PLAYING_TOPIC_SUFFIX}`;
}

// Apple's `reason` is more specific than the status code, so it decides when it is recognised.
const REASON_ERRORS = new Map([
  ['Unregistered', 'InvalidToken'],
  ['BadDeviceToken', 'InvalidToken'],
  ['DeviceTokenNotForTopic', 'TopicMismatch'],
  ['TopicDisallowed', 'TopicMismatch'],
  ['BadTopic', 'TopicMismatch'],
  ['InvalidProviderToken', 'ProviderAuth'],
  ['ExpiredProviderToken', 'ProviderAuth'],
  ['PayloadTooLarge', 'PayloadTooLarge'],
  ['TooManyRequests', 'ApnsRateLimited'],
]);

// The same refusals by status, for an answer whose reason is missing or new to us.
const STATUS_ERRORS = new Map([
  [403, 'ProviderAuth'],
  [410, 'InvalidToken'],
  [413, 'PayloadTooLarge'],
  [429, 'ApnsRateLimited'],
]);

const ERROR_HTTP_STATUS = new Map([
  ['InvalidToken', 410],
  ['TopicMismatch', 400],
  ['ProviderAuth', 502],
  ['PayloadTooLarge', 413],
  ['ApnsRateLimited', 429],
  ['ApnsUnavailable', 502],
  ['ApnsError', 502],
]);

/**
 * Classifies Apple's answer so Home Assistant can act on it without reading prose.
 *
 * The distinction that matters: `InvalidToken` means this session's token is dead and the
 * registration should go, while everything else is the relay's or the app's problem and must
 * never cost a user their registration. An unrecognised refusal is therefore `ApnsError`, not
 * a guess at a dead token.
 *
 * @param {{ status: number, reason: string | null }} response
 * @returns {{ ok: boolean, errorType?: string, httpStatus: number }}
 */
function classifyApnsResponse({ status, reason }) {
  if (status === 200) {
    return { ok: true, httpStatus: 201 };
  }
  const errorType =
    REASON_ERRORS.get(reason) ||
    STATUS_ERRORS.get(status) ||
    (status >= 500 ? 'ApnsUnavailable' : 'ApnsError');
  return { ok: false, errorType, httpStatus: ERROR_HTTP_STATUS.get(errorType) };
}

/**
 * The rate-limit identity of a destination token.
 *
 * Lower-cased first, because the token is validated as case-insensitive hex and one device written
 * two ways must not be handed two quotas. A full digest because this is a storage key: at 16 hex
 * characters a collision is cheap enough to be worth finding, and a collision here lets one device
 * spend another's quota.
 *
 * @param {string} token
 */
function destinationIdentity(token) {
  return crypto.createHash('sha256').update(token.toLowerCase()).digest('hex');
}

/**
 * A short, non-reversible label for a destination token, for logs and responses.
 *
 * A prefix of the same digest, so one device is one label however its token was cased.
 *
 * @param {string} token
 */
function tokenFingerprint(token) {
  return destinationIdentity(token).slice(0, TOKEN_FINGERPRINT_LENGTH);
}

/**
 * The process-wide provider, built from deployment configuration on first use.
 *
 * `null` when Now Playing is not configured, which is the state of any deployment that has not
 * been given a key. The request is then refused rather than failing inside a send.
 *
 * @type {ApnsProvider | null | undefined}
 */
let provider;

/** @returns {ApnsProvider | null} */
function nowPlayingProvider() {
  if (provider !== undefined) {
    return provider;
  }
  const key = process.env.NOW_PLAYING_APNS_KEY;
  const keyId = process.env.NOW_PLAYING_APNS_KEY_ID;
  const teamId = process.env.NOW_PLAYING_APNS_TEAM_ID;
  if (!key || !keyId || !teamId) {
    provider = null;
    return provider;
  }
  provider = new ApnsProvider({
    // Deployment secrets keep newlines awkwardly; accept an escaped form as well as a real one.
    key: key.replace(/\\n/g, '\n'),
    keyId,
    teamId,
    // iOS 27 issues these tokens against production even for a development-signed build. That is
    // Apple's behaviour rather than a rule this relay asserts, so the environment stays
    // configurable and defaults to what works.
    production: process.env.NOW_PLAYING_APNS_PRODUCTION !== 'false',
  });
  return provider;
}

/** Test seam. Replaces the cached provider; `undefined` restores configuration lookup. */
function setNowPlayingProvider(next) {
  provider = next;
}

/**
 * @param {number} status
 * @param {string} errorType
 * @param {string} message
 * @returns {{ ok: boolean, status: number, error: object }}
 */
function invalid(status, errorType, message) {
  return { ok: false, status, error: { errorType, message } };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

module.exports = {
  isNowPlayingRequest,
  prepareNowPlaying,
  classifyApnsResponse,
  destinationIdentity,
  tokenFingerprint,
  nowPlayingProvider,
  setNowPlayingProvider,
  MAX_PAYLOAD_BYTES,
};
