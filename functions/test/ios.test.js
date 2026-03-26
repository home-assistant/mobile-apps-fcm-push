'use strict';

const path = require('path');
const fs = require('fs');

const { createMockRequest, createMockResponse, createMockDocRef, createMockRateLimitData, setupFirestoreCollectionChain } = require('./utils/mock-factories');
const { assertResponse } = require('./utils/assertion-helpers');

// --- Mocks ---

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
jest.mock('firebase-functions', () => ({
  config: jest.fn(() => ({})),
  region: jest.fn().mockReturnThis(),
  runWith: jest.fn().mockReturnThis(),
  https: { onRequest: jest.fn() },
}));

const { handleRequest } = require('../index.js');
const ios = require('../ios');

// --- Helpers ---

const FCM_TOKEN = 'test:fcm-token-123';
const LIVE_ACTIVITY_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function createLiveActivityRequest(bodyOverrides = {}) {
  return createMockRequest({
    body: {
      push_token: FCM_TOKEN,
      live_activity_token: LIVE_ACTIVITY_TOKEN,
      message: 'Test message',
      title: 'Test title',
      registration_info: {
        app_id: 'io.robbie.HomeAssistant',
        app_version: '2024.1',
        os_version: '17.0',
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

// --- Fixture-driven tests ---

const fixturesDir = path.join(__dirname, 'fixtures/live-activity');
const fixtureFiles = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

describe('live-activity createPayload via FCM', () => {
  // Fixture-driven tests: load each fixture, call ios.createPayload with
  // live_activity_token in the body, assert the returned payload has
  // apns.liveActivityToken and correct aps fields.
  it.each(fixtureFiles)('%s', (filename) => {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, filename), 'utf8'));
    const req = createMockRequest({ body: fixture.input });
    const result = ios.createPayload(req);

    expect(result.updateRateLimits).toBe(fixture.expected.updateRateLimits);

    // liveActivityToken should be set from the input
    expect(result.payload.apns.liveActivityToken).toBe(fixture.expected.liveActivityToken);

    // apns-priority header should be '10'
    expect(result.payload.apns.headers['apns-priority']).toBe('10');

    // No apns-push-type or apns-topic headers — FCM sets them automatically
    expect(result.payload.apns.headers['apns-push-type']).toBeUndefined();
    expect(result.payload.apns.headers['apns-topic']).toBeUndefined();

    // Check aps fields
    const aps = result.payload.apns.payload.aps;
    expect(aps.event).toBe(fixture.expected.apsEvent);
    expect(typeof aps.timestamp).toBe('number');

    if (fixture.expected.contentState) {
      expect(aps['content-state']).toMatchObject(fixture.expected.contentState);
    }

    if (fixture.expected.attributesType) {
      expect(aps['attributes-type']).toBe(fixture.expected.attributesType);
    }

    if (fixture.expected.attributes) {
      expect(aps.attributes).toMatchObject(fixture.expected.attributes);
    }

    if (fixture.expected.dismissalDate) {
      expect(aps['dismissal-date']).toBe(fixture.expected.dismissalDate);
    }

    if (fixture.expected.staleDate) {
      expect(aps['stale-date']).toBe(fixture.expected.staleDate);
    }

    if (fixture.expected.relevanceScore) {
      expect(aps['relevance-score']).toBe(fixture.expected.relevanceScore);
    }

    if (fixture.expected.alert) {
      expect(aps.alert).toMatchObject(fixture.expected.alert);
    }

    if (fixture.expected.alertSound) {
      expect(aps.sound).toBe(fixture.expected.alertSound);
    }

    // analytics_label should be set for Live Activity
    expect(result.payload.fcm_options.analytics_label).toBe('iOSLiveActivityV1');
  });

  // --- Unit tests for the FCM payload builder ---

  test('defaults event to update when not specified', () => {
    const req = createLiveActivityRequest({ data: {} });
    const { payload } = ios.createPayload(req);
    expect(payload.apns.payload.aps.event).toBe('update');
  });

  test('start event includes attributes-type and attributes', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        title: 'Laundry',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'start', activity_id: 'laundry-001' },
      },
    });
    const { payload } = ios.createPayload(req);
    expect(payload.apns.payload.aps['attributes-type']).toBe('HALiveActivityAttributes');
    expect(payload.apns.payload.aps.attributes).toEqual({ tag: 'laundry-001', title: 'Laundry' });
  });

  test('end event includes dismissal-date when provided', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'end', dismissal_date: 9999999 },
      },
    });
    const { payload } = ios.createPayload(req);
    expect(payload.apns.payload.aps['dismissal-date']).toBe(9999999);
  });

  test('stale-date and relevance-score are included when provided', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'update', stale_date: 1111, relevance_score: 0.5 },
      },
    });
    const { payload } = ios.createPayload(req);
    expect(payload.apns.payload.aps['stale-date']).toBe(1111);
    expect(payload.apns.payload.aps['relevance-score']).toBe(0.5);
  });

  test('content-state maps fields correctly', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        message: 'Fallback',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: {
          event: 'update',
          content_state: {
            message: 'Override',
            critical_text: 'Critical',
            progress: 50,
            progress_max: 100,
            chronometer: true,
            countdown_end: '2024-01-01T00:00:00Z',
            icon: 'mdi:test',
            color: '#FF0000',
          },
        },
      },
    });
    const { payload } = ios.createPayload(req);
    const cs = payload.apns.payload.aps['content-state'];
    expect(cs.message).toBe('Override');
    expect(cs.critical_text).toBe('Critical');
    expect(cs.progress).toBe(50);
    expect(cs.progress_max).toBe(100);
    expect(cs.chronometer).toBe(true);
    expect(cs.countdown_end).toBe('2024-01-01T00:00:00Z');
    expect(cs.icon).toBe('mdi:test');
    expect(cs.color).toBe('#FF0000');
  });

  test('top-level message is used when no content_state', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        message: 'Hello from HA',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'update' },
      },
    });
    const { payload } = ios.createPayload(req);
    expect(payload.apns.payload.aps['content-state'].message).toBe('Hello from HA');
  });

  test('liveActivityToken is set from req.body.live_activity_token', () => {
    const req = createLiveActivityRequest();
    const { payload } = ios.createPayload(req);
    expect(payload.apns.liveActivityToken).toBe(LIVE_ACTIVITY_TOKEN);
  });

  test('apns-priority header is set to 10', () => {
    const req = createLiveActivityRequest();
    const { payload } = ios.createPayload(req);
    expect(payload.apns.headers['apns-priority']).toBe('10');
  });

  test('no apns-push-type or apns-topic headers (FCM sets them)', () => {
    const req = createLiveActivityRequest();
    const { payload } = ios.createPayload(req);
    expect(payload.apns.headers['apns-push-type']).toBeUndefined();
    expect(payload.apns.headers['apns-topic']).toBeUndefined();
  });

  test('all live activity events update rate limits', () => {
    for (const event of ['start', 'update', 'end']) {
      const req = createLiveActivityRequest({ data: { event, activity_id: 'test-001' } });
      const result = ios.createPayload(req);
      expect(result.updateRateLimits).toBe(true);
    }
  });

  test('normal notifications (no live_activity_token) still work as before', () => {
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
    // Normal notification should have notification object, not liveActivityToken
    expect(result.payload.notification).toBeDefined();
    expect(result.payload.notification.body).toBe('Hello');
    expect(result.payload.apns.liveActivityToken).toBeUndefined();
    expect(result.payload.fcm_options.analytics_label).toBe('iosV1Notification');
  });
});

