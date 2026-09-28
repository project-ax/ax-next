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
  // hidden per-fire conversation.
  it('a routine run carries no conversation, so nothing is checked (TASK-616 scope)', async () => {
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
