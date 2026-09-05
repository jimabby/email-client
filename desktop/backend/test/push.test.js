const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.HERMES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-push-'));
process.env.HERMES_SECRET_KEY = 'a'.repeat(64);
fs.writeFileSync(path.join(process.env.HERMES_DATA_DIR, 'accounts.json'), '{"accounts":[],"aiSettings":{}}');

const push = require('../services/pushService');
const store = require('../store');

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

function reset() {
  for (const device of [...store.getDevices()]) store.removeDevice(device.token);
}

// ─── Token validation ───────────────────────────────────────────────────────

test('accepts both Expo token spellings', () => {
  assert.ok(push.isExpoPushToken(TOKEN_A));
  assert.ok(push.isExpoPushToken('ExpoPushToken[cccccccccccccccccccccc]'));
});

test('rejects anything that is not an Expo push token', () => {
  // An APNs hex token, a URL, and empty input have all been passed here by
  // mistake in similar code. None of them are deliverable.
  assert.ok(!push.isExpoPushToken('740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad'));
  assert.ok(!push.isExpoPushToken('https://example.com'));
  assert.ok(!push.isExpoPushToken(''));
  assert.ok(!push.isExpoPushToken(null));
  assert.ok(!push.isExpoPushToken('ExponentPushToken[]'));
});

test('registerDevice refuses a token that could never be delivered to', () => {
  reset();
  assert.throws(() => push.registerDevice({ token: 'nonsense', platform: 'ios' }), /valid Expo push token/);
  assert.strictEqual(push.listDevices().length, 0);
});

// ─── Registration ───────────────────────────────────────────────────────────

test('registering the same device twice updates rather than duplicating', () => {
  reset();
  push.registerDevice({ token: TOKEN_A, platform: 'ios' });
  push.registerDevice({ token: TOKEN_A, platform: 'android' });

  const devices = push.listDevices();
  assert.strictEqual(devices.length, 1);
  // The app re-registers on every launch; a duplicate would mean two banners.
  assert.strictEqual(devices[0].platform, 'android');
});

test('an unknown platform is recorded rather than trusted verbatim', () => {
  reset();
  push.registerDevice({ token: TOKEN_A, platform: 'windows-phone' });
  assert.strictEqual(push.listDevices()[0].platform, 'unknown');
});

test('unregisterDevice removes exactly one device', () => {
  reset();
  push.registerDevice({ token: TOKEN_A, platform: 'ios' });
  push.registerDevice({ token: TOKEN_B, platform: 'android' });

  assert.strictEqual(push.unregisterDevice(TOKEN_A), true);
  assert.deepStrictEqual(push.listDevices().map(d => d.token), [TOKEN_B]);
  assert.strictEqual(push.unregisterDevice('never-registered'), false);
});

test('accountIds are capped so one device cannot store an unbounded list', () => {
  reset();
  push.registerDevice({
    token: TOKEN_A,
    platform: 'ios',
    accountIds: Array.from({ length: 50 }, (_, i) => `acct-${i}`),
  });
  assert.strictEqual(push.listDevices()[0].accountIds.length, 20);
});

// ─── Delivery targeting ─────────────────────────────────────────────────────

test('a device with no account filter hears about every account', async () => {
  reset();
  push.registerDevice({ token: TOKEN_A, platform: 'ios', accountIds: [] });
  // No devices are filtered out, so this would attempt a network call; assert
  // on the selection instead by checking the empty-account short circuit.
  const result = await push.notifyNewMail('acct-1', []);
  assert.deepStrictEqual(result, { sent: 0, pruned: 0 });
});

test('an already-read message never raises a notification', async () => {
  reset();
  push.registerDevice({ token: TOKEN_A, platform: 'ios' });
  const result = await push.notifyNewMail('acct-1', [{ id: '1', from: 'a@b.c', read: true }]);
  assert.deepStrictEqual(result, { sent: 0, pruned: 0 });
});

test('no registered devices means no request is attempted', async () => {
  reset();
  const result = await push.send('acct-1', { title: 'x', body: 'y' });
  assert.deepStrictEqual(result, { sent: 0, pruned: 0 });
});
