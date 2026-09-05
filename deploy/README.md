# Cloud deployment

This is the recommended mobile architecture: the Node backend runs continuously
on a small VPS, preserving Gmail, Outlook, IMAP/SMTP, snooze, queued sends,
reports, and AI features. The phone no longer depends on the desktop being on.

## VPS setup

Prerequisites: a Linux VPS with Docker Compose, ports 80/443 open, and a DNS
record pointing `mail.example.com` to the VPS.

1. Copy this repository to the VPS.
2. Copy `deploy/.env.example` to `deploy/.env` and replace every placeholder.
3. Generate `API_TOKEN`, `HERMES_SECRET_KEY`, and `WEBHOOK_CLIENT_STATE`
   separately with `openssl rand -hex 32`.

   `HERMES_SECRET_KEY` encrypts stored credentials at rest — **back it up
   somewhere safe**. If it is lost, the sealed values remain on disk untouched
   but cannot be decrypted, and every account has to be re-authorised.
4. If using OAuth, register the public HTTPS callback URLs shown in `.env` with
   Google and Microsoft.
5. Start the service:

   ```sh
   cd deploy
   docker compose up -d --build
   docker compose ps
   curl https://mail.example.com/api/health
   ```

Caddy obtains and renews HTTPS certificates automatically. The backend is not
published directly; only Caddy can reach port 3001.

## Move existing accounts

The existing `desktop/backend/accounts.json` contains credentials and OAuth
tokens, sealed with the key that machine used. Because the VPS has a different
`HERMES_SECRET_KEY`, the file has to be re-keyed rather than copied verbatim —
run this on the machine that can still read it, with its own key in the
environment:

```sh
cd desktop/backend
HERMES_SECRET_KEY=<the-old-key> node -e "
  const secrets = require('./services/secretStore');
  const fs = require('fs');
  const plain = secrets.openObject(JSON.parse(fs.readFileSync('accounts.json', 'utf8')));
  fs.writeFileSync('accounts.plain.json', JSON.stringify(plain, null, 2), { mode: 0o600 });
"
HERMES_SECRET_KEY=<the-new-vps-key> node -e "
  const secrets = require('./services/secretStore');
  const fs = require('fs');
  const plain = JSON.parse(fs.readFileSync('accounts.plain.json', 'utf8'));
  fs.writeFileSync('accounts.rekeyed.json', JSON.stringify(secrets.sealObject(plain), null, 2), { mode: 0o600 });
"
rm accounts.plain.json   # holds cleartext credentials — delete it immediately
```

On a desktop install the old key lives in the OS keychain rather than the
environment; run the first command from the app's data directory with
`HERMES_SECRET_KEY` unset only if that machine has no keychain. Otherwise it is
simpler to re-add the accounts on the server.

Transfer the re-keyed file over an encrypted channel, then copy it into the
private Docker volume (never commit it):

```sh
docker compose cp /secure/path/accounts.rekeyed.json backend:/data/accounts.json
docker compose restart backend
```

Keep a protected backup of this file. The `hermes-data` volume also persists
snoozes, send queues, settings, and cached metadata across container upgrades.

## Use it from a browser

Open `https://mail.example.com` and paste the same `API_TOKEN` when prompted.
The token is held for that tab only and is cleared when the tab closes.

The server injects the token into the page automatically for a browser running
on the server itself, which is how the desktop app authenticates; a remote
visitor is deliberately never handed it and has to enter it.

## Connect the phone

In Hermes mobile Settings, enter `https://mail.example.com` and the exact
`API_TOKEN` from `deploy/.env`, then tap **Test connection**. A wrong or missing
token returns HTTP 401.

### Notifications

Turn on **New mail notifications** in the same screen. The app asks the OS for
permission, obtains an Expo push token, and registers it with the backend over
the authenticated API — there is nothing to configure on the server, and no
platform credentials are held there. Delivery goes through Expo's push service,
which fans out to APNs and FCM.

The backend then notifies the phone from the same arrival pipeline that raises
the desktop's toasts, so notifications keep coming with the app closed and the
desktop switched off. Snoozed messages notify on waking too.

Two caveats worth knowing: push needs a physical device (a simulator has no
transport), and tokens are pruned automatically when Expo reports the app was
uninstalled.

For a managed container host, build `desktop/backend/Dockerfile`, mount a
persistent disk at `/data`, set the same environment variables, and use the
host's HTTPS URL. Background schedulers require an always-on instance; services
that sleep on idle will delay snooze and queued-send jobs.
