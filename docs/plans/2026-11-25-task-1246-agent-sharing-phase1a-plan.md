# TASK-1246 — Sharing phase 1A: who can use an agent, and its owners — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A personal agent gets an audience (`just-me` by default, `everyone`, or a `list` of people) and a set of owners. `checkAccess` admits owners and the audience. Lists include agents shared with you. Every reader can ask "is this agent shared?" from `agents:resolve`'s answer. Owners-only routes set the audience and the owners.

**Architecture:** The data lives only in `@ax/agents`: an `audience` column on `agents_v1_agents` and two small tables, owners and list members. `packages/agents/src/acl.ts` `checkAccess` stays the one "can use" rule, and `agents:list-for-user` mirrors it in SQL. Today, eight write paths in other plugins treat "`agents:resolve` let me in, and the agent is personal" as "I own it". Each of them now checks the new `isOwner` on the resolve answer, so being shared an agent never lets someone change it.

**Tech Stack:** TypeScript, Kysely + Postgres (testcontainers in tests), zod, vitest, the @ax hook bus.

**Spec:** `docs/plans/2026-11-25-agent-sharing-design.md` (phase 1, card A). Decisions and their alternatives: `.claude/memory/decisions/2026-11-25-TASK-1246.md`. Read both before starting.

## Global Constraints

- Audience values, exactly: `just-me` (the default), `everyone`, `list`. A list holds user ids now. Leave room for group ids, but write none.
- "Only AX accounts can be owners," and only AX accounts can be listed. An AX account is an id `auth:get-user` answers non-null.
- "Owners may change the audience and the owners." Non-owners get 403. Workspace admins get no override on sharing (design §7).
- "Fail closed on an unknown audience": a DB CHECK, a `corrupt-row` on read, deny in `checkAccess`, and 400 on write.
- "Migration: additive. Existing agents get just-me and their creator (a personal agent's owner) as the owner." `owner_id` stays the creator.
- "Team agents keep working exactly as today." Every team branch is untouched. Sharing routes answer a team agent with 403 `team-agent`.
- "No UI in this card beyond what tests need." No file under `packages/channel-web/src/components`, `src/lib` or `src/App.tsx` changes.
- Write routes keep http-server's CSRF check (no `bypassCsrf`) and the 64 KiB `ADMIN_BODY_MAX_BYTES` cap.
- Queries on `agents_v1_*` live only in a `store.ts` or `scope.ts` (lint rule `local/no-bare-tenant-tables`).
- No foreign key to `agents_v1_agents` (it breaks downstream `DROP TABLE` teardowns; `migrations.ts:203`).
- Tests: `pnpm --filter <pkg> test`, with the filter BEFORE the script. Postgres tests need `DOCKER_HOST` set per CLAUDE.md. `pnpm --filter @ax/agents build` type-checks src (agents excludes `__tests__` from tsc, so run its tests too). channel-web's build DOES type-check its tests.
- security-checklist: run the `security-checklist` skill over Tasks 1–6 together and paste its note into the PR.

## Review Focus

1. **A write path that still reads "resolved + personal" as "owner".** Task 6 ends with a grep audit. Every remaining hit must be a read, an owner-gated write, or a team-branch selector, and the PR lists them.
2. **`everyone` admitting a principal that isn't an AX account**: `'system'`, `ownerless:<sid>`, `''`, or an id auth doesn't know. Pinned in Task 2 (`acl.test.ts`, `sharing-access.test.ts`).
3. **The owners set losing the creator, going empty, or holding duplicates; a co-owner removing themselves.** Pinned in Task 4.
4. **`agents:list-for-user` and `agents:resolve` disagreeing about who can see an agent.** Pinned by Task 2's matrix test.
5. **A member row that outlives a `list` audience** (switch to `just-me`, then back to `list` with new people) **coming back to grant access.** Pinned in Task 1 (rows deleted) and Task 2 (a stray row with `just-me` admits nobody).

## File map

- `packages/agents/src/migrations.ts`: the audience column, two tables, the creator backfill, row types.
- `packages/agents/src/types.ts`: audience types, new `Agent` fields, `ResolveOutputSchema`, doc fixes.
- `packages/agents/src/store.ts`: `rowToAgent` (audience, `shared`), create inserts the creator owner row, delete clears sharing rows, `listReachable`.
- `packages/agents/src/sharing/store.ts` (new): owner and member reads and writes.
- `packages/agents/src/sharing/service.ts` (new): validation, the owner check, the settings view (names).
- `packages/agents/src/scope.ts`: `reachableAgents`; `scopedAgents` keeps its meaning, with a corrected doc.
- `packages/agents/src/acl.ts`: `checkAccess`, `isAxAccount`, `isAgentOwner`.
- `packages/agents/src/plugin.ts`: resolve/list wiring, manifest, owner powers, reset TRUNCATE.
- `packages/agents/src/identity/service.ts`: person-written identity needs an owner on a personal agent.
- `packages/agents/src/admin-routes.ts`: settings payload, two PUT routes, the Settings › Agents filter.
- `packages/mcp-oauth/src/routes.ts`: sign-in on a personal agent needs `isOwner`.
- `packages/channel-web/src/server/agent-ownership.ts` (new), plus `routes-agent-identity.ts`, `routes-workspace.ts`, `routes-connections.ts`, `routes-chat.ts`: owner-only writes and owned-or-team lists.
- Tests in each package. Docs: the architecture doc, a design-doc addendum, a changeset, a memory context shard.

## Shapes cards B and C build on (copy into the PR body)

