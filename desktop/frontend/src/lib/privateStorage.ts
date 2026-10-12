// Sensitive content is encrypted in IndexedDB. Keys stay in memory: desktop
// derives one from the OS-protected master; browsers use a storage passphrase.
const keys = ['hermes-drafts', 'hermes-local-outbox'];
const cache = new Map<string, unknown>();
let db: IDBDatabase;
let key: CryptoKey;
let pending = Promise.resolve();
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
async function put(name: string, value: unknown) {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('private', 'readwrite');
    tx.objectStore('private').put(value, name);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not save private data'));
  });
}
async function initialize(passphrase?: string) {
  const opening = indexedDB.open('hermes-private', 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore('private');
  db = await request(opening);
  if (window.hermes?.privateKey) {
    const hex = await window.hermes.privateKey();
    const bytes = Uint8Array.from(hex.match(/../g)!, part => parseInt(part, 16));
    key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } else {
    if (!passphrase || passphrase.length < 12) throw new Error('Use a storage passphrase of at least 12 characters.');
    let salt = await request(db.transaction('private').objectStore('private').get('salt'));
    if (!salt) { salt = crypto.getRandomValues(new Uint8Array(16)); await put('salt', salt); }
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const check = await request(db.transaction('private').objectStore('private').get('check'));
  if (check) await crypto.subtle.decrypt({ name: 'AES-GCM', iv: check.iv }, key, check.data);
  else { const iv = crypto.getRandomValues(new Uint8Array(12)); await put('check', { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('hermes')) }); }
  for (const name of keys) {
    const sealed = await request(db.transaction('private').objectStore('private').get(name));
    if (sealed) {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.data);
      cache.set(name, JSON.parse(new TextDecoder().decode(plain)));
    } else {
      const legacy = localStorage.getItem(name);
      cache.set(name, legacy ? JSON.parse(legacy) : []);
      if (legacy) await updatePrivate<unknown[]>(name, value => value);
    }
    // Delete legacy plaintext only after encrypted storage succeeded.
    localStorage.removeItem(name);
  }
}
export async function initializePrivateStorage(passphrase?: string) {
  if (navigator.locks) return navigator.locks.request('hermes-private-initialize', () => initialize(passphrase));
  return initialize(passphrase);
}
export function readPrivate<T>(name: string, fallback: T): T { return (cache.get(name) as T) ?? fallback; }
export function updatePrivate<T>(name: string, update: (value: T) => T): Promise<T> {
  const work = async () => {
    if (!key || !db) throw new Error('Private storage is unavailable. Keep this message open and retry.');
    const sealed = await request(db.transaction('private').objectStore('private').get(name));
    const latest = sealed ? JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.data))) : readPrivate<T>(name, [] as T);
    const next = update(latest);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(next)));
    await put(name, { iv, data });
    cache.set(name, next);
    return next;
  };
  const operation = pending.then(async () => { if (navigator.locks) return await navigator.locks.request('hermes-private-write', work); return await work() });
  pending = operation.then(() => {}, () => {});
  return operation;
}
