const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-backfill-'));
process.env.HERMES_SECRET_KEY = 'd'.repeat(64);

const store = require('../store');
const account = store.addAccount({ type: 'imap', email: 'resume@example.com' });
const gone = 'account-that-was-removed';

// What the previous process left behind when it stopped mid-backfill.
store.saveBackfillJob(account.id, {
  accountId: account.id, folder: 'Archive', since: null, until: null,
  running: true, scanned: 100, indexed: 40, error: null,
  startedAt: '2026-11-01T00:00:00.000Z', pageToken: 'page-2', seenTokens: ['page-2'],
});
store.saveBackfillJob(gone, { accountId: gone, folder: 'INBOX', running: true, scanned: 0, indexed: 0, pageToken: 'x', seenTokens: [] });

test('an interrupted backfill resumes from its last finished page after a restart', async () => {
  const servicePath = require.resolve('../services/imapService');
  const tokensAsked = [];
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: {
    fetchEmails: async (_account, _folder, _limit, token) => {
      tokensAsked.push(token);
      return { emails: [{ id: `${account.id}::Archive::9`, date: '2026-03-01', subject: 'Late page' }], nextToken: null };
    },
    fetchEmailBody: async () => ({ text: 'resumed body' }),
  } };

  const coverage = require('../services/searchCoverageService');
  const before = coverage.coverage().jobs.find(j => j.accountId === account.id);
  assert.equal(before.interrupted, true);
  assert.equal(before.pageToken, undefined, 'page tokens are internal');

  assert.deepEqual(coverage.resumeInterrupted(), [account.id]);
  const job = coverage.coverage().jobs.find(j => j.accountId === account.id);
  while (coverage.coverage().jobs.find(j => j.accountId === account.id).running) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(tokensAsked, ['page-2']);
  const done = coverage.coverage().jobs.find(j => j.accountId === account.id);
  assert.equal(done.scanned, 101);
  assert.equal(done.indexed, 41);
  assert.equal(done.error, null);
  assert.ok(job.resumedAt);

  // A finished job is saved without its cursor, so it is never resumed again.
  const saved = store.getBackfillJobs()[account.id];
  assert.equal(saved.running, false);
  assert.equal(saved.pageToken, undefined);
  assert.equal(store.getBackfillJobs()[gone], undefined, 'a job for a removed account is dropped');
  assert.deepEqual(coverage.resumeInterrupted(), []);
});

test.after(() => store.flush());
