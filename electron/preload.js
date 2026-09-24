const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Thin, explicit bridge between the Angular renderer and the Electron main process.
 * No direct ipcRenderer access is exposed to the renderer for security (contextIsolation).
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // --- Connection profiles ---
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    save: (profile) => ipcRenderer.invoke('connections:save', profile),
    remove: (id) => ipcRenderer.invoke('connections:remove', id),
    test: (profile) => ipcRenderer.invoke('connections:test', profile)
  },

  // --- Bookmarks (named shortcuts to a connection + bucket + prefix) ---
  bookmarks: {
    list: () => ipcRenderer.invoke('bookmarks:list'),
    save: (bookmark) => ipcRenderer.invoke('bookmarks:save', bookmark),
    remove: (id) => ipcRenderer.invoke('bookmarks:remove', id)
  },

  // --- S3 operations ---
  s3: {
    listBuckets: (connectionId) => ipcRenderer.invoke('s3:listBuckets', connectionId),
    listObjects: (connectionId, bucket, prefix, continuationToken) =>
      ipcRenderer.invoke('s3:listObjects', { connectionId, bucket, prefix, continuationToken }),
    createFolder: (connectionId, bucket, key) =>
      ipcRenderer.invoke('s3:createFolder', { connectionId, bucket, key }),
    deleteObjects: (connectionId, bucket, keys) =>
      ipcRenderer.invoke('s3:deleteObjects', { connectionId, bucket, keys }),
    renameObject: (connectionId, bucket, oldKey, newKey) =>
      ipcRenderer.invoke('s3:renameObject', { connectionId, bucket, oldKey, newKey }),
    createBucket: (connectionId, bucket, region) =>
      ipcRenderer.invoke('s3:createBucket', { connectionId, bucket, region }),
    deleteBucket: (connectionId, bucket) =>
      ipcRenderer.invoke('s3:deleteBucket', { connectionId, bucket }),
    getPresignedUrl: (connectionId, bucket, key, expiresInSeconds) =>
      ipcRenderer.invoke('s3:getPresignedUrl', { connectionId, bucket, key, expiresInSeconds }),
    getPreviewUrl: (connectionId, bucket, key, contentType) =>
      ipcRenderer.invoke('s3:getPreviewUrl', { connectionId, bucket, key, contentType }),
    getTextPreview: (connectionId, bucket, key, maxBytes) =>
      ipcRenderer.invoke('s3:getTextPreview', { connectionId, bucket, key, maxBytes }),
    getPublicUrl: (connectionId, bucket, key) => ipcRenderer.invoke('s3:getPublicUrl', { connectionId, bucket, key }),
    getObjectProperties: (connectionId, bucket, key) =>
      ipcRenderer.invoke('s3:getObjectProperties', { connectionId, bucket, key }),
    copyItems: (args) => ipcRenderer.invoke('s3:copyItems', args),
    exportListingCsv: (args) => ipcRenderer.invoke('s3:exportListingCsv', args)
  },

  // --- Transfer queue (fast multi-threaded upload/download) ---
  transfers: {
    enqueueUpload: (connectionId, bucket, prefix, localPaths) =>
      ipcRenderer.invoke('transfers:enqueueUpload', { connectionId, bucket, prefix, localPaths }),
    enqueueDownload: (connectionId, bucket, items, destDir) =>
      ipcRenderer.invoke('transfers:enqueueDownload', { connectionId, bucket, items, destDir }),
    enqueueCopyMove: (args) => ipcRenderer.invoke('transfers:enqueueCopyMove', args),
    pause: (taskId) => ipcRenderer.invoke('transfers:pause', taskId),
    resume: (taskId) => ipcRenderer.invoke('transfers:resume', taskId),
    cancel: (taskId) => ipcRenderer.invoke('transfers:cancel', taskId),
    retry: (taskId) => ipcRenderer.invoke('transfers:retry', taskId),
    clearCompleted: () => ipcRenderer.invoke('transfers:clearCompleted'),
    pauseAll: () => ipcRenderer.invoke('transfers:pauseAll'),
    resumeAll: () => ipcRenderer.invoke('transfers:resumeAll'),
    setConcurrency: (maxConcurrentTransfers) =>
      ipcRenderer.invoke('transfers:setConcurrency', maxConcurrentTransfers),
    setPartSizeMB: (mb) => ipcRenderer.invoke('transfers:setPartSizeMB', mb),
    getSettings: () => ipcRenderer.invoke('transfers:getSettings'),
    getSnapshot: () => ipcRenderer.invoke('transfers:getSnapshot'),
    onUpdate: (callback) => {
      const listener = (_event, snapshot) => callback(snapshot);
      ipcRenderer.on('transfers:update', listener);
      return () => ipcRenderer.removeListener('transfers:update', listener);
    }
  },

  // --- Native dialogs / filesystem ---
  dialogs: {
    chooseFilesToUpload: () => ipcRenderer.invoke('dialogs:chooseFilesToUpload'),
    chooseFolderToUpload: () => ipcRenderer.invoke('dialogs:chooseFolderToUpload'),
    chooseDownloadDestination: () => ipcRenderer.invoke('dialogs:chooseDownloadDestination'),
    chooseSaveCsvPath: (defaultName) => ipcRenderer.invoke('dialogs:chooseSaveCsvPath', defaultName),
    confirm: (message, detail) => ipcRenderer.invoke('dialogs:confirm', { message, detail })
  },

  platform: process.platform,

  // Resolves a real filesystem path from a dropped File object. The old
  // `File.path` extension Electron used to patch onto dropped files is
  // deprecated and, on macOS in particular, has been unreliable for OS-level
  // Finder drag-and-drop (it can come back empty even though the drop event
  // itself fires fine) - `webUtils.getPathForFile` is Electron's supported
  // replacement and works consistently across platforms.
  getPathForFile: (file) => webUtils.getPathForFile(file)
});
