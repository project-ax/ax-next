---
name: claude-memory
description: Use at session start to read project memory in `.claude/memory/`, during the session to capture corrections / dead ends / "remember this" / "log that", and at session end ("done", "wrap up", PR opened, tests pass) to update it. Five kinds — context, decisions, patterns, mistakes, meta — each a frozen root archive plus a per-task shard directory, keeping project facts, decisions, reusable patterns, mistakes to avoid, and self-observations about how I work on this project. Also handles first-session bootstrap (creating the directory, seeding files, committing them).
---

# claude-memory

Per-project working memory that survives across sessions. **This file is the source of truth.** The original design, `docs/plans/2026-04-23-claude-memory-skill-design.md`, is useful background on *why* each piece exists, but it has diverged — it still describes memory as gitignored and unversioned, and predates per-task shards entirely. It carries a banner saying so. Where the two disagree, this file wins.

**What this is for:** capturing project facts, decisions, patterns, mistakes, and — critically — *behavioral observations about how I work on this project* (the `meta` kind). Each session's read phase acts on the prior session's write phase; no scheduler needed.

**What this is NOT for:** user-scoped preferences (those live in the auto-memory system at `~/.claude/projects/<slug>/memory/`), team-visible artifacts (those go in commit messages and PR descriptions), or one-shot scratchpad notes.

---

## The five kinds — one archive plus a shard directory each

All under `.claude/memory/`. All entries date-stamped `YYYY-MM-DD`. Everything here obeys the **no-padding rule**: write only entries that earn their place.

Each of the five kinds has two halves:

- **The archive** — `.claude/memory/<kind>.md`. Frozen history. Read it; never append to it. `scripts/memory-append-check.sh` fails any PR that touches one.
- **The shards** — `.claude/memory/<kind>/<YYYY-MM-DD>-<TASK-ID>.md`. One small file per task per kind. Every new row goes here, so two branches never write the same bytes and there is nothing to merge.

Ask for the path instead of assembling it by hand:

```bash
path=$(scripts/memory-write-target.sh --shard decisions TASK-415)
mkdir -p "$(dirname "$path")"   # --shard only prints the path; it creates nothing
```

An invalid kind or TASK-ID exits 1. A shard keeps its kind's shape — a `decisions` shard holds `| Date | Decision | Rationale | Alternatives |` rows, a `patterns` shard the `## Patterns` / `## Anti-Patterns` headings — so archive and shards concatenate into one coherent read.

| Kind | What goes in | Write test |
|---|---|---|
| `context` | Confirmed project facts — domain rules, API behaviors, env quirks, data shapes, naming conventions. Not opinions. | Would a fresh-context Claude waste time re-discovering this? |
| `decisions` | Architectural / design / process decisions. Table: `Date \| Decision \| Rationale \| Alternatives`. Never deleted — strikethrough if reversed. | Would someone 3 months from now ask "why did we do it this way?" |
| `patterns` | Two sections — `## Patterns (do these)` and `## Anti-Patterns (don't do these)`. Each entry: *"When X, do Y because Z."* | Is this reusable across future tasks on this project? |
| `mistakes` | One entry per mistake: what went wrong, why, how it was fixed. Graduates to `## Resolved` after **two subsequent sessions** avoid it — a graduation rewrites an existing line, so it belongs in a hygiene pass (below), not a feature branch. Never deleted. | Would next session's Claude repeat this if I don't write it down? |
| `meta` | Self-observations — behavioral patterns, not project facts. How I work on this project that I'd want future-me to do differently. | Is this about *how I worked*, not *what the project is*? |

### `meta` examples (the self-improvement layer)

- `2026-04-23` — On BigQuery tasks, I write the full query then debug. Better: sketch joins first, confirm schema, then write.
- `2026-04-23` — I over-explain when the user wants just the patch. Default terse unless asked.

The pattern: name a behavior, name the better alternative. Tag `active` if it's load-bearing for the next session.

---

## Triggers — when to read, when to write

### Read phase — fires on the first user message in a session

