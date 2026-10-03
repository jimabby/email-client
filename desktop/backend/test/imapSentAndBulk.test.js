const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-imap-'));
process.env.HERMES_SECRET_KEY = 'b'.repeat(64);
fs.writeFileSync(path.join(process.env.HERMES_DATA_DIR, 'accounts.json'), '{"accounts":[],"aiSettings":{}}');

// A fake IMAP server: records every command the service issues.
const calls = [];
const FOLDERS = [
  { name: 'INBOX', path: 'INBOX' },
  { name: 'Sent', path: 'Sent', specialUse: '\\Sent' },
  { name: 'Trash', path: 'Trash', specialUse: '\\Trash' },
  { name: 'Archive', path: 'Archive' },
];
class FakeImapFlow {
  constructor() { this.usable = true; }
  on() {}
  async connect() {}
  async logout() {}
  close() {}
  async list() { return FOLDERS; }
  async mailboxOpen(name) { calls.push(['open', name]); return { exists: 0 }; }
  async append(mailbox, raw, flags, date) { calls.push(['append', mailbox, raw.toString(), flags, date]); return { uid: 99 }; }
  async messageFlagsAdd(set, flags) { calls.push(['flagsAdd', set, flags]); }
  async messageFlagsRemove(set, flags) { calls.push(['flagsRemove', set, flags]); }
  async messageMove(set, to) { calls.push(['move', set, to]); return {}; }
  async messageDelete(set) { calls.push(['delete', set]); }
}
require.cache[require.resolve('imapflow')] = { exports: { ImapFlow: FakeImapFlow } };

// A fake SMTP transport: records what went on the wire.
const nodemailer = require('nodemailer');
const sent = [];
let smtpFails = false;
nodemailer.createTransport = () => ({
  sendMail: async (options) => {
    if (smtpFails) throw new Error('ECONNRESET');
    sent.push(options);
    return { messageId: options.messageId };
  },
  close() {},
});

const express = require('express');
const store = require('../store');
const imap = require('../services/imapService');
const { shouldSaveSentCopy, uidSet } = imap._internals;

const ACCOUNT = store.addAccount({
  type: 'imap', email: 'me@fastmail.example', name: 'Me',
  imapHost: 'imap.fastmail.example', smtpHost: 'smtp.fastmail.example', password: 'x',
});

test.beforeEach(() => { calls.length = 0; sent.length = 0; smtpFails = false; });

// ─── Sent copy ──────────────────────────────────────────────────────────────

test('a Sent copy is saved by default for an ordinary SMTP host', () => {
  assert.strictEqual(shouldSaveSentCopy({ smtpHost: 'smtp.mail.me.com' }), true);
  assert.strictEqual(shouldSaveSentCopy({ smtpHost: 'smtp.qq.com' }), true);
});

test('hosts that file their own copy are skipped by default', () => {
  for (const host of ['smtp.gmail.com', 'smtp.office365.com', 'smtp-mail.outlook.com']) {
    assert.strictEqual(shouldSaveSentCopy({ smtpHost: host }), false, host);
  }
});

test('an explicit account setting beats the default either way', () => {
  assert.strictEqual(shouldSaveSentCopy({ smtpHost: 'smtp.gmail.com', saveSentCopy: true }), true);
  assert.strictEqual(shouldSaveSentCopy({ smtpHost: 'smtp.qq.com', saveSentCopy: false }), false);
});

test('sending appends the same message, Bcc included, to the Sent folder', async () => {
  await imap.sendEmail(ACCOUNT, { to: 'you@example.com', bcc: 'secret@example.com', subject: 'Hi', text: 'Hello' });
  assert.strictEqual(sent.length, 1);
  const append = calls.find(c => c[0] === 'append');
  assert.ok(append, 'a copy was appended');
  assert.strictEqual(append[1], 'Sent');
  assert.deepStrictEqual(append[3], ['\\Seen']);
  assert.ok(append[2].includes(`Message-ID: ${sent[0].messageId}`), 'copy shares the delivered Message-ID');
  assert.match(append[2], /^Bcc: secret@example\.com/m);
});

