const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-features-'));
process.env.HERMES_SECRET_KEY = 'f'.repeat(64);
// A legacy accounts.json that still carries the rule-run and auto-reply logs.
fs.writeFileSync(path.join(process.env.HERMES_DATA_DIR, 'accounts.json'), JSON.stringify({
  accounts: [],
  aiSettings: {},
  ruleRuns: { 'legacy-id': 1 },
  autoReplies: { 'old@example.com': '2026-01-01T00:00:00.000Z' },
}));

/**
 * Regression tests for the review fixes and the features added with them:
 * unified paging, IMAP undo ids, the shared event stream, the new-mail re-run,
 * muted threads, follow-up reminders, notification filters, and import.
 *
 * Every provider is a scripted fake installed into the module cache before
 * anything that would load the real one.
 */
const calls = [];
const pages = new Map();
let fetchDelayMs = 0;

function fakeService(type) {
  return {
    async fetchEmails(account, folder, limit, pageToken) {
      calls.push({ type, op: 'fetch', accountId: account.id, pageToken: pageToken ?? null });
      if (fetchDelayMs) await new Promise(r => setTimeout(r, fetchDelayMs));
      const script = pages.get(account.id) || [];
      const index = pageToken ? Number(pageToken) : 0;
      return script[index] || script[script.length - 1] || { emails: [], nextToken: null };
    },
    // An IMAP server without UIDPLUS reports the destination but no new UID.
    async reportSpam(account, id) {
      calls.push({ type, op: 'spam', id });
      return type === 'imap' ? { folder: 'Junk' } : { id };
    },
    async deleteEmail(account, id) {
      calls.push({ type, op: 'delete', id });
      return type === 'imap' ? { folder: 'Trash', permanent: false } : { id };
    },
    async moveEmail(account, id, ...rest) {
      calls.push({ type, op: 'move', id, args: rest });
      return type === 'imap' ? { folder: rest[1] } : { id };
    },
    async markAsRead(account, id) { calls.push({ type, op: 'read', id }); },
    async getFolders() { return [{ name: 'Archive', path: 'Archive' }]; },
    async getUnreadCounts() { return {}; },
    async importMessage(account, raw, folder) {
      calls.push({ type, op: 'import', folder, raw: raw.toString('latin1') });
      return { id: 'imported' };
    },
  };
}

for (const [name, type] of [['gmailService', 'gmail'], ['outlookService', 'outlook'], ['imapService', 'imap']]) {
  const resolved = require.resolve(`../services/${name}`);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: fakeService(type) };
}

const express = require('express');
const store = require('../store');
const emailsRouter = require('../routes/emails');
const mailWatch = require('../services/mailWatchService');
const followups = require('../services/followupService');
const notifications = require('../services/notificationService');
const importService = require('../services/importService');
const apiAuth = require('../middleware/apiAuth');

const app = express();
app.use(express.json());
app.use('/api/emails', emailsRouter);

let server;
let base;

test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  for (const account of store.getAccounts()) await mailWatch.stopWatch(account.id);
  server?.close();
});

function resetAccounts(...types) {
  for (const account of [...store.getAccounts()]) store.removeAccount(account.id);
  return types.map((type, i) => store.addAccount({ type, email: `user${i}@example.com`, name: `U${i}` }));
}

function email(accountId, id, date, extra = {}) {
  return { id, accountId, from: 'Sender <sender@example.com>', subject: id, date, folder: 'INBOX', read: false, ...extra };
}

