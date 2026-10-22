# TASK-909 Tasks page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Tasks** entry in the workspace sidebar, right under Today, opens `/workspace/tasks`: every task the person owns across the agents they can see, grouped by what needs them, each row leading with the agent's latest update.

**Architecture:** A new BFF route, `GET /api/workspace/tasks` in `routes-workspace.ts`, fans `routines:list` out over the caller's roster (`listAgents`) with `agentWorkspaceCtx`, keeps the caller's own non-repeat routines, and projects each to a small wire row with the agent's text fenced. The client reads it with `useTasks()` from inside a new `TasksPage`, groups rows with a pure `groupTasks()`, and draws them with `StateDot`'s new task marks. A `{ kind: 'tasks' }` route and a sidebar row wire it into the shell. No new hook, plugin, dependency or shadcn component.

**Tech Stack:** TypeScript, React 18, shadcn (radix) primitives, Tailwind v3 semantic tokens, vitest + testing-library (no user-event), zod via `@ax/routines-contract`.

**Spec:** the TASK-909 card body, and `docs/plans/2026-10-20-agent-tasks-design.md` §3 (house rules), §3.1, §3.6, §12 and §14. Contract from the predecessor: the section "For the sibling cards (TASK-908 and later)" of `docs/plans/2026-10-21-task-907-routine-report-plan.md`. Decisions: `.claude/memory/decisions/2026-10-22-TASK-909.md`, rows counted from the first data row. Read rows 2–5 before Task 1: each one departs from the card.

## Global Constraints

