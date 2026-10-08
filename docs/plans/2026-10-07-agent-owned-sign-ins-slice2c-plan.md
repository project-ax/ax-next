# Agent-owned sign-ins — Slice 2c (agent-proposed connectors go to admins) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A connector an agent proposes with `connector_propose` lands in **Admin › Connectors → Awaiting approval**, where admins see every user's proposals.
- An admin approves one by creating the connector, using the normal editor prefilled from the proposal.
- People then add it to their agents from the rail.
- Nothing lets a non-admin create a connector any more.

**Architecture:**
- **Drafts.** The existing authored-draft store stays the queue. It gains all-owners reads and clears (system-scoped, in `scope.ts`).
- **Approval is creation.** When `connectors:upsert` creates a live connector, every pending draft with that id is cleared on the server, so there's no separate grant path to keep in step.
- **What's deleted:**
  - the chat-orchestrator grant (`agent:apply-authored-connector-grant`);
  - the in-chat connector card;
  - the non-admin authored routes;
  - the Settings approve dialog;
  - the `connector_propose` freshness digest;
  - skills `cap-migration`'s connector creation.
- **What's reworded:** the tool text, the held-call clause and the built-in skills.

**Tech Stack:** TypeScript, vitest, Kysely/Postgres (testcontainers), React + shadcn (channel-web).

**Spec:** `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md`: "What people see" (Admin › Connectors, *Awaiting approval*) and §4. Slice 2c of the 2a/2b/2c split. **Prereqs:** slices 1, 2a, 2b.

## Global Constraints

- No cross-plugin imports (invariant 2). @ax/connectors must not declare any `agents:*` call (cycle).
- **No half-wired code (invariant 3).** Everything the old flow used and nothing uses any more is deleted in the same task that stops using it, along with its tests:
  - hooks, routes, types, `optionalCalls` entries, client helpers, components, card kinds.
- UI uses shadcn and semantic tokens only (invariant 6). Invoke the `shadcn` skill before UI work. Copy should be plain, short and warm.
- Payload names stay storage-agnostic.
- **Product owner decisions:**
  - only admins define connectors;
  - "I don't care if existing skills are broken."
