import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError, type HookBus, type Plugin } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createCredentialsPlugin } from '@ax/credentials';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createConnectorsPlugin } from '../plugin.js';
import type { UpsertInput, UpsertOutput } from '../types.js';

// ---------------------------------------------------------------------------
// TASK-788 — a credential stored ON an agent for a connector is readable only
// while that connector is on the agent.
//
// THE GAP. TASK-711 let `credentials:get` take the agent step for `account:<id>`
// whenever the reader resolved the one shared definition with that id, without
// asking whether the agent carries the connector. A team sign-in kept resolving
// after the connector was detached from the agent (or for an agent that never
// had it), so any path that asks the vault with that agent in ctx got the token.
//
// REAL PIECES: postgres connectors store, the real vault + its DB-backed blob
// store (over an in-memory `storage:*` stub), the real
// `credentials:authorize-agent:account` provider. STUB: `agents:resolve` (a
// mutable agent record + member list, refusing non-members the way @ax/agents
// does). Reads go the way the credential proxy reads: `credentials:get` with
// the agent in ctx. Against the TASK-711 provider every `refused` case below
// returns the team token.
// ---------------------------------------------------------------------------

const TEAM_TOKEN = 'TEAM-LINEAR-TOKEN';
const AGENT_ID = 'team-agent-1';
const REF = 'account:linear';

interface AgentRecord {
  members: string[];
  connectorAttachments: string[];
  connectorExclusions: string[];
}

let container: StartedPostgreSqlContainer;
let connectionString: string;
let savedCredentialsKey: string | undefined;
const harnesses: TestHarness[] = [];
let agent: AgentRecord;

function agentsStub(): Plugin {
  return {
    manifest: {
      name: 'agents-stub',
      version: '0.0.0',
      registers: ['agents:resolve'],
      calls: [],
      subscribes: ['connectors:deleted'],
    },
    async init({ bus }) {
      // Simulates what the REAL @ax/agents subscriber does (slice 2b): detach the
      // id everywhere when no live connector keeps it. This fake cannot run the
      // real plugin; the real detach is tested in @ax/agents
      // (connector-cleanup.test.ts).
      bus.subscribe<{ connectorId: string; idStillLive?: boolean }>(
        'connectors:deleted',
        'agents-stub',
        async (_ctx, payload) => {
          if (payload.idStillLive !== false) return undefined;
          agent.connectorAttachments = agent.connectorAttachments.filter((id) => id !== payload.connectorId);
          agent.connectorExclusions = agent.connectorExclusions.filter((id) => id !== payload.connectorId);
          return undefined;
        },
      );
      bus.registerService(
        'agents:resolve',
        'agents-stub',
        async (_ctx, input: { agentId: string; userId: string }) => {
          if (input.agentId !== AGENT_ID) {
            throw new PluginError({
              code: 'not-found',
              plugin: 'agents-stub',
              hookName: 'agents:resolve',
              message: 'no such agent',
            });
          }
          if (!agent.members.includes(input.userId)) {
            throw new PluginError({
              code: 'forbidden',
              plugin: 'agents-stub',
              hookName: 'agents:resolve',
              message: 'not a member',
            });
          }
          return {
            agent: {
              id: AGENT_ID,
              visibility: 'team',
              connectorAttachments: [...agent.connectorAttachments],
              connectorExclusions: [...agent.connectorExclusions],
            },
          };
        },
      );
    },
  };
}

function memStorage(): Plugin {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: ['storage:get', 'storage:set', 'storage:list-prefix', 'storage:delete-prefix'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService('storage:get', 'mem-storage', async (_c, { key }: { key: string }) => ({
        value: store.get(key),
      }));
      bus.registerService(
        'storage:set',
        'mem-storage',
        async (_c, { key, value }: { key: string; value: Uint8Array }) => {
          store.set(key, value);
        },
      );
      bus.registerService('storage:list-prefix', 'mem-storage', async (_c, { prefix }: { prefix: string }) => {
        const entries: Array<{ key: string; value: Uint8Array }> = [];
        for (const [key, value] of store) if (key.startsWith(prefix)) entries.push({ key, value });
        return { entries };
      });
      bus.registerService('storage:delete-prefix', 'mem-storage', async (_c, { prefix }: { prefix: string }) => {
        let deleted = 0;
        for (const key of [...store.keys()]) {
          if (key.startsWith(prefix)) {
            store.delete(key);
            deleted++;
          }
        }
        return { deleted };
      });
    },
  };
}

