import { Injectable, computed, signal } from '@angular/core';
import { ElectronService } from './electron.service';

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  version: string | null;
  percent: number;
  error: string | null;
  manual: boolean;
  enabled: boolean;
  currentVersion: string;
}

/** Mirrors the main-process updater (electron/services/updater.js). */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  readonly state = signal<UpdateState | null>(null);
  readonly dismissed = signal(false);

  /** Statuses worth interrupting the user for; 'idle'/'checking' render nothing. */
  readonly visible = computed(() => {
    const s = this.state();
    return !this.dismissed() && !!s && ['available', 'downloading', 'ready', 'error'].includes(s.status);
  });

  constructor(private electron: ElectronService) {
    if (!electron.isElectron || !electron.api.updater) return;
    const api = electron.api.updater;
    api.getState().then((s: UpdateState) => this.state.set(s));
    api.onState((s: UpdateState) => {
      if (s.status !== this.state()?.status) this.dismissed.set(false);
      this.state.set(s);
    });
  }

  check(): void {
    this.electron.api.updater.check();
  }
  download(): void {
    this.electron.api.updater.download();
  }
  install(): void {
    this.electron.api.updater.install();
  }
}
