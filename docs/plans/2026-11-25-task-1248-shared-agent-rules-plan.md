# TASK-1248 — Sharing phase 1C: a shared personal agent follows the team-agent rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A personal agent shared with other people (`agents:resolve` says `shared: true`) follows the rules team agents follow today: its memory is shared with everyone who can use it, it gets its own Slack bot that any owner sets up, outsiders' requests wait for an owner, and a website "Always" covers everyone who can use it. "Just me" agents don't change.

**Architecture:** No new hook and no new table. Each rule already hangs on a few predicates that ask "is this a team agent?": memory's `resolveMemoryAccess` and `member-names.ts`, channel-slack's `channels.ts` (`resolveFor`, `adminOfTeam`, `teamAdminAccess`) and `team-name.ts`, and channel-web's `keepVerdict`, `factsVisibility` and `readGrants.shared`. Each gets a second arm: "or a personal agent whose resolve answer says `shared: true`". The team arm doesn't change. Everything downstream follows on its own: recall scope, speaker filing, the `/memory` mount and export, bot routes, outsider tiers, the channel notice, and Slack prompts. Two decisions go beyond re-keying: a shared agent stops answering Slack DMs (the team rule), and only owners change who a personal agent is, even by chatting with it.

**Tech Stack:** TypeScript, zod, vitest, the @ax hook bus. Kysely/Postgres only in the canary (testcontainers).

**Spec:** `docs/plans/2026-11-25-agent-sharing-design.md` (phase 1, card C; §9 is what card A handed over). Read it with `docs/plans/2026-11-09-channel-slack-design.md` §2, §4b and §4c (the rules being re-keyed). Every decision and its alternatives are in `.claude/memory/decisions/2026-11-25-TASK-1248.md`. Card A's shapes are in `docs/plans/2026-11-25-task-1246-agent-sharing-phase1a-plan.md` ("Shapes cards B and C build on").

## Global Constraints

