const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-routes-'));
process.env.HERMES_SECRET_KEY = 'f'.repeat(64);
// Force the store to start empty rather than seeding from the bundled file.
fs.writeFileSync(path.join(process.env.HERMES_DATA_DIR, 'accounts.json'), '{"accounts":[],"aiSettings":{}}');

const express = require('express');
const emailsRouter = require('../routes/emails');

/**
 * Ask Express which registered route a given method+path resolves to.
 * This is what the "declare static paths before /:accountId" comments in
 * routes/emails.js are protecting, and it has broken twice before — once for
 * /daily-report and once for /snoozed, each time silently 404ing because
 * Express matched the literal as an account id.
 */
function resolveRoute(method, url) {
  const layers = emailsRouter.stack.filter(layer => layer.route);
  for (const layer of layers) {
    if (!layer.route.methods[method.toLowerCase()]) continue;
    if (layer.regexp.test(url)) return layer.route.path;
  }
  return null;
}

const STATIC_GET_PATHS = [
  ['/unread-counts', '/unread-counts'],
  ['/search-index', '/search-index'],
  ['/search-all', '/search-all'],
  ['/search-attachments-all', '/search-attachments-all'],
  ['/snoozed', '/snoozed'],
  ['/daily-report', '/daily-report'],
  ['/rules', '/rules'],
  ['/templates', '/templates'],
  ['/outbox', '/outbox'],
];

for (const [url, expected] of STATIC_GET_PATHS) {
  test(`GET ${url} resolves to its own handler, not /:accountId`, () => {
    assert.strictEqual(resolveRoute('GET', url), expected);
  });
}

test('GET /rules/schema is not swallowed by /:accountId/search', () => {
  assert.strictEqual(resolveRoute('GET', '/rules/schema'), '/rules/schema');
});

test('POST /categorize and /trigger-report keep their own handlers', () => {
  assert.strictEqual(resolveRoute('POST', '/categorize'), '/categorize');
  assert.strictEqual(resolveRoute('POST', '/trigger-report'), '/trigger-report');
});

test('POST /rules/run and /rules/preview are not matched as /:accountId/folders', () => {
  assert.strictEqual(resolveRoute('POST', '/rules/run'), '/rules/run');
  assert.strictEqual(resolveRoute('POST', '/rules/preview'), '/rules/preview');
});

test('POST /outbox/:jobId/retry is not matched as a message action', () => {
  assert.strictEqual(resolveRoute('POST', '/outbox/abc123/retry'), '/outbox/:jobId/retry');
  assert.strictEqual(resolveRoute('POST', '/outbox/abc123/cancel'), '/outbox/:jobId/cancel');
});

test('a real account id still reaches the wildcard list route', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  assert.strictEqual(resolveRoute('GET', `/${uuid}`), '/:accountId');
  assert.strictEqual(resolveRoute('GET', `/${uuid}/folders`), '/:accountId/folders');
  assert.strictEqual(resolveRoute('GET', `/${uuid}/aliases`), '/:accountId/aliases');
});

test('the attachment download route is registered under the message path', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  assert.strictEqual(
    resolveRoute('GET', `/${uuid}/message/${uuid}-abc/attachment/0`),
    '/:accountId/message/:emailId/attachment/:index',
  );
});

// ─── Live requests against unknown accounts ─────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/emails', emailsRouter);
  return app;
}

async function request(app, method, url, body) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

test('static endpoints answer 200 rather than "Account not found"', async () => {
  const app = makeApp();

  const snoozed = await request(app, 'GET', '/api/emails/snoozed');
  assert.strictEqual(snoozed.status, 200);
  assert.ok(Array.isArray(snoozed.body));

  const report = await request(app, 'GET', '/api/emails/daily-report');
  assert.strictEqual(report.status, 200);

  const outbox = await request(app, 'GET', '/api/emails/outbox');
  assert.strictEqual(outbox.status, 200);
  assert.ok(Array.isArray(outbox.body));

  const schema = await request(app, 'GET', '/api/emails/rules/schema');
  assert.strictEqual(schema.status, 200);
  assert.ok(schema.body.fields.includes('from'));
});

test('an unknown account id gets a 404, not a crash', async () => {
  const res = await request(makeApp(), 'GET', '/api/emails/not-a-real-account');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'Account not found');
});

test('the local index endpoint answers without any account configured', async () => {
  const res = await request(makeApp(), 'GET', '/api/emails/search-index?q=anything');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.emails));
});

test('rules round-trip through validation', async () => {
  const app = makeApp();
  const saved = await request(app, 'PUT', '/api/emails/rules', {
    rules: [{
      name: 'File invoices',
      conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
      actions: [{ type: 'move', targetFolder: 'Bills' }],
    }],
  });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.body.length, 1);
  assert.strictEqual(saved.body[0].match, 'all');

  const listed = await request(app, 'GET', '/api/emails/rules');
  assert.strictEqual(listed.body[0].name, 'File invoices');
});

test('rule preview reports matches without touching the mailbox', async () => {
  const res = await request(makeApp(), 'POST', '/api/emails/rules/preview', {
    rule: { conditions: [{ field: 'from', op: 'contains', value: 'spam' }], actions: [{ type: 'delete' }] },
    emails: [
      { id: 'a', from: 'spam@bad.com', subject: 'hi' },
      { id: 'b', from: 'friend@good.com', subject: 'hi' },
    ],
  });
  assert.deepStrictEqual(res.body.matched, ['a']);
});
