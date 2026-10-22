# TASK-910 Task Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Stay on top of something" task gets its own page at `/workspace/tasks/<agentId>/<routineId>`: the latest update, the brief, the agent's notes (visible, and clearable in a way a running check-in can't undo), the Updates thread, Check now and Pause/Resume. Rows on the Tasks page link to it.

**Architecture:** `@ax/routines` gains one service hook, `routines:clear-notes` (owner only), and schema version 6 adds `agent_notes_cleared_at`. A clear stamps it with a moment no earlier than any open run's start, and `recordReport` refuses to write notes from a run that started at or before it. The routines view's `nextRunAt` starts honouring active hours, so "Next check at" is true. channel-web adds `GET /api/workspace/tasks/:agentId/:routineId` (`routines:get` plus `routines:recent-fires`, fenced into a narrow `TaskDetail`) and `DELETE …/notes`. A new `TaskPage` (with `TaskNotes` and `TaskUpdates`) reads it through `useTask`, and reuses the existing routines admin routes for Check now and Pause/Resume. No new plugin, no new dependency, no new shadcn component.

**Tech Stack:** TypeScript, zod 3, Kysely on Postgres (testcontainers), React 18, shadcn (radix) primitives, Tailwind v3 semantic tokens, vitest + testing-library (no user-event).

**Spec:** the TASK-910 card body, and `docs/plans/2026-10-20-agent-tasks-design.md` §3 (house rules), §3.3, §3.6, §7, §12, §13. Predecessor contracts: "For the sibling cards" in `docs/plans/2026-10-21-task-907-routine-report-plan.md`, `docs/plans/2026-10-22-task-908-checkin-brief-plan.md` and `docs/plans/2026-10-22-task-909-tasks-page-plan.md`. Decisions: `.claude/memory/decisions/2026-10-22-TASK-910.md`, rows counted from the first data row. Read rows 2, 4, 7, 8 and 9 before Task 1. Each one departs from or extends the card.

## Global Constraints

