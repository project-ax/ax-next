import { describe, it, expect, vi } from 'vitest';
import { PluginError, createLogger, makeAgentContext, type AgentContext } from '@ax/core';
import { createCallTool, type CallToolDeps } from '../connector-inventory/call-tool.js';
import type { CallServerToolOptions, ServerCallOutcome } from '../connector-inventory/call-server-tool.js';
import { ConnectorCallToolOutputSchema } from '../connector-inventory/types.js';

// ---------------------------------------------------------------------------
// TASK-1046 — `connectors:call-tool`: the host makes ONE call a person
// approved, after re-deriving access from the decision's user and agent.
//
// A fake bus answers the hooks the handler reads, and a fake `callServer`
// stands in for the network (the transport has its own suite,
// connector-call-server-tool.test.ts). Each case asserts the exact outcome
// and what was asked or sent: every check runs before the send, so a miss
// must reach no server at all, and usually stops the reads where it is found.
// ---------------------------------------------------------------------------

const USER = 'owner-1';
const AGENT = 'agent-1';
/** linear's `main` server: the one the approved call names. */
const NS = 'c0123456789';
/** linear's `docs` server: same connector, other server, its own key. */
const NS_DOCS = 'c00000000aa';
/** Another connector the agent also has. */
const NS_OTHER = 'cfedcba9876';
const MAIN_URL = 'https://mcp.linear.app/mcp';
const DOCS_URL = 'https://docs.linear.app/mcp';
const TOKEN = 'tok-SECRET-main';
const DOCS_KEY = 'key-SECRET-docs';
const TOOL_KEY = `mcp.${NS}.save_comment`;

type Json = Record<string, unknown>;

/** `connectors:resolve`'s answer for linear: two servers, each with its own credential. */
function linear(over: { capabilities?: Json; toolNamespaces?: unknown; credentialPlan?: unknown } = {}) {
  return {
    id: 'linear',
    keyMode: 'personal',
    usageNote: '',
    capabilities: {
      allowedHosts: ['docs.linear.app', 'mcp.linear.app'],
      credentials: [
        { slot: 'docs-key', kind: 'api-key', headerName: 'X-Docs-Key', server: 'docs' },
        { slot: 'token', kind: 'oauth', server: 'main' },
      ],
      mcpServers: [
        { name: 'docs', transport: 'http', url: DOCS_URL, allowedHosts: ['docs.linear.app'], credentials: [] },
        { name: 'main', transport: 'http', url: MAIN_URL, allowedHosts: ['mcp.linear.app'], credentials: [] },
      ],
      packages: { npm: [], pypi: [] },
      services: [],
      ...over.capabilities,
    },
    credentialPlan: over.credentialPlan ?? [
      { slot: 'docs-key', scope: 'agent', ref: 'account:linear:docs-key', service: 'linear', slotTag: 'docs-key' },
      { slot: 'token', scope: 'agent', ref: 'account:linear:token', service: 'linear', slotTag: 'token' },
    ],
    toolNamespaces: over.toolNamespaces ?? [
      { server: 'docs', toolNamespace: NS_DOCS },
      { server: 'main', toolNamespace: NS },
    ],
  };
}

/** One `connectors:list-effective` entry. */
function effective(id: string, toolNamespaces: Array<{ server: string; toolNamespace: string }>) {
  return {
    summary: {
      id,
      name: id,
      description: '',
      usageNote: '',
      keyMode: 'personal',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      canEdit: true,
      requiresAttachment: true,
    },
    source: 'attached',
    capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] }, services: [] },
    toolNamespaces,
  };
}

/** The agent's effective set: linear is second, so a "first entry" shortcut is wrong. */
const EFFECTIVE = () => ({
  connectors: [
    effective('github', [{ server: 'gh', toolNamespace: NS_OTHER }]),
    effective('linear', [
      { server: 'docs', toolNamespace: NS_DOCS },
      { server: 'main', toolNamespace: NS },
    ]),
  ],
});

