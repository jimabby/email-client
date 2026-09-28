const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-review-'));
process.env.HERMES_SECRET_KEY = 'b'.repeat(64);

const ids = require('../services/emailIds');
const { hostGuard, isLoopbackHost } = require('../middleware/hostGuard');
const secrets = require('../services/secretStore');
const unsub = require('../services/unsubscribeService');
const gmail = require('../services/gmailService');
const imap = require('../services/imapService');
const outlook = require('../services/outlookService');
const rules = require('../services/rulesService');
const vacation = require('../services/vacationService');
const accountHealth = require('../services/accountHealth');

// ─── Email ids ──────────────────────────────────────────────────────────────

test('an IMAP id records its folder, and the folder beats the query parameter', () => {
  const id = imap.composeId('acc', 'Sent', 42);
  assert.equal(id, 'acc::Sent::42');
  assert.equal(ids.imapUid(id), 42);
  assert.equal(ids.imapFolder(id, 'INBOX'), 'Sent');
});

test('a legacy IMAP id without a folder falls back to the one supplied', () => {
  assert.equal(ids.imapUid('acc::7'), 7);
  assert.equal(ids.imapFolder('acc::7', 'Archive'), 'Archive');
});

test('folder names containing the separator survive', () => {
  assert.equal(ids.imapFolder('acc::Work::Q1::9'), 'Work::Q1');
});

// ─── DNS rebinding ──────────────────────────────────────────────────────────

test('loopback Host headers are accepted, with or without a port', () => {
  for (const host of ['localhost', 'localhost:3001', '127.0.0.1:3001', '[::1]:3001', '127.5.0.1']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
});

test('a rebinding hostname is refused even though it resolves to loopback', () => {
  for (const host of ['attacker.example:3001', '127.0.0.1.attacker.example', 'localhost.evil.com', '']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('hostGuard answers 421 to a foreign Host and passes loopback through', () => {
  const guard = hostGuard();
  let status = null;
  let passed = false;
  const res = { status(code) { status = code; return this; }, json() { return this; } };
  guard({ headers: { host: 'evil.example:3001' } }, res, () => { passed = true; });
  assert.equal(status, 421);
  assert.equal(passed, false);
  guard({ headers: { host: '127.0.0.1:3001' } }, res, () => { passed = true; });
  assert.equal(passed, true);
});

// ─── Sealed files ───────────────────────────────────────────────────────────

test('sealed files round-trip and are not readable as plaintext', () => {
  const sealed = secrets.sealText('{"secret":"mail body"}');
  assert.equal(secrets.isSealedBuffer(sealed), true);
  assert.equal(sealed.includes(Buffer.from('mail body')), false);
  assert.equal(secrets.openText(sealed), '{"secret":"mail body"}');
});

test('a plaintext file from an older build still opens', () => {
  assert.equal(secrets.openText(Buffer.from('{"a":1}')), '{"a":1}');
});

test('a tampered sealed file fails instead of returning garbage', () => {
  const sealed = secrets.sealText('hello');
  sealed[sealed.length - 1] ^= 0xff;
  assert.throws(() => secrets.openText(sealed));
});

// ─── Gmail ──────────────────────────────────────────────────────────────────

const b64 = (text, encoding = 'utf8') => Buffer.from(text, encoding).toString('base64url');

test('a malformed Date header no longer throws; internalDate is used', () => {
  assert.equal(gmail._internals.messageDate('not a date', '1700000000000'), new Date(1700000000000).toISOString());
  assert.doesNotThrow(() => gmail._internals.messageToSummary({ id: 'a' }, {
    id: 'm1', internalDate: '1700000000000',
    payload: { headers: [{ name: 'Date', value: 'garbage' }], mimeType: 'multipart/mixed' },
  }, 'INBOX'));
});

test('a Gmail summary reports attachments from the top-level MIME type', () => {
  const summary = gmail._internals.messageToSummary({ id: 'a' }, { id: 'm', payload: { mimeType: 'multipart/mixed', headers: [] } }, 'INBOX');
  assert.equal(summary.hasAttachments, true);
  const plain = gmail._internals.messageToSummary({ id: 'a' }, { id: 'm', payload: { mimeType: 'multipart/alternative', headers: [] } }, 'INBOX');
  assert.equal(plain.hasAttachments, false);
});

test('an attached .txt file does not replace the message body', () => {
  const { text } = gmail._internals.extractBody({
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: b64('the real body') } },
      { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('attached file') } },
    ],
  });
  assert.equal(text, 'the real body');
});

