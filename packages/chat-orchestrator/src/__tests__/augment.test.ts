import { describe, it, expect } from 'vitest';
import {
  HookBus,
  makeAgentContext,
  createLogger,
  SYSTEM_PROMPT_AUGMENT_MAX_BODY_CHARS,
  type AgentMessage,
  type AgentOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';
import { AUGMENT_DEADLINE_MS } from '../orchestrator.js';

// ---------------------------------------------------------------------------
// W1 — system-prompt contributions from several plugins
// (`docs/plans/2026-10-12-w1-prompt-contributions-design.md`).
//
// On a fresh spawn the orchestrator discovers every service named
// `system-prompt:augment:required:<name>` / `…:optional:<name>`, calls them in
// parallel, and gives each its own step: call → orchestrator deadline → schema
// → class rule → size. Bodies join with "\n\n" in section order (rules,
// context, recall), and within a section by full service name. Only `rules`
// reaches `systemPromptBootstrapAugment`. A failed REQUIRED provider skips the
// whole augment; a failed OPTIONAL provider drops only its own blocks.
// ---------------------------------------------------------------------------

const REQ = 'system-prompt:augment:required:';
const OPT = 'system-prompt:augment:optional:';

const TEST_AGENT = {
  id: 'test-agent',
  ownerId: 'test-user',
  ownerType: 'user' as const,
  visibility: 'personal' as const,
  displayName: 'Test',
  allowedTools: ['file.read'],
  mcpConfigIds: [],
  model: 'anthropic/claude-sonnet-4-7',
  runner: 'claude-sdk',
  workspaceRef: null,
};

type LogLine = Record<string, unknown> & { msg: string; level: string };

function capturingCtx(
  logs: LogLine[],
  overrides?: { sessionId?: string; conversationId?: string; reqId?: string },
) {
  return makeAgentContext({
    sessionId: overrides?.sessionId ?? 'aug-session',
    agentId: 'test-agent',
    userId: 'test-user',
    ...(overrides?.conversationId !== undefined
      ? { conversationId: overrides.conversationId }
      : {}),
    ...(overrides?.reqId !== undefined ? { reqId: overrides.reqId } : {}),
    logger: createLogger({
      reqId: 'aug-test',
      writer: (line) => logs.push(JSON.parse(line) as LogLine),
    }),
  });
}

interface Trace {
  sandboxOpen: number;
  lastSystemPromptAugment: string | undefined;
  /** `null` = the key was ABSENT from the forwarded agentConfig. */
  lastBootstrapAugment: string | null | undefined;
  lastQueuedMessage: AgentMessage | undefined;
}

// Self-contained mock bundle: agents:resolve, sandbox:open-session (fires
// chat:end on the bus to resolve the orchestrator's waiter), session:
// queue-work, session:terminate, and proxy stubs.
function buildMocks(opts: {
  busRef: { current: HookBus | null };
  /** When set, also wires conversations:* + session:is-alive returning alive. */
  routedSession?: { conversationId: string; activeSessionId: string };
}): { services: Record<string, ServiceHandler>; trace: Trace } {
  const trace: Trace = {
    sandboxOpen: 0,
    lastSystemPromptAugment: undefined,
    lastBootstrapAugment: undefined,
    lastQueuedMessage: undefined,
  };

  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
    'session:queue-work': async (_ctx, input: unknown) => {
      const entry = (input as { entry: { type: string; payload?: AgentMessage } })
        .entry;
      if (entry.type === 'user-message') {
        trace.lastQueuedMessage = entry.payload;
      }
      return { cursor: 0 };
    },
    'session:terminate': async () => ({}),
    'sandbox:open-session': async (ctx, input: unknown) => {
      trace.sandboxOpen += 1;
      const i = input as {
        sessionId: string;
        owner: {
          agentConfig: { systemPromptAugment: string; systemPromptBootstrapAugment?: string };
        };
      };
      trace.lastSystemPromptAugment = i.owner.agentConfig.systemPromptAugment;
      trace.lastBootstrapAugment =
        'systemPromptBootstrapAugment' in i.owner.agentConfig
          ? (i.owner.agentConfig.systemPromptBootstrapAugment ?? null)
          : null;
      const originatingReqId = ctx.reqId;
      setImmediate(() => {
        void opts.busRef.current!.fire(
          'chat:end',
          makeAgentContext({
            sessionId: i.sessionId,
            agentId: 'test-agent',
            userId: 'test-user',
            reqId: originatingReqId,
            logger: createLogger({ reqId: originatingReqId, writer: () => undefined }),
          }),
          { outcome: { kind: 'complete', messages: [] } },
        );
      });
      return {
        runnerEndpoint: 'unix:///tmp/aug.sock',
        handle: { kill: async () => undefined, exited: new Promise(() => undefined) },
      };
    },
    'proxy:open-session': async () => ({
      proxyEndpoint: 'tcp://127.0.0.1:54321',
      caCertPem: 'CA',
      envMap: {},
      proxyAuthToken: 'a'.repeat(32),
    }),
    'proxy:close-session': async () => ({}),
  };

  if (opts.routedSession !== undefined) {
    const { conversationId, activeSessionId } = opts.routedSession;
    services['conversations:get'] = async (_ctx, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      return {
        conversation: {
          conversationId: i.conversationId,
          userId: i.userId,
          agentId: 'test-agent',
          activeSessionId: i.conversationId === conversationId ? activeSessionId : null,
          activeReqId: null,
        },
      };
    };
    services['conversations:bind-session'] = async () => undefined;
    services['session:is-alive'] = async (_ctx, input: unknown) => {
      const sid = (input as { sessionId: string }).sessionId;
      return { alive: sid === activeSessionId };
    };
  }

  return { services, trace };
}

