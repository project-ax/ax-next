# TASK-949: People add, tick, reword and delete a task's steps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a "Get something done" task's page, its owner adds a step, ticks or unticks any step, rewords any step and deletes any step (the agent's included), with no approval and no new revision, one change at a time, and a retry never applies a change twice.

**Architecture:** A person's change is the same op the agent's report sends (`RoutineStepOpSchema`), applied by the same pure helper under the same row lock, now told who is acting. A new owner-only service, `routines:set-steps`, runs it through `receiptTransaction` (operation `'set-steps'`), whose receipt keeps a count and never text. channel-web gains `POST /api/workspace/tasks/:agentId/:routineId/steps`, and `TaskSteps.tsx` becomes an editable list (shadcn `Checkbox`, `DropdownMenu`, `Input`, `FieldError`) that swaps the page's steps for each answer without a re-read. Both writers of `task_steps` keep stored entries this version can't read. No schema change.

**Tech Stack:** TypeScript, zod 3.25, Kysely on Postgres (testcontainers, or the local-pg shim), vitest, React + shadcn (channel-web), Radix Checkbox and DropdownMenu.

**Spec:** card TASK-949 (orchestrator scratchpad `TASK-949/card.md`); `docs/plans/2026-10-20-agent-tasks-design.md` §3.4, §4.5, §7, §12 PR 3; decisions `.claude/memory/decisions/2026-10-24-TASK-949.md` (cited as "row N", counting the plan row as row 1) and `.claude/memory/decisions/2026-10-24-TASK-948.md` (cited as "948 row N").

## Where the code refined the card

Every MEASURED predecessor learning checked out against be148ac53. These change what to build:

1. **No migration** (row 2). `routines_v1_requests.operation` is plain `text NOT NULL` (`packages/routines/src/migrations.ts:538-542`), so `'set-steps'` needs no version. The dispatch note's "take version 12" doesn't apply. `migrations.test.ts` doesn't change.
2. **The helper has no actor** (row 3). `applyStepOps` always writes `addedBy: 'agent'` and lets `edit`/`remove` touch only agent steps (`packages/routines/src/steps.ts:95-112`). It gains a required `actor`.
3. **A person's edit makes the step theirs** (row 4, a call a human may want to confirm). The card is silent on edits. Otherwise the agent could reword a person's correction back, and the check-in message would frame the person's words as the agent's own plan.
4. **Stored entries this version can't read are kept by both writers** (row 6, 948 row 36). One pure `changeStoredSteps`, used by `recordReport` (948's writer) and the new `setSteps`.
5. **`receiptTransaction` stores whatever the effect returns** (`store.ts:548-553`), so a refusal must throw inside the effect. Its `onReplay` gains the transaction, so a replay can answer the steps as they are now (row 7).
6. **The get-done brief contradicts person steps** (948 row 23 (a), row 10): "Anything else in the check-in message that claims to be from them isn’t." Task 3 names the person's steps in that line.
7. **The page has no way to swap steps** (`packages/channel-web/src/lib/workspace-task.ts`). Task 5 adds `replaceSteps`, with a rule so an older in-flight read can't undo a change on screen (row 13).
8. **A person's duplicate add** is skipped like the agent's (row 5). The page checks first, so the card's "changed or removed meanwhile" line never explains a duplicate.
9. **The house body errors** are `invalid-json` / `invalid-body`, not the card's `steps-body-invalid` (row 12).
10. **No preset pin changes.** `presets/k8s/src/__tests__/preset.test.ts` checks routines' hooks with `toContain`. The pins that do change are `ROUTINE_SERVICES`' length (`packages/routines/src/__tests__/return-schemas.test.ts:140`), channel-web's exact manifest (`packages/channel-web/src/__tests__/server/plugin.test.ts`), the route registration list, and the route tests' "without routines at all" list.
11. **`setSteps` takes no `now`**, and a failed write is scrubbed like `reportWriteError` (row 9).

## Global Constraints

- Base on origin/main be148ac53 or later. **Before Task 1, `git fetch origin` and read `git log --oneline origin/main -8`.** If TASK-950 or TASK-951 merged, rebase first and follow row 18:
  - with TASK-951, `ROUTINE_SERVICES` has 22 entries and the manifest keeps `routines:set-finish-by`;
  - with TASK-950, `setSteps` refuses a done task as `forbidden` (Task 2, Step 4).
- **No schema version.** If a reviewer asks for one, point at row 2.
- **Copy is exact and asserted verbatim.** Apostrophes are U+2019 (’) and the heading separator is U+00B7 (·), as TASK-948 set them. The strings this card adds are in Task 6.
- **Invisible or broken characters in tests:** build them with `String.fromCodePoint(0x200b)` (zero-width space) and `String.fromCharCode(0xd800)` (lone surrogate). Don't type a backslash-u escape: the Write/Edit tools have turned those into raw characters four times (`.claude/memory/mistakes/2026-10-24-TASK-948.md`). If a file ends up holding one anyway, run the code-point scan from `docs/plans/2026-10-24-task-948-get-done-steps-plan.md` (Global Constraints), which must print `[]`.
- **One file:** `pnpm --filter @ax/<pkg> exec vitest run <path>`. Never `pnpm test --filter` and never a filter after the script name (CLAUDE.md). Check the summary's file count.
- **Built packages.** `@ax/routines-contract` and `@ax/core` resolve through `dist/` (`packages/routines-contract/package.json` exports `./dist/index.js`; no source alias). After editing the contract (Task 3), run `pnpm --filter @ax/routines build` (`tsc -b`, which rebuilds the contract through its reference and type-checks routines' source) before any routines or channel-web test that uses the new schemas. This is TASK-952's rule (`docs/plans/2026-10-24-task-952-report-reading-trend-plan.md:85-88`).
- **Postgres-backed suites:**
  - every `@ax/routines` test that uses `store-fixture.ts`, `support/routine-harness.ts` or `support/check-in.ts`: this card's `steps-store`, `set-steps-store`, `set-steps`, `canary` and the rest of the package;
  - six `@ax/channel-web` server files: `routes-chat`, `stream-e2e`, `connections-mirror`, `routes-workspace-approval-actor`, `routes-attachments` and `acceptance-e2e` (`src/__tests__/server/*.test.ts`); none is a file this card edits;
  - `@ax/routines-admin-routes`, for the final gate only.
  - `@ax/routines-contract` needs none.
  - Check Docker with `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock timeout 15 docker info`, and export that `DOCKER_HOST` for the run.
  - If it hangs, don't restart OrbStack. Run routines on the shim the builder already made for this worktree: `pnpm --filter @ax/routines exec vitest run --config /private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/386b12a8-02d6-45fd-a50d-1e78eb04cac6/scratchpad/TASK-949/pg/vitest.local-pg.config.mjs [<path>]`, after `/opt/homebrew/opt/postgresql@17/bin/pg_isready -h 127.0.0.1 -p 55439` answers.
  - The shim covers routines only. With Docker down, run channel-web's whole-suite steps with the six Postgres files excluded, then name them in the handoff (TASK-441's precedent, `.claude/memory/patterns/2026-09-19-TASK-441.md`): `pnpm --filter @ax/channel-web exec vitest run --exclude src/__tests__/server/routes-chat.test.ts --exclude src/__tests__/server/stream-e2e.test.ts --exclude src/__tests__/server/connections-mirror.test.ts --exclude src/__tests__/server/routes-workspace-approval-actor.test.ts --exclude src/__tests__/server/routes-attachments.test.ts --exclude src/__tests__/server/acceptance-e2e.test.ts`.
  - Record each package's baseline (files and tests) before Task 1. The shim is Postgres 17, not CI's 16, so name every suite that ran only on the shim, or not at all, in the handoff.
- **What type-checks:** channel-web type-checks its test files; `@ax/routines` and `@ax/routines-contract` don't (memory `feedback_tsc_excludes_test_files`). In routines, a stale call in a test fails only at run time, so run the whole file. In channel-web, `pnpm --filter @ax/channel-web exec tsc --build` finds every fixture a type change breaks.
- **A task's test file carries only the names that task's tests use.** `@typescript-eslint/no-unused-vars` fails test files too (`.claude/memory/mistakes/2026-10-24-TASK-948.md`).
- **Imports:** channel-web `src/lib/*.ts` modules import siblings as relative `./x.js`, never `@/lib/...`.
- **Scope:** one new service hook (`routines:set-steps`), one new route, no new tool, IPC action, dependency or shadcn component. `Checkbox`, `DropdownMenu`, `Input` and `Field`/`FieldError` are installed (`packages/channel-web/src/components/ui/`). Task 6 invokes the `shadcn` and `ux-design` skills.
- **Run the tasks one at a time** in this worktree: channel-web's `tsc --build` compiles routines and the contract, so two builds at once collide.
- **Memory rows** go to shards (`.claude/memory/<kind>/2026-10-24-TASK-949.md`), never a root archive. The planner wrote this plan and the decisions shard; commit both before Task 1, because `pnpm test:scripts` checks every path a shard cites.
- **Final gate:** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

## Review Focus

Each line is pinned by a test in the task named.

