# auto-ship — design

> **REVISED 2026-05-24 — source of truth moved off `TODO.md` onto the GitHub "TO DO"
> board.** `TODO.md` is deleted; the org `project-ax` Projects v2 board (#1) is now the
> single source of truth. Dependencies live in a per-card **"Depends on"** field
> (Task IDs), readiness is derived from it, the lane set is **Backlog · To Do ·
> In Progress · In Review · Done · Parked**, and the orchestrator runs **continuously**
> — a token-free bash poller watches the To Do lane once a minute and re-invokes it on
> change. The board sections below describe the original best-effort *mirror*; the
> shipped skill (`.claude/skills/auto-ship/`) is the current spec. The control-loop /
> merge-queue / failure-breaker shape is unchanged; only the state store and the
> watch-trigger are new. Sections that say "`TODO.md` strike-through / mermaid DAG"
> now mean "board lane move / `Depends on` field".

**Date:** 2026-05-24
**Status:** approved design, pre-implementation — see the revision banner above
**Related:** `.claude/skills/yolo-ship/SKILL.md` (modified by this work), the "TO DO" project board (the work this skill drains)

## Problem

`TODO.md` now carries a parallelization DAG (mermaid edge-map + inline `[TASK-ID]`
lines + ⚠ cluster-walk lane + 🚫 trigger-gated set). We want to drain that DAG
**autonomously and in parallel**: an orchestrator that finds every task with no
unmet dependency, ships each via `yolo-ship`, merges the green PRs, recomputes
the now-unblocked tasks, and loops until the DAG is empty — without the
orchestrator's own context ballooning, and without spinning forever on failures.

This requires two deliverables:

1. **`auto-ship`** — a new user-invocable orchestrator skill.
2. **`yolo-ship` edits** — an auto-merge phase for standalone runs, plus an
   *orchestrated mode* that defers the merge to auto-ship and stops touching
   `TODO.md`.

## Decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| Q1 | Which task classes to auto-dispatch | **Code tasks + cluster walks.** Only the 🚫 trigger-gated set is skipped. |
| Q2 | Where merge + conflict-resolution lives | **Orchestrator owns the merge queue** (serialized). |
| Q3 | TODO.md write contention | **Orchestrator is the sole writer.** Agents return follow-ups in their handoff. |
| Q4 | Skill name | **`auto-ship`.** |

**Reconciliation of Q2 with the top-line "modify yolo-ship to auto-merge" ask:**
yolo-ship gains a self-merge phase that is its standalone default; under
auto-ship it is suppressed (auto-ship passes an orchestrated flag) so the
orchestrator can serialize all merges. The merge *mechanism* is documented once;
the *queue / ordering / serialization / TODO.md reconciliation* is owned by the
orchestrator.

---

## 1. Orchestrator topology

**Chosen: main-session orchestrator with all durable state externalized to disk.**

The `/auto-ship` session **is** the orchestrator. It dispatches background
`yolo-ship` agents, merges completed PRs through a serialized queue, updates
`TODO.md`, recomputes the ready set, and repeats. Its in-memory footprint is
only the edge-map plus one line per in-flight task. Everything that matters
lives on disk:

- **Done** = the task line is struck through (`~~`) in `TODO.md`.
- **In-flight** = an open PR whose title is prefixed `[TASK-ID]`.
- **Parked/quarantined** = a `🛑 [TASK-ID]` line in `TODO.md` + a journal row.
- **Attempt history** = the event journal `.claude/auto-ship-log.md` (gitignored).
- **Glanceable progress** = the dashboard `.claude/auto-ship-status.md` — a
  derived mirror, not a source of truth (see §13).

Because state is fully reconstructable from `TODO.md` + `gh pr list` +
`.claude/auto-ship-log.md`, **the run is resumable**: kill the session, re-invoke
`/auto-ship`, and it rebuilds and continues. This is also the escape hatch for
very long runs — when context grows, end and re-enter.

Rejected alternatives: (B) a dedicated background orchestrator agent — frees the
user's session but nests agents 3 deep, hides progress, and its own context
still grows; (C) a `/loop`-tick orchestrator — cleanest context but needs
fragile "what's already running?" detection. We take A and bake in C's
disk-as-truth discipline.

---

## 2. State model & readiness

Source of truth: the mermaid edge-map fenced in `TODO.md` plus the inline
`[TASK-ID]` checkbox lines.

A task is **ready** iff **all** of:

- it is **not done** (line not struck through),
- it is **not in-flight** (no open `[TASK-ID]`-prefixed PR),
- it is **not parked** (no `🛑` marker, attempt count below cap — see §11),
- **every** incoming edge — **solid `-->` and dashed `-.->`** — points to a
  done task. Dashed edges mean "coordinate / don't run concurrently," so for
  dispatch purposes they gate exactly like solid edges.
- it is **not in the 🚫 trigger-gated set**.

First wave therefore = `{ARCH-1, ARCH-4, ARCH-5, ARCH-8, CLI-3}`.

Two **lanes** with different execution mechanics:

- **Code lane** — tasks that produce a mergeable PR. Dispatched in parallel
  (one background `yolo-ship` agent each).
- **Cluster-walk lane** — the ⚠ manual-acceptance walks. They share one
  `kind-ax-next-dev` cluster, so they run **serialized, one at a time**, via the
  `k8s-acceptance-loop` skill. Readiness still spans lanes: e.g. `CLI-2` (walk)
  has a dashed edge from `CLI-3` (code), so it waits until `CLI-3` merges.

---

## 3. Control loop

```
print plan (waves + lanes + skip-list)
  → recompute ready set from TODO.md + gh pr list + log
    → any ready?
        no  → terminate: report done / parked / in-flight / trigger-gated
        yes → dispatch wave:
                • code-lane ready tasks → 1 background yolo-ship agent each
                • cluster-lane ready tasks → serialized walk agents (1 at a time)
            → await completion notifications
            → serialized merge queue (§5) for each completed code PR
            → fold follow-ups + strike-throughs into TODO.md (sole writer)
            → loop back to recompute
```

The orchestrator **always prints the computed plan before wave 1** (and on every
recompute) so a watching human can interrupt. `--dry-run` stops right after the
first plan print.

---

## 4. Dispatch contract (what each agent is told)

Each code-lane agent is dispatched (background) with a prompt that pins:

- Run `/yolo-ship` on **exactly one** task ID.
- Branch `auto-ship/<TASK-ID>-<slug>`; PR title prefixed `[<TASK-ID>]`; base `main`.
- **Orchestrated mode:** stop at a **green + verified-mergeable** PR. Do **NOT**
  merge. Do **NOT** edit `TODO.md`.
- Return a **structured handoff, ≤150 words**:
  - `task`, `pr` (#), `headSha`, `mergeable` (y/n), `ci` (green/red/pending)
  - `outcome` ∈ {`pr-green`, `failed`}
  - on `failed`: a normalized **failure signature** (§11)
  - `followups`: bullet lines the orchestrator will fold into `TODO.md`

Cluster-walk agents are dispatched the same way but run `k8s-acceptance-loop`
instead of `/yolo-ship`, rebuild the agent image first for image-baked walks,
and return `outcome` ∈ {`walk-pass`, `walk-fail`} with a failure signature on
fail.

---

## 5. Merge queue (orchestrator-owned, serialized)

One PR at a time:

1. `git fetch origin`.
2. If the PR is not mergeable (main moved): check out the branch, rebase onto
   `main`, resolve conflicts, push, wait for CI to re-green.
3. `gh pr merge --squash <n>`.
4. Fast-forward local `main` (`git checkout main && git pull --ff-only`).
5. Strike the task line in `TODO.md`, append the closing PR ref, and fold in the
   agent's reported follow-ups (orchestrator is the sole `TODO.md` writer, Q3).
6. Record `merged` in `.claude/auto-ship-log.md`.

Serialization makes conflicts rare and resolvable; only one writer ever touches
`main` or `TODO.md`.

---

## 6. Cluster-walk lane

Walks are verification, not PRs, and contend for one cluster:

- **Pre-flight:** confirm `kind-ax-next-dev` is up. If not, park the whole lane
  with a note and continue draining the code lane.
- **Serialized:** one walk agent at a time. Image-baked walks (`CLI-2`,
  `SYNC-1`, `FAULTA-1`) rebuild the agent image first (per
  `docker-build-cache-runner-fixes`).
- **Pass** → strike the task through.
- **Fail** → the walk found a real bug → file a follow-up code task in `TODO.md`
  (with `parent` + failure signature, §11) and report. v1 lets the normal loop
  pick that follow-up up on the next recompute (auto-fix), governed by the §11
  loop-prevention guards. A future toggle can make walk-fixes human-only.

---

## 7. Context discipline ("never gets too big")

Hard rules baked into the skill:

- The orchestrator **never** reads task source files, diffs, or agent
  transcripts into its own context.
- It holds only: the edge-map and **≤1 line per in-flight task**.
- After every merge it **re-derives** state from disk + `gh` rather than
  accumulating across waves.
- It enforces the **≤150-word** structured handoff from every agent.
- Because all state is on disk, the run is **resumable** — the explicit
  long-run escape hatch is "end the session and re-invoke `/auto-ship`."

---

## 8. yolo-ship modifications

1. **New Phase 7 — auto-merge when green** (standalone default): runs the §5
   merge routine on its own PR. Satisfies the literal "auto-merge" ask.
2. **Orchestrated flag** (set by auto-ship's dispatch prompt): skip Phase 7;
   emit the §4 handoff instead.
3. **Autonomy-contract item 3 changes under orchestration:** do not write
   `TODO.md`; return deferred follow-ups in the handoff so the orchestrator (the
   sole writer) folds them in.

These are additive: a human running `/yolo-ship` directly gets auto-merge; a
auto-ship-dispatched agent gets the deferred-handoff behavior.

---

## 9. Testing & safety

- `auto-ship --dry-run` prints the full wave/lane plan + skip-list and stops (no
  dispatch). The plan is always printed before wave 1 regardless.
- Validate the skill end-to-end against a **throwaway 2-node DAG** (one with a
  dependency on the other) before pointing it at the real `TODO.md` — this also
  proves the 3-deep agent nesting (auto-ship → yolo-ship → its subagents) works.
- Validate the §11 breaker with a deliberately-failing throwaway task (assert it
  parks after the cap, no infinite loop).

---

## 10. Known risks

- **Blast radius:** auto-merging multiple PRs to `main`. Mitigated by the
  serialized queue, mandatory green CI, the dry-run, the plan-print-before-wave,
  and resumable-from-disk state.
- **Nested agents 3 deep** — supported by the harness; verified on the 2-node
  test before any real run.
- **Cluster-walk autonomy** — Playwright/kubectl walks are the least
  deterministic; the lane is serialized and pre-flight-gated, and walk failures
  are governed by §11 like any other failure.

---

## 11. Failure handling & loop prevention

The dangerous case: a walk (or any task) fails → a follow-up "fix" is added to
`TODO.md` → the normal loop dispatches and merges it → the original task
re-runs → it fails the **same way** → another follow-up is added → forever. Five
layered guards prevent this. All state is on disk in the append-only event
journal `.claude/auto-ship-log.md` (each failure event carries
`attempt | outcome | signature | parent | depth | ts`, so attempt counts are a
grep), and the guards survive a resume.

**1. Failure signature + same-signature breaker (the core fix).**
Every failing agent/walk returns a **normalized failure signature** in its
handoff — line numbers, timestamps, and SHAs stripped; e.g.
`walk:CLI-1:clone-exit-128:auth-403` or
`ci:vitest:credential-proxy-resync:timeout`. A follow-up records its `parent`
and the parent's signature `S`. When the parent re-runs after the fix merges:

- **Same signature `S` again** → the fix provably did not move the needle →
  **quarantine the parent** (`🛑`, logged) and **do not spawn another
  follow-up**. The loop terminates on the first repeat.
- **Different signature `S2`** → genuine progress (one bug fixed, a new one
  surfaced) → a follow-up may spawn, bounded by the caps below.

**2. Per-task attempt cap (default 2).** Independent of signatures. After 2
failed attempts a task is quarantined with its reason + last signature, and is
never auto-dispatched again. Also short-circuits: two identical signatures →
quarantine immediately (the failure is deterministic).

**3. Follow-up provenance + chain-depth cap (default 2).** Each auto-spawned
task carries `parent` and `depth`. At the depth cap it is parked for a human
instead of spawning further, bounding any "different-failure" chain.

**4. Global circuit breaker (per run).** Cap total auto-spawned tasks
(default ~10) and total dispatches (default ~3× the initial actionable count).
Exceeding either halts the auto-loop and hands back with a full report. Catch-all
for unforeseen regeneration patterns.

**5. No-progress stall detector.** If a full wave completes with the done-count
unchanged **and** the ready-set identical to the prior iteration, halt and
report. Prevents silent spinning.

**Quarantine is visible, never silent:** a parked task gets a
`🛑 [TASK-ID] (parked after N attempts — <signature>)` line in `TODO.md` and a
log row, and is excluded from the ready set. **Termination condition:** no ready
tasks **and** no in-flight tasks — remaining work is trigger-gated or
quarantined, both enumerated in the final report.

---

## 12. Progress tracking & observability

Two files, distinct roles, both gitignored, both `cat`/`tail`/`watch`-able from
any terminal independent of the Claude session.

**`.claude/auto-ship-status.md` — the dashboard.** Overwritten on every state
change. A single snapshot: a header line with counts + a progress bar + the
budget meters (§11), then sections for in-flight (with PR# + CI state), ready,
blocked (with the blocking edge), parked (`🛑` + signature), and done (with
closing PR#). It is a **derived mirror**, never a source of truth — on resume
the orchestrator rebuilds it from `TODO.md` + `gh pr list` + the journal, so it
can never be stale-but-wrong. Watch with `watch -n5 cat
.claude/auto-ship-status.md`.

**`.claude/auto-ship-log.md` — the event journal.** Append-only timeline of every
state transition (`run start`, `wave N dispatch`, `pr-green`, `merged`,
`walk-pass`, `failed … → PARKED`, etc.). Human-readable and `tail -f`-able for a
live feed; also the on-disk substrate for §11 (failure events carry
`attempt/outcome/signature/parent/depth`, so attempt counts are a grep).

`TODO.md` (struck-through / `🛑`) and `gh pr list` remain the source of truth for
done / parked / in-flight; the two files above exist purely to make progress
easy to watch and the run cheap to resume.

### 12.1 Optional GitHub Project board mirror (best-effort)

In addition to the file dashboard, the orchestrator mirrors progress to a GitHub
**Projects v2** kanban board so progress is visible in the GitHub UI. This is a
**second, best-effort mirror** — never load-bearing. The file dashboard +
`TODO.md` + `gh pr list` remain the source of truth; the board can lag or be off
entirely and the run is unaffected.

- **Board:** auto-create-or-reuse a project titled **"TO DO"** owned by the repo
  owner (`gh project list/create`), then **link it to the repo** (`gh project
  link`) so it surfaces under the repo's Projects tab. (v2 boards are owned by the
  org/user, never the repo — linking is the only way to put one "in" a repo.)
- **Cards:** one **draft issue** per non-done `[TASK-ID]`, titled
  `[TASK-ID] <task title>`, self-populated from `TODO.md` (find-or-create by
  title prefix, so re-runs don't duplicate). On PR open, the card's body gets the
  PR link appended.
- **Columns:** the orchestrator reads the board's **Status** single-select
  options (`gh project field-list --format json`) and maps auto-ship state →
  column. On a fresh board the orchestrator **auto-defines** the 7-column scheme via
  `updateProjectV2Field` (verified working; documented in
  `references/github-project.md`): `Trigger-gated · Blocked · Ready · In Progress
  · In Review · Done · Parked`. On a pre-existing board it does NOT clobber columns; if those options
  are absent it **falls back** to the default `Todo / In Progress / Done` (Ready/Blocked/Trigger-gated/Parked →
  Todo; In Progress/In Review → In Progress; Done → Done) so cards still move.
- **Moves:** card status is set via `gh project item-edit
  --single-select-option-id …` on the same transitions that touch the file
  dashboard (dispatch → In Progress, PR open → In Review, merge → Done, quarantine
  → Parked, deps clear → Ready).
- **Degradation:** if `gh` lacks the `project` scope, or any board call fails,
  emit a one-time warning (`board mirror OFF — file dashboard only; enable with
  gh auth refresh -s project`) and continue. Board updates are **skipped in
  `--dry-run`** (no external mutation in a dry run).
- **Mechanics** (GA `gh project` subcommands + a documented optional GraphQL
  column-setup snippet) live in `references/github-project.md`.

## 13. Out of scope (v1)

- Auto-dispatching cluster-walk fixes can be disabled via a future
  human-only toggle; v1 lets the §11 guards govern it.
- Per-package registry tightening, Go toolchain, and the other 🚫 trigger-gated
  TODO items are never touched by auto-ship.
- Cross-repo / multi-DAG orchestration. One `TODO.md`, one repo.
