# TASK-947: A deleted routine's runs list only for the person they ran as — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a moved routine is deleted, its new owner's history reads list none of the earlier owner's runs. Once a routine is gone, each of its runs lists only for the person it ran as. Also correct `StatusChip`'s header comment.

**Architecture:** One predicate in `historyQuery`, the query behind both store history reads (`packages/routines/src/store.ts`). Today a routine that's gone lists every run. Now it lists a run only when `f.run_as_user_id` equals the reader. `recentFires` and `recentFiresForAgent` take the reader as `actorUserId`, as `recentReplies` and `recentReports` already do, and the two services pass `ctx.userId`. Live routines keep TASK-936's rule unchanged. No hook, schema, migration or channel-web code changes.

**Tech Stack:** TypeScript, Kysely on Postgres, vitest with testcontainers.

**Spec:** card TASK-947 (acceptance below). Decisions are in `.claude/memory/decisions/2026-10-26-TASK-947.md`, cited as "decisions row N". Background: `.claude/memory/decisions/2026-10-23-TASK-936.md` rows 5, 10, 18 and 21 (rows count from the first data row), and `docs/plans/2026-10-20-agent-tasks-design.md` §3.7, §7 and §15.

Card acceptance, verbatim:

- A store test: a moved, then deleted, routine lists none of the earlier owner's runs for the new owner.
- `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.

**What the card got right, and the part it didn't** (decisions row 1):

- **The leak is real.** `historyQuery` keeps every row whose routine is gone (`r.routine_id IS NULL`). So once a moved routine is deleted, its new owner's reads list the earlier owner's runs again. The reports stay hidden, because `fireViews` shows a report only to a non-null owner.
- **`renderedPrompt` doesn't reach the browser through the Activity feed.** `fireToActivityEvent` forwards only the status, the error (as `detail`), the trigger and the time. It does reach the browser through the Settings history route. `routines-admin-routes`' `fires` drops only `report`, and it never checks that the routine still exists. So the store is the right place for the fix, and no route needs to change.
- **Task runs have no rendered prompt at all.** `fire.ts` stores null for them. So the payload half of the leak belongs to a repeat routine with a webhook trigger.

**The team call** (decisions row 3, which the card left to us): **teammates stop seeing a deleted routine's runs.** A live routine's runs still list for every member who can see the agent. Once the routine is deleted, each run lists only for the person it ran as. That is the routine's owner, never the admin who deleted it. A run with no recorded run-as lists for no one (decisions row 4).

## Global Constraints

- No schema version, migration, hook input or output schema, tool, IPC action, route, UI, copy, dependency or lockfile change. No new log line.
- Exact-list pins stay as they are. `packages/routines/src/__tests__/return-schemas.test.ts` and channel-web's manifest tests don't change.
- The reader is a **required** `actorUserId: string` on both store reads. Never make it optional: a missing reader must fail to compile in product code.
- Routines tests are not type-checked (`packages/routines/tsconfig.json` excludes `src/__tests__/**`). A test's store read without `actorUserId` still compiles and reads as no one for a gone routine. **Every test read of a gone routine names its reader.** Reads of live routines elsewhere stay as they are (decisions row 6).
- Postgres-backed tests need `DOCKER_HOST` (CLAUDE.md). OrbStack may hang. If it does, the `fixture()` store tests can run on a local Postgres shim (`.claude/memory/patterns/2026-10-23-TASK-930.md`). The canary and `report-tool.test.ts` use the real harness and can't, so re-run them on Docker before calling Task 1 green.
- Commit this plan and the decisions shard before any `pnpm test:scripts` run. `scripts/__tests__/memory-cited-paths-exist.test.js` fails when a shard cites an untracked file, and the shard cites this plan.
- Run the tasks one at a time in this worktree. channel-web's `tsc --build` compiles routines and its contract, so two builds at once collide.
- TASK-939 and TASK-941 are being built in parallel and may also append rows to design §15. If a rebase conflicts there, keep every row, in date order.

## Review Focus

1. **The routine is deleted while one of the earlier owner's runs is still open.** The fire row is written after the delete, with the earlier owner as run-as, and the new owner must never see it. → Task 1 Step 1 (the `open` run).
2. **A team admin deletes a member's task.** The admin and other members see none of its runs. The owner, whose runs they were, still sees them, without reports. → Task 1 Step 2.
3. **Pages stay full.** Gone runs a reader can't see are filtered before the limit, so they never use up a page. → Task 1 Step 1 (`listed('owner', 1)`).
4. **Run-as, not the actor.** The reader is matched to who the run ran as (the routine's owner at accept), never to the actor on the accept. In production the two agree: the tick and webhooks accept as the owner, and fire-now and replies need `fire`, which is the owner's. So only the store test can tell them apart, with `dispatch.test.ts`' actor 'editor'. → Task 1 Step 6 (`dispatch.test.ts:42`).
5. **A row with no recorded run-as** (written by code from before version 9) of a gone routine lists for nobody. → Task 1 Step 1 (the `minute(2)` row).

## Hook surface

No hook signature changes (decisions row 5). `routines:recent-fires` and `routines:recent-fires-for-agent` keep their schemas. Each now lists fewer rows for a gone routine, depending on who calls. `actorUserId` is a store parameter, and `run_as_user_id` stays a store column. The PR still carries a short boundary note:

- **Alternate implementation:** a SQLite-backed routines store. It would record run-as and bind the reader the same way.
- **Payload names that might leak:** none. No payload field is added.
- **Subscriber risk:** none. These are service hooks.
- **Wire surface:** none.

## Security checklist (Task 1)

- **Prompt injection and untrusted content (the threat here).** A gone routine's fire rows hold untrusted text: `renderedPrompt` (a webhook routine's prompt rendered with a third party's payload) and host-written `error` and `warning`. A warning can name the connectors the run's person must sign in to. Before this fix, every person who could reach the agent got that text through `routines:recent-fires` (Settings forwards it as is) and `routines:recent-fires-for-agent` (Activity shows the error). That held once the routine was gone, including a later owner after drift repair and every teammate on a team agent. After the fix, only the person each run ran as gets it. Nothing here interpolates the text anywhere: the reader is a bound parameter, and the text goes out exactly as before.
- **Sandbox escape:** N/A. No filesystem, process, network, env or handle is added or widened.
- **Supply chain:** N/A. No `package.json` or lockfile change.
- **Residual, accepted:** a run's person still sees their own runs of a routine they no longer own, once it's deleted. That is their own text.

The PR's `## Security review` block, to finish in Task 1 Step 9:

```
## Security review
- Sandbox: N/A: no filesystem path, process, network, env or handle is added or widened; one store read gains a bound-parameter predicate.
- Injection: A deleted routine's run rows carry untrusted text (a webhook routine's rendered prompt with third-party payload, host error and warning text naming the run's person's connectors). They now list only for the person each run ran as, so they no longer reach a later owner after drift repair or other members of a team agent. The reader is a bound parameter; nothing is interpolated.
- Supply chain: N/A: no package.json or lockfile change.
```

---

### Task 1: Bind the reader for a gone routine's runs `[tier: sensitive]`

Runs the `security-checklist` skill: cross-user visibility of third-party webhook payloads and host error text.

**Files:**
- Modify: `packages/routines/src/store.ts`: the `recentFires`/`recentFiresForAgent` interface docs and signatures (`:227-236`), the tail of `reconcileOwners`' doc (`:298-300`), `historyQuery` and its doc (`:715-731`), and the two read implementations (`:1565-1585`)
- Modify: `packages/routines/src/services.ts:333-343`
- Test: `packages/routines/src/__tests__/owner-change-store.test.ts` (new test after `:152`; trim `:132-152`)
- Test: `packages/routines/src/__tests__/report-tool.test.ts:278-301` (rewrite)
- Test: `packages/routines/src/__tests__/canary.test.ts` (extend the test at `:770-814`)
- Test: `packages/routines/src/__tests__/dispatch.test.ts:42`, `:48`, `:51`, `:99`; `packages/routines/src/__tests__/fire.test.ts:113`, `:141`; `packages/routines/src/__tests__/plugin.test.ts:63`

**Interfaces:**
- Produces, in `RoutinesStore`, using the file's existing `type Actor = { actorUserId: string }`:
  - `recentFires(input: RoutineKey & Actor & { limit?: number }): Promise<FireRow[]>`
  - `recentFiresForAgent(input: Actor & { agentId: string; limit?: number; before?: Date }): Promise<FireRow[]>`
  - `function historyQuery(db: DB, actorUserId: string)` (module-private)
- `FireRow` is unchanged. `routineOwnerUserId` is still null for a routine that's gone.

- [ ] **Step 1: Write the card's store test.** In `owner-change-store.test.ts`, add it after the test that ends at `:152`, using the file's existing helpers (`bound`, `finished`, `finish`, `moveTo`, `minute`, `needsYou`, `onTrack`, `taskInput`):

```ts
  it('a moved, then deleted, routine lists none of the earlier owner’s runs for the new owner: each run lists only for the person it ran as (TASK-947)', async () => {
    const task = await f.store.createAuthored(taskInput('task'));
    await finished(task, 'earlier', minute(1), needsYou);
    // A run with no record of who it ran as (written by code from before version 9).
    await sql`INSERT INTO routines_v1_fires (agent_id, routine_id, fired_at, trigger_source, status) VALUES ('a', ${task.routineId}, ${minute(2)}, 'tick', 'ok')`.execute(f.db);
    // Accepted as the earlier owner, and still open across the move and the delete.
    const open = await bound(task, 'open', minute(3));
    await moveTo('new-owner');
    await finished(task, 'newer', minute(4), onTrack, 'new-owner');
    const current = (await f.store.findOne(task))!;
    await f.store.deleteAuthored({ agentId: 'a', routineId: task.routineId, expectedRevision: current.revision, actorUserId: 'new-owner', requestId: 'delete', now });
    // It ends after the delete, so its fire row is written with the routine already gone.
    expect(await finish(open.dispatchId)).toBe(true);
    const listed = async (actorUserId: string, limit?: number) => {
      const page = limit === undefined ? {} : { limit };
      return {
        byRoutine: (await f.store.recentFires({ agentId: 'a', routineId: task.routineId, actorUserId, ...page })).map(r => [r.firedAt, r.routineOwnerUserId]),
        forAgent: (await f.store.recentFiresForAgent({ agentId: 'a', actorUserId, ...page })).map(r => [r.firedAt, r.routineOwnerUserId]),
      };
    };
    // The new owner, who deleted it, reads only their own run; the earlier owner only theirs; anyone else none.
    expect(await listed('new-owner')).toEqual({ byRoutine: [[minute(4), null]], forAgent: [[minute(4), null]] });
    expect(await listed('owner')).toEqual({ byRoutine: [[minute(3), null], [minute(1), null]], forAgent: [[minute(3), null], [minute(1), null]] });
    expect(await listed('someone-else')).toEqual({ byRoutine: [], forAgent: [] });
    // Filtered before the limit: newer runs the reader can't see don't use up the page.
    expect(await listed('owner', 1)).toEqual({ byRoutine: [[minute(3), null]], forAgent: [[minute(3), null]] });
  });
```

- [ ] **Step 2: Rewrite the team test.** Replace `report-tool.test.ts:278-301` ("a deleted team task's runs keep their reports hidden from everyone, its owner included") with the test below. The setup lines (`start` through `fires`) are unchanged. The admin deletes through the real service, the same call `services.test.ts:49` makes:

```ts
  it("a deleted team task's runs list only for the person they ran as, without their reports (TASK-947)", async () => {
    // …unchanged setup: start(), routines:create as h.owner on h.teamAgentId, checkIn with NEEDS_YOU and NOTES, key, fires…
    // While the task exists, its owner sees the run's report, and a teammate sees the run without it.
    expect((await fires(h.owner)).byRoutine.map(fire => fire.report)).toEqual([{ ...NEEDS_YOU, reading: null }]);
    expect((await fires(h.teamMember)).byRoutine.map(fire => fire.report)).toEqual([null]);
    // A team admin deletes it (they may stop anyone's task). The run's rows stay. A routine that's
    // gone lists a run only for the person it ran as, its owner, and still without its report.
    expect(await h.bus.call('routines:delete', h.teamAdmin, { ...key, expectedRevision: (await get(task)).revision, requestId: 'delete' })).toMatchObject({ deleted: true });
    const own = await fires(h.owner);
    for (const list of [own.byRoutine, own.forAgent]) expect(list.map(fire => fire.report)).toEqual([null]);
    expect(JSON.stringify(own)).not.toContain(NEEDS_YOU.update);
    // The other members, the admin who deleted it included, no longer see it at all.
    for (const person of [h.teamMember, h.teamAdmin]) expect(await fires(person), person.userId).toEqual({ byRoutine: [], forAgent: [] });
  });
```

Keep the `createRoutinesStore` import: `:399` and `:510` still use it.

- [ ] **Step 3: Extend the owner-change canary.** At the end of the canary test that starts at `canary.test.ts:770` ("after the agent moves to a new owner, their Updates thread lists none of the earlier owner’s check-ins…"), add this after the `run_as_user_id` poll at `:811-813`. It is the card's user-facing case through the bus: `routines:recent-fires-for-agent` is the Activity feed's read.

```ts
    // TASK-947: the new owner deletes the task. Their history of it is what it was, without reports,
    // and the earlier owner's check-in still lists for no one, in the task's history or the agent's feed.
    const kept = await history();
    expect(kept.byRoutine).toHaveLength(2);
    expect(await h.bus.call('routines:delete', newOwner, { agentId: h.agentId, routineId: task.routineId, requestId: randomUUID(), expectedRevision: (await get()).revision }))
      .toEqual({ deleted: true, cleanupPending: false });
    const withoutReports = (fires: RoutineFireView[]) => fires.map(fire => ({ ...fire, report: null }));
    expect(await history()).toEqual({ byRoutine: withoutReports(kept.byRoutine), forAgent: withoutReports(kept.forAgent) });
```

- [ ] **Step 4: Run the three files and see the new tests fail.**

Run: `pnpm --filter @ax/routines test src/__tests__/owner-change-store.test.ts src/__tests__/report-tool.test.ts src/__tests__/canary.test.ts`

Expected: FAIL in exactly the three tests above.
- The store test fails because `listed('new-owner')` also returns `minute(3)`, `minute(2)` and `minute(1)`.
- The team test fails because the teammate's reads return the run instead of `[]`.
- The canary fails because the deleted task's history has 3 rows, not 2.

Everything else passes.

- [ ] **Step 5: Implement.**
  - **`historyQuery(db, actorUserId)`.** Replace its WHERE so the gone branch also requires the reader: `eb.or([eb.and([eb('r.routine_id', 'is', null), eb('f.run_as_user_id', '=', actorUserId)]), eb('f.run_as_user_id', '=', eb.ref('r.owner_user_id'))])`. A NULL `run_as_user_id` matches neither branch.
  - **The two reads.** `recentFires` and `recentFiresForAgent` take the signatures in Interfaces and pass `input.actorUserId` to `historyQuery`.
  - **`services.ts`.** `routines:recent-fires` and `routines:recent-fires-for-agent` pass `actorUserId: ctx.userId` to the store read. Add one comment line above the two registrations: `// TASK-947: read for the caller. A routine that's gone lists a run only for the person it ran as (historyQuery).`
  - **Docs.** Replace them in the same file (rule 5, decisions row 7).

The `recentFires` interface doc becomes:

```
   * A routine's runs, newest first; `limit` is clamped to 1-200. TASK-936: a
   * live routine's runs only when they ran as its current owner, so after a
   * change of owner the earlier owner's runs reach no one until the routine
   * returns to them. TASK-947: a gone routine's runs only when they ran as
   * `actorUserId`, the person reading, so once a routine is deleted each run
   * reaches only the person it ran as: never a later owner, and on a team agent
   * never another member. Both rules hold before the limit. A run with no
   * record of who it ran as (written by code from before version 9) lists for
   * no one. Each row carries the owner read in the same statement
   * (`routineOwnerUserId`, `historyQuery`), null for a routine that's gone.
```

The `recentFiresForAgent` one-liner becomes: `/** An agent's runs, newest first, older than `before` when it's given, under `recentFires`' rule for the same reader. */`

In `reconcileOwners`' doc, replace the last sentence ("Once the routine is deleted, all its runs list again, with no report.") with: `Once the routine is deleted, each run lists only for the person it ran as, still with no report (TASK-947), so a later owner never sees the earlier owner's runs.`

