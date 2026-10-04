import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reject } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { blobPath, retiredPath } from '../store.js';
import {
  createBlobStoreFsPlugin,
  type BlobGetOutput,
  type BlobPurgeInput,
  type BlobPurgeOutput,
  type BlobRetireInput,
  type BlobRetireOutput,
  type BlobStatInput,
  type BlobListInput,
  type BlobListOutput,
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

  it('registers the six blob:* hooks (plus the internal put the facade wraps) — and no blob:delete', () => {
    expect(h.bus.hasService('blob:put')).toBe(true);
    expect(h.bus.hasService('blob:put-internal')).toBe(true);
    expect(h.bus.hasService('blob:get')).toBe(true);
    expect(h.bus.hasService('blob:stat')).toBe(true);
    expect(h.bus.hasService('blob:list')).toBe(true);
    expect(h.bus.hasService('blob:retire')).toBe(true);
    expect(h.bus.hasService('blob:purge')).toBe(true);
    // Hard delete is gone: the only way out is retire, then purge (TASK-778).
    expect(h.bus.hasService('blob:delete')).toBe(false);
  });

  it('manifest advertises the blob:* hooks and nothing else', () => {
    const p = createBlobStoreFsPlugin({ root });
    expect(p.manifest.name).toBe('@ax/blob-store-fs');
    expect(p.manifest.registers).toEqual([
      'blob:put',
      'blob:put-internal',
      'blob:get',
      'blob:stat',
      'blob:list',
      'blob:retire',
      'blob:purge',
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

  it('a blob:pre-put veto makes blob:put throw and leaves the store empty', async () => {
    h.bus.subscribe('blob:pre-put', 'test-quota', async () =>
      reject({ reason: 'storage full', source: 'test-quota' }),
    );
    const bytes = new TextEncoder().encode('refused');

    await expect(
      h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', h.ctx(), { bytes }),
    ).rejects.toMatchObject({ code: 'rejected', message: expect.stringContaining('storage full') });

    expect(
      await h.bus.call<{ sha256: string }, BlobStatOutput>('blob:stat', h.ctx(), {
        sha256: sha256Hex(bytes),
      }),
    ).toEqual({ found: false });
  });

  it('blob:stored fires once with the sha256 and size after a successful put', async () => {
    const seen: Array<{ sha256: string; size: number }> = [];
    h.bus.subscribe<{ sha256: string; size: number }>(
      'blob:stored',
      'test-ledger',
      async (_ctx, payload) => {
        seen.push(payload);
        return undefined;
      },
    );
    const bytes = new TextEncoder().encode('ledger me');

    await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', h.ctx(), { bytes });

    expect(seen).toEqual([{ sha256: sha256Hex(bytes), size: bytes.length }]);
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

  it('blob:retire moves a blob out of live; blob:get restores it', async () => {
    const bytes = new TextEncoder().encode('retire via the bus');
    const { sha256 } = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', h.ctx(), {
      bytes,
    });
    expect(
      await h.bus.call<BlobRetireInput, BlobRetireOutput>('blob:retire', h.ctx(), { sha256 }),
    ).toEqual({});
    await expect(fs.stat(blobPath(root, sha256))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await h.bus.call<BlobListInput, BlobListOutput>('blob:list', h.ctx(), {
        state: 'retired',
        limit: 10,
      }),
    ).toEqual({ items: [{ sha256, size: bytes.length }] });
    // Retiring again (now missing from live) is a no-op, not an error.
    await expect(
      h.bus.call<BlobRetireInput, BlobRetireOutput>('blob:retire', h.ctx(), { sha256 }),
    ).resolves.toEqual({});

    const got = await h.bus.call<{ sha256: string }, BlobGetOutput>('blob:get', h.ctx(), {
      sha256,
    });
    expect('bytes' in got && got.bytes).toEqual(bytes);
    await expect(fs.stat(blobPath(root, sha256))).resolves.toBeTruthy();
  });

  it('blob:purge removes the retired copy (idempotent) and never a live one', async () => {
    const bytes = new TextEncoder().encode('purge via the bus');
    const { sha256 } = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', h.ctx(), {
      bytes,
    });
    // Purging a LIVE blob leaves it alone.
    expect(
      await h.bus.call<BlobPurgeInput, BlobPurgeOutput>('blob:purge', h.ctx(), { sha256 }),
    ).toEqual({});
    expect(
      await h.bus.call<BlobStatInput, BlobStatOutput>('blob:stat', h.ctx(), { sha256 }),
    ).toEqual({ size: bytes.length });

    await h.bus.call<BlobRetireInput, BlobRetireOutput>('blob:retire', h.ctx(), { sha256 });
    await h.bus.call<BlobPurgeInput, BlobPurgeOutput>('blob:purge', h.ctx(), { sha256 });
    await expect(fs.stat(retiredPath(root, sha256))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await h.bus.call<BlobStatInput, BlobStatOutput>('blob:stat', h.ctx(), { sha256 }),
    ).toEqual({ found: false });
    await expect(
      h.bus.call<BlobPurgeInput, BlobPurgeOutput>('blob:purge', h.ctx(), { sha256 }),
    ).resolves.toEqual({});
  });

  it('blob:stat { restore: false } reports a retired blob without restoring it', async () => {
    const bytes = new TextEncoder().encode('peek, do not touch');
    const { sha256 } = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', h.ctx(), {
      bytes,
    });
    await h.bus.call<BlobRetireInput, BlobRetireOutput>('blob:retire', h.ctx(), { sha256 });
    expect(
      await h.bus.call<BlobStatInput, BlobStatOutput>('blob:stat', h.ctx(), {
        sha256,
        restore: false,
      }),
    ).toEqual({ size: bytes.length });
    await expect(fs.stat(blobPath(root, sha256))).rejects.toMatchObject({ code: 'ENOENT' });
    // Default stat restores it.
    expect(
      await h.bus.call<BlobStatInput, BlobStatOutput>('blob:stat', h.ctx(), { sha256 }),
    ).toEqual({ size: bytes.length });
    await expect(fs.stat(blobPath(root, sha256))).resolves.toBeTruthy();
  });

  it('blob:stat rejects a non-boolean restore with invalid-payload', async () => {
    await expect(
      h.bus.call<unknown, BlobStatOutput>('blob:stat', h.ctx(), {
        sha256: '1'.repeat(64),
        restore: 'no',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('blob:retire / blob:purge reject an invalid sha', async () => {
    await expect(
      h.bus.call<BlobRetireInput, BlobRetireOutput>('blob:retire', h.ctx(), {
        sha256: '../../../etc/passwd',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(
      h.bus.call<BlobPurgeInput, BlobPurgeOutput>('blob:purge', h.ctx(), {
        sha256: '../../../etc/passwd',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
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

  it('blob:list pages stored blobs ascending by sha, with a cursor until the last page', async () => {
    const shas: string[] = [];
    for (const t of ['one', 'two', 'three', 'four', 'five']) {
      const out = await h.bus.call<BlobPutInput, BlobPutOutput>('blob:put', h.ctx(), {
        bytes: new TextEncoder().encode(t),
      });
      shas.push(out.sha256);
    }
    shas.sort();

    const first = await h.bus.call<BlobListInput, BlobListOutput>('blob:list', h.ctx(), {
      state: 'live',
      limit: 2,
    });
    expect(first.items.map((i) => i.sha256)).toEqual(shas.slice(0, 2));
    expect(first.next).toBe(shas[1]);

    const rest = await h.bus.call<BlobListInput, BlobListOutput>('blob:list', h.ctx(), {
      state: 'live',
      limit: 10,
      after: first.next!,
    });
    expect(rest.items.map((i) => i.sha256)).toEqual(shas.slice(2));
    // The `returns` schema must not smuggle in an undefined-valued `next`.
    expect('next' in rest).toBe(false);
  });

  it('blob:list rejects a bad limit with invalid-payload', async () => {
    await expect(
      h.bus.call<BlobListInput, BlobListOutput>('blob:list', h.ctx(), {
        state: 'live',
        limit: 1001,
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});
