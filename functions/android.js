module.exports = {
  createPayload: function createPayload(req) {
    var payload = {
      android: {},
      data: {}
    };
    var updateRateLimits = true;

    if(req.body.data) {
      if(req.body.data.android) {
        payload.android = req.body.data.android;
      }
      if(req.body.data.data) {
        payload.data = req.body.data.data;
      }
      // Handle the web actions by changing them into a format the app can handle
      // https://www.home-assistant.io/integrations/html5/#actions
      if(req.body.data.actions) {
        for (let i = 0; i < req.body.data.actions.length; i++) {
          const action = req.body.data.actions[i];
          payload.data["action_"+i+"_key"] = action.action
          payload.data["action_"+i+"_title"] = action.title
        }
      }
    }

    // Always put message, title, and image in data so that the application can handle creating
    // the notifications.  This allows us to safely create actionable/imaged notifications.
    if(req.body.message) {
      payload.data.message = req.body.message
    }
    if(req.body.title) {
      payload.data.title = req.body.title
    }
    if(payload.android.image) {
      payload.data.image = payload.android.image
      delete payload.android.image
    }

    return [updateRateLimits, payload];
  }
}