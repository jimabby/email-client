// What a device token may do.
//
// The master API token can do everything. A device token carries a scope,
// chosen when it is created, so a lost phone does not have to mean a lost
// installation:
//
//   full  Everything except managing other devices. Tokens created before
//         scopes existed have no scope field and stay here, unchanged.
//   mail  Read, send, and organise mail. Cannot add, change, or remove
//         accounts, change the AI provider or its key, restore a settings
//         backup, or move whole mailboxes in or out.
//   read  Read mail and use the reading aids (search, summaries, smart
//         replies). Changes nothing.
//
// Paths are relative to /api, as the auth middleware in server.js sees them.

const SCOPES = ['full', 'mail', 'read'];

// [method ('*' for any), path pattern]
const ADMIN_ONLY = [
  ['*', /^\/auth\/devices(\/|$)/],
  ['POST', /^\/auth\/accounts(\/|$)/],
  ['PATCH', /^\/auth\/accounts\//],
  ['DELETE', /^\/auth\/accounts\//],
  // Starting an OAuth sign-in adds an account.
  ['GET', /^\/auth\/(gmail|outlook)$/],
  ['POST', /^\/ai\/settings$/],
  ['DELETE', /^\/ai\/settings$/],
  ['PUT', /^\/ai\/(model|privacy)$/],
  ['POST', /^\/emails\/settings-import$/],
  ['GET', /^\/emails\/export$/],
  ['POST', /^\/emails\/export-ticket$/],
  ['POST', /^\/emails\/[^/]+\/import$/],
  ['POST', /^\/emails\/trigger-report$/],
  // Private keys: making, importing, exporting, or deleting one.
  ['POST', /^\/pgp\/identities(\/|$)/],
  ['DELETE', /^\/pgp\/identities\//],
];

// Requests a read-only device may make although they are not GETs: they
// compute something, or register this device for push, without changing mail.
const READ_WRITES = [
  ['POST', /^\/emails\/categorize$/],
  ['POST', /^\/pgp\/readiness$/],
  // The passphrase is the authority; nothing stored changes.
  ['POST', /^\/pgp\/(unlock|lock)$/],
  ['POST', /^\/emails\/rules\/preview$/],
  ['POST', /^\/emails\/[^/]+\/message\/[^/]+\/attachment\/[^/]+\/ticket$/],
  ['POST', /^\/emails\/devices$/],
  ['DELETE', /^\/emails\/devices$/],
  ['POST', /^\/ai\/(smart-replies|thread-summary|priority|extract-actions|summarize-attachment|chat)$/],
];

const matches = (list, method, path) => list.some(([m, re]) => (m === '*' || m === method) && re.test(path));

function normalizeScope(scope) {
  return SCOPES.includes(scope) ? scope : 'full';
}

/** @returns null when allowed, else the reason it is not. */
function denialFor(scope, method, path) {
  const effective = normalizeScope(scope);
  const verb = String(method || 'GET').toUpperCase();
  if (effective === 'full') return null;
  if (matches(ADMIN_ONLY, verb, path)) return `This device's ${effective} access cannot change accounts, AI keys, encryption keys, backups, or whole-mailbox import and export. Use the master token.`;
  if (effective === 'read' && !['GET', 'HEAD', 'OPTIONS'].includes(verb) && !matches(READ_WRITES, verb, path)) {
    return 'This device has read-only access.';
  }
  return null;
}

/** Express middleware; runs after apiAuth has set req.auth. */
function deviceScope(req, res, next) {
  if (!req.auth?.deviceId) return next();
  const reason = denialFor(req.auth.scope, req.method, req.path);
  if (reason) return res.status(403).json({ error: reason, scope: normalizeScope(req.auth.scope) });
  return next();
}

module.exports = { deviceScope, denialFor, normalizeScope, SCOPES };
