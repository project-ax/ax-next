import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceBaseline,
  commitTurnAndBundle,
  materializeWorkspace,
  resyncBaselineAndReplay,
  rollbackToBaseline,
  scaffoldSdkProjectsSymlink,
  scaffoldWorkspaceGitignore,
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
 * Build a baseline bundle FILE containing the given files; returns its PATH.
 * Mirrors the host-side `buildBaselineBundle` shape so we exercise the runner's
 * clone path realistically. The bundle now arrives at materializeWorkspace as a
 * file on disk (BUG-W3 — the IPC client streams the raw octet-stream body
 * there), not as a base64 string. The file is written under `scratchRoot`
 * (cleaned in afterEach) AND materializeWorkspace takes ownership and deletes
 * it on completion, so callers don't clean it up themselves.
 */
async function makeBundle(files: Record<string, string>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(tmpdir(), 'ax-rb-'));
  try {
    // Bundle ships on refs/heads/main (matches the host materialize
    // bundle's branch name).
    await git(['init', '-b', 'main', tmp]);
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
    const built = path.join(tmp, 'b.bundle');
    await git(['-C', tmp, 'bundle', 'create', built, 'main']);
    // Copy out to a standalone path (sibling of the eventual clone root, OUTSIDE
    // it — clone refuses a non-empty target) that survives this helper's tmp
    // cleanup. materializeWorkspace deletes it; afterEach sweeps scratchRoot for
    // error-path tests where materialize never ran.
    const out = path.join(
      scratchRoot,
      `bundle-${Math.random().toString(36).slice(2, 10)}.bundle`,
    );
    await fs.copyFile(built, out);
    return out;
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
  it('rejects an empty or missing bundle file (Phase 3 always-bundle contract)', async () => {
    // Wire contract: workspace.materialize ALWAYS ships a non-empty
    // bundle (one commit on refs/heads/baseline, possibly with an
    // empty tree for brand-new workspaces). A zero-byte streamed file
    // means the host is broken or the stream truncated — bootstrap-fatal.
    const root = path.join(scratchRoot, 'agent');
    const emptyBundle = path.join(scratchRoot, 'empty.bundle');
    await fs.writeFile(emptyBundle, '');
    await expect(
      materializeWorkspace({ root, bundlePath: emptyBundle }),
    ).rejects.toThrow(/empty or missing bundle file/);
    // A wholly-missing path is the same bootstrap-fatal condition.
    await expect(
      materializeWorkspace({
        root,
        bundlePath: path.join(scratchRoot, 'does-not-exist.bundle'),
      }),
    ).rejects.toThrow(/empty or missing bundle file/);
  });

  it('clones from an empty-tree baseline bundle (brand-new workspace)', async () => {
    // The host's empty-workspace materialize ships a baseline bundle
    // with one commit whose tree is the empty tree. Runner clones it,
    // ends up with an empty working tree but a valid baseline ref.
    const bundleFile = await makeBundle({});
    const root = path.join(scratchRoot, 'agent');

    await materializeWorkspace({ root, bundlePath: bundleFile });

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
    const bundleFile = await makeBundle({ '.ax/CLAUDE.md': 'hello\n' });
    const root = path.join(scratchRoot, 'agent');

    await materializeWorkspace({ root, bundlePath: bundleFile });

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
    const bundleFile = await makeBundle({
      '.ax/CLAUDE.md': '# memory',
      '.ax/draft-skills/foo/SKILL.md': '---\nname: foo\n---\n',
      'src/main.ts': 'export {};\n',
    });
    const root = path.join(scratchRoot, 'agent');

    await materializeWorkspace({ root, bundlePath: bundleFile });

    expect(await fs.readFile(path.join(root, '.ax/CLAUDE.md'), 'utf8')).toBe(
      '# memory',
    );
    expect(
      await fs.readFile(path.join(root, '.ax/draft-skills/foo/SKILL.md'), 'utf8'),
    ).toBe('---\nname: foo\n---\n');
    expect(await fs.readFile(path.join(root, 'src/main.ts'), 'utf8')).toBe(
      'export {};\n',
    );
  });

  it('deletes the host-streamed bundle file after clone (takes ownership)', async () => {
    const bundleFile = await makeBundle({ 'a.txt': 'a' });
    const root = path.join(scratchRoot, 'agent');

    // The bundle file lives outside the clone target. materializeWorkspace
    // takes ownership and must unlink it on success.
    await materializeWorkspace({ root, bundlePath: bundleFile });

    let exists = true;
    try {
      await fs.stat(bundleFile);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('throws a useful error (and still deletes the file) when the bundle is invalid', async () => {
    const root = path.join(scratchRoot, 'agent');
    // A non-empty file that isn't a valid git bundle — passes the size guard,
    // then `git clone` rejects it.
    const notABundle = path.join(scratchRoot, 'garbage.bundle');
    await fs.writeFile(notABundle, 'this is not a bundle');
    await expect(
      materializeWorkspace({ root, bundlePath: notABundle }),
    ).rejects.toThrow(/git clone failed/);
    // Ownership cleanup runs even on the failure path (finally block).
    await expect(fs.stat(notABundle)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does NOT run `git lfs install --local` (LFS layer removed, TASK-70)', async () => {
    // The half-wired LFS layer is gone (out-of-git Part E): no `git lfs
    // install --local`, so no `[filter "lfs"]` should be written into the
    // clone's .git/config. This both proves the removal and removes the
    // suite's git-lfs-binary dependency (the missing-binary failure that
    // reddened ~25 runner tests on any sandbox without git-lfs).
    const bundleFile = await makeBundle({});
    const root = path.join(scratchRoot, 'agent');

    await materializeWorkspace({ root, bundlePath: bundleFile });

    const cfg = await fs.readFile(path.join(root, '.git', 'config'), 'utf8');
    expect(cfg).not.toContain('[filter "lfs"]');
  });
});

describe('no .claude/skills symlink (Phase 3: project source dropped)', () => {
  it('does not scaffold a .claude/skills symlink (project source dropped in Phase 3)', async () => {
    // Phase 3 drops scaffoldWorkspaceSkillSurface entirely. After materialize
    // (the only workspace-setup step that runs pre-turn), no .claude/skills
    // entry should exist. The host-controlled read-only user projection at
    // $CLAUDE_CONFIG_DIR/skills/ (0555) is the sole discovery path.
    const bundleFile = await makeBundle({ 'README.md': 'hello' });
    const root = path.join(scratchRoot, 'agent');
    await materializeWorkspace({ root, bundlePath: bundleFile });

    await expect(
      fs.lstat(path.join(root, '.claude', 'skills')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('scaffoldWorkspaceGitignore', () => {
  it('creates a .gitignore with node_modules + python + cache entries when absent', async () => {
    const root = path.join(scratchRoot, 'agent');
    await materializeWorkspace({ root, bundlePath: await makeBundle({}) });

    await scaffoldWorkspaceGitignore(root);

    const gi = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    for (const entry of [
      'node_modules/',
      '.venv/',
      'venv/',
      '__pycache__/',
      '*.py[cod]',
      '.npm/',
      '.cache/',
      // TASK-67: the SDK jsonl transcript leaves git (DB-backed resume store).
      '.claude/projects/',
      // TASK-78: materialized uploads are blob-store-backed; ignored so they
      // don't round-trip into the commit/bundle.
      '.ax/uploads/',
    ]) {
      expect(gi).toContain(entry);
    }
  });

  it('is idempotent — a second call adds no duplicate lines', async () => {
    const root = path.join(scratchRoot, 'agent');
    await materializeWorkspace({ root, bundlePath: await makeBundle({}) });

    await scaffoldWorkspaceGitignore(root);
    await scaffoldWorkspaceGitignore(root);

    const gi = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    const nodeModulesLines = gi.split('\n').filter((l) => l.trim() === 'node_modules/');
    expect(nodeModulesLines).toHaveLength(1);
  });

  it('creates the workspace root if it does not yet exist (regression: A4 dropped scaffoldWorkspaceSkillSurface, whose recursive mkdir had been incidentally creating the root)', async () => {
    // No materializeWorkspace here — a root that nothing else created. Before
    // the self-sufficient mkdir, this ENOENT'd on the .gitignore append (the
    // CI failure on PR #218). The scaffolder must create its own root.
    const root = path.join(scratchRoot, 'never-created');
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });

    await scaffoldWorkspaceGitignore(root);

    const gi = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(gi).toContain('node_modules/');
  });

  it('preserves a baseline .gitignore and appends only the missing entries', async () => {
    const root = path.join(scratchRoot, 'agent');
    // Baseline already ignores node_modules/ and has a user entry.
    await materializeWorkspace({
      root,
      bundlePath: await makeBundle({ '.gitignore': 'node_modules/\ndist/\n' }),
    });

    await scaffoldWorkspaceGitignore(root);

    const gi = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(gi).toContain('dist/'); // user entry preserved
    expect(gi.split('\n').filter((l) => l.trim() === 'node_modules/')).toHaveLength(1); // not duplicated
    expect(gi).toContain('__pycache__/'); // missing entry appended
    expect(gi).toContain('.venv/');
  });
});

describe('scaffoldSdkProjectsSymlink', () => {
  // Phase E follow-up: the Anthropic SDK writes its per-session turn
  // transcripts to `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sid>.jsonl`.
  // Phase 0 sets CLAUDE_CONFIG_DIR=<sandbox-HOME>/.ax/session — OUTSIDE
  // the workspace — so the turn-end `git add -A + bundle` never captures
  // those jsonls. This scaffolder lays down a symlink from the SDK's
  // projects dir into the workspace so the writes land inside /agent
  // and get bundled. The load-bearing assertion is the last test: a
  // write through the symlink path materializes inside workspaceRoot.

  it('creates <claudeConfigDir>/projects as a symlink to <workspaceRoot>/.claude/projects', async () => {
    const root = path.join(scratchRoot, 'agent');
    const claudeConfigDir = path.join(scratchRoot, 'session');
    await fs.mkdir(root, { recursive: true });

    await scaffoldSdkProjectsSymlink(root, claudeConfigDir);

    const linkTarget = await fs.readlink(path.join(claudeConfigDir, 'projects'));
    expect(linkTarget).toBe(path.join(root, '.claude', 'projects'));
    // Target dir is materialized so the SDK's `open(..., 'a')` on
    // <claudeConfigDir>/projects/<encoded-cwd>/<sid>.jsonl can mkdir
    // through the symlink without ENOENT on the parent.
    const targetStat = await fs.stat(path.join(root, '.claude', 'projects'));
    expect(targetStat.isDirectory()).toBe(true);
  });

  it('creates the claudeConfigDir parent if it does not already exist (defensive)', async () => {
    const root = path.join(scratchRoot, 'agent');
    // Deliberately a nested path that doesn't exist yet — the init
    // container usually pre-creates this, but the scaffolder must not
    // assume so.
    const claudeConfigDir = path.join(scratchRoot, 'home', 'runner', '.ax', 'session');
    await fs.mkdir(root, { recursive: true });

    await scaffoldSdkProjectsSymlink(root, claudeConfigDir);

    const linkTarget = await fs.readlink(path.join(claudeConfigDir, 'projects'));
    expect(linkTarget).toBe(path.join(root, '.claude', 'projects'));
  });

  it('is idempotent — a second call leaves the correct symlink in place', async () => {
    const root = path.join(scratchRoot, 'agent');
    const claudeConfigDir = path.join(scratchRoot, 'session');
    await fs.mkdir(root, { recursive: true });

    await scaffoldSdkProjectsSymlink(root, claudeConfigDir);
    await scaffoldSdkProjectsSymlink(root, claudeConfigDir);

    const linkTarget = await fs.readlink(path.join(claudeConfigDir, 'projects'));
    expect(linkTarget).toBe(path.join(root, '.claude', 'projects'));
  });

  it('replaces a stale regular file at <claudeConfigDir>/projects with the canonical symlink', async () => {
    const root = path.join(scratchRoot, 'agent');
    const claudeConfigDir = path.join(scratchRoot, 'session');
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await fs.writeFile(path.join(claudeConfigDir, 'projects'), 'leftover');

    await scaffoldSdkProjectsSymlink(root, claudeConfigDir);

    const linkTarget = await fs.readlink(path.join(claudeConfigDir, 'projects'));
    expect(linkTarget).toBe(path.join(root, '.claude', 'projects'));
  });

  it('replaces a stale directory at <claudeConfigDir>/projects with the canonical symlink', async () => {
    const root = path.join(scratchRoot, 'agent');
    const claudeConfigDir = path.join(scratchRoot, 'session');
    await fs.mkdir(path.join(claudeConfigDir, 'projects', 'foo'), { recursive: true });
    await fs.writeFile(path.join(claudeConfigDir, 'projects', 'foo', 'bar.jsonl'), '{}');

    await scaffoldSdkProjectsSymlink(root, claudeConfigDir);

    const linkTarget = await fs.readlink(path.join(claudeConfigDir, 'projects'));
    expect(linkTarget).toBe(path.join(root, '.claude', 'projects'));
  });

  it('writes through the symlink land inside workspaceRoot (the load-bearing assertion)', async () => {
    // This is what the SDK actually does: it calls `open(..., 'a')` on
    // `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sid>.jsonl` and
    // appends turn transcript lines. We mimic that I/O pattern and check
    // the bytes land where the runner's `git add -A` will see them.
    const root = path.join(scratchRoot, 'agent');
    const claudeConfigDir = path.join(scratchRoot, 'session');
    await fs.mkdir(root, { recursive: true });

    await scaffoldSdkProjectsSymlink(root, claudeConfigDir);

    const encodedCwd = '-agent';
    const sid = 'abc123';
    const sdkPath = path.join(claudeConfigDir, 'projects', encodedCwd, `${sid}.jsonl`);
    await fs.mkdir(path.dirname(sdkPath), { recursive: true });
    await fs.writeFile(sdkPath, '{"turn":1}\n');

    // Bytes must be reachable via the workspace path — that's what the
    // turn-end `git add -A` walks.
    const workspacePath = path.join(
      root,
      '.claude',
      'projects',
      encodedCwd,
      `${sid}.jsonl`,
    );
    expect(await fs.readFile(workspacePath, 'utf8')).toBe('{"turn":1}\n');
  });
});

// ---------------------------------------------------------------------------
// Turn-end helpers (Slice 7).
// ---------------------------------------------------------------------------

/**
 * Set up `/agent` as a real materialized workspace, ready for
 * turn-end ops. Returns the agent dir + the baseline OID.
 */
async function setupMaterializedWorkspace(args: {
  baselineFiles?: Record<string, string>;
} = {}): Promise<{ root: string; baselineOid: string }> {
  const baselineFiles = args.baselineFiles ?? {};
  const root = path.join(scratchRoot, 'agent');
  // makeBundle writes a bundle FILE; materializeWorkspace clones from it and
  // takes ownership (deletes it) — mirrors the runner's real boot path.
  const bundleFile = await makeBundle(baselineFiles);
  await materializeWorkspace({ root, bundlePath: bundleFile });
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

  it('returns null + creates NO commit for a pure chat turn (jsonl-only write, gitignored) — TASK-70 Phase-5 gate', async () => {
    // The realistic post-out-of-git chat turn: the SDK appends to its session
    // jsonl under `.claude/projects/`, which scaffoldWorkspaceGitignore has
    // gitignored (TASK-67) so it never rides a commit. With transcripts, blobs,
    // and skills all off git, that jsonl is the ONLY thing a chat turn touches
    // in /agent — so the per-turn commit must see an EMPTY diff, create no
    // commit, and return null (commit-notify SKIPPED). This is the Phase-5 gate:
    // the per-turn commit fires only on a non-empty /agent diff.
    const { root } = await setupMaterializedWorkspace();
    // In production scaffoldWorkspaceGitignore runs ONCE at materialize,
    // before any turn — so by turn time the `.gitignore` (with
    // `.claude/projects/`) is already baselined. Mirror that: scaffold it,
    // commit it, and advance `baseline` so the turn under test starts from a
    // clean, gitignore-aware baseline (exactly the runner's post-materialize
    // state).
    await scaffoldWorkspaceGitignore(root);
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-m', 'scaffold gitignore']);
    await advanceBaseline(root);
    const headBefore = (
      await git(['-C', root, 'rev-parse', 'HEAD'])
    ).stdout.trim();

    // Simulate the SDK's per-session jsonl write (gitignored path).
    const jsonlDir = path.join(root, '.claude', 'projects', '-agent');
    await fs.mkdir(jsonlDir, { recursive: true });
    await fs.writeFile(
      path.join(jsonlDir, 'sess-abc.jsonl'),
      '{"type":"user","message":{"role":"user","content":"hi"}}\n',
    );

    const r = await commitTurnAndBundle({ root, reason: 'turn' });
    expect(r).toBeNull();

    // NO commit was created — HEAD is unchanged and baseline..main is empty.
    const headAfter = (
      await git(['-C', root, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    expect(headAfter).toBe(headBefore);
    expect(
      (
        await git(['-C', root, 'rev-list', '--count', 'refs/heads/baseline..main'])
      ).stdout.trim(),
    ).toBe('0');
  });

  it('bundles an already-committed turn when the working tree is clean (re-sync replay; baseline..main non-empty) — TASK-11', async () => {
    // After resyncBaselineAndReplay, the turn's commit sits on `main` ahead of
    // a freshly-re-pinned `baseline`, and the working tree is CLEAN. The
    // re-bundle must STILL ship `baseline..main`. Returning null here made the
    // re-sync caller (commitNotifyWithResync) read it as "turn absorbed ⇒
    // accepted" and silently drop the turn — TASK-11's post-attachment turn
    // lost on reload. Simulate the post-rebase state: a real commit on `main`,
    // baseline left behind, clean tree.
    const { root } = await setupMaterializedWorkspace();
    await fs.writeFile(path.join(root, 'replayed-turn.txt'), 'rebased\n');
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-m', 'replayed turn']);
    // Preconditions: clean working tree, baseline..main has exactly one commit.
    expect((await git(['-C', root, 'status', '--porcelain'])).stdout.trim()).toBe('');
    expect(
      (
        await git(['-C', root, 'rev-list', '--count', 'refs/heads/baseline..main'])
      ).stdout.trim(),
    ).toBe('1');

    const bundleB64 = await commitTurnAndBundle({ root, reason: 'turn' });
    // Must NOT be null — the replayed commit is real and needs shipping.
    expect(bundleB64).not.toBeNull();
    // And it round-trips the committed content.
    const verifyDir = path.join(scratchRoot, 'verify-replay');
    await git(['clone', root, verifyDir]);
    expect(
      await fs.readFile(path.join(verifyDir, 'replayed-turn.txt'), 'utf8'),
    ).toBe('rebased\n');
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
  it("mixed (recoverable): preserves the agent's added file, undoes the commit", async () => {
    const { root, baselineOid } = await setupMaterializedWorkspace();
    await fs.writeFile(path.join(root, 'wip.txt'), 'wip');
    await commitTurnAndBundle({ root, reason: 'turn' });

    await rollbackToBaseline(root, 'mixed');

    expect(await fs.readFile(path.join(root, 'wip.txt'), 'utf8')).toBe('wip');
    const head = (await git(['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    expect(head).toBe(baselineOid);
    const count = (
      await git(['-C', root, 'rev-list', '--count', 'refs/heads/baseline..main'])
    ).stdout.trim();
    expect(count).toBe('0');
  });

  it('B1 regression: a recoverable veto preserves a just-authored SKILL.md', async () => {
    const { root } = await setupMaterializedWorkspace();
    const skillPath = path.join(root, '.ax', 'draft-skills', 'linear', 'SKILL.md');
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, '---\nname: linear\ndescription: x\n---\n# body\n');
    await commitTurnAndBundle({ root, reason: 'turn' });

    await rollbackToBaseline(root, 'mixed');

    expect(await fs.readFile(skillPath, 'utf8')).toContain('name: linear');
  });

  it('hard (SDK-config veto): wipes the working tree back to baseline', async () => {
    const { root } = await setupMaterializedWorkspace();
    await fs.writeFile(path.join(root, 'wip.txt'), 'wip');
    await commitTurnAndBundle({ root, reason: 'turn' });

    await rollbackToBaseline(root, 'hard');

    let exists = true;
    try {
      await fs.stat(path.join(root, 'wip.txt'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('hard restores a deleted baseline file', async () => {
    const { root } = await setupMaterializedWorkspace({
      baselineFiles: { 'important.txt': 'do not delete' },
    });
    await fs.unlink(path.join(root, 'important.txt'));
    await commitTurnAndBundle({ root, reason: 'turn' });

    await rollbackToBaseline(root, 'hard');

    expect(await fs.readFile(path.join(root, 'important.txt'), 'utf8')).toBe('do not delete');
  });

  it('moves HEAD back to baseline after rollback (mixed)', async () => {
    const { root, baselineOid } = await setupMaterializedWorkspace();
    await fs.writeFile(path.join(root, 'a.txt'), 'A');
    await commitTurnAndBundle({ root, reason: 'turn' });

    await rollbackToBaseline(root, 'mixed');

    const head = (await git(['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    expect(head).toBe(baselineOid);
  });
});

// ---------------------------------------------------------------------------
// resyncBaselineAndReplay — concurrent-writer advance recovery.
// ---------------------------------------------------------------------------

/**
 * Build a bundle of a repo that already has the prerequisite B0 commit
 * (i.e. the advanced-mirror scenario). The bundle is a "thin" bundle
 * relative to B0 — but since we use `git bundle create … main` without
 * prerequisite exclusion here the bundle is self-contained (has all
 * objects). That's fine: the fetch target already has B0, so git is
 * happy to fetch even a fat bundle.
 *
 * Returns { bundlePath, newHead } where bundlePath is a temp file holding the
 * advanced-mirror bundle (matching how the runner now receives it — the IPC
 * client's callBinary streams the host's octet-stream body to a temp file, NOT
 * a base64 string in JSON) and newHead is the OID of the tip commit that
 * represents the concurrent writer's advance. resyncBaselineAndReplay takes
 * ownership of the file and deletes it.
 */
async function makeAdvancedMirrorBundle(
  b0Oid: string,
  baseRoot: string,
  advancedFile: string,
  advancedContent: string,
): Promise<{ bundlePath: string; newHead: string }> {
  // Build the "advanced mirror" in a separate temp dir. The mirror starts
  // from a clone of the runner's workspace, but then resets to B0 so
  // the concurrent writer's commit is a sibling of T1 (both children of
  // B0) — NOT a descendant of T1. This is critical: if the mirror's main
  // were descended from T1, `git rebase --onto B1 B0 main` would treat T1
  // as "already applied" and drop it (its patch would already be present
  // in B1's ancestry), producing a no-op rebase that moves main to B1
  // without replaying T1. The host mirror in production branches off B0
  // independently of the runner's turn, so the test must reflect that.
  const mirrorDir = await fs.mkdtemp(path.join(tmpdir(), 'ax-mirror-'));
  try {
    await git(['clone', baseRoot, mirrorDir]);
    await git(['-C', mirrorDir, 'config', 'user.email', 'test@example.com']);
    await git(['-C', mirrorDir, 'config', 'user.name', 'test']);
    // Reset the mirror to B0 so the concurrent commit is a sibling of T1,
    // not a descendant. This mirrors the real production scenario: the host
    // storage tier branched from B0 independently of the runner's turn.
    await git(['-C', mirrorDir, 'reset', '--hard', b0Oid]);
    // Concurrent writer adds a file on a DIFFERENT path than our turn.
    const absPath = path.join(mirrorDir, advancedFile);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, advancedContent);
    await git(['-C', mirrorDir, 'add', '-A']);
    await git(['-C', mirrorDir, 'commit', '-m', 'concurrent writer advance']);
    const newHead = (
      await git(['-C', mirrorDir, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    // Bundle all of `main` (B0→B1 — a self-contained bundle with only the
    // baseline and the concurrent writer's commit, not T1).
    const bundleFile = path.join(mirrorDir, 'mirror.bundle');
    await git(['-C', mirrorDir, 'bundle', 'create', bundleFile, 'main']);
    const bytes = await fs.readFile(bundleFile);
    // Land the bundle bytes in a temp file OUTSIDE mirrorDir (which this
    // function's finally clause wipes) so resyncBaselineAndReplay can read +
    // own it. Mirrors the runner's real path: the IPC client streams the
    // host's binary bundle response straight to a temp file.
    const bundlePath = path.join(
      tmpdir(),
      `ax-test-resync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bundle`,
    );
    await fs.writeFile(bundlePath, bytes);
    return { bundlePath, newHead };
  } finally {
    await fs.rm(mirrorDir, { recursive: true, force: true });
  }
}

describe('resyncBaselineAndReplay', () => {
  it('happy path: disjoint-path rebase replays turn commit onto advanced baseline', async () => {
    // Step 1: Build runner workspace with a turn commit on top of B0.
    //
    //   B0 (seed.txt)  ← refs/heads/baseline
    //   └─ T1 (a.jsonl) ← HEAD/main (the turn commit)
    const { root, baselineOid: b0Oid } = await setupMaterializedWorkspace({
      baselineFiles: { 'seed.txt': 'seed\n' },
    });
    // Turn commit touching a.jsonl (disjoint from the concurrent writer's path).
    await fs.writeFile(path.join(root, 'a.jsonl'), '{"turn":1}\n');
    await commitTurnAndBundle({ root, reason: 'turn 1' });

    // Confirm the turn commit landed (HEAD ≠ B0).
    const headAfterTurn = (
      await git(['-C', root, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    expect(headAfterTurn).not.toBe(b0Oid);

    // Step 2: Build the advanced mirror — concurrent writer added att/file.txt
    // on top of B0. This simulates what the host head is at after a concurrent
    // advance ({ accepted: false, actualParent: B1 }); the runner fetches the
    // B1 bundle to a temp file out-of-band and passes the PATH to resync.
    const { bundlePath, newHead: b1Oid } =
      await makeAdvancedMirrorBundle(b0Oid, root, 'att/file.txt', 'attachment\n');

    // Step 3: Call resyncBaselineAndReplay.
    await resyncBaselineAndReplay({
      root,
      bundlePath,
      oldBaseline: b0Oid,
      newBaseline: b1Oid,
    });

    // Step 4: Assertions.

    // refs/heads/baseline must now point at B1.
    const baselineAfter = (
      await git(['-C', root, 'rev-parse', 'refs/heads/baseline'])
    ).stdout.trim();
    expect(baselineAfter).toBe(b1Oid);

    // Both the concurrent writer's file AND the turn's file must be in
    // the working tree.
    expect(
      await fs.readFile(path.join(root, 'att', 'file.txt'), 'utf8'),
    ).toBe('attachment\n');
    expect(
      await fs.readFile(path.join(root, 'a.jsonl'), 'utf8'),
    ).toBe('{"turn":1}\n');
    // Baseline file is still there too.
    expect(
      await fs.readFile(path.join(root, 'seed.txt'), 'utf8'),
    ).toBe('seed\n');

    // baseline..main must contain exactly 1 commit (the replayed turn).
    const log = (
      await git(['-C', root, 'log', '--oneline', `${b1Oid}..main`])
    ).stdout.trim();
    const logLines = log.split('\n').filter(Boolean);
    expect(logLines).toHaveLength(1);
  });

  it('survives a dirty working tree (live SDK appends to the turn jsonl after commit)', async () => {
    // Regression: on a live runner the Claude Agent SDK keeps appending to
    // the session transcript jsonl AFTER commitTurnAndBundle snapshots it, so
    // by the time the re-sync rebase runs the working tree is DIRTY. Without
    // --autostash, `git rebase` aborts ("local changes would be overwritten")
    // and the turn is lost. Every prior fixture used a CLEAN tree, so only a
    // live cluster reproduced this. Here we simulate the SDK's post-commit
    // append and assert the resync still lands.
    //
    //   B0 (seed.txt)  ← refs/heads/baseline
    //   └─ T1 (a.jsonl) ← HEAD/main (the turn commit)
    //   + unstaged append to a.jsonl in the working tree (the live write)
    const { root, baselineOid: b0Oid } = await setupMaterializedWorkspace({
      baselineFiles: { 'seed.txt': 'seed\n' },
    });
    // Turn commit touching a.jsonl (disjoint from the concurrent writer's path).
    await fs.writeFile(path.join(root, 'a.jsonl'), '{"turn":1}\n');
    await commitTurnAndBundle({ root, reason: 'turn 1' });

    // Simulate the live SDK appending more transcript AFTER the per-turn
    // commit: a.jsonl is now dirty (tracked, modified, unstaged).
    await fs.appendFile(path.join(root, 'a.jsonl'), '{"turn":1,"more":true}\n');

    // Advanced mirror — concurrent writer added att/file.txt on top of B0.
    const { bundlePath, newHead: b1Oid } =
      await makeAdvancedMirrorBundle(b0Oid, root, 'att/file.txt', 'attachment\n');

    // Must NOT throw even though the working tree is dirty.
    await resyncBaselineAndReplay({
      root,
      bundlePath,
      oldBaseline: b0Oid,
      newBaseline: b1Oid,
    });

    // refs/heads/baseline must now point at B1.
    const baselineAfter = (
      await git(['-C', root, 'rev-parse', 'refs/heads/baseline'])
    ).stdout.trim();
    expect(baselineAfter).toBe(b1Oid);

    // Both the concurrent writer's file AND the turn's file must be present.
    expect(
      await fs.readFile(path.join(root, 'att', 'file.txt'), 'utf8'),
    ).toBe('attachment\n');
    expect(
      await fs.readFile(path.join(root, 'seed.txt'), 'utf8'),
    ).toBe('seed\n');

    // baseline..main must contain exactly the 1 replayed turn commit.
    const log = (
      await git(['-C', root, 'log', '--oneline', `${b1Oid}..main`])
    ).stdout.trim();
    const logLines = log.split('\n').filter(Boolean);
    expect(logLines).toHaveLength(1);

    // The dirty append must be preserved in the working tree: --autostash
    // re-applies it on top of the rebased state. a.jsonl therefore contains
    // BOTH the committed turn line AND the live append.
    const aJsonl = await fs.readFile(path.join(root, 'a.jsonl'), 'utf8');
    expect(aJsonl).toBe('{"turn":1}\n{"turn":1,"more":true}\n');
  });

  it('conflict path: same-path change throws and leaves repo non-mid-rebase', async () => {
    // Both the concurrent writer AND the turn touch the same file — this
    // produces an irreconcilable conflict. resyncBaselineAndReplay must
    // throw and leave the repo in a usable state (not mid-rebase).
    const { root, baselineOid: b0Oid } = await setupMaterializedWorkspace({
      baselineFiles: { 'shared.txt': 'base\n' },
    });
    // Turn commit modifies shared.txt.
    await fs.writeFile(path.join(root, 'shared.txt'), 'turn-edit\n');
    await commitTurnAndBundle({ root, reason: 'turn 1' });

    // Concurrent writer also modifies shared.txt differently.
    const { bundlePath, newHead: b1Oid } =
      await makeAdvancedMirrorBundle(b0Oid, root, 'shared.txt', 'concurrent-edit\n');

    // Must throw.
    await expect(
      resyncBaselineAndReplay({
        root,
        bundlePath,
        oldBaseline: b0Oid,
        newBaseline: b1Oid,
      }),
    ).rejects.toThrow(/resync rebase conflict/);

    // Repo must not be mid-rebase — git status and rev-parse must work.
    const revParseResult = await git(['-C', root, 'rev-parse', 'HEAD']);
    expect(revParseResult.code).toBe(0);
    expect(revParseResult.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);

    // No REBASE_HEAD present (rebase was aborted).
    let rebaseHead = true;
    try {
      await fs.stat(path.join(root, '.git', 'REBASE_HEAD'));
    } catch {
      rebaseHead = false;
    }
    expect(rebaseHead).toBe(false);
  });
});
