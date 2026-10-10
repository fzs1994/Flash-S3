const { app, shell } = require('electron');

const RELEASES_URL = 'https://github.com/fzs1994/Flash-S3/releases/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Checks GitHub Releases for a newer version (via electron-updater, which reads
 * the latest.yml published with each release) and downloads and
 * installs it when the user asks. macOS builds are unsigned, so there the update can't be applied
 * in place - the UI is pointed at the release page instead.
 */
class UpdaterService {
  constructor(getWindow) {
    this.getWindow = getWindow;
    this.state = { status: 'idle', version: null, percent: 0, error: null, manual: process.platform === 'darwin' };
    this.autoUpdater = null;

    // Updating only makes sense for installed builds; dev runs have no latest.yml.
    if (!app.isPackaged) return;
    const { autoUpdater } = require('electron-updater');
    this.autoUpdater = autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => {
      this.set({ status: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', () => this.set({ status: 'idle' }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => this.set({ status: 'error', error: err?.message || String(err) }));
  }

  start() {
    if (!this.autoUpdater) return;
    setTimeout(() => this.check(false), 5000);
    setInterval(() => this.check(false), CHECK_INTERVAL_MS).unref();
  }

  getState() {
    return { ...this.state, enabled: !!this.autoUpdater, currentVersion: app.getVersion() };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('updater:state', this.getState());
  }

  async check(userInitiated) {
    if (!this.autoUpdater || ['checking', 'downloading', 'ready'].includes(this.state.status)) return this.getState();
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (err) {
      // Background checks fail silently (offline etc.); manual ones report it.
      if (userInitiated) this.set({ status: 'error', error: err?.message || String(err) });
      else this.set({ status: 'idle' });
    }
    return this.getState();
  }

  async download() {
    if (!this.autoUpdater) return;
    if (this.state.manual) return shell.openExternal(RELEASES_URL);
    try {
      this.set({ status: 'downloading', percent: 0 });
      await this.autoUpdater.downloadUpdate();
    } catch (err) {
      this.set({ status: 'error', error: err?.message || String(err) });
    }
  }

  install() {
    if (this.autoUpdater && this.state.status === 'ready') this.autoUpdater.quitAndInstall();
  }
}

module.exports = { UpdaterService };
