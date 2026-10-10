import { CommonModule } from '@angular/common';
import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppSettings, DEFAULT_APP_SETTINGS } from '../../core/models/models';
import { AppSettingsService } from '../../core/services/app-settings.service';
import { ElectronService } from '../../core/services/electron.service';
import { ThemeService } from '../../core/services/theme.service';
import { UpdateService } from '../../core/services/update.service';
import { DropdownComponent, DropdownOption } from '../dropdown/dropdown.component';

interface TransferLimits {
  concurrency: number;
  partSizeMB: number;
  uploadMBps: number;
  downloadMBps: number;
}

type Form = AppSettings & TransferLimits;

const opts = (pairs: [any, string][]): DropdownOption[] => pairs.map(([value, label]) => ({ value, label }));

/** Root component of the separate "General Settings" window (see electron/main.js openSettingsWindow). */
@Component({
  selector: 'app-settings-window',
  standalone: true,
  imports: [CommonModule, FormsModule, DropdownComponent],
  templateUrl: './settings-window.component.html',
  styleUrl: './settings-window.component.scss'
})
export class SettingsWindowComponent implements OnInit {
  readonly themeOptions: DropdownOption[] = [
    { value: 'light', label: 'Light', icon: 'fi-sr-sun ic-amber' },
    { value: 'dark', label: 'Dark', icon: 'fi-sr-moon ic-purple' }
  ];
  readonly concurrencyOptions = opts([1, 2, 3, 4, 6, 8, 12, 16].map((n) => [n, String(n)] as [number, string]));
  readonly retryOptions = opts(Array.from({ length: 11 }, (_, n) => [n, n === 0 ? 'No retries' : `${n} ${n === 1 ? 'retry' : 'retries'}`] as [number, string]));
  readonly ifExistsOptions = opts([
    ['overwrite', 'Overwrite'],
    ['ask', 'Ask me each time'],
    ['skip', 'Skip'],
    ['rename', 'Keep both (rename the new one)']
  ]);
  readonly sortKeyOptions = opts([
    ['name', 'Name'],
    ['ext', 'Type'],
    ['size', 'Size'],
    ['date', 'Last modified'],
    ['class', 'Storage class']
  ]);
  readonly sortDirOptions = opts([
    ['asc', 'Ascending'],
    ['desc', 'Descending']
  ]);
  readonly viewOptions = opts([
    ['single', 'Single pane'],
    ['dual', 'Dual pane']
  ]);
  readonly dateFormatOptions = opts([
    ['short', 'System short (10/10/26, 3:45 PM)'],
    ['iso', 'ISO (2026-10-10 15:45:00)'],
    ['dmy', 'Day first (10/10/2026 15:45)'],
    ['long', 'Long (Oct 10, 2026, 3:45 PM)']
  ]);
  readonly timeZoneOptions = opts([
    ['local', 'Local time'],
    ['utc', 'UTC']
  ]);
  readonly sizeUnitOptions = opts([
    ['binary', 'Binary (1 KB = 1024 B)'],
    ['decimal', 'Decimal (1 kB = 1000 B)'],
    ['bytes', 'Exact bytes']
  ]);
  readonly expiryOptions = opts([
    [900, '15 minutes'],
    [3600, '1 hour'],
    [21600, '6 hours'],
    [86400, '1 day'],
    [604800, '7 days (maximum)']
  ]);
  readonly lockOptions = opts([
    [0, 'Never'],
    [1, 'After 1 minute'],
    [5, 'After 5 minutes'],
    [10, 'After 10 minutes'],
    [15, 'After 15 minutes'],
    [30, 'After 30 minutes'],
    [60, 'After 1 hour']
  ]);
  readonly startupOptions = opts([
    ['normal', 'Open normally'],
    ['minimized', 'Start minimized'],
    ['tray', 'Start hidden in the system tray']
  ]);

  form: Form = { ...DEFAULT_APP_SETTINGS, concurrency: 4, partSizeMB: 8, uploadMBps: 0, downloadMBps: 0 };
  readonly tabs: { id: string; label: string; icon: string; color: string }[] = [
    { id: 'transfers', label: 'Transfers', icon: 'fi-sr-exchange', color: 'ic-blue' },
    { id: 'browsing', label: 'Browsing', icon: 'fi-sr-folder-open', color: 'ic-amber' },
    { id: 'safety', label: 'Safety', icon: 'fi-sr-shield-check', color: 'ic-green' },
    { id: 'app', label: 'App', icon: 'fi-sr-apps', color: 'ic-blue' },
    { id: 'about', label: 'About', icon: 'fi-sr-info', color: 'ic-muted' }
  ];
  readonly activeTab = signal('transfers');