test('a Latin-1 body is decoded in its declared charset', () => {
  const { text } = gmail._internals.extractBody({
    mimeType: 'text/plain',
    headers: [{ name: 'Content-Type', value: 'text/plain; charset="ISO-8859-1"' }],
    body: { data: b64('café', 'latin1') },
  });
  assert.equal(text, 'café');
});

// ─── IMAP ───────────────────────────────────────────────────────────────────

test('an IMAP thread is named after the root of its References', () => {
  const root = imap._internals.threadRoot(
    { inReplyTo: '<c@x>', messageId: '<d@x>' },
    '<a@x> <b@x> <c@x>',
  );
  assert.equal(root, '<a@x>');
  assert.equal(imap._internals.threadRoot({ messageId: '<solo@x>' }, ''), '<solo@x>');
});

test('the IMAP snippet skips the MIME preamble and decodes the text part', () => {
  const source = [
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    'This is a multi-part message in MIME format.',
    '--B',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Hello =C3=A9t=C3=A9 friends',
    '--B--',
  ].join('\r\n');
  const snippet = imap._internals.snippetFromSource(Buffer.from(source));
  assert.equal(snippet.includes('multi-part'), false);
  assert.match(snippet, /^Hello/);
});

test('header blocks parse into lower-case keys', () => {
  const parsed = imap._internals.parseHeaderBlock('List-Id: <news.example.com>\r\nTo: me@x.com,\r\n  you@x.com\r\n');
  assert.equal(parsed['list-id'], '<news.example.com>');
  assert.equal(parsed.to, 'me@x.com, you@x.com');
});

// ─── Outlook ────────────────────────────────────────────────────────────────

test('a page token pointing off Graph is refused', () => {
  assert.throws(() => outlook._internals.graphUrl('https://attacker.example/me/messages'));
  assert.throws(() => outlook._internals.graphUrl('http://graph.microsoft.com/v1.0/me'));
  assert.equal(
    outlook._internals.graphUrl('https://graph.microsoft.com/v1.0/me/messages?$skip=50'),
    'https://graph.microsoft.com/v1.0/me/messages?$skip=50',
  );
});

test('a sender with no display name is not rendered as "undefined"', () => {
  assert.equal(outlook._internals.formatSender({ emailAddress: { address: 'a@b.com' } }), 'a@b.com');
  assert.equal(outlook._internals.formatSender({ emailAddress: { name: 'Ann', address: 'a@b.com' } }), 'Ann <a@b.com>');
});

// ─── Rules ──────────────────────────────────────────────────────────────────

test('fromAddress equals matches the exact sender only', () => {
  const rule = rules.sanitizeRule({
    conditions: [{ field: 'fromAddress', op: 'equals', value: 'a@b.com' }],
    actions: [{ type: 'spam' }],
  });
  const email = (from) => ({ id: 'x', accountId: 'acc', from });
  assert.equal(rules.ruleMatches(email('Ann <a@b.com>'), rule), true);
  assert.equal(rules.ruleMatches(email('Xa <xa@b.com>'), rule), false);
});

// ─── Vacation ───────────────────────────────────────────────────────────────

const account = { id: 'acc', email: 'me@x.com', aliases: [{ email: 'alias@x.com' }] };

