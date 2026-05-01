// ---------------------------------------------------------------------------
// Test-only host-side Plugin for @ax/workspace-git-server.
//
// Translates `workspace:*` hooks into git-protocol operations against a
// remote `@ax/workspace-git-server` instance. Maintains a per-plugin bare
// mirror in a tempdir and shells out to the system `git` binary using the
// same paranoid env discipline as the server (with author env added).
//
// NOT exported from `index.ts`. NOT registered by any preset. The point of
// existing is to satisfy `runWorkspaceContract` and the multi-replica /
// empty-repo integration tests in Phase 1 — Phase 2 replaces it with a
// production plugin that handles shard routing, retry policy, and the rest.
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
  type Plugin,
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
import { createRepoLifecycleClient } from './repo-lifecycle.js';

const PLUGIN_NAME = '@ax/workspace-git-server-test-only';

// Author env for commits made by this plugin. Production plugins (Phase 2+)
// will route the agent identity through here; for the test-only plugin a
// fixed identity keeps the contract stable.
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'ax-runner',
  GIT_AUTHOR_EMAIL: 'ax-runner@example.com',
  GIT_COMMITTER_NAME: 'ax-runner',
  GIT_COMMITTER_EMAIL: 'ax-runner@example.com',
} as const;

// Same paranoid env as the server, with PATH widened slightly (test envs
// may have git on /usr/local/bin) and author identity for commits.
const HOST_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  ...AUTHOR_ENV,
};

export interface CreateTestOnlyGitServerPluginOptions {
  /**
   * Boots a fresh server (or reuses one) and returns the connection info +
   * a workspaceId for this plugin instance to operate on. Called once per
   * `init()`.
   */
  boot: () => Promise<{
    baseUrl: string;
    token: string;
    workspaceId: string;
  }>;
}

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

interface MirrorState {
  /** Bare mirror dir for this plugin instance. */
  mirror: string;
  baseUrl: string;
  token: string;
  workspaceId: string;
  /** URL with embedded path to the bare repo on the server. */
  remoteUrl: string;
  /** Tracks the last queue tail; ensures hooks serialize per-plugin. */
  queue: Promise<unknown>;
}

function authConfig(token: string): readonly string[] {
  return ['-c', `http.extraHeader=Authorization: Bearer ${token}`];
}