- Stay inside `packages/channel-web`, plus the one design-doc paragraph in Task 1 and the memory shard. TASK-908 is in flight in `packages/routines`, `routines-contract`, `chat-orchestrator`, `core` and `agent-runner-core`; touch none of them.
- No new hook, plugin, dependency, shadcn component or `pnpm-lock.yaml` change. Alert, Button, Collapsible, Empty and Spinner are installed.
- The route reads identity only from `authOr401`, and nothing from `req.params`, `req.query` or the body.
- Agent-written text (`update`) leaves the server only through `fenceLine(update, ROUTINE_REPORT_UPDATE_MAX_CHARS)` (500). `ask` and `agentNotes` never leave it. The page draws text only as React text children: no `dangerouslySetInnerHTML`, no markdown component. A `title` carries the fenced value (TASK-436).
- `src/lib/` modules the server or a server test imports use relative `./x.js` imports, never `@/lib/...` (TASK-906 pattern): `workspace-types.ts` and `task-groups.ts`.
- `theme-contrast.test.ts` scans all of `src/` outside `__tests__`, comments included. Never write the text-colour form of the state-quiet token (`text-` + `state-quiet`) anywhere, and never pair `bg-<family>-soft` with `text-<family>` in a new file.
- Every `StateDot` fill is an arm of the form `state === '<mark>' && '<class>',` inside its `cn()` call. That is the only form the contrast test parses; any other spelling leaves the mark unmeasured with a green suite.
- Plain words on the page: Tasks, check in, Needs you. Never routine, webhook or trigger. Copy marked "exact" is decided; paste it. The apostrophe in the copy is `’` (U+2019).
- Counting is fine; no progress bars or time estimates (the `Elapsed` rule in `bits.tsx`).
- Rows are not links and have no hover affordance until TASK-910 adds the task page. No placeholder route.
- Run one test file as `pnpm --filter @ax/channel-web test <path>` (filter before the script, no `--`; several paths are fine). Check the file count in vitest's summary.
- vitest doesn't type-check, and channel-web's `tsc` includes its tests: after each task run `pnpm --filter @ax/channel-web exec tsc --build`.
- TDD and the Bug Fix Policy: run each new test against the unmodified code and watch it fail before changing the source.
- Test inputs with invisible characters are written as escape text (`'\u202E'`) and checked with the code-point scan in `.claude/memory/mistakes/2026-10-20-TASK-904.md`; the Write and Edit tools can store the raw character (`.claude/memory/mistakes/2026-10-22-TASK-907.md`). No task here needs one; if you add one, scan it.
- Final gates (CLAUDE.md): `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Docker-backed suites need `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock` on this machine.
- Memory: shards only, from `scripts/memory-write-target.sh --shard <kind> TASK-909`. Never touch a root `.claude/memory/*.md`, and never add a `Memory-Rewrite:` trailer.
- Deploy: none. PR 1 deploys as a whole, and TASK-907 must not deploy before TASK-910.

## Review Focus

1. **A team agent with several owners.** A member (or another admin) never sees a task they don't own, and its update text appears nowhere in the response. Pinned in Task 2 (`on a team agent, lists only the tasks the caller owns`).
2. **No rows, and one agent couldn't be read.** The page says which agent it couldn't read and never says "No tasks yet". Pinned in Task 5 (`says which agents could not be read, and never claims the list is empty`).
3. **A tab left open.** "checked 4 min ago" keeps moving instead of going stale. Pinned in Task 5 (`dates a report from when it was written…`).
4. **Report text stored before the writer's rules (TASK-913).** An update over 500 characters or with a line break comes back as one capped line. Pinned in Task 2 (`caps a stored update to one line of 500 characters`).
5. **Retry races and version skew.** An older answer landing after a newer one is dropped, and a 404 from a host without the route reads as "couldn't load" with Try again. Pinned in Task 3 (`drops an older answer…`, `calls a 401 expired and anything else failed`).

## Where this plan departs from the card

Each is a decisions row; say so in the PR description.

- **Owner-only, by `task !== null || permissions.fire`** (row 2). `RoutineView` has no owner field, so the predecessor's `ownerUserId === userId` can't be written here. One accepted gap, pinned by a test.
- **"No update yet" means "has never reported"** (row 3). The card's "or the last check-in ended without a report" is design PR 2's failure handling, and `reportedAt < lastRunAt` would be wrong: `tick.ts` moves `last_run_at` when a check-in starts and when it skips one outside active hours.
- **No `lastRunAt` fallback for "checked … ago"** (row 4), for the same reason.
- **The wire row carries only what the page draws** (row 5): no `ask`, `kind`, `lastRunAt`, `nextRunAt`, `lastStatus` or trigger. The card's "update/ask are capped" becomes "update is capped, and the ask is never sent".
- Card text only: `workspace-route.ts` is `packages/channel-web/src/lib/workspace-route.ts`.

## For the sibling cards (TASK-910 and later): what this card guarantees

- `GET /api/workspace/tasks` answers `TasksResponse` (`lib/workspace-types.ts`): the caller's own non-repeat routines on every roster agent, in roster order, each with `agentId` and `routineId`, so TASK-910 can turn rows into links to its task route without a new read.
- `TaskGroup` (`lib/task-groups.ts`) is the one vocabulary for a task's mark, and `StateDot` draws each value. The task page header can draw `<StateDot state={taskGroup(row)} />`. The group words live in `TasksPage.tsx` (`TASK_GROUP_LABELS`); move them to a shared module when a second surface needs them.
- The load-failure card is private to `TasksPage.tsx`. Extract it if the task page wants the same register.
- **Design PR 2** owns "No recent update": `taskGroup`'s `task === null → 'no-update'` rule and the design §3.6 note are where it changes. `lastRunAt` is not "the last check-in".
- **Design PR 4** (team members start tasks that run as themselves) must keep `permissions.fire` true for an owner who may run their own task, or revisit `isOwnTask` in `routes-workspace.ts`.
- **Design PR 3** (`get-done`) already appears on the page (`kind !== 'repeat'`); add `kind` to `TaskRow` with the steps.

## Order and file ownership

| Wave | Task | Touches | Depends on |
|---|---|---|---|
| 1 | T1 wire row and grouping | `lib/workspace-types.ts`, new `lib/task-groups.ts` and its test, design §3.6 | — |
| 2 | T2 the route | `server/routes-workspace.ts`, `server/plugin.ts`, new `__tests__/server/routes-workspace-tasks.test.ts`, `routes-workspace-registration.test.ts`, `plugin.test.ts` | T1 |
| 2 | T3 the page's read | `lib/workspace-api.ts`, new `lib/workspace-tasks.ts`, two new lib tests | T1 |
| 2 | T4 task marks | `components/workspace/bits.tsx`, `StateDotSlot.test.tsx`, `src/__tests__/theme-contrast.test.ts` | T1 |
| 3 | T5 the page | `lib/workspace-time.ts` and its test, new `TasksPage.tsx` and its test | T1, T3, T4 |
| 4 | T6 route, sidebar, shell | `lib/workspace-route.ts` and its test, `WorkspaceSidebar.tsx`, `WorkspaceShell.tsx`, `WorkspaceSidebarState.test.tsx`, `WorkspaceShellRouting.test.tsx` | T5 |

Paths below are under `packages/channel-web/src/` unless they start with `docs/` or `packages/`.

---

### Task 1: The wire row and the grouping rule [tier: mechanical]

**Files:**
- Modify: `lib/workspace-types.ts` (append the four types; one `import type`)
- Create: `lib/task-groups.ts`
- Test: `lib/__tests__/task-groups.test.ts`
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md` §3.6 (a paragraph after the table)

**Interfaces:**
- Produces, in `lib/workspace-types.ts` (`import type { RoutineReportStatus } from '@ax/routines-contract';`):

```ts
/** A task's latest report, as the Tasks page shows it (TASK-909). The agent wrote `update`; the server fenced it to one line of at most 500 code points, or null when nothing legible survived. */
export interface TaskRowReport { status: RoutineReportStatus; update: string | null; reportedAt: string }
/** One row of `GET /api/workspace/tasks`: a task the caller owns, on an agent they can see. `task` is null until its first report. */
export interface TaskRow { agentId: string; agentName: string; routineId: string; name: string; enabled: boolean; task: TaskRowReport | null }
/** An agent whose tasks couldn't be read, so the page can say so instead of looking complete. */
export interface UnavailableAgent { agentId: string; agentName: string }
export interface TasksResponse { tasks: TaskRow[]; unavailableAgents: UnavailableAgent[] }
```

- Produces, in `lib/task-groups.ts` (`import type { TaskRow } from './workspace-types.js';`, nothing else):

```ts
export type TaskGroup = 'needs-you' | 'off-track' | 'on-track' | 'no-update' | 'paused';
export type ActiveTaskGroup = Exclude<TaskGroup, 'paused'>;
export const ACTIVE_TASK_GROUPS: readonly ActiveTaskGroup[]; // ['needs-you', 'off-track', 'on-track', 'no-update']
export function taskGroup(row: TaskRow): TaskGroup;
export function groupTasks(rows: readonly TaskRow[]): { groups: Array<{ group: ActiveTaskGroup; rows: TaskRow[] }>; paused: TaskRow[] };
```

Rules: `enabled === false` → `'paused'` whatever the report says; else `task === null` → `'no-update'`; else `task.status`. `groups` follows `ACTIVE_TASK_GROUPS` and leaves out empty groups. Inside a group, and in `paused`: newest `task.reportedAt` first (a null or unparseable instant last), then `name` by `localeCompare`, then `agentName` by `localeCompare`, then `agentId`, then `routineId` (plain `<`), so the order never shuffles. Never mutates its input.

- [ ] **Step 1: Write the failing tests** in `lib/__tests__/task-groups.test.ts`, with a helper `row(over: Partial<TaskRow>): TaskRow` (defaults: `agentId 'a1'`, `agentName 'Caveman'`, `routineId 'r1'`, `name 'Zero open tickets'`, `enabled true`, `task null`) and `report(status, reportedAt = '2026-10-22T10:00:00.000Z')`:
  - `puts a paused task under paused, whatever its report says`: `taskGroup(row({ enabled: false, task: report('needs-you') }))` is `'paused'`.
  - `puts a task that has never reported under no-update`.
  - `it.each(['needs-you', 'off-track', 'on-track'])('puts a %s report under its own group')`.
  - `orders the groups needs-you, off-track, on-track, no-update, and leaves empty ones out`: input order on-track, no-update, needs-you → `groups.map(g => g.group)` is `['needs-you', 'on-track', 'no-update']`.
  - `lists the newest update first, then never-reported tasks by name`: two on-track rows reported 10:00 and 10:05 → the 10:05 one first; no-update rows named `'b'`, `'A'`, `'c'` → `['A', 'b', 'c']`.
  - `keeps paused tasks out of the groups and sorts them the same way`: a paused needs-you row isn't in any group; `paused` lists a reported row before a never-reported one.
  - `breaks ties by agent name, then ids`: same name and instant on agents `'Juniper'` and `'Caveman'` → Caveman first.
  - `does not reorder the array it is given`.

- [ ] **Step 2: Run them and watch them fail** (module missing): `pnpm --filter @ax/channel-web test src/lib/__tests__/task-groups.test.ts`.

- [ ] **Step 3: Add the types to `lib/workspace-types.ts` and write `lib/task-groups.ts`** per the Interfaces block.

- [ ] **Step 4: Run the test (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.

- [ ] **Step 5: Add this paragraph to design §3.6, right after the status table (exact):**

> PR 1 ships part of this table (TASK-909). The Tasks page draws ○ as **No update yet** for a task that has never reported. A check-in that fails, or ends without a report, leaves the task showing its last report until PR 2 adds No recent update and failure counting. Telling those apart needs each run's report: a task's last-run time moves when a check-in starts and when one is skipped outside its active hours, so it can't stand in for "the last check-in".

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/lib/workspace-types.ts packages/channel-web/src/lib/task-groups.ts packages/channel-web/src/lib/__tests__/task-groups.test.ts docs/plans/2026-10-20-agent-tasks-design.md
git commit -m "Agent Tasks: the Tasks page's row and how it groups (TASK-909)"
```

