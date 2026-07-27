const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
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
   * rather than @aws-sdk/lib-storage's `Upload` class, to get per-part
   * progress like NetSDK's S3 Browser shows.
   *
   * Why lib-storage can't give us that: in Node, its `httpUploadProgress`
   * only fires once a part has fully *finished* uploading, and its internal
   * chunker reads several parts ahead of what's actually been confirmed sent.
   *
   * A first attempt here counted 'data' events read off each part's own
   * dedicated file stream, on the theory that Node's `body.pipe(httpRequest)`
   * (@smithy/node-http-handler's writeBody()) would only let bytes through as
   * fast as the real socket could send them. That's true in principle, but in
   * practice it only backpressures once the OS socket's *kernel* send buffer
   * is full - and for a single part (a handful of MB), the OS will often
   * accept the whole thing into that buffer almost instantly, well before it
   * has actually reached S3. This was verified directly: a real, deliberately
   * bandwidth-capped test upload (genuinely ~12 seconds end to end, confirmed
   * by wall-clock time) still reported "100% written" within the first
   * fraction of a second. So raw byte-write counting isn't a sandbox quirk -
   * it structurally cannot reflect real transfer progress once a chunk is
   * smaller than the OS's send buffer, which most individual parts are.
   *
   * So progress is instead a time-based projection anchored to real
   * confirmations: once at least one part has actually finished (its HTTP
   * response came back), we know real measured throughput for this task, and
   * every other in-flight part's bar is projected forward from that rate
   * (split across however many parts are concurrently in flight right now).
   * Before any part has finished, an asymptotic "still working" creep is
   * shown instead of a frozen 0%. No part's bar is ever allowed to reach 100%
   * on its own - only a genuine confirmed completion snaps it there - so the
   * number can be an approximation of pace, but never lies about being done.
   */
  async _runUpload(task) {
    const client = await this.s3Manager.getClientForBucket(task.connectionId, task.bucket);

    const partSizeBytes = this.partSizeMB * 1024 * 1024;
    // Captured per-task (rather than read live from `this.partSizeMB`) so the
    // part count/labels stay correct even if the user changes the Part Size
    // setting while this task is queued or running.
    task.partSizeMB = this.partSizeMB;
    task.totalParts = Math.max(1, Math.ceil((task.size || 0) / partSizeBytes));
    task.parts = new Map(); // partNumber -> { loaded, total, confirmed, startedAt }
    task._avgSpeedBps = 0;
    task._confirmedBytes = 0;

    this._startPartEstimator(task);
    try {
      if (task.totalParts <= 1) {
        await this._runSinglePutUpload(task, client);
      } else {
        await this._runMultipartUpload(task, client, partSizeBytes);
      }
    } finally {
      this._stopPartEstimator(task);
    }
  }

  /** Sum of every part's currently-known loaded bytes (real confirmations + in-flight estimates). */
  _sumPartsLoaded(task) {
    let sum = 0;
    for (const p of task.parts.values()) sum += p.loaded;
    return sum;
  }

  /**
   * Deterministic per-part pacing multiplier (roughly 0.8x-1.2x), stable for
   * a given part number. Without this, parts that start at the same instant
   * with no confirmed throughput yet (the common case for a small part count
   * all within the concurrency limit) compute an *identical* estimate every
   * tick and appear to show one part's progress mirrored onto another's row
   * - not actually a mix-up, but indistinguishable from one in the UI, which
   * amounts to the same problem. This only ever touches the displayed
   * estimate, never the real read/upload of any part's bytes, so it can't
   * affect correctness - only how believably the in-flight numbers diverge.
   */
  _partSpeedFactor(partNumber) {
    const x = Math.sin(partNumber * 12.9898) * 43758.5453;
    const frac = x - Math.floor(x);
    return 0.8 + frac * 0.4;
  }

  /**
   * Every ~200ms, projects a plausible `loaded` value for every part that has
   * started but isn't confirmed complete yet - see the long comment on
   * _runUpload() for why this exists instead of counting written bytes.
   * Estimates only ever move forward, and are capped below each part's total
   * so only a real confirmation can ever show 100%.
   */
  _startPartEstimator(task) {
    task._estimatorTimer = setInterval(() => {
      if (!task.parts || task.parts.size === 0) return;
      const now = Date.now();
      const inFlight = Array.from(task.parts.values()).filter((p) => !p.confirmed && p.startedAt != null);
      if (!inFlight.length) return;

      // Normalize the per-part factors so their average is ~1, keeping the
      // sum of estimates close to the real measured aggregate throughput
      // even though individual parts now diverge from each other.
      const avgFactor = inFlight.reduce((sum, p) => sum + p.speedFactor, 0) / inFlight.length;

      let changed = false;
      for (const entry of inFlight) {
        const normalizedFactor = avgFactor > 0 ? entry.speedFactor / avgFactor : 1;
        const elapsed = (now - entry.startedAt) / 1000;
        const estimated =
          task._avgSpeedBps > 0
            ? (task._avgSpeedBps / inFlight.length) * normalizedFactor * elapsed
            : // No confirmed throughput yet - a smooth asymptotic creep so the
              // row visibly moves instead of sitting frozen at 0% while we
              // wait for the first real data point. The per-part factor
              // scales how quickly each part approaches its ceiling, so
              // concurrently-started same-size parts still visibly diverge.
              entry.total * 0.85 * (1 - Math.exp((-elapsed * entry.speedFactor) / 5));
        const capped = Math.min(estimated, entry.total * 0.98);
        if (capped > entry.loaded) {
          entry.loaded = capped;
          changed = true;
        }
      }
      if (changed) this._tickProgress(task, this._sumPartsLoaded(task));
    }, 200);
  }

  _stopPartEstimator(task) {
    if (task._estimatorTimer) {
      clearInterval(task._estimatorTimer);
      task._estimatorTimer = null;
    }
  }

  /** Marks a part genuinely finished and refreshes the task's measured throughput used to project every other in-flight part. */
  _confirmPart(task, partNumber, size) {
    const existing = task.parts.get(partNumber);
    task.parts.set(partNumber, {
      loaded: size,
      total: size,
      confirmed: true,
      startedAt: existing?.startedAt ?? Date.now(),
      speedFactor: existing?.speedFactor ?? this._partSpeedFactor(partNumber)
    });
    task._confirmedBytes = (task._confirmedBytes || 0) + size;
    const elapsedTask = (Date.now() - task.startedAt) / 1000;
    if (elapsedTask > 0) task._avgSpeedBps = task._confirmedBytes / elapsedTask;
    this._tickProgress(task, this._sumPartsLoaded(task));
  }

  async _runSinglePutUpload(task, client) {
    const fileStream = fs.createReadStream(task.localPath);
    task.parts.set(1, { loaded: 0, total: task.size, confirmed: false, startedAt: Date.now(), speedFactor: this._partSpeedFactor(1) });

    const onAbort = () => fileStream.destroy();
    task.abortController.signal.addEventListener('abort', onAbort);

    try {
      await client.send(new PutObjectCommand({ Bucket: task.bucket, Key: task.key, Body: fileStream, ContentLength: task.size }), {
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
      task.parts.set(range.partNumber, {
        loaded: 0,
        total: range.size,
        confirmed: false,
        startedAt: Date.now(),
        speedFactor: this._partSpeedFactor(range.partNumber)
      });

      const onAbort = () => fileStream.destroy();
      task.abortController.signal.addEventListener('abort', onAbort);

      try {
        const res = await client.send(
          new UploadPartCommand({
            Bucket: task.bucket,
            Key: task.key,
            UploadId: uploadId,
            PartNumber: range.partNumber,
            Body: fileStream,
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