async function makeHarness(opts: { withAgents?: boolean } = {}): Promise<TestHarness> {
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      memStorage(),
      createCredentialsStoreDbPlugin(),
      createCredentialsPlugin(),
      createConnectorsPlugin(),
      ...(opts.withAgents === false ? [] : [agentsStub()]),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  savedCredentialsKey = process.env.AX_CREDENTIALS_KEY;
  process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS connectors_v1_connectors');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (savedCredentialsKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
  else process.env.AX_CREDENTIALS_KEY = savedCredentialsKey;
  if (container) await stopPostgresContainer(container);
});

/** The team's shared `linear` (owner `admin`), plus the team sign-in stored ON the agent. */
async function seedTeamConnector(h: TestHarness): Promise<void> {
  await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'admin' }), {
    userId: 'admin',
    connectorId: 'linear',
    name: 'Linear',
    keyMode: 'personal',
    visibility: 'shared',
    capabilities: {
      allowedHosts: ['mcp.linear.app'],
      credentials: [{ slot: 'API_TOKEN', kind: 'api-key' }],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
      services: [],
    },
  });
  await h.bus.call('credentials:set', h.ctx({ userId: 'admin' }), {
    scope: 'agent',
    ownerId: AGENT_ID,
    ref: REF,
    kind: 'api-key',
    payload: new TextEncoder().encode(TEAM_TOKEN),
  });
}

/** What the credential proxy does in a session on the agent. */
function readOnAgent(h: TestHarness, userId: string): Promise<string> {
  return h.bus.call<{ ref: string; userId: string }, string>(
    'credentials:get',
    h.ctx({ userId, agentId: AGENT_ID }),
    { ref: REF, userId },
  );
}

async function presentOnAgent(h: TestHarness, userId: string): Promise<boolean> {
  const out = await h.bus.call<{ ref: string; userId: string }, { present: boolean }>(
    'credentials:has',
    h.ctx({ userId, agentId: AGENT_ID }),
    { ref: REF, userId },
  );
  return out.present;
}

async function expectRefused(h: TestHarness, userId: string): Promise<void> {
  await expect(readOnAgent(h, userId)).rejects.toSatisfy(
    (err: unknown) => err instanceof PluginError && err.code === 'credential-not-found',
  );
  expect(await presentOnAgent(h, userId)).toBe(false);
}

describe('agent-scope connector credential needs the connector on the agent (TASK-788)', () => {
  it('allowed (positive control): the connector is ATTACHED, so every member reads the team sign-in', async () => {
    agent = { members: ['admin', 'bob'], connectorAttachments: ['linear'], connectorExclusions: [] };
    const h = await makeHarness();
    await seedTeamConnector(h);
    expect(await readOnAgent(h, 'bob')).toBe(TEAM_TOKEN);
    expect(await presentOnAgent(h, 'bob')).toBe(true);
    expect(await readOnAgent(h, 'admin')).toBe(TEAM_TOKEN);
  });

  it('refused: the connector was NEVER attached to the agent', async () => {
    agent = { members: ['admin', 'bob'], connectorAttachments: [], connectorExclusions: [] };
    const h = await makeHarness();
    await seedTeamConnector(h);
    await expectRefused(h, 'bob');
    await expectRefused(h, 'admin');
  });

  it('refused: the connector is DETACHED after the sign-in was stored', async () => {
    agent = { members: ['admin', 'bob'], connectorAttachments: ['linear'], connectorExclusions: [] };
    const h = await makeHarness();
    await seedTeamConnector(h);
    expect(await readOnAgent(h, 'bob')).toBe(TEAM_TOKEN);
    agent.connectorAttachments = [];
    await expectRefused(h, 'bob');
    // Re-attaching restores it: the row was never touched, only the gate.
    agent.connectorAttachments = ['linear'];
    expect(await readOnAgent(h, 'bob')).toBe(TEAM_TOKEN);
  });

  it('refused: the reader is not a member of the agent, even with the connector attached', async () => {
    agent = { members: ['admin'], connectorAttachments: ['linear'], connectorExclusions: [] };
    const h = await makeHarness();
    await seedTeamConnector(h);
    await expectRefused(h, 'eve');
  });

  it("legacy row: the OWNER's implicit reach counts, and an EXCLUSION removes it", async () => {
    agent = { members: ['admin', 'bob'], connectorAttachments: [], connectorExclusions: [] };
    const h = await makeHarness();
    await seedTeamConnector(h);
    // A pre-attachment row: reaches its owner's agents without an attachment.
    const pg = new (await import('pg')).default.Client({ connectionString });
    await pg.connect();
    try {
      await pg.query(
        "UPDATE connectors_v1_connectors SET requires_attachment = false WHERE connector_id = 'linear'",
      );
    } finally {
      await pg.end().catch(() => {});
    }
    expect(await readOnAgent(h, 'admin')).toBe(TEAM_TOKEN);
    // Not the owner: the legacy row reaches nobody else implicitly.
    await expectRefused(h, 'bob');
    agent.connectorExclusions = ['linear'];
    await expectRefused(h, 'admin');
  });

  it('refused (fail closed): no agents:resolve provider is loaded', async () => {
    agent = { members: ['admin', 'bob'], connectorAttachments: ['linear'], connectorExclusions: [] };
    const h = await makeHarness({ withAgents: false });
    await seedTeamConnector(h);
    await expectRefused(h, 'bob');
  });

  it("the sign-in WRITE-scope question (purpose 'store') does not need the attachment", async () => {
    agent = { members: ['admin', 'bob'], connectorAttachments: [], connectorExclusions: [] };
    const h = await makeHarness();
    await seedTeamConnector(h);
    const ask = (purpose?: 'store') =>
      h.bus.call<{ userId: string; agentId: string; ref: string; purpose?: 'store' }, { allowed: boolean }>(
        'credentials:authorize-agent:account',
        h.ctx({ userId: 'admin' }),
        { userId: 'admin', agentId: AGENT_ID, ref: REF, ...(purpose ? { purpose } : {}) },
      );
    expect(await ask('store')).toEqual({ allowed: true });
    expect(await ask()).toEqual({ allowed: false });
  });
});

