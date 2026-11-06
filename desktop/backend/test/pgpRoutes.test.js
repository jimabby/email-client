const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pgp-routes-'));
process.env.HERMES_SECRET_KEY = '9'.repeat(64);

// IMAP stub: records what is sent and serves it back as the stored message.
const sent = { raw: [], plain: [], drafts: [] };
let stored = null;
require.cache[require.resolve('../services/imapService')] = { exports: {
  sendRaw: async (account, message) => { sent.raw.push(message); stored = message.raw; },
  sendEmail: async (account, email) => { sent.plain.push(email); },
  saveDraft: async (account, draft) => { sent.drafts.push({ plain: draft }); return { type: 'imap', uid: sent.drafts.length, mailbox: 'Drafts' }; },
  saveRawDraft: async (account, message) => { sent.drafts.push({ raw: message.raw }); return { type: 'imap', uid: sent.drafts.length, mailbox: 'Drafts' }; },
  deleteDraft: async () => {},
  fetchEmailBody: async () => ({
    from: 'Me <me@example.com>', subject: 'Plans', text: 'This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)',
    html: '', attachments: [
      { filename: null, contentType: 'application/pgp-encrypted', size: 10, content: null },
      { filename: 'encrypted.asc', contentType: 'application/octet-stream', size: 999, content: null },
    ],
  }),
  getRawMessage: async () => stored,
  getAttachment: async () => ({ filename: 'encrypted.asc', contentType: 'application/octet-stream', content: Buffer.from('ciphertext') }),
  markAsRead: async () => {},
} };

const express = require('express');
const openpgp = require('openpgp');
const store = require('../store');
const queue = require('../services/sendQueueService');

const account = store.addAccount({ type: 'imap', email: 'me@example.com', name: 'Me' });
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/pgp', require('../routes/pgp'));
app.use('/api/emails', require('../routes/emails'));

let server, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); store.flush(); });

const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('key management round trip over the API', async () => {
  const made = await post('/api/pgp/identities', { email: 'me@example.com', name: 'Me' });
  assert.equal(made.status, 201);
  const friend = await openpgp.generateKey({ userIDs: [{ email: 'friend@example.org' }], format: 'armored' });
  assert.equal((await post('/api/pgp/contacts', { armoredKey: friend.publicKey })).status, 201);

  const keys = await (await fetch(base + '/api/pgp/keys')).json();
  assert.equal(keys.identities.length, 1);
  assert.equal(keys.contacts[0].email, 'friend@example.org');
  assert.ok(!JSON.stringify(keys).includes('PRIVATE KEY'), 'no private key ever leaves via the listing');

  const pub = await fetch(base + '/api/pgp/identities/me@example.com/public');
  assert.match(await pub.text(), /BEGIN PGP PUBLIC KEY/);

  assert.equal((await post('/api/pgp/identities/me@example.com/export', { passphrase: 'short' })).status, 400);
  const backup = await (await post('/api/pgp/identities/me@example.com/export', { passphrase: 'long enough passphrase' })).json();
  const locked = await openpgp.readPrivateKey({ armoredKey: backup.armoredKey });
  assert.equal(locked.isDecrypted(), false, 'the exported copy is passphrase-protected');

  const ready = await (await post('/api/pgp/readiness', { from: 'me@example.com', to: 'friend@example.org, nokey@x.example' })).json();
  assert.deepEqual(ready.missing, ['nokey@x.example']);
});

