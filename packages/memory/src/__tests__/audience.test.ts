import Database from 'better-sqlite3';
import {
  HookBus,
  makeAgentContext,
  type AgentContext,
  type AgentContextAudience,
  type LlmCallOutput,
} from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isPersonSubject, recallAudienceScope, recallFacts, recordFacts } from '../audience.js';
import { OBSERVER_RUN_EVENT } from '../failure.js';
import { MEMORY_NOTE_TOOL_HOOK } from '../note-tool.js';
import { FACTS_RECALL_HOOK, FACTS_RECORD_HOOK } from '../plugin.js';
import { MEMORY_RECALL_TOOL_HOOK } from '../recall-tool.js';
import type { MemoryRecallInput, MemoryRecallOutput } from '../types.js';
import {
  ALICE,
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

  // Spreading the scope last isn't enough on its own: a private turn's scope
  // is empty, so it overrides nothing.
  it.each(['shared', 'private', 'public', undefined])(
    'a private read drops a caller-built audience %j: the scope comes from ctx alone',
    async (audience) => {
      for (const ctx of [turn(), turn('private')]) {
        const { bus, asked } = engineAnswering({ statements: [], degraded: [] });
        await recallFacts(bus, ctx, FACTS_RECALL_HOOK, { limit: 5, audience });
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
    expect(await recallFacts(bus, turn('shared'), FACTS_RECALL_HOOK, {})).toBe(answer);
  });
});

// ---------------------------------------------------------------------------
// The write side: every statement is stamped with its turn's audience, and a
// shared turn stores nothing about a person.
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
});

describe('isPersonSubject — what a shared turn stores nothing about', () => {
  it.each(PERSON_SUBJECTS)('%j is a person', (about) => {
    expect(isPersonSubject(about)).toBe(true);
  });

  it.each(NOT_PERSON_SUBJECTS)('%j is not', (about) => {
    expect(isPersonSubject(about)).toBe(false);
  });
});

describe('recordFacts — the one door every engine write goes through', () => {
  const ANSWER = { records: [{ id: 'row-1' }] };
  const turn = (audience?: AgentContextAudience): AgentContext =>
    makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      ...(audience !== undefined ? { audience } : {}),
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
    await recordFacts(bus, turn(audience as AgentContextAudience | undefined), FACTS_RECORD_HOOK, {
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
      const failure: unknown = await recordFacts(bus, turn('shared'), FACTS_RECORD_HOOK, {
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
      recordFacts(bus, turn('public' as AgentContextAudience), FACTS_RECORD_HOOK, {
        statements: [{ about: 'user', value: 'Paris' }],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(written).toEqual([]);
  });

  it.each(NOT_PERSON_SUBJECTS)('a shared write about %j goes through, stamped shared', async (about) => {
    const { bus, written } = engineRecording();
    await recordFacts(bus, turn('shared'), FACTS_RECORD_HOOK, { statements: [{ about }] });
    expect(written).toEqual([{ statements: [{ about, audience: 'shared' }] }]);
  });

  it('a private write sends a person subject on: the speaker rewrite already ran upstream', async () => {
    for (const ctx of [turn(), turn('private')]) {
      const { bus, written } = engineRecording();
      await recordFacts(bus, ctx, FACTS_RECORD_HOOK, {
        statements: [{ about: `user:${ALICE}` }, { about: 'User' }],
      });
      expect(written).toEqual([
        { statements: [{ about: `user:${ALICE}`, audience: 'private' }, { about: 'User', audience: 'private' }] },
      ]);
    }
  });

  it("returns the engine's answer as it came", async () => {
    const { bus } = engineRecording();
    expect(await recordFacts(bus, turn('shared'), FACTS_RECORD_HOOK, { statements: [{ about: 'x' }] })).toBe(ANSWER);
  });

  // Both engines validate with `map`, which skips a hole, so a hole sent on
  // as one would never be looked at.
  it('sends a hole on as a statement with no subject, for the engine to refuse', async () => {
    const { bus, written } = engineRecording();
    const statements: object[] = [{ about: 'a' }];
    statements.length = 2;
    await recordFacts(bus, turn('shared'), FACTS_RECORD_HOOK, { statements });
    expect(written).toEqual([{ statements: [{ about: 'a', audience: 'shared' }, { audience: 'shared' }] }]);
    expect(1 in (written[0] as { statements: unknown[] }).statements).toBe(true);
  });
});
