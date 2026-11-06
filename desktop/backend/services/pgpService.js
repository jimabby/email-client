const crypto = require('crypto');
const openpgp = require('openpgp');
const MailComposer = require('nodemailer/lib/mail-composer');
const MimeNode = require('nodemailer/lib/mime-node');
const addressparser = require('nodemailer/lib/addressparser');
const mimeFuncs = require('nodemailer/lib/mime-funcs');
const { simpleParser } = require('mailparser');
const store = require('../store');

/**
 * OpenPGP for Hermes: PGP/MIME (RFC 3156) on the way out, PGP/MIME and inline
 * PGP on the way in.
 *
 * Where the keys live. Identities (your own key pairs) and contacts (other
 * people's public keys) are kept in the sealed state file, encrypted at rest
 * with the same AES-256-GCM key as every other credential. Private keys are
 * stored unlocked so a message can be opened without a passphrase prompt —
 * the protection is the at-rest encryption and the device itself. On the cloud
 * backend that means the server can read your encrypted mail: the server is
 * yours, but it is a server. That trade-off is stated in the UI.
 *
 * What is protected. The body and every attachment. Not the subject, sender,
 * or recipients: those travel in the clear, as with every PGP/MIME client that
 * does not use protected headers.
 *
 * Trust. A signature is "verified" only when it checks out against a key we
 * hold whose user ID names the sender's address. Keys arrive by explicit import
 * or, on first contact, from an Autocrypt header (trust on first use). A later
 * Autocrypt header with a different key never replaces a stored one; it is
 * reported as a key change instead.
 */

const MAX_KEY_BYTES = 64 * 1024;
const MAX_CONTACTS = 5000;

// ─── Key storage ────────────────────────────────────────────────────────────

const parsedKeys = new Map(); // armored text -> openpgp key object

async function parseKey(armored) {
  if (parsedKeys.has(armored)) return parsedKeys.get(armored);
  const key = await openpgp.readKey({ armoredKey: armored });
  if (parsedKeys.size > 2000) parsedKeys.clear();
  parsedKeys.set(armored, key);
  return key;
}

const lower = (value) => String(value || '').trim().toLowerCase();

function emailsOf(key) {
  return key.getUserIDs()
    .map(uid => (uid.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] || (uid.includes('@') ? uid : '')))
    .map(lower)
    .filter(Boolean);
}

function describe(key, extra = {}) {
  return {
    fingerprint: key.getFingerprint().toUpperCase(),
    keyId: key.getKeyID().toHex().toUpperCase(),
    userIds: key.getUserIDs(),
    algorithm: key.getAlgorithmInfo()?.algorithm || null,
    createdAt: key.getCreationTime()?.toISOString?.() || null,
    ...extra,
  };
}

async function listKeys() {
  const { identities, contacts } = store.getPgpKeys();
  const out = { identities: [], contacts: [] };
  for (const [email, entry] of Object.entries(identities)) {
    try {
      out.identities.push({
        email,
        ...describe(await parseKey(entry.publicKey), { addedAt: entry.addedAt, source: entry.source }),
        publicKey: entry.publicKey,
        locked: entry.locked === true,
        unlockedUntil: entry.locked === true ? unlockedUntil(email) : null,
      });
    }
    catch { /* an unreadable entry is skipped, not fatal */ }
  }
  for (const [email, entry] of Object.entries(contacts)) {
    try { out.contacts.push({ email, ...describe(await parseKey(entry.publicKey), { addedAt: entry.addedAt, source: entry.source, keyChanged: entry.keyChanged || null }) }); }
    catch { /* skipped */ }
  }
  out.identities.sort((a, b) => a.email.localeCompare(b.email));
  out.contacts.sort((a, b) => a.email.localeCompare(b.email));
  return out;
}

function ownAddresses() {
  const own = new Set();
  for (const account of store.getAccounts()) {
    if (account.email) own.add(lower(account.email));
    for (const alias of [...(account.aliases || []), ...store.getAliases(account.id)]) if (alias?.email) own.add(lower(alias.email));
  }
  return own;
}

/** Make a new key pair for one of the user's own addresses. */
async function generateIdentity({ email, name }) {
  const address = lower(email);
  if (!ownAddresses().has(address)) throw new Error('Keys can only be made for one of your own addresses');
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ name: String(name || '').slice(0, 120) || undefined, email: address }],
    format: 'armored',
  });
  const keys = store.getPgpKeys();
  keys.identities[address] = { privateKey, publicKey, addedAt: new Date().toISOString(), source: 'generated' };
  store.savePgpKeys(keys);
  unlocked.delete(address);
  return describe(await parseKey(publicKey), { email: address, publicKey });
}

