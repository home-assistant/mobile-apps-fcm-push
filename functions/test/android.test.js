'use strict';

const android = require('../android.js');
const { createMockRequest } = require('./utils/mock-factories');

const createAndroidRequest = (data) => createMockRequest({ body: { data, registration_info: {} } });

describe('android.createPayload', () => {
  test('omits ttl when it is not supplied', () => {
    const { payload } = android.createPayload(createAndroidRequest({}));

    expect(payload.android).not.toHaveProperty('ttl');
  });

  test('forwards a zero ttl', () => {
    const { payload } = android.createPayload(createAndroidRequest({ ttl: 0 }));

    expect(payload.android.ttl).toBe(0);
  });

  test('forwards a positive ttl in milliseconds', () => {
    const { payload } = android.createPayload(createAndroidRequest({ ttl: 3600000 }));

    expect(payload.android.ttl).toBe(3600000);
  });
});
