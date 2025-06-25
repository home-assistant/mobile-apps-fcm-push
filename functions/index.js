'use strict';

const { Logging } = require('@google-cloud/logging');
const functions = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const android = require('./android');
const ios = require('./ios');
const legacy = require('./legacy');

initializeApp();

const db = getFirestore();
const messaging = getMessaging();

const logging = new Logging();

const debug = isDebug();
const MAX_NOTIFICATIONS_PER_DAY = 500;

const region = functions.config().app && functions.config().app.region || "us-central1";
const regionalFunctions = functions.region(region).runWith({ timeoutSeconds: 10 });

exports.androidV1 = regionalFunctions.https.onRequest(async (req, res) => 
  handleRequest(req, res, android.createPayload)
);

exports.iOSV1 = regionalFunctions.https.onRequest(async (req, res) => 
  handleRequest(req, res, ios.createPayload)
);

exports.sendPushNotification = regionalFunctions.https.onRequest(async (req, res) => 
  handleRequest(req, res, legacy.createPayload)
);

exports.checkRateLimits = regionalFunctions.https.onRequest(async (req, res) => {
  const { push_token: token } = req.body;
  if (!token) {
    return res.status(403).send({ 'errorMessage': 'You did not send a token!' });
  }
  if (token.indexOf(':') === -1) { // A check for old SNS tokens
    return res.status(403).send({ 'errorMessage': 'That is not a valid FCM token' });
  }

  const today = getToday();
  const ref = db.collection('rateLimits').doc(today).collection('tokens').doc(token);

  let docData = {
    attemptsCount: 0,
    deliveredCount: 0,
    errorCount: 0,
    totalCount: 0,
  };

  try {
    const currentDoc = await ref.get();
    if (currentDoc.exists) {
      docData = currentDoc.data();
    }
  } catch (err) {
    return handleError(req, res, {}, 'getRateLimitDoc', err);
  }

  return res.status(200).send({
    target: token,
    rateLimits: getRateLimitsObject(docData),
  });
});

async function handleRequest(req, res, payloadHandler) {
  if (debug) functions.logger.info('Handling request', { requestBody: JSON.stringify(req.body) });
  const today = getToday();
  const { push_token: token } = req.body;
  if (!token) {
    return res.status(403).send({ 'errorMessage': 'You did not send a token!' });
  }
  if (token.indexOf(':') === -1) { // A check for old SNS tokens
    return res.status(403).send({'errorMessage': 'That is not a valid FCM token'});
  }

  const { updateRateLimits, payload } = payloadHandler(req);

  payload.token = token;

  const ref = db.collection('rateLimits').doc(today).collection('tokens').doc(token);

  let docExists = false;
  let docData = {
    attemptsCount: 0,
    deliveredCount: 0,
    errorCount: 0,
    totalCount: 0,
    expiresAt: getFirestoreTimestamp(),
  };

  try {
    const currentDoc = await ref.get();
    docExists = currentDoc.exists;
    if (currentDoc.exists) {
      docData = currentDoc.data();
    }
  } catch (err) {
    return handleError(req, res, payload, 'getRateLimitDoc', err);
  }

  docData.attemptsCount = docData.attemptsCount + 1;

  if (updateRateLimits && docData.deliveredCount === MAX_NOTIFICATIONS_PER_DAY) {
    try {
      await sendRateLimitedNotification(token);
    } catch (err) {
      handleError(req, res, payload, 'sendRateLimitNotification', err, false);
    }
  }

  if (updateRateLimits && docData.deliveredCount > MAX_NOTIFICATIONS_PER_DAY) {
    await setRateLimitDoc(ref, docExists, docData, req, res);
    return res.status(429).send({
      errorType: 'RateLimited',
      message: 'The given target has reached the maximum number of notifications allowed per day. Please try again later.',
      target: token,
      rateLimits: getRateLimitsObject(docData),
    });
  }

  docData.totalCount = docData.totalCount + 1;

  if (debug) functions.logger.info('Sending notification', { notification: JSON.stringify(payload) });

  let messageId;
  try {
    messageId = await messaging.send(payload);
    docData.deliveredCount = docData.deliveredCount + 1;
  } catch (err) {
    docData.errorCount = docData.errorCount + 1;
    await setRateLimitDoc(ref, docExists, docData, res);
    return handleError(req, res, payload, 'sendNotification', err);
  }

  if (debug) functions.logger.info('Successfully sent notification', { messageId: messageId, notification: JSON.stringify(payload) });

  if (updateRateLimits) {
    await setRateLimitDoc(ref, docExists, docData, res);
  } else {
    if (debug) functions.logger.info('Not updating rate limits because notification is critical or command');
  }

  return res.status(201).send({
    messageId,
    sentPayload: payload,
    target: token,
    rateLimits: getRateLimitsObject(docData),
  });

}

