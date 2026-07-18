export interface ConnectionProfile {
  id: string;
  name: string;
  region: string;
  accessKeyId: string;
  hasSecret?: boolean;
  createdAt?: number;
}

export interface ConnectionProfileInput {
  id?: string;
  name: string;
  region: string;
  accessKeyId: string;
  secretAccessKey?: string;
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

export type TransferType = 'upload' | 'download';
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
  progressPct: number;
}
