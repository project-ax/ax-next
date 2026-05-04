import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import picomatch from 'picomatch';
import {
  PluginError,
  asWorkspaceVersion,
  type Bytes,
  type FileChange,
  type HookBus,
  type WorkspaceApplyBundleInput,
  type WorkspaceApplyBundleOutput,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceChange,
  type WorkspaceDelta,
  type WorkspaceDiffInput,
  type WorkspaceDiffOutput,
  type WorkspaceExportBaselineBundleInput,
  type WorkspaceExportBaselineBundleOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
  type WorkspaceVersion,
} from '@ax/core';
/**
 * Config for `registerWorkspaceGitHooks`. `repoRoot` is the absolute path to
 * the bare git repo's parent directory; `<repoRoot>/repo.git` is materialized
 * lazily on first use.
 */
export interface WorkspaceGitCoreConfig {
  repoRoot: string;
}

const PLUGIN_NAME = '@ax/workspace-git-core';
const MAIN_REF = 'refs/heads/main';

// Bot identity. INTENTIONALLY hard-coded — the agent never gets to choose
// who the commit appears to be from. (The agent-supplied `reason` flows
// into the commit message, but `author` and `committer` are us, always.)
const BOT_AUTHOR = {
  name: 'ax-runner',
  email: 'ax-runner@example.com',
} as const;

// File mode for blob entries in a tree. We don't preserve executability —
// the workspace contract is "path → bytes," nothing else.
const FILE_MODE = '100644';
const TREE_MODE = '040000';

// ---------------------------------------------------------------------------
// Phase 3 bundle hooks (workspace:export-baseline-bundle +
// workspace:apply-bundle).
//
// The bundle wire ships git pack data between the runner and the host; both
// hooks have git-vocabulary fields (`bundleBytes`, `baselineCommit`) per the
// I1 trade-off documented in @ax/core/src/workspace.ts. They're optional
// service hooks — non-bundle backends just don't register them. We register
// them here so the local single-replica plugin can participate in
// commit-notify alongside @ax/workspace-git-server.
//
// Why we shell out to the `git` binary for these (instead of staying inside
// isomorphic-git like the four base hooks): isomorphic-git has no `bundle`
// support — neither create nor verify nor fetch-from-bundle. The bundle
// wire is the contract, and short of reimplementing the pack/bundle file
// format ourselves, the only way to honor it is to call out to real git.
// We isolate that call site to a single `runGit` helper with a locked-down
// environment (no global config, no system config, fixed PATH) so the
// existing fs-only capability surface only widens by the minimum needed.
//
// Determinism contract: the BASELINE_ENV constants below MUST match the
// values used by @ax/workspace-git-server's BASELINE_ENV and @ax/ipc-core's
// buildBaselineBundle. If they drift, the runner's first thin bundle's
// prereq OID won't match what this backend reconstructs and apply-bundle
// fails loud with an OID-mismatch. We deliberately duplicate the constants
// rather than import (Invariant 2 — no cross-plugin imports).
// ---------------------------------------------------------------------------

const BASELINE_DATE = '1970-01-01T00:00:00Z';
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'ax-runner',
  GIT_AUTHOR_EMAIL: 'ax-runner@example.com',
  GIT_COMMITTER_NAME: 'ax-runner',
  GIT_COMMITTER_EMAIL: 'ax-runner@example.com',
} as const;
const BASELINE_ENV = {
  ...AUTHOR_ENV,
  GIT_AUTHOR_DATE: BASELINE_DATE,
  GIT_COMMITTER_DATE: BASELINE_DATE,
} as const;

// Locked-down env for git child processes. No global config, no system
// config, no terminal prompts, fixed PATH. PATH is hard-coded so a CI
// environment with a malicious `git` binary on $PATH can't subvert us.
//
// We include the standard Linux/CI locations (`/usr/local/bin`, `/usr/bin`,
// `/bin`) plus the two common macOS locations:
//   - `/opt/homebrew/bin` — Homebrew default on Apple Silicon (the host
//      plugin runs in the dev process on the engineer's laptop, which
//      typically has git only here).
//   - `/opt/local/bin`    — MacPorts default.
// This list is closed: we don't inherit `process.env.PATH` because the
// security goal is to pick git from a known set of locations, not from
// whatever the user's shell happens to have first.
const GIT_PROCESS_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
  PATH: '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/local/bin',
  ...AUTHOR_ENV,
};

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGit(
  args: readonly string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...GIT_PROCESS_ENV, ...(extraEnv ?? {}) };
    const child = spawn('git', [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });
}

