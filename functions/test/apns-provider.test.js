'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { ApnsProvider } = require('../apns-provider');

// A throwaway P-256 key, generated per run. Never a real credential, and never asserted on.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const KEY_ID = 'TESTKEYID1';
const TEAM_ID = 'TESTTEAM01';
const TOKEN = 'de1ec7ab1ede1ec7ab1ede1ec7ab1ede';
const TOPIC = 'io.robbie.HomeAssistant.push-type.nowplaying';

/** A stand-in for one HTTP/2 stream, driven by the test. */
class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.headers = null;
    this.written = null;
    this.closedWith = null;
    this.timeoutHandler = null;
  }

  setTimeout(ms, handler) {
    this.timeoutMs = ms;
    this.timeoutHandler = handler;
  }

  end(body) {
    this.written = body;
    this.emit('written');
  }

  close(code) {
    this.closedWith = code;
  }

  /** Plays back an APNs answer. */
  respond(status, { apnsId = 'APNS-ID-1', body = null } = {}) {
    this.emit('response', { ':status': status, 'apns-id': apnsId });
    if (body !== null) {
      this.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    }
    this.emit('end');
  }
}

/** A stand-in for an HTTP/2 session. */
class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.destroyed = false;
    this.requests = [];
    this.throwOnRequest = null;
  }

  request(headers) {
    if (this.throwOnRequest) {
      const err = this.throwOnRequest;
      this.throwOnRequest = null;
      throw err;
    }
    const stream = new FakeStream();
    stream.headers = headers;
    this.requests.push(stream);
    return stream;
  }

  close() {
    this.closed = true;
    this.emit('close');
  }
}

const makeProvider = (overrides = {}) => {
  const sessions = [];
  const hosts = [];
  const provider = new ApnsProvider({
    key: KEY_PEM,
    keyId: KEY_ID,
    teamId: TEAM_ID,
    connect: (host) => {
      hosts.push(host);
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    ...overrides,
  });
  return { provider, sessions, hosts };
};

const startSend = (provider) =>
  provider.send({ token: TOKEN, topic: TOPIC, pushType: 'nowplaying', body: Buffer.from('{}') });

/** Drives one send to completion against the fake transport. */
const sendAndRespond = async (provider, sessions, status, options) => {
  const pending = startSend(provider);
  const session = sessions[sessions.length - 1];
  const stream = session.requests[session.requests.length - 1];
  await new Promise((resolve) => (stream.written ? resolve() : stream.once('written', resolve)));
  stream.respond(status, options);
  return { result: await pending, stream };
};

const decodeJwt = (bearer) => {
  const [header, claims, signature] = bearer.replace(/^bearer /, '').split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')),
    signature: Buffer.from(signature, 'base64url'),
    signingInput: `${header}.${claims}`,
  };
};

describe('construction', () => {
  test.each([['key'], ['keyId'], ['teamId']])('refuses to build without %s', (field) => {
    expect(() => makeProvider({ [field]: '' })).toThrow(/requires key, keyId and teamId/);
  });

  /// iOS 27 issues Now Playing tokens against production even for a development-signed build,
  /// but that is Apple's behaviour and not a rule to hardcode.
  test('defaults to production and can be pointed at sandbox', () => {
    expect(makeProvider().provider.host).toBe('https://api.push.apple.com');
    expect(makeProvider({ production: false }).provider.host).toBe(
      'https://api.sandbox.push.apple.com',
    );
  });
});

