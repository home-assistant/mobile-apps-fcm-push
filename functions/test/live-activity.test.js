'use strict';

const path = require('path');
const fs = require('fs');

const { createMockRequest, createMockResponse, createMockDocRef, createMockRateLimitData, setupFirestoreCollectionChain } = require('./utils/mock-factories');
const { assertResponse } = require('./utils/assertion-helpers');

// --- Mocks ---

const mockApns = { send: jest.fn() };
jest.mock('../apns', () => mockApns);

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
  getMessaging: jest.fn(() => ({ send: jest.fn() })),
}));
jest.mock('firebase-functions', () => ({
  config: jest.fn(() => ({})),
  region: jest.fn().mockReturnThis(),
  runWith: jest.fn().mockReturnThis(),
  https: { onRequest: jest.fn() },
}));

const { handleLiveActivityRequest } = require('../index.js');
const liveActivity = require('../live-activity');

// --- Helpers ---

const VALID_APNS_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

// Pass body field overrides directly (not nested under body: {}) to avoid
// createMockRequest's outer Object.assign overwriting the merged body.
function createLiveActivityRequest(bodyOverrides = {}) {
  return createMockRequest({
    body: {
      push_token: VALID_APNS_TOKEN,
      message: 'Test message',
      title: 'Test title',
      registration_info: {
        app_id: 'io.robbie.HomeAssistant',
        app_version: '2024.1',
        os_version: '17.0',
        apns_environment: 'sandbox',
      },
      data: {
        event: 'update',
        activity_id: 'test-001',
        content_state: { message: 'Test message' },
      },
      ...bodyOverrides,
    },
  });
}

function setupFirestoreMocks() {
  const docSnapshot = { exists: false, data: jest.fn(() => createMockRateLimitData()) };
  const docRef = createMockDocRef(docSnapshot);
  setupFirestoreCollectionChain(mockFirestore, docRef);

  mockFirestore.runTransaction.mockImplementation(async (callback) => {
    let exists = docSnapshot.exists;
    let currentData = exists ? { ...docSnapshot.data() } : null;

    const mockTxn = {
      get: jest.fn().mockImplementation(() => ({ exists, data: () => currentData || {} })),
      set: jest.fn().mockImplementation((ref, data) => {
        exists = true;
        currentData = { ...data };
        docSnapshot.exists = true;
        docSnapshot.data = jest.fn(() => currentData);
        docRef.set(data);
      }),
      update: jest.fn().mockImplementation((ref, data) => {
        if (currentData) {
          currentData = { ...currentData, ...data };
          docSnapshot.data = jest.fn(() => currentData);
        }
        docRef.update(data);
      }),
    };

    return callback(mockTxn);
  });

  return { docRef, docSnapshot };
}

// --- createPayload tests (fixture-driven) ---

const fixturesDir = path.join(__dirname, 'fixtures/live-activity');
const fixtureFiles = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

describe('live-activity createPayload', () => {
  it.each(fixtureFiles)('%s', (filename) => {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, filename), 'utf8'));
    const req = createMockRequest({ body: fixture.input });
    const result = liveActivity.createPayload(req);

    expect(result.updateRateLimits).toBe(fixture.expected.updateRateLimits);
    expect(result.apnsEnvironment).toBe(fixture.expected.apnsEnvironment);

    if (fixture.expected.apnsHeaders) {
      expect(result.apnsHeaders).toMatchObject(fixture.expected.apnsHeaders);
    }

    expect(result.apnsPayload.aps.event).toBe(fixture.expected.apsEvent);
    expect(typeof result.apnsPayload.aps.timestamp).toBe('number');

    if (fixture.expected.contentState) {
      expect(result.apnsPayload.aps['content-state']).toMatchObject(fixture.expected.contentState);
    }

    if (fixture.expected.attributesType) {
      expect(result.apnsPayload.aps['attributes-type']).toBe(fixture.expected.attributesType);
    }

    if (fixture.expected.attributes) {
      expect(result.apnsPayload.aps.attributes).toMatchObject(fixture.expected.attributes);
    }
  });
});

// --- handleLiveActivityRequest integration tests ---

