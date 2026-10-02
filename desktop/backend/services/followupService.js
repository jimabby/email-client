const { randomUUID: uuidv4 } = require('crypto');
const store = require('../store');
const searchIndex = require('./searchIndexService');

// Follow-up reminders: "tell me if nobody has replied to this in N days".
//
// A reminder watches one sent message. Replies are detected from the local
// search index, which every arrival already passes through, so checking costs
// no provider calls: a message from one of the recipients, newer than the
// send, in the same conversation (or with the same subject once Re:/Fwd: are
// stripped) counts as a reply. When the due date passes with none, the user
// is notified and the reminder stays listed until they dismiss it.

const MAX_DAYS = 60;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
// A reminder that was answered is kept briefly so the UI can say so, then dropped.
const KEEP_REPLIED_MS = 3 * 24 * 60 * 60 * 1000;

let intervalHandle = null;

function addressOf(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(value || '')).trim().toLowerCase();
}

/** Every address in a To/Cc value, whether a string or an array. */
function addressList(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  return raw.split(/[,;]/).map(addressOf).filter(a => a.includes('@'));
}

function normalizeSubject(subject) {
  return String(subject || '')
    .replace(/^\s*((re|fwd?|aw|sv|wg|tr)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Start watching a sent (or queued) message.
 * @param {{ accountId: string, jobId?: string, to: string|string[], cc?: string|string[],
 *           subject?: string, threadId?: string, sentAt?: string, days: number }} input
 */
function createFollowup({ accountId, jobId, to, cc, subject, threadId, sentAt, days }) {
  const span = Number(days);
  if (!Number.isFinite(span) || span <= 0 || span > MAX_DAYS) {
    throw new Error(`Follow-up must be between 1 hour and ${MAX_DAYS} days`);
  }
  const recipients = Array.from(new Set([...addressList(to), ...addressList(cc)]));
  if (!recipients.length) throw new Error('A follow-up needs at least one recipient');

  const start = Date.parse(sentAt || '') || Date.now();
  return store.addFollowup({
    id: uuidv4(),
    accountId,
    jobId: jobId || null,
    to: Array.isArray(to) ? to.join(', ') : String(to || ''),
    recipients,
    subject: String(subject || '(no subject)').slice(0, 300),
    threadId: threadId || null,
    sentAt: new Date(start).toISOString(),
    dueAt: new Date(start + span * 24 * 60 * 60 * 1000).toISOString(),
    status: 'waiting',
    createdAt: new Date().toISOString(),
  });
}

/** The indexed message that answers this reminder, or null. */
function findReply(followup, documents = searchIndex.allDocuments()) {
  const recipients = new Set(followup.recipients || []);
  const subject = normalizeSubject(followup.subject);
  const after = Date.parse(followup.sentAt) || 0;

  for (const doc of documents) {
    if (doc.accountId !== followup.accountId) continue;
    if (!(doc.ts > after)) continue;
    if (!recipients.has(addressOf(doc.from))) continue;
    const sameThread = followup.threadId && doc.threadId && doc.threadId === followup.threadId;
    if (sameThread || (subject && normalizeSubject(doc.subject) === subject)) return doc;
  }
  return null;
}

/** Check every open reminder; notify for the ones that came due unanswered. */
function processFollowups(now = Date.now(), { notify = defaultNotify } = {}) {
  const fired = [];
  for (const followup of [...store.getFollowups()]) {
    if (followup.status === 'replied') {
      if (now - (Date.parse(followup.repliedAt) || now) > KEEP_REPLIED_MS) store.removeFollowup(followup.id);
      continue;
    }

    // A send that was undone or cancelled has nothing to follow up on.
    if (followup.jobId) {
      const job = store.getSendQueueItem(followup.jobId);
      if (job && job.status === 'cancelled') { store.removeFollowup(followup.id); continue; }
    }

    const reply = findReply(followup);
    if (reply) {
      store.updateFollowup(followup.id, { status: 'replied', repliedAt: new Date(now).toISOString(), replyId: reply.id });
      continue;
    }

    if (followup.status === 'waiting' && Date.parse(followup.dueAt) <= now) {
      const updated = store.updateFollowup(followup.id, { status: 'due', firedAt: new Date(now).toISOString() });
      try { notify(updated); } catch { /* notifications are best-effort */ }
      fired.push(updated);
    }
  }
  return fired;
}

function defaultNotify(followup) {
  require('./notificationService').notifyFollowup(followup);
}

/** Push a reminder's due date out by `days` from now and watch it again. */
function remindAgain(id, days, now = Date.now()) {
  const span = Number(days);
  if (!Number.isFinite(span) || span <= 0 || span > MAX_DAYS) throw new Error('Invalid number of days');
  const updated = store.updateFollowup(id, {
    status: 'waiting',
    dueAt: new Date(now + span * 24 * 60 * 60 * 1000).toISOString(),
    firedAt: null,
  });
  if (!updated) throw new Error('Follow-up not found');
  return updated;
}

function startScheduler() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    try { processFollowups(); } catch (err) { console.warn('[followup]', err.message); }
  }, CHECK_INTERVAL_MS);
  intervalHandle.unref?.();
  // Give the search index a moment to load before the first check.
  setTimeout(() => { try { processFollowups(); } catch { /* next tick */ } }, 30000).unref?.();
  console.log('⏰ Follow-up scheduler started (checks every 5 min)');
}

module.exports = {
  createFollowup,
  processFollowups,
  remindAgain,
  findReply,
  startScheduler,
  _internals: { normalizeSubject, addressList, MAX_DAYS },
};
