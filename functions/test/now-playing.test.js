'use strict';

const {
  isNowPlayingRequest,
  prepareNowPlaying,
  classifyApnsResponse,
  destinationIdentity,
  tokenFingerprint,
  MAX_PAYLOAD_BYTES,
} = require('../now-playing');

const TOKEN = 'de1ec7ab1ede1ec7ab1ede1ec7ab1ede';
const OFFICIAL_APP_ID = 'io.robbie.HomeAssistant';
const ALLOWED_APP_IDS_VARIABLE = 'NOW_PLAYING_APNS_ALLOWED_APP_IDS';

const baseBody = (overrides = {}) => {
  const { now_playing: nowPlaying, ...rest } = overrides;
  return {
    push_token: 'test:token123',
    now_playing_token: TOKEN,
    registration_info: {
      app_id: OFFICIAL_APP_ID,
      app_version: '2026.9.1',
      webhook_id: 'webhook-1',
      os_version: '27.0',
    },
    ...rest,
    now_playing: {
      event: 'update',
      timestamp: 1788749001,
      attributes: { id: 'remote-media-123', schemaVersion: 1 },
      ...(nowPlaying || {}),
    },
  };
};

const payloadOf = (result) => JSON.parse(result.request.body.toString('utf8'));

const topicFor = (appId) => prepareNowPlaying(baseBody({ registration_info: { app_id: appId } }));

// Mirrors the module's syntax rule, so a test can show an identifier is well formed and still
// refused. If the two ever disagree these assertions fail loudly rather than silently pass.
const APP_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;

describe('request detection', () => {
  test('only a now_playing_token selects this path', () => {
    expect(isNowPlayingRequest({ now_playing_token: TOKEN })).toBe(true);
    expect(isNowPlayingRequest({ push_token: 'test:token123' })).toBe(false);
    expect(isNowPlayingRequest({ live_activity_token: 'abc' })).toBe(false);
    expect(isNowPlayingRequest({})).toBe(false);
    expect(isNowPlayingRequest(null)).toBe(false);
  });
});

