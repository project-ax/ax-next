import type { FileChange } from './workspace.js';

// ---------------------------------------------------------------------------
// Policy-visible path filter — pure path predicate.
//
// Two callers share this single chokepoint:
//   - the `workspace:apply` facade (`workspace-apply-facade.ts`), which fires
//     `workspace:pre-apply` with the policy-visible subset of an in-process
//     apply's changes; and
//   - the IPC commit path (`@ax/ipc-core`'s `workspace-commit-notify.ts`),
//     which fires the same hook with the policy-visible subset of a runner's
//     bundle diff.
//
// Phase 3 contract (extended in Phase 0): workspace:pre-apply subscribers
// see ONLY policy-visible paths. Today that's:
//   - `.ax/**`     — agent-managed project memory (skills, identity, notes)
//   - `.claude/**` — Claude Agent SDK setting-source roots (settings.json,
//                    sub-agents, slash-commands, rules, project memory,
//                    and `.claude/skills/<name>/...` once Phase 0 enables
//                    `settingSources: ['user', 'project']`)
//
// Subscribers like the skill validator decide allow/veto on this filtered
// subset; the apply then receives the FULL change set and lands everything.
//
// Rationale: pre-apply checks are policy. Policy applies to the agent's
// own project state — its skills, its memory, its identity files — AND
// to any path the SDK reads as configuration (`.claude/**`). A model
// writing `src/main.ts` doesn't trip the validator; a model writing
// `.claude/settings.json` or `.ax/draft-skills/foo/SKILL.md` does. Keeping the
// filter at this single chokepoint means future validators (identity,
// skill schema, SDK-config veto, etc.) all see the same scope and can't
// accidentally key off paths outside the policy set.
//
// Why startsWith and not picomatch: the rule is intentionally rigid —
// "anything under .ax/ or .claude/." There's no glob nuance to express,
// no per-validator override knob, no escape hatch. A literal prefix
// check keeps the policy obvious and impossible to misconfigure.
//
// Exact-path policy: the Claude Agent SDK also loads memory files that
// live at the *project root* (no directory prefix). With
// `settingSources: ['project']` the SDK reads `<root>/CLAUDE.md` and (if
// `'local'` is added) `<root>/CLAUDE.local.md` directly. Those paths
// have no `.ax/` or `.claude/` prefix to match, so the filter forwards
// them by exact-string match — otherwise an agent write to root
// `CLAUDE.md` would slip past the validator and become a prompt-injection
// surface. The corresponding veto entries live in validator-skill's
// SDK_CONFIG_EXACT_PATHS; adding here = also add there.
//
// Lives in @ax/core (not a workspace backend) because it's
// backend-agnostic: it only depends on the core `FileChange` type, and
// every backend's `workspace:apply` facade plus the host commit path
// share it. One source of truth for the policy scope (Invariant 4).
//
// Audit source: docs/notes/2026-05-17-sdk-setting-sources-audit.md
// ---------------------------------------------------------------------------

export const POLICY_PREFIXES = ['.ax/', '.claude/'] as const;

export const POLICY_EXACT_PATHS: ReadonlySet<string> = new Set<string>([
  'CLAUDE.md',
  'CLAUDE.local.md',
]);

export function filterToPolicy(changes: readonly FileChange[]): FileChange[] {
  return changes.filter(
    (c) =>
      POLICY_EXACT_PATHS.has(c.path) ||
      POLICY_PREFIXES.some((p) => c.path.startsWith(p)),
  );
}

