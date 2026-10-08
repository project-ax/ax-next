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
// connectors, as in prod: it misses boot-time events, so its own boot sweep
// (asking `connectors:live-ids`) drops agent markers for dead ids (slice 5).
//
// Slice 5 — nothing is per person any more. Connector keys live on agents
// (or are the one company key), the person-level marker table is gone, and
// @ax/credentials purges every old user-scope `account:` row once at boot.
// This test plants such rows the way a pre-slice-5 vault holds them and
// proves they are never read and are gone after the boot.
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

async function upsertConnector(h: TestHarness, owner: string, id: string): Promise<void> {
  await h.bus.call('connectors:upsert', h.ctx({ userId: owner }), {
    userId: owner,
    connectorId: id,
    name: id,
    keyMode: 'personal',
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

async function setAgentKey(h: TestHarness, agentId: string, ref: string): Promise<void> {
  await h.bus.call('credentials:set', h.ctx({ userId: ADMIN }), {
    scope: 'agent',
    ownerId: agentId,
    ref,
    kind: 'api-key',
    payload: new TextEncoder().encode(`secret-${agentId}-${ref}`),
  });
}

/**
 * Plant a person-level connector key the way a vault written before slice 5
 * holds it: `credentials:set` refuses `account:` at user scope now, so copy a
 * validly sealed blob (the agent's) into user scope through the store seam.
 */
async function plantPersonKey(h: TestHarness, fromAgentId: string, userId: string, ref: string): Promise<void> {
  const ctx = h.ctx({ userId: ADMIN });
  const { blob } = await h.bus.call<unknown, { blob: Uint8Array | undefined }>('credentials:store-blob:get', ctx, {
    scope: 'agent',
    ownerId: fromAgentId,
    ref,
  });
  expect(blob).toBeDefined();
  await h.bus.call('credentials:store-blob:put', ctx, { scope: 'user', ownerId: userId, ref, blob });
}

/** What a session of `userId` on `agentId` gets for `ref`: the value, or the error code. */
async function readAs(h: TestHarness, userId: string, agentId: string, ref: string): Promise<string> {
  try {
    return await h.bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      h.ctx({ userId, agentId }),
      { ref, userId },
    );
  } catch (err) {
    return `error:${(err as { code?: string }).code ?? 'unknown'}`;
  }
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
  const agent = await query('SELECT agent_id, connector_id FROM mcp_oauth_v1_needs_reconnect_agent');
  return agent.map((r) => `agent/${String(r['agent_id'])}/${String(r['connector_id'])}`).sort();
}

/** Whether the retired person-level marker table exists at all. */
async function userMarkerTableExists(): Promise<boolean> {
  const r = await query("SELECT to_regclass('mcp_oauth_v1_needs_reconnect') AS t");
  return r[0]!['t'] !== null;
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
    await upsertConnector(seed, USER, 'usertool'); // non-admin's: removed at boot
    await upsertConnector(seed, USER, 'sameid'); // non-admin's, but an admin's survives
    await upsertConnector(seed, ADMIN, 'sameid');
    await upsertConnector(seed, ADMIN, 'admintool'); // removed at runtime (b)
    await upsertConnector(seed, ADMIN, 'dupid'); // (c): removed at runtime…
    await upsertConnector(seed, ADMIN2, 'dupid'); // …while this one keeps the id
    const agentA = await newAgent(seed, ['usertool', 'sameid', 'admintool', 'dupid']);
    const agentB = await newAgent(seed, ['usertool', 'keepme']);

    // Agents' keys and reconnect markers for each id, plus the person-level
    // keys an old vault still holds for the same ids.
    for (const id of ['usertool', 'sameid', 'admintool', 'dupid']) {
      await setAgentKey(seed, agentA, `account:${id}`);
      await plantPersonKey(seed, agentA, PERSON, `account:${id}`);
    }
    for (const id of ['usertool', 'admintool', 'dupid']) {
      await query(
        'INSERT INTO mcp_oauth_v1_needs_reconnect_agent (agent_id, connector_id, marked_at) VALUES ($1, $2, now())',
        [agentA, id],
      );
    }
    // The person-level marker table was dropped by mcp-oauth's migration.
    expect(await userMarkerTableExists()).toBe(false);
    // Never readable: on an agent with no key, the person's own row is not
    // consulted for an `account:` ref (it would have been before slice 5).
    expect(await readAs(seed, PERSON, agentB, 'account:sameid')).toBe('error:credential-not-found');
    // Simulate a vault from before slice 5: no purge marker yet (the seed
    // boot already ran the one-time purge on an empty vault).
    await query("DELETE FROM storage_postgres_v1_kv WHERE key LIKE '%user-account-purged'");
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
    // usertool's and sameid's agent sign-ins are purged (sameid too, though an
    // admin's live connector still carries the id: sign-ins are keyed by id
    // alone, so the survivor must not read a token minted for the removed
    // definition). Every person-level row is gone:
    // @ax/credentials' one-time boot purge.
    expect(await keys(h)).toEqual(
      [
        `agent/${agentA}/account:admintool`,
        `agent/${agentA}/account:dupid`,
      ].sort(),
    );
    // mcp-oauth's boot sweep dropped the marker for the id removed at boot.
    expect(await markers()).toEqual([`agent/${agentA}/admintool`, `agent/${agentA}/dupid`]);

    // ---- (b) Runtime admin delete of a connector (id now dead) -------------
    await h.bus.call('connectors:delete', h.ctx({ userId: ADMIN }), {
      userId: ADMIN,
      connectorId: 'admintool',
      purgeGlobal: true,
    });
    expect(await attachments(agentA)).toEqual(['sameid', 'dupid']);
    expect((await keys(h)).filter((k) => k.endsWith(':admintool'))).toEqual([]);
    expect((await markers()).filter((m) => m.endsWith('/admintool'))).toEqual([]);

    // ---- (c) Runtime delete while a same-id connector survives -------------
    // Two live definitions of `dupid` (ADMIN's and ADMIN2's): the id is
    // ambiguous, so it fails closed — agent A's stored sign-in reads as absent
    // (the vault's own "no such credential"), not as whichever definition
    // happens to be asked about. The control: the row is stored.
    expect((await keys(h)).filter((k) => k.endsWith(':dupid'))).toEqual([`agent/${agentA}/account:dupid`]);
    expect(await readAs(h, ADMIN, agentA, 'account:dupid')).toBe('error:credential-not-found');
    await h.bus.call('connectors:delete', h.ctx({ userId: ADMIN }), {
      userId: ADMIN,
      connectorId: 'dupid',
      purgeGlobal: true,
    });
    expect(await liveConnectors()).toEqual([`${ADMIN}/sameid`, `${ADMIN2}/dupid`]);
    // The id is still live (ADMIN2's): attachments and the agent's marker stay.
    // The agent's sign-in does NOT: it is keyed by id alone, so it would
    // otherwise become readable through a survivor that may point at other
    // hosts. A re-sign-in is needed.
    expect(await attachments(agentA)).toEqual(['sameid', 'dupid']);
    expect((await keys(h)).filter((k) => k.endsWith(':dupid'))).toEqual([]);
    expect(await markers()).toEqual([`agent/${agentA}/dupid`]);
    expect(await readAs(h, ADMIN, agentA, 'account:dupid')).toBe('error:credential-not-found');
    // Nothing per person anywhere.
    expect((await keys(h)).filter((k) => k.startsWith('user/'))).toEqual([]);
  });
});
