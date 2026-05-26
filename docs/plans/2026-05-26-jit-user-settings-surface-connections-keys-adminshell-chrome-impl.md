# JIT User Settings Surface — Connections + Keys (AdminShell chrome) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote user settings from the `UserMenu` modals to a real, role-aware **Settings surface** that reuses the existing `AdminShell` shadcn chrome (admins simply see *additional* tabs — invariant #6). Ship two fully-wired tabs every user gets: **Connections** (the per-`(user, agent)` skills the agent can do, with an agent switcher and a Remove for user-added ones) and **Keys** (the user-scoped credential vault — masked, with a "used by" hint, Replace, and Remove).

**Architecture:** The surface is the established `AdminShell` (a full-pane swap, not a modal, not a router) made role-aware: user tabs (`connections`, `keys`) always render; the seven admin tabs render only when `isAdmin`. Data flows over the existing same-origin `fetch` + bus-registered HTTP route pattern. Connections is a **BFF composition** in the `@ax/channel-web` server plugin (which already calls `agents:resolve`): it merges three skill sources (default-attached / agent-global / per-user) into one UI-shaped list. Per-user *detach* is a new domain hook in `@ax/skills` (the one source of truth for per-user attachments). Keys re-adds the user-scoped `GET /settings/credentials` read route (removed in the Task-19 credentials redesign but still called by the client) and reuses the existing `/settings/destinations/:kind/credential` write path.

**Tech Stack:** TypeScript, pnpm workspace, React + shadcn/ui (in `packages/channel-web`), kysely + Postgres (testcontainers in tests), zod, vitest + @testing-library/react.

---

## Why this slice is exactly Connections + Keys (read before scoping anything else)

The card names design **Part II P3 + P7.1**, decisions **#11/#15**, and the **P6 mirror property**. It does **not** name P2/P7.2 (the service-keyed `account` vault) or P7.3 (the persistent host-grant store). Verified against `main` (HEAD `85bdb59a`, after TASK-37 #190 merged), those two backends are **separate Backlog tasks** that are **not** TASK-42 dependencies:

- **TASK-43** (`account` tag + service-keyed vault) — Backlog. The manifest `account` tag does **not** exist on `main` (`CapabilitySlot` in `packages/skills-parser/src/capabilities.ts` has only `{ slot, kind, description? }`; the only credential destinations are `provider:` / `skill:<id>:<slot>` / `mcp:*` / `routine:*` in `packages/credentials/src/refs.ts`). So Keys is **per-slot**, not service-keyed, in this slice.
- **TASK-44** (`per-(user,agent)` host-grant store, "always allow") — Backlog. TASK-37 (merged) ships only the **live** reactive wall (`proxy:add-host`, `/api/chat/allow-host`); its card states *"'Always for this agent' performs the same LIVE grant as 'Just this once' this phase"* — there is **no** persistent grant list to list or revoke. So the **"Allowed sites" panel is out of this slice**.

**Scope decision (confirmed with the human):** *Surface + skills + keys now.* Build the role-aware shell + a fully-wired Connections→skills section + a fully-wired Keys section. **Omit** the "Allowed sites" panel (TASK-44 adds it + its store) and ship Keys **per-slot** (TASK-43 upgrades it to service-keyed). These are **future additions to a stable surface, not dead code** — there is no half-wired panel in this PR (see "Half-wired window" below).

### Stale assumptions flagged (per the planning brief, item 1)

