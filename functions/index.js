'use strict';

const ios = require('./ios')
const android = require('./android')

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

var db = admin.firestore();

const debug = isDebug()
const MAX_NOTIFICATIONS_PER_DAY = 150;

exports.sendPushNotification = functions.https.onRequest(async (req, res) => {
  if(debug) console.log('Received payload', JSON.stringify(req.body));
  var today = getToday();
  var token = req.body.push_token;
  if(!token) {
    return res.status(403).send({ 'errorMessage': 'You did not send a token!' });
  }
  if(token.indexOf(':') === -1) { // A check for old SNS tokens
    return res.status(403).send({'errorMessage': 'That is not a valid FCM token'});
  }
  var ref = db.collection('rateLimits').doc(today).collection('tokens').doc(token);

  var updateRateLimits = true
  var payload = null
  if(req.body.registration_info.app_id === 'io.robbie.HomeAssistant') {
    let response = ios.createPayload(req)
    updateRateLimits = response.updateRateLimits
    payload = response.payload
  } else if (req.body.registration_info.app_id === 'io.homeassistant.companion.android') {
    let response = android.createPayload(req)
    updateRateLimits = response.updateRateLimits
    payload = response.payload
  } else {
    console.error('Issue deternmining android vs ios for payload ', JSON.stringify(req.body))
    return res.status(400).send({
      errorType: 'UnknownApplication',
      errorStep: 'ApplicationCheck'
    });
  }

  payload['token'] = token;

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
    console.error('Error getting document!', err);
    return handleError(res, payload, 'getDoc', err);
  }

  docData.attemptsCount = docData.attemptsCount + 1;

  if(updateRateLimits && docData.deliveredCount === MAX_NOTIFICATIONS_PER_DAY) {
    try {
      await sendRateLimitedNotification(token);
    } catch(err) {
      console.error('Error sending rate limited notification!', err);
    }
  }

  if(updateRateLimits && docData.deliveredCount > MAX_NOTIFICATIONS_PER_DAY) {
    await setRateLimitDoc(ref, docExists, docData, res);
    return res.status(429).send({
      errorType: 'RateLimited',
      message: 'The given target has reached the maximum number of notifications allowed per day. Please try again later.',
      target: token,
      rateLimits: getRateLimitsObject(docData),
    });
  }

  docData.totalCount = docData.totalCount + 1;

  if(debug) console.log('Sending payload', JSON.stringify(payload));

  var messageId;
  try {
    messageId = await admin.messaging().send(payload);
    docData.deliveredCount = docData.deliveredCount + 1;
  } catch(err) {
    docData.errorCount = docData.errorCount + 1;
    await setRateLimitDoc(ref, docExists, docData, res);
    return handleError(res, payload, 'sendNotification', err);
  }

  if(debug) console.log('Successfully sent message:', messageId);

  if (updateRateLimits) {
    await setRateLimitDoc(ref, docExists, docData, res);
  } else {
    if(debug) console.log('Not updating rate limits because notification is critical or command');
  }

  return res.status(201).send({
    messageId: messageId,
    sentPayload: payload,
    target: token,
    rateLimits: getRateLimitsObject(docData),
  });

});

function isDebug() {
  let conf = functions.config();
  if(conf.debug){
    return conf.debug.local;
  }
  return false;
}

async function setRateLimitDoc(ref, docExists, docData, res) {
  try {
    if(docExists) {
      if(debug) console.log('Updating existing doc!');
      await ref.update(docData);
    } else {
      if(debug) console.log('Creating new doc!');
      await ref.set(docData);
    }
  } catch(err) {
    if(docExists) {
      console.error('Error updating document!', err);
    } else {
      console.error('Error creating document!', err);
    }
    return handleError(res, null, 'setDocument', err);
  }
  return true;
}

function handleError(res, payload, step, incomingError) {
  if (!incomingError) return null;
  if(payload) {
    console.error('InternalError during', step, 'with payload', JSON.stringify(payload), incomingError);
  } else {
    console.error('InternalError during', step, incomingError);
  }
  return res.status(500).send({
    errorType: 'InternalError',
    errorStep: step,
    message: incomingError.message,
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
    }
  };
  if(debug) console.log('Sending rate limit payload', JSON.stringify(payload));
  return await admin.messaging().send(payload);
}
