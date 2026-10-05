import { createHash } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { PluginError } from '@ax/core';

// ---------------------------------------------------------------------------
// Content-addressed S3-compatible blob store.
//
// This is the SECOND backend behind the storage-agnostic `blob:*` service hook
// (TASK-65 / @ax/blob-store-fs is the first). Same content-addressing contract,
// different substrate: objects live at `<prefix><sha[0:2]>/<sha[2:4]>/<sha>`
// inside a single S3-compatible bucket (MinIO / GCS via its S3 endpoint /
// AWS S3 / R2), keyed by the lowercase-hex sha256 of their bytes.
//
// We keep the same two-level shard the fs backend uses. S3 has a flat
// keyspace so the shard isn't strictly required, but it keeps object keys
// parity with fs (a migration / dual-read tool can map one to the other) and
// it costs nothing.
//
// Deleting is two-phase (blob GC design D3): `retire` moves a blob out of the
// live namespace into `<prefix>/retired/<aa>/<bb>/<sha>`, a read (`get` /
// `stat`) that misses the live key moves it back, and `purge` deletes the
// retired copy for good. S3 has no rename, so each move is CopyObject then
// DeleteObject — two requests, not one atomic step (see SECURITY.md). The copy
// always goes first, so a crash between them leaves both copies (never none);
// @ax/blob-gc's sweep finds the sha in both listings and repairs it.
//
// The sha is a CONTENT hash, never a caller-supplied path. The strict regex
// below defends against any key-injection: a caller can only ever name a
// 64-char lowercase-hex string, which can't contain `/`, `..`, NUL, or any
// other key metacharacter. We reject anything else BEFORE building a key.
// ---------------------------------------------------------------------------

/** Lowercase-hex sha256, 64 chars. The only shape a caller may name a blob by. */
const SHA256_REGEX = /^[a-f0-9]{64}$/;

/**
 * What a blob's key looks like once its namespace prefix (the store prefix for
 * live blobs, `<prefix>/retired/` for retired ones) is stripped:
 * `<aa>/<bb>/<sha>`, with the sha filed under its own shard. Anything else
 * (`retired/...` seen from the live side, `<sha>.tmp.<x>` leftovers, stray
 * objects) is not a blob.
 */
const SHARD_KEY_REGEX = /^([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

/** The sub-namespace retired blobs live under, inside the store prefix. */
const RETIRED_DIR = 'retired';

/** The most blobs one `list` page may carry. */
const LIST_MAX_LIMIT = 1000;

const PLUGIN_NAME = '@ax/blob-store-s3';

function assertValidSha(sha256: string): void {
  if (typeof sha256 !== 'string' || !SHA256_REGEX.test(sha256)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: 'sha256 must be 64 lowercase-hex characters',
    });
  }
}

/**
 * Strip trailing `/` characters without a regex. We deliberately avoid
 * `replace(/\/+$/, '')` — that anchored `+`-quantified pattern is a
 * polynomial-ReDoS shape (`js/polynomial-redos`) that backtracks on a string
 * of many slashes. A reverse character scan is O(n) with no backtracking.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return end === s.length ? s : s.slice(0, end);
}

/**
 * Resolve the object key for a content hash within the bucket. The two-level
 * shard (`<sha[0:2]>/<sha[2:4]>`) mirrors the fs backend. `prefix` is an
 * operator-supplied namespace within the bucket (empty = bucket root); we
 * normalize away a trailing slash so `'blobs'` and `'blobs/'` produce the
 * same key. `sha256` MUST already be validated by `assertValidSha`.
 */
export function blobKey(prefix: string, sha256: string): string {
  const shard = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  if (prefix === '') return shard;
  return `${stripTrailingSlashes(prefix)}/${shard}`;
}

/**
 * Resolve the RETIRED object key for a content hash:
 * `<prefix>/retired/<aa>/<bb>/<sha>`, or `retired/<aa>/<bb>/<sha>` with an empty
 * prefix. `purge` builds its key ONLY through this helper, so it can never
 * address a live blob. `sha256` MUST already be validated by `assertValidSha`.
 */
