// ---------------------------------------------------------------------------
// GitEngine — shared git-ops engine for the workspace-git-server host plugin.
//
// What it is: a per-workspaceId multiplexed engine that translates the
// `workspace:*` hook payloads into git smart-HTTP wire operations against the
// storage tier. The four hooks (apply / read / list / diff) all flow through
// here. The engine is parameterized by `workspaceId` so a single engine can
// serve many workspaces — that's the generalization over the Phase 1
// "one workspace per plugin instance" `plugin-test-only.ts`.
//
// Ownership boundary (load-bearing):
//   - The engine does NOT own its `MirrorCache`. The caller (a plugin factory
//     in Task 11 / 12) constructs the cache, hands it to `createGitEngine`,
//     and is responsible for `mirrorCache.shutdown()` itself. Multiple plugin
//     instances may share a cache (or test-only stubs may swap one in), so
//     the engine never reaches up the lifetime stack.
//   - The engine does NOT own its `RepoLifecycleClient` for the same reason
//     — the caller wired it to a baseUrl/token and gets to recycle it.
//   - The engine DOES own:
//       * its per-workspace serialization queue (`Map<id, Promise<unknown>>`)
//       * the `createdWorkspaces` set that gates best-effort `createRepo`
//       * the `closed` flag that makes `shutdown()` idempotent and rejects
//         future calls cleanly.
//
// Per-workspace serialization: `apply`/`read`/`list`/`diff` calls for the
// SAME `workspaceId` queue behind each other (so two simultaneous applies on
// the same workspace serialize via fast-forward semantics rather than racing
// to a parent-mismatch). Calls for DIFFERENT `workspaceId`s run concurrently
// — the `Map` lookup keys on the workspaceId so each one has its own tail.
//
// Best-effort create: the storage tier's REST surface treats `POST /repos`
// idempotently — a 409 means "already exists, that's fine". We swallow that
// case so the first apply for a fresh workspaceId can lazy-create. We gate
// the `createRepo` call via `createdWorkspaces` so a successful create
// happens at most once per (engine, workspaceId) pair, regardless of how
// many concurrent applies arrive.
//
// Helpers (`runGit`, `readBlobBytes`, `globToRegex`, `diffTree`, …) are
// internal — they're the same shape as the originals in `plugin-test-only.ts`,
// just lifted out so a future production factory and the existing test-only
// factory can share one implementation. Only `createGitEngine`, `GitEngine`,
// and `GitEngineOptions` are public.
//
// Token discipline: bearer tokens flow through `runGit` via the
// `http.extraHeader` config and never appear in error messages or logs.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  asWorkspaceVersion,
  PluginError,
  type Bytes,
  type FileChange,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceChange,
  type WorkspaceDelta,
  type WorkspaceDiffInput,
  type WorkspaceDiffOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
  type WorkspaceVersion,
} from '@ax/core';
import type {
  WorkspaceApplyBundleInput,
  WorkspaceApplyBundleOutput,
  WorkspaceExportBaselineBundleInput,
  WorkspaceExportBaselineBundleOutput,
} from '@ax/workspace-bundle-protocol';
import type { MirrorCache } from './mirror-cache.js';
import type { RepoLifecycleClient } from './repo-lifecycle.js';

const PLUGIN_NAME = '@ax/workspace-git-server';

/**
 * A `WorkspaceVersion` as THIS backend mints them: a full 40-hex commit OID.
 *
 * Why this exists, given `WorkspaceVersion` is deliberately opaque: this
 * engine spawns the real `git` binary (`runGit`, `readBlobBytes` below), and
 * every version a caller hands us ends up as the leading characters of an
 * argument to it — standalone in `ls-tree -r --name-only <version>` and in
 * `diff-tree ... <from> <to>`, and as the prefix of `<version>:<path>` in
 * `cat-file -e` / `cat-file blob`. An argument that starts with a dash is read
 * by git as an OPTION, and none of our call sites pass `--`.
 *
 * `asWorkspaceVersion` in `@ax/core` is a bare cast with no validation, and it
 * must stay that way — the version's SHAPE is a backend's business, and
 * `MockWorkspace` deliberately mints non-SHA `mock-N` strings to prove the
 * contract is storage-agnostic (Invariant 1). So a `[0-9a-f]{40}` check does
 * NOT belong in core. It belongs here, in a backend that mints SHAs.
 *
 * This is the same hole PR #583 closed in `@ax/workspace-git-core`, reached
 * through a different package. The fix is deliberately the same shape: a
 * regex at the entry point, not a census of which plugins forward a version.
 * A census is a snapshot the next plugin invalidates — `@ax/validator-identity`
 * already falsified one, forwarding the runner's `parent` into `workspace:read`
 * from a `workspace:pre-apply` subscriber.
 */
const OID_RE = /^[0-9a-f]{40}$/;

function requireOid(
  version: WorkspaceVersion | string,
  hookName: string,
  field: string,
): string {
  const v = version as string;
  if (typeof v !== 'string' || !OID_RE.test(v)) {
    throw new PluginError({
      code: 'invalid-version',
      plugin: PLUGIN_NAME,
      hookName,
      message: `${field} must be a 40-character hex commit id`,
    });
  }
  return v;
}

// Author env for commits made by the engine. Production callers (Task 11+)
// will route the agent identity through here; for now a fixed identity keeps
// the contract stable across host-plugin variants.
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'ax-runner',
  GIT_AUTHOR_EMAIL: 'ax-runner@example.com',
  GIT_COMMITTER_NAME: 'ax-runner',
  GIT_COMMITTER_EMAIL: 'ax-runner@example.com',
} as const;

// Phase 3 deterministic-baseline env. Used ONLY by `seedMirrorWithBaseline`
// to reconstruct the runner's local baseline OID inside the mirror cache.
// MUST match the env used by `buildBaselineBundle` in
// `packages/ipc-core/src/handlers/workspace-materialize.ts` — the OIDs
// produced on both sides have to be bit-identical for the runner's thin
// bundle to find its prerequisite. The `WorkspaceApplyBundleInput` type
// comment in `@ax/workspace-bundle-protocol` is the contract.
//
// We intentionally don't import the constant from ipc-core (would
// violate I2 — no cross-plugin imports). We duplicate it here and pin
// the contract via the type comment.
const BASELINE_DATE = '1970-01-01T00:00:00Z';
const BASELINE_ENV = {
  ...AUTHOR_ENV,
  GIT_AUTHOR_DATE: BASELINE_DATE,
  GIT_COMMITTER_DATE: BASELINE_DATE,
} as const;

// Same paranoid env shape as the rest of the host-side git callers
// (see `mirror-cache.ts`'s `gitEnv()`), with author identity layered on top
// for commits. PATH is intentionally fixed here (rather than inheriting
// `process.env.PATH`) because `runGit` is the workhorse for every git call
// the engine issues — the moment a CI environment with a maliciously placed
// `git` binary in PATH could subvert the engine, we'd lose the whole battle.
const HOST_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  ...AUTHOR_ENV,
};

interface GitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface GitOpts {
  cwd?: string;
  // Bytes to feed via stdin (e.g. for `git diff-tree` etc. — currently unused).
  stdin?: Buffer | string;
  // Optional extra env merged on top of HOST_GIT_ENV.
  extraEnv?: NodeJS.ProcessEnv;
}

function runGit(args: readonly string[], opts: GitOpts = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...HOST_GIT_ENV, ...(opts.extraEnv ?? {}) };
    const child = spawn('git', [...args], {
      env,
      cwd: opts.cwd,
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
  });
}

// --- Bytes helpers --------------------------------------------------------

