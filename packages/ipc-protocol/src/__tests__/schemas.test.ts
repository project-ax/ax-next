import { describe, it, expect } from 'vitest';
import {
  ToolPreCallRequestSchema,
  ToolPreCallResponseSchema,
  ToolExecuteHostRequestSchema,
  ToolExecuteHostResponseSchema,
  ToolListRequestSchema,
  ToolListResponseSchema,
  WorkspaceCommitNotifyRequestSchema,
  WorkspaceCommitNotifyResponseSchema,
  WorkspaceMaterializeRequestSchema,
  WorkspaceMaterializeResponseSchema,
  SessionNextMessageResponseSchema,
  SessionGetConfigResponseSchema,
  ConversationFetchHistoryRequestSchema,
  ConversationFetchHistoryResponseSchema,
  ToolDescriptorSchema,
  ToolCallSchema,
  AgentMessageSchema,
  asWorkspaceVersion,
  type WorkspaceVersion,
} from '../actions.js';
import {
  EventStreamChunkSchema,
  EventToolPostCallSchema,
  EventTurnEndSchema,
  EventChatEndSchema,
  AgentOutcomeSchema,
} from '../events.js';
import {
  IpcErrorCodeSchema,
  IpcErrorSchema,
  IpcErrorEnvelopeSchema,
} from '../errors.js';
import { IPC_TIMEOUTS_MS, type IpcActionName } from '../timeouts.js';

describe('tool.pre-call', () => {
  it('accepts an allow verdict with modifiedCall', () => {
    const parsed = ToolPreCallResponseSchema.parse({
      verdict: 'allow',
      modifiedCall: { id: 'c1', name: 'bash', input: { cmd: 'ls -la' } },
    });
    expect(parsed.verdict).toBe('allow');
    if (parsed.verdict === 'allow') {
      expect(parsed.modifiedCall?.input).toEqual({ cmd: 'ls -la' });
    }
  });

  it('accepts a bare allow verdict', () => {
    const parsed = ToolPreCallResponseSchema.parse({ verdict: 'allow' });
    expect(parsed.verdict).toBe('allow');
  });

  it('accepts a reject verdict with a reason', () => {
    const parsed = ToolPreCallResponseSchema.parse({
      verdict: 'reject',
      reason: 'blocked by policy',
    });
    expect(parsed.verdict).toBe('reject');
    if (parsed.verdict === 'reject') {
      expect(parsed.reason).toBe('blocked by policy');
    }
  });

  it('rejects an invalid verdict', () => {
    const r = ToolPreCallResponseSchema.safeParse({ verdict: 'maybe' });
    expect(r.success).toBe(false);
  });

  it('round-trips a request payload', () => {
    const parsed = ToolPreCallRequestSchema.parse({
      call: { id: 'c1', name: 'bash', input: { cmd: 'ls' } },
    });
    expect(parsed.call.name).toBe('bash');
  });
});

describe('tool.execute-host', () => {
  it('round-trips request and response', () => {
    const req = ToolExecuteHostRequestSchema.parse({
      call: { id: 'c1', name: 'http-fetch', input: { url: 'https://x' } },
    });
    expect(req.call.id).toBe('c1');
    const res = ToolExecuteHostResponseSchema.parse({
      output: { status: 200, body: 'ok' },
    });
    expect(res.output).toEqual({ status: 200, body: 'ok' });
  });
});

