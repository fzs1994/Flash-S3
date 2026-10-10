import { Injectable, NgZone, computed, signal } from '@angular/core';
import { AppSettings, DEFAULT_APP_SETTINGS } from '../models/models';
import { ElectronService } from './electron.service';

const DATE_FORMATS: Record<AppSettings['dateFormat'], string> = {
  short: 'short',
  iso: 'yyyy-MM-dd HH:mm:ss',
  dmy: 'dd/MM/yyyy HH:mm',
  long: 'MMM d, y, h:mm a'
};

/**
 * Renderer-side mirror of the persisted General Settings (owned by the main
 * process, see electron/services/app-settings.js). Every window loads it on
 * startup and stays in sync through the 'appSettings:changed' broadcast, so a
 * change saved in the settings window shows up in the main window immediately.
 */
@Injectable({ providedIn: 'root' })
export class AppSettingsService {
  readonly settings = signal<AppSettings>(DEFAULT_APP_SETTINGS);
  private readonly loaded: Promise<void>;

  /** Angular `date` pipe format / timezone arguments derived from the display preferences. */
  readonly dateFormat = computed(() => DATE_FORMATS[this.settings().dateFormat]);
  readonly timeZone = computed(() => (this.settings().timeZone === 'utc' ? 'UTC' : undefined));

  constructor(
    private electron: ElectronService,
    zone: NgZone
  ) {
    if (!electron.isElectron || !electron.api.settings?.get) {
      this.loaded = Promise.resolve();
      return;
    }
    electron.api.settings.onChange((s: AppSettings) => zone.run(() => this.settings.set(s)));
    this.loaded = electron.api.settings
      .get()
      .then((s: AppSettings) => zone.run(() => this.settings.set(s)))
      .catch(() => {});
  }

  /** Resolves once the persisted settings have been read (or immediately outside Electron). */
  ready(): Promise<void> {
    return this.loaded;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next: AppSettings = await this.electron.api.settings.set(patch);
    this.settings.set(next);
    return next;
  }

  /** Formats a byte count per the "size units" preference. */
  formatSize(bytes?: number | null): string {
    if (bytes === undefined || bytes === null) return '';
    const mode = this.settings().sizeUnits;
    if (mode === 'bytes') return `${Math.round(bytes).toLocaleString()} B`;
    if (bytes === 0) return '0 B';
    const base = mode === 'decimal' ? 1000 : 1024;
    const units = mode === 'decimal' ? ['B', 'kB', 'MB', 'GB', 'TB'] : ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(base)));
    return `${(bytes / Math.pow(base, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
}
