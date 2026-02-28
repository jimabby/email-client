const express = require('express');
const router = express.Router();
const store = require('../store');

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
      // emailId is the Gmail message ID (without accountId prefix)
      const gmailId = emailId.includes('-') ? emailId.split('-').slice(1).join('-') : emailId;
      body = await service.fetchEmailBody(account, gmailId);
    } else if (account.type === 'outlook') {
      const outlookId = emailId.includes('-') ? emailId.split('-').slice(1).join('-') : emailId;
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
          const gmailId = emailId.includes('-') ? emailId.split('-').slice(1).join('-') : emailId;
          await service.markAsRead(account, gmailId);
        } else if (account.type === 'outlook') {
          const outlookId = emailId.includes('-') ? emailId.split('-').slice(1).join('-') : emailId;
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

  const { to, cc, bcc, subject, text, html } = req.body;

  if (!to || !subject) {
    return res.status(400).json({ error: 'to and subject are required' });
  }

  try {
    const service = getService(account.type);
    await service.sendEmail(account, { to, cc, bcc, subject, text, html });
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
    if (account.type === 'imap') {
      const service = require('../services/imapService');
      const parts = req.params.emailId.split('::');
      const uid = parseInt(parts[1]);
      const folder = req.query.folder || 'INBOX';
      await service.deleteEmail(account, uid, folder);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
