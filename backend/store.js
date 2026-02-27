const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const STORE_FILE = path.join(__dirname, 'accounts.json');

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load store:', e.message);
  }
  return { accounts: [] };
}

function saveStore(data) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save store:', e.message);
  }
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
  }
};