/** Bring in an existing private key (unlocked once with its passphrase). */
async function importIdentity({ email, armoredKey, passphrase }) {
  const address = lower(email);
  if (!ownAddresses().has(address)) throw new Error('Keys can only be imported for one of your own addresses');
  if (!armoredKey || String(armoredKey).length > MAX_KEY_BYTES) throw new Error('Paste an armored private key');
  let key = await openpgp.readPrivateKey({ armoredKey: String(armoredKey) });
  if (!key.isDecrypted()) {
    if (!passphrase) throw new Error('This key is protected; enter its passphrase');
    try { key = await openpgp.decryptKey({ privateKey: key, passphrase: String(passphrase) }); }
    catch { throw new Error('That passphrase does not unlock this key'); }
  }
  if (!emailsOf(key).includes(address)) throw new Error(`This key has no user ID for ${address}`);
  const publicKey = key.toPublic().armor();
  const keys = store.getPgpKeys();
  keys.identities[address] = { privateKey: key.armor(), publicKey, addedAt: new Date().toISOString(), source: 'imported' };
  store.savePgpKeys(keys);
  unlocked.delete(address);
  return describe(key, { email: address, publicKey });
}

/**
 * A passphrase-protected copy of a private key, for backup or for use in
 * another OpenPGP client. A key made here exists nowhere else; losing it
 * means losing every message encrypted to it.
 */
async function exportIdentity(email, passphrase) {
  const entry = store.getPgpKeys().identities[lower(email)];
  if (!entry) throw new Error('No key for that address');
  if (String(passphrase || '').length < 8) throw new Error('Choose a passphrase of at least 8 characters');
  const key = await usablePrivateKey(lower(email));
  const locked = await openpgp.encryptKey({ privateKey: key, passphrase: String(passphrase) });
  return locked.armor();
}

function removeIdentity(email) {
  const keys = store.getPgpKeys();
  delete keys.identities[lower(email)];
  unlocked.delete(lower(email));
  store.savePgpKeys(keys);
}

// ─── Passphrase-locked keys ────────────────────────────────────────────────
//
// By default a private key is stored unlocked (inside the sealed state file)
// so mail opens without a prompt. "Require passphrase" changes what is stored:
// the key itself is then passphrase-encrypted, so a copy of the data
// directory, a backup, or a stolen disk is useless for reading mail even with
// the sealing key. Unlocking holds the decrypted key in this process's memory
// for a while; a restart, "Lock now", or the timeout forgets it.
//
// What it does not change: while unlocked, this server can read your mail.

const DEFAULT_UNLOCK_HOURS = 8;
const MAX_UNLOCK_HOURS = 72;
const unlocked = new Map(); // address -> { key, until }

function unlockedUntil(address) {
  const entry = unlocked.get(address);
  if (!entry) return null;
  if (entry.until <= Date.now()) { unlocked.delete(address); return null; }
  return new Date(entry.until).toISOString();
}

function lockedError(address) {
  const error = new Error(`Your OpenPGP key for ${address} is locked. Unlock it with its passphrase first.`);
  error.code = 'PGP_LOCKED';
  error.address = address;
  return error;
}

/** The decrypted private key for an identity, or PGP_LOCKED. */
async function usablePrivateKey(address) {
  const entry = store.getPgpKeys().identities[address];
  if (!entry) throw new Error('No key for that address');
  if (entry.locked !== true) return openpgp.readPrivateKey({ armoredKey: entry.privateKey });
  if (!unlockedUntil(address)) throw lockedError(address);
  return unlocked.get(address).key;
}

function isLocked(address) {
  const entry = store.getPgpKeys().identities[lower(address)];
  return !!entry && entry.locked === true && !unlockedUntil(lower(address));
}

/** Start requiring a passphrase. The key stays unlocked for this session. */
async function requirePassphrase(email, passphrase, { hours = DEFAULT_UNLOCK_HOURS } = {}) {
  const address = lower(email);
  if (String(passphrase || '').length < 8) throw new Error('Choose a passphrase of at least 8 characters');
  const keys = store.getPgpKeys();
  const entry = keys.identities[address];
  if (!entry) throw new Error('No key for that address');
  if (entry.locked === true) throw new Error('This key already requires a passphrase');
  const key = await openpgp.readPrivateKey({ armoredKey: entry.privateKey });
  const protectedKey = await openpgp.encryptKey({ privateKey: key, passphrase: String(passphrase) });
  keys.identities[address] = { ...entry, privateKey: protectedKey.armor(), locked: true };
  store.savePgpKeys(keys);
  unlocked.set(address, { key, until: Date.now() + clampHours(hours) * 3600_000 });
  return { locked: true, unlockedUntil: unlockedUntil(address) };
}

