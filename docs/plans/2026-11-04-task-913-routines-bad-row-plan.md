# TASK-913: one stored routine that no longer reads can't stop the tick — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stored routine row that today's contract refuses is skipped, and said so in ids and codes, by every reader that handles many rows at once (the tick's claim, a run's finish, plugin boot, the app-update pump, agent purge). It shows in Settings → Routines as "can't be read" with a working Delete. No new or changed schedule can use `?`.

**Architecture:** One lenient reader in the store, `readRoutineRow` (the `safeParse` of what `rowToRoutine` parses), used wherever one row's failure would sink a batch. Per-row reads keep the strict `rowToRoutine`. `routines:list` gains a separate `unreadable` array that only Settings draws. Delete reads raw columns. The `?` rule goes in the contract's write-only `repeatScheduleWriteIssue`.

**Tech Stack:** TypeScript, kysely + Postgres (testcontainers), zod 3.25, croner 8.1.2, React + shadcn (channel-web), vitest.

**Spec:** the card (condensed below) and `.claude/memory/decisions/2026-11-04-TASK-913.md`, which holds every decision here with its rationale and the alternatives turned down.

## Spec

The card asks for:

- `claimDue`: parse each claimed row on its own. Skip a row that fails and log one line naming its `routineId` and the first issue path. No definition text: it is model-authored. Every other row in the batch still fires. Decide what happens to the skipped row's `next_run_at`.
- `list` / `findOne`: a row that fails to parse still shows in Settings as broken, with Delete available, instead of failing the whole list.
- Tests: a raw-SQL row that violates the task floor next to a valid due row. The valid one fires, the bad one is skipped and logged, and `routines:list` still returns.
- Decide whether to refuse `?` for every routine, and what to do with stored rows that have one.
- Acceptance: a routines store test and a services/list test with a deliberately invalid row. Then `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

Planning changed or settled this (decisions shard rows in brackets):

1. The claim's push is from the row's stored time (`store.ts:1669-1673`), so an overdue row would come back on every 5-second tick. A skipped authored row is set to `now + claimWindowMinutes`. A skipped default-routine row gets `last_run_at = now` instead, because its due time is `COALESCE(last_run_at, created_at) + interval` and its `next_run_at` must stay NULL. [rows 2-3]
2. The log line carries ids, the zod issue path (screened) and the zod issue code. Never the message: zod's own messages quote stored values. [row 4]
3. Unreadable rows cross `routines:list` as a separate `unreadable` array of `{ agentId, routineId, revision, name, origin, canDelete }`, defaulting to `[]`. [rows 5-7]
4. Delete works for them: `routines:delete` and `deleteAuthored` read owner, default source, revision and webhook as columns. Per-row reads (get, edit, Pause, fire-now, reply, duplicate, webhook admission) keep throwing for that one routine. [rows 8-9]
5. Three more whole-batch failures of the same kind are fixed. A run's finish (`finishDispatch`) parses the task, which stops plugin init at boot and stalls the app-update pump. Agent purge fails on one row. The app-update claim stalls every repeat routine's updates. [row 10]
6. `?` is refused in every new or changed schedule: repeat routines through `repeatScheduleWriteIssue`, which lets an unchanged schedule through; tasks keep TASK-906's rule. Stored repeat `?` crons get no migration and no read-side rule. [row 12]
7. Out of scope: the Tasks page, Today and the badge now leave an unreadable task out (before, the whole agent failed). The default catalog list's leniency is a follow-up too. [row 15]

## Global Constraints

- Don't edit `packages/routines/src/tick.ts`, `fire.ts`, `webhook-handler.ts`, `packages/channel-web/src/components/workspace/TaskForm.tsx` or `packages/channel-web/src/components/routines/use-routine-draft.ts`. Sibling builders TASK-1037 and TASK-1038 own them. Nothing in this plan needs them.
- Store log lines use the store's existing style: one `process.stderr.write` line starting `[ax/routines] `, with ids, a screened zod issue path and a zod issue code only. Never stored text, a zod message or an error message.
- Copy, exact. Use typographic apostrophes and quotes wherever shown:
  - contract `?` message: `A schedule can’t use “?”. Use “*” for any value, or write the exact time.`
  - cancelled app update (stored fire error): `This app update was cancelled because its routine could not be read.`
  - Settings line: `We can’t read this routine anymore, so it isn’t running.`, plus ` Delete it and set it up again.` when the entry's `canDelete` is true
  - Settings name fallback: `Untitled routine`
- UI composes the installed shadcn primitives with semantic tokens (CLAUDE.md invariant 6). The Task 8 implementer invokes the `shadcn` skill before editing.
- `@ax/routines-contract` consumers import its `dist/`. After any contract change, run `pnpm --filter @ax/routines-contract build` before running routines, admin-routes or channel-web tests.
- Docker-backed suites (everything under `packages/routines/src/__tests__` that uses `fixture()` or `createRoutineHarness`, and `human-rest-integration.test.ts`): set `DOCKER_HOST` explicitly. Run them per file with `pnpm --filter <pkg> exec vitest run <file> --maxWorkers=1`. Never `pnpm --filter X test -- <file>`, which runs the whole package.
- Every fix to a whole-batch failure gets a test that you have run red before the fix (Bug Fix Policy).
- A test file carries only the names its own task uses: `no-unused-vars` is an error in tests. `packages/routines` keeps tests out of `tsc`, so lint the touched test files.
- Break rows only with visible characters: a 5-minute task interval, a 129-character name, or an unknown time zone. No invisible-character fixtures (the escape-text trap, TASK-948 mistakes).
- No schema migration. Memory rows go to `.claude/memory/<kind>/2026-11-04-TASK-913.md` shards only.

## Review Focus

1. **A contract change breaks many rows at once** (time-zone data drops a zone a lot of routines use). Readable due routines must never be starved. Each unreadable row ahead of them is skipped once and pushed a claim window from now, so the readable ones fire after one tick per full batch of unreadable rows. The claim takes the most overdue first (`store.ts:1635-1636`), so N unreadable rows cost about N ÷ `claimBatchSize` ticks of 5 s, not forever. Pinned in Task 3 (`a claim batch filled with rows that no longer read holds back a readable routine only until each has been skipped once`).
2. **A routine stops reading while its check-in runs** (a deploy with new time-zone data, or a rollback mid-run). The run's finish still records, and boot still succeeds. Pinned in Task 3 (the misses-store boot test).
3. **App updates already waiting for a routine that stops reading** must not hold up every other routine's updates. Pinned in Task 5.
4. **Someone who can see an unreadable routine but can't stop it** gets no Delete button, and the service refuses them anyway. Pinned in Task 6 (team member refused, team admin allowed) and Task 8 (no button when `canDelete` is false).
5. **A person renames a saved `?` repeat routine without touching its schedule.** The new `?` rule must not block the edit, at the contract, the store or the editor. Pinned in Task 1.

## File map

| File | Change | Task |
|---|---|---|
| `packages/routines-contract/src/definition.ts` | `repeatScheduleWriteIssue` refuses `?`; its doc | 1 |
| `packages/routines-contract/src/tools.ts` | cron `expr` description | 1 |
| `packages/routines-contract/src/services.ts` | `RoutineUnreadableViewSchema`; `RoutineListOutputSchema.unreadable` | 2 |
| `packages/routines/src/store.ts` | `readRoutineRow`, `reportUnreadable`, `claimDue`, `finishDispatch` | 3 |
| `packages/routines/src/store.ts`, `types.ts` | `listAll`, `list`, `findOwnership`, `lockRoutineRow`, `deleteAuthored`, `purgeAgent`, `queueCleanup`; `UnreadableRoutine` | 4 |
| `packages/routines/src/repeat-deliveries.ts` | `claim` cancels an update whose routine doesn't read | 5 |
| `packages/routines/src/services.ts` | `routines:list` `unreadable`; `routines:delete` via columns; `unreadableViews` | 6 |
| `packages/routines-admin-routes/src/routes.ts` | Settings list forwards `unreadable` | 7 |
| `packages/channel-web/src/lib/routines.ts`, `components/routines/RoutinesList.tsx` | list page type; draw and delete unreadable rows | 8 |

Order: Tasks 1 and 2 can run in parallel (different contract files); build the contract once both are in. Then Task 3, then Tasks 4 and 5 in parallel (Task 4 edits `store.ts`, Task 5 edits `repeat-deliveries.ts`). Then Task 6, then Task 7. Task 8 needs only Task 2 and can run beside Tasks 3-7.

---

### Task 1: Refuse `?` in every new or changed schedule [tier: integration]

**Files:**
- Modify: `packages/routines-contract/src/definition.ts:203-224` (`repeatScheduleWriteIssue` and its doc comment)
- Modify: `packages/routines-contract/src/tools.ts:258` (the cron `expr` description)
- Test: `packages/routines-contract/src/__tests__/repeat-schedule-write.test.ts`
- Test: `packages/routines-contract/src/__tests__/definition.test.ts:430` (comment), `:839-843` (tool text)
- Test: `packages/routines/src/__tests__/independent-store.test.ts` (new `it` after `preserves a stored fast cron on reads…`)
- Test: `packages/channel-web/src/components/routines/__tests__/RoutineEditor.methods.test.tsx` (new `it` after `marks a newly authored fast cron invalid…`). Small conflict risk with TASK-1037: append only, and on a rebase conflict keep both.

**Interfaces:**
- Produces: `repeatScheduleWriteIssue(schedule, previous?)`, signature unchanged. A cron whose `expr` contains `?` now returns `QUESTION` (the Global Constraints message) unless it equals `previous` (same `expr` and `tz`). No new export. The servers' `validateScheduleWrite` (create, update, tools, duplicate) and both editors (through `use-routine-draft.ts`) already call it, so no other source changes.

- [ ] **Step 1: Write the failing contract tests** in `repeat-schedule-write.test.ts`. Add `const QUESTION = 'A schedule can’t use “?”. Use “*” for any value, or write the exact time.';` and:

```ts
it('refuses “?” in a new or changed repeat schedule at any time of day (TASK-913)', () => {
  for (const time of ['2031-01-01T10:10:00Z', '2031-01-01T10:40:00Z', '2031-01-01T10:00:00Z']) {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(time));
      for (const expr of ['? 9 * * *', '?-30 * * * *', '*/? * * * *', '0 12 ? * MON', '? * * * * *', '?,0 * * * * *'])
        expect(issue(cron(expr)), `${expr} at ${time}`).toBe(QUESTION);
    } finally { vi.useRealTimers(); }
  }
  expect(issue(cron('? 10 * * *'), cron('? 9 * * *'))).toBe(QUESTION);
  expect(issue(cron('? 9 * * *', 'America/New_York'), cron('? 9 * * *'))).toBe(QUESTION);
});
it('keeps a saved “?” schedule through edits that leave it unchanged', () => {
  expect(issue(cron('? 9 * * *'), cron('? 9 * * *'))).toBeNull();
});
```

Edit two existing tests:
- `does not introduce task-only recurrence rules for repeat jobs`: delete its two `?` lines (`:41-42`). Keep the one-off date and 31 February.
- `checks clock-relative seconds lists deterministically…`: `expect(verdicts[0]).toBe(QUESTION)`, which was `toMatch(/60 seconds/)`. `verdicts[1]` still equals `verdicts[0]`.

In `definition.test.ts`:
- Rename `says a task’s cron can’t use “?”, and has to keep checking in` to `says no schedule can use “?”, and a task’s has to keep checking in`. Assert both substrings on `JSON.stringify(RoutineToolJsonSchemas[name])` for `routine_create` and `routine_update`:
  - `'Croner cron expression, without \\"?\\" (use \\"*\\" for any value).'`
  - `'For a task (\\"stay-on-top\\" or \\"get-done\\"), runs must be at least 15 minutes apart and the schedule must repeat (not a single date, nor a date that never comes, such as 31 February).'`
- Line 430's comment (`// A repeat routine keeps it.`) becomes `// A repeat routine saved with one still reads: only a new or changed schedule refuses it (repeatScheduleWriteIssue, TASK-913).` The assertion stays.

