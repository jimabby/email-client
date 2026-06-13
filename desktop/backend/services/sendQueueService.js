const { v4: uuidv4 } = require('uuid');
const store = require('../store');

let intervalHandle = null;
let processingPromise = null;
const processingIds = new Set(); // IDs currently being sent

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

function createQueuedSend({ accountId, email, sendAt, undoWindowSec = 0 }) {
  const normalizedSendAt = normalizeSendAt(sendAt, undoWindowSec);
  const job = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    accountId,
    email,
    sendAt: normalizedSendAt,
    canUndoUntil: undoWindowSec > 0 ? normalizedSendAt : null,
    status: 'pending',
    error: null,
  };
  store.addSendQueueItem(job);
  return job;
}

function cancelQueuedSend(jobId) {
  const job = store.getSendQueueItem(jobId);
  if (!job) throw new Error('Scheduled send not found');
  if (job.status !== 'pending') throw new Error('Message can no longer be cancelled');
  if (processingIds.has(jobId)) throw new Error('Message is already being sent');
  return store.updateSendQueueItem(jobId, {
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
  });
}

async function processDueSends() {
  if (processingPromise) return processingPromise;
  processingPromise = _processDueSends();
  try { await processingPromise; } finally { processingPromise = null; }
}

async function _processDueSends() {
  const queue = store.getSendQueue()
    .filter(item => item.status === 'pending')
    .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());

  for (const item of queue) {
    if (new Date(item.sendAt).getTime() > Date.now()) break;

    // Re-check status in case it was cancelled between iterations
    const fresh = store.getSendQueueItem(item.id);
    if (!fresh || fresh.status !== 'pending') continue;

    processingIds.add(item.id);
    store.updateSendQueueItem(item.id, {
      status: 'sending',
      sendingAt: new Date().toISOString(),
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
      store.updateSendQueueItem(item.id, {
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : 'Unknown send error',
      });
    } finally {
      processingIds.delete(item.id);
    }
  }

  // Prune old completed items
  store.pruneSendQueue();
}

function startScheduler() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    processDueSends().catch(() => {});
  }, 1000);
  processDueSends().catch(() => {});
}

module.exports = {
  createQueuedSend,
  cancelQueuedSend,
  startScheduler,
};