/**
 * Build a self-contained git bundle of an empty-tree baseline commit
 * with deterministic OID. Used when the workspace has no commits yet
 * (first apply against an empty repo) — same shape as the materialize
 * handler's empty-workspace bundle so the runner's matching clone has
 * the same baseline OID.
 */
async function buildEmptyBaselineBundle(): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'ax-ws-git-empty-baseline-'));
  try {
    const init = await runGit(['init', '-b', 'main', tmp], BASELINE_ENV);
    if (init.code !== 0) {
      throw new Error(`empty baseline init failed: ${init.stderr}`);
    }
    const cfg = await runGit(
      ['-C', tmp, 'config', 'core.fileMode', 'false'],
      BASELINE_ENV,
    );
    if (cfg.code !== 0) {
      throw new Error(`empty baseline config failed: ${cfg.stderr}`);
    }
    const commit = await runGit(
      ['-C', tmp, 'commit', '--allow-empty', '-m', 'baseline'],
      BASELINE_ENV,
    );
    if (commit.code !== 0) {
      throw new Error(`empty baseline commit failed: ${commit.stderr}`);
    }
    // Bundle to a tempfile (not stdout) — runGit decodes stdout as utf8
    // which would mangle binary pack bytes.
    const bundlePath = join(tmp, 'baseline.bundle');
    const bundle = await runGit(
      ['-C', tmp, 'bundle', 'create', bundlePath, 'main'],
      BASELINE_ENV,
    );
    if (bundle.code !== 0) {
      throw new Error(`empty baseline bundle failed: ${bundle.stderr}`);
    }
    const bytes = await readFile(bundlePath);
    return bytes.toString('base64');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Bundle the bare repo's state at `oid` into a self-contained git bundle.
 * Ships every commit reachable from `oid` plus a single ref
 * `refs/heads/main` pointing at it.
 *
 * `oid` does NOT have to be the bare repo's current HEAD — we honor the
 * documented contract (`@ax/core/src/workspace.ts`: "bundles <version>
 * (a single commit + everything reachable)") and bundle whatever
 * reachable commit the caller asks for. The stale-parent race (a
 * concurrent writer landed something between the runner's snapshot and
 * now) leaves `oid` as an ancestor of HEAD, still reachable, and
 * apply-bundle's CAS catches the actual drift downstream as a
 * structured `parent-mismatch`. A strict HEAD-equality check here would
 * mask that as a 500 in commit-notify.
 *
 * We assemble the bundle in a scratch bare repo so we don't have to
 * mutate gitdir's refs (a temp ref under `refs/tmp/*` in gitdir would
 * still need its name rewritten to `refs/heads/main` for the consumer's
 * `fetch refs/heads/main:refs/heads/main`, and rewriting in-place is
 * the racy thing we'd be avoiding by using a temp ref in the first
 * place). Scratch gives us a clean `refs/heads/main -> oid` setup.
 */
async function exportBundleAt(gitdir: string, oid: string): Promise<string> {
  // Verify the oid exists in gitdir. Commits are append-only on main,
  // so any oid we ever issued for this workspace remains reachable; an
  // unknown oid is a real misuse (forged baseline) and gets a loud throw.
  const verify = await runGit([
    '-C', gitdir, 'rev-parse', '--verify', `${oid}^{commit}`,
  ]);
  if (verify.code !== 0) {
    throw new Error(
      `bare repo has no commit at ${oid}: ${verify.stderr}`,
    );
  }
  const scratch = mkdtempSync(join(tmpdir(), 'ax-ws-git-export-bundle-'));
  try {
    // Bare scratch repo. We fetch the requested oid by SHA into
    // refs/heads/main, then bundle from there. The fetch carries every
    // commit reachable from oid (git's smart-fetch); the resulting
    // bundle ships refs/heads/main -> oid plus all ancestors, exactly
    // the shape the consumer's `fetch refs/heads/main:refs/heads/main`
    // expects.
    const init = await runGit(['init', '--bare', '-b', 'main', scratch]);
    if (init.code !== 0) {
      throw new Error(`export scratch init failed: ${init.stderr}`);
    }
    const fetch = await runGit([
      '-C', scratch, 'fetch', '--quiet', gitdir,
      `+${oid}:refs/heads/main`,
    ]);
    if (fetch.code !== 0) {
      throw new Error(`export scratch fetch failed: ${fetch.stderr}`);
    }
    const bundlePath = join(scratch, 'export.bundle');
    const create = await runGit([
      '-C', scratch, 'bundle', 'create', bundlePath, 'main',
    ]);
    if (create.code !== 0) {
      throw new Error(`bundle create failed: ${create.stderr}`);
    }
    const bytes = await readFile(bundlePath);
    return bytes.toString('base64');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Seed an empty bare repo with the deterministic empty-tree baseline
 * commit, but ONLY if the seed's OID matches `expectedOid`. Used by
 * apply-bundle when the repo has no commits yet — the runner's first
 * thin bundle's prereq OID must match the seed by construction (both
 * built from the same shape: sorted paths, fixed dates, fixed author
 * env, --allow-empty, core.fileMode=false).
 *
 * We build in scratch first, verify the OID, and only push to gitdir on
 * match. Seeding gitdir on mismatch would create refs/heads/main in the
 * bare repo and trip the parent-CAS check on every retry, wedging the
 * repo until someone manually deletes the ref.
 *
 * Returns the seeded OID. Throws on mismatch with seededOid in the
 * message so the caller's error envelope is unambiguous.
 */
async function seedBareWithEmptyBaseline(
  gitdir: string,
  expectedOid: string,
): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), 'ax-ws-git-baseline-seed-'));
  try {
    const init = await runGit(['init', '-b', 'main', scratch], BASELINE_ENV);
    if (init.code !== 0) {
      throw new Error(`baseline seed init failed: ${init.stderr}`);
    }
    const cfg = await runGit(
      ['-C', scratch, 'config', 'core.fileMode', 'false'],
      BASELINE_ENV,
    );
    if (cfg.code !== 0) {
      throw new Error(`baseline seed config failed: ${cfg.stderr}`);
    }
    const commit = await runGit(
      ['-C', scratch, 'commit', '--allow-empty', '-m', 'baseline'],
      BASELINE_ENV,
    );
    if (commit.code !== 0) {
      throw new Error(`baseline seed commit failed: ${commit.stderr}`);
    }
    const rp = await runGit(['-C', scratch, 'rev-parse', 'HEAD']);
    if (rp.code !== 0) {
      throw new Error(`baseline seed rev-parse failed: ${rp.stderr}`);
    }
    const seededOid = rp.stdout.trim();
    // Validate BEFORE writing to gitdir. On mismatch we throw and the
    // bare repo stays empty — next retry with parent:null still passes
    // the parent-CAS, so the workspace can recover once the runner
    // catches up.
    if (seededOid !== expectedOid) {
      throw new PluginError({
        code: 'parent-mismatch',
        plugin: PLUGIN_NAME,
        hookName: 'workspace:apply-bundle',
        message: `seeded baseline OID ${seededOid} does not match runner baseline ${expectedOid} (determinism contract violated)`,
      });
    }
    const push = await runGit([
      '-C', scratch, 'push', gitdir, 'main:refs/heads/main',
    ]);
    if (push.code !== 0) {
      throw new Error(`baseline seed push failed: ${push.stderr}`);
    }
    return seededOid;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Fetch a thin bundle into the bare repo under refs/bundle/* (so it
 * doesn't clobber refs/heads/main during the fetch). Returns the
 * single tip OID the bundle introduced. The bundle's prereq MUST already
 * be reachable in the repo or git rejects with "fatal: bad object".
 */
async function fetchBundleIntoBare(
  gitdir: string,
  bundlePath: string,
): Promise<string> {
  // Crash-safety: a prior apply that crashed between `git fetch` and the
  // outer `clearBundleRefs(gitdir)` cleanup would leave stale temp refs
  // under refs/bundle/. Without this pre-clear, the next apply's
  // for-each-ref below sees N+1 refs and the count check throws even on
  // a perfectly valid bundle, wedging the repo until someone manually
  // cleans it. Clearing first makes retries crash-safe by construction.
  await clearBundleRefs(gitdir);
  const fetch = await runGit([
    '-C', gitdir, 'fetch', '--quiet', bundlePath,
    'refs/heads/*:refs/bundle/*',
  ]);
  if (fetch.code !== 0) {
    throw new Error(`bundle fetch failed: ${fetch.stderr}`);
  }
  const list = await runGit([
    '-C', gitdir, 'for-each-ref',
    '--format=%(refname) %(objectname)', 'refs/bundle/',
  ]);
  if (list.code !== 0) {
    throw new Error(`for-each-ref refs/bundle failed: ${list.stderr}`);
  }
  const lines = list.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (lines.length !== 1) {
    throw new Error(
      `bundle introduced ${lines.length} refs (expected exactly 1): ${lines.join(', ')}`,
    );
  }
  const parts = lines[0]!.split(' ');
  if (parts.length !== 2) {
    throw new Error(`malformed for-each-ref output: ${lines[0]}`);
  }
  return parts[1]!;
}

/**
 * Drop refs/bundle/* after a successful apply. The commit objects stay
 * (referenced by refs/heads/main now); the temp refs would otherwise
 * leak into the next apply on this repo.
 */
async function clearBundleRefs(gitdir: string): Promise<void> {
  const list = await runGit([
    '-C', gitdir, 'for-each-ref', '--format=%(refname)', 'refs/bundle/',
  ]);
  if (list.code !== 0) return; // best-effort
  const refs = list.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const ref of refs) {
    await runGit(['-C', gitdir, 'update-ref', '-d', ref]);
  }
}