- [ ] **Step 2: Run them, expect FAIL** from the two new tests, the edited seconds-list test and the renamed tool-text test. The two deleted lines and the comment can't go red.

Run: `pnpm --filter @ax/routines-contract exec vitest run src/__tests__/repeat-schedule-write.test.ts src/__tests__/definition.test.ts`

- [ ] **Step 3: Implement.** In `repeatScheduleWriteIssue`, put `if (schedule.expr.includes('?')) return QUESTION;` after the interval branch and before the `':'`/`'@'` early return. It must stay after the unchanged-schedule early return. The seconds sampler's `?` branch is now unreachable: check the `seconds` field alone (`samples` goes).

  In the doc comment, replace "Question marks keep their existing repeat semantics: one clock-relative value is fine, while a list/range with another value is checked at both endpoints." with: "A new or changed schedule can't use “?” (TASK-913): croner fills it in from the clock on every parse, so its times, and whether it reads at all, change with when it's read. One saved before keeps reading, and an edit that leaves it unchanged keeps it."

  In `tools.ts:258`, the `expr` description becomes exactly: `'Croner cron expression, without "?" (use "*" for any value). Newly authored or changed repeat schedules need at least 60 seconds between runs. For a task ("stay-on-top" or "get-done"), runs must be at least 15 minutes apart and the schedule must repeat (not a single date, nor a date that never comes, such as 31 February).'`

