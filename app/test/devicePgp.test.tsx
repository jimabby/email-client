/// <reference types="jest" />
// SecureStore as an in-memory keychain; expo-crypto on Node's CSPRNG.
const mockKeychain = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockKeychain.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockKeychain.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockKeychain.delete(k); }),
}));
jest.mock('expo-crypto', () => {
  const nodeCrypto = require('crypto');
  return { randomUUID: () => nodeCrypto.randomUUID(), getRandomValues: (a: any) => nodeCrypto.webcrypto.getRandomValues(a) };
});

import * as openpgp from 'openpgp';
import PostalMime from 'postal-mime';
import {
  importDeviceKey, listDeviceKeys, removeDeviceKey, unlockDeviceKeys, lockDeviceKeys, isUnlocked,
  decryptPayload, buildEncryptedMessage, deviceReadiness, DeviceKeyLockedError,
} from '../src/devicePgp';
import { encodeWords, encodeAddressList, splitAddresses, base64ToBytes, bytesToBase64 } from '../src/mime';

// Node built-ins, typed loosely: the app's tsconfig has no Node types.
const fs = jest.requireActual('fs');
const path = jest.requireActual('path');
declare const process: { env: Record<string, string | undefined>; cwd(): string };

// Made by the backend's OpenPGP.js v6; see the "note" field inside.
const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test/fixtures/interop-keys-and-backend-message.json'), 'utf8'));
const friendKey = [{ email: 'friend@example.org', publicKey: fixture.friendPublicKey }];

beforeEach(() => { lockDeviceKeys(); });

test('a key must arrive passphrase-protected, and the passphrase must be right', async () => {
  await expect(importDeviceKey(fixture.mePrivateKeyUnlocked, 'x')).rejects.toThrow(/with a passphrase/);
  await expect(importDeviceKey(fixture.meLockedPrivateKey, 'wrong passphrase')).rejects.toThrow(/does not unlock/);
  await expect(importDeviceKey('garbage', 'x')).rejects.toThrow(/not an OpenPGP private key/);

  const keys = await importDeviceKey(fixture.meLockedPrivateKey, fixture.passphrase);
  expect(keys).toEqual([expect.objectContaining({ email: 'me@example.com', unlocked: true })]);
  // At rest it is still the passphrase-protected key, never the unlocked one.
  const stored = [...mockKeychain.values()].find(v => v.includes('PRIVATE KEY'))!;
  expect((await openpgp.readPrivateKey({ armoredKey: stored })).isDecrypted()).toBe(false);
});

test('a message encrypted and signed by the backend (v6) opens and verifies on the phone (v5)', async () => {
  await unlockDeviceKeys(fixture.passphrase);
  const opened = await decryptPayload(fixture.payload, friendKey);
  expect(opened.pgp).toMatchObject({ encrypted: true, decrypted: true, status: 'verified', signer: 'friend@example.org' });
  expect(opened.subject).toBe('Plans 计划');
  expect(opened.text).toMatch(/Meet at noon\. 中午见。/);
  expect(opened.html).toMatch(/<b>noon<\/b>/);
  expect(opened.attachments.map(a => a.filename)).toEqual(['map.txt']);
  expect(new TextDecoder().decode(opened.attachments[0].content)).toBe('north gate');
});

test('without the sender’s key the signature is unverified, not trusted', async () => {
  await unlockDeviceKeys(fixture.passphrase);
  const opened = await decryptPayload(fixture.payload, []);
  expect(opened.pgp.decrypted).toBe(true);
  expect(opened.pgp.status).toBe('unknown-key');
});

test('a locked key asks for its passphrase, and only the right one unlocks it', async () => {
  expect(isUnlocked()).toBe(false);
  await expect(decryptPayload(fixture.payload, friendKey)).rejects.toBeInstanceOf(DeviceKeyLockedError);
  await expect(unlockDeviceKeys('nope nope nope')).rejects.toThrow(/does not unlock/);
  expect(await unlockDeviceKeys(fixture.passphrase)).toEqual(['me@example.com']);
  expect((await listDeviceKeys())[0].unlocked).toBe(true);
});

