const store = require('../store');
const contacts = require('./contactsService');

// Vacation auto-responder.
//
// Runs on the server against the arrival pipeline, so it answers mail whether
// or not a client is open — the same property that makes the rule engine
// useful. It rides on the existing send queue, which means an auto-reply
// composed while the network is down is retried rather than lost.
//
// Auto-responders are notorious for mail loops and for replying to mailing
// lists, so the suppression rules below are the substance of this file, not an
// afterthought.

const DEFAULT_COOLDOWN_DAYS = 4;

/** Addresses and headers that must never receive an automatic reply. */
const NEVER_REPLY_PATTERNS = [
  /^no-?reply@/i,
  /^do-?not-?reply@/i,
  /^bounce/i,
  /^postmaster@/i,
  /^mailer-daemon@/i,
  /^listserv@/i,
  /^owner-/i,
  /-(request|bounces|errors)@/i,
];

function addressOf(from) {
  const match = String(from || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(from || '')).trim().toLowerCase();
}

function isSuppressedAddress(address) {
  if (!address || !address.includes('@')) return true;
  return NEVER_REPLY_PATTERNS.some(re => re.test(address));
}

/**
 * RFC 3834: automatic responses must not be sent in reply to other automatic
 * responses, and bulk mail must be left alone. The summary we get from a list
 * fetch has no headers, so this is a best-effort check on what we do have.
 */
function looksAutomated(email) {
  const subject = String(email.subject || '');
  if (/^(auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery status|returned mail)/i.test(subject)) {
    return true;
  }
  const headers = email.headers || {};
  const get = (name) => String(headers[name] || headers[name.toLowerCase()] || '');
  if (get('auto-submitted') && !/^no$/i.test(get('auto-submitted'))) return true;
  if (get('x-auto-response-suppress')) return true;
  if (get('precedence') && /bulk|list|junk/i.test(get('precedence'))) return true;
  if (get('list-id') || get('list-unsubscribe')) return true;
  return false;
}

function settings() {
  const raw = store.getVacationSettings() || {};
  return {
    enabled: raw.enabled === true,
    subject: String(raw.subject || 'Out of office').slice(0, 300),
    message: String(raw.message || '').slice(0, 20000),
    startAt: raw.startAt || null,
    endAt: raw.endAt || null,
    accountIds: Array.isArray(raw.accountIds) ? raw.accountIds : [],
    knownContactsOnly: raw.knownContactsOnly === true,
    cooldownDays: Number(raw.cooldownDays) > 0 ? Number(raw.cooldownDays) : DEFAULT_COOLDOWN_DAYS,
  };
}

/** Is the responder switched on and inside its scheduled window right now? */
function isActive(now = Date.now(), config = settings()) {
  if (!config.enabled || !config.message.trim()) return false;
  if (config.startAt && now < Date.parse(config.startAt)) return false;
  if (config.endAt && now > Date.parse(config.endAt)) return false;
  return true;
}

/**
 * Decide whether one arriving message earns an auto-reply.
 * @returns {{ reply: boolean, reason: string }}
 */
function shouldReply(email, account, now = Date.now(), config = settings()) {
  if (!isActive(now, config)) return { reply: false, reason: 'inactive' };
  if (config.accountIds.length && !config.accountIds.includes(account.id)) {
    return { reply: false, reason: 'account not selected' };
  }

  const sender = addressOf(email.from);
  if (isSuppressedAddress(sender)) return { reply: false, reason: 'no-reply sender' };

  // Never answer ourselves: that is the classic infinite loop.
  const own = new Set([String(account.email || '').toLowerCase()]);
  for (const alias of account.aliases || []) own.add(String(alias.email || '').toLowerCase());
  if (own.has(sender)) return { reply: false, reason: 'own address' };

  if (looksAutomated(email)) return { reply: false, reason: 'automated message' };

  if (config.knownContactsOnly && !contacts.isKnown(sender)) {
    return { reply: false, reason: 'not a known contact' };
  }

  const last = store.lastAutoReplyTo(sender);
  if (last && now - Date.parse(last) < config.cooldownDays * 86400000) {
    return { reply: false, reason: 'already replied recently' };
  }

  return { reply: true, reason: 'ok' };
}

