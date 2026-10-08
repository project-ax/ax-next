# Agent-owned sign-ins — Slice 5 (lookup flip + boot purge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- An agent never acts as the person chatting with it.
- Connector credentials (`account:` refs) resolve **agent → global** only, and nothing can write one at person (user) scope any more.
- Every person-level connector credential and person-level reconnect marker is removed once, at boot.
- After this slice, main is deployable.

**Architecture:**
- **@ax/credentials**
  - `findRow` skips the user step for refs starting `account:`.
  - `credentials:set` refuses `account:` at user scope.
  - A one-time boot step (storage marker, the same pattern as `wipe-pre-redesign.ts`) calls its own `credentials:purge-account {scopes:['user']}`.
- **@ax/mcp-oauth**
  - Retires `remove-personal-sign-in` and drops the user marker table.
  - At init, it asks `connectors:live-ids` and drops agent markers for ids that are no longer live (SIGNINS-3).
- **Every other writer of a person-level `account:` credential moves** to agent or global scope, or is removed:
  - the connectors credential plan;
  - the admin editor;
  - the skill grant card;
  - the destination routes;
  - the CLI.

**Tech Stack:** TypeScript, vitest, Postgres via testcontainers, React + shadcn.

**Spec:** `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md`: §1 (lookup and writes), §2 "Removed", §7 (migration), Security, Testing › first bullet and Migration, and the Slices revision note. **Prereqs:** slices 1–4. This branch stacks on `feat/agent-owned-sign-ins-4`.

## Global Constraints

- **Core guarantee (spec Security):** the lookup skipping user scope for `account:` refs, and the write refusal. Both get dedicated tests.
- **Other ref kinds keep user → agent → global:** `provider:`, `skill:`, `routine:` and `mcp:`. A test proves each still resolves at user scope, and the purge leaves those rows untouched.
- **Team-agent and agent-scope rows survive the purge, as do global rows.** A test proves it.
- **Both boot steps are idempotent.** A second run is a no-op, and a test proves it.
- **Boot steps fail toward keeping data, and never fail the boot:**
  - a missing storage hook → skip;
  - a purge error → don't write the marker, and retry next boot;
  - a missing `connectors:live-ids` or a failure there → keep all markers.
- **No cross-plugin imports; no half-wired code.** Every user-scope `account:` path that becomes unreachable is deleted with its tests: hooks, routes, store methods, tables (dropped), client helpers and copy.
- **Owner decisions:**
  - "Migration: everyone signs in again."
  - "I don't care if existing skills are broken."
  - Admin-only connectors.
  - An API key filled in at creation is shared (global); a blank key means each agent adds its own (agent scope).
- **UI uses shadcn and semantic tokens.** Copy is plain, short and warm.
- `export DOCKER_HOST=unix:///var/run/docker.sock AX_TESTCONTAINER_START_SLOT_WAIT_MS=120000`. Run Docker suites one at a time; on this loaded host, re-run a timing-out file alone with `--no-file-parallelism`. Use `pnpm --filter <pkg> test` (filter first), check tsc per package, and run eslint. Rebuild a package before running preset-k8s tests that import its dist.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings carried in

- **Owners.** The user-scope purge is owned by **@ax/credentials** at its own init. It owns the rows and `purge-account`, and needs no connectors knowledge. Marker cleanup is owned by **@ax/mcp-oauth** at init, which runs after connectors in the declared graph, so `connectors:live-ids` is usable.
- **The marker key** is `credentials:agent-owned-sign-ins:user-account-purged`, stored with `storage:get`/`storage:set` the way `WIPE_MARKER_KEY` is.
- **The user marker table is dropped** (`DROP TABLE IF EXISTS mcp_oauth_v1_needs_reconnect` in the migration). That's idempotent and needs no marker.
  - `markerOwnerOf` only ever returns an agent owner.
  - A row that isn't at agent scope (global, or no scope) gets **no** marker.
  - Global OAuth rows can't exist: OAuth sign-ins are always agent scope since slice 3.
