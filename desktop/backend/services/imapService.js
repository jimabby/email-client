const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const calendar = require('./calendarService');
const authResults = require('./authResultsService');

// ─── IMAP Connection Pool ─────────────────────────────────────────────────────
// One persistent connection per account. All operations are serialized through
// a queue so we never open two mailboxes concurrently on the same connection.

// A server that stops answering mid-command would otherwise hold the queue
// forever, and every later operation on the account would wait behind it.
const OPERATION_TIMEOUT_MS = 2 * 60 * 1000;

const CONNECT_OPTIONS = {
  greetingTimeout: 15000,
  connectionTimeout: 30000,
};

class ImapConnection {
  constructor(account) {
    this.account = account;
    this.client = null;
    this._queue = Promise.resolve();
  }

  // Run fn(client) exclusively — waits for any in-progress operation first.
  run(fn) {
    const task = this._queue.then(async () => {
      if (!this.client || !this.client.usable) {
        await this._connect();
      }
      const client = this.client;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          // Drop the wedged connection so the next operation starts clean.
          if (this.client === client) this.client = null;
          try { client.close(); } catch { /* already gone */ }
          reject(new Error('IMAP operation timed out'));
        }, OPERATION_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        return await Promise.race([fn(client), timeout]);
      } catch (err) {
        if (!this.client || !this.client.usable) this.client = null;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    });
    // Let the queue advance even if this task fails.
    this._queue = task.catch(() => {});
    return task;
  }

  async _connect() {
    if (this.client) {
      try { await this.client.logout(); } catch {}
      this.client = null;
    }
    const client = new ImapFlow({
      host: this.account.imapHost,
      port: this.account.imapPort || 993,
      secure: this.account.imapSecure !== false,
      auth: { user: this.account.email, pass: this.account.password },
      tls: { rejectUnauthorized: this.account.allowInsecureTLS !== true },
      ...CONNECT_OPTIONS,
      logger: false
    });
    await client.connect();
    // Drop the cached client on unexpected close/error so the next call reconnects.
    client.on('close', () => { if (this.client === client) this.client = null; });
    client.on('error', () => { if (this.client === client) this.client = null; });
    this.client = client;
  }

  async close() {
    if (this.client) {
      try { await this.client.logout(); } catch {}
      this.client = null;
    }
  }
}

const imapPool = new Map(); // accountId -> ImapConnection

function getConn(account) {
  const existing = imapPool.get(account.id);
  // A pooled connection captures the account object it was built from. If the
  // stored credentials or host changed since then, drop it so the next call
  // reconnects with the new settings instead of failing with the old password.
  if (existing) {
    const stale = existing.account.password !== account.password
      || existing.account.imapHost !== account.imapHost
      || existing.account.imapPort !== account.imapPort;
    if (!stale) return existing;
    existing.close().catch(() => {});
    imapPool.delete(account.id);
  }
  const conn = new ImapConnection(account);
  imapPool.set(account.id, conn);
  return conn;
}

// Call this when an account is removed so the connection is cleaned up.
async function closeConnection(accountId) {
  const conn = imapPool.get(accountId);
  if (conn) {
    await conn.close();
    imapPool.delete(accountId);
  }
}

// ─── SMTP Pool ────────────────────────────────────────────────────────────────
// Reuse pooled SMTP connections so sending doesn't re-negotiate TLS every time.

const smtpPool = new Map(); // accountId -> { transporter, fingerprint }

// Certificate validation stays ON. Turning it off silently accepts any
// certificate, which exposes the account password and every outgoing message
// to anyone able to intercept the connection. Accounts that genuinely need it
// (a self-hosted server with a self-signed cert) must opt in explicitly.
function tlsOptions(account) {
  return { rejectUnauthorized: account.allowInsecureTLS !== true };
}

function smtpFingerprint(account) {
  return [account.smtpHost, account.smtpPort, account.smtpSecure, account.password, account.allowInsecureTLS].join('|');
}

