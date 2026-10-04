import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  createTestHarness,
  stopPostgresContainer,
  startTestContainer,
  type TestHarness,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  createMemoryEgressAllowlistStore,
  createMemoryVerdictStore,
  createToolPolicyPlugin,
} from '@ax/tool-policy';
import { createAgentsPlugin } from '../plugin.js';
import type {
  Actor,
  Agent,
  AttachConnectorInput,
  AttachConnectorOutput,
  CreateInput,
  CreateOutput,
} from '../types.js';

/**
 * TASK-737 — attaching a connector copies its per-tool defaults
 * (design decision 2). Real @ax/agents on Postgres + real @ax/tool-policy;
 * `connectors:resolve` is stubbed to hand out a namespace per connector.
 *
 * The behaviour under test is the composition: what an agent is allowed to do
 * AFTER the connector's editor changes the defaults.
 */

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

const NS: Record<string, string> = { linear: 'c1111111111', gmail: 'c2222222222' };
const SEARCH = `mcp.${NS.linear}.search_issues`;
const CREATE = `mcp.${NS.linear}.create_issue`;
let resolveCalls: Array<{ userId: string; connectorId: string }> = [];

async function makeHarness(opts: { toolPolicy?: boolean } = {}): Promise<TestHarness> {
  const h = await createTestHarness({
    services: {
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => {
        throw new Error('not used');
      },
      'connectors:resolve': async (_ctx, input) => {
        const { userId, connectorId } = input as { userId: string; connectorId: string };
        resolveCalls.push({ userId, connectorId });
        const ns = NS[connectorId];
        if (ns === undefined) throw new Error(`connector '${connectorId}' not found`);
        return { keyMode: 'personal', toolNamespaces: [{ server: connectorId, toolNamespace: ns }] };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createAgentsPlugin(),
      ...(opts.toolPolicy === false
        ? []
        : [
            createToolPolicyPlugin({
              egressStore: createMemoryEgressAllowlistStore(),
              verdictStore: createMemoryVerdictStore(),
            }),
          ]),
    ],
  });
  harnesses.push(h);
  return h;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  resolveCalls = [];
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS agents_v1_agents');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const OWNER: Actor = { userId: 'owner1', isAdmin: false };
const ADMIN: Actor = { userId: 'admin1', isAdmin: true };

async function newAgent(h: TestHarness, name = 'Quill'): Promise<string> {
  const out = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId: OWNER.userId }), {
    actor: OWNER,
    input: {
      displayName: name,
      allowedTools: [],
      mcpConfigIds: [],
      model: 'anthropic/claude-opus-4-7',
      visibility: 'personal',
    },
  });
  return out.agent.id;
}

/** Attach each id in turn via `agents:attach-connector` (one id per call —
 *  the only write path, TASK-799); returns the agent after the last one. */
async function attach(
  h: TestHarness,
  agentId: string,
  connectorIds: string[],
  actor: Actor = OWNER,
): Promise<{ agent: Agent }> {
  let last: AttachConnectorOutput | undefined;
  for (const connectorId of connectorIds) {
    last = await h.bus.call<AttachConnectorInput, AttachConnectorOutput>(
      'agents:attach-connector',
      h.ctx({ userId: actor.userId }),
      { actor, agentId, connectorId },
    );
  }
  if (last === undefined) throw new Error('attach() needs at least one connector id');
  return { agent: last.agent };
}

async function setDefaults(h: TestHarness, verdicts: Array<{ toolKey: string; verdict: string | null }>) {
  const out = await h.bus.call<unknown, { ok: boolean }>(
    'tool-policy:set-connector-defaults',
    h.ctx({ userId: ADMIN.userId }),
    { connectorId: 'linear', verdicts },
  );
  expect(out.ok).toBe(true);
}

async function verdictOf(h: TestHarness, agentId: string, toolKey: string): Promise<string> {
  const r = await h.bus.call<unknown, { verdict: string }>(
    'tool-policy:evaluate',
    h.ctx({ agentId }),
    { call: { name: toolKey, input: {} }, agentId },
  );
  return r.verdict;
}

async function overrides(h: TestHarness, agentId: string) {
  const r = await h.bus.call<unknown, { overrides: Array<{ toolKey: string; verdict: string; origin: string }> }>(
    'tool-policy:list-agent-overrides',
    h.ctx(),
    { agentId },
  );
  return r.overrides.map(({ toolKey, verdict, origin }) => ({ toolKey, verdict, origin }));
}

