const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-unified-'));
process.env.HERMES_SECRET_KEY = 'e'.repeat(64);
fs.writeFileSync(path.join(process.env.HERMES_DATA_DIR, 'accounts.json'), '{"accounts":[],"aiSettings":{}}');

/**
 * The unified inbox pages each account independently and merges by date.
 *
 * The bug this covers: an account that had run out of pages was simply left out
 * of the returned token map. On the next request the server read that missing
 * key as `undefined` — indistinguishable from "no token supplied", i.e. a first
 * load — and fetched page one again. Every "Load more" therefore re-appended
 * the first fifty messages of every exhausted account, and because the client
 * appends by id those arrived as duplicate rows sharing a React key.
 *
 * The fix is an explicit null. These tests pin both halves: the null is
 * emitted, and it is honoured on the way back in.
 */

// Stand-in provider, installed into the module cache before the router is
// loaded so `getService` resolves to it. Each account gets a scripted set of
// pages and records every fetch, which is what the assertions inspect.
const fetchLog = [];
const pages = new Map();

function fakeService() {
  return {
    async fetchEmails(account, folder, limit, pageToken) {
      fetchLog.push({ accountId: account.id, pageToken: pageToken ?? null });
      const script = pages.get(account.id) || [];
      const index = pageToken ? Number(pageToken) : 0;
      return script[index] || { emails: [], nextToken: null };
    },
  };
}

for (const name of ['gmailService', 'outlookService', 'imapService']) {
  const resolved = require.resolve(`../services/${name}`);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: fakeService() };
}

// The router also indexes what it fetches; keep that out of the way.
const searchIndexPath = require.resolve('../services/searchIndexService');
require.cache[searchIndexPath] = {
  id: searchIndexPath,
  filename: searchIndexPath,
  loaded: true,
  exports: { indexSummaries() {}, search: () => [], toSummary: (d) => d, stats: () => ({}) },
};

const express = require('express');
const store = require('../store');
const emailsRouter = require('../routes/emails');

const app = express();
app.use(express.json());
app.use('/api/emails', emailsRouter);

let server;
let base;

test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

function email(id, date) {
  return { id, accountId: id.split(':')[0], from: 'a@b.c', subject: id, date, folder: 'INBOX', read: false };
}

function seedAccounts() {
  for (const account of [...store.getAccounts()]) store.removeAccount(account.id);
  const a = store.addAccount({ type: 'gmail', email: 'a@example.com', name: 'A' });
  const b = store.addAccount({ type: 'gmail', email: 'b@example.com', name: 'B' });
  return [a.id, b.id];
}

const get = async (url) => {
  const res = await fetch(`${base}${url}`);
  return { status: res.status, body: await res.json() };
};

test('an exhausted account is reported as an explicit null, not omitted', async () => {
  const [a, b] = seedAccounts();
  fetchLog.length = 0;
  pages.clear();
  // A has a second page; B is done after its first.
  pages.set(a, [
    { emails: [email(`${a}:1`, '2026-01-02T00:00:00Z')], nextToken: '1' },
    { emails: [email(`${a}:2`, '2026-01-01T00:00:00Z')], nextToken: null },
  ]);
  pages.set(b, [{ emails: [email(`${b}:1`, '2026-01-03T00:00:00Z')], nextToken: null }]);

  const { body } = await get('/api/emails/unified?folder=INBOX&limit=50');

  assert.ok(Object.prototype.hasOwnProperty.call(body.nextTokens, b),
    'the exhausted account must still appear in the map');
  assert.strictEqual(body.nextTokens[b], null);
  assert.strictEqual(body.nextTokens[a], '1');
});

test('a second page does not re-fetch an account that has run out', async () => {
  const [a, b] = seedAccounts();
  pages.clear();
  pages.set(a, [
    { emails: [email(`${a}:1`, '2026-01-02T00:00:00Z')], nextToken: '1' },
    { emails: [email(`${a}:2`, '2026-01-01T00:00:00Z')], nextToken: null },
  ]);
  pages.set(b, [{ emails: [email(`${b}:1`, '2026-01-03T00:00:00Z')], nextToken: null }]);

  const first = await get('/api/emails/unified?folder=INBOX&limit=50');
  fetchLog.length = 0;

  const tokens = encodeURIComponent(JSON.stringify(first.body.nextTokens));
  const second = await get(`/api/emails/unified?folder=INBOX&limit=50&pageTokens=${tokens}`);

  // B must not be asked again — that request is what produced the duplicates.
  assert.deepStrictEqual(fetchLog, [{ accountId: a, pageToken: '1' }]);
  assert.deepStrictEqual(second.body.emails.map(e => e.id), [`${a}:2`]);
  assert.strictEqual(second.body.nextTokens[a], null);
  assert.strictEqual(second.body.nextTokens[b], null);
});

test('an account missing from a continuation map is treated as exhausted', async () => {
  const [a, b] = seedAccounts();
  pages.clear();
  pages.set(a, [{ emails: [email(`${a}:1`, '2026-01-02T00:00:00Z')], nextToken: '1' },
                { emails: [], nextToken: null }]);
  pages.set(b, [{ emails: [email(`${b}:1`, '2026-01-03T00:00:00Z')], nextToken: null }]);
  fetchLog.length = 0;

  // An older client sends back only the live tokens, as the server used to
  // return. B is absent, and must still not be re-read from the top.
  const tokens = encodeURIComponent(JSON.stringify({ [a]: '1' }));
  await get(`/api/emails/unified?folder=INBOX&limit=50&pageTokens=${tokens}`);

  assert.deepStrictEqual(fetchLog.map(f => f.accountId), [a]);
});

test('every account is fetched when no tokens are supplied at all', async () => {
  const [a, b] = seedAccounts();
  pages.clear();
  pages.set(a, [{ emails: [email(`${a}:1`, '2026-01-02T00:00:00Z')], nextToken: null }]);
  pages.set(b, [{ emails: [email(`${b}:1`, '2026-01-03T00:00:00Z')], nextToken: null }]);
  fetchLog.length = 0;

  await get('/api/emails/unified?folder=INBOX&limit=50');

  assert.deepStrictEqual(
    fetchLog.map(f => f.pageToken),
    [null, null],
    'a first load must read every account from the start',
  );
});

test('a message returned by two pages appears once', async () => {
  const [a, b] = seedAccounts();
  pages.clear();
  // Providers do overlap their cursors; the merge must be idempotent.
  pages.set(a, [{ emails: [email(`${a}:1`, '2026-01-02T00:00:00Z')], nextToken: null }]);
  pages.set(b, [{ emails: [email(`${a}:1`, '2026-01-02T00:00:00Z')], nextToken: null }]);

  const { body } = await get('/api/emails/unified?folder=INBOX&limit=50');
  assert.strictEqual(body.emails.length, 1);
});

test('results stay in descending date order across accounts', async () => {
  const [a, b] = seedAccounts();
  pages.clear();
  pages.set(a, [{ emails: [email(`${a}:old`, '2026-01-01T00:00:00Z')], nextToken: null }]);
  pages.set(b, [{ emails: [email(`${b}:new`, '2026-01-05T00:00:00Z')], nextToken: null }]);

  const { body } = await get('/api/emails/unified?folder=INBOX&limit=50');
  assert.deepStrictEqual(body.emails.map(e => e.id), [`${b}:new`, `${a}:old`]);
});
