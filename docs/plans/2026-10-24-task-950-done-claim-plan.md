# TASK-950: "I think it's done", then Mark done or Not yet, and a Done filter on Tasks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Get something done" check-in can end with `done: true` (status "needs-you"), which puts the task in Needs you on Tasks and Today; the person presses **Mark done** (the task stops checking in, keeps its steps and report, and drops off the Tasks list a week later into a Done filter) or **Not yet** with a reply (the claim goes, a check-in starts); a Done task can be **Reopened** with a reply, or switched back on in Settings.

**Architecture:** The contract adds `done` to the report (refused unless the status is "needs-you"), a `done: { at }` on every routine view, `doneClaimed` on the task view, and two services, `routines:complete` and `routines:reopen`. The store (schema version 13) keeps the claim as a stamp of the report that made it, and Done as a completion that only counts while the task is a disabled get-done task completed by its owner (`doneOf`). Mark done reuses the pause machinery through a request receipt; Reopen is a reply that also clears the claim and, on a Done task, runs it again. channel-web adds two POST routes, a Done group and filter on Tasks, the claim card, Mark done and Reopen on the task page, and a claimed block on Today.

**Tech Stack:** TypeScript, zod 3.25, Kysely on Postgres (testcontainers, or the local-pg shim), vitest, React + shadcn (channel-web).

**Spec:** card TASK-950 (orchestrator dispatch `scratchpad/dispatch/prompt-950.txt`, lines 1-260); `docs/plans/2026-10-20-agent-tasks-design.md` §3.1, §3.4, §3.5, §3.6, §4.5, §7, §12 PR 3; decisions `.claude/memory/decisions/2026-10-24-TASK-950.md` (rows cited as "decisions row N"). Prior plans for style and code: `docs/plans/2026-10-24-task-948-get-done-steps-plan.md`, `docs/plans/2026-10-23-task-930-failure-ladder-plan.md`.

## Where the code refined the card

Every MEASURED predecessor learning checked out at be148ac53, at drifted lines (decisions row 1). These are the places the code changes what to build:

1. **The tool's report schema can't take an object refinement and stay a `ZodObject`:** the JSON-schema parity test and `report.test.ts` read its `.shape`, and a refinement on the `done` field alone can't see `status`. The schema becomes a `ZodEffects` and the two tests read `innerType()` (Task 1; decisions row 2).
2. **The claim is a stamp, `task_done_claimed_at`, not a boolean** (decisions row 3): code from before version 13 writes reports and moves owners without touching it, and a boolean would show a stale claim beside a newer report. The view is unchanged (`doneClaimed: boolean`).
3. **Done is `doneOf(row)`: get-done, completed, not enabled, completed by its owner** (decisions row 4), not "a time is enough". Older code can resume a Done task without clearing it, and a running row must never refuse its own reports.
4. **`updateAuthored` keeps a completion only while the task stays Done and off**; ax's pause clears one too; a Resume leaves the claim alone (decisions row 5).
5. **`completeTask` must throw its refusals inside `receiptTransaction`:** a returned refusal would be stored as the request's receipt (decisions row 6).
6. **The routes read the task first** (`ownTaskOr404`), so a stranger gets 404 and only an owner can see 403 `task-done-not-allowed` (decisions row 11). The reply route reads nothing first because it never answers 403.
7. **`TaskReplyBox` needs a third mode, `'reopen'`,** for an honest helper line on a Done task (decisions row 14). Mark done also shows on a paused task (product call 4, decisions row 16). A Done task without `edit` explains its disabled Reopen (decisions row 17).
8. **`ActiveTaskGroup` must become `Exclude<TaskGroup, 'paused' | 'done'>`** to "stay as it is" once `TaskGroup` gains `'done'` (decisions row 19).
9. **The card's line references drifted** (decisions row 1): `missesAfterRun`'s null rule is `packages/routines/src/store.ts:373`, the auto-pause UPDATE `:396-401`, `pausedSpecHash` `:315-318`, `updateAuthored`'s Resume reset `:642`, the refused agent resume `packages/routines/src/tools.ts:154-155`, `replyCheckIn` `packages/routines/src/services.ts:159-184`.
10. **Stale prose** the card didn't list is fixed in the task that touches each file (decisions row 23).

## Global Constraints

- Base on origin/main be148ac53 or later. Routines schema **version 13** (TASK-952 took 10, TASK-948 took 11, and TASK-951, merged first, took 12; this plan was written for 12). TASK-949 and TASK-951 build in parallel and also touch the report schemas, `recordReport`, `StoredRoutineSchema.task`, `TOOL_FIELDS`, the report-key pins, `migrations.ts`, and (949) `TaskSteps.tsx`/`TaskPage.tsx`. Whichever merges second rebases, takes the next free version everywhere (`migrations.ts`, every `versions()` list in `migrations.test.ts`, comments, the design doc), unions the key pins, and re-runs the routines, routines-admin-routes and channel-web suites.
- Copy is exact and asserted verbatim. Apostrophes in person-facing and model-facing copy are U+2019 (’), the separator is U+00B7 (·), and the tool descriptions' quotes stay straight (`"needs-you"`), as they are today.
- No test in this card needs an invisible character: test the reply rule with blank and over-length text only. If you still write a `\u` escape anywhere, run the code-point scan from the TASK-948 plan's Global Constraints on that file and re-escape what it finds (memory `mistakes/2026-10-24-TASK-948.md`: the Write/Edit tools turned such escapes into raw characters four times).
- One file: `pnpm --filter @ax/<pkg> exec vitest run <path>`. Never `test -- <file>`, never a filter after the script name (memory `mistakes/2026-10-20-TASK-904.md`). Check the file count in the summary.
- Postgres-backed suites (`@ax/routines`, `@ax/routines-admin-routes`) need Docker. Check it with `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock timeout 15 docker info`. If it hangs, don't restart OrbStack: run `@ax/routines` on the local-pg shim, `pnpm --filter @ax/routines exec vitest run --config /private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/386b12a8-02d6-45fd-a50d-1e78eb04cac6/scratchpad/TASK-950/pg/vitest.routines.mjs [<path>]`, after `/opt/homebrew/opt/postgresql@17/bin/pg_isready -h 127.0.0.1 -p 55439` answers. For `@ax/routines-admin-routes`, copy that config to a sibling file with its `root` pointed at `packages/routines-admin-routes`. Tests that count `pg_locks` or wait on locks run with `--no-file-parallelism` on the shim. It is Postgres 17, not 16: CI's run is then the gate, so name every suite that ran only on the shim in the handoff (memory `patterns/2026-10-23-TASK-930.md`, `patterns/2026-10-23-TASK-932.md`).
- channel-web type-checks its test files; `@ax/routines` and `@ax/routines-contract` don't. A type change those packages make that a channel-web fixture doesn't follow fails `pnpm build`: run `pnpm --filter @ax/channel-web exec tsc --build` and fix every fixture it names. For the routines packages the failing tests are the only finder.
- `vi.mock('@/lib/workspace-api', …)` blocks list `workspaceApi`'s methods by hand. A test that drives Mark done, Not yet or Reopen adds `completeTask: vi.fn()` / `reopenTask: vi.fn()` to its mock.
- channel-web `src/lib/*.ts` modules import siblings as relative `./x.js`, never `@/lib/...` (memory `patterns/2026-10-20-TASK-906.md`).
- A task's test file carries only the names that task's tests use: `@typescript-eslint/no-unused-vars` is an error in tests too (memory `mistakes/2026-10-24-TASK-948.md`). When a later task extends a test file, it adds the helpers it needs.
- UI uses installed shadcn primitives and semantic tokens only. `ToggleGroup` is installed (`packages/channel-web/src/components/ui/toggle-group.tsx`) and wrapped by the house radiogroup `Segmented` (`packages/channel-web/src/components/workspace/WorkspaceHeader.tsx`), which Today already uses; `Alert`, `Button`, `Card`, `Collapsible`, `Field`, `Textarea` are installed. No `shadcn add`. Invoke the `shadcn` and `ux-design` skills in Tasks 7-10.
- Run the tasks one at a time in this worktree: channel-web's `tsc --build` compiles routines and the contract, so two builds at once collide.
- Memory rows go to shards under `.claude/memory/<kind>/2026-10-24-TASK-950.md`, never a root archive. Commit this plan and its decisions shard first, so `pnpm test:scripts` (which checks every path a shard cites) passes at any point.
- Final gate: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

## Review Focus

1. **A check-in still running when the person presses Mark done reports afterwards.** Expected: its report is refused (`'done'`), it counts no miss, and the task stays Done with its last update. → Task 2, "a report waiting on the row lock while the task is marked done is refused" and "a Done task's late check-in neither counts a miss nor clears one".
2. **Mark done's answer is lost, the person reopens the task, and the browser retries the first press.** Expected: the retry answers done and finishes nothing (the receipt). → Task 3, "a second Mark done writes nothing, and a retry after a Reopen replays without finishing it again".
3. **A Done task is switched back on in Settings.** Expected: it is no longer Done, it checks in, and its reports land. → Task 2, "a person's Resume of a Done task clears its completion and runs it".
4. **A check-in that started before a Not yet claims done again.** Expected (accepted, decisions row 8): the task reads claimed until the next report, and the check-in the Not yet started replaces it whatever order they finish in. → Task 3, "a claim from a check-in accepted before the Not yet lands, and the one the Not yet started replaces it".
5. **Older code ran during a rollback: it resumed a Done task, reported over a claim, or moved an owner.** Expected: after rolling forward the task runs and reads unclaimed, a later pause doesn't bring Done back, and a moved task reads as a plain pause. → Task 2, "a claim shows only beside the report it came with", "Done needs the task off, its completer its owner, and a get-done kind", "a pause clears a completion left on a running task".

## Hook surface and boundary review

New: `routines:complete`, `routines:reopen`. Changed: `routines:report` (input gains `done`); `routines:list`, `routines:get`, `routines:create`, `routines:update` (the view gains `done`, the task view `doneClaimed`); the tools `routine_report` (input `done`), `routine_list`, `routine_get`, `routine_update` (answers carry `done` and `task.doneClaimed`). For the PR description:

- **Alternate impl:** an external tracker's "resolve" and "reopen" on an issue (Linear, Asana) behind the same two services, or a SQLite store with the same three columns.
- **Payload names that might leak:** none. `done`, `doneClaimed`, `at`, `text`, `requestId`, `checkIn` are domain or house words. `task_done_claimed_at` and `task_completed_by_user_id` stay below the hook: the view sends only `at`.
- **Subscriber risk:** none, they are services. `checkIn: 'started'` means accepted, not finished, as for replies.
- **Wire surface:** neither hook is a tool or an IPC action. The schemas live in `@ax/routines-contract`; the HTTP routes are channel-web's.

## Security checklist (Task 10 runs the skill over the whole diff)

Flagged tasks: 1 (model-written input), 2 and 3 (writes under locks, receipts), 4 (who may finish or reopen, the tool gate), 5 (prompt text), 6 (new HTTP routes, the 404/403 order). The PR's `## Security review` block, to finish in Task 10:

```
## Security review
- Sandbox: N/A: no filesystem path, process, network, env or handle is added or widened. routines:complete and routines:reopen are services, never tools or IPC actions, so no agent can reach them; the agent's resume of a disabled task stays refused (packages/routines/src/tools.ts, routine_update with enabled: true), so it can't undo Done either.
- Injection: a claim is model output (one boolean) that moves a task to Needs you. It changes no state beyond the claim, a later report withdraws it, the person decides, and the page and Today show it beside the update it came with. The check-in message's claim line is fixed host text. Not yet's and Reopen's text is the person's reply: owner-only, screened by RoutineReplyTextSchema before it is stored, quoted as the person's words in the next check-in, never in the brief. A report on a Done task is refused, so a check-in still running can't write onto a finished task. Receipts hold { done: true } only; log lines carry ids and closed words.
- Authorization: Mark done and Reopen of a Done task need edit (agents:can-manage-routines, the task's owner), decided under the routine's row lock; Not yet on a running task needs ownership, like a reply. The routes read the task as the caller first, so a stranger gets the read's 404 and never a 403.
- Supply chain: N/A: no package.json or lockfile change, and no new shadcn component.
```

## Rollback

