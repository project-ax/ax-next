# TASK-933 "Today shows what tasks need from you" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today becomes the one inbox for tasks too. A task that needs the person (its agent said Needs you, three check-ins in a row left no update, or the host paused it after five) gets its own block on Today, with the ask or the reason, Reply (inline) and Open task. The approvals raised during that task's check-ins sit under it. The sidebar badge, the Needs you tab and Today's headline are one count. Plus the two TASK-932 follow-ups: a malformed `checkIn` no longer fails the queue read, and the undo poll no longer asks routines for a label.

**Architecture:** channel-web only. `GET /api/workspace/tasks` gains the agent's `ask` (fenced). `useTasks()` moves from `TasksPage` into `WorkspaceShell`, so one read feeds Today, the badge and the Tasks page; the shell re-reads it on entering Today or Tasks and after a reply sent from Today. Two pure modules decide what Today shows: `todayTasks` (`lib/task-groups.ts`, which tasks need you) and `lib/today-queue.ts` (`waitingOnYou`, the one count, and `todayQueue`, the groups). `TodayTaskGroup` draws one task's block; `TodayView` lays out grants, then task groups, then the remaining approvals. On the decisions path, the host labels only OPEN rows with their task, and the client queue keeps the label a row already had when a later answer comes back without one. No hook, migration, dependency, shadcn component or `pnpm-lock.yaml` change.

**Tech Stack:** TypeScript, React 19, shadcn (radix) primitives, Tailwind v3 semantic tokens, vitest + testing-library (`fireEvent`, no user-event). The server route tests use stubs on a real `HookBus` (no Docker).

**Spec:** the TASK-933 card body (dispatch file) and `docs/plans/2026-10-20-agent-tasks-design.md` §3.5 (the Today mock), §3.6, §9 ("Approvals pile up"), §12 PR 2. Decisions: `.claude/memory/decisions/2026-10-23-TASK-933.md`, rows counted from the first data row. Read rows 2–13 before Task 2: each settles something the card left open, or departs from it.

## Global Constraints