function isDebug() {
  let conf = functions.config();
  if (conf.debug){
    return conf.debug.local === 'true';
  }
  return false;
}

async function setRateLimitDoc(ref, docExists, docData, req, res) {
  try {
    if (docExists) {
      if (debug) functions.logger.info('Updating existing rate limit doc!');
      await ref.update(docData);
    } else {
      if (debug) functions.logger.info('Creating new rate limit doc!');
      await ref.set(docData);
    }
  } catch (err) {
    const step = docExists ? 'updateRateLimitDocument' : 'createRateLimitDocument';
    return handleError(req, res, null, step, err);
  }
  return true;
}

function handleError(req, res, payload = {}, step, incomingError, shouldExit = true) {
  if (!incomingError) {
    incomingError = new Error(`handleError was passed an undefined incomingError`);
  }

  if (!(incomingError instanceof Error)) {
    functions.logger.warn('incomingError is not instanceof Error, its constructor.name is', incomingError.constructor.name);
    incomingError = new Error(incomingError);
  }

  return reportError(incomingError, step, req, payload).then(() => {
    if (!shouldExit) { return true; }

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
    notification: JSON.stringify(notificationObj)
  };

  if (req.body.registration_info) {
    labels.appID = req.body.registration_info.app_id;
    labels.appVersion = req.body.registration_info.app_version;
    labels.osVersion = req.body.registration_info.os_version;
  }

  // https://cloud.google.com/logging/docs/api/ref_v2beta1/rest/v2beta1/MonitoredResource
  const metadata = {
    resource: {
      type: 'cloud_function',
      labels: {
        function_name: process.env.FUNCTION_TARGET,
        // Use region from Cloud Function config as process.env.FIREBASE_CONFIG.locationId only has the project's multi-region location, e.g. us-central or europe-west, and we need a complete Google Cloud location, e.g. us-central1 or europe-west1, to invoke Google Cloud Logging API.
        // See https://firebase.google.com/docs/projects/locations#location-mr
        // and https://firebase.google.com/docs/functions/locations#selecting-regions_firestore-storage
        region
      }
    },
    severity: 'ERROR',
    labels
  };

  // https://cloud.google.com/error-reporting/reference/rest/v1beta1/ErrorEvent
  const errorEvent = {
    message: err.stack,
    serviceContext: {
      service: process.env.FUNCTION_TARGET,
      version: process.env.K_REVISION,
      resourceType: 'cloud_function',
    },
    context: {
      httpRequest: {
        method: req.method,
        url: req.originalUrl,
        userAgent: req.get('user-agent'),
        remoteIp: req.ip
      },
      user: req.body.push_token
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

function getToday() {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, '0');
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy = today.getFullYear();
  return `${yyyy}${mm}${dd}`;
}

function getFirestoreTimestamp() {
  const now = new Date().getTime();
  const endDate = new Date(now - (now % 86400000) + 86400000);
  return Timestamp.fromDate(endDate);
}

function getRateLimitsObject(doc) {
  const d = new Date();
  let remainingCount = MAX_NOTIFICATIONS_PER_DAY - doc.deliveredCount;
  if (remainingCount < 0) {
    remainingCount = 0;
  }
  return {
    attempts: doc.attemptsCount || 0,
    successful: doc.deliveredCount || 0,
    errors: doc.errorCount || 0,
    total: doc.totalCount || 0,
    maximum: MAX_NOTIFICATIONS_PER_DAY,
    remaining: remainingCount,
    resetsAt: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  };
}

async function sendRateLimitedNotification(token) {
  const d = new Date();
  const strMax = String(MAX_NOTIFICATIONS_PER_DAY);
  const payload = {
    token: token,
    notification: {
      title: 'Notifications Rate Limited',
      body: `You have now sent more than ${MAX_NOTIFICATIONS_PER_DAY} notifications today. You will not receive new notifications until midnight UTC.`
    },
    data: {
      rateLimited: 'true',
      maxNotificationsPerDay: strMax,
      resetsAt: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString(),
    },
    android: {
      notification: {
        body_loc_args: [strMax],
        body_loc_key: "rate_limit_notification.body",
        title_loc_key: "rate_limit_notification.title",
      }
    },
    apns: {
      payload: {
        aps: {
          alert: {
            'loc-args': [strMax],
            'loc-key': "rate_limit_notification.body",
            'title-loc-key': "rate_limit_notification.title",
          }
        }
      }
    },
    fcm_options: {
      analytics_label: "rateLimitNotification"
    }
  };
  if (debug) functions.logger.info('Sending rate limit notification', { notification: JSON.stringify(payload) });
  return messaging.send(payload);
}

// Export for testing
exports.handleRequest = handleRequest;
