const android = require('../android');

const createRequest = (body) => ({
  body: {
    registration_info: {
      app_id: 'io.homeassistant.companion.android',
      app_version: '2026.9.0',
      os_version: '16',
      webhook_id: 'webhook',
    },
    ...body,
  },
});

describe('android.createPayload', () => {
  it('sends request_location_update as high priority', () => {
    const { payload } = android.createPayload(
      createRequest({ message: 'request_location_update' }),
    );

    expect(payload.android.priority).toBe('high');
    expect(payload.data.message).toBe('request_location_update');
  });

  it('keeps the priority requested for request_location_update', () => {
    const { payload } = android.createPayload(
      createRequest({ message: 'request_location_update', data: { priority: 'normal' } }),
    );

    expect(payload.android.priority).toBe('normal');
  });

  it('leaves the priority of other messages unset', () => {
    const { payload } = android.createPayload(createRequest({ message: 'Hello' }));

    expect(payload.android.priority).toBeUndefined();
  });
});
