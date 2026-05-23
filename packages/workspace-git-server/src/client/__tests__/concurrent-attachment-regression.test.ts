// ---------------------------------------------------------------------------
// Regression test: concurrent attachments:commit must not drop chat turns.
//
// Production scenario that was lost before this fix:
//
//   1. Chat turn T1 lands: runner calls workspace.commit-notify with
//      parentVersion=V0. Host pushes V1 (turn commit), returns accepted:true.
//      Runner advances its local baseline to V1.
//   2. CONCURRENT: An attachment upload calls attachments:commit →
//      workspace:apply. The host advances the SAME mirror to V2 (an
//      attachment file on a disjoint path, child of V1). This is out-of-band
//      from the runner's perspective.
//   3. Chat turn T2 lands: runner calls workspace.commit-notify with
//      parentVersion=V1. The host's mirror head is NOW V2 (not V1).
//
//   BEFORE THE FIX: exportBaselineBundle threw a raw Error and the handler
//   returned 500. The runner treated 500 as a network error, kept the bundle
//   accumulating, and every subsequent turn re-sent the same stale bundle →
//   permanent 500 loop. The transcript was truncated on reload.
//
//   AFTER THE FIX (Tasks 1-4):
//     - git-engine.ts's exportBaselineBundle detects mirror head ≠ requested
//       version and throws PluginError{code:'parent-mismatch'} carrying
//       actualParent=V2 and baselineBundleBytes=<bundle@V2>.
//     - workspace-commit-notify.ts handler catches that error and returns
//       status 200, accepted:false, actualParent, baselineBundleBytes.
//     - runner's resyncBaselineAndReplay fetches the bundle, rebases T2 onto
//       V2, and retries → accepted:true with parent=V2. Both the attachment
//       file AND the turn file are in the workspace.
//
// What this test validates (host-side integration level):
//
//   PART A (host): Real GitEngine + real exportBaselineBundle. Drives the full
//   V1→out-of-band-V2→exportBaselineBundle(V1) path and asserts the engine
//   returns parent-mismatch with actualParent=V2 and non-empty bundleBytes.
//
//   PART B (full loop): Feeds the baselineBundleBytes from PART A into a
//   runner-style repo via raw git operations (matching the exact git commands
//   that resyncBaselineAndReplay executes). Then calls applyBundle with
//   parent=V2 on the real engine and asserts: (a) accepted, (b) both the
//   attachment file (V2) and the turn file (T2) are visible in the mirror.
//
// Pre-fix failure mode of this test:
//   PART A would fail: exportBaselineBundle would NOT return a PluginError;
//   instead it would throw a plain Error("mirror head … concurrent writer or
//   stale version") OR return successfully with the wrong (stale) bundle. The
//   `expect(err).toBeInstanceOf(PluginError)` assertion would fail.
//   PART B would never be reached.
//
// Coverage boundary:
//   The full runner re-sync loop (the bounded retry in main.ts) is NOT
//   exercised here — that path requires driving the full runner process.
//   It is covered by the manual cluster re-walk in the plan's Verification
//   section. The raw git rebase in PART B is the same git invocation sequence
//   that resyncBaselineAndReplay uses, so the object-store plumbing is
//   equivalent.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asWorkspaceVersion, PluginError } from '@ax/core';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../../server/index.js';
import { createGitEngine, type GitEngine } from '../git-engine.js';
import { createMirrorCache, type MirrorCache } from '../mirror-cache.js';
import { createRepoLifecycleClient } from '../repo-lifecycle.js';

