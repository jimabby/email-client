const { v4: uuidv4 } = require('uuid');
const store = require('../store');

let intervalHandle = null;
let processingPromise = null;
const processingIds = new Set(); // IDs currently being sent

// Every send goes through this queue, so a message composed while the network
// is down is retried rather than lost. Transient failures back off; permanent
// ones (a rejected recipient, an auth error) stop immediately and surface in
// the outbox for the user to fix.
const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 15000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

function getService(accountType) {
  if (accountType === 'gmail') return require('./gmailService');
  if (accountType === 'outlook') return require('./outlookService');
  return require('./imapService');
}

function asDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeSendAt(sendAt, undoWindowSec = 0) {
  const now = Date.now();
  const parsed = asDate(sendAt);
  let sendAtMs = parsed ? parsed.getTime() : now;
  if (sendAtMs < now) sendAtMs = now;
  if (undoWindowSec > 0) {
    sendAtMs = Math.max(sendAtMs, now + undoWindowSec * 1000);
  }
  return new Date(sendAtMs).toISOString();
}

// Network-level problems are worth retrying; a 5xx from the provider is too.
// A malformed address or a revoked token will never succeed on retry.
function isTransient(err) {
  const message = String(err?.message || '');
  const code = String(err?.code || '');
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|ESOCKET/i.test(code)) return true;
  if (/network|timeout|socket|temporarily|try again|rate ?limit|too many requests/i.test(message)) return true;
  if (/\b(429|500|502|503|504)\b/.test(message)) return true;
  if (/getaddrinfo|connect\s/i.test(message)) return true;
  return false;
}

function backoffMs(attempts) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)));
}

function createQueuedSend({ accountId, email, sendAt, undoWindowSec = 0 }) {
  const normalizedSendAt = normalizeSendAt(sendAt, undoWindowSec);
  const job = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    accountId,
    email,
    sendAt: normalizedSendAt,
    nextAttemptAt: normalizedSendAt,
    canUndoUntil: undoWindowSec > 0 ? normalizedSendAt : null,
    status: 'pending',
    attempts: 0,
    error: null,
    // A short summary so the outbox UI never has to hold the full body.
    subject: email?.subject || '(no subject)',
    to: email?.to || '',
  };
  store.addSendQueueItem(job);
  return job;
}

function cancelQueuedSend(jobId) {
  const job = store.getSendQueueItem(jobId);
  if (!job) throw new Error('Scheduled send not found');
  if (job.status !== 'pending' && job.status !== 'retrying' && job.status !== 'failed') {
    throw new Error('Message can no longer be cancelled');
  }
  if (processingIds.has(jobId)) throw new Error('Message is already being sent');
  return store.updateSendQueueItem(jobId, {
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
  });
}

/** Move a failed job back into the queue for an immediate retry. */
function retryQueuedSend(jobId) {
  const job = store.getSendQueueItem(jobId);
  if (!job) throw new Error('Queued message not found');
  if (job.status === 'sent') throw new Error('Message has already been sent');
  return store.updateSendQueueItem(jobId, {
    status: 'pending',
    nextAttemptAt: new Date().toISOString(),
    error: null,
  });
}

async function processDueSends() {
  if (processingPromise) return processingPromise;
  processingPromise = _processDueSends();
  try { await processingPromise; } finally { processingPromise = null; }
}

async function _processDueSends() {
  const now = Date.now();
  const queue = store.getSendQueue()
    .filter(item => item.status === 'pending' || item.status === 'retrying')
    .filter(item => new Date(item.nextAttemptAt || item.sendAt).getTime() <= now)
    .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());

  for (const item of queue) {
    // Re-check status in case it was cancelled between iterations
    const fresh = store.getSendQueueItem(item.id);
    if (!fresh || (fresh.status !== 'pending' && fresh.status !== 'retrying')) continue;

    processingIds.add(item.id);
    const attempts = (fresh.attempts || 0) + 1;
    store.updateSendQueueItem(item.id, {
      status: 'sending',
      sendingAt: new Date().toISOString(),
      attempts,
      error: null,
    });

    try {
      const account = store.getAccount(item.accountId);
      if (!account) throw new Error('Account no longer exists');
      const service = getService(account.type);
      await service.sendEmail(account, item.email);
      store.updateSendQueueItem(item.id, {
        status: 'sent',
        sentAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown send error';
      const retryable = isTransient(err) && attempts < MAX_ATTEMPTS;
      store.updateSendQueueItem(item.id, {
        status: retryable ? 'retrying' : 'failed',
        failedAt: new Date().toISOString(),
        nextAttemptAt: retryable
          ? new Date(Date.now() + backoffMs(attempts)).toISOString()
          : undefined,
        error: retryable
          ? `${message} — retrying (attempt ${attempts} of ${MAX_ATTEMPTS})`
          : message,
      });
      if (!retryable) {
        console.error(`[outbox] Giving up on ${item.id}: ${message}`);
        // A message that will never send on its own needs the user's attention.
        try {
          require('./notificationService').notifySendFailed({ subject: item.subject, error: message });
        } catch { /* notifications are best-effort */ }
      }
    } finally {
      processingIds.delete(item.id);
    }
  }

  // Prune sent/cancelled items; failed ones stay visible in the outbox.
  store.pruneSendQueue();
}

/** Everything the outbox UI needs, without the message bodies. */
function listOutbox() {
  return store.getSendQueue().map(({ email, ...rest }) => ({
    ...rest,
    to: rest.to || email?.to || '',
    subject: rest.subject || email?.subject || '(no subject)',
    hasAttachments: !!(email?.attachments && email.attachments.length),
  }));
}

function startScheduler() {
  if (intervalHandle) return;
  // Any job left mid-send by a crash goes back in the queue.
  for (const item of store.getSendQueue()) {
    if (item.status === 'sending') {
      store.updateSendQueueItem(item.id, { status: 'pending', nextAttemptAt: new Date().toISOString() });
    }
  }
  intervalHandle = setInterval(() => {
    processDueSends().catch(() => {});
  }, 2000);
  intervalHandle.unref?.();
  processDueSends().catch(() => {});
  console.log('📤 Outbox scheduler started (retries transient failures with backoff)');
}

module.exports = {
  createQueuedSend,
  cancelQueuedSend,
  retryQueuedSend,
  listOutbox,
  processDueSends,
  startScheduler,
  // exported for tests
  _internals: { isTransient, backoffMs, normalizeSendAt },
};
