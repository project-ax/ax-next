// ---------------------------------------------------------------------------
// TASK-720 repro: a workspace save bigger than the JSON frame is never accepted.
//
// THE BUG. The runner's end-of-turn save is `commitTurnAndBundle` (a thin git
// bundle of `baseline..main`) handed to `commitNotifyWithResync`, which posts it
// as base64 inside the JSON action `workspace.commit-notify`. The host reads a
// JSON body under MAX_FRAME (4 MiB), so about 3 MiB of compressed objects is the
// most one save can carry. Over that the host answers 413 (or the socket resets
// and the client retries for up to two minutes) and `commitNotifyWithResync`
// swallows every throw as `kept`. `refs/heads/baseline` never moves, so every
// LATER bundle (`baseline..main`) still carries the big blob and is refused the
// same way. Nothing is saved for that agent again, and nobody is told.
//
// WHAT THIS PINS. The real path, end to end, in one process:
//
//   runner git repo (materialized from the host, the way the runner does it)
//     -> commitTurnAndBundle -> commitNotifyWithResync
//     -> real createIpcClient  --HTTP over a unix socket-->  real createListener
//     -> real dispatch (the 4 MiB body gate lives here)
//     -> real workspace-git-core backend on a HookBus
//
// A 5 MiB file of random (incompressible) bytes is the smallest realistic save
// that cannot fit. RED on main: the outcome is `kept` (see the stderr line the
// runner writes, quoted in the assertion message). GREEN once the bundle rides
// the binary `workspace.commit-bundle` action (raw octet-stream body, up to the
// host's 100 MiB budget) instead of the JSON frame.
//
// Not a unit test of a handler: the 4 MiB gate is in the transport, so a test
// that calls `workspaceCommitNotifyHandler` directly (as the sibling
// workspace-commit-notify.test.ts does with its 5 MiB bundle) cannot see it.
//
// NOTE FOR WHOEVER CHANGES THE WIRE. Everything crossing a package boundary here
// resolves through that package's built `dist/` (`@ax/ipc-server` runs
// `@ax/ipc-core`'s built dispatcher; `@ax/agent-runner-core` and
// `@ax/ipc-protocol` are the runner side). After editing any of them, run
// `pnpm build` before this test, or it exercises the old code.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_FRAME,
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type Plugin,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
import { createIpcClient, type IpcClient } from '@ax/ipc-protocol';
import {
  commitNotifyWithResync,
  commitTurnAndBundle,
  materializeWorkspace,
  type CommitNotifyResult,
} from '@ax/agent-runner-core';
import { createListener, type Listener } from '@ax/ipc-server';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  AgentConfig,
  SessionCreateInput,
  SessionCreateOutput,
} from '@ax/session-inmemory';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { registerWorkspaceGitHooks } from '@ax/workspace-git-core';

const SESSION_ID = 'task-720-session';
const AGENT_ID = 'task-720-agent';
const USER_ID = 'task-720-user';

const AGENT_CONFIG: AgentConfig = {
  displayName: 'Task 720 Agent',
  systemPromptAugment: '',
  allowedTools: [],
  mcpConfigIds: [],
  model: 'anthropic/claude-sonnet-4-7',
  runner: 'claude-sdk',
};

// Big enough that no git compression can bring it under MAX_FRAME (random bytes
// do not compress), small enough that the whole file stays fast.
const BIG_FILE_BYTES = 5 * 1024 * 1024;

/**
 * The single-replica workspace backend, as a plugin shim (modeled on
 * workspace-commit-notify-core-resync.test.ts). `registers` must list every hook
 * `registerWorkspaceGitHooks` registers.
 */
function workspaceBackendPlugin(repoRoot: string): Plugin {
  return {
    manifest: {
      name: '@ax/workspace-git-core-task-720-shim',
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:apply-internal',
        'workspace:apply-bundle',
        'workspace:export-baseline-bundle',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      registerWorkspaceGitHooks(bus, { repoRoot });
    },
  };
}

