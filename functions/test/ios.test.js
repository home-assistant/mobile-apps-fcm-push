'use strict';

const ios = require('../ios.js');

describe('ios.js', () => {
  it('should create a silent show_camera command with entity_id', () => {
    const result = ios.createPayload({
      body: {
        message: 'show_camera',
        data: {
          entity_id: 'camera.front_door',
        },
        registration_info: {
          app_id: 'io.robbie.HomeAssistant.dev',
          os_version: '18.0',
          app_version: '2026.1',
        },
      },
    });

    expect(result).toEqual({
      updateRateLimits: false,
      payload: {
        notification: {},
        apns: {
          headers: {
            'apns-push-type': 'background',
          },
          payload: {
            aps: {
              contentAvailable: true,
            },
            homeassistant: {
              command: 'show_camera',
              entity_id: 'camera.front_door',
            },
          },
        },
        fcm_options: {
          analytics_label: 'iosV1Notification',
        },
      },
    });
  });

  it('should create a silent hide_camera command', () => {
    const result = ios.createPayload({
      body: {
        message: 'hide_camera',
        registration_info: {
          app_id: 'io.robbie.HomeAssistant.dev',
          os_version: '18.0',
          app_version: '2026.1',
        },
      },
    });

    expect(result).toEqual({
      updateRateLimits: false,
      payload: {
        notification: {},
        apns: {
          headers: {
            'apns-push-type': 'background',
          },
          payload: {
            aps: {
              contentAvailable: true,
            },
            homeassistant: {
              command: 'hide_camera',
            },
          },
        },
        fcm_options: {
          analytics_label: 'iosV1Notification',
        },
      },
    });
  });
});