- [ ] **Step 4: Run the contract tests, expect PASS; then build the contract**

Run: `pnpm --filter @ax/routines-contract exec vitest run src/__tests__/repeat-schedule-write.test.ts src/__tests__/definition.test.ts && pnpm --filter @ax/routines-contract build`

- [ ] **Step 5: Add the store test** to `independent-store.test.ts`, reusing its `edit` helper:

```ts
it('refuses “?” in a new or changed repeat cron and keeps a saved one through unrelated edits (TASK-913)', async () => {
  const saved = { kind: 'cron' as const, expr: '? 9 * * *', tz: 'UTC' };
  await expect(f.store.createAuthored({ ...createInput('fresh-question'), definition: { ...createInput().definition, schedule: saved } }))
    .rejects.toMatchObject({ toolCode: 'validation', field: 'schedule.expr' });
  const row = await f.store.createAuthored(createInput());
  await sql`UPDATE routines_v1_definitions SET schedule_spec=${JSON.stringify(saved)}::jsonb WHERE routine_id=${row.routineId}`.execute(f.db);
  const legacy = (await f.store.findOne(row))!;
  expect(legacy.schedule).toEqual(saved);
  const renamed = await f.store.updateAuthored(edit(legacy, { name: 'Renamed', schedule: { ...saved } }));
  expect(renamed.schedule).toEqual(saved);
  await expect(f.store.updateAuthored(edit(renamed, { schedule: { ...saved, expr: '? 10 * * *' } })))
    .rejects.toMatchObject({ toolCode: 'validation', field: 'schedule.expr' });
});
```

- [ ] **Step 6: Add the editor test** to `RoutineEditor.methods.test.tsx`, modelled on the fast-cron test: `it('marks a “?” cron invalid while allowing an unchanged saved one (TASK-913)')`.
  - `mocks.get.mockResolvedValue({ ...view(), schedule: { kind: 'cron', expr: '? 9 * * *', tz: 'UTC' } })`, then `await edit()`.
  - Change only the prompt: Save is enabled.
  - Change `Cron expression` to `? 10 * * *`. Save is disabled, the field has `aria-invalid="true"`, and `screen.getByText(/Use “\*” for any value/)` is visible.

- [ ] **Step 7: Run both, expect PASS** (no product change beyond the contract; a failure here means the contract build is stale)

Run: `DOCKER_HOST=<socket> pnpm --filter @ax/routines exec vitest run src/__tests__/independent-store.test.ts --maxWorkers=1`
Run: `pnpm --filter @ax/channel-web exec vitest run src/components/routines/__tests__/RoutineEditor.methods.test.tsx`

- [ ] **Step 8: Commit** (`[TASK-913] Refuse “?” in new or changed schedules; saved ones keep reading`)

---

### Task 2: The list contract names routines it can't read [tier: mechanical]

**Files:**
- Modify: `packages/routines-contract/src/services.ts:45` (`RoutineListOutputSchema`), plus the new schema and its type beside the other types (`:302`)
- Create: `packages/routines-contract/src/__tests__/unreadable.test.ts`
- Modify: `packages/routines-contract/src/__tests__/definition.test.ts:232`. The case becomes `[contract.RoutineListOutputSchema, { routines: [view], unreadable: [] }]`, because that loop asserts `parse(value)` equals `value`.

**Interfaces:**
- Produces:

```ts
export const RoutineUnreadableViewSchema = z.object({
  agentId: RoutineOpaqueStringSchema, routineId: RoutineOpaqueStringSchema, revision: RoutineOpaqueStringSchema,
  name: z.string(), origin: z.enum(['authored', 'default']), canDelete: z.boolean(),
}).strict();
export type RoutineUnreadableView = z.output<typeof RoutineUnreadableViewSchema>;
export const RoutineListOutputSchema = z.object({
  routines: z.array(RoutineViewSchema),
  unreadable: z.array(RoutineUnreadableViewSchema).default([]),
}).strict();
```