test('the phone builds PGP/MIME that hides the subject and body, encrypted to recipient and sender', async () => {
  await unlockDeviceKeys(fixture.passphrase);
  const draft = {
    from: { name: 'Me', address: 'me@example.com' },
    to: '"Friend, F." <friend@example.org>', bcc: 'me@example.com',
    subject: 'Reply 回复', text: 'See you at noon.', html: '<p>See you at <i>noon</i>.</p>',
    attachments: [{ filename: '路线.txt', contentType: 'text/plain', content: bytesToBase64(new TextEncoder().encode('east gate')) }],
    inReplyTo: '<orig@example.org>',
  };
  const rawB64 = await buildEncryptedMessage(draft, friendKey);
  const raw = new TextDecoder().decode(base64ToBytes(rawB64));
  expect(raw).toMatch(/^Subject: \[\.\.\.\]\r$/m);
  expect(raw).toMatch(/^Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"/m);
  expect(raw).toMatch(/^In-Reply-To: <orig@example\.org>\r$/m);
  expect(raw).toMatch(/^To: "Friend, F\." <friend@example\.org>\r$/m);
  expect(raw).not.toMatch(/See you|Reply 回复|5Zue5aSN|east gate/);

  // The friend can open it with their own key, and sees the protected subject.
  const armored = raw.match(/-----BEGIN PGP MESSAGE-----[\s\S]+?-----END PGP MESSAGE-----/)![0];
  const result = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: armored }),
    decryptionKeys: await openpgp.readPrivateKey({ armoredKey: fixture.friendPrivateKey }),
    verificationKeys: await openpgp.readKey({ armoredKey: fixture.mePublicKey }),
    format: 'binary',
  });
  await expect(result.signatures[0].verified).resolves.toBe(true);
  const inner = await PostalMime.parse(result.data as Uint8Array);
  expect(inner.subject).toBe('Reply 回复');
  expect(inner.text?.trim()).toBe('See you at noon.');
  expect(inner.attachments[0].filename).toBe('路线.txt');

  // Hand the same message to the backend's interop test (v6 must open it).
  if (process.env.WRITE_INTEROP_FIXTURE) {
    fs.writeFileSync(process.env.WRITE_INTEROP_FIXTURE, JSON.stringify({
      note: 'Built on the phone (OpenPGP.js v5 + src/mime.ts) for the backend (v6) interop test. Test-only keys.',
      friendPrivateKey: fixture.friendPrivateKey, friendPublicKey: fixture.friendPublicKey, mePublicKey: fixture.mePublicKey,
      raw: rawB64,
    }, null, 1));
  }
});

test('encrypting refuses recipients without a key and a locked key', async () => {
  expect(deviceReadiness('me@example.com', { to: 'friend@example.org, stranger@x.example' }, friendKey))
    .toEqual({ recipients: ['friend@example.org', 'stranger@x.example'], missing: ['stranger@x.example'], canEncrypt: false });
  await expect(buildEncryptedMessage({ from: { address: 'me@example.com' }, to: 'friend@example.org', subject: 's', text: 't' }, friendKey))
    .rejects.toBeInstanceOf(DeviceKeyLockedError);
});

test('removing the key forgets it everywhere', async () => {
  await removeDeviceKey('me@example.com');
  expect(await listDeviceKeys()).toEqual([]);
  expect([...mockKeychain.values()].some(v => v.includes('PRIVATE KEY'))).toBe(false);
});

test('header encoding: ASCII stays readable, the rest becomes RFC 2047 words', () => {
  expect(encodeWords('Hello')).toBe('Hello');
  expect(encodeWords('计划')).toBe('=?UTF-8?B?6K6h5YiS?=');
  expect(encodeWords('a\r\nBcc: injected@x')).toBe('a Bcc: injected@x');
  expect(splitAddresses('"Doe, J" <j@x.example>, k@y.example')).toEqual(['"Doe, J" <j@x.example>', 'k@y.example']);
  expect(encodeAddressList('张三 <z@x.example>')).toBe('=?UTF-8?B?5byg5LiJ?= <z@x.example>');
  expect(new TextDecoder().decode(base64ToBytes(bytesToBase64(new TextEncoder().encode('round trip ✓'))))).toBe('round trip ✓');
});
