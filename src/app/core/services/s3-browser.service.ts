import { Injectable, computed, effect, signal, untracked } from '@angular/core';
import { ConnectionProfile, ConnectionTabState, ObjectProperties, S3ListItem } from '../models/models';
import { AppSettingsService } from './app-settings.service';
import { ElectronService } from './electron.service';

const SESSION_KEY = 's3b:lastSession';

interface SavedSession {
  activeConnectionId: string | null;
  tabs: { connectionId: string; name: string; bucket: string | null; prefix: string }[];
}

/**
 * Multi-connection tab manager + "where am I" navigation state for the
 * object browser. Each open connection gets its own tab (bucket list,
 * current bucket/prefix, listing, selection, loading/error) so switching
 * tabs preserves exactly where you were. All the read-only signals below
 * (buckets, currentBucket, items, etc.) mirror the previously single-tab
 * API but are now derived from whichever tab is currently active, so
 * components that just read `s3.items()` etc. don't need to know tabs
 * exist at all.
 */
@Injectable({ providedIn: 'root' })
export class S3BrowserService {
  readonly tabs = signal<ConnectionTabState[]>([]);
  readonly activeConnectionId = signal<string | null>(null);

  /** Whether the main content area is showing the dual-pane view instead of the single sidebar+list view. */
  readonly dualPaneMode = signal(false);

  toggleDualPaneMode(): void {
    this.dualPaneMode.update((v) => !v);
  }

  readonly activeTab = computed<ConnectionTabState | null>(
    () => this.tabs().find((t) => t.connectionId === this.activeConnectionId()) ?? null
  );

  readonly buckets = computed(() => this.activeTab()?.buckets ?? []);
  readonly currentBucket = computed(() => this.activeTab()?.currentBucket ?? null);
  readonly currentPrefix = computed(() => this.activeTab()?.currentPrefix ?? '');
  readonly items = computed(() => this.activeTab()?.items ?? []);
  readonly selectedKeys = computed(() => this.activeTab()?.selectedKeys ?? new Set<string>());
  readonly loading = computed(() => this.activeTab()?.loading ?? false);
  readonly errorMessage = computed(() => this.activeTab()?.errorMessage ?? null);
  readonly nextContinuationToken = computed(() => this.activeTab()?.nextContinuationToken ?? null);

  readonly breadcrumbs = computed(() => {
    const bucket = this.currentBucket();
    if (!bucket) return [];
    const parts = this.currentPrefix().split('/').filter(Boolean);
    const crumbs = [{ label: bucket, prefix: '' }];
    let acc = '';
    for (const part of parts) {
      acc += `${part}/`;
      crumbs.push({ label: part, prefix: acc });
    }
    return crumbs;
  });

  /** Session saving stays off until startup restore has finished, so an empty startup state can't overwrite the saved one. */
  private savingSession = false;

  constructor(
    private electron: ElectronService,
    private appSettings: AppSettingsService
  ) {
    effect(() => {
      const tabs = this.tabs();
      const active = this.activeConnectionId();
      const enabled = this.appSettings.settings().restoreLastSession;
      untracked(() => this.persistSession(tabs, active, enabled));
    });
  }