// --- handleRequest integration tests for Live Activity ---

describe('handleRequest with Live Activity payload', () => {
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMessaging.send.mockResolvedValue('mock-message-id');
    res = createMockResponse();
    setupFirestoreMocks();
  });

  test('sends Live Activity via FCM and returns 201', async () => {
    const req = createLiveActivityRequest();
    await handleRequest(req, res, ios.createPayload);

    expect(mockMessaging.send).toHaveBeenCalledTimes(1);
    const sentPayload = mockMessaging.send.mock.calls[0][0];
    expect(sentPayload.apns.liveActivityToken).toBe(LIVE_ACTIVITY_TOKEN);
    expect(sentPayload.apns.payload.aps.event).toBe('update');
    expect(sentPayload.apns.headers['apns-priority']).toBe('10');
    expect(sentPayload.token).toBe(FCM_TOKEN);

    assertResponse.expectSuccessResponse(res);
    const response = res.send.mock.calls[0][0];
    expect(response.messageId).toBe('mock-message-id');
    expect(response.target).toBe(FCM_TOKEN);
    expect(response.rateLimits).toBeDefined();
  });

  test('rejects missing token with 403', async () => {
    const req = createLiveActivityRequest({ push_token: undefined });
    delete req.body.push_token;
    await handleRequest(req, res, ios.createPayload);

    assertResponse.expectForbiddenResponse(res, 'You did not send a token!');
    expect(mockMessaging.send).not.toHaveBeenCalled();
  });

  test('updates rate limits for end events', async () => {
    const req = createLiveActivityRequest({ data: { event: 'end', activity_id: 'test-001' } });
    await handleRequest(req, res, ios.createPayload);

    expect(mockMessaging.send).toHaveBeenCalledTimes(1);
    assertResponse.expectSuccessResponse(res);
    const response = res.send.mock.calls[0][0];
    expect(response.rateLimits).toBeDefined();
  });

  test('returns 500 on FCM send failure', async () => {
    mockMessaging.send.mockRejectedValue(new Error('Network error'));
    const req = createLiveActivityRequest();
    await handleRequest(req, res, ios.createPayload);

    assertResponse.expectErrorResponse(res, 500, {
      errorType: 'InternalError',
      errorStep: 'sendNotification',
    });
  });

  test('returns 429 when rate limited', async () => {
    const { docSnapshot } = setupFirestoreMocks();
    docSnapshot.exists = true;
    docSnapshot.data.mockReturnValue(
      createMockRateLimitData({ attemptsCount: 501, deliveredCount: 501, totalCount: 501 }),
    );

    const req = createLiveActivityRequest();
    await handleRequest(req, res, ios.createPayload);

    assertResponse.expectRateLimitResponse(res, FCM_TOKEN);
    expect(mockMessaging.send).not.toHaveBeenCalled();
  });
});
