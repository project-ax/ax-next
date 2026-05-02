import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  reject,
  type AgentContext,
  type FileChange,
  type Plugin,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceDelta,
  type WorkspaceVersion,
} from '@ax/core';
import { createMockWorkspacePlugin } from '@ax/test-harness';
import { buildBaselineBundle } from '../workspace-materialize.js';
import { workspaceCommitNotifyHandler } from '../workspace-commit-notify.js';

// ---------------------------------------------------------------------------
// workspace.commit-notify handler — Phase 3 real implementation tests.
//
// Same harness shape as workspace-materialize.test.ts: real HookBus +
// MockWorkspace plugin (which registers workspace:apply,
// workspace:read, workspace:list, but NOT workspace:apply-bundle —
// so the handler exercises the FALLBACK FileChange[] path here). A
// separate test exercises the apply-bundle path by registering a
// mock workspace:apply-bundle service alongside MockWorkspace.
//
// Real bundles are constructed via simulateRunnerTurn (mirrors
// production runner shape): build deterministic baseline → clone →
// commit → bundle baseline..main + main.
// ---------------------------------------------------------------------------

interface Env {
  bus: HookBus;
  ctx: AgentContext;
}

async function makeEnv(extraPlugins: Plugin[] = []): Promise<Env> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [createMockWorkspacePlugin(), ...extraPlugins],
    config: {},
  });
  const ctx = makeAgentContext({
    sessionId: 'wcn-test',
    agentId: 'wcn-agent',
    userId: 'wcn-user',
  });
  return { bus, ctx };
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function git(
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd, env: env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Simulate the runner's turn-end shape end-to-end:
 *   1. Host's buildBaselineBundle produces the baseline.
 *   2. Runner clones, switches to main, makes turn changes, commits.
 *   3. Runner bundles baseline..main + main ref.
 *
 * Returns the bundle base64 + the baselineFiles snapshot the host
 * needs to seed at apply time.
 */
async function simulateRunnerTurn(args: {
  baselineFiles: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
  turnFiles: Record<string, string | null>;
  /** Author identity for the turn commit (defaults to ax-runner). */
  turnAuthor?: string;
  /** Committer identity (defaults to turnAuthor). */
  turnCommitter?: string;
}): Promise<{ bundleB64: string }> {
  const {
    baselineFiles,
    turnFiles,
    turnAuthor = 'ax-runner',
    turnCommitter = turnAuthor,
  } = args;

  const baselineB64 = await buildBaselineBundle({
    paths: baselineFiles.map((f) => f.path),
    read: async (p) => {
      const f = baselineFiles.find((x) => x.path === p);
      return f === undefined ? null : Buffer.from(f.bytes);
    },
  });

  const root = await fs.mkdtemp(path.join(tmpdir(), 'ax-wcn-sim-'));
  try {
    const bundlePath = path.join(root, 'baseline.bundle');
    await fs.writeFile(bundlePath, Buffer.from(baselineB64, 'base64'));
    const wt = path.join(root, 'wt');
    const cl = await git(['clone', '--branch', 'baseline', bundlePath, wt]);
    if (cl.code !== 0) throw new Error(`clone failed: ${cl.stderr}`);
    await git(['-C', wt, 'checkout', '-b', 'main']);

    for (const [p, content] of Object.entries(turnFiles)) {
      const abs = path.join(wt, p);
      if (content === null) {
        await fs.unlink(abs);
      } else {
        const dir = path.dirname(abs);
        if (dir !== wt) await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(abs, content);
      }
    }
    await git(['-C', wt, 'add', '-A']);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: turnAuthor,
      GIT_AUTHOR_EMAIL: `${turnAuthor}@example.com`,
      GIT_COMMITTER_NAME: turnCommitter,
      GIT_COMMITTER_EMAIL: `${turnCommitter}@example.com`,
    };
    const c = await git(['-C', wt, 'commit', '-m', 'turn'], undefined, env);
    if (c.code !== 0) throw new Error(`commit failed: ${c.stderr}`);

    const buf = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn('git', [
        '-C',
        wt,
        'bundle',
        'create',
        '-',
        'baseline..main',
        'main',
      ]);
      const chunks: Buffer[] = [];
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0
          ? resolve(Buffer.concat(chunks))
          : reject(new Error(`bundle exit=${code}: ${stderr}`)),
      );
    });
    return { bundleB64: buf.toString('base64') };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('workspace.commit-notify handler — empty bundle', () => {
  it('short-circuits to accepted:true with parentVersion preserved', async () => {
    const { bus, ctx } = await makeEnv();
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: 'v-existing',
        reason: 'turn',
        bundleBytes: '',
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    const body = result.body as { accepted: true; version: string };
    expect(body.accepted).toBe(true);
    expect(body.version).toBe('v-existing');
  });

  it('short-circuits to accepted:true even with null parentVersion', async () => {
    const { bus, ctx } = await makeEnv();
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: '',
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    expect((result.body as { accepted: boolean }).accepted).toBe(true);
  });
});

