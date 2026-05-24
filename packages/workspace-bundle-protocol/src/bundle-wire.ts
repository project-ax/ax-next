import type { WorkspaceApplyOutput, WorkspaceVersion } from '@ax/core';

// ---------------------------------------------------------------------------
// @ax/workspace-bundle-protocol — the git-runner bundle-wire contract
// (ARCH-3; follows the @ax/sandbox-protocol / @ax/ipc-protocol precedent)
//
// These are the hook-bus payload types for the OPTIONAL, git-specific
// thin-bundle fast-path between the host's commit-notify / materialize
// handlers and a bundle-aware workspace backend (@ax/workspace-git,
// @ax/workspace-git-core, @ax/workspace-git-server).
//
// Why they live HERE and not in @ax/core: the kernel's workspace surface
// is storage-AGNOSTIC (architecture doc Section 4.5 — no sha / branch /
// bundle / ref / commit vocabulary). These types carry exactly that git
// vocabulary (`bundleBytes`, `baselineCommit`). Keeping them in @ax/core
// made the backend-neutral kernel carry git field names — the very I1
// leak invariant #1 forbids. Relocating them into this git-runner
// protocol package keeps the kernel clean while preserving the optional
// fast-path: a non-git backend (e.g. a future GCS-backed impl) registers
// NEITHER bundle hook and never imports this package, so it never sees
// the git vocabulary and never pays for the abstraction. The neutral
// `workspace:apply` / `read` / `list` / `diff` surface in @ax/core stays
// the cross-backend contract; this package is the additive git seam.
//
// Pure TS types, no zod: these are consumed only as in-process hook-bus
// generics (`bus.call<In, Out>` / `registerService<In, Out>`), where the
// TS type IS the whole contract. There is no untrusted wire to validate
// at this surface — the runner <-> host WIRE shape lives in
// @ax/ipc-protocol (WorkspaceCommitNotifyRequestSchema, which DOES zod-
// validate), and the git backends re-derive `baselineCommit` from their
// own scratch repo rather than trusting bus input. The two neutral types
// these reference (`WorkspaceVersion`, `WorkspaceApplyOutput`) are
// imported type-only from @ax/core (the storage-neutral kernel — no leak).
// ---------------------------------------------------------------------------

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
   * The bundle's prerequisite commit OID. The workspace plugin uses
   * it to verify the bundle's prereq matches what's in its mirror
   * cache before attempting fetch (and as a `--force-with-lease`
   * value when pushing to the storage tier).
   */
  baselineCommit: string;
  parent: WorkspaceVersion | null;
  reason?: string;
}

export type WorkspaceApplyBundleOutput = WorkspaceApplyOutput;

// ---------------------------------------------------------------------------
// `workspace:export-baseline-bundle` (Phase 3, OPTIONAL service hook)
//
// Companion to `workspace:apply-bundle`. The host-side commit-notify
// handler uses this to seed its bundler scratch repo with the
// workspace's actual git state at the runner's parentVersion,
// eliminating the need for deterministic reconstruction. Bundle-aware
// backends register both hooks together; non-bundle backends register
// neither.
//
// The output is a self-contained git bundle containing every commit
// reachable from the workspace's state at `version`, with a single ref
// (`refs/heads/main`) pointing at that state. The bundler clones this
// into its scratch repo, then loads the runner's thin bundle on top.
// The thin bundle's prereq matches the bundle's tip OID by
// construction (both are the workspace's actual head at `version`).
//
// Special cases:
//   - `version: null` (first apply): the workspace has no commits yet
//     in the storage tier. The hook returns a DETERMINISTIC empty-tree
//     baseline bundle, identical to what the materialize handler ships
//     to the runner. The runner's clone -> first-turn bundle has its
//     prereq pointing at this same deterministic OID.
//   - `version: <git-sha>` (subsequent applies): the workspace has the
//     prior turn's tip in the storage tier. The hook bundles
//     `<version>` (a single commit + everything reachable). The
//     runner's local baseline ref points at this same OID, so its
//     thin bundle's prereq matches.
//
// Same I1 trade-off as apply-bundle: this hook's input/output have
// git vocabulary (`bundleBytes`). Allowed because the hook is OPTIONAL
// and only registered by bundle-aware backends. The bus surface stays
// clean for non-bundle backends.
// ---------------------------------------------------------------------------

export interface WorkspaceExportBaselineBundleInput {
  /**
   * Which workspace state to bundle:
   *   - `undefined` (or omitted): the workspace's CURRENT HEAD. If the
   *     workspace has no commits yet, the hook returns the same
   *     deterministic empty-tree baseline as the `null` case. Used by
   *     `workspace.materialize` — the runner needs a bundle whose tip
   *     OID matches the workspace's actual HEAD, so its first thin
   *     bundle's prereq lines up with what `commit-notify` will fetch
   *     via `workspace:export-baseline-bundle({version: parent})`.
   *   - `null`: the seed condition — ALWAYS the deterministic empty-tree
   *     baseline, regardless of current state. Used by `commit-notify`
   *     when the runner reports `parentVersion: null` (first apply).
   *   - `<oid>`: bundle whatever's at that exact version in the
   *     workspace plugin's storage. Used by `commit-notify` for
   *     subsequent applies (`parent` is the runner's prior tip).
   */
  version?: WorkspaceVersion | null;
}

export interface WorkspaceExportBaselineBundleOutput {
  /**
   * Base64-encoded git bundle. Always non-empty — even an empty
   * workspace ships a bundle with one empty-tree commit on
   * `refs/heads/main`. The runner's thin bundle's prereq matches
   * this bundle's tip OID by construction.
   */
  bundleBytes: string;
}
