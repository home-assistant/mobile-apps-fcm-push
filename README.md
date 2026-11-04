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

## Deploy your own

You can deploy the push server anywhere you want: it is a plain Node app you can run using Docker + Valkey cluster or Firestore for rate limiting + a reverse proxy. The hosted push server is deployed to Google Cloud and uses Valkey for rate limiting + Firebase Hosting as a proxy.

Before deploying, you'll need a Firebase project for FCM with the mobile apps registered to it. Then, [create a service account](https://docs.cloud.google.com/iam/docs/service-accounts-create) with the "Firebase Cloud Messaging API Admin" and "Logs Writer" roles, create a new key for it and download it as a JSON file.

Example Docker Compose file for a small setup on `push.example.com`, with Caddy as a reverse proxy:

```yaml
services:
  app:
    build: ./functions
    environment:
      GOOGLE_APPLICATION_CREDENTIALS: /secrets/service-account.json
      VALKEY_HOST: valkey
      VALKEY_PORT: "6379"
    volumes:
      - ./service-account.json:/secrets/service-account.json:ro
    depends_on: [valkey]

  valkey:
    image: valkey/valkey:8
    command: >
      sh -c "valkey-server --cluster-enabled yes --cluster-config-file nodes.conf &
             until valkey-cli ping >/dev/null 2>&1; do sleep 0.2; done;
             valkey-cli cluster addslotsrange 0 16383;
             wait"

  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    command: caddy reverse-proxy --from push.example.com --to app:8080
    volumes:
      - caddy_data:/data

volumes:
  caddy_data:
```

### Cloud Run and Firebase Hosting

This is how the hosted push server is deployed (see `.github/workflows/deploy.yml`). The commands below run from the repository root. Change the target project if needed:

```
# Only once
sed -i s/home-assistant-mobile-apps/myproject/g .firebaserc
```

Build the container and deploy it to Cloud Run as the `mobile-push` service. Pass the same project
to both `gcloud` commands, as `.firebaserc` only selects the project for the Firebase CLI:

```
gcloud builds submit functions --tag gcr.io/myproject/mobile-push --project myproject
gcloud run deploy mobile-push --image gcr.io/myproject/mobile-push --region us-central1 --allow-unauthenticated --project myproject
```

Then deploy Firebase Hosting, which routes the API endpoints to the Cloud Run service:

```
firebase deploy --only hosting
```

To use another region than `us-central1`, change it both in the `gcloud run deploy` command and in the rewrites in `firebase.json`.
