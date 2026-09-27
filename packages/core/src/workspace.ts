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

import { z, type ZodType } from 'zod';
import { PluginError } from './errors.js';

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

// ---------------------------------------------------------------------------
// Runtime `returns` contracts for the IPC-reachable workspace read hooks
// (ARCH-6). These live in `@ax/core` because the SHAPES already live here and
// are storage-neutral — `WorkspaceVersion` is a compile-time brand over a
// plain string, so the schema validates it as `z.string()` (an opaque token,
// never resolved as a path). Every workspace backend that registers these
// hooks (git-core, git-server client, the test-harness mock) imports the
// schema from here, keeping one source of truth (I4).
//
// `version` is branded `WorkspaceVersion` on the TS type but `z.string()` on
// the schema; zod can't reconstruct the brand, so we cast the exported schema
// to `ZodType<...Output>` for assignability against `registerService<I,O>`'s
// `returns?: ZodType<O>` param. The drift-guard test (round-trip a
// fully-populated value) is what actually enforces schema↔interface agreement.
// ---------------------------------------------------------------------------
export const WorkspaceReadOutputSchema = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    bytes: z.instanceof(Uint8Array),
    version: z.string().optional(),
  }),
  z.object({ found: z.literal(false) }),
]) as unknown as ZodType<WorkspaceReadOutput>;

export interface WorkspaceListInput {
  version?: WorkspaceVersion;
  pathGlob?: string;
}
export interface WorkspaceListOutput {
  paths: string[];
}
export const WorkspaceListOutputSchema = z.object({
  paths: z.array(z.string()),
}) as unknown as ZodType<WorkspaceListOutput>;

// ---------------------------------------------------------------------------
// ARCH-12: runtime `returns` contracts for the write-path workspace hooks
// `workspace:apply` (validated once at the @ax/core facade) and
// `workspace:diff` (validated at each backend's registration).
//
// `WorkspaceChange` carries LAZY `contentBefore?/contentAfter?: () => Promise<Bytes>`
// functions. A strict zod object schema strips undeclared keys (hook-bus.ts —
// "object schemas *strip* undeclared keys by default"), which would silently
// delete those fns and (a) break the cross-backend `workspace-contract.ts`
// assertion `expect(typeof ch.contentAfter).toBe('function')` and (b) sever
// subscribers' content access (e.g. `@ax/routines` sync reading
// `change.contentAfter`). So the change-element schema validates only the
// serializable data fields (`path`, `kind`) and `.passthrough()`es the rest —
// zod 3 passthrough keeps function-valued keys by REFERENCE IDENTITY (verified
// against zod 3.25.76), so the lazy fns ride through `.parse()` untouched. This
// is the same `.passthrough()` reasoning as `sandbox:open-session`'s handle.
//
// `WorkspaceVersion` is a compile-time brand over string, so `before`/`after`
// validate as `z.string()` (an opaque token, never resolved as a path). The
// schemas are cast to `ZodType<...>` for assignability against
// `registerService<I,O>`'s `returns?: ZodType<O>` param; the drift-guard tests
// (round-trip a fully-populated value, assert fn refs survive) enforce
// schema↔interface agreement.
// ---------------------------------------------------------------------------
const WorkspaceChangeSchema = z
  .object({
    path: z.string(),
    kind: z.enum(['added', 'modified', 'deleted']),
  })
  .passthrough();

