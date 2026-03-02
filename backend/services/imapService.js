const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

// ─── IMAP Connection Pool ─────────────────────────────────────────────────────
// One persistent connection per account. All operations are serialized through
// a queue so we never open two mailboxes concurrently on the same connection.

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
      try {
        return await fn(this.client);
      } catch (err) {
        if (!this.client || !this.client.usable) this.client = null;
        throw err;
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
  if (!imapPool.has(account.id)) {
    imapPool.set(account.id, new ImapConnection(account));
  }
  return imapPool.get(account.id);
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

const smtpPool = new Map(); // accountId -> nodemailer transporter

function getTransporter(account) {
  if (smtpPool.has(account.id)) return smtpPool.get(account.id);
  const t = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort || 587,
    secure: account.smtpSecure || false,
    auth: { user: account.email, pass: account.password },
    tls: { rejectUnauthorized: false },
    pool: true,        // keep SMTP connections alive
    maxConnections: 1
  });
  smtpPool.set(account.id, t);
  return t;
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function fetchEmails(account, folder = 'INBOX', limit = 50) {
  return getConn(account).run(async (client) => {
    const emails = [];
    const mailbox = await client.mailboxOpen(folder);
    const total = mailbox.exists;
    if (total === 0) return [];

    const start = Math.max(1, total - limit + 1);
    for await (const msg of client.fetch(`${start}:${total}`, {
      envelope: true,
      bodyStructure: true,
      uid: true,
      flags: true
    })) {
      emails.unshift({
        id: `${account.id}::${msg.uid}`,
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
    return emails;
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
        size: a.size,
        content: a.content ? a.content.toString('base64') : null,
      }))
    };
  });
}

async function getFolders(account) {
  return getConn(account).run(async (client) => {
    const list = await client.list();
    return list.map(f => ({ name: f.name, path: f.path, delimiter: f.delimiter }));
  });
}

async function sendEmail(account, { to, cc, bcc, subject, text, html, attachments }) {
  const transporter = getTransporter(account);
  return transporter.sendMail({
    from: `${account.name || account.email} <${account.email}>`,
    to, cc, bcc, subject, text, html,
    attachments: (attachments || []).map(a => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'base64'),
      contentType: a.contentType
    }))
  });
}

async function markAsRead(account, uid, folder = 'INBOX') {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
  });
}

async function deleteEmail(account, uid, folder = 'INBOX') {
  return getConn(account).run(async (client) => {
    await client.mailboxOpen(folder);
    await client.messageDelete(String(uid), { uid: true });
  });
}

async function testConnection(account) {
  // Use a fresh client for connection tests (don't pollute the pool).
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort || 993,
    secure: account.imapSecure !== false,
    auth: { user: account.email, pass: account.password },
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
  fetchEmails,
  fetchEmailBody,
  getFolders,
  sendEmail,
  markAsRead,
  deleteEmail,
  testConnection,
  closeConnection
};
