// ---------------------------------------------------------------------------
// Agent-tier sync — bridge the FS-based memory pipeline to the per-agent
// `/agent` governed git tier (TASK-182).
//
// THE BUG THIS FIXES. memory-strata's observer + consolidator do a local-FS
// read-modify-write over `<workspaceRoot>/permanent/memory/**`. In the k8s
// preset the host's `ctx.workspace.rootPath` is `process.cwd()` (e.g.
// `/opt/ax-next/host`) — a SINGLE path shared by every agent. So two things
// were broken at once:
//   1. POOLING — every agent's consolidated memory landed in the one shared
//      host dir, not isolated per agent.
//   2. INERT REFLECTION — that host dir is the host pod's filesystem; it never
//      reaches a runner pod. The reflection runner reads `/agent/memory/...`
//      inside its OWN sandbox and finds nothing, so skill-crystallization
//      no-ops (the TASK-180 walk failure).
//
// THE FIX. The per-agent `/agent` git tier is the single durable home for
// consolidated memory. The git tier is keyed by agentId alone (TASK-257) — the
// same keying the runner's `/agent` materialize bundle uses — so writing
// through it is BOTH per-agent-isolated AND visible to that agent's
// reflection runner. (It is no longer per-caller: every user authorized to
// reach the agent shares the same repo — see `workspace-id.ts`.)
//
// Mechanism (mirrors @ax/channel-web's routes-agent-identity, the established
// pattern for host→/agent writes):
//   - hydrate: read the agent's `memory/**` subtree out of `/agent` (via the
//     `workspace:list` + `workspace:read` service hooks) into a fresh local
//     scratch dir, laid out as `permanent/memory/**` so the UNCHANGED FS
//     pipeline (observer / consolidator / inject / bootstrap) operates on it.
//   - <run the existing FS pipeline on the scratch>
//   - flush: diff the scratch's `permanent/memory/**` against the hydrated
//     baseline and apply the delta to `/agent` as `memory/**` via
//     `workspace:apply`, owner-routed by the same ctx. The git tier's CAS
//     rebase-on-mismatch contract merges concurrent same-tree writes; a true
//     same-file conflict resolves last-write-wins (the human decision).
//
// `/agent` is canonical; the scratch is a disposable per-operation working
// copy rebuilt from `/agent` every time (Invariant 4 — one source of truth for
// where memory lives). No host-pod state persists between operations.
//
// STORAGE-AGNOSTIC (Invariant 1): this module speaks only the neutral
// `workspace:*` hook surface (`paths`, opaque `version`, `put`/`delete`
// FileChange) — no git / sha / bundle vocabulary leaks in. A non-git workspace
// backend that registered the same hooks would work unchanged.
// ---------------------------------------------------------------------------

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import {
  PluginError,
  asWorkspaceVersion,
  type AgentContext,
  type FileChange,
  type HookBus,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
  type WorkspaceVersion,
} from '@ax/core';
import { stripHumanTierChanges } from './human-tier.js';
import { AGENT_TIER_MEMORY_ROOT, MEMORY_ROOT } from './paths.js';

/**
 * Where the memory subtree lives inside the `/agent` git tier. The FS pipeline
 * uses `permanent/memory/**` (MEMORY_ROOT) under the local scratch; the git
 * tier drops the `permanent/` host-layout prefix so the reflection runner reads
 * `/agent/memory/system/recent.md` — the path the skill-crystallization design
 * documents as the consolidated-memory home.
 *
 * Defined in `paths.ts` (so `human-tier.ts` can derive the human tier's
 * tier-side path without importing this module) and re-exported here, where
 * every existing importer already looks for it.
 */
export { AGENT_TIER_MEMORY_ROOT };