1. **The agent's check-in reports while the person changes a step** (either one waits on the other's row lock). Expected: both changes land, and neither writer overwrites the other's. → Task 2, "a person's change and a report that wait on each other both land, in either order".
2. **A retry after a lost answer** (the same request id, the same change). Expected: nothing applies twice, and the answer is the steps as they are now. The same id with a different change is refused. → Task 2, "the same request again changes nothing and answers the steps as they are now", and Task 6, "keeps the request id across an unconfirmed failure and drops it after a refusal".
3. **A person rewords an agent step, and the next check-in tries to reword it back.** Expected: the agent's edit is skipped, the step reads "(the person wrote this)", and the page drops "added by {agent}". → Task 1 (helper), Task 3 (canary), Task 6 (the edit-note line).
4. **A row holding an entry this version can't read** (a rollback or a hand edit), or a value that isn't a list. Expected: a change by either writer keeps the entry, and a non-list is never overwritten. → Task 1, both pure and Postgres tests.
5. **A re-read that started before a change lands after it** (the 10-second poll after Check now, whose last read may be this one). Expected: the change stays on screen, the rest of the re-read is shown, and one more quiet read brings the list up to date. → Task 5, "a read that started before replaceSteps keeps the replaced steps" and "a read whose steps it kept asks for one more quiet read".

## Hook surface and boundary review

New service hook `routines:set-steps`. It's neither a tool nor an IPC action. For the PR description:

- **Alternate impl:** an external tracker's checklist API (Asana subtasks, Todoist sub-tasks) behind the same ops, or a SQLite store with the same JSON column.
- **Payload names that might leak:** none. `ops`, `op`, `steps`, `skipped`, `addedBy` and `requestId` are domain or house words; step ids are opaque.
- **Subscriber risk:** none, it's a service. A consumer must not assume an op applied: `skipped` says how many didn't.
- **Wire surface:** not an IPC action. The schemas live in `@ax/routines-contract` with the other routine services.

`receiptTransaction`'s `onReplay` changes shape, but it's private to `store.ts`, so no boundary review is needed.

## Security checklist

Flagged tasks: 1 (who may change whose words), 2 (person text written under a lock, receipts), 3 (the owner gate, the brief), 4 (the HTTP write route), 6 (person and agent text in inputs and attributes). Task 6's last step runs the `security-checklist` skill over the whole diff, and the PR's block starts from:

```
## Security review
- Sandbox: N/A: no filesystem path, process, network, env or handle is added or widened. One new owner-only service (routines:set-steps, neither a tool nor an IPC action, so no model can call it) and one new route behind auth:require-user, agents:resolve and the global CSRF guard. Ownership is decided in the store under the routine's row lock.
- Injection: a person's step text reaches the model in later check-in messages. The contract screens it before anything runs (one line, 1-200 UTF-16 units, no invisible or broken characters), at most 50 steps. It is quoted line by line and labelled "(the person wrote this)" from host-set addedBy, which no op can set. The get-done brief now names that label as the person's words (fixed text, no step text). A person may reword or delete any step, so injected agent text is clearable (design §7). A person's rewording makes a step theirs, and the agent can then only tick it. Receipts keep a count only; the log line carries ids and counts; a failed write's error names only the routine and the SQLSTATE. The page draws every step as a React text child, the route fences it as the task page does, and no attribute is built from step text.
- Supply chain: N/A: no package.json or lockfile change; the shadcn primitives used are already installed.
```

## Rollback

