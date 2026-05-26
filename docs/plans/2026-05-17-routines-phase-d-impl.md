# Routines — Phase D Implementation Plan (UI + Heartbeat Bootstrap)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship operator-visible observability over the routines system + a heartbeat that auto-seeds on agent creation. Add a Routines modal in `channel-web` (sibling to Credentials), an additive `rendered_prompt` column on `routines_v1_fires`, a new `routines:recent-fires` service hook, a new `@ax/routines-admin-routes` package exposing three `/settings/routines/*` routes, hide routine-fired conversations from the chat sidebar, and seed `.ax/routines/heartbeat.md` via a new `agents:created` event.

**Architecture:** No new schema other than one additive column. One new package (`@ax/routines-admin-routes`) mirroring the shape of `@ax/credentials-admin-routes`. Cross-plugin coordination through two new hooks: `agents:created` (fire/subscribe — agents fires, routines subscribes to seed the heartbeat) and `routines:recent-fires` (call/register — admin routes call it for the modal's expand panel). `conversations:create` and `conversations:find-or-create` gain an optional `hidden?: boolean` field so routines can mark per-fire conversations hidden at creation time. No half-wired window — producer (column + hook + routes), consumer (UI), and canary all ship in this PR.

**Tech Stack:** TypeScript + Kysely + Postgres. React + shadcn/ui in `channel-web`. No new shadcn primitives — Collapsible / Toast / Table are hand-rolled in the same style as `UserMenu` and `CredentialsList`. No new runtime deps.

**Spec:** `docs/plans/2026-05-17-routines-phase-d-design.md`. Builds on Phases A–C (`docs/plans/2026-05-14-routines-design.md` §7.3) + the just-closed cluster walk (PRs #88, #89, #91).

---

## Invariants (L1–L9)

- **L1 (no half-wired window).** Schema + hook + routes + UI + canary all in one PR. PR notes name the "Phase D window CLOSED" line.
- **L2 (no cross-plugin imports).** `@ax/routines-admin-routes` reaches routines / agents only through the bus. `@ax/routines` reaches workspace / conversations / agents only through the bus.
- **L3 (capabilities explicit and minimized).** `@ax/routines-admin-routes.calls`: `http:register-route`, `routines:list`, `routines:recent-fires`, `routines:fire-now`, `agents:resolve`. `@ax/routines.calls` adds: `workspace:apply` (for heartbeat seed). `@ax/agents` fires `agents:created` (subscriber hook — not in `registers`).
- **L4 (storage-agnostic hook payloads).** `agents:created` carries `{ agentId, ownerId, ownerType }` only. `routines:recent-fires` returns the existing `FireRow` shape extended with one new field (`renderedPrompt`).
- **L5 (untrusted content trust boundary).** `renderedPrompt` is rendered model-template output; the column stores the post-substitution string. Capped at 64 KiB before write — matches the existing `silenceMaxChars` discipline. Browser renders via React default-escape; no innerHTML sinks.
- **L6 (subscriber must not throw).** The heartbeat seed subscriber catches and logs all errors. A seed failure must not block `agents:create` from returning success.
- **L7 (additive schema only).** One `ALTER TABLE … ADD COLUMN rendered_prompt TEXT` migration. No backfill. NULL on historical rows is the canonical "we didn't capture this" sentinel.
- **L8 (ACL on every admin route).** Every `/settings/routines/*` route runs `requireUser` then validates `agentId` ownership via `agents:resolve({ agentId, userId })` before invoking the underlying service hook.
- **L9 (zero new shadcn primitives).** Hand-roll Collapsible / Toast equivalents using `useState` + the existing `animate-in fade-in-0 slide-in-from-top-1` Tailwind classes already in `UserMenu`. Honors CLAUDE.md invariant #6 without adding install footprint.

---

## File Structure

**Create:**
- `packages/routines/src/heartbeat-template.ts` — exported template string.
- `packages/routines/src/seed-heartbeat.ts` — `agents:created` subscriber that writes the template via `workspace:apply`.
- `packages/routines/src/__tests__/seed-heartbeat.test.ts`
- `packages/routines-admin-routes/package.json`
- `packages/routines-admin-routes/tsconfig.json`
- `packages/routines-admin-routes/src/index.ts`
- `packages/routines-admin-routes/src/plugin.ts`
- `packages/routines-admin-routes/src/routes.ts`
- `packages/routines-admin-routes/src/shared.ts` — copy of the route-shared helpers (`requireUser`, `parseRequestBody`, `writeServiceError`) — see Task 9 step 2.
- `packages/routines-admin-routes/src/__tests__/routes.test.ts`
- `packages/channel-web/src/components/routines/RoutinesPanel.tsx` — **already drafted** as design artifact; this plan only adds tests and integration.
- `packages/channel-web/src/components/routines/RoutinesList.tsx` — drafted.
- `packages/channel-web/src/components/routines/TriggerChip.tsx` — drafted.
- `packages/channel-web/src/components/routines/StatusChip.tsx` — drafted.
- `packages/channel-web/src/components/routines/FireRowsTable.tsx` — drafted.
- `packages/channel-web/src/components/routines/FireNowControl.tsx` — drafted.
- `packages/channel-web/src/lib/routines.ts` — drafted.
- `packages/channel-web/src/__tests__/routines-list.test.tsx`
- `packages/channel-web/src/__tests__/fire-now-control.test.tsx`
- `packages/channel-web/src/__tests__/routines-client.test.ts`

**Modify:**
- `packages/routines/src/migrations.ts` — add migration step for `rendered_prompt`.
- `packages/routines/src/store.ts` — extend `recordFire` with optional `renderedPrompt`; add `recentFires` method.
- `packages/routines/src/types.ts` — extend `FireRow` with `renderedPrompt`; extend `FireNowInput` with optional `payload`; add `RecentFiresInput` / `RecentFiresOutput`.
- `packages/routines/src/fire.ts` — stash rendered prompt on `PendingFire`; pass through to chat:turn-end.
- `packages/routines/src/plugin.ts` — register `routines:recent-fires`; extend `routines:fire-now` to accept payload; thread renderedPrompt through both writers; pass `hidden: true` on conversations create/find-or-create; subscribe `seed-heartbeat` to `agents:created`; add `workspace:apply` to manifest `calls`.
- `packages/routines/src/__tests__/canary.test.ts` — new cases for renderedPrompt, hidden conversations.
- `packages/routines/src/__tests__/store.test.ts` — new tests for `recentFires` ordering and `renderedPrompt` round-trip.
- `packages/routines/src/__tests__/migrations.test.ts` — assert the new column exists.
- `packages/agents/src/plugin.ts` — fire `agents:created` after `store.create` commits.
- `packages/agents/src/__tests__/plugin.test.ts` — assert the event fires with the right payload.
- `packages/conversations/src/types.ts` — extend `CreateInput` and `FindOrCreateInput` shapes with optional `hidden`.
- `packages/conversations/src/plugin.ts` — accept `hidden` and pass through to the store; default false.
- `packages/conversations/src/store.ts` — pass `hidden` through INSERT.
- `packages/conversations/src/__tests__/plugin.test.ts` — new cases for hidden creation.
- `packages/channel-web/src/components/UserMenu.tsx` — new Routines menuitem.
- `packages/channel-web/src/__tests__/user-menu.test.tsx` — extend to cover Routines item.
- `packages/channel-web/src/components/Sidebar.tsx` — plumb `onOpenRoutines` through to UserMenu.
- `packages/channel-web/src/App.tsx` (or wherever `SettingsPanel` is rendered) — mount `RoutinesPanel` with open/close state.
- `presets/cli/src/main.ts` — load `@ax/routines-admin-routes`.
- `presets/k8s/src/index.ts` — load `@ax/routines-admin-routes`.
- `deploy/MANUAL-ACCEPTANCE.md` — new scenario at the bottom.

**Do not touch:** `packages/sandbox-k8s`, `packages/workspace-git*`, `packages/agent-claude-sdk-runner`, `packages/http-server`. Routines fire pipeline and webhook routes already proven on cluster — no runtime changes needed.

---

## Task 1: Schema migration — `rendered_prompt` column

**Files:**
- Modify: `packages/routines/src/migrations.ts`
- Test: `packages/routines/src/__tests__/migrations.test.ts`

- [ ] **Step 1: Read existing migrations to find the latest step number.**

```bash
grep -n "step\|version" packages/routines/src/migrations.ts | head
```

- [ ] **Step 2: Write the failing test.**

In `packages/routines/src/__tests__/migrations.test.ts`, add at the bottom of the `describe('runRoutinesMigration', …)` block:

```ts
it('rendered_prompt column exists on routines_v1_fires after migration', async () => {
  const db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: container.getConnectionUri() }),
    }),
  });
  try {
    await runRoutinesMigration(db);
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'routines_v1_fires'
    `.execute(db);
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain('rendered_prompt');
  } finally {
    await db.destroy();
  }
});
```

- [ ] **Step 3: Run test to verify it fails.**

```bash
pnpm --filter @ax/routines test -- -t "rendered_prompt column exists"
```

Expected: FAIL (`Expected [...] to contain 'rendered_prompt'`).

- [ ] **Step 4: Add the migration step.**

In `packages/routines/src/migrations.ts`, add a new step to the array (use the next sequential step number — read the file to find the current max). Example shape (adjust the `step` number to whatever's next):

```ts
{
  step: 3, // BUMP this to next sequential number
  description: 'add rendered_prompt column to routines_v1_fires',
  up: async (db) => {
    await sql`
      ALTER TABLE routines_v1_fires
        ADD COLUMN rendered_prompt TEXT
    `.execute(db);
  },
},
```

Also extend the `RoutinesDatabase` Kysely interface for the `routines_v1_fires` table to include `rendered_prompt: string | null`.

- [ ] **Step 5: Run test to verify it passes.**

```bash
pnpm --filter @ax/routines test -- -t "rendered_prompt column exists"
```

Expected: PASS.

- [ ] **Step 6: Run full routines test suite.**

```bash
pnpm --filter @ax/routines test
```

Expected: all 120 tests pass.

- [ ] **Step 7: Commit.**

```bash
git add packages/routines/src/migrations.ts packages/routines/src/__tests__/migrations.test.ts
git commit -m "feat(routines): add rendered_prompt column to routines_v1_fires (Phase D L7)"
```

---

## Task 2: `recordFire` accepts renderedPrompt; threading from fire.ts

**Files:**
- Modify: `packages/routines/src/store.ts`
- Modify: `packages/routines/src/types.ts`
- Modify: `packages/routines/src/fire.ts`
- Modify: `packages/routines/src/plugin.ts`
- Test: `packages/routines/src/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing test for `recordFire` with renderedPrompt.**