```ts
// agents:resolve { agentId, userId } → { agent: Agent }. Agent gains:
audience?: 'just-me' | 'everyone' | 'list'; // personal agents only; absent on a team agent
shared: boolean;   // team agent, or personal agent whose audience !== 'just-me'. Card C keys on THIS.
isOwner?: boolean; // for the userId asked; set by agents:resolve and agents:list-for-user; false on a team agent

// agents:list-for-user { userId, teamIds? } → { agents: Agent[] }, each with isOwner:
//   personal agents the user owns (created or co-owned)
//   ∪ personal agents shared with them ('everyone' when the user is an AX account; a 'list' naming them)
//   ∪ team agents of teamIds (unchanged)

// HTTP (signed-in cookie; writes need X-Requested-With: ax-admin or an allowed Origin)
// GET /admin/agents/:id → { agent: SerializedAgent & { shared: boolean; isOwner?: boolean; sharing?: SharingView } }
//   (sharing only for an owner of a personal agent)
// PUT /admin/agents/:id/audience  body AudienceBody      → 200 { sharing: SharingView }
// PUT /admin/agents/:id/owners    body { userIds: string[] } → 200 { sharing: SharingView } (must include the creator)
// GET /admin/agents → only agents the caller manages: team agents + isOwner
type AudienceBody =
  | { kind: 'just-me' }
  | { kind: 'everyone' }
  | { kind: 'list'; members: Array<{ type: 'user'; id: string }> }; // 1..50; phase 2 adds { type: 'group'; id }
interface PersonView { id: string; displayName: string | null } // no email, ever
interface SharingView {
  audience: { kind: 'just-me' } | { kind: 'everyone' }
          | { kind: 'list'; members: Array<{ type: 'user' } & PersonView> };
  owners: Array<PersonView & { creator: boolean }>; // creator first; 1..10
}
// Errors: 400 { error: 'invalid-audience' | 'invalid-owners' | 'duplicate-person' | 'creator-required' }
//         400 { error: 'unknown-person' } (no id) · 401 · 403 { error: 'forbidden' } (not an owner)
//         403 { error: 'team-agent' } · 404 { error: 'not-found' } · 413 · 503 { error: 'accounts-unavailable' }
// No email in SharingView and no id in unknown-person (security review: avoids an email/account lookup by id). A people-search route for card B's picker is card B's to design.
```

## Who may do what on a personal agent (after this card)

| | Creator | Co-owner | Audience | Workspace admin |
|---|---|---|---|---|
| Use it (resolve, lists) | yes | yes | yes | only as an owner or audience |
| Change audience, owners | yes | yes | 403 | 403 (no override) |
| Settings: `agents:update`, skill attachments, connector attach/detach, sign-in on it, identity, Instructions, abilities, tool verdicts, sites | yes | yes | 403 | existing `isAdmin` bypasses unchanged |
| Delete | yes | 403 | 403 | yes (existing) |
| Routines (`agents:can-manage-routines`), webhook token | yes | no | no | webhook: existing |

Why delete, routines and the webhook token stay with the creator: routines on a personal agent run as its creator (`routines/src/services.ts:332` stamps `agent.ownerId`), and delete can't be undone. See the decisions shard.

Widening `agents:can-manage-connectors` to co-owners also reaches its other callers. Each of these follows design §1 ("connections"), and the PR must list them:
- the workspace connectors tab's Remove and per-agent key;
- apps-bridge builder-mode app links (`apps-bridge/src/bridge-call.ts:166`, `:307`). Viewer mode stays creator-only (`:308`).

One caller must NOT follow it: the routine receiver's access read (`GET /settings/routines/:agentId/receiver-access`, routines-admin-routes `receiverAccess`). It used to ask `agents:can-manage-connectors`, so widening that would tell a co-owner "allowed" while the token write (`agents:ensure-webhook-token`) refuses them. It now asks `agents:can-manage-webhook-token`, which shares one predicate (`webhookTokenAllowed`) with the rotate and ensure hooks: the token stays the creator's.

In this card, co-owners and the audience can't chat with the agent yet: memory refuses non-creators (`memory/src/access.ts:66`), so a k8s sandbox open fails. Card C fixes that.

---

### Task 1: Storage — audience column, owners, list members [tier: sensitive]

**Files:**
- Modify: `packages/agents/src/migrations.ts` (append after the TASK-990 statements; `AgentsRow`; new row types; `AgentsDatabase`)
- Modify: `packages/agents/src/types.ts` (new types; `Agent` fields)
- Modify: `packages/agents/src/store.ts` (`rowToAgent`, `insertAgentRow`, `create`, `update`, `setSkillAttachments`, `deleteById`)
- Create: `packages/agents/src/sharing/store.ts`
- Modify: `packages/agents/src/plugin.ts:782` (reset TRUNCATE)
- Test: `packages/agents/src/__tests__/migrations.test.ts`, `store.test.ts`, `plugin.test.ts`, new `sharing-store.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `type AudienceKind = 'just-me' | 'everyone' | 'list'` and `AUDIENCE_KINDS: readonly AudienceKind[]`.
  - `interface AudienceMember { type: 'user'; id: string }`.
  - `type AgentAudience = { kind: 'just-me' } | { kind: 'everyone' } | { kind: 'list'; members: AudienceMember[] }`.
  - `interface CallerFacts { owner: boolean; listed: boolean }`.
  - `interface PersonView`, `interface SharingView` (shapes above).
  - `Agent` gains `audience?: AudienceKind`, `shared: boolean` and `isOwner?: boolean`. `isOwner` is set in Task 2; document it now.
- Produces (`sharing/store.ts`): `createSharingStore(db: Kysely<AgentsDatabase>): SharingStore` with:
  - `callerFacts(agentId, userId): Promise<CallerFacts>`: one query, two `EXISTS` (owner row; member row with `member_type = 'user'`).
  - `listOwners(agentId): Promise<string[]>`: ordered by `created_at, user_id`, so the creator's backfilled or created row comes first.
  - `listMembers(agentId): Promise<AudienceMember[]>`: `member_type = 'user'` rows only, ordered by `created_at, member_id`.
  - `setAudience(agentId, audience: AgentAudience): Promise<void>` and `setOwners(agentId, userIds: readonly string[]): Promise<void>`. Each runs ONE transaction. It first does `SELECT agent_id … FOR UPDATE` on the agent row, throwing `PluginError{code:'not-found'}` if there is none. Then it replaces the rows. `setAudience` writes the column and deletes every member row, then inserts members only for `list`.

- [ ] **Step 1: Write the failing tests**

`migrations.test.ts` (add the two new tables to its `afterEach` drops):
- `adds audience TEXT NOT NULL DEFAULT 'just-me' and existing rows read just-me`.
- `CHECK refuses an unknown audience`: `UPDATE … SET audience = 'friends'` rejects, matching `/agents_v1_audience_check/`.
- `creates agents_v1_owners and agents_v1_audience_members`: columns and primary keys; `member_type` accepts `'user'` and `'group'` and refuses `'team'`.
- `backfills the creator as owner of each personal agent, none for team agents`. Run the migration twice: still one row per personal agent.
- `does not re-add the creator when the agent already has another owner`. Delete the creator row, keep a second owner, re-run the migration, and the creator is still absent.
- The existing `creates agents_v1_agents table + owner index` test may pin a table list. Keep it true.

`sharing-store.test.ts` (new; real Postgres like `store.test.ts`):
- `callerFacts reports owner and listed separately`.
- `setAudience(list) stores the members; setAudience(everyone) and setAudience(just-me) leave no member rows`.
- `setOwners replaces the owner set`.
- `setAudience and setOwners on a deleted agent reject not-found and write no rows`.
- `listMembers ignores a raw-inserted group row` (Review Focus 5's storage half).

`store.test.ts`:
- `create inserts the creator as owner: without a tx, inside a caller tx that commits, and with bootstrap pending`.
- `a caller tx that rolls back leaves no owner row`.
- `a team agent gets no owner row`.
- `a personal agent reads audience just-me and shared false; a team agent has no audience and shared true`.
- `deleteById removes the agent's owner and member rows`.

