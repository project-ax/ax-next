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
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
} from '@ax/core';
import type { MirrorCache } from './mirror-cache.js';
import type { RepoLifecycleClient } from './repo-lifecycle.js';

const PLUGIN_NAME = '@ax/workspace-git-server';

// Author env for commits made by the engine. Production callers (Task 11+)
// will route the agent identity through here; for now a fixed identity keeps
// the contract stable across host-plugin variants.
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'ax-runner',
  GIT_AUTHOR_EMAIL: 'ax-runner@example.com',
  GIT_COMMITTER_NAME: 'ax-runner',
  GIT_COMMITTER_EMAIL: 'ax-runner@example.com',
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
    // Anything else propagates.
    const msg = r.stderr.toLowerCase();
    if (
      msg.includes('empty repository') ||
      msg.includes("couldn't find remote ref") ||
      msg.includes('does not appear to be a git repository')
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
  apply(workspaceId: string, input: WorkspaceApplyInput): Promise<WorkspaceApplyOutput>;
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

  const parentMismatch = (message: string): PluginError =>
    new PluginError({
      code: 'parent-mismatch',
      plugin: PLUGIN_NAME,
      message,
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
  ): Promise<WorkspaceApplyOutput> => {
    guardClosed();
    return enqueue(workspaceId, async () => {
      guardClosed();
      const remoteUrl = remoteUrlFor(opts.baseUrl, workspaceId);

      // 1. Acquire mirror.
      const handle = await opts.mirrorCache.acquire(workspaceId);

      // 2. Ensure the repo exists on the storage tier (first apply only).
      await ensureRepoCreated(workspaceId);

      // 3. Fetch latest state into the mirror.
      await fetchMirror(remoteUrl, opts.token, handle.dir);

      // 4. Read current mirror head.
      const mirrorHead = await currentMirrorOid(handle.dir);
      const callerParent =
        input.parent === null ? null : (input.parent as string);

      // 5. Validate parent matches mirror head (the same logic from
      // plugin-test-only.ts:528-547, kept verbatim).
      if (mirrorHead === null && callerParent !== null) {
        throw parentMismatch(
          'mirror has no commits; caller passed a non-null parent',
        );
      }
      if (mirrorHead !== null && callerParent === null) {
        throw parentMismatch('mirror has commits; caller passed parent: null');
      }
      if (
        mirrorHead !== null &&
        callerParent !== null &&
        mirrorHead !== callerParent
      ) {
        throw parentMismatch('caller parent does not match current mirror head');
      }

      // 6. Build scratch tree, apply changes, commit, push.
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
            throw parentMismatch(
              'remote rejected push: non-fast-forward (concurrent writer)',
            );
          }
          throw new Error(`git push failed: ${push.stderr}`);
        }

        // 7. Refresh mirror so the just-pushed commit + its blobs are
        // available for diff/contentAfter.
        await fetchMirror(remoteUrl, opts.token, handle.dir);

        // 8. Build the delta payload.
        const delta = await buildDelta(
          handle.dir,
          mirrorHead,
          newOid,
          input.reason,
        );
        return {
          version: asWorkspaceVersion(newOid),
          delta,
        };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  };

  const read = async (
    workspaceId: string,
    input: WorkspaceReadInput,
  ): Promise<WorkspaceReadOutput> => {
    guardClosed();
    return enqueue(workspaceId, async () => {
      guardClosed();
      const remoteUrl = remoteUrlFor(opts.baseUrl, workspaceId);
      const handle = await opts.mirrorCache.acquire(workspaceId);
      await fetchMirror(remoteUrl, opts.token, handle.dir);
      const target =
        input.version !== undefined
          ? (input.version as string)
          : await currentMirrorOid(handle.dir);
      if (target === null) return { found: false };
      const exists = await runGit([
        '-C',
        handle.dir,
        'cat-file',
        '-e',
        `${target}:${input.path}`,
      ]);
      if (exists.code !== 0) return { found: false };
      const bytes = await readBlobBytes(handle.dir, target, input.path);
      return { found: true, bytes };
    });
  };

  const list = async (
    workspaceId: string,
    input: WorkspaceListInput,
  ): Promise<WorkspaceListOutput> => {
    guardClosed();
    return enqueue(workspaceId, async () => {
      guardClosed();
      const remoteUrl = remoteUrlFor(opts.baseUrl, workspaceId);
      const handle = await opts.mirrorCache.acquire(workspaceId);
      await fetchMirror(remoteUrl, opts.token, handle.dir);
      const target =
        input.version !== undefined
          ? (input.version as string)
          : await currentMirrorOid(handle.dir);
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
  };

  const diff = async (
    workspaceId: string,
    input: WorkspaceDiffInput,
  ): Promise<WorkspaceDiffOutput> => {
    guardClosed();
    return enqueue(workspaceId, async () => {
      guardClosed();
      const remoteUrl = remoteUrlFor(opts.baseUrl, workspaceId);
      const handle = await opts.mirrorCache.acquire(workspaceId);
      await fetchMirror(remoteUrl, opts.token, handle.dir);
      const from = input.from === null ? null : (input.from as string);
      const to = input.to as string;
      const delta = await buildDelta(handle.dir, from, to, undefined);
      return { delta };
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

  return { apply, read, list, diff, shutdown, _internalQueueSize };
}
