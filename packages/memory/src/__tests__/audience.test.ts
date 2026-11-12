import { HookBus, makeAgentContext, type AgentContext, type LlmCallOutput } from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recallAudienceScope, recallFacts } from '../audience.js';
import { MEMORY_NOTE_TOOL_HOOK } from '../note-tool.js';
import { FACTS_RECALL_HOOK } from '../plugin.js';
import { MEMORY_RECALL_TOOL_HOOK } from '../recall-tool.js';
import type { MemoryRecallInput, MemoryRecallOutput } from '../types.js';
import {
  ALICE,
  engineRecord,
  makeMemoryHarness,
  type MemoryHarness,
  type MemoryHarnessOptions,
} from './harness.js';

/**
 * TASK-1091, the read side: a turn whose reply people without access to the
 * agent can read (`ctx.audience: 'shared'`) recalls only what was learned
 * where they could see it.
 *
 * Driven through the bus over the REAL sqlite engine, because the property is
 * one of the two plugins together: memory has to send the scope, and the
 * engine has to honour it. The one stub here is an engine that IGNORES the
 * scope, which is the case memory's backstop exists for.
 */

let harness: MemoryHarness | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.teardown();
  harness = undefined;
});

async function makeHarness(options: MemoryHarnessOptions = {}): Promise<MemoryHarness> {
  harness = await makeMemoryHarness({}, options);
  return harness;
}

const JAN = '2026-01-15T00:00:00.000Z';
/** A conversation people without access to the agent can read. */
const CHANNEL = 'conv-channel';
/** One only the owner can read. */
const PRIVATE_CONV = 'conv-private';

/** Every value shares the word `launch`, so one query matches them all. */
const SECRET = 'launch codename Nightjar';
const PUBLIC = 'launch date in March';
const LEGACY = 'launch budget Kestrel';

const AUGMENT_HOOK = 'system-prompt:augment:optional:memory';

/** A passer-by in a shared conversation; the turn runs as the owner. */
function sharedCtx(h: MemoryHarness): AgentContext {
  return h.ctx({ conversationId: CHANNEL, source: 'external', audience: 'shared' });
}

function values(out: MemoryRecallOutput): string[] {
  return out.statements.map((s) => s.value);
}

async function augment(h: MemoryHarness, ctx: AgentContext): Promise<string> {
  const out = await h.bus.call<Record<string, never>, { recall?: string }>(AUGMENT_HOOK, ctx, {});
  return out.recall ?? '';
}

function recallTool(h: MemoryHarness, ctx: AgentContext, query: string): Promise<string> {
  return h.bus.call<{ input: unknown }, string>(MEMORY_RECALL_TOOL_HOOK, ctx, { input: { query } });
}

/** Every `memory:facts:recall` input the work sent, in order. */
async function engineReadsDuring(
  h: MemoryHarness,
  work: () => Promise<unknown>,
): Promise<Array<Record<string, unknown>>> {
  const spy = vi.spyOn(h.bus, 'call');
  try {
    await work();
    return spy.mock.calls
      .filter(([hook]) => hook === FACTS_RECALL_HOOK)
      .map(([, , input]) => input as Record<string, unknown>);
  } finally {
    spy.mockRestore();
  }
}

