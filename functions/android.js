module.exports = {
  createPayload: function createPayload(req) {
    let payload = {
      android: {},
      data: {},
      fcm_options: {
        analytics_label: "androidV1Notification"
      }
    };
    let updateRateLimits = true;

    if (req.body.data){

      // Handle the web actions by changing them into a format the app can handle
      // https://www.home-assistant.io/integrations/html5/#actions
      if (req.body.data.actions) {
        for (let i = 0; i < req.body.data.actions.length; i++) {
          const action = req.body.data.actions[i];
          if (action.action){
            payload.data["action_"+(i+1)+"_key"] = action.action;
          }
          if (action.title) {
            payload.data["action_"+(i+1)+"_title"] = action.title;
          }
          if (action.uri){
            payload.data["action_"+(i+1)+"_uri"] = action.uri;
          }
        }
      }

      // Allow setting of ttl
      // https://firebase.google.com/docs/reference/admin/node/admin.messaging.AndroidConfig.html#optional-ttl
      if (req.body.data.ttl){
        payload.android.ttl = req.body.data.ttl;
      }

      // https://firebase.google.com/docs/reference/admin/node/admin.messaging.AndroidConfig.html#optional-priority
      if (req.body.data.priority){
        payload.android.priority = req.body.data.priority;
      }

      // https://firebase.google.com/docs/reference/admin/node/admin.messaging.AndroidNotification.html
      for (const key of [
        'icon', 'color', 'sound', 'tag', 'clickAction',
        'bodyLocKey', 'bodyLocArgs', 'titleLocKey', 'titleLocArgs', 'channel',
        'ticker', 'sticky', 'eventTime', 'localOnly', 'notificationPriority',
        'defaultSound', 'defaultVibrateTimings', 'defaultLightSettings', 'vibrateTimings',
        'visibility', 'notificationCount', 'lightSettings', 'image', 'timeout', 'importance', 
        'subject', 'group', 'icon_url', 'ledColor', 'vibrationPattern', 'persistent', 
        'chronometer', 'when', 'alert_once', 'intent_class_name', 'notification_icon',
        'ble_advertise', 'ble_transmit', 'video', 'high_accuracy_update_interval',
        'package_name', 'visibility'
      ]) {
        if (req.body.data[key]){
          payload.data[key] = String(req.body.data[key]);
        }
      }
    }

    // Always put message, title, and image in data so that the application can handle creating
    // the notifications.  This allows us to safely create actionable/imaged notifications.
    if (req.body.message) {
      payload.data.message = req.body.message;
      const messages_to_ignore = ['request_location_update', 'clear_notification', 'remove_channel', 'command_dnd', 
      'command_ringer_mode', 'command_broadcast_intent','command_volume_level', 'command_screen_on',
      'command_bluetooth', 'command_high_accuracy_mode', 'command_activity', 'command_webview', 'command_media',
      'command_update_sensors', 'command_ble_transmitter', 'command_persistent_connection'];
      if (messages_to_ignore.includes(req.body.message)) {
        updateRateLimits = false;
      }
    }
    if (req.body.title) {
      payload.data.title = req.body.title;
    }

    return { updateRateLimits: updateRateLimits, payload: payload };
  }
};
