# TASK-911 "See what it did" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each check-in on a task page links to its own read-only transcript at `/workspace/tasks/<agentId>/<routineId>/checkins/<conversationId>`. The page shows when it ran, why, and the report it ended with, then what the agent said and every tool it ran. Nothing on it can send into, stop or continue that conversation, and nobody but the task's owner can open it.

**Architecture:** channel-web gains one GET route, `…/checkins/:conversationId`. It runs the task page's ownership order (moved out of `taskDetail` into a shared `ownTaskOr404`). Then it checks that the conversation is one of the task's newest 200 check-ins (`routines:recent-fires`), and reads it the way the agent view's read-only past-conversation excerpt does (`conversations:get`, then `buildThread` and `approvalMessages`), without the host-written check-in message. Updates entries now carry their `conversationId`. A new `TaskCheckinPage` reads the route through `useTaskCheckin` and draws the transcript with `AgentConversation` in `readOnly` mode, whose `agent` prop narrows to `{ id, name }`. The shell mounts the page with the decision queue, as it does `AgentView`. No new hook, plugin, dependency, migration or shadcn component.

**Tech Stack:** TypeScript, React 18, shadcn (radix) primitives, Tailwind v3 semantic tokens, vitest + testing-library (`fireEvent`, no user-event). Every new test uses stubs on a real `HookBus`, with no Postgres.

**Spec:** the TASK-911 card body, and `docs/plans/2026-10-20-agent-tasks-design.md` §3.3 (first bullet), §3.7 (an approval raised during a check-in shows in its transcript), §7 and §12 (PR 1). Predecessor contract: "For the sibling cards" in `docs/plans/2026-10-22-task-910-task-page-plan.md`. Decisions: `.claude/memory/decisions/2026-10-22-TASK-911.md`, rows counted from the first data row. Read rows 2–8 before Task 1: each one settles something the card left open, or departs from it.

## Global Constraints

