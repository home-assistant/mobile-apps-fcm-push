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

# Deploy your own

Change the target project if needed:

```
# Only once
sed -i s/home-assistant-mobile-apps/myproject/g ../.firebaserc
```

You can set the `app.region` setting if you want to deploy your functions in a another location than `us-central1`, e.g. `europe-west1`:

```
# Only once
firebase functions:config:set app.region="us-central1"
```

Then deploy the Cloud Functions:

```
firebase deploy
```
