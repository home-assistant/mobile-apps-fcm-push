'use strict';

const { Logging } = require('@google-cloud/logging');
const { getMessaging } = require('firebase-admin/messaging');
const { FirestoreRateLimiter, ValkeyRateLimiter } = require('./rate-limiter');
const { NOW_PLAYING_DESTINATION_PREFIX, NOW_PLAYING_KEY_PREFIX } = require('./rate-limiter/util');
const {
  isNowPlayingRequest,
  prepareNowPlaying,
  classifyApnsResponse,
  destinationIdentity,
  nowPlayingProvider,
  tokenFingerprint,
} = require('./now-playing');

const MAX_NOTIFICATIONS_PER_DAY = parseInt(process.env.MAX_NOTIFICATIONS_PER_DAY || '500');

// Remote Now Playing gets its own daily ceiling, deliberately far above the notification quota:
// this traffic is machine-generated state synchronization, and a heavy listening day of track,
// transport and volume changes lands in the low hundreds. 5000 stays an order of magnitude clear
// of real use while still bounding a runaway client to roughly three pushes a minute sustained.
const MAX_NOW_PLAYING_UPDATES_PER_DAY = parseInt(
  process.env.MAX_NOW_PLAYING_UPDATES_PER_DAY || '5000',
);
const REGION = (process.env.REGION || 'us-central1').toLowerCase();

const usingCloudFunctions = process.env.FUNCTION_TARGET !== undefined;

const messaging = getMessaging();
const logging = new Logging();
const debug = process.env.DEBUG === 'true';

// Use Valkey rate limiter if Valkey config is available, otherwise use Firestore
let rateLimiter;
const useValkey = process.env.VALKEY_HOST && process.env.VALKEY_PORT;
// Metered separately from notifications, in the same backend and under the same day partition.
let nowPlayingRateLimiter;
if (useValkey) {
  rateLimiter = new ValkeyRateLimiter(
    MAX_NOTIFICATIONS_PER_DAY,
    debug,
    process.env.VALKEY_HOST,
    parseInt(process.env.VALKEY_PORT, 10),
  );
  nowPlayingRateLimiter = new ValkeyRateLimiter(
    MAX_NOW_PLAYING_UPDATES_PER_DAY,
    debug,
    process.env.VALKEY_HOST,
    parseInt(process.env.VALKEY_PORT, 10),
    NOW_PLAYING_KEY_PREFIX,
  );
} else {
  rateLimiter = new FirestoreRateLimiter(MAX_NOTIFICATIONS_PER_DAY, debug);
  nowPlayingRateLimiter = new FirestoreRateLimiter(
    MAX_NOW_PLAYING_UPDATES_PER_DAY,
    debug,
    NOW_PLAYING_KEY_PREFIX,
  );
}

async function handleCheckRateLimits(req, res) {
  const { push_token: token } = req.body;
  if (!token) {
    return res.status(403).send({ errorMessage: 'You did not send a token!' });
  }
  if (token.indexOf(':') === -1) {
    // A check for old SNS tokens
    return res.status(403).send({ errorMessage: 'That is not a valid FCM token' });
  }

  try {
    const rateLimitInfo = await rateLimiter.checkRateLimit(token);
    return res.status(200).send({
      target: token,
      rateLimits: rateLimitInfo.rateLimits,
    });
  } catch (err) {
    return handleError(req, res, { token }, 'getRateLimitDoc', err);
  }
}

