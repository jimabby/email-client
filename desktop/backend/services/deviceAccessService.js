const crypto = require('crypto');
const store = require('../store');
const events = new (require('events').EventEmitter)();
function list() { return store.getAccessDevices().map(({ hash, ...device }) => device); }
function create(name) {
  if (!String(name || '').trim()) throw new Error('Device name is required');
  const token = 'hermes_' + crypto.randomBytes(32).toString('hex');
  const device = { id: crypto.randomUUID(), name: String(name).trim().slice(0, 80), createdAt: new Date().toISOString(), hash: crypto.createHash('sha256').update(token).digest('hex') };
  store.saveAccessDevices([...store.getAccessDevices(), device]);
  const { hash, ...publicDevice } = device;
  return { ...publicDevice, token };
}
function authenticate(token) {
  if (typeof token !== 'string' || !token.startsWith('hermes_')) return null;
  const hash = crypto.createHash('sha256').update(token).digest();
  return store.getAccessDevices().find(d => !d.revokedAt && crypto.timingSafeEqual(Buffer.from(d.hash, 'hex'), hash)) || null;
}
function revoke(id) {
  const devices = store.getAccessDevices();
  if (!devices.some(d => d.id === id)) throw new Error('Device not found');
  store.saveAccessDevices(devices.map(d => d.id === id ? { ...d, revokedAt: new Date().toISOString() } : d));
  for (const device of store.getDevices()) if (device.accessDeviceId === id) store.removeDevice(device.token);
  events.emit('revoke', id);
}
module.exports = { list, create, authenticate, revoke, events };