In `packages/routines/src/__tests__/store.test.ts`, add:

```ts
it('recordFire round-trips renderedPrompt', async () => {
  await runRoutinesMigration(db);
  const store = createRoutinesStore(db);
  await store.upsert({
    agentId: 'agt_a', path: '.ax/routines/r.md',
    authorUserId: 'u1', name: 'r', description: 'd',
    specHash: 'h1',
    trigger: { kind: 'interval', every: '60s' },
    activeHours: null, silenceToken: null, silenceMax: 300,
    conversation: 'per-fire', promptBody: 'hi {{payload.x}}',
    nextRunAt: null,
  });
  const id = await store.recordFire({
    agentId: 'agt_a', path: '.ax/routines/r.md',
    triggerSource: 'manual',
    conversationId: 'cnv_1',
    status: 'ok', error: null,
    renderedPrompt: 'hi world',
  });
  expect(id).toBeGreaterThan(0);
  const row = await db
    .selectFrom('routines_v1_fires')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  expect(row.rendered_prompt).toBe('hi world');
});
```

- [ ] **Step 2: Run test to verify it fails.**

```bash
pnpm --filter @ax/routines test -- -t "round-trips renderedPrompt"
```

Expected: FAIL — `recordFire` signature doesn't accept the field.

- [ ] **Step 3: Extend `recordFire` signature in `store.ts`.**

Replace the existing `recordFire` to accept the new optional field. Find the current signature (search `recordFire`) and add a `renderedPrompt?: string | null` parameter. The INSERT call gets a new column. **Cap at 64 KiB** per L5 — truncate with an ellipsis if longer:

```ts
async function recordFire(input: {
  agentId: string; path: string;
  triggerSource: FireSource;
  conversationId: string | null;
  status: FireStatus;
  error: string | null;
  renderedPrompt?: string | null;
}): Promise<number> {
  const MAX = 64 * 1024;
  const raw = input.renderedPrompt ?? null;
  const renderedPrompt =
    raw !== null && raw.length > MAX ? `${raw.slice(0, MAX - 1)}…` : raw;
  const row = await db
    .insertInto('routines_v1_fires')
    .values({
      agent_id: input.agentId,
      path: input.path,
      trigger_source: input.triggerSource,
      conversation_id: input.conversationId,
      status: input.status,
      error: input.error,
      rendered_prompt: renderedPrompt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}
```

- [ ] **Step 4: Extend `FireRow` in `types.ts`.**

Add `renderedPrompt: string | null;` to the `FireRow` interface (right after `error`).

- [ ] **Step 5: Run store test.**

```bash
pnpm --filter @ax/routines test -- -t "round-trips renderedPrompt"
```

Expected: PASS.

- [ ] **Step 6: Stash renderedPrompt on `PendingFire`.**

In `packages/routines/src/fire.ts`, extend the `PendingFire` shape:

```ts
export interface PendingFire {
  row: RoutineRow;
  conversationId: string;
  source: FireSource;
  renderedPrompt: string;
  onTurnEnd: (turn: { contentBlocks?: unknown[] }) => Promise<void>;
}
```

Compute the rendered prompt once (the existing code path), and pass it to `pending.set`. The relevant existing block:

```ts
const prompt =
  source === 'webhook' && payload !== undefined
    ? renderTemplate(row.promptBody, { payload })
    : row.promptBody;

deps.pending.set(reqId, {
  row, conversationId, source,
  renderedPrompt: prompt,
  onTurnEnd: async () => {},
});
```

- [ ] **Step 7: Thread renderedPrompt through `chat:turn-end` subscriber.**

In `packages/routines/src/plugin.ts`, find the `chat:turn-end` subscriber's two `localStore.recordFire(...)` call sites (silenced + ok branches). Pass `renderedPrompt: pf.renderedPrompt` to both:

```ts
await localStore.recordFire({
  agentId: pf.row.agentId, path: pf.row.path,
  triggerSource: pf.source,
  conversationId: pf.conversationId,
  status: 'silenced', error: null,
  renderedPrompt: pf.renderedPrompt,
});
// ... and the 'ok' branch similarly:
await localStore.recordFire({
  agentId: pf.row.agentId, path: pf.row.path,
  triggerSource: pf.source,
  conversationId: pf.conversationId,
  status: 'ok', error: null,
  renderedPrompt: pf.renderedPrompt,
});
```

- [ ] **Step 8: Extend `FireNowInput` and thread renderedPrompt through `routines:fire-now` write.**

In `packages/routines/src/types.ts`, add the optional `payload` field now (so the type matches the usage below — Task 4 only adds the canary test that exercises it):

```ts
export interface FireNowInput {
  agentId: string;
  path: string;
  source?: FireSource;
  payload?: unknown;
}
```

Then in `plugin.ts`, find the `routines:fire-now` service-hook registration (the `localStore.recordFire(...)` call around line 202 of the current file). Render the prompt with the input payload and pass it:

```ts
const renderedPrompt =
  input.payload !== undefined
    ? renderTemplate(row.promptBody, { payload: input.payload })
    : row.promptBody;
const result = await fireRoutine(row, source === 'tick' ? 'tick' : 'manual', input.payload);
const fireId = await localStore.recordFire({
  agentId: row.agentId, path: row.path,
  triggerSource: source,
  conversationId: result.conversationId ?? null,
  status: result.status,
  error: result.error,
  renderedPrompt,
});
```

You'll also need to import `renderTemplate` at the top of `plugin.ts` if not already imported.

- [ ] **Step 9: Run routines tests.**

```bash
pnpm --filter @ax/routines test
```

