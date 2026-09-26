import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import type { IpcClient, IpcClientOptions } from '@ax/ipc-protocol';
import type { RunnerEnv } from '../env.js';
import type { Loop, LoopContext, RunnerSeams, TranscriptSource } from '../index.js';

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
  };
});

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
});
