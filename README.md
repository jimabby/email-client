# Hermes — Email Client with Claude AI

A fast, dark-themed desktop/web email client that supports Gmail, Outlook, and any IMAP/SMTP provider, with built-in **Claude AI** to help you write better emails.

## Features

- **Multi-account** — Gmail (OAuth), Outlook (OAuth), and any IMAP/SMTP server
- **Full email client** — read, compose, reply, forward emails
- **AI Assist** — Claude AI helps you write emails with 9 modes:
  - Improve — make it professional and clear
  - Concise — shorten without losing meaning
  - Complete — finish what you started
  - Fix Grammar — grammar and spelling
  - Formal — rewrite in formal tone
  - Friendly — warm and approachable tone
  - Subject Ideas — suggest subject lines
  - Draft Reply — auto-draft a reply
  - Custom — give your own instruction
- **Real-time streaming** AI suggestions
- **Folder navigation** — Inbox, Sent, Drafts, Trash, custom folders
- **Desktop app** — runs as a native Electron app or in the browser

## Quick Start

### 1. Setup

Double-click `setup.bat` (browser mode) or `setup-electron.bat` (desktop app).

Or manually:
```bash
cd backend && npm install
cd ../frontend && npm install
```

### 2. Configure API Keys

Create `backend/.env`:

```env
# Required for AI suggestions
ANTHROPIC_API_KEY=sk-ant-...

# Optional: for Gmail OAuth
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...

# Optional: for Outlook OAuth
OUTLOOK_CLIENT_ID=...
OUTLOOK_CLIENT_SECRET=...
```

### 3. Start

**Browser mode** — double-click `start.bat`

**Desktop app** — double-click `start-desktop.bat`

Or manually:
```bash
# Browser mode (two terminals)
cd backend && npm start
cd frontend && npm run dev
# Open http://localhost:5173

# Desktop app
npm start   # from root folder
```

## Adding Email Accounts

### IMAP / SMTP (Recommended)

Works with any provider. Click **Add Account → IMAP/SMTP tab**.

**Gmail with App Password:**
1. Enable 2FA on your Google account
2. Go to Google Account → Security → App Passwords → create one
3. Use that 16-character password in the IMAP tab
4. Settings: IMAP `imap.gmail.com:993`, SMTP `smtp.gmail.com:587`

**Outlook.com / Hotmail:**
- IMAP `outlook.office365.com:993`, SMTP `smtp.office365.com:587`

**Yahoo Mail:**
- Generate an App Password in Yahoo Account Security settings

### Gmail OAuth

1. Create a project at [Google Cloud Console](https://console.cloud.google.com)
2. Enable the **Gmail API**
3. Create OAuth 2.0 credentials (Web Application)
4. Add `http://localhost:3001/api/auth/gmail/callback` as redirect URI
5. Add your Google account as a **Test User** in OAuth consent screen
6. Copy Client ID and Secret to `backend/.env`

### Outlook OAuth

1. Register an app at [Azure Portal](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps)
2. Add `http://localhost:3001/api/auth/outlook/callback` as redirect URI
3. Add permissions: `Mail.ReadWrite`, `Mail.Send`, `User.Read`
4. Create a client secret
5. Copy Client ID and Secret to `backend/.env`

## Architecture

```
hermes/
├── electron/          # Electron desktop wrapper
│   └── main.js        # Starts backend + opens app window
├── backend/           # Node.js + Express
│   ├── server.js
│   ├── routes/
│   │   ├── auth.js    # OAuth + account management
│   │   ├── emails.js  # Email CRUD
│   │   └── ai.js      # Claude AI endpoint
│   └── services/
│       ├── gmailService.js
│       ├── outlookService.js
│       ├── imapService.js
│       └── aiService.js
└── frontend/          # React + TypeScript + Vite + Tailwind
    └── src/
        ├── App.tsx
        ├── components/
        │   ├── HermesLogo.tsx    # SVG logo
        │   ├── Sidebar.tsx
        │   ├── EmailList.tsx
        │   ├── EmailViewer.tsx
        │   ├── ComposeModal.tsx
        │   └── AccountModal.tsx
        ├── store/emailStore.ts
        └── api/client.ts
```

## Security Notes

- Account credentials are stored in `backend/accounts.json` — this file is in `.gitignore` and should never be committed
- The `.env` file with your API keys is also in `.gitignore`
- For production use, add database encryption and HTTPS
- The AI button sends your email draft to Claude API — [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy) applies
