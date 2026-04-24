import { describe, it, expect } from 'vitest';
import {
  LlmCallRequestSchema,
  LlmCallResponseSchema,
  ToolPreCallRequestSchema,
  ToolPreCallResponseSchema,
  ToolExecuteHostRequestSchema,
  ToolExecuteHostResponseSchema,
  ToolListRequestSchema,
  ToolListResponseSchema,
  WorkspaceCommitNotifyRequestSchema,
  WorkspaceCommitNotifyResponseSchema,
  SessionNextMessageResponseSchema,
  ToolDescriptorSchema,
  ToolCallSchema,
  ChatMessageSchema,
  asWorkspaceVersion,
  type WorkspaceVersion,
} from '../actions.js';
import {
  EventStreamChunkSchema,
  EventToolPostCallSchema,
  EventTurnEndSchema,
  EventChatEndSchema,
} from '../events.js';
import {
  IpcErrorCodeSchema,
  IpcErrorSchema,
  IpcErrorEnvelopeSchema,
} from '../errors.js';
import { IPC_TIMEOUTS_MS, type IpcActionName } from '../timeouts.js';

describe('llm.call', () => {
  it('accepts a minimal request', () => {
    const parsed = LlmCallRequestSchema.parse({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.role).toBe('user');
  });

  it('rejects an unknown role', () => {
    const result = LlmCallRequestSchema.safeParse({
      messages: [{ role: 'bot', content: 'hi' }],
    });
    expect(result.success).toBe(false);
  });

  it('round-trips a response with tool calls', () => {
    const payload = {
      assistantMessage: { role: 'assistant', content: 'ok' },
      toolCalls: [{ id: 'c1', name: 'bash', input: { cmd: 'ls' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const parsed = LlmCallResponseSchema.parse(payload);
    expect(parsed.assistantMessage.content).toBe('ok');
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.name).toBe('bash');
    expect(parsed.usage?.inputTokens).toBe(10);
  });

  it('allows an optional tools list on request', () => {
    const parsed = LlmCallRequestSchema.parse({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'bash',
          description: 'run shell',
          inputSchema: { type: 'object' },
          executesIn: 'sandbox',
        },
      ],
      model: 'claude-opus',
      maxTokens: 1000,
      temperature: 0.5,
    });
    expect(parsed.tools?.[0]?.executesIn).toBe('sandbox');
  });
});

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

describe('session.next-message response', () => {
  it('round-trips a user-message variant', () => {
    const parsed = SessionNextMessageResponseSchema.parse({
      type: 'user-message',
      payload: { role: 'user', content: 'hello' },
      cursor: 3,
    });
    expect(parsed.type).toBe('user-message');
    if (parsed.type === 'user-message') {
      expect(parsed.payload.content).toBe('hello');
      expect(parsed.cursor).toBe(3);
    }
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

  it('IPC_TIMEOUTS_MS has the six expected keys', () => {
    const expected = [
      'llm.call',
      'tool.pre-call',
      'tool.execute-host',
      'tool.list',
      'workspace.commit-notify',
      'session.next-message',
    ].sort();
    expect(Object.keys(IPC_TIMEOUTS_MS).sort()).toEqual(expected);
  });

  it('IpcActionName type is assignable from each key', () => {
    // Type-level check: compile error if the keys do not match.
    const names: IpcActionName[] = [
      'llm.call',
      'tool.pre-call',
      'tool.execute-host',
      'tool.list',
      'workspace.commit-notify',
      'session.next-message',
    ];
    expect(names).toHaveLength(6);
  });
});

describe('shared schemas exported', () => {
  it('ChatMessageSchema rejects unknown role', () => {
    const r = ChatMessageSchema.safeParse({ role: 'alien', content: 'hi' });
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
});
