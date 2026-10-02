const store = require('../store');

// The backend runs in an Electron utilityProcess, which has no access to the
// Notification or Tray APIs. It posts intents to the main process over the
// parent port instead; outside Electron (the Docker deploy, tests) the calls
// are no-ops.

function parentPort() {
  return process.parentPort || null;
}

function post(message) {
  const port = parentPort();
  if (!port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fan a notification out to registered mobile devices.
 *
 * Loaded lazily and guarded: push is best-effort and must never be able to
 * fail — or slow down — the arrival pipeline it hangs off.
 */
function pushToDevices(run) {
  try {
    const result = run(require('./pushService'));
    if (result && typeof result.catch === 'function') {
      result.catch(err => console.warn('[push] delivery failed:', err.message));
    }
  } catch (err) {
    console.warn('[push] delivery failed:', err.message);
  }
}

function senderName(from) {
  const match = String(from || '').match(/^\s*"?([^"<]+?)"?\s*</);
  if (match) return match[1].trim();
  const address = String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '');
  return address.trim() || 'Unknown sender';
}

function addressOf(from) {
  const match = String(from || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(from || '')).trim().toLowerCase();
}

/** A VIP entry is a full address, or "@domain" / "domain" for a whole domain. */
function isVip(from, vips = []) {
  const address = addressOf(from);
  if (!address) return false;
  const domain = address.split('@')[1] || '';
  return vips.some(raw => {
    const entry = String(raw || '').trim().toLowerCase();
    if (!entry) return false;
    if (entry.includes('@') && !entry.startsWith('@')) return entry === address;
    return domain === entry.replace(/^@/, '');
  });
}

function minutesOf(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/**
 * Minutes past midnight in the user's own time zone. The cloud backend usually
 * runs in UTC, so "22:00" has to be read in the zone the client reported.
 */
function localMinutes(now, timeZone) {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
      const hour = Number(parts.find(p => p.type === 'hour')?.value);
      const minute = Number(parts.find(p => p.type === 'minute')?.value);
      if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute;
    } catch { /* unknown zone — fall back to the server's clock */ }
  }
  return now.getHours() * 60 + now.getMinutes();
}

/** Is `now` inside the quiet window? Windows may wrap midnight (22:00–07:00). */
function inQuietHours(quiet, now = new Date(), timeZone = null) {
  if (!quiet?.enabled) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === null || end === null || start === end) return false;
  const current = localMinutes(now, timeZone);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/**
 * The messages that may interrupt the user right now. Everything still
 * arrives, is indexed, and counts toward the badge — this only decides which
 * of it is worth a toast or a push.
 */
function interrupting(emails, settings = store.getNotificationSettings(), now = new Date()) {
  const quiet = inQuietHours(settings.quietHours, now, settings.timeZone);
  return emails.filter(email => {
    const vip = isVip(email.from, settings.vips);
    if (settings.vipOnly && !vip) return false;
    if (quiet && !(vip && settings.quietHours.allowVips)) return false;
    return true;
  });
}

/**
 * Notify about newly arrived mail. Batched: one notification per burst so a
 * sync that pulls 40 messages doesn't produce 40 toasts.
 */
function notifyNewMail(accountId, emails = []) {
  const account = store.getAccount(accountId);
  const unread = interrupting(emails.filter(e => !e.read));
  if (!unread.length) return;

  // The phone is a peer of the desktop shell, not a client of it: a registered
  // device should hear about mail whether or not a window is open anywhere.
  pushToDevices(push => push.notifyNewMail(accountId, unread));

  if (unread.length === 1) {
    const email = unread[0];
    post({
      type: 'notify',
      title: senderName(email.from),
      body: email.subject || '(no subject)',
      subtitle: account?.email,
      // Clicking the toast should open this exact message.
      payload: { accountId, emailId: email.id, folder: email.folder || 'INBOX' },
    });
    return;
  }

  post({
    type: 'notify',
    title: `${unread.length} new messages`,
    body: unread.slice(0, 3).map(e => senderName(e.from)).join(', ')
      + (unread.length > 3 ? `, and ${unread.length - 3} more` : ''),
    subtitle: account?.email,
    payload: { accountId, folder: 'INBOX' },
  });
}

/**
 * A snoozed message reaching its wake time.
 *
 * Distinct from notifyNewMail because it is not an arrival: the message has
 * been sitting in the mailbox all along, and the user asked to be reminded of
 * it now. Saying so is the whole value of the feature — previously the snooze
 * simply stopped hiding the message, which is invisible unless the inbox
 * happens to be open and in view.
 */
function notifySnoozeWake(accountId, email, { title, folder } = {}) {
  const account = store.getAccount(accountId);
  pushToDevices(push => push.notifySnoozeWake(accountId, email, { folder }));
  post({
    type: 'notify',
    title: title || senderName(email?.from),
    body: email?.subject || '(no subject)',
    subtitle: account?.email ? `Snoozed · ${account.email}` : 'Snoozed message',
    payload: { accountId, emailId: email?.id, folder: folder || 'INBOX' },
  });
}

/** Push the total unread count to the tray icon / dock badge. */
function updateBadge(totalUnread) {
  post({ type: 'badge', count: Math.max(0, Number(totalUnread) || 0) });
}

/** Surface a send failure the user needs to act on. */
function notifySendFailed(job) {
  post({
    type: 'notify',
    title: 'Message not sent',
    body: `${job.subject || '(no subject)'} — ${job.error || 'send failed'}`,
    payload: { view: 'outbox' },
  });
}

/** A sent message has had no reply by the date the user asked to be told. */
function notifyFollowup(followup) {
  const account = store.getAccount(followup.accountId);
  const recipient = String(followup.to || '').split(',')[0].trim() || 'your recipient';
  pushToDevices(push => push.notifyFollowup?.(followup));
  post({
    type: 'notify',
    title: `No reply from ${senderName(recipient)}`,
    body: followup.subject || '(no subject)',
    subtitle: account?.email ? `Follow up · ${account.email}` : 'Follow up',
    payload: { view: 'followups' },
  });
}

module.exports = {
  notifyNewMail,
  notifySnoozeWake,
  notifyFollowup,
  updateBadge,
  notifySendFailed,
  available: () => !!parentPort(),
  _internals: { isVip, inQuietHours, interrupting, minutesOf },
};