function getTransporter(account) {
  const fingerprint = smtpFingerprint(account);
  const cached = smtpPool.get(account.id);
  if (cached && cached.fingerprint === fingerprint) return cached.transporter;
  if (cached) { try { cached.transporter.close(); } catch { /* already gone */ } }

  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort || 587,
    secure: account.smtpSecure || false,
    auth: { user: account.email, pass: account.password },
    tls: tlsOptions(account),
    pool: true,        // keep SMTP connections alive
    maxConnections: 1
  });
  smtpPool.set(account.id, { transporter, fingerprint });
  return transporter;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Gmail and Outlook both return a server-side snippet; IMAP has no equivalent,
// so one is derived from the first couple of KB of the raw message. Without it
// categorisation loses a whole signal on IMAP accounts and the search index
// stores an empty preview.
const SNIPPET_SOURCE_BYTES = 2048;
const SNIPPET_CHARS = 200;

function decodeSnippetBody(body, transferEncoding) {
  if (/base64/i.test(transferEncoding)) {
    // The source is truncated, so decode whole 4-char groups only.
    const compact = body.replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(compact.slice(0, compact.length - (compact.length % 4)), 'base64').toString('utf8');
  }
  if (/quoted-printable/i.test(transferEncoding)) {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body;
}

const BLANK_LINE = /\r?\n\r?\n/;
const BOUNDARY = /boundary="?([^";\r\n]+)"?/i;

function splitPart(part) {
  const at = part.search(BLANK_LINE);
  return at === -1 ? null : { headers: part.slice(0, at), body: part.slice(at) };
}

function snippetFromSource(source) {
  if (!source) return '';
  const raw = source.toString('utf8');
  // Headers end at the first blank line; everything after it is the body.
  const top = splitPart(raw);
  if (!top) return '';
  const headers = top.headers.replace(/\r?\n[ \t]+/g, ' ');
  let body = top.body.replace(/^\s+/, '');
  let encoding = headers.match(/^content-transfer-encoding:\s*(\S+)/im)?.[1] || '';

  // A multipart message opens with a preamble ("This is a multi-part message
  // in MIME format.") and part headers. Skip to the first text part instead of
  // showing those as the preview.
  const boundary = headers.match(BOUNDARY)?.[1];
  if (boundary) {
    let found = null;
    for (const chunk of body.split(`--${boundary}`).slice(1)) {
      const part = splitPart(chunk);
      if (!part) continue;
      // A nested multipart/alternative carries its own boundary; its first
      // text part is still the best preview.
      const nested = part.headers.match(BOUNDARY)?.[1];
      if (nested) {
        const inner = part.body.split(`--${nested}`).slice(1)
          .find(p => /content-type:\s*text\/(plain|html)/i.test(p));
        found = inner ? splitPart(inner) : null;
        if (found) break;
        continue;
      }
      if (/content-type:\s*text\/(plain|html)/i.test(part.headers) || !/content-type:/i.test(part.headers)) {
        found = part;
        break;
      }
    }
    if (!found) return '';
    body = found.body.replace(/^\s+/, '');
    encoding = found.headers.match(/content-transfer-encoding:\s*(\S+)/i)?.[1] || '';
  } else if (/^[A-Za-z0-9+/=\r\n]{200,}$/.test(body.slice(0, 400)) && !/base64/i.test(encoding)) {
    // Encoded noise without a declared encoding — better empty than garbage.
    return '';
  }

  body = decodeSnippetBody(body, encoding)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

  return body.slice(0, SNIPPET_CHARS);
}

// UIDs are only unique within one mailbox, so the folder is part of the id.
// Without it message 5 in INBOX and message 5 in Sent shared an id, and the
// search index, categories, and snoozes confused the two.
function composeId(accountId, folder, uid) {
  return `${accountId}::${folder}::${uid}`;
}

