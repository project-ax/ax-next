import Database from 'better-sqlite3';
import type { AgentContext, LlmCallInput } from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NOTE_FAILED_EVENT, OBSERVER_FAILED_EVENT, OBSERVER_RUN_EVENT } from '../failure.js';
import { MEMORY_NOTE_TOOL_HOOK, NOTE_TWIN_EVENT, type MemoryNoteResult } from '../note-tool.js';
import type { MemoryStatement } from '../types.js';
import { eventsNamed, makeMemoryHarness, type MemoryHarness } from './harness.js';

/**
 * TASK-641 — an agent note and the extracted copy of the same fact.
 *
 * The walk (TASK-629, kind, main d4ec1335) found each fact stored twice: once
 * by the agent's `memory_note` during the turn (`product go-live date`,
 * `relocating to`), and again by the observer after the turn
 * (`product_go_live_date`, `relocating_to`), with paraphrased values. A Fix on
 * one left the other showing.
 *
 * The observer now drops the extracted twin at write time, so there is one
 * row and every person-facing action — Fix, Undo-for-Fix, Forget, Forget-Undo
 * — acts on all of it. Driven end to end through the bus over the REAL sqlite
 * engine, with the same fake transcript and cursor store as
 * `incremental.test.ts`.
 */

let harness: MemoryHarness | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await harness?.teardown();
  harness = undefined;
});

const CONV = 'conv-1';
const IDLE_MS = 1_000;

interface Fact {
  subject: string;
  predicate: string;
  object: string;
  /** Defaults to 2026-09-01. */
  validStart?: string;
}

/** The measured walk pair: what the agent saved, and what extraction wrote. */
const GO_LIVE_NOTE = { about: 'user', relation: 'product go-live date', value: 'October 14, 2026' };
const GO_LIVE_EXTRACTED: Fact = {
  subject: 'user',
  predicate: 'product_go_live_date',
  object: 'Product go-live moved to October 14',
};
const DENVER_NOTE = { about: 'user', relation: 'relocating to', value: 'Denver, in November 2026' };
const DENVER_EXTRACTED: Fact = {
  subject: 'user',
  predicate: 'relocating_to',
  object: 'Relocating to Denver in November',
};

interface Env {
  h: MemoryHarness;
  ctx: (source?: 'routine') => AgentContext;
  /** What the stub extractor answers on its next calls. */
  extract: (facts: Fact[]) => void;
  note: (input: { about: string; relation: string; value: string }, ctx?: AgentContext) => Promise<void>;
  /** A user message and its reply, then the assistant turn-end. */
  exchange: (user: string, assistant: string, reqId: string) => Promise<void>;
  /** Let the idle pass run and settle. */
  idle: () => Promise<void>;
  /** The conversation feed: this conversation's ACTIVE rows. */
  feed: () => Promise<MemoryStatement[]>;
  /** Every stored row, active or closed, straight from the table. */
  rows: () => Array<{
    relation: string;
    value: string;
    provenance: string;
    source_role: string | null;
  }>;
}

