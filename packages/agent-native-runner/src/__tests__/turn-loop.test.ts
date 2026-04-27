import { describe, expect, it } from 'vitest';
import {
  createLocalDispatcher,
  SessionInvalidError,
  type InboxLoop,
  type InboxLoopEntry,
  type IpcClient,
  type LocalDispatcher,
} from '@ax/agent-runner-core';
import type {
  ChatMessage,
  LlmCallResponse,
  ToolCall,
  ToolDescriptor,
  ToolPreCallResponse,
} from '@ax/ipc-protocol';
import { runTurnLoop, type TurnLoopOutcome } from '../turn-loop.js';

// ---------------------------------------------------------------------------
// A tiny fake IpcClient: canned responses per action name, served in FIFO
// order. Asserts against `calls` + `events` give us full visibility into
// what the runner sent on the wire.
// ---------------------------------------------------------------------------

interface CallRecord {
  action: string;
  payload: unknown;
}
interface EventRecord {
  name: string;
  payload: unknown;
}

interface CallQueue {
  [action: string]: Array<unknown | (() => unknown)>;
}

function makeFakeClient(canned: CallQueue): {
  client: IpcClient;
  calls: CallRecord[];
  events: EventRecord[];
} {
  const calls: CallRecord[] = [];
  const events: EventRecord[] = [];
  const queues: Record<string, Array<unknown | (() => unknown)>> = {};
  for (const [k, v] of Object.entries(canned)) {
    queues[k] = [...v];
  }

  const client: IpcClient = {
    async call(action, payload) {
      calls.push({ action, payload });
      const queue = queues[action];
      if (queue === undefined || queue.length === 0) {
        throw new Error(`fake client: no canned response for ${action}`);
      }
      const next = queue.shift()!;
      if (typeof next === 'function') {
        // A thunk lets tests inject thrown errors per call.
        return (next as () => unknown)();
      }
      return next;
    },
    async callGet() {
      throw new Error('fake client: callGet not used in turn-loop tests');
    },
    async event(name, payload) {
      events.push({ name, payload });
    },
    async close() {},
  };
  return { client, calls, events };
}

// A minimal fake InboxLoop that yields scripted entries.
function makeFakeInbox(entries: InboxLoopEntry[]): InboxLoop {
  const queue = [...entries];
  let cursor = 0;
  return {
    async next() {
      if (queue.length === 0) {
        throw new Error('fake inbox: exhausted');
      }
      cursor += 1;
      return queue.shift()!;
    },
    get cursor() {
      return cursor;
    },
  };
}

const userMsg = (content: string): InboxLoopEntry => ({
  type: 'user-message',
  payload: { role: 'user', content },
  reqId: 'r-test',
});

const cancel: InboxLoopEntry = { type: 'cancel' };

const tools: ToolDescriptor[] = [
  {
    name: 'bash',
    inputSchema: {},
    executesIn: 'sandbox',
  },
];

// Canonical LLM response helpers.
function llmNoTools(content: string): LlmCallResponse {
  return {
    assistantMessage: { role: 'assistant', content },
    toolCalls: [],
  };
}
function llmWithTool(content: string, name: string, input: unknown): LlmCallResponse {
  const call: ToolCall = { id: 'call-1', name, input };
  return {
    assistantMessage: { role: 'assistant', content },
    toolCalls: [call],
  };
}
function preAllow(): ToolPreCallResponse {
  return { verdict: 'allow' };
}

