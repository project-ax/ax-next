import { describe, it, expect, vi } from 'vitest';
import {
  HookBus,
  makeAgentContext,
  createLogger,
  reject,
  SYSTEM_PROMPT_AUGMENT_MAX_BODY_CHARS,
  SYSTEM_PROMPT_LANDED_HOOK,
  type AgentMessage,
  type AgentOutcome,
  type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';
import { AUGMENT_DEADLINE_MS, CONNECTORS_SKIPPED_SUBSCRIBER_TIMEOUT_MS } from '../orchestrator.js';

// ---------------------------------------------------------------------------
// W1 — system-prompt contributions from several plugins
// (`docs/plans/2026-10-12-w1-prompt-contributions-design.md`).
//
// On a fresh spawn the orchestrator discovers every service named
// `system-prompt:augment:required:<name>` / `…:optional:<name>`, calls them in
// parallel, and gives each its own step: call → orchestrator deadline → schema
// → class rule → size. Bodies join with "\n\n" in section order (rules,
// brief, context, recall), and within a section by full service name. Only
// `rules` and `brief` reach `systemPromptBootstrapAugment`. A failed REQUIRED provider skips the
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
  connectorsSkippedSubscriberTimeoutMs?: number;
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
        ...(opts.connectorsSkippedSubscriberTimeoutMs !== undefined
          ? { connectorsSkippedSubscriberTimeoutMs: opts.connectorsSkippedSubscriberTimeoutMs }
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
    [`${OPT}a`, value({ context: 'CTX-a', brief: 'BRIEF-a' })],
    // Upper-case 'B' sorts BEFORE lower-case 'a' under a plain `<` compare
    // (code-unit order), but after it under localeCompare. Pins the former:
    // the same bytes on every host, whatever its locale.
    [`${OPT}B`, value({ context: 'CTX-B', recall: 'REC-B' })],
  ];
  const EXPECTED_NORMAL = [
    'R-MEM',
    'R-POLICY',
    'BRIEF-a',
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
      expect(s.trace.lastBootstrapAugment).toBe('R-MEM\n\nR-POLICY\n\nBRIEF-a');
      expect(failures(s.logs)).toEqual([]);
      for (const [name] of ORDERED) expect(s.calls[name]).toBe(1);
    }
  });

  it('bootstrap gets only `rules` and `brief`; context and recall never reach it', async () => {
    const s = await run([
      [`${REQ}memory`, value({ rules: 'RULES', recall: 'RECALLED' })],
      [`${OPT}routines`, value({ brief: 'BRIEF', context: 'CONTEXT' })],
    ]);
    expect(s.trace.lastSystemPromptAugment).toBe('RULES\n\nBRIEF\n\nCONTEXT\n\nRECALLED');
    expect(s.trace.lastBootstrapAugment).toBe('RULES\n\nBRIEF');
  });

  // A task check-in can run while its agent is still in its first-run chat, and
  // bootstrap mode drops `context`, so a brief alone must reach it (W1 §11).
  it('an optional provider\'s `brief` alone reaches bootstrap mode', async () => {
    const s = await run([[`${OPT}routines`, value({ brief: 'TASK BRIEF' })]]);
    expect(s.trace.lastSystemPromptAugment).toBe('TASK BRIEF');
    expect(s.trace.lastBootstrapAugment).toBe('TASK BRIEF');
    expect(failures(s.logs)).toEqual([]);
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
    ['an oversized brief', { brief: OVERSIZED }, 'too_large'],
    ['a number brief', { brief: 1 }, 'invalid'],
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

  // Review round 1, finding 1: a required provider's invalid result suppresses
  // the whole augment, so the log must say what was wrong — field paths and
  // codes only, never the provider's text.
  it('failure logs name what was wrong without echoing the body', async () => {
    const s = await run([
      [`${OPT}typed`, value({ context: 42, recall: 'SECRET-BODY' })],
      [`${OPT}sneaky`, value({ rules: 'SECRET-RULES' })],
      [`${OPT}big`, value({ recall: OVERSIZED })],
      // A provider controls an unknown key's NAME; zod puts it in `keys` and
      // `message`, never in `path`, and neither of those is logged.
      [`${OPT}evil`, value({ context: 'C', 'SECRET-KEY': 'x' })],
    ]);
    const byProvider = new Map(
      logsNamed(s.logs, 'system_prompt_contribution_failed').map((l) => [l.provider, l]),
    );
    expect(byProvider.get(`${OPT}typed`)?.issues).toEqual([
      { path: 'context', code: 'invalid_type' },
    ]);
    expect(byProvider.get(`${OPT}sneaky`)?.issues).toEqual([
      { path: 'rules', code: 'optional_provider_returned_rules' },
    ]);
    expect(byProvider.get(`${OPT}evil`)?.issues).toEqual([
      { path: '', code: 'unrecognized_keys' },
    ]);
    expect(byProvider.get(`${OPT}big`)).toMatchObject({
      section: 'recall',
      length: SYSTEM_PROMPT_AUGMENT_MAX_BODY_CHARS + 1,
    });
    expect(JSON.stringify(s.logs)).not.toContain('SECRET');
  });

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

// ---------------------------------------------------------------------------
// TASK-908 — `chat:system-prompt-landed { reqId, providers }`, fired once per
// fresh spawn right after the augment is built and before any proxy or sandbox
// session opens. `providers` lists only the providers whose step succeeded AND
// returned at least one non-empty body: a provider that answered `{}` put
// nothing in the prompt, so it is not listed, and @ax/routines can refuse a
// check-in whose brief didn't land. A subscriber may veto; the turn then ends
// `terminated` with `system-prompt:<reason>`.
describe('chat:system-prompt-landed (TASK-908)', () => {
  const OVERSIZED = 'x'.repeat(SYSTEM_PROMPT_AUGMENT_MAX_BODY_CHARS + 1);

  interface Landed {
    ctxReqId: string;
    payload: unknown;
  }

  function recordLanded(s: Setup): Landed[] {
    const seen: Landed[] = [];
    s.h.bus.subscribe(SYSTEM_PROMPT_LANDED_HOOK, 'test-observer', async (ctx, payload) => {
      seen.push({ ctxReqId: ctx.reqId, payload });
      return undefined;
    });
    return seen;
  }

  function invokeAs(s: Setup, reqId: string): Promise<AgentOutcome> {
    return s.h.bus.call<unknown, AgentOutcome>(
      'agent:invoke',
      capturingCtx(s.logs, { reqId }),
      { message: { role: 'user', content: 'hi' } },
    );
  }

  it('fires once per fresh spawn with the providers whose bodies landed', async () => {
    const s = await setup({
      // Registration order is not the payload's order: it is sorted by name.
      providers: [
        [`${REQ}memory`, value({ rules: 'R' })],
        [`${OPT}routines`, value({ brief: 'B' })],
        [`${OPT}empty`, value({})],
        [`${OPT}blank`, value({ context: '' })],
        [
          `${OPT}thrower`,
          async () => {
            throw new Error('provider boom');
          },
        ],
        [`${OPT}huge`, value({ context: OVERSIZED })],
      ],
    });
    const seen = recordLanded(s);
    const outcome = await invokeAs(s, 'req-landed-1');
    expect(outcome.kind).toBe('complete');
    expect(s.trace.sandboxOpen).toBe(1);
    // The listed providers are exactly the ones whose text is in the prompt.
    expect(s.trace.lastSystemPromptAugment).toBe('R\n\nB');
    expect(seen).toEqual([
      {
        ctxReqId: 'req-landed-1',
        payload: { reqId: 'req-landed-1', providers: [`${OPT}routines`, `${REQ}memory`] },
      },
    ]);
  });

  it('a failed required provider lands nothing: providers is []', async () => {
    const s = await setup({
      providers: [
        [
          `${REQ}memory`,
          async () => {
            throw new Error('rules read failed');
          },
        ],
        [`${OPT}routines`, value({ brief: 'B' })],
      ],
    });
    const seen = recordLanded(s);
    expect((await invokeAs(s, 'req-landed-2')).kind).toBe('complete');
    // The optional provider's step succeeded, but its brief never reached the prompt.
    expect(s.trace.lastSystemPromptAugment).toBe('');
    expect(seen).toEqual([
      { ctxReqId: 'req-landed-2', payload: { reqId: 'req-landed-2', providers: [] } },
    ]);
  });

  it('no providers registered: providers is []', async () => {
    const s = await setup();
    const seen = recordLanded(s);
    expect((await invokeAs(s, 'req-landed-3')).kind).toBe('complete');
    expect(seen).toEqual([
      { ctxReqId: 'req-landed-3', payload: { reqId: 'req-landed-3', providers: [] } },
    ]);
  });

  it('the routed path never fires it', async () => {
    const s = await setup({
      providers: [[`${OPT}routines`, value({ brief: 'B' })]],
      routedSession: { conversationId: 'conv-routed', activeSessionId: 's-live' },
    });
    const seen = recordLanded(s);
    const reqId = 'req-routed-landed';
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
    expect(s.calls[`${OPT}routines`]).toBe(0);
    expect(seen).toEqual([]);
  });

  it('a rejection ends the turn before any proxy or sandbox session opens', async () => {
    const s = await setup({ providers: [[`${OPT}routines`, value({})]] });
    // Registered, so a read that ran before the veto would show up below.
    s.h.bus.registerService('tool-policy:list-agent-overrides', 'test-policy', async () => ({
      overrides: [],
    }));
    s.h.bus.subscribe(SYSTEM_PROMPT_LANDED_HOOK, 'test-veto', async () =>
      reject({ reason: 'brief-missing' }),
    );
    const turnErrors: unknown[] = [];
    const ends: unknown[] = [];
    s.h.bus.subscribe('chat:turn-error', 'test-observer', async (_ctx, payload) => {
      turnErrors.push(payload);
      return undefined;
    });
    s.h.bus.subscribe('chat:end', 'test-observer', async (_ctx, payload) => {
      ends.push(payload);
      return undefined;
    });
    const callSpy = vi.spyOn(s.h.bus, 'call');

    const outcome = await invokeAs(s, 'req-veto');

    const expected = { kind: 'terminated', reason: 'system-prompt:brief-missing' };
    expect(outcome).toEqual(expected);
    // The browser hears about it (chat:turn-error), and audit sees one chat:end.
    expect(turnErrors).toHaveLength(1);
    expect(turnErrors).toMatchObject([{ reqId: 'req-veto', reason: 'system-prompt:brief-missing' }]);
    expect(ends).toEqual([{ outcome: expected }]);
    // Nothing was opened, so there is nothing to close.
    expect(s.trace.sandboxOpen).toBe(0);
    const called = callSpy.mock.calls.map((c) => c[0]);
    expect(called).toContain(`${OPT}routines`);
    for (const hook of [
      'tool-policy:list-agent-overrides',
      'proxy:open-session',
      'sandbox:open-session',
      'session:queue-work',
    ]) {
      expect(called).not.toContain(hook);
    }
  });

  it('a hung or throwing subscriber is skipped after the short bound, and the turn goes on', async () => {
    const s = await setup({
      providers: [[`${OPT}routines`, value({ brief: 'B' })]],
      connectorsSkippedSubscriberTimeoutMs: 20,
    });
    s.h.bus.subscribe(SYSTEM_PROMPT_LANDED_HOOK, 'test-hanger', () => new Promise<never>(() => {}));
    s.h.bus.subscribe(SYSTEM_PROMPT_LANDED_HOOK, 'test-thrower', async () => {
      throw new Error('subscriber boom');
    });
    const started = Date.now();
    const outcome = await invokeAs(s, 'req-hung');
    expect(outcome.kind).toBe('complete');
    expect(s.trace.sandboxOpen).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Both subscribers really ran, and each was isolated by the bus.
    const onLanded = (msg: string) =>
      logsNamed(s.logs, msg)
        .filter((l) => l.hook === SYSTEM_PROMPT_LANDED_HOOK)
        .map((l) => ({ plugin: l.plugin, timeoutMs: l.timeoutMs }));
    expect(onLanded('hook_subscriber_timed_out')).toEqual([
      { plugin: 'test-hanger', timeoutMs: 20 },
    ]);
    expect(onLanded('hook_subscriber_failed')).toEqual([
      { plugin: 'test-thrower', timeoutMs: undefined },
    ]);
  });

  // Decisions row 4: a throw from the fire itself can't come from a subscriber
  // (the bus isolates those), so it is an infrastructure fault, and ending
  // every chat over it is the wrong trade. Logged by error name only.
  it('a fire that throws is logged and the turn goes on', async () => {
    const s = await setup({ providers: [[`${OPT}routines`, value({ brief: 'B' })]] });
    const realFire = s.h.bus.fire.bind(s.h.bus);
    vi.spyOn(s.h.bus, 'fire').mockImplementation(((...args: Parameters<HookBus['fire']>) => {
      if (args[0] !== SYSTEM_PROMPT_LANDED_HOOK) return realFire(...args);
      const err = new Error('SECRET-DETAIL');
      err.name = 'BusFault';
      return Promise.reject(err);
    }) as HookBus['fire']);
    const outcome = await invokeAs(s, 'req-fire-throws');
    expect(outcome.kind).toBe('complete');
    expect(s.trace.sandboxOpen).toBe(1);
    const failed = logsNamed(s.logs, 'chat_system_prompt_landed_fire_failed');
    expect(failed.map((l) => ({ level: l.level, name: l.name }))).toEqual([
      { level: 'warn', name: 'BusFault' },
    ]);
    expect(JSON.stringify(failed)).not.toContain('SECRET-DETAIL');
  });

  it('is bounded by the short pre-turn bound by default', async () => {
    const s = await setup();
    const fireSpy = vi.spyOn(s.h.bus, 'fire');
    expect((await invokeAs(s, 'req-default-bound')).kind).toBe('complete');
    const opts = fireSpy.mock.calls
      .filter((c) => c[0] === SYSTEM_PROMPT_LANDED_HOOK)
      .map((c) => c[3]);
    expect(opts).toEqual([{ subscriberTimeoutMs: CONNECTORS_SKIPPED_SUBSCRIBER_TIMEOUT_MS }]);
  });
});
