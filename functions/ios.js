'use strict';

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
    // When live_activity_token is present, this is a Live Activity push notification.
    // Firebase Admin SDK v13.5.0+ supports the liveActivityToken (camelCase) field in the
    // apns config object. When set, FCM automatically adds apns-push-type: liveactivity
    // and routes the notification to APNs correctly. No APNs credentials, HTTP/2 sessions,
    // or environment routing are needed — FCM handles it all.
    if (req.body.live_activity_token) {
      return buildLiveActivityPayload(req);
    }

    // Live Activity requests without a token fall back to normal push; log them for routing debug.
    if (req.body.data?.live_update === true) {
      console.info(
        '[ios-live-activity]',
        JSON.stringify({
          mode: 'fallback_notification',
          reason: 'missing_live_activity_token',
          tag: req.body.data?.tag ?? null,
          activity_id: req.body.data?.activity_id ?? null,
        })
      );
    }

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

  if (data.stale_date) {
    aps[LiveActivityApsKey.STALE_DATE] = data.stale_date;
  }

  if (data.relevance_score !== undefined) {
    aps[LiveActivityApsKey.RELEVANCE_SCORE] = data.relevance_score;
  }

  // FCM currently only delivers Live Activity pushes reliably when aps.alert exists.
  // Use a blank alert for quiet updates/ends; explicit data.alert still wins.
  if (data.alert) {
    aps.alert = data.alert;
    if (data.alert_sound) {
      aps.sound = data.alert_sound;
    }
  } else {
    aps.alert = defaultLiveActivityAlert(req.body, event);
    if (event !== LiveActivityEvent.START) {
      aps[LiveActivityApsKey.INTERRUPTION_LEVEL] = 'passive';
    }
  }

  console.info(
    '[ios-live-activity]',
    JSON.stringify({
      mode: 'live_activity',
      event,
      tag: data.tag ?? null,
      activity_id: data.activity_id ?? null,
      has_alert: Boolean(aps.alert),
      interruption_level: aps[LiveActivityApsKey.INTERRUPTION_LEVEL] ?? null,
      content_state_keys: Object.keys(contentState),
      dismissal_date: aps[LiveActivityApsKey.DISMISSAL_DATE] ?? null,
    })
  );

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
    // Use a dedicated analytics label so Live Activity sends can be separated from regular iOS pushes.
    fcm_options: {
      analytics_label: 'iOSLiveActivityV1',
    },
  };

  return {
    updateRateLimits: true,
    payload,
  };
}

// FCM requires aps.alert for Live Activity delivery; use real copy for starts and blank copy for quiet updates.
function defaultLiveActivityAlert(body, event) {
  if (event === LiveActivityEvent.START) {
    return {
      title: body.title ?? '',
      body: body.message ?? '',
    };
  }

  return {
    title: '',
    body: '',
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
