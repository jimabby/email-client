const store = require('../store');

// Tracks accounts whose credentials the provider has stopped accepting.
//
// A revoked Google refresh token, an expired Microsoft grant, or a changed
// IMAP password used to surface as an endless stream of failed fetches and a
// mailbox that silently stopped updating. Recording it on the account lets the
// client show a "Reconnect" prompt instead.

/** Does this error mean "sign in again", as opposed to a transient failure? */
function isAuthError(err) {
  if (!err) return false;
  const message = String(err.message || err);
  const data = err.response?.data;
  // Google: the refresh token was revoked or has expired.
  if (data?.error === 'invalid_grant' || /invalid_grant/i.test(message)) return true;
  if (/Token has been expired or revoked/i.test(message)) return true;
  // MSAL: the cached grant can no longer be redeemed silently.
  if (/interaction_required|invalid_grant|AADSTS(50173|70008|700082|50076|65001)/i.test(message)) return true;
  // Graph after a refresh attempt (graphRequestWithRefresh already retried).
  if (err.status === 401 || /^Graph API error: 401\b/.test(message)) return true;
  // IMAP / SMTP.
  if (err.authenticationFailed === true) return true;
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|Invalid login|\b535\b/i.test(message)) return true;
  return false;
}

/** Record an auth failure on the account if `err` is one. Returns true if so. */
function noteFailure(accountId, err) {
  if (!isAuthError(err)) return false;
  const account = store.getAccount(accountId);
  if (!account) return false;
  const message = String(err.message || err).slice(0, 300);
  if (account.authError?.message !== message) {
    store.updateAccount(accountId, { authError: { message, at: new Date().toISOString() } });
  }
  return true;
}

/** Clear a recorded auth failure after a call that worked. */
function noteSuccess(accountId) {
  const account = store.getAccount(accountId);
  if (account?.authError) store.updateAccount(accountId, { authError: null });
}

module.exports = { isAuthError, noteFailure, noteSuccess };
