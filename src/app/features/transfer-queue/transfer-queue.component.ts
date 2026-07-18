import { CommonModule } from '@angular/common';
import { Component, Input, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TransferTask } from '../../core/models/models';
import { TransferService } from '../../core/services/transfer.service';

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatEta(seconds: number | null): string {
  if (seconds === null || !isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `${m}m ${s}s`;
}

@Component({
  selector: 'app-transfer-queue',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './transfer-queue.component.html',
  styleUrl: './transfer-queue.component.scss'
})
export class TransferQueueComponent {
  /** Expanded-state height in px, controlled by the drag handle in AppComponent. */
  @Input() panelHeight = 240;

  readonly collapsed = signal(false);
  readonly concurrencyOptions = [1, 2, 3, 4, 6, 8, 12, 16];

  readonly showSettings = signal(false);
  readonly settingsError = signal<string | null>(null);
  readonly settingsSaving = signal(false);
  settingsForm = { concurrency: 4, partSizeMB: 8 };

  readonly summary = computed(() => {
    const tasks = this.transfers.tasks();
    return {
      active: tasks.filter(t => t.status === 'active').length,
      queued: tasks.filter(t => t.status === 'queued').length,
      errors: tasks.filter(t => t.status === 'error').length,
      total: tasks.length
    };
  });

  constructor(public transfers: TransferService) {}

  formatBytes = formatBytes;
  formatEta = formatEta;

  toggleCollapsed(): void {
    this.collapsed.set(!this.collapsed());
  }

  onConcurrencyChange(ev: Event): void {
    const value = Number((ev.target as HTMLSelectElement).value);
    this.transfers.setConcurrency(value);
  }

  openSettings(): void {
    this.settingsForm = {
      concurrency: Number(this.transfers.concurrency()),
      partSizeMB: Number(this.transfers.partSizeMB())
    };
    this.settingsError.set(null);
    this.showSettings.set(true);
  }

  closeSettings(): void {
    this.showSettings.set(false);
  }

  async applySettings(): Promise<void> {
    const concurrency = Number(this.settingsForm.concurrency);
    const partSizeMB = Number(this.settingsForm.partSizeMB);

    if (!Number.isFinite(partSizeMB) || partSizeMB < 5 || partSizeMB > 500) {
      this.settingsError.set('Part size must be a number between 5 and 500 MB.');
      return;
    }

    this.settingsSaving.set(true);
    this.settingsError.set(null);
    try {
      await Promise.all([this.transfers.setConcurrency(concurrency), this.transfers.setPartSizeMB(partSizeMB)]);
      this.showSettings.set(false);
    } catch (err: any) {
      // Most common cause: the Electron main process (preload/IPC handlers) hasn't
      // been restarted since these settings were added - `npm start`'s live reload
      // only refreshes the Angular renderer, not the Electron shell itself.
      this.settingsError.set(
        err?.message?.includes('No handler registered') || err?.message?.includes('electronAPI bridge')
          ? 'Could not reach the app backend. Please fully quit and restart Flash S3 Browser, then try again.'
          : err?.message || 'Failed to save settings.'
      );
    } finally {
      this.settingsSaving.set(false);
    }
  }

  statusIcon(status: TransferTask['status']): string {
    switch (status) {
      case 'active':
        return 'fi-rr-refresh fi-spin';
      case 'queued':
        return 'fi-rr-hourglass';
      case 'paused':
        return 'fi-rr-pause';
      case 'completed':
        return 'fi-rr-check';
      case 'error':
        return 'fi-rr-exclamation';
      case 'canceled':
        return 'fi-rr-cross';
      default:
        return '';
    }
  }

  trackByTaskId(_: number, task: TransferTask): string {
    return task.id;
  }
}
