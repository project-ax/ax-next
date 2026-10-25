# TASK-953: Duplicate task, and "Going well when" in Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a task's page, ⋯ › Duplicate makes a paused copy named "Copy of {name}" with the same brief, schedule and active hours and the steps unticked, and lands the person on it; and a person can edit a task's "Going well when" in Agent Settings › Routines.

**Architecture:** A new owner-only host service, `routines:duplicate`, makes the copy in one Postgres transaction through `receiptTransaction` (operation `'duplicate'`, receipt `{ routineId }`), so a copy never exists without its steps and a retry answers the same copy. What a copy carries is one pure module in `@ax/routines` (`duplicate.ts`: the name rule and the step copy). channel-web gains `POST /api/workspace/tasks/:agentId/:routineId/duplicate`, the task page a ⋯ menu whose one item is Duplicate (under TaskPage's keep-the-request rule), and the shell a memory-only flag that tells the copy's page, once, that it is a paused copy. `RoutineEditor` gains a "Going well when" field and a kind line for a task. No schema change, tool, IPC action, dependency or new shadcn component.

**Tech Stack:** TypeScript, zod 3.25, Kysely on Postgres (testcontainers, or the local-pg shim), vitest, React + shadcn (channel-web), Radix DropdownMenu, lucide `MoreHorizontal`.

**Spec:** card TASK-953 (orchestrator scratchpad `TASK-953/card.txt`, lines 1-178); `docs/plans/2026-10-20-agent-tasks-design.md` §3.3, §7, §9, §12 PR 3; decisions `.claude/memory/decisions/2026-10-24-TASK-953.md` (cited as "row N", the plan row being row 1). The step rules are TASK-948's and TASK-949's (`.claude/memory/decisions/2026-10-24-TASK-948.md`, `…-TASK-949.md`).

## Where the code refined the card

Every MEASURED predecessor learning checked out against 8a655585b. **Every `file:line` in this plan is origin/main d892597b8**, where TASK-951 (#1034, Finish by, schema version 12) and #1035 (the canaries' poll budget) have merged; the builder rebases there before Task 1. TASK-950 is still in flight. These change what to build:

0. **TASK-951 is in** (row 13). Its `finish_by` column is not in `NO_TASK_STATE` (it has its own `NO_FINISH_BY`, `packages/routines/src/store.ts:353`), and the duplicate's INSERT doesn't name it, so a copy's finish date is NULL with no code here. Task 2 pins it with a store test, and the canary with a source that has one. `ROUTINE_SERVICES` has 22 entries (`set-finish-by` last), and its PUT route is this card's route template: a write that reads the task first through `ownTaskOr404` (`packages/channel-web/src/server/routes-workspace.ts:7783-7861`).
1. **The name rule moves out of the contract** (row 2). `@ax/routines-contract` is bundled by the SPA and is browser-safe by rule (`eslint.config.mjs:7-10`). `clampCodeUnits` comes only from `@ax/core`'s root, which runs `new AsyncLocalStorage()` (`node:async_hooks`) at module load (`packages/core/src/hook-bus.ts:1,9`). `DUPLICATE_NAME_PREFIX` and `duplicateName` go in `packages/routines/src/duplicate.ts`; the contract keeps the schemas. The card's "contract" acceptance for `duplicateName` is pinned in routines' pure test instead.
2. **The store also decides the owner, under the lock** (row 4). `duplicateAuthored` answers `{ routineId, replayed } | 'not-found' | 'forbidden'`, and every refusal is thrown inside the effect (`receiptTransaction` stores whatever its effect returns, `packages/routines/src/store.ts:626-631`).
3. **Decision 5's reachable 400 is the copy's size** (row 5). Every read revalidates the definition, so a source today's rules refuse already fails `routines:get` (and so its own page). What a readable source can still trip: the copy is 9 bytes longer ("Copy of ", and `false` for `true`), so a source within 9 bytes of the 64 KB definition cap makes a copy `validateDefinition` refuses on `promptBody`.
4. **The route reads the task first** (row 6), through `ownTaskOr404`, so a stranger, a teammate who doesn't own the task and a repeat routine are all the page's 404 before the hook runs, and a 403 means only "your own task, but you no longer manage this agent's tasks".
5. **The ⋯ button is what's disabled without `edit`**, described by the note line (row 7). A disabled Radix menu item can't take keyboard focus (`@radix-ui/react-menu` 2.1.16, `focusable: !disabled`), so a one-item menu with its item disabled tells a keyboard user nothing. The note lines shown without `edit` now name copying.
6. **`invalidField === 'goodWhen'` can never be true** (row 10): neither core's `TOOL_FIELDS` nor `RoutineApiError`'s `fields` has `goodWhen`. The field is marked invalid from the editor's own contract check.
7. **The degradation line is honest** (row 6): the page can't tell whether the hook exists, so without it Duplicate answers 503 and makes no copy; it doesn't disappear.
8. **No migration** (row 11), and **no preset or mcp-oauth pin changes** (row 1). The pins that do change: `ROUTINE_SERVICES`' length (`packages/routines/src/__tests__/return-schemas.test.ts:176`, 22 → 23), channel-web's exact manifest (`packages/channel-web/src/__tests__/server/plugin.test.ts`), the route registration list, and the route tests' "without routines at all" list.
9. **Through the service, a default is `forbidden`, not `not-found`** (row 14, from the builder check). `routinePermissions` gives a default no `edit`, so the service's `edit` check refuses it before the store's own `not-found` (which stays, as the locked re-check). The contract's doc says so, as `routines:update` behaves. The route's `ownTaskOr404` 404s a default (a repeat routine) before either.
10. **The local-pg shim the dispatch notes name is wired to another worktree.** Both its `root` and its mock path say `agent-abcb9446d4499f944` (TASK-936's tree). Copy and repoint it before use (Global Constraints).

## Global Constraints

- **Base and parallel cards.** Rebase onto origin/main d892597b8 or later before Task 1 (the plan is anchored there), then `pnpm install` and `pnpm build`. Before Task 1, `git fetch origin` and read `git log --oneline origin/main -8`. TASK-950 (done claim, Mark done, Reopen) is still building in parallel (row 13). If it has merged, rebase first; the "Rebase onto TASK-950" step in Tasks 2, 3, 4 and 5 says what it needs. Re-run the routines, routines-admin-routes and channel-web suites after any rebase.
- **No schema version.** `'duplicate'` is a new value of a plain text column (row 11). If a reviewer asks for one, point at row 11; the next free number would be 13 (TASK-951 took 12).
- **SQL in tests:** Kysely's `sql` tag sends `\d` as `d`, so a regex inside SQL uses `[0-9]` (orchestrator note, TASK-951).
- **Copy is exact and asserted verbatim.** Apostrophes are U+2019 (’). Task 5 and Task 6 list every string this card adds or changes. Don't add the words routine, webhook or trigger to new copy.
- **Characters in tests.** Build an astral character with `String.fromCodePoint(0x1F600)`; never type it or a backslash-u escape (the Write/Edit escape trap, `.claude/memory/mistakes/2026-10-24-TASK-948.md`). Assert names by comparing whole expected strings, not with a surrogate regex. If any file ends up holding an escape anyway, run the code-point scan from `docs/plans/2026-10-24-task-948-get-done-steps-plan.md` (Global Constraints); it must print `[]`.
- **One file:** `pnpm --filter @ax/<pkg> exec vitest run <path>`. Never `pnpm test --filter` and never a `--` (`.claude/memory/mistakes/2026-10-20-TASK-904.md`). Check the summary's file count.
- **Built packages.** `@ax/routines-contract` resolves through `dist/`. After Task 1, run `pnpm --filter @ax/routines build` (it rebuilds the contract through its reference) before any routines or channel-web test that uses the new schemas.
- **Postgres-backed suites:** every `@ax/routines` test that uses `store-fixture.ts`, `support/routine-harness.ts` or `support/check-in.ts` (this card's `duplicate-store`, `duplicate`, `canary`); six channel-web server files (`routes-chat`, `stream-e2e`, `connections-mirror`, `routes-workspace-approval-actor`, `routes-attachments`, `acceptance-e2e`), none of which this card edits; `@ax/routines-admin-routes` at the final gate.
  - Check Docker with `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock timeout 15 docker info`, and export that `DOCKER_HOST` for the run. If it hangs, don't restart OrbStack.
  - The shim: copy `/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/386b12a8-02d6-45fd-a50d-1e78eb04cac6/scratchpad/TASK-936/t1-pg/vitest.local-pg.config.mjs` and `mock-harness.ts` from the same directory into `/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/386b12a8-02d6-45fd-a50d-1e78eb04cac6/scratchpad/TASK-953/pg/`, and in both replace `agent-abcb9446d4499f944` with `agent-a1f3fef8ffaba8307` and the `setupFiles` path with the new copy's. The copied config predates #1035: add `expect: { poll: { timeout: 15_000 } }` to its `test` block, as `packages/routines/vitest.config.ts` now has, or the canaries' polls get vitest's 1-second default. Run with `pnpm --filter @ax/routines exec vitest run --config <that config> [<path>]` once `/opt/homebrew/opt/postgresql@17/bin/pg_isready -h 127.0.0.1 -p 55439` answers. It swaps `startTestContainer` only; a harness-based file (the canary) that won't start on it is named in the handoff as not run.
  - With Docker down, run channel-web's whole-suite steps with the six files above passed as `--exclude src/__tests__/server/<name>.test.ts`, and name them in the handoff. The shim is Postgres 17, not CI's 16: name every suite that ran only on it.
- **What type-checks:** channel-web type-checks its test files (`pnpm --filter @ax/channel-web exec tsc --build`); routines and the contract don't, so run their whole changed files.
- **A task's test file carries only the names that task's tests use** (`@typescript-eslint/no-unused-vars` fails test files too).
- **Imports:** channel-web `src/lib/*.ts` modules import siblings as relative `./x.js`. Server modules never import `@/…`.
- **UI:** shadcn primitives already installed (`DropdownMenu`, `Button`, `Alert`, `Textarea`, `Field`), semantic tokens only. Tasks 5 and 6 invoke the `shadcn` and `ux-design` skills before building.
- **Run the tasks one at a time** in this worktree: channel-web's `tsc --build` compiles routines and the contract, so two builds at once collide.
- **Memory rows** go to shards (`.claude/memory/<kind>/2026-10-24-TASK-953.md`), never a root archive. The planner wrote this plan and the decisions shard; commit both before Task 1. The shard cites this plan's path, so `memory-cited-paths-exist` (in `pnpm test:scripts`) is red until the plan is committed, and green after (measured: it flags only that path while the plan is untracked).
- **No known canary flake any more:** #1035 (merged) gave the routines and skills canaries a 15-second poll budget, so a canary failure on this branch is a real one to chase.
- **Final gate:** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

## Review Focus

Each line is pinned by a test in the task named.

1. **A retry after a lost answer.** The same request id must answer the same copy, never make a second one; the same id on another task is refused. The page keeps the id across an unconfirmed failure and drops it after an answered refusal. → Task 2 ("the same request again answers the same copy…"), Task 5 ("a press whose answer never came keeps its request id…").
2. **The longest name, with a character across the cut.** A 128-unit name copies to exactly 128 units, and an emoji at the cut is dropped whole, never halved. → Task 2, `duplicateName` cases.
3. **A task with a full history.** A source with a report, notes, a reading, misses, a cleared-notes stamp, a reply, a run and a finish date (and, after a TASK-950 rebase, a claim and Done) gives a copy with none of them. → Task 2 ("copies none of the task’s state…"), Task 3 (canary).
4. **Someone who isn't the owner, or no longer manages the agent's tasks.** A teammate gets the page's 404 and the service's `forbidden`; an owner who lost the role sees a disabled ⋯ with its reason, and a race answers 403 with the same words. No copy either way. → Tasks 3, 4 and 5.
5. **Coming back to the copy.** Back and Forward, a reload, or a later visit never repeat the one-time line, and Resume hides it. → Task 5 (shell test and page test).

## Hook surface and boundary review

New service hook `routines:duplicate`. Neither a tool nor an IPC action. For the PR description:

- **Alternate impl:** a tracker's "duplicate issue" with its checklist (Linear, Asana), or a SQLite store making the same copy in one transaction.
- **Payload names that might leak:** none. `routineId` and `requestId` are this plugin's own words, on every routines service.
- **Subscriber risk:** none, it's a service.
- **Wire surface:** not an IPC action. The schemas live in `@ax/routines-contract` with the other routine services.

## Security checklist

Flagged tasks: 2 (copies agent-written steps into a new task, under a receipt), 3 (who may, with no approval), 4 (the HTTP write route). Task 4's Step 6 runs the `security-checklist` skill over the diff so far; rerun it on the whole branch before the PR if Tasks 5-7 change anything it covered. The PR block starts from:

```
## Security review
- Sandbox: N/A: no filesystem path, process, network, env or handle is added or widened. One new owner-only host service (routines:duplicate, neither a tool nor an IPC action, so no model can call it) and one new route behind auth:require-user, agents:resolve, the task page's own ownership read and the global CSRF guard. The service requires agents:can-manage-routines and edit on the source; the store decides the owner again under the source's row lock.
- Injection: a copy carries the source's agent-written steps into a new task, unticked and still labelled by host-set addedBy, so they reach the copy's check-ins quoted and framed as the agent's own plan, are drawn as text and labelled "added by {agent}" on the copy's page, and are deletable there (TASK-949). The copy is paused until a person resumes it, and nothing else crosses: no notes, report, reading, misses, finish date, replies, runs or receipts. No approval card, by Vinay's call: the person's own press is the only way in, decided on the host. The receipt and the answer hold the copy's id alone; the log line holds ids and a replay flag, never the task's name or steps. "Going well when" in Settings is the person's own brief field, saved through routines:update under validateDefinition's invisible-character and padding rules (TASK-906), unchanged.
- Supply chain: N/A: no package.json or lockfile change; the shadcn primitives and the lucide icon are already installed.
```

## Rollback

No schema change. Code from before this card never reads a `'duplicate'` receipt (only `routines:duplicate` asks for one). A copy is an ordinary task row, readable by any version that reads its source (a get-done copy needs schema version 11's code, as its source does: TASK-948's rollback note). Nothing from Agent Tasks PR 1–3 is deployed.

## Tiers and order

| Task | Tier | Needs | security-checklist |
|---|---|---|---|
| 1 Contract: `routines:duplicate`'s schemas | mechanical | — | — |
| 2 Copy rules and the store's `duplicateAuthored` | sensitive | 1 | flagged |
| 3 `routines:duplicate` end to end in routines (service, pins, canary) | sensitive | 2 | flagged |
| 4 channel-web server: the duplicate route and the manifest | sensitive | 1 (stubs the hook) | flagged (runs the skill) |
| 5 channel-web client: `duplicateTask`, ⋯ › Duplicate, the one-time line | integration | 4 | — |
| 6 Settings editor: "Going well when" and the kind line | mechanical | — | — |
| 7 Docs: the design says what was built | mechanical | 5, 6 | — |

---

### Task 1: Contract: `routines:duplicate`'s schemas [tier: mechanical]

**Files:**
- Modify: `packages/routines-contract/src/services.ts` (after `RoutineSetStepsOutputSchema`, `:156`; types at the end, after `:259`)
- Create: `packages/routines-contract/src/__tests__/duplicate.test.ts`

**Interfaces:**
- Produces (Tasks 2-4): `RoutineDuplicateInputSchema`, `RoutineDuplicateOutputSchema`, `type RoutineDuplicateInput`, `type RoutineDuplicateOutput` (`z.output`).

- [ ] **Step 1: Write the failing test** (`duplicate.test.ts`, header comment in `set-steps.test.ts`'s style)
  - `it("takes a task's key and a request id, strictly")`:
    - `RoutineDuplicateInputSchema.parse({ agentId: 'a', routineId: 'r', requestId: 'q' })` deep-equals its input;
    - each of these fails `safeParse`: no `requestId`; `requestId: ''`; `requestId: 'x'.repeat(257)`; an extra `name: 'Mine'`; an extra `ownerUserId: 'u'`; an extra `steps: []`; an extra `enabled: true`.
  - `it("answers the copy's id and nothing else")`:
    - `RoutineDuplicateOutputSchema.parse({ routineId: 'rtn_1' })` is `toStrictEqual({ routineId: 'rtn_1' })`;
    - each fails: `{}`; `{ routineId: '' }`; `{ routineId: 'rtn_1', name: 'Copy of Notify' }`; `{ routineId: 'rtn_1', steps: [] }`.

- [ ] **Step 2: Run it and see it fail**
  Run: `pnpm --filter @ax/routines-contract exec vitest run src/__tests__/duplicate.test.ts`
  Expected: FAIL (the schemas aren't exported).

- [ ] **Step 3: Implement**
  - `export const RoutineDuplicateInputSchema = RoutineKeySchema.extend({ requestId: RoutineOpaqueStringSchema }).strict();`
  - `export const RoutineDuplicateOutputSchema = z.object({ routineId: RoutineOpaqueStringSchema }).strict();`
  - The two `export type … = z.output<…>` lines beside `RoutineSetStepsInput`/`Output`.
  - Doc comment above them, in the file's voice:

    ```
    /**
     * `routines:duplicate` (TASK-953): a person copies their own task, from its
     * page. The copy is a new task of the same kind, paused (not enabled, no
     * next check-in), named "Copy of {name}" (cut to fit the name limit, never
     * inside a character), with the source's definition otherwise: its brief,
     * its schedule and its active hours. A "get-done" task's steps come along
     * unticked, under new ids, each still saying who wrote it. It copies none
     * of the task's state (its report, notes, reading or missed check-ins),
     * nor its finish date, and none of its replies or its history. The answer
     * is the copy's id. The
     * same `requestId` again answers with the same copy; on another task it is
     * refused (`request-conflict`). Who may follows `routines:create` (someone
     * who may manage the agent's tasks; the copy is the agent's owner's on a
     * personal agent, else the caller's), plus `edit` on the source, so only
     * its owner copies it. Someone else's routine, and a default (which no one
     * edits), are `forbidden`; a repeat routine of the caller's own and a
     * missing one are `not-found`; a task whose copy today's rules refuse is
     * `validation`.
     * Neither a tool nor an IPC action, so no model can call it, and no
     * approval: the person makes the copy themselves, and it stays paused
     * until a person resumes it.
     */
    ```

- [ ] **Step 4: Run the contract's tests and build**
  Run: `pnpm --filter @ax/routines-contract exec vitest run`, then `pnpm --filter @ax/routines build`
  Expected: PASS, and the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/routines-contract/src/services.ts packages/routines-contract/src/__tests__/duplicate.test.ts
git commit -m "[TASK-953] Contract: routines:duplicate's input and answer"
```

---

### Task 2: Copy rules and the store's `duplicateAuthored` [tier: sensitive]

**Files:**
- Create: `packages/routines/src/duplicate.ts`
- Modify: `packages/routines/src/types.ts` (`DuplicateResult` after `SetStepsResult`, `:104-111`)
- Modify: `packages/routines/src/store.ts`:
  - imports (`:3-13`: `RoutineDuplicateOutputSchema` from the contract; `copiedSteps`, `duplicateName` from `./duplicate.js`; `DuplicateResult` type);
  - the interface, after `setSteps` (`:106-124`);
  - `parseReceipt` (`:542-548`) and `receiptCopy`'s doc (`:549-572`);
  - a `DuplicateRefused` class after `StepsRefused` (`:669-676`);
  - the method, after `setSteps` (`:1044-1086`).
- Create: `packages/routines/src/__tests__/duplicate-rules.test.ts` (pure), `packages/routines/src/__tests__/duplicate-store.test.ts` (Postgres)

**Interfaces:**
- Consumes: `RoutineDuplicateOutputSchema` (Task 1); `storedSteps`, `newStepId` (`packages/routines/src/steps.ts`); `clampCodeUnits` (`@ax/core`); `ROUTINE_NAME_MAX_CHARS`, `ROUTINE_STEPS_MAX` (contract).
- Produces (Task 3):
  - `duplicate.ts`: `export const DUPLICATE_NAME_PREFIX = 'Copy of ';`, `export function duplicateName(name: string): string`, `export function copiedSteps(value: unknown, newId?: (taken: ReadonlySet<string>) => string): StoredStep[]` (default `newStepId`).
  - `types.ts`: `export type DuplicateResult = { routineId: string; replayed: boolean } | 'not-found' | 'forbidden';` (doc in `SetStepsResult`'s style: `replayed` is for the log line only).
  - `RoutinesStore.duplicateAuthored(input: RoutineKey & Actor & { ownerUserId: string; requestId: string; now: Date }): Promise<DuplicateResult>`.

- [ ] **Step 1: Write the failing pure tests** (`duplicate-rules.test.ts`)
  - `duplicateName`:
    - `'Move the help docs'` → `'Copy of Move the help docs'`;
    - `'a'.repeat(128)` → `'Copy of ' + 'a'.repeat(120)` (and its `length` is 128);
    - `const smile = String.fromCodePoint(0x1F600)`: `'a'.repeat(119) + smile + 'b'.repeat(8)` → `'Copy of ' + 'a'.repeat(119)` (the emoji straddles the cut and goes whole; length 127);
    - `smile + 'a'.repeat(118)` → `'Copy of ' + smile + 'a'.repeat(118)` (length 128, the emoji kept);
    - `duplicateName('Copy of Onboard Acme')` → `'Copy of Copy of Onboard Acme'` (no special case).
  - `copiedSteps`, with `step(id, text, done, addedBy)` building a `StoredStep`:
    - two stored steps, `s000001` done by the agent and `s000002` not done by the person, and a stub `newId` that records the `taken` set it is given and answers `c1`, then `c2` → `toStrictEqual([{ id: 'c1', text: …, done: false, addedBy: 'agent' }, { id: 'c2', text: …, done: false, addedBy: 'person' }])`, and the first `taken` it saw holds `s000001` and `s000002`;
    - with the default `newStepId`, every id matches `/^s[0-9a-z]{6}$/` and none is a source id;
    - a list holding `7`, `{ id: 's000003', text: 'x', done: 'yes', addedBy: 'agent' }`, `{ id: 's000004', text: 'y', done: false, addedBy: 'robot' }` and a second entry with id `s000001` copies only the first `s000001` step (the steps `storedSteps` reads);
    - `null`, `{}` and the string `'[]'` each copy to `[]`;
    - 51 readable steps copy to the first 50, in order;
    - a stored step carrying an extra `note` key copies to exactly `{ id, text, done, addedBy }` (`toStrictEqual`).

- [ ] **Step 2: Run it and see it fail**
  Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/duplicate-rules.test.ts`
  Expected: FAIL (no `duplicate.ts`).

- [ ] **Step 3: Implement `duplicate.ts`**
  - Header doc: what a copy is, in one place (TASK-953); pure, so it is tested without Postgres.
  - `duplicateName(name)` = `DUPLICATE_NAME_PREFIX + clampCodeUnits(name, ROUTINE_NAME_MAX_CHARS - DUPLICATE_NAME_PREFIX.length)`; its doc says why it lives here and not in the contract (row 2).
  - `copiedSteps`: `storedSteps(value)`, `.slice(0, ROUTINE_STEPS_MAX)`, each mapped field by field to `{ id: newId(taken), text, done: false, addedBy }`, where `taken` starts as the read steps' ids and gains each id drawn. Its doc gives row 3's rules (unread entries stay behind; `addedBy` kept because it says who wrote the words).

- [ ] **Step 4: Run it and see it pass**
  Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Write the failing store tests** (`duplicate-store.test.ts`, on `fixture()`)
  - Helpers: `GET_DONE` and `STAY_ON_TOP` as in `set-steps-store.test.ts:13-16` / `set-steps.test.ts:16-23`; `createTask(requestId, definition = GET_DONE)` through `f.store.createAuthored({ ...createInput(requestId), definition })` (owner `'owner'`, made by `'editor'`); `duplicate(key, requestId, actorUserId = 'owner')` calling `f.store.duplicateAuthored({ agentId: key.agentId, routineId: key.routineId, actorUserId, ownerUserId: 'owner', requestId, now: minute(5) })`; `copied(…)` that throws on a string answer; `rowOf(routineId)` (`SELECT *` by SQL); `receipts()` (operation `'duplicate'`, as `set-steps-store.test.ts:26-27`); `writeSteps` (`set-steps-store.test.ts:21-22`).
  - `it('copies a get-done task paused, with the same definition but its name, and its steps unticked under new ids')`:
    - the source holds `s000001` ("Export every article", done, agent) and `s000002` ("Ask Dana to review billing", not done, person);
    - `copied(task, 'd1')` → `routineId` matches `/^rtn_/` and isn't the source's;
    - `findOne` of the copy: `editableDefinition(copy)` equals `{ ...editableDefinition(source), name: 'Copy of Move the help docs', enabled: false }`; `nextRunAt` null; `ownerUserId` `'owner'`; `definitionId` null; its `revision` isn't the source's;
    - its `steps` are the two texts in order, `done: false`, the same `addedBy`, ids matching `/^s[0-9a-z]{6}$/` and neither `s000001` nor `s000002`;
    - the source reads exactly as before.
  - `it('copies a stay-on-top task too')`: the copy's `kind` is `'stay-on-top'` and its steps are `[]`.
  - `it('copies none of the task’s state, replies or history')`:
    - give the source, by SQL: `task_status 'needs-you'`, `task_update`, `task_ask`, `task_reported_at`, `task_report_accepted_at`, `agent_notes 'The refund code is QX7731.'`, `agent_notes_cleared_at`, `task_reading_value 3`, `task_reading_label 'Open tickets'`, `task_reading_reported_at`, `task_misses_in_a_row 2`, `task_miss_reason 'no-report'`, `task_miss_at`, `last_run_at`, `last_status 'error'`, `last_error 'boom'`, `last_warning 'warned'`;
    - set its finish date through the store (`f.store.setFinishBy({ agentId: 'a', routineId: task.routineId, actorUserId: 'owner', finishBy: '2026-11-14' })`, as `finish-by-store.test.ts:21-22` does), and add a reply (`f.store.addReply` as the owner) and a run (`acceptDispatch` as the owner, then `finishDispatch`);
    - the copy's row has every one of those columns `NULL` (`task_misses_in_a_row` 0), `finish_by` `NULL` too, and `task_steps` `[]` here; `findOne` of the copy has `finishBy: null`, while the source keeps `'2026-11-14'`;
    - counts of `routines_v1_replies`, `routines_v1_fires` and `routines_v1_dispatches` for the copy's `routine_id` are all 0;
    - `findOne` of the copy has `task: null` and `noRecentUpdate: null`;
    - `JSON.stringify` of the copy's row doesn't contain `QX7731`.
  - `it('the same request again answers the same copy and makes one row; another request makes another copy')`:
    - `duplicate(task, 'd1')` twice → `{ routineId: X, replayed: false }`, then `{ routineId: X, replayed: true }`;
    - one row named `'Copy of Move the help docs'`;
    - `duplicate(task, 'd2')` → another id, and two such rows;
    - `duplicate(otherTask, 'd1')` rejects `{ toolCode: 'request-conflict' }`.
  - `it('keeps only the copy’s id in its receipt')`: `receipts()` is `[{ operation: 'duplicate', request_id: 'd1', result: { routineId: X } }]`.
  - `it('a repeat routine, a default, a missing task and someone else’s are refused, and nothing is written')`:
    - a repeat routine (`createInput`), a materialized default, and `rtn_missing` each answer `'not-found'`. Make the default as `default-admission-concurrency.test.ts:10-13` does: `f.store.upsertDefault({ ...createInput().definition, name: 'copy-check', trigger: { kind: 'interval', every: '60s' } })`, then `f.store.materializeMissing({ agents: [{ agentId: 'a', ownerUserId: 'owner' }], now })`, then find the row in `f.store.list({ agentId: 'a' })` by `definitionId === defaultRoutineId`;
    - `duplicate(task, 'd9', 'editor')` (made it, doesn't own it) answers `'forbidden'`;
    - the definitions row count is unchanged and `receipts()` is `[]`.
  - `it('a task holding a webhook trigger, which no task can have, is not-found rather than a validation error')`: set the task's `trigger_kind = 'webhook'` and `trigger_spec = '{"kind":"webhook","path":"/hook"}'` by SQL → `'not-found'`.
  - `it('a task today’s rules refuse is a validation error, and nothing is written')`: `good_when = ''` on a get-done row by SQL → rejects `{ toolCode: 'validation' }`; no new row; `receipts()` is `[]`.
  - `it('a task whose copy is too large to save is a validation error on promptBody, and nothing is written')`:
    - `bytes(d) = new TextEncoder().encode(JSON.stringify(RoutineDefinitionSchema.parse(d))).length`;
    - build a get-done definition named `'T'` whose `promptBody` is `'Move the docs. '` repeated, then cut or padded with `x` until `bytes` is exactly `ROUTINE_DEFINITION_MAX_BYTES - 4` (assert it in the test: the copy adds 9 bytes, so it lands 5 over);
    - `createTask` accepts it; `duplicate` rejects `{ toolCode: 'validation', field: 'promptBody' }`; no new row; `receipts()` is `[]`.
  - `it('a retired agent’s task is not-found')`: after `f.store.purgeAgent('a')`, `duplicate` rejects `{ toolCode: 'not-found' }`.

- [ ] **Step 6: Run them and see them fail**
  Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/duplicate-store.test.ts` (or on the shim)
  Expected: FAIL (`duplicateAuthored` is not a function).

- [ ] **Step 7: Implement the store**
  - `parseReceipt`: `if (operation === 'duplicate') return RoutineDuplicateOutputSchema.parse(value);` before the throw. `receiptCopy`'s default branch already stores `{ routineId }` as it is; its doc gains "TASK-953: `duplicate`'s result is the copy's id alone, stored as it is."
  - `class DuplicateRefused extends Error { constructor(readonly reason: 'not-found' | 'forbidden') { super(reason); } }`, with `StepsRefused`'s doc reason (a returned refusal would be stored as a settled receipt).
  - The interface doc: row 4's rules, in `setSteps`' style.
  - The method. The order of the checks is the decision, so here it is:

    ```ts
    async duplicateAuthored(input) {
      // Inside receiptTransaction: the agent fence, then the request's row, then the source FOR SHARE (a copy
      // changes nothing on it). Nothing locks a request row after a routine's, so this adds no deadlock.
      let replayed = false;
      try {
        const key = operationKey(input, 'duplicate', inputHash({ agentId: input.agentId, routineId: input.routineId }));
        const { routineId } = await receiptTransaction(db, key, async trx => {
          const raw = await trx.selectFrom('routines_v1_definitions').selectAll()
            .where('agent_id', '=', input.agentId).where('routine_id', '=', input.routineId).forShare().executeTakeFirst();
          // TASK_KINDS, an explicit allowlist: a repeat routine, a default and a kind this code doesn't know stay.
          if (!raw || raw.definition_id !== null || !isTaskKind(raw.kind)) throw new DuplicateRefused('not-found');
          if (raw.owner_user_id !== input.actorUserId) throw new DuplicateRefused('forbidden');
          // No task has a webhook trigger (validateDefinition): no path, HMAC or credential to copy.
          if (raw.trigger_kind === 'webhook') throw new DuplicateRefused('not-found');
          let source: StoredRoutine;
          try { source = rowToRoutine(raw); } catch (error) { throw validationError(error); }
          const definition = validateDefinition({ ...editableDefinition(source), name: duplicateName(source.name), enabled: false });
          const row = await trx.insertInto('routines_v1_definitions').values({
            ...definitionColumns(definition), agent_id: input.agentId,
            routine_id: opaqueId('rtn'), revision: opaqueId('rev'), owner_user_id: input.ownerUserId, next_run_at: null,
            last_run_at: null, last_status: null, last_error: null, definition_id: null, definition_updated_at: null,
            created_at: input.now, updated_at: input.now, task_steps: JSON.stringify(copiedSteps(raw.task_steps)),
          }).returning('routine_id').executeTakeFirstOrThrow();
          // All the receipt keeps (receiptCopy, parseReceipt).
          return { routineId: row.routine_id };
        }, async () => { replayed = true; });
        return { routineId, replayed };
      } catch (error) {
        if (error instanceof DuplicateRefused) return error.reason;
        throw error;
      }
    },
    ```

    Every column the INSERT leaves out takes its default: no report, notes, reading, misses, pause stamp, clear stamp, last warning or finish date (`finish_by`, TASK-951), and, after a TASK-950 rebase, no claim or completion.

- [ ] **Step 8: Run both files, then the whole routines package**
  Run: the Step 2 and Step 6 commands, then `pnpm --filter @ax/routines exec vitest run`
  Expected: PASS.

- [ ] **Step 9: Rebase onto TASK-950 (only if it merged):** give the source a claim (`task_done_claimed_at`), and add `it('a Done task copies, and the copy isn’t done')` with a source completed through TASK-950's store method: the copy's `task_done_claimed_at`, `task_completed_at` and `task_completed_by_user_id` are `NULL` and it reads as not Done. Don't refuse a Done source.

- [ ] **Step 10: Commit**

```bash
git add packages/routines/src/duplicate.ts packages/routines/src/types.ts packages/routines/src/store.ts packages/routines/src/__tests__/duplicate-rules.test.ts packages/routines/src/__tests__/duplicate-store.test.ts
git commit -m "[TASK-953] Routines store: a person's paused copy of their task, under one receipt"
```

---

### Task 3: `routines:duplicate`, end to end in routines [tier: sensitive]

**Files:**
- Modify: `packages/routines/src/services.ts` (`ROUTINE_SERVICES` `:11-16`; the service after `set-steps`, `:413-430`, before the closing `}` at `:431`)
- Create: `packages/routines/src/__tests__/duplicate.test.ts` (the service over the real store, as `set-steps.test.ts`)
- Modify: `packages/routines/src/__tests__/return-schemas.test.ts:175-184`, `packages/routines/src/__tests__/canary.test.ts` (a new describe at the end, after TASK-951's `:960-998`)

**Interfaces:**
- Consumes: `store.duplicateAuthored` (Task 2); `RoutineDuplicateInputSchema`, `RoutineDuplicateOutputSchema` (Task 1).
- Produces (Task 4): service `routines:duplicate`, input `{ agentId, routineId, requestId }`, answer `{ routineId }`, refusals `SafeToolError` `validation` (input or copy), `forbidden` (field `input`: not the owner, no longer managing the agent's tasks, or a default), `not-found` (field `routineId`: missing, or a repeat routine of the caller's own), and `agents:resolve`'s own refusal.

- [ ] **Step 1: Write the failing service tests** (`duplicate.test.ts`)
  - Harness as `set-steps.test.ts:25-56`: a team agent (`ownerType: 'team'`, `ownerId: 'team-1'`), `reach`, `allowed` and `store` overrides; `order` records `'agents:resolve'` and `'duplicateAuthored'`; `duplicate(input, ctx = as('owner'))`.
  - `it("the owner copies a task, and the answer is the copy's id alone")`: `toStrictEqual({ routineId: expect.stringMatching(/^rtn_/) })`; `order` is `['agents:resolve', 'duplicateAuthored']`; the copy reads (`findOne`) `ownerUserId: 'owner'` (the caller, not `'team-1'`), `enabled: false`, name `'Copy of Move the help docs'`.
  - `it("only the task's owner who may manage the agent's tasks copies it, and the store is never asked otherwise")`:
    - `services({ allowed: false })` → rejects `{ toolCode: 'forbidden' }`, `order` `['agents:resolve']`;
    - `as('teammate')` and `as('editor')` (who made it) → `forbidden`, `order` without `'duplicateAuthored'`;
    - the definitions list (`f.store.list({ agentId: 'a' })`) still holds only the source.
  - `it('someone agents:resolve refuses is refused before anything is read')`: `services({ reach: [] })` → rejects `{ code: 'forbidden' }`; `order` `['agents:resolve']`.
  - `it('a repeat routine and a missing task are not-found')`: a repeat routine → `{ toolCode: 'not-found', field: 'routineId' }` (from the store); `rtn_missing` → the same, with `order` lacking `'duplicateAuthored'` (from `rowFor`).
  - `it('a default is forbidden, as routines:update refuses it, and the store is never asked')`: materialize one as Task 2's store test does (`upsertDefault`, then `materializeMissing` for `'owner'`); `routinePermissions` gives a default no `edit` (`services.ts:31-34`), so it rejects `{ toolCode: 'forbidden' }` with `order` lacking `'duplicateAuthored'`. The store's own `not-found` for a default (Task 2) is the locked re-check behind it.
  - `it('an input the contract refuses is a validation error, and nothing is asked')`: an extra `name`, `requestId: ''`, no `requestId` → `{ toolCode: 'validation' }`; `order` `[]`.
  - `it("answers the copy's id alone, whatever else the store hands over")`: create a real task first (the service reads it with `rowFor` before the store), then `store: { duplicateAuthored: async () => ({ routineId: 'rtn_x', replayed: false, name: 'Copy of …' }) as DuplicateResult }` → `toStrictEqual({ routineId: 'rtn_x' })`.
  - `it('logs one line per copy, ids only, and says when it was a retry')`, as `set-steps.test.ts:122-137`:
    - the task's name and a step's text both hold `QX7731`;
    - the first call logs `routines_task_duplicated` `{ level: 'info', agentId: 'a', routineId: <source>, copyId: <copy>, replayed: false }`, the retry with the same request id the same with `replayed: true`, and both answers are equal;
    - every key is in `['level', 'ts', 'reqId', 'msg', 'agentId', 'routineId', 'copyId', 'replayed']`;
    - no line contains `QX7731`.

- [ ] **Step 2: Run them and see them fail**
  Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/duplicate.test.ts`
  Expected: FAIL (no `routines:duplicate` service).

- [ ] **Step 3: Implement**
  - `ROUTINE_SERVICES` gains `'duplicate'` after `'set-finish-by'`.
  - `register('duplicate', C.RoutineDuplicateInputSchema, C.RoutineDuplicateOutputSchema, …)`, in this order:
    1. `const a = await access(ctx, input.agentId); requireAllowed(a.allowed);` (as `create`);
    2. `requireAllowed(routinePermissions(await rowFor({ agentId: input.agentId, routineId: input.routineId }), ctx.userId, a.allowed).edit);`
    3. `store.duplicateAuthored({ agentId, routineId, actorUserId: ctx.userId, ownerUserId: a.agent.ownerType === 'user' ? a.agent.ownerId : ctx.userId, requestId, now: now() })`;
    4. `'not-found'` → `new SafeToolError('not-found', 'routineId')`; `'forbidden'` → `new SafeToolError('forbidden', 'input')`;
    5. `ctx.logger.info('routines_task_duplicated', { agentId, routineId, copyId: outcome.routineId, replayed: outcome.replayed })`;
    6. return `{ routineId: outcome.routineId }`, field by field.
  - The comment above it, in the file's style: a person copies their own task from its page; who may (create's rule plus `edit`, the store deciding the owner again under the lock); neither a tool nor an IPC action, so no model can call it; no approval, because the person is the author and the copy stays paused until a person resumes it; the log line carries ids and the replay flag, never the name or steps.

- [ ] **Step 4: Pin it in `return-schemas.test.ts`**
  - The count test (`:175`) title gains "and a person's copy of a task"; `toHaveLength(22)` → `toHaveLength(23)` (`:176`); add `expect(ROUTINE_SERVICES).toContain('routines:duplicate')` after the `set-finish-by` line (`:184`).
  - New `it("answers a copy with its id alone (TASK-953)")`: `C.RoutineDuplicateOutputSchema.parse({ routineId: 'rtn_1' })` is `toStrictEqual`; `{ routineId: 'rtn_1', name: 'Copy of Notify' }` throws.

- [ ] **Step 5: Write the canary** (`canary.test.ts`, `describe('duplicate canary (TASK-953)')`, after the TASK-951 describe)
  - `it('the owner copies a get-done task: paused, its steps unticked; resumed, its first check-in lists them and no notes')`:
    1. Make the task on the team agent exactly as the TASK-949 canary does (`routine_create` held, approved once, `h.advance(11_000)`, executed).
    2. First check-in (`ch.checkIn(task, 'run-1', …)`): `routine_report` with `notes: 'The billing images move first.'` and `steps: [{ op: 'add', text: 'Export every article from the old help center', done: true }, { op: 'add', text: 'Upload them to the new site' }]` → `toStrictEqual({ recorded: true, steps: { applied: 2, skipped: 0 } })`; poll `store.recentFires(task)` to length 1. Then give it a finish date: `routines:set-finish-by` as `h.owner` `{ agentId, routineId, finishBy: '2026-11-14' }`, as the TASK-951 canary does.
    3. `routines:duplicate` as `h.owner` `{ agentId: task.agentId, routineId: task.routineId, requestId: 'copy-1' }` → `{ routineId: copyId }`.
    4. A teammate can't: `routines:duplicate` as `h.teamMember` (requestId `'copy-tm'`) rejects `{ toolCode: 'forbidden' }`.
    5. `routines:get` of the copy as the owner: `toMatchObject({ name: 'Copy of Move the help docs', enabled: false, nextRunAt: null, kind: 'get-done', goodWhen: task.goodWhen, promptBody: task.promptBody, trigger: task.trigger, task: null, finishBy: null })`, and `steps` is both texts, `done: false`, `addedBy: 'agent'`.
    6. Resume it as the owner: `routines:update` `{ agentId, routineId: copyId, requestId: 'resume-copy', expectedRevision: copy.revision, patch: { enabled: true } }`.
    7. `ch.checkIn(resumed, 'copy-run-1', …)` reporting on track. Its `message` contains `'The task’s steps, 0 of 2 done.'`, `` `- [ ] ${copy.steps[0]!.id} (you added this):\n  > Export every article from the old help center` ``, the same for the second step, `'You have no saved notes yet.'` and `'No earlier reports yet.'`, and does not contain `'The billing images move first.'`.
    8. The source still lists its first step done.

- [ ] **Step 6: Run the service, pins and canary, then the whole package**
  Run: `pnpm --filter @ax/routines exec vitest run src/__tests__/duplicate.test.ts src/__tests__/return-schemas.test.ts src/__tests__/canary.test.ts`, then `pnpm --filter @ax/routines exec vitest run`
  Expected: PASS.

- [ ] **Step 7: Rebase onto TASK-950 (only if it merged):** recount `ROUTINE_SERVICES` (22 on d892597b8, plus `complete` and `reopen`, plus `duplicate`: 25) and keep every `toContain`.

- [ ] **Step 8: Commit**

```bash
git add packages/routines/src/services.ts packages/routines/src/__tests__/duplicate.test.ts packages/routines/src/__tests__/return-schemas.test.ts packages/routines/src/__tests__/canary.test.ts
git commit -m "[TASK-953] routines:duplicate: a task's owner copies it, paused, with no approval"
```

---

### Task 4: channel-web server: the duplicate route and the manifest [tier: sensitive]

**Files:**
- Modify: `packages/channel-web/src/server/routes-workspace.ts`:
  - the route list (`:2-14`, a line after `/finish-by` `:13`);
  - the security posture: "the task page's six routes" (`:64-67`), and after the `/finish-by` sentence ("`/finish-by` is a write that does read first", `:85-90`);
  - local hook types after `TaskSetFinishByOutput` (`:881`);
  - a body reader after `readTaskFinishByBody` (`:3792-3797`);
  - the handler after `setTaskFinishBy` (`:7783-7861`), the template it follows;
  - the route table after `/finish-by` (`:10237-10243`).
- Modify: `packages/channel-web/src/server/plugin.ts` (manifest comment after the TASK-951 paragraph `:84-88`; optional call after `routines:set-finish-by` `:375-382`)
- Modify: `packages/channel-web/src/lib/workspace-types.ts` (`TaskDuplicateResponse` after `TaskStepsResponse` `:1508-1511`; the `permissions` doc `:1536`)
- Test: `packages/channel-web/src/__tests__/server/routes-workspace-task.test.ts`, `packages/channel-web/src/__tests__/server/plugin.test.ts` (after the `routines:set-finish-by` entry, `:812-816`), `packages/channel-web/src/__tests__/server/routes-workspace-registration.test.ts:69`

**Interfaces:**
- Consumes: hook `routines:duplicate`, `RoutineDuplicateInputSchema`, `RoutineDuplicateOutputSchema` (Tasks 1, 3).
- Produces (Task 5):
  - `POST /api/workspace/tasks/:agentId/:routineId/duplicate`, body `{ requestId: string }`;
  - 200 `TaskDuplicateResponse` (`workspace-types.ts`: `export interface TaskDuplicateResponse { routineId: string }`);
  - refusals: 400 `missing-task-id`, `invalid-json`, `invalid-body`, `duplicate-invalid`; 403 `task-duplicate-not-allowed`; 404 `agent-not-found`, `task-not-found`; 503 `task-duplicate-unavailable`. The page words each from its status alone.

- [ ] **Step 1: Write the failing route tests**
  - Harness (`routes-workspace-task.test.ts`):
    - the file header names the new route and its stub;
    - `World` gains `duplicateAnswer: RoutineDuplicateOutput` (default `{ routineId: 'COPY-ID-1' }`) and `duplicateFailure: Error | null`, beside `finishByFailure` (`:205`, default `:246`);
    - `setup()` registers `routines:duplicate` unless absent, after the `routines:set-finish-by` stub (`:377-395`): it records `duplicateCalls`, pushes `'routines:duplicate'` onto `order`, runs `parseRoutineInput(RoutineDuplicateInputSchema, raw)` first, then throws `duplicateFailure` or answers `duplicateAnswer`, with `{ returns: RoutineDuplicateOutputSchema }` unless `world.unvalidated`;
    - a `duplicate(params = KEY, body = { requestId: 'req-1' })` request helper beside `finishBy` (`:430`);
    - `'routines:duplicate'` joins the "without routines at all" list (`:1046-1056`).
  - `describe('POST /api/workspace/tasks/:agentId/:routineId/duplicate (TASK-953)')`. Each test checks the status, the body and what the hooks saw. Every test that gets past the 503 check needs a task alice owns, because `ownTaskOr404` reads it before the hook runs: `rows: [stored({ agentId: 'a1', routineId: 't1' })]` (the `/steps` tests run with no rows, so don't copy their setups as they are). The `/finish-by` tests (`:1674` on) are the closer model.
    - `401s without a session, and reads nothing`.
    - `400s a body that isn't JSON` → `invalid-json`; `400s a body of the wrong shape, before the agent is read` → `invalid-body` for `[]`, `{}`, `{ requestId: '' }`, `{ requestId: 7 }` and `null`; `resolveCalls` and `duplicateCalls` empty.
    - `503s without routines:duplicate, before reading the agent` → `task-duplicate-unavailable`, `resolveCalls` empty.
    - `404s someone agents:resolve refuses, and never calls the hook` → `agent-not-found`.
    - `404s a task that isn't the caller's, and a repeat routine, before the hook is asked` → `task-not-found`, `duplicateCalls` empty, `order` `['routines:get']`, for:
      - a stay-on-top task bob owns on `TEAM_AGENTS` (`stored({ agentId: 'team', routineId: 't1', ownerUserId: 'bob' })`, `managers: { team: ['bob'] }`, viewer alice, params `{ agentId: 'team', routineId: 't1' }`);
      - a repeat routine alice owns (`stored({ kind: 'repeat', goodWhen: null })`).
    - `copies the caller's own task: 200 with the copy's id alone, and the hook gets only the address's ids and the request id`:
      - body `{ requestId: 'q', agentId: 'other', routineId: 'other', name: 'Mine' }`;
      - `toStrictEqual({ routineId: 'COPY-ID-1' })`;
      - `duplicateCalls[0]` is `{ userId: 'alice', agentId: 'a1', input: { agentId: 'a1', routineId: 't1', requestId: 'q' } }`;
      - `order` is `['routines:get', 'routines:duplicate']`.
    - `403s when the service says the owner may not` → `duplicateFailure` `new SafeToolError('forbidden', 'input')` → 403 `task-duplicate-not-allowed`.
    - `400s what the service refuses as invalid` → `new SafeToolError('validation', 'promptBody')`, and a request id of 257 characters (refused by the stub's own contract check), each → 400 `duplicate-invalid`.
    - `404s a task that went meanwhile` → `new SafeToolError('not-found', 'routineId')` → 404 `task-not-found`.
    - `fails the request for anything else` → `new SafeToolError('request-conflict', 'requestId')` and `new Error('boom')` reject the handler (as the steps route's test does).
    - `answers the copy's id alone, whatever else the hook says` → `unvalidated: true`, `duplicateAnswer` `{ routineId: 'COPY-ID-1', name: 'Copy of Zero open tickets' }` (cast) → body `toStrictEqual({ routineId: 'COPY-ID-1' })`.
  - `plugin.test.ts`: the exact list gains, after `routines:set-finish-by`:
    `{ hook: 'routines:duplicate', degradation: 'Duplicate on the task page (POST /api/workspace/tasks/:agentId/:routineId/duplicate) answers 503 and makes no copy' }`.
  - `routes-workspace-registration.test.ts`: `expect(routes).toContain('POST /api/workspace/tasks/:agentId/:routineId/duplicate')`.

- [ ] **Step 2: Run them and see them fail**
  Run: `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-workspace-task.test.ts src/__tests__/server/plugin.test.ts src/__tests__/server/routes-workspace-registration.test.ts`
  Expected: FAIL (no handler, no manifest entry).

- [ ] **Step 3: Implement**
  - `readTaskDuplicateBody(parsed: unknown): { requestId: string } | null`: an object (not an array) with a non-empty string `requestId`; anything else in the body is left behind. Doc in `readTaskStepsBody`'s style.
  - Local types: `interface TaskDuplicateInput extends TaskKeyInput { requestId: string }` and `interface TaskDuplicateOutput { routineId: string }` (the bus has parsed the answer through the service's `returns`).
  - `taskDuplicate(req, res)`:
    1. `authOr401`;
    2. `taskKeyOr400`;
    3. JSON (`invalid-json`);
    4. `readTaskDuplicateBody` (`invalid-body`);
    5. `bus.hasService('routines:duplicate')`, else 503 `task-duplicate-unavailable`;
    6. `const own = await ownTaskOr404(userId, key, res); if (own === null) return;`
    7. `bus.call<TaskDuplicateInput, TaskDuplicateOutput>('routines:duplicate', own.ctx, { agentId: key.agentId, routineId: key.routineId, requestId: body.requestId })`;
    8. `SafeToolError` `validation` → 400 `duplicate-invalid`, then `SafeToolError` `forbidden` → 403 `task-duplicate-not-allowed` (both checked before `isTaskRefusal`), then `isTaskRefusal` → 404 `task-not-found`, else rethrow;
    9. 200 `{ routineId: out.routineId } satisfies TaskDuplicateResponse`.
  - Its doc comment says: the order above; it reads the task first, as the page does, so a stranger, a teammate and a repeat routine get the page's 404 and only the owner's `forbidden` is a 403; nothing in the body but the request id is forwarded; CSRF is @ax/http-server's global guard, met by `workspace-api`'s write headers.
  - Route table entry after `/finish-by`: `// TASK-953 — the task's owner copies it, paused. The service decides who may; the route reads the task first.`
  - `plugin.ts`: the declaration above, with a comment in the `set-finish-by` style; the manifest comment gains "TASK-953 adds no hard call either: a task's owner copies it through the optional routines:duplicate, answering 503 without it."
  - Header and posture (rule 5): the route list gains `POST /api/workspace/tasks/:agentId/:routineId/duplicate — copy that task, paused, its steps unticked (TASK-953)` after `/finish-by`; "the task page's six routes" becomes seven, naming `/duplicate` (TASK-953); after the `/finish-by` sentence add: "`/duplicate` reads first too, through `ownTaskOr404`, so a stranger, a teammate and a repeat routine get the page's 404 before the service is asked, and only the owner's `forbidden` is a 403."
  - `workspace-types.ts`: `TaskDuplicateResponse` with a doc ("`POST …/duplicate`'s answer (TASK-953): the copy's id, which the page opens"); the `permissions` doc becomes "fire: start a check-in. stop: pause. edit: resume, and copy the task (TASK-953). As the routines services decide them."

- [ ] **Step 4: Run the three files, then the server suite and types**
  Run: the Step 2 command, then `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server` (with Docker down, add the six `--exclude` flags) and `pnpm --filter @ax/channel-web exec tsc --build`
  Expected: PASS, `manifest-declarations.test.ts` included.

- [ ] **Step 5: Rebase onto TASK-950 (only if it merged):** keep its manifest entries, route-table entries and registration pins beside this card's.

- [ ] **Step 6: Run the `security-checklist` skill** over the whole branch diff so far (Tasks 1-4), starting from the block under "Security checklist". Record any finding it raises as a decisions-shard row and fix it test-first in its own commit.

- [ ] **Step 7: Commit**

```bash
git add packages/channel-web/src/server packages/channel-web/src/lib/workspace-types.ts packages/channel-web/src/__tests__/server
git commit -m "[TASK-953] channel-web: POST /api/workspace/tasks/:agentId/:routineId/duplicate"
```

---

### Task 5: channel-web client: `duplicateTask`, ⋯ › Duplicate, and the one-time line [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/workspace-api.ts` (after `setTaskFinishBy`, `:1265-1275`)
- Modify: `packages/channel-web/src/components/workspace/TaskPage.tsx`:
  - the header doc (`:10-13`, `:31-37`, `:43-50`, `:68-74`);
  - copy and `actionNote` (`:124-177`);
  - `useTaskActions` (`:208-266`) and `useFocusAfterPress` (`:268-294`);
  - `TaskPage`'s props and wiring (`:296-398`);
  - `TaskActions` and its doc (`:400-458`);
  - `TaskBody`, after the meta block, which now holds `TaskFinishDate` (`:547-580`).
- Modify: `packages/channel-web/src/components/workspace/WorkspaceShell.tsx` (state near the route state `:244-258`; the `TaskPage` render `:1008-1016`)
- Test: `packages/channel-web/src/lib/__tests__/workspace-api-task.test.ts`, `packages/channel-web/src/components/workspace/__tests__/TaskPage.test.tsx`, `packages/channel-web/src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx`

**Interfaces:**
- Consumes: the route and `TaskDuplicateResponse` (Task 4).
- Produces: `workspaceApi.duplicateTask(agentId: string, routineId: string, input: { requestId: string }): Promise<TaskDuplicateResponse>`; `TaskPage` props `onDuplicated: (routineId: string) => void` (the copy's id, same agent) and `justCopied?: boolean` (default false).

**The copy (exact):**
- ⋯ button: `aria-label="More actions"`; its one item: `Duplicate`.
- One-time line, a default `Alert`: `This is a paused copy. Change what you need, then press Resume.`, then the link `Change it in {agentName}’s settings`.
- Duplicate failures, each an `Alert` in the page's notice slot:
  - not confirmed (no answer, a 5xx, a 408 or 429, or an answer that can't be read): `We couldn’t confirm the copy was made. Try again, and it won’t be made twice.`;
  - 401: `HTTP_SESSION_ENDED`, `default` register;
  - 403: `You can’t copy this task, because you no longer manage this agent’s tasks.`;
  - 400: `We couldn’t copy this task as it is. Change it in {agentName}’s settings first.`;
  - 404: `LOAD_COPY.gone` (`We couldn’t find this task. It may have been deleted, or it belongs to someone else.`);
  - any other answered refusal: `We couldn’t copy this task just now. Try again.`
  - All but the 401 are `destructive`.
- `actionNote` (row 7). Every line shown without `edit` names copying; the rest are unchanged:
  - auto-paused, no `edit`: `` `${AUTO_PAUSED_LINE} Only someone who manages this agent’s tasks can resume or copy it.` ``;
  - paused, no `edit`: `Paused. Only someone who manages this agent’s tasks can resume or copy it.`;
  - running, no `fire`, no `edit`: `You can’t start or pause this task’s check-ins, or copy the task, because you no longer manage this agent’s tasks.`;
  - running, no `fire`, with `edit`: unchanged (`You can’t start or pause this task’s check-ins, because you no longer manage this agent’s tasks.`);
  - running, `fire`, no `edit` (no service produces it for a task, but the page shouldn't stay silent): `You can’t copy this task, because you no longer manage this agent’s tasks.` (the 403's constant).

- [ ] **Step 1: Write the failing `duplicateTask` tests** (`workspace-api-task.test.ts`, `describe('workspaceApi.duplicateTask (TASK-953)')` after `setTaskFinishBy`'s (`:411`), shaped as `setTaskSteps`' at `:363-410`):
  - `posts only the request id to the task’s duplicate route, with the write headers` → URL `/api/workspace/tasks/a1/t1/duplicate`, `POST`, `x-requested-with: ax-admin`, body `toStrictEqual({ requestId: 'req-1' })`;
  - `answers the copy’s id` → `{ routineId: 'rtn_2' }`;
  - `it.each` `a 200 it can’t read is a WorkspaceShapeError: %s` for `{}`, `{ routineId: '' }`, `{ routineId: 7 }`, `[]`, `null`;
  - `a refusal is a WorkspaceApiError carrying its status` → a 403 response.

- [ ] **Step 2: Run them and see them fail**
  Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/workspace-api-task.test.ts`
  Expected: FAIL (`duplicateTask` is not a function).

- [ ] **Step 3: Implement `duplicateTask`** after `setTaskFinishBy`: `req` `POST` to `` `${taskPath(agentId, routineId)}/duplicate` `` with `body: { requestId: input.requestId }`, read with `checkedRead<TaskDuplicateResponse>` requiring a record (not an array) whose `routineId` is a non-empty string. Doc in `setTaskSteps`' style. Run Step 2's command. Expected: PASS.

- [ ] **Step 4: Invoke the `shadcn` and `ux-design` skills** for the ⋯ menu and the one-time line before writing the page tests.

- [ ] **Step 5: Write the failing page tests** (`TaskPage.test.tsx`)
  - Setup:
    - the `workspace-api` mock (`:26-38`) gains `duplicateTask: vi.fn()` after `setTaskFinishBy` (`duplicateMock`), and the file's `beforeEach` (`:172-180`), which resets each mock by name, resets `duplicateMock` too, or a leftover `mockRejectedValueOnce` leaks into the next test;
    - `renderPage(over: { justCopied?: boolean } = {})` also passes `onDuplicated` (`vi.fn`) and returns it, and passes `justCopied={over.justCopied ?? false}`: `exactOptionalPropertyTypes` is on (`tsconfig.base.json:14`) and channel-web type-checks its tests, so an explicit `undefined` fails `tsc --build`;
    - `chooseDuplicate()` focuses the `More actions` button, sends `ArrowDown` and clicks the `Duplicate` menuitem (TaskSteps' `choose`, `TaskSteps.test.tsx:102-107`). The action runs after the menu hands focus back, so await the mock with `waitFor`;
    - reuse this file's own `dropFocusOnBody` and `settled` helpers (`:156-171`).
  - `it('⋯ › Duplicate copies the task with a request id, and hands the copy’s id to the shell without reading the task again')`:
    - `duplicateMock` resolves `{ routineId: 'rtn_copy' }`;
    - it was called once with `('a1', 't1', { requestId: expect.any(String) })`;
    - `onDuplicated` was called with `'rtn_copy'`;
    - `taskMock`'s call count is what it was before the press.
  - `it('a press whose answer never came keeps its request id, and the retry sends the same one')`:
    - first `mockRejectedValueOnce(new WorkspaceApiError('/x', 503))` → an alert with the not-confirmed copy;
    - second press resolves → the same `requestId` both times, and `onDuplicated` was called.
  - `it('an answered refusal ends the request, so the next press sends a new id')`: a 403 → an alert with the 403 copy; the next press's `requestId` differs.
  - `it.each` `'a refused copy says why: %s'` for 400 (with `Quill`), 404, 401 (with `HTTP_SESSION_ENDED`, and its alert's class lacks `destructive`) and 409 (the "just now" copy).
  - `it('after a failed Duplicate, focus goes back to the ⋯')`: a 403, with focus dropped on `<body>` (`dropFocusOnBody`) while the press is out → once it settles, `document.activeElement` is the `More actions` button.
  - The no-manage cases (`:580-606`): `NO_MANAGE_NOTE` and `PAUSED_NO_EDIT_NOTE` (`:62-64`) take the new strings, each row's `buttons` gains `'More actions'` (disabled, described by the note), and the auto-paused case at `:1259` takes its new string.
  - `it('without edit but able to start check-ins, only the ⋯ is off, and the note says why')`: `{ fire: true, stop: true, edit: false }`, running → `More actions` disabled with description `You can’t copy this task, because you no longer manage this agent’s tasks.`; `Check now` and `Pause` enabled, with no `aria-describedby`.
  - `it('Duplicate is offered on a paused task and on a get-done task')`: both have `More actions` enabled and the `Duplicate` item.
  - `it('the copy’s page says once that it’s a paused copy, with the link to its agent’s settings')`:
    - `renderPage({ justCopied: true })` on a paused task with `edit` → the alert's text, and `getByRole('link', { name: 'Change it in Quill’s settings' })`, whose click calls `onNavigate` with `{ kind: 'agent-settings', id: 'a1', section: 'routines' }`;
    - no line: without `justCopied`; with it on a running task; and with it on a paused task without `edit`.
  - `it('Resume uses the line up: it doesn’t come back when the copy is paused again')`: `renderPage({ justCopied: true })` on the paused copy; press Resume (`updateMock` resolves, the re-read answers it running) → no line; press Pause (the re-read answers it paused) → still no line.

- [ ] **Step 6: Run them and see them fail**
  Run: `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/TaskPage.test.tsx`
  Expected: FAIL.

- [ ] **Step 7: Implement the page**
  - `ActionKind` gains `'duplicate'`; `UNCONFIRMED` and `REFUSED` gain its strings; `COPY_NOT_ALLOWED` is the 403 line and the fire-without-edit note; `actionNote` as listed.
  - `duplicateFailure(e: unknown, agentName: string): { text: string; register: AlertRegister }` words a failure per the list, using `isConfirmedRefusal` from `@/lib/http`.
  - `useTaskActions(agentId, routineId, detail, refresh, poll, onDuplicated)`. For `'duplicate'`:
    - call `workspaceApi.duplicateTask(agentId, routineId, { requestId: op.requestId })`;
    - on success, drop the pending press, call `onDuplicated(copyId)`, and skip the `finally` block's `refresh()`;
    - on failure, keep the pending press when `!isConfirmedRefusal(e)`, else drop it, and use `duplicateFailure` for the notice.
    - The other three kinds don't change. The pending-press rule (`pending.current?.kind === kind`) and the one-press-at-a-time guard cover Duplicate as they are.
  - `useFocusAfterPress` gains a `more` ref and a `'more'` slot. The order to try is the pressed control, then the other two in header order, then the note, and focus still moves only from `<body>` or one of the three.
  - `TaskActions` (doc: "Check now, then Pause or Resume, then ⋯ …"), after the toggle:
    - `<DropdownMenu modal={false}>` (the #998 freeze rule) with `DropdownMenuTrigger asChild` over `Button variant="ghost" size="icon" aria-label="More actions" disabled={!permissions.edit || busy} aria-describedby={describedBy(!permissions.edit)}`;
    - its icon is `<MoreHorizontal aria-hidden="true" />`, or a `Spinner` while `acting === 'duplicate'`;
    - `DropdownMenuContent align="end"` with `TaskSteps`' `onCloseAutoFocus` pattern (`TaskSteps.tsx:572-581`): the chosen action runs in a `setTimeout` after focus is back on the trigger;
    - one `DropdownMenuItem` `Duplicate`, whose `onSelect` chooses `() => onPress('duplicate')`.
  - `onPress` maps `'duplicate'` to the `'more'` slot.
  - `TaskPage` keeps the flag it was mounted with as a one-way latch: `const [copyLine, setCopyLine] = useState(justCopied)`, and an effect clears it the first time the task reads as running (`detail?.enabled`), so Resume uses it up and a later Pause doesn't bring it back. `TaskBody` gains `copyLine: boolean`. After the meta/note/status block and before the notice, when `copyLine && !detail.enabled && detail.permissions.edit`, render the default `Alert` with the line and the link, built like the brief's settings link (`routeLinkProps({ kind: 'agent-settings', id: agentId, section: 'routines' }, onNavigate)`).
  - The header doc (rule 5): "the page's two actions" becomes three controls (Check now, Pause or Resume, and ⋯ with Duplicate, TASK-953). THE ACTIONS adds that Duplicate goes through `workspaceApi` to the page's own route and is worded from the status. A PRESS WHOSE ANSWER NEVER CAME applies to Duplicate too: a retry answers the first press's copy. WHERE FOCUS GOES names the ⋯.

- [ ] **Step 8: Run the page tests** (Step 6's command). Expected: PASS.

- [ ] **Step 9: Write the failing shell test** (`WorkspaceShellRouting.test.tsx`; its `workspace-api` mock `:30-64` gains `duplicateTask: vi.fn()`)
  - `it('Duplicate opens the copy at its own address, which says once that it’s a paused copy')`:
    - `taskMock` answers by routine id: `t1` → `TASK_DETAIL`; `t2` → a paused copy named `'Copy of Zero open support tickets'` with `edit` (`nextCheckAt: null`);
    - `duplicateTask` resolves `{ routineId: 't2' }`;
    - `renderAt('/workspace/tasks/a1/t1')`, choose ⋯ › Duplicate;
    - the pathname becomes `/workspace/tasks/a1/t2`, the copy's heading shows, and so does the line.
  - `it('the line doesn’t come back after Back and Forward, or on opening the copy’s address again')`:
    - after the same flow, `window.history.back()` with a `popstate` (the file's way, `:388-391`) shows the source, and `forward()` with a `popstate` shows the copy without the line;
    - unmount, then `renderAt('/workspace/tasks/a1/t2')` (a reload): the copy, without the line.

- [ ] **Step 10: Run it and see it fail**
  Run: `pnpm --filter @ax/channel-web exec vitest run src/components/workspace/__tests__/WorkspaceShellRouting.test.tsx`
  Expected: FAIL (the shell passes no `onDuplicated`, so nothing navigates).

- [ ] **Step 11: Implement the shell**
  - `const [freshCopy, setFreshCopy] = useState<string | null>(null)`, a comment over it (row 9: memory only, never the URL; cleared once the route leaves that task), and an effect on `[route, freshCopy]` that clears it whenever `route` isn't `{ kind: 'task' }` with that key (`JSON.stringify([route.agentId, route.routineId])`, TaskPage's own key).
  - `TaskPage` gets `justCopied={freshCopy === <the route's key>}` and `onDuplicated={(copyId) => { setFreshCopy(JSON.stringify([route.agentId, copyId])); navigate({ kind: 'task', agentId: route.agentId, routineId: copyId }); }}`. Both setters run in that one callback, so React batches them and the effect never sees the flag beside the source's route; the shell test pins it.

- [ ] **Step 12: Run the client files, then channel-web and its types**
  Run: Steps 2, 6 and 10's files, then `pnpm --filter @ax/channel-web exec vitest run` (with Docker down, the six `--exclude` flags) and `pnpm --filter @ax/channel-web exec tsc --build`
  Expected: PASS. (No `TaskPage` test counts the header's buttons today, so the ⋯ breaks none by its presence; the focus test at `TaskPage.test.tsx:533-550` still lands on the note, since a viewer without `edit` has the ⋯ off too.)

- [ ] **Step 13: Rebase onto TASK-950 (only if it merged):**
  - its Done header (only Reopen) gains ⋯ › Duplicate, enabled with `edit`;
  - its no-edit Done note becomes "… can reopen or copy it.";
  - add `it('Duplicate is offered on a Done task')`. Copying a finished plan is the main use.

- [ ] **Step 14: Commit**

```bash
git add packages/channel-web/src/lib/workspace-api.ts packages/channel-web/src/components/workspace packages/channel-web/src/lib/__tests__/workspace-api-task.test.ts
git commit -m "[TASK-953] Task page: ⋯ › Duplicate opens a paused copy, which says so once"
```

---

### Task 6: Settings editor: "Going well when" and the kind line [tier: mechanical]

**Files:**
- Modify: `packages/channel-web/src/components/routines/RoutineEditor.tsx` (imports `:1-32`; `RoutineForm`: after `validation`/`dirty` `:247-251`, the intro `:351-353`, after the "What should {agent} do?" field `:368-380`)
- Test: `packages/channel-web/src/components/routines/__tests__/RoutineEditor.test.tsx`

**Interfaces:**
- Consumes: `isTaskKind`, `ROUTINE_GOOD_WHEN_MAX_CHARS` (contract); `TASK_KIND_LABELS` (`@/lib/task-kinds`). No other task's code.

- [ ] **Step 1: Invoke the `shadcn` and `ux-design` skills** for the field and the kind line.

- [ ] **Step 2: Write the failing tests** (`describe("a task's Going well when (TASK-953)")`)
  - `const task = { ...row, kind: 'get-done' as const, goodWhen: 'Every article is on the new site.' }`; `editTask(view = task)` renders edit mode with `routineApi.get` resolving `view`, then awaits `findByDisplayValue(view.goodWhen)`.
  - `it('shows Going well when for a task, filled in, after what the agent should do, and names its kind')`:
    - `getByLabelText('Going well when')` is a textarea with `rows` `"2"`;
    - it follows the `What should Caveman do?` textarea in document order (`compareDocumentPosition` gives `DOCUMENT_POSITION_FOLLOWING`);
    - `getByText('Get something done')`;
    - a stay-on-top task shows `Stay on top of something`.
  - `it('shows neither for a repeat routine, or when creating one')`: `edit()` with the repeat fixture, and create mode: no `Going well when` field, no `Get something done`, no `Stay on top of something`.
  - `it('saves Going well when only when it changed')`:
    - Save is disabled at first;
    - after changing the field to `'Every article is live.'` and pressing Save, `routineApi.update`'s first call has `patch` `toStrictEqual({ goodWhen: 'Every article is live.' })`.
  - `it('an emptied Going well when shows the contract’s own message, marks the field, and keeps Save off')`:
    - after emptying it, `getByRole('status')` has text `Say how we’ll know this task is going well.`;
    - the field has `aria-invalid="true"`;
    - Save is disabled and `routineApi.update` was never called.

- [ ] **Step 3: Run them and see them fail**
  Run: `pnpm --filter @ax/channel-web exec vitest run src/components/routines/__tests__/RoutineEditor.test.tsx`
  Expected: FAIL.

- [ ] **Step 4: Implement**
  - After `dirty`: `const firstIssue = !validation.success && dirty ? validation.error.issues[0] : undefined;` and `const goodWhenInvalid = firstIssue?.path[0] === 'goodWhen';`. Add a comment: neither the host (core's `TOOL_FIELDS`) nor `RoutineApiError` can name `goodWhen`, so its invalid state is the contract's own check here, which already keeps Save off (row 10).
  - Before the intro paragraph: `{isTaskKind(form.kind) && <p className="text-sm text-muted-foreground">{TASK_KIND_LABELS[form.kind]}</p>}`.
  - After the "What should {agent} do?" `Field`, when `isTaskKind(form.kind)`, a `Field` (`data-invalid={goodWhenInvalid || undefined}`) holding:
    - `FieldLabel htmlFor={`${id}-goodWhen`}` `Going well when`;
    - `Textarea id={`${id}-goodWhen`} rows={2} maxLength={ROUTINE_GOOD_WHEN_MAX_CHARS} value={form.goodWhen ?? ''} onChange={(e) => update('goodWhen', e.target.value)} disabled={disabled} aria-invalid={goodWhenInvalid || undefined}`.
  - `changed()` already diffs `goodWhen`; create mode's form is always repeat, so it never shows.

- [ ] **Step 5: Run the file, the routines components and types**
  Run: the Step 3 command, `pnpm --filter @ax/channel-web exec vitest run src/components/routines src/components/admin` and `pnpm --filter @ax/channel-web exec tsc --build`
  Expected: PASS (`DefaultRoutinesSection` shares `RoutineForm`, always repeat).

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/routines/RoutineEditor.tsx packages/channel-web/src/components/routines/__tests__/RoutineEditor.test.tsx
git commit -m "[TASK-953] Settings: a person edits a task's Going well when, and sees its kind"
```

---

### Task 7: Docs: the design says what was built [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md`

- [ ] **Step 1: Write the notes, as built**
  - `:32` (Resume here, "Now: §12 PR 3 …"): before "Mark done (TASK-950) comes next.", add "TASK-953 adds Duplicate task (⋯ › Duplicate on a task's page) and makes "Going well when" editable in Settings;". Keep TASK-950's clause at a rebase.
  - §3.3, after the PR 2 notes (`:226-228`), a new note: `> PR 3 (TASK-953): ⋯ holds one item for now, Duplicate. It makes a paused copy named "Copy of {name}" with the same brief, schedule and active hours, and a get-done task's steps unticked, each still labelled by who wrote it. It copies none of the task's state, its finish date, its replies or its history. The person lands on the copy's page ("This is a paused copy. Change what you need, then press Resume."), changes what they need and presses Resume. No approval, because the person made it. Until PR 4's ⋯ › Edit, a task's brief, "Going well when" included, is changed in the agent's settings.`
  - §4.5's Hooks row (`:478`): add `routines:duplicate` (a person's paused copy of their own task, TASK-953).
  - §7, at the end of the steps paragraph (`:660-661`): "Duplicating a task (TASK-953) carries its steps into the copy, unticked and still labelled by who wrote them, so an injected step stays visible and deletable there too, and the copy stays paused until a person resumes it."
  - §9, after TASK-951's note (`:726`): `PR 3 (TASK-953): The same plan every week → ⋯ › Duplicate on the task page: a paused "Copy of {name}" with the brief, schedule, active hours and steps (unticked), and none of the notes, replies, history, state or finish date. The person edits it (the brief in Settings until PR 4) and presses Resume. Turning a repeating plan into a skill the agent drafts from comes later.`
  - §13's new hooks (`:910-915`): add `routines:duplicate` (TASK-953, host-only, the source's owner with `edit`), after `routines:set-finish-by`.
  - §15, after its last row (`:1009`): two rows dated 2026-10-24, `Decided`. One: Duplicate is a host service, one transaction and one receipt; paused, "Copy of {name}", steps unticked keeping who wrote them, nothing else copied, the finish date included; the source's owner with `edit`, no approval (TASK-953). Two: a person edits "Going well when" in Settings until PR 4's ⋯ › Edit (TASK-953).
  - Rule 5 (row 12): the §15 row at `:1008` goes from `Proposed (to confirm with Vinay)` to `Decided`, its text ending "(confirmed by Vinay, 2026-10-24)"; `:254`'s "Proposed (to confirm with Vinay): rewording a step the agent added makes it the person's" becomes "Rewording a step the agent added makes it the person's (confirmed by Vinay, 2026-10-24)"; `:661`'s "(or reworded, which §15 carries as proposed, to confirm with Vinay)" becomes "(or reworded)".

- [ ] **Step 2: Check it**
  Run: `pnpm test:scripts`
  Expected: PASS (the memory cited-paths guard reads the shard's paths).

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-10-20-agent-tasks-design.md
git commit -m "[TASK-953] Design doc: Duplicate task and Going well when in Settings, as built"
```

---

## Final verification (the card's gate)

- [ ] `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Name every suite that ran only on the local-pg shim, or not at all, in the handoff.
- [ ] The PR description carries the boundary review and the security block above. It lists the card refinements from rows 2, 4, 5, 6, 7, 10 and 14 (where the plan departs from the card's letter), and row 12's design-doc status fix.

## Not in this card (YAGNI)

- **⋯ › Edit on the task page, and a deep link into one task's editor in Settings** (PR 4; the settings route has no routine id).
- **Duplicating a repeat routine**, and **turning a repeating plan into a skill** (card "Left to later", design §9).
- **A "Copy of Copy of" rename rule, a capability flag for whether the hook exists, a cap on copies per agent, and a replay that re-checks the source** (row 15).
- **`goodWhen` in core's `TOOL_FIELDS`** (row 10): it would change what the model is told for one Settings field.