// "Message-ID" values in a References header, oldest first.
function messageIds(value) {
  return String(value || '').match(/<[^<>\s]+>/g) || [];
}

function referencesFromHeaders(headers) {
  if (!headers) return '';
  const text = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  return text.match(/^references:\s*(.+)$/im)?.[1].trim() || '';
}

// The thread a message belongs to is named after its root: the first id in
// References, else the message it replies to, else itself. Using In-Reply-To
// alone (as this once did) split every conversation deeper than one reply.
function threadRoot(envelope, references) {
  return messageIds(references)[0] || envelope.inReplyTo || envelope.messageId || null;
}

// Envelope → EmailSummary. Shared by list, search, and attachment search so
// the three paths can't drift apart.
function toSummary(account, msg, folder) {
  const envelope = msg.envelope || {};
  const references = referencesFromHeaders(msg.headers);
  return {
    id: composeId(account.id, folder, msg.uid),
    snippet: snippetFromSource(msg.source),
    uid: msg.uid,
    from: envelope.from?.[0]
      ? `${envelope.from[0].name || ''} <${envelope.from[0].address}>`.trim()
      : 'Unknown',
    to: (envelope.to || []).map(a => a.address),
    subject: envelope.subject || '(no subject)',
    date: envelope.date?.toISOString() || new Date().toISOString(),
    read: msg.flags?.has('\\Seen') ?? false,
    starred: msg.flags?.has('\\Flagged') ?? false,
    folder,
    accountId: account.id,
    threadId: threadRoot(envelope, references),
    messageId: envelope.messageId || '',
    inReplyTo: envelope.inReplyTo || '',
    hasAttachments: msg.bodyStructure ? collectStructureAttachments(msg.bodyStructure).length > 0 : undefined,
  };
}

// What every list-style fetch asks for: enough to build a summary, including
// the attachment flag (from BODYSTRUCTURE — no bytes) and References for
// threading, without downloading bodies.
const SUMMARY_FETCH = {
  envelope: true, uid: true, flags: true, bodyStructure: true,
  headers: ['references'],
  source: { maxLength: SNIPPET_SOURCE_BYTES },
};

async function fetchEmails(account, folder = 'INBOX', limit = 50, pageToken = null) {
  return getConn(account).run(async (client) => {
    const mailbox = await client.mailboxOpen(folder);
    if (mailbox.exists === 0) return { emails: [], nextToken: null };

    // Page by UID, not sequence number. Sequence numbers shift whenever mail
    // arrives or is expunged, so a sequence-based page token silently skips or
    // repeats messages while the user is scrolling.
    let ceiling;
    if (pageToken) {
      ceiling = parseInt(pageToken, 10);
    } else if (mailbox.uidNext) {
      ceiling = mailbox.uidNext - 1;
    } else {
      // Not every server reports uidNext. Falling back to 0 here would report
      // an empty mailbox, so find the top UID the expensive way — once, only
      // for the first page, and only on servers that need it.
      const all = await client.search({ all: true }, { uid: true });
      ceiling = all?.length ? Math.max(...all) : 0;
    }
    if (!Number.isFinite(ceiling) || ceiling < 1) {
      return { emails: [], nextToken: null };
    }

    // Walk down from the ceiling in bounded windows. Listing every UID in the
    // mailbox first (a `1:*` SEARCH) meant each "load more" on a 100k-message
    // account pulled the entire UID set just to keep the last `limit` of it.
    // UIDs are sparse, so the window widens until enough messages are found.
    const emails = [];
    let cursor = ceiling;
    let window = Math.max(limit * 2, 50);

    while (emails.length < limit && cursor >= 1) {
      const low = Math.max(1, cursor - window + 1);
      for await (const msg of client.fetch(`${low}:${cursor}`, SUMMARY_FETCH, { uid: true })) {
        emails.push(toSummary(account, msg, folder));
      }
      if (low === 1) { cursor = 0; break; }
      cursor = low - 1;
      // Empty stretches are common in a mailbox with lots of deletions.
      window = Math.min(window * 2, 10000);
    }

    emails.sort((a, b) => b.uid - a.uid);
    const page = emails.slice(0, limit);
    if (!page.length) return { emails: [], nextToken: null };

    // More to come only if we stopped short of UID 1.
    const lowestUid = page[page.length - 1].uid;
    const hasMore = lowestUid > 1;
    return { emails: page, nextToken: hasMore ? String(lowestUid - 1) : null };
  });
}

