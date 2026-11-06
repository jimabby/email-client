const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-device-keys-'));
process.env.HERMES_SECRET_KEY = '5'.repeat(64);

// IMAP stub: the stored message is whatever the test puts here.
const sent = [];
let stored = null;
require.cache[require.resolve('../services/imapService')] = { exports: {
  sendRaw: async (account, message) => { sent.push(message); },
  getRawMessage: async () => stored,
  fetchEmailBody: async () => ({ from: 'friend@example.org', subject: '[...]', text: '', html: '', attachments: [
    { filename: null, contentType: 'application/pgp-encrypted', size: 10, content: null },
    { filename: 'encrypted.asc', contentType: 'application/octet-stream', size: 999, content: null },
  ] }),
  markAsRead: async () => {},
  getThreadingInfo: async (account, uid, folder) => ({ inReplyTo: `<orig-${uid}@example.org>`, references: `<root@example.org> <${folder}@example.org>` }),
} };

const express = require('express');
const openpgp = require('openpgp');
const store = require('../store');
const pgp = require('../services/pgpService');
const queue = require('../services/sendQueueService');

const account = store.addAccount({ type: 'imap', email: 'me@example.com', name: 'Me' });
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/pgp', require('../routes/pgp'));
app.use('/api/emails', require('../routes/emails'));
let server, base;
let phoneKey;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // The phone's key: made elsewhere; the backend only ever sees its public half.
  phoneKey = await openpgp.generateKey({ userIDs: [{ email: 'me@example.com' }], format: 'armored' });
  await pgp.importContactKeys((await openpgp.generateKey({ userIDs: [{ email: 'friend@example.org' }], format: 'armored' })).publicKey);
});
test('a reply built on the phone can learn the Message-ID and References of the original', async () => {
  const id = encodeURIComponent(`${account.id}::Archive::42`);
  const res = await fetch(`${base}/api/emails/${account.id}/message/${id}/threading?folder=Archive`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { inReplyTo: '<orig-42@example.org>', references: '<root@example.org> <Archive@example.org>' });
});

test.after(async () => { await new Promise(resolve => server.close(resolve)); store.flush(); });

const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function pgpMime(armored, { from = 'Friend <friend@example.org>' } = {}) {
  return Buffer.from([
    `From: ${from}`, 'To: me@example.com', 'Subject: [...]', 'MIME-Version: 1.0',
    'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="xx"', '',
    '--xx', 'Content-Type: application/pgp-encrypted', '', 'Version: 1', '',
    '--xx', 'Content-Type: application/octet-stream; name="encrypted.asc"', '',
    armored.replace(/\r?\n/g, '\r\n'), '--xx--', '',
  ].join('\r\n'));
}

test('the backend hands over the encrypted part untouched, without holding any private key', async () => {
  assert.deepEqual(store.getPgpKeys().identities, {}, 'no private key on this backend');
  const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'for the phone only' }), encryptionKeys: await openpgp.readKey({ armoredKey: phoneKey.publicKey }) });
  stored = pgpMime(armored);

  const res = await fetch(`${base}/api/emails/${account.id}/message/${encodeURIComponent(`${account.id}::INBOX::1`)}/pgp-payload?folder=INBOX`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const payload = await res.json();
  assert.equal(payload.kind, 'pgp-mime');
  assert.equal(payload.from, 'Friend <friend@example.org>');
  // The phone can open it; the backend could not.
  const opened = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: payload.armored }), decryptionKeys: await openpgp.readPrivateKey({ armoredKey: phoneKey.privateKey }) });
  assert.equal(opened.data, 'for the phone only');

  const body = await (await fetch(`${base}/api/emails/${account.id}/message/${encodeURIComponent(`${account.id}::INBOX::1`)}?folder=INBOX`)).json();
  assert.equal(body.pgp.decrypted, false, 'server-side decrypt is impossible, as intended');
});

test('inline PGP is extracted too; ordinary mail has no payload', async () => {
  const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'inline' }), encryptionKeys: await openpgp.readKey({ armoredKey: phoneKey.publicKey }) });
  stored = Buffer.from(`From: friend@example.org\r\nContent-Type: text/plain\r\n\r\nHi\r\n${armored.replace(/\r?\n/g, '\r\n')}\r\n`);
  assert.equal((await pgp.encryptedPayload(stored)).kind, 'inline');
  stored = Buffer.from('From: a@b.example\r\nContent-Type: text/plain\r\n\r\nplain\r\n');
  assert.equal((await fetch(`${base}/api/emails/${account.id}/message/x/pgp-payload`)).status, 404);
});

test('public keys are listed for on-device encryption; nothing private', async () => {
  const { keys } = await (await fetch(`${base}/api/pgp/public-keys`)).json();
  assert.equal(keys[0].email, 'friend@example.org');
  assert.match(keys[0].publicKey, /PUBLIC KEY/);
  assert.ok(!JSON.stringify(keys).includes('PRIVATE'));
});

const prebuilt = (from = 'Me <me@example.com>') => Buffer.from([
  `From: ${from}`, 'To: friend@example.org', 'Bcc: secret-watcher@example.net', 'Subject: [...]', 'MIME-Version: 1.0',
  'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="yy"', '',
  '--yy', 'Content-Type: application/pgp-encrypted', '', 'Version: 1', '',
  '--yy', 'Content-Type: application/octet-stream', '', '-----BEGIN PGP MESSAGE-----', '', 'opaque', '-----END PGP MESSAGE-----', '--yy--', '',
].join('\r\n')).toString('base64');

test('a message encrypted on the device is queued and delivered byte for byte, Bcc off the wire', async () => {
  const res = await post(`/api/emails/${account.id}/send-prebuilt`, { raw: prebuilt(), requestId: 'device-send-0001' });
  assert.equal(res.status, 200);
  const { jobId } = await res.json();
  assert.equal(store.getSendQueueItem(jobId).subject, '[...]', 'the outbox never learns the subject');
  await queue.processDueSends();
  const message = sent.at(-1);
  assert.equal(message.raw.toString('base64'), prebuilt());
  assert.doesNotMatch(message.rawForSmtp.toString(), /^Bcc:/m);
  assert.deepEqual(message.envelope.to.sort(), ['friend@example.org', 'secret-watcher@example.net']);
});

test('prebuilt sends must come from the account, and their content cannot be edited', async () => {
  assert.equal((await post(`/api/emails/${account.id}/send-prebuilt`, { raw: prebuilt('Spoof <ceo@other.example>') })).status, 400);
  assert.equal((await post(`/api/emails/${account.id}/send-prebuilt`, { raw: '' })).status, 400);
  const { jobId } = await (await post(`/api/emails/${account.id}/send-prebuilt`, { raw: prebuilt(), requestId: 'device-send-0002', sendAt: new Date(Date.now() + 3600_000).toISOString() })).json();
  assert.throws(() => queue.editQueuedSend(jobId, { to: 'someone@else.example', subject: 'x' }), /encrypted on your device/);
  const later = new Date(Date.now() + 7200_000).toISOString();
  assert.equal(queue.editQueuedSend(jobId, { to: 'friend@example.org', sendAt: later }).sendAt, later);
});