If `.claude/memory/` exists: read **all five archives in full, plus the `<kind>/*.md` shards alongside each one**. The shards are where every row written since the shard cutover lives — an archive-only read sees a project that appears to have stopped learning. Build an internal orientation summary (don't show the user unless asked).

Then check three conditions and act:

1. **Hot memory?** Any archive or shard has an entry within the last 14 days, OR `mistakes` has an un-Resolved entry, OR `meta` has an `active`-tagged entry.
   → Surface one line: *"Reading memory — one recent thing to watch: \<...\>."*

2. **Archive over ~150 lines?** → Note that hygiene is due (see below). Shards are small by construction, so this threshold only ever fires on an archive — and acting on it is a deliberate, separately-committed pass, not something to fold into the task at hand.

3. **Mistake cluster?** Three similar entries across `mistakes` (archive and shards) from different sessions.
   → Promote to a `meta` shard rule phrased as an actionable instruction, and cite the originating mistakes from it. (Cross-referencing *back* into each original would edit existing lines — save that for a hygiene pass.) Clusters are judgment-based, not keyword-matched.

If `.claude/memory/` does not exist: do **not** create it yet. Wait for the first significant task. See "First session" below.

### Mid-session capture — fires immediately, don't wait for session end

- User correction: *"no, not that — do X."*
- Dead end hit and a different approach succeeds.
- Explicit *"remember this"* / *"save that"* / *"log that."*
- User teaches a non-obvious fact about the project.

Write the relevant shard right away. Don't batch.

### Write phase — fires on session end or task completion

Triggers: *"done"*, *"that's all"*, *"wrap up"*, tests pass on a significant change, PR opened, migration runs clean. Or explicit *"update memory."*

For each kind, ask: **did this session add anything new?** Write only if yes, and write it to that kind's shard for this task. No padding entries.

Then ask one meta-question: **What did I learn about how I work on this project that I'd want future-me to do differently?** If the answer names a *behavior* (not a project fact), write a `meta` shard. Otherwise skip.

### NOT triggers

Every tool call. Every file edit. Routine "step complete" moments. A single task finishing that didn't teach anything. The write test filters these out.

---

## First session on a project

When `.claude/memory/` does not exist:

1. After the first **significant** task lands (not on session start — wait for signal), create the directory and seed all five archives with minimal headers:

   ```
   .claude/memory/
   ├── context.md       # archive — headers only, start empty
   ├── decisions.md     # archive — table header: | Date | Decision | Rationale | Alternatives |
   ├── patterns.md      # archive — "## Patterns" and "## Anti-Patterns" headers
   ├── mistakes.md      # archive — empty
   ├── meta.md          # archive — empty
   └── <kind>/          # shards — context/, decisions/, patterns/, mistakes/, meta/
   ```

   Don't hand-create the shard directories: git doesn't track empty ones anyway, and each appears the first time `scripts/memory-write-target.sh --shard <kind> <TASK-ID>` names a file in it (that mode prints a path and creates nothing, so `mkdir -p "$(dirname "$path")"` is on you).

   **On a greenfield project this seed commit trips R2**, because creating the five archives *is* touching them — measured, exit 1 with two violations. That is the guard being right rather than the bootstrap being wrong: the archives predate it everywhere else. Put a `Memory-Rewrite: seeding .claude/memory/` trailer on the seed commit, or land the guard in a later PR than the seed.

2. Run the write phase against what was just done, writing the current task's output as shards.

3. Commit the new `.claude/memory/` files alongside the task that created them. `.claude/memory/` is **tracked in the repo** — do not add it to `.gitignore`. If a stale `.gitignore` entry ignores it, remove that entry so memory updates can be committed.

ax-next tracks `.claude/memory/` in git, so commit memory changes with the work that produced them — including any update you make this session.

---

## Parallel agents: shard your writes, in your own worktree/branch copy

auto-ship runs several `yolo-ship` agents at once. While every branch appended to the same five root files, those files were the serialization point: **eight append-collisions in one day's runs**, and two branches hit a *second* collision while merely waiting in the merge queue. No production file ever conflicted — the shape was always "both sides appended at EOF". Each one cost a rebase, a force-push and a fresh ~10-minute CI run.

Per-task shards remove the collision instead of resolving it. Two branches never write the same bytes, so there is no merge, no conflict, and nothing for `git rerere` to record or replay against a different `main`.

On top of that, the older rule still holds: **write + commit memory only in your own worktree/branch copy, never the shared main checkout** (`/home/vpulim/dev/ai/ax-next`), where a concurrent write once silently dropped another agent's rows (the TASK-7 bug, first seen on the ARCH-3 run). Because memory is committed and tracked, `git worktree add` carries the files into your worktree and your rows land on PR merge through auto-ship's serialized queue. A solo human editing memory on `main` with no agents in flight is fine — the hazard is specifically the *shared checkout under parallelism*.

If you're not sure which tree you're in, run `scripts/memory-write-target.sh`: it prints the correct `.claude/memory` dir for your current working tree (your own copy, primary or linked) and warns — with `--check` it exits nonzero — when you're standing in the shared main checkout while linked worktrees exist.

`scripts/memory-append-check.sh [<base-ref>]` (default `origin/main`) is the guard, and CI runs it on every PR. Over `merge-base(<base>, HEAD)..HEAD` it fails if **(R1)** any line under `.claude/memory/` was deleted, or **(R2)** a root archive was touched at all. Exit 0 clean, 1 violation, 2 usage or unresolvable base — an unresolvable base fails closed. A `Memory-Rewrite: <reason>` trailer on a commit in the range waives both, for a deliberate hygiene pass.

R1 is deliberately stronger than "my rows survived": a branch's conflict resolution once passed its own row-presence check while a whole-file blank-line normalization had silently collapsed four pre-existing double-blank runs elsewhere in `decisions.md`. Nothing of that branch's was lost, so its check reported success — and the unrelated churn manufactured the next agent's conflict.

### Why not `merge=union`

It was the obvious cheap fix, and measurement refuted it. Union is line-wise: git matches whatever two appended blocks share at their edges as ordinary context and emits it once. Against the real `decisions.md` (3189 lines the day it was measured), four different append shapes **all lost lines** — 1 to 2 each, in one case eating the closing line of a multi-line row so it ended mid-sentence with the next `##` heading welded on. And every single case reported a `git diff --numstat` deletions column of **0**, so the sharpest available "no row was dropped" check cannot see the loss. Union blinds the check that catches the real risk.

One related trap, for the archive-under-waiver case only: `rerere.enabled=false` is not proof the rerere hazard is absent. An `rr-cache` directory in a shared `.git` is enough for a replay, so `git rebase --no-rerere-autoupdate` is not redundant.

---

## Hygiene — lazy, threshold-triggered, and always its own change

Shards are small by construction — one day, one task, one kind — so the ~150-line threshold now only ever fires on an **archive**, and folding shards back into one is the main reason to run a pass at all.

Every hygiene move rewrites or removes existing lines, which is exactly what the guard blocks (R1: no deletions; R2: don't touch an archive). That friction is the point. **A hygiene pass is its own branch and its own commit, carrying a `Memory-Rewrite: <reason>` trailer** — never folded into a feature branch while other agents are shipping shards.

**If you are an agent shipping a card, you do not add that trailer.** Tripping the guard means you wrote to the wrong place; the fix is a shard, not a waiver. A trailer that makes a red check go green is the easiest thing in this file to reach for and the only thing here that quietly undoes it — which is why the guard's own failure message deliberately does not print a copy-pasteable one. Hygiene is a human call on a branch of its own.

| Kind | Hygiene rule |
|---|---|
| `context` | Consolidate redundant facts. Remove anything subsumed by `decisions` or `patterns`. |
| `decisions` | **Never prune.** Move entries older than 90 days to `## Archived`. |
| `patterns` | Merge near-duplicates. Remove patterns superseded by decisions. |
| `mistakes` | Apply Resolved graduation (two successful avoidances across subsequent sessions). **Never delete.** |
| `meta` | Keep the 5–10 most actionable observations. Archive the rest to `## Archived`. |

If a hygiene pass would materially change a file (not just whitespace), note it in the session's write phase so the user sees what moved. And don't tidy what you weren't asked to: an unrelated blank-line normalization in `decisions.md` once collapsed four pre-existing double-blank runs, which is the churn R1 exists to catch.

---

## Writing style

- **Terse.** One concrete sentence beats three vague ones.
- **Specific.** *"Use `listZones` with query filter, never `getZoneTree`"* beats *"prefer efficient API patterns."*
- **Date-stamped.** `YYYY-MM-DD` on every entry.
- **No duplication.** Scan the kind's archive *and* its existing shards before adding.
- **No padding.** An entry that doesn't earn its place is noise.
- **Cite the file, not the line — unless the line IS the point.** `packages/core/src/workspace-policy.ts` stays true across every edit above it; `workspace-policy.ts:162` is wrong the next time someone adds an import. Line numbers rot silently and they rot *precisely* — a wrong `file:line` reads as more authoritative than no line at all, which is why two PRs in one session shipped precise-looking-but-wrong refs while *fixing* false claims. Keep the line only when you are pinning that exact line (a specific regex, a magic default), and then quote what is on it so the reader can tell it moved.
- **Name a path only if it exists.** `scripts/__tests__/memory-cited-paths-exist.test.js` fails if any repo path cited in these files is no longer tracked by git — it is what caught two rows still pointing at `@ax/agent-claude-sdk-runner` months after #395 moved them to `@ax/agent-runner-core`. If a sentence needs to name something that deliberately does *not* exist (a rejected alternative, a doc that never landed), write it so it does not read as a live file reference. Do not add an allowlist to that guard; an exceptions list is just the next thing to rot.

When in doubt, the write test on each file is the arbiter: if the answer is no, don't write.

---

## Boundary with other stores

| Store | Audience | Committed? | What goes there |
|---|---|---|---|
| `~/.claude/projects/<slug>/memory/` (auto-memory) | future-me across all projects | no | user profile, cross-project preferences, feedback |
| `<repo>/.claude/memory/` (this skill) | future-me in this project | yes (committed) | project facts, decisions, patterns, mistakes, meta |
| Commit messages / PR descriptions | the team | yes | anything team-visible |

If something would help the team, it goes in the commit or PR — not here. If it only helps future-me on this project, it goes here. If it's about *me* across projects, it goes in auto-memory.

---

## The loop (why this works without a scheduler)

```
session starts → read phase  → archives + <kind>/ shards
                             → (hot memory?       → surface warning)
                             → (archive over 150? → hygiene is due, on its own branch)
                             → (mistake cluster?  → promote to a meta shard)
work happens   → mid-session capture on corrections / dead ends / "remember this"
session ends   → write phase → a shard per kind that learned something
                             → meta shard if behavior-level insight
```

Each session's read phase acts on the prior session's write phase. That's the whole loop. No cron, no agents, no out-of-band jobs.
