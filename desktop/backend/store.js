const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const secrets = require('./services/secretStore');

// In packaged Electron app, HERMES_DATA_DIR points to the writable AppData folder.
// In dev mode it falls back to the backend directory.
const DATA_DIR  = process.env.HERMES_DATA_DIR || __dirname;
const STORE_FILE = path.join(DATA_DIR, 'accounts.json');
// The email cache is high-churn (rewritten on every list/body fetch) and can
// grow to hundreds of MB. Keep it in its own file so account credentials and
// OAuth tokens in accounts.json aren't rewritten — or put at risk — each fetch.
const CACHE_FILE = path.join(DATA_DIR, 'email-cache.json');
// Categories churn on every inbox load and grow to thousands of entries.
// Keeping them out of accounts.json means a category refresh never rewrites
// the file holding credentials.
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');
// Queued and recently sent mail, with bodies and base64 attachments of up to
// 30 MB. It used to live in accounts.json, so every token refresh or rule run
// rewrote — and re-sealed — tens of megabytes alongside the credentials.
const OUTBOX_FILE = path.join(DATA_DIR, 'outbox.json');

// A fresh install has no accounts to seed, so nothing is ever copied in from
// the bundle. An earlier version seeded from a developer's own accounts.json
// sitting next to this module, which meant real credentials rode along inside
// the installer — the data directory is created empty instead.
function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    }
  } catch (e) {
    console.error('Failed to initialise data directory:', e.message);
  }
}