`plugin.test.ts`: extend `bootstrap:reset-cleanup wipes every agent row…`. Both new tables are empty afterwards.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ax/agents test -- migrations store sharing-store plugin`
Expected: FAIL (missing column/tables, `createSharingStore` not found).

- [ ] **Step 3: Implement**

Migration statements, appended verbatim:
```sql
ALTER TABLE agents_v1_agents
  ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'just-me'
  CONSTRAINT agents_v1_audience_check CHECK (audience IN ('just-me', 'everyone', 'list'));

CREATE TABLE IF NOT EXISTS agents_v1_owners (
  agent_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, user_id)
);
CREATE INDEX IF NOT EXISTS agents_v1_owners_user ON agents_v1_owners (user_id);

CREATE TABLE IF NOT EXISTS agents_v1_audience_members (
  agent_id    TEXT NOT NULL,
  member_type TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, member_type, member_id),
  CONSTRAINT agents_v1_audience_member_type_check CHECK (member_type IN ('user', 'group'))
);
CREATE INDEX IF NOT EXISTS agents_v1_audience_members_member
  ON agents_v1_audience_members (member_type, member_id);

INSERT INTO agents_v1_owners (agent_id, user_id)
SELECT a.agent_id, a.owner_id FROM agents_v1_agents a
 WHERE a.owner_type = 'user'
   AND NOT EXISTS (SELECT 1 FROM agents_v1_owners o WHERE o.agent_id = a.agent_id)