// ---------------------------------------------------------------------------
// Agent-owned sign-ins slice 1 — the purge across the real plugin boundary:
// connectors:delete → credentials:purge-account → the real vault. A spy on the
// purge hook cannot catch contract drift (purge.ts swallows a rejected call);
// this does, by reading the agent's row back after a same-id re-upsert.
// ---------------------------------------------------------------------------
describe('deleting a shared connector purges agents\' sign-ins in the real vault (slice 1)', () => {
  async function deleteAndRecreate(h: TestHarness, purgeGlobal: boolean): Promise<void> {
    const del = await h.bus.call<
      { userId: string; connectorId: string; purgeGlobal?: boolean },
      { deleted: boolean }
    >('connectors:delete', h.ctx({ userId: 'admin' }), {
      userId: 'admin',
      connectorId: 'linear',
      ...(purgeGlobal ? { purgeGlobal: true } : {}),
    });
    expect(del.deleted).toBe(true);
    // A later connector re-uses the id (same owner, same shape).
    await h.bus.call<UpsertInput, UpsertOutput>('connectors:upsert', h.ctx({ userId: 'admin' }), {
      userId: 'admin',
      connectorId: 'linear',
      name: 'Linear',
      keyMode: 'personal',
      visibility: 'shared',
      capabilities: {
        allowedHosts: ['mcp.linear.app'],
        credentials: [{ slot: 'API_TOKEN', kind: 'api-key' }],
        mcpServers: [],
        packages: { npm: [], pypi: [] },
        services: [],
      },
    });
  }

  it('an admin delete (purgeGlobal) tombstones the agent row: a re-upserted same-id connector cannot read it', async () => {
    agent = { members: ['admin', 'bob'], connectorAttachments: ['linear'], connectorExclusions: [] };
    const h = await makeHarness();
    await seedTeamConnector(h);
    expect(await readOnAgent(h, 'bob')).toBe(TEAM_TOKEN);
    await deleteAndRecreate(h, true);
    await expectRefused(h, 'bob');
    await expectRefused(h, 'admin');
  });

  it('a delete WITHOUT purgeGlobal still detaches the agent: a same-id re-upsert cannot read the old token', async () => {
    agent = { members: ['admin', 'bob'], connectorAttachments: ['linear'], connectorExclusions: [] };
    const h = await makeHarness();
    await seedTeamConnector(h);
    expect(await readOnAgent(h, 'bob')).toBe(TEAM_TOKEN);
    await deleteAndRecreate(h, false);
    // The old row survives (no purge authority), but the delete detached the
    // agent (simulated by the stub's connectors:deleted subscriber, as the real
    // @ax/agents one does), so the re-created connector is not attached to it.
    expect(agent.connectorAttachments).toEqual([]);
    await expectRefused(h, 'bob');
    await expectRefused(h, 'admin');
  });
});
