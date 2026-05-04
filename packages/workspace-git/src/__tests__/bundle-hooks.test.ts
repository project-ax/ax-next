// Regression: the local single-replica @ax/workspace-git backend MUST
// register the Phase 3 bundle hooks (workspace:export-baseline-bundle +
// workspace:apply-bundle). Without them, the host-side commit-notify
// handler rejects every multi-turn write — breaking /permanent
// persistence in the local CLI / single-pod kind path.
//
// The bundle wire is what the runner uses to ship turn-N's commits back
// to the host. The handler probes for export-baseline-bundle first
// (gating: a backend that ships only one half of the wire would silently
// regress on turn 2); both hooks ship together as the Phase 3 backend
// contract, mirroring @ax/workspace-git-server's registration set.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asWorkspaceVersion,
  type WorkspaceApplyBundleInput,
  type WorkspaceApplyBundleOutput,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceExportBaselineBundleInput,
  type WorkspaceExportBaselineBundleOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createWorkspaceGitPlugin } from '../plugin.js';

// Determinism env shape — must match BASELINE_ENV in
// @ax/workspace-git-server (and the materialize handler in @ax/ipc-core).
// If these drift, the runner's first thin bundle's prereq OID won't
// match what this backend reconstructs.
const SIM_BASELINE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ax-runner',
  GIT_AUTHOR_EMAIL: 'ax-runner@example.com',
  GIT_COMMITTER_NAME: 'ax-runner',
  GIT_COMMITTER_EMAIL: 'ax-runner@example.com',
  GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
};

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
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

interface SimulatedTurn {
  bundleB64: string;
  baselineCommit: string;
  turnPath: string;
  turnContent: string;
}

/**
 * Mirror the runner-side flow: build deterministic baseline (sorted
 * paths, fixed dates, --allow-empty + core.fileMode=false on `main`),
 * clone it, apply turn changes, bundle `baseline..main` thin.
 */