async function setup(): Promise<Env> {
  let facts: Fact[] = [];
  const llm = (_input: LlmCallInput) => ({
    text: JSON.stringify({
      facts: facts.map((f) => ({
        network: 'experience',
        validStart: '2026-09-01T00:00:00Z',
        ...f,
        invalidatesPrevious: false,
      })),
    }),
    stopReason: 'end_turn' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const h = await makeMemoryHarness({ incremental: { idleMs: IDLE_MS, everyUserTurns: 4 } }, { llm });
  harness = h;

  const turns: Array<Record<string, unknown>> = [];
  const storage = new Map<string, Uint8Array>();
  h.bus.registerService('conversations:get', 'fake-conversations', async () => ({
    conversation: { title: null },
    turns: [...turns],
  }));
  h.bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
    'storage:get',
    'fake-storage',
    async (_c, { key }) => ({ value: storage.get(key) }),
  );
  h.bus.registerService<{ key: string; value: Uint8Array }, void>(
    'storage:set',
    'fake-storage',
    async (_c, { key, value }) => {
      storage.set(key, value);
    },
  );
  const say = (role: 'user' | 'assistant', text: string): void => {
    turns.push({
      turnId: `${turns.length}`,
      turnIndex: turns.length,
      role,
      contentBlocks: [{ type: 'text', text }],
      createdAt: '2026-09-27T00:00:00Z',
    });
  };
  const ctx: Env['ctx'] = (source) =>
    h.ctx({ conversationId: CONV, ...(source !== undefined ? { source } : {}) });

  return {
    h,
    ctx,
    extract: (next) => {
      facts = next;
    },
    note: async (input, c = ctx()) => {
      const out = await h.bus.call<unknown, MemoryNoteResult>(MEMORY_NOTE_TOOL_HOOK, c, { input });
      expect(out).toEqual({ ok: true });
    },
    exchange: async (user, assistant, reqId) => {
      say('user', user);
      say('assistant', assistant);
      await h.bus.fire('chat:turn-end', ctx(), { role: 'assistant', reqId, reason: 'user-message-wait' });
    },
    idle: async () => {
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      await h.settleObserver();
    },
    feed: async () => (await h.recall({ conversationId: CONV }, ctx())).statements,
    rows: () => {
      const db = new Database(h.databasePath, { readonly: true });
      try {
        return db
          .prepare('SELECT relation, value, provenance, source_role FROM memory_facts_v1 ORDER BY rowid')
          .all() as ReturnType<Env['rows']>;
      } finally {
        db.close();
      }
    },
  };
}

/** The agent notes the fact DURING the turn; extraction runs after it. */
async function notedThenExtracted(env: Env): Promise<void> {
  await env.note(GO_LIVE_NOTE);
  await env.note(DENVER_NOTE);
  env.extract([GO_LIVE_EXTRACTED, DENVER_EXTRACTED]);
  await env.exchange(
    'Our product go-live moved to Oct 14, and I am relocating to Denver in November.',
    'Saved both.',
    'r1',
  );
  await env.idle();
}

function values(statements: readonly { value: string }[]): string[] {
  return statements.map((s) => s.value).sort();
}

describe('an extracted restatement of an agent note is not stored', () => {
  it('the walk pairs: one row per fact, the agent’s', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await notedThenExtracted(env);

    expect(env.h.llmCalls).toHaveLength(1);
    expect(env.rows().map((r) => r.provenance)).toEqual(['agent', 'agent']);
    const feed = await env.feed();
    expect(values(feed)).toEqual(['Denver, in November 2026', 'October 14, 2026']);
    expect(feed.every((s) => s.savedBy === 'agent')).toBe(true);

    const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'skipped', reason: 'only-twins', twins: 2 });
  });

  it('a different fact in the same pass is still stored — and a second value of the same relation too', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await env.note(GO_LIVE_NOTE);
    await env.note({ about: 'user', relation: 'likes artist', value: 'Radiohead' });
    env.extract([
      GO_LIVE_EXTRACTED,
      { subject: 'user', predicate: 'likes_artist', object: 'Bjork' },
      { subject: 'user', predicate: 'has_pet', object: 'a cat named Miso' },
    ]);
    await env.exchange('Go-live is Oct 14. I love Radiohead and Bjork. My cat is Miso.', 'Noted.', 'r1');
    await env.idle();

    expect(values(await env.feed())).toEqual([
      'Bjork',
      'October 14, 2026',
      'Radiohead',
      'a cat named Miso',
    ]);
    const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'recorded', recorded: 2, twins: 1 });
  });

  // A SCOPE guard, not a fix test: it passes on the unfixed code too. It
  // fails if the check ever starts matching a routine batch against its
  // hidden per-fire conversation. (TASK-654's retracted-twin check is
  // owner-scoped and does run here; it finds nothing retracted to drop.)
  it('a routine run carries no conversation, so the conversation twin check is skipped (TASK-616 scope)', async () => {
    vi.useFakeTimers();
    const env = await setup();
    const routine = env.ctx('routine');
    await env.note(GO_LIVE_NOTE, routine);
    env.extract([GO_LIVE_EXTRACTED]);
    await env.h.bus.fire('chat:end', routine, {
      outcome: {
        kind: 'complete',
        messages: [
          { role: 'user', content: 'Go-live moved to Oct 14.' },
          { role: 'assistant', content: 'Saved.' },
        ],
      },
    });
    await env.h.settleObserver();
    expect(env.rows().map((r) => r.provenance).sort()).toEqual(['agent', 'extracted']);
  });
});

describe('a Fix on the note leaves nothing of the old value showing', () => {
  it("'it changed' after the pass", async () => {
    vi.useFakeTimers();
    const env = await setup();
    await notedThenExtracted(env);
    const goLive = (await env.feed()).find((s) => s.value === 'October 14, 2026');
    expect(goLive).toBeDefined();

    await env.h.correct(
      { id: goLive!.id, about: 'user', relation: goLive!.relation, value: 'October 20, 2026', reason: 'changed' },
      env.ctx(),
    );

    const all = (await env.h.recall({ about: 'user', limit: 50 }, env.ctx())).statements;
    expect(values(all)).toEqual(['Denver, in November 2026', 'October 20, 2026']);
    expect(all.some((s) => /October 14/.test(s.value))).toBe(false);
  });

  it.each(['changed', 'never-right'] as const)(
    "'%s' BEFORE the pass: the extractor's copy does not bring the old value back",
    async (reason) => {
      vi.useFakeTimers();
      const env = await setup();
      await env.note(GO_LIVE_NOTE);
      const [noted] = await env.feed();
      // The corrected value shares no word with the extracted one, so only
      // the CLOSED note can recognise the extractor's copy — the check must
      // read closed rows, not just active ones.
      await env.h.correct(
        { id: noted!.id, about: 'user', relation: noted!.relation, value: 'Pushed to spring', reason },
        env.ctx(),
      );

      env.extract([GO_LIVE_EXTRACTED]);
      await env.exchange('Our product go-live moved to Oct 14.', 'Saved.', 'r1');
      await env.idle();

      const all = (await env.h.recall({ about: 'user', limit: 50 }, env.ctx())).statements;
      expect(values(all)).toEqual(['Pushed to spring']);
      expect(env.rows().some((r) => r.provenance === 'extracted')).toBe(false);
    },
  );

  // Pins the active-human-prior path. Not the two-word rule's guard: under the
  // old one-word rule the closed note (sharing `october`) suppressed it too.
  it("the person's own Fix, still active, suppresses the extractor's restatement of it", async () => {
    vi.useFakeTimers();
    const env = await setup();
    await env.note(GO_LIVE_NOTE);
    const [noted] = await env.feed();
    await env.h.correct(
      { id: noted!.id, about: 'user', relation: noted!.relation, value: 'October 20, 2026', reason: 'changed' },
      env.ctx(),
    );

    env.extract([{ ...GO_LIVE_EXTRACTED, object: 'Product go-live moved to October 20' }]);
    await env.exchange('Actually the go-live moved to Oct 20.', 'Updated.', 'r1');
    await env.idle();

    const feed = await env.feed();
    expect(values(feed)).toEqual(['October 20, 2026']);
    expect(feed[0]?.savedBy).toBe('person');
    expect(env.rows().some((r) => r.provenance === 'extracted')).toBe(false);
  });

  it('Undo-for-Fix restores the note — once', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await notedThenExtracted(env);
    const goLive = (await env.feed()).find((s) => s.value === 'October 14, 2026')!;
    const fixed = await env.h.correct(
      { id: goLive.id, about: 'user', relation: goLive.relation, value: 'October 20, 2026', reason: 'never-right' },
      env.ctx(),
    );

    const undo = await env.h.uncorrect({ id: fixed.id, restore: goLive.id }, env.ctx());
    expect(undo).toEqual({ undone: true });
    const all = (await env.h.recall({ about: 'user', limit: 50 }, env.ctx())).statements;
    expect(values(all)).toEqual(['Denver, in November 2026', 'October 14, 2026']);
  });
});

