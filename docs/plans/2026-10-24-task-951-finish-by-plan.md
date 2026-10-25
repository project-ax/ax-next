# TASK-951: an optional "Finish by" date that a person sets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Get something done" task's owner can give it a finish date on its task page. The Tasks row ("9 days left") and the task page ("Finish by Sat, Nov 14 · 9 days left") show it. Each check-in's brief counts the days to it and tells the agent to report Off track when the steps left won't fit. No tool, IPC action or model can set it.

**Architecture:** The contract gains the date's rule (`RoutineFinishBySchema`, clock-free) and one shared calendar: `taskTimeZone` (the cron's zone, else the active hours', else UTC) and whole-day counting. The store keeps the date as `YYYY-MM-DD` TEXT in its own column on the definition row (schema version 12). It reads the column leniently, clears it on a change of kind, keeps it on a change of owner, leaves it out of receipts, and writes it only through `setFinishBy`. That method checks the owner and the kind under the agent fence and the row lock, and never moves the revision. A new owner-only service, `routines:set-finish-by`, is neither a tool nor an IPC action. The views carry `finishBy` to anyone who sees the routine. The brief adds one fixed paragraph, counted from the run's accept time in the task's time zone. channel-web computes `{ date, daysLeft }` on the host in the task's time zone, adds `PUT …/finish-by`, and draws the line and an inline native date field on the task page plus a suffix on the Tasks row.

**Tech Stack:** TypeScript, zod 3.25, Kysely on Postgres (testcontainers, or the local-pg shim), `Intl.DateTimeFormat`, vitest, React + shadcn (channel-web).

**Spec:** card TASK-951 (orchestrator scratchpad `TASK-951/card.md`); `docs/plans/2026-10-20-agent-tasks-design.md` §3.4, §4.5, §8, §9 (finding "Get something done has no due date"), §12 PR 3, §13; decisions `.claude/memory/decisions/2026-10-24-TASK-951.md` (cited as "decisions row N").

## Where the code refined the card

Everything else in the card checked out against be148ac53. These six points change what gets built, and each has a decisions row:

1. **The lenient read uses the contract's whole rule, not just the regex.** The CHECK the card asks for passes `2026-02-30` and `2026-13-45`, since they match `^\d{4}-\d{2}-\d{2}$`. V8 rolls `new Date('2026-02-30T00:00:00Z')` over to 1–2 March. `new Date('2026-02-32T00:00:00Z')` is an Invalid Date, and `Intl.DateTimeFormat#format` then throws `RangeError: Invalid time value` (measured on Node 24.19). That throw would land in the brief, the Tasks list or the page. So every read takes a stored date through `RoutineFinishBySchema.safeParse`, and a refused value reads as null [row 4].
2. **Receipts leave `finishBy` out. The card said `withoutTaskState` "leaves it in receipts".** `StoredRoutineSchema` is strict (`packages/routines/src/definition.ts`), and the `receiptCopy` comment (`packages/routines/src/store.ts:490-505`) explains why every newer key stays out: code from before the field reads receipts with a strict schema that has no such key. A replayed dispatch never fires (`tick.ts:106` uses `randomUUID()` per dispatch; `services.ts:234` and `webhook-handler.ts:117` skip replays), so the brief always reads the live `accepted.row` [row 5].
3. **`setFinishBy` answers `{ finishBy } | 'not-found' | 'forbidden'`.** In the card's `string | null | 'not-found' | 'forbidden'`, TypeScript absorbs the two literals into `string`, so callers can't narrow [row 6].
4. **The CHECK uses `[0-9]`, not `\d`.** Kysely's `sql` tag builds from the template's cooked strings. Measured: `` sql`… ~ '^\d{4}$'` `` sends `~ '^d{4}$'`. That CHECK would refuse every real date and accept only `dddd-dd-dd` [row 3].
5. **`PUT …/finish-by` reads the task first (`ownTaskOr404`).** Its answer carries `daysLeft`, which needs the task's time zone, and the card's order (resolve, then set) has none. The service still decides owner and kind under its row lock. The read only supplies the zone and makes the route's 404s match the page's [row 12].
6. **The `optionalCalls` degradation sentence is reworded.** The card's "Without it, the task page shows no finish date" is false: the date reaches the page through `routines:get` [row 13].

Smaller corrections, no behaviour change:
- `TaskDetailView` already picks `trigger` and `activeHours` (`routes-workspace.ts:767-781`). Only `TaskListView` needs all three new picks.
- The parity tests are now `definition.test.ts:240-250`.
- **14 November 2026 is a Saturday.** The card's "Fri, Nov 14" is an example from another year, so tests compute weekdays.

## Global Constraints