- `routines:clear-notes` is the only new hook. Input `{ agentId, routineId }`, output exactly `{ cleared: true }`. It never changes `revision`, `spec_hash`, `updated_at`, or the task's status, update, ask, reported-at or report-accepted-at.
- One additive schema change: routines version 6, `agent_notes_cleared_at TIMESTAMPTZ` on `routines_v1_definitions`, in `runRoutinesMigration`'s advisory-locked transaction, gated on `routines_schema_versions` row 6. **If origin/main already has a version 6 when you rebase (TASK-919 may add one), take the next free number** and update every version list in `migrations.test.ts`.
- No new dependency, no `pnpm-lock.yaml` change, no shadcn component added. Alert, Breadcrumb, Button, Card, Collapsible, Dialog and Spinner are installed. `ui/alert-dialog` is not, and adding it would add `@radix-ui/react-alert-dialog` (decisions row 9).
- Plain words on the page: Tasks, check in, Needs you. Never routine, webhook or trigger, including in error copy. Never show `RoutineApiError.message` (its copy says "routine"). Copy marked "exact" is decided: paste it. The apostrophe is `’` (U+2019).
- Agent-written text (a report's update and ask, the agent notes) and the person-written brief leave the server only fenced (`fenceLine` / `fenceBlock`, Task 8), and are drawn only as React text children. Multi-line text uses `whitespace-pre-wrap break-words`. No `dangerouslySetInnerHTML`, no markdown component.
- `theme-contrast.test.ts` scans all of `src/` outside `__tests__`, comments included. Never write the text-colour form of the state-quiet token (`text-` + `state-quiet`), and never pair `bg-<family>-soft` with `text-<family>` in a new file. Errors use `Alert variant="destructive"`.
- `src/lib/` modules the server imports use relative `./x.js` imports, never `@/lib/...`: `task-schedule.ts`, `cron-describe.ts`, `workspace-types.ts`, `task-groups.ts`, `fence-line.ts`.
- Run one test file as `pnpm --filter <pkg> test <path>`: the filter goes before the script, and no `--` (`.claude/memory/mistakes/2026-10-20-TASK-904.md`). Check the file count in vitest's summary.
- vitest resolves workspace packages from `dist/`. After Task 1, run `pnpm --filter @ax/routines-contract build` before any routines or channel-web test. channel-web's route tests import `packages/routines/src/services.ts` by relative path, so routines needs no build for them.
- channel-web's `tsc` type-checks its tests: after each channel-web task run `pnpm --filter @ax/channel-web exec tsc --build`.
- Postgres suites need `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`. For the whole routines package also set `VITEST_MAX_WORKERS=2`. Don't run two routines Postgres suites in one worktree at the same moment.
- Test inputs with invisible characters (`'\u202E'`) are escape text. The Write and Edit tools can store the raw character: check with the code-point scan in `.claude/memory/mistakes/2026-10-20-TASK-904.md` before committing (`.claude/memory/mistakes/2026-10-22-TASK-907.md`).
- TDD and the Bug Fix Policy: run each new test against the unmodified code and watch it fail before changing the source.
- Final gates (CLAUDE.md): `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
- Memory: shards only, from `scripts/memory-write-target.sh --shard <kind> TASK-910`. Never touch a root `.claude/memory/*.md`, and never add a `Memory-Rewrite:` trailer.
- Deploy: PR 1 deploys as one. TASK-907 must not deploy before this card (design §7: this page is where a person reads and clears the agent's notes). Say so in the PR.

## Review Focus

1. **A check-in that started before the person pressed Clear reports notes after it, and the host clock stepped back in between.** Its report lands; the notes stay cleared. Pinned in Task 2 (`a check-in accepted before the clear…`, `holds when the host clock steps back…`) and Task 4 (`notes cleared while a check-in runs stay cleared…`).
2. **A task with active hours whose next slot falls outside its window.** "Next check" names the window's start, not a time the tick will skip. Pinned in Task 3.
3. **Check now's answer never arrives, and the person presses it again.** The retry sends the same request, so only one check-in starts. Pinned in Task 12 (`a Check now that couldn't be confirmed…`).
4. **The task was edited or paused in another tab.** The page says so and loads the latest, and Resume uses the new revision. Pinned in Task 12 (`a task changed elsewhere…`, `Pause, then Resume…`).
5. **Someone opens another person's task URL on a team agent.** 404, no run history is read, and none of its text is in the body. Pinned in Task 8 (`404s someone else’s task…`).

## Where this plan departs from the card

Each is a decisions row; say so in the PR description.

- **Only the task's owner may clear its notes, whether or not they still manage the agent's tasks** (row 4). The card says `edit`. The owner is the only person shown the notes, and clearing is the safe direction.
- **Clear notes confirms through the installed `Dialog` destructive-confirm pattern, not `AlertDialog`** (row 9).
- **The schedule words come from `lib/task-schedule.ts` (TASK-906), not `TriggerChip`**, and active hours have no days of the week, so "9 to 6 on weekdays" can't be said (row 8). The header reads like "checks in every hour, 9:00 AM to 6:00 PM (America/New_York)".
- **`RoutineView.nextRunAt` now says when a routine will really run next** (row 7), a routines change the card didn't ask for.
- **Updates entries carry no `triggerSource`, `conversationId` or `ask`** (row 10). TASK-911 adds `conversationId` with "See what it did".
- **A failed check-in reads "This check-in didn’t finish." with its recorded reason under it** (row 13). Plain-word reasons and fixes are design PR 2's.
- **Check now re-reads the task once and doesn't poll** (row 15).

## Card premises, checked (at 1cf119aec)

- **True, and decided:** a check-in accepted before a clear could write notes after it. `recordReport`'s guard (`task_report_accepted_at IS NULL OR <= dispatch.accepted_at`, `packages/routines/src/store.ts:431-462`) has no notion of a clear, and `acceptDispatch` hands the run the old notes for its check-in message (`fire.ts:271`). Row 2.
- **True:** `routines:recent-fires` returns `firedAt, triggerSource, conversationId, status, error, renderedPrompt, warning, report`, newest first by `fired_at` (no tiebreak), limit clamped to 1–200 (`store.ts:564-575`), with `report` shown only to the routine's owner (`fireViews`). The admin routes take `POST /settings/routines/:agentId/:routineId/fire` `{ expectedRevision, requestId }` and `PATCH …/:routineId` `{ expectedRevision, requestId, patch }`, and `writeServiceError` maps `forbidden`/`not-found` → 404, `revision-conflict` → 409, `disabled` → 400. `routines:fire-now` answers once the check-in has started; the turn runs detached (`fire.ts:330-351`). Pause works with `stop`; Resume needs `edit` (`services.ts:115-126`). CSRF is the http-server's global guard for `DELETE` too (`packages/http-server/src/csrf.ts`), and `workspace-api`'s `req()` sends `x-requested-with: ax-admin` on every non-GET. `return-schemas.test.ts` is `packages/routines/src/__tests__/return-schemas.test.ts` and pins 16 services. The preset tests pin routines hooks with `toContain` (no change needed); channel-web's `plugin.test.ts` pins its manifest exactly, and `manifest-declarations.test.ts` refuses an undeclared `bus.call`.
- **Refuted:** `TriggerChip` doesn't humanize ("interval 1h", "webhook /path") and knows nothing of active hours. Active hours are `{ start, end, tz }` with no days. `ui/alert-dialog` isn't installed. And a routine's stored `nextRunAt` isn't its next check-in when it has active hours (`tick.ts:90-100` skips and re-arms).

## For the sibling cards (TASK-911 and later): what this card guarantees

- After `routines:clear-notes` answers, no run accepted at or before the clear can write notes, and the next check-in's message carries none.
- `TaskUpdate` (`lib/workspace-types.ts`) has no `conversationId`. TASK-911 adds it to the type, to `isTaskDetail` (`lib/workspace-api.ts`), and to `toTaskDetail` (`server/routes-workspace.ts`, from the fire view's own field), and puts its link in the trailing space of a `TaskUpdates` entry (the entry body is `min-w-0 flex-1`).
- `checkInSchedule` is the task page's schedule phrase. `describeCheckIns` stays the approval card's sentence.
- `TASK_GROUP_LABELS` and `taskGroup` live in `lib/task-groups.ts`, for every surface. `routeLinkProps` (`lib/route-link.ts`) is how a workspace surface links to another view.
- **Design PR 2** owns No recent update: the latest update card shows `task` (the last report) even when a newer check-in failed above it in Updates. It also owns plain-word failure reasons with a fix, and the live "checking in" state after Check now or a reply.
- **Design PR 4** replaces the "Change these in {agent}’s settings" link with ⋯ › Edit.

## Order and file ownership

| Wave | Task | Touches | Depends on |
|---|---|---|---|
| 1 | T1 contract | `routines-contract/src/services.ts`, new contract test | — |
| 1 | T2 clear and guard | `routines/src/{migrations,store,types}.ts`, `migrations.test.ts`, new `clear-notes-store.test.ts` | — |
| 1 | T3 next check | `routines/src/services.ts` (`routineView` only), new `next-check.test.ts` | — |
| 1 | T5 schedule phrase | `channel-web/src/lib/{cron-describe,task-schedule}.ts` and tests, design §3.2, §3.3 | — |
| 1 | T6 wire and fold | `channel-web/src/lib/workspace-types.ts`, new `lib/task-updates.ts` and test | — |
| 1 | T7 words and links | `channel-web/src/lib/{workspace-time,task-groups}.ts`, new `lib/route-link.ts`, `TasksPage.tsx` (labels import), tests | — |
| 2 | T4 the hook | `routines/src/services.ts` (register), `return-schemas.test.ts`, new `clear-notes.test.ts`, `checkin.test.ts`, `canary.test.ts`, design §4.5, §7, §13, §15 | T1, T2, T3 |
| 2 | T8 the routes | `channel-web/src/server/{routes-workspace,plugin}.ts`, `plugin.test.ts`, `routes-workspace-registration.test.ts`, new `routes-workspace-task.test.ts` | T1, T3, T5, T6 |
| 2 | T9 client read | `channel-web/src/lib/workspace-api.ts`, new `lib/workspace-task.ts`, two new tests | T6 |
| 3 | T10 notes | new `components/workspace/TaskNotes.tsx` and test | T9 |
| 3 | T11 updates | new `components/workspace/TaskUpdates.tsx` and test | T6, T7 |
| 4 | T12 the page | new `components/workspace/TaskPage.tsx` and test | T7, T9, T10, T11 |
| 5 | T13 routing | `lib/workspace-route.ts`, `TasksPage.tsx`, `WorkspaceShell.tsx`, their tests | T12 |

Paths below are under `packages/channel-web/src/` unless they start with `docs/` or `packages/`. T2 runs Postgres suites and T3's are pure, so they can share wave 1.

---

### Task 1: The `routines:clear-notes` contract [tier: mechanical]

**Files:**
- Modify: `packages/routines-contract/src/services.ts`: new schemas after `RoutineReportOutputSchema` (:53), types at the end, and one sentence in `RoutineReportInputSchema`'s comment (:43-47)
- Test: create `packages/routines-contract/src/__tests__/clear-notes.test.ts`

**Interfaces:**
- Produces:

```ts
/**
 * `routines:clear-notes` (TASK-910): the person clears a task's agent notes,
 * the text its next check-in reads (design §7). Only the routine's owner may.
 * No run accepted at or before the clear can write notes again. It never
 * changes the routine's revision.
 */
export const RoutineClearNotesInputSchema = RoutineKeySchema;
export const RoutineClearNotesOutputSchema = z.object({ cleared: z.literal(true) }).strict();
export type RoutineClearNotesInput = z.output<typeof RoutineClearNotesInputSchema>;
export type RoutineClearNotesOutput = z.output<typeof RoutineClearNotesOutputSchema>;
```

- [ ] **Step 1: Write the failing tests**: `takes exactly a routine's key` (parses `{ agentId: 'a', routineId: 'r' }`; refuses one with `notes: null` added, and one without `routineId`); `answers only { cleared: true }` (`{ cleared: false }` and `{ cleared: true, notes: null }` are refused).
- [ ] **Step 2: Run and watch it fail:** `pnpm --filter @ax/routines-contract test src/__tests__/clear-notes.test.ts`.
- [ ] **Step 3: Add the schemas and types.** Append to `RoutineReportInputSchema`'s comment (exact): "A run accepted at or before the person last cleared the notes can't change them (TASK-910)."
- [ ] **Step 4: Run it (PASS), then** `pnpm --filter @ax/routines-contract build`.
- [ ] **Step 5: Commit:** `git commit -m "routines-contract: the routines:clear-notes schemas (TASK-910)"`

### Task 2: A clear holds against a check-in already running [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/routines/src/migrations.ts`: `RoutinesDefinitionsRow` (:39-51; add the column, and to the version-4 comment "and NULL again after the person clears them, `routines:clear-notes`"), `runRoutinesMigration` (:159-162, version 6), a new `addNotesClearedColumn`
- Modify: `packages/routines/src/store.ts`: `RoutinesStore` (:45), `recordReport` (:431-462), a new `clearAgentNotes`
- Modify: `packages/routines/src/types.ts:46-50` (`RecordReportInput`'s comment gains "A run accepted at or before the last clear can't change the notes (TASK-910).")
- Test: `packages/routines/src/__tests__/migrations.test.ts`; create `packages/routines/src/__tests__/clear-notes-store.test.ts`

**Interfaces:**
- Produces:

```ts
// RoutinesDefinitionsRow, version 6
agent_notes_cleared_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
// RoutinesStore
/**
 * TASK-910. The person clears a task's agent notes. Owner only, decided under
 * the routine's row lock. No run accepted at or before the clear can write
 * notes again (`recordReport`). Touches nothing else in the row.
 */
clearAgentNotes(input: RoutineKey & { actorUserId: string; now: Date }): Promise<'cleared' | 'not-found' | 'forbidden'>;
```

**The rule (decisions row 2):**
- `clearAgentNotes`, in one transaction: `lockLiveAgent` false → `'not-found'`; the definition row read `FOR UPDATE` (owner only), missing → `'not-found'`; `owner_user_id !== actorUserId` → `'forbidden'`; else one UPDATE setting `agent_notes = NULL` and

  ```sql
  agent_notes_cleared_at = GREATEST(${now}, (SELECT max(accepted_at) FROM routines_v1_dispatches
    WHERE agent_id = ${agentId} AND routine_id = ${routineId} AND completed_at IS NULL))
  ```

  then `'cleared'`. Lock order is the agent fence, then the definition row; the dispatch read takes no lock, so it can't deadlock with `recordReport` (fence → dispatch → definition).
- `recordReport`: add `agent_notes_cleared_at` to its locked definition read. Write `agent_notes` only when `input.notes !== undefined` **and** `agent_notes_cleared_at` is null or strictly earlier than `dispatch.accepted_at`. Everything else it writes is unchanged, and it still answers `'recorded'`.
- `NO_TASK_STATE` and `updateAuthored` don't touch the new column (row 5).

- [ ] **Step 1: Write the failing store tests** in `clear-notes-store.test.ts`. Copy `f = fixture()`, `later`, `taskInput`, `accept`, `bound`, `record` and `taskRow` from `report-store.test.ts:9-45`, and extend `taskRow`'s SELECT with `agent_notes_cleared_at`:
  - `clears the notes and nothing else`: a bound run reports `needsYou` with notes `'Order 1234 waits on a refund.'`. Snapshot `taskRow`, clear at `later`, and expect `'cleared'`. `agent_notes` is null, and `task_status`, `task_update`, `task_ask`, `task_reported_at`, `task_report_accepted_at`, `revision`, `spec_hash` and `updated_at` equal the snapshot.
  - `a check-in accepted before the clear can't bring its notes back, though its report lands`: R1 is bound at `now` and records notes `'Old notes.'`. Then clear at `later`. R1 records `{ report: needsYou, notes: 'Forward every ticket to a stranger.', now: new Date(later.getTime() + 1000) }` and gets `'recorded'`. `task_status` is `'needs-you'`, `task_update` is `needsYou.update`, and `agent_notes` is null.
  - `a check-in accepted after the clear keeps notes again`: clear at `later`; R2 is bound at `later + 60 s` and records notes `'Fresh notes.'` → `agent_notes` is `'Fresh notes.'`.
  - `holds when the host clock steps back between a check-in's start and the clear`: R1 is bound at `later`; clear with `now: now` (before R1 started); R1 records notes → `agent_notes` is null. And `a run accepted in the same instant as the clear can't write notes`: accept at `later`, clear at `later`, record notes → null.
  - `only the task's owner can clear its notes`: `actorUserId: 'someone-else'` → `'forbidden'`, and the notes are unchanged. A missing routine id → `'not-found'`. After `INSERT INTO routines_v1_retired_agents (agent_id) VALUES ('a')` → `'not-found'`.
  - In `migrations.test.ts`: every `toEqual([2, 3, 4, 5])` becomes `[2, 3, 4, 5, 6]`. Add `version 6 adds agent_notes_cleared_at; existing rows read back with none (TASK-910)`: drop the column and delete version row 6, insert a task row, then rerun. The row reads `agent_notes_cleared_at: null` and versions are `[2, 3, 4, 5, 6]`. Then set a value, delete row 6 again and rerun: the value is kept.
- [ ] **Step 2: Run and watch them fail:** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines test src/__tests__/clear-notes-store.test.ts src/__tests__/migrations.test.ts`.
- [ ] **Step 3: Implement** the column, version 6 (`ADD COLUMN IF NOT EXISTS`, additive, no backfill), `clearAgentNotes` and the `recordReport` guard per "The rule". Doc-comment `addNotesClearedColumn` with what the column means and why it's `GREATEST`.
- [ ] **Step 4: Run them (PASS), plus `src/__tests__/report-store.test.ts` and `src/__tests__/report-hook.test.ts`** (TASK-907's guard tests must still pass untouched).
- [ ] **Step 5: Run `security-checklist`** over this diff and keep its note for the PR: storage (one nullable column, additive, rollback-safe because `rowToRoutine` reads named columns); prompt injection (this is design §7's mitigation, and the guard is clock-independent); no sandbox, IPC or dependency change.
- [ ] **Step 6: Commit:** `git commit -m "routines: a clear of a task's notes holds against a check-in already running (TASK-910)"`

### Task 3: A task's `nextRunAt` says when it will really check in [tier: integration]

**Files:**
- Modify: `packages/routines/src/services.ts:31-37` (`routineView`), importing `advanceToNextActiveWindow` from `./active-hours.js`
- Test: create `packages/routines/src/__tests__/next-check.test.ts`

**Interfaces:**
- Produces: `RoutineView.nextRunAt` is the stored next run moved to the start of the next active window when it falls outside one (`advanceToNextActiveWindow(row.nextRunAt, row.activeHours)`), and as stored otherwise. Name and type unchanged; storage and the tick unchanged. A one-line comment says the tick skips a run outside its window and re-arms at the window's start (`tick.ts:90-100`), so this is when it will run (decisions row 7).

- [ ] **Step 1: Write the failing tests** with a row built like `return-schemas.test.ts:5-10`, given `activeHours: { start: '09:00', end: '18:00', tz: 'UTC' }`:
  - `moves a next run after the day's window to the next morning`: stored `2030-01-01T18:30:00Z` → `'2030-01-02T09:00:00.000Z'`.
  - `moves one before the window to its start`: `07:00Z` → `'2030-01-01T09:00:00.000Z'`.
  - `keeps one inside the window, and any routine without active hours, as stored`.
  - `reads the window in its own time zone`: tz `'America/New_York'`, stored `2030-01-01T23:30:00Z` → `'2030-01-02T14:00:00.000Z'`.
  - `a paused routine has no next run`: `nextRunAt: null` → `null`.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/routines test src/__tests__/next-check.test.ts`.
- [ ] **Step 3: Implement** in `routineView`.
- [ ] **Step 4: Run it and `src/__tests__/return-schemas.test.ts` (PASS).**
- [ ] **Step 5: Commit:** `git commit -m "routines: a routine's next run honours its active hours in every view (TASK-910)"`

### Task 4: `routines:clear-notes` [tier: sensitive] (security-checklist, boundary review)

**Files:**
- Modify: `packages/routines/src/services.ts`: `ROUTINE_SERVICES` (:10-14) gains `'clear-notes'`; register it after `report`
- Modify: `packages/routines/src/__tests__/return-schemas.test.ts:48-53`
- Create: `packages/routines/src/__tests__/clear-notes.test.ts`
- Modify: `packages/routines/src/__tests__/checkin.test.ts` (a new `describe`), `packages/routines/src/__tests__/canary.test.ts` (the PR 1 backend canary's tail, after :472)
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`: §4.5's Hooks row (:447) and §13's New hooks (:869) gain `routines:clear-notes` after `routines:report`; §7 (:624-625) and §15 (append)

**Interfaces:**
- Consumes: T1's schemas; T2's `store.clearAgentNotes`.
- Produces: `routines:clear-notes` (ctx, `{ agentId, routineId }`) → `{ cleared: true }`. It first runs `access(ctx, agentId)` (an `agents:resolve` refusal propagates), then `store.clearAgentNotes({ ...input, actorUserId: ctx.userId, now: now() })`. `'not-found'` → `SafeToolError('not-found', 'routineId')`; `'forbidden'` → `SafeToolError('forbidden', 'input')`. On `'cleared'` it logs `ctx.logger.info('routines_notes_cleared', { agentId, routineId })`, ids only (row 6). It doesn't check `a.allowed` (row 4).

- [ ] **Step 1: Write the failing tests.**
  - `return-schemas.test.ts`: `toHaveLength(17)`, `toContain('routines:clear-notes')`, and `C.RoutineClearNotesOutputSchema.parse({ cleared: true })` equals `{ cleared: true }`.
  - `clear-notes.test.ts` (`createRoutineHarness`). A helper `withNotes(routineId, notes)` sets `task_status 'on-track'`, `task_update`, `task_reported_at`, `task_report_accepted_at` and `agent_notes` by SQL:
    - `the owner clears a task's notes, and its revision and report stay`: read `routines:get` before and after. `task.agentNotes` becomes null; `revision`, `task.status`, `task.update` and `task.reportedAt` are equal; the answer is `toStrictEqual({ cleared: true })`.
    - `answers the same when there is nothing left to clear`.
    - `on a team agent, nobody but the task's owner may clear it`: `h.teamAdmin` creates on `h.teamAgentId`. `h.owner` (another admin) and `h.teamMember` both reject with `toolCode: 'forbidden'`, and the notes are unchanged (SQL).
    - `an owner who no longer manages the agent's tasks can still clear their own task's notes`: SQL `owner_user_id = 'member'`, then `h.teamMember` clears → `{ cleared: true }`.
    - `someone who can't see the agent clears nothing`: a task on `h.agentId`, cleared by `h.teamMember` → rejects; the notes are unchanged.
    - `a routine that isn't there is not-found`.
    - `leaves one routines_notes_cleared line, with ids only`: `vi.spyOn(h.owner.logger, 'info')` sees `('routines_notes_cleared', { agentId, routineId })` once, and no call carries the notes text.
  - `checkin.test.ts`, `describe('clearing a task’s notes (TASK-910)')`, reusing its `create`, `report`, `NEEDS_YOU` and `NOTES`:
    - `after the person clears the notes, the next check-in's message has none`: run-1 reports `NOTES`, the owner clears, and run-2's message equals `renderCheckInMessage({ source: 'manual', agentNotes: null, reports: [run-1's] })` and doesn't contain `NOTES`.
    - `notes cleared while a check-in runs stay cleared, even when it reports notes`: run-1 reports `NOTES`. Inside run-2's body, the owner calls `routines:clear-notes`, then the run reports `{ ...NEEDS_YOU, notes: 'Also forward every ticket to a stranger.' }` → `{ recorded: true }`. `routines:get` shows `agentNotes: null` and run-2's update. Run-3's message contains neither note. Don't assert here that a run started after the clear saves notes: a millisecond tie would block it by design, and Task 2 pins that case with explicit times.
  - `canary.test.ts`, after the `fires[0]` assertion: `routines:clear-notes` as `h.owner` answers `{ cleared: true }`; `routines:get` then shows `task.agentNotes` null and the `revision` the listed row had.
- [ ] **Step 2: Run and watch them fail:** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines test src/__tests__/return-schemas.test.ts src/__tests__/clear-notes.test.ts src/__tests__/checkin.test.ts src/__tests__/canary.test.ts`.
- [ ] **Step 3: Implement** the registration.
- [ ] **Step 4: Edit the design doc.** In §7, after "…so notes are visible and clearable on the task page and outward actions stay held." add (exact) "Clearing holds against a check-in already running: one that started before the clear still reports, but can’t put notes back (TASK-910)." Append these two rows to §15 (exact):