/** Stop requiring a passphrase: store the key unlocked again. */
async function removePassphrase(email, passphrase) {
  const address = lower(email);
  const keys = store.getPgpKeys();
  const entry = keys.identities[address];
  if (!entry || entry.locked !== true) throw new Error('This key does not require a passphrase');
  const key = await decryptStored(entry, passphrase);
  keys.identities[address] = { ...entry, privateKey: key.armor(), locked: false };
  store.savePgpKeys(keys);
  unlocked.delete(address);
  return { locked: false };
}

async function decryptStored(entry, passphrase) {
  const stored = await openpgp.readPrivateKey({ armoredKey: entry.privateKey });
  try { return await openpgp.decryptKey({ privateKey: stored, passphrase: String(passphrase || '') }); }
  catch { throw Object.assign(new Error('That passphrase does not unlock this key'), { code: 'PGP_BAD_PASSPHRASE' }); }
}

function clampHours(hours) {
  const value = Number(hours);
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_UNLOCK_HOURS) : DEFAULT_UNLOCK_HOURS;
}

/** Unlock for a while. Without an address, every locked key the passphrase opens. */
async function unlockIdentity({ email, passphrase, hours = DEFAULT_UNLOCK_HOURS }) {
  const { identities } = store.getPgpKeys();
  const targets = email ? [lower(email)] : Object.keys(identities).filter(a => identities[a].locked === true);
  const opened = [];
  let lastError = null;
  for (const address of targets) {
    const entry = identities[address];
    if (!entry) { lastError = new Error('No key for that address'); continue; }
    if (entry.locked !== true) continue;
    try {
      const key = await decryptStored(entry, passphrase);
      unlocked.set(address, { key, until: Date.now() + clampHours(hours) * 3600_000 });
      opened.push({ email: address, unlockedUntil: unlockedUntil(address) });
    } catch (err) { lastError = err; }
  }
  if (!opened.length) throw lastError || new Error('No locked key to unlock');
  return { unlocked: opened };
}

/** Forget unlocked keys now (one address, or all). */
function lockNow(email) {
  if (email) unlocked.delete(lower(email));
  else unlocked.clear();
  return { locked: true };
}

/**
 * Import one or more public keys (an armored block may hold several). Each is
 * filed under every address its user IDs name. A private key pasted here by
 * mistake is reduced to its public half — the secret is never kept.
 */
async function importContactKeys(armored, { source = 'manual' } = {}) {
  const text = String(armored || '');
  if (!text.trim() || text.length > MAX_KEY_BYTES * 4) throw new Error('Paste an armored public key');
  let found;
  try { found = await openpgp.readKeys({ armoredKeys: text }); }
  catch { throw new Error('That is not an OpenPGP public key'); }
  const keys = store.getPgpKeys();
  const imported = [];
  for (const key of found) {
    const publicKey = (key.isPrivate() ? key.toPublic() : key).armor();
    for (const email of emailsOf(key)) {
      if (!keys.contacts[email] && Object.keys(keys.contacts).length >= MAX_CONTACTS) throw new Error('Too many contact keys');
      keys.contacts[email] = { publicKey, addedAt: new Date().toISOString(), source };
      imported.push({ email, fingerprint: key.getFingerprint().toUpperCase() });
    }
  }
  if (!imported.length) throw new Error('That key has no email address in its user IDs');
  store.savePgpKeys(keys);
  return imported;
}

function removeContact(email) {
  const keys = store.getPgpKeys();
  delete keys.contacts[lower(email)];
  store.savePgpKeys(keys);
}

function publicKeyFor(email) {
  const { identities, contacts } = store.getPgpKeys();
  const address = lower(email);
  return identities[address]?.publicKey || contacts[address]?.publicKey || null;
}

/** For the composer: which recipients we could encrypt to, and who is missing. */
function readiness({ from, to, cc, bcc }) {
  const { identities } = store.getPgpKeys();
  const sender = lower(from);
  const recipients = recipientsOf({ to, cc, bcc });
  const missing = recipients.filter(r => !publicKeyFor(r));
  return {
    canSign: !!identities[sender],
    canEncrypt: !!identities[sender] && recipients.length > 0 && missing.length === 0,
    missing,
    // The key exists but needs its passphrase before it can sign or encrypt.
    locked: isLocked(sender),
  };
}

// ─── Sending ────────────────────────────────────────────────────────────────

