'use strict';

const {
  createMockRequest,
  createMockResponse,
  createMockPayloadHandler,
  createMockDocRef,
  createMockRateLimitData,
} = require('./utils/mock-factories');

const mockMessaging = { send: jest.fn() };
const mockFirestore = { collection: jest.fn(), runTransaction: jest.fn() };
const mockFunctions = {
  config: jest.fn(() => ({})),
  logger: { info: jest.fn(), warn: jest.fn() },
  region: jest.fn().mockReturnThis(),
  runWith: jest.fn().mockReturnThis(),
  https: { onRequest: jest.fn() },
};
const logWrites = [];
const mockLogging = {
  log: jest.fn(() => ({
    write: jest.fn((entry, callback) => callback()),
    entry: jest.fn((metadata, payload) => {
      logWrites.push(payload);
      return {};
    }),
    debug: jest.fn(),
    info: jest.fn(),
    alert: jest.fn(),
  })),
};

jest.mock('firebase-functions/v1', () => mockFunctions);
jest.mock('@google-cloud/logging', () => ({ Logging: jest.fn(() => mockLogging) }));
jest.mock('firebase-admin/app', () => ({ initializeApp: jest.fn() }));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockFirestore),
  Timestamp: { fromDate: jest.fn(() => 'mock-timestamp') },
}));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn(() => mockMessaging) }));

const handlers = require('../handlers.js');
const legacy = require('../legacy.js');
const { destinationIdentity, setNowPlayingProvider, tokenFingerprint } = require('../now-playing');
const { NOW_PLAYING_DESTINATION_PREFIX, NOW_PLAYING_KEY_PREFIX } = require('../rate-limiter/util');

const TOKEN = 'de1ec7ab1ede1ec7ab1ede1ec7ab1ede';
const FCM_TOKEN = 'test:token123';
const NOW_PLAYING_DOC = `${NOW_PLAYING_KEY_PREFIX}${FCM_TOKEN}`;
const DESTINATION_DOC = `${NOW_PLAYING_KEY_PREFIX}${NOW_PLAYING_DESTINATION_PREFIX}${destinationIdentity(TOKEN)}`;

/** Document ids the rate limiters addressed, so which quota was charged is observable. */
const docIds = [];
/** Documents a test has declared full, so one quota can be exhausted without the other. */
const limitedDocs = new Set();
/** Live counters per document. */
const counters = new Map();
/** What a test asked every not-yet-written document to start at, if anything. */
let baseline = null;

/** The counters a document currently holds, or `null` when it does not exist yet. */
const stateOf = (id) => {
  if (limitedDocs.has(id)) {
    return createMockRateLimitData({
      attemptsCount: 5001,
      deliveredCount: 5001,
      totalCount: 5001,
    });
  }
  if (counters.has(id)) return counters.get(id);
  return baseline;
};

const nowPlayingBody = (overrides = {}) => ({
  push_token: FCM_TOKEN,
  now_playing_token: TOKEN,
  registration_info: {
    app_id: 'io.robbie.HomeAssistant',
    app_version: '2026.9.1',
    webhook_id: 'webhook-1',
    os_version: '27.0',
  },
  now_playing: {
    event: 'update',
    timestamp: 1788749001,
    attributes: { id: 'remote-media-123', schemaVersion: 1 },
  },
  ...overrides,
});

/** A provider that records what it was asked to send. */
const fakeProvider = (response = { status: 200, apnsId: 'APNS-1', reason: null }) => ({
  sent: [],
  send(request) {
    this.sent.push(request);
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  },
});

