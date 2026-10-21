'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  createMockRequest,
  createMockResponse,
  createMockDocRef,
  createMockRateLimitData,
  setupFirestoreCollectionChain,
} = require('./utils/mock-factories');
const { assertResponse } = require('./utils/assertion-helpers');

// --- Mocks (required for handleRequest integration tests) ---

const mockMessaging = { send: jest.fn() };
const mockFirestore = { collection: jest.fn(), runTransaction: jest.fn() };
const mockLogging = {
  log: jest.fn(() => ({
    write: jest.fn((entry, cb) => cb()),
    entry: jest.fn(() => ({})),
    debug: jest.fn(),
    info: jest.fn(),
  })),
};

jest.mock('@google-cloud/logging', () => ({ Logging: jest.fn(() => mockLogging) }));
jest.mock('firebase-admin/app', () => ({ initializeApp: jest.fn() }));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockFirestore),
  Timestamp: { fromDate: jest.fn(() => 'mock-timestamp') },
}));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => mockMessaging),
}));

const { handleRequest } = require('../handlers.js');
const ios = require('../ios.js');

const FCM_TOKEN = 'test:fcm-token-123';

// --- Fixture-driven tests for iOS payload builder ---

describe('ios.js', () => {
  const fixturesDir = './test/fixtures/ios/';

  test('builds a standard notification payload', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        message: 'Hello',
        title: 'Test',
        registration_info: {
          app_id: 'io.robbie.HomeAssistant',
          app_version: '2024.1',
          os_version: '17.0',
        },
      },
    });
    const result = ios.createPayload(req);
    expect(result.payload.notification).toBeDefined();
    expect(result.payload.notification.body).toBe('Hello');
    expect(result.payload.apns.liveActivityToken).toBeUndefined();
    expect(result.payload.fcm_options.analytics_label).toBe('ios_notification');
  });

  // Get fixture files synchronously for test definition
  const files = fs.readdirSync(fixturesDir);
  const jsonFiles = files.filter((file) => file.endsWith('.json'));

  // Use it.each for parameterized tests with fixture files
  it.each(jsonFiles)('should handle %s', (file, done) => {
    fs.readFile(fixturesDir + file, 'utf8', (err, data) => {
      if (err) {
        done(err);
        return;
      }

      const json = JSON.parse(data);
      const input = json['input'];
      const expected = {
        payload: {
          apns: {
            headers: json['headers'],
            payload: json['payload'],
          },
        },
        updateRateLimits: json['rate_limit'],
      };

      const result = ios.createPayload({ body: input });

      // Remove things that aren't worth copy/pasting between test cases
      delete result['payload']['android'];
      delete result['payload']['notification'];
      delete result['payload']['fcm_options'];

      assert.deepStrictEqual(result, expected);
      done();
    });
  });

  // Ensure we have fixture files to test
  it('should have fixture files to test', () => {
    expect(jsonFiles.length).toBeGreaterThan(0);
  });
});
