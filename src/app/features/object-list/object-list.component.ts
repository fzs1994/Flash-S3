import { CommonModule } from '@angular/common';
import { Component, EventEmitter, HostListener, Output, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { S3ListItem } from '../../core/models/models';
import { ElectronService } from '../../core/services/electron.service';
import { S3BrowserService } from '../../core/services/s3-browser.service';
import { ToastService } from '../../core/services/toast.service';
import { TransferService } from '../../core/services/transfer.service';
import { ContextMenuComponent, ContextMenuEntry } from '../context-menu/context-menu.component';

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

@Component({
  selector: 'app-object-list',
  standalone: true,
  imports: [CommonModule, FormsModule, ContextMenuComponent],
  templateUrl: './object-list.component.html',
  styleUrl: './object-list.component.scss'
})
export class ObjectListComponent {
  @Output() renameRequested = new EventEmitter<void>();
  @Output() generateUrlRequested = new EventEmitter<void>();
  @Output() copyRequested = new EventEmitter<void>();
  @Output() moveRequested = new EventEmitter<void>();
  @Output() newFolderRequested = new EventEmitter<void>();
  @Output() propertiesRequested = new EventEmitter<void>();

  isDragOver = false;

  readonly searchTerm = signal('');

  readonly filteredItems = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const items = this.s3.items();
    if (!term) return items;
    return items.filter((i) => i.name.toLowerCase().includes(term));
  });

  readonly contextMenu = signal<{ x: number; y: number } | null>(null);

  readonly contextMenuItems = computed<ContextMenuEntry[]>(() => {
    const count = this.s3.selectedKeys().size;
    if (!count) return [];
    const single = count === 1;

    const primaryGroup: ContextMenuEntry[] = [
      { type: 'item', id: 'download', label: 'Download', icon: 'fi-rr-download', colorClass: 'ic-green' },
      { type: 'item', id: 'copy', label: 'Copy To…', icon: 'fi-rr-copy', colorClass: 'ic-teal' },
      { type: 'item', id: 'move', label: 'Move To…', icon: 'fi-rr-arrow-right', colorClass: 'ic-purple' }
    ];
    const editGroup: ContextMenuEntry[] = [
      ...(single ? [{ type: 'item', id: 'rename', label: 'Rename', icon: 'fi-rr-edit', colorClass: 'ic-amber' } as ContextMenuEntry] : []),
      { type: 'item', id: 'delete', label: 'Delete', icon: 'fi-rr-trash', colorClass: 'ic-red', danger: true }
    ];
    const shareGroup: ContextMenuEntry[] = single
      ? [
          { type: 'item', id: 'shareUrl', label: 'Share URL…', icon: 'fi-rr-link', colorClass: 'ic-teal' },
          { type: 'item', id: 'properties', label: 'Properties', icon: 'fi-rr-info', colorClass: 'ic-blue' }
        ]
      : [];

    const groups = [primaryGroup, editGroup, shareGroup].filter((g) => g.length);
    const entries: ContextMenuEntry[] = [];
    groups.forEach((group, i) => {
      if (i > 0) entries.push({ type: 'divider' });
      entries.push(...group);
    });
    return entries;
  });

  /**
   * Right-clicking empty space (not a specific row) shows folder-level
   * actions - the same set as the top toolbar - rather than nothing, so you
   * don't have to reach for the toolbar just because you're deep in a list.
   */
  readonly folderContextMenu = signal<{ x: number; y: number } | null>(null);

  readonly folderContextMenuItems = computed<ContextMenuEntry[]>(() => {
    const hasBucket = !!this.s3.currentBucket();
    const entries: ContextMenuEntry[] = [
      { type: 'item', id: 'refresh', label: 'Refresh', icon: 'fi-rr-refresh', colorClass: 'ic-blue' }
    ];
    if (hasBucket) {
      entries.push(
        { type: 'item', id: 'newFolder', label: 'New Folder', icon: 'fi-rr-folder', colorClass: 'ic-amber' },
        { type: 'divider' },
        { type: 'item', id: 'uploadFiles', label: 'Upload Files…', icon: 'fi-rr-upload', colorClass: 'ic-blue' },
        { type: 'item', id: 'uploadFolder', label: 'Upload Folder…', icon: 'fi-rr-upload', colorClass: 'ic-blue' },
        { type: 'divider' },
        { type: 'item', id: 'exportCsv', label: 'Export CSV…', icon: 'fi-rr-file-export', colorClass: 'ic-teal' }
      );
    }
    return entries;
  });

  constructor(
    public s3: S3BrowserService,
    private electron: ElectronService,
    private transfers: TransferService,
    private toast: ToastService
  ) {
    // Clear any active search when navigating to a different folder/bucket -
    // otherwise a leftover filter term could make a freshly-opened folder
    // look empty for no apparent reason.
    effect(() => {
      this.s3.currentBucket();
      this.s3.currentPrefix();
      this.searchTerm.set('');
    }, { allowSignalWrites: true });
  }

  formatBytes = formatBytes;

  /**
   * Delete key removes the current selection; F2 renames it (only when
   * exactly one item is selected, matching the context menu's own rule).
   * Ignored while the user is typing anywhere (search box, rename dialog,
   * bookmark panel, etc.) and while any modal overlay (Connections, Copy/Move,
   * New Folder/Rename/Share URL, Transfer Settings) is open, so a background
   * selection can't be deleted/renamed out from under an active dialog.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(ev: KeyboardEvent): void {
    if (this.isTypingTarget(ev.target) || this.isModalOpen()) return;
    const count = this.s3.selectedKeys().size;
    if (!count) return;

    if (ev.key === 'Delete') {
      ev.preventDefault();
      this.deleteSelected();
    } else if (ev.key === 'F2' && count === 1) {
      ev.preventDefault();
      this.renameRequested.emit();
    }
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

  clearSearch(): void {
    this.searchTerm.set('');
  }

  onRowClick(item: S3ListItem, ev: MouseEvent): void {
    if (ev.ctrlKey || ev.metaKey) {
      this.s3.toggleSelect(item.key, false);
    } else {
      this.s3.toggleSelect(item.key, true);
    }
  }

  onRowDoubleClick(item: S3ListItem): void {
    if (item.type === 'folder') this.s3.openFolderItem(item);
  }

  onRowContextMenu(item: S3ListItem, ev: MouseEvent): void {
    ev.preventDefault();
    // Stop it reaching the container's own contextmenu handler, which would
    // otherwise also fire and show the folder-level menu on top of this one.
    ev.stopPropagation();
    // Right-clicking a row outside the current selection replaces it (typical
    // file-manager behavior); right-clicking within an existing multi-select
    // keeps it intact so bulk actions apply to the whole selection.
    if (!this.s3.selectedKeys().has(item.key)) {
      this.s3.toggleSelect(item.key, true);
    }
    this.contextMenu.set({ x: ev.clientX, y: ev.clientY });
  }

  /** Right-click anywhere that isn't a row (rows stop propagation before this fires) - folder-level actions instead of an item menu. */
  onContainerContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    this.folderContextMenu.set({ x: ev.clientX, y: ev.clientY });
  }

  onContextMenuAction(actionId: string): void {
    switch (actionId) {
      case 'download':
        this.download();
        break;
      case 'copy':
        this.copyRequested.emit();
        break;
      case 'move':
        this.moveRequested.emit();
        break;
      case 'rename':
        this.renameRequested.emit();
        break;
      case 'delete':
        this.deleteSelected();
        break;
      case 'shareUrl':
        this.generateUrlRequested.emit();
        break;
      case 'properties':
        this.propertiesRequested.emit();
        break;
    }
  }

  onFolderContextMenuAction(actionId: string): void {
    const bucket = this.s3.currentBucket();
    switch (actionId) {
      case 'refresh':
        if (bucket) this.s3.refreshListing();
        else this.s3.loadBuckets();
        break;
      case 'newFolder':
        this.newFolderRequested.emit();
        break;
      case 'uploadFiles':
        if (bucket) this.transfers.uploadFilesDialog(bucket, this.s3.currentPrefix());
        break;
      case 'uploadFolder':
        if (bucket) this.transfers.uploadFolderDialog(bucket, this.s3.currentPrefix());
        break;
      case 'exportCsv':
        this.s3.exportListingCsv();
        break;
    }
  }

  download(): void {
    const bucket = this.s3.currentBucket();
    if (!bucket) return;
    const items = this.s3
      .items()
      .filter((i) => i.type === 'file' && this.s3.selectedKeys().has(i.key))
      .map((i) => ({ key: i.key, name: i.name, size: i.size }));
    if (items.length) this.transfers.downloadItemsDialog(bucket, items);
  }

  async deleteSelected(): Promise<void> {
    const selectedKeys = this.s3.selectedKeys();
    const count = selectedKeys.size;
    if (!count) return;
    const ok = await this.electron.api.dialogs.confirm(`Delete ${count} item(s)?`, 'This action cannot be undone.');
    if (!ok) return;

    const label =
      count === 1
        ? `${this.s3.items().find((i) => selectedKeys.has(i.key))?.type === 'folder' ? 'Folder' : 'File'} deleted`
        : `${count} items deleted`;
    try {
      await this.s3.deleteSelected();
      this.toast.show(label, 'success');
    } catch (err: any) {
      this.toast.show(`Failed to delete: ${err?.message || err}`, 'danger');
    }
  }

  onBreadcrumbClick(prefix: string): void {
    this.s3.openPrefix(prefix);
  }

  isSelected(key: string): boolean {
    return this.s3.selectedKeys().has(key);
  }

  onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    this.isDragOver = true;
  }

  onDragLeave(): void {
    this.isDragOver = false;
  }

  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.isDragOver = false;
    // `webUtils.getPathForFile` (bridged via preload) is Electron's supported
    // way to resolve a dropped File's real filesystem path. The older
    // `File.path` property this used to rely on is deprecated and, on macOS
    // specifically, can come back empty even though the drop itself fires
    // fine - falling back to it here only for older/unexpected preload builds.
    const files = Array.from(ev.dataTransfer?.files || []) as any[];
    const paths = files
      .map((f) => {
        try {
          return this.electron.api.getPathForFile ? this.electron.api.getPathForFile(f) : f.path;
        } catch {
          return f.path;
        }
      })
      .filter(Boolean);
    const connId = this.s3.activeConnectionId();
    const bucket = this.s3.currentBucket();
    if (paths.length && connId && bucket) {
      this.electron.api.transfers.enqueueUpload(connId, bucket, this.s3.currentPrefix(), paths);
    }
  }
}
