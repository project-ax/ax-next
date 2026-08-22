// ---------------------------------------------------------------------------
// The human-owned memory tier (TASK-234 / plan task AW-13).
//
// Every other file under `permanent/memory/` is written by a machine. The
// consolidator rewrites `system/user.md`, the map builder regenerates
// `system/map.md` end-to-end each pass, the recent view is thrown away and
// rebuilt, inbox observations decay after two weeks, and the rollup GC unlinks
// docs that stop being useful. That is the right behaviour for memory the
// agent worked out for itself.
//
// It is the wrong behaviour for a sentence a person typed. The Memory tab
// promises "your rules are kept word for word", and a promise the storage does
// not keep is worse than no promise at all — a user whose hand-written note is
// eaten by the strata GC does not forgive it.
//
// So there is exactly one file in the tree that no automatic writer may touch:
//
//     permanent/memory/system/rules.md
//
// HOW THAT IS ENFORCED, given a comment is not enforcement:
//
//  1. Runtime. Every automatic write site in this package calls
//     {@link guardAutomaticWrite} before it writes or unlinks. Pointing one at
//     the human tier throws — loudly, at the call site, in production.
//  2. The tier flush. `flushAgentTier` computes a whole-subtree put/delete
//     delta; {@link stripHumanTierChanges} removes the human tier from it, so
//     a scratch that lost the file can never propagate that loss to `/agent`.
//  3. Review. {@link AUTOMATIC_WRITERS} enumerates every module in this package
//     that mutates the memory tree. A static canary test scans the source for
//     FS-mutation calls and fails when a module performs one without being on
//     the list. A NEW writer added later must either register here — and
//     therefore inherit the guard — or fail the build.
//
// The one sanctioned writer lives in `rules-store.ts`, which only the
// `memory:rules:write` service hook calls, and which is reached only from a
// human clicking Save.
//
// This module imports nothing but `paths.ts` and `@ax/core` on purpose: every
// writer in the package imports it, so a heavier dependency here would make a
// cycle out of the guard.
//
// STORAGE-AGNOSTIC (invariant 1): the hook payloads this tier is reached
// through carry a `body` string and nothing else. `rulesFile()` is an
// implementation detail of the filesystem-backed strata; the alternate
// implementation (the human tier as a database row) keeps the same two hooks
// and never sees a path.
// ---------------------------------------------------------------------------

import { posix } from 'node:path';
import { PluginError } from '@ax/core';
import { AGENT_TIER_MEMORY_ROOT, MEMORY_ROOT, rulesFile } from './paths.js';

const PLUGIN_NAME = '@ax/memory-strata';

/**
 * Every workspace-relative path an automatic writer is forbidden to write or
 * delete. One entry today; the array exists so the exclusion is a value the
 * guard and {@link AUTOMATIC_WRITERS} SHARE rather than two lists that drift.
 */
export const HUMAN_TIER_PATHS: readonly string[] = Object.freeze([rulesFile()]);

/** The same file inside the per-agent `/agent` git tier (`memory/system/rules.md`). */
export const HUMAN_TIER_TIER_PATHS: readonly string[] = Object.freeze(
  HUMAN_TIER_PATHS.map((rel) =>
    posix.join(AGENT_TIER_MEMORY_ROOT, rel.slice(MEMORY_ROOT.length + 1)),
  ),
);

/**
 * Is this path human-owned?
 *
 * Accepts every shape a caller in this package actually holds: a
 * workspace-relative path (`permanent/memory/system/rules.md`), a `/agent`
 * tier path (`memory/system/rules.md`), or the absolute path a low-level FS
 * helper was handed (`/tmp/scratch-x/permanent/memory/system/rules.md`).
 * Matching a suffix on a `/` boundary is what lets ONE guard sit at every
 * write site instead of each site first having to re-derive a relative path.
 */
export function isHumanTierPath(path: string): boolean {
  const norm = path.replace(/\\/gu, '/');
  return [...HUMAN_TIER_PATHS, ...HUMAN_TIER_TIER_PATHS].some(
    (owned) => norm === owned || norm.endsWith(`/${owned}`),
  );
}

