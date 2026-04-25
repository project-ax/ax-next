import { existsSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import git from 'isomorphic-git';
import picomatch from 'picomatch';
import {
  PluginError,
  asWorkspaceVersion,
  type Bytes,
  type FileChange,
  type HookBus,
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
}