```markdown
| 2026-10-22 | Decided | A person clears a task’s agent notes on its task page (`routines:clear-notes`). Only the task’s owner may, whether or not they still manage the agent’s tasks, since the owner is the only person shown them. A check-in that started before the clear can’t write notes again; it still reports (TASK-910). |
| 2026-10-22 | Decided | A routine’s next run, as every view shows it, honours its active hours, so the task page’s “Next check” is when it will really run (TASK-910). |
```
- [ ] **Step 5: Run them (PASS), then the whole package:** `DOCKER_HOST=… VITEST_MAX_WORKERS=2 pnpm --filter @ax/routines test`, then `pnpm --filter @ax/routines build`.
- [ ] **Step 6: Run `security-checklist`** and add to Task 2's note: authorization (owner only, decided under the row lock; `agents:resolve` first; not reachable by the model, since it is not a tool or an IPC action); the residual risk in "Before the PR".
- [ ] **Step 7: Commit:** `git commit -m "routines: routines:clear-notes, for the person who owns a task (TASK-910)"`

### Task 5: How often a task checks in, as a phrase [tier: mechanical]

**Files:**
- Modify: `lib/cron-describe.ts`: export `clockTime` (:93); `describeFields` (:115) returns phrases without the leading `Runs `; `describeCron` prepends it, so its output is byte-for-byte unchanged; add `describeCronPhrase`
- Modify: `lib/task-schedule.ts`: add `checkInSchedule` (`describeCheckIns` unchanged)
- Test: `lib/__tests__/cron-describe.test.ts`, `lib/__tests__/task-schedule.test.ts`
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md` §3.2 (after the New task mock's closing fence, :160) and §3.3 (after the mock's closing fence, :198)

**Interfaces:**
- Produces:

```ts
// lib/cron-describe.ts
export function clockTime(minute: string, hour: string): string;            // '0','9' → '9:00 AM'
export function describeCronPhrase(expr: string, timezone?: string): CronDescription; // like describeCron, text without "Runs "
// lib/task-schedule.ts (import type { ActiveHours, RoutineTrigger } from '@ax/routines-contract')
/** How often a task checks in, as the words after "checks in" (TASK-910), or null when it doesn't check in on a schedule. Carries the trigger's own time zone, so a caller fences it. */
export function checkInSchedule(trigger: RoutineTrigger, activeHours: ActiveHours | null): string | null;
```

Rules: an interval says `every ${unit}` for 1, else `every ${n} ${unit}s` (`UNIT_WORDS`), and null when unreadable. A cron says `describeCronPhrase(expr, tz)`'s text when described, else `'on a custom schedule'`. A webhook says null. When the phrase isn't null and `activeHours` is set, append `, ${hm(start)} to ${hm(end)} (${tz})`, where `hm('00:00')` and `hm('24:00')` are `'midnight'` and anything else is `clockTime`.

- [ ] **Step 1: Write the failing tests.** cron-describe: `describes a cron as the words after "checks in"`: `describeCronPhrase('0 9 * * 1-5', 'America/New_York')` → `{ kind: 'described', text: 'at 9:00 AM, every weekday (America/New_York)' }`, `'*/15 * * * *'` → `'every 15 minutes'`, and `'15,45 2-4 * * *'` → `{ kind: 'unknown' }`. Every existing `describeCron` test passes untouched. task-schedule: `it.each([['15m', 'every 15 minutes'], ['1h', 'every hour'], ['2d', 'every 2 days']])`; `a cron it can describe` → `'at 9:00 AM, every weekday (America/New_York)'`; `a cron it can't` → `'on a custom schedule'`; `a webhook` → null; `adds the active hours, in their own time zone` (`every: '1h'`, `{ start: '09:00', end: '18:00', tz: 'America/New_York' }`) → `'every hour, 9:00 AM to 6:00 PM (America/New_York)'`; `says midnight for the end of the day` (`{ start: '22:00', end: '24:00', tz: 'UTC' }`) → `'every hour, 10:00 PM to midnight (UTC)'`.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/cron-describe.test.ts src/lib/__tests__/task-schedule.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Correct the design doc (rule 5, decisions row 21).** After the §3.3 mock (exact): "> PR 1 (TASK-910): today’s active hours are one window every day, with no days of the week, so the header reads like “checks in every hour, 9:00 AM to 6:00 PM (America/New_York)”. A weekdays-only window needs a schedule that names the days (a cron) until PR 4’s New task dialog settles how people pick days." After the §3.2 mock (exact): "> “Only 9 to 6 on weekdays” needs days of the week in active hours, which routines don’t have yet (one window every day). PR 4 adds them or builds that checkbox on a cron."
- [ ] **Step 6: Commit:** `git commit -m "Agent Tasks: how often a task checks in, in plain words (TASK-910)"`

