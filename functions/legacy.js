const path = require('path');

module.exports = {
  createPayload: function createPayload(req) {
    let payload = {
      notification: {
        body: req.body.message,
      },
      android: {
        ttl: 0,
        priority: "HIGH"
      },
      apns: {
        headers: {},
        payload: {
          aps: {
            alert: {
              body: req.body.message
            },
            sound: 'default'
          }
        }
      },
      fcm_options: {
        analytics_label: "legacyNotification"
      }
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

    var updateRateLimits = true;

    if (req.body.registration_info.app_id.indexOf('io.robbie.HomeAssistant') > -1) {
      // Enable old SNS iOS specific push setup.
      if (req.body.message === 'request_location_update' || req.body.message === 'request_location_updates') {
        payload.notification = {};
        payload.apns.payload.aps = {};
        payload.apns.payload.aps.contentAvailable = true;
        payload.apns.payload.homeassistant = { 'command': 'request_location_update' };
        updateRateLimits = false;
      } else if (req.body.message === 'clear_badge') {
        payload.notification = {};
        payload.apns.payload.aps = {};
        payload.apns.payload.aps.contentAvailable = true;
        payload.apns.payload.aps.badge = 0;
        payload.apns.payload.homeassistant = { 'command': 'clear_badge' };
        updateRateLimits = false;
      } else if (req.body.message === 'clear_notification') {
        payload.notification = {};
        payload.apns.payload.aps = {};
        payload.apns.payload.aps.contentAvailable = true;
        payload.apns.payload.homeassistant = { 'command': 'clear_notification' };

        if (req.body.data.tag) {
          payload.apns.payload.homeassistant.tag = req.body.data.tag;
        }

        if (payload.apns.headers['apns-collapse-id']) {
          payload.apns.payload.homeassistant.collapseId = payload.apns.headers['apns-collapse-id'];
        }

        delete payload.apns.headers['apns-collapse-id'];

        updateRateLimits = false;
      } else if (req.body.message === 'update_complications') {
        payload.notification = {};
        payload.apns.payload.aps = {};
        payload.apns.payload.aps.contentAvailable = true;
        payload.apns.payload.homeassistant = { 'command': 'update_complications' };
        updateRateLimits = false;
      } else {
        if (req.body.data) {
          var needsCategory = false;
          var needsMutableContent = false;

          if (req.body.data.subtitle) {
            payload.apns.payload.aps.alert.subtitle = req.body.data.subtitle;
          }

          if (req.body.data.push) {
            for (var attrname in req.body.data.push) {
              payload.apns.payload.aps[attrname] = req.body.data.push[attrname];
            }
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

          if ((typeof req.body.registration_info.os_version === "string")
            && (req.body.registration_info.os_version.startsWith('10.15'))) {
            switch (typeof payload.apns.payload.aps.sound) {
              case "string":
                payload.apns.payload.aps.sound = path.parse(payload.apns.payload.aps.sound).name;
                break;
              case "object":
                if (typeof payload.apns.payload.aps.sound.name === "string") {
                  payload.apns.payload.aps.sound.name = path.parse(payload.apns.payload.aps.sound.name).name;
                }
                break;
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

          if (typeof req.body.data.tag === "string") {
            payload.apns.headers['apns-collapse-id'] = req.body.data.tag;
          }

          if (typeof req.body.data.group === "string") {
            payload.apns.payload.aps['thread-id'] = req.body.data.group;
          }
        }

        if (needsCategory && !payload.apns.payload.aps.category) {
          payload.apns.payload.aps.category = 'DYNAMIC';
        }

        if (payload.apns.payload.aps.category) {
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
      }
    }

    if (payload.apns.payload.aps.sound) {
      if ((typeof payload.apns.payload.aps.sound === "string") && (payload.apns.payload.aps.sound.toLowerCase() === "none")) {
        delete payload.apns.payload.aps.sound;
      } else if (typeof payload.apns.payload.aps.sound === "object") {
        if (payload.apns.payload.aps.sound.volume) {
          payload.apns.payload.aps.sound.volume = parseFloat(payload.apns.payload.aps.sound.volume);
        }
        if (payload.apns.payload.aps.sound.critical) {
          payload.apns.payload.aps.sound.critical = parseInt(payload.apns.payload.aps.sound.critical);
        }
        if (payload.apns.payload.aps.sound.critical && payload.apns.payload.aps.sound.volume > 0) {
          updateRateLimits = false;
        }
      }
    }
    if (payload.apns.payload.aps.badge) payload.apns.payload.aps.badge = Number(payload.apns.payload.aps.badge);
    if (payload.apns.payload.aps.contentAvailable) {
      payload.apns.headers['apns-push-type'] = 'background';
    } else {
      payload.apns.headers['apns-push-type'] = 'alert';
    }

    return { updateRateLimits: updateRateLimits, payload: payload };
  }
};
