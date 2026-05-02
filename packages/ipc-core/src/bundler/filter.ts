import type { FileChange } from '@ax/core';

// ---------------------------------------------------------------------------
// `.ax/**` filter — pure path predicate.
//
// Phase 3 contract: workspace:pre-apply subscribers see ONLY agent-managed
// project memory (`.ax/**`). Subscribers like the skill validator
// (Slice 8) decide allow/veto on this filtered subset; workspace:apply
// then receives the FULL change set and lands everything.
//
// Rationale: pre-apply checks are policy. Policy applies to the agent's
// own project state — its skills, its memory, its identity files —
// not to the user's source code. A model writing `src/main.ts` doesn't
// trip the skill validator; a model writing `.ax/skills/foo/SKILL.md`
// does. Keeping the filter at this single chokepoint means future
// validators (identity, skill schema, etc.) all see the same scope and
// can't accidentally key off paths outside `.ax/`.
//
// Why startsWith and not picomatch: the rule is intentionally rigid —
// "anything under .ax/." There's no glob nuance to express, no
// per-validator override knob, no escape hatch. A literal prefix check
// keeps the policy obvious and impossible to misconfigure.
// ---------------------------------------------------------------------------

const AX_PREFIX = '.ax/';

export function filterToAx(changes: readonly FileChange[]): FileChange[] {
  return changes.filter((c) => c.path.startsWith(AX_PREFIX));
}
