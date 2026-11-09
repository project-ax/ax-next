import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  createTestHarness,
  startTestContainer,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Kysely } from 'kysely';
import pg from 'pg';
import {
  DIRECTORY_SEARCH_HOOK,
  DirectoryEntrySchema,
  DirectorySearchOutputSchema,
  type DirectorySearchOutput,
} from '../contract.js';
import { DEFAULT_REGISTRY_URL } from '../limits.js';
import type { ConnectorDirectoryDatabase } from '../migrations.js';
import {
  createConnectorDirectoryPlugin,
  type ConnectorDirectoryConfig,
  type ConnectorDirectoryPlugin,
} from '../plugin.js';
import { searchDirectory } from '../search.js';
import { createFakeRegistry, page, waitForAbort } from './support/fake-registry.js';
import { header, listing, remote } from './support/listing.js';

const HOUR = 3_600_000;

let container: StartedPostgreSqlContainer;
let connectionString: string;
const booted: TestHarness[] = [];

/**
 * Boot the plugin on real Postgres. Timers are off unless the test sets them,
 * or asks for the factory's own defaults (`defaultTimers`).
 */
async function boot(
  config: ConnectorDirectoryConfig,
  o: { defaultTimers?: boolean } = {},
): Promise<{ harness: TestHarness; plugin: ConnectorDirectoryPlugin }> {
  const plugin = createConnectorDirectoryPlugin(
    o.defaultTimers === true ? config : { syncIntervalMs: 0, ...config },
  );
  const harness = await createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString }), plugin],
  });
  booted.push(harness);
  return { harness, plugin };
}

