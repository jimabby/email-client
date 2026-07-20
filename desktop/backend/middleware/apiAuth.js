const crypto = require('crypto');

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual || '', 'utf8');
  const expectedBuffer = Buffer.from(expected || '', 'utf8');
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function apiAuth(req, res, next) {
  const expected = process.env.API_TOKEN;

  // Keep local development compatible. Production startup rejects this state.
  if (!expected) return next();

  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !safeEqual(match[1], expected)) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Invalid or missing API token' });
  }

  return next();
}

module.exports = apiAuth;