In `historyQuery`'s doc, replace the last two sentences ("One with no record … with no owner, so it shows no report.") with:

```
 * them. TASK-947: a routine that's gone has no owner, so each of its runs lists
 * only when it ran as `actorUserId`, the person reading, and with no owner, so
 * it shows no report. One with no record of who it ran as (written by code from
 * before version 9) lists for no one, its routine live or gone. Both rules are
 * in the WHERE, before any limit.
```

- [ ] **Step 6: Update the tests that pinned the old rule, or would turn vacuous** (decisions row 6). Each read below is of a gone routine. Give it a reader as `{ agentId: <row>.agentId, routineId: <row>.routineId, actorUserId: <who> }`:
  - **`owner-change-store.test.ts:132-152`.** Retitle it `'a live routine’s history lists only the runs that ran as its current owner, with that owner'`. Delete its gone tail: the comment at `:148`, `current`, the `deleteAuthored` call and the expectation at `:151`. Step 1's test now covers deletion. Keep the NULL-row assertion at `:147`.
  - **`dispatch.test.ts:42`.** Use reader `'owner'` and `toHaveLength(1)`. Add `expect(<same read with actorUserId: 'editor'>).toEqual([])`, with the comment `// TASK-947: it lists only for the person it ran as, the owner, not 'editor', who asked for it.`
  - **`dispatch.test.ts:48`.** Reader `'owner'`; still `toHaveLength(1)`.
  - **`dispatch.test.ts:51` and `:99` (after `purgeAgent`).** Reader `'owner'`; still `toEqual([])`. Now they prove the purge removed the rows, not that the reader can't see them.
  - **`fire.test.ts:113` (agent-gone purge) and `:141` (finished after the delete).** Reader `'owner'`; assertions unchanged.
  - **`plugin.test.ts:63` (after `agents:delete`).** Reader `h.owner.userId`; still `toEqual([])`.

