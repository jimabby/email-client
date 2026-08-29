const test = require('node:test');
const assert = require('node:assert');
const tickets = require('../services/downloadTicketService');

const TARGET = { accountId: 'a1', emailId: 'a1::7', index: 0, folder: 'INBOX' };

test('a ticket redeems once and only once', () => {
  const { token } = tickets.issue(TARGET);
  const first = tickets.redeem(token);
  assert.deepEqual(first, TARGET);
  // The whole point: a URL that leaks after use is worthless.
  assert.equal(tickets.redeem(token), null);
});

test('an unknown token is refused', () => {
  assert.equal(tickets.redeem('nope'), null);
  assert.equal(tickets.redeem(''), null);
  assert.equal(tickets.redeem(undefined), null);
  assert.equal(tickets.redeem(null), null);
});

test('a ticket is bound to one attachment, not to the account', () => {
  const { token } = tickets.issue({ ...TARGET, index: 3 });
  assert.equal(tickets.redeem(token).index, 3);
});

test('an expired ticket is refused', () => {
  const { token } = tickets.issue(TARGET);
  // Reach in and age it rather than waiting two minutes.
  tickets._internals.tickets.get(token).expiresAt = Date.now() - 1;
  assert.equal(tickets.redeem(token), null);
});

test('tokens are long, random, and URL-safe', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const { token } = tickets.issue(TARGET);
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(!seen.has(token), 'tokens must not repeat');
    seen.add(token);
  }
});

test('outstanding tickets stay bounded', () => {
  for (let i = 0; i < 700; i++) tickets.issue(TARGET);
  assert.ok(tickets._internals.tickets.size <= 500, 'unredeemed tickets must not grow without bound');
});

test('the reported lifetime matches the enforced one', () => {
  const { expiresIn } = tickets.issue(TARGET);
  assert.equal(expiresIn, Math.floor(tickets._internals.TTL_MS / 1000));
});
