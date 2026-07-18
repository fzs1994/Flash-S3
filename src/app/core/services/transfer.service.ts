import { computed, Injectable, NgZone, OnDestroy, signal } from '@angular/core';
import { TransferTask } from '../models/models';
import { S3BrowserService } from './s3-browser.service';
import { ElectronService } from './electron.service';

@Injectable({ providedIn: 'root' })
export class TransferService implements OnDestroy {
  readonly tasks = signal<TransferTask[]>([]);
  readonly concurrency = signal<number>(4);
  readonly partSizeMB = signal<number>(8);
  private unsubscribe: (() => void) | null = null;

  readonly activeTasks = computed(() => this.tasks().filter(t => t.status === 'active'));
  readonly queuedTasks = computed(() => this.tasks().filter(t => t.status === 'queued'));
  readonly totalSpeedBps = computed(() => this.activeTasks().reduce((sum, t) => sum + (t.speedBps || 0), 0));

  /** Last-seen status per task id, used to detect completion transitions so we don't re-trigger a refresh on every progress tick. */
  private lastStatuses = new Map<string, string>();

  constructor(
    private electron: ElectronService,
    private s3: S3BrowserService,
    private ngZone: NgZone
  ) {
    if (this.electron.isElectron) {
      // ipcRenderer 'on' listeners fire outside Angular's zone (they aren't a
      // zone-patched API), so signal updates here wouldn't trigger change
      // detection without explicitly re-entering the zone. Without this, the
      // transfer queue UI only re-renders after some unrelated zone-triggered
      // event (e.g. a click) happens to run next.
      this.unsubscribe = this.electron.api.transfers.onUpdate((snapshot: TransferTask[]) => {
        this.ngZone.run(() => {
          this.refreshFoldersForNewlyCompleted(snapshot);
          this.tasks.set(snapshot);
        });
      });
      this.electron.api.transfers.getSnapshot().then((snapshot: TransferTask[]) =>
        this.ngZone.run(() => {
          this.tasks.set(snapshot);
          // Seed the baseline without triggering refreshes for tasks that
          // were already completed before this session started.
          this.lastStatuses = new Map(snapshot.map(t => [t.id, t.status]));
        })
      );
      // Concurrency/part-size are persisted in the main process across restarts -
      // pull the last-saved values so the Settings dialog doesn't reset to defaults.
      this.electron.api.transfers.getSettings().then((settings: { concurrency: number; partSizeMB: number }) =>
        this.ngZone.run(() => {
          this.concurrency.set(settings.concurrency);
          this.partSizeMB.set(settings.partSizeMB);
        })
      );
    }
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
  }

  /** Auto-refreshes any open tab's listing when an upload targeting its current folder just completed. */
  private refreshFoldersForNewlyCompleted(snapshot: TransferTask[]): void {
    const foldersToRefresh: { connectionId: string; bucket: string; prefix: string }[] = [];

    for (const task of snapshot) {
      const prevStatus = this.lastStatuses.get(task.id);
      if (task.type === 'upload' && task.status === 'completed' && prevStatus !== 'completed') {
        const slashIdx = task.key.lastIndexOf('/');
        const prefix = slashIdx >= 0 ? task.key.slice(0, slashIdx + 1) : '';
        foldersToRefresh.push({ connectionId: task.connectionId, bucket: task.bucket, prefix });
      }
      this.lastStatuses.set(task.id, task.status);
    }

    // Drop bookkeeping for tasks removed from the queue (e.g. "Clear Completed").
    const liveIds = new Set(snapshot.map(t => t.id));
    for (const id of this.lastStatuses.keys()) {
      if (!liveIds.has(id)) this.lastStatuses.delete(id);
    }

    const refreshedConnectionIds = new Set<string>();
    for (const folder of foldersToRefresh) {
      if (refreshedConnectionIds.has(folder.connectionId)) continue;
      const matchingTab = this.s3
        .tabs()
        .find(
          t =>
            t.connectionId === folder.connectionId &&
            t.currentBucket === folder.bucket &&
            t.currentPrefix === folder.prefix
        );
      if (matchingTab) {
        refreshedConnectionIds.add(folder.connectionId);
        this.s3.refreshListingFor(folder.connectionId);
      }
    }
  }

  async uploadFilesDialog(bucket: string, prefix: string): Promise<void> {
    const connId = this.s3.activeConnectionId();
    if (!connId) return;
    const files = await this.electron.api.dialogs.chooseFilesToUpload();
    if (files?.length) await this.electron.api.transfers.enqueueUpload(connId, bucket, prefix, files);
  }

  async uploadFolderDialog(bucket: string, prefix: string): Promise<void> {
    const connId = this.s3.activeConnectionId();
    if (!connId) return;
    const folders = await this.electron.api.dialogs.chooseFolderToUpload();
    if (folders?.length) await this.electron.api.transfers.enqueueUpload(connId, bucket, prefix, folders);
  }

  async downloadItemsDialog(bucket: string, items: { key: string; name: string; size?: number }[]): Promise<void> {
    const connId = this.s3.activeConnectionId();
    if (!connId || !items.length) return;
    const destDir = await this.electron.api.dialogs.chooseDownloadDestination();
    if (!destDir) return;
    await this.electron.api.transfers.enqueueDownload(connId, bucket, items, destDir);
  }

  pause(taskId: string): void {
    this.electron.api.transfers.pause(taskId);
  }
  resume(taskId: string): void {
    this.electron.api.transfers.resume(taskId);
  }
  cancel(taskId: string): void {
    this.electron.api.transfers.cancel(taskId);
  }
  retry(taskId: string): void {
    this.electron.api.transfers.retry(taskId);
  }
  pauseAll(): void {
    this.electron.api.transfers.pauseAll();
  }
  resumeAll(): void {
    this.electron.api.transfers.resumeAll();
  }
  clearCompleted(): void {
    this.electron.api.transfers.clearCompleted();
  }
  async setConcurrency(n: number): Promise<void> {
    const applied = await this.electron.api.transfers.setConcurrency(n);
    this.concurrency.set(applied);
  }
  async setPartSizeMB(mb: number): Promise<void> {
    const applied = await this.electron.api.transfers.setPartSizeMB(mb);
    this.partSizeMB.set(applied);
  }
}
