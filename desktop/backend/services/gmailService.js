const { google } = require('googleapis');
const calendar = require('./calendarService');
const authResults = require('./authResultsService');

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || 'http://localhost:3001/api/auth/gmail/callback'
  );
}

function getAuthUrl(state) {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    prompt: 'consent',
    state
  });
}

async function handleCallback(code) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Get user info
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();

  return {
    tokens,
    email: data.email,
    name: data.name,
    picture: data.picture
  };
}

function getAuthClient(account) {
  const store = require('../store');
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken
  });

  // Auto-refresh tokens and persist to store
  oauth2Client.on('tokens', (tokens) => {
    const updates = {};
    if (tokens.refresh_token) {
      account.refreshToken = tokens.refresh_token;
      updates.refreshToken = tokens.refresh_token;
    }
    if (tokens.access_token) {
      account.accessToken = tokens.access_token;
      updates.accessToken = tokens.access_token;
    }
    if (Object.keys(updates).length > 0) {
      store.updateAccount(account.id, updates);
    }
  });

  return oauth2Client;
}

function getGmailClient(account) {
  return google.gmail({ version: 'v1', auth: getAuthClient(account) });
}

// ─── Batched metadata fetches ───────────────────────────────────────────────
// Listing a folder returns ids only, so every message needs a metadata read.
// One HTTP request per message means 50 round-trips per page and trips Gmail's
// per-user rate limit; the batch endpoint collapses them into one.

const BATCH_SIZE = 50; // Google's recommended maximum per batch request
const META_HEADERS = ['From', 'To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To'];

function parseBatchResponse(body, boundary) {
  const parts = body.split(`--${boundary}`);
  const results = [];
  for (const part of parts) {
    // Each part is: MIME headers, blank line, HTTP status line + headers,
    // blank line, then the JSON payload.
    const jsonStart = part.indexOf('{');
    if (jsonStart === -1) continue;
    const statusMatch = part.match(/HTTP\/[\d.]+\s+(\d{3})/);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    const contentId = part.match(/Content-ID:\s*response-([^\r\n]+)/i)?.[1]?.trim();
    // Trim any trailing CRLF/boundary remnants after the JSON object.
    const jsonEnd = part.lastIndexOf('}');
    if (jsonEnd <= jsonStart) continue;
    try {
      results.push({ contentId, status, data: JSON.parse(part.slice(jsonStart, jsonEnd + 1)) });
    } catch { /* skip an unparsable part rather than failing the page */ }
  }
  return results;
}

async function batchGetMessages(account, msgIds) {
  if (!msgIds.length) return new Map();
  const auth = getAuthClient(account);
  const out = new Map();

  for (let offset = 0; offset < msgIds.length; offset += BATCH_SIZE) {
    const chunk = msgIds.slice(offset, offset + BATCH_SIZE);
    const boundary = `hermes_batch_${Date.now()}_${offset}`;
    const query = `format=metadata&${META_HEADERS.map(h => `metadataHeaders=${h}`).join('&')}`;

    const body = chunk.map((id, i) => [
      `--${boundary}`,
      'Content-Type: application/http',
      `Content-ID: <item-${i}>`,
      '',
      `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?${query}`,
      '',
    ].join('\r\n')).join('\r\n') + `\r\n--${boundary}--\r\n`;

    const res = await auth.request({
      url: 'https://gmail.googleapis.com/batch/gmail/v1',
      method: 'POST',
      headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
      body,
      responseType: 'text',
    });

    const responseBoundary = String(res.headers?.['content-type'] || '').match(/boundary=(?:"([^"]+)"|([^;]+))/);
    const parsedBoundary = (responseBoundary?.[1] || responseBoundary?.[2] || '').trim();
    for (const part of parseBatchResponse(String(res.data), parsedBoundary || boundary)) {
      if (part.status >= 200 && part.status < 300 && part.data?.id) out.set(part.data.id, part.data);
    }
  }

  return out;
}

function messageToSummary(account, detail, folder) {
  const headers = detail.payload?.headers || [];
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  return {
    id: `${account.id}-${detail.id}`,
    gmailId: detail.id,
    from: getHeader('From'),
    to: [getHeader('To')],
    subject: getHeader('Subject') || '(no subject)',
    date: getHeader('Date') ? new Date(getHeader('Date')).toISOString() : new Date().toISOString(),
    read: !detail.labelIds?.includes('UNREAD'),
    starred: detail.labelIds?.includes('STARRED') ?? false,
    folder,
    accountId: account.id,
    snippet: detail.snippet || '',
    threadId: detail.threadId || null,
    messageId: getHeader('Message-ID'),
    inReplyTo: getHeader('In-Reply-To'),
  };
}

