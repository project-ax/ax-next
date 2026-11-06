# TASK-887 — Pointing a connector somewhere new signs everyone out of it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a connector's owner edits it so that a stored credential (every agent's OAuth sign-in or key, the shared workspace key, the OAuth client secret) would be bound somewhere it was not bound before, `connectors:upsert` clears those credentials before the edit commits, and the admin editors warn first and ask for the shared key and client secret again in the same save.

**Architecture:** A pure rule in `@ax/connectors` (`pointsSomewhereNew(before, after)`) compares the "reach facts" of the old and new definition. In `connectors:upsert` a new last pre-write gate calls the existing `credentials:purge-account` (agent scope) and `credentials:delete` (global refs). If either throws, the edit is refused with a new code, `connector-sign-out-failed` (503). This is the TASK-758 pattern. `@ax/mcp-oauth`'s callback refuses a sign-in whose connector no longer points at the address the sign-in began for. channel-web keeps a mirrored copy of the rule, pinned by a contract test. Both editors now PATCH before writing secrets on an edit, and they extend the existing address-change warning.

**Tech Stack:** TypeScript, vitest (Postgres testcontainers for `@ax/connectors` hook/route tests), React + shadcn (channel-web), RTL.

**Spec:** board card TASK-887 (quoted in the builder's dispatch) + the **Design** section below (this card has no separate design doc). Parent design: `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md`. Decisions: `.claude/memory/decisions/2026-11-06-TASK-887.md`.

---

## Design (Phases 1–2 output — read before any task)

### The hole, as measured in the code today

- `upsertConnector` (`packages/connectors/src/plugin.ts:636-794`) purges no credential on an edit. Its only pre-write gates are TASK-758's tool-permission reset (`resetMovedEndpoints`, L884-923; kept-name **url** changes only) and TASK-809's ceiling sources (L726-745). The card's "TASK-758 resets permissions on endpoint, allowedHosts or slot changes" is stale: only kept-name url changes reset.
- Where stored credentials go at run time:
  - **Sandbox proxy** (`packages/chat-orchestrator/src/connector-union.ts:902-915`): an OAuth token, or an api-key slot with a `headerName`, is bound to `hostname(url of the server the slot names)`. An api-key slot **without** `headerName` (an env key) is bound to the top-level `allowedHosts`. Server-level `allowedHosts`/`credentials` have no consumer.
  - **Host side:** `@ax/mcp-client` `connector-inventory/connector-headers.ts:80-110` (describe-tools/call-tool) sends the real token or header to the slot's server url. describe-tools checks no allowlist.
  - **OAuth sign-in** (`packages/mcp-oauth/src/routes.ts:608-647, 960-987`): `begin` reads the slot's server url, `authServerUrl`, `clientSecretRef` and top-level `allowedHosts`. The callback posts the client secret to the token endpoint, gated by `allowedHosts`.
  - **Refresh** (`packages/mcp-oauth/src/resolver.ts:186-203`, TASK-696) uses only the token blob's own `tokenEndpoint`/`resource`/client. Editing the connector never moves an existing refresh token or client secret. So `scopes`, `clientId` and `clientRegistration` are not reach.
- `credentials:purge-account {connectorId, scopes:['agent']}` (`packages/credentials/src/plugin.ts:1203-1274`) tombstones every agent's `account:<id>` and `account:<id>:*` row, for every owner. That covers OAuth tokens (kind `mcp-oauth` at `account:<id>`) and per-agent keys alike. `credentials:delete` writes a tombstone even for an absent ref, so it is idempotent (L1026-1045). Both are already in connectors' `optionalCalls` (plugin.ts:222-232). **No manifest edge and no new hook are needed.**

### The rule: what counts as "pointing it somewhere new"

`pointsSomewhereNew(before, after)` is true iff `after` has a **reach fact** `before` lacks. Removing things never counts. Facts are raw-string tuples, and no URL is parsed, so a respelling reads as new. That errs safe: it can over-purge, never under-purge.

1. **One fact per top-level credential slot:** `['slot', slot, ref, kind, address, headerName, authServerUrl, tokenUrl, secretRef]`.
   - `ref` is that slot's `deriveCredentialPlan` ref. It is included because removing one of two env slots collapses the other's ref onto `account:<id>` and an older row.
   - `address` is `[transport, url ?? null]` of the first server named `slot.server`, or `null`. Resolving through the server makes a server rename that keeps its url a non-change.
   - `headerName` is api-key only; `authServerUrl`, `tokenUrl` and `secretRef` are oauth only. Each is `null` where it doesn't apply.
   - `secretRef` is `'own'` when `clientSecretRef` is falsy or equals `account:<id>:OAUTH_CLIENT_SECRET`, else the raw ref. A re-pointed ref could post a header's shared key to a token endpoint.
2. **One fact per server-level slot:** `['server-slot', [server.transport, server.url ?? null], slot, kind, headerName, authServerUrl, tokenUrl, secretRef]`. Dead today, so it costs nothing. Kept so a later consumer can't make one live silently (the TASK-712 precedent).
3. **One fact per top-level allowed host:** `['host', h]`, emitted **only when the side has a top-level env key** (api-key without `headerName`). Only those keys are bound to these hosts. This is why the remote editor's discovered-host merge on a no-op save (`packages/channel-web/src/lib/remote-mcp-form.ts:223-231`) can't sign everyone out.

Each fact is `JSON.stringify` of its tuple.

Consequences (the Task 1 table pins every one):
- These count: a url change, including a path-only change (the same "address" TASK-758 and the editors use), a slot re-pointed at a server with a different url, a `headerName`/kind/AS-pin/foreign-`clientSecretRef` change, a slot added or renamed, a host added to an env-key connector.
- These don't: scopes, clientId, clientRegistration, packages, services, display fields, a server added that no slot names, any removal except a ref collapse, a host added to an OAuth/header-only connector.

### What a retarget clears, and when

- **What:** every agent's rows, via `credentials:purge-account {connectorId, scopes:['agent']}`. Plus these global refs via `credentials:delete {scope:'global', ownerId:null, ref}`:
  - the `deriveCredentialPlan` refs with scope `global`, from **before ∪ after**, deduped;
  - `account:<id>:OAUTH_CLIENT_SECRET`, when either side has a top-level oauth slot.

  This is one rule: "signs everyone out, clears its shared key and client secret". It mirrors the delete purge (`packages/connectors/src/purge.ts:79-150`), minus the announcement.
- **When:** in `upsertConnector`, only when `prior !== null`, as the **last** gate. That is after TASK-758's reset and TASK-809's pre-write ceiling sources, right before `store.upsert`. An earlier gate failing therefore never signs anyone out for nothing.
- **Fail direction:** a throw refuses the edit (`connector-sign-out-failed` → 503), and the old row stands.
  - If the purge lands and the write then fails, agents are signed out of an unchanged connector. That costs UX, not a leak. Save retries, the rule fires again, and the purge is idempotent.
  - A post-commit purge would leave the leak live until a retry. A retry of the same address would detect nothing (the TASK-758 lesson).
- **No authority flag.** The purge is the consequence of the retarget. A flag would let a caller retarget *without* it.
- Cross-owner PATCHes write the stored capabilities (`admin-routes.ts:754-784`), so they can never retarget. The `owner-only-change` 403 stays as is.

### The in-flight sign-in

A popup opened before the retarget can finish within the 10-minute pending window. It would write a token minted for the **old** resource after the purge, and the runtime would send it to the new url. `@ax/mcp-oauth`'s callback already re-reads the connector (routes.ts:955-986). Task 3 makes it refuse when the oauth slot's server url ≠ `pending.resource`.

### Editors

- **Both editors, on an EDIT:**
  - Write the connector (PATCH) **first**, then its secrets. The client-secret ref is deterministic (`refForDestination({kind:'account', service:id, slot:OAUTH_CLIENT_SECRET_SLOT})`), so the PATCH can name it before the write.
  - Today both write secrets first. That would make the server's purge wipe a key typed in the same save, and it lets a refused PATCH (403/503) still overwrite the live key. (R pin: `RemoteMcpConnectorForm.test.tsx:1568-1571`; L: `LegacyConnectorEditDialog.tsx:595-598` "M3".)
  - Creates are unchanged.
- **RemoteMcpConnectorForm (R):**
  - Extend the existing `address-change-resets-tools` Alert (R:659-670).
  - On a retarget, saved shared header values and a saved custom-client secret must be typed again in the same save.
  - Delete the "Send saved headers to {host}" confirmation (R:183, 197-202, 348, 450-451, 1112-1140). It confirmed sending saved keys to a new host, which no longer happens.
- **LegacyConnectorEditDialog (L):** opens only for connectors with no MCP server (`ConnectorEditDialog.tsx:101-104`). Its TASK-758 Alert sits inside the `mechanism === 'mcp'` block (L:832-841) and so never shows in the product. Move it below the per-mechanism fields and extend it. L has no shared-key field, so it can only say the key is cleared (follow-up 2).
- **Dev mock** (`packages/channel-web/mock/admin/connectors.ts`): unchanged. It has no credential routes or store, so there is nothing to purge or re-enter.

### Boundary review (paste into the PR)

- **Changed:** `connectors:upsert` gains a side effect (purges through existing hooks) and a new error code, `connector-sign-out-failed`. There are no payload field changes and no new, renamed or removed hooks. So there are **no exact-list pins** to update (`presets/k8s/.../preset.test.ts`, mcp-oauth `e2e.test.ts` `captureRouteServices`/`plugin.test.ts` untouched).
- **Alternate impl:** a connector store that binds credentials to an endpoint fingerprint, so the purge becomes a no-op; or a vault that deletes by tag.
- **Leaky names:** none (`connector-sign-out-failed` names the outcome).
- **Subscriber risk:** N/A (service hook; the code is a fixed string).
- **Wire:** the admin route answers `503 {error:'connector-sign-out-failed'}`. Not an IPC action.

### Security (run `security-checklist` — required)

- **Sandbox/capability:** narrows reach. A retarget can no longer carry a credential to a host the stored value was not bound to. The purge uses only the existing agent-scope hook (global is still refused there) and per-ref global deletes.
- **Injection/untrusted:** the OAuth callback (browser-delivered state/code) gains a refusal. Connector text renders as text, unchanged.
- **Supply chain:** N/A (no dependency).
- **Accepted residuals (sub-second races, follow-up 5):** an agent key or sign-in written between the pre-write purge and the commit; a callback whose address check passes while its token exchange overlaps the commit.
- **Warm sessions** keep their spawn-time bindings (old hosts only) until retired on the next turn (`orchestrator.ts:2793-2830`). They never reach the new host.

### Delete-and-recreate gap (card's "related interim gap")

**Closed.** The admin DELETE always passes `purgeGlobal: true` (`admin-routes.ts:832`). So agent sign-ins, the global key and the client secret are purged (`plugin.ts:1003-1007`, `purge.ts`), even while a same-id copy survives (SIGNINS-9). `connectors:deleted {idStillLive:false}` detaches every agent (`agents/src/connector-cleanup.ts:43-62`) and drops mcp-oauth markers. `POST /admin/connectors` is create-only.

Residual (follow-up 1): the delete purge is best-effort *after* the soft-delete. A credential-store failure during a delete leaves keys that a same-id recreate could read.

### Follow-ups (not this card — report them, don't build them)

1. Admin delete: purge before tombstoning, all or nothing, like the boot sweep (`non-admin-sweep.ts`).
2. L has no shared-key field. A no-server workspace connector's key can't be entered, or re-entered after a retarget, from Admin › Connectors.
3. R infers "Saved securely" for shared header keys from the definition (`remote-mcp-form.ts:62-66`) and never checks the vault. After a purge by another path it claims a key that's gone.
4. `clientSecretRef` may name any `account:<id>:<tag>`, including a header slot's shared key (TASK-712 rule). Consider pinning the tag to `OAUTH_CLIENT_SECRET`.
5. The sub-second residuals above: a post-commit repeat purge, plus a check-after-write in the callback.
6. A needs-reconnect marker left from before the retarget makes that agent's row say "Sign in again". The chat's skipped notice lists only "not set up" rows (`SkippedConnectorsNotice.tsx:137`). This quirk predates the card.

Card wording vs reality: after a purge, rows show **"Sign in"** ("Not signed in yet"; SIGNINS-5 labels), or **"Add key"** for per-agent keys. They show "Sign in again" only where a needs-reconnect marker already existed. This is accepted; making every row say "Sign in again" would need a new mcp-oauth hook for one label.

---

## Global Constraints

- Invariant 2: no cross-plugin runtime import. channel-web's rule is a **copy**. Only a `__tests__` file may import `@ax/connectors`.
- Invariant 6: compose existing shadcn primitives only (`Alert` with `role="note"`, `Field`/`FieldError`/`FieldDescription`, `Input`, `Button`) and semantic tokens. No new components, no raw colors.
- UI copy is **verbatim** as written in Tasks 4–6 (curly `’`, like the surrounding strings).
- Never log a secret value; refs and counts are fine.
- Provider credentials stay API-key-only (standing user rule). This card adds no credential entry surface; it only re-asks for the existing shared-key and client-secret fields.
- Commands:
  - Use `pnpm --filter <pkg> test`, with the filter before the script.
  - Docker-backed suites (`@ax/connectors`, `@ax/mcp-oauth` e2e) need an explicit `DOCKER_HOST`; set `AX_TESTCONTAINER_START_SLOT_WAIT_MS=120000`.
  - Run `tsc` alongside vitest (`pnpm --filter <pkg> build`). channel-web's tsc type-checks test files.
  - Build `@ax/connectors` before channel-web tests that import it (`pnpm --filter @ax/connectors build`).
- No fixed-iteration polling in tests. Use RTL `waitFor`/`findBy*` (or `vi.waitFor`); the `pnpm test:scripts` guard enforces it.
- Final gate: `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.

## Review Focus

1. **A remote connector re-saved unchanged after discovery returns a sign-in host it didn't store** (OAuth or header only) must not warn and must not sign anyone out. → Task 1 table row "host added to an OAuth-only connector", Task 5 test `no-op save with newly discovered hosts`.
2. **A save where the PATCH lands but the re-entered key or secret write fails** must say the connector saved, keep the typed values, and write them on the next Save. The server must not purge again for nothing on the retry, because its row already has the new address. → Task 5 test `partial save`.
3. **A sign-in popup left open across the retarget** must be refused at the callback, with nothing written. → Task 3.
4. **Remove on a saved client secret during a retarget** must lift the re-entry requirement and save without a secret. → Task 5 test `Remove lifts the client-secret requirement`.
5. **Removing one of two env-key slots** (ref collapse onto `account:<id>`) counts as a retarget. → Task 1 table.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/connectors/src/retarget.ts` (new) | the pure rule `pointsSomewhereNew` | 1 |
| `packages/connectors/src/__tests__/retarget.test.ts` (new) | table test, no Docker | 1 |
| `packages/connectors/src/index.ts` | export the rule + type | 1 |
| `packages/chat-orchestrator/src/connector-union.ts:902` | one cross-reference comment | 1 |
| `packages/core/src/error-codes.ts`, `__tests__/error-codes.test.ts` | `CONNECTOR_SIGN_OUT_FAILED` + pin; stale "chat grant route" line | 2 |
| `packages/connectors/src/plugin.ts` | `signOutBeforeRetarget` + gate; manifest degradation text | 2 |
| `packages/connectors/src/admin-routes.ts` | 503 mapping; stale comment L393-413 | 2 |
| `packages/connectors/src/__tests__/hooks.test.ts`, `admin-routes.test.ts`, `plugin.test.ts` | gate tests; route 503; manifest pin; stale comment L681-682 | 2 |
| `packages/mcp-oauth/src/routes.ts`, `__tests__/routes.test.ts` | callback address check | 3 |
| `packages/channel-web/src/lib/connector-form.ts`, `lib/connectors.ts`, `lib/__tests__/connector-form.test.ts`, `src/__tests__/connector-retarget-contract.test.ts` (new) | client mirror, client error constants, contract | 4 |
| `packages/channel-web/src/lib/remote-mcp-form.ts`, `components/settings/RemoteMcpConnectorForm.tsx`, tests | R | 5 |
| `packages/channel-web/src/components/settings/LegacyConnectorEditDialog.tsx`, tests | L | 6 |

Order: 1 → 2 → 4 → (5 ∥ 6). Task 3 is independent.

---

### Task 1: The retarget rule `[tier: sensitive]`

Needs `security-checklist` (it decides when credentials are cleared).

**Files:**
- Create: `packages/connectors/src/retarget.ts`
- Create: `packages/connectors/src/__tests__/retarget.test.ts`
- Modify: `packages/connectors/src/index.ts` (add exports)
- Modify: `packages/chat-orchestrator/src/connector-union.ts:902-903` (comment only)

**Interfaces:**
- Produces:
  - `export interface RetargetSubject { id: string; keyMode: KeyMode; capabilities: Pick<Capabilities, 'allowedHosts' | 'credentials' | 'mcpServers'> }`
  - `export function pointsSomewhereNew(before: RetargetSubject, after: RetargetSubject): boolean`
  - Both are exported from `@ax/connectors`.

- [ ] **Step 1: Write the failing table test** `retarget.test.ts` (pure, no harness). The fixtures are full `Capabilities` literals (with `packages`/`services`), including:
  - `linear`: personal OAuth; server `linear` at `https://mcp.linear.app/mcp`; oauth slot `MCP_OAUTH` with `server:'linear'`, `clientId:'cid'` and `clientSecretRef:'account:linear:OAUTH_CLIENT_SECRET'`; `allowedHosts:['mcp.linear.app']`.
  - `crm`: workspace; server `crm` at `https://mcp.crm.example/mcp`; header slot `HEADER_1` with `headerName:'X-Api-Key'` and `server:'crm'`.
  - `sf`: personal CLI; no servers; env slot `sf`; `allowedHosts:['login.salesforce.com']`.

  Run them through `it.each` as `[name, before, after, expected]`:

  | case | expected |
  |---|---|
  | identical | false |
  | linear url → `https://elsewhere.example/mcp` (kept name) | true |
  | linear url path only → `https://mcp.linear.app/v2/mcp` | true |
  | linear server renamed `linear2`, slot `server` follows, same url | false |
  | linear: second server added at a new url, no slot names it | false |
  | linear: server and its slot removed | false |
  | two servers; oauth slot re-pointed to the one with a different url | true |
  | two servers with the same url; oauth slot re-pointed between them | false |
  | linear `authServerUrl` added / `tokenUrl` changed | true / true |
  | linear `clientSecretRef` removed (canonical → absent) | false |
  | linear `clientSecretRef` → `account:linear:HEADER_1` | true |
  | linear `scopes` / `clientId` / `clientRegistration` changed | false |
  | linear `allowedHosts` gains `auth.linear.app` (OAuth-only connector) | false |
  | crm `headerName` → `Authorization` | true |
  | crm header slot added / removed | true / false |
  | crm header slot re-pointed to a second server with another url | true |
  | slot kind oauth → api-key, same slot name | true |
  | sf host added / removed | true / false |
  | sf package added; sf `services` added | false |
  | sf with two env slots → one removed (ref collapses to `account:sf`) | true |
  | no-credential connector url changed | false |
  | server-level slot added / server-level host added | true / false |

- [ ] **Step 2: Run it and see it fail** — `pnpm --filter @ax/connectors exec vitest run src/__tests__/retarget.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `retarget.ts`.
  - It has one internal `reachFacts(c: RetargetSubject): Set<string>` that builds exactly the three fact kinds in Design › The rule (same tuple order and the same `null`s), using `deriveCredentialPlan` (`./credential-plan.js`) for refs and `oauthClientSecretRefFor` (`./oauth-client-secret-ref.js`) for `'own'`.
  - `pointsSomewhereNew` returns whether any fact of `after` is missing from `before`.
  - The file comment must:
    - name the runtime sites it mirrors (connector-union.ts:902-915, connector-headers.ts:80-110, mcp-oauth routes.ts:608-647/987);
    - name why refresh-only fields are excluded (resolver.ts:186-203);
    - say the channel-web copy lives in `lib/connector-form.ts`, with the contract `__tests__/connector-retarget-contract.test.ts`.
- [ ] **Step 4: Add the exports** to `index.ts`, and add the comment at `connector-union.ts:902`: "TASK-887: @ax/connectors `retarget.ts` mirrors this binding to decide when an edit must sign agents out — change one, change the other."
- [ ] **Step 5: Run it and see it pass** — the same command → PASS. Then `pnpm --filter @ax/connectors build` → exit 0.
- [ ] **Step 6: Commit** `[TASK-887] connectors: pointsSomewhereNew — when an edit binds a stored credential somewhere new`.

### Task 2: Sign everyone out before the edit commits `[tier: sensitive]`

Needs `security-checklist` (credential purge at a write gate).

**Files:**
- Modify: `packages/core/src/error-codes.ts`, `packages/core/src/__tests__/error-codes.test.ts`
- Modify: `packages/connectors/src/plugin.ts`:
  - imports;
  - new fn next to `resetMovedEndpoints` (~L861);
  - the gate between the TASK-809 pre-write block (ends L745) and `store.upsert` (L746);
  - manifest `optionalCalls` L223-232.
- Modify: `packages/connectors/src/admin-routes.ts`: `handleHookError` L171-212, and the `changesOwnerOnlyFields` doc L393-413.
- Test: `packages/connectors/src/__tests__/hooks.test.ts` (new describe after the TASK-758 describe that ends ~L1172), `admin-routes.test.ts`, `plugin.test.ts:51-56`.

**Interfaces:**
- Consumes: `pointsSomewhereNew`, `RetargetSubject` (Task 1).
- Produces: `export const CONNECTOR_SIGN_OUT_FAILED = 'connector-sign-out-failed'` in `@ax/core/error-codes`. The route answers `503 {error:'connector-sign-out-failed'}`.

- [ ] **Step 1: Failing tests.**
  - **`error-codes.test.ts`:** pin `CONNECTOR_SIGN_OUT_FAILED` to `'connector-sign-out-failed'`.
  - **`hooks.test.ts`:** `describe('an edit that points a connector somewhere new signs everyone out first (TASK-887)')`. Its harness records every `credentials:purge-account` and `credentials:delete` input, each with the row's stored url at call time (like L1104-1122):
    - `an OAuth server moving purges every agent's sign-ins and the client secret, before the row changes` — the purge calls equal `[{connectorId:'linear', scopes:['agent']}]`; the delete calls equal `[{scope:'global', ownerId:null, ref:'account:linear:OAUTH_CLIENT_SECRET'}]`; the url at call time is OLD; the saved url is NEW.
    - `a shared-key connector moving clears its shared key` — workspace header connector, url change; the delete refs equal `['account:crm:HEADER_1']`. A header slot renamed in the same edit deletes both the old and the new ref.
    - `a CLI connector gaining a site signs everyone out; losing one does not`.
    - `edits that point nowhere new clear nothing` — a description edit, a scopes change, a host added to an OAuth-only connector, a server rename keeping its url. No call at all.
    - `a failed sign-out refuses the edit with connector-sign-out-failed and writes nothing` — once with purge-account throwing and once with delete throwing. It rejects `{code:'connector-sign-out-failed'}`, the saved url stays OLD, and no `connectors:tool-namespaces-changed` event fires.
    - `with no credentials provider loaded the edit saves (nothing is stored)` — use `makeHarness()`.
    - `a create never clears anything`.
    - `the sign-out is the last gate: a failed ceiling-sources call signs nobody out` — header-key (API-key) server; `tool-policy:set-ceiling-sources` throws; rejects `tool-permissions-reset-failed`; zero purge calls.
  - **`admin-routes.test.ts`:** `PATCH that points a connector somewhere new answers 503 connector-sign-out-failed when the sign-out fails, and nothing changes`. The harness is a variant of `makeHarness()` (L121) with a throwing `'credentials:purge-account'` service.
  - **`plugin.test.ts:51-56`:** the new degradation strings (Step 3).
- [ ] **Step 2: Run them and see them fail** — `pnpm --filter @ax/connectors test` (Docker) and `pnpm --filter @ax/core test`.
- [ ] **Step 3: Implement.**
  - **`error-codes.ts`:** add `CONNECTOR_SIGN_OUT_FAILED` with a doc comment in the sibling's style. In `TOOL_PERMISSIONS_RESET_FAILED`'s doc, change "The connector routes (and the chat grant route) answer it" to "The connector routes answer it". The chat grant route was removed in slice 2c; only the connector routes and editors use the code.
  - **`plugin.ts`:** add `async function signOutBeforeRetarget(bus, ctx, before: Connector, after: RetargetSubject, hookName: string): Promise<void>`. It runs the purge set from Design › What a retarget clears:
    - Each call is guarded by `bus.hasService` (absent ⇒ nothing stored).
    - On a throw: `ctx.logger.error('connectors_retarget_sign_out_failed', {connectorId, step, err: message})`, then throw `PluginError({code: CONNECTOR_SIGN_OUT_FAILED, plugin, hookName, message: "couldn't sign everyone out of this connector before pointing it somewhere new, so the edit was not saved", cause})`.
    - On success: `ctx.logger.info('connectors_retarget_signed_out', {connectorId, purged, globalRefs})`.
    - The gate: `if (prior !== null && pointsSomewhereNew(prior, {id: connectorId, keyMode, capabilities})) await signOutBeforeRetarget(…)`. Comment the ordering, fail direction and no-flag rationale (Design).
  - **Manifest degradations:**
    - `credentials:delete` → `'the connector is deleted or pointed somewhere new but its stored key is left in the vault (no @ax/credentials provider to purge it)'`
    - `credentials:purge-account` → `"the connector is deleted or pointed somewhere new but agents' sign-ins for it are left in the vault (a later same-id connector, or the new address, could receive them)"`
  - **`admin-routes.ts`:** map the code to 503 beside `TOOL_PERMISSIONS_RESET_FAILED`, and list it in the doc comment.
  - **Stale line fix (rule 5)**, `admin-routes.ts:397-401`: replace "an endpoint change would hand every agent's stored sign-ins and the shared key to the new host through the credential proxy (only tool permissions are reset on a move — TASK-758)" with "pointing a connector somewhere new signs every agent out of it and clears its shared key and client secret (TASK-887) — the owner's call, not another admin's".
  - **Stale line fix**, `admin-routes.test.ts:681-682`: replace "would send every agent's stored sign-ins and the shared key somewhere new" with "signs every agent out and clears the shared key (TASK-887), which is the owner's call".
- [ ] **Step 4: Run them and see them pass** — the same commands → PASS. Then `pnpm --filter @ax/connectors build && pnpm --filter @ax/core build` → exit 0.
- [ ] **Step 5: Commit** `[TASK-887] connectors:upsert signs everyone out and clears the shared key before an edit points a connector somewhere new`.

### Task 3: The OAuth callback refuses a sign-in begun for the old address `[tier: sensitive]`

Needs `security-checklist` (OAuth callback = untrusted browser input).

**Files:**
- Modify: `packages/mcp-oauth/src/routes.ts`, the callback right after the connector re-read (~L955-986)
- Test: `packages/mcp-oauth/src/__tests__/routes.test.ts` (callback describe, beside `the connector vanished mid-flow` ~L3110)

- [ ] **Step 1: Failing tests**, modeled on L3110-3123 (`run({stubs:{'connectors:get': …}})`):
  - `TASK-887. the connector now points its OAuth server somewhere else (changed mid-flow) → reason=sign-in-failed; nothing written` — `connectors:get` returns the default connector with the oauth slot's server url changed. Assert: the redirect contains `oauth=error&reason=sign-in-failed`; `setSpy` and `attachSpy` are not called; `logger.warn` is called with `('mcp_oauth_callback_failed', objectContaining({stage:'connector-changed', connectorId:'conn-1'}))`; `logger.error` is not called. If the harness exposes the token exchange, also assert it was not called.
  - `TASK-887. the oauth slot was removed mid-flow → refused the same way`.
- [ ] **Step 2: Run them and see them fail** — `pnpm --filter @ax/mcp-oauth exec vitest run src/__tests__/routes.test.ts`.
- [ ] **Step 3: Implement.** After `connector` is read, and before the client lookup, discovery, exchange, vault write and attach, derive the address the connector's oauth slot names now, the way `begin` does (L609-646): the first oauth slot, then the server with `name === slot.server`, then its `url`. If that isn't exactly `pending.resource`, log `warn('mcp_oauth_callback_failed', {stage:'connector-changed', connectorId})`, `fail('sign-in-failed')` and return. Comment: TASK-887 — a sign-in belongs to the address it began for. A retarget while the popup was open signed every agent out, and a token minted for the old address must not land now. Mirrors `begin`'s derivation; keep the two in step.
- [ ] **Step 4: Run them and see them pass** — the same command, then the full `pnpm --filter @ax/mcp-oauth test`. Existing happy paths must still pass. If one fails, its stub connector's url didn't equal its pending `resource`: align the fixture, not the check.
- [ ] **Step 5: Commit** `[TASK-887] mcp-oauth: a sign-in begun for a connector's old address is refused at the callback`.

### Task 4: The client copy of the rule, its contract, and the new error copy `[tier: integration]`

**Files:**
- Modify: `packages/channel-web/src/lib/connector-form.ts` (next to `endpointChangedServers`, ~L286-315)
- Modify: `packages/channel-web/src/lib/connectors.ts`: widen `deriveCredentialPlan`'s parameter (L610) to `Pick<Connector, 'id' | 'keyMode' | 'capabilities'>` (no behavior change); add the error constants next to `TOOL_PERMISSIONS_RESET_FAILED` (L220-237).
- Test: `packages/channel-web/src/lib/__tests__/connector-form.test.ts`; create `packages/channel-web/src/__tests__/connector-retarget-contract.test.ts`.

**Interfaces:**
- Consumes: `pointsSomewhereNew` and `CapabilitiesSchema` from `@ax/connectors` (test only); `CONNECTOR_SIGN_OUT_FAILED` from `@ax/core/error-codes`.
- Produces, from `lib/connector-form.ts`: `export function pointsSomewhereNew(before: Pick<Connector,'id'|'keyMode'|'capabilities'>, after: Pick<Connector,'id'|'keyMode'|'capabilities'>): boolean`.
- Produces, from `lib/connectors.ts`:
  - re-export `CONNECTOR_SIGN_OUT_FAILED`;
  - `export const CONNECTOR_SIGN_OUT_FAILED_MESSAGE = 'We couldn’t sign everyone out of this connector, so we didn’t save your changes. Your saved settings are unchanged. Try saving again in a moment.'`;
  - `export function isConnectorSignOutFailure(err: unknown): boolean` — `err instanceof Error && err.message === CONNECTOR_SIGN_OUT_FAILED`.

- [ ] **Step 1: Failing tests.**
  - **Contract** `connector-retarget-contract.test.ts`: the Task 1 table, copied. Every capabilities literal goes through `CapabilitiesSchema.parse` first, as in `connector-credential-refs-contract.test.ts`. For every row, assert that the client result equals the server result equals `expected`. Import the server's function as `serverPointsSomewhereNew`.
  - **`connector-form.test.ts`:** pin the client `CONNECTOR_SIGN_OUT_FAILED` to the literal `'connector-sign-out-failed'`. This is the sibling of the TASK-758 pin, so drift can't fall back to the generic copy.
- [ ] **Step 2: Run them and see them fail** — `pnpm --filter @ax/connectors build && pnpm --filter @ax/channel-web exec vitest run src/__tests__/connector-retarget-contract.test.ts src/lib/__tests__/connector-form.test.ts`.
- [ ] **Step 3: Implement** the client copy: the same three fact kinds and the same tuples, using the local `deriveCredentialPlan` and `OAUTH_CLIENT_SECRET_SLOT`. Add a header comment naming the server original and the contract test. Add the constants.
- [ ] **Step 4: Run them and see them pass** — the same command → PASS. Then `pnpm --filter @ax/channel-web build` → exit 0 (tsc includes tests).
- [ ] **Step 5: Commit** `[TASK-887] channel-web: mirror pointsSomewhereNew under a contract test; sign-out failure copy`.

### Task 5: RemoteMcpConnectorForm warns, asks for secrets again, and saves the connector first `[tier: sensitive]`

Sensitive for hard-to-reverse state, not reach: the server enforces the boundary. If the order is wrong (a secret written before the PATCH on an edit), the server's purge silently wipes a shared key the admin just typed, and the admin may not have it any more. This task also removes the "Send saved headers to {host}" confirmation. That removal is safe **only** with Task 2 in place, so the PR's security note must mention it.

**Files:**
- Modify: `packages/channel-web/src/lib/remote-mcp-form.ts`: `remoteErrors` (L127-168) gains `options: { reenterSavedValues?: boolean } = {}`.
- Modify: `packages/channel-web/src/components/settings/RemoteMcpConnectorForm.tsx`
- Test: create `packages/channel-web/src/components/settings/__tests__/RemoteMcpConnectorForm.retarget.test.tsx`. Use a self-contained `fetch` router like `RemoteMcpConnectorForm.test.tsx:101-148`, recording non-GET calls in order, and render through `ConnectorEditDialog` as `openEditor` (:163-171) does. A new file keeps sibling cards' edits apart (TASK-758 precedent).
- Modify: `RemoteMcpConnectorForm.test.tsx`:
  - the order pin at L1568-1571 becomes `['PATCH /admin/connectors/linear','POST /admin/destinations/account/credential']`;
  - delete or replace the tests for the removed "Send saved headers to" confirmation (grep `Send saved headers to`, `Confirm the destination`).

**Interfaces:**
- Consumes: `pointsSomewhereNew` (Task 4, `lib/connector-form`); `CONNECTOR_SIGN_OUT_FAILED_MESSAGE`, `isConnectorSignOutFailure` (Task 4, `lib/connectors`).

- [ ] **Step 1: Failing tests** in the new file:
  - `moving an OAuth connector says it signs everyone out and each agent signs in again` — the Alert `address-change-resets-tools` contains "Changing where this connector points signs everyone out of it." and "Each agent signs in again from its Connectors tab.", and still contains the existing tool-permissions sentence.
  - `moving a shared-key connector asks for its saved header values again` — the saved header shows a value input, not "Saved securely". Save with it blank shows "Enter this value again. Changing where this connector points cleared it." and sends nothing.
  - `a retarget save writes the connector first, then the re-entered key and client secret` — the calls are in order: PATCH, then the credential POSTs.
  - `Remove lifts the client-secret requirement on a retarget` — custom client with a saved secret, url changed. The secret is required with "Enter the client secret again, or remove it. Changing where this connector points cleared it."; after Remove, Save PATCHes with no `clientSecretRef` and writes no secret.
  - `a refused PATCH (503 connector-sign-out-failed) shows its message and writes no secret` — exactly one call (the PATCH); the CONNECTOR_SIGN_OUT_FAILED_MESSAGE text is visible.
  - `partial save: a key write that fails after the PATCH says so, stays open, and Save writes it` — the first credential POST answers 500. Text: "We saved the connector, but couldn’t save the key. Try saving again." The typed value is kept, and a second Save issues PATCH + POST.
  - `no-op save with newly discovered hosts does not warn` — discovery answers an extra AS host for the saved url (OAuth connector); no sign-out sentence.
  - `a plain no-op save does not warn`.
- [ ] **Step 2: Run them and see them fail** — `pnpm --filter @ax/channel-web exec vitest run src/components/settings/__tests__/RemoteMcpConnectorForm.retarget.test.tsx`.
- [ ] **Step 3: Implement** in R.
  - `retargeted` = an existing `connector` and `pointsSomewhereNew(connector, {...connector, capabilities: remoteCapabilities(effectiveDraft, connector.id, connector, discovered?.hosts ?? [])})` (the same capabilities Save sends).
  - `reenterKeys` = `retargeted && keyMode === 'workspace'`.
  - `reenterSecret` = `retargeted && signIn === 'oauth' && registration === 'custom' && draft.clientSecretRef !== ''`.
  - **Validation:** `remoteErrors(…, { reenterSavedValues: reenterKeys })` gives a saved header with no value the re-entry message above. In `submit`, `reenterSecret && !draft.clientSecret.trim()` sets `errors.clientSecret` to the secret message.
  - **Rendering:** `reenterKeys` shows saved headers' value inputs. `reenterSecret` shows the secret input, plus the existing Remove button as a ghost button beside it.
  - **Alert:** render when `addressChanged || retargeted`, with up to two paragraphs.
    - P1, when `retargeted`: "Changing where this connector points signs everyone out of it." followed by exactly one of:
      - "Each agent signs in again from its Connectors tab." (`signIn === 'oauth'`)
      - "Each agent adds its key again from its Connectors tab." (personal)
      - "It also clears the shared key, so enter it again below." (workspace)

      Then "It also clears the client secret, so enter it again below." when `reenterSecret`.
    - P2, when `addressChanged`: the existing sentence verbatim.
  - **Delete** the destination confirmation (state, effect reset, validation, JSX).
  - **Save, edit path only:**
    1. If `writesClientSecret`, compute `clientSecretRef = refForDestination(destination)` first.
    2. `patchConnector`, then `update('clientSecretRef', clientSecretRef)`.
    3. Write the client secret. On failure: "We saved the connector, but couldn’t save the client secret. Try saving again."
    4. Write the workspace header values. On failure: "We saved the connector, but couldn’t save the key. Try saving again."
    5. Tool permissions, as today.

    Each failure stays open and keeps the draft, like the tool-permissions branch at L536-546. **The create path is unchanged.**
  - The error chain checks `isConnectorSignOutFailure` first.
- [ ] **Step 4: Run them and see them pass** — the new file plus the full `RemoteMcpConnectorForm*.test.tsx` set, then `pnpm --filter @ax/channel-web build`.
- [ ] **Step 5: Commit** `[TASK-887] Remote connector editor: warn that moving signs everyone out, ask for the shared key and client secret again, save the connector first`.

### Task 6: LegacyConnectorEditDialog warns and saves the connector first `[tier: integration]`

**Files:**
- Modify: `packages/channel-web/src/components/settings/LegacyConnectorEditDialog.tsx`: save flow L585-673, Alert L832-841, M3 comment L595-598.
- Test: create `packages/channel-web/src/components/settings/__tests__/LegacyConnectorEditDialog.retarget.test.tsx`, patterned on `LegacyConnectorEditDialog.endpoint-reset.test.tsx` (`vi.spyOn` on the connectors lib, :63-71). It renders a CLI connector (`sf`-shaped, env slot, keyMode personal) and a workspace variant.

**Interfaces:**
- Consumes: as in Task 5.

- [ ] **Step 1: Failing tests:**
  - `adding a site to a CLI connector says it signs everyone out` — the Alert `endpoint-change-resets-tools` shows "Changing where this connector points signs everyone out of it." and "Each agent adds its key again from its Connectors tab."
  - `the workspace variant says the shared key is cleared` — "It also clears the shared key."
  - `removing a site or editing the description does not warn`.
  - `a 503 connector-sign-out-failed shows its message`.
  - `an edit writes the connector before the client secret` — `patchConnector` is called before `setDestinationCredential`.
- [ ] **Step 2: Run them and see them fail** — `pnpm --filter @ax/channel-web exec vitest run src/components/settings/__tests__/LegacyConnectorEditDialog.retarget.test.tsx`.
- [ ] **Step 3: Implement.**
  - `retargeted` = `target !== 'new' && pointsSomewhereNew({id: form.connectorId, keyMode: form.keyMode, capabilities: form.baseCapabilities}, {id: form.connectorId, keyMode: form.keyMode, capabilities: capabilitiesFromForm(form)})`.
  - Move the Alert below the per-mechanism fields and render it when `endpointChanged || retargeted`.
    - P1, when `retargeted`: "Changing where this connector points signs everyone out of it." followed by exactly one of:
      - "Each agent signs in again from its Connectors tab." (any top-level oauth slot after)
      - "Each agent adds its key again from its Connectors tab." (personal)
      - "It also clears the shared key." (workspace)
    - P2, when `endpointChanged`: the existing sentence verbatim.
  - **Edit path:** compute the `clientSecretRef` patches deterministically (no write), build the capabilities, PATCH, then write the typed client secrets. On failure: "We saved the connector, but couldn’t save the client secret. Try saving again." Rewrite the M3 comment: edits write the connector first (TASK-887: the server may clear the secret inside the PATCH, and a refused PATCH must write nothing); a create still writes the secret first.
  - Map `isConnectorSignOutFailure` → `CONNECTOR_SIGN_OUT_FAILED_MESSAGE`.
- [ ] **Step 4: Run them and see them pass** — the new file plus `LegacyConnectorEditDialog*.test.tsx` and `ConnectorEditDialog.test.tsx`, then `pnpm --filter @ax/channel-web build`.
- [ ] **Step 5: Commit** `[TASK-887] Legacy connector editor: warn that adding a site signs everyone out; save the connector before its secret`.

---

## PR checklist (builder)

- Boundary review and security note from the Design section are in the PR body.
- Stale lines fixed in this diff:
  - `packages/connectors/src/admin-routes.ts:397-401`
  - `packages/connectors/src/__tests__/admin-routes.test.ts:681-682`
  - `packages/core/src/error-codes.ts`, the "chat grant route" line
- Follow-ups 1–6 are listed as follow-ups, not built.