ON CONFLICT DO NOTHING;
```
If Postgres rejects the named CHECK inside `ADD COLUMN IF NOT EXISTS` on the second run, use the guarded `DO $$` pattern instead (`conversations/src/migrations.ts:255-292`). The run-twice test decides. Comment each statement the way its neighbours are commented, including why `'group'` is allowed but never written.

Store:
- `rowToAgent` reads `audience`. On a personal row, a value outside `AUDIENCE_KINDS` throws `corrupt-row` (same posture as `runner`). It sets `audience` and `shared = audience !== 'just-me'`. On a team row, `audience` is omitted and `shared = true`.
- Add `'audience'` to every explicit `.returning([...])` list: `insertAgentRow`, `update`, `setSkillAttachments`. Otherwise `rowToAgent` would see `undefined` and call a fresh personal agent corrupt.
- `create`: for `ownerType === 'user'`, insert `agents_v1_owners (agent_id, user_id = ownerId)` on the same executor as the agent row. Without a caller `tx`, a personal create always runs in `db.transaction()`, because it is now always two rows.
- `deleteById`: after the existing lock, `deleteFrom('agents_v1_audience_members')` and `deleteFrom('agents_v1_owners')` for the agent, then identity, then the agent. This is also what `scripts/__tests__/agent-keyed-tables-are-cleaned.test.js` looks for.
- `plugin.ts` reset: `TRUNCATE agents_v1_identity, agents_v1_owners, agents_v1_audience_members, agents_v1_agents`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ax/agents test && pnpm --filter @ax/agents build && pnpm test:scripts`
Expected: PASS. The agent-keyed-tables guard is green with the two new tables.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src
git commit -m "[TASK-1246] agents: store an audience, owners and list members (additive migration)"
```

---

### Task 2: The access rule — checkAccess, agents:resolve, agents:list-for-user [tier: sensitive]

**Files:**
- Modify: `packages/agents/src/acl.ts` (rewrite the header and `checkAccess`; add `isAxAccount` and `isAgentOwner`)
- Modify: `packages/agents/src/scope.ts` (add `reachableAgents`; correct `scopedAgents`' doc to "personal agents the user CREATED plus team agents of teamIds", since its only caller is Today's self-changes)
- Modify: `packages/agents/src/store.ts` (`listReachable` replaces `listScoped`, whose only caller is `listForUser`)
- Modify: `packages/agents/src/plugin.ts` (create the sharing store in `init`; `resolveAgent`; `listForUser`; manifest)
- Modify: `packages/agents/src/types.ts` (`ResolveOutputSchema`; docs on `ListForUserInput/Output`, `ResolveOutput`, the identity ACL note at `:462-464`)
- Modify: `packages/agents/src/identity/service.ts` (`requireAccess` passes the new deps)
- Test: `acl.test.ts`, new `sharing-access.test.ts`, `return-schemas.test.ts`, `plugin.test.ts` (manifest pin), `presets/k8s/src/__tests__/preset.test.ts`

**Interfaces:**
- Consumes: `SharingStore.callerFacts`, `CallerFacts`, `Agent.audience/shared` (Task 1).
- Produces (`acl.ts`):
  - `type AclResult = { allowed: true; owner: boolean } | { allowed: false; reason: 'forbidden' }`.
  - `interface AclDeps { callerFacts: (agentId: string, userId: string) => Promise<CallerFacts>; warnState?: { warned: boolean }; accountWarnState?: { warned: boolean } }`.
  - `checkAccess(agent: Agent, userId: string, bus: HookBus, ctx: AgentContext, deps: AclDeps): Promise<AclResult>`.
  - `isAxAccount(bus: HookBus, ctx: AgentContext, userId: string, deps?: { warnState?: { warned: boolean } }): Promise<boolean>`.
  - `isAgentOwner(agent: Agent, userId: string, callerFacts: AclDeps['callerFacts']): Promise<boolean>`: true only for a personal agent with an owner row for a non-empty `userId`; always false on a team agent.
- Produces (`scope.ts`): `interface ReachableScope { userId: string; teamIds: readonly string[]; everyone: boolean }` and `reachableAgents(db, scope)`, a builder selecting all agent columns plus `is_owner` (boolean `EXISTS` on owners).
- Produces (`store.ts`): `listReachable(scope: ReachableScope): Promise<Agent[]>`, each with `isOwner` set, ordered `created_at desc` as today.

Rules (`checkAccess`, personal agent; the team branch keeps its code and returns `owner: false`):
1. `ownerType !== 'user'`, or `userId` not a non-empty string → forbidden.
2. `facts.owner` → `{ allowed: true, owner: true }`. The creator is NOT special-cased: the owners table is the one source of truth.
3. `audience`: `just-me` → forbidden; `list` → allowed iff `facts.listed`; `everyone` → allowed iff `isAxAccount`. Any other value → forbidden (fail closed).

`isAxAccount`:
- `''` or `isOwnerlessId(userId)` → false, with no call.
- No `auth:get-user` (or `no-service`) → false, logged once as `agents_acl_account_check_unavailable`.
- Any other throw propagates, so an outage is not a quiet deny.
- True iff the answer is an object whose `id === userId`.

`reachableAgents` filter: `owner_type='user'` AND (an owner row for `userId` OR (`scope.everyone` AND `audience='everyone'`) OR (`audience='list'` AND a `user` member row for `userId`)); OR `owner_type='team'` AND `owner_id IN teamIds`. With empty `teamIds`, the team arm is left out entirely, as `scopedAgents` does today.

Wiring:
- `resolveAgent` returns `{ agent: { ...applyPolicy(agent, policy), isOwner: acl.owner } }`.
- `agents:list-for-user` becomes `listForUser(store, bus, ctx, input)`. It computes `everyone = await isAxAccount(bus, ctx, input.userId)` and returns `listReachable`.
- `ResolveOutputSchema` declares `audience: z.enum(['just-me','everyone','list']).optional()`, `shared: z.boolean()` and `isOwner: z.boolean().optional()`.
- Manifest `optionalCalls` gains `{ hook: 'auth:get-user', degradation: "the 'everyone' audience admits only an agent's owners, and sharing writes that name a person answer 503 (nothing can check the person is an AX account)" }`.

- [ ] **Step 1: Write the failing tests**

`acl.test.ts` (unit; the fake `callerFacts` returns fixed facts). Update the existing expectations to `{ allowed: true, owner: false }` for team members. New tests:
- `personal: an owner row → allowed, owner true`.
- `personal: the creator with no owner row → forbidden` (pins the one source of truth).
- `personal just-me: a non-owner → forbidden, and auth:get-user is never called`.
- `personal just-me: a listed flag without the list audience → forbidden` (Review Focus 5's read half).
- `personal list: listed → allowed owner false; not listed → forbidden`.
- `personal everyone: an AX account → allowed; auth:get-user null → forbidden; 'ownerless:s1' and '' → forbidden with no lookup; 'system' unknown to auth → forbidden`.
- `personal everyone: no auth:get-user → forbidden and warns once`.
- `personal everyone: auth:get-user throws → rejects (not forbidden)`.
- `an unknown audience: the owner is allowed, a non-owner is forbidden` (cast a bogus value).

`sharing-access.test.ts` (new; real Postgres; boot like `plugin.test.ts`). Stubs: `auth:get-user` knows `alice`, `bob`, `carol` and `dave` only; `teams:is-member` says `{ member: true, role: 'member' }` for `team-1`. Seed through `agents:create` plus `createSharingStore` on the same DB:
- `resolve and list agree for every agent and user`. Agents: J (just-me), E (everyone), L (list [carol]), each created by alice with bob added as owner. Users: alice, bob, carol, dave, `'system'`, `'ownerless:s1'`, `'ghost'`.
  - J is allowed for {alice, bob}.
  - E is allowed for {alice, bob, carol, dave}.
  - L is allowed for {alice, bob, carol}.
  - For each user, the ids `agents:list-for-user` returns equal the agents `agents:resolve` allows.
  - `isOwner` is true only for alice and bob, on both hooks.
- `switching L back to just-me removes carol from resolve and list`.
- `a stray user member row on a just-me agent grants nothing`. Raw-insert a member row for dave on J: dave stays out of both resolve and list.
- `a team agent resolves for a member with shared true, isOwner false and no audience; agents:list-for-user returns it only with teamIds`.
- `without auth:get-user, E admits only its owners` (boot without the stub).

`return-schemas.test.ts`: add `audience`, `shared`, `isOwner` to the fixture. Add `does not strip shared, isOwner or audience`, and `rejects a resolve answer without shared`.

`plugin.test.ts`: add the `auth:get-user` entry to the exact manifest pin (`:127`). Update `agents:list-for-user only returns reachable agents` if it compares whole objects.

`presets/k8s/src/__tests__/preset.test.ts`: `@ax/agents declares auth:get-user as an optional call and @ax/auth-better produces it`. Use the file's existing manifest and registrant helpers.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ax/agents test -- acl sharing-access return-schemas plugin`
Expected: FAIL (old `checkAccess` signature; no `isOwner`; manifest mismatch).