- **The agent-marker sweep** batches distinct `connector_id`s from `mcp_oauth_v1_needs_reconnect_agent` in groups of at most 500 (`connectors:live-ids` max), and deletes only ids answered as not live. It's best-effort and never throws. It has no marker; it runs every boot, the way agents' `dropDanglingConnectorIds` does.
- **The connectors credential plan.** `scopeForKeyMode('personal')` returns `'agent'`, not `'user'`, in connectors and in channel-web's mirror. Plan consumers that write or read with an explicit scope use the agent (`ownerId` = the agent id). Consumers that name no scope (`credentials:get`/`has` under the session ctx) are unchanged.
- **The admin connector editor never writes person-level credentials:**
  - A `keyMode:'personal'` connector's header keys aren't entered in the editor at all. Each agent adds its own at Add (slice 3).
  - The OAuth client secret is always written at **global** scope, for a shared connector.
  - The "needs migration" flow that reads and deletes the admin's own user-scope copy is deleted. After the purge there's nothing to migrate. When the global secret is missing, the editor shows its normal "not set — enter it" state.
  - A private connector can't carry a client secret (they're admin-only and shared in practice). Saving one says "Make it Shared to use a client secret."
- **The skill grant card** (`GrantRow`) no longer offers key entry for an `account:<svc>` destination. It shows "Ask a workspace admin to add a {svc} connector, then add it to this agent." `skill:` destinations are unchanged.
  - skill-broker `request_capability`'s `haveExisting` for `account:` slots checks presence with `credentials:has` under the session ctx (agent → global) instead of listing user-scope rows.
  - This follows the owner decision that existing skills may break.
- **The credentials-admin-routes destination routes** (`/settings/destinations/account/credential`, POST and DELETE) are deleted for the `account` destination kind. Other kinds stay. channel-web's `setDestinationCredential`/`deleteDestinationCredential` lose their `account` user-scope branch.
- **The CLI.** `ax credentials set` with an `account:` ref prints a short error ("Connector credentials belong to agents now; add them from the agent's Connectors tab") and exits non-zero. Other refs are unchanged.
- **The connectors admin "Test" probe** for a `keyMode:'personal'` connector no longer looks in the admin's user scope. It reports `needs-key` with copy saying it's tested once an agent adds its key.
- **Delete-time purges.** `purge.ts`'s user-scope plan-key and client-secret deletes are removed: there are no rows to delete. `purge-account` calls drop `'user'` from their scopes.
- **Copy** in channel-web that describes person-level sign-ins changes to agent wording:
  - "Your sign-in expired" → "Sign-in expired";
  - "Each person connects / signs in / adds their own key" → "Each agent …";
  - "Personal — each user brings their own key" → "Each agent adds its own key";
  - the consent "act as you on X" → "use your {X} account for everyone who uses this agent", on team agents only. Personal agents show no consent.

## Review Focus

- **A person who still has an old user-scope token at boot:** after boot it's gone, `credentials:get` for that `account:` ref returns the agent's row (or not-found), and the person's `provider:` key still works.
- **Boot while storage is down, or `purge-account` throws midway:** no marker is written, the next boot retries, the rows that were already tombstoned stay tombstoned, and the boot doesn't fail.
- **mcp-oauth boot with connectors not loaded** (CLI preset), or `live-ids` throwing: no marker is dropped and no error is raised.
- **The CLI, an old SPA bundle or a skill card posting an `account:` write at user scope:** refused with a clear error, and nothing written.
- **A refresh of an agent-scope OAuth token:** it re-stores at agent scope and is never refused by the new guard.

---

### Task 1: @ax/credentials — flip the lookup, refuse user-scope `account:` writes, purge once at boot

