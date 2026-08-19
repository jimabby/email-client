const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Each test gets its own data dir + key so runs can't contaminate each other.
function freshSecrets(key) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-secrets-'));
  process.env.HERMES_DATA_DIR = dir;
  process.env.HERMES_SECRET_KEY = key;
  delete require.cache[require.resolve('../services/secretStore')];
  return { secrets: require('../services/secretStore'), dir };
}

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

test('encrypt produces a tagged value that is not the plaintext', () => {
  const { secrets } = freshSecrets(KEY_A);
  const sealed = secrets.encrypt('hunter2');
  assert.notStrictEqual(sealed, 'hunter2');
  assert.ok(secrets.isEncrypted(sealed));
  assert.ok(!sealed.includes('hunter2'));
});

test('encrypt then decrypt round-trips, including unicode', () => {
  const { secrets } = freshSecrets(KEY_A);
  for (const value of ['hunter2', 'sk-ant-api03-xyz', 'pässwörd — ✉️', 'a'.repeat(5000)]) {
    assert.strictEqual(secrets.decrypt(secrets.encrypt(value)), value);
  }
});

test('encrypting an already sealed value is a no-op', () => {
  const { secrets } = freshSecrets(KEY_A);
  const once = secrets.encrypt('token');
  assert.strictEqual(secrets.encrypt(once), once);
});

test('empty and non-string values pass through untouched', () => {
  const { secrets } = freshSecrets(KEY_A);
  assert.strictEqual(secrets.encrypt(''), '');
  assert.strictEqual(secrets.encrypt(undefined), undefined);
  assert.strictEqual(secrets.decrypt('plain text'), 'plain text');
});

test('sealObject seals only the known secret fields, recursively', () => {
  const { secrets } = freshSecrets(KEY_A);
  const sealed = secrets.sealObject({
    email: 'a@b.com',
    password: 'hunter2',
    nested: { refreshToken: 'rt-123', label: 'keep me' },
    list: [{ apiKey: 'sk-1' }],
  });

  assert.strictEqual(sealed.email, 'a@b.com');
  assert.strictEqual(sealed.nested.label, 'keep me');
  assert.ok(secrets.isEncrypted(sealed.password));
  assert.ok(secrets.isEncrypted(sealed.nested.refreshToken));
  assert.ok(secrets.isEncrypted(sealed.list[0].apiKey));
});

test('openObject reverses sealObject', () => {
  const { secrets } = freshSecrets(KEY_A);
  const original = { password: 'hunter2', nested: { accessToken: 'at-1' }, other: 5 };
  const restored = secrets.openObject(secrets.sealObject(original));
  assert.deepStrictEqual(restored, original);
});

// This is the property that stops a key mismatch from destroying credentials:
// a value that cannot be decrypted must come back still sealed, so writing the
// store again preserves it byte-for-byte.
test('a wrong key leaves the sealed value intact rather than blanking it', () => {
  const { secrets: withA, dir } = freshSecrets(KEY_A);
  const sealed = withA.sealObject({ password: 'hunter2' });

  process.env.HERMES_DATA_DIR = dir;
  process.env.HERMES_SECRET_KEY = KEY_B;
  delete require.cache[require.resolve('../services/secretStore')];
  const withB = require('../services/secretStore');

  const opened = withB.openObject(sealed);
  assert.notStrictEqual(opened.password, '', 'must not blank the credential');
  assert.ok(withB.isUnreadable(opened.password));

  // Re-sealing with the wrong key must not alter the stored ciphertext...
  const resealed = withB.sealObject(opened);
  assert.strictEqual(resealed.password, sealed.password);

  // ...so the original key still recovers it.
  process.env.HERMES_SECRET_KEY = KEY_A;
  delete require.cache[require.resolve('../services/secretStore')];
  const againWithA = require('../services/secretStore');
  assert.strictEqual(againWithA.openObject(resealed).password, 'hunter2');
});

test('a passphrase key is accepted as well as raw hex', () => {
  const { secrets } = freshSecrets('a memorable passphrase');
  assert.strictEqual(secrets.decrypt(secrets.encrypt('value')), 'value');
});

test('tampered ciphertext fails authentication instead of returning garbage', () => {
  const { secrets } = freshSecrets(KEY_A);
  const prefix = 'enc:g1:';
  const sealed = secrets.encrypt('hunter2');
  assert.ok(sealed.startsWith(prefix));

  // Flip a bit in a real ciphertext byte. Editing the base64 text directly is
  // unreliable — a change in the final character can land entirely in padding
  // bits that decode away, leaving the payload untouched.
  const raw = Buffer.from(sealed.slice(prefix.length), 'base64');
  // Layout is [12-byte IV][16-byte tag][body]; corrupt the first body byte.
  raw[28] ^= 0xff;
  const tampered = prefix + raw.toString('base64');

  const result = secrets.decrypt(tampered);
  assert.ok(secrets.isEncrypted(result), 'GCM auth failure must not yield plaintext');
});

test('tampering with the auth tag is also rejected', () => {
  const { secrets } = freshSecrets(KEY_A);
  const prefix = 'enc:g1:';
  const raw = Buffer.from(secrets.encrypt('hunter2').slice(prefix.length), 'base64');
  raw[12] ^= 0xff; // first byte of the GCM tag
  assert.ok(secrets.isEncrypted(secrets.decrypt(prefix + raw.toString('base64'))));
});
