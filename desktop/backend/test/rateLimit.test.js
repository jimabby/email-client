const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');

const { apiLimiter, webhookLimiter, aiLimiter, sendLimiter, isLoopback } = require('../middleware/rateLimit');

/**
 * The desktop app hammers a loopback backend during a normal sync, so every
 * limit has to exempt local callers. What the limits actually protect is the
 * public deployment — above all /api/webhooks, which cannot be authenticated
 * (a provider can't send the Hermes token) and makes the server poll a mailbox
 * on every call.
 */

// Present the request as coming from an arbitrary address, the way it would
// behind a reverse proxy.
function withPeer(app, remoteAddress) {
  const wrapper = express();
  wrapper.use((req, res, next) => {
    Object.defineProperty(req, 'socket', { value: { remoteAddress }, configurable: true });
    next();
  });
  wrapper.use(app);
  return wrapper;
}

// One pooled agent per server. A fresh connection per request (agent: false)
// makes a 70-request flood take minutes on Windows; keep-alive keeps it to a
// blink, and destroying the agent lets server.close() settle.
function open(app, peer) {
  const server = withPeer(app, peer).listen(0, '127.0.0.1');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const ready = new Promise(r => server.once('listening', r));

  return {
    ready,
    get: (path) => new Promise((resolve, reject) => {
      http.get({ port: server.address().port, host: '127.0.0.1', path, agent }, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }).on('error', reject);
    }),
    close: () => { agent.destroy(); server.closeAllConnections?.(); server.close(); },
  };
}

async function hammer({ limiter, mount = '/', peer, path = '/', times }) {
  const inner = express();
  inner.use(mount, limiter);
  inner.get('*', (req, res) => res.json({ ok: true }));

  const client = open(inner, peer);
  await client.ready;

  const codes = [];
  for (let i = 0; i < times; i++) codes.push((await client.get(path)).status);
  client.close();
  return codes;
}

test('isLoopback recognises every form of a local peer', () => {
  for (const addr of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopback({ socket: { remoteAddress: addr } }), true, addr);
  }
  for (const addr of ['203.0.113.9', '10.1.2.3', '::ffff:10.1.2.3', '', undefined]) {
    assert.equal(isLoopback({ socket: { remoteAddress: addr } }), false, String(addr));
  }
  // A request with no socket at all must not be treated as local.
  assert.equal(isLoopback({}), false);
});

test('a local caller is never rate limited', async () => {
  // Well past the webhook limit of 60/min.
  const codes = await hammer({ limiter: webhookLimiter, peer: '127.0.0.1', times: 80 });
  assert.ok(codes.every(c => c === 200), 'loopback must never be throttled');
});

test('a remote caller is cut off once the webhook limit is reached', async () => {
  const codes = await hammer({ limiter: webhookLimiter, peer: '198.51.100.7', times: 70 });
  assert.equal(codes[0], 200, 'the first request should pass');
  assert.ok(codes.includes(429), 'the flood should eventually be rejected');
  assert.equal(codes.at(-1), 429, 'and stay rejected once over the limit');
  assert.equal(codes.filter(c => c === 200).length, 60, 'exactly the limit should pass');
});

test('the AI limit is tighter than the general API limit', async () => {
  const ai = await hammer({ limiter: aiLimiter, peer: '198.51.100.8', times: 45 });
  assert.equal(ai.filter(c => c === 200).length, 40);
});

test('the send limit is the tightest of all', async () => {
  const sent = await hammer({ limiter: sendLimiter, peer: '198.51.100.9', times: 35 });
  assert.equal(sent.filter(c => c === 200).length, 30);
});

test('a throttled response says what happened rather than failing blank', async () => {
  const inner = express();
  inner.use('/', webhookLimiter);
  inner.get('*', (req, res) => res.json({ ok: true }));

  const client = open(inner, '198.51.100.10');
  await client.ready;

  let last;
  for (let i = 0; i < 65; i++) last = await client.get('/');
  client.close();

  assert.equal(last.status, 429);
  assert.match(last.body, /Too many webhook requests/);
});

test('the send limiter is scoped to /send and does not catch /send-queue', async () => {
  // /send-queue/:id/cancel is how a queued message is recalled — throttling it
  // alongside sending would make "undo send" fail exactly when it is needed.
  const inner = express();
  inner.use('/api/emails/:accountId/send', sendLimiter);
  inner.get('*', (req, res) => res.json({ limited: !!res.getHeader('ratelimit') }));

  const client = open(inner, '198.51.100.11');
  await client.ready;

  const limited = async (path) => JSON.parse((await client.get(path)).body).limited;

  assert.equal(await limited('/api/emails/acc1/send'), true, '/send should be limited');
  assert.equal(await limited('/api/emails/acc1/send-queue/job1/cancel'), false, '/send-queue must not be');
  assert.equal(await limited('/api/emails/acc1'), false, 'the folder listing must not be');
  client.close();
});
