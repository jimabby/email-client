const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow;
const BACKEND_PORT = 3001;

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
    show: false,
    backgroundColor: '#0f172a',
  });

  mainWindow.loadURL(`http://localhost:${BACKEND_PORT}`);

  // Only show once the page has loaded (prevents white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in the system browser, not inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://localhost`)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    startBackend();
    await waitForBackend();
    createWindow();
  } catch (err) {
    console.error('Failed to start AI Mail:', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
