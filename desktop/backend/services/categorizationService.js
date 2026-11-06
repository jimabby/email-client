// Rule-based email categorization — no AI required, zero cost

const VALID_CATEGORIES = new Set(['Primary', 'Social', 'Jobs', 'Promotions', 'Receipts']);

// Bumped whenever the rules below change in a way that should re-sort mail
// that was already categorised. The route layer drops cached categories saved
// under an older version (see routes/emails.js /categorize).
const RULES_VERSION = 2;

// Sender matching works on the address's domain, never on the raw From text.
// Matching anywhere in "Name <addr>" made "x.com" catch dropbox.com and
// fedex.com, and "lever.co" catch clever.com.
//
// Two shapes of entry:
//   - `domains`: a registrable domain; matches it and any subdomain
//     (x.com, mail.x.com — not dropbox.com).
//   - `brands`:  a whole domain label, any TLD (facebookmail.com, indeed.co.uk,
//     mastodon.social) — never a substring of a longer label.
const SENDERS = {
  jobs: {
    domains: ['seek.com', 'seek.com.au', 'monster.com', 'reed.co.uk', 'greenhouse.io', 'lever.co', 'jora.com', 'careerone.com.au', 'myworkdayjobs.com', 'myworkday.com'],
    brands: ['linkedin', 'indeed', 'indeedemail', 'glassdoor', 'ziprecruiter', 'careerbuilder', 'jobstreet', 'totaljobs', 'workday', 'smartrecruiters', 'recruitly'],
  },
  receipts: {
    domains: ['stripe.com', 'square.com', 'squareup.com', 'zip.co', 'etsy.com', 'uber.com', 'booking.com', 'netflix.com', 'spotify.com', 'apple.com', 'google.com'],
    brands: ['paypal', 'afterpay', 'klarna', 'shopify', 'amazon', 'ebay', 'doordash', 'deliveroo', 'menulog', 'airbnb'],
  },
  social: {
    domains: ['x.com', 'twitter.com', 'threads.net', 'bsky.app'],
    brands: ['facebook', 'facebookmail', 'instagram', 'tiktok', 'discord', 'discordapp', 'youtube', 'reddit', 'redditmail', 'snapchat', 'pinterest', 'whatsapp', 'telegram', 'wechat', 'mastodon', 'bluesky'],
  },
  promotions: {
    domains: [],
    brands: ['mailchimp', 'mcsv', 'mcdlv', 'sendgrid', 'klaviyo', 'klaviyomail', 'braze', 'iterable', 'constantcontact'],
  },
};

const PATTERNS = {
  jobs: {
    // "resume" alone matched "Can we resume our talk?"; it now needs a
    // recruiting context. Bare "recruiter" stays — it rarely means anything else.
    subject: /job alert|job match|new job|job opportunit|job notification|application received|application submitted|application confirm|interview invitation|interview request|your application|recruiter|we.re hiring|open position|job posting|shortlisted|your (resume|cv)\b|(resume|cv) (review|received|submitted|feedback)|talent acquisition|salary negotiation/i,
  },
  receipts: {
    // Only counts together with a known merchant sender. Bare "confirm" made
    // "Confirm your recovery email" from google.com a receipt; it now needs an
    // object that is actually transactional.
    fromSubject: /receipt|invoice|\border\b|payment|transaction|(order|booking|purchase|payment|subscription) (is )?confirm|confirm(ed|ation)? (of )?(your )?(order|booking|purchase|payment)|itinerary|shipped|delivered|tracking|refund|subscription|renewal/i,
    // Strong transactional subject signals — any sender
    subject: /\breceipt\b|tax invoice|payment receipt|payment confirm|purchase confirm|order confirm|booking confirm|transaction confirm|invoice #|order #|order number|your order has|your order of|payment of \$|charged \$|refund of \$|amount due/i,
  },
  social: {
    subject: /friend request|tagged you|mentioned you|new follower|started following|new comment|new reaction|invited you to|group invite/i,
  },
  promotions: {
    // Explicit marketing local parts — NOT generic noreply (too broad).
    local: /^(newsletters?|marketing|deals|offers|promo|promotions|announce|announcements|campaigns?)$/i,
    subject: /\bsale\b|coupon code|\d+%\s*off|buy now|limited.time offer|flash sale|clearance|exclusive offer|early access|free shipping on|members.only|unlock.*deal|today only|ends tonight|last chance|don.t miss/i,
    snippet: /unsubscribe|view in browser|view this email in|manage.*preference|email preference|update.*subscription/i,
  },
};