describe('a Forget on the note forgets the fact', () => {
  it('Forget, then the pass: nothing comes back; Forget-Undo restores it once', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await env.note(DENVER_NOTE);
    const [noted] = await env.feed();
    await env.h.forget({ ids: [noted!.id] }, env.ctx());

    env.extract([DENVER_EXTRACTED]);
    await env.exchange('I am relocating to Denver in November.', 'Noted.', 'r1');
    await env.idle();
    expect(await env.feed()).toEqual([]);

    await env.h.unforget({ ids: [noted!.id] }, env.ctx());
    expect(values(await env.feed())).toEqual(['Denver, in November 2026']);
  });
});

describe('the twin read fails open', () => {
  it('records the batch unfiltered and says so', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await env.note(GO_LIVE_NOTE);

    const bus = env.h.bus;
    const original = bus.call.bind(bus);
    bus.call = (async (name: string, c: AgentContext, input: unknown) => {
      // The twin read is the only facts read naming BOTH a subject and a
      // conversation; the feed names the conversation alone.
      const i = input as { about?: unknown; conversationId?: unknown } | undefined;
      if (name === 'memory:facts:recall' && i?.about !== undefined && i.conversationId === CONV) {
        throw new Error('facts store unavailable');
      }
      return original(name, c, input);
    }) as typeof bus.call;

    env.extract([GO_LIVE_EXTRACTED]);
    await env.exchange('Our product go-live moved to Oct 14.', 'Saved.', 'r1');
    await env.idle();
    bus.call = original;

    expect(env.rows().map((r) => r.provenance)).toEqual(['agent', 'extracted']);
    const failed = eventsNamed(env.h.logs, OBSERVER_FAILED_EVENT).find(
      (e) => e.bindings.reason === 'twin-check-failed',
    );
    expect(failed).toBeDefined();
    // TASK-649: the cause travels with the warning.
    expect(failed?.bindings.err).toBeInstanceOf(Error);
    expect((failed?.bindings.err as Error).message).toBe('facts store unavailable');
  });
});

// ---------------------------------------------------------------------------
// TASK-649 — the REVERSE order: the agent notes, in a later turn, a fact an
// earlier extraction pass already stored. The note is not written a second
// time; the extracted row stays the one row (with its `sourceRole`).
// ---------------------------------------------------------------------------

/** The extraction pass runs first; the agent notes the same fact afterwards. */
async function extractedThenNoted(env: Env): Promise<MemoryNoteResult> {
  env.extract([DENVER_EXTRACTED]);
  await env.exchange('I am relocating to Denver in November.', 'Sounds exciting.', 'r1');
  await env.idle();
  expect(env.rows().map((r) => r.provenance)).toEqual(['extracted']);
  return env.h.bus.call<unknown, MemoryNoteResult>(MEMORY_NOTE_TOOL_HOOK, env.ctx(), {
    input: DENVER_NOTE,
  });
}

