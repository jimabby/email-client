const crypto = require('crypto');

// Single-use download tickets.
//
// The mobile app hands attachment URLs to the OS viewer, which means the URL
// leaves the app. It used to carry `access_token=<API_TOKEN>` — the master
// credential for every mailbox — straight into the system browser's history,
// which is frequently synced across a user's devices.
//
// A ticket is scoped to one attachment, expires in two minutes, and works once.
// If it does end up in a history file it is worthless by the time anyone reads
// it, and it could never have been used for anything but that one file.

const TTL_MS = 2 * 60 * 1000;
const MAX_OUTSTANDING = 500;

/** @type {Map<string, {accountId, emailId, index, folder, expiresAt, used}>} */
const tickets = new Map();

function sweep(now = Date.now()) {
  for (const [token, ticket] of tickets) {
    if (ticket.used || ticket.expiresAt <= now) tickets.delete(token);
  }
  // A flood of unredeemed tickets must not grow without bound.
  while (tickets.size > MAX_OUTSTANDING) {
    tickets.delete(tickets.keys().next().value);
  }
}

function issue({ accountId, emailId, index, folder }) {
  const token = crypto.randomBytes(32).toString('base64url');
  tickets.set(token, {
    accountId,
    emailId,
    index,
    folder: folder || 'INBOX',
    expiresAt: Date.now() + TTL_MS,
    used: false,
  });
  // Sweep after inserting, not before: trimming first left the map one over
  // the cap on every call, so the bound was never actually MAX_OUTSTANDING.
  sweep();
  return { token, expiresIn: Math.floor(TTL_MS / 1000) };
}

/**
 * Redeem a ticket. Returns its target, or null if it is unknown, expired, or
 * already spent — the three are deliberately indistinguishable to the caller.
 */
function redeem(token) {
  if (typeof token !== 'string' || !token) return null;
  const ticket = tickets.get(token);
  if (!ticket) return null;

  // Burn it before doing any work, so a retry or a double-fetch cannot reuse it.
  tickets.delete(token);
  if (ticket.used || ticket.expiresAt <= Date.now()) return null;

  return {
    accountId: ticket.accountId,
    emailId: ticket.emailId,
    index: ticket.index,
    folder: ticket.folder,
  };
}

module.exports = { issue, redeem, _internals: { tickets, sweep, TTL_MS } };