describe('snapshot-on-attach (agents:attach-connector)', () => {
  it('attaching copies the connector defaults onto the agent', async () => {
    const h = await makeHarness();
    await setDefaults(h, [
      { toolKey: SEARCH, verdict: 'allow' },
      { toolKey: CREATE, verdict: 'hold' },
    ]);
    const agentId = await newAgent(h);
    await attach(h, agentId, ['linear']);

    expect(await overrides(h, agentId)).toEqual(
      expect.arrayContaining([
        { toolKey: SEARCH, verdict: 'allow', origin: 'snapshot' },
        { toolKey: CREATE, verdict: 'hold', origin: 'snapshot' },
      ]),
    );
    expect(await verdictOf(h, agentId, SEARCH)).toBe('allow');
    expect(await verdictOf(h, agentId, CREATE)).toBe('hold');
    // Resolved as the agent's owner (who its sessions resolve as). The
    // non-admin workspace-connector guard (TASK-739) resolves once more (as the
    // actor — here also the owner) before the write.
    expect(resolveCalls).toEqual([
      { userId: OWNER.userId, connectorId: 'linear' },
      { userId: OWNER.userId, connectorId: 'linear' },
    ]);
  });

  it('a later TIGHTENING by the editor applies to an agent that already has the connector', async () => {
    const h = await makeHarness();
    await setDefaults(h, [{ toolKey: SEARCH, verdict: 'allow' }]);
    const agentId = await newAgent(h);
    await attach(h, agentId, ['linear']);
    expect(await verdictOf(h, agentId, SEARCH)).toBe('allow');

    await setDefaults(h, [{ toolKey: SEARCH, verdict: 'deny' }]);
    expect(await verdictOf(h, agentId, SEARCH)).toBe('deny');
  });

  it('a later LOOSENING by the editor does not loosen an agent that already has the connector — even when it is attached again', async () => {
    const h = await makeHarness();
    await setDefaults(h, [{ toolKey: CREATE, verdict: 'hold' }]);
    const existing = await newAgent(h, 'Existing');
    await attach(h, existing, ['linear']);

    await setDefaults(h, [{ toolKey: CREATE, verdict: 'allow' }]);
    expect(await verdictOf(h, existing, CREATE)).toBe('hold');

    // Re-attaching it (alongside another connector) must not re-copy the
    // now-looser default over the attach-time copy.
    await attach(h, existing, ['linear', 'gmail']);
    expect(await verdictOf(h, existing, CREATE)).toBe('hold');

    // A NEW attach takes today's default.
    const fresh = await newAgent(h, 'Fresh');
    await attach(h, fresh, ['linear']);
    expect(await verdictOf(h, fresh, CREATE)).toBe('allow');
  });

  it('a tool with no default at attach stays Ask first after the editor first allows it; a tightening still applies (TASK-754)', async () => {
    // Was a KNOWN LIMIT under TASK-737: with nothing to copy, the tool
    // followed the live default, looser included. The copy now records the
    // namespace, and "no default when I attached" is kept as Ask first.
    const h = await makeHarness();
    const agentId = await newAgent(h);
    await attach(h, agentId, ['linear']);
    expect(await overrides(h, agentId)).toEqual([]);
    expect(await verdictOf(h, agentId, CREATE)).toBe('hold');

    await setDefaults(h, [{ toolKey: CREATE, verdict: 'allow' }]);
    expect(await verdictOf(h, agentId, CREATE)).toBe('hold');
    // An agent that never attached it follows the live default.
    const other = await newAgent(h, 'Other');
    expect(await verdictOf(h, other, CREATE)).toBe('allow');

    await setDefaults(h, [{ toolKey: CREATE, verdict: 'deny' }]);
    expect(await verdictOf(h, agentId, CREATE)).toBe('deny');
  });

  it('an admin attaching to someone else’s agent still resolves the connector as the agent owner', async () => {
    const h = await makeHarness();
    await setDefaults(h, [{ toolKey: SEARCH, verdict: 'allow' }]);
    const agentId = await newAgent(h);
    await attach(h, agentId, ['linear'], ADMIN);
    expect(resolveCalls).toEqual([{ userId: OWNER.userId, connectorId: 'linear' }]);
    expect(await overrides(h, agentId)).toEqual([
      { toolKey: SEARCH, verdict: 'allow', origin: 'snapshot' },
    ]);
  });

  it('a connector that does not resolve is still attached (the copy is skipped, not fatal)', async () => {
    const h = await makeHarness();
    const agentId = await newAgent(h);
    const out = await attach(h, agentId, ['dangling', 'linear']);
    expect(out.agent.connectorAttachments).toEqual(['dangling', 'linear']);
  });

  it('without tool-policy loaded, attaching works and copies nothing', async () => {
    const h = await makeHarness({ toolPolicy: false });
    const agentId = await newAgent(h);
    const out = await attach(h, agentId, ['linear']);
    expect(out.agent.connectorAttachments).toEqual(['linear']);
    // Only the workspace-connector guard's lookup (TASK-739) — no snapshot one.
    expect(resolveCalls).toEqual([{ userId: OWNER.userId, connectorId: 'linear' }]);
  });
});

