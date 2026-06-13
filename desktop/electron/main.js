const { app, BrowserWindow, shell, globalShortcut } = require('electron');
const path = require('path');
const fs   = require('fs');
const http = require('http');

let mainWindow;
const BACKEND_PORT = 3001;

// Resolve icon path (works both in dev and after packaging)
function getIconPath() {
  const candidates = [
    path.join(__dirname, '../build/icons/icon.ico'),
    path.join(process.resourcesPath || '', 'build/icons/icon.ico'),
  ];
  return candidates.find(p => fs.existsSync(p));
}

// Wait for the backend Express server to be ready
function waitForBackend(maxRetries = 40) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      http.get(`http://localhost:${BACKEND_PORT}/api/health`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      }).on('error', retry);
    };
    const retry = () => {
      attempts++;
      if (attempts >= maxRetries) {
        reject(new Error('Backend did not start in time'));
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });
}

// Start the Express backend in the same Node.js process
function startBackend() {
  // Tell the backend where to store user data (writable AppData location)
  process.env.HERMES_DATA_DIR = app.getPath('userData');
  const backendEntry = path.join(__dirname, '../backend/server.js');
  require(backendEntry);
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
    },
    title: 'Hermes',
    icon: getIconPath(),
    show: false,
    backgroundColor: '#0d1117',
  });

  mainWindow.loadURL(`http://localhost:${BACKEND_PORT}`);

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
    if (url.startsWith(`http://localhost`)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    globalShortcut.unregisterAll();
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Set the app icon in the taskbar (Windows/Linux)
  if (process.platform !== 'darwin') {
    const icon = getIconPath();
    if (icon) app.setAppUserModelId('com.hermes.app');
  }

  try {
    startBackend();
    await waitForBackend();
    createWindow();
  } catch (err) {
    console.error('Failed to start Hermes:', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