No schema change. Code from before this card ignores `'set-steps'` receipts, since it never looks one up. It reads `addedBy: 'person'` steps, because TASK-948 already knows that author. Once rolled back, its `recordReport` again drops unreadable entries on a write that applies a change (948's behaviour), so roll forward rather than back if a later version wrote such entries. Nothing from Agent Tasks PR 1–3 is deployed.

## Tiers and order

| Task | Tier | Needs | security-checklist |
|---|---|---|---|
| 1 Step rules for two writers (pure helper + `recordReport`) | sensitive | — | flagged |
| 2 Store: `setSteps` (receipt, replay, lock, refusals) | sensitive | 1 | flagged |
| 3 `routines:set-steps` end to end in routines (contract, service, brief, canary) | sensitive | 2 | flagged |
| 4 channel-web server: the steps route and the manifest | sensitive | 3 | flagged |
| 5 channel-web client data: `setTaskSteps` and `replaceSteps` | integration | 4 | — |
| 6 channel-web client: editable steps on the task page | sensitive | 5 | flagged (runs the skill) |
| 7 Docs: the design says what was built | mechanical | 6 | — |

---

### Task 1: Step rules for two writers [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/steps.ts` (whole module: `StoredStepSchema` doc 6-16, `storedSteps` 24-43, `applyStepOps` 63-114)
- Modify: `packages/routines/src/store.ts:844-850` and `:870-876` (`recordReport`'s step lines), `:49-62` (its interface doc)
- Test: `packages/routines/src/__tests__/stored-steps.test.ts` (pure), `packages/routines/src/__tests__/steps-store.test.ts` (Postgres)

**Interfaces:**
- Produces (all in `steps.ts`, used by Task 2):
  - `applyStepOps(current: readonly StoredStep[], ops: readonly RoutineStepOp[], actor: RoutineStepAuthor, newId?: (taken: ReadonlySet<string>) => string): { steps: StoredStep[]; applied: number; skipped: number }`
  - `readStoredSteps(value: unknown): { steps: StoredStep[]; unread: unknown[] } | null`. Null when `value` isn't a list.
  - `storedSteps(value: unknown): StoredStep[]`, unchanged behaviour: `readStoredSteps(value)?.steps ?? []`.
  - `export type StepsChange = { steps: StoredStep[]; applied: number; skipped: number; write: unknown[] | null }`
  - `changeStoredSteps(value: unknown, ops: readonly RoutineStepOp[], actor: RoutineStepAuthor, newId?: (taken: ReadonlySet<string>) => string): StepsChange`

- [ ] **Step 1: Update the existing pure tests, then write the failing new ones** in `stored-steps.test.ts`.
  - Every existing `applyStepOps(list, ops)` call gains `'agent'` third; `ids(...)` moves to fourth. The expectations stay the same.
  - New `describe('applyStepOps as the person (TASK-949)')`:
    - `add writes the person's step, and follows the cap and the duplicate rule`:
      - `applyStepOps([], [{ op: 'add', text: 'Ask Dana' }], 'person', ids('s000001')).steps` equals `[step('s000001', 'Ask Dana', { addedBy: 'person' })]`;
      - an add of text already listed, or onto a full list of `ROUTINE_STEPS_MAX`, is skipped.
    - `rewords or removes any step, and a reworded step becomes the person's`:
      - start from an agent step A and a person step P;
      - ops `[{ op: 'edit', id: A.id, text: 'Email the five VIPs' }, { op: 'remove', id: P.id }]` → `{ steps: [{ ...A, text: 'Email the five VIPs', addedBy: 'person' }], applied: 2, skipped: 0 }`.
    - `an edit that leaves the text as it is changes nothing`: `[{ op: 'edit', id: A.id, text: A.text }]` → `steps` equals `[A]` (still `addedBy: 'agent'`), `applied: 1`.
    - `ticks and unticks any step`: tick and untick both apply to A and to P, and neither changes `addedBy`.
    - `only the exact word 'person' gets a person's reach`: with `actor` passed as `'robot'`, an edit of P is skipped and an add writes `addedBy: 'agent'`. (Routines' tests aren't type-checked, so this pins fail-closed at run time; cast the actor `as RoutineStepAuthor`.)
  - New `describe('readStoredSteps and changeStoredSteps (TASK-949)')`:
    - `readStoredSteps keeps what it can't read and drops a duplicate it never shows`:
      - input `[step('s000001','A'), { ...step('s000002','B'), addedBy: 'app' }, 7, step('s000001','dup')]`;
      - → `{ steps: [step('s000001','A')], unread: [{ ...step('s000002','B'), addedBy: 'app' }, 7] }`;
      - `readStoredSteps({ not: 'a list' })` and `readStoredSteps(null)` are `null`.
    - `a change writes the steps it read, as changed, then every entry it couldn't read`:
      - `changeStoredSteps(thatInput, [{ op: 'tick', id: 's000001' }], 'person').write` equals `[step('s000001','A',{ done: true }), { ...step('s000002','B'), addedBy: 'app' }, 7]`;
      - `steps` is the readable list only.
    - `nothing applied writes nothing`: every op skipped → `write: null`.
    - `a new step never takes the id of an entry it couldn't read`: `changeStoredSteps([{ ...step('sabcdef','x'), addedBy: 'app' }], [{ op: 'add', text: 'New' }], 'person', taken => (taken.has('sabcdef') ? 'snew001' : 'sabcdef'))` → the new step's id is `'snew001'`.
    - `a value that isn't a list skips every change and writes nothing`: `changeStoredSteps('steps', [{ op: 'add', text: 'X' }], 'person')` → `{ steps: [], applied: 0, skipped: 1, write: null }`.
    - `leaves the value it was given as it was`: freeze the input array and its entries, run a change, and the input is deep-equal to before.

- [ ] **Step 2: Run them and see them fail**
  Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/stored-steps.test.ts`
  Expected: FAIL. `readStoredSteps` and `changeStoredSteps` aren't exported, and the person cases don't apply.

- [ ] **Step 3: Implement in `steps.ts`.** The one-op rules:

```ts
// add: the cap and the duplicate rule as before; the author is the actor's, failing toward the agent.
steps.push({ id: newId(new Set(steps.map(step => step.id))), text: op.text, done: op.done ?? false, addedBy: actor === 'person' ? 'person' : 'agent' });
// edit / remove: only the exact 'person' may touch a step the agent didn't add.
if (actor !== 'person' && step.addedBy !== 'agent') return false;
if (op.op === 'remove') { steps.splice(steps.indexOf(step), 1); return true; }
// A person's words make the step theirs; an edit that changes nothing relabels nothing.
if (op.text !== step.text) { step.text = op.text; if (actor === 'person') step.addedBy = 'person'; }
return true;
```

  - `readStoredSteps` is `storedSteps`' loop: an entry that fails `StoredStepSchema` goes to `unread` in order, and one with an id already read is dropped.
  - `changeStoredSteps`: when `readStoredSteps` is `null`, answer `{ steps: [], applied: 0, skipped: ops.length, write: null }`.
  - Otherwise run `applyStepOps(read.steps, ops, actor, taken => newId(new Set([...taken, ...unreadIds])))`, where `unreadIds` are the string `id`s among the unread entries. A new step never takes the id of an entry kept after it: a later version reads first-wins and would drop the kept one.
  - `write` is `applied > 0 ? [...changes.steps, ...read.unread] : null`.
  - Rewrite the docs that this makes false: `applyStepOps`' "No change can say who added a step: `add` always writes 'agent'" becomes "the actor says"; it lists what each actor may do. Add a sentence to `StoredStepSchema`'s rollback note: a writer keeps an entry this schema refuses, so its step survives a write made during a rollback.

- [ ] **Step 4: Run the pure tests and see them pass**
  Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/stored-steps.test.ts`
  Expected: PASS.

- [ ] **Step 5: Write the failing Postgres tests** in `steps-store.test.ts`'s `"a report's step changes (TASK-948)"` describe (same helpers):
  - `a report that applies a change keeps the stored entries this version can't read (TASK-949)`:
    - `setSteps(task.routineId, [step('s000001','Export every article'), { ...step('s000002','From later'), addedBy: 'app' }])`;
    - a report ticks `s000001` → `{ outcome: 'recorded', applied: 1, skipped: 0 }`;
    - `stepsColumn` equals `[step('s000001','Export every article',{ done: true }), { ...step('s000002','From later'), addedBy: 'app' }]`.
  - `a report against a checklist that isn't a list skips every change and leaves it (TASK-949)`:
    - `setSteps(task.routineId, { not: 'a list' })`;
    - a report adds a step → `{ outcome: 'recorded', applied: 0, skipped: 1 }`;
    - `stepsColumn` still equals `{ not: 'a list' }`, and the report's status landed.
  - Fix the file's header comment (lines 8-9, "edited only by its check-ins' reports") to say "edited by its check-ins' reports and, from TASK-949, by its owner".

- [ ] **Step 6: Run and see them fail.** Run the file (Postgres; see Global Constraints). Expected: the two new tests FAIL. The unreadable entry is dropped, and the non-list is overwritten.

- [ ] **Step 7: Switch `recordReport` to `changeStoredSteps`.**
  - `changes` becomes `input.steps === undefined ? null : definition.kind === 'get-done' ? changeStoredSteps(definition.task_steps, input.steps, 'agent') : { steps: [], applied: 0, skipped: input.steps.length, write: null }`.
  - The write is guarded by `changes !== null && changes.write !== null` and stores `JSON.stringify(changes.write)`.
  - `store.ts` imports `changeStoredSteps` and `storedSteps` from `./steps.js` and no longer `applyStepOps`, or lint fails the unused import. `rowToRoutine` still uses `storedSteps`.
  - Fix the interface doc at `store.ts:49-62`. "The one writer of a task's report, and (TASK-948) of a get-done task's checklist" becomes "the one writer of a task's report, and one of the two writers of a get-done task's checklist (TASK-949: `setSteps` is the other; both keep entries this version can't read)".

- [ ] **Step 8: Run the whole routines package.**
  Run: `pnpm --filter @ax/routines test` (or the shim config without a path).
  Expected: PASS. 948's "a report whose every change is skipped writes no checklist…" still passes unchanged.

- [ ] **Step 9: Commit**

```bash
git add packages/routines/src/steps.ts packages/routines/src/store.ts packages/routines/src/__tests__/stored-steps.test.ts packages/routines/src/__tests__/steps-store.test.ts
git commit -m "feat(routines): step changes say who makes them, and both writers keep entries they can't read (TASK-949)"
```

---

### Task 2: Store: `setSteps` [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/store.ts`
  - the `RoutinesStore` interface (add `setSteps` after `addReply`, `:69-80`);
  - `parseReceipt` (`:484-489`);
  - `receiptCopy`'s doc (`:490-505`);
  - `receiptTransaction` (`:536-559`);
  - `acceptDispatch`'s `onReplay` (`:694`);
  - the implementation, after `addReply`.
- Modify: `packages/routines/src/steps.ts` (add `StepsReceiptSchema`)
- Modify: `packages/routines/src/types.ts` (add `SetStepsResult`)
- Create: `packages/routines/src/__tests__/set-steps-store.test.ts` (Postgres)

**Interfaces:**
- Consumes: `changeStoredSteps`, `storedSteps` (Task 1).
- Produces (used by Task 3):
  - `types.ts`: `export type SetStepsResult = { steps: StoredStep[]; skipped: number } | 'not-found' | 'forbidden';`
  - `RoutinesStore.setSteps(input: RoutineKey & { actorUserId: string; requestId: string; ops: readonly RoutineStepOp[] }): Promise<SetStepsResult>`. A retired agent throws `SafeToolError('not-found', 'routineId')` (`receiptTransaction`'s rule), and the same `requestId` with other ops throws `SafeToolError('request-conflict', 'requestId')`.
  - `steps.ts`: `export const StepsReceiptSchema = z.object({ skipped: z.number().int().min(0) }).strict();`

- [ ] **Step 1: Write the failing tests** in the new `set-steps-store.test.ts`.
  - Copy only the helpers these tests use from `steps-store.test.ts`: `fixture`, `GET_DONE`, `taskInput`, `step`, the raw `setSteps` writer (rename it `writeSteps`, since `setSteps` is now the store's), `stepsColumn`, `waitsOn`, and `bound`/`record` for the report cases. Add `receipts = () => SELECT operation, request_id, result FROM routines_v1_requests WHERE operation = 'set-steps'`.
  - `const change = (requestId: string, ops: RoutineStepOp[], actorUserId = 'owner') => f.store.setSteps({ agentId: 'a', routineId: task.routineId, actorUserId, requestId, ops })`.
  - The tests:
  - `an owner's add is the person's, and the answer is the list as it is now`:
    - `change('r1', [{ op: 'add', text: 'Ask Dana to review billing' }])` → `{ steps: [{ id: /^s[0-9a-z]{6}$/, text: 'Ask Dana to review billing', done: false, addedBy: 'person' }], skipped: 0 }`;
    - `stepsColumn` equals the same list.
  - `a person may reword and remove the agent's steps, and a reworded step is theirs`:
    - `writeSteps` two agent steps;
    - edit the first and remove the second → `skipped: 0`, and the column holds one step with the new text and `addedBy: 'person'`.
  - `a change to a step that's gone, an add past 50, and an add already listed are skipped and counted`:
    - on a full list of `ROUTINE_STEPS_MAX`, ops tick `'sgone00'`, add `'One more'`, add `'Step 1'` → `skipped: 3`;
    - the column is unchanged.
  - `only the owner may: someone else is forbidden, and nothing is written or kept`:
    - `change('r1', [add], 'teammate')` → `'forbidden'`;
    - the column is `[]`, and `receipts()` is `[]`.
  - `a stay-on-top task, a repeat routine and a missing one are not-found`:
    - create one of each (`RoutineDefinitionSchema.parse` with `kind: 'stay-on-top'`/`goodWhen`, and a plain repeat);
    - a deleted routine id too;
    - each answers `'not-found'`, and nothing is kept.
  - `a retired agent is not-found`:
    - `await f.store.purgeAgent('a')`;
    - `change(...)` rejects with `{ toolCode: 'not-found' }`.
  - `a change never moves the routine's revision, spec hash or updated time`: read `revision`, `spec_hash` and `updated_at` with SQL before and after a change; they're equal.
  - `the same request again changes nothing and answers the steps as they are now`:
    - `change('r1', [add 'X'])`;
    - then an agent report ticks X (`bound`/`record`);
    - then `change('r1', [add 'X'])` again → `{ steps: [{ …X, done: true }], skipped: 0 }`;
    - the column holds one X.
  - `the receipt keeps the count and no step text`:
    - after `change('r1', [add 'SECRET step'])`, `receipts()` equals `[{ operation: 'set-steps', request_id: 'r1', result: { skipped: 0 } }]`;
    - `JSON.stringify(await receipts())` doesn't contain `SECRET`.
  - `the same request id with other changes is refused`: `change('r1', [add 'X'])` then `change('r1', [add 'Y'])` rejects with `{ toolCode: 'request-conflict' }`.
  - `a replay checks the owner again`:
    - after `change('r1', …)`, set the row's `owner_user_id` to `'someone-else'` with SQL;
    - the replay answers `'forbidden'`;
    - after deleting the routine (`deleteAuthored`) a replay answers `'not-found'`.
  - `a person's change and a report that wait on each other both land, in either order`, one test with two cases in the shape of 948's "a report that waits on the task's row lock adds to the steps written while it waited" (`steps-store.test.ts:176-195`):
    - (a) a held `FOR UPDATE` on the row; `change('r1', [{ op: 'edit', id: B, text: 'B2' }])` waits (`waitsOn`); inside the hold, `writeSteps` the agent's tick of A; release → the answer and the column show A ticked and B reworded;
    - (b) the same hold; `record(run, onTrack, [{ op: 'tick', id: 'A' }])` waits; inside the hold, `writeSteps` the person's B2; release → both land.
  - `a change keeps the stored entries this version can't read`: `writeSteps([stepA, { ...stepB, addedBy: 'app' }])`; tick A → the column keeps the `'app'` entry after A.
  - `a checklist write that fails names only the routine and the SQLSTATE`:
    - 948's temporary `CHECK (jsonb_array_length(task_steps) = 0)` pattern (`steps-store.test.ts:206-219`);
    - an add of `'SECRET step text'` rejects with message `Could not save the steps for routine ${task.routineId} (SQLSTATE 23514).`;
    - `inspect(failure)` doesn't contain `SECRET`;
    - `receipts()` is `[]`.

- [ ] **Step 2: Run and see them fail**
  Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/set-steps-store.test.ts` (Postgres)
  Expected: FAIL, `f.store.setSteps is not a function`.

- [ ] **Step 3: Give `receiptTransaction`'s replay the transaction.**
  - The signature becomes `onReplay?: (trx: Transaction<RoutinesDatabase>) => Promise<void>`.
  - The replay branch becomes `if (receipt.result !== null) { await onReplay?.(trx); return parseReceipt(key.operation, receipt.result) as T; }`.
  - `acceptDispatch` passes `async () => { replayed = true; }`.
  - `parseReceipt` gains `if (operation === 'set-steps') return StepsReceiptSchema.parse(value);`, before the throw.
  - `receiptCopy`'s doc gains: "`set-steps`' result is its count alone (`{ skipped }`), stored as it is: the steps never reach the receipt (TASK-949)."

- [ ] **Step 4: Implement `setSteps`** after `addReply`, with its interface doc. The doc covers: owner only under the fence and the row lock; missing or not get-done is `not-found`; someone else's is `forbidden`; the changes apply as the person; the receipt and replay behaviour; never moves revision, spec hash or updated time; a retired agent throws `not-found`.

```ts
/** TASK-949. Why setSteps wrote nothing: thrown inside the receipt's transaction so the request row rolls back with it. */
class StepsRefused extends Error { constructor(readonly reason: 'not-found' | 'forbidden') { super(reason); } }

async setSteps(input) {
  // receiptTransaction's order: the agent fence, the request row, then (here) the routine's row.
  // recordReport takes the fence, the run's row, then the routine's row, so this adds no deadlock.
  const locked = async (trx: Transaction<RoutinesDatabase>) => {
    const row = await trx.selectFrom('routines_v1_definitions').select(['kind', 'owner_user_id', 'task_steps'])
      .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).forUpdate().executeTakeFirst();
    // An explicit allowlist: only get-done has a checklist.
    if (!row || row.kind !== 'get-done') throw new StepsRefused('not-found');
    if (row.owner_user_id !== input.actorUserId) throw new StepsRefused('forbidden');
    return row;
  };
  let steps: StoredStep[] = [];
  try {
    const { skipped } = await receiptTransaction(db, operationKey(input, 'set-steps', inputHash({ agentId: input.agentId, routineId: input.routineId, ops: input.ops })), async trx => {
      const row = await locked(trx);
      const changes = changeStoredSteps(row.task_steps, input.ops, 'person');
      if (changes.write !== null) {
        try {
          // No revision, spec_hash or updated_at: steps are task state, so a change can't turn the page's next Check now into a conflict.
          await trx.updateTable('routines_v1_definitions').set({ task_steps: JSON.stringify(changes.write) })
            .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).execute();
        } catch (error) { throw stepsWriteError(input.routineId, error); }
      }
      steps = changes.steps;
      // The receipt keeps this and nothing else (receiptCopy, parseReceipt).
      return { skipped: changes.skipped };
    }, async trx => { steps = storedSteps((await locked(trx)).task_steps); });
    return { steps, skipped };
  } catch (error) {
    if (error instanceof StepsRefused) return error.reason;
    throw error;
  }
}
```

  - `stepsWriteError(routineId, error)` is `reportWriteError`'s sibling, with the message `Could not save the steps for routine ${routineId}${code === null ? '' : ` (SQLSTATE ${code})`}.`. Pull the SQLSTATE read into one `sqlState(error): string | null` that both use.
  - `reportWriteError`'s message is pinned by 948's test, so keep it byte for byte.
  - If TASK-950 merged first (Global Constraints), `locked` also selects its done column and throws `new StepsRefused('forbidden')` for a done task, after the owner check. Add a test beside "only the owner may".

- [ ] **Step 5: Run the file and see it pass.** Expected: PASS.

- [ ] **Step 6: Run the whole routines package.** `acceptDispatch`'s replay tests (`dispatch.test.ts` and others) must still pass. Expected: PASS, with the baseline plus the new tests.

- [ ] **Step 7: Commit**

```bash
git add packages/routines/src/store.ts packages/routines/src/steps.ts packages/routines/src/types.ts packages/routines/src/__tests__/set-steps-store.test.ts
git commit -m "feat(routines): setSteps, a person's step changes under the row lock with a count-only receipt (TASK-949)"
```

---

### Task 3: `routines:set-steps`, end to end in routines [tier: sensitive]

**Files:**
- Modify: `packages/routines-contract/src/services.ts`
  - add the schemas and types after `RoutineRecentRepliesOutputSchema` (`:128`);
  - fix the doc at `:49` ("the one writer of a task's state" becomes "the one writer of a task's report").
- Modify: `packages/routines-contract/src/definition.ts:579-601, 635-650`. Docs only:
  - `RoutineStepOpSchema`: "as the agent sends it in a report, or a person sends it from the task page (`routines:set-steps`, TASK-949)";
  - `RoutineReportStepsSchema`: "a list of changes, applied in order: a report's, and a person's";
  - the block comment's "TASK-949's box shows them" becomes "the task page's step editor shows them (TASK-949)".
- Create: `packages/routines-contract/src/__tests__/set-steps.test.ts`
- Modify: `packages/routines/src/services.ts` (`ROUTINE_SERVICES` `:11-16`; register after `recent-replies`)
- Modify: `packages/routines/src/brief.ts:44-66, 86-97`
- Test: `packages/routines/src/__tests__/return-schemas.test.ts:139-148`, new `packages/routines/src/__tests__/set-steps.test.ts` (Postgres), `packages/routines/src/__tests__/brief.test.ts:90-131`, `packages/routines/src/__tests__/canary.test.ts:823-880`

**Interfaces:**
- Consumes: `RoutinesStore.setSteps`, `SetStepsResult` (Task 2).
- Produces (used by Task 4 and Task 6):
  - `RoutineSetStepsInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema, ops: RoutineReportStepsSchema }).strict()`. `RoutineReportStepsSchema` is already `z.array(RoutineStepOpSchema).min(1).max(ROUTINE_STEPS_MAX)`: one rule for the agent's and the person's lists.
  - `RoutineSetStepsOutputSchema = z.object({ steps: z.array(RoutineStepViewSchema), skipped: z.number().int().min(0) }).strict()`
  - types `RoutineSetStepsInput`, `RoutineSetStepsOutput`
  - hook `routines:set-steps`

- [ ] **Step 1: Write the failing contract test** `set-steps.test.ts`, in the shape of `clear-notes.test.ts`:
  - `takes a routine's key, a request id and 1 to 50 changes, strictly`:
    - parses `{ agentId: 'a', routineId: 'r', requestId: 'q', ops: [{ op: 'add', text: 'Ask Dana' }] }`;
    - refuses `ops: []`, 51 ops, an extra top-level key (`steps`), and an op with `addedBy`;
    - refuses a blank text, a 201-character text and a zero-width space, the first refusal's message being exactly `'Write the step first.'`, `'A step can be up to 200 characters.'` and `'A step can’t contain invisible characters (…)'` (match the last with `toMatch(/^A step can’t contain invisible characters/)`).
  - `answers the steps and a count, strictly`: parses `{ steps: [{ id: 's1', text: 'x', done: false, addedBy: 'person' }], skipped: 0 }`, and refuses `skipped: -1`, `skipped: 1.5` and an extra key.