describe('tool.list', () => {
  it('round-trips an empty catalog', () => {
    const req = ToolListRequestSchema.parse({});
    expect(req).toEqual({});
    const res = ToolListResponseSchema.parse({ tools: [] });
    expect(res.tools).toEqual([]);
  });

  it('rejects an unknown key on the request (strict)', () => {
    const r = ToolListRequestSchema.safeParse({ surprise: true });
    expect(r.success).toBe(false);
  });

  it('round-trips a populated catalog', () => {
    const res = ToolListResponseSchema.parse({
      tools: [
        {
          name: 'bash',
          description: 'run shell',
          inputSchema: { type: 'object' },
          executesIn: 'sandbox',
        },
        {
          name: 'http-fetch',
          inputSchema: { type: 'object' },
          executesIn: 'host',
        },
      ],
    });
    expect(res.tools).toHaveLength(2);
    expect(res.tools[1]?.executesIn).toBe('host');
  });

  it('requires executesIn on a descriptor', () => {
    const r = ToolDescriptorSchema.safeParse({
      name: 'bash',
      inputSchema: { type: 'object' },
    });
    expect(r.success).toBe(false);
  });
});

describe('workspace.commit-notify', () => {
  it('accepts the accepted shape with version and delta:null', () => {
    const parsed = WorkspaceCommitNotifyResponseSchema.parse({
      accepted: true,
      version: 'v-token-abc',
      delta: null,
    });
    expect(parsed.accepted).toBe(true);
    if (parsed.accepted) {
      expect(parsed.version).toBe('v-token-abc');
      expect(parsed.delta).toBeNull();
      // Brand check: the transform gives parsed.version the
      // WorkspaceVersion brand so callers don't need a cast.
      const branded: WorkspaceVersion = parsed.version;
      expect(branded).toBe('v-token-abc');
    }
  });

  it('brands version via asWorkspaceVersion helper', () => {
    const v: WorkspaceVersion = asWorkspaceVersion('raw-from-backend');
    expect(v).toBe('raw-from-backend');
  });

  it('accepts the rejected shape with a reason', () => {
    const parsed = WorkspaceCommitNotifyResponseSchema.parse({
      accepted: false,
      reason: 'stale parent',
    });
    expect(parsed.accepted).toBe(false);
    if (!parsed.accepted) {
      expect(parsed.reason).toBe('stale parent');
    }
  });

  it('rejects a malformed response', () => {
    const r = WorkspaceCommitNotifyResponseSchema.safeParse({
      accepted: true,
      version: 'v1',
      // missing delta
    });
    expect(r.success).toBe(false);
  });

  it('round-trips a request payload', () => {
    const parsed = WorkspaceCommitNotifyRequestSchema.parse({
      parentVersion: null,
      commitRef: 'abc123',
      message: 'initial',
    });
    expect(parsed.parentVersion).toBeNull();
    expect(parsed.commitRef).toBe('abc123');
  });
});

