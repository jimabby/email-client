import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { api } from './api';
import { decryptPayload, hasDeviceKey, DeviceKeyLockedError, type DecryptedAttachment, type DecryptedMessage } from './devicePgp';
import { bytesToBase64 } from './mime';
import type { EmailBody } from './types';

/**
 * Open a message the backend could not decrypt, with a key held on this phone.
 * @returns the readable body and its decrypted attachments, `locked` when the
 *   phone's key needs its passphrase, or null when there is no key here.
 */
export async function openWithDeviceKey(accountId: string, emailId: string, folder: string | undefined, body: EmailBody):
  Promise<null | { locked: true } | { body: EmailBody; attachments: DecryptedAttachment[] }> {
  if (!(await hasDeviceKey())) return null;
  let opened: DecryptedMessage;
  try {
    const [payload, { keys }] = await Promise.all([api.pgpPayload(accountId, emailId, folder), api.publicKeys()]);
    opened = await decryptPayload(payload, keys);
  } catch (err) {
    if (err instanceof DeviceKeyLockedError) return { locked: true };
    throw err;
  }
  return {
    body: {
      ...body,
      ...(typeof opened.subject === 'string' ? { subject: opened.subject } : {}),
      text: opened.text,
      html: opened.html,
      attachments: opened.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size, content: null })),
      pgp: { ...opened.pgp, onDevice: true },
    },
    attachments: opened.attachments,
  };
}

/**
 * Hand a decrypted attachment to the OS share sheet. It is written to the
 * app's cache only for as long as the sheet needs it, then deleted: the
 * plaintext should not outlive the moment it was asked for.
 */
export async function shareDecryptedAttachment(attachment: DecryptedAttachment): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  const dir = `${FileSystem.cacheDirectory}decrypted/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const safe = (attachment.filename || 'attachment').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'attachment';
  const uri = `${dir}${Date.now()}-${safe}`;
  await FileSystem.writeAsStringAsync(uri, bytesToBase64(attachment.content), { encoding: FileSystem.EncodingType.Base64 });
  try {
    await Sharing.shareAsync(uri, { mimeType: attachment.contentType, dialogTitle: attachment.filename });
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
}
