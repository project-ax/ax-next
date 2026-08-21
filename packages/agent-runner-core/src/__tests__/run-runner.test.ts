import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import type { IpcClient, IpcClientOptions } from '@ax/ipc-protocol';
import type { RunnerEnv } from '../env.js';
import type { Loop, RunnerSeams, TranscriptSource } from '../index.js';

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
