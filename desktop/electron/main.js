const { app, BrowserWindow, shell, ipcMain, utilityProcess, Notification, Tray, Menu, nativeImage, nativeTheme, safeStorage } = require('electron');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const crypto = require('crypto');

let mainWindow;
let backendProcess;
let tray;
let quitting = false;
let backendRestarts = 0;
let unreadTotal = 0;
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

// Loopback is not an authorisation boundary. Every other process on this
// machine can reach 127.0.0.1:3001, and so can any web page the user visits:
// CORS stops a page reading the *response*, but a simple no-preflight POST
// still executes, which is enough to delete mail or report a sender as spam.
// Without API_TOKEN, apiAuth waves all of it through.
//
// So the desktop gets a token too. It is generated fresh on every launch,
// never touches disk, and reaches the renderer through the bootstrap in
// server.js — which hands it out only to a caller on this machine.
const SESSION_API_TOKEN = crypto.randomBytes(32).toString('hex');

function startBackend(masterKey) {
  const backendEntry = path.join(__dirname, '../backend/server.js');

  backendProcess = utilityProcess.fork(backendEntry, [], {
    cwd: path.join(__dirname, '../backend'),
    stdio: 'inherit',
    env: {
      ...process.env,
      HERMES_DATA_DIR: app.getPath('userData'),
      HERMES_SECRET_KEY: masterKey,
      API_TOKEN: SESSION_API_TOKEN,
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
    unreadTotal = count;
    updateTray(count);
    if (process.platform === 'darwin') {
      app.dock?.setBadge(count > 0 ? String(count) : '');
    } else if (process.platform === 'linux') {
      app.setBadgeCount?.(count);
    } else {
      // Windows draws a small image over the taskbar button. There is nothing
      // in the main process that can rasterise "12" into a bitmap, so the
      // renderer — which has a canvas — draws it and hands the PNG back
      // through the bridge below. Passing null here, as this once did, simply
      // cleared the overlay and the count was never visible anywhere but the
      // tray tooltip.
      if (count > 0) mainWindow?.webContents.send('hermes:badge', { count });
      else mainWindow?.setOverlayIcon?.(null, '');
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

// --- Window state -----------------------------------------------------------
// Size, position, maximised-ness, and the last theme the renderer was showing.
// The theme is here so the very first paint can use the right background: the
// renderer's choice lives in localStorage, which the main process cannot read,
// and a fixed dark colour flashed black for every light-mode user.

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    return {
      width: Number(raw.width) > 0 ? Math.round(raw.width) : 1400,
      height: Number(raw.height) > 0 ? Math.round(raw.height) : 900,
      x: Number.isFinite(raw.x) ? Math.round(raw.x) : undefined,
      y: Number.isFinite(raw.y) ? Math.round(raw.y) : undefined,
      maximized: raw.maximized === true,
      theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : null,
    };
  } catch {
    return { width: 1400, height: 900, maximized: false, theme: null };
  }
}

let savedTheme = null;

function writeWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // getNormalBounds is the un-maximised geometry, which is what a restore
    // needs - getBounds while maximised records the whole screen.
    const bounds = mainWindow.getNormalBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify({
      ...bounds,
      maximized: mainWindow.isMaximized(),
      theme: savedTheme,
    }), { mode: 0o600 });
  } catch { /* losing the window position is not worth surfacing */ }
}

/** The ground colour to paint before the renderer's first frame. */
function launchBackground(theme) {
  const dark = theme ? theme === 'dark' : nativeTheme.shouldUseDarkColors;
  // --bg from frontend/src/index.css, in both themes.
  return dark ? '#060609' : '#e7e8ee';
}

function createWindow() {
  const state = readWindowState();
  savedTheme = state.theme;

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
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
    backgroundColor: launchBackground(state.theme),
  });

  if (state.maximized) mainWindow.maximize();

  mainWindow.loadURL(`http://127.0.0.1:${BACKEND_PORT}`);

  // Only show once the page has loaded (prevents white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();  // ensure keyboard focus on Windows
  });

  // DevTools on Ctrl/Cmd+Shift+I. This used to be a globalShortcut, which
  // registers with the OS and takes the chord away from every other
  // application for as long as Hermes is running - including while it sits
  // minimised in the tray. A before-input-event handler is scoped to this
  // window, which is all that was ever wanted.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const modifier = process.platform === 'darwin' ? input.meta : input.control;
    if (modifier && input.shift && String(input.key).toLowerCase() === 'i') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  // Open external links in the system browser, not inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Debounced so a drag-resize writes once, not once per frame.
  let persistTimer = null;
  const persistLater = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(writeWindowState, 400);
    persistTimer.unref?.();
  };
  mainWindow.on('resize', persistLater);
  mainWindow.on('move', persistLater);
  mainWindow.on('maximize', persistLater);
  mainWindow.on('unmaximize', persistLater);

  // Closing the window keeps Hermes running in the tray so mail keeps syncing
  // and notifications keep arriving.
  mainWindow.on('close', (event) => {
    writeWindowState();
    if (quitting || !tray) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Renderer to main bridge ------------------------------------------------
// Deliberately one channel with a fixed shape rather than a general IPC
// surface. The renderer can tell the shell two things: which theme it is
// showing (so the next launch paints the right background) and what the
// taskbar overlay should look like (because only the renderer can rasterise a
// number).

ipcMain.on('hermes:chrome', (event, payload) => {
  // Only the app's own window may drive the shell.
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  if (!payload || typeof payload !== 'object') return;

  if (payload.theme === 'light' || payload.theme === 'dark') {
    if (payload.theme !== savedTheme) {
      savedTheme = payload.theme;
      writeWindowState();
    }
  }

  if (typeof payload.badgeDataUrl === 'string' && process.platform === 'win32') {
    // A PNG data URL and nothing else.
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(payload.badgeDataUrl)) return;
    if (payload.badgeDataUrl.length > 64 * 1024) return;
    try {
      const image = nativeImage.createFromDataURL(payload.badgeDataUrl);
      if (!image.isEmpty()) mainWindow.setOverlayIcon?.(image, `${unreadTotal} unread`);
    } catch { /* an overlay is decoration; never fail the app over it */ }
  }
});

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
  try { backendProcess?.kill(); } catch { /* already gone */ }
});
