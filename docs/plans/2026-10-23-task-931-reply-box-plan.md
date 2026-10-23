# TASK-931: the reply box (stored, in every check-in, starts one now) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task's owner replies to their agent on the task page. The reply is stored, shown in Updates, carried (the last 20) in every later check-in message, and it starts a check-in now; after a reply or Check now the page shows "Checking in now…" until the update lands.

**Architecture:** One new table, `routines_v1_replies` (routines schema **version 8**), written only by `store.addReply` under the agent fence and the routine's row lock, owner-only. Two new services in `@ax/routines`: `routines:reply` stores the reply, then starts a check-in through `routines:fire-now`'s accept/dispatch path, keyed on the reply so a retry can never start two; `routines:recent-replies` is an owner-only read. `fire.ts` reads the last 20 replies into the check-in message as their own quoted block. channel-web adds `POST /api/workspace/tasks/:agentId/:routineId/replies`, carries fenced replies on the task detail, and the task page grows a standalone `TaskReplyBox`, a merged Updates timeline and a 10-second poll.

**Tech Stack:** TypeScript, zod 3.25, Kysely + Postgres (testcontainers), vitest, React 19 + shadcn (channel-web).

**Spec:** the TASK-931 card (orchestrator scratchpad `TASK-931/card.md`) and `docs/plans/2026-10-20-agent-tasks-design.md` §3.3, §4.1, §4.2, §4.5, §7, §12 PR 2. Decisions: `.claude/memory/decisions/2026-10-23-TASK-931.md` (rows cited as [n]).

## Global Constraints

- Routines schema **version 8** (TASK-930 took 7). Every `versions()` pin in `migrations.test.ts` becomes `[2, 3, 4, 5, 6, 7, 8]`.
- `ROUTINE_REPLY_MAX_CHARS = 2000` (UTF-16 units, like every contract cap). The check-in message carries `CHECK_IN_REPLIES = 20`; the task page shows `50`; `routines:recent-replies` clamps `limit` to 1–50 and defaults to 20.
- Copy is exact and uses U+2019 for apostrophes and U+2026 for "…". Component and message tests assert it verbatim.
- Invisible-character test inputs are built with `String.fromCodePoint(0x200b)` / `String.fromCharCode(0xd800)`, never typed as backslash-u escape text (the Write/Edit tools have turned that into raw characters three times: `mistakes/2026-10-23-TASK-932.md`). If you do write an escape, run the code-point scan from `mistakes/2026-10-20-TASK-904.md` on the file.
- Run one file with `pnpm --filter @ax/<pkg> test <file>` — the filter before the script, never `-- <file>`. Check the file count in the summary.
- Docker: `@ax/routines` store, service, fire, check-in and canary tests start Postgres; export `DOCKER_HOST` first (CLAUDE.md, Docker-backed tests). `@ax/routines-contract` tests and the channel-web files named below don't. A whole channel-web run includes six Docker-backed files.
- channel-web type-checks its test files: after any task that touches channel-web or a type it imports, run `pnpm --filter @ax/channel-web exec tsc --build`. channel-web `src/lib/*.ts` modules import siblings as relative `./x.js`, never `@/lib/...` (the server build can't resolve the alias).
- One worktree: run the tasks one after another. channel-web's `tsc --build` recompiles `routines` and `routines-contract` and writes their `dist/` (TASK-932 decisions row 17).
- No new dependency, shadcn component or `pnpm-lock.yaml` change. Installed and used: `Textarea` (forwards its ref), `Field`/`FieldLabel`/`FieldDescription`/`FieldError` (`FieldError` is `role="alert"`), `Button`, `Spinner` (pass `aria-hidden="true"` inside another live region or a button), `Card`. Semantic tokens only. UI tasks invoke `shadcn` and `ux-design`; `ux-design` may reword copy the card didn't fix, and the change is recorded in the shard.
- Nothing about replies is a tool, an IPC action or part of any routine view: replies reach a model only in a check-in message.
- Memory rows go to shards (`scripts/memory-write-target.sh --shard <kind> TASK-931`), never a root archive.
- Final gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

## Review Focus

1. **The 10-second re-reads while "Checking in now…".** For up to five minutes a re-read runs every 10 s. Done through the ordinary `refresh()`, each one marks the task refreshing, which disables Check now and Pause (dropping a keyboard user's focus to `<body>`) and turns any failed read into a red "couldn't refresh" alert. The person should be able to press anything at any moment and see no alarm for a background blip. → Task 9, "the 10-second re-reads leave Check now and Pause pressable and raise no refresh alert, even when one fails", and the `refreshQuietly` tests.
2. **A retry after a partial failure.** The reply was stored, then the host died or the database blipped before the check-in was accepted. Sending again must start exactly one check-in — never zero (the old "replayed starts nothing" rule) and never two. → Task 3, "a retry after the first try stored the reply but never started its check-in starts it, once".
3. **An edit after an unconfirmed send.** "We couldn't confirm your reply was sent", the person fixes a typo and sends again: that must be a new reply, not a replay that silently keeps the first text while the box clears. → Task 7, "an edited text after an unconfirmed send is a new reply".
4. **Browser and host clocks a little apart.** The poll must still stop when the check-in it started lands, and a check-in already running at the press must not stop it. → Task 9, the `arrivedCheckIn` slack tests.
5. **Paused, or an owner who no longer manages the agent's tasks.** Stored, no check-in, and no copy anywhere that promises one. → Task 3 (answer order) and Task 7 (four helper lines).

(Also pinned, less likely: the routine paused, edited or deleted between the reply's write and its check-in's accept → Task 2, "a reply racing a delete stores nothing"; Task 3, "the routine changing between the reply and its check-in".)

## Where the code refined the card

- **Version 8**, not 7 [1].
- **The check-in a reply starts is keyed on the reply** (`acceptDispatch` `requestId: 'reply:' + replyId`), and a replayed reply runs the check-in decision again, so Review Focus 1 converges to one check-in [4].
- **Answer order:** `not-allowed`, then `paused`, then `started`, so `paused` ("when you resume the task") is only said to someone who can resume [5].
- **The text rule's messages speak to the person** and name the first invisible character's position; the box checks the same schema before it sends [7].
- **The brief's fixed text** told every check-in that its message holds only the agent's own text; it gains one line about replies (rule 5) [9].
- **`TaskReplyBox` takes `canStart`**: an owner who can't manage the agent's tasks sees the page and must not be promised a check-in [14].
- **The request id is kept only for the same text** [15].
- **Ties in Updates:** a check-in a reply started has the same or a later time, so at equal times the check-in shows above the reply [16].
- **The poll's stop rule** compares against what was on the page at the press, not the browser's clock against the host's [17].
- **The poll re-reads quietly** (`refreshQuietly`): the ordinary refresh disables the header buttons and alarms on a failed read [17].
- **One voice per outcome:** the box's started line is "Sent. {agent} started checking in." (the card's "is checking in now" goes stale on screen), the page's "Checking in now…" is hidden from screen readers when a reply started it, and the arrival line follows the arrived check-in's status [15][17].
- **Errors are worded per HTTP status:** `workspaceApi` carries only the status (`WorkspaceApiError`) [15].

## Boundary review (new service hooks `routines:reply`, `routines:recent-replies`)

- **Alternate impl:** an external tracker's comment thread on the task (Linear or Asana comments), or a SQLite routines store with the same table.
- **Payload names that might leak:** none. `text`, `sentAt`, `replyId`, `authorUserId`, `requestId` are domain or house words; `checkIn` is a closed product vocabulary (`started | paused | not-allowed | replayed`).
- **Subscriber risk:** none, they are services. `checkIn: 'started'` means a run was accepted, not finished; consumers must not treat it as a result. channel-web never forwards `authorUserId` or `replyId`.
- **Wire surface:** not an IPC action and not a tool. Schemas live in `@ax/routines-contract` with the other routine services.

## Tiers, order, security

| Task | Tier | Needs | security-checklist |
|---|---|---|---|
| 1 Contract: text rule and schemas | sensitive | — | **run** |
| 2 Migration v8 and store | sensitive | 1 | **run** |
| 3 Services | sensitive | 2 | **run** |
| 4 Check-in message, fire, brief | sensitive | 2 | **run** |
| 5 Routines canary | integration | 3, 4 | — |
| 6 channel-web routes, wire, manifest | sensitive | 1 | **run** |
| 7 Client API and `TaskReplyBox` | integration | 6 | — |
| 8 Updates timeline | integration | 6 | — |
| 9 Poll, page wiring, Reply button | integration | 7, 8 | — |
| 10 Design doc | mechanical | all | — |

Run in order 1 → 10 in one worktree. The PR's security note (from `security-checklist`) covers: a person's text crossing browser → host → model, screened (length, blank, invisible, lone surrogate) before any write; owner-only, decided under the routine's row lock; quoted and labelled in the check-in message, never in `brief`; kept out of team-readable history (`renderedPrompt: null`), memory (check-in conversations are refused capture) and transcripts (TASK-911 drops user rows); a reply costs a model run through fire-now's accept/dispatch path and `fire` permission, at most once per reply, under the usual usage limits (no rate limit: one check-in at a time is design PR 5); CSRF through the global guard; the page renders replies as plain text.

## File map

- `packages/routines-contract/src/definition.ts`, `services.ts` (T1).
- `packages/routines/src/migrations.ts`, `store.ts`, `types.ts` (T2); `services.ts` (T3); `checkin-message.ts`, `fire.ts`, `brief.ts` (T4).
- `packages/routines/src/__tests__/`: `store-fixture.ts`, `migrations.test.ts`, new `reply-store.test.ts` (T2); `return-schemas.test.ts`, new `reply.test.ts` (T3); `checkin-message.test.ts`, `fire.test.ts`, `checkin.test.ts`, `brief.test.ts` (T4); `support/check-in.ts`, `canary.test.ts` (T5).
- `packages/channel-web/src/lib/workspace-types.ts`, `server/routes-workspace.ts`, `server/plugin.ts` (T6); `lib/workspace-api.ts`, new `components/workspace/TaskReplyBox.tsx` (T7); `lib/task-updates.ts`, `components/workspace/TaskUpdates.tsx` (T8); new `lib/use-task-poll.ts`, `components/workspace/TaskPage.tsx`, `lib/workspace-task.ts` (T9).
- `docs/plans/2026-10-20-agent-tasks-design.md` (T10).

---

### Task 1: Contract — the reply text rule and the two services' schemas [tier: sensitive]

**Files:**
- Modify: `packages/routines-contract/src/definition.ts` (after `RoutineReportFieldShape`; `LONE_SURROGATE` and `firstHiddenCharacter` live here)
- Modify: `packages/routines-contract/src/services.ts` (after the `tasks-for-conversations` schemas; add the types to the type block)
- Create test: `packages/routines-contract/src/__tests__/reply.test.ts`

**Interfaces — Produces** (exported from `@ax/routines-contract`):
```ts
// definition.ts
export const ROUTINE_REPLY_MAX_CHARS = 2000;
export const RoutineReplyTextSchema: z.ZodEffects<z.ZodString, string, string>;
// services.ts
export const ROUTINE_REPLIES_MAX_LIMIT = 50;
export const ROUTINE_REPLY_CHECK_INS = ['started', 'paused', 'not-allowed', 'replayed'] as const;
export const RoutineReplyCheckInSchema = z.enum(ROUTINE_REPLY_CHECK_INS);
export const RoutineReplyInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema, text: RoutineReplyTextSchema }).strict();
export const RoutineReplyOutputSchema = z.object({ replyId: RoutineOpaqueStringSchema, checkIn: RoutineReplyCheckInSchema }).strict();
export const RoutineRecentRepliesInputSchema = RoutineKeySchema.extend({ limit: z.number().int().min(1).max(ROUTINE_REPLIES_MAX_LIMIT).optional() }).strict();
export const RoutineReplyViewSchema = z.object({ replyId: RoutineOpaqueStringSchema, authorUserId: z.string().min(1), text: z.string(), sentAt: RoutineInstantSchema }).strict();
export const RoutineRecentRepliesOutputSchema = z.object({ replies: z.array(RoutineReplyViewSchema) }).strict();
export type RoutineReplyCheckIn; RoutineReplyInput; RoutineReplyOutput; RoutineRecentRepliesInput; RoutineRecentRepliesOutput; RoutineReplyView; // z.output of each
```

- [ ] **Step 1: Write the failing tests** in `reply.test.ts`:
  - `ROUTINE_REPLY_MAX_CHARS` is 2000.
  - `RoutineReplyTextSchema` accepts, unchanged: `'Refunds under $100 are fine.\n\nAsk me about the rest.'`; `'x'.repeat(2000)`; `` `${'x'.repeat(1998)}${String.fromCodePoint(0x1f600)}` `` (2000 units, a whole pair at the end); `'a\tb\r\nc'`.
  - It refuses with exactly one issue, message verbatim: `''` and `' \n\t '` → `'Write a reply first.'`; `'x'.repeat(2001)` → `'A reply can be up to 2,000 characters.'`; `` `ok${String.fromCodePoint(0x200b)}then` `` → `'A reply can’t contain invisible characters (U+200B at character 3).'`; `` `${String.fromCodePoint(0xe0041)}hi` `` → `'A reply can’t contain invisible characters (U+E0041 at character 1).'`; `` `ok${String.fromCharCode(0xd800)}` `` → `'A reply can’t contain broken characters.'`.
  - `RoutineReplyInputSchema` parses `{ agentId: 'a', routineId: 'r', requestId: 'q', text: 'hi' }`; refuses an extra key, a missing or empty `requestId`, a 257-character one.
  - `RoutineReplyOutputSchema` parses each of the four `checkIn` values; refuses `'finished'`, an extra key, a missing `replyId`.
  - `RoutineRecentRepliesInputSchema` takes `limit` omitted, 1 and 50; refuses 0, 51, 1.5 and an extra key.
  - `RoutineRecentRepliesOutputSchema` parses `{ replies: [{ replyId: 'reply_1', authorUserId: 'owner', text: 'x'.repeat(3000), sentAt: '2026-10-23T09:00:00.000Z' }] }` (stored text isn't re-capped, TASK-913); refuses an extra key on a reply (`ownerUserId`) and on the root, and `sentAt: 'yesterday'`.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines-contract test src/__tests__/reply.test.ts` — expect FAIL (exports missing).
- [ ] **Step 3: Implement.** `RoutineReplyTextSchema` is built like `reportText`: `z.string().min(1, 'Write a reply first.').max(ROUTINE_REPLY_MAX_CHARS, 'A reply can be up to 2,000 characters.').superRefine(…)`, returning early when the length is out of range (one issue per failure), then blank (`trim() === ''`) → invisible (`firstHiddenCharacter`, its code point formatted as `briefFieldIssue` does: hex, upper case, padded to 4) → `LONE_SURROGATE`. Newlines are allowed; padding isn't refused (a person's own words). Doc comment: person-written, owner-only, reaches a model only in a check-in message; the messages reach the person (the reply box shows them), unlike `reportText`'s. The services' schemas get a doc block each like `clear-notes`' (who may, neither a tool nor an IPC action, `checkIn: 'started'` means accepted not finished, `authorUserId` is for the caller's own "was this me" and never leaves the host).
- [ ] **Step 4: Run** the file, then `pnpm --filter @ax/routines-contract test`.
- [ ] **Step 5: Commit** `feat(routines-contract): a reply's text rule and the reply services' schemas (TASK-931)`.

