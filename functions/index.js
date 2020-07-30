'use strict';

const { Logging } = require('@google-cloud/logging');
const functions = require('firebase-functions');
const admin = require('firebase-admin');

const android = require('./android')
const ios = require('./ios')
const legacy = require('./legacy')

admin.initializeApp();

var db = admin.firestore();

const logging = new Logging();

const debug = isDebug()
const MAX_NOTIFICATIONS_PER_DAY = 300;

exports.androidV1 = functions.https.onRequest(async (req, res) => {
  return handleRequest(req, res, android.createPayload);
});

exports.iOSV1 = functions.https.onRequest(async (req, res) => {
  return handleRequest(req, res, ios.createPayload);
});

exports.sendPushNotification = functions.https.onRequest(async (req, res) => {
  return handleRequest(req, res, legacy.createPayload);
});

exports.checkRateLimits = functions.https.onRequest(async (req, res) => {
  var token = req.body.push_token;
  if(!token) {
    return res.status(403).send({ 'errorMessage': 'You did not send a token!' });
  }
  if(token.indexOf(':') === -1) { // A check for old SNS tokens
    return res.status(403).send({ 'errorMessage': 'That is not a valid FCM token' });
  }

  var today = getToday();

  var ref = db.collection('rateLimits').doc(today).collection('tokens').doc(token);

  var docExists = false;
  var docData = {
    attemptsCount: 0,
    deliveredCount: 0,
    errorCount: 0,
    totalCount: 0,
  };

  try {
    let currentDoc = await ref.get();
    if(currentDoc.exists) {
      docData = currentDoc.data();
    }
  } catch(err) {
    functions.logger.error('Error getting document!', err);
    return handleError(req, res, payload, 'getDoc', err);
  }

  return res.status(200).send({
    target: token,
    rateLimits: getRateLimitsObject(docData),
  });
});

async function handleRequest(req, res, payloadHandler) {
  if(debug) functions.logger.info('Received payload', JSON.stringify(req.body));
  var today = getToday();
  var token = req.body.push_token;
  if(!token) {
    return res.status(403).send({ 'errorMessage': 'You did not send a token!' });
  }
  if(token.indexOf(':') === -1) { // A check for old SNS tokens
    return res.status(403).send({'errorMessage': 'That is not a valid FCM token'});
  }

  let response = payloadHandler(req)
  var updateRateLimits = response.updateRateLimits
  var payload = response.payload

  payload['token'] = token;

  var ref = db.collection('rateLimits').doc(today).collection('tokens').doc(token);

  var docExists = false;
  var docData = {
    attemptsCount: 0,
    deliveredCount: 0,
    errorCount: 0,
    totalCount: 0,
  };

  try {
    let currentDoc = await ref.get();
    docExists = currentDoc.exists;
    if(currentDoc.exists) {
      docData = currentDoc.data();
    }
  } catch(err) {
    functions.logger.error('Error getting document!', err);
    return handleError(req, res, payload, 'getDoc', err);
  }

  docData.attemptsCount = docData.attemptsCount + 1;

  if(updateRateLimits && docData.deliveredCount === MAX_NOTIFICATIONS_PER_DAY) {
    try {
      await sendRateLimitedNotification(token);
    } catch(err) {
      functions.logger.error('Error sending rate limited notification!', err);
    }
  }

  if(updateRateLimits && docData.deliveredCount > MAX_NOTIFICATIONS_PER_DAY) {
    await setRateLimitDoc(ref, docExists, docData, req, res);
    return res.status(429).send({
      errorType: 'RateLimited',
      message: 'The given target has reached the maximum number of notifications allowed per day. Please try again later.',
      target: token,
      rateLimits: getRateLimitsObject(docData),
    });
  }

  docData.totalCount = docData.totalCount + 1;

  if(debug) functions.logger.info('Sending payload', JSON.stringify(payload));

  var messageId;
  try {
    messageId = await admin.messaging().send(payload);
    docData.deliveredCount = docData.deliveredCount + 1;
  } catch(err) {
    docData.errorCount = docData.errorCount + 1;
    await setRateLimitDoc(ref, docExists, docData, res);
    return handleError(req, res, payload, 'sendNotification', err);
  }

  if(debug) functions.logger.info('Successfully sent message:', messageId);

  if (updateRateLimits) {
    await setRateLimitDoc(ref, docExists, docData, res);
  } else {
    if(debug) functions.logger.info('Not updating rate limits because notification is critical or command');
  }

  return res.status(201).send({
    messageId: messageId,
    sentPayload: payload,
    target: token,
    rateLimits: getRateLimitsObject(docData),
  });

}

