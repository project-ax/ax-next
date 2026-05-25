import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { IpcRequestError } from '@ax/ipc-protocol';
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
const materializeMock = vi.fn().mockResolvedValue({ baselineCommit: 'mock-baseline-oid' });
const commitTurnAndBundleMock = vi.fn().mockResolvedValue(null);
const advanceBaselineMock = vi.fn().mockResolvedValue(undefined);
const rollbackToBaselineMock = vi.fn().mockResolvedValue(undefined);
const resyncBaselineAndReplayMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../git-workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-workspace.js')>();
  return {
    ...actual,
    materializeWorkspace: materializeMock,
    commitTurnAndBundle: commitTurnAndBundleMock,
    advanceBaseline: advanceBaselineMock,
    rollbackToBaseline: rollbackToBaselineMock,
    resyncBaselineAndReplay: resyncBaselineAndReplayMock,
  };
});

// Mock ONLY the venv scaffold (it spawns `uv`) so these unit tests stay
// hermetic. `buildPythonVenvEnv` / `pythonVenvDir` stay real via `...actual`
// so the env-literal assertions below exercise the real env builder.
const scaffoldPythonVenvMock = vi.fn().mockResolvedValue(true);
vi.mock('../python-venv.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../python-venv.js')>();
  return { ...actual, scaffoldPythonVenv: scaffoldPythonVenvMock };
});