describe('Now Playing delivery through sendPushNotification', () => {
  let req, res, docRef, docSnapshot;

  /** Starts every Now Playing counter at `count`. */
  const withCounters = (count) => {
    baseline = createMockRateLimitData({
      attemptsCount: count,
      deliveredCount: count,
      totalCount: count,
    });
    docSnapshot.exists = true;
    docSnapshot.data.mockReturnValue(baseline);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    logWrites.length = 0;
    mockMessaging.send.mockResolvedValue('mock-message-id');

    res = createMockResponse();
    docSnapshot = { exists: false, data: jest.fn(() => createMockRateLimitData()) };
    docRef = createMockDocRef(docSnapshot);
    docIds.length = 0;
    limitedDocs.clear();
    counters.clear();
    baseline = null;

    // Counters are per document, because the two Now Playing quotas are two documents and a test
    // has to be able to fill one without filling the other.
    mockFirestore.collection.mockReturnValue({
      doc: jest.fn(() => ({
        collection: jest.fn(() => ({
          doc: jest.fn((id) => {
            docIds.push(id);
            return {
              id,
              // `checkRateLimit` reads through this, so it has to see the same per-document
              // counters the transaction does.
              get: async () => {
                const current = stateOf(id);
                return { exists: current !== null, data: () => current || {} };
              },
              set: (data) => docRef.set(data),
              update: (data) => docRef.update(data),
            };
          }),
        })),
      })),
    });
    mockFirestore.runTransaction.mockImplementation(async (callback) =>
      callback({
        get: jest.fn((ref) => {
          const current = stateOf(ref.id);
          return { exists: current !== null, data: () => current || {} };
        }),
        set: jest.fn((ref, data) => {
          counters.set(ref.id, { ...data });
          docSnapshot.exists = true;
          docSnapshot.data = jest.fn(() => ({ ...data }));
          docRef.set(data);
        }),
        update: jest.fn((ref, data) => {
          const current = stateOf(ref.id);
          if (current) {
            counters.set(ref.id, { ...current, ...data });
            docSnapshot.data = jest.fn(() => ({ ...current, ...data }));
          }
          docRef.update(data);
        }),
      }),
    );
  });

  afterEach(() => {
    setNowPlayingProvider(undefined);
  });

  describe('routing', () => {
    test('an ordinary notification still goes through Firebase', async () => {
      const provider = fakeProvider();
      setNowPlayingProvider(provider);
      req = createMockRequest();
      await handlers.handleRequest(req, res, createMockPayloadHandler());

      expect(mockMessaging.send).toHaveBeenCalledTimes(1);
      expect(provider.sent).toHaveLength(0);
      expect(res.status).toHaveBeenCalledWith(201);
    });

    /// Live Activities work through Firebase Admin's own liveActivityToken support and must not
    /// be re-routed onto the direct provider.
    test('a Live Activity still goes through Firebase with liveActivityToken', async () => {
      const provider = fakeProvider();
      setNowPlayingProvider(provider);
      req = createMockRequest({
        body: {
          push_token: FCM_TOKEN,
          live_activity_token: 'la-token-abc',
          message: 'Doing a thing',
          data: { event: 'update', tag: 'laundry' },
          registration_info: { app_id: 'io.robbie.HomeAssistant', app_version: '2026.9.1' },
        },
      });
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(provider.sent).toHaveLength(0);
      expect(mockMessaging.send).toHaveBeenCalledTimes(1);
      expect(mockMessaging.send.mock.calls[0][0].apns.liveActivityToken).toBe('la-token-abc');
    });

    test('a now_playing_token goes to the direct provider, not Firebase', async () => {
      const provider = fakeProvider();
      setNowPlayingProvider(provider);
      req = createMockRequest({ body: nowPlayingBody() });
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(mockMessaging.send).not.toHaveBeenCalled();
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]).toMatchObject({
        token: TOKEN,
        topic: 'io.robbie.HomeAssistant.push-type.nowplaying',
        pushType: 'nowplaying',
      });
    });

    /// The ordinary FCM token is still required: it is the registration and metering identity.
    test('a Now Playing request without a Companion token is refused', async () => {
      setNowPlayingProvider(fakeProvider());
      req = createMockRequest({ body: { ...nowPlayingBody(), push_token: undefined } });
      await handlers.handleRequest(req, res, legacy.createPayload);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    /// Every refusal from this path carries one step name, so Home Assistant only has to read
    /// `errorType`.
    test.each([
      [
        'a request-shape refusal',
        () => nowPlayingBody({ live_activity_token: 'la-token' }),
        400,
        'AmbiguousRequest',
      ],
      [
        'an app this relay does not serve',
        () => nowPlayingBody({ registration_info: { app_id: 'evil.example.app' } }),
        403,
        'UnsupportedApp',
      ],
    ])('%s is refused before any APNs traffic', async (_label, body, status, errorType) => {
      const provider = fakeProvider();
      setNowPlayingProvider(provider);
      req = createMockRequest({ body: body() });
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(provider.sent).toHaveLength(0);
      expect(mockMessaging.send).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.send).toHaveBeenCalledWith(
        expect.objectContaining({ errorType, errorStep: 'sendNowPlaying' }),
      );
      // Nothing was charged either.
      expect(docRef.set).not.toHaveBeenCalled();
      // And the refusal discloses neither the destination token nor the configured allowlist.
      const serialized = JSON.stringify(res.send.mock.calls[0][0]);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain('io.robbie');
    });

    test('a deployment with no credentials says so instead of failing obscurely', async () => {
      setNowPlayingProvider(null);
      req = createMockRequest({ body: nowPlayingBody() });
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(mockMessaging.send).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(501);
      expect(res.send).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: 'NowPlayingNotConfigured' }),
      );
    });
  });

  describe('the answer to Home Assistant', () => {
    test('a delivery reports the apns-id and a fingerprint rather than the token', async () => {
      setNowPlayingProvider(fakeProvider({ status: 200, apnsId: 'APNS-42', reason: null }));
      req = createMockRequest({ body: nowPlayingBody() });
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(res.status).toHaveBeenCalledWith(201);
      const body = res.send.mock.calls[0][0];
      expect(body).toMatchObject({ messageId: 'APNS-42', target: tokenFingerprint(TOKEN) });
      expect(body.sentPayload.aps.attributes.id).toBe('remote-media-123');
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    });

    /// Only a genuinely dead token may carry `InvalidToken`: Home Assistant unregisters on it,
    /// and losing a registration over a topic or credential fault would silently stop a feature
    /// the user never turned off.
    /// The mapping itself is covered exhaustively against `classifyApnsResponse`. What matters
    /// here is that its verdict reaches the response: the one that retires a registration, one
    /// that must not be mistaken for it, and a refusal nobody has seen before.
    test.each([
      [410, 'Unregistered', 410, 'InvalidToken'],
      [400, 'DeviceTokenNotForTopic', 400, 'TopicMismatch'],
      [400, 'SomethingNewFromApple', 502, 'ApnsError'],
    ])('APNs %i %s answers HTTP %i %s', async (apnsStatus, reason, httpStatus, errorType) => {
      setNowPlayingProvider(fakeProvider({ status: apnsStatus, apnsId: 'APNS-1', reason }));
      req = createMockRequest({ body: nowPlayingBody() });
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(res.status).toHaveBeenCalledWith(httpStatus);
      expect(res.send).toHaveBeenCalledWith(
        expect.objectContaining({ errorType, errorCode: reason, errorStep: 'sendNowPlaying' }),
      );
    });

    test('a connection failure is an infrastructure error, not a dead token', async () => {
      setNowPlayingProvider(fakeProvider(new Error('ECONNRESET')));
      req = createMockRequest({ body: nowPlayingBody() });
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.send).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: 'ApnsUnavailable', errorStep: 'sendNowPlaying' }),
      );
    });
  });

  describe('rate limiting', () => {
    /// Metering is on the Companion FCM token, never the session token: that one belongs to a
    /// single Follow session and rotates, so a client could reset its quota by re-following.
    /// Two counters. The Companion one is the identity every other quota here uses; the
    /// destination one exists because this path only ever checks that token's shape, so a caller
    /// can make up a new one per request and would otherwise have unlimited access to one phone.
    test('charges both the registration and the destination counter', async () => {
      setNowPlayingProvider(fakeProvider());
      req = createMockRequest({ body: nowPlayingBody() });
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(docIds).toContain(NOW_PLAYING_DOC);
      expect(docIds).toContain(DESTINATION_DOC);
      // Keys are a digest, never the token they stand for.
      expect(docIds.join(' ')).not.toContain(TOKEN);
      expect(docRef.set).toHaveBeenCalledWith(expect.objectContaining({ attemptsCount: 1 }));
      expect(docRef.update).toHaveBeenCalledWith(expect.objectContaining({ deliveredCount: 1 }));
    });

    test('an invented Companion token shares the destination counter with a real one', async () => {
      setNowPlayingProvider(fakeProvider());
      req = createMockRequest({
        body: { ...nowPlayingBody(), push_token: 'invented:1' },
      });
      await handlers.handleRequest(req, res, legacy.createPayload);

      // Its own registration bucket, which is exactly why the destination bucket has to exist.
      expect(docIds).toContain(`${NOW_PLAYING_KEY_PREFIX}invented:1`);
      expect(docIds).toContain(DESTINATION_DOC);
    });

    /// The token is validated as case-insensitive hex, so the same device written two ways must
    /// not be handed two buckets.
    test('the destination counter does not care how the token is cased', async () => {
      setNowPlayingProvider(fakeProvider());
      req = createMockRequest({
        body: { ...nowPlayingBody(), now_playing_token: TOKEN.toUpperCase() },
      });
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(docIds).toContain(DESTINATION_DOC);
    });

    /// Either counter refuses on its own. The destination row uses an invented Companion token so
    /// only the destination counter is full, which is the case a registration-keyed quota alone
    /// would have let through.
    ///
    /// Nothing is charged either way. Charging one counter for a request the other refuses would
    /// leave an attempt that no success or error ever answers, and the visible
    /// "Notifications Rate Limited" push belongs to the notification quota, not to this one.
    test.each([
      ['the registration', () => withCounters(5001), FCM_TOKEN],
      ['the destination', () => limitedDocs.add(DESTINATION_DOC), 'invented:2'],
    ])(
      'a target over %s ceiling is refused, and charges nothing',
      async (_label, fill, pushToken) => {
        const provider = fakeProvider();
        setNowPlayingProvider(provider);
        fill();
        req = createMockRequest({ body: { ...nowPlayingBody(), push_token: pushToken } });
        await handlers.handleRequest(req, res, legacy.createPayload);

        expect(provider.sent).toHaveLength(0);
        expect(mockMessaging.send).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(429);
        const body = res.send.mock.calls[0][0];
        expect(body).toMatchObject({ errorType: 'RateLimited', target: pushToken });
        expect(JSON.stringify(body)).not.toContain(TOKEN);
        expect(docRef.set).not.toHaveBeenCalled();
        expect(docRef.update).not.toHaveBeenCalled();
      },
    );

    test('an ordinary notification still charges the notification counter', async () => {
      req = createMockRequest();
      await handlers.handleRequest(req, res, createMockPayloadHandler());

      expect(docIds).toContain(FCM_TOKEN);
      expect(docIds).not.toContain(NOW_PLAYING_DOC);
    });

    /// The whole point of the separate quota: a day of listening must not stop real
    /// notifications, and a target out of notification quota is not out of Now Playing quota.
    test('a target over the notification quota can still send Now Playing updates', async () => {
      const provider = fakeProvider();
      setNowPlayingProvider(provider);
      withCounters(900);
      req = createMockRequest({ body: nowPlayingBody() });
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(provider.sent).toHaveLength(1);
      expect(res.status).toHaveBeenCalledWith(201);
    });

    /// Over MAX_NOW_PLAYING_UPDATES_PER_DAY. The visible "Notifications Rate Limited" push
    /// belongs to the notification quota alone; this ceiling is a machine-readable refusal.
  });

  describe('accounting that fails after APNs has answered', () => {
    /// Apple's answer is the result of the request. Bookkeeping happens after it and must never
    /// replace it, because the answer that matters most is the one that retires a dead token.
    ///
    /// Lets the two pre-send charges through and fails everything after them, so these exercise
    /// the accounting that runs once APNs has already answered rather than failing earlier for
    /// the wrong reason.
    const breakAccountingAfterSend = () => {
      const working = mockFirestore.runTransaction.getMockImplementation();
      mockFirestore.runTransaction
        .mockImplementationOnce(working)
        .mockImplementationOnce(working)
        .mockRejectedValue(new Error('firestore is unavailable'));
    };

    test('a delivery is still reported when recordSuccess throws', async () => {
      setNowPlayingProvider(fakeProvider({ status: 200, apnsId: 'APNS-42', reason: null }));
      req = createMockRequest({ body: nowPlayingBody() });
      breakAccountingAfterSend();
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'APNS-42' }));
    });

    /// The first row is the one that matters most: a dead token is the only answer that retires a
    /// registration, and losing it behind a database exception means Home Assistant keeps pushing
    /// at a token that will never work again. The rest are here because every refusal has to keep
    /// its own classification, not just that one.
    test.each([
      [410, 'Unregistered', 410, 'InvalidToken'],
      [400, 'DeviceTokenNotForTopic', 400, 'TopicMismatch'],
      [403, 'InvalidProviderToken', 502, 'ProviderAuth'],
      [429, 'TooManyRequests', 429, 'ApnsRateLimited'],
      [503, 'ServiceUnavailable', 502, 'ApnsUnavailable'],
    ])(
      'APNs %i %s still answers HTTP %i %s when accounting throws',
      async (apnsStatus, reason, httpStatus, errorType) => {
        setNowPlayingProvider(fakeProvider({ status: apnsStatus, apnsId: 'APNS-1', reason }));
        req = createMockRequest({ body: nowPlayingBody() });
        breakAccountingAfterSend();
        await handlers.handleRequest(req, res, legacy.createPayload);

        expect(res.status).toHaveBeenCalledWith(httpStatus);
        expect(res.send).toHaveBeenCalledWith(
          expect.objectContaining({ errorType, errorCode: reason }),
        );
      },
    );

    /// Reaching APNs at all is what separates this from the pre-send case.
    test('a send that never reached Apple still reports that, not the accounting failure', async () => {
      setNowPlayingProvider(fakeProvider(new Error('ECONNRESET')));
      req = createMockRequest({ body: nowPlayingBody() });
      breakAccountingAfterSend();
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.send).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: 'ApnsUnavailable' }),
      );
    });

    /// The failure is not swallowed. It goes to its own error stream so it is not read as a
    /// delivery problem.
    test('the accounting failure is reported under its own step', async () => {
      setNowPlayingProvider(fakeProvider({ status: 200, apnsId: 'APNS-1', reason: null }));
      req = createMockRequest({ body: nowPlayingBody() });
      breakAccountingAfterSend();
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(mockLogging.log).toHaveBeenCalledWith('errors-recordNowPlayingRateLimit');
    });

    /// Before the send is a different matter: nothing has happened yet, so refusing is safe and
    /// charging nothing is the honest answer.
    test('an accounting failure before the send still fails the request', async () => {
      const provider = fakeProvider();
      setNowPlayingProvider(provider);
      req = createMockRequest({ body: nowPlayingBody() });
      mockFirestore.collection.mockImplementation(() => {
        throw new Error('firestore is unavailable');
      });
      await handlers.handleRequest(req, res, legacy.createPayload);

      expect(provider.sent).toHaveLength(0);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('logging', () => {
    test('the destination token is redacted from error reports', () => {
      const body = nowPlayingBody();
      const redacted = handlers.redactForLogging(body);
      expect(JSON.stringify(redacted)).not.toContain(TOKEN);
      expect(redacted.now_playing_token).toBe(`[redacted:${tokenFingerprint(TOKEN)}]`);
      // Everything else a maintainer needs is still there.
      expect(redacted.registration_info).toEqual(body.registration_info);
      expect(redacted.now_playing).toEqual(body.now_playing);
    });

    test('an ordinary request body is returned untouched', () => {
      const body = { push_token: FCM_TOKEN, message: 'hi' };
      expect(handlers.redactForLogging(body)).toBe(body);
      expect(handlers.redactForLogging(undefined)).toBeUndefined();
    });

    test('no log entry from a Now Playing send contains the token, a key or a bearer', async () => {
      process.env.DEBUG = 'true';
      jest.resetModules();
      const freshHandlers = require('../handlers.js');
      require('../now-playing').setNowPlayingProvider(fakeProvider());
      req = createMockRequest({ body: nowPlayingBody() });
      await freshHandlers.handleRequest(req, res, legacy.createPayload);
      delete process.env.DEBUG;

      const serialized = JSON.stringify(logWrites);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain('bearer ');
      expect(serialized).not.toContain('BEGIN PRIVATE KEY');
      // The fingerprint is what correlation uses instead.
      expect(serialized).toContain(tokenFingerprint(TOKEN));
    });
  });
});
