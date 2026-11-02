import { afterAll, afterEach, describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import {
  AttachmentsListResponseSchema,
  IpcRequestError,
  type IpcClient,
  type IpcClientOptions,
} from '@ax/ipc-protocol';
import type { RunnerEnv } from '../env.js';
import type { EndTurnInput, Loop, LoopContext, RunnerDeps, RunnerSeams, TranscriptSource } from '../index.js';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Unit test for the runner shell's exit-code contract:
//   0 — the loop ran and returned normally.
//   1 — the loop threw (abnormal termination).
//   2 — fatal during bootstrap, and NO event.chat-end is fired (the
//       orchestrator's handle.exited watcher synthesizes the terminated
//       outcome, so chat:end still fires exactly once per agent:invoke).
//
// Everything the boot sequence touches on the way to the loop (the proxy
// bridge, the skills projection, the prompt engine, the IPC socket) is mocked
// out — those modules have their own suites; this one is about the shell. The
// agent's home and the scratch root are real temp directories.
// ---------------------------------------------------------------------------

type FakeClient = { call: Mock; callBinary: Mock; event: Mock; close: Mock } & IpcClient;

let fakeClient: FakeClient;
let createIpcClientMock: Mock;

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

vi.mock('../proxy-ca-from-env.js', () => ({
  writeProxyCaFromEnv: vi.fn().mockResolvedValue('skipped'),
}));
vi.mock('../proxy-startup.js', () => ({
  setupProxy: vi.fn().mockResolvedValue({ providerEnv: {} }),
}));
vi.mock('../installed-skills.js', () => ({
  materializeInstalledSkillsFromEnv: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../prompt-engine.js', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('system prompt'),
}));
vi.mock('../inbox-loop.js', () => ({
  createInboxLoop: vi.fn(() => ({ next: vi.fn(), cursor: 0 })),
}));

const { runRunner } = await import('../run-runner.js');
const { createInboxLoop } = await import('../inbox-loop.js');

/** Drive the shell's message pump with a scripted inbox. */
function scriptInbox(entries: unknown[]): void {
  const queue = [...entries];
  (createInboxLoop as unknown as Mock).mockReturnValueOnce({
    next: vi.fn(async () => queue.shift() ?? { type: 'cancel' }),
    cursor: 0,
  });
}

// TASK-994: runRunner refuses to start unless CLAUDE_CONFIG_DIR names an
// existing directory outside the agent's home — the sandbox always provides
// one. A real runner-private temp dir stands in for it. TASK-995: the agent's
// home (`/files`) and the scratch root (`/tmp`) are required too, so the
// sandbox layout is three sibling temp dirs.
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-run-runner-'));
const CONFIG_DIR = path.join(SANDBOX, 'home-runner', '.ax', 'session');
const HOME = path.join(SANDBOX, 'files');
const SCRATCH = path.join(SANDBOX, 'tmp');
await fs.mkdir(CONFIG_DIR, { recursive: true });
await fs.mkdir(HOME, { recursive: true });
// The scratch root also gets the session venv. Mark it present so the shell
// does not start a `uv venv` child that outlives the test.
await fs.mkdir(path.join(SCRATCH, 'py'), { recursive: true });
await fs.writeFile(path.join(SCRATCH, 'py', 'pyvenv.cfg'), '');
afterAll(async () => {
  await fs.rm(SANDBOX, { recursive: true, force: true });
});

/** The minimal shape readRunnerEnv produces (see env.ts). */
function fakeEnv(): RunnerEnv {
  return {
    runnerEndpoint: 'unix:///tmp/ax.sock',
    sessionId: 'sess-1',
    authToken: 'tok-123',
    userFilesRoot: HOME,
    ephemeralRoot: SCRATCH,
    claudeConfigDir: CONFIG_DIR,
    proxyEndpoint: 'http://127.0.0.1:8443',
  };
}

const transcriptSource: TranscriptSource = {
  read: vi.fn().mockResolvedValue(null),
  write: vi.fn().mockResolvedValue('accepted'),
};

describe('runRunner — bounded final history and visible event refusals', () => {
  it('keeps the final history inside the wire cap while retaining the newest message', async () => {
    const loop: Loop = { run: async ctx => {
      for (let i = 0; i < 6; i++) ctx.recordAssistantText('\\'.repeat(800_000));
      ctx.recordAssistantText('the newest answer');
      return 0;
    } };
    expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    const payload = fakeClient.event.mock.calls.find(c => c[0] === 'event.chat-end')![1];
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(4 * 1024 * 1024);
    expect(payload.outcome.messages.at(-1)).toEqual({ role: 'assistant', content: 'the newest answer' });
  });

  it.each([400, 413])('logs refused turn/chat-end status %i without its response body', async status => {
    fakeClient.event.mockRejectedValue(new IpcRequestError('VALIDATION', status, 'PRIVATE_RESPONSE_BODY'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const loop: Loop = { run: async ctx => {
      await ctx.endTurn({ contentBlocks: [{ type: 'text', text: 'PRIVATE_MODEL_TEXT' }], toolResultBlocks: [{ type: 'text', text: 'PRIVATE_TOOL_TEXT' }], usage: null, readTurnId: async () => undefined });
      return 0;
    } };
    try {
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      const logs = stderr.mock.calls.map(c => String(c[0]));
      const refusals = logs.filter(l => l.includes('ipc_event_refused'));
      expect(refusals).toHaveLength(3);
      expect(refusals.every(l => l.includes(`"status":${status}`))).toBe(true);
      expect(refusals.join('')).toContain('event.turn-end');
      expect(refusals.join('')).toContain('event.chat-end');
      expect(refusals.join('')).not.toContain('PRIVATE_');
    } finally { stderr.mockRestore(); }
  });
});

function seams(readEnv: () => RunnerEnv): RunnerSeams {
  return {
    readEnv,
    createTranscriptSource: () => transcriptSource,
    hasLocalTranscript: async () => false,
  };
}

beforeEach(() => {
  createIpcClientMock = vi.fn();
  fakeClient = {
    call: vi.fn().mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-1',
          agentId: 'a-1',
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
      // A conversation-bound boot copies the conversation's uploads.
      if (action === 'attachments.list') return { files: [] };
      throw new Error(`unexpected call: ${action}`);
    }),
    callGet: vi.fn(),
    callBinary: vi.fn(async (action: string) => {
      throw new Error(`unexpected binary call: ${action}`);
    }),
    event: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as FakeClient;
});

/** The auto-attach notes a tool turn-end can carry (generated-files.ts). */
const NOT_ATTACHED = { type: 'text', text: 'Some new files could not be attached. Ask the agent to attach them again.' };
const HELD = { type: 'text', text: 'Some new files need your approval before we attach them. You can also find them in the Files tab.' };

describe('runRunner — generated file attachment', () => {
  // New files in the agent's home are attached to the turn that made them, by
  // reference (TASK-1012): the chip names the file by its key in the agent's
  // files, and nothing is copied into the blob store, so the file is charged
  // once. The home is the only tracked root since TASK-995 made it required: a
  // session can no longer come up without one and fall back to scratch
  // `artifacts/`.
  it.each(['allow', 'reject', 'hold', 'unavailable'] as const)('uses the policy gate (%s) and attaches a reference, never a blob copy', async (verdict) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-files-shell-'));
    const original = fakeClient.call.getMockImplementation()!;
    fakeClient.call.mockImplementation(async (action: string, ...args: unknown[]) => {
      if (action === 'session.get-config') return { ...await original(action, ...args), conversationId: 'c1' };
      if (action === 'tool.list') return { tools: [{ name: 'artifact_publish', executesIn: 'sandbox', inputSchema: {} }] };
      if (action === 'tool.pre-call') {
        // `unavailable`: the gate never answers, so it fails closed.
        if (verdict === 'unavailable') throw new Error('host gone');
        return verdict === 'allow' ? { verdict: 'allow' }
          : verdict === 'reject' ? { verdict: 'reject', reason: 'blocked' }
            : { verdict: 'hold', decisionId: 'd1', note: 'approval required' };
      }
      return original(action, ...args);
    });
    const upload = vi.fn(async () => ({ sha256: 'a'.repeat(64), size: 6 }));
    fakeClient.callBinaryUpload = upload;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const loop: Loop = { run: async ctx => {
      await fs.writeFile(path.join(root, 'report.txt'), 'report');
      await ctx.endTurn({
        contentBlocks: [{ type: 'text', text: 'Here is your report.' }],
        toolResultBlocks: [], usage: null, readTurnId: async () => undefined,
      });
      return 0;
    } };
    try {
      expect(await runRunner(() => loop, seams(() => ({ ...fakeEnv(), userFilesRoot: root })))).toBe(0);
      // No copy, whatever the verdict: no blob, no artifact row.
      expect(upload).not.toHaveBeenCalled();
      expect(fakeClient.call.mock.calls.some(c => c[0] === 'artifact.publish')).toBe(false);
      // The chip rides the FIRST turn-end, the one that closes SSE.
      const first = fakeClient.event.mock.calls.find(call => call[0] === 'event.turn-end')!;
      expect(first[1].role).toBe('tool');
      const chip = { type: 'agent_file', path: 'report.txt', mediaType: 'text/plain', sizeBytes: 6 };
      const gated = fakeClient.call.mock.calls.filter(c => c[0] === 'tool.pre-call');
      expect(gated).toEqual([['tool.pre-call', {
        call: { id: expect.any(String), name: 'artifact_publish', input: { path: path.join(root, 'report.txt') } },
      }]]);
      const reported = fakeClient.event.mock.calls.filter(c => c[0] === 'event.tool-post-call');
      if (verdict === 'allow') {
        expect(first[1].contentBlocks).toContainEqual(chip);
        // The gated call's outcome is the chip it attached.
        expect(reported).toEqual([['event.tool-post-call', { call: gated[0]![1].call, output: chip }]]);
      } else {
        expect(first[1].contentBlocks.some((block: { type: string }) => block.type === 'agent_file')).toBe(false);
        expect(reported).toEqual([]);
      }
      // The warning carries the reason code, and only on a refusal.
      const logs = stderr.mock.calls.map(c => String(c[0])).join('');
      const reason = { allow: null, reject: 'denied', hold: 'held', unavailable: 'unavailable' }[verdict];
      if (reason === null) expect(logs).not.toContain('could not attach a generated file');
      else expect(logs).toContain(`runner: could not attach a generated file (${reason})\n`);
      // A held file is waiting on the person, so it is never told to try again.
      if (verdict === 'hold') {
        expect(first[1].contentBlocks).toContainEqual(HELD);
        expect(first[1].contentBlocks).not.toContainEqual(NOT_ATTACHED);
      } else if (verdict !== 'allow') {
        expect(first[1].contentBlocks).toContainEqual(NOT_ATTACHED);
        expect(first[1].contentBlocks).not.toContainEqual(HELD);
      }
    } finally { stderr.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });

  // TASK-1017. A held automatic attach is a call the RUNNER made, so the model
  // never saw it and cannot make it "again". When the person answers, the
  // runner sends that same call back to the gate itself, when the delivery is
  // pulled, ahead of the turn it opens, so the model's own turn is not the
  // one to spend the approval through the sandbox executor (which would copy
  // the file into the blob store).
  const APPROVED = 'A person approved attaching new files from earlier in this conversation. ' +
    'That is handled for you: do not publish them yourself unless the user asks you to. You do not need to reply.';
  const DECLINED = 'A person chose not to attach new files from earlier in this conversation, so they were not attached. ' +
    'Do not publish them unless the user asks you to. You do not need to reply.';
  const CHIP = { type: 'agent_file', path: 'report.txt', mediaType: 'text/plain', sizeBytes: 6 };
  const HOLD = { verdict: 'hold', decisionId: 'd1', note: 'approval required' };
  const turn: EndTurnInput = {
    contentBlocks: [{ type: 'text', text: 'Here is your report.' }],
    toolResultBlocks: [], usage: null, readTurnId: async () => undefined,
  };
  const preCallCount = () => fakeClient.call.mock.calls.filter(c => c[0] === 'tool.pre-call').length;

  /** A conversation-bound run with auto-attach on: `tool.pre-call` answers from `verdicts`, in order. */
  async function autoAttachRun(
    verdicts: unknown[], inbox: unknown[], drive: (ctx: LoopContext, home: string) => Promise<void>, exit = 0,
  ) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-files-shell-'));
    const original = fakeClient.call.getMockImplementation()!;
    fakeClient.call.mockImplementation(async (action: string, ...args: unknown[]) => {
      if (action === 'session.get-config') return { ...await original(action, ...args), conversationId: 'c1' };
      if (action === 'tool.list') return { tools: [{ name: 'artifact_publish', executesIn: 'sandbox', inputSchema: {} }] };
      if (action === 'tool.pre-call') {
        const next = verdicts.shift();
        if (next === undefined) throw new Error('tool.pre-call was asked more often than scripted');
        return next;
      }
      return original(action, ...args);
    });
    const upload = vi.fn(async () => ({ sha256: 'a'.repeat(64), size: 6 }));
    fakeClient.callBinaryUpload = upload;
    scriptInbox(inbox);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let logs = '';
    try {
      const loop: Loop = { run: async ctx => { await drive(ctx, home); return 0; } };
      expect(await runRunner(() => loop, seams(() => ({ ...fakeEnv(), userFilesRoot: home })))).toBe(exit);
      logs = stderr.mock.calls.map(c => String(c[0])).join('');
    } finally { stderr.mockRestore(); await fs.rm(home, { recursive: true, force: true }); }
    return {
      logs,
      upload,
      preCalls: fakeClient.call.mock.calls.filter(c => c[0] === 'tool.pre-call').map(c => c[1] as { call: unknown }),
      toolTurnEnds: fakeClient.event.mock.calls
        .filter(c => c[0] === 'event.turn-end' && c[1].role === 'tool')
        .map(c => c[1].contentBlocks as Array<{ type: string }>),
      reported: fakeClient.event.mock.calls.filter(c => c[0] === 'event.tool-post-call').map(c => c[1]),
    };
  }

  /** The held turn writes report.txt; the next pull is `delivery`; then that turn ends. */
  async function heldThenAnswered(verdicts: unknown[], delivery: Record<string, unknown>) {
    let seen: unknown;
    let preCallsAtPull = -1;
    const run = await autoAttachRun(verdicts, [delivery], async (ctx, home) => {
      await fs.writeFile(path.join(home, 'report.txt'), 'report');
      await ctx.endTurn(turn);
      seen = await ctx.nextMessage();
      preCallsAtPull = preCallCount();
      await ctx.endTurn(turn);
      expect(await ctx.nextMessage()).toBeNull();
    });
    return { ...run, seen, preCallsAtPull };
  }

  it('approving a held auto-attach attaches the reference once and creates no blob', async () => {
    const run = await heldThenAnswered([HOLD, { verdict: 'allow' }],
      { type: 'decision-resolved', decisionId: 'd1', outcome: 'approved', note: 'HOST NOTE' });
    // The runner's own note: the host's would ask the model to repeat a call
    // it never made.
    expect(run.seen).toEqual({ content: `System message (not from the user): ${APPROVED}`, id: expect.any(String) });
    expect(JSON.stringify(run.seen)).not.toContain('HOST NOTE');
    // The identical call went back to the gate when the delivery was pulled,
    // before the model's turn began.
    expect(run.preCallsAtPull).toBe(2);
    expect(run.preCalls).toHaveLength(2);
    expect(run.preCalls[1]).toEqual(run.preCalls[0]);
    // Charged once: no blob, no artifact row.
    expect(run.upload).not.toHaveBeenCalled();
    expect(fakeClient.call.mock.calls.some(c => c[0] === 'artifact.publish' || c[0] === 'blob.put')).toBe(false);
    expect(fakeClient.callBinary.mock.calls.some(c => c[0] === 'blob.put')).toBe(false);
    // The held turn says it is waiting; the chip lands once, on a later turn.
    expect(run.toolTurnEnds[0]).toContainEqual(HELD);
    expect(run.toolTurnEnds[0]!.some(block => block.type === 'agent_file')).toBe(false);
    expect(run.toolTurnEnds.slice(1).flat().filter(block => block.type === 'agent_file')).toEqual([CHIP]);
    // The approved call's outcome is the chip.
    expect(run.reported).toEqual([{ call: run.preCalls[1]!.call, output: CHIP }]);
  });

  it('a decision-resolved the runner did not raise keeps the host note even with auto-attach on', async () => {
    // A cold session's hold, or one the model raised itself: not ours to answer.
    const run = await heldThenAnswered([HOLD],
      { type: 'decision-resolved', decisionId: 'd2', outcome: 'approved', note: 'HOST NOTE' });
    expect(run.seen).toEqual({ content: 'System message (not from the user): HOST NOTE', id: expect.any(String) });
    expect(run.preCallsAtPull).toBe(1);
    expect(run.preCalls).toHaveLength(1);
    expect(run.toolTurnEnds.flat().some(block => block.type === 'agent_file')).toBe(false);
    expect(run.reported).toEqual([]);
  });

  it('declining a held auto-attach gets the runner note and never asks the gate again', async () => {
    const run = await heldThenAnswered([HOLD],
      { type: 'decision-resolved', decisionId: 'd1', outcome: 'dismissed', note: 'HOST NOTE' });
    expect(run.seen).toEqual({ content: `System message (not from the user): ${DECLINED}`, id: expect.any(String) });
    expect(run.preCalls).toHaveLength(1);
    expect(run.toolTurnEnds.flat().some(block => block.type === 'agent_file')).toBe(false);
    expect(run.reported).toEqual([]);
  });

  it('an approval pulled while another turn streams lands once, on the turn that ends next', async () => {
    // The claude-sdk loop pulls ahead (TASK-573): the delivery is pulled while
    // the person's next turn is still streaming.
    const run = await autoAttachRun([HOLD, { verdict: 'allow' }], [
      { type: 'user-message', payload: { role: 'user', content: 'thanks' }, reqId: 'req-next', cursor: 1 },
      { type: 'decision-resolved', decisionId: 'd1', outcome: 'approved', note: 'HOST NOTE' },
    ], async (ctx, home) => {
      await fs.writeFile(path.join(home, 'report.txt'), 'report');
      await ctx.endTurn(turn); // the held turn
      await ctx.nextMessage(); // "thanks"
      await ctx.emitChunk({ kind: 'text', text: 'you are welcome' });
      expect(await ctx.nextMessage()).not.toBeNull(); // the approval, mid-turn
      await ctx.endTurn(turn); // the "thanks" turn
      await ctx.endTurn(turn); // the continuation
    });
    expect(run.toolTurnEnds.map(blocks => blocks.filter(block => block.type === 'agent_file'))).toEqual([[], [CHIP]]);
  });

  it('an approved chip the continuation turn never delivered is logged, not lost silently', async () => {
    // The approval is spent when the delivery is pulled; the chip waits for the
    // next turn-end. A continuation turn that throws out of the loop never ends.
    const run = await autoAttachRun([HOLD, { verdict: 'allow' }], [
      { type: 'decision-resolved', decisionId: 'd1', outcome: 'approved', note: 'HOST NOTE' },
    ], async (ctx, home) => {
      await fs.writeFile(path.join(home, 'report.txt'), 'report');
      await ctx.endTurn(turn); // the held turn
      expect(await ctx.nextMessage()).not.toBeNull(); // the approval
      throw new Error('provider exploded');
    }, 1);
    expect(run.toolTurnEnds.flat().some(block => block.type === 'agent_file')).toBe(false);
    // Once per chip the run could not deliver.
    const undelivered = run.logs.split('runner: could not attach a generated file (undelivered)\n').length - 1;
    expect(undelivered).toBe(1);
  });
});

describe('runRunner — uploads', () => {
  // Uploads are copied into `<scratch>/uploads/` at boot, and again when a
  // message names an attachment the sandbox has no copy of yet (a later turn's
  // upload on a warm runner). Each turn's attachment blocks are translated by
  // id from those copies.
  let scratch: string;
  let blobTmp: string;
  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-run-uploads-'));
    blobTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-run-blobs-'));
    // A scratch root also gets the session venv. Mark it present so the shell
    // does not start a `uv venv` child that outlives the test.
    await fs.mkdir(path.join(scratch, 'py'));
    await fs.writeFile(path.join(scratch, 'py', 'pyvenv.cfg'), '');
  });
  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
    await fs.rm(blobTmp, { recursive: true, force: true });
  });

  const NOTES = Buffer.from('hello from the person');
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const listed = (attachmentId: string) => ({
    attachmentId,
    filename: 'notes.txt',
    sha256: sha(NOTES),
    mediaType: 'text/plain',
    sizeBytes: NOTES.length,
  });
  const attachmentBlock = (attachmentId: string) => ({
    type: 'attachment',
    attachmentId,
    filename: 'notes.txt',
    mediaType: 'text/plain',
    sizeBytes: NOTES.length,
  });

  /** One conversation-bound run that pulls one message carrying `blocks`. */
  async function pullOne(opts: { lists: string[][]; blocks: unknown[] }): Promise<unknown> {
    const original = fakeClient.call.getMockImplementation()!;
    const lists = [...opts.lists];
    fakeClient.call.mockImplementation(async (action: string, ...args: unknown[]) => {
      if (action === 'session.get-config') return { ...(await original(action, ...args)), conversationId: 'c1' };
      if (action === 'attachments.list') {
        const ids = lists.length > 1 ? lists.shift()! : lists[0]!;
        return AttachmentsListResponseSchema.parse({ files: ids.map(listed) });
      }
      return original(action, ...args);
    });
    const originalBinary = fakeClient.callBinary.getMockImplementation()!;
    fakeClient.callBinary.mockImplementation(async (action: string, payload: unknown) => {
      if (action !== 'blob.get') return originalBinary(action, payload);
      expect(payload).toEqual({ sha256: sha(NOTES) });
      const tmp = path.join(blobTmp, `${randomName()}.bin`);
      await fs.writeFile(tmp, NOTES);
      return { path: tmp, bytes: NOTES.length };
    });
    scriptInbox([
      { type: 'user-message', payload: { role: 'user', content: 'see this', contentBlocks: opts.blocks }, reqId: 'r1', cursor: 1 },
    ]);
    let seen: unknown;
    const loop: Loop = {
      run: async (ctx) => {
        seen = (await ctx.nextMessage())?.content;
        return 0;
      },
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runRunner(() => loop, seams(() => ({ ...fakeEnv(), ephemeralRoot: scratch })))).toBe(0);
    } finally {
      stderr.mockRestore();
    }
    return seen;
  }

  let counter = 0;
  const randomName = () => `blob-${counter++}`;
  const listCalls = () => fakeClient.call.mock.calls.filter((c) => c[0] === 'attachments.list');
  const inlined = () =>
    `User attached 'notes.txt' at ${path.join(scratch, 'uploads', 'notes.txt')} (text/plain)\n\n${NOTES.toString('utf8')}`;

  it('re-materializes when a queued message carries an unknown attachmentId', async () => {
    // Nothing was uploaded when the runner booted; the message brings one.
    const seen = await pullOne({ lists: [[], ['att-new']], blocks: [attachmentBlock('att-new')] });
    expect(listCalls()).toEqual([
      ['attachments.list', { conversationId: 'c1' }],
      ['attachments.list', { conversationId: 'c1' }],
    ]);
    expect(await fs.readFile(path.join(scratch, 'uploads', 'notes.txt'))).toEqual(NOTES);
    expect(seen).toEqual([
      { type: 'text', text: 'see this' },
      { type: 'text', text: inlined() },
    ]);
    expect(await fs.readdir(blobTmp)).toEqual([]);
  });

  it('does not list again when every attachment in a message already has a copy', async () => {
    const seen = await pullOne({ lists: [['att-1']], blocks: [attachmentBlock('att-1')] });
    expect(listCalls()).toHaveLength(1);
    expect(seen).toEqual([
      { type: 'text', text: 'see this' },
      { type: 'text', text: inlined() },
    ]);
  });

  it('serializes overlapping copies: two concurrent pulls never copy one upload twice', async () => {
    // LoopContext does not forbid a loop from pulling twice at once. Two
    // queued messages each name an upload the runner has no copy of; if both
    // pulls copied at the same time, each would fetch both uploads and the
    // second copy of each would land as `notes (3).txt`, `notes (4).txt`.
    const original = fakeClient.call.getMockImplementation()!;
    let listCount = 0;
    fakeClient.call.mockImplementation(async (action: string, ...args: unknown[]) => {
      if (action === 'session.get-config') return { ...(await original(action, ...args)), conversationId: 'c1' };
      if (action === 'attachments.list') {
        listCount += 1;
        const ids = listCount === 1 ? [] : ['att-a', 'att-b'];
        return AttachmentsListResponseSchema.parse({ files: ids.map(listed) });
      }
      return original(action, ...args);
    });
    const originalBinary = fakeClient.callBinary.getMockImplementation()!;
    fakeClient.callBinary.mockImplementation(async (action: string, payload: unknown) => {
      if (action !== 'blob.get') return originalBinary(action, payload);
      // Slow enough that two unserialized copies overlap.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const tmp = path.join(blobTmp, `${randomName()}.bin`);
      await fs.writeFile(tmp, NOTES);
      return { path: tmp, bytes: NOTES.length };
    });
    scriptInbox([
      { type: 'user-message', payload: { role: 'user', content: 'a', contentBlocks: [attachmentBlock('att-a')] }, reqId: 'r1', cursor: 1 },
      { type: 'user-message', payload: { role: 'user', content: 'b', contentBlocks: [attachmentBlock('att-b')] }, reqId: 'r2', cursor: 2 },
    ]);
    const loop: Loop = {
      run: async (ctx) => {
        await Promise.all([ctx.nextMessage(), ctx.nextMessage()]);
        return 0;
      },
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runRunner(() => loop, seams(() => ({ ...fakeEnv(), ephemeralRoot: scratch })))).toBe(0);
    } finally {
      stderr.mockRestore();
    }
    const blobGets = fakeClient.callBinary.mock.calls.filter((c) => c[0] === 'blob.get');
    expect(blobGets).toHaveLength(2);
    expect((await fs.readdir(path.join(scratch, 'uploads'))).sort()).toEqual(['notes (2).txt', 'notes.txt']);
    expect(await fs.readdir(blobTmp)).toEqual([]);
  });

  it('an attachment the host does not list reaches the model as a mention, with no workspace read', async () => {
    const seen = await pullOne({ lists: [[]], blocks: [attachmentBlock('att-ghost')] });
    expect(seen).toEqual([
      { type: 'text', text: 'see this' },
      { type: 'text', text: "User attached 'notes.txt' (text/plain), but the file could not be loaded." },
    ]);
    expect(fakeClient.call.mock.calls.some((c) => c[0] === 'workspace.read')).toBe(false);
  });
});

