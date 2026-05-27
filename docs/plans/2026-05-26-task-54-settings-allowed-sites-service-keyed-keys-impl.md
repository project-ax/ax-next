# TASK-54 — JIT: finish Settings surface (Allowed-sites panel + service-keyed Keys)

**Goal:** Close the two half-wired windows TASK-42 deferred on its now-stable AdminShell Settings surface. Pure UI wiring; **no new stores/hooks** (TASK-43 account vault + TASK-44 host-grants both shipped).

1. **Allowed-sites panel** under Connections (agent-scoped): wire `host-grants:list` + `host-grants:revoke` (TASK-44) — the "Always for this agent" grants, revocable. Mirror property: revoke removes the durable grant so it is not re-loaded into the next session's allowlist.
2. **Service-keyed Keys:** upgrade the Keys tab to recognize `account:<service>` vault entries (TASK-43) with "add a key by service", a "used by" hint (which skills declare `account: <svc>`), Replace + Remove. Keep per-slot rows back-compat.

**Design:** Part II P3/P6/P7.1; decisions #11/#13/#15 (`docs/plans/2026-05-26-just-in-time-capabilities-design.md`).

## As-built anchors (verified against HEAD)

- `host-grants:list({ ownerUserId, agentId }) → { hosts: { host, grantedAt }[] }`, `host-grants:revoke({ ownerUserId, agentId, host }) → { revoked }` — `packages/host-grants/src/plugin.ts`. Host-internal (NOT IPC).
- Orchestrator loads grants into the allowlist at session open — `orchestrator.ts:1362-1374` (`host-grants:list`, hasService-gated). The grant store is the source of truth; the live allowlist is a per-session snapshot.
- `account` Destination kind: `refForDestination` returns `account:${service}` (`credentials/src/refs.ts`, `channel-web/src/lib/credentials.ts:138-153`). Server route `POST|DELETE /settings/destinations/account/credential` exists (`credentials-admin-routes/src/destination-routes.ts:120-152`; service grammar `/^[a-z][a-z0-9-]{0,63}$/`).
- `skills:list` returns `SkillSummary.capabilities.credentials[]` where each slot has optional `account` (`skills/src/types.ts:228,239`). The connections route already calls `skills:list`.
- Connections BFF route is the template — auth → `agents:resolve` ACL (404 no-leak) → server-forced userId — `channel-web/src/server/routes-connections.ts`. Registered in `channel-web/src/server/plugin.ts`.
- channel-web manifest already has `host-grants:grant` in `optionalCalls`; `proxy:add-host` in hard `calls`. Manifest-shape `toEqual` assertion at `plugin.test.ts:431`.

## Mirror-property decision (load-bearing)

Revoke from settings removes the **durable** host-grant. The next session open won't load it. The current live session keeps the host until it ends (there is no `proxy:remove-host` hook and the task forbids new hooks). Fails safe: a stale live host dies with the session, never widens. (decision logged.)

---

## Tasks

### Task 1 — Allowed-sites BFF route (`routes-connections.ts` or new `routes-allowed-sites.ts`) [server]

