# TASK-1212: a website Allow on a team agent covers the whole team (plus the TASK-1208 follow-ups) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a team agent, one website Allow covers every member's later sessions of that agent. On a personal agent nothing changes. Owners and team admins can see and remove the site in the agent's settings. The TASK-1208 review follow-ups land in the same PR: copy, the late Allow line, the cap message, the web "Always" after a session ends, the outsider write-up, and two nits.

**Architecture:** There is no new store, no scope column and no agent-row allowlist. `@ax/host-grants` keeps its table, but `list`, `revoke`, the duplicate check and the 256 cap are keyed by **agent**. `owner_user_id` now means "who added it". Every writer already proves the person may use the agent, so a personal agent's rows are all its owner's. Its list is therefore byte-for-byte what it was, and a team agent's list becomes the union of its members' adds. channel-web gates removal on the existing `agents:can-manage-connectors` answer. For a late Allow, the orchestrator seeds the existing TASK-1199 "now allowed" record at session open with the sites added since the agent last spoke in that conversation.

**Tech Stack:** TypeScript, Kysely/Postgres (testcontainers), React (shadcn), vitest, pnpm workspace. No new dependencies.

**Spec:** card TASK-1212 and its DECIDED block (Vinay, 2026-11-23): "on a TEAM agent, one website Allow covers every member's sessions of that agent. On a personal agent, it stays per (person, agent). The 'Once allowed, it stays allowed' copy is then true for everyone. Owners and team admins can see and remove the host in the agent's settings. Outsider turns run as the requester, so they get it too … This widens a capability on purpose." Predecessor: `docs/plans/2026-11-22-task-1208-host-allow-per-agent-plan.md`, review row 18 of `.claude/memory/decisions/2026-11-22-TASK-1208.md`. Decisions: `.claude/memory/decisions/2026-11-23-TASK-1212.md`.

**Tasks:** 9. Tiers: 3 mechanical, 2 integration, 4 sensitive. Order: 1 → 2 → 3, and 1 → 4 → 5, and 1 → 8. Tasks 6 and 7 can run any time. Task 9 goes last.

## Premise check (code read at f952512ad)

- **Holds:** a kept site is per (person, agent). The PK is `(owner_user_id, agent_id, host)` (`host-grants/src/migrations.ts:18-25`). The orchestrator loads `host-grants:list({ ownerUserId: ctx.userId, agentId })` at fresh spawn (`chat-orchestrator/src/orchestrator.ts:4551-4563`). The Slack Allow and the web "Always" both file it under the clicker (`channel-slack/src/permission-prompts.ts:206-221`, `channel-web/src/server/routes-allow-host.ts:139-157`).
- **Refined:** the card says "That needs a team-scoped grant in host-grants, or an agent-level allowlist". Neither is needed. A per-agent read of the existing table gives the decided behavior: only an agent's owner can write rows for a personal agent, so its read is unchanged. An agent-row allowlist would also be wrong for another reason. `agent.allowedHosts` is the credential-binding list (TASK-687, `orchestrator.ts:4198-4209`), so a granted host would be sent the agent's provider key.
- **Refined:** item 2 ("team copy over-promises") is made true by item 1. "Once allowed, it stays allowed.", "Allowed from now on." and "Always for this agent" become accurate for everyone, so no prompt copy changes. The copy work moves to the surfaces that still imply "yours": the agent settings group "Granted by you", Settings › Sites, and the pending changeset `.changeset/slack-host-allow-remembered.md:8`.
- **Refined:** "the agent's settings" today is AgentSettings › Connectors › "Granted by you" (`ConnectorsTab.tsx:203-223`, data from `readGrants`, `routes-workspace.ts:6647-6710`). It shows only the reader's own rows and has no role check. Global Settings › Sites (`AllowedSitesPanel.tsx`) lists the reader's own rows across every agent, team agents included, and lets any member add or remove there (`routes-connections.ts:434-568`). Both have to change.
- **Confirmed (item 6):** outsider turns run as the bot's requester (`channel-slack/src/router.ts:566`, `channel-route.ts:88`, ctx `source: 'external'` at `turn.ts:160-162`). Routine runs run as the routine's owner (`routines/src/fire.ts:269-274`). After Task 2, the session-open read carries no user at all, so a member, an outsider's turn and a routine all load the agent's list.
- **Confirmed (item 3):** nothing carries a "now allowed" note across sessions. The record is per session and in memory (`credential-proxy/src/plugin.ts:563-568`), and it is forgotten on close (`:925-929`). The conversation's `lastActivityAt` is bumped only by content turn-ends (`conversations/src/plugin.ts:911-922`). Routing reads it before a fresh spawn (`orchestrator.ts:3281`), and host grants carry `grantedAt`.
- **Confirmed (items 4, 5, 7):** at the cap, Slack says "Allowed for now" or "I'd already finished…" with no reason. The web route swallows `grant-limit` and answers `{ added: true }`, so the toast says "Site allowed", and its warn log carries `host: body.host` (`routes-allow-host.ts:152-155`). The web "Always" keeps nothing once `added: false`. The bus throws `invalid-return` after a handler's answer fails its `returns` schema (`core/src/hook-bus.ts:417-426`), and Slack treats that as "try again". The gate-level host tests (`answers.test.ts:1793-1888`) never check that a refused click keeps nothing.

## Approaches