- [ ] **Step 3: Implement** the signatures and rules above. `identity/service.ts` gets the sharing store in its deps (`createIdentityService({ bus, agents, identity, sharing })`) and passes `{ callerFacts: sharing.callerFacts }` to `checkAccess`. Rewrite `acl.ts`'s header as the rule list above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ax/agents test && pnpm --filter @ax/agents build && pnpm --filter @ax/preset-k8s test -- preset boot-graph`
Expected: PASS. The boot-graph test proves the new optional edge closes no cycle.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src presets/k8s/src/__tests__/preset.test.ts
git commit -m "[TASK-1246] agents: owners and the audience pass checkAccess; lists include agents shared with you"
```

---

### Task 3: Owner powers inside @ax/agents [tier: sensitive]

**Files:**
- Modify: `packages/agents/src/plugin.ts`: `assertWriteAllowed` (`:1105`), `deleteAgent` (`:1013`), `connectorsManageAllowed` (`:1198`), `routinesManageAllowed` (`:1163`, doc only), the webhook rotate/ensure clauses (`:357-359`, `:393-395`), and the "Write-side authz" comment block (`:1082-1086`)
- Modify: `packages/agents/src/identity/service.ts` (`requireAccess` returns the owner fact; `set` uses it)
- Modify: `packages/agents/src/types.ts`: the docs on `agents:can-manage-connectors` and the attach/detach ACL (`:355-372`, `:398-411`) say "the agent's owners", not "the agent's owner"
- Fix a stale claim that would make sharing look harmless for connections. `types.ts:430-431` and `plugin.ts:1225-1226` say a personal agent's "sign-in or key is stored on the person". Since slice 5 it is stored ON THE AGENT (`connectors/src/credential-plan.ts:12-16`; `mcp-oauth/src/routes.ts:531-532`), so anyone who can use the agent spends it. Say that, and say that choosing it on a personal agent is `agents:can-manage-connectors`' question (its owners). `agents:can-set-shared-credential` stays `false` for personal agents: no behaviour change.
- Test: new `packages/agents/src/__tests__/owner-powers.test.ts`, `identity.test.ts`

**Interfaces:**
- Consumes: `isAgentOwner`, `checkAccess` (Task 2); `SharingStore` (Task 1).
- Produces:
  - `assertWriteAllowed(agent, bus, ctx, actor, callerFacts)` and `connectorsManageAllowed(agent, bus, ctx, actor, callerFacts)`. Each gains a trailing `callerFacts: AclDeps['callerFacts']`; every call site passes the plugin's `sharing.callerFacts`.
  - `assertDeleteAllowed(agent, bus, ctx, actor): Promise<void>`. Admin → ok; personal → only the creator (`ownerId === actor.userId`); team → the member check `assertWriteAllowed` already applies to a team agent (`isTeamMember`), unchanged. `deleteAgent` calls it instead of `assertWriteAllowed`.

Rules:
- `assertWriteAllowed`: personal → `isAgentOwner(agent, actor.userId)`.
- `connectorsManageAllowed`: personal → `isAgentOwner`. The `isAdmin` bypass and the team branches don't change.
- `routinesManageAllowed` keeps `ownerId === ctx.userId`. Add a comment naming `routines/src/services.ts:332` as the reason.
- Webhook rotate/ensure: personal stays `ownerId === actor.userId` or `actor.isAdmin`. Only call the third clause (`connectorsManageAllowed`) when `existing.ownerType === 'team'`, so co-owners don't gain it through Task 3's widening.
- `agents:identity:set`: when `author` is not `'agent'` and the agent is personal, the caller must be an owner (`forbidden` otherwise). Team agents, `get` and `complete-bootstrap` keep `checkAccess`.

- [ ] **Step 1: Write the failing tests**

`owner-powers.test.ts` (real Postgres; alice creates, `setOwners([alice, bob])`, `setAudience(everyone)`; `auth:get-user` knows alice, bob and carol):
- `a co-owner may update, set skill attachments, attach and detach connectors; can-manage-connectors says true for them`.
- `a co-owner may not delete (forbidden) or manage routines (can-manage-routines allowed false), and is refused rotate and ensure webhook token`.
- `the creator keeps every power`.
- `someone the agent is shared with may use it but not update, delete or attach; can-manage-connectors and can-manage-routines say false`.
- `a workspace admin who isn't an owner can still update and delete it (existing bypass)`.
- `team agents are unchanged: any member updates; only a team admin manages connectors` (`teams:is-member` stub returning a role).

