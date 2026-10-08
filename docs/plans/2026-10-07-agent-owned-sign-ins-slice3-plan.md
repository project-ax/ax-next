# Agent-owned sign-ins — Slice 3 (agent-owned sign-in + all-or-nothing Add) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Every sign-in is stored on the **agent**, never on the person.
- Adding a connector to an agent is one step that either fully happens or leaves nothing:
  - **OAuth:** the popup opens directly, and the callback writes the token and attaches the connector.
  - **Per-agent API key:** the key form saves the key and attaches the connector in one request.
  - **Shared key or no auth:** the connector is added immediately.
- The rail row menu becomes **Edit / Remove**, plus **Sign in again** (or **Add key**) only on a row that needs it.
- Every no-agent sign-in path and `signOutIfUnused` are deleted.

**Architecture:**
- **mcp-oauth `begin`**
  - It requires `agentId` and a `mode` (`'add' | 'sign-in-again'`), and always writes at agent scope.
  - The authorize URL always carries `prompt=select_account` (`select_account consent` for Google).
- **mcp-oauth `callback`**
  - It re-checks the agent gate, writes the token at agent scope, and for `mode:'add'` calls `agents:attach-connector`.
  - If the attach fails, it deletes the token and redirects with a fixed `reason`.
- **channel-web server**
  - `POST /api/workspace/agents/:id/connectors` takes optional `keys`, writes them at agent scope, then attaches, deleting the keys if the attach fails.
  - Remove deletes the agent's own sign-in and keys.
- **channel-web client**
  - The Add subview and rail menu drive these routes.
  - The popup bridge forwards the reason.

**Tech Stack:** TypeScript, vitest, Kysely/Postgres (testcontainers), React + shadcn (channel-web).

**Spec:** `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md`: §2 (sign-in flow, minus identity capture, which is slice 4), §3 (all-or-nothing Add), "Agent rail › Connectors", and Slices › 3. **Prereqs:** slices 1, 2a, 2b and 2c (this branch stacks on `feat/agent-owned-sign-ins-2c`).

## Global Constraints

- No cross-plugin imports (invariant 2). Inter-plugin calls go through the hook bus and are declared in the manifest. mcp-oauth calling `agents:attach-connector` creates no cycle: nothing that agents calls reaches mcp-oauth. Verify with the preset bootstrap test.
- **No half-wired code (invariant 3).** Every route, hook, type, `optionalCalls` entry, client helper, component, menu item and test that the old flow used and nothing uses any more is deleted in the task that stops using it.
- UI uses shadcn and semantic tokens only (invariant 6). Invoke the `shadcn` skill before UI work. Copy is plain, short and warm (CLAUDE.md voice).
- Payload names stay storage-agnostic. `mode` and `reason` are product words.
- **Lookup is NOT flipped in this slice.** User-scope `account:` rows are still read (user → agent → global) until slice 5. Tests that assert person-level rows are *read* stay. Tests that assert a sign-in or key is *written* at user scope are rewritten to agent scope.
- **The `keyMode` stored values stay `personal` / `workspace`** (the 2a ruling). `personal` means "each agent adds its own key".
- `export DOCKER_HOST=unix:///var/run/docker.sock AX_TESTCONTAINER_START_SLOT_WAIT_MS=120000`. Run Docker suites one at a time. Use `pnpm --filter <pkg> test` (filter first), `pnpm --filter <pkg> exec tsc --noEmit -p .` (or the package's build), and `pnpm lint`. Rebuild a package before running the k8s preset tests that import its dist.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Owner decisions (don't relitigate):**
  - the account belongs to the agent;
  - signing in is part of Add, all or nothing;
  - no choice step: the popup opens directly with `prompt=select_account`;
  - row menu: Edit + Remove, plus Sign in again on rows that need it;
  - team agents have one account per connector, and only a team admin may sign in.

## Rulings carried in (made for the owner while planning)