**Files:**
- Modify `packages/credentials/src/plugin.ts`:
  - `findRow` 823-862 and its comment 792-822;
  - the manifest comment ~486;
  - `credentials:set` handler 630-660 (the refusal goes after `validateRef` ~636);
  - the `purge-account` doc ~323-337;
  - init 1223-1237.
- Create `packages/credentials/src/purge-user-account.ts`, modelled on `wipe-pre-redesign.ts`.
- Tests in `packages/credentials/src/__tests__/`:
  - rewrite `account-agent-guard.test.ts:260-269`, `account-global-guard.test.ts:265-275, 399-421`, `has.test.ts:484-516` and `vault.test.ts:100-146` to the new rule;
  - in `purge-account.test.ts:79-120`, seed through `store-blob:put`, not `credentials:set`;
  - add new tests.

**Requirements:**
1. **`findRow`:** when `ref.startsWith(GUARDED_ACCOUNT_REF_PREFIX)`, don't add the user attempt. Other refs are unchanged. Update both comments.
2. **`credentials:set`:** `scope === 'user'` plus an `account:` ref → `PluginError({code:'invalid-payload', message:"connector credentials ('account:' refs) can't be stored per person; store them on the agent or globally"})`. `delete` is unchanged, so old rows stay deletable.
3. **Boot purge** (`purgeUserAccountCredentials(bus, ctx)`), called from init after the pre-redesign wipe:
   - Skip if `storage:get`/`storage:set` are absent.
   - Skip if the marker is set.
   - Otherwise call the plugin's own purge with `{scopes:['user']}` (the internal function, not through the bus, if that's how `purge-account` is built), then set the marker.
   - Any throw → log a warn (counts only), no marker, don't throw.
   - Log `credentials_user_account_purged {purged}`.

**Tests (write first):**
- With a user-scope `account:linear` row and an agent-scope one, `get` under an agent ctx returns the **agent** row. With only a user row, it's not found (and there's no env fallback for `account:`, if that's the existing rule; check).
- `has` behaves the same way.
- `provider:x`, `skill:x` and `routine:x` at user scope still resolve.
- Setting `account:x` at user scope is refused and nothing is written. At agent and global scope it succeeds.
- **The boot purge:**
  - removes user-scope `account:*` rows across two owners;
  - keeps agent, global and non-`account:` user rows;
  - writes the marker, and a second boot is a no-op (purge not called);
  - with storage missing → skipped;
  - a purge throw → no marker, no throw, and the next boot retries.
- A refresh of an agent-scope row re-stores without tripping the refusal: resolve with a fake `credentials:resolve:<kind>` returning `refreshed`.

Commit: `credentials: connector credentials resolve on the agent or globally, never per person`.

### Task 2: @ax/mcp-oauth — retire person-level sign-ins and markers; sweep dead agent markers at boot

**Files:**
- Modify in `packages/mcp-oauth/src/`:
  - `plugin.ts`: `remove-personal-sign-in` 196-236 / 297 / 596-629; status-batch 510-538; marker wiring 460-494; manifest 275-298 (add `connectors:live-ids` to `optionalCalls`); init.
  - `store.ts`: `MarkerOwner` 99; user branches 239-342; a new `listMarkedConnectorIds()` and `deleteAgentMarkersForConnectors(ids)` (or reuse `deleteMarkersForConnector`).
  - `resolver.ts:81-86, 137-142`.
  - `migrations.ts:73-79, 115-131` (drop the table).
  - `routes.ts:1073-1146`: the status probe's no-agent branch is deleted, and `agentId` is required (the only client always sends it).
- Tests:
  - `plugin.test.ts`: manifest 96, 110-115; status-batch 218-407; 577-597; delete block 682-766; 1037-1120;
  - `store.test.ts` 44, 378-449, 566-595;
  - `resolver-marker.test.ts`, `resolver-rejected.test.ts:51-68`;
  - `e2e.test.ts:745-830`: delete or convert the "personal sign-in survives" test;
  - `client-secret-ref.e2e.test.ts:328, 396-404`: the author's own user-scope secret no longer resolves. Rewrite to the global secret, or assert refusal.
  - `presets/k8s/src/__tests__/preset.test.ts:1100-1110`.