- No new hook, plugin, dependency, migration, `pnpm-lock.yaml` change or shadcn component. Alert, Breadcrumb, Button and Spinner are installed. The new route calls only hooks channel-web already declares: `routines:get`, `routines:recent-fires`, `decisions:list` and `connectors:tool-labels` (all optional), and `conversations:get` (hard). The manifest gains no entry, and `manifest-declarations.test.ts` stays green.
- Exactly one route sits under `/checkins/`, and it is a GET. The check-in page holds no way to send. It makes no `workspaceApi` write, no chat or stream call and no `onStop`. `AgentConversation` gets `readOnly`, and inert send and grant handlers (Task 8).
- Plain words on the page: Tasks, check in, Needs you. New copy never says routine, webhook, trigger or conversation, error copy included. The reused `AgentConversation` keeps its own labels. Copy marked exact is decided, so paste it. The apostrophe is `’` (U+2019).
- The report's update and a failed check-in's reason are fenced on the server and drawn as React text only, with no markdown component. The transcript is drawn only by `AgentConversation`, exactly as the agent view draws it. Its markdown pipeline shows an image as its alt text and leaves file links out of prose. No `dangerouslySetInnerHTML` anywhere.
- Every wire field is built one by one, never spread. `triggerSource` crosses only on the check-in response, never on `TaskDetail`. A check-in's `thread` carries no user-role row, no thinking and no `memoryUsed`.
- `theme-contrast.test.ts` scans all of `src/` outside `__tests__`, comments included. Never write the text-colour form of the state-quiet token (`text-` + `state-quiet`), and never pair `bg-<family>-soft` with `text-<family>` in a new file. Errors use `Alert variant="destructive"`.
- Run one test file as `pnpm --filter @ax/channel-web test <path>`: the filter goes before the script, and there is no `--` (`.claude/memory/mistakes/2026-10-20-TASK-904.md`). Check the file count in vitest's summary.
- Any command that runs a whole folder or the whole package (`… test src/__tests__/server`, `… test`) needs `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock` in front. Six existing server files start Postgres (`routes-chat`, `acceptance-e2e`, `stream-e2e`, `connections-mirror`, `routes-attachments`, `routes-workspace-approval-actor`), and without it they fail at load with "set DOCKER_HOST explicitly". Measured at 45f941f26: everything else in `src/__tests__/server` passes.
- channel-web's `tsc` type-checks its tests, so after each task run `pnpm --filter @ax/channel-web exec tsc --build`. Tests may import `packages/routines/src/*.js` by relative path (the TASK-909/910 precedent), so routines needs no build.
- TDD and the Bug Fix Policy: run each new test against the unmodified code and watch it fail before changing the source.
- Final gates (CLAUDE.md): `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. The Docker-backed packages may fail with "Waited 40000 ms for a container start slot". Re-run those one at a time with `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock` (routines with `VITEST_MAX_WORKERS=2`) and report both runs (`.claude/memory/patterns/2026-10-22-TASK-910.md`).
- Memory: shards only, from `scripts/memory-write-target.sh --shard <kind> TASK-911`. Never touch a root `.claude/memory/*.md`, and never add a `Memory-Rewrite:` trailer.
- Deploy: nothing in PR 1 is deployed yet, and PR 1 deploys as one. This card adds no migration, so it needs no deploy note beyond saying so.

## Review Focus

1. **A check-in URL that names the caller's own ordinary chat with the same agent, or another task's check-in.** It answers 404, and the conversation is never read through this route. Pinned in Task 2 (`404s another task’s check-in…`, `404s the caller’s own chat…`).
2. **Someone opens another person's check-in on a team agent.** It answers 404, with no run history and no transcript read. Pinned in Task 2 (`404s someone else’s task…`).
3. **The transcript holds an approval that is still waiting, and the person answers it there.** The card is the queue's own row, and its primary button works as it does on Today. Nothing sends into, resumes or binds the check-in's conversation, and there is no composer, Stop or "Edit first". Pinned in Task 8 (`offers no way to send…`, `answers an approval…`).
4. **A check-in its instructions blocked (TASK-908's veto).** The transcript says the instructions didn't load. It never says "The agent stopped unexpectedly. Retry to continue." Pinned in Task 3, and in Task 8 (`a check-in its instructions blocked…`).
5. **A check-in is still running when the task page loads.** It has already reported, so it is on the latest update card, but it isn't in Updates until it finishes. If it said something new, the card has no link until it finishes, rather than opening the check-in before it. If it repeated the previous report word for word, the link opens that earlier check-in, which ended with the same report: nothing on the wire tells the two apart (decisions row 12, accepted). Pinned in Task 7 (`none while a check-in that said something new is still running`, and its TaskPage twin).

## Where this plan departs from the card

Each is a decisions row. Say so in the PR description.

- **The transcript is built the agent view's way, not by calling the chat route** (row 3). `GET /api/chat/conversations/:id` answers raw turns, and it drops `displayEvents` (the failure rows). `AgentConversation` draws `ThreadMessage[]` built by `buildThread`. The read itself is the same `conversations:get`, with the same 404-on-refusal rule.
- **Tool calls show as the agent view shows them: one line each** (row 4). The line names the tool and what it ran on, and says whether it worked, failed or is waiting. The full inputs and results are not shown. The card's "tool calls with their inputs and results" describes a renderer that doesn't exist: the workspace has never carried a tool's raw input or output (`lib/workspace-steps.ts`).
- **The check-in message the host sent the agent is left out** (row 5). Drawn, it would read as the person's own words, and it quotes the agent's notes.
- **A manual start reads "Started outside its schedule", not "Check now"** (row 10). The agent's own `routine_fire_now` records `manual` too, and a fire row can't tell the two apart.
- **`AgentConversation` is reused in `readOnly` mode with its `agent` prop narrowed, rather than having its renderer factored out** (row 8).
- **`triggerSource` crosses only on the check-in route** (row 11). No Updates entry draws it.
- **The latest update card links only when its check-in is in Updates and says the same** (row 12).
- **The brief veto's two turn-error codes get their own words** (row 13). TASK-908 left this to this card.

## Card premises, checked (at 45f941f26)

- **True:**
  - `conversations:get` is owner-only (`conv.userId !== input.userId` → `not-found`, `packages/conversations/src/plugin.ts:1585-1593`) and reads hidden conversations by id. Only list queries filter `hidden` (`scope.ts:42-44`).
  - A per-fire check-in conversation is created with the routine owner's `userId`, `hidden: true` and `origin: 'routine'` (`packages/routines/src/fire.ts:215-226`).
  - `routines:recent-fires` clamps `limit` to 1–200 (`ROUTINE_HISTORY_MAX_LIMIT`) and sorts newest first by `fired_at` with no tiebreak (`store.ts:597-608`). It hides only `report` from non-owners (`fireViews`).
  - A fire row is written only when its run finishes. `finishDispatch` inserts it, and `fired_at` is the run's accept time (`store.ts:387-392`).
  - `RoutineFireView` carries `conversationId` (nullable) and `triggerSource`.
  - `isOwnTask(view)` implies ownership. `task` is non-null only for the owner (`services.ts:53-57`), and `permissions.fire` is `allowed && ownerUserId === userId` (`services.ts:28-31`).
  - A routine counts as a task when `view.kind !== 'repeat'`, decided right after `routines:get` (`routes-workspace.ts:6934`).
  - The other line numbers in the brief hold: `TaskFireView` at :736, `toTaskUpdate` at :3452, `isOwnTask` at :3293, routes at :9239–9252, `getConversation` at `routes-chat.ts:1100`.
- **Refuted or corrected:**
  - (a) The existing thread renderer doesn't show tool inputs and results. A step row is the tool's name plus one bounded qualifier (`stepDetail`) and a status.
  - (b) Design §3.3 says "a check-in that is the agent's latest chat would open live with a composer". It can't: `conversations:list` never returns a hidden conversation, so a check-in is never the agent's current chat. Task 9 fixes that line.
  - (c) The brief says "a manual trigger is Check now". `routines:fire-now` stamps `manual` for both the person's Check now and the agent's `routine_fire_now` (`services.ts:147`, `tools.ts:106-110`).
  - (d) "Read the transcript the way `GET /api/chat/conversations/:id` does" is corrected by row 3.
  - (e) A fire row's `conversationId` can be null while a conversation exists: after a host restart (`interruptAbandonedDispatches`, `store.ts:361-369`) or a setup failure (`fire.ts:170-175`). Those entries get no link, which matches the card's "only for check-ins that have a `conversationId`".

## For the sibling cards (design PR 2 and later): what this card guarantees

- `TaskUpdate.conversationId` is on the task wire, and `TaskCheckin` is the check-in page's (`lib/workspace-types.ts`). `latestUpdateCheckIn` (`lib/task-updates.ts`) decides which check-in the latest update came from.
- A check-in's thread never holds a user-role row. PR 2's replies reach a check-in through its check-in message, so they won't show in a transcript. If PR 2 wants them there, add them as their own labelled row, not by letting user turns back in.
- `approvalReadFrom` (`AgentConversation.tsx`) is the one rule for "how were this thread's approval cards read".
- **Follow-ups worth filing** (not built here):
  - `POST /api/chat/messages` accepts any conversation its caller owns, hidden check-ins included (`routes-chat.ts:480-498`), and the orchestrator has no origin check. So an owner could add a turn to their own check-in with a crafted request. Refuse `origin: 'routine'` conversations there.
  - Opening a check-in older than the newest 200 needs a one-fire lookup by conversation in routines. There is no such service today.

## Order and file ownership

| Wave | Task | Touches | Depends on |
|---|---|---|---|
| 1 | T1 Updates carry their check-in | `lib/workspace-types.ts`, `server/routes-workspace.ts` (`TaskFireView`, `toTaskUpdate`, `toTaskDetail`'s doc), `lib/workspace-api.ts` (`isTaskUpdate`), five test files | — |
| 1 | T3 turn-error words | `lib/turn-error-labels.ts` and its test | — |
| 1 | T5 the route's address | `lib/workspace-route.ts` and its test, `WorkspaceShell.tsx` (sidebar mapping only) | — |
| 1 | T6 the renderer, ready to reuse | `AgentConversation.tsx`, `AgentView.tsx`, a new test | — |
| 2 | T2 the route | `server/routes-workspace.ts`, `server/plugin.ts`, `plugin.test.ts`, `routes-workspace-registration.test.ts`, a new `routes-workspace-checkin.test.ts` | T1 |
| 2 | T4 the client read | `lib/workspace-api.ts`, a new `lib/workspace-task-checkin.ts`, two new tests | T1 |
| 2 | T7 See what it did links | `lib/task-updates.ts`, `TaskUpdates.tsx`, `TaskPage.tsx`, their tests | T1, T5 |
| 3 | T8 the check-in page | a new `TaskCheckinPage.tsx` and its test | T3, T4, T5, T6, T7 |
| 4 | T9 open it, and the design doc | `WorkspaceShell.tsx`, `WorkspaceShellRouting.test.tsx`, `docs/plans/2026-10-20-agent-tasks-design.md` | T8 |

Paths are under `packages/channel-web/src/` unless they start with `docs/` or `packages/`. The tasks in one wave touch disjoint files. Line numbers are at 45f941f26: use the named symbol when they drift. Cards that may merge first: TASK-923 (Check now copy) likely edits `TaskPage.tsx` and its test, which Task 7 also touches, and the design doc's §15 collects rows from every card. Rebase onto the current origin/main before the PR and keep both sides.

---

### Task 1: Each Updates entry carries its check-in's conversation [tier: integration]

**Files:**
- Modify: `lib/workspace-types.ts`: `TaskUpdate` (:1353) gains a field; add `TaskCheckin` after `TaskDetail` (:1364)
- Modify: `server/routes-workspace.ts`: `TaskFireView` (:736) widens; `toTaskUpdate` (:3452) adds the field; `toTaskDetail`'s doc comment (:3387-3406)
- Modify: `lib/workspace-api.ts`: `isTaskUpdate` (:466-475)
- Test: `__tests__/server/routes-workspace-task.test.ts` (the `fire()` fixture's comment :115-118, the expected `updates` :319-352, the marker loop :353-365); `lib/__tests__/workspace-api-task.test.ts` (`UPDATE` :39-44, `DETAIL.updates` :56-60, the refusal table :103-136); and the `TaskUpdate` factories in `lib/__tests__/task-updates.test.ts` (:8-21), `components/workspace/__tests__/TaskUpdates.test.tsx` (:16-25) and `components/workspace/__tests__/TaskPage.test.tsx` (:78-85)

**Interfaces:**
- Produces:

```ts
// lib/workspace-types.ts. `RoutineFireView` is a type import from '@ax/routines-contract'.
export interface TaskUpdate {
  // …the four TASK-910 fields, unchanged…
  /** The check-in's own conversation, for See what it did (TASK-911). Null when the run recorded none. */
  conversationId: string | null;
}
/** One check-in's read-only page (TASK-911): GET /api/workspace/tasks/:agentId/:routineId/checkins/:conversationId. */
export interface TaskCheckin {
  /** The task's name, fenced to one line: the breadcrumb's middle crumb. */
  taskName: string;
  /** The agent's name, as the roster has it. */
  agentName: string;
  /** The check-in, built exactly as its Updates entry is. Its conversationId is the one asked for. */
  checkIn: TaskUpdate;
  /** What started it. 'manual' is Check now or the agent's own start, which can't be told apart (TASK-908). */
  triggerSource: RoutineFireView['triggerSource'];
  /** What the agent said and did, as the agent view draws it: no user-role rows, no thinking, no memory chips. */
  thread: ThreadMessage[];
  /** How the approval cards in `thread` were read, the agent view's field. */
  decisions: { status: WorkspaceReadStatus };
}
// server/routes-workspace.ts
type TaskFireView = Pick<RoutineFireView, 'firedAt' | 'status' | 'error' | 'report' | 'conversationId' | 'triggerSource'>;
```

`toTaskUpdate` adds `conversationId: fire.conversationId`, as is: an opaque id the host minted, never text an agent wrote. `isTaskUpdate` adds `isStringOrNull(v.conversationId)`. In `toTaskDetail`'s doc comment, the list of what doesn't cross becomes (exact): "of each check-in no `triggerSource`, `ask`, `renderedPrompt` or `warning` (TASK-910 decisions row 10); its `conversationId` crosses for See what it did (TASK-911)."

- [ ] **Step 1: Write the failing tests.**
  - `routes-workspace-task.test.ts`:
    - In `answers the task’s latest update, brief, notes and updates`, every expected update gains `conversationId: 'CONVERSATION-ID'`, the fixture's default.
    - In the marker loop, `'CONVERSATION-ID'` leaves the forbidden list. `'manual'` stays: one fixture fire is `triggerSource: 'manual'`, and the task page never shows it.
    - The fixture's comment becomes (exact): "One check-in, as `routines:recent-fires` shows it. The fields the page never draws carry markers no response may contain. Its conversation is drawn, as See what it did (TASK-911)."
    - New test `each update names its check-in’s conversation, and one that recorded none says so`: fires `[fire({ conversationId: 'c-2' }), fire({ conversationId: null, status: 'error', error: 'boom' })]` → `body.updates.map((u) => u.conversationId)` is `['c-2', null]`.
  - `workspace-api-task.test.ts`:
    - `UPDATE` gains `conversationId: 'c1'`, and `DETAIL.updates`' two inline entries gain `conversationId: null` and `'c3'`, so the guard is seen to accept both forms.
    - The refusal table (:119-136) gains `['an update whose conversation isn’t an id', { ...DETAIL, updates: [{ ...UPDATE, conversationId: 42 }] }]` and `['an update whose conversation is left out', { ...DETAIL, updates: [{ ...UPDATE, conversationId: undefined }] }]`.
  - The other three factories default `conversationId: null`. TASK-910's "plain text" tests assert that no `a` element exists, and a null id draws no link (Task 7).
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/__tests__/server/routes-workspace-task.test.ts src/lib/__tests__/workspace-api-task.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both (PASS), plus `src/lib/__tests__/task-updates.test.ts`, `src/components/workspace/__tests__/TaskUpdates.test.tsx` and `src/components/workspace/__tests__/TaskPage.test.tsx`, then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit:** `git commit -m "Agent Tasks: each check-in in Updates carries its conversation (TASK-911)"`

### Task 2: The check-in route [tier: sensitive] (security-checklist)

**Files:**
- Modify: `server/routes-workspace.ts`:
  - the header route list (:1-10) and the security paragraph (:51-65);
  - the `@ax/routines-contract` import gains `ROUTINE_HISTORY_MAX_LIMIT`;
  - new `ownTaskOr404` beside `taskDetail` (:6913), which `taskDetail` then uses;
  - new `toTaskCheckin` after `toTaskUpdate`;
  - handler `taskCheckin` after `clearTaskNotes` (:6958);
  - one route entry after `/notes` (:9250).
- Modify: `server/plugin.ts`: the header (after the TASK-910 sentence, :62-64), and the `routines:get` and `routines:recent-fires` degradations and their comment (:304-316)
- Modify: `__tests__/server/plugin.test.ts` (the same two strings, :777-787) and `__tests__/server/routes-workspace-registration.test.ts` (two tests)
- Create: `__tests__/server/routes-workspace-checkin.test.ts`

**Interfaces:**
- Consumes: `TaskCheckin` and the widened `TaskFireView` and `toTaskUpdate` (T1).
- Produces: `GET /api/workspace/tasks/:agentId/:routineId/checkins/:conversationId` → 200 `TaskCheckin`. It also answers 401 `{ error: 'unauthenticated' }`; 400 `missing-task-id` or `missing-checkin-id`; and 404 `agent-not-found` (from `resolveAgentOr404`), `task-not-found` or `checkin-not-found`.

```ts
// inside makeWorkspaceHandlers
/**
 * The order one task's routes share (TASK-910 decisions row 11; TASK-911 row 2): without @ax/routines' reads, 404;
 * resolveAgentOr404; routines:get as the caller, where a refusal (isTaskRefusal) is a 404 and any other throw
 * propagates; a repeat routine or someone else's task (!isOwnTask) is a 404. Writes the 404 and answers null.
 * Reads no run history.
 */