/**
 * RFC 3834 §2: only answer mail that names this mailbox directly. A message
 * that reached us through a list, a Bcc, or an alias we don't own does not get
 * a reply — that is how auto-responders end up spamming every list member.
 */
function isDirectlyAddressed(headers, account) {
  const own = new Set([String(account.email || '').toLowerCase()]);
  for (const alias of account.aliases || []) own.add(String(alias.email || '').toLowerCase());
  const recipients = `${headers.to || ''},${headers.cc || ''}`.toLowerCase();
  const addresses = recipients.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) || [];
  return addresses.some(address => own.has(address));
}

function getService(accountType) {
  if (accountType === 'gmail') return require('./gmailService');
  if (accountType === 'outlook') return require('./outlookService');
  return require('./imapService');
}

/**
 * The headers list summaries do not carry. Without them looksAutomated could
 * only judge by subject, and every newsletter or list post from an ordinary
 * address got an out-of-office.
 */
async function fetchPolicyHeaders(email, account) {
  const service = getService(account.type);
  if (!service.getHeaders) return null;
  const { providerId, imapFolder } = require('./emailIds');
  return account.type === 'imap'
    ? service.getHeaders(account, providerId('imap', email.id), imapFolder(email.id, email.folder))
    : service.getHeaders(account, providerId(account.type, email.id));
}

/**
 * Queue auto-replies for any of `emails` that qualify.
 * Called from the new-mail pipeline; resolves rather than throwing into it.
 * @returns {Promise<Array<{ to: string, jobId: string }>>}
 */
async function respondTo(emails, account, { loadHeaders = fetchPolicyHeaders } = {}) {
  const config = settings();
  if (!isActive(Date.now(), config)) return [];

  const { createQueuedSend } = require('./sendQueueService');
  const sent = [];

  for (const email of emails) {
    let verdict;
    try {
      verdict = shouldReply(email, account, Date.now(), config);
    } catch {
      continue;
    }
    if (!verdict.reply) continue;

    // The cheap checks passed; now the ones that need the real headers. When
    // they cannot be read, stay silent — a missed auto-reply is harmless, a
    // reply to a mailing list is not.
    let headers;
    try {
      headers = await loadHeaders(email, account);
    } catch (err) {
      console.warn(`[vacation] Skipping ${email.id}: headers unavailable (${err.message})`);
      continue;
    }
    if (!headers) continue;
    if (looksAutomated({ ...email, headers })) continue;
    if (!isDirectlyAddressed(headers, account)) continue;

    const sender = addressOf(email.from);
    const subject = String(email.subject || '').replace(/^(re|fwd?)\s*:\s*/i, '').trim();

    try {
      const job = createQueuedSend({
        accountId: account.id,
        email: {
          to: sender,
          subject: subject ? `${config.subject}: Re: ${subject}` : config.subject,
          text: config.message,
          // Marks the message as an automatic reply so the other end's own
          // responder stays quiet — the other half of loop prevention.
          autoSubmitted: 'auto-replied',
          inReplyTo: email.messageId || undefined,
        },
        undoWindowSec: 0,
      });
      store.recordAutoReply(sender);
      sent.push({ to: sender, jobId: job.id });
      console.log(`[vacation] Auto-replied to ${sender}`);
    } catch (err) {
      console.warn('[vacation] Could not queue auto-reply:', err.message);
    }
  }

  return sent;
}

module.exports = {
  settings,
  isActive,
  shouldReply,
  respondTo,
  _internals: { addressOf, isSuppressedAddress, looksAutomated, isDirectlyAddressed, DEFAULT_COOLDOWN_DAYS },
};