### Task 2: Migration v8 and the store [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/migrations.ts` (`RepliesRow`, `RoutinesDatabase.routines_v1_replies`, version 8 in `runRoutinesMigration`, new `addRepliesTable` with its doc)
- Modify: `packages/routines/src/types.ts`, `packages/routines/src/store.ts` (interface + `createRoutinesStore`: `addReply`, `recentReplies`; `purgeAgent`; `deleteAuthored`)
- Modify: `packages/routines/src/__tests__/store-fixture.ts` (add `routines_v1_replies` to the `TRUNCATE` list, or replies leak between tests in a file)
- Modify: `packages/routines/src/__tests__/migrations.test.ts` (the nine `[2, 3, 4, 5, 6, 7]` pins at lines 75, 88, 100, 123, 158, 174, 181, 193, 204 → add 8; one new test)
- Create test: `packages/routines/src/__tests__/reply-store.test.ts` (`fixture()`; Postgres)

**Interfaces:**
- Consumes: `RoutineKey` (contract).
- Produces:
  ```ts
  // migrations.ts
  export interface RepliesRow { reply_id: string; agent_id: string; routine_id: string; author_user_id: string; request_id: string; body: string; created_at: Date }
  // types.ts
  /** TASK-931. A person's reply on a task, as stored. Person-written. */
  export type StoredReply = { replyId: string; authorUserId: string; text: string; sentAt: Date };
  export type AddReplyResult = { outcome: 'added' | 'replayed'; replyId: string; row: StoredRoutine } | 'not-found' | 'forbidden';
  // store.ts, RoutinesStore
  addReply(input: RoutineKey & { actorUserId: string; requestId: string; text: string; now: Date }): Promise<AddReplyResult>;
  recentReplies(input: RoutineKey & { limit: number }): Promise<StoredReply[]>;
  ```
