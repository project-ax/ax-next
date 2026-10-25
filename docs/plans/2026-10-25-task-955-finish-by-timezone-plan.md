# TASK-955: Count Finish by days in the person's time zone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Get something done" task with no time zone of its own counts the days to its Finish by date on the calendar of the person who set the date, not on UTC's. So a person in Los Angeles who sets "today" at 5:30 pm sees "Due today", and the check-in's brief says "finished today", in the evening as well.

**Architecture:** One function already decides which calendar every surface counts on: `taskTimeZone` in `@ax/routines-contract`. The brief (`packages/routines/src/brief.ts:217`) and the host's count for the Tasks row, the task page and the PUT answer (`toTaskFinishBy`, `packages/channel-web/src/server/routes-workspace.ts:3713-3726`) both call it. This card stores the zone the person's browser reports with the date, in a new `finish_by_time_zone` column at schema version 14. It carries that zone through the hook, the stored row and every routine view as `finishByTimeZone`, and makes it `taskTimeZone`'s third choice, after the task's own zone and before UTC. The browser never computes a count, and the zone never crosses back to it.

**Tech Stack:** TypeScript, zod 3, Kysely on Postgres (testcontainers), vitest, React (channel-web, jsdom tests).

**Spec:** card TASK-955 (acceptance quoted below). Design: `docs/plans/2026-10-20-agent-tasks-design.md` (the TASK-951 paragraph at :272). Predecessor: `docs/plans/2026-10-24-task-951-finish-by-plan.md`, `.claude/memory/decisions/2026-10-24-TASK-951.md` (rows 12-17, 22 and 31; row 31 is the review finding this card answers), and `.claude/memory/patterns/2026-10-24-TASK-951.md` row 1. Decisions for this card: `.claude/memory/decisions/2026-10-25-TASK-955.md`.

**Card acceptance (verbatim):**
- Contract and service: `routines:set-finish-by` accepts and validates the zone and refuses one that isn't IANA.
- Brief test: a zoneless task whose date was set from America/Los_Angeles at 17:30 local on day D reads "today" (0 days), not -1, at a check-in accepted at 01:00 UTC on D+1.
- channel-web: the row and page show the same count as the brief at the boundary.
- `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

## Global Constraints

- **Which calendar counts:** the cron's `tz` → else the active hours' `tz` → else the stored `finishByTimeZone` → else `'UTC'`. This lives in one place, `taskTimeZone` (`packages/routines-contract/src/finish-by.ts`). Never re-derive it elsewhere. (Decisions row 2: the task's own zone wins. That is the card's call, flagged for Vinay in the handoff.)
- **Which zones are allowed:** the existing `RoutineTimezoneSchema` (`packages/routines-contract/src/definition.ts:52`: 1-256 characters that this runtime's `Intl.DateTimeFormat` accepts). Never add a second zone rule. The value is stored as sent, not canonicalized.
- **Names:** `finishByTimeZone` on the hook surface (service input, service output, `StoredRoutine`, every routine view). The column is `finish_by_time_zone`. The PUT body field is `timeZone`. The wire type `TaskFinishBy` stays `{ date, daysLeft }`.
- **The zone lives only beside a date.** Only `setFinishBy` writes it. Removing the date clears it. A change of kind clears both. A change of owner, or any other edit, keeps both. Duplicate and receipts carry neither. No tool or IPC action can reach it: the strict tool and definition schemas already refuse an unknown key.
- **Logs** carry ids and flags only, never the date and never the zone.
- **Schema version 14**, or the next free number at rebase (decisions row 16).
- **Rebuild the contract before testing another package.** vitest loads `@ax/routines-contract` from its built `dist/`. After any contract change, run `pnpm --filter @ax/routines-contract build` before running routines, routines-admin-routes or channel-web tests (TASK-951 decisions row 30).
- **Docker.** `@ax/routines` and `@ax/routines-admin-routes` (its `human-rest-integration.test.ts`) start Postgres containers, so set `DOCKER_HOST` (CLAUDE.md "Docker-backed tests"). If Docker hangs, follow the card's dispatch notes: use the local Postgres stand-in on :55439 and drop every database you create.
- **`pnpm --filter` goes before the script.** The full gate is `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
- **Commit first.** Commit this plan and the decisions shard before running `pnpm test:scripts`: its cited-paths guard fails on a memory shard that cites an untracked file.
- **No new UI, copy, dependency, hook, route or Settings control.** Invariant 6 doesn't apply: no component changes its markup.
- **No backslash-u escapes in tests or docs.** The Write tool has turned them into raw characters seven times (`.claude/memory/mistakes/2026-10-24-TASK-951.md`). This card needs none: every zone is ASCII.

## Questions answered (planner, self-answered from code and memory)

1. **Where is "today" computed, for each surface?** There is one place per side, and both go through `taskTimeZone`.
   - Brief: `checkInBrief` → `renderTaskBrief(entry.row, calendarDateIn(entry.acceptedAt, taskTimeZone(entry.row)))` (`brief.ts:217`). `entry.row` is the `StoredRoutine` read under the row lock at accept (`acceptDispatch` → `rowToRoutine`). It has the trigger and the active hours, and after Task 2 it has the stored zone too.
   - Tasks row, task page and the PUT answer: all three call `toTaskFinishBy(view, now)` (`routes-workspace.ts:3713`). It reads `view.trigger` and `view.activeHours` today, and after Task 3 it reads `view.finishByTimeZone` too.
   - The browser computes only `browserToday()`, for the date field's `min` and the "not in the past" check (`lib/task-finish-by.ts:46-64`). `lib/task-finish-by.ts` only puts the host's count into words (`finishByCount`). So the card's "the page and row use the same count, in channel-web's `lib/task-finish-by.ts`" is refined: the count is the host's (decisions row 1).
2. **Store the zone? Yes,** at schema version 14, in a nullable `finish_by_time_zone TEXT` column. There is no CHECK, for two reasons: a format CHECK can't say "a zone `Intl` knows", and a coupling CHECK would break rollback (decisions row 3). The zone flows as follows:
   - The browser sends `timeZone`.
   - The PUT route passes it on as `finishByTimeZone` when this host's `Intl` can use it. Otherwise it drops it and logs a warn line (decisions row 9).
   - `routines:set-finish-by` validates it with `RoutineTimezoneSchema.nullable().optional()`.
   - `store.setFinishBy` writes it beside the date.
   - `rowToRoutine` reads it back through the same rule. It reads as null without a date.
   - Every routine view carries it (it is null unless the task is get-done).
   - The BFF counts with it, and the service's answer echoes it.
   - **Validating safely and with a bound:** `RoutineTimezoneSchema` refuses an empty string or one over 256 characters. Anything `Intl` doesn't know makes it throw `RangeError`, which `validTimezone` catches.
     - zod 3.25.76 still runs the refinement after `max` fails (MEASURED: the issues are `too_big` and `custom`), so `Intl` does see a long string.
     - The 1 MiB body cap (`MAX_BODY_BYTES`, `packages/http-server/src/types.ts:214`; the route sets no larger one) bounds that, and `Intl` refuses a 1 MB string in about 9 ms (MEASURED, Node 24.19).
     - This is the same rule, with the same cost, as a cron's `tz`. There's no extra length pre-check.
     - The MEASURED zone values are in decisions row 4.