// ---------------------------------------------------------------------------
// TASK-809 — an OAuth connector has NO admin per-tool ceiling, so at attach
// (the person has signed in, the tool inventory can be listed) each tool's
// starting per-agent verdict is seeded from the MCP server's hints:
// readOnly === true -> allow, anything else -> hold. Both `connectors:resolve`
// and `connectors:describe-tools` are stubbed; `tool-policy:snapshot-
// connector-for-agent` is a recording stub so the INPUT the agents plugin
// sends is what is asserted (tool-policy's own honouring of it is covered in
// its package).
// ---------------------------------------------------------------------------

interface SnapshotCall {
  agentId: string;
  connectorId: string;
  toolNamespaces: string[];
  startingVerdicts?: Array<{ toolKey: string; verdict: string }>;
}
interface DescribeCall {
  userId: string;
  agentId?: string;
  connectorId: string;
}
type DescribeTool = { toolKey: string; readOnly: boolean | null };

const OAUTH_NS = 'c3333333333';
const OTHER_NS = 'c4444444444';

describe('attach-time starting verdicts for OAuth connectors (TASK-809)', () => {
  let snapshotCalls: SnapshotCall[] = [];
  let describeCalls: DescribeCall[] = [];
  let describeImpl: () => Promise<{ status: string; tools: DescribeTool[]; checkedAt: string }>;

  const okTools: DescribeTool[] = [
    { toolKey: `mcp.${OAUTH_NS}.search_issues`, readOnly: true },
    { toolKey: `mcp.${OAUTH_NS}.create_issue`, readOnly: false },
    { toolKey: `mcp.${OAUTH_NS}.mystery`, readOnly: null },
    // Another connector's / namespace's key must never be seeded from this one.
    { toolKey: `mcp.${OTHER_NS}.search_issues`, readOnly: true },
    { toolKey: `mcp.${OAUTH_NS}x.search_issues`, readOnly: true },
  ];

  async function makeStubHarness(opts: { describeTools?: boolean } = {}): Promise<TestHarness> {
    const withDescribe = opts.describeTools !== false;
    const h = await createTestHarness({
      services: {
        'http:register-route': async () => ({ unregister: () => {} }),
        'auth:require-user': async () => {
          throw new Error('not used');
        },
        'connectors:resolve': async (_ctx, input) => {
          const { connectorId } = input as { userId: string; connectorId: string };
          if (connectorId === 'oauthy') {
            return {
              keyMode: 'personal',
              capabilities: {
                mcpServers: [{ name: 'oauthy' }],
                credentials: [{ slot: 'oauth', kind: 'oauth', server: 'oauthy' }],
              },
              toolNamespaces: [{ server: 'oauthy', toolNamespace: OAUTH_NS }],
            };
          }
          if (connectorId === 'keyed') {
            return {
              keyMode: 'personal',
              capabilities: {
                mcpServers: [{ name: 'keyed' }],
                credentials: [{ slot: 'api', kind: 'api-key', server: 'keyed' }],
              },
              toolNamespaces: [{ server: 'keyed', toolNamespace: OTHER_NS }],
            };
          }
          throw new Error(`connector '${connectorId}' not found`);
        },
        'tool-policy:snapshot-connector-for-agent': async (_ctx, input) => {
          snapshotCalls.push(input as SnapshotCall);
          return { ok: true };
        },
        ...(withDescribe
          ? {
              'connectors:describe-tools': async (_ctx, input) => {
                describeCalls.push(input as DescribeCall);
                return describeImpl();
              },
            }
          : {}),
      },
      plugins: [createDatabasePostgresPlugin({ connectionString }), createAgentsPlugin()],
    });
    harnesses.push(h);
    return h;
  }

  beforeEach(() => {
    snapshotCalls = [];
    describeCalls = [];
    describeImpl = async () => ({ status: 'ok', tools: okTools, checkedAt: new Date().toISOString() });
  });

  it('seeds readOnly true -> allow and false/null -> hold, scoped to the OAuth namespace', async () => {
    const h = await makeStubHarness();
    const agentId = await newAgent(h);
    await attach(h, agentId, ['oauthy']);

    // Asked as the person who attached, for this agent + connector.
    expect(describeCalls).toEqual([{ userId: OWNER.userId, agentId, connectorId: 'oauthy' }]);
    expect(snapshotCalls).toEqual([
      {
        agentId,
        connectorId: 'oauthy',
        toolNamespaces: [OAUTH_NS],
        startingVerdicts: [
          { toolKey: `mcp.${OAUTH_NS}.search_issues`, verdict: 'allow' },
          { toolKey: `mcp.${OAUTH_NS}.create_issue`, verdict: 'hold' },
          { toolKey: `mcp.${OAUTH_NS}.mystery`, verdict: 'hold' },
        ],
      },
    ]);
  });

  it('asks describe-tools as the ACTOR (an admin attaching to the owner’s agent), not the resolve user', async () => {
    const h = await makeStubHarness();
    const agentId = await newAgent(h);
    await attach(h, agentId, ['oauthy'], ADMIN);
    expect(describeCalls).toEqual([{ userId: ADMIN.userId, agentId, connectorId: 'oauthy' }]);
  });

  it('caps the seeded verdicts at 500', async () => {
    describeImpl = async () => ({
      status: 'ok',
      tools: Array.from({ length: 600 }, (_, i) => ({
        toolKey: `mcp.${OAUTH_NS}.tool_${i}`,
        readOnly: true,
      })),
      checkedAt: new Date().toISOString(),
    });
    const h = await makeStubHarness();
    const agentId = await newAgent(h);
    await attach(h, agentId, ['oauthy']);
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]!.startingVerdicts).toHaveLength(500);
  });

  it('an API-key connector never asks describe-tools and sends no startingVerdicts', async () => {
    const h = await makeStubHarness();
    const agentId = await newAgent(h);
    await attach(h, agentId, ['keyed']);
    expect(describeCalls).toEqual([]);
    expect(snapshotCalls).toEqual([{ agentId, connectorId: 'keyed', toolNamespaces: [OTHER_NS] }]);
    expect('startingVerdicts' in snapshotCalls[0]!).toBe(false);
  });

  it('describe-tools throwing still snapshots, without startingVerdicts', async () => {
    describeImpl = async () => {
      throw new Error('inventory exploded');
    };
    const h = await makeStubHarness();
    const agentId = await newAgent(h);
    const out = await attach(h, agentId, ['oauthy']);
    expect(out.agent.connectorAttachments).toEqual(['oauthy']);
    expect(describeCalls).toHaveLength(1);
    expect(snapshotCalls).toEqual([{ agentId, connectorId: 'oauthy', toolNamespaces: [OAUTH_NS] }]);
    expect('startingVerdicts' in snapshotCalls[0]!).toBe(false);
  });

  it.each(['needs-auth', 'unreachable', 'unknown'])(
    'status %s -> snapshot without startingVerdicts (tools are not trusted unless ok)',
    async (status) => {
      describeImpl = async () => ({ status, tools: okTools, checkedAt: new Date().toISOString() });
      const h = await makeStubHarness();
      const agentId = await newAgent(h);
      await attach(h, agentId, ['oauthy']);
      expect(describeCalls).toHaveLength(1);
      expect(snapshotCalls).toEqual([{ agentId, connectorId: 'oauthy', toolNamespaces: [OAUTH_NS] }]);
      expect('startingVerdicts' in snapshotCalls[0]!).toBe(false);
    },
  );

  it('an ok answer with no tools of the namespace omits startingVerdicts', async () => {
    describeImpl = async () => ({
      status: 'ok',
      tools: [{ toolKey: `mcp.${OTHER_NS}.search_issues`, readOnly: true }],
      checkedAt: new Date().toISOString(),
    });
    const h = await makeStubHarness();
    const agentId = await newAgent(h);
    await attach(h, agentId, ['oauthy']);
    expect(describeCalls).toHaveLength(1);
    expect(snapshotCalls).toEqual([{ agentId, connectorId: 'oauthy', toolNamespaces: [OAUTH_NS] }]);
    expect('startingVerdicts' in snapshotCalls[0]!).toBe(false);
  });

  it('without a describe-tools service the snapshot still happens, without startingVerdicts', async () => {
    const h = await makeStubHarness({ describeTools: false });
    const agentId = await newAgent(h);
    await attach(h, agentId, ['oauthy']);
    expect(describeCalls).toEqual([]);
    expect(snapshotCalls).toEqual([{ agentId, connectorId: 'oauthy', toolNamespaces: [OAUTH_NS] }]);
    expect('startingVerdicts' in snapshotCalls[0]!).toBe(false);
  });
});
