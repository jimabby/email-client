const express = require('express');
const router = express.Router();
const store = require('../store');
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';

function redirectToFrontend(res, params = {}) {
  const target = new URL(FRONTEND_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  });
  return res.redirect(target.toString());
}

// ─── ACCOUNTS ───────────────────────────────────────────────────────────────

// List all accounts (strip sensitive credentials for client)
router.get('/accounts', (req, res) => {
  const accounts = store.getAccounts().map(({ password, accessToken, refreshToken, ...safe }) => safe);
  res.json(accounts);
});

// Add IMAP account
router.post('/accounts/imap', async (req, res) => {
  const { email, name, password, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure } = req.body;

  if (!email || !password || !imapHost || !smtpHost) {
    return res.status(400).json({ error: 'email, password, imapHost, and smtpHost are required' });
  }

  // Test connection
  try {
    const imapService = require('../services/imapService');
    await imapService.testConnection({ email, password, imapHost, imapPort, imapSecure });
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
    smtpSecure: smtpSecure || false
  });

  const { password: _, ...safe } = account;
  res.json({ success: true, account: safe });
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
  res.json({ success: true });
});

// ─── GMAIL OAUTH ──────────────────────────────────────────────────────────

router.get('/gmail', (req, res) => {
  if (!process.env.GMAIL_CLIENT_ID) {
    return res.status(400).json({ error: 'Gmail OAuth not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env' });
  }
  try {
    const gmailService = require('../services/gmailService');
    const url = gmailService.getAuthUrl();
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gmail/callback', async (req, res) => {
  const { code, error } = req.query;

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
        refreshToken: tokens.refresh_token || existing.refreshToken
      });
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
    const url = await outlookService.getAuthUrl();
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/outlook/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return redirectToFrontend(res, { error });
  }

  try {
    const outlookService = require('../services/outlookService');
    const { accessToken, refreshToken, accountId, email, name } = await outlookService.handleCallback(code);

    const existing = store.getAccounts().find(a => a.email === email && a.type === 'outlook');
    if (existing) {
      store.updateAccount(existing.id, { accessToken, refreshToken });
    } else {
      store.addAccount({
        type: 'outlook',
        email,
        name,
        accessToken,
        refreshToken,
        msAccountId: accountId
      });
    }

    redirectToFrontend(res, { auth: 'outlook', success: 'true' });
  } catch (err) {
    console.error('Outlook callback error:', err);
    redirectToFrontend(res, { error: err.message });
  }
});

module.exports = router;
