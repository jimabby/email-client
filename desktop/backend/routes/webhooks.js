const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const router = express.Router();
const store = require('../store');
const { notifyNewMail } = require('../services/mailWatchService');

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

router.post('/gmail', async (req, res) => {
  if (!(await verifyGmailPush(req))) return res.status(403).end();
  try {
    const encoded = req.body?.message?.data;
    const event = encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : {};
    const account = store.getAccounts().find(a => a.type === 'gmail' && a.email?.toLowerCase() === String(event.emailAddress || '').toLowerCase());
    if (account) notifyNewMail(account.id, { source: 'gmail-pubsub', historyId: event.historyId });
  } catch {}
  res.status(204).end();
});

router.post('/outlook', (req, res) => {
  if (req.query.validationToken) return res.type('text/plain').send(req.query.validationToken);
  for (const event of req.body?.value || []) {
    if (event.clientState !== process.env.WEBHOOK_CLIENT_STATE) continue;
    const providerId = event.resourceData?.id || String(event.resource || '').split('/').pop();
    // Graph notification payloads don't include the mailbox; subscriptions are
    // one per account. Match a persisted subscription id when available, else
    // notify all Outlook accounts (each client performs a cheap refresh).
    const matches = store.getAccounts().filter(a => a.type === 'outlook' && (!a.graphSubscriptionId || a.graphSubscriptionId === event.subscriptionId));
    for (const account of matches) notifyNewMail(account.id, { source: 'outlook-webhook', providerId });
  }
  res.status(202).end();
});

module.exports = router;