async function simulateRunnerTurn(args: {
  baselineFiles?: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
  turnPath: string;
  turnContent: string;
}): Promise<SimulatedTurn> {
  const root = mkdtempSync(join(tmpdir(), 'ax-ws-git-bundle-sim-'));
  try {
    // 1. Deterministic baseline.
    const baselineDir = path.join(root, 'baseline');
    await fs.mkdir(baselineDir, { recursive: true });
    await run(['init', '-b', 'main', baselineDir], undefined, SIM_BASELINE_ENV);
    await run(
      ['-C', baselineDir, 'config', 'core.fileMode', 'false'],
      undefined,
      SIM_BASELINE_ENV,
    );
    const baselineFiles = [...(args.baselineFiles ?? [])].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    for (const { path: p, bytes } of baselineFiles) {
      const abs = path.join(baselineDir, p);
      const dir = path.dirname(abs);
      if (dir !== baselineDir) await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(abs, bytes, { mode: 0o644 });
    }
    await run(['-C', baselineDir, 'add', '-A'], undefined, SIM_BASELINE_ENV);
    await run(
      ['-C', baselineDir, 'commit', '--allow-empty', '-m', 'baseline'],
      undefined,
      SIM_BASELINE_ENV,
    );
    const baselineHead = await run(
      ['-C', baselineDir, 'rev-parse', 'HEAD'],
      undefined,
      SIM_BASELINE_ENV,
    );
    const baselineCommit = baselineHead.stdout.trim();

    // 2. Bundle baseline so we can clone from it.
    const baselineBundle = path.join(root, 'baseline.bundle');
    await run(
      ['-C', baselineDir, 'bundle', 'create', baselineBundle, 'main'],
      undefined,
      SIM_BASELINE_ENV,
    );

    // 3. Clone + pin baseline ref.
    const wt = path.join(root, 'wt');
    const cl = await run(['clone', '--branch', 'main', baselineBundle, wt]);
    if (cl.code !== 0) throw new Error(`clone failed: ${cl.stderr}`);
    await run(['-C', wt, 'update-ref', 'refs/heads/baseline', 'HEAD']);
    await run(['-C', wt, 'config', 'user.name', 'ax-runner']);
    await run(['-C', wt, 'config', 'user.email', 'ax-runner@example.com']);

    // 4. Apply turn change.
    const abs = path.join(wt, args.turnPath);
    const dir = path.dirname(abs);
    if (dir !== wt) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(abs, args.turnContent);
    await run(['-C', wt, 'add', '-A']);
    await run(['-C', wt, 'commit', '-m', 'turn']);

    // 5. Bundle thin: `baseline..main` + the `main` ref.
    const turnBundleBuf = await new Promise<Buffer>((resolve, reject) => {
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
    return {
      bundleB64: turnBundleBuf.toString('base64'),
      baselineCommit,
      turnPath: args.turnPath,
      turnContent: args.turnContent,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('@ax/workspace-git bundle hooks (Phase 3)', () => {
  let repoRoot: string;
  let h: TestHarness;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-git-bundle-test-'));
    h = await createTestHarness({
      plugins: [createWorkspaceGitPlugin({ repoRoot })],
    });
  });

  afterEach(async () => {
    await h.close();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("manifest registers both Phase 3 bundle hooks", () => {
    const p = createWorkspaceGitPlugin({ repoRoot: '/tmp/x' });
    expect(p.manifest.registers).toEqual(
      expect.arrayContaining([
        'workspace:export-baseline-bundle',
        'workspace:apply-bundle',
      ]),
    );
  });

  it("export-baseline-bundle({version:null}) returns a deterministic empty baseline that git can verify", async () => {
    const out = await h.bus.call<
      WorkspaceExportBaselineBundleInput,
      WorkspaceExportBaselineBundleOutput
    >('workspace:export-baseline-bundle', h.ctx(), { version: null });

    expect(out.bundleBytes.length).toBeGreaterThan(0);
    // Verify the bytes are a valid git bundle by feeding to `git bundle verify`.
    const scratch = mkdtempSync(join(tmpdir(), 'ax-ws-bundle-verify-'));
    try {
      const bundlePath = join(scratch, 'baseline.bundle');
      await fs.writeFile(bundlePath, Buffer.from(out.bundleBytes, 'base64'));
      const init = await run(['init', '-b', 'main', scratch]);
      expect(init.code).toBe(0);
      const verify = await run(['-C', scratch, 'bundle', 'verify', bundlePath]);
      expect(verify.code).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("export-baseline-bundle({version:null}) OID matches the runner's deterministic baseline (cross-backend determinism)", async () => {
    // The runner builds its baseline with the same env shape; the OID
    // must match bit-for-bit so the runner's first thin bundle's prereq
    // points at the same commit this backend's bundle introduces.
    const sim = await simulateRunnerTurn({
      turnPath: 'permanent/test1.txt',
      turnContent: 'hello-permanent',
    });

    const exported = await h.bus.call<
      WorkspaceExportBaselineBundleInput,
      WorkspaceExportBaselineBundleOutput
    >('workspace:export-baseline-bundle', h.ctx(), { version: null });

    // Load the exported bundle into a scratch repo + read its tip OID.
    const scratch = mkdtempSync(join(tmpdir(), 'ax-ws-bundle-tip-'));
    try {
      const bundlePath = join(scratch, 'baseline.bundle');
      await fs.writeFile(
        bundlePath,
        Buffer.from(exported.bundleBytes, 'base64'),
      );
      const cl = await run(['clone', '--branch', 'main', bundlePath, scratch + '/clone']);
      expect(cl.code).toBe(0);
      const head = await run(['-C', scratch + '/clone', 'rev-parse', 'HEAD']);
      expect(head.code).toBe(0);
      expect(head.stdout.trim()).toBe(sim.baselineCommit);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("apply-bundle: round-trip a runner thin bundle into an empty workspace", async () => {
    const sim = await simulateRunnerTurn({
      turnPath: 'permanent/test1.txt',
      turnContent: 'hello-permanent',
    });

    const result = await h.bus.call<
      WorkspaceApplyBundleInput,
      WorkspaceApplyBundleOutput
    >('workspace:apply-bundle', h.ctx(), {
      bundleBytes: sim.bundleB64,
      baselineCommit: sim.baselineCommit,
      parent: null,
      reason: 'turn 1',
    });

    expect(result.version).toMatch(/^[0-9a-f]{40}$/);
    expect(result.version).not.toBe(sim.baselineCommit);
    expect(result.delta.before).toBeNull();
    expect(result.delta.after).toBe(result.version);
    expect(result.delta.changes.map((c) => c.path)).toEqual([sim.turnPath]);
    expect(result.delta.changes[0]?.kind).toBe('added');

    // The post-apply state survives a separate `read` — the actual
    // /permanent persistence guarantee.
    const read = await h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      h.ctx(),
      { path: sim.turnPath },
    );
    expect(read).toEqual({
      found: true,
      bytes: new TextEncoder().encode(sim.turnContent),
    });
  });

  it("apply-bundle: round-trip a multi-turn sequence (the actual broken path)", async () => {
    // Turn 1: write /permanent/test1.txt.
    const sim1 = await simulateRunnerTurn({
      turnPath: 'permanent/test1.txt',
      turnContent: 'hello-permanent',
    });
    const r1 = await h.bus.call<
      WorkspaceApplyBundleInput,
      WorkspaceApplyBundleOutput
    >('workspace:apply-bundle', h.ctx(), {
      bundleBytes: sim1.bundleB64,
      baselineCommit: sim1.baselineCommit,
      parent: null,
      reason: 'turn 1',
    });

    // Turn 2: the runner's NEW baseline = turn 1's tip (its local
    // baseline ref advanced after the prior accept). The host's
    // commit-notify handler calls export-baseline-bundle({version: r1.version})
    // to seed its scratch repo. We replay that flow:
    //   a. export the workspace at r1.version
    //   b. clone the export → make turn 2 change → bundle thin
    //   c. apply-bundle({baselineCommit: r1.version, parent: r1.version})
    const exported = await h.bus.call<
      WorkspaceExportBaselineBundleInput,
      WorkspaceExportBaselineBundleOutput
    >('workspace:export-baseline-bundle', h.ctx(), {
      version: r1.version,
    });

    const root = mkdtempSync(join(tmpdir(), 'ax-ws-git-turn2-'));
    let turn2BundleB64: string;
    try {
      const baselineBundle = path.join(root, 'baseline.bundle');
      await fs.writeFile(
        baselineBundle,
        Buffer.from(exported.bundleBytes, 'base64'),
      );
      const wt = path.join(root, 'wt');
      const cl = await run(['clone', '--branch', 'main', baselineBundle, wt]);
      if (cl.code !== 0) throw new Error(`turn2 clone failed: ${cl.stderr}`);
      // Pin baseline ref to the just-cloned head (= r1.version).
      await run(['-C', wt, 'update-ref', 'refs/heads/baseline', 'HEAD']);
      await run(['-C', wt, 'config', 'user.name', 'ax-runner']);
      await run(['-C', wt, 'config', 'user.email', 'ax-runner@example.com']);
      // Turn 2 change.
      await fs.mkdir(path.join(wt, 'permanent'), { recursive: true });
      await fs.writeFile(
        path.join(wt, 'permanent/test2.txt'),
        'hello-permanent-2',
      );
      await run(['-C', wt, 'add', '-A']);
      await run(['-C', wt, 'commit', '-m', 'turn 2']);
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
            : reject(new Error(`turn2 bundle exit=${code}: ${stderr}`)),
        );
      });
      turn2BundleB64 = buf.toString('base64');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const r2 = await h.bus.call<
      WorkspaceApplyBundleInput,
      WorkspaceApplyBundleOutput
    >('workspace:apply-bundle', h.ctx(), {
      bundleBytes: turn2BundleB64,
      baselineCommit: r1.version,
      parent: r1.version,
      reason: 'turn 2',
    });

    expect(r2.version).not.toBe(r1.version);

    // BOTH files persist after turn 2.
    const list = await h.bus.call<WorkspaceListInput, WorkspaceListOutput>(
      'workspace:list',
      h.ctx(),
      {},
    );
    expect([...list.paths].sort()).toEqual([
      'permanent/test1.txt',
      'permanent/test2.txt',
    ]);
    const r1Read = await h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      h.ctx(),
      { path: 'permanent/test1.txt' },
    );
    expect(r1Read).toEqual({
      found: true,
      bytes: new TextEncoder().encode('hello-permanent'),
    });
  });

  it("apply-bundle: parent-mismatch when caller's parent disagrees with HEAD", async () => {
    const sim = await simulateRunnerTurn({
      turnPath: 'a.txt',
      turnContent: 'A',
    });
    await h.bus.call<WorkspaceApplyBundleInput, WorkspaceApplyBundleOutput>(
      'workspace:apply-bundle',
      h.ctx(),
      {
        bundleBytes: sim.bundleB64,
        baselineCommit: sim.baselineCommit,
        parent: null,
        reason: 'turn 1',
      },
    );

    await expect(
      h.bus.call<WorkspaceApplyBundleInput, WorkspaceApplyBundleOutput>(
        'workspace:apply-bundle',
        h.ctx(),
        {
          bundleBytes: sim.bundleB64,
          baselineCommit: sim.baselineCommit,
          // Repo is non-empty now, so passing parent: null must fail.
          parent: null,
          reason: 'racey',
        },
      ),
    ).rejects.toMatchObject({ code: 'parent-mismatch' });
  });

  it("apply-bundle: seeded-baseline mismatch leaves the bare repo empty so retries can recover", async () => {
    // Regression: an apply-bundle against an empty repo with a baselineCommit
    // that doesn't match the deterministic seed used to push refs/heads/main
    // BEFORE checking the OID. On mismatch the repo was left non-empty,
    // making every subsequent retry with parent:null fail the parent-CAS
    // forever until someone manually deleted refs/heads/main. The fix:
    // validate the seed in scratch before pushing to gitdir.
    const wrongBaseline = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    // Build a real bundle from a real runner turn so the bundleBytes
    // parses; then deliberately lie about baselineCommit. The mismatch
    // must throw before any state lands in gitdir.
    const sim = await simulateRunnerTurn({
      turnPath: 'permanent/test1.txt',
      turnContent: 'hello-permanent',
    });
    await expect(
      h.bus.call<WorkspaceApplyBundleInput, WorkspaceApplyBundleOutput>(
        'workspace:apply-bundle',
        h.ctx(),
        {
          bundleBytes: sim.bundleB64,
          baselineCommit: wrongBaseline,
          parent: null,
          reason: 'mismatched',
        },
      ),
    ).rejects.toMatchObject({ code: 'parent-mismatch' });

    // The bare repo's HEAD must still be unset — a retry with the right
    // baseline + parent:null is what unwedges the workspace.
    const headFile = path.join(repoRoot, 'repo.git', 'refs', 'heads', 'main');
    let headExists = true;
    try {
      await fs.stat(headFile);
    } catch {
      headExists = false;
    }
    expect(headExists).toBe(false);

    // Sanity: a fresh apply with the right baseline + parent:null now succeeds.
    const recovery = await h.bus.call<
      WorkspaceApplyBundleInput,
      WorkspaceApplyBundleOutput
    >('workspace:apply-bundle', h.ctx(), {
      bundleBytes: sim.bundleB64,
      baselineCommit: sim.baselineCommit,
      parent: null,
      reason: 'recovery',
    });
    expect(recovery.version).toMatch(/^[0-9a-f]{40}$/);
  });

  it("apply-bundle: stale refs/bundle/* from a crashed prior apply don't wedge the next apply", async () => {
    // Regression: fetchBundleIntoBare used to clear refs/bundle/* only in
    // the trailing finally. A crash between `git fetch` and the cleanup
    // (or just an interrupted process) left stale temp refs; the next
    // apply's for-each-ref then saw multiple refs and threw on the count
    // check. Pre-clearing in the helper makes retries crash-safe by
    // construction.
    //
    // Simulate the crash by initializing the bare repo and planting a
    // stale loose ref under refs/bundle/. Empty-tree OID (known-fixed)
    // is a safe target — git's for-each-ref doesn't validate object
    // presence.
    const sim = await simulateRunnerTurn({
      turnPath: 'permanent/test1.txt',
      turnContent: 'hello-permanent',
    });
    const bareGitDir = path.join(repoRoot, 'repo.git');
    await run(['init', '--bare', '-b', 'main', bareGitDir]);
    // Plant the stale ref by writing the loose ref file directly. We use
    // the empty-tree OID (a fixed 40-hex git knows about); update-ref
    // would reject it on object-presence checks, so we go around the
    // plumbing the same way an interrupted prior apply would have.
    const emptyTreeOid = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const refPath = path.join(
      bareGitDir,
      'refs',
      'bundle',
      'heads',
      'main',
    );
    await fs.mkdir(path.dirname(refPath), { recursive: true });
    await fs.writeFile(refPath, emptyTreeOid + '\n');

    // Sanity-check the wedged state: for-each-ref sees the stale ref.
    const before = await run(
      ['-C', bareGitDir, 'for-each-ref', '--format=%(refname)', 'refs/bundle/'],
    );
    expect(before.stdout.trim()).toBe('refs/bundle/heads/main');

    // With the stale ref in place, apply-bundle must still succeed —
    // the pre-clear in fetchBundleIntoBare drops refs/bundle/* before
    // the new fetch.
    const result = await h.bus.call<
      WorkspaceApplyBundleInput,
      WorkspaceApplyBundleOutput
    >('workspace:apply-bundle', h.ctx(), {
      bundleBytes: sim.bundleB64,
      baselineCommit: sim.baselineCommit,
      parent: null,
      reason: 'after-crash',
    });
    expect(result.version).toMatch(/^[0-9a-f]{40}$/);

    // After a successful apply, refs/bundle/* is empty (the trailing
    // cleanup still runs).
    const after = await run(
      ['-C', bareGitDir, 'for-each-ref', '--format=%(refname)', 'refs/bundle/'],
    );
    expect(after.stdout.trim()).toBe('');
  });

  it("export-baseline-bundle({version: <existing-oid>}) bundles the workspace state at that version", async () => {
    // First write something via the FileChange path to make sure
    // export works against state produced by workspace:apply (not just
    // bundle-applied state).
    const r1 = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      h.ctx(),
      {
        changes: [
          {
            path: 'hello.txt',
            kind: 'put',
            content: new TextEncoder().encode('world'),
          },
        ],
        parent: null,
      },
    );

    const out = await h.bus.call<
      WorkspaceExportBaselineBundleInput,
      WorkspaceExportBaselineBundleOutput
    >('workspace:export-baseline-bundle', h.ctx(), {
      version: asWorkspaceVersion(r1.version),
    });

    // Bundle's tip OID should equal r1.version.
    const scratch = mkdtempSync(join(tmpdir(), 'ax-ws-bundle-existing-'));
    try {
      const bundlePath = join(scratch, 'b.bundle');
      await fs.writeFile(bundlePath, Buffer.from(out.bundleBytes, 'base64'));
      const cl = await run([
        'clone',
        '--branch',
        'main',
        bundlePath,
        scratch + '/clone',
      ]);
      expect(cl.code).toBe(0);
      const head = await run([
        '-C',
        scratch + '/clone',
        'rev-parse',
        'HEAD',
      ]);
      expect(head.stdout.trim()).toBe(r1.version);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
