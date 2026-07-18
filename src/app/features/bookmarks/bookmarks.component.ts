import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Bookmark } from '../../core/models/models';
import { BookmarkService } from '../../core/services/bookmark.service';
import { ConnectionService } from '../../core/services/connection.service';
import { S3BrowserService } from '../../core/services/s3-browser.service';

/**
 * Toolbar widget: a "Bookmarks" button that opens a dropdown listing saved
 * shortcuts to specific connection + bucket + prefix combinations. Supports
 * bookmarking the folder currently being viewed, inline rename, delete, and
 * click-to-navigate (opening/switching the relevant connection tab first).
 */
@Component({
  selector: 'app-bookmarks',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './bookmarks.component.html',
  styleUrl: './bookmarks.component.scss'
})
export class BookmarksComponent {
  readonly open = signal(false);
  readonly adding = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly errorMsg = signal<string | null>(null);
  editValue = '';

  constructor(
    public bookmarks: BookmarkService,
    public s3: S3BrowserService,
    private connectionService: ConnectionService,
    private elRef: ElementRef<HTMLElement>
  ) {}

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    if (!this.open()) return;
    // Use composedPath() (the propagation path captured at dispatch time)
    // rather than a live Node.contains() check. A click on a button whose own
    // handler removes it via *ngIf (e.g. "Add current") can trigger an
    // Angular re-render mid-bubble, detaching ev.target from the document
    // before this listener runs - contains() would then wrongly report
    // "outside" and close the panel the same click that opened a row in it.
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target as Node];
    if (!path.includes(this.elRef.nativeElement)) {
      this.closePanel();
    }
  }

  toggleOpen(): void {
    if (this.open()) {
      this.closePanel();
    } else {
      this.errorMsg.set(null);
      this.open.set(true);
    }
  }

  closePanel(): void {
    this.open.set(false);
    this.adding.set(false);
    this.editingId.set(null);
  }

  pathLabel(b: Bookmark): string {
    const trimmed = (b.prefix || '').replace(/\/$/, '');
    return trimmed ? `${b.bucket}/${trimmed}` : b.bucket;
  }

  private defaultName(): string {
    const bucket = this.s3.currentBucket() || '';
    const prefix = this.s3.currentPrefix() || '';
    const trimmed = prefix.replace(/\/$/, '');
    const lastSegment = trimmed.split('/').pop();
    return lastSegment || bucket;
  }

  startAdd(): void {
    this.editingId.set(null);
    this.editValue = this.defaultName();
    this.adding.set(true);
    this.focusActiveInput();
  }

  cancelAdd(): void {
    this.adding.set(false);
  }

  async confirmAdd(): Promise<void> {
    const name = this.editValue.trim();
    const connectionId = this.s3.activeConnectionId();
    const bucket = this.s3.currentBucket();
    if (!name) {
      this.errorMsg.set('Please enter a name for the bookmark.');
      return;
    }
    if (!connectionId || !bucket) {
      this.errorMsg.set('No folder is open to bookmark.');
      return;
    }
    const conn = this.connectionService.connections().find(c => c.id === connectionId);
    try {
      this.errorMsg.set(null);
      await this.bookmarks.add({
        name,
        connectionId,
        connectionName: conn?.name ?? 'Connection',
        bucket,
        prefix: this.s3.currentPrefix()
      });
      this.adding.set(false);
    } catch (err: any) {
      console.error('[Bookmarks]', err);
      this.errorMsg.set(this.describeError(err));
    }
  }

  startEdit(b: Bookmark): void {
    this.adding.set(false);
    this.editingId.set(b.id);
    this.editValue = b.name;
    this.focusActiveInput();
  }

  /**
   * Focuses (and selects) whichever inline text input is currently showing -
   * the "add current" name field or a row's rename field. Without this the
   * field never receives keyboard focus after appearing, so typing and
   * pressing Enter silently go nowhere.
   */
  private focusActiveInput(): void {
    setTimeout(() => {
      const input = this.elRef.nativeElement.querySelector<HTMLInputElement>('.bookmark-row__input');
      input?.focus();
      input?.select();
    });
  }

  cancelEdit(): void {
    this.editingId.set(null);
  }

  async confirmEdit(b: Bookmark): Promise<void> {
    const name = this.editValue.trim();
    if (!name) return;
    try {
      this.errorMsg.set(null);
      await this.bookmarks.rename(b.id, name);
      this.editingId.set(null);
    } catch (err: any) {
      console.error('[Bookmarks]', err);
      this.errorMsg.set(this.describeError(err));
    }
  }

  async remove(b: Bookmark): Promise<void> {
    try {
      const ok = await (window as any).electronAPI.dialogs.confirm(`Delete bookmark "${b.name}"?`, 'This cannot be undone.');
      if (ok) {
        this.errorMsg.set(null);
        await this.bookmarks.remove(b.id);
      }
    } catch (err: any) {
      console.error('[Bookmarks]', err);
      this.errorMsg.set(this.describeError(err));
    }
  }

  async goTo(b: Bookmark): Promise<void> {
    const conn = this.connectionService.connections().find(c => c.id === b.connectionId);
    if (!conn) {
      this.errorMsg.set(`Connection "${b.connectionName}" no longer exists.`);
      return;
    }
    try {
      this.errorMsg.set(null);
      this.closePanel();
      await this.s3.openConnectionTab(b.connectionId, conn.name);
      this.s3.setActiveTab(b.connectionId);
      await this.s3.navigateTo(b.bucket, b.prefix);
    } catch (err: any) {
      console.error('[Bookmarks]', err);
      this.open.set(true);
      this.errorMsg.set(this.describeError(err));
    }
  }

  /** Turns a raw IPC/JS error into a helpful message - the most common cause during
   *  development is that the Electron main process (which owns the bookmark store
   *  and doesn't hot-reload) hasn't been restarted since this feature was added. */
  private describeError(err: any): string {
    const msg = err?.message || String(err ?? 'Unknown error');
    if (/electronAPI bridge|Cannot read propert(y|ies) of undefined|is not a function|No handler registered/i.test(msg)) {
      return 'Could not reach the app backend. Please fully quit and restart Flash S3, then try again.';
    }
    return msg;
  }
}
