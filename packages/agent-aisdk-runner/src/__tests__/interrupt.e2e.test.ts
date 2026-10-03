import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IpcClient, IpcClientOptions } from '@ax/ipc-protocol';
import type { InboxLoopEntry } from '@ax/agent-runner-core';

// ---------------------------------------------------------------------------
// TASK-688 — Stop, on the aisdk runner.
//
// The original bug, measured by the §8 walk: click Stop, the UI goes idle, and
// the turn's `touch /agent/cancel-probe.txt` (behind a `sleep 45`) STILL
// happens. This suite drives the REAL `runRunner` shell and the REAL loop,
// including the real Bash tool, against a scripted model, and holds the inbox
// open so an `interrupt` can land mid-turn — the thing the old runner never
// read until the turn was over.
//
// Same seams as parity.e2e.test.ts (git/venv/IPC/provider mocked, everything
// else real). The one difference is the inbox: parity's answers instantly and
// then says `cancel`, which can never model "the person presses Stop while a
// reply is streaming". This one blocks until the test pushes an entry.
// ---------------------------------------------------------------------------

type FakeClient = {
  call: Mock;
  callGet: Mock;
  callBinary: Mock;
  callBinaryUpload: Mock;
  event: Mock;
  close: Mock;
} & IpcClient;

let fakeClient: FakeClient;
let events: Array<{ name: string; payload: Record<string, unknown> }>;
let calls: Array<{ action: string; payload: unknown }>;
let shippedTranscript: Buffer[];
let toolCatalog: unknown[];
/** How long `tool.execute-host` takes to answer — a host tool cannot be aborted. */
let hostToolMs = 0;

// ---- a blocking inbox -------------------------------------------------------
const inbox = {
  queue: [] as InboxLoopEntry[],
  waiter: null as null | ((e: InboxLoopEntry) => void),
  push(entry: InboxLoopEntry): void {
    if (this.waiter !== null) {
      const w = this.waiter;
      this.waiter = null;
      w(entry);
    } else {
      this.queue.push(entry);
    }
  },
  next(): Promise<InboxLoopEntry> {
    const head = this.queue.shift();
    if (head !== undefined) return Promise.resolve(head);
    return new Promise<InboxLoopEntry>((resolve) => {
      this.waiter = resolve;
    });
  },
};

vi.mock('@ax/ipc-protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ax/ipc-protocol')>();
  return {
    ...actual,
    createIpcClient: (_opts: IpcClientOptions): IpcClient => fakeClient,
  };
});

vi.mock('@ax/agent-runner-core/internal/git-workspace.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@ax/agent-runner-core/internal/git-workspace.js')>();
  return {
    ...actual,
    materializeWorkspace: vi.fn().mockResolvedValue({ baselineCommit: 'oid-0' }),
    scaffoldWorkspaceGitignore: vi.fn().mockResolvedValue(undefined),
    commitTurnAndBundle: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('@ax/agent-runner-core/internal/python-venv.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@ax/agent-runner-core/internal/python-venv.js')>();
  return { ...actual, scaffoldPythonVenv: vi.fn().mockResolvedValue(false) };
});

vi.mock('@ax/agent-runner-core/internal/inbox-loop.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@ax/agent-runner-core/internal/inbox-loop.js')>();
  return {
    ...actual,
    createInboxLoop: () => ({ cursor: 0, next: () => inbox.next() }),
  };
});

const scriptedModel = vi.fn();
vi.mock('../provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../provider.js')>()),
  resolveModel: () => scriptedModel(),
  createProxyFetch: () => undefined,
}));

const { main } = await import('../main.js');
const { MockLanguageModelV4 } = await import('ai/test');
const { decodeTranscript } = await import('../transcript-codec.js');

type Chunk = Record<string, unknown>;

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const head = (): Chunk[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r', modelId: 'm', timestamp: new Date(0) },
];
const textStep = (text: string): Chunk[] => [
  ...head(),
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
];
const toolStep = (toolName: string, input: Record<string, unknown>, id = 'c1'): Chunk[] => [
  ...head(),
  { type: 'tool-input-start', id, toolName },
  { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
];

/** Every prompt the model was handed, so a test can assert what it saw. */
let sentPrompts: unknown[];

/**
 * A model that streams `firstChunks` and then HANGS, like a provider mid-reply,
 * until the request is aborted — at which point the stream errors with an
 * AbortError, exactly as a real fetch does. Later calls replay `later`.
 */
function modelThatHangsThen(firstChunks: Chunk[], later: Chunk[][] = []): unknown {
  let call = 0;
  const rest = [...later];
  return new MockLanguageModelV4({
    doStream: async ({ prompt, abortSignal }) => {
      sentPrompts.push(prompt);
      call += 1;
      if (call > 1) {
        const chunks = rest.shift();
        if (chunks === undefined) throw new Error('model script exhausted');
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const c of chunks) controller.enqueue(c as never);
              controller.close();
            },
          }),
        };
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const c of firstChunks) controller.enqueue(c as never);
            abortSignal?.addEventListener('abort', () => {
              controller.error(
                abortSignal.reason ?? new DOMException('This operation was aborted', 'AbortError'),
              );
            });
          },
        }),
      };
    },
  });
}

