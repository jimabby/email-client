const { ConfidentialClientApplication } = require('@azure/msal-node');
const calendar = require('./calendarService');
const authResults = require('./authResultsService');

const SCOPES = ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read'];
const REDIRECT_URI = process.env.OUTLOOK_REDIRECT_URI || 'http://localhost:3001/api/auth/outlook/callback';

function createMsalApp() {
  return new ConfidentialClientApplication({
    auth: {
      clientId: process.env.OUTLOOK_CLIENT_ID,
      authority: 'https://login.microsoftonline.com/common',
      clientSecret: process.env.OUTLOOK_CLIENT_SECRET
    }
  });
}

async function getAuthUrl(state) {
  const msalApp = createMsalApp();
  const authCodeUrlParams = {
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    state
  };
  return await msalApp.getAuthCodeUrl(authCodeUrlParams);
}

async function handleCallback(code) {
  const msalApp = createMsalApp();
  const tokenRequest = {
    code,
    scopes: SCOPES,
    redirectUri: REDIRECT_URI
  };

  const response = await msalApp.acquireTokenByCode(tokenRequest);

  // Get user info
  const userRes = await graphRequest(response.accessToken, '/me?$select=mail,displayName,userPrincipalName');

  // Serialize the MSAL token cache so we can restore it later for silent token renewal
  const tokenCache = msalApp.getTokenCache().serialize();

  return {
    accessToken: response.accessToken,
    msalHomeAccountId: response.account?.homeAccountId || null,
    msalTokenCache: tokenCache,
    email: userRes.mail || userRes.userPrincipalName,
    name: userRes.displayName
  };
}

async function refreshAccessToken(account) {
  if (!account.msalTokenCache || !account.msalHomeAccountId) return account.accessToken;
  try {
    const msalApp = createMsalApp();
    msalApp.getTokenCache().deserialize(account.msalTokenCache);
    const accounts = await msalApp.getTokenCache().getAllAccounts();
    const msalAccount = accounts.find(a => a.homeAccountId === account.msalHomeAccountId);
    if (!msalAccount) return account.accessToken;
    const response = await msalApp.acquireTokenSilent({ scopes: SCOPES, account: msalAccount });
    if (response.accessToken && response.accessToken !== account.accessToken) {
      account.accessToken = response.accessToken;
      // Persist updated token cache and access token
      const store = require('../store');
      store.updateAccount(account.id, {
        accessToken: response.accessToken,
        msalTokenCache: msalApp.getTokenCache().serialize()
      });
    }
    return response.accessToken;
  } catch {
    return account.accessToken;
  }
}

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

// Graph hands back `@odata.nextLink` as an absolute URL. Prefixing it with the
// API root again produces a nonsense URL and breaks every "load more", so pass
// absolute values through untouched.
function graphUrl(pathOrUrl) {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${GRAPH_ROOT}${pathOrUrl}`;
}

async function graphRequest(accessToken, path, method = 'GET', body = null) {
  // Node 18+ ships a global fetch — no node-fetch dependency required.
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(graphUrl(path), options);
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Graph API error: ${res.status} ${error}`);
  }

  // Some endpoints (e.g. message /send) return 202/204 with an empty body.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const FOLDER_MAP = {
  'INBOX': 'inbox',
  'Sent': 'sentitems',
  'Drafts': 'drafts',
  'Trash': 'deleteditems',
  'Junk': 'junkemail',
  'Archive': 'archive'
};

// Turn "Name <a@b.com>, c@d.com" (string or array) into Graph recipient objects.
function toRecipients(value) {
  const parts = Array.isArray(value) ? value : String(value || '').split(',');
  return parts
    .map(p => {
      const s = String(p || '').trim();
      if (!s) return null;
      const m = s.match(/<([^>]+)>/);
      return { emailAddress: { address: (m ? m[1] : s).trim() } };
    })
    .filter(Boolean);
}

