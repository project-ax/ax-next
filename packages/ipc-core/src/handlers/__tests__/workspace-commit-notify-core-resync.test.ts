// ---------------------------------------------------------------------------
// Integration regression (F-1): the apply-bundle parent-mismatch catch in the
// commit-notify handler must forward a FULL re-sync envelope — not a bare veto
// — when the workspace runs on the SINGLE-REPLICA backend (@ax/workspace-git-
// core).
//
// Why this is distinct from `workspace-commit-notify.test.ts`'s "parent-mismatch
// from export-baseline-bundle" case:
//
//   - On the MULTI-replica backend (@ax/workspace-git-server) a concurrent
//     writer surfaces EARLY — at `workspace:export-baseline-bundle(V1)` — which
//     already throws PluginError{cause:{actualParent, baselineBundleBytes}}.
//     The handler's EXPORT catch forwards that. (Covered by the server-side
//     regression + the probe test in workspace-commit-notify.test.ts.)
//
//   - On the SINGLE-replica backend (@ax/workspace-git-core) the export of a
//     reachable ancestor (V1, now an ancestor of V2) SUCCEEDS — it bundles AT
//     V1. The mismatch is only detected LATER, by the parent-CAS inside
//     `workspace:apply-bundle` (impl.ts Site 1: head V2 ≠ requested parent V1).
//     Pre-fix that throw carried NO actualParent, so the handler's apply-bundle
//     catch returned a BARE veto (no actualParent / no baselineBundleBytes) and
//     the runner had no head to rebase onto → permanent stuck-loop / lost turn.
//
// This test drives the REAL handler against the REAL workspace-git-core backend
// (no mocked services) through the exact production sequence:
//   turn-1 (empty baseline) → V1, concurrent out-of-band attachment apply → V2,
//   turn-2 with parentVersion=V1.
//
// Pre-fix RED: turn-2 returns accepted:false but actualParent/baselineBundleBytes
// are undefined (bare veto). Post-fix GREEN: actualParent===V2 and
// baselineBundleBytes is a real git bundle at V2.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
  type WorkspaceVersion,
} from '@ax/core';
import { registerWorkspaceGitHooks } from '@ax/workspace-git-core';
import { workspaceCommitNotifyHandler } from '../workspace-commit-notify.js';

// ---------------------------------------------------------------------------
// Raw-git helpers (copied from
// packages/workspace-git-server/src/client/__tests__/concurrent-attachment-regression.test.ts).
// ---------------------------------------------------------------------------

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

async function gitOrThrow(
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  const r = await git(args, cwd, env);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
  }
  return r;
}

// Matches workspace-git-core impl.ts's BASELINE_ENV (determinism contract):
// the empty-baseline OID the runner pins must equal the host's, so a turn-1
// workspace built here with this env produces the SAME empty-baseline OID the
// core backend reconstructs.
const SIM_BASELINE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ax-runner',
  GIT_AUTHOR_EMAIL: 'ax-runner@example.com',
  GIT_COMMITTER_NAME: 'ax-runner',
  GIT_COMMITTER_EMAIL: 'ax-runner@example.com',
  GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
};

/** Build a thin bundle (baseline..main + main ref) from a runner repo. */
async function buildTurnBundle(repoDir: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', [
      '-C', repoDir, 'bundle', 'create', '-', 'baseline..main', 'main',
    ]);
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString('base64'))
        : reject(new Error(`bundle exit=${code}: ${stderr}`)),
    );
  });
}

/**
 * Build a runner-style working tree on top of the deterministic empty-tree
 * baseline. Returns { wt, baselineCommit } where baselineCommit is the
 * empty-baseline OID (== the core backend's reconstruction).
 */