| Option | Verdict |
|---|---|
| **Per-agent reads of the existing table; `owner_user_id` = who added it** (chosen) | No migration (one additive index) and no new store. host-grants needs no team knowledge. Personal agents are unchanged by construction. One rule for every reader: the orchestrator, the rail, Settings and the late line. |
| A scope column, with each caller passing `scope` from the agent's visibility | Five callers must agree on the scope (Slack, the allow-host route, the rail, Settings, the orchestrator). One that forgets files a row no team reader sees. Needs a PK migration. |
| host-grants resolves visibility itself (`agents:resolve` per call) | Adds a new edge plus an ACL'd lookup on every call. `agents:resolve` also fires `agents:resolved` for the probed user. |
| An agent-level `allowedHosts` in `@ax/agents` | A second allowlist store (invariant 4). The field doubles as the credential binding (TASK-687), so it would leak the provider key. |
| Fan-out: one row per current member | New members miss the site. The member list is admin-only (`teams:list-members`). |

## Global Constraints

- The decision is binding: on a team agent one Allow covers every member's sessions; on a personal agent nothing changes. Who may click Allow is unchanged. Do not edit `channel-slack/src/answers.ts` or `turn.ts`, except tests.
- Hook surface: `host-grants:list` input becomes `{ agentId }`. `host-grants:revoke` input becomes `{ agentId, host }`. `host-grants:grant` keeps `{ ownerUserId, agentId, host }`, where `ownerUserId` is the person adding it. `host-grants:list-for-user` is unchanged and lists the rows that person added. `proxy:open-session` gains an optional `newlyAllowedHosts?: string[]`. No new hooks. None of these is an IPC action, and the runner reaches none of them. The PR carries the boundary review below.
- Who may remove a site on a team agent: `agents:can-manage-connectors`, asked with the person's own `{ userId, isAdmin }`, through channel-web's existing `connectorsManageable` (`routes-workspace.ts:5022-5036`). It fails closed. On a personal agent, its owner (`agents:resolve` already proved it).
- Logs never carry a host, a session id, a user or agent id, or a token. `slack_prompt_failed` keeps exactly `{ installId, kind, stage, code }`. channel-web's `host_grant_persist_failed` becomes `{ code }`.
- Copy below is a draft. The builder's ux-designer pass may reword it, but must keep three rules: never "from now on" or "Site allowed" unless the site was kept; a full list says it is full; nothing names the host (model-chosen text). Slack copy uses straight apostrophes (`copy.ts`). Web copy uses curly ’ (`grant-copy.ts`).
- Invariant 6: no new components. Compose the existing shadcn primitives and invoke the `shadcn` skill before touching `ConnectorsTab.tsx`, `AllowedSitesPanel.tsx`, `SiteAgentsDialog.tsx` or `GrantRow.tsx`.
- Stay off siblings' files. TASK-1213: `packages/memory/**`, `packages/session-postgres/**`, `packages/ipc-core/**`. TASK-1214: `packages/channel-web/src/components/admin/AgentForm.tsx`. TASK-1207: `packages/tool-policy/**`, `packages/agent-claude-sdk-runner/**`. Also leave `packages/agent-runner-core/src/egress-note.ts` alone: the line and the block note keep their words.
- Tests run as `pnpm --filter @ax/<pkg> test` (filter first), with `pnpm --filter @ax/<pkg> build` beside them, because vitest tolerates type drift. `@ax/host-grants` and `@ax/preset-k8s` need Docker: set `DOCKER_HOST` (CLAUDE.md "Docker-backed tests"). Before the PR: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, plus `pnpm lint`.

## Review Focus

1. **A plain member removing a team site.** The UI shows no Revoke, and a forged POST gets 403 with nothing removed. A team admin's Revoke removes it for everyone. Pinned in Task 4.
2. **Two members allow the same host, or rows from before this card duplicate one.** Every list shows one site, one Revoke removes it for everyone, and the cap counts it once. Pinned in Task 1.
3. **A late Allow:** a day-old Slack prompt, or a web "Always" after the session ended. The site is kept, and the next fresh session's first message carries the "now allowed" line once. A message routed into a still-live session gets no second line. Pinned in Tasks 3, 6 and 7.
4. **A team agent at 256 distinct sites across members.** Slack and the web say the list is full, and neither says "from now on" or "Site allowed". Pinned in Tasks 1, 6 and 7.
5. **A forged web "Always" naming an agent the person can't use (ended session).** Nothing is kept, and the answer is identical for "no such agent" and "not yours". Pinned in Task 6.

---

### Task 1: `@ax/host-grants`: an agent's allowed sites belong to the agent [tier: sensitive]

`security-checklist` required: this moves the store's isolation boundary from (person, agent) to agent, which deliberately widens egress on team agents.

**Files:**
- Modify: `packages/host-grants/src/store.ts`: the header (`:1-6`), `MAX_GRANTS_PER_AGENT` doc, the `HostGrantsStore` interface, `grant`, `list` and `revoke`. `listForUser` and `deleteAllForAgent` are unchanged.
- Modify: `packages/host-grants/src/types.ts`: `HostGrantsListInput`, `HostGrantsRevokeInput`, and the field docs.
- Modify: `packages/host-grants/src/plugin.ts`: the list and revoke handlers (`:97-121`). Add a header paragraph stating the callers' contract ("prove the person may use the agent before `grant`, and may manage it before `revoke`; host-grants checks no ACL"). Update the TASK-718 comment at `:64-67`.
- Modify: `packages/host-grants/src/migrations.ts`: add the index, and update the header `:8-14`.
- Test: `packages/host-grants/src/__tests__/store.test.ts`, `plugin.test.ts`, `migrations.test.ts`, `host-grants.canary.test.ts` (its `list`/`revoke` calls at `:61-85` move to the new shapes).

