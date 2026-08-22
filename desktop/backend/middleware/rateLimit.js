const rateLimit = require('express-rate-limit');

/**
 * Request limits.
 *
 * The desktop app talks to a loopback backend and would trip any sane limit
 * during a normal sync, so loopback callers are exempt throughout. What these
 * protect is the public deployment: the webhook endpoints are unauthenticated
 * by necessity (a provider cannot send the Hermes token), and each call makes
 * the server go and poll a mailbox. The AI routes are metered because every
 * request spends money at a third party.
 */

function isLoopback(req) {
  const addr = req.socket?.remoteAddress || '';
  if (addr === '::1') return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function make({ windowMs, limit, name }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // A single-user server behind a reverse proxy sees one client address for
    // everyone, so keying on IP is the only signal available — and it is the
    // right one for the abuse this guards against.
    skip: isLoopback,
    message: { error: `Too many ${name} requests — slow down and try again shortly.` },
  });
}

// Broad backstop for the authenticated API. Generous: a client opening a large
// folder legitimately fires a burst of body and attachment fetches.
const apiLimiter = make({ windowMs: 60_000, limit: 600, name: 'API' });

// Unauthenticated, and each one costs a provider poll.
const webhookLimiter = make({ windowMs: 60_000, limit: 60, name: 'webhook' });

// Every call here spends money with Anthropic/OpenAI/Google.
const aiLimiter = make({ windowMs: 60_000, limit: 40, name: 'AI' });

// Sending is the one action with real-world side effects that cannot be undone
// once the window closes.
const sendLimiter = make({ windowMs: 60_000, limit: 30, name: 'send' });

module.exports = { apiLimiter, webhookLimiter, aiLimiter, sendLimiter, isLoopback };
