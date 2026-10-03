const store = require('../store');
const contacts = require('./contactsService');
const rules = require('./rulesService');

/**
 * Sender screener.
 *
 * With the screener on, mail from someone the user has never dealt with does
 * not reach the inbox. It is moved to a holding folder ("Screener" by default)
 * and waits there for one decision per sender: allow (their mail goes to the
 * inbox from then on, and what is waiting is moved back) or block (it goes to
 * the trash, now and in future).
 *
 * "Dealt with" means: explicitly allowed, written to by the user, or already a
 * correspondent when the screener was switched on — enabling it seeds the allow
 * list from the existing contacts, so switching it on never quarantines people
 * the user already hears from.
 *
 * The holding area is a real provider folder rather than a local flag, so the
 * phone, webmail, and any other client agree on what is screened.
 */

const MAX_LIST = 5000;
const PENDING_PER_ACCOUNT = 200;

function getService(accountType) {
  if (accountType === 'gmail') return require('./gmailService');
  if (accountType === 'outlook') return require('./outlookService');
  return require('./imapService');
}

/** The bare, lower-cased sender address of a message summary. */
function senderOf(email) {
  return contacts.parseAddressList(email?.from)[0]?.email || '';
}

/** Normalise a user-supplied sender: an address, or "@domain" for a domain. */
function normalizeSender(value) {
  const raw = String(value || '').trim().toLowerCase();
  const angled = raw.match(/<([^>]+)>/);
  const sender = (angled ? angled[1] : raw).trim();
  if (/^@[^\s@]+\.[^\s@]+$/.test(sender)) return sender;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) return sender;
  return null;
}

function listMatches(list, sender) {
  const domain = `@${sender.split('@')[1] || ''}`;
  return list.includes(sender) || list.includes(domain);
}

function ownAddresses() {
  const own = new Set();
  for (const account of store.getAccounts()) {
    if (account.email) own.add(String(account.email).toLowerCase());
    for (const alias of account.aliases || []) if (alias.email) own.add(String(alias.email).toLowerCase());
  }
  return own;
}

/**
 * What the screener does with one arriving message.
 * @returns {'allow'|'block'|'screen'}
 */
function classify(email, settings = store.getScreenerSettings()) {
  if (!settings.enabled) return 'allow';
  const sender = senderOf(email);
  // Nothing to decide on — never hide mail the user could not then act on.
  if (!sender) return 'allow';
  if (listMatches(settings.blocked, sender)) return 'block';
  if (listMatches(settings.allowed, sender)) return 'allow';
  if (ownAddresses().has(sender)) return 'allow';
  if (contacts.hasWrittenTo(sender)) return 'allow';
  return 'screen';
}

// accountId -> folder path. Resolved once per process; a folder renamed or
// deleted behind our back is re-resolved after a failed move.
const folderCache = new Map();

/** The provider path of the account's screener folder, creating it if needed. */
async function screenerFolderFor(account, { create = true } = {}) {
  const name = store.getScreenerSettings().folder;
  const cached = folderCache.get(account.id);
  if (cached && cached.name === name) return cached.path;

  const service = getService(account.type);
  const folders = await service.getFolders(account);
  let match = folders.find(f => String(f.name).toLowerCase() === name.toLowerCase());
  if (!match && create) match = await service.createFolder(account, name);
  if (!match) return null;
  folderCache.set(account.id, { name, path: match.path });
  return match.path;
}

/**
 * Screen freshly arrived inbox mail for one account.
 * @returns {Promise<Set<string>>} ids that were moved out of the inbox
 */
async function screenArrivals(account, emails) {
  const handled = new Set();
  const settings = store.getScreenerSettings();
  if (!settings.enabled || !emails.length) return handled;

  let folder = null;
  for (const email of emails) {
    const verdict = classify(email, settings);
    if (verdict === 'allow') continue;
    try {
      if (verdict === 'block') {
        await rules.runAction(account, email, { type: 'delete' });
      } else {
        folder = folder || await screenerFolderFor(account);
        await rules.runAction(account, email, { type: 'move', targetFolder: folder });
      }
      handled.add(email.id);
    } catch (err) {
      folderCache.delete(account.id);
      console.warn(`[screener] Could not ${verdict} ${email.id}: ${err.message}`);
    }
  }
  return handled;
}

