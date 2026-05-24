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
// The OPTIONAL git thin-bundle fast-path hooks (`workspace:apply-bundle`,
// `workspace:export-baseline-bundle`) and their payload types
// (`WorkspaceApplyBundleInput` / `Output`,
// `WorkspaceExportBaselineBundleInput` / `Output`) intentionally do NOT
// live here.
//
// Those types carry git vocabulary (`bundleBytes`, `baselineCommit`) and
// would leak it into this storage-NEUTRAL kernel (invariant I1 / arch doc
// Section 4.5 — no sha / branch / bundle / ref / commit on the workspace
// surface). They live in the git-runner protocol package
// `@ax/workspace-bundle-protocol` instead (ARCH-3; mirrors how the
// git-vocabulary IPC *wire* shape lives in `@ax/ipc-protocol`, not core,
// and follows the `@ax/sandbox-protocol` precedent). Bundle-aware backends
// and the host's commit-notify / materialize handlers import the types
// from there; a non-git backend registers neither hook and never sees the
// vocabulary, falling back to the `workspace:apply(FileChange[])` path.
// ---------------------------------------------------------------------------

export interface WorkspaceReadInput {
  path: string;
  version?: WorkspaceVersion;
}
// `workspace:read` returns a discriminated result, not a thrown error, so
// subscribers can branch on absence without try/catch every time.
//
// `version` is the storage-agnostic identifier of the snapshot the bytes
// were read from. Opaque to subscribers — pass it back as `parent` on a
// subsequent `workspace:apply` to keep CAS aligned with the read.
// Backends that don't populate it (older versions, alternative impls)
// leave it undefined and callers fall back to null.
export type WorkspaceReadOutput =
  | { found: true; bytes: Bytes; version?: WorkspaceVersion }
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
