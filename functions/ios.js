'use strict';

// Live Activity 'end' events dismiss an ongoing activity rather than delivering new content,
// so they are exempt from rate limits — equivalent to clear_notification on Android.
const NO_RATE_LIMIT_LIVE_ACTIVITY_EVENTS = new Set(['end']);

module.exports = {
  createPayload: (req) => {
    const payload = {
      notification: {
        body: req.body.message,
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
        analytics_label: 'iosV1Notification',
      },
    };

    if (req.body.title) {
      payload.notification.title = req.body.title;
      payload.apns.payload.aps.alert.title = req.body.title;
    }

    if (req.body.data) {
      for (const key of ['apns', 'data']) {
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

    if (req.body.registration_info.app_id.indexOf('io.robbie.HomeAssistant') > -1) {
      // Enable old SNS iOS specific push setup.
      if (
        req.body.message === 'request_location_update' ||
        req.body.message === 'request_location_updates'
      ) {
        payload.notification = {};
        payload.apns.payload.aps = {};
        payload.apns.payload.aps.contentAvailable = true;
        payload.apns.payload.homeassistant = {
          command: 'request_location_update',
        };
        updateRateLimits = false;
      } else if (req.body.message === 'clear_badge') {
        payload.notification = {};
        payload.apns.payload.aps = {};
        payload.apns.payload.aps.contentAvailable = true;
        payload.apns.payload.aps.badge = 0;
        payload.apns.payload.homeassistant = { command: 'clear_badge' };
        updateRateLimits = false;
      } else {
        if (req.body.data) {
          if (req.body.data.subtitle) {
            payload.apns.payload.aps.alert.subtitle = req.body.data.subtitle;
          }

          if (req.body.data.push) {
            payload.apns.payload.aps = { ...payload.apns.payload.aps, ...req.body.data.push };
          }

          if (req.body.data.sound) {
            payload.apns.payload.aps.sound = req.body.data.sound;
          } else if (req.body.data.push?.sound) {
            payload.apns.payload.aps.sound = req.body.data.push.sound;
          }

          if (req.body.data.entity_id) {
            payload.apns.payload.entity_id = req.body.data.entity_id;
          }

          if (req.body.data.action_data) {
            payload.apns.payload.homeassistant = req.body.data.action_data;
          }

          if (req.body.data.attachment) {
            payload.apns.payload.attachment = req.body.data.attachment;
          }

          if (req.body.data.url) {
            payload.apns.payload.url = req.body.data.url;
          }

          if (req.body.data.shortcut) {
            payload.apns.payload.shortcut = req.body.data.shortcut;
          }

          if (req.body.data.presentation_options) {
            payload.apns.payload.presentation_options = req.body.data.presentation_options;
          }
        }

        payload.apns.payload.aps.mutableContent = true;

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

  // Builds the APNs payload for a Live Activity push notification.
  //
  // This returns a different shape than createPayload because Live Activities bypass FCM
  // entirely — the payload is delivered directly to APNs via apns.js. The returned object
  // contains apnsPayload/apnsHeaders/apnsEnvironment instead of an FCM message object.
  createLiveActivityPayload: (req) => {
    const { data = {} } = req.body;
    const event = data.event ?? 'update';
    const now = Math.floor(Date.now() / 1000);

    const aps = {
      timestamp: now,
      event,
    };

    // content-state is required for start and update; send for end as well so the
    // activity can display final state before dismissal.
    aps['content-state'] = buildLiveActivityContentState(req.body, data);

    if (event === 'start') {
      // Push-to-start requires the static attributes that were registered with the activity.
      // 'attributes-type' must exactly match the Swift struct name — HALiveActivityAttributes —
      // because APNs uses it to look up the registered ActivityKit type on the device.
      // This value is case-sensitive and cannot change after the app has shipped.
      aps['attributes-type'] = 'HALiveActivityAttributes';
      aps.attributes = {
        tag: data.activity_id ?? data.tag ?? '',
        title: req.body.title ?? '',
      };
    }

    if (event === 'end' && data.dismissal_date) {
      aps['dismissal-date'] = data.dismissal_date;
    }

    if (data.stale_date) {
      aps['stale-date'] = data.stale_date;
    }

    if (data.relevance_score !== undefined) {
      aps['relevance-score'] = data.relevance_score;
    }

    // Optional alert shown alongside the live activity update.
    if (data.alert) {
      aps.alert = data.alert;
      if (data.alert_sound) {
        aps.sound = data.alert_sound;
      }
    }

    // Sandbox tokens are rejected by the production APNs endpoint and vice versa.
    // The client reports its environment during registration so we can route correctly.
    // Normalize to the two valid values so unexpected strings don't create unbounded
    // session cache entries in apns.js (e.g. 'Production', 'prod', or typos).
    const rawEnvironment = req.body.registration_info?.apns_environment;
    const apnsEnvironment = rawEnvironment === 'sandbox' ? 'sandbox' : 'production';
    const bundleId = req.body.registration_info?.app_id ?? 'io.robbie.HomeAssistant';

    return {
      updateRateLimits: !NO_RATE_LIMIT_LIVE_ACTIVITY_EVENTS.has(event),
      apnsPayload: { aps },
      apnsHeaders: {
        'apns-push-type': 'liveactivity',
        // APNs requires the topic to include the push-type suffix for Live Activities.
        'apns-topic': `${bundleId}.push-type.liveactivity`,
        'apns-priority': '10',
      },
      apnsEnvironment,
    };
  },
};

// Builds the content-state object that APNs delivers to the app's Live Activity widget.
// Each field maps to a property in the Swift HALiveActivityContentState Codable struct.
// Only recognized fields are forwarded — extra keys would cause APNs to reject the payload.
function buildLiveActivityContentState(body, data) {
  const state = {};

  // Top-level message field is the primary text; content_state fields take precedence.
  if (body.message) {
    state.message = body.message;
  }

  if (data.content_state) {
    const cs = data.content_state;
    if (cs.message !== undefined) state.message = cs.message;
    if (cs.critical_text !== undefined) state.critical_text = cs.critical_text;
    if (cs.progress !== undefined) state.progress = cs.progress;
    if (cs.progress_max !== undefined) state.progress_max = cs.progress_max;
    if (cs.chronometer !== undefined) state.chronometer = cs.chronometer;
    if (cs.countdown_end !== undefined) state.countdown_end = cs.countdown_end;
    if (cs.icon !== undefined) state.icon = cs.icon;
    if (cs.color !== undefined) state.color = cs.color;
  }

  return state;
}
