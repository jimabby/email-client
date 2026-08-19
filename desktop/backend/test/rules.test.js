const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-rules-'));
process.env.HERMES_SECRET_KEY = 'd'.repeat(64);

const rules = require('../services/rulesService');

const email = (overrides = {}) => ({
  id: 'acct-1::1',
  accountId: 'acct-1',
  folder: 'INBOX',
  from: 'Newsletter <news@marketing.example.com>',
  to: ['me@example.com'],
  subject: 'Your weekly digest',
  snippet: 'Unsubscribe at any time',
  ...overrides,
});

const rule = (overrides = {}) => rules.sanitizeRule({
  name: 'Test',
  match: 'all',
  conditions: [{ field: 'from', op: 'contains', value: 'marketing' }],
  actions: [{ type: 'markRead' }],
  ...overrides,
});

// ─── sanitizeRule ───────────────────────────────────────────────────────────

test('sanitizeRule fills in an id, defaults, and keeps valid input', () => {
  const clean = rules.sanitizeRule({
    name: 'Filing',
    conditions: [{ field: 'subject', op: 'startsWith', value: 'Invoice' }],
    actions: [{ type: 'move', targetFolder: 'Bills' }],
  });
  assert.ok(clean.id);
  assert.strictEqual(clean.enabled, true);
  assert.strictEqual(clean.match, 'all');
  assert.deepStrictEqual(clean.actions, [{ type: 'move', targetFolder: 'Bills' }]);
});

test('sanitizeRule drops unknown fields, operators, and actions', () => {
  const clean = rules.sanitizeRule({
    conditions: [
      { field: 'from', op: 'contains', value: 'ok' },
      { field: 'bogusField', op: 'contains', value: 'x' },
      { field: 'subject', op: 'bogusOp', value: 'x' },
    ],
    actions: [{ type: 'move', targetFolder: 'X' }, { type: 'launchMissiles' }],
  });
  assert.strictEqual(clean.conditions.length, 1);
  assert.strictEqual(clean.actions.length, 1);
});

test('sanitizeRule falls back to a safe action when none survive', () => {
  const clean = rules.sanitizeRule({ conditions: [], actions: [{ type: 'nope' }] });
  assert.deepStrictEqual(clean.actions, [{ type: 'markRead', targetFolder: '' }]);
});

test('sanitizeRule caps list lengths and string sizes', () => {
  const clean = rules.sanitizeRule({
    name: 'n'.repeat(500),
    conditions: Array.from({ length: 50 }, () => ({ field: 'from', op: 'contains', value: 'v'.repeat(1000) })),
    actions: Array.from({ length: 50 }, () => ({ type: 'star' })),
  });
  assert.strictEqual(clean.name.length, 80);
  assert.strictEqual(clean.conditions.length, 10);
  assert.strictEqual(clean.conditions[0].value.length, 300);
  assert.strictEqual(clean.actions.length, 5);
});

// ─── Matching ───────────────────────────────────────────────────────────────

test('contains matches case-insensitively by default', () => {
  assert.ok(rules.ruleMatches(email(), rule({ conditions: [{ field: 'from', op: 'contains', value: 'MARKETING' }] })));
});

test('caseSensitive makes the comparison exact', () => {
  const r = rule({ conditions: [{ field: 'from', op: 'contains', value: 'MARKETING', caseSensitive: true }] });
  assert.strictEqual(rules.ruleMatches(email(), r), false);
});

test('every operator behaves as named', () => {
  const cases = [
    ['contains', 'weekly', true],
    ['contains', 'monthly', false],
    ['notContains', 'monthly', true],
    ['notContains', 'weekly', false],
    ['equals', 'Your weekly digest', true],
    ['equals', 'weekly', false],
    ['startsWith', 'your', true],
    ['startsWith', 'digest', false],
    ['endsWith', 'digest', true],
    ['endsWith', 'your', false],
    ['matches', '^your .* digest$', true],
    ['matches', '^digest', false],
  ];
  for (const [op, value, expected] of cases) {
    const r = rule({ conditions: [{ field: 'subject', op, value }] });
    assert.strictEqual(rules.ruleMatches(email(), r), expected, `${op} "${value}"`);
  }
});

test('an invalid regex fails closed instead of throwing', () => {
  const r = rule({ conditions: [{ field: 'subject', op: 'matches', value: '([unclosed' }] });
  assert.strictEqual(rules.ruleMatches(email(), r), false);
});

test('match:all requires every condition, match:any requires one', () => {
  const conditions = [
    { field: 'from', op: 'contains', value: 'marketing' },
    { field: 'subject', op: 'contains', value: 'nonexistent' },
  ];
  assert.strictEqual(rules.ruleMatches(email(), rule({ match: 'all', conditions })), false);
  assert.strictEqual(rules.ruleMatches(email(), rule({ match: 'any', conditions })), true);
});

test('a rule scoped to another account never matches', () => {
  const r = rule({ accountId: 'acct-2' });
  assert.strictEqual(rules.ruleMatches(email(), r), false);
  assert.strictEqual(rules.ruleMatches(email({ accountId: 'acct-2' }), r), true);
});

test('a disabled rule never matches', () => {
  assert.strictEqual(rules.ruleMatches(email(), rule({ enabled: false })), false);
});

test('a rule with no conditions matches nothing rather than everything', () => {
  const r = rules.sanitizeRule({ name: 'Empty', conditions: [], actions: [{ type: 'delete' }] });
  assert.strictEqual(rules.ruleMatches(email(), r), false);
});

test('the to field matches against an array of recipients', () => {
  const r = rule({ conditions: [{ field: 'to', op: 'contains', value: 'me@example.com' }] });
  assert.ok(rules.ruleMatches(email(), r));
});

test('hasAttachment/isTrue matches only when the flag is set', () => {
  const r = rule({ conditions: [{ field: 'hasAttachment', op: 'isTrue', value: '' }] });
  assert.strictEqual(rules.ruleMatches(email(), r), false);
  assert.strictEqual(rules.ruleMatches(email({ hasAttachments: true }), r), true);
});

// ─── previewRule ────────────────────────────────────────────────────────────

test('previewRule reports matching ids without performing any action', () => {
  const batch = [
    email({ id: 'a' }),
    email({ id: 'b', from: 'Friend <friend@personal.com>' }),
    email({ id: 'c' }),
  ];
  const matched = rules.previewRule(
    { conditions: [{ field: 'from', op: 'contains', value: 'marketing' }], actions: [{ type: 'delete' }] },
    batch,
  );
  assert.deepStrictEqual(matched, ['a', 'c']);
});