**Requirements:**
1. **Delete `mcp-oauth:remove-personal-sign-in`:** its types, registration and tests.
2. **The marker table and status-batch:**
   - Drop the user marker table in the migration.
   - `MarkerOwner` becomes agent-only.
   - `markerOwnerOf` returns `null` (no marker) for non-agent scopes, and the resolver skips mark/clear on `null`.
   - status-batch: `needsReconnect` comes from agent markers only. Keep the `shared` field, equal to the agent markers (the channel-web caller already shows "Team" wording only for team agents), unless removing it is cleaner. If so, update channel-web's mirror and `connectorHealth` in the same commit.
3. **The init sweep** (`sweepDeadAgentMarkers`), when the routes plugin set is loaded or always, whichever has the store:
   - read the distinct connector ids from the agent marker table;
   - ask `connectors:live-ids` in batches of ≤500;
   - delete agent markers for ids not answered live.
   - Absent hook / throw / malformed reply → keep everything, and log at info or warn.
4. **The status probe:** `agentId` is required (400 when missing). Delete the user-scope probe path.
5. Update the doc comments that mention person-level sign-ins.
6. Carried from slice 4:
   - **(a)** `types.ts`'s `identityScope` doc comment still says "per-(connector, authorization server)". The flag is keyed per **agent**, connector and auth server; fix the comment.
   - **(b)** In the callback, the identity-scope skip flag is written in the provider-error branch, which runs before the agent-gate re-check. Move the flag write so it happens only after the same agent re-check passes (`agents:resolve`, plus the team-admin check), and skip it otherwise. Add a test: a removed team member's forged `invalid_scope` doesn't set the flag.

**Tests (write first):**
- The manifest no longer registers `remove-personal-sign-in`, and does declare `connectors:live-ids` optional.
- status-batch with agent markers only.
- `markerOwnerOf` → `null` for user, global and no scope.
- **The sweep:**
  - deletes markers for dead ids only;
  - batches 501 ids into 2 calls;
  - missing hook → keeps all; a throw → keeps all.
- The migration drops the table, and a second migrate is fine.
- The status probe without `agentId` → 400.
- The preset test: the k8s boot graph still has no cycle, and `registers` is updated.

Commit: `mcp-oauth: sign-ins and reconnect markers live only on agents`.

### Task 3: connectors, mcp-client, skill-broker, credentials-admin-routes, CLI — no person-level connector credentials

**Files:**
- `packages/connectors/src/credential-plan.ts:113-150`, `purge.ts:64-163`, `admin-routes.ts:254-283` (probe), and tests:
  - `agent-credential-attachment.test.ts:383-450`;
  - `credential-scope-authz.test.ts:364-381, 456-475`;
  - `admin-routes.test.ts:1375-1415`;
  - `hooks.test.ts` (scope expectations);
  - `credential-plan.test.ts`, `stdio-sweep.test.ts:141`, `non-admin-sweep.test.ts:224, 529` and the `purge-account` scope assertions.
- `packages/mcp-client`:
  - check every consumer of `credentialPlan[].scope`;
  - tests: `connector-inventory-wiring.test.ts:214-225` plus fixture-only scope changes in `connector-inventory-describe-tools.test.ts`, `connector-inventory-auth-failure-recheck.test.ts`, `host-server-sweep.test.ts`.
- `packages/skill-broker/src/tools/request-capability.ts:169-242`, with tests `plugin.test.ts:99-109, 411-490, 640-670`.
- `packages/credentials-admin-routes/src/destination-routes.ts:216-457`, with tests `destination-handlers.test.ts:581-745`.
- `packages/cli/src/commands/credentials.ts:97-106`, with tests.
- `presets/k8s/src/__tests__/connector-delete-composition.test.ts:152-278`: seed agent-scope keys and markers instead, and expect the user ones gone.

