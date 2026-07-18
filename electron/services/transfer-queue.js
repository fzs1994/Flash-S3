const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const Store = require('electron-store');
const { Upload } = require('@aws-sdk/lib-storage');
const { GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const DEFAULT_MAX_CONCURRENT_TRANSFERS = 4; // how many files run at once
const DEFAULT_PART_CONCURRENCY = 4;         // parallel parts *within* one file (multipart)
const DEFAULT_PART_SIZE_MB = 8;             // default multipart chunk size
const MIN_PART_SIZE_MB = 5;                 // S3 requires >= 5 MB for any non-final part
const MAX_PART_SIZE_MB = 500;               // sane practical ceiling

/**
 * TransferQueueManager
 *
 * Implements the "fast multiple upload queues" requirement:
 *  - Any number of transfers can be queued at once.
 *  - Up to `maxConcurrentTransfers` files move at the same time (configurable).
 *  - Each individual upload is itself multipart with `partConcurrency` parallel
 *    parts via @aws-sdk/lib-storage, so large files saturate bandwidth too.
 *  - Every task supports pause / resume / cancel / retry.
 *  - Progress, speed and ETA are recalculated on every progress tick and
 *    broadcast to the renderer via the 'update' event.
 *
 * Known limitation: pause on an in-flight transfer aborts the current
 * request; resume restarts that file from byte 0 rather than a true
 * byte-offset resume. True resumable-pause would require tracking S3
 * multipart UploadIds / HTTP Range requests per part and is a good
 * follow-up enhancement.
 */
class TransferQueueManager extends EventEmitter {
  constructor(s3Manager) {
    super();
    this.s3Manager = s3Manager;
    this.tasks = new Map(); // id -> task
    this.settingsStore = new Store({ name: 'flash-s3-transfer-settings' });
    this.maxConcurrentTransfers = Math.max(
      1,
      Math.min(16, Number(this.settingsStore.get('concurrency', DEFAULT_MAX_CONCURRENT_TRANSFERS)) | 0 || DEFAULT_MAX_CONCURRENT_TRANSFERS)
    );
    this.partConcurrency = DEFAULT_PART_CONCURRENCY;
    this.partSizeMB = Math.max(
      MIN_PART_SIZE_MB,
      Math.min(MAX_PART_SIZE_MB, Number(this.settingsStore.get('partSizeMB', DEFAULT_PART_SIZE_MB)) | 0 || DEFAULT_PART_SIZE_MB)
    );
    this.activeCount = 0;
    this.globallyPaused = false;
  }

  setConcurrency(maxConcurrentTransfers) {
    this.maxConcurrentTransfers = Math.max(1, Math.min(16, maxConcurrentTransfers | 0));
    this.settingsStore.set('concurrency', this.maxConcurrentTransfers);
    this._pump();
    return this.maxConcurrentTransfers;
  }

  /** Sets the multipart upload chunk size (MB), clamped to a safe range. Applies to transfers queued from now on. */
  setPartSizeMB(mb) {
    const parsed = Number(mb) | 0;
    this.partSizeMB = Math.max(MIN_PART_SIZE_MB, Math.min(MAX_PART_SIZE_MB, parsed || DEFAULT_PART_SIZE_MB));
    this.settingsStore.set('partSizeMB', this.partSizeMB);
    return this.partSizeMB;
  }

  /** Current persisted transfer settings, sent to the renderer on startup so the Settings dialog reflects last session's values. */
  getSettings() {
    return { concurrency: this.maxConcurrentTransfers, partSizeMB: this.partSizeMB };
  }

  // ---- Public enqueue API -------------------------------------------------

  enqueueUpload({ connectionId, bucket, prefix, localPaths }) {
    const created = [];
    for (const localPath of localPaths) {
      const files = this._expandLocalPathToFiles(localPath);
      for (const file of files) {
        const relativeKeyName = file.relativeName.split(path.sep).join('/');
        const key = `${prefix || ''}${relativeKeyName}`;
        const task = this._createTask({
          type: 'upload',
          connectionId,
          bucket,
          key,
          localPath: file.absolutePath,
          size: file.size
        });
        created.push(task);
      }
    }
    this._pump();
    this._emitUpdate();
    return created.map((t) => t.id);
  }

  enqueueDownload({ connectionId, bucket, items, destDir }) {
    const created = [];
    for (const item of items) {
      const destPath = path.join(destDir, item.name || path.basename(item.key));
      const task = this._createTask({
        type: 'download',
        connectionId,
        bucket,
        key: item.key,
        localPath: destPath,
        size: item.size || 0
      });
      created.push(task);
    }
    this._pump();
    this._emitUpdate();
    return created.map((t) => t.id);
  }

  // ---- Task control --------------------------------------------------------

  pause(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status === 'active') {
      task.pauseRequested = true;
      if (task.abortController) task.abortController.abort();
    } else if (task.status === 'queued') {
      task.status = 'paused';
    }
    this._emitUpdate();
  }

  resume(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status === 'paused' || task.status === 'error') {
      task.status = 'queued';
      task.transferred = 0;
      task.error = null;
    }
    this._pump();
    this._emitUpdate();
  }

  cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.cancelRequested = true;
    if (task.abortController) task.abortController.abort();
    if (task.status === 'queued' || task.status === 'paused') {
      task.status = 'canceled';
    }
    this._emitUpdate();
  }

  retry(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'queued';
    task.transferred = 0;
    task.error = null;
    task.cancelRequested = false;
    this._pump();
    this._emitUpdate();
  }

  pauseAll() {
    this.globallyPaused = true;
    for (const task of this.tasks.values()) this.pause(task.id);
  }

  resumeAll() {
    this.globallyPaused = false;
    for (const task of this.tasks.values()) {
      if (task.status === 'paused') task.status = 'queued';
    }
    this._pump();
    this._emitUpdate();
  }

  clearCompleted() {
    for (const [id, task] of this.tasks) {
      if (['completed', 'canceled'].includes(task.status)) this.tasks.delete(id);
    }
    this._emitUpdate();
  }

  getSnapshot() {
    return Array.from(this.tasks.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => this._toPublic(t));
  }

  // ---- Internals ------------------------------------------------------------

  _createTask({ type, connectionId, bucket, key, localPath, size }) {
    const id = randomUUID();
    const task = {
      id,
      type,
      connectionId,
      bucket,
      key,
      localPath,
      size: size || 0,
      transferred: 0,
      status: 'queued',
      speedBps: 0,
      etaSeconds: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      _lastTick: null,
      _lastTransferred: 0,
      pauseRequested: false,
      cancelRequested: false,
      abortController: null
    };
    this.tasks.set(id, task);
    return task;
  }

  _expandLocalPathToFiles(localPath) {
    const stat = fs.statSync(localPath);
    if (stat.isFile()) {
      return [{ absolutePath: localPath, relativeName: path.basename(localPath), size: stat.size }];
    }
    // Directory: walk recursively, keep paths relative to the chosen folder's parent
    // so the folder itself becomes the top-level "prefix" in S3.
    const baseDir = path.dirname(localPath);
    const results = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const relativeName = path.relative(baseDir, full);
          const s = fs.statSync(full);
          results.push({ absolutePath: full, relativeName, size: s.size });
        }
      }
    };
    walk(localPath);
    return results;
  }

  _pump() {
    if (this.globallyPaused) return;
    while (this.activeCount < this.maxConcurrentTransfers) {
      const next = Array.from(this.tasks.values()).find((t) => t.status === 'queued');
      if (!next) break;
      this._runTask(next);
    }
  }

  async _runTask(task) {
    task.status = 'active';
    task.startedAt = Date.now();
    task._lastTick = Date.now();
    task._lastTransferred = 0;
    task.abortController = new AbortController();
    this.activeCount += 1;
    this._emitUpdate();

    try {
      if (task.type === 'upload') await this._runUpload(task);
      else await this._runDownload(task);

      if (task.cancelRequested) {
        task.status = 'canceled';
      } else if (task.pauseRequested) {
        task.status = 'paused';
        task.pauseRequested = false;
      } else {
        task.status = 'completed';
        task.transferred = task.size;
        task.speedBps = 0;
        task.etaSeconds = 0;
      }
    } catch (err) {
      if (task.cancelRequested) {
        task.status = 'canceled';
      } else if (task.pauseRequested) {
        task.status = 'paused';
        task.pauseRequested = false;
      } else {
        task.status = 'error';
        task.error = err && err.message ? err.message : String(err);
      }
    } finally {
      task.abortController = null;
      this.activeCount -= 1;
      this._emitUpdate();
      this._pump();
    }
  }

  _tickProgress(task, transferredBytes) {
    task.transferred = transferredBytes;
    const now = Date.now();
    const dt = (now - task._lastTick) / 1000;
    if (dt >= 0.25) {
      const db = task.transferred - task._lastTransferred;
      task.speedBps = dt > 0 ? db / dt : 0;
      const remaining = Math.max(task.size - task.transferred, 0);
      task.etaSeconds = task.speedBps > 0 ? remaining / task.speedBps : null;
      task._lastTick = now;
      task._lastTransferred = task.transferred;
      this._emitUpdate();
    }
  }

  async _runUpload(task) {
    const client = await this.s3Manager.getClientForBucket(task.connectionId, task.bucket);
    const body = fs.createReadStream(task.localPath);

    const uploader = new Upload({
      client,
      params: { Bucket: task.bucket, Key: task.key, Body: body },
      queueSize: this.partConcurrency,
      partSize: this.partSizeMB * 1024 * 1024,
      leavePartsOnError: false
    });

    uploader.on('httpUploadProgress', (progress) => {
      if (progress.loaded) this._tickProgress(task, progress.loaded);
    });

    task._abortUpload = () => uploader.abort();
    task.abortController.signal.addEventListener('abort', () => {
      uploader.abort().catch(() => { });
      body.destroy();
    });

    await uploader.done();
  }

  async _runDownload(task) {
    const client = await this.s3Manager.getClientForBucket(task.connectionId, task.bucket);

    if (!task.size) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: task.bucket, Key: task.key }));
        task.size = head.ContentLength || 0;
      } catch (_) {
        /* non-fatal, progress % just won't be known ahead of time */
      }
    }

    fs.mkdirSync(path.dirname(task.localPath), { recursive: true });

    const res = await client.send(
      new GetObjectCommand({ Bucket: task.bucket, Key: task.key }),
      { abortSignal: task.abortController.signal }
    );

    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(task.localPath);
      let transferred = 0;

      const onAbort = () => {
        res.Body.destroy();
        writeStream.destroy();
      };
      task.abortController.signal.addEventListener('abort', onAbort);

      res.Body.on('data', (chunk) => {
        transferred += chunk.length;
        this._tickProgress(task, transferred);
      });

      res.Body.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      res.Body.on('error', reject);
    });
  }

  _toPublic(task) {
    return {
      id: task.id,
      type: task.type,
      connectionId: task.connectionId,
      bucket: task.bucket,
      key: task.key,
      localPath: task.localPath,
      size: task.size,
      transferred: task.transferred,
      status: task.status,
      speedBps: task.speedBps,
      etaSeconds: task.etaSeconds,
      error: task.error,
      progressPct: task.size > 0 ? Math.min(100, Math.round((task.transferred / task.size) * 100)) : task.status === 'completed' ? 100 : 0
    };
  }

  _emitUpdate() {
    this.emit('update', this.getSnapshot());
  }
}

module.exports = { TransferQueueManager };