function recipientsOf({ to, cc, bcc }) {
  const all = [];
  const walk = (list) => {
    for (const entry of list) {
      if (entry.group) walk(entry.group);
      else if (entry.address) all.push(lower(entry.address));
    }
  };
  for (const field of [to, cc, bcc]) if (field) walk(addressparser(String(field)));
  return [...new Set(all)];
}

function resolveFrom(account, sendAs) {
  const wanted = lower(sendAs?.email);
  if (wanted && wanted !== lower(account.email)) {
    const alias = [...(account.aliases || []), ...store.getAliases(account.id)].find(a => lower(a.email) === wanted);
    if (alias) return { name: alias.name || account.name || alias.email, address: alias.email };
  }
  return { name: account.name || account.email, address: account.email };
}

const build = (node) => new Promise((resolve, reject) => node.build((err, out) => (err ? reject(err) : resolve(out))));

/** The body and attachments as one MIME entity, without message headers. */
// RFC 9788 header protection: the real subject travels inside the encrypted
// part; the outer header, which every relay and the provider can read, says
// only this.
const OBSCURED_SUBJECT = '[...]';

async function innerEntity({ text, html, attachments, subject }, { protectSubject = false } = {}) {
  const node = new MailComposer({
    // RFC 3156 §3: signed data must survive transport unchanged. Quoted-
    // printable protects trailing whitespace and long lines, which relays
    // otherwise strip or rewrap, breaking the signature.
    textEncoding: 'quoted-printable',
    text: text || undefined,
    html: html || undefined,
    attachments: (attachments || []).map(a => ({
      filename: a.filename,
      content: Buffer.from(a.content || '', 'base64'),
      contentType: a.contentType,
    })),
  }).compile();
  const raw = (await build(node)).toString('binary');
  const split = raw.indexOf('\r\n\r\n');
  const headerLines = raw.slice(0, split).split(/\r\n(?![ \t])/);
  // Message-level headers belong on the outer message; what is signed or
  // encrypted is the entity itself.
  let kept = headerLines.filter(line => !/^(message-id|date|mime-version):/i.test(line));
  if (protectSubject) {
    kept = kept.map(line => (/^content-type:/i.test(line) ? `${line}; protected-headers="v1"` : line));
    kept.push(mimeFuncs.foldLines(`Subject: ${mimeFuncs.encodeWords(String(subject || ''), 'Q', 52)}`, 76).replace(/\r?\n$/, ''));
  }
  // nodemailer leaves bare LFs inside 7bit parts. On the wire they become
  // CRLF, so the bytes we sign must already be CRLF or nothing verifies.
  const entity = `${kept.join('\r\n')}\r\n\r\n${raw.slice(split + 4)}`.replace(/\r?\n/g, '\r\n');
  return Buffer.from(entity, 'binary');
}

function autocryptHeader(address, publicKeyArmored) {
  return parseKey(publicKeyArmored).then(key => {
    const keydata = Buffer.from(key.write()).toString('base64');
    const folded = keydata.match(/.{1,76}/g).join('\r\n ');
    return `addr=${address}; keydata=\r\n ${folded}`;
  });
}

/**
 * Build a PGP/MIME message.
 * @returns {{ raw: Buffer, rawForSmtp: Buffer, envelope: {from: string, to: string[]}, messageId: string }}
 *   `raw` keeps Bcc (Gmail and Graph read it to deliver); `rawForSmtp` drops it
 *   because SMTP takes recipients from the envelope and would otherwise show
 *   Bcc to everyone.
 */