**Requirements:** apply the "Rulings carried in" bullets for the connectors credential plan, the Test probe, delete-time purges, the destination routes, the CLI and skill-broker's `haveExisting`. Specifically:
- Every place in these packages that writes or reads an `account:` ref at **explicit user scope** is changed or deleted.
- Any test that only proved person-level behaviour is deleted, and any test that proved a still-true property is rewritten to agent or global scope.
- Grep afterwards for `scope: 'user'` / `scope:'user'` near `account:` across these packages, and for `'personal'` → `'user'` scope mappings. List what's left and why in the report.

**Tests:** besides the rewrites:
- `credentialPlan` for a personal connector says `scope:'agent'`;
- the destination route for `account` is gone (404/405), and `skill` still works;
- the CLI refuses `account:` and accepts `provider:`;
- `request_capability`'s `haveExisting` is true when the agent has the key, false when only a person-level row existed (the real vault, after Task 1's flip);
- the probe for a personal connector reports `needs-key` without reading user scope.

Commit(s): one per package group is fine, e.g. `connectors: per-agent keys are planned on the agent`, `skill-broker + credentials-admin-routes + cli: no person-level connector credentials`.

### Task 4: channel-web — editor, grant card and copy stop assuming person-level credentials

**Files:**
- `packages/channel-web/src/components/settings/RemoteMcpConnectorForm.tsx` (secrets 173-176, 331-359, 485-525; copy 613-617, 781, 853, 921, 932);
- `LegacyConnectorEditDialog.tsx` (603-635, 816);
- `lib/connector-credential-slots.ts:43-50`;
- `lib/credentials.ts:196-265`;
- `lib/connectors.ts:590-628` (the plan mirror), `:661, :676` (consent copy);
- `components/workspace/GrantRow.tsx:257-270`;
- `components/workspace/AgentConnectors.tsx:138`;
- `components/settings/ConnectorOAuthConnect.tsx:162`, `components/workspace/AddConnector.tsx:523`;
- `components/settings/CredentialSlotRow.tsx` and `server/...` / `admin-routes` `GET /settings/credentials` callers (check whether `myCredentials.list` is still needed for anything; if not, delete it).
- Tests:
  - `RemoteMcpConnectorForm.test.tsx:1542-1690`;
  - `ConnectorEditDialog.test.tsx:818-855`;
  - `credentials-client.test.ts:240-305`;
  - `lib/__tests__/connectors-credential-plan.test.ts`;
  - GrantRow tests;
  - `routes-workspace-connectors.test.ts:1318-1350` (drop the `remove-personal-sign-in` stub).

**Requirements:** apply the "Rulings carried in" bullets for the admin connector editor, the skill grant card, the copy, and channel-web's destination helpers. Use the `shadcn` skill.

**Tests:**
- The editor saves the OAuth client secret at global scope for a shared connector.
- A private connector with a client secret → the "Make it Shared" message, and nothing written.
- No editor path writes user scope.
- The needs-migration UI is gone.
- GrantRow's `account:` destination shows the ask-an-admin copy and offers no key form; `skill:` still offers one.
- The copy strings are updated (assert the new text).
- `connectorHealth` and the rail are unaffected.

Commit: `channel-web: connector credentials are never entered per person`.

### Task 5: Gate + memory

- [ ] Run the full gate: `pnpm build && pnpm lint && pnpm -r --workspace-concurrency=2 --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`. Re-run Docker-timeout packages alone.
- [ ] Write the shards with `scripts/memory-write-target.sh --shard decisions SIGNINS-7` and `--shard context SIGNINS-7`. Record:
  - the flip and the refusal;
  - the two boot steps, their owners and the marker key;
  - the dropped table;
  - the plan scope `'agent'`;
  - the editor, grant card, destination route and CLI rulings;
  - "main is deployable after this slice";
  - `Deleted in SIGNINS-7:` tombstones for every deleted file path.