interface Fixture {
  harness: TestHarness;
  bus: HookBus;
  ctx: AgentContext;
  /** What the runner uses to talk to the host. */
  client: IpcClient;
  /** The runner's /agent working tree. */
  root: string;
  /** refs/heads/baseline at materialize time = the first commit's parentVersion. */
  baselineCommit: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-task720-')));
  const repoRoot = path.join(tmp, 'repos');
  const socketDir = path.join(tmp, 'sock');
  const root = path.join(tmp, 'agent');
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(socketDir, { recursive: true });

  // Host: a real bus with a real workspace backend and the real session store
  // (auth), fronted by the real unix-socket listener + dispatcher.
  const harness = await createTestHarness({
    plugins: [createSessionInmemoryPlugin(), workspaceBackendPlugin(repoRoot)],
  });
  const { token } = await harness.bus.call<SessionCreateInput, SessionCreateOutput>(
    'session:create',
    harness.ctx(),
    {
      sessionId: SESSION_ID,
      workspaceRoot: root,
      owner: { userId: USER_ID, agentId: AGENT_ID, agentConfig: AGENT_CONFIG },
    },
  );
  const socketPath = path.join(socketDir, 'ipc.sock');
  const listener: Listener = await createListener({
    socketPath,
    sessionId: SESSION_ID,
    bus: harness.bus,
  });

  // Runner: the real IPC client. The retry budget is shortened so a RED run (the
  // write ECONNRESETs and the client keeps retrying) fails in seconds instead of
  // the production 2 minutes. It changes nothing about the wire.
  const client = createIpcClient({
    runnerEndpoint: `unix://${socketPath}`,
    token,
    maxElapsedMs: 3_000,
    retryBackoff: () => 50,
  });

  // Runner: materialize /agent from the host, exactly as session start does
  // (host streams the baseline bundle; the runner clones it and pins `baseline`).
  const materialized = await client.callBinary('workspace.materialize', {});
  const { baselineCommit } = await materializeWorkspace({
    root,
    bundlePath: materialized.path,
  });

  const ctx = makeAgentContext({
    sessionId: SESSION_ID,
    agentId: AGENT_ID,
    userId: USER_ID,
  });

