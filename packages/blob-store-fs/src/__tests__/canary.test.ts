import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import {
  createBlobStoreFsPlugin,
  type BlobGetOutput,
  type BlobPutInput,
  type BlobPutOutput,
} from '../plugin.js';

// ---------------------------------------------------------------------------
// Canary acceptance — the I3 "wire one real caller" reachability proof.
//
// `createTestHarness({ plugins })` boots the plugin through @ax/core's
// `bootstrap` (manifest validation, dependency resolution, init). This canary
// then drives a blob:put → blob:get round-trip through the SAME bus a real
// host would, proving @ax/blob-store-fs is registered + reachable end to end
// (not half-wired). It runs against a real on-disk root (fs only — no Postgres,
// no Docker, no IPC transport needed).
// ---------------------------------------------------------------------------

describe('canary: @ax/blob-store-fs blob:put → blob:get round-trip', () => {
  let root: string;
  let h: TestHarness;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ax-blob-canary-'));
    // Boots through bootstrap: this is the reachability proof.
    h = await createTestHarness({ plugins: [createBlobStoreFsPlugin({ root })] });
  });

  afterEach(async () => {
    await h.close();
    await fs.rm(root, { recursive: true, force: true });
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

  it('a second put of the same bytes returns the same sha (idempotent, stored once)', async () => {
    const ctx = h.ctx();
    const bytes = new TextEncoder().encode('idempotent canary');
    const first = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', ctx, {
      bytes,
    });
    const second = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', ctx, {
      bytes,
    });
    expect(second.sha256).toBe(first.sha256);
    const shardDir = join(root, first.sha256.slice(0, 2), first.sha256.slice(2, 4));
    expect(await fs.readdir(shardDir)).toEqual([first.sha256]);
  });
});
