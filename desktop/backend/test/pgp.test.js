const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pgp-'));
process.env.HERMES_SECRET_KEY = 'a'.repeat(64);

const openpgp = require('openpgp');
const store = require('../store');
const pgp = require('../services/pgpService');

const me = store.addAccount({ type: 'imap', email: 'me@example.com', name: 'Me' });
let friend; // a correspondent's key pair, made outside Hermes

test.before(async () => {
  friend = await openpgp.generateKey({ userIDs: [{ name: 'Friend', email: 'friend@example.org' }], format: 'armored' });
});

test('identities can only be made for your own addresses', async () => {
  await assert.rejects(pgp.generateIdentity({ email: 'someone@else.example' }), /your own addresses/);
  const identity = await pgp.generateIdentity({ email: 'Me@Example.com', name: 'Me' });
  assert.match(identity.fingerprint, /^[0-9A-F]{40}$/);
  assert.match(identity.publicKey, /BEGIN PGP PUBLIC KEY BLOCK/);
  const listed = await pgp.listKeys();
  assert.equal(listed.identities[0].email, 'me@example.com');
  assert.equal(listed.identities[0].privateKey, undefined, 'private keys are never listed');
});

test('a passphrase-protected private key is unlocked once on import', async () => {
  const protectedKey = await openpgp.generateKey({ userIDs: [{ email: 'me@example.com' }], passphrase: 'correct horse', format: 'armored' });
  await assert.rejects(pgp.importIdentity({ email: 'me@example.com', armoredKey: protectedKey.privateKey }), /passphrase/);
  await assert.rejects(pgp.importIdentity({ email: 'me@example.com', armoredKey: protectedKey.privateKey, passphrase: 'wrong' }), /does not unlock/);
  // Restore the generated identity for the remaining tests.
  const before = store.getPgpKeys();
  await pgp.importIdentity({ email: 'me@example.com', armoredKey: protectedKey.privateKey, passphrase: 'correct horse' });
  assert.notEqual(store.getPgpKeys().identities['me@example.com'].publicKey, before.identities['me@example.com'].publicKey);
  store.savePgpKeys(before);
});

test('contact import files a key under its addresses and never keeps a secret', async () => {
  const imported = await pgp.importContactKeys(friend.privateKey);
  assert.deepEqual(imported.map(i => i.email), ['friend@example.org']);
  const stored = store.getPgpKeys().contacts['friend@example.org'].publicKey;
  assert.match(stored, /PUBLIC KEY/);
  assert.doesNotMatch(stored, /PRIVATE KEY/);
  await assert.rejects(pgp.importContactKeys('not a key'), /not an OpenPGP public key/);
});

test('readiness reports who is missing a key', () => {
  assert.deepEqual(pgp.readiness({ from: 'me@example.com', to: 'friend@example.org' }), { canSign: true, canEncrypt: true, missing: [] });
  const r = pgp.readiness({ from: 'me@example.com', to: 'Friend <friend@example.org>, stranger@nowhere.example' });
  assert.equal(r.canEncrypt, false);
  assert.deepEqual(r.missing, ['stranger@nowhere.example']);
});

const draft = {
  to: 'Friend <friend@example.org>',
  bcc: 'hidden@example.net',
  subject: 'Quarterly numbers',
  text: 'The secret is 42.\nLine two with trailing space ',
  html: '<p>The secret is <b>42</b>.</p>',
  attachments: [{ filename: 'plan.txt', contentType: 'text/plain', content: Buffer.from('attached plan').toString('base64') }],
  inReplyTo: '<orig@example.org>',
};

