'use strict';

const path = require('path');

const CLEAR_NOTIFICATION = 'clear_notification';
const LiveActivityEvent = Object.freeze({
  START: 'start',
  UPDATE: 'update',
  END: 'end',
});
const LiveActivityApsKey = Object.freeze({
  ATTRIBUTES_TYPE: 'attributes-type',
  CONTENT_STATE: 'content-state',
  DISMISSAL_DATE: 'dismissal-date',
  INTERRUPTION_LEVEL: 'interruption-level',
  RELEVANCE_SCORE: 'relevance-score',
  STALE_DATE: 'stale-date',
});

module.exports = {
  createPayload: (req) => {
    if (req.body.live_activity_token) {
      return buildLiveActivityPayload(req);
    }

    if (process.env.DEBUG === 'true' && req.body.data?.live_update === true) {
      console.info(
        '[legacy-live-activity]',
        JSON.stringify({
          mode: 'fallback_notification',
          reason: 'missing_live_activity_token',
          tag: req.body.data?.tag ?? null,
          activity_id: req.body.data?.activity_id ?? null,
        }),
      );
    }

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
        if (req.body.data?.push?.badge) {
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

        if (req.body.data?.tag) {
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
            payload.apns.payload.aps = { ...payload.apns.payload.aps, ...req.body.data.push };
          }

          if (req.body.data.actions) {
            payload.apns.payload.actions = req.body.data.actions;
            needsCategory = true;
          }

          if (req.body.data.sound) {
            payload.apns.payload.aps.sound = req.body.data.sound;
          } else if (req.body.data.push?.sound) {
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

// Builds an FCM-compatible payload for Live Activity push notifications.
//
// The liveActivityToken field (camelCase) is required by Firebase Admin SDK v13.5.0+.
// When present in the apns config, FCM automatically sets apns-push-type: liveactivity
// and routes the notification to APNs correctly. No APNs credentials, HTTP/2 sessions,
// or environment routing are needed — FCM handles it all.
function buildLiveActivityPayload(req) {
  const { data = {} } = req.body;
  const event = data.event ?? LiveActivityEvent.UPDATE;
  const now = Math.floor(Date.now() / 1000);

  const aps = {
    timestamp: now,
    event,
  };

  // content-state is required for start and update; send for end as well so the
  // activity can display final state before dismissal.
  const contentState = buildLiveActivityContentState(req.body, data);
  aps[LiveActivityApsKey.CONTENT_STATE] = contentState;

  if (event === LiveActivityEvent.START) {
    // Push-to-start requires the static attributes that were registered with the activity.
    // 'attributes-type' must exactly match the Swift struct name — HALiveActivityAttributes —
    // because APNs uses it to look up the registered ActivityKit type on the device.
    // This value is case-sensitive and cannot change after the app has shipped.
    aps[LiveActivityApsKey.ATTRIBUTES_TYPE] = 'HALiveActivityAttributes';
    aps.attributes = {
      tag: data.activity_id ?? data.tag ?? '',
      title: req.body.title ?? '',
    };
  }

  if (event === LiveActivityEvent.END) {
    aps[LiveActivityApsKey.DISMISSAL_DATE] = data.dismissal_date ?? now;
  }

  if (data.stale_date !== undefined) {
    aps[LiveActivityApsKey.STALE_DATE] = data.stale_date;
  }

  if (data.relevance_score !== undefined) {
    aps[LiveActivityApsKey.RELEVANCE_SCORE] = data.relevance_score;
  }

  if (data.alert) {
    aps.alert = data.alert;
    if (data.alert_sound) {
      aps.sound = data.alert_sound;
    }
  } else if (event === LiveActivityEvent.START) {
    // Start events always carry an alert so the user sees the activity launch.
    aps.alert = defaultLiveActivityAlert(req.body);
  } else if (event === LiveActivityEvent.UPDATE) {
    // APNs needs aps.alert present to treat the push as alert-type and deliver immediately.
    // Omitting `body` avoids triggering the Live Activity update chime — only `body`
    // causes iOS to play sound, a bare `title` is enough for fast delivery without noise.
    aps.alert = { title: '' };
  } else if (event === LiveActivityEvent.END) {
    aps.alert = defaultLiveActivityAlert(req.body);
  }

  if (process.env.DEBUG === 'true') {
    console.info(
      '[legacy-live-activity]',
      JSON.stringify({
        mode: 'live_activity',
        event,
        tag: data.tag ?? null,
        activity_id: data.activity_id ?? null,
        has_alert: Boolean(aps.alert),
        interruption_level: aps[LiveActivityApsKey.INTERRUPTION_LEVEL] ?? null,
        content_state_keys: Object.keys(contentState),
        dismissal_date: aps[LiveActivityApsKey.DISMISSAL_DATE] ?? null,
      }),
    );
  }

  const payload = {
    apns: {
      // The liveActivityToken (camelCase) tells Firebase Admin SDK v13.5.0+ to route
      // this message as a Live Activity notification. FCM automatically sets the
      // apns-push-type: liveactivity header and the correct apns-topic suffix.
      liveActivityToken: req.body.live_activity_token,
      headers: {
        'apns-priority': '10',
      },
      payload: {
        aps,
      },
    },
    fcm_options: {
      analytics_label: 'iOSLiveActivityV1',
    },
  };

  return {
    updateRateLimits: true,
    payload,
  };
}

function defaultLiveActivityAlert(body) {
  return {
    title: body.title ?? '',
    body: body.message !== CLEAR_NOTIFICATION ? (body.message ?? '') : '',
  };
}

// Builds the content-state object that APNs delivers to the app's Live Activity widget.
// Each field maps to a property in the Swift HALiveActivityContentState Codable struct.
// Only recognized fields are forwarded — extra keys would cause APNs to reject the payload.
function buildLiveActivityContentState(body, data) {
  const state = {};

  // Top-level message field is the primary text. Do not render command strings.
  // The Swift ContentState requires message, so send an empty string if HA omitted it.
  if (body.message !== undefined && body.message !== CLEAR_NOTIFICATION) {
    state.message = body.message;
  } else {
    state.message = '';
  }

  if (body.title !== undefined) state.title = body.title;
  if (data.critical_text !== undefined) state.critical_text = data.critical_text;
  if (data.progress !== undefined) state.progress = data.progress;
  if (data.progress_max !== undefined) state.progress_max = data.progress_max;
  if (data.chronometer !== undefined) state.chronometer = data.chronometer;
  if (data.notification_icon !== undefined) state.icon = data.notification_icon;
  if (data.notification_icon_color !== undefined) state.color = data.notification_icon_color;
  if (data.when !== undefined) {
    state.countdown_end = data.when_relative
      ? Math.floor(Date.now() / 1000) + data.when
      : data.when;
  }

  if (data.content_state) {
    const cs = data.content_state;
    if (cs.title !== undefined) state.title = cs.title;
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
