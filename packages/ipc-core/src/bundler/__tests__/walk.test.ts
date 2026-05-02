import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBaselineBundle } from '../../handlers/workspace-materialize.js';
import { prepareScratchRepo } from '../scratch.js';
import { walkBundleChanges } from '../walk.js';

// ---------------------------------------------------------------------------
// walk.ts — tests against real bundles loaded into prepared scratch
// repos. Mirrors the production flow.
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

interface SimArgs {
  baselineFiles: ReadonlyArray<{ path: string; bytes: Buffer }>;
  turnFiles: Record<string, string | null>; // null = delete
  /** Some tests want binary content. */
  turnFilesBytes?: Record<string, Buffer>;
}

async function simulateTurn(
  args: SimArgs,
): Promise<{ bundleB64: string; baselineBundleB64: string }> {
  const { baselineFiles, turnFiles, turnFilesBytes = {} } = args;
  const baselineBundleB64 = await buildBaselineBundle({
    paths: baselineFiles.map((f) => f.path),
    read: async (p) => {
      const f = baselineFiles.find((x) => x.path === p);
      return f === undefined ? null : f.bytes;
    },
  });
  const baselineB64 = baselineBundleB64;
  const runnerRoot = await fs.mkdtemp(path.join(tmpdir(), 'ax-walk-sim-'));
  try {
    const bundlePath = path.join(runnerRoot, 'baseline.bundle');
    await fs.writeFile(bundlePath, Buffer.from(baselineB64, 'base64'));
    const wt = path.join(runnerRoot, 'wt');
    const cl = await git(['clone', '--branch', 'main', bundlePath, wt]);
    if (cl.code !== 0) throw new Error(`clone failed: ${cl.stderr}`);
    // Pin refs/heads/baseline to HEAD (mirrors materializeWorkspace).
    await git(['-C', wt, 'update-ref', 'refs/heads/baseline', 'HEAD']);
    await git(['-C', wt, 'config', 'user.name', 'ax-runner']);
    await git(['-C', wt, 'config', 'user.email', 'ax-runner@example.com']);

    for (const [p, content] of Object.entries(turnFiles)) {
      const abs = path.join(wt, p);
      if (content === null) {
        await fs.unlink(abs);
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
      }
    }
    for (const [p, bytes] of Object.entries(turnFilesBytes)) {
      const abs = path.join(wt, p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes);
    }

    await git(['-C', wt, 'add', '-A']);
    const c = await git(['-C', wt, 'commit', '-m', 'turn']);
    if (c.code !== 0) throw new Error(`commit failed: ${c.stderr}`);

    const bundle = await new Promise<Buffer>((resolve, reject) => {
      // `bundle create <range> <ref>` — see scratch.test.ts for why
      // the trailing ref matters.
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
    return { bundleB64: bundle.toString('base64'), baselineBundleB64 };
  } finally {
    await fs.rm(runnerRoot, { recursive: true, force: true });
  }
}

describe('walkBundleChanges', () => {
  it('emits put for an added file (turn-end shape)', async () => {
    const baselineFiles: Array<{ path: string; bytes: Buffer }> = [];
    const { bundleB64, baselineBundleB64 } = await simulateTurn({
      baselineFiles,
      turnFiles: { '.ax/CLAUDE.md': 'hi' },
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineBundleBytes: baselineBundleB64,
    });
    try {
      const r = await walkBundleChanges({
        repoPath: scratch.repoPath,
        baselineCommit: scratch.baselineCommit,
      });
      expect(r).toEqual([
        {
          path: '.ax/CLAUDE.md',
          kind: 'put',
          content: new Uint8Array(Buffer.from('hi')),
        },
      ]);
    } finally {
      await scratch.dispose();
    }
  });

  it('emits put for a modified file', async () => {
    const baselineFiles = [{ path: 'a.txt', bytes: Buffer.from('old') }];
    const { bundleB64, baselineBundleB64 } = await simulateTurn({
      baselineFiles,
      turnFiles: { 'a.txt': 'new' },
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineBundleBytes: baselineBundleB64,
    });
    try {
      const r = await walkBundleChanges({
        repoPath: scratch.repoPath,
        baselineCommit: scratch.baselineCommit,
      });
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ path: 'a.txt', kind: 'put' });
      if (r[0]?.kind === 'put') {
        expect(Buffer.from(r[0].content).toString('utf8')).toBe('new');
      }
    } finally {
      await scratch.dispose();
    }
  });

  it('emits delete for a removed file (Bash-delete gap closed)', async () => {
    // The model uses `Bash: rm` (no Write/Edit/MultiEdit involved).
    // Phase 3 catches it via git diff regardless of the tool used.
    const baselineFiles = [{ path: 'a.txt', bytes: Buffer.from('doomed') }];
    const { bundleB64, baselineBundleB64 } = await simulateTurn({
      baselineFiles,
      turnFiles: { 'a.txt': null },
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineBundleBytes: baselineBundleB64,
    });
    try {
      const r = await walkBundleChanges({
        repoPath: scratch.repoPath,
        baselineCommit: scratch.baselineCommit,
      });
      expect(r).toEqual([{ path: 'a.txt', kind: 'delete' }]);
    } finally {
      await scratch.dispose();
    }
  });

  it('aggregates a mix of add/modify/delete in one bundle', async () => {
    const baselineFiles = [
      { path: 'a.txt', bytes: Buffer.from('A1') },
      { path: 'b.txt', bytes: Buffer.from('B1') },
    ];
    const { bundleB64, baselineBundleB64 } = await simulateTurn({
      baselineFiles,
      turnFiles: { 'a.txt': 'A2', 'b.txt': null, 'c.txt': 'C1' },
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineBundleBytes: baselineBundleB64,
    });
    try {
      const r = await walkBundleChanges({
        repoPath: scratch.repoPath,
        baselineCommit: scratch.baselineCommit,
      });
      const byPath = new Map(r.map((c) => [c.path, c]));
      expect(byPath.size).toBe(3);
      expect(byPath.get('a.txt')?.kind).toBe('put');
      expect(byPath.get('b.txt')?.kind).toBe('delete');
      expect(byPath.get('c.txt')?.kind).toBe('put');
    } finally {
      await scratch.dispose();
    }
  });

  it('preserves binary content (NUL byte, high-bit) round-trip', async () => {
    const baselineFiles: Array<{ path: string; bytes: Buffer }> = [];
    const binary = Buffer.from([0x00, 0xff, 0x42, 0x00, 0x80]);
    const { bundleB64, baselineBundleB64 } = await simulateTurn({
      baselineFiles,
      turnFiles: {},
      turnFilesBytes: { 'bin.dat': binary },
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineBundleBytes: baselineBundleB64,
    });
    try {
      const r = await walkBundleChanges({
        repoPath: scratch.repoPath,
        baselineCommit: scratch.baselineCommit,
      });
      expect(r).toHaveLength(1);
      if (r[0]?.kind === 'put') {
        expect(Buffer.compare(Buffer.from(r[0].content), binary)).toBe(0);
      }
    } finally {
      await scratch.dispose();
    }
  });

  it('handles paths with spaces correctly (NUL-delimited diff-tree)', async () => {
    const baselineFiles: Array<{ path: string; bytes: Buffer }> = [];
    const weirdPath = 'foo bar/baz "quux".txt';
    const { bundleB64, baselineBundleB64 } = await simulateTurn({
      baselineFiles,
      turnFiles: { [weirdPath]: 'hello' },
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineBundleBytes: baselineBundleB64,
    });
    try {
      const r = await walkBundleChanges({
        repoPath: scratch.repoPath,
        baselineCommit: scratch.baselineCommit,
      });
      expect(r).toHaveLength(1);
      expect(r[0]?.path).toBe(weirdPath);
    } finally {
      await scratch.dispose();
    }
  });
});