`identity.test.ts` additions:
- `a person's write by someone the agent is shared with is forbidden and saves nothing`.
- `the agent's own write (author 'agent') in that person's turn is saved`.
- `a co-owner's person write is saved`.
- `a team member's person write is saved, as before`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ax/agents test -- owner-powers identity`
Expected: FAIL (co-owner forbidden today; audience person-write saved today).

- [ ] **Step 3: Implement** the rules above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ax/agents test && pnpm --filter @ax/agents build && pnpm --filter @ax/routines test`
Expected: PASS. The routines harness boots the real agents plugin, so it guards against creator-only regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src
git commit -m "[TASK-1246] agents: co-owners change settings; delete, routines and webhooks stay the creator's"
```

---

### Task 4: Sharing routes and the settings payload [tier: sensitive]

**Files:**
- Create: `packages/agents/src/sharing/service.ts`
- Modify: `packages/agents/src/admin-routes.ts`:
  - `AdminRouteDeps` gains `sharing: SharingService`.
  - `serializeAgent` adds `shared`, plus `isOwner` when defined.
  - `show` adds `sharing` for an owner.
  - `list` keeps only `ownerType === 'team' || isOwner === true`.
  - Two handlers and two routes. The route table's method union gains `'PUT'`.
- Modify: `packages/agents/src/plugin.ts` (build the service; pass it to `registerAdminAgentRoutes`)
- Create: `packages/agents/src/__tests__/admin-routes-harness.ts`. MOVE (don't copy) `bootStack`, `dropAllTables`, `signIn`, `mintSecondUserCookie` and `http` from `admin-routes.test.ts`, which then imports them. `http` accepts `'PUT'` and an optional `headers` override. `mintSecondUserCookie` accepts a display name. `dropAllTables` drops the two new tables.
- Create: `packages/agents/src/__tests__/admin-routes-sharing.test.ts`

**Interfaces:**
- Consumes: `SharingStore`, `AgentAudience`, `SharingView`, `PersonView` (Task 1); `checkAccess`, `isAgentOwner` (Task 2).
- Produces (`sharing/service.ts`):
  - `AUDIENCE_MEMBERS_MAX = 50` and `OWNERS_MAX = 10`.
  - `type SharingWriteResult = { status: 200; sharing: SharingView } | { status: 400 | 403 | 404 | 503; error: string }`.
  - `createSharingService(deps: { bus: HookBus; agents: Pick<AgentStore, 'getById'>; sharing: SharingStore }): SharingService`, with:
    - `view(ctx: AgentContext, agent: Agent): Promise<SharingView>`
    - `setAudience(ctx: AgentContext, actor: Actor, agentId: string, body: unknown): Promise<SharingWriteResult>`
    - `setOwners(ctx: AgentContext, actor: Actor, agentId: string, body: unknown): Promise<SharingWriteResult>`

Order inside a write:
1. `getById` → 404 `not-found`.
2. Team agent: `checkAccess`. A non-member gets 403 `forbidden`; a member gets 403 `team-agent`.
3. Personal agent: `isAgentOwner(actor.userId)` or 403 `forbidden`. `actor.isAdmin` is ignored.
4. zod `.strict()` body → 400 `invalid-audience` / `invalid-owners`:
   - audience: the union above; `members` 1..50, `id` 1..128 chars;
   - owners: `{ userIds }`, 1..10 strings of 1..128.
5. Duplicate ids → 400 `duplicate-person`.
6. Owners only: the creator (`agent.ownerId`) missing → 400 `creator-required`.
7. Every named id other than the creator → `auth:get-user`:
   - null → 400 `unknown-person` (no `id`: security review);
   - hook absent → 503 `accounts-unavailable`;
   - a throw propagates (500).
8. Store write. A raced delete gives 404.
9. Log `agents_sharing_audience_set { agentId, kind, members, by }` or `agents_sharing_owners_set { agentId, owners, by }`. Counts only: no names or emails.
10. 200 with `view`.

`view` looks every owner and member up with `auth:get-user` in parallel. A null answer, a missing hook or a throw reads as `displayName: null`, logged by error name only; it never fails the read. `creator` is `id === agent.ownerId`.

Route handlers:
- `requireUser` (401), then a missing `:id` → 400.
- Then parse with `parseAndValidate(req.body, z.unknown())`: 413, or 400 `invalid-json`.
- Then the service, then `res.status(result.status).json(...)`.
- Paths: `PUT /admin/agents/:id/audience` and `PUT /admin/agents/:id/owners`.

- [ ] **Step 1: Write the failing tests**

`admin-routes-sharing.test.ts` (real auth-better, http-server and Postgres via the harness). Alice signs in as admin and is the creator. Bob, Carol and Dave are minted users:
- `audience everyone: another AX user can open the agent and finds it in agents:list-for-user` (acceptance). Alice PUTs `{kind:'everyone'}` → 200. Bob's `GET /admin/agents/:id` → 200 with `shared: true`, `isOwner: false` and no `sharing`. `agents:list-for-user` for bob includes it.
- `audience list admits only the listed people` (acceptance). The list is [bob]: bob gets 200, carol gets 403, and carol's `agents:list-for-user` lacks it.
- `a non-owner can't change the audience or the owners` (acceptance). Bob (in the audience) PUTs audience → 403 `forbidden`, and owners → 403. A GET as alice shows nothing changed.
- `an unknown audience is refused and nothing changes` (acceptance). Each of these gets 400 `invalid-audience`, and alice's GET still shows just-me:
  - `{kind:'friends'}`
  - `{kind:'list'}`
  - `{kind:'list',members:[]}`
  - `{kind:'list',members:[{type:'group',id:'g1'}]}`
  - an extra key
  - 51 members
- `listing someone who isn't an AX account → 400 unknown-person naming no id`.
- `a duplicate person → 400 duplicate-person`.
- `owners: the creator must stay; adding bob makes him an owner who sees sharing and can PATCH; bob can remove himself; carol can't add herself`:
  - `[bob]` → 400 `creator-required`;
  - `[alice, bob]` → 200; bob's GET shows `isOwner: true` and `sharing`;
  - bob PUTs `[alice]` → 200, and bob then gets 403 on GET (the audience is just-me).
- `11 owners → 400 invalid-owners; [alice, alice] → 400 duplicate-person`.
- `a team agent → 403 team-agent for a member and 403 forbidden for a non-member`. Seed a team row with SQL; stub `teams:is-member`.
- `writes keep CSRF: a PUT with no X-Requested-With and no Origin → 403 and nothing changes`.
- `GET /admin/agents lists only agents the caller manages`: alice's everyone-agent is absent from bob's list.
- `the owner's settings payload names people`. `sharing.owners[0]` is `{ id: alice, displayName: 'Test Admin', email: 'admin@example.com', creator: true }`; a listed member carries their minted name and email.
- `an admin who isn't an owner can't change the audience (403)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ax/agents test -- admin-routes`
Expected: the new file FAILS (routes 404); `admin-routes.test.ts` still PASSES after the helper move.