const post = async (url, body) => {
  const res = await fetch(`${base}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
};

// ─── Store ──────────────────────────────────────────────────────────────────

test('rule-run and auto-reply logs move out of accounts.json', () => {
  assert.strictEqual(store.hasRuleRun('legacy-id'), true);
  assert.ok(store.lastAutoReplyTo('old@example.com'));
  store.markRuleRun('fresh-id');
  store.flush();
  const accounts = JSON.parse(fs.readFileSync(path.join(process.env.HERMES_DATA_DIR, 'accounts.json'), 'utf8'));
  assert.strictEqual(accounts.ruleRuns, undefined);
  assert.strictEqual(accounts.autoReplies, undefined);
  assert.ok(fs.existsSync(path.join(process.env.HERMES_DATA_DIR, 'state.json')));
});

// ─── Unified paging ─────────────────────────────────────────────────────────

test('the unified inbox returns every fetched message, not just the first `limit`', async () => {
  const [a, b] = resetAccounts('gmail', 'gmail');
  pages.clear();
  pages.set(a.id, [{ emails: [email(a.id, `${a.id}-1`, '2026-01-04T00:00:00Z'), email(a.id, `${a.id}-2`, '2026-01-02T00:00:00Z')], nextToken: '1' }]);
  pages.set(b.id, [{ emails: [email(b.id, `${b.id}-1`, '2026-01-03T00:00:00Z'), email(b.id, `${b.id}-2`, '2026-01-01T00:00:00Z')], nextToken: '1' }]);

  const res = await fetch(`${base}/api/emails/unified?folder=INBOX&limit=2`);
  const body = await res.json();
  // Both accounts' tokens advanced past two messages each, so all four must
  // be on screen — trimming to two lost the rest for good.
  assert.strictEqual(body.emails.length, 4);
  assert.deepStrictEqual(body.emails.map(e => e.date), [
    '2026-01-04T00:00:00Z', '2026-01-03T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z',
  ]);
});

// ─── Undo ids ───────────────────────────────────────────────────────────────

test('IMAP spam without a reported UID offers no undo instead of a wrong one', async () => {
  const [imap] = resetAccounts('imap');
  const id = `${imap.id}::INBOX::42`;
  const { status, body } = await post(`/api/emails/${imap.id}/message/${encodeURIComponent(id)}/spam`);
  assert.strictEqual(status, 200);
  // UID 42 in INBOX is not UID 42 in Junk — undoing with it moved a stranger.
  assert.strictEqual(body.undoId, null);
});

test('IMAP delete without a reported UID offers no undo', async () => {
  const [imap] = resetAccounts('imap');
  const id = `${imap.id}::INBOX::7`;
  const res = await fetch(`${base}/api/emails/${imap.id}/message/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const body = await res.json();
  assert.strictEqual(body.permanent, false);
  assert.strictEqual(body.undoId, null);
});

test('Gmail keeps its id across a spam report, so undo still uses it', async () => {
  const [gmail] = resetAccounts('gmail');
  const id = `${gmail.id}-abc123`;
  const { body } = await post(`/api/emails/${gmail.id}/message/${encodeURIComponent(id)}/spam`);
  assert.strictEqual(body.undoId, id);
});

test('reporting spam or moving a message clears its snooze', async () => {
  const [gmail] = resetAccounts('gmail');
  const spamId = `${gmail.id}-s1`;
  const moveId = `${gmail.id}-m1`;
  for (const emailId of [spamId, moveId]) {
    store.addSnooze({ emailId, accountId: gmail.id, folder: 'INBOX', until: new Date(Date.now() + 3600e3).toISOString() });
  }
  await post(`/api/emails/${gmail.id}/message/${encodeURIComponent(spamId)}/spam`);
  await post(`/api/emails/${gmail.id}/message/${encodeURIComponent(moveId)}/move`, { folder: 'Archive' });
  const left = store.getSnoozes().map(s => s.emailId);
  assert.ok(!left.includes(spamId));
  assert.ok(!left.includes(moveId));
});

// ─── Shared stream ──────────────────────────────────────────────────────────