Version 13 is additive and nullable (decisions row 22). Older code ignores the three columns: a Done task reads there as a paused task (the tick doesn't claim it, Check now is refused, its agent's reads work). A person may resume it in Settings; the completion stays, but after rolling forward the task runs (`doneOf` needs it off) and its next pause on version-12 code, a person's or ax's, clears it (a pause by older code leaves it, so a Done task older code resumed and paused again reads as Done after rolling forward: an accepted window). A report or owner move by older code leaves the claim stamp behind a newer report, so the claim lapses; an owner move leaves a completion whose completer isn't the new owner, so it reads as a plain pause. Older code never looks up a `'complete'` receipt. Nothing from Agent Tasks PR 1-3 is deployed.

## Tiers and order

| Task | Tier | Needs | security-checklist |
|---|---|---|---|
| 1 Contract: report `done`, complete/reopen I/O, tool words | sensitive | — | flagged |
| 2 Store: version 13, the claim, Done in reports, misses and edits | sensitive | 1 | flagged |
| 3 Store: Mark done and Reopen | sensitive | 2 | flagged |
| 4 Services, tools and views | sensitive | 3 | flagged |
| 5 Check-in message, brief, canary | sensitive | 4 | flagged |
| 6 channel-web server routes and client API | sensitive | 4 | flagged |
| 7 Reply box modes and Mark done's press | integration | 6 | — |
| 8 Tasks page: Done group and filter | integration | 6 | — |
| 9 Task page: claim, Mark done, Not yet, Done, Reopen | integration | 7, 8 | — |
| 10 Today: the claimed block; the security review | integration | 7, 8 | runs the skill over the diff |
| 11 Docs: the design doc as built | mechanical | all | — |

Run them in this order, one at a time.

---

### Task 1: Contract: the report's `done`, the complete and reopen services' input and answer, and the tools' words [tier: sensitive]

**Files:**
- Modify: `packages/routines-contract/src/definition.ts`: `RoutineReportFieldShape` (:530-536) gains `done`; a new exported `refuseDoneWithoutNeedsYou` right after it, with a doc block.
- Modify: `packages/routines-contract/src/tools.ts`: `RoutineReportToolInputSchema` (:45-51) and its comment (:38-44); the `routine_report` JSON schema's properties; `RoutineToolDescriptions` (`routine_list`, `routine_get`, `routine_update`, `routine_report`).
- Modify: `packages/routines-contract/src/services.ts`: `RoutineReportInputSchema` (:58-64) and its doc; new schemas and types after `RoutineReplyOutputSchema` (:113).
- Modify: `packages/core/src/safe-tool-error.ts`: `TOOL_FIELDS` (:21-22) gains `'done'`; the comment reads "(TASK-948: steps; TASK-950: done)".
- Create: `packages/routines-contract/src/__tests__/done.test.ts`.
- Modify tests: `packages/routines-contract/src/__tests__/report.test.ts` ("names no target" :79-86, "shares one field shape" :88-95), `packages/routines-contract/src/__tests__/definition.test.ts` (the parity test :238-247), `packages/core/src/__tests__/safe-tool-error.test.ts`.

**Interfaces:**
- Produces (all exported from `@ax/routines-contract`):
  ```ts
  RoutineReportFieldShape.done: z.ZodBoolean;
  /** TASK-950. A claim that a task is done comes with status "needs-you": issue at path ['done']. */
  export function refuseDoneWithoutNeedsYou(report: { status: RoutineReportStatus; done?: boolean | undefined }, ctx: z.RefinementCtx): void;
  export const RoutineCompleteInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema }).strict();
  export const RoutineCompleteOutputSchema = z.object({ done: z.literal(true) }).strict();
  export const RoutineReopenInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema, text: RoutineReplyTextSchema }).strict();
  export const RoutineReopenOutputSchema = RoutineReplyOutputSchema;
  export type RoutineCompleteInput / RoutineCompleteOutput / RoutineReopenInput / RoutineReopenOutput; // z.output<…>
  ```
  `RoutineReportToolInputSchema` and `RoutineReportInputSchema` each gain `done: RoutineReportFieldShape.done.optional()` (after `reading`, before `steps`) and end in `.superRefine(refuseDoneWithoutNeedsYou)`, so both are `ZodEffects` now. `SafeToolField` gains `'done'`.
- Not here: the view fields `done` and `doneClaimed` (Task 4 adds them with their producer, so every task leaves the suites green; decisions row 12).