- **Seeding stays best-effort inside `agents:attach-connector`. A seed failure does not undo the Add.**
  - `snapshotNewlyAttachedConnectors` (`packages/agents/src/connector-snapshot.ts:131-199`) is deliberately fail-safe. A lost copy holds the agent to the live connector default: "lost, never widened".
  - The compensation therefore covers token → attach, the step that can leave a half-added connector. That matches the spec's intent ("nothing half-added").
  - Cost if wrong: a connector added during a describe-tools outage starts at the connector defaults instead of hint-seeded verdicts, which is safe.
  - No agents change is needed.
- **`begin` refuses instead of downgrading.**
  - Today `mayStoreOnAgent` returning false silently drops `credScope` to `'user'` (`packages/mcp-oauth/src/routes.ts:437-439`). After this slice, a "no" is a 403 `agent-store-refused`.
  - Personal agents also store at agent scope. The store question still uses `credentials:authorize-agent:account` with `purpose:'store'`.
- **"Sign in again" requires the connector to already be on the agent.**
  - `begin` asks `credentials:authorize-agent:account` *without* `purpose`, which requires the connector to be effective on the agent (`packages/connectors/src/credential-authz.ts:297-330`). A "no" is 409 `not-on-agent`.
  - `mode:'add'` uses `purpose:'store'`.
- **The callback re-checks the agent gate.** It runs `agents:resolve` and, for a team agent, `agents:can-set-shared-credential`, as the consuming user. The agent may have been deleted, or the person demoted, inside the 10-minute window. A failure redirects with `reason=not-allowed`, and nothing is written.
- **The popup learns why an Add failed.** The return URL gains `reason`, one of a fixed set:
  - `cancelled`: the provider returned `error=access_denied`;
  - `not-allowed`;
  - `add-failed`: the attach was refused or threw, and the token was deleted;
  - `sign-in-failed`: anything else.

  The bridge forwards `reason` only if it's in that set. The client maps each reason to fixed copy, so no provider text reaches the UI.
- **`POST …/agents/:id/connectors` refuses OAuth connectors.** It answers 409 `connector-needs-sign-in`, because an OAuth Add happens in the callback. The client never calls POST for OAuth.
- **API-key Add.**
  - For `keyMode:'personal'` connectors, POST requires `keys` covering every key slot (all or nothing). It writes each slot at agent scope, then attaches.
  - On attach failure (or a later slot write failing), it deletes the slots it wrote and answers with the original error.
  - For `keyMode:'workspace'` (shared key) and no-auth connectors, `keys` must be absent (400 if present), and the existing gate checks the shared key exists.
- **Rail key re-entry.** A row whose per-agent key is missing gets **Add key**, the key-mode twin of Sign in again.
  - It uses the existing agent-scope key route (`PUT …/team-key`, `setTeamKey`, `packages/channel-web/src/server/routes-workspace.ts:7330-7384`), renamed to `PUT …/connectors/:connectorId/key`.
  - It's widened to personal agents: their owner may set it.
  - Replacing a working key is Remove, then Add.
- **Remove** detaches, then deletes this agent's sign-in (`mcp-oauth:remove-shared-sign-in`, which also clears the agent reconnect marker) and its agent-scope key rows. It clears tool leftovers as today. `signOutIfUnused` and the `signedOut` response field are deleted.
- **Members see who the agent acts as, with no actions** (spec). A member's row menu shows only read-only details, if it shows anything today. Sign-in, key and remove items are hidden.

## Review Focus