Expected: existing canary tests still pass (they don't assert renderedPrompt yet — Task 4 adds those). Store test passes.

- [ ] **Step 10: Commit.**

```bash
git add packages/routines/src/store.ts packages/routines/src/types.ts \
        packages/routines/src/fire.ts packages/routines/src/plugin.ts \
        packages/routines/src/__tests__/store.test.ts
git commit -m "feat(routines): thread renderedPrompt through fire writers (Phase D)"
```

---

## Task 3: `routines:recent-fires` service hook + store method

**Files:**
- Modify: `packages/routines/src/store.ts`
- Modify: `packages/routines/src/types.ts`
- Modify: `packages/routines/src/plugin.ts`
- Test: `packages/routines/src/__tests__/store.test.ts`

- [ ] **Step 1: Add types in `types.ts`.**

```ts
export interface RecentFiresInput {
  agentId: string;
  path: string;
  limit?: number;
}
export interface RecentFiresOutput {
  fires: FireRow[];
}
```

- [ ] **Step 2: Write failing store test.**

In `packages/routines/src/__tests__/store.test.ts`:

```ts
it('recentFires returns fires for one routine in fired_at DESC order, honors limit', async () => {
  await runRoutinesMigration(db);
  const store = createRoutinesStore(db);
  await store.upsert({
    agentId: 'agt_a', path: '.ax/routines/r.md',
    authorUserId: 'u1', name: 'r', description: 'd', specHash: 'h1',
    trigger: { kind: 'interval', every: '60s' },
    activeHours: null, silenceToken: null, silenceMax: 300,
    conversation: 'per-fire', promptBody: 'hi', nextRunAt: null,
  });
  for (let i = 0; i < 5; i += 1) {
    await store.recordFire({
      agentId: 'agt_a', path: '.ax/routines/r.md',
      triggerSource: 'manual', conversationId: `cnv_${i}`,
      status: 'ok', error: null, renderedPrompt: `prompt ${i}`,
    });
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct fired_at
  }
  const out = await store.recentFires({ agentId: 'agt_a', path: '.ax/routines/r.md', limit: 3 });
  expect(out).toHaveLength(3);
  expect(out[0]!.renderedPrompt).toBe('prompt 4');
  expect(out[2]!.renderedPrompt).toBe('prompt 2');
});
```

- [ ] **Step 3: Run test to verify it fails.**

```bash
pnpm --filter @ax/routines test -- -t "recentFires returns fires"
```

Expected: FAIL — `store.recentFires` doesn't exist.

- [ ] **Step 4: Implement `recentFires` in `store.ts`.**

Add at the end of the store factory's returned object:

```ts
async function recentFires(input: {
  agentId: string; path: string; limit?: number;
}): Promise<FireRow[]> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 20));
  const rows = await db
    .selectFrom('routines_v1_fires')
    .selectAll()
    .where('agent_id', '=', input.agentId)
    .where('path', '=', input.path)
    .orderBy('fired_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    path: r.path,
    firedAt: r.fired_at,
    triggerSource: r.trigger_source as FireSource,
    conversationId: r.conversation_id,
    status: r.status as FireStatus,
    error: r.error,
    renderedPrompt: r.rendered_prompt,
  }));
}
```

And add `recentFires` to the returned object.

Update `RoutinesStore` interface in the same file to include the new method.

- [ ] **Step 5: Run store test.**

```bash
pnpm --filter @ax/routines test -- -t "recentFires returns fires"
```

Expected: PASS.

- [ ] **Step 6: Register `routines:recent-fires` service hook in `plugin.ts`.**

Add to the manifest:

```ts
registers: ['routines:fire-now', 'routines:list', 'routines:recent-fires'],
```

In `init`, alongside the other `bus.registerService` calls:

```ts
bus.registerService<RecentFiresInput, RecentFiresOutput>(
  'routines:recent-fires', PLUGIN_NAME,
  async (_ctx, input) => {
    const fires = await localStore.recentFires(input);
    return { fires };
  },
);
```

Import the new types at the top.

- [ ] **Step 7: Run full routines tests.**

```bash
pnpm --filter @ax/routines test
```

Expected: all green.

- [ ] **Step 8: Commit.**

```bash
git add packages/routines/src/store.ts packages/routines/src/types.ts \
        packages/routines/src/plugin.ts packages/routines/src/__tests__/store.test.ts
git commit -m "feat(routines): add routines:recent-fires service hook (Phase D)"
```

---

## Task 4: Canary asserts `routines:fire-now` payload reaches `rendered_prompt`

**Files:**
- Test: `packages/routines/src/__tests__/canary.test.ts`

(Type extension + plumbing already done in Task 2 step 8. This task is purely the canary case that pins the behavior end-to-end.)

- [ ] **Step 1: Write the failing canary test.**

In `packages/routines/src/__tests__/canary.test.ts`, add inside the Phase C webhook canary describe (or create a new describe for Phase D):

```ts
it('case 10: routines:fire-now with payload renders template into routines_v1_fires.rendered_prompt (#Phase D)', async () => {
  const { h } = await makeWebHarness();
  await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
    before: null, after: asWorkspaceVersion('v1'),
    author: { agentId: 'agt_a', userId: 'u1' },
    changes: [{ path: '.ax/routines/r.md', kind: 'added',
      contentAfter: async () => webhookBody() }],
  });
  await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
    agentId: 'agt_a', path: '.ax/routines/r.md',
    payload: { pr: { title: 'hello' } },
  });
  const k = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
  try {
    await vi.waitFor(async () => {
      const fires = await k.selectFrom('routines_v1_fires').selectAll().execute();
      expect(fires.length).toBeGreaterThanOrEqual(1);
      const last = fires[fires.length - 1]!;
      expect(last.rendered_prompt).toBe('PR: hello');
    }, { timeout: 5_000, interval: 25 });
  } finally {
    await k.destroy();
  }
});
```

- [ ] **Step 2: Run the test.**

```bash
pnpm --filter @ax/routines test -- -t "case 10"
```

Expected outcomes:

- If Task 2 step 8's plumbing is correct, the test passes. The `payload` flows through `FireNowInput` → `renderTemplate` → `recordFire(renderedPrompt: 'PR: hello')`.
- If the registered Zod schema (if any) for `routines:fire-now` strips the new `payload` field, the test fails — find the schema (`grep -n "routines:fire-now" packages/routines/src/plugin.ts`) and extend it with `payload: z.unknown().optional()`.

- [ ] **Step 3: Run full routines tests.**

```bash
pnpm --filter @ax/routines test
```

Expected: all green.

- [ ] **Step 4: Commit.**

```bash
git add packages/routines/src/__tests__/canary.test.ts
git commit -m "test(routines): canary asserts payload renders into routines_v1_fires.rendered_prompt (Phase D)"
```

---

## Task 5: `conversations:create` + `find-or-create` accept optional `hidden`

**Files:**
- Modify: `packages/conversations/src/types.ts`
- Modify: `packages/conversations/src/plugin.ts`
- Modify: `packages/conversations/src/store.ts`
- Test: `packages/conversations/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Find the existing create types and store insert.**

```bash
grep -n "CreateInput\|FindOrCreateInput\|insertInto.*conversations" packages/conversations/src/*.ts
```

- [ ] **Step 2: Extend `CreateInput` and `FindOrCreateInput`.**

In `packages/conversations/src/types.ts`, add `hidden?: boolean` to both interfaces. For find-or-create, `hidden` lives under `fallback`:

```ts
export interface FindOrCreateInput {
  userId: string;
  agentId: string;
  externalKey: string;
  fallback: { title: string; hidden?: boolean };
}
```

- [ ] **Step 3: Write failing plugin test.**

In `packages/conversations/src/__tests__/plugin.test.ts`, add:

```ts
it('conversations:create respects optional hidden flag', async () => {
  const h = await makeIntegrationHarness();
  const out = await h.bus.call('conversations:create', h.ctx({ userId: 'u1' }), {
    userId: 'u1', agentId: 'agt_a',
    title: 'a hidden one', hidden: true,
  });
  const row = await db
    .selectFrom('conversations_v1_conversations')
    .selectAll()
    .where('conversation_id', '=', (out as { conversationId: string }).conversationId)
    .executeTakeFirstOrThrow();
  expect(row.hidden).toBe(true);
});

it('conversations:find-or-create respects optional hidden flag on create branch', async () => {
  const h = await makeIntegrationHarness();
  const out = await h.bus.call('conversations:find-or-create', h.ctx({ userId: 'u1' }), {
    userId: 'u1', agentId: 'agt_a',
    externalKey: 'routine:x',
    fallback: { title: 'shared', hidden: true },
  });
  const row = await db
    .selectFrom('conversations_v1_conversations')
    .selectAll()
    .where('conversation_id', '=', (out as { conversation: { conversationId: string }; created: boolean })
      .conversation.conversationId)
    .executeTakeFirstOrThrow();
  expect(row.hidden).toBe(true);
});
```

- [ ] **Step 4: Run tests to verify they fail.**

```bash
pnpm --filter @ax/conversations test -- -t "respects optional hidden"
```

Expected: FAIL — `hidden` is being ignored.

- [ ] **Step 5: Plumb `hidden` through `plugin.ts` and `store.ts`.**

In `plugin.ts`, find the `conversations:create` registered handler and pass `hidden: input.hidden ?? false` to whatever store method it calls. Same for `conversations:find-or-create`'s create branch.

In `store.ts`, the INSERT for new conversations gets a `hidden` value column. If the column isn't already in the inserted columns list, add it:

```ts
await db.insertInto('conversations_v1_conversations').values({
  ...,
  hidden: input.hidden ?? false,
}).execute();
```

- [ ] **Step 6: Run tests to verify they pass.**

```bash
pnpm --filter @ax/conversations test -- -t "respects optional hidden"
```

Expected: PASS.

- [ ] **Step 7: Run full conversations tests.**

```bash
pnpm --filter @ax/conversations test
```

Expected: all green.

- [ ] **Step 8: Commit.**

```bash
git add packages/conversations/src/types.ts packages/conversations/src/plugin.ts \
        packages/conversations/src/store.ts \
        packages/conversations/src/__tests__/plugin.test.ts
git commit -m "feat(conversations): conversations:create + find-or-create accept hidden flag (Phase D)"
```

---

## Task 6: Routines passes `hidden: true` on conversation create

**Files:**
- Modify: `packages/routines/src/fire.ts`
- Test: `packages/routines/src/__tests__/canary.test.ts`

- [ ] **Step 1: Write the failing canary test.**

Add a case to the existing canary that captures `conversations:create` input and asserts `hidden: true`:

```ts
it('case 11: routine fires mark per-fire conversations hidden (#Phase D)', async () => {
  let createInput: { hidden?: boolean } | undefined;
  const h = await createTestHarness({
    services: {
      'agents:resolve': async () => ({ agent: { id: 'agt_a', ownerId: 'u1', workspaceRef: null } }),
      'agents:ensure-webhook-token': async () => ({ token: 'tok' }),
      'agents:resolve-by-webhook-token': async () => ({ agent: null }),
      'credentials:get': async () => 'shhh',
      'http:register-route': async () => ({ unregister: () => {} }),
      'conversations:create': async (_c, input: unknown) => {
        createInput = input as { hidden?: boolean };
        return { conversationId: 'cnv_x' };
      },
      'conversations:find-or-create': async () => ({ conversation: { conversationId: 'shared' }, created: false }),
      'conversations:drop-turn': async () => undefined,
      'conversations:hide': async () => undefined,
      'agent:invoke': async (ctx) => {
        await h.bus.fire('chat:turn-end', ctx, {
          reqId: ctx.reqId, turnId: 't', contentBlocks: [{ type: 'text', text: 'ack' }],
        });
        return { kind: 'complete', messages: [] };
      },
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createRoutinesPlugin({ tickIntervalMs: 60_000 }),
    ],
  });
  harnesses.push(h);
  // Index a per-fire interval routine, fire it.
  await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
    before: null, after: asWorkspaceVersion('v1'),
    author: { agentId: 'agt_a', userId: 'u1' },
    changes: [{ path: '.ax/routines/r.md', kind: 'added', contentAfter: async () => routineBody() }],
  });
  await h.bus.call('routines:fire-now', h.ctx({ userId: 'u1' }), {
    agentId: 'agt_a', path: '.ax/routines/r.md',
  });
  expect(createInput?.hidden).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails.**

```bash
pnpm --filter @ax/routines test -- -t "case 11"
```

Expected: FAIL — `createInput.hidden` is `undefined`.

- [ ] **Step 3: Modify `fire.ts` to pass `hidden: true`.**

Find the `conversations:create` and `conversations:find-or-create` calls in `fire.ts`. Add `hidden: true`:

```ts
const out = await deps.bus.call('conversations:find-or-create', baseCtx, {
  userId: row.authorUserId,
  agentId: row.agentId,
  externalKey: row.path,
  fallback: { title: row.name, hidden: true },
});
// ...
const conv = await deps.bus.call('conversations:create', baseCtx, {
  userId: row.authorUserId,
  agentId: row.agentId,
  title: `${row.name} @ ${new Date().toISOString()}`,
  hidden: true,
});
```

- [ ] **Step 4: Run test to verify it passes.**

```bash
pnpm --filter @ax/routines test -- -t "case 11"
```

Expected: PASS.

- [ ] **Step 5: Run full routines tests.**

```bash
pnpm --filter @ax/routines test
```

Expected: all green.

- [ ] **Step 6: Commit.**

```bash
git add packages/routines/src/fire.ts packages/routines/src/__tests__/canary.test.ts
git commit -m "feat(routines): mark per-fire conversations hidden at creation (Phase D)"
```

---

## Task 7: `agents:created` event in `@ax/agents`

**Files:**
- Modify: `packages/agents/src/plugin.ts`
- Test: `packages/agents/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test.**

In `packages/agents/src/__tests__/plugin.test.ts`, add:

```ts
it('fires agents:created after agents:create commits', async () => {
  const h = await makeIntegrationHarness();
  const events: Array<{ agentId: string; ownerId: string; ownerType: string }> = [];
  h.bus.subscribe('agents:created', 'test-spy', async (_ctx, payload) => {
    events.push(payload as { agentId: string; ownerId: string; ownerType: string });
    return undefined;
  });
  const out = await h.bus.call('agents:create', h.ctx({ userId: 'u1' }), {
    actor: { userId: 'u1', isAdmin: false },
    input: {
      displayName: 'A', systemPrompt: 'p', allowedTools: [],
      mcpConfigIds: [], model: 'claude-opus-4-7', visibility: 'personal',
    },
  });
  const agentId = (out as { agent: { id: string } }).agent.id;
  expect(events).toEqual([{ agentId, ownerId: 'u1', ownerType: 'user' }]);
});
```

(Adjust `agents:create` invocation if the existing handler uses a different shape — read it first.)

- [ ] **Step 2: Run test to verify it fails.**

```bash
pnpm --filter @ax/agents test -- -t "fires agents:created"
```

Expected: FAIL — event is never fired.

- [ ] **Step 3: Add `bus.fire('agents:created', …)` after the store insert.**

In `packages/agents/src/plugin.ts`, find the `agents:create` registered handler. After the successful `store.create` call (and any post-commit work), add:

```ts
const fireResult = await bus.fire('agents:created', ctx, {
  agentId: created.id,
  ownerId: created.ownerId,
  ownerType: created.ownerType,
});
if (fireResult.rejected) {
  ctx.logger.warn('agents_created_rejected', { agentId: created.id, reason: fireResult.reason });
}
```

(Don't block the response on subscriber failures — `bus.fire` already isolates throws; the rejected case is logged but the create still succeeds.)

Also update the manifest's `subscribes` if it needs to declare `agents:created` as fired-by-this-plugin. Per ax-conventions, subscriber hooks aren't declared in the manifest, but if there's a `fires` array convention in this repo's manifests, add it there. Grep for `'fires:'` in other plugin manifests:

```bash
grep -rn "fires:" packages/*/src/plugin.ts | head
```

If none exist, no manifest change needed.

- [ ] **Step 4: Run test to verify it passes.**

```bash
pnpm --filter @ax/agents test -- -t "fires agents:created"
```

Expected: PASS.

- [ ] **Step 5: Run full agents tests.**

```bash
pnpm --filter @ax/agents test
```

Expected: all green.

- [ ] **Step 6: Commit.**

```bash
git add packages/agents/src/plugin.ts packages/agents/src/__tests__/plugin.test.ts
git commit -m "feat(agents): fire agents:created event after create commits (Phase D)"
```

---

## Task 8: Heartbeat seed — template + subscriber

**Files:**
- Create: `packages/routines/src/heartbeat-template.ts`
- Create: `packages/routines/src/seed-heartbeat.ts`
- Create: `packages/routines/src/__tests__/seed-heartbeat.test.ts`
- Modify: `packages/routines/src/plugin.ts`

- [ ] **Step 1: Create the heartbeat template.**

`packages/routines/src/heartbeat-template.ts`:

```ts
/**
 * Default heartbeat routine seeded into every new agent's workspace at
 * .ax/routines/heartbeat.md. Daily interval + silence-token so quiet
 * days don't clutter the routines fire log.
 */
export const HEARTBEAT_TEMPLATE: string =
  [
    '---',
    'name: heartbeat',
    'description: daily check-in; says HEARTBEAT_OK and goes quiet when nothing\'s outstanding',
    'trigger:',
    '  kind: interval',
    '  every: "24h"',
    'conversation: shared',
    'silenceToken: HEARTBEAT_OK',
    '---',
    'If nothing\'s outstanding for you to report on, just say `HEARTBEAT_OK` and nothing else. Otherwise, give a one-paragraph summary.',
    '',
  ].join('\n');

export const HEARTBEAT_PATH = '.ax/routines/heartbeat.md';
```

- [ ] **Step 2: Write failing subscriber test.**

`packages/routines/src/__tests__/seed-heartbeat.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createSeedHeartbeatSubscriber } from '../seed-heartbeat.js';
import { HEARTBEAT_TEMPLATE, HEARTBEAT_PATH } from '../heartbeat-template.js';
import { makeAgentContext } from '@ax/core';

