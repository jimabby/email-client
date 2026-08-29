const store = require('../store');

// Mailbox export to mbox.
//
// A self-hosted mail client that cannot hand your mail back is a trap. mbox is
// the format every other client imports — Thunderbird, Apple Mail, mutt — so
// this doubles as a backup and as an exit route.
//
// The export streams: messages are fetched and written one at a time, so a
// 20,000-message mailbox never has to fit in memory.

function getService(accountType) {
  if (accountType === 'gmail') return require('./gmailService');
  if (accountType === 'outlook') return require('./outlookService');
  return require('./imapService');
}

function providerId(accountType, emailId) {
  if (accountType === 'imap') {
    const parts = String(emailId).split('::');
    return parseInt(parts[parts.length - 1], 10);
  }
  if (emailId.length > 37 && emailId[36] === '-') return emailId.slice(37);
  return emailId.split('-').slice(5).join('-');
}

/**
 * mbox separates messages with a "From " line at the start of a line. Any line
 * in the body that itself begins "From " has to be quoted, or the reader will
 * split the message in two. This is the mboxrd variant: existing ">From " runs
 * get an extra ">" so the escaping is reversible on import.
 */
function escapeFromLines(text) {
  return text.replace(/^(>*From )/gm, '>$1');
}

const MBOX_DATE = { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' };

function mboxSeparator(email) {
  const address = String(email.from || '').match(/<([^>]+)>/)?.[1]
    || String(email.from || '').trim()
    || 'unknown@localhost';
  const date = new Date(email.date || Date.now());
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  // asctime(): "Thu Jan  1 00:00:00 2026"
  const parts = new Intl.DateTimeFormat('en-US', { ...MBOX_DATE, timeZone: 'UTC' }).formatToParts(valid);
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  const time = valid.toISOString().slice(11, 19);
  return `From ${address} ${get('weekday')} ${get('month')} ${get('day')} ${time} ${get('year')}`;
}

/**
 * Stream one folder of one account into `out` as mbox.
 *
 * @param {object} account
 * @param {NodeJS.WritableStream} out
 * @param {{ folder?: string, limit?: number, onProgress?: (n: number) => void }} options
 * @returns {Promise<{ exported: number, failed: number }>}
 */
async function exportFolder(account, out, { folder = 'INBOX', limit = 5000, onProgress } = {}) {
  const service = getService(account.type);
  if (!service.getRawMessage) throw new Error(`Export is not supported for ${account.type} accounts`);

  let exported = 0;
  let failed = 0;
  let pageToken = null;

  const write = (chunk) => new Promise((resolve, reject) => {
    // Respect backpressure: without this a fast provider outruns a slow client
    // and the whole mailbox buffers in memory, which is what streaming is for.
    if (out.write(chunk)) return resolve();
    out.once('drain', resolve);
    out.once('error', reject);
  });

  while (exported + failed < limit) {
    const pageSize = Math.min(100, limit - exported - failed);
    const page = await service.fetchEmails(account, folder, pageSize, pageToken);
    const emails = page?.emails || [];
    if (!emails.length) break;

    for (const email of emails) {
      try {
        const raw = await service.getRawMessage(
          account,
          providerId(account.type, email.id),
          folder,
        );
        if (!raw) { failed++; continue; }

        const body = escapeFromLines(raw.toString('utf8').replace(/\r\n/g, '\n'));
        await write(`${mboxSeparator(email)}\n${body}${body.endsWith('\n') ? '' : '\n'}\n`);
        exported++;
        if (onProgress && exported % 50 === 0) onProgress(exported);
      } catch (err) {
        failed++;
        console.warn(`[export] Skipped ${email.id}: ${err.message}`);
      }
    }

    pageToken = page?.nextToken || null;
    if (!pageToken) break;
  }

  return { exported, failed };
}

/** A filesystem-safe name for the download. */
function suggestFilename(account, folder) {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = (value) => String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe(account.email)}-${safe(folder) || 'mail'}-${stamp}.mbox`;
}

module.exports = {
  exportFolder,
  suggestFilename,
  _internals: { escapeFromLines, mboxSeparator, providerId },
};
