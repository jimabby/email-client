const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-review-'));
process.env.HERMES_SECRET_KEY = 'b'.repeat(64);
const store = require('../store');
const drafts = require('../services/sharedDraftService');
const rules = require('../services/rulesService');
const account = store.addAccount({ type: 'imap', email: 'review@example.com' });
test('nested regex quantifiers finish without blocking, unsupported backreferences fail closed', () => {
  const rule = rules.sanitizeRule({ conditions: [{ field: 'subject', op: 'matches', value: '(a+)+$' }], actions: [{ type: 'markRead' }] });
  assert.equal(rules.ruleMatches({ subject: 'a'.repeat(10000) + '!' }, rule), false);
  rule.conditions[0].value = '(a)\\1';
  assert.equal(rules.ruleMatches({ subject: 'aa' }, rule), false);
});
test('failed replacement preserves old provider and shared draft; concurrent edits conflict', async () => {
  const copies = new Set(); let next = 0, fail = false;
  const service = { saveDraft: async () => { if (fail) throw new Error('Provider down'); const id = String(++next); copies.add(id); return { type: 'imap', id }; }, deleteDraft: async (_, ref) => { copies.delete(ref.id); } };
  const ref = await drafts.save(account, { draftId: 'test-draft-1', text: 'private original' }, service);
  fail = true;
  await assert.rejects(drafts.save(account, { replaceRef: ref, text: 'replacement' }, service), /Provider down/);
  assert.ok(copies.has(ref.id)); assert.equal(drafts.list()[0].text, 'private original');
  fail = false;
  const results = await Promise.allSettled([drafts.save(account, { replaceRef: ref, text: 'device A' }, service), drafts.save(account, { replaceRef: ref, text: 'device B' }, service)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal(copies.size, 1);
  await assert.rejects(drafts.remove(account, ref, service), { status: 409 });
  const bytes = fs.readFileSync(path.join(process.env.HERMES_DATA_DIR, 'shared-drafts.json'), 'utf8');
  assert.ok(!bytes.includes('device A')); assert.ok(!bytes.includes('private original'));
});
test('AI privacy blocks external work at the route, including automatic completion by default', async () => {
  const express = require('express'); const app = express(); app.use(express.json()); app.use(require('../routes/ai'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    store.saveAiPrivacy({ localOnly: true, automaticAccounts: [] });
    for (const route of ['/suggest', '/suggest-text', '/priority', '/smart-replies', '/thread-summary', '/chat']) {
      const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 403, route);
    }
    store.saveAiPrivacy({ localOnly: false, automaticAccounts: [] });
    const response = await fetch(base + '/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'complete', automatic: true, accountId: account.id }) });
    assert.equal(response.status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('search coverage groups dates and bodies by folder and rejects invalid backfills', () => {
  const index = require('../services/searchIndexService'); const coverage = require('../services/searchCoverageService');
  index.indexSummaries([{ id: 'review-msg', accountId: account.id, folder: 'Archive', subject: 'Hello', date: '2026-01-01T00:00:00Z' }]);
  index.indexBody('review-msg', { text: 'Body' });
  const group = coverage.coverage().folders.find(f => f.accountId === account.id);
  assert.equal(group.folder, 'Archive'); assert.equal(group.bodies, 1); assert.equal(group.oldest, '2026-01-01T00:00:00.000Z');
  assert.throws(() => coverage.start({ accountId: account.id, folder: 'Archive', since: 'invalid' }), /date range/);
});
test.after(() => store.flush());

test('backfill fetches bodies only within the selected dates and detects repeated pages', async () => {
  const coverage = require('../services/searchCoverageService');
  const index = require('../services/searchIndexService');
  const servicePath = require.resolve('../services/imapService');
  const previous = require.cache[servicePath];
  const fetched = [];
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: {
    fetchEmails: async () => ({ emails: [
      { id: `${account.id}::Archive::71`, date: '2026-02-01', subject: 'Included' },
      { id: `${account.id}::Archive::72`, date: '2025-02-01', subject: 'Excluded' },
    ], nextToken: 'repeated' }),
    fetchEmailBody: async (_, uid, folder) => { fetched.push([uid, folder]); return { text: 'Backfilled body' }; },
  } };
  try {
    const job = coverage.start({ accountId: account.id, folder: 'Archive', since: '2026-01-01', until: '2026-12-31' });
    assert.throws(() => coverage.start({ accountId: account.id, folder: 'Archive' }), /already running/);
    while (job.running) await new Promise(resolve => setImmediate(resolve));
    assert.match(job.error, /repeated a page token/);
    assert.deepEqual(fetched, [[71, 'Archive'], [71, 'Archive']]);
    assert.ok(Array.from(index.allDocuments()).some(d => d.id === `${account.id}::Archive::71` && d.body.includes('Backfilled')));
    assert.ok(!Array.from(index.allDocuments()).some(d => d.id === `${account.id}::Archive::72`));
  } finally { if (previous) require.cache[servicePath] = previous; else delete require.cache[servicePath]; }
});

test('a failed full scan is retried even when the top message stays the same', async () => {
  const pollingAccount = store.addAccount({ type: 'gmail', email: 'poll@example.com' });
  let scans = 0;
  const servicePath = require.resolve('../services/gmailService');
  const previous = require.cache[servicePath];
  const message = { id: pollingAccount.id + '-message', accountId: pollingAccount.id, read: true, from: 'a@example.com', subject: 'New', date: new Date().toISOString() };
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: {
    fetchEmails: async (_account, _folder, limit) => { if (limit !== 1 && ++scans === 1) throw new Error('Temporary outage'); return { emails: [message], nextToken: null }; },
    getUnreadCounts: async () => ({}),
  } };
  const watch = require('../services/mailWatchService');
  const watcher = watch._internals.startApiPollWatcher(pollingAccount);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scans, 1); assert.equal(watcher.lastSeenMessageId, null);
    await watcher.tick();
    assert.equal(scans, 2); assert.equal(watcher.lastSeenMessageId, message.id);
  } finally { await watcher.stop(); if (previous) require.cache[servicePath] = previous; else delete require.cache[servicePath]; }
});
