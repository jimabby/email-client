// Composite email ids, parsed in one place.
//
//   Gmail/Outlook: "{accountUuid}-{providerMessageId}"
//   IMAP:          "{accountUuid}::{folder}::{uid}"
//   IMAP (legacy): "{accountUuid}::{uid}" — before the folder was part of the id
//
// The routes, the rule engine, and the exporter each used to carry their own
// copy of these helpers, which is how they drift apart.

/** The provider's own message id from a Gmail/Outlook composite id. */
function gmailOrOutlookId(emailId) {
  const id = String(emailId);
  // UUID v4 is always 36 characters long. The provider message ID starts at index 37.
  if (id.length > 37 && id[36] === '-') return id.slice(37);
  // Fallback: split on '-' and skip the 5 UUID segments
  return id.split('-').slice(5).join('-');
}

function imapUid(emailId) {
  const parts = String(emailId).split('::');
  return parseInt(parts[parts.length - 1], 10);
}

/**
 * The mailbox an IMAP id lives in, or `fallback` for a legacy id that did not
 * record it. A UID is meaningless without its mailbox, so whenever the id
 * carries one it beats whatever folder the caller passed alongside.
 */
function imapFolder(emailId, fallback = 'INBOX') {
  const parts = String(emailId).split('::');
  if (parts.length >= 3) return parts.slice(1, -1).join('::');
  return fallback || 'INBOX';
}

/** Provider-side id for any account type. */
function providerId(accountType, emailId) {
  return accountType === 'imap' ? imapUid(emailId) : gmailOrOutlookId(emailId);
}

module.exports = { gmailOrOutlookId, imapUid, imapFolder, providerId };
