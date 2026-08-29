const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-attach-'));
process.env.HERMES_SECRET_KEY = 'a'.repeat(64);
fs.writeFileSync(path.join(process.env.HERMES_DATA_DIR, 'accounts.json'), '{"accounts":[],"aiSettings":{}}');

const express = require('express');
const store = require('../store');

// A message can name its attachment anything and declare any content type.
// Serving that back with Content-Disposition: inline used to let a sender run
// HTML on the app's own origin — the origin that holds the API token. These
// tests pin the allowlist that closed it.

const ACCOUNT = store.addAccount({
  type: 'imap', email: 'me@acme.com', name: 'Me',
  imapHost: 'imap.acme.com', smtpHost: 'smtp.acme.com', password: 'x',
});

let served = { filename: 'x', contentType: 'text/plain', content: Buffer.from('hi') };

// Stub the provider so no network is involved.
require.cache[require.resolve('../services/imapService')] = {
  exports: {
    getAttachment: async () => served,
    fetchEmails: async () => ({ emails: [], nextToken: null }),
  },
};

const app = express();
app.use(express.json());
app.use('/api/emails', require('../routes/emails'));

const server = app.listen(0);
const port = server.address().port;
test.after(() => server.close());

function get(contentType, filename, inline = true) {
  served = { filename, contentType, content: Buffer.from('<script>alert(1)</script>') };
  const url = `http://127.0.0.1:${port}/api/emails/${ACCOUNT.id}/message/${ACCOUNT.id}::7/attachment/0?inline=${inline}`;
  return fetch(url);
}

test('an HTML attachment is never served inline, however it is named', async () => {
  for (const name of ['invoice.pdf', 'photo.png', 'payload.html', 'no-extension']) {
    const res = await get('text/html', name);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream', name);
    assert.match(res.headers.get('content-disposition'), /^attachment;/, name);
  }
});

test('SVG is treated as executable, not as an image', async () => {
  const res = await get('image/svg+xml', 'logo.svg');
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment;/);
});

test('other script-capable types are forced to download too', async () => {
  for (const type of [
    'application/xhtml+xml', 'text/xml', 'application/javascript',
    'text/javascript', 'application/xml', 'image/svg+xml',
  ]) {
    const res = await get(type, 'file.bin');
    assert.equal(res.headers.get('content-type'), 'application/octet-stream', type);
  }
});

test('genuinely safe types still preview inline', async () => {
  for (const type of ['application/pdf', 'image/png', 'image/jpeg', 'text/plain']) {
    const res = await get(type, 'file');
    assert.equal(res.headers.get('content-type'), type, type);
    assert.match(res.headers.get('content-disposition'), /^inline;/, type);
  }
});

test('a parameterised safe type is normalised, not rejected', async () => {
  const res = await get('text/plain; charset=utf-8', 'notes.txt');
  assert.equal(res.headers.get('content-type'), 'text/plain');
  assert.match(res.headers.get('content-disposition'), /^inline;/);
});

test('every attachment response is sandboxed and non-sniffable', async () => {
  const res = await get('application/pdf', 'a.pdf');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /sandbox/);
  assert.match(csp, /default-src 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control'), /no-store/);
});

test('without inline=true even a safe type downloads', async () => {
  const res = await get('application/pdf', 'a.pdf', false);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment;/);
});

test('a quoted filename cannot break out of the Content-Disposition header', async () => {
  const res = await get('application/pdf', 'evil";\r\nX-Injected: 1;.pdf');
  const disposition = res.headers.get('content-disposition');
  assert.ok(!/X-Injected/i.test(res.headers.get('x-injected') || ''));
  assert.ok(!disposition.includes('\n'));
});