async function ownTaskOr404(
  userId: string,
  key: TaskKeyInput,
  res: RouteResponse,
): Promise<{ agent: AgentsResolveOutput['agent']; view: TaskDetailView; ctx: AgentContext } | null>;
// module level
function toTaskCheckin(
  agent: { displayName: string },
  view: TaskDetailView,
  fire: TaskFireView,
  thread: ThreadMessage[],
  status: WorkspaceReadStatus,
): TaskCheckin;
```

**`taskDetail`** becomes `authOr401` → `taskKeyOr400` → `ownTaskOr404` → `routines:recent-fires` (limit 50) → 200. Its behaviour is byte-for-byte unchanged, and TASK-910's tests pass untouched. Every 404 from `ownTaskOr404` is `{ error: 'task-not-found' }`, the hasService one included.

**`taskCheckin` (decisions rows 2, 3, 5, 6, 9), in this order:**
1. `authOr401`, then `taskKeyOr400`.
2. `conversationId = (req.params.conversationId ?? '').trim()`. Empty → 400 `missing-checkin-id`.
3. `ownTaskOr404`.
4. `routines:recent-fires` with `{ ...key, limit: ROUTINE_HISTORY_MAX_LIMIT }` through its `ctx`. Any throw propagates.
5. `fire = fires.find((f) => f.conversationId === conversationId)`. None → 404 `checkin-not-found`, and no conversation is read.
6. `conversations:get` through `initCtx` with `{ conversationId, userId }`, the agent panel's read. `isBenignConversationRead(err)` → 404 `checkin-not-found`; any other throw propagates.
7. `got.conversation.agentId !== key.agentId || got.conversation.userId !== userId` → 404 `checkin-not-found`.
8. Build the thread: `connectors = await connectorNames(userId)` and `approvals = await approvalMessages(userId, key.agentId, conversationId)`, then `thread = [...buildThread(got.turns ?? [], got.displayEvents ?? [], approvals.live, connectors), ...approvals.messages].filter((m) => m.kind !== 'user')`.
9. 200 `toTaskCheckin(agent, view, fire, thread, approvals.status)`.

Two short comments in the handler: no `withMemoryUsed`, because routine runs record no recall receipts and the memory chip edits memory (row 6); and why user rows drop (row 5).

`toTaskCheckin` builds `{ taskName: fenceLine(view.name, ROUTINE_NAME_MAX_CHARS) ?? 'Untitled task', agentName: agent.displayName, checkIn: toTaskUpdate(fire), triggerSource: fire.triggerSource, thread, decisions: { status } }`.

**Comments and strings (exact):**
- Header list, after the `/notes` line: `GET  /api/workspace/tasks/:agentId/:routineId/checkins/:conversationId — one check-in's transcript, read-only (TASK-911)`.
- Security paragraph: the check-in route joins the task page's routes in the `agents:resolve`-first list, and this sentence follows "…before deciding that.": "A check-in's transcript (TASK-911) must also be one of that task's newest 200 check-ins before its conversation is read, and `conversations:get` checks again that it is the caller's own."
- `plugin.ts` header, after the TASK-910 sentence: "TASK-911 adds no call either: a check-in's page reads the same optional routines:get and routines:recent-fires, then its conversation through the hard conversations:get, and answers 404 without routines."
- The `routines:get` comment gains "TASK-911's check-in page reads both too." Its degradation becomes `'the task page (GET /api/workspace/tasks/:agentId/:routineId) and its check-ins (GET /api/workspace/tasks/:agentId/:routineId/checkins/:conversationId) answer 404, because without @ax/routines there are no tasks'`.
- `routines:recent-fires` becomes `'the task page and its check-ins answer 404, as they do without routines:get (both come from @ax/routines)'`.

