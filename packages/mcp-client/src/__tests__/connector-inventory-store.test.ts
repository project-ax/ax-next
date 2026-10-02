import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, startTestContainer, stopPostgresContainer, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { sql, type Kysely } from 'kysely';
import { createMcpClientPlugin } from '../plugin.js';
import {
  createInventoryStore,
  runMcpClientMigration,
  type McpClientDatabase,
} from '../connector-inventory/store.js';
import type { ListOutcome } from '../connector-inventory/list-tools.js';
import type { DescribeToolsOutput } from '../connector-inventory/types.js';

// ---------------------------------------------------------------------------
// The inventory cache table against a real Postgres, and the plugin wiring:
// `connectorToolInventory: true` migrates, registers the hook, and serves it
// over the bus; leaving it off registers nothing and needs no database.
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    try {
      const { db } = await h.bus.call<unknown, { db: Kysely<McpClientDatabase> }>('database:get-instance', h.ctx(), {});
      await sql`DROP TABLE IF EXISTS mcp_client_v1_tool_inventory`.execute(db);
    } catch {
      /* harness without a database */
    }
    await h.close();
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const baseServices = {
  'storage:get': async () => ({ value: undefined }),
  'storage:set': async () => undefined,
  'credentials:get': async () => 'tok',
  'tool:register': async () => undefined,
  'agents:resolve': async () => ({ agent: {} }),
  'connectors:resolve': async () => ({
    id: 'linear',
    capabilities: {
      credentials: [],
      mcpServers: [{ name: 'main', transport: 'http', url: 'https://mcp.linear.app/mcp' }],
    },
    credentialPlan: [],
    toolNamespaces: [{ server: 'main', toolNamespace: 'c0123456789' }],
  }),
};

async function boot(listTools: () => Promise<ListOutcome>): Promise<TestHarness> {
  const h = await createTestHarness({
    services: baseServices,
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createMcpClientPlugin({ connectorToolInventory: true, connectorInventoryListTools: listTools }),
    ],
  });
  harnesses.push(h);
  return h;
}

describe('inventory store (postgres)', () => {
  it('migrates idempotently, round-trips, upserts, and treats a corrupt row as a miss', async () => {
    const h = await boot(async () => ({ kind: 'ok', dropped: 0, tools: [] }));
    const { db } = await h.bus.call<unknown, { db: Kysely<McpClientDatabase> }>('database:get-instance', h.ctx(), {});
    await runMcpClientMigration(db); // second run is a no-op
    const store = createInventoryStore(db);
    const key = { userId: 'u', agentId: '', connectorId: 'c' };
    expect(await store.get(key)).toBeNull();

    const tool = {
      name: 'a',
      title: 'A',
      description: 'd',
      readOnly: true,
      outward: null,
      toolKey: 'mcp.c0123456789.a',
    };
    const at = new Date('2026-10-02T12:00:00Z');
    await store.put(key, { status: 'ok', tools: [tool], fingerprint: 'f1', checkedAt: at });
    expect(await store.get(key)).toEqual({ status: 'ok', tools: [tool], fingerprint: 'f1', checkedAt: at });

    await store.put(key, { status: 'needs-auth', tools: [], fingerprint: 'f1', checkedAt: at });
    expect((await store.get(key))!.status).toBe('needs-auth');
    expect(await store.get({ ...key, agentId: 'other' })).toBeNull();

    await sql`UPDATE mcp_client_v1_tool_inventory SET tools = 'not json'`.execute(db);
    expect(await store.get(key)).toBeNull();
    await sql`UPDATE mcp_client_v1_tool_inventory SET tools = '[]', status = 'bogus'`.execute(db);
    expect(await store.get(key)).toBeNull();
  });
});

describe('plugin wiring', () => {
  it('registers connectors:describe-tools and serves it from the table across calls', async () => {
    let listed = 0;
    const h = await boot(async () => {
      listed++;
      return {
        kind: 'ok',
        dropped: 0,
        tools: [{ name: 'search', title: 'Search', description: '', readOnly: true, outward: false }],
      };
    });
    expect(h.bus.hasService('connectors:describe-tools')).toBe(true);
    const first = await h.bus.call<unknown, DescribeToolsOutput>('connectors:describe-tools', h.ctx(), {
      userId: 'u1',
      connectorId: 'linear',
    });
    expect(first.status).toBe('ok');
    expect(first.tools[0]!.toolKey).toBe('mcp.c0123456789.search');
    const second = await h.bus.call<unknown, DescribeToolsOutput>('connectors:describe-tools', h.ctx(), {
      userId: 'u1',
      connectorId: 'linear',
    });
    expect(second).toEqual(first);
    expect(listed).toBe(1);
  });

  it('is off by default: no hook, no database call in the manifest', () => {
    const p = createMcpClientPlugin();
    expect(p.manifest.registers).toEqual([]);
    expect(p.manifest.calls).not.toContain('database:get-instance');
    const on = createMcpClientPlugin({ connectorToolInventory: true });
    expect(on.manifest.registers).toEqual(['connectors:describe-tools']);
    expect(on.manifest.calls).toEqual(
      expect.arrayContaining(['database:get-instance', 'connectors:resolve', 'agents:resolve', 'credentials:get']),
    );
  });
});