export function retiredBlobKey(prefix: string, sha256: string): string {
  const shard = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  if (prefix === '') return `${RETIRED_DIR}/${shard}`;
  return `${stripTrailingSlashes(prefix)}/${RETIRED_DIR}/${shard}`;
}

/**
 * CopyObject's `CopySource`: `<bucket>/<key>`, each path segment URL-encoded
 * (the SDK sends it as a header verbatim). Our keys are hex + `/` + the
 * operator's prefix, so this only matters for an unusual bucket / prefix, but
 * an unencoded one would copy the wrong object or fail to sign.
 */
function copySource(bucket: string, key: string): string {
  return [bucket, ...key.split('/')].map((seg) => encodeURIComponent(seg)).join('/');
}

export interface BlobPutResult {
  sha256: string;
  size: number;
}

export type BlobGetResult = { bytes: Uint8Array } | { found: false };
export type BlobStatResult = { size: number } | { found: false };

/** `stat` options. `restore` defaults to true; `false` reports a retired blob's
 *  size without moving it back (for probes that must not undo a retire). */
export interface BlobStatOptions {
  restore?: boolean | undefined;
}

/** One page request for `list`. `after` is the cursor from the previous page. */
export interface BlobListQuery {
  state: 'live' | 'retired';
  after?: string;
  limit: number;
}
/** One page of `list`. `next` is present iff the page is full — see `list`. */
export interface BlobListResult {
  items: Array<{ sha256: string; size: number }>;
  next?: string;
}

function invalidListInput(message: string): PluginError {
  return new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, message });
}

/** Validate a `list` request before anything is sent to S3. The hook bus hands
 *  us unchecked JSON-ish input, so check every field's runtime type. */
function assertValidListQuery(q: BlobListQuery): void {
  if (q.state !== 'live' && q.state !== 'retired') {
    throw invalidListInput("state must be 'live' or 'retired'");
  }
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > LIST_MAX_LIMIT) {
    throw invalidListInput(`limit must be an integer between 1 and ${LIST_MAX_LIMIT}`);
  }
  if (q.after !== undefined && (typeof q.after !== 'string' || !SHA256_REGEX.test(q.after))) {
    throw invalidListInput('after must be 64 lowercase-hex characters');
  }
}

/**
 * Is this an S3 "object not found" error? HeadObject throws `NotFound` and
 * GetObject throws `NoSuchKey`; some S3-compatible servers (MinIO, GCS) report
 * it as a 404 on a differently-named exception. We treat any of those as
 * "missing" so `stat`/`get` return `{ found: false }` rather than throwing.
 */
function isNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e.name === 'NotFound' ||
    e.name === 'NoSuchKey' ||
    e.Code === 'NoSuchKey' ||
    e.$metadata?.httpStatusCode === 404
  );
}

/**
 * An S3-backed content-addressed blob store rooted at a single bucket
 * (+ optional key prefix). Every operation is idempotent, and identical bytes
 * always land at identical keys, so concurrent hosts pointed at the same bucket
 * converge.
 *
 *   - `put` is idempotent (HeadObject fast-path skips the re-upload when the
 *     content-addressed object already exists; identical bytes → identical key).
 *   - `get` re-verifies the digest and refuses to return tampered bytes.
 *   - `stat` is a HeadObject.
 *   - `get` and `stat` restore a retired blob on a live miss (design D3).
 *   - `retire` moves live → retired; `purge` deletes the retired copy only.
 *   - `list` is a ListObjectsV2 scan of the live or retired keys, a page at a time.
 */