/** Replays `steps` in order, one per provider call; a later call past the end throws. */
function modelReplaying(steps: Chunk[][]): unknown {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      sentPrompts.push(prompt);
      const chunks = steps[i++];
      if (chunks === undefined) throw new Error('model script exhausted');
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(c as never);
            controller.close();
          },
        }),
      };
    },
  });
}

let tmp: string;
let workspaceRoot: string;
let configDir: string;
const ORIGINAL_ENV = process.env;

const userMessage = (content: string, reqId = 'req-1'): InboxLoopEntry =>
  ({ type: 'user-message', reqId, payload: { content, contentBlocks: [] } }) as InboxLoopEntry;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-aisdk-interrupt-'));
  workspaceRoot = path.join(tmp, 'agent');
  configDir = path.join(tmp, 'config');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });

  events = [];
  calls = [];
  shippedTranscript = [];
  toolCatalog = [];
  hostToolMs = 0;
  sentPrompts = [];
  inbox.queue = [];
  inbox.waiter = null;

  process.env = {
    ...ORIGINAL_ENV,
    AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
    AX_SESSION_ID: 'sess-1',
    AX_AUTH_TOKEN: 'tok-123',
    AX_WORKSPACE_ROOT: workspaceRoot,
    AX_PROXY_ENDPOINT: 'http://127.0.0.1:8443',
    AX_PROXY_TOKEN: 'feedfacefeedfacefeedfacefeedface',
    ANTHROPIC_API_KEY: 'ax-cred:0123456789abcdef0123456789abcdef',
    CLAUDE_CONFIG_DIR: configDir,
    AX_VENV_READY_WAIT_MS: '0',
  };
  delete process.env.AX_INSTALLED_SKILLS_JSON;
  delete process.env.AX_USERFILES_ROOT;
  delete process.env.AX_EPHEMERAL_ROOT;

  fakeClient = {
    call: vi.fn(async (action: string, payload: unknown) => {
      calls.push({ action, payload });
      switch (action) {
        case 'session.get-config':
          return {
            userId: 'u-1',
            agentId: 'a-1',
            agentConfig: {
              displayName: 'Interrupt Agent',
              systemPromptAugment: '',
              allowedTools: [],
              mcpConfigIds: [],
              model: 'anthropic/claude-sonnet-4-6',
              runner: 'aisdk',
            },
            conversationId: 'conv-1',
            runnerSessionId: null,
          };
        case 'tool.list':
          return { tools: toolCatalog };
        case 'attachments.list':
          return { files: [] };
        case 'tool.pre-call':
          return { verdict: 'allow' };
        case 'tool.execute-host':
          await new Promise((r) => setTimeout(r, hostToolMs));
          return { output: 'host tool output' };
        case 'proxy.drain-egress-blocks':
          return { hosts: [] };
        case 'conversation.store-runner-session':
          return {};
        default:
          throw new Error(`unexpected call: ${action}`);
      }
    }),
    callGet: vi.fn(),
    callBinary: vi.fn(async () => {
      const p = path.join(tmp, 'bundle.bin');
      await fs.writeFile(p, '');
      return { path: p, bytes: 0 };
    }),
    callBinaryUpload: vi.fn(async (action: string, body: Buffer) => {
      calls.push({ action, payload: undefined });
      if (action === 'session.replace-transcript') {
        shippedTranscript = [Buffer.from(body)];
        return { maxSeq: 1 };
      }
      shippedTranscript.push(Buffer.from(body));
      return { outcome: 'appended', maxSeq: 1 };
    }),
    event: vi.fn(async (name: string, payload: Record<string, unknown>) => {
      events.push({ name, payload });
    }),
    close: vi.fn(async () => undefined),
  } as unknown as FakeClient;
});

