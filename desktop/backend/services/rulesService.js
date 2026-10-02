const { randomUUID: uuidv4 } = require('crypto');
const store = require('../store');

// Rule engine.
//
// A rule is: match ALL or ANY of N conditions, then run N actions.
// Rules run server-side when new mail arrives, so they apply whether or not a
// client happens to be open — and each message is processed at most once, so
// re-listing a folder can never re-run a destructive action.

// `fromAddress` is the bare sender address, so "equals" can match exactly —
// `from` is the whole header, display name included.
const FIELDS = new Set(['from', 'fromAddress', 'to', 'subject', 'snippet', 'hasAttachment']);
const OPS = new Set(['contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'matches', 'isTrue']);
const ACTIONS = new Set(['move', 'archive', 'markRead', 'markUnread', 'star', 'spam', 'delete']);

function getService(accountType) {
  if (accountType === 'gmail') return require('./gmailService');
  if (accountType === 'outlook') return require('./outlookService');
  return require('./imapService');
}

const { providerId: toProviderId, imapFolder } = require('./emailIds');

// ─── Validation ─────────────────────────────────────────────────────────────

// Every operator except `isTrue` compares against a value. A condition with an
// empty one is not a filter, it is a wildcard — and `contains ''` matched every
// message ever received. Paired with `match: 'any'` and a delete or spam
// action, one blank field in the rule editor emptied the mailbox. Blank
// conditions are dropped here rather than in the UI, because the API is
// reachable without it.
const VALUELESS_OPS = new Set(['isTrue']);

function sanitizeRule(raw) {
  const conditions = (Array.isArray(raw.conditions) ? raw.conditions : [])
    .filter(c => FIELDS.has(c?.field) && OPS.has(c?.op))
    .map(c => ({
      field: c.field,
      op: c.op,
      value: String(c.value ?? '').slice(0, 300),
      caseSensitive: c.caseSensitive === true,
    }))
    .filter(c => VALUELESS_OPS.has(c.op) || c.value.trim() !== '')
    .slice(0, 10);

  const actions = (Array.isArray(raw.actions) ? raw.actions : [])
    .filter(a => ACTIONS.has(a?.type))
    .slice(0, 5)
    .map(a => ({ type: a.type, targetFolder: String(a.targetFolder || '').slice(0, 300) }));

  return {
    id: raw.id || uuidv4(),
    name: String(raw.name || 'Rule').slice(0, 80),
    enabled: raw.enabled !== false,
    accountId: raw.accountId || undefined,
    match: raw.match === 'any' ? 'any' : 'all',
    conditions,
    actions: actions.length ? actions : [{ type: 'markRead', targetFolder: '' }],
    stopProcessing: raw.stopProcessing === true,
  };
}

function sanitizeRules(list) {
  return (Array.isArray(list) ? list : []).slice(0, 100).map(sanitizeRule);
}

// ─── Matching ───────────────────────────────────────────────────────────────

function senderAddress(from) {
  const value = String(from || '');
  return (value.match(/<([^>]+)>/)?.[1] || value).trim();
}

function fieldValue(email, field) {
  switch (field) {
    case 'from': return String(email.from || '');
    case 'fromAddress': return senderAddress(email.from);
    case 'to': return Array.isArray(email.to) ? email.to.join(', ') : String(email.to || '');
    case 'subject': return String(email.subject || '');
    case 'snippet': return String(email.snippet || '');
    case 'hasAttachment': return email.hasAttachments ? 'true' : '';
    default: return '';
  }
}

function conditionMatches(email, condition) {
  const rawHaystack = fieldValue(email, condition.field);
  const haystack = condition.caseSensitive ? rawHaystack : rawHaystack.toLowerCase();
  const needle = condition.caseSensitive ? condition.value : condition.value.toLowerCase();

  // sanitizeRule drops empty values, but ruleMatches is also called on
  // unsanitized input from previewRule, and a stored rule predates that filter.
  // An empty needle matches nothing rather than everything — the safe reading.
  if (!VALUELESS_OPS.has(condition.op) && !needle) return false;

  switch (condition.op) {
    case 'contains': return haystack.includes(needle);
    case 'notContains': return !haystack.includes(needle);
    case 'equals': return haystack.trim() === needle.trim();
    case 'startsWith': return haystack.startsWith(needle);
    case 'endsWith': return haystack.endsWith(needle);
    case 'isTrue': return !!rawHaystack;
    case 'matches':
      try {
        // User-supplied patterns are capped in length and run against short
        // header strings, which keeps catastrophic backtracking bounded.
        return new RegExp(condition.value.slice(0, 200), condition.caseSensitive ? '' : 'i').test(rawHaystack);
      } catch {
        return false;
      }
    default: return false;
  }
}

function ruleMatches(email, rule) {
  if (rule.enabled === false) return false;
  if (rule.accountId && rule.accountId !== email.accountId) return false;
  if (!rule.conditions.length) return false;
  return rule.match === 'any'
    ? rule.conditions.some(c => conditionMatches(email, c))
    : rule.conditions.every(c => conditionMatches(email, c));
}

// ─── Execution ──────────────────────────────────────────────────────────────

async function runAction(account, email, action, archiveFolder) {
  const service = getService(account.type);
  const providerId = toProviderId(account.type, email.id);
  const folder = account.type === 'imap' ? imapFolder(email.id, email.folder) : (email.folder || 'INBOX');

  switch (action.type) {
    case 'markRead':
      return service.markAsRead(account, providerId, folder);
    case 'markUnread':
      return service.markAsUnread(account, providerId, folder);
    case 'star':
      return account.type === 'imap'
        ? service.toggleStar(account, providerId, folder, true)
        : service.toggleStar(account, providerId, true);
    case 'spam':
      return service.reportSpam(account, providerId, folder);
    case 'delete':
      return service.deleteEmail(account, providerId, folder);
    case 'archive':
    case 'move': {
      const target = action.type === 'archive' ? (archiveFolder || 'Archive') : action.targetFolder;
      if (!target) throw new Error('Move rule has no target folder');
      if (account.type === 'outlook') return service.moveEmail(account, providerId, target);
      return service.moveEmail(account, providerId, folder, target);
    }
    default:
      throw new Error(`Unknown rule action: ${action.type}`);
  }
}

// Actions that take the message out of the current folder — nothing after one
// of these can address the message any more.
const TERMINAL_ACTIONS = new Set(['move', 'archive', 'spam', 'delete']);

/**
 * Apply the stored rules to a batch of email summaries.
 * @param {Array} emails
 * @param {{ force?: boolean, archiveFolders?: Record<string,string> }} options
 *        force — re-run even for messages already processed (manual "Run rules now").
 */
async function applyRules(emails, { force = false, archiveFolders = {} } = {}) {
  const rules = store.getRules().filter(r => r.enabled !== false);
  if (!rules.length) return { applied: [], processed: 0 };

  const applied = [];
  let processed = 0;

  for (const email of emails) {
    if (!email?.id) continue;
    if (!force && store.hasRuleRun(email.id)) continue;

    const account = store.getAccount(email.accountId);
    if (!account) continue;

    const matching = rules.filter(rule => ruleMatches(email, rule));
    // Mark before acting: a rule that half-fails must not be retried forever
    // on the same message, and a delete can't be undone by a retry anyway.
    store.markRuleRun(email.id);
    processed++;
    if (!matching.length) continue;

    let removed = false;
    for (const rule of matching) {
      if (removed) break;
      for (const action of rule.actions) {
        try {
          await runAction(account, email, action, archiveFolders[account.id]);
          applied.push({ emailId: email.id, ruleId: rule.id, action: action.type });
          if (TERMINAL_ACTIONS.has(action.type)) { removed = true; break; }
        } catch (err) {
          console.warn(`[rules] ${rule.name} / ${action.type} failed on ${email.id}: ${err.message}`);
        }
      }
      if (rule.stopProcessing) break;
    }
  }

  return { applied, processed };
}

/** Test a rule against a batch of emails without performing any action. */
function previewRule(rule, emails) {
  const sanitized = sanitizeRule(rule);
  return (emails || []).filter(email => ruleMatches(email, sanitized)).map(e => e.id);
}

module.exports = {
  sanitizeRule,
  sanitizeRules,
  ruleMatches,
  applyRules,
  runAction,
  previewRule,
  senderAddress,
  TERMINAL_ACTIONS,
  FIELDS: Array.from(FIELDS),
  OPS: Array.from(OPS),
  ACTIONS: Array.from(ACTIONS),
};
