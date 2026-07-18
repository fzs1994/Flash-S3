const Store = require('electron-store');
const { randomUUID } = require('crypto');

/**
 * Persists user-defined bookmarks - named shortcuts to a specific
 * connection + bucket + prefix - across restarts, so users can jump
 * straight back to a deep folder instead of re-navigating each time.
 */
class BookmarkStore {
  constructor() {
    this.store = new Store({ name: 'flash-s3-bookmarks' });
  }

  list() {
    return this.store.get('bookmarks', []);
  }

  /** Creates a new bookmark, or updates an existing one if `bookmark.id` matches. */
  save(bookmark) {
    const raw = this.store.get('bookmarks', []);
    const id = bookmark.id || randomUUID();
    const existingIndex = raw.findIndex((b) => b.id === id);

    const record = {
      id,
      name: bookmark.name,
      connectionId: bookmark.connectionId,
      connectionName: bookmark.connectionName,
      bucket: bookmark.bucket,
      prefix: bookmark.prefix || '',
      createdAt: existingIndex >= 0 ? raw[existingIndex].createdAt : Date.now()
    };

    if (existingIndex >= 0) raw[existingIndex] = record;
    else raw.push(record);

    this.store.set('bookmarks', raw);
    return record;
  }

  remove(id) {
    const raw = this.store.get('bookmarks', []);
    this.store.set('bookmarks', raw.filter((b) => b.id !== id));
    return { removed: true };
  }
}

module.exports = { BookmarkStore };
