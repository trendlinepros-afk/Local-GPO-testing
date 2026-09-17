'use strict';

const { app } = require('electron');
const https = require('https');

let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (_) {
  autoUpdater = null;
}

const GITHUB_OWNER = 'trendlinepros-afk';
const GITHUB_REPO = 'Local-GPO-testing';

let win = null;
let wired = false;

function send(type, data) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:event', { type, data: data || null });
  }
}

function parseVersion(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((n) => parseInt(n, 10))
    .filter((n) => !Number.isNaN(n));
}

function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function wireAutoUpdater() {
  if (!autoUpdater || wired) return;
  wired = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) =>
    send('available', { version: info.version, releaseNotes: info.releaseNotes, releaseName: info.releaseName })
  );
  autoUpdater.on('update-not-available', (info) =>
    send('not-available', { version: info && info.version })
  );
  autoUpdater.on('error', (err) => send('error', { message: err ? String(err.message || err) : 'Unknown error' }));
  autoUpdater.on('download-progress', (p) =>
    send('progress', { percent: Math.round(p.percent), transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond })
  );
  autoUpdater.on('update-downloaded', (info) => send('downloaded', { version: info.version }));
}

function init(mainWindow) {
  win = mainWindow;
  wireAutoUpdater();
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'Local-GPO-Compliance-Tester',
        Accept: 'application/vnd.github+json'
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 404) {
          resolve(null); // no releases published yet
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API returned ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('GitHub request timed out')));
    req.end();
  });
}

/**
 * In an installed build, use electron-updater (reads the GitHub release +
 * latest.yml and can download/install). Outside a packaged build, fall back to
 * the GitHub API so the button still reports whether a newer release exists.
 */
async function check() {
  const currentVersion = app.getVersion();

  if (app.isPackaged && autoUpdater) {
    send('checking');
    try {
      await autoUpdater.checkForUpdates();
      return { mode: 'electron-updater', currentVersion };
    } catch (err) {
      send('error', { message: String(err.message || err) });
      return { mode: 'electron-updater', currentVersion, error: String(err.message || err) };
    }
  }

  // Dev / unpackaged fallback
  send('checking');
  try {
    const release = await fetchLatestRelease();
    if (!release || !release.tag_name) {
      send('not-available', { version: currentVersion });
      return { mode: 'manual', currentVersion, latestVersion: null, note: 'No published releases found yet.' };
    }
    const latest = release.tag_name;
    if (isNewer(latest, currentVersion)) {
      send('available', {
        version: latest.replace(/^v/i, ''),
        releaseName: release.name,
        releaseNotes: release.body,
        htmlUrl: release.html_url,
        manual: true
      });
    } else {
      send('not-available', { version: currentVersion });
    }
    return { mode: 'manual', currentVersion, latestVersion: latest, url: release.html_url };
  } catch (err) {
    send('error', { message: String(err.message || err) });
    return { mode: 'manual', currentVersion, error: String(err.message || err) };
  }
}

async function download() {
  if (app.isPackaged && autoUpdater) {
    try {
      await autoUpdater.downloadUpdate();
      return { started: true };
    } catch (err) {
      send('error', { message: String(err.message || err) });
      return { started: false, error: String(err.message || err) };
    }
  }
  send('error', {
    message: 'Automatic download is only available in the installed build. Please download the latest release from GitHub.'
  });
  return { started: false, error: 'not-packaged' };
}

function install() {
  if (app.isPackaged && autoUpdater) {
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { installing: true };
  }
  return { installing: false, error: 'not-packaged' };
}

module.exports = { init, check, download, install };