The schema's doc comment, in substance:
- TASK-913: a stored routine today's rules can't read, as `routines:list` names it beside the routines that do. It carries enough to recognize the routine and, when the caller may stop it, to delete it.
- Its ids and revision are the row's own.
- `name` is the stored name as a type only (stored text isn't re-checked), cut to `ROUTINE_NAME_MAX_CHARS` code points by the producer.
- `origin` says whether it is a workspace default's copy.
- `canDelete` is the services' `permissions.stop` for the caller.
- Nothing of its definition crosses, because any field could be the one that doesn't read.
- Only Settings draws these. The Tasks page and `routine_list` read `routines` alone.

On `unreadable`: left out reads as none. The routines plugin always sends it, and fakes that answer `{ routines }` keep parsing.

- [ ] **Step 1: Write the failing test** `unreadable.test.ts`:

```ts
const entry = { agentId: 'a', routineId: 'rtn_1', revision: 'rev_1', name: 'x'.repeat(300), origin: 'authored', canDelete: true };
it('reads a list answer that names no unreadable routine as none', () => {
  expect(RoutineListOutputSchema.parse({ routines: [] })).toEqual({ routines: [], unreadable: [] });
});
it('carries an unreadable routine with only its ids, revision, stored name, origin and Delete right', () => {
  expect(RoutineListOutputSchema.parse({ routines: [], unreadable: [entry] })).toEqual({ routines: [], unreadable: [entry] });
  for (const extra of [{ ownerUserId: 'owner' }, { kind: 'repeat' }, { schedule: null }])
    expect(RoutineUnreadableViewSchema.safeParse({ ...entry, ...extra }).success).toBe(false);
  for (const bad of [{ routineId: '' }, { revision: 'r'.repeat(257) }, { origin: 'other' }, { canDelete: 'yes' }])
    expect(RoutineUnreadableViewSchema.safeParse({ ...entry, ...bad }).success).toBe(false);
});
```

- [ ] **Step 2: Run, expect FAIL** (`RoutineUnreadableViewSchema` is undefined): `pnpm --filter @ax/routines-contract exec vitest run src/__tests__/unreadable.test.ts src/__tests__/definition.test.ts`
- [ ] **Step 3: Implement** the Interfaces block in `services.ts`. `index.ts` already re-exports `services.js`.
- [ ] **Step 4: Run the same command, expect PASS, then build:** `pnpm --filter @ax/routines-contract build`
- [ ] **Step 5: Commit** (`[TASK-913] routines:list contract: unreadable routines beside the ones that read`)

---

### Task 3: The tick, a run's finish and boot skip a row that doesn't read [tier: sensitive]

Needs `security-checklist` (log lines near model-authored text; the tick is the global fire path).

**Files:**
- Modify: `packages/routines/src/store.ts:728-739` (`rowToRoutine` and its input), new exports beside it; `:231` (doc on `claimDue` in `RoutinesStore`); `:1626-1679` (`claimDue`); `:1152-1228` (`finishDispatch`, the nudge at `:1214-1216`)
- Create: `packages/routines/src/__tests__/unreadable-rows-store.test.ts`
- Modify: `packages/routines/src/__tests__/misses-store.test.ts` (new `it` after `a stored definition today's checks refuse still pauses at boot…`)

**Interfaces:**
- Produces (exported from `store.ts`, used by Tasks 4 and 5):

```ts
/** TASK-913. Where a stored row stopped reading, as a log line may say it: the first zod issue's path and code, never its message. */
export type UnreadableIssue = { path: string; code: string };
export type RoutineRowRead = { ok: true; routine: StoredRoutine } | { ok: false; issue: UnreadableIssue };
/** rowToRoutine's parse, answered instead of thrown. Never throws. */
export function readRoutineRow(row: Selectable<RoutinesDefinitionsRow>): RoutineRowRead;
export function reportUnreadable(row: Pick<Selectable<RoutinesDefinitionsRow>, 'agent_id' | 'routine_id'>, issue: UnreadableIssue, consequence: string): void;
```

`rowToRoutine` keeps its signature and stays strict. It and `readRoutineRow` build their input in one private helper (today's object, unchanged).

Rules:
- `readRoutineRow` runs `StoredRoutineSchema.safeParse(...)`, importing `StoredRoutineSchema` from `./definition.js`. On failure it reads the first issue:
  - `path` is the segments joined with `.` when there is at least one and every `String(segment)` matches `/^[A-Za-z0-9]{1,64}$/`; otherwise it is `input`.
  - `code` is `issue.code`.
  - Any throw while building or parsing gives `{ path: 'input', code: 'thrown' }`.
- `reportUnreadable` writes exactly `` `[ax/routines] routine ${agent_id}/${routine_id} no longer reads (${path}: ${code}), so ${consequence}\n` ``.
- `claimDue`: the SQL is unchanged. For each returned row, in order, keep the rows that read. For one that doesn't:
  - Call `reportUnreadable(raw, issue, 'the tick skipped it')`.
  - Then run one UPDATE on it, guarded by `agent_id`, `routine_id` and `revision = raw.revision`. An authored row (`definition_id IS NULL`) gets `next_run_at = now + claimWindowMinutes` (computed in TS from `input.now`). A default row gets `last_run_at = input.now`; never touch its `next_run_at` (`routines_v1_default_next_run_at_chk`).
  - Return the rows that read, in their returned order.
- `finishDispatch`: the nudge reads `readRoutineRow(definition)`.
  - A row that reads nudges as today.
  - One that doesn't skips the nudge and records `{ row: definition, issue }` in a new variable, e.g. `unreadableDefinition`. Don't reuse the existing `let unreadable` (`store.ts:1154`): that flag is for an unreadable report and has its own after-commit line at `:1220`. Reset the new record at the top of the transaction callback.
  - After the transaction has committed with `finished === true`, call `reportUnreadable(row, issue, "its finished run didn't reschedule it")`. This mirrors the existing after-commit lines at `:1219-1226`.
  - Everything else in the finish is unchanged.
- Doc on `claimDue` in `RoutinesStore`: "TASK-913: a claimed row today's rules can't read is skipped, never returned. It writes one stderr line in ids and codes, and it's tried again a claim window from now (an authored row's next run) or after its interval (a default's last run, its due time's base). Every other row in the batch is returned."

- [ ] **Step 1: Write the failing tests.** Start `unreadable-rows-store.test.ts` with `describe('the tick and a run’s finish beside a row that no longer reads (TASK-913)')` and these helpers. Only these; Task 4 adds its own. The `afterEach` restore is required, as in `misses-store.test.ts:16`. vitest's `spyOn` hands back the existing spy, so without the restore the second `captureExpectedStderr` saves the spy as the "original" stderr, and any line that doesn't match recurses forever.

```ts
const f = fixture();
afterEach(() => { vi.restoreAllMocks(); });
const task = (requestId: string) => ({ ...createInput(requestId), definition: RoutineDefinitionSchema.parse({
  name: 'Inbox', promptBody: 'Keep the inbox under control.', trigger: { kind: 'interval', every: '15m' }, kind: 'stay-on-top', goodWhen: 'Nothing waits more than a day.' }) });
/** The card's way in: code from before TASK-906 set a task to check in every 5 minutes. */
const underTheFloor = (routineId: string) => sql`UPDATE routines_v1_definitions SET schedule_spec = ${JSON.stringify({ kind: 'interval', every: '5m' })}::jsonb WHERE routine_id = ${routineId}`.execute(f.db);
const columns = async (routineId: string) => (await sql<{ next_run_at: Date | null; last_run_at: Date | null }>`SELECT next_run_at, last_run_at FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0]!;
const skippedLines = () => captureExpectedStderr(m => m.startsWith('[ax/routines] routine ')).messages;
const claim = (at: Date, limit = 10) => f.store.claimDue({ now: at, limit, claimWindowMinutes: 5 });
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);
```

Tests (assertions exact):
1. `claimDue hands over every due row that reads and skips the one that doesn't, in one line of ids and codes`.
   - Set up `repeat = createAuthored(createInput('repeat'))` and `broken = createAuthored(task('task'))`, then `underTheFloor(broken.routineId)`.
   - `claim(minutes(60))` maps to `[repeat.routineId]`.
   - The lines equal `` [`[ax/routines] routine a/${broken.routineId} no longer reads (schedule.every: custom), so the tick skipped it\n`] ``.
   - `repeat`'s `next_run_at` is `repeat.nextRunAt + 5 min`, and `broken`'s is `minutes(65)`.
2. `claimDue tries a skipped routine again a claim window from now, not from its stored time, and fires it once it reads`.
   - Break the task and set its `next_run_at` to `minutes(-3 * 24 * 60)` (a host that was down).
   - `claim(now)` gives `[]` and `claim(now + 5 s)` gives `[]`, with 1 line so far.
   - `claim(minutes(5))` gives `[]`, with 2 lines.
   - Set the schedule back to `15m`. `claim(minutes(10))` maps to `[broken.routineId]`, still 2 lines.
3. `a claim batch filled with rows that no longer read holds back a readable routine only until each has been skipped once`.
   - Break the task and set its `next_run_at` to `minutes(-24 * 60)`. Then create `repeat`.
   - `claim(minutes(2), 1)` gives `[]`.
   - `claim(minutes(2) + 5 s, 1)` maps to `[repeat.routineId]`.