describe('workspace.commit-notify handler — fallback FileChange[] path (MockWorkspace, no apply-bundle)', () => {
  it('happy path: bundle decoded, applied via workspace:apply, snapshot queryable', async () => {
    const { bus, ctx } = await makeEnv();
    const turnContent = '# project memory';
    const { bundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: { '.ax/CLAUDE.md': turnContent },
    });

    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: bundleB64,
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    const body = result.body as { accepted: true; version: string; delta: null };
    expect(body.accepted).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    // Wire NEVER carries the delta payload.
    expect(body.delta).toBeNull();
  });

  it('rejects bundle authored by someone other than ax-runner', async () => {
    const { bus, ctx } = await makeEnv();
    const { bundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: { 'a.txt': 'A' },
      turnAuthor: 'eve',
    });
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: bundleB64,
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    const body = result.body as { accepted: false; reason: string };
    expect(body.accepted).toBe(false);
    expect(body.reason).toContain('author verification');
  });

  it('rejects bundle whose committer differs (committer-replaced attack)', async () => {
    const { bus, ctx } = await makeEnv();
    const { bundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: { 'a.txt': 'A' },
      turnAuthor: 'ax-runner',
      turnCommitter: 'eve',
    });
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: bundleB64,
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    expect((result.body as { accepted: boolean }).accepted).toBe(false);
  });

  it('pre-apply subscriber sees ONLY .ax/-filtered changes, NOT user-code changes', async () => {
    const { bus, ctx } = await makeEnv();
    let observedChanges: FileChange[] | null = null;
    bus.subscribe<{
      changes: FileChange[];
      parent: WorkspaceVersion | null;
      reason: string;
    }>('workspace:pre-apply', 'observer', async (_c, payload) => {
      observedChanges = payload.changes;
      return undefined;
    });

    const { bundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: {
        '.ax/CLAUDE.md': '# memory',
        'src/main.ts': 'export {};',
        'README.md': '# project',
      },
    });
    await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: bundleB64,
      },
      ctx,
      bus,
    );

    expect(observedChanges).not.toBeNull();
    const changes = observedChanges as unknown as FileChange[];
    expect(changes.map((c) => c.path).sort()).toEqual(['.ax/CLAUDE.md']);
  });

  it('pre-apply rejection surfaces as 200 {accepted:false, reason}', async () => {
    const { bus, ctx } = await makeEnv();
    bus.subscribe('workspace:pre-apply', 'mock-policy', async () =>
      reject({ reason: 'policy violation' }),
    );

    const { bundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: { '.ax/CLAUDE.md': 'mem' },
    });
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: bundleB64,
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    const body = result.body as { accepted: false; reason: string };
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe('policy violation');
  });

  it('pre-apply rejection short-circuits BEFORE workspace:apply runs', async () => {
    const { bus, ctx } = await makeEnv();
    bus.subscribe('workspace:pre-apply', 'mock-policy', async () =>
      reject({ reason: 'no' }),
    );
    let applyCalled = false;
    // Wrap workspace:apply to detect if it was called. We can't easily
    // intercept the registered service, but we can subscribe to
    // workspace:applied — which only fires after apply succeeds.
    bus.subscribe('workspace:applied', 'spy', async () => {
      applyCalled = true;
      return undefined;
    });

    const { bundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: { '.ax/CLAUDE.md': 'mem' },
    });
    await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: bundleB64,
      },
      ctx,
      bus,
    );
    expect(applyCalled).toBe(false);
  });

  it('workspace:applied subscriber receives the delta with the full change set (not .ax-filtered)', async () => {
    const { bus, ctx } = await makeEnv();
    let observed: WorkspaceDelta | null = null;
    bus.subscribe<WorkspaceDelta>('workspace:applied', 'observer', async (_c, payload) => {
      observed = payload;
      return undefined;
    });

    const { bundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: {
        '.ax/CLAUDE.md': '# memory',
        'src/main.ts': 'export {};',
      },
    });
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: bundleB64,
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);

    expect(observed).not.toBeNull();
    const delta = observed as unknown as WorkspaceDelta;
    // Apply got the FULL set (not .ax-filtered).
    expect(delta.changes.map((c) => c.path).sort()).toEqual([
      '.ax/CLAUDE.md',
      'src/main.ts',
    ]);
  });

  it('schema validation: malformed request (missing bundleBytes) → 400 VALIDATION', async () => {
    const { bus, ctx } = await makeEnv();
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        // Missing bundleBytes — schema rejects.
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(400);
    const errBody = result.body as { error: { code: string; message: string } };
    expect(errBody.error.code).toBe('VALIDATION');
    expect(errBody.error.message).toContain('workspace.commit-notify');
  });
});

