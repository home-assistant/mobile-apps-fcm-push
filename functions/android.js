module.exports = {
  createPayload: function createPayload(req) {
    let payload = {
      android: {},
      data: {}
    };
    let updateRateLimits = true;

    if(req.body.data){

      // URL to an image
      if(req.body.data.image){
        payload.data.image = req.body.data.image
      }

      // Handle the web actions by changing them into a format the app can handle
      // https://www.home-assistant.io/integrations/html5/#actions
      if(req.body.data.actions) {
        for (let i = 0; i < req.body.data.actions.length; i++) {
          const action = req.body.data.actions[i];
          payload.data["action_"+(i+1)+"_key"] = action.action
          payload.data["action_"+(i+1)+"_title"] = action.title
        }
      }

      // Allow setting of ttl
      // https://firebase.google.com/docs/reference/admin/node/admin.messaging.AndroidConfig.html#optional-ttl
      if(req.body.data.ttl){
        payload.android.ttl = req.body.data.ttl
      }
      
      // https://firebase.google.com/docs/reference/admin/node/admin.messaging.AndroidConfig.html#optional-priority
      if(req.body.data.priority){
        payload.android.priority = req.body.data.priority
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

    return { updateRateLimits: updateRateLimits, payload: payload };
  }
}
