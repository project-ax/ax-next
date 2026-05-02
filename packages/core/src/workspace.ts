// ---------------------------------------------------------------------------
// Workspace contract (architecture doc Section 4.5)
//
// Subscribers never parse a WorkspaceVersion. They pass it back to workspace
// hooks. Git impl makes it a commit SHA; GCS impl makes it a manifest object
// name. Neither leaks at this surface.
//
// Snapshots, not commits: the surface is "full set of path → content at a
// version." Backends derive that however they want. Per Section 4.5 this is
// the GCS-natural shape; git can always derive it (`git ls-tree` +
// `git diff-tree`).
// ---------------------------------------------------------------------------

export type WorkspaceVersion = string & { readonly __brand: 'WorkspaceVersion' };

export const asWorkspaceVersion = (s: string): WorkspaceVersion =>
  s as WorkspaceVersion;

export type Bytes = Uint8Array;

export type FileChange =
  | { path: string; kind: 'put'; content: Bytes }
  | { path: string; kind: 'delete' };

export type WorkspaceChangeKind = 'added' | 'modified' | 'deleted';

export interface WorkspaceChange {
  path: string;
  kind: WorkspaceChangeKind;
  // Lazy on purpose — skill validator only wants .claude/skills/**, canary
  // wants everything, indexer wants neither. Forcing eager bytes makes every
  // workspace change pay full cost regardless of who's listening.
  contentBefore?: () => Promise<Bytes>;
  contentAfter?: () => Promise<Bytes>;
}

export interface WorkspaceDelta {
  before: WorkspaceVersion | null;
  after: WorkspaceVersion;
  reason?: string;
  author?: { agentId?: string; userId?: string; sessionId?: string };
  changes: WorkspaceChange[];
}

// Service-hook payloads.
export interface WorkspaceApplyInput {
  changes: FileChange[];
  parent: WorkspaceVersion | null;
  reason?: string;
}
export interface WorkspaceApplyOutput {
  version: WorkspaceVersion;
  delta: WorkspaceDelta;
}

// ---------------------------------------------------------------------------
// `workspace:apply-bundle` (Phase 3, OPTIONAL service hook)
//
// Bundle-aware workspace plugins MAY register this in addition to
// `workspace:apply`. The host's commit-notify handler probes for it and
// uses it when available; non-bundle backends (e.g., a future GCS-backed
// implementation) leave it unregistered, in which case the handler falls
// back to the FileChange[] path.
//
// Trade-off vs. Invariant I1: this hook's input shape carries
// git-vocabulary fields (`bundleBytes`, `baselineCommit`). That's
// allowed because the hook is OPTIONAL — a non-git backend doesn't
// register it, doesn't see the vocabulary, and doesn't pay for the
// abstraction leak. The bus surface stays clean: a subscriber listing
// `workspace:apply-bundle` registrations sees nothing for non-git
// backends. The handler's fallback to `workspace:apply(FileChange[])`
// is the storage-agnostic safety net.
//
// Why this exists: round-tripping a thin bundle through `FileChange[]`
// and re-hashing in the workspace plugin is wasteful when the workspace
// is git-backed. The bundle ALREADY has the new objects in pack format;
// the workspace plugin can `git fetch <bundle>` directly into its
// mirror cache + push to storage. No rehash, no synthetic timestamps,
// and the bare repo's commit chain is bit-identical to the runner's
// chain (auditability win).
//
// Determinism contract (load-bearing): the runner ships a thin bundle
// from `<runner-baseline>..<runner-tip>`. The bundle's PREREQUISITE is
// the runner's baseline commit OID. The workspace plugin's mirror
// cache must have this exact OID at HEAD when fetch runs, or git
// rejects with "fatal: bad object". Two paths to that:
//   1. After the FIRST turn, the mirror cache's HEAD becomes the
//      runner's commit OID (whatever it is). The runner advances its
//      local baseline to match. From turn 2 onward, prereqs match by
//      construction — no determinism needed.
//   2. The FIRST turn's prereq is the materialize-time baseline
//      (built deterministically by buildBaselineBundle in the
//      materialize handler). The mirror cache's HEAD must match that
//      OID. This is the seed condition. The workspace plugin
//      reconstructs the deterministic baseline at first-apply time
//      using the same shape (sorted paths, fixed dates, fixed author).
// ---------------------------------------------------------------------------

export interface WorkspaceApplyBundleInput {
  /**
   * Base64-encoded git thin bundle. The runner produced this with
   * `git bundle create - <runner-baseline>..<runner-tip> <ref>`.
   * The bundle ships exactly one ref (the new tip).
   */
  bundleBytes: string;
  /**
   * Reconstructed baseline commit OID — the bundle's prerequisite.
   * The host bundler computed this via deterministic baseline
   * reconstruction. The workspace plugin can use it to verify the
   * bundle's prereq matches what's in its mirror cache before
   * attempting fetch.
   */
  baselineCommit: string;
  parent: WorkspaceVersion | null;
  reason?: string;
  /**
   * Snapshot of the workspace at `parent` version. The workspace
   * plugin uses this to seed its mirror cache when the cache is empty
   * (first apply for this workspaceId) so it has the baseline commit
   * to fetch the thin bundle against. After the first apply, the
   * mirror cache retains the previous turn's tip and this snapshot is
   * effectively unused — but we ship it on every call to keep the
   * input shape stable.
   */
  baselineFiles: ReadonlyArray<{ path: string; bytes: Bytes }>;
}

export type WorkspaceApplyBundleOutput = WorkspaceApplyOutput;

export interface WorkspaceReadInput {
  path: string;
  version?: WorkspaceVersion;
}
// `workspace:read` returns a discriminated result, not a thrown error, so
// subscribers can branch on absence without try/catch every time.
export type WorkspaceReadOutput =
  | { found: true; bytes: Bytes }
  | { found: false };

export interface WorkspaceListInput {
  version?: WorkspaceVersion;
  pathGlob?: string;
}
export interface WorkspaceListOutput {
  paths: string[];
}

export interface WorkspaceDiffInput {
  from: WorkspaceVersion | null;
  to: WorkspaceVersion;
}
export interface WorkspaceDiffOutput {
  delta: WorkspaceDelta;
}
