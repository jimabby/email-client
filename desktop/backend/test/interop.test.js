const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-interop-'));
process.env.HERMES_SECRET_KEY = '3'.repeat(64);

const store = require('../store');
const pgp = require('../services/pgpService');

// Built by the phone (OpenPGP.js v5 + app/src/mime.ts); see its "note".
// Regenerate with: cd app && WRITE_INTEROP_FIXTURE=<this dir>/fixtures/interop-phone-message.json npx jest test/devicePgp.test.tsx
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/interop-phone-message.json'), 'utf8'));

test('a message built and encrypted on the phone (v5) opens and verifies here (v6)', async () => {
  store.addAccount({ type: 'imap', email: 'friend@example.org' });
  const keys = store.getPgpKeys();
  keys.identities['friend@example.org'] = { privateKey: fixture.friendPrivateKey, publicKey: fixture.friendPublicKey, addedAt: new Date().toISOString(), source: 'imported' };
  keys.contacts['me@example.com'] = { publicKey: fixture.mePublicKey, addedAt: new Date().toISOString(), source: 'manual' };
  store.savePgpKeys(keys);

  const raw = Buffer.from(fixture.raw, 'base64');
  const opened = await pgp.open(raw);
  assert.equal(opened.pgp.decrypted, true);
  assert.equal(opened.pgp.status, 'verified');
  assert.equal(opened.pgp.signer, 'me@example.com');
  assert.equal(opened.subject, 'Reply 回复');
  assert.match(opened.text, /See you at noon\./);
  assert.match(opened.html, /<i>noon<\/i>/);
  assert.equal(opened.attachments[0].filename, '路线.txt');
  assert.equal(opened.attachments[0].content.toString(), 'east gate');

  const prebuilt = pgp.readPrebuilt(raw);
  assert.equal(prebuilt.from, 'me@example.com');
  assert.equal(prebuilt.encrypted, true);
  assert.deepEqual(prebuilt.envelope.to.sort(), ['friend@example.org', 'me@example.com']);
  assert.doesNotMatch(prebuilt.rawForSmtp.toString(), /^Bcc:/m);
});

test.after(() => store.flush());