async function handleRequest(req, res, payloadHandler) {
  const log = logging.log('handleRequest');
  const metadata = buildLogMetadata(req);

  if (debug) {
    log.debug(log.entry(metadata, { message: 'Handling request' }));
  }
  const { push_token: token } = req.body;
  if (!token) {
    return res.status(403).send({ errorMessage: 'You did not send a token!' });
  }
  if (token.indexOf(':') === -1) {
    // A check for old SNS tokens
    return res.status(403).send({ errorMessage: 'That is not a valid FCM token' });
  }

  // Apple's Now Playing sessions cannot be addressed through FCM. Firebase Admin has no field
  // for their per-session token the way it has `liveActivityToken`, so that one delivery path
  // goes straight to APNs from here. Everything before this point is shared, including the FCM
  // token check, so the rate-limit identity stays the same for both.
  if (isNowPlayingRequest(req.body)) {
    return handleNowPlayingRequest(req, res, token);
  }

  const { updateRateLimits, payload } = payloadHandler(req);

  payload.token = token;

  let rateLimitInfo;
  try {
    rateLimitInfo = await rateLimiter.checkRateLimit(token);
  } catch (err) {
    return handleError(req, res, payload, 'getRateLimitDoc', err);
  }

  if (updateRateLimits) {
    // Increment attempts count
    const attemptInfo = await rateLimiter.recordAttempt(token);

    if (attemptInfo.shouldSendRateLimitNotification) {
      try {
        await sendRateLimitedNotification(req, token);
      } catch (err) {
        handleError(req, res, payload, 'sendRateLimitNotification', err, false);
      }
    }

    if (attemptInfo.isRateLimited) {
      return res.status(429).send({
        errorType: 'RateLimited',
        message:
          'The given target has reached the maximum number of notifications allowed per day. Please try again later.',
        target: token,
        rateLimits: attemptInfo.rateLimits,
      });
    }
  }

  if (debug) {
    log.info(
      log.entry(metadata, {
        message: 'Sending notification',
        notification: JSON.stringify(payload),
      }),
    );
  }

  let messageId;
  let rateLimits;
  try {
    messageId = await messaging.send(payload);
    if (updateRateLimits) {
      rateLimits = await rateLimiter.recordSuccess(token);
    } else {
      rateLimits = rateLimitInfo.rateLimits;
    }
  } catch (err) {
    if (updateRateLimits) {
      await rateLimiter.recordError(token);
    }
    return handleError(req, res, payload, 'sendNotification', err);
  }

  if (debug) {
    log.info(
      log.entry(metadata, {
        message: 'Successfully sent notification',
        messageId: messageId,
        notification: JSON.stringify(payload),
      }),
    );
  }

  if (!updateRateLimits && debug) {
    log.info(
      log.entry(metadata, {
        message: 'Not updating rate limits because notification is critical or command',
      }),
    );
  }

  return res.status(201).send({
    messageId,
    sentPayload: payload,
    target: token,
    rateLimits: rateLimits,
  });
}

/**
 * Charges the Now Playing counters for a request APNs has already answered.
 *
 * Bookkeeping after the fact must never become the result. Apple's answer is the outcome of the
 * request, and the most important one it can give is that a session token is dead: if a 410 is
 * replaced by a database exception, Home Assistant is told the relay had an internal error rather
 * than that it should remove the registration, and it keeps pushing at a token that will never
 * work again.
 *
 * A failure here is still worth knowing about, so it is reported under its own step rather than
 * folded into the delivery's. Returns the registration counters, or `undefined` when they could
 * not be written.
 *
 * @param {(key: string) => Promise<any>} charge
 */
async function chargeNowPlayingQuotas(req, quotas, loggable, charge) {
  try {
    const [rateLimits] = await Promise.all(quotas.map(charge));
    return rateLimits;
  } catch (err) {
    try {
      await reportError(err, 'recordNowPlayingRateLimit', req, loggable);
    } catch {
      // Reporting the failure failed too. There is nothing further to try, and the delivery
      // result still has to reach Home Assistant.
    }
    return undefined;
  }
}

/**
 * Delivers one Now Playing `update` or `end` straight to APNs.
 *
 * The response is deliberately machine-readable. Home Assistant has to be able to tell a dead
 * session token, which it should unregister, from a topic or provider-credential problem,
 * which is ours and must never cost the user their registration.
 *
 * The quotas it charges are a safety ceiling rather than the mechanism that keeps this traffic
 * reasonable, which is Home Assistant's job. A server that reaches either is pushing far more
 * than the product needs.
 */
