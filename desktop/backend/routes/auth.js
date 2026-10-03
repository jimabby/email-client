const express = require('express');
const router = express.Router();
const store = require('../store');
const { SECRET_FIELDS } = require('../services/secretStore');
const { createOAuthState, verifyOAuthState } = require('../middleware/oauthState');
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';

function redirectToFrontend(res, params = {}) {
  const target = new URL(FRONTEND_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  });
  return res.redirect(target.toString());
}

// ─── ACCOUNTS ───────────────────────────────────────────────────────────────

// Every field the secret store seals is also never sent to a client. Naming
// the fields by hand here missed smtpPassword; one list cannot drift.
function publicAccount(account) {
  const safe = { ...account };
  for (const field of SECRET_FIELDS) delete safe[field];
  delete safe.msalHomeAccountId;
  // What actually happens, not just the stored override, so the settings
  // toggle shows the default correctly.
  if (account.type === 'imap') {
    safe.sentCopyEffective = require('../services/imapService')._internals.shouldSaveSentCopy(account);
  }
  return safe;
}

// List all accounts (strip sensitive credentials for client)
router.get('/accounts', (req, res) => {
  res.json(store.getAccounts().map(publicAccount));
});

// Restart the arrival watcher so it picks up changed credentials.
async function rewatch(accountId) {
  try {
    const watch = require('../services/mailWatchService');
    await watch.stopWatch(accountId);
    watch.ensureWatch(accountId);
  } catch { /* watch is best-effort */ }
}