- [ ] **Step 2: Run it and see it fail**
  Run: `pnpm --filter @ax/routines-contract exec vitest run src/__tests__/set-steps.test.ts`
  Expected: FAIL (no export).

- [ ] **Step 3: Add the schemas, types and doc** to `services.ts`. The doc comment, in the `routines:reply` style:

```ts
/**
 * `routines:set-steps` (TASK-949): a task's owner changes its steps on its
 * task page: adds one, ticks or unticks one, rewords or removes one. Only the
 * routine's owner may, whether or not they still manage the agent's tasks, and
 * only on a "get-done" task. `ops` are the changes the agent's report sends,
 * applied in order, by id: a person may reword or remove any step, the agent's
 * included, and their `add`, like a step whose words they change, is
 * `addedBy: 'person'`. A change to a step that's gone, an `add` past 50 and an
 * `add` whose text is already listed are skipped and counted (`skipped`);
 * `steps` is the list after them. The same `requestId` again changes nothing
 * and answers with the steps as they are now and the first try's count. It
 * never changes the routine's revision. Each text is checked by
 * `RoutineStepTextSchema`, whose messages the person reads. Neither a tool nor
 * an IPC action, so no model can call it.
 */
```

- [ ] **Step 4: Run the contract test and see it pass, then build.** Expected: PASS. Then run `pnpm --filter @ax/routines build` (Global Constraints, built packages), or routines' tests still see the old `dist/`, where `C.RoutineSetStepsInputSchema` is `undefined`, and every later step fails for that reason alone.