**Interfaces:**
- Produces:
  ```ts
  interface HostGrantsGrantInput { ownerUserId: string; agentId: string; host: string } // ownerUserId = who adds it
  interface HostGrantsListInput { agentId: string }
  interface HostGrantsRevokeInput { agentId: string; host: string }
  // outputs unchanged: { created: boolean } | { hosts: { host: string; grantedAt: string }[] } | { revoked: boolean }
  // store
  grant(input: { ownerUserId: string; agentId: string; host: string }): Promise<{ created: boolean }>;
  list(agentId: string): Promise<HostGrant[]>;           // one entry per host, earliest grantedAt, host asc
  revoke(input: { agentId: string; host: string }): Promise<{ revoked: boolean }>; // every adder's row for that host
  ```
  - `grant` answers `created: false`, with no insert, when **any** row exists for (agent, host).
  - It throws `grant-limit` when the agent already has 256 **distinct** hosts.
  - The cap and the duplicate check run in that order, so re-granting a host already kept is never limited.
  - Migration: `CREATE INDEX IF NOT EXISTS host_grants_v1_grants_agent_host ON host_grants_v1_grants (agent_id, host)`.

- [ ] **Step 1: Write the failing store tests** (`store.test.ts`; replace the per-(user, agent) tests at `:48-138`)
  - `it("list is the agent's: every adder's hosts, once each, ordered by host")`
    - Setup: mel grants `b.example.com` and `a.example.com` on `agt_team`; ada grants `c.example.com` on `agt_team`; mel grants `z.example.com` on `agt_other`.
    - Expect: `list('agt_team')` hosts `['a.example.com','b.example.com','c.example.com']`; `list('agt_other')` hosts `['z.example.com']`.
  - `it('a host already on the agent is a no-op for anyone')`
    - Mel's grant of `x.example.com` → `{created:true}`. Ada's → `{created:false}`.
    - `listForUser('ada')` → `[]`: no row is filed under her.
  - `it('rows from before (one host under two adders) read as one site with the earliest grantedAt')`
    - Insert raw rows `(mel, agt_team, x, t1)` and `(ada, agt_team, x, t2 > t1)`.
    - `list('agt_team')` → `[{ host: 'x.example.com', grantedAt: t1.toISOString() }]`.
  - `it('revoke takes the host off the agent for everyone, and only on that agent')`
    - Rows: mel x on team, ada x on team (raw), mel x on other.
    - `revoke({agentId:'agt_team', host:x})` → `{revoked:true}`. Then `list('agt_team')` is `[]` and `list('agt_other')` is `[x]`.
    - A second revoke → `{revoked:false}`.
  - `it('the 256 cap is per agent, counted once per host whoever added it')`
    - Mel adds 128 hosts and ada adds 128 others on `agt_team` (raw-insert a duplicate of one of them under the other person too).
    - Anyone's new host → `grant-limit`.
    - Re-granting an existing host → `{created:false}`.
    - `agt_other` still takes one.
  - `it("a personal agent's list is exactly what its owner kept (unchanged)")`: owner grants two hosts; `list` returns both; `revoke` removes one.
  - Keep `listForUser` (`:85`), `rejects an invalid host` (`:104`) and `deleteAllForAgent` (`:140-176`) as they are.

- [ ] **Step 2: Write the failing plugin, migration and canary tests**
  - `plugin.test.ts`: `'grant → list → revoke round-trips over the bus'` uses `{ agentId }` and `{ agentId, host }`.
  - `plugin.test.ts`: new `it("one person's grant is in the agent's list, read with agentId alone")`.
  - `plugin.test.ts`: new `it('list and revoke without agentId are missing-field')`.
  - `migrations.test.ts`: new `it('adds the (agent_id, host) index, idempotently')`, reading `pg_indexes WHERE indexname = 'host_grants_v1_grants_agent_host'` after two runs.
  - Canary: move to the new shapes.

- [ ] **Step 3: Run them and see them fail.** Run `DOCKER_HOST=<your socket> pnpm --filter @ax/host-grants test`. Expected: the new tests FAIL on per-(user, agent) keys.

- [ ] **Step 4: Implement** the store, the types, the plugin handlers and the index.
  - `list` is `GROUP BY host` with `MIN(created_at)`, ordered by host.
  - The cap is `count(distinct host)`.
  - Keep TASK-44's accepted race comment, extended: two people adding one host at once may leave two rows. That is harmless because reads group and revoke deletes both.
  - Rewrite the store header: "An agent's allowed sites belong to the agent. `owner_user_id` records who added a row. On a personal agent only its owner can add, because every writer checks access to the agent first, so its list is the owner's."

- [ ] **Step 5: Run and see them pass.** Run the same command, then `pnpm --filter @ax/host-grants build`. Expected: PASS, and tsc is clean.

- [ ] **Step 6: Commit** `[TASK-1212] host-grants: an agent's allowed sites belong to the agent (team-wide on team agents)`.

### Task 2: chat-orchestrator: load the agent's sites, whoever's session it is [tier: mechanical]

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:4542-4563`. Send the call as `{ agentId: agent.id }`, with a matching local input type. Rewrite the TASK-44 comment: "the agent's allowed sites. On a team agent, every member's session, an outsider's turn (run as the bot's requester) and a routine run load the same list. On a personal agent only its owner ever adds to it (TASK-1212). Still fails open."
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts:5213-5250`.