// PATCH /api/auth/accounts/:id — update an IMAP account's password (the
// "Reconnect" path after the server stopped accepting the old one) or its
// display name. The connection is tested before anything is saved.
router.patch('/accounts/:id', async (req, res) => {
  const account = store.getAccount(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const updates = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) updates.name = req.body.name.trim().slice(0, 120);

  // IMAP only: whether sent mail is also APPENDed to the Sent folder. null
  // restores the default (on, unless the SMTP host files its own copy).
  if ('saveSentCopy' in (req.body || {})) {
    if (account.type !== 'imap') return res.status(400).json({ error: 'Only IMAP accounts need a Sent copy saved' });
    const value = req.body.saveSentCopy;
    if (value !== true && value !== false && value !== null) return res.status(400).json({ error: 'saveSentCopy must be true, false, or null' });
    updates.saveSentCopy = value;
  }

  if (typeof req.body?.password === 'string' && req.body.password) {
    if (account.type !== 'imap') return res.status(400).json({ error: 'Only IMAP accounts have a password; reconnect OAuth accounts by signing in again' });
    try {
      await require('../services/imapService').testConnection({ ...account, password: req.body.password });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    updates.password = req.body.password;
    updates.authError = null;
  }

  const updated = store.updateAccount(account.id, updates);
  if (updates.password) {
    try { await require('../services/imapService').closeConnection(account.id); } catch { /* reconnects lazily */ }
    await rewatch(account.id);
  }
  res.json({ success: true, account: publicAccount(updated) });
});

// Add IMAP account
router.post('/accounts/imap', async (req, res) => {
  const {
    email, name, password, imapHost, imapPort, imapSecure,
    smtpHost, smtpPort, smtpSecure, allowInsecureTLS,
  } = req.body;

  if (!email || !password || !imapHost || !smtpHost) {
    return res.status(400).json({ error: 'email, password, imapHost, and smtpHost are required' });
  }

  // A second copy of the same mailbox doubles every notification and rule run.
  const duplicate = store.getAccounts().find(a => a.type === 'imap'
    && String(a.email).toLowerCase() === String(email).toLowerCase()
    && String(a.imapHost).toLowerCase() === String(imapHost).toLowerCase());
  if (duplicate) {
    return res.status(409).json({ error: `${email} is already connected. Use Reconnect to update its password.` });
  }

  // Test connection
  try {
    const imapService = require('../services/imapService');
    await imapService.testConnection({ email, password, imapHost, imapPort, imapSecure, allowInsecureTLS: allowInsecureTLS === true });
  } catch (err) {
    return res.status(400).json({ error: `Connection failed: ${err.message}` });
  }

  const account = store.addAccount({
    type: 'imap',
    email,
    name: name || email,
    password,
    imapHost,
    imapPort: imapPort || 993,
    imapSecure: imapSecure !== false,
    smtpHost,
    smtpPort: smtpPort || 587,
    smtpSecure: smtpSecure || false,
    // Opt-in only: skipping certificate validation exposes the password and
    // every outgoing message to interception.
    allowInsecureTLS: allowInsecureTLS === true,
  });

  try { require('../services/mailWatchService').ensureWatch(account); } catch { /* watch is best-effort */ }

  res.json({ success: true, account: publicAccount(account) });
});

// Delete account
router.delete('/accounts/:id', async (req, res) => {
  const ok = store.removeAccount(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Account not found' });
  // Close any cached IMAP connection for this account
  try {
    const imapService = require('../services/imapService');
    await imapService.closeConnection(req.params.id);
  } catch {}
  try {
    const { stopWatch } = require('../services/mailWatchService');
    await stopWatch(req.params.id);
  } catch {}
  // Removing an account must also remove its mail from the local search index,
  // otherwise deleted mailboxes stay searchable.
  try { require('../services/searchIndexService').removeAccount(req.params.id); } catch {}
  res.json({ success: true });
});

// ─── GMAIL OAUTH ──────────────────────────────────────────────────────────

router.get('/gmail', (req, res) => {
  if (!process.env.GMAIL_CLIENT_ID) {
    return res.status(400).json({ error: 'Gmail OAuth not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env' });
  }
  try {
    const gmailService = require('../services/gmailService');
    const url = gmailService.getAuthUrl(createOAuthState('gmail'));
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gmail/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (!verifyOAuthState(state, 'gmail')) {
    return res.status(400).json({ error: 'Invalid or expired OAuth state' });
  }

  if (error) {
    return redirectToFrontend(res, { error });
  }

  try {
    const gmailService = require('../services/gmailService');
    const { tokens, email, name } = await gmailService.handleCallback(code);

    // Check if account already exists
    const existing = store.getAccounts().find(a => a.email === email && a.type === 'gmail');
    if (existing) {
      store.updateAccount(existing.id, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || existing.refreshToken,
        expiryDate: tokens.expiry_date,
        // Signing in again is how a revoked grant is fixed.
        authError: null,
      });
      await rewatch(existing.id);
    } else {
      store.addAccount({
        type: 'gmail',
        email,
        name,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date
      });
    }

    try {
      const created = store.getAccounts().find(a => a.email === email && a.type === 'gmail');
      require('../services/mailWatchService').ensureWatch(created);
    } catch { /* watch is best-effort */ }
    redirectToFrontend(res, { auth: 'gmail', success: 'true' });
  } catch (err) {
    console.error('Gmail callback error:', err);
    redirectToFrontend(res, { error: err.message });
  }
});

// ─── OUTLOOK OAUTH ────────────────────────────────────────────────────────

router.get('/outlook', async (req, res) => {
  if (!process.env.OUTLOOK_CLIENT_ID) {
    return res.status(400).json({ error: 'Outlook OAuth not configured. Set OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET in .env' });
  }
  try {
    const outlookService = require('../services/outlookService');
    const url = await outlookService.getAuthUrl(createOAuthState('outlook'));
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/outlook/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (!verifyOAuthState(state, 'outlook')) {
    return res.status(400).json({ error: 'Invalid or expired OAuth state' });
  }

  if (error) {
    return redirectToFrontend(res, { error });
  }

  try {
    const outlookService = require('../services/outlookService');
    const { accessToken, msalHomeAccountId, msalTokenCache, email, name } = await outlookService.handleCallback(code);

    const existing = store.getAccounts().find(a => a.email === email && a.type === 'outlook');
    if (existing) {
      store.updateAccount(existing.id, { accessToken, msalHomeAccountId, msalTokenCache, authError: null });
      await rewatch(existing.id);
    } else {
      store.addAccount({
        type: 'outlook',
        email,
        name,
        accessToken,
        msalHomeAccountId,
        msalTokenCache
      });
    }

    try {
      const created = store.getAccounts().find(a => a.email === email && a.type === 'outlook');
      require('../services/mailWatchService').ensureWatch(created);
    } catch { /* watch is best-effort */ }
    redirectToFrontend(res, { auth: 'outlook', success: 'true' });
  } catch (err) {
    console.error('Outlook callback error:', err);
    redirectToFrontend(res, { error: err.message });
  }
});

module.exports = router;
