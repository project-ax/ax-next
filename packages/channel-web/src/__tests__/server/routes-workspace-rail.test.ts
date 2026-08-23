/**
 * The rail route (AW-14 / TASK-235) — the security surface's BFF.
 *
 * Three things these tests exist for, in order of how much they would cost to
 * get wrong:
 *
 *   1. THE ACL. `agent-activity:get` has none of its own — it answers for
 *      whatever agentId it is handed and says so on its own registration. This
 *      route is where the check lives, and "the hook was never even called for
 *      a foreign agent" is asserted rather than assumed.
 *   2. THE FENCE. Everything on this surface that a person did not write —
 *      an MCP vendor's description, a granted hostname out of a skill manifest,
 *      a routine name behind an activity phrase — is untrusted text rendered on
 *      a trust surface.
 *   3. NO SILENT EMPTIES. An empty array here is a claim about an agent's
 *      reach. "Nothing there", "no producer in this deployment" and "the read
 *      failed" are three different answers and the wire carries which.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import {
  ALL_DECISION_STATUSES,
  COUNTER_WINDOW_DAYS,
  RAIL_DESCRIPTION_MAX_CHARS,
  RAIL_LABEL_MAX_CHARS,
  inAgentScope,
  makeWorkspaceHandlers,
  parseMcpToolName,
  readGrantRef,
  toRailActivity,
  toWirePermission,
} from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';
import type { AgentRailData, DecisionStatus } from '../../lib/workspace-types.js';

function mkReq(params: Record<string, string> = {}, body?: unknown): RouteRequest {
  return {
    headers: {},
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf-8'),
    cookies: {},
    query: {},
    params,
    signedCookie: () => null,
  };
}

interface CapturedRes {
  statusCode: number;
  body: unknown;
}
function mkRes(): { res: RouteResponse; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text(_s: string) {
      /* unused */
    },
    end() {
      /* unused */
    },
  };
  return { res, captured };
}

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

/** The instant the tests pretend it is, so the counter window has a real edge. */
const NOW = new Date('2026-08-21T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function notFound(): PluginError {
  return new PluginError({ code: 'not-found', plugin: 'mock-agents', message: 'nope' });
}

/**
 * `source` -> the tool its rule matches, for the policy mock's `outOfReach`
 * filter. The real plugin holds this privately (`match.tool` never rides out on
 * a row); the mock needs its own copy to reproduce the same behaviour.
 */
const RULE_TOOL: Record<string, string> = {
  'rule:web.search': 'web_search',
  'rule:skills.request-capability': 'request_capability',
  'rule:sandbox.read': 'Read',
  'rule:builtins.task': 'Task',
};

interface AgentRecord {
  id: string;
  displayName: string;
  ownerId: string;
  allowedTools: string[];
  mcpConfigIds: string[];
  skillAttachments: Array<{ skillId: string }>;
  connectorAttachments: string[];
}

interface StoredDecisionLike {
  id: string;
  agentId: string;
  status: DecisionStatus;
  createdAt: string;
}