// Batch first; fall back to individual reads if the batch endpoint is
// unavailable (proxies occasionally reject multipart bodies).
async function fetchSummaries(account, msgIds, folder) {
  if (!msgIds.length) return [];
  try {
    const details = await batchGetMessages(account, msgIds);
    if (details.size) {
      return msgIds.map(id => details.get(id)).filter(Boolean).map(d => messageToSummary(account, d, folder));
    }
  } catch (err) {
    console.warn('[gmail] Batch metadata fetch failed, falling back to per-message reads:', err.message);
  }
  const gmail = getGmailClient(account);
  return Promise.all(msgIds.map(id => _fetchMessageMeta(gmail, account, id, folder)));
}

function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractBody(payload) {
  let html = '';
  let text = '';

  function processPart(part) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      html = decodeBase64(part.body.data);
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      text = decodeBase64(part.body.data);
    } else if (part.parts) {
      part.parts.forEach(processPart);
    }
  }

  if (payload.body?.data) {
    if (payload.mimeType === 'text/html') {
      html = decodeBase64(payload.body.data);
    } else {
      text = decodeBase64(payload.body.data);
    }
  }

  if (payload.parts) {
    payload.parts.forEach(processPart);
  }

  return { html, text };
}

function folderToLabelId(folder) {
  if (folder === 'Sent' || folder === 'SENT') return 'SENT';
  if (folder === 'Drafts' || folder === 'DRAFT') return 'DRAFT';
  if (folder === 'Trash' || folder === 'TRASH') return 'TRASH';
  if (folder === 'INBOX') return 'INBOX';
  return folder;
}

async function _fetchMessageMeta(gmail, account, msgId, folder) {
  const detail = await gmail.users.messages.get({
    userId: 'me', id: msgId, format: 'metadata',
    metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To']
  });
  const headers = detail.data.payload?.headers || [];
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  return {
    id: `${account.id}-${msgId}`,
    gmailId: msgId,
    from: getHeader('From'),
    to: [getHeader('To')],
    subject: getHeader('Subject') || '(no subject)',
    date: getHeader('Date') ? new Date(getHeader('Date')).toISOString() : new Date().toISOString(),
    read: !detail.data.labelIds?.includes('UNREAD'),
    starred: detail.data.labelIds?.includes('STARRED') ?? false,
    folder,
    accountId: account.id,
    snippet: detail.data.snippet || '',
    threadId: detail.data.threadId || null,
    messageId: getHeader('Message-ID'),
    inReplyTo: getHeader('In-Reply-To')
  };
}

async function fetchEmails(account, folder = 'INBOX', limit = 50, pageToken = null) {
  const gmail = getGmailClient(account);
  const listParams = { userId: 'me', labelIds: [folderToLabelId(folder)], maxResults: limit };
  if (pageToken) listParams.pageToken = pageToken;
  const listRes = await gmail.users.messages.list(listParams);
  const messages = listRes.data.messages || [];
  const emails = await fetchSummaries(account, messages.map(m => m.id), folder);
  return { emails, nextToken: listRes.data.nextPageToken || null };
}

async function searchEmails(account, query, limit = 50) {
  const gmail = getGmailClient(account);
  const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: limit });
  const messages = listRes.data.messages || [];
  return fetchSummaries(account, messages.map(m => m.id), 'search');
}

async function searchAttachments(account, query, type, folder = 'INBOX', limit = 50) {
  const gmail = getGmailClient(account);
  const parts = ['has:attachment'];
  if (folder) parts.push(`label:${folderToLabelId(folder)}`);
  if (query && query.trim()) parts.push(`filename:${query.trim()}`);
  if (type && type.trim()) {
    const t = type.trim().replace(/^\./, '');
    parts.push(`filename:${t}`);
  }
  const q = parts.join(' ');
  const listRes = await gmail.users.messages.list({ userId: 'me', q, maxResults: limit });
  const messages = listRes.data.messages || [];
  return fetchSummaries(account, messages.map(m => m.id), folder || 'search');
}

