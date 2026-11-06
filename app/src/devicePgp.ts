import * as openpgp from 'openpgp';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import PostalMime from 'postal-mime';
import { innerEntity, pgpMimeMessage, recipientsOf, addressOf, bytesToBase64, type OutgoingAttachment } from './mime';
import type { PgpStatus } from './types';

/**
 * OpenPGP keys held on this phone.
 *
 * With a key here, the cloud backend never needs one: it hands over the
 * still-encrypted part of a message, and this module decrypts and verifies it
 * on the device. Outgoing encrypted mail is built and encrypted here, and the
 * backend relays the finished bytes.
 *
 * At rest the key stays passphrase-protected (exactly as exported from the
 * desktop's Settings → Encryption → Back up), inside the iOS Keychain or
 * Android Keystore via SecureStore. The unlocked key lives only in this
 * process's memory, until the app is closed or "Lock" is pressed.
 */

const INDEX_KEY = 'hermes-pgp-device-index';
const keyName = (email: string) => `hermes-pgp-device-${bytesToHex(new TextEncoder().encode(email.toLowerCase()))}`;
function bytesToHex(bytes: Uint8Array) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }

const unlocked = new Map<string, openpgp.PrivateKey>();

async function readIndex(): Promise<string[]> {
  try { return JSON.parse((await SecureStore.getItemAsync(INDEX_KEY)) || '[]'); } catch { return []; }
}
async function writeIndex(emails: string[]) {
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...new Set(emails)]));
}

const emailsOf = (key: openpgp.Key) => key.getUserIDs()
  .map(uid => (uid.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] || (uid.includes('@') ? uid : '')).toLowerCase())
  .filter(Boolean);

export interface DeviceKeyInfo { email: string; fingerprint: string; unlocked: boolean }

export async function listDeviceKeys(): Promise<DeviceKeyInfo[]> {
  const out: DeviceKeyInfo[] = [];
  for (const email of await readIndex()) {
    const armored = await SecureStore.getItemAsync(keyName(email));
    if (!armored) continue;
    try {
      const key = await openpgp.readPrivateKey({ armoredKey: armored });
      out.push({ email, fingerprint: key.getFingerprint().toUpperCase(), unlocked: unlocked.has(email) });
    } catch { /* unreadable entry: skipped */ }
  }
  return out;
}

export async function hasDeviceKey(email?: string): Promise<boolean> {
  const index = await readIndex();
  return email ? index.includes(email.toLowerCase()) : index.length > 0;
}

export function isUnlocked(email?: string): boolean {
  return email ? unlocked.has(email.toLowerCase()) : unlocked.size > 0;
}

/**
 * Add a private key. It must be passphrase-protected, as the desktop's
 * backup export is; the passphrase is checked now and the key stays unlocked
 * for this session. Filed under every address its user IDs name.
 */
export async function importDeviceKey(armoredKey: string, passphrase: string): Promise<DeviceKeyInfo[]> {
  let key: openpgp.PrivateKey;
  try { key = await openpgp.readPrivateKey({ armoredKey: armoredKey.trim() }); }
  catch { throw new Error('That is not an OpenPGP private key'); }
  if (key.isDecrypted()) throw new Error('Export the key from the desktop with a passphrase (Settings → Encryption → Back up), then paste that here.');
  let opened: openpgp.PrivateKey;
  try { opened = await openpgp.decryptKey({ privateKey: key, passphrase }); }
  catch { throw new Error('That passphrase does not unlock this key'); }
  const emails = emailsOf(key);
  if (!emails.length) throw new Error('This key has no email address in its user IDs');
  const armored = key.armor();
  for (const email of emails) {
    await SecureStore.setItemAsync(keyName(email), armored);
    unlocked.set(email, opened);
  }
  await writeIndex([...(await readIndex()), ...emails]);
  return listDeviceKeys();
}

export async function removeDeviceKey(email: string) {
  const address = email.toLowerCase();
  await SecureStore.deleteItemAsync(keyName(address));
  unlocked.delete(address);
  await writeIndex((await readIndex()).filter(e => e !== address));
}

/** Unlock every stored key this passphrase opens. */
export async function unlockDeviceKeys(passphrase: string): Promise<string[]> {
  const opened: string[] = [];
  for (const email of await readIndex()) {
    if (unlocked.has(email)) { opened.push(email); continue; }
    const armored = await SecureStore.getItemAsync(keyName(email));
    if (!armored) continue;
    try {
      const key = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: armored }), passphrase });
      unlocked.set(email, key);
      opened.push(email);
    } catch { /* not this key's passphrase */ }
  }
  if (!opened.length) throw new Error('That passphrase does not unlock this key');
  return opened;
}

export function lockDeviceKeys() { unlocked.clear(); }