---

### Task 2: `GET /api/workspace/tasks` [tier: sensitive] (security-checklist)

**Files:**
- Modify: `server/routes-workspace.ts` — header route list and security paragraph (lines 1–90), the `@ax/routines-contract` import (115–121), a view type near the other routine interfaces (~670–680), the handler next to `activity` (~6368), the route table next to `/api/workspace/activity` (~8774)
- Modify: `server/plugin.ts:58-61` (header comment) and `:286-292` (`routines:list` degradation and its comment)
- Modify: `__tests__/server/plugin.test.ts:774-776` (the pinned degradation)
- Modify: `__tests__/server/routes-workspace-registration.test.ts:60-67` (one `toContain`)
- Create: `__tests__/server/routes-workspace-tasks.test.ts`

**Interfaces:**
- Consumes: `TaskRow`, `TasksResponse`, `UnavailableAgent` from `../lib/workspace-types.js` (Task 1); `groupTasks` from `../../lib/task-groups.js` (Task 1, canary test only).
- Produces: `handlers.tasks(req: RouteRequest, res: RouteResponse): Promise<void>` on `makeWorkspaceHandlers`'s result, mounted as `GET /api/workspace/tasks`. 200 → `TasksResponse`; no session → 401 `{ error: 'unauthenticated' }`.

**The route:**
- `import type { RoutineView } from '@ax/routines-contract'` and the runtime `ROUTINE_REPORT_UPDATE_MAX_CHARS` (into the existing import). `type TaskListView = Pick<RoutineView, 'routineId' | 'name' | 'kind' | 'enabled' | 'permissions' | 'task'>;` and `interface TaskListOutput { routines: TaskListView[] }`. The bus has already parsed the answer through `RoutineListOutputSchema`, so read the fields; don't re-validate them.
- Module-private `function isOwnTask(view: TaskListView): boolean` returning `view.task !== null || view.permissions.fire`, with a comment saying: the view has no owner; the services show `task` only to its owner (`taskView`) and give `fire` only to an owner who may manage the agent's routines (`routinePermissions`); a never-reported task whose owner lost that permission is left out until its first report (decisions row 2); design PR 4 must keep this true for member-owned tasks.
- Module-private `function toTaskRows(agent: { id: string; displayName: string }, views: readonly TaskListView[]): TaskRow[]`: keep `kind !== 'repeat' && isOwnTask(view)`; build each row field by field, never spreading the view: `agentName: agent.displayName` (the roster string `/state` sends), `name: fenceLine(view.name, ROUTINE_NAME_MAX_CHARS) ?? 'Untitled task'`, `task: null` or `{ status, update: fenceLine(view.task.update, ROUTINE_REPORT_UPDATE_MAX_CHARS), reportedAt }`.
- Inside `makeWorkspaceHandlers`, `async function tasksForAgent(agent, userId): Promise<{ ok: true; tasks: TaskRow[] } | { ok: false }>`: `bus.call<RoutinesListInput, TaskListOutput>('routines:list', agentWorkspaceCtx(agent.id, userId), { agentId: agent.id })`. Any throw → `initCtx.logger.warn('workspace_tasks_read_failed', { agentId: agent.id, error: <message> })` (the `firesForAgent` shape) and `{ ok: false }`.
- `async tasks(req, res)`: `authOr401` → `listAgents(userId)`, uncaught (the roster is the page) → without `routines:list`, 200 `{ tasks: [], unavailableAgents: [] }` → `Promise.all` over the roster → 200 `{ tasks, unavailableAgents }` `satisfies TasksResponse`, both in roster order. A JSDoc on the handler says what it serves and links decisions rows 2 and 7.
- Header: add `GET  /api/workspace/tasks            — every task the caller owns, across their agents (TASK-909)` after the `/api/workspace/activity` entry and its `?agentId=` line. In the security paragraph, "`/state`, `/route` and the UNSCOPED branch of `/activity`" becomes "`/state`, `/route`, `/tasks` and the UNSCOPED branch of `/activity`", and add the sentence: "`/tasks` is checked again per agent: `routines:list` runs `agents:resolve` for the caller itself and shows a task's state only to its owner (TASK-907)."
- `plugin.ts`: the `routines:list` degradation becomes (exact) `'the Tasks page lists no tasks, and Activity rows say "Routine unavailable" instead of each routine\'s authored name'`; its comment says the Tasks page reads this hook too, and that without it rows say "Routine unavailable" (the old text named a "routine path" label that no longer exists, rule 5). Add to the header comment, after the TASK-231 sentence: "TASK-909 adds no hard call either: the Tasks page (GET /api/workspace/tasks) reads the optional routines:list and answers an empty list without it."

