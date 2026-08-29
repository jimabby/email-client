const { EventEmitter } = require('events');
const { ImapFlow } = require('imapflow');
const store = require('../store');
const searchIndex = require('./searchIndexService');
const notifications = require('./notificationService');
const rules = require('./rulesService');

const emitter = new EventEmitter();
emitter.setMaxListeners(50); // Allow many SSE clients
const watchers = new Map(); // accountId -> watcher

function getService(accountType) {
  if (accountType === 'gmail') return require('./gmailService');
  if (accountType === 'outlook') return require('./outlookService');
  return require('./imapService');
}

function emitNewMail(accountId, payload = {}) {
  emitter.emit('new-mail', {
    accountId,
    at: new Date().toISOString(),
    ...payload,
  });
}

// ─── New-mail pipeline ──────────────────────────────────────────────────────
// Every delivery mechanism (IDLE, Gmail push, Graph webhook, polling) funnels
// here so indexing, rules, notifications, and the badge behave identically no
// matter how the arrival was detected.

const seenIds = new Map(); // accountId -> Set of message ids already handled
const inFlight = new Map(); // accountId -> Promise, so bursts collapse

async function handleNewMail(accountId, meta = {}) {
  if (inFlight.has(accountId)) return inFlight.get(accountId);

  const task = (async () => {
    const account = store.getAccount(accountId);
    if (!account) return [];

    let emails = [];
    try {
      const service = getService(account.type);
      const result = await service.fetchEmails(account, 'INBOX', 25, null);
      emails = result?.emails || [];
    } catch (err) {
      console.warn(`[watch] Could not fetch new mail for ${account.email}: ${err.message}`);
      emitNewMail(accountId, meta);
      return [];
    }

    // Always index — cheap, and keeps search fresh even for already-seen mail.
    searchIndex.indexSummaries(emails);

    let known = seenIds.get(accountId);
    const isFirstPass = !known;
    if (!known) { known = new Set(); seenIds.set(accountId, known); }

    const fresh = emails.filter(e => !known.has(e.id));
    for (const email of emails) known.add(email.id);
    // Bound the set so a long-running process doesn't grow forever.
    if (known.size > 2000) {
      const trimmed = Array.from(known).slice(-1000);
      seenIds.set(accountId, new Set(trimmed));
    }

    // On the very first pass everything looks new; that's a cold start, not an
    // arrival, so don't fire notifications or rules for the whole inbox.
    if (!isFirstPass && fresh.length) {
      try {
        const archiveFolders = {};
        try {
          const folders = await getService(account.type).getFolders(account);
          const match = folders.find(f => /^archive$/i.test(f.name)) || folders.find(f => /all mail/i.test(f.name));
          if (match) archiveFolders[account.id] = match.path;
        } catch { /* archive rules fall back to "Archive" */ }
        await rules.applyRules(fresh, { archiveFolders });
      } catch (err) {
        console.warn('[watch] Rule run failed:', err.message);
      }
      // Auto-replies go out through the same send queue as anything else, so a
      // reply composed while the network is down is retried rather than lost.
      try { require('./vacationService').respondTo(fresh, account); }
      catch (err) { console.warn('[watch] Vacation responder failed:', err.message); }

      try { notifications.notifyNewMail(accountId, fresh); } catch { /* best effort */ }
    }

    refreshBadge().catch(() => {});
    emitNewMail(accountId, { ...meta, count: fresh.length });
    return fresh;
  })().finally(() => inFlight.delete(accountId));

  inFlight.set(accountId, task);
  return task;
}

// ─── Unread counts ──────────────────────────────────────────────────────────

// Keyed by the folder set, not just by time. refreshBadge() asks for INBOX
// alone while the sidebar asks for every folder it shows; a time-only cache let
// whichever ran first answer the other, so sidebar badges intermittently read
// zero for every folder but the inbox.
let cachedCounts = { at: 0, key: '', byAccount: {} };

function countsKey(folders) {
  return Array.from(new Set(folders)).sort().join(',');
}

/**
 * Unread/total per folder for every account. Cached briefly because the
 * sidebar asks for it often and each call hits the provider.
 */
