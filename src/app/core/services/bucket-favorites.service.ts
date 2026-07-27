import { Injectable, signal } from '@angular/core';

const FAVORITES_KEY = 's3b:favoriteBuckets';
const SHOW_ONLY_KEY = 's3b:showFavoriteBucketsOnly';

function loadFavorites(): Record<string, string[]> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function loadShowFavoritesOnly(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(SHOW_ONLY_KEY) === '1';
}

/**
 * Favorite buckets, scoped per saved connection (favoriting a bucket in one
 * AWS account has no effect on another account's bucket list). Backed by
 * localStorage rather than the main-process electron-store, since this is
 * lightweight view/preference data - same tier as the sidebar width or
 * dual-pane split, not a secret.
 */
@Injectable({ providedIn: 'root' })
export class BucketFavoritesService {
  private readonly favoritesByConnection = signal<Record<string, string[]>>(loadFavorites());

  /** Whether the bucket tree is currently showing only favorited buckets. Persists across restarts. */
  readonly showFavoritesOnly = signal<boolean>(loadShowFavoritesOnly());

  isFavorite(connectionId: string | null, bucketName: string): boolean {
    if (!connectionId) return false;
    return (this.favoritesByConnection()[connectionId] || []).includes(bucketName);
  }

  toggleFavorite(connectionId: string | null, bucketName: string): void {
    if (!connectionId) return;
    this.favoritesByConnection.update((map) => {
      const current = map[connectionId] || [];
      const next = current.includes(bucketName) ? current.filter((n) => n !== bucketName) : [...current, bucketName];
      return { ...map, [connectionId]: next };
    });
    this.persistFavorites();
  }

  toggleShowFavoritesOnly(): void {
    this.showFavoritesOnly.update((v) => !v);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SHOW_ONLY_KEY, this.showFavoritesOnly() ? '1' : '0');
    }
  }

  private persistFavorites(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(this.favoritesByConnection()));
  }
}