async function fetchEmailBody(account, gmailId) {
  const gmail = getGmailClient(account);

  const detail = await gmail.users.messages.get({
    userId: 'me',
    id: gmailId,
    format: 'full'
  });

  const headers = detail.data.payload?.headers || [];
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const { html, text } = extractBody(detail.data.payload);
  const messageId = getHeader('Message-ID');
  const references = getHeader('References');

  // Attachment *metadata* only. Bytes are pulled on demand by
  // GET /api/emails/:accountId/message/:emailId/attachment/:index so that
  // opening a message with a 20 MB PDF doesn't buffer it through the API.
  const attachments = [];
  let calendarText = '';
  function collectAttachments(part) {
    if (!part) return;
    // A meeting invite arrives as a text/calendar part which usually has no
    // filename at all, so it has to be matched on type before the filename
    // check below decides what counts as an attachment.
    const mimeType = part.mimeType || '';
    if (!calendarText && /^text\/calendar/i.test(mimeType) && part.body?.data) {
      calendarText = decodeBase64(part.body.data);
    }
    if (part.filename && part.body) {
      attachments.push({
        filename: part.filename,
        contentType: mimeType || 'application/octet-stream',
        size: part.body.size || 0,
        content: null,
        // Kept internally for the download endpoint; stripped before responding.
        attachmentId: part.body.attachmentId || null,
        inlineData: part.body.data || null,
      });
      if (!calendarText && /\.ics$/i.test(part.filename) && part.body.data) {
        calendarText = decodeBase64(part.body.data);
      }
    }
    if (part.parts) part.parts.forEach(collectAttachments);
  }
  collectAttachments(detail.data.payload);
  rememberAttachments(account, gmailId, attachments);

  return {
    gmailId,
    from: getHeader('From'),
    to: getHeader('To'),
    cc: getHeader('Cc'),
    subject: getHeader('Subject'),
    date: getHeader('Date') ? new Date(getHeader('Date')).toISOString() : '',
    html,
    text,
    attachments,
    // Threading info so replies can set In-Reply-To/References and stay in
    // the same Gmail thread.
    messageId,
    references,
    threadId: detail.data.threadId || null,
    authentication: authResults.summarize(getHeader('Authentication-Results'), getHeader('From')),
    calendarInvite: calendarText ? calendar.parseInvite(calendarText) : null,
  };
}

// Opening a message already walked its payload, so remember where each
// attachment lives. Downloading one used to re-issue a full format=full read
// of the entire message just to turn an index into an attachmentId.
const ATTACHMENT_MAP_LIMIT = 200;
const attachmentMaps = new Map(); // `${accountId}:${gmailId}` -> attachment metadata[]

function rememberAttachments(account, gmailId, attachments) {
  const key = `${account.id}:${gmailId}`;
  attachmentMaps.delete(key);
  attachmentMaps.set(key, attachments);
  // Map iteration is insertion-ordered, so the oldest key is the first one.
  while (attachmentMaps.size > ATTACHMENT_MAP_LIMIT) {
    attachmentMaps.delete(attachmentMaps.keys().next().value);
  }
}

