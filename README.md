# mobile-apps-fcm-push

This is the code that powers the official mobile app push notifications. Feel free to submit PRs!

## Developer Setup

Install NPM dependencies:

```
cd functions
npm install
```

Startup function for local testing:

```
# Only Once
npm install -g firebase-tools

firebase functions:config:set debug.local=true
firebase functions:config:get > .runtimeconfig.json

# Whenever you want to start
npm run serve
```

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