### Task 6: The task page's wire shape, and how Updates fold [tier: mechanical]

**Files:**
- Modify: `lib/workspace-types.ts` (append after `TasksResponse`, :1337)
- Create: `lib/task-updates.ts`; test `lib/__tests__/task-updates.test.ts`

**Interfaces:**
- Produces:

```ts
// lib/workspace-types.ts. Doc each: the agent wrote update/ask/agentNotes, the server fenced them (TASK-910).
export interface TaskDetailReport { status: RoutineReportStatus; update: string | null; ask: string | null; agentNotes: string | null; reportedAt: string }
export interface TaskUpdate {
  /** When the check-in started, ISO. */ firedAt: string;
  status: 'ok' | 'silenced' | 'error';
  /** The recorded reason, one fenced line, only when status is 'error'. */ error: string | null;
  report: { status: RoutineReportStatus; update: string | null } | null;
}
export interface TaskDetail {
  agentName: string; name: string; enabled: boolean;
  /** Check now's and Pause/Resume's `expectedRevision`. */ revision: string;
  /** fire: start a check-in. stop: pause. edit: resume. As the routines services decide them. */
  permissions: { fire: boolean; stop: boolean; edit: boolean };
  /** The words after "checks in", or null. */ schedule: string | null;
  /** When the next check-in is due, ISO; null when paused. */ nextCheckAt: string | null;
  brief: { promptBody: string | null; goodWhen: string | null };
  task: TaskDetailReport | null;
  /** Newest first, at most 50. */ updates: TaskUpdate[];
}
// lib/task-updates.ts (relative imports only)
export const FOLD_MIN_HIDDEN = 2;
export type UpdateItem = { kind: 'update'; update: TaskUpdate } | { kind: 'fold'; updates: TaskUpdate[] };
export function foldUpdates(updates: readonly TaskUpdate[]): UpdateItem[];
```

Fold rule (decisions row 14): an update is quiet when `status !== 'error'` and `report?.status === 'on-track'`. Each maximal run of consecutive quiet updates keeps its first (newest) as an `update`; when at least `FOLD_MIN_HIDDEN` follow it, they become one `fold` right after it, and a shorter tail stays as single updates. Everything else is an `update`. Order is kept; the input isn't mutated.

- [ ] **Step 1: Write the failing tests**, with a helper `u(status, over)`:
  - `shows the newest of a run of on-track check-ins and folds the rest`: 6 on-track → `[update(0), fold(1..5)]`.
  - `doesn't fold a run with only one to hide`: 2 on-track → two updates.
  - `any other check-in breaks a run`: `[needs-you, on, on, on, off-track, on, on]` → `[u, u, fold(2), u, u, u]`.
  - `never folds a failed check-in, or one without a report`: an `error` run with an on-track report, and a `report: null` run, stay single and break runs.
  - `keeps the order and doesn't change its input`.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/task-updates.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit:** `git commit -m "Agent Tasks: the task page's wire shape, and quiet check-ins fold (TASK-910)"`

### Task 7: Time words, status words and in-app links [tier: mechanical]

**Files:**
- Modify: `lib/workspace-time.ts` (append); test `lib/__tests__/workspace-time.test.ts`
- Modify: `lib/task-groups.ts`; test `lib/__tests__/task-groups.test.ts`
- Modify: `components/workspace/TasksPage.tsx:50-56` (import `TASK_GROUP_LABELS` from `@/lib/task-groups`, delete the local copy and its "Move them…" comment)
- Create: `lib/route-link.ts`; test `lib/__tests__/route-link.test.ts`

**Interfaces:**
- Produces:

```ts
// lib/workspace-time.ts
/** "at 10:02 AM" today, "tomorrow at 9:00 AM", "yesterday at 4:58 PM", else "on Mon, Oct 20 at 10:02 AM"; null on an instant it can't read. Reader's time zone. */
export function checkInWhen(iso: string, now: Date = new Date()): string | null;
/** An Updates entry's time: localTime today, else `${localDayLabel(d, now)}, ${localTime}`; null on an instant it can't read. */
export function updateStamp(iso: string, now: Date = new Date()): string | null;
// lib/task-groups.ts
export const TASK_GROUP_LABELS: Record<TaskGroup, string>; // exact: 'Needs you', 'Off track', 'On track', 'No update yet', 'Paused'
export function taskGroup(row: { enabled: boolean; task: { status: RoutineReportStatus } | null }): TaskGroup; // was (row: TaskRow); same rule
// lib/route-link.ts (relative imports)
export function routeLinkProps(route: WorkspaceRoute, onNavigate: (route: WorkspaceRoute) => void):
  { href: string; onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void };
```

`checkInWhen`'s other-day form is `on ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at ${localTime}`. `routeLinkProps`: `href` is `workspaceRoutePath(route)`; `onClick` calls `preventDefault()` and `onNavigate(route)` only for an unmodified primary click (`button === 0`, no meta, ctrl, shift or alt, not `defaultPrevented`); any other click is the browser's.

