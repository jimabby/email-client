const express = require('express');
const router = express.Router();
const store = require('../store');
const { categorizeEmails, VALID_CATEGORIES } = require('../services/categorizationService');
const { categorizeEmailsWithAI } = require('../services/aiService');

function getService(accountType) {
  if (accountType === 'gmail') return require('../services/gmailService');
  if (accountType === 'outlook') return require('../services/outlookService');
  return require('../services/imapService');
}

// GET /api/emails/:accountId?folder=INBOX&limit=50
router.get('/:accountId', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = req.query.folder || 'INBOX';
  const limit = parseInt(req.query.limit) || 50;

  try {
    const service = getService(account.type);
    const emails = await service.fetchEmails(account, folder, limit);
    res.json(emails);
  } catch (err) {
    console.error('Fetch emails error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emails/:accountId/folders
router.get('/:accountId/folders', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const service = getService(account.type);
    if (!service.getFolders) {
      // Default folders for services that don't support listing
      return res.json([
        { name: 'Inbox', path: 'INBOX' },
        { name: 'Sent', path: 'Sent' },
        { name: 'Drafts', path: 'Drafts' },
        { name: 'Trash', path: 'Trash' }
      ]);
    }
    const folders = await service.getFolders(account);
    res.json(folders);
  } catch (err) {
    console.error('Get folders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emails/:accountId/message/:emailId
router.get('/:accountId/message/:emailId', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const emailId = req.params.emailId;

  try {
    const service = getService(account.type);

    let body;
    if (account.type === 'gmail') {
      // emailId format is "{accountUUID}-{gmailMsgId}"; UUID has 4 dashes (5 segments), so slice(5) gives the gmailMsgId
      const gmailId = emailId.split('-').slice(5).join('-');
      body = await service.fetchEmailBody(account, gmailId);
    } else if (account.type === 'outlook') {
      const outlookId = emailId.split('-').slice(5).join('-');
      body = await service.fetchEmailBody(account, outlookId);
    } else {
      // IMAP: emailId format is "accountId::uid", folder passed as ?folder= query param
      const parts = emailId.split('::');
      const uid = parseInt(parts[1]);
      const folder = req.query.folder || 'INBOX';
      body = await service.fetchEmailBody(account, uid, folder);
    }

    // Mark as read
    try {
      if (service.markAsRead) {
        if (account.type === 'gmail') {
          const gmailId = emailId.split('-').slice(5).join('-');
          await service.markAsRead(account, gmailId);
        } else if (account.type === 'outlook') {
          const outlookId = emailId.split('-').slice(5).join('-');
          await service.markAsRead(account, outlookId);
        } else {
          const parts = emailId.split('::');
          const uid = parseInt(parts[1]);
          const folder = req.query.folder || 'INBOX';
          await service.markAsRead(account, uid, folder);
        }
      }
    } catch (e) {
      // Don't fail if mark-as-read fails
    }

    res.json(body);
  } catch (err) {
    console.error('Fetch email body error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/emails/:accountId/send
router.post('/:accountId/send', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { to, cc, bcc, subject, text, html, attachments } = req.body;

  if (!to || !subject) {
    return res.status(400).json({ error: 'to and subject are required' });
  }

  try {
    const service = getService(account.type);
    await service.sendEmail(account, { to, cc, bcc, subject, text, html, attachments });
    res.json({ success: true });
  } catch (err) {
    console.error('Send email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/emails/:accountId/message/:emailId
router.delete('/:accountId/message/:emailId', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const service = getService(account.type);
    if (account.type === 'imap') {
      const parts = req.params.emailId.split('::');
      const uid = parseInt(parts[1]);
      const folder = req.query.folder || 'INBOX';
      await service.deleteEmail(account, uid, folder);
    } else if (account.type === 'gmail') {
      const gmailId = req.params.emailId.split('-').slice(5).join('-');
      await service.deleteEmail(account, gmailId);
    } else if (account.type === 'outlook') {
      const outlookId = req.params.emailId.split('-').slice(5).join('-');
      await service.deleteEmail(account, outlookId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/emails/categorize
router.post('/categorize', async (req, res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails array required' });

  const cached = store.getEmailCategories();
  // Invalidate stale entries that used old category names (Updates, Forums)
  const uncached = emails.filter(e => !cached[e.id] || !VALID_CATEGORIES.has(cached[e.id]));

  if (uncached.length) {
    // Try AI first; fall back to rule-based if no API key or AI call fails
    let fresh = await categorizeEmailsWithAI(uncached);
    if (!fresh) fresh = categorizeEmails(uncached);
    store.saveEmailCategories(fresh);
    Object.assign(cached, fresh);
  }

  const result = {};
  for (const e of emails) result[e.id] = cached[e.id] || 'Primary';
  res.json({ categories: result });
});

// GET /api/emails/daily-report — one-shot: returns and clears the pending report
router.get('/daily-report', (req, res) => {
  const report = store.getPendingReport();
  if (report) store.clearPendingReport();
  res.json(report || null);
});

module.exports = router;
