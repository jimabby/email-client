const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-index-'));
process.env.HERMES_SECRET_KEY = 'c'.repeat(64);

const searchIndex = require('../services/searchIndexService');

const ACCOUNT = 'acct-1';

function seed() {
  searchIndex.indexSummaries([
    {
      id: 'e1', accountId: ACCOUNT, folder: 'INBOX',
      from: 'Alice Smith <alice@acme.com>', to: ['me@example.com'],
      subject: 'Q3 invoice attached', date: '2026-08-10T10:00:00Z',
      read: false, starred: true, snippet: 'Please find the invoice',
    },
    {
      id: 'e2', accountId: ACCOUNT, folder: 'INBOX',
      from: 'Bob <bob@other.org>', to: ['me@example.com'],
      subject: 'Lunch tomorrow?', date: '2026-08-12T10:00:00Z',
      read: true, starred: false, snippet: 'Are you free',
    },
    {
      id: 'e3', accountId: 'acct-2', folder: 'Sent',
      from: 'me@example.com', to: ['carol@acme.com'],
      subject: 'Re: Q3 invoice attached', date: '2026-08-11T10:00:00Z',
      read: true, starred: false, snippet: 'Thanks',
    },
  ]);

  searchIndex.indexBody('e1', {
    text: 'The quarterly invoice total is 4200 dollars, due on the fifteenth.',
    attachments: [{ filename: 'invoice-q3.pdf' }],
    subject: 'Q3 invoice attached',
  });
}

test.before(seed);

test('finds a message by a word in its subject', () => {
  const ids = searchIndex.search('invoice').map(d => d.id);
  assert.ok(ids.includes('e1'));
  assert.ok(ids.includes('e3'));
});

test('finds a message by a word only present in the body', () => {
  const ids = searchIndex.search('quarterly').map(d => d.id);
  assert.deepStrictEqual(ids, ['e1']);
});

test('matches a sender by domain or local part, not just the full address', () => {
  assert.ok(searchIndex.search('acme').map(d => d.id).includes('e1'));
  assert.ok(searchIndex.search('alice').map(d => d.id).includes('e1'));
});

test('multiple bare terms are ANDed together', () => {
  assert.deepStrictEqual(searchIndex.search('quarterly invoice').map(d => d.id), ['e1']);
  assert.deepStrictEqual(searchIndex.search('quarterly lunch').map(d => d.id), []);
});

test('quoted phrases must appear contiguously', () => {
  assert.deepStrictEqual(searchIndex.search('"4200 dollars"').map(d => d.id), ['e1']);
  assert.deepStrictEqual(searchIndex.search('"dollars 4200"').map(d => d.id), []);
});

test('from: and subject: operators scope the match to that field', () => {
  assert.deepStrictEqual(searchIndex.search('from:bob').map(d => d.id), ['e2']);
  // "lunch" is in e2's subject, so a from: filter for alice excludes it.
  assert.deepStrictEqual(searchIndex.search('from:alice lunch').map(d => d.id), []);
  assert.ok(searchIndex.search('subject:lunch').map(d => d.id).includes('e2'));
});

test('is:unread, is:starred and has:attachment filter correctly', () => {
  assert.deepStrictEqual(searchIndex.search('is:unread').map(d => d.id), ['e1']);
  assert.deepStrictEqual(searchIndex.search('is:starred').map(d => d.id), ['e1']);
  assert.deepStrictEqual(searchIndex.search('has:attachment').map(d => d.id), ['e1']);
});

test('attachment filenames are searchable', () => {
  assert.ok(searchIndex.search('invoice-q3').map(d => d.id).includes('e1'));
});

test('a prefix finds the full word', () => {
  assert.ok(searchIndex.search('quarter').map(d => d.id).includes('e1'));
});

test('accountId and folder scope the results', () => {
  const scoped = searchIndex.search('invoice', { accountId: ACCOUNT }).map(d => d.id);
  assert.deepStrictEqual(scoped, ['e1']);
  const byFolder = searchIndex.search('invoice', { folder: 'Sent' }).map(d => d.id);
  assert.deepStrictEqual(byFolder, ['e3']);
});

test('a subject hit outranks a body-only hit', () => {
  searchIndex.indexSummaries([{
    id: 'e4', accountId: ACCOUNT, folder: 'INBOX',
    from: 'Dan <dan@x.com>', subject: 'Nothing relevant', date: '2026-08-13T10:00:00Z', read: true,
  }]);
  searchIndex.indexBody('e4', { text: 'the word invoice appears only down here' });

  const ranked = searchIndex.search('invoice', { accountId: ACCOUNT }).map(d => d.id);
  assert.strictEqual(ranked[0], 'e1', 'subject match should rank first');
  assert.ok(ranked.includes('e4'));
});

test('an empty or operator-less query returns nothing rather than everything', () => {
  assert.deepStrictEqual(searchIndex.search(''), []);
  assert.deepStrictEqual(searchIndex.search('   '), []);
});

test('stopwords alone do not match every document', () => {
  assert.deepStrictEqual(searchIndex.search('the'), []);
});

test('setFlags updates what is:unread returns', () => {
  searchIndex.setFlags('e1', { read: true });
  assert.deepStrictEqual(searchIndex.search('is:unread').map(d => d.id), []);
  searchIndex.setFlags('e1', { read: false });
  assert.deepStrictEqual(searchIndex.search('is:unread').map(d => d.id), ['e1']);
});

test('remove drops a document from every posting list', () => {
  searchIndex.indexSummaries([{ id: 'tmp', accountId: ACCOUNT, folder: 'INBOX', from: 'z@z.com', subject: 'zebra crossing', date: '2026-08-01T00:00:00Z' }]);
  assert.ok(searchIndex.search('zebra').length);
  searchIndex.remove('tmp');
  assert.deepStrictEqual(searchIndex.search('zebra'), []);
});

test('removeAccount clears only that account', () => {
  const before = searchIndex.search('invoice').map(d => d.id);
  assert.ok(before.includes('e3'));
  searchIndex.removeAccount('acct-2');
  const after = searchIndex.search('invoice').map(d => d.id);
  assert.ok(!after.includes('e3'));
  assert.ok(after.includes('e1'));
});

test('re-indexing a message updates rather than duplicating it', () => {
  searchIndex.indexSummaries([{ id: 'e2', accountId: ACCOUNT, folder: 'INBOX', from: 'Bob <bob@other.org>', subject: 'Dinner tomorrow?', date: '2026-08-12T10:00:00Z', read: true }]);
  assert.deepStrictEqual(searchIndex.search('dinner').map(d => d.id), ['e2']);
  // The old subject term should no longer match.
  assert.deepStrictEqual(searchIndex.search('subject:lunch').map(d => d.id), []);
});

test('toSummary produces the shape the email list expects', () => {
  const [doc] = searchIndex.search('quarterly');
  const summary = searchIndex.toSummary(doc);
  assert.strictEqual(summary.id, 'e1');
  assert.strictEqual(summary.accountId, ACCOUNT);
  assert.ok(Array.isArray(summary.to));
  assert.strictEqual(summary.fromIndex, true);
});