**Interfaces:** Consumes Task 1's `host-grants:list({ agentId })`.

- [ ] **Step 1: Change the TASK-44 assertion** to `expect(listInput).toEqual({ agentId: 'test-agent' })`. Comment: no user in the key, so an outsider's turn, a routine and every member read the agent's list (item 6).
- [ ] **Step 2: Run** `pnpm --filter @ax/chat-orchestrator test -- orchestrator.test`. Expected: FAIL (`ownerUserId` is still sent).
- [ ] **Step 3: Implement** the change above.
- [ ] **Step 4: Run** the same command, plus `pnpm --filter @ax/chat-orchestrator build`. Expected: PASS.
- [ ] **Step 5: Commit** `[TASK-1212] chat-orchestrator: a session loads its agent's allowed sites`.

### Task 3: the "now allowed" line reaches the next session after a late Allow [tier: sensitive]

`security-checklist` required: this touches credential-proxy's session open and puts stored hosts into the model's prompt through the existing line. It needs a boundary review for `proxy:open-session`.

**Files:**
- Modify: `packages/credential-proxy/src/plugin.ts`:
  - `OpenSessionInput` (`:240-…`) gains `newlyAllowedHosts`.
  - The open-session handler records them right after `sessions.set(input.sessionId, sessionConfig)` (`~:830`).
  - Comments at `:350-370` and `:925-929`: a kept site comes back at the next open through this field.
- Test: `packages/credential-proxy/src/__tests__/allowed-hosts-drain.test.ts`.
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`:
  - Local `ConversationsGetOutput.conversation` (`:701-709`) gains `lastActivityAt?: string | null`.
  - Local `ProxyOpenSessionInput` (`:598-…`) gains `newlyAllowedHosts?: string[]`.
  - Declare `let priorActivityAt: string | null = null` before the routing block, and set it from `conv.conversation.lastActivityAt` at `:3281`. Both sites are inside `runAgentInvokeTurn` (`:3075`).
  - The Task 2 load computes the list.
  - The `proxy:open-session` call (`:4626-4636`) passes it.
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`, beside the TASK-44 tests.

**Interfaces:**
- Produces: `proxy:open-session` input `newlyAllowedHosts?: string[]`. These are hosts the agent should be told are allowed now.
  - The proxy records each one that is a string, passes `HOST_RE` and is on `allowlist` into `allowedSinceDrain` for the new session. That record caps at 32 and surfaces each host once.
  - So the first `proxy:drain-session-allowed-hosts` returns them, and the runner's existing TASK-1199 line says so. Anything else is ignored. The field grants nothing.
- Orchestrator rule: a host is reported when all of these hold:
  - it comes from `host-grants:list`;
  - its `grantedAt` is strictly later than `Date.parse(priorActivityAt)`;
  - it was not already in `baseAllowSet` before the grants were added (from the provider, the agent row, connectors or registries).
  
  Report `[]` when there is no conversation, `lastActivityAt` is null, a timestamp won't parse, or the read failed. Fresh spawns only: a routed turn changes nothing.

- [ ] **Step 1: Write the failing proxy tests** (`allowed-hosts-drain.test.ts`)
  - `it('open-session: newly allowed hosts on the allowlist are reported once, at the first drain')`: allowlist `['a.example.com','b.example.com']`, `newlyAllowedHosts: ['b.example.com']`. First drain → `{ hosts: ['b.example.com'] }`; second → `{ hosts: [] }`.
  - `it('a newly allowed host that is not on the allowlist, or is not a host, is never reported')`: `['c.example.com', 'NOT A HOST', 42]` → `[]`.
  - `it('close-session forgets them')`.
  - `it('no newlyAllowedHosts: nothing reported (unchanged)')`.
- [ ] **Step 2: Write the failing orchestrator tests** (stub `conversations:get`, `conversations:bind-session` and `session:is-alive` so routing runs; ctx carries a `conversationId`)
  - `it('TASK-1212: a fresh spawn reports the sites allowed since the agent last spoke in this conversation')`: `lastActivityAt: T0`; grants `old.example.com@T0-1h`, `new.example.com@T0+1h` → open input `newlyAllowedHosts: ['new.example.com']`, and both are in `allowlist`.
  - `it('… nothing when the conversation has no lastActivityAt, or there is no conversation')` → `[]`, or the field is absent.
  - `it('… a site another source already allows is not reported')`: a grant `api.anthropic.com@T0+1h` while `TEST_AGENT.allowedHosts` already holds it.
  - `it('… a turn routed into a live session reads no grants and opens nothing')`.
  - Extend the fail-open test (`:5252`): `host-grants:list` throws → `newlyAllowedHosts` is empty or absent.
- [ ] **Step 3: Run** `pnpm --filter @ax/credential-proxy test -- allowed-hosts-drain` and `pnpm --filter @ax/chat-orchestrator test -- orchestrator.test`. Expected: FAIL.
- [ ] **Step 4: Implement** both halves as specified.
- [ ] **Step 5: Run** both commands, plus `pnpm --filter @ax/credential-proxy build` and `pnpm --filter @ax/chat-orchestrator build`. Expected: PASS.
- [ ] **Step 6: Commit** `[TASK-1212] a site allowed while the agent wasn't running reaches its next reply as the "now allowed" line`.