- [ ] **Step 3: Implement** the service and routes above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ax/agents test && pnpm --filter @ax/agents build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src
git commit -m "[TASK-1246] agents: owners-only routes to set who can use an agent and its owners"
```

---

### Task 5: mcp-oauth — only an owner signs in on a personal agent [tier: sensitive]

**Files:**
- Modify: `packages/mcp-oauth/src/routes.ts`:
  - `begin`'s gate (`:528-571`): its local type gains `isOwner?: unknown`. A personal agent whose answer isn't `isOwner === true` → 403 `forbidden`, before any connector read, vault read, state write or provider request.
  - `recheckAgent` (`:832-866`): the same rule answers `'not-allowed'`, logged as `mcp_oauth_callback_agent_refused { stage: 'owner' }`.
  - Rewrite the comments at `:529-532` and `:851-852`.
  - The status probe (`:1349`) stays read-only and open.
- Test: `packages/mcp-oauth/src/__tests__/routes.test.ts`. Also add `isOwner: true` to every personal-agent `agents:resolve` stub that expects success: `routes.test.ts` (about 20), `e2e.test.ts:638`, `dcr-client-binding.e2e.test.ts`, `admin-client-secret.e2e.test.ts`, `client-secret-ref.e2e.test.ts` and `plugin.test.ts` as their failures show.

**Interfaces:**
- Consumes: `agents:resolve` answer `agent.isOwner` (Task 2), read structurally (no import).

- [ ] **Step 1: Write the failing tests**
- `begin refuses someone a personal agent is shared with (isOwner false) with 403, and never reads the connector or writes state`. Spies on `connectors:get` and the state store see zero calls.
- `begin refuses a personal agent whose answer carries no isOwner (fail closed)`.
- `the callback refuses a signer who stopped owning the personal agent since begin (not-allowed), and stores no token`.
- `an owner's begin and callback still succeed` (the existing tests, with stubs now carrying `isOwner: true`).

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ax/mcp-oauth test`
Expected: the new tests FAIL (sign-in proceeds today).

- [ ] **Step 3: Implement** the rule above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ax/mcp-oauth test && pnpm --filter @ax/mcp-oauth build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-oauth/src
git commit -m "[TASK-1246] mcp-oauth: only an owner signs in on a personal agent"
```

---

### Task 6: channel-web — owner-only writes on personal agents; lists stay owned + team [tier: sensitive]

**Files:**
- Create: `packages/channel-web/src/server/agent-ownership.ts`
- Modify: `packages/channel-web/src/server/routes-agent-identity.ts`:
  - PUT `save` (`:192`) → 403 `forbidden` for a personal agent the caller doesn't own;
  - GET stays open to anyone who can use the agent;
  - local type at `:67`; comments at `:44-45` and `:161-163`.
- Modify: `packages/channel-web/src/server/routes-workspace.ts`:
  - `saveRules` (`:9789`), `setAbility` (`:8764`) and `setConnectorToolVerdict` (`:9611`, any verdict) → 403 `forbidden` for a personal agent the caller doesn't own;
  - `revokeGrant` (`:8669`): the personal shortcut needs `ownsPersonalAgent`, and anyone else takes the existing manage check;
  - `sitesRemovable` (`:6669`): same rule;
  - `setupForCaller`'s one call (`:8856`): a non-owner of a personal agent gets `'ask-owner'`;
  - `listAgents` (`:5762`) filters;
  - local types at `:399` and `:638` gain `visibility?` and `isOwner?`;
  - stale comments at `:4737-4739`, `:5230-5231` ("its credentials live on the person": they live on the agent), `:5257-5258`, `:6657-6658`, `:8657-8659`, `:9782-9784`.
- Modify: `packages/channel-web/src/server/routes-connections.ts`:
  - `refusedUnlessPersonal` (`:242`) becomes "owned personal agent, else 403". Keep `team-agent` for a team agent; answer `forbidden` for a personal agent the caller doesn't own;
  - local type at `:39`;
  - comments at `:233-239` and `:591-594`.
- Modify: `packages/channel-web/src/server/routes-chat.ts`: `listAgents` (`:1448`) filters; local type at `:225`.
- Test: new `src/__tests__/server/agent-ownership.test.ts`; extend:
  - `routes-agent-identity` tests;
  - `routes-workspace.test.ts` (rules, abilities, state roster);
  - `routes-workspace-connector-tools.test.ts`;
  - the grants/revoke tests (`routes-workspace-rail.test.ts` or wherever `revokeGrant` and `sitesRemovable` are pinned);
  - `routes-workspace-connectors.test.ts` (setup);
  - `routes-connections.test.ts` (sites add/revoke);
  - `routes-chat.test.ts` (list).

  Existing stubs that stand for the owner of a personal agent gain `isOwner: true`.

**Interfaces:**
- Consumes: `agent.isOwner` / `agent.visibility` from `agents:resolve` and `agents:list-for-user` (Task 2), read structurally.
- Produces (`agent-ownership.ts`):
  - `ownsPersonalAgent(agent: { visibility?: unknown; isOwner?: unknown }): boolean`. True only for `visibility === 'personal' && isOwner === true`: strict, used for writes.
  - `hideAgentsSharedWithMe<T extends { visibility?: unknown; isOwner?: unknown }>(agents: readonly T[]): T[]`. Keeps team rows and every row whose `isOwner !== false`: lenient, so a producer without the field means "owned", as today. Used for lists.

- [ ] **Step 1: Write the failing tests**

`agent-ownership.test.ts`:
- `ownsPersonalAgent is true only for personal + isOwner true; false for a missing isOwner, isOwner false, or a team agent`.
- `hideAgentsSharedWithMe drops only personal rows with isOwner false`.

Route tests, each stubbing `agents:resolve` with `{ visibility: 'personal', isOwner: false }` (someone the agent is shared with):
- `PUT identity → 403 and agents:identity:set is never called`.
- `PUT memory/rules (Instructions) → 403, nothing written`.
- `PUT abilities → 403, tool-policy:set-agent-override never called`.
- `PUT a connector tool verdict (allow and deny) → 403, no override written`.
- `POST and DELETE /api/chat/allowed-sites/:agentId → 403 forbidden, host-grants never called`.
- `workspace grant revoke of a site → 403, host-grants:revoke never called`.
- `the grants read says sites aren't removable`.
- `the connectors read offers 'ask-owner', never sign-in`.
- `GET /api/chat/agents and the workspace /state roster leave out an agent shared with me but keep team agents and owned ones (and rows without isOwner)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ax/channel-web test -- agent-ownership routes-agent-identity routes-workspace routes-connections routes-chat`
Expected: FAIL (the writes succeed today; the lists include the row).

- [ ] **Step 3: Implement** with the two helpers. Each route answers 403 `forbidden` before any write hook is called.

