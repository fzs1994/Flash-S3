import { CommonModule } from '@angular/common';
import { Component, HostListener, signal } from '@angular/core';
import { ConnectionService } from './core/services/connection.service';
import { S3BrowserService } from './core/services/s3-browser.service';
import { BucketTreeComponent } from './features/bucket-tree/bucket-tree.component';
import { ConnectionManagerComponent } from './features/connection-manager/connection-manager.component';
import { CopyMoveDialogComponent } from './features/dialogs/copy-move-dialog.component';
import { PromptDialogComponent } from './features/dialogs/prompt-dialog.component';
import { ObjectListComponent } from './features/object-list/object-list.component';
import { StatusBarComponent } from './features/status-bar/status-bar.component';
import { ToolbarComponent } from './features/toolbar/toolbar.component';
import { TransferQueueComponent } from './features/transfer-queue/transfer-queue.component';

type DialogMode = 'newFolder' | 'rename' | 'shareUrl' | null;

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 480;
const QUEUE_MIN = 120;
const QUEUE_MAX = 560;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadPanelSize(key: string, fallback: number): number {
  if (typeof localStorage === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function persistPanelSize(key: string, value: number): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(key, String(Math.round(value)));
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    ToolbarComponent,
    BucketTreeComponent,
    ObjectListComponent,
    TransferQueueComponent,
    StatusBarComponent,
    ConnectionManagerComponent,
    PromptDialogComponent,
    CopyMoveDialogComponent
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  readonly showConnectionsPanel = signal(true);
  readonly dialogMode = signal<DialogMode>(null);
  readonly copyMoveMode = signal<'copy' | 'move' | null>(null);
  dialogValue = '';

  readonly sidebarWidth = signal(loadPanelSize('s3b:sidebarWidth', 240));
  readonly queueHeight = signal(loadPanelSize('s3b:queueHeight', 240));
  private resizing: 'sidebar' | 'queue' | null = null;

  constructor(
    public s3: S3BrowserService,
    public connectionService: ConnectionService
  ) {}

  startSidebarResize(ev: MouseEvent): void {
    ev.preventDefault();
    this.resizing = 'sidebar';
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }

  startQueueResize(ev: MouseEvent): void {
    ev.preventDefault();
    this.resizing = 'queue';
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
  }

  @HostListener('document:mousemove', ['$event'])
  onDocumentMouseMove(ev: MouseEvent): void {
    if (this.resizing === 'sidebar') {
      this.sidebarWidth.set(clamp(ev.clientX, SIDEBAR_MIN, SIDEBAR_MAX));
    } else if (this.resizing === 'queue') {
      // Panel sits above the status bar; approximate that bar's height so the
      // drag tracks the cursor rather than lagging behind it.
      const heightFromCursor = window.innerHeight - ev.clientY - 22;
      this.queueHeight.set(clamp(heightFromCursor, QUEUE_MIN, QUEUE_MAX));
    }
  }

  @HostListener('document:mouseup')
  onDocumentMouseUp(): void {
    if (!this.resizing) return;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    persistPanelSize('s3b:sidebarWidth', this.sidebarWidth());
    persistPanelSize('s3b:queueHeight', this.queueHeight());
    this.resizing = null;
  }

  async onConnected(id: string): Promise<void> {
    const profile = this.connectionService.connections().find((c) => c.id === id);
    await this.s3.openConnectionTab(id, profile?.name ?? 'Connection');
    this.showConnectionsPanel.set(false);
  }

  selectTab(connectionId: string): void {
    this.s3.setActiveTab(connectionId);
  }

  closeTab(connectionId: string, ev: Event): void {
    ev.stopPropagation();
    this.s3.closeConnectionTab(connectionId);
    if (!this.s3.tabs().length) this.showConnectionsPanel.set(true);
  }

  openNewFolderDialog(): void {
    this.dialogValue = '';
    this.dialogMode.set('newFolder');
  }

  openRenameDialog(): void {
    const keys = Array.from(this.s3.selectedKeys());
    if (keys.length !== 1) return;
    const item = this.s3.items().find(i => i.key === keys[0]);
    this.dialogValue = item ? item.name : '';
    this.dialogMode.set('rename');
  }

  async openShareUrlDialog(): Promise<void> {
    const keys = Array.from(this.s3.selectedKeys());
    if (keys.length !== 1) return;
    this.dialogValue = 'Generating…';
    this.dialogMode.set('shareUrl');
    try {
      this.dialogValue = await this.s3.generatePresignedUrl(keys[0], 3600);
    } catch (err: any) {
      this.dialogValue = `Error: ${err?.message || err}`;
    }
  }

  async onDialogConfirm(value: string): Promise<void> {
    const mode = this.dialogMode();
    this.dialogMode.set(null);
    if (mode === 'newFolder' && value.trim()) {
      await this.s3.createFolder(value.trim());
    } else if (mode === 'rename' && value.trim()) {
      const keys = Array.from(this.s3.selectedKeys());
      if (keys.length === 1) await this.s3.renameItem(keys[0], value.trim());
    }
  }

  onDialogCancel(): void {
    this.dialogMode.set(null);
  }
}
