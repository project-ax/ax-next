import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';

import type { AgentContext } from '@ax/core';
import {
  createTestHarness,
  startTestContainer,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createStoragePostgresPlugin } from '@ax/storage-postgres';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { createConnectorsPlugin } from '@ax/connectors';
import { createAgentsPlugin } from '@ax/agents';
import type { CreateOutput as AgentCreateOutput } from '@ax/agents';
import { createMcpOAuthPlugin } from '@ax/mcp-oauth';

// ---------------------------------------------------------------------------
// Slice 2b (agent-owned sign-ins) — a connector delete, end to end, through the
// REAL halves: @ax/connectors announces, @ax/agents detaches, @ax/credentials
// purges, @ax/mcp-oauth drops reconnect markers. Each plugin has its own test
// against a stubbed other side; this is the one that proves they agree on the
// hook surface (`connectors:deleted` with `idStillLive`, `connectors:live-ids`,
// `credentials:purge-account`) and on boot ORDER.
//
// Boot order matters: @ax/connectors inits BEFORE @ax/agents (agents declares
// `connectors:live-ids` as an optional call, so the graph puts connectors
// first; the k8s preset measured credentials 3, connectors 9, agents 12,
// mcp-oauth 42). So the one-time non-admin sweep fires `connectors:deleted`
// while nobody from agents is listening yet — agents' own boot sweep, asking
// `connectors:live-ids`, is what detaches those ids. The plugin list below is
// in kernel order, and mcp-oauth is listed last so it also inits after
// connectors, as in prod (it misses boot-time events — slice 5's to fix).
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
let savedCredentialsKey: string | undefined;
const harnesses: TestHarness[] = [];

const ADMIN = 'admin1';
const ADMIN2 = 'admin2';
const USER = 'userB';
const PERSON = 'alice';

/** `auth:get-user`: admins are admins; everyone else is a non-admin. */
const getUser = async (_ctx: AgentContext, input: unknown) => {
  const { userId } = input as { userId: string };
  return { id: userId, isAdmin: userId === ADMIN || userId === ADMIN2 };
};