1. **The card's `Depends on: TASK-33 TASK-37` understates its content.** The "Allowed sites" persistence is TASK-44 and the "service-keyed" Keys is TASK-43 — both Backlog, neither a dep. Resolved by the Option-A scope above (those sections are deferred to their owning tasks). *Action for the board: TASK-44 and TASK-43 should each add their section into this surface when they land; their cards already point at TASK-42 ("revocable in settings (TASK-42)").*
2. **`GET /settings/credentials` is dead on `main`.** It was removed in the Task-19 credentials UX redesign (`packages/credentials-admin-routes/src/plugin.ts` header comment), yet the client still calls it (`packages/channel-web/src/lib/credentials.ts:124` → `myCredentials.list()`; asserted by `credentials-client.test.ts`). This slice **re-adds the server route**, fixing that latent mismatch.
3. **`skills:list-user-attachments` is not browser-reachable and is minimal.** It is a host-internal service hook (no IPC, no HTTP route), returns only `{ skillId, credentialBindings }` (no name/description/source/locked flag — `packages/skills/src/types.ts:140-161`), and there is **no detach hook**. This slice adds the BFF merged read (enriching via `skills:list`) and the new `skills:detach-for-user` hook + route.
4. **`main` moved during planning** (`73084ba6` → `85bdb59a`; TASK-37 #190 merged mid-stream). All file:line anchors below were re-read against `85bdb59a`. Re-confirm at execution time (the auto-ship queue may advance `main` again).

---

## Scope guardrails

- **Hook-surface change:** one new service hook — `skills:detach-for-user` (`@ax/skills`). Boundary-review note is in Task 2. It is **host-internal, NOT an IPC action** (mirrors `skills:attach-for-user`'s posture — the untrusted runner must never detach a user's skills; the only caller is the authenticated, CSRF-gated browser route).
- **New HTTP routes (not hooks):** `GET /api/chat/connections/:agentId`, `DELETE /api/chat/connections/:agentId/skills/:skillId` (channel-web BFF), and `GET /settings/credentials` (`@ax/credentials-admin-routes`). Each route's request/response schema lives in its owning package.
- **Invariant #2 (no cross-plugin imports):** the Connections merge composes `skills:*` + `agents:resolve` **via the bus**, in the channel-web server plugin (which already declares `agents:resolve` in `calls`). It is **not** placed in `@ax/skills`, because `@ax/agents` already calls `skills:resolve`/`skills:upsert` (`packages/agents/src/admin-routes.ts`, plus `skills:upsert` in its `optionalCalls`) — a `@ax/skills` → `agents:resolve` edge would form a **boot-time cycle**. The BFF is the correct, cycle-free composition layer.
- **Invariant #4 (one source of truth):** per-user attachments stay owned by `@ax/skills` (`skills_v1_user_attachments`); the BFF only *reads/merges* via hooks. Credentials stay owned by `@ax/credentials`; Keys only reads metadata + reuses the existing write route.
- **Invariant #5 (capabilities minimized):** every new route forces `ownerId/userId = actor.id` from `auth:require-user` — never trusts a body/param-supplied user id (IDOR guard). `credentials:list` returns metadata only (no secret bytes). The detach hook takes no `actor` and is keyed to `(userId, agentId, skillId)`.
- **Invariant #6 (one UI language):** reuse the installed shadcn primitives in `packages/channel-web/src/components/ui/` (`Card`, `Table`, `Badge`, `Button`, `Select`, `Sheet`, `Input`, `Label`, `Alert`). **No** new Tabs primitive — the surface reuses `AdminShell`'s existing hand-rolled sidebar+pane chrome (`AdminSidebar` + `AdminPane`). **Before writing any UI (Tasks 7–9), invoke the `shadcn` skill** (CLAUDE.md mandates it; monorepo flag is `-c packages/channel-web`).
- **Security-checklist:** the card does **not** flag it, but this slice adds user-scoped routes over **credentials** + a capability (detach). Task 10 runs the `security-checklist` skill and pastes the note into the PR; the starting threat model is pre-stated below.
- **Half-wired window:** **NONE.** Every rendered section is fully backed in this PR (Connections skills via the detach hook + BFF routes + ConnectionsTab; Keys via the new list route + existing destination write + KeysTab). The surface **omits** the "Allowed sites" panel (added by TASK-44) and renders Keys **per-slot** (upgraded by TASK-43) — these are deferred *features*, not unwired *code*. State this in the PR "Half-wired window" section: "No half-wired code; Allowed-sites + service-keyed Keys are future additions owned by TASK-44/TASK-43."

### Pre-stated threat model (for Task 10's security-checklist)

- **Sandbox escape — N/A.** No sandbox/IPC/runner surface is added. `skills:detach-for-user` is explicitly **not** an IPC action; the untrusted runner cannot reach it.
- **Prompt injection / untrusted content.** Skill *descriptions* (admin-authored, or agent-authored in open mode) render in the Connections/Keys lists. They render through React text nodes (auto-escaped) — **no `dangerouslySetInnerHTML`**. Credential "used by" is derived by parsing `skill:<id>:<slot>` refs host/client-side, never executed.
- **IDOR / cross-user access (the real risk here).** All three routes derive identity from `auth:require-user` and force `ownerId/userId = actor.id`; the Connections read additionally calls `agents:resolve({ userId: actor.id })` (ACL — a not-accessible agent → 404, no existence leak); detach is keyed to the actor's own row; `GET /settings/credentials` lists only `{ scope: 'user', ownerId: actor.id }`. No route trusts a client-supplied user id.
- **Secret exposure.** `credentials:list` returns metadata only (`{ scope, ownerId, ref, kind, createdAt, ... }`, no payload — verified `packages/credentials/src/__tests__/list.test.ts`). The Keys read path never carries secret bytes; writes reuse the existing `/settings/destinations/:kind/credential` route (secret base64 in body, scope+owner server-forced).
- **Supply chain.** No new dependencies — composes installed shadcn primitives + existing wire patterns.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/skills/src/user-attachments-store.ts` | per-`(user,agent)` attachment storage | **add** `delete()` method |
| `packages/skills/src/types.ts` | skills I/O shapes + return schemas | **add** `SkillsDetachForUser*` types + schema |
| `packages/skills/src/plugin.ts` | skills hook handlers + manifest | **add** `skills:detach-for-user` register + manifest entry |
| `packages/credentials-admin-routes/src/admin-routes.ts` | credentials read routes | **add** `GET /settings/credentials` (user-scoped list) |
| `packages/channel-web/src/server/routes-connections.ts` | **new** — BFF Connections read + detach | **create** |
| `packages/channel-web/src/server/plugin.ts` | channel-web server plugin | **wire** connections routes + 3 new `calls` |
| `packages/channel-web/src/lib/agents.ts` | **new** — agent-list wire client | **create** |
| `packages/channel-web/src/lib/connections.ts` | **new** — connections wire client | **create** |
| `packages/channel-web/src/components/admin/AdminSidebar.tsx` | settings nav | **add** user tabs + `isAdmin` gating |
| `packages/channel-web/src/components/admin/AdminShell.tsx` | settings shell | **add** `isAdmin` + new tab panels + default `connections` |
| `packages/channel-web/src/components/UserMenu.tsx` | user menu | **ungate** Settings entry (show for all) |
| `packages/channel-web/src/App.tsx` | mount point | **pass** `isAdmin` to `AdminShell` |
| `packages/channel-web/src/components/settings/ConnectionsTab.tsx` | **new** — Connections tab | **create** |
| `packages/channel-web/src/components/settings/KeysTab.tsx` | **new** — Keys tab | **create** |
| `packages/channel-web/src/components/settings/__tests__/*.test.tsx` | tab tests | **create** |

---

## Shared rule: server-forced user scope (referenced by Tasks 3, 4, 5)

Every new route is gated and scope-forced identically:

1. Resolve identity with `auth:require-user` (→ `401` on rejection). Use the existing helper for the package (`requireUser`/`requireAuthenticated` in `@ax/credentials-admin-routes`; `authOr401` in `@ax/channel-web`).
2. **Never** read a user id from the request body or params. Use the resolved `actor.id` for every hook call's `userId`/`ownerId`/`ownerUserId`.
3. CSRF: state-changing methods (POST/PUT/DELETE) are auto-gated by `@ax/http-server` requiring `X-Requested-With: ax-admin`; the wire clients send it.

This is the same contract `packages/skills/src/settings-routes.ts` and `packages/credentials-admin-routes/src/destination-routes.ts` already enforce.

---

### Task 1: `@ax/skills` — add `UserAttachmentsStore.delete()`

**Files:**
- Modify: `packages/skills/src/user-attachments-store.ts`
- Test: `packages/skills/src/__tests__/user-attachments-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `user-attachments-store.test.ts` (mirrors the existing `PostgreSqlContainer` + `runSkillsMigration` + `createUserAttachmentsStore` pattern already in the file):

```typescript
it('delete removes one scoped attachment and reports whether a row was removed', async () => {
  const store = createUserAttachmentsStore(db);
  await store.upsert({ ownerUserId: 'u1', agentId: 'a1', skillId: 'linear', credentialBindings: {} });
  await store.upsert({ ownerUserId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: {} });

  const removed = await store.delete('u1', 'a1', 'linear');
  expect(removed).toEqual({ removed: true });

  const left = await store.listForUserAgent('u1', 'a1');
  expect(left.map((a) => a.skillId)).toEqual(['github']);

  // Idempotent: deleting an absent row reports removed:false (no throw).
  expect(await store.delete('u1', 'a1', 'linear')).toEqual({ removed: false });

  // Scope isolation: u2 cannot delete u1's row.
  await store.upsert({ ownerUserId: 'u2', agentId: 'a1', skillId: 'github', credentialBindings: {} });
  expect(await store.delete('u2', 'a1', 'github')).toEqual({ removed: true });
  expect((await store.listForUserAgent('u1', 'a1')).map((a) => a.skillId)).toEqual(['github']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/user-attachments-store.test.ts`
Expected: FAIL — `store.delete` is not a function.

- [ ] **Step 3: Implement `delete`**

In `packages/skills/src/user-attachments-store.ts`, extend the interface and the returned object:

```typescript
export interface UserAttachmentsStore {
  upsert(input: UpsertUserAttachmentInput): Promise<{ created: boolean }>;
  listForUserAgent(ownerUserId: string, agentId: string): Promise<UserAttachment[]>;
  /** Remove one (user, agent, skill) attachment. Idempotent: removed:false when absent. */
  delete(ownerUserId: string, agentId: string, skillId: string): Promise<{ removed: boolean }>;
}
```

Add the implementation inside `createUserAttachmentsStore` (after `listForUserAgent`):

```typescript
async delete(ownerUserId, agentId, skillId) {
  const res = await db
    .deleteFrom('skills_v1_user_attachments')
    .where('owner_user_id', '=', ownerUserId)
    .where('agent_id', '=', agentId)
    .where('skill_id', '=', skillId)
    .executeTakeFirst();
  return { removed: Number(res.numDeletedRows ?? 0n) > 0 };
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/user-attachments-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/user-attachments-store.ts packages/skills/src/__tests__/user-attachments-store.test.ts
git commit -m "feat(skills): UserAttachmentsStore.delete() (scoped, idempotent)"
```

---

### Task 2: `@ax/skills` — register `skills:detach-for-user`

**Files:**
- Modify: `packages/skills/src/types.ts`, `packages/skills/src/plugin.ts`
- Test: `packages/skills/src/__tests__/plugin.test.ts`

**Boundary review (new service hook `skills:detach-for-user`):**
- **Alternate impl:** a join table today; a JSON column or a `@ax/skills-fs` backend tomorrow register the same `{ userId, agentId, skillId } → { removed }` shape. (Same alternate as `skills:attach-for-user`.)
- **Leak-prone fields:** none. `userId`/`agentId`/`skillId` are opaque ids; `removed` is a plain boolean. No storage vocabulary.
- **Subscriber risk:** none — it's a service hook, not a subscriber payload.
- **IPC / wire surface:** **not** an IPC action. Host-internal only; the sole caller is the authenticated, CSRF-gated channel-web detach route (Task 5). Mirrors the `skills:attach-for-user` posture documented at `plugin.ts:597-605` ("no agent-reachable caller").

- [ ] **Step 1: Write the failing test**

Add to `plugin.test.ts` (uses the existing `makeHarness` helper — `createDatabasePostgresPlugin` + `createSkillsPlugin` + stubbed `http:register-route`/`auth:require-user`):

```typescript
it('skills:detach-for-user removes a per-user attachment and is idempotent', async () => {
  const h = await makeHarness();
  // Install a skill so attach can validate, then attach for the user.
  await h.bus.call('skills:upsert', h.ctx(), { manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY });
  await h.bus.call('skills:attach-for-user', h.ctx(), {
    userId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: {},
  });

  const before = await h.bus.call<
    { userId: string; agentId: string },
    { attachments: Array<{ skillId: string }> }
  >('skills:list-user-attachments', h.ctx(), { userId: 'u1', agentId: 'a1' });
  expect(before.attachments.map((a) => a.skillId)).toEqual(['github']);

  const out = await h.bus.call<
    { userId: string; agentId: string; skillId: string },
    { removed: boolean }
  >('skills:detach-for-user', h.ctx(), { userId: 'u1', agentId: 'a1', skillId: 'github' });
  expect(out).toEqual({ removed: true });

  const after = await h.bus.call<
    { userId: string; agentId: string },
    { attachments: unknown[] }
  >('skills:list-user-attachments', h.ctx(), { userId: 'u1', agentId: 'a1' });
  expect(after.attachments).toEqual([]);

  // Idempotent — removing again is not an error.
  expect(
    await h.bus.call('skills:detach-for-user', h.ctx(), { userId: 'u1', agentId: 'a1', skillId: 'github' }),
  ).toEqual({ removed: false });
});
```

Also extend the manifest-shape assertion in `plugin.test.ts` (the test that lists `registers`) to include `'skills:detach-for-user'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/plugin.test.ts`
Expected: FAIL — no plugin registers `skills:detach-for-user`.

- [ ] **Step 3: Add the types + return schema**

In `packages/skills/src/types.ts`, next to the existing `SkillsListUserAttachments*` definitions (~line 155):

```typescript
export interface SkillsDetachForUserInput {
  userId: string;
  agentId: string;
  skillId: string;
}
export interface SkillsDetachForUserOutput {
  removed: boolean;
}
```

And next to `SkillsListUserAttachmentsOutputSchema` (~line 305):

```typescript
export const SkillsDetachForUserOutputSchema = z.object({
  removed: z.boolean(),
}) as unknown as ZodType<SkillsDetachForUserOutput>;
```

- [ ] **Step 4: Register the hook + manifest entry**

In `packages/skills/src/plugin.ts`, add `'skills:detach-for-user'` to the manifest `registers` array (after `'skills:list-user-attachments'`, ~line 187). Import the new types/schema in the existing type import block. Then register the handler immediately after the `skills:list-user-attachments` registration (~line 657):

```typescript
bus.registerService<SkillsDetachForUserInput, SkillsDetachForUserOutput>(
  'skills:detach-for-user',
  PLUGIN_NAME,
  async (_ctx, input) => {
    // Host-internal: the (authenticated) caller supplies userId. Keyed to
    // (userId, agentId, skillId) so a user can only ever detach their own row.
    return attachmentsStore.delete(input.userId, input.agentId, input.skillId);
  },
  { returns: SkillsDetachForUserOutputSchema },
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/skills test`
Expected: PASS (whole package green).

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/types.ts packages/skills/src/plugin.ts packages/skills/src/__tests__/plugin.test.ts
git commit -m "feat(skills): skills:detach-for-user hook (host-internal per-user detach)"
```

---

### Task 3: `@ax/credentials-admin-routes` — `GET /settings/credentials`

**Files:**
- Modify: `packages/credentials-admin-routes/src/admin-routes.ts`
- Test: `packages/credentials-admin-routes/src/__tests__/admin-handlers.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `admin-handlers.test.ts` (mirrors its `mkReq`/`mkRes` + `makeBus(authedUser)` harness — `makeBus` stubs `auth:require-user` to return `{ user: authedUser }`):

```typescript
it('GET /settings/credentials lists ONLY the caller user-scoped credentials', async () => {
  const bus = makeBus({ id: 'u1', isAdmin: false });
  // Seed: one user-scoped cred for u1, one global cred (must NOT appear).
  await bus.call('credentials:set', sysCtx, {
    scope: 'user', ownerId: 'u1', ref: 'skill:linear:LINEAR_API_KEY', kind: 'api-key',
    payload: new TextEncoder().encode('secret'),
  });
  await bus.call('credentials:set', sysCtx, {
    scope: 'global', ownerId: null, ref: 'provider:anthropic', kind: 'api-key',
    payload: new TextEncoder().encode('secret'),
  });

  const handlers = createAdminCredentialsHandlers({ bus });
  const res = mkRes();
  await handlers.listSettings(mkReq({}), res);

  expect(res.statusCode).toBe(200);
  const body = res.jsonBody as { credentials: Array<{ ref: string; scope: string; ownerId: string | null }> };
  expect(body.credentials).toEqual([
    { scope: 'user', ownerId: 'u1', ref: 'skill:linear:LINEAR_API_KEY', kind: 'api-key', createdAt: expect.any(String) },
  ]);
  // Defense: no secret bytes in the payload.
  expect(JSON.stringify(body)).not.toContain('secret');
});
```

(Match the exact `CredentialMeta` projection `credentials:list` returns — adjust the expected object to the fields the existing list handler test asserts. `sysCtx`/`makeBus`/`mkReq`/`mkRes` already exist in this test file; reuse them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/credentials-admin-routes test -- src/__tests__/admin-handlers.test.ts`
Expected: FAIL — `handlers.listSettings` does not exist.

- [ ] **Step 3: Add the user-scoped list handler**

In `packages/credentials-admin-routes/src/admin-routes.ts`, add a `listSettings` handler beside `list` (reuse `requireUser` from `./shared.js`):

```typescript
/** GET /settings/credentials — the caller's own user-scoped credentials (metadata only). */
async listSettings(req: RouteRequest, res: RouteResponse): Promise<void> {
  const actor = await requireUser(deps.bus, ctx, req, res);
  if (actor === null) return;
  try {
    const out = await deps.bus.call<
      { scope: 'user'; ownerId: string },
      { credentials: unknown[] }
    >('credentials:list', ctx, { scope: 'user', ownerId: actor.id });
    res.status(200).json(out);
  } catch (err) {
    if (writeServiceError(res, err)) return;
    throw err;
  }
},
```

Add it to the handler return type, import `requireUser` if not already imported, and register the route in `registerAdminCredentialsRoutes`:

```typescript
{ method: 'GET', path: '/settings/credentials', handler: handlers.listSettings },
```

(`credentials:list` is already in this plugin's manifest `calls`; no manifest change needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/credentials-admin-routes test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/credentials-admin-routes/src/admin-routes.ts packages/credentials-admin-routes/src/__tests__/admin-handlers.test.ts
git commit -m "feat(credentials-routes): re-add GET /settings/credentials (user-scoped list)"
```

---

### Task 4: channel-web BFF — `GET /api/chat/connections/:agentId` (merged read)

**Files:**
- Create: `packages/channel-web/src/server/routes-connections.ts`
- Modify: `packages/channel-web/src/server/plugin.ts`
- Test: `packages/channel-web/src/__tests__/server/routes-connections.test.ts`

- [ ] **Step 1: Write the failing test**

Create `routes-connections.test.ts` (mirror `routes-allow-host.test.ts` / `routes-chat.test.ts`: build a `HookBus`, register stub services, build duck-typed req/res). Stub `auth:require-user`, `agents:resolve`, `skills:list-user-attachments`, `skills:list`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createHookBus, makeAgentContext } from '@ax/core';
import { makeConnectionsHandlers } from '../../server/routes-connections.js';

function mkReq(params: Record<string, string>) {
  return { headers: {}, body: Buffer.from(''), cookies: {}, query: {}, params, signedCookie: () => null };
}
function mkRes() {
  const r: any = { statusCode: 0, jsonBody: undefined };
  r.status = (n: number) => { r.statusCode = n; return r; };
  r.json = (v: unknown) => { r.jsonBody = v; };
  r.end = () => {};
  return r;
}

describe('GET /api/chat/connections/:agentId', () => {
  let bus: ReturnType<typeof createHookBus>;
  const initCtx = makeAgentContext({ sessionId: 'init', agentId: '@ax/channel-web', userId: 'system' });

  beforeEach(() => {
    bus = createHookBus();
    bus.registerService('auth:require-user', 'm', async () => ({ user: { id: 'u1', isAdmin: false } }));
    bus.registerService('agents:resolve', 'm', async (_c, i: any) => {
      if (i.agentId !== 'a1') { const e: any = new Error('nf'); e.code = 'not-found'; throw e; }
      return { agent: { id: 'a1', displayName: 'Research', skillAttachments: [{ skillId: 'memory', credentialBindings: {} }] } };
    });
    bus.registerService('skills:list-user-attachments', 'm', async () => ({
      attachments: [{ skillId: 'linear', credentialBindings: {} }],
    }));
    bus.registerService('skills:list', 'm', async () => ({
      skills: [
        { id: 'web_search', description: 'Search the web', defaultAttached: true },
        { id: 'memory', description: 'Long-term memory', defaultAttached: false },
        { id: 'linear', description: 'Linear issues', defaultAttached: false },
      ],
    }));
  });

  it('merges default + agent-global + per-user with source tags and removable flags', async () => {
    const h = makeConnectionsHandlers({ bus, initCtx });
    const res = mkRes();
    await h.get(mkReq({ agentId: 'a1' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      agentId: 'a1',
      skills: [
        { skillId: 'web_search', description: 'Search the web', source: 'default', removable: false },
        { skillId: 'memory', description: 'Long-term memory', source: 'agent', removable: false },
        { skillId: 'linear', description: 'Linear issues', source: 'user', removable: true },
      ],
    });
  });

  it('404s an agent the caller cannot access (no existence leak)', async () => {
    const h = makeConnectionsHandlers({ bus, initCtx });
    const res = mkRes();
    await h.get(mkReq({ agentId: 'nope' }), res);
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/routes-connections.test.ts`
Expected: FAIL — cannot find module `../../server/routes-connections.js`.

- [ ] **Step 3: Implement the merged-read handler**

Create `packages/channel-web/src/server/routes-connections.ts` (mirror `routes-allow-host.ts`'s I2 posture — no `@ax/skills`/`@ax/agents` import; duck-typed bus calls + `RouteRequest`/`RouteResponse` from `routes-chat.js`):

```typescript
/**
 * GET    /api/chat/connections/:agentId
 * DELETE /api/chat/connections/:agentId/skills/:skillId   (Task 5)
 *
 * The Settings "Connections" surface — a per-(user, agent) read of "what this
 * agent can do," merged from three sources via the bus:
 *   - default-attached (locked)   — skills:list, defaultAttached === true
 *   - agent-global    (locked)    — agents:resolve → agent.skillAttachments
 *   - per-user        (removable) — skills:list-user-attachments
 * Precedence on id collision mirrors the orchestrator union: user > agent > default.
 *
 * Security: identity is the AUTHENTICATED user (auth:require-user); agents:resolve
 * enforces the agent ACL (a not-accessible agent → 404, no existence leak). I2 —
 * no cross-plugin import; all hooks are duck-typed bus calls.
 */
import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import type { RouteRequest, RouteResponse } from './routes-chat.js';

interface AuthRequireUserInput { req: RouteRequest }
interface AuthRequireUserOutput { user: { id: string; isAdmin: boolean } }

interface AgentsResolveInput { agentId: string; userId: string }
interface AgentSkillAttachment { skillId: string; credentialBindings: Record<string, string> }
interface AgentsResolveOutput { agent: { id: string; skillAttachments: AgentSkillAttachment[] } }

interface SkillsListInput { scope: 'all'; ownerUserId: string }
interface SkillSummaryLite { id: string; description: string; defaultAttached: boolean }
interface SkillsListOutput { skills: SkillSummaryLite[] }

interface ListUserAttachmentsInput { userId: string; agentId: string }
interface ListUserAttachmentsOutput { attachments: Array<{ skillId: string }> }

interface DetachInput { userId: string; agentId: string; skillId: string }
interface DetachOutput { removed: boolean }

export interface ConnectionSkill {
  skillId: string;
  description: string;
  source: 'default' | 'agent' | 'user';
  removable: boolean;
}
export interface ConnectionsResponse { agentId: string; skills: ConnectionSkill[] }

async function authOr401(
  bus: HookBus, ctx: AgentContext, req: RouteRequest, res: RouteResponse,
): Promise<string | null> {
  try {
    const r = await bus.call<AuthRequireUserInput, AuthRequireUserOutput>('auth:require-user', ctx, { req });
    return r.user.id;
  } catch (err) {
    if (err instanceof PluginError) { res.status(401).json({ error: 'unauthenticated' }); return null; }
    throw err;
  }
}

/** Resolve the agent for ACL. Any PluginError → 404 (do not leak existence). */
async function resolveAgentOr404(
  bus: HookBus, ctx: AgentContext, agentId: string, userId: string, res: RouteResponse,
): Promise<AgentsResolveOutput['agent'] | null> {
  try {
    const r = await bus.call<AgentsResolveInput, AgentsResolveOutput>('agents:resolve', ctx, { agentId, userId });
    return r.agent;
  } catch (err) {
    if (err instanceof PluginError) { res.status(404).json({ error: 'agent-not-found' }); return null; }
    throw err;
  }
}

export function makeConnectionsHandlers(deps: { bus: HookBus; initCtx: AgentContext }) {
  const { bus, initCtx } = deps;
  return {
    /** GET /api/chat/connections/:agentId */
    async get(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) { res.status(400).json({ error: 'missing-agent-id' }); return; }

      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      const [userAtt, listed] = await Promise.all([
        bus.call<ListUserAttachmentsInput, ListUserAttachmentsOutput>(
          'skills:list-user-attachments', initCtx, { userId, agentId }),
        bus.call<SkillsListInput, SkillsListOutput>(
          'skills:list', initCtx, { scope: 'all', ownerUserId: userId }),
      ]);

      const descById = new Map(listed.skills.map((s) => [s.id, s.description]));
      const defaultIds = new Set(listed.skills.filter((s) => s.defaultAttached).map((s) => s.id));
      const userIds = new Set(userAtt.attachments.map((a) => a.skillId));
      const agentIds = new Set(agent.skillAttachments.map((a) => a.skillId));

      const skills: ConnectionSkill[] = [];
      const pushAll = (ids: string[], source: ConnectionSkill['source']) => {
        for (const id of [...ids].sort()) {
          skills.push({ skillId: id, description: descById.get(id) ?? '', source, removable: source === 'user' });
        }
      };
      // Precedence user > agent > default: subtract higher-precedence ids.
      pushAll([...defaultIds].filter((id) => !userIds.has(id) && !agentIds.has(id)), 'default');
      pushAll([...agentIds].filter((id) => !userIds.has(id)), 'agent');
      pushAll([...userIds], 'user');

      res.status(200).json({ agentId, skills } satisfies ConnectionsResponse);
    },

    /** DELETE /api/chat/connections/:agentId/skills/:skillId — implemented in Task 5. */
    async detach(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      const skillId = req.params.skillId ?? '';
      if (agentId.length === 0 || skillId.length === 0) { res.status(400).json({ error: 'missing-id' }); return; }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;
      await bus.call<DetachInput, DetachOutput>('skills:detach-for-user', initCtx, { userId, agentId, skillId });
      res.status(204).end(); // idempotent — 204 whether or not a row existed
    },
  };
}
```

(The `detach` handler is implemented here but only *registered* in Task 5, so Task 4's test exercises `get` and Task 5's test exercises `detach`. This avoids a half-wired window — both ship before the package is done.)

- [ ] **Step 4: Wire the GET route + manifest calls in `plugin.ts`**

In `packages/channel-web/src/server/plugin.ts`: add `'skills:list'`, `'skills:list-user-attachments'`, and `'skills:detach-for-user'` to the manifest `calls` array (with a comment: "Settings Connections surface (TASK-42) — channel-web always co-deploys with @ax/skills in presets/k8s, so these are hard deps"). Then register both routes in `init()` (after the allow-host route, before attachments):

```typescript
import { makeConnectionsHandlers } from './routes-connections.js';
// ...inside init(), after allowHostRoute:
const connections = makeConnectionsHandlers({ bus, initCtx });
for (const route of [
  { method: 'GET' as const, path: '/api/chat/connections/:agentId', handler: connections.get },
  { method: 'DELETE' as const, path: '/api/chat/connections/:agentId/skills/:skillId', handler: connections.detach },
]) {
  const r = await bus.call<unknown, { unregister: () => void }>('http:register-route', initCtx, {
    method: route.method,
    path: route.path,
    handler: route.handler as unknown as (req: RouteRequest, res: RouteResponse) => Promise<void>,
  });
  unregisterRoutes.push(r.unregister);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/routes-connections.test.ts`
Expected: PASS (the `get` cases).

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/server/routes-connections.ts packages/channel-web/src/server/plugin.ts packages/channel-web/src/__tests__/server/routes-connections.test.ts
git commit -m "feat(channel-web): BFF GET /api/chat/connections/:agentId merged skills read"
```

---

### Task 5: channel-web BFF — `DELETE /api/chat/connections/:agentId/skills/:skillId`

**Files:**
- Test: `packages/channel-web/src/__tests__/server/routes-connections.test.ts`

(The handler + route registration already landed in Task 4; this task adds the detach coverage and the plugin-manifest assertion. Per the bug-fix/test policy and invariant #3, the detach path must be tested before the package is considered done.)

- [ ] **Step 1: Write the failing test**

Add to `routes-connections.test.ts`, extending the `beforeEach` to also register a recording `skills:detach-for-user` stub:

```typescript
let detachCalls: Array<{ userId: string; agentId: string; skillId: string }>;
// in beforeEach:
detachCalls = [];
bus.registerService('skills:detach-for-user', 'm', async (_c, i: any) => {
  detachCalls.push(i); return { removed: true };
});

it('DELETE detaches the caller user-scoped skill and returns 204', async () => {
  const h = makeConnectionsHandlers({ bus, initCtx });
  const res = mkRes();
  await h.detach(mkReq({ agentId: 'a1', skillId: 'linear' }), res);
  expect(res.statusCode).toBe(204);
  expect(detachCalls).toEqual([{ userId: 'u1', agentId: 'a1', skillId: 'linear' }]);
});

it('DELETE 404s an agent the caller cannot access (no cross-user detach)', async () => {
  const h = makeConnectionsHandlers({ bus, initCtx });
  const res = mkRes();
  await h.detach(mkReq({ agentId: 'nope', skillId: 'linear' }), res);
  expect(res.statusCode).toBe(404);
  expect(detachCalls).toEqual([]);
});
```

Also add a plugin-level assertion in `packages/channel-web/src/__tests__/server/plugin.test.ts` that the manifest `calls` now include `skills:list`, `skills:list-user-attachments`, `skills:detach-for-user` (mirror the existing manifest assertion in that file).

- [ ] **Step 2: Run test to verify it fails (then passes)**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/routes-connections.test.ts src/__tests__/server/plugin.test.ts`
Expected: the new detach cases PASS immediately (the handler shipped in Task 4); the manifest assertion FAILS until you confirm the three `calls` are present from Task 4, then PASSES. If the detach handler was not added in Task 4, add it now per Task 4 Step 3.

- [ ] **Step 3: Confirm the manifest + registration**

Verify `plugin.ts` `calls` contains the three skills hooks and both connection routes are registered (Task 4 Step 4). No new code if Task 4 is complete.

- [ ] **Step 4: Run the package tests**

Run: `pnpm -F @ax/channel-web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/__tests__/server/routes-connections.test.ts packages/channel-web/src/__tests__/server/plugin.test.ts
git commit -m "test(channel-web): cover connections detach route + manifest calls"
```

---

### Task 6: channel-web client — `lib/agents.ts` + `lib/connections.ts`

**Files:**
- Create: `packages/channel-web/src/lib/agents.ts`, `packages/channel-web/src/lib/connections.ts`
- Test: `packages/channel-web/src/__tests__/connections-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `connections-client.test.ts` (mirror `credentials-client.test.ts` — stub `global.fetch`, assert URL/method/headers + parsed result):

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { listChatAgents } from '../lib/agents.js';
import { getConnections, detachConnectionSkill } from '../lib/connections.js';

afterEach(() => vi.restoreAllMocks());

it('listChatAgents GETs /api/chat/agents', async () => {
  const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify([{ agentId: 'a1', displayName: 'Research', visibility: 'personal' }]), { status: 200 }),
  );
  const agents = await listChatAgents();
  expect(fetchMock).toHaveBeenCalledWith('/api/chat/agents', { credentials: 'include' });
  expect(agents).toEqual([{ agentId: 'a1', displayName: 'Research', visibility: 'personal' }]);
});

it('getConnections GETs /api/chat/connections/:agentId', async () => {
  vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ agentId: 'a1', skills: [] }), { status: 200 }),
  );
  const out = await getConnections('a1');
  expect(out).toEqual({ agentId: 'a1', skills: [] });
});

it('detachConnectionSkill DELETEs with the CSRF header', async () => {
  const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await detachConnectionSkill('a1', 'linear');
  expect(fetchMock).toHaveBeenCalledWith('/api/chat/connections/a1/skills/linear', {
    method: 'DELETE',
    headers: { 'x-requested-with': 'ax-admin' },
    credentials: 'include',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/connections-client.test.ts`
Expected: FAIL — cannot find modules `../lib/agents.js` / `../lib/connections.js`.

- [ ] **Step 3: Implement the wire clients**

Create `packages/channel-web/src/lib/agents.ts`:

```typescript
/** Agent-list wire client — the user-scoped list behind the Settings agent switcher. */
export interface ChatAgentSummary {
  agentId: string;
  displayName: string;
  visibility: 'personal' | 'team';
}

export async function listChatAgents(): Promise<ChatAgentSummary[]> {
  const res = await fetch('/api/chat/agents', { credentials: 'include' });
  if (!res.ok) throw new Error(`list agents: ${res.status}`);
  return (await res.json()) as ChatAgentSummary[];
}
```

Create `packages/channel-web/src/lib/connections.ts`:

```typescript
/** Connections wire client — typed wrappers around /api/chat/connections/*. */
const csrfHeader = { 'x-requested-with': 'ax-admin' } as const;

export interface ConnectionSkill {
  skillId: string;
  description: string;
  source: 'default' | 'agent' | 'user';
  removable: boolean;
}
export interface ConnectionsResponse { agentId: string; skills: ConnectionSkill[] }

export async function getConnections(agentId: string): Promise<ConnectionsResponse> {
  const res = await fetch(`/api/chat/connections/${encodeURIComponent(agentId)}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`connections: ${res.status}`);
  return (await res.json()) as ConnectionsResponse;
}

export async function detachConnectionSkill(agentId: string, skillId: string): Promise<void> {
  const res = await fetch(
    `/api/chat/connections/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
    { method: 'DELETE', headers: csrfHeader, credentials: 'include' },
  );
  if (!res.ok && res.status !== 204) throw new Error(`detach: ${res.status}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/connections-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/agents.ts packages/channel-web/src/lib/connections.ts packages/channel-web/src/__tests__/connections-client.test.ts
git commit -m "feat(channel-web): agents + connections wire clients"
```

---

### Task 7: Promote `AdminShell` to a role-aware Settings surface

**Files:**
- Modify: `packages/channel-web/src/components/admin/AdminSidebar.tsx`, `packages/channel-web/src/components/admin/AdminShell.tsx`, `packages/channel-web/src/components/UserMenu.tsx`, `packages/channel-web/src/App.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/AdminSidebar.test.tsx`, `packages/channel-web/src/components/__tests__/UserMenu.test.tsx`

> **Invoke the `shadcn` skill first** (CLAUDE.md invariant #6). This task reuses the existing hand-rolled `AdminSidebar`/`AdminPane` chrome — no new primitive.

- [ ] **Step 1: Write the failing tests**

Create/extend `AdminSidebar.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminSidebar } from '../AdminSidebar';

const noop = () => {};

it('always shows the user tabs (Connections, Keys)', () => {
  render(<AdminSidebar activeTab="connections" isAdmin={false} onTabChange={noop} onBackToChat={noop} />);
  expect(screen.getByText('Connections')).toBeInTheDocument();
  expect(screen.getByText('Keys')).toBeInTheDocument();
});

it('hides admin tabs from non-admins', () => {
  render(<AdminSidebar activeTab="connections" isAdmin={false} onTabChange={noop} onBackToChat={noop} />);
  expect(screen.queryByText('Providers')).not.toBeInTheDocument();
  expect(screen.queryByText('Teams')).not.toBeInTheDocument();
});

it('shows admin tabs to admins alongside the user tabs', () => {
  render(<AdminSidebar activeTab="providers" isAdmin onTabChange={noop} onBackToChat={noop} />);
  expect(screen.getByText('Connections')).toBeInTheDocument();
  expect(screen.getByText('Providers')).toBeInTheDocument();
});
```

Create/extend `UserMenu.test.tsx` (mock `useUser` to a non-admin; assert the Settings entry now renders):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserMenu } from '../UserMenu';

vi.mock('../../lib/user-context', () => ({
  useUser: () => ({ id: 'u1', email: 'u@x.com', name: 'U', role: 'user' }),
}));

it('shows the Settings entry to non-admin users', async () => {
  render(<UserMenu onOpenAdminSettings={() => {}} />);
  // open the popover
  screen.getByRole('button', { name: /U/ }).click();
  expect(await screen.findByText('Settings')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/AdminSidebar.test.tsx src/components/__tests__/UserMenu.test.tsx`
Expected: FAIL — `AdminSidebar` has no `isAdmin` prop / no Connections/Keys tabs; UserMenu hides Settings from non-admins.

- [ ] **Step 3: Make `AdminSidebar` role-aware**

In `packages/channel-web/src/components/admin/AdminSidebar.tsx`:

```typescript
import { ChevronLeft, KeyRound, Cpu, User, Server, UsersRound, ShieldCheck, Wrench, Plug, Key } from 'lucide-react';
// ...
export type AdminTabId =
  | 'connections' | 'keys'
  | 'providers' | 'model-config' | 'auth-providers'
  | 'agents' | 'skills' | 'mcp-servers' | 'teams';

const USER_NAV: Array<{ id: AdminTabId; label: string; icon: typeof KeyRound }> = [
  { id: 'connections', label: 'Connections', icon: Plug },
  { id: 'keys', label: 'Keys', icon: Key },
];

const ADMIN_NAV: Array<{ id: AdminTabId; label: string; icon: typeof KeyRound }> = [
  { id: 'providers', label: 'Providers', icon: KeyRound },
  { id: 'model-config', label: 'Model config', icon: Cpu },
  { id: 'auth-providers', label: 'Auth providers', icon: ShieldCheck },
  { id: 'agents', label: 'Agents', icon: User },
  { id: 'skills', label: 'Skills', icon: Wrench },
  { id: 'mcp-servers', label: 'MCP servers', icon: Server },
  { id: 'teams', label: 'Teams', icon: UsersRound },
];

export interface AdminSidebarProps {
  activeTab: AdminTabId;
  isAdmin: boolean;
  onTabChange: (tab: AdminTabId) => void;
  onBackToChat: () => void;
}
```

In the body, render a "Settings" section with `USER_NAV` always, and the existing "Admin" section with `ADMIN_NAV` only when `isAdmin`. Factor the existing `<ul>`-of-`<AdminNavItem>` into a small local `NavSection({ label, items })` to avoid duplication:

```tsx
function NavSection({ label, items, activeTab, onTabChange }: {
  label: string;
  items: typeof USER_NAV;
  activeTab: AdminTabId;
  onTabChange: (t: AdminTabId) => void;
}) {
  return (
    <>
      <SidebarSectionLabel className="px-4 py-2">{label}</SidebarSectionLabel>
      <ul className="flex flex-col gap-px px-1 list-none m-0 p-0">
        {items.map((item) => (
          <li key={item.id}>
            <AdminNavItem icon={item.icon} label={item.label}
              active={activeTab === item.id} onClick={() => onTabChange(item.id)} />
          </li>
        ))}
      </ul>
    </>
  );
}
// in AdminSidebar's scroll container:
<NavSection label="Settings" items={USER_NAV} activeTab={activeTab} onTabChange={onTabChange} />
{isAdmin && <NavSection label="Admin" items={ADMIN_NAV} activeTab={activeTab} onTabChange={onTabChange} />}
```

- [ ] **Step 4: Make `AdminShell` role-aware**

In `packages/channel-web/src/components/admin/AdminShell.tsx`: add `isAdmin: boolean` to `AdminShellProps`; default `activeTab` to `'connections'`; add `connections`/`keys` to `TAB_META` (eyebrow `'Settings'`); render the new tabs; pass `isAdmin` to `AdminSidebar`:

```tsx
import { ConnectionsTab } from '../settings/ConnectionsTab';
import { KeysTab } from '../settings/KeysTab';
// TAB_META gains:
connections: { eyebrow: 'Settings', title: 'Connections' },
keys: { eyebrow: 'Settings', title: 'Keys' },
// signature:
export function AdminShell({ isAdmin, onClose }: AdminShellProps) {
  const [activeTab, setActiveTab] = useState<AdminTabId>('connections');
  // ...
  <AdminSidebar activeTab={activeTab} isAdmin={isAdmin} onTabChange={setActiveTab} onBackToChat={onClose} />
  // panels:
  {activeTab === 'connections' && <ConnectionsTab />}
  {activeTab === 'keys' && <KeysTab />}
  // ...existing admin panels unchanged...
}
```

(`ConnectionsTab`/`KeysTab` are created in Tasks 8/9. To keep this task green on its own, add minimal placeholder components `export function ConnectionsTab() { return null; }` / `KeysTab` now and flesh them out next — OR sequence Tasks 8/9 before wiring the panels. Prefer the latter: implement Tasks 8 & 9 first if executing strictly task-by-task, then wire here. If executing this task first, the placeholders keep `tsc` green and are replaced in Tasks 8/9 — no half-wired *shipped* code since all three land in the same PR.)

- [ ] **Step 5: Ungate the UserMenu Settings entry + pass `isAdmin` from App**

In `UserMenu.tsx`, remove the `{isAdmin && (...)}` wrapper around the `data-action="settings"` button so it renders for every user (keep the `onOpenAdminSettings?.()` handler). The file's security note already states server-side enforcement is the real boundary — update it to: "every user can open Settings; admin-only *tabs* are gated in-shell, and every `/admin/*` route enforces `role === 'admin'` server-side regardless."

In `App.tsx`, pass `isAdmin`:

```tsx
<AdminShell isAdmin={user.role === 'admin'} onClose={() => setAdminSettingsOpen(false)} />
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/AdminSidebar.test.tsx src/components/__tests__/UserMenu.test.tsx`
Expected: PASS. Also re-run any existing `AdminShell`/`AdminSidebar` tests to confirm the new `isAdmin` prop didn't break them.

- [ ] **Step 7: Commit**

```bash
git add packages/channel-web/src/components/admin/AdminSidebar.tsx packages/channel-web/src/components/admin/AdminShell.tsx packages/channel-web/src/components/UserMenu.tsx packages/channel-web/src/App.tsx packages/channel-web/src/components/admin/__tests__/AdminSidebar.test.tsx packages/channel-web/src/components/__tests__/UserMenu.test.tsx
git commit -m "feat(channel-web): role-aware Settings surface (Connections/Keys tabs for all users)"
```

---

### Task 8: `ConnectionsTab` — agent switcher + skills list + Remove

**Files:**
- Create: `packages/channel-web/src/components/settings/ConnectionsTab.tsx`
- Test: `packages/channel-web/src/components/settings/__tests__/ConnectionsTab.test.tsx`

> **Invoke the `shadcn` skill first.** Compose `Select` (agent switcher), `Card`, `Badge`, `Button`, `Alert` — do not hand-roll.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectionsTab } from '../ConnectionsTab';
import * as agentsLib from '../../../lib/agents';
import * as connLib from '../../../lib/connections';

beforeEach(() => {
  vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([
    { agentId: 'a1', displayName: 'Research', visibility: 'personal' },
  ]);
  vi.spyOn(connLib, 'getConnections').mockResolvedValue({
    agentId: 'a1',
    skills: [
      { skillId: 'web_search', description: 'Search the web', source: 'default', removable: false },
      { skillId: 'linear', description: 'Linear issues', source: 'user', removable: true },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

it('renders the agent switcher and the merged skills with locked/removable affordances', async () => {
  render(<ConnectionsTab />);
  expect(await screen.findByText('Linear issues')).toBeInTheDocument();
  expect(screen.getByText('Search the web')).toBeInTheDocument();
  // default is locked (no Remove), user-added is removable.
  expect(screen.getAllByRole('button', { name: /remove/i })).toHaveLength(1);
});

it('Remove calls detachConnectionSkill and refetches', async () => {
  const detach = vi.spyOn(connLib, 'detachConnectionSkill').mockResolvedValue();
  render(<ConnectionsTab />);
  fireEvent.click(await screen.findByRole('button', { name: /remove/i }));
  await waitFor(() => expect(detach).toHaveBeenCalledWith('a1', 'linear'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/components/settings/__tests__/ConnectionsTab.test.tsx`
Expected: FAIL — cannot find module `../ConnectionsTab`.

- [ ] **Step 3: Implement `ConnectionsTab`**

Create `packages/channel-web/src/components/settings/ConnectionsTab.tsx`. Structure: on mount, `listChatAgents()` → default selected = first; on selected change, `getConnections(agentId)`. Render a `Select` switcher, then a `Card` listing skills (description + a `Badge` reading `default`/`agent`/`you`, and a `Button variant="ghost"` "Remove" only when `removable`). Empty/error → `Alert`.

```tsx
import { useEffect, useState, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { listChatAgents, type ChatAgentSummary } from '@/lib/agents';
import { getConnections, detachConnectionSkill, type ConnectionSkill } from '@/lib/connections';

const SOURCE_LABEL: Record<ConnectionSkill['source'], string> = {
  default: 'default', agent: 'agent', user: 'you',
};

export function ConnectionsTab() {
  const [agents, setAgents] = useState<ChatAgentSummary[]>([]);
  const [agentId, setAgentId] = useState<string>('');
  const [skills, setSkills] = useState<ConnectionSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listChatAgents()
      .then((a) => { setAgents(a); if (a[0]) setAgentId(a[0].agentId); })
      .catch((e) => setError(String(e)));
  }, []);

  const load = useCallback((id: string) => {
    if (!id) return;
    setSkills(null); setError(null);
    getConnections(id).then((r) => setSkills(r.skills)).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => { load(agentId); }, [agentId, load]);

  const remove = async (skillId: string) => {
    await detachConnectionSkill(agentId, skillId);
    load(agentId);
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">What this agent can do</h3>
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select an agent" /></SelectTrigger>
          <SelectContent>
            {agents.map((a) => <SelectItem key={a.agentId} value={a.agentId}>{a.displayName}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}

      <Card className="divide-y divide-border">
        {skills === null && <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>}
        {skills?.length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground">No skills yet.</div>}
        {skills?.map((s) => (
          <div key={s.skillId} className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex-1 min-w-0">
              <span className="text-sm text-foreground">{s.description || s.skillId}</span>
            </span>
            <Badge variant="secondary">{SOURCE_LABEL[s.source]}</Badge>
            {s.removable
              ? <Button variant="ghost" size="sm" onClick={() => remove(s.skillId)}>Remove</Button>
              : <span className="text-[11px] text-muted-foreground w-[64px] text-right">can't remove</span>}
          </div>
        ))}
      </Card>
    </div>
  );
}
```

(If the shadcn skill reports `select` is missing, add it: `pnpm dlx shadcn@latest add select -c packages/channel-web`. Verified present on `main` — no add expected.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/components/settings/__tests__/ConnectionsTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/settings/ConnectionsTab.tsx packages/channel-web/src/components/settings/__tests__/ConnectionsTab.test.tsx
git commit -m "feat(channel-web): ConnectionsTab — agent switcher + skills + remove"
```

---

### Task 9: `KeysTab` — masked vault list + "used by" + Replace/Remove

**Files:**
- Create: `packages/channel-web/src/components/settings/KeysTab.tsx`
- Test: `packages/channel-web/src/components/settings/__tests__/KeysTab.test.tsx`

> **Invoke the `shadcn` skill first.** Compose `Card`, `Badge`, `Button`, `Sheet`, `Input`, `Alert`. Reuse `setDestinationCredential`/`clearDestinationCredential` from `@/lib/credentials`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KeysTab } from '../KeysTab';
import { myCredentials } from '../../../lib/credentials';

beforeEach(() => {
  vi.spyOn(myCredentials, 'list').mockResolvedValue([
    { scope: 'user', ownerId: 'u1', ref: 'skill:linear:LINEAR_API_KEY', kind: 'api-key', createdAt: '2026-05-20T00:00:00Z' },
    { scope: 'user', ownerId: 'u1', ref: 'skill:github:GH_TOKEN', kind: 'api-key', createdAt: '2026-05-22T00:00:00Z' },
  ]);
});
afterEach(() => vi.restoreAllMocks());

it('lists the user keys masked, with a used-by hint derived from the ref', async () => {
  render(<KeysTab />);
  // "used by" is the skill id parsed from skill:<id>:<slot>
  expect(await screen.findByText(/linear/)).toBeInTheDocument();
  expect(screen.getByText(/github/)).toBeInTheDocument();
  // secret is never rendered
  expect(screen.queryByText(/LINEAR_API_KEY=/)).not.toBeInTheDocument();
  // each row shows a masked "set" indicator
  expect(screen.getAllByText('••••••').length).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/components/settings/__tests__/KeysTab.test.tsx`
Expected: FAIL — cannot find module `../KeysTab`.

- [ ] **Step 3: Implement `KeysTab`**

Create `packages/channel-web/src/components/settings/KeysTab.tsx`. List `myCredentials.list()`, parse `skill:<id>:<slot>` refs into a per-credential `usedBy` (the skill id) + a human slot, render masked rows with Replace (Sheet + Input → `setDestinationCredential`) and Remove (`clearDestinationCredential`). For non-`skill:` refs, fall back to showing the raw ref.

```tsx
import { useEffect, useState, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import {
  myCredentials, setDestinationCredential, clearDestinationCredential,
  type CredentialMeta,
} from '@/lib/credentials';

/** skill:<id>:<slot> → { usedBy: id, slot }. Other ref shapes → { usedBy: ref }. */
function parseRef(ref: string): { usedBy: string; slot: string | null } {
  const m = /^skill:([^:]+):(.+)$/.exec(ref);
  return m ? { usedBy: m[1]!, slot: m[2]! } : { usedBy: ref, slot: null };
}

export function KeysTab() {
  const [creds, setCreds] = useState<CredentialMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    myCredentials.list().then(setCreds).catch((e) => setError(String(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const replace = async (ref: string, slot: string | null, payload: string) => {
    const m = /^skill:([^:]+):(.+)$/.exec(ref);
    if (!m) return; // only skill-slot destinations are user-replaceable in this slice
    await setDestinationCredential({
      destination: { kind: 'skill-slot', skillId: m[1]!, slot: m[2]! },
      slot: { kind: 'api-key' },
      scope: { scope: 'user', ownerId: null }, // server forces ownerId = actor.id
      payload,
    });
    load();
  };

  const remove = async (ref: string) => {
    const m = /^skill:([^:]+):(.+)$/.exec(ref);
    if (!m) return;
    await clearDestinationCredential({
      destination: { kind: 'skill-slot', skillId: m[1]!, slot: m[2]! },
      scope: { scope: 'user', ownerId: null },
    });
    load();
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div>
        <h3 className="text-sm font-medium text-foreground">My keys</h3>
        <p className="text-xs text-muted-foreground">Shared across all your agents.</p>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      <Card className="divide-y divide-border">
        {creds === null && <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>}
        {creds?.length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground">No keys yet.</div>}
        {creds?.map((c) => {
          const { usedBy, slot } = parseRef(c.ref);
          return (
            <div key={c.ref} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex-1 min-w-0">
                <span className="text-sm text-foreground">{usedBy}</span>
                <span className="ml-2 text-[11px] text-muted-foreground">used by: {usedBy}{slot ? ` · ${slot}` : ''}</span>
              </span>
              <span className="text-muted-foreground text-xs tracking-widest">••••••</span>
              <Badge variant="secondary">set</Badge>
              <ReplaceSheet onSave={(p) => replace(c.ref, slot, p)} />
              <Button variant="ghost" size="sm" onClick={() => remove(c.ref)}>Remove</Button>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function ReplaceSheet({ onSave }: { onSave: (payload: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><Button variant="ghost" size="sm">Replace</Button></SheetTrigger>
      <SheetContent>
        <SheetHeader><SheetTitle>Replace key</SheetTitle></SheetHeader>
        <div className="flex flex-col gap-3 mt-4">
          <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="New value" />
          <Button disabled={value.length === 0} onClick={async () => { await onSave(value); setOpen(false); setValue(''); }}>
            Save
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

(Confirm the exact `setDestinationCredential`/`clearDestinationCredential` argument shapes against `packages/channel-web/src/lib/credentials.ts` at execution — they take `{ destination, slot, scope: { scope, ownerId }, payload }` / `{ destination, scope }`. The `PermissionCard` already calls them with `scope: { scope: 'user', ownerId: null }`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/components/settings/__tests__/KeysTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/settings/KeysTab.tsx packages/channel-web/src/components/settings/__tests__/KeysTab.test.tsx
git commit -m "feat(channel-web): KeysTab — masked vault list + used-by + replace/remove"
```

---

### Task 10: Mirror-property integration test + full verification + PR

**Files:**
- Test: `packages/channel-web/src/__tests__/server/connections-mirror.test.ts`

- [ ] **Step 1: Write the mirror-property integration test (design P6/P8)**

This proves the "revoke from either side" mirror at the BFF level: a card-path attach appears in the Connections read, and detaching there propagates. Use the channel-web server test harness with **real** `@ax/skills` + `@ax/database-postgres` (mirror the skills `plugin.test.ts` `makeHarness` + the channel-web server route harness) and a stub `agents:resolve`:

```typescript
it('mirror: a per-user attachment appears in Connections, and detaching there removes it', async () => {
  // bootstrap: database-postgres + skills + a stub agents:resolve + auth:require-user(u1)
  // 1) simulate the card grant (host-side):
  await bus.call('skills:upsert', sys, { manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY }); // id: github
  await bus.call('skills:attach-for-user', sys, { userId: 'u1', agentId: 'a1', skillId: 'github', credentialBindings: {} });

  // 2) GET connections shows it as removable (source: user)
  const h = makeConnectionsHandlers({ bus, initCtx });
  let res = mkRes();
  await h.get(mkReq({ agentId: 'a1' }), res);
  expect((res.jsonBody as any).skills).toContainEqual(
    expect.objectContaining({ skillId: 'github', source: 'user', removable: true }),
  );

  // 3) DELETE there → 204; the per-user attachment is gone (mirror propagates)
  res = mkRes();
  await h.detach(mkReq({ agentId: 'a1', skillId: 'github' }), res);
  expect(res.statusCode).toBe(204);
  const after = await bus.call<{ userId: string; agentId: string }, { attachments: unknown[] }>(
    'skills:list-user-attachments', sys, { userId: 'u1', agentId: 'a1' });
  expect(after.attachments).toEqual([]);
});
```

(The full browser walk — connect a skill in chat → see it under Connections → revoke → confirm the next turn lacks it — is owned by **TASK-49** ("walk — settings mirror property"). This task's bar is the server-level mirror; do not attempt Playwright here.)

- [ ] **Step 2: Run the mirror test**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/connections-mirror.test.ts`
Expected: PASS.

- [ ] **Step 3: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. (`pnpm build` catches undeclared workspace deps that vitest tolerates — e.g. that channel-web's new `calls` map to real producers; `pnpm lint` enforces `no-restricted-imports` so no cross-plugin import sneaks into `routes-connections.ts`.)

- [ ] **Step 4: Run the `security-checklist` skill**

Invoke `security-checklist` and answer all three threat models against the pre-stated model above. Key items to confirm in code:
- Every new route forces `ownerId/userId = actor.id`; none reads a user id from body/params (IDOR).
- `GET /api/chat/connections/:agentId` calls `agents:resolve({ userId: actor.id })` and maps any `PluginError` to 404 (ACL + no existence leak).
- `GET /settings/credentials` returns metadata only; grep the response path for any payload/ciphertext leak (none).
- Skill descriptions render via React text nodes (no `dangerouslySetInnerHTML`).
- `skills:detach-for-user` is **not** registered as an IPC action.
Paste the structured note into the PR.

- [ ] **Step 5: Commit + open PR**

```bash
git add packages/channel-web/src/__tests__/server/connections-mirror.test.ts
git commit -m "test(channel-web): connections mirror property (attach → read → detach)"
```

PR description must include:
- **Boundary review:** new hook `skills:detach-for-user` — `{ userId, agentId, skillId } → { removed }`, storage-agnostic, no leak; alternate impl = join table / JSON column / `@ax/skills-fs`; subscriber risk none; **not** an IPC action (host-internal, like `skills:attach-for-user`). New HTTP routes' schemas live in their owning packages.
- **Half-wired window:** **NONE.** Every rendered section is fully backed. The surface intentionally omits the "Allowed sites" panel (added by **TASK-44** + its persistent host-grant store) and ships Keys per-slot rather than service-keyed (upgraded by **TASK-43**'s `account` vault). These are deferred features on a stable surface, not unwired code.
- **Stale-dep note:** TASK-42's `Depends on: TASK-33 TASK-37` understates the surface's content — "Allowed sites" persistence is TASK-44 and "service-keyed" Keys is TASK-43 (both Backlog, neither a dep). Resolved by the agreed surface-first scope; TASK-44/TASK-43 each add their section into this surface when they land.
- The security-checklist note.

---

## Self-Review

**Spec coverage** (against design Part II P3 + P7.1 + decisions #11/#15 + P6, scoped to the agreed Option A):
- "Promote user settings from UserMenu modals to a real Settings surface reusing AdminShell chrome; admins see additional tabs" (P3, P7.1, #15) → Task 7 (role-aware `AdminSidebar`/`AdminShell` + ungated UserMenu entry). ✓
- "Connections (per-(user,agent)): active skills, defaults marked + locked, user-added removable, with an agent switcher" (P3) → Tasks 4 (merged read), 6 (client), 8 (tab). ✓
- "Keys (shared across agents): credential vault with a 'used by' hint" (P3) → Tasks 3 (`/settings/credentials`), 9 (tab). Service-keyed (`account`) deferred to TASK-43 — stated. ✓
- "Allowed sites (host grants)" (P3) → **deferred to TASK-44** (persistent store doesn't exist) — explicitly out of scope, stated. ✓
- "Mirror property: revoke from either side" (P6, #11) → Task 2 (`skills:detach-for-user`), Task 5 (detach route), Task 10 (mirror integration test). ✓
- "Settings is the mirror, one source of truth, one design language" (#11, invariants #4/#6) → BFF reads/merges via hooks (no duplicate state); reuses shadcn AdminShell chrome (Task 7); `shadcn` skill invoked in UI tasks. ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. No TBD/TODO. The only conditional is Task 7 Step 4's ConnectionsTab/KeysTab sequencing note (placeholders vs. implement-first) — both land in the same PR, so no half-wired *shipped* code. ✓

**Type consistency:** `ConnectionSkill { skillId, description, source: 'default'|'agent'|'user', removable }` and `ConnectionsResponse { agentId, skills }` are identical in the server (`routes-connections.ts`), the client (`lib/connections.ts`), and the tab. `SkillsDetachForUserInput/Output` (`{ userId, agentId, skillId } → { removed }`) match the store `delete()` signature, the hook handler, and the BFF detach call. `AdminTabId` gains `'connections' | 'keys'` consistently in `AdminSidebar` + `AdminShell`. `CredentialMeta` is reused from `lib/credentials.ts` (not redefined). ✓

**Cycle safety re-verified:** the merged read lives in `@ax/channel-web` (already declares `agents:resolve` in `calls`), **not** `@ax/skills` — because `@ax/agents` calls `skills:resolve`/`skills:upsert`, so a `@ax/skills` → `agents:resolve` edge would be a boot cycle. The three new channel-web `calls` (`skills:list`, `skills:list-user-attachments`, `skills:detach-for-user`) point at `@ax/skills`, which does not call back into channel-web — no cycle. ✓

**Known residuals (acceptable this slice):**
- `skills:list({ scope: 'all' })` supplies both descriptions and the `defaultAttached` flag in one call; `skills:list-defaults` (which returns `ResolvedSkill` without `description`) is intentionally not used here.
- "used by" shows the skill id parsed from `skill:<id>:<slot>` refs (honest, no new coupling); it becomes service→skills when TASK-43's `account` vault lands.
- The Keys "Add a brand-new key from scratch" affordance is deferred — adding a key requires knowing its destination (a skill slot), which is the card's job today; the service-keyed "add by service" flow is TASK-43. KeysTab covers list / Replace / Remove of existing user credentials.
