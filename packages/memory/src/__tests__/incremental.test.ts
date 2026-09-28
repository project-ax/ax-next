import Database from 'better-sqlite3';
import { PluginError, type AgentContext, type LlmCallInput } from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NO_CREDENTIAL_EVENT, OBSERVER_FAILED_EVENT, OBSERVER_RUN_EVENT } from '../failure.js';
import { cursorKey } from '../incremental.js';
import { buildTurnRangeBatchKey } from '../observer.js';
import type { MemoryPluginConfig } from '../plugin.js';
import {
  ALICE,
  eventsNamed,
  makeMemoryHarness,
  type MemoryHarness,
  type MemoryHarnessOptions,
} from './harness.js';

/**
 * TASK-625 — extraction DURING a conversation.
 *
 * Driven end to end through the bus: `chat:turn-end` and `chat:end` fired
 * the way the host fires them, over the REAL sqlite engine, with a fake
 * `conversations:get` (the canonical transcript) and a fake `storage:*` (the
 * cursor store) — the two services that turn the incremental path on.
 */

let harness: MemoryHarness | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await harness?.teardown();
  harness = undefined;
});

const CONV = 'conv-1';
const UNKNOWN_CONV = 'conv-the-store-never-saw';
const IDLE_MS = 1_000;

interface FakeTurn {
  turnId: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'tool';
  contentBlocks: unknown[];
  createdAt: string;
}

interface Env {
  h: MemoryHarness;
  transcripts: Map<string, FakeTurn[]>;
  storage: Map<string, Uint8Array>;
  /** Make the next `n` storage:set calls throw. */
  failCursorWrites: (n: number) => void;
  /** Make the next `n` conversations:get calls throw. */
  failTranscriptReads: (n: number) => void;
  ctx: (opts?: { conversationId?: string; source?: 'routine' | 'user' }) => AgentContext;
  say: (role: 'user' | 'assistant' | 'tool', text: string, conv?: string, blocks?: unknown[]) => void;
  /** A user message and its reply, then the assistant turn-end. */
  exchange: (user: string, assistant: string, reqId: string, ctx?: AgentContext) => Promise<void>;
  chatEnd: (ctx?: AgentContext) => Promise<void>;
  /** The dialogue each extraction call saw, in order. */
  dialogues: () => string[];
  rows: () => Array<{
    value: string;
    source_turn_id: string | null;
    conversation_id: string | null;
    batch_key: string | null;
  }>;
}

/**
 * A stub extractor with a simple, inspectable rule: one fact per dialogue
 * line, its object the line's text. Context lines produce facts too — which
 * is the point: the observer, not the model, has to drop them.
 */
function perLineExtractor(input: LlmCallInput): { text: string; stopReason: 'end_turn'; usage: { inputTokens: number; outputTokens: number } } {
  const prompt = String(input.messages[0]?.content ?? '');
  const dialogue = prompt.split('Dialogue transcript:\n')[1] ?? '';
  const facts = dialogue
    .split('\n')
    .map((line) => /^(user|assistant): (.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      network: 'experience',
      subject: m[1],
      predicate: 'said',
      object: m[2],
      validStart: '2026-09-01T00:00:00Z',
      invalidatesPrevious: false,
    }));
  return { text: JSON.stringify({ facts }), stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
}