async function handleNowPlayingRequest(req, res, token) {
  const log = logging.log('handleNowPlaying');
  const metadata = buildLogMetadata(req);

  const prepared = prepareNowPlaying(req.body);
  if (!prepared.ok) {
    // One step name for the whole delivery path, refusals included: Home Assistant discriminates
    // on `errorType`, and a second step name would only give it a reason to parse two fields.
    return res.status(prepared.status).send({ ...prepared.error, errorStep: 'sendNowPlaying' });
  }

  const provider = nowPlayingProvider();
  if (!provider) {
    return res.status(501).send({
      errorType: 'NowPlayingNotConfigured',
      errorStep: 'sendNowPlaying',
      message: 'This deployment has no Now Playing APNs credentials configured.',
    });
  }

  // What is safe to record. The payload is; the destination token is not.
  const loggable = {
    event: prepared.event,
    topic: prepared.request.topic,
    target: tokenFingerprint(prepared.request.token),
    payloadBytes: prepared.request.body.length,
  };

  // Two counters, both of which have to allow the send.
  //
  // The registration counter is keyed on the Companion token, which is the identity every other
  // quota in this service uses. On its own it is not enough here: unlike the Firebase path,
  // nothing on this path ever hands that token to Firebase, so it is only ever checked for shape.
  // A caller could invent a new one per request, be given an empty bucket each time, and push at
  // one real device without limit. The second counter is keyed on the device the push actually
  // reaches, so inventing registrations gains nothing.
  const quotas = [
    token,
    `${NOW_PLAYING_DESTINATION_PREFIX}${destinationIdentity(prepared.request.token)}`,
  ];

  // Read both before charging either. Charging as we go would leave an attempt recorded against
  // one counter for a request the other refused, which no success or error ever answers.
  let allowances;
  try {
    allowances = await Promise.all(quotas.map((key) => nowPlayingRateLimiter.checkRateLimit(key)));
  } catch (err) {
    return handleError(req, res, loggable, 'getRateLimitDoc', err);
  }

  if (allowances.some((allowance) => allowance.isRateLimited)) {
    // No visible warning push: filling this ceiling is something Home Assistant reads and backs
    // off from, not something to tell the user about. `shouldSendRateLimitNotification` is what
    // triggers the user-facing "Notifications Rate Limited" alert, and it is ignored here.
    //
    // The counters reported are the registration's, which is what `target` names. The destination
    // counter is shared by every registration pushing at that device, and its numbers are not this
    // caller's to read.
    return res.status(429).send({
      errorType: 'RateLimited',
      message:
        'The given target has reached the maximum number of Now Playing updates allowed per day. Please try again later.',
      target: token,
      rateLimits: allowances[0].rateLimits,
    });
  }

  try {
    await Promise.all(quotas.map((key) => nowPlayingRateLimiter.recordAttempt(key)));
  } catch (err) {
    // Its own step: `getRateLimitDoc` is the read above, and a failure to write a counter is a
    // different fault to a failure to read one.
    return handleError(req, res, loggable, 'recordNowPlayingAttempt', err);
  }

  if (debug) {
    log.info(log.entry(metadata, { message: 'Sending Now Playing update', ...loggable }));
  }

  let response;
  try {
    response = await provider.send(prepared.request);
  } catch (err) {
    // The request never reached Apple: a connection or TLS failure, or a timeout.
    await chargeNowPlayingQuotas(req, quotas, loggable, (key) =>
      nowPlayingRateLimiter.recordError(key),
    );
    try {
      await reportError(err, 'sendNowPlaying', req, loggable);
    } catch {
      // The delivery failure is what Home Assistant needs to hear about, not this.
    }
    return res.status(502).send({
      errorType: 'ApnsUnavailable',
      errorStep: 'sendNowPlaying',
      message: err.message,
    });
  }

  const outcome = classifyApnsResponse(response);

  if (!outcome.ok) {
    await chargeNowPlayingQuotas(req, quotas, loggable, (key) =>
      nowPlayingRateLimiter.recordError(key),
    );
    if (debug) {
      log.info(
        log.entry(metadata, {
          message: 'Now Playing delivery refused',
          ...loggable,
          errorType: outcome.errorType,
          errorCode: response.reason,
          apnsStatus: response.status,
        }),
      );
    }
    return res.status(outcome.httpStatus).send({
      errorType: outcome.errorType,
      errorCode: response.reason,
      errorStep: 'sendNowPlaying',
      apnsStatus: response.status,
      apnsId: response.apnsId,
      target: loggable.target,
    });
  }

  // The registration's counters are what the response reports, and the destination's are advanced
  // alongside them so both stay answered. The push has already been delivered, so a failure to
  // record that leaves `rateLimits` absent from the response rather than losing the delivery.
  const rateLimits = await chargeNowPlayingQuotas(req, quotas, loggable, (key) =>
    nowPlayingRateLimiter.recordSuccess(key),
  );

  if (debug) {
    log.info(log.entry(metadata, { message: 'Sent Now Playing update', ...loggable }));
  }

  return res.status(201).send({
    messageId: response.apnsId,
    sentPayload: JSON.parse(prepared.request.body.toString('utf8')),
    target: loggable.target,
    rateLimits,
  });
}

function handleError(req, res, payload = {}, step, incomingError, shouldExit = true) {
  const log = logging.log('handleError');
  const metadata = buildLogMetadata(req);

  if (!incomingError) {
    incomingError = new Error(`handleError was passed an undefined incomingError`);
  }

  if (!(incomingError instanceof Error)) {
    log.alert(
      log.entry(metadata, {
        message:
          'incomingError is not instanceof Error, its constructor.name is:' +
          incomingError.constructor.name,
      }),
    );
    incomingError = new Error(incomingError);
  }

  // Handle Firebase Messaging errors with appropriate status codes
  if (incomingError.code?.startsWith('messaging/')) {
    const errorCode = incomingError.code.replace('messaging/', '');

    // For specific token errors, skip reporting and return immediately
    if (
      errorCode === 'invalid-registration-token' ||
      errorCode === 'registration-token-not-registered'
    ) {
      if (!shouldExit) {
        return true;
      }

      return res.status(500).send({
        errorType: 'InvalidToken',
        errorCode: errorCode,
        errorStep: step,
        message: incomingError.message,
      });
    }

    // Handle Android message size limit errors
    if (
      errorCode === 'invalid-argument' ||
      errorCode === 'payload-too-large' ||
      (incomingError.message &&
        (incomingError.message.toLowerCase().includes('message is too big') ||
          incomingError.message.toLowerCase().includes('payload too large')))
    ) {
      if (!shouldExit) {
        return true;
      }

      return res.status(500).send({
        errorType: 'PayloadTooLarge',
        errorCode: errorCode,
        errorStep: step,
        message: incomingError.message,
      });
    }
  }

  // Report all other errors before responding
  return reportError(incomingError, step, req, payload).then(() => {
    if (!shouldExit) {
      return true;
    }

    // Default error response for all errors
    return res.status(500).send({
      errorType: 'InternalError',
      errorStep: step,
      message: incomingError.message,
    });
  });
}

