'use strict';

const { getToday, NOW_PLAYING_KEY_PREFIX } = require('../../rate-limiter/util');

const mockFirestore = { collection: jest.fn(), runTransaction: jest.fn() };

jest.mock('firebase-admin/app', () => ({ initializeApp: jest.fn() }));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockFirestore),
  Timestamp: { fromDate: jest.fn(() => 'mock-timestamp') },
}));

const FirestoreRateLimiter = require('../../rate-limiter/firestore-rate-limiter');
const ValkeyRateLimiter = require('../../rate-limiter/valkey-rate-limiter');

const TOKEN = 'test:token123';

/** Records the collection path and document id a Firestore limiter addresses. */
const firestoreDoc = (limiter) => {
  const captured = {};
  const dayDoc = jest.fn((day) => {
    captured.day = day;
    return {
      collection: jest.fn(() => ({
        doc: jest.fn((id) => {
          captured.id = id;
          return {};
        }),
      })),
    };
  });
  mockFirestore.collection.mockReturnValue({ doc: dayDoc });
  limiter._getDocRef(TOKEN);
  captured.collection = mockFirestore.collection.mock.calls[0][0];
  return captured;
};

/// The Now Playing quota is a second counter for the same token, in the same backend and under
/// the same day partition. The notification bucket's storage layout must be exactly what it
/// always was, so an unprefixed limiter has to produce byte-identical keys.
describe('rate-limit key namespacing', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Firestore: the Now Playing bucket is a separate document, same day partition', () => {
    const notifications = firestoreDoc(new FirestoreRateLimiter(500, false));
    expect(notifications).toEqual({ collection: 'rateLimits', day: getToday(), id: TOKEN });

    const nowPlaying = firestoreDoc(new FirestoreRateLimiter(5000, false, NOW_PLAYING_KEY_PREFIX));
    expect(nowPlaying).toEqual({
      collection: 'rateLimits',
      day: getToday(),
      id: `${NOW_PLAYING_KEY_PREFIX}${TOKEN}`,
    });
  });

  test('Valkey: the Now Playing bucket is a separate key for the same token', () => {
    const notifications = new ValkeyRateLimiter(500, false, 'localhost', 6379);
    expect(notifications._getValkeyKey(TOKEN)).toBe(`rate_limit:${TOKEN}:${getToday()}`);

    const nowPlaying = new ValkeyRateLimiter(
      5000,
      false,
      'localhost',
      6379,
      NOW_PLAYING_KEY_PREFIX,
    );
    expect(nowPlaying._getValkeyKey(TOKEN)).toBe(
      `rate_limit:${NOW_PLAYING_KEY_PREFIX}${TOKEN}:${getToday()}`,
    );
  });
});