- [ ] **Step 7: Run the routines suite and the build.**

Run: `pnpm --filter @ax/routines test && pnpm --filter @ax/routines build`
Expected: all routines tests pass, and `tsc -b` exits 0. A compile error in `services.ts` means a read is missing its reader.

- [ ] **Step 8: Run the other packages that drive the real plugin.**

Run: `pnpm --filter @ax/routines-admin-routes test src/__tests__/human-rest-integration.test.ts && pnpm --filter @ax/skills test src/__tests__/crystallization-canary.test.ts`
Expected: PASS. Both read only live routines (the full gate runs everything else).

- [ ] **Step 9: Security note.** Run the `security-checklist` skill against the diff and finish the PR's `## Security review` block from the draft above.

- [ ] **Step 10: Commit.**

```bash
git add packages/routines/src/store.ts packages/routines/src/services.ts packages/routines/src/__tests__/owner-change-store.test.ts packages/routines/src/__tests__/report-tool.test.ts packages/routines/src/__tests__/canary.test.ts packages/routines/src/__tests__/dispatch.test.ts packages/routines/src/__tests__/fire.test.ts packages/routines/src/__tests__/plugin.test.ts
git commit -m "[TASK-947] Routines: a deleted routine's runs list only for the person they ran as"
```

### Task 2: Contract and design docs say the new rule `[tier: mechanical]`

