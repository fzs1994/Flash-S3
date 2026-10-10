import { CommonModule } from '@angular/common';
import { Component, EventEmitter, HostListener, Output, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MarqueeSelectDirective, MarqueeSelectEvent, rangeKeys } from '../../core/directives/marquee-select.directive';
import { S3ListItem } from '../../core/models/models';
import { AppSettingsService } from '../../core/services/app-settings.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { ElectronService } from '../../core/services/electron.service';
import { S3BrowserService } from '../../core/services/s3-browser.service';
import { ToastService } from '../../core/services/toast.service';
import { TransferService } from '../../core/services/transfer.service';
import { extensionOf, SortKey, sortItems, withoutHidden } from '../../core/utils/list-utils';
import { isPreviewable } from '../../core/utils/preview-types';
import { ContextMenuComponent, ContextMenuEntry } from '../context-menu/context-menu.component';
import { AclDialogComponent } from '../dialogs/acl-dialog.component';
import { DropdownComponent } from '../dropdown/dropdown.component';
import { PreviewDialogComponent } from '../dialogs/preview-dialog.component';

const NO_EXT = '__none__';
const FOLDERS_ONLY = '__folders__';

@Component({
  selector: 'app-object-list',
  standalone: true,
  imports: [CommonModule, FormsModule, DropdownComponent, AclDialogComponent, ContextMenuComponent, MarqueeSelectDirective, PreviewDialogComponent],
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

  /** Row the next Shift+click range starts from. */
  private selectionAnchor: string | null = null;
  /** Selection as it was when a Ctrl/Shift rubber-band drag began, so the box adds to it rather than replacing it. */
  private marqueeBase: ReadonlySet<string> = new Set();

  readonly searchTerm = signal('');

  readonly sortKey = signal<SortKey>('name');
  readonly sortDir = signal<'asc' | 'desc'>('asc');
  /** Type filter: '' = everything, '__folders__' = folders only, otherwise a file extension ('' extension is '__none__'). */
  readonly typeFilter = signal('');

  /** Distinct file extensions in the current folder, for the type filter dropdown. */
  readonly availableExtensions = computed(() => {
    const exts = new Set<string>();
    for (const i of this.s3.items()) if (i.type === 'file') exts.add(extensionOf(i) || NO_EXT);
    return Array.from(exts).sort((a, b) => (a === NO_EXT ? 1 : b === NO_EXT ? -1 : a.localeCompare(b)));
  });

  readonly filteredItems = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const type = this.typeFilter();
    let items = withoutHidden(this.s3.items(), this.appSettings.settings());
    if (term) items = items.filter((i) => i.name.toLowerCase().includes(term));
    if (type === FOLDERS_ONLY) items = items.filter((i) => i.type === 'folder');
    else if (type) items = items.filter((i) => i.type === 'file' && (extensionOf(i) || NO_EXT) === type);
    return sortItems(items, this.sortKey(), this.sortDir());
  });

  toggleSort(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortKey.set(key);
      // Newest / largest first feels more natural for date and size.
      this.sortDir.set(key === 'size' || key === 'date' ? 'desc' : 'asc');
    }
  }

  sortIcon(key: SortKey): string {
    return this.sortDir() === 'asc' ? 'fi-sr-arrow-small-up' : 'fi-sr-arrow-small-down';
  }

  readonly typeOptions = computed(() => [
    { value: '', label: 'All types', icon: 'fi-sr-apps' },
    { value: FOLDERS_ONLY, label: 'Folders only', icon: 'fi-sr-folder' },
    ...this.availableExtensions().map((ext) => ({
      value: ext,
      label: ext === NO_EXT ? 'No extension' : `.${ext}`,
      icon: 'fi-sr-file'
    }))
  ]);


  extensionOf = extensionOf;

  /** Object (key) or bucket (key: null) whose ACL is open in the permissions dialog. */
  readonly aclTarget = signal<{ key: string | null } | null>(null);

  readonly contextMenu = signal<{ x: number; y: number } | null>(null);

  /** File open in the preview viewer; prev/next steps through `previewItems` (the previewable files in on-screen order). */
  readonly previewItem = signal<S3ListItem | null>(null);
  readonly previewItems = computed(() => this.filteredItems().filter(isPreviewable));

  /** The one selected item, if exactly one is selected. */
  private readonly singleSelected = computed(() => {
    const keys = this.s3.selectedKeys();
    if (keys.size !== 1) return null;
    const [key] = keys;
    return this.s3.items().find((i) => i.key === key) ?? null;
  });

  readonly contextMenuItems = computed<ContextMenuEntry[]>(() => {
    const count = this.s3.selectedKeys().size;
    if (!count) return [];
    const single = count === 1;
    const selected = this.singleSelected();

    const previewGroup: ContextMenuEntry[] =
      selected && isPreviewable(selected)
        ? [{ type: 'item', id: 'preview', label: 'Preview', icon: 'fi-sr-eye', colorClass: 'ic-blue' }]
        : [];
    const primaryGroup: ContextMenuEntry[] = [
      { type: 'item', id: 'download', label: 'Download', icon: 'fi-sr-download', colorClass: 'ic-green' },
      { type: 'item', id: 'copy', label: 'Copy To…', icon: 'fi-sr-copy', colorClass: 'ic-teal' },
      { type: 'item', id: 'move', label: 'Move To…', icon: 'fi-sr-arrow-right', colorClass: 'ic-purple' }
    ];
    const editGroup: ContextMenuEntry[] = [
      ...(single ? [{ type: 'item', id: 'rename', label: 'Rename', icon: 'fi-sr-edit', colorClass: 'ic-amber' } as ContextMenuEntry] : []),
      { type: 'item', id: 'delete', label: 'Delete', icon: 'fi-sr-trash', colorClass: 'ic-red', danger: true }
    ];
    const shareGroup: ContextMenuEntry[] = single
      ? [
          { type: 'item', id: 'shareUrl', label: 'Share URL…', icon: 'fi-sr-link', colorClass: 'ic-teal' },
          ...(selected?.type === 'file'
            ? [{ type: 'item', id: 'acl', label: 'Permissions (ACL)…', icon: 'fi-sr-shield-check', colorClass: 'ic-purple' } as ContextMenuEntry]
            : []),
          { type: 'item', id: 'properties', label: 'Properties', icon: 'fi-sr-info', colorClass: 'ic-blue' }
        ]
      : [];

    const groups = [previewGroup, primaryGroup, editGroup, shareGroup].filter((g) => g.length);
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
      { type: 'item', id: 'refresh', label: 'Refresh', icon: 'fi-sr-refresh', colorClass: 'ic-blue' }
    ];
    if (hasBucket) {
      entries.push(
        { type: 'item', id: 'newFolder', label: 'New Folder', icon: 'fi-sr-folder', colorClass: 'ic-amber' },
        { type: 'divider' },
        { type: 'item', id: 'uploadFiles', label: 'Upload Files…', icon: 'fi-sr-upload', colorClass: 'ic-blue' },
        { type: 'item', id: 'uploadFolder', label: 'Upload Folder…', icon: 'fi-sr-upload', colorClass: 'ic-blue' },
        { type: 'divider' },
        { type: 'item', id: 'exportCsv', label: 'Export CSV…', icon: 'fi-sr-file-export', colorClass: 'ic-teal' },
        { type: 'divider' },
        { type: 'item', id: 'bucketAcl', label: 'Bucket permissions (ACL)…', icon: 'fi-sr-shield-check', colorClass: 'ic-purple' }
      );
    }
    return entries;
  });

  constructor(
    public s3: S3BrowserService,
    private electron: ElectronService,
    private transfers: TransferService,
    private toast: ToastService,
    public appSettings: AppSettingsService,
    private confirm: ConfirmService
  ) {
    // Apply the default sort whenever it is (re)loaded or changed in General Settings.
    effect(() => {
      const { defaultSortKey, defaultSortDir } = this.appSettings.settings();
      this.sortKey.set(defaultSortKey);
      this.sortDir.set(defaultSortDir);
    }, { allowSignalWrites: true });

    // Clear any active search when navigating to a different folder/bucket -
    // otherwise a leftover filter term could make a freshly-opened folder
    // look empty for no apparent reason.
    effect(() => {
      this.s3.currentBucket();
      this.s3.currentPrefix();
      this.searchTerm.set('');
      this.typeFilter.set('');
    }, { allowSignalWrites: true });
  }

  formatBytes = (bytes?: number) => this.appSettings.formatSize(bytes);

  /**
   * Delete key removes the current selection; F2 renames it and Space
   * previews it (both only when exactly one item is selected, matching the
   * context menu's own rule).
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
    } else if (ev.key === ' ' && count === 1) {
      ev.preventDefault();
      const item = this.singleSelected();
      if (item?.type !== 'file') return;
      if (isPreviewable(item)) this.previewItem.set(item);
      else this.toast.show('No preview available for this file type', 'info');
    }
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  private isModalOpen(): boolean {
    return !!document.querySelector('.connections-overlay, .settings-overlay, .cm-overlay, .props-overlay, .preview-overlay, .overlay');
  }

  clearSearch(): void {
    this.searchTerm.set('');
  }

  onRowClick(item: S3ListItem, ev: MouseEvent): void {
    const additive = ev.ctrlKey || ev.metaKey;
    // Shift+click selects everything between the last plain/Ctrl-clicked row
    // (the anchor) and this one; Ctrl+Shift adds that range to the selection.
    if (ev.shiftKey && this.selectionAnchor) {
      const range = rangeKeys(this.filteredItems().map((i) => i.key), this.selectionAnchor, item.key);
      if (range.length) {
        this.s3.setSelection(additive ? [...this.s3.selectedKeys(), ...range] : range);
        return;
      }
    }
    this.s3.toggleSelect(item.key, !additive);
    this.selectionAnchor = item.key;
  }

  onMarqueeStart(): void {
    this.marqueeBase = this.s3.selectedKeys();
  }

  onMarqueeChange(ev: MarqueeSelectEvent): void {
    this.s3.setSelection(ev.additive ? [...this.marqueeBase, ...ev.keys] : ev.keys);
  }

  onRowDoubleClick(item: S3ListItem): void {
    if (item.type === 'folder') this.s3.openFolderItem(item);
    else if (isPreviewable(item)) this.previewItem.set(item);
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
      this.selectionAnchor = item.key;
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
      case 'preview':
        this.previewItem.set(this.singleSelected());
        break;
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
      case 'acl':
        if (this.singleSelected()) this.aclTarget.set({ key: this.singleSelected()!.key });
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
      case 'bucketAcl':
        this.aclTarget.set({ key: null });
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
    const only = count === 1 ? this.s3.items().find((i) => selectedKeys.has(i.key)) : null;
    const ok = await this.confirm.confirmDelete({ count, singleName: only?.name, connectionId: this.s3.activeConnectionId() });
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
