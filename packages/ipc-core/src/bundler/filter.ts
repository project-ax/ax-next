import type { FileChange } from '@ax/core';

// ---------------------------------------------------------------------------
// Policy-visible path filter — pure path predicate.
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
// subset; workspace:apply then receives the FULL change set and lands
// everything.
//
// Rationale: pre-apply checks are policy. Policy applies to the agent's
// own project state — its skills, its memory, its identity files — AND
// to any path the SDK reads as configuration (`.claude/**`). A model
// writing `src/main.ts` doesn't trip the validator; a model writing
// `.claude/settings.json` or `.ax/skills/foo/SKILL.md` does. Keeping the
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
// Audit source: docs/notes/2026-05-17-sdk-setting-sources-audit.md
// ---------------------------------------------------------------------------

const POLICY_PREFIXES = ['.ax/', '.claude/'] as const;

const POLICY_EXACT_PATHS: ReadonlySet<string> = new Set<string>([
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