ensureDataDir();

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Failed to load ${path.basename(file)}:`, e.message);
  }
  return fallback;
}

function writeJsonAtomic(file, data) {
  const tmpFile = `${file}.tmp`;
  fs.writeFileSync(tmpFile, data, { mode: 0o600 });
  fs.renameSync(tmpFile, file);
}

/**
 * Read a file written by the sealed writer. Message content is encrypted at
 * rest; a plaintext file from an older build is read as-is and sealed on its
 * next write. When the key no longer opens the file, the unreadable copy is
 * set aside rather than overwritten — for the outbox that is unsent mail.
 */
function readSealedJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(secrets.openText(fs.readFileSync(file)));
  } catch (e) {
    console.error(`Failed to load ${path.basename(file)}:`, e.message);
    try { fs.renameSync(file, `${file}.unreadable-${Date.now()}`); } catch { /* leave it */ }
    return fallback;
  }
}

function loadStore() {
  // Credentials are sealed on disk; the in-memory copy is plaintext so the
  // provider services keep working with ordinary strings.
  return secrets.openObject(readJson(STORE_FILE, { accounts: [], aiSettings: {} }));
}

// ─── Debounced, flushable writers ───────────────────────────────────────────
// Coalesce bursts of mutations into one write, but always leave a way to force
// the pending write out (process exit, tests).

function makeWriter(file, serialize) {
  let queued = false;
  let timer = null;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queued) return;
    queued = false;
    try {
      writeJsonAtomic(file, serialize());
    } catch (e) {
      console.error(`Failed to save ${path.basename(file)}:`, e.message);
    }
  };

  const schedule = () => {
    queued = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, 50);
    timer.unref?.();
  };

  return { schedule, flush };
}

const store = loadStore();
const emailCache = readSealedJson(CACHE_FILE, {});
const categories = readJson(CATEGORIES_FILE, {});
const outbox = readSealedJson(OUTBOX_FILE, { items: [] });
if (!Array.isArray(outbox.items)) outbox.items = [];

const storeWriter = makeWriter(STORE_FILE, () => JSON.stringify(secrets.sealObject(store), null, 2));
const cacheWriter = makeWriter(CACHE_FILE, () => secrets.sealText(JSON.stringify(emailCache)));
const categoriesWriter = makeWriter(CATEGORIES_FILE, () => JSON.stringify(categories));
const outboxWriter = makeWriter(OUTBOX_FILE, () => secrets.sealText(JSON.stringify(outbox)));

const saveStore = () => storeWriter.schedule();
const saveCache = () => cacheWriter.schedule();
const saveCategories = () => categoriesWriter.schedule();
const saveOutbox = () => outboxWriter.schedule();

function flushAll() {
  storeWriter.flush();
  cacheWriter.flush();
  categoriesWriter.flush();
  outboxWriter.flush();
}

// Never lose the last few mutations when the process goes away.
process.on('exit', flushAll);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { flushAll(); process.exit(0); });
}

// ─── One-time migrations ────────────────────────────────────────────────────

// Older builds stored the message cache inside accounts.json.
if (store.emailCache && typeof store.emailCache === 'object') {
  Object.assign(emailCache, store.emailCache);
  delete store.emailCache;
  saveCache();
  saveStore();
}

// Older builds stored categories inside accounts.json.
if (store.categories && typeof store.categories === 'object') {
  Object.assign(categories, store.categories);
  delete store.categories;
  saveCategories();
  saveStore();
}

// Older builds kept the send queue inside accounts.json.
if (Array.isArray(store.sendQueue)) {
  const known = new Set(outbox.items.map(i => i.id));
  for (const item of store.sendQueue) if (!known.has(item.id)) outbox.items.push(item);
  delete store.sendQueue;
  saveOutbox();
  saveStore();
}

// IMAP ids gained their folder ("acc::uid" -> "acc::INBOX::uid"). A snooze
// saved under the old form would never match the message it hides.
if (Array.isArray(store.snoozes)) {
  let migrated = false;
  for (const snooze of store.snoozes) {
    const parts = String(snooze.emailId || '').split('::');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      const folder = snooze.folder || snooze.email?.folder || 'INBOX';
      snooze.emailId = `${parts[0]}::${folder}::${parts[1]}`;
      if (snooze.email) snooze.email.id = snooze.emailId;
      migrated = true;
    }
  }
  if (migrated) saveStore();
}

// Rules gained structured conditions; keep old single-field rules working by
// promoting them to the new shape on read.
function normalizeRule(rule) {
  if (Array.isArray(rule.conditions) && rule.conditions.length && Array.isArray(rule.actions)) return rule;
  const conditions = Array.isArray(rule.conditions) && rule.conditions.length ? rule.conditions : [];
  if (!conditions.length) {
    if (rule.from) conditions.push({ field: 'from', op: 'contains', value: rule.from });
    if (rule.subject) conditions.push({ field: 'subject', op: 'contains', value: rule.subject });
  }
  const actions = Array.isArray(rule.actions) && rule.actions.length
    ? rule.actions
    : [{ type: rule.action || 'markRead', targetFolder: rule.targetFolder || '' }];
  return { ...rule, match: rule.match || 'all', conditions, actions };
}

// Rewrite accounts.json once so any existing plaintext credentials get sealed.
if (Array.isArray(store.accounts) && store.accounts.length) saveStore();

module.exports = {
  flush: flushAll,
  dataDir: DATA_DIR,
  secretsBackend: secrets.backend,

  getAccounts() {
    return store.accounts;
  },

  getAccount(id) {
    return store.accounts.find(a => a.id === id);
  },

  addAccount(accountData) {
    const account = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      ...accountData
    };
    store.accounts.push(account);
    saveStore();
    return account;
  },

  updateAccount(id, updates) {
    const idx = store.accounts.findIndex(a => a.id === id);
    if (idx === -1) return null;
    store.accounts[idx] = { ...store.accounts[idx], ...updates };
    saveStore();
    return store.accounts[idx];
  },

  removeAccount(id) {
    const idx = store.accounts.findIndex(a => a.id === id);
    if (idx === -1) return false;
    store.accounts.splice(idx, 1);
    saveStore();
    return true;
  },

  // ─── Send-as aliases ──────────────────────────────────────────────────────
  // Extra identities the user may send from on a given account.
  getAliases(accountId) {
    const account = store.accounts.find(a => a.id === accountId);
    return Array.isArray(account?.aliases) ? account.aliases : [];
  },

  saveAliases(accountId, aliases) {
    const account = store.accounts.find(a => a.id === accountId);
    if (!account) return null;
    account.aliases = aliases;
    saveStore();
    return account.aliases;
  },

  getAiSettings() {
    return store.aiSettings || {};
  },

  saveAiSettings({ provider, apiKey }) {
    store.aiSettings = { provider, apiKey };
    saveStore();
  },

  getRules() { return (Array.isArray(store.rules) ? store.rules : []).map(normalizeRule); },
  saveRules(rules) { store.rules = Array.isArray(rules) ? rules : []; saveStore(); },

  getTemplates() { return Array.isArray(store.templates) ? store.templates : []; },
  saveTemplates(templates) { store.templates = Array.isArray(templates) ? templates : []; saveStore(); },

  // Ids of messages the rule engine has already processed, so re-listing a
  // folder never re-applies destructive actions to the same message.
  hasRuleRun(emailId) {
    return !!(store.ruleRuns && store.ruleRuns[emailId]);
  },

  markRuleRun(emailId) {
    if (!store.ruleRuns) store.ruleRuns = {};
    store.ruleRuns[emailId] = Date.now();
    const keys = Object.keys(store.ruleRuns);
    if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete store.ruleRuns[k];
    saveStore();
  },

  getEmailCache(key) { return emailCache[key] || null; },
  saveEmailCache(key, value) {
    // Keep the cache useful but bounded: attachment bytes can be tens of MB and
    // remain available online, while message text is what offline reading needs.
    const safeValue = JSON.parse(JSON.stringify(value, (name, item) => name === 'content' ? null : item));
    if (JSON.stringify(safeValue).length > 1024 * 1024) return;
    // Delete first so a refreshed entry moves to the end of the insertion
    // order. Reassigning in place kept its original slot, which made the trim
    // below evict by first-cached rather than least-recently-cached.
    delete emailCache[key];
    emailCache[key] = { value: safeValue, cachedAt: new Date().toISOString() };
    const keys = Object.keys(emailCache);
    for (const old of keys.slice(0, Math.max(0, keys.length - 300))) delete emailCache[old];
    saveCache();
  },

  // ─── Email categories cache ───────────────────────────────────────────────
  getEmailCategories() {
    return categories;
  },

  saveEmailCategories(map) {
    Object.assign(categories, map);
    saveCategories();
  },

  // ─── Daily report run tracking ───────────────────────────────────────────
  getLastReportDate() {
    return store.lastReportDate || null;
  },

  saveLastReportDate(dateStr) {
    store.lastReportDate = dateStr;
    saveStore();
  },

  // ─── Daily report (one-shot, cleared after read) ──────────────────────────
  getPendingReport() {
    return store.pendingReport || null;
  },

  savePendingReport(report) {
    store.pendingReport = report;
    saveStore();
  },

  clearPendingReport() {
    delete store.pendingReport;
    saveStore();
  },

  // ─── Send queue / outbox ──────────────────────────────────────────────────
  getSendQueue() {
    return outbox.items;
  },

  addSendQueueItem(item) {
    outbox.items.push(item);
    saveOutbox();
    return item;
  },

  updateSendQueueItem(id, updates) {
    const idx = outbox.items.findIndex(i => i.id === id);
    if (idx === -1) return null;
    const next = { ...outbox.items[idx], ...updates };
    // Once a message is out, its body and attachments are never needed again
    // (the provider's Sent folder has them) — keep only the outbox summary.
    if (next.status === 'sent') delete next.email;
    outbox.items[idx] = next;
    saveOutbox();
    return next;
  },

  getSendQueueItem(id) {
    return outbox.items.find(i => i.id === id) || null;
  },

  removeSendQueueItem(id) {
    const idx = outbox.items.findIndex(i => i.id === id);
    if (idx === -1) return false;
    outbox.items.splice(idx, 1);
    saveOutbox();
    return true;
  },

  // Remove sent/cancelled items older than 24 hours. Failed items stay until
  // the user deals with them — that is the whole point of an outbox.
  pruneSendQueue() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const before = outbox.items.length;
    outbox.items = outbox.items.filter(item => {
      if (item.status !== 'sent' && item.status !== 'cancelled') return true;
      const doneAt = item.sentAt || item.cancelledAt;
      return doneAt && new Date(doneAt).getTime() > cutoff;
    });
    if (outbox.items.length !== before) saveOutbox();
  },

  // ─── Snooze ────────────────────────────────────────────────────────────────
  // A snooze hides an email from the inbox until `until`, then a scheduler
  // removes it so the message resurfaces. Each entry keeps the full email
  // summary so the "Snoozed" view can render without re-fetching.
  getSnoozes() {
    if (!Array.isArray(store.snoozes)) store.snoozes = [];
    return store.snoozes;
  },

  addSnooze(item) {
    if (!Array.isArray(store.snoozes)) store.snoozes = [];
    const idx = store.snoozes.findIndex(s => s.emailId === item.emailId);
    if (idx === -1) store.snoozes.push(item);
    else store.snoozes[idx] = item;
    saveStore();
    return item;
  },

  removeSnooze(emailId) {
    if (!Array.isArray(store.snoozes)) return false;
    const idx = store.snoozes.findIndex(s => s.emailId === emailId);
    if (idx === -1) return false;
    store.snoozes.splice(idx, 1);
    saveStore();
    return true;
  },

  // Snoozes whose wake time has passed
  getDueSnoozes(now = Date.now()) {
    if (!Array.isArray(store.snoozes)) return [];
    return store.snoozes.filter(s => new Date(s.until).getTime() <= now);
  },

  // Drop snoozes for accounts that no longer exist
  pruneSnoozes() {
    if (!Array.isArray(store.snoozes)) return;
    const validIds = new Set(store.accounts.map(a => a.id));
    const before = store.snoozes.length;
    store.snoozes = store.snoozes.filter(s => validIds.has(s.accountId));
    if (store.snoozes.length !== before) saveStore();
  },

  // ─── Vacation auto-responder ──────────────────────────────────────────────
  // Settings plus a log of who has already been auto-replied to, so a busy
  // correspondent gets one out-of-office rather than one per message.
  getVacationSettings() {
    return store.vacation || { enabled: false };
  },

  saveVacationSettings(settings) {
    store.vacation = settings;
    saveStore();
    return store.vacation;
  },

  /** ISO timestamp of the last auto-reply sent to `email`, or null. */
  lastAutoReplyTo(email) {
    const key = String(email || '').toLowerCase();
    return store.autoReplies?.[key] || null;
  },

  recordAutoReply(email) {
    if (!store.autoReplies) store.autoReplies = {};
    const key = String(email || '').toLowerCase();
    store.autoReplies[key] = new Date().toISOString();

    // Bound the log. Oldest entries go first, which is also the least useful
    // half — a sender not written to in months should get a fresh reply anyway.
    const keys = Object.keys(store.autoReplies);
    if (keys.length > 2000) {
      const sorted = keys.sort((a, b) => String(store.autoReplies[a]).localeCompare(String(store.autoReplies[b])));
      for (const stale of sorted.slice(0, keys.length - 2000)) delete store.autoReplies[stale];
    }
    saveStore();
  },

  clearAutoReplyLog() {
    store.autoReplies = {};
    saveStore();
  },

  // ─── Registered mobile devices ────────────────────────────────────────────
  // Expo push tokens, keyed by token so a re-registration (which the app does
  // on every launch) updates rather than piles up. Not a secret — a push token
  // only lets its holder send a notification to that device — so it is not run
  // through the secret store.
  getDevices() {
    if (!Array.isArray(store.devices)) store.devices = [];
    return store.devices;
  },

  saveDevice(device) {
    if (!Array.isArray(store.devices)) store.devices = [];
    const idx = store.devices.findIndex(d => d.token === device.token);
    if (idx === -1) store.devices.push(device);
    else store.devices[idx] = { ...store.devices[idx], ...device };
    // A phone that is reinstalled repeatedly should not grow this unbounded.
    if (store.devices.length > 50) store.devices = store.devices.slice(-50);
    saveStore();
    return device;
  },

  removeDevice(token) {
    if (!Array.isArray(store.devices)) return false;
    const idx = store.devices.findIndex(d => d.token === token);
    if (idx === -1) return false;
    store.devices.splice(idx, 1);
    saveStore();
    return true;
  },

  // ─── Per-account signatures ───────────────────────────────────────────────
  // Keyed by account id, and by `${accountId}:${aliasEmail}` for an alias, so
  // sending from a second identity signs with that identity's signature.
  getSignatures() {
    return store.signatures || {};
  },

  saveSignatures(signatures) {
    store.signatures = signatures && typeof signatures === 'object' ? signatures : {};
    saveStore();
    return store.signatures;
  },

  // Limit categories cache to prevent unbounded growth
  pruneCategories(maxEntries = 5000) {
    const keys = Object.keys(categories);
    if (keys.length <= maxEntries) return;
    for (const k of keys.slice(0, keys.length - maxEntries)) delete categories[k];
    saveCategories();
  }
};