**The test harness** (`routes-workspace-tasks.test.ts`): copy `mkReq`, `mkRes` and `initCtx` from `routes-workspace.test.ts:53-96`. Import `routineView` from `'../../../../routines/src/services.js'`, `type StoredRoutine` from `'../../../../routines/src/types.js'` (the imports `src/__tests__/routine-manager-producer.test.tsx` already makes, one level shallower), `routineFixture` from `'../../components/routines/__tests__/routine-fixture.js'`, and `RoutineListOutputSchema`, `RoutineViewSchema`, `ROUTINE_REPORT_UPDATE_MAX_CHARS` from `@ax/routines-contract`. A `setup({ viewer, rosters, rows, managers, failures })` builds a fresh `HookBus` per test and registers:
- `auth:require-user` → `{ user: { id: viewer, isAdmin: false } }`, or throws `PluginError({ code: 'unauthenticated', … })` when `viewer` is null;
- `agents:list-for-user` → `{ agents: rosters[userId] ?? [] }`, recording each call;
- `routines:list`, registered with `{ returns: RoutineListOutputSchema }` so the real schema parses every view as in production. It records `{ userId: ctx.userId, agentId: ctx.agentId, input }`, throws `failures.get(input.agentId)` when set, and otherwise answers `{ routines: rows.filter(r => r.agentId === input.agentId).map(r => routineView(r, ctx.userId, managers[input.agentId]?.includes(ctx.userId) ?? false)) }`.

Fixtures: `stored(over: Partial<StoredRoutine>): StoredRoutine` = `{ ...routineFixture, kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.', ownerUserId: 'alice', definitionId: null, definitionUpdatedAt: null, nextRunAt: null, lastRunAt: null, task: null, ...over }`; `report(status, over = {})` = `{ status, update: 'Queue is empty.', ask: 'ASK-TEXT want me to draft a reply?', agentNotes: 'NOTES-TEXT Acme is an enterprise customer.', reportedAt: new Date('2026-10-22T09:58:00.000Z'), ...over }`. Default world: `rosters.alice = [{ id: 'a1', displayName: 'Caveman' }, { id: 'a2', displayName: 'Juniper' }]`, `managers = { a1: ['alice'], a2: ['alice'] }`.

