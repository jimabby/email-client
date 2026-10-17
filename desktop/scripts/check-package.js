const assert = require('assert/strict');
const path = require('path');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
const root = path.resolve(__dirname, '..');
const patterns = require('../package.json').build.files;
const filter = new FileMatcher(root, path.join(root, 'dist-electron'), s => s, patterns).createFilter();
const file = { isDirectory: () => false };
for (const name of ['backend/email-cache/index.json', 'backend/email-cache/synthetic-marker.bin', 'backend/state.json', 'backend/shared-drafts.json', 'backend/accounts.json', 'backend/services/secret.key', 'backend/.env']) {
  assert.equal(filter(path.join(root, name), file), false, name + ' must never ship');
}
for (const name of ['backend/server.js', 'backend/services/sharedDraftService.js', 'electron/main.js', 'build/icons/256x256.png', 'frontend/dist/index.html']) {
  assert.equal(filter(path.join(root, name), file), true, name + ' must ship');
}
console.log('Electron packaging filters exclude private runtime data and include required assets.');
