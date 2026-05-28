// ---------------------------------------------------------------------------
// claude-sdk runner — git-workspace helpers (Phase 3).
//
// Owns three concerns:
//   1. Materialize /permanent at session start by cloning the
//      host-streamed baseline bundle.
//   2. Stage everything in /permanent at turn end, commit if non-empty,
//      bundle the new commits as `git bundle baseline..HEAD`.
//   3. Roll the working tree back to the baseline ref when the host
//      vetoes a turn, and advance the baseline ref when the host
//      accepts.
//
// All git invocations use the locked-down env baked into the pod by
// `@ax/sandbox-k8s`'s pod-spec (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=
// /dev/null, HOME=/nonexistent, GIT_AUTHOR_*=ax-runner pinned). We do
// NOT re-stamp those env vars here — that's the pod's job and we trust
// it. Re-stamping would split the source of truth and let a future env
// tweak drift between the two callers.
//
// Spawn discipline: every git invocation goes through a single `spawn`
// helper that captures stdout+stderr separately, never echoes either to
// the runner's own stderr, and returns the buffers to the caller. The
// caller decides whether to surface a failure as fatal or recoverable.
// This is the same shape the host-side bundler uses — keep them aligned.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { commitTrace } from './commit-trace.js';

interface SpawnResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * Spawn `git` with the given args. Inherits the parent process env (so
 * the pod-spec's locked-down env applies). `stdin` is closed;
 * stdout/stderr are captured fully before resolve.
 */
function runGit(
  args: readonly string[],
  opts: { cwd?: string } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

async function expectOk(result: SpawnResult, label: string): Promise<void> {
  if (result.code !== 0) {
    // stderr is git's own diagnostic; safe to include because the
    // runner's stderr is the host's log sink and the host pod is the
    // trust root.
    throw new Error(`${label} failed (exit=${result.code}): ${result.stderr}`);
  }
}

export interface MaterializeInput {
  /** Filesystem path of the workspace root (typically `/permanent`). */
  root: string;
  /**
   * Path to the host-streamed baseline bundle on local disk. The IPC client's
   * `callBinary('workspace.materialize')` drains the raw `application/octet-stream`
   * response body here (no in-memory base64/JSON round-trip — BUG-W3).
   * materializeWorkspace clones from it and TAKES OWNERSHIP: it deletes the file
   * when done (success or failure).
   */
  bundlePath: string;
}

/**
 * Initialize `/permanent` as a git working tree by cloning a
 * host-streamed baseline bundle.
 *
 * Phase 3 always-bundle: the host's `workspace.materialize` ALWAYS ships
 * a non-empty bundle (one commit on `refs/heads/baseline`, possibly
 * with an empty tree for brand-new workspaces). The runner therefore
 * always clones — no `git init` path. Symmetric with the host side.
 *
 * The bundle arrives on disk as a temp file (the IPC client streamed the raw
 * octet-stream body straight to it — BUG-W3 — so an arbitrarily large bundle
 * never hits the 4 MiB JSON response cap). We clone directly from that file;
 * `git clone` refuses a non-empty target, so the file must live OUTSIDE `root`
 * (the client writes it to `os.tmpdir()`, always writable in both the
 * subprocess and k8s sandboxes even when `/`'s parent volume is read-only).
 *
 * After clone, `refs/heads/baseline` is pinned locally to HEAD so the
 * next `git bundle baseline..HEAD` is well-defined. Subsequent turns
 * advance the baseline ref via `advanceBaseline` after the host accepts.
 *
 * Idempotency note: this is called ONCE per session. Re-calling on a
 * non-empty `/permanent` would fail (`git clone` refuses a non-empty
 * target). Bootstrap-fatal — the runner can't proceed without a clean
 * workspace.
 */
export async function materializeWorkspace(
  input: MaterializeInput,
): Promise<{ baselineCommit: string }> {
  const { root, bundlePath } = input;

  try {
    // Defensive: the wire contract says materialize ALWAYS ships a non-empty
    // bundle (one commit on refs/heads/baseline, possibly an empty tree). A
    // zero-byte or missing file means the host bundler is broken or the stream
    // truncated — fail loud rather than silently producing an unworkable
    // workspace (and before `git clone` emits a less obvious error).
    const stat = await fs.stat(bundlePath).catch(() => null);
    if (stat === null || stat.size === 0) {
      throw new Error(
        `materializeWorkspace: empty or missing bundle file at ${bundlePath} (host should always ship a baseline bundle)`,
      );
    }
    await fs.mkdir(root, { recursive: true });
    await expectOk(
      await runGit(['clone', '--branch', 'main', bundlePath, root]),
      'git clone',
    );
    // Pin refs/heads/baseline to current HEAD (= main = bundle's tip)
    // so the next `git bundle baseline..main` is well-defined.
    // refs/heads/baseline doesn't exist after clone (the bundle only
    // ships refs/heads/main); we create it here pinning to the same
    // OID as main.
    //
    // After this, the contract is:
    //   refs/heads/baseline   — the last-accepted state (advances per
    //                           turn via advanceBaseline after host
    //                           accepts).
    //   HEAD/refs/heads/main  — current working state; advances on each
    //                           turn-end commit.
    //   git bundle baseline..main main — the per-turn thin bundle.
    await expectOk(
      await runGit(['-C', root, 'update-ref', 'refs/heads/baseline', 'HEAD']),
      'git update-ref refs/heads/baseline',
    );
    // Phase 2 (attachments): enable git-lfs smudge filters in this clone so
    // LFS-tracked files (uploads under .ax/uploads/**, artifacts matching
    // .gitattributes) check out as real bytes. --local writes only into
    // THIS repo's .git/config, never HOME/system. Idempotent; safe to re-run.
    await expectOk(
      await runGit(['-C', root, 'lfs', 'install', '--local']),
      'git lfs install --local',
    );
    // Resolve the baseline OID for the caller. The runner uses this to
    // initialize parentVersion for its first commit-notify call: when
    // the workspace has prior history, parentVersion=null on the first
    // turn would cause commit-notify to export the deterministic empty
    // baseline (tip≠HEAD), and the bundler scratch repo would reject
    // the runner's thin bundle with "Repository lacks these prerequisite
    // commits". The fix is to thread the materialize-time tip OID
    // through to the first commit-notify so the host can resolve the
    // matching baseline bundle.
    const head = await runGit(['-C', root, 'rev-parse', 'refs/heads/baseline']);
    await expectOk(head, 'git rev-parse refs/heads/baseline');
    const baselineCommit = head.stdout.toString('utf8').trim();
    return { baselineCommit };
  } finally {
    // We took ownership of the host-streamed bundle file — delete it once the
    // clone is done (success or failure). Best-effort: if unlink fails (e.g.,
    // already gone), nothing depends on it.
    await fs.rm(bundlePath, { force: true });
  }
}

/**
 * Lay down the on-disk shape the Claude Agent SDK's `'project'` skill
 * source needs inside the runner's workspace root: `.ax/skills/` (the
 * host-controlled location, empty in Phase 0 — no project-authored
 * skills yet) and a `.claude/skills` symlink that resolves to it.
 *
 * The relative target (`../.ax/skills`) keeps the link stable across
 * bind-mount path renames, matching the subprocess sibling's shape.
 *
 * Must run AFTER `materializeWorkspace` clones the baseline bundle —
 * doing it before clone would leave the target non-empty and `git
 * clone` would refuse it ("destination path '/permanent' already
 * exists and is not an empty directory"). The k8s init container used
 * to do this and broke chat post-Phase-0; lesson learned, scaffold
 * lives here now.
 *
 * Idempotent. A correct symlink already in place is left untouched
 * (so concurrent re-entry doesn't briefly orphan it); anything else at
 * the symlink path (regular file, dangling link, or directory left by
 * an interrupted previous session) is dropped and recreated.
 */
export async function scaffoldWorkspaceSkillSurface(root: string): Promise<void> {
  const claudeDir = path.join(root, '.claude');
  const axSkillsDir = path.join(root, '.ax', 'skills');
  const skillsLink = path.join(claudeDir, 'skills');
  await fs.mkdir(claudeDir, { recursive: true, mode: 0o755 });
  await fs.mkdir(axSkillsDir, { recursive: true, mode: 0o755 });
  const existing = await fs.readlink(skillsLink).catch(() => null);
  if (existing === '../.ax/skills') return;
  await fs.rm(skillsLink, { recursive: true, force: true });
  try {
    await fs.symlink('../.ax/skills', skillsLink);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const raced = await fs.readlink(skillsLink).catch(() => null);
    if (raced !== '../.ax/skills') throw err;
  }
}

const WORKSPACE_GITIGNORE_HEADER = '# ax agent workspace defaults';
/**
 * Dependency/build artifacts that an agent's `npm install` / python run can
 * drop into `/permanent`, and which would otherwise be `git add -A`'d and
 * bundled to the host. `.npm/`+`.cache/` are the backstop for when the
 * tool-cache redirect (buildToolCacheEnv) has no ephemeral root to point at.
 */
const WORKSPACE_GITIGNORE_ENTRIES = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.py[cod]',
  '.npm/',
  '.cache/',
];

/**
 * Ensure `<root>/.gitignore` carries sensible dependency/build-artifact
 * ignores so agent tooling output doesn't get committed + bundled to the host.
 *
 * Idempotent and non-destructive: each entry (and the header) is only appended
 * if not already present, so re-running never duplicates, and a user-authored
 * `.gitignore` in the baseline is preserved (we only append what's missing).
 * Runs AFTER materializeWorkspace clones the baseline (same ordering rationale
 * as scaffoldWorkspaceSkillSurface) so it can see existing baseline content.
 */
export async function scaffoldWorkspaceGitignore(root: string): Promise<void> {
  const gitignorePath = path.join(root, '.gitignore');
  const existing = await fs.readFile(gitignorePath, 'utf8').catch(() => '');
  const present = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = WORKSPACE_GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;
  const leadingNewline = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const header = present.has(WORKSPACE_GITIGNORE_HEADER) ? '' : `${WORKSPACE_GITIGNORE_HEADER}\n`;
  await fs.appendFile(gitignorePath, `${leadingNewline}${header}${missing.join('\n')}\n`);
}

/**
 * Lay down `$CLAUDE_CONFIG_DIR/projects` as a symlink pointing INTO the
 * workspace at `<workspaceRoot>/.claude/projects` so the Anthropic SDK's
 * native turn-transcript writes land inside `/permanent` and get picked
 * up by the runner's turn-end `git add -A + bundle`.
 *
 * Background: Phase 0 set `CLAUDE_CONFIG_DIR=<sandbox-HOME>/.ax/session`
 * so skill-discovery's `'user'` setting source resolves to a host-owned
 * root SEPARATE from the workspace's `'project'` source. That split is
 * load-bearing — see proxy-startup.ts (CLAUDE_CONFIG_DIR allowlist entry)
 * and main.ts (the (a)/(b) comment block in the query() env literal).
 *
 * Side effect we missed: the SDK ALSO derives its per-session jsonl path
 * from CLAUDE_CONFIG_DIR — `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/
 * <sid>.jsonl`. After Phase 0 those writes started landing OUTSIDE the
 * workspace, so `git add -A` couldn't see them, so `conversations:get`
 * came back `{ turns: [] }` for every conversation booted on a
 * post-Phase-0 runner.
 *
 * The SDK's `projectsDir = join(configDir, "projects")` is hard-coded
 * (no separable env override), so we redirect the I/O at the filesystem
 * layer instead. This is symmetric with the sibling
 * `scaffoldWorkspaceSkillSurface`: both run AFTER materializeWorkspace
 * clones the baseline bundle into `/permanent` (a pre-clone scaffold
 * would leave the target non-empty and `git clone` would refuse it).
 *
 * Symlink target style — IMPORTANT distinction from the sibling: this
 * link lives OUTSIDE the workspace (in `$CLAUDE_CONFIG_DIR`), so the
 * target must be the ABSOLUTE workspace path. The sibling uses a
 * RELATIVE target (`../.ax/skills`) because it lives INSIDE the
 * workspace and a relative link survives bind-mount path renames; there
 * is no equivalent relative path here (the two roots are unrelated
 * filesystem subtrees by design).
 *
 * Idempotent. A correct symlink already in place is left untouched (so
 * concurrent re-entry doesn't briefly orphan it); anything else at the
 * symlink path (regular file, dangling link, or directory left by an
 * interrupted previous session) is dropped and recreated.
 */
export async function scaffoldSdkProjectsSymlink(
  workspaceRoot: string,
  claudeConfigDir: string,
): Promise<void> {
  const targetDir = path.join(workspaceRoot, '.claude', 'projects');
  const linkPath = path.join(claudeConfigDir, 'projects');
  // Target dir must exist before the SDK opens a file under it — the
  // SDK's `mkdir(dirname, { recursive: true })` over a symlink whose
  // target dir is missing would hit ENOENT on the chain.
  await fs.mkdir(targetDir, { recursive: true, mode: 0o755 });
  // Parent of the symlink: the sandbox init container usually
  // pre-creates this (it stamps `mkdir -p .../session/skills` for the
  // skill-discovery surface), but the scaffolder must not assume so —
  // a future sandbox provider may only stamp the bare HOME root.
  await fs.mkdir(claudeConfigDir, { recursive: true, mode: 0o755 });
  const existing = await fs.readlink(linkPath).catch(() => null);
  if (existing === targetDir) return;
  await fs.rm(linkPath, { recursive: true, force: true });
  try {
    await fs.symlink(targetDir, linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const raced = await fs.readlink(linkPath).catch(() => null);
    if (raced !== targetDir) throw err;
  }
}

// ---------------------------------------------------------------------------
// Turn-end helpers (Phase 3 Slice 7).
//
// At each SDK `result` boundary, the runner:
//   1. Stages everything in /permanent (`git add -A`) — catches whatever
//      the agent wrote, regardless of which tool wrote it. Bash deletes,
//      MCP writes, the SDK's internal jsonl: ALL of it.
//   2. Detects empty turn (no staged changes) → returns null bundle so
//      the runner skips the commit-notify call.
//   3. Otherwise commits + bundles `baseline..main main` (thin bundle
//      with the new tip ref). Returns base64 bytes.
//
// After the host responds:
//   - Accepted: `advanceBaseline` moves refs/heads/baseline to HEAD so
//     the next turn's bundle starts from the new state.
//   - Rejected/vetoed: `rollbackToBaseline` resets working tree + HEAD
//     to baseline, undoing the agent's writes for the failed turn. The
//     SDK doesn't see the rollback (it's in the runner's local repo);
//     the agent's next turn starts from a clean baseline.
// ---------------------------------------------------------------------------

/**
 * Stage `/permanent`, commit any working-tree changes, and build a thin
 * bundle of the commits in `baseline..main`.
 *
 * Returns the bundle as base64 bytes, OR null when `baseline..main` is empty —
 * i.e. nothing to ship. That covers an empty turn (no staged changes AND no
 * prior commit) AND a re-sync replay whose commit became empty because its
 * content was already in the advanced baseline (a true absorb). The gate is
 * the commit RANGE, not the working-tree staged diff: after
 * `resyncBaselineAndReplay` the tree is clean but `main` carries the replayed
 * turn commit, which still needs shipping (returning null there would let the
 * caller drop it as "absorbed" — the bug this gate fixes). Caller skips the
 * commit-notify IPC call when null.
 */
export async function commitTurnAndBundle(input: {
  root: string;
  reason: string;
}): Promise<string | null> {
  const { root, reason } = input;

  // Stage everything. `-A` catches additions, modifications, AND
  // deletions — the load-bearing improvement over PostToolUse-based
  // observation, which only saw additions/modifications via the SDK's
  // Write/Edit/MultiEdit tools.
  await expectOk(await runGit(['-C', root, 'add', '-A']), 'git add');

  // Working-tree-change detection: `git diff --cached --quiet` exits 0 when
  // there are no staged changes, 1 when there are. We use this rather
  // than parsing `git status` output — exit code is an authoritative
  // signal that doesn't depend on porcelain format stability. Commit only
  // when there's something staged; an empty `git commit` would refuse.
  const status = await runGit(
    ['-C', root, 'diff', '--cached', '--quiet'],
    {},
  );
  if (status.code === 1) {
    // Commit. Author + committer come from the pod-spec env (ax-runner
    // pinned). The host bundler verifies this; a missing or wrong
    // identity would surface as accepted:false at the host.
    await expectOk(
      await runGit(['-C', root, 'commit', '-m', reason]),
      'git commit',
    );
  } else if (status.code !== 0) {
    // Anything other than 0 or 1 is an error from git itself.
    throw new Error(
      `git diff --cached --quiet failed (exit=${status.code}): ${status.stderr}`,
    );
  }

  // Decide whether there's anything to SHIP by the commit range
  // `baseline..main`, NOT by whether the working tree had changes. These
  // diverge after a re-sync replay: resyncBaselineAndReplay rebases the
  // turn's commit onto the advanced baseline and re-pins `baseline`, leaving
  // a CLEAN working tree but a non-empty `baseline..main` (the replayed
  // commit still needs shipping). The old "empty staged diff ⇒ return null"
  // wrongly reported that as nothing-to-ship, and the re-sync caller read the
  // null as "turn absorbed ⇒ accepted" — silently dropping the turn (TASK-11,
  // the post-attachment turn lost on reload). Gate on the range so BOTH a
  // freshly-committed turn AND a re-sync-replayed commit are shipped; return
  // null only when `baseline..main` is genuinely empty (an empty turn, or a
  // replay whose commit became empty because its content was already in the
  // advanced baseline — a true absorb).
  const range = await runGit(
    ['-C', root, 'rev-list', '--count', 'refs/heads/baseline..main'],
    {},
  );
  await expectOk(range, 'git rev-list baseline..main');
  if (range.stdout.toString('utf8').trim() === '0') {
    return null;
  }

  // Bundle `baseline..main main` — thin bundle with the new tip ref.
  //   - `baseline..main` is the rev range (commits since the last
  //     accepted state).
  //   - `main` (no `refs/heads/` prefix needed) makes the bundle ship
  //     refs/heads/main pointing at the tip. The host's
  //     `fetchBundleIntoMirror` looks for refs/heads/* via its
  //     refspec; without this trailing arg the bundle has no refs and
  //     the host rejects "bundle introduced 0 refs".
  //
  // Bundle to a tempfile (NOT to stdout) — Node's child_process stdio
  // can re-encode binary output via the default `'utf8'` decoder if a
  // listener attaches before raw bytes flow. Tempfile path is
  // unambiguous and trivially correct. Place it in `os.tmpdir()` so
  // it's outside `root` (avoiding `git add -A` on the next turn) AND
  // is on a writable filesystem (the parent of `root` is often a
  // read-only volume root in the k8s sandbox; see materializeWorkspace
  // for the matching note).
  const bundlePath = path.join(os.tmpdir(), `ax-turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bundle`);
  await expectOk(
    await runGit(
      ['-C', root, 'bundle', 'create', bundlePath, 'baseline..main', 'main'],
    ),
    'git bundle create',
  );
  try {
    const bytes = await fs.readFile(bundlePath);
    return bytes.toString('base64');
  } finally {
    await fs.rm(bundlePath, { force: true });
  }
}

/**
 * Move `refs/heads/baseline` to current HEAD. Call this AFTER the host
 * accepts a turn — the agent's view of "what's locked in" advances.
 *
 * Subsequent turns bundle `baseline..main` against the new baseline,
 * shipping only the next turn's changes.
 */
export async function advanceBaseline(root: string): Promise<void> {
  await expectOk(
    await runGit(
      ['-C', root, 'update-ref', 'refs/heads/baseline', 'HEAD'],
    ),
    'git update-ref baseline -> HEAD',
  );
}

/**
 * Roll the working tree + HEAD back to `refs/heads/baseline`. Call this
 * after the host vetoes a turn — the agent's writes for that turn are
 * undone.
 *
 * `git reset --hard baseline` does both: moves HEAD/main to baseline,
 * AND wipes the working tree to match. The agent's next turn starts
 * from a clean baseline state.
 *
 * The SDK doesn't see the rollback. Its in-memory view of the
 * conversation continues, but its NEXT tool call to read a file would
 * see the baseline content (not the rolled-back content). Whether that
 * causes confusion is up to the agent / the system prompt; the runner
 * just enforces the host's veto.
 */
export async function rollbackToBaseline(root: string): Promise<void> {
  await expectOk(
    await runGit(['-C', root, 'reset', '--hard', 'baseline']),
    'git reset --hard baseline',
  );
}

/**
 * Recover from a concurrent-writer advance: the storage tier moved its head
 * from `oldBaseline` to `newBaseline` while our turn committed on top of
 * `oldBaseline`. Fetch the new baseline and replay our turn commit(s) onto it
 * so the next `commit-notify` ships `newBaseline..HEAD`.
 *
 * The `baselineBundleBytes` are the base64-encoded git bundle of the advanced
 * storage state (shipped by the host in the `accepted:false` response). Fetching
 * this bundle brings `newBaseline` into the local object store so
 * `git rebase --onto newBaseline` can resolve it.
 *
 * Disjoint paths (concurrent writer's file vs our turn's file) ⇒ clean rebase.
 * A real conflict (same path touched by both) ⇒ the rebase is aborted (leaving
 * the tree usable) and an error is thrown so the caller can surface a loud
 * turn failure.
 *
 * The working tree may be DIRTY when this runs: on a live runner the Claude
 * Agent SDK keeps appending to the session transcript jsonl after the per-turn
 * commit snapshotted it. The rebase uses `--autostash` so those uncommitted
 * writes are stashed before and re-applied after — without it git would abort
 * the rebase and the turn would be lost.
 */
export async function resyncBaselineAndReplay(input: {
  root: string;
  baselineBundleBytes: string;
  oldBaseline: string;
  newBaseline: string;
}): Promise<void> {
  const { root, baselineBundleBytes, oldBaseline, newBaseline } = input;

  // Write the host-provided bundle to a temp file. Matches the same temp-bundle
  // pattern used by materializeWorkspace: place in os.tmpdir() (always writable
  // in both k8s and subprocess sandboxes; the parent of `root` may be read-only).
  const bundlePath = path.join(
    os.tmpdir(),
    `ax-resync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bundle`,
  );
  await fs.writeFile(bundlePath, Buffer.from(baselineBundleBytes, 'base64'));
  try {
    // Fetch the bundle into the runner's local repo so the `newBaseline`
    // object is reachable. `git fetch <bundle> main` writes FETCH_HEAD only
    // (no local ref is updated). The rebase below uses the raw `newBaseline`
    // OID directly, so no refspec is needed — don't add one.
    commitTrace(
      `[commit-trace]   resync: fetch bundle (old=${oldBaseline} new=${newBaseline})\n`,
    );
    await expectOk(
      await runGit(['-C', root, 'fetch', bundlePath, 'main']),
      'git fetch resync bundle',
    );
    commitTrace(`[commit-trace]   resync: fetch ok → rebase --autostash\n`);

    // Replay: git rebase --autostash --onto <newBaseline> <oldBaseline> main
    //   --autostash         : stash any dirty tracked changes before the
    //                         rebase and re-apply them after. On a LIVE runner
    //                         the Claude Agent SDK keeps appending to the
    //                         session transcript jsonl AFTER commitTurnAndBundle
    //                         snapshots it, so by the time this re-sync runs the
    //                         working tree is dirty. Without --autostash git
    //                         aborts ("local changes would be overwritten").
    //                         For append-only/disjoint jsonl the stash re-applies
    //                         cleanly. (Fixtures with clean trees never hit this;
    //                         only a live cluster reproduced it.)
    //   --onto newBaseline  : set the new parent for the replayed commits
    //   oldBaseline         : the upstream from which our turn diverged
    //   main                : the branch to rebase (our turn's HEAD)
    //
    // This replays the commits in `oldBaseline..main` onto `newBaseline`.
    // For disjoint-path changes this is always clean. For same-path changes
    // git will stop with a conflict marker and a non-zero exit.
    const rebase = await runGit([
      '-C', root,
      'rebase', '--autostash', '--onto', newBaseline, oldBaseline, 'main',
    ]);
    commitTrace(
      `[commit-trace]   resync: rebase exit=${rebase.code}${rebase.code !== 0 ? ` stderr=${rebase.stderr.slice(0, 200)}` : ''}\n`,
    );
    if (rebase.code !== 0) {
      // Conflict — abort to restore the pre-rebase state so the repo is usable.
      await runGit(['-C', root, 'rebase', '--abort']);
      throw new Error(`resync rebase conflict: ${rebase.stderr}`);
    }

    // Pin refs/heads/baseline to the new storage head so subsequent turns'
    // `baseline..main` bundles are computed against the right starting point.
    await expectOk(
      await runGit([
        '-C', root,
        'update-ref', 'refs/heads/baseline', newBaseline,
      ]),
      'git update-ref baseline -> newBaseline',
    );
  } finally {
    // Best-effort cleanup of the temp bundle file.
    await fs.rm(bundlePath, { force: true });
  }
}
