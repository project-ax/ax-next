# TASK-936: A change of owner starts a task over — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent changes owner, each of its tasks starts over for the new owner: no task state, none of the earlier owner's check-ins or reports on the task page, and no notes, misses or earlier reports in a check-in run as the new owner.

**Architecture:** `reconcileOwners`, the only writer of a routine's owner, clears the task state in the UPDATE that moves it, with TASK-907's `NO_TASK_STATE` (what a change of kind clears). Each run records who it ran as (`run_as_user_id`, routines schema version 9): on its dispatch when it is accepted, copied to its fire row when it finishes. The store's history reads list a live routine's runs only when they ran as its current owner, and hand `fireViews` that owner from the same statement; `recentReports` binds the reader the way TASK-931's `recentReplies` does.

**Tech Stack:** TypeScript, Kysely on Postgres, vitest with testcontainers.

**Spec:** card TASK-936 (acceptance copied below); `docs/plans/2026-10-20-agent-tasks-design.md` §7, §15; decisions `.claude/memory/decisions/2026-10-23-TASK-936.md` (rows cited as "decisions row N").

Card acceptance, verbatim:

- Store or service tests, all failing before the fix. After an owner change:
  - the new owner's `routines:get` and `routines:list` task state is empty;
  - the Updates thread shows none of the previous owner's reports;
  - the next check-in message carries no notes and none of the previous owner's reports;
  - the TASK-911 transcript route returns 404 for the previous owner's check-ins.
- Record the decision in a decisions shard and in the design doc's §15.
- `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

**The fourth bullet is already true, and already tested** (decisions row 11). The transcript route reads the conversation with `conversations:get` as the caller, which refuses another person's conversation, and checks `got.conversation.userId !== userId` again (`packages/channel-web/src/server/routes-workspace.ts:7476-7496`). `packages/channel-web/src/__tests__/server/routes-workspace-checkin.test.ts:746-780` pins it ("an earlier owner’s, which conversations:get refuses"). So no new test there can fail before the fix, and channel-web doesn't change. After Task 3 the route refuses one step earlier, without reading the conversation: the new owner's `routines:recent-fires` no longer lists the check-in, so the membership check at `routes-workspace.ts:7469-7474` answers `checkin-not-found` (pinned by `routes-workspace-checkin.test.ts:592`). Task 3's canary pins that listing, read with the route's own `limit: 200`.

**Why the history reads drop runs, not just reports** (decisions row 5). Hiding only the report would leave each earlier check-in in the new owner's Updates thread as "Checked in but didn’t leave an update" (`packages/channel-web/src/lib/task-updates.ts:95`), a false sentence, with a See what it did link to the gone page.

## Global Constraints

- Routines schema **version 9** (TASK-931 took 8). If origin/main has a version 9 at rebase, take the next free number everywhere: `migrations.ts`, the `versions()` lists in `migrations.test.ts`, the comments.
- The migration only adds: `ADD COLUMN IF NOT EXISTS`, nullable `TEXT`, no FK, no CHECK, no index. Its backfill writes only the new columns, and only where they are NULL.
- No hook added, no hook input or output schema changed, no tool, IPC action, route, UI or copy change, no dependency or lockfile change, no new log line.
- Exact-list pins stay as they are: `packages/routines/src/__tests__/return-schemas.test.ts`, `presets/k8s/src/__tests__/preset.test.ts`, channel-web `plugin.test.ts` and `manifest-declarations.test.ts`.
- The check-in message's words don't change. The tests read the existing lines: "You have no saved notes yet.", "No earlier reports yet.", "ended without a report".
- Postgres-backed tests need `DOCKER_HOST` (CLAUDE.md). If OrbStack hangs, the `fixture()` store tests can run on a local Postgres shim (memory `patterns/2026-10-23-TASK-930.md`, `patterns/2026-10-23-TASK-932.md`). The canary can't, so re-run it on Docker before calling a task green.
- Commit this plan and its decisions shard before any `pnpm test:scripts` run. `scripts/__tests__/memory-cited-paths-exist.test.js` fails when a shard cites an untracked file, and the shard cites this plan. The builder commits both after planning; if they aren't committed yet, add them to Task 1's commit.
- Run the tasks one at a time in this worktree: channel-web's `tsc --build` compiles routines and its contract, so two tasks building at once collide.

## Review Focus

1. **A check-in still running when the agent moves** (accepted as the earlier owner): nothing of it reaches the new owner's task. That covers a report it saved before the move, one it tries after, its notes, and the miss it leaves by ending without a report. → Task 3, "a check-in still open when the task moves leaves the new owner’s task alone".
2. **The task moves back to the earlier owner:** they read their own runs and reports again, never the interim owner's, and the state starts over again. → Task 3, the history test and the `recentReports` test.
3. **A run with no record of who it ran as** (written by code from before version 9, after a rollback): a live routine lists it for no one, and it still counts as a miss, as before. → Task 3, the history test and the open-check-in test.
4. **A routine deleted after a move:** every run of it still lists, both owners' runs, with no report for anyone, as today. → Task 3, the history test. `report-tool.test.ts:269` keeps pinning that no report shows.
5. **A paused task that moves** stays paused (`enabled` untouched). An auto-pause becomes a plain pause, and `agent_notes_cleared_at` and the schedule stay. → Task 2's store test.

## Hook surface

No hook signature changes (decisions row 13). `routines:get` and `routines:list` answer a moved task with `task: null` and `noRecentUpdate: null`. `routines:recent-fires` and `routines:recent-fires-for-agent` list fewer rows for a routine that changed owner. Their shapes are unchanged. `run_as_user_id` is a store column that never reaches a payload. `FireRow.routineOwnerUserId` is internal to `@ax/routines` and dropped in `fireViews`; the strict `RoutineFireViewSchema` would refuse it if it ever leaked. CLAUDE.md requires boundary review only for signature changes. The PR still gets a short note:

- **Alternate implementation:** a SQLite-backed routines store records who each run ran as the same way, and so would an external tracker behind the same hooks.
- **Payload names that might leak:** none. No payload field is added.
- **Subscriber risk:** none. These are service hooks; no subscriber payload changes.
- **Wire surface:** none. No IPC action changes; `routine_report` is untouched.
- **Exact-list pins:** none to update (Global Constraints).

## Security checklist (Tasks 1–3; one PR note)

- **Prompt injection and untrusted content (the threat here).** A check-in runs as the task's owner, with their connectors. Its report, ask and notes are model output and can hold that person's private details, or an instruction injected through a ticket or email (design §7). Before this fix, a change of owner did two things. (a) It showed that text to the new owner: task page, Tasks, Today, `routine_get`/`routine_list`/`routine_update` in their chats, and the Settings history JSON. Task 2 covers the state; Task 3 covers the runs. (b) It fed that text into check-ins run as the new owner, with the new owner's credentials, so a cross-user injection could keep steering. Task 2 covers the notes and misses, Task 3 the reports. TASK-931 already covers replies. A side effect of Task 3: while the routine exists, the new owner's Settings history also stops showing a webhook routine's earlier rendered prompts, which carry the payloads sent to the earlier owner's webhook.
- **Residuals, accepted** (decisions row 18). A run accepted as the earlier owner keeps running as them until it finishes: one check-in, and it can't write into the moved task. Once a routine is deleted, before or after the move, all its runs list again to anyone who can see the agent, as today: `deleteAuthored` keeps fire rows (`store.ts:551-563`) and the history read keeps a gone routine's rows. Reports stay hidden (no owner). The host-written `error` and `warning`, and a webhook routine's `renderedPrompt`, show again. This is pre-existing and narrowed here, not closed; nulling those fields for gone routines would change today's behaviour for everyone (decisions row 18). A request in flight across the agent's move can reconcile the routine back with a stale `agents:resolve` answer. That already happens today; each move now also resets, which fails toward showing less.
- **Sandbox escape:** N/A. No sandbox, runner, IPC or `routine_report` change.
- **Supply chain:** N/A. No dependency or lockfile change.
- **Capabilities (invariant 5):** every change narrows a read. The new columns hold host-set user ids, never model text.
- **No untrusted string reaches SQL.** The reset's `sql.ref(column)` takes only `NO_TASK_STATE`'s own keys, which are constants. Every value is a bound parameter.
- **Data at rest:** the earlier owner's runs and replies stay stored. While the routine exists, only the earlier owner can read them again, and only if the task returns. Replies are deleted with the routine or the agent. Fire rows outlive a deleted routine until the agent is purged, as today (see Residuals).

The PR's `## Security review` block, to finish in Task 3 Step 7:

