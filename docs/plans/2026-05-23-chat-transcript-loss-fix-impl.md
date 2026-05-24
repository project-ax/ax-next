# Chat transcript-loss-on-concurrent-write — fix plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans or
> superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes. **Read the Design
> Decision section and get sign-off before starting Task 3** — the runner re-sync mechanism
> has a fork the reviewer must pick.

**Goal:** A chat turn must persist even when a concurrent writer (today: `attachments:commit`)
advances the shared per-(userId,agentId) workspace mirror out-of-band, so reloading a
session never loses turns and the resume path never injects synthetic turns.

**Architecture:** Two coordinated changes. (1) **Host** stops returning a bare 500 on the
optimistic-concurrency mismatch and instead returns `accepted:false` carrying the mirror's
actual head — the same re-sync contract the `apply-bundle` path already uses
(`parent-mismatch` + `cause.actualParent`). (2) **Runner** stops treating that as a transient
error: on a parent-mismatch it re-syncs its local baseline to the actual head, replays the
current turn's commit on top, and retries `commit-notify` — bounded. This makes chat robust
to *any* concurrent writer, not just attachments.

**Tech stack:** TypeScript (pnpm workspaces), vitest, git plumbing (`git-engine.ts`,
`git-workspace.ts`), zod (`ipc-protocol`).

---

## Root cause (confirmed — see `docs/plans/2026-05-23-chat-qa-sweep-design.md` revision + memory)

1. Chat turns commit normally; runner pins `parentVersion` to its materialize-time baseline
   (`main.ts:384`, advanced only on `accepted` at `main.ts:992`).
