# mobile-apps-fcm-push

This is the code that powers the official mobile app push notifications. Feel free to submit PRs!

The service is a [Fastify](https://fastify.dev) server (`functions/webapp.js`) that runs on Cloud Run.
Firebase Hosting rewrites the public `/api/*` endpoints to it (see `firebase.json`).

## Developer Setup

Install NPM dependencies:

```
cd functions
npm install
```

Start the server for local testing. It uses [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
to talk to Firebase, so authenticate against a project you have access to first:

```
# Only once
gcloud auth application-default login

# Whenever you want to start (DEBUG is optional)
DEBUG=true GCLOUD_PROJECT=myproject npm start
```

The server reads its configuration from environment variables:

| Variable                    | Default | Description                                                    |
| --------------------------- | ------- | -------------------------------------------------------------- |
| `PORT`                      | `8080`  | Port the server listens on                                     |
| `DEBUG`                     | `false` | Set to `true` to enable debug logging                          |
| `MAX_NOTIFICATIONS_PER_DAY` | `500`   | Daily per-device notification limit                            |
| `VALKEY_HOST`/`VALKEY_PORT` | unset   | Use Valkey instead of Firestore for rate limiting (needs both) |

# Deploy your own

Change the target project if needed:

```
# Only once
sed -i s/home-assistant-mobile-apps/myproject/g .firebaserc
```

Build the container and deploy it to Cloud Run as the `mobile-push` service:

```
cd functions
gcloud builds submit --tag gcr.io/myproject/mobile-push
gcloud run deploy mobile-push --image gcr.io/myproject/mobile-push --region us-central1 --allow-unauthenticated
```

Then deploy Firebase Hosting, which routes the API endpoints to the Cloud Run service:

```
firebase deploy --only hosting
```

To use another region than `us-central1`, change it both in the `gcloud run deploy` command and in the rewrites in `firebase.json`.
