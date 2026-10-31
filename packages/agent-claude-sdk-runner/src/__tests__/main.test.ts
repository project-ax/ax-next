import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AttachmentsListResponseSchema, IpcRequestError } from '@ax/ipc-protocol';
import type { IpcClient, IpcClientOptions } from '@ax/ipc-protocol';
import type {
  InboxLoop,
  InboxLoopEntry,
  InboxLoopOptions,
} from '@ax/agent-runner-core';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from 'vitest';
import { HELD_TOOL_RESULT_TEXT } from '../held-calls.js';

// What `@ax/decisions` writes for the MODEL when it holds a call, and what the
// CLI therefore hands back as the tool_result content. Kept verbatim-ish here
// (shape, not exact wording) because the point of the TASK-260 test is that
// NONE of it reaches the human's transcript.
const MODEL_HOLD_NOTE =
  'Held for approval (dec_abc123). Do not retry it and do not look for another way to do the same thing. Tell the user what you were about to do.';

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
  callBinary: Mock;
  callBinaryUpload: Mock;
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

// Mock the venv scaffold (it spawns `uv`) and `createInboxLoop` (session-start
// inbox wiring) so these unit tests stay hermetic. `buildPythonVenvEnv` /
// `pythonVenvDir` stay real (a separate module) so the env-literal assertions
// below exercise the real env builder.
//
// TASK-67 runner-core extraction (task 8): the boot sequence these back now
// runs inside @ax/agent-runner-core's own `run-runner.ts`, which imports its
// siblings by relative path (`./python-venv.js`, …), so a mock on the package
// BARREL would never be reached. Each of these targets the explicitly-declared internal subpath (see that
// package's `exports` map), which is the same module identity the barrel
// re-export and run-runner.ts's relative import both resolve to.
const scaffoldPythonVenvMock = vi.fn().mockResolvedValue(true);
// TASK-67 (runner-core extraction): shipTranscriptDelta / restoreTranscriptForResume
// moved into @ax/agent-runner-core's barrel alongside everything else this suite
// mocks at that specifier. These are wire-shape tests (no real jsonl on disk), so
// we mock the functions here — their real fs/IPC behavior is covered in
// transcript-delta.test.ts (now in @ax/agent-runner-core). Defaults model the
// happy path: the per-turn ship 'appended' (so the F2a bind fires), and resume
// rebuilds a real transcript ('written: true'). The F2a-guard test overrides
// restore to 'written: false'.
const shipTranscriptDeltaMock = vi.fn().mockResolvedValue({
  outcome: 'appended',
  sentOffset: 10,
  sentSeq: 1,
});
const restoreTranscriptForResumeMock = vi.fn().mockResolvedValue({
  written: true,
  state: { sentOffset: 10, sentSeq: 1 },
});
vi.mock('@ax/agent-runner-core/internal/python-venv.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@ax/agent-runner-core/internal/python-venv.js')>();
  return { ...actual, scaffoldPythonVenv: scaffoldPythonVenvMock };
});
vi.mock('@ax/agent-runner-core/internal/inbox-loop.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@ax/agent-runner-core/internal/inbox-loop.js')>();
  return {
    ...actual,
    createInboxLoop: (opts: InboxLoopOptions): InboxLoop => {
      createInboxLoopMock(opts);
      return fakeInbox;
    },
  };
});
vi.mock('@ax/agent-runner-core/internal/transcript-delta.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@ax/agent-runner-core/internal/transcript-delta.js')>();
  return {
    ...actual,
    shipTranscriptDelta: shipTranscriptDeltaMock,
    restoreTranscriptForResume: restoreTranscriptForResumeMock,
  };
});

// TranscriptSource split (runner-core extraction fix round 2): main() builds
// ONE `transcriptSource` (the transcript directory, slugged by the SDK's cwd,
// which is the agent's home) and threads it into every
// shipTranscriptDelta/restoreTranscriptForResume call. shipTranscriptDelta /
// restoreTranscriptForResume are mocked wholesale above, so nothing exercises
// the source's real read()/write() closures in this suite — but a
// regression that built the source from the wrong root (or diverged the
// restore source from the ship sources) would be invisible without this spy.
// Wraps the real factory (harmless — its output is never invoked here) so we
// can assert what root main() actually passed.
const createJsonlTranscriptSourceSpy = vi.fn();
vi.mock('../jsonl-transcript-source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../jsonl-transcript-source.js')>();
  return {
    ...actual,
    createJsonlTranscriptSource: (transcriptDir: string, sdkCwd: string) => {
      createJsonlTranscriptSourceSpy(transcriptDir, sdkCwd);
      return actual.createJsonlTranscriptSource(transcriptDir, sdkCwd);
    },
  };
});

// Mock the transcript-flush seam. `readLastTurnUuid` defaults to undefined
// (the fake transcript directory has no jsonl — matching real behavior).
// `waitForTranscriptUuid` defaults to a fast no-op (true = landed) so tests
// that yield an assistant turn don't pay a real poll/timeout; the dedicated
// flush-ordering test overrides it to observe WHEN main() invokes it relative
// to the transcript ship, and WHICH uuid it targets. The wait's real polling/timeout
// behavior is covered in turn-end-uuid.test.ts.
const readLastTurnUuidMock = vi.fn().mockResolvedValue(undefined);
const waitForTranscriptUuidMock = vi.fn().mockResolvedValue(true);
// F2a resume guard: default to "resumable" so the resume-path tests below see
// `resume` passed through; the guard test overrides it to false. The fake
// transcript directory has no real jsonl, so the real impl would always report
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

// TASK-994: the runner refuses to start unless CLAUDE_CONFIG_DIR names an
// existing directory outside the agent's home — the sandbox always provides
// one. A real runner-private temp dir stands in for it.
const CONFIG_DIR = mkdtempSync(nodePath.join(os.tmpdir(), 'ax-main-cfg-'));
afterAll(async () => {
  await fs.rm(CONFIG_DIR, { recursive: true, force: true });
});

// TASK-995: the agent's home (AX_USERFILES_ROOT) and the session scratch root
// (AX_EPHEMERAL_ROOT) are required; there is no fallback for either. Real
// directories, so anything the runner writes lands inside this suite's temp
// dir. The home stays empty: nothing the runner does writes there (the §11
// tests below check that against a home with files in it).
const SANDBOX_DIR = mkdtempSync(nodePath.join(os.tmpdir(), 'ax-main-sbx-'));
const HOME_DIR = nodePath.join(SANDBOX_DIR, 'files');
const SCRATCH_DIR = nodePath.join(SANDBOX_DIR, 'tmp');
mkdirSync(HOME_DIR);
mkdirSync(SCRATCH_DIR);
afterAll(async () => {
  await fs.rm(SANDBOX_DIR, { recursive: true, force: true });
});

