---
name: claude-memory
description: Use at session start to read project memory in `.claude/memory/`, during the session to capture corrections / dead ends / "remember this" / "log that", and at session end ("done", "wrap up", PR opened, tests pass) to update it. Five files — context.md, decisions.md, patterns.md, mistakes.md, meta.md — keep project facts, decisions, reusable patterns, mistakes to avoid, and self-observations about how I work on this project. Also handles first-session bootstrap (creating the directory, seeding files, gitignoring).
---

# claude-memory

Per-project working memory that survives across sessions. Design spec: `docs/plans/2026-04-23-claude-memory-skill-design.md` — read that if anything here is ambiguous.

**What this is for:** capturing project facts, decisions, patterns, mistakes, and — critically — *behavioral observations about how I work on this project* (`meta.md`). Each session's read phase acts on the prior session's write phase; no scheduler needed.

**What this is NOT for:** user-scoped preferences (those live in the auto-memory system at `~/.claude/projects/<slug>/memory/`), team-visible artifacts (those go in commit messages and PR descriptions), or one-shot scratchpad notes.

---

## The five files

All under `.claude/memory/`. All entries date-stamped `YYYY-MM-DD`. All files obey the **no-padding rule**: write only entries that earn their place.

| File | What goes in | Write test |
|---|---|---|
| `context.md` | Confirmed project facts — domain rules, API behaviors, env quirks, data shapes, naming conventions. Not opinions. | Would a fresh-context Claude waste time re-discovering this? |
| `decisions.md` | Architectural / design / process decisions. Table: `Date \| Decision \| Rationale \| Alternatives`. Never deleted — strikethrough if reversed. | Would someone 3 months from now ask "why did we do it this way?" |
| `patterns.md` | Two sections — `## Patterns (do these)` and `## Anti-Patterns (don't do these)`. Each entry: *"When X, do Y because Z."* | Is this reusable across future tasks on this project? |
| `mistakes.md` | One entry per mistake: what went wrong, why, how it was fixed. Graduates to `## Resolved` after **two subsequent sessions** avoid it. Never deleted. | Would next session's Claude repeat this if I don't write it down? |
| `meta.md` | Self-observations — behavioral patterns, not project facts. How I work on this project that I'd want future-me to do differently. | Is this about *how I worked*, not *what the project is*? |

### `meta.md` examples (the self-improvement layer)

- `2026-04-23` — On BigQuery tasks, I write the full query then debug. Better: sketch joins first, confirm schema, then write.
- `2026-04-23` — I over-explain when the user wants just the patch. Default terse unless asked.

The pattern: name a behavior, name the better alternative. Tag `active` if it's load-bearing for the next session.

---

## Triggers — when to read, when to write

### Read phase — fires on the first user message in a session

If `.claude/memory/` exists: read **all five files in full**. Build an internal orientation summary (don't show the user unless asked).

Then check three conditions and act:

1. **Hot memory?** Any file has an entry within the last 14 days, OR `mistakes.md` has an un-Resolved entry, OR `meta.md` has an `active`-tagged entry.
   → Surface one line: *"Reading memory — one recent thing to watch: \<...\>."*

2. **File over ~150 lines?** → Run hygiene (see below).

3. **Mistake cluster?** Three similar entries in `mistakes.md` across different sessions.
   → Promote to a `meta.md` rule phrased as an actionable instruction. Add cross-reference back in each originating mistake. Clusters are judgment-based, not keyword-matched.

If `.claude/memory/` does not exist: do **not** create it yet. Wait for the first significant task. See "First session" below.

### Mid-session capture — fires immediately, don't wait for session end

- User correction: *"no, not that — do X."*
- Dead end hit and a different approach succeeds.
- Explicit *"remember this"* / *"save that"* / *"log that."*
- User teaches a non-obvious fact about the project.

Write the relevant file right away. Don't batch.

### Write phase — fires on session end or task completion

Triggers: *"done"*, *"that's all"*, *"wrap up"*, tests pass on a significant change, PR opened, migration runs clean. Or explicit *"update memory."*

For each file, ask: **did this session add anything new?** Write only if yes. No padding entries.

Then ask one meta-question: **What did I learn about how I work on this project that I'd want future-me to do differently?** If the answer names a *behavior* (not a project fact), write to `meta.md`. Otherwise skip.

### NOT triggers

Every tool call. Every file edit. Routine "step complete" moments. A single task finishing that didn't teach anything. The write test filters these out.

---

## First session on a project

When `.claude/memory/` does not exist:

1. After the first **significant** task lands (not on session start — wait for signal), create the directory and seed all five files with minimal headers:

   ```
   .claude/memory/
   ├── context.md       # headers only — start empty
   ├── decisions.md     # table header: | Date | Decision | Rationale | Alternatives |
   ├── patterns.md      # "## Patterns" and "## Anti-Patterns" headers
   ├── mistakes.md      # empty — entries added as they occur
   └── meta.md          # empty — entries added on write phase
   ```

2. Run the write phase against what was just done, to seed memory with the current task's output.

3. If `.gitignore` is writable and doesn't already ignore `.claude/memory/`, add it. If `.gitignore` is not writable or doesn't exist, warn the user — do not silently leave memory uncommitted-but-visible.

ax-next's `.gitignore` already covers `.claude/memory/` (added in the same change that shipped this skill), so step 3 is a no-op here.

---

## Hygiene — lazy, threshold-triggered

Runs at read phase only when a file crosses ~150 lines. Not every session.

| File | Hygiene rule |
|---|---|
| `context.md` | Consolidate redundant facts. Remove anything subsumed by `decisions.md` or `patterns.md`. |
| `decisions.md` | **Never prune.** Move entries older than 90 days to `## Archived`. |
| `patterns.md` | Merge near-duplicates. Remove patterns superseded by decisions. |
| `mistakes.md` | Apply Resolved graduation (two successful avoidances across subsequent sessions). **Never delete.** |
| `meta.md` | Keep the 5–10 most actionable observations. Archive the rest to `## Archived`. |

If a hygiene pass would materially change the file (not just whitespace), note it in the session's write phase so the user sees what moved.

---

## Writing style

- **Terse.** One concrete sentence beats three vague ones.
- **Specific.** *"Use `listZones` with query filter, never `getZoneTree`"* beats *"prefer efficient API patterns."*
- **Date-stamped.** `YYYY-MM-DD` on every entry.
- **No duplication.** Scan the target file before adding.
- **No padding.** An entry that doesn't earn its place is noise.

When in doubt, the write test on each file is the arbiter: if the answer is no, don't write.

---

## Boundary with other stores

| Store | Audience | Committed? | What goes there |
|---|---|---|---|
| `~/.claude/projects/<slug>/memory/` (auto-memory) | future-me across all projects | no | user profile, cross-project preferences, feedback |
| `<repo>/.claude/memory/` (this skill) | future-me in this project | no (gitignored) | project facts, decisions, patterns, mistakes, meta |
| Commit messages / PR descriptions | the team | yes | anything team-visible |

If something would help the team, it goes in the commit or PR — not here. If it only helps future-me on this project, it goes here. If it's about *me* across projects, it goes in auto-memory.

---

## The loop (why this works without a scheduler)

```
session starts → read phase  → (hot memory?       → surface warning)
                             → (file over 150?    → run hygiene)
                             → (mistake cluster?  → promote to meta.md)
work happens   → mid-session capture on corrections / dead ends / "remember this"
session ends   → write phase → 4 files updated if new info
                             → meta.md updated if behavior-level insight
```

Each session's read phase acts on the prior session's write phase. That's the whole loop. No cron, no agents, no out-of-band jobs.
