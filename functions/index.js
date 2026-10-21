'use strict';

const functions = require('firebase-functions/v1');
const { defineBoolean, defineString } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');

// Deploy-time configuration. These replace the `app.region` and `debug.local`
// values that used to come from `functions.config()`, which was removed in
// firebase-functions v7. Values are read from `.env` files in this directory
// (see README.md) and exposed to the function as environment variables.
const appRegion = defineString('APP_REGION', {
  default: 'us-central1',
  description: 'Region to deploy the Cloud Functions to',
});
const debugLocal = defineBoolean('DEBUG_LOCAL', {
  default: false,
  description: 'Enable debug logging',
});

// We need to initialize the app before importing modules that want Firestore.
initializeApp();

const android = require('./android');
const ios = require('./ios');

// v1 `functions.region()` only accepts plain strings, so the param is resolved
// here at load time rather than passed through as a param expression.
const region = appRegion.value() || 'us-central1';
const regionalFunctions = functions.region(region).runWith({ timeoutSeconds: 10 });

// These must be imported before the handlers to ensure they are initialized correctly
process.env.DEBUG = isDebug().toString();
process.env.REGION = region;

const { handleRequest, handleCheckRateLimits } = require('./handlers');

exports.androidV1 = regionalFunctions.https.onRequest(async (req, res) =>
  handleRequest(req, res, android.createPayload),
);

exports.sendPushNotification = regionalFunctions.https.onRequest(async (req, res) =>
  handleRequest(req, res, ios.createPayload),
);

exports.checkRateLimits = regionalFunctions.https.onRequest(async (req, res) =>
  handleCheckRateLimits(req, res),
);

function isDebug() {
  return debugLocal.value() === true;
}

exports.handleRequest = handleRequest;
exports.handleCheckRateLimits = handleCheckRateLimits;
