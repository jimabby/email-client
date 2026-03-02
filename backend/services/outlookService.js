const { ConfidentialClientApplication } = require('@azure/msal-node');

const SCOPES = ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read'];
const REDIRECT_URI = 'http://localhost:3001/api/auth/outlook/callback';

function createMsalApp() {
  return new ConfidentialClientApplication({
    auth: {
      clientId: process.env.OUTLOOK_CLIENT_ID,
      authority: 'https://login.microsoftonline.com/common',
      clientSecret: process.env.OUTLOOK_CLIENT_SECRET
    }
  });
}

async function getAuthUrl() {
  const msalApp = createMsalApp();
  const authCodeUrlParams = {
    scopes: SCOPES,
    redirectUri: REDIRECT_URI
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

  return {
    accessToken: response.accessToken,
    refreshToken: response.account?.homeAccountId,
    accountId: response.account?.homeAccountId,
    email: userRes.mail || userRes.userPrincipalName,
    name: userRes.displayName
  };
}

async function graphRequest(accessToken, path, method = 'GET', body = null) {
  const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, options);
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Graph API error: ${res.status} ${error}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

const FOLDER_MAP = {
  'INBOX': 'inbox',
  'Sent': 'sentitems',
  'Drafts': 'drafts',
  'Trash': 'deleteditems',
  'Junk': 'junkemail'
};

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
    snippet: msg.bodyPreview || ''
  };
}

const SELECT_FIELDS = 'id,from,toRecipients,subject,receivedDateTime,isRead,flag,bodyPreview';

async function fetchEmails(account, folder = 'INBOX', limit = 50, pageToken = null) {
  const folderPath = FOLDER_MAP[folder] || folder;
  const url = pageToken || `/me/mailFolders/${folderPath}/messages?$top=${limit}&$select=${SELECT_FIELDS}&$orderby=receivedDateTime desc`;
  const data = await graphRequest(account.accessToken, url);
  const emails = (data.value || []).map(msg => _outlookMsgToSummary(account, msg, folder));
  return { emails, nextToken: data['@odata.nextLink'] || null };
}

async function searchEmails(account, query, limit = 50) {
  const data = await graphRequest(
    account.accessToken,
    `/me/messages?$search="${encodeURIComponent(query)}"&$top=${limit}&$select=${SELECT_FIELDS}`
  ).catch(() => ({ value: [] }));
  return (data.value || []).map(msg => _outlookMsgToSummary(account, msg, 'search'));
}

async function fetchEmailBody(account, outlookId) {
  const [msg, attData] = await Promise.all([
    graphRequest(account.accessToken, `/me/messages/${outlookId}?$select=id,from,toRecipients,ccRecipients,subject,receivedDateTime,body,hasAttachments`),
    graphRequest(account.accessToken, `/me/messages/${outlookId}/attachments`).catch(() => ({ value: [] })),
  ]);

  const attachments = (attData?.value || [])
    .filter(a => a['@odata.type'] === '#microsoft.graph.fileAttachment')
    .map(a => ({
      filename: a.name,
      contentType: a.contentType,
      size: a.size,
      content: a.contentBytes || null,
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
    text: msg.body?.contentType === 'text' ? msg.body.content : '',
    attachments,
  };
}

async function deleteEmail(account, outlookId) {
  await graphRequest(account.accessToken, `/me/messages/${outlookId}`, 'DELETE');
}

async function getFolders(account) {
  const data = await graphRequest(account.accessToken, '/me/mailFolders');
  return (data.value || []).map(f => ({
    name: f.displayName,
    path: f.id
  }));
}

async function sendEmail(account, { to, cc, bcc, subject, text, html, attachments }) {
  const toArray = Array.isArray(to) ? to : [to];

  await graphRequest(account.accessToken, '/me/sendMail', 'POST', {
    message: {
      subject,
      body: {
        contentType: html ? 'HTML' : 'Text',
        content: html || text || ''
      },
      toRecipients: toArray.filter(Boolean).map(addr => ({
        emailAddress: { address: addr }
      })),
      ccRecipients: cc ? [{ emailAddress: { address: cc } }] : [],
      bccRecipients: bcc ? [{ emailAddress: { address: bcc } }] : [],
      attachments: (attachments || []).map(a => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.filename,
        contentBytes: a.content,
        contentType: a.contentType
      }))
    },
    saveToSentItems: true
  });
}

async function markAsRead(account, outlookId) {
  await graphRequest(account.accessToken, `/me/messages/${outlookId}`, 'PATCH', { isRead: true });
}

async function markAsUnread(account, outlookId) {
  await graphRequest(account.accessToken, `/me/messages/${outlookId}`, 'PATCH', { isRead: false });
}

async function toggleStar(account, outlookId, starred) {
  await graphRequest(account.accessToken, `/me/messages/${outlookId}`, 'PATCH', {
    flag: { flagStatus: starred ? 'flagged' : 'notFlagged' }
  });
}

async function moveEmail(account, outlookId, toFolder) {
  const destinationId = FOLDER_MAP[toFolder] || toFolder;
  await graphRequest(account.accessToken, `/me/messages/${outlookId}/move`, 'POST', { destinationId });
}

module.exports = {
  getAuthUrl,
  handleCallback,
  fetchEmails,
  searchEmails,
  fetchEmailBody,
  getFolders,
  sendEmail,
  markAsRead,
  markAsUnread,
  toggleStar,
  moveEmail,
  deleteEmail,
};
