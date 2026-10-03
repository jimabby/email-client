const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-cache-'));
process.env.HERMES_DATA_DIR = DATA_DIR;
process.env.HERMES_SECRET_KEY = 'c'.repeat(64);
fs.writeFileSync(path.join(DATA_DIR, 'accounts.json'), '{"accounts":[],"aiSettings":{}}');
// A cache file in the old single-file format, as an older build left it.
fs.writeFileSync(path.join(DATA_DIR, 'email-cache.json'), JSON.stringify({
  'list:legacy-acc:INBOX:': { value: { emails: [{ id: 'old-1' }] }, cachedAt: '2026-01-01T00:00:00.000Z' },
}));

// Provider stubs for the send queue: "slow" never answers until released.
let releaseSlow;
const slowGate = new Promise(resolve => { releaseSlow = resolve; });
const delivered = [];
const fakeService = {
  sendEmail: async (account, email) => {
    if (account.email === 'slow@example.com') await slowGate;
    delivered.push(`${account.email}:${email.subject}`);
  },
};
require.cache[require.resolve('../services/gmailService')] = { exports: fakeService };

const store = require('../store');
const queue = require('../services/sendQueueService');
const CACHE_DIR = path.join(DATA_DIR, 'email-cache');

// ─── Offline cache ──────────────────────────────────────────────────────────

test('the old single-file cache is migrated into per-entry files', () => {
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'email-cache.json')), 'legacy file removed');
  assert.deepStrictEqual(store.getEmailCache('list:legacy-acc:INBOX:').value, { emails: [{ id: 'old-1' }] });
});

test('each entry is its own sealed file', () => {
  const before = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.bin')).length;
  store.saveEmailCache('body:acc-1:m1:INBOX', { text: 'confidential body text' });
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.bin'));
  assert.strictEqual(files.length, before + 1);
  for (const file of files) {
    assert.ok(!fs.readFileSync(path.join(CACHE_DIR, file), 'utf8').includes('confidential'), 'sealed at rest');
  }
  assert.strictEqual(store.getEmailCache('body:acc-1:m1:INBOX').value.text, 'confidential body text');
});

test('attachment bytes are never cached', () => {
  store.saveEmailCache('body:acc-1:m2:INBOX', { attachments: [{ filename: 'a.pdf', content: 'AAAA' }] });
  assert.strictEqual(store.getEmailCache('body:acc-1:m2:INBOX').value.attachments[0].content, null);
});

test('an unknown key is a miss, not an error', () => {
  assert.strictEqual(store.getEmailCache('body:nope:x:INBOX'), null);
});

test('removing an account deletes its cached mail from disk', () => {
  const account = store.addAccount({ type: 'gmail', email: 'gone@example.com' });
  store.saveEmailCache(`list:${account.id}:INBOX:`, { emails: [] });
  store.saveEmailCache(`body:${account.id}:m:INBOX`, { text: 'x' });
  store.saveEmailCache('body:keep-me:m:INBOX', { text: 'y' });
  const before = fs.readdirSync(CACHE_DIR).length;
  store.removeAccount(account.id);
  assert.strictEqual(fs.readdirSync(CACHE_DIR).length, before - 2);
  assert.strictEqual(store.getEmailCache(`body:${account.id}:m:INBOX`), null);
  assert.ok(store.getEmailCache('body:keep-me:m:INBOX'));
});

// ─── Send queue ─────────────────────────────────────────────────────────────

test('a hung account does not hold up mail from other accounts', async () => {
  const slow = store.addAccount({ type: 'gmail', email: 'slow@example.com' });
  const fast = store.addAccount({ type: 'gmail', email: 'fast@example.com' });
  queue.createQueuedSend({ accountId: slow.id, email: { to: 'a@x.com', subject: 'stuck' } });
  const job = queue.createQueuedSend({ accountId: fast.id, email: { to: 'b@x.com', subject: 'quick' } });

  const run = queue.processDueSends();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepStrictEqual(delivered, ['fast@example.com:quick']);
  assert.strictEqual(store.getSendQueueItem(job.id)?.status ?? 'sent', 'sent');

  // A second tick while the slow account is still busy must not start a
  // second, concurrent send of its stuck message.
  await Promise.race([queue.processDueSends(), new Promise(resolve => setTimeout(resolve, 20))]);
  assert.strictEqual(delivered.filter(d => d.startsWith('slow')).length, 0);

  releaseSlow();
  await run;
  assert.deepStrictEqual(delivered.sort(), ['fast@example.com:quick', 'slow@example.com:stuck']);
});
