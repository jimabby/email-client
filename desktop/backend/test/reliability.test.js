const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-reliability-'));
process.env.HERMES_SECRET_KEY = 'a'.repeat(64);
const store = require('../store');
const queue = require('../services/sendQueueService');
const unsubscribe = require('../services/unsubscribeService');
const access = require('../services/deviceAccessService');
const followups = require('../services/followupService');
const index = require('../services/searchIndexService');
const account = store.addAccount({ type: 'imap', email: 'test@example.com' });
let outcome = null;
const provider = require.resolve('../services/imapService');
require.cache[provider] = { id: provider, filename: provider, loaded: true, exports: { sendEmail: async () => { if (outcome) throw outcome; } } };
const payload = { accountId: account.id, email: { to: 'recipient@example.com', subject: 'private subject', text: 'private body' } };

test('acceptance is durable and encrypted before returning', () => {
  const job = queue.createQueuedSend(payload);
  const sealed = fs.readFileSync(path.join(process.env.HERMES_DATA_DIR, 'outbox.json'));
  assert.equal(sealed.includes(Buffer.from('private body')), false);
  const disk = JSON.parse(require('../services/secretStore').openText(sealed));
  assert.ok(disk.items.some(item => item.id === job.id));
  queue.cancelQueuedSend(job.id);
});
test('disk write failure rejects acceptance and restores memory', () => {
  const old = fs.renameSync; const count = store.getSendQueue().length;
  fs.renameSync = () => { throw new Error('disk full'); };
  try { assert.throws(() => queue.createQueuedSend(payload), /disk full/); assert.equal(store.getSendQueue().length, count); }
  finally { fs.renameSync = old; }
});
test('same request returns one job, including after removal', () => {
  const input = { ...payload, requestId: 'request-123', requestHash: 'same' };
  const first = queue.createQueuedSend(input);
  assert.equal(queue.createQueuedSend(input).id, first.id);
  assert.throws(() => queue.createQueuedSend({ ...input, requestHash: 'different' }), /different content/);
  store.removeSendQueueItem(first.id);
  assert.equal(queue.createQueuedSend(input).id, first.id);
});
test('lost provider response requires explicit confirmation and is never auto-retried', async () => {
  outcome = Object.assign(new Error('socket reset after send'), { code: 'ECONNRESET' });
  const job = queue.createQueuedSend(payload);
  await queue.processDueSends();
  assert.equal(store.getSendQueueItem(job.id).status, 'uncertain');
  assert.throws(() => queue.retryQueuedSend(job.id), /Check Sent/);
  await queue.processDueSends();
  assert.equal(store.getSendQueueItem(job.id).attempts, 1);
  outcome = null;
  queue.retryQueuedSend(job.id, { acknowledgeUncertain: true });
  await queue.processDueSends();
  assert.equal(store.getSendQueueItem(job.id).status, 'sent');
});
test('connection refusal can retry safely', async () => {
  outcome = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  const job = queue.createQueuedSend(payload); await queue.processDueSends();
  assert.equal(store.getSendQueueItem(job.id).status, 'retrying');
  queue.cancelQueuedSend(job.id); outcome = null;
});
test('outbox edits preserve attachments and record history', () => {
  const job = queue.createQueuedSend({ ...payload, email: { ...payload.email, attachments: [{ filename: 'a.txt', content: 'YQ==' }] } });
  const updated = queue.editQueuedSend(job.id, { to: 'fixed@example.com', subject: 'Fixed', text: '<literal>', sendAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(updated.email.attachments.length, 1); assert.equal(updated.email.html, '<p>&lt;literal&gt;</p>');
  assert.ok(updated.history.some(e => e.detail === 'Message edited'));
  queue.cancelQueuedSend(job.id);
});
test('private mapped IPv6 representations are all rejected', async () => {
  for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '[::ffff:c0a8:1]', '[::1]']) {
    await assert.rejects(unsubscribe._internals.assertPublicHttps('https://' + host + '/'));
  }
});
test('redirect is not reported as successful unsubscribe', async () => {
  const result = await unsubscribe.unsubscribe({ listUnsubscribe: '<https://example.com/unsubscribe>', listUnsubscribePost: 'List-Unsubscribe=One-Click' }, { lookup: async () => [{ address: '93.184.216.34' }], fetchImpl: async () => ({ status: 302 }) });
  assert.equal(result.method, 'browser');
});
test('unsubscribe pins socket DNS lookup to the validated address', async () => {
  const https = require('https'); const old = https.request; let lookups = 0;
  https.request = (url, options, callback) => {
    options.lookup('example.com', {}, (err, address, family) => { assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
    const req = new (require('events').EventEmitter)(); req.end = () => callback({ statusCode: 204, resume() {} }); return req;
  };
  try {
    await unsubscribe.unsubscribe({ listUnsubscribe: '<https://example.com/unsubscribe>', listUnsubscribePost: 'List-Unsubscribe=One-Click' }, { lookup: async () => { lookups++; return [{ address: lookups === 1 ? '93.184.216.34' : '127.0.0.1' }]; } });
    assert.equal(lookups, 1);
  } finally { https.request = old; }
});
test('revocation invalidates only that device and signals active streams', () => {
  const a = access.create('Phone'); const b = access.create('Tablet'); let revoked;
  access.events.once('revoke', id => { revoked = id; });
  assert.ok(access.authenticate(a.token)); assert.equal(JSON.stringify(access.list()).includes(a.token), false);
  access.revoke(a.id); assert.equal(revoked, a.id); assert.equal(access.authenticate(a.token), null); assert.ok(access.authenticate(b.token));
});
test('failed send does not fire a follow-up; successful delivery starts its clock', () => {
  const job = queue.createQueuedSend(payload); store.updateSendQueueItem(job.id, { status: 'failed' });
  const reminder = followups.createFollowup({ accountId: account.id, jobId: job.id, to: 'recipient@example.com', sentAt: '2020-01-01', days: 1 });
  let fired = 0; followups.processFollowups(Date.now(), { notify: () => fired++ }); assert.equal(fired, 0);
  const sentAt = new Date().toISOString(); store.updateSendQueueItem(job.id, { status: 'sent', sentAt });
  followups.processFollowups(Date.now(), { notify: () => fired++ }); assert.equal(fired, 0);
  assert.equal(store.getFollowups().find(f => f.id === reminder.id).dueAt, new Date(Date.parse(sentAt) + 86400000).toISOString());
});
test('Chinese search returns relevant messages', () => {
  index.indexSummaries([{ id: 'zh-test', accountId: account.id, subject: '\u9879\u76ee\u4f1a\u8bae\u5b89\u6392', from: 'a@example.com', date: new Date().toISOString() }]);
  assert.ok(index.search('\u9879\u76ee\u4f1a\u8bae').some(d => d.id === 'zh-test'));
});
test('arrival scans all pages and resumes after restart without replaying old messages', async () => {
  const service = require('../services/imapService');
  const watch = require('../services/mailWatchService');
  const rules = require('../services/rulesService');
  const oldRules = rules.applyRules; const batches = [];
  rules.applyRules = async emails => { batches.push(...emails.map(e => e.id)); return { applied: [] }; };
  service.getUnreadCounts = async () => ({});
  let messages = Array.from({ length: 30 }, (_, i) => ({ id: `arrival-${i}`, accountId: account.id, from: 'reader@example.com', subject: 'Hello', date: new Date().toISOString(), read: true }));
  service.fetchEmails = async (_account, _folder, _limit, token) => {
    const offset = Number(token || 0); return { emails: messages.slice(offset, offset + 10), nextToken: offset + 10 < messages.length ? String(offset + 10) : null };
  };
  try {
    await watch.handleNewMail(account.id);
    assert.equal(store.getSyncState(account.id).scanned, 30); assert.equal(batches.length, 0);
    await watch.stopWatch(account.id);
    messages = [...Array.from({ length: 40 }, (_, i) => ({ ...messages[0], id: `new-${i}` })), ...messages];
    await watch.handleNewMail(account.id);
    assert.equal(batches.length, 40); assert.equal(store.getSyncState(account.id).scanned, 70);
    await watch.stopWatch(account.id); await watch.handleNewMail(account.id); assert.equal(batches.length, 40);
  } finally { rules.applyRules = oldRules; }
});
test('device credentials cannot mint new device credentials', async () => {
  const express = require('express'); const apiAuth = require('../middleware/apiAuth');
  process.env.API_TOKEN = 'master-test-token';
  const app = express(); app.use(express.json()); app.use('/api', apiAuth); app.use('/api/auth', require('../routes/auth'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const device = access.create('Limited phone'); const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/api/auth/devices', { method: 'POST', headers: { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Unwanted credential' }) });
    assert.equal(response.status, 403);
    access.revoke(device.id);
    assert.equal((await fetch(base + '/api/auth/accounts', { headers: { Authorization: `Bearer ${device.token}` } })).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); delete process.env.API_TOKEN; }
});
test.after(() => store.flush());
