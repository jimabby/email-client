// DNS-rebinding defence.
//
// A page on attacker.example can re-point its own hostname at 127.0.0.1. The
// browser then treats requests to http://attacker.example:3001 as same-origin:
// no Origin header on a GET, so CORS never engages, and the response is
// readable. The socket still comes from this machine, so the token bootstrap
// in server.js — which trusts loopback callers — would hand the API token to
// that page.
//
// The one thing the attacker cannot choose is the Host header: it carries
// their hostname. A server that only answers to loopback names is immune.

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The hostname from a Host header, without the port. */
function hostnameOf(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.replace(/:\d+$/, '');
}

function isLoopbackHost(hostHeader) {
  const name = hostnameOf(hostHeader);
  return LOOPBACK_NAMES.has(name) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * Express middleware for a loopback-bound server: refuse any request whose
 * Host is not a loopback name. `extraHosts` allows named aliases (e.g. a LAN
 * hostname) when the operator binds wider on purpose.
 */
function hostGuard({ extraHosts = [] } = {}) {
  const allowed = new Set(extraHosts.map(h => hostnameOf(h)).filter(Boolean));
  return (req, res, next) => {
    const host = req.headers.host;
    if (isLoopbackHost(host) || allowed.has(hostnameOf(host))) return next();
    res.status(421).json({ error: 'Misdirected request' });
  };
}

module.exports = { hostGuard, isLoopbackHost, hostnameOf };