type Snapshot = Map<string, Bytes>;

// Per-repo mutex. isomorphic-git has no atomic update-ref CAS, so we serialize
// `compare parent + write blobs/trees + commit + update ref` as a single
// critical section. Single-replica only — multi-replica deployment will need
// a real lock (deferred to Week 10+).
class Mutex {
  private chain: Promise<unknown> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }
}

function copyBytes(b: Bytes): Bytes {
  return new Uint8Array(b);
}

function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Validate a `FileChange.path`:
//   - non-empty
//   - relative POSIX (no leading `/`)
//   - no NUL bytes
//   - no `..` segments
//   - no `.git` segments anywhere
//   - no Windows-style `\` separators (the workspace contract is POSIX)
function validatePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new PluginError({
      code: 'invalid-path',
      plugin: PLUGIN_NAME,
      hookName: 'workspace:apply',
      message: 'path must be a non-empty string',
    });
  }
  if (path.includes('\0')) {
    throw new PluginError({
      code: 'invalid-path',
      plugin: PLUGIN_NAME,
      hookName: 'workspace:apply',
      message: `path contains NUL byte: ${JSON.stringify(path)}`,
    });
  }
  if (path.startsWith('/')) {
    throw new PluginError({
      code: 'invalid-path',
      plugin: PLUGIN_NAME,
      hookName: 'workspace:apply',
      message: `path must be relative, got: ${JSON.stringify(path)}`,
    });
  }
  if (path.includes('\\')) {
    throw new PluginError({
      code: 'invalid-path',
      plugin: PLUGIN_NAME,
      hookName: 'workspace:apply',
      message: `path must use POSIX separators, got: ${JSON.stringify(path)}`,
    });
  }
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new PluginError({
        code: 'invalid-path',
        plugin: PLUGIN_NAME,
        hookName: 'workspace:apply',
        message: `path contains forbidden segment: ${JSON.stringify(path)}`,
      });
    }
    if (seg === '.git') {
      throw new PluginError({
        code: 'invalid-path',
        plugin: PLUGIN_NAME,
        hookName: 'workspace:apply',
        message: `path may not include a .git segment: ${JSON.stringify(path)}`,
      });
    }
  }
}