async function protect(account, email, { encrypt = false, sign = false, selfOnly = false } = {}) {
  if (!encrypt && !sign) throw new Error('Nothing to protect');
  const from = resolveFrom(account, email.sendAs);
  const sender = lower(from.address);
  const { identities } = store.getPgpKeys();
  const identity = identities[sender];
  if (!identity) {
    const error = new Error(`You have no OpenPGP key for ${sender}. Create or import one in Settings → Encryption.`);
    error.code = 'PGP_NO_IDENTITY';
    throw error;
  }
  const privateKey = await usablePrivateKey(sender);

  // Encrypted mail hides its subject; a signed-only message has nothing to hide.
  const inner = await innerEntity(email, { protectSubject: encrypt });
  let root;
  if (encrypt) {
    // A draft is encrypted to its author alone: nobody else should read it
    // yet, and it must save before every recipient's key is known.
    const recipients = selfOnly ? [] : recipientsOf(email);
    const missing = recipients.filter(r => !publicKeyFor(r));
    if (!recipients.length && !selfOnly) throw new Error('Add a recipient before encrypting');
    if (missing.length) {
      const error = new Error(`No OpenPGP key for ${missing.join(', ')}. Import their public key, or send without encryption.`);
      error.code = 'PGP_MISSING_KEYS';
      error.missing = missing;
      throw error;
    }
    // Encrypt to ourselves too, so the Sent copy stays readable.
    const encryptionKeys = await Promise.all([...new Set([...recipients.map(publicKeyFor), identity.publicKey])].map(parseKey));
    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ binary: inner }),
      encryptionKeys,
      signingKeys: sign ? privateKey : undefined,
      format: 'armored',
    });
    root = new MimeNode('multipart/encrypted; protocol="application/pgp-encrypted"');
    const version = root.createChild('application/pgp-encrypted');
    version.setHeader('Content-Description', 'PGP/MIME version identification');
    version.setHeader('Content-Transfer-Encoding', '7bit');
    version.setContent('Version: 1\r\n');
    const payload = root.createChild('application/octet-stream; name="encrypted.asc"');
    payload.setHeader('Content-Description', 'OpenPGP encrypted message');
    payload.setHeader('Content-Disposition', 'inline; filename="encrypted.asc"');
    payload.setHeader('Content-Transfer-Encoding', '7bit');
    payload.setContent(armored.replace(/\r?\n/g, '\r\n'));
  } else {
    const signature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: inner }),
      signingKeys: privateKey,
      detached: true,
      format: 'armored',
    });
    root = new MimeNode('multipart/signed; micalg=pgp-sha512; protocol="application/pgp-signature"');
    // Emitted byte for byte: the signature covers exactly these bytes.
    root.createChild(false).setRaw(inner);
    const sig = root.createChild('application/pgp-signature; name="signature.asc"');
    sig.setHeader('Content-Description', 'OpenPGP digital signature');
    sig.setHeader('Content-Disposition', 'attachment; filename="signature.asc"');
    sig.setHeader('Content-Transfer-Encoding', '7bit');
    sig.setContent(signature.replace(/\r?\n/g, '\r\n'));
  }

  const domain = String(account.email || '').split('@')[1] || 'hermes.local';
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const replyRefs = [email.references, email.inReplyTo].filter(Boolean).join(' ');
  root.setHeader('From', [from]);
  if (email.to) root.setHeader('To', email.to);
  if (email.cc) root.setHeader('Cc', email.cc);
  if (email.bcc) root.setHeader('Bcc', email.bcc);
  root.setHeader('Subject', encrypt ? OBSCURED_SUBJECT : (email.subject || ''));
  root.setHeader('Date', new Date());
  root.setHeader('Message-ID', messageId);
  if (email.inReplyTo) root.setHeader('In-Reply-To', email.inReplyTo);
  if (replyRefs) root.setHeader('References', replyRefs);
  if (email.autoSubmitted) root.setHeader('Auto-Submitted', email.autoSubmitted);
  root.setHeader({ key: 'Autocrypt', value: await autocryptHeader(sender, identity.publicKey), prepared: true });

  root.keepBcc = true;
  const raw = await build(root);
  root.keepBcc = false;
  const rawForSmtp = await build(root);
  return { raw, rawForSmtp, envelope: root.getEnvelope(), messageId };
}

// ─── Reading ────────────────────────────────────────────────────────────────

const ARMORED_MESSAGE = /-----BEGIN PGP MESSAGE-----[\s\S]+?-----END PGP MESSAGE-----/;
const CLEARSIGNED = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]+?-----END PGP SIGNATURE-----/;

/** Cheap test on an already-fetched body: is opening the raw message worth it? */
function looksProtected(body) {
  if (!body) return false;
  const types = (body.attachments || []).map(a => `${lower(a.contentType)} ${lower(a.filename)}`);
  if (types.some(t => /application\/pgp-(encrypted|signature)|\bencrypted\.asc\b|\bsignature\.asc\b/.test(t))) return true;
  const text = String(body.text || '');
  return ARMORED_MESSAGE.test(text) || CLEARSIGNED.test(text);
}

function splitHeaderBody(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('binary') : String(raw);
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return { headers: text, body: '' };
  return { headers: text.slice(0, match.index), body: text.slice(match.index + match[0].length) };
}

function headerValue(headers, name) {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  const match = unfolded.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'));
  return match ? match[1].trim() : '';
}