async function setup(
  config: MemoryPluginConfig = {},
  llm: MemoryHarnessOptions['llm'] = perLineExtractor,
): Promise<Env> {
  const h = await makeMemoryHarness(
    { incremental: { idleMs: IDLE_MS, everyUserTurns: 4 }, ...config },
    { llm },
  );
  harness = h;
  const transcripts = new Map<string, FakeTurn[]>();
  const storage = new Map<string, Uint8Array>();
  let cursorWriteFailures = 0;
  let transcriptReadFailures = 0;

  h.bus.registerService<{ conversationId: string; userId: string }, { conversation: unknown; turns: FakeTurn[] }>(
    'conversations:get',
    'fake-conversations',
    async (_ctx, input) => {
      if (transcriptReadFailures > 0) {
        transcriptReadFailures -= 1;
        throw new Error('transcript store unavailable');
      }
      if (input.conversationId === UNKNOWN_CONV) {
        throw new PluginError({
          code: 'not-found',
          plugin: 'fake-conversations',
          hookName: 'conversations:get',
          message: 'conversation not found',
        });
      }
      return { conversation: { title: null }, turns: [...(transcripts.get(input.conversationId) ?? [])] };
    },
  );
  h.bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
    'storage:get',
    'fake-storage',
    async (_ctx, { key }) => ({ value: storage.get(key) }),
  );
  h.bus.registerService<{ key: string; value: Uint8Array }, void>(
    'storage:set',
    'fake-storage',
    async (_ctx, { key, value }) => {
      if (cursorWriteFailures > 0) {
        cursorWriteFailures -= 1;
        throw new Error('storage unavailable');
      }
      storage.set(key, value);
    },
  );

  const ctx: Env['ctx'] = (opts = {}) =>
    h.ctx({ conversationId: opts.conversationId ?? CONV, ...(opts.source !== undefined ? { source: opts.source } : {}) });

  const say: Env['say'] = (role, text, conv = CONV, blocks) => {
    const turns = transcripts.get(conv) ?? [];
    turns.push({
      turnId: `${turns.length}`,
      turnIndex: turns.length,
      role,
      contentBlocks: blocks ?? [{ type: 'text', text }],
      createdAt: '2026-09-27T00:00:00Z',
    });
    transcripts.set(conv, turns);
  };

  return {
    h,
    transcripts,
    storage,
    failCursorWrites: (n) => {
      cursorWriteFailures = n;
    },
    failTranscriptReads: (n) => {
      transcriptReadFailures = n;
    },
    ctx,
    say,
    exchange: async (user, assistant, reqId, c = ctx()) => {
      say('user', user, c.conversationId);
      say('assistant', assistant, c.conversationId);
      await h.bus.fire('chat:turn-end', c, { role: 'assistant', reqId, reason: 'user-message-wait' });
    },
    chatEnd: async (c = ctx()) => {
      await h.bus.fire('chat:end', c, { outcome: { kind: 'complete', messages: [] } });
      await h.settleObserver();
    },
    dialogues: () =>
      h.llmCalls.map((call) => String(call.messages[0]?.content ?? '').split('Dialogue transcript:\n')[1] ?? ''),
    rows: () => {
      const db = new Database(h.databasePath, { readonly: true });
      try {
        return db
          .prepare('SELECT value, source_turn_id, conversation_id, batch_key FROM memory_facts_v1 ORDER BY rowid')
          .all() as ReturnType<Env['rows']>;
      } finally {
        db.close();
      }
    },
  };
}

async function idle(env: Env): Promise<void> {
  await vi.advanceTimersByTimeAsync(IDLE_MS);
  await env.h.settleObserver();
}

describe('an idle pause after a completed turn triggers a pass', () => {
  it('extracts the new turns once the conversation goes quiet, not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();

    await env.exchange('I moved to Boston last week.', 'Welcome to Boston!', 'req-1');
    await env.h.settleObserver();
    // Nothing yet: the turn returned, and the pass waits for the pause.
    expect(env.h.llmCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(env.h.llmCalls).toHaveLength(0);
    await idle(env);

    expect(env.h.llmCalls).toHaveLength(1);
    expect(env.rows().map((r) => r.value)).toEqual([
      'I moved to Boston last week.',
      'Welcome to Boston!',
    ]);
  });

  it('a later pass covers ONLY the new turns; its context turns yield no statements', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();

    await env.exchange('I moved to Boston last week.', 'Welcome to Boston!', 'req-1');
    await idle(env);
    await env.exchange('My sister lives in Paris.', 'Paris is lovely in spring.', 'req-2');
    await idle(env);

    expect(env.h.llmCalls).toHaveLength(2);
    // The second pass SAW the two earlier turns as context, so references
    // resolve …
    expect(env.dialogues()[1]).toBe(
      [
        'user: I moved to Boston last week.',
        'assistant: Welcome to Boston!',
        'user: My sister lives in Paris.',
        'assistant: Paris is lovely in spring.',
      ].join('\n'),
    );
    // … and the stub extracted a fact from every line, context included, but
    // only the NEW turns' facts were stored: no Boston twice.
    expect(env.rows().map((r) => r.value)).toEqual([
      'I moved to Boston last week.',
      'Welcome to Boston!',
      'My sister lives in Paris.',
      'Paris is lovely in spring.',
    ]);
    const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ outcome: 'recorded', trigger: 'idle', contextOnly: 2 });
  });

  it('shows at most two context turns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('Alpha one.', 'Alpha two.', 'req-1');
    await env.exchange('Bravo one.', 'Bravo two.', 'req-2');
    await idle(env);
    await env.exchange('Charlie one.', 'Charlie two.', 'req-3');
    await idle(env);
    expect(env.dialogues()[1]).toBe(
      ['user: Bravo one.', 'assistant: Bravo two.', 'user: Charlie one.', 'assistant: Charlie two.'].join('\n'),
    );
  });

  it('each new turn resets the pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('First thing.', 'Noted first.', 'req-1');
    await vi.advanceTimersByTimeAsync(IDLE_MS - 10);
    await env.exchange('Second thing.', 'Noted second.', 'req-2');
    await vi.advanceTimersByTimeAsync(IDLE_MS - 10);
    expect(env.h.llmCalls).toHaveLength(0);
    await idle(env);
    // ONE pass over both exchanges, not one per turn.
    expect(env.h.llmCalls).toHaveLength(1);
    expect(env.rows()).toHaveLength(4);
  });
});