// Unread/total per folder without pulling any message — this is what the
// sidebar badges need.
async function getUnreadCounts(account, folders = ['INBOX']) {
  return getConn(account).run(async (client) => {
    const counts = {};
    for (const folder of folders) {
      try {
        const status = await client.status(folder, { unseen: true, messages: true });
        counts[folder] = { unread: status.unseen || 0, total: status.messages || 0 };
      } catch {
        counts[folder] = { unread: 0, total: 0 };
      }
    }
    return counts;
  });
}

async function searchEmails(account, query, folder = 'INBOX', limit = 50) {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);
    const uids = await client.search(
      { or: [{ from: query }, { subject: query }] },
      { uid: true }
    );
    if (!uids || uids.length === 0) return [];
    const recentUids = uids.slice(-limit);
    const emails = [];
    for await (const msg of client.fetch(recentUids, SUMMARY_FETCH, { uid: true })) {
      emails.push(toSummary(account, msg, folder));
    }
    emails.sort((a, b) => b.uid - a.uid);
    return emails;
  });
}

function _attachmentMatches(att, query, type) {
  const filename = (att.filename || '').toLowerCase();
  const contentType = (att.contentType || '').toLowerCase();
  const q = (query || '').trim().toLowerCase();
  const t = (type || '').trim().toLowerCase();

  const queryOk = !q || filename.includes(q);
  if (!queryOk) return false;

  if (!t) return true;
  if (t.includes('/')) return contentType.includes(t);
  const ext = t.startsWith('.') ? t : `.${t}`;
  return filename.endsWith(ext) || filename.includes(t);
}

// Walk a BODYSTRUCTURE tree and collect the parts that look like attachments.
// This comes back in the FETCH response itself — no message bodies are
// downloaded, which is the difference between a few KB and several hundred MB
// for a single search.
function collectStructureAttachments(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    for (const child of node.childNodes) collectStructureAttachments(child, out);
    return out;
  }
  const disposition = String(node.disposition || '').toLowerCase();
  const filename = node.dispositionParameters?.filename
    || node.parameters?.name
    || '';
  const isAttachment = disposition === 'attachment' || (!!filename && disposition !== 'inline');
  if (isAttachment) {
    out.push({
      filename,
      contentType: node.type || 'application/octet-stream',
      size: node.size || 0,
      part: node.part || '1',
    });
  }
  return out;
}

async function searchAttachments(account, query, type, folder = 'INBOX', limit = 50) {
  return getConn(account).run(async (client) => {
    const emails = [];
    const mailbox = await client.mailboxOpen(folder);
    if (mailbox.exists === 0) return [];

    // Let the server narrow the candidate set first when it can.
    let candidateUids;
    try {
      candidateUids = await client.search({ header: { 'content-type': 'multipart/mixed' } }, { uid: true });
    } catch {
      candidateUids = null;
    }
    if (!candidateUids || !candidateUids.length) {
      candidateUids = await client.search({ all: true }, { uid: true });
    }
    if (!candidateUids?.length) return [];

    candidateUids.sort((a, b) => b - a);
    const scanUids = candidateUids.slice(0, Math.max(limit * 10, 500));

    for await (const msg of client.fetch(scanUids, SUMMARY_FETCH, { uid: true })) {
      const attachments = collectStructureAttachments(msg.bodyStructure);
      if (!attachments.some(att => _attachmentMatches(att, query, type))) continue;
      emails.push(toSummary(account, msg, folder));
      if (emails.length >= limit) break;
    }

    emails.sort((a, b) => b.uid - a.uid);
    return emails;
  });
}