afterEach(async () => {
  process.env = ORIGINAL_ENV;
  vi.clearAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

const turnEnds = (): Array<Record<string, unknown>> =>
  events.filter((e) => e.name === 'event.turn-end').map((e) => e.payload);
const assistantEnds = (): Array<Record<string, unknown>> =>
  turnEnds().filter((t) => t.role === 'assistant');
const chunks = (): Array<Record<string, unknown>> =>
  events.filter((e) => e.name === 'event.stream-chunk').map((e) => e.payload);
const chatEnd = (): Record<string, unknown> | undefined =>
  events.find((e) => e.name === 'event.chat-end')?.payload;
const shippedEntries = (): Array<{ role: string; message: unknown }> => {
  if (shippedTranscript.length === 0) return [];
  const decoded = decodeTranscript(Buffer.concat(shippedTranscript));
  if (!decoded.ok) throw new Error(`shipped transcript did not decode: ${decoded.reason}`);
  return decoded.entries.map((e) => ({ role: e.role, message: e.message }));
};

/** Poll until `cond` holds — the runner is a real async pipeline; no fixed sleeps. */
async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Every tool-call id in a prompt has a tool-result somewhere after it, and vice versa. */
function danglingToolCalls(prompt: unknown): string[] {
  const messages = prompt as Array<{ role: string; content: unknown }>;
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as Array<{ type: string; toolCallId?: string }>) {
      if (part.type === 'tool-call' && part.toolCallId !== undefined) called.add(part.toolCallId);
      if (part.type === 'tool-result' && part.toolCallId !== undefined)
        answered.add(part.toolCallId);
    }
  }
  return [...called].filter((id) => !answered.has(id));
}

