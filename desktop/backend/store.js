const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
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

// On first launch of a packaged app the user-data dir won't have accounts.json yet.
// If there's a bundled seed file next to this module, copy it over once.
function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(STORE_FILE)) {
      const bundled = path.join(__dirname, 'accounts.json');
      if (fs.existsSync(bundled)) {
        fs.copyFileSync(bundled, STORE_FILE);
      }
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
const emailCache = readJson(CACHE_FILE, {});
const categories = readJson(CATEGORIES_FILE, {});

const storeWriter = makeWriter(STORE_FILE, () => JSON.stringify(secrets.sealObject(store), null, 2));
const cacheWriter = makeWriter(CACHE_FILE, () => JSON.stringify(emailCache));
const categoriesWriter = makeWriter(CATEGORIES_FILE, () => JSON.stringify(categories));

const saveStore = () => storeWriter.schedule();
const saveCache = () => cacheWriter.schedule();
const saveCategories = () => categoriesWriter.schedule();

function flushAll() {
  storeWriter.flush();
  cacheWriter.flush();
  categoriesWriter.flush();
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
    if (!Array.isArray(store.sendQueue)) store.sendQueue = [];
    return store.sendQueue;
  },

  addSendQueueItem(item) {
    if (!Array.isArray(store.sendQueue)) store.sendQueue = [];
    store.sendQueue.push(item);
    saveStore();
    return item;
  },

  updateSendQueueItem(id, updates) {
    if (!Array.isArray(store.sendQueue)) store.sendQueue = [];
    const idx = store.sendQueue.findIndex(i => i.id === id);
    if (idx === -1) return null;
    store.sendQueue[idx] = { ...store.sendQueue[idx], ...updates };
    saveStore();
    return store.sendQueue[idx];
  },

  getSendQueueItem(id) {
    if (!Array.isArray(store.sendQueue)) store.sendQueue = [];
    return store.sendQueue.find(i => i.id === id) || null;
  },

  removeSendQueueItem(id) {
    if (!Array.isArray(store.sendQueue)) return false;
    const idx = store.sendQueue.findIndex(i => i.id === id);
    if (idx === -1) return false;
    store.sendQueue.splice(idx, 1);
    saveStore();
    return true;
  },

  // Remove sent/cancelled items older than 24 hours. Failed items stay until
  // the user deals with them — that is the whole point of an outbox.
  pruneSendQueue() {
    if (!Array.isArray(store.sendQueue)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const before = store.sendQueue.length;
    store.sendQueue = store.sendQueue.filter(item => {
      if (item.status !== 'sent' && item.status !== 'cancelled') return true;
      const doneAt = item.sentAt || item.cancelledAt;
      return doneAt && new Date(doneAt).getTime() > cutoff;
    });
    if (store.sendQueue.length !== before) saveStore();
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

  // Limit categories cache to prevent unbounded growth
  pruneCategories(maxEntries = 5000) {
    const keys = Object.keys(categories);
    if (keys.length <= maxEntries) return;
    for (const k of keys.slice(0, keys.length - maxEntries)) delete categories[k];
    saveCategories();
  }
};
