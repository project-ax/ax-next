import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceBaseline,
  commitTurnAndBundle,
  materializeWorkspace,
  rollbackToBaseline,
} from '../git-workspace.js';

// ---------------------------------------------------------------------------
// git-workspace.ts — tests against a real `git` binary in tempdirs.
//
// The runner module is the boundary between the sandbox-side IPC and the
// disk; mocking out git would test the wrong thing. We need real git here
// so a future runtime that breaks the env contract (HOME, GIT_CONFIG_*)
// surfaces as a test failure, not as a silent in-prod degradation.
// ---------------------------------------------------------------------------

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function git(
  args: readonly string[],
  cwd?: string,
): Promise<SpawnResult> {
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
 * Build a baseline bundle containing the given files. Returns the bundle
 * bytes (base64-encoded). Mirrors the host-side `buildBaselineBundle`
 * shape so we can exercise the runner's clone path realistically.
 */
async function makeBundle(files: Record<string, string>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(tmpdir(), 'ax-rb-'));
  try {
    await git(['init', '-b', 'baseline', tmp]);
    // Author + committer must be set; we use the same identity the host
    // bundler uses, but for this test it just needs to be SOMETHING valid.
    await git(['-C', tmp, 'config', 'user.email', 'test@example.com']);
    await git(['-C', tmp, 'config', 'user.name', 'test']);
    for (const [p, content] of Object.entries(files)) {
      const abs = path.join(tmp, p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
    await git(['-C', tmp, 'add', '-A']);
    // --allow-empty so empty `files` produces a bundle with one
    // empty-tree commit (mirrors the host's always-bundle contract).
    await git(['-C', tmp, 'commit', '--allow-empty', '-m', 'baseline']);
    const bundle = await new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['-C', tmp, 'bundle', 'create', '-', 'baseline']);
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.once('error', reject);
      child.once('close', () => resolve(Buffer.concat(chunks).toString('base64')));
    });
    return bundle;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

let scratchRoot: string;

beforeEach(async () => {
  // Allocate a parent dir for each test; the test owns whatever subpath
  // it uses for `root`.
  scratchRoot = await fs.mkdtemp(path.join(tmpdir(), 'ax-runner-'));
});

afterEach(async () => {
  await fs.rm(scratchRoot, { recursive: true, force: true });
});

describe('materializeWorkspace', () => {
  it('rejects an empty bundleBase64 (Phase 3 always-bundle contract)', async () => {
    // Wire contract: workspace.materialize ALWAYS ships a non-empty
    // bundle (one commit on refs/heads/baseline, possibly with an
    // empty tree for brand-new workspaces). An empty bundle here
    // means the host is broken or the wire was tampered with —
    // bootstrap-fatal.
    const root = path.join(scratchRoot, 'permanent');
    await expect(
      materializeWorkspace({ root, bundleBase64: '' }),
    ).rejects.toThrow(/empty bundleBase64/);
  });

  it('clones from an empty-tree baseline bundle (brand-new workspace)', async () => {
    // The host's empty-workspace materialize ships a baseline bundle
    // with one commit whose tree is the empty tree. Runner clones it,
    // ends up with an empty working tree but a valid baseline ref.
    const bundleB64 = await makeBundle({});
    const root = path.join(scratchRoot, 'permanent');

    await materializeWorkspace({ root, bundleBase64: bundleB64 });

    // Working tree is empty (no entries other than .git).
    const entries = (await fs.readdir(root)).filter((e) => e !== '.git');
    expect(entries).toEqual([]);

    // baseline ref exists and == HEAD.
    const baseline = await git(['-C', root, 'rev-parse', 'refs/heads/baseline']);
    const head = await git(['-C', root, 'rev-parse', 'HEAD']);
    expect(baseline.stdout.trim()).toBe(head.stdout.trim());
    expect(baseline.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('clones from a non-empty baseline bundle and pins refs/heads/baseline to HEAD', async () => {
    const bundleB64 = await makeBundle({ '.ax/CLAUDE.md': 'hello\n' });
    const root = path.join(scratchRoot, 'permanent');

    await materializeWorkspace({ root, bundleBase64: bundleB64 });

    // The file should be on disk.
    expect(
      await fs.readFile(path.join(root, '.ax/CLAUDE.md'), 'utf8'),
    ).toBe('hello\n');

    // `refs/heads/baseline` must exist and equal HEAD so the next
    // `bundle baseline..HEAD` is well-defined.
    const baselineRef = await git(['-C', root, 'rev-parse', 'refs/heads/baseline']);
    const headRef = await git(['-C', root, 'rev-parse', 'HEAD']);
    expect(baselineRef.code).toBe(0);
    expect(headRef.code).toBe(0);
    expect(baselineRef.stdout.trim()).toBe(headRef.stdout.trim());
    expect(baselineRef.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('clones with nested directory contents intact', async () => {
    const bundleB64 = await makeBundle({
      '.ax/CLAUDE.md': '# memory',
      '.ax/skills/foo/SKILL.md': '---\nname: foo\n---\n',
      'src/main.ts': 'export {};\n',
    });
    const root = path.join(scratchRoot, 'permanent');

    await materializeWorkspace({ root, bundleBase64: bundleB64 });

    expect(await fs.readFile(path.join(root, '.ax/CLAUDE.md'), 'utf8')).toBe(
      '# memory',
    );
    expect(
      await fs.readFile(path.join(root, '.ax/skills/foo/SKILL.md'), 'utf8'),
    ).toBe('---\nname: foo\n---\n');
    expect(await fs.readFile(path.join(root, 'src/main.ts'), 'utf8')).toBe(
      'export {};\n',
    );
  });

  it('cleans up the temporary .baseline.bundle file after clone', async () => {
    const bundleB64 = await makeBundle({ 'a.txt': 'a' });
    const root = path.join(scratchRoot, 'permanent');

    await materializeWorkspace({ root, bundleBase64: bundleB64 });

    // The temp file lives at `${root}.baseline.bundle` — outside the clone
    // target. After successful materialize it must be unlinked.
    const bundleFile = `${root}.baseline.bundle`;
    let exists = true;
    try {
      await fs.stat(bundleFile);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('throws a useful error when bundleBase64 is invalid', async () => {
    const root = path.join(scratchRoot, 'permanent');
    // Garbage that's syntactically base64 but not a valid bundle.
    const notABundle = Buffer.from('this is not a bundle').toString('base64');
    await expect(
      materializeWorkspace({ root, bundleBase64: notABundle }),
    ).rejects.toThrow(/git clone failed/);
  });
});

// ---------------------------------------------------------------------------
// Turn-end helpers (Slice 7).
// ---------------------------------------------------------------------------

/**
 * Set up `/permanent` as a real materialized workspace, ready for
 * turn-end ops. Returns the permanent dir + the baseline OID.
 */
async function setupMaterializedWorkspace(args: {
  baselineFiles?: Record<string, string>;
} = {}): Promise<{ root: string; baselineOid: string }> {
  const baselineFiles = args.baselineFiles ?? {};
  const root = path.join(scratchRoot, 'permanent');
  // makeBundle expects a Record<string, string>; mirrors the wire shape
  // the host's materialize handler produces.
  const bundleB64 = await makeBundle(baselineFiles);
  await materializeWorkspace({ root, bundleBase64: bundleB64 });
  // After materialize: refs/heads/baseline pinned, HEAD on `main`
  // (created by checkout -b main during materialize).
  const baselineOid = (
    await git(['-C', root, 'rev-parse', 'refs/heads/baseline'])
  ).stdout.trim();
  // Ensure ax-runner identity is configured for the runner-side
  // commits the test will make. (In production, env vars from the pod
  // spec set this; tests set it via per-repo config.)
  await git(['-C', root, 'config', 'user.name', 'ax-runner']);
  await git(['-C', root, 'config', 'user.email', 'ax-runner@example.com']);
  return { root, baselineOid };
}

describe('commitTurnAndBundle', () => {
  it('returns null for an empty turn (no staged changes)', async () => {
    const { root } = await setupMaterializedWorkspace();
    const r = await commitTurnAndBundle({ root, reason: 'turn' });
    expect(r).toBeNull();
  });

  it('catches a Bash-style file create (raw fs write, no SDK tool)', async () => {
    // Phase 3 motivation: PostToolUse-based observation missed Bash
    // writes. git status sees ALL writes regardless of tool.
    const { root, baselineOid } = await setupMaterializedWorkspace();
    await fs.writeFile(path.join(root, 'created-by-bash.txt'), 'hello\n');

    const bundleB64 = await commitTurnAndBundle({ root, reason: 'turn' });
    expect(bundleB64).not.toBeNull();
    expect(bundleB64!.length).toBeGreaterThan(0);

    // Verify the bundle round-trips: clone it elsewhere and check the
    // file is there.
    const verifyDir = path.join(scratchRoot, 'verify-bash');
    const bundleFile = path.join(scratchRoot, 'b.bundle');
    await fs.writeFile(bundleFile, Buffer.from(bundleB64!, 'base64'));

    // The bundle is thin (baseline..main); we need the baseline as a
    // prereq. Clone the workspace itself, which has both.
    await git(['clone', root, verifyDir]);
    expect(
      await fs.readFile(path.join(verifyDir, 'created-by-bash.txt'), 'utf8'),
    ).toBe('hello\n');

    // Confirm baseline didn't move (commitTurnAndBundle doesn't
    // advance baseline; that's advanceBaseline's job).
    const baselineNow = (
      await git(['-C', root, 'rev-parse', 'refs/heads/baseline'])
    ).stdout.trim();
    expect(baselineNow).toBe(baselineOid);
  });

  it('catches a Bash-style delete (closes the gap that motivated Phase 3)', async () => {
    // Plain `rm` on the filesystem — no SDK tool involved. Pre-Phase-3
    // observation missed this entirely; git status catches it.
    const { root } = await setupMaterializedWorkspace({
      baselineFiles: { 'doomed.txt': 'will be deleted' },
    });
    await fs.unlink(path.join(root, 'doomed.txt'));

    const bundleB64 = await commitTurnAndBundle({ root, reason: 'turn' });
    expect(bundleB64).not.toBeNull();

    // Verify the delete is in the bundle: clone, check the file is gone.
    const verifyDir = path.join(scratchRoot, 'verify-del');
    await git(['clone', root, verifyDir]);
    let exists = true;
    try {
      await fs.stat(path.join(verifyDir, 'doomed.txt'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('aggregates multi-file changes in one bundle', async () => {
    const { root } = await setupMaterializedWorkspace({
      baselineFiles: { 'old.txt': 'A1' },
    });
    await fs.writeFile(path.join(root, 'old.txt'), 'A2'); // modify
    await fs.writeFile(path.join(root, 'new.txt'), 'B1'); // add
    await fs.mkdir(path.join(root, '.ax'), { recursive: true });
    await fs.writeFile(path.join(root, '.ax/CLAUDE.md'), '# memory'); // add nested

    const bundleB64 = await commitTurnAndBundle({ root, reason: 'turn' });
    expect(bundleB64).not.toBeNull();

    const verifyDir = path.join(scratchRoot, 'verify-multi');
    await git(['clone', root, verifyDir]);
    expect(await fs.readFile(path.join(verifyDir, 'old.txt'), 'utf8')).toBe('A2');
    expect(await fs.readFile(path.join(verifyDir, 'new.txt'), 'utf8')).toBe('B1');
    expect(
      await fs.readFile(path.join(verifyDir, '.ax/CLAUDE.md'), 'utf8'),
    ).toBe('# memory');
  });

  it('cleans up the .turn.bundle tempfile after success', async () => {
    const { root } = await setupMaterializedWorkspace();
    await fs.writeFile(path.join(root, 'a.txt'), 'A');
    await commitTurnAndBundle({ root, reason: 'turn' });

    const bundleFile = `${root}.turn.bundle`;
    let exists = true;
    try {
      await fs.stat(bundleFile);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});

describe('advanceBaseline', () => {
  it('moves refs/heads/baseline to current HEAD', async () => {
    const { root, baselineOid } = await setupMaterializedWorkspace();
    await fs.writeFile(path.join(root, 'a.txt'), 'A');
    await commitTurnAndBundle({ root, reason: 'turn' });

    const headBefore = (await git(['-C', root, 'rev-parse', 'HEAD']))
      .stdout.trim();
    expect(headBefore).not.toBe(baselineOid);

    await advanceBaseline(root);
    const baselineAfter = (
      await git(['-C', root, 'rev-parse', 'refs/heads/baseline'])
    ).stdout.trim();
    expect(baselineAfter).toBe(headBefore);
  });

  it('after advance, the next turn bundles from the new baseline', async () => {
    const { root } = await setupMaterializedWorkspace();
    // Turn 1.
    await fs.writeFile(path.join(root, 'a.txt'), 'A1');
    const turn1 = await commitTurnAndBundle({ root, reason: 'turn 1' });
    expect(turn1).not.toBeNull();
    await advanceBaseline(root);

    // Turn 2.
    await fs.writeFile(path.join(root, 'b.txt'), 'B1');
    const turn2 = await commitTurnAndBundle({ root, reason: 'turn 2' });
    expect(turn2).not.toBeNull();

    // Turn 2's bundle should contain only b.txt (a.txt is in baseline now).
    const verifyDir = path.join(scratchRoot, 'verify-t2');
    const bundleFile = path.join(scratchRoot, 't2.bundle');
    await fs.writeFile(bundleFile, Buffer.from(turn2!, 'base64'));
    // Clone the workspace itself (has the prereq).
    await git(['clone', root, verifyDir]);
    expect(await fs.readFile(path.join(verifyDir, 'a.txt'), 'utf8')).toBe('A1');
    expect(await fs.readFile(path.join(verifyDir, 'b.txt'), 'utf8')).toBe('B1');
  });
});

describe('rollbackToBaseline', () => {
  it('wipes the working tree back to baseline (file added on turn disappears)', async () => {
    const { root } = await setupMaterializedWorkspace();
    await fs.writeFile(path.join(root, 'wip.txt'), 'wip');
    await commitTurnAndBundle({ root, reason: 'turn' });
    // Confirm the file IS there before rollback.
    expect(await fs.readFile(path.join(root, 'wip.txt'), 'utf8')).toBe('wip');

    await rollbackToBaseline(root);

    // File is gone post-rollback.
    let exists = true;
    try {
      await fs.stat(path.join(root, 'wip.txt'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('restores deleted files when rolled back', async () => {
    // The agent deleted a baseline file; host vetoed; the file should
    // come back.
    const { root } = await setupMaterializedWorkspace({
      baselineFiles: { 'important.txt': 'do not delete' },
    });
    await fs.unlink(path.join(root, 'important.txt'));
    await commitTurnAndBundle({ root, reason: 'turn' });

    await rollbackToBaseline(root);

    expect(
      await fs.readFile(path.join(root, 'important.txt'), 'utf8'),
    ).toBe('do not delete');
  });

  it('moves HEAD back to baseline after rollback', async () => {
    const { root, baselineOid } = await setupMaterializedWorkspace();
    await fs.writeFile(path.join(root, 'a.txt'), 'A');
    await commitTurnAndBundle({ root, reason: 'turn' });

    await rollbackToBaseline(root);

    const head = (await git(['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    expect(head).toBe(baselineOid);
  });
});
