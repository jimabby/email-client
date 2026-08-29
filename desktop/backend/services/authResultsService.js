// Sender authentication (SPF / DKIM / DMARC).
//
// The receiving provider has already done this work and recorded the outcome in
// the Authentication-Results header. Surfacing it costs one header read and is
// the strongest phishing signal a mail client can show: a message claiming to be
// from a bank that fails DMARC is worth a warning, and one that passes all three
// is worth the absence of one.
//
// Reading the provider's verdict is the only sound option here — verifying DKIM
// ourselves would mean re-fetching raw sources and a DNS resolver, and the
// provider's result is authoritative for mail it accepted.

const MECHANISMS = ['spf', 'dkim', 'dmarc', 'compauth'];

/**
 * Parse an Authentication-Results header value.
 * Example: "mx.google.com; dkim=pass header.i=@acme.com; spf=pass ...; dmarc=pass ..."
 */
function parseAuthResults(headerValue) {
  const text = String(headerValue || '');
  if (!text.trim()) return null;

  const results = {};
  for (const mechanism of MECHANISMS) {
    // `dkim=pass`, `spf=softfail`, `dmarc=fail (p=REJECT)`
    const match = text.match(new RegExp(`\\b${mechanism}\\s*=\\s*([a-z]+)`, 'i'));
    if (match) results[mechanism] = match[1].toLowerCase();
  }
  if (!Object.keys(results).length) return null;

  // The domain the signature actually authenticated, which is what matters when
  // it disagrees with the visible From.
  const dkimDomain = text.match(/header\.(?:i|d)\s*=\s*@?([A-Za-z0-9.-]+)/i)?.[1] || null;
  const spfDomain = text.match(/smtp\.mailfrom\s*=\s*(?:[^@\s]+@)?([A-Za-z0-9.-]+)/i)?.[1] || null;

  return { ...results, dkimDomain, spfDomain };
}

function domainOf(address) {
  const match = String(address || '').match(/@([A-Za-z0-9.-]+)/);
  return match ? match[1].toLowerCase().replace(/[>,;\s]+$/, '') : null;
}

/** Does `candidate` equal `base` or sit under it? (mail.acme.com vs acme.com) */
function domainMatches(candidate, base) {
  if (!candidate || !base) return false;
  const a = candidate.toLowerCase();
  const b = base.toLowerCase();
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Reduce the mechanism results to one verdict the UI can render.
 *
 * @returns {{ status: 'pass'|'partial'|'fail'|'unknown', label, detail, spf, dkim, dmarc, alignedDomain }}
 */
function summarize(headerValue, fromHeader) {
  const parsed = parseAuthResults(headerValue);
  if (!parsed) {
    return {
      status: 'unknown',
      label: 'Not verified',
      detail: 'This message carries no sender-authentication results.',
      spf: null, dkim: null, dmarc: null, alignedDomain: null,
    };
  }

  const { spf = null, dkim = null, dmarc = null } = parsed;
  const fromDomain = domainOf(fromHeader);
  // A DKIM pass only means something if it authenticated the domain the message
  // claims to be from — this is exactly the gap phishing exploits.
  const aligned = domainMatches(parsed.dkimDomain, fromDomain)
    || domainMatches(parsed.spfDomain, fromDomain);

  const failed = [spf, dkim, dmarc].filter(v => v === 'fail' || v === 'softfail');
  const passed = [spf, dkim, dmarc].filter(v => v === 'pass');

  if (dmarc === 'fail' || (dkim === 'fail' && spf === 'fail')) {
    return {
      status: 'fail',
      label: 'Failed authentication',
      detail: `This message claims to be from ${fromDomain || 'its sender'} but did not pass that domain's checks. Treat links and attachments as untrusted.`,
      spf, dkim, dmarc, alignedDomain: parsed.dkimDomain || parsed.spfDomain,
    };
  }

  if (dmarc === 'pass' || (passed.length >= 2 && !failed.length)) {
    return {
      status: aligned || dmarc === 'pass' ? 'pass' : 'partial',
      label: aligned || dmarc === 'pass' ? 'Verified sender' : 'Signed by another domain',
      detail: aligned || dmarc === 'pass'
        ? `Confirmed as genuinely sent from ${fromDomain || 'the stated domain'}.`
        : `Authenticated, but signed by ${parsed.dkimDomain || parsed.spfDomain} rather than ${fromDomain}.`,
      spf, dkim, dmarc, alignedDomain: parsed.dkimDomain || parsed.spfDomain,
    };
  }

  if (failed.length) {
    return {
      status: 'partial',
      label: 'Partly verified',
      detail: `Some sender checks did not pass${failed.includes('softfail') ? ' (soft failure)' : ''}. Be cautious with links and attachments.`,
      spf, dkim, dmarc, alignedDomain: parsed.dkimDomain || parsed.spfDomain,
    };
  }

  return {
    status: 'unknown',
    label: 'Not verified',
    detail: 'Sender authentication was inconclusive for this message.',
    spf, dkim, dmarc, alignedDomain: parsed.dkimDomain || parsed.spfDomain,
  };
}

module.exports = { parseAuthResults, summarize, _internals: { domainOf, domainMatches } };
