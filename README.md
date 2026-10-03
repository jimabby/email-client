# Hermes

Hermes is a privacy-minded email client for Gmail, Outlook, and any IMAP/SMTP
provider, with optional AI help (Claude, ChatGPT, or Gemini). It ships as a
desktop app for Windows, macOS, and Linux, and as a mobile app that talks to a
self-hosted backend.

The interface is available in English and Simplified Chinese (简体中文).

## What's in this repository

```
email-client/
├── desktop/            Desktop app: Electron shell + Node backend + React UI
│   ├── electron/       Window, tray, notifications, auto-update, secure link handling
│   ├── backend/        Express API: providers, send queue, rules, search index, tests
│   └── frontend/       React + Vite + Tailwind interface
├── app/                Mobile app (React Native / Expo)
├── deploy/             Docker Compose + Caddy for an always-on cloud backend
└── shared/             Code shared between desktop and mobile (email policy)
```

One backend serves every client. On the desktop it runs inside the Electron
app, bound to `127.0.0.1` with a fresh token each launch. The phone talks to the
same backend deployed on a server (see [`deploy/`](deploy/README.md)), so it
works with the computer switched off.

```
 Desktop window ──► backend (127.0.0.1, inside the app) ──► Gmail API / Graph / IMAP+SMTP
 Phone app ───────► backend (your VPS, behind Caddy) ─────► Gmail API / Graph / IMAP+SMTP
```

## Features

**Mail**
- Gmail and Outlook via OAuth; any other provider over IMAP/SMTP (presets for
  Gmail app passwords, Outlook, Yahoo, and iCloud)
- All inboxes in one list, conversation view, and real-time arrival (IMAP IDLE,
  Gmail Pub/Sub, Microsoft Graph webhooks, or polling)
- Send-as aliases, per-account signatures, templates, and scheduled send
- Undo send, and Undo for delete, archive, move, and spam on every provider
- An outbox that retries sends after a network failure
- Sent mail is saved to the Sent folder on IMAP servers that don't keep their
  own copy (configurable per account)
- Send & archive: reply and file the original in one step
- Drag-and-drop attachments; print or save any message as PDF
- Calendar invitations with Accept / Tentative / Decline
- Mbox/EML import and mbox export; one-file settings backup

**Staying in control**
- **Screener**: mail from first-time senders waits in a holding folder until
  you allow or block them, per address or for a whole domain. Everyone you
  already correspond with is approved when you switch it on.
- Rules with multiple conditions and actions, run on the server as mail arrives
- Snooze, follow-up reminders ("remind me if nobody replies"), and muted threads
- Vacation auto-reply with loop protection and per-sender cooldown
- VIP-only notifications and quiet hours
- One-click unsubscribe (RFC 8058) and sender blocking

**Search and AI**
- Instant local search across all accounts (`from:`, `subject:`,
  `has:attachment`, `is:unread`, `is:starred`, `"phrases"`), plus attachment search
- Optional AI: draft assistance in 9 modes, smart replies, thread summaries,
  priority inbox, task/date extraction, and inbox categories

**Privacy and security**
- Credentials, cached mail, the outbox, and the search index are encrypted at
  rest (AES-256-GCM; the desktop app keeps the key in the OS keychain)
- Messages render in a sandboxed frame where scripts can never run; remote
  images are blocked until you choose to load them, and tracking pixels are
  removed
- The API listens on loopback only unless you set an API token; DNS-rebinding
  attempts are refused
- Links in mail open only as `http(s)` or `mailto`

## Keyboard shortcuts

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `j` / `k` | Next / previous message | `r` | Reply |
| `↓` / `↑` | Same, while the list has focus | `a` | Reply all |
| `x` | Select message for a bulk action | `f` | Forward |
| `e` | Archive | `s` | Star / unstar |
| `d` / `Delete` | Delete | `u` | Mark unread |
| `/` | Search | `Ctrl+N` | New message |
| `Ctrl+K` | Command palette | `Ctrl+Enter` | Send (in the composer) |
| `Esc` | Deselect / close | `?` | Show all shortcuts |

## Getting started

Requirements: **Node.js 22 or newer** (Vite needs 20.19+/22.12+, and the test
runner's file globbing needs 21+) and npm.

### Desktop app

```bash
cd desktop
npm install                     # Electron shell
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
npm run build:frontend
npm start                       # launches the Electron app
```

On Windows, `desktop/setup.bat` installs everything and `desktop/start-desktop.bat`
launches the app.

To build an installer: `npm run dist` (or `npm run pack` for an unpacked build).

### Development (browser + hot reload)

```bash
cd desktop/backend && cp .env.example .env    # then edit .env
cd ..
npm run dev        # backend on http://localhost:3001, UI on http://localhost:5173
```

The backend needs no keys to start. IMAP accounts work out of the box. Gmail
and Outlook sign-in need OAuth credentials, and AI features need an API key
(entered in Settings → AI, or set in `.env`). Every variable is documented in
[`desktop/backend/.env.example`](desktop/backend/.env.example).

### Mobile app

The phone app needs a backend reachable from the internet. Deploy one with
[`deploy/README.md`](deploy/README.md) (a small VPS with Docker is enough),
then:

```bash
cd app
npm install
npm start          # scan the QR code with Expo Go
```

In the app's Settings, enter the server URL and its `API_TOKEN`. Details:
[`app/README.md`](app/README.md).

## Configuration notes

- **Gmail / Outlook OAuth**: create OAuth credentials in Google Cloud Console or
  Azure, and register the callback URLs from `.env.example`. Without them,
  Gmail still works over IMAP with an app password.
- **Language**: Settings → Privacy & Appearance → Language. "Match system"
  picks Chinese when the OS prefers it.
- **Sent copies on IMAP**: Settings → Rules & Templates → "Saved copies of sent
  mail". Gmail and Office 365 file their own copy, so Hermes skips them by
  default; every other server gets a copy unless you turn it off.
- **Screener**: Settings → Rules & Templates → Open screener, or the Screener
  entry in the sidebar.

## Testing

```bash
cd desktop/backend && npm test          # backend test suite (node:test)
cd desktop/frontend && npx tsc --noEmit # type-check the desktop UI
cd app && npm run typecheck             # type-check the mobile app
```

## More documentation

- [`desktop/README.md`](desktop/README.md): desktop features, security model, updates
- [`app/README.md`](app/README.md): mobile setup and screens
- [`deploy/README.md`](deploy/README.md): cloud deployment, moving accounts, backups
