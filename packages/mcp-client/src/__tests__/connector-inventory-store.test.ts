import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { CHECK_COOLDOWN_MS } from '../connector-inventory/describe-tools.js';
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
}, 60_000);

afterEach(async () => {
  vi.useRealTimers();
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
  // The boot sweep of retired host MCP server rows (TASK-792): nothing stored.
  'storage:list-prefix': async () => ({ entries: [] }),
  'storage:delete': async () => ({ deleted: 0 }),
  'credentials:get': async () => 'tok',
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

  it('purges an agent\'s cached inventories when agents:deleted fires, and nobody else\'s', async () => {
    const h = await boot(async () => ({ kind: 'ok', dropped: 0, tools: [] }));
    const { db } = await h.bus.call<unknown, { db: Kysely<McpClientDatabase> }>('database:get-instance', h.ctx(), {});
    const store = createInventoryStore(db);
    const row = { status: 'ok' as const, tools: [], fingerprint: 'f', checkedAt: new Date() };
    await store.put({ userId: 'u', agentId: 'gone', connectorId: 'c' }, row);
    await store.put({ userId: 'u2', agentId: 'gone', connectorId: 'c2' }, row);
    await store.put({ userId: 'u', agentId: 'kept', connectorId: 'c' }, row);
    await store.put({ userId: 'u', agentId: '', connectorId: 'c' }, row);
    await h.bus.fire('agents:deleted', h.ctx(), { agentId: 'gone', ownerId: 'u', ownerType: 'user' });
    expect(await store.get({ userId: 'u', agentId: 'gone', connectorId: 'c' })).toBeNull();
    expect(await store.get({ userId: 'u2', agentId: 'gone', connectorId: 'c2' })).toBeNull();
    expect(await store.get({ userId: 'u', agentId: 'kept', connectorId: 'c' })).not.toBeNull();
    expect(await store.get({ userId: 'u', agentId: '', connectorId: 'c' })).not.toBeNull();
    // A malformed payload is ignored, never thrown.
    await h.bus.fire('agents:deleted', h.ctx(), { agentId: '' });
    expect(await store.get({ userId: 'u', agentId: 'kept', connectorId: 'c' })).not.toBeNull();
  });

  it('TASK-741: inventory-status-batch reads the last stored status per connector and never lists', async () => {
    let listed = 0;
    const h = await boot(async () => {
      listed++;
      return { kind: 'unreachable', reason: 'timeout' };
    });
    expect(h.bus.hasService('connectors:inventory-status-batch')).toBe(true);
    const batch = (input: unknown) =>
      h.bus.call<unknown, { statuses: Array<{ connectorId: string; status: string; checkedAt: string }> }>(
        'connectors:inventory-status-batch',
        h.ctx(),
        input,
      );
    // Nothing checked yet: no entries, and no listing happened to find out.
    expect(await batch({ userId: 'u1', agentId: 'a1', connectorIds: ['linear'] })).toEqual({ statuses: [] });
    expect(listed).toBe(0);

    await h.bus.call('connectors:describe-tools', h.ctx(), { userId: 'u1', agentId: 'a1', connectorId: 'linear' });
    expect(listed).toBe(1);

    const { db } = await h.bus.call<unknown, { db: Kysely<McpClientDatabase> }>('database:get-instance', h.ctx(), {});
    const store = createInventoryStore(db);
    // A row older than any TTL is still the last known state.
    const old = new Date('2020-01-01T00:00:00Z');
    await store.put({ userId: 'u1', agentId: 'a1', connectorId: 'gmail' }, { status: 'ok', tools: [], fingerprint: '', checkedAt: old });

    const out = await batch({ userId: 'u1', agentId: 'a1', connectorIds: ['linear', 'gmail', 'never'] });
    const byId = new Map(out.statuses.map((s) => [s.connectorId, s]));
    expect(byId.get('linear')?.status).toBe('unreachable');
    expect(byId.get('gmail')).toEqual({ connectorId: 'gmail', status: 'ok', checkedAt: old.toISOString() });
    expect(byId.has('never')).toBe(false);
    // Scoped to the exact (user, agent): another user or agent sees nothing.
    expect(await batch({ userId: 'u2', agentId: 'a1', connectorIds: ['linear'] })).toEqual({ statuses: [] });
    expect(await batch({ userId: 'u1', connectorIds: ['linear'] })).toEqual({ statuses: [] });
    expect(listed).toBe(1);

    await expect(batch({ userId: 'u1', connectorIds: 'linear' })).rejects.toThrow();
    await expect(batch({ userId: 'u1', connectorIds: [], extra: 1 })).rejects.toThrow();
    // Same id cap as mcp-oauth:status-batch (128), so one list fits both.
    await expect(batch({ userId: 'u1', connectorIds: ['x'.repeat(129)] })).rejects.toThrow();
    expect(await batch({ userId: 'u1', connectorIds: ['x'.repeat(128)] })).toEqual({ statuses: [] });
  });

  it('TASK-787: during an inventory-write outage the batch shows the newest describe-tools answer; the stored row wins once writes recover', async () => {
    // Only Date is faked: the 30s per-connector check window is read off the
    // clock, and the pg driver's own timers must stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const nextWindow = () => vi.setSystemTime(new Date(Date.now() + CHECK_COOLDOWN_MS));
    let outcome: ListOutcome = { kind: 'ok', dropped: 0, tools: [] };
    const h = await boot(async () => outcome);
    const { db } = await h.bus.call<unknown, { db: Kysely<McpClientDatabase> }>('database:get-instance', h.ctx(), {});
    const batch = async () =>
      (
        await h.bus.call<unknown, { statuses: Array<{ connectorId: string; status: string }> }>(
          'connectors:inventory-status-batch',
          h.ctx(),
          { userId: 'u1', agentId: 'a1', connectorIds: ['linear'] },
        )
      ).statuses.map((s) => s.status);
    const refresh = () =>
      h.bus.call<unknown, DescribeToolsOutput>('connectors:describe-tools', h.ctx(), {
        userId: 'u1',
        agentId: 'a1',
        connectorId: 'linear',
        force: true,
      });
    const storedStatus = async () =>
      (await createInventoryStore(db).get({ userId: 'u1', agentId: 'a1', connectorId: 'linear' }))?.status;

    expect((await refresh()).status).toBe('ok');
    expect(await batch()).toEqual(['ok']);

    // A write outage: inserts and updates fail, reads still work.
    await sql`CREATE OR REPLACE FUNCTION mcp_client_test_refuse_write() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'inventory write refused'; END; $$ LANGUAGE plpgsql`.execute(db);
    await sql`CREATE TRIGGER mcp_client_test_refuse BEFORE INSERT OR UPDATE ON mcp_client_v1_tool_inventory
      FOR EACH ROW EXECUTE FUNCTION mcp_client_test_refuse_write()`.execute(db);
    outcome = { kind: 'needs-auth' };
    nextWindow();
    expect((await refresh()).status).toBe('needs-auth');
    expect(await storedStatus()).toBe('ok'); // the write really failed
    expect(await batch()).toEqual(['needs-auth']);

    // Recovery: the next write lands, and the stored row is the answer.
    await sql`DROP TRIGGER mcp_client_test_refuse ON mcp_client_v1_tool_inventory`.execute(db);
    await sql`DROP FUNCTION mcp_client_test_refuse_write()`.execute(db);
    outcome = { kind: 'unreachable', reason: 'timeout' };
    nextWindow();
    expect((await refresh()).status).toBe('unreachable');
    expect(await storedStatus()).toBe('unreachable');
    expect(await batch()).toEqual(['unreachable']);
  });

  it("TASK-787: agents:deleted also forgets the agent's answers held during a write outage", async () => {
    const h = await boot(async () => ({ kind: 'needs-auth' }));
    const { db } = await h.bus.call<unknown, { db: Kysely<McpClientDatabase> }>('database:get-instance', h.ctx(), {});
    await sql`CREATE OR REPLACE FUNCTION mcp_client_test_refuse_write() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'inventory write refused'; END; $$ LANGUAGE plpgsql`.execute(db);
    await sql`CREATE TRIGGER mcp_client_test_refuse BEFORE INSERT OR UPDATE ON mcp_client_v1_tool_inventory
      FOR EACH ROW EXECUTE FUNCTION mcp_client_test_refuse_write()`.execute(db);
    const batch = async (agentId: string) =>
      (
        await h.bus.call<unknown, { statuses: Array<{ status: string }> }>('connectors:inventory-status-batch', h.ctx(), {
          userId: 'u1',
          agentId,
          connectorIds: ['linear'],
        })
      ).statuses.map((s) => s.status);
    for (const agentId of ['gone', 'kept']) {
      await h.bus.call('connectors:describe-tools', h.ctx(), { userId: 'u1', agentId, connectorId: 'linear' });
    }
    expect(await batch('gone')).toEqual(['needs-auth']);
    await h.bus.fire('agents:deleted', h.ctx(), { agentId: 'gone', ownerId: 'u1', ownerType: 'user' });
    expect(await batch('gone')).toEqual([]);
    expect(await batch('kept')).toEqual(['needs-auth']);
    await sql`DROP TRIGGER mcp_client_test_refuse ON mcp_client_v1_tool_inventory`.execute(db);
    await sql`DROP FUNCTION mcp_client_test_refuse_write()`.execute(db);
  });

  it('TASK-753: inventory-tool-titles reads cached titles only, newest first, scoped to the user', async () => {
    let listed = 0;
    const h = await boot(async () => {
      listed++;
      return { kind: 'unreachable', reason: 'timeout' };
    });
    expect(h.bus.hasService('connectors:inventory-tool-titles')).toBe(true);
    const titles = (input: unknown) =>
      h.bus.call<unknown, { titles: Array<{ connectorId: string; toolKey: string; title: string }> }>(
        'connectors:inventory-tool-titles',
        h.ctx(),
        input,
      );
    const { db } = await h.bus.call<unknown, { db: Kysely<McpClientDatabase> }>('database:get-instance', h.ctx(), {});
    const store = createInventoryStore(db);
    const tool = (name: string, title: string) => ({
      name,
      title,
      description: '',
      readOnly: null,
      outward: null,
      toolKey: `mcp.c5e0235982f.${name}`,
    });
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-02-01T00:00:00Z');
    await store.put(
      { userId: 'u1', agentId: 'a1', connectorId: 'linear' },
      {
        status: 'ok',
        tools: [tool('create_issue', 'Old title'), tool('list_issues', 'list_issues')],
        fingerprint: '',
        checkedAt: older,
      },
    );
    await store.put(
      { userId: 'u1', agentId: 'a2', connectorId: 'linear' },
      { status: 'ok', tools: [tool('create_issue', 'Open a ticket')], fingerprint: '', checkedAt: newer },
    );
    // A failed check is not an inventory, and another user's row is not ours.
    await store.put(
      { userId: 'u1', agentId: 'a3', connectorId: 'gmail' },
      { status: 'unreachable', tools: [tool('send', 'Send mail')], fingerprint: '', checkedAt: newer },
    );
    await store.put(
      { userId: 'u2', agentId: 'a1', connectorId: 'linear' },
      { status: 'ok', tools: [tool('create_issue', 'Someone else')], fingerprint: '', checkedAt: newer },
    );

    const out = await titles({ userId: 'u1', connectorIds: ['linear', 'gmail', 'never'] });
    // The newest check wins; a title that is just the name is no title.
    expect(out).toEqual({
      titles: [{ connectorId: 'linear', toolKey: 'mcp.c5e0235982f.create_issue', title: 'Open a ticket' }],
    });
    expect((await titles({ userId: 'u2', connectorIds: ['linear'] })).titles.map((t) => t.title)).toEqual([
      'Someone else',
    ]);
    expect(await titles({ userId: 'u1', connectorIds: [] })).toEqual({ titles: [] });
    // Never a network call on the label path.
    expect(listed).toBe(0);

    // A hostile server's title is bounded on the wire.
    await store.put(
      { userId: 'u3', agentId: '', connectorId: 'big' },
      { status: 'ok', tools: [tool('x', 'T'.repeat(5000))], fingerprint: '', checkedAt: newer },
    );
    const big = await titles({ userId: 'u3', connectorIds: ['big'] });
    expect([...big.titles[0]!.title]).toHaveLength(200);

    await expect(titles({ userId: 'u1', connectorIds: 'linear' })).rejects.toThrow();
    await expect(titles({ userId: 'u1', connectorIds: [], agentId: 'a1' })).rejects.toThrow();
  });

  it('is off by default: no hook, no database call in the manifest', () => {
    const p = createMcpClientPlugin();
    expect(p.manifest.registers).toEqual([]);
    expect(p.manifest.calls).not.toContain('database:get-instance');
    const on = createMcpClientPlugin({ connectorToolInventory: true });
    expect(on.manifest.registers).toEqual([
      'connectors:describe-tools',
      'connectors:inventory-status-batch',
      'connectors:inventory-tool-titles',
    ]);
    expect(on.manifest.subscribes).toEqual(['agents:deleted', 'connectors:auth-failure-reported']);
    expect(p.manifest.optionalCalls?.map((c) => c.hook)).not.toContain('connectors:list-effective');
    expect(p.manifest.subscribes).toEqual([]);
    expect(on.manifest.calls).toEqual(
      expect.arrayContaining(['database:get-instance', 'connectors:resolve', 'agents:resolve', 'credentials:get']),
    );
  });
});
