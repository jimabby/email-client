const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-digest-'));
process.env.HERMES_SECRET_KEY = 'e'.repeat(64);
fs.writeFileSync(path.join(process.env.HERMES_DATA_DIR, 'accounts.json'), '{"accounts":[],"aiSettings":{}}');

// Provider stub: one mailbox whose folders and digest contents the test controls.
const folders = [{ name: 'INBOX', path: 'INBOX' }];
const waiting = [];
require.cache[require.resolve('../services/gmailService')] = { exports: {
  getFolders: async () => folders,
  createFolder: async (account, name) => { const folder = { name, path: `Label_${name}` }; folders.push(folder); return folder; },
  fetchEmails: async (account, folder) => ({ emails: folder === 'Label_Digest' ? waiting : [] }),
} };

const store = require('../store');
const contacts = require('../services/contactsService');
const rules = require('../services/rulesService');
const notifications = require('../services/notificationService');
const digest = require('../services/digestService');

const actions = [];
rules.runAction = async (account, email, action) => { actions.push({ id: email.id, folder: email.folder, ...action }); };
let wroteTo = [];
contacts.hasWrittenTo = (email) => wroteTo.includes(email);
const delivered = [];
notifications.notifyDigest = (perAccount, total) => { delivered.push({ perAccount, total }); return true; };

const ACCOUNT = store.addAccount({ type: 'gmail', email: 'me@example.com' });
const mail = (id, from, subject = id, extra = {}) => ({ id: `${ACCOUNT.id}-${id}`, accountId: ACCOUNT.id, from, folder: 'INBOX', subject, snippet: '', ...extra });

test.beforeEach(() => { actions.length = 0; });

test('nothing is filed while the digest is off', async () => {
  const handled = await digest.collectArrivals(ACCOUNT, [mail('a', 'Acme <newsletter@acme.example>')]);
  assert.equal(handled.size, 0);
});

test('newsletters are filed into a Digest folder created on demand; people are not', async () => {
  digest.configure({ enabled: true, deliverAt: '17:00' });
  const handled = await digest.collectArrivals(ACCOUNT, [
    mail('b', 'Acme <newsletter@acme.example>', 'October news'),
    mail('c', 'Pat <pat@friend.example>', 'Lunch?'),
    mail('d', 'Shop <hello@shop.example>', 'Flash sale: 40% off'),
  ]);
  assert.deepEqual([...handled].sort(), [`${ACCOUNT.id}-b`, `${ACCOUNT.id}-d`]);
  assert.ok(folders.some(f => f.name === 'Digest'));
  assert.deepEqual(actions.map(a => [a.id.split('-').pop(), a.type, a.targetFolder]), [['b', 'move', 'Label_Digest'], ['d', 'move', 'Label_Digest']]);
  assert.equal(store.getDigestState().collected[ACCOUNT.id], 2);
});

test('VIPs, correspondents, kept senders, and Primary overrides never go to the digest', () => {
  store.saveNotificationSettings({ ...store.getNotificationSettings(), vips: ['vip@news.example'] });
  wroteTo = ['replied@news.example'];
  digest.setSender('@kept.example', 'keep');
  store.saveCategoryOverrides({ senders: { 'deals@mine.example': 'Primary' }, domains: {} });
  assert.equal(digest.belongsInDigest(mail('e', 'vip@news.example', '50% off')), false);
  assert.equal(digest.belongsInDigest(mail('f', 'replied@news.example', '50% off')), false);
  assert.equal(digest.belongsInDigest(mail('g', 'promo@mail.kept.example', '50% off')), false);
  assert.equal(digest.belongsInDigest(mail('h', 'deals@mine.example', '50% off')), false);
});

