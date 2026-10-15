'use strict';

const { setupFirebaseMocks } = require('./utils/firebase-mocks');

// Keep the real firebase-functions SDK so this test catches module-load breakage
// against the installed version (e.g. the removal of functions.config() in v7).
setupFirebaseMocks({ mockFirebaseFunctions: false });

describe('index.js', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, GCLOUD_PROJECT: 'local-test' };
    delete process.env.APP_REGION;
    delete process.env.DEBUG_LOCAL;
    delete process.env.REGION;
    delete process.env.DEBUG;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test('loads and exports the Cloud Function handlers', () => {
    const index = require('../index');
    const { initializeApp } = require('firebase-admin/app');

    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(typeof index.androidV1).toBe('function');
    expect(typeof index.sendPushNotification).toBe('function');
    expect(typeof index.checkRateLimits).toBe('function');
  });

  test('defaults region to us-central1 and debug to false', () => {
    require('../index');

    expect(process.env.REGION).toBe('us-central1');
    expect(process.env.DEBUG).toBe('false');
  });

  test('reads region and debug from the APP_REGION and DEBUG_LOCAL params', () => {
    process.env.APP_REGION = 'europe-west1';
    process.env.DEBUG_LOCAL = 'true';

    require('../index');

    expect(process.env.REGION).toBe('europe-west1');
    expect(process.env.DEBUG).toBe('true');
  });
});
