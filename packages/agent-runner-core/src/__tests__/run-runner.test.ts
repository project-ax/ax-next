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
  setupProxy: vi.fn().mockResolvedValue({ anthropicEnv: {} }),
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
  locate: vi.fn().mockResolvedValue(null),
  write: vi.fn().mockResolvedValue(undefined),
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
            model: 'claude-sonnet-4-7',
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
            model: 'claude-sonnet-4-7',
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
});
