import { Injectable, signal } from '@angular/core';
import { PaneId, PaneState, S3ListItem } from '../models/models';
import { ElectronService } from './electron.service';

function emptyPane(): PaneState {
  return {
    connectionId: null,
    connectionName: null,
    buckets: [],
    loadingBuckets: false,
    bucket: null,
    prefix: '',
    items: [],
    selectedKeys: new Set(),
    loading: false,
    errorMessage: null
  };
}

/**
 * Drives the dual-pane view: two fully independent browsing contexts (left
 * and right), each free to point at any saved connection and any bucket -
 * including two different buckets in the *same* account at once, which the
 * single-active-tab model (S3BrowserService) can't do since a tab only
 * tracks one current bucket/prefix per connection.
 *
 * Kept separate from S3BrowserService/ConnectionTabState entirely, rather
 * than generalizing that service, so the existing single-pane view and all
 * its callers stay untouched.
 */
@Injectable({ providedIn: 'root' })
export class PaneService {
  readonly panes = signal<Record<PaneId, PaneState>>({
    left: emptyPane(),
    right: emptyPane()
  });

  constructor(private electron: ElectronService) {}

  pane(id: PaneId): PaneState {
    return this.panes()[id];
  }

  other(id: PaneId): PaneId {
    return id === 'left' ? 'right' : 'left';
  }

  breadcrumbs(id: PaneId): { label: string; prefix: string }[] {
    const p = this.pane(id);
    if (!p.bucket) return [];
    const parts = p.prefix.split('/').filter(Boolean);
    const crumbs = [{ label: p.bucket, prefix: '' }];
    let acc = '';
    for (const part of parts) {
      acc += `${part}/`;
      crumbs.push({ label: part, prefix: acc });
    }
    return crumbs;
  }

  private updatePane(id: PaneId, patch: Partial<PaneState>): void {
    this.panes.update((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  }

  async setConnection(id: PaneId, connectionId: string, connectionName: string): Promise<void> {
    this.updatePane(id, {
      connectionId,
      connectionName,
      bucket: null,
      prefix: '',
      items: [],
      selectedKeys: new Set(),
      errorMessage: null,
      loadingBuckets: true
    });
    try {
      const buckets = await this.electron.api.s3.listBuckets(connectionId);
      this.updatePane(id, { buckets });
    } catch (err: any) {
      this.updatePane(id, { errorMessage: err?.message || String(err) });
    } finally {
      this.updatePane(id, { loadingBuckets: false });
    }
  }

  async openBucket(id: PaneId, bucket: string): Promise<void> {
    this.updatePane(id, { bucket, prefix: '', selectedKeys: new Set() });
    await this.refresh(id);
  }

  async openPrefix(id: PaneId, prefix: string): Promise<void> {
    this.updatePane(id, { prefix, selectedKeys: new Set() });
    await this.refresh(id);
  }

  async openFolderItem(id: PaneId, item: S3ListItem): Promise<void> {
    if (item.type === 'folder') await this.openPrefix(id, item.key);
  }

  async refresh(id: PaneId): Promise<void> {
    const p = this.pane(id);
    if (!p.connectionId || !p.bucket) return;
    this.updatePane(id, { loading: true, errorMessage: null });
    try {
      const res = await this.electron.api.s3.listObjects(p.connectionId, p.bucket, p.prefix);
      this.updatePane(id, { items: res.items });
    } catch (err: any) {
      this.updatePane(id, { errorMessage: err?.message || String(err) });
    } finally {
      this.updatePane(id, { loading: false });
    }
  }

  toggleSelect(id: PaneId, key: string, exclusive = false): void {
    const p = this.pane(id);
    const current = new Set(p.selectedKeys);
    if (exclusive) {
      this.updatePane(id, { selectedKeys: current.has(key) && current.size === 1 ? new Set() : new Set([key]) });
      return;
    }
    if (current.has(key)) current.delete(key);
    else current.add(key);
    this.updatePane(id, { selectedKeys: current });
  }

  clearSelection(id: PaneId): void {
    this.updatePane(id, { selectedKeys: new Set() });
  }

  async createFolder(id: PaneId, name: string): Promise<void> {
    const p = this.pane(id);
    if (!p.connectionId || !p.bucket || !name.trim()) return;
    const key = `${p.prefix}${name.trim()}`;
    await this.electron.api.s3.createFolder(p.connectionId, p.bucket, key);
    await this.refresh(id);
  }

  async deleteSelected(id: PaneId): Promise<void> {
    const p = this.pane(id);
    if (!p.connectionId || !p.bucket) return;
    const keys = Array.from(p.selectedKeys);
    if (!keys.length) return;
    await this.electron.api.s3.deleteObjects(p.connectionId, p.bucket, keys);
    this.clearSelection(id);
    await this.refresh(id);
  }

  // Note: cross-pane copy/move itself lives in TransferService.enqueueCopyMove()
  // (called from PaneViewComponent) so it runs through the Transfer Queue
  // instead of blocking here - PaneService only owns browsing state.
}
