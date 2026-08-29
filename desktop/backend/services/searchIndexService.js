const fs = require('fs');
const path = require('path');
const store = require('../store');

// Local full-text index over every message Hermes has seen.
//
// Why not SQLite FTS5: the app ships as an Electron installer, and a native
// module would need an ABI rebuild per Electron version on every platform.
// A pure-JS inverted index keeps `npm install` dependency-free and runs in the
// same process, which matters more here than the last 20% of query features.
//
// Documents hold headers plus body text; the postings map is rebuilt from the
// documents on load (fast enough at the default 50k-document cap, which
// HERMES_SEARCH_MAX_DOCS can raise) so only one file has to stay consistent
// on disk.

const DATA_DIR = process.env.HERMES_DATA_DIR || path.join(__dirname, '..');
const INDEX_FILE = path.join(DATA_DIR, 'search-index.json');
const MAX_DOCS = Number(process.env.HERMES_SEARCH_MAX_DOCS) || 50000;
const MAX_BODY_CHARS = 20000;

/** @type {Map<string, object>} emailId -> document */
const docs = new Map();
/** @type {Map<string, Set<string>>} token -> emailIds */
const postings = new Map();

// Very common English words carry no signal and blow up the postings map.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'he', 'i', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'was', 'were', 'will', 'with', 'you', 'your', 're', 'fw', 'fwd',
]);

function stripTags(text) {
  return String(text ?? '').replace(/<[^>]+>/g, ' ');
}

// NOTE: no tag stripping here. A From header is "Alice <alice@acme.com>", and
// treating <...> as markup would delete the address — making every sender
// unsearchable by their domain. HTML is stripped where bodies are ingested
// instead (see upsert), which is the only place tags can appear.
function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9@._+-]+/)
    .map(t => t.replace(/^[._-]+|[._-]+$/g, ''))
    .filter(t => t.length >= 2 && t.length <= 40 && !STOPWORDS.has(t));
}

// An address token also indexes its local part and domain, so searching
// "acme" finds mail from billing@acme.com.
function expandAddress(token) {
  if (!token.includes('@')) return [token];
  const [local, domain] = token.split('@');
  const parts = [token];
  if (local) parts.push(local);
  if (domain) {
    parts.push(domain);
    const bare = domain.split('.')[0];
    if (bare && bare !== domain) parts.push(bare);
  }
  return parts;
}

function docTokens(doc) {
  const out = new Set();
  for (const t of tokenize(doc.subject)) out.add(t);
  for (const t of tokenize(doc.from)) for (const e of expandAddress(t)) out.add(e);
  for (const t of tokenize(doc.to)) for (const e of expandAddress(t)) out.add(e);
  for (const t of tokenize(doc.body)) out.add(t);
  for (const name of doc.attachmentNames || []) for (const t of tokenize(name)) out.add(t);
  return out;
}

// A sorted copy of the vocabulary, rebuilt lazily. Prefix search used to walk
// every entry in `postings` for each term that missed — at the document cap
// that is a map of hundreds of thousands of tokens, traversed on every
// keystroke. Sorting once per vocabulary change turns it into a binary search.
let sortedTokens = null;

function addPostings(doc) {
  for (const token of docTokens(doc)) {
    let set = postings.get(token);
    if (!set) { set = new Set(); postings.set(token, set); sortedTokens = null; }
    set.add(doc.id);
  }
}

function removePostings(doc) {
  for (const token of docTokens(doc)) {
    const set = postings.get(token);
    if (!set) continue;
    set.delete(doc.id);
    if (!set.size) { postings.delete(token); sortedTokens = null; }
  }
}

function vocabulary() {
  if (!sortedTokens) sortedTokens = Array.from(postings.keys()).sort();
  return sortedTokens;
}