function paramOf(value, name) {
  const match = String(value).match(new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i'));
  return match ? (match[1] ?? match[2]) : '';
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The raw bytes of each body part of a multipart entity, exactly as sent. */
function partsOf(body, boundary) {
  const pieces = (`\r\n${body}`).split(new RegExp(`\\r?\\n--${escapeRegExp(boundary)}`));
  const parts = [];
  for (const piece of pieces.slice(1)) {
    if (piece.startsWith('--')) break;
    parts.push(piece.replace(/^[ \t]*\r?\n/, ''));
  }
  return parts;
}

function decodePart(part) {
  const { headers, body } = splitHeaderBody(part);
  const encoding = lower(headerValue(headers, 'content-transfer-encoding'));
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (encoding === 'quoted-printable') {
    return Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'binary').toString('utf8');
  }
  return Buffer.from(body, 'binary').toString('utf8');
}

async function verificationKeys() {
  const { identities, contacts } = store.getPgpKeys();
  const armored = [...Object.values(identities), ...Object.values(contacts)].map(e => e.publicKey);
  const keys = [];
  for (const text of new Set(armored)) {
    try { keys.push(await parseKey(text)); } catch { /* skip unreadable */ }
  }
  return keys;
}

/** Every private key usable right now, and how many are locked away. */
async function decryptionKeys() {
  const { identities } = store.getPgpKeys();
  const keys = [];
  let locked = 0;
  for (const address of Object.keys(identities)) {
    try { keys.push(await usablePrivateKey(address)); }
    catch (err) { if (err.code === 'PGP_LOCKED') locked++; }
  }
  return Object.assign(keys, { locked });
}

/**
 * What a set of signatures says about this message.
 * @returns {{ signed: boolean, status?: 'verified'|'mismatch'|'unknown-key'|'bad', signer?: string, fingerprint?: string }}
 */
async function evaluateSignatures(signatures, senderAddress, keys) {
  if (!signatures?.length) return { signed: false };
  let best = null;
  for (const signature of signatures) {
    const key = keys.find(k => k.getKeys(signature.keyID).length > 0);
    if (!key) { best = best || { signed: true, status: 'unknown-key', keyId: signature.keyID.toHex().toUpperCase() }; continue; }
    try {
      await signature.verified;
      const fingerprint = key.getFingerprint().toUpperCase();
      const emails = emailsOf(key);
      const result = emails.includes(lower(senderAddress))
        ? { signed: true, status: 'verified', signer: lower(senderAddress), fingerprint }
        : { signed: true, status: 'mismatch', signer: emails[0] || null, fingerprint };
      if (result.status === 'verified') return result;
      best = result;
    } catch {
      best = { signed: true, status: 'bad', fingerprint: key.getFingerprint().toUpperCase() };
    }
  }
  return best;
}

/** Learn a correspondent's key from an Autocrypt header (trust on first use). */
async function learnAutocrypt(headers, senderAddress) {
  const value = headerValue(headers, 'autocrypt');
  if (!value) return null;
  const addr = lower(value.match(/(?:^|;)\s*addr=([^;\s]+)/i)?.[1]);
  const keydata = value.match(/(?:^|;)\s*keydata=([A-Za-z0-9+/=\s]+)/i)?.[1];
  if (!addr || addr !== lower(senderAddress) || !keydata || ownAddresses().has(addr)) return null;
  try {
    const key = await openpgp.readKey({ binaryKey: Buffer.from(keydata.replace(/\s+/g, ''), 'base64') });
    if (!emailsOf(key).includes(addr)) return null;
    const keys = store.getPgpKeys();
    const existing = keys.contacts[addr];
    const armored = key.armor();
    if (!existing) {
      if (Object.keys(keys.contacts).length >= MAX_CONTACTS) return null;
      keys.contacts[addr] = { publicKey: armored, addedAt: new Date().toISOString(), source: 'autocrypt' };
      store.savePgpKeys(keys);
      return { learned: addr };
    }
    const known = await parseKey(existing.publicKey);
    if (known.getFingerprint() !== key.getFingerprint()) {
      keys.contacts[addr] = { ...existing, keyChanged: { fingerprint: key.getFingerprint().toUpperCase(), seenAt: new Date().toISOString() } };
      store.savePgpKeys(keys);
      return { changed: addr };
    }
  } catch { /* a malformed header is ignored */ }
  return null;
}

async function bodyFromEntity(entity) {
  const parsed = await simpleParser(Buffer.isBuffer(entity) ? entity : Buffer.from(entity, 'binary'));
  const attachments = (parsed.attachments || [])
    .filter(a => !/application\/pgp-signature/i.test(a.contentType || ''))
    .map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size, content: a.content }));
  // A Subject inside the protected entity (RFC 9788) is the real one.
  const subject = parsed.headers?.has('subject') ? (parsed.subject || '') : null;
  return { text: parsed.text || '', html: parsed.html || parsed.textAsHtml || '', attachments, ...(subject !== null ? { subject } : {}) };
}

/**
 * Decrypt and/or verify a raw message.
 * @returns {Promise<null | { text, html, attachments, pgp }>} null when the
 *   message carries no OpenPGP protection; otherwise the readable content and
 *   a status object. Attachments carry their decrypted bytes.
 */
