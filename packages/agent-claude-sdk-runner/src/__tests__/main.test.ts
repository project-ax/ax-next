import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
// Unit-level test for main.ts — mocks the Anthropic SDK and the IPC client
// surface so we can verify control flow (env → tool.list → query() drain →
// turn-end / chat-end events → exit code) without a subprocess or real
// proxy. Full e2e is Task 14.
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

// Captured per-test so each scenario can assert on what main() saw.
type FakeClient = {
  call: Mock;
  callGet: Mock;
  event: Mock;
  close: Mock;
} & IpcClient;

type FakeInbox = {
  next: Mock;
} & InboxLoop;

let fakeClient: FakeClient;
let fakeInbox: FakeInbox;
let createIpcClientMock: Mock;
let createInboxLoopMock: Mock;

vi.mock('@ax/ipc-protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ax/ipc-protocol')>();
  return {
    ...actual,
    createIpcClient: (opts: IpcClientOptions): IpcClient => {
      createIpcClientMock(opts);
      return fakeClient;
    },
  };
});

vi.mock('../inbox-loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../inbox-loop.js')>();
  return {
    ...actual,
    createInboxLoop: (opts: InboxLoopOptions): InboxLoop => {
      createInboxLoopMock(opts);
      return fakeInbox;
    },
  };
});

// Phase 3: the runner now spawns `git` for session-start materialize +
// turn-end commit/bundle/rollback. Mocking these out keeps these unit
// tests fast, hermetic, and free of stderr noise from git ops failing
// against the test's fake AX_WORKSPACE_ROOT (`/tmp/workspace`).
//
// The REAL git-workspace ops are exercised in `git-workspace.test.ts`
// against real tempdirs + git binary; the workspace-commit-notify
// handler tests cover the host-side bundler. This file focuses on
// main.ts's control-flow shape (env → boot → SDK loop → events).
const materializeMock = vi.fn().mockResolvedValue(undefined);
const commitTurnAndBundleMock = vi.fn().mockResolvedValue(null);
const advanceBaselineMock = vi.fn().mockResolvedValue(undefined);
const rollbackToBaselineMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../git-workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-workspace.js')>();
  return {
    ...actual,
    materializeWorkspace: materializeMock,
    commitTurnAndBundle: commitTurnAndBundleMock,
    advanceBaseline: advanceBaselineMock,
    rollbackToBaseline: rollbackToBaselineMock,
  };
});

const COMPLETE_ENV = {
  AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
  AX_SESSION_ID: 'sess-1',
  AX_AUTH_TOKEN: 'tok-123',
  AX_WORKSPACE_ROOT: '/tmp/workspace',
  AX_PROXY_ENDPOINT: 'http://127.0.0.1:8443',
  ANTHROPIC_API_KEY: 'ax-cred:0123456789abcdef0123456789abcdef',
} as const;

const ORIGINAL_ENV = process.env;

function setEnv(overrides: Partial<Record<string, string | undefined>>): void {
  process.env = { ...ORIGINAL_ENV };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function buildFakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  const client: FakeClient = {
    call: vi.fn(),
    callGet: vi.fn(),
    event: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as FakeClient;
  return client;
}

function buildFakeInbox(entries: InboxLoopEntry[]): FakeInbox {
  const queue = [...entries];
  const next = vi.fn().mockImplementation(async (): Promise<InboxLoopEntry> => {
    if (queue.length === 0) {
      throw new Error('fake inbox: exhausted (test setup bug)');
    }
    return queue.shift()!;
  });
  return { next, cursor: 0 } as FakeInbox;
}

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

function assistantBlocks(content: unknown[]): SDKMessage {
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
      content,
    },
  } as unknown as SDKMessage;
}

function userToolResult(
  toolUseId: string,
  text: string,
  isError = false,
): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    session_id: 'sess-1',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: text,
          is_error: isError,
        },
      ],
    },
  } as unknown as SDKMessage;
}