function _outlookMsgToSummary(account, msg, folder) {
  return {
    id: `${account.id}-${msg.id}`,
    outlookId: msg.id,
    from: msg.from?.emailAddress
      ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>`.trim()
      : '',
    to: (msg.toRecipients || []).map(r => r.emailAddress?.address),
    subject: msg.subject || '(no subject)',
    date: msg.receivedDateTime || new Date().toISOString(),
    read: msg.isRead,
    starred: msg.flag?.flagStatus === 'flagged',
    folder,
    accountId: account.id,
    snippet: msg.bodyPreview || '',
    threadId: msg.conversationId || null,
    messageId: msg.internetMessageId || ''
  };
}

const SELECT_FIELDS = 'id,from,toRecipients,subject,receivedDateTime,isRead,flag,bodyPreview,conversationId,internetMessageId';

async function graphRequestWithRefresh(account, path, method = 'GET', body = null) {
  try {
    return await graphRequest(account.accessToken, path, method, body);
  } catch (err) {
    // Match the status prefix this module emits, not any "401" appearing in an
    // error body (a message id can contain those digits).
    if (err.message && /^Graph API error: 401\b/.test(err.message)) {
      const freshToken = await refreshAccessToken(account);
      return await graphRequest(freshToken, path, method, body);
    }
    throw err;
  }
}

// Unread counts straight from the folder resource — one call, no message scan.
async function getUnreadCounts(account, folders = ['INBOX']) {
  const counts = {};
  await Promise.all(folders.map(async (folder) => {
    try {
      const folderPath = FOLDER_MAP[folder] || folder;
      const data = await graphRequestWithRefresh(
        account,
        `/me/mailFolders/${folderPath}?$select=unreadItemCount,totalItemCount`
      );
      counts[folder] = { unread: data?.unreadItemCount || 0, total: data?.totalItemCount || 0 };
    } catch {
      counts[folder] = { unread: 0, total: 0 };
    }
  }));
  return counts;
}

async function fetchEmails(account, folder = 'INBOX', limit = 50, pageToken = null) {
  const folderPath = FOLDER_MAP[folder] || folder;
  const url = pageToken || `/me/mailFolders/${folderPath}/messages?$top=${limit}&$select=${SELECT_FIELDS}&$orderby=receivedDateTime desc`;
  const data = await graphRequestWithRefresh(account, url);
  const emails = (data.value || []).map(msg => _outlookMsgToSummary(account, msg, folder));
  return { emails, nextToken: data['@odata.nextLink'] || null };
}

async function searchEmails(account, query, limit = 50) {
  const data = await graphRequestWithRefresh(
    account,
    `/me/messages?$search="${encodeURIComponent(query)}"&$top=${limit}&$select=${SELECT_FIELDS}`
  ).catch(() => ({ value: [] }));
  return (data.value || []).map(msg => _outlookMsgToSummary(account, msg, 'search'));
}

async function searchAttachments(account, query, type, folder = 'INBOX', limit = 50) {
  const parts = ['hasattachments:true'];
  if (query && query.trim()) parts.push(`attachment:${query.trim()}`);
  if (type && type.trim()) parts.push(`attachment:${type.trim()}`);
  const search = encodeURIComponent(parts.join(' AND '));

  const folderPath = FOLDER_MAP[folder] || folder;
  const path = folder ? `/me/mailFolders/${folderPath}/messages` : '/me/messages';
  const data = await graphRequestWithRefresh(
    account,
    `${path}?$search="${search}"&$top=${limit}&$select=${SELECT_FIELDS}`
  ).catch(() => ({ value: [] }));
  return (data.value || []).map(msg => _outlookMsgToSummary(account, msg, folder || 'search'));
}

async function fetchEmailBody(account, outlookId) {
  // $select on the attachments collection keeps contentBytes out of the
  // response — the bytes are fetched on demand by getAttachment instead.
  const [msg, attData] = await Promise.all([
    // internetMessageHeaders carries Authentication-Results; Graph omits it
    // unless it is asked for by name.
    graphRequestWithRefresh(account, `/me/messages/${outlookId}?$select=id,from,toRecipients,ccRecipients,subject,receivedDateTime,body,hasAttachments,internetMessageId,internetMessageHeaders`),
    graphRequestWithRefresh(account, `/me/messages/${outlookId}/attachments?$select=id,name,contentType,size`).catch(() => ({ value: [] })),
  ]);

  const header = (name) => (msg.internetMessageHeaders || [])
    .find(h => String(h.name || '').toLowerCase() === name)?.value || '';

  // Graph will not hand back an .ics body through the metadata $select, so the
  // one calendar attachment (if any) is fetched in full.
  let calendarText = '';
  const icsMeta = (attData?.value || []).find(a => calendar.isCalendarPart({
    contentType: a.contentType, filename: a.name,
  }));
  if (icsMeta?.id) {
    try {
      const full = await graphRequestWithRefresh(account, `/me/messages/${outlookId}/attachments/${icsMeta.id}`);
      if (full?.contentBytes) calendarText = Buffer.from(full.contentBytes, 'base64').toString('utf8');
    } catch { /* an unreadable invite is still a readable message */ }
  }

  const attachments = (attData?.value || [])
    .filter(a => !a['@odata.type'] || a['@odata.type'] === '#microsoft.graph.fileAttachment')
    .map(a => ({
      filename: a.name,
      contentType: a.contentType,
      size: a.size,
      content: null,
      graphAttachmentId: a.id,
    }));

  return {
    outlookId,
    from: msg.from?.emailAddress
      ? `${msg.from.emailAddress.name} <${msg.from.emailAddress.address}>`
      : '',
    to: (msg.toRecipients || []).map(r => r.emailAddress?.address).join(', '),
    cc: (msg.ccRecipients || []).map(r => r.emailAddress?.address).join(', '),
    subject: msg.subject || '',
    date: msg.receivedDateTime || '',
    html: msg.body?.contentType === 'html' ? msg.body.content : '',
    text: msg.body?.contentType === 'text' ? msg.body.content
      : msg.body?.content ? msg.body.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '',
    attachments,
    // RFC 822 Message-ID — used by other providers' reply headers. Outlook
    // replies themselves thread via the Graph createReply endpoint instead.
    messageId: msg.internetMessageId || '',
    authentication: authResults.summarize(
      header('authentication-results'),
      msg.from?.emailAddress?.address,
    ),
    calendarInvite: calendarText ? calendar.parseInvite(calendarText) : null,
  };
}

// Pull one attachment's bytes on demand, by position in the array returned
// from fetchEmailBody.
async function getAttachment(account, outlookId, index) {
  const body = await fetchEmailBody(account, outlookId);
  const att = body.attachments?.[index];
  if (!att?.graphAttachmentId) throw new Error('Attachment not found');

  const full = await graphRequestWithRefresh(
    account,
    `/me/messages/${outlookId}/attachments/${att.graphAttachmentId}`
  );
  if (!full?.contentBytes) throw new Error('Attachment has no downloadable content');
  return {
    filename: att.filename,
    contentType: att.contentType,
    content: Buffer.from(full.contentBytes, 'base64'),
  };
}

// Undo a delete. Graph keeps the message id stable across folders, so the
// message can simply be moved back out of Deleted Items.
async function untrashEmail(account, outlookId, toFolder = 'INBOX') {
  const destinationId = FOLDER_MAP[toFolder] || toFolder;
  await graphRequestWithRefresh(account, `/me/messages/${outlookId}/move`, 'POST', { destinationId });
}

// The complete RFC822 source, for mbox export. Graph exposes it at /$value,
// which returns raw bytes rather than JSON — so it bypasses graphRequest.
async function getRawMessage(account, outlookId) {
  const accessToken = await refreshAccessToken(account);
  const res = await fetch(`${GRAPH_ROOT}/me/messages/${outlookId}/$value`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function deleteEmail(account, outlookId) {
  await graphRequestWithRefresh(account, `/me/messages/${outlookId}`, 'DELETE');
}

async function getFolders(account) {
  const data = await graphRequestWithRefresh(account, '/me/mailFolders');
  return (data.value || []).map(f => ({
    name: f.displayName,
    path: f.id
  }));
}

async function fetchThread(account, conversationId) {
  const escaped = String(conversationId).replace(/'/g, "''");
  const data = await graphRequestWithRefresh(account, `/me/messages?$filter=conversationId eq '${escaped}'&$top=50&$select=${SELECT_FIELDS}`);
  return Promise.all((data.value || []).map(async msg => ({ summary: _outlookMsgToSummary(account, msg, 'conversation'), body: await fetchEmailBody(account, msg.id) })));
}

async function registerPushWatch(account, notificationUrl, clientState) {
  const expirationDateTime = new Date(Date.now() + 2.5 * 24 * 60 * 60 * 1000).toISOString();
  return graphRequestWithRefresh(account, '/subscriptions', 'POST', {
    changeType: 'created', notificationUrl, resource: '/me/mailFolders/inbox/messages', expirationDateTime, clientState
  });
}

async function createFolder(account, name) {
  const folder = await graphRequestWithRefresh(account, '/me/mailFolders', 'POST', { displayName: name });
  return { name: folder.displayName, path: folder.id };
}

async function renameFolder(account, folderId, name) {
  const folder = await graphRequestWithRefresh(account, `/me/mailFolders/${folderId}`, 'PATCH', { displayName: name });
  return { name: folder.displayName, path: folder.id };
}

async function reportSpam(account, outlookId) {
  await graphRequestWithRefresh(account, `/me/messages/${outlookId}/move`, 'POST', { destinationId: 'junkemail' });
}

// Send-as alias, if the account is configured for one. Graph only honours a
// custom `from` when the mailbox actually has SendAs rights; if it doesn't the
// request fails, so this is applied only for addresses the user registered.
function resolveFromRecipient(account, sendAs) {
  const wanted = String(sendAs?.email || '').trim().toLowerCase();
  if (!wanted || wanted === String(account.email).toLowerCase()) return null;
  const alias = (account.aliases || []).find(a => String(a.email).toLowerCase() === wanted);
  if (!alias) return null;
  return { emailAddress: { address: alias.email, name: alias.name || undefined } };
}

async function sendEmail(account, { to, cc, bcc, subject, text, html, attachments, replyToProviderId, sendAs }) {
  const message = {
    subject,
    body: {
      contentType: html ? 'HTML' : 'Text',
      content: html || text || ''
    },
    toRecipients: toRecipients(to),
    ccRecipients: toRecipients(cc),
    bccRecipients: toRecipients(bcc),
  };
  const fromRecipient = resolveFromRecipient(account, sendAs);
  if (fromRecipient) message.from = fromRecipient;
  const atts = (attachments || []).map(a => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: a.filename,
    contentBytes: a.content,
    contentType: a.contentType
  }));

  // Replies: sendMail can't set In-Reply-To (Graph only allows x- headers),
  // so create a reply draft — which Graph threads onto the conversation —
  // overwrite its content, and send it.
  if (replyToProviderId) {
    try {
      const draft = await graphRequestWithRefresh(account, `/me/messages/${replyToProviderId}/createReply`, 'POST', {});
      if (draft?.id) {
        await graphRequestWithRefresh(account, `/me/messages/${draft.id}`, 'PATCH', message);
        for (const att of atts) {
          await graphRequestWithRefresh(account, `/me/messages/${draft.id}/attachments`, 'POST', att);
        }
        await graphRequestWithRefresh(account, `/me/messages/${draft.id}/send`, 'POST', null);
        return;
      }
    } catch { /* original may be gone — fall through to a plain send */ }
  }

  await graphRequestWithRefresh(account, '/me/sendMail', 'POST', {
    message: { ...message, attachments: atts },
    saveToSentItems: true
  });
}

// Creating a message (POST /me/messages) saves it as a draft in the Drafts folder.
async function saveDraft(account, { to, cc, bcc, subject, text, html, attachments }) {
  const created = await graphRequestWithRefresh(account, '/me/messages', 'POST', {
    subject: subject || '',
    body: {
      contentType: html ? 'HTML' : 'Text',
      content: html || text || ''
    },
    toRecipients: toRecipients(to),
    ccRecipients: toRecipients(cc),
    bccRecipients: toRecipients(bcc),
    attachments: (attachments || []).map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentBytes: a.content,
      contentType: a.contentType
    }))
  });
  return { type: 'outlook', id: created?.id || null };
}

async function deleteDraft(account, ref) {
  if (!ref?.id) return;
  await graphRequestWithRefresh(account, `/me/messages/${ref.id}`, 'DELETE');
}

async function markAsRead(account, outlookId) {
  await graphRequestWithRefresh(account, `/me/messages/${outlookId}`, 'PATCH', { isRead: true });
}

async function markAsUnread(account, outlookId) {
  await graphRequestWithRefresh(account, `/me/messages/${outlookId}`, 'PATCH', { isRead: false });
}

async function toggleStar(account, outlookId, starred) {
  await graphRequestWithRefresh(account, `/me/messages/${outlookId}`, 'PATCH', {
    flag: { flagStatus: starred ? 'flagged' : 'notFlagged' }
  });
}

async function moveEmail(account, outlookId, toFolder) {
  const destinationId = FOLDER_MAP[toFolder] || toFolder;
  await graphRequestWithRefresh(account, `/me/messages/${outlookId}/move`, 'POST', { destinationId });
}

module.exports = {
  getAuthUrl,
  handleCallback,
  fetchEmails,
  searchEmails,
  searchAttachments,
  fetchEmailBody,
  fetchThread,
  getFolders,
  getUnreadCounts,
  getAttachment,
  getRawMessage,
  createFolder,
  renameFolder,
  reportSpam,
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