test('encrypt + sign: PGP/MIME on the wire, readable by the recipient and by us', async () => {
  // Bcc must be encrypted to as well.
  await pgp.importContactKeys((await openpgp.generateKey({ userIDs: [{ email: 'hidden@example.net' }], format: 'armored' })).publicKey);
  const { raw, rawForSmtp, envelope } = await pgp.protect(me, draft, { encrypt: true, sign: true });
  const wire = raw.toString();
  assert.match(wire, /Content-Type: multipart\/encrypted;[\s\S]*protocol="application\/pgp-encrypted"/);
  assert.match(wire, /Version: 1/);
  assert.match(wire, /BEGIN PGP MESSAGE/);
  assert.match(wire, /^Autocrypt: addr=me@example\.com; keydata=/m);
  assert.match(wire, /^In-Reply-To: <orig@example\.org>/m);
  assert.doesNotMatch(wire, /secret is 42/, 'body never travels in the clear');
  assert.doesNotMatch(wire, /attached plan/);
  assert.match(wire, /^Bcc: hidden@example\.net/m);
  assert.doesNotMatch(rawForSmtp.toString(), /^Bcc:/m, 'SMTP copy drops Bcc');
  assert.deepEqual(envelope.to.sort(), ['friend@example.org', 'hidden@example.net']);

  // We can read our own Sent copy.
  const opened = await pgp.open(raw);
  assert.equal(opened.pgp.encrypted, true);
  assert.equal(opened.pgp.decrypted, true);
  assert.equal(opened.pgp.status, 'verified');
  assert.match(opened.text, /The secret is 42\./);
  assert.match(opened.html, /<b>42<\/b>/);
  assert.equal(opened.attachments[0].filename, 'plan.txt');
  assert.equal(opened.attachments[0].content.toString(), 'attached plan');

  // And so can the friend, with a stock OpenPGP implementation.
  const parts = pgp._internals.partsOf(pgp._internals.splitHeaderBody(raw).body, pgp._internals.paramOf(pgp._internals.headerValue(pgp._internals.splitHeaderBody(raw).headers, 'content-type'), 'boundary'));
  const armored = parts[1].slice(parts[1].indexOf('-----BEGIN'));
  const decrypted = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: armored }),
    decryptionKeys: await openpgp.readPrivateKey({ armoredKey: friend.privateKey }),
    format: 'binary',
  });
  assert.match(Buffer.from(decrypted.data).toString(), /plan\.txt/);
});

test('encrypting to someone without a key fails before anything is sent', async () => {
  await assert.rejects(pgp.protect(me, { ...draft, bcc: '', to: 'stranger@nowhere.example' }, { encrypt: true }), (err) => {
    assert.equal(err.code, 'PGP_MISSING_KEYS');
    assert.deepEqual(err.missing, ['stranger@nowhere.example']);
    return true;
  });
  const other = store.addAccount({ type: 'imap', email: 'nokey@example.com' });
  await assert.rejects(pgp.protect(other, draft, { sign: true }), (err) => err.code === 'PGP_NO_IDENTITY');
});

test('sign only: multipart/signed that verifies, and tampering is caught', async () => {
  const { raw } = await pgp.protect(me, { ...draft, bcc: '' }, { sign: true });
  const wire = raw.toString();
  assert.match(wire, /Content-Type: multipart\/signed;[\s\S]*protocol="application\/pgp-signature"/);
  assert.match(wire, /BEGIN PGP SIGNATURE/);

  const opened = await pgp.open(raw);
  assert.equal(opened.pgp.encrypted, false);
  assert.equal(opened.pgp.status, 'verified');
  assert.equal(opened.pgp.signer, 'me@example.com');
  assert.equal(opened.attachments.length, 1, 'the signature itself is not listed as an attachment');

  const tampered = Buffer.from(wire.replace('attached plan', 'attached plaN').replace(Buffer.from('attached plan').toString('base64'), Buffer.from('attached plaN').toString('base64')));
  assert.equal((await pgp.open(tampered)).pgp.status, 'bad');
});

test('a valid signature from a key that does not name the sender is a mismatch', async () => {
  const { raw } = await pgp.protect(me, { ...draft, bcc: '' }, { sign: true });
  const spoofed = Buffer.from(raw.toString().replace(/^From: .*$/m, 'From: friend@example.org'));
  assert.equal((await pgp.open(spoofed)).pgp.status, 'mismatch');
});