4. `claimDue moves a skipped default routine's last run to now, so it waits out its interval instead of coming back every tick`.
   - `upsertDefault(defaultDefinition())` (60 s), then `materializeMissing({ agents: [{ agentId: 'a', ownerUserId: 'owner' }], now })`.
   - The copy is the row with `definitionId !== null` and `name === 'Check in'`. Set its `name` to `'x'.repeat(129)`.
   - At `at = now + 61 s`, `claim(at)` doesn't contain it.
   - The lines equal `` [`[ax/routines] routine a/${copy.routineId} no longer reads (name: too_big), so the tick skipped it\n`] ``.
   - `columns(copy)` equals `{ next_run_at: null, last_run_at: at }`.
   - `claim(at + 5 s)` doesn't contain it, still 1 line.
   - Other seeded defaults may be claimed; assert only about the copy.

In `misses-store.test.ts`, add `a stored definition today's checks refuse still finishes an interrupted check-in at boot when it isn't the fifth miss, leaving its next check-in as it was`:
- `row = createAuthored(taskInput('task'))`, then `checkIn(row, 'first', { at: minute(1) })`.
- Set its `schedule_spec` to `{"kind":"interval","every":"5m"}`. Then `before = definitionRow(row.routineId)`.
- Capture lines starting `[ax/routines] routine `.
- `await expect(f.store.interruptAbandonedDispatches()).resolves.toBe(1)`.
- The lines equal `` [`[ax/routines] routine a/${row.routineId} no longer reads (schedule.every: custom), so its finished run didn't reschedule it\n`] ``.
- `definitionRow` matches `{ next_run_at: before.next_run_at, last_status: 'error', task_misses_in_a_row: 1, task_miss_reason: 'interrupted' }`.

- [ ] **Step 2: Run, expect FAIL.** Tests 1-4 fail because `claimDue` throws a ZodError; the boot test fails because `interruptAbandonedDispatches` rejects.

Run: `DOCKER_HOST=<socket> pnpm --filter @ax/routines exec vitest run src/__tests__/unreadable-rows-store.test.ts src/__tests__/misses-store.test.ts --maxWorkers=1`

- [ ] **Step 3: Implement** the Interfaces block and the rules above.
- [ ] **Step 4: Run the same command, expect PASS.** Then run the suites that claim and finish runs: `store.test.ts`, `finish-by-store.test.ts`, `tick.test.ts`, `report-store.test.ts`, `active-hours-store.test.ts`, one file at a time, same form. Then run `pnpm --filter @ax/routines build` and `pnpm exec eslint packages/routines/src/store.ts packages/routines/src/__tests__/unreadable-rows-store.test.ts packages/routines/src/__tests__/misses-store.test.ts`.
- [ ] **Step 5: Commit** (`[TASK-913] The tick, a run's finish and boot skip a routine that no longer reads`)

---

### Task 4: List, delete and purge read columns for a row that doesn't read [tier: sensitive]

Needs `security-checklist` (who may delete is now decided from columns).

**Files:**
- Modify: `packages/routines/src/types.ts` (new `UnreadableRoutine`)
- Modify: `packages/routines/src/store.ts`:
  - the interface (`:31-32`, plus `listAll` and `findOwnership`)
  - `lockRoutine` (`:955-960`), split
  - `queueCleanup` (`:966-972`)
  - `deleteAuthored` (`:1056-1070`)
  - `purgeAgent` (`:1616-1617`)
  - `list` and `findOne` (`:1769-1783`)
- Test: `packages/routines/src/__tests__/unreadable-rows-store.test.ts`, a second `describe('listing, deleting and purging a row that no longer reads (TASK-913)')`. Add the imports it needs (`plainWebhookInput`, `credentialRef`).

**Interfaces:**
- Consumes: `readRoutineRow` (Task 3).
- Produces:

```ts
// types.ts
/** TASK-913. A stored routine today's rules can't read: its key, revision, owner, default source and name, read as columns. */
export type UnreadableRoutine = { agentId: string; routineId: string; revision: string; ownerUserId: string; definitionId: string | null; name: string };
// RoutinesStore
listAll(input: { agentId: string }): Promise<{ routines: StoredRoutine[]; unreadable: UnreadableRoutine[] }>;
/** The rows that read: listAll's routines. Never throws for one that doesn't. */
list(input: { agentId: string }): Promise<StoredRoutine[]>;
/** TASK-913. The routine's owner and default source, read as columns, so a row today's rules refuse answers too. */
findOwnership(input: RoutineKey): Promise<{ ownerUserId: string; definitionId: string | null } | null>;
```

Rules:
- `listAll` runs today's `list` query (same order). Each row goes through `readRoutineRow`, and a row that doesn't read becomes an `UnreadableRoutine` from its columns. No log line: it would repeat on every page load. Implement `list` as `listAll(...).routines` through a closure function, not `this`.
- `findOwnership` selects only `owner_user_id` and `definition_id`.
- New private `lockRoutineRow(db, input: RoutineKey & { expectedRevision: string })` does today's lock and checks (`FOR UPDATE`, `not-found`, `revision-conflict`) and returns the raw row. `lockRoutine` becomes `rowToRoutine(await lockRoutineRow(...))` and keeps serving `updateAuthored` and `withLockedWebhookSecret`.
- `deleteAuthored` uses `lockRoutineRow`. A row with `definition_id !== null` is `forbidden`. It calls `queueCleanup(trx, cleanupSource(row))`. Receipt and answer are unchanged.
- `queueCleanup(db, row: { agentId: string; routineId: string; ownerUserId: string; webhook: unknown })`: same body, and a `StoredRoutine` still fits it. New `cleanupSource(row)` maps `agent_id`, `routine_id`, `owner_user_id` and `webhook_spec`.
- `purgeAgent` changes to `for (const row of rows) await queueCleanup(trx, cleanupSource(row));`.

- [ ] **Step 1: Write the failing tests:**
1. `listAll answers the rows that read and names the rest by id, revision, owner, default source and name only`.
   - Set up `repeat` and a broken `task`.
   - `listAll({ agentId: 'a' })` gives `routines` mapping to `[repeat.routineId]` and `unreadable` equal to `[{ agentId: 'a', routineId: broken.routineId, revision: broken.revision, ownerUserId: 'owner', definitionId: null, name: 'Inbox' }]`.
   - `list({ agentId: 'a' })` maps to `[repeat.routineId]` and doesn't throw.
   - `findOne(broken)` still rejects. That's left as is on purpose; write it as a comment in the test.
