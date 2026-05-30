import { describe, expect, it } from 'vitest';
import { buildS3Client } from '../plugin.js';

// ---------------------------------------------------------------------------
// buildS3Client config-correctness guard.
//
// The load-bearing one: AWS SDK JS v3 (since early 2025) defaults
// requestChecksumCalculation to WHEN_SUPPORTED, which adds an
// x-amz-checksum-crc32 / STREAMING-…-TRAILER header to PutObject. MinIO
// (pre-trailer releases) and GCS's S3 endpoint reject those, so a plain
// blob:put would fail against exactly the dev + prod targets this backend
// exists for. We pin both checksum knobs to WHEN_REQUIRED. This test fails
// loudly if a future refactor drops that pin (the breakage would otherwise
// only surface as a live MinIO/GCS round-trip failure, which the unit suite
// can't see because it uses an in-memory fake client).
// ---------------------------------------------------------------------------

/** The SDK normalizes a string config value into a provider function. */
async function resolveMaybeProvider<T>(v: T | (() => Promise<T> | T)): Promise<T> {
  return typeof v === 'function' ? await (v as () => Promise<T> | T)() : v;
}

describe('buildS3Client', () => {
  it('pins checksum calculation/validation to WHEN_REQUIRED (S3-compatible safe)', async () => {
    const client = buildS3Client({ bucket: 'b', endpoint: 'http://minio:9000' });
    const req = await resolveMaybeProvider(client.config.requestChecksumCalculation);
    const res = await resolveMaybeProvider(client.config.responseChecksumValidation);
    expect(req).toBe('WHEN_REQUIRED');
    expect(res).toBe('WHEN_REQUIRED');
  });

  it('defaults forcePathStyle to true (MinIO/GCS need path-style)', () => {
    const client = buildS3Client({ bucket: 'b', endpoint: 'http://minio:9000' });
    expect(client.config.forcePathStyle).toBe(true);
  });

  it('honors an explicit forcePathStyle=false (AWS S3 proper)', () => {
    const client = buildS3Client({ bucket: 'b', forcePathStyle: false });
    expect(client.config.forcePathStyle).toBe(false);
  });

  it('uses explicit static credentials when both keys are provided (MinIO dev)', async () => {
    const client = buildS3Client({
      bucket: 'b',
      endpoint: 'http://minio:9000',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minio-secret',
    });
    const creds = await resolveMaybeProvider(client.config.credentials);
    expect(creds).toMatchObject({
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minio-secret',
    });
  });

  it('leaves credentials to the SDK default provider chain when static keys are absent (Workload Identity)', () => {
    // The whole point of the prod (GCS) posture: no static keys → the SDK
    // resolves creds from its default provider chain (Workload Identity /
    // IRSA / metadata). We assert we did NOT inject a static object — the SDK
    // installs its own default provider (a function), never a plain
    // {accessKeyId,...} object built by us.
    const client = buildS3Client({ bucket: 'b', endpoint: 'https://storage.googleapis.com' });
    // When we omit credentials, the SDK's default chain is a function provider
    // (NOT the literal object we'd have built). If buildS3Client ever injected
    // an empty/partial static credential, this would be a plain object.
    expect(typeof client.config.credentials).toBe('function');
  });

  it('treats empty-string static keys as absent (does not inject blank creds)', () => {
    // The chart's secretKeyRef path could in theory surface an empty value;
    // an empty accessKeyId must NOT become a static credential (which would
    // shadow the provider chain and fail auth). buildS3Client guards on
    // non-empty, so empty → default provider chain (a function).
    const client = buildS3Client({
      bucket: 'b',
      endpoint: 'http://minio:9000',
      accessKeyId: '',
      secretAccessKey: '',
    });
    expect(typeof client.config.credentials).toBe('function');
  });
});