```
## Security review
- Sandbox: N/A: no filesystem path, process, network, env or handle is added or widened. The change adds two nullable DB columns holding host-set user ids and narrows existing store reads.
- Injection: A check-in's report, ask and notes (model output, possibly carrying the earlier owner's private details or a ticket's injected instruction) no longer reach a new owner after drift repair moves a task. They are cleared from the task in the moving UPDATE, a run's report is listed only for the person it ran as while they own the routine, and the check-in message reads only that person's reports, so a cross-user instruction can't steer check-ins run with the new owner's credentials. Nothing untrusted is interpolated into SQL.
- Supply chain: N/A: no package.json or lockfile change.
```

---

### Task 1: Version 9 records who each run ran as [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/migrations.ts`: `RoutinesFiresRow` (:76-93), `DispatchesRow` (:136-144), `runRoutinesMigration` (:169-206), and a new `addRunAsColumns` above `addRepliesTable` (:208).
- Test: `packages/routines/src/__tests__/migrations.test.ts`

**Interfaces:**
- Produces: a nullable `run_as_user_id TEXT` column on `routines_v1_dispatches` and on `routines_v1_fires`. Kysely fields `DispatchesRow.run_as_user_id` and `RoutinesFiresRow.run_as_user_id`, both `ColumnType<string | null, string | null | undefined, string | null>`.

- [ ] **Step 1: Write the failing test** (after the version 8 test)

```ts
it('version 9 records who each run ran as: existing runs read as their routine’s owner, a gone routine’s stay unknown, and a re-run keeps them (TASK-936)', async () => {
  await runRoutinesMigration(db);
  await sql`ALTER TABLE routines_v1_dispatches DROP COLUMN IF EXISTS run_as_user_id`.execute(db);
  await sql`ALTER TABLE routines_v1_fires DROP COLUMN IF EXISTS run_as_user_id`.execute(db);
  await sql`DELETE FROM routines_schema_versions WHERE version = 9`.execute(db);
  // Version-8 rows: a task, a run open across the upgrade, a finished run's fire, and a fire whose routine is gone.
  await insertTask();
  await sql`INSERT INTO routines_v1_dispatches (dispatch_id,agent_id,routine_id,revision,req_id,accepted_at,completed_at,trigger_source) VALUES ('d_open','a','r_task','rev_task','req_open','2031-01-01T00:00:00Z',NULL,'tick')`.execute(db);
  await sql`INSERT INTO routines_v1_fires (agent_id,routine_id,dispatch_id,fired_at,trigger_source,conversation_id,status,report_status,report_update) VALUES ('a','r_task','d_done','2030-12-31T23:45:00Z','tick','c_done','ok','on-track','Queue is empty.')`.execute(db);
  await sql`INSERT INTO routines_v1_fires (agent_id,routine_id,dispatch_id,fired_at,trigger_source,conversation_id,status) VALUES ('a','r_gone','d_gone','2030-12-31T23:30:00Z','tick','c_gone','ok')`.execute(db);
  await runRoutinesMigration(db); await runRoutinesMigration(db);
  expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  expect((await sql`SELECT table_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema=current_schema() AND column_name='run_as_user_id' ORDER BY table_name`.execute(db)).rows).toEqual([
    { table_name: 'routines_v1_dispatches', data_type: 'text', is_nullable: 'YES' },
    { table_name: 'routines_v1_fires', data_type: 'text', is_nullable: 'YES' },
  ]);
  const runAs = async () => ({
    dispatches: (await sql`SELECT dispatch_id, run_as_user_id FROM routines_v1_dispatches ORDER BY dispatch_id`.execute(db)).rows,
    fires: (await sql`SELECT dispatch_id, run_as_user_id FROM routines_v1_fires ORDER BY dispatch_id`.execute(db)).rows,
  });
  const backfilled = {
    dispatches: [{ dispatch_id: 'd_open', run_as_user_id: 'owner' }],
    fires: [{ dispatch_id: 'd_done', run_as_user_id: 'owner' }, { dispatch_id: 'd_gone', run_as_user_id: null }],
  };
  expect(await runAs()).toEqual(backfilled);
  // Finishing version 9 over the columns it added keeps their values, even once the routine has another owner.
  await sql`UPDATE routines_v1_definitions SET owner_user_id = 'someone-else' WHERE routine_id = 'r_task'`.execute(db);
  await sql`DELETE FROM routines_schema_versions WHERE version = 9`.execute(db);
  await runRoutinesMigration(db);
  expect(await versions()).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  expect(await runAs()).toEqual(backfilled);
});
```

