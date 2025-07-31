module.exports = {
  createPayload: (req) => {
    const payload = {
      android: {},
      data: {},
      fcm_options: {
        analytics_label: 'androidV1Notification',
      },
    };
    let updateRateLimits = true;

    if (req.body.data) {
      // Handle the web actions by changing them into a format the app can handle
      // https://www.home-assistant.io/integrations/html5/#actions
      if (Array.isArray(req.body.data.actions)) {
        req.body.data.actions.forEach((action, i) => {
          const actionIndex = i + 1;
          if (action.action) {
            payload.data[`action_${actionIndex}_key`] = action.action;
          }
          if (action.title) {
            payload.data[`action_${actionIndex}_title`] = action.title;
          }
          if (action.uri) {
            payload.data[`action_${actionIndex}_uri`] = action.uri;
          }
          if (action.behavior) {
            payload.data[`action_${actionIndex}_behavior`] = action.behavior;
          }
        });
      }

      // Allow setting of ttl
      // https://firebase.google.com/docs/reference/admin/node/admin.messaging.AndroidConfig.html#optional-ttl
      if (req.body.data.ttl) {
        payload.android.ttl = req.body.data.ttl;
      }

      // https://firebase.google.com/docs/reference/admin/node/admin.messaging.AndroidConfig.html#optional-priority
      if (req.body.data.priority) {
        payload.android.priority = req.body.data.priority;
      }

      // https://firebase.google.com/docs/reference/admin/node/admin.messaging.AndroidNotification.html
      const androidNotificationKeys = [
        'icon',
        'color',
        'sound',
        'tag',
        'clickAction',
        'bodyLocKey',
        'bodyLocArgs',
        'titleLocKey',
        'titleLocArgs',
        'channel',
        'ticker',
        'sticky',
        'eventTime',
        'localOnly',
        'notificationPriority',
        'defaultSound',
        'defaultVibrateTimings',
        'defaultLightSettings',
        'vibrateTimings',
        'visibility',
        'notificationCount',
        'lightSettings',
        'image',
        'timeout',
        'importance',
        'subject',
        'group',
        'icon_url',
        'ledColor',
        'vibrationPattern',
        'persistent',
        'chronometer',
        'when',
        'when_relative',
        'alert_once',
        'intent_class_name',
        'notification_icon',
        'ble_advertise',
        'ble_transmit',
        'video',
        'high_accuracy_update_interval',
        'package_name',
        'tts_text',
        'media_stream',
        'command',
        'intent_package_name',
        'intent_action',
        'intent_extras',
        'media_command',
        'media_package_name',
        'intent_uri',
        'intent_type',
        'ble_uuid',
        'ble_major',
        'ble_minor',
        'confirmation',
        'app_lock_enabled',
        'app_lock_timeout',
        'home_bypass_enabled',
        'car_ui',
        'ble_measured_power',
        'progress',
        'progress_max',
        'progress_indeterminate',
      ];

      androidNotificationKeys.forEach((key) => {
        if (Object.hasOwn(req.body.data, key)) {
          payload.data[key] = String(req.body.data[key]);
        }
      });
    }

    // Always put message, title, and image in data so that the application can handle creating
    // the notifications.  This allows us to safely create actionable/imaged notifications.
    if (req.body.message) {
      payload.data.message = req.body.message;
      const androidMessagesToIgnore = [
        'request_location_update',
        'clear_notification',
        'remove_channel',
        'command_dnd',
        'command_ringer_mode',
        'command_broadcast_intent',
        'command_volume_level',
        'command_screen_on',
        'command_bluetooth',
        'command_high_accuracy_mode',
        'command_activity',
        'command_app_lock',
        'command_webview',
        'command_media',
        'command_update_sensors',
        'command_ble_transmitter',
        'command_persistent_connection',
        'command_stop_tts',
        'command_auto_screen_brightness',
        'command_screen_brightness_level',
        'command_screen_off_timeout',
        'command_flashlight',
      ];
      if (androidMessagesToIgnore.includes(req.body.message)) {
        updateRateLimits = false;
      }
    }
    if (req.body.title) {
      payload.data.title = req.body.title;
    }

    // Include webhook ID to allow distinguishing which notify service sent this.
    if (req.body.registration_info.webhook_id) {
      payload.data.webhook_id = req.body.registration_info.webhook_id;
    }

    return { updateRateLimits, payload };
  },
};