- **THE rule:** a personal agent follows a team-agent rule iff its `agents:resolve` answer has `visibility === 'personal'` and `shared === true` (an exact match). Team agents keep their own branch, byte for byte. A personal agent whose answer has no `shared`, or a non-boolean one, keeps the Just-me rule. Never read `audience` (card A's rule).
- "Personal 'Just me' agents are unchanged, including TASK-1238's DM-agent choice." For memory that means creator only, with owner-scoped reads, and it includes co-owners of a Just-me agent: they stay refused (decisions shard).
- **No channel-web client change.** No file under `packages/channel-web/src/components`, `src/lib` or `src/App.tsx` changes: card B (TASK-1247) is editing them. channel-web *server* files (`src/server/**`) and their tests are in scope.
- No new service hook, event or table. No manifest `calls`/`optionalCalls` change in any plugin.
- Copy is fixed by this plan (Task 6, Task 7). Plain words, no "team" in new strings, no backend vocabulary.
- Tests: `pnpm --filter <pkg> test` (the filter goes BEFORE the script). Build each touched package too (`pnpm --filter <pkg> build`): most packages leave `__tests__` out of tsc, but channel-web type-checks its tests. The canary (Task 9) needs Docker with `DOCKER_HOST` set (CLAUDE.md, "Docker-backed tests").
- security-checklist: run the `security-checklist` skill once over Tasks 1–6, 8 and 9 together, and paste its note into the PR.

## Review Focus

1. **A personal agent wrongly treated as shared** when its answer lacks `shared`, carries `shared: 'true'`, or names another agent. Every re-keyed predicate must fall back to the Just-me rule. This is pinned in Task 1 (memory), Task 3 (`keepVerdict`) and Task 4 (`resolveFor`).
2. **Narrowing back to Just me must take effect on the very next operation.** Memory reads, the `/memory` mount, Slack mentions and outsiders' turns must all re-ask `agents:resolve` each time and cache nothing. Pinned in Tasks 1, 5 and 9.
3. **An outsider's turn on a shared agent must keep every outsider rule.** It runs as the owner who set the bot up and remembers nothing an outsider says. A source this build doesn't recognise reads shared rows only. Pinned in Tasks 1 and 5.
4. **The DM read side and write side must agree** for an agent that became shared after it was chosen. Pinned in Task 6.
5. **A sharee steering the agent through chat.** Its identity and soul must not move (Task 8). Its website "Always" may move, by design (Task 3). Nothing else in the four rules may widen beyond `agents:resolve`.

## THE rule, and who does what after this card (copy into the PR body)

| | Just me (owners only) | Shared personal (`shared: true`) | Team agent (unchanged) |
|---|---|---|---|
| Memory | creator only; reads scoped to the creator | everyone who can use it; speaker facts under the speaker; outsiders' words never kept; unknown source → shared rows only | same as shared |
| Names in memory | none | `agents:resolve` admits the id **and** the id takes part (an owner, on a `list` audience, or it owns a row in this agent's memory) → `auth:get-user` name; admitted only via `everyone` and never spoke: "a teammate", no lookup | `teams:is-member` → name |
| Slack | DMs on the shared app (TASK-1238) | its own bot for channels; **never answers DMs** | own bot |
| Who sets up / manages the bot | — (409 `personal-agent`) | any owner (`isOwner`) | team admins |
| Outsiders' turns run as / their approvals wait for | — | the owner who set the bot up, while still an owner; another owner can Take over | the team admin who set it up |
| A person's own held calls | themself | themself (no change needed) | themself |
| Website "Always" | owners keep it for the agent | anyone who can use it keeps it for the agent | any member |
| Who removes a site | owners (card A) | owners (card A) | team admins |
| Identity / soul / first-run setup (incl. the agent's own tools) | owners | owners | any member (unchanged) |

## File map

- `packages/memory/src/access.ts`: `MemoryAccess.memberCheck`; `resolveMemoryAccess` admits a shared agent's people.
- `packages/memory/src/member-names.ts`: names on a shared agent come through `agents:resolve`.
- `packages/memory/src/plugin.ts`: `FORBIDDEN_PAYLOAD_FIELDS`. Plus docs in `owner.ts` and `audience.ts`.
- `packages/memory/src/__tests__/harness.ts`: a shared personal agent fake. New `shared-agent.test.ts`.
- `packages/channel-web/src/server/routes-allow-host.ts` (`keepVerdict`) and `routes-workspace.ts` (`ResolvedAgent.shared`, `factsVisibility`, `readGrants`).
- `packages/channel-slack/src/channels.ts`, `team-name.ts`, `turn.ts`, `router.ts`, `agent-routes.ts`, `copy.ts`, `turn-note.ts` and `bot-requests.ts`, plus the callers of the renamed `managerAccess`. Test fake `__tests__/fake-agents.ts`.
- `packages/agents/src/identity/service.ts` and `types.ts` (identity ACL); `packages/chat-orchestrator/src/orchestrator.ts` (who is offered identity tools and first-run setup).
- `presets/memory/src/__tests__/canary.test.ts`: the end-to-end case.
- Docs: both design docs, `docs/plans/2026-05-24-current-architecture.md`, and `packages/core/src/context.ts` (comment). Stale comments in host-grants, chat-orchestrator and channel-slack. `.changeset/agent-sharing-phase1c.md`.

---

### Task 1: Memory — a shared agent's memory is shared with everyone who can use it [tier: sensitive]

This is the fix the card requires. Today `access.ts:66` refuses anyone but the creator, so a sharee's k8s session fails at `sandbox:memory-mounts` (`memory_mounts_failed`).

**Files:**
- Modify: `packages/memory/src/access.ts` (all of it: the type, `resolveMemoryAccess`, the docs).
- Modify: `packages/memory/src/plugin.ts:268-282` (`FORBIDDEN_PAYLOAD_FIELDS`); reword the "on a team agent" text in the optional-call degradation notes at `:652-665`.
- Modify (docs only): `packages/memory/src/owner.ts:9-15` and `:32-44`; `packages/memory/src/audience.ts:106-108`, `:428-436`; the refusal text at `:642-644` ("a team agent's turn" → "a shared agent's turn").
- Modify: `packages/memory/src/__tests__/harness.ts:123-137` (options), `:180-186`, `:294-332` (`registerMemoryAgents`).
- Create: `packages/memory/src/__tests__/shared-agent.test.ts`.

**Interfaces:**
- Produces: `MemoryAccess` gains `memberCheck?: 'agent'`. It is set ONLY on a shared personal agent's access, which is `{ userId, visibility: 'team', memberCheck: 'agent', agentName? }`. That access never has a `teamId`. A team agent's access is unchanged and has no `memberCheck`. Task 2 consumes `memberCheck`.
- Produces (tests): `makeMemoryHarness(config, { agent: { visibility: 'personal', shared: true, ownerUserId?, members?, displayName? } })`. Its `agents:resolve` admits `ownerUserId` and every id in `members`, and answers `{ id, ownerId: ownerUserId, ownerType: 'user', visibility: 'personal', shared: true, audience: 'everyone', isOwner: userId === ownerUserId, displayName? }`. Without `shared`, a personal answer carries `shared: false, audience: 'just-me', isOwner: true`. A team answer carries `shared: true, isOwner: false`. `harness.resolveCalls: string[]` records each `userId` asked, in order. `harness.setShared(false)` flips the fake to Just me between calls (it then admits only `ownerUserId`).

`resolveMemoryAccess`, in this order (the order is the fail-closed property):
1. The existing `ctx.agentId` checks and the `agents:resolve` call. The call's output type also reads `shared`.
2. The existing shape check (`personal`+`user` or `team`+`team`, else `invalid-return`).
3. `visibility === 'team'`: return exactly what it returns today.
4. `visibility === 'personal' && agent.shared === true`: return the shared access above. `agents:resolve` has already admitted `userId`.
5. Otherwise (Just me, or `shared` missing or not `true`): today's rule. `ownerId !== userId` → `forbidden`; else `{ userId, visibility: 'personal' }`.

Document on the type that `'team'` means "this agent's memory is shared with everyone who can use it: a team agent, or a personal agent shared beyond its owners (TASK-1248)", and that the name predates sharing.

- [ ] **Step 1: Extend the harness** as in Interfaces. Keep every existing default answer except the new `shared`/`isOwner`/`audience` fields.

- [ ] **Step 2: Write the failing tests** in `shared-agent.test.ts`. ALICE owns the agent; BOB is someone it is shared with (`members: new Set([BOB])`), unless a test says otherwise:
  - `one person's write is everyone's read, and another's correction closes it` (mirror `team.test.ts:34`): ALICE remembers, BOB recalls it; BOB corrects it; ALICE's recall shows the fix and not the original.
  - `someone it is shared with can forget the owner's row, but never another agent's` (mirror `team.test.ts:64`).
  - `keeps each person's speaker subject distinct, and profile is the caller's` (mirror `team.test.ts:89`).
  - `refuses the moment the agent goes back to Just me: no cached grant` (mirror `team.test.ts:139`): BOB recalls; `setShared(false)`; BOB's next recall rejects `forbidden`; ALICE's recall is owner-scoped again (a row BOB wrote isn't in it).
  - `a Just-me agent is still its creator's alone: a co-owner or anyone else is refused`: register an ad-hoc `agents:resolve` (as `team.test.ts:156-193` does) that admits BOB as a co-owner, answering `{ id, ownerId: ALICE, ownerType: 'user', visibility: 'personal', shared: false, audience: 'just-me', isOwner: true }`. BOB's recall still rejects `forbidden`.
  - `an answer with no shared, or a non-boolean one, keeps the Just-me rule` (`it.each` over `undefined`, `'true'`, `1`, same ad-hoc fake admitting BOB): BOB is refused; ALICE gets the personal scope.
  - `refuses caller-provided shared, isOwner and memberCheck fields` (mirror `team.test.ts:212`).
  - `an outsider's turn recalls everything and files no person fact` (mirror the team cases at `audience.test.ts:1526` and `:1658`): `source: 'external'`; recall is unscoped; a `user`/`user:<id>` subject is not stored.
  - `a source this build doesn't recognise reads shared rows only and gets no /memory view` (mirror `audience.test.ts:328` and the mount case in `export.test.ts:400`).
  - `sandbox:memory-mounts gives someone it is shared with the agent's /memory view, and refuses them once it is Just me again`.
  - `the /memory export gives each person their own heading, never "you"` (mirror `export-render.test.ts:216`).
  - `another person's key never prints as a raw id`: in the injected block and the export, it reads `a teammate` until Task 2 names it.

- [ ] **Step 3: Run them and see them fail.**
  Run: `pnpm --filter @ax/memory test -- shared-agent`
  Expected: FAIL. BOB is refused with "This personal memory belongs to another person".

- [ ] **Step 4: Implement** `resolveMemoryAccess` as above. Add `'shared'`, `'isOwner'` and `'memberCheck'` to `FORBIDDEN_PAYLOAD_FIELDS`. Update the docs listed in Files.

- [ ] **Step 5: Run the whole package and build.**
  Run: `pnpm --filter @ax/memory test && pnpm --filter @ax/memory build`
  Expected: all pass. Every existing team and personal test passes unchanged.

- [ ] **Step 6: Commit.** `[TASK-1248] memory: a shared personal agent's memory is shared with everyone who can use it`

### Task 2: Memory — name the people a shared agent is shared with [tier: sensitive]

**Files:**
- Modify: `packages/memory/src/member-names.ts`: the "Whose names" doc (`:43-56`), the guard in `memberLabels` (`:267-281`), a second lookup beside `lookUp` (`:354-381`), and the hook named in `warnNamesFailed` / the timeout warning (`:116-118`, `:297`).
- Test: `packages/memory/src/__tests__/member-names.test.ts` (a new `describe`), `augment.test.ts`, `export.test.ts`.

**Interfaces:**
- Consumes: `MemoryAccess.memberCheck === 'agent'` (Task 1). Also `AGENTS_RESOLVE_HOOK` from `access.ts`.

How the lookup works:
- In `memberLabels`, after the existing labelling and the scoped-recall check:
  - a non-empty `access.teamId` takes today's team path, unchanged;
  - otherwise `access.memberCheck === 'agent'` takes the new path, which needs `agents:resolve` and `auth:get-user` to be registered and `ctx.agentId` to be a non-empty string;
  - anything else names nobody.
- The new per-id lookup calls `agents:resolve` with `{ agentId: ctx.agentId, userId }`.
  - A `PluginError` with code `forbidden` or `not-found` returns `{ lookup }`: no name and no fault.
  - Any other throw is a fault for hook `agents:resolve`.
  - An answer whose `agent.id !== ctx.agentId` returns `{ lookup }`.
  - Otherwise the `auth:get-user` step runs exactly as the team path does: same `memberName` cleaning and refusals, same 2 s all-or-nothing deadline, and the caller's own key is counted only for collisions.

- [ ] **Step 1: Write the failing tests** (a `describe('memberLabels on a personal agent shared with everyone (TASK-1248)')`, using the Task 1 harness):
  - `names someone the agent is shared with: agents:resolve admits them, then auth:get-user names them`. `resolveCalls` holds BOB; `memberCalls` (`teams:is-member`) stays empty.
  - `someone agents:resolve refuses reads "a teammate", with no auth:get-user call and no warning`.
  - `an answer about another agent names nobody for that id`.
  - `a resolve fault reads "a teammate" and warns once, naming agents:resolve`.
  - `past the deadline nobody is named` (mirror the team deadline case).
  - `an outsider's turn names the same people a member's turn does` (mirror `member-names.test.ts:926`).
  - `a turn from a source this build doesn't recognise names nobody and asks nobody` (mirror `:653`).
  - `the agent's own name and "a teammate" are refused as names` (one TASK-1213 mirror).
  - In `augment.test.ts`, `the injected block names a person the agent is shared with` (mirror `:1492`). In `export.test.ts`, `the /memory export names the people the agent is shared with` (mirror `:152`).

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm --filter @ax/memory test -- member-names augment export`
  Expected: FAIL. The names read `a teammate`.

- [ ] **Step 3: Implement** the guard and the lookup. Update the "Whose names" doc so it states both proofs.

- [ ] **Step 4: Run the whole package and build.**
  Run: `pnpm --filter @ax/memory test && pnpm --filter @ax/memory build`
  Expected: all pass. The team tests still count `teams:is-member` calls exactly as before.

- [ ] **Step 5: Commit.** `[TASK-1248] memory: name the people a shared agent is shared with`

### Task 3: channel-web server — a shared agent's memory line, its sites, and "Always for this agent" [tier: sensitive]

**Files:**
- Modify: `packages/channel-web/src/server/routes-allow-host.ts`: `keepVerdict` (`:262-286`) and the docs at `:17-40` and `:236-241`.
- Modify: `packages/channel-web/src/server/routes-workspace.ts`:
  - `ResolvedAgent` (`:412-433`) gains `shared?: boolean`;
  - `factsVisibility` (`:5811-5812`);
  - `readGrants` (`:6759`).
- Modify (comments only, now false): `packages/host-grants/src/store.ts:1-6`, `packages/host-grants/src/types.ts:3-5`, `packages/host-grants/src/plugin.ts:10-13`, `packages/chat-orchestrator/src/orchestrator.ts:5492`, `packages/channel-slack/src/permission-prompts.ts:74-77`. Each says "on a personal agent only its owner adds". It becomes "only its owners add, and on a shared personal agent anyone who can use it does (TASK-1248)".
- Test: `packages/channel-web/src/__tests__/server/routes-allow-host.test.ts`, `routes-workspace-rail.test.ts`, the agent-detail memory test in `routes-workspace.test.ts`, and `routes-workspace-decisions.test.ts`.

**Interfaces:** none new. The rule from Global Constraints, read structurally from the resolve answer.

`keepVerdict` order:
1. id mismatch → `bad-response`;
2. `visibility === 'team'` → `ok`;
3. `visibility !== 'personal'` → `bad-response`;
4. `shared === true` → `ok`;
5. `typeof isOwner !== 'boolean'` → `bad-response`;
6. `ownsPersonalAgent` → `ok`, else `not-owner`.

`factsVisibility`:
- `'team'` for a team agent, or a personal agent with `shared === true`;
- `'personal'` for any other personal agent;
- omitted otherwise.

`readGrants`: `const shared = agent.visibility === 'team' || (agent.visibility === 'personal' && agent.shared === true);`

- [ ] **Step 1: Write and flip the failing tests:**
  - `routes-allow-host.test.ts`:
    - flip `:473` into `a sharee's live Always on a shared agent keeps the site on the agent` (the fake answers `shared: true, isOwner: false`; `host-grants:grant` is called with the sharee as `ownerUserId` and the proxy's agent; `kept: true`);
    - flip `:521` into `an ended Always naming a shared agent the person can use keeps it`;
    - add `a non-owner on a personal agent that isn't shared still keeps nothing (not-owner)` (`shared: false, isOwner: false`);
    - add rows to the malformed-answer table (`:558`): `shared: 'true'` with `isOwner` missing → `bad-response`, kept false.
  - The agent-detail memory test: `a shared personal agent's memory reads as shared (factsVisibility team)` for an owner and for a sharee. A Just-me agent stays `'personal'`. A personal answer with no `shared` stays `'personal'`.
  - `routes-workspace-rail.test.ts`: `a shared personal agent's sites read as shared (grants.shared true)`. The existing `:1937` (a sharee gets no Revoke, and their revoke is 403) must still pass unchanged.
  - `routes-workspace-decisions.test.ts`: `someone a personal agent is shared with approves their own held call on it`. Mirror that file's own approve case for an owner, with `agents:resolve` admitting the sharee (`shared: true, isOwner: false`) and the decision filed under the sharee. Keep `:406` (a decision that isn't the caller's is 404) as is.

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm --filter @ax/channel-web test -- routes-allow-host routes-workspace`
  Expected: FAIL. `kept: false`, `factsVisibility: 'personal'`, `shared: false`. (The decisions approve case may already pass; that is expected, and it pins the rule.)

- [ ] **Step 3: Implement** the three changes and the doc fixes.

- [ ] **Step 4: Run and build.**
  Run: `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web build && pnpm --filter @ax/host-grants build && pnpm --filter @ax/chat-orchestrator build`
  Expected: all pass.

- [ ] **Step 5: Commit.** `[TASK-1248] channel-web: a shared agent's memory line, sites and "Always for this agent" follow the shared-agent rule`

### Task 4: Slack — a shared agent gets its own bot, and its owners manage it [tier: sensitive]

**Files:**
- Modify: `packages/channel-slack/src/channels.ts:31-157`:
  - `AgentAccess` becomes `'yes' | 'no' | 'agent-gone' | 'not-shared'`;
  - `Resolved`, `resolveFor`, `agentAccess`;
  - a new internal `mayManage`;
  - `teamAdminAccess` is renamed `managerAccess`;
  - `checkRights` and every doc comment that says "team agent" for this rule.
- Modify: the callers of the rename and of `'not-team'`: `router.ts:680`, `:759`; `bots.ts:854-857`, `:901`; `bot-requests.ts:325-327`; `bot-changes.ts:401-404`; `channel-route.ts:74-83`.
- Modify: `packages/channel-slack/src/team-name.ts:38-65`. `agentSeenBy` names a team agent or a shared personal agent. Its `teamId` is the `ownerId` only when `ownerType === 'team'`, else null.
- Modify (comments, now false): `capture-veto.ts:30-31` ("only a team agent has a bot"), `agent-routes.ts:128-130` and `:392-394`.
- Modify: `packages/channel-slack/src/__tests__/fake-agents.ts`:
  - `FakeAgent` gains `audience?: 'just-me' | 'everyone'` (personal only, default `just-me`) and `coOwners?: string[]`;
  - `canSee` admits co-owners, and any non-empty id for `everyone`;
  - `record()` carries `shared` (team, `everyone`, or a non-empty `shareWith`) and `audience` (personal);
  - `resolve` and `list-for-user` set `isOwner` (creator or co-owner; false on a team agent);
  - `can-set-shared-credential` is unchanged (false for every personal agent).
- Test: `channels.test.ts`, `channel-route.test.ts`, `agent-routes.test.ts`, `bot-requests.test.ts` (`agentSeenBy`, `:867`) and `bot-request-dms.test.ts` (`:1466`).

**Interfaces:**
- Produces: `managerAccess(bus, ctx, agentId, userId): Promise<AgentAccess>`. It answers `'yes'` for a team admin of a team agent, or an owner of a shared personal agent. It answers `'not-shared'` for a Just-me agent, and `'no'` / `'agent-gone'` as before. Task 5 relies on it.
- `checkRights` keeps its signature and its `Rights` type. `reason: 'personal-agent'` now means "a Just-me personal agent".

How the checks decide:
- `resolveFor` returns `{ access: 'yes', agentName, kind: 'team' | 'personal', isOwner: agent.isOwner === true }` when:
  - the answer is about this agent, and
  - it is a team agent (`visibility === 'team'`), or a personal agent with `shared === true`.
  Anything else is `'not-shared'`.
- `mayManage` on a `'team'` kind asks `adminOfTeam`, unchanged. On a `'personal'` kind it reads `isOwner` from the same answer, with no second call.
- The HTTP `409 personal-agent` code and the `not-team-agent` tier reason keep their strings.

- [ ] **Step 1: Extend `fake-agents.ts`** as in Files.

- [ ] **Step 2: Write the failing tests** (an `everyone` agent created by ALICE with co-owner CAROL; BOB is any other AX user):
  - `channels.test.ts`:
    - `is yes for a personal agent shared with everyone, for its owners and the people it is shared with` (mirror `:58`);
    - `lets anyone a shared agent is shared with view, and only its owners manage` (mirror `:105`: CAROL manages, BOB views and gets `forbidden` to manage);
    - `never asks agents:can-set-shared-credential about a personal agent`;
    - `a Just-me agent is still not-shared, its own creator's included` (keep `:71`, renamed);
    - `managerAccess is yes for an owner of a shared agent and no for anyone else it is shared with` (mirror `:184`, `:208`);
    - `a personal answer with no shared, or shared not true, is not-shared` (`it.each`).
  - `channel-route.test.ts`: `decideTier` rows for a shared personal agent (mirror `:34-49`). Someone who can use it is attended (A). An AX user it isn't shared with runs external as the connector (B). `not-shared` is unavailable.
  - `agent-routes.test.ts`:
    - `an owner of a shared personal agent reads the bot card and may manage it` (`state` is `ready` or `no-workspace`, `canManage: true`; mirror `:770`);
    - `someone it is shared with reads it but every write is 403` (mirror `:659`, `:679`);
    - `a co-owner of a shared agent manages it too`;
    - `a Just-me agent still answers 409 personal-agent to every write` (keep `:776`).
  - `bot-requests.test.ts`: `only an answer about this agent, as a shared agent, names it`. A shared personal agent is named, with `teamName` null (mirror `:867`).

- [ ] **Step 3: Run them and see them fail.**
  Run: `pnpm --filter @ax/channel-slack test -- channels channel-route agent-routes bot-requests bot-request-dms`
  Expected: FAIL. A shared agent reads `personal-agent` / `not-team`.

- [ ] **Step 4: Implement** `channels.ts`, the rename across its callers, `team-name.ts`, and the comment fixes.

- [ ] **Step 5: Run and build.**
  Run: `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build`
  Expected: all pass. Every team-agent test passes unchanged, apart from the mechanical rename.

- [ ] **Step 6: Commit.** `[TASK-1248] channel-slack: a shared personal agent gets its own bot, and its owners manage it`

### Task 5: Slack — setup, outsiders and approvals on a shared agent follow its owners [tier: sensitive]

These are behaviour tests across the Slack flows Task 4 re-keyed. No production change is expected. If a test exposes a branch Task 4 missed, fix it here and name it in the PR.

**Files:**
- Test: `packages/channel-slack/src/__tests__/bots.test.ts`, `bot-requests.test.ts`, `bot-changes.test.ts`, `router.test.ts`, `turn.test.ts`, `answers.test.ts`. Use the Task 4 fake: ALICE's `everyone` agent with co-owner CAROL.

**Interfaces:**
- Consumes: `managerAccess` (Task 4) and `fakeAgents`' `audience` and `coOwners`.

- [ ] **Step 1: Write the tests:**
  - `bots.test.ts`:
    - `an owner of a shared agent asks for its bot and, with their own Slack token, finishes it` (the self path; mirror the team admin's);
    - `the AX-admin path finishes only while the requester is still an owner` (mirror `:1383`; ALICE removes CAROL's ownership before the Allow → refused);
    - `needsClaim is true once the requester is no longer an owner` (mirror `:2358`).
  - `bot-requests.test.ts`:
    - the refusals table for a shared personal agent (mirror `:529`): BOB (shared with, not an owner) → 403; a Just-me agent → 409 `personal-agent`; a stranger → 404;
    - `approving needs the requester to still be an owner`.
  - `bot-changes.test.ts`:
    - `a co-owner takes over once the requester is no longer an owner` (mirror CL1 `:1470`);
    - `claim-not-needed while the requester is still an owner`;
    - `someone it is only shared with can't take over (403)`.
  - `router.test.ts`:
    - `a mention from someone the agent is shared with binds the channel and runs attended, as them` (mirror `:2990`);
    - `an outsider's mention runs external, as the requester, while they are an owner` (mirror `:3225`);
    - `once the requester is no longer an owner, an outsider gets the polite line and no turn` (mirror `:3264`);
    - `once the agent is Just me again, every mention gets the polite line and no turn runs` (the inert-bot rule);
    - `the memory notice posts on a shared agent's bot's first channel turn` (mirror `:3819`).
  - `turn.test.ts`: `an outsider's turn on a shared agent: its owner's line, no lookup and no prompt` (mirror `:823`). The held call waits for the requester.
  - `answers.test.ts`:
    - `someone a shared agent is shared with answers their own prompt in its channel` (mirror `:511`);
    - `a website Allow there keeps the site on the agent` (TASK-1212's rule in Slack);
    - rewrite `:823` so it covers BOTH an agent that is neither a team agent nor shared (closes `no-access`) AND a shared agent (answerable).

- [ ] **Step 2: Run them.**
  Run: `pnpm --filter @ax/channel-slack test`
  Expected: PASS once Task 4 is in. A failure is a missed branch: fix it in the code, not in the test.

- [ ] **Step 3: Commit.** `[TASK-1248] channel-slack: tests — bot setup, outsiders and approvals on a shared agent follow its owners`

### Task 6: Slack DMs — a shared agent never answers DMs; a co-owner gets no broken DM button [tier: sensitive]

**Files:**
- Modify: `packages/channel-slack/src/turn.ts:240-270`. `AgentChoice` gains `shared?: boolean`. In `pickPersonalAgent`, `own` also requires `a.shared !== true`.
- Modify: `packages/channel-slack/src/router.ts`:
  - `agentsOf` (`:237-256`) carries `shared` when it is a boolean;
  - `personalAgentFor` (`:294-306`) returns `DmRouting`;
  - `routeDm` (`:455-470`) picks the reply;
  - fix the comments at `:58-60` and `:258-264`.
- Modify: `packages/channel-slack/src/agent-routes.ts`. The status route's personal-agent branch (`:387-403`) handles a non-creator. Fix the comment at `:391-393` ("Only its owner sees a personal agent" is false since card A). `chooseDmAgent` (`:572-587`) gets docs only.
- Modify: `packages/channel-slack/src/copy.ts`, adding `agentsShared`.
- Test: `turn.test.ts`, `router.test.ts`, `agent-routes.test.ts`.

**Interfaces:**
- Produces: `export interface DmRouting { agent: DmAgent | null; ownSharedAgents: boolean }`. `personalAgentFor(bus, ctx, userId, choices): Promise<DmRouting>`. `ownSharedAgents` is true when the list holds at least one personal agent the person created (`ownerType 'user'`, `visibility 'personal'`, `ownerId === userId`) with `shared === true`. `isOwnPersonalAgent` keeps its signature and so excludes shared agents too.
- Copy, exact: `agentsShared: (origin: string) => \`Your agents are shared with other people, so they don't answer direct messages. Mention one in a channel it's in, or talk to it in [the web app](${origin}).\``

What `routeDm` and the status route do:
- In `routeDm`, `agent === null` replies `ownSharedAgents ? COPY.agentsShared(origin) : COPY.noAgent(origin)`, and logs `slack_no_personal_agent` with `{ sharedOnly: boolean }`.
- The status route's personal-agent branch: when `isOwnPersonalAgent(d.bus, a.ctx, a.userId, a.agentId)` is false (a co-owner of a Just-me agent), it answers `answersDms: false, dmAgentName: null`.

- [ ] **Step 1: Write the failing tests:**
  - `turn.test.ts`:
    - `pickPersonalAgent skips a shared agent, even the chosen one, and falls back to the oldest unshared`;
    - `a person whose only agents are shared has none to pick`.
  - `router.test.ts`:
    - `a DM from someone whose own agents are all shared gets the shared line and no turn runs`;
    - `a stored choice naming an agent that is now shared routes to their oldest unshared agent` (mirror `:1459`);
    - `a DM from someone with no agents still gets noAgent`.
  - `agent-routes.test.ts`:
    - `choosing your own shared agent for DMs is 403, and nothing is stored`;
    - `a co-owner of a Just-me agent reads its Slack tab with no DM choice to make` (`answersDms: false`, `dmAgentName: null`);
    - `the creator's Just-me agent still shows which agent answers their DMs` (keep TASK-1238's cases).

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm --filter @ax/channel-slack test -- turn router agent-routes`
  Expected: FAIL.

- [ ] **Step 3: Implement** the predicate, `DmRouting`, the copy, the routeDm branch and the status fix.

- [ ] **Step 4: Run and build.**
  Run: `pnpm --filter @ax/channel-slack test && pnpm --filter @ax/channel-slack build`
  Expected: all pass.

- [ ] **Step 5: Commit.** `[TASK-1248] channel-slack: a shared agent never answers DMs; a co-owner gets no DM choice to make`

### Task 7: Slack wording names no team [tier: mechanical]

On a shared agent these lines reach Slack users and the model. Each new string is still true for a team agent.

**Files:**
- Modify: `packages/channel-slack/src/copy.ts`, `packages/channel-slack/src/turn-note.ts:143-149` and `packages/channel-slack/src/bot-requests.ts:212-215`.
- Test: the tests that pin these strings (`turn-note.test.ts:77` and its neighbours; any `copy`, `bot-requests` or `bot-request-dms` assertion on the old words; grep the old strings under `packages/channel-slack/src/__tests__`).

Exact replacements:
- `sharedBotInChannel`, second sentence: `'To bring an agent into this channel, invite its own bot with /invite.'`
- `channelNoLongerAllowed`, last sentence: `'If this is a private channel, someone who manages me may need to set me up again.'`
- `botUnavailable`: `"I can't answer you here right now. Someone who manages me needs to check my settings in the web app."`
- `botRequestAsked`: `"Someone asked for an agent's own Slack bot."`
- `botRequestSubject`, the no-name branch: `` `${i.requester} wants to add @${i.botName} for an agent.` ``
- `AGENT_FALLBACK`: `'An agent'`. `REQUESTER_FALLBACK`: `'Someone'`.
- `SLACK_NOTE_OUTSIDER`: `"your owner, the team admin who set you up in Slack,"` becomes `"your owner, the person who set you up in Slack,"`. Nothing else in the note changes.

- [ ] **Step 1: Update the pinned-string tests first, and see them fail.**
  Run: `pnpm --filter @ax/channel-slack test -- turn-note copy bot-request`
  Expected: FAIL on the old words.
- [ ] **Step 2: Change the strings.**
- [ ] **Step 3: Check nothing still says it.** Run `grep -rn "team admin\|team agent" packages/channel-slack/src --include='*.ts' | grep -v __tests__`. Every remaining hit must be a comment about team agents' own rule (the `adminOfTeam` branch) or a log key. List them in the PR.
- [ ] **Step 4: Run.** `pnpm --filter @ax/channel-slack test`. Expected: PASS.
- [ ] **Step 5: Commit.** `[TASK-1248] channel-slack: Slack wording names no team`

### Task 8: Only owners change who a personal agent is, even through chat [tier: sensitive]

Card A made a person's identity edit owner-only. But the agent's own `update_identity` in a sharee's chat still saved: a confused deputy. Identity and soul reach every session's system prompt, including the owner's routines, which run as the creator with the creator's connections.

**Files:**
- Modify: `packages/agents/src/identity/service.ts`. In `set` (`:313-327`), the owner check applies to every `author`. `completeBootstrap` (`:384-393`) gets the same owner check after `requireAccess`. Both are skipped on a team agent.
- Modify: `packages/agents/src/types.ts:603-610`, the identity hooks' ACL note. A write on a personal agent, the person's or the agent's own, and `complete-bootstrap`, need `ctx.userId` to be one of its owners. Its audience reads, never changes, even through the agent.
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`:
  - `AgentRecord` (`:500-505`) gains `isOwner?: boolean`;
  - `identityToolScope` (`:1855`) opts gain `mayChangeIdentity: boolean`;
  - the offers become `[UPDATE_IDENTITY_TOOL, opts.attended && opts.mayChangeIdentity]` and `[COMPLETE_BOOTSTRAP_TOOL, opts.attended && opts.bootstrapMode]`;
  - `bootstrapMode` (`:4663`) becomes `attended && read.bootstrap === 'pending' && mayChangeIdentity`, with `mayChangeIdentity = agent.visibility === 'team' || agent.isOwner !== false`.
  This is UX only: the service is the boundary. `!== false` keeps today's behaviour for an answer without the field.
- Test: `packages/agents/src/__tests__/identity.test.ts`, `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` (the `identityToolScope` and bootstrap-mode cases).

**Interfaces:**
- `identityToolScope(agent, allowedTools, disallowedTools, opts: { attended: boolean; bootstrapMode: boolean; mayChangeIdentity: boolean })`.
- `agents:identity:set` and `agents:identity:complete-bootstrap` answer `forbidden` for a non-owner of a personal agent. `identity/tools.ts` already maps that to `not-allowed`.

- [ ] **Step 1: Write the failing tests:**
  - `identity.test.ts`:
    - flip `:809` into `the agent's own identity write in a sharee's turn is refused`;
    - add `complete-bootstrap from someone a personal agent is shared with is refused, and the agent stays pending`;
    - add `a co-owner's turn still lets the agent change itself`;
    - add `any member's turn on a team agent still lets the agent change itself` (unchanged).
  - `orchestrator.test.ts`:
    - `identityToolScope hides update_identity and complete_bootstrap when the person may not change the agent`;
    - `a sharee's attended turn on a pending personal agent is not in first-run setup` (the resolve stub answers `isOwner: false`);
    - `an owner's attended turn on a pending agent still is`.

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm --filter @ax/agents test -- identity && pnpm --filter @ax/chat-orchestrator test -- orchestrator`
  Expected: FAIL.

- [ ] **Step 3: Implement** the service checks, the ACL note, and the orchestrator gate. Update every `identityToolScope` call site and test to pass `mayChangeIdentity`.

- [ ] **Step 4: Run and build.**
  Run: `pnpm --filter @ax/agents test && pnpm --filter @ax/agents build && pnpm --filter @ax/chat-orchestrator test && pnpm --filter @ax/chat-orchestrator build`
  Expected: all pass.

- [ ] **Step 5: Commit.** `[TASK-1248] agents: only a personal agent's owners change who it is, even through chat`

### Task 9: The canary — a personal agent shared with everyone, end to end [tier: integration]

This proves the real `agents:resolve` `shared` reaches real memory, channel-web and channel-slack. That gap left a sharee's k8s session failing at `memory_mounts_failed`.

**Files:**
- Test: `presets/memory/src/__tests__/canary.test.ts`. Add one `it` after the "unauthenticated and foreign callers" case (`:758`). It uses the seeded `aliceAgentId`, `ALICE` and `BOB`, and the helpers `apiJson` and `ctxFor`.

**Interfaces:**
- Consumes card A's `PUT /admin/agents/:id/audience` (body `{ kind: 'everyone' }` / `{ kind: 'just-me' }`), the memory routes `/api/workspace/agents/:id/memory/remember|recall`, `GET /api/workspace/agents/:id`, `GET /settings/slack/:agentId` (channel-slack status), and the `sandbox:memory-mounts` hook.

- [ ] **Step 1: Write the test** `a personal agent shared with everyone: someone it is shared with uses its memory, and loses it when it is Just me again (TASK-1248)`. Use one unique value (e.g. `` `canary-1248-${randomBytes(4).toString('hex')}` ``) so other cases can't collide:
  0. Before sharing: ALICE's `GET /settings/slack/${aliceAgentId}` answers `canManage: false` (the canary connects no Slack workspace, so even a Just-me agent reads `state: 'no-workspace'`; `canManage` is what tells them apart). BOB's answers 404.
  1. ALICE PUTs `{ kind: 'everyone' }` on `aliceAgentId` → 200.
  2. BOB's `GET /api/workspace/agents/${aliceAgentId}` → 200, with `memory.factsVisibility === 'team'`.
  3. BOB remembers `{ about: 'user', relation: 'likes', value }` → 2xx. ALICE's recall for `value` finds it (shared memory).
  4. `bus.call('sandbox:memory-mounts', ctxFor(aliceAgentId, BOB), { owner: { agentId: aliceAgentId, userId: BOB } })` resolves to `{ mounts }` with exactly one mount (the call shape of `packages/memory/src/__tests__/export.test.ts:323-331`; `ctxFor` takes `(agentId, userId)`).
  5. ALICE's `GET /settings/slack/${aliceAgentId}` now answers `canManage: true` (an owner manages a shared agent's bot). BOB's answers 200 with `canManage: false`.
  6. ALICE PUTs `{ kind: 'just-me' }` → 200. BOB's recall → 403 or 404. The same `sandbox:memory-mounts` call for BOB rejects with `forbidden`. ALICE's recall for `value` no longer finds BOB's row (her scope is her own rows again).
- [ ] **Step 2: Run it** (it should pass once Tasks 1–6 are in).
  Run: `pnpm --filter @ax/preset-memory test -- canary` with `DOCKER_HOST` set.
  Expected: PASS, and every other canary case still passes.
- [ ] **Step 3: Commit.** `[TASK-1248] canary: a personal agent shared with everyone, end to end`

### Task 10: Docs, stale lines, changeset [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-25-agent-sharing-design.md`.
  - Lines `:105`, `:108` and `:111`: append "(card C: …)" with the outcome of each.
  - Add **§10 "Found while building phase 1C (TASK-1248)"**. It records:
    - the rule;
    - Just me unchanged, so co-owners of a Just-me agent still can't chat (open question);
    - narrowing hides others' rows from the creator and leaves a bot inert;
    - outsiders' approvals wait for the one owner who set the bot up;
    - a shared agent never answers DMs;
    - identity is owners-only;
    - files, artifacts, the routine list and Instructions follow the team rule, and card B's confirmation should name them;
    - **the client-wording list for card B**, verbatim from the decisions shard row.
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`:
  - `:74`, the §2 DM row: "Sender's 'Just me' personal agent…";
  - `:605`: "'Just me' personal agents stay on the shared app; a shared personal agent gets its own bot like a team agent (TASK-1248)";
  - `:1092`: add an as-built note, "the person who set it up" (TASK-1248);
  - `:1126`, §4c rule 2: "'Just me' agents work only in DMs… A personal agent shared with other people follows rules 1, 3, 4 and 5 (TASK-1248)".
- Modify: `docs/plans/2026-05-24-current-architecture.md`, next to `:204`. Add one line: a shared personal agent follows the team-agent rules for memory, Slack, approvals and website Allow (TASK-1248).
- Modify (comment only): `packages/core/src/context.ts:300-320`, the `audience` doc. "A team agent's memory…" becomes "A team agent's, or a shared personal agent's, memory…".
- Create: `.changeset/agent-sharing-phase1c.md`. Bumps: `"@ax/memory": minor`, `"@ax/channel-slack": minor`, `"@ax/channel-web": patch`, `"@ax/agents": patch`, `"@ax/chat-orchestrator": patch`. The body is a plain-language summary (voice per CLAUDE.md) and a "Not done" list: co-owners of a Just-me agent; removing a bot when an agent goes back to Just me; card B's wording.

- [ ] **Step 1: Write the doc changes and the changeset.**
- [ ] **Step 2: Check** `pnpm build` passes (the core comment change touches nothing typed).
- [ ] **Step 3: Commit.** `[TASK-1248] docs: shared agents follow the team-agent rules; stale lines; changeset`

---

## Final gate

```bash
pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
```
Expected: all green. If `@ax/auth-better`'s Docker teardown times out with every assertion passing, record that. Then confirm the touched packages (`@ax/memory`, `@ax/channel-slack`, `@ax/channel-web`, `@ax/agents`, `@ax/chat-orchestrator`, `@ax/host-grants`, `@ax/preset-memory`, `@ax/preset-k8s`) passed with their own `--filter` runs.

## PR body must include

- **THE rule and the who-does-what table** above, verbatim.
- **Boundary review:** no service-hook signature changes. Two contract meanings change:
  - `memory:recall` and the recall receipts' `visibility: 'team'` now also covers a shared personal agent ("this agent's memory is shared"). No leaky names; the alternate impl is a group-backed audience.
  - the identity hooks' ACL now refuses a non-owner's agent-authored write on a personal agent.
- **The security-checklist note** (Tasks 1–6, 8, 9). It must cover:
  - who now reaches a shared agent's memory, Slack bot and outsiders' run-as;
  - persisted egress grants by sharees;
  - the identity tightening;
  - the residuals: a live sharee session keeps its `/memory` mount until it ends; a narrowed agent's export is rewritten at the creator's next pass; files, artifacts and the routine list follow the team rule.
- **For Vinay** (each reversible):
  - co-owners of a Just-me agent still can't chat with it (the per-agent `/memory` export). Should a Just-me agent with co-owners share its memory among them?
  - outsiders' approvals wait for the one owner who set the bot up, not every owner;
  - a shared agent no longer answers its creator's Slack DMs;
  - going back to Just me hides what others taught the agent from the creator (kept, and back if shared again), and leaves its bot inert until an AX admin removes it or the agent is shared again;
  - identity is owners-only, even through chat.
- **For card B:** the client-wording list (design §10). Card B's shared-agent lists can now land, because sharees can chat.