describe('every N completed user turns triggers a pass', () => {
  it('fires on the Nth user turn without waiting for the pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup({ incremental: { idleMs: 60 * 60_000, everyUserTurns: 2 } });

    await env.exchange('Turn one about kayaks.', 'Kayaks are fun.', 'req-1');
    await env.h.settleObserver();
    expect(env.h.llmCalls).toHaveLength(0);
    await env.exchange('Turn two about canoes.', 'Canoes too.', 'req-2');
    await env.h.settleObserver();

    expect(env.h.llmCalls).toHaveLength(1);
    expect(env.rows()).toHaveLength(4);
    const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ trigger: 'turns' });
  });

  it('counts a user message once, however many assistant turns answer it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup({ incremental: { idleMs: 60 * 60_000, everyUserTurns: 2 } });

    await env.exchange('One long question about tides.', 'Part one on tides.', 'req-1');
    env.say('assistant', 'Part two on tides.');
    await env.h.bus.fire('chat:turn-end', env.ctx(), { role: 'assistant', reqId: 'req-1', reason: 'user-message-wait' });
    // Tool turns and heartbeats are not replies at all.
    await env.h.bus.fire('chat:turn-end', env.ctx(), { role: 'tool', reqId: 'req-1', reason: 'user-message-wait' });
    await env.h.bus.fire('chat:turn-end', env.ctx(), { reason: 'user-message-wait' });
    await env.h.settleObserver();

    expect(env.h.llmCalls).toHaveLength(0);
  });
});

describe('chat:end extracts only what remains', () => {
  it('covers the turns after the last pass, and nothing an earlier pass covered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup({ incremental: { idleMs: 60 * 60_000, everyUserTurns: 2 } });

    await env.exchange('Turn one about kayaks.', 'Kayaks are fun.', 'req-1');
    await env.exchange('Turn two about canoes.', 'Canoes too.', 'req-2');
    await env.h.settleObserver();
    await env.exchange('Turn three about rafts.', 'Rafts float.', 'req-3');
    await env.chatEnd();

    expect(env.h.llmCalls).toHaveLength(2);
    expect(env.dialogues()[1]).toBe(
      [
        'user: Turn two about canoes.',
        'assistant: Canoes too.',
        'user: Turn three about rafts.',
        'assistant: Rafts float.',
      ].join('\n'),
    );
    expect(env.rows().map((r) => r.value)).toEqual([
      'Turn one about kayaks.',
      'Kayaks are fun.',
      'Turn two about canoes.',
      'Canoes too.',
      'Turn three about rafts.',
      'Rafts float.',
    ]);
    const run = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(run?.bindings).toMatchObject({ trigger: 'chat-end' });
  });

  it('after an idle pass covered everything, chat:end makes no call at all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    await idle(env);
    await env.chatEnd();
    expect(env.h.llmCalls).toHaveLength(1);
    const skipped = eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1);
    expect(skipped?.bindings).toMatchObject({ outcome: 'skipped', reason: 'no-new-turns', trigger: 'chat-end' });
  });

  it('cancels the pending idle pass, so the conversation is extracted once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    await env.chatEnd();
    await idle(env);
    expect(env.h.llmCalls).toHaveLength(1);
    expect(env.rows()).toHaveLength(2);
  });

  it('takes a trailing unanswered user turn at chat:end, but an idle pass leaves it for its reply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    // The next message is already persisted when the pause fires, but has no
    // reply yet: it is not a completed turn.
    env.say('user', 'Also I adopted a beagle.');
    await idle(env);
    expect(env.dialogues()[0]).not.toContain('beagle');

    await env.chatEnd();
    expect(env.dialogues()[1]).toContain('user: Also I adopted a beagle.');
    expect(env.rows().map((r) => r.value)).toContain('Also I adopted a beagle.');
  });
});

