const store = require('../store');
const contacts = require('./contactsService');
const rules = require('./rulesService');
const screener = require('./screenerService');
const { categorizeEmails } = require('./categorizationService');

/**
 * Newsletter digest.
 *
 * With the digest on, newsletters do not land in the inbox one at a time.
 * They are filed into a holding folder ("Digest" by default) as they arrive,
 * silently, and once a day — at the time the user picked — a single
 * notification says how many are waiting. The folder is a real provider
 * folder, so webmail and the phone see the same thing.
 *
 * What counts as a newsletter:
 *   - a sender the user put in the digest (address or "@domain"), or
 *   - with auto-detect on, mail the categorizer files under Promotions
 *     (honouring the user's own category overrides).
 * Never: a sender on the "keep in inbox" list, a VIP, or anyone the user has
 * written to. Those are people, not newsletters.
 */

const MAX_LIST = 5000;
const LIST_PER_ACCOUNT = 200;
const CHECK_INTERVAL_MS = 60 * 1000;

function getService(accountType) {
  if (accountType === 'gmail') return require('./gmailService');
  if (accountType === 'outlook') return require('./outlookService');
  return require('./imapService');
}

const senderOf = (email) => contacts.parseAddressList(email?.from)[0]?.email || '';

function listMatches(list, sender) {
  if (!sender) return false;
  const domain = sender.split('@')[1] || '';
  return list.includes(sender) || list.some(entry => entry.startsWith('@') && (domain === entry.slice(1) || domain.endsWith(`.${entry.slice(1)}`)));
}

function isVip(sender) {
  const { vips } = store.getNotificationSettings();
  return listMatches((vips || []).map(v => String(v).toLowerCase()), sender);
}

/** @returns {boolean} whether this arriving message belongs in the digest */
function belongsInDigest(email, settings = store.getDigestSettings(), category = null) {
  if (!settings.enabled) return false;
  const sender = senderOf(email);
  if (!sender) return false;
  if (listMatches(settings.excluded, sender)) return false;
  if (isVip(sender)) return false;
  if (contacts.hasWrittenTo(sender)) return false;
  if (listMatches(settings.senders, sender)) return true;
  if (!settings.autoDetect) return false;
  const resolved = category || categorizeEmails([email], { overrides: store.getCategoryOverrides() })[email.id];
  return resolved === 'Promotions';
}

const folderCache = new Map();

async function digestFolderFor(account, { create = true } = {}) {
  const name = store.getDigestSettings().folder;
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
 * File freshly arrived inbox mail that belongs in the digest.
 * @returns {Promise<Set<string>>} ids moved out of the inbox
 */
async function collectArrivals(account, emails) {
  const handled = new Set();
  const settings = store.getDigestSettings();
  if (!settings.enabled || !emails.length) return handled;

  // The categories the inbox already shows win over a fresh rule-based guess,
  // so an AI-categorised Promotions message is treated the same way here.
  const cached = store.getEmailCategories();
  let folder = null;
  for (const email of emails) {
    if (!belongsInDigest(email, settings, cached[email.id] || null)) continue;
    try {
      folder = folder || await digestFolderFor(account);
      await rules.runAction(account, email, { type: 'move', targetFolder: folder });
      handled.add(email.id);
    } catch (err) {
      folderCache.delete(account.id);
      console.warn(`[digest] Could not file ${email.id}: ${err.message}`);
    }
  }
  if (handled.size) {
    const { collected } = store.getDigestState();
    collected[account.id] = (collected[account.id] || 0) + handled.size;
    store.saveDigestState({ collected });
  }
  return handled;
}

/** Everything in the digest folders, grouped by sender, newest first. */
async function list() {
  const settings = store.getDigestSettings();
  const digestState = store.getDigestState();
  const since = digestState.lastDeliveredAt ? Date.parse(digestState.lastDeliveredAt) : 0;
  const bySender = new Map();
  const errors = [];

  await Promise.all(store.getAccounts().map(async (account) => {
    try {
      const folder = await digestFolderFor(account, { create: false });
      if (!folder) return;
      const { emails = [] } = await getService(account.type).fetchEmails(account, folder, LIST_PER_ACCOUNT, null) || {};
      for (const email of emails) {
        const sender = senderOf(email) || '(unknown sender)';
        if (!bySender.has(sender)) {
          const name = contacts.parseAddressList(email.from)[0]?.name || '';
          bySender.set(sender, { sender, name, emails: [] });
        }
        bySender.get(sender).emails.push({ ...email, accountId: email.accountId || account.id, digestFolder: folder, isNew: Date.parse(email.date || '') > since });
      }
    } catch (err) {
      errors.push({ accountId: account.id, email: account.email, error: err.message });
    }
  }));

  const groups = Array.from(bySender.values()).map(group => {
    group.emails.sort((a, b) => Date.parse(b.date || '') - Date.parse(a.date || ''));
    return { ...group, latest: group.emails[0]?.date || null, count: group.emails.length, unread: group.emails.filter(e => !e.read).length };
  });
  groups.sort((a, b) => Date.parse(b.latest || '') - Date.parse(a.latest || ''));
  return { settings, state: digestState, groups, errors };
}

const normalizeSender = screener.normalizeSender;

function configure({ enabled, folder, deliverAt, autoDetect }) {
  const next = {};
  if (typeof enabled === 'boolean') next.enabled = enabled;
  if (typeof autoDetect === 'boolean') next.autoDetect = autoDetect;
  if (typeof folder === 'string' && folder.trim()) next.folder = folder.trim().slice(0, 100);
  if (deliverAt !== undefined) {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(deliverAt))) throw new Error('Delivery time must be HH:MM');
    next.deliverAt = String(deliverAt);
  }
  if (next.folder) folderCache.clear();
  return store.saveDigestSettings(next);
}