2. `deleteAuthored deletes a row that no longer reads, under its revision, and queues its signing-secret cleanup`.
   - `hook = createAuthored(plainWebhookInput())`, then set its `name` to `'x'.repeat(129)`.
   - A stale revision rejects with `{ toolCode: 'revision-conflict' }`.
   - `hook.revision` resolves to `{ deleted: true, cleanupPending: true }`.
   - `pendingCleanup({ limit: 10 })` equals `[{ agentId: 'a', routineId: hook.routineId, ownerUserId: 'owner', credentialRef: credentialRef(hook) }]`.
   - `listAll` equals `{ routines: [], unreadable: [] }`.
3. `deleteAuthored still refuses a default routine that no longer reads`. Materialize the 60 s default as in Task 3, break its name, and delete under its revision: rejects with `{ toolCode: 'forbidden' }`.
4. `purgeAgent removes an agent whose routines include one that no longer reads, and queues that routine's secret`.
   - A broken `hook` plus `createAuthored(createInput('other'))`.
   - `purgeAgent('a')` resolves.
   - `pendingCleanup` holds `hook`'s ref.
   - `listAll` equals `{ routines: [], unreadable: [] }`.

- [ ] **Step 2: Run, expect FAIL** (`listAll`/`findOwnership` missing; delete and purge throw ZodErrors): `DOCKER_HOST=<socket> pnpm --filter @ax/routines exec vitest run src/__tests__/unreadable-rows-store.test.ts --maxWorkers=1`
- [ ] **Step 3: Implement** the Interfaces block and rules.
- [ ] **Step 4: Run, expect PASS.** Then run `store.test.ts`, `cleanup.test.ts` and `webhook-address-store.test.ts` (same form), `pnpm --filter @ax/routines build`, and eslint on the touched files.
- [ ] **Step 5: Commit** (`[TASK-913] Delete and purge a routine that no longer reads; listAll names it`)

---

### Task 5: The app-update pump cancels an update whose routine doesn't read [tier: sensitive]

Needs `security-checklist` (a queue every repeat routine shares; a stored, person-visible error text).

**Files:**
- Modify: `packages/routines/src/repeat-deliveries.ts:56-80` (`claim`)
- Test: `packages/routines/src/__tests__/repeat-deliveries.test.ts` (new `it`)

**Interfaces:**
- Consumes: `readRoutineRow`, `reportUnreadable` (Task 3). `claim`'s signature is unchanged.

Rules:
- In `claim`'s transaction, read `raw` with `readRoutineRow` in place of `rowToRoutine`.
- When `raw` exists and doesn't read, cancel the update the way the changed-job branch does. That means the same fire row insert and the same delivery update, with error `This app update was cancelled because its routine could not be read.` and `invalidated_reason: 'unreadable'`. The column is free text, and every reader checks only `IS NOT NULL`. Set `cancelled = true` and return `null`. Comment: an unreadable routine can't run the update, which the run re-parses, and leaving it at the head would stall every routine's updates (`ORDER BY q.sequence_id LIMIT 1`).
- After the transaction commits, before the existing recursion, call `reportUnreadable(raw, issue, 'its waiting app update was cancelled')`.
- A routine that reads takes today's path unchanged.

- [ ] **Step 1: Write the failing test** `cancels a waiting app update whose routine no longer reads, and claims the next routine’s (TASK-913)`. The file imports only `describe`, `expect` and `it` today (`repeat-deliveries.test.ts:1`). Add `afterEach` and `vi` to that import, add `captureExpectedStderr` from `./support/expected-diagnostics.js`, and add `afterEach(() => { vi.restoreAllMocks(); });` after `const f = fixture();` (the reason is in Task 3, Step 1).

```ts
const broken = await row('Broken'); const next = await row('Next');
expect(await queue().admit({ row: broken, payload: { title: 'first' }, deliveryId: 'first', now }, persist)).toBe('accepted');
expect(await queue().admit({ row: next, payload: { title: 'second' }, deliveryId: 'second', now }, persist)).toBe('accepted');
// A name a later rule refuses: what a stricter contract does to a routine saved before it.
await sql`UPDATE routines_v1_definitions SET name = ${'x'.repeat(129)} WHERE routine_id = ${broken.routineId}`.execute(f.db);
const lines = captureExpectedStderr(m => m.startsWith('[ax/routines] routine ')).messages;
expect((await queue().claim(now))?.accepted.row.routineId).toBe(next.routineId);
expect(lines).toEqual([`[ax/routines] routine a/${broken.routineId} no longer reads (name: too_big), so its waiting app update was cancelled\n`]);
expect((await sql<{ status: string; error: string }>`SELECT status, error FROM routines_v1_fires WHERE routine_id = ${broken.routineId}`.execute(f.db)).rows)
  .toEqual([{ status: 'error', error: 'This app update was cancelled because its routine could not be read.' }]);
expect((await queue().status(broken, 'owner')).waiting).toBe(0);
```

- [ ] **Step 2: Run, expect FAIL** (`claim` rejects with a ZodError): `DOCKER_HOST=<socket> pnpm --filter @ax/routines exec vitest run src/__tests__/repeat-deliveries.test.ts --maxWorkers=1`
- [ ] **Step 3: Implement** the rules.
- [ ] **Step 4: Run, expect PASS.** Also run `repeat-runtime.test.ts` and `repeat-admission-pool.test.ts`, then build and lint as in Task 3.
- [ ] **Step 5: Commit** (`[TASK-913] App-update pump: cancel an update whose routine no longer reads instead of stalling`)

---

### Task 6: `routines:list` names them and `routines:delete` deletes them [tier: sensitive]

Needs `security-checklist` (the delete authorization path; a model-authored name crossing toward the browser) and a boundary review in the PR (text below).

**Files:**
- Modify: `packages/routines/src/services.ts`: `:40-43` (`routinePermissions` parameter type), `:287-290` (`list`), `:314-321` (`delete`), and the new export `unreadableViews`
- Test: `packages/routines/src/__tests__/return-schemas.test.ts` (unit, no Docker)
- Test: `packages/routines/src/__tests__/services.test.ts` (harness, Docker): new `describe('a stored routine today’s rules refuse (TASK-913)')`

**Interfaces:**
- Consumes: `C.RoutineUnreadableViewSchema`, `C.RoutineUnreadableView` and `C.RoutineListOutputSchema` (Task 2). `store.listAll`, `store.findOwnership` and `UnreadableRoutine` (Task 4).
- Produces:

```ts
export function routinePermissions(row: Pick<StoredRoutine, 'ownerUserId' | 'definitionId'>, userId: string, allowed: boolean, stopOthers = false): C.RoutinePermissions;
export function unreadableViews(rows: readonly UnreadableRoutine[], userId: string, allowed: boolean, stopOthers = false): C.RoutineUnreadableView[];
```