test('the query-string token is accepted on the all-accounts stream', () => {
  process.env.API_TOKEN = 'x'.repeat(40);
  try {
    let status = 200;
    const res = { set() {}, status(code) { status = code; return { json() {} }; } };
    let passed = false;
    apiAuth({ get: () => '', path: '/emails/stream', query: { access_token: 'x'.repeat(40) } }, res, () => { passed = true; });
    assert.ok(passed);
    passed = false;
    apiAuth({ get: () => '', path: '/emails/streamy', query: { access_token: 'x'.repeat(40) } }, res, () => { passed = true; });
    assert.strictEqual(passed, false);
    assert.strictEqual(status, 401);
  } finally {
    delete process.env.API_TOKEN;
  }
});

test('one stream carries new-mail events for every account', async () => {
  const [a, b] = resetAccounts('gmail', 'gmail');
  pages.clear();
  const controller = new AbortController();
  const res = await fetch(`${base}/api/emails/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  const waitFor = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (!predicate(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  };

  await waitFor(t => t.includes('"ready"'));
  mailWatch.notifyNewMail(a.id, { source: 'test' });
  mailWatch.notifyNewMail(b.id, { source: 'test' });
  await waitFor(t => t.includes(a.id) && t.includes(b.id));
  controller.abort();

  assert.ok(text.includes(`"accountId":"${a.id}"`));
  assert.ok(text.includes(`"accountId":"${b.id}"`));
});

// ─── New-mail pipeline ──────────────────────────────────────────────────────

test('an arrival during a running check triggers one more check', async () => {
  const [account] = resetAccounts('gmail');
  await mailWatch.stopWatch(account.id);
  pages.set(account.id, [{ emails: [], nextToken: null }]);
  calls.length = 0;
  fetchDelayMs = 50;
  try {
    const first = mailWatch.handleNewMail(account.id, { source: 'test' });
    mailWatch.handleNewMail(account.id, { source: 'test' }); // collapses into `first`
    await first;
    await new Promise(r => setTimeout(r, 150));
  } finally {
    fetchDelayMs = 0;
  }
  const fetches = calls.filter(c => c.op === 'fetch' && c.accountId === account.id);
  assert.strictEqual(fetches.length, 2, 'the collapsed arrival must still be looked at');
});

test('replies to a muted thread are marked read and archived', async () => {
  const [account] = resetAccounts('gmail');
  await mailWatch.stopWatch(account.id);
  const old = email(account.id, `${account.id}-old`, '2026-01-01T00:00:00Z', { threadId: 'T1' });
  pages.set(account.id, [{ emails: [old], nextToken: null }]);
  await mailWatch.handleNewMail(account.id, { source: 'seed' });

  const res = await post(`/api/emails/${account.id}/thread/T1/mute`, { subject: 'noisy' });
  assert.strictEqual(res.body.success, true);
  assert.ok(store.isThreadMuted(account.id, 'T1'));

  const reply = email(account.id, `${account.id}-reply`, '2026-01-02T00:00:00Z', { threadId: 'T1' });
  const other = email(account.id, `${account.id}-other`, '2026-01-02T00:00:00Z', { threadId: 'T2' });
  pages.set(account.id, [{ emails: [reply, other, old], nextToken: null }]);
  calls.length = 0;
  await mailWatch.handleNewMail(account.id, { source: 'test' });

  assert.ok(calls.some(c => c.op === 'read' && c.id === 'reply'));
  assert.ok(calls.some(c => c.op === 'move' && c.id === 'reply'));
  assert.ok(!calls.some(c => c.op === 'move' && c.id === 'other'), 'unmuted threads are left alone');

  const del = await fetch(`${base}/api/emails/${account.id}/thread/T1/mute`, { method: 'DELETE' });
  assert.strictEqual((await del.json()).success, true);
  assert.strictEqual(store.isThreadMuted(account.id, 'T1'), false);
});

// ─── Notification filters ───────────────────────────────────────────────────

test('VIP entries match whole addresses or whole domains', () => {
  const { isVip } = notifications._internals;
  assert.ok(isVip('Boss <boss@corp.com>', ['boss@corp.com']));
  assert.ok(isVip('x@corp.com', ['@corp.com']));
  assert.ok(isVip('x@corp.com', ['corp.com']));
  assert.ok(!isVip('x@notcorp.com', ['corp.com']));
  assert.ok(!isVip('xboss@corp.com', ['boss@corp.com']));
});

test('quiet hours handle windows that wrap midnight', () => {
  const { inQuietHours } = notifications._internals;
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);
  const night = { enabled: true, start: '22:00', end: '07:00' };
  assert.ok(inQuietHours(night, at(23)));
  assert.ok(inQuietHours(night, at(6, 59)));
  assert.ok(!inQuietHours(night, at(7)));
  assert.ok(!inQuietHours(night, at(12)));
  const lunch = { enabled: true, start: '12:00', end: '13:00' };
  assert.ok(inQuietHours(lunch, at(12, 30)));
  assert.ok(!inQuietHours({ ...lunch, enabled: false }, at(12, 30)));
});

test('quiet hours are read in the user’s time zone', () => {
  const { inQuietHours } = notifications._internals;
  // 23:30 UTC is 08:30 the next morning in Tokyo.
  const now = new Date(Date.UTC(2026, 0, 1, 23, 30));
  const quiet = { enabled: true, start: '22:00', end: '07:00' };
  assert.strictEqual(inQuietHours(quiet, now, 'UTC'), true);
  assert.strictEqual(inQuietHours(quiet, now, 'Asia/Tokyo'), false);
});

test('VIP-only and quiet hours decide what interrupts', () => {
  const { interrupting } = notifications._internals;
  const vip = { from: 'boss@corp.com' };
  const other = { from: 'news@shop.com' };
  const base = { vipOnly: false, vips: ['boss@corp.com'], timeZone: null, quietHours: { enabled: false, start: '22:00', end: '07:00', allowVips: true } };
  assert.strictEqual(interrupting([vip, other], base).length, 2);
  assert.deepStrictEqual(interrupting([vip, other], { ...base, vipOnly: true }), [vip]);
  const night = new Date(2026, 0, 1, 23);
  const quiet = { ...base, quietHours: { ...base.quietHours, enabled: true } };
  assert.deepStrictEqual(interrupting([vip, other], quiet, night), [vip]);
  assert.deepStrictEqual(interrupting([vip, other], { ...quiet, quietHours: { ...quiet.quietHours, allowVips: false } }, night), []);
});

test('notification settings are validated on save', async () => {
  const res = await fetch(`${base}/api/emails/notification-settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vipOnly: true, vips: ['Boss@Corp.com', 'not an address', '@corp.com'], timeZone: 'Not/AZone', quietHours: { enabled: true, start: 'late', end: '06:30' } }),
  });
  const saved = await res.json();
  assert.deepStrictEqual(saved.vips, ['boss@corp.com', '@corp.com']);
  assert.strictEqual(saved.timeZone, null);
  assert.strictEqual(saved.quietHours.start, '22:00');
  assert.strictEqual(saved.quietHours.end, '06:30');
});

