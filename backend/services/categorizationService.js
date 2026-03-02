// Rule-based email categorization — no AI required, zero cost

const VALID_CATEGORIES = new Set(['Primary', 'Social', 'Jobs', 'Promotions', 'Receipts']);

// Pre-compiled patterns for performance
const PATTERNS = {
  jobs: {
    from: /linkedin|seek\.com|indeed\.|glassdoor|monster\.com|ziprecruiter|careerbuilder|jobstreet|reed\.co\.uk|totaljobs|workday|greenhouse\.io|lever\.co|smartrecruiters|recruitly|jora\.com|careerone\.com/i,
    subject: /job alert|job match|new job|job opportunit|job notification|application received|application submitted|application confirm|interview invitation|interview request|your application|recruiter|we.re hiring|open position|job posting|shortlisted|resume|cv review|talent acquisition|salary negotiation/i,
  },
  receipts: {
    // Known payment/merchant senders — only counts when subject also looks transactional
    fromStrong: /paypal|stripe\.com|square\.com|afterpay|klarna|zip\.co|shopify|amazon\.(com|co\.uk|com\.au)|ebay\.(com|co\.uk|com\.au)|etsy\.com|uber\.com|doordash|deliveroo|menulog|airbnb|booking\.com|netflix\.com|spotify\.com|apple\.com|google\.com/i,
    fromSubject: /receipt|invoice|order|payment|transaction|confirm|booking|itinerary|shipped|delivered|tracking|refund|subscription|renewal/i,
    // Strong transactional subject signals — any sender
    subject: /\breceipt\b|tax invoice|payment receipt|payment confirm|purchase confirm|order confirm|booking confirm|transaction confirm|invoice #|order #|order number|your order has|your order of|payment of \$|charged \$|refund of \$|amount due/i,
  },
  social: {
    from: /facebook|twitter|x\.com|instagram|tiktok|discord|youtube|reddit|snapchat|pinterest|whatsapp|telegram|wechat|mastodon|bluesky|threads/i,
    subject: /friend request|tagged you|mentioned you|new follower|started following|new comment|new reaction|invited you to|group invite/i,
  },
  promotions: {
    // Explicit marketing sender patterns — NOT generic noreply (too broad)
    from: /newsletter|marketing@|deals@|offers@|promo@|promotions@|announce@|campaign@|mailchimp|sendgrid|klaviyo|braze|iterable|constantcontact/i,
    subject: /\bsale\b|coupon code|\d+%\s*off|buy now|limited.time offer|flash sale|clearance|exclusive offer|early access|free shipping on|members.only|unlock.*deal|today only|ends tonight|last chance|don.t miss/i,
    snippet: /unsubscribe|view in browser|view this email in|manage.*preference|email preference|update.*subscription/i,
  },
};

function categorizeOne(email) {
  const from    = (email.from    || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  const snippet = (email.snippet || '').toLowerCase();

  // Jobs — checked first: specific job platforms + strong subject signals
  if (PATTERNS.jobs.from.test(from))    return 'Jobs';
  if (PATTERNS.jobs.subject.test(subject)) return 'Jobs';

  // Receipts — before Promotions to avoid noreply false-positives
  if (PATTERNS.receipts.fromStrong.test(from) && PATTERNS.receipts.fromSubject.test(subject)) return 'Receipts';
  if (PATTERNS.receipts.subject.test(subject)) return 'Receipts';

  // Social
  if (PATTERNS.social.from.test(from))    return 'Social';
  if (PATTERNS.social.subject.test(subject)) return 'Social';

  // Promotions — last resort for marketing (no generic noreply match)
  if (PATTERNS.promotions.from.test(from))    return 'Promotions';
  if (PATTERNS.promotions.subject.test(subject)) return 'Promotions';
  if (PATTERNS.promotions.snippet.test(snippet)) return 'Promotions';

  return 'Primary';
}

/**
 * Categorize an array of email summaries.
 * @param {Array<{id, from, subject, snippet}>} emails
 * @returns {Record<string, string>} map of emailId → category
 */
function categorizeEmails(emails) {
  const result = {};
  for (const email of emails) {
    result[email.id] = categorizeOne(email);
  }
  return result;
}

module.exports = { categorizeEmails, VALID_CATEGORIES };
