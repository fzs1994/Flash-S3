import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnInit, Output, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BucketInfo } from '../../core/models/models';
import { ConnectionService } from '../../core/services/connection.service';
import { ElectronService } from '../../core/services/electron.service';
import { S3BrowserService } from '../../core/services/s3-browser.service';

/**
 * Copy/Move destination picker. Lets the user send the currently selected
 * items to a different folder in the same bucket, a different bucket, or a
 * bucket under an entirely different saved connection - runs the operation
 * itself (via S3BrowserService.copyItems) and reports completion/cancellation
 * through `closed`, so the parent just needs to show/hide this component.
 */
@Component({
  selector: 'app-copy-move-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './copy-move-dialog.component.html',
  styleUrl: './copy-move-dialog.component.scss'
})
export class CopyMoveDialogComponent implements OnInit {
  @Input() mode: 'copy' | 'move' = 'copy';
  @Output() closed = new EventEmitter<void>();

  readonly destConnectionId = signal<string | null>(null);
  readonly destBucket = signal<string | null>(null);
  destPrefix = '';

  readonly destBuckets = signal<BucketInfo[]>([]);
  readonly loadingBuckets = signal(false);
  readonly running = signal(false);
  readonly errorMsg = signal<string | null>(null);

  readonly selectedItems = computed(() => this.s3.items().filter((i) => this.s3.selectedKeys().has(i.key)));

  readonly title = computed(() => (this.mode === 'move' ? 'Move to…' : 'Copy to…'));
  readonly confirmLabel = computed(() => (this.running() ? 'Working…' : this.mode === 'move' ? 'Move' : 'Copy'));

  constructor(
    public s3: S3BrowserService,
    public connectionService: ConnectionService,
    private electron: ElectronService
  ) {}

  ngOnInit(): void {
    // Default to "here" - same connection/bucket/folder - so the destination
    // guard (can't copy something onto itself) forces at least one deliberate
    // change, rather than silently no-op'ing on an unedited default.
    const connectionId = this.s3.activeConnectionId();
    this.destConnectionId.set(connectionId);
    this.destBucket.set(this.s3.currentBucket());
    this.destPrefix = this.s3.currentPrefix();
    this.destBuckets.set(this.s3.buckets());
  }

  async onConnectionChange(connectionId: string): Promise<void> {
    this.destConnectionId.set(connectionId || null);
    this.destBucket.set(null);
    this.errorMsg.set(null);
    if (!connectionId) {
      this.destBuckets.set([]);
      return;
    }
    // Reuse the already-loaded list for the currently active connection instead of refetching.
    if (connectionId === this.s3.activeConnectionId()) {
      this.destBuckets.set(this.s3.buckets());
      return;
    }
    this.loadingBuckets.set(true);
    try {
      const buckets = await this.electron.api.s3.listBuckets(connectionId);
      this.destBuckets.set(buckets);
    } catch (err: any) {
      this.errorMsg.set(err?.message || String(err));
      this.destBuckets.set([]);
    } finally {
      this.loadingBuckets.set(false);
    }
  }

  cancel(): void {
    this.closed.emit();
  }

  async confirm(): Promise<void> {
    const connectionId = this.destConnectionId();
    const bucket = this.destBucket();
    if (!connectionId || !bucket) {
      this.errorMsg.set('Choose a destination bucket.');
      return;
    }
    const prefix = this.normalizePrefix(this.destPrefix);

    this.running.set(true);
    this.errorMsg.set(null);
    try {
      await this.s3.copyItems({ connectionId, bucket, prefix }, this.mode === 'move');
      this.closed.emit();
    } catch (err: any) {
      this.errorMsg.set(err?.message || String(err));
    } finally {
      this.running.set(false);
    }
  }

  private normalizePrefix(raw: string): string {
    const trimmed = raw.trim().replace(/^\/+/, '');
    if (!trimmed) return '';
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  }
}
