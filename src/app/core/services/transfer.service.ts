import { computed, Injectable, NgZone, OnDestroy, signal } from '@angular/core';
import { S3ListItem, TransferTask } from '../models/models';
import { S3BrowserService } from './s3-browser.service';
import { ElectronService } from './electron.service';
import { PaneService } from './pane.service';

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
    private panes: PaneService,
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

  /**
   * Auto-refreshes any open tab or dual-pane view showing a folder affected by
   * a transfer that just completed - an upload's own destination folder, or
   * (for copy/move tasks) both the source and destination folders, since a
   * dual-pane move can change what both panes are looking at simultaneously.
   */
  private refreshFoldersForNewlyCompleted(snapshot: TransferTask[]): void {
    const foldersToRefresh: { connectionId: string; bucket: string; prefix: string }[] = [];

    for (const task of snapshot) {
      const prevStatus = this.lastStatuses.get(task.id);
      const justCompleted = task.status === 'completed' && prevStatus !== 'completed';
      if (justCompleted && task.type === 'upload') {
        const slashIdx = task.key.lastIndexOf('/');
        const prefix = slashIdx >= 0 ? task.key.slice(0, slashIdx + 1) : '';
        foldersToRefresh.push({ connectionId: task.connectionId, bucket: task.bucket, prefix });
      } else if (justCompleted && task.type === 'copy') {
        foldersToRefresh.push({ connectionId: task.connectionId, bucket: task.bucket, prefix: task.srcPrefix ?? '' });
        if (task.destConnectionId && task.destBucket) {
          foldersToRefresh.push({ connectionId: task.destConnectionId, bucket: task.destBucket, prefix: task.destPrefix ?? '' });
        }
      }
      this.lastStatuses.set(task.id, task.status);
    }

    // Drop bookkeeping for tasks removed from the queue (e.g. "Clear Completed").
    const liveIds = new Set(snapshot.map(t => t.id));
    for (const id of this.lastStatuses.keys()) {
      if (!liveIds.has(id)) this.lastStatuses.delete(id);
    }

    for (const folder of foldersToRefresh) {
      const matchingTab = this.s3
        .tabs()
        .find(
          t =>
            t.connectionId === folder.connectionId &&
            t.currentBucket === folder.bucket &&
            t.currentPrefix === folder.prefix
        );
      if (matchingTab) this.s3.refreshListingFor(folder.connectionId);

      for (const paneId of ['left', 'right'] as const) {
        const pane = this.panes.pane(paneId);
        if (pane.connectionId === folder.connectionId && pane.bucket === folder.bucket && pane.prefix === folder.prefix) {
          this.panes.refresh(paneId);
        }
      }
    }
  }

  /** `connectionId` defaults to the globally active tab; dual-pane view passes a specific pane's connection instead. */
  async uploadFilesDialog(bucket: string, prefix: string, connectionId?: string): Promise<void> {
    const connId = connectionId ?? this.s3.activeConnectionId();
    if (!connId) return;
    const files = await this.electron.api.dialogs.chooseFilesToUpload();
    if (files?.length) await this.electron.api.transfers.enqueueUpload(connId, bucket, prefix, files);
  }

  async uploadFolderDialog(bucket: string, prefix: string, connectionId?: string): Promise<void> {
    const connId = connectionId ?? this.s3.activeConnectionId();
    if (!connId) return;
    const folders = await this.electron.api.dialogs.chooseFolderToUpload();
    if (folders?.length) await this.electron.api.transfers.enqueueUpload(connId, bucket, prefix, folders);
  }

  async downloadItemsDialog(
    bucket: string,
    items: { key: string; name: string; size?: number }[],
    connectionId?: string
  ): Promise<void> {
    const connId = connectionId ?? this.s3.activeConnectionId();
    if (!connId || !items.length) return;
    const destDir = await this.electron.api.dialogs.chooseDownloadDestination();
    if (!destDir) return;
    await this.electron.api.transfers.enqueueDownload(connId, bucket, items, destDir);
  }

  /**
   * Queues a copy/move of `items` as a single trackable task in the Transfer
   * Queue, instead of running it synchronously and blocking on the result -
   * used by the dual-pane view so cross-pane transfers show progress/errors
   * like any other transfer. Completion auto-refreshes both the source and
   * destination folder in whichever tab(s)/pane(s) happen to be showing them.
   */
  async enqueueCopyMove(args: {
    items: S3ListItem[];
    srcConnectionId: string;
    srcBucket: string;
    srcPrefix: string;
    destConnectionId: string;
    destBucket: string;
    destPrefix: string;
    move: boolean;
  }): Promise<void> {
    if (!args.items.length) return;
    await this.electron.api.transfers.enqueueCopyMove(args);
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