- [ ] **Step 4: Run the tests to verify they pass, then audit**

Run: `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build`
Expected: PASS.

Audit:
```bash
grep -rn "visibility === 'personal'\|visibility !== 'personal'\|ownerType !== 'user'\|visibility !== 'team'" packages/channel-web/src/server packages/mcp-oauth/src --include='*.ts' | grep -v __tests__
```
Every remaining hit must be a read, a write already gated by an @ax/agents hook (`agents:attach-connector` and friends) or by `ownsPersonalAgent`, or a team-branch selector. Paste the list with a one-word reason each into the PR body.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src
git commit -m "[TASK-1246] channel-web: only an owner changes a personal agent; lists stay yours + team"
```

---

### Task 7: Guard tests for the list consumers that already filter by owner [tier: integration]

These pass on arrival. They pin, against the wider list, that a shared agent is never treated as the caller's own.

**Files:**
- Test: `packages/channel-slack/src/__tests__/turn.test.ts`, `packages/channel-slack/src/__tests__/agent-routes.test.ts`, `packages/apps-bridge/src/__tests__/settings-routes.test.ts`

**Interfaces:**
- Consumes: the `agents:list-for-user` row shape with `isOwner` (Task 2), stubbed.

- [ ] **Step 1: Write the tests**
- `pickPersonalAgent never picks an agent someone else owns that is shared with the user, even when it was chosen` (`turn.ts:252`). Alice's agent `{ownerType:'user', visibility:'personal', ownerId:'alice', isOwner:false}` is older and chosen; bob's own agent is picked. With only alice's agent, the answer is null.
- `POST /settings/slack/:agentId/dm-agent refuses an agent shared with the caller (404) and writes no choice`.
- `apps-bridge: an agent shared with the caller is not offered as a candidate and can't be approved` (`settings-routes.ts:147`).

- [ ] **Step 2: Run them, then prove each one bites**

Run: `pnpm --filter @ax/channel-slack test -- turn agent-routes && pnpm --filter @ax/apps-bridge test -- settings-routes`
Expected: PASS.

Then temporarily delete the `a.ownerId === userId` term in `pickPersonalAgent` and the `ownerId !== userId` term at `settings-routes.ts:147`. Re-run: each new test FAILS. Restore both. Record the two mutation results in the PR.

- [ ] **Step 3: Commit**

```bash
git add packages/channel-slack/src/__tests__ packages/apps-bridge/src/__tests__
git commit -m "[TASK-1246] test: Slack DMs and apps never take an agent that is only shared with you"
```

---

### Task 8: Docs, design addendum, changeset, memory correction [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-05-24-current-architecture.md`. Lines ~201 and ~379 describe `agents:resolve` as the tenant ACL gate. Add one sentence each: it admits a personal agent's owners and its audience (`just-me | everyone | list`), its answer carries `shared` and `isOwner`, and settings writes on a personal agent need an owner.
- Modify: `docs/plans/2026-11-25-agent-sharing-design.md`. Append **§9 Found while building phase 1A (TASK-1246)**, one bullet each:
  - eight write paths took "resolved + personal" as "owner", and 1A guards them;
  - the creator stays an owner in phase 1;
  - co-owners change settings, while delete, routines and webhooks stay the creator's;
  - memory refuses non-creators until card C, so card B's shared-agent lists should follow card C;
  - sharing also exposes files, artifacts (rename, delete, public link), the routine list, Instructions, and the agent's self-identity updates. Card B's confirmation copy should name them, or card C should restrict them.
- Create: `.changeset/agent-sharing-phase1a.md` with `"@ax/agents": minor`, `"@ax/channel-web": patch`, `"@ax/mcp-oauth": patch`. Body: plain-language summary, the shapes, and a "Not done yet" list: card B UI, card C re-key, memory for non-creators.
- Create: `.claude/memory/context/2026-11-25-TASK-1246.md`. One row correcting `context.md:196`: `visibility` is only `personal | team`, and there is no `shared` visibility. "Is this agent shared?" is now `agents:resolve`'s `shared` boolean (team agent, or personal agent whose audience isn't `just-me`). Create the directory with `mkdir -p` first. Never edit the archive.

- [ ] **Step 1: Write the four edits.**
- [ ] **Step 2: Verify**

Run: `scripts/memory-append-check.sh origin/main && git diff --stat origin/main -- .claude/memory docs .changeset`
Expected: exit 0. The only memory files touched are the decisions shard (the plan's) and the new context shard; no root archive.

- [ ] **Step 3: Commit**

```bash
git add docs/plans .changeset .claude/memory/context
git commit -m "[TASK-1246] docs: sharing phase 1A in the architecture and design docs; changeset"
```

---

## Final gate

```bash
pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
```
Expected: all green. If `@ax/auth-better`'s Docker teardown times out with every assertion passing, record that, and confirm the affected packages passed with their own `--filter` runs.

## PR body must include

- **Boundary review** (for `agents:resolve`'s answer and `agents:list-for-user`'s output):
  - Alternate impl: an external directory (Google Groups/Okta) or file-backed agents answering `shared`/`isOwner`.
  - Leaky names: none.
  - Subscriber risk: none (`agents:resolved` is unchanged). Consumers must ask `shared`, never `audience` or `visibility`, and the type says so.
  - Wire: not an IPC action. The HTTP body `{kind, members:[{type,id}]}` maps 1:1 to store rows.
- **The shapes section above**, verbatim, for cards B and C.
- **The security-checklist note** (Tasks 1–6), including the not-guarded list from the decisions shard and the Task 6 audit list.
- **Interim limits:**
  - co-owners and the audience can't chat with a shared agent until card C, because memory refuses non-creators and the k8s sandbox open fails;
  - card B's shared-agent lists should follow card C;
  - there is no UI yet, so sharing is reachable only through the routes.
- **For Vinay:**
  - the creator can't be removed as an owner in phase 1;
  - delete, routines and webhooks stay with the creator;
  - the confirmation copy should also name files, artifacts, routines, Instructions and self-identity updates.
- **Mutation results** from Task 7.
