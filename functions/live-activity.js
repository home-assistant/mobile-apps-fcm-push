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

// 'attributes-type' must exactly match the Swift struct name registered with ActivityKit.
// APNs uses it to look up the registered type on the device, so this value is case-sensitive
// and cannot change after the app has shipped.
const ATTRIBUTES_TYPE = 'HALiveActivityAttributes';

// APNs delivery priority for Live Activity pushes. 10 means "send immediately" (the highest
// priority); it is a string because APNs transmits header values as strings.
const APNS_PRIORITY_IMMEDIATE = '10';

// FCM analytics label used to identify Live Activity pushes in Firebase reporting.
const ANALYTICS_LABEL = 'iOSLiveActivityV1';

module.exports = { createPayload };

// Builds an FCM-compatible payload for Live Activity push notifications.
//
// The liveActivityToken field (camelCase) is required by Firebase Admin SDK v13.5.0+.
// When present in the apns config, FCM automatically sets apns-push-type: liveactivity
// and routes the notification to APNs correctly. No APNs credentials, HTTP/2 sessions,
// or environment routing are needed — FCM handles it all.
function createPayload(req) {
  const { data = {} } = req.body;
  const event = data.event ?? LiveActivityEvent.UPDATE;
  const now = Math.floor(Date.now() / 1000);

  const aps = {
    timestamp: now,
    event,
  };

  // content-state is required for start and update; send for end as well so the
  // activity can display final state before dismissal.
  const contentState = buildContentState(req.body, data);
  aps[LiveActivityApsKey.CONTENT_STATE] = contentState;

  if (event === LiveActivityEvent.START) {
    // Push-to-start requires the static attributes that were registered with the activity.
    aps[LiveActivityApsKey.ATTRIBUTES_TYPE] = ATTRIBUTES_TYPE;
    aps.attributes = {
      tag: data.activity_id ?? data.tag ?? '',
      title: req.body.title ?? '',
    };
    // Server that started the activity, so a tap can open the originating server when the
    // user has several. Only sent when present; the iOS attribute is optional for compatibility.
    const startWebhookId = req.body.registration_info && req.body.registration_info.webhook_id;
    if (startWebhookId) {
      aps.attributes.webhook_id = startWebhookId;
    }
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
    aps.alert = buildAlert(req.body);
  } else if (event === LiveActivityEvent.UPDATE) {
    if (data.silent === true) {
      // silent: true — title-only alert keeps fast APNs delivery without triggering the chime.
      aps.alert = { title: '' };
    } else {
      aps.alert = buildAlert(req.body);
    }
  } else if (event === LiveActivityEvent.END) {
    aps.alert = buildAlert(req.body);
  }

  if (process.env.DEBUG === 'true') {
    console.info(
      '[live-activity]',
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
        'apns-priority': APNS_PRIORITY_IMMEDIATE,
      },
      payload: {
        aps,
      },
    },
    fcm_options: {
      analytics_label: ANALYTICS_LABEL,
    },
  };

  return {
    updateRateLimits: true,
    payload,
  };
}

function buildAlert(body) {
  return {
    title: body.title ?? '',
    body: body.message !== CLEAR_NOTIFICATION ? (body.message ?? '') : '',
  };
}

// Builds the content-state object that APNs delivers to the app's Live Activity widget.
// Each field maps to a property in the Swift HALiveActivityContentState Codable struct.
// Only recognized fields are forwarded — extra keys would cause APNs to reject the payload.
function buildContentState(body, data) {
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
  // url: path/URL to open when the activity is tapped (mirrors actionable notifications).
  if (data.url !== undefined) state.url = data.url;
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
    if (cs.url !== undefined) state.url = cs.url;
  }

  return state;
}
