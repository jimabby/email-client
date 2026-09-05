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

- **Settings** - backend URL, API token, notifications, and appearance
- **Accounts** - accounts stored by the cloud backend, plus **All inboxes**
- **Folders** - every mailbox on an account, with live unread counts
- **Inbox** - list with pull-to-refresh, infinite scroll, search, and swipe
  actions (swipe right to archive, left to delete, long press to toggle read)
- **Viewer** - full email, star, delete, archive, snooze, reply, and the AI
  summary / smart replies when a key is configured on the server
- **Compose** - new message, reply, drafts, send later, and undo send

## Notifications

Turn on **New mail notifications** in Settings. The app registers an Expo push
token with the backend, which then notifies this device from the same arrival
pipeline that drives the desktop's toasts — so mail arrives with the app closed
and the desktop switched off. Tapping a notification opens that exact message.
Snoozed messages notify when they wake.

Push needs a physical device; a simulator has no transport for it.

## Appearance

Light and dark, following the system by default and overridable in Settings.
The palettes are the desktop client's tokens from `frontend/src/index.css` —
keep the two in step, or the phone and the desktop stop looking like the same
product.

## Privacy

Remote images and tracking pixels are blocked until you tap **Show images**, so
opening a message does not confirm your address to the sender. The rules come
from `shared/emailPolicy.ts`, which the desktop client enforces too — the two
readers cannot drift apart.

Attachments open through a single-use link that expires in two minutes, so the
API token never reaches the system browser's history.

## Stack

Expo SDK 51, React Native 0.74, React Navigation, Zustand, axios,
react-native-render-html, react-native-gesture-handler (swipe actions), and
expo-notifications (push).
