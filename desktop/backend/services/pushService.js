const https = require('https');
const store = require('../store');

/**
 * Push notifications to the mobile app.
 *
 * The desktop shell gets told about new mail over the utilityProcess port and
 * raises an OS notification. The phone had no equivalent at all: a complete
 * arrival pipeline existed server-side — IDLE/push/polling, indexing, rules,
 * badge — and the mobile app only ever learned about new mail by being opened
 * and pulled down.
 *
 * Expo's push service is the delivery mechanism because the app is an Expo
 * managed build; it takes an ExponentPushToken and fans out to APNs/FCM, so
 * there are no platform credentials to hold here.
 */

const EXPO_HOST = 'exp.host';
const EXPO_PATH = '/--/api/v2/push/send';
// Expo accepts up to 100 messages per request.
const CHUNK = 100;

/** Expo tokens have a fixed, checkable shape; anything else is not deliverable. */
function isExpoPushToken(token) {
  return typeof token === 'string'
    && /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/.test(token.trim());
}

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: EXPO_HOST,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Expo push request timed out')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Register a device.
 *
 * Devices are keyed by token, so re-registering the same install (which Expo
 * does on every launch) updates rather than duplicates.
 */
function registerDevice({ token, platform, accountIds }) {
  if (!isExpoPushToken(token)) throw new Error('Not a valid Expo push token');
  return store.saveDevice({
    token: token.trim(),
    platform: platform === 'ios' || platform === 'android' ? platform : 'unknown',
    // An empty list means "every account", which is what a fresh install wants.
    accountIds: Array.isArray(accountIds) ? accountIds.slice(0, 20) : [],
    registeredAt: new Date().toISOString(),
  });
}

function unregisterDevice(token) {
  return store.removeDevice(String(token || '').trim());
}

function listDevices() {
  return store.getDevices();
}

/** Devices that should hear about this account. */
function targetsFor(accountId) {
  return store.getDevices().filter(device =>
    !device.accountIds?.length || device.accountIds.includes(accountId));
}

/**
 * Deliver one notification, and prune devices Expo tells us are dead.
 *
 * A token becomes invalid when the app is uninstalled. Expo reports that as a
 * DeviceNotRegistered error per-message; leaving those in the store means every
 * future send carries dead weight and the error is re-reported forever.
 */
async function send(accountId, { title, body, data }) {
  const devices = targetsFor(accountId);
  if (!devices.length) return { sent: 0, pruned: 0 };

  let sent = 0;
  let pruned = 0;

  for (let i = 0; i < devices.length; i += CHUNK) {
    const batch = devices.slice(i, i + CHUNK);
    const messages = batch.map(device => ({
      to: device.token,
      title: String(title || 'Hermes').slice(0, 120),
      body: String(body || '').slice(0, 300),
      sound: 'default',
      // Opening the notification should land on the exact message.
      data: data || {},
      priority: 'high',
      channelId: 'new-mail',
    }));

    let response;
    try {
      response = await postJson(EXPO_PATH, messages);
    } catch (err) {
      console.warn('[push] Expo request failed:', err.message);
      continue;
    }

    const tickets = Array.isArray(response.body?.data) ? response.body.data : [];
    tickets.forEach((ticket, index) => {
      if (ticket?.status === 'ok') { sent++; return; }
      if (ticket?.details?.error === 'DeviceNotRegistered') {
        store.removeDevice(batch[index].token);
        pruned++;
      }
    });
  }

  return { sent, pruned };
}

function senderName(from) {
  const match = String(from || '').match(/^\s*"?([^"<]+?)"?\s*</);
  if (match) return match[1].trim();
  const address = String(from || '').match(/<([^>]+)>/)?.[1] || String(from || '');
  return address.trim() || 'Unknown sender';
}

/** Batched, matching the desktop toast: one notification per arrival burst. */
async function notifyNewMail(accountId, emails = []) {
  const unread = emails.filter(e => !e.read);
  if (!unread.length) return { sent: 0, pruned: 0 };

  if (unread.length === 1) {
    const email = unread[0];
    return send(accountId, {
      title: senderName(email.from),
      body: email.subject || '(no subject)',
      data: { accountId, emailId: email.id, folder: email.folder || 'INBOX' },
    });
  }

  return send(accountId, {
    title: `${unread.length} new messages`,
    body: unread.slice(0, 3).map(e => senderName(e.from)).join(', ')
      + (unread.length > 3 ? `, and ${unread.length - 3} more` : ''),
    data: { accountId, folder: 'INBOX' },
  });
}

/** A snoozed message reaching its wake time. */
async function notifySnoozeWake(accountId, email, { folder } = {}) {
  return send(accountId, {
    title: senderName(email?.from),
    body: email?.subject || '(no subject)',
    data: { accountId, emailId: email?.id, folder: folder || 'INBOX', reason: 'snooze' },
  });
}

module.exports = {
  registerDevice,
  unregisterDevice,
  listDevices,
  notifyNewMail,
  notifySnoozeWake,
  send,
  isExpoPushToken,
};