describe('runRunner — working directory', () => {
  // TASK-995: the agent's home is AX_USERFILES_ROOT, with no fallback, and the
  // scratch root is separate from it. Loops use `homeDir` for the SDK's
  // HOME/cwd; the prompt engine names both roots.
  it('hands the loop and the prompt engine the agent home, and the scratch root beside it', async () => {
    const { buildSystemPrompt } = await import('../prompt-engine.js');
    vi.mocked(buildSystemPrompt).mockClear();
    const makeLoop = vi.fn((_deps: RunnerDeps) => ({ run: async () => 0 }));
    expect(await runRunner(makeLoop, seams(fakeEnv))).toBe(0);
    const deps = makeLoop.mock.calls[0]![0];
    expect(deps.homeDir).toBe(HOME);
    expect(deps.env).toMatchObject({ userFilesRoot: HOME, ephemeralRoot: SCRATCH });
    expect(deps.env).not.toHaveProperty('workspaceRoot');
    // The host-tool workspace flush is gone with the workspace.
    expect(deps).not.toHaveProperty('flushWorkspaceForHostTool');
    const args = vi.mocked(buildSystemPrompt).mock.calls.at(-1)!;
    expect(args[2]).toBe(HOME); //    home
    expect(args[3]).toBe(SCRATCH); // scratch
  });
});

