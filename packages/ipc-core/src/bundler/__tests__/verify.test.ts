import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBaselineBundle } from '../../handlers/workspace-materialize.js';
import { prepareScratchRepo } from '../scratch.js';
import { parseAuthorCommitter, verifyBundleAuthor } from '../verify.js';

// ---------------------------------------------------------------------------
// verify.ts — tests against real bundles loaded into prepared scratch
// repos. Mirrors the production flow: simulate the runner producing a
// turn bundle (with controllable author identity), prepare a scratch
// repo, then verify.
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
  turnFiles: Record<string, string>;
  /** Author for the turn commit (defaults to ax-runner). */
  turnAuthor?: string;
  /** Committer for the turn (defaults to turnAuthor). */
  turnCommitter?: string;
}

/**
 * Simulate runner's turn-end bundle. Returns the bundle bytes plus
 * the baselineFiles so the caller can pass both to prepareScratchRepo.
 */
async function simulateTurn(args: SimArgs): Promise<{ bundleB64: string }> {
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
      return f === undefined ? null : f.bytes;
    },
  });

  const runnerRoot = await fs.mkdtemp(path.join(tmpdir(), 'ax-vfy-sim-'));
  try {
    const bundlePath = path.join(runnerRoot, 'baseline.bundle');
    await fs.writeFile(bundlePath, Buffer.from(baselineB64, 'base64'));
    const wt = path.join(runnerRoot, 'wt');
    const cl = await git(['clone', '--branch', 'baseline', bundlePath, wt]);
    if (cl.code !== 0) throw new Error(`clone failed: ${cl.stderr}`);
    // Move HEAD off baseline (mirrors materializeWorkspace).
    await git(['-C', wt, 'checkout', '-b', 'main']);

    for (const [p, content] of Object.entries(turnFiles)) {
      const abs = path.join(wt, p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
    await git(['-C', wt, 'add', '-A']);

    // Commit with author/committer override env. Both can be the same
    // string or different — verify checks both.
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: turnAuthor,
      GIT_AUTHOR_EMAIL: `${turnAuthor}@example.com`,
      GIT_COMMITTER_NAME: turnCommitter,
      GIT_COMMITTER_EMAIL: `${turnCommitter}@example.com`,
    };
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['-C', wt, 'commit', '-m', 'turn'], { env });
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`commit exit=${code}: ${stderr}`)),
      );
    });

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
    return { bundleB64: bundle.toString('base64') };
  } finally {
    await fs.rm(runnerRoot, { recursive: true, force: true });
  }
}

describe('verifyBundleAuthor', () => {
  it('accepts a turn bundle whose commit is authored by ax-runner', async () => {
    const baselineFiles = [{ path: 'a.txt', bytes: Buffer.from('A') }];
    const { bundleB64 } = await simulateTurn({
      baselineFiles,
      turnFiles: { 'b.txt': 'B' },
      turnAuthor: 'ax-runner',
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineFiles,
    });
    try {
      await expect(
        verifyBundleAuthor({
          repoPath: scratch.repoPath,
          baselineCommit: scratch.baselineCommit,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await scratch.dispose();
    }
  });

  it('rejects a bundle authored by someone other than ax-runner', async () => {
    const baselineFiles = [{ path: 'a.txt', bytes: Buffer.from('A') }];
    const { bundleB64 } = await simulateTurn({
      baselineFiles,
      turnFiles: { 'b.txt': 'B' },
      turnAuthor: 'eve',
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineFiles,
    });
    try {
      await expect(
        verifyBundleAuthor({
          repoPath: scratch.repoPath,
          baselineCommit: scratch.baselineCommit,
        }),
      ).rejects.toThrow(/author=.*eve/);
    } finally {
      await scratch.dispose();
    }
  });

  it('rejects a bundle whose committer differs (author-set + committer-replaced)', async () => {
    const baselineFiles = [{ path: 'a.txt', bytes: Buffer.from('A') }];
    const { bundleB64 } = await simulateTurn({
      baselineFiles,
      turnFiles: { 'b.txt': 'B' },
      turnAuthor: 'ax-runner',
      turnCommitter: 'eve',
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineFiles,
    });
    try {
      await expect(
        verifyBundleAuthor({
          repoPath: scratch.repoPath,
          baselineCommit: scratch.baselineCommit,
        }),
      ).rejects.toThrow(/committer=.*eve/);
    } finally {
      await scratch.dispose();
    }
  });

  it('rejects a bundle with a name that contains "ax-runner" as a substring', async () => {
    const baselineFiles = [{ path: 'a.txt', bytes: Buffer.from('A') }];
    const { bundleB64 } = await simulateTurn({
      baselineFiles,
      turnFiles: { 'b.txt': 'B' },
      turnAuthor: 'evil-ax-runner',
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineFiles,
    });
    try {
      await expect(
        verifyBundleAuthor({
          repoPath: scratch.repoPath,
          baselineCommit: scratch.baselineCommit,
        }),
      ).rejects.toThrow(/evil-ax-runner/);
    } finally {
      await scratch.dispose();
    }
  });

  it('rejects a bundle with a name that differs only by case', async () => {
    const baselineFiles = [{ path: 'a.txt', bytes: Buffer.from('A') }];
    const { bundleB64 } = await simulateTurn({
      baselineFiles,
      turnFiles: { 'b.txt': 'B' },
      turnAuthor: 'Ax-Runner',
    });
    const scratch = await prepareScratchRepo({
      bundleBytes: bundleB64,
      baselineFiles,
    });
    try {
      await expect(
        verifyBundleAuthor({
          repoPath: scratch.repoPath,
          baselineCommit: scratch.baselineCommit,
        }),
      ).rejects.toThrow(/Ax-Runner/);
    } finally {
      await scratch.dispose();
    }
  });
});

describe('parseAuthorCommitter (pure helper)', () => {
  it('extracts both names from a canonical cat-file body', () => {
    const body =
      'tree abc123\n' +
      'parent def456\n' +
      'author ax-runner <ax-runner@example.com> 1234567890 +0000\n' +
      'committer ax-runner <ax-runner@example.com> 1234567890 +0000\n' +
      '\n' +
      'commit message body\n';
    expect(parseAuthorCommitter(body)).toEqual({
      authorName: 'ax-runner',
      committerName: 'ax-runner',
    });
  });

  it('handles multi-word names', () => {
    const body =
      'tree abc\n' +
      'author First Last <a@b.c> 1 +0\n' +
      'committer Second Last <a@b.c> 1 +0\n' +
      '\n' +
      'msg\n';
    expect(parseAuthorCommitter(body)).toEqual({
      authorName: 'First Last',
      committerName: 'Second Last',
    });
  });

  it('handles a root commit (no parent line)', () => {
    const body =
      'tree abc\n' +
      'author ax-runner <a@b.c> 1 +0\n' +
      'committer ax-runner <a@b.c> 1 +0\n' +
      '\n' +
      'msg\n';
    expect(parseAuthorCommitter(body)).toEqual({
      authorName: 'ax-runner',
      committerName: 'ax-runner',
    });
  });

  it('returns empty strings when fields are missing (defensive)', () => {
    const body = 'tree abc\nparent def\n\nmsg\n';
    expect(parseAuthorCommitter(body)).toEqual({
      authorName: '',
      committerName: '',
    });
  });
});