- Version 8, in the advisory-locked transaction, gated on `routines_schema_versions` row 8 (the version-7 shape):
  ```sql
  CREATE TABLE IF NOT EXISTS routines_v1_replies (
    reply_id text PRIMARY KEY, agent_id text NOT NULL, routine_id text NOT NULL,
    author_user_id text NOT NULL, request_id text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL,
    CONSTRAINT routines_v1_replies_request_unique UNIQUE (agent_id, routine_id, author_user_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS routines_v1_replies_by_routine ON routines_v1_replies (agent_id, routine_id, created_at DESC);
  ```
  No foreign key, no CHECK on `body` [2].

- [ ] **Step 1: Write the failing tests.**
  - `migrations.test.ts`, new `it('version 8 adds the replies table; a re-run keeps its rows (TASK-931)')`: migrate; `DROP TABLE routines_v1_replies`; delete version row 8; `insertTask()`; migrate twice → `versions()` is `[2, 3, 4, 5, 6, 7, 8]`; the table has exactly the seven columns; `routines_v1_replies_by_routine` is in `pg_indexes`; `constraintCount('routines_v1_replies_request_unique', 'routines_v1_replies')` is 1; INSERT a reply, then a second row with a new `reply_id` and the same four keys rejects with `{ code: '23505', constraint: 'routines_v1_replies_request_unique' }`; delete version row 8, migrate → the first reply is still there and `findOne` still reads the task. Update the nine existing pins.
  - `reply-store.test.ts` (a task is `createAuthored({ ...createInput('<distinct id>'), definition: RoutineDefinitionSchema.parse({ name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' }, kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.' }) })`, owner `'owner'`; every create in a test passes its own request id to `createInput`, since its default `'create-1'` would replay or `request-conflict` the second create, as `tasks-for-conversations.test.ts` avoids; a task on agent `b` also sets `agentId: 'b'`):
    - "the owner adds a reply, and replies read back newest first": `addReply({ …key, actorUserId: 'owner', requestId: 'r1', text: 'First.', now })` → `{ outcome: 'added', replyId: expect.stringMatching(/^reply_/), row: expect.objectContaining({ routineId, kind: 'stay-on-top', ownerUserId: 'owner' }) }`; a second at `now + 60 s`; `recentReplies({ …key, limit: 20 })` → `[{ replyId, authorUserId: 'owner', text: 'Second.', sentAt }, { …'First.' }]`.
    - "a retry with the same requestId answers replayed with the first id and keeps the first text": same requestId, text `'Changed.'` → `{ outcome: 'replayed', replyId: <first> }`; one row, `'First.'`.
    - "the same requestId on another task, or from another person, is another reply" (the unique key spans agent, routine and author: insert the other person's row by SQL, since `addReply` refuses a non-owner).
    - "anyone but the owner is forbidden, and nothing is stored" (`actorUserId: 'editor'` → `'forbidden'`; zero rows).
    - "a repeat routine, a missing routine and a retired agent are not-found" (`createInput()`'s routine; an unknown id; after `purgeAgent('a')`), zero rows.
    - "recentReplies clamps its limit to 1–50 and reads one routine only": 52 replies; `limit: 0` → 1 (the newest); `limit: 51` → 50; `limit: 3` → the three newest; another task's replies never appear.
    - "purgeAgent removes that agent's replies only" (tasks on agents `a` and `b`).
    - "deleteAuthored removes that routine's replies only" (two tasks on `a`).
    - "replies survive a change of kind" (`updateAuthored` patch `{ kind: 'repeat', goodWhen: null }` → still listed) [decision 6 of the card].
    - "a reply racing a delete stores nothing": in a manual `f.db.transaction()`, lock the task's definition row `FOR UPDATE` and hold the transaction open on a deferred promise; start `addReply` without awaiting it; `expect.poll` until `pg_stat_activity` shows one backend with `wait_event_type = 'Lock'` (so `addReply` is really blocked on the row); then delete the definition row in the manual transaction and commit. `addReply` resolves `'not-found'` and there are zero reply rows. Without the poll the test passes vacuously (the delete can land before `addReply` reads); with it, an `addReply` that doesn't lock reads the row, inserts, and fails the test.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines test src/__tests__/reply-store.test.ts src/__tests__/migrations.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** `addReply` [3]: one `db.transaction()`: `lockLiveAgent` (false → `'not-found'`); the definition row `forUpdate()` (missing or `kind === 'repeat'` → `'not-found'`; `owner_user_id !== actorUserId` → `'forbidden'`); `rowToRoutine(raw)` before writing; `insertInto('routines_v1_replies')` with `reply_id: opaqueId('reply')`, `body: text`, `created_at: now`, `.onConflict(oc => oc.columns(['agent_id', 'routine_id', 'author_user_id', 'request_id']).doNothing()).returning('reply_id')`; no row back → select the existing row's `reply_id` → `'replayed'`. `recentReplies`: `Math.min(50, Math.max(1, limit))`, `orderBy('created_at', 'desc').orderBy('reply_id', 'desc')`, mapped to `StoredReply`. `purgeAgent`: delete the agent's replies inside its transaction, before the definitions delete. `deleteAuthored`: delete the routine's replies after `lockRoutine`, before the definition delete. Docs on the interface say: owner-only under the row lock, a retry keeps the first text, replies outlive a kind change and go with their routine or agent.
- [ ] **Step 4: Run** the two files, then `pnpm --filter @ax/routines test` (whole package; on "container start slot" timeouts re-run with `VITEST_MAX_WORKERS=2`, patterns TASK-910).
- [ ] **Step 5: Commit** `feat(routines): replies table (schema v8) and owner-only reply store (TASK-931)`.

### Task 3: Services — `routines:reply` and `routines:recent-replies` [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/services.ts` (`ROUTINE_SERVICES` += `'reply'`, `'recent-replies'`; register both, each with a comment block like `clear-notes`')
- Modify: `packages/routines/src/__tests__/return-schemas.test.ts` (`toHaveLength(18)` → 20; `toContain` both; title)
- Create test: `packages/routines/src/__tests__/reply.test.ts` — the TASK-932 pattern (`tasks-for-conversations.test.ts:150-166`): `fixture()`'s real store, a `HookBus` with stub `agents:resolve` (a TEAM agent `{ id: 'a', ownerType: 'team', ownerId: 'team-1' }`, so `reconcileOwners` never rewrites owners; callers outside `reach` throw `PluginError` `forbidden`) and `agents:can-manage-routines` (`{ allowed }`), `registerRoutineServices({ bus, now, store: { ...f.store, ...overrides }, dispatch, admitDispatch? })` with a `dispatch` that records each `AcceptedDispatch` and answers `{ status: 'ok' }`. Postgres.

**Interfaces:**
- Consumes: Task 1 schemas; Task 2 `addReply`, `recentReplies`; existing `acceptDispatch`, `findOne`, `routineOwners`, `routinePermissions`, `admitDispatch`, `dispatch`.
- Produces: `routines:reply` (`RoutineReplyInput` → `RoutineReplyOutput`), `routines:recent-replies` (`RoutineRecentRepliesInput` → `RoutineRecentRepliesOutput`). Info line `routines_reply_added { agentId, routineId, checkIn, replayed }`.
- The decision after the reply is stored [4][5] — the order is the point, so here it is:
  ```ts
  async function replyCheckIn(ctx: AgentContext, allowed: boolean, row: StoredRoutine, replyId: string): Promise<C.RoutineReplyCheckIn> {
    if (!routinePermissions(row, ctx.userId, allowed).fire) return 'not-allowed';
    if (!row.enabled) return 'paused';
    const key = { agentId: row.agentId, routineId: row.routineId };
    let result;
    try {
      result = await store.acceptDispatch({ ...key, expectedRevision: row.revision, actorUserId: ctx.userId, source: 'manual', requestId: `reply:${replyId}`, now: now() });
    } catch (err) {
      // This reply's check-in was accepted before, against an earlier revision.
      if (err instanceof SafeToolError && err.toolCode === 'request-conflict') return 'replayed';
      throw err;
    }
    if (result === null) {
      const fresh = await store.findOne(key);
      if (fresh === null) throw new SafeToolError('not-found', 'routineId');
      if (!fresh.enabled) return 'paused';
      throw new SafeToolError('unavailable', 'input'); // the reply is stored; a resend replays it and starts the check-in
    }
    if (result.replayed) return 'replayed';
    await dispatch!(result.accepted);
    return 'started';
  }
  ```
  `dispatch()`'s `{ status }` is not read: `started` means accepted, not finished, and a check-in that fails during setup is recorded as a failed run that the page shows (Task 9's arrival line). `routines:reply` = `admitDispatch(async () => { access(); if (!dispatch) throw unavailable; addReply (not-found → SafeToolError('not-found','routineId'), forbidden → SafeToolError('forbidden','input')); replyCheckIn; log; return { replyId, checkIn } })` — the whole handler inside `admitDispatch`, like `fire-now`, the log line on every success with `replayed: outcome === 'replayed'`. `routines:recent-replies` = `access()`; `store.routineOwners({ agentId, routineIds: [routineId] })`; not `ctx.userId` (or no entry) → `{ replies: [] }`; else `recentReplies({ …, limit: input.limit ?? 20 })` mapped field by field, `sentAt.toISOString()` [6].

- [ ] **Step 1: Write the failing tests.**
  - `return-schemas.test.ts`: `ROUTINE_SERVICES` has 20 and contains `'routines:reply'` and `'routines:recent-replies'`; `RoutineReplyOutputSchema.parse({ replyId: 'reply_1', checkIn: 'started' })` round-trips and refuses an extra `text` key; `RoutineRecentRepliesOutputSchema` refuses a reply with `ownerUserId`.
  - `reply.test.ts` — `routines:reply`:
    - "a reply on a running task is stored and starts one manual check-in, keyed on the reply": `{ replyId: /^reply_/, checkIn: 'started' }`; one dispatch with `source: 'manual'` for the task; `routines_v1_requests` holds one `operation = 'dispatch'` row with `request_id = 'reply:' + replyId`.
    - "a retry with the same requestId answers replayed with the same id and starts nothing more" (still one dispatch).
    - "a retry after the first try stored the reply but never started its check-in starts it, once": override `acceptDispatch` to throw `new Error('connection reset')` once → the first call rejects and one reply row exists; the second call → `{ replyId: <same>, checkIn: 'started' }`, one dispatch; a third → `'replayed'`, still one.
    - "a retry after the task changed answers replayed and starts no second check-in": started; `f.store.updateAuthored` (patch `{ goodWhen: 'Nothing waits a day.' }`, new revision); retry → `'replayed'`; one dispatch.
    - "a paused task stores the reply and starts nothing" → `'paused'`, no dispatch, `recentReplies` has it.
    - "an owner who can't manage the agent's tasks gets not-allowed, paused or not" (`allowed: false`; enabled and paused) → `'not-allowed'`, no dispatch, stored.
    - "the routine changing between the reply and its check-in": override `acceptDispatch` → `null` and `findOne` → `null` → rejects `{ toolCode: 'not-found' }`; → a disabled row → `'paused'`; → an enabled row → rejects `{ toolCode: 'unavailable' }`; no dispatch in any; the reply stays stored.
    - "nobody but the task's owner may reply" (`teammate` in `reach`) → `{ toolCode: 'forbidden' }`, zero rows.
    - "a repeat routine and a missing routine are not-found", zero rows.
    - "agents:resolve runs first, and a caller it refuses stores nothing" → `{ code: 'forbidden' }`, zero rows.
    - "refused text never reaches the store" (`''`, 2001 characters, a U+200B built with `String.fromCodePoint`) → `{ toolCode: 'validation' }`, zero rows.
    - "without dispatch, a reply is refused before anything is stored" (register without `dispatch`) → `{ toolCode: 'unavailable' }`, zero rows.
    - "while the host shuts down, a reply is refused before anything is stored" (`admitDispatch: async () => { throw new SafeToolError('unavailable', 'input'); }`), zero rows.
    - "logs one line per reply, ids and closed words only": through `logged(ctx)` (`support/report-log.ts`), one `routines_reply_added` at info whose keys are within `['level', 'ts', 'reqId', 'msg', 'agentId', 'routineId', 'checkIn', 'replayed']`; the reply's text appears in no line; a replay logs `replayed: true`.
  - `reply.test.ts` — `routines:recent-replies`:
    - "the owner reads their replies newest first, with who wrote each": `{ replies: [{ replyId, authorUserId: 'owner', text, sentAt: '<ISO>' }, …] }`; `limit: 1` → the newest.
    - "anyone else, and a routine that's gone, gets none" (`teammate` → `{ replies: [] }`; unknown routine → `{ replies: [] }`).
    - "agents:resolve runs first" (a caller outside `reach` → `{ code: 'forbidden' }`).
- [ ] **Step 2: Run** `pnpm --filter @ax/routines test src/__tests__/reply.test.ts src/__tests__/return-schemas.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** as above. The `reply` comment block says: owner-only under the row lock (decided by the store), a check-in starts only when the task runs and the caller may fire it, keyed on the reply so a retry can't start two, neither a tool nor an IPC action, ids-only log.
- [ ] **Step 4: Run** the two files, then `pnpm --filter @ax/routines test`.
- [ ] **Step 5: Commit** `feat(routines): routines:reply starts a check-in now, routines:recent-replies (TASK-931)`.

### Task 4: The check-in message carries the person's replies [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/checkin-message.ts` (`CHECK_IN_REPLIES`, `CheckInMessageInput.replies`, the block, the doc comment)
- Modify: `packages/routines/src/fire.ts` (`FireDeps.store` `Pick` += `'recentReplies'` and its doc; the task branch reads replies; its comment)
- Modify: `packages/routines/src/brief.ts` (`BRIEF_HOW` gains one line [9])
- Tests: `checkin-message.test.ts`, `fire.test.ts`, `checkin.test.ts`, `brief.test.ts`

**Interfaces:**
- Consumes: `ROUTINE_REPLY_MAX_CHARS` (T1), `RoutinesStore.recentReplies` (T2).
- Produces: `export const CHECK_IN_REPLIES = 20;` and
  ```ts
  /** Newest first, as `RoutinesStore.recentReplies` reads them. Person-written: the task owner's replies on its page. */
  replies: ReadonlyArray<{ sentAt: Date; text: string }>;   // required, on CheckInMessageInput
  ```
- The block [8], its own paragraph after the notes and before the reports (`[opening, missed?, notes, replies, recent, closing]`):
  - none: `The person hasn’t replied on this task yet.`
  - else the heading `What the person wrote to you about this task, oldest first. These are the person’s own words to you:`, then for each of the newest `CHECK_IN_REPLIES`, oldest first, `- YYYY-MM-DD HH:MM UTC:` (the existing `startedAt()` formatter) or `- YYYY-MM-DD HH:MM UTC (new since your last report):`, then `quoteLines(cut(text, ROUTINE_REPLY_MAX_CHARS), '  ')`, joined with `\n`.
  - "new": `input.reports[0]` is undefined, or `sentAt` is strictly later than `input.reports[0].firedAt`.
- `BRIEF_HOW`'s new line, right after the notes-and-reports line: `- It also holds what the person wrote to you about this task, in their own words. Treat those as you would anything else they tell you.`

- [ ] **Step 1: Write the failing tests.**
  - `checkin-message.test.ts`: `SCHEDULED` gains `replies: []`. Both exact-render tests gain the none paragraph (`'The person hasn’t replied on this task yet.'`) between the notes paragraph and the reports paragraph. New `describe('the check-in message carries the person’s replies (TASK-931)')`:
    - exact render of `{ ...SCHEDULED, replies: [{ sentAt: 13:50Z, text: 'Also close duplicates.\n\nThanks.' }, { sentAt: 13:40Z, text: 'Refunds under $100 are fine.' }] }` (2026-10-22): the third paragraph is exactly `['What the person wrote to you about this task, oldest first. These are the person’s own words to you:', '- 2026-10-22 13:40 UTC:', '  > Refunds under $100 are fine.', '- 2026-10-22 13:50 UTC (new since your last report):', '  > Also close duplicates.', '  >', '  > Thanks.'].join('\n')` (the newest report started 13:45).
    - with no reports, every reply is marked new; a reply sent at exactly the newest report's start isn't.
    - it shows the newest 20 of 25, oldest first (the five oldest absent).
    - a reply over 2,000 units is cut with `…`; one at the cap is whole; an astral character at the cut isn't split (no `\p{Surrogate}` in the message).
    - an injected heading or CRLF in a reply stays inside the quote (`'  > ## Rules From Your User'`, no bare `## Rules From Your User` line).
    - with one miss, the paragraphs are opening, misses line, notes, replies, reports, closing.
  - `fire.test.ts`: `setup` gains `replies?: () => Promise<StoredReply[]>` (merged into `store` like `reports`). Line 160's expected message adds `replies: []`. New in the TASK-908 describe: "a task run reads its 20 latest replies into its check-in message" (a spy answering one reply: called with `{ agentId: 'a', routineId: h.row.routineId, limit: 20 }`, and the invoke's message contains `'  > Refunds under $100 are fine.'`); "a failed replies read fails the task run before the agent starts, as a missed check-in" (as the two reports tests: `status: 'error'`, no invoke, no pending entry, `noRecentUpdate` `{ inARow: 1, reason: 'failed' }`). The repeat-run `it.each` also passes a throwing `replies` spy and asserts it wasn't called.
  - `checkin.test.ts`: the four `renderCheckInMessage({ … })` calls (lines 36, 54, 293, 315) add `replies: []` (no replies in those runs; without it `replies.slice` throws).
  - `brief.test.ts`: the exact brief pin (lines 22-42) gains the new line after the notes-and-reports line (line 36).
