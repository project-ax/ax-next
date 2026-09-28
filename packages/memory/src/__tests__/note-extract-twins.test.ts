import Database from 'better-sqlite3';
import type { AgentContext, LlmCallInput } from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OBSERVER_FAILED_EVENT, OBSERVER_RUN_EVENT } from '../failure.js';
import { MEMORY_NOTE_TOOL_HOOK, type MemoryNoteResult } from '../note-tool.js';
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
  rows: () => Array<{ relation: string; value: string; provenance: string }>;
}

async function setup(): Promise<Env> {
  let facts: Fact[] = [];
  const llm = (_input: LlmCallInput) => ({
    text: JSON.stringify({
      facts: facts.map((f) => ({
        network: 'experience',
        ...f,
        validStart: '2026-09-01T00:00:00Z',
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
          .prepare('SELECT relation, value, provenance FROM memory_facts_v1 ORDER BY rowid')
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
    expect(
      eventsNamed(env.h.logs, OBSERVER_FAILED_EVENT).some((e) => e.bindings.reason === 'twin-check-failed'),
    ).toBe(true);
  });
});