/** `permanent/memory/foo` (scratch-relative) → `memory/foo` (/agent tier). */
export function scratchRelToTierPath(scratchRel: string): string {
  // scratchRel is always posix-style (we build it from MEMORY_ROOT + posix
  // joins). Strip the MEMORY_ROOT prefix, re-root under AGENT_TIER_MEMORY_ROOT.
  const tail = scratchRel.slice(MEMORY_ROOT.length + 1); // drop "permanent/memory/"
  return posix.join(AGENT_TIER_MEMORY_ROOT, tail);
}
/** `memory/foo` (/agent tier) → `permanent/memory/foo` (scratch-relative). */
function tierToScratchRelPath(tierPath: string): string {
  const tail = tierPath.slice(AGENT_TIER_MEMORY_ROOT.length + 1); // drop "memory/"
  return posix.join(MEMORY_ROOT, tail);
}

export interface HydratedTier {
  /** Absolute path of the fresh scratch dir. Caller passes this as the FS
   *  pipeline's `workspaceRoot`, then MUST `dispose()` it. */
  scratchRoot: string;
  /** The `/agent` tier version the scratch was hydrated from — passed back as
   *  the `parent` CAS token on flush. null when the tier has no commit yet. */
  baseVersion: WorkspaceVersion | null;
  /** tier-path → bytes, captured at hydrate time, so flush can compute a
   *  minimal put/delete delta (don't re-ship unchanged files). */
  baseline: Map<string, Uint8Array>;
  /** Remove the scratch dir. Best-effort; safe to call more than once. */
  dispose(): Promise<void>;
}

/** Is `tierPath` a file path inside the agent tier's memory subtree? A prefix
 *  check alone is not enough: `memory/../x` passes it and then normalizes out
 *  of the subtree (and, joined onto the scratch root, out of the scratch). */
function isTierMemoryPath(tierPath: string): boolean {
  if (!tierPath.startsWith(`${AGENT_TIER_MEMORY_ROOT}/`)) return false;
  return tierPath.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export interface HydrateOptions {
  /**
   * Hydrate ONLY these tier paths (e.g. `memory/system/agent.md`) instead of
   * the whole `memory/**` subtree: `workspace:list` is skipped and each path is
   * read directly. Paths outside the memory subtree are ignored — this module
   * never pulls non-memory files into the scratch.
   *
   * SAFE ONLY FOR CREATE-ONLY PIPELINES. `flushAgentTier` computes deletions
   * as baseline-minus-scratch, so a file that was never read is in neither and
   * is never deleted — and a pipeline that only creates files (bootstrap, with
   * its O_EXCL seeds) sees everything it needs. Rewriting a file that IS in
   * `only` is equally safe — bootstrap's placeholder `agent.md` repair
   * (TASK-556) does exactly that — because the baseline holds it and the flush
   * ships the change as a plain put. But a pipeline that reads,
   * rewrites or deletes OTHER files (observer, consolidator, memory_note) would
   * see a scratch missing most of the agent's memory: it would rebuild derived
   * files from a fraction of the data, or fail to find what it should delete.
   * Those callers MUST hydrate fully (omit `only`). (TASK-513)
   */
  only?: readonly string[];
}

/**
 * Read the agent's `memory/**` out of `/agent` into a fresh local scratch dir
 * laid out as `permanent/memory/**`. The returned `scratchRoot` is what the
 * caller hands to the unchanged observer / consolidator / bootstrap pipeline.
 *
 * Reads are routed by `ctx.agentId` — the git tier confines each read to
 * that agent's repo, so the scratch can never contain another agent's
 * memory. (The repo is shared by every user authorized to reach that agent;
 * `ctx.userId` no longer selects a distinct repo — see `workspace-id.ts`.)
 *
 * ONE SNAPSHOT (TASK-513). The first read that finds a file returns the tier
 * version it read from; every later read passes that `version`, so the whole
 * scratch comes from one snapshot and `baseVersion` names it. Unpinned, each
 * read could land on a different head if a runner commit landed mid-hydrate —
 * a torn scratch whose `baseVersion` was whichever head the last read saw.
 * (The list stays unpinned: it runs before any version is known, and a listed
 * path the pinned snapshot lacks is simply not found.)
 */
export async function hydrateAgentTier(
  bus: HookBus,
  ctx: AgentContext,
  opts: HydrateOptions = {},
): Promise<HydratedTier> {
  const scratchRoot = await mkdtemp(join(tmpdir(), 'ax-mem-tier-'));
  const dispose = async (): Promise<void> => {
    await rm(scratchRoot, { recursive: true, force: true });
  };
  // TASK-556: until this returns, the caller holds no `dispose` — every
  // caller's own `finally` starts after the hydrate — so a list, read or write
  // that throws mid-hydrate must remove the scratch dir here.
  try {
    const { baseline, baseVersion } = await populateScratch(bus, ctx, opts, scratchRoot);
    return { scratchRoot, baseVersion, baseline, dispose };
  } catch (err) {
    await dispose().catch(() => undefined); // never mask the hydrate error
    throw err;
  }
}

async function populateScratch(
  bus: HookBus,
  ctx: AgentContext,
  opts: HydrateOptions,
  scratchRoot: string,
): Promise<{ baseline: Map<string, Uint8Array>; baseVersion: WorkspaceVersion | null }> {
  const baseline = new Map<string, Uint8Array>();
  let baseVersion: WorkspaceVersion | null = null;

  let candidates: readonly string[];
  if (opts.only !== undefined) {
    candidates = opts.only;
  } else {
    const listed = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
      'workspace:list',
      ctx,
      { pathGlob: `${AGENT_TIER_MEMORY_ROOT}/**` },
    );
    candidates = listed.paths;
  }
  // `pathGlob` is advisory — a backend MAY ignore it and return everything
  // (the local git-core backend does). Filter defensively so the scratch only
  // contains memory files regardless of backend filtering — and regardless of
  // what a caller put in `only`. Dedupe so a repeated `only` entry is one read.
  const memPaths = [...new Set(candidates.filter(isTierMemoryPath))];

  for (const tierPath of memPaths) {
    const input: WorkspaceReadInput =
      baseVersion === null ? { path: tierPath } : { path: tierPath, version: baseVersion };
    const read: WorkspaceReadOutput = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      ctx,
      input,
    );
    if (!read.found) continue;
    if (baseVersion === null && read.version !== undefined) baseVersion = read.version;
    baseline.set(tierPath, read.bytes);
    const scratchRel = tierToScratchRelPath(tierPath);
    const abs = join(scratchRoot, ...scratchRel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    // Deliberately NOT `guardAutomaticWrite`d, and this is the one write in the
    // package where that is correct (TASK-234). This copies the tier's own
    // bytes into a disposable working copy; the human tier MUST land here, or
    // the flush's diff would see it missing and try to delete it. The boundary
    // for this module is enforced on the way OUT, in `flushAgentTier`.
    await writeFile(abs, Buffer.from(read.bytes));
  }

  return { baseline, baseVersion };
}

