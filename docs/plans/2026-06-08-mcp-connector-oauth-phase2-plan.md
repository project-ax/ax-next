# MCP Connector OAuth — Phase 2 Implementation Plan (connect UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the user-facing connector-OAuth surface — connect, status, consent, and `oauth`-slot authoring — on top of the merged Phase 1 backend, with the small backend changes that surface requires.

**Architecture:** Two PRs. **2a (backend)** reopens `@ax/mcp-oauth` so the token's storage scope follows the agent (personal → `scope:'user'`, team → `scope:'agent'`), adds a live status read endpoint, and fixes the return-path collision. **2b (UI)** adds the SPA OAuth bridge, a reusable `ConnectorOAuthConnect` component, the two connect homes (Connectors tab for personal, agent editor for team), the read-only status hint, and `oauth`-slot authoring. The resolver, proxy injection, and token blob are untouched.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspace, Kysely + Postgres (`mcp_oauth_v1_*`), zod, vitest, React + shadcn (in `packages/channel-web`), `@modelcontextprotocol/sdk` (already present). Design: `docs/plans/2026-06-08-mcp-connector-oauth-phase2-design.md`.

**Worktree:** All work happens in the isolated worktree `.worktrees/mcp-oauth-ui` (branch `feat/mcp-connector-oauth-ui`) — the shared main checkout has concurrent agents that switch its branch.

---

## File structure

**PR 2a — backend (`packages/mcp-oauth/`, `presets/k8s/`)**
- `src/types.ts` — `PendingAuthorization` gains `credScope: 'user' | 'agent'`.
- `src/migrations.ts` — additive `cred_scope` column on `mcp_oauth_v1_pending`; `McpOAuthPendingRow` gains `cred_scope`.
- `src/store.ts` — `putPending`/`rowToPending` carry `credScope`.
- `src/routes.ts` — `begin`: optional `agentId` + scope selection; `callback`: write at the stored scope/ownerId; new `status` handler + route registration.
- `src/plugin.ts` — default `connectorReturnPath` → `/oauth/connected`.
- `presets/k8s/src/index.ts:1038` — `connectorReturnPath: '/oauth/connected'`.
- `src/__tests__/{routes,store,e2e}.test.ts` — scope selection, callback write, status mapping, user-scope reuse.

**PR 2b — UI (`packages/channel-web/`)**
- `src/lib/connectors.ts` — `ConnectorCredentialSlot` widens to an `api-key | oauth` union.
- `src/lib/connector-form.ts` — `CredentialSlotRow` carries the oauth fields + (de)serialization.
- `src/lib/connectors-oauth.ts` — NEW: `beginOAuth`, `getOAuthStatus` REST wrappers.
- `src/lib/oauth-callback-bridge.ts` — NEW: the popup/return handler.
- `src/main.tsx` — call the bridge before mounting React.
- `src/components/settings/ConnectorOAuthConnect.tsx` — NEW: button + status + consent + popup orchestration.
- `src/components/settings/ConnectorConnectDialog.tsx` — oauth branch (user-scope).
- `src/components/admin/AgentForm.tsx` — team-agent connect + personal status hint in the connector section.
- `src/components/settings/ConnectorEditDialog.tsx` — `oauth`-slot authoring (advanced disclosure).
- matching `__tests__/*`.

---

## Conventions to mirror (read before starting)

- **Routes / duck-typed req-res / `auth:require-user`:** `packages/mcp-oauth/src/routes.ts` (the whole file — `begin`/`callback` are the template; `requireUser`, `ctxFor`, `isReject`, `errFields`, neutral logging).
- **Pending store + migration:** `packages/mcp-oauth/src/{store,migrations,types}.ts`.
- **`agents:resolve` output:** `packages/agents/src/types.ts:100` — `{ agent: { id, ownerId, ownerType:'user'|'team', visibility:'personal'|'team', … } }`.
- **`credentials:get` not-found:** throws `PluginError{ code:'credential-not-found' }` (`packages/credentials/src/plugin.ts:608`). **Refresh-dead:** the resolver throws `NeedsReconnectError` (`packages/mcp-oauth/src/resolver.ts:15`), message contains `reconnect required`.
- **Preset wiring:** `presets/k8s/src/index.ts:1038` (`createMcpOAuthPlugin({ mountRoutes, publicOrigin, connectorReturnPath })`).
- **Connector REST client + plan/consent re-declarations:** `packages/channel-web/src/lib/connectors.ts`.
- **Connect dialog (paste flow we branch from):** `packages/channel-web/src/components/settings/ConnectorConnectDialog.tsx`; `CredentialSlotForm.tsx`.
- **Authoring form (one source of truth):** `packages/channel-web/src/lib/connector-form.ts`; `ConnectorEditDialog.tsx`.
- **Agent editor:** `packages/channel-web/src/components/admin/AgentForm.tsx` (connector section ~629-673; `SkillAttachmentsSection` is the per-agent two-step pattern).
- **shadcn:** `collapsible.tsx` + `badge.tsx` are installed (no CLI add). Invoke the `shadcn` skill before touching UI; `ux-design` for copy.

---
---

# PR 2a — backend (hybrid scope + status endpoint + return-path)

## Task 1: `cred_scope` on the pending authorization

**Files:**
- Modify: `packages/mcp-oauth/src/types.ts:29-41` (`PendingAuthorization`)
- Modify: `packages/mcp-oauth/src/migrations.ts:26-39` (DDL), `:50-62` (`McpOAuthPendingRow`)
- Modify: `packages/mcp-oauth/src/store.ts` (`rowToPending`, `putPending`)
- Test: `packages/mcp-oauth/src/__tests__/store.test.ts`

