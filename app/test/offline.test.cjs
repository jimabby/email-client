const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const ts = require('typescript');
function fixture() {
  const files = new Map(), keys = new Map();
  let failWrites = false;
  let identity = { serverUrl: 'https://one.example', apiToken: 'token-one', offline: false };
  const nativeFs = {
    documentDirectory: 'private/', makeDirectoryAsync: async () => {},
    readDirectoryAsync: async dir => [...files.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length)),
    readAsStringAsync: async file => files.get(file),
    writeAsStringAsync: async (file, value) => { if (failWrites) throw new Error('Disk full'); files.set(file, value); },
    moveAsync: async ({ from, to }) => { files.set(to, files.get(from)); files.delete(from); },
    deleteAsync: async file => { files.delete(file); },
  };
  const mocks = {
    'expo-secure-store': { getItemAsync: async k => keys.get(k), setItemAsync: async (k, v) => { keys.set(k, v); } },
    'expo-file-system/legacy': nativeFs,
    'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async (_, value) => crypto.createHash('sha256').update(value).digest('hex'), getRandomBytesAsync: async n => new Uint8Array(crypto.randomBytes(n)), randomUUID: crypto.randomUUID },
    './store': { useAppStore: { getState: () => identity, setState: value => { identity = { ...identity, ...value }; } } },
  };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/offline.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { module, exports: module.exports, require: name => mocks[name] || require(name), Uint8Array, TextEncoder, TextDecoder, Date, console });
  return { offline: module.exports, files, keys, switchServer: () => { identity = { ...identity, serverUrl: 'https://two.example' }; }, fillDisk: () => { failWrites = true; } };
}
const disconnected = () => { throw Object.assign(new Error('Offline'), { isAxiosError: true }); };
test('cached mail is encrypted, available offline, and isolated by connection identity', async () => {
  const { offline, files, switchServer } = fixture();
  await offline.cachedRead('message', async () => ({ text: 'private message body' }));
  for (const bytes of files.values()) assert.ok(!bytes.includes('private message body'));
  const value = await offline.cachedRead('message', disconnected);
  assert.equal(value.text, 'private message body'); assert.equal(value.offline, true);
  switchServer(); await assert.rejects(offline.cachedRead('message', disconnected), /Offline/);
});
test('offline sends survive transport failures, retain identity, and pause permanent rejections', async () => {
  const { offline } = fixture(); const payload = { requestId: 'stable-request', to: 'a@example.com', text: 'private' };
  await offline.queueOffline('account', payload); await offline.queueOffline('account', payload);
  assert.equal((await offline.localSends()).length, 1);
  await offline.flushLocalSends(disconnected); assert.equal((await offline.localSends()).length, 1);
  let calls = 0;
  await offline.flushLocalSends(async (_, data) => { calls++; assert.equal(data.requestId, payload.requestId); throw Object.assign(new Error('Rejected'), { isAxiosError: true, response: { status: 400 } }); });
  await offline.flushLocalSends(async () => { calls++; }); assert.equal(calls, 1);
  await offline.flushLocalSends(async (_, data) => assert.equal(data.requestId, payload.requestId), true);
  assert.equal((await offline.localSends()).length, 0);
});
test('disk failure never acknowledges an offline send', async () => {
  const { offline, fillDisk } = fixture(); fillDisk();
  await assert.rejects(offline.queueOffline('account', { requestId: 'keep-draft' }), /Disk full/);
  assert.equal((await offline.localSends()).length, 0);
});
test('missing encryption key preserves existing ciphertext', async () => {
  const { offline, keys, files } = fixture();
  await offline.queueOffline('account', { requestId: 'recoverable' });
  const before = [...files.values()]; keys.clear();
  await assert.rejects(offline.localSends(), /key is unavailable/);
  assert.deepEqual([...files.values()], before);
});