test('only mail addressed to this mailbox is directly addressed', () => {
  const { isDirectlyAddressed } = vacation._internals;
  assert.equal(isDirectlyAddressed({ to: 'Me <me@x.com>' }, account), true);
  assert.equal(isDirectlyAddressed({ to: 'team@x.com', cc: 'alias@x.com' }, account), true);
  assert.equal(isDirectlyAddressed({ to: 'list@lists.example.com' }, account), false);
});

test('the responder stays silent for list mail and when headers cannot be read', async () => {
  const store = require('../store');
  store.saveVacationSettings({ enabled: true, subject: 'Away', message: 'Back soon', accountIds: [], cooldownDays: 4 });
  store.clearAutoReplyLog();
  const email = { id: 'acc-1', from: 'Bob <bob@example.com>', subject: 'Hi', accountId: 'acc' };

  const list = await vacation.respondTo([email], account, { loadHeaders: async () => ({ to: 'me@x.com', 'list-id': '<news>' }) });
  assert.equal(list.length, 0);

  const unreadable = await vacation.respondTo([email], account, { loadHeaders: async () => { throw new Error('offline'); } });
  assert.equal(unreadable.length, 0);

  const direct = await vacation.respondTo([email], account, { loadHeaders: async () => ({ to: 'me@x.com' }) });
  assert.equal(direct.length, 1);
  store.saveVacationSettings({ enabled: false });
});

// ─── Unsubscribe ────────────────────────────────────────────────────────────

test('private and loopback addresses are recognised', () => {
  const { isPrivateAddress } = unsub._internals;
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('one-click unsubscribe POSTs to a public https URL', async () => {
  const calls = [];
  const result = await unsub.unsubscribe({
    listUnsubscribe: '<mailto:u@list.example>, <https://list.example/u?id=1>',
    listUnsubscribePost: 'List-Unsubscribe=One-Click',
  }, {
    lookup: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { status: 200 }; },
    sendMail: () => { throw new Error('should not mail'); },
  });
  assert.equal(result.method, 'one-click');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, 'List-Unsubscribe=One-Click');
  assert.equal(calls[0].init.redirect, 'manual');
});

test('a one-click URL resolving to a private address is refused', async () => {
  await assert.rejects(unsub.unsubscribe({
    listUnsubscribe: '<https://internal.example/u>',
    listUnsubscribePost: 'List-Unsubscribe=One-Click',
  }, { lookup: async () => [{ address: '10.0.0.5' }], fetchImpl: async () => ({ status: 200 }), sendMail: () => {} }));
});

test('without one-click, a mailto target gets an email', async () => {
  const sent = [];
  const result = await unsub.unsubscribe({ listUnsubscribe: '<mailto:leave@list.example?subject=remove%20me>' }, {
    sendMail: (mail) => sent.push(mail),
  });
  assert.equal(result.method, 'mailto');
  assert.deepEqual(sent[0], { to: 'leave@list.example', subject: 'remove me', text: 'unsubscribe' });
});

test('a plain https unsubscribe is handed back to open in the browser', async () => {
  const result = await unsub.unsubscribe({ listUnsubscribe: '<https://list.example/prefs>' }, { sendMail: () => {} });
  assert.deepEqual(result, { method: 'browser', url: 'https://list.example/prefs' });
});

// ─── Account health ─────────────────────────────────────────────────────────

test('revoked grants and bad passwords count as auth errors; network errors do not', () => {
  assert.equal(accountHealth.isAuthError({ response: { data: { error: 'invalid_grant' } }, message: 'x' }), true);
  assert.equal(accountHealth.isAuthError(new Error('Graph API error: 401 {"error":"InvalidAuthenticationToken"}')), true);
  assert.equal(accountHealth.isAuthError(Object.assign(new Error('Command failed'), { authenticationFailed: true })), true);
  assert.equal(accountHealth.isAuthError(new Error('getaddrinfo ENOTFOUND imap.example.com')), false);
  assert.equal(accountHealth.isAuthError(new Error('Graph API error: 503 busy')), false);
});
