import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Kysely } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '../plugin.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];
const opened: Kysely<unknown>[] = [];

async function bootHarness(): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createStoragePostgresPlugin(),
    ],
  });
  harnesses.push(h);
  const { db } = await h.bus.call<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    h.ctx(),
    {},
  );
  opened.push(db);
  return h;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 60_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('storage_postgres_v1_kv').ifExists().execute();
    } catch {
      /* drained pool — ignore */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('db:transact (storage-postgres)', () => {
  it('commits the run callback successfully', async () => {
    const h = await bootHarness();
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
    const h = await bootHarness();
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
    const h = await bootHarness();
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
    const p = createStoragePostgresPlugin();
    expect(p.manifest.registers).toContain('db:transact');
  });
});
