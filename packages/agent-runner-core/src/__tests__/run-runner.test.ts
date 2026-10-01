import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import type { IpcClient, IpcClientOptions } from '@ax/ipc-protocol';
import type { RunnerEnv } from '../env.js';
import type { Loop, LoopContext, RunnerDeps, RunnerSeams, TranscriptSource } from '../index.js';
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
// Everything the boot sequence touches on the way to the loop (git, the proxy
// bridge, the skills projection, the prompt engine, the IPC socket) is mocked
// out — those modules have their own suites; this one is about the shell.
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
// git-workspace.js is imported both by the shell and (internally) by
// commit-notify-resync.ts — one mock at the module covers both call sites.
vi.mock('../git-workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-workspace.js')>();
  return {
    ...actual,
    materializeWorkspace: vi.fn().mockResolvedValue({ baselineCommit: 'oid-0' }),
    scaffoldWorkspaceGitignore: vi.fn().mockResolvedValue(undefined),
    scaffoldSdkProjectsSymlink: vi.fn().mockResolvedValue(undefined),
    commitTurnAndBundle: vi.fn().mockResolvedValue(null),
    // Only reached when a test hands commitTurnAndBundle a bundle (the
    // TASK-720 save-refusal cases); there is no real repo at /tmp/workspace.
    advanceBaseline: vi.fn().mockResolvedValue(undefined),
    rollbackToBaseline: vi.fn().mockResolvedValue(undefined),
  };
});

const { runRunner } = await import('../run-runner.js');
const { commitTurnAndBundle } = await import('../git-workspace.js');
const { createInboxLoop } = await import('../inbox-loop.js');

/** Drive the shell's message pump with a scripted inbox. */
function scriptInbox(entries: unknown[]): void {
  const queue = [...entries];
  (createInboxLoop as unknown as Mock).mockReturnValueOnce({
    next: vi.fn(async () => queue.shift() ?? { type: 'cancel' }),
    cursor: 0,
  });
}

/** The minimal shape readRunnerEnv produces (see env.ts). */
function fakeEnv(): RunnerEnv {
  return {
    runnerEndpoint: 'unix:///tmp/ax.sock',
    sessionId: 'sess-1',
    authToken: 'tok-123',
    workspaceRoot: '/tmp/workspace',
    proxyEndpoint: 'http://127.0.0.1:8443',
  };
}

const transcriptSource: TranscriptSource = {
  read: vi.fn().mockResolvedValue(null),
  write: vi.fn().mockResolvedValue('accepted'),
};

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
      throw new Error(`unexpected call: ${action}`);
    }),
    callGet: vi.fn(),
    callBinary: vi.fn().mockResolvedValue({ path: '/tmp/fake.bundle', bytes: 0 }),
    event: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as FakeClient;
});