### Task 4: channel-web server: a team agent's sites in its settings (everyone sees, owners and team admins remove) [tier: sensitive]

`security-checklist` required: this changes who may revoke, and it widens what members can read.

**Files:**
- Modify `packages/channel-web/src/server/routes-workspace.ts`:
  - `rail` (`:8543-8563`) uses `authActorOr401` (`:2278`) and calls `readGrants(actor, agent)`.
  - `readGrants` (`:6647-6710`) lists sites with `{ agentId }`. Site rows get `revocable` as below, and the group gets `shared`. The approved-capability half is unchanged and still per person.
  - `revokeGrant` (`:8576-8615`) uses `authActorOr401`. Its site branch runs the manage check, then `host-grants:revoke({ agentId, host })`. Rewrite the comment at `:8600-8602`.
- Modify `packages/channel-web/src/server/routes-connections.ts`:
  - The local `AgentsResolveOutput.agent` (`:39-41`) gains `visibility?: 'personal' | 'team'`.
  - `addAllowedSite` (`:434-489`) and `revokeAllowedSite` (`:547-568`) answer **403 `{ error: 'team-agent' }`** for any agent whose `visibility !== 'personal'`, before any host-grants call.
  - `listAllowedSites` uses `{ agentId }`, and revoke uses `{ agentId, host }`.
  - Update the comments at `:64`, `:404-411` and `:491-497`.
- Modify `packages/channel-web/src/lib/workspace-types.ts`:
  - `AgentRailData.grants` gains `shared: boolean`.
  - The `GrantRow.revocable` doc (`:553-558`) adds: "…or the reader may not take it back: a team agent's site is for its owners and team admins to remove."
- Modify `packages/channel-web/src/server/plugin.ts:231-266`: comments only. The degradation strings stay, so their pins in `plugin.test.ts:762-777` don't move.
- Test: `packages/channel-web/src/__tests__/server/routes-workspace-rail.test.ts` (stubs at `:296-300`, `:1317-1392`) and `routes-connections.test.ts` (`:110-130`, `:275-460`).

**Interfaces:**
- Produces: `AgentRailData['grants']` is `{ status; rows: GrantRow[]; incomplete: boolean; shared: boolean }`. `shared` is `agent.visibility === 'team'`.
- `sitesManageable` is `agent.visibility === 'personal' || await connectorsManageable(agent.id, actor)`. It fails closed: no hook, a throw or an unreadable answer all mean false. Ask it only when the agent isn't personal and `host-grants:revoke` exists.
- A site row's `revocable` is `hasService('host-grants:revoke') && sitesManageable`.
- `POST /api/workspace/agents/:agentId/grants/revoke` with `{ ref: { grant: 'site', host } }` answers 403 `{ error: 'forbidden' }` unless `sitesManageable`. Otherwise it calls `host-grants:revoke({ agentId, host })` and answers `{ revoked }`.

- [ ] **Step 1: Write the failing rail tests**
  - `it("a team agent's sites: every member reads the agent's list")`: the recorded list input is exactly `{ agentId }`, a plain member sees the rows, and `grants.shared === true`.
  - `it("a plain member gets no Revoke on a team agent's site; a team admin does")`: `agents:can-manage-connectors` is stubbed per userId.
  - `it("a personal agent's owner can revoke, and the manage check is never asked")`.
  - `it('on a team agent, a missing or throwing manage check means no Revoke')`.
  - `it("a plain member's revoke of a team agent's site is 403 and nothing is removed")`.
  - `it("a team admin's revoke takes the site off the agent: host-grants:revoke({ agentId, host })")`.
- [ ] **Step 2: Write the failing Settings route tests**
  - `it("adding or removing a site on a team agent from Settings is 403 team-agent, and host-grants is never called")`.
  - The personal add, list and revoke tests move to the new shapes.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-web test -- routes-workspace-rail routes-connections`. Expected: FAIL.
- [ ] **Step 4: Implement** as specified.
- [ ] **Step 5: Run** the same command, plus `pnpm --filter @ax/channel-web build`. Expected: PASS.
- [ ] **Step 6: Commit** `[TASK-1212] channel-web: a team agent's sites are its own; owners and team admins remove them`.

### Task 5: channel-web client: say whose sites they are; Settings › Sites is for personal agents [tier: integration]

Invoke `shadcn` and run a ux-designer pass on the copy.

**Files:**
- Modify: `packages/channel-web/src/components/workspace/ConnectorsTab.tsx`: the trigger at `:203-223`, `Grants` at `:490-561`.
- Modify: `packages/channel-web/src/components/settings/AllowedSitesPanel.tsx`: the doc at `:10-22`, filtering, and the copy at `:82-111`.
- Modify: `packages/channel-web/src/components/settings/SiteAgentsDialog.tsx`: the doc at `:18-22` and the copy at `:104-105`.
- Modify: `packages/channel-web/src/lib/connections.ts`: comments at `:91`, `:113`, `:174`.
- Test: `packages/channel-web/src/components/workspace/__tests__/AgentRail.test.tsx` (`describe('AgentSettings — "Granted by you"')`, `:719`) and `packages/channel-web/src/components/settings/__tests__/AllowedSitesPanel.test.tsx`.

**Interfaces:** Consumes Task 4's `rail.grants.shared` and the per-row `revocable`.

The behavior and draft copy, by surface:

