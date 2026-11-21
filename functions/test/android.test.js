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
});
