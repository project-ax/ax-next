# TASK-904 Keepers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring back the fixes the projects revert (#1004) took out. Each one is judged on its own merits and each gets a test that fails first. Once they're in, the reverted main can go to production without the storage helper crash-looping.

**Architecture:** Five independent changes in four packages. Each is a port of code that was already reviewed in a reverted commit, trimmed to what still makes sense without shared folders and projects. Most are hand ports; the menu change applies cleanly.
1. The storage helper accepts W2's `sharedFolders` on ledger records and recovery annotations, and unmounts the binds they name when it releases them.
2. The `conversations_v1_pending_purges` outbox for `agents:deleted`.
3. Three menus become non-modal.
4. Pooled storage failures report redacted causes.
5. The pod spec checks the `/files` subPath.

The last task corrects the design-doc lines this card came from.

**Tech Stack:** TypeScript, zod, Kysely on Postgres (testcontainers), Radix/shadcn `DropdownMenu`, vitest with Testing Library.

**Spec:** `docs/plans/2026-10-20-agent-tasks-design.md` §11 step 2 (plus step 3's drain note), card TASK-904. Decisions: `.claude/memory/decisions/2026-10-20-TASK-904.md`. Read row 1 before Task 1: it changes "accept and drop" to "accept and unmount".

## Global Constraints

- No hook signature changes, no new hooks, no new dependencies, no cross-plugin imports. Boundary review is not required. Say so in the PR body.
- Bug Fix Policy: run every task's new test against the unmodified code and watch it fail before you make the source change.
- Leave these out:
  - The `project` purge kind and the `conversation-unavailable` reason (from 19cfb47).
  - The NFS `lookupcache=positive` static PV (#999) and `walk-read.ts` (TASK-899).
  - Everything W2 used to *bind* shared folders: the assignment field, the `ax.io/shared-folders` claim-annotation check, `/backing/files-ro` and `assertReadOnlyMount`, the staging-ownership check, `AX_SHARED_FOLDERS`, and any bind loop.
- Keep these log names: `conversations_purged_for_deleted_agent` (info, `{agentId, count}`) and `conversations_purge_for_deleted_agent_failed` (error, `{agentId, err}`).
- Port from the source commits (table below). When this plan and the source disagree, the plan wins.
- Copy `describe-failure.ts` with `git show`, never by retyping it. Its control-character regex has to stay the escape text `\u0000-\u001f\u007f`, not raw bytes.
- Gates: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
  - Single package: `pnpm --filter @ax/<pkg> test -- <file>`. The filter goes before the script.
  - Postgres tests (conversations, attachments, channel-web server, preset-k8s) need an explicit `DOCKER_HOST`.
- Memory: write shards only. Never edit a root `.claude/memory/*.md` archive, and never add a `Memory-Rewrite:` trailer.
- `security-checklist`: run it once over Tasks 1, 4 and 5. They change the privileged storage helper and the runner pod's mounts. Put the note in the PR body.

## Review Focus

1. **A W2 record whose shared bind (or whole `shared` directory) is already gone.** Release must still finish and clear the finalizers. Pinned in Task 1 by `still releases a W2 record whose shared bind is already gone`.
2. **A W2 session still live when the new helper boots.** Reconcile leaves it alone. Its later release unmounts the shared binds too. Pinned in Task 1 by `leaves a live W2 session alone at boot…`.
3. **A database that already ran W3's version of the outbox.** That version has a wider CHECK and may hold a stale `project` row. The migration must be a no-op there, and the sweep must never retry the `project` row. Pinned in Task 2 by `a database that ran the reverted W3 migration…`.
4. **An `agents:deleted` payload with a missing, empty or non-string `agentId`.** It must never write an outbox row. Pinned in Task 2 by the added assertion in the existing invalid-payload `it.each`.
5. **A long or multi-line error message** (mount stderr, API text). `describeFailure` keeps the description to one line of at most 1024 characters. A report line adds only a fixed prefix and a checked pod uid, so it can't forge log lines. Pinned in Task 4 by `keeps the description to one line of at most 1024 characters`, and for reconcile's report by `keeps a report to one line: a fixed prefix, the pod uid, …` (review follow-up).

## Source map

| Task | Source (`git show <sha> -- <path>` for the diff, `<sha>:<path>` for the file) | How |
|---|---|---|
| 1 | `6e00408`: `packages/sandbox-k8s/src/storage-node/{protocol,sources,engine}.ts`, `__tests__/storage-node.test.ts` | Hand port of the release half only |
| 2 | `19cfb47`: `packages/conversations/src/{migrations,store,plugin,index,types}.ts`, `__tests__/{pending-purges,agent-deleted,drop-turn}.test.ts`, plus the call sites it touched | Hand port. 19cfb47 sits on W3a's `purgeWhere` and `project_id`; HEAD is post-W1 |
| 3 | `bf207d7`: `SkillsAppStore.tsx`, `AgentConnectors.tsx`, `AgentRail.tsx` and their tests | 4 files apply cleanly (checked with `git apply --check`); AgentRail is by hand |
| 4 | `6e00408` (unchanged through `e011da3`): `storage-node/describe-failure.ts`, `__tests__/describe-failure.test.ts`, the catch hunks in `storage-node/engine.ts` and `shared-pool.ts`, the "activation failure reporting" tests and two `shared-pool.test.ts` tests | Copy the two new files; hand port the hunks |
| 5 | `6e00408`: `packages/sandbox-k8s/src/pod-spec.ts` (`USER_FILES_SUBPATH_RE`), `__tests__/pod-spec.test.ts` (F9 tests) | Hand port |

**Order:** Task 1 before Task 4, because both edit `storage-node/engine.ts` and the `engineFixture` in `storage-node.test.ts`. Tasks 2, 3 and 5 are independent of everything. Task 6 goes last because it quotes what Task 1 built.

---

### Task 1: The storage helper boots over W2 shared-folder records [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/sandbox-k8s/src/storage-node/protocol.ts:27-33` (`StorageRecordSchema`), plus a new legacy schema and guard above it
- Modify: `packages/sandbox-k8s/src/storage-node/sources.ts` (new function)
- Modify: `packages/sandbox-k8s/src/storage-node/engine.ts:23` (add `targetParts` after `targetName`) and `:178-195` (`releaseLocked` loop)
- Modify: `packages/sandbox-k8s/SECURITY.md`, "Shared-pool recovery", first paragraph
- Test: `packages/sandbox-k8s/src/__tests__/storage-node.test.ts`

**Interfaces:**
- Produces, in `protocol.ts`:
  - `isLegacySharedFolderId(id: unknown): id is string`
  - `StorageRecord` gains `sharedFolders?: { folderId: string; readOnly: boolean }[]`
  - `StorageAssignmentSchema` is **unchanged**: still strict, still has no `sharedFolders`
- Produces, in `sources.ts`: `legacySharedFolderTargetParts(folderId: string): string[]`. It returns `['shared', folderId]` and throws `Error('invalid shared folder id')` when the guard fails.
- Produces, in the test: `engineFixture()`'s return object also exposes `mounted` (the existing `Set<string>`).

- [ ] **Step 1: Write the failing tests.** Add `mounted` to `engineFixture`'s return. Add `StorageRecordSchema` to the import from `../storage-node/protocol.js`. Then append this block at the end of the file:

```ts
// TASK-904. A W2-era helper (#989, reverted in #1004) bound shared folders at
// ax-late/shared/<folderId> and named them in its ledger record and recovery
// annotation. This helper never binds one. It must boot over those records and
// undo every bind they name when it releases them.
const W2_SHARED = [{ folderId: 'sf_a', readOnly: false }, { folderId: 'sf_b', readOnly: true }];
/** The record a W2 helper wrote: the assignment minus its bootstrap, plus sharedFolders. */
function w2Record(data: StorageAssignment, published: boolean) {
  const { bootstrap, ...rest } = data;
  return { ...rest, sharedFolders: W2_SHARED, assignmentId: bootstrap.assignmentId, published };
}
/** The binds a W2 helper left attached on the pod's late volume. */
function plantW2Binds(f: ReturnType<typeof engineFixture>, folders = ['sf_a', 'sf_b']) {
  for (const parts of [['files'], ...folders.map(id => ['shared', id])]) {
    const path = join(f.volume, ...parts); mkdirSync(path, { recursive: true }); f.mounted.add(path);
  }
}
const unmounted = (f: ReturnType<typeof engineFixture>) =>
  f.command.mock.calls.filter(([program]) => program === 'umount').map(([, args]) => args.at(-1));
const writeLedger = (f: ReturnType<typeof engineFixture>, record: unknown) =>
  writeFileSync(join(f.config.ledgerRoot, `${f.data.podUid}.json`), JSON.stringify(record));

describe('storage-node over leftover W2 shared-folder state (TASK-904)', () => {
  it('boots reconcile over a W2 recovery annotation with no local ledger and unmounts every bind it names', async () => {
    const data = input(); const f = engineFixture(data); const k = kubeFixture(data);
    const fence = { machineId: randomUUID(), bootId: randomUUID() };
    k.pod.metadata!.finalizers = [STORAGE_FINALIZER]; k.claim.metadata!.finalizers = [STORAGE_FINALIZER];
    // Written by the W2 helper during an earlier boot of this machine.
    k.pod.metadata!.annotations!['ax.io/storage-recovery'] =
      JSON.stringify({ version: 1, fence: { ...fence, bootId: randomUUID() }, record: w2Record(data, false) });
    plantW2Binds(f);
    const engine = new StorageNodeEngine(f.config, createStorageAuthority(k.api, 'node', 'pool', fence), f.command, f.io);
    await expect(engine.reconcile()).resolves.toBeUndefined();
    expect(unmounted(f)).toEqual([join(f.volume, 'files'), join(f.volume, 'shared/sf_a'), join(f.volume, 'shared/sf_b')]);
    expect(f.mounted.size).toBe(0);
    expect(k.api.deleteClaim).toHaveBeenCalledWith(data.claimName, data.claimUid);
    expect(k.pod.metadata!.finalizers).toEqual([]); expect(k.claim.metadata!.finalizers).toEqual([]);
    expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
  });
  it('boots reconcile over a W2 ledger record and releases an abandoned one, shared binds included', async () => {
    const f = engineFixture(); const engine = f.make(); plantW2Binds(f); writeLedger(f, w2Record(f.data, true));
    vi.mocked(f.authority.abandoned).mockResolvedValue(true);
    await expect(engine.reconcile()).resolves.toBeUndefined();
    expect(f.mounted.size).toBe(0); expect(f.authority.finish).toHaveBeenCalledOnce();
    expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
  });
  it('leaves a live W2 session alone at boot; its later release unmounts the shared binds too', async () => {
    const f = engineFixture(); const engine = f.make(); plantW2Binds(f); writeLedger(f, w2Record(f.data, true));
    await expect(engine.reconcile()).resolves.toBeUndefined();
    expect(f.authority.stop).not.toHaveBeenCalled(); expect(f.mounted.size).toBe(3);
    await engine.release(identity(f.data));
    expect(f.events).toEqual(['stop', 'sync', 'umount', 'sync', 'umount', 'sync', 'umount', 'finish']);
    expect(f.mounted.size).toBe(0); expect(readdirSync(f.config.ledgerRoot)).toEqual([]);
  });
  it('still releases a W2 record whose shared bind is already gone', async () => {
    const f = engineFixture(); const engine = f.make(); plantW2Binds(f, ['sf_a']); writeLedger(f, w2Record(f.data, true));
    vi.mocked(f.authority.abandoned).mockResolvedValue(true);
    await expect(engine.reconcile()).resolves.toBeUndefined();
    expect(unmounted(f)).toEqual([join(f.volume, 'files'), join(f.volume, 'shared/sf_a')]);
    expect(f.authority.finish).toHaveBeenCalledOnce();
  });
  it('accepts sharedFolders on a record only, and only in the shape W2 wrote', () => {
    const data = input();
    expect(StorageAssignmentSchema.safeParse({ ...data, sharedFolders: W2_SHARED }).success).toBe(false);
    expect(StorageRecordSchema.safeParse(w2Record(data, false)).success).toBe(true);
    const seventeen = Array.from({ length: 17 }, (_, i) => ({ folderId: `sf_${String(i).padStart(2, '0')}`, readOnly: true }));
    for (const sharedFolders of [[{ folderId: '../agent-b', readOnly: false }], [{ folderId: 'sf_a/..', readOnly: false }],
      [{ folderId: 'agent-a', readOnly: false }], [{ folderId: 'sf_a', readOnly: 'no' }], [{ folderId: 'sf_a' }],
      [{ folderId: 'sf_a', readOnly: false, path: '/etc' }], [{ folderId: 'sf_a', readOnly: false }, { folderId: 'sf_a', readOnly: true }],
      [{ folderId: 'sf_b', readOnly: false }, { folderId: 'sf_a', readOnly: false }], [], seventeen]) {
      expect(StorageRecordSchema.safeParse({ ...w2Record(data, false), sharedFolders }).success).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail.** Run `pnpm --filter @ax/sandbox-k8s test -- src/__tests__/storage-node.test.ts -t "TASK-904"`. Expected failures:
  - Test 1 rejects with a ZodError for the unrecognized key `sharedFolders`.
  - Tests 2 and 4 reject with `storage recovery pending`.
  - Test 3 rejects at reconcile.
  - Test 5 fails on the accept line.

- [ ] **Step 3: Add the legacy schema to `protocol.ts`.** Put it above `StorageRecordSchema`, and add `sharedFolders: LegacySharedFoldersSchema.optional(),` to `StorageRecordSchema` between `roles` and `assignmentId`. Do not add it to `StorageAssignmentSchema`. The values are pinned to W2's:

```ts
/**
 * W2 legacy (TASK-904). A W2-era helper (#989, reverted) bound shared folders at
 * `ax-late/shared/<folderId>` and named them here. Nothing binds one any more, and
 * an assignment may not carry the key. A record may, and release unmounts those
 * binds, so a helper upgraded over a live W2 session leaves no bind behind. Delete
 * this once no W2-era ledger record or recovery annotation can exist (production
 * reset and drained, §11 step 3).
 */
const LEGACY_SHARED_FOLDER_ID_RE = /^sf_[A-Za-z0-9_-]{1,64}$/;
export const isLegacySharedFolderId = (id: unknown): id is string =>
  typeof id === 'string' && LEGACY_SHARED_FOLDER_ID_RE.test(id);
const LegacySharedFoldersSchema = z.array(z.object({
  folderId: z.string().regex(LEGACY_SHARED_FOLDER_ID_RE), readOnly: z.boolean() }).strict())
  .min(1).max(16)
  .refine(list => list.every((f, i) => i === 0 || list[i - 1]!.folderId < f.folderId), 'shared folders must be sorted and unique');
```

  `StorageRecoverySchema` embeds `record: StorageRecordSchema`, so `recover()` and `priorBoot()` (`authority.ts:94`, `:165`) pick up the fix with no change of their own.

- [ ] **Step 4: Implement `legacySharedFolderTargetParts(folderId: string): string[]` in `sources.ts`.** It checks the id with `isLegacySharedFolderId` again, because this is the one place an id becomes path components. Then it returns `['shared', folderId]`.

- [ ] **Step 5: Change `engine.ts` to release every target a record names.** Add `targetParts(record: StorageRecord): string[][]` after `targetName`. It returns `[...record.roles.map(role => [targetName(role)]), ...(record.sharedFolders ?? []).map(f => legacySharedFolderTargetParts(f.folderId))]`. In `releaseLocked`, apply W2's loop hunk (`git show 6e00408 -- packages/sandbox-k8s/src/storage-node/engine.ts`, the `@@ -175,15 +291,15 @@` hunk):
  - `for (const parts of targetParts(record))`
  - `this.io.directory(volume, parts)`
  - The `stillMounted()` suffix becomes `${LATE_VOLUME}/${parts.join('/')}`.

  Everything else in release stays as it is. That includes the ENOENT skip, the "remains attached" check, and the stop → unmount → finish order.

- [ ] **Step 6: Add one sentence to `SECURITY.md` "Shared-pool recovery".** Put it after "The strict record contains storage UIDs, roles, and agent identity.": "A record written by a W2-era helper (#989, reverted) may also list the shared-folder ids it bound under the late volume. The helper accepts that list on records only, never on a new assignment, and uses it only to unmount those binds on release (TASK-904)."

- [ ] **Step 7: Run the tests and watch them pass.** First run `pnpm --filter @ax/sandbox-k8s test -- src/__tests__/storage-node.test.ts`: all tests pass, including the existing `refuses corrupted recovery metadata and API outages`. Then run `pnpm --filter @ax/sandbox-k8s test` and `pnpm --filter @ax/sandbox-k8s build`: both are green.

- [ ] **Step 8: Commit** with `fix(sandbox-k8s): storage helper boots over W2 shared-folder records and unmounts their binds`.

---

### Task 2: Durable chat purge after an agent is deleted [tier: sensitive]

**Files:**
- Modify: `packages/conversations/src/migrations.ts`
  - Add the table and index after the `conversations_v1_transcripts_by_conv` index (`:309`).
  - Add a `ConversationPendingPurgeRow` interface.
  - Add a `conversations_v1_pending_purges` entry to `ConversationDatabase` (`:384`).
- Modify: `packages/conversations/src/store.ts` (the `ConversationStore` interface near `:560`, and the implementation near `:1257`)
- Modify: `packages/conversations/src/plugin.ts`
  - The factory at `:106`.
  - The `agents:deleted` subscriber at `:461-471`.
  - `shutdown` at `:474`.
  - Replace `purgeConversationsForDeletedAgent` (`:553-620`).
  - The manifest comment at `:193-196`.
- Modify: `packages/conversations/src/index.ts`: also export the types `ConversationsPlugin` and `ConversationsPluginOptions`.
- Modify: `packages/conversations/src/types.ts:776-780`. The comment now says the factory takes only operational options (`purgeSweepIntervalMs`), never anything stored on a conversation. This is 19cfb47's wording.
- Create: `packages/conversations/src/__tests__/pending-purges.test.ts`
- Modify: `packages/conversations/src/__tests__/agent-deleted.test.ts` and `drop-turn.test.ts`
- Modify: these call sites, each one becoming `createConversationsPlugin({ purgeSweepIntervalMs: 0 })`, exactly as 19cfb47 did:
  - `packages/attachments/src/__tests__/contract.test.ts:92`
  - `packages/channel-web/src/__tests__/server/acceptance-e2e.test.ts:276`
  - `packages/channel-web/src/__tests__/server/routes-chat.test.ts:590`
  - `packages/channel-web/src/__tests__/server/stream-e2e.test.ts:262`
  - `presets/k8s/src/__tests__/acceptance.test.ts:1886, 2245, 2699, 3401`
  - `presets/k8s/src/__tests__/agent-delete-cleanup.test.ts:212`

  Leave the production preset (`presets/k8s/src/index.ts:1291`) and the conversations package's other tests on the defaults.

**Interfaces (all produced here):**

```ts
// plugin.ts
export interface ConversationsPluginOptions { purgeSweepIntervalMs?: number } // default 60_000; 0 = no timer, no startup pass
export interface ConversationsPlugin extends Plugin {
  sweepPendingPurges(now?: Date): Promise<{ attempted: number; purged: number }>; // joins a pass in flight; never rejects for one target
}
export function createConversationsPlugin(opts?: ConversationsPluginOptions): ConversationsPlugin;
// store.ts
export type PendingPurgeKind = 'agent';
export interface PendingPurge { kind: PendingPurgeKind; targetId: string }
enqueuePurge(kind: PendingPurgeKind, targetId: string): Promise<void>;          // ON CONFLICT DO NOTHING
purgeAndDequeue(kind: PendingPurgeKind, targetId: string): Promise<string[]>;   // purge + delete outbox row, ONE transaction
recordPurgeFailure(kind: PendingPurgeKind, targetId: string, error: string, now: Date): Promise<void>; // upsert, backoff
duePurges(now: Date, limit: number): Promise<PendingPurge[]>;                   // kind = 'agent' rows only, earliest first
```

Pinned values (all from 19cfb47):
- The sweep:
  - default interval 60 000 ms
  - first pass after `min(5000, interval)` ms
  - batch of 50
  - both timers `unref()`'d
- Retries:
  - `last_error` holds the message only, cut to 500 characters plus `…`
  - backoff is 30 s × 2^(attempts−1), capped at 3600 s, with the exponent clamped by `LEAST(p.attempts, 20)`
- The sweep's ctx is `makeAgentContext({ sessionId: 'conversations-purge-sweep', agentId: '@ax/conversations', userId: 'system' })`.
- New log names: `conversations_purge_enqueue_failed`, `conversations_purge_retry_record_failed`, `conversations_purged_announce_failed` and `conversations_purge_sweep_failed`.

- [ ] **Step 1: Port the test file.** Copy `git show 19cfb47:packages/conversations/src/__tests__/pending-purges.test.ts` into place, then trim it to the agent kind:
  - Drop the `project` `KindCase` and the `describe.each`. Inline the agent case: target `agt_gone`, its two log names, and its `fire` (`agents:deleted` with `{ agentId, ownerId: 'u_owner', ownerType: 'user' }`).
  - Change `seed(pool, agentId, n = 3)` so its inserts no longer name `project_id`, because that column is gone.
  - Keep all eight agent tests and the "pending record itself cannot be written" test as they are.

  Then add this test:

```ts
it('a database that ran the reverted W3 migration keeps its table, and the sweep never touches a leftover project row', async () => {
  // W3's DDL (#991): the same table, but its CHECK also allowed 'project'.
  const pre = new pg.Client({ connectionString }); await pre.connect();
  try {
    await pre.query(`CREATE TABLE conversations_v1_pending_purges (
      kind TEXT NOT NULL CHECK (kind IN ('agent', 'project')), target_id TEXT NOT NULL,
      attempts INT NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_error TEXT NULL, PRIMARY KEY (kind, target_id))`);
    await pre.query(`INSERT INTO conversations_v1_pending_purges (kind, target_id, next_attempt_at)
      VALUES ('project', 'prj_gone', NOW() - interval '1 hour')`);
  } finally { await pre.end(); }
  const { plugin, pool, announced } = await makeHarness();
  const { ids } = await seed(pool, 'agt_gone');
  await pool.query(`INSERT INTO conversations_v1_pending_purges (kind, target_id) VALUES ('agent', 'agt_gone')`);
  expect(await plugin.sweepPendingPurges(new Date(Date.now() + 60 * SEC))).toEqual({ attempted: 1, purged: 1 });
  expect(await countConversations(pool, ids)).toBe(0);
  expect(announced).toHaveLength(1);
  expect((await pendingRows(pool)).map(r => [r.kind, r.target_id, r.attempts])).toEqual([['project', 'prj_gone', 0]]);
});
```

  Then edit `agent-deleted.test.ts`:
  - In `afterEach`, run `DROP TABLE IF EXISTS conversations_v1_pending_purges` before the other drops. Do the same in `drop-turn.test.ts`'s `afterEach`.
  - In `logs an error and swallows when the purge fails…`, add 19cfb47's pending-row assertion: `SELECT kind, target_id, attempts …` should equal `[{ kind: 'agent', target_id: 'agt_a', attempts: 1 }]`.
  - In the invalid-payload `it.each`, add an assertion that `SELECT COUNT(*)::int AS n FROM conversations_v1_pending_purges` is `0`.

- [ ] **Step 2: Run the tests and watch them fail.** Run `pnpm --filter @ax/conversations test -- src/__tests__/pending-purges.test.ts src/__tests__/agent-deleted.test.ts`. Expected: they fail. Either `sweepPendingPurges` is not a function, or the table doesn't exist.

- [ ] **Step 3: Add the migration.** Use this exact DDL, as two statements, and put 19cfb47's comment above it (with the project wording taken out). Add one sentence: a database that ran W3's version already has this table, with `CHECK (kind IN ('agent', 'project'))`. `IF NOT EXISTS` keeps that table, which is harmless, because only `agent` rows are written or read.

```sql
CREATE TABLE IF NOT EXISTS conversations_v1_pending_purges (
  kind TEXT NOT NULL CHECK (kind IN ('agent')),
  target_id TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT NULL,
  PRIMARY KEY (kind, target_id)
);
CREATE INDEX IF NOT EXISTS conversations_v1_pending_purges_due ON conversations_v1_pending_purges (next_attempt_at);
```

  `ConversationPendingPurgeRow` has `kind: 'agent'`. The defaulted columns are optional, as in 19cfb47.

- [ ] **Step 4: Add the store methods.**
  - Move `purgeForAgent`'s transaction body into a module-level `purgeAgentConversations(db, agentId: string, dequeue: boolean): Promise<string[]>`. When `dequeue` is set, its last statement inside the same transaction is `trx.deleteFrom('conversations_v1_pending_purges').where('kind', '=', 'agent').where('target_id', '=', agentId)`.
  - `purgeForAgent` keeps its validation and calls the new function with `false`.
  - `validatePurgeTarget` rejects any kind but `'agent'` with `invalid("kind must be 'agent'")`.
  - `enqueuePurge` and `recordPurgeFailure` are 19cfb47's, verbatim.
  - `duePurges` is 19cfb47's query plus `.where('kind', '=', 'agent')`.

- [ ] **Step 5: Wire the outbox into the plugin.** Port these from `git show 19cfb47:packages/conversations/src/plugin.ts`, minus the `projects:deleted` subscriber and the project log entry:
  - The constants, the two interfaces and the closure state (`busRef`, both timers, `sweepInFlight`, `stopped`, `purging`).
  - The functions: `sweepCtx`, `runPurgeSweep`, `sweepPendingPurges`, `sweepInBackground`, `purgeForDeletion`, `validDeletedId` (agent only), `PURGE_LOG` (agent only), `purgeKey`, `shortErrorMessage`, `purgeAndAnnounce` and `announcePurged`. `announcePurged` takes over HEAD's chunked fire loop.
  - The init wiring (`busRef = bus; stopped = false;` plus the timers when the interval is above 0).
  - The returned `sweepPendingPurges`.
  - The `shutdown` that stops the timers and waits for any pass in flight.

  The `agents:deleted` subscriber calls `purgeForDeletion(localStore, bus, ctx, 'agent', agentId)` whenever `validDeletedId` returns an id. Keep 19cfb47's long doc comment, project lines removed, including its "NOT covered" paragraph.

- [ ] **Step 6: Run the tests and watch them pass.**
  - `pnpm --filter @ax/conversations test` and `pnpm --filter @ax/conversations build` are green.
  - Then the dependants: `pnpm --filter @ax/attachments test -- src/__tests__/contract.test.ts`, `pnpm --filter @ax/channel-web test -- src/__tests__/server`, and `pnpm --filter @ax/preset-k8s test -- src/__tests__/agent-delete-cleanup.test.ts src/__tests__/acceptance.test.ts`.

- [ ] **Step 7: Commit** with `fix(conversations): retry a failed agent chat purge until it succeeds (durable outbox)`.

---

### Task 3: Three menus that could freeze the page are non-modal [tier: mechanical]

**Files:**
- Modify: `packages/channel-web/src/components/workspace/AgentRail.tsx:180`, `packages/channel-web/src/components/workspace/AgentConnectors.tsx:729`, `packages/channel-web/src/components/settings/SkillsAppStore.tsx:672`
- Test: `packages/channel-web/src/components/workspace/__tests__/AgentRail.test.tsx`, `__tests__/AgentConnectors.test.tsx`, `settings/__tests__/SkillsAppStore.test.tsx`

This only adds a prop to an existing shadcn primitive, so there's no new component and invariant 6 holds.

- [ ] **Step 1: Write the failing tests.** Apply bf207d7's two test hunks, which apply cleanly: `git show bf207d7 -- packages/channel-web/src/components/workspace/__tests__/AgentConnectors.test.tsx packages/channel-web/src/components/settings/__tests__/SkillsAppStore.test.tsx | git apply`. bf207d7's AgentRail test lived in the W3e describe, which is gone, so add this to the end of `describe('AgentRail — past conversations')` instead:

```ts
// A modal menu here leaves the page unclickable after its dialog removes the
// trigger (production, 2026-10-19; #998).
it('the chat row menu never locks the page', async () => {
  render(<AgentRail detail={detail({ past: [{ id: 'c-launch', title: 'Launch checklist',
    lastActivityAt: new Date().toISOString() }] })} openPastId={null} onOpenPast={vi.fn()} tab="chat" />);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Options for Launch checklist' }), { button: 0, ctrlKey: false });
  expect(await screen.findAllByRole('menuitem')).not.toHaveLength(0);
  expect(document.body.style.pointerEvents).not.toBe('none');
  await waitFor(() => expect(railMock).toHaveBeenCalled());
});
```

- [ ] **Step 2: Run the tests and watch them fail.** Run `pnpm --filter @ax/channel-web test -- src/components/workspace/__tests__/AgentRail.test.tsx src/components/workspace/__tests__/AgentConnectors.test.tsx src/components/settings/__tests__/SkillsAppStore.test.tsx`. Expected: the three new tests fail with `expected 'none' not to be 'none'`. If any of them passes against the still-modal menu, it isn't testing the lock. Stop and fix the test before going on.

- [ ] **Step 3: Make the menus non-modal.**
  - Apply the two component hunks: `git show bf207d7 -- packages/channel-web/src/components/workspace/AgentConnectors.tsx packages/channel-web/src/components/settings/SkillsAppStore.tsx | git apply`.
  - In `AgentRail.tsx`'s `menu()`, change `<DropdownMenu>` to `<DropdownMenu modal={false}>`, with bf207d7's comment: `// Not modal: Delete opens a dialog whose action removes this row, and the menu with it; a modal menu would leave <body> unclickable.`

- [ ] **Step 4: Run the tests and watch them pass.** The same command is green. Then `pnpm --filter @ax/channel-web test` and `pnpm --filter @ax/channel-web build` are green. channel-web's tsc does typecheck its tests.

- [ ] **Step 5: Commit** with `fix(channel-web): three menus whose dialog removes their trigger are non-modal (#998 keepers)`.

---

### Task 4: Pooled storage failures keep a redacted cause [tier: sensitive] (security-checklist)

Do this after Task 1, because both edit the engine and its test fixture.

**Files:**
- Create: `packages/sandbox-k8s/src/storage-node/describe-failure.ts` with `git show 6e00408:packages/sandbox-k8s/src/storage-node/describe-failure.ts > packages/sandbox-k8s/src/storage-node/describe-failure.ts`
- Create: `packages/sandbox-k8s/src/__tests__/describe-failure.test.ts`, the same way from `6e00408`, plus one new test
- Modify: `packages/sandbox-k8s/src/storage-node/engine.ts`: the io type (`:30-35`) and `assign`'s catch (`:132-136`)
- Modify: `packages/sandbox-k8s/src/shared-pool.ts`: the imports and the catch (`:212-216`)
- Test: `packages/sandbox-k8s/src/__tests__/storage-node.test.ts`, `packages/sandbox-k8s/src/__tests__/shared-pool.test.ts`

**Interfaces:**
- Consumes: Task 1's `engineFixture`, which already returns `mounted`.
- Produces:
  - `describeFailure(error: unknown, env: Readonly<Record<string, string>>): string`
  - `redactedError(error: unknown, env: Readonly<Record<string, string>>): Error`
  - `export interface StorageNodeIo { directory: typeof openDirectory; mountInfo(): string; chown(fd: number): void; isTmpfs(path: string): boolean; report(message: string): void }`. The engine's `io` parameter has this type, and the default `report` writes `` `${message}\n` `` to `process.stderr`.

- [ ] **Step 1: Write the failing tests.**
  - Copy the test file from `6e00408` and add this test to its first describe:

    ```ts
    it('keeps a report to one line of at most 1024 characters', () => {
      const text = describeFailure(new Error(`first\nsecond\r\n${'x'.repeat(5000)}`), {});
      expect(text.length).toBeLessThanOrEqual(1024);
      expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(text).toContain('first second');
    });
    ```

  - In `storage-node.test.ts`, give `engineFixture`'s io a `report: vi.fn((message: string) => { reports.push(message); })`, with `const reports: string[] = []`, and return `reports`. Then append W2's `describe('storage-node activation failure reporting', …)` with its five tests, verbatim, from `git show 6e00408 -- packages/sandbox-k8s/src/__tests__/storage-node.test.ts`.
  - In `shared-pool.test.ts`, insert W2's two tests after `rejects a resolver selecting another agent…`: `keeps the underlying activation and cleanup errors without leaking credentials` and `never attaches a credential-bearing original error as the cause`.

- [ ] **Step 2: Run the tests and watch them fail.** Run `pnpm --filter @ax/sandbox-k8s test -- src/__tests__/describe-failure.test.ts src/__tests__/storage-node.test.ts src/__tests__/shared-pool.test.ts`. Expected failures:
  - the describe-failure tests: module not found
  - the reporting tests: `reports` stays empty, or `err.cause` is undefined
  - the shared-pool tests: the message lacks `storage operation rejected`

- [ ] **Step 3: Apply W2's catch hunks.**
  - In `engine.ts`'s `assign` catch, apply the hunk from 6e00408. It reports `` `storage activation failed for pod ${record.podUid}: ${describeFailure(cause, env)}` ``, reports a failed unwind release the same way, and throws `new Error('storage activation failed', { cause: redactedError(cause, env) })`, where `env = bootstrap.env`.
  - In `shared-pool.ts`, apply the catch hunk from 6e00408. It collects `describeFailure` details for the cause, a failed release and a failed claim delete, and throws `` `shared session activation failed: ${details.join('; ')}` `` with `{ cause: redactedError(cause, env) }`, where `env = draft.data.env`.
  - Copy none of 6e00408's shared-folder lines from either file.

- [ ] **Step 4: Run the tests and watch them pass.** The same command is green. Then `pnpm --filter @ax/sandbox-k8s test` and `pnpm --filter @ax/sandbox-k8s build` are green.

- [ ] **Step 5: Commit** with `fix(sandbox-k8s): pooled storage failures keep a redacted cause`.

---

### Task 5: A `/files` subPath must be exactly one safe segment [tier: sensitive] (security-checklist)

**Files:**
- Modify: `packages/sandbox-k8s/src/pod-spec.ts`. Add a module constant before `realizeMounts` (`:491`), and add the check at the top of `case 'nfs'`, before `out.volumes.push`.
- Test: `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts`, in `describe('filestore mounts …')`, just before the `adds no chown init when no mounts are yielded` test (`:1319`), where W2 put them. Also change `:1533`.

- [ ] **Step 1: Write the failing tests.** These are W2's F9 tests, with a read-only case added:

```ts
// The user-files subPath is the per-agent subtree key: exactly one safe segment.
// An empty one would mount the whole export at /files; a deeper or dot-named one
// would mount something other than this agent's own subtree.
it.each([['.shared'], ['a/b'], ['..'], [''], ['.'], ['agent abc'], ['agent-abc/']])(
  'rejects a user-files subPath %j (fail closed)', (subPath) => {
    for (const readOnly of [false, true]) {
      expect(() => buildPodSpec('m', { ...baseInput, mounts: [{ ...nfsMount, subPath, readOnly }] }, baseResolved()))
        .toThrow(/user-files/);
    }
  });
it('accepts a real agent id as the user-files subPath', () => {
  const spec = buildPodSpec('m', { ...baseInput, mounts: [{ ...nfsMount, subPath: 'agt_01HZX9K2Q7-abc' }] }, baseResolved());
  expect(runnerMounts(spec).find((m) => m.name === 'ax-mount-0')!.subPath).toBe('agt_01HZX9K2Q7-abc');
});
```

  At `:1533`, change `rootExport`'s `subPath: ''` to `subPath: 'vol1'`. The test still expects `/aliases/`. An empty subPath now gets refused before the alias check runs, which is why W2 made this change.

- [ ] **Step 2: Run the tests and watch them fail.** Run `pnpm --filter @ax/sandbox-k8s test -- src/__tests__/pod-spec.test.ts`. Expected: the new `rejects` cases fail, because nothing throws yet.

- [ ] **Step 3: Add the check.** Add `const USER_FILES_SUBPATH_RE = /^[A-Za-z0-9_-]+$/;` with a comment saying it mirrors `SAFE_SEGMENT_RE` in `user-files-ops.ts` and the resolvers' agent-id gate. In `case 'nfs'`, add `if (mount.role === 'user-files' && !USER_FILES_SUBPATH_RE.test(mount.subPath)) throw new Error("a role:'user-files' mount subPath must be a single safe path segment");`.

- [ ] **Step 4: Run the tests and watch them pass.** The same file is green. Then `pnpm --filter @ax/sandbox-k8s test` and `pnpm --filter @ax/preset-k8s test` are green. The preset suite builds real pods with resolver-made subPaths.

- [ ] **Step 5: Commit** with `fix(sandbox-k8s): a /files mount subPath must be one safe path segment`.

---

### Task 6: Correct the prose that generated this card [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md:18-23` (Resume here), `:714-726` (§11 step 2) and `:736-737` (§11 step 3)
- Create: the context shard. Get its path from `scripts/memory-write-target.sh --shard context TASK-904`, then `mkdir -p` its directory.

- [ ] **Step 1: Resume here.** Replace the "Now" line and the first "Next" item with:

```markdown
- **Now:** this design is proposed. §11 step 1, the revert, merged as #1004
  (TASK-903). §11 step 2, the keepers PR, is TASK-904.
- **Next, in order:**
  1. §11 steps 3–4: resetting production and kind, tidying the board. Deploy
     the reverted main to production only with TASK-904 in the image, or drain
     first (step 3). The wipe alone isn't enough: without TASK-904 the storage
     helper refuses records that still carry `sharedFolders` and won't start.
```

- [ ] **Step 2: §11 step 2.**
  - At the end of the "Small sandbox hardening from W2" bullet, add: "TASK-904 re-landed both. Neither depends on shared folders."
  - In the leftover-key bullet, replace "Accept the key and drop it, with a test that boots reconcile over such a record." with: "Accept the key on records only (never on a new assignment), and unmount the `shared/<folderId>` binds it names on release. Dropping it would let the helper boot but leave those binds attached when it frees the pod. Tested by booting reconcile over such a record and annotation (TASK-904)."

- [ ] **Step 3: §11 step 3.** Replace "Skip the drain only if step 2's leftover-key fix is already in the image." with "Skip the drain only if step 2's leftover-key fix (TASK-904) is already in the image. The helper then boots over those records and unmounts their shared-folder binds when it releases them."

- [ ] **Step 4: Context shard.** Write two bullets:
  - First: TASK-904 re-landed the durable agent chat purge, the three non-modal menus, redacted pooled-storage causes and the `/files` subPath check, so the bugs `.claude/memory/context/2026-10-20-TASK-903.md` lists as "coming back until §11 step 2" are fixed again.
  - Second: the storage helper keeps `sharedFolders` on ledger records and recovery annotations only, and unmounts `ax-late/shared/<id>` on release. Delete it once no W2-era record can exist.
  - Backtick only paths that exist.

- [ ] **Step 5: Verify, then commit.**
  - Run `pnpm test:scripts`. `memory-cited-paths-exist` and `memory-append-check` are green.
  - Commit the doc, the context shard and `.claude/memory/decisions/2026-10-20-TASK-904.md` with `docs: TASK-904 keepers landed; correct §11's leftover-key line`.

---

## Before the PR

- [ ] Run the full gates from Global Constraints. All of them are green.
- [ ] Put the `security-checklist` note for Tasks 1, 4 and 5 in the PR body.
- [ ] State in the PR body:
  - Boundary review is not required: no hook-surface change. `agents:deleted` and `conversations:purged` keep their payloads. The retry sweep announces `conversations:purged` under a system ctx, and its only subscriber, `@ax/attachments`, reads no identity from ctx.
  - Task 1 deliberately departs from the card's "accept and drop". The reason is in decisions row 1.