/** Index of the first token >= prefix, or vocab.length. */
function lowerBound(vocab, prefix) {
  let lo = 0;
  let hi = vocab.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (vocab[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function tokensWithPrefix(prefix) {
  const vocab = vocabulary();
  const out = [];
  for (let i = lowerBound(vocab, prefix); i < vocab.length; i++) {
    if (!vocab[i].startsWith(prefix)) break;
    out.push(vocab[i]);
  }
  return out;
}

// ─── Persistence ────────────────────────────────────────────────────────────

let dirty = false;
let saveTimer = null;

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 5000);
  saveTimer.unref?.();
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    const tmp = `${INDEX_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, docs: Array.from(docs.values()) }), { mode: 0o600 });
    fs.renameSync(tmp, INDEX_FILE);
  } catch (e) {
    console.error('[search] Failed to persist index:', e.message);
  }
}

function load() {
  try {
    if (!fs.existsSync(INDEX_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    for (const doc of raw.docs || []) {
      docs.set(doc.id, doc);
      addPostings(doc);
    }
    console.log(`🔎 Search index loaded (${docs.size} messages)`);
  } catch (e) {
    console.error('[search] Failed to load index, starting empty:', e.message);
    docs.clear();
    postings.clear();
    sortedTokens = null;
  }
}

process.on('exit', flush);

// ─── Writing ────────────────────────────────────────────────────────────────

function evictIfNeeded() {
  if (docs.size <= MAX_DOCS) return;
  // Oldest messages go first — recent mail is what search is actually for.
  const sorted = Array.from(docs.values()).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const doc of sorted.slice(0, docs.size - MAX_DOCS)) {
    removePostings(doc);
    docs.delete(doc.id);
  }
}

function upsert(fields) {
  if (!fields?.id) return;
  const existing = docs.get(fields.id);
  if (existing) removePostings(existing);

  const doc = {
    id: fields.id,
    accountId: fields.accountId ?? existing?.accountId ?? '',
    folder: fields.folder ?? existing?.folder ?? 'INBOX',
    from: fields.from ?? existing?.from ?? '',
    to: fields.to ?? existing?.to ?? '',
    subject: fields.subject ?? existing?.subject ?? '',
    date: fields.date ?? existing?.date ?? '',
    snippet: (fields.snippet ?? existing?.snippet ?? '').slice(0, 300),
    // Bodies are the only field that can carry markup.
    body: stripTags(fields.body ?? existing?.body ?? '').slice(0, MAX_BODY_CHARS),
    read: fields.read ?? existing?.read ?? false,
    starred: fields.starred ?? existing?.starred ?? false,
    threadId: fields.threadId ?? existing?.threadId ?? null,
    hasAttachments: fields.hasAttachments ?? existing?.hasAttachments ?? false,
    attachmentNames: fields.attachmentNames ?? existing?.attachmentNames ?? [],
    ts: Date.parse(fields.date ?? existing?.date ?? '') || existing?.ts || Date.now(),
  };

  docs.set(doc.id, doc);
  addPostings(doc);
  evictIfNeeded();
  scheduleSave();
}

/** Index a batch of list summaries (headers only). */
function indexSummaries(summaries = []) {
  for (const email of summaries) {
    if (!email?.id) continue;
    upsert({
      id: email.id,
      accountId: email.accountId,
      folder: email.folder,
      from: email.from,
      to: Array.isArray(email.to) ? email.to.join(', ') : email.to,
      subject: email.subject,
      date: email.date,
      snippet: email.snippet,
      read: email.read,
      starred: email.starred,
      threadId: email.threadId,
    });
  }
}

/** Enrich an already-indexed message with its body and attachment names. */
function indexBody(emailId, body) {
  if (!emailId || !body) return;
  const text = body.text || String(body.html || '').replace(/<[^>]+>/g, ' ');
  upsert({
    id: emailId,
    body: text.replace(/\s+/g, ' ').trim(),
    hasAttachments: !!(body.attachments && body.attachments.length),
    attachmentNames: (body.attachments || []).map(a => a.filename).filter(Boolean),
    subject: body.subject || undefined,
    from: body.from || undefined,
    to: body.to || undefined,
    date: body.date || undefined,
  });
}

function remove(emailId) {
  const doc = docs.get(emailId);
  if (!doc) return;
  removePostings(doc);
  docs.delete(emailId);
  scheduleSave();
}

function removeAccount(accountId) {
  for (const doc of Array.from(docs.values())) {
    if (doc.accountId === accountId) {
      removePostings(doc);
      docs.delete(doc.id);
    }
  }
  scheduleSave();
}

function setFlags(emailId, { read, starred } = {}) {
  const doc = docs.get(emailId);
  if (!doc) return;
  if (typeof read === 'boolean') doc.read = read;
  if (typeof starred === 'boolean') doc.starred = starred;
  scheduleSave();
}

// ─── Querying ───────────────────────────────────────────────────────────────

// Supports bare terms, "quoted phrases", and the operators from:, to:,
// subject:, has:attachment, is:unread, is:starred.
function parseQuery(raw) {
  const parsed = { terms: [], phrases: [], from: [], to: [], subject: [], hasAttachment: false, unread: false, starred: false };
  const pattern = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(raw || '')) !== null) {
    const field = (match[1] || match[3] || '').toLowerCase();
    const value = match[2] ?? match[4] ?? '';
    const phrase = match[5];
    const bare = match[6];

    if (field) {
      if (field === 'from') parsed.from.push(value.toLowerCase());
      else if (field === 'to') parsed.to.push(value.toLowerCase());
      else if (field === 'subject') parsed.subject.push(value.toLowerCase());
      else if (field === 'has' && /attach/i.test(value)) parsed.hasAttachment = true;
      else if (field === 'is' && /unread/i.test(value)) parsed.unread = true;
      else if (field === 'is' && /star/i.test(value)) parsed.starred = true;
      else parsed.terms.push(...tokenize(value));
    } else if (phrase !== undefined) {
      if (phrase.trim()) parsed.phrases.push(phrase.toLowerCase());
    } else if (bare) {
      parsed.terms.push(...tokenize(bare));
    }
  }
  return parsed;
}

function candidateIds(parsed) {
  const termSets = [];
  for (const term of parsed.terms) {
    const exact = postings.get(term);
    if (exact) { termSets.push(exact); continue; }
    // Prefix fallback so "invoic" still finds "invoice".
    const union = new Set();
    if (term.length >= 3) {
      for (const token of tokensWithPrefix(term)) {
        for (const id of postings.get(token) || []) union.add(id);
      }
    }
    termSets.push(union);
  }

  if (!termSets.length) return null; // operator-only query — scan everything

  // Rarest posting list first makes the intersection cheap.
  termSets.sort((a, b) => a.size - b.size);
  let result = new Set(termSets[0]);
  for (const set of termSets.slice(1)) {
    const next = new Set();
    for (const id of result) if (set.has(id)) next.add(id);
    result = next;
    if (!result.size) break;
  }
  return result;
}

function matchesFilters(doc, parsed) {
  const from = (doc.from || '').toLowerCase();
  const to = (doc.to || '').toLowerCase();
  const subject = (doc.subject || '').toLowerCase();
  const haystack = `${subject} ${from} ${to} ${(doc.body || '').toLowerCase()}`;

  if (parsed.from.some(v => !from.includes(v))) return false;
  if (parsed.to.some(v => !to.includes(v))) return false;
  if (parsed.subject.some(v => !subject.includes(v))) return false;
  if (parsed.phrases.some(p => !haystack.includes(p))) return false;
  if (parsed.hasAttachment && !doc.hasAttachments) return false;
  if (parsed.unread && doc.read) return false;
  if (parsed.starred && !doc.starred) return false;
  return true;
}

function score(doc, parsed) {
  const subject = (doc.subject || '').toLowerCase();
  const from = (doc.from || '').toLowerCase();
  const body = (doc.body || '').toLowerCase();

  let value = 0;
  for (const term of parsed.terms) {
    if (subject.includes(term)) value += 6;
    if (from.includes(term)) value += 4;
    if (body.includes(term)) value += 1;
  }
  for (const phrase of parsed.phrases) {
    if (subject.includes(phrase)) value += 10;
    if (body.includes(phrase)) value += 3;
  }
  if (!doc.read) value += 1;
  if (doc.starred) value += 1;

  // Recency tiebreaker: full weight this week, decaying over a year.
  const ageDays = (Date.now() - (doc.ts || 0)) / 86400000;
  value += Math.max(0, 8 - Math.log2(Math.max(1, ageDays)) * 1.2);
  return value;
}

/**
 * @returns {Array<object>} indexed documents, best match first.
 */
function search(query, { accountId = null, folder = null, limit = 50 } = {}) {
  const parsed = parseQuery(query);
  const hasCriteria = parsed.terms.length || parsed.phrases.length || parsed.from.length ||
    parsed.to.length || parsed.subject.length || parsed.hasAttachment || parsed.unread || parsed.starred;
  if (!hasCriteria) return [];

  const ids = candidateIds(parsed);
  const pool = ids ? Array.from(ids, id => docs.get(id)).filter(Boolean) : Array.from(docs.values());

  const hits = [];
  for (const doc of pool) {
    if (accountId && doc.accountId !== accountId) continue;
    if (folder && folder !== 'search' && doc.folder !== folder) continue;
    if (!matchesFilters(doc, parsed)) continue;
    hits.push(doc);
  }

  hits.sort((a, b) => score(b, parsed) - score(a, parsed));
  return hits.slice(0, limit);
}

/** Shape an indexed document back into the EmailSummary the UI expects. */
function toSummary(doc) {
  return {
    id: doc.id,
    from: doc.from,
    to: doc.to ? doc.to.split(',').map(s => s.trim()).filter(Boolean) : [],
    subject: doc.subject,
    date: doc.date,
    read: doc.read,
    starred: doc.starred,
    folder: doc.folder,
    accountId: doc.accountId,
    snippet: doc.snippet,
    threadId: doc.threadId,
    fromIndex: true,
  };
}

// ─── Background backfill ────────────────────────────────────────────────────
// Walk each account's inbox in the background so search covers more than the
// pages the user happens to have opened.

function getService(accountType) {
  if (accountType === 'gmail') return require('./gmailService');
  if (accountType === 'outlook') return require('./outlookService');
  return require('./imapService');
}

let backfillRunning = false;

async function backfill({ pages = 4, pageSize = 100 } = {}) {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    for (const account of store.getAccounts()) {
      const service = getService(account.type);
      let pageToken = null;
      for (let page = 0; page < pages; page++) {
        try {
          const result = await service.fetchEmails(account, 'INBOX', pageSize, pageToken);
          indexSummaries(result.emails || []);
          pageToken = result.nextToken;
          if (!pageToken) break;
        } catch (err) {
          console.warn(`[search] Backfill stopped for ${account.email}:`, err.message);
          break;
        }
      }
    }
    flush();
  } finally {
    backfillRunning = false;
  }
}

let schedulerHandle = null;

function startScheduler() {
  if (schedulerHandle) return;
  load();
  // First pass shortly after boot so startup stays fast, then hourly.
  setTimeout(() => backfill().catch(() => {}), 20000).unref?.();
  schedulerHandle = setInterval(() => backfill().catch(() => {}), 60 * 60 * 1000);
  schedulerHandle.unref?.();
  console.log('🔎 Search index scheduler started (backfills hourly)');
}

module.exports = {
  startScheduler,
  load,
  flush,
  indexSummaries,
  indexBody,
  remove,
  removeAccount,
  setFlags,
  search,
  toSummary,
  backfill,
  stats: () => ({ documents: docs.size, tokens: postings.size }),
  /** Every indexed document. The contacts book is derived from these. */
  allDocuments: () => docs.values(),
  // exported for tests
  _internals: { tokenize, parseQuery, score, tokensWithPrefix },
};