**Files:**
- Modify: `packages/routines-contract/src/services.ts:224-230`
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md:700` (§7) and the end of the §15 table (after `:1059`)

**Interfaces:** none (docs only). Consumes Task 1's rule as stated in the decisions shard rows 2 to 4.

- [ ] **Step 1: Contract doc.** Replace the comment above `RoutineRecentFiresOutputSchema` with:

```ts
/**
 * `routines:recent-fires` and `routines:recent-fires-for-agent` (TASK-936): a
 * routine's runs, newest first, read for the caller (`ctx.userId`). For a live
 * routine, only the runs that ran as its current owner, for anyone who can see
 * it. After a change of owner the earlier owner's runs reach no one, their
 * reports included, until the routine moves back. Once a routine is deleted,
 * each of its runs lists only for the person it ran as, still with no report,
 * so neither a later owner nor, on a team agent, another member sees it
 * (TASK-947).
 */
```

- [ ] **Step 2: Design §7.** In the "A task's state is its owner's." bullet (`:700`), replace "On a team agent every member still sees a task's runs, without their reports. Once a task is deleted, its runs list again, without reports (TASK-936)." with:

  "On a team agent every member sees a live task's runs, without their reports. Once a task is deleted, each of its runs lists only for the person it ran as, still without its report, so neither a later owner nor a teammate sees it (TASK-936, TASK-947)."

- [ ] **Step 3: Design §15.** Append this row as the table's last line:

```
| 2026-10-26 | Decided | Once a routine is deleted, each of its runs lists only for the person it ran as, without its report. On a team agent the other members stop seeing a deleted task's runs; a live task's runs are unchanged. A run with no record of who it ran as lists for no one. The card left the team call to its builder (TASK-947). |
```

- [ ] **Step 4: Verify and commit.**

Run: `pnpm --filter @ax/routines-contract build`
Expected: exit 0.

```bash
git add packages/routines-contract/src/services.ts docs/plans/2026-10-20-agent-tasks-design.md
git commit -m "[TASK-947] Docs: a deleted routine's runs list only for the person they ran as"
```

### Task 3: StatusChip's comment says what it draws `[tier: mechanical]`

`StatusChip` has one caller since #985 (2026-10-10): `FireRowsTable`, which passes each run's `status`. Routine rows and the editor stopped drawing `lastStatus` in that PR. The header also says `/75` for `silenced`, but the code says `/60`. Comments only. The `null` arm stays (YAGNI, decisions row 8).

**Files:**
- Modify: `packages/channel-web/src/components/routines/StatusChip.tsx:1-6`
- Modify: `packages/channel-web/src/__tests__/theme-contrast.test.ts:1910-1911` (a comment)

**Interfaces:** none.

- [ ] **Step 1: Replace the header comment** with:

```tsx
/**
 * StatusChip — one run's status, on each row of a routine's run history in
 * Settings (`FireRowsTable`): `ok`, `silenced` or `error`, as that run's fire
 * row recorded it. It is not the routine's own `lastStatus`, which no
 * channel-web view draws. `null` draws a muted em dash labelled "Never fired";
 * no caller passes it today, since every run has a status. Color tokens stay
 * semantic (no raw hex). The only deviations from neutral are `error`'s
 * destructive ink, fill and border (`text-destructive` on
 * `bg-destructive-soft`) and a subdued `text-foreground/60` on `silenced`, so
 * a silenced run reads as "intentional", not "broken".
 */
