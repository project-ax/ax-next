import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConversationsPlugin } from '../plugin.js';
import type {
  CreateInput,
  CreateOutput,
  GetInput,
  GetOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// Phase D Task 4: getConversation reads transcripts from the workspace's
// runner-native jsonl via `workspace:list` + `workspace:read`, NOT from the
// `conversation_turns` rows in postgres. The wire shape on the
// `conversations:get` hook is unchanged: subscribers (channel-web) still
// see `{ conversation, turns: Turn[] }`.
//
// Strategy: we mock `workspace:list` and `workspace:read` via vi.fn()
// service handlers in the test harness. Each test programs the mock for
// its scenario and asserts both the bus interactions AND the hook output.
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

interface WorkspaceMocks {
  list: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
}

async function makeHarness(opts: {
  policy?: ResolvePolicy;
  workspaceList?: (input: { pathGlob?: string }) => Promise<{ paths: string[] }>;
  workspaceRead?: (input: {
    path: string;
  }) => Promise<{ found: true; bytes: Uint8Array } | { found: false }>;
}): Promise<{ h: TestHarness; mocks: WorkspaceMocks }> {
  const policy = opts.policy ?? { decide: () => 'allow' as const };
  // Default: workspace contains nothing → no jsonl found.
  const list = vi.fn(
    opts.workspaceList ??
      (async () => ({ paths: [] }) as { paths: string[] }),
  );
  const read = vi.fn(
    opts.workspaceRead ??
      (async () =>
        ({ found: false }) as { found: true; bytes: Uint8Array } | { found: false }),
  );
  const h = await createTestHarness({
    services: {
      'agents:resolve': async (
        _ctx,
        input: unknown,
      ): Promise<{ agent: { id: string; visibility: string } }> => {
        const call = input as { agentId: string; userId: string };
        const decision = policy.decide(call);
        if (decision === 'allow') {
          return { agent: { id: call.agentId, visibility: 'personal' } };
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
      'workspace:list': async (_ctx, input: unknown) =>
        list(input as { pathGlob?: string }),
      'workspace:read': async (_ctx, input: unknown) =>
        read(input as { path: string }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createConversationsPlugin(),
    ],
  });
  harnesses.push(h);
  return { h, mocks: { list, read } };
}

/**
 * Bind a `runner_session_id` directly via raw SQL — Phase B's
 * `conversations:store-runner-session` hook ships in the same plugin but
 * we bypass it to keep these tests focused on getConversation.
 */
async function setRunnerSessionViaStore(
  conversationId: string,
  runnerSessionId: string | null,
): Promise<void> {
  const client = new (await import('pg')).default.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'UPDATE conversations_v1_conversations SET runner_session_id = $1, updated_at = NOW() WHERE conversation_id = $2',
      [runnerSessionId, conversationId],
    );
  } finally {
    await client.end().catch(() => {});
  }
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

// Build a minimal SDK jsonl payload with one user line + one assistant line.
function makeJsonlBytes(): Uint8Array {
  const lines = [
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: 'hello' },
      uuid: 'u-1',
      timestamp: '2026-04-29T12:00:00.000Z',
      sessionId: 'sess-abc',
    }),
    JSON.stringify({
      parentUuid: 'u-1',
      isSidechain: false,
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi back' }],
      },
      uuid: 'u-2',
      timestamp: '2026-04-29T12:00:01.000Z',
      sessionId: 'sess-abc',
    }),
    '',
  ];
  return new TextEncoder().encode(lines.join('\n'));
}

