const crypto = require('crypto');

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual || '', 'utf8');
  const expectedBuffer = Buffer.from(expected || '', 'utf8');
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

// EventSource cannot set request headers, so SSE endpoints accept the same
// token as a query parameter. Everything else must use the Authorization
// header, which never lands in server logs or the browser history.
const QUERY_TOKEN_PATHS = [/^\/emails\/stream\//];

function extractToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1];
  if (QUERY_TOKEN_PATHS.some(re => re.test(req.path)) && typeof req.query.access_token === 'string') {
    return req.query.access_token;
  }
  return null;
}

function apiAuth(req, res, next) {
  const expected = process.env.API_TOKEN;

  // Keep loopback-only development compatible. server.js refuses to bind a
  // non-loopback interface without a token, so an unauthenticated backend is
  // never reachable from the network.
  if (!expected) return next();

  const token = extractToken(req);
  if (!token || !safeEqual(token, expected)) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Invalid or missing API token' });
  }

  return next();
}

module.exports = apiAuth;