function extractionReply(facts: Array<Record<string, unknown>>): LlmCallOutput {
  return {
    text: JSON.stringify({
      facts: facts.map((f) => ({ network: 'world', validStart: JAN, invalidatesPrevious: false, ...f })),
    }),
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

/** Every `memory:recall` read shape. */
const RECALL_SHAPES: MemoryRecallInput[] = [
  {},
  { query: 'launch' },
  { about: 'launch_plan' },
  { profile: true },
  { activeOnly: false },
  { profile: true, activeOnly: false },
  { conversationId: CHANNEL },
  { conversationId: PRIVATE_CONV },
];

describe('@ax/memory — a shared turn recalls shared statements only (TASK-1091)', () => {
  it.each(['personal', 'team'] as const)(
    'a private statement is never recalled in a shared turn (%s agent)',
    async (visibility) => {
      const h = await makeHarness({ agent: { visibility } });
      const mine = h.ctx({ conversationId: PRIVATE_CONV });
      const shared = sharedCtx(h);
      await h.remember({ about: 'launch_plan', relation: 'codename', value: SECRET }, mine);
      await engineRecord(h.bus, shared, [
        {
          about: 'launch_plan',
          relation: 'date',
          value: PUBLIC,
          when: JAN,
          ownerUserId: ALICE,
          conversationId: CHANNEL,
          audience: 'shared',
        },
      ]);

      // The control: the owner's private turn reads both, so what the shared
      // turn misses below is a filter at work, not an empty store.
      expect(values(await h.recall({}, mine)).sort()).toEqual([PUBLIC, SECRET].sort());
      expect(values(await h.recall({ query: 'launch' }, mine)).sort()).toEqual([PUBLIC, SECRET].sort());
      expect(await augment(h, mine)).toContain('Nightjar');

      // The listing and the ranked read return the shared row and nothing else.
      expect(values(await h.recall({}, shared))).toEqual([PUBLIC]);
      expect(values(await h.recall({ query: 'launch' }, shared))).toEqual([PUBLIC]);
      // Every other read shape, including a conversation feed pointed at the
      // owner's private conversation, misses it too.
      for (const input of RECALL_SHAPES) {
        expect(values(await h.recall(input, shared))).not.toContain(SECRET);
      }
      // The block injected into a shared turn's prompt, and the tool.
      const block = await augment(h, shared);
      expect(block).toContain(PUBLIC);
      expect(block).not.toContain('Nightjar');
      const tool = await recallTool(h, shared, 'launch');
      expect(tool).toContain(PUBLIC);
      expect(tool).not.toContain('Nightjar');
    },
  );

  // Review focus 5: a row stored before audience existed carries no stamp, and
  // unstamped is not provably shared.
  it('neither a private-stamped nor an unstamped (pre-audience) row reaches a shared turn', async () => {
    const h = await makeHarness();
    const shared = sharedCtx(h);
    const row = { about: 'launch_plan', when: JAN, ownerUserId: ALICE, conversationId: CHANNEL };
    await engineRecord(h.bus, shared, [
      { ...row, relation: 'budget', value: LEGACY },
      { ...row, relation: 'codename', value: SECRET, audience: 'private' },
      { ...row, relation: 'date', value: PUBLIC, audience: 'shared' },
    ]);

    expect(values(await h.recall({ query: 'launch' }, h.ctx())).sort()).toEqual(
      [LEGACY, PUBLIC, SECRET].sort(),
    );
    for (const input of [{}, { query: 'launch' }, { conversationId: CHANNEL }, { activeOnly: false }]) {
      expect(values(await h.recall(input, shared))).toEqual([PUBLIC]);
    }
  });

  it('a shared statement IS recalled in a private turn', async () => {
    const h = await makeHarness();
    const { records } = await engineRecord(h.bus, h.ctx(), [
      {
        about: 'launch_plan',
        relation: 'date',
        value: PUBLIC,
        when: JAN,
        ownerUserId: ALICE,
        conversationId: CHANNEL,
        audience: 'shared',
      },
    ]);

    const { statements } = await h.recall({}, h.ctx());
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ id: records[0]!.id, value: PUBLIC, audience: 'shared' });
    // A shared turn labels it the same way.
    const shared = await h.recall({}, sharedCtx(h));
    expect(shared.statements.map((s) => s.audience)).toEqual(['shared']);
  });

  it('absent audience behaves exactly as today', async () => {
    const h = await makeHarness();
    await h.remember(
      { about: 'launch_plan', relation: 'codename', value: SECRET },
      h.ctx({ conversationId: PRIVATE_CONV }),
    );
    await engineRecord(h.bus, h.ctx(), [
      {
        about: 'office',
        relation: 'lives_in',
        value: 'Boston',
        when: JAN,
        slot: 'lives_in',
        ownerUserId: ALICE,
        conversationId: PRIVATE_CONV,
        audience: 'private',
      },
    ]);

    // An absent audience and an explicit `'private'` are the same turn.
    for (const ctx of [h.ctx(), h.ctx({ audience: 'private' })]) {
      const outs: MemoryRecallOutput[] = [];
      const reads = await engineReadsDuring(h, async () => {
        for (const input of RECALL_SHAPES) outs.push(await h.recall(input, ctx));
        await augment(h, ctx);
        await recallTool(h, ctx, 'launch');
      });
      expect(reads.length).toBeGreaterThan(0);
      for (const input of reads) expect(input).not.toHaveProperty('audience');
      expect(values(outs[0]!).sort()).toEqual(['Boston', SECRET].sort());
      for (const out of outs) {
        for (const statement of out.statements) expect(statement).not.toHaveProperty('audience');
      }
    }
  });

  it('every engine recall under a shared ctx carries audience "shared"', async () => {
    const h = await makeHarness({
      llm: () =>
        extractionReply([
          { subject: 'office', predicate: 'lives_in', object: 'Boston' },
          { subject: 'billing_service', predicate: 'owner', object: 'Dana' },
        ]),
    });
    const shared = sharedCtx(h);
    // One shared, agent-saved, slotted row in this conversation: memory:recall
    // reads its slot chain, and the observer finds it as the active twin of
    // the person's "Boston", which sends it on to the chain read.
    await engineRecord(h.bus, shared, [
      {
        about: 'office',
        relation: 'lives_in',
        value: 'Boston',
        when: JAN,
        slot: 'lives_in',
        provenance: 'agent',
        ownerUserId: ALICE,
        conversationId: CHANNEL,
        audience: 'shared',
      },
    ]);

    const routes = {
      'memory:recall': await engineReadsDuring(h, async () => {
        for (const input of RECALL_SHAPES) await h.recall(input, shared);
      }),
      augment: await engineReadsDuring(h, () => augment(h, shared)),
      memory_recall: await engineReadsDuring(h, () => recallTool(h, shared, 'Boston')),
      memory_note: await engineReadsDuring(h, () =>
        h.bus.call(MEMORY_NOTE_TOOL_HOOK, shared, {
          input: { about: 'standup', relation: 'held_at', value: '9am' },
        }),
      ),
      observer: await engineReadsDuring(h, async () => {
        await h.bus.fire('chat:end', shared, {
          outcome: {
            kind: 'complete',
            messages: [
              { role: 'user', content: 'Our office is in Boston now.' },
              { role: 'assistant', content: 'Noted. Dana owns the billing service.' },
            ],
          },
        });
        await h.settleObserver();
      }),
    };

    for (const [route, reads] of Object.entries(routes)) {
      expect(reads.length, route).toBeGreaterThan(0);
      for (const input of reads) expect(input.audience, route).toBe('shared');
    }
    // The reads above took the branches a plain listing never reaches.
    const recall = routes['memory:recall'];
    // The slot chains `memory:recall` reads beside a page with slotted rows.
    expect(recall.some((i) => i.about === 'office' && i.activeOnly === false && Array.isArray(i.slots))).toBe(true);
    // The history profile's separate read of the slots in effect.
    expect(recall.some((i) => i.about === `user:${ALICE}` && i.activeOnly === true && i.limit === 200)).toBe(true);
    const observer = routes.observer;
    expect(h.llmCalls).toHaveLength(1);
    // The conversation twin read...
    expect(observer.some((i) => i.conversationId === CHANNEL && i.about === 'office')).toBe(true);
    // ...the chain read it sends the person's "Boston" to...
    expect(observer.some((i) => Array.isArray(i.slots) && i.slots.length === 1)).toBe(true);
    // ...and the every-conversation read for a retracted slot-less value.
    expect(observer.some((i) => i.about === 'billing_service' && !('conversationId' in i))).toBe(true);
  });

  // Review focus 3: both engines drop an unknown recall field without a word,
  // so an engine without audience support would answer a shared read with
  // every row it has.
  it('a shared read that gets a non-shared row back fails instead of returning it', async () => {
    const h = await makeHarness();
    const { id } = await h.remember(
      { about: 'launch_plan', relation: 'codename', value: SECRET },
      h.ctx({ conversationId: PRIVATE_CONV }),
    );
    const realCall = h.bus.call.bind(h.bus) as (hook: string, c: AgentContext, input: unknown) => Promise<unknown>;
    vi.spyOn(h.bus, 'call').mockImplementation((async (hook: string, c: AgentContext, input: unknown) => {
      if (hook !== FACTS_RECALL_HOOK || input === null || typeof input !== 'object') {
        return realCall(hook, c, input);
      }
      const { audience: _ignored, ...rest } = input as Record<string, unknown>;
      return realCall(hook, c, rest);
    }) as never);

    // A private turn is untouched: the backstop is the shared path's alone.
    expect(values(await h.recall({}, h.ctx()))).toEqual([SECRET]);

    const shared = sharedCtx(h);
    const failure: unknown = await h.recall({}, shared).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toMatchObject({ code: 'invalid-return', hookName: FACTS_RECALL_HOOK });
    // The refusal names no row: not its text, not its id.
    const message = (failure as Error).message;
    expect(message).not.toContain('Nightjar');
    expect(message).not.toContain(id);

    await expect(h.recall({ query: 'launch' }, shared)).rejects.toMatchObject({ code: 'invalid-return' });
    await expect(recallTool(h, shared, 'launch')).rejects.toMatchObject({ code: 'invalid-return' });
    await expect(augment(h, shared)).rejects.toMatchObject({ code: 'invalid-return' });
  });

  const REMEMBER = { about: 'launch_plan', relation: 'date', value: PUBLIC };
  it.each([
    // A shared turn asking to widen its own read.
    ['memory:recall', 'private', 'shared', {}],
    ['memory:recall', 'shared', undefined, {}],
    ['memory:remember', 'shared', undefined, REMEMBER],
    ['memory:remember', 'private', 'shared', REMEMBER],
  ] as const)(
    'audience is not a caller-settable field: %s refuses audience %j (turn audience %j)',
    async (hook, audience, turnAudience, payload) => {
      const h = await makeHarness();
      const ctx = turnAudience === undefined ? h.ctx() : h.ctx({ audience: turnAudience });
      const spy = vi.spyOn(h.bus, 'call');
      await expect(h.bus.call(hook, ctx, { ...payload, audience })).rejects.toMatchObject({
        code: 'invalid-payload',
        message: expect.stringContaining('audience is not a caller-settable field'),
      });
      // Refused before the store: nothing read, nothing written.
      expect(spy.mock.calls.some(([called]) => called.startsWith('memory:facts:'))).toBe(false);
    },
  );
});

