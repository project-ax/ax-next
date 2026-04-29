import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HookCallback,
  HookCallbackMatcher,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { IpcClient, IpcClientOptions } from '@ax/ipc-protocol';
import type {
  InboxLoop,
  InboxLoopEntry,
  InboxLoopOptions,
} from '../inbox-loop.js';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

// ---------------------------------------------------------------------------
// Task 7c — claude-sdk runner aggregates per-turn workspace diff into ONE
// `workspace.commit-notify` request at the SDK `result` (turn-end) message.
//
// Strategy:
//   1. Stub `query()` from @anthropic-ai/claude-agent-sdk so we control
//      both the assistant transcript AND the moment we call PostToolUse
//      with simulated `Write` tool events.
//   2. Use a real tmpdir as workspaceRoot, with real files written to
//      mimic what the SDK would have done. The PostToolUse observer reads
//      from disk to get the resulting bytes (Edit/MultiEdit can't be
//      reconstructed from input alone).
//   3. Capture all IpcClient.call calls; assert ONE commit-notify per
//      turn with all three changes aggregated.
// ---------------------------------------------------------------------------

const queryMock = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  createSdkMcpServer: vi.fn((config: { name: string }) => ({
    type: 'sdk',
    name: config.name,
    instance: {},
  })),
  tool: vi.fn(
    (
      name: string,
      description: string,
      schema: unknown,
      handler: unknown,
    ) => ({ name, description, schema, handler }),
  ),
}));

type FakeClient = {
  call: Mock;
  callGet: Mock;
  event: Mock;
  close: Mock;
} & IpcClient;
type FakeInbox = { next: Mock } & InboxLoop;

let fakeClient: FakeClient;
let fakeInbox: FakeInbox;

vi.mock('@ax/ipc-protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ax/ipc-protocol')>();
  return {
    ...actual,
    createIpcClient: (_opts: IpcClientOptions): IpcClient => fakeClient,
  };
});

vi.mock('../inbox-loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../inbox-loop.js')>();
  return {
    ...actual,
    createInboxLoop: (_opts: InboxLoopOptions): InboxLoop => fakeInbox,
  };
});

let workspaceRoot: string;
const ORIGINAL_ENV = process.env;

function setEnv(): void {
  process.env = {
    ...ORIGINAL_ENV,
    AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
    AX_SESSION_ID: 'sess-1',
    AX_AUTH_TOKEN: 'tok-123',
    AX_WORKSPACE_ROOT: workspaceRoot,
    AX_PROXY_ENDPOINT: 'http://127.0.0.1:8443',
    ANTHROPIC_API_KEY: 'ax-cred:0123456789abcdef0123456789abcdef',
  };
}

function buildFakeClient(): FakeClient {
  return {
    call: vi.fn(),
    callGet: vi.fn(),
    event: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as FakeClient;
}

function buildFakeInbox(entries: InboxLoopEntry[]): FakeInbox {
  const queue = [...entries];
  const next = vi.fn().mockImplementation(async (): Promise<InboxLoopEntry> => {
    if (queue.length === 0) throw new Error('inbox exhausted');
    return queue.shift()!;
  });
  return { next, cursor: 0 } as FakeInbox;
}

const userEntry = (content: string): InboxLoopEntry => ({
  type: 'user-message',
  payload: { role: 'user', content },
  reqId: 'r-test',
});
const cancelEntry: InboxLoopEntry = { type: 'cancel' };

function assistantText(text: string): SDKMessage {
  return {
    type: 'assistant',
    uuid: 'msg-uuid',
    session_id: 'sess-1',
    parent_tool_use_id: null,
    message: {
      id: 'm-1',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0 },
      },
      content: [{ type: 'text', text }],
    },
  } as unknown as SDKMessage;
}

function resultSuccess(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    },
    modelUsage: {},
    permission_denials: [],
    uuid: 'result-uuid',
    session_id: 'sess-1',
  } as unknown as SDKMessage;
}

beforeEach(async () => {
  queryMock.mockReset();
  workspaceRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ax-claude-sdk-diffs-')),
  );
});

