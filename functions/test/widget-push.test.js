'use strict';

const crypto = require('crypto');
const { createMockRequest, createMockResponse } = require('./utils/mock-factories');

jest.mock('node:http2', () => ({ connect: jest.fn() }));
const http2 = require('node:http2');

const mockRateLimiter = {
  recordAttempt: jest.fn(),
  recordSuccess: jest.fn(),
  recordError: jest.fn(),
};
jest.mock('../handlers', () => ({ widgetRateLimiter: mockRateLimiter }));

const widgetPush = require('../widget-push');

const WIDGET_TOKEN = '80f7d67347204c7dda85d331a95ec31c1e3c62b9173836ada8ed9abf';

// A real P-256 key so ES256 signing succeeds; its value is irrelevant to the mock.
const TEST_P8 = crypto
  .generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });

// Makes http2.connect return a client whose request replays the given APNs
// responses in order (one per connect call, so we can exercise the fallback).
function mockApns(responses, onRequest) {
  let index = 0;
  http2.connect.mockImplementation(() => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const handlers = {};
    const request = {
      on: jest.fn((event, cb) => {
        handlers[event] = cb;
        return request;
      }),
      setEncoding: jest.fn(),
      end: jest.fn(() => {
        process.nextTick(() => {
          handlers.response?.({ ':status': response.status, 'apns-id': response.apnsId });
          if (response.body) handlers.data?.(response.body);
          handlers.end?.();
        });
      }),
    };
    return {
      on: jest.fn(),
      request: jest.fn((headers) => {
        onRequest?.(headers);
        return request;
      }),
      close: jest.fn(),
    };
  });
}

function widgetRequest(overrides = {}) {
  return createMockRequest({
    body: {
      push_subscription: { subscription_id: 'ios-widget-sensors', target: 'sensors' },
      push_token: WIDGET_TOKEN,
      registration_info: { app_id: 'io.test.HomeAssistant' },
      ...overrides,
    },
  });
}

describe('widget-push', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APNS_KEY_P8 = TEST_P8;
    process.env.APNS_KEY_ID = 'KEY1234567';
    process.env.APNS_TEAM_ID = 'TEAM123456';
    mockRateLimiter.recordAttempt.mockResolvedValue({ isRateLimited: false, rateLimits: {} });
    mockRateLimiter.recordSuccess.mockResolvedValue({});
    mockRateLimiter.recordError.mockResolvedValue({});
  });

  it('returns 201 and echoes the apns-id on a successful send', async () => {
    mockApns([{ status: 200, apnsId: 'apns-success' }]);
    const res = createMockResponse();

    await widgetPush.sendWidgetPush(widgetRequest(), res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        target: WIDGET_TOKEN,
        messageId: 'apns-success',
        pushType: 'widgets',
      }),
    );
  });

  it('rate-limits per token and returns 429 without reaching APNs', async () => {
    mockRateLimiter.recordAttempt.mockResolvedValueOnce({
      isRateLimited: true,
      rateLimits: { successful: 500 },
    });
    const res = createMockResponse();

    await widgetPush.sendWidgetPush(widgetRequest(), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(http2.connect).not.toHaveBeenCalled();
  });

  it('records the attempt outcome with the rate limiter on success', async () => {
    mockApns([{ status: 200, apnsId: 'x' }]);

    await widgetPush.sendWidgetPush(widgetRequest(), createMockResponse());

    expect(mockRateLimiter.recordAttempt).toHaveBeenCalledWith(WIDGET_TOKEN);
    expect(mockRateLimiter.recordSuccess).toHaveBeenCalledWith(WIDGET_TOKEN);
  });

  it('sends the widgets push type, widget topic and device path', async () => {
    let headers;
    mockApns([{ status: 200, apnsId: 'x' }], (h) => {
      headers = h;
    });

    await widgetPush.sendWidgetPush(widgetRequest(), createMockResponse());

    expect(headers['apns-push-type']).toBe('widgets');
    expect(headers['apns-topic']).toBe('io.test.HomeAssistant.push-type.widgets');
    expect(headers[':path']).toBe(`/3/device/${WIDGET_TOKEN}`);
    expect(headers.authorization).toMatch(/^bearer /);
  });

  it('falls back to the sandbox host on BadDeviceToken', async () => {
    mockApns([
      { status: 400, body: '{"reason":"BadDeviceToken"}' },
      { status: 200, apnsId: 'sandbox-ok' },
    ]);
    const res = createMockResponse();

    await widgetPush.sendWidgetPush(widgetRequest(), res);

    expect(http2.connect).toHaveBeenCalledTimes(2);
    expect(http2.connect).toHaveBeenNthCalledWith(1, 'https://api.push.apple.com');
    expect(http2.connect).toHaveBeenNthCalledWith(2, 'https://api.sandbox.push.apple.com');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 403 when no token is sent', async () => {
    const res = createMockResponse();
    await widgetPush.sendWidgetPush(widgetRequest({ push_token: null }), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 400 when registration_info.app_id is missing', async () => {
    const res = createMockResponse();
    await widgetPush.sendWidgetPush(widgetRequest({ registration_info: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 500 when APNs credentials are not configured', async () => {
    delete process.env.APNS_KEY_P8;
    const res = createMockResponse();
    await widgetPush.sendWidgetPush(widgetRequest(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('propagates a non-fallback APNs rejection status', async () => {
    mockApns([{ status: 410, body: '{"reason":"Unregistered"}' }]);
    const res = createMockResponse();
    await widgetPush.sendWidgetPush(widgetRequest(), res);
    expect(res.status).toHaveBeenCalledWith(410);
  });
});
