// @vitest-environment node
/**
 * One connector's details view, per agent (TASK-742, connectors-rail slice 9):
 *
 *   GET /api/workspace/agents/:agentId/connectors/:connectorId/tools[?refresh=1]
 *   PUT /api/workspace/agents/:agentId/connectors/:connectorId/tool-verdicts
 *
 * What the tests are for, most expensive first:
 *
 *   1. THE KEY BINDING. A PUT can only write a key under THIS connector's own
 *      tool namespaces, for a connector in THIS agent's effective list. A
 *      foreign namespace, `Bash`, or a malformed key never reaches the store.
 *   2. THE ACL. A caller `agents:resolve` refuses gets a 404 and nothing
 *      downstream runs.
 *   3. THE SCREEN SAYS WHAT THE GATE DOES. `verdict` is the strictest of the
 *      agent's choice and the admin's ceiling; unknown values fail closed to
 *      `hold`; a choice the agent holds stays visible even when the server
 *      cannot be listed. The last block boots the REAL @ax/tool-policy and
 *      checks the route's writes against `tool-policy:evaluate`.
 *   4. UNTRUSTED TEXT. A server's titles / descriptions are fenced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import {
  createMemoryEgressAllowlistStore,
  createMemoryVerdictStore,
  createToolPolicyPlugin,
} from '@ax/tool-policy';
import {
  CONNECTOR_TOOL_DESCRIPTION_MAX_CHARS,
  makeWorkspaceHandlers,
} from '../../server/routes-workspace.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

function mkReq(
  params: Record<string, string>,
  opts: { body?: unknown; raw?: string; query?: Record<string, string> } = {},
): RouteRequest {
  return {
    headers: {},
    body:
      opts.raw !== undefined
        ? Buffer.from(opts.raw, 'utf-8')
        : opts.body === undefined
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(opts.body), 'utf-8'),
    cookies: {},
    query: opts.query ?? {},
    params,
    signedCookie: () => null,
  };
}

interface Captured {
  statusCode: number;
  body: unknown;
}
function mkRes(): { res: RouteResponse; captured: Captured } {
  const captured: Captured = { statusCode: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text() {},
    end() {},
  };
  return { res, captured };
}

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

const NS_LINEAR = 'c0123456789';
const NS_LINEAR_2 = 'c0123456780';
const NS_GMAIL = 'cabcdef0123';
const NS_STRANGER = 'cfffffff000';
const k = (ns: string, tool: string) => `mcp.${ns}.${tool}`;

interface InventoryTool {
  name: string;
  title: string;
  description: string;
  readOnly: boolean | null;
  outward: boolean | null;
  toolKey: string;
}
const tool = (ns: string, name: string, extra: Partial<InventoryTool> = {}): InventoryTool => ({
  name,
  title: name.replace(/_/g, ' '),
  description: `Does ${name}.`,
  readOnly: null,
  outward: null,
  toolKey: k(ns, name),
  ...extra,
});

describe('connector details routes (mock bus)', () => {
  let bus: HookBus;
  let owners: Map<string, string>;
  let effective: Array<{
    summary: { id: string; name: string; keyMode?: 'personal' | 'workspace' };
    source: 'default' | 'attached' | 'legacy-owned';
    toolNamespaces: Array<{ server: string; toolNamespace: string }>;
  }>;
  let inventory: { status: string; tools: InventoryTool[]; checkedAt: string };
  let describeThrows: boolean;
  let describeCalls: unknown[];
  /** toolKey → admin default. */
  let defaults: Map<string, string>;
  let defaultsCalls: unknown[];
  /** toolKey → stored override. */
  let overrides: Map<string, { verdict: string; ceiling?: string }>;
  let listOverridesCalls: number;
  let setCalls: Array<Record<string, unknown>>;
  let setAnswer: (input: { toolKey: string; verdict: string }) => unknown;
  let listEffectiveCalls: number;

  function registerAll(omit: string[] = []) {
    const reg = (hook: string, fn: (i: unknown) => Promise<unknown>) => {
      if (!omit.includes(hook)) bus.registerService(hook, 'mock', async (_c, i) => fn(i));
    };
    reg('auth:require-user', async () => ({ user: { id: 'u1', isAdmin: false } }));
    reg('agents:resolve', async (i) => {
      const { agentId, userId } = i as { agentId: string; userId: string };
      if (owners.get(agentId) !== userId) {
        throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' });
      }
      return { agent: { id: agentId, connectorAttachments: ['linear'], connectorExclusions: [] } };
    });
    reg('connectors:list-effective', async () => {
      listEffectiveCalls++;
      return { connectors: effective };
    });
    reg('connectors:describe-tools', async (i) => {
      describeCalls.push(i);
      if (describeThrows) throw new Error('server down');
      return inventory;
    });
    reg('tool-policy:get-connector-defaults', async (i) => {
      defaultsCalls.push(i);
      return {
        defaults: [...defaults.entries()].map(([toolKey, verdict]) => ({ toolKey, verdict })),
      };
    });
    reg('tool-policy:list-agent-overrides', async () => {
      listOverridesCalls++;
      return {
        overrides: [...overrides.entries()].map(([toolKey, o]) => ({
          toolKey,
          verdict: o.verdict,
          ...(o.ceiling !== undefined && { ceiling: o.ceiling }),
          origin: 'user',
        })),
      };
    });
    reg('tool-policy:set-agent-override', async (i) => {
      const input = i as { toolKey: string; verdict: string };
      setCalls.push(input as unknown as Record<string, unknown>);
      return setAnswer(input);
    });
  }

  beforeEach(() => {
    bus = new HookBus();
    owners = new Map([
      ['a1', 'u1'],
      ['a-theirs', 'u2'],
    ]);
    effective = [
      {
        summary: { id: 'gmail', name: 'Gmail', keyMode: 'workspace' },
        source: 'default',
        toolNamespaces: [{ server: 'gmail', toolNamespace: NS_GMAIL }],
      },
      {
        summary: { id: 'linear', name: 'Linear', keyMode: 'personal' },
        source: 'attached',
        toolNamespaces: [{ server: 'linear', toolNamespace: NS_LINEAR }],
      },
    ];
    inventory = {
      status: 'ok',
      checkedAt: '2026-10-03T10:00:00.000Z',
      tools: [
        tool(NS_LINEAR, 'create_issue', { readOnly: false, outward: true }),
        tool(NS_LINEAR, 'search', { readOnly: true, outward: false }),
        tool(NS_LINEAR, 'list_teams'),
        tool(NS_LINEAR, 'delete_issue', { readOnly: false, outward: false }),
      ],
    };
    describeThrows = false;
    describeCalls = [];
    defaults = new Map([
      [k(NS_LINEAR, 'create_issue'), 'allow'],
      [k(NS_LINEAR, 'search'), 'hold'],
      [k(NS_LINEAR, 'delete_issue'), 'deny'],
    ]);
    defaultsCalls = [];
    overrides = new Map([
      [k(NS_LINEAR, 'create_issue'), { verdict: 'hold', ceiling: 'allow' }],
      [k(NS_GMAIL, 'send'), { verdict: 'deny', ceiling: 'allow' }],
      ['Bash', { verdict: 'deny', ceiling: 'allow' }],
    ]);
    listOverridesCalls = 0;
    setCalls = [];
    // A store that keeps what it is told and reports the admin default as
    // the ceiling, like @ax/tool-policy does.
    setAnswer = ({ toolKey, verdict }) => {
      overrides.set(toolKey, { verdict, ceiling: defaults.get(toolKey) ?? 'hold' });
      return { ok: true };
    };
    listEffectiveCalls = 0;
    registerAll();
  });

  async function get(
    connectorId = 'linear',
    agentId = 'a1',
    query: Record<string, string> = {},
  ): Promise<Captured> {
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).connectorTools(
      mkReq({ agentId, connectorId }, { query }),
      res,
    );
    return captured;
  }
  async function put(
    body: unknown,
    connectorId = 'linear',
    agentId = 'a1',
    raw?: string,
  ): Promise<Captured> {
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).setConnectorToolVerdict(
      mkReq({ agentId, connectorId }, { body, ...(raw !== undefined && { raw }) }),
      res,
    );
    return captured;
  }
  const toolsOf = (r: Captured) =>
    (r.body as { tools: Array<Record<string, unknown>> }).tools;

  describe('GET …/tools', () => {
    it('passes the hints through and shows what the gate does for each tool', async () => {
      const r = await get();
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({
        connector: { id: 'linear', name: 'Linear', access: 'personal' },
        status: 'ok',
        checkedAt: '2026-10-03T10:00:00.000Z',
        possiblyIncomplete: false,
        tools: [
          {
            // Admin allows, the person said Ask first: Ask first, under an
            // Allow ceiling.
            toolKey: k(NS_LINEAR, 'create_issue'),
            title: 'create issue',
            description: 'Does create_issue.',
            readOnly: false,
            outward: true,
            verdict: 'hold',
            ceiling: 'allow',
          },
          {
            // Admin said Ask first and the person said nothing.
            toolKey: k(NS_LINEAR, 'search'),
            title: 'search',
            description: 'Does search.',
            readOnly: true,
            outward: false,
            verdict: 'hold',
            ceiling: 'hold',
          },
          {
            // Nobody decided: the gate's own default for a connector tool.
            toolKey: k(NS_LINEAR, 'list_teams'),
            title: 'list teams',
            description: 'Does list_teams.',
            readOnly: null,
            outward: null,
            verdict: 'hold',
            ceiling: 'hold',
          },
          {
            toolKey: k(NS_LINEAR, 'delete_issue'),
            title: 'delete issue',
            description: 'Does delete_issue.',
            readOnly: false,
            outward: false,
            verdict: 'deny',
            ceiling: 'deny',
          },
        ],
      });
      // Defaults are read for THIS connector's namespaces only; the
      // inventory is read under the caller and for this agent.
      expect(defaultsCalls).toEqual([{ connectorId: 'linear', toolNamespaces: [NS_LINEAR] }]);
      expect(describeCalls).toEqual([{ userId: 'u1', agentId: 'a1', connectorId: 'linear' }]);
    });

    it("says whose access a workspace connector spends", async () => {
      inventory = { ...inventory, tools: [tool(NS_GMAIL, 'send')] };
      const r = await get('gmail');
      expect((r.body as { connector: unknown }).connector).toEqual({
        id: 'gmail',
        name: 'Gmail',
        access: 'workspace',
      });
      // The Gmail override shows up on the Gmail view, not the Linear one.
      expect(toolsOf(r)).toEqual([
        expect.objectContaining({ toolKey: k(NS_GMAIL, 'send'), verdict: 'deny' }),
      ]);
    });

    it('fails closed: an unreadable verdict or ceiling reads as Ask first', async () => {
      defaults.set(k(NS_LINEAR, 'list_teams'), 'yolo');
      overrides.set(k(NS_LINEAR, 'search'), { verdict: 'allow', ceiling: 'sure' });
      const rows = toolsOf(await get());
      expect(rows.find((t) => t.toolKey === k(NS_LINEAR, 'list_teams'))).toMatchObject({
        verdict: 'hold',
        ceiling: 'hold',
      });
      expect(rows.find((t) => t.toolKey === k(NS_LINEAR, 'search'))).toMatchObject({
        verdict: 'hold',
        ceiling: 'hold',
      });
    });

    it('keeps a choice the agent holds visible when the server no longer lists that tool', async () => {
      overrides.set(k(NS_LINEAR, 'archived_tool'), { verdict: 'deny', ceiling: 'allow' });
      const rows = toolsOf(await get());
      expect(rows.at(-1)).toEqual({
        toolKey: k(NS_LINEAR, 'archived_tool'),
        title: 'archived_tool',
        description: '',
        readOnly: null,
        outward: null,
        verdict: 'deny',
        ceiling: 'allow',
      });
      // Another connector's choice and a non-connector key are not rows here.
      const keys = rows.map((t) => t.toolKey);
      expect(keys).not.toContain(k(NS_GMAIL, 'send'));
      expect(keys).not.toContain('Bash');
    });

    it("drops inventory rows outside this connector's own namespaces", async () => {
      inventory.tools.push(tool(NS_GMAIL, 'send'), tool(NS_STRANGER, 'x'), {
        ...tool(NS_LINEAR, 'bash'),
        toolKey: 'Bash',
      });
      const keys = toolsOf(await get()).map((t) => t.toolKey);
      expect(keys).toEqual([
        k(NS_LINEAR, 'create_issue'),
        k(NS_LINEAR, 'search'),
        k(NS_LINEAR, 'list_teams'),
        k(NS_LINEAR, 'delete_issue'),
      ]);
    });

    it('a server that cannot be asked reads as unknown, and held choices still show', async () => {
      describeThrows = true;
      const r = await get();
      expect(r.statusCode).toBe(200);
      expect(r.body).toMatchObject({ status: 'unknown', checkedAt: null, possiblyIncomplete: false });
      expect(toolsOf(r)).toEqual([
        {
          toolKey: k(NS_LINEAR, 'create_issue'),
          title: 'create_issue',
          description: '',
          readOnly: null,
          outward: null,
          verdict: 'hold',
          ceiling: 'allow',
        },
      ]);
    });

    it('with no describe-tools in the preset, answers unknown rather than failing', async () => {
      bus = new HookBus();
      registerAll(['connectors:describe-tools']);
      const r = await get();
      expect(r.statusCode).toBe(200);
      expect(r.body).toMatchObject({ status: 'unknown', checkedAt: null });
      expect(toolsOf(r).map((t) => t.toolKey)).toEqual([k(NS_LINEAR, 'create_issue')]);
    });

    it('refresh=1 asks the server again (force); a plain read does not', async () => {
      await get('linear', 'a1', { refresh: '1' });
      await get();
      expect(describeCalls).toEqual([
        { userId: 'u1', agentId: 'a1', connectorId: 'linear', force: true },
        { userId: 'u1', agentId: 'a1', connectorId: 'linear' },
      ]);
    });

    it('flags the list incomplete when one of its servers answered with no tools', async () => {
      effective[1]!.toolNamespaces.push({ server: 'local', toolNamespace: NS_LINEAR_2 });
      expect((await get()).body).toMatchObject({ possiblyIncomplete: true });
      // …but not when nothing was listed at all — that is `status`'s job.
      inventory = { ...inventory, status: 'unreachable', tools: [] };
      expect((await get()).body).toMatchObject({
        status: 'unreachable',
        possiblyIncomplete: false,
      });
    });

    it('fences a server title and description; never builds markup', async () => {
      inventory.tools = [
        tool(NS_LINEAR, 'evil', {
          title: 'Delete\u0007 every\nthing‮',
          description: `Line one\u0007\nLine two‮${'x'.repeat(5000)}`,
        }),
        tool(NS_LINEAR, 'blank', { title: '​​', name: '\u0001' }),
      ];
      const rows = toolsOf(await get());
      expect(rows[0]!.title).toBe('Delete every thing');
      const description = rows[0]!.description as string;
      expect(description.startsWith('Line one\nLine two')).toBe(true);
      expect(description).not.toMatch(/[\u0007‮]/);
      expect([...description]).toHaveLength(CONNECTOR_TOOL_DESCRIPTION_MAX_CHARS);
      // Nothing legible in title OR name: the key's own tool part.
      expect(rows[1]!.title).toBe('blank');
    });

    it("404s another person's agent and touches nothing downstream", async () => {
      const r = await get('linear', 'a-theirs');
      expect(r).toEqual({ statusCode: 404, body: { error: 'agent-not-found' } });
      expect(listEffectiveCalls).toBe(0);
      expect(describeCalls).toHaveLength(0);
      expect(defaultsCalls).toHaveLength(0);
      expect(listOverridesCalls).toBe(0);
    });

    it("404s a connector that is not in this agent's list, before any store read", async () => {
      const r = await get('notion');
      expect(r).toEqual({ statusCode: 404, body: { error: 'connector-not-found' } });
      expect(describeCalls).toHaveLength(0);
      expect(defaultsCalls).toHaveLength(0);
      expect(listOverridesCalls).toBe(0);
    });

    it('400s a malformed connector id', async () => {
      expect((await get('../x')).statusCode).toBe(400);
    });

    it('503s without the connector list or without the verdict store', async () => {
      bus = new HookBus();
      registerAll(['connectors:list-effective']);
      expect(await get()).toEqual({ statusCode: 503, body: { error: 'connectors-unavailable' } });
      bus = new HookBus();
      registerAll(['tool-policy:get-connector-defaults']);
      expect(await get()).toEqual({
        statusCode: 503,
        body: { error: 'tool-permissions-unavailable' },
      });
      bus = new HookBus();
      registerAll(['tool-policy:list-agent-overrides']);
      expect((await get()).statusCode).toBe(503);
    });
  });

  describe('PUT …/tool-verdicts', () => {
    it('writes one verdict for this agent and answers the re-read state', async () => {
      const r = await put({ toolKey: k(NS_LINEAR, 'search'), verdict: 'deny' });
      expect(r).toEqual({
        statusCode: 200,
        body: { tool: { toolKey: k(NS_LINEAR, 'search'), verdict: 'deny', ceiling: 'hold' } },
      });
      expect(setCalls).toEqual([{ agentId: 'a1', toolKey: k(NS_LINEAR, 'search'), verdict: 'deny' }]);
    });

    it("answers the store's state, not an echo of the request", async () => {
      // The store said yes, but what it holds is stricter (another writer
      // won the race): the screen shows the stored deny.
      setAnswer = ({ toolKey }) => {
        overrides.set(toolKey, { verdict: 'deny', ceiling: 'allow' });
        return { ok: true };
      };
      const r = await put({ toolKey: k(NS_LINEAR, 'create_issue'), verdict: 'allow' });
      expect((r.body as { tool: unknown }).tool).toEqual({
        toolKey: k(NS_LINEAR, 'create_issue'),
        verdict: 'deny',
        ceiling: 'allow',
      });
    });

    it.each([
      ['another connector of this agent', k(NS_GMAIL, 'send')],
      ['a connector this agent does not have', k(NS_STRANGER, 'x')],
      ['a non-connector key', 'Bash'],
      ['a key with no tool part', `mcp.${NS_LINEAR}.`],
      ['a key with no namespace', 'mcp..search'],
      ['an over-long key', k(NS_LINEAR, 'a'.repeat(300))],
      ['a non-string key', 42],
    ])('refuses %s and never writes', async (_label, toolKey) => {
      const r = await put({ toolKey, verdict: 'deny' });
      expect(r).toEqual({ statusCode: 400, body: { error: 'not-this-connectors-tool' } });
      expect(setCalls).toHaveLength(0);
    });

    it.each([[null], ['yes'], [undefined]])('refuses verdict %s (no clears here)', async (verdict) => {
      const r = await put({ toolKey: k(NS_LINEAR, 'search'), verdict });
      expect(r).toEqual({ statusCode: 400, body: { error: 'invalid-verdict' } });
      expect(setCalls).toHaveLength(0);
    });

    it('400s a body that is not JSON', async () => {
      const r = await put(undefined, 'linear', 'a1', '{nope');
      expect(r).toEqual({ statusCode: 400, body: { error: 'invalid-json' } });
    });

    it('a choice looser than the ceiling is a 409 carrying the ceiling, never "saved"', async () => {
      setAnswer = () => ({ ok: false, reason: 'ceiling-violation', ceiling: 'hold' });
      const r = await put({ toolKey: k(NS_LINEAR, 'search'), verdict: 'allow' });
      expect(r).toEqual({ statusCode: 409, body: { error: 'ceiling-violation', ceiling: 'hold' } });
    });

    it('any other refusal is a 409 with its reason', async () => {
      setAnswer = () => ({ ok: false, reason: 'invalid-key' });
      const r = await put({ toolKey: k(NS_LINEAR, 'search'), verdict: 'deny' });
      expect(r).toEqual({ statusCode: 409, body: { error: 'verdict-not-saved', reason: 'invalid-key' } });
    });

    it('a yes the re-read cannot find is not reported as saved', async () => {
      setAnswer = () => ({ ok: true });
      const r = await put({ toolKey: k(NS_LINEAR, 'list_teams'), verdict: 'deny' });
      expect(r).toEqual({
        statusCode: 409,
        body: { error: 'verdict-not-saved', reason: 'not-found-on-reread' },
      });
    });

    it('a yes whose re-read THROWS is reported as written-but-unconfirmed, not as a failure (TASK-757)', async () => {
      // The store accepted the write; only the read-back broke. A 500 here
      // made the screen say "Nothing changed" about a change that was made.
      bus = new HookBus();
      registerAll(['tool-policy:list-agent-overrides']);
      bus.registerService('tool-policy:list-agent-overrides', 'mock', async () => {
        throw new Error('store read blipped');
      });
      const warn = vi.spyOn(initCtx.logger, 'warn');
      try {
        const r = await put({ toolKey: k(NS_LINEAR, 'search'), verdict: 'deny' });
        expect(r).toEqual({
          statusCode: 200,
          body: { tool: { toolKey: k(NS_LINEAR, 'search'), verdict: 'deny' }, unconfirmed: true },
        });
        expect(setCalls).toEqual([
          { agentId: 'a1', toolKey: k(NS_LINEAR, 'search'), verdict: 'deny' },
        ]);
        expect(warn).toHaveBeenCalledWith(
          'workspace_tool_verdict_reread_failed',
          expect.objectContaining({ agentId: 'a1', connectorId: 'linear', error: expect.stringContaining('store read blipped') }),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('a normal save carries no unconfirmed flag', async () => {
      const r = await put({ toolKey: k(NS_LINEAR, 'search'), verdict: 'deny' });
      expect('unconfirmed' in (r.body as object)).toBe(false);
    });

    it("404s another person's agent and never writes", async () => {
      const r = await put({ toolKey: k(NS_LINEAR, 'search'), verdict: 'deny' }, 'linear', 'a-theirs');
      expect(r.statusCode).toBe(404);
      expect(setCalls).toHaveLength(0);
    });

    it("404s a connector that is not in this agent's list and never writes", async () => {
      effective = effective.filter((c) => c.summary.id !== 'linear');
      const r = await put({ toolKey: k(NS_LINEAR, 'search'), verdict: 'deny' });
      expect(r).toEqual({ statusCode: 404, body: { error: 'connector-not-found' } });
      expect(setCalls).toHaveLength(0);
    });

    it('503s without a writer', async () => {
      bus = new HookBus();
      registerAll(['tool-policy:set-agent-override']);
      const r = await put({ toolKey: k(NS_LINEAR, 'search'), verdict: 'deny' });
      expect(r).toEqual({ statusCode: 503, body: { error: 'tool-permissions-unavailable' } });
    });
  });
});

// ---------------------------------------------------------------------------
// Against the real @ax/tool-policy: what the route writes is what the gate
// enforces, and the store's ceiling refusal reaches the person as a 409.
// ---------------------------------------------------------------------------

describe('connector details routes against the real tool-policy', () => {
  const NS = 'c5e0235982f';
  const SEND = `mcp.${NS}.send_message`;
  const AGENT = 'agent-1';
  const harnesses: TestHarness[] = [];
  afterEach(async () => {
    while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  });

  async function boot(): Promise<TestHarness> {
    const h = await createTestHarness({
      services: {
        'auth:require-user': async () => ({ user: { id: 'u1', isAdmin: false } }),
        'agents:resolve': async (_c, i) => {
          const { agentId, userId } = i as { agentId: string; userId: string };
          if (agentId !== AGENT || userId !== 'u1') {
            throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' });
          }
          return { agent: { id: AGENT, connectorAttachments: ['gmail'], connectorExclusions: [] } };
        },
        'connectors:list-effective': async () => ({
          connectors: [
            {
              summary: { id: 'gmail', name: 'Gmail', keyMode: 'workspace' },
              source: 'attached',
              toolNamespaces: [{ server: 'gmail', toolNamespace: NS }],
            },
          ],
        }),
      },
      plugins: [
        createToolPolicyPlugin({
          egressStore: createMemoryEgressAllowlistStore(),
          verdictStore: createMemoryVerdictStore(),
        }),
      ],
    });
    harnesses.push(h);
    return h;
  }

  const adminDefault = (h: TestHarness, verdict: 'allow' | 'hold' | 'deny') =>
    h.bus.call('tool-policy:set-connector-defaults', h.ctx({ userId: 'admin-1' }), {
      connectorId: 'gmail',
      verdicts: [{ toolKey: SEND, verdict }],
    });

  async function putVerdict(h: TestHarness, verdict: string): Promise<Captured> {
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus: h.bus, initCtx }).setConnectorToolVerdict(
      mkReq({ agentId: AGENT, connectorId: 'gmail' }, { body: { toolKey: SEND, verdict } }),
      res,
    );
    return captured;
  }

  async function evaluate(h: TestHarness): Promise<string> {
    const r = await h.bus.call<unknown, { verdict: string }>(
      'tool-policy:evaluate',
      h.ctx({ agentId: AGENT }),
      { call: { name: SEND, input: {} }, agentId: AGENT },
    );
    return r.verdict;
  }

  it('Ask first and Deny take effect at the gate', async () => {
    const h = await boot();
    expect(await adminDefault(h, 'allow')).toEqual({ ok: true });
    expect(await evaluate(h)).toBe('allow');

    expect(await putVerdict(h, 'hold')).toEqual({
      statusCode: 200,
      body: { tool: { toolKey: SEND, verdict: 'hold', ceiling: 'allow' } },
    });
    expect(await evaluate(h)).toBe('hold');

    expect((await putVerdict(h, 'deny')).statusCode).toBe(200);
    expect(await evaluate(h)).toBe('deny');

    // And the details view reads back the same state the gate enforces.
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus: h.bus, initCtx }).connectorTools(
      mkReq({ agentId: AGENT, connectorId: 'gmail' }),
      res,
    );
    expect(toolsOfAny(captured)).toEqual([
      expect.objectContaining({ toolKey: SEND, verdict: 'deny', ceiling: 'allow' }),
    ]);
  });

  it('cannot loosen past the admin: Allow under an Ask-first ceiling is a 409', async () => {
    const h = await boot();
    expect(await adminDefault(h, 'hold')).toEqual({ ok: true });
    expect(await putVerdict(h, 'allow')).toEqual({
      statusCode: 409,
      body: { error: 'ceiling-violation', ceiling: 'hold' },
    });
    expect(await evaluate(h)).toBe('hold');
  });
});

function toolsOfAny(r: Captured): unknown[] {
  return (r.body as { tools: unknown[] }).tools;
}