- [ ] **Step 1: Write the failing tests.**
  - `done.test.ts`, `describe('a report’s done (TASK-950)')`. `const report = { status: 'needs-you', update: 'Every article is on the new site.' } as const; const binding = { agentId: 'a', dispatchId: 'd', ask: null };`
    - `it('takes done true with needs-you, on the tool and on the service, and reads it absent as no claim')`: `RoutineReportToolInputSchema.parse({ ...report, done: true }).done` is `true`; `RoutineReportInputSchema.parse({ ...report, ...binding, done: true }).done` is `true`; `'done' in RoutineReportToolInputSchema.parse(report)` is `false` (and the same for the service); `{ ...report, status: 'on-track', done: false }` parses on both.
    - `it.each(['on-track', 'off-track'])('refuses done true with %s, naming done, in words that say what to send')`: on both schemas, `safeParse({ ...input, status, done: true })` fails with `issues.map(i => [i.path, i.message])` equal to `[[['done'], 'When you think the task is done, send status "needs-you" with done true.']]`.
    - `it('refuses a done that isn’t true or false')`: `'true'`, `1` and `null` fail on both.
    - `it('the complete and reopen inputs are strict, and reopen’s text is a reply')`: `RoutineCompleteInputSchema.parse({ agentId: 'a', routineId: 'r', requestId: 'q' })` round-trips; adding `{ actorUserId: 'u' }`, `{ text: 'x' }` or `{ untrustedField: 1 }` fails. `RoutineReopenInputSchema.parse({ agentId: 'a', routineId: 'r', requestId: 'q', text: 'Also redirect the old links.' })` round-trips; `text: '   '` fails with the message `'Write a reply first.'`, `text: 'x'.repeat(2001)` with `'A reply can be up to 2,000 characters.'`; a missing `text` fails.
    - `it('answers done true, and reopen answers as a reply does')`: `RoutineCompleteOutputSchema` takes `{ done: true }` and refuses `{ done: false }`, `{}` and `{ done: true, at: 'x' }`; `RoutineReopenOutputSchema` is `RoutineReplyOutputSchema` (`toBe`).
    - `it('offers the model done as an optional boolean')`: `RoutineToolJsonSchemas.routine_report.properties.done` matches `{ type: 'boolean' }`, and `required` is still `['status', 'update']`.
    - `it('the tools say what done means and who marks a task done')`: `toContain` each new sentence of Step 3's descriptions (one per tool).
  - `report.test.ts`: "names no target" reads `RoutineReportToolInputSchema.innerType().shape` and its keys are `['ask', 'done', 'notes', 'reading', 'status', 'steps', 'update']`. "shares one field shape": keys `['ask', 'done', 'notes', 'reading', 'status', 'update']`, and `RoutineReportFieldShape.done.safeParse(null).success` is `false` (not nullable, unlike `ask`, `notes`, `reading`).
  - `definition.test.ts`, the parity test: add `import { z } from 'zod';` and read each runtime schema through `const objectOf = (schema: z.ZodTypeAny) => (schema instanceof z.ZodEffects ? schema.innerType() : schema) as z.AnyZodObject;` before `.shape`.
  - `safe-tool-error.test.ts`: `it('names a report’s done (TASK-950)')`: `new SafeToolError('validation', 'done')` has `field: 'done'` and the message `'Routine input is invalid. Check the indicated field. Field: done'`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @ax/routines-contract test` and `pnpm --filter @ax/core exec vitest run src/__tests__/safe-tool-error.test.ts`
Expected: FAIL. `done` isn't a field, the new schemas don't exist, and `done` names `input`.

- [ ] **Step 3: Implement.**
  - `refuseDoneWithoutNeedsYou`: when `report.done === true && report.status !== 'needs-you'`, add one custom issue at `path: ['done']` with exactly the Step 1 words. Doc: the claim is part of the report, and every reader (Tasks groups, Today, the badge) keys on the status, so a claim must come with "needs-you"; the message never reaches the agent (core's fixed template names the field only), it is for the contract's own callers and tests.
  - `RoutineReportFieldShape.done: z.boolean()`, with a line in the shape's doc: optional on both inputs; left out or false is no claim.
  - Rewrite the tool schema's comment (:38-44): it names no task, run or conversation; it is a strict object refined by `refuseDoneWithoutNeedsYou`, so it is a `ZodEffects` and the parity test reads the object through `innerType()`; `steps` (TASK-948) and `done` (TASK-950) are for a "get-done" task.
  - `RoutineReportInputSchema`'s doc gains: "`done` (TASK-950): true says the agent thinks a "get-done" task is finished; it must come with "needs-you". Left out or false is no claim, and a later report without it takes the claim back."
  - Doc blocks for the new schemas, in the style of the reply ones:
    - `routines:complete` (TASK-950): a person marks a "get-done" task done. Only its owner, who manages the agent's tasks (`edit`), may. It stops checking in the way a pause does and keeps its steps, report and notes. The same `requestId` again answers the same without doing it twice; a task already done answers done with no change. Neither a tool nor an IPC action: only a person marks a task done.
    - `routines:reopen` (TASK-950): Not yet, and Reopen on a Done task. It stores a reply as `routines:reply` does; it clears the agent's claim, and on a Done task it also clears the completion and runs the task again (that needs `edit`); then it starts a check-in as a reply does, and `checkIn` says what happened, with `routines:reply`'s meanings. Neither a tool nor an IPC action.
  - The `routine_report` JSON schema gains `done: { type: 'boolean', description: 'For a "get-done" task only: true when you think the whole task is finished. Send it with status "needs-you". Leave it out otherwise.' }`.
  - `RoutineToolDescriptions`, exact edits:
    - `routine_report`: `"replaces the first’s status, update, ask, notes and reading, and applies"` becomes `"replaces the first’s status, update, ask, notes, reading and done, and applies"`; insert `' done is for a "get-done" task only. Send true, with status "needs-you", when you think the whole task is finished: the person then marks it done or tells you what’s left. Only a person marks a task done. A later report without done takes the claim back.'` right before `' The person can read your report, your notes and your steps.'`.
    - `routine_list` and `routine_get`: `(status, update, ask, reading, reportedAt` becomes `(status, update, ask, reading, doneClaimed, reportedAt`; after `'reading is the one number the agent read at that check-in, with its own label, or null.'` insert `' doneClaimed is true when that report said a "get-done" task is finished and the person hasn’t marked it done yet.'`; append at the end `' A task’s done is { at } once a person marked a "get-done" task finished: it no longer checks in, and only a person can reopen it. It is null otherwise, and for a task another person owns.'`.
    - `routine_update`: `'answers with task and noRecentUpdate null, so read the task with routine_get.'` becomes `'answers with task, noRecentUpdate and done null, so read the task with routine_get.'`.

- [ ] **Step 4: Run and see them pass, then the dependents' builds**

Run: `pnpm --filter @ax/routines-contract test && pnpm --filter @ax/core test && pnpm --filter @ax/routines build && pnpm --filter @ax/channel-web exec tsc --build`
Expected: PASS and clean builds. `@ax/routines` builds unchanged (it reads `done` nowhere yet); `prepare`'s first parse already applies the rule.

- [ ] **Step 5: Commit**

```bash
git add packages/routines-contract packages/core/src/safe-tool-error.ts packages/core/src/__tests__/safe-tool-error.test.ts
git commit -m "[TASK-950] routines-contract: a report can say the task is done, and two services finish or reopen it"
```

---

### Task 2: Store: schema version 13, the claim, and what Done means to a report, a miss and an edit [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/migrations.ts`: three fields on `RoutinesDefinitionsRow` after `task_steps` (:103); `if (!await done(13))` after version 12; a new `addDoneColumns` above `addGetDoneSteps` (:299).
- Modify: `packages/routines/src/types.ts`: `StoredTaskState` (:17), new `StoredDone`, `StoredRoutine.done` (:28-50), `ReportRefusal` and its doc (:110-114), `RecordReportInput` and its doc (:115-127).
- Modify: `packages/routines/src/definition.ts`: `StoredRoutineSchema` (:52-82).
- Modify: `packages/routines/src/store.ts`: the `recordReport` interface doc (:49-61); `taskState` (:241-250); `NO_MISSES`/`NO_TASK_STATE` (:301-308) and the doc above them; a new `NO_COMPLETION` and `doneOf`; `missesAfterRun` (:367-404) and its doc; `rowToRoutine` (:437-446); `withoutTaskState` (:514) and `receiptCopy`'s doc (:490-505); `updateAuthored` (:627-648); `recordReport` (:821-881).
- Create: `packages/routines/src/__tests__/done-store.test.ts`.
- Modify tests: `packages/routines/src/__tests__/migrations.test.ts`.
- Fixtures forced by the types (`done: null` on a `StoredRoutine` literal, `doneClaimed: false` on a `StoredTaskState` literal): in routines (no compiler finds these) `return-schemas.test.ts` `row`, `brief.test.ts` `storedRow`, `fire.test.ts` `sampleRow`, `next-check.test.ts`, and any other literal a failing test names; in channel-web (`tsc --build` names them) `stored()` and `report()` in `src/__tests__/server/routes-workspace-{checkin,task,tasks}.test.ts` and `row` in `src/__tests__/routine-manager-producer.test.tsx`.

**Interfaces:**
- Consumes: `RecordReportInput.done` comes from Task 4's service; nothing from Task 1 at runtime.
- Produces:
  ```ts
  // types.ts
  /** TASK-950. A get-done task a person marked done: when, and who (always its owner, `doneOf`). */
  export type StoredDone = { at: Date; byUserId: string };
  StoredTaskState.doneClaimed: boolean;   // the claim, read beside its own report (taskState)
  StoredRoutine.done: StoredDone | null;  // doneOf(row)
  ReportRefusal = 'agent-retired' | 'run-closed' | 'not-bound' | 'routine-gone' | 'kind' | 'owner' | 'done';
  RecordReportInput.done?: boolean;       // true: the report claims the task is done; written for get-done only
  // migrations.ts, RoutinesDefinitionsRow
  task_done_claimed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  task_completed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  task_completed_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  // store.ts (module-private; Task 3 uses both)
  const NO_COMPLETION = { task_completed_at: null, task_completed_by_user_id: null } as const;
  function doneOf(row: Pick<Selectable<RoutinesDefinitionsRow>, 'kind' | 'enabled' | 'owner_user_id' | 'task_completed_at' | 'task_completed_by_user_id'>): StoredDone | null;
  ```
  `NO_TASK_STATE` gains `task_done_claimed_at: null` and `...NO_COMPLETION`, so a kind change (`updateAuthored`) and an owner change (`reconcileOwners`, which writes every `NO_TASK_STATE` key) clear all three with no code of their own.

The rules (decisions rows 3, 4, 5, 9):
```ts
// doneOf: the one reading of Done.
return row.kind === 'get-done' && !row.enabled && row.task_completed_at !== null
  && row.task_completed_by_user_id !== null && row.task_completed_by_user_id === row.owner_user_id
  ? { at: row.task_completed_at, byUserId: row.task_completed_by_user_id } : null;
// taskState: the claim counts only beside the report that made it.
doneClaimed: row.task_done_claimed_at !== null && row.task_done_claimed_at.getTime() === row.task_reported_at.getTime(),
```
- `recordReport`: select `enabled`, `task_completed_at` and `task_completed_by_user_id` with the existing columns; after the `owner` refusal, `if (doneOf(definition) !== null) return 'done';` (nothing written); the guarded state UPDATE gains `task_done_claimed_at: definition.kind === 'get-done' && input.done === true ? input.now : null`, beside `task_reported_at: input.now`. The dispatch's report JSON stays `{ status, update, ask }` (TASK-952 handoff: a new key there would drop the report after a rollback).
- `missesAfterRun`: the null rule becomes `row.kind === 'repeat' || (row.task_auto_paused_at !== null && !row.enabled) || doneOf(row) !== null`; the auto-pause columns gain `...NO_COMPLETION`.
- `updateAuthored`: add `...(current.done !== null && !next.enabled ? {} : NO_COMPLETION)` to the UPDATE, beside the existing Resume reset (which stays `NO_MISSES` only). The claim is not touched here.
- `rowToRoutine` passes `done: doneOf(row)`; `StoredRoutineSchema` gains `done: z.object({ at: z.coerce.date(), byUserId: z.string() }).strict().nullable().default(null)` and its `task` object gains `doneClaimed: z.boolean().default(false)`, both commented in the `task` field's style (types only; receipts leave the key out and the default fills it).
- `withoutTaskState` strips `done` too (`Omit<StoredRoutine, 'task' | 'noRecentUpdate' | 'steps' | 'done'>`).

- [ ] **Step 1: Write the failing tests.** `done-store.test.ts`, one `describe("a task's claim and Done, as the store keeps them (TASK-950)")`, over `fixture()`. Helpers, defined only as far as this task's tests use them: `GET_DONE` and `STAY` definitions (1h interval), `taskInput(requestId, definition = GET_DONE)`, `minute(n)`, `bound(key, requestId, at)` and `record(run, report, over?)` as in `steps-store.test.ts`, `markDoneByHand(routineId, by = 'owner')` (one UPDATE setting `enabled = false`, `task_completed_at`, `task_completed_by_user_id`), `columns(routineId)` (selects `enabled`, `task_done_claimed_at`, `task_completed_at`, `task_completed_by_user_id`, `task_reported_at`, `task_misses_in_a_row`), and for the lock test `openTransaction`, `lockRow` and `waitingOnRoutineRow`, copied from `reply-store.test.ts`. `const needsYouDone = { status: 'needs-you', update: 'Every article is on the new site.', ask: null } as const`.
  - `it('a report with done claims the task, and the next report without it takes the claim back')`: run 1 records `needsYouDone` with `{ done: true }` → `(await findOne(task)).task` matches `{ status: 'needs-you', doneClaimed: true }` and the stamp equals `task_reported_at`; run 2 (accepted later) records `{ status: 'on-track', update: 'Found two more articles.', ask: null }` → `doneClaimed: false` and the stamp is null.
  - `it('an older check-in’s claim doesn’t replace a newer report')`: older accepted at `minute(1)`, newer at `minute(2)`; newer records on-track; older records `needsYouDone` with done → status `'on-track'`, `doneClaimed: false`.
  - `it('a claim on a check-in of any other kind records the report and no claim')`: a stay-on-top task; `recordReport` with `done: true` → `'recorded'`, status `'needs-you'`, `doneClaimed: false`, stamp null.
  - `it('a claim shows only beside the report it came with')`: claim; then a hand UPDATE moving `task_reported_at` one minute later (what a report from code before version 13 does) → `doneClaimed: false`.
  - `it('a report on a Done task is refused as done and writes nothing')`: claim with run 1; open run 2; `markDoneByHand`; run 2 records → `'done'`; run 2's dispatch `report` is still null; the task's status, update and `task_reported_at` are run 1's.
  - `it('a report waiting on the row lock while the task is marked done is refused')`:
    ```ts
    const held = await openTransaction(trx => lockRow(trx, task), trx => sql`UPDATE routines_v1_definitions SET enabled = false, task_completed_at = ${minute(40)}, task_completed_by_user_id = 'owner' WHERE routine_id = ${task.routineId}`.execute(trx));
    const waiting = record(run, needsYouDone, { done: true });
    await expect.poll(waitingOnRoutineRow).toBeGreaterThan(0);
    held.release(); await held.done;
    expect(await waiting).toBe('done');
    ```
  - `it('a Done task’s late check-in neither counts a miss nor clears one')`: (a) an open run, `markDoneByHand`, `finishDispatch` with `{ status: 'error', … miss: 'failed' }` → misses still 0, still disabled, revision unchanged, no auto-pause line on stderr; (b) an open run that recorded its report before the task was marked done, misses seeded to 2 by hand, then finishes → misses still 2.
  - `it('Done needs the task off, its completer its owner, and a get-done kind')`: with the completion columns set to the owner, an enabled row reads `done: null` and a report on it is `'recorded'`; a disabled row completed by `'someone-else'` reads `done: null`; one with a time and a null user reads `done: null`; a disabled get-done row completed by `'owner'` reads `done: { at, byUserId: 'owner' }`; the same columns on a stay-on-top row read `done: null`.
  - `it('a person’s Resume of a Done task clears its completion and runs it; an edit that keeps it off keeps it Done')`: `markDoneByHand`; an `updateAuthored` of `{ description: 'Moving the docs.' }` keeps `done` and `enabled: false`; one of `{ enabled: true }` gives `done: null`, both completion columns null, `enabled: true` and a `nextRunAt`; a new run's report is `'recorded'`.
  - `it('a pause clears a completion left on a running task, a person’s or ax’s')`: (a) completion columns by hand on an enabled row, then `updateAuthored({ enabled: false })` → columns null, `done: null`; (b) completion columns by hand on an enabled row with `task_misses_in_a_row = 4`, then a fifth run finishes without a report → auto-paused, columns null, `done: null` (capture the auto-pause stderr line as the TASK-930 tests do).
  - `it('a change of kind or of owner clears the claim and the completion, and leaves the task off')`: claim plus `markDoneByHand`; a kind change to stay-on-top (with `goodWhen`, as the existing kind-change tests send it) → all three columns null, `enabled: false`; on a second task, `reconcileOwners({ agents: [{ agentId: 'a', ownerUserId: 'new-owner' }] })` → the same.
  - `it('receipts keep no done, and a replay answers done null')`: `markDoneByHand`; an `updateAuthored` rename; its receipt JSON has no `done` key (`result ? 'done'` is false); the exact replay answers `done: null`; `StoredRoutineSchema.innerType().omit({ done: true })` parses the receipt (code from before this field still reads it).
  - `migrations.test.ts`: every `[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]` becomes `[…, 12, 13]` (afterwards `grep -n "9, 10, 11\]" packages/routines/src/__tests__/migrations.test.ts` finds none), and after the version-12 test: `it('version 13 adds a task’s claim and completion, nullable and empty; a re-run keeps them (TASK-950)')`: run the migration; drop the three columns and delete version 12's row; `insertTask()`; run it twice; `versions()` ends at 12; `information_schema.columns` gives `task_done_claimed_at` and `task_completed_at` as `timestamp with time zone`, `task_completed_by_user_id` as `text`, all `is_nullable: 'YES'` and `column_default: null`; the existing row's three are null; set values, delete version 12's row, run again → the values stay.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/done-store.test.ts src/__tests__/migrations.test.ts`
Expected: FAIL. The columns don't exist and `recordReport` takes no `done`.

- [ ] **Step 3: Implement** the Interfaces and rules above. `addDoneColumns(db)` is three `ALTER TABLE routines_v1_definitions ADD COLUMN IF NOT EXISTS …` statements (`task_done_claimed_at TIMESTAMPTZ`, `task_completed_at TIMESTAMPTZ`, `task_completed_by_user_id TEXT`), no foreign key (memory: a new FK breaks other packages' teardown) and no backfill. Its doc: version 13 is a "get-done" task's claim and completion; the claim is the time of the report that made it, so a report or owner move by older code withdraws it; Done is read through `doneOf`; additive, and a re-run keeps every value; the Rollback section's hazards. Each row field's doc says who writes it: `task_done_claimed_at` by `recordReport` beside the report, cleared by `completeTask`, `reopenTask` and `NO_TASK_STATE`; the completion by `completeTask`, cleared by `reopenTask`, `updateAuthored`, ax's pause and `NO_TASK_STATE`. Update the prose this changes: the `recordReport` interface doc (the claim, the `'done'` refusal), `missesAfterRun`'s doc ("and while the task is Done"), the `NO_TASK_STATE` doc (a TASK-950 paragraph), `receiptCopy`'s doc, and `ReportRefusal`'s doc (`'done'`: a person marked the task done). Add the fixtures' `done: null` and `doneClaimed: false` (Files).

- [ ] **Step 4: Run and see them pass, then the package and channel-web's typecheck**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/done-store.test.ts src/__tests__/migrations.test.ts && pnpm --filter @ax/routines test && pnpm --filter @ax/routines build && pnpm --filter @ax/channel-web exec tsc --build`
Expected: PASS and clean. The existing report, misses, steps, owner-change and receipt tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src packages/channel-web/src/__tests__/server packages/channel-web/src/__tests__/routine-manager-producer.test.tsx
git commit -m "[TASK-950] routines: schema version 13 keeps a task's claim and completion"
```

---

### Task 3: Store: Mark done and Reopen [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/definition.ts`: `completeRequestHash` beside `deleteRequestHash` (:94-96).
- Modify: `packages/routines/src/types.ts`: `ReopenTaskResult` beside `AddReplyResult` (:95).
- Modify: `packages/routines/src/store.ts`: the `RoutinesStore` interface (two methods with docs right after `addReply`, :80); `parseReceipt` (:484-489); the two implementations after `addReply` (:906-929).
- Modify tests: `packages/routines/src/__tests__/done-store.test.ts` (two describes).

**Interfaces:**
- Consumes: `doneOf`, `NO_COMPLETION`, `pausedSpecHash`, `NO_MISSES`, `receiptTransaction`, `operationKey`, `lockLiveAgent`, `rowToRoutine` (store.ts); `RoutineCompleteOutputSchema` (Task 1).
- Produces:
  ```ts
  // definition.ts
  export function completeRequestHash(input: RoutineKey): string; // inputHash({ agentId, routineId })
  // types.ts
  export type ReopenTaskResult = { outcome: 'added' | 'replayed'; replyId: string; row: StoredRoutine; wasDone: boolean } | 'not-found' | 'forbidden';
  // store.ts, RoutinesStore
  completeTask(input: RoutineKey & { actorUserId: string; requestId: string; mayEdit: boolean; now: Date }): Promise<{ done: true }>;
  reopenTask(input: RoutineKey & { actorUserId: string; requestId: string; text: string; mayEdit: boolean; now: Date }): Promise<ReopenTaskResult>;
  ```

The rules (decisions rows 6, 7):
- `completeTask` runs in `receiptTransaction(db, operationKey(input, 'complete', completeRequestHash(input)), effect)`. The effect reads the row `FOR UPDATE`; missing or `kind !== 'get-done'` throws `new SafeToolError('not-found', 'routineId')`; `owner_user_id !== actorUserId || !mayEdit` throws `new SafeToolError('forbidden', 'input')`; `doneOf(raw) !== null` returns `{ done: true }` with no write; otherwise one UPDATE: `{ enabled: false, revision: opaqueId('rev'), spec_hash: pausedSpecHash(raw).hash, next_run_at: null, updated_at: now, task_done_claimed_at: null, task_completed_at: now, task_completed_by_user_id: actorUserId, ...NO_MISSES }`, then `{ done: true }`. Steps, report and notes stay. `parseReceipt` gains `if (operation === 'complete') return RoutineCompleteOutputSchema.parse(value);`. Its doc: why it throws rather than returns (a returned refusal would become the receipt), and that a retry answers from the receipt even after a Reopen.
- `reopenTask`, one `db.transaction()`: `lockLiveAgent` (false → `'not-found'`); the row `FOR UPDATE`; missing or `kind !== 'get-done'` → `'not-found'`; another owner → `'forbidden'`; `const done = doneOf(raw) !== null`; `done && !mayEdit` → `'forbidden'`; then `addReply`'s insert, `ON CONFLICT (agent_id, routine_id, author_user_id, request_id) DO NOTHING … RETURNING reply_id`. A replay reads the first reply's id and answers `{ outcome: 'replayed', replyId, row: rowToRoutine(raw), wasDone: done }` with no other write. A new reply on a Done task UPDATEs `{ ...NO_COMPLETION, task_done_claimed_at: null, enabled: true, revision: opaqueId('rev'), spec_hash: inputHash({ ...editableDefinition(rowToRoutine(raw)), enabled: true }), next_run_at: nextRun({ ...editableDefinition(rowToRoutine(raw)), enabled: true }, now), updated_at: now, ...NO_MISSES } … RETURNING *`; a new reply on a task whose `task_done_claimed_at` is set UPDATEs `{ task_done_claimed_at: null }` only; otherwise no UPDATE. It answers `{ outcome: 'added', replyId, row, wasDone: done }` with the row as it now is. Its doc says the lock order is `addReply`'s, and why only a new reply clears the claim.

- [ ] **Step 1: Write the failing tests.** Add to `done-store.test.ts` (extend the helpers as needed: `complete(key, requestId, over?)`, `reopen(key, requestId, text, over?)`, both defaulting `actorUserId: 'owner'`, `mayEdit: true`, `now`; `completeReceipts()` counting `operation = 'complete'` rows).
  - `describe('Mark done (store, TASK-950)')`:
    - `it('marks a get-done task done the way a pause does, and keeps its steps, report and notes')`: steps written by hand, a claim recorded with `notes: 'Redirects are next.'`, misses seeded to 2 by hand; `complete` → `{ done: true }`; the row is `enabled: false`, a new revision, `nextRunAt: null`, `noRecentUpdate: null`, `task` with `doneClaimed: false` and the claim's status, update and `agentNotes`, the same `steps`, `done: { at: now, byUserId: 'owner' }`; its `spec_hash` equals `inputHash({ ...editableDefinition(before), enabled: false })`; `f.store.claimDue({ now: new Date(now.getTime() + 365 * 86_400_000), limit: 10, claimWindowMinutes: 5 })` returns no row with its `routineId`.
    - `it('a second Mark done writes nothing, and a retry after a Reopen replays without finishing it again')`: `complete(task, 'A')` → revision R1; `complete(task, 'B')` → `{ done: true }` and the revision is still R1; `reopen(task, 'C', 'Not yet.')` → running; `complete(task, 'A')` again → `{ done: true }`, and the task is still running at the Reopen's revision with `done: null`.
    - `it('refuses a task it can’t finish, and keeps no receipt')`: each of a stay-on-top task, a missing routine id and a retired agent (insert into `routines_v1_retired_agents`) rejects with `{ toolCode: 'not-found' }`; `actorUserId: 'editor'` and `mayEdit: false` reject with `{ toolCode: 'forbidden' }`; after each, `completeReceipts()` is 0 and the row is unchanged.
  - `describe('Not yet and Reopen (store, TASK-950)')`:
    - `it('Not yet on a claimed task stores the reply and takes the claim back; the task keeps running')`: claim; `reopen(task, 'N', 'Also redirect the old links.')` → `{ outcome: 'added', replyId: stringMatching(/^reply_/), row: objectContaining({ enabled: true, revision: <unchanged> }), wasDone: false }`; `doneClaimed: false`; `recentReplies` holds the text.
    - `it('Reopen on a Done task stores the reply and runs the task again')`: `complete`; `reopen` → `wasDone: true`, `row.enabled: true`, a revision unlike the Done one, `row.nextRunAt` equal to `now + 1h`, `done: null`, completion columns null, misses 0, `spec_hash` equal to `inputHash({ ...editableDefinition(row), enabled: true })`.
    - `it('Reopen on a Done task needs edit, and stores nothing without it')`: `mayEdit: false` → `'forbidden'`; no reply stored; still Done.
    - `it('a retry after the agent claimed again keeps the new claim (seeded interleaving)')`:
      ```ts
      const first = await bound(task, 'run-1', minute(1));
      await record(first, needsYouDone, { done: true });
      const notYet = await reopen(task, 'not-yet', 'Also redirect the old links.');   // clears the claim
      const second = await bound(task, 'run-2', minute(2));
      await record(second, needsYouDone, { done: true });                          // claims again
      expect(await reopen(task, 'not-yet', 'Also redirect the old links.')).toEqual({
        outcome: 'replayed', replyId: (notYet as { replyId: string }).replyId, row: expect.anything(), wasDone: false });
      expect((await f.store.findOne(task))?.task?.doneClaimed).toBe(true);
      ```
    - `it('a claim from a check-in accepted before the Not yet lands, and the one the Not yet started replaces it')` (Review Focus 4): run 1 claims; run 2 is accepted at `minute(2)`; Not yet; run 3 is accepted at `minute(3)`; run 2 records with done → claimed; run 3 records on-track without done → not claimed; and with the two reversed (run 3 first, then run 2) the task ends not claimed, run 3's report.
    - `it('a retry of a Reopen after the task was marked done again leaves it done')`: complete; reopen 'R'; complete 'B'; reopen 'R' again → `{ outcome: 'replayed', wasDone: true }`, still Done.
    - `it('a reply on a get-done task neither claimed nor Done writes nothing else')`: `reopen` → `'added'`; `revision` and `updated_at` unchanged.
    - `it('refuses a stay-on-top task, a missing one and a retired agent as not-found, and anyone but the owner as forbidden')`: nothing stored.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/done-store.test.ts`
Expected: FAIL. `completeTask` and `reopenTask` don't exist.

- [ ] **Step 3: Implement** the Interfaces and rules above.

- [ ] **Step 4: Run and see them pass, then the package**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/done-store.test.ts && pnpm --filter @ax/routines test && pnpm --filter @ax/routines build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src/definition.ts packages/routines/src/types.ts packages/routines/src/store.ts packages/routines/src/__tests__/done-store.test.ts
git commit -m "[TASK-950] routines: Mark done pauses a get-done task for good, and Reopen runs it again with a reply"
```

---

### Task 4: Services, tools and views: who sees Done, and who may finish or reopen a task [tier: sensitive]

**Files:**
- Modify: `packages/routines-contract/src/definition.ts`: `RoutineTaskViewSchema` (:670-675) and its doc; a new `RoutineDoneViewSchema` above `RoutineViewShape`; `RoutineViewShape` (:681-699) gains `done`.
- Modify: `packages/routines/src/services.ts`: `ROUTINE_SERVICES` (:11-16); `routineView` (:35-44); `taskView` (:60-64) and its doc; a new `doneView`; the `report` service (:291-307) and its comment; `replyCheckIn`'s doc (:145-158); two registrations after `reply` (:342-366).
- Modify: `packages/routines/src/tools.ts`: `prepareReport` (:61-91) and its doc.
- Create: `packages/routines/src/__tests__/done.test.ts`.
- Modify tests: `packages/routines/src/__tests__/return-schemas.test.ts`, `report-tool.test.ts`, `report-hook.test.ts`.
- Fixtures forced by the two required view fields (`done: null` on every view literal, `doneClaimed: false` on every task view literal; a list-tool view takes `done` too): `packages/routines-contract/src/__tests__/` (`definition.test.ts`, `report.test.ts`, `misses.test.ts`, `steps.test.ts`), `packages/routines/src/__tests__/` (any literal a failing test names), `packages/routines-admin-routes/src/__tests__/routes.test.ts` (the `routine` view), `packages/channel-web/src/components/routines/__tests__/routine-fixture.ts`, and every literal `pnpm --filter @ax/channel-web exec tsc --build` names.

**Interfaces:**
- Consumes: Task 1's schemas; Task 2's `StoredRoutine.done`, `StoredTaskState.doneClaimed`, `RecordReportInput.done`, `'done'` refusal; Task 3's `completeTask`, `reopenTask`.
- Produces:
  ```ts
  // @ax/routines-contract
  export const RoutineDoneViewSchema = z.object({ at: RoutineInstantSchema }).strict();
  export type RoutineDoneView = z.output<typeof RoutineDoneViewSchema>;
  RoutineTaskView.doneClaimed: boolean;     // required; RoutineTaskListViewSchema keeps it
  RoutineView.done: RoutineDoneView | null; // required, in RoutineViewShape, so the list-tool view has it too
  // services.ts
  ROUTINE_SERVICES // 22: adds 'complete', 'reopen'
  function doneView(row: StoredRoutine, userId: string): C.RoutineDoneView | null;
  ```
  `doneView` is `{ at: row.done.at.toISOString() }` only when `row.done !== null && row.ownerUserId === userId && row.kind === 'get-done'`, never `byUserId`. `taskView` adds `doneClaimed: row.kind === 'get-done' && row.task.doneClaimed`. Doc for `done` on the view: host-written; null for anyone but the task's owner (`task`'s rule), for any kind but get-done, and in an exact replay's answer (receipts keep none); required, so a producer that doesn't know it is refused.

The services (decisions row 10):
- `complete`: `const a = await access(ctx, input.agentId); const row = await rowFor(input); await store.completeTask({ agentId, routineId, actorUserId: ctx.userId, requestId, mayEdit: routinePermissions(row, ctx.userId, a.allowed).edit, now: now() });` then `ctx.logger.info('routines_task_completed', { agentId, routineId })` and `{ done: true as const }`. The store's thrown refusals pass through.
- `reopen`, inside `admitDispatch`: `access`; no `dispatch` → `SafeToolError('unavailable', 'input')`; `rowFor`; `store.reopenTask({ …, text, mayEdit: routinePermissions(row, ctx.userId, a.allowed).edit, now: now() })`; `'not-found'`/`'forbidden'` → the same `SafeToolError`s `reply` throws; then `replyCheckIn(ctx, a.allowed, outcome.row, outcome.replyId, send)` inside the same try/catch as `reply` (its `routines_reply_check_in_failed` warn on a throw); then `ctx.logger.info('routines_task_reopened', { agentId, routineId, wasDone: outcome.wasDone, checkIn })` and `{ replyId: outcome.replyId, checkIn }`.
- `report`: destructure `done` beside `notes`, `reading`, `steps`, and pass `...(done === true ? { done: true } : {})` to `recordReport`. A `'done'` refusal goes through `reportRefused` like the others.
- `prepareReport`: destructure `done` with `notes` and `steps`; after the steps check, `if (done === true && run.kind !== 'get-done') throw new SafeToolError('validation', 'done');` (a wrong call, refused before anything is written; the store covers the race, decisions row 9); put `done` into the hook input only when present.

- [ ] **Step 1: Write the failing tests.**
  - `done.test.ts` (services over the real store and Postgres): a `services()` helper modelled on `reply.test.ts`'s (a team agent, `allowed` switchable, `dispatched` and `logged` contexts), registering the routines services, with a get-done `TASK`.
    - `it('routines:complete marks the owner’s task done, once, and says so in one line')`: answer `{ done: true }`; one `routines_task_completed` info line whose keys are all in `['level', 'ts', 'reqId', 'msg', 'agentId', 'routineId']`; `routines:get` as the owner shows `enabled: false`, `nextRunAt: null`, `done: { at: now.toISOString() }`.
    - `it.each` over a teammate (`forbidden`), the owner with `allowed: false` (`forbidden`), a stay-on-top task (`not-found`) and a missing routine (`not-found`): rejects with that `toolCode`, and the task is unchanged.
    - `it('routines:reopen on a Done task reopens it and starts a check-in keyed on its reply')`: `{ replyId, checkIn: 'started' }`; one dispatch whose receipt request id is `reply:${replyId}`; `routines_task_reopened` with `{ wasDone: true, checkIn: 'started' }`.
    - `it('its check-in follows the reply’s rules')`: a claimed paused task → `'paused'`; a claimed running task with `allowed: false` → `'not-allowed'` (the claim still goes); the same request again → `'replayed'`.
    - `it('a Done task can’t be reopened without edit, and nothing is stored')`: `allowed: false` → `forbidden`, no reply row.
    - `it('runs inside admitDispatch: a host shutting down refuses it before anything is written')`: `admitDispatch` that throws → rejects, no reply row, still Done.
    - `it('shows done and the claim to the task’s owner only')`: a claimed task: the owner's `get` has `task.doneClaimed: true`; after `complete`, `done: { at }`; a teammate's `get` and `list` show `done: null` and `task: null`.
  - `return-schemas.test.ts`: `ROUTINE_SERVICES` has length 22 and contains `'routines:complete'` and `'routines:reopen'`; `routineView` of a Done get-done row (with `done` and a claimed `task`) as `'owner'` parses with `RoutineViewSchema` and the Get, Create and Update output schemas and has `done: { at }`; as `'teammate'` it has `done: null`; the same row as stay-on-top has `done: null` and no claim; `RoutineViewSchema` refuses `done: { at, byUserId: 'owner' }`; `RoutineCompleteOutputSchema` takes `{ done: true }` only.
  - `report-tool.test.ts`, `describe('routine_report done (TASK-950)')`:
    - `'done on a stay-on-top check-in is refused at pre-call and at execute, naming done, and writes nothing'`: inside a stay-on-top check-in, pre-call is `{ rejected: true, reason: INVALID('done') }`, execute rejects with `{ toolCode: 'validation', field: 'done' }`, and nothing is written.
    - `'done with on-track is refused, naming done'`: on a get-done check-in, the same two refusals.
    - `'a get-done check-in claims done: routine_get and routine_list show it'`: the answer is `toStrictEqual({ recorded: true })`; from a chat context `routine_get`'s `task.doneClaimed` is `true` and `done` is `null`; `routine_list`'s entry has the same.
  - `report-hook.test.ts`: `'a report on a Done task is refused, and the operator line says done'`: rejects with `{ toolCode: 'not-in-check-in' }`; exactly one `routines_report_refused` line with `{ stage: 'hook', reason: 'done' }`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/done.test.ts src/__tests__/return-schemas.test.ts src/__tests__/report-tool.test.ts src/__tests__/report-hook.test.ts`
Expected: FAIL. The services and view fields don't exist.

- [ ] **Step 3: Implement** the Interfaces and services above, and the fixtures (Files). Rewrite `replyCheckIn`'s doc's "a stored reply" to say it serves `routines:reopen` too, and the `report` comment to name the claim and the `'done'` refusal.

- [ ] **Step 4: Run and see them pass, then everything that parses a view**

Run:
- `pnpm --filter @ax/routines exec vitest run src/__tests__/done.test.ts src/__tests__/return-schemas.test.ts src/__tests__/report-tool.test.ts src/__tests__/report-hook.test.ts`
- `pnpm --filter @ax/routines-contract test && pnpm --filter @ax/routines test && pnpm --filter @ax/routines-admin-routes test`
- `pnpm --filter @ax/routines build && pnpm --filter @ax/channel-web exec tsc --build`
- `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server src/__tests__/routines-list.test.tsx src/__tests__/routine-manager-producer.test.tsx`

Expected: PASS. `presets/k8s/src/__tests__/preset.test.ts` pins routines hooks with `toContain` only, so it needs no change.

- [ ] **Step 5: Commit**

```bash
git add packages/routines-contract/src packages/routines/src packages/routines-admin-routes/src/__tests__/routes.test.ts packages/channel-web/src
git commit -m "[TASK-950] routines: routines:complete and routines:reopen, and the owner sees a task's claim and when it was marked done"
```

---

### Task 5: The check-in message, the brief and the canary [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/checkin-message.ts`: `CheckInMessageInput` (:19-48), a `claimedLine`, `renderCheckInMessage` (:155-176) and its doc.
- Modify: `packages/routines/src/fire.ts` (:281-284) and the comment above it.
- Modify: `packages/routines/src/brief.ts`: `BRIEF_GET_DONE`'s third line (:64) and the doc above it.
- Modify: `packages/routines/src/__tests__/support/check-in.ts`: `reopenCheckIn` on `CheckInHarness`.
- Modify tests: `checkin-message.test.ts`, `brief.test.ts` (:96, :113), `canary.test.ts`.
- Fixtures forced by `CheckInMessageInput.doneClaimed` (required): add `doneClaimed: false` to `checkin-message.test.ts`'s `SCHEDULED` and its other literals, to `checkin.test.ts`'s literals and to `fire.test.ts`'s.

**Interfaces:**
- Consumes: `StoredTaskState.doneClaimed` (Task 2); `routines:complete`, `routines:reopen` (Task 4).
- Produces: `CheckInMessageInput.doneClaimed: boolean`; `CheckInHarness.reopenCheckIn(view: RoutineView, requestId: string, text: string, body: CheckInBody, opts?: CheckInOptions): Promise<CheckIn & { answer: RoutineReopenOutput }>`, `replyCheckIn`'s twin over `routines:reopen` (share the body; it throws unless the answer is `'started'`).

The exact copy:
- The claim line: `'In your last report you said you think this task is done. The person hasn’t marked it done yet. Check whether it still is, and report again.'`
- `BRIEF_GET_DONE`'s third line becomes `'- When you think the whole task is done, report status "needs-you" with done true. The person then marks it done, or tells you what’s left. Only the person marks it done.'`
- Message order (decisions row 13): opening, the claim line, the misses line, steps, notes, replies, recent reports, closing.
- `fire.ts` passes `doneClaimed: row.kind === 'get-done' && row.task?.doneClaimed === true`, from the accepted row.

- [ ] **Step 1: Write the failing tests.**
  - `checkin-message.test.ts`, `describe('a claimed task’s check-in message (TASK-950)')`:
    - `renderCheckInMessage({ ...SCHEDULED, doneClaimed: true, missesInARow: 1, steps: [] }).split('\n\n')`: `[0]` is `'Scheduled check-in.'`, `[1]` the claim line, `[2]` `'Your last check-in ended without a report. Finish this one with routine_report, even if nothing changed.'`, `[3]` starts with `'This task has no steps yet.'`.
    - With `doneClaimed: false` the message doesn't contain `'you think this task is done'` and equals the existing exact output.
  - `brief.test.ts`: update the two pinned get-done lines to the new third line; add `it('the get-done brief says how to claim done, and only that kind’s does (TASK-950)')`: the get-done brief contains the new line, the stay-on-top brief contains neither `'done true'` nor `'marks it done'`.
  - `canary.test.ts`, a new describe at the end:
    ```ts
    // TASK-950: a "Get something done" task finishes, end to end through the real routines, agents, tool-policy and
    // decisions plugins and Postgres: a check-in says it's done, the next one is told so and says it again, the person
    // marks it done, nothing runs after, and Reopen with a reply starts a check-in that reads it.
    describe('done canary (TASK-950)', () => {
      it('a check-in says the task is done; the person marks it done, it stops, and Reopen with a reply starts it again', async () => {
    ```
    The steps: create a get-done task on `h.agentId` with `routines:create` as `h.owner` (`TASK_DEFINITION` with `kind: 'get-done'`); run 1 reports `{ status: 'needs-you', update: 'Every article is on the new site.', done: true }` (answer `{ recorded: true }`); after its fire row lands, `routines:get` shows `task: { status: 'needs-you', doneClaimed: true }` and `done: null`; run 2's message contains the claim line, and it reports with `done: true` again; `routines:complete` (`requestId: 'mark-done'`) answers `{ done: true }`; the task is `enabled: false`, `nextRunAt: null`, `done: { at: <ISO> }`, `noRecentUpdate: null`; `routines:fire-now` with its revision rejects with `{ toolCode: 'disabled' }`; the same `routines:complete` again answers `{ done: true }` and the revision is unchanged; `ch.reopenCheckIn(done, 'reopen-1', REPLY, async () => {})` answers `checkIn: 'started'`, its message contains `` `(new since your last report):\n  > ${REPLY}` `` and not the claim line; the task is `enabled: true`, `done: null`, with a `nextRunAt`. (Decisions row 21: the tick's side is pinned by Task 3's `claimDue` assertion.)

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/checkin-message.test.ts src/__tests__/brief.test.ts src/__tests__/canary.test.ts -t "TASK-950"`
Expected: FAIL.

- [ ] **Step 3: Implement.** `claimedLine(doneClaimed)` returns the line or null. Extend the docs: `CheckInMessageInput.doneClaimed` is the accepted row's live claim (a get-done task whose latest report said done, not yet answered); `renderCheckInMessage`'s doc says the host adds the claim line after the opening, fixed text, and that a Not yet reply arrives in the replies paragraph marked new. `BRIEF_GET_DONE`'s doc says the third line tells the agent how to claim and that only the person marks it done. Add `reopenCheckIn` and the fixtures (Files).

- [ ] **Step 4: Run and see them pass, then the package**

Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/checkin-message.test.ts src/__tests__/brief.test.ts src/__tests__/canary.test.ts src/__tests__/checkin.test.ts src/__tests__/fire.test.ts && pnpm --filter @ax/routines test && pnpm --filter @ax/routines build`
Expected: PASS. The canary is harness-based: on the shim it runs like the rest; re-run it on Docker before the handoff, or name it as shim-only.

- [ ] **Step 5: Commit**

```bash
git add packages/routines/src
git commit -m "[TASK-950] routines: a claimed task's check-in is told so, and the get-done brief says how to claim done"
```

---

### Task 6: channel-web server and client API: done on the wire, and the complete and reopen routes [tier: sensitive]

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-types.ts`: `TaskRowReport` (:1366) gains `doneClaimed`; `TaskRow` (:1399-1413) gains `doneAt`; `TaskDetailReport` (:1431-1440) gains `doneClaimed`; `TaskDetail` (:1497-1525) gains `doneAt`; a new `TaskCompleteResponse` beside `TaskReplyResponse` (:1479).
- Modify: `packages/channel-web/src/server/routes-workspace.ts`: the route list (:8-12) and the security-posture paragraph (:58-77, "the task page's four routes"); `TaskListView` and `TaskDetailView` (:752-781) pick `'done'`; `toTaskRows` (:3447-3473) and `toTaskDetail` (:3698-3746) with their docs; a new `toTaskDoneAt`; a new `readTaskCompleteBody` beside `readTaskReplyBody` (:3655); types `TaskCompleteInput`/`TaskCompleteOutput` beside `TaskReplyInput` (:816-820; reopen reuses `TaskReplyInput` and `TaskReplyOutput`); handlers `completeTask` and `reopenTask` after `taskReply` (:7513-7558); two route-table entries after the replies route (:9924-9930).
- Modify: `packages/channel-web/src/server/plugin.ts`: the manifest comment (a TASK-950 paragraph after TASK-931's, :79-81) and two `optionalCalls` after `routines:recent-replies` (:353-358).
- Modify: `packages/channel-web/src/lib/workspace-api.ts`: `isTaskReport` (:481-490), `withRowDefaults` (:503-514) and its doc, `isTaskRow` (:550-563), `isTaskDetailReport` (:590-601), `isTaskDetail` (:666-689); `completeTask` and `reopenTask` after `sendTaskReply` (:1187-1203).
- Modify tests: `src/__tests__/server/routes-workspace-task.test.ts`, `routes-workspace-tasks.test.ts`, `routes-workspace-registration.test.ts` (:62-71), `plugin.test.ts` (:722-830, the exact `optionalCalls` list); `src/lib/__tests__/workspace-api-task.test.ts`, `workspace-api-tasks.test.ts`.
- Fixtures forced by the new required fields: every `TaskRow`, `TaskRowReport`, `TaskDetail` and `TaskDetailReport` literal `pnpm --filter @ax/channel-web exec tsc --build` names (expect `TasksPage.test.tsx`, `TaskPage.test.tsx`, `TodayTaskGroup.test.tsx`, `TodayView.test.tsx`, `WorkspaceShell*.test.tsx`, `consent-focus.test.tsx`, `task-groups.test.ts`, `today-queue.test.ts`, `workspace-tasks.test.ts`, `workspace-task.test.ts` and the route tests' exact bodies): a row gets `doneAt: null`, a report `doneClaimed: false`.

**Interfaces:**
- Consumes: the views' `done` and `task.doneClaimed` (Task 4); `routines:complete`, `routines:reopen` and their schemas (Tasks 1, 4).
- Produces:
  ```ts
  // workspace-types.ts
  TaskRowReport.doneClaimed: boolean;    TaskDetailReport.doneClaimed: boolean;
  /** TASK-950. When a person marked the task done, ISO; null while it isn't Done. */
  TaskRow.doneAt: string | null;         TaskDetail.doneAt: string | null;
  /** `POST /api/workspace/tasks/:agentId/:routineId/complete`'s answer (TASK-950). */
  export interface TaskCompleteResponse { done: true }
  // workspace-api.ts
  completeTask(agentId: string, routineId: string, input: { requestId: string }): Promise<TaskCompleteResponse>;
  reopenTask(agentId: string, routineId: string, input: { text: string; requestId: string }): Promise<TaskReplyResponse>;
  ```
  Both throw `WorkspaceApiError` carrying only the status, or `WorkspaceShapeError` on an answer of the wrong shape, as `sendTaskReply` does.

The routes (decisions row 11):
- `POST /api/workspace/tasks/:agentId/:routineId/complete`, body `{ requestId }`: `authOr401` → `taskKeyOr400` → JSON (400 `invalid-json`) → `readTaskCompleteBody` (a non-empty string `requestId`, else 400 `invalid-body`) → without `routines:complete`, 503 `task-complete-unavailable` → `ownTaskOr404` → `own.view.permissions.edit` false → 403 `task-done-not-allowed` → `routines:complete` as the caller (`agentWorkspaceCtx`) with `{ agentId, routineId, requestId }` built field by field → a `SafeToolError` `forbidden` → 403 `task-done-not-allowed`; any other `isTaskRefusal` → 404 `task-not-found`; anything else throws → 200 `{ done: true }`.
- `POST …/reopen`, body `{ requestId, text }` (`readTaskReplyBody`): the same order with 503 `task-reopen-unavailable`; the 403 before the call only when `own.view.done !== null && !own.view.permissions.edit`; a `validation` refusal → 400 `reply-invalid` (checked before `isTaskRefusal`); `forbidden` → 403; other refusals → 404 → 200 `{ checkIn }`.
- `toTaskDoneAt(view)` is lenient for a view the schema didn't parse (TASK-913, as `toTaskNoRecentUpdate`): a non-object `done`, or one without a string `at`, is null. Rows and the detail carry `doneAt: toTaskDoneAt(view)` and `task.doneClaimed: view.task.doneClaimed === true`. Both docs gain: when a person marked the task done crosses as a time, host-written; who marked it never crosses.
- `plugin.ts` `optionalCalls`, exact:
  - `{ hook: 'routines:complete', degradation: 'Mark done on the task page and on Today (POST /api/workspace/tasks/:agentId/:routineId/complete) answers 503 and the task keeps checking in' }`
  - `{ hook: 'routines:reopen', degradation: 'Not yet and Reopen (POST /api/workspace/tasks/:agentId/:routineId/reopen) answer 503 and nothing is sent' }`
- `workspace-api.ts`: `isTaskReport` accepts `doneClaimed` absent or boolean; `isTaskRow` accepts `doneAt` absent, null or a string; `withRowDefaults` fills an absent `doneAt` with null and an absent `task.doneClaimed` with false (its doc: a host from before TASK-950); `isTaskDetailReport` requires a boolean `doneClaimed` and `isTaskDetail` a present `doneAt`, null or a string (`task()` doesn't normalise, as for the ask).

- [ ] **Step 1: Write the failing tests.**
  - `routes-workspace-task.test.ts`: the `World` gains `completeAnswer`/`completeFailure` and `reopenAnswer`/`reopenFailure`; `setup` registers `routines:complete` and `routines:reopen` unless `absent`, each pushing to `order` and its calls list and running `parseRoutineInput` with the contract's input schema first, with `returns` set to the output schema; helpers `complete(params, body)` and `reopen(params, body)`. A get-done `stored()` row for these tests. New describes:
    - `POST …/complete (TASK-950)`: 200 `{ done: true }` with the service called once as `alice` with exactly `{ agentId: 'a1', routineId: 't1', requestId: 'req-1' }` though the body carried `agentId: 'zzz'` and `admin: true`, and `order` is `['routines:get', 'routines:complete']`; 403 `task-done-not-allowed` for an owner the managers list leaves out (a task that has reported, so it is still theirs), with no service call; 403 for a service `forbidden`; 404 `task-not-found` for a teammate on a team agent with someone else's task, with no service call; 404 for `not-found`; 503 before reading anything (`resolveCalls` and `getCalls` empty); 400 `invalid-json`, 400 `invalid-body` for `{}`, `{ requestId: '' }` and `{ requestId: 7 }`; 401 without a session; a thrown `Error('db down')` from the service fails the request (rejects).
    - `POST …/reopen (TASK-950)`: 200 `{ checkIn }` for each of the four answers; a Done task (`stored({ …, enabled: false, done: { at, byUserId: 'alice' } })`) and an owner without `edit` → 403 before the call; a claimed running task and an owner without `edit` → the service is called (Not yet needs only ownership); 400 `reply-invalid` for `'   '` and `'x'.repeat(2001)` (the service's own check); 404, 503, 401 and the 400s as for complete.
    - `the page carries doneAt and the claim (TASK-950)`: a claimed get-done task's detail has `task.doneClaimed: true` and `doneAt: null`; a Done one has `doneAt` equal to its ISO time; with `unvalidated` and `viewPatch: { done: 'nope' }`, `doneAt` is null.
  - `routes-workspace-tasks.test.ts`: a Done row has `doneAt` and a claimed row `task.doneClaimed: true`; no row carries a `byUserId`, and the body's JSON doesn't contain `'alice'` as a completer field (assert `JSON.stringify(body)` has no `byUserId`).
  - `routes-workspace-registration.test.ts`: `toContain('POST /api/workspace/tasks/:agentId/:routineId/complete')` and `'…/reopen'`.
  - `plugin.test.ts`: the exact `optionalCalls` list gains the two entries, right after `routines:recent-replies`.
  - `workspace-api-tasks.test.ts`: a row without `doneAt` and a report without `doneClaimed` (an older host) read as `doneAt: null`, `doneClaimed: false`; `doneAt: 7` and `doneClaimed: 'yes'` are refused.
  - `workspace-api-task.test.ts`: a detail needs `doneAt` (null or text) and `task.doneClaimed`; `completeTask` POSTs `{ requestId }` only, with the CSRF header, to `/api/workspace/tasks/a1/t1/complete`, refuses an answer other than `{ done: true }`, and carries a failed press's status; `reopenTask` POSTs `{ text, requestId }` to `…/reopen`, reads each `checkIn`, and carries a failure's status.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-workspace-task.test.ts src/__tests__/server/routes-workspace-tasks.test.ts src/__tests__/server/routes-workspace-registration.test.ts src/__tests__/server/plugin.test.ts src/lib/__tests__/workspace-api-task.test.ts src/lib/__tests__/workspace-api-tasks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces and routes above, with handler docs in the reply route's style (each saying why it reads the task first), the route list lines ` * POST /api/workspace/tasks/:agentId/:routineId/complete — mark that task done (TASK-950)` and ` * POST /api/workspace/tasks/:agentId/:routineId/reopen — "Not yet", or reopen a Done task, with a reply (TASK-950)`, and the posture paragraph: six routes, and `/complete` and `/reopen` read the caller's own task first because only an owner may learn they can't. Fix the fixtures `tsc --build` names.

- [ ] **Step 4: Run and see them pass, then the package**

Run: the Step 2 command, then `pnpm --filter @ax/channel-web exec tsc --build && pnpm --filter @ax/channel-web test`
Expected: PASS. `manifest-declarations.test.ts` stays green because both hooks are declared.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src
git commit -m "[TASK-950] channel-web: Mark done and Not yet/Reopen routes, and when a task was done on the wire"
```

---

### Task 7: The reply box's Not yet and Reopen modes, and Mark done's press [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/workspace/TaskReplyBox.tsx`: a `mode` prop; `failureLine`, `helperLine`, `sentLine` (:65-96) take it; the endpoint; export the confirmed-answer check (:61-63) as `isConfirmedAnswer`; the header comment.
- Create: `packages/channel-web/src/components/workspace/TaskMarkDone.tsx`.
- Create: `packages/channel-web/src/components/workspace/__tests__/TaskMarkDone.test.tsx`.
- Modify tests: `packages/channel-web/src/components/workspace/__tests__/TaskReplyBox.test.tsx` (its mock gains `reopenTask`).

**Interfaces:**
- Consumes: `workspaceApi.completeTask`, `workspaceApi.reopenTask` (Task 6).
- Produces:
  ```ts
  // TaskReplyBox.tsx
  export type TaskReplyMode = 'reply' | 'not-yet' | 'reopen';
  // new optional prop: mode?: TaskReplyMode, default 'reply'; 'not-yet' and 'reopen' send with workspaceApi.reopenTask
  export function isConfirmedAnswer(e: unknown): e is HttpError; // today's `confirmed`, renamed and exported
  // TaskMarkDone.tsx
  export const MARK_DONE_NOT_ALLOWED = 'You can’t mark this task done, because you no longer manage this agent’s tasks.';
  export function untickedLine(unticked: number): string;
  export function markDoneFailure(e: unknown): { text: string; register: AlertRegister };
  export function useMarkDone(input: { agentId: string; routineId: string; unticked: number; onDone: () => void }): {
    busy: boolean; confirming: boolean; failure: { text: string; register: AlertRegister } | null;
    press: () => void; confirm: () => void; cancel: () => void;
  };
  export function MarkDoneConfirmation(props: { unticked: number; primary: boolean; busy: boolean; onConfirm: () => void; onCancel: () => void }): JSX.Element;
  ```

The copy (decisions rows 14, 16):

| | `reply` (unchanged) | `not-yet` | `reopen` |
|---|---|---|---|
| Label | `Reply to {agent} about this task` | `What’s left for {agent} to do?` | same as not-yet |
| Helper, running, may start | today's | `{agent} reads this, and sending it starts a check-in now.` | `Sending this reopens the task, and {agent} starts checking in again.` |
| Helper, running, may not start | today's | `{agent} reads this at its next check-in.` | as above |
| Helper, paused | today's | today's paused lines | as above |
| Sent: started, replayed | `Sent. {agent} started checking in.` | `Sent. {agent} is checking in now.` | same as not-yet |
| Sent: paused | today's | `Sent. {agent} will read it when you resume the task.` | same |
| Sent: not-allowed | today's | `Sent. {agent} will read it at its next check-in.` (running) / `Sent. {agent} will read it once the task is resumed.` (paused) | same |
| 403 | today's not-found line | `You can’t reopen this task, because you no longer manage this agent’s tasks.` | same |

Mark done:
- `untickedLine(1)` is `'1 step isn’t ticked. It’ll stay on the task as it is.'`; `untickedLine(n)` is `` `${n} steps aren’t ticked. They’ll stay on the task as they are.` ``.
- `markDoneFailure`: not a confirmed answer (`!isConfirmedAnswer(e)`: no `HttpError`, status 0, 5xx, 408, 429, a shape error) → `'We couldn’t confirm the task was marked done. Try again, and it won’t happen twice.'`, destructive; 401 → `HTTP_SESSION_ENDED`, `'default'`; 403 → `MARK_DONE_NOT_ALLOWED`; 404 → `'We couldn’t find this task any more. It may have been deleted.'`; any other → `'We couldn’t mark this task done just now. Try again.'` (all destructive but the 401).
- `useMarkDone`: `press()` opens the confirmation when `unticked > 0`, else sends; `confirm()` sends; `cancel()` closes it. A send is one at a time (a ref guard, as `TaskReplyBox` has); it reuses the pending `requestId` after an unconfirmed failure and drops it on success or a confirmed answer (TaskPage's pending-press rule); on success it closes the confirmation, clears the failure and calls `onDone()`; every failure is logged with `logRequestFailure(e, 'task-mark-done')`.
- `MarkDoneConfirmation` is an `Alert` (default variant) holding the line and two `size="sm"` buttons: **Mark done anyway** (`default` when `primary`, else `outline`; a `Spinner` while `busy`) and **Cancel** (`ghost`). It takes focus on its first button when it mounts.

- [ ] **Step 1: Invoke the `shadcn` and `ux-design` skills**, then write the failing tests.
  - `TaskReplyBox.test.tsx`, `describe('Not yet and Reopen (TASK-950)')`: in `not-yet` mode the textarea is labelled `What’s left for Quill to do?`, the helper for a running task that may start is the table's, Send calls `reopenTask('a1', 't1', { text, requestId })` and never `sendTaskReply`, and each answer shows its sent line; in `reopen` mode the helper is the reopen one; a paused not-yet box shows the paused helper; a 403 shows the reopen line; `reply` mode's existing tests stay as they are.
  - `TaskMarkDone.test.tsx` (a small harness component that renders a Mark done button wired to `useMarkDone` and the confirmation when `confirming`):
    - `'finishes on the first press when nothing is unticked'`: `completeTask` is called once with a `requestId`, and `onDone` runs.
    - `it.each([[1, '1 step isn’t ticked. It’ll stay on the task as it is.'], [2, '2 steps aren’t ticked. They’ll stay on the task as they are.']])('asks first with %i unticked')`: no call until Mark done anyway; Cancel closes it with no call.
    - `'keeps its request id across a failure nobody answered, and starts afresh after an answer'`: a `WorkspaceApiError(path, 503)` then success: both calls carry the same `requestId`; a 403, then another press: a new `requestId`.
    - `it.each` over 401, 403, 404, 0 and 500: the failure's words and register.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/TaskReplyBox.test.tsx src/components/workspace/__tests__/TaskMarkDone.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** with installed shadcn primitives and semantic tokens only. Extend `TaskReplyBox`'s header comment: three modes, and that a Not yet or Reopen reply goes to `routines:reopen`. Give `TaskMarkDone.tsx` a header comment: only a person marks a task done; the press keeps its request across an unanswered failure so a retry finishes nothing twice; the confirmation never blocks a task with every step ticked or none.

- [ ] **Step 4: Run and see them pass, then the package**

Run: the Step 2 command, then `pnpm --filter @ax/channel-web exec tsc --build && pnpm --filter @ax/channel-web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/workspace
git commit -m "[TASK-950] channel-web: the reply box's Not yet and Reopen modes, and Mark done's press"
```

---

### Task 8: The Tasks page: Done above paused, Done this week, and the Done filter [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/task-groups.ts` (:4-104).
- Modify: `packages/channel-web/src/components/workspace/bits.tsx`: the shapes comment (:95-108), `STATE_SHAPE` (:125-137), `StateDot`'s arms (:166-186).
- Modify: `packages/channel-web/src/components/workspace/TasksPage.tsx`: the header comment (:1-19), `TaskBoard` (:135-221), a new `DoneSection`, `TaskItem` (:322-385).
- Modify: `packages/channel-web/src/components/workspace/TaskPage.tsx`: the `taskGroup({ … })` call in `LatestUpdate` gains `doneAt: null` (the miss card is never a Done task's).
- Modify tests: `src/lib/__tests__/task-groups.test.ts`, `src/components/workspace/__tests__/StateDotSlot.test.tsx` (:63-82 and a new test), `src/__tests__/theme-contrast.test.ts` (`dotFills` :1356-1363 and the exact list :1378-1396), `src/components/workspace/__tests__/TasksPage.test.tsx`.

**Interfaces:**
- Consumes: `TaskRow.doneAt`, `task.doneClaimed` (Task 6).
- Produces:
  ```ts
  export type TaskGroup = 'needs-you' | 'off-track' | 'no-recent-update' | 'on-track' | 'no-update' | 'paused' | 'done';
  export type ActiveTaskGroup = Exclude<TaskGroup, 'paused' | 'done'>;  // the same five as today
  TASK_GROUP_LABELS.done = 'Done';
  /** How long a Done task stays under Current, counted from doneAt against the browser's clock. */
  export const TASK_DONE_RECENT_MS = 7 * 86_400_000;
  export function taskGroup(row: { enabled: boolean; doneAt: string | null; task: { status: RoutineReportStatus } | null; noRecentUpdate: { inARow: number } | null }): TaskGroup; // 'done' first
  export function groupTasks(rows: readonly TaskRow[], now: Date): {
    groups: Array<{ group: ActiveTaskGroup; rows: TaskRow[] }>; paused: TaskRow[]; doneRecently: TaskRow[]; doneAll: TaskRow[];
  };
  ```
  `doneRecently` holds done rows with `now - Date.parse(doneAt) <= TASK_DONE_RECENT_MS` (a future `doneAt` counts; an unreadable one is only in `doneAll`); both lists are newest `doneAt` first, ties by today's `compareRows` order; done rows are in neither `groups` nor `paused`. Rewrite `taskGroup`'s doc: Done wins, then paused, then the rest as today.
- `STATE_SHAPE.done = 'box-border h-[7px] w-[4px] -translate-y-px rotate-45 border-b-[1.5px] border-r-[1.5px]'` and the arm `state === 'done' && 'border-primary'`, after `paused`'s (decisions row 18). The shapes comment's task-marks list adds "done ✓".

The page (decisions row 19), exact copy:
- `Segmented` under the header, in a `<div className="self-start">` so the track doesn't stretch: `label="Which tasks to show"`, options `[{ value: 'current', label: 'Current' }, { value: 'done', label: 'Done', count: doneAll.length }]`. It renders only when `doneAll.length > 0`; the view is `doneAll.length === 0 ? 'current' : chosen`, with `chosen` in `TaskBoard`'s state.
- Current: the groups, then a section headed `StateDot done` + `Done this week` + ` · {n}` (the group heading's markup) over `doneRecently`, then the paused toggle. When it has no groups, no recent done tasks and none paused, but `doneAll` isn't empty, it says, muted: `No tasks need looking after right now. Finished ones are under Done.`
- Done: only one section, headed `StateDot done` + `Done` + ` · {n}`, over `doneAll` (no groups, no paused toggle). The load-failure and "couldn’t load tasks from …" alerts show in both views, as today.
- A done row's second line is `` `${row.agentName} · Done ${when}` `` with `when = checkInWhen(row.doneAt, now)`, or `` `${row.agentName} · Done` `` when that is null; its third line is the update, as on any row.

- [ ] **Step 1: Invoke the `shadcn` and `ux-design` skills**, then write the failing tests.
  - `task-groups.test.ts`, with `vi.useFakeTimers({ now: Date.parse('2026-10-24T12:00:00Z') })` where a test needs a clock: `taskGroup` gives `'done'` for a done row even with a needs-you report and three misses, and `'paused'` for a disabled row without `doneAt`; `groupTasks` puts a row done exactly 7 days before `now` in `doneRecently`, one done 7 days and 1 ms before only in `doneAll`, a future one in `doneRecently`, an unreadable one only in `doneAll`; both lists are newest first; done rows are in no group and not in `paused`.
  - `StateDotSlot.test.tsx`: the states list gains `'done'`; `it('draws done as a check no other mark uses (TASK-950)')`: `widthPx(STATE_SHAPE.done)` is 4, the shape contains `rotate-45`, `border-b-[1.5px]` and `border-r-[1.5px]`, it equals no other shape, and the rendered dot has `border-primary` and no `bg-` class.
  - `theme-contrast.test.ts`: `dotFills` maps `border-primary` to `bg-primary` as it maps `border-state-quiet`; the exact list gains `'StateDot.done'` after `'StateDot.paused'`.
  - `TasksPage.test.tsx`: `'Current shows the groups, then Done this week, then paused'` (section order by `compareDocumentPosition`; the done row reads `Caveman · Done …`); `'the toggle shows only when a task is done, and counts them'` (no radiogroup named "Which tasks to show" without one; with two, the radio named `/^Done/` contains `2`); `'Done lists every done task, newest first'`; `'a task done 8 days ago is only under Done'`; `'Current says where finished tasks went when it has nothing else'`; `'the choice survives a re-read, and falls back to Current when the last done task is reopened'` (rerender with new rows).

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/task-groups.test.ts src/components/workspace/__tests__/StateDotSlot.test.tsx src/__tests__/theme-contrast.test.ts src/components/workspace/__tests__/TasksPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** with installed primitives and semantic tokens only. Update `TasksPage`'s header comment (the Current and Done views) and the shapes comment in `bits.tsx`.

- [ ] **Step 4: Run and see them pass, then the package and its build**

Run: the Step 2 command, then `pnpm --filter @ax/channel-web exec tsc --build && pnpm --filter @ax/channel-web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/task-groups.ts packages/channel-web/src/lib/__tests__/task-groups.test.ts packages/channel-web/src/components/workspace packages/channel-web/src/__tests__/theme-contrast.test.ts
git commit -m "[TASK-950] channel-web: Done tasks on Tasks, under Done this week and a Done filter"
```

---

### Task 9: The task page: the claim, Mark done, Not yet, the Done page and Reopen [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/workspace/TaskPage.tsx`: the header comment (:1-60, "the page's two actions" goes); `actionNote` (:149-164); `TaskPage` (:283-381) holds the in-place box state; `TaskActions` (:387-440); `TaskBody` (:461-607); `LatestUpdate` (:682-846).
- Modify: `packages/channel-web/src/components/workspace/TaskSteps.tsx`: a `footer?: ReactNode` prop, drawn after the list or the empty line.
- Modify tests: `__tests__/TaskPage.test.tsx` (its mock gains `completeTask` and `reopenTask`; `detail()` gains `doneAt: null`), `__tests__/TaskSteps.test.tsx`.

**Interfaces:**
- Consumes: `TaskReplyBox` modes, `useMarkDone`, `MarkDoneConfirmation`, `MARK_DONE_NOT_ALLOWED` (Task 7); `StateDot state="done"` (Task 8); `TaskDetail.doneAt`, `task.doneClaimed` (Task 6).
- Produces: nothing other tasks use.

The behaviour (decisions rows 15, 16, 17), with `claimed = detail.doneAt === null && detail.task?.doneClaimed === true` and `unticked = detail.steps.filter(s => !s.done).length`:
- **Header.** A Done task shows only **Reopen** (outline), disabled without `permissions.edit` (described by the note), `aria-expanded`/`aria-controls` on the in-place box. Otherwise Check now and Pause/Resume as today, except that both are `outline` while `claimed`.
- **`actionNote`.** A Done task: null with `edit`, else `'Done. Only someone who manages this agent’s tasks can reopen it.'` Every other case as today.
- **`LatestUpdate`.** A Done branch first: a focusable (`tabIndex={-1}`, `RESOLUTION_FOCUS_RING`) line with `StateDot state="done"` and `` `Done · You marked it done ${when}.` `` (`checkInWhen(detail.doneAt, now)`; `'Done · You marked it done.'` when null), then, muted, `` `Last update ${reportedWhen}: ${update}` `` as the miss card writes it, when there is a report. In the ordinary branch, when `claimed`, `` `${agentName} thinks this is done.` `` comes before the update, and the action row after the ask's Reply holds **Mark done** (`default`) and **Not yet** (outline, toggling the in-place box). In the miss branch, when `claimed`, a muted `` `${agentName} said it thinks this is done.` `` comes before "Last update", with the same row. Without `edit`, Mark done is disabled and the row is followed by `MARK_DONE_NOT_ALLOWED` (the button's `aria-describedby`). While confirming, `MarkDoneConfirmation` (`primary`) takes the action row's place.
- **In-place box.** `TaskPage` keeps `inPlace: { mode: 'not-yet' | 'reopen'; open: boolean } | null`. Not yet and Reopen open it in their mode (pressing the same trigger again toggles it; the other mode replaces it, keyed by mode). `TaskBody` renders it right after `LatestUpdate`, in an element with the box's id and `hidden={!open}` (no display class on that element: it would beat `[hidden]`), as `TaskReplyBox` in that mode with `enabled`, `canStart={permissions.fire}`, `onSent={onReplySent}`; opening focuses its textarea (an effect, as Today's Reply does). It stays mounted once opened, so its sent line survives the claim or Done ending.
- **Steps footer.** For a get-done task that isn't Done and isn't `claimed`, `TaskSteps` gets a footer: the text `'Only you can mark this task done.'`, followed by `` ` When ${agentName} thinks it’s finished, it’ll ask you here and on Today.` `` while it runs (with `edit`), or `MARK_DONE_NOT_ALLOWED` (without), beside an outline **Mark done** (disabled and described by the text without `edit`); while confirming, `MarkDoneConfirmation` (not `primary`).
- **Mark done.** `TaskBody` calls `useMarkDone({ agentId, routineId, unticked, onDone })` once; `onDone` re-reads the task and, once it shows as Done, focus goes to the Done line, but only from `<body>` (the page's WHERE FOCUS GOES rule). A failure is an `Alert` in its register under the row.
- **Done page.** The steps show read-only as they are; the bottom reply box is hidden while Done.

- [ ] **Step 1: Invoke the `shadcn` and `ux-design` skills**, then write the failing tests in `TaskPage.test.tsx`, `describe('finishing a task (TASK-950)')`:
  - `'a claimed task leads its latest update with the claim, and Mark done is the page’s one primary action'`: `Quill thinks this is done.` precedes the update; of the page's buttons, only Mark done carries `bg-action` (the `default` variant's class), and Check now doesn't.
  - `'Mark done finishes on the first press with every step ticked, or none, and asks first with unticked ones'`: with all ticked, `completeTask` is called once and the task is read again; with one unticked, `1 step isn’t ticked. It’ll stay on the task as it is.` shows and nothing is called until Mark done anyway; with two, the plural line.
  - `'Not yet opens the box in place: what’s left, sent as a reopen, and the line stays after the claim goes'`: the textarea labelled `What’s left for Quill to do?` gets focus; Send calls `reopenTask`; after the re-read without the claim, `Sent. Quill is checking in now.` is still shown.
  - `'without edit, Mark done is disabled and says why'`: the button is disabled and its `aria-describedby` names `MARK_DONE_NOT_ALLOWED`'s element.
  - `'a running get-done task offers Mark done under its steps; a paused one with the first sentence only'`.
  - `'a Done task: Reopen only, the Done line, its steps as they are, no reply box'`: no Check now or Pause button; `Done · You marked it done at …`; an unticked step still reads `Not done:`; no textarea labelled `Reply to Quill about this task`.
  - `'Reopen opens the what’s-left box, and sending reopens the task'`: the reopen helper shows; Send calls `reopenTask`.
  - `'a Done task without edit can’t reopen it, and the note says who can'`.
  - `'a refused Mark done says why in the page’s words'`: a 403 shows `MARK_DONE_NOT_ALLOWED` in an alert.
  - `TaskSteps.test.tsx`: `'draws a footer after the steps, and after the empty line'`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/TaskPage.test.tsx src/components/workspace/__tests__/TaskSteps.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** with installed primitives and semantic tokens only. The agent-written text (the update, the ask) stays a React text child. Update the page's header comment: the actions now include Mark done (in the claim card or under the steps) and, on a Done task, Reopen alone.

- [ ] **Step 4: Run and see them pass, then the package and its build**

Run: the Step 2 command, then `pnpm --filter @ax/channel-web exec tsc --build && pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build`
Expected: PASS, and `tsc --build && vite build` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/workspace
git commit -m "[TASK-950] channel-web: the task page's claim card, Mark done, Not yet, and the Done page with Reopen"
```

---

### Task 10: Today: the claimed block, then the security review [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/task-groups.ts`: `TodayTaskReason` (:107) and `todayTaskReason` (:109-121) with its doc.
- Modify: `packages/channel-web/src/components/workspace/TodayTaskGroup.tsx`: the header comment (:1-33), `MARK` (:55-59), `bodyLine` (:86-100), the block (:102-259).
- `TodayView.tsx` needs no change: it renders every group through `TodayTaskGroup` and passes `onReplied` (checked at :556-564).
- Modify tests: `src/lib/__tests__/task-groups.test.ts`, `src/lib/__tests__/today-queue.test.ts`, `src/components/workspace/__tests__/TodayTaskGroup.test.tsx` (its mock gains `completeTask` and `reopenTask`), `src/components/workspace/__tests__/TodayView.test.tsx`.

**Interfaces:**
- Consumes: `useMarkDone`, `MarkDoneConfirmation`, `TaskReplyBox` `not-yet` (Task 7); `TaskRow.task.doneClaimed`, `TaskRow.steps` (Task 6); `returnFocusToConsentRegion` (`lib/consent-focus.ts`).
- Produces: `TodayTaskReason = 'asks' | 'escalated' | 'auto-paused' | 'done-claimed'`. `todayTaskReason`: disabled → as today; not in the needs-you group → null; three or more misses → `'escalated'`; `row.task?.doneClaimed === true` → `'done-claimed'`; else `'asks'`.

The block (decisions row 20), exact copy: the mark is Needs you (`MARK['done-claimed'] = 'needs-you'`); the body line is `` `${agentName} thinks this is done.` ``, then the update (or `CANT_SHOW`) in the body's style, then, muted, `` `${agentName} asks: ${ask}` `` when the report has a legible ask; the actions are **Mark done** and **Not yet** (both `outline`, size `sm`: Approve stays Today's one primary action) and Open task. Not yet is the `Collapsible` trigger for a `TaskReplyBox` in `not-yet` mode (`canStart={false}`, `enabled={row.enabled}`, `onSent` → `onReplied`), mounted and `hidden` as the Reply box is. Mark done uses `useMarkDone` with `unticked = row.steps === null ? 0 : row.steps.total - row.steps.done`; `MarkDoneConfirmation` (not `primary`) takes the action row's place while it asks. On success, call `returnFocusToConsentRegion(<the block's root element>)` and then `onReplied()` (the block leaves Today). A failure shows under the row in its register; a 403 reads `MARK_DONE_NOT_ALLOWED`.

- [ ] **Step 1: Invoke the `shadcn` and `ux-design` skills**, then write the failing tests.
  - `task-groups.test.ts`: `todayTaskReason` gives `'done-claimed'` for an enabled claimed row, `'escalated'` for a claimed row with three misses, `'asks'` for an unclaimed needs-you row, and null for a done row and for a person-paused claimed row.
  - `today-queue.test.ts`: a claimed task counts once in `waitingOnYou` and makes one group with reason `'done-claimed'`.
  - `TodayTaskGroup.test.tsx`, `describe('a task that thinks it’s done (TASK-950)')`: the heading has the Needs you mark, then `Quill thinks this is done.`, the update and the muted ask; Mark done and Not yet are both outline (no `bg-action`); Mark done with nothing unticked calls `completeTask` and then `onReplied`; with `steps: { done: 1, total: 3 }` it shows `2 steps aren’t ticked. They’ll stay on the task as they are.` first; Not yet opens the box labelled `What’s left for Quill to do?` and its Send calls `reopenTask` and then `onReplied`; a 403 shows `MARK_DONE_NOT_ALLOWED`.
  - `TodayView.test.tsx`: a claimed row renders one block with Mark done and Not yet, inside the element marked `data-consent-region`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/task-groups.test.ts src/lib/__tests__/today-queue.test.ts src/components/workspace/__tests__/TodayTaskGroup.test.tsx src/components/workspace/__tests__/TodayView.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** with installed primitives and semantic tokens only; update the header comment's WHAT IT SAYS (a claimed task's block) and `todayTaskReason`'s doc.

- [ ] **Step 4: Run and see them pass, then the package and its build**

Run: the Step 2 command, then `pnpm --filter @ax/channel-web exec tsc --build && pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib packages/channel-web/src/components/workspace
git commit -m "[TASK-950] channel-web: Today asks about a task that thinks it's done, with Mark done and Not yet"
```

- [ ] **Step 6: Run the `security-checklist` skill** over `git diff origin/main` (Tasks 1-10) and finish the PR's `## Security review` block from this plan's Security checklist section. Every item needs an answer, and an N/A needs a reason. Keep it, with the boundary review above, for the PR description.

---

### Task 11: Docs: the design doc says what was built [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`.

**Interfaces:** none (prose only).

- [ ] **Step 1: Edit the design doc**, using the schema version Task 2 actually took (12 unless a parallel card merged first):
  - **Resume here** (:32): the sentence ending `a person editing steps (TASK-949) and Mark done (TASK-950) come next.` becomes `…; TASK-950 adds "I think it's done", Mark done, Not yet, Reopen and the Done filter (schema version 13); a person editing steps (TASK-949) comes next.` (drop the TASK-949 clause if it has merged by then).
  - **§3.1**, after "Done tasks drop off after a week and stay findable under a Done filter.": `> PR 3 (TASK-950): Tasks has Current and Done. Current shows a Done task under "Done this week" for 7 days after it was marked done, counted on the person's own clock, then only Done lists it, newest first, as "{agent} · Done {when}".`
  - **§3.4**, after the TASK-948 note: `> PR 3 (TASK-950): The agent says "I think it's done" by reporting status "needs-you" with done true; a later report without it takes the claim back, and the task keeps checking in on its schedule meanwhile, each check-in told about its own claim. The person can press Mark done at any time; it becomes the page's primary action once the agent claims done, and with unticked steps it says how many first and keeps them as they are. Not yet needs a reply: it takes the claim back and starts a check-in that reads it. A Done task stops checking in the way a pause does, keeps its steps, report and notes, and refuses a report from a check-in still running. Reopen, with a reply, runs it again and starts a check-in; switching it back on in Settings reopens it too. Mark done and Reopen need the person to manage the agent's tasks; Not yet needs only to own the task.`
  - **§3.5**, after the TASK-933 note: `> PR 3 (TASK-950): A task that thinks it's done shows on Today as "{agent} thinks this is done." with its update, and Mark done and Not yet, both outline, then Open task. Three missed check-ins still read as missed.`
  - **§3.6**, after the table's paragraphs: `PR 3 (TASK-950) builds ✓ Done: a check mark in the primary color. A Done task counts no missed check-ins, and only a person reopens it.`
  - **§4.5**, the Task state row: append `(TASK-950: the claim is kept as the time of the report that made it, so a later report takes it back; done is when the owner marked it, read only while the task is off; a change of kind or owner clears both, schema version 13.)`; the Hooks row keeps `routines:complete` and `routines:reopen` as named.
  - **§7**, the "Only a person" bullet: append `(TASK-950: no tool reaches routines:complete or routines:reopen, a report on a Done task is refused, and the agent's resume of it is refused like any paused task's.)`
  - **§15**: three rows dated 2026-10-24, all Decided: (a) After "I think it's done" the task keeps checking in, and each report keeps the claim or takes it back (questions Q3) (TASK-950). (b) A person can press Mark done at any time; it becomes the primary action once the agent claims done; unticked steps are allowed and stay on the task (questions Q4) (TASK-950). (c) A Done task can be reopened from its page with a reply, or by switching it on in Settings; Not yet needs a reply (questions Q5) (TASK-950).

- [ ] **Step 2: Check, then commit**

Run: `pnpm test:scripts`
Expected: PASS (the shards' cited paths all exist).

```bash
git add docs/plans/2026-10-20-agent-tasks-design.md
git commit -m "[TASK-950] docs: what finishing a task is, as built"
```

---

## Final verification (the card's gate)

Run: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
Expected: all green, all three suites run (CLAUDE.md). If whole Docker-backed files fail with "Waited 40000 ms for a container start slot", that is OrbStack queueing, not the diff: re-run those packages one at a time (`VITEST_MAX_WORKERS=2` for routines) and report both runs (memory `patterns/2026-10-22-TASK-910.md`). Name every suite that ran only on the local-pg shim.

## Not in this card (YAGNI)

- Email when a task says it's done (§14 Q4); an "Also ask" list, so someone else can mark done (§14 Q8).
- Undo for Mark done (Reopen covers a mistake); archiving or deleting Done tasks in bulk.
- A clear stamp that makes Not yet hold against a check-in already running (decisions row 8).
- A "Done" marker on past Updates entries, or the claim on run history (the claim lives on the task's latest report only).
- Settings saying "Done" on a Done task (it reads as switched off, and switching it on reopens it).
- Person-edited steps on a Done task (TASK-949; decisions row 24).