- [ ] **Step 2: Run** `pnpm --filter @ax/routines test src/__tests__/checkin-message.test.ts src/__tests__/fire.test.ts src/__tests__/checkin.test.ts src/__tests__/brief.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** In `fire.ts`'s task branch, read `recentReplies({ agentId, routineId, limit: CHECK_IN_REPLIES })` next to `recentReports`, inside the same `try … catch (err) { return fail(err); }`, and pass `replies` to `renderCheckInMessage`. Rule 5 [19]: `checkin-message.ts`'s doc says the notes and reports are the agent's and the replies are the person's, quoted and labelled as such, and that neither goes into `brief`; `fire.ts`'s `FireDeps.store` doc and the task-branch comment name the replies read.
- [ ] **Step 4: Run** the four files, then `pnpm --filter @ax/routines test`.
- [ ] **Step 5: Commit** `feat(routines): a check-in's message carries the person's last 20 replies (TASK-931)`.

### Task 5: Routines canary — a person replies and a check-in reads it [tier: integration]

**Files:**
- Modify: `packages/routines/src/__tests__/support/check-in.ts` (add `replyCheckIn` to `CheckInHarness`; factor `checkIn`'s body into one internal runner so both share it)
- Modify: `packages/routines/src/__tests__/canary.test.ts` (new `describe('replies canary (TASK-931)')` at the end)

**Interfaces:**
- Produces: `replyCheckIn(view: RoutineView, requestId: string, text: string, body: CheckInBody, opts?: CheckInOptions): Promise<CheckIn & { answer: RoutineReplyOutput }>` — like `checkIn`, but starts the check-in with `routines:reply` (as `opts.asOwner ?? h.owner`) and throws `The reply started no check-in (it answered <checkIn>).` unless the answer is `started`.

- [ ] **Step 1: Write the failing test** `it('a person replies, a check-in starts at once, and its message carries the reply; the next one marks only the newer reply new; a retry starts nothing')`, with a manual clock (the PR 1 canary's `clock` at `canary.test.ts:474-483`: `now` starts at `Date.parse('2026-10-09T12:00:00Z')`, `sleep` waits to be woken) passed to `createCheckInHarness({ clock })`, and `now += 60_000` before each reply, so reply 1 and its check-in are at 12:01 and reply 2 and its check-in at 12:02:
  1. Assign `h = ch` (as the TASK-930 canary does) so the file's `afterEach` closes the harness; add `routineRunner` to the `./support/check-in.js` import. Create the task (`TASK_DEFINITION`).
  2. `replyCheckIn(task, 'reply-1', 'Refunds under $100 are fine to approve without asking me.', body)`, where `body` reports `{ status: 'on-track', update: 'Approved two small refunds.', ask: null }` through `tool:execute:routine_report` as `routineRunner(ctx)`: the answer is `{ replyId: /^reply_/, checkIn: 'started' }`; the message contains `'- 2026-10-09 12:01 UTC (new since your last report):\n  > Refunds under $100 are fine to approve without asking me.'` (no report yet, so it's new). Then `expect.poll` until the task has one fire.
  3. `replyCheckIn(task, 'reply-2', 'Also close duplicate tickets.', an empty body)`: the message contains `'- 2026-10-09 12:01 UTC:\n  > Refunds under $100 are fine to approve without asking me.\n- 2026-10-09 12:02 UTC (new since your last report):\n  > Also close duplicate tickets.'` (reply 1 was sent in the same instant the reporting check-in started, so it reads as seen).
  4. `routines:reply` again with `'reply-2'` and its text → `{ replyId: <step 3's>, checkIn: 'replayed' }`; the fire count stays 2 and `routines_v1_dispatches` holds 2 rows.
  5. `routines:recent-replies` as the owner → two replies, newest first, `authorUserId: h.owner.userId`.
- [ ] **Step 2: Run** `pnpm --filter @ax/routines test src/__tests__/canary.test.ts` — expect FAIL (no `replyCheckIn`).
- [ ] **Step 3: Implement** `replyCheckIn`.
- [ ] **Step 4: Run** the file, then `pnpm --filter @ax/routines test`.
- [ ] **Step 5: Commit** `test(routines): replies canary (TASK-931)`.

### Task 6: channel-web server — `POST …/replies`, replies on the task detail, the manifest [tier: sensitive]

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-types.ts` (`TaskReply`, `TaskReplyCheckIn`, `TaskReplyResponse`, `TaskDetail.replies`)
- Modify: `packages/channel-web/src/server/routes-workspace.ts` (hook types next to `TaskFiresInput`; `TASK_REPLIES_LIMIT`, `TASK_REPLY_MAX_CHARS`, `TASK_REPLY_MAX_LINES` next to the notes caps; `toTaskReply`; `toTaskDetail(agent, view, fires, replies, userId)`; `taskDetail` reads replies; new `taskReply` handler; route registration after `…/notes`; the header route list; the security paragraph's "three routes")
- Modify: `packages/channel-web/src/server/plugin.ts` (two `optionalCalls` after `routines:tasks-for-conversations`; a "TASK-931 adds no hard call either" header line)
- Modify: `packages/channel-web/src/__tests__/server/plugin.test.ts` (the exact pin, same two entries, same place)
- Modify: `packages/channel-web/src/__tests__/server/routes-workspace-registration.test.ts` (lines 65-67 pin the other task routes with `toContain`; add `'POST /api/workspace/tasks/:agentId/:routineId/replies'`, or a forgotten registration ships a dead route with every handler test green)
- Modify: `packages/channel-web/src/__tests__/server/routes-workspace-task.test.ts`
- Modify (fixtures the required field forces; add `replies: []`): `src/lib/__tests__/workspace-api-task.test.ts` (`DETAIL`, the `body` at line 84), `src/lib/__tests__/workspace-task.test.ts` (`detail()`), `src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx` (`TASK_DETAIL`), `src/components/workspace/__tests__/TaskPage.test.tsx` (`detail()`)

**Interfaces — Produces:**
```ts
// workspace-types.ts
export type TaskReplyCheckIn = RoutineReplyOutput['checkIn'];   // import type from '@ax/routines-contract'
/** One reply in a task's Updates. `text` is the person's, fenced; null when nothing legible survived. */
export interface TaskReply { sentAt: string; text: string | null; byYou: boolean }
export interface TaskReplyResponse { checkIn: TaskReplyCheckIn }
// TaskDetail gains (after updates): /** The person's replies, newest first, at most 50 (TASK-931). */ replies: TaskReply[];
// routes-workspace.ts
const TASK_REPLIES_LIMIT = 50;
const TASK_REPLY_MAX_CHARS = 6 * ROUTINE_REPLY_MAX_CHARS;
const TASK_REPLY_MAX_LINES = ROUTINE_REPLY_MAX_CHARS + 1;
// POST /api/workspace/tasks/:agentId/:routineId/replies   body { text: string; requestId: string } → 200 TaskReplyResponse
// handlers.taskReply
```
- `taskReply` order [12]: `authOr401` → `taskKeyOr400` → `JSON.parse(req.body.toString('utf-8'))` (400 `invalid-json`) → `text` a string and `requestId` a non-empty string (400 `invalid-body`) → `!bus.hasService('routines:reply')` → 503 `task-replies-unavailable` → `resolveAgentOr404` → `routines:reply` with `agentWorkspaceCtx(key.agentId, userId)` and the input built field by field `{ agentId, routineId, requestId, text }`. Catch: `SafeToolError` with `toolCode === 'validation'` → 400 `reply-invalid` (checked BEFORE `isTaskRefusal`, which counts `validation` as a 404); `isTaskRefusal` → 404 `task-not-found`; else rethrow. 200 `{ checkIn }`.
- `taskDetail`: after the fires read, `bus.hasService('routines:recent-replies') ? (await bus.call('routines:recent-replies', own.ctx, { ...key, limit: TASK_REPLIES_LIMIT })).replies : []`; any throw propagates. `toTaskReply(reply, userId)` = `{ sentAt: reply.sentAt, text: fenceBlock(reply.text, TASK_REPLY_MAX_CHARS, TASK_REPLY_MAX_LINES)?.text ?? null, byYou: reply.authorUserId === userId }` [13].
- `optionalCalls` entries (and `plugin.test.ts`'s pin), verbatim:
  - `{ hook: 'routines:reply', degradation: 'the reply box on the task page (POST /api/workspace/tasks/:agentId/:routineId/replies) answers 503 and nothing is sent' }`
  - `{ hook: 'routines:recent-replies', degradation: 'the task page shows no replies in its Updates thread' }`

- [ ] **Step 1: Write the failing tests** in `routes-workspace-task.test.ts`. `World` gains `replies: RoutineReplyView[]` (what `routines:recent-replies` answers), `repliesFailure`, `replyAnswer: RoutineReplyOutput` (default `{ replyId: 'REPLY-ID-0', checkIn: 'started' }`) and `replyFailure`; register both stubs with the contract's `returns` schemas; record calls (with a shared order log); add `reply(params, body)` beside `detail`/`clear`.
  - POST: "sends the reply as the caller and answers what it did about a check-in" → 200, body `toStrictEqual({ checkIn: 'started' })`; the hook got exactly `{ agentId: 'a1', routineId: 't1', requestId: 'req-1', text: 'Refunds under $100 are fine.' }` as `alice` (an extra body key `{ …, agentId: 'zzz', admin: true }` is not forwarded).
  - `it.each` 400s, none calling `agents:resolve` or the hook: unparseable body → `invalid-json`; `[]`, `{}`, `{ text: 3, requestId: 'r' }`, `{ text: 'hi' }`, `{ text: 'hi', requestId: '' }` → `invalid-body`.
  - "400s text the service refuses" (`replyFailure: new SafeToolError('validation', 'input')`) → 400 `reply-invalid`.
  - `it.each` refusals `SafeToolError('forbidden', 'input')`, `SafeToolError('not-found', 'routineId')`, `PluginError` `not-found` → 404 `task-not-found`.
  - "404s an agent the caller can't reach, without asking to reply" (`viewer: 'mallory'`) → 404, no hook call.
  - "503s without routines:reply, before reading the agent" → `task-replies-unavailable`, `resolveCalls` empty.
  - "401s without a session", "400s a blank id" (nothing called).
  - "fails the request on any other failure, rather than saying it was sent" (`replyFailure: new Error('database down')`) → the handler rejects and no 200 was written.
  - GET: every whole-body `toStrictEqual` (and `satisfies TaskDetail`) in the file gains `replies: []`. New: "carries the owner's replies, fenced, newest first, with byYou and nothing else" — `replies: [{ replyId: 'REPLY-ID-1', authorUserId: 'alice', text: 'Line one.\nLine two.', sentAt: '2026-10-22T15:00:00.000Z' }, { replyId: 'REPLY-ID-2', authorUserId: 'carol', text: `x${String.fromCodePoint(0x202e)}y`, sentAt: '2026-10-22T14:00:00.000Z' }, { …, authorUserId: 'alice', text: '   ' }]` → `[{ sentAt, text: 'Line one.\nLine two.', byYou: true }, { sentAt, text: 'x' + String.fromCharCode(0x5c) + 'u202ey', byYou: false }, { sentAt, text: null, byYou: true }]`; `JSON.stringify(body)` contains none of `'authorUserId'`, `'carol'`, `'REPLY-ID'`, `'replyId'`.
  - "asks for the newest 50 replies, as the caller, after the check-ins" (call input `{ agentId: 'a1', routineId: 't1', limit: 50 }`, user `alice`; order log `recent-fires` then `recent-replies`).
  - "without routines:recent-replies the page has no replies" → 200, `replies: []`.
  - "a failed replies read fails the page" → rejects, no 200.
  - "reads no replies for a task that isn't the caller's" (the existing 404 cases record no `recent-replies` call).
  - `plugin.test.ts`: the pinned `optionalCalls` gain the two entries after `routines:tasks-for-conversations`.
  - `routes-workspace-registration.test.ts`: the mounted routes contain `'POST /api/workspace/tasks/:agentId/:routineId/replies'`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test src/__tests__/server/routes-workspace-task.test.ts src/__tests__/server/plugin.test.ts src/__tests__/server/manifest-declarations.test.ts src/__tests__/server/routes-workspace-registration.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Call both hooks with string literals at each `bus.call`/`bus.hasService` (`manifest-declarations.test.ts` checks both directions). Rule 5 [19]: the header route list gains `POST /api/workspace/tasks/:agentId/:routineId/replies — reply to the agent about that task (TASK-931)`; the security paragraph's task routes become four, the reply route reads nothing before the service decides ownership under its lock (like `/notes`), and its text is the person's, screened by the contract before any write; `toTaskDetail`'s doc names the replies, fenced as a block with no author.
- [ ] **Step 4: Run** the four files, then `pnpm --filter @ax/channel-web exec tsc --build` and `pnpm --filter @ax/channel-web test src/lib src/components/workspace/__tests__/TaskPage.test.tsx src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx`.
- [ ] **Step 5: Commit** `feat(channel-web): reply route and replies on the task detail (TASK-931)`.

### Task 7: Client API and `TaskReplyBox` [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-api.ts` (`isTaskReply`; `isTaskDetail` checks `replies`; `sendTaskReply`)
- Modify: `packages/channel-web/src/lib/__tests__/workspace-api-task.test.ts`
- Create: `packages/channel-web/src/components/workspace/TaskReplyBox.tsx`
- Create: `packages/channel-web/src/components/workspace/__tests__/TaskReplyBox.test.tsx` (mock `@/lib/workspace-api` with `sendTaskReply: vi.fn()`, as `TaskPage.test.tsx` mocks it)

**Interfaces:**
- Consumes: `TaskReply`, `TaskReplyCheckIn`, `TaskReplyResponse` (T6); `RoutineReplyTextSchema`, `ROUTINE_REPLY_CHECK_INS` (T1).
- Produces:
  ```ts
  workspaceApi.sendTaskReply(agentId: string, routineId: string, input: { text: string; requestId: string }): Promise<TaskReplyResponse>
  // POST `${taskPath(agentId, routineId)}/replies` through `req` (CSRF header), checkedRead: checkIn ∈ ROUTINE_REPLY_CHECK_INS
  export function TaskReplyBox(props: {
    agentId: string; routineId: string; agentName: string;
    enabled: boolean;
    /** The task's `permissions.fire`: whether a reply can start a check-in (for its owner, also whether they can resume it). */
    canStart: boolean;
    onSent: (checkIn: TaskReplyCheckIn) => void;
    inputRef?: Ref<HTMLTextAreaElement>;
  }): ReactElement
  ```
- Copy, verbatim [14][15]:
  - Label: `Reply to ${agentName} about this task`.
  - Helper (`FieldDescription`): enabled + canStart `${agentName} reads your replies every time it checks in. Sending one starts a check-in now.`; enabled only `${agentName} reads your replies every time it checks in.`; paused + canStart `It’s paused, so ${agentName} will read this once you resume it.`; paused only `It’s paused, so ${agentName} will read this once it’s resumed.`
  - Sent (a `role="status"` line mounted with the box, empty until a send): `started` and `replayed` `Sent. ${agentName} started checking in.` (the card's "is checking in now" goes false once the check-in ends, while the line is still on screen [15]); `paused` `Sent. ${agentName} will read it when you resume the task.`; `not-allowed` `Sent. ${agentName} will read it at its next check-in.`
  - Failures (`FieldError`), never the server's words: unconfirmed `We couldn’t confirm your reply was sent. Try again, and it won’t be sent twice.`; 401 `HTTP_SESSION_ENDED`; 403/404 `We couldn’t find this task any more. It may have been deleted.`; other 4xx `We couldn’t send that reply as written. Change it and try again.`; the contract rule's first issue message when the text fails `RoutineReplyTextSchema` (nothing sent).
- Behaviour: a `<form>`; `Textarea` (`rows={3}`, `ref={inputRef}`, `aria-describedby` the helper and any error, `aria-invalid` on a rule failure, `readOnly` while sending); Send is `type="submit"`, `variant="secondary"` (one primary per screen stays Check now or Resume), with an inline `Spinner` while sending, disabled while `text.trim() === ''` or sending. Ctrl+Enter or Cmd+Enter submits unless `nativeEvent.isComposing`. The request id: reuse the pending one only when its text equals the text being sent; drop it on success or a confirmed failure (an `HttpError` with status 1–499); keep it on an unconfirmed one (not an `HttpError` — which covers `TypeError` network failures and `WorkspaceShapeError` — or status 0 or ≥ 500). On success: clear the text, show the sent line, call `onSent(checkIn)`. Typing clears the last sent line or error. Focus: a clicked Send goes disabled while sending (and stays disabled once the box clears), which drops focus on `<body>`; when a send settles, if focus is on `<body>` or on Send, it moves to the textarea (TaskPage's rule: someone who moved on meanwhile stays where they went). The textarea needs the box's own ref as well as `inputRef`: merge them with a callback ref.

- [ ] **Step 1: Write the failing tests.**
  - `workspace-api-task.test.ts`: "reads a task's replies" (`replies: [{ sentAt, text: 'Hi', byYou: true }, { sentAt, text: null, byYou: false }]`); "refuses a body without replies, or a reply without byYou" (`WorkspaceShapeError`); "sends a reply with POST, the CSRF header and only the text and request id" (fetch URL `/api/workspace/tasks/a1/t1/replies`, `method: 'POST'`, `x-requested-with: ax-admin`, body `{ text, requestId }`); "refuses an answer that doesn't say what happened about a check-in" (`{ checkIn: 'finished' }`, `{}`); "carries the status of a failed send" (503 → `WorkspaceApiError` with `status` 503).
  - `TaskReplyBox.test.tsx`:
    - the label, and each of the four helper lines.
    - "Send waits for something to send" (disabled empty and for `'   '`; enabled once typed).
    - "sends the text, clears the box and says the check-in started" (called with `('a1', 't1', { text, requestId: expect.any(String) })`; `onSent('started')`; textarea empty; status line exact).
    - `it.each` of the other three sent lines (`replayed` reads as `started`).
    - "Ctrl+Enter and Cmd+Enter send; Enter alone doesn't, nor while composing".
    - "an unconfirmed send keeps its request id for the same text, so a retry can’t store it twice" — `it.each` of a 503 `WorkspaceApiError`, `new TypeError('Failed to fetch')` and a `WorkspaceShapeError`: the second send's `requestId` equals the first's; `onSent` once.
    - "an edited text after an unconfirmed send is a new reply" (503, edit, send → a different `requestId`).
    - "a refusal drops the request id" (400 → its line verbatim; the next send has a new id), and the 404 and 401 lines verbatim.
    - "checks the text the way the host does before sending" (2001 characters → `A reply can be up to 2,000 characters.`; a U+200B at character 3 → `A reply can’t contain invisible characters (U+200B at character 3).`; `aria-invalid="true"`; `sendTaskReply` not called).
    - "the text can't change while it sends" (`readOnly` until the promise settles).
    - "after a clicked Send settles, focus is back in the box" (success and failure); "focus someone moved elsewhere meanwhile stays there".
    - "inputRef reaches the textarea".
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-api-task.test.ts src/components/workspace/__tests__/TaskReplyBox.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** with `shadcn` and `ux-design` invoked first. The file's header says: standalone so TASK-933 can put it on Today (Today must decide `canStart`: `TaskRow` carries no permissions); the person's own text; why the request id is kept and when it's dropped.
- [ ] **Step 4: Run** the two files and `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit** `feat(channel-web): TaskReplyBox and the reply client call (TASK-931)`.

### Task 8: Updates merges the person's replies with the check-ins [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/task-updates.ts` (`foldTimeline` replaces `foldUpdates`; `TimelineItem` replaces `UpdateItem`; header)
- Modify: `packages/channel-web/src/lib/__tests__/task-updates.test.ts`
- Modify: `packages/channel-web/src/components/workspace/TaskUpdates.tsx` (`replies` prop, a reply entry, header)
- Modify: `packages/channel-web/src/components/workspace/__tests__/TaskUpdates.test.tsx` (`renderThread(updates, replies = [])`)
- Modify: `packages/channel-web/src/components/workspace/TaskPage.tsx` (pass `replies={detail.replies}` only)

**Interfaces:**
- Consumes: `TaskReply` (T6).
- Produces:
  ```ts
  export type TimelineItem =
    | { kind: 'update'; update: TaskUpdate }
    | { kind: 'reply'; reply: TaskReply }
    | { kind: 'fold'; updates: TaskUpdate[] };
  /** Both lists newest first in; one newest-first timeline out. Never mutates its inputs. */
  export function foldTimeline(updates: readonly TaskUpdate[], replies: readonly TaskReply[]): TimelineItem[];
  // TaskUpdates props gain `replies: TaskReply[]` (required)
  ```
- Merge [16]: walk both lists in their own order; take the check-in while its `firedAt` instant is at or after the reply's `sentAt` (so a tie puts the check-in above), else the reply; an instant `Date.parse` can't read counts as `-Infinity`. Then fold as before: a quiet check-in's following consecutive quiet check-ins fold when at least `FOLD_MIN_HIDDEN`; a reply ends the run and never folds.
- A reply entry: the `updateStamp(sentAt, now)` column, an empty `StateDotSlot` (no mark, no sr-only group word), then one `<p className="… whitespace-pre-wrap break-words …">` holding `<span className="font-medium">You</span>` (or `Someone else` when `byYou` is false), a space, and the text, or `We can’t show this reply.` when it is null. No See what it did.

- [ ] **Step 1: Write the failing tests.**
  - `task-updates.test.ts`: every `foldUpdates(ups)` becomes `foldTimeline(ups, [])` with the same expectations. New: "interleaves replies and check-ins, newest first"; "at the same instant, the check-in a reply started shows above the reply"; "a reply breaks a quiet run and never folds" (on-track check-ins at 10:50, 10:40, 10:30, 10:20, 10:10 and a reply at 10:35 → `[u50, u40, r35, u30, fold[u20, u10]]`); "replies alone come out as given"; "a reply with an unreadable time goes after every check-in"; "doesn't change its inputs".
  - `TaskUpdates.test.tsx`: "a reply shows its time, You and the text, with no mark and no link" (`textContent` is exactly `` `${updateStamp(sentAt, NOW)}You Refunds under $100 are fine.` ``, no link in the item); "someone else's reply says so"; "a reply that can't be shown says so"; "a reply keeps its line breaks and draws as plain text" (`'**bold** <img src=x onerror=alert(1)>\nsecond line'` appears as text; no `img` or `strong` element; the `p` has `whitespace-pre-wrap`); "a reply between quiet check-ins breaks the fold" (the fold line reads `2 earlier check-ins, all on track`, not 3).
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test src/lib/__tests__/task-updates.test.ts src/components/workspace/__tests__/TaskUpdates.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** with `shadcn` and `ux-design`. Rule 5 [19]: both headers say the thread holds check-ins and the person's replies.
- [ ] **Step 4: Run** the two files, `TaskPage.test.tsx`, and `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit** `feat(channel-web): Updates shows the person's replies beside the check-ins (TASK-931)`.

### Task 9: "Checking in now…", the reply box on the page, and Reply on the latest card [tier: integration]

**Files:**
- Create: `packages/channel-web/src/lib/use-task-poll.ts` (relative imports)
- Create test: `packages/channel-web/src/lib/__tests__/use-task-poll.test.ts` (`renderHook`, `vi.useFakeTimers()`)
- Modify: `packages/channel-web/src/lib/workspace-task.ts` (`refreshQuietly`, and its header) and `src/lib/__tests__/workspace-task.test.ts`
- Modify: `packages/channel-web/src/components/workspace/TaskPage.tsx`
- Modify: `packages/channel-web/src/components/workspace/__tests__/TaskPage.test.tsx`

**Interfaces:**
- Consumes: `TaskReplyBox` (T7), `TaskUpdates` with `replies` (T8).
- Produces:
  ```ts
  // workspace-task.ts: useTask also returns
  /** A background re-read (the poll's): it doesn't mark the task refreshing, and a failed one leaves the page as it is (logged). One that finds the task gone or the session ended still replaces it, like any read. */
  refreshQuietly: () => void;
  // use-task-poll.ts
  export const TASK_POLL_INTERVAL_MS = 10_000;
  export const TASK_POLL_LIMIT_MS = 300_000;
  /** How far before the press a check-in may have started and still be the one the press started: browser and host clocks differ a little. */
  export const TASK_POLL_CLOCK_SLACK_MS = 60_000;
  export type TaskPollPhase = 'idle' | 'checking' | 'arrived' | 'timed-out';
  /** Pure: the newest check-in in `updates` that wasn't there at the press (`seen`, keyed `${firedAt}|${conversationId ?? ''}`) and started no earlier than `at - TASK_POLL_CLOCK_SLACK_MS`; else null. */
  export function arrivedCheckIn(updates: readonly TaskUpdate[], press: { at: number; seen: ReadonlySet<string> }): TaskUpdate | null;
  export function useTaskPoll(updates: readonly TaskUpdate[] | null, reread: () => void): {
    phase: TaskPollPhase;
    /** Who started the current poll: the reply box speaks for its own check-in, so the page doesn't say it again. */
    startedBy: 'check-now' | 'reply' | null;
    /** The check-in that ended it, while `phase` is `arrived`. */
    arrived: TaskUpdate | null;
    start: (by: 'check-now' | 'reply') => void;
    stop: () => void;
  };
  ```
- `start(by)`: clears any running timers, records `{ at: Date.now(), seen }` from the latest `updates` (kept in a ref) and `by`, phase `checking`, `setInterval(reread, 10 s)` and a 5-minute timeout to `timed-out`. While `checking`, every new `updates` is checked: an arrival → clear, `arrived` (keeping the entry); `null` (the page failed) → clear, `idle`. `stop()` → clear, `idle`. Unmount clears.
- TaskPage [17][18]: `const { state, refresh, refreshQuietly } = useTask(…)`; `const poll = useTaskPoll(detail?.updates ?? null, refreshQuietly)`. The poll's re-reads must not touch `refreshing` (which disables Check now and Pause through `busy`, and drops a keyboard user's focus to `<body>` every 10 s), nor show the "couldn't refresh" alert. `useTaskActions` takes `poll`: a Check now press calls `poll.stop()` when it starts and `poll.start('check-now')` when `fireNow` answers `ok` (replacing `{ said: CHECKING_IN }`; `CHECKING_IN` and the `said` arm of `Notice` go); Pause and Resume don't touch it; the ordinary `refresh()` after every press stays (the next press needs the new revision). The existing `role="status"` line shows: `checking` → `<span aria-hidden={poll.startedBy === 'reply' || undefined}><Spinner aria-hidden="true" …/>Checking in now…</span>` (visible either way; when a reply started it, the box has already said so, TASK-651's "each outcome once"); `arrived` → `${agentName} finished checking in.`, or `The check-in didn’t finish. The reason is under Updates.` when `poll.arrived.status === 'error'` (a reply whose check-in failed during setup still answers `started`: accepted, not finished [5]); `timed-out` → `Still checking in. Its update will be under Updates when it’s done.`; `idle` → nothing. `TaskReplyBox` renders after `TaskUpdates` with `enabled={detail.enabled}`, `canStart={detail.permissions.fire}`, `inputRef={replyRef}` and `onSent={checkIn => { if (checkIn === 'started' || checkIn === 'replayed') poll.start('reply'); refresh(); }}`. `LatestUpdate` gets `onReply`: after `${agentName} asks: …` on both the normal card and the missed-check-in card (whose ask is muted), an `outline`, `size="sm"`, self-start `Reply` button that calls `replyRef.current?.focus()`.

- [ ] **Step 1: Write the failing tests.**
  - `workspace-task.test.ts`: "a quiet re-read keeps the task on screen without marking it refreshing, and a failed one leaves it as it was" (`refreshing` stays false; after a rejected read `refreshFailed` stays false and `detail` is unchanged); "a quiet re-read that finds the task gone or the session ended replaces it" (404 → `{ kind: 'failed', error: 'gone' }`, 401 → `expired`).
  - `use-task-poll.test.ts`: "re-reads every 10 seconds while checking" (2 calls at 20 s); "stops when a check-in that wasn't there at the press arrives, and keeps it" (rerender with an update whose `firedAt` is the fake now → `arrived`, `arrived` is that entry, no call in the next 30 s); "a check-in already there at the press doesn't stop it"; "a check-in that started up to a minute before the press stops it, one that started earlier doesn't" (59 s → `arrived`; 61 s → still `checking`); "stops at five minutes, not before" (`checking` at 299 999 ms, `timed-out` at 300 000, no call after); "a second start resets the five minutes and says who started it"; "stop clears it" (`idle`, no calls); "stops when the page can't show the task" (`null` → `idle`); "unmount stops re-reading".
  - `TaskPage.test.tsx` (it already runs `vi.useFakeTimers({ shouldAdvanceTime: true })` and `vi.setSystemTime(NOW)` in `beforeEach`, line 153: advance with `await act(async () => { await vi.advanceTimersByTimeAsync(ms); })` and query synchronously, the `AgentViewStop.test.tsx` "never-stuck fallback" pattern):
    - Existing tests the box now breaks: line 292's `screen.queryByRole('textbox')` is scoped to the brief, `within(screen.getByRole('region', { name: 'About this task' }))`; the unscoped `screen.getByRole('status')` at lines 319, 325, 389 and 503 become a `pageStatus()` helper, `screen.getAllByRole('status')[0]` (the page's line comes before the box's in document order). The mock adds `sendTaskReply: vi.fn()`. `CHECKING_IN` becomes `'Checking in now…'` in every test that uses it (lines 46, 324, 326, 369, 391, 398, 416, 448, 717).
    - New `describe('TaskPage: replies and checking in now (TASK-931)')`: "the reply box sits under Updates" (the textbox `Reply to Quill about this task` follows the Updates region in document order); "a paused task's box says it'll be read once resumed" and "an owner who can't manage the agent's tasks isn't promised a check-in" (helper lines verbatim); "Reply on the latest card focuses the box" (`document.activeElement` is the textbox); "no Reply when the agent asks nothing"; "the missed check-in card's muted ask has Reply too"; "a reply that started a check-in reads the task again at once and shows Checking in now…, hidden from the screen reader because the box said it" (the span is `aria-hidden="true"`); "after Check now the line is announced" (no `aria-hidden`); "a reply to a paused task reads the task again and doesn't say it's checking in"; "after Check now the page reads the task every 10 seconds until its update arrives, then says it finished" (`taskMock` calls at 10 s and 20 s; the third answer holds a new update → `Quill finished checking in.`; no call at 30 s); "the 10-second re-reads leave Check now and Pause pressable and raise no refresh alert, even when one fails" (both buttons enabled across a tick whose read is pending; a rejected tick shows no `We couldn’t refresh this task just now…` alert); "a check-in that didn't finish says so when it arrives" (`The check-in didn’t finish. The reason is under Updates.`); "after five minutes it stops reading and says it's still checking in".
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test src/lib/__tests__/workspace-task.test.ts src/lib/__tests__/use-task-poll.test.ts src/components/workspace/__tests__/TaskPage.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** with `shadcn` and `ux-design`. `refreshQuietly` is `load` with a flag: no `refreshing: true` before, and on a `'failed'` outcome keep the state (log it as `load` already does); `'expired'`/`'gone'` replace it as before. Rule 5 [19]: `TaskPage.tsx`'s "WHAT IS SAID OUT LOUD" paragraph describes the poll's lines (one polite region mounted with the task; a Check now press clears it so each press is heard; the reply box speaks its own sent line, so the page's "Checking in now…" for a reply is hidden from screen readers; the arrival line follows the arrived check-in's status); `workspace-task.ts`'s header lists the reply's re-read and the poll's quiet re-reads.
- [ ] **Step 4: Run** the three files, the whole `src/components/workspace` folder, and `pnpm --filter @ax/channel-web exec tsc --build`.
- [ ] **Step 5: Commit** `feat(channel-web): the task page takes replies and shows "Checking in now…" (TASK-931)`.

### Task 10: Design doc [tier: mechanical]

**Files:** Modify `docs/plans/2026-10-20-agent-tasks-design.md`.

- [ ] **Step 1: Edit** (rule 5 [19]):
  - §3.3, after the TASK-911 note: a `> PR 2 (TASK-931):` note — only the task's owner replies, on team agents too; a reply is stored and shows in Updates beside the check-ins (the page shows the last 50, never folded); every later check-in's message carries the last 20, oldest first, quoted as the person's own words, and marks the ones newer than the last report; sending one starts a check-in now (as Check now does, even while one runs) when the task is running and the person manages the agent's tasks, and otherwise is read at the next check-in; after a reply or Check now the page says "Checking in now…" and re-reads every 10 seconds for up to 5 minutes; the latest update's ask has a Reply button. Up to 2,000 characters, no invisible or broken characters.
  - §4.5 Replies row: append "(TASK-931: `routines_v1_replies`, schema version 8, with each reply's request id so a retry is stored once; the task page shows the last 50.)"; Hooks row: add `routines:recent-replies` (the owner's replies, for the task page) after `routines:reply`.
  - §7: one bullet — a reply is the owner's own words: owner-only, screened before it's stored, and it reaches a model only in a check-in's message, quoted and labelled, never in the brief, never in run history anyone else reads, never in memory; each reply starts at most one check-in, under the usual limits.
  - §13: add `routines:recent-replies` after `routines:reply`.
  - §15: Decided rows, dated 2026-10-23, for: owner-only replies; a reply starts a check-in now, even while one runs, and a paused task or an owner who can't manage the agent's tasks stores it without one; the check-in is keyed on the reply so a retry starts at most one; replies survive a kind change and go with their task or agent; the message carries the last 20, the page the last 50; the page polls after Check now or a reply (10 s, 5 minutes).
- [ ] **Step 2: Verify** `pnpm test:scripts` (doc-path guards) passes.
- [ ] **Step 3: Commit** `docs(agent-tasks): replies as built (TASK-931)`.

---

## Handoff notes for the builder

- Before Task 1, check `git log origin/main..HEAD` and that `migrations.ts` still ends at version 7; if a sibling merged a version 8 first, take 9 and say so in the shard.
- TASK-921 (reports after a notes clear) and TASK-927 (UTC times) touch `checkin-message.ts`: the replies block is its own paragraph and its own helper, so a rebase keeps both sides.
- TASK-933 reuses `TaskReplyBox` on Today: it must supply `canStart` (`TaskRow` has no permissions) and its own `onSent`.
