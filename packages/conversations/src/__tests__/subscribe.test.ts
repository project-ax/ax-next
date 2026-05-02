import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError, type AgentContext } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  AppendTurnInput,
  AppendTurnOutput,
  CreateInput,
  CreateOutput,
  FetchHistoryInput,
  FetchHistoryOutput,
  GetMetadataInput,
  GetMetadataOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// chat:turn-end subscriber test (Phase D, Task 5).
//
// Phase D collapses transcript persistence: the runner's native jsonl is the
// source of truth, NOT the host's `conversation_turns` rows. The subscriber
// no longer calls `conversations:append-turn` — it only bumps
// `last_activity_at` so sidebar ordering still reflects user-visible
// activity (I8).
//
// We exercise the subscriber via `bus.fire('chat:turn-end', ...)` and assert
// on three things:
//   1. `last_activity_at` is bumped on non-heartbeat turn-ends.
//   2. `conversations:append-turn` is NEVER called from the subscriber path.
//   3. Heartbeats stay no-ops (no bump, no row).
// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

interface ResolvePolicy {
  decide(call: { agentId: string; userId: string }):
    | 'allow'
    | 'forbid'
    | 'notfound';
}

interface CallSpy {
  calls: Array<{ hookName: string; ctx: AgentContext; input: unknown }>;
}

