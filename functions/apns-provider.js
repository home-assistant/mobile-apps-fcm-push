'use strict';

const http2 = require('node:http2');
const crypto = require('node:crypto');

// Apple's provider API hosts. Which one a token belongs to is a property of the build that
// created it, so this is configuration rather than something the relay can infer.
const APNS_HOST_PRODUCTION = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';

// Apple rejects a provider token older than one hour. Refreshing well inside that leaves room
// for clock skew and for a request that is already in flight when the token ages out.
const PROVIDER_TOKEN_LIFETIME_SECONDS = 45 * 60;

// A request that has not been answered in this long is treated as a connection problem rather
// than left to hang: Home Assistant is waiting on the other end of this.
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Minimal token-authenticated APNs provider over HTTP/2.
 *
 * It exists because Firebase Admin has no field for a Now Playing session token the way it has
 * `apns.liveActivityToken` for Live Activities, so this one delivery path cannot go through FCM.
 * Deliberately small: one connection, one signing key, no retry policy, no payload knowledge.
 *
 * Nothing here logs. The signing key, the provider JWT and the destination token only ever
 * leave this object as an HTTP/2 header, and the caller decides what to record.
 */
class ApnsProvider {
  /**
   * @param {object} options
   * @param {string} options.key PEM-encoded P-256 private key (an Apple `.p8`).
   * @param {string} options.keyId Apple's identifier for that key.
   * @param {string} options.teamId Apple Developer team identifier.
   * @param {boolean} [options.production] Production host when true, sandbox when false.
   * @param {() => number} [options.now] Injectable clock, in milliseconds.
   * @param {(host: string) => import('node:http2').ClientHttp2Session} [options.connect]
   *   Injectable connector, so tests never reach Apple.
   */
  constructor({ key, keyId, teamId, production = true, now, connect }) {
    if (!key || !keyId || !teamId) {
      throw new Error('ApnsProvider requires key, keyId and teamId');
    }
    this.keyId = keyId;
    this.teamId = teamId;
    this.host = production ? APNS_HOST_PRODUCTION : APNS_HOST_SANDBOX;
    this.now = now || (() => Date.now());
    this.connect = connect || ((host) => http2.connect(host));
    this.signingKey = crypto.createPrivateKey(key);
    /** @type {import('node:http2').ClientHttp2Session | null} */
    this.session = null;
    /** @type {{ value: string, expiresAt: number } | null} */
    this.providerToken = null;
  }

  /**
   * The cached provider JWT, signed afresh only once it is close to Apple's one-hour maximum.
   *
   * A Now Playing session can update on every track change, and signing per request would burn
   * CPU on a value that stays valid for the better part of an hour.
   *
   * @returns {string}
   */
  authorizationToken() {
    const nowSeconds = Math.floor(this.now() / 1000);
    if (this.providerToken && this.providerToken.expiresAt > nowSeconds) {
      return this.providerToken.value;
    }

    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.keyId }));
    const claims = base64url(JSON.stringify({ iss: this.teamId, iat: nowSeconds }));
    const signingInput = `${header}.${claims}`;
    // APNs wants a JWS signature, meaning raw R||S rather than the DER encoding `createSign`
    // produces.
    const signature = crypto.sign('sha256', Buffer.from(signingInput), {
      key: this.signingKey,
      dsaEncoding: 'ieee-p1363',
    });

    const value = `${signingInput}.${base64url(signature)}`;
    this.providerToken = { value, expiresAt: nowSeconds + PROVIDER_TOKEN_LIFETIME_SECONDS };
    return value;
  }

  /**
   * The shared HTTP/2 session, reopened when the last one is gone.
   *
   * Apple sends GOAWAY routinely and expects the provider to reconnect rather than to treat it
   * as an error, so a closed or destroyed session is simply replaced on the next send.
   *
   * @returns {import('node:http2').ClientHttp2Session}
   */
  connection() {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    const session = this.connect(this.host);
    for (const event of ['error', 'close', 'goaway']) {
      // The `error` listener is not optional: without one a session-level error becomes an
      // unhandled exception and takes the process with it. The next send reconnects.
      session.on(event, () => {
        if (this.session === session) {
          this.session = null;
        }
      });
    }
    this.session = session;
    return session;
  }

  /**
   * Sends one notification and resolves with Apple's answer, including its refusals.
   *
   * A rejection means the request never reached Apple. A resolution with a non-200 status means
   * Apple answered and said no, which is a different thing and is classified by the caller.
   *
   * @param {object} request
   * @param {string} request.token Destination device token, lowercase hex.
   * @param {string} request.topic Value for `apns-topic`.
   * @param {string} request.pushType Value for `apns-push-type`.
   * @param {Buffer} request.body Encoded JSON payload.
   * @returns {Promise<{ status: number, apnsId: string | null, reason: string | null }>}
   */
  async send({ token, topic, pushType, body }) {
    let stream;
    try {
      stream = this.connection().request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${this.authorizationToken()}`,
        'apns-topic': topic,
        'apns-push-type': pushType,
        'content-type': 'application/json',
        'content-length': body.length,
      });
    } catch (err) {
      // The session was unusable and said so synchronously. Drop it so the next send reconnects.
      this.session = null;
      throw err;
    }

    return new Promise((resolve, reject) => {
      let status = 0;
      let apnsId = null;
      const chunks = [];

      // Whichever of these settles first wins; a promise ignores the rest.
      stream.setTimeout(REQUEST_TIMEOUT_MS, () => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error('APNs request timed out'));
      });
      stream.on('error', reject);

      stream.on('response', (headers) => {
        status = Number(headers[':status']) || 0;
        const id = headers['apns-id'];
        apnsId = typeof id === 'string' ? id : null;
      });
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        resolve({ status, apnsId, reason: parseReason(Buffer.concat(chunks)) });
      });

      stream.end(body);
    });
  }

  /** Closes the shared connection. Used by tests and by orderly shutdown. */
  close() {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      this.session.close();
    }
    this.session = null;
  }
}

/** @param {Buffer} buffer */
function parseReason(buffer) {
  if (!buffer.length) {
    return null;
  }
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    return typeof parsed.reason === 'string' ? parsed.reason : null;
  } catch {
    // Apple answered with something that is not the documented JSON body. The status code is
    // still meaningful, and the body may contain anything, so it is not propagated.
    return null;
  }
}

/** @param {string | Buffer} value */
function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

module.exports = { ApnsProvider };
