const store = require('../store');

// When a snoozed email's wake time arrives we remove the snooze (so the inbox
// stops hiding it), raise a notification, and emit a synthetic new-mail event
// so any connected client refreshes and the message reappears.
let intervalHandle = null;

function senderName(from) {
  const match = String(from || '').match(/^\s*"?([^"<]+?)"?\s*</);
  if (match) return match[1].trim();
  const address = String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '');
  return address.trim() || 'Unknown sender';
}

function processDueSnoozes() {
  const due = store.getDueSnoozes();
  if (!due.length) return;
  const { notifyNewMail } = require('./mailWatchService');
  const notifications = require('./notificationService');

  for (const snooze of due) {
    store.removeSnooze(snooze.emailId);

    // A snooze is a promise to resurface the message at a particular time.
    // Silently un-hiding it in a list the user may not be looking at does not
    // keep that promise, so waking raises a real notification — the same one
    // an arrival would. The click payload opens the exact message.
    try {
      if (snooze.email) {
        notifications.notifySnoozeWake(snooze.accountId, snooze.email, {
          title: senderName(snooze.email.from),
          folder: snooze.folder || snooze.email.folder || 'INBOX',
        });
      }
    } catch { /* notifications are best-effort */ }

    try {
      notifyNewMail(snooze.accountId, { source: 'snooze-wake', emailId: snooze.emailId });
    } catch { /* best effort */ }

    console.log(`[Snooze] Woke ${snooze.emailId} (account ${snooze.accountId})`);
  }
}

function startScheduler() {
  if (intervalHandle) return;
  // Drop snoozes for removed accounts on startup.
  try { store.pruneSnoozes(); } catch { /* ignore */ }
  intervalHandle = setInterval(processDueSnoozes, 30000);
  // Every other scheduler unrefs its timer; without this the backend process
  // stays alive on shutdown waiting for a tick that no longer matters.
  intervalHandle.unref?.();
  processDueSnoozes();
  console.log('😴 Snooze scheduler started (checks every 30s)');
}

module.exports = { startScheduler, processDueSnoozes };