async function open(raw, { from = '', fallbackText = '' } = {}) {
  const { headers, body } = splitHeaderBody(raw);
  const contentType = headerValue(headers, 'content-type');
  const sender = addressparser(from || headerValue(headers, 'from'))[0]?.address || '';
  const learned = await learnAutocrypt(headers, sender);
  const keys = await verificationKeys();

  const base = lower(contentType.split(';')[0]);
  const boundary = paramOf(contentType, 'boundary');

  if (base === 'multipart/encrypted' && /pgp-encrypted/i.test(paramOf(contentType, 'protocol')) && boundary) {
    const parts = partsOf(body, boundary);
    const armored = parts[1] ? decodePart(parts[1]) : '';
    return { ...(await decryptArmored(armored, sender, keys)), ...(learned ? { learned } : {}) };
  }

  if (base === 'multipart/signed' && /pgp-signature/i.test(paramOf(contentType, 'protocol')) && boundary) {
    const parts = partsOf(body, boundary);
    if (parts.length < 2) return null;
    // RFC 3156: the signed data is the first part with CRLF line endings.
    const signed = Buffer.from(parts[0].replace(/\r?\n/g, '\r\n'), 'binary');
    let signature;
    try {
      const result = await openpgp.verify({
        message: await openpgp.createMessage({ binary: signed }),
        signature: await openpgp.readSignature({ armoredSignature: decodePart(parts[1]) }),
        verificationKeys: keys,
        expectSigned: false,
      });
      signature = await evaluateSignatures(result.signatures, sender, keys);
    } catch (err) {
      signature = { signed: true, status: 'bad', error: err.message };
    }
    const content = await bodyFromEntity(signed);
    return { ...content, pgp: { encrypted: false, ...signature, ...(learned ? { learned } : {}) } };
  }

  // Inline PGP, as older clients and some webmail send it.
  const parsed = await simpleParser(Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'binary'));
  const text = parsed.text || fallbackText || '';
  const inline = text.match(ARMORED_MESSAGE);
  if (inline) {
    const result = await decryptArmored(inline[0], sender, keys, { inline: true });
    if (result.pgp.error) return result;
    const replaced = text.replace(inline[0], result.text);
    return { ...result, text: replaced, html: '', attachments: result.attachments };
  }
  const clear = text.match(CLEARSIGNED);
  if (clear) {
    try {
      const message = await openpgp.readCleartextMessage({ cleartextMessage: clear[0] });
      const result = await openpgp.verify({ message, verificationKeys: keys, expectSigned: false });
      const signature = await evaluateSignatures(result.signatures, sender, keys);
      return { text: text.replace(clear[0], message.getText()), html: '', attachments: [], pgp: { encrypted: false, ...signature } };
    } catch (err) {
      return { text, html: '', attachments: [], pgp: { encrypted: false, signed: true, status: 'bad', error: err.message } };
    }
  }
  return null;
}

async function decryptArmored(armored, sender, keys, { inline = false } = {}) {
  const privateKeys = await decryptionKeys();
  const lockedResult = () => ({ text: '', html: '', attachments: [], pgp: { encrypted: true, decrypted: false, locked: true, error: 'Your OpenPGP key is locked. Unlock it with its passphrase to read this message.' } });
  if (!privateKeys.length) {
    if (privateKeys.locked) return lockedResult();
    return { text: '', html: '', attachments: [], pgp: { encrypted: true, decrypted: false, error: 'This message is encrypted, and you have no OpenPGP key here to open it. Import your key in Settings → Encryption.' } };
  }
  try {
    const message = await openpgp.readMessage({ armoredMessage: armored });
    const result = await openpgp.decrypt({
      message,
      decryptionKeys: privateKeys,
      verificationKeys: keys,
      expectSigned: false,
      format: 'binary',
    });
    const data = Buffer.from(result.data);
    let signature = await evaluateSignatures(result.signatures, sender, keys);
    let content;
    if (inline) {
      content = { text: data.toString('utf8'), html: '', attachments: [] };
    } else {
      // The decrypted entity may itself be multipart/signed (sign-then-encrypt
      // as two steps, the way some clients do it).
      const nested = splitHeaderBody(data);
      const nestedType = headerValue(nested.headers, 'content-type');
      if (/^multipart\/signed/i.test(nestedType) && /pgp-signature/i.test(paramOf(nestedType, 'protocol'))) {
        const inner = await open(data, { from: sender });
        if (inner) { content = inner; if (!signature.signed && inner.pgp?.signed) signature = { signed: true, status: inner.pgp.status, signer: inner.pgp.signer, fingerprint: inner.pgp.fingerprint }; }
      }
      content = content ? { text: content.text, html: content.html, attachments: content.attachments, ...(content.subject !== undefined ? { subject: content.subject } : {}) } : await bodyFromEntity(data);
    }
    return { ...content, pgp: { encrypted: true, decrypted: true, ...signature } };
  } catch (err) {
    const noKey = /decryption key|session key|no.*key/i.test(err.message);
    // The unlocked keys could not open it, but a locked one might.
    if (noKey && privateKeys.locked) return lockedResult();
    return { text: '', html: '', attachments: [], pgp: { encrypted: true, decrypted: false, error: noKey ? 'None of your OpenPGP keys can open this message.' : `Could not decrypt: ${err.message}` } };
  }
}