async function makeHarness(
  policy: ResolvePolicy = { decide: () => 'allow' },
): Promise<TestHarness & { spy: CallSpy }> {
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: { id: string; visibility: string } }> => {
        const call = input as { agentId: string; userId: string };
        const decision = policy.decide(call);
        if (decision === 'allow') {
          return {
            agent: { id: call.agentId, visibility: 'personal' },
          };
        }
        if (decision === 'notfound') {
          throw new PluginError({
            code: 'not-found',
            plugin: 'mock-agents',
            hookName: 'agents:resolve',
            message: `agent '${call.agentId}' not found`,
          });
        }
        throw new PluginError({
          code: 'forbidden',
          plugin: 'mock-agents',
          hookName: 'agents:resolve',
          message: `agent '${call.agentId}' forbidden for '${call.userId}'`,
        });
      },
      // conversations:get is unused by these tests, but the manifest
      // declares `workspace:list` + `workspace:read` as required calls,
      // so bootstrap fails fast without a registrant for them. Stub
      // both with empty defaults — Phase D's transcript-from-workspace
      // path is exercised in get.test.ts.
      'workspace:list': async () => ({ paths: [] as string[] }),
      'workspace:read': async () => ({ found: false }) as const,
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  // Wrap bus.call so tests can assert WHICH service hooks the subscriber
  // path consulted. Phase D: we want to prove `conversations:append-turn`
  // is never invoked from inside the subscriber.
  const spy: CallSpy = { calls: [] };
  const originalCall = h.bus.call.bind(h.bus);
  h.bus.call = (async <I, O>(
    hookName: string,
    ctx: AgentContext,
    input: I,
  ): Promise<O> => {
    spy.calls.push({ hookName, ctx, input });
    return originalCall<I, O>(hookName, ctx, input);
  }) as typeof h.bus.call;
  harnesses.push(h);
  return Object.assign(h, { spy });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
    await cleanup.query('DROP TABLE IF EXISTS conversations_v1_conversations');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('@ax/conversations chat:turn-end subscriber (Phase D)', () => {
  it('bumps last_activity_at on chat:turn-end with content (no append-turn call)', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    const beforeMd = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(beforeMd.lastActivityAt).toBeNull();

    // Reset spy between create and the fire we care about — we want to
    // assert about the subscriber path, not the create path.
    h.spy.calls.length = 0;

    const ctx = h.ctx({
      userId: 'userA',
      agentId: 'agt_a',
      conversationId: created.conversationId,
    });

    const result = await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'hello world' }],
    });
    expect(result.rejected).toBe(false);

    // The subscriber MUST NOT call conversations:append-turn — that's
    // the Phase D pivot. Other hooks (none expected) would also surface
    // here.
    const appendCalls = h.spy.calls.filter(
      (c) => c.hookName === 'conversations:append-turn',
    );
    expect(appendCalls).toHaveLength(0);

    // last_activity_at IS bumped — sidebar ordering keys off it.
    const afterMd = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(afterMd.lastActivityAt).not.toBeNull();

    // No row was written to conversation_turns. fetch-history reads the
    // rows directly (it's the runner-replay path; Phase D leaves the
    // host-rows API in place for explicit append-turn callers like the
    // user-turn append on POST).
    const got = await h.bus.call<FetchHistoryInput, FetchHistoryOutput>(
      'conversations:fetch-history',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toHaveLength(0);
  });

  it('no-ops when ctx.conversationId is unset (canary chats)', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    h.spy.calls.length = 0;

    // Note: ctx WITHOUT conversationId — the canary acceptance test path
    // (a session minted without an owner.conversationId).
    const ctx = h.ctx({ userId: 'userA', agentId: 'agt_a' });

    await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'this should NOT bump anything' }],
    });

    expect(
      h.spy.calls.filter((c) => c.hookName === 'conversations:append-turn'),
    ).toHaveLength(0);

    const md = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(md.lastActivityAt).toBeNull();
  });

  it('no-ops when contentBlocks is empty/missing (heartbeat turn-ends)', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    h.spy.calls.length = 0;

    const ctx = h.ctx({
      userId: 'userA',
      agentId: 'agt_a',
      conversationId: created.conversationId,
    });

    // Missing contentBlocks.
    const r1 = await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      role: 'assistant',
    });
    expect(r1.rejected).toBe(false);

    // Empty array.
    const r2 = await h.bus.fire('chat:turn-end', ctx, {
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [],
    });
    expect(r2.rejected).toBe(false);

    // No append-turn calls.
    expect(
      h.spy.calls.filter((c) => c.hookName === 'conversations:append-turn'),
    ).toHaveLength(0);

    // I8: heartbeats DO NOT count toward user-visible activity. The
    // timestamp must stay null until a real turn arrives.
    const md = await h.bus.call<GetMetadataInput, GetMetadataOutput>(
      'conversations:get-metadata',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(md.lastActivityAt).toBeNull();
  });

  it('subscriber MUST NOT throw when bumpLastActivity fails', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    // Force the bump to fail by dropping the conversations table out
    // from under the running plugin. The next bumpLastActivity will hit
    // a relation-does-not-exist error from postgres — exactly the
    // "storage hiccup" the subscriber-must-not-throw posture protects
    // the live chat from.
    const cleanup = new (await import('pg')).default.Client({
      connectionString,
    });
    await cleanup.connect();
    try {
      await cleanup.query('DROP TABLE IF EXISTS conversations_v1_turns');
      await cleanup.query(
        'DROP TABLE IF EXISTS conversations_v1_conversations',
      );
    } finally {
      await cleanup.end().catch(() => {});
    }

    const ctx = h.ctx({
      userId: 'userA',
      agentId: 'agt_a',
      conversationId: created.conversationId,
    });

    let threw: unknown;
    try {
      const result = await h.bus.fire('chat:turn-end', ctx, {
        reason: 'user-message-wait',
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'storage is down' }],
      });
      expect(result.rejected).toBe(false);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeUndefined();
  });

  it('explicit conversations:append-turn callers still work (hook stays registered)', async () => {
    // Phase D removes the SUBSCRIBER's auto-append, but the
    // `conversations:append-turn` service hook stays registered for
    // explicit callers (channel-web's POST path appends the user turn
    // through it). This guards the manifest-level invariant that the
    // hook is still callable end-to-end.
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );

    const ctx = h.ctx({ userId: 'userA', agentId: 'agt_a' });
    await h.bus.call<AppendTurnInput, AppendTurnOutput>(
      'conversations:append-turn',
      ctx,
      {
        conversationId: created.conversationId,
        userId: 'userA',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'explicit user turn' }],
      },
    );

    const got = await h.bus.call<FetchHistoryInput, FetchHistoryOutput>(
      'conversations:fetch-history',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toHaveLength(1);
    expect(got.turns[0]!.role).toBe('user');
  });
});