describe('handleLiveActivityRequest', () => {
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApns.send.mockResolvedValue({ status: 200, apnsId: 'mock-apns-id', body: {} });
    res = createMockResponse();
    setupFirestoreMocks();
  });

  test('sends successfully and returns 201', async () => {
    const req = createLiveActivityRequest();
    await handleLiveActivityRequest(req, res, liveActivity.createPayload);

    expect(mockApns.send).toHaveBeenCalledTimes(1);
    const [sentToken, sentPayload, sentHeaders, sentEnv] = mockApns.send.mock.calls[0];
    expect(sentToken).toBe(VALID_APNS_TOKEN);
    expect(sentPayload.aps.event).toBe('update');
    expect(sentHeaders['apns-push-type']).toBe('liveactivity');
    expect(sentEnv).toBe('sandbox');

    assertResponse.expectSuccessResponse(res);
    const response = res.send.mock.calls[0][0];
    expect(response.messageId).toBe('mock-apns-id');
    expect(response.target).toBe(VALID_APNS_TOKEN);
    expect(response.rateLimits).toBeDefined();
  });

  test('rejects missing token with 403', async () => {
    const req = createLiveActivityRequest({ push_token: undefined });
    delete req.body.push_token;
    await handleLiveActivityRequest(req, res, liveActivity.createPayload);

    assertResponse.expectForbiddenResponse(res, 'You did not send a token!');
    expect(mockApns.send).not.toHaveBeenCalled();
  });

  test('rejects FCM token (contains colon) with 403', async () => {
    const req = createLiveActivityRequest({ push_token: 'fcm:token123' });
    await handleLiveActivityRequest(req, res, liveActivity.createPayload);

    assertResponse.expectForbiddenResponse(res, 'That is not a valid APNs token');
    expect(mockApns.send).not.toHaveBeenCalled();
  });

  test('rejects non-hex token with 403', async () => {
    const req = createLiveActivityRequest({ push_token: 'not-a-valid-token!!' });
    await handleLiveActivityRequest(req, res, liveActivity.createPayload);

    assertResponse.expectForbiddenResponse(res, 'That is not a valid APNs token');
    expect(mockApns.send).not.toHaveBeenCalled();
  });

  test('does not update rate limits for end events', async () => {
    const req = createLiveActivityRequest({ data: { event: 'end', activity_id: 'test-001' } });
    await handleLiveActivityRequest(req, res, liveActivity.createPayload);

    expect(mockApns.send).toHaveBeenCalledTimes(1);
    assertResponse.expectSuccessResponse(res);
    const response = res.send.mock.calls[0][0];
    // Rate limits should still be present (from checkRateLimit), just not incremented
    expect(response.rateLimits).toBeDefined();
  });

  test('returns 500 InvalidToken on APNs BadDeviceToken', async () => {
    mockApns.send.mockResolvedValue({ status: 400, apnsId: null, body: { reason: 'BadDeviceToken' } });
    const req = createLiveActivityRequest();
    await handleLiveActivityRequest(req, res, liveActivity.createPayload);

    assertResponse.expectErrorResponse(res, 500, { errorType: 'InvalidToken' });
  });

  test('returns 500 InternalError on APNs send failure', async () => {
    mockApns.send.mockRejectedValue(new Error('Network error'));
    const req = createLiveActivityRequest();
    await handleLiveActivityRequest(req, res, liveActivity.createPayload);

    assertResponse.expectErrorResponse(res, 500, {
      errorType: 'InternalError',
      errorStep: 'sendNotification',
    });
  });

  test('returns 500 InternalError on unexpected APNs status', async () => {
    mockApns.send.mockResolvedValue({ status: 500, apnsId: null, body: { reason: 'InternalServerError' } });
    const req = createLiveActivityRequest();
    await handleLiveActivityRequest(req, res, liveActivity.createPayload);

    assertResponse.expectErrorResponse(res, 500, { errorType: 'InternalError' });
  });

  test('returns 429 when rate limited', async () => {
    const { docSnapshot } = setupFirestoreMocks();
    docSnapshot.exists = true;
    docSnapshot.data.mockReturnValue(
      createMockRateLimitData({ attemptsCount: 501, deliveredCount: 501, totalCount: 501 }),
    );

    const req = createLiveActivityRequest();
    await handleLiveActivityRequest(req, res, liveActivity.createPayload);

    assertResponse.expectRateLimitResponse(res, VALID_APNS_TOKEN);
    expect(mockApns.send).not.toHaveBeenCalled();
  });
});

// --- createPayload unit tests ---

describe('live-activity createPayload unit', () => {
  test('defaults event to update when not specified', () => {
    const req = createLiveActivityRequest({ body: { data: {} } });
    const { apnsPayload } = liveActivity.createPayload(req);
    expect(apnsPayload.aps.event).toBe('update');
  });

  test('defaults apnsEnvironment to production when not specified', () => {
    const req = createMockRequest({
      body: {
        push_token: VALID_APNS_TOKEN,
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'update' },
      },
    });
    const { apnsEnvironment } = liveActivity.createPayload(req);
    expect(apnsEnvironment).toBe('production');
  });

  test('start event includes attributes-type and attributes', () => {
    const req = createMockRequest({
      body: {
        push_token: VALID_APNS_TOKEN,
        title: 'Laundry',
        registration_info: { app_id: 'io.robbie.HomeAssistant', apns_environment: 'sandbox' },
        data: { event: 'start', activity_id: 'laundry-001' },
      },
    });
    const { apnsPayload } = liveActivity.createPayload(req);
    expect(apnsPayload.aps['attributes-type']).toBe('HALiveActivityAttributes');
    expect(apnsPayload.aps.attributes).toEqual({ tag: 'laundry-001', title: 'Laundry' });
  });

  test('end event includes dismissal-date when provided', () => {
    const req = createMockRequest({
      body: {
        push_token: VALID_APNS_TOKEN,
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'end', dismissal_date: 9999999 },
      },
    });
    const { apnsPayload } = liveActivity.createPayload(req);
    expect(apnsPayload.aps['dismissal-date']).toBe(9999999);
  });

  test('stale-date and relevance-score are included when provided', () => {
    const req = createMockRequest({
      body: {
        push_token: VALID_APNS_TOKEN,
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'update', stale_date: 1111, relevance_score: 0.5 },
      },
    });
    const { apnsPayload } = liveActivity.createPayload(req);
    expect(apnsPayload.aps['stale-date']).toBe(1111);
    expect(apnsPayload.aps['relevance-score']).toBe(0.5);
  });

  test('apns-topic uses bundle id from registration_info', () => {
    const req = createMockRequest({
      body: {
        push_token: VALID_APNS_TOKEN,
        registration_info: { app_id: 'com.example.app', apns_environment: 'production' },
        data: { event: 'update' },
      },
    });
    const { apnsHeaders } = liveActivity.createPayload(req);
    expect(apnsHeaders['apns-topic']).toBe('com.example.app.push-type.liveactivity');
  });

  test('top-level message is used when no content_state', () => {
    const req = createMockRequest({
      body: {
        push_token: VALID_APNS_TOKEN,
        message: 'Hello from HA',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'update' },
      },
    });
    const { apnsPayload } = liveActivity.createPayload(req);
    expect(apnsPayload.aps['content-state'].message).toBe('Hello from HA');
  });
});