// ─── Keys held on a device ──────────────────────────────────────────────────
//
// A client may keep its private key to itself (the phone, talking to a cloud
// backend it does not want reading its mail). The backend then never decrypts:
// it hands over the still-encrypted part of a message, the public keys it
// knows, and relays messages the client encrypted itself.

/**
 * The encrypted part of a raw message, untouched, for a client to open.
 * @returns {Promise<null | { kind: 'pgp-mime' | 'inline', armored: string, from: string, text?: string }>}
 */
async function encryptedPayload(raw) {
  const { headers, body } = splitHeaderBody(raw);
  const from = headerValue(headers, 'from');
  const contentType = headerValue(headers, 'content-type');
  const base = lower(contentType.split(';')[0]);
  const boundary = paramOf(contentType, 'boundary');
  if (base === 'multipart/encrypted' && /pgp-encrypted/i.test(paramOf(contentType, 'protocol')) && boundary) {
    const parts = partsOf(body, boundary);
    const armored = parts[1] ? decodePart(parts[1]) : '';
    return ARMORED_MESSAGE.test(armored) ? { kind: 'pgp-mime', armored: armored.match(ARMORED_MESSAGE)[0], from } : null;
  }
  const parsed = await simpleParser(Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'binary'));
  const text = parsed.text || '';
  const inline = text.match(ARMORED_MESSAGE);
  return inline ? { kind: 'inline', armored: inline[0], from, text } : null;
}

/** Every public key this backend knows: correspondents' and your own. */
function publicKeys() {
  const { identities, contacts } = store.getPgpKeys();
  return [
    ...Object.entries(contacts).map(([email, entry]) => ({ email, publicKey: entry.publicKey, source: entry.source || 'manual' })),
    ...Object.entries(identities).map(([email, entry]) => ({ email, publicKey: entry.publicKey, source: 'identity' })),
  ];
}

/**
 * Read the envelope of a message a client built and encrypted itself.
 * The body is opaque to the backend; only these headers matter for delivery.
 * @returns {{ raw: Buffer, rawForSmtp: Buffer, envelope: { from: string, to: string[] }, to: string, cc: string, bcc: string, from: string, encrypted: boolean }}
 */
function readPrebuilt(raw) {
  const { headers } = splitHeaderBody(raw);
  const from = addressparser(headerValue(headers, 'from'))[0]?.address || '';
  const to = headerValue(headers, 'to');
  const cc = headerValue(headers, 'cc');
  const bcc = headerValue(headers, 'bcc');
  const recipients = recipientsOf({ to, cc, bcc });
  // SMTP takes recipients from the envelope; the Bcc header must not travel.
  const text = raw.toString('binary');
  const split = /\r?\n\r?\n/.exec(text);
  const head = split ? text.slice(0, split.index) : text;
  const rest = split ? text.slice(split.index) : '';
  const withoutBcc = head.split(/\r?\n(?![ \t])/).filter(line => !/^bcc:/i.test(line)).join('\r\n');
  const contentType = headerValue(headers, 'content-type');
  return {
    raw,
    rawForSmtp: Buffer.from(withoutBcc + rest, 'binary'),
    envelope: { from: lower(from), to: recipients },
    from: lower(from), to, cc, bcc,
    encrypted: /^multipart\/encrypted/i.test(contentType),
  };
}

module.exports = {
  encryptedPayload,
  publicKeys,
  readPrebuilt,
  listKeys,
  generateIdentity,
  importIdentity,
  exportIdentity,
  removeIdentity,
  requirePassphrase,
  removePassphrase,
  unlockIdentity,
  lockNow,
  isLocked,
  importContactKeys,
  removeContact,
  publicKeyFor,
  readiness,
  protect,
  looksProtected,
  open,
  _internals: { partsOf, splitHeaderBody, headerValue, paramOf, recipientsOf, innerEntity, parsedKeys, unlocked },
};