async function readBlobBytes(
  repoDir: string,
  oid: string,
  path: string,
): Promise<Bytes> {
  // `git cat-file blob <oid>:<path>` writes the bytes to stdout. Capture as
  // raw Buffer (not utf8) to preserve binary content.
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoDir, 'cat-file', 'blob', `${oid}:${path}`], {
      env: HOST_GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git cat-file blob ${oid}:${path} exited ${code}: ${Buffer.concat(errChunks).toString('utf8')}`,
          ),
        );
        return;
      }
      const buf = Buffer.concat(chunks);
      resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
  });
}

// --- Glob -----------------------------------------------------------------

// Minimal glob -> regex converter, sufficient for the contract test's `src/**`.
// Supports `**` (any path including slashes), `*` (any chars except slash),
// `?` (any single char except slash). Other regex specials are escaped.
function globToRegex(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$(){}[]|\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

// --- Apply pipeline helpers ----------------------------------------------

function authConfig(token: string): readonly string[] {
  return ['-c', `http.extraHeader=Authorization: Bearer ${token}`];
}

async function fetchMirror(
  remoteUrl: string,
  token: string,
  mirror: string,
): Promise<void> {
  const r = await runGit([
    ...authConfig(token),
    '-C',
    mirror,
    'fetch',
    '--prune',
    remoteUrl,
    '+refs/heads/*:refs/heads/*',
  ]);
  if (r.code !== 0) {
    // First fetch on a freshly-init'd empty mirror against an empty server
    // repo can succeed-or-fail depending on git version: many emit a warning
    // about the empty repo but exit 0. If it exits non-zero and the message
    // mentions "Couldn't find remote ref" or similar emptiness markers, the
    // mirror is effectively in the same state — still empty — so swallow.
    //
    // We also swallow "repository ... not found" (HTTP 404 from the storage
    // tier) for the same reason: a `read`/`list`/`diff` against a workspaceId
    // that no caller has ever written to is, semantically, a read against an
    // empty workspace. The contract is "return empty / found:false for the
    // unknown case" — and the engine's `apply()` always calls
    // `ensureRepoCreated` before fetching, so a write path NEVER hits a 404
    // here. (A misconfigured `baseUrl` would manifest as a connection error,
    // not a 404 — different code path, different stderr signature.)
    const msg = r.stderr.toLowerCase();
    if (
      msg.includes('empty repository') ||
      msg.includes("couldn't find remote ref") ||
      msg.includes('does not appear to be a git repository') ||
      (msg.includes('repository') && msg.includes('not found'))
    ) {
      return;
    }
    throw new Error(`git fetch failed (code ${r.code}): ${r.stderr}`);
  }
}

async function currentMirrorOid(mirror: string): Promise<string | null> {
  const r = await runGit([
    '-C',
    mirror,
    'rev-parse',
    '--quiet',
    '--verify',
    'refs/heads/main',
  ]);
  if (r.code !== 0) return null;
  const oid = r.stdout.trim();
  return oid.length > 0 ? oid : null;
}

// A pinned read waiting on a coalesced batch (TASK-554).
interface PinnedReadWaiter {
  path: string;
  resolve: (out: WorkspaceReadOutput) => void;
  reject: (err: unknown) => void;
}

// One answer from `git cat-file --batch`, in request order.
type BatchEntry =
  | { kind: 'blob'; bytes: Bytes }
  | { kind: 'missing' }
  | { kind: 'other'; type: string };

// Can `path` go on a `cat-file --batch` stdin line? The protocol is one object
// name per line, so a path carrying a line break would split into two
// requests. And git echoes a missing name truncated at a NUL, so a NUL path
// would desynchronise the reply parser. Such paths take the single-read path
// instead, which fails or answers them on their own.
function batchablePath(path: string): boolean {
  return !path.includes('\n') && !path.includes('\r') && !path.includes('\u0000');
}

/**
 * Resolve many `<rev>:<path>` specs with ONE `git cat-file --batch` process
 * (TASK-554). Returns one entry per spec, in order. The specs travel on stdin,
 * never argv, so no spec can be read as an option.
 *
 * Reply grammar (git-cat-file(1)): a found object is
 * `<oid> SP <type> SP <size> LF <bytes> LF`; a name that does not resolve is
 * `<name> SP missing LF` (`ambiguous` likewise). Anything else is a protocol
 * error and fails the whole call rather than mis-assigning bytes to a path.
 */
async function catFileBatch(
  repoDir: string,
  specs: readonly string[],
): Promise<BatchEntry[]> {
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', ['-C', repoDir, 'cat-file', '--batch'], {
      env: HOST_GIT_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    child.once('error', reject);
    // An EPIPE on stdin (git died early) surfaces as a non-zero exit below.
    child.stdin.on('error', () => undefined);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git cat-file --batch exited ${code}: ${Buffer.concat(errChunks).toString('utf8')}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    child.stdin.end(specs.map((s) => `${s}\n`).join(''));
  });

  const out: BatchEntry[] = [];
  let pos = 0;
  for (const spec of specs) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) {
      throw new Error(`git cat-file --batch: reply ended before ${spec}`);
    }
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const found = /^[0-9a-f]{40,64} (\S+) (\d+)$/.exec(header);
    if (found !== null) {
      const type = found[1]!;
      const size = Number(found[2]);
      if (pos + size + 1 > buf.length || buf[pos + size] !== 0x0a) {
        throw new Error(`git cat-file --batch: truncated reply for ${spec}`);
      }
      const content = buf.subarray(pos, pos + size);
      pos += size + 1;
      out.push(
        type === 'blob'
          ? { kind: 'blob', bytes: new Uint8Array(content) }
          : { kind: 'other', type },
      );
      continue;
    }
    if (header === `${spec} missing`) {
      out.push({ kind: 'missing' });
      continue;
    }
    if (header.startsWith(`${spec} `)) {
      out.push({ kind: 'other', type: header.slice(spec.length + 1) });
      continue;
    }
    throw new Error(`git cat-file --batch: unexpected reply for ${spec}: ${header}`);
  }
  if (pos !== buf.length) {
    throw new Error('git cat-file --batch: trailing bytes after the last reply');
  }
  return out;
}

// True iff the mirror holds `oid` as a commit object. Used by pinned
// `read`/`list` to decide whether the storage-tier fetch can be skipped.
// `oid` has already passed `requireOid`, so it is a bare hex id, never a
// ref name or an option.
async function mirrorHasCommit(mirror: string, oid: string): Promise<boolean> {
  const r = await runGit(['-C', mirror, 'cat-file', '-e', `${oid}^{commit}`]);
  return r.code === 0;
}

async function buildScratch(
  mirror: string,
  mirrorHead: string | null,
): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), 'ax-ws-server-scratch-'));
  if (mirrorHead === null) {
    // Empty baseline: init a working tree on `main`.
    const init = await runGit(['init', '-b', 'main', scratch]);
    if (init.code !== 0) {
      throw new Error(`git init scratch failed: ${init.stderr}`);
    }
  } else {
    // Local clone from the bare mirror — fast, no network. The clone
    // automatically checks out the default branch.
    const clone = await runGit(['clone', mirror, scratch]);
    if (clone.code !== 0) {
      throw new Error(`git clone scratch failed: ${clone.stderr}`);
    }
  }
  return scratch;
}

async function applyChanges(
  scratch: string,
  changes: FileChange[],
): Promise<void> {
  for (const change of changes) {
    const target = join(scratch, change.path);
    if (change.kind === 'put') {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, change.content);
    } else {
      // delete — `force: true` means missing-ok.
      await rm(target, { force: true });
    }
  }
}