  private persistSession(tabs: ConnectionTabState[], active: string | null, enabled: boolean): void {
    if (!this.savingSession) return;
    try {
      if (!enabled) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      const session: SavedSession = {
        activeConnectionId: active,
        tabs: tabs.map((t) => ({ connectionId: t.connectionId, name: t.name, bucket: t.currentBucket, prefix: t.currentPrefix }))
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      /* storage unavailable - session restore is a convenience only */
    }
  }

  /** Reopens the tabs (and the bucket/folder each was showing) from the previous run, for connections that still exist. */
  async restoreLastSession(connections: ConnectionProfile[]): Promise<void> {
    let session: SavedSession | null = null;
    try {
      session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch {
      session = null;
    }
    if (!session?.tabs?.length) return;
    const known = new Set(connections.map((c) => c.id));
    for (const saved of session.tabs) {
      if (!known.has(saved.connectionId)) continue;
      const name = connections.find((c) => c.id === saved.connectionId)?.name ?? saved.name;
      await this.openConnectionTab(saved.connectionId, name);
      if (saved.bucket) await this.navigateTo(saved.bucket, saved.prefix || '');
    }
    if (session.activeConnectionId && known.has(session.activeConnectionId)) this.setActiveTab(session.activeConnectionId);
  }

  startSavingSession(): void {
    this.savingSession = true;
    // Persist the state we ended up in (restored or empty) right away.
    this.persistSession(this.tabs(), this.activeConnectionId(), this.appSettings.settings().restoreLastSession);
  }

  /** Fetches the next page of the current folder (only offered when the listing was truncated at the page size). */
  async loadMore(): Promise<void> {
    const connectionId = this.activeConnectionId();
    const tab = this.activeTab();
    if (!connectionId || !tab?.currentBucket || !tab.nextContinuationToken) return;
    this.updateTab(connectionId, { loading: true, errorMessage: null });
    try {
      const res = await this.electron.api.s3.listObjects(connectionId, tab.currentBucket, tab.currentPrefix, tab.nextContinuationToken);
      const latest = this.tabs().find((t) => t.connectionId === connectionId);
      this.updateTab(connectionId, {
        items: [...(latest?.items ?? tab.items), ...res.items],
        nextContinuationToken: res.nextContinuationToken
      });
    } catch (err: any) {
      this.updateTab(connectionId, { errorMessage: err?.message || String(err) });
    } finally {
      this.updateTab(connectionId, { loading: false });
    }
  }

  // ---- Tab management -------------------------------------------------

  /** Opens a connection as a new tab, or just switches to it if already open. */
  async openConnectionTab(connectionId: string, name: string): Promise<void> {
    const existing = this.tabs().find((t) => t.connectionId === connectionId);
    if (existing) {
      this.activeConnectionId.set(connectionId);
      return;
    }
    const tab: ConnectionTabState = {
      connectionId,
      name,
      buckets: [],
      currentBucket: null,
      currentPrefix: '',
      items: [],
      selectedKeys: new Set(),
      loading: false,
      errorMessage: null,
      nextContinuationToken: null
    };
    this.tabs.update((list) => [...list, tab]);
    this.activeConnectionId.set(connectionId);
    await this.loadBuckets(connectionId);
  }

  closeConnectionTab(connectionId: string): void {
    const wasActive = this.activeConnectionId() === connectionId;
    this.tabs.update((list) => list.filter((t) => t.connectionId !== connectionId));
    if (wasActive) {
      const remaining = this.tabs();
      this.activeConnectionId.set(remaining.length ? remaining[remaining.length - 1].connectionId : null);
    }
  }

  setActiveTab(connectionId: string): void {
    if (this.tabs().some((t) => t.connectionId === connectionId)) this.activeConnectionId.set(connectionId);
  }

  private updateTab(connectionId: string, patch: Partial<ConnectionTabState>): void {
    this.tabs.update((list) => list.map((t) => (t.connectionId === connectionId ? { ...t, ...patch } : t)));
  }

  // ---- Browsing ---------------------------------------------------------

  async loadBuckets(connectionId: string | null = this.activeConnectionId()): Promise<void> {
    if (!connectionId) return;
    this.updateTab(connectionId, { loading: true, errorMessage: null });
    try {
      const buckets = await this.electron.api.s3.listBuckets(connectionId);
      this.updateTab(connectionId, { buckets });
    } catch (err: any) {
      this.updateTab(connectionId, { errorMessage: err?.message || String(err) });
    } finally {
      this.updateTab(connectionId, { loading: false });
    }
  }

  async openBucket(bucketName: string): Promise<void> {
    const connectionId = this.activeConnectionId();
    if (!connectionId) return;
    this.updateTab(connectionId, { currentBucket: bucketName, currentPrefix: '', selectedKeys: new Set() });
    await this.refreshListing();
  }

  async openPrefix(prefix: string): Promise<void> {
    const connectionId = this.activeConnectionId();
    if (!connectionId) return;
    this.updateTab(connectionId, { currentPrefix: prefix, selectedKeys: new Set() });
    await this.refreshListing();
  }

  /** Goes up one level from the current folder (no-op at the bucket root). */
  async goUp(): Promise<void> {
    const prefix = this.currentPrefix();
    if (!prefix) return;
    const parts = prefix.split('/').filter(Boolean);
    parts.pop();
    await this.openPrefix(parts.length ? `${parts.join('/')}/` : '');
  }

  async openFolderItem(item: S3ListItem): Promise<void> {
    if (item.type === 'folder') await this.openPrefix(item.key);
  }

  /** Jumps the active tab straight to a given bucket/prefix - used when navigating to a bookmark. */
  async navigateTo(bucket: string, prefix: string): Promise<void> {
    const connectionId = this.activeConnectionId();
    if (!connectionId) return;
    this.updateTab(connectionId, { currentBucket: bucket, currentPrefix: prefix, selectedKeys: new Set() });
    await this.refreshListing();
  }

  async refreshListing(): Promise<void> {
    const connectionId = this.activeConnectionId();
    if (!connectionId) return;
    await this.refreshListingFor(connectionId);
  }

  /**
   * Re-lists whatever folder a given (possibly inactive/background) tab is
   * currently showing. Used for the active tab's "Refresh" button, and also
   * fired automatically when a transfer targeting that tab's connection
   * finishes, so newly uploaded files show up without a manual refresh.
   */
  async refreshListingFor(connectionId: string): Promise<void> {
    const tab = this.tabs().find((t) => t.connectionId === connectionId);
    if (!tab || !tab.currentBucket) return;
    this.updateTab(connectionId, { loading: true, errorMessage: null });
    try {
      const res = await this.electron.api.s3.listObjects(connectionId, tab.currentBucket, tab.currentPrefix);
      this.updateTab(connectionId, { items: res.items, nextContinuationToken: res.nextContinuationToken });
    } catch (err: any) {
      this.updateTab(connectionId, { errorMessage: err?.message || String(err) });
    } finally {
      this.updateTab(connectionId, { loading: false });
    }
  }

  toggleSelect(key: string, exclusive = false): void {
    const connectionId = this.activeConnectionId();
    const tab = this.activeTab();
    if (!connectionId || !tab) return;
    const current = new Set(tab.selectedKeys);
    if (exclusive) {
      this.updateTab(connectionId, {
        selectedKeys: current.has(key) && current.size === 1 ? new Set() : new Set([key])
      });
      return;
    }
    if (current.has(key)) current.delete(key);
    else current.add(key);
    this.updateTab(connectionId, { selectedKeys: current });
  }

  setSelection(keys: Iterable<string>): void {
    const connectionId = this.activeConnectionId();
    if (!connectionId) return;
    this.updateTab(connectionId, { selectedKeys: new Set(keys) });
  }

  clearSelection(): void {
    const connectionId = this.activeConnectionId();
    if (!connectionId) return;
    this.updateTab(connectionId, { selectedKeys: new Set() });
  }

  async createFolder(name: string): Promise<void> {
    const connectionId = this.activeConnectionId();
    const tab = this.activeTab();
    if (!connectionId || !tab?.currentBucket) return;
    const key = `${tab.currentPrefix}${name}`;
    await this.electron.api.s3.createFolder(connectionId, tab.currentBucket, key);
    await this.refreshListing();
  }

  async deleteSelected(): Promise<void> {
    const connectionId = this.activeConnectionId();
    const tab = this.activeTab();
    if (!connectionId || !tab?.currentBucket) return;
    const keys = Array.from(tab.selectedKeys);
    if (!keys.length) return;
    await this.electron.api.s3.deleteObjects(connectionId, tab.currentBucket, keys);
    this.clearSelection();
    await this.refreshListing();
  }

  async renameItem(oldKey: string, newName: string): Promise<void> {
    const connectionId = this.activeConnectionId();
    const tab = this.activeTab();
    if (!connectionId || !tab?.currentBucket) return;
    const parentPrefix = oldKey.substring(0, oldKey.lastIndexOf('/', oldKey.length - 2) + 1);
    const newKey = `${parentPrefix}${newName}`;
    // Drives the active browse window's loading overlay for the duration of the rename.
    this.updateTab(connectionId, { loading: true });
    try {
      await this.electron.api.s3.renameObject(connectionId, tab.currentBucket, oldKey, newKey);
    } catch (err) {
      this.updateTab(connectionId, { loading: false });
      throw err;
    }
    await this.refreshListing();
  }

  async generatePresignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const connectionId = this.activeConnectionId();
    const tab = this.activeTab();
    if (!connectionId || !tab?.currentBucket) throw new Error('No active bucket');
    const res = await this.electron.api.s3.getPresignedUrl(connectionId, tab.currentBucket, key, expiresInSeconds);
    return res.url;
  }

  /** The object's plain, unsigned S3 URL (no expiry, no credentials embedded) - see s3-manager.js.getPublicUrl() for what "unsigned" means for a private bucket. */
  async generatePublicUrl(key: string): Promise<string> {
    const connectionId = this.activeConnectionId();
    const tab = this.activeTab();
    if (!connectionId || !tab?.currentBucket) throw new Error('No active bucket');
    const res = await this.electron.api.s3.getPublicUrl(connectionId, tab.currentBucket, key);
    return res.url;
  }

  async getObjectProperties(key: string): Promise<ObjectProperties> {
    const connectionId = this.activeConnectionId();
    const tab = this.activeTab();
    if (!connectionId || !tab?.currentBucket) throw new Error('No active bucket');
    return this.electron.api.s3.getObjectProperties(connectionId, tab.currentBucket, key);
  }

  /**
   * Copies (or moves) the currently selected items from the active tab's
   * bucket/prefix to a destination bucket + prefix, which may belong to a
   * different saved connection entirely. Refreshes whichever open tab(s)
   * the operation actually affected - the source (items may have moved) and
   * the destination (if it's currently being viewed in some tab).
   */
  async copyItems(dest: { connectionId: string; bucket: string; prefix: string }, move: boolean): Promise<void> {
    const connectionId = this.activeConnectionId();
    const tab = this.activeTab();
    if (!connectionId || !tab?.currentBucket) return;
    const items = tab.items.filter((i) => tab.selectedKeys.has(i.key));
    if (!items.length) return;

    await this.electron.api.s3.copyItems({
      items,
      srcConnectionId: connectionId,
      srcBucket: tab.currentBucket,
      destConnectionId: dest.connectionId,
      destBucket: dest.bucket,
      destPrefix: dest.prefix,
      move
    });

    if (move) this.clearSelection();
    await this.refreshListing();

    const destTab = this.tabs().find(
      (t) => t.connectionId === dest.connectionId && t.currentBucket === dest.bucket && t.currentPrefix === dest.prefix
    );
    if (destTab && (dest.connectionId !== connectionId || dest.bucket !== tab.currentBucket || dest.prefix !== tab.currentPrefix)) {
      await this.refreshListingFor(dest.connectionId);
    }
  }

  /**
   * Exports the current folder's *entire* listing (every page, not just what's
   * currently on screen) to a CSV file the user picks a location for. Returns
   * null if the user cancels the save dialog.
   */
  async exportListingCsv(): Promise<{ path: string; rowCount: number } | null> {
    const connectionId = this.activeConnectionId();
    const tab = this.activeTab();
    if (!connectionId || !tab?.currentBucket) return null;

    const folderLabel = tab.currentPrefix
      ? tab.currentPrefix.replace(/\/$/, '').split('/').pop()
      : tab.currentBucket;
    const defaultName = `${folderLabel || tab.currentBucket}-listing.csv`;

    const destPath = await this.electron.api.dialogs.chooseSaveCsvPath(defaultName);
    if (!destPath) return null;

    return this.electron.api.s3.exportListingCsv({
      connectionId,
      bucket: tab.currentBucket,
      prefix: tab.currentPrefix,
      destPath
    });
  }
}