- `export DOCKER_HOST=unix:///var/run/docker.sock AX_TESTCONTAINER_START_SLOT_WAIT_MS=120000`. Run Docker suites one at a time. Use `pnpm --filter <pkg> test` (filter first) plus tsc per package, and `pnpm lint`.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01YZ4rcdtzRxcf4xooEWqvx8`.

## Rulings carried in

- **The in-chat connector card is removed, not made informational.** Cards replay on reconnect and re-fire every turn, so an informational card would need a new lifecycle for no gain. The tool reply tells the model "I've asked your workspace admin", and the model tells the person.
- **Approval is creation.** Any `connectors:upsert` that **creates** a live connector clears all pending drafts with that id, whoever proposed them. No grant, no approved-caps rows, no auto-attach.
- **The `connectors.propose` hold stays,** reworded to "ask your workspace admin to add a new connection". It throttles agent spam into the admin queue.
- **The `connector_propose` freshness digest is dropped.** A replayed call now only writes a draft and can't replace a live connector.
- **Skills `cap-migration` stops creating connectors.** It still strips the legacy capabilities block so manifests parse. Skills that relied on that reach break, which the owner accepted.
- **The `keyMode` stored values stay `personal`/`workspace`** (the 2a ruling).

## Review Focus

- **A non-admin calling any remaining authored route or the old card decision endpoint** gets 403/404/405, never a created connector.
- **Two people propose the same id; an admin creates it:** both drafts disappear, and the next turn shows no card or proposal for either.
- **A proposal for an id that already exists as a live shared connector:** the tool answers that it's already available, telling them to add it from Connectors. No draft is left in the queue.
- **An old persisted connector card in the chunk buffer from before the upgrade:** reconnect must not crash or render a dead Connect button.
- **The admin "Set it up" prefill:** saving creates a **shared** connector owned by the admin with the admin's key choice, never the proposer's.

---

### Task 1: Connectors — all-owners proposal queue; creation clears drafts; proposal dedup

**Files:** `packages/connectors/src/{scope.ts, authored-store.ts, plugin.ts, store.ts, types.ts, admin-routes.ts}`; tests in `packages/connectors/src/__tests__/` (`authored-hooks`, `authored-store`, `admin-routes`, `admin-route-gate`, `leak-guard`, `plugin`).

**Requirements:**

1. **New system-scoped reads and deletes in `scope.ts`, with store methods:**
   - list every **pending** draft across owners;
   - clear every draft with a given id, across owners.
2. **New service hook `connectors:list-authored-pending-all` (admin use only).** It takes `{}` and returns `{ drafts: [{ ownerUserId, agentId, connectorId, name, usageNote, keyMode, proposal, updatedAt }] }`.
   - Drop drafts whose id is already live under any owner. Use `hasLiveById`.
   - Add the field names to the types and returns schema.
3. **New service hook `connectors:clear-authored-by-id {connectorId} → {cleared}`.**
4. **`connectors:upsert` clears drafts when it creates.** When it **creates** a live row (`created === true`), clear every draft with that id across owners. It's best-effort: log on failure, never fail the upsert.
5. **`connectors:install-authored` dedup.** If any **live** connector with that id exists (`hasLiveById`, any owner), return `{ status: 'active' }` and write no draft. Today it checks only the proposer's own rows.
6. **Routes:**
   - Delete the user-mode authored routes (`GET /settings/connectors/authored`, `POST …/authored/:id/approve`, `DELETE …/authored/:id`) and their handlers and tests.
   - Add admin routes (adminOnly, admin bundle):
     - `GET /admin/connectors/authored` lists all pending proposals. Enrich each with the proposer's display name/email via `auth:get-user` (fail-soft: on null or throw show the id). The agent name is not required: say "one of <name>'s agents".
     - `DELETE /admin/connectors/authored/:connectorId` (Dismiss) clears every draft with that id.
   - There is no approve route. Approving is `POST /admin/connectors`, which already enforces `requireUniqueId`, and requirement 4 clears the drafts.
7. **Remove `connectors:list-authored-pending` (per user) and `connectors:activate-authored`** once nothing calls them. Task 2 removes the orchestrator's calls; if a caller still exists after Task 1, leave it until Task 2 and note that. Keep `list-authored` / `clear-authored` only if something still uses them after Task 2.

**Tests:**
- all-owners list (two proposers, plus one dropped because its id is live);
- clear-by-id;
- creating via `connectors:upsert` and via `POST /admin/connectors` clears both proposers' drafts, while an *edit* does not;
- install-authored on a live id returns `active` with no draft;
- the admin routes' auth: a non-admin gets 403;
- the removed user routes are unregistered (the gate test pins the exact `/settings/connectors*` set: only the GET list and GET `:id` remain);
- display-name enrichment fails soft.

Commit: `connectors: proposals queue for admins; creating a connector resolves its proposals`.

### Task 2: Remove the chat approval path (orchestrator + channel-web server)

**Files:**
- `packages/chat-orchestrator/src/{orchestrator.ts, plugin.ts, connector-card.ts}` and tests;
- `packages/channel-web/src/server/{routes-chat.ts, plugin.ts, chunk-buffer.ts, sse.ts, grant-declines.ts, routes-workspace.ts}` and tests (`routes-chat-card-eviction`, `chunk-buffer`, `sse`, `routes-workspace-grants`, server `plugin.test`).

**Requirements:**
- Delete `agent:apply-authored-connector-grant` with its types, registration and tests.
- Delete the `connectors:proposed` subscriber, `fireUpfrontConnectorCards` and its warm-turn and fresh-spawn call sites, the per-conversation card dedup, and `connector-card.ts` if it's now unused.
- `connectors:proposed` itself: if nothing subscribes any more, stop firing it from connectors **and** delete its type. Don't leave an event nobody listens to.
- In `routes-chat.ts` `postPermissionDecision`, delete the connector branch. Any remaining request shape for a connector decision answers 400 (or whatever an unknown kind gets today) and creates nothing.
- Remove the `optionalCalls` entry in the channel-web server plugin.
- **Persisted connector cards.** `chunk-buffer` and `sse` must tolerate an old persisted `kind:'connector'` card: drop it on replay, never render it, never crash. Add a test for exactly that.
- Remove the decline persistence for connectors (`grant-declines` kind `'connector'`) if nothing else uses it. Keep the skill kind.
- Check `routes-workspace.ts` grants reading (`readGrants` ~5630, revoke ~4558) for dependence on authored-connector approved-caps rows. Since no new rows are written, the code must still handle existing old rows (show and revoke them) but needs no new path. Note what you find.

**Tests:** delete the obsolete tests. Add:
- old-card replay is dropped safely;
- a connector decision POST creates nothing;
- the orchestrator no longer fires a card when a draft exists.

Commit: `chat: agent-proposed connectors no longer open an approval card in chat`.

### Task 3: Admin UI — Awaiting approval

**Files:**
- `packages/channel-web/src/components/settings/ConnectorsTab.tsx`, `ProposedConnectorApproveDialog.tsx` (delete);
- `components/workspace/GrantRow.tsx` (remove the connector arm), `lib/grant-copy.ts`, `lib/workspace-grant-store.ts` (remove the connector-grant precedence if dead);
- `lib/connectors.ts` (client helpers);
- the editor prefill path (`RemoteMcpConnectorForm.tsx` / `ConnectorEditDialog.tsx` / `LegacyConnectorEditDialog.tsx`);
- the dev mock `packages/channel-web/mock/admin/connectors.ts`;
- tests.

**Requirements:**
- In the Admin › Connectors tab, rename the "Proposed by your assistant" shelf to **"Awaiting approval"**, listing **all** users' proposals from `GET /admin/connectors/authored`. Each row shows:
  - the name;
  - "Asked for by <proposer> for one of their agents";
  - the hosts or servers it would reach (plain text, untrusted, escaped);
  - **Set it up** and **Dismiss**.
- **Set it up** opens the normal create editor **prefilled** from the proposal: name, usage note, MCP servers or hosts, credential slot names and key-mode hint. The admin decides the key choice (fill in a shared key, or leave blank for each agent).
  - Saving goes through the normal create path. The server clears the proposals (Task 1), and the shelf refreshes.
  - The proposal's key-mode is only a hint. The editor's rule applies (a filled key means shared).
- **Dismiss** confirms ("Dismiss this request? The person won't be notified.") and calls DELETE.
- Delete `ProposedConnectorApproveDialog` and its tests, the old client helpers (`listAuthoredPending`, `approveAuthoredConnector`, the user-scoped `rejectAuthoredConnector`) and the connector arm of `GrantRow`, with their tests.
- Use the `shadcn` skill. No new raw styling.

**Tests:**
- the shelf lists two proposers' requests;
- Set it up prefills the editor, and a save calls `POST /admin/connectors` with `visibility:'shared'`;
- Dismiss calls DELETE;
- GrantRow has no connector arm;
- the dev mock mirrors the server.

Commit: `channel-web: Admin › Connectors shows requests awaiting approval`.

### Task 4: Tool, held call and skill text; drop freshness

**Files:**
- `packages/tool-connector-propose/src/{descriptor.ts, plugin.ts, freshness.ts}` and tests;
- `packages/tool-policy/src/rules.ts` and tests;
- `packages/decisions/src/templates.ts` and tests;
- `presets/k8s/src/builtin-skills/ax-connector-creator/SKILL.md`, `ax-skill-creator/SKILL.md`;
- `presets/k8s/src/__tests__/builtin-skills.test.ts`;
- `packages/agent-runner-core` `system-prompt.test.ts`, if it pins the text.

**Requirements:**
- **Descriptor.** The proposal goes to a workspace admin. The person doesn't approve a card. Once an admin sets it up, the person adds it to the agent from the Connectors tab. Keep the `keyMode` guidance, but describe it as a hint the admin decides. Don't narrate approval mechanics beyond one honest sentence.
- **Tool reply.** Add a human-readable `message` next to `{connectorId, status}`. Use plain text that adds no new trust:
  - `pending` → "Sent to your workspace admin for approval. Once they set it up, add it to this agent from the Connectors tab."
  - `active` → "This connector already exists. Add it to this agent from the Connectors tab."
- **Freshness.** Delete the freshness digest registration and `freshness.ts` and their tests. Make sure nothing else imports them.
- **Held call.** Change the `connectors.propose` rule clause to "ask your workspace admin to add a new connection". The verdict stays `hold`. Update the decisions template and tests.
- **Built-in skills.** Rewrite the approval sections of `ax-connector-creator/SKILL.md` to the new flow, and update the one pointer line in `ax-skill-creator`.

Commit: `connector_propose: requests go to a workspace admin`.

### Task 5: Skills cap-migration stops creating connectors

**Files:** `packages/skills/src/cap-migration.ts`, `packages/skills/src/plugin.ts` (wiring and `optionalCalls`), tests.

**Requirement:**
- Keep stripping a legacy `capabilities:` block so the manifest parses. **Stop** calling `connectors:upsert`, and log that the skill's legacy reach was dropped (the owner accepted broken skills).
- Remove `connectors:upsert` from skills' `optionalCalls` if nothing else in skills uses it.
- Update the module header to say so.

**Tests:** a legacy skill row is migrated (block stripped) and **no** connector is created.

Commit: `skills: legacy capability migration no longer creates connectors`.

### Task 6: Gate + memory

- [ ] Run the full gate: `pnpm build && pnpm lint && pnpm -r --workspace-concurrency=2 --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.
- [ ] Write the shard: `shard=$(scripts/memory-write-target.sh --shard decisions SIGNINS-4)`. Record:
  - the card was removed, not made informational, and why;
  - approval is creation, and creation clears drafts;
  - the hold stays and the freshness check was dropped;
  - cap-migration stopped creating connectors;
  - no non-admin path creates a connector.