describe('payload', () => {
  test('an update is exactly the aps envelope Apple documents, and nothing else', () => {
    const result = prepareNowPlaying(baseBody());
    expect(result.ok).toBe(true);
    expect(result.request.pushType).toBe('nowplaying');
    expect(payloadOf(result)).toEqual({
      aps: {
        event: 'update',
        timestamp: 1788749001,
        attributes: { id: 'remote-media-123', schemaVersion: 1 },
      },
    });
    // No alert, sound, badge or content-available: this is not a notification.
    expect(Object.keys(payloadOf(result))).toEqual(['aps']);
    expect(Object.keys(payloadOf(result).aps).sort()).toEqual(['attributes', 'event', 'timestamp']);
  });

  test('an end is the same envelope with the session identity', () => {
    const result = prepareNowPlaying(
      baseBody({
        now_playing: {
          event: 'end',
          timestamp: 1788749002,
          attributes: { id: 'remote-media-123' },
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.event).toBe('end');
    expect(payloadOf(result)).toEqual({
      aps: { event: 'end', timestamp: 1788749002, attributes: { id: 'remote-media-123' } },
    });
  });

  /// A versioned cross-repo protocol: an older relay must pass a newer schema through, and the
  /// ordering clock is the caller's, and APNs sequences a session's pushes by it.
  test('forwards unknown attributes and the caller timestamp untouched', () => {
    const attributes = {
      id: 'remote-media-123',
      schemaVersion: 7,
      somethingAddedLater: { nested: [1, 2, 3] },
      positionUpdatedAtUnix: 1788749875.123,
    };
    const payload = payloadOf(
      prepareNowPlaying(baseBody({ now_playing: { timestamp: 1500000000, attributes } })),
    );
    expect(payload.aps.attributes).toEqual(attributes);
    expect(payload.aps.timestamp).toBe(1500000000);
  });
});

describe('validation', () => {
  test.each([
    [
      'both specialised tokens is ambiguous',
      { live_activity_token: 'la-token' },
      400,
      'AmbiguousRequest',
    ],
    ['a token that is not hex', { now_playing_token: 'zzzz' }, 400, 'InvalidNowPlayingToken'],
    ['a token of odd length', { now_playing_token: 'abc' }, 400, 'InvalidNowPlayingToken'],
    ['an empty token', { now_playing_token: '' }, 400, 'InvalidNowPlayingToken'],
    ['a token of the wrong type', { now_playing_token: 1234 }, 400, 'InvalidNowPlayingToken'],
    [
      'a now_playing that is not an object',
      { now_playing: 'nope' },
      400,
      'InvalidNowPlayingRequest',
    ],
  ])('rejects %s', (_label, overrides, status, errorType) => {
    const result = prepareNowPlaying({ ...baseBody(), ...overrides });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(status);
    expect(result.error).toMatchObject({ errorType });
  });

  test('rejects a missing now_playing object', () => {
    const body = baseBody();
    delete body.now_playing;
    expect(prepareNowPlaying(body).error).toMatchObject({ errorType: 'InvalidNowPlayingRequest' });
  });

  /// `start` is push-to-start, which this product has no use for: a session exists because the
  /// user chose Follow.
  test.each([['start'], ['begin'], [''], [undefined]])('rejects the event %p', (event) => {
    expect(prepareNowPlaying(baseBody({ now_playing: { event } })).error).toMatchObject({
      errorType: 'UnsupportedNowPlayingEvent',
    });
  });

  test.each([
    ['a float', 1788749001.5],
    ['a string', '1788749001'],
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['missing', undefined],
  ])('rejects a timestamp that is %s', (_label, timestamp) => {
    expect(prepareNowPlaying(baseBody({ now_playing: { timestamp } })).error).toMatchObject({
      errorType: 'InvalidNowPlayingTimestamp',
    });
  });

  test.each([
    ['an array', []],
    ['a string', 'nope'],
    ['missing', undefined],
  ])('rejects attributes that are %s', (_label, attributes) => {
    expect(prepareNowPlaying(baseBody({ now_playing: { attributes } })).error).toMatchObject({
      errorType: 'InvalidNowPlayingAttributes',
    });
  });

  /// iOS routes the push by attributes.id. Without it APNs answers 200 and the device silently
  /// discards the push, so refusing here is the only way the caller learns anything.
  test.each([
    ['missing', {}],
    ['empty', { id: '' }],
    ['the wrong type', { id: 7 }],
  ])('rejects an attributes id that is %s', (_label, attributes) => {
    expect(prepareNowPlaying(baseBody({ now_playing: { attributes } })).error).toMatchObject({
      errorType: 'MissingNowPlayingSessionId',
    });
  });
});

describe('topic authorization', () => {
  const originalAllowed = process.env[ALLOWED_APP_IDS_VARIABLE];

  afterEach(() => {
    if (originalAllowed === undefined) delete process.env[ALLOWED_APP_IDS_VARIABLE];
    else process.env[ALLOWED_APP_IDS_VARIABLE] = originalAllowed;
  });

  /// The App Store identifier, which TestFlight builds and Mac Catalyst share.
  test('the official app is served out of the box', () => {
    delete process.env[ALLOWED_APP_IDS_VARIABLE];
    expect(topicFor(OFFICIAL_APP_ID).request.topic).toBe(
      'io.robbie.HomeAssistant.push-type.nowplaying',
    );
  });

  test('a deployment can name additional exact identifiers', () => {
    process.env[ALLOWED_APP_IDS_VARIABLE] = 'io.robbie.HomeAssistant.dev, com.example.fork';
    expect(topicFor('io.robbie.HomeAssistant.dev').request.topic).toBe(
      'io.robbie.HomeAssistant.dev.push-type.nowplaying',
    );
    expect(topicFor('com.example.fork').ok).toBe(true);
    // Configuring one does not imply anything near it.
    expect(topicFor('com.example.fork.evil').ok).toBe(false);
    expect(topicFor('com.example').ok).toBe(false);
  });

  /// A syntactically valid bundle identifier is not an authorized one: the topic is selected
  /// under a team-scoped signing key, so anything the team can sign would otherwise be reachable.
  test.each([
    ['a different vendor', 'evil.example.app'],
    ['a suffix of the official id', 'io.robbie.HomeAssistant.evil'],
    ['a prefix of the official id', 'io.robbie'],
    ['a lookalike', 'io.robbie.HomeAssistantt'],
    ['a case variant', 'io.robbie.homeassistant'],
    ['the debug id, which is not built in', 'io.robbie.HomeAssistant.dev'],
  ])('refuses %s even though it is well formed', (_label, appId) => {
    delete process.env[ALLOWED_APP_IDS_VARIABLE];
    expect(APP_ID_SHAPE.test(appId)).toBe(true);
    const result = topicFor(appId);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toMatchObject({ errorType: 'UnsupportedApp' });
    // The refusal does not disclose which apps are configured.
    expect(JSON.stringify(result.error)).not.toContain('io.robbie');
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['no dot', 'HomeAssistant'],
    ['a leading dot', '.io.robbie'],
    ['a trailing dot', 'io.robbie.'],
    ['a path', 'io.robbie/../other'],
    ['a space', 'io.robbie Home'],
    ['header injection', 'io.robbie\r\nx-evil: 1'],
    ['the wrong type', 42],
    ['too long', `io.robbie.${'a'.repeat(200)}`],
  ])('refuses an app id that is %s', (_label, appId) => {
    expect(topicFor(appId).error).toMatchObject({ errorType: 'UnsupportedApp' });
  });

  test('refuses a missing or non-object registration_info', () => {
    const body = baseBody();
    delete body.registration_info;
    expect(prepareNowPlaying(body).error).toMatchObject({ errorType: 'UnsupportedApp' });
    expect(prepareNowPlaying(baseBody({ registration_info: OFFICIAL_APP_ID })).ok).toBe(false);
  });

  /// The configuration mistake that would matter most: a wildcard must never widen anything. It
  /// authorizes an app literally called `*`, which is not a bundle identifier and cannot exist.
  test.each([['*'], ['**'], ['io.robbie.*'], ['io.robbie.HomeAssistant*'], ['.*']])(
    'a configured %p is literal and authorizes nothing real',
    (pattern) => {
      process.env[ALLOWED_APP_IDS_VARIABLE] = pattern;
      expect(topicFor('evil.example.app').ok).toBe(false);
      expect(topicFor('io.robbie.HomeAssistant.dev').ok).toBe(false);
      expect(topicFor(pattern).ok).toBe(false);
      // And the app that was already served is unaffected.
      expect(topicFor(OFFICIAL_APP_ID).ok).toBe(true);
    },
  );

  /// The caller must never be able to choose where a push goes.
  test('a caller-supplied topic cannot override the derived one', () => {
    const result = prepareNowPlaying(
      baseBody({
        apns_topic: 'com.attacker.app.push-type.nowplaying',
        topic: 'com.attacker.app',
        now_playing_topic: 'com.attacker.app',
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.request.topic).toBe('io.robbie.HomeAssistant.push-type.nowplaying');
  });
});

describe('payload size', () => {
  const withPadding = (bytes) =>
    baseBody({
      now_playing: { attributes: { id: 'remote-media-123', pad: 'x'.repeat(bytes) } },
    });

  /// Apple's documented 4 KB maximum, checked before a connection is opened.
  test('the boundary is exactly Apple maximum', () => {
    // The envelope is fixed and the padding is one JSON byte per character, so this is exact.
    const envelopeBytes = prepareNowPlaying(withPadding(0)).request.body.length;
    const fits = prepareNowPlaying(withPadding(MAX_PAYLOAD_BYTES - envelopeBytes));
    expect(fits.ok).toBe(true);
    expect(fits.request.body.length).toBe(MAX_PAYLOAD_BYTES);

    const tooBig = prepareNowPlaying(withPadding(MAX_PAYLOAD_BYTES - envelopeBytes + 1));
    expect(tooBig.ok).toBe(false);
    expect(tooBig.status).toBe(413);
    expect(tooBig.error).toMatchObject({ errorType: 'PayloadTooLarge' });
  });

  test('the refusal does not quote the oversized payload', () => {
    const secret = 'do-not-log-me-'.repeat(400);
    const result = prepareNowPlaying(
      baseBody({ now_playing: { attributes: { id: 'remote-media-123', pad: secret } } }),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.error)).not.toContain('do-not-log-me');
  });
});

describe('APNs response classification', () => {
  test('200 is success', () => {
    expect(classifyApnsResponse({ status: 200, reason: null })).toEqual({
      ok: true,
      httpStatus: 201,
    });
  });

  /// Apple's answer to the outcome Home Assistant acts on. `InvalidToken` is the only one that
  /// unregisters a user's session, so nothing but a genuinely dead token may map to it,
  /// including a refusal we do not recognise.
  test.each([
    [410, 'Unregistered', 'InvalidToken', 410],
    [400, 'BadDeviceToken', 'InvalidToken', 410],
    [410, null, 'InvalidToken', 410],
    [400, 'DeviceTokenNotForTopic', 'TopicMismatch', 400],
    [400, 'TopicDisallowed', 'TopicMismatch', 400],
    [400, 'BadTopic', 'TopicMismatch', 400],
    [403, 'InvalidProviderToken', 'ProviderAuth', 502],
    [403, 'ExpiredProviderToken', 'ProviderAuth', 502],
    [403, null, 'ProviderAuth', 502],
    [413, 'PayloadTooLarge', 'PayloadTooLarge', 413],
    [429, 'TooManyRequests', 'ApnsRateLimited', 429],
    [500, 'InternalServerError', 'ApnsUnavailable', 502],
    [503, 'ServiceUnavailable', 'ApnsUnavailable', 502],
    [503, null, 'ApnsUnavailable', 502],
    [400, 'SomethingNewFromApple', 'ApnsError', 502],
    [418, null, 'ApnsError', 502],
  ])('APNs %i %s is %s, answered as HTTP %i', (status, reason, errorType, httpStatus) => {
    expect(classifyApnsResponse({ status, reason })).toEqual({ ok: false, errorType, httpStatus });
  });
});

describe('destination identity', () => {
  /// The Companion token is only checked for shape before this path is taken, so it cannot be the
  /// only thing a quota is keyed on. This names the device the push actually reaches.
  test('is a full digest, so two devices cannot share a bucket by chance', () => {
    const identity = destinationIdentity(TOKEN);
    expect(identity).toHaveLength(64);
    expect(identity).toMatch(/^[0-9a-f]+$/);
    expect(identity).not.toContain(TOKEN);
    expect(destinationIdentity(`${TOKEN}ff`)).not.toBe(identity);
  });

  /// The token is validated as case-insensitive hex, so the same device written two ways is one
  /// device and must not be handed two quotas.
  test('does not care how the token is cased', () => {
    expect(destinationIdentity(TOKEN.toUpperCase())).toBe(destinationIdentity(TOKEN.toLowerCase()));
  });

  /// Long enough that a collision is not a way to spend someone else's quota, where the truncated
  /// logging fingerprint would not be.
  test('is longer than the label used for logs', () => {
    expect(destinationIdentity(TOKEN).length).toBeGreaterThan(tokenFingerprint(TOKEN).length);
  });
});

describe('token fingerprint', () => {
  test('is stable, short, distinguishing and not the token', () => {
    expect(tokenFingerprint(TOKEN)).toBe(tokenFingerprint(TOKEN));
    expect(tokenFingerprint(TOKEN)).toHaveLength(16);
    expect(TOKEN).not.toContain(tokenFingerprint(TOKEN));
    expect(tokenFingerprint(TOKEN)).not.toBe(tokenFingerprint(`${TOKEN}ff`));
  });
});