/** Every message waiting in a screener folder, grouped by sender. */
async function listPending() {
  const settings = store.getScreenerSettings();
  const bySender = new Map();
  const errors = [];

  await Promise.all(store.getAccounts().map(async (account) => {
    try {
      const folder = await screenerFolderFor(account, { create: false });
      if (!folder) return;
      const { emails = [] } = await getService(account.type).fetchEmails(account, folder, PENDING_PER_ACCOUNT, null) || {};
      for (const email of emails) {
        const sender = senderOf(email) || '(unknown sender)';
        if (!bySender.has(sender)) {
          const name = contacts.parseAddressList(email.from)[0]?.name || '';
          bySender.set(sender, { sender, name, emails: [] });
        }
        bySender.get(sender).emails.push({ ...email, screenerFolder: folder });
      }
    } catch (err) {
      errors.push({ accountId: account.id, email: account.email, error: err.message });
    }
  }));

  const pending = Array.from(bySender.values()).map(group => {
    group.emails.sort((a, b) => Date.parse(b.date || '') - Date.parse(a.date || ''));
    return { ...group, latest: group.emails[0]?.date || null, count: group.emails.length };
  });
  pending.sort((a, b) => Date.parse(b.latest || '') - Date.parse(a.latest || ''));
  return { ...settings, pending, errors };
}

/** Turn the screener on or off, or rename its folder. */
function configure({ enabled, folder }) {
  const current = store.getScreenerSettings();
  const next = {};
  if (typeof folder === 'string' && folder.trim()) next.folder = folder.trim().slice(0, 100);
  if (typeof enabled === 'boolean') {
    next.enabled = enabled;
    if (enabled && !current.enabled) {
      // Everyone already corresponded with is approved up front.
      contacts.invalidate();
      const seeded = new Set(current.allowed);
      for (const c of contacts.all()) seeded.add(c.email);
      next.allowed = Array.from(seeded).slice(0, MAX_LIST);
      next.enabledAt = new Date().toISOString();
    }
  }
  if (next.folder) folderCache.clear();
  return store.saveScreenerSettings(next);
}

/**
 * Record a decision about a sender and act on whatever of theirs is waiting.
 * @param {{ sender: string, decision: 'allow'|'block' }} input
 */
async function decide({ sender: rawSender, decision }) {
  const sender = normalizeSender(rawSender);
  if (!sender) throw new Error('A sender address or @domain is required');
  if (decision !== 'allow' && decision !== 'block') throw new Error('decision must be "allow" or "block"');

  const settings = store.getScreenerSettings();
  const without = (list) => list.filter(s => s !== sender);
  const allowed = without(settings.allowed);
  const blocked = without(settings.blocked);
  if (decision === 'allow') allowed.push(sender); else blocked.push(sender);
  store.saveScreenerSettings({ allowed: allowed.slice(-MAX_LIST), blocked: blocked.slice(-MAX_LIST) });

  // Release (or bin) what this sender already has waiting.
  const isDomain = sender.startsWith('@');
  const matches = (email) => {
    const from = senderOf(email);
    return isDomain ? from.endsWith(sender) : from === sender;
  };

  let moved = 0;
  let failed = 0;
  for (const account of store.getAccounts()) {
    let folder;
    try { folder = await screenerFolderFor(account, { create: false }); } catch { folder = null; }
    if (!folder) continue;
    let emails = [];
    try {
      emails = (await getService(account.type).fetchEmails(account, folder, PENDING_PER_ACCOUNT, null))?.emails || [];
    } catch { continue; }
    for (const email of emails.filter(matches)) {
      const located = { ...email, folder: email.folder || folder };
      try {
        if (decision === 'allow') await rules.runAction(account, located, { type: 'move', targetFolder: 'INBOX' });
        else await rules.runAction(account, located, { type: 'delete' });
        moved++;
      } catch (err) {
        failed++;
        console.warn(`[screener] Could not release ${email.id}: ${err.message}`);
      }
    }
  }
  return { sender, decision, moved, failed };
}

/** Forget a sender entirely — neither allowed nor blocked. */
function forget(rawSender) {
  const sender = normalizeSender(rawSender);
  if (!sender) return store.getScreenerSettings();
  const settings = store.getScreenerSettings();
  return store.saveScreenerSettings({
    allowed: settings.allowed.filter(s => s !== sender),
    blocked: settings.blocked.filter(s => s !== sender),
  });
}

module.exports = {
  classify,
  screenArrivals,
  listPending,
  configure,
  decide,
  forget,
  normalizeSender,
  _internals: { folderCache, senderOf },
};
