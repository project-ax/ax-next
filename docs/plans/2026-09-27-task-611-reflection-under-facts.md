# TASK-611 — skill-reflection back on under facts memory

## Why

TASK-609 (#763) forced `skill-reflection` OFF under the facts preset because the
reflection prompt's recurrence gate read Strata's `memory/docs/**`
`source_conversations` frontmatter. Strata is gone (TASK-608). Facts memory stores
one `conversationId` per row (`FactRecord.conversationId`), but `memory:recall`
deliberately dropped it, so the agent saw dates and never conversations.

## Signal: per-answer conversation numbers on `memory:recall`

- `MemoryStatement.conversation?: number` — a 1-based ordinal **local to one
  answer**. Two statements carrying the same number were recorded in the same
  conversation. The number is not an id, is not stable across answers, and
  reveals nothing about which conversation it was. Absent when the row was saved
  outside a conversation (`memory:remember`, `memory_note` without one).
- Assigned in `memory:recall` over the returned page in chronological
  (`when`, `id`) order, so the evidence table reads #1, #2, … top to bottom.
- `memory_recall` (the tool) renders it as a `Conv` column (`#1`) and adds one
  line: `Distinct conversations in this evidence: N.`
- The raw conversation id never reaches a caller-facing payload (unchanged rule).

Boundary review (hook payload change on `memory:recall`):
- Alternate impl: the postgres facts engine, or any engine that echoes
  `conversationId` — the ordinal is derived in the product layer, not the engine.
- Leaky names: none. "conversation" is product vocabulary; no id, no storage term.
- Subscriber risk: a caller might treat the ordinal as stable — documented as
  per-answer only.
- Wire surface: none (host-side tool; channel-web reads the hook, additive field).

## Prompt

`SKILL_REFLECTION_PROMPT` rewritten: no `memory/docs`, no `recent.md`, no
`source_conversations`. Short-circuit: the marker records the date of the last
pass; a `memory_recall` that shows no evidence dated after it → REFLECTION_DONE.
Recurrence: a procedure qualifies only when the evidence rows that describe it
carry **2 or more different conversation numbers in the same answer**. Rows with no
number, and rows about reflection passes or skills themselves, do not count.

## Re-enable (migration, `@ax/routines`)

- Remove `RoutinesConfig.forceDisabledDefaults`, `disableDefaultRoutines`, the
  `default-disabled-by-deployment` refusal, and the preset-memory swap (it goes back
  to the k8s base's `@ax/routines`). Leaving the option would be dead code.
- Seed INSERT carries the new prompt with `spec_hash = 'seed-2026-09-27'`.
- One UPDATE, one-shot by construction: for the `skill-reflection` row still on the
  untouched old seed (`spec_hash = 'seed-2026-06-08' AND source_md = 'seed'`) set
  the new prompt + hash, bump `updated_at` (so `refreshStale` reaches materialized
  rows), and `enabled = enabled OR <a fire of default:skill-reflection exists>`.
  A re-run matches nothing because the hash moved.

What the data can and cannot tell apart:
- Per-agent human opt-outs live in `agent_default_routine_overrides_v1`; #763 never
  touched them, and neither does this. They survive.
- The GLOBAL flag: #763 wrote `false` with no marker. "Was ON (and fired) before
  #763" is detectable from fire history; "an operator turned it off globally after
  it had fired" is **not** distinguishable from "#763 turned it off" — both are
  re-enabled. There is no UI for the global flag (bus/raw SQL only).
- A deployment that never flipped reflection ON (the seed is OFF — the operator
  rollout gate) has no fires and stays OFF. The brief's "k8s base defaults
  skill-reflection ON" is not what the code does: the seed is `enabled=false`.

## Known limits of the signal (from review)

- **Self-inflation.** A reflection fire runs in a fresh per-fire conversation, and
  `@ax/memory`'s observer does not skip routine-origin turns. So after two passes,
  rows extracted from reflection turns can carry two conversation numbers. The
  prompt excludes rows about reflection or skills, but that is a prose guard
  only. This is live on deployments the migration re-enables, not only after an
  operator flip. The real fix is an observer skip for `ctx.source === 'routine'`,
  deferred because TASK-612 owns the observer right now.
- **Page-bounded.** Two genuine occurrences must land in ONE recall page (15 by
  default, 40 at most). This errs towards false negatives, the safe direction for
  a gate on auto-active skills.
- **Short-circuit dates are event dates.** The When column is when a fact became
  true, not when it was recorded. A new fact about an old event does not count as
  "after the last pass".
- **Team agents.** On a team agent the page spans members, so "2 conversations"
  can mean two people once each. No id is exposed; this only changes the meaning.
- **Operator-edited prompts** (`source_md <> 'seed'`) are left alone and may
  still name Strata paths. Operators fix those by hand.

## Tests

- `@ax/memory`: one conversation → one number and "1"; two conversations → two
  numbers and "2"; no-conversation rows carry none; raw id absent.
- `@ax/routines` migrations (Postgres): old-seed row that fired → ON + new prompt;
  old-seed row never fired → stays OFF, new prompt; re-run is a no-op; operator-edited
  row untouched; per-agent override survives.
- Prompt guard (skills canary) rewritten for the new clauses.
- preset-memory canary: skill-reflection can be flipped ON under facts memory.