const AGENT_ROW = () => ({
  agent: {
    id: AGENT,
    ownerId: USER,
    ownerType: 'user',
    connectorAttachments: ['github', 'linear'],
    connectorExclusions: ['old-crm'],
  },
});

const CREDENTIALS: Record<string, string> = {
  'account:linear:token': TOKEN,
  'account:linear:docs-key': DOCS_KEY,
};

interface Setup {
  agentsResolve?: () => unknown;
  listEffective?: () => unknown;
  /** Default true. */
  hasListEffective?: boolean;
  resolve?: () => unknown;
  credential?: (ref: string) => unknown;
  callServer?: (opts: CallServerToolOptions) => Promise<ServerCallOutcome>;
  /** How far the clock moves while each hook is being answered. */
  clockJumps?: Partial<Record<string, number>>;
}

function setup(s: Setup = {}) {
  let clock = 1_800_000_000_000;
  const calls: Array<{ hook: string; ctx: AgentContext; input: unknown }> = [];
  const bus: CallToolDeps['bus'] = {
    async call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O> {
      calls.push({ hook, ctx, input });
      clock += s.clockJumps?.[hook] ?? 0;
      switch (hook) {
        case 'agents:resolve':
          return (s.agentsResolve ?? AGENT_ROW)() as O;
        case 'connectors:list-effective':
          return (s.listEffective ?? EFFECTIVE)() as O;
        case 'connectors:resolve':
          return (s.resolve ?? (() => linear()))() as O;
        case 'credentials:get': {
          const { ref } = input as { ref: string };
          return (s.credential ?? ((r: string) => CREDENTIALS[r]))(ref) as O;
        }
        default:
          throw new Error(`unexpected hook ${hook}`);
      }
    },
    hasService: (hook) => hook !== 'connectors:list-effective' || s.hasListEffective !== false,
  };
  const sent: CallServerToolOptions[] = [];
  const callServer = vi.fn(async (opts: CallServerToolOptions): Promise<ServerCallOutcome> => {
    sent.push(opts);
    return s.callServer !== undefined ? s.callServer(opts) : { outcome: 'succeeded' };
  });
  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({ reqId: 'r', writer: (line) => logs.push(JSON.parse(line) as Record<string, unknown>) });
  const callTool = createCallTool({ bus, callServer, now: () => clock });
  const ctx = (over: Partial<{ userId: string; agentId: string }> = {}) =>
    makeAgentContext({ sessionId: 'decision-replay', userId: USER, agentId: AGENT, logger, ...over });
  const run = (input: unknown, callerCtx: AgentContext = ctx()) => callTool(callerCtx, input);
  const hooks = () => calls.map((c) => c.hook);
  return { calls, hooks, sent, callServer, logs, ctx, run };
}

const payload = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  agentId: AGENT,
  toolKey: TOOL_KEY,
  input: { issueId: 'ENG-1', body: 'Shipped' },
  ...over,
});

const FAILED = (reason: string) => ({ outcome: 'failed', reason });