  get versions(): { electron?: string; chrome?: string; node?: string } {
    return this.electron.api.versions ?? {};
  }

  get platformLabel(): string {
    const names: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
    return names[this.electron.api.platform] ?? this.electron.api.platform;
  }
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly saved = signal(false);

  readonly hasPin = signal(false);
  currentPin = '';
  newPin = '';
  readonly pinMessage = signal<{ ok: boolean; text: string } | null>(null);

  constructor(
    private electron: ElectronService,
    public appSettings: AppSettingsService,
    public theme: ThemeService,
    public updates: UpdateService
  ) {}

  async ngOnInit(): Promise<void> {
    document.title = 'General Settings';
    try {
      await this.appSettings.ready();
      const transfers = await this.electron.api.transfers.getSettings();
      this.form = { ...this.appSettings.settings(), ...transfers };
      this.hasPin.set(await this.electron.api.lock.hasPin());
    } catch {
      this.error.set('Could not load settings. Please fully quit and restart Flash S3.');
    }
  }

  private validMBps(v: unknown): boolean {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 100000;
  }

  private validInt(v: unknown, min: number, max: number): boolean {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max;
  }

  async browseDownloadFolder(): Promise<void> {
    const dir = await this.electron.api.dialogs.chooseDownloadDestination();
    if (dir) this.form.defaultDownloadFolder = dir;
  }

  async setPin(): Promise<void> {
    const res = await this.electron.api.lock.setPin(this.newPin, this.hasPin() ? this.currentPin : undefined);
    if (res.ok) {
      this.hasPin.set(true);
      this.pinMessage.set({ ok: true, text: 'PIN saved.' });
      this.currentPin = '';
      this.newPin = '';
    } else {
      this.pinMessage.set({ ok: false, text: res.error });
    }
  }

  async removePin(): Promise<void> {
    const res = await this.electron.api.lock.clearPin(this.currentPin);
    if (res.ok) {
      this.hasPin.set(false);
      this.form.lockAfterMinutes = 0;
      this.pinMessage.set({ ok: true, text: 'PIN removed; idle lock is off.' });
      this.currentPin = '';
    } else {
      this.pinMessage.set({ ok: false, text: res.error });
    }
  }

  async save(): Promise<void> {
    const f = this.form;
    if (!this.validInt(f.partSizeMB, 5, 500)) return this.fail('Part size must be a whole number between 5 and 500 MB.');
    if (!this.validMBps(f.uploadMBps) || !this.validMBps(f.downloadMBps)) {
      return this.fail('Speed limits must be 0 (unlimited) or a positive number of MB/s.');
    }
    if (!this.validInt(f.retryBackoffSeconds, 1, 300)) return this.fail('Retry delay must be between 1 and 300 seconds.');
    if (!this.validInt(f.pageSize, 100, 1000)) return this.fail('Objects per page must be between 100 and 1000.');
    if (!this.validInt(f.requestTimeoutSeconds, 0, 3600)) return this.fail('Request timeout must be 0 (none) to 3600 seconds.');

    this.saving.set(true);
    this.error.set(null);
    this.saved.set(false);
    try {
      const t = this.electron.api.transfers;
      // `theme` is saved the moment it is picked, so keep this form's copy from overwriting it.
      const { concurrency, partSizeMB, uploadMBps, downloadMBps, theme: _theme, ...appPatch } = f;
      await Promise.all([
        t.setConcurrency(Number(concurrency)),
        t.setPartSizeMB(Number(partSizeMB)),
        t.setSpeedLimits({ uploadMBps: Number(uploadMBps), downloadMBps: Number(downloadMBps) }),
        this.appSettings.update(appPatch)
      ]);
      // Re-read so the form shows what was actually stored after clamping.
      this.form = { ...this.appSettings.settings(), ...(await t.getSettings()) };
      this.saved.set(true);
      this.close();
    } catch (err: any) {
      this.error.set(
        err?.message?.includes('No handler registered')
          ? 'Could not reach the app backend. Please fully quit and restart Flash S3, then try again.'
          : err?.message || 'Failed to save settings.'
      );
    } finally {
      this.saving.set(false);
    }
  }

  private fail(message: string): void {
    this.saved.set(false);
    this.error.set(message);
  }

  close(): void {
    window.close();
  }
}