// ─── Follow-ups ─────────────────────────────────────────────────────────────

test('a reply from a recipient on the same subject answers a follow-up', () => {
  const [account] = resetAccounts('gmail');
  const followup = followups.createFollowup({
    accountId: account.id, to: 'Ann <ann@example.com>, bob@example.com', subject: 'Budget', sentAt: '2026-03-01T00:00:00Z', days: 3,
  });
  const ts = Date.parse('2026-03-02T00:00:00Z');
  const doc = (over) => ({ accountId: account.id, from: 'ann@example.com', subject: 'Re: Budget', ts, ...over });

  assert.ok(followups.findReply(followup, [doc({})]));
  assert.strictEqual(followups.findReply(followup, [doc({ from: 'eve@example.com' })]), null, 'not a recipient');
  assert.strictEqual(followups.findReply(followup, [doc({ ts: Date.parse('2026-02-28T00:00:00Z') })]), null, 'older than the send');
  assert.strictEqual(followups.findReply(followup, [doc({ subject: 'Lunch?' })]), null, 'a different conversation');
  assert.strictEqual(followups.findReply(followup, [doc({ accountId: 'other' })]), null, 'another account');
});

test('an unanswered follow-up fires once when it comes due', () => {
  const [account] = resetAccounts('gmail');
  for (const f of [...store.getFollowups()]) store.removeFollowup(f.id);
  const sentAt = new Date(Date.now() - 4 * 86400e3).toISOString();
  const created = followups.createFollowup({ accountId: account.id, to: 'nobody@example.com', subject: 'Silence', sentAt, days: 3 });

  const fired = [];
  followups.processFollowups(Date.now(), { notify: f => fired.push(f) });
  followups.processFollowups(Date.now(), { notify: f => fired.push(f) });
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(store.getFollowups().find(f => f.id === created.id).status, 'due');

  const again = followups.remindAgain(created.id, 2);
  assert.strictEqual(again.status, 'waiting');
});

