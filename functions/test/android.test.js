'use strict';

const android = require('../android');

describe('android createPayload', () => {
  test('converts boolean authenticationRequired to a string', () => {
    const { payload } = android.createPayload({
      body: {
        message: 'test',
        data: { actions: [{ action: 'test', title: 'Test', authenticationRequired: true }] },
        registration_info: {},
      },
    });

    expect(payload.data.action_1_authenticationRequired).toBe('true');
  });

  test('throws a clear error when android data field cannot be serialized', () => {
    const circular = {};
    circular.self = circular;

    expect(() =>
      android.createPayload({
        body: {
          message: 'test',
          data: { progress_segments: circular },
          registration_info: {},
        },
      }),
    ).toThrow('Unable to serialize req.body.data.progress_segments for Android payload');

    try {
      android.createPayload({
        body: {
          message: 'test',
          data: { progress_segments: circular },
          registration_info: {},
        },
      });
    } catch (err) {
      expect(err.message).toContain('req.body.data.progress_segments');
    }
  });
});