- [ ] **Step 1: Write the failing tests.**
  - **Setup.** Copy `mkReq`, `mkRes`, `initCtx`, `stored`, `report`, the `World` and `setup` pattern and `TEAM_AGENTS` from `routes-workspace-task.test.ts`, with the real `routineView` behind `routines:get`. `routines:recent-fires` answers the world's fires whose `routineId` is the input's, newest first. Add to the world:
    - `conversations`: per id, `{ userId, agentId, turns, displayEvents }`. `conversations:get` mirrors the producer: an unknown id or another user's conversation throws `new PluginError({ code: 'not-found', … })`, and each call is recorded.
    - `decisions`: `null` means no `decisions:list` service; otherwise its rows. Copy a decision row and the `decisions:list` stub from the approval tests in `routes-workspace.test.ts` (around :3225).
    - `convFailure` and `firesFailure`.
    - Copy turn fixtures from `routes-workspace.test.ts:1513-1600` (text, `tool_use`, `tool_result`, `thinking`).
  - `shows a check-in’s transcript: what the agent said and the tools it ran`:
    - The fire is `{ conversationId: 'c1', triggerSource: 'tick', status: 'ok', report: { status: 'on-track', update: 'Queue is empty.', ask: null } }`.
    - Conversation c1 belongs to alice on a1. It holds a user turn `'Scheduled check-in.\n\n> NOTES-TEXT'`; an assistant turn with text `'Checking the queue.'` and a `tool_use` named `Bash` with input `{ command: 'pnpm test' }`; its `tool_result`; and an assistant turn `'Queue is empty.'`.
    - The body has `taskName`, `agentName: 'Caveman'` and `checkIn: { firedAt, status: 'ok', error: null, report: { status: 'on-track', update: 'Queue is empty.' }, conversationId: 'c1' }`. It also has `triggerSource: 'tick'` and `decisions: { status: 'unavailable' }`.
    - `thread` holds a `steps` row whose step text contains `'pnpm test'`, and an `agent` row `'Queue is empty.'`.
  - `never draws the check-in message the host sent, as if the person had said it`: no thread row has `kind: 'user'`, and `JSON.stringify(body)` doesn't contain `NOTES-TEXT`.
  - `keeps the model’s scratchpad off the wire`: a `thinking` block reading `'SCRATCHPAD-TEXT'` is absent from the JSON.
  - `reads the task’s newest 200 check-ins and the conversation, both as the caller`: the recent-fires call is `{ userId: 'alice', input: { agentId: 'a1', routineId: 't1', limit: 200 } }`, and the conversation calls are `[{ conversationId: 'c1', userId: 'alice' }]`.
  - `404s another task’s check-in on the same agent, without reading it`: alice owns tasks t1 and t2. The id `c-t2` is t2's fire and alice's conversation → `{ error: 'checkin-not-found' }`, with no conversation call.
  - `404s the caller’s own chat with the same agent, without reading it`: `chat-1` belongs to alice on a1 but isn't a fire → 404, with no conversation call.
  - `404s someone else’s task on a team agent, and reads neither its check-ins nor the conversation`: Bob's task on `team` → `task-not-found`. There is no recent-fires or conversation call, and no `BOB-` text in the body.
  - `404s a repeat routine, and reads neither`: `task-not-found`, with no recent-fires or conversation call.
  - `404s an agent the caller can’t reach, reading nothing`: `agent-not-found`, with no `routines:get` call.
  - `404s a check-in whose conversation isn’t the caller’s, or isn’t this agent’s`: an earlier owner's conversation (the stub throws `not-found`) → `checkin-not-found`. The stub answering `agentId: 'a2'` → `checkin-not-found`.
  - `a transcript or a history that can’t be read fails the request`: `convFailure = new Error('db down')` makes `handlers.taskCheckin(…)` reject, and so does `firesFailure`.
  - `shows an approval the check-in is still waiting on, and only that one`: d1 is open in c1 and d2 is open in `c-other`. The thread ends with `{ kind: 'approval', id: 'decision-d1', decisionId: 'd1' }`, holds no d2, and `decisions.status` is `'ok'`.
  - `fences the report it ended with, and a failed check-in’s reason`: a report update `'first\nsecond'` → `'first second'`. An `error` fire with `error: 'line one\nline two'` → one line.
  - `it.each(['tick', 'manual', 'webhook'])('says what started it: %s')`: `triggerSource` passes through.
  - `401s without a session`. `400s an empty check-in id` (`conversationId: '  '`, and nothing past `auth:require-user` is called). `404s in a deployment without routines`.
  - Registration:
    - `toContain('GET /api/workspace/tasks/:agentId/:routineId/checkins/:conversationId')`.
    - `only one route reaches a check-in, and it only reads`: the routes whose path contains `/checkins` equal `[{ method: 'GET', path: '/api/workspace/tasks/:agentId/:routineId/checkins/:conversationId' }]`.
  - `plugin.test.ts`: the two new degradation strings.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/__tests__/server/routes-workspace-checkin.test.ts src/__tests__/server/routes-workspace-registration.test.ts src/__tests__/server/plugin.test.ts`.
- [ ] **Step 3: Implement** the helper, the refactor, the handler, the route and the strings.
- [ ] **Step 4: Run them (PASS), plus `src/__tests__/server/routes-workspace-task.test.ts` untouched (the refactor), then** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/channel-web test src/__tests__/server` (six existing files there start Postgres) **and** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Run `security-checklist`** and keep its note for the PR:
  - **Authorization:** identity comes from the session. `agents:resolve` runs before any read. Owner-only twice: `isOwnTask` implies the owner, and `conversations:get` filters on the user. No history is read before the ownership decision, and no conversation is read before fire membership. Every miss is a 404 whose body doesn't depend on whether the conversation exists.
  - **Prompt injection:** the transcript is model and tool output, built by `buildThread`, the agent view's projection. It carries text blocks only (J4); each tool step is one fenced line; a failure is a code plus a bounded detail. Host-written user rows are dropped, and the report and reason are fenced.
  - **No write path:** one GET, calling read hooks only. `decisions:list` runs the decisions plugin's own expiry sweep, as every queue read does.
  - **Residual:** a check-in's conversation id now reaches its owner's browser, which makes the chat-POST follow-up above reachable by the owner alone.
  - No sandbox, IPC or dependency change.
- [ ] **Step 6: Commit:** `git commit -m "Agent Tasks: GET one check-in’s transcript, for its task’s owner only (TASK-911)"`

### Task 3: The brief veto's words in a transcript [tier: mechanical]

**Files:**
- Modify: `lib/turn-error-labels.ts` (`ERROR_LABELS`, :48)
- Test: `lib/__tests__/turn-error-labels.test.ts`

