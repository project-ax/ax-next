import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Plugin } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConnectorsPlugin } from '../plugin.js';
import { deriveToolNamespaces } from '../tool-namespace.js';
import type { ConnectorDeletedEvent, ListEffectiveInput, ListEffectiveOutput, ListOutput } from '../types.js';

// The sweep runs inside connectors' init, so the capture plugin must init
// BEFORE it. Registering `credentials:delete` (an optionalCall of
// @ax/connectors) puts this plugin ahead of it in topological order.
function capturePlugin(
  events: ConnectorDeletedEvent[],
  purged: Array<{ scope: string; ownerId: string | null; ref: string }>,
  accountPurges: unknown[] = [],
): Plugin {
  return {
    manifest: {
      name: 'test/capture',
      version: '0.0.0',
      registers: ['credentials:delete', 'credentials:purge-account'],
      calls: [],
      subscribes: ['connectors:deleted'],
    },
    init({ bus }) {
      bus.registerService('credentials:delete', 'test/capture', async (_ctx, input) => {
        purged.push(input as { scope: string; ownerId: string | null; ref: string });
        return undefined;
      });
      bus.registerService('credentials:purge-account', 'test/capture', async (_ctx, input) => {
        accountPurges.push(input);
        return { purged: 0 };
      });
      bus.subscribe<ConnectorDeletedEvent>('connectors:deleted', 'test/capture', async (_ctx, e) => {
        events.push(e);
        return undefined;
      });
    },
  };
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

async function boot(extra: Plugin[] = []): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString }), ...extra, createConnectorsPlugin()],
  });
  harnesses.push(h);
  return h;
}

async function sql(text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const c = new (await import('pg')).default.Client({ connectionString });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end().catch(() => {});
  }
}

const httpServer = { name: 'remote', transport: 'http', url: 'https://mcp.example.com', allowedHosts: [], credentials: [] };
const stdioServer = { name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], allowedHosts: [], credentials: [] };
const caps = (servers: unknown[], credentials: unknown[] = []) =>
  JSON.stringify({ allowedHosts: [], credentials, mcpServers: servers, packages: { npm: [], pypi: [] } });

// The connectors plugin logs through its own init ctx, whose default logger
// writes one JSON line per entry to stdout. Capture those lines while `fn` runs.
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: Array<Record<string, unknown>> }> {
  const logs: Array<Record<string, unknown>> = [];
  const original = process.stdout.write.bind(process.stdout);
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // not a log line
      }
    }
    return (original as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write);
  try {
    return { result: await fn(), logs };
  } finally {
    spy.mockRestore();
  }
}

