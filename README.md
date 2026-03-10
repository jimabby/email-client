# Hermes — AI-Powered Email Client

A fast, dark-themed desktop/web email client for Gmail, Outlook, and any IMAP/SMTP provider. Hermes supports multiple AI providers (OpenAI, Gemini, Claude) and adds smart features like priority inbox, thread summaries, and smart unsubscribe.

## Highlights

- **Multi-account** — Gmail (OAuth), Outlook (OAuth), and any IMAP/SMTP server
- **Full email client** — read, compose, reply, forward, delete, move, star
- **AI Assist** — improve drafts with 9 modes (Improve, Concise, Complete, Fix Grammar, Formal, Friendly, Subject Ideas, Draft Reply, Custom)
- **Priority inbox (AI)** — rank emails by urgency/importance in one click
- **Thread summaries (AI)** — summarize long threads in a single click
- **Smart unsubscribe** — detects unsubscribe links and surfaces one-click action
- **Attachment search** — search by attachment name/type
- **Inline previews** — view images/PDFs without downloading
- **Saved searches** — automatically saves recent searches (with delete options)
- **Thread view** — group replies by conversation
- **Real-time updates** — SSE streaming for new mail
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
# AI provider (choose one, or change later in Settings ? AI)
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Gmail OAuth
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...

# Optional: Outlook OAuth
OUTLOOK_CLIENT_ID=...
OUTLOOK_CLIENT_SECRET=...
```

Note: In the app, go to **Settings ? AI** and select your provider + API key.

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

Works with any provider. Click **Add Account ? IMAP/SMTP**.

**Gmail with App Password:**
1. Enable 2FA on your Google account
2. Google Account ? Security ? App Passwords ? create one
3. Use that 16-character password in the IMAP tab
4. Settings: IMAP `imap.gmail.com:993`, SMTP `smtp.gmail.com:587`

**Outlook.com / Hotmail:**
- IMAP `outlook.office365.com:993`, SMTP `smtp.office365.com:587`

**Yahoo Mail:**
- Generate an App Password in Yahoo Account Security settings

### Gmail OAuth

1. Create a project at Google Cloud Console
2. Enable the **Gmail API**
3. Create OAuth 2.0 credentials (Web Application)
4. Add `http://localhost:3001/api/auth/gmail/callback` as redirect URI
5. Add your Google account as a **Test User** in OAuth consent screen
6. Copy Client ID and Secret to `backend/.env`

### Outlook OAuth

1. Register an app at Azure Portal
2. Add `http://localhost:3001/api/auth/outlook/callback` as redirect URI
3. Add permissions: `Mail.ReadWrite`, `Mail.Send`, `User.Read`
4. Create a client secret
5. Copy Client ID and Secret to `backend/.env`

## AI Features — Where to Find Them

- **Priority inbox**: list header toggle (right side)
- **Thread summary**: “Summarize” button in the email viewer toolbar
- **Smart unsubscribe**: “Unsubscribe” button appears in viewer when detected
- **AI draft assist**: Compose window ? AI Assist

## Architecture

```
hermes/
+-- electron/          # Electron desktop wrapper
¦   +-- main.js        # Starts backend + opens app window
+-- backend/           # Node.js + Express
¦   +-- server.js
¦   +-- routes/
¦   ¦   +-- auth.js    # OAuth + account management
¦   ¦   +-- emails.js  # Email CRUD
¦   ¦   +-- ai.js      # AI endpoints
¦   +-- services/
¦       +-- gmailService.js
¦       +-- outlookService.js
¦       +-- imapService.js
¦       +-- aiService.js
+-- frontend/          # React + TypeScript + Vite + Tailwind
    +-- src/
        +-- App.tsx
        +-- components/
        ¦   +-- HermesLogo.tsx
        ¦   +-- Sidebar.tsx
        ¦   +-- EmailList.tsx
        ¦   +-- EmailViewer.tsx
        ¦   +-- ComposeModal.tsx
        ¦   +-- AccountModal.tsx
        +-- store/emailStore.ts
        +-- api/client.ts
```

## Security Notes

- Account credentials are stored in `backend/accounts.json` — this file is in `.gitignore` and should never be committed
- The `.env` file with your API keys is also in `.gitignore`
- For production use, add database encryption and HTTPS
- AI features send email data to the selected provider. Review the provider’s privacy policy.
