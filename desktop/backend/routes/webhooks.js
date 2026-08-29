const express = require('express');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const router = express.Router();
const store = require('../store');
// handleNewMail — NOT the SSE-only emitter. A push notification is a real
// arrival: it has to index the message, run the rules, raise the notification,
// and refresh the badge, exactly as the IMAP and polling paths do. Wiring this
// to the emitter instead meant push-configured accounts silently lost all four.
const { handleNewMail } = require('../services/mailWatchService');

// When GMAIL_PUBSUB_SA_EMAIL is set, require a valid Google-signed OIDC token
// on Gmail push requests so only Google's Pub/Sub can trigger refreshes.
// Configure the push subscription with an OIDC service-account token whose
// audience is the webhook URL (or GMAIL_PUBSUB_AUDIENCE). Left unset, the
// endpoint stays open (spurious refreshes only) to preserve existing setups.
const oidcClient = new OAuth2Client();

async function verifyGmailPush(req) {
  const expectedEmail = process.env.GMAIL_PUBSUB_SA_EMAIL;
  if (!expectedEmail) return true; // verification not configured
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return false;
  try {
    const audience = process.env.GMAIL_PUBSUB_AUDIENCE || undefined;
    const ticket = await oidcClient.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    return payload?.email_verified === true && payload.email === expectedEmail;
  } catch {
    return false;
  }
}

// Constant-time compare that also fails closed: an unset WEBHOOK_CLIENT_STATE
// used to make `event.clientState !== undefined` false for a payload that
// omitted the field, so an unconfigured server accepted anything.
function clientStateMatches(received) {
  const expected = process.env.WEBHOOK_CLIENT_STATE;
  if (!expected) return false;
  const a = Buffer.from(String(received ?? ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/gmail', async (req, res) => {
  if (!(await verifyGmailPush(req))) return res.status(403).end();
  // Acknowledge immediately: Pub/Sub retries on a slow response, and the
  // refresh below can take seconds against a large mailbox.
  res.status(204).end();
  try {
    const encoded = req.body?.message?.data;
    const event = encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : {};
    const account = store.getAccounts().find(a => a.type === 'gmail' && a.email?.toLowerCase() === String(event.emailAddress || '').toLowerCase());
    if (account) {
      handleNewMail(account.id, { source: 'gmail-pubsub', historyId: event.historyId })
        .catch(err => console.warn('[webhook] Gmail refresh failed:', err.message));
    }
  } catch { /* a malformed push is not worth failing the response over */ }
});

router.post('/outlook', (req, res) => {
  if (req.query.validationToken) return res.type('text/plain').send(req.query.validationToken);
  res.status(202).end();

  for (const event of req.body?.value || []) {
    if (!clientStateMatches(event.clientState)) continue;
    const providerId = event.resourceData?.id || String(event.resource || '').split('/').pop();
    // Graph notification payloads don't include the mailbox; subscriptions are
    // one per account. Match a persisted subscription id when available, else
    // notify all Outlook accounts (each performs a cheap refresh).
    const matches = store.getAccounts().filter(a => a.type === 'outlook' && (!a.graphSubscriptionId || a.graphSubscriptionId === event.subscriptionId));
    for (const account of matches) {
      handleNewMail(account.id, { source: 'outlook-webhook', providerId })
        .catch(err => console.warn('[webhook] Outlook refresh failed:', err.message));
    }
  }
});

module.exports = router;
