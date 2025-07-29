'use strict';

const functions = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');

// We need to initialize the app before importing modules that want Firestore.
initializeApp();

const android = require('./android');
const ios = require('./ios');
const legacy = require('./legacy');

const region = (functions.config().app && functions.config().app.region) || 'us-central1';
const regionalFunctions = functions.region(region).runWith({ timeoutSeconds: 10 });

// These must be imported before the handlers to ensure they are initialized correctly
process.env.DEBUG = isDebug() ? 'true' : 'false';
process.env.REGION = region;

const { handleRequest, handleCheckRateLimits } = require('./handlers');

exports.androidV1 = regionalFunctions.https.onRequest(async (req, res) =>
  handleRequest(req, res, android.createPayload),
);

exports.iOSV1 = regionalFunctions.https.onRequest(async (req, res) =>
  handleRequest(req, res, ios.createPayload),
);

exports.sendPushNotification = regionalFunctions.https.onRequest(async (req, res) =>
  handleRequest(req, res, legacy.createPayload),
);

exports.checkRateLimits = regionalFunctions.https.onRequest(async (req, res) =>
  handleCheckRateLimits(req, res),
);

function isDebug() {
  let conf = functions.config();
  if (conf.debug) {
    return conf.debug.local === 'true';
  }
  return false;
}

exports.handleRequest = handleRequest;
exports.handleCheckRateLimits = handleCheckRateLimits;
