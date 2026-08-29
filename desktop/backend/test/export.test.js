const test = require('node:test');
const assert = require('node:assert');
const { Writable } = require('node:stream');
const exportService = require('../services/exportService');

const { escapeFromLines, mboxSeparator, providerId } = exportService._internals;

test('quotes body lines that would otherwise split the message', () => {
  const body = ['Hello,', 'From here on it gets worse.', 'Not from a line start.'].join('\n');
  const escaped = escapeFromLines(body);
  assert.ok(escaped.includes('>From here on'));
  assert.ok(escaped.includes('Not from a line start.'));
});

test('escaping is reversible — existing quotes gain one more', () => {
  assert.equal(escapeFromLines('>From x'), '>>From x');
  assert.equal(escapeFromLines('>>From x'), '>>>From x');
});

test('a From line only counts at the start of a line', () => {
  assert.equal(escapeFromLines('Sent From home'), 'Sent From home');
});

test('the separator carries the sender address and an asctime date', () => {
  const line = mboxSeparator({ from: 'Alice <alice@acme.com>', date: '2026-09-01T09:30:00Z' });
  assert.match(line, /^From alice@acme\.com /);
  assert.match(line, /Tue Sep 01 09:30:00 2026$/);
});

test('a message with no usable sender or date still produces a valid separator', () => {
  const line = mboxSeparator({});
  assert.match(line, /^From unknown@localhost \w{3} \w{3} \d{2} \d{2}:\d{2}:\d{2} \d{4}$/);
  const bad = mboxSeparator({ from: 'nobody', date: 'not-a-date' });
  assert.match(bad, /^From nobody /);
});

test('composite ids resolve back to each provider native id', () => {
  assert.equal(providerId('imap', 'acct-1::4821'), 4821);
  assert.equal(
    providerId('gmail', 'ebff0159-7a8a-4042-9ce9-dc12f898e498-18f2c9a1b'),
    '18f2c9a1b',
  );
});

test('exportFolder streams every message and reports what it skipped', async () => {
  const chunks = [];
  const sink = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
  });

  const account = { id: 'a1', type: 'imap', email: 'me@acme.com' };
  const emails = [
    { id: 'a1::1', from: 'x@y.com', date: '2026-01-01T00:00:00Z' },
    { id: 'a1::2', from: 'x@y.com', date: '2026-01-02T00:00:00Z' },
    { id: 'a1::3', from: 'x@y.com', date: '2026-01-03T00:00:00Z' },
  ];

  const fake = {
    fetchEmails: async () => ({ emails, nextToken: null }),
    // The middle message is unreadable, which must not abort the export.
    getRawMessage: async (_acct, uid) => (uid === 2 ? null : Buffer.from(`Subject: m${uid}\n\nFrom the top\n`)),
  };

  const original = require.cache[require.resolve('../services/imapService')];
  require.cache[require.resolve('../services/imapService')] = { exports: fake };
  try {
    const result = await exportService.exportFolder(account, sink, { folder: 'INBOX' });
    assert.equal(result.exported, 2);
    assert.equal(result.failed, 1);
  } finally {
    if (original) require.cache[require.resolve('../services/imapService')] = original;
    else delete require.cache[require.resolve('../services/imapService')];
  }

  const output = chunks.join('');
  assert.equal((output.match(/^From x@y\.com /gm) || []).length, 2);
  // The body's own "From the top" line must have been quoted.
  assert.ok(output.includes('>From the top'));
});

test('the suggested filename is filesystem-safe', () => {
  const name = exportService.suggestFilename({ email: 'me@acme.com' }, '[Gmail]/All Mail');
  assert.match(name, /^me-acme\.com-Gmail-All-Mail-\d{4}-\d{2}-\d{2}\.mbox$/);
  assert.ok(!/[\\/:*?"<>|]/.test(name));
});