test('a follow-up for an undone send is dropped', () => {
  const [account] = resetAccounts('gmail');
  store.addSendQueueItem({ id: 'job-undone', accountId: account.id, status: 'cancelled' });
  const created = followups.createFollowup({ accountId: account.id, jobId: 'job-undone', to: 'x@example.com', subject: 'Oops', days: 1 });
  followups.processFollowups(Date.now(), { notify: () => {} });
  assert.ok(!store.getFollowups().some(f => f.id === created.id));
});

test('send with followUpDays creates a reminder, and bad values are refused', async () => {
  const [account] = resetAccounts('gmail');
  const ok = await post(`/api/emails/${account.id}/send`, { to: 'pat@example.com', subject: 'Proposal', text: 'hi', followUpDays: 3, undoWindowSec: 30 });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.body.followupId);
  assert.ok(store.getFollowups().some(f => f.id === ok.body.followupId && f.recipients.includes('pat@example.com')));

  const bad = await post(`/api/emails/${account.id}/send`, { to: 'pat@example.com', subject: 'x', followUpDays: 365 });
  assert.strictEqual(bad.status, 400);
});

// ─── Import ─────────────────────────────────────────────────────────────────

test('an mbox splits into messages and un-escapes quoted From lines', () => {
  const mbox = [
    'From alice@example.com Mon Jan  1 00:00:00 2026',
    'From: alice@example.com',
    'Subject: one',
    '',
    'Hello',
    '>From the archive',
    '',
    'From bob@example.com Tue Jan  2 00:00:00 2026',
    'From: bob@example.com',
    'Subject: two',
    '',
    'Bye',
    '',
  ].join('\n');
  const messages = importService.parseUpload(Buffer.from(mbox));
  assert.strictEqual(messages.length, 2);
  assert.match(messages[0].toString(), /Subject: one/);
  assert.match(messages[0].toString(), /\r\nFrom the archive\r\n/);
  assert.match(messages[1].toString(), /Subject: two/);
});

test('a bare .eml is imported as one message', () => {
  const eml = 'From: a@example.com\nSubject: single\n\nbody\n';
  const messages = importService.parseUpload(Buffer.from(eml));
  assert.strictEqual(messages.length, 1);
  assert.match(messages[0].toString(), /^From: a@example\.com\r\n/);
});

test('the import route files every message into the chosen folder', async () => {
  const [account] = resetAccounts('imap');
  calls.length = 0;
  const mbox = 'From x Mon Jan  1 00:00:00 2026\nSubject: a\n\n1\n\nFrom y Mon Jan  1 00:00:00 2026\nSubject: b\n\n2\n';
  const res = await fetch(`${base}/api/emails/${account.id}/import?folder=Archive`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: mbox,
  });
  const body = await res.json();
  assert.strictEqual(body.imported, 2);
  assert.deepStrictEqual(calls.filter(c => c.op === 'import').map(c => c.folder), ['Archive', 'Archive']);
});