```

- [ ] **Step 2: Fix the twin.** In `theme-contrast.test.ts`, the comment that reads "`StatusChip`'s `error` arm (a routine's last-fire status, on every routine row and every fire row)" becomes "`StatusChip`'s `error` arm (a run's status, on every row of a routine's run history, `FireRowsTable`)". The rest of the sentence ("and `RoutinesList`'s error banner both painted …") is unchanged.

- [ ] **Step 3: Verify.**

Run: `pnpm --filter @ax/channel-web test src/__tests__/theme-contrast.test.ts`
Expected: PASS. `statusChipArm` strips comments before it matches, so the new header can't change what it reads.

- [ ] **Step 4: Commit.**

```bash
git add packages/channel-web/src/components/routines/StatusChip.tsx packages/channel-web/src/__tests__/theme-contrast.test.ts
git commit -m "[TASK-947] channel-web: StatusChip's comment says it draws one run's status"
```

### Final gate (after all three tasks)

- [ ] Run, with this plan and the decisions shard already committed: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Expected: all green. If `@ax/auth-better`'s Docker teardown hook times out with its assertions passing, that is the known local flake (CLAUDE.md). It is not this change.
- [ ] The PR body carries the boundary note ("Hook surface") and the `## Security review` block (Task 1 Step 9). Under "Decisions", it names the team call: members no longer see a deleted task's runs.