function systemInit(sessionId: string): SDKMessage {
  // Mirrors SDKSystemMessage from
  // @anthropic-ai/claude-agent-sdk/sdk.d.ts:3282-3314 — the FIRST message
  // every `query()` emits. Phase C uses session_id to bind the SDK's
  // durable transcript to our conversation row so a future runner can
  // resume() instead of replaying.
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    apiKeySource: 'user',
    claude_code_version: '0.0.0-test',
    cwd: '/tmp/workspace',
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-7',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: 'sys-init-uuid',
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

const userEntry = (
  content: string,
  reqId: string = 'req-test',
): InboxLoopEntry => ({
  type: 'user-message',
  payload: { role: 'user', content },
  reqId,
});
const cancelEntry: InboxLoopEntry = { type: 'cancel' };

beforeEach(() => {
  queryMock.mockReset();
  materializeMock.mockReset();
  materializeMock.mockResolvedValue(undefined);
  commitTurnAndBundleMock.mockReset();
  commitTurnAndBundleMock.mockResolvedValue(null);
  advanceBaselineMock.mockReset();
  advanceBaselineMock.mockResolvedValue(undefined);
  rollbackToBaselineMock.mockReset();
  rollbackToBaselineMock.mockResolvedValue(undefined);
  createIpcClientMock = vi.fn();
  createInboxLoopMock = vi.fn();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('main()', () => {
  it('happy path: user message → assistant text → result → cancel → exit 0', async () => {
    setEnv(COMPLETE_ENV);
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
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.commit-notify') {
        return { accepted: true, version: 'v1', delta: null };
      }
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('please summarize'), cancelEntry]);

    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        // Consume one user message from the inbox-driven prompt generator
        // so the happy path actually exercises userMessages(). The cancel
        // entry then terminates the generator; we synthesize one
        // assistant+result pair to drain back.
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          const firstUser = await it.next();
          if (firstUser.done === true) {
            throw new Error('prompt closed before any user message');
          }
          yield assistantText('hello world');
          yield resultSuccess();
          // Drain the generator so userMessages() hits the cancel entry
          // and returns, letting the outer for-await exit.
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();

    expect(rc).toBe(0);

    // Three calls at boot: session.get-config + workspace.materialize +
    // tool.list. Materialize is Phase 3; the runner clones (or inits)
    // /permanent before the SDK query opens.
    expect(fakeClient.call).toHaveBeenCalledTimes(3);
    expect(fakeClient.call).toHaveBeenCalledWith('session.get-config', {});
    expect(fakeClient.call).toHaveBeenCalledWith('workspace.materialize', {});
    expect(fakeClient.call).toHaveBeenCalledWith('tool.list', {});
    // Materialize must be called BEFORE tool.list so the workspace exists
    // by the time the SDK query opens.
    const callOrder = fakeClient.call.mock.calls.map((c) => c[0]);
    expect(callOrder.indexOf('workspace.materialize')).toBeLessThan(
      callOrder.indexOf('tool.list'),
    );
    // Materialize was actually invoked on the workspace root.
    expect(materializeMock).toHaveBeenCalledTimes(1);
    expect(materializeMock).toHaveBeenCalledWith({
      root: '/tmp/workspace',
      bundleBase64: '',
    });
    // Empty turns (no file changes accumulated) skip commit-notify; the
    // event.turn-end below is the heartbeat the host keys off (Task 7c).
    const commitNotifies = fakeClient.call.mock.calls.filter(
      (c) => c[0] === 'workspace.commit-notify',
    );
    expect(commitNotifies).toHaveLength(0);

    const turnEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.turn-end',
    );
    // One assistant turn-end carrying the text contentBlock so
    // @ax/conversations can persist it (Task 3 of Week 10–12).
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.[1]).toEqual({
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'hello world' }],
    });

    const chatEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.chat-end',
    );
    expect(chatEnds).toHaveLength(1);
    const chatEndPayload = chatEnds[0]?.[1] as {
      outcome: {
        kind: string;
        messages: Array<{ role: string; content: string }>;
      };
    };
    expect(chatEndPayload.outcome.kind).toBe('complete');
    expect(chatEndPayload.outcome.messages).toEqual([
      { role: 'user', content: 'please summarize' },
      { role: 'assistant', content: 'hello world' },
    ]);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const queryArg = queryMock.mock.calls[0]?.[0] as {
      options: {
        disallowedTools: string[];
        mcpServers: Record<string, unknown>;
        settingSources: string[];
        systemPrompt: { type: string; preset: string };
        env: { ANTHROPIC_BASE_URL?: string; ANTHROPIC_API_KEY: string };
      };
    };
    expect(queryArg.options.disallowedTools).toEqual(
      expect.arrayContaining(['WebFetch', 'WebSearch', 'Skill', 'Task']),
    );
    expect(queryArg.options.mcpServers).toHaveProperty('ax-host-tools');
    expect(queryArg.options.settingSources).toEqual([]);
    expect(queryArg.options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
    expect(queryArg.options.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(queryArg.options.env.ANTHROPIC_API_KEY).toBe(
      COMPLETE_ENV.ANTHROPIC_API_KEY,
    );

    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });

  it('bootstrap failure: missing AX_PROXY_ENDPOINT → exit 2, no chat-end, no query', async () => {
    setEnv({ ...COMPLETE_ENV, AX_PROXY_ENDPOINT: undefined });
    // These get set but should never be touched — main() should return
    // before constructing the client.
    fakeClient = buildFakeClient();
    fakeInbox = buildFakeInbox([]);

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(2);

      const stderrMessages = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .join('');
      expect(stderrMessages).toContain('AX_PROXY_ENDPOINT');
      expect(stderrMessages).toContain('AX_PROXY_UNIX_SOCKET');

      expect(queryMock).not.toHaveBeenCalled();
      expect(fakeClient.event).not.toHaveBeenCalled();
      expect(createIpcClientMock).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('Phase 3 turn end: bundle ships → commit-notify → host accepts → advance baseline', async () => {
    // The new shape: at SDK `result`, runner calls commitTurnAndBundle.
    // If non-null, runner ships workspace.commit-notify with bundleBytes.
    // On host accept, runner advances baseline; on veto, runner rolls
    // back. Fully replaces the legacy diff-accumulator path.
    setEnv(COMPLETE_ENV);
    commitTurnAndBundleMock.mockResolvedValueOnce('FAKE_BUNDLE_B64');
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u',
          agentId: 'a',
          agentConfig: {
            systemPrompt: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'claude-sonnet-4-7',
          },
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: 'B64' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.commit-notify') {
        return { accepted: true, version: 'v-new', delta: null };
      }
      throw new Error(`unexpected: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantText('done');
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    // commit-notify was sent with bundleBytes from commitTurnAndBundle.
    const commitCalls = fakeClient.call.mock.calls.filter(
      (c) => c[0] === 'workspace.commit-notify',
    );
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0]?.[1]).toEqual({
      parentVersion: null,
      reason: 'turn',
      bundleBytes: 'FAKE_BUNDLE_B64',
    });
    // advanceBaseline called on accept.
    expect(advanceBaselineMock).toHaveBeenCalledTimes(1);
    expect(rollbackToBaselineMock).not.toHaveBeenCalled();
  });

  it('Phase 3 turn end: empty turn (commitTurnAndBundle returns null) → no commit-notify', async () => {
    setEnv(COMPLETE_ENV);
    // Default mock returns null — empty turn.
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u',
          agentId: 'a',
          agentConfig: {
            systemPrompt: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'claude-sonnet-4-7',
          },
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: 'B64' };
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantText('done');
          yield resultSuccess();
          await it.next();
        })();
      },
    );
    const { main } = await import('../main.js');
    expect(await main()).toBe(0);
    const commitCalls = fakeClient.call.mock.calls.filter(
      (c) => c[0] === 'workspace.commit-notify',
    );
    expect(commitCalls).toHaveLength(0);
    expect(advanceBaselineMock).not.toHaveBeenCalled();
    expect(rollbackToBaselineMock).not.toHaveBeenCalled();
  });

  it('Phase 3 turn end: host vetoes → rollback called, baseline NOT advanced', async () => {
    setEnv(COMPLETE_ENV);
    commitTurnAndBundleMock.mockResolvedValueOnce('BUNDLE_VETO');
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u',
          agentId: 'a',
          agentConfig: {
            systemPrompt: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'claude-sonnet-4-7',
          },
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: 'B64' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.commit-notify') {
        return { accepted: false, reason: 'policy violation' };
      }
      throw new Error(`unexpected: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantText('done');
          yield resultSuccess();
          await it.next();
        })();
      },
    );
    try {
      const { main } = await import('../main.js');
      expect(await main()).toBe(0);
      expect(rollbackToBaselineMock).toHaveBeenCalledTimes(1);
      expect(advanceBaselineMock).not.toHaveBeenCalled();
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrText).toContain('policy violation');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('Phase 3 turn end: commit-notify IPC error → preserve working tree (no rollback, no advance)', async () => {
    setEnv(COMPLETE_ENV);
    commitTurnAndBundleMock.mockResolvedValueOnce('BUNDLE_NETERR');
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u',
          agentId: 'a',
          agentConfig: {
            systemPrompt: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'claude-sonnet-4-7',
          },
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: 'B64' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.commit-notify') {
        throw new Error('connect ECONNREFUSED');
      }
      throw new Error(`unexpected: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantText('done');
          yield resultSuccess();
          await it.next();
        })();
      },
    );
    try {
      const { main } = await import('../main.js');
      expect(await main()).toBe(0);
      // Network error: no rollback (preserve tree), no advance.
      expect(advanceBaselineMock).not.toHaveBeenCalled();
      expect(rollbackToBaselineMock).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('bootstrap failure: workspace.materialize IPC error → exit 2, no query, materialize stderr', async () => {
    // Phase 3: materialize failure is bootstrap-fatal. The runner cannot
    // operate against an undefined workspace state — better to exit loud
    // than to desync silently from the host's view of the lineage.
    setEnv(COMPLETE_ENV);
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
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') {
        throw new Error('host bundler exploded');
      }
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([]);

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(2);

      const stderrMessages = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .join('');
      expect(stderrMessages).toContain('workspace.materialize failed');
      expect(stderrMessages).toContain('host bundler exploded');

      expect(queryMock).not.toHaveBeenCalled();
      expect(fakeClient.close).toHaveBeenCalledTimes(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('bootstrap failure: materializeWorkspace throws → exit 2, no query', async () => {
    // Distinct from the IPC-error case: the IPC succeeds (bundle bytes
    // returned), but the runner-side `git clone` blows up. Same fatal
    // semantics — we can't proceed against a broken /permanent.
    setEnv(COMPLETE_ENV);
    materializeMock.mockRejectedValueOnce(new Error('git clone failed: bad bundle'));
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
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') {
        return { bundleBytes: 'malformed' };
      }
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([]);

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(2);

      const stderrMessages = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .join('');
      expect(stderrMessages).toContain('workspace.materialize failed');
      expect(stderrMessages).toContain('git clone failed: bad bundle');

      expect(queryMock).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('multi-block assistant turn: text + thinking + tool_use all flow into event.turn-end contentBlocks in order', async () => {
    setEnv(COMPLETE_ENV);
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
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('go'), cancelEntry]);

    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantBlocks([
            { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
            // Redacted-thinking blocks fire when extended-thinking is
            // flagged. Replay (Task 15) MUST preserve the opaque blob
            // (J3: Anthropic compatibility) — dropping it leaves a hole
            // the model detects on a follow-up turn.
            { type: 'redacted_thinking', data: 'opaque-blob-1' },
            { type: 'text', text: 'sure thing' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Bash',
              input: { command: 'ls' },
            },
            // Unknown block types are dropped defensively.
            { type: 'unknown_kind', whatever: true },
          ]);
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    const turnEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.turn-end',
    );
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.[1]).toEqual({
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [
        { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'opaque-blob-1' },
        { type: 'text', text: 'sure thing' },
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'Bash',
          input: { command: 'ls' },
        },
      ],
    });
  });

  it('tool_result via SDK user message → emits a separate role=tool turn-end before the assistant turn-end', async () => {
    setEnv(COMPLETE_ENV);
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
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('do work'), cancelEntry]);

    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          // Assistant fires a tool_use, runner runs it, SDK echoes the
          // result back as a user message.
          yield assistantBlocks([
            {
              type: 'tool_use',
              id: 'tu_42',
              name: 'Bash',
              input: { command: 'pwd' },
            },
          ]);
          yield userToolResult('tu_42', '/tmp/work');
          yield assistantBlocks([{ type: 'text', text: 'done' }]);
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    const turnEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.turn-end',
    );
    // Two turn-ends at this single SDK `result` boundary: tool first
    // (chronologically came before the assistant wrap-up), assistant
    // second.
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[0]?.[1]).toEqual({
      reason: 'user-message-wait',
      role: 'tool',
      contentBlocks: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_42',
          content: '/tmp/work',
          is_error: false,
        },
      ],
    });
    expect(turnEnds[1]?.[1]).toEqual({
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [
        {
          type: 'tool_use',
          id: 'tu_42',
          name: 'Bash',
          input: { command: 'pwd' },
        },
        { type: 'text', text: 'done' },
      ],
    });
  });

  it('tool_result with mixed text+image content: both blocks survive into the role=tool turn-end', async () => {
    // ToolResultBlock.content is `string | (TextBlock | ImageBlock)[]`.
    // A tool that returns image content (screenshot tool, Read on a
    // binary, etc.) loses context on replay if the runner filters
    // images out of the array — this test pins the round-trip so that
    // regression can't happen silently.
    setEnv(COMPLETE_ENV);
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
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('shoot it'), cancelEntry]);

    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantBlocks([
            {
              type: 'tool_use',
              id: 'tu_77',
              name: 'Screenshot',
              input: {},
            },
          ]);
          yield {
            type: 'user',
            parent_tool_use_id: null,
            session_id: 'sess-1',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu_77',
                  content: [
                    { type: 'text', text: 'captured' },
                    {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: 'AAA=',
                      },
                    },
                    // Unknown content-array entry types are still
                    // dropped defensively.
                    { type: 'mystery', payload: 'wat' },
                  ],
                  is_error: false,
                },
              ],
            },
          } as unknown as SDKMessage;
          yield assistantBlocks([{ type: 'text', text: 'shot' }]);
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    const turnEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.turn-end',
    );
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[0]?.[1]).toEqual({
      reason: 'user-message-wait',
      role: 'tool',
      contentBlocks: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_77',
          content: [
            { type: 'text', text: 'captured' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'AAA=',
              },
            },
          ],
          is_error: false,
        },
      ],
    });
  });

  it('empty assistant turn: turn-end fires as a heartbeat with no contentBlocks attached', async () => {
    setEnv(COMPLETE_ENV);
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
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('ping'), cancelEntry]);

    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          // No assistant message at all — straight to result.
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    const turnEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.turn-end',
    );
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.[1]).toEqual({
      reason: 'user-message-wait',
      role: 'assistant',
    });
  });

  it('emits event.stream-chunk per text + thinking block with reqId; skips redacted_thinking and tool_use', async () => {
    // Task 6: per-block streaming. The runner caches the host-minted
    // reqId from the inbox payload (J9) and stamps it onto every
    // event.stream-chunk it emits during the assistant branch. text and
    // thinking blocks stream; redacted_thinking and tool_use do NOT
    // (no human-readable text). Empty-text blocks are skipped to avoid
    // noise on the wire.
    setEnv(COMPLETE_ENV);
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
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('go', 'r42'), cancelEntry]);

    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          // Two assistant messages within the same turn:
          //   #1 — thinking + text "hello" + redacted_thinking + tool_use
          //   #2 — text "world"
          // Empty text in #2 would be skipped if present; we omit one
          // here to keep this test focused on the streaming contract.
          yield assistantBlocks([
            { type: 'thinking', thinking: 'pondering', signature: 'sig-1' },
            { type: 'text', text: 'hello' },
            { type: 'redacted_thinking', data: 'opaque' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Bash',
              input: { command: 'ls' },
            },
            // Empty-text block — must NOT emit a chunk.
            { type: 'text', text: '' },
          ]);
          yield assistantBlocks([{ type: 'text', text: 'world' }]);
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    const streamChunks = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.stream-chunk',
    );
    // Three chunks: thinking, text "hello", text "world". The empty-text
    // block, the redacted_thinking block, and the tool_use block do not
    // contribute.
    expect(streamChunks).toHaveLength(3);
    expect(streamChunks[0]?.[1]).toEqual({
      reqId: 'r42',
      text: 'pondering',
      kind: 'thinking',
    });
    expect(streamChunks[1]?.[1]).toEqual({
      reqId: 'r42',
      text: 'hello',
      kind: 'text',
    });
    expect(streamChunks[2]?.[1]).toEqual({
      reqId: 'r42',
      text: 'world',
      kind: 'text',
    });

    // The turn-end transcript still flows independently (Task 3) — the
    // stream chunks are observation-only (I4) and do NOT replace the
    // canonical contentBlocks transcript.
    const turnEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.turn-end',
    );
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.[1]).toEqual({
      reason: 'user-message-wait',
      role: 'assistant',
      contentBlocks: [
        { type: 'thinking', thinking: 'pondering', signature: 'sig-1' },
        { type: 'text', text: 'hello' },
        { type: 'redacted_thinking', data: 'opaque' },
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'Bash',
          input: { command: 'ls' },
        },
        { type: 'text', text: '' },
        { type: 'text', text: 'world' },
      ],
    });
  });

  it('stream-chunk emit failure does not terminate the runner', async () => {
    // The runner swallows event.stream-chunk failures (the host may be
    // tearing down). The chat must complete cleanly even if every chunk
    // emit rejects.
    setEnv(COMPLETE_ENV);
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
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    // Reject only event.stream-chunk; let other events resolve normally.
    fakeClient.event.mockImplementation(async (name: string) => {
      if (name === 'event.stream-chunk') {
        throw new Error('host gone');
      }
      return undefined;
    });
    fakeInbox = buildFakeInbox([userEntry('go', 'r-bad'), cancelEntry]);

    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantText('hello');
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);
  });

  it('terminated path: SDK throws mid-stream → exit 1, chat-end outcome.kind=terminated', async () => {
    setEnv(COMPLETE_ENV);
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
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('trigger'), cancelEntry]);

    queryMock.mockImplementation(() => {
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield assistantText('starting');
        throw new Error('simulated SDK failure');
      })();
    });

    const { main } = await import('../main.js');
    const rc = await main();

    expect(rc).toBe(1);

    const chatEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.chat-end',
    );
    expect(chatEnds).toHaveLength(1);
    const payload = chatEnds[0]?.[1] as {
      outcome: {
        kind: string;
        reason?: string;
        error?: { name: string; message: string; stack?: string };
      };
    };
    expect(payload.outcome.kind).toBe('terminated');
    expect(payload.outcome.reason).toBe('Error: simulated SDK failure');
    expect(payload.outcome.error?.name).toBe('Error');
    expect(payload.outcome.error?.message).toBe('simulated SDK failure');
    // The serialized error must survive JSON.stringify — an Error instance
    // would stringify to `{}`, losing all the diagnostic information the
    // host relies on when surfacing a terminated chat.
    const round = JSON.parse(JSON.stringify(payload.outcome.error));
    expect(round.message).toBe('simulated SDK failure');

    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // Task 15 (Week 10–12): replay-at-boot.
  //
  // The runner pulls the persisted transcript at boot and yields prior
  // user / tool turns into the SDK's prompt iterator BEFORE pulling the
  // first live inbox message. Assistant turns are NOT re-yielded — the
  // prompt iterator only takes user-shaped messages, and the model
  // regenerates from the user-side context.
  // ---------------------------------------------------------------------

  it('Task 15 replay: fetches history when conversationId is non-null and yields prior user turns BEFORE the live inbox (assistant + tool turns are skipped — Anthropic API requires tool_result paired with preceding tool_use)', async () => {
    setEnv(COMPLETE_ENV);
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string, payload: unknown) => {
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
          conversationId: 'cnv_resume',
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'conversation.fetch-history') {
        // Pin the request shape: conversationId from session.get-config.
        expect(payload).toEqual({ conversationId: 'cnv_resume' });
        return {
          turns: [
            {
              role: 'user',
              contentBlocks: [
                { type: 'text', text: 'first question' },
              ],
            },
            {
              role: 'assistant',
              contentBlocks: [
                { type: 'text', text: 'first answer (will not re-yield)' },
                { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } },
              ],
            },
            {
              role: 'tool',
              contentBlocks: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu_1',
                  content: 'ok',
                  is_error: false,
                },
              ],
            },
            {
              role: 'user',
              contentBlocks: [{ type: 'text', text: 'second question' }],
            },
          ],
        };
      }
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('live message'), cancelEntry]);

    // Capture the order in which the SDK saw user-shaped messages so we
    // can assert: replay turns FIRST (in order), live inbox LAST.
    const sdkSawMessages: Array<{
      role: string;
      content: unknown;
    }> = [];

    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          for await (const m of prompt) {
            sdkSawMessages.push({
              role: m.message.role,
              content: m.message.content,
            });
          }
          yield resultSuccess();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    // The runner made exactly one conversation.fetch-history call.
    const fetchCalls = fakeClient.call.mock.calls.filter(
      (c) => c[0] === 'conversation.fetch-history',
    );
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.[1]).toEqual({ conversationId: 'cnv_resume' });

    // The SDK saw replay USER turns FIRST, then the live inbox.
    // Assistant AND tool turns from the persisted transcript are NOT
    // re-yielded (Anthropic's API rejects tool_result blocks that
    // aren't paired with a preceding assistant tool_use; without the
    // SDK's resume() API, replaying tool turns is unsafe). The model
    // regenerates the tool flow from the user-side context.
    expect(sdkSawMessages).toHaveLength(3);
    // Replay user turn #1 — text-only, collapsed back to a string.
    expect(sdkSawMessages[0]).toEqual({
      role: 'user',
      content: 'first question',
    });
    // Replay user turn #2 — assistant + tool turns from the spec are
    // skipped, so user turn #2 is the second message the SDK sees.
    expect(sdkSawMessages[1]).toEqual({
      role: 'user',
      content: 'second question',
    });
    // Live inbox message LAST.
    expect(sdkSawMessages[2]).toEqual({
      role: 'user',
      content: 'live message',
    });
  });

  it('Task 15: skips fetch when conversationId is null', async () => {
    setEnv(COMPLETE_ENV);
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
          conversationId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'conversation.fetch-history') {
        throw new Error('runner must NOT fetch history when conversationId is null');
      }
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('hello'), cancelEntry]);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          for await (const _m of prompt) {
            void _m;
          }
          yield resultSuccess();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    // No fetch-history call at all.
    expect(
      fakeClient.call.mock.calls.filter(
        (c) => c[0] === 'conversation.fetch-history',
      ),
    ).toHaveLength(0);
  });

  it('Task 15: fetch-history failure is non-fatal — runner continues with empty replay', async () => {
    setEnv(COMPLETE_ENV);
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
          conversationId: 'cnv_resume',
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'conversation.fetch-history') {
        throw new Error('storage hiccup');
      }
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('live message'), cancelEntry]);

    const sdkSawMessages: Array<{ role: string; content: unknown }> = [];
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          for await (const m of prompt) {
            sdkSawMessages.push({
              role: m.message.role,
              content: m.message.content,
            });
          }
          yield resultSuccess();
        })();
      },
    );

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const { main } = await import('../main.js');
      const rc = await main();
      // Non-fatal: chat completes (rc 0), no terminated outcome.
      expect(rc).toBe(0);
      // We logged the failure to stderr.
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrText).toContain('conversation.fetch-history failed');
    } finally {
      stderrSpy.mockRestore();
    }
    // SDK only saw the live inbox message — replay was empty.
    expect(sdkSawMessages).toEqual([
      { role: 'user', content: 'live message' },
    ]);
  });

  // ---------------------------------------------------------------------
  // Phase C: runner-owned session ids.
  //
  // The Anthropic SDK emits a system/init message as the FIRST message
  // of every query() (verified against sdk.d.ts SDKSystemMessage). When
  // the runner has a bound conversation, we capture that session_id and
  // POST it to the host via `conversation.store-runner-session` so a
  // future restart can SDK.resume(sessionId) instead of replaying the
  // transcript from our database.
  //
  // Once-only semantic: a single query() call can re-emit system/init on
  // resume; only the first one is load-bearing for the bind. The handler
  // sets a flag BEFORE awaiting the IPC so a re-entrant init can't
  // double-fire.
  //
  // Non-fatal posture: if the bind IPC fails, the chat still completes.
  // We just lose the resume optimization on next restart and fall back
  // to fetch-history replay.
  // ---------------------------------------------------------------------

  describe('Phase C: runner_session_id binding', () => {
    it('happy path: bound conversation → captures system/init session_id and POSTs conversation.store-runner-session exactly once', async () => {
      setEnv(COMPLETE_ENV);
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
            conversationId: 'cnv-1',
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'conversation.fetch-history') {
          return { turns: [] };
        }
        if (action === 'conversation.store-runner-session') {
          return { ok: true };
        }
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('go'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield systemInit('sdk-sess-abc');
            yield assistantText('hi');
            yield resultSuccess();
            await it.next();
          })();
        },
      );

      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(0);

      const bindCalls = fakeClient.call.mock.calls.filter(
        (c) => c[0] === 'conversation.store-runner-session',
      );
      expect(bindCalls).toHaveLength(1);
      expect(bindCalls[0]?.[1]).toEqual({
        conversationId: 'cnv-1',
        runnerSessionId: 'sdk-sess-abc',
      });
    });

    it('no conversation: conversationId is null → no conversation.store-runner-session call', async () => {
      setEnv(COMPLETE_ENV);
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
            conversationId: null,
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'conversation.store-runner-session') {
          throw new Error(
            'runner must NOT bind sessionId when conversationId is null',
          );
        }
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('hello'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield systemInit('sdk-sess-xyz');
            yield assistantText('ok');
            yield resultSuccess();
            await it.next();
          })();
        },
      );

      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(0);

      const bindCalls = fakeClient.call.mock.calls.filter(
        (c) => c[0] === 'conversation.store-runner-session',
      );
      expect(bindCalls).toHaveLength(0);
    });

    it('multiple system/init: only the FIRST triggers the bind (re-entrant init defense)', async () => {
      // The SDK's resume(sessionId) flow can re-emit system/init within
      // the same query(). We only build resume() in a later task, but
      // the runner code path must defend today — the first init is the
      // load-bearing one for the bind.
      setEnv(COMPLETE_ENV);
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
            conversationId: 'cnv-2',
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'conversation.fetch-history') {
          return { turns: [] };
        }
        if (action === 'conversation.store-runner-session') {
          return { ok: true };
        }
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('first'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield systemInit('s1');
            yield assistantText('a');
            yield resultSuccess();
            // Synthesized: would normally only happen on a real resume.
            // The runner MUST ignore this for binding purposes.
            yield systemInit('s2');
            yield resultSuccess();
            await it.next();
          })();
        },
      );

      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(0);

      const bindCalls = fakeClient.call.mock.calls.filter(
        (c) => c[0] === 'conversation.store-runner-session',
      );
      expect(bindCalls).toHaveLength(1);
      expect(bindCalls[0]?.[1]).toEqual({
        conversationId: 'cnv-2',
        runnerSessionId: 's1',
      });
    });

    it('IPC failure is non-fatal: bind throws → stderr logs error, chat still completes with outcome.kind=complete', async () => {
      setEnv(COMPLETE_ENV);
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
            conversationId: 'cnv-3',
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'conversation.fetch-history') {
          return { turns: [] };
        }
        if (action === 'conversation.store-runner-session') {
          throw new Error('host returned 503');
        }
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('go'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield systemInit('sdk-sess-fail');
            yield assistantText('still works');
            yield resultSuccess();
            await it.next();
          })();
        },
      );

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        const { main } = await import('../main.js');
        const rc = await main();
        // Non-fatal: chat completed cleanly.
        expect(rc).toBe(0);

        const stderrText = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .join('');
        expect(stderrText).toContain(
          'conversation.store-runner-session failed',
        );
        expect(stderrText).toContain('host returned 503');
      } finally {
        stderrSpy.mockRestore();
      }

      const chatEnds = fakeClient.event.mock.calls.filter(
        (c) => c[0] === 'event.chat-end',
      );
      expect(chatEnds).toHaveLength(1);
      const payload = chatEnds[0]?.[1] as {
        outcome: { kind: string };
      };
      expect(payload.outcome.kind).toBe('complete');
    });
  });
});
