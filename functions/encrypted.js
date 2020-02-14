module.exports = {
    createPayload: function createPayload(req) {
      let payload = {
        apns: {
            payload: {
                aps: {
                    alert: {
                        title: "Encrypted notification",
                        body: "If you're seeing this, something has gone wrong with encryption"
                    },
                    'mutable-content': true
                }
            }
        },
        data: {
            encrypted: "true",
            encrypted_data: req.body.encrypted_data,
            registration_info: JSON.stringify(req.body.registration_info)
        },
        fcm_options: {
          analytics_label: "encryptedV1Notification"
        }
      };

      return { updateRateLimits: true, payload: payload };
    }
  }