describe('runRunner — bootstrap-safe augment (TASK-524)', () => {
  function configWith(extra: Record<string, unknown>): void {
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-1',
          agentId: 'a-1',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: 'RULES\n\nFACTS',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'anthropic/claude-sonnet-4-7',
            runner: 'claude-sdk',
            ...extra,
          },
          conversationId: null,
          runnerSessionId: null,
        };
      }
      if (action === 'tool.list') return { tools: [] };
      throw new Error(`unexpected call: ${action}`);
    });
  }

  async function lastPromptArgs(): Promise<unknown[]> {
    const { buildSystemPrompt } = await import('../prompt-engine.js');
    const mock = buildSystemPrompt as unknown as Mock;
    mock.mockClear();
    const loop: Loop = { run: vi.fn().mockResolvedValue(0) };
    expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    expect(mock).toHaveBeenCalledOnce();
    return mock.mock.calls[0]!;
  }

  it('hands the prompt engine the full augment AND the bootstrap-safe slice', async () => {
    configWith({ systemPromptBootstrapAugment: 'RULES' });
    const args = await lastPromptArgs();
    expect(args[1]).toBe('RULES\n\nFACTS');
    expect(args[6]).toBe('RULES');
  });

  it('a session frozen before TASK-524 (no field) means no bootstrap augment', async () => {
    configWith({});
    const args = await lastPromptArgs();
    expect(args[6]).toBe('');
  });
});