describe('seed-heartbeat subscriber', () => {
  it('calls workspace:apply with the heartbeat template on agents:created', async () => {
    const applies: Array<{ changes: unknown[] }> = [];
    const bus = {
      call: vi.fn(async (hook: string, _ctx: unknown, payload: unknown) => {
        if (hook === 'workspace:apply') {
          applies.push(payload as { changes: unknown[] });
          return { version: 'v1' };
        }
        throw new Error(`unexpected: ${hook}`);
      }),
    };
    const ctx = makeAgentContext({ sessionId: 'test', agentId: 'agt_a', userId: 'u1' });
    const sub = createSeedHeartbeatSubscriber({ bus: bus as never });
    await sub(ctx, { agentId: 'agt_a', ownerId: 'u1', ownerType: 'user' });
    expect(applies).toHaveLength(1);
    const change = (applies[0]!.changes as Array<{ path: string; kind: string; contentAfter: () => Promise<Uint8Array> }>)[0]!;
    expect(change.path).toBe(HEARTBEAT_PATH);
    expect(change.kind).toBe('added');
    const bytes = await change.contentAfter();
    expect(new TextDecoder().decode(bytes)).toBe(HEARTBEAT_TEMPLATE);
  });

  it('swallows workspace:apply failures (K10 / L6)', async () => {
    const bus = {
      call: vi.fn(async () => { throw new Error('workspace gone'); }),
    };
    const ctx = makeAgentContext({ sessionId: 'test', agentId: 'agt_a', userId: 'u1' });
    const sub = createSeedHeartbeatSubscriber({ bus: bus as never });
    // Must NOT throw.
    await expect(sub(ctx, { agentId: 'agt_a', ownerId: 'u1', ownerType: 'user' })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails (file doesn't exist).**

```bash
pnpm --filter @ax/routines test -- -t "seed-heartbeat"
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the subscriber.**

`packages/routines/src/seed-heartbeat.ts`:

```ts
import type { AgentContext, HookBus } from '@ax/core';
import { HEARTBEAT_TEMPLATE, HEARTBEAT_PATH } from './heartbeat-template.js';

const ENC = new TextEncoder();

export interface SeedHeartbeatDeps {
  bus: HookBus;
}

export interface AgentsCreatedPayload {
  agentId: string;
  ownerId: string;
  ownerType: string;
}

/**
 * Subscriber for `agents:created`. Writes the bundled heartbeat template
 * into the new agent's workspace via `workspace:apply`. K10 / L6: any
 * failure is caught + logged; the seed must NOT block agent creation.
 */
export function createSeedHeartbeatSubscriber(deps: SeedHeartbeatDeps) {
  return async (
    ctx: AgentContext,
    payload: AgentsCreatedPayload,
  ): Promise<undefined> => {
    try {
      await deps.bus.call<
        { changes: Array<{ path: string; kind: 'added'; contentAfter: () => Promise<Uint8Array> }>;
          parent: null; reason: string },
        { version: string }
      >('workspace:apply', ctx, {
        changes: [{
          path: HEARTBEAT_PATH,
          kind: 'added',
          contentAfter: async () => ENC.encode(HEARTBEAT_TEMPLATE),
        }],
        parent: null,
        reason: 'seed heartbeat',
      });
    } catch (err) {
      ctx.logger.warn('routines_heartbeat_seed_failed', {
        agentId: payload.agentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  };
}
```

- [ ] **Step 5: Run subscriber test to verify it passes.**

```bash
pnpm --filter @ax/routines test -- -t "seed-heartbeat"
```

Expected: PASS.

- [ ] **Step 6: Wire the subscriber in `plugin.ts`.**

Import at the top:

```ts
import { createSeedHeartbeatSubscriber } from './seed-heartbeat.js';
```

Add to manifest `calls`:

```ts
calls: [
  // existing entries...
  'workspace:apply',
],
```

And to `subscribes`:

```ts
subscribes: ['workspace:applied', 'chat:turn-end', 'agents:webhook-token-rotated', 'agents:created'],
```

In `init`, after the other `bus.subscribe` calls:

```ts
bus.subscribe('agents:created', PLUGIN_NAME, createSeedHeartbeatSubscriber({ bus }));
```

- [ ] **Step 7: Run full routines tests.**

```bash
pnpm --filter @ax/routines test
```

Expected: all green.

- [ ] **Step 8: Commit.**

```bash
git add packages/routines/src/heartbeat-template.ts packages/routines/src/seed-heartbeat.ts \
        packages/routines/src/plugin.ts packages/routines/src/__tests__/seed-heartbeat.test.ts
git commit -m "feat(routines): seed .ax/routines/heartbeat.md on agents:created (Phase D)"
```

---

## Task 9: New `@ax/routines-admin-routes` package

**Files:**
- Create: `packages/routines-admin-routes/package.json`
- Create: `packages/routines-admin-routes/tsconfig.json`
- Create: `packages/routines-admin-routes/src/index.ts`
- Create: `packages/routines-admin-routes/src/plugin.ts`
- Create: `packages/routines-admin-routes/src/routes.ts`
- Create: `packages/routines-admin-routes/src/shared.ts`
- Create: `packages/routines-admin-routes/src/__tests__/routes.test.ts`

- [ ] **Step 1: Scaffold `package.json`.**

```json
{
  "name": "@ax/routines-admin-routes",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@ax/test-harness": "workspace:*",
    "@ax/routines": "workspace:*",
    "@ax/agents": "workspace:*",
    "vitest": "^4.0.0",
    "typescript": "^5.7.0"
  },
  "ax": {
    "registers": [],
    "calls": [
      "http:register-route",
      "routines:list",
      "routines:recent-fires",
      "routines:fire-now",
      "agents:resolve"
    ]
  }
}
```

Run `pnpm install` from the repo root.

- [ ] **Step 2: Copy shared route helpers from `credentials-admin-routes`.**

```bash
cp packages/credentials-admin-routes/src/shared.ts \
   packages/routines-admin-routes/src/shared.ts
```

(Per CLAUDE.md no-cross-plugin-imports rule, copy rather than import. The two packages will share three small helpers; that's acceptable duplication.)

- [ ] **Step 3: Scaffold `tsconfig.json`.**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["**/__tests__/**", "**/*.test.ts", "dist/**"],
  "references": [
    { "path": "../core" }
  ]
}
```

- [ ] **Step 4: `src/index.ts`.**

```ts
export { createRoutinesAdminRoutesPlugin } from './plugin.js';
```

- [ ] **Step 5: Write the failing routes test.**

`packages/routines-admin-routes/src/__tests__/routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createRoutinesAdminRoutesPlugin } from '../plugin.js';
import type { HttpRouteHandler, HttpRequest, HttpResponse } from '@ax/http-server';

interface CapturedRes {
  status?: number;
  body?: unknown;
}

function makeReq(over: Partial<{ method: string; path: string; params: Record<string, string>;
  query: Record<string, string>; body: Buffer }> = {}): HttpRequest {
  return {
    method: over.method ?? 'GET',
    path: over.path ?? '/settings/routines',
    headers: {},
    query: over.query ?? {},
    params: over.params ?? {},
    body: over.body ?? Buffer.from(''),
    cookies: {},
    signedCookie: () => null,
    user: { id: 'u1', role: 'user' },
  } as unknown as HttpRequest;
}

function makeRes(): HttpResponse & { _captured: CapturedRes } {
  const c: CapturedRes = {};
  const r = {
    status(n: number) { c.status = n; return r as never; },
    json(b: unknown) { c.body = b; return r as never; },
    end() { return r as never; },
    header() { return r as never; },
    text() { return r as never; },
    body() { return r as never; },
    redirect() { return r as never; },
    setSignedCookie() {}, clearCookie() {},
    stream() { throw new Error('not used'); },
    _captured: c,
  } as unknown as HttpResponse & { _captured: CapturedRes };
  return r;
}

describe('routines-admin-routes', () => {
  it('GET /settings/routines lists routines for the caller', async () => {
    const handlers = new Map<string, HttpRouteHandler>();
    const h = await createTestHarness({
      services: {
        'http:register-route': async (_c, input: unknown) => {
          const i = input as { path: string; handler: HttpRouteHandler };
          handlers.set(i.path, i.handler);
          return { unregister: () => {} };
        },
        'routines:list': async () => ({ routines: [
          { agentId: 'agt_a', path: '.ax/routines/r.md', authorUserId: 'u1',
            name: 'r', description: 'd', specHash: 'h',
            trigger: { kind: 'interval', every: '24h' },
            activeHours: null, silenceToken: null, silenceMaxChars: 300,
            conversation: 'shared', promptBody: 'hi',
            nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null },
        ]}),
        'routines:recent-fires': async () => ({ fires: [] }),
        'routines:fire-now': async () => ({ fireId: 1, status: 'ok', conversationId: 'cnv_x' }),
        'agents:resolve': async (_c, input: unknown) => {
          const i = input as { agentId: string };
          return { agent: { id: i.agentId, ownerId: 'u1', workspaceRef: null } };
        },
      },
      plugins: [createRoutinesAdminRoutesPlugin()],
    });
    const handler = handlers.get('/settings/routines')!;
    expect(handler).toBeDefined();
    const res = makeRes();
    await handler(makeReq({ method: 'GET', path: '/settings/routines' }), res);
    expect(res._captured.status).toBe(200);
    expect((res._captured.body as { routines: unknown[] }).routines).toHaveLength(1);
    await h.close({ onError: () => {} });
  });

  it('GET /settings/routines/:agentId/fires returns recent fires', async () => {
    const handlers = new Map<string, HttpRouteHandler>();
    const h = await createTestHarness({
      services: {
        'http:register-route': async (_c, input: unknown) => {
          const i = input as { path: string; handler: HttpRouteHandler };
          handlers.set(i.path, i.handler);
          return { unregister: () => {} };
        },
        'routines:list': async () => ({ routines: [] }),
        'routines:recent-fires': async (_c, input: unknown) => {
          const i = input as { agentId: string; path: string; limit?: number };
          return { fires: [{ id: 1, agentId: i.agentId, path: i.path,
            firedAt: new Date('2026-05-17T00:00:00Z'),
            triggerSource: 'manual' as const, conversationId: 'cnv_1',
            status: 'ok' as const, error: null, renderedPrompt: 'hi' }] };
        },
        'routines:fire-now': async () => ({ fireId: 1, status: 'ok', conversationId: 'cnv_x' }),
        'agents:resolve': async (_c, input: unknown) => ({
          agent: { id: (input as { agentId: string }).agentId, ownerId: 'u1', workspaceRef: null },
        }),
      },
      plugins: [createRoutinesAdminRoutesPlugin()],
    });
    const handler = handlers.get('/settings/routines/:agentId/fires')!;
    const res = makeRes();
    await handler(makeReq({
      method: 'GET', path: '/settings/routines/agt_a/fires',
      params: { agentId: 'agt_a' }, query: { path: '.ax/routines/r.md', limit: '20' },
    }), res);
    expect(res._captured.status).toBe(200);
    expect((res._captured.body as { fires: unknown[] }).fires).toHaveLength(1);
    await h.close({ onError: () => {} });
  });

  it('POST /settings/routines/:agentId/fire calls routines:fire-now with payload', async () => {
    let fired: { agentId: string; path: string; payload?: unknown } | undefined;
    const handlers = new Map<string, HttpRouteHandler>();
    const h = await createTestHarness({
      services: {
        'http:register-route': async (_c, input: unknown) => {
          const i = input as { path: string; handler: HttpRouteHandler };
          handlers.set(i.path, i.handler);
          return { unregister: () => {} };
        },
        'routines:list': async () => ({ routines: [] }),
        'routines:recent-fires': async () => ({ fires: [] }),
        'routines:fire-now': async (_c, input: unknown) => {
          fired = input as { agentId: string; path: string; payload?: unknown };
          return { fireId: 7, status: 'ok' as const, conversationId: 'cnv_x' };
        },
        'agents:resolve': async (_c, input: unknown) => ({
          agent: { id: (input as { agentId: string }).agentId, ownerId: 'u1', workspaceRef: null },
        }),
      },
      plugins: [createRoutinesAdminRoutesPlugin()],
    });
    const handler = handlers.get('/settings/routines/:agentId/fire')!;
    const res = makeRes();
    await handler(makeReq({
      method: 'POST', path: '/settings/routines/agt_a/fire',
      params: { agentId: 'agt_a' },
      body: Buffer.from(JSON.stringify({ path: '.ax/routines/r.md', payload: { x: 1 } })),
    }), res);
    expect(res._captured.status).toBe(200);
    expect(fired).toEqual({ agentId: 'agt_a', path: '.ax/routines/r.md', payload: { x: 1 }, source: 'manual' });
    await h.close({ onError: () => {} });
  });
});
```

- [ ] **Step 6: Run tests to verify they fail.**

```bash
pnpm --filter @ax/routines-admin-routes test
```

Expected: FAIL — plugin doesn't exist yet.

- [ ] **Step 7: Implement `plugin.ts` and `routes.ts`.**

`packages/routines-admin-routes/src/plugin.ts`:

```ts
import type { Plugin } from '@ax/core';
import { makeAgentContext } from '@ax/core';
import { createRoutinesAdminHandlers } from './routes.js';

const PLUGIN_NAME = '@ax/routines-admin-routes';

export function createRoutinesAdminRoutesPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [
        'http:register-route', 'routines:list', 'routines:recent-fires',
        'routines:fire-now', 'agents:resolve',
      ],
      subscribes: [],
    },
    async init({ bus }) {
      const ctx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
      const handlers = createRoutinesAdminHandlers({ bus });
      for (const route of [
        { method: 'GET' as const,  path: '/settings/routines',                       handler: handlers.list },
        { method: 'GET' as const,  path: '/settings/routines/:agentId/fires',        handler: handlers.fires },
        { method: 'POST' as const, path: '/settings/routines/:agentId/fire',         handler: handlers.fire },
      ]) {
        await bus.call('http:register-route', ctx, {
          method: route.method,
          path: route.path,
          handler: route.handler,
          // These are operator-initiated from the same-origin web UI, so CSRF
          // subscriber stays engaged. No bypassCsrf flag.
        });
      }
    },
  };
}
```

`packages/routines-admin-routes/src/routes.ts`:

```ts
import { type AgentContext, type HookBus, makeAgentContext, PluginError } from '@ax/core';
import { z } from 'zod';
import {
  parseRequestBody, requireUser, writeServiceError,
  type RouteRequest, type RouteResponse,
} from './shared.js';

export interface AdminDeps { bus: HookBus; }

const fireBodySchema = z.object({
  path: z.string().min(1).max(512),
  payload: z.unknown().optional(),
}).strict();

async function ensureOwnedBy(
  bus: HookBus, ctx: AgentContext, agentId: string, userId: string,
): Promise<boolean> {
  try {
    await bus.call('agents:resolve', ctx, { agentId, userId });
    return true;
  } catch {
    return false;
  }
}

function ctxFor(req: RouteRequest, userId: string): AgentContext {
  return makeAgentContext({
    sessionId: `admin-routines-${userId}-${Date.now()}`,
    agentId: '@ax/routines-admin-routes',
    userId,
  });
}

export function createRoutinesAdminHandlers(deps: AdminDeps): {
  list: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  fires: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  fire: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  return {
    async list(req, res) {
      const user = requireUser(req, res); if (user === null) return;
      const ctx = ctxFor(req, user.id);
      try {
        const out = await deps.bus.call<unknown, { routines: unknown[] }>(
          'routines:list', ctx, {},
        );
        const visible: unknown[] = [];
        for (const r of out.routines) {
          const row = r as { agentId: string };
          if (await ensureOwnedBy(deps.bus, ctx, row.agentId, user.id)) visible.push(r);
        }
        res.status(200).json({ routines: visible });
      } catch (err) {
        writeServiceError(res, err);
      }
    },
    async fires(req, res) {
      const user = requireUser(req, res); if (user === null) return;
      const agentId = req.params.agentId;
      const path = (req.query.path as string | undefined) ?? '';
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : 20;
      if (!path) {
        res.status(400).json({ error: { code: 'validation-error', message: 'path query param required' } });
        return;
      }
      const ctx = ctxFor(req, user.id);
      if (!await ensureOwnedBy(deps.bus, ctx, agentId, user.id)) {
        res.status(403).json({ error: { code: 'forbidden', message: 'agent not visible to caller' } });
        return;
      }
      try {
        const out = await deps.bus.call<
          { agentId: string; path: string; limit: number },
          { fires: unknown[] }
        >('routines:recent-fires', ctx, { agentId, path, limit });
        res.status(200).json({ fires: out.fires });
      } catch (err) {
        writeServiceError(res, err);
      }
    },
    async fire(req, res) {
      const user = requireUser(req, res); if (user === null) return;
      const body = parseRequestBody(req, fireBodySchema);
      if (!body.ok) { res.status(400).json({ error: body.error }); return; }
      const agentId = req.params.agentId;
      const ctx = ctxFor(req, user.id);
      if (!await ensureOwnedBy(deps.bus, ctx, agentId, user.id)) {
        res.status(403).json({ error: { code: 'forbidden', message: 'agent not visible to caller' } });
        return;
      }
      try {
        const out = await deps.bus.call<
          { agentId: string; path: string; source: 'manual'; payload?: unknown },
          { fireId: number; status: string; conversationId: string | null }
        >('routines:fire-now', ctx, {
          agentId, path: body.value.path,
          source: 'manual',
          ...(body.value.payload !== undefined ? { payload: body.value.payload } : {}),
        });
        res.status(200).json(out);
      } catch (err) {
        if (err instanceof PluginError && err.code === 'not-found') {
          res.status(404).json({ error: { code: 'not-found', message: err.message } });
          return;
        }
        writeServiceError(res, err);
      }
    },
  };
}
```

- [ ] **Step 8: Run tests to verify they pass.**

```bash
pnpm --filter @ax/routines-admin-routes test
```

Expected: PASS (3/3).

- [ ] **Step 9: Build.**

```bash
pnpm build
```

Expected: clean.

- [ ] **Step 10: Commit.**

```bash
git add packages/routines-admin-routes/
git commit -m "feat(routines-admin-routes): expose /settings/routines/* HTTP surface (Phase D)"
```

---

## Task 10: Wire `@ax/routines-admin-routes` into both presets

**Files:**
- Modify: `presets/cli/src/main.ts` (or wherever plugins are listed in CLI preset)
- Modify: `presets/k8s/src/index.ts`

- [ ] **Step 1: Find the CLI preset's plugin list.**

```bash
grep -n "createRoutinesPlugin\|@ax/routines" presets/cli/src/*.ts
```

- [ ] **Step 2: Add `createRoutinesAdminRoutesPlugin()` to the CLI plugin list immediately after `createRoutinesPlugin()`.**

Add the import + the entry in the plugin list:

```ts
import { createRoutinesAdminRoutesPlugin } from '@ax/routines-admin-routes';
// ...
createRoutinesPlugin(),
createRoutinesAdminRoutesPlugin(),
```

Also add `@ax/routines-admin-routes` to the CLI preset's `package.json` `dependencies`. Run `pnpm install`.

- [ ] **Step 3: Do the same for the k8s preset.**

```bash
grep -n "createRoutinesPlugin\|@ax/routines" presets/k8s/src/*.ts
```

Add the import + entry. Add to `presets/k8s/package.json`. `pnpm install`.

- [ ] **Step 4: Run preset tests + cli tests.**

```bash
pnpm --filter @ax/cli test
pnpm --filter presets-k8s test
```

(Or whatever the actual filter names are — grep `package.json` for the right name.)

Expected: all green.

- [ ] **Step 5: Build full repo.**

```bash
pnpm build
```

Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add presets/cli/ presets/k8s/
git commit -m "feat(presets): load @ax/routines-admin-routes in CLI and k8s presets (Phase D L1)"
```

---

## Task 11: Channel-web UI — wire UserMenu + AppShell, tests for components

**Files:**
- Modify: `packages/channel-web/src/components/UserMenu.tsx`
- Modify: `packages/channel-web/src/components/Sidebar.tsx`
- Modify: `packages/channel-web/src/App.tsx` (or wherever `SettingsPanel` is mounted)
- Modify: `packages/channel-web/src/__tests__/user-menu.test.tsx`
- Create: `packages/channel-web/src/__tests__/routines-list.test.tsx`
- Create: `packages/channel-web/src/__tests__/fire-now-control.test.tsx`
- Create: `packages/channel-web/src/__tests__/routines-client.test.ts`

The skeleton components and lib already exist on disk from the design exercise — `RoutinesPanel.tsx`, `RoutinesList.tsx`, `TriggerChip.tsx`, `StatusChip.tsx`, `FireRowsTable.tsx`, `FireNowControl.tsx`, `lib/routines.ts`. This task tests them and wires them into the app.

- [ ] **Step 1: Add `ListChecks` import and Routines menuitem to `UserMenu.tsx`.**

In `packages/channel-web/src/components/UserMenu.tsx`, extend the imports:

```ts
import { KeyRound, ListChecks, LogOut, Moon, Settings, Sun } from 'lucide-react';
```

Extend the props:

```ts
export function UserMenu({
  onOpenAdminSettings,
  onOpenSettings,
  onOpenRoutines,
}: {
  onOpenAdminSettings?: (() => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
  onOpenRoutines?: (() => void) | undefined;
} = {}) {
```

Add the menuitem between Credentials and the admin Settings (before the divider):

```tsx
<button
  type="button"
  className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-md text-[12.5px] text-foreground hover:bg-muted transition-colors [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
  role="menuitem"
  onClick={() => { setOpen(false); onOpenRoutines?.(); }}
  data-action="routines"
>
  <ListChecks aria-hidden="true" strokeWidth={1.4} />
  <span>Routines</span>
</button>
```

- [ ] **Step 2: Extend `user-menu.test.tsx` to cover the new item.**

Add a test that asserts a `Routines` button exists and triggers `onOpenRoutines`:

```tsx
it('renders Routines menuitem and invokes onOpenRoutines', async () => {
  const onOpenRoutines = vi.fn();
  render(<UserMenu onOpenRoutines={onOpenRoutines} />, { wrapper: makeUserWrapper });
  await userEvent.click(screen.getByRole('button', { name: /vinay/i }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Routines' }));
  expect(onOpenRoutines).toHaveBeenCalledTimes(1);
});
```

(Adapt to whatever `makeUserWrapper` helper the existing test file uses — read the file first.)

- [ ] **Step 3: Run user-menu test.**

```bash
pnpm --filter @ax/channel-web test -- user-menu
```

Expected: PASS.

- [ ] **Step 4: Plumb `onOpenRoutines` through `Sidebar`.**

In `packages/channel-web/src/components/Sidebar.tsx`, find the `UserMenu` invocation and add the new prop. Sidebar accepts an extra prop, passes through:

```tsx
<UserMenu
  onOpenAdminSettings={onOpenAdminSettings}
  onOpenSettings={onOpenSettings}
  onOpenRoutines={onOpenRoutines}
/>
```

Update Sidebar's prop signature accordingly.

- [ ] **Step 5: Mount `RoutinesPanel` in `App.tsx`.**

Find where `SettingsPanel` is rendered (likely in `App.tsx` or an `AppShell.tsx`). Add a parallel `routinesOpen` state and a `<RoutinesPanel open={routinesOpen} onClose={...} />` instance. Pass `onOpenRoutines={() => setRoutinesOpen(true)}` to `Sidebar`.

```tsx
import { RoutinesPanel } from './components/routines/RoutinesPanel';
// ...
const [routinesOpen, setRoutinesOpen] = useState(false);
// ...
<Sidebar
  onOpenSettings={() => setCredentialsOpen(true)}
  onOpenAdminSettings={() => setAdminOpen(true)}
  onOpenRoutines={() => setRoutinesOpen(true)}
/>
<RoutinesPanel open={routinesOpen} onClose={() => setRoutinesOpen(false)} />
```

- [ ] **Step 6: Write `routines-client.test.ts` (URL encoding + error parsing).**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { routines } from '../lib/routines';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
afterEach(() => fetchMock.mockReset());

function mockJson(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

describe('lib/routines', () => {
  it('list hydrates lastRunAt to Date', async () => {
    mockJson(200, { routines: [{
      agentId: 'agt_a', path: 'p', name: 'r', description: 'd',
      trigger: { kind: 'interval', every: '24h' },
      conversation: 'shared',
      lastStatus: 'ok', lastError: null,
      lastRunAt: '2026-05-17T00:00:00.000Z',
    }] });
    const out = await routines.list();
    expect(out[0]!.lastRunAt instanceof Date).toBe(true);
  });
  it('recentFires URL-encodes the agentId', async () => {
    mockJson(200, { fires: [] });
    await routines.recentFires({ agentId: 'agt:with/slash', path: 'p' });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('agt%3Awith%2Fslash');
  });
  it('fireNow posts payload when provided', async () => {
    mockJson(200, { fireId: 1, status: 'ok', conversationId: 'cnv' });
    await routines.fireNow({ agentId: 'a', path: 'p', payload: { x: 1 } });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { payload?: unknown };
    expect(body.payload).toEqual({ x: 1 });
  });
  it('surfaces server error message', async () => {
    mockJson(403, { error: { message: 'forbidden' } });
    await expect(routines.list()).rejects.toThrow('forbidden');
  });
});
```

- [ ] **Step 7: Write `fire-now-control.test.tsx`.**

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FireNowControl } from '../components/routines/FireNowControl';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
afterEach(() => fetchMock.mockReset());

function ok(): void {
  fetchMock.mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ fireId: 1, status: 'ok', conversationId: 'cnv' }),
  } as Response);
}

describe('FireNowControl', () => {
  const intervalRoutine = {
    agentId: 'a', path: 'p', name: 'n', description: '',
    trigger: { kind: 'interval' as const, every: '24h' },
    conversation: 'shared' as const,
    lastStatus: null, lastError: null, lastRunAt: null,
  };
  const webhookRoutine = {
    ...intervalRoutine,
    trigger: { kind: 'webhook' as const, path: '/x' },
  };

  it('interval: clicking Fire now calls fireNow immediately', async () => {
    ok();
    const onFired = vi.fn();
    render(<FireNowControl routine={intervalRoutine} onFired={onFired} />);
    await userEvent.click(screen.getByRole('button', { name: /fire now/i }));
    await waitFor(() => expect(onFired).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('webhook: clicking Fire now reveals JSON form; bad JSON surfaces error', async () => {
    render(<FireNowControl routine={webhookRoutine} onFired={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /fire now/i }));
    const textarea = await screen.findByLabelText(/JSON payload/i);
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'not json');
    await userEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByText(/invalid json/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('webhook: valid JSON submits and fires', async () => {
    ok();
    const onFired = vi.fn();
    render(<FireNowControl routine={webhookRoutine} onFired={onFired} />);
    await userEvent.click(screen.getByRole('button', { name: /fire now/i }));
    const textarea = await screen.findByLabelText(/JSON payload/i);
    await userEvent.clear(textarea);
    await userEvent.type(textarea, '{{"x":1}}');
    await userEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => expect(onFired).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { payload?: unknown };
    expect(body.payload).toEqual({ x: 1 });
  });
});
```

- [ ] **Step 8: Write `routines-list.test.tsx`.**

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RoutinesList } from '../components/routines/RoutinesList';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
afterEach(() => fetchMock.mockReset());

function mockList(body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: true, status: 200, json: async () => body,
  } as Response);
}
function mockFires(body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: true, status: 200, json: async () => body,
  } as Response);
}

describe('RoutinesList', () => {
  it('empty state', async () => {
    mockList({ routines: [] });
    render(<RoutinesList onFired={vi.fn()} />);
    expect(await screen.findByText(/no routines yet/i)).toBeInTheDocument();
  });
  it('lazy-loads fires on first expand and caches on re-expand', async () => {
    mockList({ routines: [{
      agentId: 'a', path: 'p', name: 'r', description: 'd',
      trigger: { kind: 'interval', every: '24h' },
      conversation: 'shared',
      lastStatus: 'ok', lastError: null,
      lastRunAt: new Date().toISOString(),
    }] });
    mockFires({ fires: [{
      id: 1, agentId: 'a', path: 'p',
      firedAt: new Date().toISOString(),
      triggerSource: 'tick', status: 'ok', error: null,
      conversationId: 'cnv', renderedPrompt: 'hi',
    }] });
    render(<RoutinesList onFired={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('r')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /expand r/i }));
    await waitFor(() => expect(screen.getByText('hi')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Collapse + re-expand: no new fetch (cache hit).
    await userEvent.click(screen.getByRole('button', { name: /collapse r/i }));
    await userEvent.click(screen.getByRole('button', { name: /expand r/i }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 9: Run channel-web tests.**

```bash
pnpm --filter @ax/channel-web test
```

Expected: all green.

- [ ] **Step 10: Build channel-web.**

```bash
pnpm --filter @ax/channel-web build
```

Expected: clean.

- [ ] **Step 11: Commit.**

```bash
git add packages/channel-web/
git commit -m "feat(channel-web): Routines modal + UserMenu integration (Phase D)"
```

---

## Task 12: MANUAL-ACCEPTANCE scenario

**Files:**
- Modify: `deploy/MANUAL-ACCEPTANCE.md`

- [ ] **Step 1: Append the Phase D scenario.**

Add at the end of the file (or in a logical section ordering — read the file first to pick the right spot):

````markdown
## Scenario: Observe + manually fire a routine (Phase D)

Validates the Routines modal + heartbeat seed end-to-end against `ax-next-dev`.

### Preconditions

- Image rebuilt from current `main` (with --no-cache; see prior session's lesson on docker layer caching for runner-code changes — though Phase D doesn't touch runner, the discipline applies).
- Host pod rolled out; port-forward on 9090.

### Steps

1. Sign in via the dev-bootstrap token (matches the Phase C scenario).
2. Create a fresh agent via the admin UI (Settings → Agents → New, or wherever the agent-create surface lives). Use displayName `phase-d-agent`.
3. Within ~2 seconds, `routines_v1_definitions` gets a new row for `agt_<new-id>` at `.ax/routines/heartbeat.md`:

   ```bash
   kubectl exec -n ax-next ax-next-postgresql-0 -- env PGPASSWORD=$PASS \
     psql -U postgres -d ax_next -c \
     "SELECT agent_id, path, name FROM routines_v1_definitions WHERE path = '.ax/routines/heartbeat.md';"
   ```

4. Open the avatar menu → click **Routines**. The heartbeat appears for the new agent with last_status=`—`, last-run=`never`, trigger=`interval 24h`.
5. Click **Fire now** on the heartbeat row. Within a few seconds:
   - The row's last_status flips to `silenced` (heartbeat's silenceToken returns HEARTBEAT_OK; the routine silence path activates).
   - Expanding the row shows one fire row: timestamp, status=`silenced`, triggerSource=`manual`, renderedPrompt body visible.
6. Confirm the heartbeat's per-fire conversation is **not** in the chat sidebar's "today" section. Verify the row exists in `conversations_v1_conversations` with `hidden=t`:

   ```bash
   kubectl exec -n ax-next ax-next-postgresql-0 -- env PGPASSWORD=$PASS \
     psql -U postgres -d ax_next -c \
     "SELECT conversation_id, hidden FROM conversations_v1_conversations WHERE title LIKE 'heartbeat @%' ORDER BY created_at DESC LIMIT 3;"
   ```

7. **Webhook payload variant (optional).** In a chat with `phase-d-agent`, ask it to create `.ax/routines/payload-test.md` with a webhook trigger and prompt body `received: {{payload.foo}}`. In the Routines modal, click **Fire now** on that row → JSON form opens → paste `{"foo":"bar"}` → Submit. Confirm the resulting fire row's `renderedPrompt` is `received: bar`.

### Acceptance criteria

- New agent triggers heartbeat seed; `routines_v1_definitions` has a row within 2 seconds.
- Routines modal lists the new heartbeat with the trigger chip and `—` / never.
- Fire now produces a `silenced` row visible in the expanded panel, with renderedPrompt populated.
- The fire's conversation is hidden from the chat sidebar (`hidden=true` in DB).
- (Optional) Webhook Fire now with payload renders the template into `renderedPrompt`.
````

- [ ] **Step 2: Commit.**

```bash
git add deploy/MANUAL-ACCEPTANCE.md
git commit -m "docs(deploy): add Phase D Routines modal acceptance scenario"
```

---

## Task 13: PR finalize — invariants checklist, window-closed line, lint+test+build pre-push

**Files:** none (PR description / final checks).

- [ ] **Step 1: Run full pre-PR checks.**

```bash
pnpm build
pnpm test
pnpm lint
```

Expected: all clean. Address any failures inline before opening the PR.

- [ ] **Step 2: Write the PR description.**

Use the format from prior Phase PRs. Must include:

- **Phase D window CLOSED** line — name the canary test(s) that exercise the new surface.
- L1–L9 invariant table, each marked with the PR section that enforces it.
- The acceptance scenario reference from `deploy/MANUAL-ACCEPTANCE.md`.

Skeleton:

```markdown
## Summary

Phase D — Routines UI + heartbeat seed. Closes the routines window opened in Phase A:

- New `rendered_prompt` column on `routines_v1_fires` (additive).
- New `routines:recent-fires` service hook.
- `routines:fire-now` accepts optional `payload`.
- `conversations:create` + `find-or-create` accept optional `hidden` flag; routines marks per-fire conversations hidden at creation.
- New `agents:created` event from `@ax/agents`; new `seed-heartbeat` subscriber in `@ax/routines` seeds `.ax/routines/heartbeat.md` on every new agent.
- New `@ax/routines-admin-routes` package exposes `GET /settings/routines`, `GET /settings/routines/:agentId/fires`, `POST /settings/routines/:agentId/fire`.
- `channel-web` Routines modal in the avatar dropdown menu.

**Phase D window CLOSED.** Canary tests covering the new surface: `case 10` (renderedPrompt round-trip via fire-now), `case 11` (hidden flag on per-fire conversations), `seed-heartbeat.test.ts` (template + K10), `routines-admin-routes/routes.test.ts` (HTTP surface ACL + happy paths), `routines-list.test.tsx` (UI lazy load + cache).

## Invariants

| ID | Description | Where enforced |
|---|---|---|
| L1 | No half-wired window | All tasks in one PR; presets wired in Task 10 |
| L2 | No cross-plugin imports | Verified by eslint `no-restricted-imports`; `shared.ts` copied not imported |
| L3 | Capabilities explicit + minimized | Manifest `calls` lists exactly what's needed |
| L4 | Storage-agnostic hook payloads | `agents:created` payload is `{ agentId, ownerId, ownerType }` |
| L5 | Untrusted content boundary | `renderedPrompt` capped at 64 KiB in `recordFire` |
| L6 | Subscriber must not throw | `seed-heartbeat` catches all errors |
| L7 | Additive schema only | One `ADD COLUMN`; no backfill |
| L8 | ACL on every admin route | `requireUser` + `ensureOwnedBy` on all three routes |
| L9 | Zero new shadcn primitives | Hand-rolled Collapsible/Toast |

## Test plan

- `pnpm build` + `pnpm test` + `pnpm lint` clean.
- MANUAL-ACCEPTANCE Phase D scenario walked in-cluster.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 3: Push + create PR.**

```bash
git push -u origin <branch>
gh pr create --title "feat(routines): Phase D — UI + heartbeat bootstrap" --body "$(cat <<'EOF'
... [the description from step 2]
EOF
)"
```

---

## Done.

After Task 13 merges and the MANUAL-ACCEPTANCE scenario walks, Phase D is closed. Update the project memory (`MEMORY.md`) with a new entry — `[Phase D routines UI shipped as PR #N]` — and supersede the earlier "phase-d remains" hint in `project_agent_centric_design.md`.