export const WorkspaceDeltaSchema = z.object({
  before: z.string().nullable(),
  after: z.string(),
  reason: z.string().optional(),
  author: z
    .object({
      agentId: z.string().optional(),
      userId: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .optional(),
  changes: z.array(WorkspaceChangeSchema),
}) as unknown as ZodType<WorkspaceDelta>;

export const WorkspaceApplyOutputSchema = z.object({
  version: z.string(),
  delta: WorkspaceDeltaSchema as unknown as ZodType<WorkspaceDelta>,
}) as unknown as ZodType<WorkspaceApplyOutput>;

export interface WorkspaceDiffInput {
  from: WorkspaceVersion | null;
  to: WorkspaceVersion;
}
export interface WorkspaceDiffOutput {
  delta: WorkspaceDelta;
}
export const WorkspaceDiffOutputSchema = z.object({
  delta: WorkspaceDeltaSchema as unknown as ZodType<WorkspaceDelta>,
}) as unknown as ZodType<WorkspaceDiffOutput>;

// ---------------------------------------------------------------------------
// `workspace:purge` (TASK-576) — irrecoverable removal of a path selector.
//
// Semantics: remove every path under `prefixes` (except the exact paths in
// `keep`) from the CURRENT version AND from EVERY RETAINED PAST VERSION, so
// that no version the backend still holds — and no storage it still holds —
// can yield the removed bytes again. Paths outside the selector, and the
// `keep` paths, are untouched in every version (their content and their
// history survive).
//
// This is deliberately storage-agnostic: a versioned-object backend deletes
// the objects under the prefixes from every retained manifest and purges the
// noncurrent object versions; a history-based backend rewrites its history and
// drops the unreachable storage. Neither backend's vocabulary appears here.
//
//   - `purged`              sorted, distinct paths erased from ANY version
//                           (current or past). Empty when nothing matched.
//   - `version`             the current version after the purge; null when
//                           the workspace holds no versions at all.
//   - `pastVersionsChanged` true when past version identifiers were rewritten.
//                           A caller holding an older WorkspaceVersion must
//                           re-read; the old identifier no longer resolves.
//
// `prefixes` are relative POSIX directory prefixes ending in '/'. `keep` are
// exact file paths, each lying under at least one prefix. Both are validated
// by `validatePurgeSelector` — every backend calls it before touching storage.
// ---------------------------------------------------------------------------
export interface WorkspacePurgeInput {
  prefixes: string[];
  keep?: string[];
}
export interface WorkspacePurgeOutput {
  purged: string[];
  version: WorkspaceVersion | null;
  pastVersionsChanged: boolean;
}
export const WorkspacePurgeOutputSchema = z.object({
  purged: z.array(z.string()),
  version: z.string().nullable(),
  pastVersionsChanged: z.boolean(),
}) as unknown as ZodType<WorkspacePurgeOutput>;

export const PURGE_MAX_PREFIXES = 16;
export const PURGE_MAX_KEEP = 64;

function purgeInvalid(message: string): PluginError {
  return new PluginError({
    code: 'invalid-input',
    plugin: 'core',
    hookName: 'workspace:purge',
    message: `workspace:purge selector rejected: ${message}`,
  });
}

// Relative POSIX path made of non-empty segments; none is '.', '..' or '.git';
// no NUL, no backslash. The path text itself is never echoed into the error
// (it may be caller-supplied), only its index.
function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.startsWith('/')) return false;
  if (p.includes('\0') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..' || seg === '.git') return false;
  }
  return true;
}

/**
 * Throws PluginError('invalid-input') unless `input` is a well-formed purge
 * selector (see the `workspace:purge` block comment above). Pure; no I/O.
 */
export function validatePurgeSelector(input: WorkspacePurgeInput): void {
  if (input === null || typeof input !== 'object') throw purgeInvalid('input must be an object');
  const { prefixes, keep } = input as { prefixes?: unknown; keep?: unknown };
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    throw purgeInvalid('prefixes must be a non-empty array');
  }
  if (prefixes.length > PURGE_MAX_PREFIXES) {
    throw purgeInvalid(`at most ${PURGE_MAX_PREFIXES} prefixes`);
  }
  prefixes.forEach((p: unknown, i) => {
    if (typeof p !== 'string' || !p.endsWith('/') || !isSafeRelativePath(p.slice(0, -1))) {
      throw purgeInvalid(`prefixes[${i}] must be a relative POSIX directory prefix ending in '/'`);
    }
  });
  if (keep === undefined) return;
  if (!Array.isArray(keep)) throw purgeInvalid('keep must be an array');
  if (keep.length > PURGE_MAX_KEEP) throw purgeInvalid(`at most ${PURGE_MAX_KEEP} keep paths`);
  keep.forEach((k: unknown, i) => {
    if (typeof k !== 'string' || k.endsWith('/') || !isSafeRelativePath(k)) {
      throw purgeInvalid(`keep[${i}] must be a relative POSIX file path`);
    }
    if (!(prefixes as string[]).some((p) => k.startsWith(p))) {
      throw purgeInvalid(`keep[${i}] must lie under one of the prefixes`);
    }
  });
}
