const Store = require('electron-store');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const oneOf = (...values) => (v, fallback) => (values.includes(v) ? v : fallback);
const int = (min, max) => (v, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const str = (v, fallback) => (typeof v === 'string' ? v : fallback);

/** Every user preference exposed in General Settings: default value + a validator that clamps/rejects bad input. */
const SCHEMA = {
  // Appearance ('system' = no explicit choice yet; the renderer falls back to its own stored/OS preference)
  theme: { default: 'system', check: oneOf('system', 'light', 'dark') },
  // Transfers
  retryCount: { default: 0, check: int(0, 10) },
  retryBackoffSeconds: { default: 5, check: int(1, 300) },
  ifExists: { default: 'overwrite', check: oneOf('ask', 'skip', 'overwrite', 'rename') },
  keepPartialDownloads: { default: true, check: bool },
  // Browsing
  defaultSortKey: { default: 'name', check: oneOf('name', 'ext', 'size', 'date', 'class') },
  defaultSortDir: { default: 'asc', check: oneOf('asc', 'desc') },
  defaultView: { default: 'single', check: oneOf('single', 'dual') },
  showHiddenItems: { default: true, check: bool },
  dateFormat: { default: 'short', check: oneOf('short', 'iso', 'dmy', 'long') },
  timeZone: { default: 'local', check: oneOf('local', 'utc') },
  sizeUnits: { default: 'binary', check: oneOf('binary', 'decimal', 'bytes') },
  pageSize: { default: 1000, check: int(100, 1000) },
  // Safety
  confirmDelete: { default: true, check: bool },
  typeToConfirmProduction: { default: false, check: bool },
  presignExpirySeconds: { default: 3600, check: int(60, 604800) },
  defaultDownloadFolder: { default: '', check: str },
  lockAfterMinutes: { default: 0, check: int(0, 240) },
  // Network
  requestTimeoutSeconds: { default: 0, check: int(0, 3600) },
  // App
  startup: { default: 'normal', check: oneOf('normal', 'minimized', 'tray') },
  closeToTray: { default: false, check: bool },
  restoreLastSession: { default: false, check: bool },
  notifyOnComplete: { default: true, check: bool },
  checkUpdatesOnLaunch: { default: true, check: bool }
};

/**
 * Persisted app-wide preferences (everything in the General Settings window
 * except the transfer concurrency / part size / speed limits, which the
 * transfer queue owns). Emits 'change' with the full, sanitized settings
 * whenever something is updated so other services and windows can react.
 */
class AppSettings extends EventEmitter {
  constructor() {
    super();
    this.store = new Store({ name: 'flash-s3-app-settings' });
  }

  get() {
    const saved = this.store.get('settings', {});
    const out = {};
    for (const [key, def] of Object.entries(SCHEMA)) out[key] = def.check(saved[key], def.default);
    // An idle lock without a PIN would lock the user out of nothing and protect nothing.
    if (!this.hasPin()) out.lockAfterMinutes = 0;
    return out;
  }

  set(patch) {
    const current = this.get();
    const next = { ...current };
    for (const [key, value] of Object.entries(patch || {})) {
      if (SCHEMA[key]) next[key] = SCHEMA[key].check(value, current[key]);
    }
    if (!this.hasPin()) next.lockAfterMinutes = 0;
    this.store.set('settings', next);
    this.emit('change', next);
    return next;
  }

  // ---- App lock PIN (stored as a salted scrypt hash, never in plain text) ----

  hasPin() {
    return !!this.store.get('lock.hash');
  }

  _hash(pin, salt) {
    return crypto.scryptSync(String(pin), salt, 32).toString('hex');
  }

  verifyPin(pin) {
    const salt = this.store.get('lock.salt');
    const hash = this.store.get('lock.hash');
    if (!salt || !hash) return true;
    const a = Buffer.from(this._hash(pin, salt), 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Sets or changes the PIN. When one already exists, `currentPin` must match. */
  setPin(newPin, currentPin) {
    if (typeof newPin !== 'string' || newPin.length < 4 || newPin.length > 64) {
      return { ok: false, error: 'PIN must be 4-64 characters.' };
    }
    if (this.hasPin() && !this.verifyPin(currentPin)) return { ok: false, error: 'Current PIN is incorrect.' };
    const salt = crypto.randomBytes(16).toString('hex');
    this.store.set('lock.salt', salt);
    this.store.set('lock.hash', this._hash(newPin, salt));
    this.emit('change', this.get());
    return { ok: true };
  }

  clearPin(currentPin) {
    if (this.hasPin() && !this.verifyPin(currentPin)) return { ok: false, error: 'Current PIN is incorrect.' };
    this.store.delete('lock');
    // Persist lock-off now that nothing can unlock it.
    this.set({ lockAfterMinutes: 0 });
    return { ok: true };
  }
}

module.exports = { AppSettings, SCHEMA };
