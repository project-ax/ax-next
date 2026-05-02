import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBaselineBundle } from '../../handlers/workspace-materialize.js';
import { prepareScratchRepo } from '../scratch.js';

// ---------------------------------------------------------------------------
// scratch.ts — load-bearing test for the deterministic baseline +
// thin-bundle prepare pipeline.
//
// The setup mimics production:
//   1. Host calls buildBaselineBundle({paths, read}) → ships bundle to
//      runner.
//   2. Runner clones, makes turn commits, ships
//      `git bundle baseline..HEAD` back.
//   3. Host calls prepareScratchRepo({bundleBytes, baselineFiles}) to
//      reload state.
//
// If determinism breaks anywhere, this test surfaces it as a "fatal:
// bad object <oid>" from `git fetch`.
// ---------------------------------------------------------------------------

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function git(args: readonly string[], cwd?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Simulate the full round-trip: host builds baseline → runner clones,
 * commits, bundles → returns the per-turn bundle bytes. Mirrors what
 * production will do at session-start + turn-end.
 */
async function simulateRunnerTurn(args: {
  baselineFiles: ReadonlyArray<{ path: string; bytes: Buffer }>;
  turnFiles: Record<string, string | null>; // null = delete
  /** Override commit author for the turn (defaults to ax-runner). */
  turnAuthor?: string;
}): Promise<{ bundleB64: string; baselineBundleB64: string }> {
  const { baselineFiles, turnFiles, turnAuthor = 'ax-runner' } = args;

  // 1. Host builds + ships baseline.
  const baselineBundleB64 = await buildBaselineBundle({
    paths: baselineFiles.map((f) => f.path),
    read: async (p) => {
      const f = baselineFiles.find((x) => x.path === p);
      return f === undefined ? null : f.bytes;
    },
  });
  const baselineB64 = baselineBundleB64;

  // 2. Runner clones the bundle into a working tree, makes turn
  //    commits, bundles back. We use real git here because the runner
  //    does too.
  const runnerRoot = await fs.mkdtemp(path.join(tmpdir(), 'ax-runner-sim-'));
  try {
    const bundlePath = path.join(runnerRoot, 'baseline.bundle');
    await fs.writeFile(bundlePath, Buffer.from(baselineB64, 'base64'));
    const wt = path.join(runnerRoot, 'wt');
    const cl = await git(['clone', '--branch', 'main', bundlePath, wt]);
    if (cl.code !== 0) throw new Error(`clone failed: ${cl.stderr}`);
    // Pin refs/heads/baseline to HEAD (mirrors materializeWorkspace).
    // Subsequent commits advance `main` while `baseline` stays put.
    await git(['-C', wt, 'update-ref', 'refs/heads/baseline', 'HEAD']);

    // Configure runner identity.
    await git(['-C', wt, 'config', 'user.name', turnAuthor]);
    await git(['-C', wt, 'config', 'user.email', `${turnAuthor}@example.com`]);

    // Apply turnFiles.
    for (const [p, content] of Object.entries(turnFiles)) {
      const abs = path.join(wt, p);
      if (content === null) {
        await fs.unlink(abs);
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
      }
    }
    await git(['-C', wt, 'add', '-A']);
    const commit = await git(['-C', wt, 'commit', '-m', 'turn']);
    if (commit.code !== 0) throw new Error(`commit failed: ${commit.stderr}`);

    // Bundle the turn (`baseline..HEAD` — thin).
    const bundle = await new Promise<Buffer>((resolve, reject) => {
      // `bundle create <range> <ref>` — the range provides the commits;
      // the trailing ref ensures the bundle ships a named ref the host
      // can identify on fetch. Without the trailing ref, the bundle is
      // a packfile with no refs and `git fetch` reports "bundle has no
      // refs."
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
          : reject(new Error(`bundle failed: ${stderr}`)),
      );
    });
    return { bundleB64: bundle.toString('base64'), baselineBundleB64 };
  } finally {
    await fs.rm(runnerRoot, { recursive: true, force: true });
  }
}

