import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils.js';
import { useAppStore } from './store';

interface State { cache: Record<string, { value: any; at: string }>; queue: LocalSend[] }
export interface LocalSend { id: string; accountId: string; payload: any; error?: string; rejected?: boolean; at: string }
let tail = Promise.resolve();
const directory = () => FileSystem.documentDirectory + 'offline-private/';
export const offlineUnavailable = (e: unknown) => axios.isAxiosError(e) && (!e.response || e.response.status >= 500);
async function scope() {
  const { serverUrl, apiToken } = useAppStore.getState();
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, serverUrl + '\n' + apiToken);
}
async function secret() {
  let saved = await SecureStore.getItemAsync('hermes-offline-key');
  if (!saved) {
    if ((await FileSystem.readDirectoryAsync(directory())).some(n => n.endsWith('.json'))) throw new Error('Offline encryption key is unavailable. Saved files were preserved.');
    saved = bytesToHex(await Crypto.getRandomBytesAsync(32));
    await SecureStore.setItemAsync('hermes-offline-key', saved);
  }
  return hexToBytes(saved);
}
async function transaction<T>(fn: (state: State) => T, mutate: boolean, namespace: string): Promise<T> {
  const task = tail.then(async () => {
    await FileSystem.makeDirectoryAsync(directory(), { intermediates: true });
    const key = await secret();
    const names = (await FileSystem.readDirectoryAsync(directory())).filter(n => n.startsWith(namespace + '.') && n.endsWith('.json')).sort().reverse();
    let state: State = { cache: {}, queue: [] };
    if (names.length) {
      const sealed = JSON.parse(await FileSystem.readAsStringAsync(directory() + names[0]));
      state = JSON.parse(bytesToUtf8(gcm(key, hexToBytes(sealed.nonce)).decrypt(hexToBytes(sealed.data))));
    }
    const result = fn(state);
    if (mutate) {
      const nonce = await Crypto.getRandomBytesAsync(12);
      const plain = utf8ToBytes(JSON.stringify(state));
      if (plain.length > 100 * 1024 * 1024) throw new Error('Offline storage is full. Keep this draft and remove old queued messages.');
      const data = gcm(key, nonce).encrypt(plain);
      const generation = Math.max(Date.now(), Number(names[0]?.split('.')[1] || 0) + 1);
      const name = namespace + '.' + generation.toString().padStart(16, '0') + '.' + Crypto.randomUUID() + '.json';
      const path = directory() + name;
      await FileSystem.writeAsStringAsync(path + '.tmp', JSON.stringify({ nonce: bytesToHex(nonce), data: bytesToHex(data) }));
      await FileSystem.moveAsync({ from: path + '.tmp', to: path });
      for (const old of names) await FileSystem.deleteAsync(directory() + old, { idempotent: true }).catch(() => {});
    }
    return result;
  });
  tail = task.then(() => {}, () => {}); return task;
}
export async function cachedRead<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const namespace = await scope();
  try {
    const value = await fetcher();
    useAppStore.setState({ offline: false });
    // Cache failures must not hide a successful online response.
    await transaction(state => {
      state.cache[key] = { value, at: new Date().toISOString() };
      const keys = Object.keys(state.cache).sort((a, b) => state.cache[a].at.localeCompare(state.cache[b].at));
      while (keys.length > 100) delete state.cache[keys.shift()!];
    }, true, namespace).catch(() => {});
    return value;
  } catch (e) {
    if (!offlineUnavailable(e)) throw e;
    const record = await transaction(state => state.cache[key], false, namespace);
    if (!record) throw e;
    useAppStore.setState({ offline: true });
    const value = record.value;
    return (Array.isArray(value) ? value : { ...value, offline: true, cachedAt: record.at }) as T;
  }
}
export async function queueOffline(accountId: string, payload: any) {
  if (!payload.requestId) throw new Error('A stable request ID is required for offline sending');
  return transaction(state => {
    const existing = state.queue.find(q => q.accountId === accountId && q.id === payload.requestId);
    if (existing) {
      if (JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw new Error('This queued message already has different content. Open Outbox before sending again.');
      return;
    }
    if (state.queue.length >= 20) throw new Error('Offline outbox is full. Keep this draft and retry later.');
    state.queue.push({ id: payload.requestId, accountId, payload, at: new Date().toISOString() });
  }, true, await scope());
}
export async function localSends() { return transaction(state => state.queue, false, await scope()); }
export async function removeLocalSend(id: string) { if (flushing) throw new Error('Outbox is synchronizing. Retry in a moment.'); return transaction(state => { state.queue = state.queue.filter(q => q.id !== id); }, true, await scope()); }
let flushing = false;
export async function flushLocalSends(send: (accountId: string, payload: any) => Promise<unknown>, retryRejected = false) {
  if (flushing) return;
  flushing = true;
  const identity = useAppStore.getState();
  try {
    const namespace = await scope();
    const items = await transaction(state => state.queue, false, namespace);
    for (const item of items) {
      if (identity.serverUrl !== useAppStore.getState().serverUrl || identity.apiToken !== useAppStore.getState().apiToken) break;
      if (item.rejected && !retryRejected) continue;
      try { await send(item.accountId, item.payload); }
      catch (e) {
        if (offlineUnavailable(e)) break;
        await transaction(state => { const entry = state.queue.find(q => q.id === item.id); if (entry) { entry.rejected = true; entry.error = e instanceof Error ? e.message : String(e); } }, true, namespace);
        continue;
      }
      await transaction(state => { state.queue = state.queue.filter(q => q.id !== item.id); }, true, namespace);
    }
  } finally { flushing = false; }
}
