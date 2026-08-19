const express = require('express');
const router = express.Router();
const store = require('../store');
const { categorizeEmails, VALID_CATEGORIES } = require('../services/categorizationService');
const { categorizeEmailsWithAI } = require('../services/aiService');
const { createQueuedSend, cancelQueuedSend, retryQueuedSend, listOutbox } = require('../services/sendQueueService');
const { ensureWatch, subscribe, getUnreadCounts, invalidateCounts } = require('../services/mailWatchService');
const searchIndex = require('../services/searchIndexService');
const rulesService = require('../services/rulesService');
const { v4: uuidv4 } = require('uuid');

function getService(accountType) {
  if (accountType === 'gmail') return require('../services/gmailService');
  if (accountType === 'outlook') return require('../services/outlookService');
  return require('../services/imapService');
}

// Extract provider-specific ID from composite email IDs.
// Gmail/Outlook: "{uuid}-{msgId}" — UUID is 36 chars (8-4-4-4-12), followed by '-'
// IMAP:          "{accountId}::{uid}"
function gmailOrOutlookId(emailId) {
  // UUID v4 is always 36 characters long. The provider message ID starts at index 37.
  if (emailId.length > 37 && emailId[36] === '-') {
    return emailId.slice(37);
  }
  // Fallback: split on '-' and skip the 5 UUID segments
  return emailId.split('-').slice(5).join('-');
}
function imapUid(emailId) {
  const parts = emailId.split('::');
  return parseInt(parts[parts.length - 1]);
}

// Attachment entries carry provider handles used only by the download
// endpoint. Strip them so ids and inline bytes never reach the client.
function publicBody(body) {
  if (!body) return body;
  return {
    ...body,
    attachments: (body.attachments || []).map(({ attachmentId, inlineData, graphAttachmentId, ...rest }) => rest),
  };
}

// ─── Static routes ──────────────────────────────────────────────────────────
// Everything with a fixed first segment MUST be declared before the
// '/:accountId' wildcard below, or Express matches the literal as an account id.

// GET /api/emails/stream/:accountId (SSE for near real-time updates)
router.get('/stream/:accountId', (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  ensureWatch(account);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: 'ready', accountId: account.id })}\n\n`);

  const unsubscribe = subscribe((evt) => {
    if (evt.accountId !== account.id) return;
    res.write(`data: ${JSON.stringify({ type: 'new-mail', ...evt })}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'ping', at: new Date().toISOString() })}\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// GET /api/emails/unread-counts?folders=INBOX,Sent