async function fetchMirror(state: MirrorState): Promise<void> {
  const r = await runGit(
    [
      ...authConfig(state.token),
      '-C',
      state.mirror,
      'fetch',
      '--prune',
      state.remoteUrl,
      '+refs/heads/*:refs/heads/*',
    ],
  );
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
  state: MirrorState,
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
    const clone = await runGit(['clone', state.mirror, scratch]);
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
  state: MirrorState,
  scratch: string,
  parent: string | null,
): Promise<{ ok: true } | { ok: false; nonFastForward: boolean; stderr: string }> {
  // CAS via --force-with-lease: assert remote main matches `<parent>` (empty
  // string for the no-prior-commit case). Mismatch -> non-fast-forward error
  // surfaced as parent-mismatch.
  const lease = parent === null ? '' : parent;
  const args = [
    ...authConfig(state.token),
    '-C',
    scratch,
    'push',
    `--force-with-lease=refs/heads/main:${lease}`,
    state.remoteUrl,
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
  state: MirrorState,
  parent: string | null,
  newOid: string,
  reason: string | undefined,
): Promise<WorkspaceDelta> {
  const entries = await diffTree(state.mirror, parent, newOid);
  const changes: WorkspaceChange[] = entries.map((e) => {
    const kind = statusToKind(e.status);
    const path = e.path;
    if (kind === 'added') {
      return {
        path,
        kind: 'added',
        contentAfter: () => readBlobBytes(state.mirror, newOid, path),
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
            : readBlobBytes(state.mirror, before, path),
        contentAfter: () => readBlobBytes(state.mirror, newOid, path),
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
          : readBlobBytes(state.mirror, before, path),
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
// Plugin factory
// ---------------------------------------------------------------------------

export function createTestOnlyGitServerPlugin(
  opts: CreateTestOnlyGitServerPluginOptions,
): Plugin {
  // Mirror tempdir + queue live in closure scope; populated in init().
  let state: MirrorState | null = null;

  const enqueue = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (state === null) throw new Error('plugin not initialized');
    const next = state.queue.then(fn, fn);
    state.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const parentMismatch = (message: string): PluginError =>
    new PluginError({
      code: 'parent-mismatch',
      plugin: PLUGIN_NAME,
      message,
    });

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
      ],
      calls: [],
      subscribes: [],
    },

    async init({ bus }) {
      const { baseUrl, token, workspaceId } = await opts.boot();
      const lifecycle = createRepoLifecycleClient({ baseUrl, token });

      // 1. Best-effort create. 409 means the test/test-harness already created
      // the repo (e.g. multi-replica scenarios share one repo across plugins).
      try {
        await lifecycle.createRepo(workspaceId);
      } catch (err) {
        if ((err as Error).message !== 'repo already exists') throw err;
      }

      // 2. Per-plugin tempdir mirror. Use init --bare for the empty-baseline
      // case (the server's repo has no `refs/heads/main` until first push).
      // `git clone --mirror` against an empty repo emits a warning and exits
      // non-zero on some git versions, so we always init then fetch.
      const mirror = mkdtempSync(join(tmpdir(), 'ax-ws-server-mirror-'));
      const init = await runGit(['init', '--bare', '-b', 'main', mirror]);
      if (init.code !== 0) {
        throw new Error(`git init --bare mirror failed: ${init.stderr}`);
      }

      const remoteUrl = `${baseUrl.replace(/\/$/, '')}/${workspaceId}.git`;

      state = {
        mirror,
        baseUrl,
        token,
        workspaceId,
        remoteUrl,
        queue: Promise.resolve(),
      };

      // Initial fetch — may be a no-op against an empty server repo.
      await fetchMirror(state);

      // 3. Register the four hooks.
      bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        PLUGIN_NAME,
        async (_ctx, input) =>
          enqueue(async () => {
            if (state === null) throw new Error('plugin not initialized');
            // Refresh, then check parent matches mirror head.
            await fetchMirror(state);
            const mirrorHead = await currentMirrorOid(state.mirror);
            const callerParent = input.parent === null ? null : (input.parent as string);

            if (mirrorHead === null && callerParent !== null) {
              throw parentMismatch(
                'mirror has no commits; caller passed a non-null parent',
              );
            }
            if (mirrorHead !== null && callerParent === null) {
              throw parentMismatch(
                'mirror has commits; caller passed parent: null',
              );
            }
            if (
              mirrorHead !== null &&
              callerParent !== null &&
              mirrorHead !== callerParent
            ) {
              throw parentMismatch(
                'caller parent does not match current mirror head',
              );
            }

            // Build a working tree, apply changes, commit.
            const scratch = await buildScratch(state, mirrorHead);
            try {
              await applyChanges(scratch, input.changes);
              const newOid = await commitScratch(scratch, input.reason);

              // Push with CAS — if a concurrent writer beat us, this fails as
              // non-fast-forward and we surface parent-mismatch.
              const push = await pushScratch(state, scratch, mirrorHead);
              if (!push.ok) {
                if (push.nonFastForward) {
                  throw parentMismatch(
                    'remote rejected push: non-fast-forward (concurrent writer)',
                  );
                }
                throw new Error(`git push failed: ${push.stderr}`);
              }

              // Refresh mirror so the just-pushed commit + its blobs are
              // available for diff/contentAfter.
              await fetchMirror(state);

              const delta = await buildDelta(
                state,
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
          }),
      );

      bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        PLUGIN_NAME,
        async (_ctx, input) =>
          enqueue(async () => {
            if (state === null) throw new Error('plugin not initialized');
            await fetchMirror(state);
            const target =
              input.version !== undefined
                ? (input.version as string)
                : await currentMirrorOid(state.mirror);
            if (target === null) return { found: false };
            // Existence check — `cat-file -e` exits 0 iff the object exists.
            const exists = await runGit([
              '-C',
              state.mirror,
              'cat-file',
              '-e',
              `${target}:${input.path}`,
            ]);
            if (exists.code !== 0) return { found: false };
            const bytes = await readBlobBytes(state.mirror, target, input.path);
            return { found: true, bytes };
          }),
      );

      bus.registerService<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        PLUGIN_NAME,
        async (_ctx, input) =>
          enqueue(async () => {
            if (state === null) throw new Error('plugin not initialized');
            await fetchMirror(state);
            const target =
              input.version !== undefined
                ? (input.version as string)
                : await currentMirrorOid(state.mirror);
            if (target === null) return { paths: [] };
            const r = await runGit([
              '-C',
              state.mirror,
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
          }),
      );

      bus.registerService<WorkspaceDiffInput, WorkspaceDiffOutput>(
        'workspace:diff',
        PLUGIN_NAME,
        async (_ctx, input) =>
          enqueue(async () => {
            if (state === null) throw new Error('plugin not initialized');
            await fetchMirror(state);
            const from = input.from === null ? null : (input.from as string);
            const to = input.to as string;
            const delta = await buildDelta(state, from, to, undefined);
            return { delta };
          }),
      );
    },

    async shutdown() {
      if (state !== null) {
        try {
          rmSync(state.mirror, { recursive: true, force: true });
        } catch {
          // best-effort
        }
        state = null;
      }
    },
  };
}

// `readFile` import retained for potential future use (e.g. reading from
// scratch tree before discard); not currently referenced. Marking eslint-
// happy by exporting a no-op type alias avoids "unused import" without
// gating on a specific lint rule.
// (The actual reads go through `git cat-file blob` against the bare mirror
// so binary content is preserved without a separate fs.readFile path.)
void readFile;
