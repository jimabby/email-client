# Cloud deployment

This is the recommended mobile architecture: the Node backend runs continuously
on a small VPS, preserving Gmail, Outlook, IMAP/SMTP, snooze, queued sends,
reports, and AI features. The phone no longer depends on the desktop being on.

## VPS setup

Prerequisites: a Linux VPS with Docker Compose, ports 80/443 open, and a DNS
record pointing `mail.example.com` to the VPS.

1. Copy this repository to the VPS.
2. Copy `deploy/.env.example` to `deploy/.env` and replace every placeholder.
3. Generate `API_TOKEN`, `SESSION_SECRET`, and `WEBHOOK_CLIENT_STATE` separately
   with `openssl rand -hex 32`.
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
tokens. Transfer it over an encrypted channel, then copy it into the private
Docker volume (never commit it):

```sh
docker compose cp /secure/path/accounts.json backend:/data/accounts.json
docker compose restart backend
```

Keep a protected backup of this file. The `hermes-data` volume also persists
snoozes, send queues, settings, and cached metadata across container upgrades.

## Connect the phone

In Hermes mobile Settings, enter `https://mail.example.com` and the exact
`API_TOKEN` from `deploy/.env`, then tap **Test connection**. A wrong or missing
token returns HTTP 401.

For a managed container host, build `desktop/backend/Dockerfile`, mount a
persistent disk at `/data`, set the same environment variables, and use the
host's HTTPS URL. Background schedulers require an always-on instance; services
that sleep on idle will delay snooze and queued-send jobs.
