# TASK-932 "An approval raised during a check-in names its task" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Today, an approval held during one of the person's task check-ins reads "Held during a check-in on “Zero open support tickets”" instead of "Held during an unattended run · Caveman ended its turn rather than wait", and its expanded row links to the task ("Open task"). Every decision row on the wire carries `checkIn: { routineId, taskName } | null`, so TASK-933 can group a task's approvals under it.

**Architecture:** `@ax/routines` gains one read-only service, `routines:tasks-for-conversations`. Given an agent and up to 200 conversation ids, it answers which ones are check-ins of a task the caller owns. It reads the dispatch rows every run binds its conversation onto (TASK-907), through version 5's conversation index, at most two rows per conversation. channel-web's Today routes ask it once per agent, as the caller, about unattended rows only: `GET /api/workspace/decisions`, the single read and the approve, dismiss and undo answers. They project the answer as a fenced label. If the lookup fails, is absent or is slow, the row gets no label, and the queue never waits for one. On the client, `decisionProvenance` names the task, so the Today row and the check-in transcript's card (TASK-911) change together. The expanded Today row adds an Open task link. No migration, dependency, plugin, shadcn component or `pnpm-lock.yaml` change.

**Tech Stack:** TypeScript, zod 3, kysely raw `sql` on Postgres 16, React 18, shadcn (radix) primitives, Tailwind v3 semantic tokens, vitest + testing-library (`fireEvent`, no user-event). The routines tests run Postgres via testcontainers; the channel-web tests use stubs on a real `HookBus`.