// A header exactly as sent, unfolded. mailparser turns some headers (the
// List-* family among them) into structured objects, which loses the raw
// "<https://…>, <mailto:…>" form the unsubscribe code parses.
function rawHeader(parsed, name) {
  const line = (parsed.headerLines || []).find(h => h.key === name)?.line || '';
  return line.replace(/^[^:]*:\s*/, '').replace(/\r?\n[ \t]+/g, ' ').trim();
}

// The headers that decide whether a message is automated or a list post, plus
// the recipients — everything the vacation responder needs, without a body.
const POLICY_HEADERS = [
  'to', 'cc', 'list-id', 'list-unsubscribe', 'precedence', 'auto-submitted',
  'x-auto-response-suppress',
];

function parseHeaderBlock(buffer) {
  const text = String(buffer || '').replace(/\r?\n[ \t]+/g, ' ');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    out[key] = out[key] ? `${out[key]}, ${line.slice(at + 1).trim()}` : line.slice(at + 1).trim();
  }
  return out;
}

/** Selected headers of one message, keyed in lower case. */
async function getHeaders(account, uid, folder = 'INBOX') {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);
    for await (const msg of client.fetch(String(uid), { headers: POLICY_HEADERS }, { uid: true })) {
      return parseHeaderBlock(msg.headers);
    }
    return {};
  });
}

async function fetchEmailBody(account, uid, folder = 'INBOX') {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);

    let rawEmail = null;
    for await (const msg of client.fetch(String(uid), { source: true }, { uid: true })) {
      rawEmail = msg.source;
    }
    if (!rawEmail) return null;

    const parsed = await simpleParser(rawEmail);

    // mailparser exposes text/calendar both as an attachment and, for some
    // messages, only as an alternative body part — check both.
    const icsAttachment = (parsed.attachments || []).find(a => calendar.isCalendarPart(a));
    let calendarText = icsAttachment?.content ? icsAttachment.content.toString('utf8') : '';
    if (!calendarText && /BEGIN:VCALENDAR/i.test(parsed.text || '')) calendarText = parsed.text;

    return {
      uid,
      from: parsed.from?.text || '',
      to: parsed.to?.text || '',
      cc: parsed.cc?.text || '',
      subject: parsed.subject || '',
      date: parsed.date?.toISOString() || '',
      text: parsed.text || '',
      html: parsed.html || parsed.textAsHtml || '',
      // Threading info so replies can set In-Reply-To/References.
      messageId: parsed.messageId || '',
      references: Array.isArray(parsed.references)
        ? parsed.references.join(' ')
        : (parsed.references || ''),
      authentication: authResults.summarize(
        parsed.headers?.get('authentication-results'),
        parsed.from?.text,
      ),
      calendarInvite: calendarText ? calendar.parseInvite(calendarText) : null,
      // RFC 2369 / 8058 — what one-click unsubscribe needs.
      listUnsubscribe: rawHeader(parsed, 'list-unsubscribe'),
      listUnsubscribePost: rawHeader(parsed, 'list-unsubscribe-post'),
      // Metadata only — bytes come from getAttachment on demand so a message
      // with large attachments doesn't have to be buffered through the API
      // just to display its text.
      attachments: (parsed.attachments || []).map(a => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        content: null,
      }))
    };
  });
}

// Fetch a single attachment's bytes by its position in the fetchEmailBody list.
async function getAttachment(account, uid, folder = 'INBOX', index = 0) {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);
    let rawEmail = null;
    for await (const msg of client.fetch(String(uid), { source: true }, { uid: true })) {
      rawEmail = msg.source;
    }
    if (!rawEmail) throw new Error('Message not found');

    const parsed = await simpleParser(rawEmail);
    const att = (parsed.attachments || [])[index];
    if (!att) throw new Error('Attachment not found');
    return {
      filename: att.filename || `attachment-${index}`,
      contentType: att.contentType || 'application/octet-stream',
      content: att.content,
    };
  });
}

