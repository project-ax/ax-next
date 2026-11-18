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
  type LlmCallOutput,
  type MemoryPreCapturePayload,
} from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  breaksSpeakerRule,
  isPersonSubject,
  namesASpeaker,
  recallAudienceScope,
  recallFacts,
  recordFacts,
} from '../audience.js';
import { OBSERVER_RUN_EVENT } from '../failure.js';
import { MEMORY_NOTE_TOOL_HOOK, PERSON_IN_SHARED_MESSAGE, type MemoryNoteResult } from '../note-tool.js';
import { toStatements } from '../observer.js';
import { FACTS_RECALL_HOOK, FACTS_RECORD_HOOK } from '../plugin.js';
import { MEMORY_RECALL_TOOL_HOOK } from '../recall-tool.js';
import type { MemoryRecallInput, MemoryRecallOutput } from '../types.js';
import {
  ALICE,
  answerSpeakerNames,
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
  it('the speaker word alone does not name a speaker, with names or without', () => {
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
          audience: audienceOf(ctx),
          speakerNames: NAMES,
        }).speakerFacts === 1;
      const result = await h.bus.call<unknown, MemoryNoteResult>(MEMORY_NOTE_TOOL_HOOK, ctx, {
        input: { about, relation: 'r', value: 'v' },
      });
      // Refused FOR THIS RULE: the backstop's generic `forbidden` doesn't count.
      const note = !result.ok && result.error === 'forbidden' && result.message.endsWith(PERSON_IN_SHARED_MESSAGE);
      const record = await recordFacts(engine, ctx, FACTS_RECORD_HOOK, { statements: [{ about }] }).then(
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
});

describe('recordFacts — the one door every engine write goes through', () => {
  const ANSWER = { records: [{ id: 'row-1' }] };
  const turn = (audience?: AgentContextAudience, conversationId?: string): AgentContext =>
    makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      ...(audience !== undefined ? { audience } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
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

  // TASK-1146: the backstop knows the speakers' names too. A caller that has
  // them (the observer, `memory_note`) passes them; one that doesn't makes
  // `recordFacts` ask, so a writer added later can't forget the names.
  it('with no names given, a shared write asks memory:pre-capture once and refuses a speaker name, sending nothing', async () => {
    const { bus, written } = engineRecording();
    const asked = answerSpeakerNames(bus, ['vinay']);
    const failure: unknown = await recordFacts(bus, turn('shared', CHANNEL), FACTS_RECORD_HOOK, {
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
        recordFacts(bus, turn('shared', CHANNEL), FACTS_RECORD_HOOK, { statements: [{ about }] }),
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
      recordFacts(bus, turn('shared', CHANNEL), FACTS_RECORD_HOOK, { statements: [{ about: 'user' }] }),
    ).rejects.toMatchObject({ code: 'forbidden', hookName: FACTS_RECORD_HOOK });
  });

  it('names given, it asks nothing: an empty list is an answer too', async () => {
    const { bus, written } = engineRecording();
    const asked = answerSpeakerNames(bus, ['vinay']);
    const ctx = turn('shared', CHANNEL);
    await expect(
      recordFacts(bus, ctx, FACTS_RECORD_HOOK, { statements: [{ about: 'vinay' }] }, ['vinay']),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // `[]` means "asked, and nobody was named", so it is sent, though the
    // subscriber would have named `vinay` had it been asked.
    await recordFacts(bus, ctx, FACTS_RECORD_HOOK, { statements: [{ about: 'vinay' }] }, []);
    expect(asked).toEqual([]);
    expect(written).toEqual([{ statements: [{ about: 'vinay', audience: 'shared' }] }]);
  });

  it('a refused ask refuses the batch', async () => {
    const { bus, written } = engineRecording();
    bus.subscribe(MEMORY_PRE_CAPTURE_HOOK, 'test-refuser', async () => reject({ reason: 'channel-not-remembered' }));
    const failure: unknown = await recordFacts(bus, turn('shared', CHANNEL), FACTS_RECORD_HOOK, {
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
      await recordFacts(bus, ctx, FACTS_RECORD_HOOK, { statements: [{ about: 'vinay' }] });
    }
    expect(asked).toEqual([]);
    expect(written).toEqual([
      { statements: [{ about: 'vinay', audience: 'private' }] },
      { statements: [{ about: 'vinay', audience: 'private' }] },
    ]);

    // The control: the same write in a shared turn asks, and is refused.
    await expect(
      recordFacts(bus, turn('shared', CHANNEL), FACTS_RECORD_HOOK, { statements: [{ about: 'vinay' }] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(asked).toEqual([{ conversationId: CHANNEL }]);
  });

  it('an answer memory cannot read throws invalid-return, and nothing is written', async () => {
    const { bus, written } = engineRecording();
    bus.subscribe<MemoryPreCapturePayload>(MEMORY_PRE_CAPTURE_HOOK, 'test-garbled', async (_ctx, payload) => ({
      ...payload,
      speakerNames: 'vinay' as unknown as string[],
    }));
    const failure: unknown = await recordFacts(bus, turn('shared', CHANNEL), FACTS_RECORD_HOOK, {
      statements: [{ about: 'billing_service', value: 'Dana' }],
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toMatchObject({ code: 'invalid-return', plugin: '@ax/memory', hookName: MEMORY_PRE_CAPTURE_HOOK });
    expect((failure as Error).message).not.toContain('vinay');
    expect(written).toEqual([]);
  });
});