describe('GET /api/workspace/agents/:agentId/rail', () => {
  let bus: HookBus;
  let agents: Map<string, AgentRecord>;
  let activityCalls: string[];
  let activityByAgent: Map<string, unknown>;
  let catalog: Array<{ name: string; description?: string; executesIn?: string }>;
  let policyRows: unknown[];
  let policyThrows: Error | null;
  /** What the route last told the policy plugin this agent cannot reach. */
  let lastOutOfReach: string[] | null;
  let ruledTools: Map<string, { verdict: string; ruleId: string }>;
  let siteGrants: Map<string, Array<{ host: string; grantedAt: string }>>;
  let wallGrants: Map<string, Array<{ kind: string; value: string }>>;
  let revoked: unknown[];
  let decisions: StoredDecisionLike[];

  function handlers() {
    return makeWorkspaceHandlers({ bus, initCtx, now: () => NOW });
  }

  function agent(over: Partial<AgentRecord> & { id: string }): AgentRecord {
    return {
      displayName: 'Quill',
      ownerId: 'u1',
      allowedTools: [],
      mcpConfigIds: [],
      skillAttachments: [],
      connectorAttachments: [],
      ...over,
    };
  }

  function registerAuth(user: { id: string; isAdmin: boolean } | null): void {
    bus.registerService('auth:require-user', 'auth', async () => {
      if (user === null) {
        throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no' });
      }
      return { user };
    });
  }

  function registerPolicy(): void {
    bus.registerService('tool-policy:list-capabilities', 'policy', async (_c, i: unknown) => {
      if (policyThrows !== null) throw policyThrows;
      /*
        The real registrar applies `outOfReach` (@ax/tool-policy's
        `applyReach`). Mirrored here — a stub that ignored the field would let
        the scope test pass against a route that never sent it. The plugin's own
        tests pin the filter itself; this pins that the ROUTE asks for it.
      */
      const { outOfReach } = i as { outOfReach?: string[] };
      const unreachable = new Set(outOfReach ?? []);
      lastOutOfReach = outOfReach ?? null;
      return {
        rows: (policyRows as Array<Record<string, unknown>>).filter((r) => {
          if (r.verdict === 'deny') return true;
          const tool = RULE_TOOL[String(r.source)];
          return tool === undefined || !unreachable.has(tool);
        }),
      };
    });
    bus.registerService('tool-policy:evaluate', 'policy', async (_c, i: unknown) => {
      const { call } = i as { call: { name: string } };
      const ruled = ruledTools.get(call.name);
      return ruled === undefined
        ? { verdict: 'allow', ruleId: null, capability: null, irreversible: false }
        : { ...ruled, capability: 'x', irreversible: false };
    });
  }

  function registerCatalog(): void {
    bus.registerService('tool:list', 'catalog', async () => ({ tools: catalog }));
  }

  function registerActivity(): void {
    bus.registerService('agent-activity:get', 'activity', async (_c, i: unknown) => {
      const { agentId } = i as { agentId: string };
      activityCalls.push(agentId);
      return { activity: activityByAgent.get(agentId) ?? null };
    });
  }

  function registerGrants(): void {
    bus.registerService('host-grants:list', 'host-grants', async (_c, i: unknown) => {
      const { ownerUserId, agentId } = i as { ownerUserId: string; agentId: string };
      return { hosts: siteGrants.get(`${ownerUserId}/${agentId}`) ?? [] };
    });
    bus.registerService('host-grants:revoke', 'host-grants', async (_c, i: unknown) => {
      revoked.push(i);
      return { revoked: true };
    });
    bus.registerService('skills:approved-caps-list', 'skills', async (_c, i: unknown) => {
      const { ownerUserId, agentId, skillId, connectorId } = i as Record<string, string>;
      const key = `${ownerUserId}/${agentId}/${skillId ?? ''}/${connectorId ?? ''}`;
      return { capabilities: wallGrants.get(key) ?? [] };
    });
    bus.registerService('skills:approved-caps-revoke', 'skills', async (_c, i: unknown) => {
      revoked.push(i);
      return { cleared: true };
    });
  }

  function registerDecisions(): void {
    bus.registerService('decisions:list', 'decisions', async (_c, i: unknown) => {
      const { userId, agentId, status } = i as {
        userId: string;
        agentId?: string;
        status?: DecisionStatus;
      };
      expect(userId).toBe('u1');
      return {
        decisions: decisions.filter(
          (d) =>
            (agentId === undefined || d.agentId === agentId) &&
            (status === undefined || d.status === status),
        ),
      };
    });
  }

  async function railFor(agentId = 'a1'): Promise<CapturedRes> {
    const { res, captured } = mkRes();
    await handlers().rail(mkReq({ agentId }), res);
    return captured;
  }

  beforeEach(() => {
    bus = new HookBus();
    agents = new Map([['a1', agent({ id: 'a1' })]]);
    activityCalls = [];
    activityByAgent = new Map();
    catalog = [];
    policyRows = [];
    policyThrows = null;
    lastOutOfReach = null;
    ruledTools = new Map();
    siteGrants = new Map();
    wallGrants = new Map();
    revoked = [];
    decisions = [];

    bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
      const { agentId, userId } = i as { agentId: string; userId: string };
      const row = agents.get(agentId);
      if (row === undefined || row.ownerId !== userId) throw notFound();
      return { agent: row };
    });
    registerAuth({ id: 'u1', isAdmin: false });
  });

  // -------------------------------------------------------------------------
  // The ACL. This is the whole reason the route exists in this shape.
  // -------------------------------------------------------------------------

  it('401s an unauthenticated caller', async () => {
    bus = new HookBus();
    registerAuth(null);
    const { res, captured } = mkRes();
    await handlers().rail(mkReq({ agentId: 'a1' }), res);
    expect(captured.statusCode).toBe(401);

    const second = mkRes();
    await handlers().revokeGrant(
      mkReq({ agentId: 'a1' }, { ref: { grant: 'site', host: 'x' } }),
      second.res,
    );
    expect(second.captured.statusCode).toBe(401);
  });

  it('404s another user’s agent and never reaches the un-ACLd activity hook', async () => {
    agents.set('a-theirs', agent({ id: 'a-theirs', ownerId: 'u2' }));
    registerActivity();

    const captured = await railFor('a-theirs');
    expect(captured.statusCode).toBe(404);
    // The point of the assertion: `agent-activity:get` answers for whatever id
    // it is handed. If this route ever calls it before `agents:resolve`, one
    // user reads another user's agent's activity line.
    expect(activityCalls).toEqual([]);
  });

  it('404s a revoke against another user’s agent before touching any writer', async () => {
    agents.set('a-theirs', agent({ id: 'a-theirs', ownerId: 'u2' }));
    registerGrants();
    const { res, captured } = mkRes();
    await handlers().revokeGrant(
      mkReq({ agentId: 'a-theirs' }, { ref: { grant: 'site', host: 'api.evil.test' } }),
      res,
    );
    expect(captured.statusCode).toBe(404);
    expect(revoked).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // "What it may do alone"
  // -------------------------------------------------------------------------

  it('groups allow first, then hold, then deny', async () => {
    registerPolicy();
    policyRows = [
      { verdict: 'deny', capability: 'delete anything', source: 'rule:d', provenance: 'rule', described: true },
      { verdict: 'allow', capability: 'search the web', source: 'rule:a', provenance: 'catalog', described: true },
      { verdict: 'hold', capability: 'write to a customer', source: 'rule:h', provenance: 'rule', described: true },
    ];
    const captured = await railFor();
    const body = captured.body as AgentRailData;
    expect(body.permissions.rows.map((r) => r.verdict)).toEqual(['allow', 'hold', 'deny']);
  });

  it('renders an MCP tool mechanically, never from its own description', async () => {
    registerPolicy();
    registerCatalog();
    catalog = [
      {
        name: 'mcp.linear.create_issue',
        description: 'Creates an issue in Linear',
        executesIn: 'host',
      },
    ];
    ruledTools.set('mcp.linear.create_issue', { verdict: 'hold', ruleId: null as never });
    // `ruleId: null` above would mean "no rule"; make it explicit instead.
    ruledTools.set('mcp.linear.create_issue', {
      verdict: 'hold',
      ruleId: null as unknown as string,
    });

    const body = (await railFor()).body as AgentRailData;
    const row = body.permissions.rows.find((r) => r.provenance === 'mcp');
    expect(row).toBeDefined();
    expect(row?.described).toBe(false);
    expect(row?.capability).toBe('');
    expect(row?.mechanicalLabel).toBe('mcp.linear.create_issue');
    expect(row?.theirDescription).toBe('Creates an issue in Linear');
    expect(row?.theirName).toBe('linear');
    expect(row?.verdict).toBe('hold');
  });

  it('renders an unmapped capability explicitly rather than omitting it (H4)', async () => {
    registerPolicy();
    registerCatalog();
    catalog = [{ name: 'some_unmapped_tool', executesIn: 'host' }];

    const body = (await railFor()).body as AgentRailData;
    const row = body.permissions.rows.find((r) => r.source === 'tool:some_unmapped_tool');
    expect(row).toMatchObject({
      described: false,
      provenance: 'unmapped',
      mechanicalLabel: 'some_unmapped_tool',
      // A native tool's `description` is written to steer an LLM. It is never
      // promoted into a claim about reach.
      theirDescription: null,
    });
  });

  it('does not double-list a tool a rule already describes', async () => {
    registerPolicy();
    registerCatalog();
    policyRows = [
      { verdict: 'allow', capability: 'search the web', source: 'rule:web.search', provenance: 'catalog', described: true },
    ];
    catalog = [{ name: 'web_search', executesIn: 'host' }];
    ruledTools.set('web_search', { verdict: 'allow', ruleId: 'web.search' });

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions.rows).toHaveLength(1);
    expect(body.permissions.rows[0]?.described).toBe(true);
  });

  it('does not render an authored skill as a rail row of its own', async () => {
    /*
      Authored skills are zero-reach by construction: a skill manifest declares
      no capabilities, only connectors it references, and a connector's reach is
      gated at connectors:resolve. The connector rows already cover it. A
      pleasant property from TASK-100, worth not losing.
    */
    registerPolicy();
    registerCatalog();
    registerGrants();
    agents.set(
      'a1',
      agent({ id: 'a1', skillAttachments: [{ skillId: 'inbox-triage' }] }),
    );
    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions.rows.some((r) => r.source.startsWith('skill:'))).toBe(false);
  });

  it('scopes catalog rows to the agent, and flags the wildcard scope', async () => {
    registerPolicy();
    registerCatalog();
    catalog = [
      { name: 'web_search', executesIn: 'host' },
      { name: 'mcp.linear.create_issue', executesIn: 'host' },
      { name: 'mcp.other.thing', executesIn: 'host' },
    ];

    // Unrestricted: everything, and the surface says the list is not a limit.
    let body = (await railFor()).body as AgentRailData;
    expect(body.permissions.unrestrictedTools).toBe(true);
    expect(body.permissions.rows).toHaveLength(3);

    // Restricted: only what this agent's own scope lets it see.
    agents.set(
      'a1',
      agent({ id: 'a1', allowedTools: ['web_search'], mcpConfigIds: ['linear'] }),
    );
    body = (await railFor()).body as AgentRailData;
    expect(body.permissions.unrestrictedTools).toBe(false);
    expect(body.permissions.rows.map((r) => r.mechanicalLabel).sort()).toEqual([
      'mcp.linear.create_issue',
      'web_search',
    ]);
  });

  it('never asserts reach an agent’s tool scope excludes', async () => {
    /*
      THE REGRESSION. `tool-policy:list-capabilities` returns the GLOBAL rule
      table — it describes what the product enforces, not what this agent is
      wired to reach. Rendered unfiltered, an agent scoped to `['Read']` is told
      "Can search the web — on its own" about a tool it cannot call: a false
      ALLOW claim on the blast-radius surface, which is the one direction design
      H3/H4 says never to be wrong in.

      The earlier scope test could not catch this — it ran with an EMPTY rule
      table, so there was no described row to be wrong about.
    */
    registerPolicy();
    registerCatalog();
    policyRows = [
      { verdict: 'allow', capability: 'search the web', source: 'rule:web.search', provenance: 'catalog', described: true },
      { verdict: 'allow', capability: 'read files in its own workspace', source: 'rule:sandbox.read', provenance: 'catalog', described: true },
      { verdict: 'hold', capability: 'gain access to a new service or key', source: 'rule:skills.request-capability', provenance: 'rule', described: true },
      { verdict: 'deny', capability: 'start a hidden helper agent', source: 'rule:builtins.task', provenance: 'rule', described: true },
    ];
    catalog = [
      { name: 'web_search', executesIn: 'host' },
      { name: 'request_capability', executesIn: 'host' },
    ];
    ruledTools.set('web_search', { verdict: 'allow', ruleId: 'web.search' });
    ruledTools.set('request_capability', {
      verdict: 'hold',
      ruleId: 'skills.request-capability',
    });
    agents.set('a1', agent({ id: 'a1', allowedTools: ['Read'], mcpConfigIds: [] }));

    const body = (await railFor()).body as AgentRailData;
    const sources = body.permissions.rows.map((r) => r.source);

    // Both reach claims for host tools this agent cannot call are GONE.
    expect(sources).not.toContain('rule:web.search');
    expect(sources).not.toContain('rule:skills.request-capability');
    // The deny stays. A deny for a tool it could not reach anyway is still
    // true, and it is reassurance rather than reach — dropping it would
    // understate our restrictions, which costs information and endangers
    // nobody. An allow it cannot reach is the lie.
    expect(sources).toContain('rule:builtins.task');
    // And a SANDBOX built-in's row survives: `Read` is registered by the
    // runner, not by the host catalog, so its absence from the catalog proves
    // nothing about reach and it is never subtracted.
    expect(sources).toContain('rule:sandbox.read');
  });

  it('sends the scope subtraction to the policy plugin, not just to its own rows', async () => {
    registerPolicy();
    registerCatalog();
    catalog = [
      { name: 'web_search', executesIn: 'host' },
      { name: 'memory_search', executesIn: 'host' },
    ];
    agents.set('a1', agent({ id: 'a1', allowedTools: ['web_search'], mcpConfigIds: [] }));
    await railFor();
    expect(lastOutOfReach).toEqual(['memory_search']);
  });

  it('drops nothing for an unrestricted agent', async () => {
    registerPolicy();
    registerCatalog();
    policyRows = [
      { verdict: 'allow', capability: 'search the web', source: 'rule:web.search', provenance: 'catalog', described: true },
    ];
    catalog = [{ name: 'web_search', executesIn: 'host' }];
    ruledTools.set('web_search', { verdict: 'allow', ruleId: 'web.search' });

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions.rows.map((r) => r.source)).toContain('rule:web.search');
    expect(body.permissions.unrestrictedTools).toBe(true);
  });

  it('drops nothing when the catalog could not be read — overstating is the survivable direction', async () => {
    registerPolicy();
    // Registered, and it throws: we have PROVED nothing about what this agent
    // cannot reach, so no reach claim is subtracted and the list says it may be
    // incomplete rather than quietly getting shorter.
    bus.registerService('tool:list', 'catalog', async () => {
      throw new Error('catalog down');
    });
    policyRows = [
      { verdict: 'allow', capability: 'search the web', source: 'rule:web.search', provenance: 'catalog', described: true },
    ];
    agents.set('a1', agent({ id: 'a1', allowedTools: ['Read'], mcpConfigIds: [] }));

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions.rows.map((r) => r.source)).toContain('rule:web.search');
    expect(body.permissions.incomplete).toBe(true);
  });

  it('tells "no producer" apart from "read failed" apart from "nothing there"', async () => {
    // No @ax/tool-policy at all.
    let body = (await railFor()).body as AgentRailData;
    expect(body.permissions).toMatchObject({ status: 'unavailable', rows: [], incomplete: true });

    // Registered, but it threw.
    bus = new HookBus();
    beforeEachBusReset();
    registerPolicy();
    policyThrows = new Error('boom');
    body = (await railFor()).body as AgentRailData;
    expect(body.permissions).toMatchObject({ status: 'failed', rows: [], incomplete: true });

    // Registered and answering, with genuinely nothing to say.
    policyThrows = null;
    body = (await railFor()).body as AgentRailData;
    expect(body.permissions).toMatchObject({ status: 'ok', rows: [] });
  });

  it('marks the list incomplete when the catalog cannot be read', async () => {
    registerPolicy();
    // No `tool:list` registered: the described rows are still true, but they
    // are no longer the whole answer, and a short list must not read as a short
    // leash.
    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions.status).toBe('ok');
    expect(body.permissions.incomplete).toBe(true);
  });

  function beforeEachBusReset(): void {
    bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
      const { agentId, userId } = i as { agentId: string; userId: string };
      const row = agents.get(agentId);
      if (row === undefined || row.ownerId !== userId) throw notFound();
      return { agent: row };
    });
    registerAuth({ id: 'u1', isAdmin: false });
  }

  // -------------------------------------------------------------------------
  // "Granted by you"
  // -------------------------------------------------------------------------

  it('separates "Granted by you" from built-in rules', async () => {
    registerPolicy();
    registerGrants();
    siteGrants.set('u1/a1', [
      { host: 'api.linear.app', grantedAt: '2026-08-14T09:00:00.000Z' },
    ]);
    const body = (await railFor()).body as AgentRailData;
    expect(body.grants.rows.map((g) => g.source)).toEqual(['grant:api.linear.app']);
    expect(body.grants.rows[0]).toMatchObject({
      verdict: 'allow',
      action: 'reach',
      label: 'api.linear.app',
      provenance: 'grant',
      revocable: true,
      ref: { grant: 'site', host: 'api.linear.app' },
    });
  });

  it('reads the approved-capability wall once per skill and once per connection', async () => {
    registerPolicy();
    registerGrants();
    agents.set(
      'a1',
      agent({
        id: 'a1',
        skillAttachments: [{ skillId: 'inbox-triage' }],
        connectorAttachments: ['linear'],
      }),
    );
    wallGrants.set('u1/a1/inbox-triage/', [{ kind: 'npm', value: 'left-pad' }]);
    wallGrants.set('u1/a1//linear', [{ kind: 'host', value: 'api.linear.app' }]);

    const body = (await railFor()).body as AgentRailData;
    expect(body.grants.rows.map((g) => g.label).sort()).toEqual([
      'api.linear.app',
      'left-pad',
    ]);
    const pkg = body.grants.rows.find((g) => g.label === 'left-pad');
    expect(pkg).toMatchObject({
      action: 'install the npm package',
      grantedFor: { kind: 'skill', id: 'inbox-triage' },
      ref: {
        grant: 'approved-capability',
        capKind: 'npm',
        value: 'left-pad',
        skillId: 'inbox-triage',
        connectorId: null,
      },
    });
  });

  it('shows one row per granted thing, not one per record', async () => {
    registerPolicy();
    registerGrants();
    agents.set('a1', agent({ id: 'a1', connectorAttachments: ['linear'] }));
    siteGrants.set('u1/a1', [{ host: 'api.linear.app', grantedAt: '2026-08-14T09:00:00.000Z' }]);
    wallGrants.set('u1/a1//linear', [{ kind: 'host', value: 'api.linear.app' }]);

    const body = (await railFor()).body as AgentRailData;
    expect(body.grants.rows).toHaveLength(1);
  });

  it('says a grant read failed rather than reporting no grants', async () => {
    registerPolicy();
    bus.registerService('host-grants:list', 'host-grants', async () => {
      throw new Error('db down');
    });
    const body = (await railFor()).body as AgentRailData;
    expect(body.grants).toMatchObject({ status: 'failed', rows: [] });
  });

  /*
    The wall half must never speak for the site half. An agent with no skills
    and no connections has nothing to ask the wall about, and that vacuous
    "nothing to read" used to count as a successful read for the WHOLE section
    — so a `host-grants:list` that threw landed under "you haven't granted
    anything", which is a claim we had just failed to check (H7).
  */
  it('says failed when the site read throws and the agent has no wall subjects', async () => {
    registerPolicy();
    bus.registerService('host-grants:list', 'host-grants', async () => {
      throw new Error('db down');
    });
    bus.registerService('skills:approved-caps-list', 'skills', async () => ({
      capabilities: [],
    }));
    // a1 carries no skillAttachments and no connectorAttachments: the wall is
    // never asked anything.
    const body = (await railFor()).body as AgentRailData;
    expect(body.grants.status).toBe('failed');
  });

  it('says failed when the site read throws even though the wall answered', async () => {
    registerPolicy();
    agents.set('a1', agent({ id: 'a1', skillAttachments: [{ skillId: 'inbox-triage' }] }));
    bus.registerService('host-grants:list', 'host-grants', async () => {
      throw new Error('db down');
    });
    bus.registerService('skills:approved-caps-list', 'skills', async () => ({
      capabilities: [{ kind: 'npm', value: 'left-pad' }],
    }));
    const body = (await railFor()).body as AgentRailData;
    // Half an answer is not an answer. The rows we did read cannot make the
    // section's status true, because the reader would be reading a list that
    // silently omits every site grant.
    expect(body.grants.status).toBe('failed');
  });

  it('still reports a genuinely empty grant set as ok', async () => {
    // The other direction, and the reason this is not just "always failed":
    // every producer answered, and both said nothing. "You have granted this
    // agent nothing" is then a claim we are entitled to make.
    registerPolicy();
    registerGrants();
    const body = (await railFor()).body as AgentRailData;
    expect(body.grants).toMatchObject({ status: 'ok', rows: [], incomplete: false });
  });

  it('offers no revoke control when this deployment has no writer for it', async () => {
    registerPolicy();
    bus.registerService('host-grants:list', 'host-grants', async () => ({
      hosts: [{ host: 'api.linear.app', grantedAt: '2026-08-14T09:00:00.000Z' }],
    }));
    const body = (await railFor()).body as AgentRailData;
    expect(body.grants.rows[0]?.revocable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // "This week"
  // -------------------------------------------------------------------------

  it('"Brought to you" counts decisions created in the window, any status', async () => {
    registerPolicy();
    registerDecisions();
    decisions = [
      { id: 'd1', agentId: 'a1', status: 'pending', createdAt: iso(-1) },
      { id: 'd2', agentId: 'a1', status: 'dismissed', createdAt: iso(-2) },
      { id: 'd3', agentId: 'a1', status: 'expired', createdAt: iso(-3) },
      { id: 'd4', agentId: 'a1', status: 'executed', createdAt: iso(-6) },
      // Another agent's row must not land on this agent's number.
      { id: 'd5', agentId: 'a2', status: 'pending', createdAt: iso(-1) },
    ];
    const body = (await railFor()).body as AgentRailData;
    expect(body.counters.status).toBe('ok');
    expect(body.counters.rows).toHaveLength(1);
    expect(body.counters.rows[0]).toMatchObject({ id: 'brought-to-you', value: 4 });
    expect(body.counters.rows[0]?.definition).toMatch(/last 7 days/);
    expect(body.counters.windowDays).toBe(COUNTER_WINDOW_DAYS);
  });

  it('a decision created and then expired still counts as brought to you', async () => {
    registerPolicy();
    registerDecisions();
    decisions = [{ id: 'd1', agentId: 'a1', status: 'expired', createdAt: iso(-1) }];
    const body = (await railFor()).body as AgentRailData;
    expect(body.counters.rows[0]?.value).toBe(1);
  });

  it('drops anything older than the window', async () => {
    registerPolicy();
    registerDecisions();
    decisions = [
      { id: 'old', agentId: 'a1', status: 'executed', createdAt: iso(-8) },
      { id: 'edge', agentId: 'a1', status: 'executed', createdAt: iso(-7) },
    ];
    const body = (await railFor()).body as AgentRailData;
    // Exactly seven days back is inside the window; eight is not.
    expect(body.counters.rows[0]?.value).toBe(1);
  });

  it('ships NO counter it has no source for — a zero would be a claim', async () => {
    registerPolicy();
    registerDecisions();
    const body = (await railFor()).body as AgentRailData;
    const ids = body.counters.rows.map((r) => r.id);
    // "Handled on its own" counts allow-verdict tool calls: nothing counts
    // them. "You overruled it" is dismissals PLUS undone executions, and an
    // undo restores the row to `pending` leaving no trace — so the second half
    // is not derivable and the row waits for a real source.
    expect(ids).not.toContain('handled-alone');
    expect(ids).not.toContain('overruled');
  });

  it('says the counter read failed rather than showing a zero', async () => {
    registerPolicy();
    bus.registerService('decisions:list', 'decisions', async () => {
      throw new Error('db down');
    });
    const body = (await railFor()).body as AgentRailData;
    expect(body.counters).toMatchObject({ status: 'failed', rows: [] });
  });

  it('walks every status the wire union declares', () => {
    // A status added to @ax/decisions and not added here would silently
    // UNDERCOUNT, which on this row means quietly claiming an agent bothered
    // you less than it did.
    const declared: DecisionStatus[] = [
      'pending',
      'executed',
      'approved-pending-agent',
      'dismissed',
      'stale',
      'expired',
      'failed',
    ];
    expect([...ALL_DECISION_STATUSES].sort()).toEqual([...declared].sort());
  });

  // -------------------------------------------------------------------------
  // "Right now"
  // -------------------------------------------------------------------------

  it('carries the activity line, fenced', async () => {
    registerPolicy();
    registerActivity();
    activityByAgent.set('a1', {
      phrase: 'Reading email',
      counter: { done: 29, total: 41, unit: 'messages' },
      startedAt: '2026-08-21T11:54:00.000Z',
      source: 'tool',
      stale: false,
    });
    const body = (await railFor()).body as AgentRailData;
    expect(body.activity).toEqual({
      status: 'ok',
      activity: {
        phrase: 'Reading email',
        counter: { done: 29, total: 41, unit: 'messages' },
        startedAt: '2026-08-21T11:54:00.000Z',
        stale: false,
        source: 'tool',
      },
    });
  });

  it('tells an absent activity producer apart from a failed read', async () => {
    registerPolicy();
    let body = (await railFor()).body as AgentRailData;
    expect(body.activity).toEqual({ status: 'unavailable', activity: null });

    bus.registerService('agent-activity:get', 'activity', async () => {
      throw new Error('boom');
    });
    body = (await railFor()).body as AgentRailData;
    expect(body.activity).toEqual({ status: 'failed', activity: null });
  });

  // -------------------------------------------------------------------------
  // Revoking
  // -------------------------------------------------------------------------

  it('revokes a site grant through the grant record', async () => {
    registerGrants();
    const { res, captured } = mkRes();
    await handlers().revokeGrant(
      mkReq({ agentId: 'a1' }, { ref: { grant: 'site', host: 'api.linear.app' } }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ revoked: true });
    expect(revoked).toEqual([
      { ownerUserId: 'u1', agentId: 'a1', host: 'api.linear.app' },
    ]);
  });

  it('revokes an approved capability against its own subject', async () => {
    registerGrants();
    const { res } = mkRes();
    await handlers().revokeGrant(
      mkReq(
        { agentId: 'a1' },
        {
          ref: {
            grant: 'approved-capability',
            capKind: 'npm',
            value: 'left-pad',
            skillId: 'inbox-triage',
            connectorId: null,
          },
        },
      ),
      res,
    );
    expect(revoked).toEqual([
      {
        ownerUserId: 'u1',
        agentId: 'a1',
        kind: 'npm',
        value: 'left-pad',
        skillId: 'inbox-triage',
      },
    ]);
  });

  it('400s a ref it cannot read, and never guesses at what to delete', async () => {
    registerGrants();
    for (const ref of [
      undefined,
      null,
      'api.linear.app',
      { grant: 'site' },
      { grant: 'site', host: '' },
      { grant: 'approved-capability', capKind: 'nope', value: 'x', skillId: 's' },
      { grant: 'approved-capability', capKind: 'npm', value: '', skillId: 's' },
      // Both subjects, or neither: the store's key needs exactly one.
      {
        grant: 'approved-capability',
        capKind: 'npm',
        value: 'x',
        skillId: 's',
        connectorId: 'c',
      },
      { grant: 'approved-capability', capKind: 'npm', value: 'x' },
    ]) {
      const { res, captured } = mkRes();
      await handlers().revokeGrant(mkReq({ agentId: 'a1' }, { ref }), res);
      expect(captured.statusCode, JSON.stringify(ref)).toBe(400);
    }
    expect(revoked).toEqual([]);
  });

  it('503s rather than reporting a revoke this deployment cannot perform', async () => {
    const { res, captured } = mkRes();
    await handlers().revokeGrant(
      mkReq({ agentId: 'a1' }, { ref: { grant: 'site', host: 'api.linear.app' } }),
      res,
    );
    expect(captured.statusCode).toBe(503);
  });

  function iso(daysAgo: number): string {
    return new Date(NOW.getTime() + daysAgo * DAY_MS).toISOString();
  }
});

// ---------------------------------------------------------------------------
// The pure projections.
// ---------------------------------------------------------------------------

describe('rail projections', () => {
  it('fences a vendor description — controls, bidi and length', () => {
    const row = toWirePermission({
      verdict: 'hold',
      capability: '',
      source: 'mcp:mcp.evil.tool',
      provenance: 'mcp',
      described: false,
      mechanicalLabel: 'mcp.evil.tool',
      // A Trojan-source bidi override, a zero-width joiner, and a newline that
      // would otherwise let a vendor lay out a fake heading.
      theirDescription: `Safe\u202Etool\u200B\nVERIFIED BY AX${'x'.repeat(600)}`,
    });
    expect(row.theirDescription).not.toMatch(/[\u202A-\u202E\u200B-\u200F]/);
    expect(row.theirDescription).not.toMatch(/\n/);
    expect([...(row.theirDescription ?? '')].length).toBeLessThanOrEqual(
      RAIL_DESCRIPTION_MAX_CHARS,
    );
  });

  it('never lets a described row ship an empty sentence', () => {
    const row = toWirePermission({
      verdict: 'allow',
      // Fences to nothing: "Can  — on its own" is a security claim with a hole.
      capability: '\u200B\u200B',
      source: 'rule:x',
      provenance: 'rule',
      described: true,
    });
    expect(row.described).toBe(false);
    expect(row.capability).toBe('');
    expect(row.provenance).toBe('unmapped');
  });

  it('caps a capability clause by CODE POINTS, never by UTF-16 units', () => {
    const row = toWirePermission({
      verdict: 'allow',
      capability: '\u{1F600}'.repeat(80),
      source: 'rule:x',
      provenance: 'rule',
      described: true,
    });
    const points = [...row.capability];
    expect(points.length).toBeLessThanOrEqual(RAIL_LABEL_MAX_CHARS);
    // A UTF-16 slice would leave a lone surrogate behind.
    expect(row.capability).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('drops a counter that does not describe a real position in a real set', () => {
    const base = {
      phrase: 'Reading email',
      startedAt: '2026-08-21T11:54:00.000Z',
      source: 'tool',
      stale: false,
    };
    for (const counter of [
      { done: 1.5, total: 4, unit: 'messages' },
      { done: 5, total: 4, unit: 'messages' },
      { done: -1, total: 4, unit: 'messages' },
      { done: 1, total: 0, unit: 'messages' },
      { done: 1, total: 4, unit: '' },
      { done: 1, total: 4 },
    ]) {
      expect(toRailActivity({ ...base, counter })?.counter, JSON.stringify(counter)).toBe(
        null,
      );
    }
  });

  it('drops the counter on a stale line', () => {
    const line = toRailActivity({
      phrase: 'No activity for 4 minutes',
      counter: { done: 29, total: 41, unit: 'messages' },
      startedAt: '2026-08-21T11:54:00.000Z',
      source: 'tool',
      stale: true,
    });
    expect(line?.stale).toBe(true);
    expect(line?.counter).toBeNull();
  });

  it('refuses a line it cannot date — "NaN min ago" is not an answer', () => {
    expect(
      toRailActivity({
        phrase: 'Reading email',
        counter: null,
        startedAt: 'whenever',
        source: 'tool',
        stale: false,
      }),
    ).toBeNull();
    expect(toRailActivity(null)).toBeNull();
  });

  it('parses the MCP namespace exactly as the dispatcher does', () => {
    expect(parseMcpToolName('mcp.linear.create_issue')).toEqual({
      serverId: 'linear',
      tool: 'create_issue',
    });
    expect(parseMcpToolName('web_search')).toBeNull();
    // Malformed inside the namespace: still an MCP name, never a native one.
    expect(parseMcpToolName('mcp.linear')).toBeNull();
    expect(parseMcpToolName('mcp..thing')).toBeNull();
    expect(
      inAgentScope('mcp.linear', {
        allowedTools: ['mcp.linear'],
        mcpConfigIds: ['linear'],
        unrestricted: false,
      }),
    ).toBe(false);
  });

  it('reads a grant ref strictly', () => {
    expect(readGrantRef({ grant: 'site', host: 'api.linear.app' })).toEqual({
      grant: 'site',
      host: 'api.linear.app',
    });
    expect(readGrantRef({ grant: 'nope' })).toBeNull();
    expect(readGrantRef(42)).toBeNull();
  });
});