test('the send route refuses to queue an encrypted message with a missing key', async () => {
  const res = await post(`/api/emails/${account.id}/send`, { to: 'nokey@x.example', subject: 'x', text: 'y', pgp: { encrypt: true } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'PGP_MISSING_KEYS');
  assert.deepEqual(body.missing, ['nokey@x.example']);
  assert.equal(store.getSendQueue().some(job => job.email?.to === 'nokey@x.example'), false, 'nothing was queued');
});

test('an encrypted send goes out as PGP/MIME through the queue, never as plaintext', async () => {
  const res = await post(`/api/emails/${account.id}/send`, {
    to: 'friend@example.org', subject: 'Plans', text: 'Meet at noon.',
    attachments: [{ filename: 'map.txt', contentType: 'text/plain', content: Buffer.from('north gate').toString('base64') }],
    pgp: { encrypt: true, sign: true },
  });
  assert.equal(res.status, 200);
  await queue.processDueSends();
  assert.equal(sent.plain.length, 0);
  assert.equal(sent.raw.length, 1);
  assert.doesNotMatch(sent.raw[0].rawForSmtp.toString(), /Meet at noon|north gate/);
});

test('reading it back decrypts in the response, and attachments come from the decrypted copy', async () => {
  const body = await (await fetch(`${base}/api/emails/${account.id}/message/${encodeURIComponent(`${account.id}::INBOX::5`)}?folder=INBOX`)).json();
  assert.equal(body.pgp.encrypted, true);
  assert.equal(body.pgp.decrypted, true);
  assert.equal(body.pgp.status, 'verified');
  assert.match(body.text, /Meet at noon\./);
  assert.equal(body.subject, 'Plans', "the protected subject replaces the provider's [...]");
  assert.deepEqual(body.attachments.map(a => a.filename), ['map.txt']);
  assert.equal(body.attachments[0].content, null, 'bytes are fetched separately');

  const file = await fetch(`${base}/api/emails/${account.id}/message/${encodeURIComponent(`${account.id}::INBOX::5`)}/attachment/0?folder=INBOX&pgp=1`);
  assert.equal(await file.text(), 'north gate');

  // The offline cache keeps the provider's (encrypted) copy, not the plaintext.
  const cached = store.getEmailCache(`body:${account.id}:${account.id}::INBOX::5:INBOX`);
  assert.doesNotMatch(JSON.stringify(cached), /Meet at noon/);
});

test('an attachment key can be imported straight from a message', async () => {
  const other = await openpgp.generateKey({ userIDs: [{ email: 'colleague@example.net' }], format: 'armored' });
  const { loadAttachment } = require('../routes/emails')._internals;
  assert.equal(typeof loadAttachment, 'function');
  const imapStub = require.cache[require.resolve('../services/imapService')].exports;
  const previous = imapStub.getAttachment;
  imapStub.getAttachment = async () => ({ filename: 'key.asc', contentType: 'application/pgp-keys', content: Buffer.from(other.publicKey) });
  try {
    const res = await post('/api/pgp/contacts/from-attachment', { accountId: account.id, emailId: `${account.id}::INBOX::77`, index: 0, folder: 'INBOX' });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).imported[0].email, 'colleague@example.net');
  } finally { imapStub.getAttachment = previous; }
});

test('a draft of an encrypted message is stored encrypted to its author, even before recipients have keys', async () => {
  const res = await post(`/api/emails/${account.id}/drafts`, {
    to: 'nokey@x.example', subject: 'Unfinished plan', text: 'Draft secret', draftId: 'draft-pgp-0001', pgp: { encrypt: true },
  });
  assert.equal(res.status, 200);
  const saved = sent.drafts.at(-1);
  assert.ok(saved.raw, 'went through the raw (encrypted) path');
  const wire = saved.raw.toString();
  assert.match(wire, /multipart\/encrypted/);
  assert.match(wire, /^Subject: \[\.\.\.\]$/m);
  assert.doesNotMatch(wire, /Draft secret|Unfinished plan/);

  // Hermes can open its own encrypted draft.
  const opened = await require('../services/pgpService').open(saved.raw);
  assert.equal(opened.subject, 'Unfinished plan');
  assert.match(opened.text, /Draft secret/);
});

test('an ordinary draft still uses the provider path', async () => {
  const res = await post(`/api/emails/${account.id}/drafts`, { to: 'a@b.example', subject: 'Plain', text: 'Hello', draftId: 'draft-plain-0001' });
  assert.equal(res.status, 200);
  assert.equal(sent.drafts.at(-1).plain.subject, 'Plain');
});