describe('runRunner — generated file publication', () => {
  it.each([
    ['durable', 'allow'], ['durable', 'reject'], ['durable', 'hold'],
    ['scratch', 'allow'], ['scratch', 'reject'], ['scratch', 'hold'],
  ] as const)('uses the policy gate (%s, %s) and persists chips before SSE completion', async (tier, verdict) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-files-shell-'));
    const original = fakeClient.call.getMockImplementation()!;
    fakeClient.call.mockImplementation(async (action: string, ...args: unknown[]) => {
      if (action === 'session.get-config') return { ...await original(action, ...args), conversationId: 'c1' };
      if (action === 'tool.list') return { tools: [{ name: 'artifact_publish', executesIn: 'sandbox', inputSchema: {} }] };
      if (action === 'tool.pre-call') return verdict === 'allow' ? { verdict: 'allow' }
        : verdict === 'reject' ? { verdict: 'reject', reason: 'blocked' }
          : { verdict: 'hold', decisionId: 'd1', note: 'approval required' };
      if (action === 'artifact.publish') return { artifactId: 'id', downloadUrl: 'ax://artifact/id' };
      if (action === 'attachments.list') return { files: [] };
      return original(action, ...args);
    });
    const upload = vi.fn(async () => ({ sha256: 'a'.repeat(64), size: 6 }));
    fakeClient.callBinaryUpload = upload;
    const loop: Loop = { run: async ctx => {
      await fs.writeFile(path.join(root, tier === 'scratch' ? 'artifacts/report.txt' : 'report.txt'), 'report');
      await ctx.endTurn({
        contentBlocks: [{ type: 'text', text: 'Here is your report.' }],
        toolResultBlocks: [], usage: null, readTurnId: async () => undefined,
      });
      return 0;
    } };
    try {
      expect(await runRunner(() => loop, seams(() => ({ ...fakeEnv(),
        ...(tier === 'scratch' ? { ephemeralRoot: root } : { userFilesRoot: root }),
      })))).toBe(0);
      const first = fakeClient.event.mock.calls.find(call => call[0] === 'event.turn-end')!;
      expect(first[1].role).toBe('tool');
      if (verdict === 'allow') {
        expect(upload).toHaveBeenCalledOnce();
        expect(first[1].contentBlocks).toContainEqual({ type: 'attachment', path: 'report.txt', displayName: 'report.txt', mediaType: 'text/plain', sizeBytes: 6 });
      } else {
        expect(upload).not.toHaveBeenCalled();
        expect(first[1].contentBlocks.some((block: { type: string }) => block.type === 'attachment')).toBe(false);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('runRunner — working directory', () => {
  it.each([
    [{ ephemeralRoot: '/tmp/scratch' }, '/tmp/scratch'],
    [{ ephemeralRoot: '/tmp/scratch', userFilesRoot: '/tmp/files' }, '/tmp/files'],
    [{}, '/tmp/workspace'],
  ] as const)('selects the supplied user-files or scratch tier while preserving agent state', async (roots, expected) => {
    const makeLoop = vi.fn((_deps: RunnerDeps) => ({ run: async () => 0 }));
    expect(await runRunner(makeLoop, seams(() => ({ ...fakeEnv(), ...roots })))).toBe(0);
    expect(makeLoop.mock.calls[0]?.[0]).toMatchObject({ homeDir: expected, env: { workspaceRoot: '/tmp/workspace' } });
    const { buildSystemPrompt } = await import('../prompt-engine.js');
    expect(vi.mocked(buildSystemPrompt).mock.calls.at(-1)?.[6]).toBe(expected);
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
    expect(args[8]).toBe('RULES');
  });

  it('a session frozen before TASK-524 (no field) means no bootstrap augment', async () => {
    configWith({});
    const args = await lastPromptArgs();
    expect(args[8]).toBe('');
  });
});

describe('runRunner — prompt working frame', () => {
  it('hands the prompt engine the durable mount as cwd, distinct from the governed root', async () => {
    // Bootstrap mode needs to know the two differ: its script says `rm
    // .ax/BOOTSTRAP.md`, which a Bash command resolves against cwd (/files),
    // not the governed root (/tmp/workspace), unless the prompt says otherwise.
    const { buildSystemPrompt } = await import('../prompt-engine.js');
    const mock = buildSystemPrompt as unknown as Mock;
    mock.mockClear();
    const loop: Loop = { run: vi.fn().mockResolvedValue(0) };
    const env = (): RunnerEnv => ({ ...fakeEnv(), userFilesRoot: '/files' });
    expect(await runRunner(() => loop, seams(env))).toBe(0);
    expect(mock).toHaveBeenCalledOnce();
    const args = mock.mock.calls[0]!;
    expect(args[2]).toBe('/tmp/workspace'); // workspaceRoot: where .ax/ lives
    expect(args[5]).toBe('/files'); //          userFilesRoot
    expect(args[6]).toBe('/files'); //          cwd
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

  // TASK-720. The end-of-turn save runs BEFORE this turn's `event.turn-end`,
  // so a refusal rides that turn-end as a closed `saveRefused` code — the only
  // way the person learns the files were taken back. Only a TERMINAL refusal
  // sets it; a save that landed, a host that could not be reached (the files
  // ride the next turn) and a recoverable race do not.
  describe('save refusal on turn-end (TASK-720)', () => {
    /** One turn whose save gets `answer` from the host; returns turn-ends by role. */
    async function turnWithSave(
      answer: () => Promise<unknown>,
      opts: { toolResults?: boolean } = {},
    ): Promise<{ tool?: Record<string, unknown>; assistant?: Record<string, unknown> }> {
      fakeClient.event.mockClear();
      (commitTurnAndBundle as unknown as Mock).mockResolvedValueOnce(Buffer.from('BUNDLE'));
      const upload = vi.fn(async (action: string) => {
        if (action === 'workspace.commit-bundle') return answer();
        throw new Error(`unexpected upload: ${action}`);
      });
      (fakeClient as unknown as { callBinaryUpload: unknown }).callBinaryUpload = upload;
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
            usage: null,
          });
          return 0;
        }),
      };
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
      } finally {
        stderr.mockRestore();
      }
      expect(upload).toHaveBeenCalledWith('workspace.commit-bundle', Buffer.from('BUNDLE'), {
        reason: 'turn',
        parentVersion: 'oid-0',
      });
      const out: { tool?: Record<string, unknown>; assistant?: Record<string, unknown> } = {};
      for (const c of fakeClient.event.mock.calls) {
        if (c[0] !== 'event.turn-end') continue;
        const p = c[1] as Record<string, unknown>;
        if (p.role === 'tool') out.tool = p;
        if (p.role === 'assistant') out.assistant = p;
      }
      return out;
    }

    it("a storage-full veto rides the assistant turn-end as 'storage-full'", async () => {
      const { assistant } = await turnWithSave(async () => ({
        accepted: false,
        reason: 'The workspace is full.',
        recoverable: false,
        code: 'storage-full',
      }));
      expect(assistant?.saveRefused).toBe('storage-full');
      const { EventTurnEndSchema } = await import('@ax/ipc-protocol');
      expect(EventTurnEndSchema.safeParse(assistant).success).toBe(true);
    });

    it("a host 413 (save too large) rides it as 'too-large'", async () => {
      const { IpcRequestError } = await import('@ax/ipc-protocol');
      const { assistant } = await turnWithSave(async () => {
        throw new IpcRequestError('PAYLOAD_TOO_LARGE', 413, 'body too large');
      });
      expect(assistant?.saveRefused).toBe('too-large');
    });

    it("any other terminal veto (no code, or an unknown one) rides it as 'refused'", async () => {
      for (const code of [undefined, 'something-new']) {
        const { assistant } = await turnWithSave(async () => ({
          accepted: false,
          reason: 'CLAUDE.md: SDK-config paths are host-only',
          recoverable: false,
          ...(code !== undefined ? { code } : {}),
        }));
        expect(assistant?.saveRefused).toBe('refused');
      }
    });

    it('BOTH turn-ends of the turn carry it, because the stream closes on the first', async () => {
      // A turn with tool results emits role='tool' and then role='assistant'
      // under the SAME reqId. channel-web's SSE `done` subscriber closes on the
      // FIRST one it sees and unsubscribes, so a code that rides only the
      // assistant turn-end is never written to the frame — and a turn a save
      // can be refused on is exactly a turn that used tools. Each side was
      // tested in isolation and passed while the seam lost the notice.
      const { tool, assistant } = await turnWithSave(
        async () => ({ accepted: false, reason: 'no', recoverable: false }),
        { toolResults: true },
      );
      expect(tool).toBeDefined();
      expect(tool?.saveRefused).toBe('refused');
      expect(assistant?.saveRefused).toBe('refused');
    });

    it('an accepted save, an unreachable host, and a recoverable race carry NO saveRefused key', async () => {
      const answers: Array<() => Promise<unknown>> = [
        async () => ({ accepted: true, version: 'v2', delta: null }),
        async () => {
          throw new Error('ECONNRESET');
        },
        async () => ({ accepted: false, reason: 'bundle prerequisite not satisfied (baseline drift)' }),
      ];
      for (const answer of answers) {
        const { assistant } = await turnWithSave(answer);
        expect(assistant).toBeDefined();
        expect('saveRefused' in assistant!).toBe(false);
      }
    });

    it('a refused FINAL (post-loop) save has no turn-end to ride, but is not silent in the logs', async () => {
      fakeClient.event.mockClear();
      (commitTurnAndBundle as unknown as Mock).mockResolvedValueOnce(Buffer.from('FINAL'));
      (fakeClient as unknown as { callBinaryUpload: unknown }).callBinaryUpload = vi.fn(
        async () => ({ accepted: false, reason: 'The workspace is full.', recoverable: false, code: 'storage-full' }),
      );
      const loop: Loop = { run: vi.fn().mockResolvedValue(0) };
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(await runRunner(() => loop, seams(fakeEnv))).toBe(0);
        const text = stderr.mock.calls.map((c) => String(c[0])).join('');
        expect(text).toMatch(/final save refused \(storage-full\)/);
      } finally {
        stderr.mockRestore();
      }
      expect(fakeClient.event.mock.calls.some((c) => c[0] === 'event.turn-end')).toBe(false);
    });
  });
});