// Pull one attachment's bytes on demand. `index` refers to the position in the
// attachment array returned by fetchEmailBody.
async function getAttachment(account, gmailId, index) {
  let att = attachmentMaps.get(`${account.id}:${gmailId}`)?.[index];
  if (!att) {
    const body = await fetchEmailBody(account, gmailId);
    att = body.attachments?.[index];
  }
  if (!att) throw new Error('Attachment not found');

  if (att.inlineData) {
    return {
      filename: att.filename,
      contentType: att.contentType,
      content: Buffer.from(att.inlineData.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    };
  }
  if (!att.attachmentId) throw new Error('Attachment has no downloadable content');

  const gmail = getGmailClient(account);
  const res = await gmail.users.messages.attachments.get({
    userId: 'me', messageId: gmailId, id: att.attachmentId,
  });
  return {
    filename: att.filename,
    contentType: att.contentType,
    content: Buffer.from(String(res.data.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
  };
}

// Fetch just the headers needed to thread a reply to this message.
async function getThreadingInfo(account, gmailId) {
  const gmail = getGmailClient(account);
  const detail = await gmail.users.messages.get({
    userId: 'me', id: gmailId, format: 'metadata',
    metadataHeaders: ['Message-ID', 'References']
  });
  const headers = detail.data.payload?.headers || [];
  const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  return { inReplyTo: get('Message-ID'), references: get('References'), threadId: detail.data.threadId || null };
}

// The complete RFC822 source, for mbox export.
async function getRawMessage(account, gmailId) {
  const gmail = getGmailClient(account);
  const detail = await gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'raw' });
  if (!detail.data.raw) return null;
  return Buffer.from(String(detail.data.raw).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function deleteEmail(account, gmailId) {
  const gmail = getGmailClient(account);
  await gmail.users.messages.trash({ userId: 'me', id: gmailId });
}

// Undo a delete. Gmail keeps the message id stable through the bin, so this
// restores it to exactly the labels it had.
async function untrashEmail(account, gmailId) {
  const gmail = getGmailClient(account);
  await gmail.users.messages.untrash({ userId: 'me', id: gmailId });
}

// Labels Gmail exposes but that make no sense as a mail folder in the UI.
const HIDDEN_LABEL_IDS = new Set(['CHAT', 'UNREAD', 'STARRED', 'IMPORTANT']);

async function getFolders(account) {
  const gmail = getGmailClient(account);
  const res = await gmail.users.labels.list({ userId: 'me' });

  // User-created labels have ids like "Label_12" — they are exactly what the
  // move menu is for, so they must be kept. Only genuinely non-navigable
  // system labels are filtered out.
  return (res.data.labels || [])
    .filter(l => !HIDDEN_LABEL_IDS.has(l.id))
    .map(l => ({
      name: l.name,
      path: l.id,
      // Gmail nests labels with "/" in the display name.
      delimiter: '/',
      userCreated: l.type === 'user',
    }))
    .sort((a, b) => {
      // System folders first, then user labels alphabetically.
      if (a.userCreated !== b.userCreated) return a.userCreated ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
}

// Unread counts come straight from the label metadata — one cheap call per
// folder instead of counting a page of fetched messages.
async function getUnreadCounts(account, folders = ['INBOX']) {
  const gmail = getGmailClient(account);
  const counts = {};
  await Promise.all(folders.map(async (folder) => {
    try {
      const { data } = await gmail.users.labels.get({ userId: 'me', id: folderToLabelId(folder) });
      counts[folder] = { unread: data.messagesUnread || 0, total: data.messagesTotal || 0 };
    } catch {
      counts[folder] = { unread: 0, total: 0 };
    }
  }));
  return counts;
}

// One `threads.get` with format=full returns every message in the conversation
// with its payload, so a thread costs a single request instead of two per
// message.
async function fetchThread(account, threadId) {
  const gmail = getGmailClient(account);
  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });

  return (thread.data.messages || []).map((msg) => {
    const folder = msg.labelIds?.includes('SENT') ? 'SENT' : 'INBOX';
    const headers = msg.payload?.headers || [];
    const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
    const { html, text } = extractBody(msg.payload);

    const attachments = [];
    (function collect(part) {
      if (!part) return;
      if (part.filename && part.body) {
        attachments.push({
          filename: part.filename,
          contentType: part.mimeType || 'application/octet-stream',
          size: part.body.size || 0,
          content: null,
        });
      }
      if (part.parts) part.parts.forEach(collect);
    })(msg.payload);

    return {
      summary: messageToSummary(account, msg, folder),
      body: {
        gmailId: msg.id,
        from: getHeader('From'),
        to: getHeader('To'),
        cc: getHeader('Cc'),
        subject: getHeader('Subject'),
        date: getHeader('Date') ? new Date(getHeader('Date')).toISOString() : '',
        html,
        text,
        attachments,
        messageId: getHeader('Message-ID'),
        references: getHeader('References'),
        threadId: msg.threadId || null,
      },
    };
  });
}

async function registerPushWatch(account, topicName) {
  const gmail = getGmailClient(account);
  return (await gmail.users.watch({ userId: 'me', requestBody: { topicName, labelIds: ['INBOX'], labelFilterBehavior: 'include' } })).data;
}

async function createFolder(account, name) {
  const gmail = getGmailClient(account);
  const result = await gmail.users.labels.create({ userId: 'me', requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
  return { name: result.data.name, path: result.data.id };
}

async function renameFolder(account, folderId, name) {
  const gmail = getGmailClient(account);
  const result = await gmail.users.labels.update({ userId: 'me', id: folderId, requestBody: { name } });
  return { name: result.data.name, path: result.data.id };
}

async function reportSpam(account, gmailId) {
  const gmail = getGmailClient(account);
  await gmail.users.messages.modify({ userId: 'me', id: gmailId, requestBody: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] } });
}

// The exact inverse, so "Reported as spam" can carry an Undo. Gmail keeps the
// message id stable across a label change, which is what makes this reachable
// at all.
async function unreportSpam(account, gmailId, folder = 'INBOX') {
  const gmail = getGmailClient(account);
  const restoreLabel = folder && folder !== 'search' ? folderToLabelId(folder) : 'INBOX';
  await gmail.users.messages.modify({
    userId: 'me', id: gmailId,
    requestBody: { addLabelIds: [restoreLabel], removeLabelIds: ['SPAM'] },
  });
}

function wrapBase64(b64) {
  return b64.match(/.{1,76}/g)?.join('\r\n') || b64;
}

// Header values come from user input and from replied-to messages. A bare CR
// or LF would end the header and let the rest of the value inject arbitrary
// headers (extra Bcc, forged From). Fold whitespace away before use.
function sanitizeHeaderValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

// RFC 2047-encode a header value when it contains non-ASCII characters.
function encodeHeader(value) {
  const safe = sanitizeHeaderValue(value);
  if (!safe || /^[\x20-\x7e]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?=`;
}

// Quote a filename for a Content-Disposition parameter without letting quotes
// or newlines break out of it.
function encodeFilename(name) {
  return sanitizeHeaderValue(name).replace(/["\\]/g, '_');
}

// Resolve the identity to send as: an explicit alias if the account allows it,
// otherwise the account's own address.
function resolveFrom(account, sendAs) {
  const wanted = sanitizeHeaderValue(sendAs?.email || '').toLowerCase();
  if (wanted && wanted !== String(account.email).toLowerCase()) {
    const alias = (account.aliases || []).find(a => String(a.email).toLowerCase() === wanted);
    if (alias) return { name: alias.name || account.name || alias.email, email: alias.email };
  }
  return { name: account.name || account.email, email: account.email };
}

// Strip markup down to readable text for the plain-text alternative part.
// Block-level tags become line breaks so the result keeps its shape instead of
// collapsing into one run-on paragraph.
function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(line => line.trim()).join('\n')
    .trim();
}

// Split an address list on commas that sit outside quoted display names, so
// `"Doe, Jane" <j@x.com>, bob@y.com` yields two addresses rather than three.
function splitAddresses(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  const out = [];
  let current = '';
  let inQuotes = false;
  for (const ch of String(value ?? '')) {
    if (ch === '"') { inQuotes = !inQuotes; current += ch; continue; }
    if (ch === ',' && !inQuotes) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out.map(a => a.trim()).filter(Boolean);
}

// RFC 2047-encode the display name of one address, leaving the addr-spec
// untouched. Without this a non-ASCII recipient name goes out as raw 8-bit and
// arrives as mojibake — the subject was already encoded, recipients were not.
function encodeAddress(address) {
  const safe = sanitizeHeaderValue(address);
  const match = safe.match(/^(.*?)\s*<([^>]+)>$/);
  if (!match) return safe;
  const name = match[1].replace(/^"|"$/g, '').trim();
  const addr = match[2].trim();
  return name ? `${encodeHeader(name)} <${addr}>` : `<${addr}>`;
}

function encodeAddressList(value) {
  return splitAddresses(value).map(encodeAddress).join(', ');
}

// Base64 with a declared transfer encoding, so a body line longer than the
// RFC 5322 limit of 998 octets can never be produced.
function mimePart(contentType, body) {
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(String(body ?? ''), 'utf8').toString('base64')),
  ].join('\r\n');
}

// Build a base64url-encoded RFC822 message for the Gmail send/draft endpoints.
function buildRawMessage(account, { to, cc, bcc, subject, text, html, attachments, inReplyTo, references, sendAs, autoSubmitted }) {
  const hasAttachments = attachments && attachments.length > 0;
  // References for a reply = the original's References + its Message-ID.
  const replyRefs = [references, inReplyTo].filter(Boolean).map(sanitizeHeaderValue).join(' ');
  const from = resolveFrom(account, sendAs);

  const headers = [
    `From: ${encodeHeader(from.name)} <${sanitizeHeaderValue(from.email)}>`,
    to  ? `To: ${encodeAddressList(to)}` : null,
    cc  ? `Cc: ${encodeAddressList(cc)}` : null,
    bcc ? `Bcc: ${encodeAddressList(bcc)}` : null,
    `Subject: ${encodeHeader(subject || '')}`,
    inReplyTo ? `In-Reply-To: ${sanitizeHeaderValue(inReplyTo)}` : null,
    replyRefs ? `References: ${replyRefs}` : null,
    // RFC 3834. Marks a vacation reply as machine-generated so the other end's
    // responder does not answer it — the other half of mail-loop prevention.
    autoSubmitted ? `Auto-Submitted: ${sanitizeHeaderValue(autoSubmitted)}` : null,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  // Every message carries a plain-text part alongside the HTML. HTML-only mail
  // costs real deliverability with spam filters, and labelling a plain-text
  // compose as text/html used to swallow any '<' the user typed.
  const plain = text || (html ? htmlToPlainText(html) : '');
  const bodyLines = [];

  if (html && plain) {
    const altBoundary = `----=_Alt_${Date.now()}`;
    bodyLines.push(
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      `--${altBoundary}`,
      mimePart('text/plain', plain),
      `--${altBoundary}`,
      mimePart('text/html', html),
      `--${altBoundary}--`,
    );
  } else if (html) {
    bodyLines.push(mimePart('text/html', html));
  } else {
    bodyLines.push(mimePart('text/plain', plain));
  }

  let rawMessage;

  if (hasAttachments) {
    const boundary = `----=_Part_${Date.now()}`;
    const attachmentParts = attachments.map(a => [
      `--${boundary}`,
      `Content-Type: ${sanitizeHeaderValue(a.contentType) || 'application/octet-stream'}; name="${encodeFilename(a.filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeFilename(a.filename)}"`,
      '',
      wrapBase64(a.content),
    ].join('\r\n'));

    rawMessage = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      ...bodyLines,
      ...attachmentParts,
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    rawMessage = [...headers, ...bodyLines].join('\r\n');
  }

  return Buffer.from(rawMessage, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail(account, draft) {
  const gmail = getGmailClient(account);
  const requestBody = { raw: buildRawMessage(account, draft) };
  // Keep the reply inside the original Gmail thread.
  if (draft.threadId) requestBody.threadId = draft.threadId;
  await gmail.users.messages.send({ userId: 'me', requestBody });
}

// Save a draft to the Gmail Drafts folder (synced to all clients).
async function saveDraft(account, draft) {
  const gmail = getGmailClient(account);
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw: buildRawMessage(account, draft) } }
  });
  return { type: 'gmail', id: res.data.id || null };
}

async function deleteDraft(account, ref) {
  if (!ref?.id) return;
  const gmail = getGmailClient(account);
  await gmail.users.drafts.delete({ userId: 'me', id: ref.id });
}

async function markAsRead(account, gmailId) {
  const gmail = getGmailClient(account);
  await gmail.users.messages.modify({
    userId: 'me', id: gmailId,
    requestBody: { removeLabelIds: ['UNREAD'] }
  });
}

async function markAsUnread(account, gmailId) {
  const gmail = getGmailClient(account);
  await gmail.users.messages.modify({
    userId: 'me', id: gmailId,
    requestBody: { addLabelIds: ['UNREAD'] }
  });
}

async function toggleStar(account, gmailId, starred) {
  const gmail = getGmailClient(account);
  await gmail.users.messages.modify({
    userId: 'me', id: gmailId,
    requestBody: starred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] }
  });
}

async function moveEmail(account, gmailId, fromFolder, toFolder) {
  const gmail = getGmailClient(account);
  // 'search' is a synthetic folder used for search results — not a real label.
  const fromLabel = fromFolder === 'search' ? 'INBOX' : folderToLabelId(fromFolder);
  // Gmail has no Archive label: archiving means removing the source label
  // (usually INBOX) so the message only remains in All Mail.
  if (/^archive$/i.test(toFolder) || /all ?mail/i.test(toFolder)) {
    await gmail.users.messages.modify({
      userId: 'me', id: gmailId,
      requestBody: { removeLabelIds: [fromLabel] }
    });
    return { id: gmailId };
  }
  const toLabel = folderToLabelId(toFolder);
  await gmail.users.messages.modify({
    userId: 'me', id: gmailId,
    requestBody: { addLabelIds: [toLabel], removeLabelIds: [fromLabel] }
  });
  // Gmail moves are label edits, so the id never changes and an undo can
  // address the message with the id it already has.
  return { id: gmailId };
}

module.exports = {
  getAuthUrl,
  handleCallback,
  fetchEmails,
  searchEmails,
  searchAttachments,
  fetchEmailBody,
  fetchThread,
  getThreadingInfo,
  getFolders,
  getUnreadCounts,
  getAttachment,
  getRawMessage,
  createFolder,
  renameFolder,
  reportSpam,
  unreportSpam,
  registerPushWatch,
  sendEmail,
  saveDraft,
  deleteDraft,
  markAsRead,
  markAsUnread,
  toggleStar,
  moveEmail,
  deleteEmail,
  untrashEmail,
};
