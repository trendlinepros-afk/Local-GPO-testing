'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');

const gpo = require('./gpo');
const updater = require('./updater');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#0f1420',
    title: 'Local GPO Compliance Tester',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open external links (e.g. the standard's reference URL) in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  updater.init(mainWindow);
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [{ role: 'quit' }]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Project on GitHub',
          click: () => shell.openExternal('https://github.com/trendlinepros-afk/Local-GPO-testing')
        },
        {
          label: 'Check for Updates…',
          click: () => updater.check()
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC -------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

handle('app:version', () => app.getVersion());
handle('platform:info', () => gpo.platformInfo());
handle('baselines:list', () => gpo.listBaselines());
handle('gpo:comparison', (standardId) => gpo.getComparison(standardId));
handle('gpo:scan', (standardId) => gpo.scan(standardId));
handle('gpo:apply', ({ standardId, settingIds }) => gpo.apply(standardId, settingIds));
handle('gpo:batches', () => gpo.getBatches());
handle('gpo:revert', (options) => gpo.revert(options));
handle('report:export', async (standardId) => {
  const { html, filename } = await gpo.buildReport(standardId);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save compliance report',
    defaultPath: filename,
    filters: [{ name: 'HTML report', extensions: ['html'] }]
  });
  if (result.canceled || !result.filePath) return { saved: false };
  fs.writeFileSync(result.filePath, html, 'utf8');
  return { saved: true, path: result.filePath };
});
handle('updater:check', () => updater.check());
handle('updater:download', () => updater.download());
handle('updater:install', () => updater.install());

// ---- Lifecycle -------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.trendlinepros.localgpocompliancetester');
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