/**
 * Add a sender to the digest, or keep one out of it. A sender lives on at most
 * one of the two lists.
 * @param {'digest'|'keep'|'remove'} decision
 */
function setSender(value, decision) {
  const sender = normalizeSender(value);
  if (!sender) throw new Error('Enter an email address or @domain');
  if (!['digest', 'keep', 'remove'].includes(decision)) throw new Error('Unknown decision');
  const settings = store.getDigestSettings();
  const senders = settings.senders.filter(s => s !== sender);
  const excluded = settings.excluded.filter(s => s !== sender);
  if (decision === 'digest') senders.push(sender);
  if (decision === 'keep') excluded.push(sender);
  return store.saveDigestSettings({ senders: senders.slice(-MAX_LIST), excluded: excluded.slice(-MAX_LIST) });
}

/**
 * "Not a newsletter": keep this sender in the inbox from now on and move what
 * is already waiting back there.
 */
async function release(value, { inboxFor = () => 'INBOX' } = {}) {
  const sender = normalizeSender(value);
  if (!sender) throw new Error('Enter an email address or @domain');
  setSender(sender, 'keep');
  const { groups } = await list();
  let moved = 0;
  const failures = [];
  for (const group of groups) {
    if (!listMatches([sender], group.sender)) continue;
    for (const email of group.emails) {
      const account = store.getAccount(email.accountId);
      if (!account) continue;
      try {
        await rules.runAction(account, { ...email, folder: email.digestFolder }, { type: 'move', targetFolder: inboxFor(account) });
        moved++;
      } catch (err) {
        failures.push(err.message);
      }
    }
  }
  return { sender, moved, failures };
}

/** Mark everything waiting in the digest as read — "I've seen today's". */
async function markAllRead() {
  const { groups } = await list();
  let marked = 0;
  for (const group of groups) {
    for (const email of group.emails) {
      if (email.read) continue;
      const account = store.getAccount(email.accountId);
      if (!account) continue;
      try {
        await rules.runAction(account, { ...email, folder: email.digestFolder }, { type: 'markRead' });
        marked++;
      } catch { /* one stubborn message should not stop the rest */ }
    }
  }
  return { marked };
}

// ─── Daily delivery ─────────────────────────────────────────────────────────

/** YYYY-MM-DD and minutes-past-midnight in the user's time zone. */
function localClock(now, timeZone) {
  if (timeZone) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(now).map(p => [p.type, p.value]));
      return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
    } catch { /* unknown zone: the server's clock */ }
  }
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, minutes: now.getHours() * 60 + now.getMinutes() };
}

/** Is it time to deliver, and has today's digest not gone out yet? */
function isDue(now = new Date(), settings = store.getDigestSettings(), digestState = store.getDigestState()) {
  if (!settings.enabled) return false;
  const [h, m] = settings.deliverAt.split(':').map(Number);
  const { date, minutes } = localClock(now, store.getNotificationSettings().timeZone);
  return minutes >= h * 60 + m && digestState.lastDeliveredDate !== date;
}

/** Send today's digest notification (if anything arrived) and reset the count. */
function deliver(now = new Date()) {
  const digestState = store.getDigestState();
  const counts = Object.entries(digestState.collected).filter(([, n]) => n > 0);
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  if (total > 0) {
    require('./notificationService').notifyDigest(counts.map(([accountId, count]) => ({ accountId, count })), total);
  }
  const { date } = localClock(now, store.getNotificationSettings().timeZone);
  return store.saveDigestState({ lastDeliveredAt: now.toISOString(), lastDeliveredDate: date, collected: {}, lastCount: total });
}

let intervalHandle = null;
function startScheduler() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    try { if (isDue()) deliver(); } catch (err) { console.warn('[digest]', err.message); }
  }, CHECK_INTERVAL_MS);
  intervalHandle.unref?.();
}

module.exports = {
  belongsInDigest,
  collectArrivals,
  list,
  configure,
  setSender,
  release,
  markAllRead,
  isDue,
  deliver,
  startScheduler,
  _internals: { localClock, listMatches },
};
