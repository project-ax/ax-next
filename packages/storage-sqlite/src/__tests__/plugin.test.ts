import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createStorageSqlitePlugin } from '../plugin.js';

describe('@ax/storage-sqlite', () => {
  it('registers storage:get and storage:set', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    expect(h.bus.hasService('storage:get')).toBe(true);
    expect(h.bus.hasService('storage:set')).toBe(true);
  });

  it('set then get round-trips a byte value', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const ctx = h.ctx();
    const value = new TextEncoder().encode('hello world');
    await h.bus.call('storage:set', ctx, { key: 'k1', value });
    const got = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: 'k1' },
    );
    expect(got.value).toBeDefined();
    expect(new TextDecoder().decode(got.value!)).toBe('hello world');
  });

  it('get of missing key returns { value: undefined }', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const got = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      h.ctx(),
      { key: 'nope' },
    );
    expect(got.value).toBeUndefined();
  });

  it('set overwrites existing value at same key', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const ctx = h.ctx();
    await h.bus.call('storage:set', ctx, { key: 'k', value: new Uint8Array([1, 2, 3]) });
    await h.bus.call('storage:set', ctx, { key: 'k', value: new Uint8Array([9, 9]) });
    const got = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: 'k' },
    );
    expect(Array.from(got.value!)).toEqual([9, 9]);
  });

  it('manifest advertises the storage hooks', () => {
    const p = createStorageSqlitePlugin({ databasePath: ':memory:' });
    expect(p.manifest.name).toBe('@ax/storage-sqlite');
    expect(p.manifest.registers).toContain('storage:get');
    expect(p.manifest.registers).toContain('storage:set');
  });
});