export class S3BlobStore {
  private readonly prefix: string;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    keyPrefix = '',
  ) {
    this.prefix = stripTrailingSlashes(keyPrefix);
  }

  /**
   * Store `bytes`, returning their content hash + size. Idempotent: storing the
   * same bytes again is a no-op upload (the object already lives at the
   * content-addressed key). We compute the sha256 in-process — we never trust
   * the server to content-address for us, because `get` will re-verify the
   * digest regardless of backend (it's OUR integrity invariant, not S3's).
   */
  async put(bytes: Uint8Array): Promise<BlobPutResult> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const Key = blobKey(this.prefix, sha256);

    // Fast path: already stored. Content-addressed, so identical bytes are
    // already under this exact key — skip the upload.
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key }),
      );
      return { sha256, size: buf.length };
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // Not present yet — fall through to upload.
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key,
        Body: buf,
        ContentLength: buf.length,
      }),
    );
    return { sha256, size: buf.length };
  }

  /**
   * Read the blob addressed by `sha256`, RE-VERIFYING its digest before
   * returning. A tampered / corrupted object (bitrot, or an attacker who wrote
   * bytes that don't match the key's hash) is REJECTED with a `corrupt` error —
   * never returned. Missing → `{ found: false }`.
   */
  async get(sha256: string): Promise<BlobGetResult> {
    assertValidSha(sha256);
    let buf = await this.readLive(sha256);
    if (buf === undefined) {
      // Live miss: the blob may be retired (D3). Move it back, then read live
      // again. If the restore found nothing (another reader restored it first,
      // a purge won, or it was never there) this is the single re-read.
      await this.restore(sha256);
      buf = await this.readLive(sha256);
      if (buf === undefined) return { found: false };
    }
    // Re-verify: the content MUST hash to the key it was stored under. If it
    // doesn't, the object is corrupt or tampered — refuse to serve it.
    const computed = createHash('sha256').update(buf).digest('hex');
    if (computed !== sha256) {
      throw new PluginError({
        code: 'corrupt',
        plugin: PLUGIN_NAME,
        message: 'stored object failed digest re-verification',
      });
    }
    return { bytes: new Uint8Array(buf) };
  }

  /**
   * Size of the addressed blob, or `{ found: false }`. A cheap HeadObject
   * metadata probe — no digest check, no body transfer. On a live miss it
   * restores a retired copy (like `get`) unless `restore: false`, in which case
   * it reports the retired copy's size and leaves it where it is.
   */
  async stat(sha256: string, options: BlobStatOptions = {}): Promise<BlobStatResult> {
    assertValidSha(sha256);
    const { restore } = options;
    if (restore !== undefined && typeof restore !== 'boolean') {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: 'restore must be a boolean',
      });
    }
    const live = blobKey(this.prefix, sha256);
    let size = await this.headSize(live);
    if (size !== undefined) return { size };
    if (restore === false) {
      size = await this.headSize(retiredBlobKey(this.prefix, sha256));
      return size === undefined ? { found: false } : { size };
    }
    await this.restore(sha256);
    size = await this.headSize(live);
    return size === undefined ? { found: false } : { size };
  }

  /**
   * Move a blob out of the live namespace: CopyObject live → retired, then
   * DeleteObject live. A missing live key is a no-op (nothing to retire, and we
   * must not delete anything). Idempotent: a second retire finds no live key.
   *
   * Not atomic. Between the copy and the delete both copies exist, which is
   * harmless: a put in that window sees the live key, returns, and the delete
   * then leaves its blob only in `retired/`, where the next read restores it (D3).
   */
  async retire(sha256: string): Promise<void> {
    assertValidSha(sha256);
    const live = blobKey(this.prefix, sha256);
    const copied = await this.copy(live, retiredBlobKey(this.prefix, sha256));
    if (!copied) return;
    await this.deleteKey(live);
  }

  /**
   * Delete the RETIRED copy of a blob, for good. Missing is a no-op. The key is
   * built only through `retiredBlobKey`, so a purge can never touch the live
   * blob of the same sha (one that was restored, or put again, since the
   * retire). Whether nobody holds the sha any more is the caller's (the GC's)
   * call — this layer has no reference graph.
   */
  async purge(sha256: string): Promise<void> {
    assertValidSha(sha256);
    await this.deleteKey(retiredBlobKey(this.prefix, sha256));
  }

  /** The live object's bytes, or undefined when the key is missing. */
  private async readLive(sha256: string): Promise<Buffer | undefined> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: blobKey(this.prefix, sha256) }),
      );
      // A GetObject with no body for an existing key shouldn't happen, but
      // treat it as missing rather than crash.
      if (res.Body === undefined) return undefined;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /** HeadObject size of `Key`, or undefined when it is missing. */
  private async headSize(Key: string): Promise<number | undefined> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key }));
      return res.ContentLength ?? 0;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /**
   * Move retired → live: CopyObject retired → live, then DeleteObject retired.
   * Returns quietly when the retired copy is gone (lost a race with another
   * restore or a purge, or nothing was ever retired); the caller re-reads live
   * once either way. Overwriting a live key that a concurrent put just wrote is
   * harmless: same key, same bytes.
   */
  private async restore(sha256: string): Promise<void> {
    const retired = retiredBlobKey(this.prefix, sha256);
    const copied = await this.copy(retired, blobKey(this.prefix, sha256));
    if (copied) await this.deleteKey(retired);
  }

  /** CopyObject `from` → `to` in this bucket. False when `from` is missing. */
  private async copy(from: string, to: string): Promise<boolean> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: to,
          CopySource: copySource(this.bucket, from),
        }),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** DeleteObject, idempotent: S3 returns success for a missing key, and we
   *  also swallow the not-found a stricter S3-compatible server might raise. */
  private async deleteKey(Key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }));
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  /**
   * One page of live (or retired) blobs, ascending by sha256. This is the GC's enumeration
   * seam (`blob:list`): it finds blobs no ledger row has ever seen.
   *
   * `after` is exclusive — pass the previous page's `next`. `next` is present
   * iff the page holds exactly `limit` items, and then it IS the last item's
   * sha. So a final page can legitimately be empty (an exact multiple of
   * `limit`); callers loop until `next` is absent. The key is left OFF rather
   * than set to `undefined`, so it survives the bus's `returns` schema as-is.
   *
   * This is a ListObjectsV2 scan under `<prefix>/`, which S3 already returns in
   * key order. Since every live key is `<aa>/<bb>/<sha>` and `<aa>` leads with a
   * hex char, `StartAfter = blobKey(after)` resumes exactly after the cursor.
   * Only keys shaped like a live blob count; that leaves out
   * `<sha>.tmp.<x>` leftovers (not blobs yet) and the `retired/` namespace. S3
   * lists keys by byte order and 'r' sorts after every hex digit, so the first
   * key whose remainder starts past 'f' ends the live region and we stop there
   * instead of paging through everything retired.
   *
   * `state: 'retired'` is the same scan with the same contract over
   * `<prefix>/retired/`, resuming at `StartAfter = retiredBlobKey(after)`.
   */
  async list(query: BlobListQuery): Promise<BlobListResult> {
    assertValidListQuery(query);
    const { state, after, limit } = query;
    const retired = state === 'retired';

    // The empty prefix means "the whole bucket"; don't send `Prefix: ''`.
    const base = this.prefix === '' ? '' : `${this.prefix}/`;
    const listPrefix = retired ? `${base}${RETIRED_DIR}/` : base;
    const keyOf = retired ? retiredBlobKey : blobKey;
    const items: BlobListResult['items'] = [];
    let ContinuationToken: string | undefined;

    for (;;) {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(listPrefix === '' ? {} : { Prefix: listPrefix }),
          ...(after === undefined ? {} : { StartAfter: keyOf(this.prefix, after) }),
          MaxKeys: limit,
          ...(ContinuationToken === undefined ? {} : { ContinuationToken }),
        }),
      );

      for (const obj of res.Contents ?? []) {
        const key = obj.Key;
        if (key === undefined || !key.startsWith(listPrefix)) continue;
        const rest = key.slice(listPrefix.length);
        // Live scan, past the hex shards (`retired/...`): nothing live sorts
        // after this. (The retired scan's Prefix already confines it.)
        if (!retired && rest.charAt(0) > 'f') return { items };
        const m = SHARD_KEY_REGEX.exec(rest);
        if (m === null) continue;
        const sha256 = m[3]!;
        if (!sha256.startsWith(m[1]! + m[2]!)) continue;
        items.push({ sha256, size: obj.Size ?? 0 });
        if (items.length === limit) return { items, next: sha256 };
      }

      if (res.IsTruncated !== true || res.NextContinuationToken === undefined) {
        return { items };
      }
      ContinuationToken = res.NextContinuationToken;
    }
  }
}
