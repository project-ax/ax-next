# Routines — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the three new service hooks on `@ax/conversations` (`hide`, `drop-turn`, `find-or-create`) plus the `hidden` column migration. No callers yet — these are the foundation that Phase B's routines plugin will use. Phase A ships with full unit-test coverage and the canary boot loads the updated `@ax/conversations` manifest, closing the half-wired window in the same PR.

**Architecture:** All work is contained inside `packages/conversations`. We add (a) one ALTER to the `conversations_v1_conversations` table, (b) three new entries to the plugin's `registers` list, (c) three handler functions wired in `init()`, (d) corresponding store methods, (e) unit tests for each handler. The conversations sidebar query already filters `WHERE deleted_at IS NULL`; we extend it to also exclude `WHERE hidden = false`.

**Tech Stack:** TypeScript + Kysely + Postgres (existing). Test runner is vitest (`pnpm test --filter @ax/conversations`).

**Spec:** `docs/plans/2026-05-14-routines-design.md` §1, §3, §5.4, §7.3.

---

## File Structure

**Modify:**
- `packages/conversations/src/migrations.ts` — add `hidden` column (idempotent ALTER).
- `packages/conversations/src/types.ts` — add payload types for the three new hooks; add `hidden: boolean` to `Conversation`.
- `packages/conversations/src/store.ts` — add `hide`, `dropTurn`, `findOrCreate` store methods; extend list queries to filter on `hidden`.
- `packages/conversations/src/plugin.ts` — add hook registrations + handler wiring; extend `registers` manifest entry.
- `packages/conversations/src/__tests__/migrations.test.ts` — assert the `hidden` column exists after migration.

**Create:**
- `packages/conversations/src/__tests__/hide.test.ts` — unit tests for `conversations:hide`.
- `packages/conversations/src/__tests__/drop-turn.test.ts` — unit tests for `conversations:drop-turn`.
- `packages/conversations/src/__tests__/find-or-create.test.ts` — unit tests for `conversations:find-or-create`.

**Do not touch:** `packages/cli`, `packages/channel-web`, `packages/sandbox-k8s`. The canary loads the updated `@ax/conversations` automatically — no preset changes needed.

---

## Task 1: Add the `hidden` column migration

**Files:**
- Modify: `packages/conversations/src/migrations.ts`
- Modify: `packages/conversations/src/__tests__/migrations.test.ts`

- [ ] **Step 1: Write the failing migration test**

Open `packages/conversations/src/__tests__/migrations.test.ts` and add a new `it` block at the end of the existing `describe('runConversationsMigration', ...)`:

```ts
it('adds a hidden column defaulting to false', async () => {
  await runConversationsMigration(db);
  // Insert a fresh row and confirm `hidden` is false by default.
  await db.insertInto('conversations_v1_conversations')
    .values({ conversation_id: 'c-hidden-default', user_id: 'u1', agent_id: 'a1' })
    .execute();
  const row = await db.selectFrom('conversations_v1_conversations')
    .select(['hidden'])
    .where('conversation_id', '=', 'c-hidden-default')
    .executeTakeFirstOrThrow();
  expect(row.hidden).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/conversations -- migrations.test.ts
```

Expected: FAIL with "column 'hidden' does not exist" or similar Postgres error.

- [ ] **Step 3: Add the ALTER to the migration**

Locate the `ALTER TABLE conversations_v1_conversations` block near the end of `runConversationsMigration` (it already has multiple `ADD COLUMN IF NOT EXISTS` entries for the Phase B runner-owned-sessions fields). Add one more line, idempotently:

```ts
await sql`
  ALTER TABLE conversations_v1_conversations
    ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE
`.execute(db);
```

Place this immediately AFTER the existing `last_activity_at` ALTER and BEFORE the legacy `DROP TABLE conversations_v1_turns IF EXISTS` statement. The ordering matters for code-review clarity (logically grouped with the other ADD COLUMNs).

Also extend the `ConversationsTable` row type in `migrations.ts` (whatever its exported name is — check the existing declaration):

