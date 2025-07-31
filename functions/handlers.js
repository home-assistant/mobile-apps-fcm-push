'use strict';

const { Logging } = require('@google-cloud/logging');
const { getMessaging } = require('firebase-admin/messaging');
const { FirestoreRateLimiter, ValkeyRateLimiter } = require('./rate-limiter');

const MAX_NOTIFICATIONS_PER_DAY = parseInt(process.env.MAX_NOTIFICATIONS_PER_DAY || '500');
const REGION = (process.env.REGION || 'us-central1').toLowerCase();

const usingCloudFunctions = process.env.FUNCTION_TARGET !== undefined;

const messaging = getMessaging();
const logging = new Logging();
const debug = process.env.DEBUG === 'true';

// Use Valkey rate limiter if Valkey config is available, otherwise use Firestore
let rateLimiter;
const useValkey = process.env.VALKEY_HOST && process.env.VALKEY_PORT;
if (useValkey) {
  rateLimiter = new ValkeyRateLimiter(
    MAX_NOTIFICATIONS_PER_DAY,
    debug,
    process.env.VALKEY_HOST,
    parseInt(process.env.VALKEY_PORT, 10),
  );
} else {
  rateLimiter = new FirestoreRateLimiter(MAX_NOTIFICATIONS_PER_DAY, debug);
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
  if (incomingError.code && incomingError.code.startsWith('messaging/')) {
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
      (incomingError.message && (
      incomingError.message.toLowerCase().includes('message is too big') ||
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

function reportError(err, step, req, notificationObj) {
  const logName = 'errors-' + step;
  const log = logging.log(logName);

  const labels = {
    step,
    requestBody: JSON.stringify(req.body),
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