- [ ] **Step 2: In the same file, change every other `[2, 3, 4, 5, 6, 7, 8]` to `[2, 3, 4, 5, 6, 7, 8, 9]`** (11 places today; `grep -n "\[2, 3, 4, 5, 6, 7, 8\]"` should then find none).

- [ ] **Step 3: Run it and see it fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/migrations.test.ts`
Expected: FAIL. The version lists stop at 8, and the column query finds no `run_as_user_id`.

- [ ] **Step 4: Implement**

Add the two row-type fields. Add `async function addRunAsColumns(db: Kysely<RoutinesDatabase>): Promise<void>`, run under `if (!await done(9)) { …; INSERT … VALUES (9) }` after version 8. It runs these four statements, in order:

```sql
ALTER TABLE routines_v1_dispatches ADD COLUMN IF NOT EXISTS run_as_user_id TEXT;
ALTER TABLE routines_v1_fires ADD COLUMN IF NOT EXISTS run_as_user_id TEXT;
UPDATE routines_v1_dispatches d SET run_as_user_id = r.owner_user_id FROM routines_v1_definitions r
 WHERE d.run_as_user_id IS NULL AND r.agent_id = d.agent_id AND r.routine_id = d.routine_id;
UPDATE routines_v1_fires f SET run_as_user_id = r.owner_user_id FROM routines_v1_definitions r
 WHERE f.run_as_user_id IS NULL AND r.agent_id = f.agent_id AND r.routine_id = f.routine_id;
```

The function's doc comment, and the doc on each row field, must say:
- the column is the person the run ran as: its routine's owner when it was accepted (fire.ts runs as `accepted.row.ownerUserId`);
- `acceptDispatch` writes it on the dispatch and `finishDispatch` copies it to the fire;
- `reconcileOwners` never moves it, and that is the point;
- rows from before version 9 read as their routine's owner at the upgrade, the person today's code already shows their reports to;
- a gone routine's rows stay NULL, and NULL means "not known";
- the change is additive and rollback-safe: old code ignores the column, and a re-run stamps only NULL rows.

- [ ] **Step 5: Run and see it pass**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/migrations.test.ts && pnpm --filter @ax/routines build`
Expected: PASS, and the build is clean.

- [ ] **Step 6: Commit**

```bash
git add packages/routines/src/migrations.ts packages/routines/src/__tests__/migrations.test.ts
git commit -m "[TASK-936] routines: version 9 records who each run ran as"
```

---

### Task 2: A change of owner starts the task over [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/store.ts`:
  - `reconcileOwners` (:1122-1137) and its interface doc (:123-128);
  - the `NO_TASK_STATE` doc (:208-228);
  - `finishDispatch`'s interface doc (:36-44), whose "It and `updateAuthored` are the count's only writers" goes false;
  - `recordReport`'s interface doc (:49-54), whose "The one writer of a task's state" goes false;
  - `missesAfterRun`'s doc (:252-253), whose "Only a person's Resume or a kind change ends that" goes false, since a change of owner clears `task_auto_paused_at` too.
- Modify: `packages/routines/src/types.ts`: `StoredRoutine.task`'s doc (:24, "again after an edit that changes the routine's kind") and `StoredRoutine.noRecentUpdate`'s doc (:27-29, "Written only by `finishDispatch` and `updateAuthored`").
- Modify: `packages/routines/src/migrations.ts`, the doc lines this makes false: the version-4 column doc (:39-47, "NULL again after an edit that changes the routine's kind"), the version-7 column doc (:61-69) and `addCheckInMissColumns`' doc (:241-251, "Written only by `finishDispatch` … and `updateAuthored`").
- Create: `packages/routines/src/__tests__/owner-change-store.test.ts`
- Modify: `packages/routines/src/__tests__/canary.test.ts`: a new `describe('owner change canary (TASK-936)')` at the end.

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `reconcileOwners` applies `NO_TASK_STATE` to every routine it moves, in the same UPDATE. Task 3 also uses the new test file's helpers: `TASK`, `taskInput`, `needsYou`, `onTrack`, `moveTo`, `bound`, `record`, `finish`, `finished`, `stateRow` and `CLEARED`.

- [ ] **Step 1: Write the new store test file, with its helpers and one failing test**