async function buildRunnerWorkspace(args: {
  root: string;
  turnFiles: Record<string, string>;
}): Promise<{ wt: string; baselineCommit: string }> {
  const { root, turnFiles } = args;
  const baselineDir = join(root, 'baseline');
  await fs.mkdir(baselineDir, { recursive: true });
  await gitOrThrow(['init', '-b', 'main', baselineDir], undefined, SIM_BASELINE_ENV);
  await gitOrThrow(['-C', baselineDir, 'config', 'core.fileMode', 'false'], undefined, SIM_BASELINE_ENV);
  await gitOrThrow(['-C', baselineDir, 'commit', '--allow-empty', '-m', 'baseline'], undefined, SIM_BASELINE_ENV);
  const baselineBundle = join(root, 'baseline.bundle');
  await gitOrThrow(['-C', baselineDir, 'bundle', 'create', baselineBundle, 'main'], undefined, SIM_BASELINE_ENV);
  const baselineOid = (await gitOrThrow(['-C', baselineDir, 'rev-parse', 'HEAD'], undefined, SIM_BASELINE_ENV)).stdout.trim();

  const wt = join(root, 'wt');
  await gitOrThrow(['clone', '--branch', 'main', baselineBundle, wt]);
  await gitOrThrow(['-C', wt, 'update-ref', 'refs/heads/baseline', 'HEAD']);
  await gitOrThrow(['-C', wt, 'config', 'user.name', 'ax-runner']);
  await gitOrThrow(['-C', wt, 'config', 'user.email', 'ax-runner@example.com']);

  await writeTurnFiles(wt, turnFiles);
  await gitOrThrow(['-C', wt, 'add', '-A']);
  await gitOrThrow(['-C', wt, 'commit', '-m', 'turn']);
  return { wt, baselineCommit: baselineOid };
}

/**
 * Build a runner-style working tree whose baseline is an arbitrary host
 * bundle (e.g. bundle@V1). Used for turn-2, which the runner builds on top of
 * the version it last accepted (V1) — NOT the empty baseline.
 * Returns { wt, baselineCommit } where baselineCommit is the bundle's tip OID.
 */
async function buildRunnerWorkspaceFromBundle(args: {
  root: string;
  baselineBundleBytesB64: string;
  turnFiles: Record<string, string>;
}): Promise<{ wt: string; baselineCommit: string }> {
  const { root, baselineBundleBytesB64, turnFiles } = args;
  await fs.mkdir(root, { recursive: true });
  const baselineBundle = join(root, 'baseline.bundle');
  await fs.writeFile(baselineBundle, Buffer.from(baselineBundleBytesB64, 'base64'));

  const wt = join(root, 'wt');
  await gitOrThrow(['clone', '--branch', 'main', baselineBundle, wt]);
  await gitOrThrow(['-C', wt, 'update-ref', 'refs/heads/baseline', 'HEAD']);
  await gitOrThrow(['-C', wt, 'config', 'user.name', 'ax-runner']);
  await gitOrThrow(['-C', wt, 'config', 'user.email', 'ax-runner@example.com']);
  const baselineOid = (await gitOrThrow(['-C', wt, 'rev-parse', 'HEAD'])).stdout.trim();

  await writeTurnFiles(wt, turnFiles);
  await gitOrThrow(['-C', wt, 'add', '-A']);
  await gitOrThrow(['-C', wt, 'commit', '-m', 'turn']);
  return { wt, baselineCommit: baselineOid };
}