describe('an agent note restating an extracted row is not stored (TASK-649)', () => {
  it('one row — the extracted one — and the note still reports it saved', async () => {
    vi.useFakeTimers();
    const env = await setup();
    const out = await extractedThenNoted(env);

    expect(out).toEqual({ ok: true });
    expect(env.rows().map((r) => [r.provenance, r.source_role])).toEqual([['extracted', 'user']]);
    expect(values(await env.feed())).toEqual(['Relocating to Denver in November']);
    expect(eventsNamed(env.h.logs, NOTE_TWIN_EVENT)).toHaveLength(1);
  });

  it('a second value of the same relation is still noted', async () => {
    vi.useFakeTimers();
    const env = await setup();
    env.extract([{ subject: 'user', predicate: 'likes_artist', object: 'Bjork' }]);
    await env.exchange('I love Bjork.', 'Nice.', 'r1');
    await env.idle();
    await env.note({ about: 'user', relation: 'likes artist', value: 'Radiohead' });

    expect(values(await env.feed())).toEqual(['Bjork', 'Radiohead']);
  });

  // Only an ACTIVE extracted row holds the fact; a forgotten one does not, so
  // "saved" would be false. A guard for the active-only choice.
  it('a forgotten extracted twin does not stop the note', async () => {
    vi.useFakeTimers();
    const env = await setup();
    env.extract([DENVER_EXTRACTED]);
    await env.exchange('I am relocating to Denver in November.', 'Sounds exciting.', 'r1');
    await env.idle();
    const [extracted] = await env.feed();
    await env.h.forget({ ids: [extracted!.id] }, env.ctx());

    await env.note(DENVER_NOTE);
    expect(values(await env.feed())).toEqual(['Denver, in November 2026']);
  });

  it('a Fix on the one row leaves nothing of the old value; Undo restores it once', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await extractedThenNoted(env);
    const [row] = await env.feed();
    const fixed = await env.h.correct(
      { id: row!.id, about: 'user', relation: row!.relation, value: 'Staying in Boston', reason: 'never-right' },
      env.ctx(),
    );
    const all = async (): Promise<string[]> =>
      values((await env.h.recall({ about: 'user', limit: 50 }, env.ctx())).statements);
    expect(await all()).toEqual(['Staying in Boston']);

    expect(await env.h.uncorrect({ id: fixed.id, restore: row!.id }, env.ctx())).toEqual({ undone: true });
    expect(await all()).toEqual(['Relocating to Denver in November']);
  });

  it('Forget forgets the fact; Forget-Undo restores it once', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await extractedThenNoted(env);
    const [row] = await env.feed();
    await env.h.forget({ ids: [row!.id] }, env.ctx());
    expect(await env.feed()).toEqual([]);

    await env.h.unforget({ ids: [row!.id] }, env.ctx());
    expect(values(await env.feed())).toEqual(['Relocating to Denver in November']);
  });

  it('the twin read fails open: the note is written, and the warning carries the cause', async () => {
    vi.useFakeTimers();
    const env = await setup();
    env.extract([DENVER_EXTRACTED]);
    await env.exchange('I am relocating to Denver in November.', 'Sounds exciting.', 'r1');
    await env.idle();

    const bus = env.h.bus;
    const original = bus.call.bind(bus);
    bus.call = (async (name: string, c: AgentContext, input: unknown) => {
      const i = input as { about?: unknown; conversationId?: unknown } | undefined;
      if (name === 'memory:facts:recall' && i?.about !== undefined && i.conversationId === CONV) {
        throw new Error('facts store unavailable');
      }
      return original(name, c, input);
    }) as typeof bus.call;
    try {
      await env.note(DENVER_NOTE);
    } finally {
      bus.call = original;
    }

    expect(env.rows().map((r) => r.provenance)).toEqual(['extracted', 'agent']);
    const failed = eventsNamed(env.h.logs, NOTE_FAILED_EVENT).find(
      (e) => e.bindings.reason === 'twin-check-failed',
    );
    expect((failed?.bindings.err as Error | undefined)?.message).toBe('facts store unavailable');
  });
});

// ---------------------------------------------------------------------------
// TASK-649 x TASK-648 — the person restating a value they marked never right
// must survive an agent-note twin, in either order: the dedup keeps the
// user-sourced extracted row, which is what `restatedByPerson` reads.
// ---------------------------------------------------------------------------