```ts
import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { RoutineDefinitionSchema, type RoutineKey } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import type { DispatchReport } from '../types.js';

// TASK-936: an agent's change of owner (reconcileOwners: drift repair, run by the tick and by every
// routines read) starts each of its tasks over. Task 3 adds: a run is read only for whoever it ran as.
const f = fixture();
const minute = (n: number) => new Date(now.getTime() + n * 60_000);
const TASK = RoutineDefinitionSchema.parse({
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
});
/** A task 'owner' owns; each needs its own request id. */
const taskInput = (requestId: string, agentId = 'a') => ({ ...createInput(requestId), agentId, definition: TASK });
const needsYou = { status: 'needs-you', update: 'Refund QX7731 waits on Acme.', ask: 'May I refund QX7731?' } as const;
const onTrack = { status: 'on-track', update: 'Queue is empty.', ask: null } as const;
/** Drift repair's move of every routine of agent 'a' to `ownerUserId`. */
const moveTo = (ownerUserId: string) => f.store.reconcileOwners({ agents: [{ agentId: 'a', ownerUserId }] });
/** A run of the routine at its current revision, asked for by `actorUserId`, bound to its own conversation. */
const bound = async (key: RoutineKey, requestId: string, at: Date, actorUserId = 'owner') => {
  const row = (await f.store.findOne(key))!;
  const { accepted } = (await f.store.acceptDispatch({
    agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId, source: 'manual', requestId, now: at,
  }))!;
  await f.store.bindDispatchConversation({ dispatchId: accepted.dispatchId, conversationId: `c-${requestId}` });
  return { ...accepted, conversationId: `c-${requestId}` };
};
const record = (run: Awaited<ReturnType<typeof bound>>, report: DispatchReport, actorUserId = 'owner', notes?: string) => f.store.recordReport({
  agentId: run.row.agentId, dispatchId: run.dispatchId, conversationId: run.conversationId, actorUserId, report,
  ...(notes === undefined ? {} : { notes }), now: minute(30),
});
const finish = (dispatchId: string) => f.store.finishDispatch({ dispatchId, outcome: { status: 'ok', conversationId: 'c', error: null, renderedPrompt: null, warning: null } });
/** A finished run, with `report` on it, or none when it's null. */
const finished = async (key: RoutineKey, requestId: string, at: Date, report: DispatchReport | null, actorUserId = 'owner') => {
  const run = await bound(key, requestId, at, actorUserId);
  if (report !== null) expect(await record(run, report, actorUserId)).toBe('recorded');
  expect(await finish(run.dispatchId)).toBe(true);
  return run;
};
const stateRow = async (routineId: string) => (await sql<Record<string, unknown>>`
  SELECT owner_user_id, revision, enabled, next_run_at, agent_notes_cleared_at,
         task_status, task_update, task_ask, task_reported_at, task_report_accepted_at, agent_notes,
         task_misses_in_a_row, task_miss_reason, task_miss_at, task_auto_paused_at
    FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0];
/** What NO_TASK_STATE leaves. */
const CLEARED = {
  task_status: null, task_update: null, task_ask: null, task_reported_at: null, task_report_accepted_at: null, agent_notes: null,
  task_misses_in_a_row: 0, task_miss_reason: null, task_miss_at: null, task_auto_paused_at: null,
};

describe('a change of owner (store, TASK-936)', () => {
  it('a change of owner starts every routine it moves over, in the same statement: report, notes and misses go; pause, schedule and notes-cleared time stay', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    const repeat = await f.store.createAuthored(createInput('repeat'));
    const other = await f.store.createAuthored(taskInput('other', 'b'));
    // Every routine holds a report, notes, five misses and ax's pause, as recordReport and finishDispatch leave them.
    await sql`UPDATE routines_v1_definitions SET task_status = 'needs-you', task_update = ${needsYou.update}, task_ask = ${needsYou.ask},
      task_reported_at = ${minute(2)}, task_report_accepted_at = ${minute(1)}, agent_notes = 'Acme’s contact is Jo.',
      task_misses_in_a_row = 5, task_miss_reason = 'no-report', task_miss_at = ${minute(3)}, task_auto_paused_at = ${minute(4)},
      enabled = false, agent_notes_cleared_at = ${minute(0)}`.execute(f.db);
    const before = await stateRow(task.routineId);
    const otherBefore = await stateRow(other.routineId);
    expect(await moveTo('new-owner')).toBe(2);
    const after = await stateRow(task.routineId);
    expect(after).toEqual({ ...before, ...CLEARED, owner_user_id: 'new-owner', revision: after?.revision });
    expect(after?.revision).not.toBe(before?.revision);
    // Whatever its kind: a repeat row holding state (a hand edit, a rollback) is cleared too.
    expect(await stateRow(repeat.routineId)).toMatchObject({ ...CLEARED, owner_user_id: 'new-owner' });
    // It reads as a task that never reported, still paused, now a plain pause.
    expect(await f.store.findOne(task)).toMatchObject({ ownerUserId: 'new-owner', enabled: false, task: null, noRecentUpdate: null });
    // Another agent's routine, and the same move again, change nothing.
    expect(await stateRow(other.routineId)).toEqual(otherBefore);
    expect(await moveTo('new-owner')).toBe(0);
    expect(await stateRow(task.routineId)).toEqual(after);
  });
});
```

- [ ] **Step 2: Write the failing canary** (new `describe` at the end of `canary.test.ts`; every import it needs is already there)

```ts
// TASK-936: an agent's change of owner, end to end through the real routines, agents, tool-policy and
// decisions plugins and Postgres. The new owner's task starts over: none of the earlier owner's task
// state reaches their task page or a check-in run as them.
describe('owner change canary (TASK-936)', () => {
  const EARLIER = { status: 'needs-you', update: 'Refund QX7731 waits on Acme.', ask: 'May I refund QX7731?', notes: 'Acme’s contact is jo@acme.example.' } as const;

  it('after the agent moves to a new owner, their task shows none of the earlier owner’s state, and their next check-in starts with no notes and no misses', async () => {
    const ch = await createCheckInHarness();
    h = ch;
    const store = createRoutinesStore(h.db);
    const task = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
      agentId: h.agentId, requestId: randomUUID(), definition: RoutineDefinitionSchema.parse(TASK_DEFINITION),
    });
    const get = (as: AgentContext) => h.bus.call<unknown, RoutineView>('routines:get', as, { agentId: h.agentId, routineId: task.routineId });
    // The earlier owner's check-in reports, with notes; their next one leaves no report.
    await ch.checkIn(task, 'run-1', async (ctx, bus) => {
      expect(await bus.call('tool:execute:routine_report', routineRunner(ctx), { id: 'report', name: 'routine_report', input: EARLIER })).toStrictEqual({ recorded: true });
    });
    await expect.poll(async () => (await store.recentFires(task)).length).toBe(1);
    await ch.checkIn(task, 'run-2', async () => {});
    await expect.poll(async () => (await get(h.owner)).noRecentUpdate?.inARow).toBe(1);
    expect((await get(h.owner)).task).toMatchObject({ status: 'needs-you', agentNotes: EARLIER.notes });

    // The agent gets a new owner. @ax/agents has no hook that does that, so its row changes here; the rest is
    // production's path: the new owner opens the task, and resolveRoutineAccess moves its routines to them.
    await sql`UPDATE agents_v1_agents SET owner_id = 'new-owner' WHERE agent_id = ${h.agentId}`.execute(h.db);
    const newOwner = makeAgentContext({ userId: 'new-owner', agentId: 'test', sessionId: 'test' });
    const moved = await get(newOwner);
    expect(moved).toMatchObject({ task: null, noRecentUpdate: null, permissions: { fire: true } });
    const listed = (await h.bus.call<unknown, { routines: RoutineView[] }>('routines:list', newOwner, { agentId: h.agentId })).routines
      .find(row => row.routineId === task.routineId);
    expect(listed).toMatchObject({ task: null, noRecentUpdate: null });
    for (const text of ['QX7731', 'jo@acme']) expect(JSON.stringify({ moved, listed })).not.toContain(text);

    // Their next check-in, run as them, starts over: no notes and no misses line.
    const next = await ch.checkIn(moved, 'run-3', async () => {}, { asOwner: newOwner });
    expect(next.ctx.userId).toBe('new-owner');
    expect(next.message).toContain('You have no saved notes yet.');
    expect(next.message).not.toContain('ended without a report');
    expect(next.message).not.toContain('jo@acme');
  });
});
```

(Its earlier reports still reach that message until Task 3, so this test doesn't assert on them.)

- [ ] **Step 3: Run both and see them fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/owner-change-store.test.ts src/__tests__/canary.test.ts -t "TASK-936"`
Expected: FAIL. The store row keeps `task_status: 'needs-you'`, and the canary's `moved.task` isn't null.

