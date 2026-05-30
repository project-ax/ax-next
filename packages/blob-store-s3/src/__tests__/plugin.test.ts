import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { blobKey } from '../store.js';
import {
  createBlobStoreS3PluginWithClient,
  type BlobDeleteOutput,
  type BlobGetOutput,
  type BlobPutInput,
  type BlobPutOutput,
  type BlobStatOutput,
} from '../plugin.js';
import { FakeS3Client } from './fake-s3.js';

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex');

const BUCKET = 'ax-blobs';

describe('@ax/blob-store-s3 plugin', () => {
  let fake: FakeS3Client;
  let h: TestHarness;

  beforeEach(async () => {
    fake = new FakeS3Client();
    h = await createTestHarness({
      plugins: [createBlobStoreS3PluginWithClient(fake as unknown as S3Client, BUCKET)],
    });
  });

  afterEach(async () => {
    await h.close();
  });

  it('registers all four blob:* hooks', () => {
    expect(h.bus.hasService('blob:put')).toBe(true);
    expect(h.bus.hasService('blob:get')).toBe(true);
    expect(h.bus.hasService('blob:stat')).toBe(true);
    expect(h.bus.hasService('blob:delete')).toBe(true);
  });

  it('manifest advertises the blob:* hooks and nothing else', () => {
    const p = createBlobStoreS3PluginWithClient(fake as unknown as S3Client, BUCKET);
    expect(p.manifest.name).toBe('@ax/blob-store-s3');
    expect(p.manifest.registers).toEqual([
      'blob:put',
      'blob:get',
      'blob:stat',
      'blob:delete',
    ]);
    expect(p.manifest.calls).toEqual([]);
    expect(p.manifest.subscribes).toEqual([]);
  });

  it('blob:put returns the content sha256 + size', async () => {
    const bytes = new TextEncoder().encode('via the bus');
    const out = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', h.ctx(), {
      bytes,
    });
    expect(out.sha256).toBe(sha256Hex(bytes));
    expect(out.size).toBe(bytes.length);
  });

  it('blob:put → blob:get round-trips the exact bytes', async () => {
    const bytes = new Uint8Array([5, 4, 3, 2, 1, 0, 255]);
    const { sha256 } = await h.bus.call<BlobPutInput, BlobPutOutput>(
      'blob:put',
      h.ctx(),
      { bytes },
    );
    const got = await h.bus.call<{ sha256: string }, BlobGetOutput>(
      'blob:get',
      h.ctx(),
      { sha256 },
    );
    expect('bytes' in got).toBe(true);
    expect('bytes' in got && got.bytes).toEqual(bytes);
  });

  it('blob:put is idempotent on identical bytes (same sha, HeadObject fast-path)', async () => {
    const bytes = new TextEncoder().encode('store once');
    const a = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', h.ctx(), {
      bytes,
    });
    fake.calls.length = 0;
    const b = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', h.ctx(), {
      bytes,
    });
    expect(b.sha256).toBe(a.sha256);
    expect(fake.calls.map((c) => c.name)).toEqual(['HeadObject']);
  });

  it('blob:get of a missing object returns { found: false }', async () => {
    const got = await h.bus.call<{ sha256: string }, BlobGetOutput>(
      'blob:get',
      h.ctx(),
      { sha256: '0'.repeat(64) },
    );
    expect(got).toEqual({ found: false });
  });

  it('blob:stat returns the size, or { found: false }', async () => {
    const bytes = new TextEncoder().encode('measure me');
    const { sha256 } = await h.bus.call<BlobPutInput, BlobPutOutput>(
      'blob:put',
      h.ctx(),
      { bytes },
    );
    expect(
      await h.bus.call<{ sha256: string }, BlobStatOutput>('blob:stat', h.ctx(), {
        sha256,
      }),
    ).toEqual({ size: bytes.length });
    expect(
      await h.bus.call<{ sha256: string }, BlobStatOutput>('blob:stat', h.ctx(), {
        sha256: '1'.repeat(64),
      }),
    ).toEqual({ found: false });
  });

  it('blob:delete removes an object (idempotent)', async () => {
    const bytes = new TextEncoder().encode('gc me');
    const { sha256 } = await h.bus.call<BlobPutInput, BlobPutOutput>(
      'blob:put',
      h.ctx(),
      { bytes },
    );
    await h.bus.call<{ sha256: string }, BlobDeleteOutput>('blob:delete', h.ctx(), {
      sha256,
    });
    expect(
      await h.bus.call<{ sha256: string }, BlobStatOutput>('blob:stat', h.ctx(), {
        sha256,
      }),
    ).toEqual({ found: false });
    // Deleting again is a no-op, not an error.
    await expect(
      h.bus.call<{ sha256: string }, BlobDeleteOutput>('blob:delete', h.ctx(), {
        sha256,
      }),
    ).resolves.toEqual({});
  });

  it('blob:get rejects a corrupted/tampered object instead of returning it', async () => {
    const bytes = new TextEncoder().encode('trustworthy');
    const { sha256 } = await h.bus.call<BlobPutInput, BlobPutOutput>(
      'blob:put',
      h.ctx(),
      { bytes },
    );
    fake._put(BUCKET, blobKey('', sha256), new Uint8Array(Buffer.from('evil swap')));
    await expect(
      h.bus.call<{ sha256: string }, BlobGetOutput>('blob:get', h.ctx(), { sha256 }),
    ).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('blob:get rejects an invalid sha (no key injection)', async () => {
    await expect(
      h.bus.call<{ sha256: string }, BlobGetOutput>('blob:get', h.ctx(), {
        sha256: '../../../etc/passwd',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});