test('an unknown signer is reported as such, not as verified', async () => {
  const stranger = await openpgp.generateKey({ userIDs: [{ email: 'stranger@nowhere.example' }], format: 'armored' });
  const signed = await openpgp.sign({ message: await openpgp.createCleartextMessage({ text: 'Hello there' }), signingKeys: await openpgp.readPrivateKey({ armoredKey: stranger.privateKey }) });
  const raw = Buffer.from(`From: stranger@nowhere.example\r\nTo: me@example.com\r\nSubject: hi\r\nContent-Type: text/plain\r\n\r\n${signed.replace(/\r?\n/g, '\r\n')}`);
  const opened = await pgp.open(raw);
  assert.equal(opened.pgp.status, 'unknown-key');
  assert.match(opened.text, /Hello there/);
});

test('inline PGP messages are decrypted and verified', async () => {
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: 'inline secret' }),
    encryptionKeys: await openpgp.readKey({ armoredKey: store.getPgpKeys().identities['me@example.com'].publicKey }),
    signingKeys: await openpgp.readPrivateKey({ armoredKey: friend.privateKey }),
  });
  const raw = Buffer.from(`From: Friend <friend@example.org>\r\nTo: me@example.com\r\nSubject: inline\r\nContent-Type: text/plain\r\n\r\nHi,\r\n${armored.replace(/\r?\n/g, '\r\n')}\r\n`);
  const opened = await pgp.open(raw);
  assert.equal(opened.pgp.decrypted, true);
  assert.equal(opened.pgp.status, 'verified');
  assert.match(opened.text, /inline secret/);
});

test('looksProtected spots PGP/MIME parts and armor, and ignores ordinary mail', () => {
  assert.equal(pgp.looksProtected({ text: 'hello', attachments: [] }), false);
  assert.equal(pgp.looksProtected({ text: '', attachments: [{ filename: 'encrypted.asc', contentType: 'application/octet-stream' }] }), true);
  assert.equal(pgp.looksProtected({ text: '', attachments: [{ filename: 'signature.asc', contentType: 'application/pgp-signature' }] }), true);
  assert.equal(pgp.looksProtected({ text: '-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----', attachments: [] }), true);
});

test('Autocrypt teaches a first-contact key and flags a changed one without replacing it', async () => {
  const newcomer = await openpgp.generateKey({ userIDs: [{ email: 'new@contact.example' }], format: 'armored' });
  const keydata = Buffer.from((await openpgp.readKey({ armoredKey: newcomer.publicKey })).write()).toString('base64');
  const mail = (kd) => Buffer.from(`From: new@contact.example\r\nAutocrypt: addr=new@contact.example; keydata=${kd}\r\nContent-Type: multipart/signed; protocol="application/pgp-signature"; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b\r\nContent-Type: application/pgp-signature\r\n\r\n-----BEGIN PGP SIGNATURE-----\r\n\r\n-----END PGP SIGNATURE-----\r\n--b--\r\n`);
  const first = await pgp.open(mail(keydata));
  assert.deepEqual(first.pgp.learned, { learned: 'new@contact.example' });
  assert.equal(store.getPgpKeys().contacts['new@contact.example'].source, 'autocrypt');

  const replacement = await openpgp.generateKey({ userIDs: [{ email: 'new@contact.example' }], format: 'armored' });
  const otherdata = Buffer.from((await openpgp.readKey({ armoredKey: replacement.publicKey })).write()).toString('base64');
  const second = await pgp.open(mail(otherdata));
  assert.deepEqual(second.pgp.learned, { changed: 'new@contact.example' });
  const stored = store.getPgpKeys().contacts['new@contact.example'];
  assert.ok(stored.keyChanged?.fingerprint);
  assert.equal((await openpgp.readKey({ armoredKey: stored.publicKey })).getFingerprint(), (await openpgp.readKey({ armoredKey: newcomer.publicKey })).getFingerprint());
});

test('ordinary mail is left alone', async () => {
  const raw = Buffer.from('From: a@b.example\r\nSubject: hi\r\nContent-Type: text/plain\r\n\r\nJust text\r\n');
  assert.equal(await pgp.open(raw), null);
});

test.after(() => store.flush());
