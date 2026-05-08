import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createStorageSqlitePlugin } from '../plugin.js';

describe('db:transact (storage-sqlite)', () => {
  it('commits the run callback successfully', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    await h.bus.call('db:transact', h.ctx(), {
      run: async ({ tx }: { tx: unknown }) => {
        await h.bus.call('storage:set', h.ctx(), {
          key: 'tx-commit-test',
          value: new TextEncoder().encode('ok'),
          tx,
        });
      },
    });
    const r = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      h.ctx(),
      { key: 'tx-commit-test' },
    );
    expect(r.value).toBeDefined();
    expect(new TextDecoder().decode(r.value!)).toBe('ok');
  });

  it('rolls back on throw inside run callback', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    await expect(
      h.bus.call('db:transact', h.ctx(), {
        run: async ({ tx }: { tx: unknown }) => {
          await h.bus.call('storage:set', h.ctx(), {
            key: 'tx-rollback-test',
            value: new TextEncoder().encode('should-not-persist'),
            tx,
          });
          throw new Error('intentional rollback');
        },
      }),
    ).rejects.toThrow(/intentional rollback/);
    const r = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      h.ctx(),
      { key: 'tx-rollback-test' },
    );
    expect(r.value).toBeUndefined();
  });

  it('storage:set without tx still commits immediately (existing behavior unchanged)', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    await h.bus.call('storage:set', h.ctx(), {
      key: 'no-tx-test',
      value: new TextEncoder().encode('immediate'),
    });
    const r = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      h.ctx(),
      { key: 'no-tx-test' },
    );
    expect(r.value).toBeDefined();
    expect(new TextDecoder().decode(r.value!)).toBe('immediate');
  });

  it('manifest registers db:transact', () => {
    const p = createStorageSqlitePlugin({ databasePath: ':memory:' });
    expect(p.manifest.registers).toContain('db:transact');
  });
});