async function boot(opts: { withAuth: boolean }): Promise<TestHarness> {
  const services: Record<string, (ctx: AgentContext, input: unknown) => Promise<unknown>> = {
    // @ax/agents mounts admin routes; this test drives the bus directly.
    'http:register-route': async () => ({ unregister: () => {} }),
    'auth:require-user': async () => {
      throw new Error('auth:require-user is not exercised by this test');
    },
  };
  // Without it the connectors sweep skips (and records nothing) — the seed boot.
  if (opts.withAuth) services['auth:get-user'] = getUser;
  const h = await createTestHarness({
    services: services as never,
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createStoragePostgresPlugin(),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      createConnectorsPlugin(),
      createAgentsPlugin(),
      createMcpOAuthPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

async function closeAll(): Promise<void> {
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
}

async function query(text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end().catch(() => {});
  }
}

function caps(id: string) {
  return {
    allowedHosts: [],
    credentials: [{ slot: 'TOKEN', kind: 'api-key' }],
    mcpServers: [
      { name: id, transport: 'http', url: `https://mcp.example.com/${id}`, allowedHosts: [], credentials: [] },
    ],
    packages: { npm: [], pypi: [] },
    services: [],
  };
}

async function upsertConnector(
  h: TestHarness,
  owner: string,
  id: string,
  visibility: 'shared' | 'private',
): Promise<void> {
  await h.bus.call('connectors:upsert', h.ctx({ userId: owner }), {
    userId: owner,
    connectorId: id,
    name: id,
    keyMode: 'personal',
    visibility,
    capabilities: caps(id),
  });
}

async function newAgent(h: TestHarness, attachments: string[]): Promise<string> {
  const out = await h.bus.call<unknown, AgentCreateOutput>('agents:create', h.ctx({ userId: ADMIN }), {
    actor: { userId: ADMIN, isAdmin: true },
    input: {
      displayName: 'Quill',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'anthropic/claude-opus-4-7',
      visibility: 'personal',
    },
  });
  const agentId = out.agent.id;
  // The attach route checks the connector through the bus; the lists are all
  // this test is about, so they are seeded directly.
  await query('UPDATE agents_v1_agents SET connector_attachments = $2::jsonb WHERE agent_id = $1', [
    agentId,
    JSON.stringify(attachments),
  ]);
  return agentId;
}

async function attachments(agentId: string): Promise<string[]> {
  const r = await query('SELECT connector_attachments FROM agents_v1_agents WHERE agent_id = $1', [agentId]);
  return r[0]!['connector_attachments'] as string[];
}

async function setKey(h: TestHarness, scope: 'user' | 'agent', ownerId: string, ref: string): Promise<void> {
  await h.bus.call('credentials:set', h.ctx({ userId: ADMIN }), {
    scope,
    ownerId,
    ref,
    kind: 'api-key',
    payload: new TextEncoder().encode(`secret-${ownerId}-${ref}`),
  });
}

/** Every live credential as `scope/owner/ref`, sorted. */
async function keys(h: TestHarness): Promise<string[]> {
  const out = await h.bus.call<unknown, { credentials: Array<{ scope: string; ownerId: string | null; ref: string }> }>(
    'credentials:list',
    h.ctx({ userId: ADMIN }),
    {},
  );
  return out.credentials.map((c) => `${c.scope}/${c.ownerId ?? '-'}/${c.ref}`).sort();
}

async function markers(): Promise<string[]> {
  const user = await query('SELECT user_id, connector_id FROM mcp_oauth_v1_needs_reconnect');
  const agent = await query('SELECT agent_id, connector_id FROM mcp_oauth_v1_needs_reconnect_agent');
  return [
    ...user.map((r) => `user/${String(r['user_id'])}/${String(r['connector_id'])}`),
    ...agent.map((r) => `agent/${String(r['agent_id'])}/${String(r['connector_id'])}`),
  ].sort();
}

async function liveConnectors(): Promise<string[]> {
  const r = await query(
    'SELECT owner_user_id, connector_id FROM connectors_v1_connectors WHERE deleted_at IS NULL ORDER BY 1, 2',
  );
  return r.map((x) => `${String(x['owner_user_id'])}/${String(x['connector_id'])}`);
}

beforeAll(async () => {
  savedCredentialsKey = process.env.AX_CREDENTIALS_KEY;
  process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 180_000);

afterEach(closeAll);

afterAll(async () => {
  await closeAll();
  if (container) await stopPostgresContainer(container);
  if (savedCredentialsKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
  else process.env.AX_CREDENTIALS_KEY = savedCredentialsKey;
});

describe('connector delete composition: real connectors + agents + credentials + mcp-oauth', () => {
  it('boot removal, runtime admin delete, and a same-id survivor all leave agents consistent', async () => {
    // ---- Seed boot (no auth provider → the non-admin sweep skips) ----------
    const seed = await boot({ withAuth: false });
    await upsertConnector(seed, USER, 'usertool', 'shared'); // non-admin's: removed at boot
    await upsertConnector(seed, USER, 'sameid', 'shared'); // non-admin's, but an admin's survives
    await upsertConnector(seed, ADMIN, 'sameid', 'shared');
    await upsertConnector(seed, ADMIN, 'admintool', 'shared'); // removed at runtime (b)
    await upsertConnector(seed, ADMIN, 'dupid', 'shared'); // (c): removed at runtime…
    await upsertConnector(seed, ADMIN2, 'dupid', 'private'); // …while this one keeps the id
    const agentA = await newAgent(seed, ['usertool', 'sameid', 'admintool', 'dupid']);
    const agentB = await newAgent(seed, ['usertool', 'keepme']);

    // People's keys, agents' sign-ins, and reconnect markers for each id.
    for (const id of ['usertool', 'sameid', 'admintool', 'dupid']) {
      await setKey(seed, 'user', PERSON, `account:${id}`);
      await setKey(seed, 'agent', agentA, `account:${id}`);
    }
    for (const id of ['admintool', 'dupid']) {
      await query('INSERT INTO mcp_oauth_v1_needs_reconnect (user_id, connector_id, marked_at) VALUES ($1, $2, now())', [
        PERSON,
        id,
      ]);
      await query(
        'INSERT INTO mcp_oauth_v1_needs_reconnect_agent (agent_id, connector_id, marked_at) VALUES ($1, $2, now())',
        [agentA, id],
      );
    }
    await closeAll();

    // ---- (a) Real boot: connectors' one-time sweep + agents' boot sweep ----
    const h = await boot({ withAuth: true });
    expect(await liveConnectors()).toEqual([
      `${ADMIN}/admintool`,
      `${ADMIN}/dupid`,
      `${ADMIN}/sameid`,
      `${ADMIN2}/dupid`,
    ]);
    // Detached on the SAME boot, by agents' boot sweep (connectors' event fired
    // before agents subscribed). 'keepme' was never a connector: no live
    // connector has it either, so it goes too — the sweep's documented rule.
    expect(await attachments(agentA)).toEqual(['sameid', 'admintool', 'dupid']);
    expect(await attachments(agentB)).toEqual([]);
    // usertool's people's keys and agents' sign-ins are purged; sameid's stay
    // (an admin's live connector still carries the id).
    expect(await keys(h)).toEqual(
      [
        `agent/${agentA}/account:admintool`,
        `agent/${agentA}/account:dupid`,
        `agent/${agentA}/account:sameid`,
        `user/${PERSON}/account:admintool`,
        `user/${PERSON}/account:dupid`,
        `user/${PERSON}/account:sameid`,
      ].sort(),
    );

    // ---- (b) Runtime admin delete of a shared connector (id now dead) ------
    await h.bus.call('connectors:delete', h.ctx({ userId: ADMIN }), {
      userId: ADMIN,
      connectorId: 'admintool',
      purgeGlobal: true,
    });
    expect(await attachments(agentA)).toEqual(['sameid', 'dupid']);
    expect((await keys(h)).filter((k) => k.endsWith(':admintool'))).toEqual([]);
    expect((await markers()).filter((m) => m.endsWith('/admintool'))).toEqual([]);

    // ---- (c) Runtime delete while a same-id connector survives -------------
    await h.bus.call('connectors:delete', h.ctx({ userId: ADMIN }), {
      userId: ADMIN,
      connectorId: 'dupid',
      purgeGlobal: true,
    });
    expect(await liveConnectors()).toEqual([`${ADMIN}/sameid`, `${ADMIN2}/dupid`]);
    // The id is still live: attachments, people's keys and markers all stay.
    expect(await attachments(agentA)).toEqual(['sameid', 'dupid']);
    expect(await keys(h)).toContain(`user/${PERSON}/account:dupid`);
    expect(await markers()).toEqual([`agent/${agentA}/dupid`, `user/${PERSON}/dupid`]);
  });
});
