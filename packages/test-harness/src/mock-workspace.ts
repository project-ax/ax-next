import picomatch from 'picomatch';
import {
  PluginError,
  asWorkspaceVersion,
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

const PLUGIN_NAME = '@ax/test-harness/mock-workspace';

type Snapshot = Map<string, Bytes>;

// Defensive copy helper — every byte that crosses the plugin boundary is a
// fresh allocation so subscribers can't mutate snapshot storage by writing
// through the returned Uint8Array.
function copyBytes(b: Bytes): Bytes {
  return new Uint8Array(b);
}

function snapshotPaths(snap: Snapshot): string[] {
  return [...snap.keys()].sort();
}

function buildDelta(
  before: Snapshot,
  after: Snapshot,
  beforeVersion: WorkspaceVersion | null,
  afterVersion: WorkspaceVersion,
  reason: string | undefined,
  author: WorkspaceDelta['author'] | undefined,
): WorkspaceDelta {
  const changes: WorkspaceChange[] = [];
  const seen = new Set<string>();

  for (const [path, beforeBytes] of before) {
    seen.add(path);
    const afterBytes = after.get(path);
    if (afterBytes === undefined) {
      const snapshotBefore = beforeBytes;
      changes.push({
        path,
        kind: 'deleted',
        contentBefore: () => Promise.resolve(copyBytes(snapshotBefore)),
      });
    } else if (!bytesEqual(beforeBytes, afterBytes)) {
      const snapshotBefore = beforeBytes;
      const snapshotAfter = afterBytes;
      changes.push({
        path,
        kind: 'modified',
        contentBefore: () => Promise.resolve(copyBytes(snapshotBefore)),
        contentAfter: () => Promise.resolve(copyBytes(snapshotAfter)),
      });
    }
  }
  for (const [path, afterBytes] of after) {
    if (seen.has(path)) continue;
    const snapshotAfter = afterBytes;
    changes.push({
      path,
      kind: 'added',
      contentAfter: () => Promise.resolve(copyBytes(snapshotAfter)),
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

function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function applyChanges(base: Snapshot, changes: FileChange[]): Snapshot {
  const next: Snapshot = new Map();
  for (const [path, bytes] of base) next.set(path, bytes);
  for (const change of changes) {
    if (change.kind === 'put') {
      // Defensive copy on the way in too, so callers can mutate their input
      // buffer after apply() without poisoning our snapshot.
      next.set(change.path, copyBytes(change.content));
    } else {
      next.delete(change.path);
    }
  }
  return next;
}

/**
 * In-memory linear-history workspace plugin. Used by the shared workspace
 * contract test-suite to prove that the contract isn't accidentally
 * git-shaped — anything that passes here AND passes for `@ax/workspace-git`
 * is genuinely backend-agnostic.
 *
 * Versions are minted as opaque `mock-N` strings (intentionally NOT a SHA)
 * so subscribers that try to parse a `WorkspaceVersion` will break, the
 * way they should.
 */
export function createMockWorkspacePlugin(): Plugin {
  const snapshots = new Map<WorkspaceVersion, Snapshot>();
  let latest: WorkspaceVersion | null = null;
  let counter = 0;

  const mintVersion = (): WorkspaceVersion =>
    asWorkspaceVersion(`mock-${counter++}`);

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
    init({ bus }) {
      bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        PLUGIN_NAME,
        async (ctx, input) => {
          if (input.parent !== latest) {
            throw new PluginError({
              code: 'parent-mismatch',
              plugin: PLUGIN_NAME,
              hookName: 'workspace:apply',
              message: `expected parent ${latest === null ? 'null' : latest}, got ${input.parent === null ? 'null' : input.parent}`,
            });
          }

          const author: WorkspaceDelta['author'] = {
            agentId: ctx.agentId,
            userId: ctx.userId,
            sessionId: ctx.sessionId,
          };

          // Empty changes against a non-null latest: noop. Return latest
          // unchanged so subscribers don't see a phantom version bump.
          if (input.changes.length === 0 && latest !== null) {
            const delta: WorkspaceDelta = {
              before: latest,
              after: latest,
              changes: [],
            };
            if (input.reason !== undefined) delta.reason = input.reason;
            delta.author = author;
            return { version: latest, delta };
          }

          const parentSnapshot: Snapshot =
            latest === null ? new Map() : snapshots.get(latest) ?? new Map();
          const nextSnapshot = applyChanges(parentSnapshot, input.changes);
          const nextVersion = mintVersion();
          snapshots.set(nextVersion, nextSnapshot);

          const delta = buildDelta(
            parentSnapshot,
            nextSnapshot,
            latest,
            nextVersion,
            input.reason,
            author,
          );
          latest = nextVersion;
          return { version: nextVersion, delta };
        },
      );

      bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const version = input.version ?? latest;
          if (version === null) return { found: false };
          const snap = snapshots.get(version);
          if (snap === undefined) return { found: false };
          const bytes = snap.get(input.path);
          if (bytes === undefined) return { found: false };
          return { found: true, bytes: copyBytes(bytes) };
        },
      );

      bus.registerService<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const version = input.version ?? latest;
          if (version === null) return { paths: [] };
          const snap = snapshots.get(version);
          if (snap === undefined) return { paths: [] };
          let paths = snapshotPaths(snap);
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
          let fromSnapshot: Snapshot;
          if (input.from === null) {
            fromSnapshot = new Map();
          } else {
            const found = snapshots.get(input.from);
            if (found === undefined) {
              throw new PluginError({
                code: 'unknown-version',
                plugin: PLUGIN_NAME,
                hookName: 'workspace:diff',
                message: `unknown version: ${input.from}`,
              });
            }
            fromSnapshot = found;
          }
          const toSnapshot = snapshots.get(input.to);
          if (toSnapshot === undefined) {
            throw new PluginError({
              code: 'unknown-version',
              plugin: PLUGIN_NAME,
              hookName: 'workspace:diff',
              message: `unknown version: ${input.to}`,
            });
          }
          const delta = buildDelta(
            fromSnapshot,
            toSnapshot,
            input.from,
            input.to,
            undefined,
            undefined,
          );
          return { delta };
        },
      );
    },
  };
}