**Spec:** the TASK-932 card body, and `docs/plans/2026-10-20-agent-tasks-design.md` §3.5 (the mock's third row), §3.7 and §4.5. Decisions: `.claude/memory/decisions/2026-10-23-TASK-932.md`, rows counted from the first data row. Read rows 2–12 before Task 2. Each settles something the card left open, or departs from it.

## Global Constraints

- **Migration-free and diff-local.** TASK-930 is being built in parallel. It adds routines schema version 7 and edits `packages/routines/src/{store,services}.ts`, `return-schemas.test.ts`, `canary.test.ts`, channel-web's `routes-workspace.ts`, `lib/workspace-types.ts` and `lib/workspace-api.ts`, in other hunks. Put each addition where this plan says, not at a file's end unless the plan says so. On rebase, keep both sides.
- **The hook name is a string literal** at every `bus.call(...)` and `bus.hasService(...)` in channel-web. `manifest-declarations.test.ts` refuses a computed name, and refuses a call that `plugin.ts` doesn't declare.
- **A label, never an authorization.** Nothing reads `checkIn` to decide anything. Approve, dismiss and undo keep their exact bus inputs.
- **Owner-only.** The store filters `owner_user_id = actorUserId`, and the service passes `ctx.userId`. channel-web calls with `agentWorkspaceCtx(agentId, userId)`, the authenticated caller, and never with `initCtx`.
- **Untrusted text.** The task name is fenced on the server with `fenceLine(name, ROUTINE_NAME_MAX_CHARS) ?? 'Untitled task'` and drawn only as React text. No markdown, no `dangerouslySetInnerHTML`.
- **Copy is exact:** `Held during a check-in on “{taskName}”` (the quotes are U+201C and U+201D), and `Open task`. `ux-design` may adjust placement and styling, not these words.
- **Invisible characters in tests:** write `\u202E`, `\u200B` and the like as escape text. The Write/Edit tools have landed them as raw characters twice (`.claude/memory/mistakes/2026-10-20-TASK-904.md`, `2026-10-22-TASK-907.md`). Check every test file that uses them with: `python3 -c "import sys;t=open(sys.argv[1]).read();print([hex(ord(c)) for c in t if (ord(c)<32 and c not in '\n\t') or 0x7f<=ord(c)<=0x9f or 0x200b<=ord(c)<=0x200f or 0x2028<=ord(c)<=0x202e or 0x2060<=ord(c)<=0x2064 or ord(c)==0xfeff])" <file>`. It must print `[]`.
- **One file at a time:** `pnpm --filter @ax/<pkg> test <path>`. The filter goes before the script, and there is no `--` (`.claude/memory/mistakes/2026-10-20-TASK-904.md`). Check the file count in vitest's summary.
- **Docker:** every routines test file here starts Postgres. Prefix them with `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`. channel-web's new test file needs no Docker. A whole-folder or whole-package channel-web run does, because six existing server files start Postgres.
- **When Docker hangs:** while this plan was written (2026-10-23, about 07:00), `timeout 40 docker version` timed out even though `orbctl status` said Running, and another process's `docker ps` had been hung for over 20 minutes. Check the daemon that way before a Postgres-backed run. If it hangs, wait and retry: the cause may be slowness or a sleeping laptop (`pmset -g log`). Don't restart OrbStack while TASK-930's builder may be running containers. Report a Docker-blocked step as blocked, never as passed.
- **Builds between packages:** `@ax/routines-contract` resolves from `dist/` everywhere (no vitest alias). After Task 1, run `pnpm --filter @ax/routines-contract build` before any routines or channel-web test.
- **Type checks:** routines' `tsc` skips its tests, so after Tasks 2–3 run `pnpm --filter @ax/routines build`. channel-web's `tsc` checks its tests too, so after Tasks 5–7 run `pnpm --filter @ax/channel-web exec tsc --build`.
- **Worktree shell:** run git commands one at a time (no `&&` chains), and spell paths out literally rather than through shell variables. Never name a zsh variable `path` (`.claude/memory/patterns/2026-10-22-TASK-910.md`, `mistakes/2026-10-22-TASK-912.md`).
- **TDD:** run each new test against the unchanged code and watch it fail before changing the source.
- **Baseline (measured at 21448a93b, no Docker):** these ten channel-web files this plan touches all pass, 470 tests: `DecisionRow`, `TodayView`, `decision-renderers`, `TaskCheckinPage`, `ApprovalCard`, `consent-focus`, `workspace-api-decision-shape`, `server/plugin`, `server/manifest-declarations` and `server/routes-workspace`. So does all of `src/components/workspace` (69 files, 1,318 tests), and so do `workspace-decision-queue`, `WorkspaceShell`, `consent-announce`, `server/routes-workspace-decisions`, all of `@ax/routines-contract` (417 tests) and routines' `return-schemas` (no Docker either). `pnpm lint` and `pnpm --filter @ax/channel-web exec tsc --build` exit 0 from this worktree. A red one after your change is yours.
- **channel-web without Docker:** all of channel-web except the six Postgres files passes at base: `src/components` (121 files, 2,023 tests), `src/lib`, `src/__tests__` outside `server` (57 files) and, in `server`, 39 files with 1,216 tests. Together that is 292 files and 5,045 tests, in one pass of about a minute. Use this when the daemon is down: `pnpm --filter @ax/channel-web test src/components src/lib src/__tests__ --exclude 'src/__tests__/server/routes-chat.test.ts' --exclude 'src/__tests__/server/acceptance-e2e.test.ts' --exclude 'src/__tests__/server/stream-e2e.test.ts' --exclude 'src/__tests__/server/connections-mirror.test.ts' --exclude 'src/__tests__/server/routes-attachments.test.ts' --exclude 'src/__tests__/server/routes-workspace-approval-actor.test.ts'`. It doesn't replace the final gate.
- **Memory:** write to shards only, from `scripts/memory-write-target.sh --shard <kind> TASK-932`. Never touch a root `.claude/memory/*.md`, and never add a `Memory-Rewrite:` trailer.

## Review Focus

1. **Someone else's task on a team agent.** Its name never reaches another person: the SQL filters on the owner after `agents:resolve`, and "not yours" answers the same as "not a task". Pinned in Task 2 (`leaves out … another person's task …`), Task 3 (`answers only for the caller's own tasks`) and Task 5 (`carries null on … another person's task`).
2. **A conversation more than one run shared** (a shared repeat routine, later turned into a task) is never named as a check-in. Pinned in Task 2 (`leaves out a conversation that more than one run shares…`).
3. **The lookup fails, times out or is absent.** The queue still answers 200, and only that agent's rows lose their label. Pinned in Task 5 (`still answers 200 when one agent's lookup fails…`, `…doesn't come back in time…`, `without routines:tasks-for-conversations…`).
4. **Every path carries the same label:** the list, the single read and the approve, dismiss and undo answers. `useDecisionQueue` swaps in whatever row comes back, so a path without the label would drop it. Pinned in Task 5 (`the single read and the approve, dismiss and undo answers carry the same checkIn`).
5. **Approving is unchanged.** An answer whose lookup failed still answers with the resolved row. An answer whose lookup is slow waits at most a second, so the 10-second Undo window isn't eaten. Pinned in Task 5 (`an answer whose lookup fails still answers…`, `an answer waits at most a second for its label`).
6. **A shared conversation's run history can't blow up a Today read.** The query reads at most two dispatch rows per conversation. Pinned in Task 2 (`reads through version 5's conversation index`) and the query's shape.

## Where this plan departs from the card

Each is a decisions row. Say so in the PR description.

- **Ambiguous means more than one run, not more than one routine** (row 2). A shared conversation belongs to one routine: fire.ts finds or creates it with `externalKey: row.routineId` (`packages/routines/src/fire.ts:198-213`). The card's own example would pass its own rule. TASK-911's rule (its decisions row 22) counts runs.
- **The query reads at most two dispatch rows per conversation** (row 3). A shared conversation gains one row per run, forever. The default heartbeat is shared and runs daily for every personal agent (`migrations.ts:439-451`).
- **Leniency reaches the return check** (row 4). The store drops an entry that fails `RoutineCheckInViewSchema`. Otherwise one bad name would fail the hook's `returns` check, and with it the whole answer.
- **Only ids the contract can take are asked about, in batches of 200** (row 7). `@ax/decisions` stores `conversationId: ''` for a hold outside a conversation (`packages/decisions/src/pre-call.ts:263`), and such a row is `unattended`.
- **A deadline per agent's lookup** (row 8), in TASK-909's `tasksForAgent` shape: 5 s for the list, 1 s for one row (the single read and the three answers, which sit on the undo window's path). The bus's own bound is two minutes.
- **`onNavigate` is threaded `WorkspaceShell` → `TodayView` → `DecisionRow`** (row 12). Neither component has one today, and "Open {agent}" is a button, not a link.
- **Plumbing:** `projectDecision`'s label parameter is required, `toWireDecision` drops a label on any row that isn't unattended, and the approve route's eligibility check passes `null` (row 9).

## Card premises, checked (at 21448a93b)

- **True:**
  - Every fire binds its conversation onto its dispatch row before `agent:invoke`, shared and per-fire alike (`store.ts:404-415`, `fire.ts:234-235`).
  - Dispatch rows outlive their run. `finishDispatch` only sets `completed_at` (`store.ts:394`), and only `purgeAgent` deletes them (`store.ts:533`). Deleting a routine leaves its runs' rows (`deleteAuthored`, `store.ts:318-327`).
  - Version 5's `routines_v1_dispatches_conversation (agent_id, conversation_id) WHERE conversation_id IS NOT NULL` exists (`migrations.ts:197-203`).
  - A fire row is written only when its run finishes. An interrupted run's fire row has `conversationId: null`, while its dispatch row keeps the binding (`store.ts:361-370`). So the dispatch-based lookup also names a check-in still running, and one a host restart cut short.
  - Check-in conversations are `hidden: true, origin: 'routine'` (`fire.ts:217-225`), so their holds are `unattended` (`packages/decisions/src/attendance.ts:105-113`).
  - The Today routes run as the card says (`routes-workspace.ts:6436-6481, 5568-5583, 6612-6624`), and every `StoredDecision` has a `conversationId`.
  - `decisionProvenance` is shared by `DecisionRow` (:357) and `ApprovalCard` (:341, unattended rows only).
  - `Decision.task` is TASK-906's brief block. `routeLinkProps` and `{ kind: 'task', agentId, routineId }` exist, and the route encodes both ids (`workspace-route.ts:178-179`).
  - `return-schemas.test.ts` pins `ROUTINE_SERVICES` at 17. channel-web's `plugin.test.ts` pins its manifest exactly.
- **Refuted or corrected:** the ambiguity rule, the lenient read, which ids to send, and the link's wiring (rows 2, 4, 7, 12, above).

## For the sibling cards (TASK-933 and later): what this card guarantees

- `Decision.checkIn: DecisionCheckIn | null`, with `DecisionCheckIn { routineId: string; taskName: string }` (`lib/workspace-types.ts`), is on every path: the list, `GET /decisions/:id` and the approve, dismiss and undo answers.
- `checkIn` is null for an attended row, for anything that isn't the caller's own check-in (or that several runs shared), when the hook is absent, and when the lookup fails or misses its deadline (5 s for the list, 1 s for one row). **So a row can lose its label between two reads, or carry it in the list and not in the answer to a click.** Grouping must treat null as "not in a task's group" and expect a row to move.
- Read it as `d.checkIn ?? null`: a row from an older server leaves it out.
- `routines:tasks-for-conversations` is the one way to ask "which task's check-in is this conversation?". A routine's kind is read now, not at run time (decisions row 13a).
- **Follow-ups worth filing** (not built here): store the kind on the dispatch row (TASK-908's open follow-up), which also closes row 13a.

## Exact-list pins for the new hook

| Pin | Change |
|---|---|
| `ROUTINE_SERVICES` (`packages/routines/src/services.ts:11-15`), and through it the routines manifest's `registers` (`plugin.ts:46`) | add `'tasks-for-conversations'` after `'clear-notes'` (Task 3) |
| `packages/routines/src/__tests__/return-schemas.test.ts:48-55` | `toHaveLength(17)` → `18`, plus a `toContain` (Task 3). If TASK-930 or another card added a service first, use the real count. |
| channel-web `server/plugin.ts` `optionalCalls` (after `routines:clear-notes`, :320-327) | new entry (Task 5) |
| channel-web `__tests__/server/plugin.test.ts` (after the clear-notes entry, :787-791) | the same entry, same string (Task 5) |
| channel-web `__tests__/server/routes-workspace.test.ts` `WIRE_KEYS` (:3183-3212) | add `'checkIn'` (Task 5) |
| channel-web `__tests__/server/manifest-declarations.test.ts` | no edit; stays green only if the hook name is a literal and declared |
| `presets/k8s/src/__tests__/preset.test.ts` | no change. It pins routines hooks with `toContain` only, and channel-web → routines is already a call-graph edge (`routines:get`), so the cycle test sees no new cycle. |
| `@ax/mcp-oauth` stubs | no change: it references no routines hook |
| routines `__tests__/plugin.test.ts` | no change (`toContain`) |

## Order and file ownership

| Wave | Task | Touches | Depends on |
|---|---|---|---|
| 1 | T1 the contract | `packages/routines-contract/src/services.ts`, a new contract test | — |
| 2 | T2 the store's read | `packages/routines/src/store.ts`, a new `tasks-for-conversations.test.ts` | T1 |
| 2 | T5 Today's routes carry the label | channel-web `lib/workspace-types.ts`, `components/workspace/__tests__/decision-fixture.ts`, `server/routes-workspace.ts`, `server/plugin.ts`, `plugin.test.ts`, `routes-workspace.test.ts` (`WIRE_KEYS`), a new `routes-workspace-decision-checkins.test.ts` | T1 |
| 3 | T3 the hook | `packages/routines/src/services.ts`, `return-schemas.test.ts`, `tasks-for-conversations.test.ts` (second describe) | T2 |
| 3 | T6 the words and the client's check | channel-web `lib/workspace-api.ts`, `components/workspace/decision-copy.ts`, a new `decision-provenance.test.ts`, `workspace-api-decision-shape.test.ts`, `decision-renderers.test.tsx`, `TaskCheckinPage.test.tsx` | T5 |
| 3 | T7 Open task | channel-web `DecisionRow.tsx`, `TodayView.tsx`, `WorkspaceShell.tsx`, `DecisionRow.test.tsx`, `TodayView.test.tsx`, `consent-focus.test.tsx` | T5 |
| 4 | T4 the canary | `packages/routines/src/__tests__/canary.test.ts` | T3 |
| 5 | T8 the design doc | `docs/plans/2026-10-20-agent-tasks-design.md` | all |

channel-web paths are under `packages/channel-web/src/`. Tasks in one wave touch disjoint files, but in one worktree **run them one at a time, in the table's order**. `packages/channel-web/tsconfig.json` references `../routines` and `../routines-contract`, so channel-web's `tsc --build` recompiles a routines file another task is halfway through, and writes the same `dist/` and `tsbuildinfo`. Run tasks in parallel only in separate worktrees. Line numbers are at 21448a93b: if they drift, find the named symbol.

---

### Task 1: The contract [tier: mechanical]

**Files:**
- Modify: `packages/routines-contract/src/services.ts`. Add the constant and three schemas after `RoutineClearNotesOutputSchema` (:62), and three types after `RoutineClearNotesOutput` (:144, the file's end).
- Create: `packages/routines-contract/src/__tests__/tasks-for-conversations.test.ts`

**Interfaces (produces):**

```ts
/**
 * `routines:tasks-for-conversations` (TASK-932): which of these conversations
 * are check-ins of a task the caller owns, on this agent, so Today can name the
 * task an approval was held in. A label, never an authorization. A conversation
 * that isn't a check-in, is another person's, or that more than one run shared
 * is simply absent, all alike. Neither a tool nor an IPC action.
 */
export const ROUTINE_CHECKIN_LOOKUP_MAX_IDS = 200;
export const RoutineTasksForConversationsInputSchema = RoutineListInputSchema.extend({
  conversationIds: z.array(RoutineOpaqueStringSchema).min(1).max(ROUTINE_CHECKIN_LOOKUP_MAX_IDS),
}).strict();
/** One check-in: its conversation, its task's id (an opaque host id) and its task's name. */
export const RoutineCheckInViewSchema = z.object({
  conversationId: RoutineOpaqueStringSchema,
  routineId: RoutineOpaqueStringSchema,
  name: RoutineEditableShape.name,
}).strict();
export const RoutineTasksForConversationsOutputSchema = z.object({ checkIns: z.array(RoutineCheckInViewSchema) }).strict();
// …at the end of the file:
export type RoutineTasksForConversationsInput = z.output<typeof RoutineTasksForConversationsInputSchema>;
export type RoutineTasksForConversationsOutput = z.output<typeof RoutineTasksForConversationsOutputSchema>;
export type RoutineCheckInView = z.output<typeof RoutineCheckInViewSchema>;
```

- [ ] **Step 1: Write the failing test,** modelled on `clear-notes.test.ts` in the same folder, importing from `'../index.js'`:
  - `takes an agent and 1 to 200 conversation ids, and nothing else`:
    - `{ agentId: 'a', conversationIds: ['c1'] }` parses to itself.
    - 200 ids (`Array.from({ length: 200 }, (_, i) => \`c${i}\`)`) parse.
    - Refused (`safeParse(...).success === false`): `[]`; 201 ids; `['']`; `['x'.repeat(257)]`; `'c1'` (not an array); an extra `userId: 'owner'`; no `agentId`.
    - `ROUTINE_CHECKIN_LOOKUP_MAX_IDS` is `200`.
  - `answers check-ins as a conversation, a task id and a name, and nothing else`:
    - `{ checkIns: [] }` and `{ checkIns: [{ conversationId: 'c1', routineId: 'r1', name: 'Support queue' }] }` parse to themselves.
    - Refused: an entry with an extra `ownerUserId`; an extra top-level `kind`; `name: ''`; `name: 'x'.repeat(129)`.
- [ ] **Step 2: Run and watch it fail:** `pnpm --filter @ax/routines-contract test src/__tests__/tasks-for-conversations.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run (PASS), then** `pnpm --filter @ax/routines-contract test` **and** `pnpm --filter @ax/routines-contract build`.
- [ ] **Step 5: Commit:** `git commit -m "Agent Tasks: the contract for naming a check-in's task (TASK-932)"`

### Task 2: The store's read [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/routines/src/store.ts`:
  - The `@ax/routines-contract` import (:3-7) gains `RoutineCheckInViewSchema` and `type RoutineCheckInView`.
  - `RoutinesStore` gains `tasksForConversations` right after `isTaskConversation` (:62-68).
  - New exported `tasksForConversationsQuery` right after `taskConversationQuery` (:86-97).
  - The method right after `isTaskConversation` in `createRoutinesStore` (:430-436).
- Create: `packages/routines/src/__tests__/tasks-for-conversations.test.ts`. This task writes its store describe; Task 3 adds the service describe to the same file.

**Interfaces (produces):**

```ts
// RoutinesStore
/**
 * TASK-932. Which of these conversations are check-ins of a task `actorUserId`
 * owns, on `agentId`, for Today's labels: exactly one run of that agent, open or
 * finished, is bound to it, and that run's routine still exists, isn't a repeat
 * routine and is theirs. A conversation several runs shared is left out,
 * whatever their routines. The kind and owner are read now, not at run time.
 * Reads the routine's id and name only, so a row another read couldn't parse
 * still answers. One read, no lock, through version 5's index.
 */
tasksForConversations(input: { agentId: string; actorUserId: string; conversationIds: readonly string[] }): Promise<RoutineCheckInView[]>;

/**
 * `tasksForConversations`' one query, exported so a test can check the planner
 * reads it through version 5's index. Each conversation reads at most two of
 * its dispatch rows: one is a single run, two means several shared it. A
 * shared conversation gains a row every run, forever, so a plain join would
 * read them all on every Today load.
 */
export function tasksForConversationsQuery(input: { agentId: string; actorUserId: string; conversationIds: readonly string[] }) {
  return sql<{ conversation_id: string; routine_id: string; name: string }>`
    SELECT c.conversation_id, r.routine_id, r.name
      FROM unnest(${[...input.conversationIds]}::text[]) AS c(conversation_id)
     CROSS JOIN LATERAL (
           SELECT count(*) AS runs, min(d.routine_id) AS routine_id
             FROM (SELECT routine_id
                     FROM routines_v1_dispatches
                    WHERE agent_id = ${input.agentId}
                      AND conversation_id = c.conversation_id
                      AND conversation_id IS NOT NULL
                    LIMIT 2) d
           ) bound
      JOIN routines_v1_definitions r
        ON r.agent_id = ${input.agentId} AND r.routine_id = bound.routine_id
     WHERE bound.runs = 1
       AND r.kind <> 'repeat'
       AND r.owner_user_id = ${input.actorUserId}
  `;
}

// createRoutinesStore
async tasksForConversations(input) {
  const conversationIds = [...new Set(input.conversationIds)];
  if (conversationIds.length === 0) return [];
  const { rows } = await tasksForConversationsQuery({ ...input, conversationIds }).execute(db);
  // Columns, not rowToRoutine: a definition another read can't parse still names its check-in. An
  // entry the contract refuses (a name a later rule turned away, a hand edit) costs only its own
  // label, where the hook's return check would fail the whole answer (TASK-913).
  return rows.flatMap((row) => {
    const view = { conversationId: row.conversation_id, routineId: row.routine_id, name: row.name };
    return RoutineCheckInViewSchema.safeParse(view).success ? [view] : [];
  });
},
```

`unnest(${array}::text[])` is the store's existing pattern (`reconcileOwners`). The inner query states `conversation_id IS NOT NULL`, the partial index's own predicate, so the planner can always use it.

**MEASURED (planner, on a throwaway local PostgreSQL 17.6 with the two tables' relevant columns and both dispatch indexes, run as a prepared statement with bind parameters).** The query parses: the nested derived table may reference `c` through the LATERAL. It returns exactly the open and the finished check-in of the owner's task. It leaves out:
- two runs of one task in one conversation;
- two routines' runs in one conversation;
- a repeat routine;
- another owner's task;
- another agent's task;
- a deleted routine's run, and a live run sharing a conversation with one;
- an unbound id;
- a 5,000-run shared conversation.

With default settings and with `enable_seqscan = off`, the plan is `Limit → Index Scan using routines_v1_dispatches_conversation` (`actual rows=2` per conversation, the 5,000-run one included), then the definitions primary key. The test must still run on the package's Postgres 16 container.

- [ ] **Step 1: Write the failing tests.** The file header comment (exact): "TASK-932: which conversations are check-ins of the caller's own tasks, so Today can name the task an approval was held in. The store reads at most two runs per conversation; the hook runs agents:resolve first." Use `fixture()`, `createInput` and `now` from `./store-fixture.js`, as `clear-notes-store.test.ts` does. Local helpers:
  - `TASK = { name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' }, kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.' }`.
  - `taskDefinition(name = 'Support queue')` = `RoutineDefinitionSchema.parse({ ...TASK, name })`.
  - `create(requestId, definition, over: { agentId?, ownerUserId? } = {})` = `f.store.createAuthored({ ...createInput(requestId), ...over, definition })`.
  - `run(row, requestId, conversationId)`: `acceptDispatch` with `{ agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', source: 'manual', requestId, now }`, then `bindDispatchConversation`, and return the accepted dispatch. This leaves the run open.
  - `finish(dispatchId)` = `finishDispatch` with `{ status: 'ok', conversationId: 'c', error: null, renderedPrompt: 'ran', warning: null }`.
  - `ask(ids, actorUserId = 'owner', agentId = 'a')` sorts the answer by `conversationId`.
  - `drop(row)` = `f.store.deleteAuthored({ agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: \`delete-${row.routineId}\`, actorUserId: 'owner', now })`.

  `describe('tasksForConversations (store, TASK-932)')`:
  - `names a check-in's conversation while its run is open and after it finishes`: one task; `run(task, 'open', 'c-open')`; `run(task, 'done', 'c-done')` then `finish` (expect `true`). `ask(['c-open', 'c-done'])` equals both entries, `{ conversationId, routineId: task.routineId, name: 'Support queue' }`.
  - `leaves out a repeat routine, another person's task, another agent's task, a deleted task and a conversation no run is bound to`:
    - Set up, each with one run: a repeat routine (`createInput('repeat').definition`, run into `c-repeat`); a task with `ownerUserId: 'someone-else'` named 'Their queue' (`c-theirs`); a task on agent `'b'` named 'Other agent' (`c-elsewhere`); a task named 'Gone' (`c-gone`), then `drop` it.
    - `ask(['c-repeat', 'c-theirs', 'c-elsewhere', 'c-gone', 'c-none'])` is `[]`.
    - Each is named to the person and the agent it belongs to: `ask(['c-theirs'], 'someone-else')` names 'Their queue', and `ask(['c-elsewhere'], 'owner', 'b')` names 'Other agent'.
  - `leaves out a conversation that more than one run shares, whichever routines they belong to`:
    - Two runs of one task into `c-shared` (finish the second). Comment: "a shared repeat routine's conversation, before it became a task".
    - One run each of two tasks into `c-mixed`.
    - One run of a task and one of a routine you then `drop`, into `c-with-gone`.
    - `ask(['c-shared', 'c-mixed', 'c-with-gone'])` is `[]`.
  - `still names a check-in whose definition no longer parses`: a task with a run into `c1`. Then `UPDATE routines_v1_definitions SET good_when = NULL WHERE routine_id = ${task.routineId}`. Comment: "a task with no going-well-when fails every `rowToRoutine` read". Assert `f.store.findOne({ agentId: 'a', routineId: task.routineId })` rejects. `ask(['c1'])` still names 'Support queue'.
  - `leaves out only the conversation whose task name the contract refuses`:
    - Three tasks ('Support queue', 'Blank', 'Long'), with runs into `c-kept`, `c-blank` and `c-long`.
    - SQL-set Blank's name to `''` and Long's to `'x'.repeat(129)`.
    - `ask` of all three is only `c-kept`.
  - `answers a repeated id once`: `tasksForConversations({ …, conversationIds: ['c1', 'c1'] })` has length 1.
  - `reads a routine's kind as it is now, so a run from before it became a task is named (accepted, decisions row 13)`:
    - A repeat routine, `RoutineDefinitionSchema.parse({ name: 'Weekly digest', promptBody: 'Summarize.', trigger: { kind: 'interval', every: '15m' } })`, with a run into `c-before`. `ask(['c-before'])` is `[]`.
    - Then `UPDATE … SET kind = 'stay-on-top', good_when = 'Nothing waits a day.'`, and it names 'Weekly digest'.
  - `reads through version 5's conversation index`: copy `migrations.test.ts:124-132`.
    - `const compiled = tasksForConversationsQuery({ agentId: 'a', actorUserId: 'owner', conversationIds: ['c1', 'c2'] }).compile(f.db)`.
    - On one connection: `SET enable_seqscan = off`, then `EXPLAIN` through `CompiledQuery.raw(\`EXPLAIN ${compiled.sql}\`, [...compiled.parameters])`, then `RESET enable_seqscan`.
    - The plan contains `routines_v1_dispatches_conversation`. The open-runs index, `routines_v1_dispatches_open_conversation`, does not contain that substring.
- [ ] **Step 2: Run and watch them fail:** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines test src/__tests__/tasks-for-conversations.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run (PASS), then** `pnpm --filter @ax/routines build`.
- [ ] **Step 5: Run `security-checklist`** over this diff, and keep its note for the PR. The read takes caller-supplied conversation ids into parameterized SQL, filters on the owner in SQL, and reads a bounded number of rows.
- [ ] **Step 6: Commit:** `git commit -m "Agent Tasks: routines can say which conversations are a person's task check-ins (TASK-932)"`

### Task 3: The hook [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/routines/src/services.ts`. `ROUTINE_SERVICES` (:11-15) gains `'tasks-for-conversations'` after `'clear-notes'`. Add the registration after `clear-notes` (:225-232).
- Modify: `packages/routines/src/__tests__/return-schemas.test.ts` (:48-55, plus a new `it` after it).
- Modify: `packages/routines/src/__tests__/tasks-for-conversations.test.ts` (a second describe).

**Interfaces (produces):** `routines:tasks-for-conversations`, `RoutineTasksForConversationsInputSchema` → `RoutineTasksForConversationsOutputSchema`.

```ts
// TASK-932. Which of these conversations are check-ins of the caller's own tasks, so Today can name the
// task an approval was held in. A label, never an authorization: approve and dismiss go through
// @ax/decisions as before. agents:resolve runs first, as for every read; the store then answers only
// for routines ctx.userId owns (taskView's rule, not `allowed`'s), so another person's task names
// never leave, and a conversation that isn't a check-in, isn't theirs or that several runs shared is
// simply absent, all alike. Neither a tool nor an IPC action, so no model can call it.
register('tasks-for-conversations', C.RoutineTasksForConversationsInputSchema, C.RoutineTasksForConversationsOutputSchema, async (ctx, input) => {
  await access(ctx, input.agentId);
  return { checkIns: await store.tasksForConversations({ agentId: input.agentId, actorUserId: ctx.userId, conversationIds: input.conversationIds }) };
});
```

- [ ] **Step 1: Write the failing tests.**
  - `return-schemas.test.ts`:
    - The `declares every canonical service…` test: `toHaveLength(17)` → `18`, and `expect(ROUTINE_SERVICES).toContain('routines:tasks-for-conversations')`. Its title gains ", and naming a check-in's task".
    - New `it("projects a check-in as its conversation, its task's id and its name, and nothing else")`: `C.RoutineTasksForConversationsOutputSchema` parses `{ checkIns: [{ conversationId: 'c1', routineId: 'routine', name: 'Support queue' }] }` to itself, and throws on an entry with `ownerUserId` and on a top-level `kind`.
  - `tasks-for-conversations.test.ts`, `describe('routines:tasks-for-conversations (TASK-932)')`. Build a `HookBus` the way `report-views.test.ts:25-31` does:
    - `agents:resolve` pushes `'agents:resolve'` onto an `order` array. It throws `new PluginError({ code: 'forbidden', plugin: 'agents', message: 'not yours' })` for any user not in its `reach` list, else answers `{ agent: { id: 'a', ownerType: 'team', ownerId: 'team-1' } }`. Use `'team'`: a `'user'` agent would make `reconcileOwners` rewrite every routine's owner.
    - `agents:can-manage-routines` answers `{ allowed: true }`.
    - `registerRoutineServices({ bus, now: () => now, store: { ...store, async tasksForConversations(input) { order.push('store'); return store.tasksForConversations(input); } } })`, where `store = f.store` is read once.
    - Call with `makeAgentContext({ userId, agentId: 'a', sessionId: 's' })`.
    - Tests:
      - `runs agents:resolve before it reads, and a caller it refuses reads nothing`: with a task run into `c1` and `reach = ['owner']`:
        - The owner gets `toStrictEqual({ checkIns: [{ conversationId: 'c1', routineId: task.routineId, name: 'Support queue' }] })`, and `order` is `['agents:resolve', 'store']`.
        - After clearing `order`, `'stranger'` rejects with `{ code: 'forbidden' }`, and `order` is `['agents:resolve']`.
      - `answers only for the caller's own tasks`: `'teammate'` (reachable) gets `{ checkIns: [] }` for the owner's `c1`.
      - `refuses an empty list, more than 200 ids, an id that can't be one and any other key, before anything is read`:
        - Each input rejects with `{ toolCode: 'validation' }`: `conversationIds: []`; 201 ids; `['']`; an extra `userId`; no `agentId`. `order` stays `[]`.
        - 200 unknown ids answer `{ checkIns: [] }`.
- [ ] **Step 2: Run and watch them fail:** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines test src/__tests__/tasks-for-conversations.test.ts src/__tests__/return-schemas.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run (PASS), then** `pnpm --filter @ax/routines build`.
- [ ] **Step 5: Run `security-checklist`.** The PR note can combine it with Task 2's: `access` first; the owner from `ctx.userId`, never from the input; the same "absent" for not-a-task, not-yours and ambiguous; capped input; neither a tool nor an IPC action.
- [ ] **Step 6: Commit:** `git commit -m "Agent Tasks: routines:tasks-for-conversations names a person's own check-ins (TASK-932)"`

### Task 4: The canary [tier: integration]

**Files:**
- Modify: `packages/routines/src/__tests__/canary.test.ts`. Add a new `it` as the last test of `describe('task check-in report canary (TASK-907)')`, right after `outside a check-in, routine_report is refused…` (:387-399). It reuses that describe's `start`, `createTask`, `checkIn` and `runner` helpers. If a rebase conflicts with TASK-930's canary at the same spot, keep both.

- [ ] **Step 1: Write the test** `an approval held during a check-in names its task through routines:tasks-for-conversations (TASK-932)`:

```ts
await start(); // unattended: a check-in's conversation has origin `routine`
const task = await createTask();
// What the agent asks for mid-check-in: a new routine, which tool policy holds for the person.
const propose: ToolCall = { id: 'propose', name: 'routine_create', input: {
  requestId: 'propose', definition: RoutineDefinitionSchema.parse({ name: 'Weekly digest', promptBody: 'Summarize the week.', trigger: { kind: 'interval', every: '1h' } }),
} };
let conversationId = '';
await checkIn(task, 'run', async ctx => {
  conversationId = ctx.conversationId!;
  expect(isHold(await h.bus.fire('tool:pre-call', runner(ctx), propose))).toBe(true);
});
const { decisions } = await h.bus.call<unknown, { decisions: Array<{ conversationId: string; attendance: string; call: { name: string } }> }>(
  'decisions:list', h.owner, { userId: 'owner' });
const held = decisions.find(d => d.call.name === 'routine_create');
expect(held).toMatchObject({ conversationId, attendance: 'unattended' });
expect(await h.bus.call('routines:tasks-for-conversations', h.owner, { agentId: h.agentId, conversationIds: [held!.conversationId] }))
  .toStrictEqual({ checkIns: [{ conversationId, routineId: task.routineId, name: 'Support queue' }] });
```

  The harness answers every `conversations:create` with one id (`.claude/memory/patterns/2026-10-22-TASK-908.md`), so keep exactly one run in this `it`. A second run would make the conversation ambiguous.
- [ ] **Step 2: Run:** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/routines test src/__tests__/canary.test.ts`. It passes, because Task 3 is in. To see it fail, comment out the registration and watch it reject with "no plugin registered".
- [ ] **Step 3: Commit:** `git commit -m "Agent Tasks: canary — a check-in's held call names its task (TASK-932)"`

### Task 5: Today's routes carry the label [tier: sensitive] (security-checklist)

**Files:**
- Modify: `lib/workspace-types.ts`. Add `DecisionCheckIn` after `DecisionTask` (:157-163), and `checkIn` on `Decision` after `task` (:234).
- Modify: `components/workspace/__tests__/decision-fixture.ts`. Add `checkIn: null,` after `task: null,` (:37). In the header (:11-14), the sentence becomes: "The tool input reaches a renderer only as `request` (TASK-699) and `task` (TASK-906), already fenced text on open rows only; those and `checkIn` (TASK-932) are `null` here unless a test sets them."
- Modify: `server/routes-workspace.ts`:
  - **Header security paragraph:** after "…through `loadOwnedDecision`." (:95), add (exact): "Both then ask `routines:tasks-for-conversations` (TASK-932), as the caller and only about rows already past those checks, which of their unattended rows were held in one of the caller's own task check-ins. The answer is a label (`checkIn`): nothing authorizes on it, and approve, dismiss and undo go through `@ax/decisions` exactly as before."
  - **Imports:** the `@ax/routines-contract` value import (:129-139) gains `ROUTINE_CHECKIN_LOOKUP_MAX_IDS` and `RoutineOpaqueStringSchema`. The type import (:140) gains `RoutineCheckInView`, `RoutineTasksForConversationsInput` and `RoutineTasksForConversationsOutput`.
  - **Deadline constants:** `DECISION_CHECKINS_LIST_DEADLINE_MS` and `DECISION_CHECKIN_ROW_DEADLINE_MS` after `DECISION_TASK_CHECKS_IN_MAX_CHARS` (:2445), with the `CheckInSource` and `CheckInLabels` types and the `checkInOf` function.
  - **`toWireDecision`** (:2705): a third parameter and the `checkIn` field after `task`.
  - **Helpers:** new `checkInsForAgent`, `checkInsFor` and `projectOwnedDecision` right after `canManageStoredRoutine` (:5559-5566). `projectDecision` (:5568-5571) takes the label. `resolvedOrGone` (:5573-5583) calls `projectOwnedDecision`.
  - **Routes:** `decisions()` (:6436-6481) and its doc comment; `decision()` (:6612-6624); the approve route's eligibility check (:6651).
- Modify: `server/plugin.ts`. The header (after the TASK-911 sentence, :69-71) and one `optionalCalls` entry after `routines:clear-notes` (:320-327).
- Modify: `__tests__/server/plugin.test.ts` (the same entry, after :787-791) and `__tests__/server/routes-workspace.test.ts` (`WIRE_KEYS`, :3183-3212: add `'checkIn'`).
- Create: `__tests__/server/routes-workspace-decision-checkins.test.ts`.

**Interfaces (produces):**

```ts
// lib/workspace-types.ts
/**
 * TASK-932 — the task check-in an approval was held in, on an unattended row a
 * task the caller owns raised. A label for the person, never an authorization.
 * `routineId` is an opaque host id (the task page's address); `taskName` is the
 * task's own name, server-fenced to one line.
 */
export interface DecisionCheckIn {
  routineId: string;
  taskName: string;
}
// in Decision, after `task`:
/**
 * WHICH TASK IT CAME FROM (TASK-932), or null. Non-null only on an unattended
 * row held during a check-in of a task the caller owns. Null for everything
 * else, and whenever the routines read is absent, fails or is slow: it is a
 * label, so the queue never waits on it. Every path that answers a row carries
 * it: the list, the single read and the approve, dismiss and undo answers. An
 * older server leaves it out, so read it as `d.checkIn ?? null`.
 */
checkIn: DecisionCheckIn | null;

// server/routes-workspace.ts, module level, after DECISION_TASK_CHECKS_IN_MAX_CHARS
/**
 * TASK-932 — how long the Today list waits for one agent's check-in labels
 * before it answers without them. A label never holds the queue (design H7 is
 * about the queue, not its labels), and the bus's own bound is two minutes.
 * Half the Tasks page's `TASKS_AGENT_READ_DEADLINE_MS`: there the read IS the page.
 */
export const DECISION_CHECKINS_LIST_DEADLINE_MS = 5_000;
/**
 * TASK-932 — the same wait for one row: the single read and the approve,
 * dismiss and undo answers. Those sit on the undo window's path. An answer's
 * Undo counts down `UNDO_WINDOW_MS` (10 s) from the server's `resolvedAt`, and
 * the once-a-second poll re-read is what takes Undo away once the call has gone
 * out. So a slow label may cost them at most a second.
 */
export const DECISION_CHECKIN_ROW_DEADLINE_MS = 1_000;
/** TASK-932 — a check-in as `routines:tasks-for-conversations` names it, before `toWireDecision` fences it. */
type CheckInSource = Pick<RoutineCheckInView, 'routineId' | 'name'>;
/** By agent id, then conversation id. */
type CheckInLabels = Map<string, Map<string, CheckInSource>>;
function checkInOf(labels: CheckInLabels, d: StoredDecision): CheckInSource | null {
  return labels.get(d.agentId)?.get(d.conversationId) ?? null;
}

export function toWireDecision(stored: StoredDecision, eligible = false, checkIn: CheckInSource | null = null): Decision
// …the field, after `task: wireTask(stored),`:
    // TASK-932. The task check-in it was held in, or null: a label, never an authorization. Only an
    // unattended row can be one (a check-in's conversation has origin `routine`), so an answer for
    // any other row is dropped here. `routineId` is an opaque host id; the name is the task's, fenced.
    checkIn:
      stored.attendance === 'unattended' && checkIn !== null
        ? { routineId: checkIn.routineId, taskName: fenceLine(checkIn.name, ROUTINE_NAME_MAX_CHARS) ?? 'Untitled task' }
        : null,

// inside makeWorkspaceHandlers, after canManageStoredRoutine
/**
 * TASK-932 — which of these conversations are the caller's own task check-ins
 * on this agent, by conversation id. Today's label, never an authorization.
 *
 * Asked as the caller (`agentWorkspaceCtx`), so the hook runs `agents:resolve`
 * itself and answers only for the caller's own tasks. Only ids the contract can
 * take are asked about: a hold outside a conversation is stored with ''
 * (`@ax/decisions`' pre-call), and one such id would refuse the whole batch. At
 * most `ROUTINE_CHECKIN_LOOKUP_MAX_IDS` ids per call.
 *
 * It never holds or fails the queue. Without the hook it asks nothing. After a
 * throw, or past `deadlineMs`, this agent's rows carry no task and a warn line
 * says why: the shape of `tasksForAgent` on the Tasks page.
 */
async function checkInsForAgent(agentId: string, userId: string, conversationIds: Iterable<string>, deadlineMs: number): Promise<Map<string, CheckInSource>> {
  const ids = [...new Set(conversationIds)].filter((id) => RoutineOpaqueStringSchema.safeParse(id).success);
  if (ids.length === 0 || !bus.hasService('routines:tasks-for-conversations')) return new Map();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += ROUTINE_CHECKIN_LOOKUP_MAX_IDS) batches.push(ids.slice(i, i + ROUTINE_CHECKIN_LOOKUP_MAX_IDS));
    const read = Promise.all(batches.map((batch) =>
      bus.call<RoutineTasksForConversationsInput, RoutineTasksForConversationsOutput>(
        'routines:tasks-for-conversations', agentWorkspaceCtx(agentId, userId), { agentId, conversationIds: batch })));
    // After the deadline nobody waits on this read, so its eventual failure is logged here.
    read.catch((err: unknown) => {
      if (!timedOut) return;
      initCtx.logger.warn('workspace_decision_tasks_late_failed', { agentId, error: err instanceof Error ? err.message : String(err) });
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`routines:tasks-for-conversations did not answer within ${deadlineMs}ms`));
      }, deadlineMs);
    });
    const answers = await Promise.race([read, deadline]);
    return new Map(answers.flatMap((out) => out.checkIns).map((c) => [c.conversationId, { routineId: c.routineId, name: c.name }] as const));
  } catch (err) {
    initCtx.logger.warn('workspace_decision_tasks_failed', { agentId, error: err instanceof Error ? err.message : String(err) });
    return new Map();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** TASK-932 — the check-in behind each unattended row, for rows already past their ACL. One call per agent, in parallel. */
async function checkInsFor(rows: readonly StoredDecision[], userId: string, deadlineMs: number): Promise<CheckInLabels> {
  const byAgent = new Map<string, Set<string>>();
  for (const d of rows) {
    // A check-in's conversation has origin `routine`, so its holds are unattended. Attended rows are never asked about.
    if (d.attendance !== 'unattended') continue;
    const ids = byAgent.get(d.agentId) ?? new Set<string>();
    ids.add(d.conversationId);
    byAgent.set(d.agentId, ids);
  }
  return new Map(await Promise.all([...byAgent].map(async ([agentId, ids]) => [agentId, await checkInsForAgent(agentId, userId, ids, deadlineMs)] as const)));
}

/**
 * One row, labelled by the list's own rule but with the one-row deadline: the
 * single read and the three answers (`useDecisionQueue` swaps in whatever row
 * comes back).
 */
async function projectOwnedDecision(stored: StoredDecision, userId: string): Promise<Decision> {
  return projectDecision(stored, userId, checkInOf(await checkInsFor([stored], userId, DECISION_CHECKIN_ROW_DEADLINE_MS), stored));
}

async function projectDecision(stored: StoredDecision, userId: string, checkIn: CheckInSource | null): Promise<Decision> {
  const open = (stored.status === 'pending' || stored.status === 'stale') && Date.parse(stored.expiresAt) > Date.now();
  return toWireDecision(stored, open && await canManageStoredRoutine(stored, userId), checkIn);
}
```

**Routes:**
- **`decisions()`:** after `reachable` is built:

  ```ts
  const visible = rows.filter((d) => reachable.get(d.agentId) === true);
  // TASK-932: the task each check-in's approval came from. After the ACL, never before it.
  const labels = await checkInsFor(visible, userId, DECISION_CHECKINS_LIST_DEADLINE_MS);
  res.status(200).json({ decisions: await Promise.all(visible.map((d) => projectDecision(d, userId, checkInOf(labels, d)))) } satisfies DecisionsResponse);
  ```

  The doc's "This route reads, checks the ACL, and projects." gains (exact): " It also names the task a check-in's approval came from (TASK-932, `checkInsFor`): a label it asks routines for, which never holds or fails the queue."
- **`decision()`:** `projectOwnedDecision(stored, userId)`. **`resolvedOrGone`:** `return projectOwnedDecision(decision, userId);`.
- **The approve route's eligibility check (:6651):** becomes `(await projectDecision(stored, userId, null)).approvalScopes`, with the comment `// Reads approvalScopes only, so it asks routines nothing.`

**`server/plugin.ts`:**
- The header gains, after the TASK-911 sentence (exact):

  ```
  //     TASK-932 adds no hard call either: Today's queue, its single-row read
  //     and the approve, dismiss and undo answers name the task an approval was
  //     held in through the optional routines:tasks-for-conversations, and say
  //     "Held during an unattended run" without it.
  ```

- The entry, after `routines:clear-notes`:

  ```ts
  {
    // TASK-932 — Today names the task a check-in's approval came from. A label
    // only: the service answers for the caller's own tasks, and nothing
    // authorizes on it.
    hook: 'routines:tasks-for-conversations',
    degradation:
      'an approval held during a task check-in reads "Held during an unattended run" instead of naming its task, and Today offers no Open task link',
  },
  ```

  `plugin.test.ts` gets the same `{ hook, degradation }` in the same place.

- [ ] **Step 1: Write the failing tests.**
  - `WIRE_KEYS` gains `'checkIn'`. The existing list, single-read and approve tests then fail on the missing key.
  - `plugin.test.ts`: the new entry.
  - `routes-workspace-decision-checkins.test.ts`, `// @vitest-environment node`, with a header naming what it pins (the paragraph under "Architecture", shortened). Copy `mkReq`/`mkRes` from `routes-workspace-task.test.ts:44-81`. Build one module-level `initCtx` with `makeAgentContext({ sessionId: 'init', agentId: '@ax/channel-web', userId: 'system' })`, and spy on `initCtx.logger.warn` per test, as `routes-workspace-tasks.test.ts:298` does. A `setup(world)` registers:
    - `auth:require-user`: the viewer, `'alice'`.
    - `agents:resolve`: per-agent reach. Throw `PluginError({ code: 'not-found', … })` for anyone else.
    - `decisions:list`: filter `ownerUserId === userId` and the optional `agentId`.
    - `decisions:get`: owner-scoped, `null` for another person's row.
    - `decisions:approve`: answers `{ decision: { ...row, status: 'executed', resolvedAt }, executed: true, path: 'host-replays', error: null, pendingUntil: null, streamReqId: null }` (`ExecutionPath` is `'agent-executes' | 'host-replays'`, `lib/workspace-types.ts:57`).
    - `decisions:dismiss`: `{ decision: { ...row, status: 'dismissed', resolvedAt } }`.
    - `decisions:undo`: `{ decision: { ...row, status: 'pending', resolvedAt: null }, undone: true }`.
    - `routines:tasks-for-conversations`, unless the hook is absent. It records `{ userId: ctx.userId, agentId: ctx.agentId, input }`, parses its input with `parseRoutineInput(RoutineTasksForConversationsInputSchema, raw)` (relative import of `../../../../routines/src/services.js`, the TASK-910 precedent), and honours per-agent failure and hang settings. A hang is a deferred the test can reject later. It answers the ids whose `world.checkIns[agentId][id]` exists with `owner === ctx.userId`. Register it with `{ returns: RoutineTasksForConversationsOutputSchema }`.
    - Stored rows are full `StoredDecision` shapes (copy `routes-workspace.test.ts:3142-3177`'s `decision()` defaults), owned by `'alice'`, with `call.name: 'gmail_send'`, so no routine eligibility read runs.
  - Tests. `SUPPORT` = `{ routineId: 't1', taskName: 'Zero open support tickets' }`.
    - `names the task on an unattended row held in one of the caller's check-ins`:
      - The row is `{ agentId: 'a1', conversationId: 'c-checkin', attendance: 'unattended' }`, and routines knows `c-checkin` → `t1` 'Zero open support tickets', owner alice.
      - The list answers `checkIn: SUPPORT`.
      - The hook was called once, with `userId: 'alice'`, `agentId: 'a1'` and `input: { agentId: 'a1', conversationIds: ['c-checkin'] }`.
    - `fences the task name to one line, and names an unreadable one "Untitled task"`: names `'Zero\u202Eopen\n  support tickets'` → `'Zero open support tickets'`, and `'\u200B'` → `'Untitled task'`. Write the escapes as text, and run the code-point scan.
    - `carries null on an attended row, a repeat routine's row and another person's task`:
      - An attended row in `c-chat` is never asked about: no recorded input contains `c-chat`.
      - An unattended `c-repeat` routines doesn't know.
      - An unattended `c-theirs` whose task's owner is `'bob'`.
      - All three carry `checkIn: null`.
    - `asks once per agent, only about unattended rows' conversations, without repeats or ids no check-in can have`:
      - Two rows in `c1` on a1, one in `c2` on a2, and an unattended row with `conversationId: ''` on a1.
      - Exactly two calls: a1 with `['c1']` and a2 with `['c2']`.
      - The `''` row carries null.
    - `asks nothing about an agent the caller can't reach`: an a3 row alice can't resolve is left out of the list (as today), and no call names a3.
    - `asks in batches of at most 200`: 201 unattended rows on a1 in `c0`…`c200`. Two calls for a1, of 200 and 1 ids, cover every id once. Use `ROUTINE_CHECKIN_LOOKUP_MAX_IDS`, not a literal.
    - `still answers 200 when one agent's lookup fails: that agent's rows carry null, and it logs`: a1 throws `new Error('connection terminated unexpectedly')`, and a2 answers. a1's rows are null and a2's are labelled. `warn` was called with `('workspace_decision_tasks_failed', { agentId: 'a1', error: expect.stringContaining('connection terminated') })`.
    - `still answers when a lookup doesn't come back in time, and logs why when it finally fails`: copy `routes-workspace-tasks.test.ts:534-594`'s fake-timer shape.
      - a1 hangs. Start the list request, then `await vi.advanceTimersByTimeAsync(DECISION_CHECKINS_LIST_DEADLINE_MS)`.
      - The response is 200, with a1's row null, and `workspace_decision_tasks_failed` names the deadline.
      - Then reject the hung read, flush, and expect `workspace_decision_tasks_late_failed { agentId: 'a1', error: … }`.
      - `vi.useRealTimers()` in `finally`.
    - `an answer waits at most a second for its label`: fake timers again, and a1 hangs.
      - Start `approveDecision` for d1, then advance `DECISION_CHECKIN_ROW_DEADLINE_MS`.
      - It has answered 200, with `decision.status` `'executed'` and `decision.checkIn` null.
      - Assert that `DECISION_CHECKIN_ROW_DEADLINE_MS < DECISION_CHECKINS_LIST_DEADLINE_MS`, so the test can't pass on the list's deadline.
    - `without routines:tasks-for-conversations every row carries null`: the hook is absent. 200, every row is null, and no `workspace_decision_tasks_*` line is logged.
    - `the single read and the approve, dismiss and undo answers carry the same checkIn`:
      - For the `c-checkin` row d1, `decision`, `approveDecision`, `dismissDecision` and `undoDecision` (each with `params { decisionId: 'd1' }` and an empty body) answer `body.decision.checkIn` equal to `SUPPORT`.
      - An attended row's single read answers null, and the hook records no call for it.
    - `an answer whose lookup fails still answers, with checkIn null`: a1's lookup throws. `approveDecision` answers 200, `decision.status` is `'executed'`, `decision.checkIn` is null, and `decisions:approve` was called with exactly `{ decisionId: 'd1', userId: 'alice', continuationReqId: expect.any(String) }`.
    - `toWireDecision names the task only on an unattended row`:
      - `toWireDecision(unattended, false, { routineId: 't1', name: 'Zero open support tickets' }).checkIn` equals `SUPPORT`.
      - The same with `attendance: 'attended'` is null.
      - `toWireDecision(unattended).checkIn` is null.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/__tests__/server/routes-workspace-decision-checkins.test.ts src/__tests__/server/routes-workspace.test.ts src/__tests__/server/plugin.test.ts`.
- [ ] **Step 3: Implement,** including the fixture's `checkIn: null`. Without it, `decisionFixture` no longer type-checks.
- [ ] **Step 4: Run them (PASS), plus `src/__tests__/server/manifest-declarations.test.ts` and `src/__tests__/server/routes-workspace-decisions.test.ts`, then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Run `security-checklist`:**
  - A new read on the inbox path. Its conversation ids come from the caller's own decision rows, after the ACL.
  - Owner-only, decided by the service.
  - The name is fenced and drawn as text.
  - It degrades and never fails.
  - No authority moves.
- [ ] **Step 6: Commit:** `git commit -m "Agent Tasks: Today's decision rows carry the check-in they were held in (TASK-932)"`

### Task 6: The words, and the client's check [tier: integration] (invoke `shadcn` and `ux-design`)

**Files:**
- Modify: `lib/workspace-api.ts` (:406-410): a new `isDecisionCheckIn` right above `isDecisionRecord`, which also checks it.
- Modify: `components/workspace/decision-copy.ts` (:76-103): `decisionProvenance` and its doc.
- Create: `components/workspace/__tests__/decision-provenance.test.ts`
- Modify: `lib/__tests__/workspace-api-decision-shape.test.ts`, `components/workspace/__tests__/decision-renderers.test.tsx` (a new describe at the end) and `components/workspace/__tests__/TaskCheckinPage.test.tsx` (:286-305).

**Interfaces (produces):**

```ts
// lib/workspace-api.ts
/** TASK-932. Absent (an older server) reads as no task; present, it is null or two non-empty strings. */
function isDecisionCheckIn(v: unknown): boolean {
  return v === undefined || v === null ||
    (isRecord(v) && isString(v.routineId) && v.routineId.length > 0 && isString(v.taskName) && v.taskName.length > 0);
}
/** Older receipts may omit the marker; present markers use the closed domain. */
function isDecisionRecord(value: unknown): boolean {
  return isRecord(value)
    && (value.routineOperation == null || ROUTINE_DECISION_OPERATIONS.some(name => name === value.routineOperation))
    && isDecisionCheckIn(value.checkIn);
}

// components/workspace/decision-copy.ts
export function decisionProvenance(d: Decision, agentName: string): string {
  // An older server leaves `checkIn` out, which reads as no task (TASK-932).
  const checkIn = d.checkIn ?? null;
  const where =
    d.attendance === 'attended'
      ? `Held in your conversation with ${agentName} — it is still waiting there`
      : checkIn !== null
        ? `Held during a check-in on “${checkIn.taskName}”`
        : `Held during an unattended run · ${agentName} ended its turn rather than wait`;
  return d.status !== 'stale' && d.freshness?.label != null
    ? `${where} · checked against: ${d.freshness.label}`
    : where;
}
```

The doc gains (exact): "An unattended row held during one of the person's task check-ins names the task instead (TASK-932): "Held during a check-in on “{task}”". The server sets `checkIn` only on such rows, so a repeat routine's or a webhook's run, and a row from an older server, keep the unattended-run words." The two renderers draw this line, so neither component changes.

- [ ] **Step 1: Write the failing tests.**
  - `decision-provenance.test.ts`, `describe('decisionProvenance (TASK-932)')`. `CHECK_IN = { routineId: 't1', taskName: 'Zero open support tickets' }`; `CHECKED = ' · checked against: Thursday 9:30 still free for both of you'` (the fixture's label).
    - `names the task a check-in raised it in`: `decisionFixture({ checkIn: CHECK_IN })` with `'Caveman'` → `` `Held during a check-in on “Zero open support tickets”${CHECKED}` ``.
    - `drops "checked against" on a stale check-in row`: `status: 'stale'` → `'Held during a check-in on “Zero open support tickets”'`.
    - `an attended row stays in its conversation`: `attendance: 'attended', checkIn: CHECK_IN` → `` `Held in your conversation with Caveman — it is still waiting there${CHECKED}` ``.
    - `a repeat routine's or a webhook's run keeps the unattended-run words`: `checkIn: null` → `` `Held during an unattended run · Caveman ended its turn rather than wait${CHECKED}` ``.
    - `a row without checkIn, from an older server, reads as no task`: drop the key (`const { checkIn: _gone, ...older } = decisionFixture()`), cast to `Decision`, and expect the unattended-run line.
  - `workspace-api-decision-shape.test.ts`, `describe('the checkIn label (TASK-932)')`. `ROW = { id: 'd1', routineOperation: null }`.
    - `accepts a row whose checkIn is a task, null or absent`: each through `workspaceApi.decisions()`, which resolves.
    - `it.each` `refuses a row whose checkIn is %s, on the list and on the single read`: `'t1'`, `[]`, `{ routineId: 't1' }`, `{ routineId: 1, taskName: 'x' }`, `{ routineId: '', taskName: 'x' }`, `{ routineId: 't1', taskName: '' }` and `{ routineId: 't1', taskName: null }`. Each rejects with `WorkspaceShapeError` from `decisions()`, and then (after `vi.restoreAllMocks()` and a fresh `respondWith({ decision: { ...ROW, checkIn } })`) from `decision('d1')`.
  - `decision-renderers.test.tsx`, a new `describe('TASK-932 — both renderers name the task a check-in raised it in')`:
    - `the queue row and the in-thread card say the same line`: with `d = decisionFixture({ checkIn: CHECK_IN })`, both `queueText(d)` and `cardText(d)` contain `` `Held during a check-in on “Zero open support tickets”${CHECKED}` `` and not `unattended run`.
    - `draws the task name as text`: `decisionFixture({ freshness: null, checkIn: { routineId: 't1', taskName: '<img src=x onerror=alert(1)> **Zero** _open_' } })`. Without a freshness label, the line is exactly `Held during a check-in on “<img src=x onerror=alert(1)> **Zero** _open_”`. Render the expanded `DecisionRow` and the `ApprovalCard` directly. In each container the line is found by exact `getByText`, and `container.querySelector('img, strong, em')` is null.
  - `TaskCheckinPage.test.tsx`: rename `an approval it raised says it was held during an unattended run, not that it is holding` to `an approval it raised names its task, not that it is holding`. `expiring` gains `checkIn: { routineId: 't1', taskName: TASK_NAME }`, and the exact string becomes `'Held during a check-in on “Zero open support tickets” · checked against: Thursday 9:30 still free for both of you'`. Keep the "not holding" and expiry assertions.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/decision-provenance.test.ts src/lib/__tests__/workspace-api-decision-shape.test.ts src/components/workspace/__tests__/decision-renderers.test.tsx src/components/workspace/__tests__/TaskCheckinPage.test.tsx`.
- [ ] **Step 3: Implement.** Invoke `ux-design` on the line, and `shadcn` to confirm no new primitive (none expected). Keep the decided words.
- [ ] **Step 4: Run (PASS), plus `src/components/workspace/__tests__/ApprovalCard.test.tsx` and `src/components/workspace/__tests__/DecisionRow.test.tsx` (unchanged, still green), then** `pnpm --filter @ax/channel-web exec tsc --build`, and the code-point scan on any test file you added escapes to.
- [ ] **Step 5: Commit:** `git commit -m "Agent Tasks: an approval from a check-in says which task it was held for (TASK-932)"`

### Task 7: Open task [tier: integration] (invoke `shadcn` and `ux-design`)

**Files:**
- Modify: `components/workspace/DecisionRow.tsx`:
  - imports (:33-58): `routeLinkProps` from `@/lib/route-link` and `type WorkspaceRoute` from `@/lib/workspace-route`;
  - `Props` (:76-88) and the destructure (:90-101);
  - the action bar's last button (:433-441).
- Modify: `components/workspace/TodayView.tsx`: a new `import type { WorkspaceRoute } from '@/lib/workspace-route';` among its imports (:23-33), `Props` (:64-133, after `onOpenAgent`), the destructure (:136-158) and `renderRow` (:258-271).
- Modify: `components/workspace/WorkspaceShell.tsx`: `onNavigate={navigate}` on `TodayView`, after `onOpenAgent={openAgent}` (:920).
- Modify: `components/workspace/__tests__/DecisionRow.test.tsx`, `components/workspace/__tests__/TodayView.test.tsx` (`renderToday`, :65-86) and `components/workspace/__tests__/consent-focus.test.tsx` (the `TodayView` at :818-833 gains `onNavigate={vi.fn()}`).

**Interfaces (produces):**

```ts
// DecisionRow Props
/**
 * Follows an in-app link (TASK-932's Open task). Without it the row draws no
 * link, rather than one that goes nowhere; `TodayView` always passes it.
 */
onNavigate?: (route: WorkspaceRoute) => void;
// TodayView Props, after onOpenAgent
/** Where an expanded row's links go: the shell's `navigate` (TASK-932's Open task, to the task page). */
onNavigate: (route: WorkspaceRoute) => void;
```

In `DecisionRow`, `const checkIn = d.checkIn ?? null;` (absent reads as null, as in `decisionProvenance`). The last button of the expanded action bar, "Open {agent.name}", moves into one right-aligned group, with the link before it:

```tsx
<div className="ml-auto flex items-center gap-1">
  {/* TASK-932: the task this check-in's approval came from. Secondary: Approve stays the primary action. */}
  {checkIn !== null && onNavigate !== undefined && (
    <Button asChild size="sm" variant="ghost" className="gap-1.5 text-primary">
      <a {...routeLinkProps({ kind: 'task', agentId: d.agentId, routineId: checkIn.routineId }, onNavigate)}>
        Open task
        <ArrowRight size={11} />
      </a>
    </Button>
  )}
  <Button size="sm" variant="ghost" onClick={onOpenAgent} className="gap-1.5 text-primary">
    Open {agent.name}
    <ArrowRight size={11} />
  </Button>
</div>
```

`TodayView` passes `onNavigate={onNavigate}` to every `DecisionRow`. A real `<a href>` with the plain-click guard (TASK-910 decisions row 17): a modified or middle click is the browser's. No link on `ApprovalCard`: the transcript page is the task's own.

- [ ] **Step 1: Write the failing tests.**
  - `DecisionRow.test.tsx` (import `fireEvent`), a new `describe("DecisionRow — a check-in's approval links to its task (TASK-932)")`:
    - `an expanded row links to the task page, and a plain click stays in the app`:
      - Render `renderRow(decisionFixture({ checkIn: CHECK_IN }), true, { onNavigate })`.
      - `getByRole('link', { name: /^Open task/ })` has `href` `/workspace/tasks/scheduler/t1`.
      - `fireEvent.click(link, { ctrlKey: true })` doesn't call `onNavigate`.
      - A plain `fireEvent.click(link)` calls it with `{ kind: 'task', agentId: 'scheduler', routineId: 't1' }`.
    - `draws no link without a check-in, while collapsed, or without a way to navigate`: three renders (unmount between). `queryByRole('link', { name: /Open task/ })` is null each time.
    - `keeps Open {agent} beside it`: with the link drawn, `getByRole('button', { name: /^Open Scheduler/ })` still calls `onOpenAgent`.
  - `TodayView.test.tsx` (import `fireEvent`): `renderToday` passes `onNavigate={vi.fn()}`. New `it('hands an expanded check-in row the shell’s navigation (TASK-932)')`:
    - Render `renderToday({ decisions: [decision({ attendance: 'unattended', checkIn: CHECK_IN })], expandedId: 'd1', onNavigate })`.
    - Clicking the Open task link calls it with `{ kind: 'task', agentId: 'a-quill', routineId: 't1' }`.
- [ ] **Step 2: Run and watch them fail:** `pnpm --filter @ax/channel-web test src/components/workspace/__tests__/DecisionRow.test.tsx src/components/workspace/__tests__/TodayView.test.tsx`.
- [ ] **Step 3: Implement.** Invoke `shadcn` (`Button asChild` on an anchor; no new component) and `ux-design` (placement and focus order next to Open {agent}). Keep the words "Open task".
- [ ] **Step 4: Run (PASS), plus `src/components/workspace/__tests__/consent-focus.test.tsx`, `src/components/workspace/__tests__/decision-renderers.test.tsx`, `src/__tests__/workspace-decision-queue.test.tsx` and `src/components/workspace/__tests__/WorkspaceShell.test.tsx`, then** `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit:** `git commit -m "Agent Tasks: Today's row opens the task an approval came from (TASK-932)"`

### Task 8: The design doc [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`

- [ ] **Step 1: Edit (exact):**
  - **§3.7** (:293-295): the bullet "An approval raised during a check-in shows in that task's thread and transcript. …" gains, after its first sentence: "(As built: the transcript draws it (TASK-911), and Today names its task with an Open task link (TASK-932). An entry in the Updates thread is left for later.)"
  - **§4.5, the Hooks row** (:457): after `` `routines:clear-notes`, `` insert "`routines:tasks-for-conversations` (a read for labels: which conversations are the caller's own task check-ins, TASK-932), ".
  - **§13, New hooks** (:881-888): after "`routines:clear-notes` (TASK-910)," insert "`routines:tasks-for-conversations` (TASK-932, owner-only, absent for anything that isn't the caller's own check-in),".
  - **§15:** append this row at the table's end:

    ```markdown
    | 2026-10-23 | Decided | An approval held during a task check-in names its task on Today, "Held during a check-in on “{task}”", with an Open task link on the expanded row. Routines answers which conversations are the caller's own check-ins (`routines:tasks-for-conversations`) from the run's dispatch binding, so a check-in still running is named too. It is owner-only and a label only: approving is unchanged, and a conversation several runs shared is never named (TASK-932). |
    ```
- [ ] **Step 2: Commit:** `git commit -m "docs(agent-tasks): routines:tasks-for-conversations and Today's check-in label (TASK-932)"`

---

## Card acceptance → tests

| Card acceptance | Test |
|---|---|
| Store: maps a check-in's conversation, open and finished | T2 `names a check-in's conversation while its run is open and after it finishes` |
| Store: excludes repeat routines, other owners' tasks, other agents | T2 `leaves out a repeat routine, another person's task, another agent's task…` |
| Store: leaves out a conversation two routines share | T2 `leaves out a conversation that more than one run shares, whichever routines they belong to` (covers two runs of one routine too, decisions row 2) |
| Store: an unparseable definition row doesn't throw | T2 `still names a check-in whose definition no longer parses`, `leaves out only the conversation whose task name the contract refuses` |
| Service: `access` first; input caps; `return-schemas.test.ts` | T3 (all three), T1 |
| `canary.test.ts`: a check-in's held call, read through the service, names its task | T4 |
| Route: unattended check-in row carries a fenced `checkIn` | T5 `names the task…`, `fences the task name…` |
| Route: attended, repeat-routine and another person's task carry null | T5 `carries null on…` |
| Route: lookup failure → 200, `checkIn: null`, logs | T5 `still answers 200 when one agent's lookup fails…` (and the deadline test) |
| Route: single read and approve, dismiss, undo carry the same `checkIn` | T5 `the single read and the approve, dismiss and undo answers carry the same checkIn` |
| `WIRE_KEYS` | T5 |
| Without the hook, every row is null | T5 `without routines:tasks-for-conversations every row carries null` |
| `decisionProvenance`: check-in, attended, unattended-repeat, stale | T6 `decision-provenance.test.ts` |
| `DecisionRow` expanded shows the line and the Open task link | T6 (the line, `decision-renderers.test.tsx`); T7 (the link) |
| `ApprovalCard` on `TaskCheckinPage` shows it | T6 (`TaskCheckinPage.test.tsx`, and the card in `decision-renderers.test.tsx`) |
| `isDecisionRecord` refuses a malformed `checkIn` | T6 (`workspace-api-decision-shape.test.ts`) |
| The task name renders as literal text | T6 `draws the task name as text`; T5 (server fencing) |

## Before the PR

- **Gates:** `pnpm build && DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Docker-backed packages may fail with "Waited 40000 ms for a container start slot". Re-run those one at a time (routines with `VITEST_MAX_WORKERS=2`) and report both runs (`.claude/memory/patterns/2026-10-22-TASK-910.md`).
- **Boundary review (new hook `routines:tasks-for-conversations`):**
  - **Alternate impl:** an external task tracker that records which run produced which conversation, or a SQLite routines store over the same dispatch binding.
  - **Payload names that might leak:** none. `conversationId` is core's concept, and `routineId` and `name` are routine vocabulary. No `dispatch`, `req_id` or table names.
  - **Subscriber risk:** none, it's a service. Callers use it for labels and grouping only, never as authorization, and treat an absent conversation (ambiguous, not a task, not theirs) the same way.
  - **Wire surface:** not an IPC action. Its schema lives in `@ax/routines-contract` with the other routines services.
- **Security note:** combine Tasks 2, 3 and 5. State plainly:
  - the caller-supplied ids are parameterized, capped and owner-filtered in SQL after `agents:resolve`;
  - not-yours and not-a-task answer alike, so the hook is no oracle;
  - the name is person-approved, still fenced, and drawn as text;
  - the query is bounded, and the inbox has a deadline;
  - no authority moves.
- **Deploy:** none yet. Nothing from Agent Tasks is deployed, and this card adds no migration.
- **Handoff:** list the departures above (decisions rows 2, 3, 4, 7, 8, 9, 12), the accepted edges (row 13), the YAGNI cuts (row 15) and the follow-up (the kind on the dispatch row).
