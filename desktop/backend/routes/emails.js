const express = require('express');
const router = express.Router();
const store = require('../store');
const { categorizeEmails, VALID_CATEGORIES } = require('../services/categorizationService');
const { categorizeEmailsWithAI } = require('../services/aiService');
const { createQueuedSend, cancelQueuedSend, retryQueuedSend, listOutbox } = require('../services/sendQueueService');
const { ensureWatch, subscribe, getUnreadCounts, invalidateCounts } = require('../services/mailWatchService');
const searchIndex = require('../services/searchIndexService');
const rulesService = require('../services/rulesService');
const contactsService = require('../services/contactsService');
const vacationService = require('../services/vacationService');
const exportService = require('../services/exportService');
const calendarService = require('../services/calendarService');
const downloadTickets = require('../services/downloadTicketService');
const pushService = require('../services/pushService');
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

/**
 * Rebuild the client-facing composite id after a provider-side move.
 *
 * Gmail keeps a message's id across a label change, but Outlook mints a new one
 * and IMAP assigns a fresh UID in the destination mailbox. An "Undo" that sent
 * back the old id would address nothing, so the move routes hand the caller the
 * id the message has *now*.
 *
 * @returns {string|null} the new composite id, or null when it is unchanged or
 *          the provider did not tell us (an IMAP server without UIDPLUS).
 */
function recomposeId(account, previousId, moveResult) {
  if (!moveResult) return null;
  if (account.type === 'imap') {
    return moveResult.uid ? `${account.id}::${moveResult.uid}` : null;
  }
  if (!moveResult.id) return null;
  const previousProviderId = gmailOrOutlookId(previousId);
  if (moveResult.id === previousProviderId) return null;
  return `${account.id}-${moveResult.id}`;
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

// Types a browser renders without any chance of executing script. Anything
// else — text/html, image/svg+xml, application/xhtml+xml — is forced to a
// download, whatever the sender labelled it or named the file.
const INLINE_SAFE_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4',
  'video/mp4', 'video/webm', 'video/ogg',
]);

/** @returns {string|null} the safe type to serve inline, or null to force download. */
function safeInlineType(contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  return INLINE_SAFE_TYPES.has(base) ? base : null;
}

/**
 * Write attachment bytes to the response.
 *
 * Both the authenticated route and the single-use ticket route go through here
 * so the content-type allowlist and the sandbox headers can never drift apart
 * between them — the ticket path is the one reachable without the API token,
 * so it is the one that most needs them.
 */
