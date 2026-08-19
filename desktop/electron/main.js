const { app, BrowserWindow, shell, globalShortcut, utilityProcess, Notification, Tray, Menu, nativeImage, safeStorage } = require('electron');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const crypto = require('crypto');

let mainWindow;
let backendProcess;
let tray;
let quitting = false;
let backendRestarts = 0;
const BACKEND_PORT = 3001;

// Resolve icon path (works both in dev and after packaging)
function getIconPath() {
  const candidates = [
    path.join(__dirname, '../build/icons/icon.ico'),
    path.join(process.resourcesPath || '', 'build/icons/icon.ico'),
  ];
  return candidates.find(p => fs.existsSync(p));
}

function getTrayIconPath() {
  const candidates = [
    path.join(__dirname, '../build/icons/256x256.png'),
    path.join(process.resourcesPath || '', 'build/icons/256x256.png'),
    getIconPath(),
  ].filter(Boolean);
  return candidates.find(p => p && fs.existsSync(p));
}

// ─── Credential key ─────────────────────────────────────────────────────────
// The backend runs in a utilityProcess, which has no safeStorage. So the main
// process owns the master key: it is generated once, sealed with the OS
// keychain (DPAPI / Keychain / libsecret), and handed to the backend in memory
// at spawn. The key never touches disk unencrypted.

function loadOrCreateMasterKey() {
  const keyFile = path.join(app.getPath('userData'), 'master.key');

  if (fs.existsSync(keyFile)) {
    try {
      const stored = fs.readFileSync(keyFile);
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(stored);
      }
      // No keychain on this system — the file holds the key in the clear and
      // is the best we can do. Still better than credentials in accounts.json.
      return stored.toString('utf8');
    } catch (err) {
      console.error('Could not read the master key, generating a new one:', err.message);
    }
  }

  const key = crypto.randomBytes(32).toString('hex');
  try {
    const payload = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(key)
      : Buffer.from(key, 'utf8');
    fs.writeFileSync(keyFile, payload, { mode: 0o600 });
  } catch (err) {
    console.error('Could not persist the master key:', err.message);
  }
  return key;
}

// Wait for the backend Express server to be ready
function waitForBackend(maxRetries = 60) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      http.get(`http://127.0.0.1:${BACKEND_PORT}/api/health`, (res) => {
        if (res.statusCode === 200) resolve();
        else retry();
      }).on('error', retry);
    };
    const retry = () => {
      attempts++;
      if (attempts >= maxRetries) reject(new Error('Backend did not start in time'));
      else setTimeout(check, 500);
    };
    check();
  });
}

// ─── Backend process ────────────────────────────────────────────────────────
// Running the backend in its own process means a crash, an unhandled rejection,
// or a slow MIME parse can't take down or freeze the window.

function startBackend(masterKey) {
  const backendEntry = path.join(__dirname, '../backend/server.js');

  backendProcess = utilityProcess.fork(backendEntry, [], {
    cwd: path.join(__dirname, '../backend'),
    stdio: 'inherit',
    env: {
      ...process.env,
      HERMES_DATA_DIR: app.getPath('userData'),
      HERMES_SECRET_KEY: masterKey,
      // Desktop is single-user and loopback-only; no shared token needed.
      BIND_HOST: '127.0.0.1',
    },
  });

  backendProcess.on('message', handleBackendMessage);

  backendProcess.on('exit', (code) => {
    if (quitting) return;
    console.error(`Backend exited with code ${code}`);
    // Restart, but give up rather than spinning if it dies immediately.
    if (backendRestarts++ < 5) {
      setTimeout(() => startBackend(masterKey), 1000 * backendRestarts);
    } else if (mainWindow) {
      mainWindow.webContents.send('hermes:backend-down');
    }
  });

  return backendProcess;
}

// ─── Notifications & tray ───────────────────────────────────────────────────

function focusWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function handleBackendMessage(message) {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'notify') {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: String(message.title || 'Hermes').slice(0, 120),
      body: String(message.body || '').slice(0, 300),
      subtitle: message.subtitle ? String(message.subtitle).slice(0, 120) : undefined,
      silent: false,
      icon: getTrayIconPath(),
    });
    notification.on('click', () => {
      focusWindow();
      // Let the renderer open the exact message the toast referred to.
      mainWindow?.webContents.send('hermes:open', message.payload || {});
    });
    notification.show();
    return;
  }

  if (message.type === 'badge') {
    const count = Number(message.count) || 0;
    updateTray(count);
    if (process.platform === 'darwin') {
      app.dock?.setBadge(count > 0 ? String(count) : '');
    } else {
      // Windows/Linux: overlay on the taskbar button.
      mainWindow?.setOverlayIcon?.(null, count > 0 ? `${count} unread` : '');
    }
  }
}

function updateTray(unread = 0) {
  if (!tray) return;
  tray.setToolTip(unread > 0 ? `Hermes — ${unread} unread` : 'Hermes');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: unread > 0 ? `${unread} unread` : 'No unread mail', enabled: false },
    { type: 'separator' },
    { label: 'Open Hermes', click: focusWindow },
    {
      label: 'Compose',
      click: () => { focusWindow(); mainWindow?.webContents.send('hermes:compose'); },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const iconPath = getTrayIconPath();
  if (!iconPath) return;
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on('click', focusWindow);
  updateTray(0);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'Hermes',
    icon: getIconPath(),
    show: false,
    backgroundColor: '#0d1117',
  });

  mainWindow.loadURL(`http://127.0.0.1:${BACKEND_PORT}`);

  // Only show once the page has loaded (prevents white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();  // ensure keyboard focus on Windows
  });

  // Ctrl+Shift+I to open DevTools (for debugging)
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });

  // Open external links in the system browser, not inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window keeps Hermes running in the tray so mail keeps syncing
  // and notifications keep arriving.
  mainWindow.on('close', (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// One instance only — a second launch focuses the running window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusWindow);

  app.whenReady().then(async () => {
    if (process.platform !== 'darwin') {
      app.setAppUserModelId('com.hermes.app');
    }

    try {
      startBackend(loadOrCreateMasterKey());
      await waitForBackend();
      createTray();
      createWindow();
    } catch (err) {
      console.error('Failed to start Hermes:', err.message);
      app.quit();
    }
  });
}

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  // With a tray icon present, Hermes intentionally keeps running.
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
  else focusWindow();
});

app.on('quit', () => {
  globalShortcut.unregisterAll();
  try { backendProcess?.kill(); } catch { /* already gone */ }
});