describe('a user restatement of a retracted value survives an agent-note twin', () => {
  const OLD = 'conv-old';
  const LIVES = { about: 'user', relation: 'lives in', value: 'Denver, Colorado' };

  /** In another conversation: the agent noted Denver, the person Fixed it as never right. */
  async function retracted(env: Env): Promise<void> {
    const old = env.h.ctx({ conversationId: OLD });
    await env.note(LIVES, old);
    const [noted] = (await env.h.recall({ conversationId: OLD }, old)).statements;
    await env.h.correct(
      { id: noted!.id, about: 'user', relation: noted!.relation, value: 'Boston, Massachusetts', reason: 'never-right' },
      old,
    );
  }
  // Dated after the Fix's correction (a correction is true from now).
  const restatement = (): Fact => ({
    subject: 'user',
    predicate: 'lives_in',
    object: 'Denver, Colorado',
    validStart: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const profile = async (env: Env): Promise<string[]> =>
    values((await env.h.recall({ profile: true }, env.ctx())).statements);

  it('agent note first, then the pass: the extracted row is kept and the value comes back', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    await env.note(LIVES);
    env.extract([restatement()]);
    await env.exchange('Actually I do live in Denver, Colorado.', 'Got it.', 'r1');
    await env.idle();

    expect(env.rows().filter((r) => r.provenance === 'extracted').map((r) => r.source_role)).toEqual([
      'user',
    ]);
    expect(await profile(env)).toEqual(['Denver, Colorado']);
    // The agent note it twins is a retracted value on a non-human row
    // (TASK-639): hidden, so the fact does not show twice.
    expect(values(await env.feed())).toEqual(['Denver, Colorado']);
  });

  it('the pass first, then the note: the note is dropped and the value still comes back', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    env.extract([restatement()]);
    await env.exchange('Actually I do live in Denver, Colorado.', 'Got it.', 'r1');
    await env.idle();
    await env.note(LIVES);

    // One row in this conversation; the only agent row is the old, retracted note.
    expect(values(await env.feed())).toEqual(['Denver, Colorado']);
    expect(env.rows().filter((r) => r.provenance === 'agent')).toHaveLength(1);
    expect(await profile(env)).toEqual(['Denver, Colorado']);
  });

  it('the chain read fails open: the statement is kept, and the warning carries the cause', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    await env.note(LIVES);

    const bus = env.h.bus;
    const original = bus.call.bind(bus);
    bus.call = (async (name: string, c: AgentContext, input: unknown) => {
      // The chain read is the only one naming slots with no conversation.
      const i = input as { slots?: unknown; conversationId?: unknown } | undefined;
      if (name === 'memory:facts:recall' && Array.isArray(i?.slots) && i.conversationId === undefined) {
        throw new Error('chain unavailable');
      }
      return original(name, c, input);
    }) as typeof bus.call;
    try {
      env.extract([restatement()]);
      await env.exchange('Actually I do live in Denver, Colorado.', 'Got it.', 'r1');
      await env.idle();
    } finally {
      bus.call = original;
    }

    expect(env.rows().filter((r) => r.provenance === 'extracted')).toHaveLength(1);
    const failed = eventsNamed(env.h.logs, OBSERVER_FAILED_EVENT).find(
      (e) => e.bindings.reason === 'twin-check-failed',
    );
    expect((failed?.bindings.err as Error | undefined)?.message).toBe('chain unavailable');
  });

  // Guard: only the PERSON's message earns the exception.
  it("the agent's reply repeating it is still dropped as the note's twin", async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    await env.note(LIVES);
    env.extract([restatement()]);
    await env.exchange('Where was it I live?', 'You live in Denver, Colorado.', 'r1');
    await env.idle();

    expect(env.rows().some((r) => r.provenance === 'extracted')).toBe(false);
    expect(await profile(env)).toEqual(['Boston, Massachusetts']);
  });

  // TASK-641's in-window Fix: the note is Fixed as never right BEFORE the pass
  // over the turn it came from. Every twin is closed, so the extractor's copy
  // is still dropped — or the value just fixed away would come straight back.
  it('a never-right Fix inside the idle window still drops the exact-value copy', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await env.note(LIVES);
    const [noted] = await env.feed();
    await env.h.correct(
      { id: noted!.id, about: 'user', relation: noted!.relation, value: 'Boston, Massachusetts', reason: 'never-right' },
      env.ctx(),
    );
    env.extract([restatement()]);
    await env.exchange('I live in Denver, Colorado.', 'Saved.', 'r1');
    await env.idle();

    expect(env.rows().some((r) => r.provenance === 'extracted')).toBe(false);
    expect(await profile(env)).toEqual(['Boston, Massachusetts']);
  });
});

// ---------------------------------------------------------------------------
// TASK-652 — the person NEGATING a value they marked never right must not
// bring it back. Since TASK-648 a user-sourced extracted row restating a
// retracted value resurfaces it; an extractor that reads "I never lived in
// Denver" as `lives_in | Denver` would therefore resurface the very value the
// person is rejecting again. `negation.ts` drops that misreading.
// ---------------------------------------------------------------------------

describe('a negation in the person’s own message never resurfaces a retracted value', () => {
  const OLD = 'conv-old';
  const LIVES = { about: 'user', relation: 'lives in', value: 'Denver, Colorado' };

  async function retracted(env: Env): Promise<void> {
    const old = env.h.ctx({ conversationId: OLD });
    await env.note(LIVES, old);
    const [noted] = (await env.h.recall({ conversationId: OLD }, old)).statements;
    await env.h.correct(
      { id: noted!.id, about: 'user', relation: noted!.relation, value: 'Boston, Massachusetts', reason: 'never-right' },
      old,
    );
  }
  // The misreading an extractor can produce for every phrasing below. Dated
  // after the Fix, so if it were stored it would win the slot.
  const misreading = (): Fact => ({
    subject: 'user',
    predicate: 'lives_in',
    object: 'Denver, Colorado',
    validStart: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const profile = async (env: Env): Promise<string[]> =>
    values((await env.h.recall({ profile: true }, env.ctx())).statements);

  it.each([
    'I never lived in Denver, Colorado.',
    'Not Denver, Colorado anymore.',
    "I don't live in Denver, Colorado.",
    'I no longer live in Denver, Colorado.',
    'I have never lived in Denver, Colorado, to be clear.',
  ])('"%s" read as lives_in Denver: nothing stored, the Fix holds', async (said) => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    env.extract([misreading()]);
    await env.exchange(said, 'Understood.', 'r1');
    await env.idle();

    expect(env.rows().some((r) => r.provenance === 'extracted')).toBe(false);
    expect(await profile(env)).toEqual(['Boston, Massachusetts']);
    const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'skipped', reason: 'only-negations', negated: 1 });
  });

  it('the rest of the batch is still recorded, and the drop is counted', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    env.extract([misreading(), { subject: 'user', predicate: 'works_at', object: 'Acme Robotics' }]);
    await env.exchange('I never lived in Denver, Colorado. I work at Acme Robotics.', 'Noted.', 'r1');
    await env.idle();

    expect(env.rows().filter((r) => r.provenance === 'extracted').map((r) => r.value)).toEqual([
      'Acme Robotics',
    ]);
    expect(await profile(env)).toEqual(['Acme Robotics', 'Boston, Massachusetts']);
    const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'recorded', recorded: 1, negated: 1 });
  });

  // Control: the TASK-648 ruling still holds for a real restatement.
  it('a real positive restatement still brings the value back', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    env.extract([misreading()]);
    await env.exchange('Actually I do live in Denver, Colorado.', 'Got it.', 'r1');
    await env.idle();

    expect(env.rows().filter((r) => r.provenance === 'extracted').map((r) => r.source_role)).toEqual([
      'user',
    ]);
    expect(await profile(env)).toEqual(['Denver, Colorado']);
  });

  it('"No, Denver, Colorado." is an answer, not a negation: the value comes back', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    env.extract([misreading()]);
    await env.exchange('No, Denver, Colorado.', 'Got it.', 'r1');
    await env.idle();

    expect(await profile(env)).toEqual(['Denver, Colorado']);
  });
});

