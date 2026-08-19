const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-outbox-'));
process.env.HERMES_SECRET_KEY = 'e'.repeat(64);

const store = require('../store');
const queue = require('../services/sendQueueService');
const { isTransient, backoffMs, normalizeSendAt } = queue._internals;

// ─── Transient vs permanent classification ──────────────────────────────────
// This decides whether a message sits in the outbox retrying, or stops and
// asks the user for help. Getting it wrong either loses mail or spams a server.

test('network-level failures are treated as transient', () => {
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'ESOCKET']) {
    assert.ok(isTransient(Object.assign(new Error('boom'), { code })), code);
  }
});

test('rate limits and 5xx responses are transient', () => {
  assert.ok(isTransient(new Error('Graph API error: 503 Service Unavailable')));
  assert.ok(isTransient(new Error('Graph API error: 429 Too Many Requests')));
  assert.ok(isTransient(new Error('Request timeout')));
  assert.ok(isTransient(new Error('getaddrinfo ENOTFOUND smtp.example.com')));
});

test('permanent failures are not retried', () => {
  assert.ok(!isTransient(new Error('Invalid recipient address')));
  assert.ok(!isTransient(new Error('Account no longer exists')));
  assert.ok(!isTransient(new Error('550 mailbox unavailable')));
  assert.ok(!isTransient(new Error('Graph API error: 401 Unauthorized')));
});

// ─── Backoff ────────────────────────────────────────────────────────────────

test('backoff grows exponentially and is capped', () => {
  assert.strictEqual(backoffMs(1), 15000);
  assert.strictEqual(backoffMs(2), 30000);
  assert.strictEqual(backoffMs(3), 60000);
  assert.ok(backoffMs(10) <= 15 * 60 * 1000, 'must not exceed the 15 minute cap');
  assert.strictEqual(backoffMs(50), 15 * 60 * 1000);
});

// ─── Scheduling ─────────────────────────────────────────────────────────────

test('a past send time is clamped to now', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.ok(new Date(normalizeSendAt(past)).getTime() >= Date.now() - 1000);
});

test('an undo window pushes the send time out by at least that long', () => {
  const at = new Date(normalizeSendAt(undefined, 60)).getTime();
  assert.ok(at >= Date.now() + 59_000, 'undo window must delay the send');
});

test('an explicit future time is respected when it is later than the undo window', () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const at = new Date(normalizeSendAt(future, 60)).getTime();
  assert.ok(Math.abs(at - new Date(future).getTime()) < 1000);
});

test('an invalid date falls back to now rather than NaN', () => {
  const at = new Date(normalizeSendAt('not a date')).getTime();
  assert.ok(Number.isFinite(at));
});

// ─── Queue lifecycle ────────────────────────────────────────────────────────

test('createQueuedSend records a job the outbox can display', () => {
  const job = queue.createQueuedSend({
    accountId: 'acct-1',
    email: { to: 'a@b.com', subject: 'Hello', attachments: [{ filename: 'x.pdf' }] },
    undoWindowSec: 60,
  });

  assert.strictEqual(job.status, 'pending');
  assert.strictEqual(job.attempts, 0);
  assert.ok(job.canUndoUntil);

  const listed = queue.listOutbox().find(i => i.id === job.id);
  assert.strictEqual(listed.subject, 'Hello');
  assert.strictEqual(listed.to, 'a@b.com');
  assert.strictEqual(listed.hasAttachments, true);
  // The listing must not leak the message body back to the client.
  assert.strictEqual(listed.email, undefined);
});

test('cancelling a pending job marks it cancelled', () => {
  const job = queue.createQueuedSend({ accountId: 'acct-1', email: { to: 'a@b.com', subject: 'x' }, undoWindowSec: 120 });
  const cancelled = queue.cancelQueuedSend(job.id);
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.ok(cancelled.cancelledAt);
});

test('cancelling an already sent job is refused', () => {
  const job = queue.createQueuedSend({ accountId: 'acct-1', email: { to: 'a@b.com', subject: 'x' }, undoWindowSec: 60 });
  store.updateSendQueueItem(job.id, { status: 'sent', sentAt: new Date().toISOString() });
  assert.throws(() => queue.cancelQueuedSend(job.id), /no longer be cancelled/);
});

test('retry moves a failed job back to pending and clears the error', () => {
  const job = queue.createQueuedSend({ accountId: 'acct-1', email: { to: 'a@b.com', subject: 'x' }, undoWindowSec: 0 });
  store.updateSendQueueItem(job.id, { status: 'failed', error: 'mailbox full' });
  const retried = queue.retryQueuedSend(job.id);
  assert.strictEqual(retried.status, 'pending');
  assert.strictEqual(retried.error, null);
});

test('retrying an unknown job reports it clearly', () => {
  assert.throws(() => queue.retryQueuedSend('does-not-exist'), /not found/);
});

test('pruning keeps failed messages but clears old sent ones', () => {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const sent = queue.createQueuedSend({ accountId: 'acct-1', email: { to: 'a@b.com', subject: 'old' }, undoWindowSec: 0 });
  const failed = queue.createQueuedSend({ accountId: 'acct-1', email: { to: 'a@b.com', subject: 'stuck' }, undoWindowSec: 0 });
  store.updateSendQueueItem(sent.id, { status: 'sent', sentAt: old });
  store.updateSendQueueItem(failed.id, { status: 'failed', failedAt: old, error: 'nope' });

  store.pruneSendQueue();

  assert.strictEqual(store.getSendQueueItem(sent.id), null, 'old sent items are pruned');
  assert.ok(store.getSendQueueItem(failed.id), 'failed items stay until the user deals with them');
});
