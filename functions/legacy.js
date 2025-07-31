const path = require('path');

module.exports = {
  createPayload: (req) => {
    const payload = {
      notification: {
        body: req.body.message,
      },
      android: {
        ttl: 0,
        priority: 'HIGH',
      },
      apns: {
        headers: {},
        payload: {
          aps: {
            alert: {
              body: req.body.message,
            },
            sound: 'default',
          },
        },
      },
      fcm_options: {
        analytics_label: 'legacyNotification',
      },
    };

    if (req.body.title) {
      payload.notification.title = req.body.title;
      payload.apns.payload.aps.alert.title = req.body.title;
    }

    if (req.body.data) {
      for (const key of ['android', 'apns', 'data', 'webpush']) {
        if (req.body.data[key]) {
          payload[key] = req.body.data[key];
        }
      }

      // Special handling because mapping apns_headers -> apns.headers
      if (req.body.data.apns_headers) {
        payload.apns.headers = req.body.data.apns_headers;
      }
    }

    let updateRateLimits = true;

    if (req.body.registration_info.webhook_id) {
      if (!payload.apns.payload) {
        payload.apns.payload = {};
      }
      payload.apns.payload.webhook_id = req.body.registration_info.webhook_id;
    }

    if (req.body.registration_info.app_id.indexOf('io.robbie.HomeAssistant') > -1) {
      const addCommand = (command) => {
        payload.notification = {};
        payload.apns.payload.aps = {};
        payload.apns.payload.aps.contentAvailable = true;
        payload.apns.payload.homeassistant = { command: command };
        if (req.body.data && req.body.data.push && req.body.data.push.badge) {
          payload.apns.payload.aps.badge = req.body.data.push.badge;
        }
        updateRateLimits = false;
      };

      // Enable old SNS iOS specific push setup.
      if (
        req.body.message === 'request_location_update' ||
        req.body.message === 'request_location_updates'
      ) {
        addCommand('request_location_update');
      } else if (req.body.message === 'clear_badge') {
        payload.notification = {};
        payload.apns.payload.aps = {};
        payload.apns.payload.aps.badge = 0;
        updateRateLimits = false;
      } else if (req.body.message === 'clear_notification') {
        addCommand('clear_notification');

        if (req.body.data && req.body.data.tag) {
          payload.apns.payload.homeassistant.tag = req.body.data.tag;
        }

        if (payload.apns.headers['apns-collapse-id']) {
          payload.apns.payload.homeassistant.collapseId = payload.apns.headers['apns-collapse-id'];
        }

        delete payload.apns.headers['apns-collapse-id'];

        updateRateLimits = false;
      } else if (req.body.message === 'update_complications') {
        addCommand('update_complications');
        updateRateLimits = false;
      } else if (req.body.message === 'update_widgets') {
        addCommand('update_widgets');
        updateRateLimits = false;
      } else {
        let needsCategory = false;
        let needsMutableContent = false;

        if (req.body.data) {
          if (req.body.data.subtitle) {
            payload.apns.payload.aps.alert.subtitle = req.body.data.subtitle;
          }

          if (req.body.data.push) {
            Object.assign(payload.apns.payload.aps, req.body.data.push);
          }

          if (req.body.data.actions) {
            payload.apns.payload.actions = req.body.data.actions;
            needsCategory = true;
          }

          if (req.body.data.sound) {
            payload.apns.payload.aps.sound = req.body.data.sound;
          } else if (req.body.data.push && req.body.data.push.sound) {
            payload.apns.payload.aps.sound = req.body.data.push.sound;
          }

          if (
            typeof req.body.registration_info.os_version === 'string' &&
            req.body.registration_info.os_version.startsWith('10.15')
          ) {
            const soundType = typeof payload.apns.payload.aps.sound;
            if (soundType === 'string') {
              payload.apns.payload.aps.sound = path.parse(payload.apns.payload.aps.sound).name;
            } else if (
              soundType === 'object' &&
              typeof payload.apns.payload.aps.sound.name === 'string'
            ) {
              payload.apns.payload.aps.sound.name = path.parse(
                payload.apns.payload.aps.sound.name,
              ).name;
            }
          }

          if (req.body.data.entity_id) {
            payload.apns.payload.entity_id = req.body.data.entity_id;
            needsCategory = true;
            needsMutableContent = true;
          }

          if (req.body.data.action_data) {
            payload.apns.payload.homeassistant = req.body.data.action_data;
            needsCategory = true;
          }

          if (req.body.data.attachment) {
            payload.apns.payload.attachment = req.body.data.attachment;
            needsCategory = true;
            needsMutableContent = true;
          }

          const addAttachment = (url, contentType) => {
            if (!url) {
              return;
            }

            if (!payload.apns.payload.attachment) {
              payload.apns.payload.attachment = {};
            }

            if (!payload.apns.payload.attachment['content-type']) {
              payload.apns.payload.attachment['content-type'] = contentType;
            }

            if (!payload.apns.payload.attachment.url) {
              payload.apns.payload.attachment.url = url;
            }

            needsCategory = true;
            needsMutableContent = true;
          };

          addAttachment(req.body.data.video, 'mpeg4');
          addAttachment(req.body.data.image, 'jpeg');
          addAttachment(req.body.data.audio, 'waveformaudio');

          if (req.body.data.url) {
            payload.apns.payload.url = req.body.data.url;
          }

          if (req.body.data.shortcut) {
            payload.apns.payload.shortcut = req.body.data.shortcut;
          }

          if (req.body.data.presentation_options) {
            payload.apns.payload.presentation_options = req.body.data.presentation_options;
          }

          if (typeof req.body.data.tag === 'string') {
            payload.apns.headers['apns-collapse-id'] = req.body.data.tag;
          }

          if (typeof req.body.data.group === 'string') {
            payload.apns.payload.aps['thread-id'] = req.body.data.group;
          }
        }

        if (!payload.apns.payload.aps) {
          payload.apns.payload.aps = {};
        }

        if (needsCategory && !payload.apns.payload.aps.category) {
          payload.apns.payload.aps.category = 'DYNAMIC';
        } else if (payload.apns.payload.aps.category) {
          payload.apns.payload.aps.category = payload.apns.payload.aps.category.toUpperCase();
        }

        if (needsMutableContent) {
          payload.apns.payload.aps.mutableContent = true;
        }

        if (req.body.message === 'delete_alert') {
          updateRateLimits = false;
          delete payload.notification.body;
          delete payload.apns.payload.aps.alert.title;
          delete payload.apns.payload.aps.alert.subtitle;
          delete payload.apns.payload.aps.alert.body;
          delete payload.apns.payload.aps.sound;
        }

        if (req.body.message === 'test_push_source') {
          payload.apns.payload.aps.alert.title = req.body.message;
          payload.apns.payload.aps.alert.body = 'apns-fcm';
        }
      }
    }

    if (payload.apns.payload.aps.sound) {
      const { sound } = payload.apns.payload.aps;
      if (typeof sound === 'string' && sound.toLowerCase() === 'none') {
        delete payload.apns.payload.aps.sound;
      } else if (typeof sound === 'object') {
        if (sound.volume) {
          payload.apns.payload.aps.sound.volume = parseFloat(sound.volume);
        }
        if (sound.critical) {
          payload.apns.payload.aps.sound.critical = parseInt(sound.critical, 10);
        }
        if (sound.critical && sound.volume > 0) {
          updateRateLimits = false;
        }
      }
    }
    if (payload.apns.payload.aps.badge) {
      payload.apns.payload.aps.badge = Number(payload.apns.payload.aps.badge);
    }
    if (payload.apns.payload.aps.contentAvailable) {
      payload.apns.headers['apns-push-type'] = 'background';
    } else {
      payload.apns.headers['apns-push-type'] = 'alert';
    }

    return { updateRateLimits, payload };
  },
};