- **Base and version.** Base on origin/main be148ac53 or later. Routines schema **version 12** is free (`migrations.ts:277-280` stops at 11). TASK-949 and TASK-950 build in parallel and may also take 12. They also add services, which changes `ROUTINE_SERVICES`' length (21 here). They may add a `channel-web` optional call after `routines:recent-replies`, and they edit the design doc's "Resume here", §4.5, §13 and §15. Whichever merges second rebases, takes the next free number everywhere, and unions every pin. "Everywhere" means `migrations.ts`, every `versions()` list in `migrations.test.ts`, the comments and the design doc. The pins are the length, the `plugin.ts`/`plugin.test.ts` order and the design-doc rows. Then re-run the routines, routines-admin-routes and channel-web suites.
- **Copy is exact and asserted verbatim.** Apostrophes are U+2019 (’). The brief's quotes around `"off-track"` are straight, as in `BRIEF_HOW`. The separator is " · " (U+00B7), as in the page's meta line.
- **The brief spells dates with an explicit locale and UTC.** It uses `new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })` on `${date}T00:00:00Z`, so it reads "Saturday, 14 November 2026". `calendarDateIn` reads parts with the fixed locale `'en-US'`. Never pass `undefined` on the host: the host's default locale must not change the digits or the order.
- **The browser formats in the reader's language, still in UTC.** `finishByDate` is `Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })`. Following the house pattern (`shortDay`, `formatReading`), it takes an optional `locale` for tests. Lib tests pin `'en-US'` ("Sat, Nov 14"). Component tests derive the expected words from the lib function rather than pinning a locale (memory `patterns/2026-09-20-TASK-435.md`).
- **Running one file:** `pnpm --filter @ax/<pkg> exec vitest run <path>`. Never `test -- <file>`, and never a filter after the script name. Check the file count in the summary.
- **Postgres-backed suites: all of `@ax/routines`, and `@ax/routines-admin-routes`' `src/__tests__/human-rest-integration.test.ts`.** The latter boots `createRoutineHarness`, which starts a container; that package's `routes.test.ts` doesn't. Check Docker with `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock timeout 15 docker info`, and export that `DOCKER_HOST` for the run. If it hangs, don't restart OrbStack (the kind cluster and sibling builders share it). Instead, after `/opt/homebrew/opt/postgresql@17/bin/pg_isready -h 127.0.0.1 -p 55439` answers, run `pnpm --filter @ax/routines exec vitest run --config /private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/386b12a8-02d6-45fd-a50d-1e78eb04cac6/scratchpad/TASK-951/pg/vitest.routines.mjs [<path>]`. This worktree's shim already exists, with a measured baseline of 44 files and 567 tests. Add `--no-file-parallelism` if a lock-wait test flakes. The shim runs Postgres 17, not 16, so CI's run is the gate: name every suite that ran only on the shim in the handoff (memory `patterns/2026-10-23-TASK-930.md`). For `@ax/routines-admin-routes` with Docker down, run `pnpm --filter @ax/routines-admin-routes exec vitest run src/__tests__/routes.test.ts`. Or copy the shim config with `root` set to that package (its mock covers the same `packages/test-harness/dist/index.js`), and name `human-rest-integration.test.ts` in the handoff.
- **channel-web Docker-backed files.** Six channel-web files start containers: `acceptance-e2e`, `connections-mirror`, `routes-attachments`, `routes-chat`, `routes-workspace-approval-actor` and `stream-e2e`, all under `src/__tests__/server/`. They fail at preflight without Docker. When Docker is down, run the rest with one `--exclude '**/<name>.test.ts'` per file, and name those six in the handoff. None of them touches this card's code.
- **channel-web type-checks its tests** (`include: ["src", "mock"]`); `@ax/routines` and `@ax/routines-contract` don't (`exclude: ["src/__tests__/**"]`). After Tasks 2, 3, 5 and 6, run `pnpm --filter @ax/channel-web exec tsc --build`. Add `finishBy: null` (or the right value) to every fixture it names. For the routines packages, the fixture lists below are the whole job, because no compiler finds them.
- **Lib imports.** channel-web `src/lib/*.ts` modules the server imports use relative `./x.js`, never `@/lib/...` (memory `patterns/2026-10-20-TASK-906.md`). `task-finish-by.ts` is client-only. The server's helpers come from `@ax/routines-contract`.
- **Nothing new to install.** No new dependency, no shadcn component (the page uses the installed `Input` with `type="date"`) and no new tool, IPC action or `TOOL_FIELDS` entry. Invoke the `shadcn` and `ux-design` skills in Task 6.
- **Lint.** A task's test file carries only the names that task's tests use, or its commit fails `pnpm lint` (memory `mistakes/2026-10-24-TASK-948.md`).
- **One task at a time, in this worktree.** channel-web's `tsc --build` compiles routines and the contract, so two builds at once collide.
- **vitest loads other workspace packages from their built `dist/`.** `@ax/routines`, `@ax/routines-admin-routes` and channel-web resolve `@ax/routines-contract` through its package exports. After changing a package's source, rebuild it before running any other package's suite: `pnpm --filter @ax/routines-contract build` after Tasks 1 and 3, and `pnpm --filter @ax/routines build` after Tasks 2 and 4, or just `pnpm build`. Otherwise the dependent suite runs against the old schemas. After Task 3, for example, the old strict view schemas refuse `finishBy`, and every view-returning call fails `invalid-return` (the bus checks each service's `returns`, `packages/core/src/hook-bus.ts:417-425`), a mostly red run with a misleading cause.
- **Commit this plan and its decisions shard first, before Task 1.** `pnpm test:scripts` checks every rooted path a memory shard cites. Write builder memory rows to shards (`scripts/memory-write-target.sh --shard <kind> TASK-951`), never a root archive.
- **The Bash tool runs zsh, where `path` is tied to `PATH`.** CLAUDE.md's `path=$(scripts/memory-write-target.sh …)` idiom empties the search path, after which `dirname`, `mkdir` and friends are "command not found". Use another name, such as `shard=$(…)`.
- **The escape trap.** Write test inputs with invisible or unusual characters (Task 1's fullwidth digits) as backslash-u escape text. The Write/Edit tools have turned such escapes into raw characters five times, this plan included (memory `mistakes/2026-10-24-TASK-948.md`). After writing a file with one, grep for the escape. Re-escape with a script that builds the backslash from `chr(92)`.
- **Final gate:** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

## Review Focus

1. **A check-in, page read or row read near midnight, or a reader in another time zone than the task.** Expected: the brief, the page and the row all count from the task's own calendar day. Pinned by: Task 4, "counts from the accept day in the task's own time zone, not UTC's" (America/Los_Angeles at 2026-11-05T02:00Z gives 10 days, where UTC gives 9). Task 5 uses the same instant and zone and gets `daysLeft: 10` on the row and on the detail.
2. **A stored value the CHECK lets through but no calendar has** (`2026-02-30`, `2026-13-45`, from a hand edit or a later version). Expected: it reads as no date everywhere. The tick still claims the row, the brief has no paragraph, and the page and row show nothing. Nothing throws. Pinned by: Task 2, "a stored date no calendar has reads as none, and the tick still claims the row"; Task 5, "a finish date the contract refuses reaches the page as none".
3. **A read already in flight when Save answers**, for example the 10-second "Checking in now…" poll. Expected: the saved date stays on screen and is never put back to the old one. Pinned by: Task 6, `useTask` "applyAnswer shows a write's answer at once, and a read that was already on its way can't put the old value back".
4. **Save's answer lost** (network or 5xx), then pressed again. Expected: "We couldn’t save that date. Try again.", then the same PUT again, which is safe because a value set twice is the same. Pinned by: Task 6, "a save nobody could confirm says so, and pressing Save again sends the same date"; Task 3, "setting the same date twice answers the same and keeps the revision".
5. **A person-approved kind change committing while a Save waits on the row.** Expected: the save is refused as not-found, and no date lands on a stay-on-top task. Pinned by: Task 2, "a kind change that commits while setFinishBy waits on the row lock makes it not-found".

## Hook surface and boundary review

New: `routines:set-finish-by`. Changed: `routines:list`, `routines:get`, `routines:create` and `routines:update`, whose views gain `finishBy`. The tools `routine_list`, `routine_get` and `routine_update` answer with it too. For the PR description:

- **Alternate impl:** a tracker's due date (Linear `dueDate`, Asana `due_on`), or a SQLite store with the same column.
- **Payload names that might leak:** none. `finishBy` is a domain word, and `YYYY-MM-DD` is a plain calendar date.
- **Subscriber risk:** none, since it's a service. Readers must treat the date as calendar-only, never as an instant.
- **Wire surface:** not an IPC action. The schemas live in `@ax/routines-contract`.

## Security checklist (Task 6 runs the skill over the whole diff)

Flagged tasks: 1 (the only rule on what the brief can carry), 3 (a new service hook and who may call it), 4 (person-set data in a model's prompt), 5 (a new HTTP write route). For the PR's `## Security review` block, finish this in Task 6:

```
## Security review
- Sandbox: N/A: no filesystem path, process, network reach, env or handle is added or widened. One new host-only service hook (routines:set-finish-by) and one HTTP route (PUT /api/workspace/tasks/:agentId/:routineId/finish-by); no tool, IPC action, connector or permission changes.
- Injection: a "get-done" task's finish date is the only new value that reaches a model, as fixed English sentences in its check-in's brief. Only a person can set it: no tool or IPC action reaches the hook, and the tools' strict create and patch schemas refuse a finishBy key. The service refuses anything but a real calendar date written YYYY-MM-DD between 2000-01-01 and 2100-12-31, a database CHECK refuses anything that isn't that format, and a stored value the rule refuses reads as none on every read. The task's schedule time zone (which an agent can change under Always Allow) only picks which calendar day is "today", so it can move the count by up to two days; none of its text reaches the brief. The write is owner-only, decided under the agent fence and the routine's row lock, where a task that is no longer get-done is refused. The route is behind the session check and @ax/http-server's CSRF guard for PUT.
- Supply chain: N/A: no package.json or lockfile change; the page uses a native date input, not a date-picker dependency.
```

## Rollback

Version 12 is additive. Code from before it never names `finish_by`: `rowToRoutine` builds from named columns, and the CHECK allows NULL. Receipts written by version 12 leave `finishBy` out, so older code still reads them. After a rollback the dates stay in the column and don't show. One edge: older code's `updateAuthored` doesn't clear `finish_by` on a kind change. A task edited get-done → stay-on-top → get-done under older code would show its old date again after rolling forward. It needs a rollback plus two approved kind changes. Nothing from Agent Tasks PR 1–3 is deployed.

## Tiers and order

| Task | Tier | Needs | security-checklist |
|---|---|---|---|
| 1 Contract: the date's rule, the task's calendar, the hook's schemas | sensitive | — | flagged |
| 2 Store: version 12, the stored date, `setFinishBy` | sensitive | 1 | PR note |
| 3 Services, views and tool words | sensitive | 2 | flagged |
| 4 The brief, the accept time and the canary | sensitive | 3 | flagged |
| 5 channel-web server: the date on the wire and `PUT …/finish-by` | sensitive | 3 | flagged |
| 6 channel-web client: the task page's Finish by and the Tasks row | integration | 5 | runs the skill over the diff |
| 7 Docs: the design doc | mechanical | all | — |

Run them in this order, one at a time.

---

### Task 1: Contract: the date's rule, the task's calendar, the hook's schemas [tier: sensitive]

**Files:**
- Create: `packages/routines-contract/src/finish-by.ts`
- Modify: `packages/routines-contract/src/index.ts` (add `export * from './finish-by.js';`)
- Modify: `packages/routines-contract/src/services.ts`. After `RoutineClearNotesOutputSchema` (:73-74), add the two set-finish-by schemas and their doc comment. Add their types beside `RoutineClearNotes*` (:217-218).
- Create: `packages/routines-contract/src/__tests__/finish-by.test.ts`

**Interfaces:**
- Produces (exported from `@ax/routines-contract`):
  ```ts
  export const ROUTINE_FINISH_BY_EARLIEST = '2000-01-01';
  export const ROUTINE_FINISH_BY_LATEST = '2100-12-31';
  /** A finish date: `YYYY-MM-DD`, a real calendar date, 2000-01-01 to 2100-12-31. One issue, never a clock rule. */
  export const RoutineFinishBySchema: z.ZodEffects<z.ZodString, string, string>;
  /** The time zone a task's calendar runs on: its cron's, else its active hours', else 'UTC'. */
  export function taskTimeZone(row: { trigger: RoutineTrigger; activeHours: ActiveHours | null }): string;
  /** `at`'s calendar date in `tz`, `YYYY-MM-DD`. */
  export function calendarDateIn(at: Date, tz: string): string;
  /** Whole calendar days from `from` to `to` (both `YYYY-MM-DD`): 0 on the same day, negative when `to` is earlier. */
  export function calendarDaysBetween(from: string, to: string): number;
  /** `calendarDaysBetween(calendarDateIn(at, tz), finishBy)`. */
  export function calendarDaysUntil(finishBy: string, at: Date, tz: string): number;

  // services.ts
  export const RoutineSetFinishByInputSchema = RoutineKeySchema.extend({ finishBy: RoutineFinishBySchema.nullable() }).strict();
  export const RoutineSetFinishByOutputSchema = z.object({ finishBy: z.string().nullable() }).strict();
  export type RoutineSetFinishByInput = z.output<typeof RoutineSetFinishByInputSchema>;
  export type RoutineSetFinishByOutput = z.output<typeof RoutineSetFinishByOutputSchema>;
  ```
- Not here: `finishBy` on the views. Task 3 adds it with its producer, so every task leaves the suite green.

- [ ] **Step 1: Write the failing tests** in `finish-by.test.ts`:
  - `describe("a task's finish date (TASK-951)")`:
    - `it('accepts a real date from 2000 to 2100, a past one included')`: `success` for `'2026-11-14'`, `'2000-01-01'`, `'2100-12-31'`, `'2028-02-29'` and `'2001-01-01'`.
    - `it('refuses anything else with one reason')`: each of these gives `error.issues` of length 1 with this message:
      ```ts
      [['2026-02-30', 'Pick a real date.'], ['2027-02-29', 'Pick a real date.'], ['2026-13-01', 'Pick a real date.'],
       ['2026-11-00', 'Pick a real date.'], ['2101-01-01', 'Pick a real date.'], ['1999-12-31', 'Pick a real date.'],
       ['26-11-14', 'Pick a date.'], ['2026-11-14T00:00:00Z', 'Pick a date.'], [' 2026-11-14', 'Pick a date.'],
       ['\uFF12\uFF10\uFF12\uFF16-11-14', 'Pick a date.'], ['', 'Pick a date.']]
      ```
      The fullwidth digits are escape text, written as backslash-u escapes in the file.
    - `it('gives the same verdict whatever the clock says')`: under `vi.useFakeTimers({ toFake: ['Date'] })` at `2026-01-01` and again at `2099-12-31`, the schema accepts `'2026-11-14'` and `'2001-01-01'` both times. Read paths revalidate (memory `patterns/2026-10-20-TASK-906.md`).
  - `describe("a task's calendar (TASK-951)")`:
    - `it('runs on the cron’s zone, else the active hours’, else UTC')`:
      - cron `America/New_York` with active hours in `Asia/Tokyo` → `'America/New_York'`;
      - interval `15m` with active hours in `Asia/Tokyo` → `'Asia/Tokyo'`;
      - interval with `activeHours: null` → `'UTC'`.
    - `it('reads a calendar date in a time zone, whatever the host’s zone is')`:
      - `calendarDateIn(new Date('2026-11-13T15:30:00Z'), 'Asia/Tokyo')` is `'2026-11-14'`, and in `'UTC'` it's `'2026-11-13'`.
      - Repeat both with `process.env.TZ` set to `'Pacific/Kiritimati'`, then `'Pacific/Pago_Pago'`. Guard each flip with an assertion that `new Date('2026-11-13T15:30:00Z').getHours()` changed, and restore `TZ` in `finally`.
    - `it('counts whole days between two dates')`:
      - `calendarDaysBetween('2026-11-05', '2026-11-14')` → 9;
      - `('2026-12-31', '2027-01-01')` → 1;
      - `('2028-02-28', '2028-03-01')` → 2;
      - `('2026-11-14', '2026-11-14')` → 0;
      - `('2026-11-17', '2026-11-14')` → -3.
    - `it.each` for `calendarDaysUntil` (finishBy, at, tz → n):
      ```ts
      [['2026-03-09', '2026-03-07T17:00:00Z', 'America/New_York', 2],  // across spring-forward (a 23-hour day)
       ['2026-03-09', '2026-03-08T07:00:00Z', 'America/New_York', 1],  // just after the jump
       ['2026-11-02', '2026-10-31T16:00:00Z', 'America/New_York', 2],  // across fall-back (a 25-hour day)
       ['2026-11-14', '2026-11-13T15:30:00Z', 'Asia/Tokyo', 0],        // already the 14th there
       ['2026-11-14', '2026-11-13T15:30:00Z', 'UTC', 1],
       ['2026-11-14', '2026-11-14T23:59:00Z', 'UTC', 0],               // the day itself
       ['2026-11-14', '2026-11-17T12:00:00Z', 'UTC', -3]]              // past
      ```
      The first row is the one a naive `Math.floor((finish - at) / 86_400_000)` gets wrong (it answers 1).
  - `describe('routines:set-finish-by (TASK-951)')`:
    - `it('takes a task key and a date or null, and nothing else')`. The input schema:
      - accepts `{ agentId: 'a', routineId: 'r', finishBy: '2026-11-14' }` and `finishBy: null`;
      - refuses a missing `finishBy`, `finishBy: '2026-02-30'` and an extra key (`note: 'x'`).
    - The output schema accepts `{ finishBy: '2026-11-14' }` and `{ finishBy: null }`, and refuses `{ finishBy: null, revision: 'r' }`.
  - `describe('no tool can set a finish date (TASK-951)')`:
    - `it('the strict create and patch schemas refuse a finishBy key')`:
      - `RoutineCreateToolInputSchema.safeParse({ requestId: 'r', definition: { ...GET_DONE, finishBy: '2026-11-14' } }).success` is false;
      - so is `RoutineUpdateToolInputSchema.safeParse({ requestId: 'r', routineId: 'r', expectedRevision: 'v', patch: { finishBy: '2026-11-14' } }).success`;
      - so are `RoutineDefinitionSchema` and `RoutinePatchSchema` given the same key.
      - `JSON.stringify(RoutineToolJsonSchemas)` does not contain `'finishBy'`.
      - `Object.keys(RoutineToolInputSchemas)` still has the seven tools.

      Here `GET_DONE` is a parsed `get-done` definition (interval `1h`, a `goodWhen`).
- [ ] **Step 2: Run, and expect failures** on the missing exports: `pnpm --filter @ax/routines-contract exec vitest run src/__tests__/finish-by.test.ts`.
- [ ] **Step 3: Implement `finish-by.ts`.**
  - **`RoutineFinishBySchema`** is `z.string().superRefine(...)` with exactly one issue:
    - `'Pick a date.'` unless `/^\d{4}-\d{2}-\d{2}$/` matches (JS `\d` is ASCII-only);
    - else `'Pick a real date.'` unless the date round-trips through `new Date(Date.UTC(y, m - 1, d))` (same year, month and day) and sits between `ROUTINE_FINISH_BY_EARLIEST` and `ROUTINE_FINISH_BY_LATEST` as strings.
    - The year is always 2000–2100 by then, so `Date.UTC`'s 0–99 → 1900s mapping never applies.
  - **`calendarDateIn`** reads the `year`, `month` and `day` parts of `new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)`. Build the formatter once per call (the zone varies). An invalid zone throws `RangeError`, but callers only pass zones `RoutineTimezoneSchema` already accepted on the same runtime.
  - **`calendarDaysBetween`** is the difference of the two `Date.UTC` midnights over `86_400_000`. That is an exact whole number, since UTC has no DST.
  - **The header comment** says:
    - a person sets it; it is a date, not an instant;
    - it is checked only at the writer, and a read refuses quietly (TASK-913);
    - there is no "not in the past" rule, because read paths revalidate and must not depend on the clock (TASK-906);
    - one calendar is shared by the brief, the Tasks row and the page.
  - **In `services.ts`,** the two schemas get this doc, verbatim in substance: "`routines:set-finish-by` (TASK-951): a person sets or removes a "get-done" task's finish date, on its task page. Only the routine's owner may, and only on a get-done task. It never changes the routine's revision. Neither a tool nor an IPC action, so no model can set it. Null removes it."
- [ ] **Step 4: Run, and expect PASS**, with the whole contract suite green (`pnpm --filter @ax/routines-contract test`). Then run `pnpm --filter @ax/routines-contract build`, so Task 2's routines suite sees the new exports.
- [ ] **Step 5: Commit** `[TASK-951] Contract: a task's finish date, its calendar, and routines:set-finish-by's schemas`.

### Task 2: Store: version 12, the stored date, `setFinishBy` [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/migrations.ts`:
  - `RoutinesDefinitionsRow` (:95-103): add `finish_by` with a "Version 12 (TASK-951)" doc;
  - `runRoutinesMigration` (:277-280): add `done(12)` → `addFinishByColumn`;
  - add `addFinishByColumn` above `addGetDoneSteps` (:284).
- Modify: `packages/routines/src/types.ts`: `StoredRoutine` gains `finishBy` after `steps`.
- Modify: `packages/routines/src/definition.ts`: `StoredRoutineSchema` gains `finishBy` after `steps`.
- Modify: `packages/routines/src/store.ts`:
  - the interface: add `setFinishBy` after `clearAgentNotes` (:63-68), and fix the `reconcileOwners` doc (:145-166);
  - the `NO_TASK_STATE` doc (:263-300), plus a new `NO_FINISH_BY`;
  - `rowToRoutine` (:437-446);
  - the `receiptCopy` doc (:490-505) and `withoutTaskState` (:514);
  - `updateAuthored` (:639);
  - the `setFinishBy` implementation, after `clearAgentNotes` (:883-905).
- Create: `packages/routines/src/__tests__/finish-by-store.test.ts`
- Modify tests:
  - `packages/routines/src/__tests__/migrations.test.ts`: every `versions()` list becomes `[2, …, 12]` (17 places), plus two new cases;
  - routines fixtures that build a `StoredRoutine` by hand: add `finishBy: null` at `brief.test.ts:151`, `fire.test.ts:15`, `next-check.test.ts:16` and `return-schemas.test.ts:11`;
  - channel-web fixtures typed `StoredRoutine`: add `finishBy: null` in `src/__tests__/routine-manager-producer.test.tsx:17`, in `src/__tests__/server/routes-workspace-tasks.test.ts` (`stored()` :82; `TEAM_ROWS` :248 is built with it, so it needs nothing), and in the `stored()` helpers of `src/__tests__/server/routes-workspace-task.test.ts` (:110) and `src/__tests__/server/routes-workspace-checkin.test.ts` (:90). `tsc --build` names any others.

**Interfaces:**
- Consumes: `RoutineFinishBySchema` (Task 1).
- Produces:
  ```ts
  // migrations.ts
  finish_by: ColumnType<string | null, string | null | undefined, string | null>;
  // types.ts — StoredRoutine
  /** TASK-951. A "get-done" task's finish date, `YYYY-MM-DD`, set only by a person; null when none, for any other kind, and after a change of kind. */
  finishBy: string | null;
  // definition.ts — StoredRoutineSchema
  finishBy: z.string().nullable().default(null),
  // store.ts — RoutinesStore
  setFinishBy(input: RoutineKey & Actor & { finishBy: string | null }): Promise<{ finishBy: string | null } | 'not-found' | 'forbidden'>;
  ```

- [ ] **Step 1: Write the failing migration tests** in `migrations.test.ts`:
  - **Update every `versions()` list.** Each expectation of `[2, 3, 4, 5, 6, 7, 8, 9, 10, 11]` becomes `[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]` (17 places; `grep -c '10, 11\]'` should then say 0).
  - **`it('version 12 gives a task a finish date column and its check; a re-run keeps both and every date (TASK-951)')`:**
    - Run, then rewind: `ALTER TABLE routines_v1_definitions DROP CONSTRAINT IF EXISTS routines_v1_definitions_finish_by_chk, DROP COLUMN IF EXISTS finish_by` and `DELETE FROM routines_schema_versions WHERE version = 12`.
    - `insertTask()`, then run twice.
    - Check the column: `information_schema.columns` for `finish_by` is `{ data_type: 'text', is_nullable: 'YES', column_default: null }`.
    - `constraintCount('routines_v1_definitions_finish_by_chk', 'routines_v1_definitions')` is 1, and the row's `finish_by` is null.
    - Set `finish_by = '2026-11-14'`, delete version 12, and run again. The value and the single constraint are kept.
  - **`it('refuses a finish_by that isn't YYYY-MM-DD at the database, and takes one that is (TASK-951)')`:**
    - INSERT, not UPDATE, since the schema is dropped before each test. Use `insertTask(sql\`,finish_by\`, sql\`,'Nov 14'\`)`.
    - That rejects with `{ code: '23514', constraint: 'routines_v1_definitions_finish_by_chk' }`.
    - `'2026-11-14'` and NULL insert under other ids. **This half catches a `\d` that Kysely turned into `d`.**
- [ ] **Step 2: Write the failing store tests** in `finish-by-store.test.ts`. Use `fixture()`, `createInput` and `now` from `store-fixture.ts`, a parsed `get-done` definition (interval `1h`) and a copy of `steps-store.test.ts`' `waitsOn(pid)`. Read `revision`, `spec_hash`, `updated_at` and `finish_by` with SQL. Cases:
  - **`it("the owner sets a get-done task's finish date and removes it, and nothing else on the row moves")`.** A freshly created task (`createAuthored`) reads `finishBy: null`. `setFinishBy({ agentId: 'a', routineId, actorUserId: 'owner', finishBy: '2026-11-14' })` answers `{ finishBy: '2026-11-14' }`, and `findOne` shows it. Then `finishBy: null` answers `{ finishBy: null }`. `revision`, `spec_hash` and `updated_at` equal the values from before the first call.
  - **`it('anyone but the owner is forbidden, and the date stays')`.** `actorUserId: 'editor'` (the creating actor, not the owner) → `'forbidden'`, and the column is unchanged.
  - **`it('a stay-on-top task, a repeat routine, a routine that isn't there and a retired agent are not-found')`.** For the retired agent, `INSERT INTO routines_v1_retired_agents (agent_id) VALUES ('a')`.
  - **`it('a change of kind clears it in the edit itself; a change of owner keeps it')`.**
    - Set a date, then call `updateAuthored` with `patch: { kind: 'stay-on-top' }`. The answer and `findOne` have `finishBy: null`, and the column is NULL. Patching back to `get-done` still reads null.
    - A second task: set a date, then `reconcileOwners({ agents: [{ agentId: 'a', ownerUserId: 'new-owner' }] })`. `findOne` keeps `finishBy: '2026-11-14'` while its `task` is null.
  - **`it('a kind change that commits while setFinishBy waits on the row lock makes it not-found')`.**
    - Copy `steps-store.test.ts:175-196`: inside `f.db.transaction()`, `SELECT pg_backend_pid() AS pid … FOR UPDATE`, start `setFinishBy` (don't await), and `waitsOn(pid)`.
    - Then `UPDATE routines_v1_definitions SET kind = 'stay-on-top' …` in the transaction, and return.
    - The waiting call answers `'not-found'`, and `finish_by` is still NULL.
  - **`it('a stored date no calendar has reads as none, and the tick still claims the row')`.**
    - SQL `UPDATE … SET finish_by = '2026-02-30'` (the CHECK allows it) on an enabled task.
    - `findOne(...).finishBy` is null.
    - `claimDue({ now: <past its next run>, limit: 10, claimWindowMinutes: 5 })` returns that row with `finishBy: null`.
  - **`it('a receipt leaves the date out, so code from before version 12 still reads it, and an exact replay answers none')`.**
    - Set a date, then call `updateAuthored` (`patch: { description: 'x' }`). The live answer has `finishBy: '2026-11-14'`.
    - The `routines_v1_requests.result` JSON for that request has no `finishBy` key.
    - The same `updateAuthored` input again answers `finishBy: null`.
    - `acceptDispatch` on the task: the live `accepted.row.finishBy` is `'2026-11-14'` (the brief reads this), and that receipt's `result.row` has no `finishBy` key.
- [ ] **Step 3: Run, and expect failures**, on the shim or Docker (see Global Constraints): `… vitest run src/__tests__/migrations.test.ts src/__tests__/finish-by-store.test.ts`.
- [ ] **Step 4: Implement.**
  - **`addFinishByColumn`:**
    - `ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS finish_by TEXT`;
    - then the named CHECK in the house `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint …) THEN ALTER TABLE … ADD CONSTRAINT routines_v1_definitions_finish_by_chk CHECK (finish_by IS NULL OR finish_by ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'); END IF; END $$;` block (copy `addCheckInMissColumns`, :416-429).
    - Write `[0-9]`, never `\d`: Kysely's `sql` tag sends the cooked template string, so `\d` would arrive as `d`.
    - Its doc covers: TEXT, not `date` (pg-types 2.2.0 parses OID 1082 into a local-midnight `Date`, which shifts the day in some host time zones); format only (the rule's range and real-date checks stay at the writer); NULL means none; the version is additive and rollback-safe; and the one rollback edge (see Rollback).
  - **`storedFinishBy(value: string | null): string | null`** in `store.ts` gives `value` when `RoutineFinishBySchema.safeParse(value).success`, else null. `rowToRoutine` passes `finishBy: storedFinishBy(row.finish_by)`.
  - **`setFinishBy`** takes the agent fence, then the row (clearAgentNotes' order):
    - `lockLiveAgent` false → `'not-found'`;
    - `SELECT kind, owner_user_id … FOR UPDATE`; missing, or `kind !== 'get-done'` (an explicit allowlist) → `'not-found'`;
    - the owner isn't `actorUserId` → `'forbidden'`;
    - one `UPDATE … SET finish_by` → `{ finishBy: input.finishBy }`.
    - No receipt (the same value twice is the same write), and no `revision`, `spec_hash` or `updated_at` change.
  - **`const NO_FINISH_BY = { finish_by: null } as const;`** is documented as "A change of kind clears a task's finish date, as it starts the task over (TASK-907). A change of owner doesn't: the date is about the work, not text from the earlier owner's runs, so it's not in `NO_TASK_STATE`, which `reconcileOwners` also writes." In `updateAuthored`, the kind clause becomes `...(next.kind === current.kind ? {} : { ...NO_TASK_STATE, ...NO_FINISH_BY })`.
  - **`withoutTaskState`** also leaves `finishBy` out. The `receiptCopy` doc changes "All three keys" to four, saying the date is left out not because it's agent text (a person sets it) but for the same rollback reason.
  - **The `reconcileOwners` interface doc** adds: "A get-done task's finish date stays: unlike a change of kind, a change of owner doesn't touch it (TASK-951)." Fix the sentence "as a change of kind does" accordingly.
  - **The `StoredRoutineSchema` comment** says: types only (`rowToRoutine` already read the column through the rule), receipts leave the key out, and the default fills it.
- [ ] **Step 5: Run, and expect PASS.** Then run the whole routines suite (expect 45 files: the 44 of the baseline plus this one) and `pnpm --filter @ax/channel-web exec tsc --build` (fix the `StoredRoutine` fixtures it names). Finish with `pnpm --filter @ax/routines build`.
- [ ] **Step 6: Commit** `[TASK-951] Routines store: a get-done task's finish date (schema version 12), set only through setFinishBy`.

### Task 3: Services, views and tool words [tier: sensitive]

**Files:**
- Modify: `packages/routines-contract/src/definition.ts`: `RoutineViewShape` (:681-699) gains `finishBy` with a doc, so both `RoutineViewSchema` and `RoutineListToolViewSchema` carry it.
- Modify: `packages/routines-contract/src/tools.ts` `RoutineToolDescriptions` (:288-296):
  - `routine_list` and `routine_get` gain the sentence;
  - `routine_update`'s retry sentence names `finishBy`.
- Modify: `packages/routines/src/services.ts`:
  - `ROUTINE_SERVICES` (:11-16) gains `'set-finish-by'` at the end;
  - `routineView` (:35-44) gains `finishBy`;
  - a new `register('set-finish-by', …)` after `clear-notes` (:315-322), with a comment block in the house style.
- Modify: `packages/routines/src/tools.ts`: in the `listToolView` doc (:198-209), note that `finishBy` stays in the list tools' view.
- Create: `packages/routines/src/__tests__/finish-by.test.ts` (through `createRoutineHarness`)
- Modify tests:
  - `packages/routines/src/__tests__/return-schemas.test.ts`;
  - `packages/routines-contract/src/__tests__/finish-by.test.ts` (a new describe);
  - `packages/routines-contract/src/__tests__/report.test.ts` (:247, the retry sentence).
- View-fixture sweep: add `finishBy: null` to these, then run each suite:
  - `packages/routines-contract/src/__tests__/definition.test.ts` (:136, :265-267, :1007, :1189);
  - `misses.test.ts` (:48-58);
  - `report.test.ts` (:165-168 and any other literal view);
  - `packages/routines-admin-routes/src/__tests__/routes.test.ts` (:23-39);
  - `packages/channel-web/src/components/routines/__tests__/routine-fixture.ts` (typed `RoutineView`; tsc names any other).

**Interfaces:**
- Consumes: `RoutineSetFinishByInputSchema` and `RoutineSetFinishByOutputSchema` (Task 1); `store.setFinishBy` and `StoredRoutine.finishBy` (Task 2).
- Produces:
  - `RoutineView.finishBy: string | null`, also on the list tools' view.
  - The service `routines:set-finish-by`, with input `{ agentId, routineId, finishBy: string | null }` and answer `{ finishBy: string | null }`.
  - Its refusals: `SafeToolError('not-found', 'routineId')`, `SafeToolError('forbidden', 'input')`, and `validation` for a bad input.
  - The info line `routines_finish_by_set { agentId, routineId, cleared }`.
  - The view's doc (exact in substance): "TASK-951. A "get-done" task's finish date, `YYYY-MM-DD`, or null: null for any other kind and for a task with none. Only a person sets it, through `routines:set-finish-by`; no tool can. Unlike `task` it isn't owner-gated: it is about the work, holds no agent text, and whoever can see the routine sees it. A read takes it as a type, not the rule (TASK-913). Receipts keep none, so an exact replay's answer has none."

- [ ] **Step 1: Write the failing service tests** in `finish-by.test.ts`, mirroring `clear-notes.test.ts`'s cases and helpers:
  - **`it("the owner sets a get-done task's finish date and removes it; its revision stays")`.** `routines:set-finish-by` answers `{ finishBy: '2026-11-14' }`, and `routines:get` shows it with the created view's `revision`. `{ finishBy: null }` answers `{ finishBy: null }`.
  - **`it('setting the same date twice answers the same and keeps the revision')`.**
  - **`it("on a team agent the date shows to whoever sees the task, and nobody but its owner may set it")`.**
    - `h.teamAdmin` creates a get-done task on `h.teamAgentId` and sets a date.
    - `routines:get` as `h.owner` and as `h.teamMember` shows `finishBy: '2026-11-14'`, while their `task` is null and `steps` is `[]`.
    - Setting as either rejects with `{ toolCode: 'forbidden' }`, and the date stays.
  - **`it("an owner who no longer manages the agent's tasks can still set their own task's date")`.** Copy `clear-notes.test.ts:67-80`'s SQL owner move to `'member'`.
  - **`it("someone who can't see the agent sets nothing")`.** `h.teamMember` on `h.agentId` rejects with `{ code: 'forbidden' }`.
  - **`it("a routine that isn't there, and a stay-on-top task, are not-found")`.** Each rejects with `{ toolCode: 'not-found', field: 'routineId' }`.
  - **`it('a date that isn't real, or a key the service doesn't take, is refused before anything is written')`.** Inputs: `'2026-02-30'`, `'26-11-14'`, and `{ …key, finishBy: '2026-11-14', note: 'x' }`. Each rejects with `{ toolCode: 'validation' }`, and the column stays NULL.
  - **`it("a stay-on-top task's view shows no date even when its row holds one")`.** SQL-set `finish_by` on a stay-on-top task. `routines:get` gives `finishBy: null`.
  - **`it('leaves one routines_finish_by_set line, with ids and whether it cleared')`.** Spy `h.owner.logger.info`. Two calls, set then clear, give exactly `['routines_finish_by_set', { agentId, routineId, cleared: false }]` and then the same with `cleared: true`.
  - **`it('routine_update and routine_create with a finishBy key are refused at pre-call and at execute, and the date stays')`.**
    - In a chat ctx (`makeAgentContext({ ...h.owner, agentId: h.agentId, conversationId: 'chat' })`), `tool:pre-call` for `routine_update` with `patch: { finishBy: '2030-01-01' }` (and the task's current `expectedRevision`) resolves `{ rejected: true }`.
    - `tool:execute:routine_update` rejects with `{ toolCode: 'validation' }`.
    - The same pair for `routine_create` with `definition: { ...getDone, finishBy: '2030-01-01' }`.
    - The stored date is still the one the person set, and `decisions:list` shows no new decision.
- [ ] **Step 2: Write the failing view and contract tests.**
  - In `return-schemas.test.ts`:
    - the base `row` gains `finishBy: null`;
    - `ROUTINE_SERVICES` has length 21 and contains `'routines:set-finish-by'`;
    - `C.RoutineSetFinishByOutputSchema.parse({ finishBy: '2026-11-14' })` round-trips.
  - A new `it("projects a get-done task's finish date to whoever sees it, and none for any other kind")` covers:
    - a get-done row with `finishBy: '2026-11-14'` projects it for its owner and for `'teammate'`;
    - the list tools' view keeps it (`RoutineListToolOutputSchema`/`RoutineUpdateToolOutputSchema` parse a view without `steps` that still has `finishBy`);
    - the same row as `stay-on-top` or `repeat` projects null;
    - `RoutineViewSchema` refuses a view without the key and one with `finishBy: 3`, and accepts `finishBy: 'not a date'` (a type, not the rule).
  - In the contract's `finish-by.test.ts`, a `describe('the tools tell the agent about the date, and that only the person sets it (TASK-951)')` checks:
    - `RoutineToolDescriptions.routine_list` and `.routine_get` each contain `'finishBy is the date the person wants a "get-done" task finished by, or null. Only the person sets it.'`;
    - `.routine_update` contains `'A retry of an edit that already went through answers with task, noRecentUpdate and finishBy null, so read the task with routine_get.'`;
    - `.routine_create` and `.routine_report` don't contain `'finishBy'`.
  - Update `report.test.ts:247` to the new retry sentence.
- [ ] **Step 3: Run, and expect failures** in the contract suite, `return-schemas.test.ts` and `finish-by.test.ts`.
- [ ] **Step 4: Implement.**
  - **`RoutineViewShape`:** `finishBy: z.string().nullable()`.
  - **`routineView`:** `finishBy: row.kind === 'get-done' ? row.finishBy : null` (an explicit allowlist, like `stepsView`). It is not owner-gated (card decision 5).
  - **The service:** `access(ctx, input.agentId)`, then `store.setFinishBy({ agentId, routineId, actorUserId: ctx.userId, finishBy: input.finishBy })`.
    - Map `'not-found'` and `'forbidden'` exactly as `clear-notes` does (:318-319).
    - Log, then return `{ finishBy: outcome.finishBy }`. There is no `requireAllowed`: the owner may set it whether or not they still manage the agent's tasks, since it adds no reach.
    - The comment block says that, plus "under the routine's row lock", "neither a tool nor an IPC action", and that the log line carries ids and a flag only.
  - **Descriptions:** insert the sentence just before "A task’s noRecentUpdate counts…" in both `routine_list` and `routine_get`.
  - **The fixture sweep** per Files.
- [ ] **Step 5: Run, and expect PASS.** First run `pnpm --filter @ax/routines-contract build`: the routines suite and the admin routes load the contract from `dist/`, and the old build's strict view schemas refuse `finishBy`. Then check:
  - `pnpm --filter @ax/routines-contract test`;
  - the routines suite (expect 46 files);
  - `pnpm --filter @ax/routines-admin-routes test` (with Docker down, only `routes.test.ts` or the shim; see Global Constraints);
  - `pnpm --filter @ax/channel-web exec tsc --build`;
  - `pnpm build`.
- [ ] **Step 6: Commit** `[TASK-951] routines:set-finish-by: the owner sets a get-done task's finish date; every view shows it`.

### Task 4: The brief, the accept time and the canary [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/brief.ts`:
  - the module header (:9-13);
  - the `renderTaskBrief` doc and signature (:75-97);
  - `checkInBrief` (:148-161);
  - new private constants and a helper for the paragraph.
- Modify: `packages/routines/src/fire.ts`:
  - `PendingFire` (:24-50) gains `acceptedAt`;
  - destructure it at :169 and set it at :297-302.
- Modify tests:
  - `packages/routines/src/__tests__/brief.test.ts`: the `entry()` helper (:154) gains `acceptedAt`, plus new cases;
  - `packages/routines/src/__tests__/fire.test.ts`: the `setup()` option `finishBy`, the `pendingEntry` helper (:246) and the `h.pending.set` literal (:99) gain `acceptedAt`, plus a new case;
  - `packages/routines/src/__tests__/canary.test.ts`: a new describe at the end.

**Interfaces:**
- Consumes: `taskTimeZone`, `calendarDateIn` and `calendarDaysBetween` (Task 1); `StoredRoutine.finishBy` and `store.setFinishBy` (Task 2); `routines:set-finish-by` (Task 3).
- Produces:
  ```ts
  // fire.ts — PendingFire
  /** When the run was accepted (`AcceptedDispatch.acceptedAt`). Its brief counts a finish date's days from this day, in the task's time zone, as its row is the snapshot read then (TASK-951). */
  acceptedAt: Date;
  // brief.ts
  export function renderTaskBrief(
    row: { name: string; promptBody: string; goodWhen: string | null; kind: RoutineKind; finishBy: string | null },
    today: string,
  ): string;
  ```
  Here `today` is a `YYYY-MM-DD`. `checkInBrief` computes `today = calendarDateIn(entry.acceptedAt, taskTimeZone(entry.row))` and calls `renderTaskBrief(entry.row, today)`.

- [ ] **Step 1: Write the failing brief tests** in `brief.test.ts`. Use a `GET_DONE` brief (`{ ...SUPPORT_QUEUE, kind: 'get-done' as const }`), where `paragraphs = (b: string) => b.split('\n\n')`. The copy is exact:
  - **`it("a get-done task's brief says how many days are left, right after its going-well-when (TASK-951)")`.** In `renderTaskBrief({ ...GET_DONE, finishBy: '2026-11-14' }, '2026-11-05')`, the paragraph straight after the one starting `'Going well when, in the person’s words:'` is exactly:
    `The person wants this finished by Saturday, 14 November 2026. That’s 9 days from today (Thursday, 5 November 2026). If the steps left won’t fit before then, report "off-track" and say why in your update.`
    The next one starts `'How this check-in works:'`.
  - **`it('says 1 day, and "today" on the day itself')`.**
    - With today `'2026-11-13'`, the paragraph contains `That’s 1 day from today (Friday, 13 November 2026).`
    - With today `'2026-11-14'`, the paragraph is exactly `The person wants this finished today (Saturday, 14 November 2026). If the steps left won’t fit before then, report "off-track" and say why in your update.`
  - **`it('after the date, asks for off-track unless it’s done')`.**
    - With today `'2026-11-17'`, the paragraph is exactly `The person wanted this finished by Saturday, 14 November 2026, 3 days ago. Report "off-track" unless it’s done, and say in your update what’s left.`
    - With today `'2026-11-15'`, it contains `, 1 day ago.`
  - **`it('adds nothing without a date, or for a stay-on-top task')`.**
    - `renderTaskBrief({ ...GET_DONE, finishBy: null }, '2026-11-05')` equals `renderTaskBrief({ ...GET_DONE }, '2026-11-05')`, and neither contains `'The person want'`.
    - `renderTaskBrief({ ...SUPPORT_QUEUE, finishBy: '2026-11-14' }, '2026-11-05')` equals `renderTaskBrief(SUPPORT_QUEUE, '2026-11-05')`.
  - **`it.each` "counts from the accept day in the task’s own time zone, not UTC’s: %s".** Build the pending entry as `new Map([['rA', { ...entry(row), acceptedAt }]])`. The row is `{ ...storedRow({ ...TASK, kind: 'get-done', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'America/Los_Angeles' } }), finishBy: '2026-11-14' }`. Each `acceptedAt` is 18:00 the evening before in Los Angeles, so UTC would count one day fewer. `checkInBrief(pending, runCtx()).brief` contains:
    - `2026-11-05T02:00:00Z` → `That’s 10 days from today (Wednesday, 4 November 2026).` (UTC would say 9);
    - `2026-11-15T02:00:00Z` → `The person wants this finished today (Saturday, 14 November 2026).` (UTC would say 1 day ago);
    - `2026-11-18T02:00:00Z` → `The person wanted this finished by Saturday, 14 November 2026, 3 days ago.` (UTC would say 4).
  - **Control case.** The same row with `trigger: { kind: 'interval', every: '1h' }` and no active hours (UTC), accepted at `2026-11-05T02:00:00Z`, contains `That’s 9 days from today (Thursday, 5 November 2026).`
- [ ] **Step 2: Write the failing fire test** in `fire.test.ts`: `it("a check-in's brief counts from the day it was accepted, in the task's time zone, not the clock when the brief is built (TASK-951)")`.
  - `setup({ definition: { kind: 'get-done', goodWhen: 'Done when it is done.', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'America/Los_Angeles' } }, finishBy: '2031-01-10' })`. The new option calls `f.store.setFinishBy({ …, actorUserId: 'owner', finishBy })` before the accept.
  - `await h.fire(h.accepted)`. The pending entry has `acceptedAt` equal to `h.accepted.acceptedAt` (the fixture's `now`, 2031-01-01T00:00Z, which is 16:00 on 31 December in Los Angeles).
  - `checkInBrief(h.pending, makeAgentContext({ reqId: h.accepted.reqId, sessionId: 's', agentId: 'a', userId: 'owner', conversationId: 'c', source: 'routine' })).brief` contains `That’s 10 days from today (Tuesday, 31 December 2030).`
  - The wall clock is years earlier, so a brief built from `new Date()` fails this.
- [ ] **Step 3: Write the failing canary** in `canary.test.ts`: `describe('finish-by canary (TASK-951)')`, `it("a person sets a get-done task's finish date, its revision stays, and the next check-in's brief counts the days to it")`.
  - Use `createCheckInHarness({ clock })` with a fixed clock at `2026-11-05T15:00:00Z`. Copy the parked `sleep` from `describe('PR 1 backend canary (TASK-908)')`'s `clock` (:475-484).
  - Steps, in order:
    1. Create a get-done task (interval `1h`, no active hours) through `routines:create` as `h.owner` on `h.agentId`.
    2. `routines:set-finish-by` with `'2026-11-14'` answers `{ finishBy: '2026-11-14' }`.
    3. `routines:get` shows `{ finishBy: '2026-11-14', revision: task.revision }`.
    4. `ch.checkIn(task, 'run-1', body)` with the view **as created**. Its Check now carries the original revision, so it starts only if the date didn't move it. The body reports on-track through `tool:execute:routine_report` with `routineRunner(ctx)`.
  - The check-in's `brief.brief` contains `The person wants this finished by Saturday, 14 November 2026. That’s 9 days from today (Thursday, 5 November 2026). If the steps left won’t fit before then, report "off-track" and say why in your update.`
- [ ] **Step 4: Run, and expect failures**: `… vitest run src/__tests__/brief.test.ts src/__tests__/fire.test.ts src/__tests__/canary.test.ts`.
- [ ] **Step 5: Implement.**
  - **`renderTaskBrief`** pushes the paragraph after the going-well-when part when `row.kind === 'get-done' && typeof row.finishBy === 'string'`. The `typeof` keeps older call sites without the field working.
  - **`n = calendarDaysBetween(today, row.finishBy)`.** One `Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })` constant spells both dates (on `${date}T00:00:00Z`). `n === 1` and `-n === 1` say "1 day".
  - **Rule 5 — two lines this card makes false.**
    - The module header's "so nothing an agent can change reaches it" becomes: built from what the person wrote, a date only the person sets, and fixed text, so no text an agent can change reaches it; the schedule's time zone picks only which calendar day is today.
    - The `renderTaskBrief` doc says "never `description`, the schedule or anything else an agent can change". It becomes: it also takes a get-done task's finish date, which no tool can reach (only a person sets it, through `routines:set-finish-by`), so it may sit beside the person's approved fields (TASK-906 decisions row 18). `today` is the run's accept date in the task's time zone (`taskTimeZone`). An agent that edits the schedule under Always Allow can move that day, and so the count, by up to two days, but no text from the schedule reaches the brief. Never `description` or anything else an agent can change.
  - **`fire.ts`** sets `acceptedAt: accepted.acceptedAt` on the pending entry.
- [ ] **Step 6: Run, and expect PASS**, with the whole routines suite green (still 46 files). Then run `pnpm --filter @ax/routines build`.
- [ ] **Step 7: Commit** `[TASK-951] The check-in brief counts the days to a get-done task's finish date, from the day the run was accepted`.

### Task 5: channel-web server: the date on the wire and `PUT …/finish-by` [tier: sensitive]

**Files:**
- Modify: `packages/channel-web/src/server/routes-workspace.ts`:
  - the header route list (:8-12) gains the PUT line;
  - `TaskListView` (:752-755) picks `'finishBy' | 'trigger' | 'activeHours'`, and `TaskDetailView` (:767-781) picks `'finishBy'`;
  - add `toTaskFinishBy` after `toTaskStepCounts` (:3549-3553), and `readTaskFinishByBody` after `readTaskReplyBody` (:3655-3661);
  - `toTaskRows` (:3447) gains `now: Date` and `finishBy`, and its doc a sentence;
  - `toTaskDetail` (:3698) gains `now: Date` and `finishBy`, and its doc a sentence;
  - `tasksForAgent` (:4670) and `taskDetail` (:7449) pass `now()`;
  - add the `setTaskFinishBy` handler after `taskReply` (:7513-7558), and its route after `/replies` (:9925-9931).
- Modify: `packages/channel-web/src/lib/workspace-types.ts`:
  - add `TaskFinishBy` and `TaskFinishByResponse` after `TaskStepCounts` (:1393-1396);
  - `TaskRow` (:1399-1412) and `TaskDetail` (:1497-1522) gain `finishBy`.
- Modify: `packages/channel-web/src/server/plugin.ts`: the comment block (:62-90) gains a TASK-951 line, and `optionalCalls` gains the hook right after `routines:recent-replies` (:354-358).
- Modify tests:
  - `src/__tests__/server/routes-workspace-task.test.ts`: world fields, the stub, `setup({ now })`, a `finishBy()` driver, and the "without routines at all" list (:952-958) gains `'routines:set-finish-by'`;
  - `src/__tests__/server/routes-workspace-tasks.test.ts`;
  - `src/__tests__/server/routes-workspace-registration.test.ts` (:60-70);
  - `src/__tests__/server/plugin.test.ts` (the `optionalCalls` pin, :783-806);
  - the client fixtures `tsc --build` names for the now-required `TaskRow.finishBy`/`TaskDetail.finishBy`. Expect `TaskPage.test.tsx`, `TasksPage.test.tsx`, `TodayTaskGroup.test.tsx`, `TodayView.test.tsx`, `WorkspaceShell*.test.tsx`, `consent-focus.test.tsx`, `task-groups.test.ts`, `today-queue.test.ts` and the `workspace-api-task*`/`workspace-task*` tests. Each gets `finishBy: null`.

**Interfaces:**
- Consumes: `RoutineView.finishBy` (Task 3); `RoutineFinishBySchema`, `taskTimeZone` and `calendarDaysUntil` (Task 1); `RoutineSetFinishByInputSchema`/`OutputSchema` (Task 1, in the test stub).
- Produces:
  ```ts
  // workspace-types.ts
  /**
   * TASK-951. A "get-done" task's finish date and the whole days left to it. `date` is the
   * person's `YYYY-MM-DD`; `daysLeft` is counted on the host in the TASK's own time zone
   * (its schedule's, else its active hours', else UTC), not the reader's, so the page, the
   * row and the check-in's brief agree: 0 on the day, negative after. A count, not a
   * display string; the page words it.
   */
  export interface TaskFinishBy { date: string; daysLeft: number }
  /** `PUT /api/workspace/tasks/:agentId/:routineId/finish-by`'s answer (TASK-951). */
  export interface TaskFinishByResponse { finishBy: TaskFinishBy | null }
  // TaskRow and TaskDetail
  /** TASK-951. Null unless the task is "get-done" and has a finish date. */
  finishBy: TaskFinishBy | null;
  ```
  - **`PUT /api/workspace/tasks/:agentId/:routineId/finish-by`** takes the body `{ finishBy: string | null }` and runs, in order:
    1. `authOr401`;
    2. `taskKeyOr400` (400 `missing-task-id`);
    3. the body: JSON that is an object with an own `finishBy` that is a string or null, else 400 `finish-by-body-invalid` (unparseable JSON included). Anything else in the body is left behind;
    4. without `routines:set-finish-by`, 503 `task-finish-by-unavailable`;
    5. `ownTaskOr404`, for the task's time zone (`agent-not-found` or `task-not-found`, nothing written);
    6. `routines:set-finish-by` as the caller, with `{ agentId, routineId, finishBy }` built field by field. A `SafeToolError` `validation` gives 400 `finish-by-invalid`, checked before `isTaskRefusal`. A refusal gives 404 `task-not-found`. Anything else fails the request;
    7. 200 `{ finishBy: toTaskFinishBy({ ...own.view, finishBy: out.finishBy }, now()) }`.
  - **`toTaskFinishBy(view: Pick<RoutineView, 'kind' | 'finishBy' | 'trigger' | 'activeHours'>, now: Date): TaskFinishBy | null`** is null unless `view.kind === 'get-done'`, `finishBy` is a string and `RoutineFinishBySchema` accepts it. Otherwise it gives `{ date, daysLeft: calendarDaysUntil(date, now, taskTimeZone(view)) }`. It is lenient about a view the schema didn't parse (TASK-913).
  - **The `optionalCalls` entry:** `{ hook: 'routines:set-finish-by', degradation: 'Setting or removing a finish date on the task page (PUT /api/workspace/tasks/:agentId/:routineId/finish-by) answers 503 and the date stays as it was' }`. Its comment: "TASK-951 — a person sets or removes a "get-done" task's finish date. The service decides who may (the task's owner), under the routine's row lock."

- [ ] **Step 1: Write the failing route tests.**
  - **Shared setup in `routes-workspace-task.test.ts`:**
    - `setup()` gains `now?: () => Date`, passed to `makeWorkspaceHandlers` as `...(now === undefined ? {} : { now })`, and the world field `finishByFailure: Error | null`. `WorkspaceHandlerDeps.now` is optional, and channel-web's tsc checks test files with `exactOptionalPropertyTypes`, so passing `now: undefined` fails the build.
    - A `routines:set-finish-by` stub (unless absent) that:
      - records `{ userId, agentId, input }` and pushes to `order`;
      - runs `parseRoutineInput(RoutineSetFinishByInputSchema, raw)` first, as the service does;
      - throws `finishByFailure` if set, else answers `{ finishBy: input.finishBy }`, with `returns: RoutineSetFinishByOutputSchema`.
    - A `finishBy(params, body)` driver that calls `handlers.setTaskFinishBy`.
  - **New detail case:** `it("a get-done task's page carries its finish date and the days left in the task's own time zone (TASK-951)")`.
    - A stored get-done row (cron `0 9 * * *` in `America/Los_Angeles`, `finishBy: '2026-11-14'`), with `now` at `2026-11-05T02:00:00Z`.
    - `body.finishBy` is `{ date: '2026-11-14', daysLeft: 10 }`.
    - A stay-on-top view carrying a date gives null: `unvalidated: true, viewPatch: { finishBy: '2026-11-14' }`. An unparsed view, because routines' own `routineView` already nulls it, and this case must pin the route's own kind gate.
    - With `unvalidated: true, viewPatch: { finishBy: '2026-13-45' }` on the get-done row, it is null and the page still answers 200.
  - **`describe('PUT /api/workspace/tasks/:agentId/:routineId/finish-by (TASK-951)')`:**
    - **401** when `viewer: null`, and nothing is called.
    - **400 `missing-task-id`** for blank ids.
    - **400 `finish-by-body-invalid`** for `Buffer.from('not json')`, `{}`, `{ finishBy: 14 }`, `[]` and `null`. No hook is called.
    - **503 `task-finish-by-unavailable`** with `absent: new Set(['routines:set-finish-by'])`. Nothing is read.
    - **404:**
      - an agent the caller can't reach (`agent-not-found`);
      - someone else's task and a repeat routine (`task-not-found`, with no `routines:set-finish-by` call);
      - `finishByFailure` set to `new SafeToolError('not-found', 'routineId')` (a stay-on-top task) and to `new SafeToolError('forbidden', 'input')`.
    - **400 `finish-by-invalid`** for `{ finishBy: '2026-02-30' }`. The stub's own input check refuses it.
    - **200** `{ finishBy: { date: '2026-11-14', daysLeft: 10 } }` for the Los Angeles task at `2026-11-05T02:00:00Z`. The stub got exactly `{ agentId: 'a1', routineId: 't1', finishBy: '2026-11-14' }`, though the body also held `extra: 1`. `order` is `['routines:get', 'routines:set-finish-by']`.
    - **200** `{ finishBy: null }` for `{ finishBy: null }`.
    - A plain `new Error('db down')` from the stub rejects the handler: "we don't know" must not read as "not found".
  - **In `routes-workspace-tasks.test.ts`:** `it("each get-done row carries its finish date and the days left in its own task's time zone (TASK-951)")`.
    - Two get-done rows with `'2026-11-14'` at `now = 2026-11-05T02:00:00Z`: one with a cron in `America/Los_Angeles` gives `daysLeft: 10`, and one with an interval and no active hours (UTC) gives 9.
    - A stay-on-top row gives `finishBy: null`.
    - Inject `now` through that file's `makeWorkspaceHandlers` call (:226), spread in only when set, as above.
    - That file's untyped `expect(t1).toEqual({…})` at :294-310 gains `finishBy: null`. tsc can't see it, and once the route sends `finishBy: null` a missing key no longer matches.
  - **In `routes-workspace-registration.test.ts`:** `expect(routes).toContain('PUT /api/workspace/tasks/:agentId/:routineId/finish-by')`.
  - **In `plugin.test.ts`:** the `optionalCalls` pin gains the entry, exactly, after `routines:recent-replies`.
- [ ] **Step 2: Run, and expect failures**: `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-workspace-task.test.ts src/__tests__/server/routes-workspace-tasks.test.ts src/__tests__/server/routes-workspace-registration.test.ts src/__tests__/server/plugin.test.ts`.
- [ ] **Step 3: Implement** per Interfaces. Add the fixtures `tsc --build` names. `manifest-declarations.test.ts` then passes on its own, because the new `bus.hasService`/`bus.call` literals are declared.
- [ ] **Step 4: Run, and expect PASS.** Then run `tsc --build`, the channel-web suite (minus the six Docker files if Docker is down) and `pnpm build`.
- [ ] **Step 5: Commit** `[TASK-951] channel-web: a get-done task's finish date on the Tasks list and the task page, and PUT …/finish-by`.

### Task 6: channel-web client: the task page's Finish by and the Tasks row [tier: integration]

Invoke the `shadcn` skill (`-c packages/channel-web`) and the `ux-design` skill before writing the component. Use installed primitives only: `Button` (`link`, `ghost`, default; `size="sm"`), `Field`, `FieldLabel`, `FieldDescription`, `FieldError`, `FieldGroup`, `Input` (`type="date"`) and `Spinner`, with semantic tokens.

**Files:**
- Create: `packages/channel-web/src/lib/task-finish-by.ts` and `packages/channel-web/src/lib/__tests__/task-finish-by.test.ts`
- Create: `packages/channel-web/src/components/workspace/TaskFinishDate.tsx` and `packages/channel-web/src/components/workspace/__tests__/TaskFinishDate.test.tsx`
- Modify: `packages/channel-web/src/lib/workspace-api.ts`:
  - add `isTaskFinishBy` near `isTaskReading` (:462);
  - `withRowDefaults` (:503-513), `isTaskRow` (:550-563) and `isTaskDetail` (:666-687);
  - add `setTaskFinishBy` after `sendTaskReply` (:1187-1202).
- Modify: `packages/channel-web/src/lib/workspace-task.ts`: `useTask` gains `applyAnswer`.
- Modify: `packages/channel-web/src/components/workspace/TaskPage.tsx`:
  - the header doc (:1-21);
  - `TaskPage` passes `onFinishBySaved` (:294, :360-373);
  - `TaskBody` renders `TaskFinishDate` right after the meta `<p>` (:523).
- Modify: `packages/channel-web/src/components/workspace/TasksPage.tsx`: the `TaskItem` doc (:314-321) and `secondLine` (:353-358).
- Modify tests:
  - `src/lib/__tests__/workspace-api-task.test.ts`, `workspace-api-tasks.test.ts` and `workspace-task.test.ts`;
  - `src/components/workspace/__tests__/TaskPage.test.tsx` (its `workspaceApi` mock, :25-31, gains `setTaskFinishBy: vi.fn()`) and `TasksPage.test.tsx`.

**Interfaces:**
- Consumes: `TaskFinishBy`, `TaskFinishByResponse` and the PUT route (Task 5); `RoutineFinishBySchema` (Task 1).
- Produces:
  ```ts
  // lib/task-finish-by.ts
  /** "9 days left", "1 day left", "Due today", "1 day past its finish date", "3 days past its finish date". */
  export function finishByCount(daysLeft: number): string;
  /** The date as the reader's language writes it, in UTC so no time zone moves the day: "Sat, Nov 14" in en-US. `locale` is for tests. */
  export function finishByDate(date: string, locale?: string): string;
  /** "Finish by Sat, Nov 14 · 9 days left". */
  export function finishByLine(finishBy: TaskFinishBy, locale?: string): string;
  /** Today on the browser's own calendar, `YYYY-MM-DD` (local getters). */
  export function browserToday(now?: Date): string;
  /** Why a pick can't be saved, or null: '' or before `today` → 'Pick today or a later date.'; else the contract's own message ('Pick a date.' / 'Pick a real date.'). */
  export function finishByPickIssue(value: string, today: string): string | null;
  // lib/workspace-api.ts
  setTaskFinishBy: (agentId: string, routineId: string, finishBy: string | null) => Promise<TaskFinishByResponse>;
  // lib/workspace-task.ts — useTask's return
  /** Shows a write's answer on the task at once, then reads the task again (as `refresh` does), so a read already on its way, which was asked before the write, can't put the old value back: only the newest read's answer is kept. */
  applyAnswer: (update: (detail: TaskDetail) => TaskDetail) => void;
  // components/workspace/TaskFinishDate.tsx
  export function TaskFinishDate(props: {
    agentId: string; routineId: string; agentName: string;
    finishBy: TaskFinishBy | null;
    onSaved: (finishBy: TaskFinishBy | null) => void;
  }): ReactElement;
  ```
- **Copy (exact):** label `Finish by`; buttons `Add a finish date`, `Change`, `Save`, `Remove date` and `Cancel`.
  - Helper: `${agentName} will tell you if the steps left won’t fit.`
  - Refusals:
    - `Pick today or a later date.`;
    - `We couldn’t save that date. Try again.` (unconfirmed: network, 5xx, 408, 429, a shape error, or any other status);
    - `We couldn’t find this task any more. It may have been deleted.` (403 or 404);
    - `Pick a real date.` (400);
    - `HTTP_SESSION_ENDED` (401).
- **The `task-finish-by.ts` header comment** says why "days left" isn't the ETA that `bits.tsx`' "Elapsed, never remaining" forbids. It counts days to a date the person picked, so it is no estimate.

- [ ] **Step 1: Write the failing lib tests** in `task-finish-by.test.ts`:
  - `finishByCount`: 9 → `'9 days left'`, 1 → `'1 day left'`, 0 → `'Due today'`, -1 → `'1 day past its finish date'`, -3 → `'3 days past its finish date'`.
  - `finishByDate('2026-11-14', 'en-US')` → `'Sat, Nov 14'`, and the same with `process.env.TZ` set to `'Pacific/Kiritimati'` and to `'Pacific/Pago_Pago'`. Use the guard-and-restore pattern from Task 1.
  - `finishByLine({ date: '2026-11-14', daysLeft: 9 }, 'en-US')` → `'Finish by Sat, Nov 14 · 9 days left'`.
  - `browserToday(new Date(2026, 10, 5, 23, 59))` → `'2026-11-05'`, and `browserToday(new Date(2026, 0, 1, 0, 0))` → `'2026-01-01'`.
  - `finishByPickIssue`: `('', '2026-11-05')` and `('2026-11-04', '2026-11-05')` → `'Pick today or a later date.'`; `('2026-11-05', '2026-11-05')` → null; `('2026-02-30', '2026-01-01')` and `('2101-01-01', '2026-01-01')` → `'Pick a real date.'`.
- [ ] **Step 2: Write the failing API and hook tests.**
  - **`workspace-api-task.test.ts`:**
    - the detail must carry `finishBy`: absent is a `WorkspaceShapeError`; `null` and `{ date: '2026-11-14', daysLeft: -3 }` read; `{ date: '2026-02-30', daysLeft: 1 }` and `{ date: '2026-11-14', daysLeft: 1.5 }` are refused.
    - `setTaskFinishBy('a 1', 'r/1', '2026-11-14')` sends `PUT /api/workspace/tasks/a%201/r%2F1/finish-by` with the JSON body `{ finishBy: '2026-11-14' }` and the write headers, and returns the checked answer.
    - An answer without `finishBy` is a `WorkspaceShapeError`, and a 404 is a `WorkspaceApiError` with status 404.
  - **`workspace-api-tasks.test.ts`:**
    - First add `finishBy: null` to `ROW` (:22-38). It is untyped and goes through `respondWith(body: unknown)`, so tsc can't see it. Once `withRowDefaults` fills `finishBy: null`, the exact-match cases at :54, 67, 77, 97, 110, 118, 141, 149, 164 and 193 fail without it.
    - Then: a row without `finishBy` (an older host, `ROW` with the key deleted from a copy) reads as `finishBy: null`, and a malformed one fails the read.
  - **`workspace-task.test.ts`:** `it("applyAnswer shows a write's answer at once, and a read that was already on its way can't put the old value back")`, using the file's `deferred()`.
    - Load a detail with `finishBy: null`, then start a quiet re-read (`refreshQuietly`) whose answer is deferred.
    - `applyAnswer(d => ({ ...d, finishBy: SAVED }))` shows `SAVED` at once.
    - Resolve the quiet read with `finishBy: null`: the state still shows `SAVED`. Resolve the newer read with `SAVED`, and it shows `SAVED` with `refreshing: false`.
    - Second case: the newer read fails. `SAVED` stays, with `refreshFailed: true`.
- [ ] **Step 3: Write the failing component tests** in `TaskFinishDate.test.tsx`. Mock `workspaceApi.setTaskFinishBy`. Use `vi.useFakeTimers({ toFake: ['Date'] })` at local `new Date(2026, 10, 5, 12)` and `fireEvent`, since `user-event` isn't installed. Render `TaskFinishDate` inside a small test wrapper that keeps `finishBy` in `useState` and passes `onSaved` through to its setter, as `TaskPage` does through `applyAnswer`. Without it, the focus assertions after Save and after Remove never see the new button. jsdom matches browsers on date inputs (measured): a value no calendar has (`'2026-02-30'`) or that isn't a date reads back as `''`, while a past date is kept. So the field never holds an impossible date. "Pick a real date." reaches the component only through the server's 400, which the status case below drives. `finishByPickIssue`'s own schema branch is covered by the lib test.
  - **`it('shows the date and the days left, with Change described by that line')`.** The line `finishByLine(FB)` (derived, no pinned locale) is visible, and the `Change` button's accessible description includes it.
  - **`it('offers Add a finish date when there is none, and no Remove date in its field')`.**
  - **`it('adds a date: the field opens focused, refuses nothing it shouldn’t, saves once, and hands focus back')`.**
    - Open: the `Finish by` date input has focus and `min="2026-11-05"`, and the helper reads `Caveman will tell you if the steps left won’t fit.`
    - Change it to `'2026-11-14'`, then Save. `setTaskFinishBy` is called exactly once with `('a1', 't1', '2026-11-14')`, and `onSaved` gets the answer.
    - The field closes, and focus is on `Change`.
  - **`it('changes and removes a date')`.**
    - The field opens prefilled with the current date.
    - `Remove date` sends `null`, `onSaved(null)` follows, and focus lands on `Add a finish date`.
  - **`it('refuses a past or empty pick with no request')`.** For `'2026-11-04'` and `''`, the `FieldError` is `Pick today or a later date.`, the input has `aria-invalid="true"`, and `setTaskFinishBy` is not called.
  - **`it('Cancel and Escape close the field with no request, and focus goes back')`.**
  - **`it.each` per status:**
    - `new WorkspaceApiError(path, 404)` → `We couldn’t find this task any more. It may have been deleted.`, and Save and Remove are disabled afterwards (pressing again can't work);
    - 400 → `Pick a real date.`;
    - 401 → `HTTP_SESSION_ENDED`, and Save and Remove are disabled afterwards too;
    - 500 → `We couldn’t save that date. Try again.`
  - **`it('a save nobody could confirm says so, and pressing Save again sends the same date')`.** The first call rejects with `new TypeError('Failed to fetch')` and shows `We couldn’t save that date. Try again.` The second resolves: `setTaskFinishBy` saw `'2026-11-14'` both times, and `onSaved` follows.
- [ ] **Step 4: Write the failing page tests.**
  - **`TaskPage.test.tsx`:**
    - `it("a get-done task shows its finish date under the meta line; a stay-on-top task shows no finish date at all")`. The stay-on-top case has a `finishBy` set, so the client gate is pinned.
    - `it("a saved date shows at once, and the page reads the task again")`. `taskMock` is called again after Save, and the new line stays when that read answers.
  - **`TasksPage.test.tsx`:** `it("a get-done row says how long is left after its steps")`:
    - `Caveman · 2 of 5 steps · 9 days left`, `… · Due today` and `… · 3 days past its finish date`;
    - a get-done row with no steps yet and a date: `Caveman · 9 days left` (never reported) or `Caveman · checked … · 9 days left`;
    - nothing for a get-done row without a date, and nothing for a stay-on-top row that carries one.
- [ ] **Step 5: Run, and expect failures**, file by file, then implement.
  - **`isTaskFinishBy(v)`** requires a record with a string `date` that `RoutineFinishBySchema` accepts and an integer `daysLeft`. A refused date would make `Intl` throw during render.
  - **`isTaskRow`** takes an absent `finishBy`, null, or `isTaskFinishBy`, and `withRowDefaults` fills an absent one with `null`. `isTaskDetail` requires `'finishBy' in b` and null or `isTaskFinishBy`.
  - **`setTaskFinishBy`** is `req(path, { method: 'PUT', body: { finishBy } })` plus `checkedRead`.
  - **`applyAnswer`** is `setState(s => (s.kind === 'ready' ? { ...s, detail: update(s.detail), refreshing: true } : s)); load(false);`. That is the existing numbering, so the older read is dropped.
  - **`TaskPage`** passes `onFinishBySaved = (finishBy) => applyAnswer(d => ({ ...d, finishBy }))` to `TaskBody`. That renders `{detail.kind === 'get-done' && <TaskFinishDate … />}` right after the meta `<p>`.
  - **`TaskFinishDate`** follows `TaskReplyBox`'s shape: a `form`, a `Field` with `data-invalid`, `aria-describedby` on the helper and the error, and refs for focus.
  - **`TasksPage`** appends `` ` · ${finishByCount(row.finishBy.daysLeft)}` `` to whichever second line the row has, when `row.kind === 'get-done' && row.finishBy !== null`.
  - **Rule 5:** the `TaskPage` header doc and the `TaskItem` doc mention the date.
- [ ] **Step 6: Run, and expect PASS.** Then run `tsc --build`, the channel-web suite and `pnpm build`.
- [ ] **Step 7: Run `security-checklist` over the whole branch diff.** Finish the PR's security note (see above) with anything it adds.
- [ ] **Step 8: Commit** `[TASK-951] The task page sets a get-done task's finish date, and the Tasks row says how long is left`.

### Task 7: Docs: the design doc [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`

- [ ] **Step 1: Edit the sections below.**
  - **Resume here, the PR 3 "Now:" line (:32).** After the TASK-948 clause, insert `; TASK-951 adds a Finish by date that only a person sets (schema version 12)`.
  - **§3.4, after the TASK-948 note.** Add:
    > PR 3 (TASK-951): A "Get something done" task can have a Finish by date that only a person sets, on its task page, under its kind and schedule (Add a finish date; Change or Remove date). It's a date, not a time, read in the task's own time zone (its schedule's, else its active hours', else UTC). The page says "Finish by Sat, Nov 14 · 9 days left", "Due today" or "3 days past its finish date", and the Tasks row adds the count after its steps. Each check-in's brief says how many days are left and asks the agent to report Off track when the steps left won't fit; ax never works that out itself. No agent or tool can set it. A change of kind clears it, a change of owner keeps it, and Duplicate (TASK-953) leaves it behind.
  - **§4.5's table.**
    - Append `(TASK-951: a "get-done" task's Finish by date is a column of its own beside the definition, schema version 12; only a person sets it, and it's in no tool's input.)` to the "Routine definition" row.
    - Add `` `routines:set-finish-by` (a person sets or removes a "get-done" task's finish date, TASK-951) `` to the "Hooks" row's list, before `` `routines:set-steps` ``.
  - **§9, after the "PR 3 (TASK-952): …" paragraph.** Add:
    > PR 3 (TASK-951): Finish by is a date only a person sets, on a "Get something done" task's page. The row, the page and each check-in's brief count the days to it the same way, in the task's own time zone, and the brief asks the agent to report Off track when the steps left won't fit.
  - **§13, "New hooks:".** Add `` `routines:set-finish-by` (TASK-951, owner-only, neither a tool nor an IPC action) `` after `` `routines:recent-replies` ``.
  - **§15, a new last row.** `| 2026-10-24 | Decided | A "Get something done" task can have an optional Finish by date. Only a person sets it, on its task page; no agent or tool can. It's a date in the task's own time zone (its schedule's, else its active hours', else UTC), shown on the Tasks row and the task page as days left. Its check-ins' brief asks the agent to report Off track when the steps left won't fit, and ax never computes that. A change of kind clears it, a change of owner keeps it, and Duplicate doesn't copy it (TASK-951). |`
- [ ] **Step 2: Grep for loose ends.** `grep -n "set-finish-by\|Finish by" docs/plans/2026-10-20-agent-tasks-design.md` lists nine lines: the two already there (:712, :882) and the seven this task adds. `pnpm test:scripts` passes.
- [ ] **Step 3: Commit** `[TASK-951] Design doc: Finish by is a person-only date on a get-done task`.

## Left to later (not in this plan)

- Setting a finish date in the New task dialog (PR 4).
- A reminder or email as the date nears (§14 Q4).
- A finish time of day.
- Finish by on "Stay on top" tasks, which never finish.
- Hiding the date on a Done task. TASK-950 adds Done: whichever of TASK-950 and TASK-951 merges second hides the Finish by line and its field on a Done task, and pins it in `TaskPage.test.tsx`.
- Showing the date on Today, in Settings, or in the check-in message.
- Telling the person, near midnight, that the task's calendar day differs from theirs (decisions row 15).
