import { S3Client } from '@aws-sdk/client-s3';
import type { Plugin } from '@ax/core';
import { z, type ZodType } from 'zod';
import { S3BlobStore } from './store.js';

const PLUGIN_NAME = '@ax/blob-store-s3';

export interface BlobStoreS3Config {
  /**
   * Bucket the content-addressed objects live in. Operator-supplied + trusted
   * — caller hook payloads NEVER influence the bucket (it's not a payload
   * field; see I1). The bucket must already exist (provisioned by the chart's
   * MinIO bootstrap in dev, or by the operator / Terraform in prod).
   */
  bucket: string;
  /**
   * S3-compatible endpoint URL. MinIO: the in-cluster Service URL. GCS:
   * `https://storage.googleapis.com`. AWS S3 / R2: their regional endpoints.
   * Omit to let the SDK use the AWS default for `region`.
   */
  endpoint?: string;
  /**
   * Region. Required by the SDK's signer even for non-AWS endpoints (MinIO
   * accepts any value; GCS wants the bucket's region). Defaults to
   * `us-east-1` — the conventional placeholder for S3-compatible servers.
   */
  region?: string;
  /**
   * Path-style addressing (`https://endpoint/bucket/key`) instead of
   * virtual-host style (`https://bucket.endpoint/key`). MinIO and GCS's S3
   * endpoint need path-style; defaults to `true` because every non-AWS target
   * we support wants it. Set `false` for AWS S3 proper.
   */
  forcePathStyle?: boolean;
  /**
   * Static access key. DEV / MinIO only — sourced from the credential vault /
   * a k8s Secret, never committed. OMIT in prod: leaving these unset makes the
   * SDK use its default credential provider chain (Workload Identity / IRSA /
   * GKE metadata / instance profile) so there are NO static keys in the tree.
   */
  accessKeyId?: string;
  /** Static secret key. Same DEV-only caveat as `accessKeyId`. */
  secretAccessKey?: string;
  /**
   * Optional namespace prefix within the bucket (e.g. `blobs`). Lets one
   * bucket host multiple stores. Empty = bucket root. Not a payload field.
   */
  keyPrefix?: string;
}

// ---------------------------------------------------------------------------
// blob:* hook I/O types. Payloads carry ONLY sha256 / bytes / size — no backend
// vocabulary (no bucket, endpoint, region, oid, lfs, pack, ref, commit, path,
// key). This is a STRUCTURALLY-IDENTICAL copy of @ax/blob-store-fs's surface,
// re-declared (NOT imported — invariant I2) so the two backends agree on the
// contract without runtime coupling. `bytes` is a raw Uint8Array on the bus
// (NOT base64-in-JSON) so the eventual IPC binary wire can carry it over the
// callBinary octet-stream channel without re-encoding (design Part A). I1.
// ---------------------------------------------------------------------------

export interface BlobPutInput {
  bytes: Uint8Array;
}
export interface BlobPutOutput {
  sha256: string;
  size: number;
}

export interface BlobGetInput {
  sha256: string;
}
export type BlobGetOutput = { bytes: Uint8Array } | { found: false };

export interface BlobStatInput {
  sha256: string;
}
export type BlobStatOutput = { size: number } | { found: false };

export interface BlobDeleteInput {
  sha256: string;
}
export type BlobDeleteOutput = Record<string, never>;

// ---------------------------------------------------------------------------
// Runtime `returns` contracts (ARCH-13 drift-guard pattern). Each schema is a
// per-registration in-process shape assertion. They co-locate with this
// registering plugin and are a structurally-identical copy of
// @ax/blob-store-fs's schemas — the two-backend I2 pattern (like storage-sqlite
// / storage-postgres). `z.instanceof(Uint8Array)` accepts the Uint8Array the
// handler exposes at the edge; the drift-guard test round-trips a populated
// value and asserts the bytes survive by reference.
// ---------------------------------------------------------------------------

export const BlobPutOutputSchema = z.object({
  sha256: z.string(),
  size: z.number(),
});

export const BlobGetOutputSchema = z.union([
  z.object({ bytes: z.instanceof(Uint8Array) }),
  z.object({ found: z.literal(false) }),
]) as unknown as ZodType<BlobGetOutput>;

