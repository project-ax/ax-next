import Database from 'better-sqlite3';
import {
  audienceOf,
  HookBus,
  makeAgentContext,
  MEMORY_PRE_CAPTURE_HOOK,
  PluginError,
  reject,
  type AgentContext,
  type AgentContextAudience,
  type AgentContextSource,
  type LlmCallOutput,
  type MemoryPreCapturePayload,
} from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MemoryAccess } from '../access.js';
import {
  breaksSpeakerRule,
  isPersonSubject,
  namesASpeaker,
  recallAudienceScope,
  recallFacts,
  recordFacts,
  speakerScope,
  speakerSubject,
} from '../audience.js';
import { OBSERVER_RUN_EVENT } from '../failure.js';
import {
  MEMORY_NOTE_TOOL_HOOK,
  PERSON_IN_SHARED_MESSAGE,
  TEAM_PERSON_KEY_MESSAGE,
  type MemoryNoteResult,
} from '../note-tool.js';
import { toStatements } from '../observer.js';
import { FACTS_RECALL_HOOK, FACTS_RECORD_HOOK } from '../plugin.js';
import { MEMORY_RECALL_TOOL_HOOK } from '../recall-tool.js';
import { isAgentSubject } from '../self-report.js';
import { rewriteSpeaker } from '../subject.js';
import type { MemoryRecallInput, MemoryRecallOutput } from '../types.js';
import {
  ALICE,
  answerSpeakerNames,
  BOB,
  engineRecord,
  eventsNamed,
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

/**
 * Make the engine one without audience support: it drops the `audience` of
 * every recall it is sent, so it answers a shared read with every row it has.
 * The case memory's backstop exists for.
 */
function engineIgnoresAudience(h: MemoryHarness): void {
  const realCall = h.bus.call.bind(h.bus) as (hook: string, c: AgentContext, input: unknown) => Promise<unknown>;
  vi.spyOn(h.bus, 'call').mockImplementation((async (hook: string, c: AgentContext, input: unknown) => {
    if (hook !== FACTS_RECALL_HOOK || input === null || typeof input !== 'object') {
      return realCall(hook, c, input);
    }
    const { audience: _ignored, ...rest } = input as Record<string, unknown>;
    return realCall(hook, c, rest);
  }) as never);
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
  // `sharedCtx` is an outsider's turn: on a personal agent it recalls shared
  // statements only. On a team agent a member's turn (TASK-1204) and an
  // outsider's (TASK-1209) recall everything, and one from a source this
  // build doesn't know still recalls shared statements only: see the tests
  // below.
  it.each(['personal'] as const)(
    "a private statement is never recalled in an outsider's shared turn (%s agent)",
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

  // TASK-1209 (design §4c): a team agent's memory is shared with anyone who
  // talks to it, so an outsider's turn recalls what a member's does, the
  // private statement included.
  it("a private statement IS recalled in an outsider's turn on a team agent (TASK-1209)", async () => {
    const h = await makeHarness({ agent: { visibility: 'team' } });
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

    expect(values(await h.recall({}, shared)).sort()).toEqual([PUBLIC, SECRET].sort());
    expect(values(await h.recall({ query: 'launch' }, shared)).sort()).toEqual([PUBLIC, SECRET].sort());
    const block = await augment(h, shared);
    expect(block).toContain(PUBLIC);
    expect(block).toContain('Nightjar');
    const tool = await recallTool(h, shared, 'launch');
    expect(tool).toContain(PUBLIC);
    expect(tool).toContain('Nightjar');
  });

  // Review F3: on a personal agent an outsider's turn is read by someone
  // without access to the agent whatever its stamp, so a private stamp, or
  // none, reads what the room could see too. No live producer sends either
  // (channel-slack stamps an outsider's turn shared): this fails closed, like
  // `isOutsiderTurn`.
  it.each([
    ['personal', 'private'],
    ['personal', undefined],
  ] as const)(
    "nor in an outsider's turn stamped otherwise (%s agent, audience %j): it reads shared statements only",
    async (visibility, audience) => {
      const h = await makeHarness({ agent: { visibility } });
      const mine = h.ctx({ conversationId: PRIVATE_CONV });
      await h.remember({ about: 'launch_plan', relation: 'codename', value: SECRET }, mine);
      await engineRecord(h.bus, mine, [
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
      const outsider = h.ctx({ conversationId: CHANNEL, source: 'external', ...(audience !== undefined ? { audience } : {}) });

      const reads = await engineReadsDuring(h, async () => {
        expect(values(await h.recall({}, outsider))).toEqual([PUBLIC]);
        for (const input of RECALL_SHAPES) {
          expect(values(await h.recall(input, outsider)), JSON.stringify(input)).not.toContain(SECRET);
        }
        const block = await augment(h, outsider);
        expect(block).toContain(PUBLIC);
        expect(block).not.toContain('Nightjar');
        const tool = await recallTool(h, outsider, 'launch');
        expect(tool).toContain(PUBLIC);
        expect(tool).not.toContain('Nightjar');
      });
      expect(reads.length).toBeGreaterThan(0);
      for (const input of reads) expect(input.audience).toBe('shared');
    },
  );

  // TASK-1209: on a team agent the stamp of an outsider's turn changes
  // nothing either. An outsider's turn there reads unscoped whatever it says.
  it.each([
    ['team', 'private'],
    ['team', undefined],
  ] as const)(
    "an outsider's turn stamped otherwise on a %s agent (audience %j) recalls everything too, unscoped (TASK-1209)",
    async (visibility, audience) => {
      const h = await makeHarness({ agent: { visibility } });
      const mine = h.ctx({ conversationId: PRIVATE_CONV });
      await h.remember({ about: 'launch_plan', relation: 'codename', value: SECRET }, mine);
      await engineRecord(h.bus, mine, [
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
      const outsider = h.ctx({ conversationId: CHANNEL, source: 'external', ...(audience !== undefined ? { audience } : {}) });

      const reads = await engineReadsDuring(h, async () => {
        expect(values(await h.recall({}, outsider)).sort()).toEqual([PUBLIC, SECRET].sort());
        expect(values(await h.recall({ query: 'launch' }, outsider)).sort()).toEqual([PUBLIC, SECRET].sort());
        const block = await augment(h, outsider);
        expect(block).toContain(PUBLIC);
        expect(block).toContain('Nightjar');
        const tool = await recallTool(h, outsider, 'launch');
        expect(tool).toContain(PUBLIC);
        expect(tool).toContain('Nightjar');
      });
      expect(reads.length).toBeGreaterThan(0);
      for (const input of reads) expect(input).not.toHaveProperty('audience');
    },
  );

  // TASK-1209's security review: on a team agent only a source this build
  // knows reads unscoped. One it doesn't know fails closed, as
  // `isOutsiderTurn` does: whatever its stamp, it reads what the room could
  // see, backstop and all.
  it.each(['shared', 'private', undefined] as const)(
    "a turn from a source this build doesn't know recalls shared statements only on a team agent (audience %j), backstop and all",
    async (audience) => {
      const h = await makeHarness({ agent: { visibility: 'team' } });
      const mine = h.ctx({ conversationId: PRIVATE_CONV });
      await h.remember({ about: 'launch_plan', relation: 'codename', value: SECRET }, mine);
      await engineRecord(h.bus, mine, [
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
      const unknown = h.ctx({
        conversationId: CHANNEL,
        source: 'satellite' as AgentContextSource,
        ...(audience !== undefined ? { audience } : {}),
      });

      const reads = await engineReadsDuring(h, async () => {
        expect(values(await h.recall({}, unknown))).toEqual([PUBLIC]);
        for (const input of RECALL_SHAPES) {
          expect(values(await h.recall(input, unknown)), JSON.stringify(input)).not.toContain(SECRET);
        }
        const block = await augment(h, unknown);
        expect(block).toContain(PUBLIC);
        expect(block).not.toContain('Nightjar');
        const tool = await recallTool(h, unknown, 'launch');
        expect(tool).toContain(PUBLIC);
        expect(tool).not.toContain('Nightjar');
      });
      expect(reads.length).toBeGreaterThan(0);
      for (const input of reads) expect(input.audience).toBe('shared');

      // The backstop: an engine that drops the scope hands back the private
      // row, and every read fails rather than show it.
      engineIgnoresAudience(h);
      await expect(h.recall({}, unknown)).rejects.toMatchObject({ code: 'invalid-return', hookName: FACTS_RECALL_HOOK });
      await expect(recallTool(h, unknown, 'launch')).rejects.toMatchObject({ code: 'invalid-return' });
      await expect(augment(h, unknown)).rejects.toMatchObject({ code: 'invalid-return' });
    },
  );

  // Design §4c (TASK-1204): a team agent's memory is the team's, so a
  // member's shared turn reads exactly what the member's own private turn
  // reads. (So does an outsider's turn on it, TASK-1209: the tests above.)
  it("a team agent's member turn in a shared conversation recalls everything (TASK-1204)", async () => {
    const h = await makeHarness({ agent: { visibility: 'team' } });
    const mine = h.ctx({ conversationId: PRIVATE_CONV });
    // A member in the channel: the turn runs as her, and the room reads the reply.
    const shared = h.ctx({ conversationId: CHANNEL, source: 'user', audience: 'shared' });
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

    expect(values(await h.recall({}, shared)).sort()).toEqual([PUBLIC, SECRET].sort());
    expect(values(await h.recall({ query: 'launch' }, shared)).sort()).toEqual([PUBLIC, SECRET].sort());
    // Every read shape answers the shared turn what it answers the owner's
    // own turn. (Not every shape finds the private statement there either: a
    // profile read is about the person, and a conversation feed is one chat.)
    for (const input of RECALL_SHAPES) {
      expect(values(await h.recall(input, shared)).sort(), JSON.stringify(input)).toEqual(
        values(await h.recall(input, mine)).sort(),
      );
    }
    for (const input of [{}, { query: 'launch' }, { about: 'launch_plan' }, { activeOnly: false }, { conversationId: PRIVATE_CONV }]) {
      expect(values(await h.recall(input, shared)), JSON.stringify(input)).toContain(SECRET);
    }
    // The block injected into the shared turn's prompt, and the tool.
    const block = await augment(h, shared);
    expect(block).toContain(PUBLIC);
    expect(block).toContain('Nightjar');
    const tool = await recallTool(h, shared, 'launch');
    expect(tool).toContain(PUBLIC);
    expect(tool).toContain('Nightjar');
  });

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
  // every row it has. `sharedCtx` is an outsider's turn, which keeps the
  // backstop on a personal agent. (On a team agent it reads everything, so
  // there is no scope to ignore: the next test, TASK-1209.)
  it.each(['personal'] as const)('a shared read that gets a non-shared row back fails instead of returning it (%s agent)', async (visibility) => {
    const h = await makeHarness({ agent: { visibility } });
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

  // TASK-1209: an outsider's read on a team agent asks for every row, so the
  // same engine (one that drops the scope) has nothing to drop, and its
  // answer is the answer: the private row comes back, and nothing throws.
  it("an outsider's read on a team agent is never backstopped: the private row comes back (TASK-1209)", async () => {
    const h = await makeHarness({ agent: { visibility: 'team' } });
    await h.remember(
      { about: 'launch_plan', relation: 'codename', value: SECRET },
      h.ctx({ conversationId: PRIVATE_CONV }),
    );
    engineIgnoresAudience(h);

    const shared = sharedCtx(h);
    expect(values(await h.recall({}, shared))).toEqual([SECRET]);
    expect(values(await h.recall({ query: 'launch' }, shared))).toEqual([SECRET]);
    expect(await recallTool(h, shared, 'launch')).toContain('Nightjar');
    expect(await augment(h, shared)).toContain('Nightjar');
  });

  const REMEMBER = { about: 'launch_plan', relation: 'date', value: PUBLIC };
  /**
   * Every hook `rejectPrivilegeFields` guards in `plugin.ts`, each with a
   * payload that is otherwise well formed, so the field is the only thing
   * left to refuse.
   */
  const GUARDED_HOOKS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['memory:recall', {}],
    ['memory:remember', REMEMBER],
    ['memory:correct', { id: 'row-1', ...REMEMBER, reason: 'changed' }],
    ['memory:forget', { ids: ['row-1'] }],
    ['memory:unforget', { ids: ['row-1'] }],
    ['memory:uncorrect', { id: 'row-2', restore: 'row-1' }],
    ['memory:recall-receipts', { conversationId: CHANNEL }],
  ];
  it.each(
    GUARDED_HOOKS.flatMap(([hook, payload]) => [
      // A shared turn asking to widen its own read.
      [hook, 'private', 'shared', payload] as const,
      // A private turn naming any audience at all.
      [hook, 'shared', undefined, payload] as const,
    ]),
  )(
    'audience is not a caller-settable field: %s refuses audience %j (turn audience %j)',
    async (hook, audience, turnAudience, payload) => {
      const h = await makeHarness();
      const ctx = turnAudience === undefined ? h.ctx() : h.ctx({ audience: turnAudience });
      const spy = vi.spyOn(h.bus, 'call');
      await expect(h.bus.call(hook, ctx, { ...payload, audience })).rejects.toMatchObject({
        code: 'invalid-payload',
        message: expect.stringContaining('audience is not a caller-settable field'),
      });
      // Refused before anything else: no access check, nothing read, nothing written.
      expect(spy.mock.calls.map(([called]) => called)).toEqual([hook]);
    },
  );
});

describe('recallFacts — the one door every engine read goes through', () => {
  /**
   * Whose memory a read is in: a personal agent keeps the audience scope, and
   * a team agent's memory is read unscoped in a member's turn (TASK-1204) and
   * an outsider's (TASK-1209), but not from a source this build doesn't know.
   */
  const PERSONAL_AGENT = { visibility: 'personal' } as const;
  const TEAM_AGENT = { visibility: 'team' } as const;
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
    const failure: unknown = await recallFacts(bus, turn('shared'), PERSONAL_AGENT, FACTS_RECALL_HOOK, {}).then(
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
    await expect(recallFacts(bus, turn('shared'), PERSONAL_AGENT, FACTS_RECALL_HOOK, {})).rejects.toMatchObject({
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
    expect(recallAudienceScope(odd, PERSONAL_AGENT)).toEqual({ audience: 'shared' });
    const { bus, asked } = engineAnswering({ statements: [{ ...ROW }], degraded: [] });
    await expect(recallFacts(bus, odd, PERSONAL_AGENT, FACTS_RECALL_HOOK, {})).rejects.toMatchObject({ code: 'invalid-return' });
    expect(asked).toEqual([{ audience: 'shared' }]);
  });

  it('spreads the scope last, so a caller-built input cannot widen a shared read', async () => {
    const { bus, asked } = engineAnswering({ statements: [], degraded: [] });
    await recallFacts(bus, turn('shared'), PERSONAL_AGENT, FACTS_RECALL_HOOK, { limit: 5, audience: 'private' });
    expect(asked).toEqual([{ limit: 5, audience: 'shared' }]);
  });

  it('a private read sends no scope and passes every row through untouched', async () => {
    const answer = { statements: [{ ...ROW }, { ...ROW, audience: 'private' }], degraded: [] };
    for (const ctx of [turn(), turn('private')]) {
      const { bus, asked } = engineAnswering(answer);
      expect(await recallFacts(bus, ctx, PERSONAL_AGENT, FACTS_RECALL_HOOK, { limit: 5 })).toBe(answer);
      expect(asked).toEqual([{ limit: 5 }]);
    }
  });

  // Spreading the scope last isn't enough on its own: a private turn's scope
  // is empty, so it overrides nothing.
  it.each(['shared', 'private', 'public', undefined])(
    'a private read drops a caller-built audience %j: the scope comes from ctx alone',
    async (audience) => {
      for (const ctx of [turn(), turn('private')]) {
        const { bus, asked } = engineAnswering({ statements: [], degraded: [] });
        await recallFacts(bus, ctx, PERSONAL_AGENT, FACTS_RECALL_HOOK, { limit: 5, audience });
        // Strict: a key holding `undefined` is still a key.
        expect(asked).toStrictEqual([{ limit: 5 }]);
      }
    },
  );

  // Each caller refuses these on its own terms; the wrapper adds nothing a
  // caller could mistake for an answer.
  it.each([
    ['no answer', null],
    ['a non-array statements', { statements: 'rows', degraded: [] }],
  ])('leaves %s to the caller, unchanged', async (_label, answer) => {
    const { bus } = engineAnswering(answer);
    expect(await recallFacts(bus, turn('shared'), PERSONAL_AGENT, FACTS_RECALL_HOOK, {})).toBe(answer);
  });

  // TASK-1204, design §4c: a team agent's memory is the team's, so a member's
  // read is not scoped by audience in any session, and a private or unstamped
  // row in the answer is simply part of it. (`turn` names no source: a member's.)
  it("a team agent's member read carries no audience scope, and its answer is not checked for stamps (TASK-1204)", async () => {
    const answer = { statements: [{ ...ROW, audience: 'private' }, { ...ROW }], degraded: [] };
    const odd = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: ALICE, audience: 'public' as never });
    for (const ctx of [turn('shared'), odd, turn(), turn('private')]) {
      expect(recallAudienceScope(ctx, TEAM_AGENT)).toEqual({});
      const { bus, asked } = engineAnswering(answer);
      expect(await recallFacts(bus, ctx, TEAM_AGENT, FACTS_RECALL_HOOK, { limit: 5 })).toBe(answer);
      // Strict: no `audience` key at all, not even one holding `undefined`.
      expect(asked).toStrictEqual([{ limit: 5 }]);
    }
  });

  it("a team agent's read still drops a caller-built audience: the scope never comes from input", async () => {
    for (const audience of ['shared', 'private', 'public']) {
      const { bus, asked } = engineAnswering({ statements: [], degraded: [] });
      await recallFacts(bus, turn('shared'), TEAM_AGENT, FACTS_RECALL_HOOK, { limit: 5, audience });
      expect(asked).toStrictEqual([{ limit: 5 }]);
    }
  });

  /** An outsider's turn, by its audience stamp and its source. A source this build doesn't know reads as an outsider's. */
  const OUTSIDER_TURNS = [
    ['shared', 'external'],
    ['public', 'external'],
    ['shared', 'satellite'],
    ['private', 'external'],
    [undefined, 'external'],
    ['private', 'satellite'],
  ] as const;
  const outsiderTurn = (audience: string | undefined, source: string): AgentContext =>
    makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      ...(audience !== undefined ? { audience: audience as never } : {}),
      source: source as never,
    });

  // On a personal agent an outsider's turn keeps shared-only recall, and its
  // backstop. Whatever its audience stamp (review F3): an outsider's turn is
  // read by someone without access to the agent, so a private stamp, or
  // none, fails closed. No live producer sends one.
  it.each(OUTSIDER_TURNS)("an outsider's read keeps the shared scope and its backstop on a personal agent: audience %j, source %j", async (audience, source) => {
    const outsider = outsiderTurn(audience, source);
    for (const agent of [PERSONAL_AGENT]) {
      const { bus, asked } = engineAnswering({ statements: [{ ...ROW, audience: 'shared' }, { ...ROW, audience: 'private' }], degraded: [] });
      const failure: unknown = await recallFacts(bus, outsider, agent, FACTS_RECALL_HOOK, { limit: 5, audience: 'private' }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(failure, agent.visibility).toMatchObject({ code: 'invalid-return', hookName: FACTS_RECALL_HOOK });
      expect((failure as Error).message).not.toContain('Nightjar');
      expect(asked, agent.visibility).toStrictEqual([{ limit: 5, audience: 'shared' }]);
    }
  });

  // TASK-1209, design §4c: a team agent's memory is shared with anyone who
  // talks to it, so an outsider's read there is a member's read: no scope,
  // whatever its stamp, and its answer is not checked for stamps. It still
  // drops a caller-built audience.
  it.each(OUTSIDER_TURNS.filter(([, source]) => source === 'external'))("an outsider's read on a team agent is unscoped and never backstopped: audience %j, source %j", async (audience, source) => {
    const outsider = outsiderTurn(audience, source);
    expect(recallAudienceScope(outsider, TEAM_AGENT)).toStrictEqual({});
    const answer = { statements: [{ ...ROW, audience: 'shared' }, { ...ROW, audience: 'private' }], degraded: [] };
    const { bus, asked } = engineAnswering(answer);
    const out = await recallFacts<typeof answer>(bus, outsider, TEAM_AGENT, FACTS_RECALL_HOOK, { limit: 5, audience: 'private' });
    expect(out).toBe(answer);
    expect(out?.statements.map((s) => s.audience)).toContain('private');
    // Strict: no `audience` key at all, not even one holding `undefined`.
    expect(asked).toStrictEqual([{ limit: 5 }]);
  });

  // TASK-1209's security review: only a source this build knows reads a team
  // agent's memory unscoped. One it doesn't know fails closed there too,
  // whatever its stamp: the shared scope, and its backstop.
  it.each(OUTSIDER_TURNS.filter(([, source]) => source !== 'external'))("a read from a source this build doesn't know keeps the shared scope and its backstop on a team agent: audience %j, source %j", async (audience, source) => {
    const unknown = outsiderTurn(audience, source);
    expect(recallAudienceScope(unknown, TEAM_AGENT)).toStrictEqual({ audience: 'shared' });
    const { bus, asked } = engineAnswering({ statements: [{ ...ROW, audience: 'shared' }, { ...ROW, audience: 'private' }], degraded: [] });
    const failure: unknown = await recallFacts(bus, unknown, TEAM_AGENT, FACTS_RECALL_HOOK, { limit: 5, audience: 'private' }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toMatchObject({ code: 'invalid-return', hookName: FACTS_RECALL_HOOK });
    expect((failure as Error).message).not.toContain('Nightjar');
    expect(asked).toStrictEqual([{ limit: 5, audience: 'shared' }]);
  });

  it.each([
    // audience, source, visibility, scope
    ['shared', 'user', 'team', {}],
    ['shared', undefined, 'team', {}],
    ['public', 'user', 'team', {}], // a member's turn in an audience this build doesn't know: still the team's
    ['public', undefined, 'team', {}],
    [undefined, 'user', 'team', {}],
    // A member's own scheduled run reads what their turn does (TASK-1204), in any audience.
    ['shared', 'routine', 'team', {}],
    ['private', 'routine', 'team', {}],
    [undefined, 'routine', 'team', {}],
    ['public', 'routine', 'team', {}],
    // An outsider's turn on a team agent reads what a member's does (TASK-1209),
    // whatever its stamp, an audience this build doesn't know included.
    ['shared', 'external', 'team', {}],
    ['public', 'external', 'team', {}],
    ['private', 'external', 'team', {}],
    [undefined, 'external', 'team', {}],
    // A source this build doesn't know fails closed on a team agent too
    // (TASK-1209's security review), whatever its stamp.
    ['shared', 'satellite', 'team', { audience: 'shared' }],
    ['public', 'satellite', 'team', { audience: 'shared' }],
    ['private', 'satellite', 'team', { audience: 'shared' }],
    [undefined, 'satellite', 'team', { audience: 'shared' }],
    // On a personal agent an outsider's turn, whatever its stamp, reads what
    // the room could see (review F3: fail closed, no live producer), and an
    // unknown source reads as an outsider's.
    ['private', 'external', 'personal', { audience: 'shared' }],
    [undefined, 'external', 'personal', { audience: 'shared' }],
    ['private', 'satellite', 'personal', { audience: 'shared' }],
    [undefined, 'satellite', 'personal', { audience: 'shared' }],
    ['shared', 'user', 'personal', { audience: 'shared' }],
    ['shared', 'external', 'personal', { audience: 'shared' }],
    ['private', 'user', 'personal', {}],
    [undefined, undefined, 'personal', {}], // an owner route: no stamp, no source
    ['shared', 'user', 'bogus', { audience: 'shared' }], // an unknown visibility keeps the scope
    ['shared', 'external', 'bogus', { audience: 'shared' }], // ...and an outsider's on it, a personal agent's rule
  ])('the recall scope of audience %j, source %j on a %s agent is %j', (audience, source, visibility, scope) => {
    expect(recallAudienceScope({ audience, source } as never, { visibility } as never)).toStrictEqual(scope);
  });

  // Only a team agent reads unscoped: a visibility this build doesn't know
  // keeps a shared turn's scope, as a personal agent's does.
  it('a visibility this build does not know keeps the scope', async () => {
    expect(recallAudienceScope(turn('shared'), { visibility: 'bogus' } as never)).toEqual({ audience: 'shared' });
    const { bus, asked } = engineAnswering({ statements: [{ ...ROW, audience: 'private' }], degraded: [] });
    await expect(
      recallFacts(bus, turn('shared'), { visibility: 'bogus' } as never, FACTS_RECALL_HOOK, {}),
    ).rejects.toMatchObject({ code: 'invalid-return' });
    expect(asked).toEqual([{ audience: 'shared' }]);
  });
});

// ---------------------------------------------------------------------------
// The write side: every statement is stamped with its turn's audience, and a
// shared turn stores nothing under a person subject.
// ---------------------------------------------------------------------------

/**
 * Every row in the engine's table, closed ones included, straight off disk:
 * the stamp a row was STORED with, which no read path is trusted to show.
 */
function storedRows(h: MemoryHarness): Array<{
  about: string;
  value: string;
  audience: string | null;
  conversation_id: string | null;
}> {
  const db = new Database(h.databasePath, { readonly: true });
  try {
    return db
      .prepare('SELECT about, value, audience, conversation_id FROM memory_facts_v1 ORDER BY rowid')
      .all() as never;
  } finally {
    db.close();
  }
}

/** The subjects a shared turn stores nothing about (Review focus 4). */
const PERSON_SUBJECTS = [
  'user',
  'User',
  'USER',
  ' user ',
  '\tuser\n',
  'user:abc',
  'User:Bob',
  `  user:${ALICE}  `,
  'user:',
  // Lookalikes and invisibles a bare trim() keeps (NFKC + format-char strip).
  '\uFF55\uFF53\uFF45\uFF52', // fullwidth "user"
  'u\u200Bser', // zero-width space inside
  '\uFEFFuser', // BOM prefix
  'user\u2060:abc', // word joiner before the colon
  'user :abc',
  'USER\t:abc',
];
/** Subjects that only look like one. A false match costs a fact, so these stay. */
const NOT_PERSON_SUBJECTS = [
  'users',
  'username',
  'user_research',
  'User Research',
  'superuser',
  'the user',
  'user-abc',
  'assistant',
  'billing_service',
];

/**
 * The speakers' names in the TASK-1146 tests: what a channel's sender label
 * shows for its sender, a display name and a member id.
 */
const NAMES = ['Vinay Pulim', 'UHTE83XE1'];
// Spelled as escapes in this file, never as the characters: one is a
// lookalike, one is invisible.
const FULLWIDTH_VINAY = '\uff56\uff49\uff4e\uff41\uff59'; // fullwidth "vinay"
const ZWSP_VINAY = 'vi\u200bnay'; // zero-width space inside
/** Subjects made of NAMES' words: a shared turn stores nothing under them (TASK-1146). */
const NAMES_A_SPEAKER = [
  'vinay',
  'Vinay',
  'VINAY',
  ' vinay ',
  'pulim',
  'vinay_pulim',
  'Vinay Pulim',
  'vinay-pulim',
  'vinay.pulim',
  'pulim_vinay',
  'vinaypulim',
  'uhte83xe1',
  'vinay_uhte83xe1',
  // The extractor's own speaker word next to a real name: still the speaker.
  'user_vinay',
  'vinay_user',
  'user_uhte83xe1',
  'User Vinay',
  'user_vinaypulim',
  'vinaypulim_user',
  FULLWIDTH_VINAY,
  ZWSP_VINAY,
];
/**
 * Subjects that aren't made of NAMES' words alone: the work, the speaker's
 * things, a role word, and subjects with no words at all. These stay.
 */
const NOT_A_SPEAKER = [
  'team_standup',
  'vinays_team',
  'vinay_s_team',
  'vinay_laptop',
  // A role word beside a non-name is about something else. (The speaker word
  // alone is isPersonSubject's job: see the test below.)
  'user_settings',
  'team_user',
  'user_vinaypulim_laptop',
  'billing_service',
  'assistant',
  'v',
  'vin',
  '',
  '___',
];

/**
 * Longer than the speaker rule reads: in a turn others read it breaks the
 * rule unread, on every path.
 */
const TOO_LONG_TO_READ = 'x'.repeat(1025);

/**
 * Spellings self-report reads as the agent itself (`isAgentSubject`): a team
 * agent's member turn keeps each as written, whatever a display name says
 * (TASK-1204 review F9).
 */
const AGENT_SELF_SUBJECTS = [
  'assistant',
  'Assistant',
  ' assistant ',
  'the_assistant',
  'the assistant',
  'ai_assistant',
  'AI Assistant',
  'ai-assistant',
  'agent',
  'Agent',
  'the_agent',
  'The Agent',
];

/**
 * A personal agent's memory, as `resolveMemoryAccess` answers its owner: the
 * access a bare-bus `recordFacts` call is handed (TASK-1204). A personal
 * agent's shared turn keeps the speaker rule.
 */
const PERSONAL: MemoryAccess = { userId: ALICE, visibility: 'personal' };

/**
 * The extractor's answer in the speaker tests: four ways a model writes the
 * speaker, and one fact about something else.
 */
const SPEAKER_FACTS = [
  { subject: 'user', predicate: 'lives_in', object: 'Paris' },
  { subject: 'User', predicate: 'prefers', object: 'tea' },
  { subject: ' user ', predicate: 'role', object: 'admin' },
  { subject: 'user:abc', predicate: 'works_at', object: 'Initech' },
  { subject: 'billing_service', predicate: 'owner', object: 'Dana' },
];
const SPEAKER_TURN = [
  {
    role: 'user',
    content: 'I live in Paris, I prefer tea, I am an admin and I work at Initech. Dana owns the billing service.',
  },
  { role: 'assistant', content: 'Thanks, noted.' },
];

/** One `chat:end` observer pass, awaited. */
async function observeTurn(h: MemoryHarness, ctx: AgentContext, messages: unknown[] = SPEAKER_TURN): Promise<void> {
  await h.bus.fire('chat:end', ctx, { outcome: { kind: 'complete', messages } });
  await h.settleObserver();
}

describe("@ax/memory — every write carries its turn's audience; a shared turn keeps no speaker facts (TASK-1091)", () => {
  it('a shared turn stores no speaker facts', async () => {
    const h = await makeHarness({ llm: () => extractionReply(SPEAKER_FACTS) });
    await observeTurn(h, sharedCtx(h));

    // The billing row alone: nothing about the speaker however the model
    // wrote it, and so nothing under the owner's own key either.
    expect(storedRows(h)).toEqual([
      { about: 'billing_service', value: 'Dana', audience: 'shared', conversation_id: CHANNEL },
    ]);
    const run = eventsNamed(h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'recorded', recorded: 1, speakerFacts: 4 });
  });

  it('a private turn still rewrites the speaker', async () => {
    const h = await makeHarness({ llm: () => extractionReply(SPEAKER_FACTS) });
    await observeTurn(h, h.ctx({ conversationId: PRIVATE_CONV }));

    // Everything is stored, stamped private, and the rewrite stays narrow:
    // only the exact literal `user` becomes the owner's key (`subject.ts`).
    expect(storedRows(h).map((r) => `${r.about}|${r.value}|${r.audience}`).sort()).toEqual(
      [
        `user:${ALICE}|Paris|private`,
        'User|tea|private',
        ' user |admin|private',
        'user:abc|Initech|private',
        'billing_service|Dana|private',
      ].sort(),
    );
    const run = eventsNamed(h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'recorded', recorded: 5, speakerFacts: 0 });
  });

  it('a shared turn whose every fact is about a person writes nothing, and says why', async () => {
    const h = await makeHarness({ llm: () => extractionReply(SPEAKER_FACTS.slice(0, 4)) });
    const spy = vi.spyOn(h.bus, 'call');
    await observeTurn(h, sharedCtx(h));

    expect(spy.mock.calls.some(([hook]) => hook === FACTS_RECORD_HOOK)).toBe(false);
    expect(storedRows(h)).toEqual([]);
    const run = eventsNamed(h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({
      outcome: 'skipped',
      reason: 'only-speaker-facts',
      speakerFacts: 4,
    });
  });

  it.each([
    ['an absent-audience', 'private', undefined],
    ['a private', 'private', 'private'],
    ['a shared', 'shared', 'shared'],
  ] as const)("every write is stamped with its turn's audience (%s turn: %s)", async (_label, stamped, audience) => {
    const h = await makeHarness({
      llm: () => extractionReply([{ subject: 'billing_service', predicate: 'owner', object: 'Dana' }]),
    });
    const ctx = h.ctx({ conversationId: CHANNEL, ...(audience !== undefined ? { audience } : {}) });

    // The person's writes...
    const { id } = await h.remember({ about: 'launch_plan', relation: 'date', value: 'March' }, ctx);
    await h.correct({ id, about: 'launch_plan', relation: 'date', value: 'April', reason: 'changed' }, ctx);
    // ...the agent's note...
    expect(
      await h.bus.call(MEMORY_NOTE_TOOL_HOOK, ctx, {
        input: { about: 'standup', relation: 'held_at', value: '9am' },
      }),
    ).toEqual({ ok: true });
    // ...and the observer's batch.
    await observeTurn(h, ctx, [
      { role: 'user', content: 'Dana owns the billing service.' },
      { role: 'assistant', content: 'Noted.' },
    ]);

    const rows = storedRows(h);
    expect(rows.map((r) => r.value).sort()).toEqual(['9am', 'April', 'Dana', 'March']);
    // Present on every row, private ones too: a row stored from now on always
    // says who could see the turn it was learned in.
    for (const row of rows) expect(row.audience, row.value).toBe(stamped);
  });

  // `memory:remember` drops nothing itself (only owner routes call it, with
  // no audience), so this is the write door's own refusal, end to end.
  it.each(['user', 'User', ' user ', `user:${ALICE}`, 'user:someone'])(
    'memory:remember about %j in a shared turn is refused forbidden, and nothing is stored',
    async (about) => {
      const h = await makeHarness();
      const spy = vi.spyOn(h.bus, 'call');
      const failure: unknown = await h.remember({ about, relation: 'lives_in', value: 'Paris' }, sharedCtx(h)).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(failure).toMatchObject({ code: 'forbidden', plugin: '@ax/memory', hookName: FACTS_RECORD_HOOK });
      expect((failure as Error).message).not.toContain('Paris');
      expect(spy.mock.calls.some(([hook]) => hook === FACTS_RECORD_HOOK)).toBe(false);
      expect(storedRows(h)).toEqual([]);
    },
  );

  it('a shared turn stores nothing under a speaker name either (TASK-1146)', async () => {
    const h = await makeHarness({
      llm: () =>
        extractionReply([
          ...SPEAKER_FACTS,
          { subject: 'vinay', predicate: 'stated_standup_time', object: 'Team standup moved to 10:15 on Tuesdays' },
          { subject: 'Vinay_Pulim', predicate: 'prefers', object: 'tea' },
        ]),
    });
    const asked = answerSpeakerNames(h.bus, NAMES);
    await observeTurn(h, sharedCtx(h));

    // The billing row alone: nothing under `user`, and nothing under the
    // names the conversation's speaker was labelled with.
    expect(storedRows(h)).toEqual([
      { about: 'billing_service', value: 'Dana', audience: 'shared', conversation_id: CHANNEL },
    ]);
    const run = eventsNamed(h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'recorded', recorded: 1, speakerFacts: 6 });
    // One ask for the pass, about the conversation alone: memory never fills
    // in names itself, and its write doesn't ask again.
    expect(asked).toEqual([{ conversationId: CHANNEL }]);
  });

  it('a private turn files a speaker name as written: names only matter where others read', async () => {
    const h = await makeHarness({
      llm: () =>
        extractionReply([
          { subject: 'vinay', predicate: 'stated_standup_time', object: 'Team standup moved to 10:15 on Tuesdays' },
        ]),
    });
    const asked = answerSpeakerNames(h.bus, NAMES);
    await observeTurn(h, h.ctx({ conversationId: PRIVATE_CONV }));

    expect(storedRows(h)).toEqual([
      {
        about: 'vinay',
        value: 'Team standup moved to 10:15 on Tuesdays',
        audience: 'private',
        conversation_id: PRIVATE_CONV,
      },
    ]);
    // Asked, and answered with the names, as a shared turn is.
    expect(asked).toEqual([{ conversationId: PRIVATE_CONV }]);

    // The control: the same names keep it out of a shared turn.
    await observeTurn(h, sharedCtx(h));
    expect(storedRows(h).map((r) => [r.about, r.audience])).toEqual([['vinay', 'private']]);
  });

  // Walk TASK-1134, end to end, with the names channel-slack now answers
  // (the label's display name and member id). The walk's note was `about:
  // user`, the observer filed the standup under `vinay`, and the agent told
  // the channel it couldn't save it.
  it('the walk, end to end: the work note is the one row, and nothing is filed under the speaker (TASK-1134, TASK-1146)', async () => {
    const WALK_FACTS = [
      { subject: 'vinay', predicate: 'stated_standup_time', object: 'Team standup moved to 10:15 on Tuesdays' },
      { network: 'experience', subject: 'assistant', predicate: 'could_not_save_memory', object: 'the standup time' },
    ];
    const WALK_TURN = [
      {
        role: 'user',
        content: '[Slack · #ax-test-internal · vinay (UHTE83XE1)]: Our team standup moved to 10:15 on Tuesdays.',
      },
      { role: 'assistant', content: 'Got it: team standup is at 10:15 on Tuesdays.' },
    ];
    const note = (h: MemoryHarness, ctx: AgentContext, about: string, relation: string): Promise<MemoryNoteResult> =>
      h.bus.call<unknown, MemoryNoteResult>(MEMORY_NOTE_TOOL_HOOK, ctx, {
        input: { about, relation, value: '10:15 on Tuesdays' },
      });

    const h = await makeHarness({ llm: () => extractionReply(WALK_FACTS) });
    const asked = answerSpeakerNames(h.bus, ['vinay', 'UHTE83XE1']);
    const ctx = h.ctx({ conversationId: CHANNEL, source: 'user', audience: 'shared' });

    // The walk's note, then the name a model might try instead: both refused,
    // with the text that points at the work.
    expect(await note(h, ctx, 'user', 'team standup time')).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await note(h, ctx, 'vinay', 'team standup time')).toEqual({
      ok: false,
      error: 'forbidden',
      message: `NOT SAVED: nothing was written to memory — do not tell the person it was saved. ${PERSON_IN_SHARED_MESSAGE}`,
    });
    // The work note the refusal points at is saved.
    expect(await note(h, ctx, 'team_standup', 'time')).toEqual({ ok: true });
    await observeTurn(h, ctx, WALK_TURN);

    expect(storedRows(h).map((r) => [r.about, r.audience])).toEqual([['team_standup', 'shared']]);
    expect(eventsNamed(h.logs, OBSERVER_RUN_EVENT).at(-1)?.bindings).toMatchObject({
      outcome: 'skipped',
      reason: 'only-speaker-facts',
      speakerFacts: 1,
    });
    // One ask for each note that got past the `user` check (TASK-1094's
    // order), and one for the pass.
    expect(asked).toHaveLength(3);

    // The control: the same turn, with nothing naming the speaker. The
    // observer files the standup under `vinay` beside the work note: the bug
    // this card fixes, and the proof the stub really extracts it.
    const control = await makeMemoryHarness({}, { llm: () => extractionReply(WALK_FACTS) });
    try {
      const controlCtx = control.ctx({ conversationId: CHANNEL, source: 'user', audience: 'shared' });
      expect(await note(control, controlCtx, 'team_standup', 'time')).toEqual({ ok: true });
      await observeTurn(control, controlCtx, WALK_TURN);
      expect(storedRows(control).map((r) => [r.about, r.audience])).toEqual([
        ['team_standup', 'shared'],
        ['vinay', 'shared'],
      ]);
    } finally {
      await control.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// TASK-1204: a team agent's member turn runs as the member who wrote it (one
// conversation per person per thread), so what they say about themself is
// theirs: kept, and filed under their own key, the one their web chats read.
// ---------------------------------------------------------------------------

describe('a team agent keeps what a member says about themself, under their own key (TASK-1204)', () => {
  /** A member talking in a team agent's channel: the turn runs as them, and the room reads the reply. */
  function member(h: MemoryHarness, userId: string, conversationId: string): AgentContext {
    return h.ctx({ userId, conversationId, source: 'user', audience: 'shared' });
  }
  /** An outsider's turn in a channel: it runs as the requester (Bob here), never as the person talking. */
  function outsider(h: MemoryHarness): AgentContext {
    return h.ctx({ userId: BOB, conversationId: 'conv-ext', source: 'external', audience: 'shared' });
  }
  /** Every stored row as `about|value|audience`, sorted. */
  function rows(h: MemoryHarness): string[] {
    return storedRows(h)
      .map((r) => `${r.about}|${r.value}|${r.audience}`)
      .sort();
  }
  function lastRun(h: MemoryHarness): Record<string, unknown> | undefined {
    return eventsNamed(h.logs, OBSERVER_RUN_EVENT).at(-1)?.bindings;
  }

  const ALICE_LABEL = ['Alice Smith', 'U123'];
  /** What Alice says about herself, as the extractor writes it, and one fact about the work. */
  const ALICE_FACTS = [
    { subject: 'alice_smith', predicate: 'favorite_color', object: 'teal' },
    { subject: 'user', predicate: 'lives_in', object: 'Lisbon' },
    { subject: 'billing_service', predicate: 'owner', object: 'Dana' },
  ];
  const ALICE_TURN = [
    {
      role: 'user',
      content: '[Slack · #general · Alice Smith (U123)]: my favorite color is teal. I live in Lisbon. Dana owns billing.',
    },
    { role: 'assistant', content: 'Noted.' },
  ];

  it('a member\'s "my favorite color is teal" is kept under their own key: not the requester\'s, not their name', async () => {
    const h = await makeHarness({ agent: { visibility: 'team' }, llm: () => extractionReply(ALICE_FACTS) });
    const asked = answerSpeakerNames(h.bus, ALICE_LABEL, 'conv-x');
    await observeTurn(h, member(h, ALICE, 'conv-x'), ALICE_TURN);

    // Both facts about Alice under her own key, however the extractor named
    // her, stamped private: they're the team's, not the room's (review F2).
    // The work as written, stamped shared. Nothing under her label name, and
    // nothing under anyone else's key.
    expect(rows(h)).toEqual(
      [`user:${ALICE}|teal|private`, `user:${ALICE}|Lisbon|private`, 'billing_service|Dana|shared'].sort(),
    );
    expect(storedRows(h).map((r) => r.about)).not.toContain('alice_smith');
    expect(lastRun(h)).toMatchObject({ outcome: 'recorded', recorded: 3, speakerFacts: 0 });
    // One ask for the pass: its write is handed the names, and doesn't ask again.
    expect(asked).toEqual([{ conversationId: 'conv-x' }]);

    // Alice's later web chat (a private turn, run as her) finds both...
    const web = values(await h.recall({ about: 'user' }, h.ctx({ conversationId: 'conv-web' })));
    expect(web.sort()).toEqual(['Lisbon', 'teal']);
    // ...and Bob's own key holds neither.
    expect(values(await h.recall({ about: 'user' }, h.ctx({ userId: BOB, conversationId: 'conv-web-b' })))).toEqual(
      [],
    );
  });

  it("two members in one Slack thread: each one's facts land under their own key, and a claim about the other under neither", async () => {
    // One Slack thread, two conversations: each member's turns run as them.
    const BOB_LABEL = 'Bob Jones (U456)';
    const h = await makeHarness({
      agent: { visibility: 'team' },
      llm: (input) =>
        String(input.messages[0]?.content ?? '').includes(BOB_LABEL)
          ? extractionReply([
              { subject: 'bob_jones', predicate: 'lives_in', object: 'Berlin' },
              { subject: 'alice', predicate: 'favorite_color', object: 'teal' },
            ])
          : extractionReply([{ subject: 'alice_smith', predicate: 'favorite_color', object: 'teal' }]),
    });
    answerSpeakerNames(h.bus, ALICE_LABEL, 'conv-x');
    answerSpeakerNames(h.bus, ['Bob Jones', 'U456'], 'conv-y');

    await observeTurn(h, member(h, ALICE, 'conv-x'), [
      { role: 'user', content: '[Slack · #general · Alice Smith (U123)]: my favorite color is teal.' },
      { role: 'assistant', content: 'Noted.' },
    ]);
    await observeTurn(h, member(h, BOB, 'conv-y'), [
      { role: 'user', content: `[Slack · #general · ${BOB_LABEL}]: I live in Berlin, and Alice's favorite color is teal.` },
      { role: 'assistant', content: 'Noted.' },
    ]);

    // Bob's claim about Alice is a third party's fact: as written, under
    // neither member's key, and shared like any fact said in the room. What
    // each says about themself is the team's (review F2).
    expect(rows(h)).toEqual(
      [`user:${ALICE}|teal|private`, `user:${BOB}|Berlin|private`, 'alice|teal|shared'].sort(),
    );
    expect(h.llmCalls).toHaveLength(2);
    // An outsider's turn recalls all three, as a member's does (TASK-1209).
    const away = outsider(h);
    expect((await h.recall({}, away)).statements.map((s) => `${s.about}|${s.value}`).sort()).toEqual(
      [`user:${ALICE}|teal`, `user:${BOB}|Berlin`, 'alice|teal'].sort(),
    );
  });

  // What a member says about themself in a channel is filed under their own
  // key. A team agent's memory is shared with anyone who talks to it
  // (TASK-1209, design §4c), so every member's turn reads it, and so does an
  // outsider's: neither turn has an audience scope on a team agent.
  it("what a member says about themself in a channel is the team's: members and outsiders recall it", async () => {
    const h = await makeHarness({ agent: { visibility: 'team' }, llm: () => extractionReply(ALICE_FACTS) });
    answerSpeakerNames(h.bus, ALICE_LABEL, 'conv-x');
    const channel = member(h, ALICE, 'conv-x');
    await observeTurn(h, channel, ALICE_TURN);
    expect(rows(h)).toEqual(
      [`user:${ALICE}|teal|private`, `user:${ALICE}|Lisbon|private`, 'billing_service|Dana|shared'].sort(),
    );

    // Her own channel turn and her web chat read it as hers...
    const web = h.ctx({ conversationId: 'conv-web' });
    for (const ctx of [channel, web]) {
      const label = ctx.conversationId;
      expect(values(await h.recall({}, ctx)).sort(), label).toEqual(['Dana', 'Lisbon', 'teal']);
      expect(values(await h.recall({ about: 'user' }, ctx)).sort(), label).toEqual(['Lisbon', 'teal']);
      const block = await augment(h, ctx);
      expect(block, label).toContain('### Profile');
      expect(block, label).toContain('teal');
      expect(block, label).toContain('Lisbon');
      expect(await recallTool(h, ctx, 'teal'), label).toContain('user favorite color: teal');
    }
    // ...and a teammate's channel turn reads it as the team's.
    const teammate = member(h, BOB, 'conv-y');
    expect(values(await h.recall({}, teammate)).sort()).toEqual(['Dana', 'Lisbon', 'teal']);
    expect(await recallTool(h, teammate, 'teal')).toContain('a teammate favorite color: teal');

    // An outsider's turn (run as Bob, who answers for the channel) recalls
    // it too, beside the work she mentioned: by every read shape what Bob's
    // own channel turn reads, in the block, and through the tool.
    const away = outsider(h);
    expect(values(await h.recall({}, away)).sort()).toEqual(['Dana', 'Lisbon', 'teal']);
    for (const input of [...RECALL_SHAPES, { query: 'teal' }, { query: 'Lisbon' }, { conversationId: 'conv-x' }]) {
      expect(
        (await h.recall(input, away)).statements.map((s) => s.id).sort(),
        JSON.stringify(input),
      ).toEqual((await h.recall(input, teammate)).statements.map((s) => s.id).sort());
    }
    expect(values(await h.recall({ query: 'teal' }, away))).toContain('teal');
    expect(values(await h.recall({ query: 'Lisbon' }, away))).toContain('Lisbon');
    const block = await augment(h, away);
    expect(block).toContain('Dana');
    expect(block).toContain('teal');
    expect(block).toContain('Lisbon');
    expect(await recallTool(h, away, 'teal')).toContain('teal');
    expect(await recallTool(h, away, 'Lisbon')).toContain('Lisbon');
    expect(await recallTool(h, away, 'billing')).toContain('Dana');
  });

  /** An outsider's words: about themself, under the requester's own key, and about the work. */
  const OUTSIDER_FACTS = [
    { subject: 'user', predicate: 'lives_in', object: 'Paris' },
    { subject: `user:${BOB}`, predicate: 'works_at', object: 'Initech' },
    { subject: 'billing_service', predicate: 'owner', object: 'Dana' },
  ];
  const OUTSIDER_TURN = [
    { role: 'user', content: 'I live in Paris and I work at Initech. Dana owns the billing service.' },
    { role: 'assistant', content: 'Thanks.' },
  ];

  // channel-slack's veto refuses every thread an outsider talks in (TASK-1094).
  it("an outsider's words are still never remembered: with the veto, nothing is extracted or stored", async () => {
    const h = await makeHarness({ agent: { visibility: 'team' }, llm: () => extractionReply(OUTSIDER_FACTS) });
    h.bus.subscribe(MEMORY_PRE_CAPTURE_HOOK, 'test-veto', async () => reject({ reason: 'channel-external-turn' }));
    await observeTurn(h, outsider(h), OUTSIDER_TURN);

    expect(storedRows(h)).toEqual([]);
    expect(h.llmCalls).toHaveLength(0);
  });

  // The backstop: a veto subscriber that throws, or misses memory's bound, is
  // skipped by the bus. In an outsider's turn `ctx.userId` is the requester,
  // so memory's own speaker rule keeps every person fact out, the requester's
  // key above all. Work facts in an outsider's thread still ride on
  // channel-slack's veto, as today.
  it("an outsider's words are still never remembered: with no veto at all, nothing lands under a person", async () => {
    const h = await makeHarness({ agent: { visibility: 'team' }, llm: () => extractionReply(OUTSIDER_FACTS) });
    await observeTurn(h, outsider(h), OUTSIDER_TURN);

    expect(storedRows(h).filter((r) => r.about.startsWith('user:'))).toEqual([]);
    expect(rows(h)).toEqual(['billing_service|Dana|shared']);
    expect(lastRun(h)).toMatchObject({ outcome: 'recorded', recorded: 1, speakerFacts: 2 });
  });

  // Neither combination has a live producer (channel-slack stamps an
  // outsider's turn shared), so both must fail closed: an outsider's turn is
  // `withheld` whatever its audience, and a source this build doesn't know
  // reads as an outsider's (`isOutsiderTurn`).
  it.each([
    ['an outsider turn stamped private', 'external', 'private'],
    ['a turn from a source this build does not know', 'satellite', 'shared'],
  ] as const)("%s keeps the speaker rule on the observer and the note: nothing under the runner's key", async (_label, source, audience) => {
    const h = await makeHarness({ agent: { visibility: 'team' }, llm: () => extractionReply(OUTSIDER_FACTS) });
    const ctx = h.ctx({ userId: BOB, conversationId: 'conv-ext', source: source as AgentContextSource, audience });

    await observeTurn(h, ctx, OUTSIDER_TURN);
    const note = await h.bus.call<unknown, MemoryNoteResult>(MEMORY_NOTE_TOOL_HOOK, ctx, {
      input: { about: 'user', relation: 'lives_in', value: 'Paris' },
    });

    expect(note).toEqual({
      ok: false,
      error: 'forbidden',
      message: `NOT SAVED: nothing was written to memory — do not tell the person it was saved. ${PERSON_IN_SHARED_MESSAGE}`,
    });
    expect(rows(h)).toEqual([`billing_service|Dana|${audience}`]);
    expect(lastRun(h)).toMatchObject({ outcome: 'recorded', recorded: 1, speakerFacts: 2 });
  });

  it("a personal agent's member turn is unchanged: no speaker fact, the work fact stamped shared", async () => {
    const h = await makeHarness({ llm: () => extractionReply(ALICE_FACTS) });
    answerSpeakerNames(h.bus, ALICE_LABEL, 'conv-x');
    await observeTurn(h, member(h, ALICE, 'conv-x'), ALICE_TURN);

    expect(rows(h)).toEqual(['billing_service|Dana|shared']);
    expect(lastRun(h)).toMatchObject({ outcome: 'recorded', recorded: 1, speakerFacts: 2 });
  });

  // Review F9: a member whose display name is the agent's own word ("AI
  // Assistant", "Agent Smith") doesn't pull the agent's facts under their
  // key. Every subject self-report reads as the agent stays as written, on
  // the observer and the note alike; the member's own facts are still theirs.
  it("a member named like the agent: the agent's own facts stay the agent's, the member's are theirs", async () => {
    const h = await makeHarness({
      agent: { visibility: 'team' },
      llm: (input) =>
        String(input.messages[0]?.content ?? '').includes('Agent Smith (U8)')
          ? extractionReply([
              { subject: 'agent', predicate: 'could_not_get', object: 'the seller to accept 450k' },
              { subject: 'agent_smith', predicate: 'lives_in', object: 'Porto' },
            ])
          : extractionReply([
              { subject: 'ai_assistant', predicate: 'favorite_color', object: 'teal' },
              { subject: 'user', predicate: 'lives_in', object: 'Lisbon' },
            ]),
    });
    answerSpeakerNames(h.bus, ['AI Assistant', 'U7'], 'conv-x');
    answerSpeakerNames(h.bus, ['Agent Smith', 'U8'], 'conv-y');

    await observeTurn(h, member(h, ALICE, 'conv-x'), [
      { role: 'user', content: '[Slack · #general · AI Assistant (U7)]: I live in Lisbon. What colour do you like?' },
      { role: 'assistant', content: 'Teal, I think.' },
    ]);
    await observeTurn(h, member(h, BOB, 'conv-y'), [
      { role: 'user', content: '[Slack · #general · Agent Smith (U8)]: I live in Porto. Our agent could not get the seller to accept 450k.' },
      { role: 'assistant', content: 'Noted.' },
    ]);
    const note = await h.bus.call<unknown, MemoryNoteResult>(MEMORY_NOTE_TOOL_HOOK, member(h, ALICE, 'conv-x'), {
      input: { about: 'AI Assistant', relation: 'tone', value: 'friendly' },
    });
    expect(note).toEqual({ ok: true });

    expect(rows(h)).toEqual(
      [
        'ai_assistant|teal|shared',
        `user:${ALICE}|Lisbon|private`,
        'agent|the seller to accept 450k|shared',
        `user:${BOB}|Porto|private`,
        'AI Assistant|friendly|shared',
      ].sort(),
    );
  });

  // A thread recorded before TASK-1146 has no names: a name subject can't be
  // recognized as the speaker, so it is kept as written, never under a key.
  // Kept as written, it is any third party's fact, stamped shared (an
  // accepted residual of review F2: only the member's own key is private).
  it("with no names answered, a member's name subject is kept as written, never under a key", async () => {
    const h = await makeHarness({ agent: { visibility: 'team' }, llm: () => extractionReply(ALICE_FACTS) });
    await observeTurn(h, member(h, ALICE, 'conv-x'), ALICE_TURN);

    expect(rows(h)).toEqual(
      ['alice_smith|teal|shared', `user:${ALICE}|Lisbon|private`, 'billing_service|Dana|shared'].sort(),
    );
    expect(lastRun(h)).toMatchObject({ outcome: 'recorded', recorded: 3, speakerFacts: 0 });
  });
});

// ---------------------------------------------------------------------------
// TASK-1204 and TASK-1209, the read side (design §4c): a team agent's memory
// is shared with anyone who talks to it, so no read on it is scoped by
// audience, in a member's turn or an outsider's. An outsider's turn runs as
// the requester, so the requester's own key is never presented there as the
// person talking.
// ---------------------------------------------------------------------------

describe('a team agent recalls everything for anyone who talks to it, and an outsider is never "you" (TASK-1204, TASK-1209)', () => {
  /** Alice's and Bob's web chats (private turns, each run as its person), and one fact said where the room could see it. */
  async function teamWithWebChats(): Promise<MemoryHarness> {
    const h = await makeHarness({ agent: { visibility: 'team' } });
    await h.remember({ about: 'user', relation: 'lives in', value: 'Lisbon' }, h.ctx({ conversationId: 'conv-web' }));
    await h.remember(
      { about: 'launch_plan', relation: 'codename', value: SECRET },
      h.ctx({ userId: BOB, conversationId: 'conv-web-b' }),
    );
    // Bob's note in his own channel conversation: shared, the room saw it.
    const note = await h.bus.call<unknown, MemoryNoteResult>(
      MEMORY_NOTE_TOOL_HOOK,
      h.ctx({ userId: BOB, conversationId: 'conv-y', source: 'user', audience: 'shared' }),
      { input: { about: 'launch_plan', relation: 'date', value: PUBLIC } },
    );
    expect(note).toEqual({ ok: true });
    return h;
  }

  it("a team agent's channel turn recalls what a member said in a web chat", async () => {
    const h = await teamWithWebChats();
    // Alice in the team agent's channel: the turn runs as her, and the room reads the reply.
    const channel = h.ctx({ conversationId: 'conv-x', source: 'user', audience: 'shared' });

    expect(values(await h.recall({ about: 'user' }, channel))).toEqual(['Lisbon']);
    expect(values(await h.recall({}, channel)).sort()).toEqual(['Lisbon', PUBLIC, SECRET].sort());
    const block = await augment(h, channel);
    expect(block).toContain('### Profile');
    expect(block).toContain('Lisbon');
    expect(block).toContain('Nightjar');
    // She is the person talking, so her own fact reads as the speaker's.
    expect(await recallTool(h, channel, 'Lisbon')).toContain('user lives in: Lisbon');
    expect(await recallTool(h, channel, 'launch')).toContain('Nightjar');
  });

  // TASK-1209 (design §4c): a team agent's memory is shared with anyone who
  // talks to it. An outsider's turn runs as the member who answers for the
  // channel (Alice here), and recalls what her own channel turn does, her
  // web chat included. Never as the person talking: no Profile, no "you".
  it("an outsider's turn on the same agent recalls everything a member's turn recalls, the requester's web chat included", async () => {
    const h = await teamWithWebChats();
    const outsider = h.ctx({ conversationId: 'conv-ext', source: 'external', audience: 'shared' });
    // Alice's own turn in the team agent's channel: the same user, a member's turn.
    const alicesChannelTurn = h.ctx({ conversationId: 'conv-x', source: 'user', audience: 'shared' });

    // Ids, not `aboutText`: Alice's own row reads "you" in her turn and not in the outsider's.
    for (const input of RECALL_SHAPES) {
      expect(
        (await h.recall(input, outsider)).statements.map((s) => s.id).sort(),
        JSON.stringify(input),
      ).toEqual((await h.recall(input, alicesChannelTurn)).statements.map((s) => s.id).sort());
    }
    expect(values(await h.recall({}, outsider)).sort()).toEqual(['Lisbon', PUBLIC, SECRET].sort());
    const block = await augment(h, outsider);
    expect(block).toContain('Nightjar');
    expect(block).toContain('Lisbon');
    expect(block).not.toContain('### Profile');
    expect(block).not.toContain('you lives in');
    const tool = await recallTool(h, outsider, 'launch');
    expect(tool).toContain(PUBLIC);
    expect(tool).toContain('Nightjar');
  });

  it("no engine read on a team agent carries an audience scope, in a member's turn or an outsider's", async () => {
    const h = await makeHarness({
      agent: { visibility: 'team' },
      llm: () =>
        extractionReply([
          { subject: 'office', predicate: 'lives_in', object: 'Boston' },
          { subject: 'billing_service', predicate: 'owner', object: 'Dana' },
        ]),
    });
    const member = h.ctx({ conversationId: CHANNEL, source: 'user', audience: 'shared' });
    const outsider = h.ctx({ userId: BOB, conversationId: 'conv-ext', source: 'external', audience: 'shared' });
    // A private row, and one agent-saved slotted row in the member's
    // conversation, so the reads below take the slot-chain and twin branches.
    await h.remember({ about: 'launch_plan', relation: 'codename', value: SECRET }, h.ctx({ conversationId: PRIVATE_CONV }));
    await engineRecord(h.bus, member, [
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

    const observed: Array<Array<Record<string, unknown>>> = [];
    for (const ctx of [member, outsider]) {
      const routes = {
        'memory:recall': await engineReadsDuring(h, async () => {
          for (const input of RECALL_SHAPES) await h.recall(input, ctx);
        }),
        augment: await engineReadsDuring(h, () => augment(h, ctx)),
        memory_recall: await engineReadsDuring(h, () => recallTool(h, ctx, 'Boston')),
        memory_note: await engineReadsDuring(h, () =>
          h.bus.call(MEMORY_NOTE_TOOL_HOOK, ctx, { input: { about: 'standup', relation: 'held_at', value: '9am' } }),
        ),
        observer: await engineReadsDuring(h, () =>
          observeTurn(h, ctx, [
            { role: 'user', content: 'Our office is in Boston now.' },
            { role: 'assistant', content: 'Noted. Dana owns the billing service.' },
          ]),
        ),
      };
      for (const [route, reads] of Object.entries(routes)) {
        expect(reads.length, `${ctx.source} ${route}`).toBeGreaterThan(0);
        for (const input of reads) expect(input, `${ctx.source} ${route}`).not.toHaveProperty('audience');
      }
      observed.push(routes.observer);
    }
    // The member's observer pass took all three twin reads: the conversation's
    // rows, the chain its "Boston" is sent to, and the every-conversation read.
    const [observer] = observed;
    expect(observer!.some((i) => i.conversationId === CHANNEL && i.about === 'office')).toBe(true);
    expect(observer!.some((i) => Array.isArray(i.slots) && i.slots.length === 1)).toBe(true);
    expect(observer!.some((i) => i.about === 'billing_service' && !('conversationId' in i))).toBe(true);
  });

  // Bob, as a member, in his own channel conversation: "I live in Boston". A
  // member's turn files that under his own key. An outsider's turn in a
  // channel he answers for (run as him) recalls it, as a member's turn would
  // (TASK-1209), but never as "you": he isn't the person talking there.
  it("a member's note about themself in a channel reaches an outsider's turn run as that member, but never as \"you\"", async () => {
    const h = await makeHarness({ agent: { visibility: 'team' } });
    const own = h.ctx({ userId: BOB, conversationId: 'conv-b', source: 'user', audience: 'shared' });
    const note = await h.bus.call<unknown, MemoryNoteResult>(MEMORY_NOTE_TOOL_HOOK, own, {
      input: { about: 'user', relation: 'lives in', value: 'Boston' },
    });
    expect(note).toEqual({ ok: true });
    expect(storedRows(h).map((r) => `${r.about}|${r.audience}`)).toEqual([`user:${BOB}|private`]);
    const outsider = h.ctx({ userId: BOB, conversationId: CHANNEL, source: 'external', audience: 'shared' });

    expect(values(await h.recall({}, outsider))).toEqual(['Boston']);
    expect(values(await h.recall({ query: 'Boston' }, outsider))).toEqual(['Boston']);
    expect((await h.recall({}, outsider)).statements.map((s) => s.aboutText)).not.toContain('you');
    const block = await augment(h, outsider);
    expect(block).toContain('Boston');
    expect(block).not.toContain('### Profile');
    expect(block).not.toContain('you lives in');
    const tool = await recallTool(h, outsider, 'Boston');
    expect(tool).toContain('Boston');
    expect(tool).not.toMatch(/\| user lives in: Boston/);

    // The control: Bob's own channel turn runs as him, so his memory is his.
    const mine = await augment(h, own);
    expect(mine).toContain('### Profile');
    expect(mine).toContain('Boston');
    expect(await recallTool(h, own, 'Boston')).toContain('user lives in: Boston');
    expect((await h.recall({}, own)).statements.map((s) => s.aboutText)).toEqual(['you']);
  });

  // The fixture is simply a row under the requester's own key, written
  // straight to the engine. An outsider's turn recalls it, as it recalls
  // every row on a team agent (TASK-1209), and never as the person talking.
  it("in an outsider turn, the requester's own memory is never the person talking", async () => {
    const h = await makeHarness({ agent: { visibility: 'team' } });
    await engineRecord(h.bus, h.ctx({ userId: BOB }), [
      {
        about: `user:${BOB}`,
        relation: 'lives in',
        value: 'Boston',
        when: JAN,
        slot: 'lives_in',
        provenance: 'agent',
        ownerUserId: BOB,
        conversationId: 'conv-b',
        audience: 'shared',
      },
    ]);
    // An outsider's turn in a channel runs as the requester (Bob), never as
    // the person talking.
    const outsider = h.ctx({ userId: BOB, conversationId: CHANNEL, source: 'external', audience: 'shared' });

    let block = '';
    const reads = await engineReadsDuring(h, async () => {
      block = await augment(h, outsider);
    });
    // No Profile: it is the caller's, and the caller isn't the one talking.
    // Not even read: the Profile's read is the one for the caller's active
    // rows. (Recent may read that key's chain, as it does any subject's.)
    expect(block).not.toContain('### Profile');
    expect(reads.filter((i) => i.about === `user:${BOB}` && i.activeOnly === true)).toEqual([]);
    // Still recalled, as the team's memory, but never as "you".
    expect(block).toContain('Boston');
    expect(block).not.toContain('you lives in');
    const tool = await recallTool(h, outsider, 'Boston');
    expect(tool).toContain('a teammate lives in: Boston');
    expect(tool).not.toMatch(/\| user lives in: Boston/);
    expect((await h.recall({}, outsider)).statements.map((s) => s.aboutText)).toEqual(['a teammate']);

    // The control: Bob's own channel turn runs as him, so his memory is his.
    const member = h.ctx({ userId: BOB, conversationId: 'conv-b', source: 'user', audience: 'shared' });
    const own = await augment(h, member);
    expect(own).toContain('### Profile');
    expect(own).toContain('Boston');
    expect(await recallTool(h, member, 'Boston')).toContain('user lives in: Boston');
    expect((await h.recall({}, member)).statements.map((s) => s.aboutText)).toEqual(['you']);
  });
});

describe('isPersonSubject — what a shared turn stores nothing about', () => {
  it.each(PERSON_SUBJECTS)('%j is a person', (about) => {
    expect(isPersonSubject(about)).toBe(true);
  });

  it.each(NOT_PERSON_SUBJECTS)('%j is not', (about) => {
    expect(isPersonSubject(about)).toBe(false);
  });
});

describe("namesASpeaker — a subject made of a speaker's names (TASK-1146)", () => {
  it.each(NAMES_A_SPEAKER)('%j names a speaker', (about) => {
    expect(namesASpeaker(about, NAMES)).toBe(true);
  });

  it.each(NOT_A_SPEAKER)('%j does not', (about) => {
    expect(namesASpeaker(about, NAMES)).toBe(false);
  });

  // `user` alone is not a NAME: the speaker word only counts beside a real
  // name word, so `isPersonSubject` stays the one rule for `user`.
  it('the speaker word alone does not name a speaker, even with names', () => {
    expect(namesASpeaker('user', NAMES)).toBe(false);
    expect(namesASpeaker('user_user', NAMES)).toBe(false);
    expect(isPersonSubject('user')).toBe(true);
  });

  // Escapes, so both spellings are on the page: `\u00e9` is one character, `e\u0301` an `e` and a combining accent.
  const JOSE_GARCIA = 'Jos\u00e9 Garc\u00eda';
  it.each(['jose', 'Jos\u00e9', 'JOS\u00c9', 'Jose\u0301', 'garcia', 'jose_garcia'])(
    '%j names Jos\u00e9 Garc\u00eda: accents fold both ways',
    (about) => {
      expect(namesASpeaker(about, [JOSE_GARCIA])).toBe(true);
    },
  );

  it('an accented subject names an unaccented speaker too', () => {
    expect(namesASpeaker('Jos\u00e9', ['Jose Garcia'])).toBe(true);
  });

  it('a run-together name matches its split spelling, both ways', () => {
    expect(namesASpeaker('vinay_pulim', ['VinayPulim'])).toBe(true);
    expect(namesASpeaker('vinaypulim', ['Vinay Pulim'])).toBe(true);
  });

  it('the speaker word beside a run-together name is set aside too (TASK-1146 review)', () => {
    expect(namesASpeaker('user_vinaypulim', ['Vinay Pulim'])).toBe(true);
    expect(namesASpeaker('vinaypulim_user', ['Vinay Pulim'])).toBe(true);
    expect(namesASpeaker('user_vinay_pulim', ['VinayPulim'])).toBe(true);
    // Controls: the speaker word sets nothing else aside.
    expect(namesASpeaker('user_vinaypulim_laptop', ['Vinay Pulim'])).toBe(false);
    expect(namesASpeaker('user_settings', ['Vinay Pulim'])).toBe(false);
  });

  it('a name with the speaker word in it never stops a drop (TASK-1146 review round 3)', () => {
    expect(namesASpeaker('user_vinaypulim', ['Vinay Pulim', 'Test User'])).toBe(true);
    expect(namesASpeaker('vinaypulim_user', ['Vinay Pulim', 'Test User'])).toBe(true);
    expect(namesASpeaker('usersmith_user', ['User Smith'])).toBe(true);
    expect(namesASpeaker('user_smith', ['User Smith'])).toBe(true);
    // Adding such a name to the list never turns a drop into a keep.
    for (const about of NAMES_A_SPEAKER) {
      expect(namesASpeaker(about, [...NAMES, 'Test User'])).toBe(true);
    }
  });

  it('a one-word name that ends in the speaker word still matches whole', () => {
    expect(namesASpeaker('power_user', ['Poweruser'])).toBe(true);
  });

  it('no names, or names with no letters or digits, match nothing', () => {
    expect(namesASpeaker('vinay', [])).toBe(false);
    expect(namesASpeaker('x', ['\u{1F334}', '()'])).toBe(false); // a palm-tree emoji
  });
});

describe('breaksSpeakerRule — the one speaker rule (TASK-1136, TASK-1146)', () => {
  it.each(PERSON_SUBJECTS)('%j breaks it in a shared or unknown audience, never in a private one', (about) => {
    expect(breaksSpeakerRule('shared', about, [])).toBe(true);
    expect(breaksSpeakerRule('public' as AgentContextAudience, about, [])).toBe(true);
    expect(breaksSpeakerRule('private', about, [])).toBe(false);
  });
  it.each([...NOT_PERSON_SUBJECTS, 'vinay'])('with no speaker names, %j never breaks it', (about) => {
    for (const audience of ['private', 'shared', 'public'] as AgentContextAudience[]) {
      expect(breaksSpeakerRule(audience, about, [])).toBe(false);
    }
    // It would if a speaker had that name: the rule reads only the names it
    // is given, and nothing else here changed.
    expect(breaksSpeakerRule('shared', about, [about])).toBe(true);
  });
  it.each(NAMES_A_SPEAKER)(
    '%j breaks it in a shared or unknown audience when a speaker has that name, never in a private one',
    (about) => {
      expect(breaksSpeakerRule('shared', about, NAMES)).toBe(true);
      expect(breaksSpeakerRule('public' as AgentContextAudience, about, NAMES)).toBe(true);
      expect(breaksSpeakerRule('private', about, NAMES)).toBe(false);
    },
  );
  it.each(NOT_A_SPEAKER)('%j never breaks it, names or not', (about) => {
    for (const audience of ['private', 'shared', 'public'] as AgentContextAudience[]) {
      expect(breaksSpeakerRule(audience, about, NAMES)).toBe(false);
      expect(breaksSpeakerRule(audience, about, [])).toBe(false);
    }
    // The control: the same names do break it for a subject made of them.
    expect(breaksSpeakerRule('shared', 'vinay', NAMES)).toBe(true);
  });

  // A `memory_note` subject can be megabytes, and reading one costs the host
  // time its writer chooses (NFKC alone grows some characters eighteenfold).
  // No real subject is that long: both in-repo engines refuse an `about`
  // over 1024 code units.
  it('a subject over 1024 code units breaks it unread in a shared or unknown audience, never in a private one', () => {
    expect(breaksSpeakerRule('shared', TOO_LONG_TO_READ, [])).toBe(true);
    expect(breaksSpeakerRule('public' as AgentContextAudience, TOO_LONG_TO_READ, NAMES)).toBe(true);
    expect(breaksSpeakerRule('private', TOO_LONG_TO_READ, NAMES)).toBe(false);
    // 1024 is still read: neither a person nor a name.
    expect(breaksSpeakerRule('shared', 'x'.repeat(1024), NAMES)).toBe(false);
  });

  it('a list nobody froze is read afresh each time, so a changed list is seen', () => {
    const names = ['Vinay'];
    expect(namesASpeaker('pulim', names)).toBe(false);
    names.push('Pulim');
    expect(namesASpeaker('pulim', names)).toBe(true);
    names.length = 0;
    expect(namesASpeaker('pulim', names)).toBe(false);
  });

  it('a frozen list is read once: a second call does not read the names again', () => {
    const names = Object.freeze(['Vinay Pulim']);
    const normalize = vi.spyOn(String.prototype, 'normalize');
    try {
      namesASpeaker('vinay', names);
      const first = normalize.mock.calls.length;
      namesASpeaker('vinay', names);
      const second = normalize.mock.calls.length - first;
      // The second call reads the subject only; the first read the names too.
      expect(second).toBeGreaterThan(0);
      expect(second).toBeLessThan(first);
    } finally {
      normalize.mockRestore();
    }
  });

  it('checks a batch against its names in about the time of one subject: each name list is read once', () => {
    // 32 names at the core caps, each of U+FDFA, which NFKC grows eighteenfold.
    const HOSTILE = Array.from({ length: 32 }, () => '\ufdfa'.repeat(256));
    // CPU time, fastest of three (TASK-660: wall-clock budgets flaked on the
    // full parallel suite). A fresh copy of the list per run, so each run
    // pays for reading it once.
    const cpu = (subjects: number): number => {
      let best = Infinity;
      for (let run = 0; run < 3; run += 1) {
        // Frozen: a list is read once only if nobody can change it.
        const names = Object.freeze([...HOSTILE]);
        const before = process.cpuUsage();
        for (let i = 0; i < subjects; i += 1) {
          expect(breaksSpeakerRule('shared', `subject_${i}`, names)).toBe(false);
        }
        const used = process.cpuUsage(before);
        best = Math.min(best, used.user + used.system);
      }
      return best;
    };
    cpu(1); // warm the JIT so the first size is not charged for it
    // Read once per list, 200 subjects cost about what one does (measured
    // ~1x); read again per subject, ~200x (measured 167x before the fix).
    expect(cpu(200) / cpu(1)).toBeLessThan(20);
  });
});

describe('drift guard: the observer, memory_note and recordFacts refuse exactly what breaksSpeakerRule names (TASK-1136, TASK-1146)', () => {
  // Walk TASK-1134: memory_note refused `user` while the observer kept
  // `vinay`. Since TASK-1146 a speaker's name breaks the rule too, so the
  // walk's `vinay` (in NAMES_A_SPEAKER) is refused on every path once
  // memory:pre-capture names the speaker. Each path gets the names its own
  // way: `toStatements` from its caller, `memory_note` from its own ask, and
  // `recordFacts`, called without names, by asking `engine` itself.
  const SUBJECTS = [
    ...new Set([...PERSON_SUBJECTS, ...NOT_PERSON_SUBJECTS, ...NAMES_A_SPEAKER, ...NOT_A_SPEAKER, TOO_LONG_TO_READ]),
  ];
  it.each([
    ['an absent', undefined],
    ['a private', 'private'],
    ['a shared', 'shared'],
    ['an unknown', 'public'],
  ] as const)('%s audience', async (_label, audience) => {
    const h = await makeHarness();
    answerSpeakerNames(h.bus, NAMES);
    const ctx = h.ctx({
      conversationId: CHANNEL,
      ...(audience !== undefined ? { audience: audience as AgentContextAudience } : {}),
    });
    const engine = new HookBus();
    engine.registerService(FACTS_RECORD_HOOK, 'stub-engine', async () => ({ records: [{ id: 'row-1' }] }));
    answerSpeakerNames(engine, NAMES);
    const disagreements: string[] = [];
    for (const about of SUBJECTS) {
      const rule = breaksSpeakerRule(audienceOf(ctx), about, NAMES);
      const observer =
        toStatements([{ subject: about, predicate: 'r', object: 'v', validStart: JAN }], {
          ownerUserId: ALICE,
          speakerScope: speakerScope(ctx, PERSONAL),
          speakerNames: NAMES,
        }).speakerFacts === 1;
      const result = await h.bus.call<unknown, MemoryNoteResult>(MEMORY_NOTE_TOOL_HOOK, ctx, {
        input: { about, relation: 'r', value: 'v' },
      });
      // Refused FOR THIS RULE: the backstop's generic `forbidden` doesn't count.
      const note = !result.ok && result.error === 'forbidden' && result.message.endsWith(PERSON_IN_SHARED_MESSAGE);
      const record = await recordFacts(engine, ctx, PERSONAL, FACTS_RECORD_HOOK, { statements: [{ about }] }).then(
        () => false,
        (err: unknown) => err instanceof PluginError && err.code === 'forbidden',
      );
      // The note tool refuses a subject over 1024 code units as bad input in
      // EVERY audience, before the rule (the engines refuse it too), with its
      // own message: pinned in note-tool.test.ts, so it isn't compared here.
      const noteAgrees = about === TOO_LONG_TO_READ || note === rule;
      if (observer !== rule || !noteAgrees || record !== rule) {
        disagreements.push(`${JSON.stringify(about)}: rule ${rule}, observer ${observer}, note ${note}, record ${record}`);
      }
    }
    expect(disagreements).toEqual([]);
    // Not vacuous: a shared or unknown audience refuses every person subject,
    // every subject made of the speakers' names and the one too long to
    // read, and nothing else.
    expect(SUBJECTS.filter((about) => breaksSpeakerRule(audienceOf(ctx), about, NAMES))).toHaveLength(
      audienceOf(ctx) === 'shared' ? PERSON_SUBJECTS.length + NAMES_A_SPEAKER.length + 1 : 0,
    );
  });

  // TASK-1204: in a team agent's member turn the three paths don't only
  // refuse alike, they FILE alike. The observer and the note land each
  // subject exactly where `speakerSubject` says, and the write door sends a
  // subject only once it is already filed there, so a writer that forgot to
  // file one is refused, never misfiled.
  it("drift guard, team agent member turn: the observer, memory_note and recordFacts file exactly what speakerSubject says (TASK-1204)", async () => {
    const h = await makeHarness({ agent: { visibility: 'team' } });
    answerSpeakerNames(h.bus, NAMES);
    const ctx = h.ctx({ conversationId: CHANNEL, source: 'user', audience: 'shared' });
    const TEAM: MemoryAccess = { userId: ALICE, visibility: 'team' };
    expect(speakerScope(ctx, TEAM)).toBe('team');
    const engine = new HookBus();
    engine.registerService(FACTS_RECORD_HOOK, 'stub-engine', async () => ({ records: [{ id: 'row-1' }] }));
    answerSpeakerNames(engine, NAMES);
    const record = (about: string): Promise<string> =>
      recordFacts(engine, ctx, TEAM, FACTS_RECORD_HOOK, { statements: [{ about }] }).then(
        () => 'sent',
        (err: unknown) => (err instanceof PluginError && err.code === 'forbidden' ? 'refused' : `threw ${String(err)}`),
      );
    const disagreements: string[] = [];
    for (const about of SUBJECTS) {
      const expected = speakerSubject('team', about, ALICE, NAMES);
      const where = (out: string | undefined): string => (out === undefined ? 'nowhere' : JSON.stringify(out));
      const observer = toStatements([{ subject: about, predicate: 'r', object: 'v', validStart: JAN }], {
        ownerUserId: ALICE,
        speakerScope: speakerScope(ctx, TEAM),
        speakerNames: NAMES,
      }).statements[0]?.about;
      if (observer !== expected) disagreements.push(`${JSON.stringify(about)}: observer ${where(observer)}`);

      // The note tool refuses an empty subject, and one over 1024 code units,
      // as bad input in EVERY audience, before the rule (pinned in
      // note-tool.test.ts), so those aren't compared here.
      if (about !== TOO_LONG_TO_READ && about.trim() !== '') {
        const before = storedRows(h).length;
        const result = await h.bus.call<unknown, MemoryNoteResult>(MEMORY_NOTE_TOOL_HOOK, ctx, {
          input: { about, relation: 'r', value: 'v' },
        });
        const after = storedRows(h);
        // Refused FOR THIS RULE: any other refusal doesn't count.
        const note = result.ok
          ? after.length === before + 1
            ? after.at(-1)!.about
            : 'saved, but no new row'
          : result.error === 'forbidden' && result.message.endsWith(TEAM_PERSON_KEY_MESSAGE)
            ? undefined
            : `refused ${result.error}`;
        if (note !== expected) disagreements.push(`${JSON.stringify(about)}: note ${where(note)}`);
      }

      // The write door, handed the subject as written: sent only if that is
      // already where it is filed.
      const raw = await record(about);
      if (raw !== (expected === about ? 'sent' : 'refused')) {
        disagreements.push(`${JSON.stringify(about)}: recordFacts as written ${raw}`);
      }
      // ...and handed it filed: always sent.
      if (expected !== undefined) {
        const filed = await record(expected);
        if (filed !== 'sent') disagreements.push(`${JSON.stringify(about)}: recordFacts filed ${filed}`);
      }
    }
    expect(disagreements).toEqual([]);
    // Not vacuous: `user` and every subject made of the speaker's names are
    // filed under the runner's own key (and the note saved each one there),
    // every other person subject and the one too long to read are filed
    // nowhere, and the rest stay as written.
    const OWN = `user:${ALICE}`;
    const filedUnder = SUBJECTS.map((about) => speakerSubject('team', about, ALICE, NAMES));
    const personSubjectsButUser = PERSON_SUBJECTS.filter((about) => about !== 'user');
    expect(filedUnder.filter((out) => out === OWN)).toHaveLength(1 + NAMES_A_SPEAKER.length);
    expect(filedUnder.filter((out) => out === undefined)).toHaveLength(personSubjectsButUser.length + 1);
    expect(storedRows(h).filter((r) => r.about === OWN)).toHaveLength(1 + NAMES_A_SPEAKER.length);
  });
});

describe('recordFacts — the one door every engine write goes through', () => {
  const ANSWER = { records: [{ id: 'row-1' }] };
  const turn = (audience?: AgentContextAudience, conversationId?: string, source?: AgentContextSource): AgentContext =>
    makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      ...(audience !== undefined ? { audience } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(source !== undefined ? { source } : {}),
    });

  /** A bus whose engine records every write it is sent, and answers {@link ANSWER}. */
  function engineRecording(): { bus: HookBus; written: unknown[] } {
    const bus = new HookBus();
    const written: unknown[] = [];
    bus.registerService(FACTS_RECORD_HOOK, 'stub-engine', async (_c, input) => {
      written.push(input);
      return ANSWER;
    });
    return { bus, written };
  }

  it.each([
    ['an absent audience', 'private', undefined],
    ['a private turn', 'private', 'private'],
    ['a shared turn', 'shared', 'shared'],
    ['an audience this build does not know', 'shared', 'public'],
  ] as const)('%s stamps every statement %s, over whatever it carried', async (_label, stamped, audience) => {
    const { bus, written } = engineRecording();
    const statements = [
      { about: 'a', value: '1' },
      { about: 'b', value: '2', audience: 'private' },
      { about: 'c', value: '3', audience: 'shared' },
    ];
    await recordFacts(bus, turn(audience as AgentContextAudience | undefined), PERSONAL, FACTS_RECORD_HOOK, {
      batchKey: 'batch-1',
      statements,
    });
    expect(written).toEqual([
      {
        batchKey: 'batch-1',
        statements: [
          { about: 'a', value: '1', audience: stamped },
          { about: 'b', value: '2', audience: stamped },
          { about: 'c', value: '3', audience: stamped },
        ],
      },
    ]);
    // The stamp goes on what is sent, not on the caller's objects.
    expect(statements[1]).toEqual({ about: 'b', value: '2', audience: 'private' });
  });

  it.each(PERSON_SUBJECTS)(
    'a shared write about %j is refused forbidden: the whole batch, naming nothing, sending nothing',
    async (about) => {
      const { bus, written } = engineRecording();
      const failure: unknown = await recordFacts(bus, turn('shared'), PERSONAL, FACTS_RECORD_HOOK, {
        statements: [
          { about: 'billing_service', value: 'Dana' },
          { about, value: 'Paris-secret' },
        ],
      }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(failure).toMatchObject({ code: 'forbidden', plugin: '@ax/memory', hookName: FACTS_RECORD_HOOK });
      expect((failure as Error).message).not.toContain('Paris-secret');
      expect(written).toEqual([]);
    },
  );

  it('an audience this build does not know refuses a person subject too', async () => {
    const { bus, written } = engineRecording();
    await expect(
      recordFacts(bus, turn('public' as AgentContextAudience), PERSONAL, FACTS_RECORD_HOOK, {
        statements: [{ about: 'user', value: 'Paris' }],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(written).toEqual([]);
  });

  it.each(NOT_PERSON_SUBJECTS)('a shared write about %j goes through, stamped shared', async (about) => {
    const { bus, written } = engineRecording();
    await recordFacts(bus, turn('shared'), PERSONAL, FACTS_RECORD_HOOK, { statements: [{ about }] });
    expect(written).toEqual([{ statements: [{ about, audience: 'shared' }] }]);
  });

  it('a private write sends a person subject on: the speaker rewrite already ran upstream', async () => {
    for (const ctx of [turn(), turn('private')]) {
      const { bus, written } = engineRecording();
      await recordFacts(bus, ctx, PERSONAL, FACTS_RECORD_HOOK, {
        statements: [{ about: `user:${ALICE}` }, { about: 'User' }],
      });
      expect(written).toEqual([
        { statements: [{ about: `user:${ALICE}`, audience: 'private' }, { about: 'User', audience: 'private' }] },
      ]);
    }
  });

  it("returns the engine's answer as it came", async () => {
    const { bus } = engineRecording();
    expect(
      await recordFacts(bus, turn('shared'), PERSONAL, FACTS_RECORD_HOOK, { statements: [{ about: 'x' }] }),
    ).toBe(ANSWER);
  });

  // Both engines validate with `map`, which skips a hole, so a hole sent on
  // as one would never be looked at.
  it('sends a hole on as a statement with no subject, for the engine to refuse', async () => {
    const { bus, written } = engineRecording();
    const statements: object[] = [{ about: 'a' }];
    statements.length = 2;
    await recordFacts(bus, turn('shared'), PERSONAL, FACTS_RECORD_HOOK, { statements });
    expect(written).toEqual([{ statements: [{ about: 'a', audience: 'shared' }, { audience: 'shared' }] }]);
    expect(1 in (written[0] as { statements: unknown[] }).statements).toBe(true);
  });

  // TASK-1146: the backstop knows the speakers' names too. A caller that has
  // them (the observer, `memory_note`) passes them; one that doesn't makes
  // `recordFacts` ask, so a writer added later can't forget the names.
  it('with no names given, a shared write asks memory:pre-capture once and refuses a speaker name, sending nothing', async () => {
    const { bus, written } = engineRecording();
    const asked = answerSpeakerNames(bus, ['vinay']);
    const failure: unknown = await recordFacts(bus, turn('shared', CHANNEL), PERSONAL, FACTS_RECORD_HOOK, {
      statements: [
        { about: 'billing_service', value: 'Dana' },
        { about: 'vinay', value: 'Paris-secret' },
      ],
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toMatchObject({ code: 'forbidden', plugin: '@ax/memory', hookName: FACTS_RECORD_HOOK });
    expect((failure as Error).message).not.toContain('vinay');
    expect((failure as Error).message).not.toContain('Paris-secret');
    expect(written).toEqual([]);
    expect(asked).toEqual([{ conversationId: CHANNEL }]);
  });

  it('a person subject is refused without asking: the cheap refusal comes first', async () => {
    const { bus, written } = engineRecording();
    const asked = answerSpeakerNames(bus, ['vinay']);
    for (const about of ['user', 'user:abc', TOO_LONG_TO_READ]) {
      await expect(
        recordFacts(bus, turn('shared', CHANNEL), PERSONAL, FACTS_RECORD_HOOK, { statements: [{ about }] }),
      ).rejects.toMatchObject({ code: 'forbidden', plugin: '@ax/memory', hookName: FACTS_RECORD_HOOK });
    }
    expect(asked).toEqual([]);
    expect(written).toEqual([]);
  });

  it('a garbled answer cannot mask the cheap refusal', async () => {
    const { bus } = engineRecording();
    bus.subscribe<MemoryPreCapturePayload>(MEMORY_PRE_CAPTURE_HOOK, 'test-garbled', async (_ctx, payload) => ({
      ...payload,
      speakerNames: 'vinay' as unknown as string[],
    }));
    // `forbidden`, not the `invalid-return` the ask would have thrown.
    await expect(
      recordFacts(bus, turn('shared', CHANNEL), PERSONAL, FACTS_RECORD_HOOK, { statements: [{ about: 'user' }] }),
    ).rejects.toMatchObject({ code: 'forbidden', hookName: FACTS_RECORD_HOOK });
  });

  it('names given, it asks nothing: an empty list is an answer too', async () => {
    const { bus, written } = engineRecording();
    const asked = answerSpeakerNames(bus, ['vinay']);
    const ctx = turn('shared', CHANNEL);
    await expect(
      recordFacts(bus, ctx, PERSONAL, FACTS_RECORD_HOOK, { statements: [{ about: 'vinay' }] }, ['vinay']),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // `[]` means "asked, and nobody was named", so it is sent, though the
    // subscriber would have named `vinay` had it been asked.
    await recordFacts(bus, ctx, PERSONAL, FACTS_RECORD_HOOK, { statements: [{ about: 'vinay' }] }, []);
    expect(asked).toEqual([]);
    expect(written).toEqual([{ statements: [{ about: 'vinay', audience: 'shared' }] }]);
  });

  it('a refused ask refuses the batch', async () => {
    const { bus, written } = engineRecording();
    bus.subscribe(MEMORY_PRE_CAPTURE_HOOK, 'test-refuser', async () => reject({ reason: 'channel-not-remembered' }));
    const failure: unknown = await recordFacts(bus, turn('shared', CHANNEL), PERSONAL, FACTS_RECORD_HOOK, {
      statements: [{ about: 'billing_service', value: 'Dana-secret' }],
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toMatchObject({ code: 'forbidden', plugin: '@ax/memory', hookName: FACTS_RECORD_HOOK });
    expect((failure as Error).message).not.toContain('Dana-secret');
    expect(written).toEqual([]);
  });

  it('a private write never asks, and files a name as written', async () => {
    const { bus, written } = engineRecording();
    const asked = answerSpeakerNames(bus, ['vinay']);
    for (const ctx of [turn(undefined, CHANNEL), turn('private', CHANNEL)]) {
      await recordFacts(bus, ctx, PERSONAL, FACTS_RECORD_HOOK, { statements: [{ about: 'vinay' }] });
    }
    expect(asked).toEqual([]);
    expect(written).toEqual([
      { statements: [{ about: 'vinay', audience: 'private' }] },
      { statements: [{ about: 'vinay', audience: 'private' }] },
    ]);

    // The control: the same write in a shared turn asks, and is refused.
    await expect(
      recordFacts(bus, turn('shared', CHANNEL), PERSONAL, FACTS_RECORD_HOOK, { statements: [{ about: 'vinay' }] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(asked).toEqual([{ conversationId: CHANNEL }]);
  });

  it('an answer memory cannot read throws invalid-return, and nothing is written', async () => {
    const { bus, written } = engineRecording();
    bus.subscribe<MemoryPreCapturePayload>(MEMORY_PRE_CAPTURE_HOOK, 'test-garbled', async (_ctx, payload) => ({
      ...payload,
      speakerNames: 'vinay' as unknown as string[],
    }));
    const failure: unknown = await recordFacts(bus, turn('shared', CHANNEL), PERSONAL, FACTS_RECORD_HOOK, {
      statements: [{ about: 'billing_service', value: 'Dana' }],
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toMatchObject({ code: 'invalid-return', plugin: '@ax/memory', hookName: MEMORY_PRE_CAPTURE_HOOK });
    expect((failure as Error).message).not.toContain('vinay');
    expect(written).toEqual([]);
  });

  // TASK-1204: a team agent's member turn runs as the member who wrote it, so
  // a fact about them is filed under their own key. The backstop sends a
  // statement only once its subject is what `speakerSubject` files it under:
  // a writer that forgot to file it is refused, never misfiled.
  const TEAM: MemoryAccess = { userId: ALICE, visibility: 'team' };
  /** The refusal text of a turn that keeps the speaker rule (TASK-1091). */
  const WITHHELD_REFUSAL = 'the speaker could be anyone in the room';
  /** The refusal text of a team agent's member turn (TASK-1204). */
  const TEAM_REFUSAL = "isn't filed under its speaker";

  // Review F2: §4c shares a team agent's memory with the team, not with
  // people outside AX. A statement filed under the member's own key is about
  // them, so it is stamped private: every member's turn reads it (no audience
  // scope), no outsider's turn does. Everything else keeps the turn's stamp.
  it("a team agent's member turn writes statements filed under the speaker: the speaker's own stamped private, the rest shared", async () => {
    const { bus, written } = engineRecording();
    await recordFacts(
      bus,
      turn('shared', CHANNEL, 'user'),
      TEAM,
      FACTS_RECORD_HOOK,
      { statements: [{ about: `user:${ALICE}` }, { about: 'team_standup' }, { about: 'ada' }] },
      NAMES,
    );
    expect(written).toEqual([
      {
        statements: [
          { about: `user:${ALICE}`, audience: 'private' },
          { about: 'team_standup', audience: 'shared' },
          { about: 'ada', audience: 'shared' },
        ],
      },
    ]);
  });

  it.each([
    // audience, source: every turn a team agent's member files under their key in
    ['shared', 'user'],
    ['shared', undefined],
    ['shared', 'routine'],
    ['public', 'user'], // an audience this build doesn't know reads as shared
  ] as const)(
    "in a team member turn (audience %j, source %j) only the runner's own key is stamped private, over whatever a statement carried",
    async (audience, source) => {
      const { bus, written } = engineRecording();
      const statements = [
        { about: `user:${ALICE}`, value: '1', audience: 'shared' },
        { about: 'billing_service', value: '2', audience: 'private' },
        { about: 'assistant', value: '3' },
        // A third party, by a name the turn wasn't answered with.
        { about: 'bob', value: '4' },
      ];
      const ctx = turn(audience as AgentContextAudience, CHANNEL, source as AgentContextSource | undefined);
      expect(speakerScope(ctx, TEAM)).toBe('team');
      await recordFacts(bus, ctx, TEAM, FACTS_RECORD_HOOK, { batchKey: 'batch-1', statements }, NAMES);
      expect(written).toEqual([
        {
          batchKey: 'batch-1',
          statements: [
            { about: `user:${ALICE}`, value: '1', audience: 'private' },
            { about: 'billing_service', value: '2', audience: 'shared' },
            { about: 'assistant', value: '3', audience: 'shared' },
            { about: 'bob', value: '4', audience: 'shared' },
          ],
        },
      ]);
      // The stamp goes on what is sent, not on the caller's objects.
      expect(statements[0]).toEqual({ about: `user:${ALICE}`, value: '1', audience: 'shared' });
    },
  );

  it('a team member turn sends a hole on as a statement with no subject, stamped with the turn', async () => {
    const { bus, written } = engineRecording();
    const statements: object[] = [{ about: `user:${ALICE}` }];
    statements.length = 2;
    await recordFacts(bus, turn('shared', CHANNEL, 'user'), TEAM, FACTS_RECORD_HOOK, { statements }, NAMES);
    expect(written).toEqual([{ statements: [{ about: `user:${ALICE}`, audience: 'private' }, { audience: 'shared' }] }]);
  });

  // Only a team member turn has a key of its own that the room didn't earn:
  // a private turn stamps everything private as always, and the other shared
  // turns (personal agents', outsiders') never send a person key at all.
  it("the runner's key stamp is the team member turn's alone: a private turn on a team agent stamps private, a work fact in an outsider's turn shared", async () => {
    const { bus, written } = engineRecording();
    await recordFacts(bus, turn('private', CHANNEL, 'user'), TEAM, FACTS_RECORD_HOOK, {
      statements: [{ about: `user:${ALICE}` }, { about: 'billing_service' }],
    });
    await recordFacts(bus, turn('shared', CHANNEL, 'external'), TEAM, FACTS_RECORD_HOOK, { statements: [{ about: 'billing_service' }] }, NAMES);
    await recordFacts(bus, turn('shared', CHANNEL, 'user'), PERSONAL, FACTS_RECORD_HOOK, { statements: [{ about: 'billing_service' }] }, NAMES);
    expect(written).toEqual([
      { statements: [{ about: `user:${ALICE}`, audience: 'private' }, { about: 'billing_service', audience: 'private' }] },
      { statements: [{ about: 'billing_service', audience: 'shared' }] },
      { statements: [{ about: 'billing_service', audience: 'shared' }] },
    ]);
  });

  it.each(['user', 'vinay', 'user_vinay', 'UHTE83XE1', 'User', `user:${BOB}`])(
    "a team agent's member turn refuses %j: not yet filed under its speaker",
    async (about) => {
      const { bus, written } = engineRecording();
      const failure: unknown = await recordFacts(
        bus,
        turn('shared', CHANNEL, 'user'),
        TEAM,
        FACTS_RECORD_HOOK,
        {
          statements: [
            { about: 'billing_service', value: 'Dana' },
            { about, value: 'Paris-secret' },
          ],
        },
        NAMES,
      ).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(failure).toMatchObject({ code: 'forbidden', plugin: '@ax/memory', hookName: FACTS_RECORD_HOOK });
      expect((failure as Error).message).toContain(TEAM_REFUSAL);
      expect((failure as Error).message).not.toContain('Paris-secret');
      expect(written).toEqual([]);
    },
  );

  it('a team member turn refuses another person key before it asks', async () => {
    const { bus, written } = engineRecording();
    const asked = answerSpeakerNames(bus, NAMES);
    await expect(
      recordFacts(bus, turn('shared', CHANNEL, 'user'), TEAM, FACTS_RECORD_HOOK, {
        statements: [{ about: `user:${BOB}` }],
      }),
    ).rejects.toMatchObject({ code: 'forbidden', hookName: FACTS_RECORD_HOOK });
    expect(asked).toEqual([]);
    expect(written).toEqual([]);
  });

  it('a team member turn with no names handed asks once', async () => {
    const { bus, written } = engineRecording();
    const asked = answerSpeakerNames(bus, NAMES);
    await recordFacts(bus, turn('shared', CHANNEL, 'user'), TEAM, FACTS_RECORD_HOOK, {
      statements: [{ about: 'team_standup' }],
    });
    expect(asked).toEqual([{ conversationId: CHANNEL }]);
    expect(written).toEqual([{ statements: [{ about: 'team_standup', audience: 'shared' }] }]);
  });

  it('an outsider turn on a team agent keeps the speaker rule: nothing under the requester', async () => {
    const { bus, written } = engineRecording();
    const failure: unknown = await recordFacts(bus, turn('shared', CHANNEL, 'external'), TEAM, FACTS_RECORD_HOOK, {
      statements: [{ about: `user:${ALICE}` }],
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toMatchObject({ code: 'forbidden', plugin: '@ax/memory', hookName: FACTS_RECORD_HOOK });
    expect((failure as Error).message).toContain(WITHHELD_REFUSAL);
    expect(written).toEqual([]);
  });

  it("a personal agent's member turn keeps the speaker rule", async () => {
    const { bus, written } = engineRecording();
    const failure: unknown = await recordFacts(bus, turn('shared', CHANNEL, 'user'), PERSONAL, FACTS_RECORD_HOOK, {
      statements: [{ about: `user:${ALICE}` }],
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toMatchObject({ code: 'forbidden', plugin: '@ax/memory', hookName: FACTS_RECORD_HOOK });
    expect((failure as Error).message).toContain(WITHHELD_REFUSAL);
    expect(written).toEqual([]);
  });
});

describe('one rule for every write: whose memory, and who is talking (TASK-1204)', () => {
  /** The member a team agent's channel turn runs as, and their own key. */
  const X = 'user-x';
  const OWN = 'user:user-x';
  /**
   * The names a channel labels that member's words with. Not the file's
   * `NAMES` (Vinay's), so the two lists can't stand in for each other.
   */
  const ALICE_NAMES = Object.freeze(['Alice Smith', 'U123']);

  it.each([
    // audience, source, visibility, expected
    [undefined, undefined, 'team', 'private'],
    ['private', 'routine', 'personal', 'private'],
    ['private', 'external', 'team', 'withheld'], // an outsider's turn never files under its runner, whatever the audience
    ['private', 'external', 'personal', 'withheld'],
    ['shared', 'user', 'team', 'team'],
    ['shared', undefined, 'team', 'team'],
    ['shared', 'routine', 'team', 'team'],
    ['shared', 'external', 'team', 'withheld'],
    ['shared', 'bogus', 'team', 'withheld'], // an unknown source fails closed
    ['public', 'user', 'team', 'team'], // an unknown audience reads as shared
    ['shared', 'user', 'personal', 'withheld'],
    ['shared', 'user', 'bogus', 'withheld'], // an unknown visibility fails closed
  ])('audience %j, source %j, %s agent: %s', (audience, source, visibility, expected) => {
    expect(speakerScope({ audience, source } as never, { visibility } as never)).toBe(expected);
  });

  it.each([
    ['user', OWN],
    [OWN, OWN],
    ['alice', OWN],
    ['Alice', OWN],
    ['alice_smith', OWN],
    ['smith_alice', OWN],
    ['alicesmith', OWN],
    ['Alice Smith', OWN],
    ['u123', OWN],
    ['U123', OWN],
    ['user_alice', OWN],
    ['user:U123', OWN],
    ['user:alice', OWN],
    ['User', undefined],
    [' user ', undefined],
    ['user:user-y', undefined],
    ['user:bob', undefined],
    ['user :x', undefined],
    ['a'.repeat(1025), undefined],
    ['team_standup', 'team_standup'],
    ['billing_service', 'billing_service'],
    ['ada', 'ada'],
    ['alice_laptop', 'alice_laptop'],
    ['alices_team', 'alices_team'],
    ['assistant', 'assistant'],
  ])('a team member turn files %j under %j', (about, expected) => {
    expect(speakerSubject('team', about, X, ALICE_NAMES)).toBe(expected);
  });

  it('with no names, a team member turn keeps a name as written and never under a key', () => {
    expect(speakerSubject('team', 'alice_smith', X, [])).toBe('alice_smith');
    expect(speakerSubject('team', 'user', X, [])).toBe(OWN);
    expect(speakerSubject('team', 'user:U123', X, [])).toBeUndefined();
  });

  it("a display name never files the agent's own facts, or anyone's key but the runner's", () => {
    expect(speakerSubject('team', 'assistant', X, ['Assistant', 'U9'])).toBe('assistant');
    // A member whose display name is another member's id: the subject lands
    // on the runner's own key, never on `user:user-y`.
    expect(speakerSubject('team', 'user:user-y', X, ['user-y'])).toBe(OWN);
  });

  // Review F9: not only `assistant`. Every subject self-report reads as the
  // agent itself (`isAgentSubject`) stays as written, whatever a member's
  // display name says.
  it.each([
    ['ai_assistant', ['AI Assistant', 'U7']],
    ['AI Assistant', ['AI Assistant', 'U7']],
    ['ai-assistant', ['AI Assistant', 'U7']],
    ['the_assistant', ['The Assistant', 'U7']],
    ['Assistant', ['Assistant', 'U7']],
    [' assistant ', ['Assistant', 'U7']],
    ['agent', ['Agent Smith', 'U8']],
    ['Agent', ['Agent Smith', 'U8']],
    ['the_agent', ['The Agent', 'U9']],
  ])("a member named like the agent never pulls the agent's %j under their key (names %j)", (about, names) => {
    expect(isAgentSubject(about)).toBe(true);
    expect(speakerSubject('team', about, X, names)).toBe(about);
  });

  it("such a member's own name is still theirs: only the agent's subjects are kept as written", () => {
    expect(speakerSubject('team', 'agent_smith', X, ['Agent Smith', 'U8'])).toBe(OWN);
    expect(speakerSubject('team', 'smith', X, ['Agent Smith', 'U8'])).toBe(OWN);
    expect(speakerSubject('team', 'u7', X, ['AI Assistant', 'U7'])).toBe(OWN);
    expect(speakerSubject('team', 'user', X, ['AI Assistant', 'U7'])).toBe(OWN);
  });

  // Pinned so they stay visible: bounded, since the most a name can do is
  // file the speaker's own words under the speaker.
  it('accepted residuals: a name made of work words, or a namesake, files under the speaker', () => {
    expect(speakerSubject('team', 'team_standup', X, ['Standup Team', 'U7'])).toBe(OWN);
    expect(speakerSubject('team', 'alex', X, ['Alex Kim', 'U8'])).toBe(OWN);
  });

  it('a display name changed mid-thread: every name the thread kept is the speaker', () => {
    const names = ['Vinay Pulim', 'UHTE83XE1', 'vp'];
    expect(speakerSubject('team', 'vp', X, names)).toBe(OWN);
    expect(speakerSubject('team', 'vinay', X, names)).toBe(OWN);
  });

  const EVERY_SUBJECT = [
    ...new Set([
      ...PERSON_SUBJECTS,
      ...NOT_PERSON_SUBJECTS,
      ...NAMES_A_SPEAKER,
      ...NOT_A_SPEAKER,
      TOO_LONG_TO_READ,
      OWN,
      'user:user-y',
      ...AGENT_SELF_SUBJECTS,
    ]),
  ];
  const NAME_LISTS: ReadonlyArray<readonly string[]> = [
    [],
    ALICE_NAMES,
    NAMES,
    ['user-y'],
    ['Assistant'],
    ['AI Assistant', 'Agent Smith', 'The Agent'],
  ];

  it('the agent itself stays as written in a team member turn, under every name list (review F9)', () => {
    const wrong: string[] = [];
    for (const names of NAME_LISTS) {
      for (const about of EVERY_SUBJECT.filter((s) => isAgentSubject(s))) {
        const out = speakerSubject('team', about, X, names);
        if (out !== about) wrong.push(`${JSON.stringify(about)} ${JSON.stringify(names)}: ${out}`);
      }
    }
    expect(wrong).toEqual([]);
    // Not vacuous: every spelling below is one self-report reads as the agent.
    expect(EVERY_SUBJECT.filter((s) => isAgentSubject(s)).length).toBeGreaterThanOrEqual(AGENT_SELF_SUBJECTS.length);
  });

  it("never a person key but the runner's own", () => {
    const wrong: string[] = [];
    for (const names of NAME_LISTS) {
      for (const about of EVERY_SUBJECT) {
        const out = speakerSubject('team', about, X, names);
        const keptOrOwn = out === undefined || out === about || out === OWN;
        const noOtherPerson = out === undefined || !isPersonSubject(out) || out === OWN;
        if (!keptOrOwn || !noOtherPerson) wrong.push(`${JSON.stringify(about)} ${JSON.stringify(names)}: ${out}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('withheld is the TASK-1146 rule, private is the narrow rewrite', () => {
    const wrong: string[] = [];
    for (const names of NAME_LISTS) {
      for (const about of EVERY_SUBJECT) {
        const withheld = speakerSubject('withheld', about, X, names);
        if (withheld !== (breaksSpeakerRule('shared', about, names) ? undefined : about)) {
          wrong.push(`withheld ${JSON.stringify(about)} ${JSON.stringify(names)}: ${withheld}`);
        }
        const own = speakerSubject('private', about, X, names);
        if (own !== rewriteSpeaker(about, X)) wrong.push(`private ${JSON.stringify(about)}: ${own}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
