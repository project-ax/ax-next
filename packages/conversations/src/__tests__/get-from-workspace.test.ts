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
      // Phase B: workspace:apply is in the manifest calls; stub for bootstrap
      // (get-from-workspace tests don't exercise drop-turn).
      'workspace:apply': async () => ({ version: 'v-stub', delta: { before: null, after: 'v-stub', changes: [] } }),
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

  it('workspace:list / workspace:read see ctx scoped to the conversation owner — not the caller-ctx', async () => {
    // Regression: pre-fix, conversations:get forwarded the caller's ctx
    // straight into readTranscriptFromWorkspace. Channel-web calls us
    // with `initCtx` (userId='system', agentId='@ax/channel-web'). The
    // host-side workspace plugins derive workspaceId from
    // (ctx.userId, ctx.agentId) — so workspace:list looked at a
    // different (empty) workspaceId than the one the runner pod's
    // commit-notify wrote into. End user impact: the runner-owned
    // jsonl WAS persisted, but the GET endpoint silently returned
    // empty turns and turn-2 resume had no memory of turn-1.
    //
    // After the fix, conversations:get rebuilds a synthetic ctx scoped
    // to (conv.userId, conv.agentId) before the workspace round-trip.
    // We verify by capturing ctx in custom workspace mocks and
    // asserting userId/agentId match the conversation owner regardless
    // of the caller-ctx.
    const capturedListCtx: Array<{
      userId: string;
      agentId: string;
    }> = [];
    const capturedReadCtx: Array<{
      userId: string;
      agentId: string;
    }> = [];
    const h = await createTestHarness({
      services: {
        'agents:resolve': async (_ctx, input: unknown) => {
          const call = input as { agentId: string };
          return {
            agent: { id: call.agentId, visibility: 'personal' },
          };
        },
        'workspace:list': async (ctx) => {
          capturedListCtx.push({
            userId: ctx.userId,
            agentId: ctx.agentId,
          });
          return {
            paths: ['.claude/projects/-permanent/sess-xyz.jsonl'],
          };
        },
        'workspace:read': async (ctx) => {
          capturedReadCtx.push({
            userId: ctx.userId,
            agentId: ctx.agentId,
          });
          return { found: true as const, bytes: makeJsonlBytes() };
        },
        // Phase B: workspace:apply is in the manifest calls; stub for bootstrap.
        'workspace:apply': async () => ({ version: 'v-stub', delta: { before: null, after: 'v-stub', changes: [] } }),
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createConversationsPlugin(),
      ],
    });
    harnesses.push(h);

    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'real-owner', agentId: 'agt_owner' }),
      { userId: 'real-owner', agentId: 'agt_owner' },
    );
    await setRunnerSessionViaStore(created.conversationId, 'sess-xyz');

    // Caller-ctx mimics channel-web's initCtx: NOT the conversation owner.
    await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'caller-system', agentId: 'caller-channel-web' }),
      { conversationId: created.conversationId, userId: 'real-owner' },
    );

    // Workspace round-trip ran with the conversation owner's identity,
    // not the caller's.
    expect(capturedListCtx).toEqual([
      { userId: 'real-owner', agentId: 'agt_owner' },
    ]);
    expect(capturedReadCtx).toEqual([
      { userId: 'real-owner', agentId: 'agt_owner' },
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

});

// ---------------------------------------------------------------------------
// Attachment-chip reconstruction (UI bug fix, 2026-05-21).
//
// The runner translates a user's `attachment` block into a model-facing text
// mention before the SDK writes the jsonl, so the original block is gone on
// reopen and the chat shows raw "User attached '…' at .ax/uploads/… (…)" text
// instead of a chip. getConversation rebuilds the `attachment` block from the
// mention, gated to this conversation's own upload prefix.
// ---------------------------------------------------------------------------
function makeJsonlWithUserContent(content: unknown): Uint8Array {
  const lines = [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      uuid: 'u-1',
      timestamp: '2026-05-21T12:00:00.000Z',
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      },
      uuid: 'a-1',
      timestamp: '2026-05-21T12:00:01.000Z',
    }),
  ];
  return new TextEncoder().encode(lines.join('\n'));
}