export const BlobStatOutputSchema = z.union([
  z.object({ size: z.number() }),
  z.object({ found: z.literal(false) }),
]) as unknown as ZodType<BlobStatOutput>;

export const BlobDeleteOutputSchema = z.object({}) as unknown as ZodType<BlobDeleteOutput>;

/**
 * Build the S3Client from the plugin config. Credentials are passed ONLY when
 * both static keys are present (dev / MinIO); otherwise they're omitted so the
 * SDK's default provider chain (Workload Identity / IRSA / metadata) supplies
 * them — the no-static-keys prod posture.
 */
export function buildS3Client(config: BlobStoreS3Config): S3Client {
  const opts: ConstructorParameters<typeof S3Client>[0] = {
    region: config.region ?? 'us-east-1',
    forcePathStyle: config.forcePathStyle ?? true,
    // AWS SDK JS v3 (since early 2025) defaults requestChecksumCalculation to
    // WHEN_SUPPORTED, which adds an x-amz-checksum-crc32 header (and a
    // STREAMING-…-TRAILER content-sha256) to PutObject by default. Many
    // S3-COMPATIBLE servers — MinIO releases before the trailer support, and
    // GCS's S3 endpoint — reject or mis-sign those new default trailers, so a
    // plain blob:put fails against exactly the dev (MinIO) + prod (GCS) targets
    // this backend exists for. Pin both knobs to WHEN_REQUIRED to restore the
    // pre-2025 behavior every S3-compatible server accepts: checksums are sent
    // only when the operation genuinely requires them (none of ours do). Our
    // own digest re-verification on read is the integrity guarantee regardless.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
  if (config.endpoint !== undefined && config.endpoint !== '') {
    opts.endpoint = config.endpoint;
  }
  if (
    config.accessKeyId !== undefined &&
    config.accessKeyId !== '' &&
    config.secretAccessKey !== undefined &&
    config.secretAccessKey !== ''
  ) {
    opts.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  }
  return new S3Client(opts);
}

/**
 * Assemble the plugin around an already-constructed `S3BlobStore`. Shared by
 * the production factory and the test-client factory so the bus registration +
 * manifest stay defined exactly once.
 */
function blobStoreS3Plugin(store: S3BlobStore): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['blob:put', 'blob:get', 'blob:stat', 'blob:delete'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<BlobPutInput, BlobPutOutput>(
        'blob:put',
        PLUGIN_NAME,
        async (_ctx, { bytes }) => store.put(bytes),
        { returns: BlobPutOutputSchema },
      );

      bus.registerService<BlobGetInput, BlobGetOutput>(
        'blob:get',
        PLUGIN_NAME,
        async (_ctx, { sha256 }) => store.get(sha256),
        { returns: BlobGetOutputSchema },
      );

      bus.registerService<BlobStatInput, BlobStatOutput>(
        'blob:stat',
        PLUGIN_NAME,
        async (_ctx, { sha256 }) => store.stat(sha256),
        { returns: BlobStatOutputSchema },
      );

      bus.registerService<BlobDeleteInput, BlobDeleteOutput>(
        'blob:delete',
        PLUGIN_NAME,
        async (_ctx, { sha256 }) => {
          await store.delete(sha256);
          return {};
        },
        { returns: BlobDeleteOutputSchema },
      );
    },
  };
}

/**
 * Production factory: build the S3 client from config and register the four
 * `blob:*` hooks. This is the SECOND backend behind the storage-agnostic
 * `blob:*` surface (TASK-65 / @ax/blob-store-fs is the first); the k8s preset
 * registers exactly one of the two per deployment.
 */
export function createBlobStoreS3Plugin(config: BlobStoreS3Config): Plugin {
  const client = buildS3Client(config);
  return blobStoreS3Plugin(new S3BlobStore(client, config.bucket, config.keyPrefix ?? ''));
}

/**
 * Test-only seam: build the plugin with an injected S3Client (or fake). Lets
 * the plugin/canary tests exercise the real bus + manifest + bootstrap path
 * without reaching a network endpoint.
 */
export function createBlobStoreS3PluginWithClient(
  client: S3Client,
  bucket: string,
  keyPrefix = '',
): Plugin {
  return blobStoreS3Plugin(new S3BlobStore(client, bucket, keyPrefix));
}
