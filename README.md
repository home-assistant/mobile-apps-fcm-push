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

# Optional: enable debug logging while running locally
echo "DEBUG_LOCAL=true" > .env.local

# Whenever you want to start
npm run serve
```

Configuration is read from [`.env` files](https://firebase.google.com/docs/functions/config-env#env-variables)
in the `functions` directory (`.env`, `.env.<project id>` and, for local runs only, `.env.local`).
They are git-ignored, so each developer keeps their own.

| Variable      | Default       | Description                                       |
| ------------- | ------------- | ------------------------------------------------- |
| `APP_REGION`  | `us-central1` | Region the Cloud Functions are deployed to        |
| `DEBUG_LOCAL` | `false`       | Set to `true` to enable debug logging             |

# Deploy your own

Change the target project if needed:

```
# Only once
sed -i s/home-assistant-mobile-apps/myproject/g ../.firebaserc
```

You can set `APP_REGION` if you want to deploy your functions in another location than `us-central1`, e.g. `europe-west1`:

```
# Only once
echo "APP_REGION=europe-west1" > .env
```

Then deploy the Cloud Functions:

```
firebase deploy
```