describe('@ax/conversations conversations:get reconstructs attachment chips', () => {
  async function getWithUserContent(
    content: unknown,
  ): Promise<GetOutput> {
    // Bytes are injected once we know the real conversationId (the mention
    // path embeds it); the workspaceRead mock reads this holder when
    // conversations:get runs, by which point it's been populated.
    const holder: { bytes?: Uint8Array } = {};
    const { h } = await makeHarness({
      workspaceList: async () => ({
        paths: ['.claude/projects/-permanent/sess-att.jsonl'],
      }),
      workspaceRead: async () => ({ found: true, bytes: holder.bytes! }),
    });
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await setRunnerSessionViaStore(created.conversationId, 'sess-att');
    holder.bytes = makeJsonlWithUserContent(
      typeof content === 'function'
        ? (content as (id: string) => unknown)(created.conversationId)
        : content,
    );
    return h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
  }

  it('rebuilds an attachment block from a standalone mention block (keeps the typed prompt)', async () => {
    const got = await getWithUserContent((convId: string) => [
      { type: 'text', text: 'Summarize this file' },
      {
        type: 'text',
        text: `User attached 'Disaster Recovery Plan - v3.pdf' at .ax/uploads/${convId}/req-d194/a60d__Disaster_Recovery_Plan_-_v3.pdf (application/pdf)`,
      },
    ]);
    const user = got.turns.find((t) => t.role === 'user');
    expect(user?.contentBlocks).toHaveLength(2);
    expect(user?.contentBlocks[0]).toEqual({
      type: 'text',
      text: 'Summarize this file',
    });
    const att = user?.contentBlocks[1];
    expect(att).toMatchObject({
      type: 'attachment',
      displayName: 'Disaster Recovery Plan - v3.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 0,
    });
    expect((att as { path: string }).path).toContain('.ax/uploads/');
  });

  it('splits a merged "prompt\\nmention" text block into [text, attachment]', async () => {
    const got = await getWithUserContent((convId: string) => [
      {
        type: 'text',
        text: `Summarize this file\nUser attached 'r.pdf' at .ax/uploads/${convId}/req-1/ab__r.pdf (application/pdf)`,
      },
    ]);
    const user = got.turns.find((t) => t.role === 'user');
    expect(user?.contentBlocks).toEqual([
      { type: 'text', text: 'Summarize this file' },
      {
        type: 'attachment',
        path: expect.stringContaining('.ax/uploads/') as unknown as string,
        displayName: 'r.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 0,
      },
    ]);
  });

  it('does NOT convert a mention whose path belongs to a different conversation (false-positive guard)', async () => {
    const mention =
      "User attached 'evil.pdf' at .ax/uploads/cnv_someoneelse/req-x/ab__evil.pdf (application/pdf)";
    const got = await getWithUserContent([{ type: 'text', text: mention }]);
    const user = got.turns.find((t) => t.role === 'user');
    // Untouched — still a plain text block, no attachment block produced.
    expect(user?.contentBlocks).toEqual([{ type: 'text', text: mention }]);
  });

  it('does NOT convert mentions inside an assistant turn (model cannot inject chips)', async () => {
    const holder: { bytes?: Uint8Array } = {};
    const { h } = await makeHarness({
      workspaceList: async () => ({
        paths: ['.claude/projects/-permanent/sess-att.jsonl'],
      }),
      workspaceRead: async () => ({ found: true, bytes: holder.bytes! }),
    });
    const created = await h.bus.call<CreateInput, CreateOutput>(
      'conversations:create',
      h.ctx({ userId: 'userA' }),
      { userId: 'userA', agentId: 'agt_a' },
    );
    await setRunnerSessionViaStore(created.conversationId, 'sess-att');
    const mention = `User attached 'x.pdf' at .ax/uploads/${created.conversationId}/req-1/ab__x.pdf (application/pdf)`;
    holder.bytes = new TextEncoder().encode(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: mention }],
        },
        uuid: 'a-1',
        timestamp: '2026-05-21T12:00:00.000Z',
      }),
    );
    const got = await h.bus.call<GetInput, GetOutput>(
      'conversations:get',
      h.ctx({ userId: 'userA' }),
      { conversationId: created.conversationId, userId: 'userA' },
    );
    const assistant = got.turns.find((t) => t.role === 'assistant');
    expect(assistant?.contentBlocks).toEqual([{ type: 'text', text: mention }]);
  });

  it('leaves a normal text-only user turn unchanged', async () => {
    const got = await getWithUserContent([{ type: 'text', text: 'just text' }]);
    const user = got.turns.find((t) => t.role === 'user');
    expect(user?.contentBlocks).toEqual([{ type: 'text', text: 'just text' }]);
  });
});
