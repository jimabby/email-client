# Hermes Mobile

React Native (Expo) companion app for the Hermes email client. It reads from the
**same backend** as the desktop app — add accounts on desktop, read and reply on
your phone.

## Setup

```bash
cd app
npm install
npm start
```

Then scan the QR code with the **Expo Go** app (iOS/Android), or press `a`/`i`
to launch an emulator.

## Connecting to the backend

1. Start the desktop backend (`cd ../desktop/backend && npm start`).
2. Make sure your phone and computer are on the **same Wi-Fi network**.
3. Find your computer's LAN IP:
   - Windows: `ipconfig` → IPv4 Address (e.g. `192.168.1.50`)
   - macOS/Linux: `ipconfig getifaddr en0` / `hostname -I`
4. In the app's **Settings** screen, enter `http://<that-ip>:3001` and tap
   **Test connection**.

> The phone cannot reach `localhost` — that points at the phone itself. You must
> use the computer's network IP.

> By default the desktop backend's CORS allows only localhost origins. Native
> Expo requests aren't subject to browser CORS, so this works as-is. If you run
> the mobile app in a **browser** (`npm run web`), add its origin to the CORS
> list in `desktop/backend/server.js`.

## Screens

- **Settings** — configure the backend URL
- **Accounts** — lists accounts connected on the desktop app
- **Inbox** — email list with pull-to-refresh, infinite scroll, and search
- **Viewer** — full email (HTML rendered), star, delete, reply
- **Compose** — new message / reply

## Stack

Expo SDK 51 · React Native 0.74 · React Navigation · Zustand · axios ·
react-native-render-html
