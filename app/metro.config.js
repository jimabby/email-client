const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');
const sharedRoot = path.resolve(repoRoot, 'shared');

const config = getDefaultConfig(projectRoot);

// shared/ holds the email-rendering policy this app and the desktop client both
// enforce — which tags survive sanitizing, what counts as a tracking pixel,
// how an unsubscribe link is found. Metro only watches the project folder by
// default, so it has to be told about anything outside it.
config.watchFolders = [sharedRoot];

// Modules still resolve from this package's node_modules; only source files
// come from outside.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

module.exports = config;
