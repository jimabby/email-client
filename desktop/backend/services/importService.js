// Mailbox import — the other half of exportService.
//
// Accepts a single RFC 822 message (.eml) or an mbox file, the format every
// mail client exports, and files each message into a folder of the chosen
// account through the provider's own import path (IMAP APPEND, Gmail
// messages.import, Graph message create). Messages keep their original dates.

function getService(accountType) {
  if (accountType === 'gmail') return require('./gmailService');
  if (accountType === 'outlook') return require('./outlookService');
  return require('./imapService');
}

const MAX_MESSAGES = 20000;
const CONCURRENCY = { imap: 1, gmail: 4, outlook: 4 };

/** Does this buffer look like an mbox (starts with a "From " separator line)? */
function isMbox(buffer) {
  const head = buffer.subarray(0, 5).toString('latin1');
  return head === 'From ';
}

/**
 * Split an mbox into its messages.
 *
 * Works on a latin1 view so the bytes survive untouched whatever charset each
 * message uses. A separator is a "From " line at the start of the file or
 * after a blank line; quoted ">From " lines (mboxrd/mboxo) lose one ">".
 */
function splitMbox(buffer) {
  const text = buffer.toString('latin1').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const messages = [];
  let current = null;
  let previousBlank = true;

  for (const line of lines) {
    if (line.startsWith('From ') && previousBlank) {
      if (current) messages.push(current);
      current = [];
      previousBlank = false;
      continue;
    }
    if (current) current.push(/^>+From /.test(line) ? line.slice(1) : line);
    previousBlank = line === '';
  }
  if (current) messages.push(current);

  return messages
    .map(msgLines => {
      // Drop the blank line that separates this message from the next.
      while (msgLines.length && msgLines[msgLines.length - 1] === '') msgLines.pop();
      return Buffer.from(msgLines.join('\r\n') + '\r\n', 'latin1');
    })
    .filter(raw => raw.length > 2);
}

/** Every message in an uploaded file, whether mbox or a single .eml. */
function parseUpload(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return [];
  if (isMbox(buffer)) return splitMbox(buffer);
  return [Buffer.from(buffer.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1')];
}

/**
 * Import every message in `buffer` into `folder` of `account`.
 * @returns {Promise<{ total: number, imported: number, failed: number, skipped: number, errors: string[] }>}
 */
async function importInto(account, buffer, folder = 'INBOX') {
  const service = getService(account.type);
  if (!service.importMessage) throw new Error('Import is not supported for this account');

  const all = parseUpload(buffer);
  const messages = all.slice(0, MAX_MESSAGES);
  const result = { total: all.length, imported: 0, failed: 0, skipped: all.length - messages.length, errors: [] };

  let cursor = 0;
  const worker = async () => {
    while (cursor < messages.length) {
      const raw = messages[cursor++];
      try {
        await service.importMessage(account, raw, folder);
        result.imported++;
      } catch (err) {
        result.failed++;
        if (result.errors.length < 5) result.errors.push(String(err?.message || err));
      }
    }
  };
  const lanes = Math.min(CONCURRENCY[account.type] || 2, messages.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  return result;
}

module.exports = { importInto, parseUpload, _internals: { isMbox, splitMbox, MAX_MESSAGES } };
