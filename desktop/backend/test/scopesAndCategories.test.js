const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-scopes-'));
process.env.HERMES_SECRET_KEY = 'c'.repeat(64);

const express = require('express');
const store = require('../store');
const { categorizeEmails, overrideFor, senderAddress, senderDomain } = require('../services/categorizationService');
const { denialFor } = require('../middleware/deviceScope');
const access = require('../services/deviceAccessService');

const one = (from, subject = '', snippet = '') => categorizeEmails([{ id: 'x', from, subject, snippet }]).x;

// ─── Categorizer ────────────────────────────────────────────────────────────

test('sender patterns match whole domains, not substrings of the From text', () => {
  assert.equal(one('Dropbox <no-reply@dropbox.com>', 'Your files are ready'), 'Primary');
  assert.equal(one('FedEx <alerts@fedex.com>', 'Delivery update'), 'Primary');
  assert.equal(one('Clever <hi@clever.com>', 'Weekly update'), 'Primary');
  assert.equal(one('Netflix <info@netflix.com>', 'New arrivals this week'), 'Primary');
});

test('real platform senders are still recognised, including subdomains and other TLDs', () => {
  assert.equal(one('X <notify@x.com>', 'Trending now'), 'Social');
  assert.equal(one('X <notify@mail.x.com>', 'Trending now'), 'Social');
  assert.equal(one('Facebook <notification@facebookmail.com>', 'You have a memory'), 'Social');
  assert.equal(one('Mastodon <noreply@mastodon.social>', 'Weekly digest'), 'Social');
  assert.equal(one('Indeed <alert@indeed.co.uk>', 'Roles near you'), 'Jobs');
  assert.equal(one('Acme Careers <no-reply@lever.co>', 'Thanks'), 'Jobs');
  assert.equal(one('Amazon <ship-confirm@amazon.com.au>', 'Your order has shipped'), 'Receipts');
});

test('ordinary words in a personal subject do not trigger a category', () => {
  assert.equal(one('Mom <mom@gmail.com>', 'Can we resume our talk tomorrow?'), 'Primary');
  assert.equal(one('Google <no-reply@accounts.google.com>', 'Confirm your recovery email'), 'Primary');
  assert.equal(one('Recruiting <jobs@acme.com>', 'Your resume was received'), 'Jobs');
  assert.equal(one('Google Play <googleplay-noreply@google.com>', 'Your Google Play order receipt'), 'Receipts');
});

test('marketing senders are recognised by local part or ESP domain', () => {
  assert.equal(one('Acme <newsletter@acme.com>', 'October news'), 'Promotions');
  assert.equal(one('Acme <hello@acme.mcsv.net>', 'Hi'), 'Promotions');
  assert.equal(one('Pat <pat@acme.com>', 'Lunch?'), 'Primary');
});

test('address and domain are read from every From shape', () => {
  assert.equal(senderAddress('"Doe, Jane" <Jane@Example.COM>'), 'jane@example.com');
  assert.equal(senderAddress('jane@example.com'), 'jane@example.com');
  assert.equal(senderDomain('Jane <jane@mail.example.com>'), 'mail.example.com');
  assert.equal(senderDomain('no address here'), '');
});

test('overrides beat the rules: exact sender first, then domain and its subdomains', () => {
  const overrides = { senders: { 'boss@corp.com': 'Primary' }, domains: { 'corp.com': 'Promotions' } };
  assert.equal(overrideFor('Boss <boss@corp.com>', overrides), 'Primary');
  assert.equal(overrideFor('News <news@mail.corp.com>', overrides), 'Promotions');
  assert.equal(overrideFor('Other <a@othercorp.com>', overrides), null);
  assert.equal(categorizeEmails([{ id: 'a', from: 'X <notify@x.com>', subject: '' }], { overrides: { senders: {}, domains: { 'x.com': 'Primary' } } }).a, 'Primary');
});

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('category overrides route saves, applies to /categorize, and deletes', async () => {
  const app = express(); app.use(express.json()); app.use('/api/emails', require('../routes/emails'));
  await withServer(app, async (base) => {
    const json = { 'Content-Type': 'application/json' };
    const put = await fetch(base + '/api/emails/category-overrides', { method: 'PUT', headers: json, body: JSON.stringify({ from: 'Deals <deals@shop.example>', scope: 'domain', category: 'Primary' }) });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).key, 'shop.example');

    const bad = await fetch(base + '/api/emails/category-overrides', { method: 'PUT', headers: json, body: JSON.stringify({ from: 'a@b.com', category: 'Nonsense' }) });
    assert.equal(bad.status, 400);

    const categorized = await (await fetch(base + '/api/emails/categorize', { method: 'POST', headers: json, body: JSON.stringify({ emails: [{ id: 'm1', from: 'Deals <deals@shop.example>', subject: '50% off everything', snippet: '' }] }) })).json();
    assert.equal(categorized.categories.m1, 'Primary');

    const del = await fetch(base + '/api/emails/category-overrides', { method: 'DELETE', headers: json, body: JSON.stringify({ key: 'shop.example', scope: 'domain' }) });
    assert.deepEqual((await del.json()).overrides.domains, {});
  });
});