async function insertConnector(owner: string, id: string, capsJson: string, opts: { keyMode?: string; visibility?: string; deleted?: boolean } = {}) {
  await sql(
    `INSERT INTO connectors_v1_connectors (owner_user_id, connector_id, name, key_mode, visibility, capabilities, deleted_at)
     VALUES ($1, $2, $2, $3, $4, $5::jsonb, $6)`,
    [owner, id, opts.keyMode ?? 'personal', opts.visibility ?? 'private', capsJson, opts.deleted ? new Date() : null],
  );
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  await sql('DROP TABLE IF EXISTS connectors_v1_connectors');
  await sql('DROP TABLE IF EXISTS connectors_v1_authored');
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/connectors stdio sweep', () => {
  it('deletes live + tombstoned stdio connectors, keeps http ones, and list-effective works afterwards', async () => {
    await (await boot()).close({ onError: () => {} }); // create tables
    harnesses.pop();
    await insertConnector('userA', 'gdrive', caps([httpServer]));
    await insertConnector('userA', 'localtool', caps([stdioServer], [{ slot: 'TOKEN', kind: 'api-key' }]));
    await insertConnector('userA', 'oldtool', caps([stdioServer]), { deleted: true });

    const events: ConnectorDeletedEvent[] = [];
    const purged: Array<{ scope: string; ownerId: string | null; ref: string }> = [];
    const h = await boot([capturePlugin(events, purged)]);

    const rows = await sql('SELECT connector_id FROM connectors_v1_connectors ORDER BY connector_id');
    expect(rows.map((r) => r['connector_id'])).toEqual(['gdrive']);

    // Cleanup ran for the LIVE stdio row only (the tombstone was purged at its soft delete).
    expect(events).toEqual([
      { connectorId: 'localtool', toolNamespaces: deriveToolNamespaces('userA', { id: 'localtool', capabilities: { mcpServers: [stdioServer as never] } }), idStillLive: false },
    ]);
    // A personal private connector has no global key and no per-person rows
    // (its keys would live on agents, and only a SHARED definition owns those).
    expect(purged).toEqual([]);

    // Regression: one stdio row used to make the whole list throw.
    const list = await h.bus.call<{ userId: string }, ListOutput>('connectors:list', h.ctx({ userId: 'userA' }), { userId: 'userA' });
    expect(list.connectors.map((c) => c.id)).toEqual(['gdrive']);
  });

  it('purges a shared workspace connector\'s GLOBAL key (system cleanup)', async () => {
    await (await boot()).close({ onError: () => {} });
    harnesses.pop();
    await insertConnector('admin1', 'teamtool', caps([stdioServer], [{ slot: 'TOKEN', kind: 'api-key' }]), { keyMode: 'workspace', visibility: 'shared' });
    const purged: Array<{ scope: string; ownerId: string | null; ref: string }> = [];
    await boot([capturePlugin([], purged)]);
    expect(purged).toEqual([{ scope: 'global', ownerId: null, ref: 'account:teamtool' }]);
  });

  it('purges every agent\'s sign-ins for a sole shared stdio connector (system cleanup)', async () => {
    await (await boot()).close({ onError: () => {} });
    harnesses.pop();
    await insertConnector('admin1', 'teamtool', caps([stdioServer], [{ slot: 'TOKEN', kind: 'api-key' }]), { keyMode: 'workspace', visibility: 'shared' });
    const accountPurges: unknown[] = [];
    await boot([capturePlugin([], [], accountPurges)]);
    // Agent scope only: nothing is stored per person (slice 5).
    expect(accountPurges).toEqual([{ connectorId: 'teamtool', scopes: ['agent'] }]);
  });

  it('keeps agents\' sign-ins when another admin\'s live shared http connector keeps the id', async () => {
    await (await boot()).close({ onError: () => {} });
    harnesses.pop();
    await insertConnector('admin1', 'teamtool', caps([stdioServer], [{ slot: 'TOKEN', kind: 'api-key' }]), { keyMode: 'workspace', visibility: 'shared' });
    await insertConnector('admin2', 'teamtool', caps([httpServer], [{ slot: 'TOKEN', kind: 'api-key' }]), { keyMode: 'workspace', visibility: 'shared' });
    const events: ConnectorDeletedEvent[] = [];
    const accountPurges: unknown[] = [];
    await boot([capturePlugin(events, [], accountPurges)]);
    expect(accountPurges).toEqual([]);
    // The stdio row is still swept and announced — and the id is still in use.
    expect(events.map((e) => [e.connectorId, e.idStillLive])).toEqual([['teamtool', true]]);
    const rows = await sql('SELECT owner_user_id FROM connectors_v1_connectors');
    expect(rows.map((r) => r['owner_user_id'])).toEqual(['admin2']);
  });

  it('keeps the GLOBAL key when another owner\'s live non-stdio connector shares the id', async () => {
    await (await boot()).close({ onError: () => {} });
    harnesses.pop();
    await insertConnector('admin1', 'teamtool', caps([httpServer], [{ slot: 'TOKEN', kind: 'api-key' }]), { keyMode: 'workspace', visibility: 'shared' });
    await insertConnector('userB', 'teamtool', caps([stdioServer], [{ slot: 'TOKEN', kind: 'api-key' }]), { keyMode: 'workspace' });
    const events: ConnectorDeletedEvent[] = [];
    const purged: Array<{ scope: string; ownerId: string | null; ref: string }> = [];
    await boot([capturePlugin(events, purged)]);
    const rows = await sql('SELECT owner_user_id FROM connectors_v1_connectors');
    expect(rows.map((r) => r['owner_user_id'])).toEqual(['admin1']);
    expect(purged).not.toContainEqual({ scope: 'global', ownerId: null, ref: 'account:teamtool' });
    expect(purged.filter((p) => p.scope === 'global')).toEqual([]);
    expect(events.map((e) => [e.connectorId, e.idStillLive])).toEqual([['teamtool', true]]);
  });

  it('deletes a row whose capabilities are garbage but mention stdio, without purging and without throwing', async () => {
    await (await boot()).close({ onError: () => {} });
    harnesses.pop();
    await insertConnector('userA', 'weird', JSON.stringify({ mcpServers: [{ transport: 'stdio' }], credentials: 'nope' }));
    const purged: Array<{ scope: string; ownerId: string | null; ref: string }> = [];
    await boot([capturePlugin([], purged)]);
    expect(await sql('SELECT 1 FROM connectors_v1_connectors')).toHaveLength(0);
    expect(purged).toEqual([]);
  });

  it('deletes authored drafts that propose a stdio server, keeps http drafts', async () => {
    await (await boot()).close({ onError: () => {} });
    harnesses.pop();
    await sql(
      `INSERT INTO connectors_v1_authored (owner_user_id, agent_id, connector_id, name, key_mode, capability_proposal, status)
       VALUES ('userA','agent1','localtool','Local','personal',$1::jsonb,'pending'),
              ('userA','agent1','gdrive','Drive','personal',$2::jsonb,'pending')`,
      [caps([stdioServer]), caps([httpServer])],
    );
    await boot();
    const rows = await sql('SELECT connector_id FROM connectors_v1_authored');
    expect(rows.map((r) => r['connector_id'])).toEqual(['gdrive']);
  });

  it('is idempotent: the first boot sweeps once, a second boot sweeps nothing and logs count 0', async () => {
    await (await boot()).close({ onError: () => {} });
    harnesses.pop();
    await insertConnector('userA', 'localtool', caps([stdioServer]));

    const firstEvents: ConnectorDeletedEvent[] = [];
    await (await boot([capturePlugin(firstEvents, [])])).close({ onError: () => {} });
    harnesses.pop();
    expect(firstEvents.map((e) => e.connectorId)).toEqual(['localtool']);

    const events: ConnectorDeletedEvent[] = [];
    const { logs } = await captureLogs(() => boot([capturePlugin(events, [])]));
    expect(events).toEqual([]);
    expect(logs.filter((l) => l['msg'] === 'connectors_stdio_swept')).toEqual([
      expect.objectContaining({ msg: 'connectors_stdio_swept', count: 0 }),
    ]);
  });

  it('list-effective works for a user when an admin\'s SHARED stdio connector was stored', async () => {
    await (await boot()).close({ onError: () => {} });
    harnesses.pop();
    await insertConnector('admin1', 'teamtool', caps([stdioServer]), { keyMode: 'workspace', visibility: 'shared' });
    await insertConnector('userA', 'gdrive', caps([httpServer]));

    const h = await boot();
    const out = await h.bus.call<ListEffectiveInput, ListEffectiveOutput>(
      'connectors:list-effective',
      h.ctx({ userId: 'userA' }),
      // Attach the (now swept) shared id too: it must resolve to nothing, not throw.
      { userId: 'userA', attachmentIds: ['teamtool', 'gdrive'] },
    );
    expect(out.connectors.map((c) => c.summary.id)).toEqual(['gdrive']);
    for (const c of out.connectors) {
      expect(c.capabilities.mcpServers.every((m) => (m as { transport: string }).transport !== 'stdio')).toBe(true);
    }
  });

  it('logs the skipped global purge for a same-id survivor (no per-person key to purge)', async () => {
    await (await boot()).close({ onError: () => {} });
    harnesses.pop();
    await insertConnector('admin1', 'teamtool', caps([httpServer], [{ slot: 'TOKEN', kind: 'api-key' }]), { keyMode: 'workspace', visibility: 'shared' });
    await insertConnector('userB', 'teamtool', caps([stdioServer], [{ slot: 'TOKEN', kind: 'api-key' }]), { keyMode: 'workspace' });
    const purged: Array<{ scope: string; ownerId: string | null; ref: string }> = [];
    const { logs } = await captureLogs(() => boot([capturePlugin([], purged)]));
    const skipped = logs.filter((l) => l['msg'] === 'connectors_stdio_sweep_skipped_global_purge');
    expect(skipped).toEqual([expect.objectContaining({ connectorId: 'teamtool' })]);
    expect(skipped[0]).not.toHaveProperty('ownKeyPurged');
    expect(purged).toEqual([]);
  });
});