describe('connectors:call-tool', () => {
  it("maps the namespace through the agent's effective set and sends the original input", async () => {
    const t = setup();
    const input = { issueId: 'ENG-1', body: 'Shipped ✓', nested: { b: 2, a: [1, 2] } };
    expect(await t.run(payload({ input }))).toStrictEqual({ outcome: 'succeeded' });

    // The resolved `main` server, its own credential (not docs'), the bare MCP
    // tool name, and the very object the caller passed: not a parsed copy.
    expect(t.sent).toStrictEqual([
      {
        url: MAIN_URL,
        headers: { Authorization: `Bearer ${TOKEN}` },
        tool: 'save_comment',
        input,
        limits: { budgetMs: 45_000 },
      },
    ]);
    expect(t.sent[0]!.input).toBe(input);

    // Every read ran as the decision's owner and agent, in this order.
    expect(t.hooks()).toEqual(['agents:resolve', 'connectors:list-effective', 'connectors:resolve', 'credentials:get']);
    for (const c of t.calls) expect([c.ctx.userId, c.ctx.agentId]).toEqual([USER, AGENT]);
    expect(t.calls[0]!.input).toStrictEqual({ agentId: AGENT, userId: USER });
    // The agent row's own lists: the same union a session folds.
    expect(t.calls[1]!.input).toStrictEqual({
      userId: USER,
      attachmentIds: ['github', 'linear'],
      exclusions: ['old-crm'],
    });
    expect(t.calls[2]!.input).toStrictEqual({ userId: USER, connectorId: 'linear' });
    expect(t.calls[3]!.input).toStrictEqual({ ref: 'account:linear:token', userId: USER });
  });

  it.each([[[]], [null], ['text']])(
    'input that is not a plain object is invalid-call and nothing is sent (%j)',
    async (input) => {
      const t = setup();
      expect(await t.run(payload({ input }))).toStrictEqual(FAILED('invalid-call'));
      expect(t.callServer).not.toHaveBeenCalled();
      expect(t.calls).toEqual([]);
    },
  );

  it.each<[string, unknown]>([
    ['not an object at all', null],
    ['no input', { userId: USER, agentId: AGENT, toolKey: TOOL_KEY }],
    ['an unknown field', payload({ arguments: {} })],
    ['an empty user', payload({ userId: '' })],
    ['an over-long agent', payload({ agentId: 'a'.repeat(257) })],
    ['a non-connector key', payload({ toolKey: 'tool:execute:save_comment' })],
    ['a namespace that is not one we mint', payload({ toolKey: 'mcp.cABCDEF0123.save_comment' })],
    ['an empty tool name', payload({ toolKey: `mcp.${NS}.` })],
    ['a tool name with a space', payload({ toolKey: `mcp.${NS}.save comment` })],
    ['an over-long tool name', payload({ toolKey: `mcp.${NS}.${'x'.repeat(129)}` })],
  ])('a malformed request (%s) is invalid-call and nothing is asked or sent', async (_label, raw) => {
    const t = setup();
    expect(await t.run(raw)).toStrictEqual(FAILED('invalid-call'));
    expect(t.calls).toEqual([]);
    expect(t.callServer).not.toHaveBeenCalled();
  });

  it.each([
    ['another user', { userId: 'someone-else' }],
    ['another agent', { agentId: 'agent-2' }],
  ])('a ctx for %s is refused', async (_label, over) => {
    const t = setup();
    expect(await t.run(payload(), t.ctx(over))).toStrictEqual(FAILED('invalid-call'));
    expect(t.calls).toEqual([]);
    expect(t.callServer).not.toHaveBeenCalled();
  });

  it.each([
    ['user', { userId: 'ownerless:sess-1' }],
    ['agent', { agentId: 'ownerless:sess-1' }],
  ])('an owner-less %s is not-connected and nothing is asked', async (_label, over) => {
    const t = setup();
    expect(await t.run(payload(over), t.ctx(over))).toStrictEqual(FAILED('not-connected'));
    expect(t.calls).toEqual([]);
    expect(t.callServer).not.toHaveBeenCalled();
  });

  it.each(['forbidden', 'not-found'])(
    'an agent the user can no longer resolve (%s) is not-connected',
    async (code) => {
      const t = setup({
        agentsResolve: () => {
          throw new PluginError({ code, plugin: '@ax/agents', hookName: 'agents:resolve', message: 'no' });
        },
      });
      expect(await t.run(payload())).toStrictEqual(FAILED('not-connected'));
      expect(t.hooks()).toEqual(['agents:resolve']);
      expect(t.callServer).not.toHaveBeenCalled();
    },
  );

  it.each<[string, () => never]>([
    [
      'a plain error',
      () => {
        throw new Error('db down');
      },
    ],
    [
      'a bus timeout',
      () => {
        throw new PluginError({ code: 'timeout', plugin: '@ax/agents', message: 'slow' });
      },
    ],
  ])('an agent lookup that fails for another reason (%s) is unavailable', async (_label, agentsResolve) => {
    const t = setup({ agentsResolve });
    expect(await t.run(payload())).toStrictEqual(FAILED('unavailable'));
    expect(t.hooks()).toEqual(['agents:resolve']);
    expect(t.callServer).not.toHaveBeenCalled();
  });

  it('a namespace outside the effective set is not-connected', async () => {
    // linear is detached: the agent only has github now.
    const t = setup({ listEffective: () => ({ connectors: [effective('github', [{ server: 'gh', toolNamespace: NS_OTHER }])] }) });
    expect(await t.run(payload())).toStrictEqual(FAILED('not-connected'));
    expect(t.hooks()).toEqual(['agents:resolve', 'connectors:list-effective']);
    expect(t.callServer).not.toHaveBeenCalled();
  });

  it('missing connectors:list-effective fails closed as unavailable', async () => {
    const t = setup({ hasListEffective: false });
    expect(await t.run(payload())).toStrictEqual(FAILED('unavailable'));
    expect(t.hooks()).toEqual(['agents:resolve']);
    expect(t.callServer).not.toHaveBeenCalled();
  });

  it('a connectors:list-effective that throws is unavailable', async () => {
    const t = setup({
      listEffective: () => {
        throw new PluginError({ code: 'invalid-payload', plugin: '@ax/connectors', message: 'no' });
      },
    });
    expect(await t.run(payload())).toStrictEqual(FAILED('unavailable'));
    expect(t.hooks()).toEqual(['agents:resolve', 'connectors:list-effective']);
    expect(t.callServer).not.toHaveBeenCalled();
  });

  it.each<[string, () => unknown]>([
    [
      'the connector no longer resolves',
      () => {
        throw new PluginError({ code: 'not-found', plugin: '@ax/connectors', message: 'gone' });
      },
    ],
    ['the resolved record no longer carries the namespace', () => linear({ toolNamespaces: [{ server: 'docs', toolNamespace: NS_DOCS }] })],
    [
      "the namespace's server is gone",
      () =>
        linear({
          capabilities: {
            mcpServers: [{ name: 'docs', transport: 'http', url: DOCS_URL, allowedHosts: [], credentials: [] }],
          },
        }),
    ],
    [
      'the server has no url',
      () =>
        linear({
          capabilities: { mcpServers: [{ name: 'main', transport: 'http', allowedHosts: [], credentials: [] }] },
        }),
    ],
    [
      'the server url is empty',
      () =>
        linear({
          capabilities: { mcpServers: [{ name: 'main', transport: 'http', url: '', allowedHosts: [], credentials: [] }] },
        }),
    ],
  ])('%s: not-connected, no credential read, nothing sent', async (_label, resolve) => {
    const t = setup({ resolve });
    expect(await t.run(payload())).toStrictEqual(FAILED('not-connected'));
    expect(t.hooks()).toEqual(['agents:resolve', 'connectors:list-effective', 'connectors:resolve']);
    expect(t.callServer).not.toHaveBeenCalled();
  });

  it('a connectors:resolve that fails for another reason is unavailable', async () => {
    const t = setup({
      resolve: () => {
        throw new PluginError({ code: 'corrupt-row', plugin: '@ax/connectors', message: 'bad row' });
      },
    });
    expect(await t.run(payload())).toStrictEqual(FAILED('unavailable'));
    expect(t.callServer).not.toHaveBeenCalled();
  });

  const mainServer = (url: string) => ({
    mcpServers: [{ name: 'main', transport: 'http', url, allowedHosts: [], credentials: [] }],
  });
  it.each<[string, Json]>([
    ["a server host outside the connector's allowedHosts", { allowedHosts: ['docs.linear.app'] }],
    ['an http url', mainServer('http://mcp.linear.app/mcp')],
    ['a url with credentials in it', mainServer('https://user:pw@mcp.linear.app/mcp')],
    ['a url with a fragment', mainServer('https://mcp.linear.app/mcp#frag')],
    ['a private address, even if allowed', { ...mainServer('https://10.0.0.5/mcp'), allowedHosts: ['10.0.0.5'] }],
    ['a url that does not parse', mainServer('https://')],
  ])('%s is unreachable and nothing is sent', async (_label, capabilities) => {
    const t = setup({ resolve: () => linear({ capabilities }) });
    expect(await t.run(payload())).toStrictEqual(FAILED('unreachable'));
    // Refused before any credential is read.
    expect(t.hooks()).toEqual(['agents:resolve', 'connectors:list-effective', 'connectors:resolve']);
    expect(t.callServer).not.toHaveBeenCalled();
  });

  it("an IPv6 server is matched against allowedHosts without its brackets, the session proxy's rule", async () => {
    const url = 'https://[2606:4700:4700::1111]/mcp';
    const t = setup({ resolve: () => linear({ capabilities: { ...mainServer(url), allowedHosts: ['2606:4700:4700::1111'] } }) });
    expect(await t.run(payload())).toStrictEqual({ outcome: 'succeeded' });
    expect(t.sent.map((o) => o.url)).toEqual([url]);
  });

  it.each<[string, string, Setup]>([
    [
      'nothing stored for the sign-in',
      'needs-auth',
      {
        credential: () => {
          throw new PluginError({ code: 'credential-not-found', plugin: '@ax/credentials', message: 'none' });
        },
      },
    ],
    [
      'a sign-in the provider rejected',
      'needs-auth',
      {
        credential: () => {
          const err = new Error('reconnect');
          err.name = 'NeedsReconnectError';
          throw err;
        },
      },
    ],
    ['an empty credential', 'needs-auth', { credential: () => '' }],
    ['no plan ref for the slot', 'needs-auth', { resolve: () => linear({ credentialPlan: [] }) }],
    [
      'a vault blip',
      'unavailable',
      {
        credential: () => {
          throw new Error('vault down');
        },
      },
    ],
  ])('%s: failed/%s, and nothing is sent', async (_label, reason, s) => {
    const t = setup(s);
    expect(await t.run(payload())).toStrictEqual(FAILED(reason));
    expect(t.callServer).not.toHaveBeenCalled();
  });

  it.each<ServerCallOutcome>([
    { outcome: 'succeeded' },
    { outcome: 'failed', reason: 'needs-auth' },
    { outcome: 'failed', reason: 'unreachable' },
    { outcome: 'failed', reason: 'rejected' },
    { outcome: 'unknown', reason: 'timeout' },
    { outcome: 'unknown', reason: 'interrupted' },
  ])("passes the transport's outcome through (%j)", async (outcome) => {
    const t = setup({ callServer: async () => outcome });
    expect(await t.run(payload())).toStrictEqual(outcome);
    expect(t.callServer).toHaveBeenCalledTimes(1);
  });

  it('a throw after the send is unknown, before it is unavailable', async () => {
    const after = setup({
      callServer: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(await after.run(payload())).toStrictEqual({ outcome: 'unknown', reason: 'interrupted' });
    expect(after.callServer).toHaveBeenCalledTimes(1);

    // A thrown non-Error from a hook, and an answer too broken to read: both
    // before the send, so both are a definite "nothing went out".
    const thrown = setup({
      resolve: () => {
        throw 'boom';
      },
    });
    expect(await thrown.run(payload())).toStrictEqual(FAILED('unavailable'));
    expect(thrown.callServer).not.toHaveBeenCalled();
    const broken = setup({
      resolve: () => ({ id: 'linear', toolNamespaces: [{ server: 'main', toolNamespace: NS }], credentialPlan: [] }),
    });
    expect(await broken.run(payload())).toStrictEqual(FAILED('unavailable'));
    expect(broken.callServer).not.toHaveBeenCalled();
  });

  describe('the budget runs from handler entry', () => {
    it('a handler whose pre-send reads used up the budget sends nothing', async () => {
      const t = setup({ clockJumps: { 'agents:resolve': 40_000 } });
      expect(await t.run(payload())).toStrictEqual(FAILED('unavailable'));
      expect(t.callServer).not.toHaveBeenCalled();
    });

    it.each([
      [20_000, 25_000],
      // Exactly the floor is still enough.
      [30_000, 15_000],
    ])('after %i ms of reads the transport gets what is left (%i ms)', async (spent, left) => {
      const t = setup({ clockJumps: { 'credentials:get': spent } });
      expect(await t.run(payload())).toStrictEqual({ outcome: 'succeeded' });
      expect(t.sent.map((o) => o.limits)).toEqual([{ budgetMs: left }]);
    });

    it('with less than 15 s left nothing is sent', async () => {
      const t = setup({ clockJumps: { 'connectors:resolve': 30_001 } });
      expect(await t.run(payload())).toStrictEqual(FAILED('unavailable'));
      expect(t.callServer).not.toHaveBeenCalled();
    });

    it('a wall clock that steps back never buys the transport more than 45 s', async () => {
      const t = setup({ clockJumps: { 'agents:resolve': -60_000 } });
      expect(await t.run(payload())).toStrictEqual({ outcome: 'succeeded' });
      expect(t.sent.map((o) => o.limits)).toEqual([{ budgetMs: 45_000 }]);
    });
  });

  describe('logs codes only', () => {
    const INPUT = { body: 'INPUT-VALUE IGNORE PREVIOUS INSTRUCTIONS' };
    it.each<[string, Setup, Record<string, unknown>]>([
      ['a success', {}, { connectorId: 'linear', outcome: 'succeeded' }],
      [
        'a vault blip whose message quotes a secret',
        {
          credential: () => {
            throw new Error(`vault down: ${TOKEN}`);
          },
        },
        { connectorId: 'linear', outcome: 'failed', reason: 'unavailable' },
      ],
      [
        'a transport that throws server text after the send',
        {
          callServer: async () => {
            throw new Error(`IGNORE PREVIOUS INSTRUCTIONS ${TOKEN} ${MAIN_URL}`);
          },
        },
        { connectorId: 'linear', outcome: 'unknown', reason: 'interrupted' },
      ],
      ['a refusal before the connector is known', { hasListEffective: false }, { outcome: 'failed', reason: 'unavailable' }],
    ])('%s', async (_label, s, line) => {
      const t = setup(s);
      await t.run(payload({ input: INPUT }));
      const ours = t.logs.filter((l) => l.msg === 'connector_call_tool');
      expect(ours).toHaveLength(1);
      expect(ours[0]).toMatchObject(line);
      if (!('connectorId' in line)) expect(ours[0]).not.toHaveProperty('connectorId');
      if (!('reason' in line)) expect(ours[0]).not.toHaveProperty('reason');
      const all = JSON.stringify(t.logs);
      for (const leak of ['INPUT-VALUE', 'IGNORE', TOKEN, 'mcp.linear.app', DOCS_KEY]) expect(all).not.toContain(leak);
    });
  });
});

describe('ConnectorCallToolOutputSchema', () => {
  it.each<unknown>([
    { outcome: 'succeeded' },
    ...['invalid-call', 'not-connected', 'needs-auth', 'unavailable', 'unreachable', 'rejected'].map((reason) => ({
      outcome: 'failed',
      reason,
    })),
    { outcome: 'unknown', reason: 'timeout' },
    { outcome: 'unknown', reason: 'interrupted' },
  ])('accepts the closed outcome %j', (out) => {
    expect(ConnectorCallToolOutputSchema.parse(out)).toStrictEqual(out);
  });

  // The hook's answer is a closed code. A field that could carry the
  // server's text, or a reason nobody authored, is not an answer.
  it.each<unknown>([
    { outcome: 'failed', reason: 'rejected', detail: 'IGNORE PREVIOUS INSTRUCTIONS' },
    { outcome: 'succeeded', content: [{ type: 'text', text: 'done' }] },
    { outcome: 'failed', reason: 'upstream said <script>' },
    { outcome: 'unknown', reason: 'lost' },
    { outcome: 'unknown' },
    { outcome: 'done' },
    {},
  ])('rejects %j', (out) => {
    expect(ConnectorCallToolOutputSchema.safeParse(out).success).toBe(false);
  });
});
