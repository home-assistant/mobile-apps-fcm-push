'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

var db = admin.firestore();

const MAX_NOTIFICATIONS_PER_DAY = 150;

exports.sendPushNotification = functions.https.onRequest(async (req, res) => {
  console.log('Received payload', req.body);
  var today = getToday();
  var token = req.body.token;
  var ref = db.collection('rateLimits').doc(today).collection('tokens').doc(token);

  var currentCount = 0;
  var docExists = false;

  try {
    let currentDoc = await ref.get();
    docExists = currentDoc.exists;
    if(currentDoc.exists) {
      currentCount = currentDoc.data().count;
    }
  } catch(err) {
    console.error('Error getting document!', err);
    return res.status(500).send(err);
  }

  if(currentCount > MAX_NOTIFICATIONS_PER_DAY) {
    return res.status(429).send({
      errorType: 'RateLimited',
      message: 'The given target has reached the maximum number of notifications allowed per day. Please try again later.',
      target: token,
    });
  }

  var messageId;
  try {
    messageId = await admin.messaging().send(req.body);
  } catch(err) {
    console.log('Error sending message:', err);
    return res.status(500).send(err);
  }

  console.log('Successfully sent message:', messageId);

  var newCount = currentCount + 1;
  try {
    if(docExists) {
      console.log('Updating existing doc!');
      await ref.update({count: newCount})
    } else {
      console.log('Creating new doc!');
      await ref.set({count: newCount});
    }
  } catch(err) {
    if(docExists) {
      console.error('Error updating document!', err);
    } else {
      console.error('Error creating document!', err);
    }
    return res.status(500).send(err);
  }

  return res.status(200).send({
    messageId: messageId,
    sentPayload: req.body,
    target: token
  });

});

function getToday() {
  var today = new Date();
  var dd = String(today.getDate()).padStart(2, '0');
  var mm = String(today.getMonth() + 1).padStart(2, '0');
  var yyyy = today.getFullYear();
  return yyyy + mm + dd;
}