describe('chat:end on a conversation with no canonical transcript', () => {
  const MESSAGES = [
    { role: 'user', content: 'I moved to Boston.' },
    { role: 'assistant', content: 'Welcome to Boston!' },
  ];

  it('falls back to its own messages when the store has never heard of the conversation', async () => {
    const env = await setup();
    await env.h.bus.fire('chat:end', env.ctx({ conversationId: UNKNOWN_CONV }), {
      outcome: { kind: 'complete', messages: MESSAGES },
    });
    await env.h.settleObserver();
    expect(env.h.llmCalls).toHaveLength(1);
    expect(env.rows().map((r) => [r.value, r.source_turn_id, r.conversation_id])).toEqual([
      ['I moved to Boston.', null, UNKNOWN_CONV],
      ['Welcome to Boston!', null, UNKNOWN_CONV],
    ]);
    expect(eventsNamed(env.h.logs, OBSERVER_FAILED_EVENT)).toHaveLength(0);
  });

  it('falls back to its own messages when the transcript is empty', async () => {
    const env = await setup();
    await env.h.bus.fire('chat:end', env.ctx({ conversationId: 'conv-empty' }), {
      outcome: { kind: 'complete', messages: MESSAGES },
    });
    await env.h.settleObserver();
    expect(env.rows()).toHaveLength(2);
  });

  it('ignores its own messages when the transcript has the turns — they would be recorded twice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    await idle(env);
    await env.h.bus.fire('chat:end', env.ctx(), { outcome: { kind: 'complete', messages: MESSAGES } });
    await env.h.settleObserver();
    expect(env.h.llmCalls).toHaveLength(1);
    expect(env.rows()).toHaveLength(2);
  });
});

describe('overlapping and repeated passes never double-record', () => {
  it('two chat:end fires and a pending idle pass store every fact once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    await Promise.all([
      env.h.bus.fire('chat:end', env.ctx(), { outcome: { kind: 'complete', messages: [] } }),
      env.h.bus.fire('chat:end', env.ctx(), { outcome: { kind: 'complete', messages: [] } }),
      vi.advanceTimersByTimeAsync(IDLE_MS),
    ]);
    await env.h.settleObserver();
    expect(env.rows()).toHaveLength(2);
  });

  it('a lost cursor write: the batch still reads as recorded, nothing is re-extracted, and storage catches up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    env.failCursorWrites(1);
    await idle(env);
    // The batch landed, the cursor did not — and the log says BOTH: a
    // recorded batch, and a cursor failure on its own reason, not a generic
    // observer failure that would make a stored batch read as a lost one.
    expect(env.rows()).toHaveLength(2);
    expect(eventsNamed(env.h.logs, OBSERVER_FAILED_EVENT).map((e) => e.bindings)).toEqual([
      expect.objectContaining({ reason: 'cursor-write-failed', trigger: 'idle' }),
    ]);
    expect(eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1)?.bindings).toMatchObject({
      outcome: 'recorded',
      recorded: 2,
      trigger: 'idle',
    });

    expect(env.storage.has(cursorKey(CONV))).toBe(false);

    await env.chatEnd();
    // The position was carried in-process: no second extraction, no second
    // copy — and the no-new-turns pass paid the durable write it owed.
    expect(env.h.llmCalls).toHaveLength(1);
    expect(env.rows()).toHaveLength(2);
    expect(JSON.parse(new TextDecoder().decode(env.storage.get(cursorKey(CONV))))).toEqual({ next: 2 });
  });

  it('a carried cursor keeps chat:end off the no-transcript fallback when the transcript read comes back empty', async () => {
    // The fallback is safe only while nothing was ever covered. A covered
    // range whose durable write was lost must still count as covered, or
    // chat:end would re-extract its own messages under the legacy key.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    env.failCursorWrites(1);
    await idle(env);
    env.transcripts.delete(CONV);
    await env.h.bus.fire('chat:end', env.ctx(), {
      outcome: {
        kind: 'complete',
        messages: [
          { role: 'user', content: 'I moved to Boston.' },
          { role: 'assistant', content: 'Welcome to Boston!' },
        ],
      },
    });
    await env.h.settleObserver();
    expect(env.h.llmCalls).toHaveLength(1);
    expect(env.rows()).toHaveLength(2);
  });

  it('a pass that re-runs over the SAME range is an engine no-op under the range key', async () => {
    // What a host restart after a lost cursor write looks like when nothing
    // was said since: the stored cursor is behind, and the pass repeats.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    await idle(env);
    env.storage.delete(cursorKey(CONV));
    await env.chatEnd();
    expect(env.h.llmCalls).toHaveLength(2);
    expect(env.rows()).toHaveLength(2);
    expect(new Set(env.rows().map((r) => r.batch_key))).toEqual(
      new Set([
        buildTurnRangeBatchKey({ conversationId: CONV, ownerUserId: ALICE, firstTurnId: '0', lastTurnId: '1' }),
      ]),
    );
  });

  it('a lost cursor write followed by MORE turns does not re-record the covered ones', async () => {
    // The range key alone cannot save this case: the next pass would cover
    // [0..3], a different range and so a different key, and store turns 0-1
    // a second time. The in-process cursor carries the position across.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    env.failCursorWrites(1);
    await idle(env);
    await env.exchange('My sister lives in Paris.', 'Paris is lovely.', 'req-2');
    await idle(env);

    expect(env.rows().map((r) => r.value)).toEqual([
      'I moved to Boston.',
      'Welcome to Boston!',
      'My sister lives in Paris.',
      'Paris is lovely.',
    ]);
    // And the durable cursor caught up on the write that worked.
    expect(JSON.parse(new TextDecoder().decode(env.storage.get(cursorKey(CONV))))).toEqual({ next: 4 });
  });

  it('keeps the cursor in storage, so a restarted host resumes instead of starting over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    await idle(env);
    const cursor = env.storage.get(cursorKey(CONV));
    expect(JSON.parse(new TextDecoder().decode(cursor))).toEqual({ next: 2 });
  });

  it('refuses an unreadable cursor rather than re-extracting the whole conversation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    env.storage.set(cursorKey(CONV), new TextEncoder().encode('not json'));
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    await idle(env);
    expect(env.h.llmCalls).toHaveLength(0);
    expect(env.rows()).toHaveLength(0);
    expect(eventsNamed(env.h.logs, OBSERVER_FAILED_EVENT)).toHaveLength(1);
  });

  it('a failed transcript read reports, keeps the cursor, and the next pass takes the turns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    env.failTranscriptReads(1);
    await idle(env);
    expect(eventsNamed(env.h.logs, OBSERVER_FAILED_EVENT)).toHaveLength(1);
    expect(env.storage.has(cursorKey(CONV))).toBe(false);

    await env.chatEnd();
    expect(env.rows()).toHaveLength(2);
  });
});