// The complete RFC822 source, for mbox export.
async function getRawMessage(account, uid, folder = 'INBOX') {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);
    for await (const msg of client.fetch(String(uid), { source: true }, { uid: true })) {
      return msg.source;
    }
    return null;
  });
}

async function getFolders(account) {
  return getConn(account).run(async (client) => {
    const list = await client.list();
    return list.map(f => ({ name: f.name, path: f.path, delimiter: f.delimiter, specialUse: f.specialUse || null }));
  });
}

// Prefer the RFC 6154 special-use flag; fall back to the usual names.
async function findSpecialFolder(account, specialUse, namePattern) {
  const list = await getFolders(account);
  return list.find(f => f.specialUse === specialUse)
    || list.find(f => namePattern.test(f.name))
    || null;
}

async function createFolder(account, name) {
  return getConn(account).run(async client => {
    await client.mailboxCreate(name);
    return { name, path: name };
  });
}

async function renameFolder(account, folder, name) {
  return getConn(account).run(async client => {
    await client.mailboxRename(folder, name);
    return { name, path: name };
  });
}

async function reportSpam(account, uid, folder = 'INBOX') {
  const spam = await findSpecialFolder(account, '\\Junk', /spam|junk/i);
  if (!spam) throw new Error('This account has no Spam/Junk folder');
  const moved = await moveEmail(account, uid, folder, spam.path);
  return { ...moved, spamFolder: spam.path };
}

/** Move a message back out of Spam/Junk, so the action can carry an Undo. */
async function unreportSpam(account, uid, folder = 'INBOX') {
  const spam = await findSpecialFolder(account, '\\Junk', /spam|junk/i);
  if (!spam) throw new Error('This account has no Spam/Junk folder');
  return moveEmail(account, uid, spam.path, folder || 'INBOX');
}

// Resolve the identity to send as — an explicit alias the account registered,
// or the account's own address.
function resolveFrom(account, sendAs) {
  const wanted = String(sendAs?.email || '').trim().toLowerCase();
  if (wanted && wanted !== String(account.email).toLowerCase()) {
    const alias = (account.aliases || []).find(a => String(a.email).toLowerCase() === wanted);
    if (alias) return { name: alias.name || account.name || alias.email, address: alias.email };
  }
  return { name: account.name || account.email, address: account.email };
}

async function sendEmail(account, { to, cc, bcc, subject, text, html, attachments, inReplyTo, references, sendAs, autoSubmitted }) {
  const transporter = getTransporter(account);
  // References for a reply = the original's References + its Message-ID.
  const replyRefs = [references, inReplyTo].filter(Boolean).join(' ');
  return transporter.sendMail({
    // nodemailer escapes and encodes these fields itself, so a newline in a
    // name or address can't inject extra headers.
    from: resolveFrom(account, sendAs),
    to, cc, bcc, subject, text, html,
    inReplyTo: inReplyTo || undefined,
    references: replyRefs || undefined,
    // RFC 3834 — see the Gmail builder for why this matters.
    headers: autoSubmitted ? { 'Auto-Submitted': autoSubmitted } : undefined,
    attachments: (attachments || []).map(a => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'base64'),
      contentType: a.contentType
    }))
  });
}

// Fetch just the headers needed to thread a reply to this message.
async function getThreadingInfo(account, uid, folder = 'INBOX') {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);
    let headers = null;
    for await (const msg of client.fetch(String(uid), { headers: ['message-id', 'references'] }, { uid: true })) {
      headers = msg.headers;
    }
    if (!headers) return { inReplyTo: '', references: '' };
    // Unfold wrapped header lines before matching.
    const text = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
    const get = (name) => text.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1].trim() || '';
    return { inReplyTo: get('message-id'), references: get('references') };
  });
}