function isDebug() {
  let conf = functions.config();
  if(conf.debug){
    return conf.debug.local;
  }
  return false;
}

async function setRateLimitDoc(ref, docExists, docData, req, res) {
  try {
    if(docExists) {
      if(debug) functions.logger.info('Updating existing doc!');
      await ref.update(docData);
    } else {
      if(debug) functions.logger.info('Creating new doc!');
      await ref.set(docData);
    }
  } catch(err) {
    if(docExists) {
      functions.logger.error('Error updating document!', err);
    } else {
      functions.logger.error('Error creating document!', err);
    }
    return handleError(req, res, null, 'setDocument', err);
  }
  return true;
}

function handleError(req, res, payload, step, incomingError) {
  if (!incomingError) {
    incomingError = new Error(`handleError was passed an undefined incomingError during ${step}`)
  }

  if (!(incomingError instanceof Error)) {
    functions.logger.warn('incomingError is not instanceof Error, its constructor.name is', incomingError.constructor.name)
    incomingError = new Error(incomingError)
  }

  functions.logger.error('InternalError during', step, incomingError);

  if(payload) {
    functions.logger.error('Payload that triggered error:', JSON.stringify(payload));
  }

  return reportError(incomingError, step, req).then(() => {
    return res.status(500).send({
      errorType: 'InternalError',
      errorStep: step,
      message: incomingError.message,
    });
  })
}

function reportError(err, step, req) {
  // This is the name of the StackDriver log stream that will receive the log
  // entry. This name can be any valid log stream name, but must contain "err"
  // in order for the error to be picked up by StackDriver Error Reporting.
  const logName = 'errors-' + step;
  const log = logging.log(logName);

  const region = 'us-central1' // process.env.FIREBASE_CONFIG.locationId only has us-central. We need us-central1.

  // https://cloud.google.com/logging/docs/api/ref_v2beta1/rest/v2beta1/MonitoredResource
  const metadata = {
    resource: {
      type: 'cloud_function',
      labels: { function_name: process.env.FUNCTION_TARGET, region: region },
      severity: 'ERROR'
    },
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
        referrer: '',
        remoteIp: req.ip
      },
      user: req.body.push_token
    },
  };

  // Write the error log entry
  return new Promise((resolve, reject) => {
    log.write(log.entry(metadata, errorEvent), (error) => {
      if (error) {
        return reject(error);
      }
      return resolve();
    });
  });
}


function getToday() {
  var today = new Date();
  var dd = String(today.getDate()).padStart(2, '0');
  var mm = String(today.getMonth() + 1).padStart(2, '0');
  var yyyy = today.getFullYear();
  return yyyy + mm + dd;
}

function getRateLimitsObject(doc) {
  var d = new Date();
  var remainingCount = (MAX_NOTIFICATIONS_PER_DAY - doc.deliveredCount);
  if(remainingCount === -1) remainingCount = 0;
  return {
    attempts: (doc.attemptsCount || 0),
    successful: (doc.deliveredCount || 0),
    errors: (doc.errorCount || 0),
    total: (doc.totalCount || 0),
    maximum: MAX_NOTIFICATIONS_PER_DAY,
    remaining: remainingCount,
    resetsAt: new Date(d.getFullYear(), d.getMonth(), d.getDate()+1)
  };
}

async function sendRateLimitedNotification(token) {
  var d = new Date();
  var strMax = String(MAX_NOTIFICATIONS_PER_DAY);
  var payload = {
    token: token,
    notification: {
      title: 'Notifications Rate Limited',
      body: `You have now sent more than ${MAX_NOTIFICATIONS_PER_DAY} notifications today. You will not receive new notifications until midnight UTC.`
    },
    data: {
      rateLimited: 'true',
      maxNotificationsPerDay: strMax,
      resetsAt: new Date(d.getFullYear(), d.getMonth(), d.getDate()+1).toISOString(),
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
  if(debug) functions.logger.info('Sending rate limit payload', JSON.stringify(payload));
  return await admin.messaging().send(payload);
}
