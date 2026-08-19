const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Credentials (IMAP passwords, OAuth refresh tokens, MSAL caches, AI API keys)
// must never sit on disk in cleartext. Values are stored as "enc:v1:<base64>"
// and decrypted back into memory on load, so the rest of the codebase keeps
// working with plain strings.
//
// Two backends, picked automatically:
//   1. Electron safeStorage  — OS keychain (DPAPI / Keychain / libsecret).
//   2. AES-256-GCM           — key from HERMES_SECRET_KEY, or a 0600 key file
//                              beside the data dir. Used by the Docker deploy
//                              and by `npm run dev` outside Electron.

const PREFIX = 'enc:v1:';
const GCM_PREFIX = 'enc:g1:';

let safeStorage = null;
try {
  // Only resolvable inside the Electron main process.
  ({ safeStorage } = require('electron'));
} catch { /* plain Node — fall through to AES */ }

function safeStorageUsable() {
  try {
    return !!safeStorage && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

let cachedKey = null;

function keyFilePath() {
  const dir = process.env.HERMES_DATA_DIR || __dirname;
  return path.join(dir, 'secret.key');
}

// A 32-byte key, from the environment or a file created on first use.
function getAesKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.HERMES_SECRET_KEY;
  if (fromEnv && fromEnv.trim()) {
    // Accept hex, base64, or a passphrase — normalise everything to 32 bytes.
    const raw = /^[0-9a-f]{64}$/i.test(fromEnv.trim())
      ? Buffer.from(fromEnv.trim(), 'hex')
      : crypto.createHash('sha256').update(fromEnv.trim()).digest();
    cachedKey = raw;
    return cachedKey;
  }

  const file = keyFilePath();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(raw)) {
        cachedKey = Buffer.from(raw, 'hex');
        return cachedKey;
      }
    }
  } catch (e) {
    console.error('[secrets] Could not read key file:', e.message);
  }

  const generated = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated.toString('hex'), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows ignores modes */ }
  } catch (e) {
    console.error('[secrets] Could not persist key file, secrets will not survive restart:', e.message);
  }
  cachedKey = generated;
  return cachedKey;
}

function aesEncrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getAesKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return GCM_PREFIX + Buffer.concat([iv, tag, body]).toString('base64');
}

function aesDecrypt(value) {
  const raw = Buffer.from(value.slice(GCM_PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getAesKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function isEncrypted(value) {
  return typeof value === 'string' && (value.startsWith(PREFIX) || value.startsWith(GCM_PREFIX));
}

function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already sealed
  try {
    if (safeStorageUsable()) {
      return PREFIX + safeStorage.encryptString(plaintext).toString('base64');
    }
    return aesEncrypt(plaintext);
  } catch (e) {
    console.error('[secrets] Encryption failed, storing value as-is:', e.message);
    return plaintext;
  }
}

let warnedAboutKey = false;

function warnUnreadable(reason) {
  if (warnedAboutKey) return;
  warnedAboutKey = true;
  console.error(
    `[secrets] Stored credentials could not be decrypted (${reason}). This happens when the ` +
    'encryption key changes — for example HERMES_SECRET_KEY was set, removed, or altered, or the ' +
    'data directory was moved to a machine with a different keychain. The sealed values are left ' +
    'untouched on disk, so restoring the original key recovers them; otherwise re-enter the ' +
    'affected passwords and API keys.'
  );
}

// On failure the *sealed* value is returned unchanged rather than an empty
// string. openObject/sealObject then round-trip it verbatim, so a wrong key
// can never cause the real credential to be overwritten with a blank.
function decrypt(value) {
  if (!isEncrypted(value)) return value;
  try {
    if (value.startsWith(PREFIX)) {
      if (!safeStorageUsable()) {
        // Written by the packaged app, now opened without a keychain.
        warnUnreadable('OS keychain unavailable');
        return value;
      }
      return safeStorage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'));
    }
    return aesDecrypt(value);
  } catch (e) {
    warnUnreadable(e.message);
    return value;
  }
}

/** True when a value came back from decrypt() still sealed, i.e. unreadable. */
function isUnreadable(value) {
  return isEncrypted(value);
}

// Field names whose values are sealed before hitting disk.
const SECRET_FIELDS = ['password', 'accessToken', 'refreshToken', 'msalTokenCache', 'apiKey', 'smtpPassword'];

function sealObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_FIELDS.includes(key) && typeof value === 'string') out[key] = encrypt(value);
    else if (value && typeof value === 'object') out[key] = sealObject(value);
    else out[key] = value;
  }
  return out;
}

function openObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_FIELDS.includes(key) && isEncrypted(value)) out[key] = decrypt(value);
    else if (value && typeof value === 'object') out[key] = openObject(value);
    else out[key] = value;
  }
  return out;
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  isUnreadable,
  sealObject,
  openObject,
  backend: () => (safeStorageUsable() ? 'os-keychain' : 'aes-256-gcm'),
  SECRET_FIELDS,
};
