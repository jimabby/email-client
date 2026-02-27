const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

async function createImapClient(account) {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort || 993,
    secure: account.imapSecure !== false,
    auth: {
      user: account.email,
      pass: account.password
    },
    logger: false
  });
  return client;
}

async function fetchEmails(account, folder = 'INBOX', limit = 50) {
  const client = await createImapClient(account);
  const emails = [];

  try {
    await client.connect();
    const mailbox = await client.mailboxOpen(folder);
    const total = mailbox.exists;

    if (total === 0) return [];

    // Fetch the most recent emails
    const start = Math.max(1, total - limit + 1);
    const range = `${start}:${total}`;

    for await (const msg of client.fetch(range, {
      envelope: true,
      bodyStructure: true,
      uid: true,
      flags: true
    })) {
      emails.unshift({
        id: `${account.id}-${msg.uid}`,
        uid: msg.uid,
        from: msg.envelope.from?.[0]
          ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address}>`.trim()
          : 'Unknown',
        to: (msg.envelope.to || []).map(a => a.address),
        subject: msg.envelope.subject || '(no subject)',
        date: msg.envelope.date?.toISOString() || new Date().toISOString(),
        read: msg.flags.has('\\Seen'),
        folder,
        accountId: account.id
      });
    }
  } finally {
    await client.logout();
  }

  return emails;
}

async function fetchEmailBody(account, uid, folder = 'INBOX') {
  const client = await createImapClient(account);

  try {
    await client.connect();
    await client.mailboxOpen(folder);

    let rawEmail = null;
    for await (const msg of client.fetch(String(uid), { source: true }, { uid: true })) {
      rawEmail = msg.source;
    }

    if (!rawEmail) return null;

    const parsed = await simpleParser(rawEmail);

    return {
      uid,
      from: parsed.from?.text || '',
      to: parsed.to?.text || '',
      cc: parsed.cc?.text || '',
      subject: parsed.subject || '',
      date: parsed.date?.toISOString() || '',
      text: parsed.text || '',
      html: parsed.html || parsed.textAsHtml || '',
      attachments: (parsed.attachments || []).map(a => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size
      }))
    };
  } finally {
    await client.logout();
  }
}

async function getFolders(account) {
  const client = await createImapClient(account);

  try {
    await client.connect();
    const list = await client.list();
    return list.map(f => ({
      name: f.name,
      path: f.path,
      delimiter: f.delimiter
    }));
  } finally {
    await client.logout();
  }
}

async function sendEmail(account, { to, cc, bcc, subject, text, html }) {
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort || 587,
    secure: account.smtpSecure || false,
    auth: {
      user: account.email,
      pass: account.password
    },
    tls: { rejectUnauthorized: false }
  });

  const result = await transporter.sendMail({
    from: `${account.name || account.email} <${account.email}>`,
    to,
    cc,
    bcc,
    subject,
    text,
    html
  });

  return result;
}

async function markAsRead(account, uid, folder = 'INBOX') {
  const client = await createImapClient(account);
  try {
    await client.connect();
    await client.mailboxOpen(folder);
    await client.messageFlagsAdd({ uid: true }, [uid], ['\\Seen'], { uid: true });
  } finally {
    await client.logout();
  }
}

async function deleteEmail(account, uid, folder = 'INBOX') {
  const client = await createImapClient(account);
  try {
    await client.connect();
    await client.mailboxOpen(folder);
    await client.messageDelete({ uid: true }, [uid], { uid: true });
  } finally {
    await client.logout();
  }
}

async function testConnection(account) {
  const client = await createImapClient(account);
  try {
    await client.connect();
    await client.logout();
    return true;
  } catch (err) {
    throw new Error(`Connection failed: ${err.message}`);
  }
}

module.exports = {
  fetchEmails,
  fetchEmailBody,
  getFolders,
  sendEmail,
  markAsRead,
  deleteEmail,
  testConnection
};