3. **Which source wins?** The task's own zone. The card says so. The cron's times are written in that zone. Every task that has a zone keeps TASK-951's count. `RoutineEditor` defaults both zones to the browser's. Recorded in decisions row 2, with the alternative (the person's zone first) flagged for Vinay.
4. **The brief's acceptance test:** the triple below, in `brief.test.ts`, with a no-zone control that still says "1 day ago". Two more tests go through the real store: the seam test in `fire.test.ts` and the canary.
5. **channel-web:** the row and the page already share `toTaskFinishBy`, and channel-web already imports `@ax/routines-contract` in both its client (`lib/task-finish-by.ts:18`) and its server (`routes-workspace.ts:182-188`). So no new import edge is needed and invariant 2 holds. The row and page tests use the same triple as the brief's test.
6. **Boundary review:** `finishByTimeZone` is domain vocabulary, an IANA or ECMA-402 zone id, and doesn't leak anything. The answers for the PR description are in decisions row 15 and in Task 5.
7. **Pins to update:**
   - `return-schemas.test.ts`: the view and the set-finish-by output.
   - `routines-admin-routes` `VIEW_KEYS`.
   - The routine_update sentence, pinned in three tests.
   - The 21 `[2, …, 13]` version lists in `migrations.test.ts`.
   - Every `toStrictEqual({ finishBy })` on a set-finish-by answer.
   - Unchanged: `ROUTINE_SERVICES` (no new hook), the manifest, the preset and the route-registration pins (no new route).

## Review Focus

1. **A browser that can't tell its zone** (`resolvedOptions().timeZone` is `'Etc/Unknown'`, empty or undefined). The date still saves, with no zone, and counts on UTC. Pinned in Task 4: `browserTimeZone` and the TaskFinishDate test.
2. **A browser zone this host's `Intl` doesn't know** (the browser has newer time-zone data than the host). The date still saves, without the zone, counts on UTC, and leaves one ids-only warn line. Pinned in Task 4: the route test.
3. **The schedule changes after the date was set** (an interval task gets a Tokyo cron, then goes back to an interval). The date and its zone stay, and the count follows the precedence without a re-save. Pinned in Task 2 (a schedule edit keeps both) and Task 3 (the precedence table).
4. **Saving the date again from another zone, then removing it.** The newer zone replaces the older one, and Remove date clears both. Pinned in Task 2 (store and service).
5. **A stored zone that no longer reads** (a hand edit, or a host with older time-zone data), or a stray zone with no date. It reads as none. The brief doesn't throw, the tick isn't stopped, and the page still shows the date counted on UTC. Pinned in Task 2 (store reads) and Task 3 (the BFF's lenient read).

## The boundary triple (used by every test that checks the card's acceptance)

| What | Value |
|---|---|
| Day D (a Sunday) | `'2026-10-25'`, spelled by the brief as `Sunday, 25 October 2026` |
| Zone it was set from | `'America/Los_Angeles'`. 17:30 PDT on D is `2026-10-26T00:30:00Z`. |
| The check-in / "now" | `2026-10-26T01:00:00Z`, which is 18:00 PDT on D. LA's calendar says `2026-10-25` (0 days). UTC's says `2026-10-26` (−1). |
| Precedence control | `'Asia/Tokyo'` is already on `2026-10-26` at that instant (−1). `'America/New_York'` is on `2026-10-25` (0). |

These are MEASURED on Node 24.19.0 with ICU 78.3 and tzdata 2026b. The brief's lines at the boundary:
- With the zone: `The person wants this finished today (Sunday, 25 October 2026).`
- On UTC (no zone, or a Tokyo schedule): `The person wanted this finished by Sunday, 25 October 2026, 1 day ago.`

## Files

- `packages/routines/src/migrations.ts`: the row type, version 14 and `addFinishByTimeZoneColumn` (Task 1).
- `packages/routines-contract/src/services.ts`: the set-finish-by input and output (Task 2).
- `packages/routines-contract/src/finish-by.ts`: `taskTimeZone` and its docs (Task 3).
- `packages/routines-contract/src/definition.ts`: `RoutineViewShape.finishByTimeZone` (Task 3).
- `packages/routines-contract/src/tools.ts`: three tool descriptions (Task 3).
- `packages/routines/src/types.ts`, `definition.ts`, `store.ts`, `services.ts`: the stored field, reading it back, writing it, receipts, and the view (Tasks 2 and 3).
- `packages/routines/src/brief.ts` and `tools.ts`: docs only (Task 3).
- `packages/routines-admin-routes/src/routes.ts`: the `settingsView` doc (Task 3).
- `packages/channel-web/src/server/routes-workspace.ts`: the view Picks, `toTaskFinishBy` and the PUT answer (Task 3), then the PUT body and the zone check (Task 4).
- `packages/channel-web/src/lib/task-finish-by.ts`, `lib/workspace-api.ts`, `components/workspace/TaskFinishDate.tsx`: the browser sends its zone (Task 4). `lib/workspace-types.ts` and `TaskPage.tsx`: docs (Task 3).
- `docs/plans/2026-10-20-agent-tasks-design.md` and `.claude/memory/patterns/2026-10-25-TASK-955.md`: Task 5.
- Tests: listed in each task.

---

### Task 1: Schema version 14, a column for the zone a finish date was set from [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/migrations.ts`. Three places: the `RoutinesDefinitionsRow` type after `finish_by` (:106-113); `runRoutinesMigration`, after the `done(13)` block (:315-318); and a new `addFinishByTimeZoneColumn` after `addFinishByColumn` (:339-354).
- Test: `packages/routines/src/__tests__/migrations.test.ts`.

**Interfaces:**
- Consumes: nothing new.
- Produces: the column `routines_v1_definitions.finish_by_time_zone TEXT NULL`, and the row type `finish_by_time_zone: ColumnType<string | null, string | null | undefined, string | null>`. Task 2 reads and writes it.

- [ ] **Step 1: Write the failing test.** In `migrations.test.ts`:
  - Replace every `[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]` with `[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]`. There are 21 of them; `grep -c` must print 21 before and 0 after.
  - After the version-13 test (:384-406), add `it('version 14 gives a finish date the zone it was set from, nullable with no default or check; a re-run keeps every value (TASK-955)')`. Copy the version-13 test's shape:
    - `runRoutinesMigration(db)`, then `ALTER TABLE routines_v1_definitions DROP COLUMN IF EXISTS finish_by_time_zone`, then `DELETE FROM routines_schema_versions WHERE version = 14`, then `insertTask()` (a version-13 row), then run the migration twice.
    - `versions()` equals the list ending in 14.
    - `information_schema.columns` for `finish_by_time_zone` equals `[{ column_name: 'finish_by_time_zone', data_type: 'text', is_nullable: 'YES', column_default: null }]`.
    - The existing row reads `[{ finish_by_time_zone: null }]`.
    - `UPDATE … SET finish_by = '2026-10-25', finish_by_time_zone = 'America/Los_Angeles'`, delete version 14, run again. The row still reads `{ finish_by: '2026-10-25', finish_by_time_zone: 'America/Los_Angeles' }`.
    - No CHECK: `insertTask(sql\`,finish_by_time_zone\`, sql\`,'Not/AZone'\`, 'r_odd_zone')` resolves, because the read, not the database, refuses an unknown zone (Task 2). So does `insertTask(sql\`,finish_by_time_zone\`, sql\`,'America/Los_Angeles'\`, 'r_zone_no_date')` with no `finish_by`. Note that `finish_by IS NULL` must be allowed there, for rollback.
- [ ] **Step 2: Run it and watch it fail.** Run `pnpm --filter @ax/routines exec vitest run src/__tests__/migrations.test.ts`. Expected: FAIL. The version lists lack 14, and the column doesn't exist.
- [ ] **Step 3: Implement.**
  - Add the row-type field, with a doc in the style of the `finish_by` doc: "Version 14 (TASK-955). The time zone a get-done task's finish date was set from … written only by `setFinishBy` beside the date; NULL when the browser sent none and whenever there is no date; read through the contract's zone rule (`storedFinishByTimeZone`, store.ts)".
  - Add `if (!await done(14)) { await addFinishByTimeZoneColumn(trx); await sql\`INSERT INTO routines_schema_versions (version) VALUES (14)\`.execute(trx); }`.
  - Add `addFinishByTimeZoneColumn(db)`, whose body is one `ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS finish_by_time_zone TEXT`. Its doc must say:
    - why there is no format CHECK: SQL can't say "a zone `Intl` knows", so the writer and every read apply `RoutineTimezoneSchema`;
    - why there is no coupling CHECK with `finish_by`: code before version 14 clears the date alone, so its Remove date and its change of kind must still succeed after a rollback;
    - that there is no backfill: existing dates read NULL and keep counting on UTC until they are saved again;
    - that rollback is safe: older code never names the column; a date it sets keeps whatever zone the row held; a zone it leaves without a date is ignored on read.
- [ ] **Step 4: Run it and watch it pass.** The same command. Expected: PASS, every test in the file.
- [ ] **Step 5: Commit.** `git add packages/routines/src/migrations.ts packages/routines/src/__tests__/migrations.test.ts && git commit -m "[TASK-955] routines: schema version 14, a finish date's time zone column"`.

---

### Task 2: `routines:set-finish-by` takes, stores and answers the zone [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/routines-contract/src/services.ts:81-88`, the set-finish-by input and output and their doc.
- Modify: `packages/routines/src/types.ts:55-61`, adding `StoredRoutine.finishByTimeZone` after `finishBy`.
- Modify: `packages/routines/src/definition.ts:81-85`, adding `StoredRoutineSchema.finishByTimeZone: z.string().nullable().default(null)` with the same comment shape as `finishBy`.
- Modify: `packages/routines/src/store.ts`:
  - the `setFinishBy` interface and its doc (:78-94);
  - `NO_FINISH_BY` and its doc (:459-464), plus the `NO_TASK_STATE` doc's TASK-951 paragraph (:446-448);
  - a new `storedFinishByTimeZone` next to `storedFinishBy` (:640-650);
  - `rowToRoutine` (:665-673);
  - the `receiptCopy` doc and `withoutTaskState` (:725-756);
  - the `setFinishBy` implementation (:1202-1219).
- Modify: `packages/routines/src/services.ts:385-401`, the `set-finish-by` registration and its comment.
- Test: `packages/routines-contract/src/__tests__/finish-by.test.ts`, `packages/routines/src/__tests__/finish-by-store.test.ts`, `packages/routines/src/__tests__/finish-by.test.ts`, plus the fixture sweep below.

**Interfaces:**
- Consumes: the column from Task 1.
- Produces:
  - `RoutineSetFinishByInputSchema = RoutineKeySchema.extend({ finishBy: RoutineFinishBySchema.nullable(), finishByTimeZone: RoutineTimezoneSchema.nullable().optional() }).strict()`. Absent or null means none.
  - `RoutineSetFinishByOutputSchema = z.object({ finishBy: z.string().nullable(), finishByTimeZone: z.string().nullable() }).strict()`.
  - `StoredRoutine.finishByTimeZone: string | null`, required.
  - `RoutinesStore.setFinishBy(input: RoutineKey & Actor & { finishBy: string | null; finishByTimeZone: string | null }): Promise<{ finishBy: string | null; finishByTimeZone: string | null } | 'not-found' | 'forbidden'>`.
  - No view carries the zone yet. `routineView` builds field by field, so the new `StoredRoutine` field doesn't reach a view until Task 3.

- [ ] **Step 1: Write the failing contract tests** in `routines-contract/src/__tests__/finish-by.test.ts`, inside `describe('routines:set-finish-by (TASK-951)')`.
  - `it('takes the time zone the date was set from, and refuses anything that isn\'t a zone (TASK-955)')`:
    - It accepts `{ ...key, finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' }` unchanged, and the same with `'+05:30'` and with `'america/los_angeles'`, which is kept as sent.
    - It accepts `{ ...key, finishBy: null, finishByTimeZone: null }` and `{ ...key, finishBy: '2026-10-25' }`.
    - It refuses each of these as `finishByTimeZone`: `'Not/AZone'`, `'Etc/Unknown'`, `''`, `' America/Los_Angeles'`, `'x'.repeat(257)`, `5`. Use `.safeParse(...).success === false` with the input as the message.
  - Rename `'answers only the date, or null'` to `'answers the date and the zone it was set from, or nulls'`.
    - It parses `{ finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' }` and `{ finishBy: null, finishByTimeZone: null }`.
    - It refuses `{ finishBy: null }` (key missing) and `{ finishBy: null, finishByTimeZone: null, revision: 'r' }`.
  - Extend `'the strict create and patch schemas refuse a finishBy key'`: the same refusals hold with `finishByTimeZone: 'America/Los_Angeles'` instead of `finishBy`, for create, patch, `RoutineDefinitionSchema` and `RoutinePatchSchema`. No tool can set it.
- [ ] **Step 2: Write the failing store tests** in `routines/src/__tests__/finish-by-store.test.ts`.
  - Update the local helper so it passes a zone: `setFinishBy = (routineId, finishBy, actorUserId = 'owner', finishByTimeZone: string | null = null) => f.store.setFinishBy({ agentId: 'a', routineId, actorUserId, finishBy, finishByTimeZone })`. Every existing answer assertion becomes `{ finishBy: X, finishByTimeZone: null }`.
  - `it('stores the zone sent with a date beside it, and removing the date clears both (TASK-955)')`:
    - `setFinishBy(id, '2026-10-25', 'owner', 'America/Los_Angeles')` answers `{ finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' }`.
    - `findOne`, `list` and `acceptDispatch(...).accepted.row` all carry `finishByTimeZone: 'America/Los_Angeles'`.
    - The column holds it.
    - `setFinishBy(id, null, 'owner', 'America/Los_Angeles')` answers `{ finishBy: null, finishByTimeZone: null }`, and both columns are NULL.
    - `setFinishBy(id, '2026-10-25', 'owner', null)` stores a NULL zone.
  - `it('a date saved again from another zone takes the new zone (TASK-955)')`: save with LA, then with `'Asia/Tokyo'`. The answer and `findOne` say Tokyo.
  - `it('a caller that leaves the zone out stores none, even over an earlier one (TASK-955)')`: save with LA, then `f.store.setFinishBy({ agentId: 'a', routineId: id, actorUserId: 'owner', finishBy: '2026-10-26' } as never)`. The column is NULL. This pins the `?? null` (decisions row 11: Kysely drops `undefined` from `set`).
  - Extend `'a change of kind clears it in the edit itself; a change of owner keeps it'` (:80-108). Set both dates with `'America/Los_Angeles'`.
    - Between `described` (:86) and the kind change, add a schedule-only edit: `const scheduled = await edit('schedule', described.revision, { trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Tokyo' } })`. It `toMatchObject`s `{ finishBy: '2026-11-14', finishByTimeZone: 'America/Los_Angeles' }`. The kind change then uses `scheduled.revision`.
    - After the kind change (:88-91) and after the change back (:93-95), `finishByTimeZone` is null and the `finish_by_time_zone` column is NULL.
    - After the owner move (:104), `findOne(other)` also matches `finishByTimeZone: 'America/Los_Angeles'`. The new owner's own save (:107) answers `{ finishBy: '2026-12-01', finishByTimeZone: null }`.
  - `it('a stored zone this runtime doesn\'t know, or one beside no date, reads as none, and no read throws (TASK-955)')`:
    - Hand-edit `finish_by_time_zone = 'Mars/Olympus_Mons'`. Then `findOne`/`list` give `finishBy: '2026-11-14', finishByTimeZone: null`, and `claimDue` (as the existing lenient-read test calls it) resolves.
    - Hand-edit `finish_by = NULL, finish_by_time_zone = 'America/Los_Angeles'`. Then `finishByTimeZone` is null.
  - Extend `'a receipt leaves the date out…'` (:142-164) with the new key, in the same shapes as its `finishBy` assertions. Set its date with `'America/Los_Angeles'`, so the live answers at :147 and :150 also carry the zone:
    - No receipt's `result` or `result->'row'` has a `finishByTimeZone` key: add it to the SQL `?` checks.
    - A receipt still parses under a schema without both fields: `StoredRoutineSchema.innerType().omit({ finishBy: true, finishByTimeZone: true })`.
    - `updateAuthored`'s replay and `acceptDispatch`'s replay answer `finishByTimeZone: null`.
- [ ] **Step 3: Write the failing service tests** in `routines/src/__tests__/finish-by.test.ts`.
  - `it('the owner sets a date with the zone it was set from; the answer and the row carry it (TASK-955)')`:
    - `setFinishBy(h.owner, { ...key(task), finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' })` `toStrictEqual`s `{ finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' }`.
    - SQL reads `finish_by_time_zone = 'America/Los_Angeles'`.
    - The revision is unchanged.
  - `it('a zone that isn\'t one is refused before anything is written (TASK-955)')`: use the shape of the existing `'a date that isn\'t real…'` test (:116), with `finishByTimeZone` set to `'Not/AZone'`, `'Etc/Unknown'`, `''` and `'x'.repeat(257)`. Each rejects `toMatchObject({ toolCode: 'validation' })`, `agents:resolve` is never called, and both columns stay NULL.
  - Update every existing `toStrictEqual({ finishBy: … })` on a set-finish-by answer to add `finishByTimeZone: null`.
  - In the log-line test (:141), also send `finishByTimeZone: 'America/Los_Angeles'` on the first call, and assert `JSON.stringify(info.mock.calls)` contains neither `DATE` nor `'Los_Angeles'`. The line itself stays `{ agentId, routineId, cleared }`.
- [ ] **Step 4: Run the tests and watch them fail.**
  - `pnpm --filter @ax/routines-contract test`: FAIL. The schemas don't know `finishByTimeZone`.
  - `pnpm --filter @ax/routines-contract build && pnpm --filter @ax/routines exec vitest run src/__tests__/finish-by-store.test.ts src/__tests__/finish-by.test.ts`: FAIL.
- [ ] **Step 5: Implement.**
  - **Contract:** the two schemas above. Import `RoutineTimezoneSchema` from `./definition.js`. The doc names the zone ("the time zone the person's browser reported when they set the date; absent or null when it reported none") and points at `taskTimeZone` for how it counts.
  - **`store.ts`:**
    - `import { RoutineTimezoneSchema } …` from the contract.
    - `function storedFinishByTimeZone(finishBy: string | null, value: string | null): string | null`. It returns `value` only when `finishBy !== null && RoutineTimezoneSchema.safeParse(value).success`, else null. Its doc: the date's rule, applied to its zone (TASK-913). An unknown zone would make `calendarDateIn` throw mid-brief.
    - `rowToRoutine`: compute `const finishBy = storedFinishBy(row.finish_by)` once, then pass `finishBy` and `finishByTimeZone: storedFinishByTimeZone(finishBy, row.finish_by_time_zone)`.
    - `NO_FINISH_BY = { finish_by: null, finish_by_time_zone: null } as const`.
    - Drop `finishByTimeZone` in `withoutTaskState`, in its destructure and in its `Omit<…>`.
    - The `receiptCopy` doc says "All six keys" and adds a TASK-955 line: "so does the zone the date was set from, for the same reason".
    - `setFinishBy` writes `set({ finish_by: input.finishBy, finish_by_time_zone: zone })`, where `const zone = input.finishBy === null ? null : (input.finishByTimeZone ?? null)`, and answers `{ finishBy: input.finishBy, finishByTimeZone: zone }`. Keep a one-line comment on the `?? null` (Kysely drops `undefined` from `set`).
    - Update the interface doc and the `NO_TASK_STATE` / `NO_FINISH_BY` docs: a change of kind clears the date and its zone, and a change of owner keeps both.
  - **`services.ts`:** pass `finishByTimeZone: input.finishByTimeZone ?? null` and return `{ finishBy: outcome.finishBy, finishByTimeZone: outcome.finishByTimeZone }`. In the comment, change "The input schema checked the date" to "The input schema checked the date and its zone (`RoutineTimezoneSchema`)", and say the log line carries neither.
  - **`types.ts` doc:** "TASK-955. The time zone `finishBy` was set from, as the person's browser reported it: null when it reported none, when there is no date, and when the stored value isn't a zone this runtime knows. Counted only when the task has no zone of its own (`taskTimeZone`)."
- [ ] **Step 6: The fixture sweep.** Add `finishByTimeZone: null` beside `finishBy` in every typed `StoredRoutine` literal. Add `finishByTimeZone` to every set-finish-by answer assertion and every fake. The list is in "Fixture sweep, Task 2" below. Then, to catch anything the list missed:
  - `pnpm --filter @ax/channel-web build` (it type-checks its tests);
  - `git grep -n "setFinishBy(\|'routines:set-finish-by'" -- 'packages/**/__tests__/**'`;
  - `git grep -n "finishBy: null, done" -- 'packages/**/__tests__/**' 'packages/**/routine-fixture.ts'`.
- [ ] **Step 7: Run the suites and watch them pass.** `pnpm --filter @ax/routines-contract build && pnpm --filter @ax/routines-contract test && pnpm --filter @ax/routines test && pnpm --filter @ax/channel-web build && pnpm --filter @ax/channel-web test`. Expected: all PASS.
- [ ] **Step 8: Commit.** `[TASK-955] routines:set-finish-by takes, stores and answers the zone a date was set from`.

---

### Task 3: Count in that zone: the brief, the Tasks row and the task page agree [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/routines-contract/src/finish-by.ts`: `taskTimeZone` (:62-70) and the module header (:20-23).
- Modify: `packages/routines-contract/src/definition.ts`: `RoutineViewShape`, adding `finishByTimeZone` after `finishBy` (:754-763).
- Modify: `packages/routines-contract/src/tools.ts:297-300`: the `routine_list`, `routine_get` and `routine_update` descriptions.
- Modify: `packages/routines/src/services.ts`: `routineView` (:35-45), and a new `finishByTimeZoneView` next to `finishByView` (:103-115) with its doc.
- Modify: `packages/routines/src/brief.ts:9-15` and `:122-141` (docs only), and `packages/routines/src/tools.ts:205-219` (the `listToolView` doc).
- Modify: `packages/routines-admin-routes/src/routes.ts:91-102` (the `settingsView` doc).
- Modify: `packages/channel-web/src/server/routes-workspace.ts`:
  - the Picks `TaskListView` (:790-804) and `TaskDetailView` (:815-831);
  - `TaskSetFinishByOutput` (:899);
  - `toTaskFinishBy` (:3699-3726);
  - the PUT answer (:7955-7959);
  - the docs at :3549-3552, :3929-3931 and :7899-7901.
- Modify, docs only: `packages/channel-web/src/lib/workspace-types.ts:1404-1410`, `lib/task-finish-by.ts:6-12` and `components/workspace/TaskPage.tsx:40-45`.
- Test:
  - `routines-contract/src/__tests__/finish-by.test.ts`;
  - `routines/src/__tests__/brief.test.ts`, `fire.test.ts`, `canary.test.ts`, `return-schemas.test.ts` and `finish-by.test.ts`;
  - `routines-admin-routes/src/__tests__/routes.test.ts`;
  - `channel-web/src/__tests__/server/routes-workspace-tasks.test.ts` and `routes-workspace-task.test.ts`;
  - plus the fixture sweep below.

**Interfaces:**
- Consumes: `StoredRoutine.finishByTimeZone` and the store and service from Task 2.
- Produces:
  - `taskTimeZone(row: { trigger: RoutineTrigger; activeHours: ActiveHours | null; finishByTimeZone: string | null }): string`. The parameter is required (decisions row 7).
  - `RoutineViewShape.finishByTimeZone: z.string().nullable()`. Required, a type only, in every view, the tools' included.
  - `TaskSetFinishByOutput = Pick<RoutineSetFinishByOutput, 'finishBy' | 'finishByTimeZone'>`.

- [ ] **Step 1: Write the failing contract tests.**
  - In `describe("a task's calendar (TASK-951)")`, rename `'runs on the cron’s zone, else the active hours’, else UTC'` to `'runs on the cron’s zone, else the active hours’, else the zone its date was set from, else UTC (TASK-955)'`. Pass `finishByTimeZone: 'America/Los_Angeles'` to the existing three calls. They still answer `'America/New_York'` and `'Asia/Tokyo'`, so the task's own zone wins. The third becomes `'America/Los_Angeles'`. Add a fourth call, `{ trigger: interval, activeHours: null, finishByTimeZone: null }` → `'UTC'`.
  - Extend the descriptions test (:150):
    - `routine_list` and `routine_get` contain `'finishBy is the date the person wants a "get-done" task finished by, or null. Only the person sets it. finishByTimeZone is the time zone they set it from, or null.'`
    - `routine_update` contains `'A retry of an edit that already went through answers with task, noRecentUpdate, finishBy, finishByTimeZone and done null, so read the task with routine_get.'`
    - The same routine_update sentence is pinned in `routines-contract/src/__tests__/done.test.ts:118` and `report.test.ts:262`. Update both.
- [ ] **Step 2: Write the failing brief tests** in `routines/src/__tests__/brief.test.ts`.
  - Add `finishByTimeZone: null` to `storedRow` (:169-175).
  - Rename the test at :403 to `'a task with an interval, no active hours and no zone stored with its date counts on UTC’s calendar'`. Its body is unchanged.
  - Add `it('a zoneless task counts on the calendar its date was set from: "today", not 1 day ago, at 01:00 UTC the next day (TASK-955)')`, the card's acceptance:
    - The row is `{ ...storedRow({ ...TASK, kind: 'get-done', trigger: { kind: 'interval', every: '1h' } }), finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' }`.
    - `acceptedAt` is `new Date('2026-10-26T01:00:00Z')`.
    - The brief contains `'The person wants this finished today (Sunday, 25 October 2026).'` and does not contain `'1 day ago'`.
    - The control is the same row with `finishByTimeZone: null`. Its brief contains `'The person wanted this finished by Sunday, 25 October 2026, 1 day ago.'`
  - Add `it('the task’s own zone wins over the zone its date was set from (TASK-955)')`. Use the same date, zone and instant, and check both of these:
    - A cron task in `'Asia/Tokyo'` gives the `1 day ago` line.
    - An interval task with active hours `{ start: '09:00', end: '17:00', tz: 'Asia/Tokyo' }` gives the `1 day ago` line too.
- [ ] **Step 3: Write the failing seam and canary tests.**
  - `routines/src/__tests__/fire.test.ts`:
    - Give `setup`'s options `finishByTimeZone?: string`, and pass `finishByTimeZone: options.finishByTimeZone ?? null` to `f.store.setFinishBy`. Its answer expectation becomes `{ finishBy, finishByTimeZone: options.finishByTimeZone ?? null }`.
    - Add `it("a zoneless task's brief counts on the calendar its date was set from, through the stored row (TASK-955)")`, next to the TASK-951 test (:254). Set it up with `definition: { kind: 'get-done', goodWhen: 'Done when it is done.', trigger: { kind: 'interval', every: '1h' } }`, `finishBy: '2030-12-31'` and `finishByTimeZone: 'America/Los_Angeles'`. The fixture's `now`, 2031-01-01T00:00Z, is 16:00 on 31 December 2030 in Los Angeles.
    - `h.accepted.row.finishByTimeZone` is `'America/Los_Angeles'`, and the brief contains `'The person wants this finished today (Tuesday, 31 December 2030).'`. On UTC it would read `'1 day ago'`.
  - `routines/src/__tests__/canary.test.ts`: add `describe('finish-by time zone canary (TASK-955)')` after the TASK-951 canary (:1022-1060), copying that test's harness shape: `createCheckInHarness({ clock })` with a clock fixed at `2026-10-26T01:00:00Z`.
    - Create an interval task with no active hours.
    - `routines:set-finish-by` with `{ ...key, finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' }` `toStrictEqual`s `{ finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' }`.
    - `routines:get` `toMatchObject`s the same two fields and `revision: task.revision`.
    - `ch.checkIn(task, 'run-1', …)` reports on-track.
    - The check-in's brief contains `'The person wants this finished today (Sunday, 25 October 2026).'`.
    - In the TASK-951 canary, whose answers Task 2 already updated, change the comment at :1037 to "An interval, no active hours and no zone sent with the date, so the task's calendar is UTC's."
- [ ] **Step 4: Write the failing view tests.**
  - `routines/src/__tests__/return-schemas.test.ts`: next to the finishBy block (:140-172), add the same four checks for `finishByTimeZone`:
    - A get-done row with `finishBy: '2026-11-14', finishByTimeZone: 'America/Los_Angeles'` projects both.
    - Stay-on-top and repeat project null.
    - `RoutineViewSchema` refuses the view without the key, and refuses `finishByTimeZone: 3`.
    - It takes `'not a zone'` as a type only (TASK-913).
    - Task 2 already put the key on the base fixture at :11 and updated :237.
  - `routines/src/__tests__/finish-by.test.ts`:
    - The first test's `toEqual({ ...before, finishBy: DATE })` gains `finishByTimeZone` when the set sends one. Send `'America/Los_Angeles'` there, and expect it in `get` and `listed`.
    - The team test (:67): a member who can see the task sees `finishByTimeZone` as well as `finishBy`. It isn't owner-gated (decisions row 5).
    - The stay-on-top test (:132): a hand-set `finish_by_time_zone` on a stay-on-top row shows null.
  - `routines-admin-routes/src/__tests__/routes.test.ts`:
    - Add `'finishByTimeZone'` to `VIEW_KEYS` (:375-378), in sorted position after `'finishBy'` (:376).
    - Add `finishByTimeZone: 'America/Los_Angeles'` beside `finishBy: '2026-11-01'` in the full view fixture `taskView` (:364).
    - Add `finishByTimeZone: null` to the default `routine` fixture (:41).
    - A person's browser wrote the zone, so Settings keeps it, under the rule in the comment at :371-374. The checks at :428 and :436 then pass.
- [ ] **Step 5: Write the failing channel-web host tests.**
  - `routes-workspace-tasks.test.ts`, in `describe('GET /api/workspace/tasks, the finish date (TASK-951)')`:
    - Extend the first test's rows:
      - `stored({ agentId: 'a1', routineId: 'person', kind: 'get-done', finishBy: '2026-11-14', finishByTimeZone: 'America/Los_Angeles' })` → `['person', { date: '2026-11-14', daysLeft: 10 }]`;
      - `stored({ …, routineId: 'tokyo', kind: 'get-done', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Tokyo' }, finishBy: '2026-11-14', finishByTimeZone: 'America/Los_Angeles' })` → 9. At `LA_EVENING` Tokyo is already on the 5th, so the task's own zone wins.
    - Change the comment at :1039 to "An interval, no active hours and no zone stored with its date: UTC's calendar."
    - Add `it('at the boundary, a zoneless row counts on the calendar its date was set from, as the brief does (TASK-955)')`, at the triple's instant:
      - `stored({ agentId: 'a1', routineId: 'la', kind: 'get-done', finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' })` → `daysLeft: 0`;
      - the same task without the zone (`routineId: 'utc'`) → `-1`.
  - `routes-workspace-task.test.ts`:
    - Add `it('at the boundary, a zoneless task’s page counts on the calendar its date was set from, as the brief and the row do (TASK-955)')`. With `rows: [laTask({ trigger: { kind: 'interval', every: '1h' }, finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' })]` and `now` at the triple's instant, `bodyOf(captured).finishBy` `toStrictEqual`s `{ date: '2026-10-25', daysLeft: 0 }`.
    - Add `it.each([['a zone no calendar has', 'Mars/Olympus_Mons'], ['a number', 5]])('a stored zone the contract refuses counts on UTC rather than hiding the date (%s) (TASK-955)')`. Use `unvalidated: true`, `viewPatch: { finishByTimeZone: value }` and the same zoneless row at the same instant → `{ date: '2026-10-25', daysLeft: -1 }`.
    - In the PUT describe, add `it('answers the days left in the zone the service saved, not the one the page read before (TASK-955)')`:
      - The row is the zoneless LA-zoned task above, and `now` is the triple's instant.
      - The body is `{ finishBy: '2026-10-25' }`, with no zone, so the fake answers `finishByTimeZone: null`.
      - The answer is `{ finishBy: { date: '2026-10-25', daysLeft: -1 } }`, though the view read first held LA.
- [ ] **Step 6: Run the tests and watch them fail.** Run `pnpm --filter @ax/routines-contract test`, then build the contract and run the routines, admin-routes and channel-web files above. Expected: FAIL. The precedence ignores the stored zone, and no view carries it.
- [ ] **Step 7: Implement.**
  - **`taskTimeZone`:** `if (row.trigger.kind === 'cron') return row.trigger.tz; return row.activeHours?.tz ?? row.finishByTimeZone ?? 'UTC';`. The doc states the four steps and why the task's own zone wins (decisions row 2).
  - **Module header (:20-23):** "…the task's own time zone, else the one its date was set from (`taskTimeZone`)…".
  - **`RoutineViewShape`:** `finishByTimeZone: z.string().nullable()`. Its doc:
    - TASK-955: the zone the person's browser reported when they set `finishBy`.
    - It is null for any kind but get-done, when there is no date, and when none was reported.
    - Like `finishBy`, it isn't owner-gated, and it is a type only (TASK-913).
    - Receipts keep none.
    - It is required, so a producer that doesn't know it is refused.
    - It is the same in every view, the tools' included.
  - **Tool descriptions:** exactly the two sentences pinned in Step 1.
  - **`routineView`:** `finishByTimeZone: finishByTimeZoneView(row)`. `finishByTimeZoneView(row: StoredRoutine): string | null` is `row.kind === 'get-done' ? row.finishByTimeZone : null`, with a doc in the shape of `finishByView`'s.
  - **`brief.ts` header (:9-15):** replace "The schedule's time zone picks only which calendar day is today" with "The task's time zone (`taskTimeZone`: its schedule's, else the one the person set the date from) picks only which calendar day is today". In the `renderTaskBrief` doc, change "An agent that edits the schedule … can move that day" to keep that sentence and add "The zone the date was set from comes from the person's browser, and no tool can set it." There is no code change: `entry.row` already carries the zone.
  - **`listToolView` doc:** add "TASK-955: so does the zone the date was set from, a zone id the contract's rule accepted."
  - **`settingsView` doc:** "…and the person's finish date and the zone it was set from stay."
  - **BFF:**
    - Add `'finishByTimeZone'` to both Picks and to `toTaskFinishBy`'s Pick.
    - In `toTaskFinishBy`, after the date checks, read the zone leniently: `const setFrom: unknown = view.finishByTimeZone; const finishByTimeZone = typeof setFrom === 'string' && RoutineTimezoneSchema.safeParse(setFrom).success ? setFrom : null;`. Then `const tz = taskTimeZone({ trigger: view.trigger, activeHours: view.activeHours, finishByTimeZone });`. Keep the existing `RoutineTimezoneSchema.safeParse(tz)` guard.
    - The PUT answer becomes `toTaskFinishBy({ ...own.view, kind: 'get-done', finishBy: out.finishBy, finishByTimeZone: out.finishByTimeZone }, now())`.
    - `TaskSetFinishByOutput` is the Pick above.
    - Docs: `toTaskFinishBy`'s says "the task's own time zone, else the one its date was set from (`taskTimeZone`), never the reader's or the host's", plus a lenient-zone sentence. :7899-7901 says "The read supplies the task's own time zone; the service's answer supplies the zone the date was saved with".
  - **`workspace-types.ts:1404-1410`:** "(its schedule's, else its active hours', else the zone the person set the date from, else UTC)".
  - **`lib/task-finish-by.ts` and `TaskPage.tsx` docs:** the same parenthetical.
- [ ] **Step 8: The fixture sweep.** Add `finishByTimeZone: null` beside `finishBy` in every `RoutineView` literal and every view key pin listed in "Fixture sweep, Task 3" below. Then run `pnpm --filter @ax/channel-web build` and the grep from Task 2 Step 6.
- [ ] **Step 9: Run the suites and watch them pass.** `pnpm --filter @ax/routines-contract build && pnpm --filter @ax/routines-contract test && pnpm --filter @ax/routines test && pnpm --filter @ax/routines-admin-routes test && pnpm --filter @ax/channel-web build && pnpm --filter @ax/channel-web test`. Expected: all PASS. If Docker is down, run the routines-admin-routes `routes.test.ts` file alone and record the skip.
- [ ] **Step 10: Commit.** `[TASK-955] Count a zoneless task's Finish by days in the zone its date was set from: brief, row and page`.

---

### Task 4: The browser sends its zone with the date [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/channel-web/src/server/routes-workspace.ts`:
  - `TaskSetFinishByInput` (:896-898) gains `finishByTimeZone?: string`;
  - `readTaskFinishByBody` and its doc (:3853-3865);
  - the `setTaskFinishBy` handler and its doc (:7886-7960);
  - the file header's `/finish-by` sentence (:82-87).
- Modify: `packages/channel-web/src/lib/task-finish-by.ts`: a new `browserTimeZone()` after `browserToday` (:46-51). The header's first paragraph (:1-4) adds "and the browser's own time zone, which the date field sends with a date".
- Modify: `packages/channel-web/src/lib/workspace-api.ts:1328-1344`: `setTaskFinishBy` and its doc.
- Modify: `packages/channel-web/src/components/workspace/TaskFinishDate.tsx`: `save` (:158) and the header (:15-19).
- Test:
  - `channel-web/src/__tests__/server/routes-workspace-task.test.ts` (the PUT describe, :1915);
  - `src/lib/__tests__/task-finish-by.test.ts`;
  - `src/lib/__tests__/workspace-api-task.test.ts` (:520-560);
  - `src/components/workspace/__tests__/TaskFinishDate.test.tsx` (:124, :136);
  - `src/components/workspace/__tests__/TaskPage.test.tsx` (:1019).

**Interfaces:**
- Consumes: `routines:set-finish-by`'s `finishByTimeZone` input (Task 2), and the answer and count from Task 3.
- Produces:
  - `browserTimeZone(): string | null`.
  - `workspaceApi.setTaskFinishBy(agentId: string, routineId: string, finishBy: string | null, timeZone: string | null): Promise<TaskFinishByResponse>`. The body is `{ finishBy }`, plus `timeZone` only when it is a string.
  - The PUT body's optional `timeZone`.
  - The log event `workspace_finish_by_zone_unusable { agentId, routineId }`.

- [ ] **Step 1: Write the failing route tests** in the PUT describe.
  - `it('sends the zone the browser named with the date, and answers the days left on that calendar (TASK-955)')`:
    - The row is a zoneless get-done task with no date, and `now` is the triple's instant.
    - The body is `{ finishBy: '2026-10-25', timeZone: 'America/Los_Angeles' }`.
    - `finishByCalls[0].input` `toStrictEqual`s `{ agentId: 'a1', routineId: 't1', finishBy: '2026-10-25', finishByTimeZone: 'America/Los_Angeles' }`.
    - The answer `toStrictEqual`s `{ finishBy: { date: '2026-10-25', daysLeft: 0 } }`. On UTC it would be −1.
  - `it('a body with no zone, or a null one, sends none (TASK-955)')`: both `{ finishBy: '2026-10-25' }` and `{ finishBy: '2026-10-25', timeZone: null }` give an input with no `finishByTimeZone` key (`toStrictEqual`).
  - `it('a zone this host can’t count in saves the date without it, counted on UTC, and says so in ids only (TASK-955)')`:
    - `vi.spyOn(initCtx.logger, 'warn')`.
    - The body has `timeZone: 'Mars/Olympus_Mons'`.
    - The status is 200, the input has no `finishByTimeZone`, and the answer has `daysLeft: -1` at the triple's instant.
    - The warn calls filtered to `'workspace_finish_by_zone_unusable'` equal `[['workspace_finish_by_zone_unusable', { agentId: 'a1', routineId: 't1' }]]`.
    - `JSON.stringify(warn.mock.calls)` doesn't contain `'Mars'`.
  - `it('a timeZone that isn’t a string is a bad body, and nothing is asked (TASK-955)')`: for `{ finishBy: '2026-10-25', timeZone: 5 }` and `{ …, timeZone: { tz: 'UTC' } }`, the answer is 400 `{ error: 'finish-by-body-invalid' }` and `order` is `[]`.
  - The existing test at :1916 stays as it is. Its body has no zone, and its expected input `{ agentId, routineId, finishBy }` must still hold.
- [ ] **Step 2: Write the failing client tests.**
  - `lib/__tests__/task-finish-by.test.ts`: add `describe('browserTimeZone (TASK-955)')`.
    - With `process.env.TZ = 'America/Los_Angeles'`, saved and restored in `try/finally`, and with a guard that `Intl.DateTimeFormat().resolvedOptions().timeZone` is `'America/Los_Angeles'` (TASK-435's "guard the flip"), it returns `'America/Los_Angeles'`.
    - With `vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')` wrapping the original and overriding `timeZone` with `'Etc/Unknown'`, then `''`, then `undefined`, it returns `null`. Restore the spy.
  - `lib/__tests__/workspace-api-task.test.ts`:
    - Every `setTaskFinishBy(…)` call gains a fourth argument.
    - The first test passes `'America/Los_Angeles'` and expects the body `{ finishBy: '2026-11-14', timeZone: 'America/Los_Angeles' }`.
    - The remove test passes `null` and expects `{ finishBy: null }`.
    - Add `it('leaves the zone out when the browser named none (TASK-955)')`: `('a1', 't1', '2026-11-14', null)` → body `{ finishBy: '2026-11-14' }`.
  - `components/workspace/__tests__/TaskFinishDate.test.tsx`:
    - Pin the zone for the file: `beforeEach` saves `process.env.TZ` and sets `'America/Los_Angeles'`; `afterEach` restores it, deleting the variable when it was unset. The house already does this: `src/__tests__/workspace-timestamp-parity.test.tsx:286-302` and `components/workspace/__tests__/ConnectorDetails.test.tsx:593-610`.
    - :124 becomes `toHaveBeenCalledWith('a1', 't1', '2026-11-14', 'America/Los_Angeles')`.
    - :136 (Remove date) becomes `toHaveBeenCalledWith('a1', 't1', null, null)`.
    - Add `it('a browser that can’t tell its zone still saves the date, with none (TASK-955)')`: stub `resolvedOptions` as above to `'Etc/Unknown'`, save `'2026-11-14'`, and expect the call `('a1', 't1', '2026-11-14', null)`.
  - `components/workspace/__tests__/TaskPage.test.tsx:1019`: `toHaveBeenCalledWith('a1', 't1', '2026-11-14', browserTimeZone())`. Import `browserTimeZone` from `@/lib/task-finish-by`, so the test holds in any runner's zone.
- [ ] **Step 3: Run the tests and watch them fail.** `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-workspace-task.test.ts src/lib/__tests__/task-finish-by.test.ts src/lib/__tests__/workspace-api-task.test.ts src/components/workspace/__tests__/TaskFinishDate.test.tsx src/components/workspace/__tests__/TaskPage.test.tsx`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - **`readTaskFinishByBody(parsed: unknown): { finishBy: string | null; timeZone: string | null } | null`.** Read `timeZone` with `Object.hasOwn(parsed, 'timeZone')`, as `finishBy` is read. Absent or `null` gives `timeZone: null`. A string is kept as sent. Anything else makes the whole body `null`, which the handler answers 400 `finish-by-body-invalid`. In the doc, add that the zone's rule is checked at the handler.
  - **The handler, after `ownTaskOr404`:** `const zone = body.timeZone !== null && RoutineTimezoneSchema.safeParse(body.timeZone).success ? body.timeZone : null;`. If `body.timeZone !== null && zone === null`, call `initCtx.logger.warn('workspace_finish_by_zone_unusable', { agentId: key.agentId, routineId: key.routineId })`. The service input becomes `{ agentId, routineId, finishBy: body.finishBy, ...(zone === null ? {} : { finishByTimeZone: zone }) }`. The handler doc's order line gains "→ the zone (one this host can't count in is dropped, decisions row 9)" before the service call.
  - **The header sentence (:82-87):** "…the contract's date and zone rules screen both before anything is written, and they reach a model only as the brief's fixed sentences and as the routine tools' `finishBy` and `finishByTimeZone` values". The old "the date reaches a model only as fixed sentences in a get-done check-in's brief" was already false: the tools' views carry `finishBy`.
  - **`browserTimeZone()`:** `const zone: unknown = Intl.DateTimeFormat().resolvedOptions().timeZone; return RoutineTimezoneSchema.safeParse(zone).success ? (zone as string) : null;`. Import `RoutineTimezoneSchema` beside `RoutineFinishBySchema`. Its doc: a browser that can't tell its zone reports `"Etc/Unknown"`, which `Intl` refuses, and sending that would make every save fail.
  - **`setTaskFinishBy`:** the signature above, and the body `timeZone === null ? { finishBy } : { finishBy, timeZone }`. The doc says the zone travels only with a date the person picked, and that the host keeps it beside the date.
  - **`TaskFinishDate.save`:** `workspaceApi.setTaskFinishBy(agentId, routineId, next, next === null ? null : browserTimeZone())`. Update the header (:15-19): the browser counts nothing; it knows its own today, for `min` and the "not in the past" check, and it sends its own zone with the date, which the host counts in when the task has no zone of its own.
- [ ] **Step 5: Run the tests and watch them pass.** The same files, then `pnpm --filter @ax/channel-web build && pnpm --filter @ax/channel-web test`. Expected: PASS.
- [ ] **Step 6: Commit.** `[TASK-955] channel-web: the browser sends its time zone with a finish date`.

---

### Task 5: The design doc, memory and the PR's notes [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`.
- Create: `.claude/memory/patterns/2026-10-25-TASK-955.md`, from `scripts/memory-write-target.sh --shard patterns TASK-955`. Use a variable name other than `path`, which zsh ties to `PATH`, then `mkdir -p` its directory.

- [ ] **Step 1: Update the design doc.**
  - :272, in the TASK-951 paragraph: "(its schedule's, else its active hours', else UTC)" becomes "(its schedule's, else its active hours', else the time zone of the person who set it, sent by their browser with the date, else UTC; TASK-955)".
  - :753: after "in the task's own time zone", add ", or, for a task with none, in the time zone the person set the date from (TASK-955)".
  - §15: append a row after the last one. "| 2026-10-25 | Decided | A Finish by date is counted in the task's own time zone (its schedule's, else its active hours'); a task with none counts in the time zone of the person who set the date, which their browser sends with it and the host stores beside it; with no zone, UTC. The task's own zone wins when the two differ. Supersedes the 2026-10-24 TASK-951 row's \"else UTC\" (confirmed by Vinay, 2026-10-25, TASK-955). |"
  - §13 "New hooks", the `routines:set-finish-by` entry: append "; TASK-955 adds the zone the date was set from".
  - "Resume here", the PR 3 bullet: after "TASK-951 added a Finish by date that only a person sets (schema version 12);", add "TASK-955 counts it in the time zone of the person who set it when the task has none of its own (schema version 14);". Keep the bullet's other facts as they are.
- [ ] **Step 2: Write the patterns row.** One row: "`2026-10-25` (TASK-955) — **Supersedes TASK-951 patterns row 1's "else UTC".** A finish date is counted with `taskTimeZone({ trigger, activeHours, finishByTimeZone })`: cron tz, else active hours tz, else the zone the person's browser reported when they saved the date (stored beside it, `finish_by_time_zone`, schema 14), else UTC. The parameter is required on purpose: a caller that forgets the stored zone fails to compile instead of counting in UTC. Validate a browser's zone with `RoutineTimezoneSchema` on the browser before sending (`'Etc/Unknown'` is what a browser reports when it can't tell, and V8 refuses it), and at the host treat one this runtime can't use as missing rather than refusing the date. Kysely drops `undefined` from an UPDATE's `set`, so write `x ?? null` for a nullable column you mean to clear."
- [ ] **Step 3: Run the whole gate.** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Expected: all green. Name any Docker-backed suite you skipped, since CI's postgres:16 run is the gate.
- [ ] **Step 4: Run `security-checklist` over the whole diff** (Tasks 2-4 are flagged), and write its note into the PR description. The three points it must answer:
  - **Untrusted input:** the browser's zone is checked by `RoutineTimezoneSchema` at the route and again at the hook.
  - **What reaches a model:** only a zone id that `Intl` accepts, with no spaces, line breaks or text, and only in the routine tools' views. The brief gets a count and fixed sentences.
  - **Reach:** nothing new. Owner-only, as TASK-951's hook is. No tool, IPC action or dependency.
- [ ] **Step 5: Put the boundary review in the PR description,** copied from decisions row 15: the alternate impl, leaky names (none), subscriber risk (none), wire surface. Add the card's corrections (decisions rows 1 and 4) and the follow-up for Vinay (decisions row 2: which zone wins when a task's schedule zone is deliberately foreign).
- [ ] **Step 6: Commit.** `[TASK-955] Design doc and memory: Finish by counts in the zone its date was set from`.

---

## Fixture sweep, Task 2 (StoredRoutine literals, set-finish-by answers, fakes)

This comes from a read-only sweep at f0383a5f3. Unless a row says otherwise, add `finishByTimeZone: null` beside `finishBy`.

**Which tests are type-checked:** only channel-web's. The `tsconfig.json` of routines, routines-contract and routines-admin-routes all exclude `src/__tests__/**`. Every site in those packages fails only when the tests run, and a missing key there can also make a test silently assert nothing.

**channel-web's shared fixture is a view, not a stored routine:** `routineFixture` (`components/routines/__tests__/routine-fixture.ts`) is typed `RoutineView`. So in this task, put the new `StoredRoutine` key in each `stored()` helper itself. The view fixture gets its key in Task 3.

| Package | Site | Change |
|---|---|---|
| routines-contract | `src/__tests__/finish-by.test.ts:124-126` | The output-schema checks: replaced by Step 1's renamed test. In the refusal case, add the key, or it passes for the wrong reason. |
| routines | `src/__tests__/finish-by.test.ts:47, 51, 61 (loop), 63, 71, 94, 128, 145, 146, 158` | Answers `toStrictEqual({ finishBy: X, finishByTimeZone: null })`, or the sent zone where Step 3 sends one. |
| routines | `src/__tests__/finish-by-store.test.ts:46, 50, 59, 107` | Answers: as above, through the updated helper. |
| routines | `src/__tests__/duplicate-store.test.ts:101` | Answer shape. |
| routines | `src/__tests__/fire.test.ts:30` (inside `setup`) | Answer shape, plus the `finishByTimeZone` option (Task 3 Step 3 uses it). Also `:16` `sampleRow()`: add the key. |
| routines | `src/__tests__/canary.test.ts:1046, 1101` | Answer shape. |
| routines | `src/__tests__/return-schemas.test.ts:237` | Answer shape. `:11`, the base `row: StoredRoutine`: add the key now, so Task 3's view doesn't read `undefined` from it. |
| routines | `src/__tests__/brief.test.ts:174` (`storedRow`), `src/__tests__/next-check.test.ts:11-18` (`stored()`) | Add the key. Neither breaks, because one is cast and the other only reads `nextRunAt`, but the literals should stay true. |
| channel-web (tsc) | `src/__tests__/server/routes-workspace-task.test.ts:157`, `routes-workspace-tasks.test.ts:95`, `routes-workspace-checkin.test.ts:103` (each `stored()`), `src/__tests__/routine-manager-producer.test.tsx:17` | Add the key. `claimed` (:604), `markedDone` (:615), `laTask` (:1383) and `TEAM_ROWS` (tasks :255) all go through `stored()`. |
| channel-web | `src/__tests__/server/routes-workspace-task.test.ts:465`, the fake `routines:set-finish-by` | `return { finishBy: input.finishBy, finishByTimeZone: input.finishBy === null ? null : (input.finishByTimeZone ?? null) };` mirrors the store's rule. Without it, the bus's `returns` refuses the answer as `invalid-return`, and the PUT tests at :1916, :1939 and :1954 fail. tsc won't flag it. |

These don't break:
- every `toMatchObject` and `objectContaining` partial check (finish-by :64/73/77; finish-by-store :89/94/104/139; duplicate-store :117-127; canary :1044/1047/1105/1121-1124/1154);
- the other fields' `beforeThisField` receipt tests (report-views :110, steps-store :113, misses-store :95, done-store :319), because the new schema key has a default;
- the log pin at finish-by :147-150, because the line gains no field;
- `finish-by-store.test.ts:49`'s `wholeRow` comparison, because a set without a zone leaves the column NULL, as it was.

## Fixture sweep, Task 3 (RoutineView literals and view key pins)

| Package | Site | Change |
|---|---|---|
| routines-contract | `src/__tests__/definition.test.ts:137` (`view`), `:277`, `:1017`, `:1199` | Add the key. Without it, the strict parses at :139/:144/:222-224/:239-240, :485/:492, :1018 and :1200 throw or fail, and the "refuses" checks beside them pass for the wrong reason. |
| routines-contract | `src/__tests__/misses.test.ts:52`, `src/__tests__/report.test.ts:181, :213` | Add the key (the strict parses at misses :63/:73/:74 and report :189/:221/:232). |
| routines-contract | `src/__tests__/finish-by.test.ts:152-157`, `src/__tests__/done.test.ts:118`, `src/__tests__/report.test.ts:262` | The description pins (Task 3 Step 1). `finish-by.test.ts:142` and `:159` (`not.toContain('finishBy')`) also match `finishByTimeZone`, and both stay true: the JSON schemas, and the create and report descriptions, never name either. |
| routines | `src/__tests__/return-schemas.test.ts:147` | Give the get-done fixture a zone, and add Task 3 Step 4's assertions beside :151-172. The key is already on `:11` from Task 2. |
| routines-admin-routes | `src/__tests__/routes.test.ts:41` (`routine`, the fakes' default answer), `:364` (`taskView`) | Add the key, `'America/Los_Angeles'` at :364. Without it, `routes.ts:115`'s strict `call()` refuses the fakes' answers, and the routes at :160, :199, :405, :418, :427 and :430 answer 5xx. |
| routines-admin-routes | `src/__tests__/routes.test.ts:375-378` (`VIEW_KEYS`) | Add `'finishByTimeZone'` after `'finishBy'`. It's used at :428 and :436, and :436 fails from the schema change alone. |
| channel-web (tsc) | `src/components/routines/__tests__/routine-fixture.ts:28` | Add the key. This fixes every view spread in `RoutineEditor.test.tsx`, `routines-list.test.tsx`, `routines-default-parity.test.tsx` and `fire-now-control.test.tsx`. The `stored()` helpers keep their own key from Task 2. |

Not affected: the browser's wire shapes (`TaskRow`, `TaskDetail` and their `finishBy: { date, daysLeft }`), every `components/workspace` and `lib` fixture, `routines-client.test.ts`, `human-rest-integration.test.ts` (it uses the real services), and every presets package. The existing day counts (`laTask` → 10, the `utc` row → 9) stay as they are: `laTask` runs on a Los Angeles cron, and the `utc` row has no zone stored.

**Build order:** channel-web's `tsc --build` follows its project references (`../routines`, `../routines-admin-routes`, `../routines-contract`). `routine-manager-producer.test.tsx` imports `routines-admin-routes/dist/routes.js`. So run `pnpm --filter @ax/channel-web build` before `pnpm --filter @ax/channel-web test`; it rebuilds all three referenced packages.
