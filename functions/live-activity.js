'use strict';

// Events that do not count against rate limits (equivalent to clear_notification on Android).
const NO_RATE_LIMIT_EVENTS = new Set(['end']);

module.exports = {
  createPayload: (req) => {
    const { data = {} } = req.body;
    const event = data.event ?? 'update';
    const now = Math.floor(Date.now() / 1000);

    const aps = {
      timestamp: now,
      event,
    };

    // content-state is required for start and update; send for end as well so the
    // activity can display final state before dismissal.
    aps['content-state'] = buildContentState(req.body, data);

    if (event === 'start') {
      // Push-to-start requires the static attributes that were registered with the activity.
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

    const apnsEnvironment = req.body.registration_info?.apns_environment ?? 'production';
    const bundleId = req.body.registration_info?.app_id ?? 'io.robbie.HomeAssistant';

    return {
      updateRateLimits: !NO_RATE_LIMIT_EVENTS.has(event),
      apnsPayload: { aps },
      apnsHeaders: {
        'apns-push-type': 'liveactivity',
        'apns-topic': `${bundleId}.push-type.liveactivity`,
        'apns-priority': '10',
      },
      apnsEnvironment,
    };
  },
};

function buildContentState(body, data) {
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
