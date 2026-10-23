# TASK-930: task failure ladder (No recent update, then Needs you, then auto-pause) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count every task check-in that finishes without a report, show the task as ○ No recent update (1–2), ◆ Needs you (3+), pause it at 5, and let only a person resume it.

**Architecture:** One counter on the routine's definition row, written only by `finishDispatch` (every run of every routine ends there) under the same lock order as `recordReport`, and reset only by a person's Resume or a kind change in `updateAuthored`. The routines views expose it as `noRecentUpdate` (owner only, never for repeat routines); the agent's `routine_update` refuses `enabled: true` on a paused task at pre-call and at execute; channel-web projects it field by field and draws it on the Tasks page and the task page with words from one closed table keyed on the reason code.

**Tech Stack:** TypeScript, zod 3.25, Kysely + Postgres (testcontainers), vitest, React + shadcn (channel-web).

**Spec:** the TASK-930 card (orchestrator scratchpad `TASK-930/card.md`) and `docs/plans/2026-10-20-agent-tasks-design.md` §3.6, §4.5, §7, §12 PR 2. Decisions for this plan: `.claude/memory/decisions/2026-10-23-TASK-930.md`.

## Global Constraints

- Thresholds: `TASK_NEEDS_YOU_AFTER_MISSES = 3`, `TASK_AUTO_PAUSE_AFTER_MISSES = 5`. Every copy that names a number builds it from these constants.
- Reason codes, in this order, everywhere (contract enum, DB CHECK, words table): `'no-report' | 'brief-missing' | 'brief-unconfirmed' | 'brief-too-long' | 'interrupted' | 'failed'`. **Six, not the card's five** (decisions row 2). Classify at the source; never parse an error string.
- The counter's columns are written only by `finishDispatch` and `updateAuthored` (Resume, kind change). Nothing an agent sends reaches them.
- Copy uses U+2019 for apostrophes and U+201C/U+201D around “What to do”, as `BRIEF_TOO_LONG` does. Component tests assert copy verbatim.
- Run one file with `pnpm --filter @ax/<pkg> test <file>` — never `-- <file>`, never filter after the script name. Check the summary's file count.
- `@ax/routines` and `@ax/routines-admin-routes` integration tests start Postgres: export `DOCKER_HOST` first. Don't run two Postgres-heavy tasks' suites at the same moment in one worktree (TASK-910 "container start slot" timeouts are queueing; re-run that package alone).
- channel-web type-checks its test files (`include: ["src"]`, `build: tsc --build && vite build`), and its server tests import `StoredRoutine`/`routineView` from `packages/routines/src` directly. A type change in routines that a channel-web fixture doesn't follow fails `pnpm build`. Each task below lists the fixtures its type change forces. Typecheck with `pnpm --filter @ax/channel-web exec tsc --build`.
- channel-web `src/lib/*.ts` modules import siblings as relative `./x.js`, never `@/lib/...` (TASK-906 pattern: the server build can't resolve the alias).
- UI: shadcn primitives already installed (`Card`, `Alert`, `Button`) plus `StateDot`, semantic tokens only. No new shadcn component, no new dependency, no `pnpm-lock.yaml` change. Invoke `shadcn` for every UI task and `ux-design` where the task says so.
- Memory rows go to shards under `.claude/memory/<kind>/2026-10-23-TASK-930.md`, never a root archive.
- Final gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

## Review Focus

1. **Overlapping check-ins around the threshold.** A Check now that runs alongside a scheduled check-in can finish after the 5th miss paused the task: it must not push the count past 5 or clear the paused state, even if it reports; one that finishes after a person's Resume counts from 0. → Task 3, tests "once paused by misses, later runs leave the count alone" and "a run still open across Resume counts from zero".
2. **A person fixing the cause while paused.** Shortening “What to do” for `brief-too-long` is an edit that keeps the task paused; it must not reset the ladder — only Resume does (task page and Settings both call `routines:update`). → Task 3 test "an edit that keeps it paused keeps the count"; Task 13 test "Resume on an auto-paused task".
3. **The 5th run's own status.** The statement that pauses the task mints a new revision; the run's `last_status`/`last_error` update has `WHERE revision = dispatch.revision`, so it must run first or the 5th run's status is silently lost. → Task 3 test "the fifth miss pauses the task…" asserts `lastStatus`/`lastError` of the 5th run.
4. **A model patch that smuggles `enabled: true`.** Bundled with a brief edit (which would otherwise be held for a person whose card doesn't draw `enabled`), or swapped in between pre-call and execute under the same requestId. → Task 4 tests.
5. **A restart during the 5th check-in.** `interruptAbandonedDispatches` runs in plugin init with no catch: the interrupted run can be the 5th miss, must pause the task, print the line, and never throw. → Task 3 test "an interrupted run can be the fifth miss".

## Where the code contradicted the card (decisions shard rows in brackets)

- **The belt is not `brief-missing`** [2]. TASK-908 row 8 gave the belt its own sentence (`BRIEF_UNCONFIRMED`) because a belt-recorded run may have run; "Its instructions didn’t load, so it couldn’t check in" would be false there. New code `brief-unconfirmed`.
- **Auto-pause must move what a person's pause moves** [3]: `updateAuthored {enabled:false}` also sets `next_run_at = NULL` (`nextRun` of a disabled definition) and `updated_at`; `TaskDetail.nextCheckAt` is documented "null when paused".
- **Statement order in `finishDispatch`** [4]: the counter/pause update must follow the existing `last_*` update (Review Focus 3).
- **Late runs after an auto-pause** [5]: the card is silent; without a freeze a straggler makes "Its last 6 check-ins…" or clears the state TASK-933 keys Today on.
- **`TaskRow` needs `at`** [10]: TASK-933 orders Today by `noRecentUpdate.at`; one shape for row and detail is also less code.
- **"See what it did" can be exact** [11]: `noRecentUpdate.at` is `dispatch.accepted_at`, which is the fire row's `fired_at`; link the entry whose `firedAt === at`, not "the newest entry" (Updates has no tiebreak).
- **Refusal field** [8]: `SafeToolError('forbidden', 'enabled')` (`enabled` is in core's closed `TOOL_FIELDS`), so the agent learns which part of its patch was refused.
- **Fix copy** [12]: the card's fixes embed "See what it did" in sentences (dangling when there's no link) and say "Check now" on a paused task (Check now is disabled while paused).
- **Tool refusal tests live in `canary.test.ts`** [8], where the real Always Allow harness (`alwaysAllowed()`) is; `tools.test.ts` has none.

## Boundary review (view change on `routines:list` / `routines:get` / `routines:create` / `routines:update` and the `routine_list` / `routine_get` / `routine_update` tool outputs)

- **Alternate impl:** an external tracker computing "check-ins in a row with no report" from its own run log; a SQLite routines store with the same counter.
- **Payload names that might leak:** none. `noRecentUpdate`, `inARow`, `reason`, `at`, `autoPaused`; the codes are product words (no `veto`, `belt`, `dispatch`, `revision`, column names).
- **Subscriber risk:** none (service view). Consumers use `reason` for wording only, never for authorization; an unknown code reads `failed`.
- **Wire surface:** not an IPC action; schemas live in `@ax/routines-contract` with the other view schemas. channel-web's `TaskRow`/`TaskDetail` are its own route shapes.

## Tiers, waves, security

| Task | Tier | Needs | security-checklist |
|---|---|---|---|
| 1 Contract vocabulary | mechanical | — | — |
| 2 Migration v7 + read path | sensitive | 1 | PR note |
| 3 `finishDispatch` counter, auto-pause, resets | sensitive | 2 | PR note |
| 4 Only a person resumes | sensitive | 1 | **run** |
| 5 Views | sensitive | 2 | **run** |
| 6 Callers classify the miss | integration | 3 | — |
| 7 Check-in message line | integration | 2, 6 | — |
| 8 Routines canary | integration | 3–7 | — |
| 9 channel-web wire | integration | 5 | — |
| 10 Groups + StateDot mark | integration | 9 | — |
| 11 Words table + exact link | mechanical | 1, 9 | — |
| 12 Tasks page | integration | 10, 11 | — |
| 13 Task page | integration | 10, 11 | — |
| 14 Docs | mechanical | all | — |

Waves (disjoint files within a wave): **1** → **2** → **3, 4, 5** → **6, 9** → **7, 10, 11** → **8, 12, 13** → **14**. Tasks 3, 4, 5, 6, 7, 8 all run the Postgres routines suite.

PR security note must cover: auto-pause is the §7 cost bound; the refusal closes TASK-906 row 25's Always Allow path and is tested at execute; the new revision on auto-pause closes the window between `prepare`'s row read and `updateAuthored`; the new fields are host-written (counts, closed codes, instants), owner-only, and lenient on read (TASK-913); the recorded run error stays fenced in Updates where TASK-910 draws it.

## File map

- `packages/routines-contract/src/definition.ts` — codes, thresholds, view schema (T1); view fields (T5). `tools.ts` — descriptions (T1).
- `packages/routines/src/migrations.ts` — version 7, row type (T2). `types.ts`, `definition.ts` (`StoredRoutineSchema`), `store.ts` read path + receipts (T2); `store.ts` write path, `types.ts` (`DispatchMiss`), `dispatch.ts` (T3). `tools.ts` (T4). `services.ts` (T5). `brief.ts`, `fire.ts`, `plugin.ts` (T6). `checkin-message.ts`, `fire.ts` (T7).
- `packages/channel-web/src/lib/workspace-types.ts`, `server/routes-workspace.ts`, `lib/workspace-api.ts` (T9). `lib/task-groups.ts`, `components/workspace/bits.tsx` (T10). New `lib/task-miss.ts`, `lib/task-updates.ts` (T11). `components/workspace/TasksPage.tsx` (T12). `components/workspace/TaskPage.tsx` (T13).
- `docs/plans/2026-10-20-agent-tasks-design.md` (T14).

---

### Task 1: Contract vocabulary and tool descriptions [tier: mechanical]

**Files:**
- Modify: `packages/routines-contract/src/definition.ts` (after `RoutineInstantSchema`)
- Modify: `packages/routines-contract/src/tools.ts` (`RoutineToolDescriptions`)
- Create test: `packages/routines-contract/src/__tests__/misses.test.ts`

**Interfaces:**
- Produces (exported from `@ax/routines-contract`):
  ```ts
  export const CHECK_IN_MISSES = ['no-report', 'brief-missing', 'brief-unconfirmed', 'brief-too-long', 'interrupted', 'failed'] as const;
  export const CheckInMissSchema = z.enum(CHECK_IN_MISSES);
  export type CheckInMiss = z.output<typeof CheckInMissSchema>;
  export const TASK_NEEDS_YOU_AFTER_MISSES = 3;
  export const TASK_AUTO_PAUSE_AFTER_MISSES = 5;
  export const RoutineNoRecentUpdateViewSchema = z.object({
    inARow: z.number().int().min(1), reason: CheckInMissSchema, at: RoutineInstantSchema, autoPaused: z.boolean(),
  }).strict();
  export type RoutineNoRecentUpdateView = z.output<typeof RoutineNoRecentUpdateViewSchema>;
  ```
  Do NOT add the field to `RoutineViewSchema`/`RoutineListToolViewSchema` here (Task 5 does it together with the producer, so every task leaves the suite green).

- [ ] **Step 1: Write the failing tests** in `misses.test.ts`:
  - `CHECK_IN_MISSES` equals the six codes in order; the thresholds are 3 and 5.
  - `RoutineNoRecentUpdateViewSchema` parses `{ inARow: 1, reason: 'no-report', at: '2026-10-23T10:00:00.000Z', autoPaused: false }` and every code; refuses `inARow` `0`, `1.5`, `'2'`; reason `'gremlins'`; `at: new Date()`; an extra key; each key left out.
  - `RoutineToolDescriptions.routine_update` contains `'Only a person can resume a paused task.'`.
  - `routine_list` and `routine_get` each contain `'A task’s noRecentUpdate counts its check-ins in a row that ended without a report, with the last one’s reason and start time, or is null when there are none and for a task another person owns. autoPaused means ax paused the task after five in a row, and only a person can resume it.'`
- [ ] **Step 2: Run** `pnpm --filter @ax/routines-contract test src/__tests__/misses.test.ts` — expect FAIL (exports missing).
- [ ] **Step 3: Implement.** Add the exports above with a doc comment (host-written; the codes are the closed reasons a check-in left no report; wording lives in channel-web). In `tools.ts`, append `' Only a person can resume a paused task.'` right after `routine_update`'s `'Set enabled false to stop scheduling.'`, and append the noRecentUpdate sentence at the end of `routine_list` and `routine_get` (exact text in Step 1).
- [ ] **Step 4: Run** the file, then `pnpm --filter @ax/routines-contract test` (existing `toContain` description pins must stay green).
- [ ] **Step 5: Commit** `feat(routines-contract): check-in miss codes, thresholds and the noRecentUpdate view (TASK-930)`.

### Task 2: Migration v7 and the read path [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/migrations.ts` (`RoutinesDefinitionsRow`, `runRoutinesMigration`, new `addCheckInMissColumns`)
- Modify: `packages/routines/src/types.ts`, `packages/routines/src/definition.ts` (`StoredRoutineSchema`), `packages/routines/src/store.ts` (`rowToRoutine`, `receiptCopy`)
- Test: `packages/routines/src/__tests__/migrations.test.ts`; create `packages/routines/src/__tests__/misses-store.test.ts`
- Fixtures forced by the `StoredRoutine` type (add `noRecentUpdate: null`, after any spread of `routineFixture`): `packages/routines/src/__tests__/{return-schemas,brief,fire,next-check}.test.ts` StoredRoutine literals; `packages/channel-web/src/__tests__/routine-manager-producer.test.tsx` (`row`), `packages/channel-web/src/__tests__/server/routes-workspace-{checkin,task,tasks}.test.ts` (each `stored()` base).

**Interfaces:**
- Consumes: `CHECK_IN_MISSES`, `CheckInMiss`, `CheckInMissSchema` (Task 1).
- Produces:
  ```ts
  // types.ts
  export type { CheckInMiss } from '@ax/routines-contract';
  export type StoredNoRecentUpdate = { inARow: number; reason: CheckInMiss; at: Date; autoPausedAt: Date | null };
  // StoredRoutine gains: noRecentUpdate: StoredNoRecentUpdate | null;
  // migrations.ts RoutinesDefinitionsRow gains:
  task_misses_in_a_row: ColumnType<number, number | undefined, number>;
  task_miss_reason: ColumnType<string | null, CheckInMiss | null | undefined, CheckInMiss | null>; // read as string: lenient
  task_miss_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  task_auto_paused_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  ```

- [ ] **Step 1: Write the failing migration tests** in `migrations.test.ts` (schema is dropped before each test, so these can drop constraints freely):
  - `version 7 adds the miss columns; existing rows read back with none (TASK-930)`: migrate, drop the four columns and `routines_v1_definitions_task_miss_reason_chk`, `DELETE … WHERE version = 7`, `insertTask()`, migrate twice → versions `[2,3,4,5,6,7]`, columns `0/NULL/NULL/NULL`, `findOne(...).noRecentUpdate === null`. Then set values (`2`, `'interrupted'`, an instant), delete version 7 again, migrate → values kept, constraint count 1.
  - `refuses an unknown miss reason at the database (TASK-930)`: INSERT (not UPDATE — TASK-906 row 21) a task with `task_miss_reason 'gremlins'` → `{ code: '23514', constraint: 'routines_v1_definitions_task_miss_reason_chk' }`; each `CHECK_IN_MISSES` code inserts (distinct `routine_id`s).
  - `a stored reason no code knows reads as failed and doesn't stop the tick (TASK-930)`: drop the CHECK, insert a task with count 2, `'gremlins'`, a miss time and a past `next_run_at` → `findOne` gives `{ inARow: 2, reason: 'failed', at, autoPausedAt: null }`; `claimDue({ now: <after next_run_at>, limit: 10, claimWindowMinutes: 5 })` returns it, no throw.
  - Change every `[2, 3, 4, 5, 6]` (seven places) to `[2, 3, 4, 5, 6, 7]`.
- [ ] **Step 2: Write the failing read-path tests** in new `misses-store.test.ts` (copy `fixture()`, `taskInput`, `checkIn`, `finish`, `claimed` helpers from `report-views.test.ts`):
  - `a row whose miss columns are partly set or hold no count reads as no misses, and the tick still runs`: for `{count 0, reason 'no-report', at now}`, `{count -3, …}`, `{count 2, reason 'failed', at NULL}` → `findOne`, `list` → `noRecentUpdate: null`; `claimed(row)` returns the row.
  - `a full row reads back exactly`: `{count 4, 'brief-too-long', at, auto_paused_at NULL}` → `{ inARow: 4, reason: 'brief-too-long', at, autoPausedAt: null }`.
  - `receipts keep no copy of the misses`: hand-set count 2 on a task, then create/update/accept receipts → `SELECT count(*) … WHERE result ? 'noRecentUpdate' OR result->'row' ? 'noRecentUpdate'` is 0; an exact `acceptDispatch` replay answers `row.noRecentUpdate === null`; a receipt with no such key parses through `parseStoredRoutine`/`AcceptedDispatchSchema` with `null`.
- [ ] **Step 3: Run** `pnpm --filter @ax/routines test src/__tests__/migrations.test.ts` and `… test src/__tests__/misses-store.test.ts` — expect FAIL.
- [ ] **Step 4: Implement.**
  - `migrations.ts`: `if (!await done(7)) { await addCheckInMissColumns(trx); INSERT version 7 }`. `addCheckInMissColumns`: `ADD COLUMN IF NOT EXISTS task_misses_in_a_row INTEGER NOT NULL DEFAULT 0`, `task_miss_reason TEXT`, `task_miss_at TIMESTAMPTZ`, `task_auto_paused_at TIMESTAMPTZ`; the named CHECK `task_miss_reason IN (<the six codes>)` added only if missing (copy the version-4 `DO $$` block). Doc comment: additive, no backfill, old code ignores the columns; written only by `finishDispatch` and `updateAuthored`. Row-type doc next to the version-4/6 docs.
  - `definition.ts` `StoredRoutineSchema` gains `noRecentUpdate: z.object({ inARow: z.number().int(), reason: CheckInMissSchema, at: z.coerce.date(), autoPausedAt: z.coerce.date().nullable() }).strict().nullable().default(null)` — types and the enum only (TASK-907 row 7's rule); the default fills receipts.
  - `store.ts`: `function noRecentUpdate(row): StoredNoRecentUpdate | null` — null unless `Number.isInteger(count) && count >= 1 && task_miss_at !== null`; a reason not in `CHECK_IN_MISSES` reads `'failed'`. `rowToRoutine` passes `noRecentUpdate: noRecentUpdate(row)`. Rename `withoutTask` → `withoutTaskState`, dropping `task` and `noRecentUpdate`; update `receiptCopy`'s doc (rollback-safe: old strict schemas have neither key).
  - Fixtures listed above.
- [ ] **Step 5: Run** both files, then `pnpm --filter @ax/routines test`, `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 6: Commit** `feat(routines): schema v7 miss columns and a lenient noRecentUpdate read (TASK-930)`.

### Task 3: `finishDispatch` counts, auto-pauses and freezes; Resume and kind changes reset [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/store.ts` (`finishDispatch`, `interruptAbandonedDispatches`, `updateAuthored`, `NO_TASK_STATE`), `packages/routines/src/types.ts`, `packages/routines/src/dispatch.ts`
- Test: `packages/routines/src/__tests__/misses-store.test.ts`

**Interfaces:**
- Consumes: Task 2's columns and `StoredRoutine.noRecentUpdate`; `TASK_AUTO_PAUSE_AFTER_MISSES`, `CheckInMissSchema`.
- Produces:
  ```ts
  // types.ts
  /** Why an `error` run left no report, set by the code that recorded it. Absent: 'failed'. */
  export type DispatchMiss = Exclude<CheckInMiss, 'no-report'>;
  // DispatchOutcome gains: miss?: DispatchMiss;
  // dispatch.ts DispatchOutcomeSchema gains: miss: CheckInMissSchema.exclude(['no-report']).optional()  (still .strict())
  // store.ts
  const NO_MISSES = { task_misses_in_a_row: 0, task_miss_reason: null, task_miss_at: null, task_auto_paused_at: null } as const;
  // stderr after commit, ids only:
  // `[ax/routines] auto-paused task ${agentId}/${routineId} after ${TASK_AUTO_PAUSE_AFTER_MISSES} check-ins without a report\n`
  ```

- [ ] **Step 1: Write the failing tests** (append to `misses-store.test.ts`; use `captureExpectedStderr` from `support/expected-diagnostics.ts` wherever a pause happens):
  - `a check-in that finishes without a report counts, its start as the time and no-report as the reason`: `ok` then `silenced` → `inARow` 1 then 2, `reason 'no-report'`, `at` equals the run's `acceptedAt` and its fire row's `firedAt`.
  - `it.each` over `['brief-missing','brief-unconfirmed','brief-too-long','interrupted','failed', undefined]`: an `error` outcome with that `miss` records it; `undefined` records `'failed'`. A non-error outcome carrying `miss` still records `'no-report'`.
  - `a report resets the count, even on a run that then errored`: two misses, then a run that `recordReport`s and finishes `error` → `noRecentUpdate === null`, columns `NO_MISSES`.
  - `a repeat routine never counts`.
  - `the fifth miss pauses the task: not enabled, a new revision, a fresh spec hash, no next run, and the tick claims nothing`: after 5 → `enabled false`, `revision !==` before, `spec_hash === inputHash({ ...editableDefinition(before), enabled: false })`, `next_run_at null`, `updated_at` and `task_auto_paused_at` set, `findOne().noRecentUpdate` `{ inARow: 5, autoPausedAt: <Date> }`; the 5th run finished `error` with `error: 'boom'` and `findOne()` shows `lastStatus 'error'`, `lastError 'boom'` (Review Focus 3); exactly one stderr line, the text above; `claimDue` far in the future excludes it; `acceptDispatch` with the new revision → `null`.
  - `an edit held against the revision before an auto-pause fails as a revision conflict`: `updateAuthored` with the old revision → `SafeToolError` `revision-conflict`.
  - `once paused by misses, later runs leave the count alone`: accept runs 5 and 6 (overlap), finish 5 (pauses), finish 6 without a report → count 5, reason and `at` unchanged; with a report instead → still 5, `task_auto_paused_at` kept (Review Focus 1).
  - `a person's Resume starts the count over; an edit that keeps it paused keeps the count`: after the pause, `updateAuthored({ patch: { promptBody: 'Shorter.' } })` → count 5 (Review Focus 2); `updateAuthored({ patch: { enabled: true } })` → `NO_MISSES`, enabled, `next_run_at` set. Also a person's pause then Resume of a task at 2 misses resets.
  - `a run still open across Resume counts from zero`: run accepted before the pause, finished after Resume without a report → count 1.
  - `a kind change clears the misses with the rest of the task state`.
  - `an edit during a check-in doesn't drop its miss`: accept, `updateAuthored` (new revision), finish → count 1.
  - `an interrupted run counts as interrupted, and can be the fifth miss` (Review Focus 5): four misses, accept a 5th, `interruptAbandonedDispatches()` resolves `1` without throwing → `reason 'interrupted'`, paused, the stderr line.
  - `two check-ins finishing at once both count`: `Promise.all([finish(a), finish(b)])` → 2. `a report racing its own run's finish lands one consistent answer` (10 rounds): either `recordReport → 'recorded'` and count 0, or `'run-closed'` and count 1; never a deadlock.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines test src/__tests__/misses-store.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** in `finishDispatch`, inside its existing transaction:
  ```
  after the dispatch FOR UPDATE read and its completed_at check:
    definition := SELECT * FROM routines_v1_definitions WHERE (agent_id, routine_id) = dispatch's FOR UPDATE
                  -- fence → dispatch → definition: recordReport's order. No locker takes a dispatch lock
                  -- after a definition lock, so no new deadlock edge.
  insert fire row; complete the dispatch; update last_* WHERE revision = dispatch.revision  (all unchanged, in this order)
  -- then, and only then (Review Focus 3):
  skip when definition is missing, definition.kind = 'repeat',
       or (definition.task_auto_paused_at IS NOT NULL AND NOT definition.enabled)   -- frozen until a person acts
  if stored.report !== null: SET NO_MISSES
  else:
    inARow := max(0, task_misses_in_a_row) + 1
    reason := outcome.status = 'error' ? (outcome.miss ?? 'failed') : 'no-report'
    SET task_misses_in_a_row = inARow, task_miss_reason = reason, task_miss_at = dispatch.accepted_at
    if inARow >= TASK_AUTO_PAUSE_AFTER_MISSES and definition.enabled:
      also SET enabled = false, revision = opaqueId('rev'), spec_hash = pausedSpecHash(definition),
               next_run_at = NULL, updated_at = now, task_auto_paused_at = now      -- now: one new Date()
  no revision clause on this statement (TASK-907 decisions row 8)
  ```
  `pausedSpecHash(row)`: `inputHash({ ...editableDefinition(rowToRoutine(row)), enabled: false })` inside try/catch, falling back to `row.spec_hash` — this runs in plugin init via `interruptAbandonedDispatches`, so it must never throw on stored data. Write the stderr line after commit, next to the unreadable-report line. `interruptAbandonedDispatches` passes `miss: 'interrupted'`. `updateAuthored`: `NO_TASK_STATE` spreads `NO_MISSES`; add `...(!current.enabled && next.enabled ? NO_MISSES : {})`. Update `NO_TASK_STATE`'s and `finishDispatch`'s doc comments (who writes the counter, the freeze, the order).
- [ ] **Step 4: Run** the file, then `pnpm --filter @ax/routines test` (existing `report-store`, `dispatch`, `clear-notes-store` must stay green).
- [ ] **Step 5: Commit** `feat(routines): count check-ins without a report and pause a task at five (TASK-930)`.

### Task 4: Only a person resumes a paused task [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/tools.ts` (`prepare`)
- Test: `packages/routines/src/__tests__/canary.test.ts` (inside the `registered approval-to-tick-to-webhook cutover canary` describe, reusing `alwaysAllowed()`)

**Interfaces:**
- Consumes: Task 1's description text.
- Produces: `routine_update` refuses `SafeToolError('forbidden', 'enabled')` when the stored routine is a task (`kind !== 'repeat'`), not enabled, and the patch has `enabled === true`. Pre-call reason text: `'This operation is not allowed for this person and agent. Field: enabled'`.

- [ ] **Step 1: Write the failing test** `with Always Allow granted, the agent can’t resume a paused task, at pre-call or at execute; a paused repeat routine resumes (TASK-930)`:
  - Create a task through the held card (approve `'once'`, as the TASK-906 test does), then pause it as a person: `store.updateAuthored({ …, patch: { enabled: false }, stopOnly: false })`.
  - `tool:pre-call` with `update('resume', paused, { enabled: true })` → `{ rejected: true, source: '@ax/routines', reason: 'This operation is not allowed for this person and agent. Field: enabled' }`, and `isHold` false.
  - Bundled: `update('bundle', paused, { promptBody: 'Answer simple tickets.', enabled: true })` → rejected at pre-call, no hold (Review Focus 4).
  - Direct `tool:execute:routine_update` (skipping pre-call) with `{ enabled: true }` → rejects `{ toolCode: 'forbidden', field: 'enabled' }`.
  - Swap: pre-call `update('swap', paused, { activeHours: null })` passes; execute `update('swap', paused, { enabled: true })` rejects `forbidden`.
  - The task's row is still `enabled: false` with its revision unchanged after all of the above.
  - `weekly` (repeat): direct execute pause, then direct execute `{ enabled: true }` → `enabled: true`.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines test src/__tests__/canary.test.ts` — expect FAIL on the new case.
- [ ] **Step 3: Implement** in `prepare`'s shared row branch, right after `if (!row) throw new SafeToolError('not-found', 'routineId');` and before the revision check: when `name === 'routine_update' && row.kind !== 'repeat' && !row.enabled && patch.enabled === true`, throw `new SafeToolError('forbidden', 'enabled')`. Comment: design §3.6/§7 "only a person resumes"; closes TASK-906 decisions row 25; `prepare` runs at pre-call and again at execute, so a swapped call is refused too; a pause mints a new revision, so a patch read against the row before a pause fails `revision-conflict` in `updateAuthored`; a receipt replay returns before this read and can only replay an edit that already happened. `!== 'repeat'`: an unknown kind is refused (safe direction).
- [ ] **Step 4: Run** the file, then `pnpm --filter @ax/routines test src/__tests__/tools.test.ts`.
- [ ] **Step 5: Run `security-checklist`** over the diff (tool authorization reached over IPC); paste its note into the PR draft notes.
- [ ] **Step 6: Commit** `feat(routines): routine_update can't resume a paused task (TASK-930)`.

### Task 5: Views carry `noRecentUpdate`, owner only [tier: sensitive]

**Files:**
- Modify: `packages/routines-contract/src/definition.ts` (`RoutineViewSchema`, `RoutineListToolViewSchema` and their doc comments), `packages/routines/src/services.ts` (`routineView`, new `noRecentUpdateView`, `taskView` doc)
- Test: `packages/routines/src/__tests__/return-schemas.test.ts`, `packages/routines/src/__tests__/report-views.test.ts`, `packages/routines-contract/src/__tests__/misses.test.ts`
- Fixtures forced by the strict view schemas (add `noRecentUpdate: null`): `packages/routines-contract/src/__tests__/definition.test.ts` (the four view literals: in `public services and tools`, the kind/goodWhen describe, and the two near lines 999 and 1181), `packages/routines-contract/src/__tests__/report.test.ts` (the two `view` consts), `packages/routines-admin-routes/src/__tests__/routes.test.ts` (its view fixture; `routes.ts` parses every answer strictly), `packages/channel-web/src/components/routines/__tests__/routine-fixture.ts`.

**Interfaces:**
- Consumes: `RoutineNoRecentUpdateViewSchema` (T1), `StoredRoutine.noRecentUpdate` (T2).
- Produces: `RoutineView.noRecentUpdate: RoutineNoRecentUpdateView | null` and the same on `RoutineListToolView`;
  ```ts
  function noRecentUpdateView(row: StoredRoutine, userId: string): C.RoutineNoRecentUpdateView | null
  // null when row.ownerUserId !== userId, row.kind === 'repeat', or row.noRecentUpdate is null;
  // else { inARow, reason, at: at.toISOString(), autoPaused: autoPausedAt !== null && !row.enabled }
  ```

- [ ] **Step 1: Write the failing tests.**
  - `misses.test.ts`: both view schemas refuse a view without `noRecentUpdate`, accept `null` and a valid object, refuse an extra key inside it; `RoutineListToolOutputSchema` accepts a routine with `noRecentUpdate`.
  - `return-schemas.test.ts` `projects a task’s misses for its owner only, never for a repeat routine`: a task literal with `noRecentUpdate: { inARow: 3, reason: 'brief-too-long', at: new Date('2030-01-01T00:10:00Z'), autoPausedAt: null }` → owner sees `{ inARow: 3, reason: 'brief-too-long', at: '2030-01-01T00:10:00.000Z', autoPaused: false }`, a teammate `null`, a repeat `null`; each output schema parses each view.
  - `report-views.test.ts`, new describe `a task's misses on the views (TASK-930)`: owner `get`/`list` show two misses after two `checkIn`+`finish`; a teammate context (another `userId`) gets `null`; `autoPaused` is true after five and false for a hand-set row that is enabled with `task_auto_paused_at` set; an exact `routines:update` replay (same `requestId`) answers `noRecentUpdate: null`.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines-contract test src/__tests__/misses.test.ts`, `pnpm --filter @ax/routines test src/__tests__/return-schemas.test.ts`, `… test src/__tests__/report-views.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Add `noRecentUpdate: RoutineNoRecentUpdateViewSchema.nullable()` to both view schemas (doc: host-written; null for repeat routines, for no misses, for anyone but the owner, and in an exact replay). `routineView` adds `noRecentUpdate: noRecentUpdateView(row, userId)`. Extend `taskView`'s doc: the owner rule covers `noRecentUpdate` too. No change to `withoutAgentNotes` (it spreads the field through; the strict tool schemas now allow it). Then the fixtures.
- [ ] **Step 4: Run** the three files, then `pnpm --filter @ax/routines-contract test`, `pnpm --filter @ax/routines test`, `pnpm --filter @ax/routines-admin-routes test`, `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Run `security-checklist`** (what reaches a model's tool output; who sees a field).
- [ ] **Step 6: Commit** `feat(routines): routine views show a task's missed check-ins to its owner (TASK-930)`.

### Task 6: The code that records a run says why it failed [tier: integration]

**Files:**
- Modify: `packages/routines/src/brief.ts` (new `briefRunMiss`), `packages/routines/src/fire.ts` (`settleWithoutTurn`), `packages/routines/src/plugin.ts` (the belt)
- Test: `packages/routines/src/__tests__/brief.test.ts`, `packages/routines/src/__tests__/checkin.test.ts`, `packages/routines/src/__tests__/fire.test.ts`

**Interfaces:**
- Consumes: `DispatchOutcome.miss`, `DispatchMiss` (T3).
- Produces:
  ```ts
  export function briefRunMiss(entry: PendingFire, terminatedReason: string): 'brief-missing' | 'brief-too-long' | null
  // same keys as briefRunError: task run + exactly 'system-prompt:brief-missing' / 'system-prompt:brief-too-long'
  settleWithoutTurn(errorFor, reachedAssembly, missFor?: (entry: PendingFire) => DispatchMiss | null)
  ```

- [ ] **Step 1: Write the failing tests.**
  - `brief.test.ts`: `briefRunMiss` maps the two reasons for a task run; `null` for a repeat run, for `system-prompt:other`, for `chat:start:quota`.
  - `checkin.test.ts` (read `createRoutinesStore(h.db).findOne(task)` after the existing `expect.poll`): the veto test → `noRecentUpdate` `{ inARow: 2, reason: 'brief-missing' }` (its earlier check-in left no report); the too-long test → `{ inARow: 1, reason: 'brief-too-long' }`; the belt test (which reported) → `null`; new `the belt without a report counts as brief-unconfirmed` (`checkIn(task, 'run', async () => {}, { landed: null })`) → `{ inARow: 1, reason: 'brief-unconfirmed' }`.
  - `fire.test.ts` (task `definition: TASK`): the failed-report-read test → `{ inARow: 1, reason: 'failed' }`; `it.each` invoke answering `terminated` with `system-prompt:brief-too-long` → `brief-too-long`, `system-prompt:brief-missing` → `brief-missing`, `system-prompt:other` → `failed`, `chat:start:quota` → `failed` (poll the fire row first; capture the expected stderr as the neighbouring tests do). (`interrupted` is Task 3's store test.)
- [ ] **Step 2: Run** `pnpm --filter @ax/routines test src/__tests__/brief.test.ts`, `… checkin.test.ts`, `… fire.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** `briefRunMiss` next to `briefRunError`. `settleWithoutTurn` adds `...(miss === null || miss === undefined ? {} : { miss })` to its outcome; the `terminated` branch passes `entry => briefRunMiss(entry, reason)`; the other calls pass nothing (`'failed'` is the store's default). The belt in `plugin.ts` passes `miss: 'brief-unconfirmed'`. `fail()` and the tick's catch stay as they are.
- [ ] **Step 4: Run** the three files, then `pnpm --filter @ax/routines test`.
- [ ] **Step 5: Commit** `feat(routines): record why a check-in failed, at the code that knows (TASK-930)`.

### Task 7: The next check-in is told it missed [tier: integration]

**Files:**
- Modify: `packages/routines/src/checkin-message.ts`, `packages/routines/src/fire.ts` (task branch's `renderCheckInMessage` call)
- Test: `packages/routines/src/__tests__/checkin-message.test.ts`, `packages/routines/src/__tests__/checkin.test.ts`

**Interfaces:**
- Consumes: `accepted.row.noRecentUpdate` (T2).
- Produces: `CheckInMessageInput.missesInARow: number`; fire.ts passes `row.noRecentUpdate?.inARow ?? 0`. The line goes right after the opening:
  - 1: `Your last check-in ended without a report. Finish this one with routine_report, even if nothing changed.`
  - n ≥ 2: `Your last ${n} check-ins ended without a report. Finish this one with routine_report, even if nothing changed.`
  - 0 (or anything not ≥ 1): no line.

- [ ] **Step 1: Write the failing tests.** `checkin-message.test.ts`: add `missesInARow: 0` to `SCHEDULED` (the exact-text test stays as is); `one miss puts the line second`, `several say how many`, `no misses, no line`. `checkin.test.ts` `a check-in after one that left no report is told so; after a report it isn't`: run-1 no report → run-2's message has the 1-miss line as its second paragraph; run-2 reports → run-3's message has no `ended without a report`.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines test src/__tests__/checkin-message.test.ts` and `… checkin.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Host text only, no agent-written text; extend the function's doc comment. If an existing exact-message `toBe` breaks, an earlier run in that test left no report: pass its `missesInARow`.
- [ ] **Step 4: Run** both files and `… fire.test.ts`.
- [ ] **Step 5: Commit** `feat(routines): a check-in hears that its last ones left no report (TASK-930)`.

### Task 8: Routines canary: the whole ladder [tier: integration]

**Files:**
- Test: `packages/routines/src/__tests__/canary.test.ts` (new describe `failure ladder canary (TASK-930)` using `createCheckInHarness` from `support/check-in.ts`)

**Interfaces:**
- Consumes: Tasks 3–7.

- [ ] **Step 1: Write the test** `check-ins that leave no report go No recent update, then Needs you at three, then paused at five; nothing runs after; a person’s Resume starts over`:
  - Create `TASK_DEFINITION` as the owner. Five `h.checkIn(task, 'run-i', async () => {})`, each followed by `expect.poll` on `routines:get`'s `noRecentUpdate?.inARow` reaching `i`.
  - Messages: run-1 has no `ended without a report`; run-2 has `Your last check-in ended without a report.`; run-5 has `Your last 4 check-ins ended without a report.`.
  - After run 3: `inARow >= TASK_NEEDS_YOU_AFTER_MISSES`, still `enabled`.
  - After run 5: `{ enabled: false, nextRunAt: null, noRecentUpdate: { inARow: 5, reason: 'no-report', autoPaused: true } }`, a new revision, the stderr line (captured).
  - Nothing runs after: `routines:fire-now` with the new revision rejects `{ toolCode: 'disabled' }`; `createRoutinesStore(h.db).recentFires(task)` still holds 5 runs.
  - The model in the owner's chat: `tool:execute:routine_list` shows the same `noRecentUpdate`; `tool:execute:routine_update { enabled: true }` rejects `{ toolCode: 'forbidden', field: 'enabled' }`.
  - The person resumes: `routines:update` `{ enabled: true }` with the new revision → `{ enabled: true, noRecentUpdate: null }`; the next check-in's message has no misses line.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines test src/__tests__/canary.test.ts` — expect PASS (if it fails, the fault is in Tasks 3–7: fix there, with a test in that task's file).
- [ ] **Step 3: Commit** `test(routines): failure ladder canary (TASK-930)`.

### Task 9: channel-web wire: rows and detail carry `noRecentUpdate` [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-types.ts`, `packages/channel-web/src/server/routes-workspace.ts` (`TaskListView`, `TaskDetailView`, `toTaskRows`, `toTaskDetail`, new `toTaskNoRecentUpdate`), `packages/channel-web/src/lib/workspace-api.ts` (`isTaskRow`, `isTaskDetail`, new `isTaskNoRecentUpdate`)
- Test: `packages/channel-web/src/__tests__/server/routes-workspace-tasks.test.ts`, `…/routes-workspace-task.test.ts`, `packages/channel-web/src/lib/__tests__/workspace-api-tasks.test.ts`, `…/workspace-api-task.test.ts`
- Fixtures forced by the wire types (add `noRecentUpdate: null`): `src/lib/__tests__/{task-groups,workspace-task,workspace-tasks}.test.ts`, `src/components/workspace/__tests__/{TaskPage,TasksPage,WorkspaceShellRouting}.test.tsx`; the exact bodies in the two route tests (`t1` `toEqual`, the detail `toStrictEqual`).

**Interfaces:**
- Consumes: `RoutineView.noRecentUpdate` (T5), `CHECK_IN_MISSES`, `CheckInMiss` (T1).
- Produces:
  ```ts
  /** A task whose latest check-ins left no report (TASK-930): host-written. */
  export interface TaskNoRecentUpdate { inARow: number; reason: CheckInMiss; at: string; autoPaused: boolean }
  // TaskRow and TaskDetail both gain: noRecentUpdate: TaskNoRecentUpdate | null;
  function toTaskNoRecentUpdate(view: Pick<RoutineView, 'noRecentUpdate'>): TaskNoRecentUpdate | null
  // field by field; reason not in CHECK_IN_MISSES → 'failed'
  ```

- [ ] **Step 1: Write the failing tests.**
  - Route (list): a stored task with `noRecentUpdate { inARow: 2, reason: 'brief-too-long', at: new Date('2026-10-22T11:00:00.000Z'), autoPausedAt: null }` → row's `noRecentUpdate` equals `{ inARow: 2, reason: 'brief-too-long', at: '2026-10-22T11:00:00.000Z', autoPaused: false }`; paused with `autoPausedAt` → `autoPaused: true`; a never-missed task → `null`; a reason the page doesn't know reads `'failed'` (deliver that view through a `routines:list` registered without `returns` for that test — the TASK-913 shape). Grouping on top of this wire is Task 10's test.
  - Route (detail): the same field on `TaskDetail`, the unknown-reason case, and the existing `toStrictEqual` gains `noRecentUpdate: null`.
  - Guards: `isTaskRow` and `isTaskDetail` accept `null` and a valid object; refuse a missing key, `inARow` `0`/`1.5`/`'2'`, an unknown reason, a non-string `at`, a non-boolean `autoPaused`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test src/__tests__/server/routes-workspace-tasks.test.ts` (and the other three files) — expect FAIL.
- [ ] **Step 3: Implement.** Add `'noRecentUpdate'` to both `Pick`s; both builders call `toTaskNoRecentUpdate(view)` — never spread the view (TASK-909 row 5). Doc comments: `toTaskRows`/`toTaskDetail` list the new field and say it holds no agent-written text. Guards check `inARow` with `Number.isInteger && >= 1` and the reason against `CHECK_IN_MISSES` (the contract's list, as `isTaskReport` uses `ROUTINE_REPORT_STATUSES`). Then the fixtures.
- [ ] **Step 4: Run** the four files, then `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit** `feat(channel-web): tasks and the task page carry a task's missed check-ins (TASK-930)`.

### Task 10: The No recent update group and its mark [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/task-groups.ts`, `packages/channel-web/src/components/workspace/bits.tsx` (`STATE_SHAPE`, `StateDot`'s `cn()` arms, the shape comment)
- Test: `packages/channel-web/src/lib/__tests__/task-groups.test.ts`, `packages/channel-web/src/__tests__/theme-contrast.test.ts`, `packages/channel-web/src/components/workspace/__tests__/StateDotSlot.test.tsx`, `packages/channel-web/src/__tests__/server/routes-workspace-tasks.test.ts` (the `see it on Tasks` canary)

**Interfaces:**
- Consumes: `TaskRow.noRecentUpdate` (T9), `TASK_NEEDS_YOU_AFTER_MISSES` (T1).
- Produces:
  ```ts
  export type TaskGroup = 'needs-you' | 'off-track' | 'no-recent-update' | 'on-track' | 'no-update' | 'paused';
  export const ACTIVE_TASK_GROUPS = ['needs-you', 'off-track', 'no-recent-update', 'on-track', 'no-update'];
  // TASK_GROUP_LABELS['no-recent-update'] = 'No recent update'
  export function missGroup(noRecentUpdate: { inARow: number }): 'needs-you' | 'no-recent-update'; // >= 3 → needs-you
  export function taskGroup(row: { enabled: boolean; task: { status: RoutineReportStatus } | null; noRecentUpdate: { inARow: number } | null }): TaskGroup;
  // order: !enabled → paused; noRecentUpdate → missGroup(...); task === null → no-update; else task.status
  // within a group: newest of (noRecentUpdate?.at ?? task?.reportedAt) first, then compareRows' existing ties
  ```

- [ ] **Step 1: Write the failing tests.** `task-groups.test.ts`: labels include `'no-recent-update': 'No recent update'`; precedence (paused beats an escalated count; 2 misses → `no-recent-update` over an on-track report; 3 → `needs-you`; misses beat "never reported"); `ACTIVE_TASK_GROUPS` order; an escalated row from 4 minutes ago sorts above a needs-you report from 3 days ago; add `noRecentUpdate: null` to the existing `taskGroup({...})` literals. `theme-contrast.test.ts`: the exact arm list gains `'StateDot.no-recent-update'` right after `'StateDot.no-update'`, and the `--state-quiet` list gains it. `StateDotSlot.test.tsx`: the sorted state list gains it; `STATE_SHAPE['no-recent-update']` equals `STATE_SHAPE.resting`; its rendered dot carries `border-state-quiet`. `routes-workspace-tasks.test.ts`, extend `see it on Tasks` (the real `routineView`): a stored task with one miss lands in `groupTasks`' `no-recent-update` group, one with three in `needs-you`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test src/lib/__tests__/task-groups.test.ts` (and the two others) — expect FAIL.
- [ ] **Step 3: Implement** with the `shadcn` skill loaded. `STATE_SHAPE['no-recent-update'] = RING`; the fill as its own arm `state === 'no-recent-update' && 'border-state-quiet'`, placed right after the `no-update` arm (the contrast parser reads arms, TASK-909 row 9). Update the shape comment ("no-recent-update ○") and `taskGroup`'s doc.
- [ ] **Step 4: Run** the three files and `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit** `feat(channel-web): a No recent update group, escalating to Needs you at three (TASK-930)`.

### Task 11: The words for each reason, and the check-in that missed [tier: mechanical]

**Files:**
- Create: `packages/channel-web/src/lib/task-miss.ts`, test `packages/channel-web/src/lib/__tests__/task-miss.test.ts`
- Modify: `packages/channel-web/src/lib/task-updates.ts` (new `missCheckIn`), test `packages/channel-web/src/lib/__tests__/task-updates.test.ts`

**Interfaces:**
- Consumes: `CheckInMiss`, `CHECK_IN_MISSES`, both thresholds (T1); `TaskNoRecentUpdate`, `TaskUpdate` (T9).
- Produces (pure; relative imports only):
  ```ts
  export function missWords(reason: CheckInMiss, agentName: string, paused: boolean): { what: string; fix: string; settingsLink: boolean };
  export function missSummary(noRecentUpdate: { inARow: number; reason: CheckInMiss }): string;
  // inARow >= 3: `Its last ${inARow} check-ins didn’t leave an update. ${what}`; else what
  export const AUTO_PAUSED_LINE: string; // `Paused after ${TASK_AUTO_PAUSE_AFTER_MISSES} check-ins in a row didn’t leave an update.`
  // task-updates.ts
  export function missCheckIn(noRecentUpdate: Pick<TaskNoRecentUpdate, 'at'> | null, updates: readonly TaskUpdate[]): string | null;
  // the entry with firedAt === at and report === null, whose conversationId is non-null and not in sharedConversationIds(updates); else null
  ```
  The table (fix running / fix paused). Fix text never mentions a link: "See what it did" and the settings link are drawn as their own elements (Task 13).

  | code | what | fix (running) | fix (paused) | settingsLink |
  |---|---|---|---|---|
  | no-report | It checked in but didn’t say how it went. | Check now tries again. | Resume it, and it’ll try again at its next check-in. | false |
  | brief-missing | Its instructions didn’t load, so it couldn’t check in. | Check now tries again. If it keeps happening, tell whoever runs your workspace. | Resume it, and it’ll try again at its next check-in. If it keeps happening, tell whoever runs your workspace. | false |
  | brief-unconfirmed | We couldn’t confirm its instructions loaded, so its check-in was marked as failed. | as brief-missing | as brief-missing | false |
  | brief-too-long | Its instructions are too long to load. | Shorten “What to do” in {agent}’s settings. | Shorten “What to do” in {agent}’s settings, then resume it. | true |
  | interrupted | The app restarted during its check-in. | Nothing to do. It’ll try again at its next check-in. | Resume it, and it’ll try again at its next check-in. | false |
  | failed | Its check-in stopped before it finished. | Check now tries again. | Resume it, and it’ll try again at its next check-in. | false |

- [ ] **Step 1: Run `ux-design`** over the table. It may reword; it may not drop a code, the running/paused split, the count sentence at ≥ 3, or U+2019/U+201C/U+201D. The tests pin the final words.
- [ ] **Step 2: Write the failing tests.** `it.each(CHECK_IN_MISSES)` exact `what`/`fix` for both `paused` values with agent `Quill`; `settingsLink` only for `brief-too-long`; `missSummary` at 2 is `what` alone, at 3 and 7 leads with the count; `AUTO_PAUSED_LINE` exact. `missCheckIn`: the entry whose `firedAt` equals `at` even when a newer entry exists; `null` when that entry reported, has no conversation, or shares one; `null` for `null` input and for no match.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-web test src/lib/__tests__/task-miss.test.ts` and `… task-updates.test.ts` — expect FAIL.
- [ ] **Step 4: Implement**; doc comment: a closed table keyed on the code, never on error text (TASK-910 row 13); host-written words only.
- [ ] **Step 5: Run** both files; **Commit** `feat(channel-web): plain words and a fix for each missed check-in (TASK-930)`.

### Task 12: Tasks page rows say why [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/workspace/TasksPage.tsx` (`TaskItem` and its doc)
- Test: `packages/channel-web/src/components/workspace/__tests__/TasksPage.test.tsx`

**Interfaces:**
- Consumes: `missSummary`, `AUTO_PAUSED_LINE` (T11); `groupTasks` (T10).
- Produces: the row's third line is, in order: `!row.enabled && row.noRecentUpdate?.autoPaused` → `AUTO_PAUSED_LINE`; `row.noRecentUpdate !== null` → `missSummary(row.noRecentUpdate)`; else the update, as today. Same element and classes (`line-clamp-2 break-words text-[13px]`, `title`). "· checked {ago}" still comes from `task.reportedAt` (the last real report).

- [ ] **Step 1: Write the failing tests** (copy verbatim, in Task 11's final words): `groups No recent update between Off track and On track, and moves three misses to Needs you`; `a row with no recent update shows why instead of its stale update` (stale update text absent; at 3 the row reads `Its last 3 check-ins didn’t leave an update. It checked in but didn’t say how it went.`); `an auto-paused task says why it’s paused, behind the paused toggle`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/TasksPage.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** with `shadcn` loaded.
- [ ] **Step 4: Run** the file; **Commit** `feat(channel-web): Tasks rows say why a task has no recent update (TASK-930)`.

### Task 13: The task page leads with the missed check-in [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/workspace/TaskPage.tsx` (`actionNote`, `LatestUpdate`, `CheckedLine`, doc comments)
- Test: `packages/channel-web/src/components/workspace/__tests__/TaskPage.test.tsx`

**Interfaces:**
- Consumes: `missWords`, `missSummary`, `AUTO_PAUSED_LINE`, `missCheckIn` (T11); `missGroup`, `TASK_GROUP_LABELS` (T10); `TaskDetail.noRecentUpdate` (T9).
- Produces:
  - `actionNote` for `!enabled && noRecentUpdate?.autoPaused`: `${AUTO_PAUSED_LINE} Fix what’s below, then Resume.` when `permissions.edit`, else `${AUTO_PAUSED_LINE} Only someone who manages this agent’s tasks can resume it.` Every other note unchanged; Resume still needs `edit`.
  - `LatestUpdate` when `noRecentUpdate !== null`, in order: `StateDot` + label for `missGroup(nru)`; `missSummary(nru)`; `missWords(reason, agentName, !enabled).fix`, then, when `settingsLink`, a link `Open ${agentName}’s settings` (`routeLinkProps({ kind: 'agent-settings', id: agentId, section: 'routines' }, onNavigate)`, the brief link's classes); the meta line `CheckedLine` with label `Last check-in` and `at = nru.at` (`· Next check …` or `· Paused`, and `· See what it did` to `{ kind: 'task-checkin', …, conversationId: missCheckIn(nru, updates) }` when non-null); then, when `task !== null`, one muted line `Last update ${checkInWhen(task.reportedAt, now)}: ${task.update}` (`Last update: …` when the time can't be read; `CANT_SHOW` for an unreadable update). The stale ask is not shown in this state (decisions row 15). With `noRecentUpdate === null` the card is unchanged.
  - `CheckedLine` takes `label: 'Checked' | 'Last check-in'` and `at` (was `reportedAt`).

- [ ] **Step 1: Run `ux-design`** over the new lines (`Last check-in`, `Last update`, `Open {agent}’s settings`, the two auto-paused notes); the tests pin the result.
- [ ] **Step 2: Write the failing tests** (copy verbatim, in Task 11's and Step 1's final words): `a check-in that left no report leads with No recent update, the reason and the fix, then the last update, muted`; `three in a row read Needs you with the count`; `See what it did opens the check-in that missed, not a newer one`, and is absent when that entry has no conversation; `a too-long brief points at the agent’s settings`; `a paused task’s fix says to resume, never Check now`; `an auto-paused task says why it’s paused and how to resume`, with the `edit: false` variant; `Resume on an auto-paused task sends enabled true and reads the task again`; `a miss time it can’t read shows no time, never Invalid Date`.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/TaskPage.test.tsx` — expect FAIL.
- [ ] **Step 4: Implement** with `shadcn` loaded; text is React text only (agent-written `update` already fenced server-side).
- [ ] **Step 5: Run** the file, `pnpm --filter @ax/channel-web test`, `pnpm --filter @ax/channel-web exec tsc --build`; **Commit** `feat(channel-web): the task page shows a missed check-in's reason and fix (TASK-930)`.

### Task 14: Docs: the lines this PR makes stale [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`

- [ ] **Step 1: Edit.**
  - §3.6, after the PR 1 paragraph (line 276, the rule-5 fix): a `PR 2 (TASK-930):` note — a check-in that finishes without a report (any status) counts; a report resets; 1–2 show ○ No recent update with the reason and a fix, 3+ ◆ Needs you, 5 pause the task (not enabled, new revision); only a person's Resume or a kind change starts the count over; the agent's `routine_update` can't resume a paused task; the six reason codes.
  - §4.5 Task state row: after "failures in a row" add "(TASK-930: check-ins in a row without a report, the last one's reason and start, and when the host paused it)".
  - §7 cost bullet: "five check-ins in a row that end without a report pause the task, and only a person's Resume starts the count over (TASK-930)".
  - §13: "task state on `routines:list` and `routines:get`" → add "and `noRecentUpdate` (TASK-930)".
  - §15: rows for decisions 2, 3, 5, 8 and 12 of the shard, in the table's voice.
- [ ] **Step 2: Run** `pnpm test:scripts` (memory-citation and doc checks).
- [ ] **Step 3: Commit** `docs(agent-tasks): the failure ladder as built (TASK-930)`.

---

## YAGNI cuts (each considered and left out)

A structured log line for auto-pause (stderr with ids, as TASK-907 row 41); a new `SafeToolCode` for the refusal; widening `isOwnTask` with `noRecentUpdate`; plain-word reasons on each Updates entry (card: later); the stale ask in the miss state; a Settings UI for misses; "Leave paused"/dismiss; email; Today rows (TASK-933); a CHECK on the count; a new hook or dependency.

## Conflict risks

- **TASK-931 (replies), not yet branched:** also takes schema version 7 (whoever merges second renumbers to 8 and updates `migrations.test.ts`'s version lists); edits `checkin-message.ts` (keep: opening, misses line, notes, replies, reports), `fire.ts`'s task branch, `TaskPage.tsx` `LatestUpdate` (its Reply button sits after the ask, which this PR hides in the miss state), `toTaskDetail`/`TaskDetail`/`isTaskDetail`, `task-updates.ts`. Rebase on whichever lands first.
- **TASK-932 (in flight):** shares `store.ts` (new `tasksForConversations`; likely the `RoutinesStore` interface tail), `services.ts` (`ROUTINE_SERVICES` + a register; `return-schemas.test.ts` count 17→18 is theirs), `canary.test.ts` (both append describes), `routes-workspace.ts` (`decisions()`/`projectDecision`, disjoint from `toTaskRows`/`toTaskDetail`), `workspace-types.ts` and `workspace-api.ts` (`Decision.checkIn`/`isDecisionRecord`, disjoint). Textual rebases only.
- **TASK-933 consumes:** `TaskRow.noRecentUpdate { inARow, reason, at, autoPaused }`, `missSummary`, `missWords(...).what` (signature `(reason, agentName, paused)`, not the card's `(reason, inARow, agentName)`), `AUTO_PAUSED_LINE`, `taskGroup`/`missGroup`, `TASK_NEEDS_YOU_AFTER_MISSES`. Its card's "what, plus Its last N…" is `missSummary`.