test('category overrides travel with the settings backup', async () => {
  store.saveCategoryOverrides({ senders: { 'pat@acme.com': 'Jobs' }, domains: {} });
  const app = express(); app.use(express.json()); app.use('/api/emails', require('../routes/emails'));
  await withServer(app, async (base) => {
    const backup = await (await fetch(base + '/api/emails/settings-export')).json();
    assert.deepEqual(backup.categoryOverrides.senders, { 'pat@acme.com': 'Jobs' });
    store.saveCategoryOverrides({ senders: {}, domains: {} });
    backup.categoryOverrides.domains = { 'evil key with spaces': 'Primary', 'ok.example': 'NotACategory', 'good.example': 'Social' };
    await fetch(base + '/api/emails/settings-import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup) });
    assert.deepEqual(store.getCategoryOverrides(), { senders: { 'pat@acme.com': 'Jobs' }, domains: { 'good.example': 'Social' } });
  });
});

// ─── Device scopes ──────────────────────────────────────────────────────────

test('scope policy: full keeps legacy access, mail loses admin routes, read is read-only', () => {
  assert.equal(denialFor(undefined, 'DELETE', '/auth/accounts/abc'), null);
  assert.equal(denialFor('full', 'POST', '/ai/settings'), null);

  assert.match(denialFor('mail', 'DELETE', '/auth/accounts/abc'), /master token/);
  assert.match(denialFor('mail', 'POST', '/ai/settings'), /master token/);
  assert.match(denialFor('mail', 'GET', '/emails/export'), /master token/);
  assert.match(denialFor('mail', 'POST', '/emails/acc1/import'), /master token/);
  assert.equal(denialFor('mail', 'POST', '/emails/acc1/send'), null);
  assert.equal(denialFor('mail', 'POST', '/emails/acc1/message/m1/move'), null);

  assert.match(denialFor('read', 'POST', '/emails/acc1/send'), /read-only/);
  assert.match(denialFor('read', 'DELETE', '/emails/acc1/message/m1'), /read-only/);
  assert.equal(denialFor('read', 'GET', '/emails/acc1/message/m1'), null);
  assert.equal(denialFor('read', 'POST', '/ai/thread-summary'), null);
  assert.equal(denialFor('read', 'POST', '/emails/acc1/message/m1/attachment/0/ticket'), null);
  assert.match(denialFor('read', 'GET', '/emails/export'), /master token/);
});

test('scoped device tokens are enforced end to end and reported by /auth-check', async () => {
  const apiAuth = require('../middleware/apiAuth');
  const { deviceScope, normalizeScope } = require('../middleware/deviceScope');
  process.env.API_TOKEN = 'master-scope-token';
  const app = express(); app.use(express.json());
  app.use('/api', (req, res, next) => apiAuth(req, res, () => deviceScope(req, res, next)));
  app.get('/api/auth-check', (req, res) => res.json({ scope: req.auth?.deviceId ? normalizeScope(req.auth.scope) : 'admin' }));
  app.use('/api/auth', require('../routes/auth'));
  try {
    await withServer(app, async (base) => {
      assert.throws(() => access.create('Bad', 'root'), /Access must be one of/);
      const reader = access.create('Tablet', 'read');
      const mailer = access.create('Phone', 'mail');
      const auth = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

      assert.equal((await (await fetch(base + '/api/auth-check', { headers: auth(reader.token) })).json()).scope, 'read');
      assert.equal((await (await fetch(base + '/api/auth-check', { headers: auth('master-scope-token') })).json()).scope, 'admin');
      assert.equal((await fetch(base + '/api/auth/accounts', { headers: auth(reader.token) })).status, 200);
      assert.equal((await fetch(base + '/api/auth/accounts/imap', { method: 'POST', headers: auth(mailer.token), body: '{}' })).status, 403);
      assert.equal((await fetch(base + '/api/auth/accounts/whatever', { method: 'PATCH', headers: auth(reader.token), body: '{}' })).status, 403);
      assert.equal(access.list().find(d => d.id === reader.id).scope, 'read');
    });
  } finally { delete process.env.API_TOKEN; }
});

test('devices created before scopes existed keep full access', () => {
  const device = access.create('Old phone');
  const raw = store.getAccessDevices().map(d => (d.id === device.id ? (({ scope, ...rest }) => rest)(d) : d));
  store.saveAccessDevices(raw);
  assert.equal(access.authenticate(device.token).scope, undefined);
  assert.equal(access.list().find(d => d.id === device.id).scope, 'full');
});

// ─── AI model parameters ────────────────────────────────────────────────────

test('Haiku 5.5 is the default and gets room to think; Haiku 4.5 keeps its old shape', () => {
  const ai = require('../services/aiService');
  assert.equal(ai.DEFAULT_MODELS.claude, 'claude-haiku-5-5');
  assert.ok(ai.MODEL_CHOICES.claude.some(c => c.id === 'claude-haiku-4-5-20251001'));
  const current = ai._internals.claudeParams('sys', 'hi');
  assert.equal(current.model, 'claude-haiku-5-5');
  assert.equal(current.max_tokens, 8000);
  assert.deepEqual(current.output_config, { effort: 'low' });
  store.saveAiSettings({ provider: 'claude', apiKey: 'k', model: 'claude-haiku-4-5-20251001' });
  const legacy = ai._internals.claudeParams('sys', 'hi');
  assert.equal(legacy.max_tokens, 1024);
  assert.equal(legacy.output_config, undefined);
  store.saveAiSettings({ provider: null, apiKey: null });
});

test.after(() => store.flush());
