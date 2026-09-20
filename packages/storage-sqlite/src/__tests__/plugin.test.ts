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
    expect(p.manifest.registers).toContain('storage:list-prefix');
  });
});

describe('storage:list-prefix', () => {
  it('returns rows whose key starts with the literal prefix', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const ctx = h.ctx();
    await h.bus.call('storage:set', ctx, {
      key: 'credential:v2:user:alice:foo',
      value: new Uint8Array([1]),
    });
    await h.bus.call('storage:set', ctx, {
      key: 'credential:v2:user:alice:bar',
      value: new Uint8Array([2]),
    });
    await h.bus.call('storage:set', ctx, {
      key: 'other:row',
      value: new Uint8Array([3]),
    });
    const out = await h.bus.call<
      { prefix: string },
      { entries: Array<{ key: string; value: Uint8Array }> }
    >('storage:list-prefix', ctx, { prefix: 'credential:v2:user:alice:' });
    const keys = out.entries.map((e) => e.key).sort();
    expect(keys).toEqual([
      'credential:v2:user:alice:bar',
      'credential:v2:user:alice:foo',
    ]);
  });

  it('escapes SQL LIKE underscore metacharacter in the prefix', async () => {
    // Without escaping, '_' is a single-character wildcard in LIKE — the
    // 'weirdXuser' row would match 'weird_user' and leak across users.
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const ctx = h.ctx();
    await h.bus.call('storage:set', ctx, {
      key: 'credential:weird_user:r',
      value: new Uint8Array([1]),
    });
    await h.bus.call('storage:set', ctx, {
      key: 'credential:weirdXuser:r',
      value: new Uint8Array([2]),
    });
    const out = await h.bus.call<
      { prefix: string },
      { entries: Array<{ key: string; value: Uint8Array }> }
    >('storage:list-prefix', ctx, { prefix: 'credential:weird_' });
    const keys = out.entries.map((e) => e.key);
    expect(keys).toEqual(['credential:weird_user:r']);
  });

  it('escapes SQL LIKE percent metacharacter in the prefix', async () => {
    // '%' is a multi-char wildcard; without escaping, 'credential:50%' would
    // match every key starting with 'credential:50'.
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const ctx = h.ctx();
    await h.bus.call('storage:set', ctx, {
      key: 'credential:50%off:k',
      value: new Uint8Array([1]),
    });
    await h.bus.call('storage:set', ctx, {
      key: 'credential:50anything:k',
      value: new Uint8Array([2]),
    });
    const out = await h.bus.call<
      { prefix: string },
      { entries: Array<{ key: string; value: Uint8Array }> }
    >('storage:list-prefix', ctx, { prefix: 'credential:50%' });
    const keys = out.entries.map((e) => e.key);
    expect(keys).toEqual(['credential:50%off:k']);
  });

  it('rejects empty prefix with invalid-payload', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    await expect(
      h.bus.call('storage:list-prefix', h.ctx(), { prefix: '' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});

describe('storage:delete', () => {
  it('deletes exactly the matching key, unlike storage:delete-prefix on the same key', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const ctx = h.ctx();

    // First half: storage:delete only ever touches the exact key — a key
    // that merely extends it ('k:abcd' extends 'k:abc') must survive.
    await h.bus.call('storage:set', ctx, { key: 'k:abc', value: new Uint8Array([1]) });
    await h.bus.call('storage:set', ctx, { key: 'k:abcd', value: new Uint8Array([2]) });

    const delResult = await h.bus.call<{ key: string }, { deleted: number }>(
      'storage:delete',
      ctx,
      { key: 'k:abc' },
    );
    expect(delResult).toEqual({ deleted: 1 });

    const gotAbc = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: 'k:abc' },
    );
    expect(gotAbc.value).toBeUndefined();

    const gotAbcd = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: 'k:abcd' },
    );
    expect(gotAbcd.value).toBeDefined();
    expect(Array.from(gotAbcd.value!)).toEqual([2]);

    // Second half (contrast, re-seeded): storage:delete-prefix on the SAME
    // exact key destroys the row that merely extends it too — this is the
    // unsafe behavior storage:delete exists to avoid.
    await h.bus.call('storage:set', ctx, { key: 'k:abc', value: new Uint8Array([1]) });

    const prefixDelResult = await h.bus.call<{ prefix: string }, { deleted: number }>(
      'storage:delete-prefix',
      ctx,
      { prefix: 'k:abc' },
    );
    expect(prefixDelResult.deleted).toBe(2);

    const gotAbcdAfterPrefixDelete = await h.bus.call<
      { key: string },
      { value: Uint8Array | undefined }
    >('storage:get', ctx, { key: 'k:abcd' });
    expect(gotAbcdAfterPrefixDelete.value).toBeUndefined();
  });

  /*
    COMPARE-AND-DELETE. A caller that decided to drop a row from a snapshot is
    deciding about the past; between its read and this delete somebody can
    rewrite the row, and an unconditional delete destroys that newer write with
    nobody the wiser. `ifValueEquals` makes the delete a no-op instead. The
    predicate has to be enforced by the QUERY — a guard the SQL ignores is a
    guard that is not there, and it would fail in the dangerous direction.
  */
  it('ifValueEquals deletes on a match and takes nothing once the row has moved', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const ctx = h.ctx();
    const first = new Uint8Array([1, 2, 3]);
    const rewritten = new Uint8Array([9, 9, 9]);

    // The row was rewritten after the caller read `first`.
    await h.bus.call('storage:set', ctx, { key: 'cas', value: first });
    await h.bus.call('storage:set', ctx, { key: 'cas', value: rewritten });

    const stale = await h.bus.call<
      { key: string; ifValueEquals?: Uint8Array },
      { deleted: number }
    >('storage:delete', ctx, { key: 'cas', ifValueEquals: first });
    expect(stale).toEqual({ deleted: 0 });

    // ...and the newer value is untouched.
    const survived = await h.bus.call<
      { key: string },
      { value: Uint8Array | undefined }
    >('storage:get', ctx, { key: 'cas' });
    expect(Array.from(survived.value!)).toEqual([9, 9, 9]);

    // Handed the bytes that ARE there, it deletes.
    const fresh = await h.bus.call<
      { key: string; ifValueEquals?: Uint8Array },
      { deleted: number }
    >('storage:delete', ctx, { key: 'cas', ifValueEquals: rewritten });
    expect(fresh).toEqual({ deleted: 1 });

    const gone = await h.bus.call<
      { key: string },
      { value: Uint8Array | undefined }
    >('storage:get', ctx, { key: 'cas' });
    expect(gone.value).toBeUndefined();
  });

  it('deleting an absent key returns { deleted: 0 } and throws nothing', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const result = await h.bus.call<{ key: string }, { deleted: number }>(
      'storage:delete',
      h.ctx(),
      { key: 'nope' },
    );
    expect(result).toEqual({ deleted: 0 });
  });

  it('rejects empty key with invalid-payload and deletes nothing', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const ctx = h.ctx();
    await h.bus.call('storage:set', ctx, { key: 'survivor', value: new Uint8Array([7]) });

    await expect(h.bus.call('storage:delete', ctx, { key: '' })).rejects.toMatchObject({
      code: 'invalid-payload',
    });

    const got = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: 'survivor' },
    );
    expect(got.value).toBeDefined();
    expect(Array.from(got.value!)).toEqual([7]);
  });
});