// ---------------------------------------------------------------------------
// Test helpers
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
    const child = spawn('git', [...args], {
      cwd,
      env: env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Matches git-engine.ts's BASELINE_ENV (must stay in sync — determinism contract).
const SIM_BASELINE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ax-runner',
  GIT_AUTHOR_EMAIL: 'ax-runner@example.com',
  GIT_COMMITTER_NAME: 'ax-runner',
  GIT_COMMITTER_EMAIL: 'ax-runner@example.com',
  GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
};

/**
 * Build a thin bundle (baseline..main + main ref) from a runner-style repo.
 * Returns base64 bytes.
 */
async function buildTurnBundle(repoDir: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', [
      '-C', repoDir,
      'bundle', 'create', '-',
      'baseline..main', 'main',
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
 * Build a runner-style working tree on top of an empty-tree baseline.
 * Returns { wt: <path>, baselineCommit: <oid> }.
 */
async function buildRunnerWorkspace(args: {
  root: string;
  turnFiles: Record<string, string>;
}): Promise<{ wt: string; baselineCommit: string }> {
  const { root, turnFiles } = args;

  // 1. Build the deterministic empty-tree baseline (mirrors buildEmptyBaselineBundle
  //    in git-engine.ts — fixed dates, fixed author env, core.fileMode=false).
  const baselineDir = join(root, 'baseline');
  await fs.mkdir(baselineDir, { recursive: true });
  await git(['init', '-b', 'main', baselineDir], undefined, SIM_BASELINE_ENV);
  await git(['-C', baselineDir, 'config', 'core.fileMode', 'false'], undefined, SIM_BASELINE_ENV);
  await git(['-C', baselineDir, 'commit', '--allow-empty', '-m', 'baseline'], undefined, SIM_BASELINE_ENV);
  const baselineBundle = join(root, 'baseline.bundle');
  await git(['-C', baselineDir, 'bundle', 'create', baselineBundle, 'main'], undefined, SIM_BASELINE_ENV);
  const baselineOid = (await git(['-C', baselineDir, 'rev-parse', 'HEAD'], undefined, SIM_BASELINE_ENV)).stdout.trim();

  // 2. Clone into working tree.
  const wt = join(root, 'wt');
  await git(['clone', '--branch', 'main', baselineBundle, wt]);
  await git(['-C', wt, 'update-ref', 'refs/heads/baseline', 'HEAD']);
  await git(['-C', wt, 'config', 'user.name', 'ax-runner']);
  await git(['-C', wt, 'config', 'user.email', 'ax-runner@example.com']);

  // 3. Write turn files (do NOT commit — let caller bundle separately).
  for (const [p, content] of Object.entries(turnFiles)) {
    const abs = join(wt, p);
    await fs.mkdir(join(wt, require_dirname(p)), { recursive: true });
    await fs.writeFile(abs, content);
  }
  await git(['-C', wt, 'add', '-A']);
  await git(['-C', wt, 'commit', '-m', 'turn']);

  return { wt, baselineCommit: baselineOid };
}

/** Minimal dirname that doesn't need path.dirname import */
function require_dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '.' : p.slice(0, i);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TOKEN = 'concurrent-attach-regression-token';

interface Harness {
  server: WorkspaceGitServer;
  engine: GitEngine;
  mirrorCache: MirrorCache;
  repoRoot: string;
  baseUrl: string;
}

async function bootHarness(): Promise<Harness> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-concurrent-attach-repos-'));
  const server = await createWorkspaceGitServer({
    repoRoot,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const mirrorCache = createMirrorCache();
  const lifecycleClient = createRepoLifecycleClient({ baseUrl, token: TOKEN });
  const engine = createGitEngine({ baseUrl, token: TOKEN, mirrorCache, lifecycleClient });
  return { server, engine, mirrorCache, repoRoot, baseUrl };
}

async function teardown(h: Harness): Promise<void> {
  await h.engine.shutdown();
  await h.mirrorCache.shutdown();
  await h.server.close();
  await fs.rm(h.repoRoot, { recursive: true, force: true });
}

let harness: Harness;

beforeEach(async () => {
  harness = await bootHarness();
});

afterEach(async () => {
  await teardown(harness);
});

// ---------------------------------------------------------------------------
// The regression test
// ---------------------------------------------------------------------------

describe('git-engine — concurrent attachments:commit must not drop chat turns', () => {
  it(
    'PART A: exportBaselineBundle(V1) returns parent-mismatch+actualParent+bundle when mirror advanced to V2 out-of-band',
    async () => {
      // -----------------------------------------------------------------------
      // Setup: build a runner workspace + turn bundle (T2) on top of V0.
      // Then drive the host mirror through:
      //   V0 (empty baseline) → V1 (chat turn T1 accepted)
      //                       → V2 (concurrent attachment apply, disjoint path)
      // The runner still holds parentVersion=V1 when it sends T2.
      // -----------------------------------------------------------------------
      const wsId = 'ws-concurrent-attach-regression';
      const tmpRoot = mkdtempSync(join(tmpdir(), 'ax-runner-sim-'));

      let turnBundle: string;
      let baselineCommit: string;
      let v1: string;
      let v2: string;

      try {
        // --- Step 1: Simulate runner's first turn (T1) against empty workspace.
        // Build runner workspace with a chat turn file (.ax/projects/…/t1.jsonl).
        const { wt: wt1, baselineCommit: b0 } = await buildRunnerWorkspace({
          root: join(tmpRoot, 'turn1'),
          turnFiles: {
            '.ax/projects/proj1/t1.jsonl': '{"role":"assistant","text":"hello"}\n',
          },
        });
        baselineCommit = b0;

        const t1BundleB64 = await buildTurnBundle(wt1);

        // Apply T1 to the host engine → V1.
        const r1 = await harness.engine.applyBundle(wsId, {
          bundleBytes: t1BundleB64,
          baselineCommit,
          parent: null,
          reason: 'turn 1',
        });
        v1 = r1.version as string;
        expect(v1).toMatch(/^[0-9a-f]{40}$/);

        // --- Step 2: Out-of-band attachment apply → V2.
        // Simulate what attachments:commit → workspace:apply does:
        // it calls apply() with parent=V1, touching a disjoint path.
        const r2 = await harness.engine.apply(wsId, {
          changes: [
            {
              path: '.ax/uploads/img001.png',
              kind: 'put',
              content: new TextEncoder().encode('\x89PNG\r\n'),
            },
          ],
          parent: asWorkspaceVersion(v1),
          reason: 'attachment upload',
        });
        v2 = r2.version as string;
        expect(v2).toMatch(/^[0-9a-f]{40}$/);
        expect(v2).not.toBe(v1);

        // --- Step 3: Build runner's T2 turn (STILL on top of V1, unaware of V2).
        // Runner's baseline is V1; it commits a new turn on top of it.
        const { wt: wt2 } = await buildRunnerWorkspace({
          root: join(tmpRoot, 'turn2'),
          turnFiles: {
            '.ax/projects/proj1/t2.jsonl': '{"role":"assistant","text":"world"}\n',
          },
        });
        // wt2 was built off the deterministic empty baseline. We need to rebase it
        // onto V1 so the parent is correct. For the test's purpose we use the
        // already-committed wt2 as the T2 bundle (stale parent=b0).
        // We'll call exportBaselineBundle with version=V1 to trigger the
        // parent-mismatch signal.
        turnBundle = await buildTurnBundle(wt2);
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }

      // -----------------------------------------------------------------------
      // PART A: Call exportBaselineBundle(wsId, { version: V1 }).
      // The mirror is now at V2. This MUST throw PluginError{code:'parent-mismatch'}
      // with cause.actualParent===V2 and cause.baselineBundleBytes non-empty.
      //
      // PRE-FIX behaviour: exportBaselineBundle would call exportMirrorBundle
      // which calls git rev-parse + verifies headOid===oid. When oid !== head,
      // the OLD code threw a plain Error("mirror head … concurrent writer"),
      // NOT a PluginError — so the handler escalated to 500 and the runner
      // looped forever. The pre-fix exportMirrorBundle did NOT bundle the
      // current head, so the runner had no way to resync.
      //
      // POST-FIX behaviour: exportBaselineBundle detects oid !== head, bundles
      // the CURRENT head (V2), and throws PluginError{code:'parent-mismatch'}
      // with cause.actualParent=V2 and cause.baselineBundleBytes=<bundle@V2>.
      // -----------------------------------------------------------------------
      const err = await harness.engine
        .exportBaselineBundle(wsId, { version: asWorkspaceVersion(v1) })
        .catch((e: unknown) => e);

      // The export MUST fail — accepted at V1 when mirror is at V2 is wrong.
      expect(err).toBeInstanceOf(PluginError);
      const pe = err as PluginError;
      expect(pe.code).toBe('parent-mismatch');

      const cause = pe.cause as {
        actualParent: string;
        baselineBundleBytes: string;
      };

      // actualParent MUST be V2 (the real mirror head after the attachment apply).
      expect(cause.actualParent).toBe(v2);

      // baselineBundleBytes MUST be a real (non-trivial) git bundle.
      expect(typeof cause.baselineBundleBytes).toBe('string');
      expect(cause.baselineBundleBytes.length).toBeGreaterThan(100);

      // Sanity: the bundle bytes are valid base64.
      const bundleBytes = Buffer.from(cause.baselineBundleBytes, 'base64');
      // A valid git bundle starts with "# v2 git bundle\n" or "# v3 git bundle\n".
      const header = bundleBytes.slice(0, 20).toString('ascii');
      expect(header).toMatch(/^# v[23] git bundle/);
    },
    30_000,
  );

  it(
    'PART B (full loop): resync + retry succeeds; both attachment file and turn file persist',
    async () => {
      // -----------------------------------------------------------------------
      // Full loop test:
      //   1. Apply T1 → V1 (chat turn file).
      //   2. Concurrent attachment apply → V2 (disjoint path).
      //   3. Call exportBaselineBundle(V1) → get parent-mismatch with
      //      actualParent=V2 + baselineBundleBytes.
      //   4. Runner-side resync: fetch bundle, git rebase --onto V2 B0 main,
      //      pin baseline to V2.
      //   5. Re-bundle the rebased turn (now on top of V2).
      //   6. Call applyBundle with parent=V2 → MUST be accepted.
      //   7. Assert engine can read BOTH the attachment file (from V2) AND
      //      the turn file (from T2 replayed) from the mirror.
      //
      // This closes the loop: the turn that was permanently dropped before
      // the fix now persists in the workspace.
      // -----------------------------------------------------------------------
      const wsId = 'ws-concurrent-attach-full-loop';
      const tmpRoot = mkdtempSync(join(tmpdir(), 'ax-full-loop-sim-'));

      try {
        // Step 1: T1 apply → V1.
        const { wt: wt1, baselineCommit: b0 } = await buildRunnerWorkspace({
          root: join(tmpRoot, 'turn1'),
          turnFiles: {
            '.ax/projects/p1/t1.jsonl': '{"role":"assistant","text":"hello"}\n',
          },
        });

        const t1Bundle = await buildTurnBundle(wt1);
        const r1 = await harness.engine.applyBundle(wsId, {
          bundleBytes: t1Bundle,
          baselineCommit: b0,
          parent: null,
          reason: 'turn 1',
        });
        const v1 = r1.version as string;

        // Step 2: Out-of-band attachment → V2.
        const r2 = await harness.engine.apply(wsId, {
          changes: [
            {
              path: '.ax/uploads/photo.png',
              kind: 'put',
              content: new TextEncoder().encode('\x89PNG\r\n\x1a\n'),
            },
          ],
          parent: asWorkspaceVersion(v1),
          reason: 'attachment',
        });
        const v2 = r2.version as string;

        // Step 3: Build T2 bundle — runner is still at baseline=V0 (b0)
        // and built a turn commit on top of b0.
        const { wt: wt2 } = await buildRunnerWorkspace({
          root: join(tmpRoot, 'turn2'),
          turnFiles: {
            '.ax/projects/p1/t2.jsonl': '{"role":"assistant","text":"world"}\n',
          },
        });

        // The runner's parentVersion is V1 (it accepted T1). The bundle
        // it would send has baselineCommit=b0 (the turn was built off
        // the original empty baseline, before it advanced after T1).
        // For this test, what matters is that exportBaselineBundle(V1) → fails,
        // and we get the resync signal. Then we build the re-synced bundle.

        // Step 4: exportBaselineBundle(V1) — must return parent-mismatch.
        const exportErr = await harness.engine
          .exportBaselineBundle(wsId, { version: asWorkspaceVersion(v1) })
          .catch((e: unknown) => e);
        expect(exportErr).toBeInstanceOf(PluginError);
        const pe = exportErr as PluginError;
        expect(pe.code).toBe('parent-mismatch');
        const cause = pe.cause as {
          actualParent: string;
          baselineBundleBytes: string;
        };
        expect(cause.actualParent).toBe(v2);

        // Step 5: Runner-side resync (mirrors resyncBaselineAndReplay exactly).
        // Fetch the host's baselineBundleBytes into the runner's wt2 repo.
        const resyncBundlePath = join(tmpRoot, 'resync.bundle');
        await fs.writeFile(
          resyncBundlePath,
          Buffer.from(cause.baselineBundleBytes, 'base64'),
        );
        // Fetch the bundle (brings v2 object into the local object store).
        const fetchResult = await git(['-C', wt2, 'fetch', resyncBundlePath, 'main']);
        expect(fetchResult.code).toBe(0);

        // Rebase our turn commit(s) onto v2 (the concurrent writer's head).
        // --onto v2: new parent for the replayed commits.
        // b0: the upstream from which our turn diverged (the old baseline).
        // main: the branch tip to rebase.
        const rebaseResult = await git(['-C', wt2, 'rebase', '--onto', v2, b0, 'main']);
        expect(rebaseResult.code).toBe(0);

        // Pin baseline to v2 (as advanceBaseline would do after resync).
        await git(['-C', wt2, 'update-ref', 'refs/heads/baseline', v2]);

        // Step 6: Re-bundle and retry commit-notify with parent=V2.
        const rebasedBundle = await buildTurnBundle(wt2);

        // Get the rebased turn's HEAD OID for the applyBundle call.
        const rebasedHead = (await git(['-C', wt2, 'rev-parse', 'HEAD'])).stdout.trim();

        const r3 = await harness.engine.applyBundle(wsId, {
          bundleBytes: rebasedBundle,
          baselineCommit: v2, // runner's new baseline after resync
          parent: asWorkspaceVersion(v2),
          reason: 'turn 2 (after resync)',
        });
        const v3 = r3.version as string;
        expect(v3).toBe(rebasedHead); // same OID the runner produced

        // Step 7: Assert BOTH files are in the mirror.
        //
        // The attachment file (written at V2, out-of-band) must survive.
        const attachRead = await harness.engine.read(wsId, {
          path: '.ax/uploads/photo.png',
        });
        expect(attachRead.found).toBe(true);

        // The turn file (written in T2, replayed onto V2) must also be present.
        const turnRead = await harness.engine.read(wsId, {
          path: '.ax/projects/p1/t2.jsonl',
        });
        expect(turnRead.found).toBe(true);
        if (turnRead.found) {
          expect(new TextDecoder().decode(turnRead.bytes)).toBe(
            '{"role":"assistant","text":"world"}\n',
          );
        }

        // The first turn's file (written in T1) must also persist.
        const t1Read = await harness.engine.read(wsId, {
          path: '.ax/projects/p1/t1.jsonl',
        });
        expect(t1Read.found).toBe(true);
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
