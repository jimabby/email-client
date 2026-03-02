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

// Extract provider-specific ID from composite email IDs.
// Gmail/Outlook: "{uuid}-{msgId}" — UUID has 4 dashes (5 segments) → slice(5)
// IMAP:          "{accountId}::{uid}"
function gmailOrOutlookId(emailId) {
  return emailId.split('-').slice(5).join('-');
}
function imapUid(emailId) {
  return parseInt(emailId.split('::')[1]);
}

// GET /api/emails/:accountId?folder=INBOX&limit=50&pageToken=...
router.get('/:accountId', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = req.query.folder || 'INBOX';
  const limit = parseInt(req.query.limit) || 50;
  const pageToken = req.query.pageToken || null;

  try {
    const service = getService(account.type);
    const result = await service.fetchEmails(account, folder, limit, pageToken);
    res.json(result); // { emails, nextToken }
  } catch (err) {
    console.error('Fetch emails error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emails/:accountId/search?q=...&folder=INBOX&limit=50
router.get('/:accountId/search', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const query = req.query.q || '';
  const folder = req.query.folder || 'INBOX';
  const limit = parseInt(req.query.limit) || 50;

  try {
    const service = getService(account.type);
    const emails = await service.searchEmails(account, query, folder, limit);
    res.json(emails);
  } catch (err) {
    console.error('Search emails error:', err);
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
  const folder = req.query.folder || 'INBOX';

  try {
    const service = getService(account.type);

    let body;
    if (account.type === 'gmail') {
      body = await service.fetchEmailBody(account, gmailOrOutlookId(emailId));
    } else if (account.type === 'outlook') {
      body = await service.fetchEmailBody(account, gmailOrOutlookId(emailId));
    } else {
      body = await service.fetchEmailBody(account, imapUid(emailId), folder);
    }

    // Mark as read (best-effort)
    try {
      if (service.markAsRead) {
        if (account.type === 'imap') {
          await service.markAsRead(account, imapUid(emailId), folder);
        } else {
          await service.markAsRead(account, gmailOrOutlookId(emailId));
        }
      }
    } catch { /* ignore */ }

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
  if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });

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
      await service.deleteEmail(account, imapUid(req.params.emailId), req.query.folder || 'INBOX');
    } else {
      await service.deleteEmail(account, gmailOrOutlookId(req.params.emailId));
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/emails/:accountId/message/:emailId/unread
router.post('/:accountId/message/:emailId/unread', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const service = getService(account.type);
    if (account.type === 'imap') {
      await service.markAsUnread(account, imapUid(req.params.emailId), req.query.folder || 'INBOX');
    } else {
      await service.markAsUnread(account, gmailOrOutlookId(req.params.emailId));
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/emails/:accountId/message/:emailId/star
router.post('/:accountId/message/:emailId/star', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { starred } = req.body;

  try {
    const service = getService(account.type);
    if (account.type === 'imap') {
      await service.toggleStar(account, imapUid(req.params.emailId), req.query.folder || 'INBOX', starred);
    } else {
      await service.toggleStar(account, gmailOrOutlookId(req.params.emailId), starred);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/emails/:accountId/message/:emailId/move
router.post('/:accountId/message/:emailId/move', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { folder: toFolder } = req.body;
  if (!toFolder) return res.status(400).json({ error: 'folder is required' });

  try {
    const service = getService(account.type);
    if (account.type === 'imap') {
      await service.moveEmail(account, imapUid(req.params.emailId), req.query.folder || 'INBOX', toFolder);
    } else if (account.type === 'gmail') {
      await service.moveEmail(account, gmailOrOutlookId(req.params.emailId), req.query.folder || 'INBOX', toFolder);
    } else {
      await service.moveEmail(account, gmailOrOutlookId(req.params.emailId), toFolder);
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
  const uncached = emails.filter(e => !cached[e.id] || !VALID_CATEGORIES.has(cached[e.id]));

  if (uncached.length) {
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