describe('prepareScratchRepo', () => {
  it('loads the runner thin bundle and exposes baseline..HEAD as expected', async () => {
    const { bundleB64, baselineBundleB64 } = await simulateRunnerTurn({
      baselineFiles: [{ path: 'a.txt', bytes: Buffer.from('A') }],
      turnFiles: { 'b.txt': 'B' },
    });

    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineBundleBytes: baselineBundleB64,
    });
    try {
      // baselineCommit reachable.
      const baseline = await git(
        ['-C', scratch.repoPath, 'rev-parse', scratch.baselineCommit],
      );
      expect(baseline.code).toBe(0);
      expect(baseline.stdout.trim()).toBe(scratch.baselineCommit);

      // HEAD points at the bundle's tip (after symbolic-ref).
      const head = await git(['-C', scratch.repoPath, 'rev-parse', 'HEAD']);
      expect(head.code).toBe(0);
      const headOid = head.stdout.trim();
      expect(headOid).toMatch(/^[0-9a-f]{40}$/);
      expect(headOid).not.toBe(scratch.baselineCommit);

      // baseline..HEAD walk yields exactly one commit (the turn).
      const range = await git(
        ['-C', scratch.repoPath, 'rev-list', `${scratch.baselineCommit}..HEAD`],
      );
      expect(range.code).toBe(0);
      expect(
        range.stdout
          .trim()
          .split('\n')
          .filter((s) => s.length > 0),
      ).toHaveLength(1);

      // The new file is in HEAD's tree.
      const ls = await git(['-C', scratch.repoPath, 'ls-tree', 'HEAD']);
      expect(ls.code).toBe(0);
      expect(ls.stdout).toContain('b.txt');
    } finally {
      await scratch.dispose();
    }
  });

  it('rejects empty bundleBytes (caller should short-circuit before)', async () => {
    // Need a real baseline bundle for the test (any non-empty one will do).
    const { baselineBundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: { 'x.txt': 'x' },
    });
    await expect(
      prepareScratchRepo({
        bundleBytes: '',
        baselineBundleBytes: baselineBundleB64,
      }),
    ).rejects.toThrow(/empty bundleBytes/);
  });

  it('rejects empty baselineBundleBytes', async () => {
    const { bundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: { 'x.txt': 'x' },
    });
    await expect(
      prepareScratchRepo({
        bundleBytes: bundleB64,
        baselineBundleBytes: '',
      }),
    ).rejects.toThrow(/empty baselineBundleBytes/);
  });

  it('rejects when baseline bundle OID does not match the thin bundle prereq', async () => {
    // Build a thin bundle against one baseline, but try to load it on
    // top of a DIFFERENT baseline. The thin bundle's prereq won't be
    // in the loaded baseline → fetch fails.
    const { bundleB64 } = await simulateRunnerTurn({
      baselineFiles: [{ path: 'a.txt', bytes: Buffer.from('A') }],
      turnFiles: { 'b.txt': 'B' },
    });
    const { baselineBundleB64: differentBaseline } = await simulateRunnerTurn({
      baselineFiles: [{ path: 'a.txt', bytes: Buffer.from('DIFFERENT') }],
      turnFiles: { 'noop.txt': 'noop' },
    });

    await expect(
      prepareScratchRepo({
        bundleBytes: bundleB64,
        baselineBundleBytes: differentBaseline,
      }),
    ).rejects.toThrow(/fetch.*bundle failed/);
  });

  it('handles an empty-baseline + turn-adds-files scenario (brand-new workspace)', async () => {
    // Host materialize ships an empty-tree baseline; runner adds files
    // in turn 1.
    const { bundleB64, baselineBundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: { '.ax/CLAUDE.md': 'first turn writes memory' },
    });

    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineBundleBytes: baselineBundleB64,
    });
    try {
      const ls = await git(['-C', scratch.repoPath, 'ls-tree', '-r', 'HEAD']);
      expect(ls.stdout).toContain('.ax/CLAUDE.md');
    } finally {
      await scratch.dispose();
    }
  });

  it('dispose() is idempotent', async () => {
    const { bundleB64, baselineBundleB64 } = await simulateRunnerTurn({
      baselineFiles: [],
      turnFiles: { 'x.txt': 'x' },
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineBundleBytes: baselineBundleB64,
    });
    await scratch.dispose();
    await expect(scratch.dispose()).resolves.toBeUndefined();
  });
});