describe('the provider JWT', () => {
  test('is a verifiable ES256 JWS with the configured key id and team', () => {
    const { provider } = makeProvider({ now: () => 1788749001000 });
    const { header, claims, signature, signingInput } = decodeJwt(provider.authorizationToken());

    expect(header).toEqual({ alg: 'ES256', kid: KEY_ID });
    expect(claims).toEqual({ iss: TEAM_ID, iat: 1788749001 });
    // Raw R||S, as JWS requires, rather than the DER encoding Node signs with by default.
    expect(signature).toHaveLength(64);
    expect(
      crypto.verify(
        'sha256',
        Buffer.from(signingInput),
        { key: privateKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true);
  });

  /// Apple rejects a provider token older than an hour, so the refresh has to land inside that
  /// while still not re-signing per push.
  test('is cached, then re-signed before Apple one-hour maximum', () => {
    let now = 1788749001000;
    const { provider } = makeProvider({ now: () => now });
    const first = provider.authorizationToken();

    now += 40 * 60 * 1000;
    expect(provider.authorizationToken()).toBe(first);

    now += 20 * 60 * 1000;
    const second = provider.authorizationToken();
    expect(second).not.toBe(first);
    expect(decodeJwt(second).claims.iat).toBeGreaterThan(decodeJwt(first).claims.iat);
  });
});

describe('the APNs request', () => {
  test('is a POST to the device path with the Now Playing headers', async () => {
    const { provider, sessions, hosts } = makeProvider();
    const { stream } = await sendAndRespond(provider, sessions, 200);

    expect(hosts).toEqual(['https://api.push.apple.com']);
    expect(stream.headers[':method']).toBe('POST');
    expect(stream.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(stream.headers['apns-push-type']).toBe('nowplaying');
    expect(stream.headers['apns-topic']).toBe(TOPIC);
    expect(stream.headers['content-type']).toBe('application/json');
    expect(stream.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test('reuses one connection across sends', async () => {
    const { provider, sessions } = makeProvider();
    await sendAndRespond(provider, sessions, 200);
    await sendAndRespond(provider, sessions, 200);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].requests).toHaveLength(2);
  });
});

describe('the APNs response', () => {
  test('a 200 resolves with the apns-id', async () => {
    const { provider, sessions } = makeProvider();
    const { result } = await sendAndRespond(provider, sessions, 200, { apnsId: 'ABC-123' });
    expect(result).toEqual({ status: 200, apnsId: 'ABC-123', reason: null });
  });

  /// A refusal is an answer, not a failure: it resolves so the caller can classify it.
  test('a refusal resolves with the status and Apple reason', async () => {
    const { provider, sessions } = makeProvider();
    const { result } = await sendAndRespond(provider, sessions, 410, {
      body: { reason: 'Unregistered' },
    });
    expect(result).toEqual({ status: 410, apnsId: 'APNS-ID-1', reason: 'Unregistered' });
  });

  test('a body that is not the documented JSON does not throw', async () => {
    const { provider, sessions } = makeProvider();
    const { result } = await sendAndRespond(provider, sessions, 503, { body: '<html>oops</html>' });
    expect(result).toEqual({ status: 503, apnsId: 'APNS-ID-1', reason: null });
  });
});

describe('transport failures', () => {
  test('a stream error rejects', async () => {
    const { provider, sessions } = makeProvider();
    const pending = startSend(provider);
    sessions[0].requests[0].emit('error', new Error('ECONNRESET'));
    await expect(pending).rejects.toThrow('ECONNRESET');
  });

  test('a timeout cancels the stream and rejects', async () => {
    const { provider, sessions } = makeProvider();
    const pending = startSend(provider);
    const stream = sessions[0].requests[0];
    expect(stream.timeoutMs).toBeGreaterThan(0);
    stream.timeoutHandler();
    await expect(pending).rejects.toThrow('timed out');
    expect(stream.closedWith).toBeDefined();
  });

  test('a request that cannot even be opened rejects and drops the connection', async () => {
    const { provider, sessions } = makeProvider();
    provider.connection().throwOnRequest = new Error('session destroyed');
    await expect(startSend(provider)).rejects.toThrow('session destroyed');
    expect(provider.session).toBeNull();
    // The next send opens a fresh one rather than reusing the broken session.
    await sendAndRespond(provider, sessions, 200);
    expect(sessions).toHaveLength(2);
  });

  /// Apple sends GOAWAY routinely; it is a reconnect, not a failure. A session error must also
  /// never surface as an unhandled exception, which would take the process down.
  test.each([['goaway'], ['close'], ['error']])(
    'a session %s event forces a reconnect without throwing',
    async (event) => {
      const { provider, sessions } = makeProvider();
      await sendAndRespond(provider, sessions, 200);
      expect(() => sessions[0].emit(event, new Error('bye'))).not.toThrow();
      expect(provider.session).toBeNull();
      await sendAndRespond(provider, sessions, 200);
      expect(sessions).toHaveLength(2);
    },
  );
});

describe('secrecy', () => {
  test('the provider does not stringify its credentials', async () => {
    const { provider, sessions } = makeProvider();
    await sendAndRespond(provider, sessions, 200);
    const serialized = JSON.stringify(provider, (key, value) =>
      typeof value === 'object' && value !== null && value.constructor === Object
        ? value
        : String(value),
    );
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect(serialized).not.toContain(KEY_PEM.split('\n')[1]);
  });
});
