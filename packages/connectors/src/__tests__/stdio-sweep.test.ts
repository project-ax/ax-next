import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import type { ConnectorDeletedEvent, ListOutput } from '../types.js';

// The sweep runs inside connectors' init, so the capture plugin must init
// BEFORE it. Registering `credentials:delete` (an optionalCall of
// @ax/connectors) puts this plugin ahead of it in topological order.
function capturePlugin(events: ConnectorDeletedEvent[], purged: Array<{ scope: string; ownerId: string | null; ref: string }>): Plugin {
  return {
    manifest: { name: 'test/capture', version: '0.0.0', registers: ['credentials:delete'], calls: [], subscribes: ['connectors:deleted'] },
    init({ bus }) {
      bus.registerService('credentials:delete', 'test/capture', async (_ctx, input) => {
        purged.push(input as { scope: string; ownerId: string | null; ref: string });
        return undefined;
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
      { connectorId: 'localtool', toolNamespaces: deriveToolNamespaces('userA', { id: 'localtool', capabilities: { mcpServers: [stdioServer as never] } }) },
    ]);
    expect(purged).toEqual([{ scope: 'user', ownerId: 'userA', ref: 'account:localtool' }]);

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

  it('is idempotent: a second boot sweeps nothing', async () => {
    await (await boot()).close({ onError: () => {} });
    harnesses.pop();
    await insertConnector('userA', 'localtool', caps([stdioServer]));
    await (await boot()).close({ onError: () => {} });
    harnesses.pop();
    const events: ConnectorDeletedEvent[] = [];
    await boot([capturePlugin(events, [])]);
    expect(events).toEqual([]);
  });
});
