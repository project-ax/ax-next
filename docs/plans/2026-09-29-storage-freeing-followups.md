# Storage limit follow-ups (TASK-719) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deleting an agent gives its storage back (repo removed, ledger row released), a person who is over the limit sees a plain sentence on the Rules, agent-identity and routines screens instead of a raw error, and two pieces of stale deploy config go away.

**Architecture:** `@ax/workspace-git` removes an agent's repo itself when `agents:deleted` fires (TASK-718 pattern), behind a tombstone so a late commit cannot recreate it, then fires a new `workspace:deleted { agentId }` notify hook. `@ax/disk-quota` subscribes and deletes that agent's `workspace:<agentId>` ledger row, so the row is released exactly when the bytes are. A quota veto gets a machine-readable `code: 'storage-full'` that survives the two `@ax/core` facades, so routes can answer `413 { error: 'storage-full', message }` without guessing.

**Tech Stack:** TypeScript, Kysely + Postgres (testcontainers), isomorphic-git bare repos, vitest, helm chart tests.

**Spec:** `docs/plans/2026-09-29-workspace-disk-quota.md` (TASK-690 design), and the decisions in `.claude/memory/decisions/2026-09-29-TASK-719.md` (every scope and design choice below is logged there with its alternatives).

## Global Constraints

- Hook surface is backend-agnostic: `workspace:deleted` carries `{ agentId }` only. No `sha`, `path`, `gitdir`, `repoRoot`.
- No cross-plugin imports. `@ax/disk-quota` learns of a delete only through `workspace:deleted`; routes learn of a quota refusal only through `PluginError.reasonCode`. No `err.plugin === '@ax/disk-quota'` matching anywhere.
- `agents:deleted` subscribers MUST return `undefined` (a returned rejection stops every later cleanup subscriber) and MUST swallow and log their own errors.
- A subscriber never keys a delete on `ownerId`: team agents have several users. Key on `agentId` alone.
- `PluginError.code` stays `'rejected'` for a veto. Only the new optional `reasonCode` carries `'storage-full'`.
- The agent-directed workspace sentence (`workspaceFullMessage`) is never shown to a person. Copy shown to a person never says "delete" or "free up" (existing tests `messages.test.ts` and `storage-copy.test.ts` enforce this and stay as they are).
- New tenant-table queries stay in `packages/disk-quota/src/store.ts` (lint rule `local/no-bare-tenant-tables`).
- Bug Fix Policy: a fix for a bug no existing test caught ships with the test that would have caught it.
- Each task ends with its package's `pnpm --filter <pkg> test` and `tsc` clean (`pnpm --filter <pkg> build`), then a targeted commit. Voice for user-facing copy: plain, warm, no jargon, no jokes about a full disk.

## Review Focus

- **A commit that lands after the delete.** A warm runner outlives its agent for up to ~5 minutes, and a write already queued on the agent's mutex passed its identity check before the tombstone existed. Expected: it fails with a clear error, no directory is created, no `workspace:applied` fires, no ledger row appears. (Task 3 tests it, both "arrives after" and "was already queued".)
- **`rm` fails.** Expected: the ledger row STAYS (the bytes are still on disk), `workspace:deleted` is not fired, the subscriber returns `undefined`, an error is logged. (Task 3 and Task 2.)
- **Two agents.** Deleting agent A leaves agent B's repo and ledger row untouched, including B with the same owner. (Task 6 canary.)
- **A team agent.** Its `workspace:<agentId>` row is owned by `team:<id>`; the release is keyed on the source, so it goes too. (Task 2 test.)
- **A validator veto is not storage.** A `validator-identity` or `validator-routine` refusal still answers 400 with its own reason and never `storage-full`. (Task 4, 5 tests.)
- **Agent id that is not a string, empty, or contains path characters.** The subscriber ignores it (logs, no delete); the repo path is derived through `workspaceIdForAgent`, never by joining the raw id. (Task 3 test.)
- **A repo that never existed** (agent never wrote). Delete is a quiet no-op that still fires `workspace:deleted`, so a stray ledger row is released. (Task 3 test.)

---

