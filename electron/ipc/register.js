const { dialog, shell } = require('electron');
const { CredentialStore } = require('../services/credential-store');
const { BookmarkStore } = require('../services/bookmark-store');
const { S3Manager } = require('../services/s3-manager');
const { TransferQueueManager } = require('../services/transfer-queue');

function registerIpcHandlers(ipcMain, getWindow) {
  const credentialStore = new CredentialStore();
  const bookmarkStore = new BookmarkStore();
  const s3Manager = new S3Manager(credentialStore);
  const transferQueue = new TransferQueueManager(s3Manager);

  transferQueue.on('update', (snapshot) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('transfers:update', snapshot);
  });

  // --- Connections ---
  ipcMain.handle('connections:list', () => credentialStore.list());

  ipcMain.handle('connections:save', (_e, profile) => {
    const result = credentialStore.save(profile);
    s3Manager.invalidateClient(result.id);
    return result;
  });

  ipcMain.handle('connections:remove', (_e, id) => {
    s3Manager.invalidateClient(id);
    return credentialStore.remove(id);
  });

  ipcMain.handle('connections:test', async (_e, profile) => {
    try {
      // When editing a saved connection, the secret field is left blank to
      // mean "keep the existing secret" - fall back to the stored one so
      // "Test Connection" still works without forcing a re-paste.
      let effectiveProfile = profile;
      if (!profile.secretAccessKey && profile.id) {
        const stored = credentialStore.getFull(profile.id);
        if (stored) effectiveProfile = { ...profile, secretAccessKey: stored.secretAccessKey };
      }
      return await s3Manager.testConnection(effectiveProfile);
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // --- Bookmarks ---
  ipcMain.handle('bookmarks:list', () => bookmarkStore.list());
  ipcMain.handle('bookmarks:save', (_e, bookmark) => bookmarkStore.save(bookmark));
  ipcMain.handle('bookmarks:remove', (_e, id) => bookmarkStore.remove(id));

  // --- S3 operations ---
  ipcMain.handle('s3:listBuckets', async (_e, connectionId) => s3Manager.listBuckets(connectionId));

  ipcMain.handle('s3:listObjects', async (_e, { connectionId, bucket, prefix, continuationToken }) =>
    s3Manager.listObjects(connectionId, bucket, prefix, continuationToken)
  );

  ipcMain.handle('s3:createFolder', async (_e, { connectionId, bucket, key }) =>
    s3Manager.createFolder(connectionId, bucket, key)
  );

  ipcMain.handle('s3:deleteObjects', async (_e, { connectionId, bucket, keys }) =>
    s3Manager.deleteObjects(connectionId, bucket, keys)
  );

  ipcMain.handle('s3:renameObject', async (_e, { connectionId, bucket, oldKey, newKey }) =>
    s3Manager.renameObject(connectionId, bucket, oldKey, newKey)
  );

  ipcMain.handle('s3:createBucket', async (_e, { connectionId, bucket, region }) =>
    s3Manager.createBucket(connectionId, bucket, region)
  );

  ipcMain.handle('s3:deleteBucket', async (_e, { connectionId, bucket }) =>
    s3Manager.deleteBucket(connectionId, bucket)
  );

  ipcMain.handle('s3:getPresignedUrl', async (_e, { connectionId, bucket, key, expiresInSeconds }) =>
    s3Manager.getPresignedUrl(connectionId, bucket, key, expiresInSeconds)
  );

  ipcMain.handle('s3:getPublicUrl', async (_e, { connectionId, bucket, key }) =>
    s3Manager.getPublicUrl(connectionId, bucket, key)
  );

  ipcMain.handle('s3:getObjectProperties', async (_e, { connectionId, bucket, key }) =>
    s3Manager.getObjectProperties(connectionId, bucket, key)
  );

  ipcMain.handle('s3:copyItems', async (_e, args) => s3Manager.copyItems(args));

  ipcMain.handle('s3:exportListingCsv', async (_e, { connectionId, bucket, prefix, destPath }) => {
    const result = await s3Manager.exportListingToCsv(connectionId, bucket, prefix, destPath);
    shell.showItemInFolder(result.path);
    return result;
  });

  // --- Transfers ---
  ipcMain.handle('transfers:enqueueUpload', (_e, args) => transferQueue.enqueueUpload(args));
  ipcMain.handle('transfers:enqueueDownload', (_e, args) => transferQueue.enqueueDownload(args));
  ipcMain.handle('transfers:enqueueCopyMove', (_e, args) => transferQueue.enqueueCopyMove(args));
  ipcMain.handle('transfers:pause', (_e, taskId) => transferQueue.pause(taskId));
  ipcMain.handle('transfers:resume', (_e, taskId) => transferQueue.resume(taskId));
  ipcMain.handle('transfers:cancel', (_e, taskId) => transferQueue.cancel(taskId));
  ipcMain.handle('transfers:retry', (_e, taskId) => transferQueue.retry(taskId));
  ipcMain.handle('transfers:clearCompleted', () => transferQueue.clearCompleted());
  ipcMain.handle('transfers:pauseAll', () => transferQueue.pauseAll());
  ipcMain.handle('transfers:resumeAll', () => transferQueue.resumeAll());
  ipcMain.handle('transfers:setConcurrency', (_e, n) => transferQueue.setConcurrency(n));
  ipcMain.handle('transfers:setPartSizeMB', (_e, mb) => transferQueue.setPartSizeMB(mb));
  ipcMain.handle('transfers:getSettings', () => transferQueue.getSettings());
  ipcMain.handle('transfers:getSnapshot', () => transferQueue.getSnapshot());

  // --- Native dialogs ---
  ipcMain.handle('dialogs:chooseFilesToUpload', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('dialogs:chooseFolderToUpload', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('dialogs:chooseDownloadDestination', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('dialogs:chooseSaveCsvPath', async (_e, defaultName) => {
    const win = getWindow();
    const res = await dialog.showSaveDialog(win, {
      defaultPath: defaultName || 'listing.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    return res.canceled ? null : res.filePath;
  });

  ipcMain.handle('dialogs:confirm', async (_e, { message, detail }) => {
    const win = getWindow();
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Cancel', 'OK'],
      defaultId: 1,
      cancelId: 0,
      message,
      detail
    });
    return res.response === 1;
  });
}

module.exports = { registerIpcHandlers };
