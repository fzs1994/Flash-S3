const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { Transform } = require('stream');
const Store = require('electron-store');
const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} = require('@aws-sdk/client-s3');

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

  /**
   * Queues a copy/move of one or more items (files and/or folders) as a
   * single tracked task, so dual-pane (and eventually single-pane) transfers
   * show up in the same queue as uploads/downloads instead of happening
   * silently. `srcPrefix` is only used to know which open folder to refresh
   * afterwards - it isn't needed for the copy itself since each item already
   * carries its own full key.
   */
  enqueueCopyMove({ items, srcConnectionId, srcBucket, srcPrefix, destConnectionId, destBucket, destPrefix, move }) {
    const totalSize = items.reduce((sum, i) => sum + (i.type === 'file' ? i.size || 0 : 0), 0);
    const label = items.length === 1 ? items[0].name : `${items.length} items`;
    const task = this._createTask({
      type: 'copy',
      connectionId: srcConnectionId,
      bucket: srcBucket,
      key: label,
      localPath: null,
      size: totalSize
    });
    task.move = !!move;
    task.srcPrefix = srcPrefix || '';
    task.destConnectionId = destConnectionId;
    task.destBucket = destBucket;
    task.destPrefix = destPrefix || '';
    task.items = items;
    this._pump();
    this._emitUpdate();
    return task.id;
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
      else if (task.type === 'copy') await this._runCopy(task);
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
        // Snap every part to fully-loaded too, so the per-part view doesn't
        // show a sliver of a part still "in progress" after the file as a
        // whole has already finished.
        if (task.parts) {
          for (const part of task.parts.values()) part.loaded = part.total;
        }
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

  /**
   * Updates the visual "transferred" total (drives the progress bar/%/size
   * text) and the displayed speed/ETA from a real transferred-byte count,
   * then throttles the broadcast to the renderer to at most once per 250ms.
   *
   * Speed is an instantaneous delta (bytes moved over the last >= 250ms)
   * rather than a cumulative average, so it reacts promptly to the
   * connection actually speeding up or slowing down. This is only accurate
   * because `transferredBytes` is now always a genuine count, not a
   * synthetic projection - see the comment on _runUpload() for how upload
   * progress gets real, per-chunk numbers.
   */
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

  /**
   * Uploads happen through our own hand-rolled multipart implementation
   * rather than @aws-sdk/lib-storage's `Upload` class, to get real per-part
   * progress like NetSDK's S3 Browser shows (lib-storage's httpUploadProgress
   * only fires once a whole part has finished, and its chunker reads ahead
   * of what's actually been sent).
   *
   * Progress comes from a small counting Transform (_createProgressStream())
   * spliced between each part's file-read stream and the SDK - that Transform
   * is what's actually passed as `Body` for the UploadPartCommand/
   * PutObjectCommand. @smithy/node-http-handler pipes `Body` directly into
   * the underlying http.ClientRequest (`body.pipe(httpRequest)`), and Node's
   * pipe() only pulls more out of a source once its destination has actually
   * drained - so as long as something downstream is genuinely slow to accept
   * bytes (a real, bandwidth-limited connection), bytes flow through our
   * counting Transform at real transmission pace, not disk-read speed. This
   * requires the client to not silently wrap the body in the SDK's own
   * checksum-computing stream, which attaches its own `.on('data', ...)` and
   * drains it into a buffer as fast as Node can read regardless of real
   * upload speed - see the requestChecksumCalculation note in
   * s3-manager.js._buildClient(), which already disables that.
   *
   * The counting must go through a Transform and not a bare 'data' listener
   * on the raw file stream - `client.send()` only attaches its real consumer
   * after some async setup (signing, connecting), and a 'data' listener
   * attached before that would force the file stream into flowing mode
   * immediately, draining the whole file into that listener before the SDK
   * ever attaches and leaving the real HTTP body empty (verified directly:
   * with a real consumer attached 50ms late, that pattern delivered zero
   * bytes to it and produced exactly this kind of idle-socket timeout). See
   * _createProgressStream() for how the Transform avoids that.
   *
   * Verified directly with a local test: piping a 30MB file through this
   * same Transform into a writable deliberately throttled to ~1.4 MB/s (with
   * the real consumer attached late, mirroring the SDK) made progress track
   * wall-clock time to within ~10-15% of the expected pace at every
   * checkpoint (10/25/50/75/90/100%) - not the near-instant read you'd see if
   * a buffer had simply swallowed the whole file up front.
   *
   * So each part's `loaded` is simply real bytes read off its stream so far,
   * capped at its size. `_confirmPart()` still snaps it to exactly `size`
   * once S3's response for that part actually comes back, covering the
   * brief gap between "last byte handed off" and "S3 acknowledged it".
   */
  async _runUpload(task) {
    const client = await this.s3Manager.getClientForBucket(task.connectionId, task.bucket);

    const partSizeBytes = this.partSizeMB * 1024 * 1024;
    // Captured per-task (rather than read live from `this.partSizeMB`) so the
    // part count/labels stay correct even if the user changes the Part Size
    // setting while this task is queued or running.
    task.partSizeMB = this.partSizeMB;
    task.totalParts = Math.max(1, Math.ceil((task.size || 0) / partSizeBytes));
    task.parts = new Map(); // partNumber -> { loaded, total }

    if (task.totalParts <= 1) {
      await this._runSinglePutUpload(task, client);
    } else {
      await this._runMultipartUpload(task, client, partSizeBytes);
    }
  }

  /** Sum of every part's currently-known loaded bytes. */
  _sumPartsLoaded(task) {
    let sum = 0;
    for (const p of task.parts.values()) sum += p.loaded;
    return sum;
  }

  /** Snaps a part to fully loaded once S3 has actually acknowledged it - covers the brief gap between the last byte being handed off and the PUT/UploadPart response coming back. */
  _confirmPart(task, partNumber, size) {
    task.parts.set(partNumber, { loaded: size, total: size });
    this._tickProgress(task, this._sumPartsLoaded(task));
  }

  /**
   * Wraps `source` in a passthrough Transform that reports each chunk's size
   * to `onChunk` as it flows through, and pipes `source` into it - the
   * returned stream is what should be handed to the SDK as `Body`.
   *
   * The counting must happen in a Transform sitting *between* the file read
   * and the SDK, not a bare 'data' listener attached directly to `source`.
   * `client.send()` only attaches its real consumer (via
   * `body.pipe(httpRequest)` inside @smithy/node-http-handler) after some
   * async setup (signing, connecting, etc.) - a 'data' listener on `source`
   * itself forces it into flowing mode immediately and drains the whole
   * file into that listener before the SDK's real consumer ever attaches,
   * leaving the actual HTTP body empty. Verified directly: with a real
   * consumer attached 50ms late, a bare 'data' listener on the source saw
   * every byte of a 5MB file while the real consumer received none - which
   * is exactly the "socket was not read from or written to" timeout this
   * caused. A Transform's own internal buffering bounds how far `source`
   * can race ahead to its highWaterMark (tens of KB) before *this* stream's
   * writable side backpressures it, so nothing is lost regardless of when
   * the SDK actually attaches, and real transfer pacing still comes through
   * once it does.
   */
  _createProgressStream(source, onChunk) {
    const progress = new Transform({
      transform(chunk, encoding, callback) {
        onChunk(chunk.length);
        callback(null, chunk);
      }
    });
    source.on('error', (err) => progress.destroy(err));
    source.pipe(progress);
    return progress;
  }

  async _runSinglePutUpload(task, client) {
    const fileStream = fs.createReadStream(task.localPath);
    const partEntry = { loaded: 0, total: task.size };
    task.parts.set(1, partEntry);
    const body = this._createProgressStream(fileStream, (bytes) => {
      partEntry.loaded = Math.min(partEntry.loaded + bytes, partEntry.total);
      this._tickProgress(task, this._sumPartsLoaded(task));
    });

    const onAbort = () => {
      fileStream.destroy();
      body.destroy();
    };
    task.abortController.signal.addEventListener('abort', onAbort);

    try {
      await client.send(new PutObjectCommand({ Bucket: task.bucket, Key: task.key, Body: body, ContentLength: task.size }), {
        abortSignal: task.abortController.signal
      });
      this._confirmPart(task, 1, task.size);
    } finally {
      task.abortController.signal.removeEventListener('abort', onAbort);
    }
  }

  async _runMultipartUpload(task, client, partSizeBytes) {
    const ranges = [];
    let offset = 0;
    for (let partNumber = 1; partNumber <= task.totalParts; partNumber++) {
      const size = partNumber === task.totalParts ? task.size - offset : partSizeBytes;
      ranges.push({ partNumber, start: offset, end: offset + size - 1, size });
      offset += size;
    }

    // Deliberately not requesting a checksum algorithm here. Asking for one
    // (or letting the client fall back to its default) makes the SDK wrap
    // every part's request body in an aws-chunked + trailing-checksum stream
    // that drains our body non-backpressured (see the requestChecksumCalculation
    // note in s3-manager.js._buildClient) - which breaks real-time per-part
    // progress. S3 doesn't require a checksum for multipart uploads, so this
    // is safe to omit entirely.
    const created = await client.send(new CreateMultipartUploadCommand({ Bucket: task.bucket, Key: task.key }), {
      abortSignal: task.abortController.signal
    });
    const uploadId = created.UploadId;

    const uploadedParts = new Array(ranges.length);
    let firstError = null;

    const uploadOnePart = async (range) => {
      const fileStream = fs.createReadStream(task.localPath, { start: range.start, end: range.end });
      const partEntry = { loaded: 0, total: range.size };
      task.parts.set(range.partNumber, partEntry);
      const body = this._createProgressStream(fileStream, (bytes) => {
        partEntry.loaded = Math.min(partEntry.loaded + bytes, partEntry.total);
        this._tickProgress(task, this._sumPartsLoaded(task));
      });

      const onAbort = () => {
        fileStream.destroy();
        body.destroy();
      };
      task.abortController.signal.addEventListener('abort', onAbort);

      try {
        const res = await client.send(
          new UploadPartCommand({
            Bucket: task.bucket,
            Key: task.key,
            UploadId: uploadId,
            PartNumber: range.partNumber,
            Body: body,
            ContentLength: range.size
          }),
          { abortSignal: task.abortController.signal }
        );
        this._confirmPart(task, range.partNumber, range.size);
        uploadedParts[range.partNumber - 1] = { PartNumber: range.partNumber, ETag: res.ETag };
      } finally {
        task.abortController.signal.removeEventListener('abort', onAbort);
      }
    };

    // Our own small concurrency pool - each worker pulls the next unstarted
    // part and fully awaits it before pulling another, so at most
    // `partConcurrency` parts are ever being read/uploaded at once (unlike
    // lib-storage's chunker, which could read far more ahead than that).
    let nextIndex = 0;
    const runOne = async () => {
      while (nextIndex < ranges.length) {
        if (task.abortController.signal.aborted || firstError) return;
        const range = ranges[nextIndex++];
        try {
          await uploadOnePart(range);
        } catch (err) {
          if (!firstError) firstError = err;
          return;
        }
      }
    };
    const workerCount = Math.max(1, Math.min(this.partConcurrency, ranges.length));
    await Promise.all(Array.from({ length: workerCount }, runOne));

    if (firstError || task.abortController.signal.aborted) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: task.bucket, Key: task.key, UploadId: uploadId })).catch(() => {});
      throw firstError || Object.assign(new Error('Upload aborted.'), { name: 'AbortError' });
    }

    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: task.bucket,
        Key: task.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: uploadedParts.filter(Boolean).sort((a, b) => a.PartNumber - b.PartNumber) }
      })
    );
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

  /**
   * Runs a queued copy/move: same-account items go via a single server-side
   * CopyObjectCommand per object, cross-account items stream through the app
   * (GetObject -> Upload) - identical logic to the old synchronous
   * s3Manager.copyItems(), just broken into per-item steps here so progress
   * can be ticked and the operation shows up in the queue like any transfer.
   *
   * Known limitation (same spirit as pause/resume on uploads): pausing or
   * cancelling only takes effect *between* items, not mid-item, and a
   * paused/retried task re-copies from the first item rather than resuming
   * partway - acceptable since S3-side copies are typically near-instant.
   */
  async _runCopy(task) {
    const srcClient = await this.s3Manager.getClientForBucket(task.connectionId, task.bucket);
    const destClient = await this.s3Manager.getClientForBucket(task.destConnectionId, task.destBucket);
    const sameAccount = this.s3Manager._sameCredentials(task.connectionId, task.destConnectionId);
    const normalizedDestPrefix = task.destPrefix ? (task.destPrefix.endsWith('/') ? task.destPrefix : `${task.destPrefix}/`) : '';
    const sameLocationRoot = task.connectionId === task.destConnectionId && task.bucket === task.destBucket;
    const deletableKeys = [];
    let bytesDone = 0;
    let completedFully = true;

    for (const item of task.items) {
      if (task.cancelRequested || task.pauseRequested) {
        completedFully = false;
        break;
      }
      if (item.type === 'folder') {
        const folderDestPrefix = `${normalizedDestPrefix}${item.name}/`;
        if (sameLocationRoot && folderDestPrefix.startsWith(item.key)) {
          throw new Error(`Cannot ${task.move ? 'move' : 'copy'} folder "${item.name}" into itself.`);
        }
        const copiedKeys = await this.s3Manager._copyFolder({
          srcClient,
          destClient,
          srcBucket: task.bucket,
          destBucket: task.destBucket,
          srcPrefix: item.key,
          destPrefix: folderDestPrefix,
          sameAccount
        });
        deletableKeys.push(...copiedKeys, item.key);
      } else {
        const destKey = `${normalizedDestPrefix}${item.name}`;
        if (sameAccount && task.bucket === task.destBucket && item.key === destKey) {
          throw new Error(`"${item.name}" is already in that location.`);
        }
        await this.s3Manager._copyOneObject({
          srcClient,
          destClient,
          srcBucket: task.bucket,
          destBucket: task.destBucket,
          srcKey: item.key,
          destKey,
          sameAccount
        });
        deletableKeys.push(item.key);
        bytesDone += item.size || 0;
      }
      this._tickProgress(task, bytesDone);
    }

    if (task.move && completedFully && deletableKeys.length) {
      await this.s3Manager.deleteObjects(task.connectionId, task.bucket, deletableKeys);
    }
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
      progressPct: task.size > 0 ? Math.min(100, Math.round((task.transferred / task.size) * 100)) : task.status === 'completed' ? 100 : 0,
      ...(task.type === 'copy'
        ? { move: task.move, srcPrefix: task.srcPrefix, destConnectionId: task.destConnectionId, destBucket: task.destBucket, destPrefix: task.destPrefix }
        : {}),
      ...(task.type === 'upload'
        ? {
            totalParts: task.totalParts || 1,
            partSizeMB: task.partSizeMB,
            parts: task.parts
              ? Array.from(task.parts.entries())
                  .map(([partNumber, p]) => ({
                    partNumber,
                    loaded: p.loaded,
                    total: p.total,
                    progressPct: p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0
                  }))
                  .sort((a, b) => a.partNumber - b.partNumber)
              : []
          }
        : {})
    };
  }

  _emitUpdate() {
    this.emit('update', this.getSnapshot());
  }
}

module.exports = { TransferQueueManager };