`credScope` is the **credential storage scope** the token will be written under
(`'user'` for a personal connection, `'agent'` for a team connection). It is
distinct from the existing `scope` field (the OAuth *scopes* string). `ownerId`
is NOT stored — it's derived in the callback (`agent` ⇒ `agentId`, `user` ⇒ `userId`).

- [ ] **Step 1: Write the failing store test**

Add to `store.test.ts` (mirror the existing `consumePending` test harness):

```ts
it('round-trips credScope through put/get/consume', async () => {
  await store.putPending({
    state: 'st-cs', userId: 'u', agentId: '', connectorId: 'c', slot: 'S',
    codeVerifier: 'v', authServerUrl: 'https://auth', clientKey: 'c|a',
    resource: 'https://mcp', scope: 'read', credScope: 'user', createdAt: 1000,
  }, 1000);
  expect((await store.getPending('st-cs'))?.credScope).toBe('user');
  expect((await store.consumePending('st-cs', 2000, 600000))?.credScope).toBe('user');
});
```

- [ ] **Step 2: Run it to verify it fails** — `pnpm --filter @ax/mcp-oauth test store` → FAIL (`credScope` missing).

- [ ] **Step 3: Add the field + column.**

`types.ts` — add to `PendingAuthorization`:
```ts
  /** The credential storage scope the token is written under: 'user' for a
   *  personal connection (reused across the owner's agents), 'agent' for a team
   *  connection (sharees ride). Distinct from `scope` (the OAuth scopes). */
  credScope: 'user' | 'agent';
```

`migrations.ts` — after the `CREATE TABLE … mcp_oauth_v1_pending (…)`, add an idempotent column add (the table already shipped; pending rows are ephemeral so no backfill):
```ts
  await sql`ALTER TABLE mcp_oauth_v1_pending
    ADD COLUMN IF NOT EXISTS cred_scope TEXT NOT NULL DEFAULT 'agent'`.execute(db);
```
and add `cred_scope: string;` to `McpOAuthPendingRow`. (Default `'agent'` keeps any in-flight Phase-1 row valid; new rows always set it explicitly.)

`store.ts` — `rowToPending` reads `cred_scope` (validate to the union, fall back `'agent'`):
```ts
    credScope: r.cred_scope === 'user' ? 'user' : 'agent',
```
add `cred_scope: string | number | Date` is already loose; extend the `rowToPending` param type with `cred_scope: string;`. `putPending` inserts `cred_scope: p.credScope`.

- [ ] **Step 4: Run the test to verify it passes** — `pnpm --filter @ax/mcp-oauth test store` → PASS.

