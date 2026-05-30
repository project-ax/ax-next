import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createBlobBundleStore } from '../blob-bundle-store.js';
import { makeAgentContext, type HookBus } from '@ax/core';

// A tiny in-memory blob store that mimics the @ax/blob-store-fs hook surface:
// content-addressed by sha256, idempotent put, bytes ride the bus as Uint8Array.
function makeFakeBlobBus(): { bus: HookBus; objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const sha256 = (bytes: Uint8Array): string =>
    createHash('sha256').update(bytes).digest('hex');
  const bus = {
    hasService: (name: string) => name === 'blob:put' || name === 'blob:get',
    async call(name: string, _ctx: unknown, input: unknown): Promise<unknown> {
      if (name === 'blob:put') {
        const bytes = (input as { bytes: Uint8Array }).bytes;
        const sha = sha256(bytes);
        if (!objects.has(sha)) objects.set(sha, bytes);
        return { sha256: sha, size: bytes.byteLength };
      }
      if (name === 'blob:get') {
        const sha = (input as { sha256: string }).sha256;
        const bytes = objects.get(sha);
        if (bytes === undefined) return { found: false };
        return { bytes };
      }
      throw new Error(`unexpected hook ${name}`);
    },
  } as unknown as HookBus;
  return { bus, objects };
}

const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

describe('blob-bundle-store', () => {
  it('round-trips a multi-file bundle through the content-addressed blob store', async () => {
    const { bus } = makeFakeBlobBus();
    const store = createBlobBundleStore(bus, ctx);
    const files = [
      { path: 'scripts/run.py', contents: 'print("hi")' },
      { path: 'data/x.json', contents: '{}' },
    ];
    const sha = await store.writeTree(files);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const read = await store.readTree(sha!);
    // readTree returns paths sorted; assert set equality.
    expect(read).toEqual([
      { path: 'data/x.json', contents: '{}' },
      { path: 'scripts/run.py', contents: 'print("hi")' },
    ]);
  });

  it('returns null for an empty file set (no blob written)', async () => {
    const { bus, objects } = makeFakeBlobBus();
    const store = createBlobBundleStore(bus, ctx);
    expect(await store.writeTree([])).toBeNull();
    expect(objects.size).toBe(0);
  });

  it('is content-addressed: identical bytes → identical sha (dedup)', async () => {
    const { bus, objects } = makeFakeBlobBus();
    const store = createBlobBundleStore(bus, ctx);
    const a = await store.writeTree([{ path: 'a.txt', contents: 'same' }]);
    const b = await store.writeTree([{ path: 'a.txt', contents: 'same' }]);
    expect(a).toBe(b);
    expect(objects.size).toBe(1); // deduped to one object
  });

  it('serialization is order-independent: same set in different order → same sha', async () => {
    const { bus } = makeFakeBlobBus();
    const store = createBlobBundleStore(bus, ctx);
    const a = await store.writeTree([
      { path: 'b.txt', contents: '2' },
      { path: 'a.txt', contents: '1' },
    ]);
    const b = await store.writeTree([
      { path: 'a.txt', contents: '1' },
      { path: 'b.txt', contents: '2' },
    ]);
    expect(a).toBe(b);
  });

  it('re-validates paths at the extract boundary (rejects a traversal smuggled into the blob)', async () => {
    const { bus, objects } = makeFakeBlobBus();
    const store = createBlobBundleStore(bus, ctx);
    // Hand-craft a malicious serialized bundle and store it directly, bypassing
    // the write-side validateBundleFiles, to prove the read side re-validates.
    const evil = JSON.stringify({
      v: 1,
      files: [{ path: '../escape.txt', contents: 'x' }],
    });
    const bytes = new TextEncoder().encode(evil);
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(bytes).digest('hex');
    objects.set(sha, bytes);
    await expect(store.readTree(sha)).rejects.toThrow(/relative|path/i);
  });

  it("throws a clear error when the blob is missing (referenced sha GC'd)", async () => {
    const { bus } = makeFakeBlobBus();
    const store = createBlobBundleStore(bus, ctx);
    const missing = 'a'.repeat(64);
    await expect(store.readTree(missing)).rejects.toThrow(/not found|missing/i);
  });
});