// Mock the transcript-flush seam. `readLastTurnUuid` defaults to undefined
// (the fake AX_WORKSPACE_ROOT has no jsonl — matching real behavior).
// `waitForTranscriptUuid` defaults to a fast no-op (true = landed) so tests
// that yield an assistant turn don't pay a real poll/timeout; the dedicated
// flush-ordering test overrides it to observe WHEN main() invokes it relative
// to the commit, and WHICH uuid it targets. The wait's real polling/timeout
// behavior is covered in turn-end-uuid.test.ts.
const readLastTurnUuidMock = vi.fn().mockResolvedValue(undefined);
const waitForTranscriptUuidMock = vi.fn().mockResolvedValue(true);
// F2a resume guard: default to "resumable" so the resume-path tests below see
// `resume` passed through; the guard test overrides it to false. The fake
// AX_WORKSPACE_ROOT has no real jsonl, so the real impl would always report
// false and strip every resume — mock it out like the other transcript reads.
const hasResumableTranscriptMock = vi.fn().mockResolvedValue(true);
vi.mock('../turn-end-uuid.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../turn-end-uuid.js')>();
  return {
    ...actual,
    readLastTurnUuid: readLastTurnUuidMock,
    waitForTranscriptUuid: waitForTranscriptUuidMock,
    hasResumableTranscript: hasResumableTranscriptMock,
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

function assistantText(text: string, uuid = 'msg-uuid'): SDKMessage {
  return {
    type: 'assistant',
    uuid,
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

function assistantBlocks(content: unknown[], uuid = 'msg-uuid'): SDKMessage {
  return {
    type: 'assistant',
    uuid,
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
  materializeMock.mockResolvedValue({ baselineCommit: 'mock-baseline-oid' });
  commitTurnAndBundleMock.mockReset();
  commitTurnAndBundleMock.mockResolvedValue(null);
  advanceBaselineMock.mockReset();
  advanceBaselineMock.mockResolvedValue(undefined);
  rollbackToBaselineMock.mockReset();
  rollbackToBaselineMock.mockResolvedValue(undefined);
  resyncBaselineAndReplayMock.mockReset();
  resyncBaselineAndReplayMock.mockResolvedValue(undefined);
  readLastTurnUuidMock.mockReset();
  readLastTurnUuidMock.mockResolvedValue(undefined);
  waitForTranscriptUuidMock.mockReset();
  waitForTranscriptUuidMock.mockResolvedValue(true);
  hasResumableTranscriptMock.mockReset();
  hasResumableTranscriptMock.mockResolvedValue(true);
  scaffoldPythonVenvMock.mockReset();
  scaffoldPythonVenvMock.mockResolvedValue(true);
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
          runnerSessionId: null,
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
      // reqId carries the inbox message's reqId so host-side per-request
      // subscribers (e.g., @ax/routines `pending.get(reqId)`) can correlate
      // back. Without this, fire rows never write and silence-token /
      // hide-conversation logic dies on the floor. See #90.
      reqId: 'req-test',
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
        allowedTools: string[];
        disallowedTools: string[];
        mcpServers: Record<string, unknown>;
        settingSources: string[];
        systemPrompt: { type: string; preset: string; append?: string };
        env: { ANTHROPIC_BASE_URL?: string; ANTHROPIC_API_KEY: string };
      };
    };
    expect(queryArg.options.disallowedTools).toEqual(
      expect.arrayContaining(['WebFetch', 'WebSearch', 'Task']),
    );
    // I-P0-1: positive guard that Skill is NOT denied. If a future refactor
    // re-adds Skill to DISABLED_BUILTINS or otherwise reintroduces a deny,
    // this assertion fails and the regression is caught here rather than in
    // the canary acceptance test.
    expect(queryArg.options.disallowedTools).not.toContain('Skill');
    // I-P0-1: Skill is in allowedTools so the SDK auto-permits it when the
    // model invokes a discovered skill.
    expect(queryArg.options.allowedTools).toContain('Skill');
    expect(queryArg.options.mcpServers).toHaveProperty('ax-host-tools');
    // I-P0-1: 'user' enables $CLAUDE_CONFIG_DIR/skills/ discovery (host-
    // controlled installed skills); 'project' enables <workspace>/.claude/
    // skills/ discovery (a narrow symlink to .ax/skills, gated by
    // validator-skill against .claude/settings.json / CLAUDE.md / etc.).
    expect(queryArg.options.settingSources).toEqual(['user', 'project']);
    expect(queryArg.options.systemPrompt).toMatchObject({
      type: 'preset',
      preset: 'claude_code',
    });
    // The workspace note is always appended (steers attachment-path resolution
    // away from home dirs); it references the `.ax/uploads/` namespace.
    expect(queryArg.options.systemPrompt.append).toContain('.ax/uploads');
    expect(queryArg.options.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(queryArg.options.env.ANTHROPIC_API_KEY).toBe(
      COMPLETE_ENV.ANTHROPIC_API_KEY,
    );

    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });

  it('per-turn commit waits for the turn FINAL assistant line (not the intermediate tool_use line) before committing (TASK-11 / keepalive durability)', async () => {
    // Regression for TASK-11 + the 1–2.5 min `conversations:get` lag under
    // idle-keepalive. The Anthropic SDK writes the turn's FINAL assistant line
    // to the jsonl AFTER yielding `result`, so the per-turn commit — which runs
    // in the `result` handler — used to stage the workspace BEFORE the reply
    // landed and ship a bundle missing it. Under keepalive the warm runner
    // doesn't drain (no final commit) until idle-reap, so the reply stayed
    // unreadable for the whole idle window.
    //
    // The original fix waited for "any NEW assistant line", but a TOOL-using
    // turn emits an INTERMEDIATE tool_use assistant line BEFORE the closing
    // text — so the wait short-circuited on the tool_use line and the commit
    // STILL dropped the closing text (the persisted `[user, tool_use,
    // tool_result]` shape in TASK-11). The fix waits for the SPECIFIC uuid of
    // the turn's LAST assistant message (SDKAssistantMessage.uuid).
    //
    // Here we drive a tool turn (tool_use msg uuid='A' → tool_result → closing
    // text msg uuid='B' → result) and assert: (1) the wait runs before the
    // commit, and (2) it targets 'B' (the final message), NOT 'A'.
    setEnv(COMPLETE_ENV);

    const order: string[] = [];
    waitForTranscriptUuidMock.mockImplementation(async () => {
      order.push('flush-wait');
      return true;
    });
    commitTurnAndBundleMock.mockImplementation(async () => {
      order.push('commit');
      return null;
    });

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
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('run date'), cancelEntry]);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          // system/init gives the runner the SDK session_id it needs to
          // locate the jsonl for the flush wait.
          yield systemInit('sdk-sess-1');
          // A tool turn: intermediate tool_use assistant line (uuid 'A')...
          yield assistantBlocks([
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'date' } },
          ], 'A-tooluse');
          // ...the SDK echoes the tool_result back as a user message...
          yield userToolResult('tu-1', 'Sun May 24 ...');
          // ...then the turn's FINAL assistant line (uuid 'B') — written lazily.
          yield assistantText('The date was Sun May 24.', 'B-closingtext');
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    const firstFlush = order.indexOf('flush-wait');
    const firstCommit = order.indexOf('commit');
    // The flush wait ran for this turn...
    expect(firstFlush).toBeGreaterThanOrEqual(0);
    // ...and the per-turn commit happened only AFTER it.
    expect(firstCommit).toBeGreaterThan(firstFlush);
    // ...and it waited for the turn's FINAL assistant uuid ('B'), NOT the
    // intermediate tool_use line ('A'). This is the TASK-11 guard.
    expect(waitForTranscriptUuidMock).toHaveBeenCalledWith(
      '/tmp/workspace',
      'sdk-sess-1',
      'B-closingtext',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(waitForTranscriptUuidMock).not.toHaveBeenCalledWith(
      '/tmp/workspace',
      'sdk-sess-1',
      'A-tooluse',
      expect.anything(),
    );
  });

  it('FAULTA-3: a FRESH first turn (runnerSessionId null) still emits a turnId on event.turn-end (uses transcriptSessionId, not the boot runnerSessionId)', async () => {
    // Regression for FAULTA-3. The turn-end emissions looked the just-written
    // turn's uuid up via `readLastTurnUuid`, gated on `runnerSessionId !== null`.
    // But `runnerSessionId` ONLY holds the resume value (null on a fresh first
    // turn), so the gate short-circuited: `readLastTurnUuid` was never called
    // and NO `turnId` rode the first turn's event.turn-end — leaving routines'
    // silence-token / `conversations:drop-turn` with nothing to refer back to.
    //
    // The transcript session id (`transcriptSessionId`, captured from
    // system/init) is the correct, present-on-a-fresh-turn source. This test
    // drives a fresh tool turn (so BOTH the role='tool' and role='assistant'
    // emissions fire) with runnerSessionId null + a system/init giving
    // session_id 'sdk-sess-1', and asserts `readLastTurnUuid` is invoked with
    // that transcript session id AND both turn-ends carry their turnId.
    setEnv(COMPLETE_ENV);
    // Distinct uuids per role so we can pin each turn-end to its own lookup.
    readLastTurnUuidMock.mockImplementation(
      async (_root: string, _sessionId: string, type: string) =>
        type === 'user' ? 'tool-turn-uuid' : 'assistant-turn-uuid',
    );
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
          // Fresh first turn: there is no prior session to resume.
          runnerSessionId: null,
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
          // system/init gives the runner the SDK session_id (transcript id).
          yield systemInit('sdk-sess-1');
          // A tool turn so the role='tool' turn-end fires too.
          yield assistantBlocks(
            [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'date' } }],
            'A-tooluse',
          );
          yield userToolResult('tu-1', '/tmp/work');
          yield assistantText('done', 'B-closingtext');
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    // The turnId lookup ran against the TRANSCRIPT session id (system/init's
    // 'sdk-sess-1'), NOT the null boot runnerSessionId — so it was actually
    // invoked on a fresh turn.
    expect(readLastTurnUuidMock).toHaveBeenCalledWith(
      '/tmp/workspace',
      'sdk-sess-1',
      'user',
    );
    expect(readLastTurnUuidMock).toHaveBeenCalledWith(
      '/tmp/workspace',
      'sdk-sess-1',
      'assistant',
    );

    const turnEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.turn-end',
    );
    // Two turn-ends at this single SDK `result` boundary: tool first, then
    // assistant — each carrying the turnId from its own lookup.
    expect(turnEnds).toHaveLength(2);
    const toolTurnEnd = turnEnds.find((c) => (c[1] as { role?: string }).role === 'tool');
    const asstTurnEnd = turnEnds.find(
      (c) => (c[1] as { role?: string }).role === 'assistant',
    );
    expect((toolTurnEnd?.[1] as { turnId?: string }).turnId).toBe('tool-turn-uuid');
    expect((asstTurnEnd?.[1] as { turnId?: string }).turnId).toBe('assistant-turn-uuid');
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
          runnerSessionId: null,
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
    // parentVersion is the materialize-time baselineCommit, not null.
    // The runner threads the materialized OID through so the host's
    // export-baseline-bundle({version: parent}) reproduces a bundle
    // whose tip matches the runner's local baseline ref. Without this,
    // the FIRST commit-notify of a session whose workspace already has
    // history fails with "Repository lacks these prerequisite commits"
    // (see the materialize/commit-notify OID-drift fix).
    expect(commitCalls[0]?.[1]).toEqual({
      parentVersion: 'mock-baseline-oid',
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
          runnerSessionId: null,
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
          runnerSessionId: null,
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
          runnerSessionId: null,
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
          runnerSessionId: null,
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
          runnerSessionId: null,
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
          runnerSessionId: null,
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
      reqId: 'req-test',
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
          runnerSessionId: null,
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
      reqId: 'req-test',
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
      reqId: 'req-test',
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

    // Live streaming surfaces both halves of the tool-call too: a
    // tool-use chunk when the model issues the call, and a tool-result
    // chunk when the SDK echoes the result back. The host's SSE handler
    // forwards these to the browser so Thread.tsx renders ToolGroup +
    // ToolFallback live, not just on history reload.
    const streamChunks = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.stream-chunk',
    );
    // Three chunks: tool-use, tool-result, then text "done".
    expect(streamChunks).toHaveLength(3);
    expect(streamChunks[0]?.[1]).toEqual({
      reqId: expect.any(String),
      kind: 'tool-use',
      toolCallId: 'tu_42',
      toolName: 'Bash',
      input: { command: 'pwd' },
    });
    expect(streamChunks[1]?.[1]).toEqual({
      reqId: expect.any(String),
      kind: 'tool-result',
      toolCallId: 'tu_42',
      output: '/tmp/work',
      isError: false,
    });
    expect(streamChunks[2]?.[1]).toEqual({
      reqId: expect.any(String),
      kind: 'text',
      text: 'done',
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
          runnerSessionId: null,
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
      reqId: 'req-test',
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
          runnerSessionId: null,
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
      reqId: 'req-test',
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
          runnerSessionId: null,
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
    // Four chunks in emission order: thinking, text "hello", tool-use,
    // text "world". The empty-text block and redacted_thinking block do
    // not contribute (no human-readable content).
    expect(streamChunks).toHaveLength(4);
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
      kind: 'tool-use',
      toolCallId: 'tu_1',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    expect(streamChunks[3]?.[1]).toEqual({
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
      reqId: 'r42',
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
          runnerSessionId: null,
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
          runnerSessionId: null,
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
  // Phase E (2026-05-09): no replay-from-DB at boot.
  //
  // The Task 15 replay path is gone. The SDK's `resume(sessionId)`
  // rehydrates the transcript from its own on-disk store
  // (~/.claude/projects/<sessionId>.jsonl, HOME-redirected into the
  // workspace by Phase C); the runner never re-emits prior user turns
  // into the prompt iterator. The bind state (`runnerSessionId`) rides
  // on the `session.get-config` response now — there's no separate
  // `conversation.fetch-history` IPC at boot.
  //
  // These tests pin the new behavior: the runner MUST NOT call
  // `conversation.fetch-history` regardless of conversationId or
  // runnerSessionId, and the SDK's prompt iterator MUST only carry
  // live inbox messages.
  // ---------------------------------------------------------------------

  it('Phase E: boot does NOT call conversation.fetch-history when conversationId is null', async () => {
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
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'conversation.fetch-history') {
        throw new Error('runner must NOT call fetch-history (Phase E)');
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

    expect(
      fakeClient.call.mock.calls.filter(
        (c) => c[0] === 'conversation.fetch-history',
      ),
    ).toHaveLength(0);
  });

  it('Phase E: boot does NOT call conversation.fetch-history when conversationId is set + runnerSessionId is null (no resume path)', async () => {
    // The runner used to fetch history here to seed the prompt iterator
    // with prior user turns. Phase E drops that path entirely — the
    // SDK starts fresh, and the prior conversation's jsonl files (if
    // any) are picked up by the workspace-jsonl reader independently.
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
          conversationId: 'cnv_fresh',
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'conversation.fetch-history') {
        throw new Error('runner must NOT call fetch-history (Phase E)');
      }
      if (action === 'conversation.store-runner-session') return { ok: true };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('go'), cancelEntry]);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield systemInit('sdk-sess-fresh');
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    expect(
      fakeClient.call.mock.calls.filter(
        (c) => c[0] === 'conversation.fetch-history',
      ),
    ).toHaveLength(0);
  });

  it('Phase E: boot does NOT call conversation.fetch-history when runnerSessionId is set (resume path)', async () => {
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
          runnerSessionId: 'sdk-sess-resume',
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'conversation.fetch-history') {
        throw new Error('runner must NOT call fetch-history (Phase E)');
      }
      if (action === 'conversation.store-runner-session') return { ok: true };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('go'), cancelEntry]);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    expect(
      fakeClient.call.mock.calls.filter(
        (c) => c[0] === 'conversation.fetch-history',
      ),
    ).toHaveLength(0);
  });

  it('Phase E: prompt iterator yields ONLY live inbox messages when runnerSessionId is null (no replay seeding)', async () => {
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
          conversationId: 'cnv_fresh',
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'conversation.store-runner-session') return { ok: true };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([
      userEntry('first'),
      userEntry('second'),
      cancelEntry,
    ]);

    const sdkSawMessages: Array<{ role: string; content: unknown }> = [];
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          for await (const m of prompt) {
            sdkSawMessages.push({
              role: m.message.role,
              content: m.message.content,
            });
            yield resultSuccess();
          }
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    // Only the live inbox messages — no prior-turn seeding.
    expect(sdkSawMessages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('Phase E: prompt iterator yields ONLY live inbox messages when runnerSessionId is set (SDK rehydrates via resume — no replay seeding)', async () => {
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
          runnerSessionId: 'sdk-sess-resume',
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'conversation.store-runner-session') return { ok: true };
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

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

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
  // We just lose the resume optimization on next restart — the SDK
  // mints a fresh session id and writes a new jsonl alongside any
  // earlier ones (Phase E read path picks them all up).
  // ---------------------------------------------------------------------

  describe('Phase C: runner_session_id binding', () => {
    it('happy path: bound conversation → captures system/init session_id and POSTs conversation.store-runner-session once, AFTER the first host-accepted turn-end commit (F2a)', async () => {
      setEnv(COMPLETE_ENV);
      // F2a: the bind is deferred to a durable commit, so the turn must
      // actually ship + get accepted for the bind to fire.
      commitTurnAndBundleMock.mockResolvedValue('YnVuZGxl');
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
            runnerSessionId: null,
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'workspace.commit-notify') {
          return { accepted: true, version: 'v1', delta: null };
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
      // The bind must come AFTER an accepted commit-notify (durability first).
      const order = fakeClient.call.mock.calls.map((c) => c[0]);
      const firstCommit = order.indexOf('workspace.commit-notify');
      const bindIdx = order.indexOf('conversation.store-runner-session');
      expect(firstCommit).toBeGreaterThanOrEqual(0);
      expect(bindIdx).toBeGreaterThan(firstCommit);
    });

    it('F2a regression: a turn killed before any commit (no accepted commit) does NOT bind — so the retry never resumes a phantom session', async () => {
      // This is the heart of F2a: binding at system/init persisted
      // runner_session_id ~1s into the turn, BEFORE the transcript was durable.
      // A turn killed in that window left a stale binding that crashed the
      // retry's query({resume}) with "No conversation found". With the bind
      // deferred to a host-accepted commit, a turn with no committed transcript
      // (commitTurnAndBundle returns null → no commit-notify) leaves the row
      // UNBOUND, so the host returns runner_session_id=null on the retry and the
      // fresh runner starts clean instead of resuming nothing.
      setEnv(COMPLETE_ENV);
      // Default commitTurnAndBundleMock → null (no diff → no commit-notify),
      // simulating a turn that never reached a durable commit.
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
            conversationId: 'cnv-killed',
            runnerSessionId: null,
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'conversation.store-runner-session') {
          throw new Error('runner must NOT bind before a durable commit (F2a)');
        }
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('go'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield systemInit('sdk-sess-phantom');
            yield assistantText('partial');
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
            runnerSessionId: null,
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

    it('multiple system/init: binds the FIRST captured session_id exactly once (re-entrant init defense)', async () => {
      // The SDK's resume(sessionId) flow can re-emit system/init within the
      // same query(). The FIRST init is the load-bearing one — its session_id
      // is captured into transcriptSessionId and a later init must NOT change
      // it. The bind itself fires once, after the first accepted commit (F2a).
      setEnv(COMPLETE_ENV);
      commitTurnAndBundleMock.mockResolvedValue('YnVuZGxl');
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
            runnerSessionId: null,
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'workspace.commit-notify') {
          return { accepted: true, version: 'v1', delta: null };
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

    it('F2a: a transient bind failure is non-fatal and self-heals on the NEXT turn’s accepted commit (final bundle is null)', async () => {
      // F2a (supersedes the Phase E FATAL posture): the bind now fires AFTER
      // the turn already streamed to the user (post-accepted-commit), so
      // terminating on a TRANSIENT bind failure would be incoherent. The
      // failure is logged and the flag left unset, so a LATER accepted commit
      // retries. This models production: the per-turn commit captures the turn,
      // the final drain commit is empty (null) — so the retry must come from
      // turn 2's commit, not the final one.
      setEnv(COMPLETE_ENV);
      // turn-1 per-turn bundle, turn-2 per-turn bundle, final drain → null.
      commitTurnAndBundleMock
        .mockResolvedValueOnce('YnVuZGxl-1')
        .mockResolvedValueOnce('YnVuZGxl-2')
        .mockResolvedValue(null);
      let bindAttempts = 0;
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
            runnerSessionId: null,
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'workspace.commit-notify') {
          return { accepted: true, version: 'v1', delta: null };
        }
        if (action === 'conversation.store-runner-session') {
          bindAttempts++;
          // Transient (NOT a 409) on the first attempt; succeeds on the second.
          if (bindAttempts === 1) throw new Error('host returned 503');
          return { ok: true };
        }
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('one'), userEntry('two'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield systemInit('sdk-sess-fail');
            yield assistantText('turn one reply');
            yield resultSuccess();
            await it.next();
            yield assistantText('turn two reply');
            yield resultSuccess();
            await it.next();
          })();
        },
      );

      const { main } = await import('../main.js');
      const rc = await main();
      // Non-fatal: the run completes despite the first bind failing.
      expect(rc).toBe(0);

      // Retried on turn 2's accepted commit and eventually bound.
      const bindCalls = fakeClient.call.mock.calls.filter(
        (c) => c[0] === 'conversation.store-runner-session',
      );
      expect(bindCalls.length).toBe(2);
      expect(bindCalls.at(-1)?.[1]).toEqual({
        conversationId: 'cnv-3',
        runnerSessionId: 'sdk-sess-fail',
      });

      // chat-end outcome is a normal completion, NOT terminated.
      const chatEnds = fakeClient.event.mock.calls.filter(
        (c) => c[0] === 'event.chat-end',
      );
      expect(chatEnds).toHaveLength(1);
      const payload = chatEnds[0]?.[1] as { outcome: { kind: string } };
      expect(payload.outcome.kind).toBe('complete');
    });

    it('F2a: a 409 bind CONFLICT is terminal — the losing runner exits 1 (terminated) instead of orphaning its transcript', async () => {
      // A concurrent fresh-boot race: another runner already bound this
      // conversation to a DIFFERENT id, so our store-runner-session is rejected
      // 409. Retrying is futile and continuing would commit an orphan
      // transcript — the run must terminate so the loser stops.
      setEnv(COMPLETE_ENV);
      commitTurnAndBundleMock.mockResolvedValue('YnVuZGxl');
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
            conversationId: 'cnv-conflict',
            runnerSessionId: null,
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'workspace.commit-notify') {
          return { accepted: true, version: 'v1', delta: null };
        }
        if (action === 'conversation.store-runner-session') {
          throw new IpcRequestError(
            'HOOK_REJECTED',
            409,
            'runner_session_id already bound to a different value for conversation',
          );
        }
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('go'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield systemInit('sdk-sess-loser');
            yield assistantText('reply');
            yield resultSuccess();
            await it.next();
          })();
        },
      );

      const { main } = await import('../main.js');
      const rc = await main();
      // Terminal: the run exits non-zero.
      expect(rc).toBe(1);

      const chatEnds = fakeClient.event.mock.calls.filter(
        (c) => c[0] === 'event.chat-end',
      );
      expect(chatEnds).toHaveLength(1);
      const payload = chatEnds[0]?.[1] as {
        outcome: { kind: string; reason?: string };
      };
      expect(payload.outcome.kind).toBe('terminated');
      expect(payload.outcome.reason).toContain('IpcRequestError');
      expect(payload.outcome.reason).toContain(
        'already bound to a different value',
      );
    });
  });

  // ---------------------------------------------------------------------
  // Phase C / Phase E: SDK resume(sessionId).
  //
  // When `runnerSessionId` is non-null on the `session.get-config`
  // response, the runner passes it as `options.resume` to `query()`.
  // The SDK rehydrates the conversation from its own on-disk transcript
  // (~/.claude/projects/<sessionId>.jsonl, HOME-redirected into the
  // workspace by Phase C) — there's no DB replay layer to consult.
  //
  // Phase E (2026-05-09): runnerSessionId now rides the
  // session.get-config response directly (composed by the host's IPC
  // handler from `conversations:get-metadata`). The separate
  // `conversation.fetch-history` IPC is gone — see the "boot does NOT
  // call conversation.fetch-history" tests above.
  // ---------------------------------------------------------------------

  describe('Phase C: SDK resume(sessionId)', () => {
    it('runnerSessionId set on session.get-config: passes options.resume to query()', async () => {
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
            conversationId: 'cnv-resume',
            runnerSessionId: 'sdk-sess-resume',
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'conversation.store-runner-session') {
          return { ok: true };
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

      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(0);

      // (a) query() got options.resume set to the runner session id.
      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { resume?: string };
      };
      expect(queryArg.options.resume).toBe('sdk-sess-resume');

      // (b) Only the live inbox reached the SDK — no replay seeding.
      // The SDK rehydrates its own conversation from disk via
      // resume(sessionId).
      expect(sdkSawMessages).toEqual([
        { role: 'user', content: 'live message' },
      ]);
    });

    it('F2a guard: runnerSessionId set but NO resumable transcript → OMITS options.resume (starts fresh, never crashes)', async () => {
      // The SDK hard-crashes (exit 1, "No conversation found with session ID")
      // if asked to resume a session whose materialized transcript has no
      // parseable user/assistant message. The runner checks
      // hasResumableTranscript first and demotes the resume to a fresh start.
      setEnv(COMPLETE_ENV);
      hasResumableTranscriptMock.mockResolvedValue(false);
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
            conversationId: 'cnv-stale',
            runnerSessionId: 'sdk-sess-missing',
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'conversation.store-runner-session') {
          return { ok: true };
        }
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield systemInit('fresh-id');
            yield assistantText('ok');
            yield resultSuccess();
            await it.next();
          })();
        },
      );

      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(0);

      // The guard was consulted with the workspace root + the bound session id.
      expect(hasResumableTranscriptMock).toHaveBeenCalledWith(
        '/tmp/workspace',
        'sdk-sess-missing',
      );
      // resume was stripped → query started fresh (no crash).
      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { resume?: string };
      };
      expect(queryArg.options.resume).toBeUndefined();
    });

    it('runnerSessionId null on session.get-config: omits options.resume', async () => {
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
            conversationId: 'cnv-fresh',
            runnerSessionId: null,
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'conversation.store-runner-session') {
          return { ok: true };
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

      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(0);

      // (a) query() did NOT get options.resume — null runnerSessionId
      // means the SDK is starting a fresh session.
      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { resume?: string };
      };
      expect(queryArg.options.resume).toBeUndefined();

      // (b) Phase E: only the live inbox reached the SDK — no replay
      // seeding, no prior turns regenerated from DB.
      expect(sdkSawMessages).toEqual([
        { role: 'user', content: 'live message' },
      ]);
    });

    it('Phase E: empty-string runnerSessionId is treated as null (no resume; defensive against malformed wire)', async () => {
      // The wire schema is `z.string().nullable()` (no `.min(1)`), so a
      // future regression or stale row could deliver `''`. Passing
      // `resume: ''` to the SDK is undefined behavior; the runner
      // coerces empty-string to null at the boundary.
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
            conversationId: 'cnv-empty-rsid',
            runnerSessionId: '', // <- the load-bearing input
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        if (action === 'conversation.store-runner-session') {
          return { ok: true };
        }
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('go'), cancelEntry]);
      queryMock.mockImplementation(() => {
        return (async function* () {
          yield systemInit('sdk-sess-fresh');
          yield resultSuccess();
        })();
      });

      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(0);

      // options.resume must be undefined — empty-string was coerced to null,
      // and the spread-conditional doesn't include `resume` on null.
      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { resume?: string };
      };
      expect(queryArg.options.resume).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // Phase C: HOME redirect for the SDK subprocess.
  //
  // The Anthropic SDK writes its native session jsonl to
  // ~/.claude/projects/<sessionId>.jsonl. In the k8s sandbox, the runner
  // pod sets HOME=/nonexistent at the pod level so `git` (and any other
  // tool the runner spawns) can't accidentally read a global ~/.gitconfig.
  // The SDK can't write its jsonl into /nonexistent, so the targeted fix
  // is to point HOME at the workspace root for the SDK subprocess only —
  // the `env:` we pass into `query({ options: { env } })`. This way the
  // jsonl lands inside the workspace where the turn-end
  // `git status + git add -A + bundle` flow captures it. The runner
  // process's own git operations still see HOME=/nonexistent because
  // we don't override their env.
  // ---------------------------------------------------------------------

  describe('Phase C: HOME redirect for SDK subprocess', () => {
    it('happy path: SDK env.HOME is set to workspaceRoot and ANTHROPIC_API_KEY is preserved', async () => {
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
            runnerSessionId: null,
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield assistantText('ok');
            yield resultSuccess();
            await it.next();
          })();
        },
      );

      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(0);

      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: {
          env: { HOME?: string; ANTHROPIC_API_KEY?: string };
        };
      };
      // HOME = workspaceRoot is for Phase C jsonl-redirect (the SDK's
      // native ~/.claude/projects/<sessionId>.jsonl writes land where
      // the turn-end git status + bundle flow captures them).
      // Skill-discovery's `'user'` root is the separately-forwarded
      // CLAUDE_CONFIG_DIR — see the I-P0-1 test below — which must NOT
      // collapse onto this HOME path.
      expect(queryArg.options.env.HOME).toBe('/tmp/workspace');
      // ANTHROPIC_API_KEY is preserved through the spread — the
      // proxyStartup.anthropicEnv merge intent is documented here so
      // a future refactor that drops the spread still trips this test.
      expect(queryArg.options.env.ANTHROPIC_API_KEY).toBe(
        COMPLETE_ENV.ANTHROPIC_API_KEY,
      );
    });

    it('HOME override is per-SDK-subprocess only: process.env.HOME is NOT mutated by main()', async () => {
      // The runner-process git operations inherit HOME=/nonexistent
      // from process.env (pod-level setting). Mutating process.env.HOME
      // here would defeat the git-paranoia posture for the runner's
      // own git operations.
      setEnv(COMPLETE_ENV);
      const homeBefore = process.env.HOME;
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
            runnerSessionId: null,
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield assistantText('ok');
            yield resultSuccess();
            await it.next();
          })();
        },
      );

      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(0);

      expect(process.env.HOME).toBe(homeBefore);
    });
  });

  describe('Python venv activation', () => {
    // Same scaffolding as the HOME-redirect happy path, but with an ephemeral
    // root + a forwarded proxy CA so buildPythonVenvEnv produces the full set.
    function venvEnv() {
      return {
        ...COMPLETE_ENV,
        AX_EPHEMERAL_ROOT: '/ephemeral',
        SSL_CERT_FILE: '/etc/ax/proxy-ca.crt',
      };
    }
    function wireClient() {
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
            runnerSessionId: null,
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield assistantText('ok');
            yield resultSuccess();
            await it.next();
          })();
        },
      );
    }

    it('activates the venv in the SDK env when scaffold succeeds', async () => {
      setEnv(venvEnv());
      scaffoldPythonVenvMock.mockResolvedValue(true);
      wireClient();

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);

      expect(scaffoldPythonVenvMock).toHaveBeenCalledWith('/ephemeral');
      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { env: Record<string, string> };
      };
      expect(queryArg.options.env.VIRTUAL_ENV).toBe('/ephemeral/py');
      expect(queryArg.options.env.PATH.startsWith('/ephemeral/py/bin:')).toBe(
        true,
      );
      expect(queryArg.options.env.PIP_CERT).toBe('/etc/ax/proxy-ca.crt');
      expect(queryArg.options.env.REQUESTS_CA_BUNDLE).toBe(
        '/etc/ax/proxy-ca.crt',
      );
    });

    it('does NOT activate the venv when scaffold fails', async () => {
      setEnv(venvEnv());
      scaffoldPythonVenvMock.mockResolvedValue(false);
      wireClient();

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);

      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { env: Record<string, string> };
      };
      expect(queryArg.options.env.VIRTUAL_ENV).toBeUndefined();
      expect(queryArg.options.env.PATH.startsWith('/ephemeral/py/bin')).toBe(
        false,
      );
    });

    it('does not scaffold or activate when no ephemeral root is wired', async () => {
      setEnv(COMPLETE_ENV); // no AX_EPHEMERAL_ROOT
      scaffoldPythonVenvMock.mockResolvedValue(true);
      wireClient();

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);

      expect(scaffoldPythonVenvMock).not.toHaveBeenCalled();
      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { env: Record<string, string> };
      };
      expect(queryArg.options.env.VIRTUAL_ENV).toBeUndefined();
    });

    it('startup does NOT block on the venv scaffold (turn proceeds while it is still pending)', async () => {
      // Regression for the cold-start stall: `uv venv --seed` fetches seed
      // wheels from pypi and stalls ~5-23s (or hangs) when pypi egress is
      // denied. The startup wait for the scaffold is BOUNDED (AX_VENV_READY_WAIT_MS,
      // 0 here) so a never-resolving scaffold (worst case) can't block the FIRST
      // turn: pre-fix `main()` awaited it unboundedly and the turn never ran
      // (test times out); post-fix the bounded race lets the turn proceed (just
      // without the venv env wired, which is fine — opt-in via `pip install`).
      setEnv({ ...venvEnv(), AX_VENV_READY_WAIT_MS: '0' });
      scaffoldPythonVenvMock.mockReturnValue(new Promise<boolean>(() => {})); // never resolves
      wireClient();

      const { main } = await import('../main.js');
      // Completes within the normal test timeout (no await on the scaffold).
      expect(await main()).toBe(0);

      // The scaffold WAS kicked off (fire-and-forget), just not awaited.
      expect(scaffoldPythonVenvMock).toHaveBeenCalledWith('/ephemeral');
      // The turn ran before the scaffold resolved, so the venv env was NOT
      // wired this turn (pythonVenvReady never flipped).
      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { env: Record<string, string> };
      };
      expect(queryArg.options.env.VIRTUAL_ENV).toBeUndefined();

      // Reset so later tests get the default resolved-true behavior.
      scaffoldPythonVenvMock.mockReset();
      scaffoldPythonVenvMock.mockResolvedValue(true);
    });

    it('bounded-wait holds for a fast (non-instant) scaffold so turn 1 gets the venv', async () => {
      // The baked-template copy isn't instantaneous (~1s in-cluster). The
      // bounded wait must hold long enough for it to resolve so the FIRST
      // turn's SDK env has the venv on PATH (otherwise `pip` is missing on
      // turn 1). Model a ~20ms scaffold under a generous budget and assert
      // VIRTUAL_ENV is wired this turn — the inverse of the never-resolves
      // case above.
      setEnv({ ...venvEnv(), AX_VENV_READY_WAIT_MS: '2000' });
      scaffoldPythonVenvMock.mockReturnValue(
        new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(true), 20);
          t.unref?.();
        }),
      );
      wireClient();

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);

      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { env: Record<string, string> };
      };
      expect(queryArg.options.env.VIRTUAL_ENV).toBe('/ephemeral/py');

      scaffoldPythonVenvMock.mockReset();
      scaffoldPythonVenvMock.mockResolvedValue(true);
    });
  });

  it('Phase 2: query receives BOTH host and sandbox MCP servers when artifact_publish is in the catalog', async () => {
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
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') {
        return {
          tools: [
            {
              name: 'artifact_publish',
              description: 'publish an artifact',
              inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
              },
              executesIn: 'sandbox',
            },
          ],
        };
      }
      if (action === 'workspace.commit-notify') {
        return { accepted: true, version: 'v1', delta: null };
      }
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([cancelEntry]);

    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
      return (async function* () {
        // Drain immediately on cancel — we only care about the query() arg shape.
        const it = prompt[Symbol.asyncIterator]();
        await it.next();
      })();
    });

    const { main } = await import('../main.js');
    await main();

    expect(queryMock).toHaveBeenCalledTimes(1);
    const queryArg = queryMock.mock.calls[0]?.[0] as {
      options: { mcpServers: Record<string, unknown> };
    };
    const serverNames = Object.keys(queryArg.options.mcpServers);
    expect(serverNames).toEqual(
      expect.arrayContaining(['ax-host-tools', 'ax-sandbox-tools']),
    );
  });

  it('Phase 2: translates attachment contentBlocks to Anthropic image blocks before yielding to SDK', async () => {
    setEnv(COMPLETE_ENV);
    fakeClient = buildFakeClient();
    const png = Buffer.from('fake-png-bytes');
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
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.read') {
        return { found: true, bytesBase64: png.toString('base64') };
      }
      if (action === 'workspace.commit-notify') {
        return { accepted: true, version: 'v1', delta: null };
      }
      throw new Error(`unexpected call: ${action}`);
    });

    // Inject a user message with an image attachment in its contentBlocks.
    const userMsgWithAttachment: InboxLoopEntry = {
      type: 'user-message',
      payload: {
        role: 'user',
        content: '',
        contentBlocks: [
          {
            type: 'attachment',
            path: '.ax/uploads/c1/t1/img.png',
            displayName: 'img.png',
            mediaType: 'image/png',
            sizeBytes: png.length,
          },
        ],
      },
      reqId: 'req-attachment',
    };
    fakeInbox = buildFakeInbox([userMsgWithAttachment, cancelEntry]);

    // Capture the user messages the SDK actually sees.
    const sdkUserMessages: SDKUserMessage[] = [];
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
      return (async function* () {
        const it = prompt[Symbol.asyncIterator]();
        const firstUser = await it.next();
        if (!firstUser.done && firstUser.value !== undefined) {
          sdkUserMessages.push(firstUser.value);
        }
        yield assistantText('ok');
        yield resultSuccess();
        await it.next();
      })();
    });

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    expect(sdkUserMessages).toHaveLength(1);
    expect((sdkUserMessages[0]!.message as { content: unknown }).content).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: png.toString('base64'),
        },
      },
    ]);

    // Confirm workspace.read was actually called for the attachment path.
    expect(fakeClient.call).toHaveBeenCalledWith('workspace.read', {
      path: '.ax/uploads/c1/t1/img.png',
    });
  });

  it('Phase 2: preserves typed user text alongside translated attachment blocks', async () => {
    setEnv(COMPLETE_ENV);
    fakeClient = buildFakeClient();
    const png = Buffer.from('fake-png-bytes');
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
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: '' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.read') {
        return { found: true, bytesBase64: png.toString('base64') };
      }
      if (action === 'workspace.commit-notify') {
        return { accepted: true, version: 'v1', delta: null };
      }
      throw new Error(`unexpected call: ${action}`);
    });

    // The future Phase 3 chat-messages handler will send BOTH typed text
    // AND attachment blocks for a single user turn. Confirm the runner
    // emits text-first then translated blocks rather than discarding text.
    const userMsg: InboxLoopEntry = {
      type: 'user-message',
      payload: {
        role: 'user',
        content: 'what is in this image?',
        contentBlocks: [
          {
            type: 'attachment',
            path: '.ax/uploads/c1/t1/img.png',
            displayName: 'img.png',
            mediaType: 'image/png',
            sizeBytes: png.length,
          },
        ],
      },
      reqId: 'req-mixed',
    };
    fakeInbox = buildFakeInbox([userMsg, cancelEntry]);

    const sdkUserMessages: SDKUserMessage[] = [];
    queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
      return (async function* () {
        const it = prompt[Symbol.asyncIterator]();
        const firstUser = await it.next();
        if (!firstUser.done && firstUser.value !== undefined) {
          sdkUserMessages.push(firstUser.value);
        }
        yield assistantText('ok');
        yield resultSuccess();
        await it.next();
      })();
    });

    const { main } = await import('../main.js');
    await main();

    expect(sdkUserMessages).toHaveLength(1);
    expect((sdkUserMessages[0]!.message as { content: unknown }).content).toEqual([
      { type: 'text', text: 'what is in this image?' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: png.toString('base64'),
        },
      },
    ]);
  });

  // ---------------------------------------------------------------------
  // Phase 0 — skill discovery (I-P0-1 / I-P0-3): the sandbox plugin
  // (subprocess or k8s) injects CLAUDE_CONFIG_DIR=<sandbox-HOME>/.ax/session
  // into the runner's own env. The runner MUST forward that value to the
  // SDK subprocess via `options.env`. If it doesn't, the SDK's `'user'`
  // setting source falls back to `<HOME>/.claude` — and because main.ts
  // overrides HOME=workspaceRoot for the Phase C jsonl redirect, `'user'`
  // would collapse onto `'project'`'s `<cwd>/.claude/` and the host-
  // installed-skills surface would be unreachable.
  //
  // The forwarding is structural — it lives in proxy-startup's
  // ENV_ALLOWLIST. This test pins the end-to-end shape by setting
  // process.env.CLAUDE_CONFIG_DIR before main() and asserting the SDK
  // sees the same value in options.env.
  // ---------------------------------------------------------------------

  describe('Phase 0: CLAUDE_CONFIG_DIR forward for skill discovery (I-P0-1)', () => {
    it('forwards CLAUDE_CONFIG_DIR from sandbox env to SDK subprocess', async () => {
      const sandboxConfigDir = '/tmp/sandbox-home-xyz/.ax/session';
      setEnv({ ...COMPLETE_ENV, CLAUDE_CONFIG_DIR: sandboxConfigDir });
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
            runnerSessionId: null,
          };
        }
        if (action === 'workspace.materialize') return { bundleBytes: '' };
        if (action === 'tool.list') return { tools: [] };
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield assistantText('ok');
            yield resultSuccess();
            await it.next();
          })();
        },
      );

      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(0);

      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: {
          env: { HOME?: string; CLAUDE_CONFIG_DIR?: string };
        };
      };
      // Skill-discovery's `'user'` root, host-owned, separate from HOME.
      // If this assertion regresses (e.g., a refactor drops the
      // ENV_ALLOWLIST entry or main.ts spreads HOME-only), the SDK falls
      // back to `<HOME>/.claude` which equals the `'project'` source path,
      // and the entire Phase 0 / Phase 1 host-installed-skills surface
      // goes silently dark.
      expect(queryArg.options.env.CLAUDE_CONFIG_DIR).toBe(sandboxConfigDir);
      // Sanity: the HOME redirect is still in place — these two env vars
      // partition the design (HOME for jsonl, CLAUDE_CONFIG_DIR for skill
      // discovery) and must NOT collapse onto each other.
      expect(queryArg.options.env.HOME).toBe('/tmp/workspace');
      expect(queryArg.options.env.CLAUDE_CONFIG_DIR).not.toBe(
        queryArg.options.env.HOME,
      );
    });
  });

  it('Phase 3 turn end: concurrent-writer advance → resync + retry → host accepts second attempt', async () => {
    // Regression for the stuck-loop bug: when workspace.commit-notify returns
    // accepted:false with actualParent+baselineBundleBytes (the concurrent-writer
    // advance case), the runner should call resyncBaselineAndReplay, re-bundle,
    // and retry the commit-notify with the new parentVersion. On accept it
    // advances baseline. True veto (no actualParent) and network errors are
    // unchanged.
    setEnv(COMPLETE_ENV);

    // First commitTurnAndBundle returns the initial bundle; after resync it
    // returns a rebased bundle.
    commitTurnAndBundleMock
      .mockResolvedValueOnce('BUNDLE_FIRST')
      .mockResolvedValueOnce('BUNDLE_REBASED');

    let commitNotifyCallCount = 0;
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
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: 'B64' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.commit-notify') {
        commitNotifyCallCount++;
        if (commitNotifyCallCount === 1) {
          // Concurrent writer advanced the mirror: resync path
          return {
            accepted: false,
            actualParent: 'newhead',
            baselineBundleBytes: 'BBBB',
          };
        }
        // Second attempt: accept
        return { accepted: true, version: 'newhead2' };
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

    // resyncBaselineAndReplay was called once with the original parentVersion
    // as oldBaseline and 'newhead' as newBaseline.
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledTimes(1);
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledWith({
      root: '/tmp/workspace',
      baselineBundleBytes: 'BBBB',
      oldBaseline: 'mock-baseline-oid',
      newBaseline: 'newhead',
    });

    // Two commit-notify calls were made.
    const commitCalls = fakeClient.call.mock.calls.filter(
      (c) => c[0] === 'workspace.commit-notify',
    );
    expect(commitCalls).toHaveLength(2);

    // First call used the original parentVersion (materialize-time OID).
    expect(commitCalls[0]?.[1]).toEqual({
      parentVersion: 'mock-baseline-oid',
      reason: 'turn',
      bundleBytes: 'BUNDLE_FIRST',
    });

    // Second call used the concurrent writer's new head as parentVersion.
    expect(commitCalls[1]?.[1]).toEqual({
      parentVersion: 'newhead',
      reason: 'turn',
      bundleBytes: 'BUNDLE_REBASED',
    });

    // After accept, baseline was advanced (not rolled back).
    expect(advanceBaselineMock).toHaveBeenCalledTimes(1);
    expect(rollbackToBaselineMock).not.toHaveBeenCalled();
  });

  it('Phase 3 turn end: concurrent-writer advance → resync → empty rebased bundle promotes parentVersion (next turn uses new baseline)', async () => {
    // Regression for the `reb === null` path: after a resync, if the rebased
    // turn produces no new commit (commitTurnAndBundle returns null) the runner
    // must promote parentVersion to the new baseline. Otherwise the NEXT turn's
    // commit-notify would send the stale parent and trigger a spurious re-sync.
    setEnv(COMPLETE_ENV);

    // Turn 1: initial bundle, then null after resync (empty rebased bundle).
    // Turn 2: a normal bundle.
    commitTurnAndBundleMock
      .mockResolvedValueOnce('BUNDLE_FIRST')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('BUNDLE_TURN2');

    let commitNotifyCallCount = 0;
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
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: 'B64' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.commit-notify') {
        commitNotifyCallCount++;
        if (commitNotifyCallCount === 1) {
          // Turn 1: concurrent writer advanced the mirror → resync envelope.
          return {
            accepted: false,
            actualParent: 'newhead',
            baselineBundleBytes: 'BBBB',
          };
        }
        // Turn 2's commit-notify accepts.
        return { accepted: true, version: 'newhead2' };
      }
      throw new Error(`unexpected: ${action}`);
    });

    fakeInbox = buildFakeInbox([userEntry('hi'), userEntry('hi2'), cancelEntry]);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next(); // pull turn 1
          yield assistantText('done1');
          yield resultSuccess();
          await it.next(); // pull turn 2
          yield assistantText('done2');
          yield resultSuccess();
          await it.next(); // pull → cancel
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    // Resync ran once for turn 1.
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledTimes(1);
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledWith({
      root: '/tmp/workspace',
      baselineBundleBytes: 'BBBB',
      oldBaseline: 'mock-baseline-oid',
      newBaseline: 'newhead',
    });

    const commitCalls = fakeClient.call.mock.calls.filter(
      (c) => c[0] === 'workspace.commit-notify',
    );
    // Turn 1 made ONE commit-notify (reb===null breaks before any retry).
    // Turn 2 made the second.
    expect(commitCalls).toHaveLength(2);
    expect(commitCalls[0]?.[1]).toEqual({
      parentVersion: 'mock-baseline-oid',
      reason: 'turn',
      bundleBytes: 'BUNDLE_FIRST',
    });
    // THE REGRESSION ASSERTION: turn 2 uses the promoted baseline ('newhead'),
    // NOT the stale 'mock-baseline-oid'.
    expect(commitCalls[1]?.[1]).toEqual({
      parentVersion: 'newhead',
      reason: 'turn',
      bundleBytes: 'BUNDLE_TURN2',
    });

    // Turn 2's accept advanced baseline; nothing was rolled back.
    expect(advanceBaselineMock).toHaveBeenCalledTimes(1);
    expect(rollbackToBaselineMock).not.toHaveBeenCalled();
  });

  it('Phase 3 turn end: concurrent-writer advance with no actualParent (true veto) → rollback, no resync', async () => {
    // A rejected commit-notify with NO actualParent is a true policy veto —
    // not a concurrent-writer race. The runner must rollback (unchanged behavior).
    setEnv(COMPLETE_ENV);
    commitTurnAndBundleMock.mockResolvedValueOnce('BUNDLE_VETO2');
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
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: 'B64' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.commit-notify') {
        // True veto: no actualParent
        return { accepted: false, reason: 'security veto' };
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
      // No resync attempted on a true veto.
      expect(resyncBaselineAndReplayMock).not.toHaveBeenCalled();
      // Rollback called.
      expect(rollbackToBaselineMock).toHaveBeenCalledTimes(1);
      expect(advanceBaselineMock).not.toHaveBeenCalled();
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrText).toContain('security veto');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('F-2: FINAL commit-notify re-syncs on a concurrent-writer advance (was log-only)', async () => {
    // Regression for F-2: the post-`result` final/idle commit used to only log
    // on !accepted, so a concurrent writer racing the final commit silently
    // dropped the final turn's tail. After the fix, the final commit runs the
    // same shared re-sync+retry helper as the per-turn commit.
    //
    // The per-turn commit produces NO bundle (commitTurnAndBundle → null), so
    // no per-turn commit-notify fires. The FINAL commit produces a bundle, the
    // host returns the concurrent-writer envelope, the helper re-syncs +
    // re-bundles + retries, and the retry is accepted.
    setEnv(COMPLETE_ENV);
    commitTurnAndBundleMock
      .mockResolvedValueOnce(null) // per-turn: empty → no per-turn commit-notify
      .mockResolvedValueOnce('BUNDLE_FINAL') // final commit
      .mockResolvedValueOnce('BUNDLE_FINAL_REBASED'); // re-bundle after resync

    let commitNotifyCallCount = 0;
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
          runnerSessionId: null,
        };
      }
      if (action === 'workspace.materialize') return { bundleBytes: 'B64' };
      if (action === 'tool.list') return { tools: [] };
      if (action === 'workspace.commit-notify') {
        commitNotifyCallCount++;
        if (commitNotifyCallCount === 1) {
          // Concurrent writer advanced the mirror under the final commit.
          return {
            accepted: false,
            actualParent: 'v2',
            baselineBundleBytes: 'BBBB',
          };
        }
        return { accepted: true, version: 'v2' };
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
    expect(await main()).toBe(0);

    // The FINAL commit re-synced exactly once, against the materialize baseline.
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledTimes(1);
    expect(resyncBaselineAndReplayMock).toHaveBeenCalledWith({
      root: '/tmp/workspace',
      baselineBundleBytes: 'BBBB',
      oldBaseline: 'mock-baseline-oid',
      newBaseline: 'v2',
    });

    const commitCalls = fakeClient.call.mock.calls.filter(
      (c) => c[0] === 'workspace.commit-notify',
    );
    // Two commit-notify calls: the rejected final + the accepted retry.
    expect(commitCalls).toHaveLength(2);
    expect(commitCalls[0]?.[1]).toEqual({
      parentVersion: 'mock-baseline-oid',
      reason: 'turn',
      bundleBytes: 'BUNDLE_FINAL',
    });
    // The retry used the concurrent writer's new head + the re-bundle.
    expect(commitCalls[1]?.[1]).toEqual({
      parentVersion: 'v2',
      reason: 'turn',
      bundleBytes: 'BUNDLE_FINAL_REBASED',
    });

    expect(advanceBaselineMock).toHaveBeenCalledTimes(1);
    expect(rollbackToBaselineMock).not.toHaveBeenCalled();
  });
});
