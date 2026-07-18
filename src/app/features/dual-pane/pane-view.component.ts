import { CommonModule } from '@angular/common';
import { Component, Input, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PaneId, S3ListItem } from '../../core/models/models';
import { ConnectionService } from '../../core/services/connection.service';
import { ElectronService } from '../../core/services/electron.service';
import { PaneService } from '../../core/services/pane.service';
import { TransferService } from '../../core/services/transfer.service';
import { ContextMenuComponent, ContextMenuEntry } from '../context-menu/context-menu.component';

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * One side of the dual-pane view. Fully self-contained: connection/bucket
 * pickers, breadcrumbs, file table, its own mini toolbar, and a right-click
 * context menu - everything needed to browse and act on this pane without
 * touching the single-active-tab view at all.
 */
@Component({
  selector: 'app-pane-view',
  standalone: true,
  imports: [CommonModule, FormsModule, ContextMenuComponent],
  templateUrl: './pane-view.component.html',
  styleUrl: './pane-view.component.scss'
})
export class PaneViewComponent {
  @Input({ required: true }) paneId!: PaneId;

  readonly addingFolder = signal(false);
  newFolderName = '';

  readonly contextMenu = signal<{ x: number; y: number } | null>(null);

  readonly otherPaneReady = computed(() => {
    const otherId = this.paneId === 'left' ? 'right' : 'left';
    const other = this.panes.pane(otherId);
    return !!other.connectionId && !!other.bucket;
  });

  readonly contextMenuItems = computed<ContextMenuEntry[]>(() => {
    const p = this.panes.pane(this.paneId);
    const count = p.selectedKeys.size;
    if (!count) return [];
    const canSend = this.otherPaneReady();

    const entries: ContextMenuEntry[] = [
      { type: 'item', id: 'download', label: 'Download', icon: 'fi-rr-download', colorClass: 'ic-green' }
    ];
    if (canSend) {
      entries.push(
        { type: 'item', id: 'copy', label: 'Copy to other pane', icon: 'fi-rr-copy', colorClass: 'ic-teal' },
        { type: 'item', id: 'move', label: 'Move to other pane', icon: this.moveArrowIcon, colorClass: 'ic-purple' }
      );
    }
    entries.push({ type: 'divider' }, { type: 'item', id: 'delete', label: 'Delete', icon: 'fi-rr-trash', colorClass: 'ic-red', danger: true });
    return entries;
  });

  constructor(
    public panes: PaneService,
    public connectionService: ConnectionService,
    private electron: ElectronService,
    private transfers: TransferService
  ) {}

  formatBytes = formatBytes;

  get state() {
    return this.panes.pane(this.paneId);
  }

  /** Points toward whichever side the other pane actually sits on, so the move icon reads correctly on both sides. */
  get moveArrowIcon(): string {
    return this.paneId === 'left' ? 'fi-rr-arrow-right' : 'fi-rr-arrow-left';
  }

  async onConnectionChange(connectionId: string): Promise<void> {
    const conn = this.connectionService.connections().find((c) => c.id === connectionId);
    await this.panes.setConnection(this.paneId, connectionId, conn?.name ?? 'Connection');
  }

  onBucketChange(bucket: string): void {
    this.panes.openBucket(this.paneId, bucket);
  }

  onBreadcrumbClick(prefix: string): void {
    this.panes.openPrefix(this.paneId, prefix);
  }

  onRowClick(item: S3ListItem, ev: MouseEvent): void {
    this.panes.toggleSelect(this.paneId, item.key, !(ev.ctrlKey || ev.metaKey));
  }

  onRowDoubleClick(item: S3ListItem): void {
    this.panes.openFolderItem(this.paneId, item);
  }

  onRowContextMenu(item: S3ListItem, ev: MouseEvent): void {
    ev.preventDefault();
    if (!this.state.selectedKeys.has(item.key)) {
      this.panes.toggleSelect(this.paneId, item.key, true);
    }
    this.contextMenu.set({ x: ev.clientX, y: ev.clientY });
  }

  onContextMenuAction(actionId: string): void {
    switch (actionId) {
      case 'download':
        this.download();
        break;
      case 'copy':
        this.copyToOtherPane(false);
        break;
      case 'move':
        this.copyToOtherPane(true);
        break;
      case 'delete':
        this.deleteSelected();
        break;
    }
  }

  isSelected(key: string): boolean {
    return this.state.selectedKeys.has(key);
  }

  refresh(): void {
    this.panes.refresh(this.paneId);
  }

  uploadFiles(): void {
    const p = this.state;
    if (p.connectionId && p.bucket) this.transfers.uploadFilesDialog(p.bucket, p.prefix, p.connectionId);
  }

  download(): void {
    const p = this.state;
    if (!p.bucket) return;
    const items = p.items
      .filter((i) => i.type === 'file' && p.selectedKeys.has(i.key))
      .map((i) => ({ key: i.key, name: i.name, size: i.size }));
    if (items.length) this.transfers.downloadItemsDialog(p.bucket, items, p.connectionId ?? undefined);
  }

  /**
   * Sends the current selection to whatever the other pane is showing via the
   * Transfer Queue (rather than awaiting completion here) so cross-pane
   * copies/moves get progress, pause/cancel, and error reporting like any
   * other transfer. Selection is cleared immediately for a move since the
   * originals are on their way out; a copy leaves the source selection as-is.
   */
  copyToOtherPane(move: boolean): void {
    const src = this.state;
    const otherId: PaneId = this.paneId === 'left' ? 'right' : 'left';
    const dest = this.panes.pane(otherId);
    if (!src.connectionId || !src.bucket || !dest.connectionId || !dest.bucket) return;
    const items = src.items.filter((i) => src.selectedKeys.has(i.key));
    if (!items.length) return;

    this.transfers.enqueueCopyMove({
      items,
      srcConnectionId: src.connectionId,
      srcBucket: src.bucket,
      srcPrefix: src.prefix,
      destConnectionId: dest.connectionId,
      destBucket: dest.bucket,
      destPrefix: dest.prefix,
      move
    });

    if (move) this.panes.clearSelection(this.paneId);
  }

  async deleteSelected(): Promise<void> {
    const count = this.state.selectedKeys.size;
    if (!count) return;
    const ok = await this.electron.api.dialogs.confirm(`Delete ${count} item(s)?`, 'This action cannot be undone.');
    if (ok) await this.panes.deleteSelected(this.paneId);
  }

  startAddFolder(): void {
    this.newFolderName = '';
    this.addingFolder.set(true);
  }

  cancelAddFolder(): void {
    this.addingFolder.set(false);
  }

  async confirmAddFolder(): Promise<void> {
    const name = this.newFolderName.trim();
    if (!name) return;
    await this.panes.createFolder(this.paneId, name);
    this.addingFolder.set(false);
  }
}
