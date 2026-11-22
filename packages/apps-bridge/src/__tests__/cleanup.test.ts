import { makeAgentContext, type Logger } from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createSharedPostgres, createTestHarness, startTestContainer, type TestHarness } from '@ax/test-harness';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AppsBridgeDatabase } from '../migrations.js';
import { createAppsBridgePlugin } from '../plugin.js';
import { createAppsBridgeStore, type AppsBridgeStore } from '../store.js';

/*
  The real plugin on a real bus: the migration runs at init, and the two
  cleanup subscribers act on the events the agents and connectors plugins
  fire. A malformed event is logged by code and ignored, never thrown.
*/

const server = createSharedPostgres(() => startTestContainer(new PostgreSqlContainer('postgres:16-alpine')));
afterAll(() => server.stop(), 60_000);

let harness: TestHarness | undefined;
let db: Kysely<AppsBridgeDatabase> | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await db?.destroy().catch(() => {});
  db = undefined;
});

const P = 'acme-apps';
const AGENT = 'agt_support';
const OTHER_AGENT = 'agt_sales';
const ADA = 'usr_ada';
const BOB = 'usr_bob';
const KEY = 'mcp.c0123456789.create_issue';
const T0 = new Date('2026-11-21T12:00:00.000Z');

interface Line { level: string; msg: string; bindings: Record<string, unknown> | undefined }

function capturingLogger(lines: Line[]): Logger {
  const at = (level: string) => (msg: string, bindings?: Record<string, unknown>) => { lines.push({ level, msg, bindings }); };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };
  return logger;
}

async function boot(): Promise<{ h: TestHarness; store: AppsBridgeStore }> {
  const connectionString = await server.database();
  harness = await createTestHarness({
    plugins: [createDatabasePostgresPlugin({ connectionString }), createAppsBridgePlugin({ publicOrigin: 'http://ax.test' })],
  });
  db = new Kysely<AppsBridgeDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 4 }) }) });
  return { h: harness, store: createAppsBridgeStore(db) };
}

function hash(n: number): string {
  return n.toString(16).padStart(64, '0');
}

async function seed(store: AppsBridgeStore): Promise<void> {
  const mint = (n: number, agentId: string) =>
    store.mintLinkCode({ codeHash: hash(n), userId: ADA, agentId, expiresAt: new Date(T0.getTime() + 15 * 60_000), now: T0 });
  const link = async (n: number, appId: string, agentId: string) => {
    await mint(n, agentId);
    const r = await store.claimLinkCode({ codeHash: hash(n), platformId: P, appId, appName: 'App', now: T0 });
    if (r.result !== 'linked') throw new Error(r.result);
  };
  await mint(1, AGENT);
  await mint(2, OTHER_AGENT);
  await link(3, 'app_support', AGENT);
  await link(4, 'app_sales', OTHER_AGENT);
  await store.putGrant({ platformId: P, appId: 'app_support', connectorId: 'github', mode: 'viewer', toolKeys: [KEY] });
  await store.putGrant({ platformId: P, appId: 'app_sales', connectorId: 'github', mode: 'viewer', toolKeys: [KEY] });
  await store.putGrant({ platformId: P, appId: 'app_sales', connectorId: 'linear', mode: 'builder', toolKeys: [KEY] });
  await store.putApproval({ viewerUserId: BOB, platformId: P, appId: 'app_support', connectorId: 'github', agentId: 'agt_bob', toolKeys: [KEY] });
  // Ada's approval on the sales app borrows AGENT.
  await store.putApproval({ viewerUserId: ADA, platformId: P, appId: 'app_sales', connectorId: 'github', agentId: AGENT, toolKeys: [KEY] });
  await store.putApproval({ viewerUserId: BOB, platformId: P, appId: 'app_sales', connectorId: 'github', agentId: 'agt_bob', toolKeys: [KEY] });
}

async function snapshot(): Promise<Record<string, unknown[]>> {
  if (db === undefined) throw new Error('not booted');
  const q = async (text: string) => (await sql.raw<Record<string, unknown>>(text).execute(db!)).rows;
  return {
    codes: await q('SELECT code_hash, agent_id FROM apps_bridge_v1_link_codes ORDER BY code_hash'),
    links: await q('SELECT app_id, agent_id FROM apps_bridge_v1_links ORDER BY app_id'),
    grants: await q('SELECT app_id, connector_id FROM apps_bridge_v1_grants ORDER BY app_id, connector_id'),
    approvals: await q('SELECT viewer_user_id, app_id, connector_id, agent_id FROM apps_bridge_v1_viewer_approvals ORDER BY app_id, viewer_user_id'),
  };
}