- [ ] **Step 1: Write the failing tests.** workspace-time (build every expectation from `localTime(iso)` so the test is locale-proof, with `now = new Date(2026, 9, 22, 12, 0)`): `says when a check-in was or will be, on the reader’s calendar`: same day → `at ${localTime}`, next day → `tomorrow at …`, previous day → `yesterday at …`, four days on → `on … at …`, `'nope'` → null. `stamps an update with its time, and its day when that isn’t today`. task-groups: `words each mark the same way on every page` (the exact labels); `groups a task page’s detail like a Tasks row` (`taskGroup({ enabled: false, task: { status: 'needs-you' } })` → `'paused'`; `{ enabled: true, task: null }` → `'no-update'`). route-link: `links to the route’s own address`; `a plain click stays in the app` (`preventDefault` and `onNavigate` once, with the route); `it.each(['metaKey', 'ctrlKey', 'shiftKey', 'altKey'])('a %s click is left to the browser')`; `a middle click is left to the browser` (`button: 1`).
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-time.test.ts src/lib/__tests__/task-groups.test.ts src/lib/__tests__/route-link.test.ts`.
- [ ] **Step 3: Implement**, and move the labels out of `TasksPage.tsx`.
- [ ] **Step 4: Run them plus `src/components/workspace/__tests__/TasksPage.test.tsx` (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit:** `git commit -m "Agent Tasks: check-in times, status words and in-app links (TASK-910)"`

### Task 8: The task page's two routes [tier: sensitive] (security-checklist)

**Files:**
- Modify: `server/routes-workspace.ts`. The header route list (:1-24) and the security paragraph (:51-80); the `@ax/core` import (add `SafeToolError`) and the `@ax/routines-contract` imports (`ROUTINE_REPORT_ASK_MAX_CHARS`, `ROUTINE_AGENT_NOTES_MAX_CHARS`, `type RoutineFireView`). Near the TASK-909 helpers (:3224-3290): `isOwnTask`'s parameter widens to `Pick<RoutineView, 'task' | 'permissions'>`, and its comment says the task page uses it too. New there: `TASK_UPDATES_LIMIT`, `TASK_NOTES_MAX_CHARS`, `TASK_NOTES_MAX_LINES`, `isTaskRefusal`, `toTaskDetail`. Handlers `taskDetail` and `clearTaskNotes` go after `tasks` (:6714), and two route entries after `/api/workspace/tasks` (:8969).
- Modify: `server/plugin.ts`: the header comment (after the TASK-909 sentence, :62-64), and three `optionalCalls` right after the `routines:list` entry (:302)
- Modify: `__tests__/server/plugin.test.ts` (the same three entries after :777), `__tests__/server/routes-workspace-registration.test.ts` (two `toContain`)
- Create: `__tests__/server/routes-workspace-task.test.ts`

**Interfaces:**
- Consumes: `RoutineClearNotesOutputSchema` (T1); `checkInSchedule` (T5); `TaskDetail`, `TaskUpdate` (T6).
- Produces: `GET /api/workspace/tasks/:agentId/:routineId` → 200 `TaskDetail`. `DELETE /api/workspace/tasks/:agentId/:routineId/notes` → 200 `{ cleared: true }`. Both: 401 `{ error: 'unauthenticated' }`, 400 `{ error: 'missing-task-id' }`, 404 `{ error: 'agent-not-found' }` (from `resolveAgentOr404`) or `{ error: 'task-not-found' }`. The DELETE also answers 503 `{ error: 'task-notes-unavailable' }` without the hook.

**The detail route (decisions rows 10–11), in this order:** `authOr401` → trimmed `agentId`/`routineId`, either empty → 400 → without `routines:get` or `routines:recent-fires` → 404 `task-not-found` → `resolveAgentOr404(bus, initCtx, agentId, userId, res)` → `routines:get` through `agentWorkspaceCtx(agentId, userId)`, where `isTaskRefusal(err)` → 404 and any other throw propagates → `view.kind === 'repeat' || !isOwnTask(view)` → 404 → `routines:recent-fires` `{ agentId, routineId, limit: TASK_UPDATES_LIMIT }` with the same ctx, any throw propagates (a failed history read fails the page; row 11) → 200 `toTaskDetail(agent, view, fires)`. No history is read before the ownership decision.
- `isTaskRefusal(err)`: a `SafeToolError` whose `toolCode` is `not-found`, `forbidden` or `validation` (an id from the URL that can't exist), or a `PluginError` whose `code` is `not-found` or `forbidden`. Check `SafeToolError` first: it is a `PluginError` with code `invalid-payload`.
- `toTaskDetail`, field by field, never spreading a view: `agentName: agent.displayName`; `name: fenceLine(view.name, ROUTINE_NAME_MAX_CHARS) ?? 'Untitled task'`; `enabled`, `revision`; `permissions: { fire, stop, edit }`; `schedule: fenceLine(checkInSchedule(view.trigger, view.activeHours), DECISION_TASK_CHECKS_IN_MAX_CHARS)`; `nextCheckAt: view.nextRunAt`; `brief` from `fenceBlock(…, DECISION_TASK_TEXT_MAX_CHARS, DECISION_TASK_TEXT_MAX_LINES)?.text ?? null` for `promptBody` and `goodWhen`; `task`: `update` through `fenceLine(…, ROUTINE_REPORT_UPDATE_MAX_CHARS)`, `ask` through `fenceLine(…, ROUTINE_REPORT_ASK_MAX_CHARS)`, `agentNotes` through `fenceBlock(…, TASK_NOTES_MAX_CHARS, TASK_NOTES_MAX_LINES)?.text ?? null`; each update: `firedAt`, `status`, `error` (only for `'error'`: `fenceLine(fire.error, ACTIVITY_DETAIL_MAX_CHARS)`, else null), and `report` as `{ status, update: fenceLine(…, ROUTINE_REPORT_UPDATE_MAX_CHARS) }` or null. Nothing else crosses: no `renderedPrompt`, `warning`, `triggerSource` or `conversationId`.
- Constants: `TASK_UPDATES_LIMIT = 50`; `TASK_NOTES_MAX_CHARS = 6 * ROUTINE_AGENT_NOTES_MAX_CHARS` and `TASK_NOTES_MAX_LINES = ROUTINE_AGENT_NOTES_MAX_CHARS + 1`. These are sized so that everything the check-in message reads (the notes' first 2,000 UTF-16 units, even if every one becomes a six-character `\uXXXX` escape) always shows (row 10).
- **The DELETE route:** `authOr401` → ids (400) → without `routines:clear-notes`, 503 → `resolveAgentOr404` → `routines:clear-notes` `{ agentId, routineId }` through `agentWorkspaceCtx`, where `isTaskRefusal` → 404 and any other throw propagates → 200 `{ cleared: true }`. CSRF is the http-server's global guard (row 12).
- `optionalCalls` (exact):
  - `{ hook: 'routines:get', degradation: 'the task page (GET /api/workspace/tasks/:agentId/:routineId) answers 404, because without @ax/routines there are no tasks' }`
  - `{ hook: 'routines:recent-fires', degradation: 'the task page answers 404, as it does without routines:get (both come from @ax/routines)' }`
  - `{ hook: 'routines:clear-notes', degradation: 'Clear notes on the task page (DELETE /api/workspace/tasks/:agentId/:routineId/notes) answers 503 and the notes stay' }`
- Comments (exact). In the `plugin.ts` header, after the TASK-909 sentence: "TASK-910 adds no hard call either: the task page reads the optional routines:get and routines:recent-fires and answers 404 without them, and clears notes through the optional routines:clear-notes, answering 503 without it." In the `routes-workspace.ts` header list, after the `/tasks` line: `GET  /api/workspace/tasks/:agentId/:routineId — one task's page: its latest update, brief, notes and updates (TASK-910)` and `DELETE /api/workspace/tasks/:agentId/:routineId/notes — clear the agent's notes on that task (TASK-910)`. In the security paragraph, the task page's two routes join the list gated by `agents:resolve` before any read, and this sentence is added: "The task page then shows only the caller's own task (`isOwnTask`), and reads no run history before deciding that."

- [ ] **Step 1: Write the failing tests.** Copy `mkReq`, `mkRes`, `initCtx`, `stored` and `report` from `routes-workspace-tasks.test.ts:31-104`. A `setup(world)` registers: `auth:require-user`; `agents:resolve`, which throws `PluginError({ code: 'not-found', … })` unless the viewer may reach the agent and records each call; `routines:get` with `{ returns: RoutineGetOutputSchema }`, answering the real `routineView(row, ctx.userId, managers[agentId]?.includes(ctx.userId) ?? false)` or throwing `new SafeToolError('not-found', 'routineId')`; `routines:recent-fires` with `{ returns: RoutineRecentFiresOutputSchema }`, answering the world's fire views (literal `RoutineFireView`s) and recording `{ userId, input }`; `routines:clear-notes` with `{ returns: RoutineClearNotesOutputSchema }`, recording calls or throwing a configured error. Use `nextRunAt` values inside any active-hours window, so Task 3's projection doesn't change them.
  - `answers the task’s latest update, brief, notes and updates`: interval `1h`, active hours 09:00–18:00 `America/New_York`, a needs-you report with an ask and notes, and two fires (one reported, one error). The body `toEqual`s the whole `TaskDetail`, with `schedule: 'every hour, 9:00 AM to 6:00 PM (America/New_York)'`.
  - `asks for the newest 50 check-ins, as the caller`: the recorded input is `{ agentId: 'a1', routineId: 't1', limit: 50 }` and `userId` is `'alice'`.
  - `404s a repeat routine, and reads none of its history`: `task-not-found`, and no `recent-fires` call.
  - `404s someone else’s task on a team agent, and nothing of it is in the body`: Bob's task on a team agent, viewed by Alice. No `recent-fires` call, and `JSON.stringify(body)` has neither `BOB-UPDATE` nor `BOB-NOTES`.
  - `shows a reported task to an owner who can no longer manage the agent’s tasks, with every action off`: `permissions` is `{ fire: false, stop: false, edit: false }`. This is TASK-909's `isOwnTask` rule, unchanged.
  - `404s an agent the caller can’t reach, and reads nothing of it`: `agent-not-found`, and no `routines:get` call.
  - `404s a routine that isn’t there`.
  - `fences what the agent wrote`. An update `'first\nsecond'` → `'first second'`. A 600-character update or ask → 500 code points ending in `'…'`. Notes `'line one\nline two'` keep their `\n`, and notes holding `'\u202E'` come back with the visible text `\u202e`.
  - `shows every note a check-in can read, even one made of hidden characters`: notes of 2,000 × `'\u202E'` come back 12,000 characters long.
  - `keeps a failed check-in’s reason to one line, and gives a run that finished none`.
  - `a failed history read fails the page`: `recent-fires` throws, so `handlers.taskDetail(...)` rejects.
  - `401s without a session`, `400s an empty id`, and `404s in a deployment without routines`.
  - DELETE: `clears the notes as the caller` (one call, with `{ agentId: 'a1', routineId: 't1' }` and `userId` `'alice'`; answers `{ cleared: true }`). `404s when the service refuses` (`it.each` over `SafeToolError('forbidden', 'input')` and `SafeToolError('not-found', 'routineId')`). `404s an agent the caller can’t reach, without asking to clear`. `503s without routines:clear-notes`. `401s without a session`.
  - Registration: `toContain('GET /api/workspace/tasks/:agentId/:routineId')` and `toContain('DELETE /api/workspace/tasks/:agentId/:routineId/notes')`. plugin.test: the three entries.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/__tests__/server/routes-workspace-task.test.ts src/__tests__/server/routes-workspace-registration.test.ts src/__tests__/server/plugin.test.ts src/__tests__/server/manifest-declarations.test.ts`.