// Build a raw RFC822 message buffer from a draft for IMAP APPEND.
// Mirrors sendEmail: a draft saved from an alias, or as a reply, must come back
// with the same From and the same threading headers it would have been sent
// with — otherwise reopening it silently reverts to the account address and
// detaches the reply from its thread.
function buildMime(account, { to, cc, bcc, subject, text, html, attachments, inReplyTo, references, sendAs }) {
  const replyRefs = [references, inReplyTo].filter(Boolean).join(' ');
  return new Promise((resolve, reject) => {
    const mail = new MailComposer({
      from: resolveFrom(account, sendAs),
      to: to || undefined,
      cc: cc || undefined,
      bcc: bcc || undefined,
      subject: subject || '',
      text: text || undefined,
      html: html || undefined,
      inReplyTo: inReplyTo || undefined,
      references: replyRefs || undefined,
      attachments: (attachments || []).map(a => ({
        filename: a.filename,
        content: Buffer.from(a.content, 'base64'),
        contentType: a.contentType
      }))
    });
    mail.compile().build((err, message) => (err ? reject(err) : resolve(message)));
  });
}

// Locate the account's Drafts mailbox (prefer the \Drafts special-use flag).
async function _findDraftsMailbox(client) {
  try {
    const list = await client.list();
    const special = list.find(f => f.specialUse === '\\Drafts');
    if (special) return special.path;
    const byName = list.find(f => /drafts/i.test(f.path) || /drafts/i.test(f.name));
    if (byName) return byName.path;
  } catch { /* fall through */ }
  return 'Drafts';
}

async function saveDraft(account, draft) {
  const raw = await buildMime(account, draft);
  return getConn(account).run(async (client) => {
    const mailbox = await _findDraftsMailbox(client);
    const res = await client.append(mailbox, raw, ['\\Draft', '\\Seen']);
    return { type: 'imap', uid: res?.uid || null, mailbox };
  });
}

async function deleteDraft(account, ref) {
  if (!ref?.uid) return;
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(ref.mailbox || 'Drafts');
    await client.messageDelete(String(ref.uid), { uid: true });
  });
}

async function markAsRead(account, uid, folder = 'INBOX') {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
  });
}

async function markAsUnread(account, uid, folder = 'INBOX') {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);
    await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
  });
}

async function toggleStar(account, uid, folder = 'INBOX', starred) {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);
    if (starred) {
      await client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
    } else {
      await client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true });
    }
  });
}

async function moveEmail(account, uid, fromFolder, toFolder) {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(fromFolder);
    // MOVE is atomic where the server supports it; ImapFlow falls back to
    // COPY + STORE + EXPUNGE itself when it doesn't, so there's no window
    // where the message exists in both folders or in neither.
    const result = await client.messageMove(String(uid), toFolder, { uid: true });
    // A moved message gets a fresh UID in the destination mailbox, so the id
    // the client is holding stops addressing anything. Servers advertising
    // UIDPLUS report the mapping in COPYUID; without it an undo is not
    // possible and the caller is told so by the absent id.
    const mapped = result?.uidMap instanceof Map ? result.uidMap.get(Number(uid)) : undefined;
    return mapped ? { uid: mapped, folder: toFolder } : { folder: toFolder };
  });
}

/**
 * Delete = move to Trash, exactly as Gmail and Outlook do.
 *
 * This used to call messageDelete, which flags \Deleted and EXPUNGEs — the
 * message was gone for good, from a button every other provider treats as
 * recoverable. Only mail already in Trash (or on a server with no Trash at
 * all) is removed permanently now.
 */
async function deleteEmail(account, uid, folder = 'INBOX') {
  const trash = await findSpecialFolder(account, '\\Trash', /^(trash|deleted( items| messages)?|bin)$|trash/i);
  if (trash && trash.path !== folder) {
    const moved = await moveEmail(account, uid, folder, trash.path);
    return { ...moved, permanent: false };
  }
  await getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);
    await client.messageDelete(String(uid), { uid: true });
  });
  return { permanent: true };
}

