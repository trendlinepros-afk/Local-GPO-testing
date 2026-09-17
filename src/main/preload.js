'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getPlatformInfo: () => ipcRenderer.invoke('platform:info'),

  listBaselines: () => ipcRenderer.invoke('baselines:list'),
  getComparison: (standardId) => ipcRenderer.invoke('gpo:comparison', standardId),
  scan: (standardId) => ipcRenderer.invoke('gpo:scan', standardId),
  apply: (standardId, settingIds) => ipcRenderer.invoke('gpo:apply', { standardId, settingIds }),
  getBatches: () => ipcRenderer.invoke('gpo:batches'),
  revert: (options) => ipcRenderer.invoke('gpo:revert', options),
  exportReport: (standardId) => ipcRenderer.invoke('report:export', standardId),

  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),

  onUpdaterEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('updater:event', listener);
    return () => ipcRenderer.removeListener('updater:event', listener);
  }
});