- [ ] **Step 3: Implement** the routes, constants, manifest entries and comments.
- [ ] **Step 4: Run them (PASS), then** `pnpm --filter @ax/channel-web test src/__tests__/server` and `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Run `security-checklist`** and keep its note. Authorization: identity from the session; `agents:resolve` before any read; owner-only by `isOwnTask`; 404 never 403; no history read before the decision. Prompt injection: everything the agent wrote leaves fenced and capped, and the notes cap covers all the check-in reads. No sandbox, IPC or dependency change.
- [ ] **Step 6: Commit:** `git commit -m "Agent Tasks: GET and clear-notes routes for one task’s page (TASK-910)"`

### Task 9: The page's read, and Clear notes, in the browser [tier: integration]

**Files:**
- Modify: `lib/workspace-api.ts` (methods after `tasks`, :861; guards after `isTasksResponse`, :445)
- Create: `lib/workspace-task.ts`
- Test: create `lib/__tests__/workspace-api-task.test.ts`, `lib/__tests__/workspace-task.test.ts`

**Interfaces:**
- Consumes: `TaskDetail` (T6).
- Produces:

```ts
// lib/workspace-api.ts
workspaceApi.task(agentId: string, routineId: string): Promise<TaskDetail>; // GET /api/workspace/tasks/<enc>/<enc>, checkedRead + isTaskDetail
workspaceApi.clearTaskNotes(agentId: string, routineId: string): Promise<{ cleared: true }>; // req(…/notes, { method: 'DELETE' })
// lib/workspace-task.ts
export type TaskReadError = 'expired' | 'gone' | 'failed';
export type TaskState =
  | { kind: 'loading' }
  | { kind: 'ready'; detail: TaskDetail; refreshing: boolean; refreshFailed: boolean }
  | { kind: 'failed'; error: TaskReadError };
export function useTask(agentId: string, routineId: string): { state: TaskState; refresh: () => void };
```

`isTaskDetail` checks every field `TaskDetail` declares, and every update and report (statuses from `ROUTINE_REPORT_STATUSES`; update status in `['ok', 'silenced', 'error']`). `useTask` copies `useTasks` (`lib/workspace-tasks.ts`): a request counter drops stale answers and unmount bumps it, and it calls `logRequestFailure(e, 'workspace-task')`. The error is `toReadOutcome(e)`. From `ready`, a `failed` refresh keeps the detail with `refreshFailed: true`; `gone` and `expired` replace it.

- [ ] **Step 1: Write the failing tests.** API, copying `respondWith` from `workspace-api-decision-shape.test.ts:23-31`: `reads one task from its own address` (`fetch` called with `'/api/workspace/tasks/a%2F1/t%201'`); `refuses an update with a status it doesn’t know` and `refuses a body without updates` (`WorkspaceShapeError`); `clears notes with DELETE and the CSRF header` (method `DELETE`, `x-requested-with: 'ax-admin'`); `carries the status of a failed clear` (`WorkspaceApiError` with status 404). Hook (`renderHook`, mocking the module like `workspace-tasks.test.ts`): `starts loading, then holds the task`; `calls a 401 expired, a 404 gone and anything else failed`; `refreshes in place, keeping the task on screen`; `a refresh that fails keeps the task, marked`; `a refresh that finds the task gone says gone`; `drops an older answer that lands after a newer one`.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-api-task.test.ts src/lib/__tests__/workspace-task.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit:** `git commit -m "Agent Tasks: the task page reads its task and clears notes (TASK-910)"`

### Task 10: The agent's notes, and Clear notes [tier: sensitive] (security-checklist; invoke `shadcn` and `ux-design`)

**Files:**
- Create: `components/workspace/TaskNotes.tsx`; test `components/workspace/__tests__/TaskNotes.test.tsx`

**Interfaces:**
- Consumes: `workspaceApi.clearTaskNotes` (T9); `HTTP_SESSION_ENDED`, `toReadOutcome`.
- Produces: `export function TaskNotes({ agentId, routineId, agentName, notes, onCleared }: { agentId: string; routineId: string; agentName: string; notes: string | null; onCleared: () => void })`. It renders one row of the brief's `dl`: `<div className="flex flex-col gap-0.5"><dt>…</dt><dd>…</dd></div>`, the `DecisionTaskBlock` shape.

Behaviour, with copy exact:
- The `dt` is `{agentName}’s notes`.
- No notes: a muted `None. It keeps notes here between check-ins.` and no button.
- Notes: a `Collapsible`, closed at first. Its trigger is a ghost small `Button` reading `Show` (`Hide` once open), with lucide `ChevronRight` (`data-icon="inline-end"`, rotated when open), followed by a muted `(it keeps these for its next check-in)`. The content is the notes as text in `whitespace-pre-wrap break-words rounded-md border border-border bg-muted px-3 py-2 text-[13px]`, then an outline small `Clear notes` button.
- `Clear notes` opens a `Dialog`, the `settings/ConnectorsTab.tsx:383-440` pattern: `DialogTitle` `Clear {agentName}’s notes?`; `DialogDescription` `{agentName} won’t see them at its next check-in. You can’t undo this.`; and a `DialogFooter` with an outline `Cancel` and a destructive `Clear notes` (`Clearing…` and disabled while the call is in flight).
- Success closes the dialog, calls `onCleared()`, and shows `Notes cleared.` (`role="status"`).
- Failure keeps the dialog open with a destructive `Alert` inside: `HTTP_SESSION_ENDED` for an expired session, else `We couldn’t clear the notes just now. Try again.`
- Notes are only ever React text.

- [ ] **Step 1: Invoke `shadcn` and `ux-design`** for the row and the confirm. Everything used is installed: Button, Collapsible, Dialog, Alert. If `ux-design` changes copy, change the test with it.
- [ ] **Step 2: Write the failing tests** (mock `@/lib/workspace-api` as `{ ...actual, workspaceApi: { clearTaskNotes: vi.fn() } }`; use `fireEvent`):
  - `keeps the notes folded away until asked, then shows them as written`: the text isn't in the document; `Show` has `aria-expanded="false"`; after a click the text shows and the button reads `Hide`.
  - `draws notes with markdown or HTML as plain text`: notes `'**Done** <b>3</b> [docs](https://x.test) <img src=x onerror=alert(1)>'`; the box's `textContent` equals it exactly, and `container.querySelector('strong, b, a, img')` is null.
  - `clears the notes only after the person confirms`: `Clear notes` opens the dialog and nothing is called yet. The dialog's `Clear notes` calls `clearTaskNotes('a1', 't1')` once, then `onCleared` once, and `Notes cleared.` shows.
  - `Cancel leaves the notes alone`: no call.
  - `a clear that fails says so and keeps the dialog open`.
  - `says there are no notes, with nothing to clear`.
- [ ] **Step 3: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/TaskNotes.test.tsx`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run it plus `src/components/workspace/__tests__/no-fixtures.test.ts` and `src/__tests__/theme-contrast.test.ts` (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 6: Run `security-checklist`** and add to the note: the notes are drawn as text only; the clear sits behind a confirm; no dependency was added.
- [ ] **Step 7: Commit:** `git commit -m "Agent Tasks: a task’s notes, shown on request and clearable (TASK-910)"`

### Task 11: The Updates thread [tier: integration] (invoke `shadcn` and `ux-design`)

**Files:**
- Create: `components/workspace/TaskUpdates.tsx`; test `components/workspace/__tests__/TaskUpdates.test.tsx`

**Interfaces:**
- Consumes: `foldUpdates`, `TaskUpdate` (T6); `updateStamp`, `TASK_GROUP_LABELS` (T7); `StateDot`, `StateDotSlot` (`bits.tsx`).
- Produces: `export function TaskUpdates({ updates, now }: { updates: TaskUpdate[]; now: Date })`: a `<section aria-labelledby>` with an `h2` reading `Updates`, then a `<ul>`.

Entry: an `<li>` flex row with the stamp (`updateStamp(firedAt, now)`, muted, `tabular-nums`). Next comes `StateDotSlot` holding `StateDot state={report?.status ?? 'no-update'}`, followed by an `sr-only` span with that mark's `TASK_GROUP_LABELS` word. The body is a `min-w-0 flex-1` text block (leave the trailing space for TASK-911's link). Text (exact): the report's `update`. A report whose update fenced to nothing reads `It left an update we can’t show.` With no report, an `'error'` reads `This check-in didn’t finish.` and anything else reads `Checked in but didn’t leave an update`. For `'error'`, a muted second line: `error`, or `No reason was recorded.` (row 13). A fold is a `Collapsible`, closed at first, whose trigger is a ghost small `Button` reading `{n} earlier check-ins, all on track` with a rotating `ChevronRight`; its content holds the same entries. No updates: a muted `No check-ins yet.`

