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

/**
 * The tools in `RULE_TOOL` a HOST PLUGIN registers into the tool catalog, so
 * their absence from `tool:list` proves the deployment cannot run them.
 *
 * `Read` and `Task` are deliberately NOT here: the runner hands those to the
 * agent inside its own sandbox, they never pass through `tool:register`, and
 * reading their absence from the host catalog as "not installed" would silence
 * the single largest thing an agent can do. That asymmetry is the whole reason
 * the rule table declares `providedBy` instead of the rail guessing from the
 * catalog alone.
 */
const HOST_PROVIDED: readonly string[] = ['web_search', 'request_capability'];

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
  /**
   * Tools the mock table describes for EVERY call, over and above the ones
   * `evaluate` matches on an empty input.
   *
   * Usually empty, because the two coincide: `evaluate` against `{}` matches
   * exactly the UNCONDITIONAL rules, which is the same set. It exists so a test
   * can state the coverage answer directly instead of implying it.
   */
  let policyFullyDescribes: Set<string>;
  /**
   * What the mock rule table says it names in HOST-PROVIDED tools — see
   * `ListCapabilitiesOutput.hostProvidedTools`.
   *
   * EMPTY BY DEFAULT, which is the "subtract nothing new" identity: most tests
   * in this file are about other axes and an empty set leaves their worlds
   * exactly as they were. The tests that are about an uninstalled plugin set it
   * to `HOST_PROVIDED` and then decide what the catalog does or does not hold.
   */
  let policyHostTools: Set<string>;
  /** 1-based call number of `list-capabilities` that throws, for a TRANSIENT read. */
  let policyThrowsOnCall: number | null;
  let policyCalls: number;
  /** Tool names whose `tool-policy:evaluate` throws. One row's worth of loss. */
  let evaluateThrowsFor: Set<string>;
  /**
   * What `tool-policy:evaluate` answers for `effect`, keyed by tool name.
   *
   * ITS OWN MAP rather than a field on `ruledTools`, and the split is the whole
   * point of the case this exists for. A tool named only by `when` rules is
   * ABSENT from `ruledTools` — that absence is how this file writes "no rule
   * matches the empty input" — and it is exactly that tool which gets a
   * mechanical base row with effects to disclose, because `EvaluateResult.effect`
   * on a no-match is the UNION over the rules naming the tool (TASK-383).
   * Hanging the field off `ruledTools` would make the one case the fix exists
   * for unwritable, and the fake would quietly only ever exercise the easy half.
   *
   * `unknown`, not `string[]`: some tests answer junk on purpose, because the
   * route is the thing on trial here — whether it still refuses a shape the
   * hook had no business sending.
   */
  let evaluateEffect: Map<string, unknown>;
  /** What the route last told the policy plugin this agent cannot reach. */
  let lastOutOfReach: string[] | null;
  let ruledTools: Map<string, { verdict: string; ruleId: string }>;
  let siteGrants: Map<string, Array<{ host: string; grantedAt: string }>>;
  let wallGrants: Map<string, Array<{ kind: string; value: string }>>;
  let revoked: unknown[];
  let decisions: StoredDecisionLike[];
  /** Every input `decisions:count` was handed this render, in order. */
  let countCalls: Array<Record<string, unknown>>;
  /** How many times the route reached for `decisions:list`. */
  let listCalls: number;

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
      policyCalls += 1;
      if (policyThrows !== null) throw policyThrows;
      if (policyThrowsOnCall === policyCalls) throw new Error('transient');
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
        /*
          Coverage, not display: which tools the TABLE speaks for on EVERY call.
          Deliberately not filtered by `outOfReach` — a row dropped as out of
          reach is a row about a tool this agent cannot see, and the caller has
          already excluded that tool from its own pass.

          Derived from the `ruledTools` entries that carry a rule id, so the
          mock cannot disagree with itself. That derivation is the real
          plugin's identity, not a convenience: `evaluate` on an empty input
          matches only rules with no predicate, so "a rule matched `{}`" and
          "an unconditional rule exists" are the same statement. A tool named
          only by a `when` rule is therefore in NEITHER — which is exactly how
          a test writes that case: leave it out of `ruledTools`.
        */
        fullyDescribedTools: [
          ...new Set([
            ...[...ruledTools.entries()]
              .filter(([, ruled]) => ruled.ruleId !== null)
              .map(([tool]) => tool),
            ...policyFullyDescribes,
          ]),
        ],
        /*
          Which of the tools this table names come from a host plugin. Not
          filtered by `outOfReach` either, and for the same reason
          `fullyDescribedTools` is not: it is a fact about the TABLE, and the
          caller is the one holding the catalog it has to be checked against.
        */
        hostProvidedTools: [...policyHostTools],
      };
    });
    bus.registerService('tool-policy:evaluate', 'policy', async (_c, i: unknown) => {
      const { call } = i as { call: { name: string } };
      if (evaluateThrowsFor.has(call.name)) throw new Error('evaluator down');
      const ruled = ruledTools.get(call.name);
      /*
        `effect` is answered on BOTH branches, and defaults to `[]` on neither
        more nor less than the real plugin does. The real `evaluate` returns the
        matched rule's set when a rule matched and the union over the rules
        naming the tool when none did (TASK-383) — two computations, one field,
        always present. A stub that answered it only on the matched branch would
        let a route that read `effect` off nothing but described rows pass, which
        is the pre-TASK-383 behaviour this test file now exists to forbid.
      */
      const effect = evaluateEffect.get(call.name) ?? [];
      return ruled === undefined
        ? { verdict: 'allow', ruleId: null, capability: null, irreversible: false, effect }
        : { ...ruled, capability: 'x', irreversible: false, effect };
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

  /**
   * The two decision reads this route could use, both registered on purpose.
   *
   * `decisions:count` is the one the counter asks. `decisions:list` is
   * registered too and does nothing but TALLY ITS OWN CALLS, because the
   * defect this counter used to carry was invisible in the answer it gave:
   * walking the seven statuses produced the right number, and seven reads to
   * get it — each of which swept the expiry table on its way past. A number
   * cannot show that. Only the reads can, so the reads are counted.
   */
  function registerDecisions(): void {
    bus.registerService('decisions:count', 'decisions', async (_c, i: unknown) => {
      countCalls.push(i as Record<string, unknown>);
      const { userId, agentId, since } = i as {
        userId: string;
        agentId?: string;
        since: string;
      };
      expect(userId).toBe('u1');
      const from = Date.parse(since);
      return {
        // ANY status, because the input names none. That is the same rule the
        // real store applies, and stating it here is what keeps this stub from
        // agreeing with a route that started filtering again.
        count: decisions.filter(
          (d) =>
            (agentId === undefined || d.agentId === agentId) &&
            Date.parse(d.createdAt) >= from,
        ).length,
      };
    });
    bus.registerService('decisions:list', 'decisions', async () => {
      listCalls += 1;
      return { decisions: [] };
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
    policyFullyDescribes = new Set();
    policyHostTools = new Set();
    policyThrowsOnCall = null;
    policyCalls = 0;
    evaluateThrowsFor = new Set();
    evaluateEffect = new Map();
    lastOutOfReach = null;
    ruledTools = new Map();
    siteGrants = new Map();
    wallGrants = new Map();
    revoked = [];
    decisions = [];
    countCalls = [];
    listCalls = 0;

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

  it('states BOTH truths for a tool only a `when`-predicate rule names', async () => {
    /*
      TASK-267, and the review finding on its first cut — the two halves are
      one test because getting either wrong renders a different lie.

      The original bug: the rail asked `tool-policy:evaluate` about a call
      nobody was making — `{ name, input: {} }` — and read `ruleId !== null` off
      the answer to decide whether a rule already described the tool. A rule
      whose `match.when` predicate reads the call's ARGUMENTS cannot match an
      input that has none, so its tool came back "unruled" and picked up a
      mechanical row carrying the UNCONDITIONAL verdict, standing next to a
      described row that says it asks first. Two rows, one tool, and one of the
      claims invented.

      The mirror-image bug, which the first fix shipped: skip every tool the
      table merely NAMES, and this tool renders ONLY "asks you first, in some
      cases". Nothing then states what the calls the predicate misses do, which
      is run on their own — and a reader completes an unstated complement with
      the safer guess. Silence about reach is design H4, the direction never to
      be wrong in.

      So the honest rail says both: the conditional gate in our own words, and
      the base reach mechanically. The verdict on the base row comes from the
      evaluator's answer for an input no predicate can match, which is the
      table's fall-through — not a guess this route made.
    */
    registerPolicy();
    registerCatalog();
    policyRows = [
      {
        verdict: 'hold',
        capability: 'delete a folder and everything in it',
        source: 'rule:files.delete-recursive',
        provenance: 'rule',
        described: true,
        conditional: true,
      },
    ];
    catalog = [{ name: 'delete_file', executesIn: 'host' }];
    // `delete_file` is deliberately absent from `ruledTools`: its only rule is
    // predicated on `{ recursive: true }`, so a real `evaluate` neither matches
    // it on an empty input nor counts it as fully described.

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions.rows).toHaveLength(2);

    // Reading order is allow-then-hold, so the base reach comes first.
    expect(body.permissions.rows[0]).toMatchObject({
      verdict: 'allow',
      described: false,
      conditional: false,
      mechanicalLabel: 'delete_file',
      source: 'tool:delete_file',
      // Our authored clause describes the CONDITIONAL case; putting it on this
      // row would label the unconditional half with the wrong sentence.
      capability: '',
    });
    expect(body.permissions.rows[1]).toMatchObject({
      verdict: 'hold',
      described: true,
      conditional: true,
      capability: 'delete a folder and everything in it',
      source: 'rule:files.delete-recursive',
    });
  });

  it('gives a tool with an unconditional rule only authored rows, never a mechanical one', async () => {
    /*
      The other side of the same boundary, and why "always emit a base row"
      would be wrong. Here the table speaks for every call already: the narrow
      `when` rule holds the recursive ones and the broad rule allows the rest,
      both authored, both rendered. A mechanical row on top would be a third
      claim about one tool, in nobody's words, saying what the second row
      already says.
    */
    registerPolicy();
    registerCatalog();
    policyRows = [
      {
        verdict: 'allow',
        capability: 'delete a file it made',
        source: 'rule:files.delete',
        provenance: 'rule',
        described: true,
        conditional: false,
      },
      {
        verdict: 'hold',
        capability: 'delete a folder and everything in it',
        source: 'rule:files.delete-recursive',
        provenance: 'rule',
        described: true,
        conditional: true,
      },
    ];
    catalog = [{ name: 'delete_file', executesIn: 'host' }];
    // The broad rule is what `evaluate` matches on an empty input, and what
    // makes the tool fully described.
    ruledTools.set('delete_file', { verdict: 'allow', ruleId: 'files.delete' });

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions.rows.every((r) => r.described)).toBe(true);
    expect(body.permissions.rows.map((r) => r.source)).toEqual([
      'rule:files.delete',
      'rule:files.delete-recursive',
    ]);
  });

  it('leaves a tool no rule names as an unconditional mechanical row', async () => {
    // The other half of the same fix: `conditional` is a claim too, and a
    // catalog row has no rule behind it to be conditional about.
    registerPolicy();
    registerCatalog();
    catalog = [{ name: 'some_unmapped_tool', executesIn: 'host' }];

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions.rows[0]).toMatchObject({
      described: false,
      conditional: false,
      mechanicalLabel: 'some_unmapped_tool',
    });
  });

  it('TASK-383: carries a declared effect through the REAL route, base row included', async () => {
    /*
      The end-to-end seam, which the projection unit tests below do not cover:
      `toWirePermission`'s allow-list is tested directly, and the canary proves
      `effect` survives the hook bus, but nothing asserted it comes out of
      `rail()` on the response body. Raised in review as the one untested hop.

      This stages the SAME two-row shape as the conditional-rule test above — a
      `when`-predicated rule plus the mechanical base row covering the calls its
      predicate misses — because that shape proves both halves at once, and the
      second half is the one TASK-383 closed:

        - the described row carries the declared effects all the way to the wire;
        - SO DOES THE BASE ROW, which is built from `tool-policy:evaluate` and
          now reads `EvaluateResult.effect` instead of hardcoding `[]`.

      This assertion USED TO PIN THE GAP: it expected `[]` on the base row and
      said in so many words that the fix was to carry `effect` onto
      `EvaluateResult` and read it here, and that whoever did that should update
      the expectation deliberately rather than revert. That is what happened.

      What makes the base row's `['spends']` correct rather than invented: on a
      `when`-only tool NO rule matches the empty input the route sends — a
      `PredicateSpec` needs an own property holding a primitive and `{}` has
      none — so `evaluate` falls through, and its fall-through answers the UNION
      of the effects declared by every rule naming this tool. A predicate gates
      the VERDICT, not what the call does in the world: a call that slips past
      `when: { field: 'recursive', equals: true }` still spends the money. The
      fake mirrors that by answering `effect` off its own map, keyed by tool,
      for a tool deliberately absent from `ruledTools`.

      Note which rule shapes this is and is not about. `web.extract` is
      conditional AND effect-bearing (TASK-330, `['spends', 'outward']`) but its
      conditionality comes from `egress`, not from a `when` predicate, and
      `fullyDescribedTools` filters on `when === undefined` — so it is fully
      described, gets no mechanical base row at all, and reaches the wire
      through the described row the next test pins. The row here is the other
      shape: a rule carrying BOTH a `when` predicate and an effect.
    */
    registerPolicy();
    registerCatalog();
    policyRows = [
      {
        verdict: 'hold',
        capability: 'delete a folder and everything in it',
        source: 'rule:files.delete-recursive',
        provenance: 'rule',
        described: true,
        conditional: true,
        effect: ['spends'],
      },
    ];
    catalog = [{ name: 'delete_file', executesIn: 'host' }];
    // `delete_file` stays out of `ruledTools` — nothing matches `{}` — so this
    // is `evaluate`'s FALL-THROUGH answer, the union over the `when` rule.
    evaluateEffect.set('delete_file', ['spends']);

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions.rows).toHaveLength(2);
    /*
      ASSERTED, not assumed — this used to be a comment saying "reading order is
      allow-then-hold" and nothing checked it.

      Which row lands at [0] is decided by `byVerdict`, and it is decided by the
      VERDICTS ALONE: the sort is stable and the route merges
      `[...described, ...catalog.rows]`, so two rows with the SAME verdict keep
      that arrival order and the DESCRIBED row wins [0]. The mechanical row only
      comes first because `allow` precedes `hold` in `VERDICT_ORDER`, and it is
      `allow` for TWO reasons, not one: no rule matches the empty input this row
      is built from, and the evaluator's no-match answer is `allow` (@ax/tool-
      policy's `evaluate` is default-allow on a fall-through). The empty input
      explains why nothing matched; the DEFAULT supplies the verdict. Either one
      changing flips this row.

      So the positional assertions below rest entirely on the two verdicts being
      different. Pin them, and a change to the evaluator's fall-through verdict
      fails HERE, naming the verdict — instead of surfacing two rows down as a
      missing `mechanicalLabel` and a `described` that flipped, which reads like
      the base row lost its effect. A test that goes red for the wrong reason
      costs more than the bug it was guarding.

      THE NEXT LINE IS THE LOAD-BEARING ONE, and it is first on purpose: vitest
      reports the FIRST failing `expect`, so ordering it ahead of the per-row
      blocks is the whole reason the failure names the verdict and nothing else.
      The `verdict` keys inside those blocks cannot fail without this line
      failing first — they carry no extra regression coverage, and they are kept
      only so each row states its own verdict beside its identity if this line is
      ever removed. Do not reorder them.
    */
    expect(body.permissions.rows.map((r) => r.verdict)).toEqual(['allow', 'hold']);
    expect(body.permissions.rows[0]).toMatchObject({
      verdict: 'allow',
      described: false,
      mechanicalLabel: 'delete_file',
    });
    // `toEqual` on the array itself, never `toMatchObject` with a one-member
    // array and never a `.not.toBe()`: an array-valued field makes an identity
    // assertion vacuous — it passes against `[]`, against `['s','p','e','n','d','s']`,
    // against anything. This is the assertion that has to distinguish them.
    expect(body.permissions.rows[0]?.effect).toEqual(['spends']);
    expect(body.permissions.rows[1]).toMatchObject({
      verdict: 'hold',
      described: true,
      source: 'rule:files.delete-recursive',
    });
    expect(body.permissions.rows[1]?.effect).toEqual(['spends']);
  });

  it('TASK-383: refuses a junk evaluate effect on the base row, end to end', async () => {
    /*
      The mirror is typed `unknown` and the base row filters it per member. This
      is that boundary asked THROUGH THE REAL ROUTE rather than through
      `toWireEffects` directly, because the unit test of the filter cannot tell
      you the filter is still WIRED IN — #574's regression was exactly a
      duck-typed mirror that stayed `tsc`-green while the value took a path
      nobody checked.

      Two junk shapes, both plausible from an impl written against an older
      spelling of this field:

        - A BARE STRING. `'spends'` is what `EvaluateResult.effect` looked like
          before TASK-330 made it a set, so it is the shape a stale impl sends.
          It is not a set of claims we can read, and wrapping it would invent
          the claim in the shape we asked for, so it lands as `[]`.
          Mind the trap when asserting: a string is ITERABLE, so a spread or a
          `[...raw]` coercion would yield `['s','p','e','n','d','s']` — six
          nonsense members that `toHaveLength(0)` catches but that a laxer
          assertion would wave through. `toEqual([])` is the one that separates
          "refused" from "shredded".
        - AN ARRAY WITH AN INVENTED MEMBER. `['spends', 'harmless']` keeps its
          true half: dropping the whole set over one bad member would UNDERSTATE
          a real effect (design H4), and passing the bad member through would put
          a claim on the wire that no authored copy can render.
    */
    registerPolicy();
    registerCatalog();
    catalog = [
      { name: 'bare_string_tool', executesIn: 'host' },
      { name: 'junk_member_tool', executesIn: 'host' },
    ];
    evaluateEffect.set('bare_string_tool', 'spends');
    evaluateEffect.set('junk_member_tool', ['spends', 'harmless']);

    const body = (await railFor()).body as AgentRailData;
    const byLabel = new Map(
      body.permissions.rows.map((r) => [r.mechanicalLabel, r.effect] as const),
    );
    expect(byLabel.get('bare_string_tool')).toEqual([]);
    expect(byLabel.get('junk_member_tool')).toEqual(['spends']);
  });

  it('TASK-330: carries BOTH declared effects of a web.extract-shaped rule onto the wire', async () => {
    /*
      THE REGRESSION THIS TEST EXISTS TO CATCH, end to end.

      `@ax/tool-policy` moved `effect` from a single value to a SET, and this
      route duck-types the row. The old projection asked
      `row.effect === 'spends' || row.effect === 'outward'`, which an ARRAY
      fails — so every declared effect silently became `null` and the rail
      stopped disclosing that `web_extract` spends money AND acts outward.
      `pnpm build` stayed green throughout, because a duck-typed
      `effect?: string` has no opinion about an array arriving in its place.

      Understating reach is the one direction design H4 forbids, so this asks
      the REAL route for the real shipped shape — hold, conditional, both
      effects — and asserts the ORDER the rule declared them in, because the
      renderer draws them in that order.
    */
    registerPolicy();
    registerCatalog();
    policyRows = [
      {
        verdict: 'hold',
        capability: 'read a web page, and remember the site it came from',
        source: 'rule:web.extract',
        provenance: 'rule',
        described: true,
        conditional: true,
        effect: ['spends', 'outward'],
      },
    ];
    catalog = [];

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions.rows).toHaveLength(1);
    expect(body.permissions.rows[0]?.effect).toEqual(['spends', 'outward']);
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

  it('never claims reach through a plugin this deployment never loaded', async () => {
    /*
      TASK-416, found by the TASK-357 walk against the live deployment: the rail
      advertised `memory.search`, `memory.note`, `web.search` and `web.extract`
      on a host that loads neither @ax/memory-strata nor @ax/web-tools (both are
      gated on a provider key). The agent contradicted its own rail in
      conversation — "I don't have a standalone 'save to memory' tool."

      WHY THE SCOPE SUBTRACTION DID NOT ALREADY CATCH IT. `outOfReach` was built
      by walking the CATALOG and keeping what the agent's scope excluded, so it
      could only ever name tools that are IN the catalog. A rule naming a tool
      whose plugin never registered anything had nothing to be subtracted from,
      fell through untouched, and rendered as ALLOW under a heading that
      promises to describe what is installed today.

      THE PRESENTATION QUESTION, decided here rather than in a comment on the
      fix: the row is OMITTED, not shown greyed as "unavailable". This surface's
      own rule is that a missing row reads as "it cannot do that" — which for an
      uninstalled tool is exactly TRUE, so omission cannot mislead in the
      direction design H4 forbids. A greyed row would instead put a
      non-capability inside the capability list, where a skim-reader collects it
      as reach, and it would cut across the verdict grouping the list is read
      by. The section still never renders a bare empty list: `status` separates
      "no producer" from "the read failed", and a zero-row `ok` says "we can't
      tell you — not that there isn't any".
    */
    registerPolicy();
    registerCatalog();
    policyRows = [
      { verdict: 'allow', capability: 'search the web', source: 'rule:web.search', provenance: 'catalog', described: true },
      { verdict: 'allow', capability: 'read files in its own workspace', source: 'rule:sandbox.read', provenance: 'catalog', described: true },
      { verdict: 'hold', capability: 'gain access to a new service or key', source: 'rule:skills.request-capability', provenance: 'rule', described: true },
      { verdict: 'deny', capability: 'start a hidden helper agent', source: 'rule:builtins.task', provenance: 'rule', described: true },
    ];
    policyHostTools = new Set(HOST_PROVIDED);
    /*
      Every one of those rules is unconditional, so the real table reports all
      four tools as fully described — INCLUDING the two the host catalog never
      holds. Stated explicitly because it is what arms the sandbox assertion
      below: a fix that subtracted every ruled tool the catalog lacks would find
      `Read` here and delete its row, and a mock that left `Read` out of the
      coverage answer could not tell that fix from this one.
    */
    policyFullyDescribes = new Set(['web_search', 'Read', 'Task', 'request_capability']);
    // @ax/skill-broker loaded and registered its tool. @ax/web-tools did not
    // load at all, so nothing in this deployment answers to `web_search`.
    catalog = [{ name: 'request_capability', executesIn: 'host' }];
    ruledTools.set('request_capability', {
      verdict: 'hold',
      ruleId: 'skills.request-capability',
    });

    const body = (await railFor()).body as AgentRailData;
    const sources = body.permissions.rows.map((r) => r.source);

    // THE BUG: a reach claim for a tool this deployment cannot run.
    expect(sources).not.toContain('rule:web.search');
    // Proved unreachable through the same channel the scope subtraction uses,
    // so the policy plugin drops the row rather than the rail hiding it.
    expect(lastOutOfReach).toContain('web_search');

    // THE MIRROR-IMAGE MISTAKE, guarded. `Read` is registered by the RUNNER
    // inside the sandbox and never appears in the host catalog, so its absence
    // proves nothing. A fix keying on catalog membership alone would silence
    // the sandbox six — understating reach, which is worse.
    expect(sources).toContain('rule:sandbox.read');
    expect(lastOutOfReach).not.toContain('Read');
    expect(lastOutOfReach).not.toContain('Task');

    // The installed host tool keeps its row, and so does the deny: a deny for
    // a tool nobody can reach is reassurance, not a reach claim.
    expect(sources).toContain('rule:skills.request-capability');
    expect(sources).toContain('rule:builtins.task');

    // Not a partial read. Nothing failed here — the catalog answered, and it
    // answered that the tool is not installed. Saying "this list may be missing
    // something" would turn a complete answer into a hedge.
    expect(body.permissions.status).toBe('ok');
    expect(body.permissions.incomplete).toBe(false);
  });

  it('proves nothing about an uninstalled tool when the catalog itself failed', async () => {
    /*
      The proof is the catalog read, so a catalog that threw proves NOTHING —
      not even about a host-provided tool the table names. Subtracting on a
      failed read would drop a reach claim on the strength of a read that never
      happened, and the section already has an honest answer for that case.
    */
    registerPolicy();
    bus.registerService('tool:list', 'catalog', async () => {
      throw new Error('catalog down');
    });
    policyHostTools = new Set(HOST_PROVIDED);
    policyRows = [
      { verdict: 'allow', capability: 'search the web', source: 'rule:web.search', provenance: 'catalog', described: true },
    ];

    const body = (await railFor()).body as AgentRailData;
    expect(lastOutOfReach).toEqual([]);
    expect(body.permissions.status).toBe('failed');
  });

  it('fails the section when the rule table will not say which tools are host-provided', async () => {
    /*
      Same posture as the `fullyDescribedTools` re-check beside it. The field
      arrives duck-typed across the bus, and an impl registered without a
      `returns` schema can simply not send it. Reading that silence as "the
      table names no host tools" would restore the exact claim this file now
      forbids — quietly, and on the surface whose only job is to be right about
      reach. So it is a failed read instead.
    */
    registerCatalog();
    bus.registerService('tool-policy:evaluate', 'policy', async () => ({
      verdict: 'allow',
      ruleId: null,
      capability: null,
      irreversible: false,
      effect: [],
    }));
    bus.registerService('tool-policy:list-capabilities', 'policy', async () => ({
      rows: [
        { verdict: 'allow', capability: 'search the web', source: 'rule:web.search', provenance: 'catalog', described: true },
      ],
      fullyDescribedTools: [],
    }));

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions).toMatchObject({ status: 'failed', rows: [] });
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

  it('subtracts nothing when the catalog could not be read — we proved no tool unreachable', async () => {
    /*
      The catalog is the only thing that can establish "this agent cannot reach
      that tool". When the read throws we have PROVED nothing, so the
      subtraction sent to the policy plugin must be empty rather than guessed —
      guessing one away would drop a true reach claim off a blast-radius
      surface.

      TASK-284 changed what the reader SEES on this path (the section is now
      `failed` and shows nothing rather than a partial list under an `ok`
      headline), which is asserted in its own test below. This one is about the
      request we send on the way there: it stays honest whatever the section
      does with the answer.
    */
    registerPolicy();
    bus.registerService('tool:list', 'catalog', async () => {
      throw new Error('catalog down');
    });
    policyRows = [
      { verdict: 'allow', capability: 'search the web', source: 'rule:web.search', provenance: 'catalog', described: true },
    ];
    agents.set('a1', agent({ id: 'a1', allowedTools: ['Read'], mcpConfigIds: [] }));

    await railFor();
    expect(lastOutOfReach).toEqual([]);
  });

  it('a throwing tool:list is a FAILED read, not a successful partial one', async () => {
    /*
      TASK-284, the same shape TASK-264 fixed in `readGrants`: one producer
      threw and the section folded it into `incomplete` while still calling
      itself `ok`. "We could not look" then renders as "we looked and there was
      less" — the headline is the claim and `incomplete` is a footnote under it.

      Milder here than it was for grants, because the permissions empty state
      already refuses to make a claim ("we can't tell you — not that there
      isn't any"). The STATUS was still wrong, and a copy change would re-arm
      it.
    */
    registerPolicy();
    bus.registerService('tool:list', 'catalog', async () => {
      throw new Error('catalog down');
    });
    policyRows = [
      { verdict: 'allow', capability: 'search the web', source: 'rule:web.search', provenance: 'catalog', described: true },
    ];

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions).toMatchObject({
      status: 'failed',
      // Zeroed with the status, the same way `readGrants` zeroes its rows: the
      // rail gates on `status` before it maps rows, but the NEXT consumer might
      // not, and a short list under a failure is this bug one level out.
      rows: [],
      incomplete: true,
    });
  });

  it('a coverage read that throws fails the section, even when the retry answers', async () => {
    /*
      The second producer inside the catalog half: the rail asks the policy
      plugin which tools its table already describes, so it never has to invent
      a call to find out. That read is asked BEFORE the one that fetches the
      described rows, and a transient failure of the first with a clean second
      is exactly the case a shared success flag would have swallowed — the rows
      arrive, the section says `ok`, and every tool the table describes is
      quietly re-listed as an undescribed one.
    */
    registerPolicy();
    registerCatalog();
    catalog = [{ name: 'web_search', executesIn: 'host' }];
    ruledTools.set('web_search', { verdict: 'allow', ruleId: 'web.search' });
    policyRows = [
      { verdict: 'allow', capability: 'search the web', source: 'rule:web.search', provenance: 'catalog', described: true },
    ];
    policyThrowsOnCall = 1;

    const body = (await railFor()).body as AgentRailData;
    expect(policyCalls).toBeGreaterThan(1);
    expect(body.permissions).toMatchObject({ status: 'failed', rows: [], incomplete: true });
  });

  it('treats a coverage answer with no fullyDescribedTools as a failed read, never as “nothing is described”', async () => {
    /*
      A duck-typed hook (I2), and this is the trust boundary. @ax/tool-policy
      declares the field required in its `returns` schema, so a conforming impl
      cannot omit it — but an alternate impl registered with no schema can, and
      reading a missing field as an empty set is the overstatement this whole
      read exists to prevent: every tool the table describes would be re-listed
      as an undescribed one, each with a mechanical row asserting the verdict
      for a call nobody made.
    */
    bus.registerService('tool-policy:list-capabilities', 'policy', async () => ({
      rows: [
        {
          verdict: 'allow',
          capability: 'search the web',
          source: 'rule:web.search',
          provenance: 'catalog',
          described: true,
        },
      ],
    }));
    bus.registerService('tool-policy:evaluate', 'policy', async () => ({
      verdict: 'allow',
      ruleId: null,
      capability: null,
      irreversible: false,
    }));
    registerCatalog();
    catalog = [{ name: 'web_search', executesIn: 'host' }];

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions).toMatchObject({ status: 'failed', rows: [] });
  });

  it('one tool the evaluator cannot answer for costs that row and says so — not the section', async () => {
    /*
      Deliberately NOT `failed`, and the difference is the point. A wholesale
      producer failure leaves us unable to bound what is missing; this failure
      is one named tool out of a list we otherwise read completely, and the
      surface already refuses the completeness claim in so many words ("this
      list may be missing something"). Failing the whole section here would
      replace a mostly-true list with nothing, which costs the reader more than
      it protects them.
    */
    registerPolicy();
    registerCatalog();
    catalog = [
      { name: 'good_tool', executesIn: 'host' },
      { name: 'flaky_tool', executesIn: 'host' },
    ];
    evaluateThrowsFor = new Set(['flaky_tool']);

    const body = (await railFor()).body as AgentRailData;
    expect(body.permissions.status).toBe('ok');
    expect(body.permissions.incomplete).toBe(true);
    expect(body.permissions.rows.map((r) => r.mechanicalLabel)).toEqual(['good_tool']);
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
    // silently omits every site grant — and they do not ride out under a
    // `failed` status either, so no consumer that forgets to check `status`
    // can turn a short list back into a claim.
    expect(body.grants).toMatchObject({ status: 'failed', rows: [] });
  });

  it('says failed when the wall read throws and the site read was clean', async () => {
    // The mirror image of the two above, and the one that pins the card's
    // actual thesis: the flag is tracked PER PRODUCER. Without this, deleting
    // `failed = true` from the wall's catch leaves the whole rail suite green,
    // and the symmetric bug — an agent whose approved-capability wall is
    // unreadable rendering as "you haven't granted anything" — is free to come
    // back.
    registerPolicy();
    agents.set('a1', agent({ id: 'a1', skillAttachments: [{ skillId: 'inbox-triage' }] }));
    bus.registerService('host-grants:list', 'host-grants', async () => ({ hosts: [] }));
    bus.registerService('skills:approved-caps-list', 'skills', async () => {
      throw new Error('wall down');
    });
    const body = (await railFor()).body as AgentRailData;
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

  it('ships NO "Handled on its own" and NO "You overruled it" — neither has a producer (TASK-265)', async () => {
    registerPolicy();
    registerDecisions();
    // Decisions in the window INCLUDING a dismissed one, because "dismissals
    // are half of the overrule definition" is exactly the temptation this
    // pins against: the half we can count is not the number the label
    // promises.
    decisions = [
      { id: 'd1', agentId: 'a1', status: 'dismissed', createdAt: iso(-1) },
      { id: 'd2', agentId: 'a1', status: 'executed', createdAt: iso(-2) },
    ];
    const body = (await railFor()).body as AgentRailData;

    // Every string on EVERY row — id, label, and the written definition — not
    // just `id`. The way this regresses is somebody adding §4.4's counter back
    // under a fresh id, and an id-only assertion would wave that through.
    //
    // Scanning the BACKED row's strings too is deliberate: the thing being
    // guarded is a sentence the surface says, and it does not matter which row
    // says it. If `brought-to-you` is ever reworded into one of these words
    // this goes red — a prompt worth having, not a false alarm.
    const said = body.counters.rows.flatMap((r) => [r.id, r.label, r.definition]);

    // Nothing counts the tool calls an agent handled alone. `tool:pre-call`
    // fires, but @ax/decisions returns without writing a row as soon as the
    // verdict is `allow`, and @ax/agent-activity keeps one in-memory snapshot
    // that it deletes at `chat:end`. There is no history to roll up, so any
    // "Handled on its own" number would be invented.
    expect(said.some((s) => /on its own|handled[- ]alone/i.test(s))).toBe(false);

    // `decisions:undo` restores the row to `pending` and clears `resolved_at`,
    // so an override leaves NO trace. This number is not merely zero today —
    // it is underivable, and rendering it would state "you have never
    // overruled me" from a read that could not have found out either way.
    expect(said.some((s) => /overrul/i.test(s))).toBe(false);

    // AND THE LINE THAT ACTUALLY CLOSES IT — name the backed set.
    //
    // The two regexes above catch the two phrasings we happened to think of.
    // `{id:'autonomy', label:'Ran without asking', definition:'Autonomous tool
    // calls this agent made this week.'}` is the same unbacked claim wearing a
    // synonym, and it sails past both. Keeping the keywords is what makes a
    // failure message say WHY; this is what makes the test a guard. The
    // invariant is "only counters we can substantiate render", and the only
    // way to state that is to list the ones that are backed — an id is a
    // schema detail and a label is a wording, but the SET is the claim.
    //
    // So if you are reading this because you added a counter and this went
    // red: that is the tripwire doing its job. It is an invitation to say what
    // produces your number — then add its id here and carry on — not an
    // obstacle to delete. The test is named for two counters that have no
    // producer; whether yours does is exactly the question worth stopping on.
    expect(body.counters.rows.map((r) => r.id)).toEqual(['brought-to-you']);
    expect(body.counters.rows.find((r) => r.id === 'brought-to-you')?.value).toBe(2);
  });

  it('says "unavailable" when this deployment has nothing that counts decisions', async () => {
    // THE THIRD STATE, and the one the other two counter tests cannot reach.
    // "We have no producer for this" is not "we asked and the read broke", and
    // neither of them is "we asked and the answer was none" — the panel is
    // rendered differently for each, and an unpinned branch on that
    // distinction is what the rest of this rail's defect family is made of.
    registerPolicy();
    // No decisions producer of any kind.
    const body = (await railFor()).body as AgentRailData;
    // Exhaustive rather than `toMatchObject`: `rows: []` is half the claim, and
    // "there is no row here at all" is precisely what stops a zero being drawn.
    expect(body.counters).toEqual({
      status: 'unavailable',
      rows: [],
      windowDays: COUNTER_WINDOW_DAYS,
    });
  });

  it('reads unavailable off the COUNTING hook, not off @ax/decisions being present', async () => {
    // The guard has to name the hook the counter actually calls. A route that
    // gated on `decisions:list` — as this one did until TASK-266 — and then
    // called `decisions:count` would sail past the guard into a throw, and the
    // person would be told the read FAILED in a deployment where nothing was
    // ever going to answer it. Registering the sibling hook and no counter is
    // the only arrangement that tells those two apart.
    registerPolicy();
    bus.registerService('decisions:list', 'decisions', async () => {
      listCalls += 1;
      return { decisions: [] };
    });
    const body = (await railFor()).body as AgentRailData;

    expect(body.counters).toEqual({
      status: 'unavailable',
      rows: [],
      windowDays: COUNTER_WINDOW_DAYS,
    });
    // And it did not go looking for an answer in the other hook on the way.
    expect(listCalls).toBe(0);
  });

  it('says the counter read failed rather than showing a zero', async () => {
    registerPolicy();
    bus.registerService('decisions:count', 'decisions', async () => {
      throw new Error('db down');
    });
    const body = (await railFor()).body as AgentRailData;
    expect(body.counters).toMatchObject({ status: 'failed', rows: [] });
  });

  it('reads a non-numeric answer as failed, never as a zero', async () => {
    // The counter's own version of this file's third reason for existing: an
    // empty answer here is a claim about how much an agent bothered you, and
    // "the read broke" must never be printed as "nothing happened".
    registerPolicy();
    bus.registerService('decisions:count', 'decisions', async () => ({ count: null }));
    const body = (await railFor()).body as AgentRailData;
    expect(body.counters).toMatchObject({ status: 'failed', rows: [] });
  });

  it('asks the decisions plugin ONE question per render, not one per status', async () => {
    // THE CARD (TASK-266). The old counter had no way to say "any status" —
    // `decisions:list` takes one exact status — so it walked all seven, and
    // every one of those reads swept the expiry table before answering. Seven
    // sweeps to draw one integer.
    //
    // Asserted as READS, not as elapsed time: a machine that happens to be
    // fast would hide the same seven round trips, and the sweeps they trigger
    // cost the same whoever is measuring.
    registerPolicy();
    registerDecisions();
    decisions = [
      { id: 'd1', agentId: 'a1', status: 'pending', createdAt: iso(-1) },
      { id: 'd2', agentId: 'a1', status: 'expired', createdAt: iso(-2) },
    ];
    const body = (await railFor()).body as AgentRailData;

    // Zero, not "fewer": the walk is GONE, not supplemented by a faster read
    // alongside it. A route that asked both would still sweep seven times.
    // This assertion is FIRST so the failure it reports before the fix is the
    // defect's own number — seven — rather than a wrong total downstream of it.
    expect(listCalls).toBe(0);
    expect(countCalls).toHaveLength(1);
    expect(body.counters.rows[0]?.value).toBe(2);
  });

  it('names no status at all, so a status added later cannot go uncounted', async () => {
    registerPolicy();
    registerDecisions();
    decisions = [{ id: 'd1', agentId: 'a1', status: 'failed', createdAt: iso(-1) }];
    const body = (await railFor()).body as AgentRailData;

    expect(body.counters.rows[0]?.value).toBe(1);
    // What replaces the enumeration this route used to carry. It spelled out
    // all seven statuses, and a status added to @ax/decisions and not added
    // here would have UNDERCOUNTED — quietly claiming an agent bothered you
    // less often than it did. Naming none deletes the list that could go
    // stale, so this asserts the absence rather than the contents.
    expect(countCalls[0]).not.toHaveProperty('status');
    // The scope and the window are the other half of the same question: this
    // agent, and exactly the seven days the shipped sentence promises.
    expect(countCalls[0]?.agentId).toBe('a1');
    expect(Date.parse(String(countCalls[0]?.since))).toBe(
      NOW.getTime() - COUNTER_WINDOW_DAYS * DAY_MS,
    );
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

  it('carries `conditional` through, and normalises a missing one to false', () => {
    // The wire row is what the renderer switches on, and `undefined` there
    // would render as unconditional while meaning "the producer did not say".
    // A duck-typed hook (I2) can omit the field; the wire never does.
    expect(
      toWirePermission({
        verdict: 'hold',
        capability: 'delete a folder and everything in it',
        source: 'rule:files.delete-recursive',
        provenance: 'rule',
        described: true,
        conditional: true,
      }).conditional,
    ).toBe(true);
    expect(
      toWirePermission({
        verdict: 'allow',
        capability: 'search the web',
        source: 'rule:web.search',
        provenance: 'catalog',
        described: true,
      }).conditional,
    ).toBe(false);
  });

  it('keeps `conditional` on a described row that demotes to mechanical', () => {
    // Losing the clause loses our sentence, not the rule behind it. A row that
    // dropped its conditionality on the way down would render "Can use `x` —
    // on its own" for a tool the table only sometimes allows.
    const row = toWirePermission({
      verdict: 'hold',
      capability: '\u200B',
      source: 'rule:x',
      provenance: 'rule',
      described: true,
      conditional: true,
      mechanicalLabel: 'delete_file',
    });
    expect(row.described).toBe(false);
    expect(row.conditional).toBe(true);
  });

  it('carries a declared `spends` effect onto the wire row', () => {
    const row = toWirePermission({
      verdict: 'allow',
      capability: 'search the web',
      source: 'rule:web.search',
      provenance: 'catalog',
      described: true,
      effect: ['spends'],
    });
    expect(row.effect).toEqual(['spends']);
  });

  it('carries a declared `outward` effect onto the wire row', () => {
    const row = toWirePermission({
      verdict: 'hold',
      capability: 'send a message to someone outside AX',
      source: 'rule:messages.send',
      provenance: 'rule',
      described: true,
      effect: ['outward'],
    });
    expect(row.effect).toEqual(['outward']);
  });

  it('carries BOTH members of a two-effect rule, in the declared order (TASK-330)', () => {
    /*
      THE SILENT-NULL BUG. `@ax/tool-policy` made `effect` a SET, and this
      projection asked `row.effect === 'spends' || row.effect === 'outward'`
      — an array satisfies neither, so `web.extract`'s declared spend AND its
      declared outward reach both vanished into `null` on the wire, with a
      green build the whole time (the field is duck-typed, so no type error
      announced the change).

      The order is asserted, not just the membership: the renderer draws one
      badge per member in array order, and a re-ordered set is a row that
      leads with a different fact than the rule does.
    */
    const row = toWirePermission({
      verdict: 'hold',
      capability: 'read a web page, and remember the site it came from',
      source: 'rule:web.extract',
      provenance: 'rule',
      described: true,
      conditional: true,
      effect: ['spends', 'outward'],
    });
    expect(row.effect).toEqual(['spends', 'outward']);
  });

  it('allow-lists `effect` per MEMBER — an unrecognised one is dropped, the rest survive', () => {
    // The load-bearing case, and it is load-bearing in BOTH directions. A
    // plain copy-through would let `'nonsense'` onto the wire, where the
    // renderer's `Record` has no entry for it and the row would carry a claim
    // nobody typed into the authored table. Dropping the whole set over the
    // one bad member would be the opposite failure: a row that spends money
    // and says nothing, which is understating reach (design H4).
    const row = toWirePermission({
      verdict: 'allow',
      capability: 'search the web',
      source: 'rule:web.search',
      provenance: 'catalog',
      described: true,
      effect: ['spends', 'nonsense'],
    });
    expect(row.effect).toEqual(['spends']);
  });

  it('allow-lists `effect` — a set of nothing we know lands as `[]`', () => {
    const row = toWirePermission({
      verdict: 'allow',
      capability: 'search the web',
      source: 'rule:web.search',
      provenance: 'catalog',
      described: true,
      effect: ['harmless', 42, null],
    });
    expect(row.effect).toEqual([]);
  });

  it('collapses a duplicated member — the field is a set of claims, not a tally', () => {
    // The lint in @ax/tool-policy rejects duplicates at authoring time; this
    // is the duck-typed hop, where an alternate impl can still answer one.
    // Two identical badges on a row read as a rendering bug, and `key` at the
    // render site is the effect name.
    const row = toWirePermission({
      verdict: 'hold',
      capability: 'read a web page',
      source: 'rule:web.extract',
      provenance: 'rule',
      described: true,
      effect: ['spends', 'outward', 'spends'],
    });
    expect(row.effect).toEqual(['spends', 'outward']);
  });

  it.each([
    ['a bare string', 'spends'],
    ['a number', 42],
    ['null', null],
    ['an object', { spends: true }],
    ['a boolean', true],
  ])('a non-array `effect` (%s) lands as `[]`', (_label, value) => {
    // The input is a duck-typed hook answer (I2); a hook can answer anything,
    // including the single value this field used to hold. A lone `'spends'`
    // is NOT quietly wrapped into `['spends']`: guessing at the shape would
    // manufacture a claim in a form nobody agreed to send, and the honest
    // reading of an answer we cannot parse is "unclassified".
    const row = toWirePermission({
      verdict: 'allow',
      capability: 'search the web',
      source: 'rule:web.search',
      provenance: 'catalog',
      described: true,
      effect: value,
    });
    expect(row.effect).toEqual([]);
  });

  it('normalises a missing `effect` to `[]`', () => {
    const row = toWirePermission({
      verdict: 'allow',
      capability: 'search the web',
      source: 'rule:web.search',
      provenance: 'catalog',
      described: true,
    });
    expect(row.effect).toEqual([]);
  });

  it('keeps declared effects on a described row that demotes to mechanical', () => {
    // Same reasoning as `conditional` right above: losing OUR SENTENCE when
    // `capability` fences to nothing does not unspend the money.
    const row = toWirePermission({
      verdict: 'hold',
      capability: '​',
      source: 'rule:x',
      provenance: 'rule',
      described: true,
      effect: ['spends', 'outward'],
      mechanicalLabel: 'delete_file',
    });
    expect(row.described).toBe(false);
    expect(row.effect).toEqual(['spends', 'outward']);
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