afterEach(async () => {
  process.env = ORIGINAL_ENV;
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('claude-sdk runner — per-turn workspace diff (Task 7c)', () => {
  it('PostToolUse for multiple Writes + result → ONE commit-notify with aggregated changes', async () => {
    setEnv();
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            systemPrompt: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'claude-sonnet-4-7',
          },
        };
      }
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.commit-notify') {
        return { accepted: true, version: 'v1', delta: null };
      }
      throw new Error(`unexpected: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('do work'), cancelEntry]);

    queryMock.mockImplementation(
      ({
        prompt,
        options,
      }: {
        prompt: AsyncIterable<SDKUserMessage>;
        options: {
          hooks: { PostToolUse: HookCallbackMatcher[] };
        };
      }) => {
        return (async function* (): AsyncGenerator<SDKMessage> {
          // Pull the first user message so userMessages() advances.
          const it = prompt[Symbol.asyncIterator]();
          const firstUser = await it.next();
          if (firstUser.done === true) {
            throw new Error('prompt closed before first user message');
          }

          // Pretend the SDK ran three file-mutating tools. Write the
          // resulting files to disk so the PostToolUse observer can read
          // the bytes back. The third "Write" overwrites the first to
          // exercise the last-write-wins accumulator semantic.
          await fs.writeFile(path.join(workspaceRoot, 'a.txt'), 'AAA', 'utf8');
          await fs.writeFile(path.join(workspaceRoot, 'b.txt'), 'BBB', 'utf8');
          await fs.writeFile(
            path.join(workspaceRoot, 'a.txt'),
            'AAA-updated',
            'utf8',
          );

          const postHook: HookCallback =
            options.hooks.PostToolUse[0]!.hooks[0]!;
          const signal = new AbortController().signal;
          await postHook(
            {
              hook_event_name: 'PostToolUse',
              session_id: 'sess-1',
              transcript_path: '/tmp/t.jsonl',
              cwd: workspaceRoot,
              tool_name: 'Write',
              tool_input: { file_path: 'a.txt', content: 'AAA' },
              tool_response: { success: true },
              tool_use_id: 'tu_1',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
            'tu_1',
            { signal },
          );
          await postHook(
            {
              hook_event_name: 'PostToolUse',
              session_id: 'sess-1',
              transcript_path: '/tmp/t.jsonl',
              cwd: workspaceRoot,
              tool_name: 'Write',
              tool_input: { file_path: 'b.txt', content: 'BBB' },
              tool_response: { success: true },
              tool_use_id: 'tu_2',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
            'tu_2',
            { signal },
          );
          // Edit-style observation: input describes a transform, observer
          // reads the on-disk result.
          await postHook(
            {
              hook_event_name: 'PostToolUse',
              session_id: 'sess-1',
              transcript_path: '/tmp/t.jsonl',
              cwd: workspaceRoot,
              tool_name: 'Edit',
              tool_input: {
                file_path: 'a.txt',
                old_string: 'AAA',
                new_string: 'AAA-updated',
              },
              tool_response: { success: true },
              tool_use_id: 'tu_3',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
            'tu_3',
            { signal },
          );

          yield assistantText('did 3 things');
          yield resultSuccess();

          // Drain the user generator so it sees `cancel` and returns.
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();

    expect(rc).toBe(0);

    const commitCalls = fakeClient.call.mock.calls.filter(
      (c) => c[0] === 'workspace.commit-notify',
    );
    // ONE commit-notify per turn, even though three file-mutating tools
    // ran during the turn.
    expect(commitCalls).toHaveLength(1);

    const payload = commitCalls[0]?.[1] as {
      parentVersion: string | null;
      message: string;
      changes: Array<
        | { path: string; kind: 'put'; content: string }
        | { path: string; kind: 'delete' }
      >;
    };
    expect(payload.parentVersion).toBeNull();
    expect(payload.message).toBe('turn');

    // 2 distinct paths (a.txt was written twice; last-write-wins).
    expect(payload.changes).toHaveLength(2);
    const byPath = new Map(payload.changes.map((c) => [c.path, c]));
    const a = byPath.get('a.txt');
    const b = byPath.get('b.txt');
    expect(a?.kind).toBe('put');
    expect(b?.kind).toBe('put');
    if (a?.kind === 'put') {
      // Last write wins → "AAA-updated".
      expect(Buffer.from(a.content, 'base64').toString('utf8')).toBe(
        'AAA-updated',
      );
    }
    if (b?.kind === 'put') {
      expect(Buffer.from(b.content, 'base64').toString('utf8')).toBe('BBB');
    }
  });

  it('parent version advances across turns when each turn has a write', async () => {
    setEnv();
    fakeClient = buildFakeClient();
    let nextVersion = 1;
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            systemPrompt: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'claude-sonnet-4-7',
          },
        };
      }
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.commit-notify') {
        return { accepted: true, version: `v${nextVersion++}`, delta: null };
      }
      throw new Error(`unexpected: ${action}`);
    });
    fakeInbox = buildFakeInbox([
      userEntry('first'),
      userEntry('second'),
      cancelEntry,
    ]);

    queryMock.mockImplementation(
      ({
        prompt,
        options,
      }: {
        prompt: AsyncIterable<SDKUserMessage>;
        options: {
          hooks: { PostToolUse: HookCallbackMatcher[] };
        };
      }) => {
        return (async function* (): AsyncGenerator<SDKMessage> {
          const it = prompt[Symbol.asyncIterator]();
          const post: HookCallback = options.hooks.PostToolUse[0]!.hooks[0]!;
          const signal = new AbortController().signal;

          await it.next();
          await fs.writeFile(path.join(workspaceRoot, 't1.txt'), '1', 'utf8');
          await post(
            {
              hook_event_name: 'PostToolUse',
              session_id: 'sess-1',
              transcript_path: '/tmp/t.jsonl',
              cwd: workspaceRoot,
              tool_name: 'Write',
              tool_input: { file_path: 't1.txt', content: '1' },
              tool_response: { success: true },
              tool_use_id: 'tu_1',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
            'tu_1',
            { signal },
          );
          yield assistantText('reply 1');
          yield resultSuccess();

          await it.next();
          await fs.writeFile(path.join(workspaceRoot, 't2.txt'), '2', 'utf8');
          await post(
            {
              hook_event_name: 'PostToolUse',
              session_id: 'sess-1',
              transcript_path: '/tmp/t.jsonl',
              cwd: workspaceRoot,
              tool_name: 'Write',
              tool_input: { file_path: 't2.txt', content: '2' },
              tool_response: { success: true },
              tool_use_id: 'tu_2',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
            'tu_2',
            { signal },
          );
          yield assistantText('reply 2');
          yield resultSuccess();

          await it.next(); // drain to cancel
        })();
      },
    );

    const { main } = await import('../main.js');
    await main();

    const commitCalls = fakeClient.call.mock.calls.filter(
      (c) => c[0] === 'workspace.commit-notify',
    );
    expect(commitCalls).toHaveLength(2);
    expect((commitCalls[0]?.[1] as { parentVersion: string | null })
      .parentVersion).toBeNull();
    expect((commitCalls[1]?.[1] as { parentVersion: string | null })
      .parentVersion).toBe('v1');
  });
});