- [ ] **Step 1: Invoke `shadcn` and `ux-design`** (Collapsible and Button are installed).
- [ ] **Step 2: Write the failing tests:** `lists check-ins newest first, each with its mark, time and update`; `a check-in that left no update says so`; `a failed check-in says it didn’t finish, with the reason it recorded` (`No reason was recorded.` when null; a report plus an error shows both); `folds a run of on-track check-ins behind one line that opens` (six on-track: one entry, then a button `5 earlier check-ins, all on track` with `aria-expanded="false"`; after a click, six entries); `says when there are no check-ins yet`; `draws an update as plain text` (markdown and HTML literal, no `strong, b, a, img`).
- [ ] **Step 3: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/TaskUpdates.test.tsx`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run it plus `no-fixtures.test.ts` and `theme-contrast.test.ts` (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 6: Commit:** `git commit -m "Agent Tasks: a task’s Updates thread, with quiet check-ins folded (TASK-910)"`

### Task 12: The task page [tier: sensitive] (security-checklist; invoke `shadcn` and `ux-design`)

**Files:**
- Create: `components/workspace/TaskPage.tsx`; test `components/workspace/__tests__/TaskPage.test.tsx`

**Interfaces:**
- Consumes: `useTask` (T9); `TaskNotes` (T10); `TaskUpdates` (T11); `checkInWhen`, `TASK_GROUP_LABELS`, `routeLinkProps` (T7); `routineApi`, `RoutineApiError` (`lib/routines.ts`); `WorkspaceHeader`; `Breadcrumb*`, `Card`, `Alert`, `Button`, `Spinner`; `HTTP_SESSION_ENDED`, `readAlertVariant`.
- Produces: `export function TaskPage({ agentId, routineId, leading, onNavigate }: { agentId: string; routineId: string; leading?: React.ReactNode; onNavigate: (route: WorkspaceRoute) => void })`.

**Layout:**
- `WorkspaceHeader`'s `title` is the task's `name` once ready, `Task` before. Its `leading` is `leading`, then `Breadcrumb > BreadcrumbList > BreadcrumbItem > BreadcrumbLink asChild > <a {...routeLinkProps({ kind: 'tasks' }, onNavigate)}>Tasks</a>` and a `BreadcrumbSeparator`. Its children are the actions, once ready.
- The body frame is `TasksPage`'s (`flex-1 overflow-y-auto` around `mx-auto flex w-full max-w-[900px] flex-col gap-4 px-6 pb-6`).
- `loading`: a centred `Spinner`. `failed`: an `Alert` in `readAlertVariant(error)`.
- `ready`, in order:
  1. When `refreshFailed`: a destructive alert with Try again (disabled while `refreshing`).
  2. The muted meta line.
  3. The action note, muted, with an `id`.
  4. The action notice: `role="status"`, or a destructive `Alert` for a failure.
  5. The latest update `Card`, in a `<section aria-labelledby>` with an `sr-only` `h2` reading `Latest update`: the mark and its label, the update, the when line, and the ask.
  6. The brief, a `dl` of three rows: `What {agentName} does` (`promptBody`, pre-wrap; null → `No instructions saved.`), `Going well when` (`goodWhen`), then `<TaskNotes … onCleared={refresh} />`. Under it, a muted link `Change these in {agentName}’s settings`, as `routeLinkProps({ kind: 'agent-settings', id: agentId, section: 'routines' }, onNavigate)` (row 19).
  7. `<TaskUpdates updates={detail.updates} now={now} />`.
- `now` is state, reset in `useLayoutEffect` whenever `detail` changes.

**Actions (decisions rows 15–16):**
- Enabled: a default `Check now` and an outline `Pause`. Paused: a default `Resume` and an outline, disabled `Check now`. All buttons are small.
- `Check now` is disabled when `!enabled || !permissions.fire || busy`; `Pause` when `!permissions.stop || busy`; `Resume` when `!permissions.edit || busy`. A disabled button gets `aria-describedby` pointing at the action note, when there is one.
- One action at a time. Each press uses `op = (pending?.kind === kind && pending.revision === detail.revision) ? pending : { kind, revision: detail.revision, requestId: crypto.randomUUID() }`. Check now calls `routineApi.fireNow({ agentId, routineId, expectedRevision: op.revision, requestId: op.requestId })`. Pause and Resume call `routineApi.update({ …same, patch: { enabled: kind === 'resume' } })`. `pending` is cleared on success and on any 4xx `RoutineApiError`, and kept on status 0, a status ≥ 500, or a non-`RoutineApiError`. `refresh()` runs after every press.
- Copy (exact):

| Where | Text |
|---|---|
| Meta line | `{agentName} · Stay on top of something`, plus ` · checks in {schedule}` when `schedule` is set |
| Action note | paused with `edit`: `Paused. It won’t check in until you resume it.` · paused without `edit`: `Paused. Only someone who manages this agent’s tasks can resume it.` · enabled without `fire`: `You can’t start or pause this task’s check-ins, because you no longer manage this agent’s tasks.` |
| Check now `{status: 'ok'}` | `Checking in now. Its update will show under Updates when it’s done.` |
| Check now `{status: 'error'}` | `We couldn’t start the check-in. Try again.` |
| `revision-conflict` | `This task changed while you had it open. We’ve loaded the latest, so try again.` |
| `disabled` | `This task is paused, so it can’t check in. Resume it first.` |
| `not-found` / `forbidden` | `You can’t change this task any more.` |
| Unconfirmed Check now | `We couldn’t confirm the check-in started. Try again, and it won’t start twice.` |
| Unconfirmed Pause/Resume | `We couldn’t confirm that change. Try again.` |
| Latest update | `StateDot state={task.status}` and `TASK_GROUP_LABELS[task.status]`; the update; `Checked {checkInWhen(reportedAt)}`, plus ` · Next check {checkInWhen(nextCheckAt)}` when enabled with a next check, or ` · Paused` when paused; `{agentName} asks: {ask}` |
| Never reported | `StateDot state="no-update"`; `No update yet.`, plus ` It’ll check in {checkInWhen(nextCheckAt)}.` when enabled with a next check |
| Load failed / gone / expired | `We couldn’t load this task just now. Nothing was lost.` with `Try again` · `We couldn’t find this task. It may have been deleted, or it belongs to someone else.` with no button · `HTTP_SESSION_ENDED` with no button |
| Refresh failed | `We couldn’t refresh this task just now, so what you see may be out of date.` with `Try again` |

- [ ] **Step 1: Invoke `shadcn` and `ux-design`** for the header, actions, latest update and brief. Breadcrumb, Card, Button, Alert and Spinner are installed. If `ux-design` changes copy, change the tests with it.
- [ ] **Step 2: Write the failing tests.** Mock `@/lib/workspace-api` (`{ ...actual, workspaceApi: { task: vi.fn(), clearTaskNotes: vi.fn() } }`) and `@/lib/routines` (`{ ...actual, routineApi: { fireNow: vi.fn(), update: vi.fn() } }`, keeping the real `RoutineApiError`), with a `detail(over)` helper. Where times matter, `vi.useFakeTimers({ shouldAdvanceTime: true })` and `vi.setSystemTime(NOW)`; build expected times from `localTime`.
  - `shows the latest update, when it checked and checks next, and the ask in the agent’s words`.
  - `says there is no update yet, and when it will first check in` → `No update yet. It’ll check in at ${localTime(next)}.`
  - `names the agent, the kind of task and how often it checks in`.
  - `shows the brief as written, read-only, with a way to change it in the agent’s settings`: no textbox; the link's href is `/workspace/agents/a1/settings/routines`; a click calls `onNavigate` with that route.
  - `Check now starts a check-in with the task’s current revision, then reads the task again`: `fireNow` gets `{ agentId: 'a1', routineId: 't1', expectedRevision: 'rev-1', requestId: expect.any(String) }`; `task` is called twice; the `Checking in now…` status shows.
  - `a Check now that couldn’t be confirmed is retried with the same request, so it can’t start twice`: the first `fireNow` rejects with `new RoutineApiError(0)`; the second press sends the same `requestId`.
  - `Pause, then Resume, flips the task with each read’s revision`: `update` gets `{ expectedRevision: 'rev-1', patch: { enabled: false } }`; the re-read answers `enabled: false, revision: 'rev-2'`; `Resume` then sends `{ expectedRevision: 'rev-2', patch: { enabled: true } }`.
  - `Check now is disabled while paused, and says why`: the button is disabled and its `aria-describedby` points at the paused note.
  - `someone who no longer manages the agent’s tasks sees why nothing can be started or resumed`.
  - `a task changed elsewhere says so and loads the latest`: `update` rejects with `new RoutineApiError(409, 'revision-conflict')`.
  - `draws what the agent wrote as plain text`: the update, the ask and the notes (after Show) all hold markdown and HTML. Each `textContent` is exact, and no `strong`, `b` or `img`, and no `a` with `href="https://x.test"`, is in the document.
  - `a task that isn’t there or isn’t yours says so, with no Try again`: 404.
  - `a failed read offers Try again, and an expired session asks to sign in again`.
  - `the Tasks crumb goes back to Tasks`: its href is `/workspace/tasks`; a click calls `onNavigate({ kind: 'tasks' })`.
  - `clearing the notes reads the task again`.
- [ ] **Step 3: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/TaskPage.test.tsx`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run it plus `no-fixtures.test.ts` and `theme-contrast.test.ts` (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 6: Run `security-checklist`** and add to the note: model text is drawn as text only; actions go through the existing permission checks; Resume needs `edit`; a retry can't double-fire.
- [ ] **Step 7: Commit:** `git commit -m "Agent Tasks: the task page (TASK-910)"`

### Task 13: Open a task from Tasks [tier: integration] (invoke `shadcn` and `ux-design`)

**Files:**
- Modify: `lib/workspace-route.ts` (the union :55-60, `parseWorkspaceRoute` :121, `workspaceRoutePath` :156); test `lib/__tests__/workspace-route.test.ts`
- Modify: `components/workspace/TasksPage.tsx` (props; `TaskItem` becomes a link; the header comment's "Rows are not links…" paragraph, :18-19)
- Modify: `components/workspace/__tests__/TasksPage.test.tsx` (pass `onNavigate` in every render, through a local `renderPage()`; one new test)
- Modify: `components/workspace/WorkspaceShell.tsx` (the header comment :10-14, `navProps.route` :805, the `TasksPage` and `TaskPage` mounts :930)
- Modify: `components/workspace/__tests__/WorkspaceShellRouting.test.tsx` (`task: vi.fn()` in the mock; two tests)

**Interfaces:**
- Consumes: `TaskPage` (T12), `routeLinkProps` (T7).
- Produces: `WorkspaceRoute` gains `{ kind: 'task'; agentId: string; routineId: string }` at `/workspace/tasks/<agentId>/<routineId>`. `TasksPage({ leading, onNavigate }: { leading?: ReactNode; onNavigate: (route: WorkspaceRoute) => void })`.

Spec:
- Parse: under `tasks`, when the third and fourth segments both pass `parseAgentId` (rename it `parseIdSegment` and say it guards both ids), it is a task route. Anything else under `tasks` is `{ kind: 'tasks' }`. A tail past the routine id is dropped.
- Path: `` `${WORKSPACE_ROOT_PATH}/tasks/${encodeURIComponent(agentId)}/${encodeURIComponent(routineId)}` ``. `routeAgentId` stays null for a task.
- Shell: `route: route.kind === 'agent-settings' ? 'agent' : route.kind === 'task' ? 'tasks' : route.kind`, so the Tasks row is active on a task page. Mount `<TasksPage leading={navTrigger} onNavigate={navigate} />` and `{route.kind === 'task' && <TaskPage key={JSON.stringify([route.agentId, route.routineId])} agentId={route.agentId} routineId={route.routineId} leading={navTrigger} onNavigate={navigate} />}`. The header comment's view list gains `/workspace/tasks/<agentId>/<routineId>`.
- Row: `TaskItem`'s wrapper becomes `<a {...routeLinkProps({ kind: 'task', agentId: row.agentId, routineId: row.routineId }, onNavigate)} className="flex min-w-0 flex-col gap-1 px-5 py-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">`, keeping its `title`s. The header comment's paragraph becomes (exact): "Each row opens its task page (TASK-910) through a real link, so it can open in a new tab too."

- [ ] **Step 1: Invoke `shadcn` and `ux-design`** for the row's link affordance (hover and focus, semantic tokens).
- [ ] **Step 2: Write the failing tests.**
  - route: `reads a task’s path` (`/workspace/tasks/a1/t1` and `/workspace/tasks/a1/t1/extra` → the task; `/workspace/tasks/a%2F1/t%201` → `agentId 'a/1'`, `routineId 't 1'`); `falls back to Tasks for a task path it can’t read` (`/workspace/tasks/a1`, `/workspace/tasks/a1/..` and `/workspace/tasks/%E0%A4%A/t1` → `{ kind: 'tasks' }`); `writes a task’s path` (→ `/workspace/tasks/a%2F1/t%201`). Add a task route to the round-trip `ROUTES`, and `routeAgentId` of it is null. The existing `/workspace/tasks/extra` → tasks assertion stays.
  - TasksPage: `each task opens its page`: the row is a `link` whose href is `/workspace/tasks/a1/t1`; a plain click calls `onNavigate({ kind: 'task', agentId: 'a1', routineId: 't1' })`; a ctrl-click doesn't.
  - Shell: `opens a task from its own URL, with Tasks active in the sidebar` (`renderAt('/workspace/tasks/a1/t1')` → the level-1 heading is the task's name; the `Tasks` button has `data-active="true"`; `taskMock` was called with `('a1', 't1')`). `a Tasks row leaves the task’s address behind`: from `/workspace/tasks`, clicking the row link makes `window.location.pathname` `/workspace/tasks/a1/t1` and shows the heading.
- [ ] **Step 3: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-route.test.ts src/components/workspace/__tests__/TasksPage.test.tsx src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the whole package and the type-check:** `pnpm --filter @ax/channel-web test` and `pnpm --filter @ax/channel-web exec tsc --build`. The other shell tests mock `workspaceApi` as a closed object and must pass untouched. They do because `useTask` is called only inside `TaskPage`.
- [ ] **Step 6: Commit:** `git commit -m "Agent Tasks: each task on the Tasks page opens its own page (TASK-910)"`

---

## Card acceptance → tests

| Card acceptance | Test |
|---|---|
| Detail returns task state, notes and Updates with reports | T8 `answers the task’s latest update, brief, notes and updates` |
| 404 for repeat routines and another user's task | T8 `404s a repeat routine…`, `404s someone else’s task on a team agent…` |
| clear-notes requires permission and leaves `revision` unchanged | T4 `the owner clears…`, `on a team agent, nobody but the task’s owner…` (owner rule, decisions row 4); T2 `clears the notes and nothing else`; T8 DELETE tests |
| Service: a later check-in message carries no notes | T4 `after the person clears the notes, the next check-in’s message has none` |
| A run accepted before the clear can't restore notes | T2 `a check-in accepted before the clear…`, `holds when the host clock steps back…`; T4 `notes cleared while a check-in runs…` |
| Output schema in `return-schemas.test.ts` | T4 (17 services, `RoutineClearNotesOutputSchema`) |
| Latest update and ask; never-reported state | T12 |
| Notes collapsed, shown, cleared after confirm | T10 |
| On-track folding | T6 `foldUpdates` tests; T11 `folds a run of on-track check-ins…` |
| Check now with the current revision, then refresh | T12 `Check now starts a check-in…` |
| Pause then Resume flips `enabled`; Check now disabled while paused | T12 |
| Model text as literal text | T10, T11, T12 `…plain text`; T8 `fences what the agent wrote` |
| Routing for `/workspace/tasks/<agentId>/<routineId>` and the row link | T13 |
| Reachable from the canary | T4's PR 1 backend canary tail |

## Before the PR

- **Gates:** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
- **Boundary review, `routines:clear-notes` (new service hook):**
  - Alternate impl: an external task tracker (Linear, Asana) clearing its agent-kept notes field, or a SQLite-backed routines store.
  - Payload names that might leak: none. The input is `{ agentId, routineId }` (existing opaque ids), and the output is `{ cleared: true }`.
  - Subscriber risk: none; it's a service, and it fires no event.
  - Wire surface: it is neither an IPC action nor a tool, so no model can call it. Its schema lives in `@ax/routines-contract/src/services.ts` with the other routines services.
  - `RoutineView.nextRunAt` keeps its name and type; it now means "when it will run next" (active hours applied). The two HTTP routes' wire types live in `packages/channel-web/src/lib/workspace-types.ts`.
- **Security note:** combine Tasks 2, 4, 8, 10 and 12. State the residual risks plainly. A clear doesn't remove the last three updates that the next check-in message still quotes: they're capped, quoted, and visible under Updates, and design §7 promises notes, not updates. It also doesn't touch the check-in's own hidden conversation, which only the owner can read (TASK-911 shows it). Memory never captured check-ins (TASK-908).
- **Deploy:** routines schema version 6 is additive (one nullable column) and rollback-safe. PR 1 deploys as one, and TASK-907 must not deploy before this card.
- **Handoff:** list the seven departures from the card above, the refuted premises, and the YAGNI cuts (decisions row 22).
