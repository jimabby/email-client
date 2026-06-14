const store = require('../store');

// When a snoozed email's wake time arrives we remove the snooze (so the inbox
// stops hiding it) and emit a synthetic new-mail event so any connected client
// refreshes and the message reappears.
let intervalHandle = null;

function processDueSnoozes() {
  const due = store.getDueSnoozes();
  if (!due.length) return;
  const { notifyNewMail } = require('./mailWatchService');
  for (const snooze of due) {
    store.removeSnooze(snooze.emailId);
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
  processDueSnoozes();
  console.log('😴 Snooze scheduler started (checks every 30s)');
}

module.exports = { startScheduler, processDueSnoozes };