2. An attachment upload calls `attachments:commit` → `workspace:apply` to the **same**
   (userId,agentId) mirror (`attachments/src/handlers.ts:198-203`), advancing
   `refs/heads/main` **out-of-band** (confirmed: `b6b299c attachments:commit …` is a child of
   the runner's pinned `708115f`).
3. The runner's next `commit-notify` → `workspace:export-baseline-bundle({version: 708115f})`
   → `exportMirrorBundle` sees `head=b6b299c ≠ 708115f` → throws a plain `Error`
   (`git-engine.ts:626-629`).
4. `workspace-commit-notify.ts:143-146` maps that throw to `internalError()` (HTTP **500**).
5. Runner (`main.ts:1002-1010`) treats 500 as transient: keep working tree, **don't advance
   `parentVersion`**, accumulate, retry — forever with the same stale version. Nothing ever
   persists.
6. ⇒ `conversations:get` truncated ⇒ reload shows only the persisted prefix ⇒ SDK resumes
   from a transcript ending on a dangling `tool_result` ⇒ injects `Continue from where you
   left off.` / `No response requested.`; uncommitted turns are lost.

## Design Decision — RESOLVED: Option A (fetch-and-rebase), approved 2026-05-23

The runner must rebuild its baseline at the advanced head before it can replay its turn.
`materializeWorkspace` clones a bundle into an **empty** dir, so it can't re-clone in place
over the live `/permanent`. Two options for how the runner re-acquires the advanced baseline:

- **Option A — fetch-and-rebase (recommended).** Host's `accepted:false` response carries the
  new baseline **bundle bytes** (it already builds bundles). Runner writes the bundle to a
  temp file, `git fetch`es it into `/permanent`, then `git rebase --onto <newBaseline>
  <oldBaseline> main` to replay the turn commit on top. Disjoint paths (attachment file vs
  jsonl) ⇒ clean rebase. One round-trip, no extra RPC. Cost: the rejected response grows by a
  bundle (already sent on the happy path, so symmetric).
- **Option B — re-materialize RPC.** Runner calls a new `workspace.re-materialize` action
  (or reuses `workspace.materialize`) into a temp dir, then transplants the turn commit. More
  moving parts; cleaner separation. Extra RPC + temp-dir transplant logic.

Recommendation: **A** — minimal new surface, reuses the bundle the host already produces, and
keeps the version handshake in one response. The tasks below assume A; if B is chosen, Task 1's
schema field becomes a trigger flag and Task 3 swaps the fetch source.

A genuine **conflicting** rebase (concurrent writer touched the *same* path the turn did) is
out of scope for this fix — surface it as `accepted:false reason:'rebase-conflict'` and let the
turn fail loudly with a clear error rather than silently losing data. Add a follow-up issue.

## File structure

- `packages/ipc-protocol/src/actions.ts` — add `actualParent` + `baselineBundleBytes` to the
  `accepted:false` branch of `WorkspaceCommitNotifyResponseSchema` (the re-sync envelope).
- `packages/workspace-git-server/src/client/git-engine.ts` — make `exportMirrorBundle` /
  the export-baseline-bundle path throw the existing `parent-mismatch` PluginError (with
  `actualParent`) instead of a plain Error; expose the current head + its bundle.
- `packages/ipc-core/src/handlers/workspace-commit-notify.ts` — catch `parent-mismatch` from
  `export-baseline-bundle` and return `accepted:false` + `actualParent` + baseline bundle
  (mirror the existing apply-bundle `parent-mismatch` handling at lines 257-275).
- `packages/agent-claude-sdk-runner/src/git-workspace.ts` — add `resyncBaselineAndReplay()`
  (fetch new baseline bundle, `rebase --onto`, re-pin baseline).
- `packages/agent-claude-sdk-runner/src/main.ts` — in the `result` handler, on
  `accepted:false` with `actualParent`, call `resyncBaselineAndReplay`, update
  `parentVersion`, and retry `commit-notify` (bounded loop).
- Tests alongside each (`__tests__/`), plus an end-to-end regression in the canary/acceptance
  layer for "attachment upload mid-session then reload shows all turns".

---

## Task 1: Re-sync envelope on the commit-notify response

**Files:**
- Modify: `packages/ipc-protocol/src/actions.ts` (the `accepted:false` branch ~line 199-201)
- Test: `packages/ipc-protocol/src/__tests__/actions.test.ts`

- [ ] **Step 1 — failing test.** Assert the schema accepts a rejected response carrying the
  re-sync fields and still accepts the bare `{accepted:false, reason}` shape (back-compat).

```ts
import { WorkspaceCommitNotifyResponseSchema } from '../actions.js';

it('accepted:false carries optional re-sync envelope', () => {
  const resync = WorkspaceCommitNotifyResponseSchema.safeParse({
    accepted: false, reason: 'parent-mismatch',
    actualParent: 'deadbeef', baselineBundleBytes: 'AAAA',
  });
  expect(resync.success).toBe(true);
  // round-trip the new keys so the test goes RED pre-change (unknown keys are
  // stripped → these are undefined until the schema is widened).
  if (resync.success && resync.data.accepted === false) {
    expect(resync.data.actualParent).toBe('deadbeef');
    expect(resync.data.baselineBundleBytes).toBe('AAAA');
  }
  // back-compat: bare rejection still valid
  expect(WorkspaceCommitNotifyResponseSchema.safeParse(
    { accepted: false, reason: 'bundle author verification failed' },
  ).success).toBe(true);
});
```

- [ ] **Step 2 — run, expect FAIL** (`actualParent`/`baselineBundleBytes` unknown keys
  stripped, so the resync assertion fails to round-trip).
  Run: `pnpm --filter @ax/ipc-protocol test -- actions`

- [ ] **Step 3 — implement.** Add the optional fields to the `accepted:false` member:

```ts
z.object({
  accepted: z.literal(false),
  reason: z.string(),
  // Re-sync envelope (optional, present only on a parent-mismatch rejection):
  // the storage tier's current head + a baseline bundle at that head, so the
  // runner can rebase its turn onto it and retry. Opaque to the runner.
  actualParent: z.string().optional(),
  baselineBundleBytes: z.string().optional(),
}),
```

- [ ] **Step 4 — run, expect PASS.** `pnpm --filter @ax/ipc-protocol test -- actions`
- [ ] **Step 5 — commit.** `git commit -m "feat(ipc): commit-notify re-sync envelope (actualParent+baseline)"`

---

## Task 2: Host returns accepted:false + re-sync envelope on version mismatch

**Files:**
- Modify: `packages/workspace-git-server/src/client/git-engine.ts` (`exportMirrorBundle`
  ~603-630; the `export-baseline-bundle` engine method ~827)
- Modify: `packages/ipc-core/src/handlers/workspace-commit-notify.ts` (the
  `export-baseline-bundle` call site, 136-146)
- Test: `packages/ipc-core/src/handlers/__tests__/workspace-commit-notify.test.ts`,
  `packages/workspace-git-server/src/client/__tests__/*.test.ts`

- [ ] **Step 1 — failing test (handler).** With a workspace plugin stub whose
  `export-baseline-bundle` throws `PluginError{code:'parent-mismatch', cause:{actualParent}}`,
  assert `commit-notify` returns `{accepted:false, actualParent, baselineBundleBytes}` rather
  than a 500.

```ts
it('commit-notify surfaces parent-mismatch as accepted:false + re-sync envelope', async () => {
  const bus = makeBusWith({
    'workspace:export-baseline-bundle': () => {
      throw new PluginError({ code: 'parent-mismatch', plugin: 'x',
        message: 'mirror advanced',
        cause: { actualParent: 'newhead', baselineBundleBytes: 'AAAA' } });
    },
  });
  const res = await workspaceCommitNotifyHandler(
    { parentVersion: 'oldhead', reason: 'turn', bundleBytes: 'AAAA' }, ctx, bus);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    accepted: false, actualParent: 'newhead', baselineBundleBytes: 'AAAA',
  });
});
```

- [ ] **Step 2 — run, expect FAIL** (current handler returns `internalError()` → 500).
  Run: `pnpm --filter @ax/ipc-core test -- workspace-commit-notify`

- [ ] **Step 3 — implement (engine).** In `exportMirrorBundle` (git-engine.ts:626), throw the
  existing `parent-mismatch` helper carrying the head + (for Option A) bundle the *current*
  head so the caller can ship it:

```ts
// git-engine.ts — replace the plain Error at 626-629
if (headOid !== oid) {
  throw parentMismatch(
    `mirror head ${headOid} does not match requested version ${oid}`,
    headOid,
  );
}
```

  Then in the `export-baseline-bundle` engine method, on `{version}` mismatch, also attach the
  current head's bundle bytes to the thrown error's `cause` (so the handler can forward them):
  add `cause.baselineBundleBytes = await (bundle current head)`. (Reuse the existing
  bundle-current-head path used by `materialize`'s `export-baseline-bundle({})`.)

- [ ] **Step 4 — implement (handler).** In `workspace-commit-notify.ts`, wrap the
  `export-baseline-bundle` call (136-146) to catch `parent-mismatch` and return the envelope:

```ts
try {
  const out = await bus.call<WorkspaceExportBaselineBundleInput, WorkspaceExportBaselineBundleOutput>(
    'workspace:export-baseline-bundle', ctx, { version: parent });
  baselineBundleBytes = out.bundleBytes;
} catch (err) {
  if (err instanceof PluginError && err.code === 'parent-mismatch') {
    const cause = err.cause as { actualParent: string | null; baselineBundleBytes?: string };
    const body = {
      accepted: false as const,
      reason: `parent-mismatch: ${err.message}`,
      ...(cause.actualParent ? { actualParent: cause.actualParent } : {}),
      ...(cause.baselineBundleBytes ? { baselineBundleBytes: cause.baselineBundleBytes } : {}),
    };
    const checked = WorkspaceCommitNotifyResponseSchema.safeParse(body);
    if (!checked.success) return internalError();
    return { status: 200, body: checked.data };
  }
  logInternalError(ctx.logger, 'workspace.commit-notify', err);
  return internalError();
}
```

- [ ] **Step 5 — run, expect PASS** (both handler + engine suites).
  Run: `pnpm --filter @ax/ipc-core test -- workspace-commit-notify && pnpm --filter @ax/workspace-git-server test`
- [ ] **Step 6 — commit.** `git commit -m "fix(workspace): commit-notify returns accepted:false+head on mirror advance (was 500)"`

---

## Task 3: Runner re-sync helper (fetch advanced baseline + rebase the turn)

**Resolve the Design Decision first.** Tasks below assume Option A.

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/git-workspace.ts` (add `resyncBaselineAndReplay`)
- Test: `packages/agent-claude-sdk-runner/src/__tests__/git-workspace.test.ts`

- [ ] **Step 1 — failing test.** Build a temp `/permanent` with baseline B0 + one turn commit
  on top (touching `a.jsonl`). Build a second bundle representing the advanced head B1 =
  B0 + a commit touching a *different* path (`att/file.txt`). Call
  `resyncBaselineAndReplay({root, baselineBundleBytes: B1bundle, oldBaseline: B0, newBaseline: B1})`.
  Assert: `refs/heads/baseline` now points at B1; `main` contains both the attachment file and
  the turn's `a.jsonl`; `git log baseline..main` is exactly the replayed turn commit.

```ts
it('rebases the turn commit onto the advanced baseline (disjoint paths → clean)', async () => {
  const { root, B0, B1, b1bundle } = await fixtureAdvancedMirror();
  await resyncBaselineAndReplay({ root, baselineBundleBytes: b1bundle, oldBaseline: B0, newBaseline: B1 });
  expect(await revParse(root, 'refs/heads/baseline')).toBe(B1);
  expect(await fileExists(root, 'att/file.txt')).toBe(true);   // concurrent writer's file
  expect(await fileExists(root, 'a.jsonl')).toBe(true);        // our turn's file
  const range = await gitLog(root, 'baseline..main');
  expect(range.length).toBe(1);
});
```

- [ ] **Step 2 — run, expect FAIL** (`resyncBaselineAndReplay` not defined).
  Run: `pnpm --filter @ax/agent-claude-sdk-runner test -- git-workspace`

- [ ] **Step 3 — implement.** Fetch the advanced baseline into the live repo and rebase:

```ts
/**
 * Recover from a concurrent-writer advance: the storage tier moved its head
 * from `oldBaseline` to `newBaseline` while our turn committed on top of
 * `oldBaseline`. Fetch the new baseline and replay our turn commit(s) onto it
 * so the next `commit-notify` ships `newBaseline..HEAD`.
 *
 * Throws on a real rebase conflict (concurrent writer touched a path our turn
 * also touched) — the caller surfaces that as a loud turn failure.
 */
export async function resyncBaselineAndReplay(input: {
  root: string; baselineBundleBytes: string; oldBaseline: string; newBaseline: string;
}): Promise<void> {
  const { root, baselineBundleBytes, oldBaseline, newBaseline } = input;
  const bundlePath = path.join(os.tmpdir(), `ax-resync-${Date.now()}-${Math.random().toString(36).slice(2,10)}.bundle`);
  await fs.writeFile(bundlePath, Buffer.from(baselineBundleBytes, 'base64'));
  try {
    // Bring the new baseline objects into our repo.
    await expectOk(await runGit(['-C', root, 'fetch', bundlePath, 'main']), 'git fetch resync bundle');
    // Replay oldBaseline..main onto newBaseline. Disjoint paths → clean.
    const rebase = await runGit(['-C', root, 'rebase', '--onto', newBaseline, oldBaseline, 'main']);
    if (rebase.code !== 0) {
      await runGit(['-C', root, 'rebase', '--abort']); // leave the tree usable
      throw new Error(`resync rebase conflict: ${rebase.stderr}`);
    }
    // Re-pin baseline to the new head.
    await expectOk(await runGit(['-C', root, 'update-ref', 'refs/heads/baseline', newBaseline]), 'git update-ref baseline -> newBaseline');
  } finally {
    await fs.rm(bundlePath, { force: true });
  }
}
```

- [ ] **Step 4 — run, expect PASS.** `pnpm --filter @ax/agent-claude-sdk-runner test -- git-workspace`
- [ ] **Step 5 — commit.** `git commit -m "feat(runner): resyncBaselineAndReplay — rebase turn onto advanced baseline"`

---

## Task 4: Wire re-sync into the result handler (bounded retry)

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts` (the `result` handler, 980-1011)
- Test: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`

- [ ] **Step 1 — failing test.** Drive the result handler with a fake IPC client whose first
  `workspace.commit-notify` returns `{accepted:false, actualParent, baselineBundleBytes}` and
  whose second returns `{accepted:true, version: actualParent2}`. Assert: `resyncBaselineAndReplay`
  was called once, the second commit-notify was sent with `parentVersion === actualParent`, and
  the final `parentVersion` is the accepted version. (Use the existing main.test.ts harness +
  spy seams.)

- [ ] **Step 2 — run, expect FAIL** (handler doesn't re-sync; treats accepted:false as a plain
  veto → `rollbackToBaseline`). Run: `pnpm --filter @ax/agent-claude-sdk-runner test -- main`

- [ ] **Step 3 — implement.** Replace the accepted:false branch (currently rollback) so a
  parent-mismatch with `actualParent` re-syncs and retries, bounded (e.g. 3 attempts), and only
  a *true* veto (no `actualParent`) rolls back:

```ts
// inside the result try-block, replacing 984-1011's accept/veto handling
let attempt = 0;
let pv = parentVersion;
for (;;) {
  const resp = (await client.call('workspace.commit-notify', {
    parentVersion: pv, reason: 'turn', bundleBytes: bundleB64,
  })) as WorkspaceCommitNotifyResponse;
  if (resp.accepted) { parentVersion = resp.version as unknown as string; await advanceBaseline(env.workspaceRoot); break; }
  // re-sync path: concurrent writer advanced the mirror
  if (resp.actualParent && resp.baselineBundleBytes && attempt < 3) {
    attempt++;
    try {
      await resyncBaselineAndReplay({
        root: env.workspaceRoot, baselineBundleBytes: resp.baselineBundleBytes,
        oldBaseline: pv as string, newBaseline: resp.actualParent,
      });
    } catch (e) { process.stderr.write(`runner: resync failed (${String(e)})\n`); break; }
    pv = resp.actualParent;
    bundleB64 = (await commitTurnAndBundle({ root: env.workspaceRoot, reason: 'turn' })) ?? bundleB64;
    continue;
  }
  // true veto (no actualParent) or retries exhausted → roll back this turn
  process.stderr.write(`runner: workspace rejected: ${resp.reason}\n`);
  await rollbackToBaseline(env.workspaceRoot);
  break;
}
```

  (Note: `bundleB64` and `parentVersion` must be mutable in this scope; today `bundleB64` is a
  `const` from `commitTurnAndBundle` — widen to `let` and re-bundle after rebase since the turn
  commit OID changes.)

- [ ] **Step 4 — run, expect PASS.** `pnpm --filter @ax/agent-claude-sdk-runner test -- main`
- [ ] **Step 5 — commit.** `git commit -m "fix(runner): re-sync + retry commit-notify on concurrent-writer advance (was stuck loop)"`

---

## Task 5: End-to-end regression (attachment mid-session, reload shows all turns)

**Files:**
- Modify/Create: the attachments or chat acceptance/canary test that exercises a real
  `attachments:commit` + a subsequent turn (e.g. `packages/attachments/src/__tests__/` or the
  channel-web server canary).
- Test: as above.

- [ ] **Step 1 — failing test.** In-process (testcontainers/git-server stub): materialize a
  workspace; commit a chat turn (advances to V1); call `attachments:commit` (advances to V2,
  out-of-band); then run a second chat turn's `commit-notify` with `parentVersion=V1`. Assert
  the turn is **accepted** (after re-sync) and a `conversations:get`-style read returns *both*
  the attachment commit's file and both turns. Before the fix this turn is rejected/lost.

- [ ] **Step 2 — run, expect FAIL** (turn lost — reproduces #8).
- [ ] **Step 3 — implement:** none beyond Tasks 1-4; this test pins the integrated behavior.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit.** `git commit -m "test(workspace): regression — concurrent attachments:commit no longer drops chat turns"`

---

## Verification (whole-branch, before PR)

- [ ] `pnpm build && pnpm test && pnpm lint` (scope lint to changed files per the stale-worktree note).
- [ ] Re-walk the original repro on `ax-next-dev` via the `chat-qa-sweep` skill's #8: new chat →
  npx turn → attachment turn → reload → assert all turns present, no synthetic `Continue…` turn,
  attachment turn intact. (Rebuild the agent image first — the fix is runner-side, so the fast
  hostPath loop does NOT cover it; see k8s-acceptance-loop §6 caveat.)

## Boundary review

No new service-hook signatures; the change is additive fields on an existing IPC response
(`WorkspaceCommitNotifyResponseSchema`) + an internal runner helper. The new response fields
are opaque to the runner (it only feeds `actualParent` back as the next `parent`), matching the
existing `apply-bundle` `parent-mismatch`/`actualParent` contract — no backend-specific field
leaks. Patch is internal to the bundle wire; no boundary-review-required hook addition.

## Out of scope / follow-ups

- Genuine rebase conflicts (concurrent writer touched the same path the turn did) →
  `accepted:false reason:'rebase-conflict'`, turn fails loudly. File a follow-up for a real
  3-way merge or per-path locking if this proves common.
- Whether `attachments:commit` *should* share the chat mirror at all (vs a dedicated
  attachment store) — deeper design question; this fix makes the shared-mirror case correct
  regardless.

### Follow-ups surfaced by the final whole-implementation review (2026-05-23)

The fix as built is **server-backend-specific** (it's where the bug was observed). Two gaps
remain for "robust to ANY concurrent writer" to fully hold — track these:

> **STATUS 2026-05-23 — BOTH DONE.** Implemented in PR for `worktree-f1-f2-resync-followups`
> (impl plan: `docs/plans/2026-05-23-f1-f2-resync-followups-impl.md`). F-1: workspace-git-core's
> apply-bundle parent-CAS (Site 1 only) now carries `cause.actualParent`, and the commit-notify
> apply-bundle catch fetches a bundle@actualParent via the `workspace:export-baseline-bundle`
> hook and forwards the full re-sync envelope (real-backend integration test
> `workspace-commit-notify-core-resync.test.ts`). F-2: the per-turn loop is extracted into
> `commit-notify-resync.ts::commitNotifyWithResync` and called at BOTH the per-turn AND the
> final/idle commit sites (helper unit test + final-commit regression test in `main.test.ts`).
> Whole-repo build + test green, lint clean. Cluster re-walk tracked in `TODO.md`.

- **F-1 — single-replica `@ax/workspace-git` (workspace-git-core) backend still drops the
  turn.** ✅ DONE. That backend's `export-baseline-bundle` bundles a stale-but-reachable OID with no
  strict-HEAD check (`workspace-git-core/src/impl.ts:238-260`), so it does NOT raise
  parent-mismatch on export. The mismatch surfaces later at `apply-bundle`'s CAS, and the
  handler's apply-bundle parent-mismatch catch (`workspace-commit-notify.ts:~291`) returns a
  **bare** `{accepted:false}` with no `actualParent`/`baselineBundleBytes` — so the runner
  treats it as a true veto and rolls back (original bug, unfixed on single-replica). Fix:
  forward the re-sync envelope from the apply-bundle catch too (the apply-bundle
  `parent-mismatch` PluginError already carries `actualParent`; it additionally needs a
  bundle@actualParent). Then the runner's existing re-sync loop handles it for both backends.
- **F-2 — the runner's final/idle commit call site has no re-sync.** ✅ DONE. `main.ts:~1156` (the
  post-`result` "final commit" that captures the SDK's late jsonl write, per PR #127) only
  logged on `!accepted`; it didn't re-sync/retry. A concurrent attachment racing that commit
  drops the final turn's tail (narrower, same bug class). Fix: extract the bounded re-sync
  loop (Task 4) into a shared helper and use it at both the per-turn and final-commit sites.

Neither blocks the per-turn server-backend fix (the observed production bug), but both should
land before claiming the general "any concurrent writer, any backend" guarantee.