- [ ] **Step 1: Write the failing tests:**
  - `lists only tasks, across two agents, in roster order`: a1 has task `t1` (needs-you) and a repeat routine `r1` (`kind: 'repeat', goodWhen: null`); a2 has task `t2` (no report). 200; `tasks.map(t => [t.agentId, t.routineId])` is `[['a1', 't1'], ['a2', 't2']]`; `unavailableAgents` is `[]`.
  - `answers a task that has not reported with task: null, and a report with status, update and reportedAt only`: `t2.task` is `null`; `t1` equals `{ agentId: 'a1', agentName: 'Caveman', routineId: 't1', name: 'Project check-in', enabled: true, task: { status: 'needs-you', update: 'Queue is empty.', reportedAt: '2026-10-22T09:58:00.000Z' } }`; `JSON.stringify(body)` contains neither `ASK-TEXT` nor `NOTES-TEXT`.
  - `returns the other agents when one agent cannot be read, and names the one it could not`: `failures.a2 = new Error('connection terminated unexpectedly')` → 200, only a1's task, `unavailableAgents` `[{ agentId: 'a2', agentName: 'Juniper' }]`, and `vi.spyOn(initCtx.logger, 'warn')` (restored in `finally`) saw `('workspace_tasks_read_failed', { agentId: 'a2', error: expect.stringContaining('connection terminated') })`.
  - `counts a refusal for one agent as that agent being unavailable`: `failures.a2 = new PluginError({ code: 'forbidden', plugin: 'agents', message: 'no' })` → same answer (decisions row 7).
  - `never reads an agent the caller cannot see, and reads each agent as the caller`: `rosters.bob = [{ id: 'a3', displayName: 'Quill' }]` with a task on a3; viewer alice → no recorded call has `input.agentId === 'a3'`, every call has `userId === 'alice'` and `agentId === input.agentId`, and nothing from a3 is in the body.
  - `on a team agent, lists only the tasks the caller owns`: `rosters.alice` and `rosters.bob` are `[{ id: 'team-a', displayName: 'Support' }]`, `managers['team-a'] = ['alice']`; rows `tA` (owner alice, on-track), `tB` (owner bob, off-track, update `'BOB-UPDATE'`), `tC` (owner alice, no report). Viewer alice → routine ids `['tA', 'tC']`, and the body has no `BOB-UPDATE`.
  - `lists a reported task whose owner can no longer manage routines, but not a never-reported one (decisions row 2)`: same world, viewer bob owning `tB` (reported) and `tD` (no report) → `['tB']`.
  - `caps a stored update to one line of 500 characters`: a report update of `'x'.repeat(600)` comes back with `[...update].length === ROUTINE_REPORT_UPDATE_MAX_CHARS` and ending in `'…'`; another of `'first line\nsecond line'` comes back `'first line second line'`. (Stored rows aren't re-checked, TASK-913, and the view schema has no cap.)
  - `see it on Tasks: a check-in's report puts its task under its group (PR 1 canary)`: `RoutineViewSchema.parse(routineView(row, 'alice', true))` succeeds for the fixture row; through the route, `groupTasks(body.tasks).groups.find(g => g.group === 'off-track')!.rows[0]` has `routineId 't1'` and `task.update` `'Two invoices are three days old.'`.
  - `401s without a session and reads nothing`: viewer null → 401 `{ error: 'unauthenticated' }`; no roster call.
  - `answers an empty list when this deployment has no routines`: `routines:list` not registered → 200 `{ tasks: [], unavailableAgents: [] }`.
  - `takes no agent or routine from the request`: a request with `params { agentId: 'a3' }` and `query { agentid: 'a3', routineid: 'x' }` answers the same body as a bare one, and nothing reads a3.
  - `keeps a paused task, marked not enabled`: `t1` with `enabled: false` comes back with `enabled: false`.
  - In `routes-workspace-registration.test.ts`: `expect(routes).toContain('GET /api/workspace/tasks')`. In `plugin.test.ts`: the new degradation string.

- [ ] **Step 2: Run them and watch them fail:** `pnpm --filter @ax/channel-web test src/__tests__/server/routes-workspace-tasks.test.ts src/__tests__/server/routes-workspace-registration.test.ts src/__tests__/server/plugin.test.ts`.

- [ ] **Step 3: Implement** the route, the header comments and the `plugin.ts` text per "The route".

- [ ] **Step 4: Run the three files again (PASS), then** `pnpm --filter @ax/channel-web test src/__tests__/server` and `pnpm --filter @ax/channel-web exec tsc --build`.

- [ ] **Step 5: Run `security-checklist`** over this task's diff and keep its note for the PR. It covers: prompt injection (the update is agent-written and may carry text from a ticket; it leaves only fenced and capped, and nothing interprets it; ask and agent notes never leave), authorization (the roster is the ACL, `routines:list` re-checks each agent for the caller, the list is owner-only, no client-supplied ids), sandbox (none touched) and supply chain (no new dependency).

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/server/routes-workspace.ts packages/channel-web/src/server/plugin.ts packages/channel-web/src/__tests__/server/routes-workspace-tasks.test.ts packages/channel-web/src/__tests__/server/routes-workspace-registration.test.ts packages/channel-web/src/__tests__/server/plugin.test.ts
git commit -m "Agent Tasks: GET /api/workspace/tasks lists the caller's tasks (TASK-909)"
```

---

### Task 3: The page's read: `workspaceApi.tasks()` and `useTasks()` [tier: integration]

**Files:**
- Modify: `lib/workspace-api.ts` (the method next to `decisions`, ~798; guards next to `isDecisionRecord`)
- Create: `lib/workspace-tasks.ts`
- Test: `lib/__tests__/workspace-api-tasks.test.ts`, `lib/__tests__/workspace-tasks.test.ts`

**Interfaces:**
- Consumes: `TaskRow`, `TasksResponse`, `UnavailableAgent` (Task 1).
- Produces:

```ts
// lib/workspace-api.ts
workspaceApi.tasks(): Promise<TasksResponse>
// lib/workspace-tasks.ts
export type TasksReadError = 'expired' | 'failed';
export type TasksState =
  | { kind: 'loading' }
  | { kind: 'ready'; tasks: TaskRow[]; unavailableAgents: UnavailableAgent[]; refreshing: boolean }
  | { kind: 'failed'; error: TasksReadError };
export function useTasks(): { state: TasksState; retry: () => void };
```

- `tasks` is `req<unknown>('/tasks')` then `checkedRead<TasksResponse>('/tasks', body, isTasksResponse)`, the `decisions` pattern. The guard checks `tasks` and `unavailableAgents` are arrays and every element: string `agentId`, `agentName`, `routineId`, `name`; boolean `enabled`; `task` null or a record with `status` in `ROUTINE_REPORT_STATUSES` (runtime import from `@ax/routines-contract`, as `lib/routines.ts` does), `update` string or null, string `reportedAt`. Unavailable agents: string `agentId` and `agentName`.
- `useTasks` fetches on mount. `retry()` moves `ready` to `{ ...state, refreshing: true }` and anything else to `{ kind: 'loading' }`, then fetches. A `useRef` request counter drops any answer that isn't the newest request's, and the unmount cleanup bumps it. On a throw: `logRequestFailure(e, 'workspace-tasks')` (`lib/http.ts`), then `error: toReadOutcome(e) === 'expired' ? 'expired' : 'failed'` (`lib/read-register.ts`; the list route never answers 403 or 404 itself, decisions row 10).

- [ ] **Step 1: Write the failing tests.** `workspace-api-tasks.test.ts` copies `respondWith` from `workspace-api-decision-shape.test.ts:23-31`:
  - `reads the page from GET /api/workspace/tasks`: resolves the body; `fetch` was called with `'/api/workspace/tasks'` and method `GET`.
  - `refuses a body without unavailableAgents` → rejects with `WorkspaceShapeError`.
  - `refuses a row whose status it does not know` (`status: 'stuck'`) → `WorkspaceShapeError`.
  - `carries the status of a failed read`: `{ ok: false, status: 500 }` → rejects with a `WorkspaceApiError` whose `status` is 500.

  `workspace-tasks.test.ts` mocks the module like `ActivityFeedLoadMore.test.tsx:35-45` (`{ ...actual, workspaceApi: { tasks: vi.fn() } }`), uses `renderHook` and `waitFor` from `@testing-library/react`, and a small deferred-promise helper:
  - `starts loading, then holds the page`.
  - `calls a 401 expired and anything else failed`: `new WorkspaceApiError('/tasks', 401)` → `expired`; 500 and 404 → `failed`.
  - `retries from a failure through loading`.
  - `refreshes in place, keeping the rows on screen`: after `ready`, `retry()` gives `ready` with the same rows and `refreshing: true`, then the new rows with `refreshing: false`.
  - `drops an older answer that lands after a newer one`: call 1 deferred, `retry()`, call 2 deferred; resolve call 2 with B, then call 1 with A → state holds B.

- [ ] **Step 2: Run them and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-api-tasks.test.ts src/lib/__tests__/workspace-tasks.test.ts`.

- [ ] **Step 3: Implement** the method and guards in `workspace-api.ts` and the hook in `workspace-tasks.ts`.

- [ ] **Step 4: Run them (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/workspace-api.ts packages/channel-web/src/lib/workspace-tasks.ts packages/channel-web/src/lib/__tests__/workspace-api-tasks.test.ts packages/channel-web/src/lib/__tests__/workspace-tasks.test.ts
git commit -m "Agent Tasks: the Tasks page reads its list (TASK-909)"
```

---

### Task 4: Task marks on `StateDot` [tier: mechanical]

**Files:**
- Modify: `components/workspace/bits.tsx:93-158` (the shape comment, `STATE_SHAPE`, `StateDot`)
- Modify: `components/workspace/__tests__/StateDotSlot.test.tsx:69-71`, plus two tests
- Modify: `__tests__/theme-contrast.test.ts:1377-1388` (the exact dot list) and `:1398` (the quiet-dot list)

**Interfaces:**
- Consumes: `type TaskGroup` from `@/lib/task-groups` (Task 1).
- Produces: `export type DotState = AgentRunState | 'held' | TaskGroup;` `STATE_SHAPE: Record<DotState, string>`; `StateDot({ state: DotState; className?: string })`. `STATE_WORDS` and `stateWord` are unchanged.

Geometry: pull the five shape strings into module constants so a task mark and the agent mark it means share one string: `needs-you` = `waiting`'s diamond, `off-track` = `stopped`'s square, `on-track` = `working`'s circle, `no-update` = `resting`'s ring, and `paused` = `'h-[3px] w-[8px] rounded-full'` (resting's shape before Design 5, #829). Fills, appended after the `stopped` arm in exactly this order and form:

```ts
state === 'needs-you' && 'bg-warning',
state === 'off-track' && 'bg-destructive',
state === 'on-track' && 'bg-primary',
state === 'no-update' && 'border-state-quiet',
state === 'paused' && 'bg-state-quiet',
```

Rule 5: line 98 says `resting ▬ dash`, but Design 5 made resting a hollow ring, and `StateDotSlot.test.tsx` already pins the ring. Replace that line with these two (exact):

```
 *   working ● circle · waiting/held ◆ diamond · resting ○ hollow ring · stopped ■ square
 *   Task marks (TASK-909) reuse them: needs-you ◆, off-track ■, on-track ●, no-update ○, and paused ▬ dash.
```

- [ ] **Step 1: Write the failing tests** in `StateDotSlot.test.tsx`:
  - Update `covers every state the dot can draw` to `['held', 'needs-you', 'no-update', 'off-track', 'on-track', 'paused', 'resting', 'stopped', 'waiting', 'working']`.
  - `draws a task mark like the agent mark it means (TASK-909)`: `STATE_SHAPE['needs-you'] === STATE_SHAPE.waiting`, `'off-track'` equals `stopped`, `'on-track'` equals `working`, `'no-update'` equals `resting`; rendered, `needs-you` has `bg-warning`, `off-track` `bg-destructive`, `on-track` `bg-primary`, and `no-update` has `border-state-quiet` and no `bg-` class.
  - `draws paused as a dash no agent mark uses`: `widthPx(STATE_SHAPE.paused)` is 8, it contains `h-[3px]`, it differs from every agent shape, and the rendered dot has `bg-state-quiet`.

  In `theme-contrast.test.ts`, the exact list gains `'StateDot.needs-you', 'StateDot.off-track', 'StateDot.on-track', 'StateDot.no-update', 'StateDot.paused'` between `'StateDot.stopped'` and `'StatusDot.empty'`, and the quiet-dot list at :1398 gains `'StateDot.no-update'` and `'StateDot.paused'`.

- [ ] **Step 2: Run them and watch them fail:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/StateDotSlot.test.tsx src/__tests__/theme-contrast.test.ts`.

- [ ] **Step 3: Implement** in `bits.tsx`.

- [ ] **Step 4: Run them (PASS), plus** `src/components/workspace/__tests__/WorkspaceSidebarState.test.tsx` (the roster's own shape tests), then `pnpm --filter @ax/channel-web exec tsc --build`. Every new fill must also clear 3:1 on every dot backdrop in both themes; they reuse measured tokens, so the per-dot rows pass. If one doesn't, the token is wrong, not the test.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/workspace/bits.tsx packages/channel-web/src/components/workspace/__tests__/StateDotSlot.test.tsx packages/channel-web/src/__tests__/theme-contrast.test.ts
git commit -m "Agent Tasks: StateDot draws a task's status (TASK-909)"
```

---

### Task 5: The Tasks page [tier: sensitive] (security-checklist)

**Files:**
- Modify: `lib/workspace-time.ts` (append `timeAgo`); test `lib/__tests__/workspace-time.test.ts`
- Create: `components/workspace/TasksPage.tsx`; test `components/workspace/__tests__/TasksPage.test.tsx`

**Interfaces:**
- Consumes: `useTasks` (Task 3); `groupTasks`, `ACTIVE_TASK_GROUPS`, `TaskGroup` (Task 1); `StateDot`, `StateDotSlot` (Task 4); `TaskRow` (Task 1); `WorkspaceHeader`; `HTTP_SESSION_ENDED` (`lib/http.ts`).
- Produces: `export function TasksPage({ leading }: { leading?: React.ReactNode })`, which draws its own `WorkspaceHeader`; `export function timeAgo(iso: string, now: Date = new Date()): string | null`.

`timeAgo`: under a minute, a future instant included → `'just now'`; under an hour → `` `${m} min ago` ``; under 24 hours → `` `${h} hr ago` ``; otherwise `relativeDay(iso, now)`; null on an instant it can't read. Whole minutes and hours, floored.

**The page** (shadcn primitives and semantic tokens only; `gap-*`, not `space-*`; icons in buttons use `data-icon`):
- `WorkspaceHeader title="Tasks" subtitle="What your agents are looking after"` with `leading`, then the old Projects page's frame: `flex-1 overflow-y-auto` around `mx-auto flex w-full max-w-[900px] flex-col gap-4 px-6 pb-6`.
- `loading`: a centred `Spinner`.
- `failed`: the load-failure card, borrowed from `git show e011da3:packages/channel-web/src/components/workspace/ProjectLoadFailure.tsx` without its "All projects" button. `failed` → `Alert variant="destructive"` with the sentence and a secondary small "Try again" that calls `retry`; `expired` → `Alert` (default) with `HTTP_SESSION_ENDED` and no button.
- `ready`:
  - When `unavailableAgents` isn't empty, a destructive `Alert` with no title (it sits over content the page can still see, `lib/read-register.ts`): the partial sentence and "Try again", disabled while `refreshing`. Names joined with `new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })`.
  - When there are no rows and no unavailable agents, `Empty` (`EmptyHeader`, `EmptyMedia variant="icon"` holding lucide `ListChecks`, `EmptyTitle`, `EmptyDescription`), as the old `ProjectsPage` drew its empty state, with no button.
  - One `<section aria-labelledby>` per group from `groupTasks`: an `h2` holding `StateDotSlot` and `StateDot state={group}`, the group's word, a space, and a muted `· {count}` (so its text reads `Needs you · 2`), then a `<ul>` of rows.
  - Paused: when `paused` isn't empty, a `Collapsible` (closed at first) whose `CollapsibleTrigger asChild` is a ghost small `Button` holding `StateDotSlot`/`StateDot state="paused"`, the toggle words and a `ChevronDown` (`data-icon="inline-end"`, rotated when open, as the sidebar roster does). `CollapsibleContent` holds the same row list.
- A row (`<li>`, not a link): the task name (`font-medium`, `truncate`, `title={row.name}`); the meta line in `text-muted-foreground`, `` `${row.agentName} · checked ${ago}` `` when `row.task` is set and `timeAgo` reads its `reportedAt`, else `row.agentName` alone; then, when `row.task?.update` is a string, the update in a `line-clamp-2` paragraph with `title` set to that string.
- The clock: hold `now` in state and `setInterval` it every `30_000` ms while any row (paused ones included) has a report, cleared on unmount (the `LearnedInChat` pattern).

**Copy (exact):**

| Where | Text |
|---|---|
| Title, subtitle | `Tasks` · `What your agents are looking after` |
| Group words (`TASK_GROUP_LABELS`) | `Needs you` · `Off track` · `On track` · `No update yet` |
| Group count | `· {n}` |
| Paused toggle | `Show 1 paused task` / `Show {n} paused tasks`, and once open `Hide paused tasks` |
| Empty title, description | `No tasks yet` · `Ask an agent in chat to keep an eye on something for you, like an inbox or a queue.` |
| Partial failure | `We couldn’t load tasks from {names} just now, so some may be missing.` + `Try again` |
| Whole page failed | `We couldn’t load your tasks just now. Nothing was lost.` + `Try again` |
| Session ended | `HTTP_SESSION_ENDED`, no button |
| Row meta | `{agent} · checked {timeAgo}`, or `{agent}` alone |

- [ ] **Step 1: Write the failing `timeAgo` tests** in `workspace-time.test.ts`, with `now = new Date(2026, 9, 22, 12, 0)` (local time):
  - `says just now under a minute, and for a clock a little ahead`: 30 s ago and 10 s ahead → `'just now'`.
  - `counts minutes, then hours`: 4 min → `'4 min ago'`; 59 min → `'59 min ago'`; 60 min → `'1 hr ago'`; 23 h 59 min → `'23 hr ago'`.
  - `hands a day or more to relativeDay`: `new Date(2026, 9, 21, 9, 0)` → `'yesterday'`; `new Date(2026, 9, 18, 12, 0)` → `'4 days ago'`.
  - `answers null for an instant it cannot read`.

- [ ] **Step 2: Write the failing page tests** in `TasksPage.test.tsx`: mock `@/lib/workspace-api` with `{ ...actual, workspaceApi: { tasks: vi.fn() } }`, use `fireEvent` (user-event isn't installed), and build rows with a local helper:
  - `shows the title and subtitle while it loads`: `tasks` pending → heading level 1 `Tasks`, the subtitle text.
  - `groups tasks under Needs you, Off track, On track and No update yet, with counts, hiding empty groups`: two needs-you, one on-track, one never-reported → the level-2 headings read `Needs you · 2`, `On track · 1`, `No update yet · 1`, in that order, with no `Off track`.
  - `collapses paused tasks behind a toggle that counts them`: with one active needs-you row and one paused row (also a needs-you report), the heading reads `Needs you · 1`, the paused row isn't in the document, and a button `Show 1 paused task` has `aria-expanded="false"`; clicking shows the row and renames the button `Hide paused tasks`; two paused rows read `Show 2 paused tasks`.
  - `teaches the one way in when there are no tasks`: no rows, no unavailable agents → `No tasks yet` and the description; no level-2 headings.
  - `says which agents could not be read, and never claims the list is empty`: no rows and `[Juniper]` → `We couldn’t load tasks from Juniper just now, so some may be missing.` and no `No tasks yet`; rows with `[Juniper, Quill]` → `…from Juniper and Quill…` with the rows drawn; Try again calls `tasks` a second time and is disabled while that call is pending.
  - `draws an update with markdown or HTML as plain text`: update `'**Done** <b>3</b> [docs](https://x.test) <img src=x onerror=alert(1)>'` → its paragraph's `textContent` is exactly that string, and `container.querySelector('ul strong, ul b, ul a, ul img')` is null.
  - `keeps the whole name and update in a title`.
  - `dates a report from when it was written, and a never-reported task not at all`: `vi.useFakeTimers({ shouldAdvanceTime: true })` and `vi.setSystemTime(NOW)` before render (`vi.useRealTimers()` in `afterEach`); a report 4 minutes before `NOW` → `Caveman · checked 4 min ago`; a never-reported row's meta line is exactly `Juniper`; `act(() => vi.advanceTimersByTime(120_000))` → `Caveman · checked 6 min ago`.
  - `offers Try again when the page could not load`: `tasks` rejects with `new WorkspaceApiError('/tasks', 500)` → the whole-page sentence; Try again → rows.
  - `asks to sign in again when the session ended, with nothing to retry`: 401 → `HTTP_SESSION_ENDED` and no `Try again` button.

- [ ] **Step 3: Run both files and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-time.test.ts src/components/workspace/__tests__/TasksPage.test.tsx`.

- [ ] **Step 4: Implement** `timeAgo`, then `TasksPage.tsx`.

- [ ] **Step 5: Run them (PASS), plus** `src/components/workspace/__tests__/no-fixtures.test.ts` and `src/__tests__/theme-contrast.test.ts` (both scan the new file), then `pnpm --filter @ax/channel-web exec tsc --build`.

- [ ] **Step 6: Run `security-checklist`** over the page and add to Task 2's note: agent-written text reaches the person as React text only (no `dangerouslySetInnerHTML`, no markdown component), fenced and capped on the server, clamped by CSS, its `title` the fenced value; nothing on the page feeds it to a model.

- [ ] **Step 7: Commit**

```bash
git add packages/channel-web/src/lib/workspace-time.ts packages/channel-web/src/lib/__tests__/workspace-time.test.ts packages/channel-web/src/components/workspace/TasksPage.tsx packages/channel-web/src/components/workspace/__tests__/TasksPage.test.tsx
git commit -m "Agent Tasks: the Tasks page groups tasks by what needs you (TASK-909)"
```

---

### Task 6: The Tasks route, sidebar row and shell [tier: integration]

**Files:**
- Modify: `lib/workspace-route.ts` (the union, `parseWorkspaceRoute`, `workspaceRoutePath`); test `lib/__tests__/workspace-route.test.ts`
- Modify: `components/workspace/WorkspaceSidebar.tsx` (`Props`, both nav branches)
- Modify: `components/workspace/WorkspaceShell.tsx` (header comment :10-14, `navProps` :802-814, the main render after the Today block)
- Modify: `components/workspace/__tests__/WorkspaceSidebarState.test.tsx`, `components/workspace/__tests__/WorkspaceShellRouting.test.tsx`

**Interfaces:**
- Consumes: `TasksPage` (Task 5).
- Produces: `WorkspaceRoute` gains `{ kind: 'tasks' }` at `/workspace/tasks`; `WorkspaceSidebarNav`'s `route` is `'today' | 'tasks' | 'activity' | 'agent'` and it takes a required `onTasks: () => void`.

Spec:
- Route: `if (section === 'tasks') return { kind: 'tasks' };` next to the activity line (a trailing segment is dropped, as everywhere), and in `workspaceRoutePath` a `'tasks'` case returning ``${WORKSPACE_ROOT_PATH}/tasks``.
- Sidebar: lucide `ListChecks`. Collapsed: `iconRow('Tasks', ListChecks, onTasks, route === 'tasks')` between Today and Activity. Expanded: a `variant="navigation"` `Button` with `data-active={route === 'tasks'}`, `<ListChecks data-icon="inline-start" aria-hidden="true" />` and the word `Tasks`, between Today and Activity, with no badge or count. Activity stays (design §3.7, until PR 4).
- Shell: `onTasks: () => navigate({ kind: 'tasks' })` in `navProps`; `{route.kind === 'tasks' && <TasksPage leading={navTrigger} />}`. The comment at :10 becomes "Views are addressable: `/workspace`, `/workspace/tasks`, `/workspace/activity`, and `/workspace/agents/<id>[/<tab>]`."

- [ ] **Step 1: Write the failing tests:**
  - `workspace-route.test.ts`: `reads the tasks path` (`/workspace/tasks` and `/workspace/tasks/extra` → `{ kind: 'tasks' }`); `writes tasks` (→ `/workspace/tasks`); add `{ kind: 'tasks' }` to the round-trip `ROUTES`; add `expect(routeAgentId({ kind: 'tasks' })).toBeNull()` to the existing "names the open agent" test.
  - `WorkspaceSidebarState.test.tsx`: `renderRoster` takes overrides (`Partial<React.ComponentProps<typeof WorkspaceSidebarNav>>`) and passes `onTasks`. A new `describe('the Tasks row (TASK-909)')`: `lists Tasks right under Today, above Activity, and opens it` (the first three buttons inside `navigation` `Workspace` are `Today`, `Tasks`, `Activity`; clicking `Tasks` calls `onTasks` once); `marks Tasks active on the Tasks page` (`route="tasks"` → `Tasks` has `data-active="true"`, `Today` and `Activity` have `"false"`; assert with `toHaveAttribute`, since `"false"` is truthy); `puts Tasks between Today and Activity in the icon rail` (`collapsed` → inside `navigation` `Workspace`, the buttons' `aria-label`s start `Today`, `Tasks`, `Activity`, `Agents`; `IconTooltip` brings its own provider).
  - `WorkspaceShellRouting.test.tsx`: add `tasks: vi.fn()` to the mocked `workspaceApi`, `const tasksMock = vi.mocked(workspaceApi.tasks)`, and in `beforeEach` `tasksMock.mockReset(); tasksMock.mockResolvedValue({ tasks: [], unavailableAgents: [] });`. New tests: `opens Tasks from its own URL, with its sidebar row active` (`renderAt('/workspace/tasks')` → `findByRole('heading', { name: 'Tasks' })`; `getByRole('button', { name: 'Tasks' })` has `data-active="true"`, `Today` and `Activity` `"false"`; `tasksMock` called once) and `the Tasks row leaves an address behind` (`renderAt('/workspace')`, click `Tasks` → `window.location.pathname` is `/workspace/tasks` and the heading shows).

- [ ] **Step 2: Run them and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-route.test.ts src/components/workspace/__tests__/WorkspaceSidebarState.test.tsx src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx`.

- [ ] **Step 3: Implement** the route, the sidebar rows and the shell wiring.

- [ ] **Step 4: Run them (PASS), then the whole package and the type-check:** `pnpm --filter @ax/channel-web test` and `pnpm --filter @ax/channel-web exec tsc --build`. The 13 other shell tests mock `workspaceApi` as a closed object and must still pass untouched, which they do only while `useTasks` is called from inside `TasksPage`.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/workspace-route.ts packages/channel-web/src/lib/__tests__/workspace-route.test.ts packages/channel-web/src/components/workspace/WorkspaceSidebar.tsx packages/channel-web/src/components/workspace/WorkspaceShell.tsx packages/channel-web/src/components/workspace/__tests__/WorkspaceSidebarState.test.tsx packages/channel-web/src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx
git commit -m "Agent Tasks: Tasks in the sidebar, right under Today (TASK-909)"
```

---

## Card acceptance → tests

| Card acceptance | Test |
|---|---|
| Only `stay-on-top` tasks, across two agents | T2 `lists only tasks, across two agents, in roster order` |
| No report → `task: null` | T2 `answers a task that has not reported with task: null…` |
| One agent's failure → others plus `unavailableAgents` | T2 `returns the other agents when one agent cannot be read…`, `counts a refusal…` |
| A user who can't see an agent never gets its tasks | T2 `never reads an agent the caller cannot see…`, `on a team agent, lists only the tasks the caller owns` |
| Model-written `update`/`ask` capped | T2 `caps a stored update…`; the ask never leaves (`answers a task that has not reported…` checks the body) |
| Grouping order and counts; paused collapsed; empty state; partial-failure note; literal text | T5 page tests |
| `/workspace/tasks` round-trips; sidebar row active | T6 `workspace-route.test.ts` round-trip; `WorkspaceShellRouting.test.tsx` `opens Tasks from its own URL, with its sidebar row active` |
| "See it on Tasks" canary half | T2 `see it on Tasks: a check-in's report puts its task under its group (PR 1 canary)` |

## Before the PR

- Gates: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
- Boundary review: no hook is added or changed. One new HTTP route inside channel-web that reads `routines:list`; its wire type lives in `packages/channel-web/src/lib/workspace-types.ts`.
- Security note: from Tasks 2 and 5.
- Handoff: everything stayed inside `packages/channel-web`, plus the design §3.6 paragraph. List the four departures from the card (decisions rows 2–5) and the accepted gap in row 2.