- [ ] **Step 4: Implement the reset in `reconcileOwners`**

Keep the one raw UPDATE … FROM unnest. Append to its SET list, after `updated_at = now()`, the assignments generated from `NO_TASK_STATE`: `sql.join(Object.entries(NO_TASK_STATE).map(([column, value]) => sql`${sql.ref(column)} = ${value}`))`. The one constant then stays the one list, for a change of kind and a change of owner alike. Nothing else in the statement changes. It doesn't touch `enabled`, `next_run_at`, `agent_notes_cleared_at` or `last_*` (decisions rows 2 and 14).

Then fix the docs:
- `reconcileOwners`' interface doc: it moves each routine to the agent's owner at a new revision and, in the same statement, starts it over as a change of kind does (`NO_TASK_STATE`), because a task's state is its owner's. Replies stay as TASK-931 says.
- `NO_TASK_STATE`'s doc: add a paragraph saying a change of owner sets these too (`reconcileOwners`, TASK-936).
- `finishDispatch`'s interface doc: it writes the count; `updateAuthored` (a Resume, a kind change) and `reconcileOwners` (a change of owner) only start it over.
- `recordReport`'s interface doc: the one writer of a task's report; `updateAuthored` (a kind change) and `reconcileOwners` (a change of owner) only clear it.
- `migrations.ts` (:39-47, :61-69, :241-251): name `reconcileOwners` beside `updateAuthored` as clearing those columns.
- `missesAfterRun`'s doc (:252-253): a person's Resume, a kind change or a change of owner ends the freeze.
- `types.ts` (:24, :27-29): `task` and `noRecentUpdate` are also null again after a change of owner, and `reconcileOwners` clears them too.

- [ ] **Step 5: Run and see them pass, then the whole package**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/owner-change-store.test.ts src/__tests__/canary.test.ts && pnpm --filter @ax/routines test && pnpm --filter @ax/routines build`
Expected: PASS. The existing reconcile tests (`ownership.test.ts`, `defaults.test.ts`, `services.test.ts`, `reply-store.test.ts`, `reply.test.ts`, the TASK-931 canary) still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/routines/src/store.ts packages/routines/src/migrations.ts packages/routines/src/types.ts packages/routines/src/__tests__/owner-change-store.test.ts packages/routines/src/__tests__/canary.test.ts
git commit -m "[TASK-936] routines: a change of owner starts the task over"
```

---

### Task 3: A run is read only for whoever it ran as [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/store.ts`:
  - `acceptDispatch`'s dispatch insert (:589-592);
  - `finishDispatch`'s fire insert (:631-636) and its misses call (:645-647);
  - `rowToFire` (:372-379);
  - `recentFires` and `recentFiresForAgent` (:896-921) and their interface lines (:86-87);
  - `recentReports` (:923-939) and its interface doc (:88-93);
  - remove `routineOwners` (interface :26-31, implementation :979-984; `fireViews` is its only caller);
  - `reconcileOwners`' interface doc: one more sentence.
- Modify: `packages/routines/src/types.ts`: `FireRow` (:33-39).
- Modify: `packages/routines/src/services.ts`: `fireViews` (:91-105) and its two callers (:215-225).
- Modify: `packages/routines/src/fire.ts`: the `recentReports` call (:276) and the comment above it (:262-272).
- Modify: `packages/routines/src/checkin-message.ts`: the `reports` field doc (:20-21).
- Modify tests:
  - `owner-change-store.test.ts`: four new tests;
  - `report-store.test.ts`: the `recent` helper at :384 passes `actorUserId: 'owner'`;
  - `canary.test.ts`: a second test in the TASK-936 describe.

**Interfaces:**
- Consumes: Task 1's `run_as_user_id` columns; Task 2's test helpers.
- Produces:
  - `RoutinesStore.recentReports(input: RoutineKey & Actor & { limit: number }): Promise<Array<{ firedAt: Date; report: DispatchReport }>>`, where `Actor = { actorUserId: string }`, as for `recentReplies`.
  - `FireRow.routineOwnerUserId: string | null`
  - `RoutinesStore.routineOwners` is gone.
  - Inside `services.ts`: `function fireViews(userId: string, fires: FireRow[]): C.RoutineFireView[]`

