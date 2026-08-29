const test = require('node:test');
const assert = require('node:assert');
const vacation = require('../services/vacationService');

const { addressOf, isSuppressedAddress, looksAutomated } = vacation._internals;

const ACCOUNT = { id: 'acct-1', email: 'me@acme.com', aliases: [{ email: 'sales@acme.com' }] };

const ACTIVE = {
  enabled: true,
  subject: 'Out of office',
  message: 'Back on Monday.',
  startAt: null,
  endAt: null,
  accountIds: [],
  knownContactsOnly: false,
  cooldownDays: 4,
};

test('extracts the bare address from a display-name header', () => {
  assert.equal(addressOf('Alice Smith <alice@acme.com>'), 'alice@acme.com');
  assert.equal(addressOf('bob@acme.com'), 'bob@acme.com');
  assert.equal(addressOf(''), '');
});

test('never auto-replies to no-reply style senders', () => {
  for (const address of [
    'noreply@acme.com', 'no-reply@acme.com', 'donotreply@acme.com',
    'bounces@lists.acme.com', 'postmaster@acme.com', 'mailer-daemon@acme.com',
    'listserv@acme.com', 'owner-list@acme.com', 'team-request@acme.com',
  ]) {
    assert.ok(isSuppressedAddress(address), `${address} should be suppressed`);
  }
  assert.ok(!isSuppressedAddress('alice@acme.com'));
});

test('a value that is not an address at all is suppressed', () => {
  assert.ok(isSuppressedAddress(''));
  assert.ok(isSuppressedAddress('Unknown'));
});

test('recognises automated mail from its subject or headers', () => {
  assert.ok(looksAutomated({ subject: 'Out of office: your message' }));
  assert.ok(looksAutomated({ subject: 'Automatic reply: hello' }));
  assert.ok(looksAutomated({ subject: 'Undeliverable: hello' }));
  assert.ok(looksAutomated({ subject: 'Hi', headers: { 'auto-submitted': 'auto-replied' } }));
  assert.ok(looksAutomated({ subject: 'Hi', headers: { 'list-id': '<dev.acme.com>' } }));
  assert.ok(looksAutomated({ subject: 'Hi', headers: { precedence: 'bulk' } }));
  assert.ok(!looksAutomated({ subject: 'Lunch?', headers: { 'auto-submitted': 'no' } }));
  assert.ok(!looksAutomated({ subject: 'Lunch?' }));
});

test('is inactive outside its scheduled window', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  assert.ok(vacation.isActive(now, ACTIVE));
  assert.ok(!vacation.isActive(now, { ...ACTIVE, startAt: '2026-07-01T00:00:00Z' }));
  assert.ok(!vacation.isActive(now, { ...ACTIVE, endAt: '2026-06-01T00:00:00Z' }));
  assert.ok(vacation.isActive(now, { ...ACTIVE, startAt: '2026-06-01T00:00:00Z', endAt: '2026-07-01T00:00:00Z' }));
});

test('is inactive when disabled or when the message is empty', () => {
  assert.ok(!vacation.isActive(Date.now(), { ...ACTIVE, enabled: false }));
  assert.ok(!vacation.isActive(Date.now(), { ...ACTIVE, message: '   ' }));
});

test('never replies to the account or one of its own aliases', () => {
  const now = Date.now();
  for (const from of ['me@acme.com', 'Sales <sales@acme.com>']) {
    const verdict = vacation.shouldReply({ from, subject: 'Hi' }, ACCOUNT, now, ACTIVE);
    assert.equal(verdict.reply, false);
    assert.equal(verdict.reason, 'own address');
  }
});

test('replies to an ordinary correspondent', () => {
  const verdict = vacation.shouldReply(
    { from: 'Alice <alice@other.com>', subject: 'Lunch?' }, ACCOUNT, Date.now(), ACTIVE,
  );
  assert.equal(verdict.reply, true);
});

test('honours the per-account selection', () => {
  const scoped = { ...ACTIVE, accountIds: ['acct-2'] };
  const verdict = vacation.shouldReply(
    { from: 'alice@other.com', subject: 'Hi' }, ACCOUNT, Date.now(), scoped,
  );
  assert.equal(verdict.reply, false);
  assert.equal(verdict.reason, 'account not selected');
});