describe('@ax/conversations conversations:get reads from workspace jsonl', () => {
  it('returns empty turns and does NOT call workspace when runnerSessionId is null', async () => {
    const { h, mocks } = await makeHarness({});
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    // Phase-B default — newly-created rows have runner_session_id=null
    // until the runner's first turn binds it. No workspace call needed.
    expect(created.runnerSessionId).toBeNull();

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );

    expect(got.conversation.conversationId).toBe(created.conversationId);
    expect(got.turns).toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('returns parsed turns when workspace:list finds a jsonl and workspace:read returns its bytes', async () => {
    const bytes = makeJsonlBytes();
    const { h, mocks } = await makeHarness({
      workspaceList: async (_input) => ({
        paths: ['.claude/projects/-permanent/sess-abc.jsonl'],
      }),
      workspaceRead: async (_input) => ({ found: true, bytes }),
    });
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await setRunnerSessionViaStore(created.conversationId, 'sess-abc');

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list.mock.calls[0]![0]).toEqual({
      pathGlob: '.claude/projects/**/sess-abc.jsonl',
    });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.read.mock.calls[0]![0]).toEqual({
      path: '.claude/projects/-permanent/sess-abc.jsonl',
    });

    expect(got.turns).toHaveLength(2);
    expect(got.turns[0]!.role).toBe('user');
    expect(got.turns[0]!.contentBlocks).toEqual([
      { type: 'text', text: 'hello' },
    ]);
    expect(got.turns[1]!.role).toBe('assistant');
    expect(got.turns[1]!.contentBlocks).toEqual([
      { type: 'text', text: 'hi back' },
    ]);
  });

  it('returns empty turns when workspace:list returns no matches (jsonl not yet written)', async () => {
    const { h, mocks } = await makeHarness({
      workspaceList: async () => ({ paths: [] }),
    });
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await setRunnerSessionViaStore(created.conversationId, 'sess-abc');

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toEqual([]);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    // Skipped read — no path to read.
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('returns empty turns when workspace:read returns {found:false} (race: file vanished)', async () => {
    const { h, mocks } = await makeHarness({
      workspaceList: async () => ({
        paths: ['.claude/projects/-permanent/sess-abc.jsonl'],
      }),
      workspaceRead: async () => ({ found: false }),
    });
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await setRunnerSessionViaStore(created.conversationId, 'sess-abc');

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toEqual([]);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it('propagates a workspace:list throw as a PluginError', async () => {
    const { h } = await makeHarness({
      workspaceList: async () => {
        throw new PluginError({
          code: 'unknown',
          plugin: 'mock-workspace',
          hookName: 'workspace:list',
          message: 'list failure for test',
        });
      },
    });
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await setRunnerSessionViaStore(created.conversationId, 'sess-abc');

    let caught: unknown;
    try {
      await h.bus.call<GetInput, GetOutput>(
        'conversations:get',
        h.ctx({ userId: 'userA' }),
        { conversationId: created.conversationId, userId: 'userA' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).hookName).toBe('workspace:list');
  });

  it('foreign-user get returns not-found BEFORE any workspace bus call (existence-leak guard)', async () => {
    const { h, mocks } = await makeHarness({});
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await setRunnerSessionViaStore(created.conversationId, 'sess-abc');

    let caught: unknown;
    try {
      await h.bus.call<GetInput, GetOutput>(
        'conversations:get',
        h.ctx({ userId: 'userB' }),
        { conversationId: created.conversationId, userId: 'userB' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('not-found');
    // The ACL gate runs first — no workspace round-trip on a denied read.
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("agents:resolve denial propagates BEFORE any workspace bus call", async () => {
    // Allow create on userA, then flip the policy to forbid for the get
    // call. We do this by making policy decide based on a closure flag.
    let allowAll = true;
    const { h, mocks } = await makeHarness({
      policy: {
        decide: () => (allowAll ? 'allow' : 'forbid'),
      },
    });
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await setRunnerSessionViaStore(created.conversationId, 'sess-abc');

    allowAll = false;
    let caught: unknown;
    try {
      await h.bus.call<GetInput, GetOutput>(
        'conversations:get',
        h.ctx({ userId: 'userA' }),
        { conversationId: created.conversationId, userId: 'userA' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('forbidden');
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('returns multiple parsed turns with correct turnIndex ordering', async () => {
    // Build a richer jsonl with three turns to verify the parser output
    // round-trips through the hook intact.
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'q1' },
        uuid: 'u-1',
        timestamp: '2026-04-29T12:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'a1' }],
        },
        uuid: 'u-2',
        timestamp: '2026-04-29T12:00:01.000Z',
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'q2' },
        uuid: 'u-3',
        timestamp: '2026-04-29T12:00:02.000Z',
      }),
    ];
    const bytes = new TextEncoder().encode(lines.join('\n'));
    const { h } = await makeHarness({
      workspaceList: async () => ({
        paths: ['.claude/projects/-permanent/sess-multi.jsonl'],
      }),
      workspaceRead: async () => ({ found: true, bytes }),
    });
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await setRunnerSessionViaStore(created.conversationId, 'sess-multi');

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toHaveLength(3);
    expect(got.turns.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
    expect(got.turns.map((t) => t.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('does NOT consult store.listTurns — DB-direct turns are ignored', async () => {
    // Append a turn via the existing :append-turn service hook (Phase D
    // Task 5 will remove this from the chat:turn-end subscriber, but the
    // service hook itself stays). conversations:get must NOT see it
    // because it now reads from workspace, not from conversation_turns.
    const { h } = await makeHarness({});
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await h.bus.call(
      'conversations:append-turn',
      h.ctx({ userId: 'userA' }),
      {
        conversationId: created.conversationId,
        userId: 'userA',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'this is in the DB only' }],
      },
    );
    // Leave runner_session_id null — the workspace path is short-
    // circuited and the DB row is invisible. This is the load-bearing
    // assertion: no DB fallback.

    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    expect(got.turns).toEqual([]);
  });
});
