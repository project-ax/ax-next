# dag-ship — design

**Date:** 2026-05-24
**Status:** approved design, pre-implementation
**Related:** `.claude/skills/yolo-ship/SKILL.md` (modified by this work), `TODO.md` (the DAG this skill drains)

## Problem

`TODO.md` now carries a parallelization DAG (mermaid edge-map + inline `[TASK-ID]`
lines + ⚠ cluster-walk lane + 🚫 trigger-gated set). We want to drain that DAG
**autonomously and in parallel**: an orchestrator that finds every task with no
unmet dependency, ships each via `yolo-ship`, merges the green PRs, recomputes
the now-unblocked tasks, and loops until the DAG is empty — without the
orchestrator's own context ballooning, and without spinning forever on failures.

This requires two deliverables:

1. **`dag-ship`** — a new user-invocable orchestrator skill.
2. **`yolo-ship` edits** — an auto-merge phase for standalone runs, plus an
   *orchestrated mode* that defers the merge to dag-ship and stops touching
   `TODO.md`.

## Decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| Q1 | Which task classes to auto-dispatch | **Code tasks + cluster walks.** Only the 🚫 trigger-gated set is skipped. |
| Q2 | Where merge + conflict-resolution lives | **Orchestrator owns the merge queue** (serialized). |
| Q3 | TODO.md write contention | **Orchestrator is the sole writer.** Agents return follow-ups in their handoff. |
| Q4 | Skill name | **`dag-ship`.** |

**Reconciliation of Q2 with the top-line "modify yolo-ship to auto-merge" ask:**
yolo-ship gains a self-merge phase that is its standalone default; under
dag-ship it is suppressed (dag-ship passes an orchestrated flag) so the
orchestrator can serialize all merges. The merge *mechanism* is documented once;
the *queue / ordering / serialization / TODO.md reconciliation* is owned by the
orchestrator.

---

## 1. Orchestrator topology

**Chosen: main-session orchestrator with all durable state externalized to disk.**

The `/dag-ship` session **is** the orchestrator. It dispatches background
`yolo-ship` agents, merges completed PRs through a serialized queue, updates
`TODO.md`, recomputes the ready set, and repeats. Its in-memory footprint is
only the edge-map plus one line per in-flight task. Everything that matters
lives on disk:

- **Done** = the task line is struck through (`~~`) in `TODO.md`.
- **In-flight** = an open PR whose title is prefixed `[TASK-ID]`.
- **Parked/quarantined** = a `🛑 [TASK-ID]` line in `TODO.md` + a journal row.
- **Attempt history** = the event journal `.claude/dag-ship-log.md` (gitignored).
- **Glanceable progress** = the dashboard `.claude/dag-ship-status.md` — a
  derived mirror, not a source of truth (see §13).

Because state is fully reconstructable from `TODO.md` + `gh pr list` +
`.claude/dag-ship-log.md`, **the run is resumable**: kill the session, re-invoke
`/dag-ship`, and it rebuilds and continues. This is also the escape hatch for
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
- Branch `dag-ship/<TASK-ID>-<slug>`; PR title prefixed `[<TASK-ID>]`; base `main`.
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
6. Record `merged` in `.claude/dag-ship-log.md`.

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
  long-run escape hatch is "end the session and re-invoke `/dag-ship`."

---

## 8. yolo-ship modifications

1. **New Phase 7 — auto-merge when green** (standalone default): runs the §5
   merge routine on its own PR. Satisfies the literal "auto-merge" ask.
2. **Orchestrated flag** (set by dag-ship's dispatch prompt): skip Phase 7;
   emit the §4 handoff instead.
3. **Autonomy-contract item 3 changes under orchestration:** do not write
   `TODO.md`; return deferred follow-ups in the handoff so the orchestrator (the
   sole writer) folds them in.

These are additive: a human running `/yolo-ship` directly gets auto-merge; a
dag-ship-dispatched agent gets the deferred-handoff behavior.

---

## 9. Testing & safety

- `dag-ship --dry-run` prints the full wave/lane plan + skip-list and stops (no
  dispatch). The plan is always printed before wave 1 regardless.
- Validate the skill end-to-end against a **throwaway 2-node DAG** (one with a
  dependency on the other) before pointing it at the real `TODO.md` — this also
  proves the 3-deep agent nesting (dag-ship → yolo-ship → its subagents) works.
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
journal `.claude/dag-ship-log.md` (each failure event carries
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

**`.claude/dag-ship-status.md` — the dashboard.** Overwritten on every state
change. A single snapshot: a header line with counts + a progress bar + the
budget meters (§11), then sections for in-flight (with PR# + CI state), ready,
blocked (with the blocking edge), parked (`🛑` + signature), and done (with
closing PR#). It is a **derived mirror**, never a source of truth — on resume
the orchestrator rebuilds it from `TODO.md` + `gh pr list` + the journal, so it
can never be stale-but-wrong. Watch with `watch -n5 cat
.claude/dag-ship-status.md`.

**`.claude/dag-ship-log.md` — the event journal.** Append-only timeline of every
state transition (`run start`, `wave N dispatch`, `pr-green`, `merged`,
`walk-pass`, `failed … → PARKED`, etc.). Human-readable and `tail -f`-able for a
live feed; also the on-disk substrate for §11 (failure events carry
`attempt/outcome/signature/parent/depth`, so attempt counts are a grep).

`TODO.md` (struck-through / `🛑`) and `gh pr list` remain the source of truth for
done / parked / in-flight; the two files above exist purely to make progress
easy to watch and the run cheap to resume.

## 13. Out of scope (v1)

- Auto-dispatching cluster-walk fixes can be disabled via a future
  human-only toggle; v1 lets the §11 guards govern it.
- Per-package registry tightening, Go toolchain, and the other 🚫 trigger-gated
  TODO items are never touched by dag-ship.
- Cross-repo / multi-DAG orchestration. One `TODO.md`, one repo.