Rules:
- `unreadableViews` projects field by field:
  - `name` is the first `C.ROUTINE_NAME_MAX_CHARS` code points (`Array.from`).
  - `origin` is `'authored'` when `definitionId === null`, else `'default'`.
  - `canDelete` is `routinePermissions(row, …).stop`.
  - It drops an entry that `C.RoutineUnreadableViewSchema.safeParse` refuses (TASK-932's precedent: one entry the contract refuses must not fail the whole answer).
- `list` reads `store.listAll(input)` and answers `{ routines: <today's mapping>, unreadable: unreadableViews(unreadable, ctx.userId, a.allowed, a.stopOthers) }`.
- `delete`: after the receipt check, `const owner = await store.findOwnership(input)`. Null throws `not-found` on `routineId`. Otherwise `requireAllowed(routinePermissions(owner, ctx.userId, a.allowed, a.stopOthers).stop)`; the rest is unchanged. Comment: columns, never the parsed row, so a routine today's rules refuse can still be deleted under the same rule.
- No other service changes. `rowFor` and the per-row services keep the strict read.

- [ ] **Step 1: Write the failing tests.**

In `return-schemas.test.ts`, add `projects a routine that no longer reads as its ids, revision, cut name, origin and Delete right, and drops one the contract refuses (TASK-913)`:

```ts
const stored: UnreadableRoutine = { agentId: 'agent', routineId: 'routine', revision: 'revision', ownerUserId: 'owner', definitionId: null, name: '😀'.repeat(300) };
expect(unreadableViews([stored], 'owner', true)).toEqual([{ agentId: 'agent', routineId: 'routine', revision: 'revision', name: '😀'.repeat(128), origin: 'authored', canDelete: true }]);
expect(unreadableViews([stored], 'member', true)[0]?.canDelete).toBe(false);
expect(unreadableViews([stored], 'admin', true, true)[0]?.canDelete).toBe(true);
expect(unreadableViews([stored], 'owner', false)[0]?.canDelete).toBe(false);
expect(unreadableViews([{ ...stored, definitionId: 'heartbeat' }], 'owner', true, true)[0]).toMatchObject({ origin: 'default', canDelete: false });
expect(unreadableViews([{ ...stored, routineId: '' }, stored], 'owner', true).map(view => view.routineId)).toEqual(['routine']);
```

In `services.test.ts`, use `inbox` = the `Inbox` stay-on-top task definition from Task 3, and break it with `sql` against `h.db` (the 5-minute interval).
1. `routines:list still answers, naming a routine that no longer reads beside the ones that do, and routine_list leaves it out`.
   - Set up `daily = create()` and a broken task on `h.agentId`.
   - `routines:list` as `h.owner`: `routines` maps to `[daily.routineId]`.
   - `unreadable` equals `[{ agentId: h.agentId, routineId: task.routineId, revision: task.revision, name: 'Inbox', origin: 'authored', canDelete: true }]`.
   - `h.bus.call('tool:execute:routine_list', makeAgentContext({ ...h.owner, agentId: h.agentId }), { id: 'list', name: 'routine_list', input: {} })` (the call form at `tools.test.ts:336`) answers without an `unreadable` key, and its routines don't include the task.
2. `routines:delete deletes a routine that no longer reads for someone who may stop it, and refuses anyone else`.
   - The task is on `h.teamAgentId`, created by `h.owner`, then broken.
   - `routines:list` as `h.teamMember` shows it with `canDelete: false`.
   - Delete as `h.teamMember` rejects `{ toolCode: 'forbidden' }`.
   - Delete as `h.teamAdmin` resolves `{ deleted: true, cleanupPending: false }`.
   - Then `routines:list` as `h.owner` has `unreadable: []`.

- [ ] **Step 2: Run, expect FAIL.** Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/return-schemas.test.ts`, then `DOCKER_HOST=<socket> pnpm --filter @ax/routines exec vitest run src/__tests__/services.test.ts --maxWorkers=1`
- [ ] **Step 3: Implement** the Interfaces block and rules.
- [ ] **Step 4: Run, expect PASS.** Also run `service-hooks.test.ts`, `tools.test.ts` and `done.test.ts` (same form), then build and lint as in Task 3.
- [ ] **Step 5: Commit** (`[TASK-913] routines:list names routines that no longer read; routines:delete deletes them`)

---

### Task 7: The Settings route passes them through, end to end [tier: integration]

**Files:**
- Modify: `packages/routines-admin-routes/src/routes.ts:142-150` (`list`), plus one sentence on `settingsView`'s doc: "TASK-913: routines that no longer read go out as `unreadable`, which holds no task state."
- Test: `packages/routines-admin-routes/src/__tests__/routes.test.ts`. Extend `setup`'s `answers` with `unreadable?: unknown[]`, sent beside `routines` only when given.
- Test: `packages/routines-admin-routes/src/__tests__/human-rest-integration.test.ts` (Docker)

**Interfaces:**
- Consumes: `C.RoutineListOutputSchema` (Task 2) and the service behaviour (Task 6).
- Produces: `GET /settings/routines/:agentId` answers `{ routines: RoutineView[]; unreadable: RoutineUnreadableView[] }`, i.e. `{ routines: out.routines.map(settingsView), unreadable: out.unreadable }`.

- [ ] **Step 1: Write the failing tests.**

In `routes.test.ts`, add `passes the routines that no longer read through the Settings list, and answers none when the service names none (TASK-913)`:
- With `answers.unreadable = [entry]`: `body.unreadable` equals `[entry]` and `body.routines` has one routine.
- With the default setup: `body.unreadable` equals `[]`.

In `human-rest-integration.test.ts`, add `lists a routine that no longer reads through Settings and deletes it from there (TASK-913)`:
- `h = createRoutineHarness({ authenticatedUserId: 'admin' })`.
- Create the file's webhook `definition` on `h.teamAgentId` with `routes.create`, then set its `name` to `'x'.repeat(129)` through `h.db`.
- `routes.list` answers 200 with body equal to `{ routines: [], unreadable: [{ agentId: h.teamAgentId, routineId: row.routineId, revision: row.revision, name: 'x'.repeat(128), origin: 'authored', canDelete: true }] }`. Team agents get no materialized defaults.
- `routes.destroy` with `{ requestId: 'd', expectedRevision: row.revision }` answers 200 `{ deleted: true, cleanupPending: true }`.
- `routes.list` then equals `{ routines: [], unreadable: [] }`.

- [ ] **Step 2: Run, expect FAIL** (the route drops the key): `pnpm --filter @ax/routines-admin-routes exec vitest run src/__tests__/routes.test.ts` and `DOCKER_HOST=<socket> pnpm --filter @ax/routines-admin-routes exec vitest run src/__tests__/human-rest-integration.test.ts --maxWorkers=1`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** Then `pnpm --filter @ax/routines-admin-routes build`, and eslint on the touched files.
- [ ] **Step 5: Commit** (`[TASK-913] Settings list passes through routines that no longer read`)

---

### Task 8: Settings draws a routine that can't be read, with Delete [tier: integration]

Invoke the `shadcn` skill first (CLAUDE.md invariant 6).

**Files:**
- Modify: `packages/channel-web/src/lib/routines.ts` (types near `:22`; `routineApi.list` at `:173-176`)
- Modify: `packages/channel-web/src/components/routines/RoutinesList.tsx`:
  - state (`:65-77`)
  - load (`:112-121`)
  - empty state (`:265-275`)
  - rows (after `:398`)
  - `operation`, `mutate` and `deleting` types (`:76`, `:90-95`, `:158-201`)
  - dialog title (`:443`)
- Test: `packages/channel-web/src/__tests__/routines-list.test.tsx`. Every `routineApi.list` mock returns a page: `{ routines: [...], unreadable: [] }`. The `id === 'b'` implementation returns a page too.
- Test: `packages/channel-web/src/__tests__/routines-default-parity.test.tsx` (its one mock)
- Test: `packages/channel-web/src/__tests__/routines-client.test.ts` (`:154` becomes `.routines[0]`, plus one new test)

**Interfaces:**
- Consumes: `RoutineUnreadableView` (Task 2) and the route's JSON (Task 7).
- Produces:

```ts
export type UnreadableRoutine = RoutineUnreadableView;
export interface RoutineListPage { routines: RoutineView[]; unreadable: UnreadableRoutine[] }
// routineApi
list(agentId: string): Promise<RoutineListPage>;   // unreadable is [] when the answer has none
```

Rules:
- Read both lists from the same `Promise.all` and filter both by `origin`.
- Show the empty state only when both are empty.
- Draw each unreadable entry after the readable rows, separated the way they are (`Separator`):
  - The display name (`name`, or `Untitled routine`) as `truncate text-sm font-medium`.
  - Below it, `text-sm text-muted-foreground`: `We can’t read this routine anymore, so it isn’t running.`, plus ` Delete it and set it up again.` when `canDelete`.
  - The agent's name line when there is no `agentId`, as readable rows have.
  - No chevron, switch or edit.
- When `canDelete`, add `Button variant="outline" size="sm"` with text `Delete routine` and `aria-label` `Delete routine <display name>`. Disable it under the same conditions as the existing Delete. It opens the existing confirm dialog, whose title uses the display name.
- Delete reuses `mutate(…, 'delete')`. Widen the delete target to `Pick<Routine, 'agentId' | 'routineId' | 'revision' | 'name'>`, and keep the enabled toggle typed on a readable `Routine`. The `requestId` retry identity and "Retry change" stay as they are.
- No new component and no raw colors.

- [ ] **Step 1: Write the failing tests.** In `routines-list.test.tsx`, with `const broken = { agentId: 'a', routineId: 'rtn_broken', revision: 'rev_broken', name: 'Broken one', origin: 'authored' as const, canDelete: true }`:
1. `shows a routine that can’t be read, and deletes it with its own revision (TASK-913)`.
   - The page is `{ routines: [row], unreadable: [broken] }`.
   - `Broken one` and the full two-sentence line are visible.
   - Click `Delete routine Broken one`, then the dialog's `Delete`.
   - `routineApi.remove` is called with `{ agentId: 'a', routineId: 'rtn_broken', expectedRevision: 'rev_broken', requestId: expect.any(String) }`.
2. `shows a routine that can’t be read without Delete when the person can’t stop it, and names an untitled one`.
   - The page is `{ routines: [], unreadable: [{ ...broken, name: '', canDelete: false }] }`.
   - `Untitled routine` and the one-sentence line are visible.
   - No button matches `/^Delete routine/`, and there's no `No routines yet`.
3. `keeps a routine that can’t be read to its own list`. An `origin: 'default'` entry isn't drawn in the authored list beside `row`.

In `routines-client.test.ts`, add `list answers the routines that read and the ones that don’t, and reads a missing unreadable list as none (TASK-913)` (fetch mocked twice: with and without `unreadable`).

- [ ] **Step 2: Run, expect FAIL:** `pnpm --filter @ax/channel-web exec vitest run src/__tests__/routines-list.test.tsx src/__tests__/routines-default-parity.test.tsx src/__tests__/routines-client.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** Then `pnpm --filter @ax/channel-web exec tsc --build` (channel-web typechecks its tests) and eslint on the touched files.
- [ ] **Step 5: Commit** (`[TASK-913] Settings shows a routine that can’t be read, with Delete`)

---

## Final gate (after Task 8)

```bash
pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
pnpm lint
```

Set `DOCKER_HOST` explicitly for the Docker-backed suites. Run the `security-checklist` skill over Tasks 3-6 and put its note in the PR body.

## PR body material

**Boundary review (`routines:list` returns, `routines:delete` behaviour):**
- Alternate impl: any routines store (SQLite, file-backed) holds definitions written under older rules. "A stored routine today's rules can't read" means the same thing there.
- Leaky field names: none (`agentId`, `routineId`, `revision`, `name`, `origin`, `canDelete`). No column name, SQLSTATE, zod path or code crosses.
- Subscriber risk: none (a service hook). Consumers that ignore the key keep working (Tasks page, `routine_list`). The default keeps a `{ routines }`-only producer parseable.
- Wire surface: not an IPC action. The Settings HTTP route forwards the key as is. The `routine_list` tool's output, which does reach the runner, is unchanged and never carries it.
- `routines:delete`: signature unchanged. It now also deletes a routine that doesn't read, under the same `stop` rule, read from the same two columns.

**Security-note pointers** (the skill writes the note):
- Sandbox escape: N/A. No sandbox, IPC, process, file or network change.
- Prompt injection: an unreadable entry's `name` is model-authored. It reaches only the browser, as React text cut to 128 code points, and never a model. Log lines carry ids, a screened zod path and a zod code. Delete authority is unchanged, pinned by team member refused, team admin allowed and default refused.
- Supply chain: no new dependency.

**Deploy:** no migration. Rolled back, old code treats `invalidated_reason = 'unreadable'` as a cancelled update (it checks `IS NOT NULL`), and its tick again fails a batch on an unreadable row, as it does today.

**Follow-ups to return to auto-ship** (decisions row 15):
- (a) The Tasks page, Today and the badge omit an unreadable task. A hint there could say a task can't be read and that it can be deleted in Settings → Routines.
- (b) `listDefaults`/`list-agent-defaults` fail whole on one default-catalog row a later rule refuses.

**Accepted, not fixed** (decisions row 11): a legacy `?` cron that reads at claim time and not at accept time costs the rest of that batch one claim window (tick.ts, TASK-1038's file).
