import { HookBus, PluginError, makeAgentContext, type AgentContext, type LlmCallInput } from '@ax/core';
import { afterEach, describe, expect, it } from 'vitest';

import { MEMORY_CONVERSATION_ACTIVITY_HOOK } from '../activity.js';
import { createMemoryPlugin } from '../plugin.js';
import type {
  MemoryConversationActivity,
  MemoryRecallOutput,
  MemoryStatusOutput,
} from '../types.js';
import {
  ALICE,
  BOB,
  engineRecall,
  makeMemoryHarness,
  registerMemoryAgents,
  type MemoryHarness,
  type MemoryHarnessOptions,
} from './harness.js';

/**
 * TASK-626 — the per-conversation memory feed ("What I learned in this chat").
 *
 * Three pieces, all read by the same later rail block:
 *
 * - `memory:recall({ conversationId })` — the rows ONE conversation produced,
 *   always owner-scoped to the caller, each carrying the display-log turn id
 *   it came from;
 * - `memory:conversation-activity` — extracting / recorded / idle / failed /
 *   paused, fired around each incremental pass, ids only, never text;
 * - `memory:status({ conversationId })` — the same tracker, read back.
 */

// ---------------------------------------------------------------------------
// memory:recall({ conversationId }) — what goes down the wire (stub engine).
// ---------------------------------------------------------------------------

function stubCtx(userId = ALICE): AgentContext {
  return makeAgentContext({
    sessionId: 's',
    agentId: 'agent-1',
    userId,
    workspace: { rootPath: '/tmp' },
  });
}

async function stubEngine(
  statements: unknown[] = [],
  visibility: 'personal' | 'team' = 'personal',
): Promise<{ bus: HookBus; recalls: Array<Record<string, unknown>> }> {
  const bus = new HookBus();
  const recalls: Array<Record<string, unknown>> = [];
  bus.registerService('memory:facts:recall', 'stub', async (_c: AgentContext, input: unknown) => {
    recalls.push(input as Record<string, unknown>);
    return { statements, degraded: [] };
  });
  bus.registerService('memory:facts:record', 'stub', async () => ({ records: [] }));
  bus.registerService('memory:facts:supersede', 'stub', async () => ({}));
  bus.registerService('tool:register', 'stub-catalog', async () => ({}));
  registerMemoryAgents(bus, { visibility });
  await createMemoryPlugin().init({ bus, config: {} });
  return { bus, recalls };
}

describe('memory:recall({ conversationId })', () => {
  it.each(['personal', 'team'] as const)(
    'pushes the conversation AND the caller as owner down to the engine on a %s agent',
    async (visibility) => {
      const { bus, recalls } = await stubEngine([], visibility);
      await bus.call('memory:recall', stubCtx(), { conversationId: 'conv-1' });
      // A team agent's ordinary read omits the owner filter (shared
      // knowledge). A conversation belongs to one person, so this read never
      // does — a teammate's conversation id answers nothing.
      expect(recalls[0]).toMatchObject({ conversationId: 'conv-1', ownerUserId: ALICE });
    },
  );

  it('an ordinary team read still omits the owner filter', async () => {
    const { bus, recalls } = await stubEngine([], 'team');
    await bus.call('memory:recall', stubCtx(), {});
    expect(recalls[0]).not.toHaveProperty('ownerUserId');
    expect(recalls[0]).not.toHaveProperty('conversationId');
  });

  it.each([
    ['an empty string', { conversationId: '' }],
    ['whitespace', { conversationId: '   ' }],
    ['a non-string', { conversationId: 7 }],
    ['with query', { conversationId: 'conv-1', query: 'boston' }],
    ['with profile', { conversationId: 'conv-1', profile: true }],
  ])('refuses %s as invalid-payload, before the engine is asked', async (_label, input) => {
    const { bus, recalls } = await stubEngine();
    await expect(bus.call('memory:recall', stubCtx(), input)).rejects.toMatchObject({
      code: 'invalid-payload',
    });
    expect(recalls).toHaveLength(0);
  });
});