async function getUnreadCounts({ maxAgeMs = 20000, folders } = {}) {
  const requested = folders && folders.length ? folders : ['INBOX'];
  const key = countsKey(requested);
  if (cachedCounts.key === key && Date.now() - cachedCounts.at < maxAgeMs) {
    return cachedCounts.byAccount;
  }

  const byAccount = {};
  await Promise.all(store.getAccounts().map(async (account) => {
    try {
      const service = getService(account.type);
      if (!service.getUnreadCounts) { byAccount[account.id] = {}; return; }
      byAccount[account.id] = await service.getUnreadCounts(account, requested);
    } catch {
      byAccount[account.id] = {};
    }
  }));

  cachedCounts = { at: Date.now(), key, byAccount };
  return byAccount;
}

async function refreshBadge() {
  const counts = await getUnreadCounts({ maxAgeMs: 10000 });
  let total = 0;
  for (const folders of Object.values(counts)) {
    for (const value of Object.values(folders)) total += value.unread || 0;
  }
  notifications.updateBadge(total);
  return total;
}

function invalidateCounts() {
  cachedCounts = { at: 0, key: '', byAccount: {} };
}

// ─── Watchers ───────────────────────────────────────────────────────────────

function startImapWatcher(account) {
  const watcher = {
    type: 'imap',
    accountId: account.id,
    client: null,
    reconnectTimer: null,
    lastExists: 0,
    stopped: false,
    backoffMs: 5000,
  };

  const connect = async () => {
    if (watcher.stopped) return;
    if (watcher.client) {
      // Remove all listeners before disposing old client to prevent leaks
      watcher.client.removeAllListeners();
      try { await watcher.client.logout(); } catch {}
      watcher.client = null;
    }

    const fresh = store.getAccount(account.id) || account;
    const client = new ImapFlow({
      host: fresh.imapHost,
      port: fresh.imapPort || 993,
      secure: fresh.imapSecure !== false,
      auth: { user: fresh.email, pass: fresh.password },
      tls: { rejectUnauthorized: fresh.allowInsecureTLS !== true },
      logger: false,
    });

    watcher.client = client;

    client.on('exists', (event) => {
      const total = event?.count ?? watcher.lastExists;
      if (total > watcher.lastExists) {
        handleNewMail(account.id, { source: 'imap-idle', delta: total - watcher.lastExists }).catch(() => {});
      }
      watcher.lastExists = total;
    });

    client.on('expunge', () => {
      watcher.lastExists = Math.max(0, watcher.lastExists - 1);
      invalidateCounts();
    });

    client.on('error', () => { scheduleReconnect(); });
    client.on('close', () => { scheduleReconnect(); });

    try {
      await client.connect();
      const mailbox = await client.mailboxOpen('INBOX');
      watcher.lastExists = mailbox.exists || 0;
      watcher.backoffMs = 5000; // healthy again
      // Seed the seen-set so the first real arrival is recognised as new.
      handleNewMail(account.id, { source: 'imap-connect' }).catch(() => {});
    } catch {
      scheduleReconnect();
    }
  };

  const scheduleReconnect = () => {
    if (watcher.stopped) return;
    if (watcher.reconnectTimer) return;
    // Exponential backoff: a server that is down shouldn't be hammered every
    // 5 seconds for hours.
    const delay = watcher.backoffMs;
    watcher.backoffMs = Math.min(watcher.backoffMs * 2, 5 * 60 * 1000);
    watcher.reconnectTimer = setTimeout(() => {
      watcher.reconnectTimer = null;
      connect().catch(() => {});
    }, delay);
    watcher.reconnectTimer.unref?.();
  };

  watcher.stop = async () => {
    watcher.stopped = true;
    if (watcher.reconnectTimer) {
      clearTimeout(watcher.reconnectTimer);
      watcher.reconnectTimer = null;
    }
    if (watcher.client) {
      watcher.client.removeAllListeners();
      try { await watcher.client.logout(); } catch {}
      watcher.client = null;
    }
  };

  connect().catch(() => {});
  return watcher;
}