- **channel-web only.** Every path below is under `packages/channel-web/src/` unless it starts with `docs/`. No change to `@ax/routines`, `@ax/routines-contract`, `@ax/decisions` or any hook.
- **One file at a time:** `pnpm --filter @ax/channel-web test <path> [<path>…]`. The filter goes before the script, and there is **no `--`**: with `--` vitest runs the whole package (`.claude/memory/mistakes/2026-10-20-TASK-904.md`). The dispatch note's `test -- <file>` form is wrong. Check the file count in vitest's summary line.
- **Type checks:** channel-web's `tsc` checks its test files. After every task run `pnpm --filter @ax/channel-web exec tsc --build` (exit 0).
- **No Docker** for any file this plan touches. A whole-package run needs it for six Postgres files; when the daemon is down use the no-Docker command in `docs/plans/2026-10-23-task-932-approvals-name-their-task-plan.md` (Global Constraints, "channel-web without Docker"). It doesn't replace the final gate.
- **Exact copy.** Apostrophes are U+2019 (’), the separator is U+00B7 (·). `ux-design` may adjust layout and spacing, not the words this plan pins.
- **Agent-written text** (a task's `ask` and `update`) is drawn only as React text children: never markdown, never `dangerouslySetInnerHTML`. Clamped text keeps the whole fenced value in a `title` (TASK-436).
- **shadcn + semantic tokens only** (invariant 6): `Button` (incl. `asChild` around `<a>`), `Collapsible`, `Alert`, `Separator`, all installed. `flex`/`gap-*`, never `space-y-*`; icons in buttons use `data-icon`, no sizing classes; `cn()` for conditional classes.
- **Phone width 390 px:** nothing new may scroll horizontally. Every new container is `min-w-0`, long text `truncate` (with `title`) or `break-words`, action rows `flex-wrap`, no fixed widths. jsdom does no layout, so do not write class-name tests for this (`responsive-shell.test.tsx`'s header explains why such a test cannot fail).
- **TDD:** run each new test against the unchanged code and watch it fail before changing the source.
- **Baseline (measured at 24414c756):** these pass: `TodayView`, `TasksPage`, `WorkspaceShell`, `WorkspaceShellRouting`, `consent-focus`, `TaskReplyBox` (components/workspace), `workspace-decision-queue`, `workspace-api-decision-shape`, `workspace-api-tasks`, `task-groups`, `workspace-tasks`, `server/routes-workspace-tasks`, `server/routes-workspace-decision-checkins` (13 files, 307 tests); the 11 other shell-mounting files in Task 1 plus `golden-path`, `auth-gate`, `post-boot-401`, `boot` (15 files, 111 tests); and `pnpm --filter @ax/channel-web exec tsc --build`. A red one after your change is yours.
- **Worktree shell:** run git commands one at a time (no `&&` chains); spell paths out literally; never name a zsh variable `path` (`.claude/memory/mistakes/2026-10-22-TASK-912.md`).
- **Order:** run the tasks one at a time, in number order, in one worktree.
- **Memory:** shards only (`scripts/memory-write-target.sh --shard <kind> TASK-933`). Never touch a root `.claude/memory/*.md`, never add a `Memory-Rewrite:` trailer.

## Review Focus

1. **A failed, expired or partial tasks read never lets Today say "Nothing is waiting on you."**, including while a Try again or a re-read on entering Today is still in flight. Pinned in Task 7 (`tasksForToday` with `retryingAfter`) and Task 9 (`never says nothing is waiting when the tasks read failed…`, `names the agents it couldn't check…`, `while Try again is reading…`).
2. **Each approval counts once, a group there only for its approvals adds nothing, and the badge counts tasks on every route, not only where Today is mounted** (memory `patterns.md` 2026-09-16 TASK-351: a count is only pinned where its inputs differ). Pinned in Task 4 (`waitingOnYou`) and Task 9 (shell counts, and the badge on an agent's page).
3. **An answered approval stays where it was, inside its task's block, with focus on its receipt**, even when the answer comes back without its task label. Pinned in Task 6 (the queue keeps the label) and Task 9 (`consent-focus` cases).
4. **A miss never hides a pending ask** (`.claude/memory/mistakes/2026-10-23-TASK-930.md`). Pinned in Task 8 (`three misses don't hide a pending ask`).
5. **The agent's words render as literal text, and only the task's owner ever receives them.** Pinned in Task 2 (route, fenced; owner rule inherited and already pinned by TASK-909's tests) and Task 8 (`draws the agent's words as text`).

## Where this plan departs from the card

Each is a decisions row. Say so in the PR description.

- **12 test files need a `tasks` mock, not ~38** (row 2). Measured: 12 files mount the shell with a closed `workspaceApi` mock, plus `WorkspaceShellRouting.test.tsx`, which already has one (TASK-909's "13", decisions row 10, was right). The ~38 counted every file that mocks `workspaceApi`; most never mount the shell. No shared mock factory exists, so each file mirrors how it mocks `grants` (Task 1).
- **`TaskReplyBox` already takes `canStart`** (TASK-931's props row). Today passes `canStart={false}`, so its helper never promises a check-in Today can't vouch for (`TaskRow` has no permissions); the server's answer words what happened ("Sent. {agent} started checking in.") (row 8).
- **No `onOpenTask` prop:** `TodayView` already takes `onNavigate` (TASK-932), and Open task is a `routeLinkProps` link (row 8).
- **The partial-failure sentence lives in the tasks `Alert` (destructive, with Try again), not a muted line,** and a partial read also stops the empty headline (row 9). `lib/read-register.ts`: a failed read that nothing will retry is `destructive`; TasksPage draws the same failure that way.
- **Reply also shows on an escalated or auto-paused task whose last report asked something**, under a muted "{agent} asks: …" line (row 8). TASK-930's mistake: a miss must not hide a pending ask.
- **One Open task per block:** an approval inside a task's block no longer draws TASK-932's own Open task on its expanded row; the block's heading has it, always visible (row 8).
- **A retry after a failed tasks read keeps the failure on screen until a read lands** (the loading state carries `retryingAfter`), as the grants and decisions reads already do (row 4).
- **Receipts stay where their question was:** always inside a task's block, and in the plain list too if Task 9's focus test shows the old open-then-receipts split remounts the row (row 10).
- **Follow-up 1:** every decision leaving `workspaceApi` reads a malformed `checkIn` as `null` (row 11).
- **Follow-up 2:** the host looks a label up only for an open row, and the client keeps a row's label when a later answer has none (row 12).
- **Left alone on purpose:** Today's empty-state sentence (endorsed and kept verbatim by a 2026-09-16 decision, still true), a re-read from the task page's own buttons, and a tasks poll (row 13).

## Card premises, checked (at 24414c756)

- **True:** the shell computes `pending = queue.decisions.filter(isOpenDecision).length + grants.grants.length` and feeds the sidebar and the Segmented count, while `TodayView` recomputes `waiting` for the headline (`WorkspaceShell.tsx:775-776`, `TodayView.tsx:189`); `grantsError` is a headline gate plus its own `Alert` (`TodayView.tsx:198-203, 355-387`); `useTasks` is the request-counter state machine and lives in `TasksPage` (`lib/workspace-tasks.ts`, `TasksPage.tsx:69`); `taskGroup`, `missGroup` and the sort live in `lib/task-groups.ts`; `missSummary`, `AUTO_PAUSED_LINE` in `lib/task-miss.ts`; `TaskRow.noRecentUpdate { inARow, reason, at, autoPaused }`; `DecisionRow` is presentational and `renderRow` drops a decision whose agent isn't on the roster (`TodayView.tsx:251-279`); every `Decision` carries `checkIn` (TASK-932); `toTaskRows` keeps `isOwnTask` rows and `routines:list` shows `task` (and so `ask`) only to the owner; `ROUTINE_REPORT_ASK_MAX_CHARS` is 500 and already imported by the route; `decisions:list` answers open rows only (`OPEN_STATUSES`); the undo poll re-reads a row while its undo window is open (`undoSecondsLeft` needs `resolvedAt`) or while a routine approval's outcome is pending (`needsRoutineRead`: `executed`/`approved-pending-agent`, or an `agent-routines` approval awaiting delivery), so in practice resolved rows, and an open one it does read still gets its label; `GET /decisions/:id` is called by the poll and by `AgentConversation`'s Edit-first status check only; a 401 on any request latches the app to the sign-in page (`lib/http.ts:138`), so Today's expired branches are what a unit test sees.
- **Refuted or corrected:** the ~38 files, `TaskReplyBox`'s props, `onOpenTask`, the muted partial line (above). The INFERRED "a just-resolved row with `checkIn` stays in its group" holds only with Task 6: today an answer whose 1 s label lookup misses comes back with `checkIn: null`, and `useDecisionQueue` swaps it in.

## Order and file ownership

| # | Task | Tier | Touches |
|---|---|---|---|
| 1 | Shell-mounting tests answer the tasks read | mechanical | 12 test files |
| 2 | The ask crosses on the tasks list | sensitive | `server/routes-workspace.ts` (`toTaskRows`), `lib/workspace-types.ts` (`TaskRowReport`), `lib/workspace-api.ts` (`isTaskReport`), 4 test files |
| 3 | Which tasks need you | mechanical | `lib/task-groups.ts`, `task-groups.test.ts`, `routes-workspace-tasks.test.ts` |
| 4 | Today's model: one count, and the groups | integration | new `lib/today-queue.ts` + test |
| 5 | A malformed `checkIn` reads as no task | mechanical | `lib/workspace-api.ts`, `workspace-api-decision-shape.test.ts` |
| 6 | An answered approval keeps its task | sensitive | `server/routes-workspace.ts` (decision labels), `lib/workspace-types.ts` (doc), `lib/workspace-decisions.ts`, 2 test files |
| 7 | One tasks read for the whole shell | integration | `WorkspaceShell.tsx`, `TasksPage.tsx`, `lib/workspace-tasks.ts`, 3 test files |
| 8 | A task's block on Today | sensitive | new `TodayTaskGroup.tsx` + test, `TaskPage.tsx` (one `export`) |
| 9 | Today lays out tasks, and every count agrees | integration | `TodayView.tsx`, `WorkspaceShell.tsx`, 4 test files |
| 10 | The design doc | mechanical | `docs/plans/2026-10-20-agent-tasks-design.md` |

Line numbers are at 24414c756; if they drift, find the named symbol.

---

### Task 1: Shell-mounting tests answer the tasks read [tier: mechanical]

Task 7 makes the shell call `workspaceApi.tasks()` at mount. These files mount the shell with a closed `workspaceApi` mock that has no `tasks`, so they would throw. This task only adds the mock; nothing else changes and the suite stays green.

**Files (test-only):**
- Mirror an inline `grants` (the factory's `grants: vi.fn(async () => ({ grants: [] }))`):
  - `__tests__/settings-return-focus.test.tsx` (`grants` at :65)
  - `__tests__/new-agent-return-focus.test.tsx` (:61)
  - `components/workspace/__tests__/WorkspaceCreateAgentRoute.test.tsx` (:45)
  - `components/workspace/__tests__/WorkspaceGrantPresence.test.tsx` (:55)
  - `components/workspace/__tests__/WorkspaceGrantResume.test.tsx` (:49)
  - `components/workspace/__tests__/WorkspaceSettingsRoute.test.tsx` (:45)
  - `components/workspace/__tests__/WorkspaceShellAgentSwitch.test.tsx` (:40)
  - `components/workspace/__tests__/WorkspaceShellApproveContinuation.test.tsx` (:46)
- Mirror a `grants: vi.fn()` that `beforeEach` resets and fills:
  - `components/workspace/__tests__/WorkspaceShell.test.tsx` (:41, :94-95)
  - `components/workspace/__tests__/WorkspaceShellActivityScope.test.tsx` (:53, :184-185)
  - `components/workspace/__tests__/WorkspaceShellDoneTodayScope.test.tsx` (:47, :154-155)
  - `components/workspace/__tests__/responsive-shell.test.tsx` (:70, :165-166)
- No edit: `WorkspaceShellRouting.test.tsx` (already has `tasks`, :40, :157-158); `error-boundary-wiring` and `workspace-gate` (they mock the whole shell); `golden-path`, `auth-gate`, `post-boot-401`, `boot` (real `workspaceApi` over a `fetch` stub whose fallback answers a 404 or a non-tasks body, so the tasks read fails into Today's own alert from Task 9; none of them asserts on Today).

- [ ] **Step 1: Edit.** First group: right after the `grants:` line in the `vi.mock('@/lib/workspace-api', …)` factory's `workspaceApi` object, add
  `// TASK-933: the shell reads tasks at mount (Today, the badge, Tasks); nothing here has one.`
  `tasks: vi.fn(async () => ({ tasks: [], unavailableAgents: [] })),`
  Second group: add `tasks: vi.fn(),` after `grants: vi.fn(),`, `const tasksMock = vi.mocked(workspaceApi.tasks);` beside `grantsMock`, and in `beforeEach`, right after the grants pair, `tasksMock.mockReset();` and `tasksMock.mockResolvedValue({ tasks: [], unavailableAgents: [] });`. Don't add a shared factory, and don't make the shell tolerate a missing method (card).
- [ ] **Step 2: Check none was missed.** `git grep -L "tasks: vi.fn" -- packages/channel-web/src/__tests__/settings-return-focus.test.tsx packages/channel-web/src/__tests__/new-agent-return-focus.test.tsx` plus the ten `components/workspace/__tests__/` paths above prints nothing. Then `git grep -ln "<WorkspaceShell" -- 'packages/channel-web/src/**/*.test.tsx'` lists 12 files: the eleven above other than `new-agent-return-focus` (which mounts the shell through `<App />`), plus `WorkspaceShellRouting.test.tsx`.
- [ ] **Step 3: Run** the 12 files (one command, all paths): all pass, same counts as before. Then `tsc --build`.
- [ ] **Step 4: Commit:** `test(channel-web): shell-mounting tests answer the tasks read (TASK-933)`

### Task 2: The ask crosses on the tasks list [tier: sensitive]

**Run `security-checklist`** (agent-written text crossing to the browser on a list route).

**Files:**
- Modify: `server/routes-workspace.ts` — `toTaskRows` (:3404-3428) and its doc (:3383-3403).
- Modify: `lib/workspace-types.ts` — `TaskRowReport` (:1336-1342) and its doc.
- Modify: `lib/workspace-api.ts` — `isTaskReport` (:437-445) and its doc.
- Test: `__tests__/server/routes-workspace-tasks.test.ts`, `lib/__tests__/workspace-api-tasks.test.ts`.
- Fixture fallout (tsc): `lib/__tests__/task-groups.test.ts` `report()` (:47-52) and `components/workspace/__tests__/TasksPage.test.tsx` `report()` (:35-45) gain `ask: null`.

**Interfaces (produces):**

```ts
// lib/workspace-types.ts
export interface TaskRowReport {
  status: RoutineReportStatus;
  update: string | null;
  /**
   * What the agent asked the person, or null (TASK-933: Today draws it).
   * Agent-written; the server fenced it to one line of at most
   * ROUTINE_REPORT_ASK_MAX_CHARS (500) code points, null when nothing legible survived.
   */
  ask: string | null;
  reportedAt: string;
}
```

- Route: `ask: fenceLine(view.task.ask, ROUTINE_REPORT_ASK_MAX_CHARS)`, between `update` and `reportedAt`. In the doc, "so nothing rides along that the page doesn't draw (decisions row 5): the ask and the agent's notes never leave the server." becomes "so nothing rides along that no surface draws: the agent's notes never leave the server, and the ask leaves only because Today draws it (TASK-933)."; the fencing sentence names the ask beside the name and the update, and says both the update and the ask are capped at the report writer's own limits.
- Client guard: `isTaskReport` also requires `v.ask === null || isString(v.ask)`, the same strictness as `update` (decisions row 5). Its doc says a report is drawn from four fields.

- [ ] **Step 1: Write the failing tests.**
  - `routes-workspace-tasks.test.ts`:
    - Rename `answers a task that has not reported with task: null, and a report with status, update and reportedAt only` to `answers a task that has not reported with task: null, and a report with status, update, ask and reportedAt, never the agent's notes (TASK-933)`. The expected `task` gains `ask: 'ASK-TEXT want me to draft a reply?'` (the stored `report()` default, :101). Keep `expect(wire).not.toContain('NOTES-TEXT')`; drop the `ASK-TEXT` negative.
    - New `fences the ask to one line, caps it at the writer's limit, and sends a blank one as null (TASK-933)`, shaped like the update-cap test (:414-437): three stored needs-you rows whose asks are `'y'.repeat(600)` (comes back `ROUTINE_REPORT_ASK_MAX_CHARS` code points long, ending `…`), `'first line\nsecond line'` (comes back `'first line second line'`) and `'   '` (comes back `null`). Import `ROUTINE_REPORT_ASK_MAX_CHARS` from `@ax/routines-contract`.
  - `workspace-api-tasks.test.ts`: `ROW.task` (:28) gains `ask: null`. New `accepts a report whose ask is text or null` and an `it.each` `refuses a report whose ask is %s` over `42`, `{}` and `undefined` (key absent), each rejecting with `WorkspaceShapeError`, the way the file's existing refusals do.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/__tests__/server/routes-workspace-tasks.test.ts src/lib/__tests__/workspace-api-tasks.test.ts`.
- [ ] **Step 3: Implement,** with the two fixture `report()` helpers. Run the code-point scan from the TASK-932 plan's Global Constraints on any file you wrote an escape into (none is planned).
- [ ] **Step 4: Run (PASS),** plus `src/lib/__tests__/task-groups.test.ts` and `src/components/workspace/__tests__/TasksPage.test.tsx` (unchanged behaviour), then `tsc --build`.
- [ ] **Step 5: `security-checklist`.** The ask is model output: owner-only (`taskView` shows `task` only to the routine's owner; `toTaskRows` keeps `isOwnTask` rows, pinned by TASK-909's ownership tests), fenced at the boundary to one line at the writer's cap (stored rows aren't re-checked, TASK-913), and drawn as text (Task 8). No new route, hook or authority.
- [ ] **Step 6: Commit:** `Agent Tasks: the Tasks list carries a task's ask, fenced (TASK-933)`

### Task 3: Which tasks need you [tier: mechanical]

**Files:**
- Modify: `lib/task-groups.ts` (append after `groupTasks`, :92-104).
- Test: `lib/__tests__/task-groups.test.ts` (new describe), `__tests__/server/routes-workspace-tasks.test.ts` (one canary after the PR 1 canary).

**Interfaces:**
- Consumes: `TaskRow` with `task.ask` (Task 2); this file's `taskGroup`, `missGroup`, `compareRows`.
- Produces:

```ts
/** Why a task is on Today (TASK-933). */
export type TodayTaskReason = 'asks' | 'escalated' | 'auto-paused';

/**
 * Why this task needs a person on Today, or null. In order: not enabled →
 * 'auto-paused' only when `noRecentUpdate?.autoPaused === true`, else null (a
 * task a person paused never shows, whatever its last report said); not in the
 * needs-you group (`taskGroup`) → null; three or more misses in a row
 * (`missGroup`) → 'escalated'; else 'asks' (its last report said needs-you).
 */
export function todayTaskReason(row: TaskRow): TodayTaskReason | null;

/** The rows `todayTaskReason` keeps, ordered by `compareRows` (newest `noRecentUpdate.at ?? task.reportedAt` first, then name, agent name, ids). Never mutates its input. */
export function todayTasks(rows: readonly TaskRow[]): TaskRow[];
```

- [ ] **Step 1: Write the failing tests.** `task-groups.test.ts`, `describe('todayTasks (TASK-933)')`; the `report()` helper takes an optional `ask`.
  - `puts a task whose agent asked for a person on Today`: enabled with a needs-you report → `'asks'`; the same with one and with two misses → `'asks'`.
  - `puts a task with three or more misses in a row on Today, whatever its last report`: `inARow` 3 with an on-track, an off-track and a null report, and 4 with a needs-you report → `'escalated'`.
  - `keeps an auto-paused task on Today until a person resumes it`: `enabled: false`, `noRecentUpdate { inARow: 5, autoPaused: true }`, on-track report → `'auto-paused'`.
  - `never shows a task a person paused, whatever its last report said`: `enabled: false` with a needs-you report and no misses → null; `enabled: false` with `{ inARow: 2, autoPaused: false }` → null.
  - `leaves out on track, off track, one or two misses, and never reported`: each → null, and `todayTasks` of all of them is `[]`.
  - `orders the newest first, by the miss or the report, then by name`: `Ada` (needs-you, reported 10:00), `Zed` (escalated, miss at 10:05), `Alpha` (needs-you, reported 10:05), `Dee` (auto-paused, miss at 09:00) → names `['Alpha', 'Zed', 'Ada', 'Dee']`.
  - `doesn't change the rows it is given`: the input array keeps its order.
  - `routes-workspace-tasks.test.ts`: `see it on Today: a check-in's needs-you report puts its task on Today with its ask (PR 2 canary, TASK-933)`. Stored rows `t1` (needs-you report, the default ask) and `t2` (on-track); feed the route's real answer through `todayTasks`: one row, `routineId 't1'`, `task.ask 'ASK-TEXT want me to draft a reply?'`, and `todayTaskReason` of it is `'asks'`.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/task-groups.test.ts src/__tests__/server/routes-workspace-tasks.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run (PASS),** then `tsc --build`.
- [ ] **Step 5: Commit:** `Agent Tasks: which tasks need you, for Today (TASK-933)`

### Task 4: Today's model: one count, and the groups [tier: integration]

**Files:**
- Create: `lib/today-queue.ts`, `lib/__tests__/today-queue.test.ts`.

**Interfaces:**
- Consumes: `todayTasks`, `todayTaskReason`, `TodayTaskReason` (Task 3); `isOpenDecision`, `isJustResolved`, `Decision`, `TaskRow` (`lib/workspace-types.ts`).
- Produces:

```ts
/**
 * THE one count of what's waiting on you (TASK-933): open decisions, grants and
 * tasks that need you (`todayTasks`), each once. The sidebar badge, the Needs
 * you tab and Today's headline all read this, so they can't disagree. An
 * approval under a task counts as itself; a task there only for its approvals
 * adds nothing.
 */
export function waitingOnYou(q: {
  decisions: readonly Decision[];
  grants: readonly unknown[];
  tasks: readonly TaskRow[];
}): number;

/** One task's block on Today. A task that needs you always has its row; a block there only for its approvals may not. */
export type TodayGroup = {
  /** `JSON.stringify([agentId, routineId])`: the task's address, and the React key. */
  key: string;
  agentId: string;
  routineId: string;
  /** The row's name, else the first approval's `checkIn.taskName`. */
  taskName: string;
  /** The row's agent name, else the roster's. */
  agentName: string;
  /** Its approvals, open and just resolved, in queue order. */
  decisions: Decision[];
} & (
  | { /** Why the task itself needs you. */ reason: TodayTaskReason; row: TaskRow }
  | {
      /** Here only for its approvals. */
      reason: null;
      /** The task as the tasks read has it; null when the read doesn't (failed, missed its agent, or the task is gone). */
      row: TaskRow | null;
    }
);

/** Today's tasks and approvals, arranged (TASK-933). Never mutates its inputs. */
export function todayQueue(input: {
  tasks: readonly TaskRow[];
  decisions: readonly Decision[];
  agents: readonly { id: string; name: string }[];
  now: number;
}): { groups: TodayGroup[]; loose: Decision[] };
```

Rules for `todayQueue`, in order:
1. A decision takes part only if its agent is in `agents` (the roster rule `renderRow` applies) and it is open or `isJustResolved(d, now)`, in queue order.
2. Groups for `todayTasks(tasks)` come first, in that order, with `reason = todayTaskReason(row)`.
3. A decision whose `d.checkIn ?? null` is non-null joins the group keyed `[d.agentId, checkIn.routineId]`. If there is none yet it starts one (after the task groups, in queue order) with `reason: null` and `row` = the tasks read's row for that key, or null.
4. Every other decision is `loose`, in queue order.

- [ ] **Step 1: Write the failing tests** (`today-queue.test.ts`; decisions from `decisionFixture`/`resolvedFixture` in `components/workspace/__tests__/decision-fixture.ts`, whose agent is `'scheduler'`; a local `row()` like `task-groups.test.ts`'s).
  - `describe('waitingOnYou')`:
    - `counts open decisions, grants and tasks that need you, each once`: decisions `d1` (open, no task), `d2` (open, `checkIn` → `t1`), `d3` (`resolvedFixture('executed')`); one grant; tasks `t1` needs-you, `t2` on-track, `t3` paused by a person with a needs-you report → `4`.
    - `adds nothing for a task that is there only for its approvals`: `d1` with `checkIn` → `t2` (on-track) → `1`.
  - `describe('todayQueue')`:
    - `puts a check-in's approval under its task, matched on agent and task`: task `t1` on agent `scheduler` needs you; `d1` (`scheduler`, `checkIn t1`), `d2` (agent `other`, `checkIn t1`), `d3` (no task); roster `scheduler` and `other` → groups `[scheduler/t1 with [d1], other/t1 with [d2]]`, `loose [d3]`.
    - `lists tasks that need you first, then tasks there for their approvals, in queue order`.
    - `names a task there for its approvals from the tasks read, else from its label and the roster`: with an on-track row, `taskName`/`agentName` are the row's and `row` is it; without one, `taskName` is the label's, `agentName` the roster's, `row` null.
    - `keeps a just-resolved approval in its group, in its place, and drops one resolved long ago`: `d1` open, `d2` resolved now, `d3` resolved ten minutes ago, all under `t1` → `decisions [d1, d2]`; a group whose only approval was resolved long ago doesn't exist.
    - `keeps approvals without a task, or from an older server, loose`: `checkIn: null`, and a row with the key removed (`const { checkIn: _gone, ...older } = decisionFixture(…)`, cast to `Decision`).
    - `drops an approval whose agent isn't on the roster, and makes no group for it`.
    - `doesn't change its inputs`.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/today-queue.test.ts`.
- [ ] **Step 3: Implement** with relative imports.
- [ ] **Step 4: Run (PASS),** then `tsc --build`.
- [ ] **Step 5: Commit:** `Agent Tasks: Today's one count and its task groups, as pure functions (TASK-933)`

### Task 5: A malformed `checkIn` reads as no task [tier: mechanical]

TASK-932 follow-up 1. Today one malformed label makes `isDecisionRecord` refuse the whole queue read.

**Files:**
- Modify: `lib/workspace-api.ts` — `isDecisionCheckIn`/`isDecisionRecord` (:410-429), `decisions()` (:983-994), `approveDecision`/`dismissDecision`/`undoDecision` (:1068-1070), `decision()` (:1124-1148).
- Test: `lib/__tests__/workspace-api-decision-shape.test.ts` (`describe('the checkIn label (TASK-932)')`, :325-357).

**Interfaces (produces):** no new export. Every `Decision` that leaves `workspaceApi` (`decisions()`, `decision(id)`, and the `decision` of the approve, dismiss and undo answers when it is a record) carries `checkIn` as a fresh `{ routineId, taskName }` when both are non-empty strings, else `null`. Absent, null and malformed all read `null`. `isDecisionRecord` goes back to record + `routineOperation` (drop `isDecisionCheckIn`). Private helpers:

```ts
function readableCheckIn(v: unknown): DecisionCheckIn | null;
function withReadableCheckIn(d: Decision): Decision;
function withReadableAnswer<T extends { decision: Decision | null }>(out: T): T; // untouched unless out and out.decision are records
```

No log line for a dropped label (decisions row 11).

- [ ] **Step 1: Write the failing tests** in the existing describe, renamed `the checkIn label (TASK-932, TASK-933)`. Also update `accepts a real row` (:136): the read now adds `checkIn: null`, and `toEqual` treats `null` as a value, so expect `{ decision: { ...decision, checkIn: null } }`.
  - The two `accepts…` cases also assert the read row's `checkIn`: the task, `null`, and `null` for the older-server row.
  - Replace `refuses a row whose checkIn is %s, on the list and on the single read` with `reads a row whose checkIn is %s as a row with no task, on the list and the single read (TASK-933)`, same seven cases. The page is `[{ ...ROW, checkIn }, { id: 'd2', routineOperation: null, checkIn: GOOD }]` with `GOOD = { routineId: 't1', taskName: 'Zero open support tickets' }`: `decisions()` resolves, row one's `checkIn` is `null`, row two's equals `GOOD`. Then (after `vi.restoreAllMocks()`) `decision('d1')` resolves with `checkIn: null`.
  - New `the approve, dismiss and undo answers read a malformed checkIn as null and keep a good one (TASK-933)`: for each of `approveDecision('d1')`, `dismissDecision('d1')`, `undoDecision('d1')`, `respondWith({ decision: { ...ROW, checkIn: 't1' } })` resolves with `decision.checkIn` `null`, and `respondWith({ decision: { ...ROW, checkIn: GOOD } })` with `GOOD`.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-api-decision-shape.test.ts` (the list read rejects today, and the answers pass `'t1'` through).
- [ ] **Step 3: Implement.** Doc on `readableCheckIn` (exact): "TASK-933 — a label is never worth failing the queue over: TASK-932's guard refused the whole read for one bad `checkIn`, which emptied Today. A malformed one reads as no task, which is also what the host sends when its lookup fails."
- [ ] **Step 4: Run (PASS),** plus `src/__tests__/workspace-decision-queue.test.tsx` and `src/components/workspace/__tests__/decision-renderers.test.tsx`, then `tsc --build`.
- [ ] **Step 5: Commit:** `Agent Tasks: a malformed task label reads as none instead of failing Today (TASK-933)`

### Task 6: An answered approval keeps its task [tier: sensitive]

TASK-932 follow-up 2. Today every once-a-second undo poll, and every approve and dismiss answer, asks routines for the row's label with a 1 s deadline. During a routines stall each poll waits that second, logs `_failed` then `_late_failed`, and leaves a call running to the bus's 120 s bound; a missed deadline also hands back `checkIn: null`, which would move the row out of its task's block (Task 9). The fix has two halves, decided in decisions row 12: the host labels only open rows (a receipt doesn't need a label, the same way `request` and `task` are null on receipts), and the client keeps the label a row already had.

**Files:**
- Modify: `server/routes-workspace.ts`:
  - a new module-level `carriesCheckIn` right after `checkInOf` (:2516);
  - `toWireDecision`'s `checkIn` (:2837-2843) uses it, and its comment says "only an open, unattended row";
  - `checkInsFor` (:5795-5815) skips any row `carriesCheckIn` refuses, and its doc says so;
  - `projectOwnedDecision`'s doc (:5817-5821) says that a resolved row's answer asks nothing, so the approve and dismiss answers and the undo poll's reads never wait on routines (the undo answer reopens the row, so it is labelled);
  - the header paragraph (:103-107): "which of their unattended rows" becomes "which of their open, unattended rows", and add: "A resolved row carries no label (TASK-933): the queue keeps the one it had."
- Modify: `lib/workspace-types.ts` — `Decision.checkIn`'s doc (:250-259). Replace "Every path that answers a row carries it: the list, the single read and the approve, dismiss and undo answers." with: "Only an open row carries it: the list, and the single read or the undo answer of an open row. A resolved row's answers carry null, and `useDecisionQueue` keeps the label the row already had (TASK-933). The client reads a malformed label as null (TASK-933)."
- Modify: `lib/workspace-decisions.ts` — a new module-level `keepCheckIn`; `applyServerRow` (:384-393) and `applyPolledRow` (:406-415) write `keepCheckIn(prev[at], row)`; one header paragraph after "ONE MORE THING…" (:28-39) saying a row keeps its task label through its answers and its undo window, and that a list read still decides an open row's label.
- Test: `__tests__/server/routes-workspace-decision-checkins.test.ts`, `__tests__/workspace-decision-queue.test.tsx`.

**Interfaces (produces):**

```ts
// server/routes-workspace.ts, module level
/** TASK-933 — only an OPEN, unattended row can carry its check-in label. One rule for `checkInsFor` (don't ask) and `toWireDecision` (don't carry). */
function carriesCheckIn(stored: Pick<StoredDecision, 'attendance' | 'status'>): boolean;
// attendance === 'unattended' && isOpenDecision(stored)   (isOpenDecision is already imported, :224)

// lib/workspace-decisions.ts, module level
/** TASK-933 — `next`, carrying `prev`'s task label when `next` has none. A label belongs to the row's conversation, so an answer without one (a resolved row, or a lookup that missed its deadline) must not move the row out of its task's block. A new label replaces the old. */
function keepCheckIn(prev: Decision, next: Decision): Decision;
```

`mergeReadWithReceipts` stays as it is: a list read is the server's fresh word on an open row's label (decisions row 12).

- [ ] **Step 1: Write the failing tests.**
  - `routes-workspace-decision-checkins.test.ts`:
    - Replace `the single read and the approve, dismiss and undo answers carry the same checkIn` with `an open row's single read and the undo answer carry its checkIn; a resolved row's answers carry none and ask routines nothing (TASK-933)`:
      - the list still answers `{ d1: SUPPORT, 'd-chat': null }`;
      - `decision` on `d1` (pending) and `undoDecision` on `d1` (answers pending) each carry `SUPPORT`, with one recorded lookup for `['c-checkin']`;
      - `approveDecision` and `dismissDecision` on `d1` carry `null`, with `lookups` empty;
      - the attended single read stays `null` with no lookup.
    - New `the undo poll's read of a resolved row asks routines nothing (TASK-933)`, in its own `setup()` (the `decisions:list` stub answers every stored row whatever its status, so a resolved row in the shared setup would also show up in the list assertion above): a stored `row({ id: 'd-done', conversationId: 'c-checkin', attendance: 'unattended', status: 'executed', resolvedAt: RESOLVED_AT })`, with routines knowing `c-checkin`, read with `decision` carries `null`, and `lookups` is empty.
    - `an answer waits at most a second for its label` (:556): drive `undoDecision` instead of `approveDecision`; its answer's `status` is `'pending'`.
    - `an answer whose lookup fails still answers, with checkIn null` (:645): drive `undoDecision` (200, `pending`, `null`). Then set `lookups.length = 0` (the stub records a call before it honours a configured failure) and drive `approveDecision` with the same failing lookup: 200, `executed`, `null`, `approveCalls` exactly as before, and `lookups` still empty.
    - `toWireDecision names the task only on an unattended row` (:666) becomes `…only on an open, unattended row`, plus: a resolved unattended row with a source → `null`.
  - `workspace-decision-queue.test.tsx`, `describe('useDecisionQueue — an answered row keeps its task (TASK-933)')`, with the first describe's fake-timer `beforeEach`/`afterEach`. `LABEL = { routineId: 't1', taskName: 'Zero open support tickets' }`:
    - `a poll that answers without a task keeps the row's task`: `mountWith([resolvedFixture('executed', { id: 'd1', checkIn: LABEL })])`; `readDecision` resolves `{ decision: { …that row, checkIn: null } }`; `await tick(POLL_MS)`; `readDecision` was called and `decisions[0].checkIn` equals `LABEL`.
    - `an approve answer without a task keeps the row's task`: mount `decisionFixture({ id: 'd1', checkIn: LABEL })`; `approveDecision` resolves `{ decision: resolvedFixture('executed', { id: 'd1', checkIn: null }), executed: true, path: 'host-replays', error: null, pendingUntil: null, streamReqId: null }`; approve and settle → `status` `'executed'`, `checkIn` `LABEL`.
    - `a newer task name replaces the old one`: the poll answers `{ routineId: 't1', taskName: 'Renamed' }` → that.
    - `a fresh list read still decides an open row's task`: mount with `LABEL`; the next list read answers the row with `checkIn: null`; after `refresh()` it is `null`.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/__tests__/server/routes-workspace-decision-checkins.test.ts src/__tests__/workspace-decision-queue.test.tsx`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run (PASS),** plus `src/__tests__/server/routes-workspace.test.ts`, `src/__tests__/server/routes-workspace-decisions.test.ts`, `src/components/workspace/__tests__/WorkspaceShellApproveContinuation.test.tsx` and `src/components/workspace/__tests__/TaskCheckinPage.test.tsx`, then `tsc --build`.
- [ ] **Step 5: Commit:** `Agent Tasks: an answered approval keeps its task, and the undo poll stops asking routines (TASK-933)`

### Task 7: One tasks read for the whole shell [tier: integration]

**Files:**
- Modify: `lib/workspace-tasks.ts` — header (:1-17), the loading variant of `TasksState` (:26-37), the initial state (:40) and `retry` (:78-81), and a new `tasksForToday`.
- Modify: `components/workspace/TasksPage.tsx` — header (:1-19) and `TasksPage` (:62-101).
- Modify: `components/workspace/WorkspaceShell.tsx` — imports, `useTasks()` and the entering effect (beside `useDecisionQueue`, :345-348, above the early returns), the TasksPage render (:940), and a comment on the read.
- Test: `components/workspace/__tests__/TasksPage.test.tsx` (`renderPage` :72-76 and one new case), `lib/__tests__/workspace-tasks.test.ts` (new describe), `components/workspace/__tests__/WorkspaceShellRouting.test.tsx` (new describe).

**Interfaces:**
- Consumes: `useTasks`, `TasksState`, `TasksReadError` (existing).
- Produces:

```ts
// lib/workspace-tasks.ts — the loading variant gains one required field
export type TasksState =
  | {
      kind: 'loading';
      /**
       * The failure this read is retrying after (TASK-933), null for the
       * first read. Today keeps saying it couldn't check until a read lands,
       * as the grants and decisions reads do; the Tasks page ignores it and
       * shows its spinner.
       */
      retryingAfter: TasksReadError | null;
    }
  | { kind: 'ready'; /* unchanged */ }
  | { kind: 'failed'; error: TasksReadError };
// The initial state is { kind: 'loading', retryingAfter: null }; `retry` from
// `failed` sets `retryingAfter: s.error`, from `loading` keeps the one it has.

/**
 * What Today and the badge read from the tasks state (TASK-933): the rows (the
 * last good answer), the agents it couldn't read, and whether the read failed.
 * The first load reads as no rows and no error; a retry after a failure keeps
 * that failure until a read lands. A failed refresh with rows on screen is
 * `failed` too, and keeps the rows: they may be out of date.
 */
export function tasksForToday(state: TasksState): {
  tasks: TaskRow[];
  unavailableAgents: UnavailableAgent[];
  error: TasksReadError | null;
};

// components/workspace/TasksPage.tsx
export function TasksPage(props: {
  state: TasksState;
  retry: () => void;
  leading?: ReactNode;
  onNavigate: (route: WorkspaceRoute) => void;
}): JSX.Element;
```

- `TasksPage` still shows its spinner for any `loading` state; only `tasksForToday` reads `retryingAfter`.
- Shell: `const tasks = useTasks();` and an effect on `route.kind` that calls `tasks.retry()` when the kind CHANGES to `'today'` or `'tasks'`. It must not fire at mount (the hook's own effect reads then), so keep the previous kind in a ref that starts `null`. `tasks.retry` is stable. Render `<TasksPage state={tasks.state} retry={tasks.retry} leading={navTrigger} onNavigate={navigate} />`.
- Comments (rule 5, the gist): `workspace-tasks.ts` lines 5-6 ("It lives inside `TasksPage`, not the shell…") become "The shell owns it (TASK-933; TASK-909 decisions row 10 had it inside `TasksPage`), so one read serves Today, the sidebar badge and the Tasks page. The shell reads it at mount, again on entering Today or Tasks, and after a reply sent from Today." `TasksPage.tsx` lines 5-6 ("The page reads its own list…") become "The page draws the shell's tasks read (TASK-933), the same one Today and the sidebar badge count from." The shell's comment says the same, and that the read doesn't poll.

- [ ] **Step 1: Write the failing tests.**
  - `workspace-tasks.test.ts`: `starts loading, then holds the page` (:48) now expects `{ kind: 'loading', retryingAfter: null }`, and `retries from a failure through loading` (:91) expects `{ kind: 'loading', retryingAfter: 'failed' }`. New `describe('tasksForToday (TASK-933)')`: the first load → `{ tasks: [], unavailableAgents: [], error: null }`; loading with `retryingAfter: 'failed'` → no rows, `error: 'failed'`; ready → its rows and agents, `error: null`; ready with `refreshFailed: true` → the rows kept, `error: 'failed'`; failed `expired` and failed `failed` → no rows, that error.
  - `TasksPage.test.tsx`: `renderPage` renders a small `Harness` that calls `useTasks()` and hands `state` and `retry` to `TasksPage`, so every existing case still runs through the real hook. New `draws the state it is handed, without reading anything (TASK-933)`: render `TasksPage` with `state = { kind: 'ready', tasks: [row('Sweep', { task: report('on-track') })], unavailableAgents: [], refreshing: false, refreshFailed: false }`; `Sweep` shows and `tasksMock` was never called.
  - `WorkspaceShellRouting.test.tsx`, `describe('one tasks read (TASK-933)')`:
    - `reads tasks once at mount, whichever page it lands on`: `renderAt('/workspace/agents/a-quill')`; once the agent view has rendered, `tasksMock` was called exactly once.
    - `reads again on entering Tasks or Today, never on entering an agent`: `renderAt('/workspace')` → 1 call; click the sidebar's Tasks → 2; click Quill in the roster → still 2; click the sidebar's Today → 3.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-tasks.test.ts src/components/workspace/__tests__/TasksPage.test.tsx src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run (PASS),** plus the 12 files from Task 1 and `src/components/workspace/__tests__/WorkspaceShell.test.tsx`, then `tsc --build`.
- [ ] **Step 5: Commit:** `Agent Tasks: one tasks read for the whole workspace shell (TASK-933)`

### Task 8: A task's block on Today [tier: sensitive]

**Run `security-checklist`** (agent-written text on a new surface) and invoke **`shadcn`** and **`ux-design`** before writing markup.

**Files:**
- Create: `components/workspace/TodayTaskGroup.tsx`, `components/workspace/__tests__/TodayTaskGroup.test.tsx`.
- Modify: `components/workspace/TaskPage.tsx:116` — `const CANT_SHOW` becomes `export const CANT_SHOW` (one word), so both surfaces say the same thing about an update they can't show.

**Interfaces:**
- Consumes: `TodayGroup` (Task 4); `TodayTaskReason`, `TASK_GROUP_LABELS` (`lib/task-groups.ts`); `missSummary`, `AUTO_PAUSED_LINE` (`lib/task-miss.ts`); `TaskReplyBox`; `StateDot`, `StateDotSlot` (`bits.tsx`); `routeLinkProps`; `isOpenDecision`; `CANT_SHOW`.
- Produces:

```ts
export function TodayTaskGroup(props: {
  group: TodayGroup;
  onNavigate: (route: WorkspaceRoute) => void;
  /** A reply was sent from this block's box: the shell reads the tasks again. */
  onReplied: () => void;
  /** The block's approvals, already drawn as `DecisionRow`s, in `group.decisions` order. */
  children?: ReactNode;
}): JSX.Element;
```

**What it draws** (copy exact):
- A `<section aria-labelledby>`, using the row border Today's rows use (`border-b border-rule-soft last:border-b-0`).
- **Heading** (`h2`): a `StateDotSlot` holding `StateDot` `'needs-you'` (reason `asks` or `escalated`), `'paused'` (`auto-paused`) or nothing (approvals only); the task name (`truncate`, `title`); for a marked block an `sr-only` `, needs you` or `, paused` after the name (the dot is `aria-hidden`; `TASK_GROUP_LABELS`, lowercased); then, muted, `Task · {agentName}`.
- **Body line** (`line-clamp-2 break-words`, `title` = the same text):
  - `asks`: `row.task.ask ?? row.task.update ?? CANT_SHOW`;
  - `escalated`: `missSummary(row.noRecentUpdate)` ("Its last N check-ins didn’t leave an update. {what}");
  - `auto-paused`: `AUTO_PAUSED_LINE`;
  - approvals only, muted: `1 approval waiting` or `{n} approvals waiting`, n = the open approvals in the block; no line when n is 0.
- **Second line**, muted and clamped, only for `escalated`/`auto-paused` when the last report is needs-you with an ask: `{agentName} asks: {ask}`.
- **Actions** (`flex flex-wrap items-center gap-2`):
  - `Reply`, a `Button variant="outline" size="sm"` used as the `CollapsibleTrigger` (`asChild`), only when the block shows the agent's needs-you words (the `asks` body, or the second line). Outline because a block holds no primary action (Approve stays the one primary).
  - `Open task`, always: `Button asChild size="sm" variant="ghost"` around `<a {...routeLinkProps({ kind: 'task', agentId, routineId }, onNavigate)}>` with `ArrowRight data-icon="inline-end"`.
- **Reply box:** a controlled `Collapsible` (`open`/`onOpenChange` from `useState(false)`) whose `CollapsibleContent` gets `forceMount` AND `hidden={!open}`. `forceMount` keeps the box mounted, so a typed reply and its retry id survive a collapse, but on its own it never hides anything: Radix computes `isOpen = context.open || isPresent`, and `forceMount` keeps `isPresent` true (`@radix-ui/react-collapsible` 1.1.12, `dist/index.mjs:82-136`). Our `hidden` is spread after Radix's own, so it wins (`ModelsTab` and `RoutinesTab` do the same with `TabsContent`). Inside: `TaskReplyBox agentId routineId agentName enabled={row.enabled} canStart={false} onSent={() => onReplied()} inputRef={replyRef}`. Opening it moves focus to the textarea.
- **Children** below, indented (`pl-4`), separated from the block by a `Separator`.

- [ ] **Step 1: Write the failing tests** (`TodayTaskGroup.test.tsx`). Mock `@/lib/workspace-api` as `TaskReplyBox.test.tsx` does (`sendTaskReply: vi.fn()`); local `row()`, `report()` and `group()` helpers; task `t1` "Zero open support tickets" on agent `a1` "Caveman".
  - `a task whose agent asked shows the ask as written, with Reply and Open task`: the region named `/Zero open support tickets\s*, needs you/` (jsdom reads an `sr-only` suffix as its own word, `.claude/memory/patterns/2026-10-22-TASK-911.md`) holds `Task · Caveman` and `Want me to draft a reply to #4410?`; a `Reply` button; an `Open task` link with `href` `/workspace/tasks/a1/t1`; a plain click calls `onNavigate` with `{ kind: 'task', agentId: 'a1', routineId: 't1' }`, and a ctrl-click doesn't.
  - `shows the update when there's no ask, and says so when neither can be shown`: the update text; then `It left an update we can’t show.`.
  - `the reply box is closed until Reply, and keeps what was typed when closed again`: before any click, `queryByRole('textbox', { name: 'Reply to Caveman about this task' })` is null (hidden content is out of the accessibility tree) and `Reply` has `aria-expanded="false"`; open it, type `Draft it`, press `Reply` again (closed: the textbox query is null again), press it once more: the textbox's value is still `Draft it`.
  - `Reply opens the box in place, focused, and a sent reply tells Today to look again`: click `Reply` → the textbox `Reply to Caveman about this task` is visible and is `document.activeElement`; type `Yes, draft it`, click `Send`; `sendTaskReply` resolves `{ checkIn: 'started' }` → it was called with `('a1', 't1', { text: 'Yes, draft it', requestId: expect.any(String) })`, `onReplied` once, and `Sent. Caveman started checking in.` shows.
  - `the box never promises a check-in Today can't vouch for`: its helper text is exactly `Caveman reads your replies every time it checks in.`.
  - `three misses in a row: the count and the reason, Open task, no Reply`: `{ inARow: 3, reason: 'brief-too-long', at, autoPaused: false }` over an on-track report → `Its last 3 check-ins didn’t leave an update. Its instructions are too long to load.`; no `Reply`.
  - `three misses don't hide a pending ask`: a needs-you report asking `Which view should I count?` plus three misses → the miss line, then `Caveman asks: Which view should I count?`, and `Reply`.
  - `auto-paused: says why it stopped, with the paused mark`: `enabled: false`, `autoPaused: true`, on-track report → `Paused after 5 check-ins in a row didn’t leave an update.`, region name matches `/, paused/`, no `Reply`. With a needs-you ask instead, `Reply` opens a box whose helper is `It’s paused, so Caveman will read this once it’s resumed.`.
  - `a task there only for its approvals: its name, how many wait, and Open task`: `reason: null` with two open approvals and one receipt → `2 approvals waiting`; with one → `1 approval waiting`; with only a receipt → no count line. Never a `Reply`, and the region's name has neither `, needs you` nor `, paused`.
  - `draws the agent's words as text`: ask `'<img src=x onerror=alert(1)> **Zero** _open_'` → found by exact `getByText` and equal to its `title`; `container.querySelector('img, strong, em')` is null.
  - `draws its approvals inside the block`: a child `<p>an approval</p>` is inside the region.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/TodayTaskGroup.test.tsx`.
- [ ] **Step 3: Implement.** Invoke `shadcn` (no new component; `Collapsible`, `Button asChild`, `Separator`) and `ux-design` (spacing and alignment only; keep the words).
- [ ] **Step 4: Run (PASS),** plus `src/components/workspace/__tests__/TaskPage.test.tsx` and `src/components/workspace/__tests__/TaskReplyBox.test.tsx`, then `tsc --build`.
- [ ] **Step 5: `security-checklist`:** ask, update and task name are model or person text, drawn as React text only; the `title` holds the same fenced value; the reply goes through TASK-931's owner-checked route; nothing here adds a route, an authority or a link built from agent text.
- [ ] **Step 6: Commit:** `Agent Tasks: a task's block on Today, with its ask, Reply and Open task (TASK-933)`

### Task 9: Today lays out tasks, and every count agrees [tier: integration]

Invoke **`shadcn`** and **`ux-design`** before the alert markup.

**Files:**
- Modify: `components/workspace/TodayView.tsx` — header (:2-22; property 3 also names the shell's tasks read), imports, `Props` (:65-137), destructure (:139-162), counts and headline (:163-203), a third alert after the grants alert (:387), the list (:426-508).
- Modify: `components/workspace/WorkspaceShell.tsx` — `pending` and its comment (:759-776), the `TodayView` props (:911-934).
- Test: `components/workspace/__tests__/TodayView.test.tsx`, `components/workspace/__tests__/consent-focus.test.tsx`, `components/workspace/__tests__/WorkspaceShell.test.tsx`, `components/workspace/__tests__/WorkspaceShellRouting.test.tsx`.

**Interfaces:**
- Consumes: `waitingOnYou`, `todayQueue`, `TodayGroup` (Task 4); `TodayTaskGroup` (Task 8); `tasksForToday`, `TasksReadError` (Task 7); `TaskRow`, `UnavailableAgent`.
- Produces — `TodayView` `Props`, all required (the shell is its one parent, TASK-932's reasoning):

```ts
/** Every task the person owns, from the shell's one tasks read (TASK-933). Today shows the ones that need a person. */
tasks: readonly TaskRow[];
/** How that read went: null = fine or still loading; 'failed' (a failed refresh too); 'expired'. */
tasksError: TasksReadError | null;
/** Agents whose tasks couldn't be read. */
unavailableTaskAgents: readonly UnavailableAgent[];
/** Read the tasks again. */
onRetryTasks: () => void;
/** A reply was sent from a task's block. */
onReplied: () => void;
```

**Behaviour:**
- `waiting = waitingOnYou({ decisions: readable ? decisions : [], grants, tasks })`, and the shell's `pending = waitingOnYou({ decisions: queue.decisions, grants: grants.grants, tasks: taskRead.tasks })` with `const taskRead = tasksForToday(tasks.state)`. Not `today`: the shell already has a module-level `function today()` (:78) that the header's `subtitle={today()}` (:899) calls. The `pending` comment says all three numbers come from this one function and now count tasks that need you.
- `tasksUnknown = tasksError !== null || unavailableTaskAgents.length > 0`; the headline is `We could not check what is waiting on you.` when `!readable || (waiting === 0 && (grantsUnknown || tasksUnknown))`.
- **The tasks alert**, after the grants alert, when `tasksUnknown`: `Alert variant={readAlertVariant(tasksError ?? 'failed')}`.
  - Expired: `DECISION_SESSION_EXPIRED` and `SignInAgainButton`.
  - Otherwise these lines, then a `Try again` (`secondary`, `sm`) calling `onRetryTasks`:
    - `We couldn’t check your tasks just now.` when `tasksError === 'failed'`;
    - `We couldn’t check tasks from {names}, so some may be missing.` when agents are missing, names joined with `Intl.ListFormat('en', { style: 'long', type: 'conjunction' })` as `TasksPage` does.
- **The list** (Needs you): grants, then `groups.map((g) => <TodayTaskGroup key={g.key} group={g} onNavigate={onNavigate} onReplied={onReplied}>{g.decisions.map((d) => renderRow(d, isOpenDecision(d), { inBlock: true }))}</TodayTaskGroup>)`, then the loose approvals, then the empty sentence, which also needs `groups.length === 0`. `{ groups, loose } = todayQueue({ tasks, decisions: readable ? decisions : [], agents, now: Date.now() })`. The list card's gate gains `|| (filter === 'needs' && groups.length > 0)`, so a task survives an unreadable queue the way a grant does. The Working filter shows no task blocks.
- **Loose approvals:** one array in queue order, `loose.map((d) => renderRow(d, isOpenDecision(d)))`, so a row that resolves keeps its place and its instance. This is conditional: keep it only if Step 2's `a plain approval answered on Today keeps focus on its receipt` fails against the unchanged `TodayView`, as expected (today the row moves from the `open` array to the `justResolved` array, React remounts it, and `useResolutionFocus`'s armed ref is lost). If that test passes on the unchanged code, keep today's open-then-receipts order and say so in the handoff.
- **One Open task per block.** `renderRow` gains an optional third argument, `{ inBlock?: boolean }`; a row drawn inside a block gets no `onNavigate`, so the expanded `DecisionRow` draws no Open task of its own (TASK-932 made the prop optional for exactly this: no prop, no link). The block's heading already has one, and two identical links in one block would be noise (and break `getByRole` in TASK-932's test). Loose rows keep `onNavigate`; they never carry a `checkIn`, so they draw no link either way.
- Shell: `<TodayView … tasks={taskRead.tasks} tasksError={taskRead.error} unavailableTaskAgents={taskRead.unavailableAgents} onRetryTasks={tasks.retry} onReplied={tasks.retry} />`.

- [ ] **Step 1: Write the failing tests.**
  - `TodayView.test.tsx`: `renderToday` defaults to `tasks={[]} tasksError={null} unavailableTaskAgents={[]} onRetryTasks={vi.fn()} onReplied={vi.fn()}`. Mock `@/lib/workspace-api` by spreading the actual module and its `workspaceApi`, replacing only `sendTaskReply`. Locate an alert by its sentence (`getByText(…).closest('[role="alert"]')`): decision rows carry their own `role="alert"` live regions. Register checks follow the file's existing `className` contains/doesn't contain `destructive`. New `describe('what tasks need from you (TASK-933)')`:
    - `lists grants, then tasks that need you, then the other approvals` (document order).
    - `puts an approval held during a task's check-in under that task, and keeps one without a task in the plain list`.
    - `counts each task that needs you and each approval once`: task `t1` needs you, `d1` under `t1`, `d2` loose → `Three things are waiting on you.` and `3 waiting on you`.
    - `a task there only for its approvals adds nothing to the count`: on-track `t2` and `d1` under it → `One thing is waiting on you.` and `1 approval waiting`.
    - `never says nothing is waiting when the tasks read failed, and offers Try again`: `tasksError: 'failed'` → the could-not-check headline, `We couldn’t check your tasks just now.` in a `destructive` alert, and its `Try again` calls `onRetryTasks`.
    - `an ended session offers sign-in, not Try again`: `tasksError: 'expired'` → `DECISION_SESSION_EXPIRED` in a non-destructive alert, a `Sign in` button, no `Try again` in it.
    - `names the agents it couldn't check, and doesn't claim an empty day`: unavailable Juniper and Quill, nothing else → `We couldn’t check tasks from Juniper and Quill, so some may be missing.`, the could-not-check headline, `Try again` → `onRetryTasks`.
    - `a failed refresh keeps the tasks it has on screen`: `tasksError: 'failed'` plus a needs-you task → its block shows, so does the alert, and the headline says `One thing is waiting on you.`.
    - `a task still shows when the queue can't be read`: `error` set plus a needs-you task → its block shows; the headline is the could-not-check one.
    - `tasks show under Needs you only`: `filter="working"` → no block.
    - `the empty-queue sentence waits for tasks too`: only a needs-you task → no `/wait for you here/`.
    - `a reply sent from a task's block calls onReplied`.
    - Rewrite TASK-932's `hands an expanded check-in row the shell’s navigation` (:483-498) as `a check-in's approval opens its task from its block's heading, the one Open task there (TASK-933)`: the same expanded row now sits in a block, so `getAllByRole('link', { name: /^Open task/ })` has length 1, and clicking it calls `onNavigate` with `{ kind: 'task', agentId: 'a-quill', routineId: 't1' }`.
  - `consent-focus.test.tsx`: the `TodayHarness` (:818-833) gains the five props. New `describe('Today keeps an answered approval where it was (TASK-933)')`, with `Decoys` and `tabsToReach`: a harness holding one decision in state, `expandedId` on it, whose `onApprove` swaps in the resolved row.
    - `an approval answered inside its task's block keeps focus on its receipt, Undo one Tab away`: `decisionFixture({ id: 'd1', checkIn: LABEL })` → `resolvedFixture('executed', { id: 'd1', checkIn: LABEL })`, `tasks` empty (a block there for its approval). Click `Move it` → `document.activeElement` is `decision-outcome-d1`, and `tabsToReach(Undo)` is 1.
    - `a plain approval answered on Today keeps focus on its receipt`: the same, with `checkIn: null`. Expected to FAIL on the unchanged code (see Behaviour).
  - `WorkspaceShell.test.tsx` (its mock gains `sendTaskReply: vi.fn()` and a `sendTaskReplyMock`; the board has Quill `a-quill`; tasks are on `a-quill`):
    - `counts a task that needs you in the badge, the Needs you tab and the headline alike (TASK-933)`: one loose decision and one needs-you task → `Two things are waiting on you.`, the `Needs you` radio's text `Needs you2`, and the sidebar's `Today` button showing `2`.
    - `an approval under its task counts once, and a task there only for its approvals adds nothing`: `d1` under needs-you `t1`, `d2` under on-track `t2` → `Three things are waiting on you.` and `3` on the badge.
    - `reads the tasks once for the badge and Today`: after the page settles, `tasksMock` was called exactly once.
    - `a failed tasks read never lets Today say nothing is waiting, and Try again reads again`: `tasksMock` rejects once, then answers `[]` → the could-not-check headline and `We couldn’t check your tasks just now.`; `Try again` inside that alert → `Nothing is waiting on you.`, two calls.
    - `while Try again is reading, Today still says it couldn't check`: `tasksMock` rejects once, then returns a promise that never settles; after `Try again`, the headline is still `We could not check what is waiting on you.` and `Nothing is waiting on you.` is absent (pins `retryingAfter`, Task 7).
    - `a reply sent from Today reads the tasks again`: a needs-you task with an ask. Query `Reply`, the textbox and `Send` WITHIN the task's region: the home composer on Today has its own `Send` button. Type and send (`sendTaskReplyMock` resolves `{ checkIn: 'started' }`) → `tasksMock` called twice.
  - `WorkspaceShellRouting.test.tsx`: `the badge counts a task that needs you on an agent's page too (TASK-933)`: `renderAt('/workspace/agents/a-quill')` with one needs-you task → the sidebar's `Today` button shows `1`. Today isn't mounted there, so only the shell's `pending` can produce it.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/TodayView.test.tsx src/components/workspace/__tests__/consent-focus.test.tsx src/components/workspace/__tests__/WorkspaceShell.test.tsx src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx`. Note whether the plain-approval focus case failed.
- [ ] **Step 3: Implement.** Invoke `shadcn` and `ux-design`; keep the words.
- [ ] **Step 4: Run (PASS),** plus all files from Tasks 1, 7 and 8, `src/components/workspace/__tests__/DecisionRow.test.tsx` and `src/components/workspace/__tests__/decision-renderers.test.tsx`, then `tsc --build`.
- [ ] **Step 5: 390 px.** If a browser on a current build is reachable (`k8s-acceptance-loop` on `ax-next-dev`, always `--context kind-ax-next-dev`), open Today at 390×844 with a needs-you task that has an approval under it, open Reply, and check `document.documentElement.scrollWidth <= 390`. If not, say in the handoff that it is unverified at 390 px and left for the PR 2 walk. Never report it as passed without measuring.
- [ ] **Step 6: Commit:** `Agent Tasks: Today shows what tasks need from you, and every count agrees (TASK-933)`

### Task 10: The design doc [tier: mechanical]

**Files:** Modify `docs/plans/2026-10-20-agent-tasks-design.md`.

- [ ] **Step 1: Edit (exact).**
  - **§3.5**, after the mock's closing fence (:265), add:

    ```markdown
    > PR 2 (TASK-933): Today reads the same list as the Tasks page, through one read the whole workspace shares (it also feeds the sidebar badge), and reads it again on opening Today or Tasks and after a reply. A task shows on Today when its last report says Needs you, after three check-ins in a row leave no update, or once the host has paused it after five, until a person resumes it. A task a person paused never shows. Each one shows its ask (else its update) or why it's there, with Open task, and Reply when the agent asked something; the reply box opens in place. Approvals raised during a task's check-ins sit under that task, each answered on its own. A task that's fine but has approvals waiting shows only its name and how many. The badge, the Needs you tab and the headline are one count: open approvals, grants and tasks that need you, each once. A tasks read that failed, or that missed an agent, says so and never lets the headline say nothing is waiting.
    ```

  - **§15**, append these rows at the table's end:

    ```markdown
    | 2026-10-23 | Decided | Today reads `GET /api/workspace/tasks` through one shell-level read that also feeds the sidebar badge and the Tasks page, and reads it again on entering Today or Tasks and after a reply sent from Today (TASK-933). |
    | 2026-10-23 | Decided | A task shows on Today when its last report says Needs you, after three check-ins in a row without an update, or once the host paused it; an auto-paused task stays until a person resumes it, with no dismiss. A task a person paused never shows (TASK-933). |
    | 2026-10-23 | Decided | A task's approvals sit under it on Today, each answered on its own; there is no approve-all. The task's heading carries its one Open task, so an approval under it has none of its own. Reply opens the task's reply box in place (TASK-933). |
    | 2026-10-23 | Decided | The sidebar badge, the Needs you tab and Today's headline are one count: open approvals, grants and tasks that need you. A task there only for its approvals adds nothing (TASK-933). |
    | 2026-10-23 | Decided | An approval's task label is looked up only while the approval is open. Once it's answered, Today keeps the label it had, so the receipt stays under its task (TASK-933). |
    ```
- [ ] **Step 2: Commit:** `docs(agent-tasks): Today's task asks and approval groups, as built (TASK-933)`

---

## Card acceptance → tests

| Card acceptance | Test |
|---|---|
| `todayTasks` includes needs-you, escalated, auto-paused; excludes person-paused, on/off track, 1–2 misses, never reported; order | T3 (six cases) |
| Route: `ask` fenced and capped; `agentNotes` never crosses; negative-space test updated | T2 (renamed test, cap test) |
| A task group renders the ask with Reply and Open task | T8 (first case); T9 (layout) |
| Reply opens the inline box, sends, calls `onReplied` | T8 (`Reply opens the box…`); T9 (`a reply sent… calls onReplied`; shell re-read) |
| Escalated and auto-paused sentences | T8 |
| An approval with `checkIn` sits in its task's group; one without stays plain | T4; T9 |
| An approvals-only group | T4; T8; T9 |
| Headline and counts include tasks, no double count | T4 (`waitingOnYou`); T9 (TodayView, shell, badge on an agent route) |
| A tasks read failure blocks "Nothing is waiting on you", shows its alert and Try again, or sign-in on 401 | T9; T7 (`retryingAfter`) and T9 (`while Try again is reading…`) for a retry in flight |
| The partial line | T9 (`names the agents it couldn't check…`) |
| Ask and update render as literal text | T8 (`draws the agent's words as text`) |
| Shell: badge, tab and headline agree | T9 (shell) |
| Shell: one `tasks()` fetch serves Today and Tasks; re-read on entering both | T7 (routing); T9 (`reads the tasks once…`) |
| TasksPage renders from shell state | T7 (`draws the state it is handed…`) |
| Existing shell tests get a `tasks` mock, no other behaviour change | T1 |
| Phone width 390 px | T9 Step 5 (measured, or named unverified) |
| Follow-up: a malformed `checkIn` doesn't fail the read | T5 |
| Follow-up: the label lookup off the poll path | T6 |

## Before the PR

- **Gates:** `pnpm build && DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Docker-backed packages may fail with "Waited 40000 ms for a container start slot": re-run those one at a time (routines with `VITEST_MAX_WORKERS=2`) and report both runs (`.claude/memory/patterns/2026-10-22-TASK-910.md`). If the daemon hangs (`timeout 40 docker version` exits 124), don't restart OrbStack; wait, and report a Docker-blocked step as blocked.
- **Boundary review:** none. No hook is added or changed; `GET /api/workspace/tasks` and the decision routes are channel-web's own.
- **Security note** (from Tasks 2 and 8, plus Task 6):
  - the ask crosses only to the task's owner, fenced to one line at the writer's cap, and is drawn as text;
  - Reply on Today uses TASK-931's owner-checked route, so Today adds no write;
  - the label lookup now runs for open rows only: fewer calls, less output, still nothing authorizes on it;
  - the client reads a malformed label as none and never draws one;
  - no new dependency, hook, IPC or migration.
- **Deploy:** none. Nothing from Agent Tasks is deployed, and there is no migration.
- **Handoff:** list the departures (decisions rows 2, 5, 8–13), whether the plain-list focus test failed on the old code (row 10), the 390 px result or that it is unverified, and the YAGNI cuts (row 13).