// ---------------------------------------------------------------------------
// Runner-immutable paths — the write the sandbox may never author (TASK-486).
//
// Separate from the policy-visible set above, and deliberately so. That set
// answers "which changes do pre-apply subscribers get to look at"; this one
// answers "which changes may a RUNNER-ORIGINATED apply contain at all". The
// second question has no subscriber, no veto knob and no transform step — the
// host refuses the turn.
//
// THE HOLE THIS CLOSES. `permanent/memory/system/rules.md` is the human-owned
// memory tier (@ax/memory-strata's `human-tier.ts`). It materializes into the
// runner's sandbox at `/agent/memory/system/rules.md`, and @ax/memory-strata's
// `inject.ts` puts it FIRST in the injected memory block, last to be truncated,
// under "## Rules From Your User". So a sentence that lands in that file is a
// standing top-of-prompt instruction for every future turn.
//
// The sandbox could write it. `commitTurnAndBundle` stages `/agent` with
// `git add -A` and `memory/` is not in the runner's gitignore, so the file rode
// the per-turn bundle to `workspace.commit-notify`. `filterToPolicy` does not
// match it, so no `workspace:pre-apply` subscriber ever saw it — and the apply
// lands the FULL change set. Net: content injected into one conversation (a
// web page, a tool result, a pasted file) that talks the agent into one file
// write becomes a permanent instruction. Design doc § 6.3's persistence vector.
//
// WHY A COMMIT-PATH GUARD AND NOT A `workspace:pre-apply` SUBSCRIBER. A
// subscriber sees `{changes, parent, reason}` and cannot tell a runner-
// originated apply from a host-originated one except by `reason` — which comes
// straight off the runner's own wire request. An allowlist on it would hand the
// sandbox the key to its own lock. Origin has to be structural: it is decided
// by WHICH code path is running, and the only runner-originated apply path is
// `workspace.commit-notify`. The host's own writer (the Rules UI, via
// `memory:rules:write` → `workspace:apply`) goes through the in-process facade
// and is untouched by this list, which is exactly the intended split.
//
// WHY THE LITERAL LIVES HERE. @ax/memory-strata owns the concept, but
// @ax/ipc-core may not import a plugin (Invariant 2) and this module is already
// the one place workspace path policy lives (Invariant 4). So the tier-relative
// literal lives here and `human-tier.ts` DERIVES `HUMAN_TIER_TIER_PATHS` from
// it — one literal, consumed in both directions, with a drift pin in
// memory-strata's `human-tier.test.ts` that fails if its own
// `permanent/`-prefixed list stops agreeing.
//
// SCOPE. `system/rules.md` plus the derived facts-export subtree
// (`permanent/memory/facts/**`, TASK-494), not `memory/**`. The other
// always-injected system files (`user.md`, `recent.md`, `map.md`) are the
// AGENT's own memory — it is supposed to write those, and the consolidator
// regenerates them end-to-end each pass, so a sandbox write there does not
// persist. `rules.md` is the one file nothing ever rewrites, which is what
// makes it the durable vector. The facts export is the mirror-image case: it
// is a host-owned read-only projection of the fact store, regenerated
// wholesale, so a runner write under it is never legitimate — the prefix rule
// covers the subtree and the bare root, while leaving `permanent/memory/`
// siblings like `facts-backup/` untouched. The ANCESTORS of the export root
// (`permanent`, `permanent/memory`) are refused too: a runner `put` of a
// file or symlink at one of those paths would otherwise replace the
// directory the export must own before the first export ever lands.
//
// Paths are posix — the exact shape `walkBundleChanges` emits
// (`git diff-tree -r --name-status -z` reports repo-relative paths with no
// `./` prefix), so an exact-set match plus a literal prefix match is the
// whole comparison. No globs.
// ---------------------------------------------------------------------------

export const RUNNER_IMMUTABLE_PATHS: ReadonlySet<string> = new Set<string>([
  'memory/system/rules.md',
]);

export const MEMORY_FACTS_EXPORT_ROOT = 'permanent/memory/facts' as const;

export const RUNNER_IMMUTABLE_PREFIXES = [`${MEMORY_FACTS_EXPORT_ROOT}/`] as const;

/**
 * The paths in `changes` a runner-originated apply may not author, sorted and
 * de-duplicated.
 *
 * Empty array = nothing to refuse. Matches BOTH `put` and `delete`: deleting
 * the human's rules file is the same loss as overwriting it, and `git add -A`
 * stages a deletion just as readily.
 *
 * Returns the offending paths (rather than a boolean) so the caller can hand
 * them back as `discardPaths` — the refusal is then scoped to exactly this file
 * and the rest of the turn's work survives in the sandbox (TASK-287).
 */
export function findRunnerImmutableViolations(
  changes: readonly FileChange[],
): string[] {
  const hits = new Set<string>();
  for (const c of changes) {
    if (
      RUNNER_IMMUTABLE_PATHS.has(c.path) ||
      RUNNER_IMMUTABLE_PREFIXES.some(
        (p) =>
          c.path === p.slice(0, -1) ||
          c.path.startsWith(p) ||
          p.slice(0, -1).startsWith(`${c.path}/`),
      )
    ) {
      hits.add(c.path);
    }
  }
  return [...hits].sort();
}
