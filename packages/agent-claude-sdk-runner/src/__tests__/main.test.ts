import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  IpcClient,
  IpcClientOptions,
  InboxLoop,
  InboxLoopEntry,
  InboxLoopOptions,
} from '@ax/agent-runner-core';
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

vi.mock('@ax/agent-runner-core', () => ({
  createIpcClient: (opts: IpcClientOptions): IpcClient => {
    createIpcClientMock(opts);
    return fakeClient;
  },
  createInboxLoop: (opts: InboxLoopOptions): InboxLoop => {
    createInboxLoopMock(opts);
    return fakeInbox;
  },
}));

const COMPLETE_ENV = {
  AX_IPC_SOCKET: '/tmp/ax.sock',
  AX_SESSION_ID: 'sess-1',
  AX_AUTH_TOKEN: 'tok-123',
  AX_WORKSPACE_ROOT: '/tmp/workspace',
  AX_LLM_PROXY_URL: 'http://127.0.0.1:4000',
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

const userEntry = (content: string): InboxLoopEntry => ({
  type: 'user-message',
  payload: { role: 'user', content },
});
const cancelEntry: InboxLoopEntry = { type: 'cancel' };

beforeEach(() => {
  queryMock.mockReset();
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

    expect(fakeClient.call).toHaveBeenCalledTimes(1);
    expect(fakeClient.call).toHaveBeenCalledWith('tool.list', {});

    const turnEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.turn-end',
    );
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.[1]).toEqual({ reason: 'user-message-wait' });

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
        env: { ANTHROPIC_BASE_URL: string; ANTHROPIC_API_KEY: string };
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
    expect(queryArg.options.env.ANTHROPIC_BASE_URL).toBe(
      COMPLETE_ENV.AX_LLM_PROXY_URL,
    );
    expect(queryArg.options.env.ANTHROPIC_API_KEY).toBe(
      COMPLETE_ENV.AX_AUTH_TOKEN,
    );

    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });

  it('bootstrap failure: missing AX_LLM_PROXY_URL → exit 2, no chat-end, no query', async () => {
    setEnv({ ...COMPLETE_ENV, AX_LLM_PROXY_URL: undefined });
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
      expect(stderrMessages).toContain('AX_LLM_PROXY_URL');

      expect(queryMock).not.toHaveBeenCalled();
      expect(fakeClient.event).not.toHaveBeenCalled();
      expect(createIpcClientMock).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('terminated path: SDK throws mid-stream → exit 1, chat-end outcome.kind=terminated', async () => {
    setEnv(COMPLETE_ENV);
    fakeClient = buildFakeClient();
    fakeClient.call.mockImplementation(async (action: string) => {
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
      outcome: { kind: string; reason?: string };
    };
    expect(payload.outcome.kind).toBe('terminated');
    expect(payload.outcome.reason).toBe('Error');

    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });
});