describe('every statement records the turn it came from', () => {
  it('points a user fact at the user turn and an assistant fact at the assistant turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    await env.exchange('I moved to Boston.', 'I recommend the Fenway walking tour.', 'req-1');
    await env.exchange('My sister lives in Paris.', 'Try the Louvre at opening time.', 'req-2');
    await idle(env);
    expect(env.rows().map((r) => [r.value, r.source_turn_id])).toEqual([
      ['I moved to Boston.', '0'],
      ['I recommend the Fenway walking tour.', '1'],
      ['My sister lives in Paris.', '2'],
      ['Try the Louvre at opening time.', '3'],
    ]);
  });

  it('keeps TASK-616: a routine turn is stored with no conversation, and still with its source turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    const routine = env.ctx({ conversationId: 'conv-routine', source: 'routine' });
    await env.exchange('Reflect on deploy procedures.', 'Run migrations, then restart workers.', 'req-1', routine);
    await env.chatEnd(routine);
    const rows = env.rows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.conversation_id === null)).toBe(true);
    expect(rows.map((r) => r.source_turn_id)).toEqual(['0', '1']);
    // The batch identity still carries the real conversation.
    expect(rows[0]?.batch_key).toBe(
      buildTurnRangeBatchKey({ conversationId: 'conv-routine', ownerUserId: ALICE, firstTurnId: '0', lastTurnId: '1' }),
    );
  });
});