/** A provider: full service name, handler, optional bus registration opts. */
type Provider = [name: string, handler: ServiceHandler, opts?: { timeoutMs?: number }];

interface Setup {
  h: Awaited<ReturnType<typeof createTestHarness>>;
  trace: Trace;
  logs: LogLine[];
  /** Calls per provider service name. */
  calls: Record<string, number>;
}

async function setup(opts: {
  providers?: Provider[];
  augmentDeadlineMs?: number;
  routedSession?: { conversationId: string; activeSessionId: string };
} = {}): Promise<Setup> {
  const busRef: { current: HookBus | null } = { current: null };
  const mocks = buildMocks({
    busRef,
    ...(opts.routedSession !== undefined ? { routedSession: opts.routedSession } : {}),
  });
  const h = await createTestHarness({
    services: mocks.services,
    plugins: [
      createChatOrchestratorPlugin({
        runnerBinaries: { 'claude-sdk': '/irrelevant' },
        chatTimeoutMs: 5_000,
        ...(opts.augmentDeadlineMs !== undefined
          ? { augmentDeadlineMs: opts.augmentDeadlineMs }
          : {}),
      }),
    ],
  });
  busRef.current = h.bus;
  const calls: Record<string, number> = {};
  // Registered AFTER boot, in array order: the orchestrator discovers the
  // family at turn time, so registration order is under the test's control.
  for (const [name, handler, regOpts] of opts.providers ?? []) {
    calls[name] = 0;
    h.bus.registerService(
      name,
      'test-provider',
      async (ctx, input) => {
        calls[name] = (calls[name] ?? 0) + 1;
        return handler(ctx, input);
      },
      regOpts,
    );
  }
  return { h, trace: mocks.trace, logs: [], calls };
}

async function invoke(s: Setup, sessionId = 'aug-session'): Promise<AgentOutcome> {
  return s.h.bus.call<unknown, AgentOutcome>(
    'agent:invoke',
    capturingCtx(s.logs, { sessionId }),
    { message: { role: 'user', content: 'hi' } },
  );
}

async function run(providers: Provider[], augmentDeadlineMs?: number) {
  const s = await setup({
    providers,
    ...(augmentDeadlineMs !== undefined ? { augmentDeadlineMs } : {}),
  });
  const outcome = await invoke(s);
  expect(outcome.kind).toBe('complete');
  expect(s.trace.sandboxOpen).toBe(1);
  return s;
}