/** Undo a delete: move the message (addressed by its Trash UID) back. */
async function untrashEmail(account, uid, trashFolder, toFolder = 'INBOX') {
  return moveEmail(account, uid, trashFolder, toFolder || 'INBOX');
}

// Folders a conversation is looked for in: wherever the message was, plus
// Sent, so the user's own replies appear in the thread.
async function threadFolders(account, folder) {
  const sent = await findSpecialFolder(account, '\\Sent', /^sent/i).catch(() => null);
  return Array.from(new Set([folder || 'INBOX', 'INBOX', sent?.path].filter(Boolean)));
}

/**
 * Every message in a conversation, oldest first.
 *
 * IMAP has no conversation id, so `rootId` is the Message-ID the thread is
 * named after (see threadRoot): a member is the root itself or anything whose
 * References mention it.
 */
async function fetchThread(account, rootId, folder = 'INBOX') {
  const root = String(rootId || '').trim();
  if (!/^<[^<>\s]+>$/.test(root)) return [];

  const folders = await threadFolders(account, folder);
  const found = [];
  for (const box of folders) {
    const uids = await getConn(account).run(async (client) => {
      await client.mailboxOpen(box);
      const matches = await client.search({
        or: [
          { header: { 'message-id': root } },
          { header: { references: root } },
          { header: { 'in-reply-to': root } },
        ],
      }, { uid: true });
      return (matches || []).slice(-50);
    }).catch(() => []);
    for (const uid of uids) found.push({ uid, folder: box });
  }

  const items = [];
  const seenMessageIds = new Set();
  for (const { uid, folder: box } of found) {
    const [summary] = await getConn(account).run(async (client) => {
      await client.mailboxOpen(box);
      const out = [];
      for await (const msg of client.fetch(String(uid), SUMMARY_FETCH, { uid: true })) {
        out.push(toSummary(account, msg, box));
      }
      return out;
    });
    if (!summary) continue;
    // The same message can sit in two folders (a copy kept in Sent and one
    // delivered back to INBOX); show it once.
    if (summary.messageId && seenMessageIds.has(summary.messageId)) continue;
    if (summary.messageId) seenMessageIds.add(summary.messageId);
    const body = await fetchEmailBody(account, uid, box);
    items.push({ summary, body });
  }

  items.sort((a, b) => Date.parse(a.summary.date || '') - Date.parse(b.summary.date || ''));
  return items;
}

async function testConnection(account) {
  // Use a fresh client for connection tests (don't pollute the pool).
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort || 993,
    secure: account.imapSecure !== false,
    auth: { user: account.email, pass: account.password },
    tls: { rejectUnauthorized: account.allowInsecureTLS !== true },
    // Never let a wrong host hang the "Add account" dialog indefinitely.
    greetingTimeout: 15000,
    socketTimeout: 30000,
    logger: false
  });
  try {
    await client.connect();
    await client.logout();
    return true;
  } catch (err) {
    throw new Error(`Connection failed: ${err.message}`);
  }
}

module.exports = {
  _internals: { snippetFromSource, threadRoot, referencesFromHeaders, parseHeaderBlock },
  composeId,
  getHeaders,
  untrashEmail,
  fetchThread,
  fetchEmails,
  searchEmails,
  searchAttachments,
  fetchEmailBody,
  getAttachment,
  getRawMessage,
  getUnreadCounts,
  getThreadingInfo,
  getFolders,
  createFolder,
  renameFolder,
  reportSpam,
  unreportSpam,
  sendEmail,
  saveDraft,
  deleteDraft,
  markAsRead,
  markAsUnread,
  toggleStar,
  moveEmail,
  deleteEmail,
  testConnection,
  closeConnection
};
