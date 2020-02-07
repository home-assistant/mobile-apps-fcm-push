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