```ts
// Existing interface — add the new field
export interface ConversationsRow {
  // ... existing fields ...
  hidden: boolean;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test --filter @ax/conversations -- migrations.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/conversations/src/migrations.ts packages/conversations/src/__tests__/migrations.test.ts
git commit -m "feat(conversations): add hidden column for routines-driven suppression

Phase A foundation for the @ax/routines plugin. Adds a hidden BOOLEAN
column (default FALSE) to conversations_v1_conversations so silenced
routine fires can hide their conversation from the sidebar without
deleting it. Idempotent ADD COLUMN IF NOT EXISTS keeps re-runs safe."
```

---

## Task 2: Extend `Conversation` type and store list queries to expose `hidden`

**Files:**
- Modify: `packages/conversations/src/types.ts:Conversation`
- Modify: `packages/conversations/src/store.ts`

- [ ] **Step 1: Write the failing test for the type field**

Add to `packages/conversations/src/__tests__/types-shape.test.ts`:

```ts
it('Conversation exposes hidden boolean', () => {
  const c: Conversation = makeFixtureConversation();   // existing helper
  expect(typeof c.hidden).toBe('boolean');
  expect(c.hidden).toBe(false);
});
```

(If `makeFixtureConversation` doesn't exist, look for the existing pattern in `types-shape.test.ts` — most likely an inline literal — and follow it.)

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test --filter @ax/conversations -- types-shape.test.ts
```

Expected: FAIL with "Property 'hidden' is missing" or runtime undefined.

- [ ] **Step 3: Add `hidden` to the `Conversation` interface**

In `packages/conversations/src/types.ts`, locate `export interface Conversation` and add:

```ts
export interface Conversation {
  // ... existing fields ...
  /**
   * Phase A (routines-plugin foundation, 2026-05-14). Set to true by
   * `conversations:hide`. Excluded from list-by-user/agent queries.
   * Hidden conversations remain readable by id — they just don't appear
   * in the sidebar. Used by the routines plugin to suppress silenced routine
   * fires without losing their fire-log row.
   */
  hidden: boolean;
}
```

- [ ] **Step 4: Update store row-to-Conversation mapper**

In `packages/conversations/src/store.ts`, find the function/expression that maps a DB row to a `Conversation` (usually called something like `rowToConversation` or inlined in `get` / `list`). Add `hidden: row.hidden` to the mapper.

If the mapper is inlined across multiple call sites, refactor to a single helper (`rowToConversation`) in this step. Keep the change small — only extract if it's needed in more than two places.

- [ ] **Step 5: Update list-by-user/agent queries to exclude hidden**

Find every `selectFrom('conversations_v1_conversations')` that returns a list of conversations for sidebar/listing purposes. Add `.where('hidden', '=', false)` to each.

Specifically:
- The handler for `conversations:list` (or whatever the sidebar query is called) — most likely in `plugin.ts` or `store.ts`.
- The Phase B `last_activity_at` query path.

Do NOT modify single-conversation `get` / `get-by-req-id` / `get-metadata` queries — hidden conversations must remain readable by id.

- [ ] **Step 6: Add a list-excludes-hidden test**

Add to `packages/conversations/src/__tests__/lifecycle.test.ts` (or wherever list tests live):

```ts
it('list-by-user excludes hidden conversations', async () => {
  await store.create({ userId: 'u1', agentId: 'a1' /* ... */ });
  const c2 = await store.create({ userId: 'u1', agentId: 'a1' /* ... */ });
  // Direct DB write to simulate hide (the hook lands in Task 3).
  await db.updateTable('conversations_v1_conversations')
    .set({ hidden: true })
    .where('conversation_id', '=', c2.conversationId)
    .execute();
  const list = await store.listForUser({ userId: 'u1' });
  expect(list.map((c) => c.conversationId)).not.toContain(c2.conversationId);
});

it('get-by-id returns hidden conversations', async () => {
  const c = await store.create(/* ... */);
  await db.updateTable('conversations_v1_conversations')
    .set({ hidden: true })
    .where('conversation_id', '=', c.conversationId)
    .execute();
  const got = await store.get({ conversationId: c.conversationId });
  expect(got).not.toBeNull();
  expect(got!.hidden).toBe(true);
});
```

- [ ] **Step 7: Run the full conversations test suite**

```bash
pnpm test --filter @ax/conversations
```

Expected: ALL PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/conversations/src/types.ts packages/conversations/src/store.ts packages/conversations/src/__tests__/
git commit -m "feat(conversations): expose hidden field on Conversation; exclude from list queries

Adds Conversation.hidden to the type surface and updates the
list-by-user/agent queries to filter WHERE hidden = false. Hidden
conversations remain readable by id (single-get unchanged) so the
routines plugin can still write fire-log rows that reference them."
```

---

## Task 3: Add `conversations:hide` service hook

**Files:**
- Modify: `packages/conversations/src/types.ts` — add `HideInput` / `HideOutput`.
- Modify: `packages/conversations/src/store.ts` — add `hide(conversationId)` method.
- Modify: `packages/conversations/src/plugin.ts` — register `conversations:hide` and wire handler.
- Create: `packages/conversations/src/__tests__/hide.test.ts` — unit tests.

- [ ] **Step 1: Add payload types**

In `packages/conversations/src/types.ts`, add near the other hook-payload interfaces:

```ts
export interface HideInput {
  conversationId: string;
}

// void — caller does not need a return value.
export type HideOutput = void;
```

- [ ] **Step 2: Write the failing hook test**

Create `packages/conversations/src/__tests__/hide.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { makeAgentContext } from '@ax/core';
import { setupConversationsTestFixture } from './_fixture.js'; // adjust to existing test helper

describe('conversations:hide', () => {
  let fix: Awaited<ReturnType<typeof setupConversationsTestFixture>>;
  beforeEach(async () => {
    fix = await setupConversationsTestFixture();
  });

  it('marks a conversation hidden', async () => {
    const c = await fix.bus.call('conversations:create', fix.ctx, {
      userId: 'u1', agentId: 'a1' /* fill in required fields per existing CreateInput */,
    });

    await fix.bus.call('conversations:hide', fix.ctx, {
      conversationId: c.conversationId,
    });

    const got = await fix.bus.call('conversations:get', fix.ctx, {
      conversationId: c.conversationId,
    });
    expect(got).not.toBeNull();
    expect(got!.hidden).toBe(true);
  });

  it('is idempotent — hiding an already-hidden conversation is a no-op', async () => {
    const c = await fix.bus.call('conversations:create', fix.ctx, { /* ... */ });
    await fix.bus.call('conversations:hide', fix.ctx, { conversationId: c.conversationId });
    // Second call must not throw.
    await fix.bus.call('conversations:hide', fix.ctx, { conversationId: c.conversationId });

    const got = await fix.bus.call('conversations:get', fix.ctx, {
      conversationId: c.conversationId,
    });
    expect(got!.hidden).toBe(true);
  });

  it('throws PluginError code=not-found for unknown conversation_id', async () => {
    await expect(
      fix.bus.call('conversations:hide', fix.ctx, { conversationId: 'no-such-conv' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('excluded from list-by-user after hide', async () => {
    const c = await fix.bus.call('conversations:create', fix.ctx, { /* userId: 'u1' */ });
    await fix.bus.call('conversations:hide', fix.ctx, { conversationId: c.conversationId });
    const list = await fix.bus.call('conversations:list', fix.ctx, { userId: 'u1' });
    expect(list.map((x: any) => x.conversationId)).not.toContain(c.conversationId);
  });
});
```

*(If `setupConversationsTestFixture` doesn't exist under that exact name, look at how `lifecycle.test.ts` or `plugin.test.ts` sets up their fixture — copy that pattern.)*

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm test --filter @ax/conversations -- hide.test.ts
```

Expected: FAIL — no service registered for `conversations:hide`.

- [ ] **Step 4: Add `hide` to the store**

In `packages/conversations/src/store.ts`, add a method to the store-factory function (alongside `create`, `get`, etc.):

```ts
async function hide(conversationId: string): Promise<void> {
  const result = await db
    .updateTable('conversations_v1_conversations')
    .set({ hidden: true, updated_at: sql`now()` })
    .where('conversation_id', '=', conversationId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (result.numUpdatedRows === 0n) {
    // Either it doesn't exist or it's soft-deleted. Either way: not-found.
    throw new PluginError({
      code: 'not-found',
      hookName: 'conversations:hide',
      message: `conversation ${conversationId} not found`,
    });
  }
}
```

Export `hide` from the factory's return object alongside the existing methods.

- [ ] **Step 5: Register the service hook**

In `packages/conversations/src/plugin.ts`:

1. Add `'conversations:hide'` to the `registers: [...]` array in the manifest.
2. Inside `init({ bus, ... })`, after the existing `bus.registerService` calls, add:

```ts
bus.registerService<HideInput, HideOutput>(
  'conversations:hide',
  PLUGIN_NAME,
  async (_ctx, input) => {
    await store.hide(input.conversationId);
  },
);
```

3. Import `HideInput` / `HideOutput` at the top.

- [ ] **Step 6: Run the test to verify it passes**

```bash
pnpm test --filter @ax/conversations -- hide.test.ts
```

Expected: ALL PASS.

- [ ] **Step 7: Run the full conversations test suite**

```bash
pnpm test --filter @ax/conversations
```

Expected: ALL PASS (no regression in any existing test).

- [ ] **Step 8: Commit**

```bash
git add packages/conversations/src/
git commit -m "feat(conversations): add conversations:hide service hook

Marks a conversation as hidden so it disappears from list queries but
remains readable by id. Idempotent. Throws not-found if the
conversation is unknown or soft-deleted. Foundation for routines-
driven silence-token suppression (Phase B will call this from the
chat:turn-end one-shot subscriber)."
```

---

## Task 4: Add `conversations:drop-turn` service hook

**Files:**
- Modify: `packages/conversations/src/types.ts` — add `DropTurnInput` / `DropTurnOutput`.
- Modify: `packages/conversations/src/store.ts` — add `dropTurn(conversationId, turnId)` method.
- Modify: `packages/conversations/src/plugin.ts` — register and wire.
- Create: `packages/conversations/src/__tests__/drop-turn.test.ts`.

**Important context:** Phase E (per memory) dropped `conversations_v1_turns` — turn storage is now runner-native jsonl on the workspace. So `drop-turn` is **not** a SQL delete. It must apply to the runner-native transcript.

Open `packages/conversations/src/plugin.ts` first and search for how `conversations:get-from-workspace` (or whatever reads turns from jsonl) is implemented. The drop must:

1. Find the jsonl path for the conversation (likely via `runner_session_id` + workspace).
2. Rewrite the jsonl, dropping the line for the matching `turnId`.
3. Commit the workspace change back via `workspace:apply` so the change is durable.

If the existing read path uses `parseJsonlToTurns` from `@ax/agent-claude-sdk-runner-host`, find the corresponding write/delete primitive. If there isn't one yet, **defer drop-turn's actual implementation to Phase B** and ship Phase A with a stub that throws `not-implemented`. Spec deviation: note this explicitly in the PR notes ("Phase A ships `conversations:drop-turn` registered but throwing — Phase B's routines plugin will land the runner-native delete path together with its first caller").

- [ ] **Step 1: Read the existing turn-fetch path**

```bash
grep -rn "parseJsonlToTurns\|getFromWorkspace\|get-from-workspace" packages/conversations/src/ | head -20
```

Note the file/line where turns are read. The matching write path may or may not exist — if you find a `writeJsonl` or `appendToJsonl` or similar, drop-turn becomes a rewrite-with-filter operation. If only the read path exists, take the stub route in Step 2b.

- [ ] **Step 2a (preferred): Implement drop-turn against the runner-native jsonl**

If a write primitive exists, follow that pattern. Write the test first (rewrite the jsonl to exclude one line, assert subsequent reads omit that turn).

- [ ] **Step 2b (fallback): Ship the stub**

If the write primitive doesn't exist, register the hook but throw inside the handler:

```ts
bus.registerService<DropTurnInput, DropTurnOutput>(
  'conversations:drop-turn',
  PLUGIN_NAME,
  async (_ctx, _input) => {
    throw new PluginError({
      code: 'not-implemented',
      hookName: 'conversations:drop-turn',
      message: 'Phase A stub — actual implementation lands in Phase B alongside its first caller',
    });
  },
);
```

And the test asserts the throw:

```ts
it('throws not-implemented (Phase A stub)', async () => {
  await expect(
    fix.bus.call('conversations:drop-turn', fix.ctx, {
      conversationId: 'c1', turnId: 't1',
    }),
  ).rejects.toMatchObject({ code: 'not-implemented' });
});
```

Document the deviation in the commit message.

- [ ] **Step 3: Add payload types**

```ts
// types.ts
export interface DropTurnInput {
  conversationId: string;
  turnId: string;
}
export type DropTurnOutput = void;
```

- [ ] **Step 4: Register the hook**

In `plugin.ts`:
1. Add `'conversations:drop-turn'` to `registers`.
2. Wire the handler per Step 2a or 2b.

- [ ] **Step 5: Run tests**

```bash
pnpm test --filter @ax/conversations -- drop-turn.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full test suite**

```bash
pnpm test --filter @ax/conversations
```

Expected: ALL PASS.

- [ ] **Step 7: Commit**

For Step 2a (full impl):
```bash
git add packages/conversations/src/
git commit -m "feat(conversations): add conversations:drop-turn service hook

Rewrites the runner-native transcript jsonl to exclude the named
turnId, then commits the change via workspace:apply. Used by the
routines plugin's silence-token logic in Phase B to drop the agent's
HEARTBEAT_OK reply before it lands in the user-visible conversation."
```

For Step 2b (stub):
```bash
git add packages/conversations/src/
git commit -m "feat(conversations): register conversations:drop-turn (stub)

Hook surface added now (Phase A foundation), but the actual
runner-native jsonl rewrite path lands in Phase B alongside its
first caller (the routines plugin's silence-token logic). Calling the stub
throws not-implemented. Half-wired window stays open through Phase B."
```

---

## Task 5: Add `conversations:find-or-create` service hook

**Files:**
- Modify: `packages/conversations/src/types.ts` — add `FindOrCreateInput` / `FindOrCreateOutput`.
- Modify: `packages/conversations/src/store.ts` — add `findOrCreate(externalKey, fallbackInput)`.
- Modify: `packages/conversations/src/migrations.ts` — add an `external_key` column + partial unique index.
- Modify: `packages/conversations/src/plugin.ts` — register and wire.
- Create: `packages/conversations/src/__tests__/find-or-create.test.ts`.

**Why `external_key`:** Routines with `conversation: shared` need a stable lookup key that survives across fires. The natural key is `(agent_id, routine_path)`, but conversations don't currently store routine path. We add a generic `external_key TEXT NULL` column, scoped per `(user_id, agent_id, external_key)`, plus a partial unique index. The routines plugin passes `external_key = routine_path` for shared routines; other callers can leave it null.

- [ ] **Step 1: Migration test — column + unique index**

Add to `migrations.test.ts`:

```ts
it('adds external_key column and partial unique index', async () => {
  await runConversationsMigration(db);

  // Insert two rows with the same external_key but different users — must be allowed.
  await db.insertInto('conversations_v1_conversations').values({
    conversation_id: 'c1', user_id: 'u1', agent_id: 'a1', external_key: 'k1',
  }).execute();
  await db.insertInto('conversations_v1_conversations').values({
    conversation_id: 'c2', user_id: 'u2', agent_id: 'a1', external_key: 'k1',
  }).execute();

  // Inserting a second row with the SAME (user_id, agent_id, external_key) must throw.
  await expect(
    db.insertInto('conversations_v1_conversations').values({
      conversation_id: 'c3', user_id: 'u1', agent_id: 'a1', external_key: 'k1',
    }).execute(),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test --filter @ax/conversations -- migrations.test.ts
```

Expected: FAIL — `external_key` column does not exist.

- [ ] **Step 3: Add column + unique index to migration**

In `runConversationsMigration`, after the `hidden` column ALTER:

```ts
await sql`
  ALTER TABLE conversations_v1_conversations
    ADD COLUMN IF NOT EXISTS external_key TEXT
`.execute(db);

await sql`
  CREATE UNIQUE INDEX IF NOT EXISTS conversations_v1_external_key_unique
    ON conversations_v1_conversations (user_id, agent_id, external_key)
    WHERE external_key IS NOT NULL AND deleted_at IS NULL
`.execute(db);
```

Update `ConversationsRow` interface in the same file:

```ts
external_key: string | null;
```

- [ ] **Step 4: Run migration test — verify passes**

```bash
pnpm test --filter @ax/conversations -- migrations.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add `externalKey` to Conversation type**

In `types.ts`:

```ts
export interface Conversation {
  // ... existing ...
  externalKey: string | null;
}
```

Update the row→Conversation mapper in `store.ts` to include `externalKey: row.external_key`.

- [ ] **Step 6: Hook payload types**

```ts
// types.ts
export interface FindOrCreateInput {
  userId: string;
  agentId: string;
  externalKey: string;          // required — that's the whole point of this hook
  // Fields used when creating a new conversation:
  fallback: Omit<CreateInput, 'externalKey'>;  // re-uses existing CreateInput shape
}

export interface FindOrCreateOutput {
  conversation: Conversation;
  created: boolean;             // true if a new row was inserted; false if found existing
}
```

- [ ] **Step 7: Write the failing hook test**

Create `packages/conversations/src/__tests__/find-or-create.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setupConversationsTestFixture } from './_fixture.js';

describe('conversations:find-or-create', () => {
  let fix: Awaited<ReturnType<typeof setupConversationsTestFixture>>;
  beforeEach(async () => { fix = await setupConversationsTestFixture(); });

  it('creates a new conversation on first call', async () => {
    const out = await fix.bus.call('conversations:find-or-create', fix.ctx, {
      userId: 'u1', agentId: 'a1', externalKey: 'routine:.ax/routines/heartbeat.md',
      fallback: { /* required Create fields */ },
    });
    expect(out.created).toBe(true);
    expect(out.conversation.externalKey).toBe('routine:.ax/routines/heartbeat.md');
  });

  it('returns the existing conversation on second call with same key', async () => {
    const first = await fix.bus.call('conversations:find-or-create', fix.ctx, {
      userId: 'u1', agentId: 'a1', externalKey: 'k', fallback: { /* ... */ },
    });
    const second = await fix.bus.call('conversations:find-or-create', fix.ctx, {
      userId: 'u1', agentId: 'a1', externalKey: 'k', fallback: { /* ... */ },
    });
    expect(second.created).toBe(false);
    expect(second.conversation.conversationId).toBe(first.conversation.conversationId);
  });

  it('scopes per (userId, agentId, externalKey) — different user gets a separate row', async () => {
    const a = await fix.bus.call('conversations:find-or-create', fix.ctx, {
      userId: 'u1', agentId: 'a1', externalKey: 'k', fallback: { /* ... */ },
    });
    const b = await fix.bus.call('conversations:find-or-create', fix.ctx, {
      userId: 'u2', agentId: 'a1', externalKey: 'k', fallback: { /* ... */ },
    });
    expect(b.conversation.conversationId).not.toBe(a.conversation.conversationId);
  });

  it('ignores soft-deleted rows — creates fresh after deletion', async () => {
    const first = await fix.bus.call('conversations:find-or-create', fix.ctx, {
      userId: 'u1', agentId: 'a1', externalKey: 'k', fallback: { /* ... */ },
    });
    await fix.bus.call('conversations:delete', fix.ctx, {
      conversationId: first.conversation.conversationId,
    });
    const second = await fix.bus.call('conversations:find-or-create', fix.ctx, {
      userId: 'u1', agentId: 'a1', externalKey: 'k', fallback: { /* ... */ },
    });
    expect(second.created).toBe(true);
    expect(second.conversation.conversationId).not.toBe(first.conversation.conversationId);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

```bash
pnpm test --filter @ax/conversations -- find-or-create.test.ts
```

Expected: FAIL — no handler.

- [ ] **Step 9: Implement `findOrCreate` in the store**

In `store.ts`:

```ts
async function findOrCreate(
  input: FindOrCreateInput,
): Promise<FindOrCreateOutput> {
  // Select first — the partial unique index makes this race-safe under the
  // INSERT ... ON CONFLICT below. We do the SELECT first to avoid bumping
  // the conversation_id sequence when an existing row will satisfy.
  const existing = await db
    .selectFrom('conversations_v1_conversations')
    .selectAll()
    .where('user_id', '=', input.userId)
    .where('agent_id', '=', input.agentId)
    .where('external_key', '=', input.externalKey)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (existing) {
    return { conversation: rowToConversation(existing), created: false };
  }

  // Race with another find-or-create — INSERT ... ON CONFLICT DO NOTHING.
  // If the conflict-row exists, we re-SELECT it. The partial unique index
  // covers (user_id, agent_id, external_key) WHERE deleted_at IS NULL.
  const created = await create({ ...input.fallback, externalKey: input.externalKey });
  if (created !== null) {
    return { conversation: created, created: true };
  }
  // Lost the race; re-select.
  const winner = await db
    .selectFrom('conversations_v1_conversations')
    .selectAll()
    .where('user_id', '=', input.userId)
    .where('agent_id', '=', input.agentId)
    .where('external_key', '=', input.externalKey)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return { conversation: rowToConversation(winner), created: false };
}
```

You'll need to update `create` to accept an optional `externalKey` and use `.onConflict(...).doNothing()` so the race path returns null cleanly. Refer to Kysely's `OnConflict` builder.

- [ ] **Step 10: Register the hook in `plugin.ts`**

Add `'conversations:find-or-create'` to the `registers` array. Wire the handler:

```ts
bus.registerService<FindOrCreateInput, FindOrCreateOutput>(
  'conversations:find-or-create',
  PLUGIN_NAME,
  async (_ctx, input) => store.findOrCreate(input),
);
```

- [ ] **Step 11: Run all tests**

```bash
pnpm test --filter @ax/conversations
```

Expected: ALL PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/conversations/src/
git commit -m "feat(conversations): add conversations:find-or-create with external_key index

Routines-driven shared conversations need a
stable per-(user, agent, key) conversation lookup. Adds:
  - external_key TEXT column on conversations_v1_conversations
  - partial unique index on (user_id, agent_id, external_key)
    WHERE external_key IS NOT NULL AND deleted_at IS NULL
  - conversations:find-or-create service hook returning
    { conversation, created } so callers know which path ran.

Race-safe via INSERT ... ON CONFLICT DO NOTHING + re-SELECT."
```

---

## Task 6: Half-wired window closure — canary exercises the new manifest

**Files:**
- Verify: `packages/cli/src/main.ts` already loads `@ax/conversations`.
- Verify: `packages/sandbox-k8s` preset already loads `@ax/conversations`.
- Modify: whichever canary integration test exercises a full chat — assert the new hooks are present in the bus.

**Goal:** Per the half-wired window discipline, every phase must reach the canary in the same PR. Since the new hooks have no production caller in Phase A, the closure is "manifest-level reachability + assertion that the hook is registered in the booted system."

- [ ] **Step 1: Locate the canary integration test**

```bash
find packages -name "*.test.ts" -path "*__tests__*" | xargs grep -l "canary\|smoke\|full-boot" 2>/dev/null | head -5
```

Likely candidates: a `boot.test.ts` or `smoke.test.ts` somewhere in `@ax/cli` or `@ax/test-harness`. Read it. If it boots a full preset and exercises `chat:turn-start` end-to-end, that's the canary.

- [ ] **Step 2: Add a hook-registration assertion to the canary test**

Add an assertion after the boot completes:

```ts
it('new conversations hooks are registered after boot (Phase A closure)', async () => {
  const { bus } = await bootCanaryPreset();
  expect(bus.hasService('conversations:hide')).toBe(true);
  expect(bus.hasService('conversations:drop-turn')).toBe(true);
  expect(bus.hasService('conversations:find-or-create')).toBe(true);
});
```

If the bus doesn't expose `hasService`, use whatever the kernel provides — `bus.listServices()` or similar. If no such introspection exists, fall back to calling each hook with a probe input and asserting the call resolves (or throws `not-found` rather than `no-service-registered`):

```ts
// Probe with a known-bad input; we don't care about the result, only that
// SOMETHING is registered to handle it.
await expect(
  bus.call('conversations:hide', ctx, { conversationId: '__probe__' }),
).rejects.toMatchObject({ code: 'not-found' });   // would be 'no-service' if unregistered
```

- [ ] **Step 3: Run the canary test**

```bash
pnpm test --filter <whichever-package-holds-the-canary>
```

Expected: PASS. The new hooks are reachable from the booted system.

- [ ] **Step 4: Commit**

```bash
git add <canary-test-file>
git commit -m "test(canary): assert Phase A conversations hooks are reachable after boot

Closes the half-wired window for Phase A routines plugin foundations: the
new conversations:hide / drop-turn / find-or-create hooks are
verified reachable in the full canary preset. No production callers
yet — those land in Phase B."
```

---

## Task 7: PR notes and final verification

- [ ] **Step 1: Type-check and lint the whole monorepo**

```bash
pnpm build
pnpm test
```

Expected: ALL PASS. If anything outside `@ax/conversations` broke, investigate — type changes (`Conversation.hidden`, `Conversation.externalKey`) may have rippled to subscribers. Fix at the call site, not by reverting the type change.

- [ ] **Step 2: Write the PR body**

```bash
cat > /tmp/pr-body-phase-a.md <<'EOF'
## Summary
- `conversations_v1_conversations.hidden` column (default false) — silenced routine fires hide from sidebar without delete.
- `conversations_v1_conversations.external_key` column + partial unique index — stable per-(user, agent, key) conversation lookup for shared routines.
- Three new service hooks on `@ax/conversations`:
  - `conversations:hide({ conversationId })`
  - `conversations:drop-turn({ conversationId, turnId })` — implementation status: [pick one] full / stub
  - `conversations:find-or-create({ userId, agentId, externalKey, fallback })`
- Canary boot verifies all three are reachable after preset load.

## Why now
Phase A of the routines rollout — see
`docs/plans/2026-05-14-routines-design.md`. These three hooks
plus the schema additions are the foundation Phase B (routines core)
will build on. No production caller in this PR; Phase B's first
caller closes that gap.

## Half-wired window
**OPEN** through Phase B. PR title: `feat(conversations): Phase A foundations
for routines`. Closure criterion: Phase B's PR has the @ax/routines plugin
calling each of the three hooks at least once via the canary.

## Test plan
- [x] `pnpm test --filter @ax/conversations` — all green.
- [x] `pnpm build` — no type ripples broke the monorepo.
- [x] Canary integration test asserts the three hooks are registered after boot.
- [ ] Manual: rerun the existing MANUAL-ACCEPTANCE — confirm chat UI still works (hidden=false default means no visible change).
EOF
```

- [ ] **Step 3: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(conversations): Phase A foundations for routines" \
             --body-file /tmp/pr-body-phase-a.md
```

- [ ] **Step 4: Watch CI; iterate if it fails**

If CI fails on type-checks elsewhere in the monorepo, add the necessary `hidden: false` / `externalKey: null` defaults to any object literal that constructs a `Conversation`. Do not loosen the type to `Conversation | LegacyConversation` — that's the wrong direction.

---

## Notes on spec deviations

If `conversations:drop-turn` ships as a Task 4b stub (jsonl write primitive not yet present), record this in the project memory after merge:

> Phase A shipped 2026-05-14 with `conversations:drop-turn` registered but throwing `not-implemented`. The runner-native transcript-rewrite path lands in Phase B alongside its first caller (routines plugin silence-token logic). Half-wired window for that one hook stays open until Phase B's first canary fire.

Add this as a `project_*.md` memory if you take that path.