describe('aisdk runner — Stop (TASK-688)', () => {
  it('stops a reply that is streaming, keeps what was written, and stays ready for the next message', async () => {
    scriptedModel.mockReturnValue(
      modelThatHangsThen(
        [
          ...head(),
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Once upon a ' },
        ],
        [textStep('Sure, something shorter.')],
      ),
    );
    const done = main();
    inbox.push(userMessage('write me a long story'));

    await until(
      () => chunks().some((c) => c.kind === 'text' && c.text === 'Once upon a '),
      'the first words to stream',
    );
    inbox.push({ type: 'interrupt' } as InboxLoopEntry);

    // The turn ENDS: a turn-end for the stopped reply reaches the host (that is
    // what closes the person's stream), carrying what they had already seen.
    await until(() => assistantEnds().length === 1, 'the stopped turn to end');
    expect(assistantEnds()[0]!.contentBlocks).toEqual([
      { type: 'text', text: 'Once upon a ' },
    ]);
    expect(assistantEnds()[0]!.reqId).toBe('req-1');

    // ... and the runner is still there. The next message is a normal turn.
    inbox.push(userMessage('shorter please', 'req-2'));
    await until(() => assistantEnds().length === 2, 'the next turn to run');
    expect(assistantEnds()[1]!.contentBlocks).toEqual([
      { type: 'text', text: 'Sure, something shorter.' },
    ]);
    expect(assistantEnds()[1]!.reqId).toBe('req-2');

    inbox.push({ type: 'cancel' } as InboxLoopEntry);
    await expect(done).resolves.toBe(0);
    expect(chatEnd()).toEqual({ outcome: { kind: 'complete', messages: expect.any(Array) } });

    // The transcript stays coherent: the model is told what it had said before
    // it was stopped, and the new message follows it.
    expect(shippedEntries().map((e) => e.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    const secondPrompt = JSON.stringify(sentPrompts[1]);
    expect(secondPrompt).toContain('Once upon a ');
    expect(secondPrompt).toContain('shorter please');
  });

  it('kills the tool that is running: the marker file the card measured must NOT appear', async () => {
    // The card's own probe: `touch <marker>` behind a sleep, Stop ~6 s in, the
    // file appeared 45 s later. Same shape, scaled down so the suite is quick.
    const marker = path.join(tmp, 'cancel-probe.txt');
    scriptedModel.mockReturnValue(
      modelReplaying([
        toolStep('Bash', { command: `sleep 1.5 && touch ${marker}` }),
        textStep('unreachable: the tool loop must not ask the model for a second step'),
      ]),
    );
    const done = main();
    inbox.push(userMessage('run the slow thing'));

    await until(() => chunks().some((c) => c.kind === 'tool-use'), 'the tool to start');
    // Give the child a moment to actually be running (the tool-use chunk is
    // emitted when the model's call is parsed, just before the tool starts).
    await new Promise((r) => setTimeout(r, 200));
    inbox.push({ type: 'interrupt' } as InboxLoopEntry);

    await until(() => assistantEnds().length === 1, 'the stopped turn to end');
    inbox.push({ type: 'cancel' } as InboxLoopEntry);
    await expect(done).resolves.toBe(0);

    // Long enough for the sleep to have finished had anything survived.
    await new Promise((r) => setTimeout(r, 2200));
    await expect(fs.stat(marker)).rejects.toThrow(/ENOENT/);

    // The model was never asked to continue past the abandoned tool call.
    expect(sentPrompts).toHaveLength(1);
  }, 15000);

  it('leaves no dangling tool call in the transcript the next turn is built from', async () => {
    const marker = path.join(tmp, 'never.txt');
    scriptedModel.mockReturnValue(
      modelReplaying([
        toolStep('Bash', { command: `sleep 1.5 && touch ${marker}` }),
        textStep('fine, starting over'),
      ]),
    );
    const done = main();
    inbox.push(userMessage('run the slow thing'));
    await until(() => chunks().some((c) => c.kind === 'tool-use'), 'the tool to start');
    await new Promise((r) => setTimeout(r, 200));
    inbox.push({ type: 'interrupt' } as InboxLoopEntry);
    await until(() => assistantEnds().length === 1, 'the stopped turn to end');

    inbox.push(userMessage('never mind, just say hi', 'req-2'));
    await until(() => assistantEnds().length === 2, 'the next turn to run');
    inbox.push({ type: 'cancel' } as InboxLoopEntry);
    await expect(done).resolves.toBe(0);

    // A tool_use with no tool_result is a hard 400 from Anthropic. The second
    // model call is the proof that nothing of the kind was left behind.
    expect(sentPrompts).toHaveLength(2);
    expect(danglingToolCalls(sentPrompts[1])).toEqual([]);
    expect(JSON.stringify(sentPrompts[1])).toContain('never mind, just say hi');
  }, 15000);

  it('does not repeat a finished step when it is the NEXT step that gets stopped', async () => {
    // Step one talks and runs a quick tool (and finishes); step two is what the
    // person cuts short. The words of step one are already in the transcript
    // via its finished step — the partial-text salvage must add only what step
    // two had streamed (here: nothing), never step one's again.
    const stepOne: Chunk[] = [
      ...head(),
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Looking. ' },
      { type: 'text-end', id: 't' },
      { type: 'tool-input-start', id: 'c1', toolName: 'Bash' },
      { type: 'tool-input-end', id: 'c1' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'Bash', input: JSON.stringify({ command: 'echo hi' }) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
    ];
    let call = 0;
    scriptedModel.mockReturnValue(
      new MockLanguageModelV4({
        doStream: async ({ prompt, abortSignal }) => {
          sentPrompts.push(prompt);
          call += 1;
          return {
            stream: new ReadableStream({
              start(controller) {
                if (call === 1) {
                  for (const c of stepOne) controller.enqueue(c as never);
                  controller.close();
                  return;
                }
                for (const c of head()) controller.enqueue(c as never);
                abortSignal?.addEventListener('abort', () =>
                  controller.error(new DOMException('aborted', 'AbortError')),
                );
              },
            }),
          };
        },
      }),
    );
    const done = main();
    inbox.push(userMessage('look around'));
    await until(() => sentPrompts.length === 2, 'the second model call to start');
    inbox.push({ type: 'interrupt' } as InboxLoopEntry);
    await until(() => assistantEnds().length === 1, 'the stopped turn to end');
    inbox.push({ type: 'cancel' } as InboxLoopEntry);
    await expect(done).resolves.toBe(0);

    const blocks = assistantEnds()[0]!.contentBlocks as Array<{ type: string; text?: string }>;
    expect(blocks.filter((b) => b.type === 'text')).toEqual([
      { type: 'text', text: 'Looking. ' },
    ]);
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
    // user, assistant(text+tool call), tool(result) — and no stray fourth entry.
    expect(shippedEntries().map((e) => e.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('bills the steps that FINISHED when the next step is the one that gets stopped (TASK-692)', async () => {
    // Step one ran and finished (a paid model call); step two is cut off. The
    // stopped turn reports step one's usage: the person stopped the reply, not
    // the bill. The cut-off step has no usage to read, so it adds nothing.
    const stepOne: Chunk[] = toolStep('Bash', { command: 'echo hi' }).map((c) =>
      c.type === 'finish'
        ? {
            ...c,
            usage: {
              inputTokens: { total: 1000, noCache: 100, cacheRead: 850, cacheWrite: 50 },
              outputTokens: { total: 30, text: 10, reasoning: 20 },
            },
          }
        : c,
    );
    let call = 0;
    scriptedModel.mockReturnValue(
      new MockLanguageModelV4({
        doStream: async ({ prompt, abortSignal }) => {
          sentPrompts.push(prompt);
          call += 1;
          return {
            stream: new ReadableStream({
              start(controller) {
                if (call === 1) {
                  for (const c of stepOne) controller.enqueue(c as never);
                  controller.close();
                  return;
                }
                for (const c of head()) controller.enqueue(c as never);
                abortSignal?.addEventListener('abort', () =>
                  controller.error(new DOMException('aborted', 'AbortError')),
                );
              },
            }),
          };
        },
      }),
    );
    const done = main();
    inbox.push(userMessage('look around'));
    await until(() => sentPrompts.length === 2, 'the second model call to start');
    inbox.push({ type: 'interrupt' } as InboxLoopEntry);
    await until(() => assistantEnds().length === 1, 'the stopped turn to end');
    inbox.push({ type: 'cancel' } as InboxLoopEntry);
    await expect(done).resolves.toBe(0);

    expect(assistantEnds()[0]!.usage).toEqual({
      model: 'anthropic/claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 850,
      cacheWriteTokens: 50,
    });
  });

  it('a Stop pressed before the first word still ends the turn cleanly (nothing to keep)', async () => {
    scriptedModel.mockReturnValue(modelThatHangsThen([...head()], [textStep('hello')]));
    const done = main();
    inbox.push(userMessage('hi'));
    await until(() => sentPrompts.length === 1, 'the model call to start');
    inbox.push({ type: 'interrupt' } as InboxLoopEntry);

    await until(() => turnEnds().length >= 1, 'the stopped turn to end');
    // An empty assistant turn is a heartbeat: no contentBlocks, no invented text.
    expect(assistantEnds()[0]!.contentBlocks).toBeUndefined();
    // No step finished, so there is nothing to bill: `usage` is ABSENT (the host
    // then charges its flat assumption), not a zero-filled "free" turn (TASK-692).
    expect(assistantEnds()[0]).not.toHaveProperty('usage');

    inbox.push(userMessage('hi again', 'req-2'));
    await until(() => assistantEnds().length === 2, 'the next turn to run');
    inbox.push({ type: 'cancel' } as InboxLoopEntry);
    await expect(done).resolves.toBe(0);
    expect(chatEnd()).toEqual({ outcome: { kind: 'complete', messages: expect.any(Array) } });
  });

  it('ends the turn promptly even when the running tool cannot be aborted (a host tool)', async () => {
    toolCatalog = [
      {
        name: 'slow_search',
        description: 'a host tool: cannot be cancelled once dispatched',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        executesIn: 'host',
      },
    ];
    hostToolMs = 4000;
    scriptedModel.mockReturnValue(
      modelReplaying([toolStep('slow_search', { q: 'x' }), textStep('done')]),
    );
    const done = main();
    inbox.push(userMessage('search'));
    await until(() => calls.some((c) => c.action === 'tool.execute-host'), 'the host tool call');
    const stoppedAt = Date.now();
    inbox.push({ type: 'interrupt' } as InboxLoopEntry);

    await until(() => assistantEnds().length === 1, 'the stopped turn to end', 3000);
    // Well inside the 4 s the tool takes: the person is not made to wait for
    // work the runner cannot take back.
    expect(Date.now() - stoppedAt).toBeLessThan(3000);
    inbox.push({ type: 'cancel' } as InboxLoopEntry);
    await expect(done).resolves.toBe(0);
  }, 15000);

  it('an interrupt with nothing running is a harmless no-op', async () => {
    scriptedModel.mockReturnValue(modelReplaying([textStep('all good')]));
    const done = main();
    inbox.push({ type: 'interrupt' } as InboxLoopEntry); // before any message: idle
    inbox.push(userMessage('hello'));
    await until(() => assistantEnds().length === 1, 'the turn to finish');
    expect(assistantEnds()[0]!.contentBlocks).toEqual([{ type: 'text', text: 'all good' }]);
    inbox.push({ type: 'interrupt' } as InboxLoopEntry); // after it: idle again
    inbox.push({ type: 'cancel' } as InboxLoopEntry);
    await expect(done).resolves.toBe(0);
    expect(chatEnd()).toEqual({ outcome: { kind: 'complete', messages: expect.any(Array) } });
  });
});