async function ensureRepo(gitdir: string): Promise<void> {
  if (existsSync(join(gitdir, 'HEAD'))) return;
  await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
}

async function resolveHead(gitdir: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, gitdir, ref: MAIN_REF });
  } catch {
    return null;
  }
}

async function readSnapshotAt(
  gitdir: string,
  commitOid: string,
): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  const files = await git.listFiles({ fs, gitdir, ref: commitOid });
  for (const path of files) {
    const { blob } = await git.readBlob({ fs, gitdir, oid: commitOid, filepath: path });
    snap.set(path, blob);
  }
  return snap;
}

// Write a snapshot (path → bytes) to git as a tree of nested tree objects.
// Returns the root tree OID. We build a directory map first so each tree
// is written exactly once with all its children resolved.
async function writeSnapshotTree(
  gitdir: string,
  snapshot: Snapshot,
): Promise<string> {
  // First pass: write all blobs and remember their OIDs.
  const blobOids = new Map<string, string>();
  for (const [path, bytes] of snapshot) {
    const oid = await git.writeBlob({ fs, gitdir, blob: bytes });
    blobOids.set(path, oid);
  }

  // Build a directory tree: dirPath ('' = root) → Map<segment, entry>
  // Entries are either { kind: 'blob', oid, mode } or { kind: 'tree', child: dirPath }
  type Entry =
    | { kind: 'blob'; oid: string; mode: string }
    | { kind: 'tree'; childDir: string };
  const dirs = new Map<string, Map<string, Entry>>();
  const ensureDir = (d: string): Map<string, Entry> => {
    let m = dirs.get(d);
    if (m === undefined) {
      m = new Map();
      dirs.set(d, m);
    }
    return m;
  };
  ensureDir('');

  for (const [path, blobOid] of blobOids) {
    const parts = path.split('/');
    const fileName = parts[parts.length - 1]!;
    // Walk parents, ensuring each intermediate dir exists and the parent
    // points at it.
    let parentDir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i]!;
      const childDir = parentDir === '' ? segment : `${parentDir}/${segment}`;
      const parentMap = ensureDir(parentDir);
      const existing = parentMap.get(segment);
      if (existing === undefined) {
        parentMap.set(segment, { kind: 'tree', childDir });
      }
      ensureDir(childDir);
      parentDir = childDir;
    }
    const fileMap = ensureDir(parentDir);
    fileMap.set(fileName, { kind: 'blob', oid: blobOid, mode: FILE_MODE });
  }

  // Recursively write trees from leaves up. Memoize by directory path.
  const treeOids = new Map<string, string>();
  const writeDir = async (dirPath: string): Promise<string> => {
    const cached = treeOids.get(dirPath);
    if (cached !== undefined) return cached;
    const entries = dirs.get(dirPath) ?? new Map();
    const tree: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
    for (const [name, entry] of entries) {
      if (entry.kind === 'blob') {
        tree.push({ mode: entry.mode, path: name, oid: entry.oid, type: 'blob' });
      } else {
        const childOid = await writeDir(entry.childDir);
        tree.push({ mode: TREE_MODE, path: name, oid: childOid, type: 'tree' });
      }
    }
    // Git tree entries are conventionally sorted by name.
    tree.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const oid = await git.writeTree({ fs, gitdir, tree });
    treeOids.set(dirPath, oid);
    return oid;
  };

  return writeDir('');
}

