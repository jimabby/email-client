const express = require('express');
const router = express.Router();
const store = require('../store');
const { notifyNewMail } = require('../services/mailWatchService');

router.post('/gmail', (req, res) => {
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
