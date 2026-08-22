const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-bootstrap-'));
process.env.HERMES_SECRET_KEY = 'a'.repeat(64);
fs.writeFileSync(path.join(process.env.HERMES_DATA_DIR, 'accounts.json'), '{"accounts":[],"aiSettings":{}}');

/**
 * The page that bootstraps window.__HERMES_TOKEN__ cannot itself sit behind
 * apiAuth — it is what hands the SPA its credential. So the token must only
 * ever reach a caller on this machine. Serving it to a remote visitor would
 * give anyone who can reach the port full read/write access to every mailbox.
 */

const API_TOKEN = 'z'.repeat(48);

// Rebuild the same express wiring server.js uses for the SPA catch-all, without
// binding a port or starting the schedulers.
function buildApp({ remoteAddress }) {
  const express = require('express');
  const app = express();

  const indexHtml = '<!DOCTYPE html><html><head><title>Hermes</title></head><body></body></html>';

  function isLoopbackRequest(req) {
    const addr = req.socket.remoteAddress || '';
    if (addr === '::1') return true;
    const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
  }

  // Simulate the peer address the socket would report.
  app.use((req, res, next) => {
    Object.defineProperty(req, 'socket', { value: { remoteAddress }, configurable: true });
    next();
  });

  app.get('*', (req, res) => {
    let html = indexHtml;
    if (API_TOKEN && isLoopbackRequest(req)) {
      html = html.replace('</head>', `<script>window.__HERMES_TOKEN__=${JSON.stringify(API_TOKEN)}</script></head>`);
    }
    res.type('html').send(html);
  });

  return app;
}

function get(app, url = '/') {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      http.get({ port: server.address().port, path: url }, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => { server.close(); resolve(body); });
      }).on('error', (err) => { server.close(); reject(err); });
    });
  });
}

test('the SPA bootstrap hands the API token to a caller on this machine', async () => {
  const body = await get(buildApp({ remoteAddress: '127.0.0.1' }));
  assert.ok(body.includes('__HERMES_TOKEN__'), 'loopback request should receive the token');
  assert.ok(body.includes(API_TOKEN), 'the token value should be present');
});

test('IPv4-mapped loopback counts as local', async () => {
  const body = await get(buildApp({ remoteAddress: '::ffff:127.0.0.1' }));
  assert.ok(body.includes(API_TOKEN));
});

test('IPv6 loopback counts as local', async () => {
  const body = await get(buildApp({ remoteAddress: '::1' }));
  assert.ok(body.includes(API_TOKEN));
});

test('a remote visitor never receives the API token', async () => {
  for (const addr of ['203.0.113.9', '10.1.2.3', '172.20.0.4', '::ffff:10.1.2.3']) {
    const body = await get(buildApp({ remoteAddress: addr }));
    assert.ok(!body.includes(API_TOKEN), `${addr} must not receive the token`);
    assert.ok(!body.includes('__HERMES_TOKEN__'), `${addr} must not receive the bootstrap script`);
  }
});

test('an address that only looks loopback is rejected', async () => {
  // A hostile Host/X-Forwarded-For cannot reach this check at all, but a
  // near-miss address must not slip through the pattern either.
  for (const addr of ['1127.0.0.1', '127.0.0.1.evil.example', '0.0.0.0', '']) {
    const body = await get(buildApp({ remoteAddress: addr }));
    assert.ok(!body.includes(API_TOKEN), `${addr} must not receive the token`);
  }
});

test('the rest of the 127.0.0.0/8 range is still local', async () => {
  const body = await get(buildApp({ remoteAddress: '127.0.0.53' }));
  assert.ok(body.includes(API_TOKEN));
});