- [ ] **Step 5: Build the package** — `pnpm --filter @ax/mcp-oauth build` → PASS (the new required field flows through `routes.ts`'s `PendingAuthorization` literal — Task 2 fills it; until then `build` may flag the begin route, which Task 2 fixes. If you do Task 1 then Task 2 before building, build is clean).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-oauth/src/types.ts packages/mcp-oauth/src/migrations.ts packages/mcp-oauth/src/store.ts packages/mcp-oauth/src/__tests__/store.test.ts
git commit -m "feat(mcp-oauth): add credScope to the pending authorization"
```

---

## Task 2: `begin` — optional `agentId` + scope selection

**Files:**
- Modify: `packages/mcp-oauth/src/routes.ts` (`begin`, ~174-344)
- Test: `packages/mcp-oauth/src/__tests__/routes.test.ts`

Scope is chosen from the resolved agent: a **team** agent → `credScope:'agent'`;
a **personal** agent (or no `agentId`) → `credScope:'user'`. `agentId` becomes
optional; when present it is still gated by `agents:resolve` (the existing
owner/member ACL). When absent, the gate is connector ownership (`connectors:get`).

- [ ] **Step 1: Write the failing tests** (mirror the existing begin tests; the bus stub for `agents:resolve` returns a shaped agent).

```ts
it('begin with a personal agent stores credScope=user', async () => {
  // agents:resolve → { agent: { visibility:'personal', ownerId:'alice', … } }
  // ... drive begin with body { connectorId:'c', agentId:'A' } as user alice ...
  const pending = await store.getPending(lastState);
  expect(pending?.credScope).toBe('user');
});

it('begin with a team agent stores credScope=agent', async () => {
  // agents:resolve → { agent: { visibility:'team', ownerId:'team-1', … } }
  const pending = await store.getPending(lastState);
  expect(pending?.credScope).toBe('agent');
});

it('begin with NO agentId stores credScope=user and skips agents:resolve', async () => {
  // body { connectorId:'c' } — agents:resolve must NOT be called; connectors:get gates.
  const pending = await store.getPending(lastState);
  expect(pending?.credScope).toBe('user');
  expect(pending?.agentId).toBe('');
});
```

- [ ] **Step 2: Run it to verify it fails** — `pnpm --filter @ax/mcp-oauth test routes` → FAIL.

- [ ] **Step 3: Implement.** In `begin`:
  - Parse `agentId` as **optional**: replace the `typeof agentId !== 'string' || !agentId` rejection with: `connectorId` required; `agentId` optional (when present, must be a non-empty string — else 400).
  - When `agentId` is present, keep the `agents:resolve` gate but **capture the agent** and pick the scope:
    ```ts
    let credScope: 'user' | 'agent' = 'user';
    let pendingAgentId = '';
    if (agentId !== undefined) {
      let agent: { visibility: 'personal' | 'team'; ownerId: string };
      try {
        const out = await bus.call<
          { agentId: string; userId: string },
          { agent: { visibility: 'personal' | 'team'; ownerId: string } }
        >('agents:resolve', ctxFor(user.id), { agentId, userId: user.id });
        agent = out.agent;
      } catch (err) {
        if (isReject(err)) { res.status(403).json({ error: 'forbidden' }); return; }
        throw err;
      }
      credScope = agent.visibility === 'team' ? 'agent' : 'user';
      pendingAgentId = agentId;
    }
    ```
  - In the `PendingAuthorization` literal, set `credScope` and use `pendingAgentId` for `agentId`.
  - **Validation:** `agentId` absent ⇒ `credScope:'user'`, gated only by the existing `connectors:get` (already present below). No `agents:resolve` call.

- [ ] **Step 4: Run the test to verify it passes** — `pnpm --filter @ax/mcp-oauth test routes` → PASS.

- [ ] **Step 5: Build** — `pnpm --filter @ax/mcp-oauth build` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-oauth/src/routes.ts packages/mcp-oauth/src/__tests__/routes.test.ts
git commit -m "feat(mcp-oauth): begin picks credScope from the agent (personal->user, team->agent)"
```

---

## Task 3: `callback` — write at the stored scope/ownerId

**Files:**
- Modify: `packages/mcp-oauth/src/routes.ts` (`callback` credentials:set, ~513-531)
- Test: `packages/mcp-oauth/src/__tests__/routes.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
it('callback writes scope=user, ownerId=userId for a user credScope', async () => {
  // seed a pending row with credScope:'user', userId:'alice', agentId:'' ; drive callback
  expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
    scope: 'user', ownerId: 'alice', ref: 'account:conn', kind: 'mcp-oauth',
  }));
});
it('callback writes scope=agent, ownerId=agentId for an agent credScope', async () => {
  // pending credScope:'agent', agentId:'A'
  expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
    scope: 'agent', ownerId: 'A', ref: 'account:conn',
  }));
});
```

- [ ] **Step 2: Run it to verify it fails** — FAIL (callback hardcodes `scope:'agent', ownerId:pending.agentId`).

- [ ] **Step 3: Implement.** Replace the hardcoded `credentials:set` scope/ownerId:
```ts
const writeScope = pending.credScope; // 'user' | 'agent'
const writeOwnerId = writeScope === 'agent' ? pending.agentId : pending.userId;
// ...
'credentials:set', ctxFor(pending.userId), {
  scope: writeScope,
  ownerId: writeOwnerId,
  ref: `account:${pending.connectorId}`,
  kind: 'mcp-oauth',
  payload: encodeTokenBlob(blob),
  ...(blob.expiresAt !== undefined ? { expiresAt: blob.expiresAt } : {}),
}
```
Keep the `credentials:set` generic type's `scope` as `'user' | 'agent'`.

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-oauth/src/routes.ts packages/mcp-oauth/src/__tests__/routes.test.ts
git commit -m "feat(mcp-oauth): callback writes the credential at the pending row's scope/ownerId"
```

---

## Task 4: `GET /api/connectors/oauth/status`

**Files:**
- Modify: `packages/mcp-oauth/src/routes.ts` (add `status` handler + register the route)
- Test: `packages/mcp-oauth/src/__tests__/routes.test.ts`

The endpoint resolves status from the **same runtime path** a chat turn uses:
`credentials:get` with a ctx carrying `userId` + (when given) `agentId`. A value
⇒ `connected`; `credential-not-found` ⇒ `not-connected`; the resolver's
`NeedsReconnectError` ⇒ `needs-reconnect`; anything else ⇒ 500 ("couldn't
check"). Authz mirrors `begin`: `agents:resolve` when `agentId` is present,
`connectors:get` ownership otherwise. The token value is read host-side and
**discarded** — never returned.

- [ ] **Step 1: Write the failing tests** (inject a `credentials:get` bus stub).

```ts
it('status returns connected when credentials:get resolves', async () => {
  // credentials:get → 'access-token'
  await handlers.status(reqWith({ connectorId: 'c' }), res);
  expect(res.jsonBody).toEqual({ status: 'connected' });
});
it('status returns not-connected on credential-not-found', async () => {
  // credentials:get throws PluginError{ code:'credential-not-found' }
  expect(res.jsonBody).toEqual({ status: 'not-connected' });
});
it('status returns needs-reconnect on a NeedsReconnectError', async () => {
  // credentials:get throws new NeedsReconnectError('reconnect required')
  expect(res.jsonBody).toEqual({ status: 'needs-reconnect' });
});
it('status 403 when agents:resolve rejects', async () => {
  // agentId present, agents:resolve throws a rejection
  expect(res.statusCode).toBe(403);
});
```

- [ ] **Step 2: Run it to verify it fails** — FAIL (`status` undefined).

- [ ] **Step 3: Implement** in `createMcpOAuthRouteHandlers` (add `status` to the returned object). Read `connectorId` from `req.query` (required) + `agentId` (optional). Authz: if `agentId`, `agents:resolve` (403 on reject); else `connectors:get` (404 on reject). Then:

```ts
import { NeedsReconnectError } from './resolver.js';
// ...
const ref = `account:${connectorId}`;
const probeCtx = makeAgentContext({
  sessionId: 'mcp-oauth', agentId: agentId ?? '@ax/mcp-oauth', userId: user.id,
});
try {
  await bus.call<{ ref: string; userId: string }, string>(
    'credentials:get', probeCtx, { ref, userId: user.id });
  res.status(200).json({ status: 'connected' });
} catch (err) {
  const code = (err as { code?: unknown }).code;
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : '';
  if (code === 'credential-not-found') { res.status(200).json({ status: 'not-connected' }); return; }
  if (name === 'NeedsReconnectError' || err instanceof NeedsReconnectError || msg.includes('reconnect')) {
    res.status(200).json({ status: 'needs-reconnect' }); return;
  }
  logger.error('mcp_oauth_status_probe_failed', { connectorId, ...errFields(err) });
  res.status(500).json({ error: 'status_check_failed' });
}
```
> Note: `probeCtx.agentId` must be the **real** agentId (not `@ax/mcp-oauth`) when present, so `doResolve` walks the agent scope. The `credentials:get` service reads `ctx.agentId` for the agent-scope attempt (`packages/credentials/src/plugin.ts:567`).

In `registerMcpOAuthRoutes`, add:
```ts
{ method: 'GET', path: '/api/connectors/oauth/status', handler: handlers.status },
```

- [ ] **Step 4: Run the test to verify it passes** — `pnpm --filter @ax/mcp-oauth test routes` → PASS.

- [ ] **Step 5: Build** — `pnpm --filter @ax/mcp-oauth build` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-oauth/src/routes.ts packages/mcp-oauth/src/__tests__/routes.test.ts
git commit -m "feat(mcp-oauth): GET /api/connectors/oauth/status (live probe via the runtime path)"
```

---

## Task 5: Return-path fix (`/oauth/connected`)

**Files:**
- Modify: `packages/mcp-oauth/src/plugin.ts:240` (default)
- Modify: `presets/k8s/src/index.ts:1041` (explicit)
- Test: `packages/mcp-oauth/src/__tests__/plugin.test.ts` (or routes test asserting the redirect)

The merged default `/settings/connectors` collides with the connectors REST GET
route — a browser redirect there returns JSON, not the SPA. Use a dedicated SPA
path the static-files `spaFallback` serves.

- [ ] **Step 1: Write/extend a failing test** — assert a happy `callback` redirects to a URL starting `/oauth/connected?` (extend the existing callback success test in `routes.test.ts` or the e2e). Expected: FAIL (still `/settings/connectors`).

- [ ] **Step 2: Change the default** in `plugin.ts`: `connectorReturnPath: config.connectorReturnPath ?? '/oauth/connected'`.

- [ ] **Step 3: Change the preset** `presets/k8s/src/index.ts:1041`: `connectorReturnPath: '/oauth/connected'`.

- [ ] **Step 4: Run** — `pnpm --filter @ax/mcp-oauth test && pnpm --filter @ax/preset-k8s build` (or the preset package's name; find via `cat presets/k8s/package.json | grep name`) → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-oauth/src/plugin.ts presets/k8s/src/index.ts packages/mcp-oauth/src/__tests__/
git commit -m "fix(mcp-oauth): redirect OAuth callback to /oauth/connected (avoid the connectors REST route collision)"
```

---

## Task 6: Extend the e2e canary — user-scope reuse + scope selection

**Files:**
- Modify: `packages/mcp-oauth/src/__tests__/e2e.test.ts`

The existing canary proves the team/agent-scope sharee-rides path. Add the
personal/user-scope path: a connect with **no agentId** (or a personal agent)
stores `scope:'user'`, and the **same user** resolves it for a **different
agent** (user-scope reuse).

- [ ] **Step 1: Add a describe/it** mirroring the begin→callback block (~326). Drive `begin` with body `{ connectorId:'conn-1' }` (no agentId) as user `dave`; follow the fake authorize → `callback`; then:
```ts
// user-scope token: dave resolves it under TWO different agents.
const r1 = await h.bus.call('credentials:get', ctx({ userId:'dave', agentId:'agent-X' }), { ref:'account:conn-1', userId:'dave' });
const r2 = await h.bus.call('credentials:get', ctx({ userId:'dave', agentId:'agent-Y' }), { ref:'account:conn-1', userId:'dave' });
expect(r1).toBe(r2); // same user-scope token across agents (connect once)
```
Also assert the stored credential is `scope:'user', ownerId:'dave'`.

- [ ] **Step 2: Run it to verify it fails** — `pnpm --filter @ax/mcp-oauth test e2e` → FAIL until Tasks 2-3 land (they do — this just adds coverage; if it passes immediately because the wiring's done, that's fine, keep it).

- [ ] **Step 3: Make it pass** — it should pass given Tasks 1-5. Fix any harness gaps (the fake auth server already exists in the file).

- [ ] **Step 4: Full package gate** — `pnpm --filter @ax/mcp-oauth build && pnpm --filter @ax/mcp-oauth test && pnpm --filter @ax/mcp-oauth lint` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-oauth/src/__tests__/e2e.test.ts
git commit -m "test(mcp-oauth): e2e canary covers user-scope connect-once reuse across agents"
```

---

## Task 7: PR 2a gate — repo build + security note

**Files:** the PR description (boundary review + security note).

- [ ] **Step 1: Repo gate** — `pnpm build && pnpm test && pnpm lint` from the worktree root → PASS. (Scope lint to changed files if `.worktrees/` noise appears — see `feedback_workspace_lint_stale_worktree_noise`.)
- [ ] **Step 2: `security-checklist` skill** on the 2a diff (reopened credential-write path, new HTTP read route, scope selection). Walk the three threat models; answer every item.
- [ ] **Step 3: Boundary-review note** in the PR body: no new hook surface; status route schema lives in `packages/mcp-oauth/`; no field leaks; authz reuses `begin`'s gate (design §5).
- [ ] **Step 4: `ax-code-reviewer`** on the begin scope-selection + callback write + status endpoint (security-relevant wiring).
- [ ] **Step 5: Open PR 2a.** Title: `feat(mcp-oauth): hybrid storage scope + status endpoint (Phase 2a)`. Note the half-wired window: routes mounted + resolver unchanged; the UI (2b) closes the user-facing window.

---
---

# PR 2b — UI (bridge + connect component + wiring + authoring)

> Invoke the `shadcn` skill and `ux-design` skill before/while building UI (invariant #6). All components compose installed shadcn primitives + semantic tokens.

## Task 8: Widen the connector credential-slot types (client)

**Files:**
- Modify: `packages/channel-web/src/lib/connectors.ts:77-84` (`ConnectorCredentialSlot`)
- Modify: `packages/channel-web/src/lib/connector-form.ts` (`CredentialSlotRow` + (de)serialization)
- Test: `packages/channel-web/src/lib/__tests__/connector-form.test.ts`

The Phase-1 server schema already accepts an `oauth` slot (discriminated union).
The channel-web client types must catch up so the form can author one.

- [ ] **Step 1: Write the failing test** in `connector-form.test.ts`:

```ts
it('round-trips an oauth slot through form <-> capabilities', () => {
  const caps = {
    allowedHosts: ['mcp.example.com'], packages: { npm: [], pypi: [] }, mcpServers: [],
    credentials: [{ slot: 'MCP_TOKEN', kind: 'oauth', server: 'example', scopes: ['read'] }],
  };
  const form = formFromConnector({ id:'x', name:'X', description:'', usageNote:'',
    keyMode:'personal', visibility:'private', defaultAttached:false,
    createdAt:'', updatedAt:'', capabilities: caps as never });
  expect(form.credentialSlots[0]).toMatchObject({ kind: 'oauth', server: 'example' });
  const back = capabilitiesFromForm(form);
  expect(back.credentials[0]).toMatchObject({ kind: 'oauth', server: 'example', scopes: ['read'] });
});
it('still round-trips an api-key slot unchanged (back-compat)', () => { /* … kind:'api-key' … */ });
```

- [ ] **Step 2: Run it to verify it fails** — `pnpm --filter @ax/channel-web test connector-form` → FAIL.

- [ ] **Step 3: Implement.**

`lib/connectors.ts` — replace `ConnectorCredentialSlot` with a union:
```ts
export interface ConnectorApiKeySlot { slot: string; kind: 'api-key'; description?: string; }
export interface ConnectorOAuthSlot {
  slot: string; kind: 'oauth'; server: string; scopes?: string[];
  clientId?: string; clientSecretRef?: string; authServerUrl?: string; tokenUrl?: string;
}
export type ConnectorCredentialSlot = ConnectorApiKeySlot | ConnectorOAuthSlot;
```
(Leave `ConnectorMcpServerSpec.credentials` typed as `ConnectorCredentialSlot[]`.)

`lib/connector-form.ts` — `CredentialSlotRow` gains a `kind` + the oauth fields:
```ts
export interface CredentialSlotRow {
  slot: string;
  description: string;
  kind: 'api-key' | 'oauth';
  /** oauth only */
  server?: string;
  scopes?: string;       // comma-separated in the form
  clientId?: string;
  clientSecretRef?: string;
}
export const emptySlotRow = (): CredentialSlotRow => ({ slot: '', description: '', kind: 'api-key' });
```
- `slotToRow`: branch on `s.kind` — for oauth, fill `kind:'oauth', server, scopes: (s.scopes??[]).join(', '), clientId, clientSecretRef`; for api-key, the current shape + `kind:'api-key'`.
- `rowsToSlots`: branch on `r.kind` — oauth rows produce `{ slot, kind:'oauth', server, ...(scopes?.length ? {scopes: splitList(scopes)} : {}), ...(clientId ? {clientId} : {}), ...(clientSecretRef ? {clientSecretRef} : {}) }` (drop a row with an empty `slot` OR (oauth and empty `server`)); api-key rows unchanged.

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Build the package (tsc)** — `pnpm --filter @ax/channel-web build` → PASS (the union may surface `kind` narrowing TODOs in `ConnectorConnectDialog`/`refreshConnectedState` — Task 12 handles the dialog; for `deriveCredentialPlan`/`ConnectorsTab` an oauth slot still produces a plan entry, which is fine for presence but superseded by the oauth status in Task 12. If tsc flags a slot `.description` access, guard with `'description' in slot`).

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/lib/connectors.ts packages/channel-web/src/lib/connector-form.ts packages/channel-web/src/lib/__tests__/connector-form.test.ts
git commit -m "feat(channel-web): widen connector credential-slot client types to the api-key|oauth union"
```

---

## Task 9: OAuth REST client (`lib/connectors-oauth.ts`)

**Files:**
- Create: `packages/channel-web/src/lib/connectors-oauth.ts`
- Test: `packages/channel-web/src/lib/__tests__/connectors-oauth.test.ts`

- [ ] **Step 1: Write the failing test** (mock `fetch`):

```ts
import { beginOAuth, getOAuthStatus } from '../connectors-oauth';
it('beginOAuth POSTs connectorId/agentId and returns authorizationUrl', async () => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ authorizationUrl: 'https://p/auth' }), { status: 200 }));
  expect(await beginOAuth({ connectorId: 'c', agentId: 'A' })).toEqual({ authorizationUrl: 'https://p/auth' });
  const [, init] = (fetch as Mock).mock.calls[0];
  expect(JSON.parse(init.body)).toEqual({ connectorId: 'c', agentId: 'A' });
});
it('getOAuthStatus GETs and returns the status', async () => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'needs-reconnect' }), { status: 200 }));
  expect(await getOAuthStatus({ connectorId: 'c' })).toBe('needs-reconnect');
});
```

- [ ] **Step 2: Run it to verify it fails** — FAIL (module not found).

- [ ] **Step 3: Implement** (mirror `lib/connectors.ts` posture: `credentials:'include'`, `x-requested-with:'ax-admin'` on the POST):

```ts
export type OAuthStatus = 'connected' | 'needs-reconnect' | 'not-connected';