**ConnectorsTab, when `rail.grants.shared` is true:**
- The trigger reads `Granted by you and your team`.
- The empty note reads `Nothing yet — nobody has granted anything beyond the rules above.`
- When any `ref.grant === 'site'` row has `revocable === false`, add one muted line under the rows: `Sites allowed here reach everyone who uses {name}. A team admin can remove them.`
- A personal agent keeps every word it has now.

**AllowedSitesPanel:**
- Agents are limited to `visibility === 'personal'`, and grants to those agents' ids. "All agents" means every personal agent.
- If the agent list can't be read, it can't tell personal agents from team ones. Show the panel's existing error `Alert` rather than an empty list.
- The description adds: `A team agent’s sites are in that agent’s settings, under Connectors.`

**SiteAgentsDialog:** `Choose which of your personal agents may reach this site. “All agents” covers every personal agent you have now.`

- [ ] **Step 1: Write the failing tests**
  - `it("a team agent: the group is yours and your team's, and a site you can't remove says who can")`.
  - `it('a personal agent: the heading and notes are unchanged')`.
  - `it("Settings › Sites lists personal agents' sites only; a team agent's rows and badge never show")`.
  - `it('Add a site offers personal agents only, and "All agents" means all of them')`.
  - `it('when the agent list fails, the panel says so instead of showing an empty list')`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-web test -- AgentRail AllowedSitesPanel`. Expected: FAIL.
- [ ] **Step 3: Implement** with the existing primitives (`Collapsible`, `Button`, `Badge`, `Alert`) and semantic tokens.
- [ ] **Step 4: Run** the same command, plus `pnpm --filter @ax/channel-web build`. The channel-web build type-checks its tests. Also run the full channel-web suite: `AgentViewHeadings`, `ConnectorDetails` and `heading-outline` match `/Granted by you/`. Expected: PASS.
- [ ] **Step 5: Commit** `[TASK-1212] channel-web: team sites are labelled the team's; Settings › Sites lists personal agents`.

### Task 6: web Allow: "Always" sticks after the session ended; the answer says whether it was kept [tier: sensitive]

`security-checklist` required: a route that widens durable egress now accepts a browser-supplied `agentId`. That value is trusted only after `agents:resolve`.

**Files:**
- Modify: `packages/channel-web/src/server/routes-allow-host.ts`: `BodySchema` (`:45-51`), the persist block (`:126-161`), and the header (`:1-31`).
- Modify: `packages/channel-web/src/lib/credentials.ts`: `grantHost` (`:300-331`).
- Modify: `packages/channel-web/src/components/workspace/GrantRow.tsx`: `allow` (`:352-375`), and the header note at `:22-31`.
- Modify: `packages/channel-web/src/lib/grant-copy.ts`: `:166-176`.
- Test: `packages/channel-web/src/__tests__/server/routes-allow-host.test.ts`, `packages/channel-web/src/__tests__/credentials-client.test.ts`, and `packages/channel-web/src/components/workspace/__tests__/GrantRow.test.tsx`.

**Interfaces:**
- Produces (wire):
  - Request: `POST /api/chat/allow-host` with body `{ sessionId, host, persist?, agentId?: string (1..128) }`.
  - Answer: 200 `{ added: boolean; kept?: boolean; full?: true }`. `kept` is present only when `persist` is true. `full: true` appears only with `kept: false`, at the cap.
- `grantHost(input: { sessionId: string; host: string; persist?: boolean; agentId?: string }): Promise<HostGrantOutcome | null>`, where `interface HostGrantOutcome { added: boolean; kept?: boolean; full?: boolean }`. It returns `null` when a 200 can't be read.
- Route rule. These steps apply only when `persist` is true; "Just this once" answers `{ added }` exactly as now.
  1. `added: true` → the agent is the proxy's `out.agentId`; the body's `agentId` is ignored.
  2. `added: false` → `agents:resolve({ agentId: body.agentId, userId })` runs first. Any refusal or throw means nothing is kept and the answer is `kept: false`, the same for `forbidden`, `not-found`, a missing `agentId` or a fault.
  3. A grant that answers `created: true` or `created: false` → `kept: true`.
  4. `grant-limit` → `kept: false, full: true`.
  5. Anything else → `kept: false`.

  The persist half never turns into a 500. Log `host_grant_persist_failed { code }`: the `PluginError` code, else `'unknown'`.
- Toast matrix in `GrantRow` (new `grant-copy.ts` constants). "Always" sends `agentId: grant.agentId`; "Just this once" never does.

  | Choice | Outcome | Title | Detail |
  |---|---|---|---|
  | Just this once | `added` | `HOST_ALLOWED_TITLE` | `HOST_ALLOWED_DETAIL` (unchanged) |
  | Just this once | not `added` | `HOST_ENDED_TITLE` | `HOST_ENDED_DETAIL` (unchanged) |
  | Always | `kept` | `HOST_ALLOWED_TITLE` | `HOST_ALLOWED_DETAIL` |
  | Always | not kept, `full` | `HOST_FOR_NOW_TITLE = 'Allowed for now'` if `added`, else `HOST_ENDED_TITLE` | `HOST_LIST_FULL_DETAIL = 'This agent’s list of allowed sites is full, so this one won’t be kept.'` |
  | Always | not kept, otherwise | `HOST_FOR_NOW_TITLE` if `added`, else `HOST_ENDED_TITLE` | `HOST_NOT_KEPT_DETAIL = 'We couldn’t keep it for next time, so your assistant may ask again.'` if `added`, else `HOST_ENDED_DETAIL` |
  | any | `null` | no toast | — |