// Real per-folder unread totals from the provider, not a count of the page the
// client happens to have loaded.
router.get('/unread-counts', async (req, res) => {
  const folders = String(req.query.folders || 'INBOX').split(',').map(f => f.trim()).filter(Boolean);
  try {
    res.json(await getUnreadCounts({ folders }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emails/search-index?q=...&accountId=&folder=&limit=
// Instant local search across every indexed message and account.
router.get('/search-index', (req, res) => {
  const query = String(req.query.q || '');
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const hits = searchIndex.search(query, {
    accountId: req.query.accountId || null,
    folder: req.query.folder || null,
    limit,
  });
  res.json({ emails: hits.map(searchIndex.toSummary), stats: searchIndex.stats() });
});

// GET /api/emails/search-all?q=...&folder=INBOX&limit=50
// Local index first (instant, cross-account), then the providers to catch
// anything not yet indexed. Results are merged and de-duplicated.
router.get('/search-all', async (req, res) => {
  const query = req.query.q || '';
  const folder = req.query.folder || 'INBOX';
  const limit = parseInt(req.query.limit) || 50;

  try {
    const accounts = store.getAccounts();
    if (!accounts.length) return res.json([]);

    const local = searchIndex.search(query, { limit }).map(searchIndex.toSummary);

    const remote = await Promise.all(accounts.map(async (account) => {
      try {
        const service = getService(account.type);
        if (account.type === 'imap') {
          return await service.searchEmails(account, query, folder, limit);
        }
        return await service.searchEmails(account, query, limit);
      } catch {
        return [];
      }
    }));

    const merged = new Map();
    for (const email of [...local, ...remote.flat()]) {
      if (email?.id && !merged.has(email.id)) merged.set(email.id, email);
    }
    const results = Array.from(merged.values());
    results.sort((a, b) => {
      const ta = Date.parse(a.date || '');
      const tb = Date.parse(b.date || '');
      return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
    });
    res.json(results.slice(0, limit));
  } catch (err) {
    console.error('Search-all emails error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emails/search-attachments-all?q=...&type=...&folder=INBOX&limit=50
router.get('/search-attachments-all', async (req, res) => {
  const query = req.query.q || '';
  const type = req.query.type || '';
  const folder = req.query.folder || 'INBOX';
  const limit = parseInt(req.query.limit) || 50;

  try {
    const accounts = store.getAccounts();
    if (!accounts.length) return res.json([]);

    const results = await Promise.all(accounts.map(async (account) => {
      try {
        const service = getService(account.type);
        if (!service.searchAttachments) return [];
        return await service.searchAttachments(account, query, type, folder, limit);
      } catch {
        return [];
      }
    }));

    const merged = results.flat();
    merged.sort((a, b) => {
      const ta = Date.parse(a.date || '');
      const tb = Date.parse(b.date || '');
      return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
    });
    res.json(merged.slice(0, limit));
  } catch (err) {
    console.error('Search-attachments-all error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emails/snoozed — list all active (not-yet-due) snoozes across accounts.
router.get('/snoozed', (req, res) => {
  res.json(store.getSnoozes());
});

// GET /api/emails/daily-report — one-shot: returns and clears the pending report
router.get('/daily-report', (req, res) => {
  const report = store.getPendingReport();
  if (report) store.clearPendingReport();
  res.json(report || null);
});

// ─── Outbox ─────────────────────────────────────────────────────────────────

// Every queued, retrying, failed, and recently sent message.
router.get('/outbox', (req, res) => res.json(listOutbox()));

router.post('/outbox/:jobId/retry', (req, res) => {
  try {
    res.json({ success: true, job: retryQueuedSend(req.params.jobId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/outbox/:jobId/cancel', (req, res) => {
  try {
    res.json({ success: true, job: cancelQueuedSend(req.params.jobId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/outbox/:jobId', (req, res) => {
  res.json({ success: store.removeSendQueueItem(req.params.jobId) });
});

// ─── Rules & templates ──────────────────────────────────────────────────────

router.get('/rules', (req, res) => res.json(store.getRules()));

router.put('/rules', (req, res) => {
  const rules = rulesService.sanitizeRules(req.body.rules);
  store.saveRules(rules);
  res.json(rules);
});

// Preview which of the supplied emails a candidate rule would match — no
// action is taken, so the user can check a rule before enabling it.
router.post('/rules/preview', (req, res) => {
  const emails = Array.isArray(req.body.emails) ? req.body.emails.slice(0, 500) : [];
  res.json({ matched: rulesService.previewRule(req.body.rule || {}, emails) });
});

// Run the stored rules over a batch of messages. Rules also run automatically
// server-side on arrival; this is the manual "apply to existing mail" path.
router.post('/rules/run', async (req, res) => {
  const emails = Array.isArray(req.body.emails) ? req.body.emails.slice(0, 200) : [];
  try {
    const result = await rulesService.applyRules(emails, { force: req.body.force === true });
    if (result.applied.length) invalidateCounts();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/rules/schema', (req, res) => res.json({
  fields: rulesService.FIELDS,
  operators: rulesService.OPS,
  actions: rulesService.ACTIONS,
}));

router.get('/templates', (req, res) => res.json(store.getTemplates()));
router.put('/templates', (req, res) => {
  const templates = (Array.isArray(req.body.templates) ? req.body.templates : []).slice(0, 100).map(t => ({
    id: t.id || uuidv4(), name: String(t.name || 'Template').slice(0, 80), subject: String(t.subject || '').slice(0, 300), body: String(t.body || '').slice(0, 50000)
  }));
  store.saveTemplates(templates); res.json(templates);
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
    // The AI may omit some ids from its response. Fill any gaps with the
    // rule-based categorizer so every requested email gets cached — otherwise
    // the missing ones default to 'Primary' and are re-sent to the AI forever.
    const missing = uncached.filter(e => !fresh[e.id]);
    if (missing.length) Object.assign(fresh, categorizeEmails(missing));
    store.saveEmailCategories(fresh);
    Object.assign(cached, fresh);
  }

  const result = {};
  for (const e of emails) result[e.id] = cached[e.id] || 'Primary';
  res.json({ categories: result });
});

// POST /api/emails/trigger-report — force-run the daily report immediately.
// It sends real mail, so it stays a development-only affordance.
router.post('/trigger-report', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.HERMES_ALLOW_TRIGGER_REPORT !== 'true') {
    return res.status(403).json({ error: 'Disabled in production. Set HERMES_ALLOW_TRIGGER_REPORT=true to allow.' });
  }
  const { runDailyReport } = require('../services/reportService');
  store.saveLastReportDate(''); // reset so it runs
  try {
    await runDailyReport();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Per-account routes ─────────────────────────────────────────────────────

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
    store.saveEmailCache(`list:${account.id}:${folder}:${pageToken || ''}`, result);
    searchIndex.indexSummaries(result.emails || []);
    res.json(result); // { emails, nextToken }
  } catch (err) {
    console.error('Fetch emails error:', err);
    const cached = store.getEmailCache(`list:${account.id}:${folder}:${pageToken || ''}`);
    if (cached) return res.json({ ...cached.value, offline: true, cachedAt: cached.cachedAt });
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
    // IMAP search is folder-scoped (account, query, folder, limit); Gmail/Outlook
    // search across the whole mailbox (account, query, limit).
    const emails = account.type === 'imap'
      ? await service.searchEmails(account, query, folder, limit)
      : await service.searchEmails(account, query, limit);
    res.json(emails);
  } catch (err) {
    // The local index still answers when the provider is unreachable.
    const local = searchIndex.search(query, { accountId: account.id, folder, limit });
    if (local.length) return res.json(local.map(searchIndex.toSummary));
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

// ─── Send-as aliases ────────────────────────────────────────────────────────

router.get('/:accountId/aliases', (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json(store.getAliases(account.id));
});

router.put('/:accountId/aliases', (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const aliases = (Array.isArray(req.body.aliases) ? req.body.aliases : [])
    .slice(0, 20)
    .map(a => ({
      email: String(a.email || '').trim().slice(0, 200),
      name: String(a.name || '').trim().slice(0, 120),
      isDefault: a.isDefault === true,
    }))
    .filter(a => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email));

  // Only one default makes sense.
  let seenDefault = false;
  for (const alias of aliases) {
    if (alias.isDefault && seenDefault) alias.isDefault = false;
    if (alias.isDefault) seenDefault = true;
  }

  res.json(store.saveAliases(account.id, aliases));
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
    if (account.type === 'imap') {
      body = await service.fetchEmailBody(account, imapUid(emailId), folder);
    } else {
      body = await service.fetchEmailBody(account, gmailOrOutlookId(emailId));
    }

    // Mark as read (best-effort)
    try {
      if (service.markAsRead && req.query.markRead !== 'false') {
        if (account.type === 'imap') {
          await service.markAsRead(account, imapUid(emailId), folder);
        } else {
          await service.markAsRead(account, gmailOrOutlookId(emailId));
        }
        searchIndex.setFlags(emailId, { read: true });
        invalidateCounts();
      }
    } catch { /* ignore */ }

    const clientBody = publicBody(body);
    store.saveEmailCache(`body:${account.id}:${emailId}:${folder}`, clientBody);
    searchIndex.indexBody(emailId, body);
    res.json(clientBody);
  } catch (err) {
    console.error('Fetch email body error:', err);
    const cached = store.getEmailCache(`body:${account.id}:${emailId}:${folder}`);
    if (cached) return res.json({ ...cached.value, offline: true, cachedAt: cached.cachedAt });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emails/:accountId/message/:emailId/attachment/:index
// Attachment bytes are fetched on demand and streamed straight through, so
// opening a message never has to buffer a 20 MB PDF into a JSON response.
router.get('/:accountId/message/:emailId/attachment/:index', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const index = parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid attachment index' });

  try {
    const service = getService(account.type);
    if (!service.getAttachment) return res.status(400).json({ error: 'Attachments are not supported for this account' });

    const attachment = account.type === 'imap'
      ? await service.getAttachment(account, imapUid(req.params.emailId), req.query.folder || 'INBOX', index)
      : await service.getAttachment(account, gmailOrOutlookId(req.params.emailId), index);

    const filename = String(attachment.filename || `attachment-${index}`).replace(/["\r\n]/g, '');
    const disposition = req.query.inline === 'true' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
    res.setHeader('Content-Length', attachment.content.length);
    res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    // Attachment bytes are private to this user; never let a proxy keep them.
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(attachment.content);
  } catch (err) {
    console.error('Fetch attachment error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:accountId/thread/:threadId', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const service = getService(account.type);
  if (!service.fetchThread) return res.json([]);
  try {
    const items = await service.fetchThread(account, req.params.threadId);
    for (const item of items) {
      if (item?.summary?.id) searchIndex.indexBody(item.summary.id, item.body);
    }
    res.json(items.map(item => ({ ...item, body: publicBody(item.body) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:accountId/folders', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (!String(req.body.name || '').trim()) return res.status(400).json({ error: 'Folder name is required' });
  try { res.json(await getService(account.type).createFolder(account, String(req.body.name).trim())); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:accountId/folders/:folderId', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  try { res.json(await getService(account.type).renameFolder(account, req.params.folderId, String(req.body.name || '').trim())); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/emails/:accountId/send
// Optional threading fields for replies: inReplyTo (original Message-ID),
// references (original References), threadId (Gmail), replyToEmailId +
// replyToFolder (composite id — resolved server-side when headers are absent).
router.post('/:accountId/send', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const {
    to, cc, bcc, subject, text, html, attachments, sendAt, undoWindowSec,
    inReplyTo, references, threadId, replyToEmailId, replyToFolder, sendAs,
  } = req.body;
  if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });

  // A send-as address must be one the account actually registered, or the
  // provider will reject the message (or silently rewrite the From).
  if (sendAs?.email && String(sendAs.email).toLowerCase() !== String(account.email).toLowerCase()) {
    const known = store.getAliases(account.id)
      .some(a => String(a.email).toLowerCase() === String(sendAs.email).toLowerCase());
    if (!known) return res.status(400).json({ error: `${sendAs.email} is not a configured alias for this account` });
  }

  try {
    const email = { to, cc, bcc, subject, text, html, attachments, inReplyTo, references, threadId, sendAs };

    // Threading is best-effort: resolve what the client didn't supply.
    try {
      if (replyToEmailId) {
        if (account.type === 'outlook') {
          // Outlook threads via the Graph reply endpoint, not headers.
          email.replyToProviderId = gmailOrOutlookId(replyToEmailId);
        } else if (!email.inReplyTo) {
          const service = getService(account.type);
          const meta = account.type === 'gmail'
            ? await service.getThreadingInfo(account, gmailOrOutlookId(replyToEmailId))
            : await service.getThreadingInfo(account, imapUid(replyToEmailId), replyToFolder || 'INBOX');
          if (meta) {
            email.inReplyTo = meta.inReplyTo || email.inReplyTo;
            email.references = meta.references || email.references;
            email.threadId = meta.threadId || email.threadId;
          }
        }
      }
    } catch { /* send without threading rather than failing */ }

    // Everything goes through the queue: it is what makes a send survive a
    // dropped connection, and it is what "Undo send" cancels.
    const queued = createQueuedSend({
      accountId: account.id,
      email,
      sendAt,
      undoWindowSec: Number(undoWindowSec) || 0,
    });

    return res.json({
      success: true,
      queued: true,
      jobId: queued.id,
      sendAt: queued.sendAt,
      canUndoUntil: queued.canUndoUntil,
    });
  } catch (err) {
    console.error('Send email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/emails/:accountId/drafts — save a draft to the provider's Drafts folder.
// Body: { to, cc, bcc, subject, text, html, attachments, replaceRef? }
// Returns { ref } identifying the server draft so a later save can replace it.
router.post('/:accountId/drafts', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { to, cc, bcc, subject, text, html, attachments, replaceRef } = req.body;
  try {
    const service = getService(account.type);
    if (!service.saveDraft) return res.status(400).json({ error: 'Drafts are not supported for this account' });

    // Remove the previous server copy (best-effort) so re-saving doesn't pile up.
    if (replaceRef && service.deleteDraft) {
      try { await service.deleteDraft(account, replaceRef); } catch { /* ignore */ }
    }

    const ref = await service.saveDraft(account, { to, cc, bcc, subject, text, html, attachments });
    res.json({ success: true, ref });
  } catch (err) {
    console.error('Save draft error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/emails/:accountId/drafts — remove a previously saved server draft.
// Body: { ref }
router.delete('/:accountId/drafts', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { ref } = req.body || {};
  try {
    const service = getService(account.type);
    if (ref && service.deleteDraft) await service.deleteDraft(account, ref);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emails/:accountId/search-attachments?q=...&type=...&folder=INBOX&limit=50
router.get('/:accountId/search-attachments', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const query = req.query.q || '';
  const type = req.query.type || '';
  const folder = req.query.folder || 'INBOX';
  const limit = parseInt(req.query.limit) || 50;

  try {
    const service = getService(account.type);
    if (!service.searchAttachments) {
      return res.json([]);
    }
    const emails = await service.searchAttachments(account, query, type, folder, limit);
    res.json(emails);
  } catch (err) {
    console.error('Search attachments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/emails/:accountId/send-queue/:jobId/cancel
router.post('/:accountId/send-queue/:jobId/cancel', (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const job = store.getSendQueueItem(req.params.jobId);
    if (!job || job.accountId !== account.id) {
      return res.status(404).json({ error: 'Scheduled send not found' });
    }
    const cancelled = cancelQueuedSend(req.params.jobId);
    res.json({ success: true, jobId: cancelled.id, status: cancelled.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    searchIndex.remove(req.params.emailId);
    invalidateCounts();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/emails/:accountId/message/:emailId/read
router.post('/:accountId/message/:emailId/read', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const service = getService(account.type);
    if (service.markAsRead) {
      if (account.type === 'imap') {
        await service.markAsRead(account, imapUid(req.params.emailId), req.query.folder || 'INBOX');
      } else {
        await service.markAsRead(account, gmailOrOutlookId(req.params.emailId));
      }
    }
    searchIndex.setFlags(req.params.emailId, { read: true });
    invalidateCounts();
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
    searchIndex.setFlags(req.params.emailId, { read: false });
    invalidateCounts();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:accountId/message/:emailId/spam', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  try {
    const service = getService(account.type);
    const id = account.type === 'imap' ? imapUid(req.params.emailId) : gmailOrOutlookId(req.params.emailId);
    await service.reportSpam(account, id, req.query.folder || 'INBOX');
    searchIndex.remove(req.params.emailId);
    invalidateCounts();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:accountId/message/:emailId/block', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const sender = String(req.body.sender || '').match(/<([^>]+)>/)?.[1] || String(req.body.sender || '');
  if (!sender.trim()) return res.status(400).json({ error: 'Sender is required' });

  const rules = store.getRules();
  const alreadyBlocked = rules.some(r =>
    r.accountId === account.id &&
    r.actions?.some(a => a.type === 'spam') &&
    r.conditions?.some(c => c.field === 'from' && c.value.toLowerCase() === sender.toLowerCase())
  );
  if (!alreadyBlocked) {
    rules.push(rulesService.sanitizeRule({
      name: `Block ${sender}`,
      enabled: true,
      accountId: account.id,
      match: 'all',
      conditions: [{ field: 'from', op: 'contains', value: sender.toLowerCase() }],
      actions: [{ type: 'spam' }],
      stopProcessing: true,
    }));
    store.saveRules(rules);
  }

  try {
    const service = getService(account.type);
    const id = account.type === 'imap' ? imapUid(req.params.emailId) : gmailOrOutlookId(req.params.emailId);
    await service.reportSpam(account, id, req.query.folder || 'INBOX');
    searchIndex.remove(req.params.emailId);
    invalidateCounts();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    searchIndex.setFlags(req.params.emailId, { starred: !!starred });
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
    // The message still exists, just elsewhere — drop it from the index so a
    // stale folder isn't reported, and let the next fetch re-index it.
    searchIndex.remove(req.params.emailId);
    invalidateCounts();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/emails/:accountId/message/:emailId/snooze
// Body: { until: ISO-timestamp, email?: EmailSummary }
router.post('/:accountId/message/:emailId/snooze', (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { until, email } = req.body;
  if (!until || Number.isNaN(new Date(until).getTime()) || new Date(until).getTime() <= Date.now()) {
    return res.status(400).json({ error: 'until must be a future timestamp' });
  }

  const item = store.addSnooze({
    emailId: req.params.emailId,
    accountId: account.id,
    folder: req.query.folder || email?.folder || 'INBOX',
    email: email || null,
    until: new Date(until).toISOString(),
    createdAt: new Date().toISOString(),
  });
  res.json({ success: true, snooze: item });
});

// DELETE /api/emails/:accountId/message/:emailId/snooze — wake an email early
router.delete('/:accountId/message/:emailId/snooze', (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  store.removeSnooze(req.params.emailId);
  res.json({ success: true });
});

// ─── Bulk actions ───────────────────────────────────────────────────────────

async function runBulk(emailIds, worker) {
  const results = { succeeded: 0, failed: 0, errors: [] };
  const settled = await Promise.allSettled(emailIds.map(worker));
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') results.succeeded++;
    else {
      results.failed++;
      if (results.errors.length < 5) results.errors.push(String(outcome.reason?.message || outcome.reason));
    }
  }
  return results;
}

// POST /api/emails/:accountId/bulk/delete
router.post('/:accountId/bulk/delete', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { emailIds } = req.body;
  if (!Array.isArray(emailIds) || !emailIds.length) return res.status(400).json({ error: 'emailIds array required' });

  const folder = req.query.folder || 'INBOX';
  const service = getService(account.type);

  const results = await runBulk(emailIds, async (emailId) => {
    if (account.type === 'imap') await service.deleteEmail(account, imapUid(emailId), folder);
    else await service.deleteEmail(account, gmailOrOutlookId(emailId));
    searchIndex.remove(emailId);
  });

  invalidateCounts();
  res.json({ success: results.failed === 0, ...results });
});

// POST /api/emails/:accountId/bulk/read
router.post('/:accountId/bulk/read', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { emailIds } = req.body;
  if (!Array.isArray(emailIds) || !emailIds.length) return res.status(400).json({ error: 'emailIds array required' });

  const folder = req.query.folder || 'INBOX';
  const service = getService(account.type);
  if (!service.markAsRead) return res.json({ success: true, succeeded: emailIds.length, failed: 0, errors: [] });

  const results = await runBulk(emailIds, async (emailId) => {
    if (account.type === 'imap') await service.markAsRead(account, imapUid(emailId), folder);
    else await service.markAsRead(account, gmailOrOutlookId(emailId));
    searchIndex.setFlags(emailId, { read: true });
  });

  invalidateCounts();
  res.json({ success: results.failed === 0, ...results });
});

// POST /api/emails/:accountId/bulk/unread
router.post('/:accountId/bulk/unread', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { emailIds } = req.body;
  if (!Array.isArray(emailIds) || !emailIds.length) return res.status(400).json({ error: 'emailIds array required' });

  const folder = req.query.folder || 'INBOX';
  const service = getService(account.type);

  const results = await runBulk(emailIds, async (emailId) => {
    if (account.type === 'imap') await service.markAsUnread(account, imapUid(emailId), folder);
    else await service.markAsUnread(account, gmailOrOutlookId(emailId));
    searchIndex.setFlags(emailId, { read: false });
  });

  invalidateCounts();
  res.json({ success: results.failed === 0, ...results });
});

// POST /api/emails/:accountId/bulk/move
router.post('/:accountId/bulk/move', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { emailIds, folder: toFolder } = req.body;
  if (!Array.isArray(emailIds) || !emailIds.length) return res.status(400).json({ error: 'emailIds array required' });
  if (!toFolder) return res.status(400).json({ error: 'folder is required' });

  const sourceFolder = req.query.folder || 'INBOX';
  const service = getService(account.type);

  const results = await runBulk(emailIds, async (emailId) => {
    if (account.type === 'imap') await service.moveEmail(account, imapUid(emailId), sourceFolder, toFolder);
    else if (account.type === 'gmail') await service.moveEmail(account, gmailOrOutlookId(emailId), sourceFolder, toFolder);
    else await service.moveEmail(account, gmailOrOutlookId(emailId), toFolder);
    searchIndex.remove(emailId);
  });

  invalidateCounts();
  res.json({ success: results.failed === 0, ...results });
});

module.exports = router;
