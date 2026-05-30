import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { blobPath } from '../store.js';
import {
  createBlobStoreFsPlugin,
  type BlobDeleteOutput,
  type BlobGetOutput,
  type BlobPutInput,
  type BlobPutOutput,
  type BlobStatOutput,
} from '../plugin.js';

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex');

describe('@ax/blob-store-fs plugin', () => {
  let root: string;
  let h: TestHarness;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'ax-blob-plugin-test-'));
    h = await createTestHarness({ plugins: [createBlobStoreFsPlugin({ root })] });
  });

  afterEach(async () => {
    await h.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('registers all four blob:* hooks', () => {
    expect(h.bus.hasService('blob:put')).toBe(true);
    expect(h.bus.hasService('blob:get')).toBe(true);
    expect(h.bus.hasService('blob:stat')).toBe(true);
    expect(h.bus.hasService('blob:delete')).toBe(true);
  });

  it('manifest advertises the blob:* hooks and nothing else', () => {
    const p = createBlobStoreFsPlugin({ root });
    expect(p.manifest.name).toBe('@ax/blob-store-fs');
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

  it('blob:put is idempotent on identical bytes (same sha, stored once)', async () => {
    const bytes = new TextEncoder().encode('store once');
    const a = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', h.ctx(), {
      bytes,
    });
    const b = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', h.ctx(), {
      bytes,
    });
    expect(b.sha256).toBe(a.sha256);
    const shardDir = join(root, a.sha256.slice(0, 2), a.sha256.slice(2, 4));
    expect(await fs.readdir(shardDir)).toEqual([a.sha256]);
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
    await fs.writeFile(blobPath(root, sha256), Buffer.from('evil swap'));
    await expect(
      h.bus.call<{ sha256: string }, BlobGetOutput>('blob:get', h.ctx(), { sha256 }),
    ).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('blob:get rejects an invalid sha (no path traversal)', async () => {
    await expect(
      h.bus.call<{ sha256: string }, BlobGetOutput>('blob:get', h.ctx(), {
        sha256: '../../../etc/passwd',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});
