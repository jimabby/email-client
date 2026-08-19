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

function senderName(from) {
  const match = String(from || '').match(/^\s*"?([^"<]+?)"?\s*</);
  if (match) return match[1].trim();
  const address = String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '');
  return address.trim() || 'Unknown sender';
}

/**
 * Notify about newly arrived mail. Batched: one notification per burst so a
 * sync that pulls 40 messages doesn't produce 40 toasts.
 */
function notifyNewMail(accountId, emails = []) {
  const account = store.getAccount(accountId);
  const unread = emails.filter(e => !e.read);
  if (!unread.length) return;

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

module.exports = { notifyNewMail, updateBadge, notifySendFailed, available: () => !!parentPort() };