// ---------------------------------------------------------------------------
// TASK-654 — a SLOT-LESS value the person marked never right must not come
// back on the agent's say-so. The read side hides a retracted value only in a
// single-valued slot (`profile.ts`); the walk's "Denver" / "Oct 14" rows sit
// in no slot, so the observer checks for a retracted TWIN before it writes
// (human ruling, Vinay 2026-09-28: "observer checks at write"). The person
// restating it in their own turn still brings it back (TASK-648 ruling).
// ---------------------------------------------------------------------------

describe('a slot-less value marked never right is not re-extracted from the agent', () => {
  const OLD = 'conv-old';
  const CORRECTED = 'Austin, in March 2027';
  const PET: Fact = { subject: 'user', predicate: 'has_pet', object: 'a cat named Miso' };

  /** In another conversation: the agent noted the move, the person Fixed it as never right. */
  async function retracted(env: Env): Promise<{ notedId: string; correctionId: string }> {
    const old = env.h.ctx({ conversationId: OLD });
    await env.note(DENVER_NOTE, old);
    const [noted] = (await env.h.recall({ conversationId: OLD }, old)).statements;
    const { id } = await env.h.correct(
      { id: noted!.id, about: 'user', relation: noted!.relation, value: CORRECTED, reason: 'never-right' },
      old,
    );
    return { notedId: noted!.id, correctionId: id };
  }
  /** Every active row the owner has, any conversation. */
  const active = async (env: Env): Promise<string[]> =>
    values((await env.h.recall({ activeOnly: true }, env.ctx())).statements);
  const extracted = (env: Env) => env.rows().filter((r) => r.provenance === 'extracted');

  it('the premise: the note and its re-extraction sit in no slot', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    const rows = (await env.h.recall({ activeOnly: false }, env.ctx())).statements;
    expect(rows.every((r) => r.slot === undefined)).toBe(true);
  });

  it("the agent's reply repeating it is not stored, and the value stays hidden", async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    env.extract([DENVER_EXTRACTED]);
    await env.exchange('When is my move again?', 'You are relocating to Denver in November.', 'r1');
    await env.idle();

    expect(extracted(env)).toEqual([]);
    expect(await active(env)).toEqual([CORRECTED]);
    expect(await env.feed()).toEqual([]);
    const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'skipped', reason: 'only-twins', twins: 0, retracted: 1 });
  });

  it('an unrelated slot-less fact in the same pass is still stored, and the drop is counted', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    env.extract([DENVER_EXTRACTED, PET]);
    await env.exchange(
      'I have a cat named Miso.',
      'Lovely! And you are relocating to Denver in November.',
      'r1',
    );
    await env.idle();

    expect(extracted(env).map((r) => r.value)).toEqual(['a cat named Miso']);
    expect(await active(env)).toEqual([CORRECTED, 'a cat named Miso']);
    const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'recorded', recorded: 1, retracted: 1 });
  });

  it('the person restating it in their own turn brings it back', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);
    env.extract([DENVER_EXTRACTED]);
    await env.exchange('Actually I am relocating to Denver in November after all.', 'Got it.', 'r1');
    await env.idle();

    expect(extracted(env).map((r) => [r.value, r.source_role])).toEqual([
      ['Relocating to Denver in November', 'user'],
    ]);
    expect(await active(env)).toEqual([CORRECTED, 'Relocating to Denver in November']);
    expect(values(await env.feed())).toEqual(['Relocating to Denver in November']);
  });

  it('after an Undo of the Fix the value is no longer retracted, and a re-extraction is stored', async () => {
    vi.useFakeTimers();
    const env = await setup();
    const { notedId, correctionId } = await retracted(env);
    const { undone } = await env.h.uncorrect({ id: correctionId, restore: notedId }, env.ctx());
    expect(undone).toBe(true);

    env.extract([DENVER_EXTRACTED]);
    await env.exchange('When is my move again?', 'You are relocating to Denver in November.', 'r1');
    await env.idle();

    expect(extracted(env).map((r) => r.value)).toEqual(['Relocating to Denver in November']);
  });

  it('a Forget is not "never right": a re-extraction is stored', async () => {
    vi.useFakeTimers();
    const env = await setup();
    const old = env.h.ctx({ conversationId: OLD });
    await env.note(DENVER_NOTE, old);
    const [noted] = (await env.h.recall({ conversationId: OLD }, old)).statements;
    await env.h.forget({ ids: [noted!.id] }, old);

    env.extract([DENVER_EXTRACTED]);
    await env.exchange('When is my move again?', 'You are relocating to Denver in November.', 'r1');
    await env.idle();

    expect(extracted(env).map((r) => r.value)).toEqual(['Relocating to Denver in November']);
  });

  it('a Fix as "it changed" is not "never right" either: a re-extraction is stored', async () => {
    vi.useFakeTimers();
    const env = await setup();
    const old = env.h.ctx({ conversationId: OLD });
    await env.note(DENVER_NOTE, old);
    const [noted] = (await env.h.recall({ conversationId: OLD }, old)).statements;
    await env.h.correct(
      { id: noted!.id, about: 'user', relation: noted!.relation, value: CORRECTED, reason: 'changed' },
      old,
    );

    env.extract([DENVER_EXTRACTED]);
    await env.exchange('Where was I moving before?', 'You were relocating to Denver in November.', 'r1');
    await env.idle();

    expect(extracted(env).map((r) => r.value)).toEqual(['Relocating to Denver in November']);
  });

  // Scope: a SLOTTED value is the read side's (TASK-639 hides it on exact
  // `(about, slot)` + value; TASK-648 resurfaces the person's restatement).
  // The write-time check leaves it alone, so the two rules never disagree.
  it('a slotted retracted value is left to the read side: written, and hidden there', async () => {
    vi.useFakeTimers();
    const env = await setup();
    const old = env.h.ctx({ conversationId: OLD });
    await env.note({ about: 'user', relation: 'lives in', value: 'Denver, Colorado' }, old);
    const [noted] = (await env.h.recall({ conversationId: OLD }, old)).statements;
    await env.h.correct(
      { id: noted!.id, about: 'user', relation: noted!.relation, value: 'Boston, Massachusetts', reason: 'never-right' },
      old,
    );

    env.extract([{ subject: 'user', predicate: 'lives_in', object: 'Denver, Colorado' }]);
    await env.exchange('Where do I live?', 'You live in Denver, Colorado.', 'r1');
    await env.idle();

    expect(extracted(env).map((r) => [r.value, r.source_role])).toEqual([['Denver, Colorado', 'assistant']]);
    expect(values((await env.h.recall({ profile: true }, env.ctx())).statements)).toEqual([
      'Boston, Massachusetts',
    ]);
    const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'recorded', retracted: 0 });
  });

  // Review finding: the CONVERSATION read failing and the retracted check
  // then dropping every kept statement ends on `only-twins`, not `recorded`.
  // The failure must still be reported, with its cause.
  it('a failed conversation read is still reported when the retracted check drops everything', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);

    const bus = env.h.bus;
    const original = bus.call.bind(bus);
    bus.call = (async (name: string, c: AgentContext, input: unknown) => {
      const i = input as { about?: unknown; conversationId?: unknown } | undefined;
      if (name === 'memory:facts:recall' && i?.about !== undefined && i.conversationId === CONV) {
        throw new Error('conversation rows unavailable');
      }
      return original(name, c, input);
    }) as typeof bus.call;
    try {
      env.extract([DENVER_EXTRACTED]);
      await env.exchange('When is my move again?', 'You are relocating to Denver in November.', 'r1');
      await env.idle();
    } finally {
      bus.call = original;
    }

    expect(extracted(env)).toEqual([]);
    const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'skipped', reason: 'only-twins', retracted: 1 });
    const failed = eventsNamed(env.h.logs, OBSERVER_FAILED_EVENT).find(
      (e) => e.bindings.reason === 'twin-check-failed',
    );
    expect((failed?.bindings.err as Error | undefined)?.message).toBe('conversation rows unavailable');
  });

  it('the read fails open: the statement is kept, and the warning carries the cause', async () => {
    vi.useFakeTimers();
    const env = await setup();
    await retracted(env);

    const bus = env.h.bus;
    const original = bus.call.bind(bus);
    bus.call = (async (name: string, c: AgentContext, input: unknown) => {
      // The retracted-twin read is the only one naming neither a slot nor a conversation.
      const i = input as { slots?: unknown; conversationId?: unknown; activeOnly?: unknown } | undefined;
      if (
        name === 'memory:facts:recall' &&
        i?.activeOnly === false &&
        i.slots === undefined &&
        i.conversationId === undefined
      ) {
        throw new Error('owner rows unavailable');
      }
      return original(name, c, input);
    }) as typeof bus.call;
    try {
      env.extract([DENVER_EXTRACTED]);
      await env.exchange('When is my move again?', 'You are relocating to Denver in November.', 'r1');
      await env.idle();
    } finally {
      bus.call = original;
    }

    expect(extracted(env)).toHaveLength(1);
    const failed = eventsNamed(env.h.logs, OBSERVER_FAILED_EVENT).find(
      (e) => e.bindings.reason === 'twin-check-failed',
    );
    expect((failed?.bindings.err as Error | undefined)?.message).toBe('owner rows unavailable');
  });

  // TASK-661 — the LEGACY path: one extraction over `chat:end`'s own
  // messages (a turn with no conversation, a host without transcripts).
  // Those messages carry no turn ids, and before this card the facts carried
  // no `sourceRole` either, so the person's own restatement was read as an
  // unknown speaker and dropped — contrary to the TASK-648 ruling. The
  // speaker is now attributed there by the same word overlap.
  describe('on the legacy chat:end path', () => {
    /** A turn with no conversation: `chat:end` extracts over its own messages. */
    async function chatEnd(env: Env, user: string, assistant: string): Promise<void> {
      await env.h.bus.fire('chat:end', env.h.ctx(), {
        outcome: {
          kind: 'complete',
          messages: [
            { role: 'user', content: user },
            { role: 'assistant', content: assistant },
          ],
        },
      });
      await env.h.settleObserver();
    }

    it('the person restating it in their own message brings it back', async () => {
      const env = await setup();
      await retracted(env);
      env.extract([DENVER_EXTRACTED]);
      await chatEnd(env, 'Actually I am relocating to Denver in November after all.', 'Got it.');

      expect(extracted(env).map((r) => [r.value, r.source_role])).toEqual([
        ['Relocating to Denver in November', 'user'],
      ]);
      expect(await active(env)).toEqual([CORRECTED, 'Relocating to Denver in November']);
      const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
      expect(run?.bindings).toMatchObject({ outcome: 'recorded', recorded: 1, retracted: 0 });
    });

    // This test and the next are guards for the OTHER direction: they pass on
    // the unfixed code too (no role then meant dropped), and fail if the
    // speaker attribution ever credits the person with the agent's words.
    it("the agent's reply repeating it is not stored, and the value stays hidden", async () => {
      const env = await setup();
      await retracted(env);
      env.extract([DENVER_EXTRACTED]);
      await chatEnd(env, 'When is my move again?', 'You are relocating to Denver in November.');

      expect(extracted(env)).toEqual([]);
      expect(await active(env)).toEqual([CORRECTED]);
      const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
      expect(run?.bindings).toMatchObject({ outcome: 'skipped', reason: 'only-twins', retracted: 1 });
    });

    it('a paraphrase no message shares a word with has no known speaker, and stays hidden', async () => {
      const env = await setup();
      await retracted(env);
      // "relocating" and "denver" are in no message: no evidence of who said it.
      env.extract([{ subject: 'user', predicate: 'relocating_to', object: 'Denver in November' }]);
      await chatEnd(env, 'Anything planned for the autumn?', 'A few things, yes.');

      expect(extracted(env)).toEqual([]);
      expect(await active(env)).toEqual([CORRECTED]);
    });

    // The read side's slotted rule (TASK-648's `restatedByPerson`) reads the
    // same field, so the person's slotted restatement resurfaces here too.
    it('a slotted retracted value the person restates comes back on read', async () => {
      const env = await setup();
      const old = env.h.ctx({ conversationId: OLD });
      await env.note({ about: 'user', relation: 'lives in', value: 'Denver, Colorado' }, old);
      const [noted] = (await env.h.recall({ conversationId: OLD }, old)).statements;
      await env.h.correct(
        { id: noted!.id, about: 'user', relation: noted!.relation, value: 'Boston, Massachusetts', reason: 'never-right' },
        old,
      );

      // Dated after the Fix's correction (a correction is true from now).
      const validStart = new Date(Date.now() + 86_400_000).toISOString();
      env.extract([{ subject: 'user', predicate: 'lives_in', object: 'Denver, Colorado', validStart }]);
      await chatEnd(env, 'I live in Denver, Colorado, actually.', 'Thanks for telling me.');

      expect(extracted(env).map((r) => [r.value, r.source_role])).toEqual([['Denver, Colorado', 'user']]);
      expect(values((await env.h.recall({ profile: true }, env.ctx())).statements)).toEqual([
        'Denver, Colorado',
      ]);
    });

    it("a slotted retracted value the agent repeats stays hidden on read", async () => {
      const env = await setup();
      const old = env.h.ctx({ conversationId: OLD });
      await env.note({ about: 'user', relation: 'lives in', value: 'Denver, Colorado' }, old);
      const [noted] = (await env.h.recall({ conversationId: OLD }, old)).statements;
      await env.h.correct(
        { id: noted!.id, about: 'user', relation: noted!.relation, value: 'Boston, Massachusetts', reason: 'never-right' },
        old,
      );

      // Dated after the Fix too, so only the speaker keeps it hidden.
      const validStart = new Date(Date.now() + 86_400_000).toISOString();
      env.extract([{ subject: 'user', predicate: 'lives_in', object: 'Denver, Colorado', validStart }]);
      await chatEnd(env, 'Where do I live?', 'You live in Denver, Colorado.');

      expect(extracted(env).map((r) => [r.value, r.source_role])).toEqual([['Denver, Colorado', 'assistant']]);
      expect(values((await env.h.recall({ profile: true }, env.ctx())).statements)).toEqual([
        'Boston, Massachusetts',
      ]);
    });
  });
});