describe('runRunner', () => {
  it('returns 2 and does not fire chat-end when boot fails', async () => {
    const makeLoop = vi.fn();
    const code = await runRunner(
      makeLoop,
      seams(() => {
        throw new Error('missing AX_RUNNER_ENDPOINT');
      }),
    );
    expect(code).toBe(2);
    expect(makeLoop).not.toHaveBeenCalled();
    // No IPC client was ever built, so no event.chat-end could have shipped.
    expect(createIpcClientMock).not.toHaveBeenCalled();
    expect(fakeClient.event).not.toHaveBeenCalled();
  });

  // TASK-994 (design §11): the SDK loads $CLAUDE_CONFIG_DIR as its own trusted
  // config, so one inside the agent's files would turn anything the agent
  // writes there into settings, hooks, skills or MCP servers. The guard runs
  // before every other boot step, including the installed-skills
  // materialization that writes into $CLAUDE_CONFIG_DIR/skills.
  it("refuses to start before any IPC or filesystem work when CLAUDE_CONFIG_DIR is inside the agent's files", async () => {
    const t = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-run-runner-guard-'));
    const files = path.join(t, 'files');
    const cfg = path.join(files, '.claude');
    await fs.mkdir(cfg, { recursive: true });
    const { writeProxyCaFromEnv } = await import('../proxy-ca-from-env.js');
    const { setupProxy } = await import('../proxy-startup.js');
    const { materializeInstalledSkillsFromEnv } = await import('../installed-skills.js');
    vi.mocked(writeProxyCaFromEnv).mockClear();
    vi.mocked(setupProxy).mockClear();
    vi.mocked(materializeInstalledSkillsFromEnv).mockClear();
    const createTranscriptSource = vi.fn(() => transcriptSource);
    const makeLoop = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runRunner(makeLoop, {
        ...seams(() => ({ ...fakeEnv(), userFilesRoot: files, claudeConfigDir: cfg })),
        createTranscriptSource,
      });
      expect(code).toBe(2);
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/CLAUDE_CONFIG_DIR/);
      expect(createTranscriptSource).not.toHaveBeenCalled();
      expect(writeProxyCaFromEnv).not.toHaveBeenCalled();
      expect(setupProxy).not.toHaveBeenCalled();
      expect(materializeInstalledSkillsFromEnv).not.toHaveBeenCalled();
      expect(createIpcClientMock).not.toHaveBeenCalled();
      expect(makeLoop).not.toHaveBeenCalled();
      expect(fakeClient.event).not.toHaveBeenCalled();
      expect(await fs.readdir(files)).toEqual(['.claude']);
      expect(await fs.readdir(cfg)).toEqual([]);
    } finally {
      stderr.mockRestore();
      await fs.rm(t, { recursive: true, force: true });
    }
  });

  // TASK-995: the home is the agent's cwd and the only place its work
  // persists. A sandbox that did not mount it would otherwise boot an agent
  // whose every file write fails, or (were anything to create it) silently
  // land on ephemeral disk. Refused right after the config-dir guard, before
  // any IPC or other boot work.
  it.each([
    ['does not exist', async (t: string) => path.join(t, 'files')],
    [
      'is a regular file',
      async (t: string) => {
        const p = path.join(t, 'files');
        await fs.writeFile(p, 'not a directory');
        return p;
      },
    ],
    [
      'is a symlink to a regular file',
      async (t: string) => {
        await fs.writeFile(path.join(t, 'target'), 'x');
        const p = path.join(t, 'files');
        await fs.symlink(path.join(t, 'target'), p);
        return p;
      },
    ],
  ])("refuses to start when the agent's home %s", async (_label, makeHome) => {
    const t = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-run-runner-home-'));
    const home = await makeHome(t);
    const createTranscriptSource = vi.fn(() => transcriptSource);
    const makeLoop = vi.fn();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runRunner(makeLoop, {
        ...seams(() => ({ ...fakeEnv(), userFilesRoot: home })),
        createTranscriptSource,
      });
      expect(code).toBe(2);
      const out = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(out).toContain(`refusing to start: the agent's home (${home}) is not an existing directory`);
      expect(createTranscriptSource).not.toHaveBeenCalled();
      expect(createIpcClientMock).not.toHaveBeenCalled();
      expect(makeLoop).not.toHaveBeenCalled();
      // Nothing created it.
      expect((await fs.lstat(home).catch(() => null))?.isDirectory() ?? false).toBe(false);
    } finally {
      stderr.mockRestore();
      await fs.rm(t, { recursive: true, force: true });
    }
  });

  it('returns 2, closes the client, and fires NO chat-end when boot fails AFTER the client exists', async () => {
    // The load-bearing half of the contract. A bootstrap failure past the IPC
    // client (here: tool.list) must NOT emit event.chat-end — the orchestrator's
    // `handle.exited` watcher synthesizes the terminated outcome, so chat:end
    // fires exactly once per agent:invoke. An extra chat-end here would double it.
    fakeClient.call.mockImplementation(async (action: string) => {
      if (action === 'session.get-config') {
        return {
          userId: 'u-1',
          agentId: 'a-1',
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
      if (action === 'tool.list') throw new Error('host returned 503');
      throw new Error(`unexpected call: ${action}`);
    });

    const makeLoop = vi.fn();
    const code = await runRunner(makeLoop, seams(fakeEnv));

    expect(code).toBe(2);
    expect(makeLoop).not.toHaveBeenCalled();
    expect(fakeClient.close).toHaveBeenCalledTimes(1);
    expect(fakeClient.event).not.toHaveBeenCalled();
  });

  it('returns the loop exit code on a normal run', async () => {
    const loop: Loop = { run: vi.fn().mockResolvedValue(0) };
    const code = await runRunner(() => loop, seams(fakeEnv));
    expect(code).toBe(0);
    expect(loop.run).toHaveBeenCalledOnce();
    const chatEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.chat-end',
    );
    expect(chatEnds).toHaveLength(1);
    expect((chatEnds[0]?.[1] as { outcome: { kind: string } }).outcome.kind).toBe(
      'complete',
    );
  });

  it('carries a loop-supplied reason into the terminated chat-end outcome', async () => {
    const loop: Loop = {
      run: vi.fn().mockResolvedValue({ code: 1, reason: 'provider stream closed' }),
    };
    const code = await runRunner(() => loop, seams(fakeEnv));
    expect(code).toBe(1);
    const chatEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.chat-end',
    );
    expect(chatEnds).toHaveLength(1);
    expect(chatEnds[0]?.[1]).toMatchObject({
      outcome: { kind: 'terminated', reason: 'provider stream closed' },
    });
  });

  it('returns 1 when the loop throws', async () => {
    const loop: Loop = { run: vi.fn().mockRejectedValue(new Error('sdk exploded')) };
    const code = await runRunner(() => loop, seams(fakeEnv));
    expect(code).toBe(1);
    const chatEnds = fakeClient.event.mock.calls.filter(
      (c) => c[0] === 'event.chat-end',
    );
    expect(chatEnds).toHaveLength(1);
    expect(chatEnds[0]?.[1]).toMatchObject({
      outcome: { kind: 'terminated', reason: 'Error: sdk exploded' },
    });
  });
  // ---- AW-6: the decision-resolved delivery ----------------------------

  describe('decision-resolved delivery', () => {
    it('starts a turn from the host-authored note, labelled as not-the-user', async () => {
      scriptInbox([
        {
          type: 'decision-resolved',
          decisionId: 'dec_1',
          outcome: 'approved',
          note: 'They said yes. Make the call again exactly as you made it.',
        },
      ]);
      let seen: unknown;
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          seen = await ctx.nextMessage();
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      // The note reaches the model VERBATIM apart from the fixed label. If a
      // future edit started paraphrasing it here, the sentence the person's
      // approval authorised and the sentence the agent reads would drift.
      expect(seen).toEqual({
        content:
          'System message (not from the user): ' +
          'They said yes. Make the call again exactly as you made it.',
        id: expect.any(String),
      });
    });

    it('emits the continuation under the delivered reqId (TASK-278)', async () => {
      scriptInbox([
        {
          type: 'decision-resolved',
          decisionId: 'dec_1',
          outcome: 'approved',
          note: 'They said yes.',
          reqId: 'req-continuation-1',
        },
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          await ctx.emitChunk({ kind: 'text', text: 'carrying on' });
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      expect(fakeClient.event).toHaveBeenCalledWith('event.stream-chunk', {
        reqId: 'req-continuation-1',
        kind: 'text',
        text: 'carrying on',
      });
    });

    it('runs dark when the delivery carries no reqId, as before (TASK-278)', async () => {
      scriptInbox([
        {
          type: 'decision-resolved',
          decisionId: 'dec_1',
          outcome: 'approved',
          note: 'They said yes.',
        },
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          await ctx.emitChunk({ kind: 'text', text: 'carrying on' });
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      // Vacuity: the chunk emission was skipped, not misrouted — nothing
      // stamped with a stale id, and the turn still ended normally.
      expect(
        fakeClient.event.mock.calls.filter((c) => c[0] === 'event.stream-chunk'),
      ).toHaveLength(0);
    });

    // TASK-573. The Claude Agent SDK pumps its prompt iterable EAGERLY
    // (`Query.streamInput` is a bare `for await` into the CLI's stdin), so the
    // loop's next `nextMessage()` is already pending while a turn streams. When
    // a person approves mid-reply, the decision-resolved entry is pulled
    // BEFORE the held turn's `result`. The shell used to adopt the
    // continuation's reqId right there, so the held turn's remaining chunks
    // and its turn-end went out stamped with the continuation's id — and the
    // SSE stream on that id (#741 matches on payload.reqId) closed on the held
    // turn's turn-end before the continuation said a word.
    it('keeps the held turn on its own reqId when the decision resolves mid-stream (TASK-573)', async () => {
      // A hand-rolled inbox: the delivery is released by the loop itself,
      // mid-turn, and the loop waits on the pull resolving — events, no sleeps.
      let releaseDecision!: () => void;
      const decisionArrived = new Promise<void>((r) => {
        releaseDecision = r;
      });
      const entries: Array<() => Promise<unknown>> = [
        async () => ({
          type: 'user-message',
          payload: { role: 'user', content: 'read gnu.org' },
          reqId: 'req-held',
          cursor: 1,
        }),
        async () => {
          await decisionArrived;
          return {
            type: 'decision-resolved',
            decisionId: 'dec_1',
            outcome: 'approved',
            note: 'They said yes.',
            reqId: 'req-continuation',
          };
        },
      ];
      (createInboxLoop as unknown as Mock).mockReturnValueOnce({
        next: vi.fn(async () => {
          const e = entries.shift();
          return e !== undefined ? e() : { type: 'cancel' };
        }),
        cursor: 0,
      });
      const endTurnInput = {
        contentBlocks: [],
        toolResultBlocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'held' }],
        readTurnId: async () => undefined,
        usage: null,
      } as unknown as Parameters<LoopContext['endTurn']>[0];

      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage(); // the user's message → the held turn
          // What the SDK does: the next pull is already in flight.
          const pull = ctx.nextMessage();
          await ctx.emitChunk({ kind: 'text', text: 'held-1' });
          releaseDecision(); // the person approves while the reply streams
          const continuation = await pull; // the pull resolves mid-turn
          expect(continuation).not.toBeNull();
          await ctx.emitChunk({ kind: 'text', text: 'held-2' });
          await ctx.endTurn(endTurnInput); // the held turn's `result`
          await ctx.emitChunk({ kind: 'text', text: 'cont-1' });
          await ctx.endTurn(endTurnInput); // the continuation's `result`
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);

      const frames = fakeClient.event.mock.calls
        .filter((c) => c[0] === 'event.stream-chunk' || c[0] === 'event.turn-end')
        .map((c) => {
          const p = c[1] as { reqId?: string; text?: string; role?: string };
          return `${c[0] === 'event.stream-chunk' ? `chunk:${p.text}` : `turn-end:${p.role}`}@${p.reqId}`;
        });
      expect(frames).toEqual([
        'chunk:held-1@req-held',
        'chunk:held-2@req-held',
        'turn-end:tool@req-held',
        'turn-end:assistant@req-held',
        'chunk:cont-1@req-continuation',
        'turn-end:tool@req-continuation',
        'turn-end:assistant@req-continuation',
      ]);
    });

    it('parks a pulled-ahead message with no reqId too: the held turn stays on its id, the next runs dark (TASK-573)', async () => {
      scriptInbox([
        {
          type: 'user-message',
          payload: { role: 'user', content: 'read gnu.org' },
          reqId: 'req-held',
          cursor: 1,
        },
        {
          type: 'decision-resolved',
          decisionId: 'dec_1',
          outcome: 'approved',
          note: 'They said yes.',
        },
      ]);
      const endTurnInput = {
        contentBlocks: [],
        toolResultBlocks: [],
        readTurnId: async () => undefined,
        usage: null,
      } as unknown as Parameters<LoopContext['endTurn']>[0];
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          // Pulled ahead, resolved before the held turn's result.
          expect(await ctx.nextMessage()).not.toBeNull();
          await ctx.emitChunk({ kind: 'text', text: 'held-1' });
          await ctx.endTurn(endTurnInput);
          await ctx.emitChunk({ kind: 'text', text: 'cont-1' });
          await ctx.endTurn(endTurnInput);
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      const frames = fakeClient.event.mock.calls
        .filter((c) => c[0] === 'event.stream-chunk' || c[0] === 'event.turn-end')
        .map((c) => `${c[0]}@${(c[1] as { reqId?: string }).reqId ?? 'none'}`);
      // The continuation's chunk is skipped (no id to route it to), never
      // stamped with the held turn's already-finished id.
      expect(frames).toEqual([
        'event.stream-chunk@req-held',
        'event.turn-end@req-held',
        'event.turn-end@none',
      ]);
    });

    it('adopts the continuation reqId at once when the decision resolves between turns (TASK-573)', async () => {
      // The late-approve case: the held turn has already ended, so the
      // delivery is pulled with no turn in flight and routes immediately.
      scriptInbox([
        {
          type: 'user-message',
          payload: { role: 'user', content: 'read gnu.org' },
          reqId: 'req-held',
          cursor: 1,
        },
        {
          type: 'decision-resolved',
          decisionId: 'dec_1',
          outcome: 'approved',
          note: 'They said yes.',
          reqId: 'req-continuation',
        },
      ]);
      const endTurnInput = {
        contentBlocks: [],
        toolResultBlocks: [],
        readTurnId: async () => undefined,
        usage: null,
      } as unknown as Parameters<LoopContext['endTurn']>[0];
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          await ctx.emitChunk({ kind: 'text', text: 'held-1' });
          await ctx.endTurn(endTurnInput);
          await ctx.nextMessage();
          await ctx.emitChunk({ kind: 'text', text: 'cont-1' });
          await ctx.endTurn(endTurnInput);
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      const frames = fakeClient.event.mock.calls
        .filter((c) => c[0] === 'event.stream-chunk' || c[0] === 'event.turn-end')
        .map((c) => `${c[0]}@${(c[1] as { reqId?: string }).reqId}`);
      expect(frames).toEqual([
        'event.stream-chunk@req-held',
        'event.turn-end@req-held',
        'event.stream-chunk@req-continuation',
        'event.turn-end@req-continuation',
      ]);
    });

    // TASK-573. The shell can't count on one `endTurn` per pulled message: the
    // Claude Code CLI folds a message that arrives mid-turn into the running
    // turn (its `queued_command` attachment), so two pulls can share one
    // `result`. A shell that counted hand-overs would then run one message
    // behind for the rest of the session.
    it('does not drift when a pulled-ahead message is folded into the running turn (TASK-573)', async () => {
      scriptInbox([
        {
          type: 'user-message',
          payload: { role: 'user', content: 'first' },
          reqId: 'req-a',
          cursor: 1,
        },
        {
          type: 'user-message',
          payload: { role: 'user', content: 'also this' },
          reqId: 'req-b',
          cursor: 2,
        },
        {
          type: 'user-message',
          payload: { role: 'user', content: 'later' },
          reqId: 'req-c',
          cursor: 3,
        },
        {
          type: 'user-message',
          payload: { role: 'user', content: 'much later' },
          reqId: 'req-d',
          cursor: 4,
        },
      ]);
      const endTurnInput = {
        contentBlocks: [],
        toolResultBlocks: [],
        readTurnId: async () => undefined,
        usage: null,
      } as unknown as Parameters<LoopContext['endTurn']>[0];
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage(); // req-a opens the turn
          await ctx.emitChunk({ kind: 'text', text: 'a-1' });
          await ctx.nextMessage(); // req-b arrives mid-turn and is folded in
          await ctx.emitChunk({ kind: 'text', text: 'a-2' });
          await ctx.endTurn(endTurnInput); // ONE result for both messages
          await ctx.nextMessage(); // req-c, pulled with nothing streaming
          await ctx.emitChunk({ kind: 'text', text: 'c-1' });
          await ctx.endTurn(endTurnInput);
          await ctx.nextMessage(); // req-d
          await ctx.emitChunk({ kind: 'text', text: 'd-1' });
          await ctx.endTurn(endTurnInput);
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      const frames = fakeClient.event.mock.calls
        .filter((c) => c[0] === 'event.stream-chunk' || c[0] === 'event.turn-end')
        .map((c) => {
          const p = c[1] as { reqId?: string; text?: string };
          return `${c[0] === 'event.stream-chunk' ? `chunk:${p.text}` : 'turn-end'}@${p.reqId}`;
        });
      expect(frames).toEqual([
        'chunk:a-1@req-a',
        'chunk:a-2@req-a',
        'turn-end@req-a',
        // req-b was answered inside the turn that just ended; the next pull
        // adopts at once rather than queueing behind it.
        'chunk:c-1@req-c',
        'turn-end@req-c',
        'chunk:d-1@req-d',
        'turn-end@req-d',
      ]);
    });

    // TASK-785 (absorbs TASK-578). The mirror image of the fold above: ONE
    // pulled message answered across SEVERAL `endTurn`s (a loop that reports
    // each model step as its own turn, pulling only when it is done). The id
    // belongs to the message, not to the endTurn — so a hand-over that consumed
    // one id per endTurn (a FIFO shift, which hands over `undefined` once the
    // queue is empty) would run every step after the first dark, and the SSE
    // stream keyed on req-a would never hear the rest of its reply.
    it('keeps one message\'s reqId on every chunk and turn-end across several endTurns (TASK-785)', async () => {
      scriptInbox([
        { type: 'user-message', payload: { role: 'user', content: 'a' }, reqId: 'req-a', cursor: 1 },
        { type: 'user-message', payload: { role: 'user', content: 'b' }, reqId: 'req-b', cursor: 2 },
      ]);
      const endTurnInput = {
        contentBlocks: [],
        toolResultBlocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        readTurnId: async () => undefined,
        usage: null,
      } as unknown as Parameters<LoopContext['endTurn']>[0];
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage(); // req-a
          for (const step of ['a-1', 'a-2', 'a-3']) {
            await ctx.emitChunk({ kind: 'text', text: step });
            await ctx.endTurn(endTurnInput);
          }
          await ctx.nextMessage(); // req-b, only once req-a is fully answered
          await ctx.emitChunk({ kind: 'text', text: 'b-1' });
          await ctx.endTurn(endTurnInput);
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      const frames = fakeClient.event.mock.calls
        .filter((c) => c[0] === 'event.stream-chunk' || c[0] === 'event.turn-end')
        .map((c) => {
          const p = c[1] as { reqId?: string; text?: string; role?: string };
          return `${c[0] === 'event.stream-chunk' ? `chunk:${p.text}` : `turn-end:${p.role}`}@${p.reqId}`;
        });
      expect(frames).toEqual([
        'chunk:a-1@req-a',
        'turn-end:tool@req-a',
        'turn-end:assistant@req-a',
        'chunk:a-2@req-a',
        'turn-end:tool@req-a',
        'turn-end:assistant@req-a',
        'chunk:a-3@req-a',
        'turn-end:tool@req-a',
        'turn-end:assistant@req-a',
        'chunk:b-1@req-b',
        'turn-end:tool@req-b',
        'turn-end:assistant@req-b',
      ]);
    });

    // TASK-708. The fold above answered req-b inside req-a's turn, so req-b
    // never gets a turn-end of its own — and a host subscriber that waits for
    // one (agent-activity's "working" record) waited until chat:end. The loop
    // reports what the SDK consumed; the shell names the folded id on the
    // turn-ends of the turn that answered it, and only there.
    describe('folded messages (TASK-708)', () => {
      const endTurnInput = {
        contentBlocks: [],
        toolResultBlocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'slow' }],
        readTurnId: async () => undefined,
        usage: null,
      } as unknown as Parameters<LoopContext['endTurn']>[0];
      const turnEnds = (): Array<{ reqId?: string; role?: string; foldedReqIds?: string[] }> =>
        fakeClient.event.mock.calls
          .filter((c) => c[0] === 'event.turn-end')
          .map((c) => c[1] as { reqId?: string; role?: string; foldedReqIds?: string[] });
      const inbox = (...ids: string[]): void =>
        scriptInbox(
          ids.map((reqId, i) => ({
            type: 'user-message',
            payload: { role: 'user', content: reqId },
            reqId,
            cursor: i + 1,
          })),
        );

      it('names a message consumed into a running turn on that turn\'s turn-ends', async () => {
        inbox('req-a', 'req-b', 'req-c');
        const loop: Loop = {
          run: vi.fn(async (ctx: LoopContext) => {
            const a = await ctx.nextMessage();
            ctx.markMessageConsumed(a!.id); // the turn's own message: not a fold
            await ctx.emitChunk({ kind: 'text', text: 'a-1' });
            const b = await ctx.nextMessage(); // arrives mid-turn
            ctx.markMessageConsumed(b!.id); // ...and the SDK folds it in
            await ctx.endTurn(endTurnInput);
            const c = await ctx.nextMessage();
            ctx.markMessageConsumed(c!.id);
            await ctx.emitChunk({ kind: 'text', text: 'c-1' });
            await ctx.endTurn(endTurnInput);
            return 0;
          }),
        };
        expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
        expect(turnEnds()).toEqual([
          expect.objectContaining({ role: 'tool', reqId: 'req-a', foldedReqIds: ['req-b'] }),
          expect.objectContaining({ role: 'assistant', reqId: 'req-a', foldedReqIds: ['req-b'] }),
          expect.objectContaining({ role: 'tool', reqId: 'req-c' }),
          expect.objectContaining({ role: 'assistant', reqId: 'req-c' }),
        ]);
        // Scoped to the turn that answered it: a later turn does not repeat it.
        expect(turnEnds()[2]).not.toHaveProperty('foldedReqIds');
        expect(turnEnds()[3]).not.toHaveProperty('foldedReqIds');
      });

      it('does not list a pulled-ahead message that gets its own turn', async () => {
        inbox('req-a', 'req-b');
        const loop: Loop = {
          run: vi.fn(async (ctx: LoopContext) => {
            const a = await ctx.nextMessage();
            ctx.markMessageConsumed(a!.id);
            await ctx.emitChunk({ kind: 'text', text: 'a-1' });
            const b = await ctx.nextMessage(); // parked: a's turn is streaming
            await ctx.endTurn(endTurnInput);
            ctx.markMessageConsumed(b!.id); // consumed only once a's turn ended
            await ctx.emitChunk({ kind: 'text', text: 'b-1' });
            await ctx.endTurn(endTurnInput);
            return 0;
          }),
        };
        expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
        const ends = turnEnds();
        expect(ends.map((e) => e.reqId)).toEqual(['req-a', 'req-a', 'req-b', 'req-b']);
        for (const e of ends) expect(e).not.toHaveProperty('foldedReqIds');
      });

      it('lists a consumed message whose turn ends up named after a later one', async () => {
        // b gets its own turn, but c is pulled after the hand-over and before
        // b's first chunk, so c adopts at once and b's turn closes under c.
        inbox('req-a', 'req-b', 'req-c');
        const loop: Loop = {
          run: vi.fn(async (ctx: LoopContext) => {
            const a = await ctx.nextMessage();
            ctx.markMessageConsumed(a!.id);
            await ctx.emitChunk({ kind: 'text', text: 'a-1' });
            const b = await ctx.nextMessage();
            await ctx.endTurn(endTurnInput);
            ctx.markMessageConsumed(b!.id);
            const c = await ctx.nextMessage();
            await ctx.emitChunk({ kind: 'text', text: 'b-1' });
            await ctx.endTurn(endTurnInput);
            void c;
            return 0;
          }),
        };
        expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
        const ends = turnEnds();
        expect(ends.map((e) => e.reqId)).toEqual(['req-a', 'req-a', 'req-c', 'req-c']);
        expect(ends[0]).not.toHaveProperty('foldedReqIds');
        expect(ends[2]?.foldedReqIds).toEqual(['req-b']);
        expect(ends[3]?.foldedReqIds).toEqual(['req-b']);
      });

      it('ignores unknown and repeated ids, and messages without a reqId', async () => {
        scriptInbox([
          { type: 'user-message', payload: { role: 'user', content: 'a' }, reqId: 'req-a', cursor: 1 },
          { type: 'user-message', payload: { role: 'user', content: 'no id' }, cursor: 2 },
          { type: 'user-message', payload: { role: 'user', content: 'b' }, reqId: 'req-b', cursor: 3 },
        ]);
        const loop: Loop = {
          run: vi.fn(async (ctx: LoopContext) => {
            const a = await ctx.nextMessage();
            await ctx.emitChunk({ kind: 'text', text: 'a-1' });
            const anon = await ctx.nextMessage();
            const b = await ctx.nextMessage();
            ctx.markMessageConsumed('not-a-message-id');
            ctx.markMessageConsumed(anon!.id);
            ctx.markMessageConsumed(a!.id);
            ctx.markMessageConsumed(b!.id);
            ctx.markMessageConsumed(b!.id);
            await ctx.endTurn(endTurnInput);
            return 0;
          }),
        };
        expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
        const ends = turnEnds();
        expect(ends).toHaveLength(2);
        for (const e of ends) expect(e.foldedReqIds).toEqual(['req-b']);
      });
    });

    it('parks a message pulled while the continuation streams, then hands it over at its end (TASK-573)', async () => {
      scriptInbox([
        {
          type: 'user-message',
          payload: { role: 'user', content: 'read gnu.org' },
          reqId: 'req-held',
          cursor: 1,
        },
        {
          type: 'decision-resolved',
          decisionId: 'dec_1',
          outcome: 'approved',
          note: 'They said yes.',
          reqId: 'req-continuation',
        },
        {
          type: 'user-message',
          payload: { role: 'user', content: 'thanks' },
          reqId: 'req-next',
          cursor: 2,
        },
      ]);
      const endTurnInput = {
        contentBlocks: [],
        toolResultBlocks: [],
        readTurnId: async () => undefined,
        usage: null,
      } as unknown as Parameters<LoopContext['endTurn']>[0];
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          await ctx.emitChunk({ kind: 'text', text: 'held-1' });
          await ctx.nextMessage(); // decision pulled mid-reply
          await ctx.endTurn(endTurnInput);
          await ctx.emitChunk({ kind: 'text', text: 'cont-1' });
          await ctx.nextMessage(); // pulled while the continuation streams
          await ctx.emitChunk({ kind: 'text', text: 'cont-2' });
          await ctx.endTurn(endTurnInput);
          await ctx.emitChunk({ kind: 'text', text: 'next-1' });
          await ctx.endTurn(endTurnInput);
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      const frames = fakeClient.event.mock.calls
        .filter((c) => c[0] === 'event.stream-chunk' || c[0] === 'event.turn-end')
        .map((c) => {
          const p = c[1] as { reqId?: string; text?: string };
          return `${c[0] === 'event.stream-chunk' ? `chunk:${p.text}` : 'turn-end'}@${p.reqId}`;
        });
      expect(frames).toEqual([
        'chunk:held-1@req-held',
        'turn-end@req-held',
        'chunk:cont-1@req-continuation',
        'chunk:cont-2@req-continuation',
        'turn-end@req-continuation',
        'chunk:next-1@req-next',
        'turn-end@req-next',
      ]);
    });

    it('never lets a pulled-ahead message without a reqId displace a parked one (TASK-573)', async () => {
      scriptInbox([
        {
          type: 'user-message',
          payload: { role: 'user', content: 'first' },
          reqId: 'req-a',
          cursor: 1,
        },
        {
          type: 'user-message',
          payload: { role: 'user', content: 'second' },
          reqId: 'req-b',
          cursor: 2,
        },
        {
          // No id of its own: it inherits, it does not overwrite.
          type: 'user-message',
          payload: { role: 'user', content: 'third' },
          reqId: '',
          cursor: 3,
        },
      ]);
      const endTurnInput = {
        contentBlocks: [],
        toolResultBlocks: [],
        readTurnId: async () => undefined,
        usage: null,
      } as unknown as Parameters<LoopContext['endTurn']>[0];
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          await ctx.emitChunk({ kind: 'text', text: 'a-1' });
          await ctx.nextMessage(); // req-b parks
          await ctx.nextMessage(); // the id-less one arrives behind it
          await ctx.endTurn(endTurnInput);
          await ctx.emitChunk({ kind: 'text', text: 'b-1' });
          await ctx.endTurn(endTurnInput);
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      const frames = fakeClient.event.mock.calls
        .filter((c) => c[0] === 'event.stream-chunk' || c[0] === 'event.turn-end')
        .map((c) => {
          const p = c[1] as { reqId?: string; text?: string };
          return `${c[0] === 'event.stream-chunk' ? `chunk:${p.text}` : 'turn-end'}@${p.reqId}`;
        });
      expect(frames).toEqual([
        'chunk:a-1@req-a',
        'turn-end@req-a',
        'chunk:b-1@req-b',
        'turn-end@req-b',
      ]);
    });

    it('re-polls past a delivery whose note is empty rather than waking the model', async () => {
      scriptInbox([
        { type: 'decision-resolved', decisionId: 'dec_1', outcome: 'approved', note: '   ' },
        { type: 'cancel' },
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          // `cancel` resolves null — so reaching null proves the empty
          // delivery did NOT become a turn.
          expect(await ctx.nextMessage()).toBeNull();
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      expect(loop.run).toHaveBeenCalledOnce();
    });
  });

  // ---- ctx.onInterrupt (TASK-688: the Stop button) ------------------------
  //
  // `interrupt` means "stop the turn that is running, and stay warm" — it is
  // NOT `cancel` (which ends the session). The wrinkle these tests pin: only
  // ONE reader may hold the inbox cursor, and the aisdk loop does not pull
  // during a turn at all. So the shell keeps a read outstanding while a turn is
  // active and routes `interrupt` to whoever registered for it; the loops never
  // see the entry.
  describe('onInterrupt', () => {
    const userMsg = (content: string, reqId: string) => ({
      type: 'user-message',
      payload: { role: 'user', content },
      reqId,
      cursor: 1,
    });
    const closeInput = {
      contentBlocks: [],
      toolResultBlocks: [],
      readTurnId: async () => undefined,
      usage: null,
    } as unknown as Parameters<LoopContext['endTurn']>[0];

    function deferred<T = void>() {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }
    /** Let every already-settled promise chain run. Events, not sleeps. */
    const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

    /** A hand-rolled inbox: each entry is released by the test. Exhausted → cancel. */
    function gatedInbox(entries: Array<() => Promise<unknown>>) {
      const queue = [...entries];
      const next = vi.fn(async () => {
        const e = queue.shift();
        return e !== undefined ? e() : { type: 'cancel' };
      });
      (createInboxLoop as unknown as Mock).mockReturnValueOnce({ next, cursor: 0 });
      return next;
    }

    it('reaches a loop that is NOT pulling: the shell reads the inbox during the turn (aisdk shape)', async () => {
      const stop = deferred();
      gatedInbox([
        async () => userMsg('long task', 'req-1'),
        async () => {
          await stop.promise;
          return { type: 'interrupt', cursor: 2 };
        },
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          expect(await ctx.nextMessage()).not.toBeNull();
          const fired = deferred();
          const off = ctx.onInterrupt(() => fired.resolve());
          stop.resolve(); // Stop is pressed while the loop is busy streaming
          await fired.promise; // never settles if nothing reads the inbox mid-turn
          off();
          await ctx.endTurn(closeInput);
          // The queued `cancel` is still there for the pull that follows, and
          // is still what ends the session: interrupt did not swallow it.
          expect(await ctx.nextMessage()).toBeNull();
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    });

    it('routes an interrupt that lands on a PENDING pull without resolving that pull (claude-sdk shape)', async () => {
      const stop = deferred();
      const end = deferred();
      gatedInbox([
        async () => userMsg('long task', 'req-1'),
        async () => {
          await stop.promise;
          return { type: 'interrupt', cursor: 2 };
        },
        async () => {
          await end.promise;
          return { type: 'cancel', cursor: 3 };
        },
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          const pull = ctx.nextMessage(); // the SDK's pull-ahead
          let pullSettled = false;
          void pull.then(() => {
            pullSettled = true;
          });
          const fired = vi.fn();
          ctx.onInterrupt(fired);
          stop.resolve();
          await flush();
          expect(fired).toHaveBeenCalledTimes(1);
          // The entry was consumed by the router, not handed to the pull as if
          // it were a message or a cancel.
          expect(pullSettled).toBe(false);
          end.resolve();
          expect(await pull).toBeNull();
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    });

    it('drops an interrupt that arrives while nothing is running', async () => {
      const inbox = gatedInbox([
        async () => ({ type: 'interrupt', cursor: 1 }),
        async () => userMsg('hello', 'req-1'),
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          // The interrupt precedes the message in the inbox: an idle runner has
          // no turn to stop, so it is skipped and the message still arrives.
          const m = await ctx.nextMessage();
          expect(m).not.toBeNull();
          const fired = vi.fn();
          ctx.onInterrupt(fired);
          await flush();
          expect(fired).not.toHaveBeenCalled();
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      expect(inbox).toHaveBeenCalled();
    });

    it('latches an interrupt read before the loop registered, and fires it on registration', async () => {
      // Cold-spawn deferral queues `[user-message, interrupt]` back to back, so
      // the interrupt can be read before the loop gets as far as `onInterrupt`.
      gatedInbox([
        async () => userMsg('go', 'req-1'),
        async () => ({ type: 'interrupt', cursor: 2 }),
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          await flush(); // the shell routes the interrupt now — nobody is listening
          const fired = vi.fn();
          ctx.onInterrupt(fired);
          await flush();
          expect(fired).toHaveBeenCalledTimes(1);
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    });

    it('fires the handlers once per turn however many times Stop is pressed', async () => {
      // A double click queues two entries. The second must not reach a loop
      // that has already been told: for the SDK that is a second interrupt()
      // landing after the turn it meant, on whatever turn started next.
      const first = deferred();
      const second = deferred();
      gatedInbox([
        async () => userMsg('go', 'req-1'),
        async () => {
          await first.promise;
          return { type: 'interrupt', cursor: 2 };
        },
        async () => {
          await second.promise;
          return { type: 'interrupt', cursor: 3 };
        },
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          const fired = vi.fn();
          ctx.onInterrupt(fired); // registered BEFORE either press lands
          first.resolve();
          await flush();
          second.resolve();
          await flush();
          expect(fired).toHaveBeenCalledTimes(1);
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    });

    it('a handler registered once for the whole session (claude-sdk) is not fired by an idle interrupt', async () => {
      // The Claude loop registers ONE handler up front and keeps it, so unlike
      // the aisdk loop it is listening when an idle press arrives. Firing it
      // then would be `query.interrupt()` with no turn to stop.
      const late = deferred();
      gatedInbox([
        async () => ({ type: 'interrupt', cursor: 1 }), // before any message: idle
        async () => userMsg('first', 'req-1'),
        async () => {
          await late.promise;
          return { type: 'interrupt', cursor: 3 }; // after turn one has ended
        },
        async () => userMsg('second', 'req-2'),
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          const fired = vi.fn();
          ctx.onInterrupt(fired);
          await ctx.nextMessage();
          await flush();
          expect(fired).not.toHaveBeenCalled(); // the idle press was dropped
          await ctx.endTurn(closeInput);
          late.resolve();
          await ctx.nextMessage();
          await flush();
          expect(fired).not.toHaveBeenCalled(); // and so was the late one
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    });

    it('a read that outlived a long turn does not shorten the idle floor for the wait that follows', async () => {
      // aisdk shape: the watcher's read started at turn start; the turn ended
      // 14 minutes later; the runner then waits. That read's idle floor is a
      // minute from firing — and must NOT be honoured as "the host is gone",
      // or every long turn leaves a runner that exits before the reaper would.
      const floor = deferred();
      const real = deferred();
      gatedInbox([
        async () => userMsg('long task', 'req-1'),
        async () => {
          await floor.promise;
          return { type: 'idle-timeout' };
        },
        async () => {
          await real.promise;
          return userMsg('after', 'req-2');
        },
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          await ctx.endTurn(closeInput);
          const pull = ctx.nextMessage(); // waiting now, on a read that predates the wait
          floor.resolve();
          await flush();
          real.resolve();
          expect(await pull).not.toBeNull();
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    });

    it('a late interrupt for a finished turn does not stop the NEXT turn', async () => {
      const late = deferred();
      gatedInbox([
        async () => userMsg('first', 'req-1'),
        async () => {
          await late.promise;
          return { type: 'interrupt', cursor: 2 };
        },
        async () => userMsg('second', 'req-2'),
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          await ctx.endTurn(closeInput); // turn one is over ...
          late.resolve(); // ... and THEN the Stop press lands
          expect(await ctx.nextMessage()).not.toBeNull(); // turn two starts
          const fired = vi.fn();
          ctx.onInterrupt(fired);
          await flush();
          expect(fired).not.toHaveBeenCalled();
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    });

    it('reads ahead during a turn without losing or reordering what it buffers', async () => {
      const next = gatedInbox([
        async () => userMsg('one', 'req-1'),
        async () => userMsg('two', 'req-2'),
        async () => ({ type: 'cancel', cursor: 3 }),
      ]);
      const seen: string[] = [];
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          const a = await ctx.nextMessage();
          seen.push(String(a?.content));
          await flush(); // the shell has already pulled `two` and `cancel` off the wire
          await ctx.endTurn(closeInput);
          const b = await ctx.nextMessage();
          seen.push(String(b?.content));
          const c = await ctx.nextMessage();
          seen.push(String(c));
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      expect(seen).toEqual(['one', 'two', 'null']);
      // Not re-polled past the cancel: nothing after it is deliverable.
      expect(next).toHaveBeenCalledTimes(3);
    });

    it('does not mistake a long turn for an idle runner (idle-timeout with nobody waiting is discarded)', async () => {
      gatedInbox([
        async () => userMsg('long task', 'req-1'),
        async () => ({ type: 'idle-timeout' }), // the watcher's read hit its 15-minute floor
        async () => userMsg('after', 'req-2'),
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          await flush();
          await ctx.endTurn(closeInput);
          // null here would mean the runner exits right after every turn that
          // outlived the idle floor, and the person's next message cold-starts.
          expect(await ctx.nextMessage()).not.toBeNull();
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    });

    it('still honours a real idle-timeout when the runner is waiting', async () => {
      gatedInbox([async () => ({ type: 'idle-timeout' }), () => new Promise(() => {})]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          expect(await ctx.nextMessage()).toBeNull();
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    }, 2000);

    it('surfaces a terminal inbox error at the next pull, not as an unhandled rejection mid-turn', async () => {
      gatedInbox([
        async () => userMsg('go', 'req-1'),
        async () => {
          throw new Error('session gone');
        },
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          await flush(); // the watcher's read fails while the turn is running
          await ctx.endTurn(closeInput);
          await ctx.nextMessage(); // ... and the loop learns of it here
          return 0;
        }),
      };
      // A loop that throws is an abnormal end (exit 1) — exactly what an inbox
      // error was before the shell read ahead.
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(1);
    });

    it('a handler that throws does not take the runner down or block the others', async () => {
      gatedInbox([
        async () => userMsg('go', 'req-1'),
        async () => ({ type: 'interrupt', cursor: 2 }),
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          const good = vi.fn();
          ctx.onInterrupt(() => {
            throw new Error('handler blew up');
          });
          ctx.onInterrupt(good);
          await flush();
          expect(good).toHaveBeenCalledTimes(1);
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
    });
  });

  // ---- ctx.replaceTranscript (design §5 / §7 rung 3) --------------------
  //
  // The shell's only "the loop rewrote its own transcript" path. It exists
  // because compaction's summarize rung shortens the message list on purpose,
  // and the delta protocol's `resync-required` fallback is for rewrites nobody
  // announced.
  describe('replaceTranscript', () => {
    /** A client whose session HAS a conversation, plus a source with bytes. */
    function conversationalRun(source: TranscriptSource) {
      const original = fakeClient.call.getMockImplementation()!;
      fakeClient.call.mockImplementation(async (action: string, ...rest: unknown[]) => {
        if (action === 'session.get-config') {
          const cfg = (await original(action, ...rest)) as Record<string, unknown>;
          return { ...cfg, conversationId: 'conv-1' };
        }
        if (action === 'conversation.store-runner-session') return {};
        return original(action, ...rest);
      });
      return {
        ...seams(fakeEnv),
        createTranscriptSource: () => source,
      } satisfies RunnerSeams;
    }

    it('replaces the host copy with the source bytes, then ships only the delta after that', async () => {
      const callBinaryUpload = vi.fn(async (action: string) =>
        action === 'session.replace-transcript'
          ? { maxSeq: 2 }
          : { outcome: 'appended', maxSeq: 3 },
      );
      (fakeClient as unknown as { callBinaryUpload: unknown }).callBinaryUpload =
        callBinaryUpload;

      // Shrinks on `replace`, then grows by one line — a compacted turn.
      let body = 'header\nsummary\n';
      const source: TranscriptSource = {
        read: vi.fn(async () => Buffer.from(body, 'utf8')),
        write: vi.fn().mockResolvedValue('accepted'),
      };

      const loop: Loop = {
        run: vi.fn(async (ctx) => {
          ctx.setTranscriptSessionId('sess-x');
          await ctx.replaceTranscript();
          body += 'reply\n';
          await ctx.endTurn({
            contentBlocks: [],
            toolResultBlocks: [],
            readTurnId: async () => undefined,
            usage: null,
          });
          return 0;
        }),
      };

      expect(await runRunner(() => loop, conversationalRun(source))).toBe(0);

      const actions = callBinaryUpload.mock.calls.map((c) => c[0]);
      expect(actions[0]).toBe('session.replace-transcript');
      expect((callBinaryUpload.mock.calls[0]![1] as Buffer).toString('utf8')).toBe(
        'header\nsummary\n',
      );
      // The state advanced, so the following turn ships a DELTA — only the new
      // line — and its prefix hash is over the REPLACED bytes. If replace had
      // not reset the state, this would have re-shipped everything.
      const append = callBinaryUpload.mock.calls.find(
        (c) => c[0] === 'session.append-transcript',
      )!;
      expect((append[1] as Buffer).toString('utf8')).toBe('reply\n');
      expect((append[2] as { fromSeq: string }).fromSeq).toBe('2');
    });

    it('does not fail the turn when the replace call errors', async () => {
      // Best-effort by contract: the next delta's prefix hash cannot match, so
      // the existing resync path re-ships the whole thing anyway. Ending the
      // turn over a bookkeeping call with its own fallback would be the wrong
      // trade.
      (fakeClient as unknown as { callBinaryUpload: unknown }).callBinaryUpload = vi.fn(
        async (action: string) => {
          if (action === 'session.replace-transcript') throw new Error('host is down');
          return { outcome: 'appended', maxSeq: 1 };
        },
      );
      const source: TranscriptSource = {
        read: vi.fn(async () => Buffer.from('header\nsummary\n', 'utf8')),
        write: vi.fn().mockResolvedValue('accepted'),
      };
      const loop: Loop = {
        run: vi.fn(async (ctx) => {
          ctx.setTranscriptSessionId('sess-x');
          await ctx.replaceTranscript();
          return 0;
        }),
      };

      expect(await runRunner(() => loop, conversationalRun(source))).toBe(0);
    });

    it('is a noop on a session with no conversation', async () => {
      // Nothing to replace: a non-conversation session has no host transcript.
      const callBinaryUpload = vi.fn();
      (fakeClient as unknown as { callBinaryUpload: unknown }).callBinaryUpload =
        callBinaryUpload;
      const loop: Loop = {
        run: vi.fn(async (ctx) => {
          ctx.setTranscriptSessionId('sess-x');
          await ctx.replaceTranscript();
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      expect(callBinaryUpload).not.toHaveBeenCalled();
    });
  });

  // TASK-692 (per-user spend limits). `usage` is a REQUIRED field of
  // `EndTurnInput`, so a loop cannot close a turn without saying what it cost.
  // The shell forwards it on the ASSISTANT turn-end only: the role='tool' one
  // is the same turn's tool results, and metering it too would double-charge.
  describe('turn usage (TASK-692)', () => {
    const usage = {
      model: 'anthropic/claude-sonnet-4-6',
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 9000,
      cacheWriteTokens: 500,
    };

    /** Run one turn that closes with `usage`, return the turn-end payloads by role. */
    async function turnEnds(
      usageArg: unknown,
      opts: { toolResults?: boolean } = {},
    ): Promise<{ tool?: Record<string, unknown>; assistant?: Record<string, unknown> }> {
      fakeClient.event.mockClear();
      scriptInbox([
        { type: 'user-message', payload: { role: 'user', content: 'hi' }, reqId: 'req-u', cursor: 1 },
      ]);
      const loop: Loop = {
        run: vi.fn(async (ctx: LoopContext) => {
          await ctx.nextMessage();
          await ctx.endTurn({
            contentBlocks: [{ type: 'text', text: 'done' }],
            toolResultBlocks:
              opts.toolResults === true
                ? [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]
                : [],
            readTurnId: async () => undefined,
            usage: usageArg,
          } as unknown as Parameters<LoopContext['endTurn']>[0]);
          return 0;
        }),
      };
      expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      const out: { tool?: Record<string, unknown>; assistant?: Record<string, unknown> } = {};
      for (const c of fakeClient.event.mock.calls) {
        if (c[0] !== 'event.turn-end') continue;
        const p = c[1] as Record<string, unknown>;
        if (p.role === 'tool') out.tool = p;
        if (p.role === 'assistant') out.assistant = p;
      }
      return out;
    }

    it('rides the assistant turn-end and NOT the role=tool one', async () => {
      const { tool, assistant } = await turnEnds(usage, { toolResults: true });
      expect(tool).toBeDefined();
      expect(tool).not.toHaveProperty('usage');
      expect(assistant?.usage).toEqual(usage);
    });

    it('sends no usage key at all when the loop reports null (host charges its flat assumption)', async () => {
      const { assistant } = await turnEnds(null);
      expect(assistant).toBeDefined();
      expect(assistant).not.toHaveProperty('usage');
    });

    it('treats an omitted usage (an untyped/legacy caller) like null instead of crashing', async () => {
      const { assistant } = await turnEnds(undefined);
      expect(assistant).toBeDefined();
      expect(assistant).not.toHaveProperty('usage');
    });

    it('normalizes garbage numbers: NaN/Infinity -> 0, negatives -> 0, fractions rounded, clamped to 1e9', async () => {
      const { assistant } = await turnEnds({
        model: 'anthropic/claude-sonnet-4-6',
        inputTokens: Number.NaN,
        outputTokens: -5,
        cacheReadTokens: 1.6,
        cacheWriteTokens: 5_000_000_000,
      });
      expect(assistant?.usage).toEqual({
        model: 'anthropic/claude-sonnet-4-6',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 2,
        cacheWriteTokens: 1_000_000_000,
      });
      const { assistant: inf } = await turnEnds({
        ...usage,
        inputTokens: Number.POSITIVE_INFINITY,
        outputTokens: '12' as unknown as number,
      });
      // A non-finite (or non-number) count is unreadable, not "huge": 0.
      expect((inf?.usage as { inputTokens: number }).inputTokens).toBe(0);
      expect((inf?.usage as { outputTokens: number }).outputTokens).toBe(0);
    });

    it('drops the usage field entirely when the model is empty, missing, or too long for the wire', async () => {
      for (const model of ['', undefined, 'm'.repeat(201)]) {
        const { assistant } = await turnEnds({ ...usage, model });
        expect(assistant).toBeDefined();
        expect(assistant).not.toHaveProperty('usage');
      }
    });

    it('every normalized value passes the wire schema the host validates against', async () => {
      const { EventTurnEndSchema } = await import('@ax/ipc-protocol');
      const { assistant } = await turnEnds({
        model: 'openrouter/anthropic/claude-opus-4-5',
        inputTokens: -1,
        outputTokens: 7.4,
        cacheReadTokens: Number.NaN,
        cacheWriteTokens: 9e15,
      });
      expect(EventTurnEndSchema.safeParse(assistant).success).toBe(true);
    });
  });
});

// TASK-995: the git workspace tier is gone. A runner boots, runs turns and
// ends its chat without materializing, committing or bundling anything, and
// without the save-refused pipeline that hung off those saves. What remains at
// a turn boundary is the transcript ship (the DB is its source of truth).
describe('runRunner — no workspace tier (TASK-995)', () => {
  /** Every IPC action the runner sends, in order, whatever the channel. */
  let actions: string[];
  let transcriptBytes: Buffer;
  let uploads: Array<{ action: string; query: unknown }>;
  const source: TranscriptSource = {
    read: vi.fn(async () => transcriptBytes),
    write: vi.fn(async () => 'accepted' as const),
  };

  beforeEach(() => {
    actions = [];
    uploads = [];
    transcriptBytes = Buffer.from('{"type":"user"}\n{"type":"assistant"}\n', 'utf8');
    vi.mocked(source.read).mockReset().mockImplementation(async () => transcriptBytes);
    vi.mocked(source.write).mockReset().mockImplementation(async () => 'accepted');
    const call = fakeClient.call.getMockImplementation()!;
    fakeClient.call.mockImplementation(async (action: string, ...args: unknown[]) => {
      actions.push(action);
      if (action === 'session.get-config') return { ...(await call(action, ...args)), conversationId: 'c1' };
      if (action === 'conversation.store-runner-session') return {};
      return call(action, ...args);
    });
    const binary = fakeClient.callBinary.getMockImplementation()!;
    fakeClient.callBinary.mockImplementation(async (action: string, ...args: unknown[]) => {
      actions.push(action);
      return binary(action, ...args);
    });
    (fakeClient as unknown as { callBinaryUpload: unknown }).callBinaryUpload = vi.fn(
      async (action: string, _body: Buffer, query: unknown) => {
        actions.push(action);
        uploads.push({ action, query });
        if (action === 'session.append-transcript') return { outcome: 'appended', maxSeq: 2 };
        throw new Error(`unexpected upload: ${action}`);
      },
    );
    const event = fakeClient.event.getMockImplementation();
    fakeClient.event.mockImplementation(async (action: string, ...args: unknown[]) => {
      actions.push(action);
      return event?.(action, ...args);
    });
  });

  /** One conversation-bound turn with tool results, then the inbox cancels. */
  async function oneTurn(end: Partial<EndTurnInput> = {}): Promise<number> {
    scriptInbox([
      { type: 'user-message', payload: { role: 'user', content: 'write the report' }, reqId: 'req-1', cursor: 1 },
    ]);
    const loop: Loop = {
      run: vi.fn(async (ctx: LoopContext) => {
        await ctx.nextMessage();
        ctx.setTranscriptSessionId('sess-x');
        await ctx.endTurn({
          contentBlocks: [{ type: 'text', text: 'done' }],
          toolResultBlocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
          readTurnId: async () => undefined,
          usage: null,
          ...end,
        });
        return (await ctx.nextMessage()) === null ? 0 : 1;
      }),
    };
    return runRunner(() => loop, { ...seams(fakeEnv), createTranscriptSource: () => source });
  }

  it('boots, runs a turn and ends the chat without any workspace.* or drain-save-refusals call', async () => {
    expect(await oneTurn()).toBe(0);
    expect(actions.filter((a) => a.startsWith('workspace.'))).toEqual([]);
    expect(actions).not.toContain('conversation.drain-save-refusals');
    // Not vacuous: the run went the whole way — boot, the uploads copy, the
    // transcript ship and the bind, both turn-ends, the final ship and the one
    // chat-end.
    expect(actions).toEqual([
      'session.get-config',
      'attachments.list',
      'tool.list',
      'session.append-transcript',
      'conversation.store-runner-session',
      'event.turn-end',
      'event.turn-end',
      'session.append-transcript',
      'event.chat-end',
    ]);
  });

  it('turn-end and chat-end events carry no saveRefused', async () => {
    expect(await oneTurn()).toBe(0);
    const payloads = fakeClient.event.mock.calls
      .filter((c) => c[0] === 'event.turn-end' || c[0] === 'event.chat-end')
      .map((c) => c[1] as Record<string, unknown>);
    expect(payloads.map((p) => p.role ?? 'chat-end')).toEqual(['tool', 'assistant', 'chat-end']);
    for (const p of payloads) expect(p).not.toHaveProperty('saveRefused');
  });

  it('hands the loop each message as the person wrote it, with no notice prepended', async () => {
    scriptInbox([
      { type: 'user-message', payload: { role: 'user', content: 'first' }, reqId: 'req-1', cursor: 1 },
      { type: 'user-message', payload: { role: 'user', content: 'second' }, reqId: 'req-2', cursor: 2 },
    ]);
    const seen: unknown[] = [];
    const loop: Loop = {
      run: vi.fn(async (ctx: LoopContext) => {
        for (;;) {
          const msg = await ctx.nextMessage();
          if (msg === null) return 0;
          seen.push(msg.content);
          await ctx.endTurn({ contentBlocks: [], toolResultBlocks: [], readTurnId: async () => undefined, usage: null });
        }
      }),
    };
    expect(await runRunner(() => loop, { ...seams(fakeEnv), createTranscriptSource: () => source })).toBe(0);
    expect(seen).toEqual(['first', 'second']);
  });

  it('runs beforeTranscriptShip before the turn ships its transcript', async () => {
    const order: string[] = [];
    vi.mocked(source.read).mockImplementation(async () => {
      order.push('read');
      return transcriptBytes;
    });
    expect(
      await oneTurn({
        beforeTranscriptShip: async () => {
          order.push('beforeTranscriptShip');
        },
      }),
    ).toBe(0);
    // The turn's own ship reads after the wait; the final ship reads again.
    expect(order).toEqual(['beforeTranscriptShip', 'read', 'read']);
    expect(uploads[0]).toMatchObject({ action: 'session.append-transcript', query: { fromSeq: '0' } });
  });

  it('a 4xx from the bind still terminates the run (the loser of a bind race stops)', async () => {
    const call = fakeClient.call.getMockImplementation()!;
    fakeClient.call.mockImplementation(async (action: string, ...args: unknown[]) => {
      if (action === 'conversation.store-runner-session') {
        throw new IpcRequestError('HOOK_REJECTED', 409, 'bound to another session');
      }
      return call(action, ...args);
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await oneTurn()).toBe(1);
    } finally {
      stderr.mockRestore();
    }
    expect(actions).not.toContain('event.turn-end');
    const chatEnd = fakeClient.event.mock.calls.find((c) => c[0] === 'event.chat-end')!;
    expect(chatEnd[1]).toMatchObject({ outcome: { kind: 'terminated' } });
  });

  // `prepareSession` is where a loop lays down what it needs before it starts —
  // the claude-sdk loop links the SDK's projects dir to the transcripts root.
  // It must run before the resume restore writes the rebuilt transcript there
  // (#1085), and a failure is fatal before the loop exists.
  describe('prepareSession', () => {
    function resumable(): void {
      const call = fakeClient.call.getMockImplementation()!;
      fakeClient.call.mockImplementation(async (action: string, ...args: unknown[]) => {
        const out = await call(action, ...args);
        return action === 'session.get-config' ? { ...(out as object), runnerSessionId: 'sess-old' } : out;
      });
      const binary = fakeClient.callBinary.getMockImplementation()!;
      fakeClient.callBinary.mockImplementation(async (action: string, ...args: unknown[]) => {
        if (action !== 'session.get-transcript') return binary(action, ...args);
        actions.push(action);
        const tmp = path.join(SANDBOX, `restore-${Math.random().toString(16).slice(2)}.jsonl`);
        await fs.writeFile(tmp, transcriptBytes);
        return { path: tmp, bytes: transcriptBytes.length };
      });
    }

    it('runs before the resume restore writes the transcript', async () => {
      resumable();
      const order: string[] = [];
      const prepareSession = vi.fn(async () => {
        order.push('prepareSession');
      });
      vi.mocked(source.write).mockImplementation(async () => {
        order.push('restore');
        return 'accepted';
      });
      const makeLoop = vi.fn((_deps: RunnerDeps) => ({ run: async () => 0 }));
      expect(
        await runRunner(makeLoop, {
          ...seams(fakeEnv),
          createTranscriptSource: () => source,
          prepareSession,
        }),
      ).toBe(0);
      expect(prepareSession).toHaveBeenCalledOnce();
      expect(prepareSession).toHaveBeenCalledWith(
        expect.objectContaining({ userFilesRoot: HOME, ephemeralRoot: SCRATCH }),
      );
      expect(order).toEqual(['prepareSession', 'restore']);
      expect(actions).toContain('session.get-transcript');
      expect(makeLoop.mock.calls[0]![0].resumeSessionId).toBe('sess-old');
    });

    it('a prepareSession failure exits 2 before the resume restore', async () => {
      resumable();
      const prepareSession = vi.fn().mockRejectedValue(new Error('cannot link the transcripts dir'));
      const makeLoop = vi.fn();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      let code = -1;
      try {
        code = await runRunner(makeLoop, {
          ...seams(fakeEnv),
          createTranscriptSource: () => source,
          prepareSession,
        });
        expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('cannot link the transcripts dir');
      } finally {
        stderr.mockRestore();
      }
      expect(code).toBe(2);
      expect(prepareSession).toHaveBeenCalledOnce();
      expect(actions).not.toContain('session.get-transcript');
      expect(source.write).not.toHaveBeenCalled();
      expect(makeLoop).not.toHaveBeenCalled();
      // Bootstrap-fatal: the client is closed and no chat-end is sent (the
      // orchestrator synthesizes the terminated outcome from exit 2).
      expect(fakeClient.close).toHaveBeenCalledOnce();
      expect(actions).not.toContain('event.chat-end');
    });
  });
});

describe('runRunner — disallowedTools catalog filter', () => {
  it('drops a tool named in agentConfig.disallowedTools from the catalog the loop sees', async () => {
    const original = fakeClient.call.getMockImplementation()!;
    fakeClient.call.mockImplementation(async (action: string, ...args: unknown[]) => {
      if (action === 'session.get-config') {
        const cfg = (await original(action, ...args)) as { agentConfig: Record<string, unknown> };
        return { ...cfg, agentConfig: { ...cfg.agentConfig, disallowedTools: ['web_search'] } };
      }
      if (action === 'tool.list') {
        return {
          tools: [
            { name: 'web_search', executesIn: 'host', inputSchema: {} },
            { name: 'web_extract', executesIn: 'host', inputSchema: {} },
          ],
        };
      }
      return original(action, ...args);
    });
    const makeLoop = vi.fn((_deps: RunnerDeps) => ({ run: async () => 0 }));
    expect(await runRunner(makeLoop, seams(fakeEnv))).toBe(0);
    expect(makeLoop.mock.calls[0]?.[0].tools.map((t) => t.name)).toEqual(['web_extract']);
  });

  it('absent disallowedTools keeps the whole catalog', async () => {
    const original = fakeClient.call.getMockImplementation()!;
    fakeClient.call.mockImplementation(async (action: string, ...args: unknown[]) => {
      if (action === 'tool.list') {
        return { tools: [{ name: 'web_search', executesIn: 'host', inputSchema: {} }] };
      }
      return original(action, ...args);
    });
    const makeLoop = vi.fn((_deps: RunnerDeps) => ({ run: async () => 0 }));
    expect(await runRunner(makeLoop, seams(fakeEnv))).toBe(0);
    expect(makeLoop.mock.calls[0]?.[0].tools.map((t) => t.name)).toEqual(['web_search']);
  });
});


describe('routine prompt availability from filtered catalog', () => {
  it.each(['claude-sdk', 'aisdk'])('uses filtered tools for %s', async runner => {
    const original = fakeClient.call.getMockImplementation()!;
    const { buildSystemPrompt } = await import('../prompt-engine.js');
    for (const [allowedTools, disallowedTools, expected] of [
      [[], [], true], [['web_search'], [], false], [[], ['routine_get'], false],
    ] as const) {
      fakeClient.call.mockImplementation(async (action: string, input: unknown) => {
        if (action === 'tool.list') return { tools: [{ name: 'routine_get', executesIn: 'host', inputSchema: {} }, { name: 'web_search', executesIn: 'host', inputSchema: {} }] };
        const result = await original(action, input) as Record<string, unknown>;
        if (action === 'session.get-config') return { ...result, agentConfig: { ...result.agentConfig as object, runner, allowedTools, disallowedTools } };
        return result;
      });
      expect(await runRunner(() => ({ run: async () => 0 }), seams(fakeEnv))).toBe(0);
      expect(vi.mocked(buildSystemPrompt).mock.calls.at(-1)?.[7]).toBe(expected);
    }
  });
});

describe('identity prompt inputs (TASK-989)', () => {
  const IDENTITY = { identity: 'I am Pip', soul: 'Kind', instructions: 'Be brief', bootstrapMode: false };
  // The top-level beforeEach has just rebuilt fakeClient; wrap THAT implementation
  // on every call, so overrides from one case never leak into the next.
  let base: (action: string, input: unknown) => Promise<unknown>;
  beforeEach(() => {
    base = fakeClient.call.getMockImplementation()! as typeof base;
  });

  /** Boot the shell with these agentConfig overrides and this host catalog; return
   *  the arguments it handed the prompt engine. */
  async function promptArgs(agentConfig: Record<string, unknown>, catalog: string[]): Promise<unknown[]> {
    fakeClient.call.mockImplementation(async (action: string, input: unknown) => {
      if (action === 'tool.list') {
        return { tools: catalog.map((name) => ({ name, executesIn: 'host', inputSchema: {} })) };
      }
      const result = (await base(action, input)) as Record<string, unknown>;
      if (action === 'session.get-config') {
        return { ...result, agentConfig: { ...(result.agentConfig as object), ...agentConfig } };
      }
      return result;
    });
    const { buildSystemPrompt } = await import('../prompt-engine.js');
    const mock = vi.mocked(buildSystemPrompt);
    mock.mockClear();
    expect(await runRunner(() => ({ run: async () => 0 }), seams(fakeEnv))).toBe(0);
    expect(mock).toHaveBeenCalledOnce();
    return mock.mock.calls[0]!;
  }

  it('hands the session config identity to the prompt engine as it arrived', async () => {
    const args = await promptArgs({ identity: IDENTITY }, []);
    expect(args[8]).toEqual(IDENTITY);
  });

  it('passes no identity when the session config has none, so the engine default applies', async () => {
    const args = await promptArgs({}, []);
    expect(args).toHaveLength(10);
    expect(args[8]).toBeUndefined();
  });

  it('says update_identity is available only when it survived the catalog filters', async () => {
    const catalog = ['update_identity', 'web_search'];
    expect((await promptArgs({ allowedTools: [] }, catalog))[9]).toBe(true);
    expect((await promptArgs({ allowedTools: ['web_search'] }, catalog))[9]).toBe(false);
    expect((await promptArgs({ disallowedTools: ['update_identity'] }, catalog))[9]).toBe(false);
    expect((await promptArgs({}, ['web_search']))[9]).toBe(false);
  });
});
