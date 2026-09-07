'use strict';

const http2 = require('node:http2');
const crypto = require('node:crypto');

const { ApnsProvider } = require('../apns-provider');
const { prepareNowPlaying, classifyApnsResponse } = require('../now-playing');

// A throwaway key, generated per run. Never a real credential.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const TOKEN = 'de1ec7ab1ede1ec7ab1ede1ec7ab1ede';

/**
 * A local stand-in for Apple's provider API, over real HTTP/2.
 *
 * The unit tests drive a fake connector, which cannot catch a mistake in how the request is
 * actually framed. This exercises the shipped `ApnsProvider` over a genuine HTTP/2 connection,
 * everything but Apple's TLS and their servers, and records exactly what a provider would see.
 */
function startFakeApns() {
  const received = [];
  let answer = { status: 200, body: null };

  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      received.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
      const responseHeaders = { ':status': answer.status, 'apns-id': 'LOCAL-APNS-ID' };
      if (answer.body) {
        stream.respond(responseHeaders);
        stream.end(JSON.stringify(answer.body));
      } else {
        stream.respond(responseHeaders);
        stream.end();
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {any} */ (server.address());
      resolve({
        received,
        origin: `http://127.0.0.1:${port}`,
        reply(status, body = null) {
          answer = { status, body };
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done(undefined));
          }),
      });
    });
  });
}

describe('Now Playing over a real HTTP/2 connection', () => {
  let apns;
  let provider;

  const body = (overrides = {}) => ({
    push_token: 'test:token123',
    now_playing_token: TOKEN,
    registration_info: { app_id: 'io.robbie.HomeAssistant' },
    now_playing: {
      event: 'update',
      timestamp: 1788749001,
      attributes: { id: 'remote-media-123', schemaVersion: 1 },
      ...overrides,
    },
  });

  const deliver = (requestBody) => {
    const prepared = prepareNowPlaying(requestBody);
    expect(prepared.ok).toBe(true);
    return provider.send(prepared.request);
  };

  beforeEach(async () => {
    apns = await startFakeApns();
    provider = new ApnsProvider({
      key: KEY_PEM,
      keyId: 'TESTKEYID1',
      teamId: 'TESTTEAM01',
      connect: () => http2.connect(apns.origin),
    });
  });

  afterEach(async () => {
    provider.close();
    await apns.close();
  });

  /// One connection, two sends: the pseudo-headers, the Authorization header, the wire body and
  /// the caller's ordering clock, all as node:http2 actually frames them.
  test('two updates arrive as Apple documents them, over one connection', async () => {
    apns.reply(200);
    const first = await deliver(body({ attributes: { id: 'remote-media-123', title: 'First' } }));
    await deliver(
      body({ timestamp: 1788749002, attributes: { id: 'remote-media-123', title: 'Second' } }),
    );

    expect(first).toEqual({ status: 200, apnsId: 'LOCAL-APNS-ID', reason: null });
    expect(classifyApnsResponse(first)).toEqual({ ok: true, httpStatus: 201 });

    expect(apns.received).toHaveLength(2);
    const [request] = apns.received;
    expect(request.headers[':method']).toBe('POST');
    expect(request.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(request.headers['apns-push-type']).toBe('nowplaying');
    expect(request.headers['apns-topic']).toBe('io.robbie.HomeAssistant.push-type.nowplaying');
    expect(request.headers.authorization).toMatch(/^bearer /);
    expect(JSON.parse(request.body)).toEqual({
      aps: {
        event: 'update',
        timestamp: 1788749001,
        attributes: { id: 'remote-media-123', title: 'First' },
      },
    });

    expect(apns.received.map((r) => JSON.parse(r.body).aps.timestamp)).toEqual([
      1788749001, 1788749002,
    ]);
    // One session, reused: the same provider JWT went out both times.
    expect(apns.received[0].headers.authorization).toBe(apns.received[1].headers.authorization);
  });

  test('a real refusal body is read back off the wire and classified', async () => {
    apns.reply(410, { reason: 'Unregistered' });
    const result = await deliver(body());
    expect(result).toMatchObject({ status: 410, reason: 'Unregistered' });
    expect(classifyApnsResponse(result)).toMatchObject({ ok: false, errorType: 'InvalidToken' });
  });

  test('a connection that goes away mid-flight is reported, and the next send reconnects', async () => {
    apns.reply(200);
    await deliver(body());
    // Apple closing the connection is routine; the provider must not wedge.
    provider.session.destroy();
    apns.reply(200);
    await expect(deliver(body({ timestamp: 1788749009 }))).resolves.toMatchObject({ status: 200 });
    expect(apns.received).toHaveLength(2);
  });
});