/**
 * One module in this package that mutates the memory tree without a human
 * asking it to.
 *
 * `excludes` is `HUMAN_TIER_PATHS` itself — not a copy — so a writer cannot
 * quietly declare a narrower exclusion than the one the guard enforces.
 */
export interface AutomaticWriter {
  /** How the guard names it in the error and the logs. */
  readonly name: string;
  /** Source file, relative to `packages/memory-strata/src/`. */
  readonly module: string;
  /** Paths this writer may never put or delete. */
  readonly excludes: readonly string[];
}

/**
 * THE LIST. Every module below mutates `permanent/memory/**` on its own
 * schedule — seeding, consolidating, promoting, rolling up, decaying, GCing.
 *
 * Adding a module that writes or unlinks under the memory root without adding
 * it here fails `human-tier.test.ts`'s static canary. That is deliberate: the
 * failure mode this task exists to prevent is a future writer that nobody
 * remembered to teach about the human tier.
 */
export const AUTOMATIC_WRITERS: readonly AutomaticWriter[] = Object.freeze([
  { name: 'bootstrap', module: 'bootstrap.ts', excludes: HUMAN_TIER_PATHS },
  { name: 'consolidator-decay', module: 'consolidator.ts', excludes: HUMAN_TIER_PATHS },
  { name: 'promotion', module: 'promotion.ts', excludes: HUMAN_TIER_PATHS },
  { name: 'doc-store', module: 'doc-store.ts', excludes: HUMAN_TIER_PATHS },
  { name: 'inbox-store', module: 'inbox-store.ts', excludes: HUMAN_TIER_PATHS },
  { name: 'recent', module: 'recent.ts', excludes: HUMAN_TIER_PATHS },
  { name: 'map', module: 'map.ts', excludes: HUMAN_TIER_PATHS },
  { name: 'rollup-gc', module: 'rollup.ts', excludes: HUMAN_TIER_PATHS },
  { name: 'agent-tier-flush', module: 'agent-tier-sync.ts', excludes: HUMAN_TIER_PATHS },
]);

/**
 * Refuse an automatic write to the human tier.
 *
 * Called by every write/unlink site in {@link AUTOMATIC_WRITERS}. Throwing —
 * rather than silently skipping — is the point: a writer that believes it owns
 * `rules.md` has a bug, and a swallowed skip would hide it until a user's rule
 * went missing.
 */
export function guardAutomaticWrite(writer: string, path: string): void {
  if (!isHumanTierPath(path)) return;
  throw new PluginError({
    code: 'human-tier-readonly',
    plugin: PLUGIN_NAME,
    message: `${writer} may not write ${path}: it belongs to the human, not the strata`,
    cause: { writer, path },
  });
}

/**
 * Drop any human-tier entry from a computed put/delete delta.
 *
 * `flushAgentTier` diffs a whole scratch subtree, so it can emit a change for
 * a file it never deliberately touched — most dangerously a `delete`, if the
 * scratch was hydrated before a concurrent human write and therefore never
 * contained the file. Filtering (rather than throwing) is correct HERE and
 * only here: the delta is derived, not authored, so removing the entry leaves
 * the flush's actual intent intact.
 */
export function stripHumanTierChanges<T extends { path: string }>(
  changes: readonly T[],
): T[] {
  return changes.filter((c) => !isHumanTierPath(c.path));
}

/**
 * The human's text, verbatim — with one trailing newline so the file is a
 * well-formed text file and two saves of the same content produce the same
 * bytes. No frontmatter: the other system files carry it because the strata
 * indexes them, and this one is never indexed, never summarized, and never
 * parsed. What the user typed is what gets injected.
 */
export function normalizeRulesBody(body: string): string {
  // `trimEnd()`, not `/\s+$/` — the regex backtracks polynomially on input that
  // is mostly trailing whitespace, and this body is attacker-shaped in the only
  // sense that matters: a person types it into a box. `trimEnd` is linear and
  // strips the same set.
  const trimmed = body.trimEnd();
  return trimmed.length === 0 ? '' : `${trimmed}\n`;
}
