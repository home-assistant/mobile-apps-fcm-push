'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

var db = admin.firestore();

const MAX_NOTIFICATIONS_PER_DAY = 150;

exports.sendPushNotification = functions.https.onRequest(async (req, res) => {
  console.log('Received payload', JSON.stringify(req.body));
  var today = getToday();
  var token = req.body.push_token;
  if(token.indexOf(':') === -1) { // A check for old SNS tokens
    return res.status(403).send({'errorMessage': 'That is not a valid FCM token'});
  }
  var ref = db.collection('rateLimits').doc(today).collection('tokens').doc(token);

  var payload = {
    notification: {
      body: req.body.message,
    },
    apns: {
      payload: {
        aps: {
          alert: {
            body: req.body.message
          }
        }
      }
    },
    token: token,
  };

  if(req.body.title) {
    payload.notification.title = req.body.title;
    payload.apns.payload.aps.alert.title = req.body.title;
  }

  if(req.body.data) {
    if(req.body.data.android) {
      payload.android = req.body.data.android;
    }
    if(req.body.data.apns) {
      payload.apns = req.body.data.apns;
    }
    if(req.body.data.apns_headers) {
      payload.apns.headers = req.body.data.apns_headers;
    }
    if(req.body.data.data) {
      payload.data = req.body.data.data;
    }
    if(req.body.data.webpush) {
      payload.webpush = req.body.data.webpush;
    }
  }

  if(req.body.registration_info.app_id.indexOf('io.robbie.HomeAssistant') > -1) {
    // Enable old SNS iOS specific push setup.
    if (req.body.message === 'request_location_update' || req.body.message === 'request_location_updates') {
      payload.notification = {};
      payload.apns.payload.aps = {};
      payload.apns.payload.aps.contentAvailable = true;
      payload.apns.payload.homeassistant = { 'command': 'request_location_update' };
    } else if (req.body.message === 'clear_badge') {
      payload.apns.payload.aps.badge = 0;
    } else {
      if(req.body.data) {
        if (req.body.data.subtitle) {
          payload.apns.payload.aps.alert.subtitle = req.body.data.subtitle;
        }

        if (req.body.data.push) {
          for (var attrname in req.body.data.push) {
            payload.apns.payload.aps[attrname] = req.body.data.push[attrname];
          }
        }

        if(req.body.data.sound) {
          payload.apns.payload.aps.sound = req.body.data.sound;
        } else if(req.body.data.push && req.body.data.push.sound) {
          payload.apns.payload.aps.sound = req.body.data.push.sound;
        }

        if (req.body.data.entity_id) {
          payload.apns.payload.entity_id = req.body.data.entity_id;
        }

        if (req.body.data.action_data) {
          payload.apns.payload.homeassistant = req.body.data.action_data;
        }

        if (req.body.data.attachment) {
          payload.apns.payload.attachment = req.body.data.attachment;
        }

        if (req.body.data.url) {
          payload.apns.payload.url = req.body.data.url;
        }

        if (req.body.data.shortcut) {
          payload.apns.payload.shortcut = req.body.data.shortcut;
        }

        if (req.body.data.presentation_options) {
          payload.apns.payload.presentation_options = req.body.data.presentation_options;
        }
      }

      payload.apns.payload.aps.mutableContent = true;
    }
  }

  if(payload.apns.payload.aps.badge) payload.apns.payload.aps.badge = Number(payload.apns.payload.aps.badge);

  console.log('Notification payload', JSON.stringify(payload));

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
    return handleError(res, 'getDoc', err);
  }

  docData.attemptsCount = docData.attemptsCount + 1;

  if(docData.deliveredCount === MAX_NOTIFICATIONS_PER_DAY) {
    try {
      await sendRateLimitedNotification(token);
    } catch(err) {
      console.error('Error sending rate limited notification!', err);
    }
  }

  if(docData.deliveredCount > MAX_NOTIFICATIONS_PER_DAY) {
    await setRateLimitDoc(ref, docExists, docData, res);
    return res.status(429).send({
      errorType: 'RateLimited',
      message: 'The given target has reached the maximum number of notifications allowed per day. Please try again later.',
      target: token,
      rateLimits: getRateLimitsObject(docData),
    });
  }

  docData.totalCount = docData.totalCount + 1;

  var messageId;
  try {
    messageId = await admin.messaging().send(payload);
    docData.deliveredCount = docData.deliveredCount + 1;
  } catch(err) {
    docData.errorCount = docData.errorCount + 1;
    await setRateLimitDoc(ref, docExists, docData, res);
    return handleError(res, 'sendNotification', err);
  }

  console.log('Successfully sent message:', messageId);

  await setRateLimitDoc(ref, docExists, docData, res);

  return res.status(201).send({
    messageId: messageId,
    sentPayload: payload,
    target: token,
    rateLimits: getRateLimitsObject(docData),
  });

});

async function setRateLimitDoc(ref, docExists, docData, res) {
  try {
    if(docExists) {
      console.log('Updating existing doc!');
      await ref.update(docData);
    } else {
      console.log('Creating new doc!');
      await ref.set(docData);
    }
  } catch(err) {
    if(docExists) {
      console.error('Error updating document!', err);
    } else {
      console.error('Error creating document!', err);
    }
    return handleError(res, 'setDocument', err);
  }
  return true;
}

function handleError(res, step, incomingError) {
  if (!incomingError) return null;
  console.error('InternalError during', step, incomingError);
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
  console.log('Sending rate limit payload', JSON.stringify(payload));
  return await admin.messaging().send(payload);
}
