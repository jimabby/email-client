const searchIndex = require('./searchIndexService');

// Address book derived from mail that has already been indexed.
//
// There is no separate contact store and no provider sync: every message the
// user has sent or received already names its correspondents, and the search
// index holds all of it. Ranking is frequency plus recency, so the people you
// actually write to surface first — which is the only thing an autocomplete is
// really being asked to get right.

const MAX_CONTACTS = 5000;
const REBUILD_INTERVAL_MS = 5 * 60 * 1000;

let cache = { at: 0, contacts: [] };

/** Parse "Alice Smith <alice@acme.com>, bob@acme.com" into {name, email} pairs. */
function parseAddressList(value) {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  for (const part of parts) {
    const raw = String(part || '').trim();
    if (!raw) continue;
    const angled = raw.match(/^(.*?)\s*<([^>]+)>$/);
    const email = (angled ? angled[2] : raw).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const name = angled ? angled[1].replace(/^"|"$/g, '').trim() : '';
    out.push({ name, email });
  }
  return out;
}

// A correspondent the user has written TO is a stronger signal than one who
// merely wrote to them — anyone can land in the inbox, but the Sent folder is
// deliberate. Weight accordingly.
const WEIGHT_OUTBOUND = 4;
const WEIGHT_INBOUND = 1;

function build() {
  const byEmail = new Map();
  const now = Date.now();

  const record = ({ name, email }, weight, ts, accountId) => {
    let entry = byEmail.get(email);
    if (!entry) {
      entry = { email, name: '', score: 0, lastSeen: 0, count: 0, accountIds: new Set() };
      byEmail.set(email, entry);
    }
    // Prefer a real display name over an empty one, and a longer one over an
    // abbreviation ("A. Smith" loses to "Alice Smith").
    if (name && name.length > entry.name.length) entry.name = name;
    entry.count += 1;
    entry.lastSeen = Math.max(entry.lastSeen, ts || 0);
    if (accountId) entry.accountIds.add(accountId);
    // Recency decays over roughly a year, so an old mailing list never
    // outranks someone written to last week.
    const ageDays = Math.max(0, (now - (ts || now)) / 86400000);
    entry.score += weight * Math.max(0.2, 1 - ageDays / 365);
  };

  for (const doc of searchIndex.allDocuments()) {
    const outbound = /sent/i.test(doc.folder || '');
    // On a sent message the From is the user, so it carries no information;
    // the recipients are the deliberate choice worth weighting.
    if (!outbound) {
      for (const addr of parseAddressList(doc.from)) {
        record(addr, WEIGHT_INBOUND, doc.ts, doc.accountId);
      }
    }
    for (const addr of parseAddressList(doc.to)) {
      record(addr, outbound ? WEIGHT_OUTBOUND : WEIGHT_INBOUND, doc.ts, doc.accountId);
    }
  }

  // The user's own addresses are not contacts.
  const own = new Set();
  for (const account of require('../store').getAccounts()) {
    if (account.email) own.add(String(account.email).toLowerCase());
    for (const alias of account.aliases || []) {
      if (alias.email) own.add(String(alias.email).toLowerCase());
    }
  }

  const contacts = Array.from(byEmail.values())
    .filter(c => !own.has(c.email))
    .map(c => ({ ...c, accountIds: Array.from(c.accountIds) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CONTACTS);

  cache = { at: Date.now(), contacts };
  return contacts;
}

function all() {
  if (Date.now() - cache.at > REBUILD_INTERVAL_MS) return build();
  return cache.contacts;
}

/**
 * Autocomplete lookup.
 * @param {string} query  matched against both the display name and the address
 * @param {{ limit?: number, accountId?: string|null }} options
 */
function search(query, { limit = 10, accountId = null } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const pool = all();

  const scored = [];
  for (const contact of pool) {
    if (accountId && contact.accountIds.length && !contact.accountIds.includes(accountId)) continue;

    if (!q) {
      scored.push({ contact, boost: 0 });
      continue;
    }

    const email = contact.email;
    const name = contact.name.toLowerCase();
    // Prefix matches rank above substring matches — typing "al" should offer
    // alice@ before someone whose address merely contains "al".
    let boost = -1;
    if (email.startsWith(q) || name.startsWith(q)) boost = 2;
    else if (name.split(/\s+/).some(w => w.startsWith(q))) boost = 1.5;
    else if (email.includes(q) || name.includes(q)) boost = 0.5;
    if (boost < 0) continue;
    scored.push({ contact, boost });
  }

  scored.sort((a, b) => (b.boost - a.boost) || (b.contact.score - a.contact.score));

  return scored.slice(0, limit).map(({ contact }) => ({
    name: contact.name,
    email: contact.email,
    count: contact.count,
    lastSeen: contact.lastSeen ? new Date(contact.lastSeen).toISOString() : null,
  }));
}

/** Membership test used by the vacation responder's "known contacts only" mode. */
function isKnown(email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return false;
  return all().some(c => c.email === target);
}

function invalidate() {
  cache = { at: 0, contacts: [] };
}

module.exports = { search, all, isKnown, invalidate, parseAddressList, _internals: { build } };