test('a host that files its own copy gets no second one', async () => {
  await imap.sendEmail({ ...ACCOUNT, smtpHost: 'smtp.gmail.com' }, { to: 'you@example.com', subject: 'Hi', text: 'x' });
  assert.strictEqual(sent.length, 1);
  assert.ok(!calls.some(c => c[0] === 'append'));
});

test('a failed Sent copy does not fail an already-delivered send', async () => {
  const original = FakeImapFlow.prototype.append;
  FakeImapFlow.prototype.append = async () => { throw new Error('quota exceeded'); };
  try {
    await imap.sendEmail(ACCOUNT, { to: 'you@example.com', subject: 'Hi', text: 'x' });
    assert.strictEqual(sent.length, 1);
  } finally {
    FakeImapFlow.prototype.append = original;
  }
});

test('a failed SMTP send saves no copy', async () => {
  smtpFails = true;
  await assert.rejects(imap.sendEmail(ACCOUNT, { to: 'you@example.com', subject: 'Hi', text: 'x' }));
  assert.ok(!calls.some(c => c[0] === 'append'));
});

test('an empty subject is sent rather than rejected', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/emails', require('../routes/emails'));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/emails/${ACCOUNT.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'you@example.com', subject: '', text: 'no subject' }),
    });
    assert.strictEqual(res.status, 200);
    const missing = await fetch(`http://127.0.0.1:${server.address().port}/api/emails/${ACCOUNT.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '  ', subject: 'x' }),
    });
    assert.strictEqual(missing.status, 400);
  } finally {
    server.close();
    for (const item of store.getSendQueue()) store.removeSendQueueItem(item.id);
  }
});

// ─── Batched bulk actions ───────────────────────────────────────────────────

test('uidSet keeps only real UIDs', () => {
  assert.strictEqual(uidSet(['3', 5, 'x', -1, 0, '7']), '3,5,7');
});

function bulkServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/emails', require('../routes/emails'));
  const server = app.listen(0);
  const post = (action, body) => fetch(`http://127.0.0.1:${server.address().port}/api/emails/${ACCOUNT.id}/bulk/${action}?folder=INBOX`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());
  return { server, post };
}

const id = (folder, uid) => imap.composeId(ACCOUNT.id, folder, uid);

test('bulk read issues one command per folder, not one per message', async () => {
  const { server, post } = bulkServer();
  try {
    const ids = [id('INBOX', 1), id('INBOX', 2), id('INBOX', 3), id('Archive', 9)];
    const result = await post('read', { emailIds: ids });
    assert.strictEqual(result.succeeded, 4);
    const flagCalls = calls.filter(c => c[0] === 'flagsAdd');
    assert.deepStrictEqual(flagCalls.map(c => c[1]).sort(), ['1,2,3', '9']);
    assert.deepStrictEqual(flagCalls[0][2], ['\\Seen']);
  } finally { server.close(); }
});

test('bulk delete moves a whole folder to Trash in one MOVE', async () => {
  const { server, post } = bulkServer();
  try {
    const result = await post('delete', { emailIds: [id('INBOX', 4), id('INBOX', 5)] });
    assert.strictEqual(result.succeeded, 2);
    assert.deepStrictEqual(calls.filter(c => c[0] === 'move'), [['move', '4,5', 'Trash']]);
  } finally { server.close(); }
});

test('bulk delete in Trash removes for good', async () => {
  const { server, post } = bulkServer();
  try {
    await post('delete', { emailIds: [id('Trash', 6)] });
    assert.deepStrictEqual(calls.filter(c => c[0] === 'delete'), [['delete', '6']]);
  } finally { server.close(); }
});

test('a failing folder is reported without sinking the others', async () => {
  const { server, post } = bulkServer();
  const original = FakeImapFlow.prototype.messageMove;
  FakeImapFlow.prototype.messageMove = async function (set, to) {
    if (set === '8') throw new Error('no such message');
    return original.call(this, set, to);
  };
  try {
    const result = await post('move', { emailIds: [id('INBOX', 7), id('Archive', 8)], folder: 'Projects' });
    assert.strictEqual(result.succeeded, 1);
    assert.strictEqual(result.failed, 1);
    assert.deepStrictEqual(result.errors, ['no such message']);
  } finally {
    FakeImapFlow.prototype.messageMove = original;
    server.close();
  }
});