function applyChanges(base: Snapshot, changes: FileChange[]): Snapshot {
  const next: Snapshot = new Map();
  for (const [path, bytes] of base) next.set(path, bytes);
  for (const change of changes) {
    if (change.kind === 'put') {
      // Defensive copy on the way in: if the caller mutates their input
      // buffer after apply, our snapshot doesn't get poisoned.
      next.set(change.path, copyBytes(change.content));
    } else {
      next.delete(change.path);
    }
  }
  return next;
}

function buildDelta(
  before: Snapshot,
  after: Snapshot,
  beforeVersion: WorkspaceVersion | null,
  afterVersion: WorkspaceVersion,
  reason: string | undefined,
  author: WorkspaceDelta['author'] | undefined,
  gitdir: string,
  beforeCommitOid: string | null,
  afterCommitOid: string,
): WorkspaceDelta {
  const changes: WorkspaceChange[] = [];
  const seen = new Set<string>();

  for (const [path, beforeBytes] of before) {
    seen.add(path);
    const afterBytes = after.get(path);
    if (afterBytes === undefined) {
      // deleted — read lazily from the BEFORE commit so the closure doesn't
      // hold a reference to the entire pre-state Snapshot map.
      const beforeOid = beforeCommitOid!;
      changes.push({
        path,
        kind: 'deleted',
        contentBefore: () => readBlobBytes(gitdir, beforeOid, path),
      });
    } else if (!bytesEqual(beforeBytes, afterBytes)) {
      const beforeOid = beforeCommitOid!;
      changes.push({
        path,
        kind: 'modified',
        contentBefore: () => readBlobBytes(gitdir, beforeOid, path),
        contentAfter: () => readBlobBytes(gitdir, afterCommitOid, path),
      });
    }
  }
  for (const [path] of after) {
    if (seen.has(path)) continue;
    changes.push({
      path,
      kind: 'added',
      contentAfter: () => readBlobBytes(gitdir, afterCommitOid, path),
    });
  }

  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const delta: WorkspaceDelta = {
    before: beforeVersion,
    after: afterVersion,
    changes,
  };
  if (reason !== undefined) delta.reason = reason;
  if (author !== undefined) delta.author = author;
  return delta;
}