export async function beginOAuth(args: { connectorId: string; agentId?: string }): Promise<{ authorizationUrl: string }> {
  const res = await fetch('/api/connectors/oauth/begin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
    credentials: 'include',
    body: JSON.stringify(args.agentId !== undefined ? { connectorId: args.connectorId, agentId: args.agentId } : { connectorId: args.connectorId }),
  });
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    let msg = ''; try { msg = (JSON.parse(excerpt) as { message?: string; error?: string }).message ?? (JSON.parse(excerpt) as { error?: string }).error ?? ''; } catch { msg = excerpt; }
    throw new Error(msg || `begin oauth: ${res.status}`);
  }
  return (await res.json()) as { authorizationUrl: string };
}

export async function getOAuthStatus(args: { connectorId: string; agentId?: string }): Promise<OAuthStatus> {
  const qs = new URLSearchParams({ connectorId: args.connectorId });
  if (args.agentId !== undefined) qs.set('agentId', args.agentId);
  const res = await fetch(`/api/connectors/oauth/status?${qs.toString()}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`oauth status: ${res.status}`);
  return ((await res.json()) as { status: OAuthStatus }).status;
}
```

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/connectors-oauth.ts packages/channel-web/src/lib/__tests__/connectors-oauth.test.ts
git commit -m "feat(channel-web): connectors-oauth REST client (beginOAuth + getOAuthStatus)"
```

---

## Task 10: SPA OAuth callback bridge

**Files:**
- Create: `packages/channel-web/src/lib/oauth-callback-bridge.ts`
- Modify: `packages/channel-web/src/main.tsx`
- Test: `packages/channel-web/src/lib/__tests__/oauth-callback-bridge.test.ts`

On the `/oauth/connected?oauth=…&connector=…` return: if a popup
(`window.opener`), `postMessage` the outcome to the opener (origin-locked) and
close; otherwise strip the params and route to the Connectors tab.

- [ ] **Step 1: Write the failing test** (jsdom; set `window.location` via the test harness or a thin injectable):

```ts
import { handleOAuthReturn, OAUTH_MESSAGE_TYPE } from '../oauth-callback-bridge';
it('popup: posts the outcome to opener and signals handled', () => {
  const post = vi.fn();
  const handled = handleOAuthReturn({
    pathname: '/oauth/connected', search: '?oauth=success&connector=c', origin: 'https://app',
    opener: { postMessage: post } as unknown as Window, closeSelf: vi.fn(),
  });
  expect(handled).toBe(true);
  expect(post).toHaveBeenCalledWith({ type: OAUTH_MESSAGE_TYPE, connector: 'c', oauth: 'success' }, 'https://app');
});
it('non-oauth path: returns false (app boots normally)', () => {
  expect(handleOAuthReturn({ pathname: '/', search: '', origin: 'https://app', opener: null, closeSelf: vi.fn() })).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails** — FAIL.

- [ ] **Step 3: Implement** an injectable core + a thin `runOAuthBridge()` that reads real globals:

```ts
export const OAUTH_MESSAGE_TYPE = 'ax:oauth-callback';
export interface OAuthReturnEnv {
  pathname: string; search: string; origin: string;
  opener: Pick<Window, 'postMessage'> | null;
  closeSelf: () => void;
}
export function handleOAuthReturn(env: OAuthReturnEnv): boolean {
  if (env.pathname !== '/oauth/connected') return false;
  const p = new URLSearchParams(env.search);
  const oauth = p.get('oauth'); const connector = p.get('connector') ?? undefined;
  if (oauth !== 'success' && oauth !== 'error') return false;
  if (env.opener) {
    env.opener.postMessage({ type: OAUTH_MESSAGE_TYPE, connector, oauth }, env.origin);
    env.closeSelf();
    return true; // popup handled — caller must NOT boot the app
  }
  return false; // full-page fallback handled by the caller (strip + route + toast)
}
export function runOAuthBridge(): boolean {
  if (typeof window === 'undefined') return false;
  return handleOAuthReturn({
    pathname: window.location.pathname, search: window.location.search,
    origin: window.location.origin,
    opener: window.opener && window.opener !== window ? window.opener : null,
    closeSelf: () => window.close(),
  });
}
```

`main.tsx`:
```tsx
import { runOAuthBridge } from './lib/oauth-callback-bridge';
if (!runOAuthBridge()) {
  createRoot(document.getElementById('root')!).render(<App />);
}
```
(The popup case returns `true` and the app never mounts — it just posts + closes. The full-page fallback returns `false`; the app boots and `App` strips the params / shows a toast — handled in Task 12's note.)

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/oauth-callback-bridge.ts packages/channel-web/src/main.tsx packages/channel-web/src/lib/__tests__/oauth-callback-bridge.test.ts
git commit -m "feat(channel-web): SPA OAuth callback bridge (popup postMessage+close)"
```

---

## Task 11: `ConnectorOAuthConnect` component

**Files:**
- Create: `packages/channel-web/src/components/settings/ConnectorOAuthConnect.tsx`
- Test: `packages/channel-web/src/components/settings/__tests__/ConnectorOAuthConnect.test.tsx`

Button + status `Badge` + (team) consent gate + popup orchestration. Props:
```ts
interface ConnectorOAuthConnectProps {
  connectorId: string;
  serviceName: string;
  /** Pass for a team-agent (agent-scope) connect; omit for a personal/Connectors-tab (user-scope) connect. */
  agentId?: string;
  /** When true (team agent), show the shared-key consent line before connecting. */
  requiresConsent?: boolean;
  /** Called after a successful connect so the parent can refresh. */
  onConnected?: () => void;
}
```

Behavior:
- On mount, `getOAuthStatus({ connectorId, agentId })` → render a `Badge`:
  connected = "Connected", needs-reconnect = amber "Reconnect needed", not-connected = none/"Not connected".
- Consent (when `requiresConsent`): blocking `Alert` + "I understand" before the button is enabled. Copy: **"Authorizing lets anyone using this agent act as you on {serviceName}."**
- Connect: `beginOAuth({ connectorId, agentId })` → `window.open(authorizationUrl, 'ax-oauth', 'width=600,height=720')`; add a `message` listener filtered by `event.origin === window.location.origin && event.data?.type === OAUTH_MESSAGE_TYPE`; on receipt → remove listener, refetch status, `onConnected?.()`. Also poll `popup.closed` every ~500ms; if it closes without a message, refetch status (covers the user closing it) and clear the busy state.
- Errors from `beginOAuth` (e.g. 502 discovery) render inline via `Alert` (never a false "connected").

- [ ] **Step 1: Write the failing test** — mock `connectors-oauth`; assert: (1) renders status badge from `getOAuthStatus`; (2) for `requiresConsent`, the connect button is gated until "I understand"; (3) clicking Connect calls `beginOAuth` with the right args and opens a popup (stub `window.open`); (4) a posted `OAUTH_MESSAGE_TYPE` message from the right origin refetches status + calls `onConnected`; (5) a message from a WRONG origin is ignored.

- [ ] **Step 2: Run it to verify it fails** — FAIL.

- [ ] **Step 3: Implement** with shadcn `Button`, `Badge`, `Alert`. Mirror the consent pattern from `ConnectorConnectDialog`'s `ConnectBody`. Clean up the listener + poll on unmount.

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/settings/ConnectorOAuthConnect.tsx packages/channel-web/src/components/settings/__tests__/ConnectorOAuthConnect.test.tsx
git commit -m "feat(channel-web): ConnectorOAuthConnect (connect + status + consent + popup)"
```

---

## Task 12: Wire OAuth into the Connectors tab (personal, user-scope)

**Files:**
- Modify: `packages/channel-web/src/components/settings/ConnectorConnectDialog.tsx`
- Modify: `packages/channel-web/src/App.tsx` (full-page fallback: strip params + toast)
- Test: `packages/channel-web/src/components/settings/__tests__/ConnectorConnectDialog.test.tsx`

In the dialog, when the connector has an `oauth` slot, render
`ConnectorOAuthConnect` (no `agentId` ⇒ user-scope) **instead of** the paste
`CredentialSlotForm` for that slot. A connector with only an oauth slot shows
just the connect surface.

- [ ] **Step 1: Write the failing test** — a connector whose `capabilities.credentials` is `[{slot, kind:'oauth', server}]` renders `ConnectorOAuthConnect` (assert by a test id / the "Connect with" text), NOT a password field.

- [ ] **Step 2: Run it to verify it fails** — FAIL.

- [ ] **Step 3: Implement.** In `ConnectKeyForms`, branch per slot: if `slotMeta?.kind === 'oauth'`, render `<ConnectorOAuthConnect connectorId={connector.id} serviceName={connector.name} onConnected={onSaved} />`; else the existing `CredentialSlotForm`. (User-scope: no `agentId`, no `requiresConsent` — the Connectors tab is personal.) Guard the existing `description` access with the union (`'description' in slotMeta`).

  Also in `App.tsx`, after the bootstrap gate, add a one-shot effect: if `window.location.pathname === '/oauth/connected'` and `window.opener` is absent (full-page fallback), `history.replaceState({}, '', '/')`, push a toast ("Connected" / "Couldn't connect" from `?oauth=`), and leave the user on chat. (Keep it tiny — the popup path is the norm.)

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/settings/ConnectorConnectDialog.tsx packages/channel-web/src/App.tsx packages/channel-web/src/components/settings/__tests__/ConnectorConnectDialog.test.tsx
git commit -m "feat(channel-web): OAuth connect in the Connectors tab (user-scope, connect once)"
```

---

## Task 13: Wire OAuth into the agent editor (team connect + personal hint)

**Files:**
- Modify: `packages/channel-web/src/components/admin/AgentForm.tsx` (connector section ~629-673)
- Test: `packages/channel-web/src/components/admin/__tests__/AgentForm.test.tsx` (create or extend)

For each **attached** `oauth` connector, in the agent editor:
- **Team agent** (`form.visibility === 'team'`): render `ConnectorOAuthConnect`
  with `agentId={editing.id}` + `requiresConsent` (agent-scope, sharees ride).
- **Personal agent**: render a **read-only** status hint (`getOAuthStatus({ connectorId, agentId: editing.id })` → Badge "Connected" / "Not connected — connect in Connectors"). No connect button.

The connector list is `ConnectorSummary[]` (no capabilities), so detecting the
oauth slot requires the full connector. Load the full records for attached
connectors once (mirror `refreshConnectedState`'s `getConnector` loop) and key a
`Set<connectorId>` of "has an oauth slot."

- [ ] **Step 1: Write the failing test** — editing a team agent with an attached oauth connector renders `ConnectorOAuthConnect` with consent; editing a personal agent renders the read-only hint (no connect button). Mock `getConnector` + `getOAuthStatus`.

- [ ] **Step 2: Run it to verify it fails** — FAIL.

- [ ] **Step 3: Implement.** Add an effect (gated on `editing !== 'new'`) that loads full connectors for `form.connectorIds`, builds `oauthConnectorIds: Set<string>` (those with a `kind:'oauth'` slot) + a `serviceName` map. In the connector checkbox row, when the connector is attached AND in `oauthConnectorIds`, append the team `ConnectorOAuthConnect` or the personal hint per `form.visibility`. Only meaningful when `editing !== 'new'` (need the agent id) — for a new agent, show "Save the agent first, then connect."

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/admin/AgentForm.tsx packages/channel-web/src/components/admin/__tests__/AgentForm.test.tsx
git commit -m "feat(channel-web): agent-editor OAuth — team one-time connect + personal status hint"
```

---

## Task 14: Author the `oauth` slot in `ConnectorEditDialog`

**Files:**
- Modify: `packages/channel-web/src/components/settings/ConnectorEditDialog.tsx` (credential-slot rows ~829-889)
- Test: `packages/channel-web/src/components/settings/__tests__/ConnectorEditDialog.test.tsx`

Each credential-slot row gains a **type** toggle (API key / OAuth). An OAuth row
shows: a **server** select (over `form` MCP server names — for the MCP mechanism,
the leading server) + **scopes** (comma-separated). The pinned client
(`clientId` + `clientSecret`) lives behind a **`Collapsible`** ("Advanced —
custom OAuth client"), collapsed by default. The `clientSecret` is written to the
vault on save and referenced as `clientSecretRef` (see note).

- [ ] **Step 1: Write the failing test** — adding an oauth slot (set kind=oauth, server, scopes) and saving produces a `capabilities.credentials[0]` of `{ kind:'oauth', server, scopes }`. Assert the Advanced fields are hidden until the caret is opened.

- [ ] **Step 2: Run it to verify it fails** — FAIL.

- [ ] **Step 3: Implement.** In the slot-row map, add a small `ToggleGroup`/`Select` for `row.kind`. When `oauth`: render a server `Select` (options = the form's MCP server name(s); for the `mcp` mechanism the leading server name = `form.connectorId || form.name` slug, or the existing `baseCapabilities.mcpServers[].name`) + a scopes `Input`; wrap `clientId`/`clientSecretRef` entry in `<Collapsible>` (shadcn) titled "Advanced — custom OAuth client" with a chevron. The `updateSlot` helper already exists; extend it for the new fields.

  **client_secret storage:** the Advanced fields capture `clientId` (plain) + a `client_secret` value. On connector save, if a `client_secret` was entered, write it to the vault (`setDestinationCredential`, scope per the connector's keyMode: personal→user, workspace→global) at ref `account:<connectorId>:oauth-client-secret`, and set `row.clientSecretRef` to that ref before `capabilitiesFromForm`. (`begin` resolves `clientSecretRef` via `credentials:get` under the connecting user — `packages/mcp-oauth/src/routes.ts:266-287`.) If only a pre-existing `clientSecretRef` is shown (edit), don't rewrite. Keep this in `ConnectorEditDialog.submit` (not in the pure `connector-form`, which must stay side-effect-free).

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Build + lint the package** — `pnpm --filter @ax/channel-web build && pnpm --filter @ax/channel-web lint` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/settings/ConnectorEditDialog.tsx packages/channel-web/src/components/settings/__tests__/ConnectorEditDialog.test.tsx
git commit -m "feat(channel-web): author an oauth credential slot (server+scopes, pinned client behind Advanced)"
```

---

## Task 15: PR 2b gate — repo build, canary reachability, reviews

**Files:** the PR description.

- [ ] **Step 1: Repo gate** — `pnpm build && pnpm test && pnpm lint` (scope lint to changed files for the worktree-noise caveat) → PASS.
- [ ] **Step 2: Reachability (invariant #3).** Confirm the UI path is reachable end to end against the existing tests/canary: the dialog renders `ConnectorOAuthConnect` for an oauth connector; the bridge handles the return; the status endpoint maps outcomes. No half-wired component (every new component is rendered by a real parent + tested).
- [ ] **Step 3: `shadcn` skill** check — all new UI uses installed primitives + semantic tokens (no raw colors / hand-rolled forms). `ux-design` skill pass on the connect/consent/status/error copy.
- [ ] **Step 4: `security-checklist` skill** on the 2b diff (cross-window `postMessage`, new client surface). Verify origin checks both ways; no token in any message.
- [ ] **Step 5: `ax-code-reviewer`** on the bridge (postMessage/origin), `ConnectorOAuthConnect` (popup + message listener), and the client_secret write path.
- [ ] **Step 6: Open PR 2b.** Title: `feat(channel-web): connector OAuth connect UI (Phase 2b)`. Note: closes the Phase-2 user-facing window; Phase 3 is the manual-acceptance `(walk)` card.

---

## Self-review (run against the design before handing off)

- **Spec coverage:** §4 D1 hybrid scope → Tasks 1-3; D2 placement → Tasks 12 (Connectors/personal), 13 (agent editor/team + personal hint); D3 status probe → Task 4; D4 popup+bridge+return-path → Tasks 5,10,12; D5 authoring → Tasks 8,14. §7 flows → Tasks 10-13. §8 errors → Tasks 4,11,12. §9 security → Tasks 7,15. §10 tests/canary → Tasks 6,15.
- **Placeholder scan:** none — every code step shows real schema/signatures; "mirror X" steps cite an exact file:line.
- **Type consistency:** `credScope:'user'|'agent'` (Tasks 1-4); `OAuthStatus` (Tasks 9,11); `OAUTH_MESSAGE_TYPE` / `handleOAuthReturn` (Tasks 10,11); `ConnectorCredentialSlot` union + `CredentialSlotRow.kind` (Tasks 8,12,13,14); `getOAuthStatus({connectorId, agentId?})` / `beginOAuth({connectorId, agentId?})` used consistently.
- **Open verification (do during execution, not a blocker):**
  - Confirm `NeedsReconnectError` propagates un-wrapped through `credentials:get` (Task 4 — the name/message match is belt-and-braces if not).
  - Confirm `presets/k8s` is the only `createMcpOAuthPlugin` call site (Task 5 — grep; if a CLI site exists, set `connectorReturnPath` there too).
  - Confirm `@ax/static-files` is configured with `spaFallback: true` in the preset so `/oauth/connected` serves `index.html` (Task 10/12 — grep `presets/k8s/src/index.ts` for `createStaticFilesPlugin`).