describe('recallFacts — the one door every engine read goes through', () => {
  const ROW = { id: 'row-1', about: 'launch_plan', relation: 'codename', value: SECRET, when: JAN };
  const turn = (audience?: 'private' | 'shared'): AgentContext =>
    makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      ...(audience !== undefined ? { audience } : {}),
    });

  /** A bus whose engine answers `answer` to every read, and records what it was asked. */
  function engineAnswering(answer: unknown): { bus: HookBus; asked: unknown[] } {
    const bus = new HookBus();
    const asked: unknown[] = [];
    bus.registerService('memory:facts:recall', 'stub-engine', async (_c, input) => {
      asked.push(input);
      return answer;
    });
    return { bus, asked };
  }

  it.each([
    ['an unstamped row', { ...ROW }],
    ['a private row', { ...ROW, audience: 'private' }],
    ['a differently-cased stamp', { ...ROW, audience: 'SHARED' }],
    ['a null row', null],
    ['a non-object row', 'row-1'],
  ])('a shared read refuses %s beside a shared one, naming no row', async (_label, row) => {
    const { bus } = engineAnswering({ statements: [{ ...ROW, audience: 'shared' }, row], degraded: [] });
    const failure: unknown = await recallFacts(bus, turn('shared'), FACTS_RECALL_HOOK, {}).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toMatchObject({ code: 'invalid-return', plugin: '@ax/memory', hookName: FACTS_RECALL_HOOK });
    expect((failure as Error).message).not.toContain('Nightjar');
    expect((failure as Error).message).not.toContain(ROW.id);
  });

  it('a hole in the statements is not a row stamped shared', async () => {
    const statements: unknown[] = [{ ...ROW, audience: 'shared' }];
    statements.length = 2;
    const { bus } = engineAnswering({ statements, degraded: [] });
    await expect(recallFacts(bus, turn('shared'), FACTS_RECALL_HOOK, {})).rejects.toMatchObject({
      code: 'invalid-return',
    });
  });

  it('an audience this build does not know reads as shared', async () => {
    const odd = makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      audience: 'public' as never,
    });
    expect(recallAudienceScope(odd)).toEqual({ audience: 'shared' });
    const { bus, asked } = engineAnswering({ statements: [{ ...ROW }], degraded: [] });
    await expect(recallFacts(bus, odd, FACTS_RECALL_HOOK, {})).rejects.toMatchObject({ code: 'invalid-return' });
    expect(asked).toEqual([{ audience: 'shared' }]);
  });

  it('spreads the scope last, so a caller-built input cannot widen a shared read', async () => {
    const { bus, asked } = engineAnswering({ statements: [], degraded: [] });
    await recallFacts(bus, turn('shared'), FACTS_RECALL_HOOK, { limit: 5, audience: 'private' });
    expect(asked).toEqual([{ limit: 5, audience: 'shared' }]);
  });

  it('a private read sends no scope and passes every row through untouched', async () => {
    const answer = { statements: [{ ...ROW }, { ...ROW, audience: 'private' }], degraded: [] };
    for (const ctx of [turn(), turn('private')]) {
      const { bus, asked } = engineAnswering(answer);
      expect(await recallFacts(bus, ctx, FACTS_RECALL_HOOK, { limit: 5 })).toBe(answer);
      expect(asked).toEqual([{ limit: 5 }]);
    }
  });

  // Each caller refuses these on its own terms; the wrapper adds nothing a
  // caller could mistake for an answer.
  it.each([
    ['no answer', null],
    ['a non-array statements', { statements: 'rows', degraded: [] }],
  ])('leaves %s to the caller, unchanged', async (_label, answer) => {
    const { bus } = engineAnswering(answer);
    expect(await recallFacts(bus, turn('shared'), FACTS_RECALL_HOOK, {})).toBe(answer);
  });
});