describe('apps-bridge cleanup subscribers', () => {
  it('agents:deleted purges the agent\'s codes, links and the approvals that borrow it', async () => {
    const { h, store } = await boot();
    await seed(store);
    const lines: Line[] = [];
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agents', userId: 'system', logger: capturingLogger(lines) });
    await h.bus.fire('agents:deleted', ctx, { agentId: AGENT, ownerId: ADA, ownerType: 'user' });

    expect(await snapshot()).toEqual({
      codes: [{ code_hash: hash(2), agent_id: OTHER_AGENT }],
      links: [{ app_id: 'app_sales', agent_id: OTHER_AGENT }],
      grants: [{ app_id: 'app_sales', connector_id: 'github' }, { app_id: 'app_sales', connector_id: 'linear' }],
      approvals: [{ viewer_user_id: BOB, app_id: 'app_sales', connector_id: 'github', agent_id: 'agt_bob' }],
    });
    expect(lines).toContainEqual({ level: 'info', msg: 'apps_bridge_agent_cleaned', bindings: { codes: 1, links: 1, approvals: 1 } });
    expect(lines.filter((l) => l.msg === 'hook_subscriber_failed')).toEqual([]);
  });

  it('connectors:deleted removes grants only when the id is no longer live', async () => {
    const { h, store } = await boot();
    await seed(store);
    const ctx = h.ctx();
    const before = await snapshot();

    await h.bus.fire('connectors:deleted', ctx, { connectorId: 'github', toolNamespaces: [], idStillLive: true });
    expect(await snapshot()).toEqual(before);

    // A missing idStillLive keeps everything too: we fail toward keeping data.
    await h.bus.fire('connectors:deleted', ctx, { connectorId: 'github', toolNamespaces: [] });
    expect(await snapshot()).toEqual(before);

    await h.bus.fire('connectors:deleted', ctx, { connectorId: 'github', toolNamespaces: [], idStillLive: false });
    const after = await snapshot();
    expect(after.grants).toEqual([{ app_id: 'app_sales', connector_id: 'linear' }]);
    expect(after.approvals).toEqual([]);
    expect(after.links).toEqual(before.links);
    expect(after.codes).toEqual(before.codes);
  });

  it('a malformed payload is logged and ignored, never thrown', async () => {
    const { h, store } = await boot();
    await seed(store);
    const before = await snapshot();
    const lines: Line[] = [];
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agents', userId: 'system', logger: capturingLogger(lines) });

    for (const payload of [{}, { agentId: 7 }, { agentId: '' }, null, 'agt_support']) {
      await h.bus.fire('agents:deleted', ctx, payload);
    }
    for (const payload of [{}, { connectorId: 7, idStillLive: false }, { connectorId: '../x', idStillLive: false }]) {
      await h.bus.fire('connectors:deleted', ctx, payload);
    }
    expect(await snapshot()).toEqual(before);
    // The bus isolates a throwing subscriber and reports it on this line, so
    // its absence is what "never thrown" means here.
    expect(lines.filter((l) => l.msg === 'hook_subscriber_failed')).toEqual([]);

    const ignored = lines.filter((l) => l.msg === 'apps_bridge_cleanup_ignored');
    expect(ignored).toHaveLength(8);
    for (const l of ignored) {
      expect(l.level).toBe('warn');
      // A code and the hook, nothing quoted from the payload.
      expect(Object.keys(l.bindings ?? {}).sort()).toEqual(['code', 'hook']);
      expect(l.bindings?.code).toBe('invalid-payload');
    }
  });

  it('a store failure is logged by code and never thrown', async () => {
    const { h } = await boot();
    const lines: Line[] = [];
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agents', userId: 'system', logger: capturingLogger(lines) });
    // Take the table away underneath the plugin.
    await sql`DROP TABLE apps_bridge_v1_viewer_approvals`.execute(db!);
    await h.bus.fire('agents:deleted', ctx, { agentId: AGENT });
    expect(lines.filter((l) => l.msg === 'hook_subscriber_failed')).toEqual([]);
    const failed = lines.filter((l) => l.msg === 'apps_bridge_cleanup_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.level).toBe('warn');
    expect(Object.keys(failed[0]?.bindings ?? {}).sort()).toEqual(['code', 'hook']);
    expect(failed[0]?.bindings?.hook).toBe('agents:deleted');
  });
});