  return {
    harness,
    bus: harness.bus,
    ctx,
    client,
    root,
    baselineCommit,
    cleanup: async () => {
      await client.close();
      await listener.close();
      await harness.close();
      // A background `git gc --auto` can still be writing into a repo dir when
      // the foreground git we awaited has exited; retry the rm.
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/**
 * One runner save: stage + commit + bundle, then hand it to the host with the
 * runner's own re-sync helper. Kept as ONE helper so a change to the shape of
 * the bundle handed between the two runner functions is a one-place edit.
 */
async function runnerSave(
  fx: Fixture,
  parentVersion: string | null,
  reason: string,
): Promise<{ result: CommitNotifyResult; bundleSize: number; runnerStderr: string }> {
  const bundle = await commitTurnAndBundle({ root: fx.root, reason });
  if (bundle === null) throw new Error('commitTurnAndBundle found nothing to ship');

  // Capture what the runner says on stderr (pass it through too) so a RED run
  // names the swallowed transport error in the assertion message, not just
  // "expected 'kept' to be 'accepted'".
  const lines: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (realWrite as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write);
  try {
    const result = await commitNotifyWithResync({
      client: fx.client,
      root: fx.root,
      bundleBytes: bundle,
      parentVersion,
      reason,
    });
    return { result, bundleSize: bundle.length, runnerStderr: lines.join('').trim() };
  } finally {
    spy.mockRestore();
  }
}

async function hostRead(
  fx: Fixture,
  file: string,
): Promise<WorkspaceReadOutput> {
  return fx.bus.call<WorkspaceReadInput, WorkspaceReadOutput>('workspace:read', fx.ctx, {
    path: file,
  });
}

describe('TASK-720: a workspace save bigger than the 4 MiB JSON frame', () => {
  let fx: Fixture;

  beforeEach(async () => {
    // The runner pod pins author/committer to `ax-runner` (and the host verifies
    // it) and locks git's config down; mirror that for the in-process runner.
    vi.stubEnv('GIT_AUTHOR_NAME', 'ax-runner');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'ax-runner@example.com');
    vi.stubEnv('GIT_COMMITTER_NAME', 'ax-runner');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'ax-runner@example.com');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    fx = await makeFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
    vi.unstubAllEnvs();
  });

  // CONTROL (green on main, and must stay green): the same harness, the same
  // wire, a save that fits. It is what makes the two red cases below mean "too
  // big" rather than "the harness is broken" -- if this one ever fails, fix the
  // harness before reading anything into the others.
  it('control: a small save goes through this harness and lands on the host', async () => {
    await fs.writeFile(path.join(fx.root, 'note.txt'), 'small enough\n');

    const { result, bundleSize, runnerStderr } = await runnerSave(
      fx,
      fx.baselineCommit,
      'turn 1: a small file',
    );

    expect(bundleSize).toBeLessThan(MAX_FRAME);
    expect(result.outcome, runnerStderr).toBe('accepted');
    expect(result.parentVersion).toMatch(/^[0-9a-f]{40}$/);
    const note = await hostRead(fx, 'note.txt');
    expect(note.found).toBe(true);
    if (note.found) {
      expect(Buffer.from(note.bytes).toString('utf8')).toBe('small enough\n');
    }
  });

  it('a 5 MiB save is accepted, advances the version, and the file lands on the host', async () => {
    const big = randomBytes(BIG_FILE_BYTES);
    await fs.mkdir(path.join(fx.root, 'data'), { recursive: true });
    await fs.writeFile(path.join(fx.root, 'data', 'big.bin'), big);

    const { result, bundleSize, runnerStderr } = await runnerSave(
      fx,
      fx.baselineCommit,
      'turn 1: a big file',
    );

    // Precondition: this save really is over the JSON frame. If this ever
    // fails the test has stopped exercising the bug (git got smarter, or the
    // frame grew) and needs a bigger file, not a weaker assertion.
    expect(bundleSize).toBeGreaterThan(MAX_FRAME);

    expect(
      result.outcome,
      `the host never took the save; the runner swallowed: ${runnerStderr || '(nothing on stderr)'}`,
    ).toBe('accepted');
    expect(result.parentVersion).toMatch(/^[0-9a-f]{40}$/);
    expect(result.parentVersion).not.toBe(fx.baselineCommit);

    const onHost = await hostRead(fx, 'data/big.bin');
    expect(onHost.found).toBe(true);
    if (onHost.found) {
      expect(Buffer.compare(Buffer.from(onHost.bytes), big)).toBe(0);
    }
  });

  it('a small save after an oversized one is accepted too (the baseline must not wedge)', async () => {
    const big = randomBytes(BIG_FILE_BYTES);
    await fs.mkdir(path.join(fx.root, 'data'), { recursive: true });
    await fs.writeFile(path.join(fx.root, 'data', 'big.bin'), big);
    const first = await runnerSave(fx, fx.baselineCommit, 'turn 1: a big file');

    // Whatever the first save did, the NEXT turn writes something tiny. On main
    // the first save was `kept`, so `baseline` never moved and this bundle is
    // `baseline..main` = the big blob again: refused again, forever.
    await fs.writeFile(path.join(fx.root, 'note.txt'), 'a tiny follow-up\n');
    const second = await runnerSave(fx, first.result.parentVersion, 'turn 2: a small file');

    expect(
      second.result.outcome,
      `a tiny save after a big one still did not go through (first save was '${first.result.outcome}'); the runner swallowed: ${second.runnerStderr || '(nothing on stderr)'}`,
    ).toBe('accepted');
    expect(second.result.parentVersion).toMatch(/^[0-9a-f]{40}$/);
    expect(second.result.parentVersion).not.toBe(first.result.parentVersion);

    const note = await hostRead(fx, 'note.txt');
    expect(note.found).toBe(true);
    if (note.found) {
      expect(Buffer.from(note.bytes).toString('utf8')).toBe('a tiny follow-up\n');
    }
  });
});