- [ ] **Step 1: Write the failing route tests**
  - `it('Always on an ended session keeps the site for an agent the person can use, and says kept')`: the grant is called with `{ ownerUserId: <authed>, agentId: <body agentId>, host }`, and the answer is `{ added: false, kept: true }`.
  - `it.each(['forbidden','not-found'])("Always on an ended session for an agent they can't use (%s) keeps nothing, with the same answer")`: no grant call, and `{ added: false, kept: false }`.
  - `it("a live Always keeps it on the proxy's agent, never the body's")`.
  - `it('at the cap: kept false and full; the log has the code and never the host')`.
  - `it('another save failure: kept false, still 200')`.
  - `it('an ended Always with no agentId keeps nothing')`.
  - `it('Just this once answers { added } only')`.
  - Move the existing TASK-44 tests (`:140-230`) to the new shape.
- [ ] **Step 2: Write the failing client tests**
  - `grantHost` parses `{added, kept, full}`, and returns `null` on an unreadable body.
  - `GrantRow`: one test per matrix row, plus `it("Always sends the grant's agentId; Just this once does not")`.
- [ ] **Step 3: Run** `pnpm --filter @ax/channel-web test -- routes-allow-host credentials-client GrantRow`. Expected: FAIL.
- [ ] **Step 4: Implement** as specified.
- [ ] **Step 5: Run** the same command, plus `pnpm --filter @ax/channel-web build`. Expected: PASS.
- [ ] **Step 6: Commit** `[TASK-1212] web Allow: Always sticks after the conversation went quiet, and says when it couldn't`.

### Task 7: Slack: say why at the cap; an unreadable grant answer is a refusal; a refused click keeps nothing [tier: integration]

**Files:**
- Modify: `packages/channel-slack/src/permission-prompts.ts`:
  - The doc at `:28-70`, including the outcome table. Replace "Allowed sites are per person and agent…" (`:66-70`) with the team rule: the site is the agent's; members' later sessions and an outsider's turn reach it; its owners and team admins remove it in the agent's settings.
  - `REMEMBER_REFUSALS` (`:164-165`).
  - The remember catch (`:216-218`).
- Modify: `packages/channel-slack/src/copy.ts`: `:149-168`, the comment block plus two lines.
- Modify: `packages/channel-slack/src/plugin.ts`: comments at `:190-196`. The degradation string is unchanged.
- Test: `packages/channel-slack/src/__tests__/copy.test.ts` (`:105-115`, `:198-206`, `:255-275`), `permission-prompts.test.ts` (`:345-361`, `:374-390`, `:606-640`), and `answers.test.ts` (`:1793-1888`).

**Interfaces:**
- Produces:
  - `COPY.hostAllowedListFull = "Allowed for now, but my list of allowed sites is full, so I can't keep it. Ask me again and I'll try it."`
  - `COPY.hostEndedListFull = "I couldn't keep it: my list of allowed sites is full. If I need it again, I'll ask."`
  - `REMEMBER_REFUSALS = {'grant-limit','invalid-host','missing-field','invalid-return'}`.
  - `grant-limit` answers `hostAllowedListFull` while live, or `hostEndedListFull` once ended. The other three answer `hostAllowedForNow` or `hostEnded`. Every one is logged `{ stage: 'remember', code }`.

- [ ] **Step 1: Write the failing tests**
  - `permission-prompts.test.ts`: split the `it.each` at `:374` into `['invalid-host','missing-field','invalid-return']` (for now, or ended; logged by code) and a new `it("the agent's list is full (grant-limit): the line says so; for now while live, nothing kept once ended; logged by code")`.
  - `permission-prompts.test.ts`: add both lines to the "every answer is one of its COPY lines" set (`:625`).
  - `permission-prompts.test.ts`: retitle `:345` to "kept on the channel's agent, added by the asker". The call key is unchanged.
  - `copy.test.ts`: the key list, the map and literal pins for both lines. Neither contains "from now on" or "chat".
  - `answers.test.ts`: `hostWorld` records each `host-grants:grant` call as `kept`. Ada's refused click (`:1847`), the disconnected channel (`:1872`) and Deny (`:1858`) each assert `kept` is `[]`. Mel's Allow (`:1829`) asserts `kept` is `[{ ownerUserId: 'usr_mel', agentId: <the prompt's agent>, host: HOST }]`.
- [ ] **Step 2: Run** `pnpm --filter @ax/channel-slack test -- copy permission-prompts answers`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** the same command, plus `pnpm --filter @ax/channel-slack build`. Expected: PASS.
- [ ] **Step 5: Commit** `[TASK-1212] channel-slack: a full allowed-sites list says so; an unreadable keep is a refusal; refused clicks keep nothing`.

### Task 8: composition proof: a Slack Allow on a team agent is on the agent's list for everyone [tier: mechanical]