describe('runTurnLoop', () => {
  it('no tool calls: returns complete with [user, assistant] after cancel', async () => {
    const { client } = makeFakeClient({
      'llm.call': [llmNoTools('hello back')],
    });
    const inbox = makeFakeInbox([userMsg('hi'), cancel]);
    const dispatcher = createLocalDispatcher();

    const outcome = await runTurnLoop({ client, inbox, dispatcher, tools });

    expect(outcome).toEqual({
      kind: 'complete',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello back' },
      ],
    } satisfies TurnLoopOutcome);
  });

  it('one tool call dispatched locally: executes via dispatcher, emits tool-post-call', async () => {
    const bashOutput = { stdout: 'hi', exitCode: 0 };
    const dispatcher: LocalDispatcher = createLocalDispatcher();
    dispatcher.register('bash', async () => bashOutput);

    const { client, events } = makeFakeClient({
      'llm.call': [
        llmWithTool('running bash', 'bash', { command: 'echo hi' }),
        llmNoTools('done'),
      ],
      'tool.pre-call': [preAllow()],
    });
    const inbox = makeFakeInbox([userMsg('do it'), cancel]);

    const outcome = await runTurnLoop({ client, inbox, dispatcher, tools });

    if (outcome.kind !== 'complete') throw new Error('expected complete');
    // History: user, assistant(t1), tool-result, assistant(t2)
    expect(outcome.messages).toHaveLength(4);
    const toolResult = outcome.messages[2] as ChatMessage;
    expect(toolResult.role).toBe('user');
    expect(toolResult.content).toBe(`[tool bash] ${JSON.stringify(bashOutput)}`);

    // event.tool-post-call fired with the effective call + output.
    const postEvent = events.find((e) => e.name === 'event.tool-post-call');
    expect(postEvent).toBeDefined();
    expect(postEvent?.payload).toEqual({
      call: { id: 'call-1', name: 'bash', input: { command: 'echo hi' } },
      output: bashOutput,
    });

    // event.turn-end fired once after the user-message processed.
    const turnEnd = events.filter((e) => e.name === 'event.turn-end');
    expect(turnEnd).toHaveLength(1);
  });

  it('one tool call with no local impl: routes through tool.execute-host', async () => {
    const dispatcher = createLocalDispatcher();
    // No 'web_fetch' registered → should punt to host.
    const { client, calls } = makeFakeClient({
      'llm.call': [
        llmWithTool('fetching', 'web_fetch', { url: 'http://x' }),
        llmNoTools('ok'),
      ],
      'tool.pre-call': [preAllow()],
      'tool.execute-host': [{ output: 'html' }],
    });
    const inbox = makeFakeInbox([userMsg('fetch'), cancel]);

    const outcome = await runTurnLoop({ client, inbox, dispatcher, tools });

    if (outcome.kind !== 'complete') throw new Error('expected complete');
    const toolResult = outcome.messages[2] as ChatMessage;
    expect(toolResult.content).toBe('[tool web_fetch] "html"');

    // Confirm tool.execute-host was actually called.
    expect(calls.some((c) => c.action === 'tool.execute-host')).toBe(true);
  });

  it('tool.pre-call rejects: emits synthetic user message, next turn proceeds', async () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register('bash', async () => ({ stdout: 'never-runs' }));

    const { client } = makeFakeClient({
      'llm.call': [
        llmWithTool('want to run', 'bash', { command: 'rm -rf /' }),
        llmNoTools('okay, giving up'),
      ],
      'tool.pre-call': [{ verdict: 'reject', reason: 'policy' }],
    });
    const inbox = makeFakeInbox([userMsg('go'), cancel]);

    const outcome = await runTurnLoop({ client, inbox, dispatcher, tools });

    if (outcome.kind !== 'complete') throw new Error('expected complete');
    const rejectMsg = outcome.messages[2] as ChatMessage;
    expect(rejectMsg.role).toBe('user');
    expect(rejectMsg.content).toBe("tool 'bash' rejected: policy");
    // Last message is from the second LLM turn.
    expect(outcome.messages[3]).toEqual({
      role: 'assistant',
      content: 'okay, giving up',
    });
  });

  it('tool.pre-call modifies: dispatcher executes the MODIFIED call', async () => {
    const seen: ToolCall[] = [];
    const dispatcher = createLocalDispatcher();
    dispatcher.register('bash', async (call) => {
      seen.push(call);
      return { stdout: 'safe-ran' };
    });

    const modified: ToolCall = {
      id: 'call-1',
      name: 'bash',
      input: { command: 'echo safer' },
    };

    const { client, events } = makeFakeClient({
      'llm.call': [
        llmWithTool('risky', 'bash', { command: 'rm -rf /' }),
        llmNoTools('done'),
      ],
      'tool.pre-call': [{ verdict: 'allow', modifiedCall: modified }],
    });
    const inbox = makeFakeInbox([userMsg('go'), cancel]);

    const outcome = await runTurnLoop({ client, inbox, dispatcher, tools });

    expect(outcome.kind).toBe('complete');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(modified);

    // The post-event should carry the modified call, not the original.
    const postEvent = events.find((e) => e.name === 'event.tool-post-call');
    expect(postEvent?.payload).toEqual({
      call: modified,
      output: { stdout: 'safe-ran' },
    });
  });

  it('tool executor throws: pushes error message, next turn proceeds', async () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register('bash', async () => {
      throw new Error('bash blew up');
    });

    const { client } = makeFakeClient({
      'llm.call': [
        llmWithTool('try bash', 'bash', { command: 'x' }),
        llmNoTools('oh well'),
      ],
      'tool.pre-call': [preAllow()],
    });
    const inbox = makeFakeInbox([userMsg('go'), cancel]);

    const outcome = await runTurnLoop({ client, inbox, dispatcher, tools });

    if (outcome.kind !== 'complete') throw new Error('expected complete');
    const errMsg = outcome.messages[2] as ChatMessage;
    expect(errMsg.role).toBe('user');
    // LocalDispatcher wraps with "local dispatcher: tool 'bash' failed: ..."
    expect(errMsg.content).toMatch(/^\[tool bash\] error:/);
    expect(errMsg.content).toContain('bash blew up');

    expect(outcome.messages[3]).toEqual({
      role: 'assistant',
      content: 'oh well',
    });
  });

  it('maxTurns guard: bails after N LLM calls without terminating the session', async () => {
    // Model keeps emitting tool calls every turn — canned queue with >3 entries.
    const dispatcher = createLocalDispatcher();
    dispatcher.register('bash', async () => ({ stdout: 'step' }));

    const loopingLlm: LlmCallResponse[] = [
      llmWithTool('t1', 'bash', { command: 'a' }),
      llmWithTool('t2', 'bash', { command: 'b' }),
      llmWithTool('t3', 'bash', { command: 'c' }),
      llmWithTool('t4-unreached', 'bash', { command: 'd' }),
    ];
    const { client, calls } = makeFakeClient({
      'llm.call': loopingLlm,
      'tool.pre-call': [preAllow(), preAllow(), preAllow(), preAllow()],
    });
    const inbox = makeFakeInbox([userMsg('spin'), cancel]);

    const outcome = await runTurnLoop({
      client,
      inbox,
      dispatcher,
      tools,
      maxTurns: 3,
    });

    // Outer loop exited cleanly on cancel.
    expect(outcome.kind).toBe('complete');

    // Exactly 3 llm.call invocations — no more, no fewer.
    const llmCalls = calls.filter((c) => c.action === 'llm.call');
    expect(llmCalls).toHaveLength(3);
  });

  // ---------------------------------------------------------------------
  // Week 9.5 — systemPrompt seeding (the runner gets it from
  // session.get-config and forwards it via deps.systemPrompt).
  // ---------------------------------------------------------------------

  it('systemPrompt is prepended to llm.call messages but excluded from outcome', async () => {
    const { client, calls } = makeFakeClient({
      'llm.call': [llmNoTools('hi back')],
    });
    const inbox = makeFakeInbox([userMsg('greet me'), cancel]);
    const dispatcher = createLocalDispatcher();

    const outcome = await runTurnLoop({
      client,
      inbox,
      dispatcher,
      tools,
      systemPrompt: 'You are a poet.',
    });

    // The first llm.call sees the system prompt at the top of messages —
    // llm-anthropic extracts role:'system' into the API's `system` field.
    const llmCall = calls.find((c) => c.action === 'llm.call');
    expect(llmCall).toBeDefined();
    const messages = (llmCall!.payload as { messages: ChatMessage[] }).messages;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a poet.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'greet me' });
    // The user-facing outcome filters out the system message: callers
    // want a transcript, not the prompt the host wrote.
    if (outcome.kind !== 'complete') throw new Error('expected complete');
    expect(outcome.messages).toEqual([
      { role: 'user', content: 'greet me' },
      { role: 'assistant', content: 'hi back' },
    ]);
  });

  it('empty systemPrompt is not seeded as a message', async () => {
    const { client, calls } = makeFakeClient({
      'llm.call': [llmNoTools('hello')],
    });
    const inbox = makeFakeInbox([userMsg('hi'), cancel]);
    const dispatcher = createLocalDispatcher();

    await runTurnLoop({
      client,
      inbox,
      dispatcher,
      tools,
      systemPrompt: '',
    });

    const llmCall = calls.find((c) => c.action === 'llm.call');
    const messages = (llmCall!.payload as { messages: ChatMessage[] }).messages;
    // Only the user message — no role:'system' entry.
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('SessionInvalidError from llm.call: outcome is terminated with history so far', async () => {
    const dispatcher = createLocalDispatcher();
    const { client } = makeFakeClient({
      'llm.call': [
        () => {
          throw new SessionInvalidError('token revoked');
        },
      ],
    });
    const inbox = makeFakeInbox([userMsg('start'), cancel]);

    const outcome = await runTurnLoop({ client, inbox, dispatcher, tools });

    expect(outcome.kind).toBe('terminated');
    if (outcome.kind !== 'terminated') throw new Error('unreachable');
    expect(outcome.reason).toBe('SessionInvalidError');
    // History has the user message we ingested before the LLM call failed.
    expect(outcome.messages).toEqual([{ role: 'user', content: 'start' }]);
    expect(outcome.error).toBeInstanceOf(SessionInvalidError);
  });
});