async function stateRow(): Promise<Record<string, unknown> | undefined> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    const r = await c.query('SELECT * FROM connector_directory_v1_sync_state');
    return r.rows[0] as Record<string, unknown> | undefined;
  } finally {
    await c.end().catch(() => {});
  }
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network is off in tests');
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  while (booted.length > 0) await booted.pop()!.close({ onError: () => {} });
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    await c.query('TRUNCATE connector_directory_v1_entries, connector_directory_v1_sync_state');
  } catch {
    // Not created yet.
  } finally {
    await c.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/connector-directory plugin', () => {
  it('the hook answers through the bus after a sync', async () => {
    const fake = createFakeRegistry(() =>
      page([
        listing({
          name: 'app.linear/linear',
          title: 'Linear',
          remotes: [remote('https://mcp.linear.app/mcp')],
        }),
        listing({ name: 'com.example/other', title: 'Other' }),
      ]),
    );
    const { harness, plugin } = await boot({ fetchImpl: fake.fetchImpl });

    expect(await plugin.sync()).toMatchObject({ outcome: 'ok', full: true, upserted: 2 });
    // No registryUrl: the factory default, through the injected fetch only.
    expect(fake.requests.map((u) => `${u.origin}${u.pathname}`)).toEqual([
      `${DEFAULT_REGISTRY_URL}/v0.1/servers`,
    ]);

    const out = await harness.bus.call<unknown, DirectorySearchOutput>(
      DIRECTORY_SEARCH_HOOK,
      harness.ctx(),
      { query: 'linear', limit: 5 },
    );
    expect(out).toStrictEqual({
      enabled: true,
      entries: [
        {
          id: 'app.linear/linear',
          title: 'Linear',
          description: 'A test server',
          publisher: 'linear.app',
          publisherProof: 'domain',
          url: 'https://mcp.linear.app/mcp',
          auth: 'none',
          version: '1.0.0',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
      syncedAt: expect.any(String),
      stale: false,
      verifiedOnly: false,
    });
  });

  it('first sync after the initial delay, then hourly; shutdown stops it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const fake = createFakeRegistry(() => page([listing({ name: 'com.example/a' })]));
    // The factory's own defaults: 10 s after boot, then every hour.
    const { harness, plugin } = await boot({ fetchImpl: fake.fetchImpl }, { defaultTimers: true });

    await vi.advanceTimersByTimeAsync(9_999);
    await plugin.drain();
    expect(fake.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await plugin.drain();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.searchParams.has('updated_since')).toBe(false);

    await vi.advanceTimersByTimeAsync(HOUR);
    await plugin.drain();
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.searchParams.has('updated_since')).toBe(true);

    await harness.close();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    await plugin.drain();
    expect(fake.requests).toHaveLength(2);
  });

  it('a sync started while one runs joins it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeRegistry(async () => {
      await gate;
      return page([listing({ name: 'com.example/a' })]);
    });
    const { plugin } = await boot({ fetchImpl: fake.fetchImpl });

    const first = plugin.sync();
    expect(plugin.sync()).toBe(first);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    expect(plugin.sync()).toBe(first);
    release();
    expect(await first).toMatchObject({ outcome: 'ok', pages: 1 });
    expect(fake.requests).toHaveLength(1);

    // Once it settles, the next call is a new run.
    const next = plugin.sync();
    expect(next).not.toBe(first);
    expect(await next).toMatchObject({ outcome: 'ok', full: false });
    expect(fake.requests).toHaveLength(2);
  });

  it('a page that fails for a moment is asked for again before the sync gives up', async () => {
    let failuresLeft = 1;
    const fake = createFakeRegistry(() => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return new Response(null, { status: 503 });
      }
      return page([listing({ name: 'com.example/a' })]);
    });
    const waits: number[] = [];
    const { plugin } = await boot({
      fetchImpl: fake.fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(await plugin.sync()).toMatchObject({ outcome: 'ok', pages: 1, upserted: 1 });
    expect(fake.requests).toHaveLength(2);
    expect(waits).toEqual([1_000]);

    // Three in a row: two retries, then the sync fails with the registry's code.
    failuresLeft = 3;
    expect(await plugin.sync()).toEqual({ outcome: 'failed', reason: 'http-503' });
    expect(fake.requests).toHaveLength(5);
    expect(waits).toEqual([1_000, 1_000, 4_000]);
  });

  it('the returns schema holds the shape', async () => {
    const fake = createFakeRegistry(() =>
      page([
        listing({
          name: 'com.acme/keyed',
          title: 'Acme',
          status: 'deprecated',
          remotes: [
            remote('https://mcp.acme.com/mcp', 'streamable-http', [
              header('X-API-Key', { isRequired: true, isSecret: true }),
            ]),
          ],
        }),
        ...[0, 1, 2].map((i) => listing({ name: `com.acme/plain-${i}`, title: `Acme ${i}` })),
      ]),
    );
    const { harness, plugin } = await boot({ fetchImpl: fake.fetchImpl });
    expect(await plugin.sync()).toMatchObject({ outcome: 'ok', upserted: 4 });

    const input = { query: 'acme', limit: 2 };
    const viaBus = await harness.bus.call<unknown, DirectorySearchOutput>(
      DIRECTORY_SEARCH_HOOK,
      harness.ctx(),
      input,
    );
    const { db } = await harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      harness.ctx(),
      {},
    );
    const direct = await searchDirectory(db as Kysely<ConnectorDirectoryDatabase>, input, {
      verifiedOnly: false,
    });
    // Every optional field is present in this answer...
    expect(direct.nextCursor).toEqual(expect.any(String));
    expect(direct.entries[0]).toMatchObject({ keyHeader: 'X-API-Key', deprecated: true });
    // ...and the bus, which strips what its `returns` schema does not declare,
    // hands it over whole.
    expect(viaBus).toStrictEqual(direct);
    const outputKeys = Object.keys(DirectorySearchOutputSchema.shape);
    const entryKeys = Object.keys(DirectoryEntrySchema.shape);
    for (const key of Object.keys(direct)) expect(outputKeys).toContain(key);
    for (const entry of direct.entries) {
      for (const key of Object.keys(entry)) expect(entryKeys).toContain(key);
    }
  });

  it('shutdown aborts an in-flight request and resolves', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let requested!: () => void;
      const inFlight = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const fake = createFakeRegistry((_url, init) => {
        requested();
        return waitForAbort(init);
      });
      const { harness, plugin } = await boot({ fetchImpl: fake.fetchImpl });

      const result = plugin.sync();
      await inFlight;
      await harness.close();
      expect(await result).toEqual({ outcome: 'failed', reason: 'aborted' });
      // The attempt was recorded before the database went away.
      expect(await stateRow()).toMatchObject({ last_attempt_failed: true, synced_at: null });
      // A stopped plugin starts nothing.
      expect(await plugin.sync()).toEqual({ outcome: 'disabled' });
      expect(fake.requests).toHaveLength(1);

      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a shutdown during a timer-started sync resolves too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    let requested!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const fake = createFakeRegistry((_url, init) => {
      requested();
      return waitForAbort(init);
    });
    const { harness, plugin } = await boot({
      fetchImpl: fake.fetchImpl,
      syncInitialDelayMs: 0,
      syncIntervalMs: HOUR,
    });
    await vi.advanceTimersByTimeAsync(0);
    await inFlight;
    await harness.close();
    await plugin.drain();
    expect(fake.requests).toHaveLength(1);
    expect(await stateRow()).toMatchObject({ last_attempt_failed: true });
  });
});