/** The bare address from "Name <addr>" or "addr", lower-cased. */
function senderAddress(from) {
  const text = String(from || '');
  const angle = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = angle ? angle[1] : (text.match(/[^\s<>"',;]+@[^\s<>"',;]+/) || [''])[0];
  return bare.toLowerCase().replace(/[.>]+$/, '');
}

function senderDomain(from) {
  const address = senderAddress(from);
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}

function domainIn(domain, { domains, brands }) {
  if (!domain) return false;
  if (domains.some(d => domain === d || domain.endsWith(`.${d}`))) return true;
  // Every label but the last (the TLD) is a candidate brand.
  const labels = domain.split('.').slice(0, -1);
  return labels.some(label => brands.includes(label));
}

function categorizeOne(email) {
  const domain  = senderDomain(email.from);
  const local   = senderAddress(email.from).split('@')[0] || '';
  const fromText = String(email.from || '').toLowerCase();
  const subject = String(email.subject || '').toLowerCase();
  const snippet = String(email.snippet || '').toLowerCase();

  // Jobs — checked first: specific job platforms + strong subject signals
  if (domainIn(domain, SENDERS.jobs)) return 'Jobs';
  if (PATTERNS.jobs.subject.test(subject)) return 'Jobs';

  // Receipts — before Promotions to avoid noreply false-positives
  if (domainIn(domain, SENDERS.receipts) && PATTERNS.receipts.fromSubject.test(subject)) return 'Receipts';
  if (PATTERNS.receipts.subject.test(subject)) return 'Receipts';

  // Social
  if (domainIn(domain, SENDERS.social)) return 'Social';
  if (PATTERNS.social.subject.test(subject)) return 'Social';

  // Promotions — last resort for marketing (no generic noreply match)
  if (domainIn(domain, SENDERS.promotions)) return 'Promotions';
  if (PATTERNS.promotions.local.test(local) || /\bnewsletter\b/.test(fromText)) return 'Promotions';
  if (PATTERNS.promotions.subject.test(subject)) return 'Promotions';
  if (PATTERNS.promotions.snippet.test(snippet)) return 'Promotions';

  return 'Primary';
}

/**
 * A category the user chose for this sender, if any. An exact address beats a
 * domain rule, and a domain rule also covers its subdomains.
 * @param {{ senders?: Record<string,string>, domains?: Record<string,string> }} overrides
 */
function overrideFor(from, overrides) {
  if (!overrides) return null;
  const address = senderAddress(from);
  if (address && overrides.senders?.[address]) return overrides.senders[address];
  let domain = senderDomain(from);
  while (domain && domain.includes('.')) {
    if (overrides.domains?.[domain]) return overrides.domains[domain];
    domain = domain.slice(domain.indexOf('.') + 1);
  }
  return null;
}

/**
 * Categorize an array of email summaries.
 * @param {Array<{id, from, subject, snippet}>} emails
 * @param {{ overrides?: object }} [options]
 * @returns {Record<string, string>} map of emailId → category
 */
function categorizeEmails(emails, { overrides } = {}) {
  const result = {};
  for (const email of emails) {
    result[email.id] = overrideFor(email.from, overrides) || categorizeOne(email);
  }
  return result;
}

module.exports = {
  categorizeEmails,
  overrideFor,
  senderAddress,
  senderDomain,
  VALID_CATEGORIES,
  RULES_VERSION,
};
