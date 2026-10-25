# TASK-935: The miss count after a late report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task's "check-ins in a row without an update" count is right after every run's finish. That includes an older check-in that finishes (with a late report, or with none) while a newer check-in that has already saved a report is still running. And `missesAfterRun`'s doc states the rule truly, including its one exception where the count reads short.

**Architecture:** This is a change inside one function, `missesAfterRun` in `packages/routines/src/store.ts`. Its counted-miss path already recounts from a newer saved report whose run is still open (`reportStillOpen` + `unansweredAfter`, TASK-930 round 3). This card makes the other two paths that finish a run do the same:
- the run that reported behind a newer miss (the card's late report);
- the run without a report that started before the newer report (the sibling with the same symptom).

Nothing changes in hooks, the schema, migrations, views or the UI.

**Tech Stack:** TypeScript, Kysely on Postgres (testcontainers), vitest.

**Spec:** card TASK-935 (acceptance quoted below), design `docs/plans/2026-10-20-agent-tasks-design.md` (TASK-930 paragraph at :315; this card doesn't change it). Predecessor rows are in `.claude/memory/decisions/2026-10-23-TASK-930.md`, rows 23–27 (file lines 25–29), and in `.claude/memory/patterns/2026-10-23-TASK-930.md` row 1. Decisions for this card: `.claude/memory/decisions/2026-10-25-TASK-935.md`.

**Card acceptance (verbatim):**
- A test reproduces the high count, with a late report from an older check-in while a newer one is still running, and it fails before the fix.
- The count is right right after the late report lands.
- The comment states the exception.
- `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

## Global Constraints

- No new column, migration, hook, view field, dependency, helper or UI. `finishDispatch` (through `missesAfterRun`) stays the only writer that counts. `updateAuthored`, `reconcileOwners`, `completeTask` and `reopenTask` only clear.
- A path that doesn't count a miss never raises the count. Every new trim is capped at the stored count, so a Resume's fresh start holds (TASK-930 decisions row 23).
- The same-instant rule is unchanged. `unansweredAfter` keeps its strict `fired_at > after`. An open report answers a miss that started in its instant. A finished report doesn't answer a same-instant miss that finished after it.
- These still return null before anything below runs: a repeat routine, a task paused for misses (the freeze), and a Done task.
- `unansweredAfter`'s `atMost` is never negative. It becomes `LIMIT`, and `finishDispatch` runs at boot (`interruptAbandonedDispatches`), where a throw stops the host.
- The routines tests start Postgres containers, so `DOCKER_HOST` must be set (CLAUDE.md, "Docker-backed tests").
- Commit this plan and the decisions shard before `pnpm test:scripts`. Its cited-paths guard fails on a memory shard that cites an untracked file.

## Questions answered (planner, self-answered from code and memory)

- **Where does the high count come from?** `store.ts:538-543`. A run that reported behind a newer miss trims with `unansweredAfter(run.acceptedAt)`, so it keeps misses that a newer report has already answered while that report's run is still open. `misses-store.test.ts:452` reproduces it and pins it as a known lag.
- **What is "right"?** Start order (TASK-930). The count is the misses that started after the latest saved report. A saved report answers from the moment it is saved. In a tie, the run that finishes later answers.
- **Is the builder's hypothesis right?** Yes, for the late-report branch. But the sibling branch has the same symptom. A run without a report that started before the newer report returns null (`store.ts:545`), so the stale count stays. `misses-store.test.ts:432` pins four in a row (Needs you) under a newer on-track report that is still open. It also makes the doc's existing "until the next run finishes" (`store.ts:511`) false. This plan closes both (decisions row 3).
- **Which lag remains?** Only the one between finishes. A report is saved before its run finishes, and nothing recounts until the next finish. Recounting inside `recordReport` stays out (TASK-930 row 23).
- **Does the unreadable-report exception get fixed?** No. It gets documented, as the card asks (decisions row 4). It can make the count short by every miss the report was taken to answer, not by one.
- **Boundary review or security-checklist?** Neither. No hook surface changes. The lookups read only host-written times and `IS NULL` checks, never report text.

## Review Focus

1. **A Resume while runs overlap.** An older run that finishes without a report next to a newer open report must not bring back misses from before the Resume. Pinned in Task 1 (new test 3, Resume scenario).
2. **A same-instant miss after a finished newer report.** An older run's finish, with or without a report, must still count that miss. Pinned in Task 1 (new test 2).
3. **A miss that started after the newer open report.** It stays counted, on both paths. Pinned in Task 1 (new test 1).
4. **A hand-edited count below one, at a finish that takes the new no-report branch.** No throw (`LIMIT` would go negative), and the row is left as it is. Pinned in Task 1 (new test 3, hand-edit scenario).
5. **A stored report its finish reads as none** (a hand edit, or a rollback after a later version wrote it). The count reads short. That is documented in Task 2 and deliberately not tested, because only a hand edit or a rollback reaches it.

## Files

- Modify: `packages/routines/src/store.ts`. `missesAfterRun`'s two branches (:536-545) in Task 1. Its doc's second paragraph (:490-516) in Task 2.
- Modify: `packages/routines/src/__tests__/misses-store.test.ts`. Flip :426-432, replace the test at :452-468, and add three tests after it (Task 1).
- Create: `.claude/memory/patterns/2026-10-25-TASK-935.md` (Task 2).

---

### Task 1: Recount from a newer open report in both remaining paths that finish a run [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/store.ts:536-545` (inside `missesAfterRun`)
- Test: `packages/routines/src/__tests__/misses-store.test.ts`

**Interfaces:**
- Consumes: the existing `reportStillOpen(trx, row, at: Date): Promise<boolean>` and `unansweredAfter(trx, row, after: Date, atMost: number): Promise<number>` (store.ts:576, :592), unchanged. Test helpers already in the file: `checkIn`, `finish`, `missed`, `edit`, `setMisses`, `missColumns`, `NO_MISSES`, `onTrack`, `minute`, `pauseLines`, `taskInput`.
- Produces: nothing new. `missesAfterRun`'s signature and `MissesWrite` stay as they are.

- [ ] **Step 1: Write the failing tests.** Edit `misses-store.test.ts` in five places.

(a) In `"an older check-in that finishes after a newer one reported doesn't count: the newer report stands"` (:416), replace its comment at :426 and its assertion at :432. Keep the setup lines between them.

```ts
    // Nor is it the fifth miss once the newer one has reported, finished or not. Still open, that report has
    // answered the four before it too, so the fifth's finish clears them (TASK-935).
    // ...unchanged setup (other, missed, fifth, reporting, finish(fifth))...
    expect(await f.store.findOne(other)).toMatchObject({ enabled: true, noRecentUpdate: null });
    expect(await missColumns(other.routineId)).toEqual(NO_MISSES);
```

(b) Replace the whole `"known lag (a closing fix should turn this red on purpose): …"` test (:452-468) with:

```ts
  it("an older check-in's late report ends the misses that a newer report, its run still open, has answered", async () => {
    const row = await f.store.createAuthored(taskInput('task'));
    const scheduled = await checkIn(row, 'scheduled', { at: minute(1) });
    const checkNow = await checkIn(row, 'check-now', { at: minute(2) });
    await finish(checkNow.dispatchId);
    expect(await f.store.recordReport({
      agentId: 'a', dispatchId: scheduled.dispatchId, conversationId: scheduled.conversationId, actorUserId: 'owner', report: onTrack, now: minute(3),
    })).toBe('recorded');
    // A newer run reports, and is still open when the older one finishes.
    const open = await checkIn(row, 'open', { at: minute(3), report: onTrack });
    await finish(scheduled.dispatchId);
    // In the order they started: a report, a miss, a report. The open one has answered the miss already.
    expect((await f.store.findOne(row))?.noRecentUpdate).toBeNull();
    expect(await missColumns(row.routineId)).toEqual(NO_MISSES);
    await finish(open.dispatchId);
    expect(await missColumns(row.routineId)).toEqual(NO_MISSES);
  });
```

(c) New test 1, right after (b). It catches both missing fixes, and a trim that clears too much on either path:

```ts
  it('a newer report still open answers only the misses that started before it: an older check-in that finishes, with a late report or none, keeps the ones after it', async () => {
    const lines = pauseLines();
    for (const late of [true, false]) {
      const row = await f.store.createAuthored(taskInput(late ? 'late-report' : 'no-report'));
      const older = await checkIn(row, 'older', { at: minute(1) });
      const before = await checkIn(row, 'before', { at: minute(2) });
      const newer = await checkIn(row, 'newer', { at: minute(3) });
      const after = await checkIn(row, 'after', { at: minute(4) });
      await finish(before.dispatchId);
      await finish(after.dispatchId);
      const twice = { inARow: 2, reason: 'no-report', at: after.acceptedAt, autoPausedAt: null };
      expect((await f.store.findOne(row))?.noRecentUpdate, String(late)).toEqual(twice);
      // Both misses have finished. Now the newer run reports (the older one too, when late) and stays open.
      for (const run of late ? [older, newer] : [newer]) {
        expect(await f.store.recordReport({
          agentId: 'a', dispatchId: run.dispatchId, conversationId: run.conversationId, actorUserId: 'owner', report: onTrack, now: minute(5),
        })).toBe('recorded');
      }
      await finish(older.dispatchId);
      // In the order they started: the older check-in, a miss, a report, a miss. One in a row.
      const once = { ...twice, inARow: 1 };
      expect((await f.store.findOne(row))?.noRecentUpdate, String(late)).toEqual(once);
      await finish(newer.dispatchId);
      expect((await f.store.findOne(row))?.noRecentUpdate, String(late)).toEqual(once);
    }
    expect(lines).toEqual([]);
  });
```

(d) New test 2. It guards the `reportStillOpen` gate on both paths:

```ts
  it('a newer report whose run has finished is passed over: a miss that started in its instant and finished after it still counts, whatever an older check-in does', async () => {
    for (const late of [true, false]) {
      const row = await f.store.createAuthored(taskInput(late ? 'late-report' : 'no-report'));
      const older = await checkIn(row, 'older', { at: minute(1) });
      await finish((await checkIn(row, 'reported', { at: minute(2), report: onTrack })).dispatchId);
      // Started in the same instant as that report and finished after it: no report answers it.
      await finish((await checkIn(row, 'beside', { at: minute(2) })).dispatchId);
      const once = { inARow: 1, reason: 'no-report', at: minute(2), autoPausedAt: null };
      expect((await f.store.findOne(row))?.noRecentUpdate, String(late)).toEqual(once);
      if (late) {
        expect(await f.store.recordReport({
          agentId: 'a', dispatchId: older.dispatchId, conversationId: older.conversationId, actorUserId: 'owner', report: onTrack, now: minute(3),
        })).toBe('recorded');
      }
      await finish(older.dispatchId);
      expect((await f.store.findOne(row))?.noRecentUpdate, String(late)).toEqual(once);
    }
  });
```

(e) New test 3. It guards the no-report path's cap and its hand-edit guard:

```ts
  it('an older check-in that finishes without a report beside a newer report still open never raises the count, and leaves a hand-edited one', async () => {
    // A Resume starts the count over: the misses from before it don't come back.
    const row = await f.store.createAuthored(taskInput('resumed'));
    const older = await checkIn(row, 'older', { at: minute(1) });
    const newer = await checkIn(row, 'newer', { at: minute(2) });
    await missed(row, 1, 3);
    const resumed = await edit(await edit(row, 'pause', { enabled: false }), 'resume', { enabled: true });
    expect(await missColumns(row.routineId)).toEqual(NO_MISSES);
    await missed(resumed, 1, 5);
    expect(await f.store.recordReport({
      agentId: 'a', dispatchId: newer.dispatchId, conversationId: newer.conversationId, actorUserId: 'owner', report: onTrack, now: minute(6),
    })).toBe('recorded');
    await finish(older.dispatchId);
    const once = { task_misses_in_a_row: 1, task_miss_reason: 'no-report', task_miss_at: minute(5), task_auto_paused_at: null };
    expect(await missColumns(row.routineId)).toEqual(once);
    await finish(newer.dispatchId);
    expect(await missColumns(row.routineId)).toEqual(once);
    // A count below one is a hand edit: there's nothing to trim, and the finish still succeeds.
    const edited = await f.store.createAuthored(taskInput('hand-edited'));
    const early = await checkIn(edited, 'early', { at: minute(1) });
    await checkIn(edited, 'reporting', { at: minute(2), report: onTrack });
    const below = { task_misses_in_a_row: -3, task_miss_reason: 'no-report', task_miss_at: minute(5), task_auto_paused_at: null };
    await setMisses(edited.routineId, below);
    await finish(early.dispatchId);
    expect(await missColumns(edited.routineId)).toEqual(below);
  });
```

- [ ] **Step 2: Run them to see the right ones fail.**

Run: `pnpm --filter @ax/routines test src/__tests__/misses-store.test.ts`
Expected: exactly three tests fail.
- (a) gets `{ inARow: 4 }`, not `null`.
- (b) gets `{ inARow: 1, … }`, not `null`.
- New test 1 gets `inARow: 2` for both variants. It stops at the first variant (`'true'`).

New tests 2 and 3 already pass (they are guards). Every other test in the file passes.

- [ ] **Step 3: Implement in `missesAfterRun` (`packages/routines/src/store.ts`).** This is the control flow. The comments are the house wording, and the builder may rewrap them.

```ts
  // recordReport's order: a run started after this one has already answered.
  const newerMiss = row.task_miss_at !== null && row.task_miss_at > run.acceptedAt;
  const reportAt = row.task_report_accepted_at; // hoisted from below the report branch
  if (run.reported) {
    if (!newerMiss) return { columns: NO_MISSES, paused: false };
    // The misses before this report end, and so do the ones before a newer report whose run is still open:
    // it has answered them, though its run hasn't trimmed them yet (TASK-935). One whose run has finished
    // trimmed them then; trimming from it again would drop a miss that started in its instant and finished
    // after it. The ones after both stay, the newer miss's own included unless that open report answered it.
    const from = reportAt !== null && reportAt > run.acceptedAt && await reportStillOpen(trx, row, reportAt) ? reportAt : run.acceptedAt;
    const kept = await unansweredAfter(trx, row, from, Math.max(0, row.task_misses_in_a_row));
    return { columns: kept === 0 ? NO_MISSES : { task_misses_in_a_row: kept }, paused: false };
  }
  if (reportAt !== null && reportAt > run.acceptedAt) {
    // A run started after this one has reported, so this one doesn't count. While that run is still open, its
    // report has answered the misses before it too: trim to the ones after it, never up (TASK-935). A count
    // below one (a hand edit) has nothing to trim, and LIMIT can't go negative at boot.
    if (row.task_misses_in_a_row < 1 || !await reportStillOpen(trx, row, reportAt)) return null;
    const kept = await unansweredAfter(trx, row, reportAt, row.task_misses_in_a_row);
    return kept === row.task_misses_in_a_row ? null : { columns: kept === 0 ? NO_MISSES : { task_misses_in_a_row: kept }, paused: false };
  }
  // ...unchanged from "// A count below zero (a hand edit) starts again at one." on.
```

Delete the old `const reportAt = …` (:544) and the old `if (reportAt !== null && reportAt > run.acceptedAt) return null;` (:545). When the count is trimmed but not to zero, the reason and start stay as they are: the newest counted miss started after the report being trimmed from.

- [ ] **Step 4: Run the file, then the package, and type-check.**

Run: `pnpm --filter @ax/routines test src/__tests__/misses-store.test.ts`
Expected: all tests pass.

Run: `pnpm --filter @ax/routines test && pnpm --filter @ax/routines build`
Expected: the package's tests all pass, and `tsc -b` exits 0. (An Explore pass found no routines test outside `misses-store.test.ts` that reaches either branch. A failure elsewhere is new information: stop and read it.)

- [ ] **Step 5: Commit.**

```bash
git add packages/routines/src/store.ts packages/routines/src/__tests__/misses-store.test.ts
git commit -m "[TASK-935] Miss count: an older check-in's finish trims from a newer report still open"
```

- [ ] **Step 6: Mutation pass. Predict first, then run and compare.** This step needs Step 5's commit, because each mutant is undone with `git checkout`. Apply each mutant to `store.ts` alone, run `pnpm --filter @ax/routines test src/__tests__/misses-store.test.ts`, and restore it with `git checkout -- ':(literal)packages/routines/src/store.ts'`. Write down which tests fail, next to this prediction. A mismatch is a finding: either a test is blind, or the code isn't doing what was read. Fix it before Task 2. `git status` must be clean afterwards.

| Mutant | Predicted to fail |
|---|---|
| M1: the report path trims from `run.acceptedAt` always (no fix) | (b); new test 1 (`late`) |
| M2: the no-report branch returns `null` (no fix) | (a); new test 1 (no report) |
| M3: the report path trims from `reportAt` whenever it is newer, without `reportStillOpen` | new test 2 (`late`) |
| M4: the no-report branch recounts whenever `reportAt` is newer, without `reportStillOpen` | new test 2 (no report) |
| M5: the report path returns `NO_MISSES` whenever a newer report is open | new test 1 (`late`) |
| M6: the no-report branch returns `NO_MISSES` whenever a newer report is open (count ≥ 1) | new test 1 (no report); new test 3 (Resume) |
| M7: the no-report branch caps at `row.task_misses_in_a_row + 1` | new test 3 (Resume: 2, not 1) |
| M8: the no-report branch drops the `< 1` guard and passes the raw count | new test 3 (hand edit: `finishDispatch` rejects, because LIMIT is negative) |

---

### Task 2: Make `missesAfterRun`'s doc true, and supersede the stale pattern row [tier: mechanical]

**Files:**
- Modify: `packages/routines/src/store.ts:490-516` (the doc's second paragraph only; the first paragraph, :478-489, and the third, :518-527, stay)
- Create: `.claude/memory/patterns/2026-10-25-TASK-935.md`

**Interfaces:**
- Consumes: Task 1's behavior, as the doc describes it.
- Produces: nothing in code.

- [ ] **Step 1: Replace store.ts:490-516** (from ` * Runs that overlap (a Check now beside a scheduled check-in) answer in the` through ` * overlap, since a fire row doesn't say which side of it its run finished on.`) with the text below. Rewrapping is fine. Each claim is checked in decisions rows 2–4, so keep every one of them.

```text
 * Runs that overlap (a Check now beside a scheduled check-in) answer in the
 * order they started, whatever order they finish in, as `recordReport` keeps
 * the report of the run accepted last. A report is saved when the agent sends
 * it, before its run finishes, and answers from then on. While its run is
 * still open (`reportStillOpen`), it has answered the misses that started
 * before it, though nothing has trimmed them yet. So a run that finishes
 * meanwhile counts from it, not from the count.
 *
 * A run without a report doesn't count once a run that started after it has
 * reported (`task_report_accepted_at`), finished or not. If that report's run
 * is still open, the count drops to the misses that started after it, if
 * that's fewer (`unansweredAfter`). A count below one (a hand edit) is left as
 * it is. A run without a report that started at or after an open report counts
 * on from the misses after that report, capped at the count plus one, so a
 * Resume's fresh start holds. It doesn't count itself when it started in the
 * same instant as that report, whose run finishes after it. With no misses
 * after that report, it clears them.
 *
 * A run that reported behind a newer miss (`task_miss_at`) leaves that miss,
 * with its reason and start. It ends the misses before it, and the ones before
 * a newer report whose run is still open: the count drops to the runs that
 * started after the later of the two and finished without a report, if that's
 * fewer. Trimmed from its own start, the newer miss's own run is one of them,
 * so that's at least one. The exception is a miss time no such run backs, or a
 * count below one, which only a hand edit or a rollback leaves; then the report
 * clears them. Trimmed from a newer open report, there can be none, since that
 * report answered the newer miss too; then it clears them as well. A newer
 * report whose run has finished is passed over. That finish already trimmed
 * the count, and trimming from it again would drop a miss that started in its
 * instant and finished after it. A run without a report behind a newer miss
 * still counts, but keeps that miss's reason and start, so `task_miss_at`
 * never moves back.
 *
 * So, apart from the cases above that leave them as they are, every finish
 * leaves the count at exactly the misses that started after the latest saved
 * report. Between finishes it can lag. A report is saved before its run
 * finishes, so the misses before it stay counted until the next finish. A
 * person can see that, but nothing pauses on it: a pause is decided only when
 * a miss is counted, and the count is exact then. The count can run long when
 * a Resume or a kind change starts it over while runs overlap, since a fire
 * row doesn't say which side of it its run finished on.
 *
 * It runs short in one case: a hand edit or a rollback leaves a stored report
 * that its run's finish reads as none (one this version can't read, such as a
 * later version's, or a JSON null). The runs that finished while that report's
 * run was open took it as answering the misses before it, because
 * `reportStillOpen` asks only that a report is stored. Then its own run counts
 * as a miss. So the count comes out short by every miss that report was taken
 * to answer, and a pause can be missed.
```

- [ ] **Step 2: Write the pattern row** to `.claude/memory/patterns/2026-10-25-TASK-935.md`. Get the path from `scripts/memory-write-target.sh --shard patterns TASK-935`, then `mkdir -p` its directory. The file is this one line:

```markdown
- `2026-10-25` (TASK-935) — **Supersedes TASK-930's "rule as built" (exact whenever a miss is counted, never short, can read high until a newer open run finishes).** Every path through `missesAfterRun` now consults a newer saved report whose run is still open. So the miss count is exact after every finish, and between finishes it lags a saved report only until the next finish. It can run long across a Resume or kind change while runs overlap. It runs short only after a hand edit or rollback leaves a stored report its finish reads as none, and then by every miss that report was taken to answer (not one), which can miss a pause. The reusable shape: when the fact that answers a counter (a saved report) is written outside the counter's writer, every path through the writer has to consult it, or each path that doesn't becomes its own lag. TASK-930 found one such path per review round. Count the paths up front, not the bug reports.
```

- [ ] **Step 3: Check that no stale line is left.**

Run: `grep -n "never short\|known lag\|It can lag: a report saved" packages/routines/src/store.ts packages/routines/src/__tests__/misses-store.test.ts`
Expected: no output.

- [ ] **Step 4: Commit** (the plan and the decisions shard go in too if they aren't committed yet: the cited-paths guard needs them tracked).

```bash
git add packages/routines/src/store.ts .claude/memory/patterns/2026-10-25-TASK-935.md docs/plans/2026-10-25-task-935-late-report-lag-plan.md .claude/memory/decisions/2026-10-25-TASK-935.md
git commit -m "[TASK-935] missesAfterRun's doc: exact after every finish, and the one way it reads short"
```

---

## Final verification (card acceptance)

- [ ] Run: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`
  Expected: every suite green. With `--no-bail`, read each package's result. Don't stop at the first red: `@ax/auth-better`'s Docker teardown timeout with all assertions passing is a known local flake (CLAUDE.md).
- [ ] Run: `pnpm lint`
  Expected: exit 0. Lint noise from stale sibling worktrees is a known false failure, so check that any finding is in this tree.
- [ ] Run: `scripts/memory-append-check.sh` (R1/R2). Expected: pass. No root `.claude/memory/*.md` archive is touched, and no memory line is deleted.