**Files:**
- Modify: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`: the header at `:56-72`, the stub comment at `~:225`, and `:1558-1600`.

**Interfaces:** Consumes Task 1.

- [ ] **Step 1: Flip C1 and C2.**
  - Replace `keptFor(userId)` with `agentSites()`, which reads `host-grants:list` with `{ agentId }`.
  - Expect `[]` before any click, and still `[]` after Ada's refused click.
  - Expect `['api.example.com']` after Mel's Allow. Comment: this is the agent's list, so Ada's sessions and an outsider's turn (run as Ada) load it too.
  - After Carol's outsider turn: still exactly `['api.example.com']`, and `addHostCalls` length is unchanged.
- [ ] **Step 2: Run** `DOCKER_HOST=<your socket> pnpm --filter @ax/preset-k8s test -- channel-slack-composition`. Expected: FAIL before Task 1, PASS after it.
- [ ] **Step 3: Commit** `[TASK-1212] preset-k8s: a team agent's Slack Allow lands on the agent's list`.

### Task 9: docs, changesets and the stale lines that made "per person" look settled [tier: mechanical]

**Files:**
- `docs/plans/2026-11-09-channel-slack-design.md`:
  - §1 item 10 (`:58-65`): replace "The list is per person and agent … covers the sessions of the person who allowed it" with the team rule (Vinay, 2026-11-23; TASK-1212).
  - §5 host bullet (`:1330-1340`): add the full-list line.
  - Known gaps (`:1591-1598`): remove "kept for the person who clicked" and "the web app's Always keeps nothing once the session has ended". Add the as-built facts: team-wide; outsider turns and routines get it; managers remove it in the agent's settings; a late Allow's line arrives at the next session; the residual mid-turn web click.
- `docs/plans/2026-05-26-just-in-time-capabilities-design.md` (`:105`, `:253`, `:291`, `:319`, `:346`): add a dated amendment at each of its per-`(user, agent)` host-grant statements. "(TASK-1212, 2026-11-23: on a team agent the list is the agent's. Every member's sessions, outsider turns and routine runs load it, and its owners and team admins remove sites in the agent's settings.)"
- `.changeset/slack-host-allow-remembered.md:6-8` (pending). Line 6 promises "Settings > Allowed sites, where you can remove it any time". Line 8 says "On a team agent, we keep it for the person who clicked." Both become false on team agents. Rewrite them: on a personal agent, it's in Settings › Sites and you can remove it; on a team agent, it's kept for everyone who uses the agent, and its owners and team admins remove it in the agent's settings. Leave `.changeset/jit-host-grants-store.md` alone: it is TASK-44's record, and the new changeset describes the change.
- New `.changeset/team-agent-allowed-sites.md`:
  - Packages: `@ax/host-grants` minor, `@ax/chat-orchestrator` minor, `@ax/credential-proxy` minor, `@ax/channel-web` minor, `@ax/channel-slack` patch.
  - Write it in the CLAUDE.md voice. It must say all of the following:
    - Team-wide sites, outsiders and routines included.
    - **Sites already allowed on a team agent become shared at deploy.**
    - Everyone on the team sees them in the agent's settings › Connectors, and owners and team admins remove them.
    - Settings › Sites now shows personal agents only.
    - The web's "Always" sticks after a conversation went quiet.
    - A full list (256) says so.
    - A site allowed while the agent wasn't running reaches its next reply.
- `presets/k8s/src/index.ts:1131-1142`: the comment.

- [ ] **Step 1: Edit** each file above. Then run two checks and expect no hits outside dated plan files and `.claude/memory/`:
  - `git grep -n -i "per person and agent\|person who clicked\|team-mate's own turn"`
  - `git grep -n -i "per-(user, \?agent)\|per (user, agent)" -- packages/host-grants packages/channel-web/src/server/routes-allow-host.ts packages/channel-web/src/server/routes-connections.ts packages/channel-web/src/server/plugin.ts packages/channel-web/src/components/settings packages/channel-web/src/lib/connections.ts packages/channel-web/src/lib/credentials.ts presets/k8s/src/index.ts`
  
  Every remaining hit must be about something other than host grants, such as skill attachments.
- [ ] **Step 2: Run** `pnpm test:scripts`. Expected: PASS.
- [ ] **Step 3: Commit** `[TASK-1212] docs: a website Allow on a team agent covers the team`.

---

## PR body must say

- **Boundary review:**
  - (a) `host-grants:list`/`revoke` drop `ownerUserId` and key on the agent. The alternate impl is an org-policy allowlist service. No leaking field names. No subscribers.
  - (b) `proxy:open-session` gains `newlyAllowedHosts`. A proxy without a note buffer may ignore it. No subscribers.
  - Neither is a wire action.
- **Security note** (from the Tasks 1, 3, 4 and 6 walks):
  - **The deliberate widening.** One member's Allow, or a kept late Allow, adds a site that every member's later session, an outsider's turn and a routine run of that agent can reach.
  - **How it stays bounded:**
    - `HOST_RE` exact hosts.
    - The private-IP block.
    - Never a credential binding (TASK-687).
    - 256 per agent.
    - A person's action only.
    - Removable by owners and team admins.
  - **Existing team-agent rows become shared.**
  - **Members can now see a team agent's sites.**
  - **The ended-session web path trusts `agentId` only after `agents:resolve`.** Its reach equals a live Allow's.
  - **Logs lose the host.**
- **Residuals:**
  - The prompt copy doesn't say "for everyone" (decided copy).
  - A teammate's warm session gets a new site only at its next fresh spawn. That fails closed: it raises a card, and the Allow is a no-op keep.
  - The late line can name sites teammates allowed elsewhere. They are true statements, at most 32.
  - A web "Always" clicked mid-turn and then idle-reaped before the next message gets no line. The block note's "ask me to try again" covers it.
- **Follow-ups (cards):**
  - Add a site to a team agent ahead of time from its settings (owners and team admins).
  - Tell teammates' live sessions about a new team site.
