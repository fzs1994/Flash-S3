const https = require('https');
const fs = require('fs');
const {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');

/**
 * Reads the x-amz-bucket-region header directly over HTTPS, bypassing the
 * AWS SDK entirely for this one lookup.
 *
 * S3 includes this header on every response for a bucket - including a 403
 * Forbidden for a request with no/invalid credentials - regardless of which
 * region's endpoint you hit. That makes it a reliable, permission-free way
 * to discover a bucket's real region up front.
 *
 * (The AWS SDK v3 client also has a `followRegionRedirects` option meant to
 * solve this reactively, but it has known bugs - it can throw instead of
 * redirecting for ListObjectsV2/HeadObject in some SDK versions - so we
 * resolve the region proactively instead of depending on it.)
 */
function fetchBucketRegionHeader(bucket) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        method: 'HEAD',
        hostname: 's3.amazonaws.com',
        // Path-style (not virtual-hosted) so bucket names containing dots
        // don't run into TLS wildcard-certificate mismatches.
        path: `/${encodeURIComponent(bucket)}`,
        timeout: 5000
      },
      (res) => {
        resolve(res.headers['x-amz-bucket-region'] || null);
        res.resume();
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/** Quotes a CSV field only if it needs it (contains a comma, quote, or newline), doubling any internal quotes. */
function csvField(value) {
  const str = value === undefined || value === null ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Owns the S3Clients for saved connection profiles and exposes the
 * bucket / object operations the UI needs. Kept free of any transfer
 * (upload/download) logic - that lives in transfer-queue.js.
 *
 * A connection profile has a single "home" region, but individual buckets
 * can live anywhere. Every bucket-scoped operation resolves the bucket's
 * real region first (cached) and runs against a client scoped to that
 * region, so cross-region buckets just work regardless of what region the
 * connection profile itself was created with.
 */
class S3Manager {
  constructor(credentialStore) {
    this.credentialStore = credentialStore;
    this.clients = new Map(); // connectionId -> S3Client (profile's home region)
    this.regionalClients = new Map(); // "connectionId:region" -> S3Client
    this.bucketRegionCache = new Map(); // "connectionId:bucket" -> region
  }

  _buildClient(profile, region) {
    return new S3Client({
      region: region || profile.region || 'us-east-1',
      credentials: {
        accessKeyId: profile.accessKeyId,
        secretAccessKey: profile.secretAccessKey
      },
      maxAttempts: 3,
      // Without this, the SDK defaults to "WHEN_SUPPORTED" and silently wraps
      // every streaming request body (PutObject/UploadPart) in an aws-chunked
      // + trailing-checksum stream (@smithy/core's getAwsChunkedEncodingStream).
      // That wrapper attaches its own `.on('data', ...)` listener to our body
      // stream to compute the checksum, which forces the stream into flowing
      // mode and drains it into its own internal buffer as fast as Node can
      // read - completely ignoring whether the real HTTP write has actually
      // gone out over the socket yet. That's what made our per-part progress
      // counters (attached to that same body stream) race straight to 100%
      // regardless of real upload speed. We don't request checksums on our
      // upload commands, so this just stops the SDK from adding one uninvited.
      requestChecksumCalculation: 'WHEN_REQUIRED'
    });
  }

  getClient(connectionId) {
    if (this.clients.has(connectionId)) return this.clients.get(connectionId);

    const profile = this.credentialStore.getFull(connectionId);
    if (!profile) throw new Error(`Unknown connection: ${connectionId}`);

    const client = this._buildClient(profile);
    this.clients.set(connectionId, client);
    return client;
  }

  _getRegionalClient(connectionId, region) {
    const cacheKey = `${connectionId}:${region}`;
    if (this.regionalClients.has(cacheKey)) return this.regionalClients.get(cacheKey);

    const profile = this.credentialStore.getFull(connectionId);
    if (!profile) throw new Error(`Unknown connection: ${connectionId}`);

    const client = this._buildClient(profile, region);
    this.regionalClients.set(cacheKey, client);
    return client;
  }

  async _resolveBucketRegion(connectionId, bucket) {
    const cacheKey = `${connectionId}:${bucket}`;
    if (this.bucketRegionCache.has(cacheKey)) return this.bucketRegionCache.get(cacheKey);

    const profile = this.credentialStore.getFull(connectionId);
    let region = (profile && profile.region) || 'us-east-1';

    const headerRegion = await fetchBucketRegionHeader(bucket);
    if (headerRegion) region = headerRegion;

    this.bucketRegionCache.set(cacheKey, region);
    return region;
  }

  /** Resolve + return the client that should be used for a specific bucket. */
  async getClientForBucket(connectionId, bucket) {
    const region = await this._resolveBucketRegion(connectionId, bucket);
    return this._getRegionalClient(connectionId, region);
  }

  invalidateClient(connectionId) {
    this.clients.delete(connectionId);
    for (const key of Array.from(this.regionalClients.keys())) {
      if (key.startsWith(`${connectionId}:`)) this.regionalClients.delete(key);
    }
    for (const key of Array.from(this.bucketRegionCache.keys())) {
      if (key.startsWith(`${connectionId}:`)) this.bucketRegionCache.delete(key);
    }
  }

  async testConnection(profile) {
    const client = new S3Client({
      region: profile.region || 'us-east-1',
      credentials: {
        accessKeyId: profile.accessKeyId,
        secretAccessKey: profile.secretAccessKey
      },
      maxAttempts: 2
    });
    await client.send(new ListBucketsCommand({}));
    return { ok: true };
  }

  async listBuckets(connectionId) {
    const client = this.getClient(connectionId);
    const res = await client.send(new ListBucketsCommand({}));
    return (res.Buckets || []).map((b) => ({
      name: b.Name,
      creationDate: b.CreationDate
    }));
  }

  async listObjects(connectionId, bucket, prefix = '', continuationToken) {
    const client = await this.getClientForBucket(connectionId, bucket);
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: continuationToken,
        MaxKeys: 1000
      })
    );

    const folders = (res.CommonPrefixes || []).map((p) => ({
      type: 'folder',
      key: p.Prefix,
      name: p.Prefix.replace(prefix, '').replace(/\/$/, '')
    }));

    const files = (res.Contents || [])
      .filter((o) => o.Key !== prefix) // exclude the "folder marker" object itself
      .map((o) => ({
        type: 'file',
        key: o.Key,
        name: o.Key.replace(prefix, ''),
        size: o.Size,
        lastModified: o.LastModified,
        storageClass: o.StorageClass
      }));

    return {
      items: [...folders, ...files],
      isTruncated: !!res.IsTruncated,
      nextContinuationToken: res.NextContinuationToken || null
    };
  }

  /**
   * Exports the *entire* current folder listing (every page, not just the
   * first 1000 the UI shows) to a CSV file at `destPath`. Only the immediate
   * contents of `prefix` are listed - subfolders appear as a single row each,
   * matching what the folder view itself shows, rather than recursing into
   * every descendant.
   */
  async exportListingToCsv(connectionId, bucket, prefix, destPath) {
    const client = await this.getClientForBucket(connectionId, bucket);
    const rows = [['Name', 'Type', 'Size (bytes)', 'Last Modified', 'Storage Class', 'Full Path']];

    let continuationToken;
    do {
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: '/',
          ContinuationToken: continuationToken,
          MaxKeys: 1000
        })
      );

      for (const p of res.CommonPrefixes || []) {
        const name = p.Prefix.replace(prefix, '').replace(/\/$/, '');
        rows.push([name, 'Folder', '', '', '', p.Prefix]);
      }

      for (const o of res.Contents || []) {
        if (o.Key === prefix) continue; // the folder marker object itself, if any
        const name = o.Key.replace(prefix, '');
        rows.push([
          name,
          'File',
          o.Size ?? '',
          o.LastModified ? new Date(o.LastModified).toISOString() : '',
          o.StorageClass || '',
          o.Key
        ]);
      }

      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    const csv = rows.map((row) => row.map(csvField).join(',')).join('\r\n');
    fs.writeFileSync(destPath, csv, 'utf8');
    return { path: destPath, rowCount: rows.length - 1 };
  }

  async createFolder(connectionId, bucket, key) {
    const client = await this.getClientForBucket(connectionId, bucket);
    const folderKey = key.endsWith('/') ? key : `${key}/`;
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: folderKey, Body: '' }));
    return { key: folderKey };
  }

  async deleteObjects(connectionId, bucket, keys) {
    const client = await this.getClientForBucket(connectionId, bucket);
    // S3 batch delete supports up to 1000 keys per request.
    const chunks = [];
    for (let i = 0; i < keys.length; i += 1000) chunks.push(keys.slice(i, i + 1000));

    for (const chunk of chunks) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true }
        })
      );
    }
    return { deleted: keys.length };
  }

  async renameObject(connectionId, bucket, oldKey, newKey) {
    const client = await this.getClientForBucket(connectionId, bucket);
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `/${bucket}/${encodeURIComponent(oldKey).replace(/%2F/g, '/')}`,
        Key: newKey
      })
    );
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: [{ Key: oldKey }], Quiet: true }
      })
    );
    return { newKey };
  }

  /** True if two connection profiles use the identical AWS credentials (so a server-side CopyObject can span them). */
  _sameCredentials(connA, connB) {
    if (connA === connB) return true;
    const a = this.credentialStore.getFull(connA);
    const b = this.credentialStore.getFull(connB);
    return !!a && !!b && a.accessKeyId === b.accessKeyId && a.secretAccessKey === b.secretAccessKey;
  }

  /**
   * Copies (or moves, when `move` is true) one or more selected items - files
   * and/or folders - to a destination bucket + prefix, which may belong to a
   * completely different saved connection/account.
   *
   * Same-credentials copies use a single server-side CopyObjectCommand (no
   * data flows through this process). Cross-account copies fall back to
   * streaming the object through the app (download from source, upload to
   * destination), since S3 can't server-side-copy across accounts without
   * pre-arranged bucket policies we can't assume exist.
   *
   * Folders are virtual (S3 has no real directories), so copying one means
   * recursively listing every object under its prefix and copying each,
   * remapping the prefix. A move deletes every object that was actually
   * copied (not just the top-level selected keys) once all copies succeed.
   */
  async copyItems({ items, srcConnectionId, srcBucket, destConnectionId, destBucket, destPrefix, move }) {
    const normalizedDestPrefix = destPrefix ? (destPrefix.endsWith('/') ? destPrefix : `${destPrefix}/`) : '';
    const sameLocationRoot = srcConnectionId === destConnectionId && srcBucket === destBucket;

    const srcClient = await this.getClientForBucket(srcConnectionId, srcBucket);
    const destClient = await this.getClientForBucket(destConnectionId, destBucket);
    const sameAccount = this._sameCredentials(srcConnectionId, destConnectionId);

    const deletableKeys = []; // actual object keys to remove from the source on a move

    for (const item of items) {
      if (item.type === 'folder') {
        const folderDestPrefix = `${normalizedDestPrefix}${item.name}/`;
        // Guard against copying/moving a folder into itself or one of its own
        // descendants (including copying it right back to the same spot) -
        // without this, the recursive listing below would pick up objects
        // this same operation just wrote and copy them again, forever.
        if (sameLocationRoot && folderDestPrefix.startsWith(item.key)) {
          throw new Error(`Cannot ${move ? 'move' : 'copy'} folder "${item.name}" into itself.`);
        }
        const copiedKeys = await this._copyFolder({
          srcClient,
          destClient,
          srcBucket,
          destBucket,
          srcPrefix: item.key,
          destPrefix: folderDestPrefix,
          sameAccount
        });
        deletableKeys.push(...copiedKeys, item.key);
      } else {
        const destKey = `${normalizedDestPrefix}${item.name}`;
        if (sameAccount && srcBucket === destBucket && item.key === destKey) {
          throw new Error(`"${item.name}" is already in that location.`);
        }
        await this._copyOneObject({ srcClient, destClient, srcBucket, destBucket, srcKey: item.key, destKey, sameAccount });
        deletableKeys.push(item.key);
      }
    }

    if (move && deletableKeys.length) {
      await this.deleteObjects(srcConnectionId, srcBucket, deletableKeys);
    }

    return { copied: items.length };
  }

  async _copyOneObject({ srcClient, destClient, srcBucket, destBucket, srcKey, destKey, sameAccount }) {
    if (sameAccount) {
      await destClient.send(
        new CopyObjectCommand({
          Bucket: destBucket,
          Key: destKey,
          CopySource: `/${srcBucket}/${encodeURIComponent(srcKey).replace(/%2F/g, '/')}`
        })
      );
    } else {
      const res = await srcClient.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
      const uploader = new Upload({
        client: destClient,
        params: { Bucket: destBucket, Key: destKey, Body: res.Body },
        queueSize: 4,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false
      });
      await uploader.done();
    }
  }

  /** Recursively copies every object under `srcPrefix` to `destPrefix`, preserving relative structure. Returns the copied source keys. */
  async _copyFolder({ srcClient, destClient, srcBucket, destBucket, srcPrefix, destPrefix, sameAccount }) {
    const copiedKeys = [];
    let continuationToken;
    do {
      const res = await srcClient.send(
        new ListObjectsV2Command({
          Bucket: srcBucket,
          Prefix: srcPrefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000
        })
      );
      for (const obj of res.Contents || []) {
        const relativeKey = obj.Key.slice(srcPrefix.length);
        const destKey = `${destPrefix}${relativeKey}`;
        await this._copyOneObject({ srcClient, destClient, srcBucket, destBucket, srcKey: obj.Key, destKey, sameAccount });
        copiedKeys.push(obj.Key);
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return copiedKeys;
  }

  async createBucket(connectionId, bucket, region) {
    const client = this.getClient(connectionId);
    const params = { Bucket: bucket };
    if (region && region !== 'us-east-1') {
      params.CreateBucketConfiguration = { LocationConstraint: region };
    }
    await client.send(new CreateBucketCommand(params));
    return { bucket };
  }

  async deleteBucket(connectionId, bucket) {
    const client = await this.getClientForBucket(connectionId, bucket);
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    this.bucketRegionCache.delete(`${connectionId}:${bucket}`);
    return { deleted: true };
  }

  async headBucket(connectionId, bucket) {
    const client = await this.getClientForBucket(connectionId, bucket);
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { ok: true };
  }

  async getPresignedUrl(connectionId, bucket, key, expiresInSeconds = 3600) {
    const client = await this.getClientForBucket(connectionId, bucket);
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    return { url };
  }
}

module.exports = { S3Manager };