test('a sender added by hand is digested even without marketing signals; auto-detect can be turned off', () => {
  digest.setSender('Weekly <weekly@blog.example>', 'digest');
  assert.equal(digest.belongsInDigest(mail('i', 'weekly@blog.example', 'Post #12')), true);
  digest.configure({ autoDetect: false });
  assert.equal(digest.belongsInDigest(mail('j', 'newsletter@acme.example', 'October news')), false);
  assert.equal(digest.belongsInDigest(mail('k', 'weekly@blog.example', 'Post #13')), true);
  digest.configure({ autoDetect: true });
});

test('a sender sits on one list at a time; bad input is refused', () => {
  digest.setSender('weekly@blog.example', 'keep');
  const settings = store.getDigestSettings();
  assert.ok(settings.excluded.includes('weekly@blog.example'));
  assert.ok(!settings.senders.includes('weekly@blog.example'));
  assert.throws(() => digest.setSender('nonsense', 'digest'), /address/);
  assert.throws(() => digest.configure({ deliverAt: '25:00' }), /HH:MM/);
});

test('the list groups waiting mail by sender and flags what is new since the last digest', async () => {
  store.saveDigestState({ lastDeliveredAt: '2026-11-05T17:00:00.000Z' });
  waiting.push(
    mail('l', 'Acme <newsletter@acme.example>', 'Old', { date: '2026-11-05T09:00:00.000Z', read: true }),
    mail('m', 'Acme <newsletter@acme.example>', 'New', { date: '2026-11-06T09:00:00.000Z' }),
    mail('n', 'Shop <hello@shop.example>', 'Sale', { date: '2026-11-06T08:00:00.000Z' }),
  );
  const { groups } = await digest.list();
  assert.equal(groups[0].sender, 'newsletter@acme.example');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].unread, 1);
  assert.deepEqual(groups[0].emails.map(e => [e.subject, e.isNew]), [['New', true], ['Old', false]]);
});

test('"not a newsletter" keeps the sender in the inbox and moves what is waiting back', async () => {
  const result = await digest.release('newsletter@acme.example');
  assert.equal(result.moved, 2);
  assert.deepEqual(actions.map(a => [a.id.split('-').pop(), a.folder, a.targetFolder]), [['m', 'Label_Digest', 'INBOX'], ['l', 'Label_Digest', 'INBOX']]);
  assert.equal(digest.belongsInDigest(mail('o', 'newsletter@acme.example', 'More news')), false);
});

test('mark all read touches only unread messages', async () => {
  const result = await digest.markAllRead();
  assert.equal(result.marked, 2); // m and n; l was already read
  assert.ok(actions.every(a => a.type === 'markRead'));
});

test('delivery happens once a day at the chosen local time and resets the count', () => {
  store.saveNotificationSettings({ ...store.getNotificationSettings(), timeZone: 'UTC' });
  store.saveDigestState({ lastDeliveredDate: '2026-11-05', collected: { [ACCOUNT.id]: 3 } });
  assert.equal(digest.isDue(new Date('2026-11-06T16:59:00Z')), false);
  assert.equal(digest.isDue(new Date('2026-11-06T17:00:00Z')), true);

  const after = digest.deliver(new Date('2026-11-06T17:00:00Z'));
  assert.deepEqual(delivered.at(-1), { perAccount: [{ accountId: ACCOUNT.id, count: 3 }], total: 3 });
  assert.equal(after.lastDeliveredDate, '2026-11-06');
  assert.deepEqual(after.collected, {});
  assert.equal(after.lastCount, 3);
  assert.equal(digest.isDue(new Date('2026-11-06T20:00:00Z')), false, 'not twice in one day');

  // An empty day still counts as delivered, but sends nothing.
  const before = delivered.length;
  digest.deliver(new Date('2026-11-07T17:00:00Z'));
  assert.equal(delivered.length, before);
});

test('the local clock reads the configured time zone', () => {
  const { localClock } = digest._internals;
  assert.deepEqual(localClock(new Date('2026-11-06T23:30:00Z'), 'Asia/Shanghai'), { date: '2026-11-07', minutes: 7 * 60 + 30 });
});

test.after(() => store.flush());
