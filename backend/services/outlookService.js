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

async function graphRequestWithRefresh(account, path, method = 'GET', body = null) {
  try {
    return await graphRequest(account.accessToken, path, method, body);
  } catch (err) {
    if (err.message && err.message.includes('401')) {
      const freshToken = await refreshAccessToken(account);
      return await graphRequest(freshToken, path, method, body);
    }
    throw err;
  }
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
  const [msg, attData] = await Promise.all([
    graphRequestWithRefresh(account, `/me/messages/${outlookId}?$select=id,from,toRecipients,ccRecipients,subject,receivedDateTime,body,hasAttachments`),
    graphRequestWithRefresh(account, `/me/messages/${outlookId}/attachments`).catch(() => ({ value: [] })),
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
    text: msg.body?.contentType === 'text' ? msg.body.content
      : msg.body?.content ? msg.body.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '',
    attachments,
  };
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

async function sendEmail(account, { to, cc, bcc, subject, text, html, attachments }) {
  const toArray = Array.isArray(to) ? to : [to];

  await graphRequestWithRefresh(account, '/me/sendMail', 'POST', {
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
  getFolders,
  sendEmail,
  markAsRead,
  markAsUnread,
  toggleStar,
  moveEmail,
  deleteEmail,
};
