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
jest.mock('firebase-functions/v1', () => ({
  config: jest.fn(() => ({})),
  region: jest.fn().mockReturnThis(),
  runWith: jest.fn().mockReturnThis(),
  https: { onRequest: jest.fn() },
}));

const { handleRequest } = require('../index.js');
const legacy = require('../legacy.js');

// --- Fixture-driven tests for existing legacy payload builder ---

describe('legacy.js', () => {
  const fixturesDir = './test/fixtures/legacy/';

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
    const result = legacy.createPayload(req);
    expect(result.payload.notification).toBeDefined();
    expect(result.payload.notification.body).toBe('Hello');
    expect(result.payload.apns.liveActivityToken).toBeUndefined();
    expect(result.payload.fcm_options.analytics_label).toBe('legacyNotification');
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

      const result = legacy.createPayload({ body: input });

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

// --- Live Activity helpers ---

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

// --- Live Activity fixture-driven tests ---

const liveActivityFixturesDir = path.join(__dirname, 'fixtures/live-activity');
const liveActivityFixtureFiles = fs
  .readdirSync(liveActivityFixturesDir)
  .filter((f) => f.endsWith('.json'));

describe('live-activity createPayload via FCM', () => {
  it.each(liveActivityFixtureFiles)('%s', (filename) => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(liveActivityFixturesDir, filename), 'utf8'),
    );
    const req = createMockRequest({ body: fixture.input });
    const result = legacy.createPayload(req);

    expect(result.updateRateLimits).toBe(fixture.expected.updateRateLimits);
    expect(result.payload.apns.liveActivityToken).toBe(fixture.expected.liveActivityToken);

    // No apns-push-type or apns-topic headers — FCM sets them automatically
    expect(result.payload.apns.headers['apns-push-type']).toBeUndefined();
    expect(result.payload.apns.headers['apns-topic']).toBeUndefined();

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
    if (fixture.expected.interruptionLevel) {
      expect(aps['interruption-level']).toBe(fixture.expected.interruptionLevel);
    }
    if (fixture.expected.alertSound) {
      expect(aps.sound).toBe(fixture.expected.alertSound);
    }

    expect(result.payload.fcm_options.analytics_label).toBe('iOSLiveActivityV1');
  });

  test('defaults event to update when not specified', () => {
    const req = createLiveActivityRequest({ data: {} });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps.event).toBe('update');
  });

  test('start event includes attributes-type and attributes', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        title: 'Laundry',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'start', tag: 'laundry-001' },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps['attributes-type']).toBe('HALiveActivityAttributes');
    expect(payload.apns.payload.aps.attributes).toEqual({
      tag: 'laundry-001',
      title: 'Laundry',
      started_at: expect.any(Number),
    });
  });

  test('start event stamps started_at with the server send-time in epoch seconds', () => {
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(1704067200000);

    try {
      const req = createMockRequest({
        body: {
          push_token: FCM_TOKEN,
          live_activity_token: LIVE_ACTIVITY_TOKEN,
          title: 'Laundry',
          registration_info: { app_id: 'io.robbie.HomeAssistant' },
          data: { event: 'start', tag: 'laundry-001' },
        },
      });
      const { payload } = legacy.createPayload(req);
      const aps = payload.apns.payload.aps;
      expect(aps.attributes.started_at).toBe(1704067200);
      expect(aps.attributes.started_at).toBe(aps.timestamp);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test('update and end events do not carry started_at (it is a start-only attribute)', () => {
    for (const event of ['update', 'end']) {
      const req = createLiveActivityRequest({ data: { event, tag: 'laundry-001' } });
      const { payload } = legacy.createPayload(req);
      expect(payload.apns.payload.aps.attributes).toBeUndefined();
    }
  });

  test('start event includes webhook_id in attributes when registration_info has one', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        title: 'Laundry',
        registration_info: { app_id: 'io.robbie.HomeAssistant', webhook_id: 'wh-123' },
        data: { event: 'start', tag: 'laundry-001' },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps.attributes).toEqual({
      tag: 'laundry-001',
      title: 'Laundry',
      webhook_id: 'wh-123',
      started_at: expect.any(Number),
    });
  });

  test('start event omits webhook_id from attributes when registration_info lacks one', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        title: 'Laundry',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'start', tag: 'laundry-001' },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps.attributes.webhook_id).toBeUndefined();
  });

  test('start event sets apns-collapse-id to the tag so duplicate starts coalesce', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        title: 'Laundry',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'start', tag: 'laundry-tag' },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.headers['apns-collapse-id']).toBe('laundry-tag');
  });

  test('start event omits apns-collapse-id when no tag is provided', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        title: 'Laundry',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'start' },
      },
    });
    const { payload } = legacy.createPayload(req);
    // The header must be omitted entirely, not set to an empty/undefined value:
    // APNs rejects an empty apns-collapse-id.
    expect('apns-collapse-id' in payload.apns.headers).toBe(false);
  });

  test('update event does not set apns-collapse-id so every update is delivered', () => {
    const req = createLiveActivityRequest({
      data: { event: 'update', tag: 'laundry-001' },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.headers['apns-collapse-id']).toBeUndefined();
  });

  test('end event does not set apns-collapse-id so the dismissal is delivered', () => {
    const req = createLiveActivityRequest({ data: { event: 'end', tag: 'laundry-001' } });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.headers['apns-collapse-id']).toBeUndefined();
  });

  test('url in data is forwarded into content-state for tap navigation', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        message: 'Laundry running',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'update', url: '/lovelace/laundry' },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps['content-state'].url).toBe('/lovelace/laundry');
  });

  test('background_color in data is forwarded into content-state', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        message: 'Laundry running',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'update', background_color: '#101820' },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps['content-state'].background_color).toBe('#101820');
  });

  test('start event synthesizes alert without sound when alert is omitted', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        title: 'Laundry',
        message: 'Rinsing',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'start', tag: 'laundry-001' },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps.alert).toEqual({ title: 'Laundry', body: 'Rinsing' });
    expect(payload.apns.payload.aps['interruption-level']).toBeUndefined();
    expect(payload.apns.payload.aps.sound).toBeUndefined();
  });

  test('attributes-type is only set for start events, not update or end', () => {
    for (const event of ['update', 'end']) {
      const req = createLiveActivityRequest({ data: { event, activity_id: 'test-001' } });
      const { payload } = legacy.createPayload(req);
      expect(payload.apns.payload.aps['attributes-type']).toBeUndefined();
      expect(payload.apns.payload.aps.attributes).toBeUndefined();
    }
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
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps['dismissal-date']).toBe(9999999);
  });

  test('clear_notification end event dismisses immediately by default', () => {
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(1704067200000);

    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        message: 'clear_notification',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'end', tag: 'washer_cycle' },
      },
    });
    const { payload } = legacy.createPayload(req);
    const aps = payload.apns.payload.aps;
    expect(aps['dismissal-date']).toBe(1704067200);
    expect(aps['content-state']).toEqual({ message: '' });
    expect(aps.alert).toEqual({ title: '', body: '' });
    expect(aps['interruption-level']).toBeUndefined();
    expect(aps.sound).toBeUndefined();

    dateNowSpy.mockRestore();
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
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps['stale-date']).toBe(1111);
    expect(payload.apns.payload.aps['relevance-score']).toBe(0.5);
  });

  test('content-state maps fields correctly', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        title: 'Timer',
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
            countdown_end: 1704067200,
            icon: 'mdi:test',
            color: '#FF0000',
          },
        },
      },
    });
    const { payload } = legacy.createPayload(req);
    const cs = payload.apns.payload.aps['content-state'];
    expect(cs.title).toBe('Timer');
    expect(cs.message).toBe('Override');
    expect(cs.critical_text).toBe('Critical');
    expect(cs.progress).toBe(50);
    expect(cs.progress_max).toBe(100);
    expect(cs.chronometer).toBe(true);
    expect(cs.countdown_end).toBe(1704067200);
    expect(cs.icon).toBe('mdi:test');
    expect(cs.color).toBe('#FF0000');
  });

  test('flat Live Activity fields are translated into content-state', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        title: 'Washing Machine',
        message: 'Rinsing',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: {
          event: 'update',
          critical_text: 'Rinse',
          progress: 900,
          progress_max: 3600,
          chronometer: true,
          notification_icon: 'mdi:washing-machine',
          notification_icon_color: '#2196F3',
          background_color: '#101820',
          text_color: '#FFFFFF',
          progress_bar_color: '#FF9800',
        },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps['content-state']).toMatchObject({
      title: 'Washing Machine',
      message: 'Rinsing',
      critical_text: 'Rinse',
      progress: 900,
      progress_max: 3600,
      chronometer: true,
      icon: 'mdi:washing-machine',
      color: '#2196F3',
      background_color: '#101820',
      text_color: '#FFFFFF',
      progress_bar_color: '#FF9800',
    });
  });

  test('explicit content_state takes precedence over flat fields', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        message: 'Fallback',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: {
          event: 'update',
          progress: 100,
          notification_icon: 'mdi:washing-machine',
          content_state: {
            title: 'Override title',
            message: 'Override',
            progress: 999,
            icon: 'mdi:timer',
          },
        },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps['content-state']).toMatchObject({
      title: 'Override title',
      message: 'Override',
      progress: 999,
      icon: 'mdi:timer',
    });
  });

  test('relative when is translated into countdown_end', () => {
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(1704067200000);

    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'update', when: 300, when_relative: true },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps['content-state'].countdown_end).toBe(1704067500);
    dateNowSpy.mockRestore();
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
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps['content-state'].message).toBe('Hello from HA');
  });

  test('update event uses real alert with sound by default', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        title: 'Laundry',
        message: 'Rinsing',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'update', tag: 'laundry-001' },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps.alert).toEqual({ title: 'Laundry', body: 'Rinsing' });
    expect(payload.apns.payload.aps['interruption-level']).toBeUndefined();
    expect(payload.apns.payload.aps.sound).toBeUndefined();
  });

  test('update event with silent: true uses title-only alert', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        title: 'Laundry',
        message: 'Rinsing',
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'update', tag: 'laundry-001', silent: true },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps.alert).toEqual({ title: '' });
    expect(payload.apns.payload.aps['interruption-level']).toBeUndefined();
    expect(payload.apns.payload.aps.sound).toBeUndefined();
  });

  test('content-state includes empty message when top-level message is omitted', () => {
    const req = createMockRequest({
      body: {
        push_token: FCM_TOKEN,
        live_activity_token: LIVE_ACTIVITY_TOKEN,
        registration_info: { app_id: 'io.robbie.HomeAssistant' },
        data: { event: 'update', progress: 1 },
      },
    });
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.payload.aps['content-state']).toMatchObject({
      message: '',
      progress: 1,
    });
  });

  test('liveActivityToken is set from req.body.live_activity_token', () => {
    const req = createLiveActivityRequest();
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.liveActivityToken).toBe(LIVE_ACTIVITY_TOKEN);
  });

  test('apns-priority header is set to 10', () => {
    const req = createLiveActivityRequest();
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.headers['apns-priority']).toBe('10');
  });

  test('no apns-push-type or apns-topic headers (FCM sets them)', () => {
    const req = createLiveActivityRequest();
    const { payload } = legacy.createPayload(req);
    expect(payload.apns.headers['apns-push-type']).toBeUndefined();
    expect(payload.apns.headers['apns-topic']).toBeUndefined();
  });

  test('all live activity events update rate limits', () => {
    for (const event of ['start', 'update', 'end']) {
      const req = createLiveActivityRequest({ data: { event, activity_id: 'test-001' } });
      const result = legacy.createPayload(req);
      expect(result.updateRateLimits).toBe(true);
    }
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
    await handleRequest(req, res, legacy.createPayload);

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

  test('updates rate limits for end events', async () => {
    const req = createLiveActivityRequest({ data: { event: 'end', activity_id: 'test-001' } });
    await handleRequest(req, res, legacy.createPayload);

    expect(mockMessaging.send).toHaveBeenCalledTimes(1);
    assertResponse.expectSuccessResponse(res);
    const response = res.send.mock.calls[0][0];
    expect(response.rateLimits).toBeDefined();
  });
});