- [ ] **Step 5: Write the failing service tests.**
  - `return-schemas.test.ts`:
    - `toHaveLength(20)` becomes `21` (22 if TASK-951 merged first);
    - add `expect(ROUTINE_SERVICES).toContain('routines:set-steps')`;
    - add the parse of an answer, plus a refusal of one carrying `text` at the top level.
  - New `set-steps.test.ts` over the real store. Copy `reply.test.ts`'s `services()` builder (`:55-84`): an `agents:resolve` that refuses users outside `reach` and records order, a stubbed `agents:can-manage-routines`, and `logged()` contexts. Then:
  - `the owner adds a step, and it is theirs` → `{ steps: [{ …, addedBy: 'person' }], skipped: 0 }`.
  - `only the owner may, whether or not they manage the agent's tasks`:
    - the owner with `allowed: false` succeeds;
    - `'teammate'` (reachable, allowed) rejects `{ toolCode: 'forbidden' }`.
  - `someone agents:resolve refuses is refused before the store is asked`:
    - rejects with the resolve's `PluginError`;
    - `order` holds `agents:resolve` only (wrap `setSteps` in the swapped store to record it).
  - `a stay-on-top task and a missing one are not-found` → `{ toolCode: 'not-found' }`.
  - `a refused change is a validation error`: blank text, 51 ops, an op with `addedBy` → `{ toolCode: 'validation' }`, and the store was never called.
  - `the answer carries each step's four fields and nothing else`: `Object.keys(answer.steps[0]).sort()` equals `['addedBy','done','id','text']`.
  - `logs one line per change, ids and counts only`:
    - KEYS `['level','ts','reqId','msg','agentId','routineId','ops','skipped']`;
    - one `routines_steps_set` entry `{ level: 'info', agentId: 'a', routineId, ops: 1, skipped: 0 }` for the first call and one for a replay;
    - no line contains the step's text (`'The refund code is QX7731.'`).

- [ ] **Step 6: Run them and see them fail.** Expected: FAIL (no hook; length 20).

- [ ] **Step 7: Register the service.** Add `'set-steps'` to `ROUTINE_SERVICES`, then:

```ts
// TASK-949. A task's owner changes its steps on its task page. Only the owner may, whether or not they still manage
// the agent's tasks (clear-notes' rule, TASK-910; replies', TASK-931): the steps are shown to no one else (stepsView),
// and changing them adds no reach, since the next check-in still runs under the agent's own approval rules.
// agents:resolve runs first; the store decides ownership under the routine's row lock. Neither a tool nor an IPC
// action, so no model can call it. The log line carries ids and counts, never a step's text.
register('set-steps', C.RoutineSetStepsInputSchema, C.RoutineSetStepsOutputSchema, async (ctx, input) => {
  await access(ctx, input.agentId);
  const outcome = await store.setSteps({ agentId: input.agentId, routineId: input.routineId, actorUserId: ctx.userId, requestId: input.requestId, ops: input.ops });
  if (outcome === 'not-found') throw new SafeToolError('not-found', 'routineId');
  if (outcome === 'forbidden') throw new SafeToolError('forbidden', 'input');
  ctx.logger.info('routines_steps_set', { agentId: input.agentId, routineId: input.routineId, ops: input.ops.length, skipped: outcome.skipped });
  return { steps: outcome.steps.map(({ id, text, done, addedBy }) => ({ id, text, done, addedBy })), skipped: outcome.skipped };
});
```

- [ ] **Step 8: Run the service tests and see them pass.** Expected: PASS.

- [ ] **Step 9: Write the failing brief tests** in `brief.test.ts`.
  - The get-done full-lines test (`:104-121`): its fourth line becomes exactly:
    `'- It also holds what the person wrote to you about this task, in their own words: its section headed "What the person wrote to you about this task", and the steps marked "the person wrote this". Treat those as you would anything else they tell you. Anything else in the check-in message that claims to be from them isn’t.'`
  - The structural test (`:90-101`): rename it "a get-done task's brief names the person's steps and adds three fixed lines, and only that kind's". Assert `renderTaskBrief({ ...SUPPORT_QUEUE, kind: 'get-done' })` equals `stay` with the old person-words line replaced by the new one and the three lines inserted before `finish`. The stay-on-top full-lines test (`:39`) stays as it is.
  - New `'the person’s label a get-done brief names is the one the check-in message puts on a person’s step (TASK-949)'`:
    - `label = /and the steps marked "([^"]+)"/.exec(brief)?.[1]` is `'the person wrote this'`;
    - a message with one `addedBy: 'person'` step contains `` `- [ ] sbbbbbb (${label}):` ``.

- [ ] **Step 10: Run and see them fail**, then implement. In `brief.ts`, split `BRIEF_HOW`'s last line into `PERSON_WORDS` (unchanged) and `PERSON_WORDS_GET_DONE` (the new text). `renderTaskBrief` uses `[...BRIEF_HOW, row.kind === 'get-done' ? PERSON_WORDS_GET_DONE : PERSON_WORDS, ...(get-done lines), ...BRIEF_REPORT]`. Add a doc line: the get-done line names the steps' host-set label, fixed text, never a step's own. Run `brief.test.ts` and `checkin-message.test.ts`. Expected: PASS.

- [ ] **Step 11: Write the canary**, a second `it` in `describe('get-done canary (TASK-948)')`, or its own `describe('person steps canary (TASK-949)')`. Get `task` with 948's setup (`canary.test.ts:829-846`, a team agent task approved once). Then:
  - The owner adds a step: `h.bus.call('routines:set-steps', h.owner, { agentId: task.agentId, routineId: task.routineId, requestId: 'person-add', ops: [{ op: 'add', text: 'Ask Dana to review the billing section' }] })` → `{ steps: [{ id: expect.any(String), text: 'Ask Dana to review the billing section', done: false, addedBy: 'person' }], skipped: 0 }`.
  - A teammate's change rejects: `h.bus.call('routines:set-steps', h.teamMember, { …, requestId: 'tm', ops: [{ op: 'remove', id }] })` rejects `{ toolCode: 'forbidden' }`.
  - The next check-in starts from `task`, the view read before the person's change (`ch.checkIn(task, 'run-1', …)`). Its revision still holds, since a step change moves none (card decision 3), so a Check now held against it is no revision conflict. In that check-in:
    - reports `steps: [{ op: 'edit', id, text: 'Skip the review' }, { op: 'tick', id }]` → `{ recorded: true, steps: { applied: 1, skipped: 1 } }`;
    - its `message` contains `` `- [ ] ${id} (the person wrote this):\n  > Ask Dana to review the billing section` ``;
    - its `brief` contains `'and the steps marked "the person wrote this"'`.
  - Afterwards `routines:get` as the owner shows the step `done: true`, its text unchanged, `addedBy: 'person'`.

