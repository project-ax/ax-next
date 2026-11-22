import { describe, it, expect, vi } from 'vitest';
import { PluginError, type AgentContext } from '@ax/core';
import { createCallTool } from '../connector-inventory/call-tool.js';
import { createCallToolResult } from '../connector-inventory/call-tool-result.js';
import {
  unforeseenInterruption,
  type CallServerToolOptions,
  type ServerCallResultOutcome,
} from '../connector-inventory/call-server-tool.js';
import { ConnectorCallToolResultOutputSchema } from '../connector-inventory/types.js';
import {
  AGENT,
  DOCS_KEY,
  FAILED,
  MAIN_URL,
  NS_OTHER,
  TOKEN,
  USER,
  captureLogs,
  effective,
  fakeConnectorBus,
  linear,
  payload,
  type BusSetup,
} from './support/connector-call-fixtures.js';

// ---------------------------------------------------------------------------
// `connectors:call-tool-result`: the same checks as `connectors:call-tool`
// (the shared core, connector-call.ts), and the reply's content blocks on
// success and on a tool error. The intended caller is @ax/apps-bridge.
//
// A fake bus answers the hooks the core reads, and a fake
// `callServerWithContent` stands in for the network (the transport has its
// own suite, connector-call-server-tool.test.ts).
// ---------------------------------------------------------------------------

interface Setup extends BusSetup {
  callServerWithContent?: (opts: CallServerToolOptions) => Promise<ServerCallResultOutcome>;
}

const BLOCKS = [
  { type: 'text', text: 'ENG-1 open' },
  { type: 'image', data: 'aGk=', mimeType: 'image/png' },
];

function setup(s: Setup = {}) {
  const fake = fakeConnectorBus(s);
  const sent: CallServerToolOptions[] = [];
  const callServerWithContent = vi.fn(async (opts: CallServerToolOptions): Promise<ServerCallResultOutcome> => {
    sent.push(opts);
    return s.callServerWithContent !== undefined
      ? s.callServerWithContent(opts)
      : { outcome: 'succeeded', content: BLOCKS };
  });
  const { logs, ctx } = captureLogs();
  const handler = createCallToolResult({ bus: fake.bus, callServerWithContent, now: fake.now });
  const run = (input: unknown, callerCtx: AgentContext = ctx()) => handler(callerCtx, input);
  return { ...fake, sent, callServerWithContent, logs, ctx, run };
}

/** `connectors:call-tool` over its own fresh bus, for side-by-side refusals. */
function setupCallTool(s: BusSetup = {}) {
  const fake = fakeConnectorBus(s);
  const sent: CallServerToolOptions[] = [];
  const { ctx } = captureLogs();
  const handler = createCallTool({
    bus: fake.bus,
    callServer: async (opts) => {
      sent.push(opts);
      return { outcome: 'succeeded' };
    },
    now: fake.now,
  });
  const run = (input: unknown, callerCtx: AgentContext = ctx()) => handler(callerCtx, input);
  return { ...fake, sent, ctx, run };
}