**Interfaces:**
- Produces: `ERROR_LABELS['system-prompt:brief-missing']` and `['system-prompt:brief-too-long']`, worded exactly as routines' run errors `BRIEF_DIDNT_LOAD` and `BRIEF_TOO_LONG` (`packages/routines/src/brief.ts:95-97`). Comment (exact): "TASK-911: a task check-in that routines refused because its instructions didn't load (TASK-908's veto). Only that check-in's own transcript shows this row, where the default sentence would be false: nothing stopped, and there is nothing to retry. The words are routines' own run errors, pinned by the test, so the summary above the transcript and the row in it agree."

- [ ] **Step 1: Write the failing tests.** Import `BRIEF_DIDNT_LOAD` and `BRIEF_TOO_LONG` from `'../../../../routines/src/brief.js'`.
  - `a check-in its instructions blocked says so, in routines’ own words`: `turnErrorText('system-prompt:brief-missing')` is `BRIEF_DIDNT_LOAD`, and `turnErrorText('system-prompt:brief-too-long')` is `BRIEF_TOO_LONG`.
  - `another refusal of the same kind keeps the general sentence`: `turnErrorText('system-prompt:other')` is `DEFAULT_TURN_ERROR`.
- [ ] **Step 2: Run and watch it fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/turn-error-labels.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit:** `git commit -m "Agent Tasks: a check-in its instructions blocked says so in its transcript (TASK-911)"`

### Task 4: The page's read, in the browser [tier: integration]

**Files:**
- Modify: `lib/workspace-api.ts`: guard `isTaskCheckin` after `isTaskDetail` (:490-510); `taskCheckinPath` beside `taskPath` (:512); method `taskCheckin` after `task` (:936-945)
- Create: `lib/workspace-task-checkin.ts`
- Test: create `lib/__tests__/workspace-api-task-checkin.test.ts` and `lib/__tests__/workspace-task-checkin.test.ts`

**Interfaces:**
- Consumes: `TaskCheckin` (T1); `TaskReadError` (`lib/workspace-task.ts`).
- Produces:

```ts
// lib/workspace-api.ts
workspaceApi.taskCheckin(agentId: string, routineId: string, conversationId: string): Promise<TaskCheckin>;
// GET /api/workspace/tasks/<enc>/<enc>/checkins/<enc>, through checkedRead + isTaskCheckin
// lib/workspace-task-checkin.ts
export type TaskCheckinState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: TaskCheckin; refreshing: boolean; refreshFailed: boolean }
  | { kind: 'failed'; error: TaskReadError };
export function useTaskCheckin(
  agentId: string,
  routineId: string,
  conversationId: string,
): { state: TaskCheckinState; refresh: () => void };
```

The ready state's field is `page`, not `checkin`, so it can't be mistyped as the wire's `checkIn` (`state.page.checkIn`). `isTaskCheckin` checks:
- `isString(taskName)` and `isString(agentName)`;
- `isTaskUpdate(checkIn)`;
- `triggerSource` is one of `RoutineFireViewSchema.shape.triggerSource.options` (the contract's words, not a second copy);
- `thread` is an array whose every row `isRecord` with string `kind` and `id`;
- `decisions.status` is one of `'ok'`, `'unavailable'` or `'failed'`.

The thread gets no deeper check: the agent panel's own read trusts its rows the same way. `useTaskCheckin` copies `useTask` (`lib/workspace-task.ts:42-84`) exactly, logging with `logRequestFailure(e, 'workspace-task-checkin')`.

- [ ] **Step 1: Write the failing tests.**
  - API (copy `respondWith` from `workspace-api-task.test.ts`):
    - `reads one check-in from its own address, each id encoded`: `fetch` is called with `'/api/workspace/tasks/a%2F1/t%201/checkins/c%3F1'`.
    - `refuses a check-in that names a start it doesn’t know` (`triggerSource: 'cron'`), `refuses one without a transcript`, and `refuses one whose check-in isn’t one` (`checkIn: {}`). Each throws `WorkspaceShapeError`.
    - `carries the status of a failed read`: a 404 rejects as `WorkspaceApiError` with `status: 404`. The hook's gone state depends on it.
  - Hook: mirror all eight tests in `workspace-task.test.ts` (:54-190), mocking the module the same way, with the task renamed to a check-in:
    - `starts loading, then holds the check-in`.
    - `calls a 401 expired, a 404 gone and anything else failed`.
    - `a Try again after a failed read goes back through loading`.
    - `refreshes in place, keeping the transcript on screen`.
    - `a refresh that fails keeps the transcript, marked`.
    - `a refresh that finds the check-in gone says gone`.
    - `a refresh that finds the session ended stops showing the transcript`.
    - `drops an older answer that lands after a newer one`.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-api-task-checkin.test.ts src/lib/__tests__/workspace-task-checkin.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit:** `git commit -m "Agent Tasks: the check-in page reads its transcript (TASK-911)"`

### Task 5: A check-in's address [tier: mechanical]

**Files:**
- Modify: `lib/workspace-route.ts`: the union (:55-61), `parseWorkspaceRoute` (:113-158: destructure a sixth segment at :121, the tasks branch :123-130), `workspaceRoutePath` (:160-178)
- Modify: `components/workspace/WorkspaceShell.tsx:806-807` (the sidebar's `route` mapping only)
- Test: `lib/__tests__/workspace-route.test.ts`

**Interfaces:**
- Produces: `WorkspaceRoute` gains `{ kind: 'task-checkin'; agentId: string; routineId: string; conversationId: string }` at `/workspace/tasks/<agentId>/<routineId>/checkins/<conversationId>`. `routeAgentId` of it is null.

**Rules:**
- **Parse.** In the tasks branch, once both ids parse: when the fifth segment is exactly `checkins` and the sixth passes `parseIdSegment`, it is a check-in. Otherwise it stays the task route, as today, and a tail past the conversation id is dropped.
- **Path.** `` `${WORKSPACE_ROOT_PATH}/tasks/${encodeURIComponent(agentId)}/${encodeURIComponent(routineId)}/checkins/${encodeURIComponent(conversationId)}` ``.
- **Shell.** The mapping becomes `route.kind === 'agent-settings' ? 'agent' : route.kind === 'task' || route.kind === 'task-checkin' ? 'tasks' : route.kind`. Nothing mounts for the new kind until Task 9.

- [ ] **Step 1: Write the failing tests:**
  - `reads a check-in’s path`: `/workspace/tasks/a1/t1/checkins/c1` and `…/checkins/c1/extra` read as the check-in. `/workspace/tasks/a%2F1/t%201/checkins/c%201` reads as `{ agentId: 'a/1', routineId: 't 1', conversationId: 'c 1' }`.
  - `falls back to its task for a check-in path it can’t read`: `/workspace/tasks/a1/t1/checkins`, `…/checkins/..`, `…/checkins/%E0%A4%A` and `/workspace/tasks/a1/t1/other/c1` each read as `{ kind: 'task', agentId: 'a1', routineId: 't1' }`.
  - `writes a check-in’s path`: → `/workspace/tasks/a%2F1/t%201/checkins/c%201`.
  - `ROUTES` gains `{ kind: 'task-checkin', agentId: 'a/1', routineId: 't 1', conversationId: 'c/1' }`, and `routeAgentId` of it is null. The existing `/workspace/tasks/a1/t1/extra` → task assertion stays.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-route.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it plus `src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx` (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit:** `git commit -m "Agent Tasks: a check-in has its own address (TASK-911)"`

### Task 6: The agent view's renderer, ready to reuse [tier: mechanical]

**Files:**
- Modify: `components/workspace/AgentConversation.tsx`:
  - the header (:1-8);
  - `Props.agent` (:200) and `Message`'s `agent` (:1036) both become `Pick<WorkspaceAgent, 'id' | 'name'>`, the only fields the file reads;
  - new exported `approvalReadFrom` after `ApprovalRead` (:114).
- Modify: `components/workspace/AgentView.tsx:1592-1600` (use it)
- Test: create `components/workspace/__tests__/approval-read.test.ts`

**Interfaces:**
- Produces:

```ts
/**
 * How a thread's approval cards were read: the server's per-thread read folded with the queue's (AgentView's rule,
 * shared with a check-in's page, TASK-911). An expired session outranks a failed read, because Try again can't fix it.
 */
export function approvalReadFrom(thread: WorkspaceReadStatus, queueError: DecisionReadError | null): ApprovalRead;
```

**Rule:** `queueError?.kind === 'expired'` → `'expired'`; else `thread === 'failed' || queueError !== null` → `'failed'`; else `thread`. AgentView becomes `excerptOpening ? 'ok' : approvalReadFrom(shownRead, decisionsError)`, and its comment block stays. Header (exact), replacing "Past conversations live in the rail; routine fires never appear here at all, or 612 unattended runs would bury the two conversations the human actually had.": "Past conversations live in the rail, and routine fires never appear in this thread, or 612 unattended runs would bury the two conversations the human actually had. A task's check-in is read on its own page instead (`TaskCheckinPage`, TASK-911), which draws it with this component, read-only. That is why `agent` is only an id and a name."

- [ ] **Step 1: Write the failing test:**
  - `a session that ran out outranks everything`: `('failed', expired)` and `('ok', expired)` → `'expired'`.
  - `either read failing is a failed read`: `('failed', null)`, `('ok', { kind: 'failed', detail: '' })` and `('unavailable', failed)` → `'failed'`.
  - `otherwise it is the thread’s own read`: `'ok'` → `'ok'`, and `'unavailable'` → `'unavailable'`.
- [ ] **Step 2: Run and watch it fail:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/approval-read.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it plus the 20 `AgentConversation*` and `AgentView*` test files (PASS, untouched),** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/AgentConversation src/components/workspace/__tests__/AgentView` (vitest takes them as path filters), **then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit:** `git commit -m "workspace: the agent thread takes only an agent’s id and name, and shares how its approvals were read (TASK-911)"`

### Task 7: See what it did, on the task page [tier: integration] (invoke `shadcn` and `ux-design`)

**Files:**
- Modify: `lib/task-updates.ts` (append); test `lib/__tests__/task-updates.test.ts`
- Modify: `components/workspace/TaskUpdates.tsx`: the header (:17-18); props; `entryText` moves out; the link in `UpdateEntry`
- Modify: `components/workspace/TaskPage.tsx`: `TaskUpdates` (:524) and `LatestUpdate` (:560) get `agentId`, `routineId` and `onNavigate`; the link in `CheckedLine` (:604-622)
- Test: `components/workspace/__tests__/TaskUpdates.test.tsx`, `components/workspace/__tests__/TaskPage.test.tsx`

**Interfaces:**
- Consumes: `TaskUpdate.conversationId` (T1); the `task-checkin` route (T5); `routeLinkProps`, `updateStamp`.
- Produces:

```ts
// lib/task-updates.ts
/** What an Updates entry says: the agent's update, or why there isn't one (TASK-910's words, now shared with a check-in's page). */
export function updateText(update: Pick<TaskUpdate, 'status' | 'report'>): string;
/** The check-in the task's latest update came from (TASK-911, decisions row 12), or null. */
export function latestUpdateCheckIn(
  task: Pick<TaskDetailReport, 'status' | 'update'> | null,
  updates: readonly TaskUpdate[],
): string | null;
// components/workspace/TaskUpdates.tsx
export function TaskUpdates(props: {
  updates: TaskUpdate[];
  now: Date;
  agentId: string;
  routineId: string;
  onNavigate: (route: WorkspaceRoute) => void;
}): JSX.Element;
```

**`updateText`** is `TaskUpdates.tsx`'s `entryText`, moved without a word changed. The module's header (:1-11) gains (exact): "It also says what an entry says (`updateText`, shared with a check-in's page) and which check-in the latest update came from (`latestUpdateCheckIn`, TASK-911)." **`latestUpdateCheckIn`**:
- `task === null` → null.
- Take the first entry with `report !== null`. None, or its `conversationId` null → null.
- When its `report.status` and `report.update` equal the task's → its `conversationId`. Otherwise null.
- Comment: why. A check-in still running when the page was read has already reported, but it isn't in Updates until it finishes (`finishDispatch` writes the fire row). Without the equality check, the card would open the check-in before it, which said something else. One that repeated the earlier report word for word still links to the earlier check-in, which ended with that same report. The exact signal would be the run's start (`task_report_accepted_at`), which the task view doesn't carry (decisions row 12).

**The link (exact):**
- An `<a {...routeLinkProps({ kind: 'task-checkin', agentId, routineId, conversationId }, onNavigate)}>` reading `See what it did`.
- In an Updates entry it comes after the body as `shrink-0 leading-5`, followed by `<span className="sr-only">, {stamp}</span>` (left out when the stamp is null).
- On the latest update card it is the last ` · `-separated part of `CheckedLine`, with no hidden suffix.
- Classes: the brief's settings link in `TaskPage.tsx` (`rounded-sm text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground` plus `RESOLUTION_FOCUS_RING`).
- No link when the entry's `conversationId` is null.
- The `TaskUpdates` header's last paragraph becomes (exact): "Each entry links to that check-in's transcript, read-only (See what it did, TASK-911), when the check-in recorded one. It is a real link, so it opens in a new tab too, and its name carries the entry's time, so a list of them still says which is which."

- [ ] **Step 1: Invoke `shadcn` and `ux-design`** for the link's affordance and its name. No component is added. If `ux-design` changes copy, change the tests with it.
- [ ] **Step 2: Write the failing tests:**
  - `task-updates.test.ts`:
    - `updateText` gets TASK-910's four sentences: the update; `It left an update we can’t show.` for a null or empty update; `This check-in didn’t finish.` for an error with no report; `Checked in but didn’t leave an update` otherwise.
    - `the latest update came from the newest check-in that left one`: updates are an error with no report (`c3`), then on-track `'Queue is empty.'` (`c2`), then an older report (`c1`). With task `{ status: 'on-track', update: 'Queue is empty.' }` → `'c2'`. The test's comment says this is also the answer while a check-in that repeated those exact words is still running: the data can't tell the two apart, and row 12 accepts it.
    - `none while a check-in that said something new is still running`: a different update → null, and a different status → null.
    - `none for a task that hasn’t reported, or a check-in that recorded no conversation`.
    - `none when no check-in in Updates left a report`.
  - `TaskUpdates.test.tsx`: the render helper passes `agentId: 'a1'`, `routineId: 't1'` and `onNavigate`.
    - `each check-in links to what it did`: an entry with `conversationId: 'c1'` has a link named `See what it did, ${updateStamp(firedAt, now)}` with href `/workspace/tasks/a1/t1/checkins/c1`. A plain click calls `onNavigate({ kind: 'task-checkin', agentId: 'a1', routineId: 't1', conversationId: 'c1' })` once; a ctrl-click doesn't.
    - `a check-in that recorded no conversation has no link`.
    - `a folded check-in links too`: six on-track entries, each with its own `conversationId` (the `onTrack` factory's default is null since T1). One link before the fold opens, and 6 after.
    - Delete `leaves room after an update for a link to follow` (the first test replaces it). `draws an update as plain text` keeps its `a`-free assertion, since its entries' ids are null.
  - `TaskPage.test.tsx`:
    - `the latest update links to the check-in it came from`: within the `Latest update` region, `See what it did` has href `/workspace/tasks/a1/t1/checkins/c1`.
    - `no link while a check-in with a new update is still running`: the card's update differs from the newest reported entry's.
- [ ] **Step 3: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/lib/__tests__/task-updates.test.ts src/components/workspace/__tests__/TaskUpdates.test.tsx src/components/workspace/__tests__/TaskPage.test.tsx`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run them plus `src/components/workspace/__tests__/no-fixtures.test.ts` and `src/__tests__/theme-contrast.test.ts` (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 6: Commit:** `git commit -m "Agent Tasks: See what it did, on each update and the latest one (TASK-911)"`

### Task 8: The check-in page [tier: sensitive] (security-checklist; invoke `shadcn` and `ux-design`)

**Files:**
- Create: `components/workspace/TaskCheckinPage.tsx`; test `components/workspace/__tests__/TaskCheckinPage.test.tsx`

**Interfaces:**
- Consumes:
  - from earlier tasks: `useTaskCheckin` (T4), `TaskCheckin` (T1), `AgentConversation` and `approvalReadFrom` (T6), `updateText` (T7);
  - from the codebase: `routeLinkProps`, `checkInWhen`, `TASK_GROUP_LABELS`, `StateDot`, `StateDotSlot`, `WorkspaceHeader`, `Breadcrumb*`, `Alert`, `Button`, `Spinner`, `HTTP_SESSION_ENDED`, `readAlertVariant`.
- Produces (the decision props take `DecisionQueue`'s types for the same members, `lib/workspace-decisions.ts:258-273`; AgentView types `onApprove` as `(id) => void` and so hides the Always Allow scope, so don't copy it):

```ts
export function TaskCheckinPage(props: {
  agentId: string; routineId: string; conversationId: string;
  leading?: ReactNode;
  onNavigate: (route: WorkspaceRoute) => void;
  decisions: Decision[];
  onApprove: (id: string, scope?: 'once' | 'agent-routines') => void;
  onDismiss: (id: string) => void;
  onUndo: (id: string) => void;
  busyIds?: ReadonlySet<string>;
  notices?: ReadonlyMap<string, string>;
  decisionsError: DecisionReadError | null;
  onRetryDecisions: () => void;
}): JSX.Element;
```

**Layout (decisions rows 7, 8, 14).** Below, `page` is the ready state's `TaskCheckin` and `checkIn` is `page.checkIn`.
- **`WorkspaceHeader`.**
  - `title`: `Check-in ${checkInWhen(checkIn.firedAt, now)}` once ready, or `Check-in` before then or when the time can't be read.
  - `leading`: `leading`, then `Breadcrumb > BreadcrumbList`. It holds `Tasks` (`{ kind: 'tasks' }`), a separator, the task (`{ kind: 'task', agentId, routineId }`) and a separator. The task crumb reads `taskName` once ready and `Task` before, clamped (`max-w-[16rem] truncate`) with `title={taskName}`. Each crumb is `BreadcrumbLink asChild` around an `<a {...routeLinkProps(…)}>`.
  - No header actions.
- **The body** is `flex min-h-0 flex-1 flex-col`.
  - **Loading:** a centred `Spinner`.
  - **Failed:** an `Alert` in `readAlertVariant(error)`, in `TaskPage`'s centred frame.
  - **Ready, in order:**
    1. **Refresh failed:** a destructive alert with Try again, when `refreshFailed`.
    2. **The summary:** a `<section aria-labelledby>` with an `sr-only` `h2` reading `How this check-in went`, in the past-conversation banner's frame (`border-b border-border bg-muted px-6 py-3`). With a report it has a line with `StateDot state={report.status}` and `TASK_GROUP_LABELS[report.status]`, then `updateText(checkIn)` as plain text (`whitespace-pre-wrap break-words`). Without a report it has `StateDot state="no-update"` beside `updateText(checkIn)`. For `'error'` a muted line follows: `checkIn.error ?? 'No reason was recorded.'`. Last comes the muted meta line.
    3. **The transcript:** with no rows, a muted line, and `AgentConversation` isn't mounted. Otherwise `AgentConversation` with:
       - `agent={{ id: agentId, name: page.agentName }}`, `thread={page.thread}`, `conversationId={conversationId}`, `decisions`, `readOnly`;
       - `onSend={NO_SEND}`, `onApprove`, `onDismiss`, `onUndo`, `busyIds`, `notices`;
       - `approvalRead={approvalReadFrom(page.decisions.status, decisionsError)}`;
       - `onRetryApprovals={() => { onRetryDecisions(); refresh(); }}`;
       - `grants={NO_GRANTS}`, `onGrantResolved={IGNORE}`, `onGranted={NOT_GRANTED}`.

       Pass no `busy`, `onStop`, `stopping`, `settling`, `failureStripShown` or `conversationKey`.
- **`now`** is state, reset in `useLayoutEffect` whenever the check-in changes (`TaskBody`'s rule).
- **Module constants, each commented:**
  - `NO_SEND`: it does nothing. The composer isn't drawn read-only and this page holds no way to send, so a composer drawn by mistake would still reach nothing.
  - `NO_GRANTS`: presence routes a grant only to the agent's own thread; Today shows them.
  - `IGNORE`.
  - `NOT_GRANTED = async () => false`.

**Copy (exact):**

| Where | Text |
|---|---|
| Title | `Check-in {checkInWhen}`, e.g. `Check-in at 10:02 AM`; `Check-in` before ready |
| Crumbs | `Tasks` › `{taskName}` (`Task` before ready) |
| Meta line | `{agentName} · {why} · read-only` |
| Why | tick: `On its schedule` · manual: `Started outside its schedule` · webhook: `Started by an update from another app` |
| Reason | `{error}`, or `No reason was recorded.` |
| No rows | `There’s nothing else to show from this check-in.` |
| Load failed | `We couldn’t load this check-in just now. Nothing was lost.` with `Try again` |
| Gone | `We couldn’t find this check-in. It may be too old to open here, or it belongs to someone else.` with no button |
| Expired | `HTTP_SESSION_ENDED` with no button |
| Refresh failed | `We couldn’t refresh this check-in just now, so what you see may be out of date.` with `Try again` |

- [ ] **Step 1: Invoke `shadcn` and `ux-design`** for the header, the crumbs and the summary. Everything used is installed. If `ux-design` changes copy, change the tests with it, and keep "Started outside its schedule" free of any claim about who started it.
- [ ] **Step 2: Write the failing tests.**
  - **Setup.** Mock `@/lib/workspace-api` as `{ ...actual, workspaceApi: { taskCheckin: vi.fn() } }`. Add a `page(over)` helper building a `TaskCheckin`, and a props helper with `vi.fn()` handlers. Where times matter, use `vi.useFakeTimers({ shouldAdvanceTime: true })` and `vi.setSystemTime(NOW)`, and build expected times from `localTime`. Build the decision with `decisionFixture` (`__tests__/decision-fixture.ts`) as `decisionFixture({ id: 'd1', primaryLabel: 'Allow', preview: { meta: '', body: 'Original draft' } })` (`AgentConversationEdit.test.tsx:16-18`), so "Edit first" would show if editing were on.
  - `says when it ran, why, and how it ended`: the level-1 heading is `Check-in at ${localTime(firedAt)}`. The meta line is `Caveman · On its schedule · read-only`. `Needs you` and the update show.
  - `says a check-in started outside its schedule, without saying who started it`: `manual` → `Caveman · Started outside its schedule · read-only`; `webhook` → `… Started by an update from another app …`.
  - `a check-in that didn’t finish says so, with its reason`: `This check-in didn’t finish.` and its reason; a null reason → `No reason was recorded.`.
  - `shows the tools it ran`: a `steps` row (`stepsLabel: '2 steps'`, steps `Ran pnpm test` done and `Send email` failed). `getByTestId('workspace-steps')` holds both.
  - `offers no way to send, stop, retry or continue`: an open approval is in the thread and in `decisions`. There is no `textbox`; no button named `/send|stop|resend|retry|continue|edit first/i`; and no `[data-testid="composer-announcer"]`.
  - `answers an approval it is still waiting on, through the queue`: clicking `Allow` calls `onApprove` with `'d1'`.
  - `draws the agent’s words as the agent view does, and its report as plain text`:
    - The agent row is `'**Done** ![x](https://x.test/a.png) <img src=x onerror=alert(1)>'`, and no `img` is in the document.
    - The report update is `'**bold** <b>x</b>'`. The summary section's text is exact, with no `strong` or `b` inside it.
  - `says when there’s nothing else to show`: an empty thread shows the line, and there is no region named `Conversation with Caveman`.
  - `a check-in its instructions blocked reads as that`: an `error` row with `reason: 'system-prompt:brief-missing'` shows the `BRIEF_DIDNT_LOAD` sentence, and `stopped unexpectedly` is absent (T3).
  - `the crumbs lead back to Tasks and to the task`:
    - The hrefs are `/workspace/tasks` and `/workspace/tasks/a1/t1`, and the second crumb reads the task's name.
    - Clicks call `onNavigate` with `{ kind: 'tasks' }` and `{ kind: 'task', agentId: 'a1', routineId: 't1' }`.
  - `a check-in that isn’t there or isn’t yours says so, with no Try again` (404). `a failed read offers Try again, and an expired session asks to sign in again`.
  - `Try again under its approvals reads the queue and the check-in again`: `decisions.status: 'failed'`, then Try again → `onRetryDecisions` is called once, and `taskCheckin` twice.
- [ ] **Step 3: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/TaskCheckinPage.test.tsx`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run it plus `no-fixtures.test.ts` and `theme-contrast.test.ts` (PASS), then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 6: Run `security-checklist`** and add to Task 2's note:
  - The transcript is drawn only by the agent view's renderer (markdown that shows images as alt text, so model output can't make the browser fetch), and the summary is plain text.
  - The page holds no send, stream, bind or Stop. `readOnly` hides the composer and turns off "Edit first", and `onSend` does nothing.
  - An approval is answered through the queue's owner-checked routes, as on Today. For a check-in's decision (unattended, `origin: 'routine'`) that never binds a session or opens a stream, because `streamReqId` is null. Approve runs the held step on the host, or leaves the agent's next run allowed to take it, exactly as on Today.
  - Grants aren't drawn here.
- [ ] **Step 7: Commit:** `git commit -m "Agent Tasks: a check-in’s own page, read-only (TASK-911)"`

### Task 9: Open a check-in, and the design doc [tier: integration]

**Files:**
- Modify: `components/workspace/WorkspaceShell.tsx`: the header's view list (:10-14), and the mount beside `TaskPage` (:933-941)
- Modify: `components/workspace/__tests__/WorkspaceShellRouting.test.tsx` (`taskCheckin: vi.fn()` in the mock; two tests, modelled on :173-181)
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`: §3.3's first bullet (:204-208), and §15 (append)

**Interfaces:**
- Consumes: `TaskCheckinPage` (T8); `queue` (`useDecisionQueue`, :342-345).

Mount (exact props):

```tsx
{route.kind === 'task-checkin' && (
  <TaskCheckinPage
    key={JSON.stringify([route.agentId, route.routineId, route.conversationId])}
    agentId={route.agentId} routineId={route.routineId} conversationId={route.conversationId}
    leading={navTrigger} onNavigate={navigate}
    decisions={queue.decisions} onApprove={queue.approve} onDismiss={queue.dismiss} onUndo={queue.undo}
    busyIds={queue.busyIds} notices={queue.notices} decisionsError={queue.error}
    onRetryDecisions={() => void queue.refresh()}
  />
)}
```

The header's view list gains `/workspace/tasks/<agentId>/<routineId>/checkins/<conversationId>`.

**Design doc (rule 5, decisions row 16).** In §3.3's first bullet, replace "Today's agent URL carries no conversation id, and a check-in that is the agent's latest chat would open live with a composer, so this needs a task-scoped, read-only transcript view." It is wrapped across lines 206–208 with two-space continuation indents, so match it across the line breaks and keep the bullet's wrapping. Replace it with (exact): "A check-in's conversation is hidden, so the agent view never lists it, and the agent URL carries no conversation id, so this needs a task-scoped, read-only transcript view."

After the bullet list, add (exact):

> PR 1 (TASK-911): See what it did opens `/workspace/tasks/<agentId>/<routineId>/checkins/<conversationId>`, for the task's owner, for any of its newest 200 check-ins. It says when and why the check-in ran and the report it ended with. Then come what the agent said, each tool it ran as one line (the tool, what it ran on, and whether it worked, failed or is waiting), its approval cards and any failure. Not shown: the check-in message the host sent the agent, which would read as the person's own words, and each tool's full input and output, which the workspace has never shown.

Append to §15 (exact):

```markdown
| 2026-10-22 | Decided | A check-in’s transcript opens read-only from its task’s page, only for the task’s owner and only for one of its newest 200 check-ins; anything else is a 404. Nothing on the page can send into, stop or continue the check-in, and an approval in it is answered as on Today (TASK-911). |
| 2026-10-22 | Decided | The transcript shows what the agent said and did as the agent view draws it: each tool as one line, never its full input or output, and not the host-written check-in message (TASK-911). |
```

- [ ] **Step 1: Write the failing tests:**
  - `opens a check-in from its own URL, with Tasks active in the sidebar`: `renderAt('/workspace/tasks/a1/t1/checkins/c1')`. The level-1 heading starts with `Check-in`, the `Tasks` button has `data-active="true"`, and `taskCheckin` was called with `('a1', 't1', 'c1')`.
  - `See what it did on a task opens that check-in at its own address`: from `/workspace/tasks/a1/t1`, with an update whose `conversationId` is `'c1'`, clicking the link makes `window.location.pathname` `/workspace/tasks/a1/t1/checkins/c1`, and the check-in's heading shows. The card and the entry can both link, so pick the entry's by its name (`/^See what it did, /`). Model the test on `a Tasks row leaves the task’s address behind` (:183-205).
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx`.
- [ ] **Step 3: Implement** the mount and the comment, then edit the design doc.
- [ ] **Step 4: Run the whole package and the type-check:** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/channel-web test` and `pnpm --filter @ax/channel-web exec tsc --build`. The other shell tests mock `workspaceApi` as a closed object and pass untouched, because `useTaskCheckin` runs only inside the page.
- [ ] **Step 5: Commit:** `git commit -m "Agent Tasks: open a check-in from its task (TASK-911)"`

---

## Card acceptance → tests

| Card acceptance | Test |
|---|---|
| Route returns the transcript for one of the routine's fires | T2 `shows a check-in’s transcript…` |
| 404: another routine of the same agent, an ordinary chat, another user's task, a repeat routine | T2 `404s another task’s check-in…`, `…the caller’s own chat…`, `…someone else’s task…`, `…a repeat routine…` |
| No write route under `/checkins/` | T2 `only one route reaches a check-in, and it only reads` |
| The transcript renders tool calls | T2 (a `steps` row); T8 `shows the tools it ran` |
| No composer, interrupt or continue control | T8 `offers no way to send, stop, retry or continue` |
| The header shows the report | T8 `says when it ran, why, and how it ended` |
| See what it did links point at the right conversation | T7 (Updates, folded entries, the latest update card); T9 (the click lands on the address) |
| Routing round-trip | T5 (`ROUTES`) |
| Reachable from the running app | T9 |

## Before the PR

- **Gates:** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
- **Boundary review:** no new hook and no hook-surface change, so none is required. Say so. The route is HTTP inside channel-web, its wire types live in `packages/channel-web/src/lib/workspace-types.ts`, and its field names (`conversationId`, `triggerSource`) are routines' existing ones.
- **Security note:** combine Tasks 2 and 8, and state the residual risks plainly:
  - the owner can see a check-in's conversation id;
  - the chat POST follow-up;
  - Approve in a transcript runs the held step, exactly as on Today.
- **Deploy:** none in PR 1 yet, and no migration here.
- **Handoff:** list the departures above, the refuted premises, the accepted gaps (decisions row 15) and the YAGNI cuts (row 17). Suggest the two follow-ups.