describe('MemoryStatement.sourceTurnId', () => {
  const row = {
    id: 'f1',
    about: 'user:user-alice',
    relation: 'lives in',
    value: 'Boston',
    when: '2026-09-01T00:00:00Z',
  };

  it('passes a non-empty string through', async () => {
    const { bus } = await stubEngine([{ ...row, sourceTurnId: 'turn-7' }]);
    const out = await bus.call<unknown, MemoryRecallOutput>('memory:recall', stubCtx(), {});
    expect(out.statements[0]?.sourceTurnId).toBe('turn-7');
  });

  it.each([
    ['absent', {}],
    ['empty', { sourceTurnId: '' }],
    ['not a string', { sourceTurnId: 7 }],
  ])('omits the key when the engine row has it %s', async (_label, extra) => {
    const { bus } = await stubEngine([{ ...row, ...extra }]);
    const out = await bus.call<unknown, MemoryRecallOutput>('memory:recall', stubCtx(), {});
    expect(out.statements[0]).not.toHaveProperty('sourceTurnId');
  });
});

// ---------------------------------------------------------------------------
// memory:conversation-activity — driven through chat:end over the real engine.
// ---------------------------------------------------------------------------

const CONV = 'conv-1';

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

function reply(text: string): {
  text: string;
  stopReason: 'end_turn';
  usage: { inputTokens: number; outputTokens: number };
} {
  return { text, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
}

/** One fact per dialogue line, its object the line's text. */
function perLine(input: LlmCallInput): ReturnType<typeof reply> {
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
  return reply(JSON.stringify({ facts }));
}

interface Env {
  h: MemoryHarness;
  events: MemoryConversationActivity[];
  say: (role: 'user' | 'assistant', text: string) => void;
  chatEnd: (ctx?: AgentContext) => Promise<void>;
  ctx: (opts?: { userId?: string; source?: 'routine' | 'user' }) => AgentContext;
  status: (ctx: AgentContext, input?: unknown) => Promise<MemoryStatusOutput>;
}

async function setup(
  llm: MemoryHarnessOptions['llm'],
  config: { observerTimeoutMs?: number } = {},
): Promise<Env> {
  // A team agent so Bob is a real member whose status reads are meaningful.
  const h = await makeMemoryHarness(
    // idleMs is far away: these tests drive passes through chat:end only.
    { incremental: { idleMs: 600_000, everyUserTurns: 100 }, ...config },
    { llm, agent: { visibility: 'team' } },
  );
  harness = h;
  const turns: Array<{ turnId: string; turnIndex: number; role: string; contentBlocks: unknown[]; createdAt: string }> = [];
  h.bus.registerService('conversations:get', 'fake-conversations', async () => ({
    conversation: { title: null },
    turns: [...turns],
  }));
  const storage = new Map<string, Uint8Array>();
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
  const events: MemoryConversationActivity[] = [];
  h.bus.subscribe<MemoryConversationActivity>(
    MEMORY_CONVERSATION_ACTIVITY_HOOK,
    'test-listener',
    async (_c, payload) => {
      events.push(payload);
      return undefined;
    },
  );
  const ctx: Env['ctx'] = (opts = {}) =>
    h.ctx({
      conversationId: CONV,
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
      ...(opts.source !== undefined ? { source: opts.source } : {}),
    });
  return {
    h,
    events,
    ctx,
    say: (role, text) => {
      turns.push({
        turnId: `t${turns.length}`,
        turnIndex: turns.length,
        role,
        contentBlocks: [{ type: 'text', text }],
        createdAt: '2026-09-27T00:00:00Z',
      });
    },
    chatEnd: async (c = ctx()) => {
      await h.bus.fire('chat:end', c, { outcome: { kind: 'complete', messages: [] } });
      await h.settleObserver();
    },
    status: (c, input = {}) => h.bus.call<unknown, MemoryStatusOutput>('memory:status', c, input),
  };
}

function states(events: readonly MemoryConversationActivity[]): string[] {
  return events.map((e) => e.state);
}

describe('memory:conversation-activity', () => {
  it('a pass that records fires extracting then recorded, once, with the written ids and no text', async () => {
    const env = await setup(perLine);
    env.say('user', 'I moved to Boston last week.');
    env.say('assistant', 'Welcome to Boston!');
    await env.chatEnd();

    expect(states(env.events)).toEqual(['extracting', 'recorded']);
    expect(env.events[0]).toEqual({ conversationId: CONV, userId: ALICE, state: 'extracting' });

    const stored = await engineRecall(env.h.bus, env.ctx(), { limit: 100, ownerUserId: ALICE });
    const recorded = env.events[1]!;
    expect(Object.keys(recorded).sort()).toEqual(['conversationId', 'state', 'statementIds', 'userId']);
    expect([...recorded.statementIds!].sort()).toEqual(stored.statements.map((s) => s.id).sort());
    expect(recorded.statementIds).toHaveLength(2);
    // Ids only — nothing a subscriber could log that a person said.
    expect(JSON.stringify(env.events)).not.toMatch(/Boston/);

    // The recorded rows carry the display-log turn they came from.
    const feed = await env.h.recall({ conversationId: CONV }, env.ctx());
    expect(feed.statements.map((s) => s.sourceTurnId).sort()).toEqual(['t0', 't1']);
  });

  it('a pass with no new turns fires nothing', async () => {
    const env = await setup(perLine);
    env.say('user', 'I moved to Boston last week.');
    env.say('assistant', 'Welcome to Boston!');
    await env.chatEnd();
    env.events.length = 0;

    await env.chatEnd();
    expect(env.events).toEqual([]);
  });

  it('a pass whose extractor finds nothing fires extracting then idle', async () => {
    const env = await setup(() => reply(JSON.stringify({ facts: [] })));
    env.say('user', 'Hello.');
    env.say('assistant', 'Hi.');
    await env.chatEnd();
    expect(states(env.events)).toEqual(['extracting', 'idle']);
    expect(env.events[1]).not.toHaveProperty('statementIds');
  });

  it('a pass that times out fires extracting then idle', async () => {
    const env = await setup(() => new Promise(() => undefined), { observerTimeoutMs: 20 });
    env.say('user', 'I moved to Boston last week.');
    env.say('assistant', 'Welcome to Boston!');
    await env.chatEnd();
    expect(states(env.events)).toEqual(['extracting', 'idle']);
  });

  it('a pass that throws fires extracting then failed, and status says failed for that user only', async () => {
    const env = await setup(() => {
      throw new Error('upstream 504');
    });
    env.say('user', 'I moved to Boston last week.');
    env.say('assistant', 'Welcome to Boston!');
    await env.chatEnd();

    expect(states(env.events)).toEqual(['extracting', 'failed']);
    expect(await env.status(env.ctx(), { conversationId: CONV })).toEqual({
      extraction: 'ok',
      conversation: { state: 'failed' },
    });
    expect(await env.status(env.ctx({ userId: BOB }), { conversationId: CONV })).toEqual({
      extraction: 'ok',
      conversation: { state: 'idle' },
    });
  });

  it('a missing credential fires extracting then paused, and status reports the pause', async () => {
    const env = await setup(() => {
      throw new PluginError({
        code: 'no-openrouter-credential',
        plugin: '@ax/llm-openrouter',
        message: 'no credential resolved for openrouter',
      });
    });
    env.say('user', 'I moved to Boston last week.');
    env.say('assistant', 'Welcome to Boston!');
    await env.chatEnd();

    expect(states(env.events)).toEqual(['extracting', 'paused']);
    expect(await env.status(env.ctx(), { conversationId: CONV })).toEqual({
      extraction: 'paused',
      reason: 'missing-credential',
      conversation: { state: 'idle' },
    });
  });

  it('memory:status reports extracting while the pass is running', async () => {
    let during: MemoryStatusOutput | undefined;
    const ref: { env?: Env } = {};
    const env = await setup(async (input) => {
      during = await ref.env!.status(ref.env!.ctx(), { conversationId: CONV });
      return perLine(input);
    });
    ref.env = env;
    env.say('user', 'I moved to Boston last week.');
    env.say('assistant', 'Welcome to Boston!');
    await env.chatEnd();

    expect(during).toEqual({ extraction: 'ok', conversation: { state: 'extracting' } });
    expect(await env.status(env.ctx(), { conversationId: CONV })).toEqual({
      extraction: 'ok',
      conversation: { state: 'idle' },
    });
  });

  it('a routine run fires nothing', async () => {
    const env = await setup(perLine);
    env.say('user', 'I moved to Boston last week.');
    env.say('assistant', 'Welcome to Boston!');
    await env.chatEnd(env.ctx({ source: 'routine' }));
    // The pass itself still ran and stored rows (design §3.2).
    expect(env.h.llmCalls).toHaveLength(1);
    expect(env.events).toEqual([]);
  });
});

describe('memory:status({ conversationId })', () => {
  it('omits conversation when none is asked about, as before', async () => {
    const env = await setup(perLine);
    expect(await env.status(env.ctx())).toEqual({ extraction: 'ok' });
    expect(await env.status(env.ctx(), undefined)).toEqual({ extraction: 'ok' });
  });

  it.each([
    ['an empty string', ''],
    ['a non-string', 7],
  ])('refuses %s as invalid-payload', async (_label, conversationId) => {
    const env = await setup(perLine);
    await expect(env.status(env.ctx(), { conversationId })).rejects.toMatchObject({
      code: 'invalid-payload',
    });
  });
});