export class DeviceKeyLockedError extends Error {
  code = 'PGP_DEVICE_LOCKED';
  constructor() { super('Your encryption key on this phone is locked. Enter its passphrase.'); }
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface PublicKeyEntry { email: string; publicKey: string }

async function readPublicKeys(entries: PublicKeyEntry[]): Promise<openpgp.Key[]> {
  const keys: openpgp.Key[] = [];
  for (const armored of new Set(entries.map(e => e.publicKey))) {
    try { keys.push(await openpgp.readKey({ armoredKey: armored })); } catch { /* skip */ }
  }
  // Our own keys verify our own Sent mail.
  for (const key of unlocked.values()) keys.push(key.toPublic());
  return keys;
}

async function evaluateSignatures(signatures: openpgp.VerificationResult[], sender: string, keys: openpgp.Key[]): Promise<Partial<PgpStatus>> {
  if (!signatures?.length) return { signed: false };
  let best: Partial<PgpStatus> | null = null;
  for (const signature of signatures) {
    const key = keys.find(k => k.getKeys(signature.keyID).length > 0);
    if (!key) { best = best || { signed: true, status: 'unknown-key' }; continue; }
    try {
      await signature.verified;
      const fingerprint = key.getFingerprint().toUpperCase();
      const emails = emailsOf(key);
      if (emails.includes(sender)) return { signed: true, status: 'verified', signer: sender, fingerprint };
      best = { signed: true, status: 'mismatch', signer: emails[0] || null, fingerprint };
    } catch {
      best = { signed: true, status: 'bad', fingerprint: key.getFingerprint().toUpperCase() };
    }
  }
  return best || { signed: false };
}

export interface DecryptedAttachment { filename: string; contentType: string; size: number; content: Uint8Array }
export interface DecryptedMessage {
  subject?: string
  text: string
  html: string
  attachments: DecryptedAttachment[]
  pgp: PgpStatus
}

/**
 * Open what the backend's pgp-payload endpoint returned.
 * @throws DeviceKeyLockedError when a stored key would be needed but is locked.
 */
export async function decryptPayload(
  payload: { kind: 'pgp-mime' | 'inline'; armored: string; from: string; text?: string },
  publicKeys: PublicKeyEntry[],
): Promise<DecryptedMessage> {
  if (!unlocked.size) {
    if (await hasDeviceKey()) throw new DeviceKeyLockedError();
    return { text: '', html: '', attachments: [], pgp: { encrypted: true, decrypted: false, error: 'No encryption key on this phone.' } };
  }
  const sender = addressOf(payload.from || '');
  const verificationKeys = await readPublicKeys(publicKeys);
  let result;
  try {
    result = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: payload.armored }),
      decryptionKeys: [...unlocked.values()],
      verificationKeys,
      format: 'binary',
    });
  } catch {
    return { text: '', html: '', attachments: [], pgp: { encrypted: true, decrypted: false, error: 'None of the keys on this phone can open this message.' } };
  }
  const signature = await evaluateSignatures(result.signatures, sender, verificationKeys);
  const data = result.data as Uint8Array;

  if (payload.kind === 'inline') {
    const plain = new TextDecoder().decode(data);
    return {
      text: (payload.text || '').replace(payload.armored, plain) || plain,
      html: '', attachments: [],
      pgp: { encrypted: true, decrypted: true, ...signature } as PgpStatus,
    };
  }

  const parsed = await PostalMime.parse(data);
  const protectedSubject = parsed.headers?.some(h => h.key === 'subject') ? parsed.subject : undefined;
  return {
    ...(protectedSubject !== undefined ? { subject: protectedSubject } : {}),
    text: parsed.text || '',
    html: parsed.html || '',
    attachments: (parsed.attachments || [])
      .filter(a => !/application\/pgp-signature/i.test(a.mimeType || ''))
      .map(a => {
        const content = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content as ArrayBuffer);
        return { filename: a.filename || 'attachment', contentType: a.mimeType || 'application/octet-stream', size: content.length, content };
      }),
    pgp: { encrypted: true, decrypted: true, ...signature } as PgpStatus,
  };
}

// ─── Sending ────────────────────────────────────────────────────────────────

/** Which recipients we could encrypt to with the public keys we know. */
export function deviceReadiness(sender: string, lists: { to?: string; cc?: string; bcc?: string }, publicKeys: PublicKeyEntry[]) {
  const known = new Set(publicKeys.map(k => k.email.toLowerCase()));
  known.add(sender.toLowerCase());
  const recipients = recipientsOf(lists.to, lists.cc, lists.bcc);
  const missing = recipients.filter(r => !known.has(r));
  return { recipients, missing, canEncrypt: recipients.length > 0 && missing.length === 0 };
}

/**
 * Build and encrypt a whole message on the phone, signed with the sender's
 * key and encrypted to every recipient and to the sender (so Sent stays
 * readable). Returns the raw message, base64, for /send-prebuilt.
 */
export async function buildEncryptedMessage(draft: {
  from: { name?: string; address: string }
  to: string; cc?: string; bcc?: string
  subject: string; text: string; html?: string
  attachments?: OutgoingAttachment[]
  inReplyTo?: string; references?: string
}, publicKeys: PublicKeyEntry[]): Promise<string> {
  const sender = draft.from.address.toLowerCase();
  const signingKey = unlocked.get(sender);
  if (!signingKey) throw (await hasDeviceKey(sender)) ? new DeviceKeyLockedError() : new Error(`No encryption key on this phone for ${sender}`);
  const readiness = deviceReadiness(sender, draft, publicKeys);
  if (!readiness.canEncrypt) throw new Error(readiness.missing.length ? `No encryption key for ${readiness.missing.join(', ')}` : 'Add a recipient before encrypting');

  const byEmail = new Map(publicKeys.map(k => [k.email.toLowerCase(), k.publicKey]));
  const encryptionKeys: openpgp.Key[] = [signingKey.toPublic()];
  for (const recipient of readiness.recipients) {
    if (recipient === sender) continue;
    encryptionKeys.push(await openpgp.readKey({ armoredKey: byEmail.get(recipient)! }));
  }

  const inner = innerEntity({ subject: draft.subject, text: draft.text, html: draft.html, attachments: draft.attachments });
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: new TextEncoder().encode(inner) }),
    encryptionKeys,
    signingKeys: signingKey,
  }) as string;
  const domain = sender.split('@')[1] || 'hermes.local';
  const raw = pgpMimeMessage({
    from: draft.from, to: draft.to, cc: draft.cc, bcc: draft.bcc,
    messageId: `<${Crypto.randomUUID()}@${domain}>`,
    inReplyTo: draft.inReplyTo, references: draft.references,
    armored,
  });
  return bytesToBase64(new TextEncoder().encode(raw));
}