### Task 1: `code` on a veto, `reasonCode` on the error (`@ax/core`)

**Files:**
- Modify: `packages/core/src/errors.ts` (`Rejection`, `reject()`, `PluginError`, `PluginErrorOptions`)
- Modify: `packages/core/src/workspace-apply-facade.ts`, `packages/core/src/blob-put-facade.ts` (pass `pre.code` through)
- Modify: `packages/core/src/workspace.ts` (add `WorkspaceDeletedPayload`), `packages/core/src/index.ts` (export it)
- Test: the existing facade tests in `packages/core/src/__tests__/` (find them: `grep -l "registerBlobPutFacade\|registerWorkspaceApplyFacade" packages/core/src/__tests__/*`), plus `errors` tests if present

**Interfaces:**
- Produces: `reject({ reason, source?, offendingPaths?, code? })` where `code` is an optional non-empty string; `Rejection.code?: string`; `PluginErrorOptions.reasonCode?: string`; `PluginError.reasonCode?: string` (present only when set; included in `toJSON()` only when set); both facades throw `PluginError{ code: 'rejected', reasonCode: pre.code }` when the veto carried one; `interface WorkspaceDeletedPayload { agentId: string }` exported from `@ax/core`.

- [ ] **Step 1: Write failing tests.** In the facade tests: a `workspace:pre-apply` subscriber returning `reject({ reason: 'r', code: 'storage-full' })` makes `workspace:apply` throw a `PluginError` with `code === 'rejected'` and `reasonCode === 'storage-full'`; the same for `blob:pre-put` and `blob:put`. A veto with NO code yields an error where `'reasonCode' in err === false` (negative-space assertion, not just `undefined`). A `reject()` call without `code` returns an object where `'code' in r === false` (same reason `offendingPaths` is dropped when empty: an explicit `undefined` differs from absent after a zod parse or `toEqual`).
- [ ] **Step 2: Run** `pnpm --filter @ax/core test` and confirm they fail for the right reason.
- [ ] **Step 3: Implement.** Build only present keys, as `reject()` already does for `source` and `offendingPaths`. Confirm the `HookBus.fire` spread (`{ ...result, source: result.source ?? sub.plugin }`) carries `code` with no bus change; if any other code path rebuilds a `Rejection` field by field (`grep -n "offendingPaths" packages/core/src/hook-bus.ts`), carry `code` there too.
- [ ] **Step 4: Run** `pnpm --filter @ax/core test` and `pnpm --filter @ax/core build`. Expected: PASS, tsc clean.
- [ ] **Step 5: Commit** `[TASK-719] core: a veto can carry a machine-readable code; PluginError exposes it as reasonCode`.

---

### Task 2: disk-quota releases a deleted workspace's row and sets the `storage-full` code