/** Recursively list every file under `<root>/permanent/memory/`, returning
 *  scratch-relative posix paths (e.g. `permanent/memory/docs/entity/foo.md`). */
async function listScratchMemoryFiles(scratchRoot: string): Promise<string[]> {
  const memAbs = join(scratchRoot, ...MEMORY_ROOT.split('/'));
  const out: string[] = [];
  async function walk(absDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const rel = relative(scratchRoot, abs).split(sep).join('/');
        out.push(rel);
      }
    }
  }
  // memAbs may not exist (a never-seeded agent) — walk tolerates ENOENT.
  await walk(memAbs);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Apply the scratch's post-pipeline `permanent/memory/**` state back to the
 * agent's `/agent` tier as `memory/**`, as a minimal put/delete delta against
 * the hydrated baseline.
 *
 * Returns true when something was applied, false when the memory tree was
 * unchanged (a pure-chat turn that produced no observation, the common case).
 *
 * Concurrency: a CAS mismatch (the runner advanced `/agent` between hydrate and
 * flush) is retried ONCE against the tier's actual head — the established
 * workspace rebase-on-mismatch contract. Git auto-merges disjoint files; a
 * same-file collision resolves last-write-wins (this flush's bytes win).
 */
export async function flushAgentTier(
  bus: HookBus,
  ctx: AgentContext,
  hydrated: HydratedTier,
  reason: string,
): Promise<boolean> {
  const current = await listScratchMemoryFiles(hydrated.scratchRoot);
  const changes: FileChange[] = [];
  const seenTierPaths = new Set<string>();

  for (const scratchRel of current) {
    const abs = join(hydrated.scratchRoot, ...scratchRel.split('/'));
    const bytes = new Uint8Array(await readFile(abs));
    const tierPath = scratchRelToTierPath(scratchRel);
    seenTierPaths.add(tierPath);
    const prior = hydrated.baseline.get(tierPath);
    if (prior !== undefined && bytesEqual(prior, bytes)) continue; // unchanged
    changes.push({ path: tierPath, kind: 'put', content: bytes });
  }
  // Deletions: anything in the baseline the pipeline removed (decayed inbox,
  // promoted-then-deleted inbox file, quarantine move).
  for (const tierPath of hydrated.baseline.keys()) {
    if (!seenTierPaths.has(tierPath)) {
      changes.push({ path: tierPath, kind: 'delete' });
    }
  }

  /*
    TASK-234: the human tier is never part of a derived delta. This flush diffs
    a WHOLE subtree, so it can emit a change for a file the pipeline never
    deliberately touched — most dangerously a `delete`, when the scratch was
    hydrated before a concurrent human write and therefore never contained the
    file. `memory:rules:write` owns that path and applies it on its own.
  */
  const safe = stripHumanTierChanges(changes);
  if (safe.length < changes.length) {
    ctx.logger.info('memory_strata_tier_flush_skipped_human_tier', {
      agentId: ctx.agentId,
      skipped: changes.length - safe.length,
    });
  }

  if (safe.length === 0) return false;

  await applyTierChanges(bus, ctx, safe, hydrated.baseVersion, reason);
  return true;
}

const NO_ACTUAL_PARENT = Symbol('no-actual-parent');

/** Extract the tier's actual head from a workspace CAS-mismatch error so the
 *  caller can retry against it. Returns NO_ACTUAL_PARENT when the error is not
 *  a CAS miss (a real failure to rethrow). Mirrors routes-agent-identity. */
function actualParentFromMismatch(
  err: unknown,
): WorkspaceVersion | null | typeof NO_ACTUAL_PARENT {
  if (!(err instanceof PluginError) || err.code !== 'parent-mismatch') {
    return NO_ACTUAL_PARENT;
  }
  const cause = err.cause as { actualParent?: string | null } | undefined;
  if (cause === undefined || !('actualParent' in cause)) return NO_ACTUAL_PARENT;
  return cause.actualParent === null || cause.actualParent === undefined
    ? null
    : asWorkspaceVersion(cause.actualParent);
}

/**
 * Apply a put/delete delta to the agent's `/agent` tier, retrying ONCE against
 * the tier's actual head on a CAS mismatch.
 *
 * Exported for `rules-store.ts`: the human-tier write is a single-file apply
 * with exactly the same concurrency contract, and a second hand-rolled retry
 * would be a second answer to "what happens when the runner moved the tier
 * under us" (invariant 4).
 */
export async function applyTierChanges(
  bus: HookBus,
  ctx: AgentContext,
  changes: FileChange[],
  parent: WorkspaceVersion | null,
  reason: string,
): Promise<void> {
  try {
    await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', ctx, {
      changes,
      parent,
      reason,
    });
  } catch (err) {
    const actual = actualParentFromMismatch(err);
    if (actual === NO_ACTUAL_PARENT) throw err; // real failure, not a CAS miss
    // Retry once against the tier's actual head. Last-write-wins: this flush's
    // bytes overwrite a concurrent same-file change (git auto-merges disjoint
    // files; same-file collisions take our content).
    await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', ctx, {
      changes,
      parent: actual,
      reason,
    });
  }
}

/** Does the loaded deployment route memory through the `/agent` git tier?
 *  True in the k8s preset (workspace-git / workspace-git-server register
 *  `workspace:apply`); false in the local CLI preset (workspace-localdir only
 *  registers `sandbox:resolve-mounts`), which keeps writing memory directly to
 *  its per-agent localdir workspace root as before. */
export function agentTierAvailable(bus: HookBus): boolean {
  return (
    bus.hasService('workspace:apply') &&
    bus.hasService('workspace:read') &&
    bus.hasService('workspace:list')
  );
}
