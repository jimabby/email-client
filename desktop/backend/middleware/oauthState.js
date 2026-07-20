const crypto = require('crypto');

const MAX_AGE_MS = 10 * 60 * 1000;

function secret() {
  return process.env.API_TOKEN || process.env.SESSION_SECRET || 'email-client-dev-secret';
}

function signature(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function createOAuthState(provider) {
  const value = `${provider}.${Date.now()}.${crypto.randomBytes(24).toString('base64url')}`;
  return `${value}.${signature(value)}`;
}

function verifyOAuthState(state, provider) {
  if (typeof state !== 'string') return false;
  const parts = state.split('.');
  if (parts.length !== 4 || parts[0] !== provider) return false;

  const timestamp = Number(parts[1]);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > MAX_AGE_MS || timestamp > Date.now() + 30000) {
    return false;
  }

  const value = parts.slice(0, 3).join('.');
  const actual = Buffer.from(parts[3], 'utf8');
  const expected = Buffer.from(signature(value), 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { createOAuthState, verifyOAuthState };
