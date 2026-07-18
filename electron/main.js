const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { registerIpcHandlers } = require('./ipc/register');

let mainWindow = null;

// App icon for the window/taskbar at runtime (dev mode included). Windows
// prefers the multi-size .ico; Linux uses the .png. macOS ignores this
// option (the dock icon comes from the .icns in the app bundle, set below).
const windowIconPath = path.join(
  __dirname,
  '..',
  'build-resources',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png'
);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#f0f2f5',
    title: 'Flash S3 Browser',
    icon: windowIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(true);

  const startUrl = process.env.ELECTRON_START_URL;
  if (startUrl) {
    mainWindow.loadURL(startUrl);
    // Auto-open DevTools in dev mode so IPC/renderer errors (e.g. a stale
    // preload bridge after adding a new IPC channel) are visible immediately
    // instead of failing silently in the UI.
    // mainWindow.webContents.openDevTools({ mode: 'right' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 's3-browser-clone', 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

app.whenReady().then(() => {
  // macOS dev-mode dock icon (packaged builds get it from the bundle's .icns).
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, '..', 'build-resources', 'icon.png'));
  }
  const win = createWindow();
  registerIpcHandlers(ipcMain, () => mainWindow || win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