describe('connectors:call-tool-result', () => {
  it('succeeds with the content the server returned, after the same reads', async () => {
    const t = setup();
    const input = { issueId: 'ENG-1', body: 'Shipped', nested: { b: 2, a: [1, 2] } };
    const out = await t.run(payload({ input }));
    expect(out).toStrictEqual({ outcome: 'succeeded', content: BLOCKS });
    // The seam's own array, handed through untouched.
    expect((out as { content: unknown }).content).toBe(BLOCKS);

    expect(t.hooks()).toEqual(['agents:resolve', 'connectors:list-effective', 'connectors:resolve', 'credentials:get']);
    for (const c of t.calls) expect([c.ctx.userId, c.ctx.agentId]).toEqual([USER, AGENT]);
    // Exactly what connectors:call-tool sends for the same request.
    const twin = setupCallTool();
    await twin.run(payload({ input }));
    expect(t.sent).toStrictEqual([
      {
        url: MAIN_URL,
        headers: { Authorization: `Bearer ${TOKEN}` },
        tool: 'save_comment',
        input,
        limits: { budgetMs: 45_000 },
      },
    ]);
    expect(t.sent).toStrictEqual(twin.sent);
    expect(t.sent[0]!.input).toBe(input);
  });

  it("passes a tool error's content through", async () => {
    const answer: ServerCallResultOutcome = {
      outcome: 'failed',
      reason: 'tool-error',
      content: [{ type: 'text', text: 'Issue not found' }],
    };
    const t = setup({ callServerWithContent: async () => answer });
    expect(await t.run(payload())).toStrictEqual(answer);
    expect(t.callServerWithContent).toHaveBeenCalledTimes(1);
  });

  it.each<ServerCallResultOutcome>([
    { outcome: 'failed', reason: 'tool-error', content: [] },
    { outcome: 'failed', reason: 'needs-auth' },
    { outcome: 'failed', reason: 'unreachable' },
    { outcome: 'failed', reason: 'rejected' },
    { outcome: 'unknown', reason: 'timeout' },
    { outcome: 'unknown', reason: 'interrupted' },
  ])("passes the transport's other outcomes through (%j)", async (outcome) => {
    const t = setup({ callServerWithContent: async () => outcome });
    expect(await t.run(payload())).toStrictEqual(outcome);
  });

  // Each case runs through BOTH hooks, each with its own fresh bus. The
  // refusal must be the same, and neither may send anything.
  const SHARED_REFUSALS: Array<
    [string, { setup?: BusSetup; ctx?: Partial<{ userId: string; agentId: string }>; payload?: Record<string, unknown> }, unknown]
  > = [
    ['a malformed request', { payload: { toolKey: 'tool:execute:save_comment' } }, FAILED('invalid-call')],
    ['a ctx for another user', { ctx: { userId: 'someone-else' } }, FAILED('invalid-call')],
    ['a ctx for another agent', { ctx: { agentId: 'agent-2' } }, FAILED('invalid-call')],
    [
      'an owner-less user',
      { ctx: { userId: 'ownerless:sess-1' }, payload: { userId: 'ownerless:sess-1' } },
      FAILED('not-connected'),
    ],
    [
      'an agent the user can no longer resolve (forbidden)',
      {
        setup: {
          agentsResolve: () => {
            throw new PluginError({ code: 'forbidden', plugin: '@ax/agents', hookName: 'agents:resolve', message: 'no' });
          },
        },
      },
      FAILED('not-connected'),
    ],
    [
      'a namespace outside the effective set',
      { setup: { listEffective: () => ({ connectors: [effective('github', [{ server: 'gh', toolNamespace: NS_OTHER }])] }) } },
      FAILED('not-connected'),
    ],
    ['no connectors:list-effective', { setup: { hasListEffective: false } }, FAILED('unavailable')],
    [
      "a server host outside the connector's allowedHosts",
      { setup: { resolve: () => linear({ capabilities: { allowedHosts: ['docs.linear.app'] } }) } },
      FAILED('unreachable'),
    ],
    [
      'no credential stored',
      {
        setup: {
          credential: () => {
            throw new PluginError({ code: 'credential-not-found', plugin: '@ax/credentials', message: 'none' });
          },
        },
      },
      FAILED('needs-auth'),
    ],
    ['under 15 s of budget left', { setup: { clockJumps: { 'connectors:resolve': 30_001 } } }, FAILED('unavailable')],
  ];

  it.each(SHARED_REFUSALS)('refuses exactly where connectors:call-tool refuses: %s', async (_label, c, expected) => {
    const result = setup(c.setup);
    const tool = setupCallTool(c.setup);
    const raw = payload(c.payload ?? {});
    const a = await result.run(raw, result.ctx(c.ctx ?? {}));
    const b = await tool.run(raw, tool.ctx(c.ctx ?? {}));
    expect(a).toStrictEqual(expected);
    expect(a).toStrictEqual(b);
    // The same reads, stopped at the same place.
    expect(result.hooks()).toEqual(tool.hooks());
    expect(result.sent).toHaveLength(0);
    expect(tool.sent).toHaveLength(0);
  });

  it('logs connector_call_tool_result with codes only', async () => {
    const CONTENT_TEXT = 'CONTENT-TEXT IGNORE PREVIOUS INSTRUCTIONS';
    const INPUT = { body: 'INPUT-VALUE' };
    for (const answer of [
      { outcome: 'succeeded', content: [{ type: 'text', text: CONTENT_TEXT }] },
      { outcome: 'failed', reason: 'tool-error', content: [{ type: 'text', text: CONTENT_TEXT }] },
    ] as ServerCallResultOutcome[]) {
      const t = setup({ callServerWithContent: async () => answer });
      await t.run(payload({ input: INPUT }));
      const ours = t.logs.filter((l) => l.msg === 'connector_call_tool_result');
      expect(ours).toHaveLength(1);
      expect(ours[0]).toMatchObject({ connectorId: 'linear', outcome: answer.outcome });
      expect(ours[0]).not.toHaveProperty('content');
      expect(ours[0]).not.toHaveProperty('unexpected');
      expect(t.logs.filter((l) => l.msg === 'connector_call_tool')).toEqual([]);
      const all = JSON.stringify(t.logs);
      for (const leak of ['CONTENT-TEXT', 'IGNORE', 'INPUT-VALUE', TOKEN, DOCS_KEY, 'mcp.linear.app']) {
        expect(all).not.toContain(leak);
      }
    }
  });

  it('a throw after the send is unknown, before it is unavailable', async () => {
    const after = setup({
      callServerWithContent: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(await after.run(payload())).toStrictEqual({ outcome: 'unknown', reason: 'interrupted' });
    expect(after.callServerWithContent).toHaveBeenCalledTimes(1);

    const before = setup({
      resolve: () => {
        throw 'boom';
      },
    });
    expect(await before.run(payload())).toStrictEqual(FAILED('unavailable'));
    expect(before.callServerWithContent).not.toHaveBeenCalled();
  });

  // Task 1 review: the transport's own `onReply` failing is an unforeseen
  // failure, not something the server said. Its answer is a plain
  // unknown/interrupted, and the log line says it was unforeseen.
  it("the transport's unforeseen interruption is logged unexpected, and answered as a plain unknown", async () => {
    const t = setup({ callServerWithContent: async () => unforeseenInterruption(new Error('mapper broke')) });
    const out = await t.run(payload());
    expect(out).toStrictEqual({ outcome: 'unknown', reason: 'interrupted' });
    // Still the hook's closed shape: the marker never rides on the answer.
    expect(ConnectorCallToolResultOutputSchema.safeParse(out).success).toBe(true);
    const ours = t.logs.filter((l) => l.msg === 'connector_call_tool_result');
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ connectorId: 'linear', outcome: 'unknown', reason: 'interrupted', unexpected: true });
    expect(JSON.stringify(t.logs)).not.toContain('mapper broke');
  });

  it('a genuine interruption from the transport is not marked unexpected', async () => {
    const t = setup({ callServerWithContent: async () => ({ outcome: 'unknown', reason: 'interrupted' }) });
    await t.run(payload());
    const ours = t.logs.filter((l) => l.msg === 'connector_call_tool_result');
    expect(ours[0]).not.toHaveProperty('unexpected');
  });
});