describe('workspace.commit-notify handler — apply-bundle preferred path', () => {
  it('uses workspace:apply-bundle when registered, NOT workspace:apply', async () => {
    let applyBundleCalled = false;
    let applyCalled = false;

    const probePlugin: Plugin = {
      manifest: {
        name: '@ax/test-bundle-spy',
        version: '0.0.0',
        registers: ['workspace:apply-bundle'],
        calls: [],
        subscribes: [],
      },
      init({ bus }) {
        bus.registerService(
          'workspace:apply-bundle',
          '@ax/test-bundle-spy',
          async () => {
            applyBundleCalled = true;
            // Return a synthetic apply output — the test only cares
            // about which path the handler picked.
            return {
              version: 'v-from-apply-bundle' as WorkspaceVersion,
              delta: {
                before: null,
                after: 'v-from-apply-bundle' as WorkspaceVersion,
                reason: 'turn',
                changes: [],
              },
            };
          },
        );
      },
    };

    const { bus, ctx } = await makeEnv([probePlugin]);

    // Spy on workspace:apply too — must NOT fire.
    bus.subscribe('workspace:applied', 'spy-apply', async () => {
      applyCalled = true;
      return undefined;
    });

    const { bundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: { '.ax/CLAUDE.md': 'mem' },
    });
    const result = await workspaceCommitNotifyHandler(
      {
        parentVersion: null,
        reason: 'turn',
        bundleBytes: bundleB64,
      },
      ctx,
      bus,
    );
    expect(result.status).toBe(200);
    const body = result.body as { accepted: true; version: string };
    expect(body.accepted).toBe(true);
    expect(body.version).toBe('v-from-apply-bundle');
    expect(applyBundleCalled).toBe(true);
    // workspace:applied fires on success, regardless of which path
    // (the spy fires either way) — what matters is which apply path
    // produced the result. The version assertion above proves the
    // apply-bundle branch ran.
    expect(applyCalled).toBe(true); // workspace:applied fires post-success
  });
});
