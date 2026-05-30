import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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
// The sha is a CONTENT hash, never a caller-supplied path. The strict regex
// below defends against any key-injection: a caller can only ever name a
// 64-char lowercase-hex string, which can't contain `/`, `..`, NUL, or any
// other key metacharacter. We reject anything else BEFORE building a key.
// ---------------------------------------------------------------------------

/** Lowercase-hex sha256, 64 chars. The only shape a caller may name a blob by. */
const SHA256_REGEX = /^[a-f0-9]{64}$/;

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

export interface BlobPutResult {
  sha256: string;
  size: number;
}

export type BlobGetResult = { bytes: Uint8Array } | { found: false };
export type BlobStatResult = { size: number } | { found: false };

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
 * (+ optional key prefix). Multi-replica-safe: every operation is a single
 * idempotent object op, so concurrent hosts pointed at the same bucket don't
 * race (the content address guarantees identical bytes land at identical keys).
 *
 *   - `put` is idempotent (HeadObject fast-path skips the re-upload when the
 *     content-addressed object already exists; identical bytes → identical key).
 *   - `get` re-verifies the digest and refuses to return tampered bytes.
 *   - `stat` is a HeadObject; `delete` is a DeleteObject (idempotent — S3
 *     returns success whether or not the key existed).
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
    const Key = blobKey(this.prefix, sha256);
    let buf: Buffer;
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key }),
      );
      if (res.Body === undefined) {
        // A GetObject with no body for an existing key shouldn't happen, but
        // treat it as missing rather than crash.
        return { found: false };
      }
      const arr = await res.Body.transformToByteArray();
      buf = Buffer.from(arr);
    } catch (err) {
      if (isNotFound(err)) return { found: false };
      throw err;
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

  /** Size of the addressed blob, or `{ found: false }`. A cheap HeadObject
   *  metadata probe — no digest check, no body transfer. */
  async stat(sha256: string): Promise<BlobStatResult> {
    assertValidSha(sha256);
    const Key = blobKey(this.prefix, sha256);
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key }),
      );
      return { size: res.ContentLength ?? 0 };
    } catch (err) {
      if (isNotFound(err)) return { found: false };
      throw err;
    }
  }

  /**
   * Remove the addressed blob. Idempotent: deleting a missing object is a
   * no-op (S3 DeleteObject returns success regardless; we also swallow any
   * not-found exception a stricter S3-compatible server might raise). GC
   * safety (deleting only unreferenced objects) is the CALLER's responsibility
   * — the reference graph lives with the consumers, not this substrate.
   */
  async delete(sha256: string): Promise<void> {
    assertValidSha(sha256);
    const Key = blobKey(this.prefix, sha256);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key }),
      );
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }
}
