const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-screener-'));
process.env.HERMES_SECRET_KEY = 'd'.repeat(64);
fs.writeFileSync(path.join(process.env.HERMES_DATA_DIR, 'accounts.json'), '{"accounts":[],"aiSettings":{}}');

// Provider stub: one mailbox whose folders and messages the test controls.
const folders = [{ name: 'INBOX', path: 'INBOX' }];
const screened = []; // messages currently sitting in the Screener folder
const fakeGmail = {
  getFolders: async () => folders,
  createFolder: async (account, name) => {
    const folder = { name, path: `Label_${name}` };
    folders.push(folder);
    return folder;
  },
  fetchEmails: async (account, folder) => ({ emails: folder === 'Label_Screener' ? screened : [] }),
};
require.cache[require.resolve('../services/gmailService')] = { exports: fakeGmail };

const store = require('../store');
const contacts = require('../services/contactsService');
const rules = require('../services/rulesService');
const screener = require('../services/screenerService');

const actions = [];
rules.runAction = async (account, email, action) => { actions.push({ id: email.id, ...action }); };

// Contacts as the search index would report them.
let known = [];
contacts.all = () => known;
contacts.hasWrittenTo = (email) => known.some(c => c.email === email && c.outbound);
contacts.invalidate = () => {};

const ACCOUNT = store.addAccount({ type: 'gmail', email: 'me@example.com' });
const mail = (id, from) => ({ id: `${ACCOUNT.id}-${id}`, accountId: ACCOUNT.id, from, folder: 'INBOX', subject: id });

test.beforeEach(() => { actions.length = 0; });

test('everything is allowed while the screener is off', () => {
  assert.strictEqual(screener.classify(mail('a', 'stranger@spam.example')), 'allow');
});

test('switching it on approves everyone already corresponded with', () => {
  known = [{ email: 'friend@example.com', outbound: false }, { email: 'boss@work.example', outbound: true }];
  const settings = screener.configure({ enabled: true });
  assert.ok(settings.enabled);
  assert.ok(settings.allowed.includes('friend@example.com'));
  assert.ok(settings.allowed.includes('boss@work.example'));
  assert.strictEqual(screener.classify(mail('b', 'Friend <friend@example.com>')), 'allow');
});

test('a first-time sender is screened; someone the user wrote to is not', () => {
  assert.strictEqual(screener.classify(mail('c', 'New Person <new@else.example>')), 'screen');
  known.push({ email: 'replied@else.example', outbound: true });
  assert.strictEqual(screener.classify(mail('d', 'replied@else.example')), 'allow');
});

test('the user’s own addresses are never screened', () => {
  assert.strictEqual(screener.classify(mail('e', 'Me <me@example.com>')), 'allow');
});

test('a message with no parseable sender is let through', () => {
  assert.strictEqual(screener.classify(mail('f', 'undisclosed-recipients')), 'allow');
});

test('arrivals from unknown senders are moved to a Screener folder created on demand', async () => {
  const handled = await screener.screenArrivals(ACCOUNT, [
    mail('g', 'stranger@spam.example'),
    mail('h', 'friend@example.com'),
  ]);
  assert.deepStrictEqual([...handled], [`${ACCOUNT.id}-g`]);
  assert.ok(folders.some(f => f.name === 'Screener'), 'folder created');
  assert.deepStrictEqual(actions, [{ id: `${ACCOUNT.id}-g`, type: 'move', targetFolder: 'Label_Screener' }]);
});

test('allowing a sender releases everything they have waiting', async () => {
  screened.push(
    { ...mail('i', 'Stranger <stranger@spam.example>'), folder: 'Label_Screener' },
    { ...mail('j', 'stranger@spam.example'), folder: 'Label_Screener' },
    { ...mail('k', 'other@else.example'), folder: 'Label_Screener' },
  );
  const result = await screener.decide({ sender: 'Stranger <stranger@spam.example>', decision: 'allow' });
  assert.strictEqual(result.moved, 2);
  assert.deepStrictEqual(actions.map(a => [a.id.split('-').pop(), a.type, a.targetFolder]), [['i', 'move', 'INBOX'], ['j', 'move', 'INBOX']]);
  assert.strictEqual(screener.classify(mail('l', 'stranger@spam.example')), 'allow');
});

test('blocking a domain bins what is waiting and every future message', async () => {
  const result = await screener.decide({ sender: '@else.example', decision: 'block' });
  assert.strictEqual(result.moved, 1);
  assert.deepStrictEqual(actions, [{ id: `${ACCOUNT.id}-k`, type: 'delete' }]);
  const handled = await screener.screenArrivals(ACCOUNT, [mail('m', 'anyone@else.example')]);
  assert.ok(handled.has(`${ACCOUNT.id}-m`));
  assert.strictEqual(actions.at(-1).type, 'delete');
});

test('a sender moves between lists rather than sitting in both', async () => {
  await screener.decide({ sender: 'stranger@spam.example', decision: 'block' });
  const settings = store.getScreenerSettings();
  assert.ok(settings.blocked.includes('stranger@spam.example'));
  assert.ok(!settings.allowed.includes('stranger@spam.example'));
});

test('forgetting a sender returns them to the screener', () => {
  screener.forget('stranger@spam.example');
  assert.strictEqual(screener.classify(mail('n', 'stranger@spam.example')), 'screen');
});

test('nonsense senders and decisions are refused', async () => {
  await assert.rejects(screener.decide({ sender: 'not an address', decision: 'allow' }));
  await assert.rejects(screener.decide({ sender: 'a@b.example', decision: 'maybe' }));
});

test('listPending groups waiting mail by sender, newest first', async () => {
  screened.length = 0;
  screened.push(
    { ...mail('o', 'A <a@x.example>'), date: '2026-05-01T00:00:00Z' },
    { ...mail('p', 'b@y.example'), date: '2026-06-01T00:00:00Z' },
    { ...mail('q', 'a@x.example'), date: '2026-04-01T00:00:00Z' },
  );
  const { pending } = await screener.listPending();
  assert.deepStrictEqual(pending.map(p => [p.sender, p.count]), [['b@y.example', 1], ['a@x.example', 2]]);
  assert.strictEqual(pending[1].name, 'A');
});