describe('the incremental path reads user and assistant TEXT only', () => {
  it('never sends a tool turn, a tool result, an attachment or a thinking block to the extractor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup();
    env.say('user', '', CONV, [
      { type: 'text', text: 'Summarize the attached file.' },
      { type: 'attachment', path: 'x.txt', text: 'ATTACHMENT-BODY' },
    ]);
    env.say('tool', '', CONV, [{ type: 'tool_result', toolUseId: 't1', content: 'TOOL-OUTPUT' }]);
    env.say('assistant', '', CONV, [
      { type: 'thinking', thinking: 'THINKING-TEXT' },
      { type: 'tool_use', id: 't1', name: 'read', input: { path: 'TOOL-INPUT' } },
      { type: 'text', text: 'It is a grocery list.' },
    ]);
    await env.h.bus.fire('chat:turn-end', env.ctx(), { role: 'assistant', reqId: 'req-1', reason: 'user-message-wait' });
    await idle(env);

    expect(env.dialogues()).toEqual([
      ['user: Summarize the attached file.', 'assistant: It is a grocery list.'].join('\n'),
    ]);
    const wire = JSON.stringify(env.h.llmCalls);
    for (const leaked of ['ATTACHMENT-BODY', 'TOOL-OUTPUT', 'THINKING-TEXT', 'TOOL-INPUT']) {
      expect(wire).not.toContain(leaked);
    }
  });
});

describe('the paused state', () => {
  it('an incremental pass makes no call for a paused user; chat:end still tries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup({}, () => {
      throw new PluginError({
        code: 'no-openrouter-credential',
        plugin: '@ax/llm-openrouter',
        message: 'no credential resolved for openrouter',
      });
    });
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    await idle(env);
    // The first pass discovers the missing key and pauses the user.
    expect(env.h.llmCalls).toHaveLength(1);
    expect(eventsNamed(env.h.logs, NO_CREDENTIAL_EVENT)).toHaveLength(1);

    await env.exchange('My sister lives in Paris.', 'Paris is lovely.', 'req-2');
    await idle(env);
    // Paused: skipped without a call, and without another error line.
    expect(env.h.llmCalls).toHaveLength(1);
    expect(eventsNamed(env.h.logs, OBSERVER_RUN_EVENT).at(-1)?.bindings).toMatchObject({
      outcome: 'skipped',
      reason: 'paused',
      trigger: 'idle',
    });

    await env.chatEnd();
    // chat:end always tries — only a resolved call can clear the pause —
    // and the turns the paused passes left are all still there to take.
    expect(env.h.llmCalls).toHaveLength(2);
    expect(env.dialogues()[1]).toContain('Boston');
    expect(env.dialogues()[1]).toContain('Paris');
  });
});

describe('without the transcript and cursor store, nothing changes', () => {
  it('a turn-end starts no pass, and chat:end extracts its own messages exactly as before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = await makeMemoryHarness(
      { incremental: { idleMs: IDLE_MS, everyUserTurns: 1 } },
      { llm: perLineExtractor },
    );
    harness = h;
    const ctx = h.ctx({ conversationId: CONV });
    await h.bus.fire('chat:turn-end', ctx, { role: 'assistant', reqId: 'req-1', reason: 'user-message-wait' });
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    await h.settleObserver();
    expect(h.llmCalls).toHaveLength(0);

    await h.bus.fire('chat:end', ctx, {
      outcome: {
        kind: 'complete',
        messages: [
          { role: 'user', content: 'I moved to Boston.' },
          { role: 'assistant', content: 'Welcome!' },
        ],
      },
    });
    await h.settleObserver();
    expect(h.llmCalls).toHaveLength(1);
  });

  it('`incremental: false` keeps the chat:end-only path even when both services exist', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup({ incremental: false });
    await env.exchange('I moved to Boston.', 'Welcome to Boston!', 'req-1');
    await idle(env);
    expect(env.h.llmCalls).toHaveLength(0);
    await env.h.bus.fire('chat:end', env.ctx(), {
      outcome: { kind: 'complete', messages: [{ role: 'user', content: 'I moved to Boston.' }] },
    });
    await env.h.settleObserver();
    expect(env.h.llmCalls).toHaveLength(1);
    expect(env.rows().every((r) => r.source_turn_id === null)).toBe(true);
  });
});

describe('cost: one extraction call per trigger', () => {
  it('a 10-exchange conversation with N=4 costs 3 calls (turns, turns, chat:end)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const env = await setup({ incremental: { idleMs: 60 * 60_000, everyUserTurns: 4 } });
    for (let i = 1; i <= 10; i++) {
      await env.exchange(`Question ${i} about topic${i}.`, `Answer ${i} about topic${i}.`, `req-${i}`);
      // A person takes longer to type than a pass takes to run.
      await env.h.settleObserver();
    }
    await env.chatEnd();
    expect(env.h.llmCalls).toHaveLength(3);
    expect(env.rows()).toHaveLength(20);
    expect(new Set(env.rows().map((r) => r.value)).size).toBe(20);
  });
});