const COMPLETE_ENV = {
  AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
  AX_SESSION_ID: 'sess-1',
  AX_AUTH_TOKEN: 'tok-123',
  AX_USERFILES_ROOT: HOME_DIR,
  AX_EPHEMERAL_ROOT: SCRATCH_DIR,
  AX_PROXY_ENDPOINT: 'http://127.0.0.1:8443',
  AX_PROXY_TOKEN: 'feedfacefeedfacefeedfacefeedface',
  ANTHROPIC_API_KEY: 'ax-cred:0123456789abcdef0123456789abcdef',
  CLAUDE_CONFIG_DIR: CONFIG_DIR,
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
    // Binary calls stream to or from a temp file. A plain turn makes none:
    // `blob.get` (an upload copied into the scratch root) is the only one a
    // test here expects, and that test answers it itself. Anything else is a
    // setup bug, so say which action it was.
    callBinary: vi.fn().mockImplementation(async (action: string) => {
      throw new Error(`unexpected binary call: ${action}`);
    }),
    callBinaryUpload: vi.fn().mockImplementation(async (action: string) => {
      throw new Error(`unexpected upload: ${action}`);
    }),
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
    cwd: HOME_DIR,
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

/** The CLI's `--replay-user-messages` echo of a message it consumed. */
function replayOf(sent: SDKUserMessage): SDKMessage {
  return {
    type: 'user',
    message: sent.message,
    parent_tool_use_id: null,
    session_id: 'sess-1',
    uuid: sent.uuid!,
    isReplay: true,
  } as SDKMessage;
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

// The assistant fixtures above carry an all-zero `usage` block, so a turn built
// from them reports zero tokens on the model the test configures (TASK-692).
const ZERO_USAGE = {
  model: 'anthropic/claude-sonnet-4-7',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

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
  readLastTurnUuidMock.mockReset();
  readLastTurnUuidMock.mockResolvedValue(undefined);
  waitForTranscriptUuidMock.mockReset();
  waitForTranscriptUuidMock.mockResolvedValue(true);
  hasResumableTranscriptMock.mockReset();
  hasResumableTranscriptMock.mockResolvedValue(true);
  shipTranscriptDeltaMock.mockReset();
  shipTranscriptDeltaMock.mockResolvedValue({
    outcome: 'appended',
    sentOffset: 10,
    sentSeq: 1,
  });
  restoreTranscriptForResumeMock.mockReset();
  restoreTranscriptForResumeMock.mockResolvedValue({
    written: true,
    state: { sentOffset: 10, sentSeq: 1 },
  });
  createJsonlTranscriptSourceSpy.mockClear();
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
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

    // Two JSON calls at boot: session.get-config + tool.list. Nothing streams
    // as a binary either way (TASK-995: no workspace to materialize at boot or
    // to bundle at the turn boundary).
    expect(fakeClient.call).toHaveBeenCalledTimes(2);
    expect(fakeClient.call).toHaveBeenCalledWith('session.get-config', {});
    expect(fakeClient.call).toHaveBeenCalledWith('tool.list', {});
    expect(fakeClient.callBinary).not.toHaveBeenCalled();
    expect(fakeClient.callBinaryUpload).not.toHaveBeenCalled();

    const turnEnds = fakeClient.event.mock.calls.filter(
      // Exclude the TASK-66 user display turn-end (role:'user', emitted when
      // the runner pulls the inbox message) — these assertions target the
      // tool/assistant turn-ends. The user turn-end has its own test.
      (c) =>
        c[0] === 'event.turn-end' &&
        (c[1] as { role?: string }).role !== 'user',
    );
    // One assistant turn-end carrying the text contentBlock so
    // @ax/conversations can persist it (Task 3 of Week 10–12).
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.[1]).toEqual({
      reason: 'user-message-wait',
      role: 'assistant',
      usage: ZERO_USAGE,
      // reqId carries the inbox message's reqId so host-side per-request
      // subscribers (e.g., @ax/routines `pending.get(reqId)`) can correlate
      // back. Without this, fire rows never write and silence-token /
      // hide-conversation logic dies on the floor. See #90.
      reqId: 'req-test',
      contentBlocks: [{ type: 'text', text: 'hello world' }],
    });

    // TASK-66: the runner does NOT emit a user `event.turn-end` (the user turn
    // is persisted to the display log host-side by the orchestrator). Confirm
    // no role:'user' turn-end is shipped — guarding against the SSE-close /
    // clear-reqId side effects a chat:turn-end on the user turn would cause.
    const userTurnEnds = fakeClient.event.mock.calls.filter(
      (c) =>
        c[0] === 'event.turn-end' &&
        (c[1] as { role?: string }).role === 'user',
    );
    expect(userTurnEnds).toHaveLength(0);

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
        model: string;
        allowedTools: string[];
        disallowedTools: string[];
        mcpServers: Record<string, unknown>;
        settingSources: string[];
        systemPrompt: string;
        env: {
          ANTHROPIC_BASE_URL?: string;
          ANTHROPIC_API_KEY: string;
          HOME?: string;
          PATH?: string;
          TERM?: string;
          COLUMNS?: string;
          LINES?: string;
          FORCE_COLOR?: string;
          CI?: string;
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
          DISABLE_TELEMETRY?: string;
          DISABLE_ERROR_REPORTING?: string;
        };
      };
    };
    expect(queryArg.options.disallowedTools).toEqual(
      expect.arrayContaining(['WebFetch', 'WebSearch', 'Task', 'AskUserQuestion']),
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
    // PR 2 (provider-agnostic model refs): agentConfig.model is a
    // `provider/model-id` ref (`anthropic/claude-sonnet-4-7` — set in the
    // fake session.get-config response above). The SDK's own `model` option
    // wants the raw Anthropic id with the `anthropic/` prefix stripped.
    expect(queryArg.options.model).toBe('claude-sonnet-4-7');
    // Phase 3: 'user' is the SOLE source — $CLAUDE_CONFIG_DIR/skills/ (host-
    // controlled read-only projection, 0555). 'project' was dropped because it
    // would load `.claude/**`, `CLAUDE.md` and `.mcp.json` from the agent's
    // home, which the agent writes freely — skills there would bypass the host
    // projection and its quarantine gate.
    expect(queryArg.options.settingSources).toEqual(['user']);
    // TASK-142: the composed system prompt is always a plain STRING now (the
    // SDK-preset / string-fallback path was removed). With no identity in the
    // session config, the runner composes normal mode with the displayName fallback
    // identity line + the operational notes.
    expect(typeof queryArg.options.systemPrompt).toBe('string');
    expect(queryArg.options.systemPrompt).toContain(
      'You are Test Agent, a helpful personal assistant.',
    );
    // The files note is always present (TASK-995): it names the agent's home
    // and the scratch `uploads/` directory holding the files shared in this
    // chat, and nothing of the retired `.ax/` tree.
    expect(queryArg.options.systemPrompt).toContain('is your home and working directory');
    expect(queryArg.options.systemPrompt).toContain('/uploads/`');
    expect(queryArg.options.systemPrompt).not.toContain('.ax/');
    expect(queryArg.options.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(queryArg.options.env.ANTHROPIC_API_KEY).toBe(
      COMPLETE_ENV.ANTHROPIC_API_KEY,
    );

    // TASK-19: the SDK subprocess runs with HOME = the agent's home, and
    // `$HOME/bin` (in the durable home, so binaries the agent installs there
    // persist between sessions) must be on PATH — APPENDED at
    // the END (not prepended: $HOME is model-writable + restored, so a leading
    // entry would let an injected binary shadow trusted tools — I5). The SDK
    // Bash tool is a non-interactive shell that never sources a .bashrc, so
    // this env PATH is the load-bearing mechanism. A regression that drops the
    // $HOME/bin append fails here.
    expect(queryArg.options.env.HOME).toBe(COMPLETE_ENV.AX_USERFILES_ROOT);
    expect(queryArg.options.env.PATH).toBeDefined();
    expect(
      queryArg.options.env.PATH?.endsWith(
        `:${COMPLETE_ENV.AX_USERFILES_ROOT}/bin`,
      ),
    ).toBe(true);
    // And it must NOT be at the front (the shadowing guard).
    expect(
      queryArg.options.env.PATH?.startsWith(
        `${COMPLETE_ENV.AX_USERFILES_ROOT}/bin:`,
      ),
    ).toBe(false);

    // TASK-26: terminal-hint env reaches the SDK Bash tool's child so
    // TTY-detecting CLIs (cliffy/Deno, ink, chalk, CI-aware tools) emit
    // output in the detached, no-controlling-TTY sandbox shell. A regression
    // that drops the buildTtyHintEnv() spread fails here.
    //
    // FORCE_COLOR / CI are NOT in proxy-startup ENV_ALLOWLIST, so the
    // buildTtyHintEnv() default is never overridden by a forwarded value —
    // assert the exact value.
    expect(queryArg.options.env.FORCE_COLOR).toBe('1');
    expect(queryArg.options.env.CI).toBe('1');
    // TERM / COLUMNS / LINES ARE in the allowlist, so a real forwarded value
    // (e.g. the test host's TTY TERM) wins over the default FLOOR by design
    // (spread-FIRST, "floor not clamp"). The production sandbox has no TTY, so
    // these resolve to the buildTtyHintEnv() defaults; either way the contract
    // is that the Bash child always SEES them (never undefined). Assert
    // presence, not the exact default.
    expect(queryArg.options.env.TERM).toBeDefined();
    expect(queryArg.options.env.TERM?.length).toBeGreaterThan(0);
    expect(queryArg.options.env.COLUMNS).toBeDefined();
    expect(queryArg.options.env.LINES).toBeDefined();

    // TASK-55: the runner MUST spawn the SDK with telemetry / error-reporting
    // disabled so the vendored claude CLI never phones home to datadoghq.com
    // (which otherwise raised a phantom reactive egress-wall card every JIT
    // session). These flags are spread AFTER ...proxyStartup.providerEnv as a
    // non-negotiable security floor; none are in proxy-startup's ENV_ALLOWLIST,
    // so a forwarded value can't override them — assert the exact '1'. A
    // regression that drops the buildTelemetryEnv() spread (re-enabling the
    // egress) fails here.
    expect(
      queryArg.options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    ).toBe('1');
    expect(queryArg.options.env.DISABLE_TELEMETRY).toBe('1');
    expect(queryArg.options.env.DISABLE_ERROR_REPORTING).toBe('1');

    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });

  // TASK-708: a message that reaches the CLI mid-turn can be folded into the
  // running turn — one `result` answers both, so the second message's reqId
  // never gets a turn-end of its own. The CLI says so only when asked
  // (`--replay-user-messages`): it echoes the message, by the uuid we gave it,
  // before the running turn's result. The loop must ask, must name each
  // message, and must hand the echo to the shell, which lists the folded reqId
  // on the turn-ends of the turn that answered it.
  it('a message folded into the running turn is named on that turn\'s turn-ends (TASK-708)', async () => {
    setEnv(COMPLETE_ENV);
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([
      userEntry('run the slow thing', 'req-a'),
      userEntry('also, what is 2+2?', 'req-b'),
      cancelEntry,
    ]);
    const yieldedUuids: Array<string | undefined> = [];
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
        (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          const a = await it.next();
          yieldedUuids.push((a.value as SDKUserMessage).uuid);
          yield { ...replayOf(a.value as SDKUserMessage) };
          yield assistantText('running it');
          // The second message arrives mid-turn and the CLI folds it in.
          const b = await it.next();
          yieldedUuids.push((b.value as SDKUserMessage).uuid);
          yield { ...replayOf(b.value as SDKUserMessage) };
          yield resultSuccess();
          await it.next();
        })(),
    );

    const { main } = await import('../main.js');
    expect(await main()).toBe(0);

    const queryArg = queryMock.mock.calls[0]?.[0] as {
      options: { extraArgs?: Record<string, string | null> };
    };
    expect(queryArg.options.extraArgs).toEqual({ 'replay-user-messages': null });
    // Each message went to the SDK under its own id.
    expect(yieldedUuids).toHaveLength(2);
    expect(new Set(yieldedUuids).size).toBe(2);
    for (const u of yieldedUuids) expect(typeof u).toBe('string');

    const turnEnds = fakeClient.event.mock.calls
      .filter((c) => c[0] === 'event.turn-end')
      .map((c) => c[1] as { reqId?: string; foldedReqIds?: string[]; contentBlocks?: unknown });
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]).toMatchObject({ reqId: 'req-a', foldedReqIds: ['req-b'] });
    // A replay publishes nothing of its own: the person's words are not
    // re-emitted as turn content.
    expect(turnEnds[0]?.contentBlocks).toEqual([{ type: 'text', text: 'running it' }]);
  });

  // PR 2 (provider-agnostic model refs, docs/plans/2026-08-18-provider-
  // agnostic-runner-design.md §6): this runner drives the Claude Agent SDK,
  // which only ever talks to api.anthropic.com. A non-Anthropic model ref on
  // agentConfig (e.g. an operator selected an OpenRouter model for an agent
  // still bound to the claude-sdk runner) must fail the turn loudly rather
  // than silently running some other model — or silently running the
  // Anthropic default — under a config that named a different provider.
  it('agentConfig.disallowedTools reaches the SDK disallowedTools option (mapped), host-catalog denies stay out', async () => {
    setEnv(COMPLETE_ENV);
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            disallowedTools: ['Bash', 'web_search', 'mcp.c0123456789.x'],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
        (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantText('ok');
          yield resultSuccess();
          await it.next();
        })(),
    );

    const { main } = await import('../main.js');
    expect(await main()).toBe(0);
    const opts = (queryMock.mock.calls[0]?.[0] as { options: { disallowedTools: string[] } })
      .options;
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining(['WebFetch', 'WebSearch', 'Task', 'AskUserQuestion', 'Bash', 'mcp__c0123456789__x']),
    );
    expect(opts.disallowedTools).not.toContain('web_search');
    expect(opts.disallowedTools).not.toContain('Skill');
  });

  it('non-Anthropic model provider: fails the turn with a clear error, never calls query()', async () => {
    setEnv(COMPLETE_ENV);
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'openrouter/x-ai/grok-4.6',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);

    const { main } = await import('../main.js');
    const rc = await main();

    // Same fatal-error contract as any other loop.run() throw (e.g. the
    // "terminated path: SDK throws mid-stream" test above): exit 1,
    // chat-end outcome.kind='terminated', carrying the error text.
    expect(rc).toBe(1);
    expect(queryMock).not.toHaveBeenCalled();

    const chatEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.chat-end',
    );
    expect(chatEnds).toHaveLength(1);
    const payload = chatEnds[0]?.[1] as {
      outcome: {
        kind: string;
        reason?: string;
        error?: { name: string; message: string };
      };
    };
    expect(payload.outcome.kind).toBe('terminated');
    // Specific text, not just "it threw something": names the offending
    // ref, the unsupported provider, and this runner's Anthropic-only
    // limitation.
    expect(payload.outcome.error?.message).toContain(
      'openrouter/x-ai/grok-4.6',
    );
    expect(payload.outcome.error?.message).toContain('openrouter');
    expect(payload.outcome.error?.message).toContain('Anthropic');
  });

  // PR 4 (provider layer): the ANTHROPIC_API_KEY placeholder assert MOVED
  // here from @ax/agent-runner-core's setupProxy(), which runs before
  // `session.get-config` and so cannot know the agent's provider — an
  // unconditional requirement there killed every OpenRouter-only session at
  // boot. It did not VANISH: this runner drives the Claude Agent SDK and
  // always talks to api.anthropic.com, so a missing or real-looking key is
  // still a hard turn failure. Table-driven over the same shapes the old
  // core test covered.
  const badAnthropicKeys: Array<[label: string, value: string | undefined]> = [
    ['missing entirely', undefined],
    ['a real-looking sk-ant- key', 'sk-ant-real-looking-key'],
    ['a truncated placeholder', 'ax-cred:short'],
    ['a non-hex placeholder', 'ax-cred:0123456789abcdef0123456789abcdeg'],
    ['an uppercase-hex placeholder', 'ax-cred:0123456789ABCDEF0123456789ABCDEF'],
    ['a wrong-case prefix', 'AX-CRED:0123456789abcdef0123456789abcdef'],
  ];
  for (const [label, value] of badAnthropicKeys) {
    it(`ANTHROPIC_API_KEY ${label}: fails the turn naming the var and the ax-cred:<32-hex> shape, never calls query()`, async () => {
      setEnv({ ...COMPLETE_ENV, ANTHROPIC_API_KEY: value });
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-6',
              runner: 'claude-sdk',
            },
            conversationId: null,
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);

      const { main } = await import('../main.js');
      const rc = await main();

      expect(rc).toBe(1);
      // I1: the SDK is never constructed with a key of the wrong shape.
      expect(queryMock).not.toHaveBeenCalled();

      const chatEnds = fakeClient.event.mock.calls.filter(
        (c) => c[0] === 'event.chat-end',
      );
      expect(chatEnds).toHaveLength(1);
      const payload = chatEnds[0]?.[1] as {
        outcome: { kind: string; error?: { name: string; message: string } };
      };
      expect(payload.outcome.kind).toBe('terminated');
      expect(payload.outcome.error?.message).toContain('ANTHROPIC_API_KEY');
      expect(payload.outcome.error?.message).toContain('ax-cred:<32-hex>');
    });
  }

  // HR1 (filestore-user-files design §7.1 / TASK-165): a durable user-files mount
  // (AX_USERFILES_ROOT, e.g. /files) must NEVER become an SDK setting/skill-
  // discovery source. It's granted to the file TOOLS via `additionalDirectories`
  // (so the agent can read/write it), but `settingSources` stays `['user']` — the
  // sole skill-discovery path is the host's read-only `$CLAUDE_CONFIG_DIR/skills`
  // projection. A draft on /files/.skill-draft/ stays inert until skill.propose
  // promotes it. If a regression added /files as a skill source, a draft on
  // durable SHARED NFS would be discovered + executed un-gated — this guards it.
  it('with AX_USERFILES_ROOT set, /files reaches the file tools but is NEVER a skill/setting source (HR1)', async () => {
    // The home must exist (the runner refuses to start otherwise), so this is
    // the suite's real home dir, which is named `files` like the k8s mount.
    setEnv({ ...COMPLETE_ENV });
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
      // Advertise skill_propose so the draft executor is wired this session.
      if (action === 'tool.list') {
        return {
          tools: [{ name: 'skill_propose', executesIn: 'sandbox', inputSchema: {} }],
        };
      }
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
        (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantText('ok');
          yield resultSuccess();
          await it.next();
        })(),
    );

    const { main } = await import('../main.js');
    expect(await main()).toBe(0);

    const queryArg = queryMock.mock.calls[0]?.[0] as {
      options: {
        settingSources: string[];
        additionalDirectories?: string[];
        cwd: string;
        systemPrompt: string;
      };
    };
    // The sole skill/setting source stays 'user' — the home is NOT added.
    expect(queryArg.options.settingSources).toEqual(['user']);
    expect(queryArg.options.settingSources).not.toContain('project');
    expect(queryArg.options.settingSources).not.toContain(HOME_DIR);
    // It IS reachable by the file tools (durable read/write): /files is the
    // SDK's cwd and HOME (TASK-164), which the SDK always grants, so it is not
    // listed again — the scratch root is the only additional directory. Either
    // way HR1 holds: reachable by tools, never a source.
    expect(queryArg.options.cwd).toBe(HOME_DIR);
    expect(queryArg.options.additionalDirectories).toEqual([COMPLETE_ENV.AX_EPHEMERAL_ROOT]);
    // The skill-draft prefix advertised to the model is rooted at the DURABLE
    // mount (drafts persist), not the ephemeral tier.
    expect(queryArg.options.systemPrompt).toContain(`${HOME_DIR}/.skill-draft/<id>/`);
  });

  it('the per-turn transcript ship waits for the turn FINAL assistant line (not the intermediate tool_use line) (TASK-11 / keepalive durability)', async () => {
    // Regression for TASK-11 + the 1–2.5 min `conversations:get` lag under
    // idle-keepalive. The Anthropic SDK writes the turn's FINAL assistant line
    // to the jsonl AFTER yielding `result`, so the per-turn transcript ship —
    // which runs at the `result` boundary — used to read the jsonl BEFORE the
    // reply landed and ship a delta missing it. Under keepalive the warm
    // runner doesn't drain (no final ship) until idle-reap, so the reply
    // stayed unreadable for the whole idle window.
    //
    // The original fix waited for "any NEW assistant line", but a TOOL-using
    // turn emits an INTERMEDIATE tool_use assistant line BEFORE the closing
    // text — so the wait short-circuited on the tool_use line and the ship
    // STILL dropped the closing text (the persisted `[user, tool_use,
    // tool_result]` shape in TASK-11). The fix waits, in the loop's
    // `beforeTranscriptShip` seam, for the SPECIFIC uuid of the turn's LAST
    // assistant message (SDKAssistantMessage.uuid).
    //
    // Here we drive a tool turn (tool_use msg uuid='A' → tool_result → closing
    // text msg uuid='B' → result) and assert: (1) the wait runs before the
    // ship, and (2) it targets 'B' (the final message), NOT 'A'.
    setEnv(COMPLETE_ENV);

    const order: string[] = [];
    waitForTranscriptUuidMock.mockImplementation(async () => {
      order.push('flush-wait');
      return true;
    });
    shipTranscriptDeltaMock.mockImplementation(async () => {
      order.push('ship');
      return { outcome: 'appended', sentOffset: 10, sentSeq: 1 };
    });

    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          // Bound to a conversation, so the turn's transcript ships.
          conversationId: 'cnv-flush',
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      if (action === 'attachments.list') return { files: [] };
      if (action === 'conversation.store-runner-session') return { ok: true };
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
    const firstShip = order.indexOf('ship');
    // The flush wait ran for this turn...
    expect(firstFlush).toBeGreaterThanOrEqual(0);
    // ...and the per-turn transcript ship happened only AFTER it.
    expect(firstShip).toBeGreaterThan(firstFlush);
    // ...and it waited for the turn's FINAL assistant uuid ('B'), NOT the
    // intermediate tool_use line ('A'). This is the TASK-11 guard.
    expect(waitForTranscriptUuidMock).toHaveBeenCalledWith(
      `${CONFIG_DIR}/projects`,
      'sdk-sess-1',
      'B-closingtext',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(waitForTranscriptUuidMock).not.toHaveBeenCalledWith(
      `${CONFIG_DIR}/projects`,
      'sdk-sess-1',
      'A-tooluse',
      expect.anything(),
    );
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

  // TASK-704: the proxy 407s every request without this session's token, so a
  // runner that booted without a usable one would fail every model/tool call
  // like a network outage. It must exit at boot instead — naming the variable
  // on stderr and never printing the value (a bearer credential).
  for (const [label, token] of [
    ['missing', undefined],
    ['malformed (upper-case)', 'FEEDFACEFEEDFACEFEEDFACEFEEDFACE'],
    ['malformed (truncated)', 'feedfacefeedfacefeedfacefeedfac'],
  ] as const) {
    it(`bootstrap failure: ${label} AX_PROXY_TOKEN → exit 2, no IPC client, value never printed`, async () => {
      setEnv({ ...COMPLETE_ENV, AX_PROXY_TOKEN: token });
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
        expect(stderrMessages).toContain('AX_PROXY_TOKEN');
        expect(stderrMessages.toLowerCase()).not.toContain('feedfacefeedface');

        expect(queryMock).not.toHaveBeenCalled();
        expect(fakeClient.event).not.toHaveBeenCalled();
        expect(createIpcClientMock).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }
    });
  }

  // The claude-sdk loop's session preparation lays down the SDK transcript
  // directory (`prepareTranscriptDir`, wired as runRunner's `prepareSession`
  // seam). It is bootstrap-fatal and runs BEFORE the resume restore writes the
  // rebuilt jsonl there (#1085): a runner that cannot lay down its own
  // transcript directory must not restore into it or start a turn.
  it('bootstrap failure: the transcript directory cannot be laid down → exit 2 before the resume restore, no query', async () => {
    const t = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'ax-main-prep-'));
    onTestFinished(() => fs.rm(t, { recursive: true, force: true }));
    // `$CLAUDE_CONFIG_DIR/projects` is a regular file, so the directory the
    // SDK writes its jsonl under cannot be created.
    const cfg = nodePath.join(t, 'cfg');
    await fs.mkdir(cfg);
    await fs.writeFile(nodePath.join(cfg, 'projects'), 'not a directory');
    setEnv({ ...COMPLETE_ENV, CLAUDE_CONFIG_DIR: cfg });
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          // Bound and resumable: the restore would run next.
          conversationId: 'cnv-prep',
          runnerSessionId: 'sdk-sess-prep',
        };
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
      expect(stderrMessages).toContain('session preparation failed');
      expect(stderrMessages).toContain('EEXIST');

      expect(restoreTranscriptForResumeMock).not.toHaveBeenCalled();
      expect(queryMock).not.toHaveBeenCalled();
      // Boot failure: no chat-end (the host synthesizes one from exit 2).
      expect(fakeClient.event).not.toHaveBeenCalled();
      expect(fakeClient.close).toHaveBeenCalledTimes(1);
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
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
      // Exclude the TASK-66 user display turn-end (role:'user', emitted when
      // the runner pulls the inbox message) — these assertions target the
      // tool/assistant turn-ends. The user turn-end has its own test.
      (c) =>
        c[0] === 'event.turn-end' &&
        (c[1] as { role?: string }).role !== 'user',
    );
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.[1]).toEqual({
      reason: 'user-message-wait',
      role: 'assistant',
      usage: ZERO_USAGE,
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
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
      // Exclude the TASK-66 user display turn-end (role:'user', emitted when
      // the runner pulls the inbox message) — these assertions target the
      // tool/assistant turn-ends. The user turn-end has its own test.
      (c) =>
        c[0] === 'event.turn-end' &&
        (c[1] as { role?: string }).role !== 'user',
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
      usage: ZERO_USAGE,
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
    // forwards these to the browser so Thread.tsx renders them live inside
    // the ChainOfThought disclosure via ToolFallback, not just on history
    // reload.
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

  it('TASK-260: a HELD call publishes the human line with no is_error; an unheld failure in the same turn is untouched, and the hold does not bleed into the next turn', async () => {
    // The model's copy of a hold and the human's copy are different artifacts
    // living in different stores: the SDK's jsonl keeps the instructive note
    // (stop, do not retry, do not route around), and the display event log we
    // publish here gets a sentence written for a person. What made this a bug
    // is that `is_error: true` rode along, so the chat painted a waiting call
    // as a FAILED one.
    setEnv(COMPLETE_ENV);
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string, payload: unknown) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      if (action === 'tool.pre-call') {
        const { call } = payload as { call: { id: string } };
        return call.id === 'tu_hold'
          ? { verdict: 'hold', decisionId: 'dec_abc123', note: MODEL_HOLD_NOTE }
          : { verdict: 'allow' };
      }
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([
      userEntry('send it'),
      userEntry('now do the other thing'),
      cancelEntry,
    ]);

    queryMock.mockImplementation((arg: unknown) => {
      const { prompt, options } = arg as {
        prompt: AsyncIterable<SDKUserMessage>;
        options: {
          hooks: {
            PreToolUse: Array<{
              hooks: Array<
                (
                  input: unknown,
                  toolUseID: string | undefined,
                  opts: unknown,
                ) => Promise<unknown>
              >;
            }>;
          };
        };
      };
      const preToolUse = options.hooks.PreToolUse[0]!.hooks[0]!;
      const firePreToolUse = async (id: string, name: string) =>
        await preToolUse(
          {
            hook_event_name: 'PreToolUse',
            session_id: 'sess-1',
            transcript_path: '/tmp/t.jsonl',
            cwd: HOME_DIR,
            tool_name: name,
            tool_input: {},
            tool_use_id: id,
          },
          id,
          { signal: new AbortController().signal },
        );

      return (async function* () {
        const it = prompt[Symbol.asyncIterator]();
        await it.next();

        // Turn 1: two calls. One the host holds, one it allows and which then
        // genuinely fails. Both come back from the CLI as `is_error` results.
        yield assistantBlocks([
          {
            type: 'tool_use',
            id: 'tu_hold',
            name: 'mcp__ax-host-tools__request_capability',
            input: {},
          },
          { type: 'tool_use', id: 'tu_fail', name: 'Bash', input: {} },
        ]);
        await firePreToolUse('tu_hold', 'mcp__ax-host-tools__request_capability');
        await firePreToolUse('tu_fail', 'Bash');
        // The CLI synthesises the held call's result out of our
        // permissionDecisionReason — i.e. the MODEL-facing note, flagged as an
        // error. This is the exact payload the bug forwarded to the human.
        yield userToolResult('tu_hold', MODEL_HOLD_NOTE, true);
        yield userToolResult('tu_fail', 'boom: exit 1', true);
        yield resultSuccess();

        // Turn 2: the registry has been cleared at the `result` boundary, so
        // the same id (reused here purely as a probe — the SDK would mint a
        // fresh one) publishes its REAL output again.
        await it.next();
        yield userToolResult('tu_hold', 'the real output', true);
        yield resultSuccess();

        await it.next();
      })();
    });

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    const toolTurnEnds = fakeClient.event.mock.calls.filter(
      (c) =>
        c[0] === 'event.turn-end' && (c[1] as { role?: string }).role === 'tool',
    );
    expect(toolTurnEnds).toHaveLength(2);

    const turn1Blocks = (
      toolTurnEnds[0]?.[1] as { contentBlocks: Array<Record<string, unknown>> }
    ).contentBlocks;
    expect(turn1Blocks).toHaveLength(2);

    // The held call: host-authored text, and `is_error` ABSENT — not false.
    // Absent is the whole point: a key set to false is still a key downstream
    // renderers have to remember to read the right way round.
    const heldBlock = turn1Blocks[0]!;
    expect(heldBlock.tool_use_id).toBe('tu_hold');
    expect(heldBlock.content).toBe(HELD_TOOL_RESULT_TEXT);
    expect('is_error' in heldBlock).toBe(false);
    // TASK-270: the persisted "held" flag — the reader keys Waiting off
    // this, never off the copy. The unheld failure next to it carries none.
    expect(heldBlock.held).toBe(true);
    expect('held' in turn1Blocks[1]!).toBe(false);
    // None of the model's copy leaks onto the human's surface.
    expect(JSON.stringify(heldBlock)).not.toMatch(/dec_/);
    expect(JSON.stringify(heldBlock)).not.toContain('Do not retry');

    // The unheld call that really failed keeps its output and its is_error.
    // This is the assertion that stops the fix over-reaching.
    expect(turn1Blocks[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_fail',
      content: 'boom: exit 1',
      is_error: true,
    });

    // Turn 2 — no bleed.
    const turn2Blocks = (
      toolTurnEnds[1]?.[1] as { contentBlocks: Array<Record<string, unknown>> }
    ).contentBlocks;
    expect(turn2Blocks).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_hold',
        content: 'the real output',
        is_error: true,
      },
    ]);

    // The live stream has to agree with the durable block, block for block —
    // a UI that renders the stream and a UI that rehydrates history must not
    // disagree about whether this call failed.
    const resultChunks = fakeClient.event.mock.calls
      .filter(
        (c) =>
          c[0] === 'event.stream-chunk' &&
          (c[1] as { kind?: string }).kind === 'tool-result',
      )
      .map((c) => c[1] as Record<string, unknown>);
    expect(resultChunks).toHaveLength(3);

    expect(resultChunks[0]?.toolCallId).toBe('tu_hold');
    expect(resultChunks[0]?.output).toBe(HELD_TOOL_RESULT_TEXT);
    expect('isError' in resultChunks[0]!).toBe(false);
    // TASK-270: the live twin of the persisted flag.
    expect(resultChunks[0]?.held).toBe(true);
    expect(JSON.stringify(resultChunks[0])).not.toMatch(/dec_/);
    expect(JSON.stringify(resultChunks[0])).not.toContain('Do not retry');

    expect(resultChunks[1]).toEqual({
      reqId: expect.any(String),
      kind: 'tool-result',
      toolCallId: 'tu_fail',
      output: 'boom: exit 1',
      isError: true,
    });
    expect(resultChunks[2]?.output).toBe('the real output');
    expect(resultChunks[2]?.isError).toBe(true);
  });

  it('TASK-842: a connector server refused at init, or a connector tool error mid-turn, is reported to the host; held calls and other tools are not', async () => {
    const NS_INIT = 'c0123456789';
    const NS_CALL = 'cabcdef0123';
    setEnv(COMPLETE_ENV);
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string, payload: unknown) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      if (action === 'tool.pre-call') {
        const { call } = payload as { call: { id: string } };
        return call.id === 'tu_held'
          ? { verdict: 'hold', decisionId: 'dec_842', note: MODEL_HOLD_NOTE }
          : { verdict: 'allow' };
      }
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('look it up'), userEntry('again'), cancelEntry]);

    queryMock.mockImplementation((arg: unknown) => {
      const { prompt, options } = arg as {
        prompt: AsyncIterable<SDKUserMessage>;
        options: {
          hooks: {
            PreToolUse: Array<{
              hooks: Array<(input: unknown, toolUseID: string | undefined, opts: unknown) => Promise<unknown>>;
            }>;
          };
        };
      };
      const preToolUse = options.hooks.PreToolUse[0]!.hooks[0]!;
      const firePreToolUse = async (id: string, name: string) =>
        await preToolUse(
          {
            hook_event_name: 'PreToolUse',
            session_id: 'sess-1',
            transcript_path: '/tmp/t.jsonl',
            cwd: HOME_DIR,
            tool_name: name,
            tool_input: {},
            tool_use_id: id,
          },
          id,
          { signal: new AbortController().signal },
        );
      return (async function* () {
        const it = prompt[Symbol.asyncIterator]();
        await it.next();
        yield {
          ...(systemInit('sess-1') as object),
          mcp_servers: [
            { name: NS_INIT, status: 'failed' },
            { name: NS_CALL, status: 'connected' },
            { name: 'ax-host-tools', status: 'failed' },
          ],
        } as unknown as SDKMessage;
        // Turn 1: a connector call that errors twice (reported once), a held
        // connector call (not a failure), and a failing built-in (not a connector).
        yield assistantBlocks([
          { type: 'tool_use', id: 'tu_c1', name: `mcp__${NS_CALL}__search`, input: {} },
          { type: 'tool_use', id: 'tu_c2', name: `mcp__${NS_CALL}__create`, input: {} },
          { type: 'tool_use', id: 'tu_held', name: `mcp__${NS_INIT}__search`, input: {} },
          { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: {} },
        ]);
        await firePreToolUse('tu_held', `mcp__${NS_INIT}__search`);
        yield userToolResult('tu_c1', 'expected object, received null', true);
        yield userToolResult('tu_c2', 'expected object, received null', true);
        yield userToolResult('tu_held', MODEL_HOLD_NOTE, true);
        yield userToolResult('tu_bash', 'boom', true);
        yield resultSuccess();
        // Turn 2: the same connector errors again — a new turn reports again.
        await it.next();
        yield assistantBlocks([{ type: 'tool_use', id: 'tu_c3', name: `mcp__${NS_CALL}__search`, input: {} }]);
        yield userToolResult('tu_c3', 'nope', true);
        yield resultSuccess();
        await it.next();
      })();
    });

    const { main } = await import('../main.js');
    expect(await main()).toBe(0);

    const reports = fakeClient.event.mock.calls
      .filter((c) => c[0] === 'event.connector-auth-failure')
      .map((c) => c[1]);
    expect(reports).toEqual([
      { servers: [{ toolNamespace: NS_INIT, status: 'failed' }] },
      { servers: [{ toolNamespace: NS_CALL, status: 'tool-error' }] },
      { servers: [{ toolNamespace: NS_CALL, status: 'tool-error' }] },
    ]);
    // Nothing but namespaces and a status crosses — never the tool output.
    expect(JSON.stringify(reports)).not.toContain('received null');
  });

  it('FAULTA-3: fresh first turn (runnerSessionId null) still emits turnId — read via transcriptSessionId, not the boot runnerSessionId', async () => {
    // On a conversation's FIRST turn the boot runnerSessionId is null (it only
    // ever holds a *resume* value). The turn-end turnId reads MUST use the SDK's
    // real session id captured at system/init (transcriptSessionId) so a real
    // consumer — @ax/routines silence-token → conversations:drop-turn keyed on
    // payload.turnId, where a per-fire routine's response IS the conversation's
    // first turn — can refer back to this turn. Before the fix the reads were
    // gated on `runnerSessionId !== null`, so on a fresh boot readLastTurnUuid
    // was never called and no turnId was attached.
    setEnv(COMPLETE_ENV);
    // Distinct uuids per turn-role so we can prove the right read fed each one.
    readLastTurnUuidMock.mockImplementation(
      async (_root: string, _sessionId: string, kind: 'user' | 'assistant') =>
        kind === 'assistant' ? 'asst-turn-uuid' : 'tool-turn-uuid',
    );
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          // Fresh conversation, no prior runner session bound → first turn.
          conversationId: 'cnv-fresh',
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      if (action === 'attachments.list') return { files: [] };
      if (action === 'conversation.store-runner-session') return { ok: true };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([userEntry('do work'), cancelEntry]);
    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          // The SDK mints a fresh session id and announces it at init; this is
          // the id the turn-end turnId reads must target.
          yield systemInit('sdk-fresh-id');
          // A tool turn so BOTH turn-end emissions fire (role=tool + role=assistant).
          yield assistantBlocks([
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'pwd' } },
          ]);
          yield userToolResult('tu_1', '/tmp/work');
          yield assistantBlocks([{ type: 'text', text: 'done' }]);
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    const rc = await main();
    expect(rc).toBe(0);

    // Both turn-end turnId reads targeted the SDK session id (transcriptSessionId),
    // NOT the (null) boot runnerSessionId.
    expect(readLastTurnUuidMock).toHaveBeenCalledWith(
      `${CONFIG_DIR}/projects`,
      'sdk-fresh-id',
      'user',
    );
    expect(readLastTurnUuidMock).toHaveBeenCalledWith(
      `${CONFIG_DIR}/projects`,
      'sdk-fresh-id',
      'assistant',
    );

    const turnEnds = fakeClient.event.mock.calls.filter(
      // Exclude the TASK-66 user display turn-end (role:'user', emitted when
      // the runner pulls the inbox message) — these assertions target the
      // tool/assistant turn-ends. The user turn-end has its own test.
      (c) =>
        c[0] === 'event.turn-end' &&
        (c[1] as { role?: string }).role !== 'user',
    );
    expect(turnEnds).toHaveLength(2);
    // role=tool turn-end carries the 'user'-line turnId.
    expect(turnEnds[0]?.[1]).toMatchObject({
      role: 'tool',
      turnId: 'tool-turn-uuid',
    });
    // role=assistant turn-end carries the 'assistant'-line turnId — this is the
    // one @ax/routines drops on a silenced first turn.
    expect(turnEnds[1]?.[1]).toMatchObject({
      role: 'assistant',
      turnId: 'asst-turn-uuid',
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
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
      // Exclude the TASK-66 user display turn-end (role:'user', emitted when
      // the runner pulls the inbox message) — these assertions target the
      // tool/assistant turn-ends. The user turn-end has its own test.
      (c) =>
        c[0] === 'event.turn-end' &&
        (c[1] as { role?: string }).role !== 'user',
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
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
      // Exclude the TASK-66 user display turn-end (role:'user', emitted when
      // the runner pulls the inbox message) — these assertions target the
      // tool/assistant turn-ends. The user turn-end has its own test.
      (c) =>
        c[0] === 'event.turn-end' &&
        (c[1] as { role?: string }).role !== 'user',
    );
    expect(turnEnds).toHaveLength(1);
    // TASK-692: no assistant message means nothing was observed, so the loop
    // reports `usage: null` and the shell sends NO usage key at all (the host
    // then charges its flat assumed cost) — never a zero-filled "free" turn.
    expect(turnEnds[0]?.[1]).toEqual({
      reason: 'user-message-wait',
      role: 'assistant',
      reqId: 'req-test',
    });
  });

  it('reports each turn\'s usage on the assistant turn-end: one API response counted once, sub-agents included, reset per turn (TASK-692)', async () => {
    setEnv(COMPLETE_ENV);
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-6',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
    fakeInbox = buildFakeInbox([
      userEntry('first', 'req-1'),
      userEntry('second', 'req-2'),
      cancelEntry,
    ]);

    /** An SDK assistant message for API response `id`, one content block of it. */
    const response = (
      id: string,
      usage: Record<string, number | null>,
      parentToolUseId: string | null = null,
    ): SDKMessage => {
      const base = assistantText('x') as unknown as {
        message: Record<string, unknown>;
      } & Record<string, unknown>;
      return {
        ...base,
        parent_tool_use_id: parentToolUseId,
        message: { ...base.message, id, usage },
      } as unknown as SDKMessage;
    };

    queryMock.mockImplementation(
      ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        return (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          // Turn 1. Response m-A arrives as THREE SDK messages (one per block)
          // sharing an id and usage; the last carries the final output count.
          const a = {
            input_tokens: 100,
            cache_read_input_tokens: 4000,
            cache_creation_input_tokens: 250,
          };
          yield response('m-A', { ...a, output_tokens: 5 });
          yield response('m-A', { ...a, output_tokens: 5 });
          yield response('m-A', { ...a, output_tokens: 60 });
          // A sub-agent's response (parent_tool_use_id set) is billed too.
          yield response(
            'm-sub',
            { input_tokens: 30, output_tokens: 20, cache_read_input_tokens: null, cache_creation_input_tokens: null },
            'toolu_task',
          );
          // A second round trip of the main agent.
          yield response('m-B', {
            input_tokens: 7,
            output_tokens: 15,
            cache_read_input_tokens: 4250,
            cache_creation_input_tokens: 0,
          });
          yield resultSuccess();

          // Turn 2 starts clean, and may legitimately reuse nothing from turn 1.
          await it.next();
          yield response('m-A', {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4,
          });
          yield resultSuccess();
          await it.next();
        })();
      },
    );

    const { main } = await import('../main.js');
    expect(await main()).toBe(0);

    const assistantEnds = fakeClient.event.mock.calls
      .filter(
        (c) =>
          c[0] === 'event.turn-end' &&
          (c[1] as { role?: string }).role === 'assistant',
      )
      .map((c) => c[1] as { reqId?: string; usage?: unknown });
    expect(assistantEnds).toHaveLength(2);
    expect(assistantEnds[0]).toMatchObject({
      reqId: 'req-1',
      usage: {
        model: 'anthropic/claude-sonnet-4-6',
        inputTokens: 100 + 30 + 7,
        outputTokens: 60 + 20 + 15,
        cacheReadTokens: 4000 + 4250,
        cacheWriteTokens: 250,
      },
    });
    expect(assistantEnds[1]).toMatchObject({
      reqId: 'req-2',
      usage: {
        model: 'anthropic/claude-sonnet-4-6',
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
      },
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
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
      // Exclude the TASK-66 user display turn-end (role:'user', emitted when
      // the runner pulls the inbox message) — these assertions target the
      // tool/assistant turn-ends. The user turn-end has its own test.
      (c) =>
        c[0] === 'event.turn-end' &&
        (c[1] as { role?: string }).role !== 'user',
    );
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.[1]).toEqual({
      reason: 'user-message-wait',
      role: 'assistant',
      usage: ZERO_USAGE,
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
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

  describe('SDK error results', () => {
    const subtypes = [
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ] as const;

    function wireConfig(): void {
      setEnv(COMPLETE_ENV);
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: null,
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('continue', 'req-failed'), cancelEntry]);
    }

    it.each(subtypes)('%s terminates without first signalling a successful turn', async (subtype) => {
      wireConfig();
      queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
        (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield {
            ...resultSuccess(),
            subtype,
            is_error: true,
            errors: ['The resumed turn failed.'],
          } as SDKMessage;
          await it.next();
        })(),
      );

      const { main } = await import('../main.js');
      expect(await main()).toBe(1);
      // A turn-end closes SSE and removes the orchestrator's waiter. Sending
      // it before the error makes the later chat-end invisible to the person.
      expect(fakeClient.event.mock.calls.filter((c) => c[0] === 'event.turn-end')).toEqual([]);
      const chatEnds = fakeClient.event.mock.calls.filter((c) => c[0] === 'event.chat-end');
      expect(chatEnds).toHaveLength(1);
      expect(chatEnds[0]?.[1]).toMatchObject({
        outcome: {
          kind: 'terminated',
          error: { message: expect.stringContaining('The resumed turn failed.') },
        },
      });
    });

    it('a failed turn after a successful one does not publish another success heartbeat', async () => {
      wireConfig();
      fakeInbox = buildFakeInbox([
        userEntry('first', 'req-first'),
        userEntry('second', 'req-second'),
        cancelEntry,
      ]);
      queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
        (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantText('first reply');
          yield resultSuccess();
          await it.next();
          yield assistantText('partial second reply');
          yield {
            ...resultSuccess(),
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['The model failed mid-turn.'],
          } as SDKMessage;
          // Some CLI failures throw only after yielding the error result. The
          // error must win before a success heartbeat, even in that sequence.
          throw new Error('Claude Code process exited with code 1');
        })(),
      );

      const { main } = await import('../main.js');
      expect(await main()).toBe(1);
      const turnEnds = fakeClient.event.mock.calls.filter((c) => c[0] === 'event.turn-end');
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]?.[1]).toMatchObject({ reqId: 'req-first' });
      const chatEnd = fakeClient.event.mock.calls.find((c) => c[0] === 'event.chat-end');
      expect(chatEnd?.[1]).toMatchObject({
        outcome: { kind: 'terminated', error: { message: expect.stringContaining('The model failed mid-turn.') } },
      });
    });

    it('honours is_error even when the SDK labels the subtype success', async () => {
      wireConfig();
      queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
        (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield { ...resultSuccess(), is_error: true } as SDKMessage;
          await it.next();
        })(),
      );
      const { main } = await import('../main.js');
      expect(await main()).toBe(1);
      expect(fakeClient.event.mock.calls.filter((c) => c[0] === 'event.turn-end')).toEqual([]);
    });
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
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
  // (`$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<sessionId>.jsonl`, rebuilt from
  // the host store on resume); the runner never re-emits prior user turns
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
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
    // SDK starts fresh; a prior transcript, if any, lives in the host store
    // and only a resume rebuilds it.
    setEnv(COMPLETE_ENV);
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: 'cnv_fresh',
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      if (action === 'attachments.list') return { files: [] };
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: 'cnv_resume',
          runnerSessionId: 'sdk-sess-resume',
        };
      }
      if (action === 'tool.list') return { tools: [] };
      if (action === 'attachments.list') return { files: [] };
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: 'cnv_fresh',
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      if (action === 'attachments.list') return { files: [] };
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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: 'cnv_resume',
          runnerSessionId: 'sdk-sess-resume',
        };
      }
      if (action === 'tool.list') return { tools: [] };
      if (action === 'attachments.list') return { files: [] };
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
    it('happy path: bound conversation → captures system/init session_id and POSTs conversation.store-runner-session once, AFTER the transcript delta is durable (F2a)', async () => {
      setEnv(COMPLETE_ENV);
      // TASK-67 / F2a: the bind is deferred to a DURABLE TRANSCRIPT — it fires
      // after shipTranscriptDelta returns 'appended'/'resynced' (the rows are
      // in the host store). The mock defaults to 'appended', so the bind fires
      // this turn.
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: 'cnv-1',
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        if (action === 'attachments.list') return { files: [] };
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
      // The bind must come AFTER a durable transcript ship (durability first):
      // shipTranscriptDelta runs at the result boundary BEFORE the bind.
      expect(shipTranscriptDeltaMock).toHaveBeenCalled();
      const shipOrder = shipTranscriptDeltaMock.mock.invocationCallOrder[0]!;
      const bindOrder =
        fakeClient.call.mock.calls.findIndex(
          (c) => c[0] === 'conversation.store-runner-session',
        ) >= 0
          ? // The fake client's `call` shares vitest's global invocation order.
            (
              fakeClient.call.mock.invocationCallOrder[
                fakeClient.call.mock.calls.findIndex(
                  (c) => c[0] === 'conversation.store-runner-session',
                )
              ] as number
            )
          : -1;
      expect(bindOrder).toBeGreaterThan(shipOrder);
    });

    it('F2a regression: a turn killed before any durable transcript does NOT bind — so the retry never resumes a phantom session', async () => {
      // This is the heart of F2a: binding at system/init persisted
      // runner_session_id ~1s into the turn, BEFORE the transcript was durable.
      // A turn killed in that window left a stale binding that crashed the
      // retry's query({resume}) with "No conversation found". With the bind
      // deferred (TASK-67) to a DURABLE TRANSCRIPT ship, a turn whose transcript
      // never reached the store (shipTranscriptDelta → no-transcript/noop, never
      // 'appended') leaves the row UNBOUND, so the host returns
      // runner_session_id=null on the retry and the fresh runner starts clean.
      setEnv(COMPLETE_ENV);
      // Simulate a turn killed before the transcript landed: the ship is a noop.
      shipTranscriptDeltaMock.mockResolvedValue({
        outcome: 'no-transcript',
        sentOffset: 0,
        sentSeq: 0,
      });
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: 'cnv-killed',
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        if (action === 'attachments.list') return { files: [] };
        if (action === 'conversation.store-runner-session') {
          throw new Error('runner must NOT bind before a durable transcript (F2a)');
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
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: null,
            runnerSessionId: null,
          };
        }
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
      // it. The bind itself fires once, after the first durable ship (F2a).
      setEnv(COMPLETE_ENV);
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: 'cnv-2',
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        if (action === 'attachments.list') return { files: [] };
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

    it('F2a: a transient bind failure is non-fatal and self-heals on the NEXT turn’s durable transcript ship (the final ship is a noop)', async () => {
      // F2a (supersedes the Phase E FATAL posture): the bind fires AFTER the
      // turn already streamed to the user (once its transcript is durable on
      // the host), so terminating on a TRANSIENT bind failure would be
      // incoherent. The failure is logged and the flag left unset, so a LATER
      // durable ship retries. This models production: each turn's ship appends
      // its lines and the final drain ship has nothing left — so the retry must
      // come from turn 2's ship, not the final one.
      setEnv(COMPLETE_ENV);
      // turn-1 ship appends, turn-2 ship appends, final drain → noop.
      shipTranscriptDeltaMock
        .mockResolvedValueOnce({ outcome: 'appended', sentOffset: 10, sentSeq: 1 })
        .mockResolvedValueOnce({ outcome: 'appended', sentOffset: 20, sentSeq: 2 })
        .mockResolvedValue({ outcome: 'noop', sentOffset: 20, sentSeq: 2 });
      let bindAttempts = 0;
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: 'cnv-3',
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        if (action === 'attachments.list') return { files: [] };
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

      // Retried on turn 2's ship and eventually bound.
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
      // 409. Retrying is futile and continuing would ship an orphan
      // transcript — the run must terminate so the loser stops.
      setEnv(COMPLETE_ENV);
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: 'cnv-conflict',
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        if (action === 'attachments.list') return { files: [] };
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
  // (`$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<sessionId>.jsonl`, which the
  // shell rebuilds from the host store first) — there's no DB replay layer
  // to consult.
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
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: 'cnv-resume',
            runnerSessionId: 'sdk-sess-resume',
          };
        }
        if (action === 'tool.list') return { tools: [] };
        if (action === 'attachments.list') return { files: [] };
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

    it('F2a guard: runnerSessionId set but NO resumable transcript (host has no rows) → OMITS options.resume (starts fresh, never crashes)', async () => {
      // The SDK hard-crashes (exit 1, "No conversation found with session ID")
      // if asked to resume a session whose on-disk transcript has no parseable
      // user/assistant message. TASK-67: the transcript lives in the host store,
      // so the guard becomes the DB check — restoreTranscriptForResume returns
      // `written: false` when the host has no rows (max(seq) === 0), and the
      // runner demotes the resume to a fresh start instead of crashing.
      setEnv(COMPLETE_ENV);
      restoreTranscriptForResumeMock.mockResolvedValue({
        written: false,
        state: { sentOffset: 0, sentSeq: 0 },
      });
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: 'cnv-stale',
            runnerSessionId: 'sdk-sess-missing',
          };
        }
        if (action === 'tool.list') return { tools: [] };
        if (action === 'attachments.list') return { files: [] };
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

      // The guard ran via the DB-backed restore (the bound id, against the
      // source main() constructs over the transcript directory — no
      // AX_TRANSCRIPTS_ROOT here, so the SDK's own $CLAUDE_CONFIG_DIR/projects).
      // Two checks restore the original claim: the call got a well-shaped
      // source (below), AND that source was built from the right root (the
      // spy on createJsonlTranscriptSource — otherwise a source of the right
      // SHAPE but the wrong directory would pass silently). It is slugged by
      // the SDK's cwd: the agent's home.
      expect(createJsonlTranscriptSourceSpy).toHaveBeenCalledWith(
        `${CONFIG_DIR}/projects`,
        COMPLETE_ENV.AX_USERFILES_ROOT,
      );
      expect(restoreTranscriptForResumeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          source: expect.objectContaining({
            read: expect.any(Function),
            write: expect.any(Function),
          }),
          sessionId: 'sdk-sess-missing',
        }),
      );
      // resume was stripped → query started fresh (no crash).
      expect(queryMock).toHaveBeenCalledTimes(1);
      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { resume?: string };
      };
      expect(queryArg.options.resume).toBeUndefined();
    });

    it('TASK-67: a conversation-scoped turn ships the resume-transcript DELTA at the result boundary', async () => {
      // The result boundary ships the jsonl delta to the host store
      // (session.append-transcript via shipTranscriptDelta), its source of
      // truth. The bind fires off the durable transcript.
      setEnv(COMPLETE_ENV);
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: 'cnv-ship',
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        if (action === 'attachments.list') return { files: [] };
        if (action === 'conversation.store-runner-session') return { ok: true };
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('go'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
          return (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield systemInit('sdk-sess-ship');
            yield assistantText('hi');
            yield resultSuccess();
            await it.next();
          })();
        },
      );

      const { main } = await import('../main.js');
      const rc = await main();
      expect(rc).toBe(0);

      // The transcript delta shipped (per-turn + final flush), threading the
      // sentOffset/sentSeq state across calls.
      expect(shipTranscriptDeltaMock).toHaveBeenCalled();
      const shipArg = shipTranscriptDeltaMock.mock.calls[0]![0] as {
        source: unknown;
        sessionId: string;
        state: { sentOffset: number; sentSeq: number };
      };
      expect(shipArg.sessionId).toBe('sdk-sess-ship');
      expect(shipArg.state).toEqual({ sentOffset: 0, sentSeq: 0 });
      // That is the only way the transcript leaves the sandbox: nothing else
      // is uploaded (shipTranscriptDelta is mocked here, so no upload at all).
      expect(fakeClient.callBinaryUpload).not.toHaveBeenCalled();
      // The bind fired off the durable transcript ship.
      const binds = fakeClient.call.mock.calls.filter(
        (c) => c[0] === 'conversation.store-runner-session',
      );
      expect(binds).toHaveLength(1);
      expect(binds[0]?.[1]).toEqual({
        conversationId: 'cnv-ship',
        runnerSessionId: 'sdk-sess-ship',
      });
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
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: 'cnv-fresh',
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        if (action === 'attachments.list') return { files: [] };
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
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: 'cnv-empty-rsid',
            runnerSessionId: '', // <- the load-bearing input
          };
        }
        if (action === 'tool.list') return { tools: [] };
        if (action === 'attachments.list') return { files: [] };
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
  // Phase C: HOME for the SDK subprocess.
  //
  // The SDK subprocess gets HOME = the agent's home (`/files` in k8s, the
  // `env:` we pass into `query({ options: { env } })`), so tools that read
  // HOME (`~/bin`, dotfiles) find the agent's own durable files. The SDK's own
  // state does not follow HOME: with CLAUDE_CONFIG_DIR set, its `.claude.json`,
  // sessions and transcripts land there, outside the home (see the §11
  // tests). The runner process keeps its own HOME (k8s: /home/runner), so a
  // child the runner itself spawns never reads agent-written dotfiles.
  // ---------------------------------------------------------------------

  describe('Phase C: HOME for the SDK subprocess', () => {
    it('happy path: SDK env.HOME is the agent home and ANTHROPIC_API_KEY is preserved', async () => {
      setEnv(COMPLETE_ENV);
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: null,
            runnerSessionId: null,
          };
        }
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
      // HOME is the agent's home. Skill discovery's `'user'` root and the
      // SDK's own state are the separately-forwarded CLAUDE_CONFIG_DIR — see
      // the I-P0-1 test below — which must NOT collapse onto this HOME path.
      expect(queryArg.options.env.HOME).toBe(COMPLETE_ENV.AX_USERFILES_ROOT);
      // ANTHROPIC_API_KEY is preserved through the spread — the
      // proxyStartup.providerEnv merge intent is documented here so
      // a future refactor that drops the spread still trips this test.
      expect(queryArg.options.env.ANTHROPIC_API_KEY).toBe(
        COMPLETE_ENV.ANTHROPIC_API_KEY,
      );
    });

    it('HOME override is per-SDK-subprocess only: process.env.HOME is NOT mutated by main()', async () => {
      // The runner process keeps its own HOME (k8s: /home/runner, the
      // pod-level setting). Mutating process.env.HOME here would hand every
      // child the runner itself spawns the agent's home, and with it the
      // agent-written dotfiles there.
      setEnv(COMPLETE_ENV);
      const homeBefore = process.env.HOME;
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: null,
            runnerSessionId: null,
          };
        }
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

  describe('the agent home (TASK-164, TASK-995): cwd = HOME = the home, and nothing is re-rooted', () => {
    // The SDK subprocess's cwd and HOME are the agent's durable home
    // (AX_USERFILES_ROOT, `/files` in k8s). There is no second tree the runner
    // manages: the scratch root (AX_EPHEMERAL_ROOT) and the read-only memory
    // root are the only directories granted beyond it, and a path is never
    // rewritten on its way to the host.
    function wireHomeClient(
      extraTools: unknown[] = [],
      answer: (action: string, payload: unknown) => unknown = () => undefined,
    ) {
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string, payload: unknown) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: null,
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: extraTools };
        const answered = answer(action, payload);
        if (answered !== undefined) return answered;
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

    it('runs the SDK with HOME = cwd = the agent home, CLAUDE_CONFIG_DIR outside it, and additionalDirectories = [scratch, memory]', async () => {
      setEnv({ ...COMPLETE_ENV, AX_MEMORY_ROOT: '/memory' });
      wireHomeClient();

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);

      const { options } = queryMock.mock.calls[0]![0] as {
        options: {
          cwd: string;
          env: Record<string, string | undefined>;
          additionalDirectories?: string[];
          settingSources: string[];
        };
      };
      expect(options.cwd).toBe(HOME_DIR);
      expect(options.env.HOME).toBe(HOME_DIR);
      // The SDK's own trusted configuration is runner-private and outside the
      // home (the startup guard refuses anything else).
      expect(options.env.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR);
      const configFromHome = nodePath.relative(HOME_DIR, CONFIG_DIR);
      expect(configFromHome.startsWith('..') && !nodePath.isAbsolute(configFromHome)).toBe(true);
      // Beyond the cwd, the file tools reach the scratch root and the
      // read-only memory root, and nothing else. The home is not listed twice.
      expect(options.additionalDirectories).toEqual([SCRATCH_DIR, '/memory']);
      expect(options.settingSources).toEqual(['user']);
      // ~/bin follows HOME and is appended to PATH.
      expect(options.env.PATH?.endsWith(`:${HOME_DIR}/bin`)).toBe(true);
    });

    it('omits the memory root when AX_MEMORY_ROOT is unset (no permission widening)', async () => {
      setEnv(COMPLETE_ENV);
      wireHomeClient();

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);

      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { additionalDirectories?: string[] };
      };
      expect(queryArg.options.additionalDirectories).toEqual([SCRATCH_DIR]);
    });

    it('builds the transcript source for the dir the SDK runs in, so a resumed turn finds its jsonl', async () => {
      // The SDK reads `projects/<slug(cwd)>/<sid>.jsonl`, and its cwd is the
      // agent's home, so the source must be slugged by that same directory or
      // the resume-restore writes under a slug the SDK never opens ("No
      // conversation found with session ID").
      setEnv(COMPLETE_ENV);
      wireHomeClient();

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);

      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { cwd: string };
      };
      expect(queryArg.options.cwd).toBe(HOME_DIR);
      // Rooted at the transcript directory, slugged by the SDK's actual cwd —
      // the same value, not a parallel computation.
      expect(createJsonlTranscriptSourceSpy).toHaveBeenCalledWith(
        `${CONFIG_DIR}/projects`,
        queryArg.options.cwd,
      );
    });

    it.each(['AX_USERFILES_ROOT', 'AX_EPHEMERAL_ROOT'])(
      'refuses to start without %s: there is no fallback home or scratch root',
      async (name) => {
        setEnv({ ...COMPLETE_ENV, [name]: undefined });
        fakeClient = buildFakeClient();
        fakeInbox = buildFakeInbox([]);
        const stderrSpy = vi
          .spyOn(process.stderr, 'write')
          .mockImplementation(() => true);
        try {
          const { main } = await import('../main.js');
          expect(await main()).toBe(2);
          expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain(
            `missing required env: ${name}`,
          );
          expect(createIpcClientMock).not.toHaveBeenCalled();
          expect(queryMock).not.toHaveBeenCalled();
        } finally {
          stderrSpy.mockRestore();
        }
      },
    );

    // The hook main() wires is the one the SDK runs. A configuration-looking
    // path reaches the host exactly as the model wrote it, and the SDK gets no
    // `updatedInput` (TASK-995: nothing is re-rooted; see pre-tool-use.test.ts
    // for the full set of shapes).
    it('the wired PreToolUse hook hands .ax/, .claude/ and CLAUDE.md paths to the host as written', async () => {
      setEnv(COMPLETE_ENV);
      wireHomeClient([], (action) =>
        action === 'tool.pre-call' ? { verdict: 'allow' } : undefined,
      );

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);

      const { options } = queryMock.mock.calls[0]![0] as {
        options: {
          hooks: {
            PreToolUse: Array<{
              hooks: Array<(input: unknown, id: string, opts: unknown) => Promise<unknown>>;
            }>;
          };
        };
      };
      const hook = options.hooks.PreToolUse[0]!.hooks[0]!;
      for (const filePath of [`${HOME_DIR}/.ax/SOUL.md`, '.claude/settings.json', 'CLAUDE.md']) {
        const id = `tu-${filePath}`;
        const out = await hook(
          { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } },
          id,
          { signal: new AbortController().signal },
        );
        expect(out, filePath).toEqual({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
        });
        const preCall = fakeClient.call.mock.calls.filter((c) => c[0] === 'tool.pre-call').at(-1);
        expect(preCall?.[1], filePath).toEqual({
          call: { id, name: 'Write', input: { file_path: filePath, content: 'x' } },
        });
      }
    });

    // TASK-995: there is no workspace to flush before a host tool reads the
    // agent's files; they are already where the host reads them. A host tool
    // whose descriptor still says `flushWorkspaceBeforeCall` forwards straight
    // to `tool.execute-host`, with no other IPC call first.
    it('a host tool call has no workspace flush precondition', async () => {
      setEnv(COMPLETE_ENV);
      wireHomeClient(
        [
          {
            name: 'host_reads_files',
            description: 'a host tool that reads files the agent wrote',
            inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
            executesIn: 'host',
            flushWorkspaceBeforeCall: true,
          },
        ],
        (action) => (action === 'tool.execute-host' ? { output: 'host-ok' } : undefined),
      );

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);

      // The host MCP server main() built for this session (the SDK mock keeps
      // the tool entries it was handed).
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const hostServer = (sdk.createSdkMcpServer as unknown as Mock).mock.calls
        .map((c) => c[0] as {
          name: string;
          tools: Array<{ name: string; handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
        })
        .filter((c) => c.name === 'ax-host-tools')
        .at(-1);
      const hostTool = hostServer?.tools.find((t) => t.name === 'host_reads_files');
      expect(hostTool).toBeDefined();

      const before = fakeClient.call.mock.calls.length;
      const result = await hostTool!.handler({ q: 'x' }, {});
      expect(fakeClient.call.mock.calls.slice(before).map((c) => c[0])).toEqual(['tool.execute-host']);
      expect(fakeClient.call.mock.calls.at(-1)?.[1]).toMatchObject({
        call: { name: 'host_reads_files', input: { q: 'x' } },
      });
      expect(fakeClient.callBinary).not.toHaveBeenCalled();
      expect(fakeClient.callBinaryUpload).not.toHaveBeenCalled();
      expect(result).toEqual({ content: [{ type: 'text', text: 'host-ok' }] });
    });
  });

  describe('Python venv activation', () => {
    // Same scaffolding as the HOME happy path, plus a forwarded proxy CA so
    // buildPythonVenvEnv produces the full set. The venv lives in the scratch
    // root, which every session has (TASK-995).
    function venvEnv() {
      return {
        ...COMPLETE_ENV,
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
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: null,
            runnerSessionId: null,
          };
        }
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

      expect(scaffoldPythonVenvMock).toHaveBeenCalledWith(SCRATCH_DIR);
      const queryArg = queryMock.mock.calls[0]?.[0] as {
        options: { env: Record<string, string> };
      };
      expect(queryArg.options.env.VIRTUAL_ENV).toBe(`${SCRATCH_DIR}/py`);
      // TASK-19: the venv bin stays at the FRONT (the venv must win for
      // python/pip), and $HOME/bin (in the durable home) is APPENDED at the
      // END — installed agent tools are discoverable but can't shadow the
      // trusted venv/base bins.
      expect(queryArg.options.env.PATH.startsWith(`${SCRATCH_DIR}/py/bin:`)).toBe(
        true,
      );
      expect(queryArg.options.env.PATH.endsWith(`:${HOME_DIR}/bin`)).toBe(
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
      expect(queryArg.options.env.PATH.startsWith(`${SCRATCH_DIR}/py/bin`)).toBe(
        false,
      );
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
      expect(scaffoldPythonVenvMock).toHaveBeenCalledWith(SCRATCH_DIR);
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
      expect(queryArg.options.env.VIRTUAL_ENV).toBe(`${SCRATCH_DIR}/py`);

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
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
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

  /**
   * A conversation-bound host with one uploaded image. The runner copies it
   * into `<scratch>/uploads/` at boot (`attachments.list` → `blob.get`) and
   * translates the message's block by attachment id from that copy.
   */
  async function hostWithUploadedImage(png: Buffer): Promise<{ scratch: string }> {
    const scratch = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'ax-main-att-'));
    onTestFinished(() => fs.rm(scratch, { recursive: true, force: true }));
    setEnv({ ...COMPLETE_ENV, AX_EPHEMERAL_ROOT: scratch });
    const sha256 = createHash('sha256').update(png).digest('hex');
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-test',
          agentId: 'a-test',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: '',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
          },
          conversationId: 'cnv-att',
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      if (action === 'attachments.list') {
        return AttachmentsListResponseSchema.parse({
          files: [
            { attachmentId: 'att-img', filename: 'img.png', sha256, mediaType: 'image/png', sizeBytes: png.length },
          ],
        });
      }
      throw new Error(`unexpected call: ${action}`);
    });
    fakeClient.callBinary.mockImplementation(async (action: string, payload: unknown) => {
      if (action !== 'blob.get') throw new Error(`unexpected binary call: ${action}`);
      expect(payload).toEqual({ sha256 });
      const tmp = nodePath.join(scratch, 'blob-get.tmp');
      await fs.writeFile(tmp, png);
      return { path: tmp, bytes: png.length };
    });
    return { scratch };
  }

  const imageBlock = (png: Buffer) => ({
    type: 'attachment' as const,
    attachmentId: 'att-img',
    filename: 'img.png',
    mediaType: 'image/png',
    sizeBytes: png.length,
  });

  it('Phase 2: translates attachment contentBlocks to Anthropic image blocks before yielding to SDK', async () => {
    const png = Buffer.from('fake-png-bytes');
    const { scratch } = await hostWithUploadedImage(png);

    // Inject a user message with an image attachment in its contentBlocks.
    const userMsgWithAttachment: InboxLoopEntry = {
      type: 'user-message',
      payload: {
        role: 'user',
        content: '',
        contentBlocks: [imageBlock(png)],
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

    // The bytes came from the runner's own copy, flat in `<scratch>/uploads/`,
    // fetched once from the blob store and never through any other read.
    expect(await fs.readFile(nodePath.join(scratch, 'uploads', 'img.png'))).toEqual(png);
    expect(fakeClient.callBinary.mock.calls.map((c) => c[0])).toEqual(['blob.get']);
  });

  it('Phase 2: preserves typed user text alongside translated attachment blocks', async () => {
    const png = Buffer.from('fake-png-bytes');
    await hostWithUploadedImage(png);

    // The chat-messages handler sends BOTH typed text AND attachment blocks
    // for a single user turn. Confirm the runner emits text-first then
    // translated blocks rather than discarding text.
    const userMsg: InboxLoopEntry = {
      type: 'user-message',
      payload: {
        role: 'user',
        content: 'what is in this image?',
        contentBlocks: [imageBlock(png)],
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
  // sets HOME to the agent's home (`runnerHomeDir`), `'user'` would land in
  // an agent-writable `<home>/.claude/` and the host-installed-skills
  // surface would be unreachable.
  //
  // The forwarding is structural — it lives in proxy-startup's
  // ENV_ALLOWLIST. This test pins the end-to-end shape by setting
  // process.env.CLAUDE_CONFIG_DIR before main() and asserting the SDK
  // sees the same value in options.env.
  // ---------------------------------------------------------------------

  describe('Phase 0: CLAUDE_CONFIG_DIR forward for skill discovery (I-P0-1)', () => {
    it('forwards CLAUDE_CONFIG_DIR from sandbox env to SDK subprocess', async () => {
      // A real directory: the runner refuses to start on one that is missing.
      const sandboxHome = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'ax-sandbox-home-'));
      onTestFinished(() => fs.rm(sandboxHome, { recursive: true, force: true }));
      const sandboxConfigDir = nodePath.join(sandboxHome, '.ax', 'session');
      await fs.mkdir(sandboxConfigDir, { recursive: true });
      setEnv({ ...COMPLETE_ENV, CLAUDE_CONFIG_DIR: sandboxConfigDir });
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: null,
            runnerSessionId: null,
          };
        }
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
      // Sanity: HOME is still the agent's home — these two env vars
      // partition the design (HOME is the agent's own files; CLAUDE_CONFIG_DIR
      // is the SDK's trusted configuration and its jsonl) and must NOT
      // collapse onto each other.
      expect(queryArg.options.env.HOME).toBe(COMPLETE_ENV.AX_USERFILES_ROOT);
      expect(queryArg.options.env.CLAUDE_CONFIG_DIR).not.toBe(
        queryArg.options.env.HOME,
      );
    });
  });

  // ---------------------------------------------------------------------
  // TASK-994 (design §11): the SDK loads $CLAUDE_CONFIG_DIR as its own
  // trusted configuration (settings.json hooks, CLAUDE.md, skills, MCP
  // servers in .claude.json). Unset, it falls back to `$HOME/.claude` — the
  // agent's own files. So the runner refuses to start unless the directory
  // is set, absolute, exists, and sits outside the agent's home.
  // ---------------------------------------------------------------------
  describe('agent files §11 guards', () => {
    // A host that would happily run a turn, so a refusal can only come from
    // CLAUDE_CONFIG_DIR — never from an incidental boot failure.
    function bootableHost(): void {
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: null,
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
          (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield assistantText('ok');
            yield resultSuccess();
            await it.next();
          })(),
      );
    }

    async function runMain(): Promise<{ rc: number; stderr: string }> {
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { main } = await import('../main.js');
        const rc = await main();
        return { rc, stderr: spy.mock.calls.map((c) => String(c[0])).join('') };
      } finally {
        spy.mockRestore();
      }
    }

    it('refuses to start when CLAUDE_CONFIG_DIR is unset', async () => {
      setEnv({ ...COMPLETE_ENV, CLAUDE_CONFIG_DIR: undefined });
      bootableHost();

      const { rc, stderr } = await runMain();

      expect(rc).toBe(2);
      expect(stderr).toMatch(/missing required env: CLAUDE_CONFIG_DIR/);
      expect(createIpcClientMock).not.toHaveBeenCalled();
      expect(queryMock).not.toHaveBeenCalled();
    });

    it("refuses to start when CLAUDE_CONFIG_DIR reaches the agent's files through a symlink", async () => {
      const t = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'ax-main-guard-'));
      onTestFinished(() => fs.rm(t, { recursive: true, force: true }));
      const files = nodePath.join(t, 'files');
      const planted = nodePath.join(files, '.claude');
      await fs.mkdir(planted, { recursive: true });
      const link = nodePath.join(t, 'link');
      await fs.symlink(planted, link);
      setEnv({ ...COMPLETE_ENV, AX_USERFILES_ROOT: files, CLAUDE_CONFIG_DIR: link });
      bootableHost();

      const { rc, stderr } = await runMain();

      expect(rc).toBe(2);
      expect(stderr).toMatch(/refusing to start: CLAUDE_CONFIG_DIR resolves to .+ which overlaps the agent's home/);
      expect(createIpcClientMock).not.toHaveBeenCalled();
      expect(queryMock).not.toHaveBeenCalled();
      // The refusal came before the runner wrote anything into the agent's files.
      expect(await fs.readdir(files)).toEqual(['.claude']);
      expect(await fs.readdir(planted)).toEqual([]);
    });

    /** Every path under `dir`, relative and sorted. Directories end in '/'. */
    async function listTree(dir: string, rel = ''): Promise<string[]> {
      const out: string[] = [];
      for (const e of await fs.readdir(nodePath.join(dir, rel), { withFileTypes: true })) {
        const p = rel === '' ? e.name : `${rel}/${e.name}`;
        out.push(...(e.isDirectory() ? [`${p}/`, ...(await listTree(dir, p))] : [p]));
      }
      return out.sort();
    }

    // Whatever the agent leaves in its own home must not become the runner's or
    // the SDK's trusted configuration. The plants are the real-binary canary's
    // (agent-files-guards-real-sdk.e2e.test.ts), plus a connector `.mcp.json` in
    // the shape the runner's OWN projection loader accepts. The SDK is a mock
    // here, so this pins what the runner hands it; the e2e pins what the CLI
    // then does with that.
    it('files planted in the agent home reach neither the runner prompt nor the SDK options, and the runner writes nothing there', async () => {
      const t = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'ax-main-canary-'));
      onTestFinished(() => fs.rm(t, { recursive: true, force: true }));
      const files = nodePath.join(t, 'files');
      const scratch = nodePath.join(t, 'tmp');
      const cfg = nodePath.join(t, 'cfg');
      const markers = nodePath.join(t, 'markers');
      await fs.mkdir(scratch);
      await fs.mkdir(nodePath.join(cfg, 'skills'), { recursive: true });
      await fs.mkdir(markers);
      const hook = (event: string) => ({
        hooks: [{ type: 'command', command: `touch '${nodePath.join(markers, `settings-${event}`)}'` }],
      });
      const stdioServer = (marker: string) => ({
        type: 'stdio',
        command: '/bin/sh',
        args: ['-c', `touch '${nodePath.join(markers, marker)}'; sleep 1`],
      });
      const plants = new Map<string, string>([
        ['.ax/SOUL.md', 'CANARY-SOUL-7f3a\n'],
        ['CLAUDE.md', 'CANARY-CLAUDEMD-91bc\n'],
        ['.claude/CLAUDE.md', 'CANARY-DOTCLAUDE-55aa\n'],
        ['.claude/settings.json', JSON.stringify({
          hooks: {
            SessionStart: [hook('SessionStart')],
            UserPromptSubmit: [hook('UserPromptSubmit')],
            Stop: [hook('Stop')],
          },
        })],
        ['.mcp.json', JSON.stringify({ mcpServers: { canaryproj: stdioServer('mcp-json-spawned') } })],
        ['.claude.json', JSON.stringify({ mcpServers: { canaryhome: stdioServer('claude-json-spawned') } })],
        ['.claude/skills/canary-skill/SKILL.md', '---\nname: canary-skill\ndescription: CANARY-SKILL-3c1d\n---\nPlanted by the agent.\n'],
        ['.claude/skills/canary-skill/.mcp.json', JSON.stringify({
          mcpServers: { c0000000000: { type: 'http', url: 'https://canary.example.com/mcp' } },
        })],
      ]);
      for (const [rel, content] of plants) {
        await fs.mkdir(nodePath.dirname(nodePath.join(files, rel)), { recursive: true });
        await fs.writeFile(nodePath.join(files, rel), content);
      }
      const plantedTree = new Set<string>();
      for (const rel of plants.keys()) {
        plantedTree.add(rel);
        const parts = rel.split('/');
        for (let i = 1; i < parts.length; i += 1) plantedTree.add(`${parts.slice(0, i).join('/')}/`);
      }
      setEnv({ ...COMPLETE_ENV, AX_USERFILES_ROOT: files, AX_EPHEMERAL_ROOT: scratch, CLAUDE_CONFIG_DIR: cfg });
      bootableHost();

      const { rc } = await runMain();

      expect(rc).toBe(0);
      expect(queryMock).toHaveBeenCalledTimes(1);
      // Imported here, not at the top: it loads @ax/agent-runner-core, whose
      // mocked internals must not initialize before this file's mock fns do.
      const { MCP_HOST_SERVER_NAME, MCP_SANDBOX_SERVER_NAME } = await import('../tool-names.js');
      const { options } = queryMock.mock.calls[0]![0] as {
        options: {
          systemPrompt: string;
          mcpServers: Record<string, unknown>;
          settingSources: string[];
          cwd: string;
          additionalDirectories?: string[];
          env: Record<string, string | undefined>;
        };
      };
      expect(options.systemPrompt).not.toMatch(/CANARY-/);
      expect(Object.keys(options.mcpServers).sort()).toEqual(
        [MCP_HOST_SERVER_NAME, MCP_SANDBOX_SERVER_NAME].sort(),
      );
      expect(options.settingSources).toEqual(['user']);
      expect(options.cwd).toBe(files);
      expect(options.env.HOME).toBe(files);
      // The scratch root is the only directory granted beyond the home.
      expect(options.additionalDirectories).toEqual([scratch]);
      expect(options.env.CLAUDE_CONFIG_DIR).toBe(cfg);
      expect('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD' in options.env).toBe(false);
      expect(await listTree(files)).toEqual([...plantedTree].sort());
    });

    // TASK-994: where the SDK's transcript working copy lives. With a stamped
    // AX_TRANSCRIPTS_ROOT the SDK's hard-coded `$CLAUDE_CONFIG_DIR/projects`
    // is a link to it and EVERY reader/writer uses the link target; without
    // one the SDK's own per-session projects dir is used as a plain directory.
    describe('transcript directory', () => {
      // A tool-using turn on a bound conversation: exercises the flush wait,
      // both turn-end id reads, the resume restore's source and (via the
      // non-conversation variant below) the local resumable-transcript scan.
      function conversationHost(opts: {
        conversationId: string | null;
        runnerSessionId: string | null;
      }): void {
        fakeClient = buildFakeClient();
        fakeClient.call.mockImplementation(async (action: string) => {
          if (action === 'session.get-config') {
            return {
              userId: 'u-test',
              agentId: 'a-test',
              agentConfig: {
                displayName: 'Test Agent',
                systemPromptAugment: '',
                allowedTools: [],
                mcpConfigIds: [],
                model: 'anthropic/claude-sonnet-4-7',
                runner: 'claude-sdk',
              },
              conversationId: opts.conversationId,
              runnerSessionId: opts.runnerSessionId,
            };
          }
          if (action === 'tool.list') return { tools: [] };
          if (action === 'attachments.list') return { files: [] };
          if (action === 'conversation.store-runner-session') return { ok: true };
          throw new Error(`unexpected call: ${action}`);
        });
        fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
        queryMock.mockImplementation(
          ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
            (async function* () {
              const it = prompt[Symbol.asyncIterator]();
              await it.next();
              yield systemInit('sdk-sess-t');
              yield assistantText('ok', 'asst-uuid');
              yield resultSuccess();
              await it.next();
            })(),
        );
      }

      it("with AX_TRANSCRIPTS_ROOT, the SDK's projects dir links to it and every transcript reader uses it", async () => {
        const t = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'ax-main-tr-'));
        onTestFinished(() => fs.rm(t, { recursive: true, force: true }));
        const root = nodePath.join(t, 'transcripts');
        // Its own config dir: the link into `root` must not outlive `t` inside
        // the shared CONFIG_DIR, where it would dangle for every later test.
        const cfg = nodePath.join(t, 'cfg');
        await fs.mkdir(cfg);
        setEnv({ ...COMPLETE_ENV, CLAUDE_CONFIG_DIR: cfg, AX_TRANSCRIPTS_ROOT: root });
        conversationHost({ conversationId: 'cnv-t', runnerSessionId: null });

        const { rc } = await runMain();

        expect(rc).toBe(0);
        const link = nodePath.join(cfg, 'projects');
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
        expect(await fs.readlink(link)).toBe(root);
        expect(createJsonlTranscriptSourceSpy).toHaveBeenCalledWith(root, COMPLETE_ENV.AX_USERFILES_ROOT);
        expect(waitForTranscriptUuidMock).toHaveBeenCalledWith(
          root,
          'sdk-sess-t',
          'asst-uuid',
          expect.anything(),
        );
        expect(readLastTurnUuidMock).toHaveBeenCalledWith(root, 'sdk-sess-t', 'assistant');
      });

      it('with AX_TRANSCRIPTS_ROOT, the local resumable-transcript scan reads the root', async () => {
        const t = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'ax-main-tr-'));
        onTestFinished(() => fs.rm(t, { recursive: true, force: true }));
        const root = nodePath.join(t, 'transcripts');
        const cfg = nodePath.join(t, 'cfg');
        await fs.mkdir(cfg);
        setEnv({ ...COMPLETE_ENV, CLAUDE_CONFIG_DIR: cfg, AX_TRANSCRIPTS_ROOT: root });
        conversationHost({ conversationId: null, runnerSessionId: 'sdk-bound' });

        const { rc } = await runMain();

        expect(rc).toBe(0);
        expect(hasResumableTranscriptMock).toHaveBeenCalledWith(root, 'sdk-bound');
      });

      it('without AX_TRANSCRIPTS_ROOT, transcripts stay in the per-session $CLAUDE_CONFIG_DIR/projects as a plain directory', async () => {
        const cfg = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'ax-main-cfg2-'));
        onTestFinished(() => fs.rm(cfg, { recursive: true, force: true }));
        setEnv({ ...COMPLETE_ENV, CLAUDE_CONFIG_DIR: cfg });
        conversationHost({ conversationId: 'cnv-t', runnerSessionId: null });

        const { rc } = await runMain();

        expect(rc).toBe(0);
        const projects = nodePath.join(cfg, 'projects');
        const st = await fs.lstat(projects);
        expect(st.isDirectory()).toBe(true);
        expect(st.isSymbolicLink()).toBe(false);
        expect(createJsonlTranscriptSourceSpy).toHaveBeenCalledWith(projects, COMPLETE_ENV.AX_USERFILES_ROOT);
        expect(readLastTurnUuidMock).toHaveBeenCalledWith(projects, 'sdk-sess-t', 'assistant');
      });
    });
  });

  // TASK-760: a connector attached to the agent arrives as an installed-skill
  // entry whose mcpServers the runner materializes as
  // `$CLAUDE_CONFIG_DIR/skills/<id>/.mcp.json`, keyed by toolNamespace. The SDK
  // never reads that file, so the runner must hand the servers to query()
  // itself. This drives the REAL materializer (AX_INSTALLED_SKILLS_JSON → disk)
  // and the REAL options builder: on main before TASK-760 `mcpServers` held only
  // our two in-process servers and the connector tool never reached the model.
  it('connector MCP servers materialized into the skills projection reach query() mcpServers (TASK-760)', async () => {
    const cfg = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'ax-t760-cfg-'));
    try {
      setEnv({
        ...COMPLETE_ENV,
        CLAUDE_CONFIG_DIR: cfg,
        AX_INSTALLED_SKILLS_JSON: JSON.stringify([
          {
            id: 'connector-linear',
            files: [{ path: 'SKILL.md', contents: '---\nname: connector-linear\ndescription: Linear\n---\nbody' }],
            mcpServers: [
              { name: 'c0123456789', transport: 'http', url: 'https://linear.example.com/mcp', headers: { 'X-Api-Key': 'ax-cred:' + 'a'.repeat(32) } },
              { name: 'cabcdef0123', transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ax-cred:' + 'b'.repeat(32) } },
            ],
          },
        ]),
      });
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: null,
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        throw new Error(`unexpected call: ${action}`);
      });
      fakeInbox = buildFakeInbox([userEntry('hi'), cancelEntry]);
      queryMock.mockImplementation(
        ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) =>
          (async function* () {
            const it = prompt[Symbol.asyncIterator]();
            await it.next();
            yield assistantText('ok');
            yield resultSuccess();
            await it.next();
          })(),
      );

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);

      const opts = (queryMock.mock.calls[0]?.[0] as {
        options: { mcpServers: Record<string, unknown>; settingSources: string[] };
      }).options;
      expect(opts.mcpServers['c0123456789']).toEqual({
        type: 'http',
        url: 'https://linear.example.com/mcp',
        headers: { 'X-Api-Key': 'ax-cred:' + 'a'.repeat(32) },
      });
      expect(opts.mcpServers['cabcdef0123']).toEqual({
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer ax-cred:' + 'b'.repeat(32) },
      });
      // Our own two servers are still there, and 'project' is still NOT a
      // setting source — loading connectors must not reopen that door.
      expect(opts.mcpServers).toHaveProperty('ax-host-tools');
      expect(opts.mcpServers).toHaveProperty('ax-sandbox-tools');
      expect(Object.keys(opts.mcpServers).sort()).toEqual(
        ['ax-host-tools', 'ax-sandbox-tools', 'c0123456789', 'cabcdef0123'],
      );
      expect(opts.settingSources).toEqual(['user']);
    } finally {
      // The materializer locks the tree 0555; unlock so rm can clean it.
      await fs.chmod(nodePath.join(cfg, 'skills'), 0o755).catch(() => {});
      await fs.chmod(nodePath.join(cfg, 'skills', 'connector-linear'), 0o755).catch(() => {});
      await fs.rm(cfg, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // TASK-688 — Stop. The shell routes an `interrupt` inbox entry to the handler
  // this loop registers; the handler is `Query.interrupt()`, and nothing else.
  //
  // MEASURED-BY-PROBE (2026-09-29, the real `claude` binary 0.2.119 against a
  // scripted local Anthropic-compatible server): `interrupt()` during a Bash
  // call kills the command (exit 137), yields a tool_result flagged is_error and
  // a `result` with `terminal_reason: 'aborted_tools'`; during text streaming it
  // keeps the partial assistant message and yields 'aborted_streaming'; and the
  // SAME query serves the next message. So the loop's existing `result` branch
  // is the whole ending — these tests fake exactly that behaviour and pin that
  // the loop asks for it, once, and carries on.
  // -------------------------------------------------------------------------
  describe('Stop (TASK-688)', () => {
    function resultInterrupted(terminalReason: 'aborted_streaming' | 'aborted_tools'): SDKMessage {
      return {
        ...(resultSuccess() as unknown as Record<string, unknown>),
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: terminalReason,
        errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
      } as unknown as SDKMessage;
    }
    function wireConfig(): void {
      fakeClient = buildFakeClient();
      fakeClient.call.mockImplementation(async (action: string) => {
        if (action === 'session.get-config') {
          return {
            userId: 'u-test',
            agentId: 'a-test',
            agentConfig: {
              displayName: 'Test Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-7',
              runner: 'claude-sdk',
            },
            conversationId: null,
            runnerSessionId: null,
          };
        }
        if (action === 'tool.list') return { tools: [] };
        throw new Error(`unexpected call: ${action}`);
      });
    }
    function deferred<T = void>() {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }
    /** An inbox whose entries are released by the test; exhausted -> cancel. */
    function gatedInbox(entries: Array<() => Promise<InboxLoopEntry>>): void {
      const queue = [...entries];
      fakeInbox = {
        next: vi.fn(async (): Promise<InboxLoopEntry> => {
          const e = queue.shift();
          return e !== undefined ? e() : { type: 'cancel' };
        }),
        cursor: 0,
      } as unknown as FakeInbox;
    }
    const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

    it('latches startup Stop through the prompt hook and clears it for the next turn', async () => {
      setEnv(COMPLETE_ENV);
      wireConfig();
      const interrupted = deferred();
      const continueInbox = deferred();
      const nextTurn = deferred();
      gatedInbox([
        async () => userEntry('do work'),
        async () => ({ type: 'interrupt' }),
        async () => { await continueInbox.promise; return userEntry('next turn'); },
        async () => { await nextTurn.promise; return cancelEntry; },
      ]);
      const interrupt = vi.fn(async () => { interrupted.resolve(); });
      queryMock.mockImplementation(({ prompt, options }: {
        prompt: AsyncIterable<SDKUserMessage>;
        options: { hooks: { UserPromptSubmit: Array<{ hooks: Array<() => Promise<unknown>> }> } };
      }) => {
        const gen = (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          // SDK interrupt can acknowledge while idle; the prompt gate must
          // still stop work when the native process eventually consumes it.
          await interrupted.promise;
          expect(await options.hooks.UserPromptSubmit[0]!.hooks[0]!()).toMatchObject({ continue: false });
          yield resultSuccess();
          continueInbox.resolve();
          await it.next();
          expect(await options.hooks.UserPromptSubmit[0]!.hooks[0]!()).toEqual({});
          yield assistantText('Ready again.');
          yield resultSuccess();
          nextTurn.resolve();
          await it.next();
        })();
        return Object.assign(gen, { interrupt });
      });
      const { main } = await import('../main.js');
      expect(await main()).toBe(0);
      expect(interrupt).toHaveBeenCalledTimes(1);
      const turns = fakeClient.event.mock.calls.filter(c => c[0] === 'event.turn-end' && (c[1] as { role?: string }).role === 'assistant');
      expect(turns).toHaveLength(2);
    });

    it.each(['aborted_streaming', 'aborted_tools'] as const)('an interrupt mid-turn (%s) asks the SDK to interrupt, once, and the turn ends through the normal result path', async (terminalReason) => {
      setEnv(COMPLETE_ENV);
      wireConfig();
      const stop = deferred();
      const finish = deferred();
      const interrupted = deferred();
      gatedInbox([
        async () => userEntry('write me a long story'),
        async () => {
          await stop.promise;
          return { type: 'interrupt' };
        },
        async () => {
          await finish.promise;
          return cancelEntry;
        },
      ]);
      const interrupt = vi.fn(async () => {
        // What the real SDK does: the current turn ends with an aborted result.
        interrupted.resolve();
      });
      queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        const gen = (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantText('Once upon a ');
          stop.resolve(); // the person presses Stop mid-reply
          await interrupted.promise; // ... and nothing more happens until the SDK is asked
          yield resultInterrupted(terminalReason);
          finish.resolve();
          await it.next(); // the cancel that ends the session, later
        })();
        return Object.assign(gen, { interrupt });
      });

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);

      expect(interrupt).toHaveBeenCalledTimes(1);
      // The stopped turn closes like any other: one assistant turn-end carrying
      // the words the person saw, stamped with the turn's own reqId.
      const turnEnds = fakeClient.event.mock.calls.filter(
        (c) => c[0] === 'event.turn-end' && (c[1] as { role?: string }).role === 'assistant',
      );
      expect(turnEnds).toHaveLength(1);
      expect(turnEnds[0]?.[1]).toMatchObject({
        reqId: 'req-test',
        contentBlocks: [{ type: 'text', text: 'Once upon a ' }],
      });
      // And the runner ended only because the SESSION was cancelled afterwards.
      const chatEnds = fakeClient.event.mock.calls.filter((c) => c[0] === 'event.chat-end');
      expect(chatEnds).toHaveLength(1);
      expect((chatEnds[0]?.[1] as { outcome: { kind: string } }).outcome.kind).toBe('complete');
    });

    it('an interrupt with no turn running never reaches the SDK', async () => {
      setEnv(COMPLETE_ENV);
      wireConfig();
      const late = deferred();
      gatedInbox([
        async () => ({ type: 'interrupt' }), // before any message: idle
        async () => userEntry('hi'),
        async () => {
          await late.promise;
          return { type: 'interrupt' }; // after the turn: idle again
        },
        async () => cancelEntry,
      ]);
      const interrupt = vi.fn(async () => undefined);
      queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        const gen = (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantText('hello');
          yield resultSuccess();
          late.resolve();
          await flush();
          await it.next();
        })();
        return Object.assign(gen, { interrupt });
      });

      const { main } = await import('../main.js');
      expect(await main()).toBe(0);
      // An idle `query.interrupt()` is harmless in the SDK (probed), but a
      // press that lost the race with the turn's own ending has no business
      // reaching a process that has moved on to the next one.
      expect(interrupt).not.toHaveBeenCalled();
    });

    it('a failing query.interrupt() does not take the runner down', async () => {
      setEnv(COMPLETE_ENV);
      wireConfig();
      const stop = deferred();
      gatedInbox([
        async () => userEntry('go'),
        async () => {
          await stop.promise;
          return { type: 'interrupt' };
        },
      ]);
      const interrupt = vi.fn(async () => {
        throw new Error('control channel closed');
      });
      queryMock.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
        const gen = (async function* () {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield assistantText('partial');
          stop.resolve();
          await flush();
          await flush();
          yield resultSuccess();
          await it.next();
        })();
        return Object.assign(gen, { interrupt });
      });

      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const { main } = await import('../main.js');
        // The turn ends on its own result; the failed interrupt is logged, not thrown.
        expect(await main()).toBe(0);
        expect(interrupt).toHaveBeenCalledTimes(1);
        // Logged, not swallowed: an operator reading the pod log can see that
        // Stop was pressed and the SDK refused. (Without a `.catch` this is an
        // unhandled rejection instead — and nothing in the log.)
        expect(
          stderr.mock.calls.some((c) =>
            String(c[0]).includes('query.interrupt() failed: control channel closed'),
          ),
        ).toBe(true);
      } finally {
        stderr.mockRestore();
      }
    });
  });
});
