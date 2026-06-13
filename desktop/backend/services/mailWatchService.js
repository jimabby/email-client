const { EventEmitter } = require('events');
const { ImapFlow } = require('imapflow');
const store = require('../store');

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

function startImapWatcher(account) {
  const watcher = {
    type: 'imap',
    accountId: account.id,
    client: null,
    reconnectTimer: null,
    lastExists: 0,
    stopped: false,
  };

  const connect = async () => {
    if (watcher.stopped) return;
    if (watcher.client) {
      // Remove all listeners before disposing old client to prevent leaks
      watcher.client.removeAllListeners();
      try { await watcher.client.logout(); } catch {}
      watcher.client = null;
    }

    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort || 993,
      secure: account.imapSecure !== false,
      auth: { user: account.email, pass: account.password },
      logger: false,
    });

    watcher.client = client;

    client.on('exists', (event) => {
      const total = event?.count ?? watcher.lastExists;
      if (total > watcher.lastExists) {
        emitNewMail(account.id, { source: 'imap-idle', delta: total - watcher.lastExists });
      }
      watcher.lastExists = total;
    });

    client.on('expunge', () => {
      watcher.lastExists = Math.max(0, watcher.lastExists - 1);
    });

    client.on('error', () => {
      scheduleReconnect();
    });

    client.on('close', () => {
      scheduleReconnect();
    });

    try {
      await client.connect();
      const mailbox = await client.mailboxOpen('INBOX');
      watcher.lastExists = mailbox.exists || 0;
    } catch {
      scheduleReconnect();
    }
  };

  const scheduleReconnect = () => {
    if (watcher.stopped) return;
    if (watcher.reconnectTimer) return;
    watcher.reconnectTimer = setTimeout(() => {
      watcher.reconnectTimer = null;
      connect().catch(() => {});
    }, 5000);
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
    lastSeenDate: null,
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
        watcher.lastSeenDate = first.date;
        return;
      }
      const changed = first.id !== watcher.lastSeenMessageId && first.date !== watcher.lastSeenDate;
      if (changed) {
        watcher.lastSeenMessageId = first.id;
        watcher.lastSeenDate = first.date;
        emitNewMail(account.id, { source: `${account.type}-poll` });
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
  return watcher;
}

function ensureWatch(accountOrId) {
  const account = typeof accountOrId === 'string'
    ? store.getAccount(accountOrId)
    : accountOrId;

  if (!account) return null;
  if (watchers.has(account.id)) return watchers.get(account.id);

  const watcher = account.type === 'imap'
    ? startImapWatcher(account)
    : startApiPollWatcher(account);

  watchers.set(account.id, watcher);
  return watcher;
}

async function stopWatch(accountId) {
  const watcher = watchers.get(accountId);
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
  stopWatch,
  subscribe,
};
