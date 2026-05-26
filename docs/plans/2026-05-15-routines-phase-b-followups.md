# Routines Phase B Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Context.** Phase B of routines (`@ax/routines` + `@ax/validator-routine`) shipped 2026-05-15 as PR #71 with four spec deviations and three known follow-ups documented in the PR body and in [project memory](`~/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/project_routines_phase_b_pr71.md`). This plan addresses the three follow-ups. Each is mergeable independently.

**Goal.** Close the loop on the three production gaps Phase B intentionally deferred:
1. **Workspace contract: drop-turn can't persist.** `conversations:drop-turn` rewrites jsonl bytes correctly but commits with `parent: null` because `WorkspaceReadOutput` doesn't surface the version. Against the git workspace backend this always hits `parent-mismatch`. The conversation hide still runs (user-visible silence contract intact), but the jsonl rewrite is a no-op in production.
2. **`chat:turn-end` carries no `turnId`.** The runner's `event.turn-end` schema has no field to identify the just-emitted turn. The routines silence path consequently *skips* `conversations:drop-turn` entirely when `turnId` is absent (which is always today). Wiring this through lets silence actually drop the turn.
3. **Tick-loop advisory lock isn't connection-pinned.** `pg_try_advisory_lock` is session-scoped, but the routines tick loop calls it on a Kysely pool — the lock is "best-effort election" today. Correctness already comes from `FOR UPDATE SKIP LOCKED` in `claimDue`; this is hygiene that lets the lock actually do its job.

**Tech stack:** TypeScript + Kysely + Postgres. No new runtime deps. Test runner is vitest with the existing `@testcontainers/postgresql` harness.

**Spec references:**
- Phase B plan: `docs/plans/2026-05-14-routines-phase-b-impl.md`
- Phase B design: `docs/plans/2026-05-14-routines-design.md`
- Phase A plan: `docs/plans/2026-05-14-routines-phase-a-impl.md`

---

## Invariants (carry-forward from Phase B)

Numbered invariants surface explicit failure modes that must hold across every task in this plan. Reviewers can grep PR notes for `J1..J5` to confirm coverage.

- **J1 (workspace contract is the boundary, not git vocab).** Phase 1's `WorkspaceReadOutput.version` field is named neutrally (no `sha`, no `commitOid`). The git workspace plugin returns the commit OID stringified as a `WorkspaceVersion`; a future GCS-backed plugin returns its manifest pointer. Subscribers must not assume any particular shape.
- **J2 (additive wire-schema changes).** Both `WorkspaceReadResponseSchema` (wire) and `EventTurnEndSchema` (runner→host) gain a new optional field. Old runners / old workspace plugins / old subscribers continue working — missing field means "this producer doesn't surface it yet."
- **J3 (no half-wired plugins).** Each phase ships a producer + at least one consumer in the same PR. Phase 1's consumer is `conversations:drop-turn`. Phase 2's consumer is `@ax/routines`' silence-token path (un-guarded). Phase 3's consumer is the routines tick loop itself.
- **J4 (subscriber-must-not-throw).** The chat:turn-end one-shot in `@ax/routines` already swallows + logs every error path. Phase 2 doesn't relax that; it just changes the guard from "skip if no turnId" to "use turnId when present."
- **J5 (capabilities unchanged).** No new `calls` or `subscribes` entries land in any plugin manifest. No new IPC actions. The cross-plugin import allowlist isn't touched.

---

## File Structure

**Phase 1 — workspace version threading (drop-turn):**

Modify:
- `packages/core/src/workspace.ts` — extend `WorkspaceReadOutput` with optional `version`
- `packages/workspace-protocol/src/actions.ts` — extend `WorkspaceReadResponseSchema` with optional `version`
- `packages/workspace-git-core/src/impl.ts` — populate `version` from the resolved commit OID
- `packages/workspace-git-server/src/client/plugin.ts` — propagate `version` over the HTTP wire
- `packages/workspace-git-server/src/client/plugin-test-only.ts` — same
- `packages/workspace-git-server/src/server/handlers/read.ts` (or equivalent server-side serializer) — include `version` in the response envelope
- `packages/test-harness/src/mock-workspace.ts` — return `version` from the in-memory mock so contract tests keep parity
- `packages/test-harness/src/workspace-contract.ts` — assert `version` is returned and is the same OID for two reads at the same version
- `packages/conversations/src/plugin.ts` — `dropTurn` uses `read.version ?? null` instead of `null`
- `packages/conversations/src/__tests__/drop-turn.test.ts` — mocks emit `version`; assert `workspace:apply` is called with the same value as `parent`
- `packages/workspace-protocol/src/__tests__/actions.test.ts` — `version` is optional, missing-field still parses

**Phase 2 — chat:turn-end turnId:**

