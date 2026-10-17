const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const secrets = require('./secretStore');
const store = require('../store');
const file = path.join(process.env.HERMES_DATA_DIR || path.join(__dirname, '..'), 'shared-drafts.json');
let drafts;
let tail = Promise.resolve();
function read() {
  if (!drafts) drafts = fs.existsSync(file) ? JSON.parse(secrets.openText(fs.readFileSync(file))) : {};
  return drafts;
}
function write(next) {
  const plain = JSON.stringify(next);
  if (Buffer.byteLength(plain) > 100 * 1024 * 1024) throw new Error('Shared drafts are full. Remove old drafts before saving more.');
  const temp = file + '.tmp';
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, secrets.sealText(plain)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file); drafts = next;
}
function serial(fn) { const task = tail.then(fn); tail = task.catch(() => {}); return task; }
function conflict() { return Object.assign(new Error('This draft changed on another device. Your local changes are preserved. Open the latest shared draft or save your work as a new draft.'), { status: 409 }); }
function list() { return Object.values(read()).filter(d => store.getAccount(d.accountId)); }
function save(account, input, service) {
  return serial(async () => {
    const priorRef = input.replaceRef;
    const id = priorRef?.sharedId || input.draftId || crypto.randomUUID();
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error('Invalid draft id');
    const old = read()[id];
    if (old && (old.accountId !== account.id || old.serverRef.revision !== priorRef?.revision)) throw conflict();
    if (!old && priorRef?.sharedId) throw conflict();
    // Preserve the previous provider copy until both the new copy and shared record exist.
    const providerRef = await service.saveDraft(account, input);
    const serverRef = { ...providerRef, sharedId: id, revision: (old?.serverRef.revision || 0) + 1 };
    const { replaceRef, draftId, ...content } = input;
    const record = { id, accountId: account.id, savedAt: new Date().toISOString(), serverRef, ...content };
    try { write({ ...read(), [id]: record }); }
    catch (error) { /* Keep both provider copies on persistence failure. */ throw error; }
    if (priorRef && service.deleteDraft) {
      try { await service.deleteDraft(account, priorRef); } catch { /* An extra copy is recoverable. */ }
    }
    return serverRef;
  });
}
function remove(account, ref, service) {
  return serial(async () => {
    if (ref?.sharedId) {
      const old = read()[ref.sharedId];
      if (old && (old.accountId !== account.id || old.serverRef.revision !== ref.revision)) throw conflict();
      if (!old) return;
      await service.deleteDraft?.(account, ref);
      const next = { ...read() }; delete next[ref.sharedId]; write(next);
    } else if (ref) await service.deleteDraft?.(account, ref);
  });
}
module.exports = { list, save, remove };