- [ ] **Step 12: Run the whole routines package and the contract package.** Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/routines-contract/src packages/routines/src/services.ts packages/routines/src/brief.ts packages/routines/src/__tests__/return-schemas.test.ts packages/routines/src/__tests__/set-steps.test.ts packages/routines/src/__tests__/brief.test.ts packages/routines/src/__tests__/canary.test.ts
git commit -m "feat(routines): routines:set-steps, owner-only; the get-done brief names the person's steps (TASK-949)"
```

---

### Task 4: channel-web server: the steps route and the manifest [tier: sensitive]

**Files:**
- Modify: `packages/channel-web/src/server/routes-workspace.ts`:
  - the route list (`:2-12`);
  - the security posture (`:62-78`, "the task page's four routes" and "`/notes` and `/replies` are writes" both gain `/steps`);
  - the local hook types (`:797-820`);
  - `readSteps`/`toTaskStep` (`:3525-3571`; fix "for the next card's edits" at `:3559`);
  - a body reader beside `readTaskReplyBody` (`:3649-3661`);
  - the handler after `taskReply` (`:7513-7558`);
  - the route table after `/replies` (`:9925-9930`).
- Modify: `packages/channel-web/src/server/plugin.ts` (manifest comment `:78-81`, optional calls after `routines:recent-replies` `:355-358`)
- Modify: `packages/channel-web/src/lib/workspace-types.ts` (`TaskStepsResponse` after `TaskReplyResponse` `:1478-1481`; fix the `TaskStep` doc at `:1486`)
- Test: `packages/channel-web/src/__tests__/server/routes-workspace-task.test.ts`, `packages/channel-web/src/__tests__/server/plugin.test.ts:797-805`, `packages/channel-web/src/__tests__/server/routes-workspace-registration.test.ts:64-70`

**Interfaces:**
- Consumes: hook `routines:set-steps`, `RoutineSetStepsInputSchema`, `RoutineSetStepsOutputSchema` (Task 3).
- Produces (used by Task 5):
  - `POST /api/workspace/tasks/:agentId/:routineId/steps`, body `{ requestId: string; ops: RoutineStepOp[] }`;
  - 200 answers `TaskStepsResponse` (`workspace-types.ts`: `export interface TaskStepsResponse { steps: TaskStep[]; skipped: number }`);
  - refusals: 400 `missing-task-id`, `invalid-json`, `invalid-body`, `steps-invalid`; 404 `agent-not-found` (the resolve) and `task-not-found` (the service); 503 `task-steps-unavailable`. The page words every one from its status alone.

- [ ] **Step 1: Write the failing route tests.**
  - Harness (`routes-workspace-task.test.ts`):
    - `World` gains `stepsAnswer: RoutineSetStepsOutput` (default `{ steps: [], skipped: 0 }`) and `stepsFailure: Error | null`;
    - `setup()` registers a `routines:set-steps` stub unless absent. It records `stepsCalls` and `order`, runs `parseRoutineInput(RoutineSetStepsInputSchema, raw)` first (so `steps-invalid` is pinned with the contract's own refusals), then throws `stepsFailure` or answers `stepsAnswer`, registered with `{ returns: RoutineSetStepsOutputSchema }`;
    - add a `steps(params?, body?)` request helper like the reply one;
    - add `'routines:set-steps'` to the "without routines at all" list (`:950-958`).
  - New `describe('POST /api/workspace/tasks/:agentId/:routineId/steps (TASK-949)')`. Each test checks status, body and what the hook saw:
  - `401s without a session, and reads nothing` (as the reply route's test).
  - `400s a missing id, and reads nothing` → `missing-task-id`.
  - `400s a body that isn't JSON` → `invalid-json` (raw `Buffer` bodies, as the reply route's `'400s %s as invalid-json, and asks no one'` cases at `:1216` send them).
  - `400s a body of the wrong shape, before the hook or the agent is read` → `invalid-body` for each of:
    - `[]`;
    - `{ ops: [] }` (no requestId);
    - `{ requestId: '', ops: [] }`;
    - `{ requestId: 'q', ops: 'add' }`;
    - `null`.
    `resolveCalls` and `stepsCalls` are empty.
  - `503s without routines:set-steps, before reading the agent` → `task-steps-unavailable`, `resolveCalls` empty.
  - `404s someone agents:resolve refuses, and never calls the hook` → `agent-not-found` (`resolveAgentOr404`'s own answer, as the reply route's test pins at `:1268-1272`).
  - `404s a stay-on-top task and someone else's` → `stepsFailure` `SafeToolError('not-found','routineId')`, then `SafeToolError('forbidden','input')` → `task-not-found`.
  - `400s a change the contract refuses` → `steps-invalid` for:
    - `ops: []` (the shape is right, the contract wants 1 to 50);
    - a blank text;
    - a zero-width space (`String.fromCodePoint(0x200b)`);
    - 201 characters;
    - `{ op: 'rename' }`;
    - an op with `addedBy: 'person'`.
  - `fails the request for anything else` → `stepsFailure` `new SafeToolError('request-conflict','requestId')` and `new Error('boom')` reject the handler (as the reply route's test does for `unavailable`).
  - `calls the hook as the caller, with the address's ids and only requestId and ops`:
    - the body `{ requestId: 'q', ops: [add], agentId: 'other', extra: 1 }`;
    - `stepsCalls[0]` is `{ userId: 'alice', agentId: 'a1', input: { agentId: 'a1', routineId: 't1', requestId: 'q', ops: [add] } }` (the harness's viewer is `'alice'`, `:205`).
  - `answers each step as the task page draws it, and the count`:
    - `stepsAnswer` holds a person step and an agent step whose text is 300 characters with an inner run of spaces and `<img src=x>`;
    - the 200's `steps` deep-equals the `steps` the detail route answers for a get-done row storing the same two steps (`detail()` on a `stored({ kind: 'get-done', goodWhen: …, steps })` row, built as this file's TASK-948 cases build one: the view schema refuses a get-done row without `goodWhen`);
    - `skipped` passes through (`stepsAnswer.skipped = 2`).
  - `plugin.test.ts`: the exact list gains, after `routines:recent-replies`:
    `{ hook: 'routines:set-steps', degradation: 'the task page shows a get-done task\'s steps but can\'t change them: adding, ticking, rewording or deleting one (POST /api/workspace/tasks/:agentId/:routineId/steps) answers 503' }`.
  - `routes-workspace-registration.test.ts`: `expect(routes).toContain('POST /api/workspace/tasks/:agentId/:routineId/steps')`.

- [ ] **Step 2: Run them and see them fail**
  Run: `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-workspace-task.test.ts src/__tests__/server/plugin.test.ts src/__tests__/server/routes-workspace-registration.test.ts`
  Expected: FAIL (no route, no manifest entry).

- [ ] **Step 3: Implement.**
  - `readSteps(view)` becomes `view.kind !== 'get-done' ? [] : readStepList(view.steps)`, with `readStepList(steps: unknown): ReadStep[]` holding the old body. One reader feeds the detail, the Tasks counts and the answer.
  - `readTaskStepsBody(parsed: unknown): { requestId: string; ops: unknown[] } | null` requires an object (not an array) with a non-empty string `requestId` and an array `ops`.
  - Local types `interface TaskStepsInput extends TaskKeyInput { requestId: string; ops: unknown[] }` and `type TaskStepsOutput = { steps: unknown; skipped: number }`. Read the answer's steps leniently, like a view's, and trust `skipped` from the hook's `returns`.
  - `taskSteps(req, res)`, in the reply route's order:
    1. `authOr401`;
    2. `taskKeyOr400`;
    3. JSON (`invalid-json`);
    4. `readTaskStepsBody` (`invalid-body`);
    5. `bus.hasService('routines:set-steps')`, else 503 `task-steps-unavailable`;
    6. `resolveAgentOr404`;
    7. `bus.call('routines:set-steps', agentWorkspaceCtx(key.agentId, userId), { agentId: key.agentId, routineId: key.routineId, requestId: body.requestId, ops: body.ops })`;
    8. `validation` → 400 `steps-invalid` (checked before `isTaskRefusal`), `isTaskRefusal` → 404 `task-not-found`, anything else rethrown;
    9. 200 `{ steps: readStepList(out.steps).map(toTaskStep), skipped: out.skipped } satisfies TaskStepsResponse`.
  - Its doc comment says the route reads nothing first, that CSRF is the global guard (met by `workspace-api`'s write headers), and that the text is screened by the contract before anything is written.
  - Route table entry after `/replies`: `// TASK-949 — the task's owner changes its steps. The service decides who may, under the routine's row lock.`
  - `plugin.ts`: the declaration above, with a comment in the `/replies` style. The manifest comment gains: "TASK-949 adds no hard call either: a task's owner changes its steps through the optional routines:set-steps, answering 503 without it."
  - Header: add `POST /api/workspace/tasks/:agentId/:routineId/steps — add, tick, reword or delete a step on that task (TASK-949)` after the `/replies` line, and update the security posture's route count and its writes sentence.

- [ ] **Step 4: Run the three files, then the whole channel-web server suite and its types**
  Run: the Step 2 command, then `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server` (with Docker down, add the six `--exclude` flags from Global Constraints) and `pnpm --filter @ax/channel-web exec tsc --build`
  Expected: PASS, including `manifest-declarations.test.ts` (every literal `bus.call`/`hasService` declared).

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/server packages/channel-web/src/lib/workspace-types.ts packages/channel-web/src/__tests__/server
git commit -m "feat(channel-web): POST /api/workspace/tasks/:agentId/:routineId/steps (TASK-949)"
```

---

### Task 5: channel-web client data: `setTaskSteps` and `replaceSteps` [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-api.ts` (beside `sendTaskReply`, `:1180-1203`)
- Modify: `packages/channel-web/src/lib/workspace-task.ts:58-133`
- Test: `packages/channel-web/src/lib/__tests__/workspace-api-task.test.ts`, `packages/channel-web/src/lib/__tests__/workspace-task.test.ts`

**Interfaces:**
- Consumes: the route and `TaskStepsResponse` (Task 4).
- Produces (used by Task 6):
  - `workspaceApi.setTaskSteps(agentId: string, routineId: string, input: { requestId: string; ops: RoutineStepOp[] }): Promise<TaskStepsResponse>`. A refusal is a `WorkspaceApiError` (status only), and a 200 it can't read is a `WorkspaceShapeError`.
  - `useTask()` returns `{ state, refresh, refreshQuietly, replaceSteps: (steps: TaskStep[]) => void }`.

- [ ] **Step 1: Write the failing tests.**
  - `workspace-api-task.test.ts`, `describe('workspaceApi.setTaskSteps (TASK-949)')`, in the shape of the `sendTaskReply` block (`:290-340`):
    - `posts the request id and the changes to the task's steps, with the write headers`: path `/api/workspace/tasks/a1/t1/steps`, method POST, `x-requested-with: ax-admin`, body exactly `{ requestId: 'req-1', ops: [{ op: 'tick', id: 's1' }] }`;
    - `answers the steps and the count`;
    - `a 200 it can't read is a WorkspaceShapeError`: each of `{ steps: [{ id: 's1' }], skipped: 0 }`, `{ steps: [], skipped: -1 }`, `{ steps: [], skipped: 1.5 }`, `{ steps: [] }`;
    - `a refusal carries its status`: a 404 is a `WorkspaceApiError` with `status: 404`.
  - `workspace-task.test.ts`:
    - `replaceSteps swaps a ready task's steps and keeps the rest, updates included`: the same `updates` array instance before and after;
    - `a read that started before replaceSteps keeps the replaced steps, and shows the rest of its answer`: hold a `refreshQuietly()` read open on a deferred; call `replaceSteps(B)`; resolve the read with steps A and a new `name` → state shows steps B and the new name;
    - `a read whose steps it kept asks for one more quiet read, and that read's steps show`: after the case above, `workspaceApi.task` is called once more; resolve it with steps C → state shows C, and no third read follows;
    - `a read that started after replaceSteps shows its own steps, and asks for no other`;
    - `replaceSteps before the task loads does nothing`.

- [ ] **Step 2: Run them and see them fail**
  Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/workspace-api-task.test.ts src/lib/__tests__/workspace-task.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `setTaskSteps` is `sendTaskReply`'s shape. It POSTs `{ requestId, ops }` to `${taskPath(agentId, routineId)}/steps`, then `checkedRead` with `isTaskStepsResponse(v)`: a record, not an array, `steps` an array where `every(isTaskStep)`, and `skipped` a non-negative integer.
  - Import `type RoutineStepOp` from `@ax/routines-contract` and `TaskStepsResponse` from `./workspace-types.js`.
  - `useTask` gains `replaceSteps`:

```ts
// The newest read started when the page last swapped in a change's steps. A read numbered at or below it started
// before the change's answer, so its steps may be older than the page's: it keeps the page's steps and shows the
// rest of its answer. A read started after it reads the change too, and shows its own.
const stepsReplacedAt = useRef<number | null>(null);
const replaceSteps = useCallback((steps: TaskStep[]) => {
  stepsReplacedAt.current = latest.current;
  setState(s => (s.kind === 'ready' ? { ...s, detail: { ...s.detail, steps } } : s));
}, []);
// In load()'s success, after the `latest.current !== mine` check:
const stale = stepsReplacedAt.current !== null && mine <= stepsReplacedAt.current;
setState(s => ({
  kind: 'ready', refreshing: false, refreshFailed: false,
  detail: stale && s.kind === 'ready' ? { ...detail, steps: s.detail.steps } : detail,
}));
// The steps it dropped may also have held something newer than the page's: an agent's tick from the check-in this
// read delivered, after which the poll stops. One more quiet read, started now, shows the list as it is.
if (stale) quietly.current();
```

  - `quietly` is a ref to `refreshQuietly`, which is defined after `load`. Going through `refreshQuietly` keeps its rule: no quiet read overtakes an ordinary refresh in flight. That refresh, if it started before the swap, asks for its own extra read when it lands. The extra read starts after the swap, so it isn't stale and asks for no other.
  - Add a paragraph to the module doc: a change's answer swaps the steps with no re-read (TASK-949), and the rule above.

- [ ] **Step 4: Run them and see them pass, then type-check.** Run the Step 2 command and `pnpm --filter @ax/channel-web exec tsc --build`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/workspace-api.ts packages/channel-web/src/lib/workspace-task.ts packages/channel-web/src/lib/__tests__/workspace-api-task.test.ts packages/channel-web/src/lib/__tests__/workspace-task.test.ts
git commit -m "feat(channel-web): the steps call, and the task page swaps in a change's steps without a re-read (TASK-949)"
```

---

### Task 6: channel-web client: editable steps on the task page [tier: sensitive]

Invoke the `shadcn` skill (installed primitives, `-c packages/channel-web`) and the `ux-design` skill before writing the component.

**Files:**
- Modify: `packages/channel-web/src/components/workspace/TaskSteps.tsx` (whole file; header `:1-16` rewritten, "READ-ONLY IN THIS CARD" goes)
- Modify: `packages/channel-web/src/components/workspace/TaskPage.tsx` (`useTask` at `:294`, `TaskBody` props `:461-487`, the `TaskSteps` line `:557`)
- Modify: `packages/channel-web/src/lib/http.ts` (add `isConfirmedRefusal`)
- Modify: `packages/channel-web/src/components/workspace/TaskReplyBox.tsx:53-63` (use the shared helper)
- Test: `packages/channel-web/src/components/workspace/__tests__/TaskSteps.test.tsx` (rewrite), `packages/channel-web/src/components/workspace/__tests__/TaskPage.test.tsx` (mock gains `setTaskSteps: vi.fn()`), new `packages/channel-web/src/lib/__tests__/http-confirmed-refusal.test.ts`

**Interfaces:**
- Consumes: `workspaceApi.setTaskSteps`, `useTask().replaceSteps` (Task 5); `RoutineStepTextSchema`, `ROUTINE_STEPS_MAX` (`@ax/routines-contract`).
- Produces:
  - `http.ts`: `isConfirmedRefusal(e: unknown): e is HttpError`, true for a status from 1 to 499 that isn't 408 or 429. It is `TaskReplyBox`'s `confirmed`, moved.
  - `TaskSteps` props: `{ agentId: string; routineId: string; steps: TaskStep[]; agentName: string; onChanged: (steps: TaskStep[]) => void }`.

**The exact copy (U+2019 apostrophes):**

| Where | Text |
|---|---|
| Heading | `Steps` with none; `Steps · {done} of {n} done` otherwise (unchanged) |
| Empty line | `No steps yet. Add one, or {agent} drafts them at its next check-in.` |
| Add button | `Add a step` (lucide `Plus`, `aria-hidden`, `data-icon="inline-start"`; ghost, `size="sm"`) |
| At the cap | `A task can have up to 50 steps.` (Add a step disabled, `aria-describedby` this line) |
| Unconfirmed | `We couldn’t confirm that change. Try again, and it won’t happen twice.` |
| 403 / 404 | `We couldn’t find this task any more. It may have been deleted.` |
| Any other answered refusal (400 and the rest) | `We couldn’t save that step as written. Change it and try again.` |
| 401 | `HTTP_SESSION_ENDED` from `@/lib/http` |
| Skipped | `That step was changed or removed meanwhile, so we’ve loaded the latest.` |
| Duplicate add | `That step is already on the list.` |
| Editing the agent's step | `Once you save it, {agent} reads this as your words.` |
| Kept from TASK-948 | `added by {agent}`, `We can’t show this step’s text.` |

**Accessible names (tests query by these):**
- Each step's checkbox (`Checkbox`, controlled by `step.done`) is labelled by its text span (`aria-labelledby`) and described by its `added by {agent}` line when there is one.
- The options trigger is a ghost icon `Button` with lucide `MoreHorizontal`, `aria-label="Step options"`, and `aria-describedby` pointing at the step's text span.
- The menu items are `Edit` and `Delete`.
- The edit input is named `Edit step`, with buttons `Save` and `Cancel`; the add input is named `New step`, with buttons `Add` and `Cancel`. Use an sr-only `FieldLabel` or an `aria-label`.

**Behaviour (each is a test):**
1. **Tick and untick.** `onCheckedChange` sends only on a boolean: `{ op: checked ? 'tick' : 'untick', id }`. The box isn't flipped ahead of the answer.
2. **Edit.** Open the menu, choose Edit, and the row's text and options button give way to a `Field` with an `Input` (`maxLength={200}`), prefilled with the shown text or `''`, plus Save and Cancel.
   - The checkbox stays, and its text span stays in the DOM visually hidden, so it keeps its name.
   - Editing a step the agent added shows the edit-note line as the field's `FieldDescription`.
   - Save, or Enter (a `<form onSubmit>`), with the text unchanged closes the editor and sends nothing. Otherwise it sends `{ op: 'edit', id, text }`.
   - Escape or Cancel closes the editor without sending.
3. **Delete.** Choose Delete and `{ op: 'remove', id }` goes out, with no confirmation.
4. **Add.** Add a step opens a `Field` with an `Input` (`maxLength={200}`), Add and Cancel. Add or Enter sends `{ op: 'add', text }` (no `done`). When the add applied (the answer's `skipped` is 0), the input empties and stays open; a skipped add keeps its text beside the skipped line. Escape or Cancel closes it. While the list holds 50 steps, the open editor's Add is disabled too, Enter sends nothing, and the cap line is the field's `FieldDescription`.
5. **One editor at a time.** Opening Edit on another step, or Add a step, replaces the open editor, and its unsaved text is dropped. If the step being edited leaves the list (a re-read or another change's answer), its editor closes.
6. **The text rule.** Before Save or Add, `RoutineStepTextSchema.safeParse(text)` runs, and the first issue's message goes in the editor's `FieldError` (with `aria-invalid` on the input).
   - An add whose text, with whitespace runs folded and trimmed, matches a shown step's text gets the duplicate line instead.
   - Nothing is sent in either case.
7. **One change in flight.**
   - While a change is out, every checkbox, options button, Add a step, Save, Add and Cancel is `disabled`, and the open input is `readOnly` (so focus stays in it). Save and Add show a `Spinner`.
   - A second change can't start until the first settles (an `inFlight` ref, as `TaskReplyBox` has).
   - Escape does nothing while a change is out, so the editor whose request is pending is still there for its answer or its failure line.
8. **Request ids** (`TaskReplyBox`'s rule).
   - The id is kept in a ref keyed by `JSON.stringify(op)`. The same op after an unconfirmed failure reuses it; any other op mints a new `crypto.randomUUID()`.
   - It's dropped on success and on `isConfirmedRefusal`.
9. **After an answer.**
   - `onChanged(answer.steps)` runs, and the skipped line shows in a polite `role="status"` line mounted with the section (empty until then) when `answer.skipped > 0`.
   - Starting the next change clears it and any failure.
   - After an edit's answer, the editor closes.
10. **After a failure.**
    - A failed add or edit puts its line in the open editor's `FieldError` (no `aria-invalid`) and keeps the text, so pressing again retries.
    - A failed tick, untick or delete puts its line in an `Alert` under the list: `destructive`, but `default` for the 401 line.
    - `logRequestFailure(e, 'task-steps')` runs either way.
11. **Focus**, applied in a layout effect after the answer renders, and only when focus is on `<body>` or inside the steps section:
    - after a tick or untick, that step's checkbox;
    - after Save or Cancel, that step's options button;
    - after an add, the add input;
    - after the add editor's Cancel or Escape, Add a step, or the last step's checkbox when it's disabled at the cap;
    - after a Delete, or after any change whose step is no longer listed, the checkbox of the step now at that step's old index, else of the one before it, else Add a step.
    - For the menu, use `FactsMemory.tsx`'s `MemoryActions` pattern (`:334-365`): `onSelect` stores the choice, `onCloseAutoFocus` calls `preventDefault()`, focuses the trigger and runs the choice in `setTimeout(…, 0)`. Edit then focuses the edit input.
    - The menu is `<DropdownMenu modal={false}>`, as the connector row menu is (`AgentConnectors.tsx:730-731`, "a modal menu would leave <body> unclickable"), because Delete takes its own row away.
12. **Text stays text.** A step's text is only a React text child. No attribute is built from it except the input's `value`.

- [ ] **Step 1: Move the confirmed-refusal rule.** Write `http-confirmed-refusal.test.ts`: true for `new HttpError('/x', 400)`, 401, 404 and 499; false for 0, 408, 429, 500 and 503, and for a non-`HttpError`. Run it and see it fail. Add `isConfirmedRefusal` to `http.ts` and point `TaskReplyBox` at it (delete its local `UNCONFIRMED_4XX`/`confirmed`). Run `http-confirmed-refusal.test.ts` and `TaskReplyBox.test.tsx`. Expected: PASS, with `TaskReplyBox` unchanged.

- [ ] **Step 2: Write the failing component tests** in `TaskSteps.test.tsx`.
  - Mock `workspaceApi: { setTaskSteps: vi.fn() }`, as `TaskReplyBox.test.tsx` does, and keep its `deferred()` helper.
  - Open a menu with `FactsMemory.test.tsx:64-70`'s helper (`trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' }); findByRole('menuitem', { name })`), then click the item and `waitFor` the deferred action.
  - Render beside an outside `<button>Elsewhere</button>`, with `onChanged` a `vi.fn()`.
  - Keep and adapt 948's tests: heading count; order; the sr-only `Done: `/`Not done: ` words and the lucide `Square`/`SquareCheck` icon checks (`:28-36`) go, since each checkbox's `toBeChecked()` state says it now; `added by Quill` (now the checkbox's description); markup as text; the can't-show line; and "says there are none yet" (`:51-55`), whose line becomes the new empty copy, `No steps yet. Add one, or Quill drafts them at its next check-in.`
  - Then the new tests, each asserting the call's `ops`, the request id where it matters, the copy, `onChanged`, and `document.activeElement`:
    - `ticks and unticks a step with its checkbox, which is named by the step's text` (one op each; focus stays on that checkbox);
    - `Edit and Save sends one edit; Enter saves too; focus lands on the step's options button`;
    - `Save with the text unchanged closes the editor and sends nothing`;
    - `Escape cancels an edit and focus goes back to the options button`;
    - `editing the agent's step says it becomes the person's words; editing the person's step doesn't`;
    - `Delete sends one remove, asks nothing, and focus moves to the next step, else the previous one, else Add a step`;
    - `Add sends one add, empties the input and keeps it open with focus`;
    - `Escape or Cancel on the add input closes it and focus returns to Add a step`;
    - `opening another editor drops the open one`;
    - `at 50 steps Add a step is disabled and says why, and an add editor left open can't send` (open the editor at 49, add the 50th, then Add is disabled and Enter sends nothing);
    - `a text the contract refuses shows the contract's message and sends nothing`: a zero-width space, built with `String.fromCodePoint`, gives the `A step can’t contain invisible characters` message; blank gives `Write the step first.`;
    - `an add already on the list says so and sends nothing`: `'  Export   every article '` against `'Export every article'`;
    - `keeps the request id across an unconfirmed failure and drops it after a refusal`:
      - a 503 then a retry of the same op → the same `requestId` twice;
      - a 400 then a retry → two different ids;
      - a 503 on op A, then op B → B gets a new id;
    - `words each failure from its status`: a network failure (a `TypeError`), a `WorkspaceApiError` with status 0, 500, 408 and 429 → unconfirmed; 404 and 403 → the not-found line; 400 → the as-written line; 401 → `HTTP_SESSION_ENDED`. Each appears in the editor for add/edit and in the `Alert` for tick/delete;
    - `a skipped change says the list was reloaded, and shows the answer's steps; a skipped add keeps its text`;
    - `while a change is out every control is disabled, the input is read-only, Escape does nothing, and a second press sends nothing`;
    - `a step holding <img src=x onerror=alert(1)> renders as that text and no img` (948's case, kept).
  - `TaskPage.test.tsx`:
    - the `vi.mock` gains `setTaskSteps: vi.fn()`;
    - new `'a tick on a get-done page shows the answer's steps without reading the task again (TASK-949)'`: start from the file's `STEPS` (1 of 2 done), tick `s2`, answer both done; `taskMock` is called once, and the heading reads `Steps · 2 of 2 done`.

- [ ] **Step 3: Run them and see them fail**
  Run: `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/TaskSteps.test.tsx src/components/workspace/__tests__/TaskPage.test.tsx`
  Expected: FAIL.

- [ ] **Step 4: Implement `TaskSteps.tsx` and wire the page.**
  - `TaskPage` passes `replaceSteps` from `useTask` through `TaskBody` as `onStepsChanged`. It renders `<TaskSteps agentId={agentId} routineId={routineId} steps={detail.steps} agentName={agentName} onChanged={onStepsChanged} />`.
  - Rewrite `TaskSteps`' header doc to say what it now does: who may (the page is the owner's only), the op per press, the request-id rule, the focus rules, and that text is drawn as text. Keep TASK-948's "AGENT-WRITTEN TEXT IS DRAWN AS TEXT" paragraph, now saying "agent- or person-written".
  - The send path, as one function:

```ts
async function change(op: RoutineStepOp, place: 'editor' | 'list', after?: (answer: TaskStepsResponse) => void) {
  if (inFlight.current) return;
  inFlight.current = true; setBusy(true); setSkipped(false); setListFailure(null); setEditorFailure(null);
  const key = JSON.stringify(op);
  const ticket = pending.current?.key === key ? pending.current : { key, requestId: crypto.randomUUID() };
  pending.current = ticket;
  try {
    const answer = await workspaceApi.setTaskSteps(agentId, routineId, { requestId: ticket.requestId, ops: [op] });
    pending.current = null;
    onChanged(answer.steps);
    setSkipped(answer.skipped > 0);
    after?.(answer);
  } catch (e) {
    logRequestFailure(e, 'task-steps');
    if (isConfirmedRefusal(e)) pending.current = null;
    (place === 'editor' ? setEditorFailure : setListFailure)(failureLine(e));
  } finally {
    inFlight.current = false; setBusy(false);
  }
}
```

- [ ] **Step 5: Run them, the whole channel-web suite, and the types**
  Run: the Step 3 command, `pnpm --filter @ax/channel-web test` (with Docker down, `exec vitest run` with the six `--exclude` flags from Global Constraints), `pnpm --filter @ax/channel-web exec tsc --build`
  Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/workspace packages/channel-web/src/lib/http.ts packages/channel-web/src/lib/__tests__/http-confirmed-refusal.test.ts
git commit -m "feat(channel-web): the owner adds, ticks, rewords and deletes a task's steps on its page (TASK-949)"
```

- [ ] **Step 7: Run the `security-checklist` skill over the branch diff** (`git diff origin/main...HEAD`). Finish the PR's `## Security review` block from the draft above, and add anything the walk finds as a separate commit.

---

### Task 7: Docs: the design says what was built [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`: lines `:32`, `:253`, `:470`, §7 (`:649-657`), §15 (after the last 2026-10-24 row)

- [ ] **Step 1: Make these edits.**
  - `:32` "Resume here": "…a person editing steps (TASK-949) and Mark done (TASK-950) come next" becomes "…TASK-949 lets a task's owner edit its steps on the task page; Mark done (TASK-950) comes next."
  - After `:253`, a new note:
    `> PR 3 (TASK-949): The task's owner edits the steps on its page, with no approval and no new revision: they tick or untick any step, add one (labelled theirs), and reword or delete any step, the agent's included, from its ⋯ menu (Delete asks nothing: a step is one line). Rewording a step the agent added makes it the person's, so the agent reads it as their words and can no longer reword or remove it. Each press is one change, the same kind the agent sends, and a retry never applies twice. Reordering, undo and steps on Today come later.`
  - `:470`: "(TASK-948: steps are one JSON list on the routine, edited only by the agent's report so far, by id, …)" becomes "edited by id by the agent's report and (TASK-949) by the person on the task page through `routines:set-steps`, both under the routine's row lock, …". The rest stays.
  - §7, after the TASK-948 steps sentence:
    `A person can reword or delete any step on the task page (TASK-949), so an agent step injected through a ticket can be cleared. A step the person added or reworded is labelled theirs in the check-in message, and the brief says so; the agent can tick it but can’t reword or remove it. A check-in already running when a person deletes a step can still add the same text back, since it read the list before the delete; deleting it again clears it.`
  - §15, a new row:
    `| 2026-10-24 | Decided | A task's owner edits its steps on the task page, with no approval and no new revision, one change per press through routines:set-steps: the same changes the agent sends, applied by id under the row lock. They can reword or delete any step, the agent's included; a step they add or reword is theirs, which the agent can tick but not reword or remove. Receipts keep a count, never step text (TASK-949). |`

- [ ] **Step 2: Check that the scripts still pass**
  Run: `pnpm test:scripts`
  Expected: PASS (every path a memory shard cites exists).

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-10-20-agent-tasks-design.md
git commit -m "docs(agent-tasks): person-edited steps as built (TASK-949)"
```

---

## Final verification (the card's gate)

- [ ] `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Name every suite that ran only on the local-pg shim in the handoff.
- [ ] Code-point scan every file that holds a test input with an invisible or broken character (there should be none: `String.fromCodePoint` builds them).
- [ ] The PR description carries the boundary review and the security block above, and lists row 4 (a person's rewording makes a step theirs) as the call for a human to confirm.

## Not in this card (YAGNI)

- **Reordering steps; undo for a deleted step; steps on Today; read-only steps on a Done task.** The card leaves these to later (TASK-950 does the last).
- **A stamp that stops an overlapping check-in from adding a deleted step back** (row 11).
- **The approval card's warning that a kind change clears the checklist** (948 row 31): this card doesn't touch `DecisionTaskBlock`.
- **A 409 for `request-conflict`**, which only a client that reuses a request id for another change can raise (row 12).
- **A capability flag telling the page whether `routines:set-steps` exists.** Without the hook a change answers 503 and the page says it couldn't confirm.