Modify:
- `packages/ipc-protocol/src/events.ts` — extend `EventTurnEndSchema` with optional `turnId: z.string()`
- `packages/ipc-protocol/src/__tests__/events.test.ts` (or equivalent) — `turnId` is optional, missing still parses
- `packages/agent-claude-sdk-runner/src/main.ts` — capture the assistant turn's uuid from the just-written jsonl line and include it in `event.turn-end` for `role: 'assistant'` emissions
- `packages/agent-claude-sdk-runner/src/__tests__/turn-end-uuid.test.ts` (new) — round-trip a fake jsonl with a known uuid; assert the emitted `turn-end` carries it
- `packages/routines/src/plugin.ts` — keep the "skip when missing" guard (defensive) but remove the `routines_drop_turn_skipped_no_turn_id` log path's expected-frequency comment; when `turnId` IS present we call drop-turn
- `packages/routines/src/__tests__/canary.test.ts` — emit `turnId` from the `agent:invoke` mock's synchronous `chat:turn-end`; assert `captured.drops.length === 1` (was `0`)

**Phase 3 — advisory-lock connection pinning:**

Modify:
- `packages/routines/src/tick.ts` — wrap the inner tick loop in `db.connection(...)` (Kysely 0.28's pinned-connection API) so `pg_try_advisory_lock` + the long-running tick loop + `pg_advisory_unlock` all run against the same backend connection
- `packages/routines/src/__tests__/tick.test.ts` — add a multi-instance race test (two concurrent `runTickLoop` against the same DB) that asserts exactly one tick loop holds the lock at a time

**Do not touch:** `packages/channel-web`, `packages/sandbox-k8s`. None of these surfaces are involved.

---

## Phase 1: workspace `version` threading

This is the bigger phase. Touches 5 packages but each change is small and additive. End state: `conversations:drop-turn` actually persists rewrites against the git workspace backend.

### Task 1: extend `WorkspaceReadOutput` with optional `version`

**Files:**
- Modify: `packages/core/src/workspace.ts`

- [ ] **Step 1: edit the type**

In `packages/core/src/workspace.ts`, around line 188:

```ts
export type WorkspaceReadOutput =
  | { found: true; bytes: Bytes; version?: WorkspaceVersion }
  | { found: false };
```

Add a doc comment explaining J1 (storage-agnostic): the field is opaque, callers pass it back as a parent on subsequent `workspace:apply` calls — they don't parse it.

- [ ] **Step 2: build**

```bash
pnpm build
```

Expected: builds clean. The field is optional so no caller is forced to change yet.

- [ ] **Step 3: commit**

```bash
git commit -m "feat(core): extend WorkspaceReadOutput with optional version

Optional field so existing backends can land version-surfacing
incrementally. Callers (Phase 1 of routines follow-ups: conversations
:drop-turn) read read.version when present and pass it back as the
parent on the subsequent workspace:apply. Backends that don't yet
populate version keep working — caller falls back to null and accepts
the parent-mismatch risk (today's behavior)."
```

---

### Task 2: extend `WorkspaceReadResponseSchema` (wire schema)

**Files:**
- Modify: `packages/workspace-protocol/src/actions.ts`
- Modify: `packages/workspace-protocol/src/__tests__/actions.test.ts`

- [ ] **Step 1: write failing test**

In `packages/workspace-protocol/src/__tests__/actions.test.ts`, add a test asserting `version` is optional and round-trips:

```ts
it('WorkspaceReadResponseSchema accepts optional version', () => {
  expect(WorkspaceReadResponseSchema.safeParse({
    found: true, bytesBase64: 'aGVsbG8=', version: 'abc123',
  }).success).toBe(true);
  // Missing version still valid.
  expect(WorkspaceReadResponseSchema.safeParse({
    found: true, bytesBase64: 'aGVsbG8=',
  }).success).toBe(true);
});
```

- [ ] **Step 2: edit the schema**

In `packages/workspace-protocol/src/actions.ts`:

```ts
export const WorkspaceReadResponseSchema = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    bytesBase64: z.string(),
    version: z.string().optional(),
  }).strict(),
  z.object({ found: z.literal(false) }).strict(),
]);
```

- [ ] **Step 3: run tests**

```bash
pnpm --filter @ax/workspace-protocol test
```

- [ ] **Step 4: commit**

```bash
git commit -m "feat(workspace-protocol): WorkspaceReadResponseSchema gains optional version

Mirrors @ax/core's WorkspaceReadOutput change. Old clients / servers
that don't emit the field continue parsing; new pairs can opt in. J2
(additive wire change)."
```

---

### Task 3: workspace-git-core populates `version`

**Files:**
- Modify: `packages/workspace-git-core/src/impl.ts`

- [ ] **Step 1: find the `workspace:read` handler**

Around line 851 in `packages/workspace-git-core/src/impl.ts`:

```ts
bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
  'workspace:read', PLUGIN_NAME,
  async (_ctx, input) => {
    const commitOid = await resolveVersion(input.version);
    if (commitOid === null) return { found: false };
    try {
      const { blob } = await git.readBlob({ fs, gitdir, oid: commitOid, filepath: input.path });
      return { found: true, bytes: copyBytes(blob) };
    } catch (err) {
      if (isNotFoundError(err)) return { found: false };
      ...
```

Return the version with the bytes:

```ts
return {
  found: true,
  bytes: copyBytes(blob),
  version: asWorkspaceVersion(commitOid),
};
```

- [ ] **Step 2: build + run package tests**

```bash
pnpm build
pnpm --filter @ax/workspace-git-core --filter @ax/workspace-git test
```

- [ ] **Step 3: commit**

```bash
git commit -m "feat(workspace-git-core): include version in workspace:read response

Populates the new optional field from the resolved commit OID. Existing
callers that don't read version are unaffected; new callers
(conversations:drop-turn, Task 8 of this plan) can thread it back into
workspace:apply as the parent."
```

---

### Task 4: workspace-git-server propagates `version` over the HTTP wire

**Files:**
- Modify: `packages/workspace-git-server/src/server/handlers/read.ts` (or wherever the read handler serializes the response — confirm by grep before editing)
- Modify: `packages/workspace-git-server/src/client/plugin.ts`
- Modify: `packages/workspace-git-server/src/client/plugin-test-only.ts`

The HTTP server speaks the wire schema in `@ax/workspace-protocol`. After Task 2, the schema accepts `version`. Both server (encode) and client (decode) need to round-trip it.

- [ ] **Step 1: verify the read handler call site**

```bash
grep -rn "workspace:read\|WorkspaceReadResponse" packages/workspace-git-server/src/ | head
```

Identify the response-build call site (likely in `src/server/handlers/`).

- [ ] **Step 2: server-side — include version**

In the server handler, after computing bytes, include `version` in the response. The server-side delegates to the same core handler from Task 3, so the field is already available — the wire encoder needs to forward it.

- [ ] **Step 3: client-side — propagate version**

In `client/plugin.ts` and `client/plugin-test-only.ts`, the `workspace:read` registration deserializes the HTTP response and returns it as `WorkspaceReadOutput`. Add the version field to the returned shape:

```ts
if (parsed.found) {
  const result: WorkspaceReadOutput = {
    found: true,
    bytes: base64ToBytes(parsed.bytesBase64),
  };
  if (parsed.version !== undefined) {
    result.version = asWorkspaceVersion(parsed.version);
  }
  return result;
}
return { found: false };
```

- [ ] **Step 4: tests**

```bash
pnpm --filter @ax/workspace-git-server test
```

The existing integration tests should keep passing; add at least one assertion that `read` round-trips a non-null version over the HTTP wire if no existing test covers it.

- [ ] **Step 5: commit**

```bash
git commit -m "feat(workspace-git-server): round-trip version on workspace:read over HTTP

Both server (encode) and client (decode) propagate the optional
version field across the HTTP boundary. Test coverage in the existing
integration suite (a read at a known apply's version returns that
version)."
```

---

### Task 5: test-harness mock workspace returns `version`

**Files:**
- Modify: `packages/test-harness/src/mock-workspace.ts`
- Modify: `packages/test-harness/src/workspace-contract.ts`

The in-memory workspace mock is used by other plugins' tests; it needs to track and return a version per apply so contract tests can prove the field round-trips.

- [ ] **Step 1: track version in the mock**

The mock probably tracks a counter or hash for `workspace:apply`'s returned version. Plumb that into the `workspace:read` registration so reads include the version at which the bytes were stored.

The simplest approach: the mock maintains a `Map<path, { bytes; version }>` where `version` is the version that last wrote that path. `workspace:apply` updates both fields on `put`; `workspace:read` returns both.

- [ ] **Step 2: contract test asserts version**

In `packages/test-harness/src/workspace-contract.ts`, around the `workspace:read` block:

```ts
it('read returns the version at which the bytes were stored', async () => {
  const h = await load();
  const v1 = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
    'workspace:apply', h.ctx(),
    { changes: [{ path: 'a', kind: 'put', content: enc.encode('x') }], parent: null },
  );
  const r = await h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read', h.ctx(), { path: 'a' },
  );
  expect(r.found).toBe(true);
  if (!r.found) return;
  expect(r.version).toBe(v1.version);
});
```

The contract test runs against BOTH the mock and the git-backed plugin (look at the existing contract harness shape), so this single test gates Task 3 + Task 5 simultaneously.

- [ ] **Step 3: run all test-harness consumers**

```bash
pnpm build
pnpm test
```

This will flush out any mock-using test whose assertions don't yet anticipate `version`. Most should be unaffected (the field is optional), but some tests that destructure the read result might need a tweak.

- [ ] **Step 4: commit**

```bash
git commit -m "feat(test-harness): mock workspace tracks + returns version on read

Round-trips the version field through the in-memory mock. New contract
assertion proves both impls (mock + git-backed) return the
post-apply version on a subsequent read, locking in J1 + J3."
```

---

### Task 6: conversations:drop-turn uses `read.version` as parent

**Files:**
- Modify: `packages/conversations/src/plugin.ts`
- Modify: `packages/conversations/src/__tests__/drop-turn.test.ts`

- [ ] **Step 1: write failing test**

Update the existing drop-turn test to assert `workspace:apply` is called with `parent: read.version`:

```ts
it('passes read.version as the parent on workspace:apply', async () => {
  const data = new Map<string, Uint8Array>();
  data.set('.claude/projects/proj/sess_a.jsonl', new TextEncoder().encode(
    JSON.stringify({ type: 'assistant', uuid: 't1', message: { id: 'm1' } }) + '\n',
  ));
  const { h, getLastApplied } = await makeHarnessWithWorkspace(data);
  // mock workspace:read returns version 'v1'
  const conv = await h.bus.call<CreateInput, CreateOutput>(...);
  await h.bus.call('conversations:store-runner-session', h.ctx({ userId: 'u1' }), {
    conversationId: conv.conversationId, runnerSessionId: 'sess_a',
  });
  await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
    conversationId: conv.conversationId, userId: 'u1', turnId: 't1',
  });
  const applied = getLastApplied();
  expect(applied?.parent).toBe('v1');
});
```

(The `makeHarnessWithWorkspace` workspace:read mock already emits `version: 'v1'` from Phase B; the assertion just hadn't been wired.)

- [ ] **Step 2: change the handler**

In `packages/conversations/src/plugin.ts`, around line 1032 (the `workspace:apply` call in `dropTurn`):

```ts
await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
  'workspace:apply', workspaceCtx,
  {
    changes: [{ path, kind: 'put', content: rewritten }],
    parent: read.version ?? null,
    reason: `routines:drop-turn ${input.conversationId} ${input.turnId}`,
  },
);
```

Replace the long "KNOWN LIMITATION" comment block with a one-liner pointing at the fix:

```ts
// Use the version we just read from as the parent. Backends that
// don't yet populate read.version (or pre-Task-3 versions of the
// git plugin) keep getting null and the parent-mismatch fallback
// — same as before this PR.
```

- [ ] **Step 3: tests**

```bash
pnpm --filter @ax/conversations test
```

- [ ] **Step 4: commit**

```bash
git commit -m "fix(conversations): drop-turn passes read.version as workspace:apply parent

Closes the Phase B follow-up #1. workspace:apply's CAS now succeeds
on the git workspace backend because parent matches the resolved
HEAD. Backends that don't yet emit read.version fall back to null
and get today's behavior (parent-mismatch propagates to the caller,
silenced fires hide the conversation, jsonl rewrite is a no-op)."
```

---

### Task 7: end-to-end via real git workspace

**Files:**
- Add: `packages/conversations/src/__tests__/drop-turn-against-git.test.ts`

Verify the full chain against the real `@ax/workspace-git` plugin (no mock workspace).

- [ ] **Step 1: write the test**

```ts
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createWorkspaceGitPlugin } from '@ax/workspace-git';
import { createConversationsPlugin } from '../plugin.js';
import type { WorkspaceApplyInput, WorkspaceApplyOutput } from '@ax/core';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => { while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} }); });
afterAll(async () => { if (container) await container.stop(); });

describe('conversations:drop-turn against the real git workspace', () => {
  it('persists the rewritten jsonl by passing read.version as parent', async () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'ax-conv-drop-turn-'));
    try {
      const h = await createTestHarness({
        services: {
          'agents:resolve': async (_c, input: unknown) => ({
            agent: { id: (input as { agentId: string }).agentId, visibility: 'personal' },
          }),
        },
        plugins: [
          createDatabasePostgresPlugin({ connectionString }),
          createWorkspaceGitPlugin({ gitDir }),
          createConversationsPlugin(),
        ],
      });
      harnesses.push(h);

      // Seed: write a 2-turn jsonl to the workspace.
      const path = '.claude/projects/proj/sess_a.jsonl';
      const lines = [
        JSON.stringify({ type: 'assistant', uuid: 't1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
        JSON.stringify({ type: 'assistant', uuid: 't2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'second' }] } }),
      ];
      const initial = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', h.ctx(),
        { changes: [{ path, kind: 'put', content: new TextEncoder().encode(lines.join('\n') + '\n') }], parent: null },
      );

      // Bind a conversation to this sessionId.
      const conv = await h.bus.call('conversations:create', h.ctx({ userId: 'u1' }), {
        userId: 'u1', agentId: 'a1',
      });
      await h.bus.call('conversations:store-runner-session', h.ctx({ userId: 'u1' }), {
        conversationId: (conv as { conversationId: string }).conversationId,
        runnerSessionId: 'sess_a',
      });

      // Drop turn 1.
      await h.bus.call('conversations:drop-turn', h.ctx({ userId: 'u1' }), {
        conversationId: (conv as { conversationId: string }).conversationId,
        userId: 'u1', turnId: 't1',
      });

      // Read the file back from the workspace.
      const read = await h.bus.call<{ path: string }, { found: boolean; bytes?: Uint8Array }>(
        'workspace:read', h.ctx(), { path },
      );
      expect(read.found).toBe(true);
      if (!read.found) return;
      const text = new TextDecoder().decode(read.bytes!);
      expect(text).not.toContain('"uuid":"t1"');
      expect(text).toContain('"uuid":"t2"');
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: run**

```bash
pnpm --filter @ax/conversations test
```

Expected: PASS. This is the load-bearing test that proves the end-to-end fix.

- [ ] **Step 3: commit**

```bash
git commit -m "test(conversations): end-to-end drop-turn against real git workspace

Boots @ax/database-postgres + @ax/workspace-git + @ax/conversations
against a real Postgres + real git in a tmp dir. Seeds a 2-turn
jsonl, drops turn 1, asserts the workspace file no longer contains
t1 — proving the version-as-parent fix actually persists across the
CAS gate."
```

---

### Task 8: Phase 1 PR

- [ ] **Step 1: open PR**

```bash
git push -u origin <branch>
gh pr create --title "fix(workspace): thread version through workspace:read so conversations:drop-turn persists" \
             --body-file /tmp/pr-body-phase-1.md
```

PR body should call out:
- The 4 invariants J1–J5 status.
- The end-to-end test in Task 7 as proof of the fix.
- That `WorkspaceReadOutput.version` is optional, so any future backend can ship without populating it (no-op fallback to today's behavior).

---

## Phase 2: `chat:turn-end` `turnId`

Wire the assistant-turn uuid through from the runner to the routines silence path so `conversations:drop-turn` can actually identify the turn to remove.

### Task 9: extend `EventTurnEndSchema`

**Files:**
- Modify: `packages/ipc-protocol/src/events.ts`
- Modify: tests under `packages/ipc-protocol/src/__tests__/` (find the existing test file for event schemas)

- [ ] **Step 1: edit schema**

```ts
export const EventTurnEndSchema = z.object({
  reqId: z.string().optional(),
  reason: z.enum(['user-message-wait', 'error', 'complete']),
  usage: z.object({...}).optional(),
  contentBlocks: z.array(ContentBlockSchema).optional(),
  role: z.enum(['user', 'assistant', 'tool']).optional(),
  /** Stable identifier for the turn the runner just emitted, used by
   * subscribers (e.g., @ax/routines silence-token logic) that need to
   * refer back to this specific turn — usually the jsonl line's uuid
   * for the assistant turn this event closes. Optional until producers
   * adopt it (see @ax/agent-claude-sdk-runner Phase 2 task). */
  turnId: z.string().optional(),
});
```

- [ ] **Step 2: write a test**

In the event schema tests, assert `turnId` is optional and round-trips:

```ts
expect(EventTurnEndSchema.safeParse({
  reason: 'complete', role: 'assistant', turnId: 'uuid-1',
}).success).toBe(true);
```

- [ ] **Step 3: build + test**

```bash
pnpm --filter @ax/ipc-protocol test
pnpm build
```

- [ ] **Step 4: commit**

```bash
git commit -m "feat(ipc-protocol): EventTurnEndSchema gains optional turnId

Identifies the just-emitted turn so subscribers can drop or annotate
it. Optional until runners populate it; consumers (Phase 2 of
routines follow-ups) read it when present. J2 (additive wire change)."
```

---

### Task 10: runner emits `turnId`

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts` (and any helper that wraps the `event.turn-end` emission)
- Add: `packages/agent-claude-sdk-runner/src/__tests__/turn-end-uuid.test.ts`

The runner doesn't currently track the assistant turn's uuid. The Claude SDK writes a jsonl line; the runner needs to capture that uuid before emitting `event.turn-end`. Two reasonable approaches:

**Approach A (preferred): read the jsonl tail after the SDK writes.**
After the SDK yields, before emitting the `assistant` turn-end, list `.claude/projects/**/<sessionId>.jsonl` via the runner's local fs, read the last line of the file, parse the JSON, and use its `uuid`. Cheap (file is small, just-written) and authoritative (matches what `conversations:drop-turn` will look for).

**Approach B: capture from the SDK's message callback.**
If the SDK exposes a per-message hook with the uuid, grab it there. Less code but couples to an SDK-internal contract — fragile.

Go with **Approach A**.

- [ ] **Step 1: write the failing test**

Create `packages/agent-claude-sdk-runner/src/__tests__/turn-end-uuid.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLastTurnUuid } from '../turn-end-uuid.js';

describe('readLastTurnUuid', () => {
  it('returns the uuid of the last assistant line in the jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-runner-uuid-'));
    try {
      const file = join(dir, 'sess.jsonl');
      writeFileSync(file, [
        JSON.stringify({ type: 'user', uuid: 'u1' }),
        JSON.stringify({ type: 'assistant', uuid: 'a1', message: { id: 'm1' } }),
        JSON.stringify({ type: 'assistant', uuid: 'a2', message: { id: 'm2' } }),
      ].join('\n') + '\n');
      const uuid = await readLastTurnUuid(file, 'assistant');
      expect(uuid).toBe('a2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no matching line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-runner-uuid-'));
    try {
      const file = join(dir, 'sess.jsonl');
      writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1' }) + '\n');
      expect(await readLastTurnUuid(file, 'assistant')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined on missing file', async () => {
    expect(await readLastTurnUuid('/does/not/exist.jsonl', 'assistant')).toBeUndefined();
  });
});
```

- [ ] **Step 2: implement helper**

Create `packages/agent-claude-sdk-runner/src/turn-end-uuid.ts`:

```ts
import { readFile } from 'node:fs/promises';

/**
 * Read the jsonl transcript and return the uuid of the LAST line whose
 * `type` matches the requested role. Used by event.turn-end emission to
 * surface the just-written turn's uuid so subscribers can refer back
 * (e.g., conversations:drop-turn). Returns undefined on missing file,
 * parse error, or no matching line — non-fatal.
 */
export async function readLastTurnUuid(
  jsonlPath: string,
  type: 'assistant' | 'user' | 'tool',
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(jsonlPath, 'utf-8');
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      const o = JSON.parse(line) as { type?: string; uuid?: string };
      if (o.type === type && typeof o.uuid === 'string') {
        return o.uuid;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}
```

- [ ] **Step 3: wire in main.ts**

Around line 750 in `packages/agent-claude-sdk-runner/src/main.ts` (the assistant turn-end emission), look up the uuid via `readLastTurnUuid(jsonlPath, 'assistant')` and include it in the event. The jsonl path is what the runner already knows (it lives at `${cwd}/.claude/projects/<slug>/<sessionId>.jsonl`).

```ts
const assistantBlocks = turnContentBlocks;
turnContentBlocks = [];
const turnId = await readLastTurnUuid(jsonlPath, 'assistant');
await client
  .event('event.turn-end', {
    reason: 'user-message-wait',
    role: 'assistant',
    ...(assistantBlocks.length > 0 ? { contentBlocks: assistantBlocks } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  })
  .catch(() => { /* host may be tearing down; non-fatal */ });
```

Same treatment for the `role: 'tool'` emission a few lines above — pass `type: 'user'` (tool_result blocks are echoed by the SDK as user messages).

Identify `jsonlPath` from the runner's existing context. If the runner doesn't already track it as a local variable, derive it once near the top of the message loop and reuse.

- [ ] **Step 4: tests**

```bash
pnpm --filter @ax/agent-claude-sdk-runner test
```

- [ ] **Step 5: commit**

```bash
git commit -m "feat(agent-claude-sdk-runner): include turnId on event.turn-end

Reads the just-written jsonl tail to extract the uuid of the
assistant turn (or the user line carrying tool_result blocks) and
includes it on the event.turn-end emission. Subscribers can refer
back to this specific turn — first consumer is @ax/routines'
silence-token drop-turn path (Task 11 in this plan).

Non-fatal on missing file, parse error, or no matching line — the
event still emits without turnId and consumers gracefully skip."
```

---

### Task 11: routines silence path uses `turnId`

**Files:**
- Modify: `packages/routines/src/plugin.ts`
- Modify: `packages/routines/src/__tests__/canary.test.ts`

The plugin already has the guard `if (typeof turnId === 'string' && turnId.length > 0)`. After Task 10, real chat:turn-end events carry `turnId`, so the guard now exercises the drop-turn path in production.

- [ ] **Step 1: update canary mock**

In `packages/routines/src/__tests__/canary.test.ts`, the agent:invoke mock that emits chat:turn-end should now include a `turnId`:

```ts
await busRef.current!.bus.fire('chat:turn-end', ctx, {
  reqId: ctx.reqId,
  turnId: 'fake-uuid-1',
  contentBlocks: replyOnInvoke.contentBlocks,
});
```

The silence test's assertion changes back:

```ts
// chat:turn-end now carries turnId, so the silence path drops the turn.
expect(captured.drops).toHaveLength(1);
expect(captured.drops[0]!.turnId).toBe('fake-uuid-1');
expect(captured.hides).toHaveLength(1);
```

- [ ] **Step 2: keep the defensive guard, update its log**

In `packages/routines/src/plugin.ts`, the guard stays — it's still right to skip when missing. Update the log message to reflect "shouldn't happen post-Phase-2":

```ts
} else {
  // Post-routines-followups Phase 2: chat:turn-end carries turnId
  // from runners. A missing turnId now indicates either an
  // older runner version or a bug — log loud, skip safe.
  ctx.logger.warn('routines_drop_turn_skipped_no_turn_id', {
    conversationId: pf.conversationId,
  });
}
```

- [ ] **Step 3: tests**

```bash
pnpm --filter @ax/routines test
```

- [ ] **Step 4: commit**

```bash
git commit -m "feat(routines): exercise drop-turn when chat:turn-end carries turnId

Phase 2 of routines follow-ups closes the silence-token drop loop.
Canary mock emits turnId; the silence path now actually calls
conversations:drop-turn (which, post-Phase-1, persists the jsonl
rewrite via the version-as-parent fix).

The defensive 'skip when missing' guard remains. Post-Phase-2,
missing turnId means either a pre-Phase-2 runner image or a runner
bug — surface as a warn so it's visible in logs."
```

---

### Task 12: Phase 2 PR

- [ ] Push, open PR titled `feat(routines): wire turnId through chat:turn-end so silence-token actually drops the turn`. Reference the Phase 1 PR in the body since the end-to-end value depends on Phase 1's CAS fix.

---

## Phase 3: tick-loop advisory-lock connection pinning

Smallest of the three. Kysely 0.28's `db.connection(cb)` API binds a pool connection for the duration of the callback. We wrap the inner tick loop in that callback so try-lock, claim, advance, and unlock all share one backend connection — same session, same advisory lock.

### Task 13: pin connection in `runTickLoop`

**Files:**
- Modify: `packages/routines/src/tick.ts`
- Modify: `packages/routines/src/__tests__/tick.test.ts`

- [ ] **Step 1: write the failing race test**

Add to `packages/routines/src/__tests__/tick.test.ts`:

```ts
it('only one runTickLoop instance holds the advisory lock at a time', async () => {
  // Two concurrent runTickLoops against the same DB. Both should not
  // claim the same row (correctness already guaranteed by FOR UPDATE
  // SKIP LOCKED). The advisory lock should additionally prevent the
  // second loop from even entering its inner tick — proven by observing
  // that only ONE loop's fire() callback was invoked.
  const store = createRoutinesStore(db);
  await seedInterval(store, 'agt_a', '60s', new Date('2026-05-14T12:00:00Z'));
  let fireA = 0, fireB = 0;
  const fakeClock: Clock = {
    now: () => new Date('2026-05-14T12:01:00Z'),
    sleep: async () => {},
  };
  const ctlA = new AbortController();
  const ctlB = new AbortController();
  const runA = runTickLoop({
    db, store, fire: async () => { fireA++; return { status: 'ok', error: null }; },
    clock: fakeClock, signal: ctlA.signal,
    tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 10, claimWindowMinutes: 5,
  });
  const runB = runTickLoop({
    db, store, fire: async () => { fireB++; return { status: 'ok', error: null }; },
    clock: fakeClock, signal: ctlB.signal,
    tickIntervalMs: 1, electionRetryMs: 1, claimBatchSize: 10, claimWindowMinutes: 5,
  });
  // Let them race a few ticks.
  await new Promise((r) => setTimeout(r, 50));
  ctlA.abort(); ctlB.abort();
  await Promise.all([runA, runB]);
  // Only one loop should have fired the routine. The "best-effort"
  // election today can have both inside the inner loop briefly; after
  // the connection-pin fix this should be deterministic.
  expect(fireA + fireB).toBe(1);
});
```

- [ ] **Step 2: update `runTickLoop`**

In `packages/routines/src/tick.ts`, wrap the inner loop in `db.connection(...)`:

```ts
export async function runTickLoop(input: TickLoopInput): Promise<void> {
  while (!input.signal.aborted) {
    // Connection-pin the entire lifetime of one election attempt + tick
    // burst. pg_try_advisory_lock is session-scoped; the lock acquired
    // here is held only for the duration of the callback (Kysely returns
    // the connection to the pool on exit, which also releases the lock).
    await input.db.connection().execute(async (pinned) => {
      const acquired = await tryAcquireAdvisoryLock(pinned);
      if (!acquired) {
        await input.clock.sleep(input.electionRetryMs, input.signal);
        return;
      }
      try {
        while (!input.signal.aborted) {
          try {
            await runTickOnce({
              store: input.store, fire: input.fire,
              now: input.clock.now(),
              claimBatchSize: input.claimBatchSize,
              claimWindowMinutes: input.claimWindowMinutes,
            });
          } catch (err) {
            process.stderr.write(`[ax/routines] tick error: ${err instanceof Error ? err.message : String(err)}\n`);
          }
          await input.clock.sleep(input.tickIntervalMs, input.signal);
        }
      } finally {
        await releaseAdvisoryLock(pinned);
      }
    });
  }
}
```

`tryAcquireAdvisoryLock` and `releaseAdvisoryLock` now accept a `Kysely<RoutinesDatabase>` that is actually the pinned connection (Kysely's connection-bound builder is compatible with the same type — verify this signature against Kysely 0.28 docs before committing).

Note: `store` operations inside `runTickOnce` still go through the pool (not the pinned connection). That's OK — `claimDue`'s correctness comes from `FOR UPDATE SKIP LOCKED`, which is row-level not session-level. The advisory lock just gates which replica is the active "ticker."

- [ ] **Step 3: run tests**

```bash
pnpm --filter @ax/routines test
```

The race test from Step 1 should pass. All existing tests should still pass.

- [ ] **Step 4: commit**

```bash
git commit -m "fix(routines): pin connection for advisory-lock tick election

pg_try_advisory_lock and pg_advisory_unlock are session-scoped. Calling
them on a Kysely pool runs them on whatever connection the pool hands
out — likely DIFFERENT backends, so the unlock no-ops and the lock
lingers until the original connection times out. Wrap the inner tick
loop in db.connection(...) so both the lock and the loop body share one
backend connection.

Correctness already comes from claimDue's FOR UPDATE SKIP LOCKED;
this fix lets the election lock do its actual job. Test: two
concurrent runTickLoops against the same DB are now mutually
exclusive (only one fires)."
```

---

### Task 14: Phase 3 PR

- [ ] Push, open PR titled `fix(routines): connection-pin advisory lock in tick loop election`. Self-contained — no Phase 1 / Phase 2 dependency.

---

## Sequencing

The three phases are independent and can land in any order. Suggested merge order, easiest first:

1. **Phase 3** (advisory lock) — smallest, no cross-package surface.
2. **Phase 1** (workspace version) — biggest, touches 5 packages but each change is small.
3. **Phase 2** (turnId) — depends on Phase 1 to actually persist the drop, otherwise canary is misleading. (Phase 2 *can* land before Phase 1, but the silence path's drop call still fails parent-mismatch in production until Phase 1 ships.)

If shipping all three as one PR is preferred (smaller surface for reviewers + one canary that proves the whole chain), sequence the tasks 1 → 14 in one branch and open one PR. The plan above is structured so either approach works.

---

## Verification (per phase)

Before opening each PR:

```bash
pnpm build
pnpm test
pnpm lint
```

All three must be clean. Recall the workflow note: pre-PR check is **build + test + lint**, not just build + test.

---

## Spec deviation tracking

If anything in the implementation diverges from this plan, log it in the PR body as:

> **Deviation:** <what changed> — **Why:** <reason> — **Impact:** <follow-up work or none>

Update [`project_routines_phase_b_pr71.md`](~/.claude/projects/-Users-vpulim-dev-ai-ax-next/memory/project_routines_phase_b_pr71.md) to flip the relevant follow-up from "known follow-up" to "shipped in PR #N" once each phase merges.

---

## Summary of expected commits

**Phase 1 (workspace version):**
1. `feat(core): extend WorkspaceReadOutput with optional version`
2. `feat(workspace-protocol): WorkspaceReadResponseSchema gains optional version`
3. `feat(workspace-git-core): include version in workspace:read response`
4. `feat(workspace-git-server): round-trip version on workspace:read over HTTP`
5. `feat(test-harness): mock workspace tracks + returns version on read`
6. `fix(conversations): drop-turn passes read.version as workspace:apply parent`
7. `test(conversations): end-to-end drop-turn against real git workspace`

**Phase 2 (turnId):**
8. `feat(ipc-protocol): EventTurnEndSchema gains optional turnId`
9. `feat(agent-claude-sdk-runner): include turnId on event.turn-end`
10. `feat(routines): exercise drop-turn when chat:turn-end carries turnId`

**Phase 3 (advisory lock):**
11. `fix(routines): pin connection for advisory-lock tick election`
