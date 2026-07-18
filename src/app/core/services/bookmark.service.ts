import { Injectable, signal } from '@angular/core';
import { Bookmark } from '../models/models';
import { ElectronService } from './electron.service';

export interface BookmarkInput {
  name: string;
  connectionId: string;
  connectionName: string;
  bucket: string;
  prefix: string;
}

/**
 * Persisted bookmarks - named shortcuts to a connection + bucket + prefix.
 * Backed by electron-store in the main process (see bookmark-store.js), so
 * they survive app restarts the same way saved connections do.
 */
@Injectable({ providedIn: 'root' })
export class BookmarkService {
  readonly bookmarks = signal<Bookmark[]>([]);

  constructor(private electron: ElectronService) {
    // Fire-and-forget on startup; swallow failures here (e.g. a stale preload
    // bridge mid-development) so a broken initial load doesn't surface as an
    // unhandled rejection - callers that need to know about failures use
    // add/rename/remove below, which do propagate errors.
    this.refresh().catch(() => {});
  }

  async refresh(): Promise<void> {
    if (!this.electron.isElectron) return;
    if (!this.electron.api.bookmarks) {
      console.warn('[Bookmarks] window.electronAPI.bookmarks is missing (stale preload bridge - restart the app)');
      return;
    }
    this.bookmarks.set(await this.electron.api.bookmarks.list());
  }

  async add(input: BookmarkInput): Promise<void> {
    await this.electron.api.bookmarks.save(input);
    await this.refresh();
  }

  async rename(id: string, name: string): Promise<void> {
    const existing = this.bookmarks().find((b) => b.id === id);
    if (!existing) return;
    await this.electron.api.bookmarks.save({ ...existing, name });
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    await this.electron.api.bookmarks.remove(id);
    await this.refresh();
  }
}
