# `claude-memory` skill — design

**Date:** 2026-04-23
**Status:** Design approved, implementation pending
**Author:** Vinay Pulim (with Claude)

## Goal

Give Claude Code a file-based working memory per project so it can continuously self-improve across sessions — capture project facts, decisions, patterns, and mistakes, and distill behavioral observations that change how Claude approaches future work.

Claude has no cross-session memory by default. This skill creates it.

## Scope

### In scope
- Per-project working memory at `.claude/memory/` (gitignored).
- Read phase at session start; write phase at session end and on mid-session triggers.
- A dedicated `meta.md` layer for self-observations (the self-improvement payload).
- Lazy hygiene: compaction only when a file crosses a size threshold.
- Cross-session pattern recognition by reading `mistakes.md` at read phase and promoting clusters to `meta.md` rules.

### Out of scope
- User-scoped memory (role, cross-project preferences) — stays in the existing `~/.claude/projects/<slug>/memory/` auto-memory system.
- Team-visible artifacts — `.claude/journal/` and `.claude/lessons/` are dropped in favor of `.claude/memory/`. Team-relevant context moves to commit messages and PR descriptions.
- Backup / sync — deferred. Memory is local, gitignored, and unversioned for now.
- Scheduled jobs, cron, or out-of-band agents — the loop is wired entirely to read/write trigger points.

## Boundary with other stores

| Store | Audience | Committed? | Purpose |
|---|---|---|---|
| `~/.claude/projects/<slug>/memory/` (auto-memory) | future-me across all projects | no | user profile, cross-project preferences, feedback |
| `<repo>/.claude/memory/` (this skill) | future-me in this project | no (gitignored) | project facts, decisions, patterns, mistakes, meta |

Adopting this skill drops `.claude/journal/` and `.claude/lessons/` from ax-next. The CLAUDE.md sections covering them are removed in the same change.

## Files

All under `.claude/memory/`. All entries date-stamped `YYYY-MM-DD`. All files follow a "no padding" rule — no entry written unless it earns its place.

### `context.md` — project facts
Confirmed facts about the project. Domain rules, API behaviors, env quirks, data shapes, naming conventions. Not opinions.

**Write test:** would a fresh-context Claude waste time re-discovering this?

### `decisions.md` — architectural / design / process decisions
Table of `Date | Decision | Rationale | Alternatives Considered`. Permanent record — never delete. Strikethrough if reversed.

**Write test:** would someone 3 months from now ask "why did we do it this way?"

### `patterns.md` — what works, what doesn't
Two sections: `## Patterns (do these)` and `## Anti-Patterns (don't do these)`. Each entry is specific and conditional: *"When X, do Y because Z."*

**Write test:** is this reusable across future tasks on this project?

### `mistakes.md` — errors and corrections
One entry per mistake: what went wrong, why, how it was fixed. Goal: next session's Claude reads and doesn't repeat.

**Lifecycle:** when a mistake has been successfully avoided in **two subsequent sessions**, it graduates to a `## Resolved` section. Never deleted — resolved mistakes are evidence of learning.

### `meta.md` — self-observations (the self-improvement layer)
Observations about Claude's own approach on *this* project. Not project facts — behavioral patterns.

**Write test:** is this about *how I worked*, not *what the project is*?

Examples:
- "On BigQuery tasks, I write the full query then debug. Better: sketch joins first, confirm schema, then write."
- "I over-explain when the user wants just the patch. Default terse unless asked."

## Triggers

### Read phase — session start
Fires on the first user message in a project where `.claude/memory/` exists. Reads all five files in full. Produces an internal orientation summary (not shown to user unless asked).

**Conditional hot-memory escalation:** if any file has an entry within the last 14 days, or `mistakes.md` has an un-Resolved entry, or `meta.md` has an `active`-tagged entry, surface a one-liner: *"Reading memory — one recent thing to watch: <...>."*

### Write phase — session end / task completion
Fires on any of:
- User says "done", "that's all", "wrap up", etc.
- A significant task lands (tests pass, PR opened, migration runs).
- User says "update memory" / "log that" / "remember this".

Action: for each file, ask *"did this session add anything new?"* Write only if yes.

### Mid-session capture
Fires immediately (do not wait for session end) on:
- User correction ("no, not that — do X").
- Dead end hit and a different approach succeeds.
- Explicit "remember this" / "save that".

### Not a trigger
Every tool call. Every file edit. Routine "step complete" moments. The write test filters these out.

## Self-improvement loop

### Distillation into `meta.md`

**At write phase:** ask one meta-question — *"What did I learn about how I work on this project that I'd want future-me to do differently?"* If the answer names a behavior (not a project fact), write to `meta.md`. Otherwise skip.

**At read phase:** scan `mistakes.md` for clusters. **Three similar entries across different sessions** promotes to a `meta.md` rule phrased as an actionable instruction. When promoted, originating mistakes cross-reference the `meta.md` entry.

Clusters are judgment-based, not keyword-matched.

### Hygiene (lazy, threshold-triggered)

Runs at read phase when a file crosses ~150 lines:

- `context.md`: consolidate redundant facts; remove anything subsumed by `decisions.md` or `patterns.md`.
- `decisions.md`: never prune. Move entries older than 90 days to `## Archived`.
- `patterns.md`: merge near-duplicates; remove patterns superseded by decisions.
- `mistakes.md`: apply Resolved graduation (2 successful avoidances). Never delete.
- `meta.md`: keep the 5–10 most actionable observations. Archive the rest.

### Loop diagram

```
session starts → read phase  → (hot memory?       → surface warning)
                             → (file over 150?    → run hygiene)
                             → (mistake cluster?  → promote to meta.md)
work happens   → mid-session capture on corrections / dead ends / "remember this"
session ends   → write phase → 4 files updated if new info
                             → meta.md updated if behavior-level insight
```

The loop closes because each session's read phase acts on the prior session's write phase. No scheduling required.

## First session on a project

When `.claude/memory/` doesn't exist:

1. Create the directory and all five files with minimal headers.
2. After the first significant task, run the write phase to seed memory.
3. Add `.claude/memory/` to `.gitignore` (or warn user if `.gitignore` is not writable).

## Writing style

- **Terse.** One concrete sentence beats three vague ones.
- **Specific.** "Use `listZones` with query filter, never `getZoneTree`" beats "prefer efficient API patterns".
- **Date-stamped.** `YYYY-MM-DD` on every entry.
- **No duplication.** Check before adding.
- **No padding.** No entry written to feel productive.

## Open questions (deferred)

- **Backup strategy.** Memory is currently unversioned and unbackupped. Later: likely a shared `~/.claude/memory-store/` git repo pushed to a private remote.
- **Multi-developer coexistence.** If two developers on the same repo both use the skill, they each get their own gitignored memory. That's intentional (personal scratchpad), but worth revisiting if team patterns emerge.
- **Integration with ax-next's memory at `~/.claude/projects/.../memory/`.** The two systems are separated by scope (user vs project). No automatic cross-referencing today. May want the read phase to optionally surface user-scoped feedback relevant to the current task, but not shipping that in v1.
