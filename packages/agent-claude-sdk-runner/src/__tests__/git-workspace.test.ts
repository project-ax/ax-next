import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materializeWorkspace } from '../git-workspace.js';

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