function sendAttachment(res, attachment, index, wantsInlineRequested) {
  const filename = String(attachment.filename || `attachment-${index}`).replace(/["\r\n]/g, '');
  // The declared type comes from the sender. Serving it back verbatim with
  // Content-Disposition: inline would let a message render attacker HTML on
  // this origin — the same origin as the app, which holds the API token. Only
  // types that cannot execute script are ever shown inline.
  const declared = safeInlineType(attachment.contentType);
  const wantsInline = wantsInlineRequested && declared !== null;
  const disposition = wantsInline ? 'inline' : 'attachment';

  res.setHeader('Content-Type', wantsInline ? declared : 'application/octet-stream');
  res.setHeader('Content-Length', attachment.content.length);
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  // Defence in depth: even for an allowlisted type, deny the response its own
  // origin, scripts, and plugins, so a parser quirk cannot become execution.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; object-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Attachment bytes are private to this user; never let a proxy keep them.
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(attachment.content);
}

/** Pull one attachment's bytes, whichever provider the account uses. */
async function loadAttachment(account, emailId, index, folder) {
  const service = getService(account.type);
  if (!service.getAttachment) throw new Error('Attachments are not supported for this account');
  return account.type === 'imap'
    ? service.getAttachment(account, imapUid(emailId), folder || 'INBOX', index)
    : service.getAttachment(account, gmailOrOutlookId(emailId), index);
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

// ─── Mobile push registration ───────────────────────────────────────────────
// The arrival pipeline already indexes, runs rules, and notifies the desktop
// shell; these let a phone subscribe to the same events.

// POST /api/emails/devices — register (or refresh) this device's push token.
// Body: { token, platform, accountIds? }
router.post('/devices', (req, res) => {
  try {
    const device = pushService.registerDevice(req.body || {});
    res.json({ success: true, device: { platform: device.platform, accountIds: device.accountIds } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/emails/devices — stop sending push to this device.
router.delete('/devices', (req, res) => {
  res.json({ success: pushService.unregisterDevice(req.body?.token || req.query.token) });
});

// ─── Contacts ───────────────────────────────────────────────────────────────
// Derived from indexed mail rather than a synced address book — see
// contactsService for why frequency plus recency is the right ranking.

// GET /api/emails/contacts?q=al&limit=10&accountId=
router.get('/contacts', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  res.json(contactsService.search(req.query.q || '', {
    limit,
    accountId: req.query.accountId || null,
  }));
});

// ─── Unified inbox ──────────────────────────────────────────────────────────

// GET /api/emails/unified?folder=INBOX&limit=50
// One date-ordered list across every account. Page tokens are per-account, so
// the client sends back the whole map it received to continue.
//
// An account with no further pages is reported as an explicit `null` rather
// than being left out of the map. Omitting it read back as `undefined` on the
// next request, which is indistinguishable from "first page", so every
// exhausted account had its first page fetched and appended again on each
// "Load more" — the same fifty messages, over and over.
router.get('/unified', async (req, res) => {
  const folder = req.query.folder || 'INBOX';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  let tokens = {};
  if (req.query.pageTokens) {
    try { tokens = JSON.parse(req.query.pageTokens) || {}; } catch { tokens = {}; }
  }

  const accounts = store.getAccounts();
  if (!accounts.length) return res.json({ emails: [], nextTokens: {}, errors: [] });

  const nextTokens = {};
  const errors = [];

  // A continuation request is one that carried tokens. On a first load the map
  // is empty and every account is fetched from the start.
  const isContinuation = Object.keys(tokens).length > 0;

  const pages = await Promise.all(accounts.map(async (account) => {
    const token = tokens[account.id];
    // An account that has already run out must not be asked again. Both an
    // explicit null and a missing entry on a continuation mean "exhausted".
    if (token === null || (isContinuation && token === undefined)) {
      nextTokens[account.id] = null;
      return [];
    }
    try {
      const service = getService(account.type);
      const result = await service.fetchEmails(account, folder, limit, token || null);
      nextTokens[account.id] = result?.nextToken || null;
      searchIndex.indexSummaries(result?.emails || []);
      return result?.emails || [];
    } catch (err) {
      errors.push({ accountId: account.id, email: account.email, error: err.message });
      // A provider being down should not blank out the other accounts. Keep
      // its token as-is so a later retry resumes where it left off instead of
      // treating the failure as the end of the mailbox.
      nextTokens[account.id] = token ?? null;
      const cached = store.getEmailCache(`list:${account.id}:${folder}:`);
      return cached ? (cached.value.emails || []) : [];
    }
  }));

  // De-duplicate before sorting: a provider can return the same message on two
  // sides of a cursor, and the client appends whatever arrives.
  const seen = new Set();
  const merged = [];
  for (const email of pages.flat()) {
    if (!email?.id || seen.has(email.id)) continue;
    seen.add(email.id);
    merged.push(email);
  }
  merged.sort((a, b) => {
    const ta = Date.parse(a.date || '');
    const tb = Date.parse(b.date || '');
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });

  res.json({ emails: merged.slice(0, limit), nextTokens, errors });
});

// ─── Vacation auto-responder ────────────────────────────────────────────────

router.get('/vacation', (req, res) => {
  const config = vacationService.settings();
  res.json({ ...config, active: vacationService.isActive() });
});

router.put('/vacation', (req, res) => {
  const body = req.body || {};
  const iso = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };

  const saved = store.saveVacationSettings({
    enabled: body.enabled === true,
    subject: String(body.subject || 'Out of office').slice(0, 300),
    message: String(body.message || '').slice(0, 20000),
    startAt: iso(body.startAt),
    endAt: iso(body.endAt),
    accountIds: Array.isArray(body.accountIds) ? body.accountIds.slice(0, 20) : [],
    knownContactsOnly: body.knownContactsOnly === true,
    cooldownDays: Math.min(Math.max(Number(body.cooldownDays) || 4, 1), 30),
  });

  // Turning the responder on starts a fresh conversation with everyone; the
  // old log would otherwise suppress replies left over from a past trip.
  if (saved.enabled && body.resetLog !== false) store.clearAutoReplyLog();

  const config = vacationService.settings();
  res.json({ ...config, active: vacationService.isActive() });
});

// ─── Signatures ─────────────────────────────────────────────────────────────
// Keyed by account id, and by `${accountId}:${aliasEmail}` for an alias, so
// sending from a second identity signs with that identity.

router.get('/signatures', (req, res) => res.json(store.getSignatures()));

router.put('/signatures', (req, res) => {
  const incoming = req.body?.signatures;
  const out = {};
  if (incoming && typeof incoming === 'object') {
    for (const [key, value] of Object.entries(incoming).slice(0, 100)) {
      out[String(key).slice(0, 200)] = String(value ?? '').slice(0, 20000);
    }
  }
  res.json(store.saveSignatures(out));
});

// ─── Mailbox export ─────────────────────────────────────────────────────────

// GET /api/emails/export?accountId=...&folder=INBOX&limit=5000
// Streams the folder as mbox, the format every other mail client imports.
router.get('/export', async (req, res) => {
  const account = store.getAccount(req.query.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = req.query.folder || 'INBOX';
  const limit = Math.min(parseInt(req.query.limit) || 5000, 50000);
  const filename = exportService.suggestFilename(account, folder);

  res.setHeader('Content-Type', 'application/mbox');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  // The total size is unknown until the last message is written, so this has
  // to be a chunked response rather than one with a Content-Length.
  res.setHeader('Transfer-Encoding', 'chunked');

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const result = await exportService.exportFolder(account, res, {
      folder,
      limit,
      onProgress: () => { if (aborted) throw new Error('Client disconnected'); },
    });
    console.log(`[export] ${account.email}/${folder}: ${result.exported} exported, ${result.failed} skipped`);
    res.end();
  } catch (err) {
    console.error('Export error:', err.message);
    // Headers are long gone by this point, so the only honest signal left is
    // an mbox comment at the tail and a truncated stream.
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end(`\n\nX-Hermes-Export-Error: ${String(err.message).replace(/[\r\n]+/g, ' ')}\n`);
  }
});

// GET /api/emails/attachment-ticket/:token
// Redeem a download ticket. Reachable without the API token by design — the
// ticket is the credential — so it is single-use, expires in two minutes, and
// is bound to exactly one attachment.
router.get('/attachment-ticket/:token', async (req, res) => {
  const claim = downloadTickets.redeem(req.params.token);
  // Unknown, expired, and already-spent are deliberately indistinguishable.
  if (!claim) return res.status(404).json({ error: 'This download link has expired' });

  const account = store.getAccount(claim.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  try {
    const attachment = await loadAttachment(account, claim.emailId, claim.index, claim.folder);
    sendAttachment(res, attachment, claim.index, true);
  } catch (err) {
    console.error('Ticketed attachment error:', err);
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
    const attachment = await loadAttachment(account, req.params.emailId, index, req.query.folder);
    sendAttachment(res, attachment, index, req.query.inline === 'true');
  } catch (err) {
    console.error('Fetch attachment error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/emails/:accountId/message/:emailId/attachment/:index/ticket
// Mint a single-use, two-minute URL for one attachment.
//
// The mobile app hands attachment URLs to the OS viewer, so the URL leaves the
// app. It used to carry the master API token, which then sat in the system
// browser's history — often synced across the user's devices. A ticket is
// scoped to one file and worthless within minutes.
router.post('/:accountId/message/:emailId/attachment/:index/ticket', (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const index = parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid attachment index' });

  const { token, expiresIn } = downloadTickets.issue({
    accountId: account.id,
    emailId: req.params.emailId,
    index,
    folder: req.query.folder || 'INBOX',
  });

  res.json({ url: `/api/emails/attachment-ticket/${token}`, expiresIn });
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

  const {
    to, cc, bcc, subject, text, html, attachments, replaceRef,
    inReplyTo, references, sendAs,
  } = req.body;
  try {
    const service = getService(account.type);
    if (!service.saveDraft) return res.status(400).json({ error: 'Drafts are not supported for this account' });

    // Remove the previous server copy (best-effort) so re-saving doesn't pile up.
    if (replaceRef && service.deleteDraft) {
      try { await service.deleteDraft(account, replaceRef); } catch { /* ignore */ }
    }

    const ref = await service.saveDraft(account, {
      to, cc, bcc, subject, text, html, attachments, inReplyTo, references, sendAs,
    });
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

// POST /api/emails/:accountId/message/:emailId/untrash
// Undo a delete. Body: { folder } — where to put it back (default INBOX).
//
// Gmail and Outlook both keep a message's id stable through the bin, so the
// original can be restored exactly. IMAP does not: the message gets a new UID
// in the Trash mailbox and the old one no longer addresses anything, so undo is
// honestly unavailable there rather than silently doing nothing.
router.post('/:accountId/message/:emailId/untrash', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const service = getService(account.type);
  if (!service.untrashEmail) {
    return res.status(400).json({ error: 'Undo is not available for IMAP accounts' });
  }

  try {
    await service.untrashEmail(
      account,
      gmailOrOutlookId(req.params.emailId),
      req.body?.folder || 'INBOX',
    );
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
    const result = await service.reportSpam(account, id, req.query.folder || 'INBOX');
    searchIndex.remove(req.params.emailId);
    invalidateCounts();
    // `undoId` is what an Undo must address; absent means undo is unavailable.
    res.json({ success: true, undoId: recomposeId(account, req.params.emailId, result) || req.params.emailId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/emails/:accountId/message/:emailId/unspam
// Undo a spam report. Body/query: { folder } — where to put it back.
router.post('/:accountId/message/:emailId/unspam', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const service = getService(account.type);
  if (!service.unreportSpam) {
    return res.status(400).json({ error: 'Undo is not available for this account' });
  }

  try {
    const id = account.type === 'imap' ? imapUid(req.params.emailId) : gmailOrOutlookId(req.params.emailId);
    const folder = req.body?.folder || req.query.folder || 'INBOX';
    await service.unreportSpam(account, id, folder);
    invalidateCounts();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const sourceFolder = req.query.folder || 'INBOX';
    let result;
    if (account.type === 'imap') {
      result = await service.moveEmail(account, imapUid(req.params.emailId), sourceFolder, toFolder);
    } else if (account.type === 'gmail') {
      result = await service.moveEmail(account, gmailOrOutlookId(req.params.emailId), sourceFolder, toFolder);
    } else {
      result = await service.moveEmail(account, gmailOrOutlookId(req.params.emailId), toFolder);
    }
    // The message still exists, just elsewhere — drop it from the index so a
    // stale folder isn't reported, and let the next fetch re-index it.
    searchIndex.remove(req.params.emailId);
    invalidateCounts();
    // The id to use when moving it back. An IMAP server that does not report
    // COPYUID leaves this null, and the client hides Undo rather than offering
    // one that would fail.
    res.json({ success: true, undoId: recomposeId(account, req.params.emailId, result), fromFolder: sourceFolder });
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

// POST /api/emails/:accountId/message/:emailId/rsvp
// Body: { response: 'accepted' | 'declined' | 'tentative', comment?: string }
// Sends the organiser a METHOD:REPLY calendar part, which is what turns an
// invitation into an accepted meeting in their calendar.
router.post('/:accountId/message/:emailId/rsvp', async (req, res) => {
  const account = store.getAccount(req.params.accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const choice = String(req.body?.response || '').toLowerCase();
  const PARTSTAT = { accepted: 'ACCEPTED', declined: 'DECLINED', tentative: 'TENTATIVE' };
  if (!PARTSTAT[choice]) {
    return res.status(400).json({ error: 'response must be "accepted", "declined", or "tentative"' });
  }

  try {
    const service = getService(account.type);
    const emailId = req.params.emailId;
    const body = account.type === 'imap'
      ? await service.fetchEmailBody(account, imapUid(emailId), req.query.folder || 'INBOX')
      : await service.fetchEmailBody(account, gmailOrOutlookId(emailId));

    const invite = body?.calendarInvite;
    if (!invite) return res.status(400).json({ error: 'This message contains no calendar invitation' });
    if (!invite.organizer?.email) {
      return res.status(400).json({ error: 'This invitation names no organiser to reply to' });
    }

    const ics = calendarService.buildReply(invite, account.email, PARTSTAT[choice]);
    const verb = { accepted: 'Accepted', declined: 'Declined', tentative: 'Tentatively accepted' }[choice];

    const queued = createQueuedSend({
      accountId: account.id,
      email: {
        to: invite.organizer.email,
        subject: `${verb}: ${invite.summary || '(no subject)'}`,
        text: req.body?.comment
          ? String(req.body.comment).slice(0, 5000)
          : `${verb} the invitation "${invite.summary || '(no subject)'}".`,
        attachments: [{
          filename: 'invite.ics',
          contentType: 'text/calendar; method=REPLY; charset=utf-8',
          content: Buffer.from(ics, 'utf8').toString('base64'),
        }],
        inReplyTo: body.messageId || undefined,
      },
      undoWindowSec: 0,
    });

    res.json({ success: true, response: choice, jobId: queued.id });
  } catch (err) {
    console.error('RSVP error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk actions ───────────────────────────────────────────────────────────

// A select-all can hand us thousands of ids. Firing them at a provider all at
// once earns a 429 and a temporary ban, and on IMAP they queue behind a single
// connection anyway — so the parallelism bought nothing and just held the
// request open. Bounded batch, bounded concurrency.
const BULK_MAX_IDS = 500;
const BULK_CONCURRENCY = { imap: 1, gmail: 8, outlook: 8 };

async function runBulk(emailIds, worker, accountType = 'imap') {
  const results = { succeeded: 0, failed: 0, errors: [], skipped: 0 };

  let ids = emailIds;
  if (ids.length > BULK_MAX_IDS) {
    results.skipped = ids.length - BULK_MAX_IDS;
    ids = ids.slice(0, BULK_MAX_IDS);
  }

  const limit = BULK_CONCURRENCY[accountType] || 4;
  let cursor = 0;

  const runOne = async (emailId) => {
    try {
      await worker(emailId);
      results.succeeded++;
    } catch (err) {
      results.failed++;
      if (results.errors.length < 5) results.errors.push(String(err?.message || err));
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, async () => {
    while (cursor < ids.length) await runOne(ids[cursor++]);
  }));

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
  }, account.type);

  invalidateCounts();
  res.json({ success: results.failed === 0 && !results.skipped, ...results });
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
  }, account.type);

  invalidateCounts();
  res.json({ success: results.failed === 0 && !results.skipped, ...results });
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
  }, account.type);

  invalidateCounts();
  res.json({ success: results.failed === 0 && !results.skipped, ...results });
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
  }, account.type);

  invalidateCounts();
  res.json({ success: results.failed === 0 && !results.skipped, ...results });
});

module.exports = router;
