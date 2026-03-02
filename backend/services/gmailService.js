const { google } = require('googleapis');

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'http://localhost:3001/api/auth/gmail/callback'
  );
}

function getAuthUrl() {
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
    prompt: 'consent'
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

function getGmailClient(account) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken
  });

  // Auto-refresh tokens
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      account.refreshToken = tokens.refresh_token;
    }
    account.accessToken = tokens.access_token;
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
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

async function fetchEmails(account, folder = 'INBOX', limit = 50) {
  const gmail = getGmailClient(account);
  const labelId = folder === 'INBOX' ? 'INBOX' :
    folder === 'Sent' ? 'SENT' :
    folder === 'Drafts' ? 'DRAFT' :
    folder === 'Trash' ? 'TRASH' : 'INBOX';

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    labelIds: [labelId],
    maxResults: limit
  });

  const messages = listRes.data.messages || [];

  const emails = await Promise.all(
    messages.slice(0, limit).map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date']
      });

      const headers = detail.data.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      return {
        id: `${account.id}-${msg.id}`,
        gmailId: msg.id,
        from: getHeader('From'),
        to: [getHeader('To')],
        subject: getHeader('Subject') || '(no subject)',
        date: getHeader('Date') ? new Date(getHeader('Date')).toISOString() : new Date().toISOString(),
        read: !detail.data.labelIds?.includes('UNREAD'),
        folder,
        accountId: account.id,
        snippet: detail.data.snippet || ''
      };
    })
  );

  return emails;
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

  // Extract attachments from payload parts
  const attachments = [];
  function collectAttachments(part) {
    if (!part) return;
    if (part.filename && part.body) {
      const att = {
        filename: part.filename,
        contentType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
        content: null,
        attachmentId: part.body.attachmentId || null,
      };
      // Small attachments: data is inline (base64url → base64)
      if (part.body.data) {
        att.content = part.body.data.replace(/-/g, '+').replace(/_/g, '/');
      }
      attachments.push(att);
    }
    if (part.parts) part.parts.forEach(collectAttachments);
  }
  collectAttachments(detail.data.payload);

  // Fetch content for large attachments that only have an attachmentId
  await Promise.all(attachments.map(async (att) => {
    if (!att.content && att.attachmentId) {
      try {
        const res = await gmail.users.messages.attachments.get({
          userId: 'me', messageId: gmailId, id: att.attachmentId
        });
        att.content = res.data.data.replace(/-/g, '+').replace(/_/g, '/');
      } catch { /* skip if fetch fails */ }
    }
    delete att.attachmentId;
  }));

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
  };
}

async function deleteEmail(account, gmailId) {
  const gmail = getGmailClient(account);
  await gmail.users.messages.trash({ userId: 'me', id: gmailId });
}

async function getFolders(account) {
  const gmail = getGmailClient(account);
  const res = await gmail.users.labels.list({ userId: 'me' });

  return (res.data.labels || [])
    .filter(l => !l.id.startsWith('Label_'))
    .map(l => ({ name: l.name, path: l.id }));
}

function wrapBase64(b64) {
  return b64.match(/.{1,76}/g)?.join('\r\n') || b64;
}

async function sendEmail(account, { to, cc, bcc, subject, text, html, attachments }) {
  const gmail = getGmailClient(account);
  const hasAttachments = attachments && attachments.length > 0;

  const headers = [
    `From: ${account.name || account.email} <${account.email}>`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    cc  ? `Cc: ${cc}`   : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  let rawMessage;

  if (hasAttachments) {
    const boundary = `----=_Part_${Date.now()}`;
    const bodyB64 = wrapBase64(Buffer.from(html || text || '').toString('base64'));

    const bodyPart = [
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      bodyB64,
    ].join('\r\n');

    const attachmentParts = attachments.map(a => [
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      wrapBase64(a.content),
    ].join('\r\n'));

    rawMessage = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      bodyPart,
      ...attachmentParts,
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    rawMessage = [
      ...headers,
      'Content-Type: text/html; charset=utf-8',
      '',
      html || text || '',
    ].join('\r\n');
  }

  const encodedMessage = Buffer.from(rawMessage).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage }
  });
}

async function markAsRead(account, gmailId) {
  const gmail = getGmailClient(account);
  await gmail.users.messages.modify({
    userId: 'me',
    id: gmailId,
    requestBody: { removeLabelIds: ['UNREAD'] }
  });
}

module.exports = {
  getAuthUrl,
  handleCallback,
  fetchEmails,
  fetchEmailBody,
  getFolders,
  sendEmail,
  markAsRead,
  deleteEmail,
};
