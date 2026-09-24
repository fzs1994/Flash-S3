import { CommonModule } from '@angular/common';
import { Component, HostListener, Input, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MarqueeSelectDirective, MarqueeSelectEvent, rangeKeys } from '../../core/directives/marquee-select.directive';
import { PaneId, S3ListItem } from '../../core/models/models';
import { ConnectionService } from '../../core/services/connection.service';
import { ElectronService } from '../../core/services/electron.service';
import { PaneService } from '../../core/services/pane.service';
import { TransferService } from '../../core/services/transfer.service';
import { ContextMenuComponent, ContextMenuEntry } from '../context-menu/context-menu.component';
import { PropertiesDialogComponent } from '../dialogs/properties-dialog.component';

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
  imports: [CommonModule, FormsModule, ContextMenuComponent, PropertiesDialogComponent, MarqueeSelectDirective],
  templateUrl: './pane-view.component.html',
  styleUrl: './pane-view.component.scss'
})
export class PaneViewComponent {
  @Input({ required: true }) paneId!: PaneId;

  readonly addingFolder = signal(false);
  newFolderName = '';

  readonly contextMenu = signal<{ x: number; y: number } | null>(null);
  readonly folderContextMenu = signal<{ x: number; y: number } | null>(null);
  readonly propertiesItem = signal<S3ListItem | null>(null);

  /** Row the next Shift+click range starts from. */
  private selectionAnchor: string | null = null;
  /** Selection as it was when a Ctrl/Shift rubber-band drag began. */
  private marqueeBase: ReadonlySet<string> = new Set();

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
    entries.push(
      { type: 'divider' },
      { type: 'item', id: 'delete', label: 'Delete', icon: 'fi-rr-trash', colorClass: 'ic-red', danger: true }
    );
    if (count === 1) {
      entries.push({ type: 'divider' }, { type: 'item', id: 'properties', label: 'Properties', icon: 'fi-rr-info', colorClass: 'ic-blue' });
    }
    return entries;
  });

  /** Right-click on empty space (not a specific row) - folder-level actions, matching the pane's own mini toolbar. */
  readonly folderContextMenuItems = computed<ContextMenuEntry[]>(() => {
    if (!this.state.bucket) return [];
    return [
      { type: 'item', id: 'refresh', label: 'Refresh', icon: 'fi-rr-refresh', colorClass: 'ic-blue' },
      { type: 'item', id: 'newFolder', label: 'New Folder', icon: 'fi-rr-folder', colorClass: 'ic-amber' },
      { type: 'divider' },
      { type: 'item', id: 'uploadFiles', label: 'Upload Files…', icon: 'fi-rr-upload', colorClass: 'ic-blue' },
      { type: 'item', id: 'uploadFolder', label: 'Upload Folder…', icon: 'fi-rr-upload', colorClass: 'ic-blue' }
    ];
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
    this.panes.setActivePane(this.paneId);
    const additive = ev.ctrlKey || ev.metaKey;
    // Shift+click selects the range from the anchor row; Ctrl+Shift adds it to the selection.
    if (ev.shiftKey && this.selectionAnchor) {
      const range = rangeKeys(this.state.items.map((i) => i.key), this.selectionAnchor, item.key);
      if (range.length) {
        this.panes.setSelection(this.paneId, additive ? [...this.state.selectedKeys, ...range] : range);
        return;
      }
    }
    this.panes.toggleSelect(this.paneId, item.key, !additive);
    this.selectionAnchor = item.key;
  }

  onMarqueeStart(): void {
    this.panes.setActivePane(this.paneId);
    this.marqueeBase = this.state.selectedKeys;
  }

  onMarqueeChange(ev: MarqueeSelectEvent): void {
    this.panes.setActivePane(this.paneId);
    this.panes.setSelection(this.paneId, ev.additive ? [...this.marqueeBase, ...ev.keys] : ev.keys);
  }

  onRowDoubleClick(item: S3ListItem): void {
    this.panes.openFolderItem(this.paneId, item);
  }

  onRowContextMenu(item: S3ListItem, ev: MouseEvent): void {
    ev.preventDefault();
    // Stop it reaching the pane's own contextmenu handler, which would
    // otherwise also fire and show the folder-level menu on top of this one.
    ev.stopPropagation();
    this.panes.setActivePane(this.paneId);
    if (!this.state.selectedKeys.has(item.key)) {
      this.panes.toggleSelect(this.paneId, item.key, true);
      this.selectionAnchor = item.key;
    }
    this.contextMenu.set({ x: ev.clientX, y: ev.clientY });
  }

  /** Right-click anywhere in the pane that isn't a row (rows stop propagation before this fires). */
  onContainerContextMenu(ev: MouseEvent): void {
    if (!this.state.bucket) return;
    ev.preventDefault();
    this.panes.setActivePane(this.paneId);
    this.folderContextMenu.set({ x: ev.clientX, y: ev.clientY });
  }

  /**
   * Delete removes whichever pane's selection the user last interacted with -
   * both panes' components are mounted at once in dual-pane mode, so without
   * checking `activePaneId` a single Delete press would fire in both. Also
   * ignored while typing or while a modal overlay is open, same reasoning as
   * the single-pane object list.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(ev: KeyboardEvent): void {
    if (this.panes.activePaneId() !== this.paneId) return;
    if (this.isTypingTarget(ev.target) || this.isModalOpen()) return;
    if (ev.key !== 'Delete') return;
    if (!this.state.selectedKeys.size) return;
    ev.preventDefault();
    this.deleteSelected();
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  private isModalOpen(): boolean {
    return !!document.querySelector('.connections-overlay, .settings-overlay, .cm-overlay, .props-overlay, .overlay');
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
      case 'properties':
        this.openProperties();
        break;
    }
  }

  onFolderContextMenuAction(actionId: string): void {
    switch (actionId) {
      case 'refresh':
        this.refresh();
        break;
      case 'newFolder':
        this.startAddFolder();
        break;
      case 'uploadFiles':
        this.uploadFiles();
        break;
      case 'uploadFolder':
        this.uploadFolder();
        break;
    }
  }

  private openProperties(): void {
    const p = this.state;
    if (p.selectedKeys.size !== 1) return;
    const key = Array.from(p.selectedKeys)[0];
    const item = p.items.find((i) => i.key === key);
    if (item) this.propertiesItem.set(item);
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

  uploadFolder(): void {
    const p = this.state;
    if (p.connectionId && p.bucket) this.transfers.uploadFolderDialog(p.bucket, p.prefix, p.connectionId);
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