- [ ] **Step 1: Write the failing store tests** (in `owner-change-store.test.ts`'s describe)

```ts
it('a run records who it ran as when it is accepted, and keeps it when it finishes after a move', async () => {
  const task = await f.store.createAuthored(taskInput('task'));
  const run = await bound(task, 'open-across-move', minute(1));
  const runAs = async (table: 'routines_v1_dispatches' | 'routines_v1_fires') => (await sql<{ run_as_user_id: string | null }>`
    SELECT run_as_user_id FROM ${sql.table(table)} WHERE dispatch_id = ${run.dispatchId}`.execute(f.db)).rows[0]?.run_as_user_id;
  expect(await runAs('routines_v1_dispatches')).toBe('owner');
  await moveTo('new-owner');
  expect(await finish(run.dispatchId)).toBe(true);
  expect(await runAs('routines_v1_fires')).toBe('owner');
});

it('a check-in still open when the task moves leaves the new owner’s task alone: no report, no notes, no miss', async () => {
  const task = await f.store.createAuthored(taskInput('task'));
  const reported = await bound(task, 'reported', minute(1));
  expect(await record(reported, needsYou, 'owner', 'Acme’s contact is Jo.')).toBe('recorded');
  const silent = await bound(task, 'silent', minute(2));
  await moveTo('new-owner');
  // It can't report into the moved task: recordReport checks the owner under the row lock.
  expect(await record(silent, onTrack)).toBe('owner');
  expect(await finish(silent.dispatchId)).toBe(true);
  expect(await finish(reported.dispatchId)).toBe(true);
  expect(await stateRow(task.routineId)).toMatchObject({ ...CLEARED, owner_user_id: 'new-owner' });
  // Neither run is the new owner's to read, and the earlier owner no longer owns the task.
  expect(await f.store.recentFires(task)).toEqual([]);
  for (const actorUserId of ['new-owner', 'owner']) {
    expect(await f.store.recentReports({ agentId: 'a', routineId: task.routineId, actorUserId, limit: 3 })).toEqual([]);
  }
  // A run with no record of who it ran as (accepted by code from before version 9) still counts, as before.
  const legacy = await bound(task, 'legacy', minute(3), 'new-owner');
  await sql`UPDATE routines_v1_dispatches SET run_as_user_id = NULL WHERE dispatch_id = ${legacy.dispatchId}`.execute(f.db);
  expect(await finish(legacy.dispatchId)).toBe(true);
  expect((await stateRow(task.routineId))?.task_misses_in_a_row).toBe(1);
});

it('a routine’s history lists only the runs that ran as its current owner, with that owner, and every run of a routine that’s gone', async () => {
  const task = await f.store.createAuthored(taskInput('task'));
  await finished(task, 'earlier', minute(1), needsYou);
  await moveTo('new-owner');
  await finished(task, 'newer', minute(2), onTrack, 'new-owner');
  const listed = async () => ({
    byRoutine: (await f.store.recentFires(task)).map(r => [r.firedAt, r.routineOwnerUserId, r.report?.status ?? null]),
    forAgent: (await f.store.recentFiresForAgent({ agentId: 'a' })).map(r => [r.firedAt, r.routineOwnerUserId, r.report?.status ?? null]),
  });
  expect(await listed()).toEqual({ byRoutine: [[minute(2), 'new-owner', 'on-track']], forAgent: [[minute(2), 'new-owner', 'on-track']] });
  // Back to the earlier owner: their own run lists again, the interim owner's doesn't.
  await moveTo('owner');
  expect(await listed()).toEqual({ byRoutine: [[minute(1), 'owner', 'needs-you']], forAgent: [[minute(1), 'owner', 'needs-you']] });
  // A run with no record of who it ran as (written by code from before version 9) lists for no one.
  await sql`INSERT INTO routines_v1_fires (agent_id, routine_id, fired_at, trigger_source, status) VALUES ('a', ${task.routineId}, ${minute(3)}, 'tick', 'ok')`.execute(f.db);
  expect((await listed()).byRoutine).toEqual([[minute(1), 'owner', 'needs-you']]);
  // Once the routine is gone every run of it lists, with no owner, as before (fireViews then shows no report).
  const current = (await f.store.findOne(task))!;
  await f.store.deleteAuthored({ agentId: 'a', routineId: task.routineId, expectedRevision: current.revision, actorUserId: 'owner', requestId: 'delete', now });
  expect((await listed()).byRoutine).toEqual([[minute(3), null, null], [minute(2), null, 'on-track'], [minute(1), null, 'needs-you']]);
});

it('a check-in reads only the reports of runs that ran as the person it runs as, on a task they own now', async () => {
  const task = await f.store.createAuthored(taskInput('task'));
  const reports = (actorUserId: string) => f.store.recentReports({ agentId: 'a', routineId: task.routineId, actorUserId, limit: 3 });
  await finished(task, 'earlier', minute(1), needsYou);
  expect(await reports('owner')).toEqual([{ firedAt: minute(1), report: needsYou }]);
  await moveTo('new-owner');
  expect(await reports('new-owner')).toEqual([]);
  expect(await reports('owner')).toEqual([]);
  await finished(task, 'newer', minute(2), onTrack, 'new-owner');
  expect(await reports('new-owner')).toEqual([{ firedAt: minute(2), report: onTrack }]);
  await moveTo('owner');
  expect(await reports('owner')).toEqual([{ firedAt: minute(1), report: needsYou }]);
  expect(await reports('new-owner')).toEqual([]);
});
```

- [ ] **Step 2: Write the failing canary** (second test in the TASK-936 describe; reuses `EARLIER`)

```ts
it('after the agent moves to a new owner, their Updates thread lists none of the earlier owner’s check-ins, and their check-ins read only their own reports', async () => {
  const ch = await createCheckInHarness();
  h = ch;
  const store = createRoutinesStore(h.db);
  const task = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
    agentId: h.agentId, requestId: randomUUID(), definition: RoutineDefinitionSchema.parse(TASK_DEFINITION),
  });
  const MINE = { status: 'on-track', update: 'Queue is empty.', ask: null } as const;
  await ch.checkIn(task, 'run-1', async (ctx, bus) => {
    expect(await bus.call('tool:execute:routine_report', routineRunner(ctx), { id: 'report', name: 'routine_report', input: EARLIER })).toStrictEqual({ recorded: true });
  });
  await expect.poll(async () => (await store.recentFires(task)).length).toBe(1);
  await sql`UPDATE agents_v1_agents SET owner_id = 'new-owner' WHERE agent_id = ${h.agentId}`.execute(h.db);
  const newOwner = makeAgentContext({ userId: 'new-owner', agentId: 'test', sessionId: 'test' });
  const get = () => h.bus.call<unknown, RoutineView>('routines:get', newOwner, { agentId: h.agentId, routineId: task.routineId });
  // What the task page reads, as the transcript route reads it (its newest 200 check-ins), and the agent's feed.
  const history = async () => ({
    byRoutine: (await h.bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires', newOwner, { agentId: h.agentId, routineId: task.routineId, limit: 200 })).fires,
    forAgent: (await h.bus.call<unknown, { fires: RoutineFireView[] }>('routines:recent-fires-for-agent', newOwner, { agentId: h.agentId })).fires
      .filter(fire => fire.routineId === task.routineId),
  });
  const moved = await get();
  expect(await history()).toEqual({ byRoutine: [], forAgent: [] });

  // Their first check-in carries none of the earlier owner's reports, and reports itself.
  const first = await ch.checkIn(moved, 'run-2', async (ctx, bus) => {
    expect(await bus.call('tool:execute:routine_report', routineRunner(ctx), { id: 'report', name: 'routine_report', input: MINE })).toStrictEqual({ recorded: true });
  }, { asOwner: newOwner });
  expect(first.message).toContain('No earlier reports yet.');
  expect(first.message).not.toContain('QX7731');
  await expect.poll(async () => (await history()).byRoutine.length).toBe(1);
  const seen = await history();
  expect(seen.byRoutine[0]?.report).toEqual(MINE);
  expect(seen.forAgent).toHaveLength(1);
  expect(JSON.stringify(seen)).not.toContain('QX7731');

  // Their next check-in reads their own report, and still none of the earlier owner's.
  const second = await ch.checkIn(await get(), 'run-3', async () => {}, { asOwner: newOwner });
  expect(second.message).toContain('Queue is empty.');
  expect(second.message).not.toContain('QX7731');
  // The earlier owner's check-in is still stored, under who it ran as.
  await expect.poll(async () => (await sql<{ run_as_user_id: string | null }>`
    SELECT run_as_user_id FROM routines_v1_fires WHERE routine_id = ${task.routineId} ORDER BY fired_at, id`.execute(h.db)).rows
    .map(row => row.run_as_user_id)).toEqual(['owner', 'new-owner', 'new-owner']);
});
```

- [ ] **Step 3: Update `report-store.test.ts`'s `recent` helper (:384)** to `f.store.recentReports({ agentId, routineId, actorUserId: 'owner', limit })`. Its three tests run as the routine's owner and keep their expectations.

- [ ] **Step 4: Run them and see them fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/owner-change-store.test.ts src/__tests__/canary.test.ts src/__tests__/report-store.test.ts`
Expected: the new tests FAIL. Fire rows carry `run_as_user_id: null`, history lists the earlier owner's runs, `routineOwnerUserId` is undefined, and the new owner's first message holds `QX7731`. The `report-store.test.ts` tests still pass.

- [ ] **Step 5: Implement**

1. `acceptDispatch` inserts `run_as_user_id: raw.owner_user_id`, the owner it read under the row lock, which `fire.ts` runs as.
2. `finishDispatch` inserts the fire with `run_as_user_id: dispatch.run_as_user_id`. It skips miss counting for a run that ran as someone who no longer owns the routine: `misses` is null when `definition === undefined || (dispatch.run_as_user_id !== null && dispatch.run_as_user_id !== definition.owner_user_id)`. Like a refused report, such a run can't touch the new owner's task; a NULL run-as counts as before (decisions row 9). Add one sentence on this to `finishDispatch`'s interface doc.
3. One query both history reads share (module-private in `store.ts`):

```ts
function historyQuery(db: DB) {
  return db.selectFrom('routines_v1_fires as f')
    .leftJoin('routines_v1_definitions as r', join => join.onRef('r.agent_id', '=', 'f.agent_id').onRef('r.routine_id', '=', 'f.routine_id'))
    .selectAll('f').select('r.owner_user_id as routine_owner_user_id')
    .where(eb => eb.or([eb('r.routine_id', 'is', null), eb('f.run_as_user_id', '=', eb.ref('r.owner_user_id'))]));
}
```

   `recentFires` adds `.where('f.agent_id', '=', …).where('f.routine_id', '=', …).orderBy('f.fired_at', 'desc').limit(limit)`. `recentFiresForAgent` adds the agent filter, the optional `f.fired_at < before`, and the same order and limit. Keep today's clamps and ordering. `rowToFire` takes `Selectable<RoutinesFiresRow> & { routine_owner_user_id: string | null }` and maps `routineOwnerUserId`. Doc the query and both interface lines: a live routine's runs only when they ran as its current owner, every run of a gone routine, and the owner read from the same statement.
4. `recentReports` changes in three ways, all in one statement. It inner-joins the definition `ON r.agent_id = f.agent_id AND r.routine_id = f.routine_id AND r.owner_user_id = f.run_as_user_id`. It adds `.where('f.run_as_user_id', '=', input.actorUserId)`. It keeps today's report filters, order and clamp, with every column qualified as `f.` (`f.agent_id`, `f.routine_id`, `f.report_status`, `f.report_update`, `f.fired_at`, `f.id`). After the join, `agent_id` and `routine_id` exist on both tables, and Postgres refuses an unqualified one (42702), which Kysely's types don't catch. This mirrors `recentReplies`: the reports of runs that ran as the reader, on a routine they own now. Rewrite its interface doc to say so.
5. `FireRow` gains `routineOwnerUserId: string | null`. Its doc: the routine's owner as the history read found it, in the same statement, so it is also who the run ran as; null when the routine is gone; who may see the run's report (`fireViews`).
6. `fireViews(userId, fires)` destructures `{ id: _id, firedAt, report, routineOwnerUserId, ...fire }`. It shows `report` only when `routineOwnerUserId !== null && routineOwnerUserId === userId`, else `null`. The second owner read is gone. The two services call `fireViews(ctx.userId, fires)`. Rewrite its doc: who ran the run and who may read its report come from one read, so they can't disagree across a move. Remove `routineOwners`.
7. `fire.ts` passes `actorUserId: row.ownerUserId` to `recentReports`. Its comment and `checkin-message.ts`'s `reports` doc say reports are read like replies: only this task's runs that ran as the person the check-in runs as, while the task is still theirs, so an earlier owner's reports never reach it.
8. `reconcileOwners`' interface doc gains: runs stay stored too, and are read only for the person they ran as, while they own the routine (`recentFires`, `recentReports`).

- [ ] **Step 6: Run and see them pass, then the package and its dependents' build**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/owner-change-store.test.ts src/__tests__/canary.test.ts src/__tests__/report-store.test.ts && pnpm --filter @ax/routines test && pnpm --filter @ax/routines build && pnpm --filter @ax/channel-web build`
Expected: PASS and clean builds. These still pass unchanged:
- `report-tool.test.ts` (team task views, and a deleted team task's runs);
- `report-views.test.ts`;
- `checkin.test.ts` (a team agent's message reaches nobody but its owner);
- the TASK-931 owner-move canary.

- [ ] **Step 7: Run the `security-checklist` skill over Tasks 1–3's diff** (`git diff origin/main -- packages/routines`). Write its note for the PR, starting from this plan's Security checklist section. Every item needs an answer, and an N/A needs a reason.

- [ ] **Step 8: Commit**

```bash
git add packages/routines/src/store.ts packages/routines/src/types.ts packages/routines/src/services.ts packages/routines/src/fire.ts packages/routines/src/checkin-message.ts packages/routines/src/__tests__/owner-change-store.test.ts packages/routines/src/__tests__/report-store.test.ts packages/routines/src/__tests__/canary.test.ts
git commit -m "[TASK-936] routines: a run is read only for whoever it ran as"
```

---

### Task 4: Docs say what an owner change does [tier: mechanical]

**Files:**
- Modify: `packages/routines-contract/src/services.ts` (:117-126)
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md` (:226, :288, :466-467, :653-656, end of §15)

**Interfaces:** none (comments and prose only).

- [ ] **Step 1: Contract docs.** Add a doc comment above `RoutineRecentFiresOutputSchema`, covering both history services. It lists a routine's runs, newest first. For a live routine, only the runs that ran as its current owner, so after a change of owner the earlier owner's runs reach no one, their reports included, until the routine moves back. A gone routine's runs all list, with no report. Amend the `report` field comment: null for anyone but the routine's owner, who is also the person the run ran as (TASK-936).
- [ ] **Step 2: Design doc.**
  - **§3.3:** a new `> PR 2 (TASK-936):` note after the TASK-931 note (:226). If the task moves to a new owner, it starts over. The new owner sees no latest update, notes or misses. Updates and every check-in's message hold only their own check-ins. The earlier owner's stay stored, and come back only if the task moves back.
  - **§3.6** (:288): "Only a person's Resume, or a change of kind, starts the count over." becomes "Only a person's Resume, a change of kind or a change of owner (TASK-936) starts the count over."
  - **§4.5**, Task state row (:466): append "(TASK-936: a change of owner clears it, as a change of kind does)".
  - **§4.5**, Run history row (:467): append "(TASK-936: and who it ran as, schema version 9; Updates and the check-in message read only the runs that ran as the task's current owner)".
  - **§7** (:656): "Only a person's Resume starts the count over (TASK-930)." was already stale, since a change of kind clears it too. It becomes "Only a person's Resume, a change of kind or a change of owner starts the count over (TASK-930, TASK-936)."
  - **§7:** a new bullet after the reply bullet (:653). **A task's state is its owner's.** If the task moves to a new owner, it starts over: its report, notes and missed check-ins go. Its runs, reports included, are read only for the person they ran as while that person owns it, never on the new owner's page and never in their check-ins (TASK-936).
  - **§15:** append two rows dated 2026-10-23, both Decided.
    - (a) A change of owner starts a task over in the statement that moves it, as a change of kind does: report, ask, agent notes and missed check-ins. A task paused for misses stays paused, as a plain pause (TASK-936).
    - (b) Each run records who it ran as (schema version 9). A routine's history and a check-in's earlier reports hold only the runs that ran as its current owner, so an earlier owner's check-ins reach neither the new owner's page nor their check-ins. They read again only if the task moves back, as replies do. Runs recorded before version 9 count as their routine's owner's at the upgrade (TASK-936).
- [ ] **Step 3: Check, then commit**

Run: `pnpm --filter @ax/routines-contract build`
Expected: clean.

```bash
git add packages/routines-contract/src/services.ts docs/plans/2026-10-20-agent-tasks-design.md
git commit -m "[TASK-936] docs: what a change of owner does to a task"
```

---

## Final verification (the card's gate)

Run: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
Expected: all green. Don't stop at the recursive run: all three suites must run (CLAUDE.md).

## Not in this card (YAGNI, decisions row 16)

- Deleting the earlier owner's fires or replies.
- An `owner_since` column.
- Filtering `tasksForConversations` by run-as: Today already drops the label on a move (TASK-932 decisions, "Accepted" (c)).
- Resetting `last_run_at`/`last_status`/`last_error`/`last_warning`.
- A kind column on dispatches (TASK-908's open follow-up).
- Any channel-web change, new log line, or index.