function startApiPollWatcher(account) {
  const watcher = {
    type: account.type,
    accountId: account.id,
    timer: null,
    lastSeenMessageId: null,
  };

  const tick = async () => {
    const fresh = store.getAccount(account.id);
    if (!fresh) return;
    try {
      const service = getService(fresh.type);
      const result = await service.fetchEmails(fresh, 'INBOX', 1, null);
      const first = result?.emails?.[0];
      if (!first) return;
      if (!watcher.lastSeenMessageId) {
        watcher.lastSeenMessageId = first.id;
        // Seed the pipeline's seen-set without notifying.
        await handleNewMail(account.id, { source: `${account.type}-poll-init` });
        return;
      }
      // Message ids are stable and unique — a different id at the top of the
      // inbox means new mail (dates can collide, so don't require both).
      if (first.id !== watcher.lastSeenMessageId) {
        watcher.lastSeenMessageId = first.id;
        await handleNewMail(account.id, { source: `${account.type}-poll` });
      }
    } catch {
      // Ignore transient polling failures.
    }
  };

  watcher.stop = async () => {
    if (watcher.timer) clearInterval(watcher.timer);
  };

  tick().catch(() => {});
  watcher.timer = setInterval(() => tick().catch(() => {}), 30000);
  watcher.timer.unref?.();
  return watcher;
}

function startPushWatcher(account) {
  const service = getService(account.type);
  const watcher = {
    type: `${account.type}-push`,
    accountId: account.id,
    renewTimer: null,
    pollFallback: null,
    stop: async () => {
      if (watcher.renewTimer) clearTimeout(watcher.renewTimer);
      if (watcher.pollFallback) { await watcher.pollFallback.stop?.(); watcher.pollFallback = null; }
    },
  };
  // If push registration fails we have no delivery mechanism, so start an API
  // poller as a fallback. Once push registration later succeeds, tear it down.
  const ensurePollFallback = () => {
    if (!watcher.pollFallback) watcher.pollFallback = startApiPollWatcher(account);
  };
  const clearPollFallback = () => {
    if (watcher.pollFallback) { watcher.pollFallback.stop?.(); watcher.pollFallback = null; }
  };
  const renew = async () => {
    const fresh = store.getAccount(account.id);
    if (!fresh) return;
    try {
      if (fresh.type === 'gmail') await service.registerPushWatch(fresh, process.env.GMAIL_PUBSUB_TOPIC);
      else {
        const subscription = await service.registerPushWatch(fresh, `${process.env.PUBLIC_WEBHOOK_URL.replace(/\/$/, '')}/api/webhooks/outlook`, process.env.WEBHOOK_CLIENT_STATE);
        if (subscription?.id) store.updateAccount(fresh.id, { graphSubscriptionId: subscription.id });
      }
      clearPollFallback();
      // Seed the seen-set so the first pushed arrival is recognised as new.
      handleNewMail(account.id, { source: `${fresh.type}-push-init` }).catch(() => {});
    } catch (err) {
      console.warn(`[watch] ${fresh.type} push registration failed, falling back to polling:`, err.message);
      ensurePollFallback();
    }
    watcher.renewTimer = setTimeout(renew, fresh.type === 'gmail' ? 6 * 24 * 60 * 60 * 1000 : 2 * 24 * 60 * 60 * 1000);
    watcher.renewTimer.unref?.();
  };
  renew().catch(() => {});
  return watcher;
}

function ensureWatch(accountOrId) {
  const account = typeof accountOrId === 'string'
    ? store.getAccount(accountOrId)
    : accountOrId;

  if (!account) return null;
  if (watchers.has(account.id)) return watchers.get(account.id);

  const canPush = account.type === 'gmail' ? !!process.env.GMAIL_PUBSUB_TOPIC
    : account.type === 'outlook' ? !!(process.env.PUBLIC_WEBHOOK_URL && process.env.WEBHOOK_CLIENT_STATE) : false;
  const watcher = account.type === 'imap' ? startImapWatcher(account) : canPush ? startPushWatcher(account) : startApiPollWatcher(account);

  watchers.set(account.id, watcher);
  return watcher;
}

/** Start a watcher for every configured account (called at boot). */
function watchAll() {
  for (const account of store.getAccounts()) ensureWatch(account);
}

async function stopWatch(accountId) {
  const watcher = watchers.get(accountId);
  seenIds.delete(accountId);
  invalidateCounts();
  if (!watcher) return;
  watchers.delete(accountId);
  await watcher.stop?.();
}

function subscribe(listener) {
  emitter.on('new-mail', listener);
  return () => emitter.off('new-mail', listener);
}

module.exports = {
  ensureWatch,
  watchAll,
  stopWatch,
  subscribe,
  handleNewMail,
  getUnreadCounts,
  invalidateCounts,
  refreshBadge,
  // Allow other services (e.g. the snooze scheduler) to push a synthetic
  // new-mail event so connected SSE clients refresh the inbox.
  notifyNewMail: emitNewMail,
};
