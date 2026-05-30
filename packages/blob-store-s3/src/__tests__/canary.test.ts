import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import {
  createBlobStoreS3PluginWithClient,
  type BlobGetOutput,
  type BlobPutInput,
  type BlobPutOutput,
} from '../plugin.js';
import { FakeS3Client } from './fake-s3.js';

// ---------------------------------------------------------------------------
// Canary acceptance — the I3 "wire one real caller" reachability proof.
//
// `createTestHarness({ plugins })` boots the plugin through @ax/core's
// `bootstrap` (manifest validation, dependency resolution, init). This canary
// then drives a blob:put → blob:get round-trip through the SAME bus a real
// host would, proving @ax/blob-store-s3 is registered + reachable end to end
// (not half-wired). It runs against an in-memory FakeS3Client (no MinIO, no
// network, no Docker) — the live MinIO round-trip is the chart/k8s lane's job;
// here we prove the plugin + bus + bootstrap wiring is sound.
// ---------------------------------------------------------------------------

const BUCKET = 'ax-blobs';

describe('canary: @ax/blob-store-s3 blob:put → blob:get round-trip', () => {
  let fake: FakeS3Client;
  let h: TestHarness;

  beforeEach(async () => {
    fake = new FakeS3Client();
    // Boots through bootstrap: this is the reachability proof.
    h = await createTestHarness({
      plugins: [createBlobStoreS3PluginWithClient(fake as unknown as S3Client, BUCKET)],
    });
  });

  afterEach(async () => {
    await h.close();
  });

  it('puts bytes, reads them back, and the digest + bytes match', async () => {
    const ctx = h.ctx();
    // A realistic opaque payload (binary, not just text) crossing the substrate.
    const payload = Buffer.concat([
      Buffer.from('blob substrate canary\n', 'utf8'),
      Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]),
    ]);
    const bytes = new Uint8Array(payload);

    const put = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', ctx, {
      bytes,
    });

    // The returned sha256 IS the sha256 of the bytes (content-addressed).
    const expectedSha = createHash('sha256').update(payload).digest('hex');
    expect(put.sha256).toBe(expectedSha);
    expect(put.size).toBe(bytes.length);

    // Read it back through the bus and verify both the digest and the bytes.
    const got = await h.bus.call<{ sha256: string }, BlobGetOutput>(
      'blob:get',
      ctx,
      { sha256: put.sha256 },
    );
    expect('bytes' in got).toBe(true);
    if (!('bytes' in got)) throw new Error('expected blob:get to find the object');
    expect(got.bytes).toEqual(bytes);
    expect(createHash('sha256').update(Buffer.from(got.bytes)).digest('hex')).toBe(
      put.sha256,
    );
  });

  it('a second put of the same bytes returns the same sha (idempotent, HeadObject fast-path)', async () => {
    const ctx = h.ctx();
    const bytes = new TextEncoder().encode('idempotent canary');
    const first = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', ctx, {
      bytes,
    });
    fake.calls.length = 0;
    const second = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', ctx, {
      bytes,
    });
    expect(second.sha256).toBe(first.sha256);
    expect(fake.calls.map((c) => c.name)).toEqual(['HeadObject']);
  });
});
