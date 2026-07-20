# Hermes Mobile

React Native (Expo) app for Hermes. For independent mobile use, connect it to an
always-on cloud backend; the desktop computer does not need to be running.

## Setup

```bash
cd app
npm install
npm start
```

Then scan the QR code with Expo Go (iOS/Android), or press `a` / `i` to launch
an emulator.

## Connecting to the cloud backend

1. Deploy the backend using [`../deploy/README.md`](../deploy/README.md).
2. In **Settings**, enter its public URL, such as `https://mail.example.com`.
3. Paste the same random `API_TOKEN` configured on the server.
4. Tap **Test connection**, then open Accounts.

The token is stored through Expo SecureStore (iOS Keychain / Android Keystore)
and is sent as a Bearer token on every private API request.

For local development, the LAN URL still works when the backend is running, and
`API_TOKEN` may be left unset. Never expose that unauthenticated mode publicly.

## Screens

- **Settings** - configure the backend URL and private API token
- **Accounts** - list accounts stored by the cloud backend
- **Inbox** - email list with pull-to-refresh, infinite scroll, and search
- **Viewer** - full email (HTML rendered), star, delete, archive, and reply
- **Compose** - new message, reply, and drafts

## Stack

Expo SDK 51, React Native 0.74, React Navigation, Zustand, axios, and
react-native-render-html.