async function readBlobBytes(
  gitdir: string,
  commitOid: string,
  path: string,
): Promise<Bytes> {
  const { blob } = await git.readBlob({ fs, gitdir, oid: commitOid, filepath: path });
  // Defensive copy so subscribers can't mutate the underlying buffer that
  // isomorphic-git might cache or share.
  return copyBytes(blob);
}

// isomorphic-git throws errors with a `code` field for not-found cases. We
// swallow any of them as "absent" rather than propagating, since `read` has
// a discriminated absent result.
function isNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return (
    code === 'NotFoundError' ||
    code === 'ObjectTypeError' ||
    code === 'ResolveRefError'
  );
}

export function registerWorkspaceGitHooks(
  bus: HookBus,
  config: WorkspaceGitCoreConfig,
): void {
  const gitdir = join(config.repoRoot, 'repo.git');
  const mutex = new Mutex();

  // Resolve a version that callers may pass. `version` undefined → HEAD.
  // Returns null if there is no HEAD yet (empty repo).
  async function resolveVersion(
    version: WorkspaceVersion | undefined,
  ): Promise<string | null> {
    await ensureRepo(gitdir);
    if (version !== undefined) return version as string;
    return resolveHead(gitdir);
  }

  bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
    'workspace:apply',
    PLUGIN_NAME,
    async (ctx, input) => {
      // Validate paths up-front, BEFORE taking the mutex, so a bad input
      // doesn't deadlock other writers.
      for (const change of input.changes) {
        validatePath(change.path);
      }

      return mutex.run(async () => {
        await ensureRepo(gitdir);
        const currentOid = await resolveHead(gitdir);
        const currentVersion: WorkspaceVersion | null =
          currentOid === null ? null : asWorkspaceVersion(currentOid);

        // Parent CAS check. The mock plugin compares against `latest`;
        // we do the same against the resolved ref.
        if (input.parent !== currentVersion) {
          throw new PluginError({
            code: 'parent-mismatch',
            plugin: PLUGIN_NAME,
            hookName: 'workspace:apply',
            message: `expected parent ${currentVersion === null ? 'null' : currentVersion}, got ${input.parent === null ? 'null' : input.parent}`,
          });
        }

        const author: WorkspaceDelta['author'] = {
          agentId: ctx.agentId,
          userId: ctx.userId,
          sessionId: ctx.sessionId,
        };

        // Empty changes against a non-null current: noop. Don't bump the ref.
        if (input.changes.length === 0 && currentVersion !== null) {
          const delta: WorkspaceDelta = {
            before: currentVersion,
            after: currentVersion,
            changes: [],
          };
          if (input.reason !== undefined) delta.reason = input.reason;
          delta.author = author;
          return { version: currentVersion, delta };
        }

        const parentSnapshot: Snapshot =
          currentOid === null ? new Map() : await readSnapshotAt(gitdir, currentOid);
        const nextSnapshot = applyChanges(parentSnapshot, input.changes);

        // Write the new tree first, then the commit, then the ref. If we
        // crash between tree and commit, dangling objects sit in the
        // object-db harmlessly until the next gc — git is forgiving here.
        const treeOid = await writeSnapshotTree(gitdir, nextSnapshot);
        const commitMessage = input.reason ?? 'workspace apply';
        const commitOid = await git.commit({
          fs,
          gitdir,
          message: commitMessage,
          author: BOT_AUTHOR,
          committer: BOT_AUTHOR,
          tree: treeOid,
          parent: currentOid === null ? [] : [currentOid],
          ref: MAIN_REF,
          // We pass `ref` so commit() updates main as part of the same
          // operation. Combined with the mutex this is effectively CAS.
        });

        const nextVersion = asWorkspaceVersion(commitOid);
        const delta = buildDelta(
          parentSnapshot,
          nextSnapshot,
          currentVersion,
          nextVersion,
          input.reason,
          author,
          gitdir,
          currentOid,
          commitOid,
        );
        return { version: nextVersion, delta };
      });
    },
  );

  bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read',
    PLUGIN_NAME,
    async (_ctx, input) => {
      const commitOid = await resolveVersion(input.version);
      if (commitOid === null) return { found: false };
      try {
        const { blob } = await git.readBlob({
          fs,
          gitdir,
          oid: commitOid,
          filepath: input.path,
        });
        return { found: true, bytes: copyBytes(blob) };
      } catch (err) {
        if (isNotFoundError(err)) return { found: false };
        throw err;
      }
    },
  );

  bus.registerService<WorkspaceListInput, WorkspaceListOutput>(
    'workspace:list',
    PLUGIN_NAME,
    async (_ctx, input) => {
      const commitOid = await resolveVersion(input.version);
      if (commitOid === null) return { paths: [] };
      let paths: string[];
      try {
        paths = await git.listFiles({ fs, gitdir, ref: commitOid });
      } catch (err) {
        if (isNotFoundError(err)) return { paths: [] };
        throw err;
      }
      paths.sort();
      if (input.pathGlob !== undefined) {
        const matcher = picomatch(input.pathGlob, { dot: true });
        paths = paths.filter((p) => matcher(p));
      }
      return { paths };
    },
  );

  bus.registerService<WorkspaceDiffInput, WorkspaceDiffOutput>(
    'workspace:diff',
    PLUGIN_NAME,
    async (_ctx, input) => {
      await ensureRepo(gitdir);
      let fromSnapshot: Snapshot;
      let fromCommitOid: string | null = null;
      if (input.from === null) {
        fromSnapshot = new Map();
      } else {
        try {
          fromSnapshot = await readSnapshotAt(gitdir, input.from as string);
          fromCommitOid = input.from as string;
        } catch (err) {
          if (isNotFoundError(err)) {
            throw new PluginError({
              code: 'unknown-version',
              plugin: PLUGIN_NAME,
              hookName: 'workspace:diff',
              message: `unknown version: ${input.from}`,
              cause: err,
            });
          }
          throw err;
        }
      }
      let toSnapshot: Snapshot;
      try {
        toSnapshot = await readSnapshotAt(gitdir, input.to as string);
      } catch (err) {
        if (isNotFoundError(err)) {
          throw new PluginError({
            code: 'unknown-version',
            plugin: PLUGIN_NAME,
            hookName: 'workspace:diff',
            message: `unknown version: ${input.to}`,
            cause: err,
          });
        }
        throw err;
      }
      const delta = buildDelta(
        fromSnapshot,
        toSnapshot,
        input.from,
        input.to,
        undefined,
        undefined,
        gitdir,
        fromCommitOid,
        input.to as string,
      );
      return { delta };
    },
  );

  bus.registerService<
    WorkspaceExportBaselineBundleInput,
    WorkspaceExportBaselineBundleOutput
  >(
    'workspace:export-baseline-bundle',
    PLUGIN_NAME,
    async (_ctx, input) => {
      // version=null is the seed-condition path: the workspace has no
      // commits in storage yet, so we ship a deterministic empty
      // baseline bundle whose tip OID matches the runner's
      // first-thin-bundle prereq by construction. No mutex needed —
      // the bundle is built from a temp scratch repo, not from the
      // bare repo.
      if (input.version === null) {
        return { bundleBytes: await buildEmptyBaselineBundle() };
      }
      // version=oid: bundle the bare repo's state at that oid. The
      // mutex serializes against concurrent applies so HEAD doesn't
      // shift between the version check and the bundle.
      return mutex.run(async () => {
        await ensureRepo(gitdir);
        const bundleBytes = await exportBundleAt(gitdir, input.version as string);
        return { bundleBytes };
      });
    },
  );

  bus.registerService<WorkspaceApplyBundleInput, WorkspaceApplyBundleOutput>(
    'workspace:apply-bundle',
    PLUGIN_NAME,
    async (ctx, input) => {
      return mutex.run(async () => {
        await ensureRepo(gitdir);
        const currentOid = await resolveHead(gitdir);
        const currentVersion: WorkspaceVersion | null =
          currentOid === null ? null : asWorkspaceVersion(currentOid);

        // Same parent-CAS as workspace:apply.
        if (input.parent !== currentVersion) {
          throw new PluginError({
            code: 'parent-mismatch',
            plugin: PLUGIN_NAME,
            hookName: 'workspace:apply-bundle',
            message: `expected parent ${currentVersion === null ? 'null' : currentVersion}, got ${input.parent === null ? 'null' : input.parent}`,
          });
        }

        // Seed the deterministic baseline if the repo is empty so the
        // thin bundle's prereq is satisfied. The seed's OID MUST match
        // the runner's declared baselineCommit (determinism contract);
        // any drift means the runner and host disagree on the empty-
        // baseline shape, which would let turn-1 silently corrupt
        // turn-2's history. The helper validates in scratch first and
        // only writes to gitdir on match — a mismatch leaves the repo
        // empty so the next retry with parent:null can still pass the
        // parent-CAS.
        if (currentOid === null) {
          await seedBareWithEmptyBaseline(gitdir, input.baselineCommit);
        } else if (currentOid !== input.baselineCommit) {
          throw new PluginError({
            code: 'parent-mismatch',
            plugin: PLUGIN_NAME,
            hookName: 'workspace:apply-bundle',
            message: `bare repo head ${currentOid} does not match runner baseline ${input.baselineCommit}`,
          });
        }

        // Write bundle to a tempfile inside the gitdir so the fetch
        // can address it by path. One finally cleans up both the
        // bundle file and the temp refs/bundle/* refs.
        const bundlePath = join(gitdir, 'in.bundle');
        await writeFile(bundlePath, Buffer.from(input.bundleBytes, 'base64'));
        try {
          const newTip = await fetchBundleIntoBare(gitdir, bundlePath);

          // Reject bundles whose tip doesn't descend from the declared
          // baseline. The runner's contract is "thin bundle of new
          // commits on top of baseline." A non-thin or otherwise-
          // detached bundle could still pass the parent-CAS above and
          // replace HEAD with unrelated history. The ancestor check
          // closes that gap.
          const ancestry = await runGit([
            '-C', gitdir, 'merge-base', '--is-ancestor',
            input.baselineCommit, newTip,
          ]);
          if (ancestry.code === 1) {
            throw new PluginError({
              code: 'parent-mismatch',
              plugin: PLUGIN_NAME,
              hookName: 'workspace:apply-bundle',
              message: `bundle tip ${newTip} does not descend from baseline ${input.baselineCommit}`,
            });
          }
          if (ancestry.code !== 0) {
            throw new Error(
              `git merge-base --is-ancestor failed (exit=${ancestry.code}): ${ancestry.stderr}`,
            );
          }

          // Advance refs/heads/main to the bundle tip.
          const update = await runGit([
            '-C', gitdir, 'update-ref', 'refs/heads/main', newTip,
          ]);
          if (update.code !== 0) {
            throw new Error(`update-ref failed: ${update.stderr}`);
          }

          // Build the delta. `from` is the caller's view of the
          // previous state (currentVersion). For first apply,
          // currentVersion is null and the delta reads as "everything
          // added since empty"; for subsequent applies, currentVersion
          // equals the prior tip and we get the per-turn diff.
          const fromCommitOid =
            currentVersion === null ? null : (currentVersion as string);
          const fromSnapshot: Snapshot =
            fromCommitOid === null
              ? new Map()
              : await readSnapshotAt(gitdir, fromCommitOid);
          const toSnapshot = await readSnapshotAt(gitdir, newTip);
          const newVersion = asWorkspaceVersion(newTip);
          const author: WorkspaceDelta['author'] = {
            agentId: ctx.agentId,
            userId: ctx.userId,
            sessionId: ctx.sessionId,
          };
          const delta = buildDelta(
            fromSnapshot,
            toSnapshot,
            currentVersion,
            newVersion,
            input.reason,
            author,
            gitdir,
            fromCommitOid,
            newTip,
          );
          return { version: newVersion, delta };
        } finally {
          await rm(bundlePath, { force: true });
          await clearBundleRefs(gitdir);
        }
      });
    },
  );
}