- **The popup is closed mid-flow, or the provider denies access.** Nothing is attached, no token is written, and the Add row is still offered. Test: provider `?error=access_denied` → redirect `reason=cancelled`, no `credentials:set`, no attach (Task 2).
- **Attach throws after a successful token exchange** (e.g. the person was removed from the team mid-flow). The token is deleted, the connector is not on the agent, and the popup shows "We couldn't add …". Test in Task 2.
- **Two agents, one owner, one connector, two different accounts.** Each Add writes its own agent-scope row, and neither overwrites the other. Test: two callbacks for agents A and B write `ownerId` A and B respectively (Task 2, e2e).
- **"Sign in again" for a connector that was removed from the agent while the popup was open.** The token write is harmless, because it's unreadable without attachment. No attach happens. Test: `mode:'sign-in-again'` never calls `agents:attach-connector` (Task 2).
- **A per-agent key Add where the attach is refused** (e.g. a team member who isn't a team admin). No key row survives. Test in Task 3.

---

### Task 1: mcp-oauth `begin` — agent required, always agent scope, mode, `prompt=select_account`

**Files:**
- Modify:
  - `packages/mcp-oauth/src/routes.ts:345-596` (`begin`; body parse at :361-373, scope at :381-412, the downgrade at :437-439, pending row at :563-585);
  - `packages/mcp-oauth/src/types.ts:40-70` (`PendingAuthorization`);
  - `packages/mcp-oauth/src/migrations.ts:50-108` (pending table + row type);
  - `packages/mcp-oauth/src/store.ts:103-204` (`rowToPending`, `putPending`);
  - `packages/mcp-oauth/src/oauth-flow.ts:225-259` (authorize URL).
- Tests:
  - `packages/mcp-oauth/src/__tests__/routes.test.ts` (begin block :344-700, credScope cases :1071-1200);
  - `oauth-flow.test.ts` (:22-60);
  - the e2e suites that begin without `agentId`: `e2e.test.ts:429-590`, `admin-client-secret.e2e.test.ts:255-430`, `client-secret-ref.e2e.test.ts:335`, `dcr-client-binding.e2e.test.ts:374, :653`.

**Interfaces:**
- **Produces:**
  - `POST /api/connectors/oauth/begin` body `{connectorId: string, agentId: string, mode: 'add' | 'sign-in-again'}` → 200 `{authorizationUrl}`.
  - `PendingAuthorization` gains `mode: 'add' | 'sign-in-again'`. `credScope` is kept in the row for old rows, but every new row is `'agent'`, and `agentId` is always non-empty.
  - DB column `mode TEXT NOT NULL DEFAULT 'sign-in-again'`, added the way `cred_scope` was (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`). An old in-flight pending row from before the upgrade then never auto-attaches.

**Requirements:**
1. **Body validation.**
   - `agentId` missing → 400 `{error:'agentId is required'}`.
   - `mode` missing or not one of the two values → 400 `{error:'mode must be "add" or "sign-in-again"'}`.
   - Existing checks (empty `agentId`, missing `connectorId`) are kept.
2. Scope is always `'agent'`. Delete the `credScope = … ? 'agent' : 'user'` line (:410) and the `pendingAgentId = ''` default.
3. **Store authorization.**
   - `mode:'add'`: `credentials:authorize-agent:account` with `purpose:'store'` (the existing `mayStoreOnAgent`). False → 403 `{error:'agent-store-refused'}`. Remove the downgrade.
   - `mode:'sign-in-again'`: the same question **without** `purpose` (attachment required). False → 409 `{error:'not-on-agent'}`.
   - Either hook missing → treat as refused. This is fail-closed and matches how `mayStoreOnAgent` treats a missing hook today. Check that, and keep it consistent.
4. **Authorize URL** (`oauth-flow.ts`):
   - always `prompt=select_account`;
   - for issuer `https://accounts.google.com`, `prompt=select_account consent`, still with `access_type=offline`.
5. Persist `mode` in the pending row and read it back (`rowToPending`). A missing or unknown DB value reads as `'sign-in-again'`.
6. Update the doc comments in `begin` that describe the user-scope / "connect once for all my agents" behaviour.

**Tests (write first):**
- `begin` without `agentId` → 400.
- Bad or missing `mode` → 400.
- A personal agent with `mode:'add'` writes a pending row with `credScope:'agent'`, `agentId` set and `mode:'add'`.
- A store refusal → 403 `agent-store-refused`, with no pending row and no discovery call.
- `sign-in-again` on a connector that isn't attached → 409 `not-on-agent`.
- `sign-in-again` uses the no-purpose question (assert the call args).
- Authorize URL: a non-Google issuer has `prompt=select_account`; Google has `prompt=select_account consent` and `access_type=offline` (`oauth-flow.test.ts`).
- Pending round-trip of `mode`, plus an old-row default (insert a row without the column value → `'sign-in-again'`).
- **Delete** these tests along with the behaviour: "a member beginning WITHOUT an agentId is unaffected" (:617), "agentId is optional" (:665 → now asserts 400), the no-agentId → user-scope case (:1183), and the e2e "connect-once reuse across agents" (`e2e.test.ts:429`).
  - Rewrite `dcr-client-binding`'s "[CONTROL] two PERSONAL agents share one user-scope token" (:653) as "two personal agents of one user get **separate** agent-scope tokens". This is the Review Focus case.
  - Give the admin-client-secret and client-secret-ref e2e begins an `agentId` + `mode:'add'`, with the attach hook stubbed if those harnesses reach the callback.

Run: `pnpm --filter @ax/mcp-oauth test` (Docker; alone). Then `tsc`.

Commit: `mcp-oauth: every sign-in belongs to an agent; the popup always asks which account`.

### Task 2: mcp-oauth `callback` — re-check, token, attach, compensate, reason

**Files:**
- Modify:
  - `packages/mcp-oauth/src/routes.ts:598-846` (`returnUrl` :598-600, callback);
  - `packages/mcp-oauth/src/plugin.ts:247-301` (manifest: add `agents:attach-connector` to `calls` under `mountRoutes`, and `agents:can-set-shared-credential` stays optional).
- Tests:
  - `routes.test.ts` (callback block :1319-2100);
  - `plugin.test.ts` (manifest :86);
  - `e2e.test.ts` (:589 agent-bound flow);
  - `presets/k8s` bootstrap/preset test (no cycle).

**Interfaces:**
- **Consumes:**
  - Task 1's `PendingAuthorization.mode`;
  - `agents:attach-connector` input `{actor:{userId, isAdmin}, agentId, connectorId}` → `{agent, changed}` (`packages/agents/src/types.ts:320-329`). Mirror the type locally; don't import it.
- **Produces:**
  - `returnUrl(connectorId, outcome: 'success' | 'error', reason?: OAuthFailureReason)`, where `type OAuthFailureReason = 'cancelled' | 'not-allowed' | 'add-failed' | 'sign-in-failed'`.
  - The redirect is `…?connector=<id>&oauth=error&reason=<reason>`. Success has no reason.

**Requirements (callback order after `consumePending`):**
1. **Provider `?error`.** `access_denied` → `reason=cancelled`; anything else → `sign-in-failed`. Write nothing.
2. **Re-check the agent gate as `pending.userId`** (the consuming user is already checked equal at :630).
   - Call `agents:resolve {agentId: pending.agentId, userId}`. Rejected → `not-allowed`.
   - For `visibility:'team'`, call `maySetSharedCredential(user, agentId)` (:227-248). False → `not-allowed`.
   - A pending row with an empty `agentId` (only possible from before the upgrade) → `not-allowed`.
3. The existing connector re-read, discovery and token exchange are unchanged. Their failures → `sign-in-failed`.
4. **Write the token** with `scope:'agent'`, `ownerId: pending.agentId`, as today. A failure → `sign-in-failed`.
5. **`mode:'add'` only:**
   - Call `agents:attach-connector` with `{actor:{userId: user.id, isAdmin: user.isAdmin}, agentId, connectorId}`.
   - On throw or reject:
     - call `credentials:delete {scope:'agent', ownerId: agentId, ref:'account:<id>'}`;
     - if the delete itself fails, log `mcp_oauth_add_compensation_failed` with the connector and agent, and nothing secret;
     - log `mcp_oauth_add_attach_failed`;
     - redirect `reason=add-failed`.
   - Do **not** clear the reconnect marker on this path.
6. **`mode:'sign-in-again'`:** no attach (the token only), as today.
7. Clear the agent reconnect marker (best-effort, as today) only after full success. Redirect `oauth=success`.
8. **Manifest.** Under `mountRoutes`, `calls` gains `agents:attach-connector`. Update `plugin.test.ts`'s manifest assertion. Confirm with the k8s preset test that bootstrap accepts the graph (no cycle).

**Tests (write first):**
- `add`: the order is set, then attach (assert call order); success redirect; marker cleared.
- `add` where attach throws → delete called with the exact scope, owner and ref; `reason=add-failed`; marker **not** cleared.
- `add` where attach throws and the delete also throws → still `add-failed`, plus the compensation log.
- `sign-in-again` → attach never called; success.
- `access_denied` → `cancelled`, with no set and no attach. Another provider error → `sign-in-failed`.
- **Re-check:**
  - a deleted agent (resolve rejects) → `not-allowed`, no token exchange call, no set;
  - a team agent whose user is no longer a team admin → `not-allowed`.
- Two agents of one owner → two writes with owners A and B (e2e, extending `:589`).
- Update the existing redirect-target test (:2024) for the `reason` param.

Run: `pnpm --filter @ax/mcp-oauth test`. Then `pnpm --filter @ax/mcp-oauth build && pnpm --filter @ax/preset-k8s test` (use the actual k8s preset package name).

Commit: `mcp-oauth: Add signs in and attaches together, or leaves nothing`.

### Task 3: channel-web server — API-key Add at agent scope; Remove deletes the agent's own sign-in; drop dead routes

**Files:**
- Modify `packages/channel-web/src/server/routes-workspace.ts`:
  - `attachConnector` :7526-7618;
  - `attachCredentialGate` :1724-1806 and its comment :1546-1562;
  - `readTeamKeyBody` :1642-1672;
  - `setTeamKey` :7330-7384 and `teamKeyGate`;
  - `removeConnector` :7620-7710;
  - `signOutIfUnused` :4429-4510;
  - `teamSignInConnectors` :4377-4427;
  - `removeTeamSignIn` :7486-7524;
  - `retryConnector` :7172;
  - the route table :8787-8845;
  - the mirror types :1476, :1502-1509.
- Modify `packages/channel-web/src/server/plugin.ts:487-530` (`optionalCalls`).
- Tests:
  - `packages/channel-web/src/__tests__/server/routes-workspace-connectors.test.ts` (POST :1576-1868, DELETE :1339-1575, retry :299-1176);
  - `__tests__/server/plugin.test.ts`;
  - the team-key / team-sign-in server tests (find with `grep -rln "team-key\|team-sign-in" packages/channel-web/src/__tests__/server`).

**Interfaces:**
- **Produces (consumed by Tasks 4 and 5):**
  - `POST /api/workspace/agents/:agentId/connectors` body `{connectorId: string, keys?: Array<{slot: string, payloadB64: string}>}` → 200 `{attached: true, changed: boolean}`.
    - 409 `{error:'connector-needs-sign-in'}` for an OAuth connector.
    - 400 `{error:'connector-needs-key'}` when a per-agent key connector is missing any slot.
    - 400 `{error:'keys-not-accepted'}` when `keys` is sent for a shared-key or no-auth connector.
  - `PUT /api/workspace/agents/:agentId/connectors/:connectorId/key` body `{slot, payloadB64}` (renamed from `…/team-key`). It's allowed for a personal agent's owner and a team agent's team admin.
  - `DELETE /api/workspace/agents/:agentId/connectors/:connectorId` → `{removed: true}`, with no `signedOut`.

**Requirements:**
1. **POST attach.**
   - Parse `keys` with the same strict rules as `readTeamKeyBody`: strict base64, max `TEAM_KEY_PAYLOAD_B64_MAX_CHARS`, no duplicate or unknown slots, at most the connector's slot count.
   - Classify the connector from its definition (`connectors:get`): OAuth slot, `keyMode:'personal'` key slots, `keyMode:'workspace'`, or none.
   - Authorize first, before any write: the existing `agents:can-manage-connectors` step and an agent-store question (`credentials:authorize-agent:account` with `purpose:'store'`).
   - **Per-agent key:**
     - Write each slot with `credentials:set {scope:'agent', ownerId: agentId, ref, kind:'api-key', payload}`.
     - Then call `agents:attach-connector`.
     - On any failure after the first write, `credentials:delete` every slot written so far, then answer with the original error's status and body.
   - **Shared key or no auth:** keep the existing `attachCredentialGate`, narrowed to the shared-key presence check.
   - Delete the gate's `connector-needs-sign-in` / `connector-needs-key` branches that read agent-scope rows before attach. That pre-attach read is the bug the spec's §3 notes. Update the gate's comment.
2. **Key route.**
   - Rename the `team-key` routes to `…/key`.
   - The gate allows a personal agent's owner as well as a team agent's team admin, and writes at agent scope.
   - Delete the GET/DELETE variants if Tasks 4 and 5 won't call them. Check the client after Task 5's plan: the rail only needs PUT.
3. **Remove.**
   - After detach and `clearConnectorLeftovers`:
     - call `mcp-oauth:remove-shared-sign-in {agentId, connectorId}` when the connector has an OAuth slot (it deletes the agent-scope token and the agent marker; check its exact input in `packages/mcp-oauth/src/plugin.ts:131-170`);
     - `credentials:delete` each key slot at agent scope when `keyMode:'personal'`.
   - These are best-effort with a log: the detach already happened, and a leftover row is unreadable without attachment.
   - Delete `signOutIfUnused`, its mirror type and the `signedOut` field.
4. **Delete the dead pieces:**
   - `removeTeamSignIn` and the `DELETE …/team-sign-in` route;
   - `teamSignInConnectors` (if only that menu item used it);
   - `retryConnector` and `POST …/retry` (the menu item goes in Task 5);
   - the `mcp-oauth:remove-personal-sign-in` `optionalCalls` entry (the hook itself retires in slice 5; channel-web stops calling it now).

   Grep each one for other callers first. Anything still used stays, and you note it.

**Tests (write first):**
- POST with a per-agent key → two `credentials:set` at agent scope, then attach, 200.
- **Attach refused** (`agents:attach-connector` rejects) → both slots deleted, and the response carries the attach error. This is the Review Focus case.
- The second slot write fails → the first deleted, no attach.
- Missing slot → 400 `connector-needs-key` with no writes.
- Keys for a shared connector → 400 `keys-not-accepted`.
- An OAuth connector → 409 `connector-needs-sign-in`.
- Not allowed to manage → 403 and **no** `credentials:set` call.
- DELETE → detach, then `remove-shared-sign-in` for OAuth and key deletes for per-agent keys; no `signedOut`.
- The key route: a personal owner may PUT; a stranger 403.
- **Delete the old tests:** the TASK-761 pre-attach gate's sign-in/key cases, "signing out once a connector is on no agent" (:1482-1575), the retry tests and the team-sign-in tests.

Run: `pnpm --filter @ax/channel-web test -- src/__tests__/server` (then the whole package), then `tsc`.

Commit: `channel-web: adding a key-based connector saves its key on the agent, or nothing`.

### Task 4: channel-web client — Add opens the popup directly; the popup plumbing requires an agent

**Files:**
- Modify:
  - `packages/channel-web/src/components/workspace/AddConnector.tsx` (`attach` :200-243, `advance` :254-277, `AvailableRow` :396-535, notice :374, key dialog :378-391);
  - `lib/add-connector.ts:72-96`;
  - `lib/use-oauth-popup.ts`;
  - `components/settings/ConnectorOAuthConnect.tsx`;
  - `lib/connectors-oauth.ts:61-111`;
  - `lib/oauth-callback-bridge.ts:29-48`;
  - `lib/oauth-full-page-return.ts:36-54`;
  - `lib/workspace-api.ts:1071-1075` (`attachConnector` gains `keys`);
  - `components/settings/ConnectorConnectDialog.tsx` (OAuth slot :348-363).
- Modify the dev mock: `packages/channel-web/mock/` (the workspace connectors and oauth begin mocks; grep for `oauth/begin` and `/connectors'` in `mock/`).
- Tests:
  - `components/workspace/__tests__/AddConnector.test.tsx`;
  - `components/settings/__tests__/ConnectorOAuthConnect.test.tsx` (:182);
  - `ConnectorConnectDialog.test.tsx` (:477);
  - `lib/__tests__/connectors-oauth.test.ts` (:54);
  - the bridge test (grep `oauth-callback-bridge`);
  - `__tests__/connector-access-coverage.test.ts`.

**Interfaces:**
- **Consumes:** Task 1's begin body; Task 2's `reason` values; Task 3's POST body and errors.
- **Produces:**
  - `beginOAuth({connectorId, agentId, mode})`, with both `agentId` and `mode` required in the type.
  - `useOAuthPopup({connectorId, agentId, mode, onConnected, …})`.
  - `ConnectorOAuthConnect` props require `agentId` and `mode`.
  - The bridge message becomes `{type:'ax:oauth-callback', connector, oauth, reason?}`.
  - `workspaceApi.attachConnector(agentId, connectorId, keys?)`.

**Requirements:**
1. **Add subview, per connector kind:**
   - **OAuth:** the row's **Add** opens the popup immediately (`mode:'add'`). On success, refresh the agent's connector list. The callback already attached, so the client doesn't call attach.
     - Delete the client-side sign-in → attach sequencing and `getOAuthStatus`-based skipping in `add-connector.ts`. Every OAuth Add signs in, even if the person already has a sign-in somewhere.
   - **Per-agent key:** Add opens the key form, and saving calls `attachConnector(agentId, connectorId, keys)`. Replace the user-scope `ConnectorConnectDialog` / `CredentialSlotForm` write with a form that only collects the values: reuse the key-entry fields the team-key dialog uses (find `TeamKeyDialog`). Don't hand-roll inputs.
   - **Shared key or no auth:** Add calls `attachConnector(agentId, connectorId)`.
   - Keep `<ConnectorAccessNotice kind="attach">` and the team-consent alert.
   - Delete the Retry `'attach'` / `'recheck'` paths that existed only for the split flow. Keep a plain retry if the POST fails with a network error.
2. **Error copy**, fixed text per `reason`, rendered as text:
   - `cancelled` → "Sign-in was cancelled, so nothing was added."
   - `not-allowed` → "You can't add connectors to this agent any more."
   - `add-failed` → "You signed in, but we couldn't add it to this agent. Nothing was saved; try again."
   - `sign-in-failed` or none → the existing generic sentence.

   Map 409 `connector-needs-sign-in` and 400 `connector-needs-key` from POST to short copy too.
3. **Bridge.** Forward `reason` only if it's one of the four literals. Otherwise omit it. Same for the full-page-return toast.
4. **`ConnectorConnectDialog`.** Delete its OAuth slot. If, after Tasks 4 and 5, the dialog has no remaining caller, delete the whole component and its tests. Grep `ConnectorConnectDialog`.
5. **The dev mock** mirrors the new begin body (400 without `agentId`), the POST `keys`, and the redirect `reason`.

**Tests (write first):**
- An OAuth Add calls `beginOAuth` with `{connectorId, agentId, mode:'add'}`, even when `getOAuthStatus` would say connected (that call is gone; assert it isn't made). On a success message it refreshes and never calls `attachConnector`.
- An `add-failed` message shows the add-failed copy, and the connector is still in the Add list.
- A per-agent key Add posts `keys`. A 409 or 400 shows the copy.
- A shared or no-auth Add posts no keys.
- The bridge drops an unknown `reason` and forwards a known one.
- `ConnectorOAuthConnect` without `agentId` is a type error (a `// @ts-expect-error` test).
- The access-coverage test still passes.

Run: `pnpm --filter @ax/channel-web test`, then `tsc` (channel-web's tsc includes test files).

Commit: `channel-web: Add opens the sign-in popup directly, and adds only if it succeeds`.

### Task 5: channel-web client — rail row menu: Edit / Remove (+ Sign in again / Add key)

**Files:**
- Modify:
  - `packages/channel-web/src/components/workspace/AgentConnectors.tsx` (header comment :1-83; state :260-270; `onRetry` :304-348; `onRemove` :350-374; `menuFor` :397-433; dialogs :579-722; `RowMenu` :836-1007; `personalExpiry` :191-193);
  - `components/workspace/ConnectorDetails.tsx` (`SETUP_REASON` :77-88, `SetupLine` :430-450);
  - `lib/agent-connectors.ts:21-24, 136-170`;
  - `lib/workspace-types.ts:1191-1199`;
  - `lib/workspace-api.ts` (`removeTeamSignIn` :1142, `retryConnector` :1154, team-key methods :525+).
- Tests:
  - `components/workspace/__tests__/AgentConnectors.test.tsx`;
  - `AgentConnectors.setup.test.tsx`, `AgentConnectors.teamKey.test.tsx`, `AgentConnectors.teamSignIn.test.tsx`, `AgentView.test.tsx`;
  - `lib/__tests__/agent-connectors.test.ts`.

**Interfaces:**
- **Consumes:**
  - Task 3's DELETE (no `signedOut`) and the PUT `…/key` route;
  - Task 4's `ConnectorOAuthConnect` / `useOAuthPopup` with `mode:'sign-in-again'`.

**Requirements:**
1. **The menu for someone who may manage the agent** (personal owner; team admin on a team agent):
   - **Sign in again**, first, only when the row needs sign-in: expired (`needsReconnect`) or missing (`setup:'sign-in'`). It opens the popup with `mode:'sign-in-again'`. On success, refresh. Attachment and verdicts stay.
   - **Add key**, only when `setup:'add-key'`. It opens the key form and PUTs to `…/key`.
   - **Edit**: the existing details view, with editable permissions. Merge today's "View details" and "Edit permissions" into one item that opens the same view.
   - **Remove from <agent>**: as today, minus the signed-out notice.
2. **Deleted:**
   - the "Retry" item and `onRetry`;
   - "Reconnect" (it becomes Sign in again);
   - the member no-agent "Sign in again" dialog (:620-655);
   - "Remove team sign-in";
   - the "Team key" item (replaced by Add key-when-needed);
   - the `removed-signed-out` result and notice;
   - the client API methods for the deleted server routes.
3. **A member** (can't manage) gets no Sign in again / Add key / Remove. If the row has a details view today, members keep a read-only "View details". Pin both in tests.
4. `ConnectorDetails`' setup button: Sign in opens with `mode:'sign-in-again'` when the connector is already attached (it always is on a rail row). Make sure no `ConnectorOAuthConnect` lacks `agentId` or `mode`.
5. Rewrite the header comment (:1-83) to describe the new menu.
6. Use the `shadcn` skill; the menu uses the existing DropdownMenu primitives.

**Tests (write first):**
- A healthy row's menu is exactly [Edit, Remove from <agent>].
- An expired row: [Sign in again, Edit, Remove …], and Sign in again begins with `mode:'sign-in-again'` and `agentId`.
- A missing key: [Add key, Edit, Remove …], and Add key PUTs `…/key`.
- A member sees no actions (only View details if present).
- Remove shows no signed-out notice.
- No "Retry", "Reconnect", "Team key" or "Remove team sign-in" text anywhere in the rendered menu, in any state.
- Delete the TASK-774 member re-sign-in tests (:634-735) and the retry/reconnect tests.

Run: `pnpm --filter @ax/channel-web test`, then `tsc`.

Commit: `channel-web: connector rows offer Edit and Remove, plus Sign in again when needed`.

### Task 6: Gate + memory

- [ ] Run the full gate: `pnpm build && pnpm lint && pnpm -r --workspace-concurrency=2 --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Re-run a Docker-timeout package on its own before calling it red.
- [ ] Write the shard with `shard=$(scripts/memory-write-target.sh --shard decisions SIGNINS-5); mkdir -p "$(dirname "$shard")"`. Record:
  - the seed-stays-best-effort ruling;
  - refuse-not-downgrade;
  - sign-in-again requires attachment;
  - the callback re-check;
  - the `reason` enum;
  - POST refuses OAuth;
  - Add key as the key twin of Sign in again;
  - Remove deletes the agent's own rows.
- [ ] Commit `memory: decisions shard for agent-owned sign-ins slice 3`.