/**
 * Strips values that must not reach Cloud Logging from a request body.
 *
 * Error reporting records the whole body, which is fine for an ordinary notification but not for
 * a Now Playing destination token: it is a device-scoped identifier that can be pushed to. The
 * body is returned unchanged, by reference, when there is nothing to redact, so this is a no-op
 * for every existing path.
 *
 * @param {object} body
 */
function redactForLogging(body) {
  if (!body || typeof body !== 'object' || !body.now_playing_token) {
    return body;
  }
  return {
    ...body,
    now_playing_token: `[redacted:${tokenFingerprint(String(body.now_playing_token))}]`,
  };
}

function reportError(err, step, req, notificationObj) {
  const logName = 'errors-' + step;
  const log = logging.log(logName);

  const labels = {
    step,
    requestBody: JSON.stringify(redactForLogging(req.body)),
    notification: JSON.stringify(notificationObj),
  };

  if (req.body.registration_info) {
    labels.appID = req.body.registration_info.app_id;
    labels.appVersion = req.body.registration_info.app_version;
    labels.osVersion = req.body.registration_info.os_version;
  }

  // https://cloud.google.com/logging/docs/api/ref_v2beta1/rest/v2beta1/MonitoredResource
  const metadata = {
    resource: {
      type: 'global',
    },
    severity: 'ERROR',
    labels,
  };

  if (usingCloudFunctions) {
    metadata.resource.type = 'cloud_function';
    metadata.resource.labels = { function_name: process.env.FUNCTION_TARGET, region: REGION };
  }

  // https://cloud.google.com/error-reporting/reference/rest/v1beta1/ErrorEvent
  const errorEvent = {
    message: err.stack,
    serviceContext: {
      service: usingCloudFunctions ? process.env.FUNCTION_TARGET : 'mobile-push',
      version: usingCloudFunctions ? process.env.K_REVISION : '1.0.0',
      resourceType: usingCloudFunctions ? 'cloud_function' : 'cloud_run',
    },
    context: {
      httpRequest: {
        method: req.method,
        url: req.originalUrl,
        userAgent: req.get('user-agent'),
        remoteIp: req.ip,
      },
      user: req.body.push_token,
    },
  };

  return new Promise((resolve, reject) => {
    log.write(log.entry(metadata, errorEvent), (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function sendRateLimitedNotification(req, token) {
  const log = logging.log('sendRateLimitedNotification');
  const metadata = buildLogMetadata(req);

  const d = new Date();
  const strMax = String(MAX_NOTIFICATIONS_PER_DAY);
  const payload = {
    token: token,
    notification: {
      title: 'Notifications Rate Limited',
      body: `You have now sent more than ${MAX_NOTIFICATIONS_PER_DAY} notifications today. You will not receive new notifications until midnight UTC.`,
    },
    data: {
      rateLimited: 'true',
      maxNotificationsPerDay: strMax,
      resetsAt: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString(),
    },
    android: {
      notification: {
        body_loc_args: [strMax],
        body_loc_key: 'rate_limit_notification.body',
        title_loc_key: 'rate_limit_notification.title',
      },
    },
    apns: {
      payload: {
        aps: {
          alert: {
            'loc-args': [strMax],
            'loc-key': 'rate_limit_notification.body',
            'title-loc-key': 'rate_limit_notification.title',
          },
        },
      },
    },
    fcm_options: {
      analytics_label: 'rateLimitNotification',
    },
  };
  if (debug)
    log.debug(
      log.entry(metadata, {
        message: 'Sending rate limit notification',
        notification: JSON.stringify(payload),
      }),
    );
  return messaging.send(payload);
}

function buildLogMetadata(req) {
  return {
    resource: { type: 'global' },
    httpRequest: {
      requestMethod: req.method,
      requestUrl: req.originalUrl,
      userAgent: req.get('user-agent'),
      remoteIp: req.ip,
    },
  };
}

exports.handleRequest = handleRequest;
exports.handleCheckRateLimits = handleCheckRateLimits;
exports.redactForLogging = redactForLogging;