**Load-bearing at MVP:** yes (the panel's only data path).

Add two handlers mirroring the connections route exactly:
- `GET /api/chat/allowed-sites/:agentId` → auth → `resolveAgentOr404` (ACL) → `host-grants:list({ ownerUserId: userId, agentId })` → `{ agentId, hosts: { host, grantedAt }[] }`. hasService-gated: if `!bus.hasService('host-grants:list')` return `{ agentId, hosts: [] }` (degrade for presets without `@ax/host-grants`).
- `DELETE /api/chat/allowed-sites/:agentId/:host` → auth → `resolveAgentOr404` → `host-grants:revoke({ ownerUserId: userId, agentId, host })` → 204 (idempotent). hasService-gated → 204 even if absent. `host` is path-decoded; userId server-forced.

Put it in `routes-connections.ts` (same file, same `makeConnectionsHandlers` deps — keeps the "Connections surface BFF" in one place) or a sibling. **TDD:** extend `routes-connections.test.ts` (or a new `routes-allowed-sites.test.ts`) — 200 list, 401 unauth, 404 wrong agent, 204 revoke, server-forced userId, hasService-absent degrade.

### Task 2 — Wire the allowed-sites routes into the plugin + manifest [server]

**Load-bearing:** yes (route registration).

- Register the two routes in `channel-web/src/server/plugin.ts` `init` (mirror the connections loop).
- Add `host-grants:list` + `host-grants:revoke` to `manifest.optionalCalls` (same posture as `host-grants:grant` — host-grants is k8s-preset-only; degrade cleanly). Each with a `degradation` string.
- Update the manifest `toEqual` assertion at `plugin.test.ts:431` to include the two new `optionalCalls` entries. Add a `.toContainEqual` style assertion that the panel's hooks are declared.

### Task 3 — Allowed-sites wire client (`lib/connections.ts`) [client]

**Load-bearing:** yes.

Add `getAllowedSites(agentId) → { hosts: { host, grantedAt }[] }` and `revokeAllowedSite(agentId, host) → void`, mirroring `getConnections`/`detachConnectionSkill` (CSRF header on DELETE, `credentials: 'include'`, `encodeURIComponent`). **TDD:** extend `connections-client.test.ts`.

### Task 4 — Allowed-sites panel inside ConnectionsTab [client/UI]

**Load-bearing:** yes.

Add an "Allowed sites (this agent)" Card section to `ConnectionsTab.tsx` below "What this agent can do", reusing the existing `agentId` switcher state. Each row: host + "always · <relative grantedAt>" + `[Revoke]` (ghost Button). Empty state "No allowed sites." Loads on agent change alongside connections. shadcn primitives only (Card/Badge/Button/Alert), semantic tokens. Hosts are untrusted text → React text nodes (auto-escaped). **TDD:** extend `ConnectionsTab.test.tsx` — renders hosts, Revoke calls `revokeAllowedSite` + refetches, empty state.

### Task 5 — "used by" BFF derivation for account vault entries [server]

**Load-bearing:** yes (the Keys "used by" hint for `account:<svc>`).

The Keys tab needs to know which skills declare each `account: <service>`. Add a small BFF read the KeysTab can call, OR fold it into the existing `/settings/credentials` path. Simplest: a new `GET /api/chat/account-usage` route in channel-web that calls `skills:list({ scope:'all', ownerUserId })` and returns `{ usage: Record<service, string[]> }` (service → sorted skill ids whose `capabilities.credentials[].account === service`). auth-gated, server-forced userId, hasService-gated (degrade `{}`). **TDD:** server test — derives usage from skills:list, empty when no skills, auth 401.

> YAGNI check: confirmed load-bearing — design P2 requires the "used by" hint to name the referencing skills, and it can't be derived client-side (the client never sees skill manifests). Reuses `skills:list` (no new domain hook).

### Task 6 — account-usage wire client [client]

Add `getAccountUsage() → Record<string, string[]>` to `lib/credentials.ts` (or `lib/connections.ts`). **TDD:** extend the relevant client test.

### Task 7 — Service-keyed Keys upgrade (`KeysTab.tsx`) [client/UI]

**Load-bearing:** yes (the headline feature).

Upgrade `KeysTab` to:
- Parse `account:<service>` refs → service-keyed row (label = service, e.g. "linear"); keep `skill:<id>:<slot>` rows working (back-compat).
- For `account:<svc>` rows, "used by" = `accountUsage[svc]` joined (fallback to the service name if empty), per design P2/P6.
- **Add a key by service** form (Sheet or inline): service slug input (validated client-side against `/^[a-z][a-z0-9-]{0,63}$/` for a friendly early error — SUBSET-or-equal of the server's grammar) + value → `setDestinationCredential({ destination: { kind:'account', service }, slot:{kind:'api-key'}, scope:{scope:'user',ownerId:null}, payload })`.
- Replace / Remove for `account` rows → `setDestinationCredential` / `clearDestinationCredential` with `{ kind:'account', service }`.
- Revoke pulls the credential out from under every referencing skill — covered by removing the shared `account:<svc>` row (one source of truth). Surface the blast radius in the "used by" hint + a confirm copy.

shadcn primitives only. **TDD:** extend `KeysTab.test.tsx` — lists an `account:linear` row with "used by" from usage, Add-by-service calls `setDestinationCredential` with the account destination, Remove calls `clearDestinationCredential` with the account destination, invalid service slug shows a friendly error, per-slot rows still render.

### Task 8 — whole-branch gate + mirror-property assertions

- `pnpm build` (tsc refs) + `pnpm lint` + run every touched package's vitest in isolation (channel-web; host-grants/credentials untouched).
- Confirm the connections-mirror server test still passes; add an allowed-sites mirror note if cheap.
- Boundary review: no new hooks → the manifest only gains `optionalCalls` entries for EXISTING hooks; no payload field leaks (host/grantedAt/service are generic).

## Out of scope / follow-ups

- Live `proxy:remove-host` (instant revoke of an in-flight session's allowlist) — not built; would be a new security-critical hook. Track as a follow-up if product wants instant live revoke.
- The full browser manual-acceptance walk (connect host in chat → see under Allowed sites → revoke → next turn lacks it) is a `(walk)` card, not this PR.
