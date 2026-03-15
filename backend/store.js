const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// In packaged Electron app, HERMES_DATA_DIR points to the writable AppData folder.
// In dev mode it falls back to the backend directory.
const DATA_DIR  = process.env.HERMES_DATA_DIR || __dirname;
const STORE_FILE = path.join(DATA_DIR, 'accounts.json');

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

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load store:', e.message);
  }
  return { accounts: [], aiSettings: {} };
}

let saveQueued = false;

function saveStore(data) {
  // Debounce rapid consecutive writes into a single microtask
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    try {
      // Atomic write: write to temp file, then rename (rename is atomic on most OS)
      const tmpFile = STORE_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
      fs.renameSync(tmpFile, STORE_FILE);
    } catch (e) {
      console.error('Failed to save store:', e.message);
    }
  });
}

const store = loadStore();

module.exports = {
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
    saveStore(store);
    return account;
  },

  updateAccount(id, updates) {
    const idx = store.accounts.findIndex(a => a.id === id);
    if (idx === -1) return null;
    store.accounts[idx] = { ...store.accounts[idx], ...updates };
    saveStore(store);
    return store.accounts[idx];
  },

  removeAccount(id) {
    const idx = store.accounts.findIndex(a => a.id === id);
    if (idx === -1) return false;
    store.accounts.splice(idx, 1);
    saveStore(store);
    return true;
  },

  getAiSettings() {
    return store.aiSettings || {};
  },

  saveAiSettings({ provider, apiKey }) {
    store.aiSettings = { provider, apiKey };
    saveStore(store);
  },

  // ─── Email categories cache ───────────────────────────────────────────────
  getEmailCategories() {
    return store.categories || {};
  },

  saveEmailCategories(map) {
    if (!store.categories) store.categories = {};
    Object.assign(store.categories, map);
    saveStore(store);
  },

  // ─── Daily report run tracking ───────────────────────────────────────────
  getLastReportDate() {
    return store.lastReportDate || null;
  },

  saveLastReportDate(dateStr) {
    store.lastReportDate = dateStr;
    saveStore(store);
  },

  // ─── Daily report (one-shot, cleared after read) ──────────────────────────
  getPendingReport() {
    return store.pendingReport || null;
  },

  savePendingReport(report) {
    store.pendingReport = report;
    saveStore(store);
  },

  clearPendingReport() {
    delete store.pendingReport;
    saveStore(store);
  },

  // Scheduled/deferred send queue
  getSendQueue() {
    if (!Array.isArray(store.sendQueue)) store.sendQueue = [];
    return store.sendQueue;
  },

  addSendQueueItem(item) {
    if (!Array.isArray(store.sendQueue)) store.sendQueue = [];
    store.sendQueue.push(item);
    saveStore(store);
    return item;
  },

  updateSendQueueItem(id, updates) {
    if (!Array.isArray(store.sendQueue)) store.sendQueue = [];
    const idx = store.sendQueue.findIndex(i => i.id === id);
    if (idx === -1) return null;
    store.sendQueue[idx] = { ...store.sendQueue[idx], ...updates };
    saveStore(store);
    return store.sendQueue[idx];
  },

  getSendQueueItem(id) {
    if (!Array.isArray(store.sendQueue)) store.sendQueue = [];
    return store.sendQueue.find(i => i.id === id) || null;
  },

  // Remove completed/failed/cancelled items older than 24 hours
  pruneSendQueue() {
    if (!Array.isArray(store.sendQueue)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const before = store.sendQueue.length;
    store.sendQueue = store.sendQueue.filter(item => {
      if (item.status === 'pending' || item.status === 'sending') return true;
      const doneAt = item.sentAt || item.failedAt || item.cancelledAt;
      return doneAt && new Date(doneAt).getTime() > cutoff;
    });
    if (store.sendQueue.length !== before) saveStore(store);
  },

  // Limit categories cache to prevent unbounded growth
  pruneCategories(maxEntries = 5000) {
    if (!store.categories) return;
    const keys = Object.keys(store.categories);
    if (keys.length <= maxEntries) return;
    const toRemove = keys.slice(0, keys.length - maxEntries);
    for (const k of toRemove) delete store.categories[k];
    saveStore(store);
  }
};