async function commitScratch(
  scratch: string,
  reason: string | undefined,
): Promise<string> {
  const add = await runGit(['-C', scratch, 'add', '-A']);
  if (add.code !== 0) throw new Error(`git add -A failed: ${add.stderr}`);
  const message = reason ?? 'apply';
  // --allow-empty so an apply with `changes: []` still produces a new oid.
  const commit = await runGit([
    '-C',
    scratch,
    'commit',
    '--allow-empty',
    '-m',
    message,
  ]);
  if (commit.code !== 0) {
    throw new Error(`git commit failed: ${commit.stderr}`);
  }
  const rp = await runGit(['-C', scratch, 'rev-parse', 'HEAD']);
  if (rp.code !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${rp.stderr}`);
  }
  return rp.stdout.trim();
}

async function pushScratch(
  remoteUrl: string,
  token: string,
  scratch: string,
  parent: string | null,
): Promise<{ ok: true } | { ok: false; nonFastForward: boolean; stderr: string }> {
  // CAS via --force-with-lease: assert remote main matches `<parent>` (empty
  // string for the no-prior-commit case). Mismatch -> non-fast-forward error
  // surfaced as parent-mismatch.
  const lease = parent === null ? '' : parent;
  const args = [
    ...authConfig(token),
    '-C',
    scratch,
    'push',
    `--force-with-lease=refs/heads/main:${lease}`,
    remoteUrl,
    'HEAD:refs/heads/main',
  ];
  const r = await runGit(args);
  if (r.code === 0) return { ok: true };
  const msg = r.stderr.toLowerCase();
  const nonFastForward =
    msg.includes('non-fast-forward') ||
    msg.includes('non fast forward') ||
    msg.includes('stale info') || // --force-with-lease lease mismatch
    msg.includes('rejected') ||
    msg.includes('failed to push');
  return { ok: false, nonFastForward, stderr: r.stderr };
}

// --- apply-bundle pipeline helpers (Phase 3) ----------------------------

/**
 * Seed an empty mirror with a deterministic empty-tree baseline
 * commit. Used for first apply against an empty storage tier — the
 * runner's local baseline OID matches this commit by construction
 * (both sides build with sorted paths, fixed dates, fixed author env,
 * --allow-empty, core.fileMode=false).
 *
 * Returns the new commit's OID so the caller can verify it matches
 * the runner's prereq.
 */
async function seedMirrorWithEmptyBaseline(mirror: string): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), 'ax-ws-baseline-'));
  try {
    // Init on `main` (matches the materialize bundle's branch + the
    // bundler's expected refspec).
    const init = await runGit(['init', '-b', 'main', scratch], {
      extraEnv: BASELINE_ENV,
    });
    if (init.code !== 0) {
      throw new Error(`baseline init failed: ${init.stderr}`);
    }
    const cfg = await runGit(
      ['-C', scratch, 'config', 'core.fileMode', 'false'],
      { extraEnv: BASELINE_ENV },
    );
    if (cfg.code !== 0) {
      throw new Error(`baseline config core.fileMode failed: ${cfg.stderr}`);
    }
    // --allow-empty produces a commit with the empty tree as its
    // tree OID. Combined with deterministic dates + identity, this
    // commit's OID is bit-for-bit reproducible.
    const commit = await runGit(
      ['-C', scratch, 'commit', '--allow-empty', '-m', 'baseline'],
      { extraEnv: BASELINE_ENV },
    );
    if (commit.code !== 0) {
      throw new Error(`baseline commit failed: ${commit.stderr}`);
    }
    const push = await runGit([
      '-C',
      scratch,
      'push',
      mirror,
      'main:refs/heads/main',
    ]);
    if (push.code !== 0) {
      throw new Error(`baseline push to mirror failed: ${push.stderr}`);
    }
    const rp = await runGit(['-C', scratch, 'rev-parse', 'HEAD']);
    if (rp.code !== 0) {
      throw new Error(`baseline rev-parse failed: ${rp.stderr}`);
    }
    return rp.stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Fetch the runner's thin bundle into the mirror cache. The bundle's
 * prerequisite (`baselineCommit`) MUST already be in the mirror — call
 * `seedMirrorWithBaseline` first if the mirror is empty. Returns the
 * bundle's tip OID (the new commit the runner produced).
 *
 * Bundles are routed under refs/bundle/* so they don't clobber
 * refs/heads/main during the fetch. We pick the single ref the bundle
 * introduced as the tip (the runner ships exactly one ref per turn).
 */
async function fetchBundleIntoMirror(
  mirror: string,
  bundlePath: string,
): Promise<string> {
  const fetch = await runGit([
    '-C',
    mirror,
    'fetch',
    '--quiet',
    bundlePath,
    'refs/heads/*:refs/bundle/*',
  ]);
  if (fetch.code !== 0) {
    throw new Error(`bundle fetch into mirror failed: ${fetch.stderr}`);
  }
  // Find the bundle's tip — exactly one ref under refs/bundle/.
  const list = await runGit([
    '-C',
    mirror,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/bundle/',
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
 * Push the bundle's tip OID to the storage tier as refs/heads/main.
 * Uses --force-with-lease for CAS (same as pushScratch).
 *
 * git push handles dependencies: if the storage tier doesn't have all
 * the commits yet (e.g., first apply), it pushes the entire chain
 * including baseline.
 */
async function pushBundleTip(
  remoteUrl: string,
  token: string,
  mirror: string,
  newTip: string,
  parent: string | null,
): Promise<{ ok: true } | { ok: false; nonFastForward: boolean; stderr: string }> {
  const lease = parent === null ? '' : parent;
  const args = [
    ...authConfig(token),
    '-C',
    mirror,
    'push',
    `--force-with-lease=refs/heads/main:${lease}`,
    remoteUrl,
    `${newTip}:refs/heads/main`,
  ];
  const r = await runGit(args);
  if (r.code === 0) return { ok: true };
  const msg = r.stderr.toLowerCase();
  const nonFastForward =
    msg.includes('non-fast-forward') ||
    msg.includes('non fast forward') ||
    msg.includes('stale info') ||
    msg.includes('rejected') ||
    msg.includes('failed to push');
  return { ok: false, nonFastForward, stderr: r.stderr };
}

/**
 * Build a self-contained git bundle of an empty-tree baseline commit
 * with deterministic OID. Used when the workspace has no commits yet
 * (first apply against an empty storage tier) — same shape as the
 * materialize handler's empty-workspace bundle so the runner's
 * matching clone has the same baseline OID. Returns both the bundle
 * bytes and the tip OID so callers can validate that a caller-supplied
 * version matches.
 */
async function buildEmptyBaselineBundle(): Promise<{
  bundleBytes: string;
  oid: string;
}> {
  const tmp = mkdtempSync(join(tmpdir(), 'ax-ws-empty-baseline-'));
  try {
    const init = await runGit(['init', '-b', 'main', tmp], {
      extraEnv: BASELINE_ENV,
    });
    if (init.code !== 0) {
      throw new Error(`empty baseline init failed: ${init.stderr}`);
    }
    const cfg = await runGit(
      ['-C', tmp, 'config', 'core.fileMode', 'false'],
      { extraEnv: BASELINE_ENV },
    );
    if (cfg.code !== 0) {
      throw new Error(`empty baseline config failed: ${cfg.stderr}`);
    }
    const commit = await runGit(
      ['-C', tmp, 'commit', '--allow-empty', '-m', 'baseline'],
      { extraEnv: BASELINE_ENV },
    );
    if (commit.code !== 0) {
      throw new Error(`empty baseline commit failed: ${commit.stderr}`);
    }
    const revParse = await runGit(
      ['-C', tmp, 'rev-parse', 'main'],
      { extraEnv: BASELINE_ENV },
    );
    if (revParse.code !== 0) {
      throw new Error(`empty baseline rev-parse failed: ${revParse.stderr}`);
    }
    const oid = revParse.stdout.trim();
    // Bundle to a tempfile (NOT stdout) — runGit's utf8-decoded
    // stdout would mangle binary bundle bytes. The pack format
    // contains arbitrary binary data (deltas, blob bytes); we need
    // raw bytes from the file.
    const bundlePath = join(tmp, 'baseline.bundle');
    const bundle = await runGit(
      ['-C', tmp, 'bundle', 'create', bundlePath, 'main'],
      { extraEnv: BASELINE_ENV },
    );
    if (bundle.code !== 0) {
      throw new Error(`empty baseline bundle failed: ${bundle.stderr}`);
    }
    const bytes = await readFile(bundlePath);
    return { bundleBytes: bytes.toString('base64'), oid };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Bundle the mirror's state at a specific commit OID into a self-
 * contained git bundle. The bundle ships every commit reachable from
 * `oid` plus the ref `refs/heads/main` pointing at it.
 *
 * Caller invariant: `oid` MUST equal the mirror's current
 * refs/heads/main (which we verify before bundling — drift here means
 * the runner's view of `parent` doesn't match what we have, which is
 * a parent-mismatch the apply path would catch downstream anyway).
 */
async function exportMirrorBundle(
  mirror: string,
  oid: string,
): Promise<string> {
  // Verify the mirror's HEAD matches the requested oid. If a concurrent
  // writer landed something between the runner's parent and now, our
  // mirror.HEAD has advanced past `oid`; the runner's apply will
  // correctly hit parent-mismatch. Bundling our current HEAD here
  // (which doesn't match `oid`) would silently mask that — better to
  // fail loud.
  const head = await runGit([
    '-C',
    mirror,
    'rev-parse',
    '--verify',
    'refs/heads/main',
  ]);
  if (head.code !== 0) {
    throw new Error(
      `mirror has no refs/heads/main: ${head.stderr}`,
    );
  }
  const headOid = head.stdout.trim();
  if (headOid !== oid) {
    throw new Error(
      `mirror head ${headOid} does not match requested version ${oid} (concurrent writer or stale version)`,
    );
  }

  // Bundle refs/heads/main directly. Use a tempfile (not stdout) for
  // binary safety — runGit's utf8-decoded stdout would mangle the
  // bundle bytes.
  const out = mkdtempSync(join(tmpdir(), 'ax-export-bundle-'));
  try {
    const bundlePath = join(out, 'baseline.bundle');
    const create = await runGit([
      '-C',
      mirror,
      'bundle',
      'create',
      bundlePath,
      'main',
    ]);
    if (create.code !== 0) {
      throw new Error(`bundle create failed: ${create.stderr}`);
    }
    const bytes = await readFile(bundlePath);
    return bytes.toString('base64');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/**
 * Clear refs/bundle/* from the mirror after a successful apply. We
 * keep the commit objects (referenced by refs/heads/main now), but
 * drop the temporary refs that were just used as fetch targets.
 */
async function clearBundleRefs(mirror: string): Promise<void> {
  const list = await runGit([
    '-C',
    mirror,
    'for-each-ref',
    '--format=%(refname)',
    'refs/bundle/',
  ]);
  if (list.code !== 0) return; // best-effort
  const refs = list.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const ref of refs) {
    await runGit(['-C', mirror, 'update-ref', '-d', ref]);
  }
}

interface DiffEntry {
  status: 'A' | 'M' | 'D';
  path: string;
}

async function diffTree(
  repoDir: string,
  fromOid: string | null,
  toOid: string,
): Promise<DiffEntry[]> {
  // The empty tree object — `git hash-object -t tree /dev/null` is
  // 4b825dc642cb6eb9a060e54bf8d69288fbee4904. git knows this constant.
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const left = fromOid ?? EMPTY_TREE;
  const r = await runGit([
    '-C',
    repoDir,
    'diff-tree',
    '-r',
    '--name-status',
    '--no-renames',
    '--root', // include diff against initial commit
    left,
    toOid,
  ]);
  if (r.code !== 0) {
    // diff-tree against the empty tree id is supported, but if anything goes
    // wrong, surface the error rather than swallowing.
    throw new Error(`git diff-tree failed: ${r.stderr}`);
  }
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  const entries: DiffEntry[] = [];
  for (const line of lines) {
    // Lines look like: "A\tpath" or "M\tpath" or "D\tpath".
    // diff-tree --root may emit a leading line that's the commit oid itself
    // when `from` is the empty tree; tolerate.
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const status = parts[0]!;
    const path = parts.slice(1).join('\t');
    if (status === 'A' || status === 'M' || status === 'D') {
      entries.push({ status, path });
    }
  }
  return entries;
}

function statusToKind(s: 'A' | 'M' | 'D'): WorkspaceChange['kind'] {
  if (s === 'A') return 'added';
  if (s === 'M') return 'modified';
  return 'deleted';
}

async function buildDelta(
  mirror: string,
  parent: string | null,
  newOid: string,
  reason: string | undefined,
  author: WorkspaceDelta['author'] | undefined,
): Promise<WorkspaceDelta> {
  const entries = await diffTree(mirror, parent, newOid);
  const changes: WorkspaceChange[] = entries.map((e) => {
    const kind = statusToKind(e.status);
    const path = e.path;
    if (kind === 'added') {
      return {
        path,
        kind: 'added',
        contentAfter: () => readBlobBytes(mirror, newOid, path),
      };
    }
    if (kind === 'modified') {
      // parent is non-null when status is 'M'; defensive.
      const before = parent;
      return {
        path,
        kind: 'modified',
        contentBefore: () =>
          before === null
            ? Promise.reject(new Error('contentBefore unavailable: no parent'))
            : readBlobBytes(mirror, before, path),
        contentAfter: () => readBlobBytes(mirror, newOid, path),
      };
    }
    // deleted
    const before = parent;
    return {
      path,
      kind: 'deleted',
      contentBefore: () =>
        before === null
          ? Promise.reject(new Error('contentBefore unavailable: no parent'))
          : readBlobBytes(mirror, before, path),
    };
  });

  const out: WorkspaceDelta = {
    before: parent === null ? null : asWorkspaceVersion(parent),
    after: asWorkspaceVersion(newOid),
    changes,
  };
  if (reason !== undefined) out.reason = reason;
  // Issue #80: subscribers like @ax/routines key off delta.author.agentId
  // to decide whether to process a workspace:applied event. The local
  // backend (@ax/workspace-git-core) populates author from the
  // AgentContext at the registerService boundary; this multi-replica
  // backend must too, or every author-keyed subscriber silently
  // early-returns on git-protocol clusters.
  if (author !== undefined) out.author = author;
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GitEngineOptions {
  /** Single storage-tier base URL (sharding deferred per Phase 2 plan Q5). */
  baseUrl: string;
  /** Bearer token for REST + git smart-HTTP. Never logged. */
  token: string;
  /** Local mirror cache. Engine doesn't construct it; caller owns lifetime. */
  mirrorCache: MirrorCache;
  /**
   * REST CRUD client for the same baseUrl/token. Engine uses it to
   * ensure-create the repo on first apply for a workspaceId.
   */
  lifecycleClient: RepoLifecycleClient;
}

export interface GitEngine {
  /**
   * `author` (issue #80): optional `{ agentId, userId, sessionId }` from the
   * caller's `AgentContext`. The registered plugin handler extracts it from
   * ctx and threads it through so the returned `delta.author` lines up with
   * what the local backend (`@ax/workspace-git-core`) produces. Subscribers
   * like `@ax/routines` early-return on missing `author.agentId`.
   */
  apply(
    workspaceId: string,
    input: WorkspaceApplyInput,
    author?: WorkspaceDelta['author'],
  ): Promise<WorkspaceApplyOutput>;
  applyBundle(
    workspaceId: string,
    input: WorkspaceApplyBundleInput,
    author?: WorkspaceDelta['author'],
  ): Promise<WorkspaceApplyBundleOutput>;
  exportBaselineBundle(
    workspaceId: string,
    input: WorkspaceExportBaselineBundleInput,
  ): Promise<WorkspaceExportBaselineBundleOutput>;
  read(workspaceId: string, input: WorkspaceReadInput): Promise<WorkspaceReadOutput>;
  list(workspaceId: string, input: WorkspaceListInput): Promise<WorkspaceListOutput>;
  diff(workspaceId: string, input: WorkspaceDiffInput): Promise<WorkspaceDiffOutput>;
  shutdown(): Promise<void>;
  /**
   * @internal Test-only seam: returns the current size of the per-workspace
   * queue Map. Used to pin the regression test for the settled-tail cleanup.
   * Do NOT call from production code — this is not part of the supported API.
   */
  _internalQueueSize(): number;
}

/**
 * Composes a `${baseUrl}/${workspaceId}.git` remote URL. `baseUrl` may carry
 * a trailing slash; we strip exactly one to keep the join well-formed.
 */
function remoteUrlFor(baseUrl: string, workspaceId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${workspaceId}.git`;
}

export function createGitEngine(opts: GitEngineOptions): GitEngine {
  // Per-workspace queue tails. The presence of a key means "an op for this
  // workspaceId is in flight or just settled"; the value is the tail Promise
  // each new op chains onto. Different workspaceIds run concurrently.
  const queues = new Map<string, Promise<unknown>>();

  // Workspaces for which we've already issued a successful (or 409-swallowed)
  // `createRepo`. Keeps the lifecycle client from being hammered with a
  // create call on every apply.
  const createdWorkspaces = new Set<string>();

  let closed = false;

  const enqueue = <T>(workspaceId: string, fn: () => Promise<T>): Promise<T> => {
    const tail = queues.get(workspaceId) ?? Promise.resolve();
    // Chain via .then(fn, fn) so the next op runs whether the previous
    // settled fulfilled or rejected — one workspace's failure shouldn't
    // permanently wedge the queue.
    const next = tail.then(fn, fn);
    const tracked = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(workspaceId, tracked);
    // Drop the entry once this tail settles, but only if no later op chained
    // onto it (i.e., the Map still points at THIS tracked Promise). A new
    // `enqueue` for the same workspaceId arriving before `tracked` settles
    // synchronously replaces the entry — this guard prevents us from
    // clobbering that newer tail. Without this cleanup the Map would grow
    // unboundedly across the engine's lifetime, since every workspaceId we
    // ever serviced would linger as a settled Promise reference.
    void tracked.then(() => {
      if (queues.get(workspaceId) === tracked) {
        queues.delete(workspaceId);
      }
    });
    return next;
  };

  // `parentMismatch` carries the storage tier's actual head as
  // `cause.actualParent` so callers (test harnesses, host-side retry loops)
  // can rebase without re-querying. The contract was inherited from the
  // 409 envelope of `@ax/workspace-git-http` (retired 2026-05-04; this
  // StatefulSet is the only storage tier now): `actualParent` is the server's
  // current head (a `WorkspaceVersion` string, or `null` for an empty repo).
  // Subscribers MUST treat the value as opaque — it's a brand-typed string
  // and the only legal use is to feed it back into a follow-up
  // `workspace:apply` as `parent`.
  const parentMismatch = (
    message: string,
    actualParent: string | null,
  ): PluginError =>
    new PluginError({
      code: 'parent-mismatch',
      plugin: PLUGIN_NAME,
      message,
      cause: {
        actualParent:
          actualParent === null ? null : asWorkspaceVersion(actualParent),
      },
    });

  const ensureRepoCreated = async (workspaceId: string): Promise<void> => {
    if (createdWorkspaces.has(workspaceId)) return;
    try {
      await opts.lifecycleClient.createRepo(workspaceId);
    } catch (err) {
      // 409 → already exists. That's fine — multi-replica deployments share
      // one repo across host plugins, and re-runs of the same engine should
      // be idempotent.
      if ((err as Error).message !== 'repo already exists') throw err;
    }
    createdWorkspaces.add(workspaceId);
  };

  const guardClosed = (): void => {
    if (closed) {
      throw new Error('GitEngine: operation after shutdown()');
    }
  };

  const apply = async (
    workspaceId: string,
    input: WorkspaceApplyInput,
    author?: WorkspaceDelta['author'],
  ): Promise<WorkspaceApplyOutput> => {
    guardClosed();
    return enqueue(workspaceId, async () => {
      guardClosed();
      const remoteUrl = remoteUrlFor(opts.baseUrl, workspaceId);

      return opts.mirrorCache.withMirror(workspaceId, async (handle) => {
        // 1. Ensure the repo exists on the storage tier (first apply only).
        await ensureRepoCreated(workspaceId);

        // 2. Fetch latest state into the mirror.
        await fetchMirror(remoteUrl, opts.token, handle.dir);

        // 3. Read current mirror head.
        const mirrorHead = await currentMirrorOid(handle.dir);
        const callerParent =
          input.parent === null ? null : (input.parent as string);

        // 4. Validate parent matches mirror head (the same logic from
        // plugin-test-only.ts:528-547, kept verbatim). Each rejection carries
        // the freshly-fetched mirror head as `cause.actualParent` so retry
        // loops can rebase without re-querying.
        if (mirrorHead === null && callerParent !== null) {
          throw parentMismatch(
            'mirror has no commits; caller passed a non-null parent',
            mirrorHead,
          );
        }
        if (mirrorHead !== null && callerParent === null) {
          throw parentMismatch(
            'mirror has commits; caller passed parent: null',
            mirrorHead,
          );
        }
        if (
          mirrorHead !== null &&
          callerParent !== null &&
          mirrorHead !== callerParent
        ) {
          throw parentMismatch(
            'caller parent does not match current mirror head',
            mirrorHead,
          );
        }

        // 5. Build scratch tree, apply changes, commit, push.
        const scratch = await buildScratch(handle.dir, mirrorHead);
        try {
          await applyChanges(scratch, input.changes);
          const newOid = await commitScratch(scratch, input.reason);
          const push = await pushScratch(
            remoteUrl,
            opts.token,
            scratch,
            mirrorHead,
          );
          if (!push.ok) {
            if (push.nonFastForward) {
              // Our local mirror was up-to-date when we read `mirrorHead`, but
              // a concurrent writer landed a commit between our fetch and our
              // push. Re-fetch + re-read so `cause.actualParent` reflects the
              // server's NEW head (the value the caller's retry will need to
              // rebase against), not the stale `mirrorHead` we computed earlier.
              await fetchMirror(remoteUrl, opts.token, handle.dir);
              const freshHead = await currentMirrorOid(handle.dir);
              throw parentMismatch(
                'remote rejected push: non-fast-forward (concurrent writer)',
                freshHead,
              );
            }
            throw new Error(`git push failed: ${push.stderr}`);
          }

          // 6. Refresh mirror so the just-pushed commit + its blobs are
          // available for diff/contentAfter.
          await fetchMirror(remoteUrl, opts.token, handle.dir);

          // 7. Build the delta payload.
          const delta = await buildDelta(
            handle.dir,
            mirrorHead,
            newOid,
            input.reason,
            author,
          );
          return {
            version: asWorkspaceVersion(newOid),
            delta,
          };
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      });
    });
  };

  // -------------------------------------------------------------------
  // applyBundle (Phase 3): direct-bundle apply path.
  //
  // Same enqueue + parent-validate pipeline as `apply`, but instead of
  // building a scratch tree and re-hashing FileChange[] into new
  // commits, we fetch the runner's thin bundle directly into the mirror
  // and push the bundle's tip to the storage tier. The runner's commit
  // OIDs land in the bare repo verbatim (auditability win) and we save
  // the rehash cost (efficiency win).
  //
  // Determinism contract: the bundle's prerequisite is the runner's
  // local baseline OID. The mirror MUST have that OID before fetch:
  //   - First apply (mirror empty): seed via `seedMirrorWithBaseline`,
  //     reconstructing the deterministic baseline. The reconstructed
  //     OID equals input.baselineCommit by determinism.
  //   - Subsequent applies (mirror has prior turn's tip): the runner
  //     advanced its local baseline after the prior accept, so
  //     baselineCommit equals the prior tip equals mirror HEAD.
  // -------------------------------------------------------------------
  const applyBundle = async (
    workspaceId: string,
    input: WorkspaceApplyBundleInput,
    author?: WorkspaceDelta['author'],
  ): Promise<WorkspaceApplyBundleOutput> => {
    guardClosed();
    return enqueue(workspaceId, async () => {
      guardClosed();
      const remoteUrl = remoteUrlFor(opts.baseUrl, workspaceId);

      return opts.mirrorCache.withMirror(workspaceId, async (handle) => {
        // 1. Ensure repo exists on storage tier.
        await ensureRepoCreated(workspaceId);

        // 2. Pull latest state from storage tier into local mirror.
        await fetchMirror(remoteUrl, opts.token, handle.dir);

        // 3. Read mirror head + validate caller's parent.
        const mirrorHead = await currentMirrorOid(handle.dir);
        const callerParent =
          input.parent === null ? null : (input.parent as string);

        // Parent-CAS:
        //   - mirror empty + callerParent null: first apply against empty
        //     workspace. Allowed; we'll seed below.
        //   - mirror empty + callerParent non-null: also allowed when
        //     callerParent == baselineCommit == deterministic empty OID.
        //     The runner pins parentVersion to the materialize-time tip
        //     so subsequent-session writes line up with prior history;
        //     when prior history was empty, that tip IS the deterministic
        //     baseline OID, and the seededOid check below verifies it.
        //   - mirror non-null + callerParent null: rejected — runner
        //     thinks workspace is empty but it isn't.
        //   - mirror non-null + callerParent non-null + mismatch:
        //     rejected — concurrent-writer race.
        //
        // The "mirror empty + callerParent non-null" case above is now
        // ENFORCED, not just described. It used to rest on the `seededOid`
        // check below, which compares `seededOid` against `baselineCommit`
        // — never against `parent`. That gap had teeth HERE in a way it does
        // not in `@ax/workspace-git-core`: on this backend `callerParent` is
        // not merely string-compared, it is handed to `buildDelta` at step 9
        // and becomes the `<from>` argv token of `git diff-tree`. So an
        // option-shaped `parent` from a runner could reach a `git` argument.
        // Requiring equality with `baselineCommit` closes that structurally
        // AND keeps the error code intact: `baselineCommit` is itself pinned
        // to a git-minted OID by the checks below, so `parent` ends up a real
        // OID without narrowing `parent-mismatch` into a different code. That
        // code is the workspace-CAS rebase-retry contract — `@ax/memory-strata`,
        // `channel-web`, `@ax/routines-admin-routes` and `ipc-core`'s
        // commit-notify all key on it — which is why running `requireOid`
        // over `parent` would have been the wrong fix.
        if (
          mirrorHead === null &&
          callerParent !== null &&
          callerParent !== input.baselineCommit
        ) {
          throw parentMismatch(
            'mirror is empty; caller parent must be null or the declared baseline',
            null,
          );
        }
        if (mirrorHead !== null && callerParent === null) {
          throw parentMismatch(
            'mirror has commits; caller passed parent: null',
            mirrorHead,
          );
        }
        if (
          mirrorHead !== null &&
          callerParent !== null &&
          mirrorHead !== callerParent
        ) {
          throw parentMismatch(
            'caller parent does not match current mirror head',
            mirrorHead,
          );
        }

        // Capture the REMOTE's pre-apply state for the push lease.
        // This is what the storage tier should currently have at
        // refs/heads/main; it equals the mirror head we just read
        // (mirrors are kept in sync via fetchMirror at the top of every
        // apply). After we seed the mirror with a deterministic
        // baseline below, the LOCAL mirror's HEAD advances — but the
        // REMOTE doesn't. The lease must reflect the remote, not the
        // post-seed local mirror.
        const remoteLease = mirrorHead;

        // 4. If mirror is empty, seed it with the deterministic empty
        //    baseline (single empty-tree commit). The runner's first-
        //    apply baseline OID matches this OID by construction —
        //    both sides build from the same shape (sorted paths, fixed
        //    dates, fixed author env, empty tree). For non-empty
        //    mirrors, HEAD is the prior turn's tip == the runner's
        //    baseline by symmetry (after each accept, both sides
        //    advance to the same OID).
        if (mirrorHead === null) {
          const seededOid = await seedMirrorWithEmptyBaseline(handle.dir);
          if (seededOid !== input.baselineCommit) {
            throw new Error(
              `seeded baseline OID ${seededOid} does not match runner baseline ${input.baselineCommit} (determinism contract violated)`,
            );
          }
          // Note: we don't re-bind mirrorHead here. The post-seed local
          // mirror state (refs/heads/main = seededOid) doesn't affect
          // any downstream decision — the push lease uses remoteLease
          // (the REMOTE's pre-apply state), and the delta uses
          // callerParent (the runner's view).
        } else if (mirrorHead !== input.baselineCommit) {
          throw parentMismatch(
            `mirror head ${mirrorHead} does not match runner baseline ${input.baselineCommit}`,
            mirrorHead,
          );
        }

        // 5-9: Fetch + ancestry-check + push + delta. The whole sequence
        // shares one finally that removes the on-disk bundle file AND
        // clears refs/bundle/* — without the broader scope, a throw
        // between fetch and push (e.g., the new ancestry check) would
        // leak temp refs into the next apply on this workspaceId.
        const bundlePath = join(handle.dir, 'in.bundle');
        await writeFile(
          bundlePath,
          Buffer.from(input.bundleBytes, 'base64'),
        );
        try {
          // 5. Fetch the thin bundle into the mirror. Prereq is now
          //    satisfied (mirror's refs/heads/main == baselineCommit).
          const newTip = await fetchBundleIntoMirror(handle.dir, bundlePath);

          // 6. Reject bundles whose tip doesn't descend from the
          //    declared baseline. The runner's contract is "thin bundle
          //    of new commits on top of baseline." A non-thin or
          //    otherwise-detached bundle could still pass --force-with-
          //    lease (the remote ref check) and replace HEAD with
          //    unrelated history. The ancestor check closes that gap.
          //
          //    `git merge-base --is-ancestor A B` exits 0 if A is an
          //    ancestor of B, 1 if not. Anything else is an error.
          const ancestry = await runGit([
            '-C',
            handle.dir,
            'merge-base',
            '--is-ancestor',
            input.baselineCommit,
            newTip,
          ]);
          if (ancestry.code === 1) {
            throw parentMismatch(
              `bundle tip ${newTip} does not descend from baseline ${input.baselineCommit}`,
              remoteLease,
            );
          }
          if (ancestry.code !== 0) {
            throw new Error(
              `git merge-base --is-ancestor failed (exit=${ancestry.code}): ${ancestry.stderr}`,
            );
          }

          // 7. Push the bundle's tip to the storage tier. git push
          //    handles dependencies — on first apply, the baseline +
          //    bundle commits all flow together. Use `remoteLease`
          //    (the PRE-seed mirror head, == remote's current state)
          //    for the --force-with-lease check.
          const push = await pushBundleTip(
            remoteUrl,
            opts.token,
            handle.dir,
            newTip,
            remoteLease,
          );
          if (!push.ok) {
            if (push.nonFastForward) {
              await fetchMirror(remoteUrl, opts.token, handle.dir);
              const freshHead = await currentMirrorOid(handle.dir);
              throw parentMismatch(
                'remote rejected push: non-fast-forward (concurrent writer)',
                freshHead,
              );
            }
            throw new Error(`git push failed: ${push.stderr}`);
          }

          // 8. Update the local mirror's refs/heads/main to the new
          //    tip so subsequent reads/lists see the current state
          //    without requiring a fetchMirror round-trip first.
          await runGit([
            '-C',
            handle.dir,
            'update-ref',
            'refs/heads/main',
            newTip,
          ]);

          // 9. Build the delta payload. `from` is the CALLER'S view
          //    of the previous state (input.parent), not the local
          //    mirror head. For first apply, callerParent is null and
          //    the delta reads as "everything added"; for subsequent
          //    applies, callerParent equals the prior tip and we get
          //    the per-turn diff.
          const delta = await buildDelta(
            handle.dir,
            callerParent,
            newTip,
            input.reason,
            author,
          );
          return {
            version: asWorkspaceVersion(newTip),
            delta,
          };
        } finally {
          // Cleanup runs on both success AND error paths:
          //   - on-disk bundle file (always removed)
          //   - refs/bundle/* (the commit objects stay; refs/heads/main
          //     references them on success, but the temp refs would
          //     leak into the next apply otherwise — and on error we
          //     definitely don't want them lingering).
          await rm(bundlePath, { force: true });
          await clearBundleRefs(handle.dir);
        }
      });
    });
  };

  // -------------------------------------------------------------------
  // exportBaselineBundle (Phase 3): companion to applyBundle.
  //
  // The host-side commit-notify handler uses this to seed its bundler
  // scratch repo with a self-contained git bundle of the workspace's
  // state at `version`. Eliminates the need for deterministic
  // reconstruction (which only worked for first apply); the bundle's
  // tip OID matches the runner's local baseline OID by construction
  // (both come from the same git history).
  //
  // For `version: null` (first apply, mirror is empty): we synthesize
  // a deterministic empty-tree baseline. The runner's clone of this
  // bundle has the same OID, so the runner's first thin bundle's
  // prereq matches.
  //
  // For `version: <oid>` (subsequent apply): we bundle the mirror's
  // state at `oid`. The runner advances its local baseline ref to
  // this OID after each accept, so its next thin bundle's prereq
  // matches.
  //
  // Enqueues per-workspaceId so concurrent apply + export stays
  // serialized (the export needs a coherent mirror snapshot).
  // -------------------------------------------------------------------
  const exportBaselineBundle = async (
    workspaceId: string,
    input: WorkspaceExportBaselineBundleInput,
  ): Promise<WorkspaceExportBaselineBundleOutput> => {
    guardClosed();
    return enqueue(workspaceId, async () => {
      guardClosed();
      if (input.version === null) {
        // Explicit seed condition: ALWAYS the deterministic empty
        // baseline, regardless of mirror state. No mirror access
        // needed.
        const { bundleBytes } = await buildEmptyBaselineBundle();
        return { bundleBytes };
      }
      // version=undefined: bundle the mirror's CURRENT HEAD; if there
      // are no commits yet, degrade to deterministic empty baseline.
      // version=oid: bundle that exact commit. Both paths need the
      // mirror in sync with the storage tier.
      const remoteUrl = remoteUrlFor(opts.baseUrl, workspaceId);
      return opts.mirrorCache.withMirror(workspaceId, async (handle) => {
        await ensureRepoCreated(workspaceId);
        await fetchMirror(remoteUrl, opts.token, handle.dir);
        const head = await currentMirrorOid(handle.dir);
        // If the mirror is empty (no commits in storage yet), only the
        // deterministic empty-baseline OID is a valid version (the only
        // tip a prior caller could have observed). undefined → return
        // empty baseline; <empty-baseline-oid> → return empty baseline;
        // any other oid → throw (genuine misuse: forged oid or
        // wrong-workspace baseline). Matters for the FIRST commit-notify
        // of a session that materialized against an empty workspace,
        // which legitimately passes parentVersion = empty-baseline-oid.
        if (head === null) {
          const empty = await buildEmptyBaselineBundle();
          if (input.version !== undefined && input.version !== empty.oid) {
            throw new Error(
              `no commit at ${input.version} in empty workspace (expected ${empty.oid} or null)`,
            );
          }
          return { bundleBytes: empty.bundleBytes };
        }
        // Mirror non-empty: undefined → bundle HEAD.
        // version=oid and oid === head → bundle that oid (happy path).
        // version=oid and oid !== head → concurrent writer advanced the
        // mirror past the caller's version. Bundle the CURRENT head so
        // the caller can re-sync, then throw a parent-mismatch PluginError
        // inline carrying both actualParent (the real head) and
        // baselineBundleBytes (the bundle at that head). We throw inline
        // rather than delegating to a parentMismatch helper because this
        // path must attach baselineBundleBytes — the helper doesn't.
        // The caller learns exactly what it needs to rebase and retry.
        if (input.version !== undefined && (input.version as string) !== head) {
          const baselineBundleBytes = await exportMirrorBundle(handle.dir, head);
          throw new PluginError({
            code: 'parent-mismatch',
            plugin: PLUGIN_NAME,
            message: `mirror head ${head} does not match requested version ${input.version as string} (concurrent writer or stale version)`,
            cause: {
              actualParent: asWorkspaceVersion(head),
              baselineBundleBytes,
            },
          });
        }
        const oid = input.version === undefined ? head : (input.version as string);
        const bundleBytes = await exportMirrorBundle(handle.dir, oid);
        return { bundleBytes };
      });
    });
  };

  const read = async (
    workspaceId: string,
    input: WorkspaceReadInput,
  ): Promise<WorkspaceReadOutput> => {
    guardClosed();
    // Validate BEFORE the queue, the mirror lease and the storage-tier fetch.
    // The security property only needs the check to precede the argv token,
    // but a caller version does not depend on mirror state, so there is no
    // reason to buy a network round-trip and a mirror sync for a string we
    // are about to reject.
    const pinned =
      input.version === undefined
        ? undefined
        : requireOid(input.version, 'workspace:read', 'version');
    if (pinned !== undefined && batchablePath(input.path)) {
      return joinPinnedBatch(workspaceId, pinned, input.path);
    }
    return enqueue(workspaceId, () => readQueued(workspaceId, input.path, pinned));
  };

  // The body of ONE read, run from inside the workspace's queue.
  const readQueued = async (
    workspaceId: string,
    path: string,
    pinned: string | undefined,
  ): Promise<WorkspaceReadOutput> => {
    guardClosed();
    const remoteUrl = remoteUrlFor(opts.baseUrl, workspaceId);
    return opts.mirrorCache.withMirror(workspaceId, async (handle) => {
      // Pinned fast path: skip the storage-tier fetch when the mirror
      // already holds the pinned commit. Safe because a commit id names
      // immutable content — a fetch can add objects and move refs, but it
      // can never change what `<oid>:<path>` resolves to. The mirror is a
      // plain per-workspace bare repo (no alternates, no shared object
      // store), so an oid is only ever local because this workspace's own
      // history put it there.
      //
      // Cheapest order for the common case: one `cat-file -e` on the
      // blob. On a miss, a second probe tells "path absent at a commit we
      // hold" (authoritative found:false, still no fetch) apart from
      // "commit not here yet" — e.g. created through another host
      // replica's mirror after ours last synced — which falls through to
      // the fetch path below, unchanged.
      if (pinned !== undefined) {
        const hit = await runGit([
          '-C',
          handle.dir,
          'cat-file',
          '-e',
          `${pinned}:${path}`,
        ]);
        if (hit.code === 0) {
          const bytes = await readBlobBytes(handle.dir, pinned, path);
          return { found: true, bytes, version: asWorkspaceVersion(pinned) };
        }
        if (await mirrorHasCommit(handle.dir, pinned)) {
          return { found: false };
        }
      }
      // Unpinned reads always fetch: "current head" is only as fresh as
      // the last sync with the storage tier.
      await fetchMirror(remoteUrl, opts.token, handle.dir);
      const target = pinned ?? (await currentMirrorOid(handle.dir));
      if (target === null) return { found: false };
      const exists = await runGit([
        '-C',
        handle.dir,
        'cat-file',
        '-e',
        `${target}:${path}`,
      ]);
      if (exists.code !== 0) return { found: false };
      const bytes = await readBlobBytes(handle.dir, target, path);
      return { found: true, bytes, version: asWorkspaceVersion(target) };
    });
  };

  // TASK-554: coalesce pinned reads. Every read is one queued op, and the
  // queue serialises a workspace's ops, so N concurrent pinned reads used to
  // cost N ops of 2 git processes each (~23 ms apiece on loopback). Instead a
  // pinned read joins the not-yet-started batch for its (workspace, version)
  // when there is one, and a batch is ONE queued op that answers all of its
  // paths with one `git cat-file --batch`. Reads that arrive while a batch
  // runs form the next batch. The queue invariant (one mirror op at a time
  // per workspace) is unchanged: a batch IS one op.
  //
  // Answering many paths from one lookup is exactly equivalent to reading
  // them one by one, because a commit id names immutable content: nothing a
  // fetch or apply between the reads could do changes what `<oid>:<path>`
  // resolves to.
  const pendingPinnedReads = new Map<string, PinnedReadWaiter[]>();

  const joinPinnedBatch = (
    workspaceId: string,
    pinned: string,
    path: string,
  ): Promise<WorkspaceReadOutput> => {
    // NUL cannot appear in a workspace id or an oid, so the key is unambiguous.
    const key = `${workspaceId}\u0000${pinned}`;
    let waiters = pendingPinnedReads.get(key);
    if (waiters === undefined) {
      const batch: PinnedReadWaiter[] = [];
      pendingPinnedReads.set(key, batch);
      waiters = batch;
      void enqueue(workspaceId, async () => {
        // Close the batch the moment it starts: a read arriving from here on
        // must not join a lookup that has already been issued.
        if (pendingPinnedReads.get(key) === batch) pendingPinnedReads.delete(key);
        await runPinnedBatch(workspaceId, pinned, batch);
      });
    }
    const joined = waiters;
    // The executor runs synchronously, so the waiter is registered before the
    // enqueued op can start (that is at least one microtask away).
    return new Promise((resolve, reject) => {
      joined.push({ path, resolve, reject });
    });
  };

  // Settles every waiter. Never throws: the queue would swallow it and the
  // waiters would hang.
  const runPinnedBatch = async (
    workspaceId: string,
    pinned: string,
    waiters: readonly PinnedReadWaiter[],
  ): Promise<void> => {
    if (waiters.length === 1) {
      // A lone read keeps the single-read path exactly.
      const lone = waiters[0]!;
      try {
        lone.resolve(await readQueued(workspaceId, lone.path, pinned));
      } catch (err) {
        lone.reject(err);
      }
      return;
    }
    let entries: BatchEntry[] | null;
    try {
      guardClosed();
      const remoteUrl = remoteUrlFor(opts.baseUrl, workspaceId);
      entries = await opts.mirrorCache.withMirror(workspaceId, async (handle) => {
        // Same fetch rule as a single pinned read: fetch only when the commit
        // is not local. If a fetch still does not bring it, every path
        // answers `missing`, which is the single read's found:false too.
        if (!(await mirrorHasCommit(handle.dir, pinned))) {
          await fetchMirror(remoteUrl, opts.token, handle.dir);
        }
        try {
          return await catFileBatch(
            handle.dir,
            waiters.map((w) => `${pinned}:${w.path}`),
          );
        } catch {
          // A reply we could not parse must not fail reads that would have
          // succeeded alone. Fall back to one read each (below).
          return null;
        }
      });
    } catch (err) {
      // The mirror lease or the fetch failed: every single read would too.
      for (const w of waiters) w.reject(err);
      return;
    }
    if (entries === null) {
      // Still inside this op's queue slot, so one at a time is correct.
      for (const w of waiters) {
        try {
          w.resolve(await readQueued(workspaceId, w.path, pinned));
        } catch (err) {
          w.reject(err);
        }
      }
      return;
    }
    const version = asWorkspaceVersion(pinned);
    waiters.forEach((w, i) => {
      const entry = entries[i]!;
      if (entry.kind === 'blob') {
        w.resolve({ found: true, bytes: entry.bytes, version });
      } else if (entry.kind === 'missing') {
        w.resolve({ found: false });
      } else {
        // The single read fails the same way: `cat-file blob` on a tree.
        w.reject(
          new Error(`git cat-file: ${pinned}:${w.path} is a ${entry.type}, not a blob`),
        );
      }
    });
  };

  const list = async (
    workspaceId: string,
    input: WorkspaceListInput,
  ): Promise<WorkspaceListOutput> => {
    guardClosed();
    // Same fail-fast placement as `read` above.
    const pinned =
      input.version === undefined
        ? undefined
        : requireOid(input.version, 'workspace:list', 'version');
    return enqueue(workspaceId, async () => {
      guardClosed();
      const remoteUrl = remoteUrlFor(opts.baseUrl, workspaceId);
      return opts.mirrorCache.withMirror(workspaceId, async (handle) => {
        // Same pinned fast path as `read`: a commit already in the mirror
        // has an immutable tree, so list it without a fetch. A pinned oid
        // that is not local (yet) fetches first; unpinned always fetches.
        if (
          pinned === undefined ||
          !(await mirrorHasCommit(handle.dir, pinned))
        ) {
          await fetchMirror(remoteUrl, opts.token, handle.dir);
        }
        const target = pinned ?? (await currentMirrorOid(handle.dir));
        if (target === null) return { paths: [] };
        const r = await runGit([
          '-C',
          handle.dir,
          'ls-tree',
          '-r',
          '--name-only',
          target,
        ]);
        if (r.code !== 0) {
          throw new Error(`git ls-tree failed: ${r.stderr}`);
        }
        let paths = r.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        if (input.pathGlob !== undefined) {
          const re = globToRegex(input.pathGlob);
          paths = paths.filter((p) => re.test(p));
        }
        return { paths };
      });
    });
  };

  const diff = async (
    workspaceId: string,
    input: WorkspaceDiffInput,
  ): Promise<WorkspaceDiffOutput> => {
    guardClosed();
    // Same fail-fast placement as `read` above. Neither endpoint depends on
    // mirror state, so both are validated before the fetch.
    const from =
      input.from === null
        ? null
        : requireOid(input.from, 'workspace:diff', 'from');
    const to = requireOid(input.to, 'workspace:diff', 'to');
    return enqueue(workspaceId, async () => {
      guardClosed();
      const remoteUrl = remoteUrlFor(opts.baseUrl, workspaceId);
      return opts.mirrorCache.withMirror(workspaceId, async (handle) => {
        await fetchMirror(remoteUrl, opts.token, handle.dir);
        // diff() is read-only — no author (no actor performed the diff).
        const delta = await buildDelta(handle.dir, from, to, undefined, undefined);
        return { delta };
      });
    });
  };

  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Wait for every in-flight queue tail to settle before returning. New
    // calls already fail via `guardClosed`. We deliberately do NOT reach into
    // the mirror cache or lifecycle client — the caller owns those.
    const tails = Array.from(queues.values());
    await Promise.allSettled(tails);
    queues.clear();
    createdWorkspaces.clear();
  };

  const _internalQueueSize = (): number => queues.size;

  return {
    apply,
    applyBundle,
    exportBaselineBundle,
    read,
    list,
    diff,
    shutdown,
    _internalQueueSize,
  };
}
