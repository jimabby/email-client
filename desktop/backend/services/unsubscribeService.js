const dns = require('dns').promises;
const net = require('net');

// One-click unsubscribe (RFC 2369 List-Unsubscribe + RFC 8058).
//
// When the sender advertises "List-Unsubscribe-Post: List-Unsubscribe=One-Click"
// with an https URL, unsubscribing is a single POST the server can make itself
// — no browser, no landing page, no tracking. Otherwise a mailto: target gets
// an email, and anything else is handed back for the user to open.
//
// The URL comes from the sender, and the server fetches it. On the cloud
// deploy that is a request from inside the host's network on a stranger's
// say-so, so only public https destinations are ever contacted.

/** Every URI in a List-Unsubscribe header, in order. */
function parseListUnsubscribe(header) {
  return Array.from(String(header || '').matchAll(/<([^>]+)>/g)).map(m => m[1].trim()).filter(Boolean);
}

function isOneClick(postHeader) {
  return /List-Unsubscribe\s*=\s*One-Click/i.test(String(postHeader || ''));
}

/** Loopback, private, link-local, CGNAT, multicast, and reserved ranges. */
function isPrivateAddress(address) {
  const ip = String(address || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(lower);
  }
  return true;
}

/** Throws unless `url` is https on a host that resolves only to public IPs. */
async function assertPublicHttps(url, { lookup = dns.lookup } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid unsubscribe URL'); }
  if (parsed.protocol !== 'https:') throw new Error('One-click unsubscribe requires https');
  if (parsed.username || parsed.password) throw new Error('Unsubscribe URL must not carry credentials');
  const host = parsed.hostname;
  if (/^localhost$/i.test(host) || /\.(local|internal|localhost)$/i.test(host)) {
    throw new Error('Unsubscribe URL points at a private host');
  }
  const addresses = net.isIP(host.replace(/^\[|\]$/g, ''))
    ? [{ address: host }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) {
    throw new Error('Unsubscribe URL points at a private address');
  }
  return parsed;
}

/** Parse "mailto:list@x.com?subject=unsubscribe&body=..." */
function parseMailto(uri) {
  const match = String(uri).match(/^mailto:([^?]+)(?:\?(.*))?$/i);
  if (!match) return null;
  const params = new URLSearchParams(match[2] || '');
  const to = decodeURIComponent(match[1]).trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(to)) return null;
  return {
    to,
    subject: params.get('subject') || 'unsubscribe',
    text: params.get('body') || 'unsubscribe',
  };
}

/**
 * Decide how to unsubscribe from a message and, where possible, do it.
 *
 * @param {{ listUnsubscribe?: string, listUnsubscribePost?: string }} headers
 * @param {{ sendMail: (mail: {to,subject,text}) => any, fetchImpl?: typeof fetch, lookup?: Function }} deps
 * @returns {Promise<{ method: 'one-click'|'mailto'|'browser'|'none', url?: string, to?: string }>}
 */
async function unsubscribe(headers, { sendMail, fetchImpl = fetch, lookup } = {}) {
  const uris = parseListUnsubscribe(headers.listUnsubscribe);
  const https = uris.find(u => /^https:/i.test(u));
  const mailto = uris.find(u => /^mailto:/i.test(u));

  if (https && isOneClick(headers.listUnsubscribePost)) {
    const target = await assertPublicHttps(https, { lookup });
    const res = await fetchImpl(target.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      // A redirect could land on a private address the check above never saw.
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 200 && res.status < 400) return { method: 'one-click', url: target.toString() };
    // A refused POST still leaves the page route available.
    return { method: 'browser', url: target.toString() };
  }

  if (mailto) {
    const mail = parseMailto(mailto);
    if (mail) {
      await sendMail(mail);
      return { method: 'mailto', to: mail.to };
    }
  }

  const page = uris.find(u => /^https?:/i.test(u));
  if (page) return { method: 'browser', url: page };
  return { method: 'none' };
}

module.exports = {
  unsubscribe,
  _internals: { parseListUnsubscribe, isOneClick, isPrivateAddress, assertPublicHttps, parseMailto },
};