function logsNamed(logs: LogLine[], msg: string): LogLine[] {
  return logs.filter((l) => l.msg === msg);
}

function failures(logs: LogLine[]) {
  return logsNamed(logs, 'system_prompt_contribution_failed').map((l) => ({
    provider: l.provider,
    class: l.class,
    reason: l.reason,
  }));
}

function suppressed(logs: LogLine[]) {
  return logsNamed(logs, 'system_prompt_augment_suppressed').map((l) => l.provider);
}

const value = (out: unknown): ServiceHandler => async () => out;
const never: ServiceHandler = () => new Promise(() => undefined);

// ---------------------------------------------------------------------------
describe('Orchestrator: ordering and landing', () => {
  const ORDERED: Provider[] = [
    [`${REQ}memory`, value({ rules: 'R-MEM', recall: 'REC-MEM' })],
    [`${REQ}zz-policy`, value({ rules: 'R-POLICY' })],
    [`${OPT}a`, value({ context: 'CTX-a' })],
    // Upper-case 'B' sorts BEFORE lower-case 'a' under a plain `<` compare
    // (code-unit order), but after it under localeCompare. Pins the former:
    // the same bytes on every host, whatever its locale.
    [`${OPT}B`, value({ context: 'CTX-B', recall: 'REC-B' })],
  ];
  const EXPECTED_NORMAL = [
    'R-MEM',
    'R-POLICY',
    'CTX-B',
    'CTX-a',
    // `…:optional:B` < `…:required:memory` by full service name.
    'REC-B',
    'REC-MEM',
  ].join('\n\n');

  it('required and optional providers land in section order, independent of registration order', async () => {
    const forward = await run(ORDERED);
    const reversed = await run([...ORDERED].reverse());
    const shuffled = await run([ORDERED[2]!, ORDERED[0]!, ORDERED[3]!, ORDERED[1]!]);

    for (const s of [forward, reversed, shuffled]) {
      expect(s.trace.lastSystemPromptAugment).toBe(EXPECTED_NORMAL);
      expect(s.trace.lastBootstrapAugment).toBe('R-MEM\n\nR-POLICY');
      expect(failures(s.logs)).toEqual([]);
      for (const [name] of ORDERED) expect(s.calls[name]).toBe(1);
    }
  });

  it('bootstrap gets only `rules`; context and recall never reach it', async () => {
    const s = await run([
      [`${REQ}memory`, value({ rules: 'RULES', recall: 'RECALLED' })],
      [`${OPT}project`, value({ context: 'PROJECT' })],
    ]);
    expect(s.trace.lastSystemPromptAugment).toBe('RULES\n\nPROJECT\n\nRECALLED');
    expect(s.trace.lastBootstrapAugment).toBe('RULES');
  });

  it('no rules anywhere → the bootstrap augment is empty, never the full augment', async () => {
    const s = await run([[`${OPT}project`, value({ context: 'PROJECT', recall: 'RECALLED' })]]);
    expect(s.trace.lastSystemPromptAugment).toBe('PROJECT\n\nRECALLED');
    expect(s.trace.lastBootstrapAugment).toBe('');
  });

  it('memory-shaped golden: one required { rules, recall } is byte-identical to the old two-contribution output', async () => {
    const R = '## Rules From Your User\n\n- Always answer in French.';
    const M = '## What You Remember\n\n- The user likes tea.';
    const s = await run([[`${REQ}memory`, value({ rules: R, recall: M })]]);
    // Pre-W1 memory returned R (bootstrap-flagged) and M as two bodies,
    // joined with "\n\n"; bootstrap mode got R alone. Same bytes now.
    expect(s.trace.lastSystemPromptAugment).toBe(`${R}\n\n${M}`);
    expect(s.trace.lastBootstrapAugment).toBe(R);
  });

  it('empty bodies are skipped, leaving no dangling blank line', async () => {
    const s = await run([
      [`${REQ}memory`, value({ rules: '', recall: 'RECALLED' })],
      [`${OPT}a`, value({ context: '' })],
      [`${OPT}b`, value({ context: 'B' })],
    ]);
    expect(s.trace.lastSystemPromptAugment).toBe('B\n\nRECALLED');
    expect(s.trace.lastBootstrapAugment).toBe('');
  });

  it('zero providers is a no-op', async () => {
    const s = await run([]);
    expect(s.trace.lastSystemPromptAugment).toBe('');
    expect(s.trace.lastBootstrapAugment).toBe('');
    expect(failures(s.logs)).toEqual([]);
    expect(suppressed(s.logs)).toEqual([]);
  });

  it('the bare legacy `system-prompt:augment` name is not called', async () => {
    const s = await run([['system-prompt:augment', value({ rules: 'STALE' })]]);
    expect(s.calls['system-prompt:augment']).toBe(0);
    expect(s.trace.lastSystemPromptAugment).toBe('');
  });

  it('an unknown class segment is ignored and logged once per orchestrator instance', async () => {
    const s = await setup({
      providers: [
        ['system-prompt:augment:mandatory:x', value({ rules: 'SNEAKY' })],
        [`${OPT}ok`, value({ context: 'OK' })],
      ],
    });
    expect((await invoke(s, 'aug-u1')).kind).toBe('complete');
    expect(s.trace.lastSystemPromptAugment).toBe('OK');
    expect((await invoke(s, 'aug-u2')).kind).toBe('complete');
    expect(s.trace.lastSystemPromptAugment).toBe('OK');

    expect(s.calls['system-prompt:augment:mandatory:x']).toBe(0);
    const unknown = logsNamed(s.logs, 'system_prompt_augment_unknown_class');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.provider).toBe('system-prompt:augment:mandatory:x');
  });

  it('a routed turn (live sandbox) makes no provider calls', async () => {
    const s = await setup({
      providers: [
        [`${REQ}memory`, value({ rules: 'SHOULD-NOT-APPEAR' })],
        [`${OPT}project`, value({ context: 'SHOULD-NOT-APPEAR' })],
      ],
      routedSession: { conversationId: 'conv-routed', activeSessionId: 's-live' },
    });
    const reqId = 'req-routed-1';
    setImmediate(() => {
      void s.h.bus.fire(
        'chat:end',
        makeAgentContext({
          sessionId: 's-live',
          agentId: 'test-agent',
          userId: 'test-user',
          reqId,
          logger: createLogger({ reqId, writer: () => undefined }),
        }),
        { outcome: { kind: 'complete', messages: [] } },
      );
    });
    const outcome = await s.h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      capturingCtx(s.logs, { sessionId: 'unused-fresh', conversationId: 'conv-routed', reqId }),
      { message: { role: 'user', content: 'follow-up' } },
    );
    expect(outcome.kind).toBe('complete');
    expect(s.trace.sandboxOpen).toBe(0);
    expect(s.calls[`${REQ}memory`]).toBe(0);
    expect(s.calls[`${OPT}project`]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('Orchestrator: review 1, finding 1 (Rules failure)', () => {
  const OPTIONAL_OK: Provider = [`${OPT}project`, value({ context: 'PROJECT' })];

  function expectSuppressed(s: Setup, provider: string) {
    expect(s.trace.lastSystemPromptAugment).toBe('');
    expect(s.trace.lastBootstrapAugment).toBe('');
    expect(suppressed(s.logs)).toEqual([provider]);
    // The optional provider still RAN (parallel, isolated) — it just didn't land.
    expect(s.calls[OPTIONAL_OK[0]]).toBe(1);
  }

  it('a required provider that throws, beside an optional one that succeeds → no augment at all', async () => {
    const s = await run([
      [
        `${REQ}memory`,
        async () => {
          throw new Error('rules read failed');
        },
      ],
      OPTIONAL_OK,
    ]);
    expectSuppressed(s, `${REQ}memory`);
    const failed = logsNamed(s.logs, 'system_prompt_contribution_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      level: 'warn',
      provider: `${REQ}memory`,
      class: 'required',
      reason: 'threw',
    });
    expect(failed[0]!.err).toMatchObject({ message: expect.stringContaining('rules read failed') });
  });

  it('a required provider that misses the deadline → no augment at all', async () => {
    const s = await run([[`${REQ}memory`, never, { timeoutMs: Infinity }], OPTIONAL_OK], 30);
    expectSuppressed(s, `${REQ}memory`);
    expect(failures(s.logs)).toEqual([
      { provider: `${REQ}memory`, class: 'required', reason: 'deadline' },
    ]);
  });

  it('a required provider that returns invalid output → no augment at all', async () => {
    const s = await run([[`${REQ}memory`, value({ rules: 42 })], OPTIONAL_OK]);
    expectSuppressed(s, `${REQ}memory`);
    expect(failures(s.logs)).toEqual([
      { provider: `${REQ}memory`, class: 'required', reason: 'invalid' },
    ]);
  });

  it('suppression is logged once per failed required provider', async () => {
    const s = await run([
      [`${REQ}a`, value(null)],
      [`${REQ}b`, async () => Promise.reject(new Error('boom'))],
      [`${REQ}c`, value({ rules: 'FINE' })],
      OPTIONAL_OK,
    ]);
    expect(s.trace.lastSystemPromptAugment).toBe('');
    expect([...suppressed(s.logs)].sort()).toEqual([`${REQ}a`, `${REQ}b`]);
  });

  it('a required provider that returns no `rules` is not a failure: the optional one lands', async () => {
    const s = await run([[`${REQ}memory`, value({})], OPTIONAL_OK]);
    expect(s.trace.lastSystemPromptAugment).toBe('PROJECT');
    expect(s.trace.lastBootstrapAugment).toBe('');
    expect(failures(s.logs)).toEqual([]);
    expect(suppressed(s.logs)).toEqual([]);
  });

  it('a required provider with recall but no rules still lands both', async () => {
    const s = await run([[`${REQ}memory`, value({ recall: 'RECALLED' })], OPTIONAL_OK]);
    expect(s.trace.lastSystemPromptAugment).toBe('PROJECT\n\nRECALLED');
    expect(s.trace.lastBootstrapAugment).toBe('');
  });

  it('no required provider registered: the optional one lands', async () => {
    const s = await run([OPTIONAL_OK]);
    expect(s.trace.lastSystemPromptAugment).toBe('PROJECT');
    expect(suppressed(s.logs)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('Orchestrator: review 1, finding 2 (validation)', () => {
  const OVERSIZED = 'x'.repeat(SYSTEM_PROMPT_AUGMENT_MAX_BODY_CHARS + 1);

  // [label, result, reason] — malformed results from an OPTIONAL provider.
  const OPTIONAL_CASES: Array<[string, unknown, 'invalid' | 'too_large']> = [
    ['null', null, 'invalid'],
    ['a non-object', 'just a string', 'invalid'],
    ['{ rules } (optional may not carry rules)', { rules: 'SNEAKY', context: 'C' }, 'invalid'],
    ['{ rules: "" } (even empty)', { rules: '', context: 'C' }, 'invalid'],
    ['a null body', { recall: null }, 'invalid'],
    ['a number body', { context: 42 }, 'invalid'],
    ['an unknown key', { context: 'C', extra: 'x' }, 'invalid'],
    ['the old { contributions } shape', { contributions: [{ source: 'x', body: 'C' }] }, 'invalid'],
    ['an oversized body', { context: OVERSIZED }, 'too_large'],
  ];

  for (const [label, result, reason] of OPTIONAL_CASES) {
    it(`optional provider returning ${label} is dropped (${reason}); a valid sibling lands`, async () => {
      const s = await run([
        [`${OPT}bad`, value(result)],
        [`${OPT}good`, value({ context: 'GOOD' })],
        [`${REQ}memory`, value({ rules: 'RULES' })],
      ]);
      expect(s.trace.lastSystemPromptAugment).toBe('RULES\n\nGOOD');
      expect(s.trace.lastBootstrapAugment).toBe('RULES');
      expect(failures(s.logs)).toEqual([{ provider: `${OPT}bad`, class: 'optional', reason }]);
      expect(suppressed(s.logs)).toEqual([]);
    });
  }

  it('a body of exactly the cap is accepted', async () => {
    const atCap = 'y'.repeat(SYSTEM_PROMPT_AUGMENT_MAX_BODY_CHARS);
    const s = await run([[`${OPT}big`, value({ context: atCap })]]);
    expect(s.trace.lastSystemPromptAugment).toBe(atCap);
  });

  // The same malformed results from a REQUIRED provider skip everything.
  const REQUIRED_CASES: Array<[string, unknown, 'invalid' | 'too_large']> = [
    ['null', null, 'invalid'],
    ['a null body', { recall: null }, 'invalid'],
    ['a number body', { rules: 42 }, 'invalid'],
    ['an unknown key', { rules: 'R', extra: 'x' }, 'invalid'],
    ['an oversized rules body', { rules: OVERSIZED }, 'too_large'],
    ['an oversized recall body', { rules: 'R', recall: OVERSIZED }, 'too_large'],
  ];

  for (const [label, result, reason] of REQUIRED_CASES) {
    it(`required provider returning ${label} skips the whole augment (${reason})`, async () => {
      const s = await run([
        [`${REQ}memory`, value(result)],
        [`${OPT}good`, value({ context: 'GOOD' })],
      ]);
      expect(s.trace.lastSystemPromptAugment).toBe('');
      expect(s.trace.lastBootstrapAugment).toBe('');
      expect(failures(s.logs)).toEqual([{ provider: `${REQ}memory`, class: 'required', reason }]);
      expect(suppressed(s.logs)).toEqual([`${REQ}memory`]);
    });
  }
});

// ---------------------------------------------------------------------------
describe('Orchestrator: review 1, finding 3 (deadline)', () => {
  it('defaults to a finite 15 s deadline', () => {
    expect(AUGMENT_DEADLINE_MS).toBe(15_000);
  });

  it('an optional provider with timeoutMs: Infinity that never settles: the session opens and the others land', async () => {
    const started = Date.now();
    const s = await run(
      [
        [`${OPT}hung`, never, { timeoutMs: Infinity }],
        [`${OPT}good`, value({ context: 'GOOD' })],
        [`${REQ}memory`, value({ rules: 'RULES' })],
      ],
      40,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s.trace.lastSystemPromptAugment).toBe('RULES\n\nGOOD');
    expect(failures(s.logs)).toEqual([
      { provider: `${OPT}hung`, class: 'optional', reason: 'deadline' },
    ]);
  });

  it('a required provider with timeoutMs: Infinity that never settles: the session opens with no augment', async () => {
    const started = Date.now();
    const s = await run(
      [
        [`${REQ}memory`, never, { timeoutMs: Infinity }],
        [`${OPT}good`, value({ context: 'GOOD' })],
      ],
      40,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s.trace.lastSystemPromptAugment).toBe('');
    expect(s.trace.lastBootstrapAugment).toBe('');
    expect(suppressed(s.logs)).toEqual([`${REQ}memory`]);
  });

  it('a provider that rejects AFTER the deadline is still just a deadline miss (no unhandled rejection)', async () => {
    const s = await run(
      [
        [
          `${OPT}late`,
          () =>
            new Promise((_res, rej) => {
              setTimeout(() => rej(new Error('too late')), 80);
            }),
          { timeoutMs: Infinity },
        ],
        [`${OPT}good`, value({ context: 'GOOD' })],
      ],
      20,
    );
    // Let the late rejection land; vitest fails the run on an unhandled one.
    await new Promise((r) => setTimeout(r, 120));
    expect(s.trace.lastSystemPromptAugment).toBe('GOOD');
    expect(failures(s.logs)).toEqual([
      { provider: `${OPT}late`, class: 'optional', reason: 'deadline' },
    ]);
  });

  for (const bad of [Infinity, Number.NaN, 0, -1]) {
    it(`config rejects augmentDeadlineMs=${bad} at init`, async () => {
      await expect(setup({ augmentDeadlineMs: bad })).rejects.toThrow(/augmentDeadlineMs/);
    });
  }
});