**Files:**
- Modify: `packages/disk-quota/src/store.ts` (new `deleteWorkspaceUsage(agentId)`), `packages/disk-quota/src/migrations.ts` (comment only: fix the header line that says nothing frees these bytes), `packages/disk-quota/src/service.ts` (new `releaseWorkspace(agentId)`, `code: 'storage-full'` on both write-gate rejections and the STORAGE_UNAVAILABLE refusal is NOT storage-full: leave it without a code), `packages/disk-quota/src/plugin.ts` (subscribe `workspace:deleted`, add to `SUBSCRIBED`, manifest `subscribes`)
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (the pin near line 702 of disk-quota's `subscribes`)
- Test: `packages/disk-quota/src/__tests__/store.test.ts`, `service.test.ts`, `plugin.test.ts`

**Interfaces:**
- Consumes: `WorkspaceDeletedPayload` from Task 1 (`import type` from `@ax/core`); `reject({ ..., code })` from Task 1.
- Produces: `store.deleteWorkspaceUsage(agentId: string): Promise<number>` deleting `WHERE source = $1 AND kind = 'workspace'` for every owner and returning the row count; `service.releaseWorkspace(agentId): Promise<void>` (never throws); the plugin subscribes `workspace:deleted` with the existing per-subscriber swallow-and-log shape and returns `undefined`.

- [ ] **Step 1: Failing tests.** (a) store: two owners' rows for `workspace:agt_a` (a personal owner and `team:t1`), one for `workspace:agt_b`, and a `blob:<sha>` row whose sha string equals nothing relevant: `deleteWorkspaceUsage('agt_a')` returns 2, leaves `agt_b` and the blob row, and a second call returns 0. (b) service: `releaseWorkspace` removes the row, `usageFor(owner)` drops by exactly that many bytes, and a failing store is logged and swallowed (use the existing `failingStore`). (c) plugin: firing `workspace:deleted { agentId }` through `harness.bus.fire` deletes the row; a malformed payload (missing/empty/non-string `agentId`) deletes nothing and does not throw; the pinned `manifest.subscribes` now includes `workspace:deleted` (update the pin). (d) gates: a refused workspace write and a refused blob put carry `code === 'storage-full'`, a fail-closed "could not check" refusal has NO `code`.
- [ ] **Step 2: Run** `pnpm --filter @ax/disk-quota test`; confirm they fail.
- [ ] **Step 3: Implement.** No new index and no migration change beyond the header comment: an agent delete is rare and runs off the request path, so a scan of this small table is fine (YAGNI pass: a partial index would be a schema change on a shared prod table for a delete nobody waits on). The existing `reconcile` test that seeds `workspace:gone-agent` and expects the sweep never deletes a row stays green: the sweep still only upserts.
- [ ] **Step 4: Run** `pnpm --filter @ax/disk-quota test` (needs Docker: `DOCKER_HOST` per CLAUDE.md), `pnpm --filter @ax/disk-quota build`, and `pnpm --filter @ax/preset-k8s test -- preset.test` for the pin.
- [ ] **Step 5: Commit** `[TASK-719] disk-quota: release a deleted agent's workspace row; mark quota vetoes storage-full`.

---

### Task 3: `@ax/workspace-git` removes a deleted agent's repo (tombstone + `workspace:deleted`)

**Files:**
- Modify: `packages/workspace-git-core/src/impl.ts` (`registerWorkspaceGitHooks`: tombstone set, `ensureAgentRepo` wrapper used by EVERY current `ensureRepo(gitdir)` call site in that function, `agents:deleted` subscriber), `packages/workspace-git/src/plugin.ts` (manifest `subscribes: ['agents:deleted']`), any other plugin that calls `registerWorkspaceGitHooks` (`grep -rn "registerWorkspaceGitHooks" packages presets --include=*.ts | grep -v __tests__`): give it the same manifest entry
- Modify: `presets/k8s/src/__tests__/preset.test.ts` if it pins workspace-git's `subscribes`
- Test: `packages/workspace-git-core/src/__tests__/` (a real bare repo in a `mkdtemp` dir, the existing suites' fixtures)

**Interfaces:**
- Consumes: `WorkspaceDeletedPayload` (Task 1).
- Produces: after `agents:deleted { agentId, ownerId, ownerType }` the repo dir `<repoRoot>/<workspaceIdForAgent(agentId)>.git` no longer exists, `workspace:deleted { agentId }` has fired once (`bus.fire('workspace:deleted', ctx, { agentId })`), and every hook for that agent afterwards throws `PluginError{ code: 'agent-deleted', plugin: '@ax/workspace-git' }` instead of creating a repo. Sequence inside the subscriber: validate `agentId` (non-empty string, else `ctx.logger.warn` and return) → compute `workspaceId = workspaceIdForAgent(agentId)` → `mutex.run(async () => { tombstone.add(workspaceId); await rm(gitdir, { recursive: true, force: true }); })` → on success fire `workspace:deleted`; on failure `ctx.logger.error('workspace_git_delete_for_deleted_agent_failed', { agentId, err })`, do NOT fire, keep the tombstone. Always return `undefined`. The mutex map entry is never removed (a new `Mutex` for the same id would stop serializing against the old one).

- [ ] **Step 1: Failing tests** (each asserts the observable state, not the call): (a) apply a write for agent A, fire `agents:deleted`, assert the directory is gone (`existsSync`), `workspace:deleted` fired exactly once with `{ agentId: 'A' }`, and `workspace:usage` for A reports 0 or throws `agent-deleted` (pick and pin the one the implementation does: since `agentRepo` is the choke point, throwing is fine as long as it is tested); (b) a `workspace:apply-internal` for A AFTER the delete throws `agent-deleted` and `existsSync(gitdir)` is still false and no `workspace:applied` fired; (c) a write ALREADY queued on A's mutex when the delete arrives (start a slow write holding the mutex, start a second write, fire the delete, release the first): the second write throws `agent-deleted` and the directory does not exist afterwards; (d) agent B (same `repoRoot`) is untouched and still writable; (e) `rm` failure (make `repoRoot` entry undeletable, or spy on `fs/promises.rm` per the file's existing mock style): subscriber resolves, error logged, `workspace:deleted` NOT fired; (f) a delete for an agent that never wrote still fires `workspace:deleted` and does not throw; (g) malformed `agentId` values (`''`, `undefined`, `42`, `'../x'`) never delete anything outside `repoRoot` and never throw; (h) the subscriber's return value is `undefined` (a returned rejection would stop the fan-out).
- [ ] **Step 2: Run** `pnpm --filter @ax/workspace-git-core test`; confirm failures.
- [ ] **Step 3: Implement.** Do not change `agentRepo`'s signature. Put the tombstone check in one wrapper next to `ensureRepo` calls so nothing that can create a repo skips it (replace all 5 current call sites; a grep for a bare `ensureRepo(` in the registration function must show only the wrapper afterwards). Reads that call `ensureRepo` outside the mutex (`resolveVersion`, `workspace:diff`) get the same check; state in a comment the residual gap (a read already past the check can still `git init` an empty dir during the `rm`; a few KB, never counted).
- [ ] **Step 4: Run** `pnpm --filter @ax/workspace-git-core test`, `pnpm --filter @ax/workspace-git test`, both `build`s, and the preset pin test.
- [ ] **Step 5: Commit** `[TASK-719] workspace-git: deleting an agent removes its repo and refuses late writes`.

---

### Task 4: Rules and agent-identity say "storage full" in plain words (`@ax/channel-web`)

**Files:**
- Modify (server): `packages/channel-web/src/server/routes-workspace.ts` (`saveRules`), `packages/channel-web/src/server/routes-agent-identity.ts` (`save` catch)
- Modify (client): `packages/channel-web/src/lib/workspace-api.ts` (`saveRules`; reuse `lib/storage-full.ts` `readStorageFull` / `StorageFullError` rather than a new mechanism), `packages/channel-web/src/lib/admin.ts` (`putAgentIdentity`), `packages/channel-web/src/components/workspace/AgentMemory.tsx` (`RulesEditor.save`), `packages/channel-web/src/components/admin/AgentForm.tsx`, `packages/channel-web/src/lib/storage-copy.ts` (per-surface sentences)
- Test: `packages/channel-web/src/__tests__/server/routes-workspace.test.ts`, `routes-agent-identity.test.ts`, `components/workspace/__tests__/AgentMemory.test.tsx`, `components/admin/__tests__/AgentForm.test.tsx`, `lib/__tests__/storage-full.test.ts`, `lib/__tests__/storage-copy.test.ts`

**Interfaces:**
- Consumes: `PluginError.reasonCode` (Task 1).
- Produces: both routes answer `413` with body `{ error: 'storage-full', message: <fixed person sentence, a local constant> }` when `err instanceof PluginError && err.code === 'rejected' && err.reasonCode === 'storage-full'`. Every other `rejected` is unchanged (identity keeps 400 with the validator's reason; Rules keeps rethrowing). The client shows the SERVER's `message` for a 413 storage-full, so the sentence lives in one place per route.
- Sentence rules: plain, says what happened (not saved) and what to do (ask an admin for more room), no "delete", no numbers, no code names. e.g. Rules: "We couldn't save your rules because your storage is full. An admin can make more room, then you can try again." Identity (admin screen, the agent already exists): "The agent was saved, but its identity wasn't, because storage is full. An admin can make more room, then you can try again." Verify the identity sentence is true (create/patch run before the identity write) by reading `routes-agent-identity.ts` before writing it.

- [ ] **Step 1: Failing tests.** Server: Rules PUT with a `memory:rules:write` mock that throws `PluginError{ code:'rejected', reasonCode:'storage-full' }` answers 413 with the exact body; the same mock WITHOUT `reasonCode` still rethrows (500 path unchanged, pin it); identity: storage-full answers 413 with the body, a validator veto (`rejected`, no `reasonCode`) still answers 400 `{ error: reason }`. Client: `saveRules` on a 413 `{error:'storage-full',message}` rejects with `StorageFullError` carrying that message and `RulesEditor` renders it (not "the server ran into a problem"); `putAgentIdentity` on 413 throws an error whose message IS the sentence (not `save agent identity: 413: {json}`), and `AgentForm` shows it in its destructive `Alert`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test` for those files; confirm failures.
- [ ] **Step 3: Implement.** Also check `FactsMemory.tsx`, which mounts `RulesEditor` too, and `AgentView.tsx` `onSaveRules`, so the new error class propagates rather than being caught as a generic failure.
- [ ] **Step 4: Run** `pnpm --filter @ax/channel-web test` (whole package; it has snapshot/copy tests) and `pnpm --filter @ax/channel-web build` (tsc excludes tests everywhere but channel-web, so type errors in tests matter here).
- [ ] **Step 5: Commit** `[TASK-719] channel-web: Rules and agent identity explain a full storage limit in plain words`.

---

### Task 5: Routines save/delete say it too, and the routines client stops hiding real messages

**Files:**
- Modify (server): `packages/routines-admin-routes/src/routes.ts` (`save` catch ~L419, `destroy` ~L466)
- Modify (client): `packages/channel-web/src/lib/routines.ts` (`readError`), `components/routines/RoutineEditor.tsx`/`RoutinesList.tsx` only if the new error class needs a render change
- Test: `packages/routines-admin-routes/src/__tests__/routes.test.ts`, `packages/channel-web/src/lib/__tests__/routines-client.test.ts`

**Interfaces:**
- Consumes: `PluginError.reasonCode` (Task 1).
- Produces: `PUT /settings/routines/:agentId` and `DELETE /settings/routines/:agentId?path=` answer `413 { error: 'storage-full', message }` for a quota refusal (a local constant sentence in this package: "We couldn't save that routine because your storage is full. An admin can make more room, then you can try again." For delete, the true sentence is "...couldn't remove that routine..."); `validator-routine` vetoes keep 400 `{ error: reason }`. Client `readError` reads BOTH shapes: a string `body.error` (what the server actually sends today) and `body.error.message`, and prefers `body.message` for a storage-full body.

- [ ] **Step 1: Failing tests.** Server: quota veto on PUT and on DELETE answers 413 with the body; a validator veto still 400 (existing test stays); a `rejected` with no `reasonCode` on DELETE answers 400 with its reason (there is no delete test today: add one). Client: `readError` on `{ error: 'some reason' }` (status 400) returns `'some reason'`, NOT `'HTTP 400'` (this is the bug: the existing client tests mock `{error:{message}}` so they never saw it; write the new test against the shape the server really sends), and on the 413 body returns its message.
- [ ] **Step 2: Run** the two packages' tests; confirm failures.
- [ ] **Step 3: Implement** minimally.
- [ ] **Step 4: Run** `pnpm --filter @ax/routines-admin-routes test`, `pnpm --filter @ax/channel-web test -- routines`, and both builds.
- [ ] **Step 5: Commit** `[TASK-719] routines: a full storage limit reads plainly; the client shows the server's real message`.

---

### Task 6: Housekeeping, canary, docs

**Files:**
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml` (delete the `AX_SKILLS_BUNDLE_ROOT` comment + env, ~L246-253; keep `AX_WORKSPACE_ROOT` and the `if local` wrapper), `deploy/charts/ax-next/__tests__/render.test.ts` (delete the two `AX_SKILLS_BUNDLE_ROOT` tests at ~L309-331; add one asserting the env is ABSENT in both backends so it cannot come back), `deploy/charts/ax-next/gke-values.yaml:101` and `deploy/GKE.md:383` (`20Gi` -> `100Gi`, keep the "edit to taste" note and add that blobs share the volume and the per-person limit multiplies against it)
- Modify: `presets/k8s/src/__tests__/disk-quota-acceptance.test.ts` (new canary case)
- Modify (stale prose that generated this card, contract rule 5): `docs/plans/2026-09-29-workspace-disk-quota.md` (the 20Gi statement, the "Deleting an agent does not delete its repo" gap, the "In-process writers see a raw refusal" gap: rewrite them to what is now true and say what is still open), `scripts/__tests__/agent-keyed-tables-are-cleaned.test.js` (`NOT_TABLES` comment about the git repo and its "no delete hook" wording), and grep the prose spellings: `grep -rniE "no delete hook|does not delete its repo|deleteRepo|agent's git workspace|skill-bundles" docs packages presets scripts deploy --include=*.md --include=*.ts --include=*.js --include=*.yaml -l` and fix each that is now false. Do NOT edit any existing `.claude/memory/**` line (R1 forbids deleting a line).
- Create: `.claude/memory/context/2026-09-29-TASK-719.md`, `patterns/2026-09-29-TASK-719.md`, `mistakes/2026-09-29-TASK-719.md` (via `scripts/memory-write-target.sh --shard <kind> TASK-719`). The context shard must say the TASK-718 shard's "NOT cleaned: the agent's git workspace repository" is now cleaned.

**Canary case** (real Postgres, real git, real fs blobs, same fixtures as the file's existing cases): owner O with agents A and B, both with a real workspace write through `workspace:apply` so both have a repo dir and a `workspace:<id>` row; O also has a blob row. Fire `agents:deleted` for A through the bus. Assert: A's repo dir is gone, A's row is gone, B's dir and row are unchanged, O's blob row is unchanged, `usageFor(O)` fell by exactly A's previous workspace bytes, and a later `workspace:apply` for A rejects, creates no directory and adds no ledger row. Then re-run the same fire and assert it is a harmless no-op.

- [ ] **Step 1:** write the render-test change and the canary case first; run `pnpm --filter @ax/ax-next-chart test` (check the chart package's real name in `deploy/charts/ax-next/package.json`) and `pnpm --filter @ax/preset-k8s test -- disk-quota-acceptance`; confirm the new tests fail.
- [ ] **Step 2:** make the edits; re-run; PASS.
- [ ] **Step 3:** run the doc guards: `pnpm test:scripts` (this includes `memory-cited-paths-exist` and `memory-quoted-blob-shas`, which read the shards).
- [ ] **Step 4: Commit** in two commits: `[TASK-719] chart: drop the dead AX_SKILLS_BUNDLE_ROOT, say 100Gi where the size is written` and `[TASK-719] canary + docs: agent delete frees its workspace; correct the stale gap notes`.

---

## Explicitly not in this PR (each becomes a board card)

1. **Blob GC + blob ledger release**, with the constraints found: no sha-referenced authority across attachments/skills/branding, `put`'s already-stored fast path races `delete` and never touches mtime, `blob.put` over IPC makes rowless blobs, and a probable primary-key bug (`attachments_v1_artifacts.artifact_id` is the sha prefix, conflict handled only on `(conversation_id, path)`; verify before designing per-row references).
2. **Backfill of pre-#823 blobs** (needs owner-bearing listing hooks from attachments and skills; measure on prod read-only first).
3. **Team-workspace sweep** (needs an owner-bearing team agent listing) and **`workspace:usage` in `@ax/workspace-git-server`** plus wiring its existing `deleteRepo` into an `agents:deleted` subscriber and firing `workspace:deleted` from it.
4. **One-off cleanup of orphan repos and stale ledger rows for agents deleted before this ships**: operator action with a dry-run listing (hash every live agent id, diff against `ws-*.git`).
5. **Unmapped callers of a refusal**: bootstrap seed (swallowed, agent silently skips the identity interview), memory exporter, authored-skill promote (400 + raw code), and the skills clients rendering a raw `413 {json}` string.
6. **Making the end-of-turn refusal reach the person** (runner-side, already listed by TASK-690).