async function writeTurnFiles(
  wt: string,
  turnFiles: Record<string, string>,
): Promise<void> {
  for (const [p, content] of Object.entries(turnFiles)) {
    const abs = join(wt, p);
    await fs.mkdir(join(wt, dirname(p)), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

// ---------------------------------------------------------------------------
// Backend boot — the core plugin shim (modeled on
// packages/workspace-git-core/src/__tests__/contract.test.ts). The manifest's
// `registers` MUST list EVERY hook registerWorkspaceGitHooks registers (the
// public `workspace:apply` facade + the six internal hooks).
// ---------------------------------------------------------------------------

function makeCorePlugin(repoRoot: string): Plugin {
  return {
    manifest: {
      name: '@ax/workspace-git-core-resync-test-shim',
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

interface Env {
  bus: HookBus;
  ctx: AgentContext;
  repoRoot: string;
}

const ENVS: Env[] = [];

async function makeEnv(): Promise<Env> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ipc-core-resync-'));
  const bus = new HookBus();
  await bootstrap({ bus, plugins: [makeCorePlugin(repoRoot)], config: {} });
  const ctx = makeAgentContext({
    sessionId: 'resync-test',
    agentId: 'resync-agent',
    userId: 'resync-user',
  });
  const env = { bus, ctx, repoRoot };
  ENVS.push(env);
  return env;
}

let tmpRoots: string[] = [];

beforeEach(() => {
  tmpRoots = [];
});

afterEach(async () => {
  for (const env of ENVS.splice(0)) {
    await fs.rm(env.repoRoot, { recursive: true, force: true });
  }
  for (const r of tmpRoots.splice(0)) {
    await fs.rm(r, { recursive: true, force: true });
  }
});

function mkTmp(label: string): string {
  const r = mkdtempSync(join(tmpdir(), `ax-resync-${label}-`));
  tmpRoots.push(r);
  return r;
}

// ---------------------------------------------------------------------------
// The regression test.
// ---------------------------------------------------------------------------

describe('workspace.commit-notify handler — single-replica concurrent-writer re-sync (F-1)', () => {
  it(
    'apply-bundle parent-mismatch forwards actualParent + baselineBundleBytes (not a bare veto)',
    async () => {
      const { bus, ctx } = await makeEnv();

      // --- turn-1: runner workspace on the empty baseline → accepted at V1.
      const t1Root = mkTmp('turn1');
      const { wt: wt1, baselineCommit: emptyBaselineOid } =
        await buildRunnerWorkspace({
          root: t1Root,
          turnFiles: {
            '.ax/projects/p/t1.jsonl': '{"role":"assistant","text":"hello"}\n',
          },
        });
      const t1Bundle = await buildTurnBundle(wt1);

      const r1 = await workspaceCommitNotifyHandler(
        { parentVersion: emptyBaselineOid, reason: 'turn', bundleBytes: t1Bundle },
        ctx,
        bus,
      );
      expect(r1.status).toBe(200);
      const b1 = r1.body as { accepted: boolean; version: string };
      expect(b1.accepted).toBe(true);
      const v1 = b1.version;
      expect(v1).toMatch(/^[0-9a-f]{40}$/);

      // --- concurrent out-of-band apply (attachment) → V2, child of V1.
      const r2 = await bus.call<
        { changes: { path: string; kind: 'put'; content: Uint8Array }[]; parent: WorkspaceVersion; reason: string },
        { version: WorkspaceVersion }
      >('workspace:apply', ctx, {
        changes: [
          {
            path: '.ax/uploads/img.png',
            kind: 'put',
            content: new TextEncoder().encode('\x89PNG\r\n'),
          },
        ],
        parent: v1 as WorkspaceVersion,
        reason: 'attachment',
      });
      const v2 = r2.version as string;
      expect(v2).toMatch(/^[0-9a-f]{40}$/);
      expect(v2).not.toBe(v1);

      // --- turn-2: runner is still pinned at V1. Build its workspace on top
      //     of bundle@V1 (the backend exports V1 fine — it's now an ancestor
      //     of V2), commit t2, bundle V1..t2, and notify with parentVersion=V1.
      const exportV1 = await bus.call<
        { version: WorkspaceVersion },
        { bundleBytes: string }
      >('workspace:export-baseline-bundle', ctx, { version: v1 as WorkspaceVersion });

      const t2Root = mkTmp('turn2');
      const { wt: wt2 } = await buildRunnerWorkspaceFromBundle({
        root: t2Root,
        baselineBundleBytesB64: exportV1.bundleBytes,
        turnFiles: {
          '.ax/projects/p/t2.jsonl': '{"role":"assistant","text":"world"}\n',
        },
      });
      const t2Bundle = await buildTurnBundle(wt2);

      const r3 = await workspaceCommitNotifyHandler(
        { parentVersion: v1, reason: 'turn', bundleBytes: t2Bundle },
        ctx,
        bus,
      );

      // The apply-bundle parent-CAS (impl.ts Site 1) detects head V2 ≠ parent
      // V1 and throws parent-mismatch. The handler must forward the FULL
      // re-sync envelope, not a bare veto.
      expect(r3.status).toBe(200);
      const b3 = r3.body as {
        accepted: false;
        reason: string;
        actualParent?: string;
        baselineBundleBytes?: string;
      };
      expect(b3.accepted).toBe(false);

      // The decisive assertions — pre-fix these are `undefined` (bare veto).
      expect(b3.actualParent).toBe(v2);
      expect(typeof b3.baselineBundleBytes).toBe('string');
      const bundle = Buffer.from(b3.baselineBundleBytes!, 'base64');
      const header = bundle.slice(0, 20).toString('ascii');
      expect(header).toMatch(/^# v[23] git bundle/);
    },
    30_000,
  );
});