describe('workspace.materialize', () => {
  it('round-trips an empty bundle (brand-new workspace)', () => {
    // Empty string => the host has nothing to ship. The runner reads this
    // and does `git init` on /permanent instead of `git clone`.
    const parsed = WorkspaceMaterializeResponseSchema.parse({ bundleBytes: '' });
    expect(parsed.bundleBytes).toBe('');
  });

  it('round-trips a non-empty bundle', () => {
    // Bytes are opaque base64 on the wire — schema does NOT decode (the
    // runner side decodes on its own to write the file). We just preserve
    // the payload faithfully.
    const b64 = Buffer.from('PACK\x00\x00').toString('base64');
    const parsed = WorkspaceMaterializeResponseSchema.parse({ bundleBytes: b64 });
    expect(parsed.bundleBytes).toBe(b64);
  });

  it('rejects a response missing bundleBytes', () => {
    expect(WorkspaceMaterializeResponseSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a response with non-string bundleBytes', () => {
    expect(
      WorkspaceMaterializeResponseSchema.safeParse({ bundleBytes: 42 }).success,
    ).toBe(false);
  });

  it('request schema accepts an empty object', () => {
    expect(WorkspaceMaterializeRequestSchema.parse({})).toEqual({});
  });

  it('request schema rejects extra fields (.strict)', () => {
    // The session's bearer token already identifies the workspace; any
    // request field would be a vector for "fetch SOMEONE ELSE'S baseline."
    // Closing that door at the schema layer makes the invariant load-bearing.
    expect(
      WorkspaceMaterializeRequestSchema.safeParse({ workspaceId: 'other' })
        .success,
    ).toBe(false);
  });
});

describe('session.next-message response', () => {
  it('round-trips a user-message variant', () => {
    const parsed = SessionNextMessageResponseSchema.parse({
      type: 'user-message',
      payload: { role: 'user', content: 'hello' },
      reqId: 'req-1',
      cursor: 3,
    });
    expect(parsed.type).toBe('user-message');
    if (parsed.type === 'user-message') {
      expect(parsed.payload.content).toBe('hello');
      expect(parsed.reqId).toBe('req-1');
      expect(parsed.cursor).toBe(3);
    }
  });

  it('rejects a user-message variant missing reqId', () => {
    // J9: every server-delivered user message MUST carry the host-minted
    // reqId so the runner can stamp event.stream-chunk emissions with it.
    // Allowing reqId to be missing would silently break stream routing.
    const r = SessionNextMessageResponseSchema.safeParse({
      type: 'user-message',
      payload: { role: 'user', content: 'hello' },
      cursor: 3,
    });
    expect(r.success).toBe(false);
  });

  it('round-trips a cancel variant', () => {
    const parsed = SessionNextMessageResponseSchema.parse({
      type: 'cancel',
      cursor: 7,
    });
    expect(parsed.type).toBe('cancel');
    expect(parsed.cursor).toBe(7);
  });

  it('round-trips a timeout variant', () => {
    const parsed = SessionNextMessageResponseSchema.parse({
      type: 'timeout',
      cursor: 9,
    });
    expect(parsed.type).toBe('timeout');
  });

  it('rejects an unknown type', () => {
    const r = SessionNextMessageResponseSchema.safeParse({
      type: 'surprise',
      cursor: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe('events', () => {
  it('EventStreamChunk round-trips valid payload', () => {
    const parsed = EventStreamChunkSchema.parse({
      reqId: 'r1',
      text: 'hi',
      kind: 'text',
    });
    expect(parsed.kind).toBe('text');
    const thinking = EventStreamChunkSchema.parse({
      reqId: 'r1',
      text: 'pondering',
      kind: 'thinking',
    });
    expect(thinking.kind).toBe('thinking');
  });

  it('EventStreamChunk rejects an invalid kind', () => {
    const r = EventStreamChunkSchema.safeParse({
      reqId: 'r1',
      text: 'x',
      kind: 'sarcasm',
    });
    expect(r.success).toBe(false);
  });

  it('EventToolPostCall round-trips a valid payload', () => {
    const parsed = EventToolPostCallSchema.parse({
      call: { id: 'c1', name: 'bash', input: { cmd: 'ls' } },
      output: { exitCode: 0, stdout: 'a\n' },
      durationMs: 42,
    });
    expect(parsed.durationMs).toBe(42);
    expect(parsed.call.name).toBe('bash');
  });

  it('EventToolPostCall rejects missing call', () => {
    const r = EventToolPostCallSchema.safeParse({ output: 'x' });
    expect(r.success).toBe(false);
  });

  it('EventTurnEnd round-trips each reason', () => {
    for (const reason of ['user-message-wait', 'error', 'complete'] as const) {
      const parsed = EventTurnEndSchema.parse({
        reqId: 'r1',
        reason,
        usage: { inputTokens: 1, outputTokens: 2 },
      });
      expect(parsed.reason).toBe(reason);
    }
  });

  it('EventTurnEnd rejects an unknown reason', () => {
    const r = EventTurnEndSchema.safeParse({ reason: 'giving-up' });
    expect(r.success).toBe(false);
  });

  it('EventChatEnd round-trips a complete outcome', () => {
    const parsed = EventChatEndSchema.parse({
      outcome: {
        kind: 'complete',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(parsed.outcome.kind).toBe('complete');
    if (parsed.outcome.kind === 'complete') {
      expect(parsed.outcome.messages).toHaveLength(1);
    }
  });

  it('EventChatEnd round-trips a terminated outcome', () => {
    const parsed = EventChatEndSchema.parse({
      outcome: { kind: 'terminated', reason: 'panic', error: { msg: 'boom' } },
    });
    expect(parsed.outcome.kind).toBe('terminated');
  });

  it('EventChatEnd rejects a malformed outcome', () => {
    const r = EventChatEndSchema.safeParse({
      outcome: { kind: 'mystery' },
    });
    expect(r.success).toBe(false);
  });
});

describe('session.get-config', () => {
  const baseConfig = {
    systemPrompt: 'be helpful',
    allowedTools: ['file.read'],
    mcpConfigIds: [],
    model: 'claude-sonnet-4-7',
  };

  it('accepts a response with conversationId set', () => {
    const parsed = SessionGetConfigResponseSchema.parse({
      userId: 'u-1',
      agentId: 'a-1',
      agentConfig: baseConfig,
      conversationId: 'cnv_abc',
    });
    expect(parsed.conversationId).toBe('cnv_abc');
  });

  it('accepts a response with conversationId null (non-conversation session)', () => {
    const parsed = SessionGetConfigResponseSchema.parse({
      userId: 'u-1',
      agentId: 'a-1',
      agentConfig: baseConfig,
      conversationId: null,
    });
    expect(parsed.conversationId).toBeNull();
  });

  it('rejects a response missing conversationId (must be explicit null)', () => {
    const r = SessionGetConfigResponseSchema.safeParse({
      userId: 'u-1',
      agentId: 'a-1',
      agentConfig: baseConfig,
    });
    expect(r.success).toBe(false);
  });
});

describe('conversation.fetch-history', () => {
  it('request requires a non-empty conversationId', () => {
    expect(
      ConversationFetchHistoryRequestSchema.safeParse({ conversationId: '' })
        .success,
    ).toBe(false);
    const ok = ConversationFetchHistoryRequestSchema.parse({
      conversationId: 'cnv_abc',
    });
    expect(ok.conversationId).toBe('cnv_abc');
  });

  it('request rejects unknown fields (strict)', () => {
    const r = ConversationFetchHistoryRequestSchema.safeParse({
      conversationId: 'cnv_abc',
      sneaky: 'no',
    });
    expect(r.success).toBe(false);
  });

  it('request rejects an oversized conversationId (>256 chars)', () => {
    const r = ConversationFetchHistoryRequestSchema.safeParse({
      conversationId: 'c'.repeat(257),
    });
    expect(r.success).toBe(false);
  });

  it('response round-trips an empty turn list', () => {
    const parsed = ConversationFetchHistoryResponseSchema.parse({ turns: [] });
    expect(parsed.turns).toEqual([]);
  });

  it('response round-trips user/assistant/tool turns with content blocks', () => {
    const parsed = ConversationFetchHistoryResponseSchema.parse({
      turns: [
        {
          role: 'user',
          contentBlocks: [{ type: 'text', text: 'hello' }],
        },
        {
          role: 'assistant',
          contentBlocks: [
            { type: 'thinking', thinking: 'plan', signature: 'sig' },
            { type: 'text', text: 'hi back' },
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
      ],
    });
    expect(parsed.turns).toHaveLength(3);
    expect(parsed.turns[0]?.role).toBe('user');
    expect(parsed.turns[2]?.contentBlocks[0]?.type).toBe('tool_result');
  });

  it('response rejects an unknown role', () => {
    const r = ConversationFetchHistoryResponseSchema.safeParse({
      turns: [
        { role: 'system', contentBlocks: [{ type: 'text', text: 'x' }] },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('response rejects malformed content blocks (canonical schema)', () => {
    const r = ConversationFetchHistoryResponseSchema.safeParse({
      turns: [{ role: 'user', contentBlocks: [{ type: 'mystery' }] }],
    });
    expect(r.success).toBe(false);
  });
});

describe('errors', () => {
  it('enum covers exactly the six codes', () => {
    const expected = [
      'SESSION_INVALID',
      'HOST_UNAVAILABLE',
      'VALIDATION',
      'HOOK_REJECTED',
      'NOT_FOUND',
      'INTERNAL',
    ] as const;
    // Values are iterable via options
    const values = IpcErrorCodeSchema.options;
    expect([...values].sort()).toEqual([...expected].sort());
  });

  it('IpcErrorSchema round-trips a valid error', () => {
    const parsed = IpcErrorSchema.parse({
      code: 'VALIDATION',
      message: 'bad input',
    });
    expect(parsed.code).toBe('VALIDATION');
  });

  it('IpcErrorEnvelopeSchema rejects unknown fields', () => {
    const r = IpcErrorEnvelopeSchema.safeParse({
      error: { code: 'INTERNAL', message: 'x' },
      extra: 'leak',
    });
    expect(r.success).toBe(false);
  });

  it('IpcErrorEnvelopeSchema accepts a well-formed envelope', () => {
    const parsed = IpcErrorEnvelopeSchema.parse({
      error: { code: 'HOST_UNAVAILABLE', message: 'no host' },
    });
    expect(parsed.error.code).toBe('HOST_UNAVAILABLE');
  });
});

describe('timeouts', () => {
  it('IPC_TIMEOUTS_MS is frozen', () => {
    expect(Object.isFrozen(IPC_TIMEOUTS_MS)).toBe(true);
  });

  it('IPC_TIMEOUTS_MS has the seven expected keys', () => {
    const expected = [
      'tool.pre-call',
      'tool.execute-host',
      'tool.list',
      'workspace.commit-notify',
      'session.next-message',
      'session.get-config',
      'conversation.fetch-history',
    ].sort();
    expect(Object.keys(IPC_TIMEOUTS_MS).sort()).toEqual(expected);
  });

  it('IpcActionName type is assignable from each key', () => {
    // Type-level check: compile error if the keys do not match.
    const names: IpcActionName[] = [
      'tool.pre-call',
      'tool.execute-host',
      'tool.list',
      'workspace.commit-notify',
      'session.next-message',
      'session.get-config',
      'conversation.fetch-history',
    ];
    expect(names).toHaveLength(7);
  });
});

describe('shared schemas exported', () => {
  it('AgentMessageSchema rejects unknown role', () => {
    const r = AgentMessageSchema.safeParse({ role: 'alien', content: 'hi' });
    expect(r.success).toBe(false);
  });

  it('ToolCallSchema accepts unknown input shape', () => {
    const parsed = ToolCallSchema.parse({
      id: 'c1',
      name: 'bash',
      input: 'anything-goes',
    });
    expect(parsed.input).toBe('anything-goes');
  });

  it('AgentMessageSchema parses a valid message', () => {
    const r = AgentMessageSchema.safeParse({ role: 'user', content: 'hi' });
    expect(r.success).toBe(true);
  });

  describe('AgentMessage role narrowing (Phase 7)', () => {
    it('accepts user and assistant roles', () => {
      expect(AgentMessageSchema.parse({ role: 'user', content: 'hi' }).role).toBe('user');
      expect(AgentMessageSchema.parse({ role: 'assistant', content: 'hi' }).role).toBe('assistant');
    });

    it('rejects the system role at the wire layer', () => {
      const r = AgentMessageSchema.safeParse({ role: 'system', content: 'be brief' });
      expect(r.success).toBe(false);
    });
  });

  it('AgentOutcomeSchema parses a complete outcome', () => {
    const r = AgentOutcomeSchema.safeParse({
      kind: 'complete',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.success).toBe(true);
  });
});
