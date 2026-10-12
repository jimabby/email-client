import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils.js';
import type { Account, EmailSummary } from './types';
import { useAppStore } from './store';
export interface DraftAttachment { filename: string; contentType: string; content: string }
export interface MobileDraft {
  id: string; serverUrl: string; account: Account; replyTo?: EmailSummary;
  to: string; cc: string; bcc: string; subject: string; body: string;
  attachments: DraftAttachment[]; savedAt: string; requestId: string;
}
let tail = Promise.resolve();
const directory = () => FileSystem.documentDirectory + 'private-drafts/';
async function key() {
  let value = await SecureStore.getItemAsync('hermes-draft-key');
  if (!value) {
    const info = await FileSystem.getInfoAsync(directory());
    if (info.exists && (await FileSystem.readDirectoryAsync(directory())).some(name => name.endsWith('.json'))) {
      throw new Error('The draft encryption key is unavailable. Existing drafts have been preserved.');
    }
    value = bytesToHex(await Crypto.getRandomBytesAsync(32));
    await SecureStore.setItemAsync('hermes-draft-key', value);
  }
  return hexToBytes(value);
}
function serial<T>(work: () => Promise<T>): Promise<T> {
  const task = tail.then(work); tail = task.then(() => {}, () => {}); return task;
}
export function saveLocalDraft(draft: MobileDraft) {
  return serial(async () => {
    await FileSystem.makeDirectoryAsync(directory(), { intermediates: true });
    const secret = await key(); const nonce = await Crypto.getRandomBytesAsync(12);
    const sealed = gcm(secret, nonce).encrypt(utf8ToBytes(JSON.stringify(draft)));
    // Publish a new version before removing old copies; replacing a file is not atomic on every platform.
    const path = directory() + draft.id + '.' + Crypto.randomUUID() + '.json';
    await FileSystem.writeAsStringAsync(path + '.tmp', JSON.stringify({ nonce: bytesToHex(nonce), data: bytesToHex(sealed) }));
    await FileSystem.moveAsync({ from: path + '.tmp', to: path });
    for (const name of await FileSystem.readDirectoryAsync(directory())) {
      if ((name === draft.id + '.json' || name.startsWith(draft.id + '.')) && directory() + name !== path) {
        await FileSystem.deleteAsync(directory() + name, { idempotent: true }).catch(() => {});
      }
    }
  });
}
export function removeLocalDraft(id: string) {
  return serial(async () => {
    const info = await FileSystem.getInfoAsync(directory()); if (!info.exists) return;
    for (const name of await FileSystem.readDirectoryAsync(directory())) {
      if (name === id + '.json' || name.startsWith(id + '.')) await FileSystem.deleteAsync(directory() + name, { idempotent: true });
    }
  });
}
export function localDrafts(): Promise<MobileDraft[]> {
  return serial(async () => {
    const info = await FileSystem.getInfoAsync(directory()); if (!info.exists) return [];
    const secret = await key(); const drafts: MobileDraft[] = [];
    for (const name of await FileSystem.readDirectoryAsync(directory())) {
      if (!name.endsWith('.json')) continue;
      const sealed = JSON.parse(await FileSystem.readAsStringAsync(directory() + name));
      const draft = JSON.parse(bytesToUtf8(gcm(secret, hexToBytes(sealed.nonce)).decrypt(hexToBytes(sealed.data)))) as MobileDraft;
      if (draft.serverUrl === useAppStore.getState().serverUrl) drafts.push(draft);
    }
    const newest = new Map<string, MobileDraft>();
    for (const draft of drafts.sort((a, b) => b.savedAt.localeCompare(a.savedAt))) {
      if (!newest.has(draft.id)) newest.set(draft.id, draft);
    }
    return [...newest.values()];
  });
}
