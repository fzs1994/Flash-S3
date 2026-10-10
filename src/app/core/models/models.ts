export interface ConnectionProfile {
  id: string;
  name: string;
  region: string;
  accessKeyId: string;
  hasSecret?: boolean;
  /** Flagged by the user so Safety settings can demand extra confirmation for destructive actions. */
  isProduction?: boolean;
  createdAt?: number;
}

export interface ConnectionProfileInput {
  id?: string;
  name: string;
  region: string;
  accessKeyId: string;
  secretAccessKey?: string;
  isProduction?: boolean;
}

export interface BucketInfo {
  name: string;
  creationDate?: string;
}

export interface S3ListItem {
  type: 'folder' | 'file';
  key: string;
  name: string;
  size?: number;
  lastModified?: string;
  storageClass?: string;
}

/** Live HeadObject-sourced details shown in the Properties popup - fresher/more complete than whatever a folder listing happened to cache. */
export interface ObjectProperties {
  key: string;
  size: number;
  lastModified?: string;
  storageClass: string;
  contentType?: string | null;
  etag?: string | null;
  versionId?: string | null;
}

/**
 * One open connection's browsing session - buckets, current bucket/prefix,
 * listing, selection, and loading/error state. A tab is created the first
 * time a connection is opened and stays alive (with its state) until the
 * user explicitly closes it, so switching tabs doesn't lose your place.
 */
export interface ConnectionTabState {
  connectionId: string;
  name: string;
  buckets: BucketInfo[];
  currentBucket: string | null;
  currentPrefix: string;
  items: S3ListItem[];
  selectedKeys: Set<string>;
  loading: boolean;
  errorMessage: string | null;
  nextContinuationToken: string | null;
}

export type PaneId = 'left' | 'right';

/**
 * One side of the dual-pane view - deliberately independent of
 * ConnectionTabState/tabs, since two panes need to browse different
 * buckets/folders of the *same* connection simultaneously, which a single
 * per-connection tab can't represent (it only tracks one current bucket/prefix).
 */
export interface PaneState {
  connectionId: string | null;
  connectionName: string | null;
  buckets: BucketInfo[];
  loadingBuckets: boolean;
  bucket: string | null;
  prefix: string;
  items: S3ListItem[];
  /** Set while the folder listing was cut off at the page size and more can be fetched. */
  nextContinuationToken?: string | null;
  selectedKeys: Set<string>;
  loading: boolean;
  errorMessage: string | null;
}

/** A named shortcut to a specific connection + bucket + prefix, for jumping straight back to a deep folder. */
export interface Bookmark {
  id: string;
  name: string;
  connectionId: string;
  connectionName: string;
  bucket: string;
  prefix: string;
  createdAt: number;
}

export type TransferType = 'upload' | 'download' | 'copy';
export type TransferStatus = 'queued' | 'active' | 'paused' | 'completed' | 'error' | 'canceled';

export interface TransferTask {
  id: string;
  type: TransferType;
  connectionId: string;
  bucket: string;
  key: string;
  localPath: string;
  size: number;
  transferred: number;
  status: TransferStatus;
  speedBps: number;
  etaSeconds: number | null;
  error: string | null;
  /** Non-error status text: retry countdown, or why a transfer was skipped. */
  note?: string | null;
  progressPct: number;
  /** Only present for type: 'copy' - whether this deletes the originals (move) vs leaves them (copy). */
  move?: boolean;
  /** Only present for type: 'copy' - the folder the items were copied/moved from, used to auto-refresh it on completion. */
  srcPrefix?: string;
  /** Only present for type: 'copy' - the destination side of the operation. */
  destConnectionId?: string;
  destBucket?: string;
  destPrefix?: string;
  /** Only present for type: 'upload' - how many multipart parts this file was split into (1 if small enough to send as a single PutObject). */
  totalParts?: number;
  /** Only present for type: 'upload' - the part size (MB) in effect when this task started uploading. */
  partSizeMB?: number;
  /** Only present for type: 'upload' - per-part progress, in part-number order. Only meaningfully non-trivial when totalParts > 1. */
  parts?: TransferPart[];
}

export interface TransferPart {
  partNumber: number;
  loaded: number;
  total: number;
  progressPct: number;
}

/** User preferences from the General Settings window - mirrors electron/services/app-settings.js SCHEMA. */
export interface AppSettings {
  // Appearance
  theme: 'system' | 'light' | 'dark';
  // Transfers
  retryCount: number;
  retryBackoffSeconds: number;
  ifExists: 'ask' | 'skip' | 'overwrite' | 'rename';
  keepPartialDownloads: boolean;
  // Browsing
  defaultSortKey: 'name' | 'ext' | 'size' | 'date' | 'class';
  defaultSortDir: 'asc' | 'desc';
  defaultView: 'single' | 'dual';
  showHiddenItems: boolean;
  dateFormat: 'short' | 'iso' | 'dmy' | 'long';
  timeZone: 'local' | 'utc';
  sizeUnits: 'binary' | 'decimal' | 'bytes';
  pageSize: number;
  // Safety
  confirmDelete: boolean;
  typeToConfirmProduction: boolean;
  presignExpirySeconds: number;
  defaultDownloadFolder: string;
  lockAfterMinutes: number;
  // Network
  requestTimeoutSeconds: number;
  // App
  startup: 'normal' | 'minimized' | 'tray';
  closeToTray: boolean;
  restoreLastSession: boolean;
  notifyOnComplete: boolean;
  checkUpdatesOnLaunch: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  retryCount: 0,
  retryBackoffSeconds: 5,
  ifExists: 'overwrite',
  keepPartialDownloads: true,
  defaultSortKey: 'name',
  defaultSortDir: 'asc',
  defaultView: 'single',
  showHiddenItems: true,
  dateFormat: 'short',
  timeZone: 'local',
  sizeUnits: 'binary',
  pageSize: 1000,
  confirmDelete: true,
  typeToConfirmProduction: false,
  presignExpirySeconds: 3600,
  defaultDownloadFolder: '',
  lockAfterMinutes: 0,
  requestTimeoutSeconds: 0,
  startup: 'normal',
  closeToTray: false,
  restoreLastSession: false,
  notifyOnComplete: true,
  checkUpdatesOnLaunch: true
};
