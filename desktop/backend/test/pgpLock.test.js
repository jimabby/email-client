const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pgp-lock-'));
process.env.HERMES_SECRET_KEY = '7'.repeat(64);

const openpgp = require('openpgp');
const store = require('../store');
const pgp = require('../services/pgpService');
const { denialFor } = require('../middleware/deviceScope');

const me = store.addAccount({ type: 'imap', email: 'me@example.com', name: 'Me' });
const PASS = 'correct horse battery';
let encryptedToMe;

test.before(async () => {
  await pgp.generateIdentity({ email: 'me@example.com' });
  ({ raw: encryptedToMe } = await pgp.protect(me, { to: 'me@example.com', subject: 'Note to self', text: 'locked secret' }, { encrypt: true, sign: true }));
});

test('requiring a passphrase stores only a passphrase-encrypted key', async () => {
  await assert.rejects(pgp.requirePassphrase('me@example.com', 'short'), /at least 8/);
  const result = await pgp.requirePassphrase('me@example.com', PASS);
  assert.equal(result.locked, true);
  assert.ok(result.unlockedUntil, 'stays unlocked for the session that set it');
  const stored = await openpgp.readPrivateKey({ armoredKey: store.getPgpKeys().identities['me@example.com'].privateKey });
  assert.equal(stored.isDecrypted(), false, 'the copy at rest is useless without the passphrase');
  await assert.rejects(pgp.requirePassphrase('me@example.com', PASS), /already/);
});

test('a locked key cannot read or send, and says why', async () => {
  pgp.lockNow();
  const opened = await pgp.open(encryptedToMe);
  assert.equal(opened.pgp.decrypted, false);
  assert.equal(opened.pgp.locked, true);
  assert.doesNotMatch(JSON.stringify(opened), /locked secret/);

  assert.equal(pgp.readiness({ from: 'me@example.com', to: 'me@example.com' }).locked, true);
  await assert.rejects(pgp.protect(me, { to: 'me@example.com', subject: 'x', text: 'y' }, { sign: true }), (err) => err.code === 'PGP_LOCKED');
  await assert.rejects(pgp.exportIdentity('me@example.com', 'backup passphrase'), (err) => err.code === 'PGP_LOCKED');
  const listed = (await pgp.listKeys()).identities[0];
  assert.equal(listed.locked, true);
  assert.equal(listed.unlockedUntil, null);
});

test('a wrong passphrase is refused; the right one unlocks for a while', async () => {
  await assert.rejects(pgp.unlockIdentity({ email: 'me@example.com', passphrase: 'nope nope nope' }), (err) => err.code === 'PGP_BAD_PASSPHRASE');
  const { unlocked } = await pgp.unlockIdentity({ passphrase: PASS, hours: 1 });
  assert.equal(unlocked[0].email, 'me@example.com');
  const opened = await pgp.open(encryptedToMe);
  assert.equal(opened.pgp.decrypted, true);
  assert.equal(opened.subject, 'Note to self');
  assert.equal(pgp.readiness({ from: 'me@example.com', to: 'me@example.com' }).locked, false);
});

test('the unlock expires on its own', async () => {
  pgp._internals.unlocked.get('me@example.com').until = Date.now() - 1;
  assert.equal(pgp.isLocked('me@example.com'), true);
  assert.equal((await pgp.open(encryptedToMe)).pgp.locked, true);
});

test('unlock hours are capped', async () => {
  const { unlocked } = await pgp.unlockIdentity({ email: 'me@example.com', passphrase: PASS, hours: 10_000 });
  const hours = (Date.parse(unlocked[0].unlockedUntil) - Date.now()) / 3600_000;
  assert.ok(hours <= 72.01 && hours > 71, `capped at 72h, got ${hours}`);
});

test('removing the passphrase needs the passphrase', async () => {
  await assert.rejects(pgp.removePassphrase('me@example.com', 'wrong passphrase'), /does not unlock/);
  await pgp.removePassphrase('me@example.com', PASS);
  pgp.lockNow();
  assert.equal(pgp.isLocked('me@example.com'), false);
  assert.equal((await pgp.open(encryptedToMe)).pgp.decrypted, true, 'unlocked storage works without a session');
});

test('any device may unlock or lock; only the master token changes the requirement', () => {
  for (const scope of ['read', 'mail', 'full']) {
    assert.equal(denialFor(scope, 'POST', '/pgp/unlock'), null, scope);
    assert.equal(denialFor(scope, 'POST', '/pgp/lock'), null, scope);
  }
  assert.match(denialFor('mail', 'POST', '/pgp/identities/me@example.com/passphrase'), /master token/);
});

test.after(() => store.flush());
