# TASK-1238: Choose which personal agent answers your Slack DMs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A personal agent's Slack settings show which of the person's personal agents answers their DMs to the shared Slack app. A button moves those DMs to this agent, and the person's next DM goes there.

**Architecture:** One row per person in a new channel-slack table, `channel_slack_v1_dm_agents`. `personalAgentFor` (router.ts) reads that row, and honors it only while `agents:list-for-user` still lists the agent as the person's own personal agent. Otherwise the oldest answers, as today. An owner-only `POST /settings/slack/:agentId/dm-agent` writes the row. The settings status names the agent that answers. channel-web shows the line and the button. No hook is added or changed.

**Tech Stack:** TypeScript, Kysely on Postgres (testcontainers in tests), vitest, React with shadcn (channel-web).

**Spec:** the TASK-1238 card (Vinay, 2026-11-24), plus §1 below. It decides design §8 Q2 (`docs/plans/2026-11-09-channel-slack-design.md:1785`). The decisions and their reasons are in `.claude/memory/decisions/2026-11-24-TASK-1238.md`.

---

## 0. What the code says (read at 7a30a71be)

- **True:** a DM to the shared app goes to the sender's OLDEST personal agent: `routeDm` (`router.ts:381`) calls `personalAgentFor`, which calls turn.ts `pickPersonalAgent`. The status says only `answersDms`, and never names the agent that does answer (`agent-routes.ts:113-116`).
- `personalAgentFor` has exactly **two callers**: `routeDm` and the status route (`agent-routes.ts:372`). Nothing else picks a DM agent. An Allow's continuation runs on the agent its prompt recorded.
- **Refuted: "personal agents without one".** No personal agent has a bot of its own: every bot route answers 409 `personal-agent`. A team agent's own bot drops every DM (`router.ts:287`, `bot-dm`). So DMs exist only on the shared app, and the choice covers the shared app by construction.
- **Refuted: "where the person's Slack mapping lives".** channel-slack stores no Slack-to-AX mapping. Each DM maps its sender afresh, from users.info's email through `auth:find-user-by-email`. So this needs a small new table.
- **Refuted: "non-owner → 403".** Every `/settings/slack/:agentId` route gives the SAME 404 for an agent the caller can't see (`agent-routes.ts:52-54`). A 403 would tell a non-owner the agent exists. The card's 403 stays for a team agent the caller *can* see.
- **"Add CSRF" needs no code.** http-server checks every POST registered without `bypassCsrf` (`packages/http-server/src/csrf.ts`), and channel-web's `post()` already sends `x-requested-with: ax-admin`.
- **Two Junipers are real:** `agents_v1_agents.display_name` has no uniqueness rule.

## 1. Design

**Approaches.**
- **(A) Chosen.** A per-person row in channel-slack, checked on every read against `agents:list-for-user`, written by an owner-only route in the existing `/settings/slack/:agentId` family.
- **(B) Rejected:** a "default agent" in @ax/agents behind a new hook. That's a cross-plugin concept for a Slack-only need, with no alternate implementation to name.
- **(C) Rejected:** switching from Slack, with a slash command or a picker. Vinay chose the settings button, the shared manifest dropped `commands` (TASK-1186), and he rejected pickers in Slack (2026-11-21).
- **(D) Rejected:** the credentials vault (it isn't a secret, and the vault can't be queried by agent for cleanup), or keying by install (an admin's reconnect would wipe every choice).

**Read rule (one predicate, both sides).** The stored id is used only if `agents:list-for-user({ userId, teamIds: [] })` lists it AND it passes `pickPersonalAgent`'s existing filter (`ownerType 'user'`, `visibility 'personal'`, `ownerId === userId`). Anything else falls back to the oldest. If the choice can't be read, the DM fails with `COPY.turnFailed` and no agent runs. It never falls back, which would put the person's words into the agent they left. The route asks the same predicate before it writes.

**What a switch changes.** Every DM routed after the write goes to the new agent.
- A turn that is running or queued keeps the agent picked when its message arrived, because `routeDm` captures `chosen` before `enqueue`.
- A reply in an *older* DM thread goes to the new agent, in a new conversation without that thread's history. Conversations are keyed by user, agent and thread key. This was accepted (decision 10 in the shard) and is listed under *Not in this PR*.

**Write route** `POST /settings/slack/:agentId/dm-agent`. It reads no body, takes the plain cap (`ADMIN_BODY_MAX_BYTES`) and keeps CSRF. The log stage is `dm-agent`.

| Request | Answer | Store |
|---|---|---|
| signed out | 401 `{ error: 'unauthenticated' }` | — |
| id fails `AGENT_ID_RE` | 404 `{ error: 'not-found' }`, no agents call | — |
| missing agent, or someone else's personal agent | 404 `{ error: 'not-found' }` | — |
| a team agent the caller can see (any role, workspace admins included) | 403 `{ error: 'forbidden' }` | — |
| caller's own personal agent | 200 `{}` | `set(userId, agentId)` |
| `checkRights` says personal, but `isOwnPersonalAgent` says no | 404 | — |
| `set` throws | 500 `{ error: 'internal' }`, `slack_channel_route_failed { stage: 'dm-agent', code }` | — |

**Status** (`GET /settings/slack/:agentId`, personal agent, Slack connected): `{ state: 'personal-agent', botName, answersDms, dmAgentName }`. `dmAgentName` is the answering agent's display name when that agent isn't this one. It is `null` when this agent answers, or when none does.

**Web states** (personal-agent):
1. **This agent answers:** today's sentence, unchanged, and no button. Right after a switch, a confirmation sits above it.
2. **Another agent answers, and is named:** "Direct messages to {bot} go to {other}." plus the button "Use {self} instead".
3. **No name came back** (an older host): a neutral line, and no button.

When the two names match (trimmed, case-insensitive), `other` = "your other {name}" and `self` = "this {name}".

## Global Constraints

- One owner: only channel-slack reads or writes `channel_slack_v1_*`. No foreign keys, and no cross-plugin imports (invariants 2 and 4).
- No hook signature or event changes. If you find you need one, stop: boundary review would apply.
- Log failures code-only (`logCode`). Never log an email, a user id, an agent id or a name in a failure line.
- Card copy never says `AX`, "shared app", "own bot", "approver", "claim" or "configuration token" (`packages/channel-web/src/test-utils/slack-card-words.ts`). The card's quoted copy is a draft for the ux pass.
- UI uses only the installed shadcn primitives (`Button`, `Alert`, `AlertDescription`) and semantic tokens (invariant 6).
- These tests need Docker: `dm-agents.test.ts`, `agents-deleted.test.ts`, `plugin.test.ts` and the preset composition test. Set `DOCKER_HOST` to your daemon's socket (CLAUDE.md › Docker-backed tests).
- Run tsc next to vitest: `pnpm --filter <pkg> build`. vitest tolerates type errors, and channel-web's tsc also covers its tests.
- Commits are prefixed `[TASK-1238]`.

## Boundary review and security

- **Boundary review: not required.** Nothing calls `bus.registerService` or `bus.fire` for a new name, and no payload changes. `agents:list-for-user`, `agents:resolve` and `agents:deleted` are used as they are. The new route is browser-to-host HTTP, not an `@ax/ipc-protocol` action.
- **security-checklist: required, one walk covering Tasks 2 and 3.** Task 2 decides which agent acts for a person. Task 3 is a new per-person write route. The walk happens in Task 3's last step.

## Review Focus

1. **A stored choice that no longer qualifies.** For example, the agent was deleted while the cleanup failed, or the row names a team agent or someone else's agent. The next DM goes to the oldest, and the settings say so. Pinned in Task 2.
2. **The choice store can't be read when a DM arrives.** The person gets "try again" and no agent runs. It never silently answers with the old agent. Pinned in Task 2.
3. **A message is already running or queued when the switch lands.** It finishes on the agent it started with, and the next message goes to the new one. Pinned in Task 2.
4. **Two personal agents share a name.** The page says "your other Juniper" and "Use this Juniper instead", never "go to Juniper. Use Juniper instead". Pinned in Task 5.
5. **The button is pressed on an out-of-date page** (the agent was deleted in another tab). The route answers 404 and stores nothing, and the section re-reads instead of looping on an error. A second click while one is in flight sends nothing. Pinned in Tasks 3 and 5.

## Files

| File | Responsibility | Task |
|---|---|---|
| `packages/channel-slack/src/dm-agents.ts` (new) | the choice's store | 1 |
| `packages/channel-slack/src/migrations.ts` | table, index, row type, header doc | 1 |
| `packages/channel-slack/src/agents-deleted.ts` | forget choices naming a deleted agent | 1 |
| `packages/channel-slack/src/plugin.ts` | construct the store, hand it to its three users, header docs | 1, 2, 3 |
| `packages/channel-slack/src/turn.ts` | `pickPersonalAgent(…, chosen)` | 2 |
| `packages/channel-slack/src/router.ts` | `personalAgentFor`, `isOwnPersonalAgent`, `RouterDeps.dmAgents` | 2 |
| `packages/channel-slack/src/agent-routes.ts` | status `dmAgentName` (2), the POST route (3) | 2, 3 |
| `presets/k8s/src/__tests__/channel-slack-composition.test.ts` | the real end-to-end proof | 4 |
| `packages/channel-web/src/lib/agent-slack.ts` | wire type, parse, `chooseSlackDmAgent`, `AGENT_SLACK_DM_COPY` | 5 |
| `packages/channel-web/src/components/workspace/AgentSlackDms.tsx` (new) | the personal-agent line, button and confirmation | 5 |
| `packages/channel-web/src/components/workspace/AgentSlack.tsx` | hold the confirmation across the re-read; render `AgentSlackDms` | 5 |
| `docs/plans/2026-11-09-channel-slack-design.md`, `.changeset/slack-dm-agent-choice.md` | §8 Q2 decided, §2 row, changeset | 6 |

---

### Task 1: Store the choice, and forget it with its agent [tier: sensitive]

Sensitive because of the migration. It's additive, but it runs at every boot of a prod host.

**Files:**
- Create: `packages/channel-slack/src/dm-agents.ts`
- Create: `packages/channel-slack/src/__tests__/dm-agents.test.ts`
- Create: `packages/channel-slack/src/__tests__/memory-dm-agent-store.ts`
- Modify: `packages/channel-slack/src/migrations.ts`. Change the header table list, the sentence "every query against them lives in store.ts or channel-store.ts" (now also dm-agents.ts), `ChannelSlackDatabase`, and `runMigrations`.
- Modify: `packages/channel-slack/src/agents-deleted.ts` and its header doc.
- Modify: `packages/channel-slack/src/plugin.ts`. Add `createDmAgentStore(db)` right after `createChannelStore(db)`, pass it to `subscribeAgentsDeleted`, and add the table to the header's storage paragraph.
- Modify: `packages/channel-slack/src/__tests__/agents-deleted.test.ts`

**Interfaces (Produces):**
```ts
// dm-agents.ts
export interface DmAgentStore {
  /** The agent this person chose for their Slack DMs, or null. Unchecked: callers check it (router.ts personalAgentFor). */
  get(userId: string): Promise<string | null>;
  /** Choose it. Replaces any earlier choice: one row per person. */
  set(userId: string, agentId: string): Promise<void>;
  /** Forget every choice naming this agent. Returns how many went. */
  removeForAgent(agentId: string): Promise<number>;
}
export function createDmAgentStore(db: Kysely<ChannelSlackDatabase>): DmAgentStore;

// migrations.ts
export interface ChannelSlackDmAgentsTable {
  user_id: ColumnType<string, string, never>;
  agent_id: string;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}
// ChannelSlackDatabase gains: channel_slack_v1_dm_agents: ChannelSlackDmAgentsTable

// agents-deleted.ts
subscribeAgentsDeleted(bus, d: {
  channels: Pick<ChannelStore, 'removeForAgent'>;
  dmAgents: Pick<DmAgentStore, 'removeForAgent'>;
  bots: Pick<Bots, 'removeForAgent'>;
}, logger): () => void

// __tests__/memory-dm-agent-store.ts: the real store's rules, in memory, for Tasks 2-3
export function memoryDmAgentStore(): {
  store: DmAgentStore;
  rows: Map<string, string>;                 // userId → agentId; a test may plant one
  calls: Array<{ method: 'get' | 'set' | 'removeForAgent'; args: string[] }>;
  faults: { get?: unknown; set?: unknown; removeForAgent?: unknown }; // thrown when set
};
```

Schema, in `runMigrations` **before** the final TASK-1186 `DELETE` (which must stay last):
```sql
CREATE TABLE IF NOT EXISTS channel_slack_v1_dm_agents (
  user_id     TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channel_slack_v1_dm_agents_agent ON channel_slack_v1_dm_agents (agent_id);
```
`set` is one statement: `INSERT … ON CONFLICT (user_id) DO UPDATE SET agent_id = EXCLUDED.agent_id, updated_at = now()`. `removeForAgent` uses `deleteFrom('channel_slack_v1_dm_agents')`. The repo guard `scripts/__tests__/agent-keyed-tables-are-cleaned.test.js` looks for that spelling.

The header paragraph says what the table is:
- which personal agent answers a person's DMs to the shared app;
- one row per AX user, never trusted as stored (every read checks it, in router.ts);
- removed with its agent;
- left by a reset, where it is inert;
- keyed by the person, so a reconnect keeps it.

- [ ] **Step 1: Write the failing store tests** in `dm-agents.test.ts`. Copy `channel-store.test.ts`'s container setup, and `TRUNCATE channel_slack_v1_dm_agents` in `beforeEach`.
  - `get answers null for someone who never chose`
  - `set then get answers the choice; a second set replaces it, one row per person`. Assert `SELECT count(*) FROM channel_slack_v1_dm_agents WHERE user_id = 'usr_pat'` is 1, and that `get` returns the second agent.
  - `two people's choices are independent`
  - `removeForAgent forgets every choice naming the agent and nothing else`. With usr_a→agt_x, usr_b→agt_x, usr_c→agt_y: `removeForAgent('agt_x')` returns 2, `get('usr_a')` and `get('usr_b')` are null, and `get('usr_c')` is `'agt_y'`. A second call returns 0.
  - `runMigrations twice keeps the table and its rows`
- [ ] **Step 2: Write the failing subscriber tests** in `agents-deleted.test.ts`, on a real Postgres and real store. Pass `dmAgents` to the existing calls too.
  - `deleting an agent forgets the DM choices naming it`. Fire `agents:deleted { agentId: 'agt_x', ownerId: 'usr_a', ownerType: 'user' }`: the rows naming agt_x are gone and the others stay.
  - `a DM-choice cleanup that fails is logged code-only, and the bindings and the bot still go`. `dmAgents.removeForAgent` rejects with an error carrying `code: 'ECONNRESET'` and a message containing `usr_a`. Assert exactly one `warn` line `slack_agent_cleanup_failed` with fields `{ stage: 'dm-agents', code: 'ECONNRESET' }`, that the serialized log lines don't contain `usr_a`, that the channel rows are removed, and that `bots.removeForAgent` was called.
- [ ] **Step 3: Run them and see them fail:** `pnpm --filter @ax/channel-slack test src/__tests__/dm-agents.test.ts src/__tests__/agents-deleted.test.ts`
- [ ] **Step 4: Implement** the migration, the store, the subscriber step and the plugin wiring.
  - The subscriber step runs after `removeChannels`, before `d.bots.removeForAgent`. It never throws.
  - Also write `memory-dm-agent-store.ts` with the same rules (`set` replaces, `removeForAgent` returns the count, `faults` throw).
- [ ] **Step 5: Run and see them pass:** the same command, plus `pnpm --filter @ax/channel-slack build` and `pnpm test:scripts` (the agent-keyed-tables guard must pass).
- [ ] **Step 6: Commit** `[TASK-1238] channel-slack: keep each person's Slack DM agent choice, forgotten with its agent`

---

### Task 2: DMs go to the chosen agent, and the settings name who answers [tier: sensitive]

security-checklist: covered by the walk in Task 3, Step 6.

**Files:**
- Modify: `packages/channel-slack/src/turn.ts` (`pickPersonalAgent` and its doc comment)
- Modify: `packages/channel-slack/src/router.ts`. Change the header step 5 at `:58`, `agentsOf` (keep `displayName`), the `personalAgentFor` doc at `:231-235`, `RouterDeps`, and `routeDm` (pass `d.dmAgents`).
- Modify: `packages/channel-slack/src/agent-routes.ts`. Change `AgentRoutesDeps`, the `personal-agent` member of `AgentSlackStatus` and its doc at `:112-116` (it now names the agent), and `status()`.
- Modify: `packages/channel-slack/src/plugin.ts`. Pass `dmAgents` into `createEventRouter({...})` and into `createAgentSlackRoutes({ bus, installs, channels, dmAgents, logger }, …)`, and fix the "oldest personal agent" line in the header at `:138`.
- Test: `packages/channel-slack/src/__tests__/router.test.ts`, `packages/channel-slack/src/__tests__/agent-routes.test.ts`

**Interfaces:**
- Consumes: `DmAgentStore`, `memoryDmAgentStore` (Task 1).
- Produces:
```ts
// turn.ts
export function pickPersonalAgent(
  agents: ReadonlyArray<AgentChoice>, userId: string, chosen: string | null = null,
): string | null;
// router.ts
export interface DmAgent { id: string; /** displayName as agents lists it; '' when it had none. Owner-authored. */ name: string }
export async function personalAgentFor(
  bus: HookBus, ctx: AgentContext, userId: string, choices: Pick<DmAgentStore, 'get'>,
): Promise<DmAgent | null>;
export async function isOwnPersonalAgent(
  bus: HookBus, ctx: AgentContext, userId: string, agentId: string,
): Promise<boolean>; // pickPersonalAgent(listed, userId, agentId) === agentId; used by Task 3
// RouterDeps gains: dmAgents: Pick<DmAgentStore, 'get'>
// AgentRoutesDeps gains: dmAgents: Pick<DmAgentStore, 'get'>   (Task 3 widens it to 'get' | 'set')
// AgentSlackStatus: | { state: 'personal-agent'; botName: string; answersDms: boolean; dmAgentName: string | null }
```
- `pickPersonalAgent`: if `chosen` names an agent in `agents` that passes the existing filter, return it. Otherwise apply today's oldest rule, unchanged. `personalAgentFor` reads `choices.get(userId)` and `agents:list-for-user({ userId, teamIds: [] })`, and either throwing propagates. In `routeDm` that is the existing `failed('agents', err)`.
- `dmAgentName` is `null` when the pick is this agent or there is no pick. Otherwise it is the pick's `name`.

- [ ] **Step 1: Write the failing router tests** in `router.test.ts`. `world()` gains `dmChoices?: Record<string, string>` (planted into a `memoryDmAgentStore`, exposed as `w.dm`) and `dmChoiceReadFails?: boolean`. Use the existing `AGENTS` fixture: usr_alice has `agt_alice_new`, `agt_team_ops` (a team agent) and `agt_alice_old`. usr_bob has `agt_bob`.
  - `a DM goes to the personal agent its sender chose`. With `{ usr_alice: 'agt_alice_new' }`: `conversations[0].input.agentId` and `invokes[0].ctx.agentId` are `'agt_alice_new'`, and `w.dm.calls` holds exactly one `get('usr_alice')`.
  - `a choice that is no longer the sender's own personal agent is ignored: the oldest answers`. For each of `agt_team_ops`, `agt_bob` and `agt_gone`, the invoke's agentId is `'agt_alice_old'`.
  - `a choice store that can't be read fails the DM: try again, and no agent runs`. The DM thread's reply is `COPY.turnFailed`. `w.invokes` and `w.conversations` are `[]`. There is one error line `slack_event_failed` `{ installId, stage: 'agents', code }`, and the serialized lines contain no `usr_alice`.
  - `a message routed before a switch keeps its agent; the next one takes the new choice`. Gate msg1 (thread T1) so it is running. Send msg2 in T1 (queued behind it). Then set `w.dm.rows.set('usr_alice', 'agt_alice_new')`. Send msg3 in a new thread T2, then release the gate. By message text: msg1 and msg2 ran on `agt_alice_old`, and msg3 on `agt_alice_new`.
  - `pickPersonalAgent honors a chosen agent only when it is the user's own personal agent`. It returns `'agt_alice_new'` for chosen `'agt_alice_new'`, and `'agt_alice_old'` for `'agt_team_ops'`, `'agt_bob'` and `null`. Keep the existing oldest/tie/undated tests unchanged.
- [ ] **Step 2: Write the failing status tests** in `agent-routes.test.ts`. `world()` puts a `memoryDmAgentStore()` in `deps.dmAgents` and exposes it as `w.dm`.
  - Rewrite `says whether a personal agent is the one its owner's DMs reach…`. With no choice: PATS gets `{ state: 'personal-agent', botName: 'canopy-works', answersDms: true, dmAgentName: null }`, and `later` gets `{ …, answersDms: false, dmAgentName: "Pat's agent" }`. The list input is still `{ userId: PAT.id, teamIds: [] }`.
  - `a stored choice moves the DMs, and the other agent's page names it`. With `w.dm.rows.set(PAT.id, later.id)`: later gets `answersDms: true, dmAgentName: null`, and PATS gets `answersDms: false, dmAgentName: 'Pat later'`.
  - `a choice naming a team agent or a gone agent is ignored`. With the row set to `SUPPORT.id`, then `'agt_gone'`, PATS gets `answersDms: true` both times.
  - `a choice store that can't be read is a 500 on the status, logged code-only`. Set `w.dm.faults.get` to an error with `code: 'ECONNRESET'` and message `'db down usr_pat'`. The answer is `{ status: 500, body: { error: 'internal' } }`, the line is `slack_channel_route_failed { stage: 'status', code: 'ECONNRESET' }`, and no line contains `usr_pat`.
  - The existing `says a personal agent is one…` body gains `dmAgentName: null`.
- [ ] **Step 3: Run and see them fail:** `pnpm --filter @ax/channel-slack test src/__tests__/router.test.ts src/__tests__/agent-routes.test.ts`
- [ ] **Step 4: Implement** the signatures above, and wire them in plugin.ts.
- [ ] **Step 5: Run and see them pass.** Run the whole `pnpm --filter @ax/channel-slack test`, including plugin.test.ts, which boots the real wiring. Then `pnpm --filter @ax/channel-slack build`.
- [ ] **Step 6: Commit** `[TASK-1238] channel-slack: a DM goes to the agent its sender chose, checked every time; settings name who answers`

---

### Task 3: The owner-only route that makes this agent the DM agent [tier: sensitive]

security-checklist: **required**. This is a new per-person write route.

**Files:**
- Modify: `packages/channel-slack/src/agent-routes.ts`. Add the route, widen `AgentRoutesDeps.dmAgents` to `Pick<DmAgentStore, 'get' | 'set'>`, and add the route to the header's route list.
- Modify: `packages/channel-slack/src/plugin.ts`. Add `POST /settings/slack/:agentId/dm-agent` to the header's route list.
- Test: `packages/channel-slack/src/__tests__/agent-routes.test.ts`, `packages/channel-slack/src/__tests__/plugin.test.ts`

**Interfaces:**
- Consumes: `checkRights` (channels.ts), `isOwnPersonalAgent` (Task 2), `DmAgentStore.set` (Task 1).
- Produces: `route('POST', '/dm-agent', 'dm-agent', chooseDmAgent)`, appended last in `createAgentSlackRoutes`'s array. Its behavior is the §1 table.
- `chooseDmAgent` works in this order:
  1. `checkRights(…, 'view')`. `not-found` gives 404. `ok` (a team agent) gives 403 `forbidden`.
  2. On `personal-agent`, call `isOwnPersonalAgent`. If it says no, 404.
  3. `d.dmAgents.set(userId, agentId)`.
  4. Answer 200 `{}`.

  The body is never read.

- [ ] **Step 1: Write the failing route tests** in `agent-routes.test.ts`.
  - Add `'/dm-agent'` to `Suffix` and to `EVERY_ROUTE` (so the existing 401 loop and the bad-id 404 loop cover it).
  - Exclude it from `WRITES`: `.filter((r) => r.suffix !== '' && r.suffix !== '/dm-agent')`. The bot routes' rights loops don't apply to it. Re-read each loop that uses `EVERY_ROUTE` and confirm its expectation holds for the new route.
  - New tests:
    - `the owner makes a later personal agent the DM agent: stored, and both pages say so`. POST as PAT on `later` gives `{ status: 200, body: {} }`. `w.dm.rows.get(PAT.id)` is `later.id`. Status for later: `answersDms: true`. For PATS: `answersDms: false, dmAgentName: 'Pat later'`.
    - `choosing again replaces the choice, and choosing the same one twice is fine`
    - `someone else's personal agent and a missing one are the same 404, and nothing is stored`. ADA on PATS, and PAT on `'agt_nobody'`. `w.dm.calls` has no `set`.
    - `a team agent is never the DM agent: 403 to its members and team admins, 404 to someone outside the team`. MEL, ADA and WILL on SUPPORT get `FORBIDDEN`. OTTO on SUPPORT gets `NOT_FOUND`. Nothing is stored.
    - `the path decides, never the body`. POST on PATS with body `{ agentId: SUPPORT.id }` stores `PATS.id`.
    - `a store that can't write is a 500, logged code-only`. With `faults.set` carrying code `ECONNRESET`, the answer is `{ status: 500, body: { error: 'internal' } }`, the line is `slack_channel_route_failed { stage: 'dm-agent', code: 'ECONNRESET' }`, and no line contains `usr_pat`.
  - Route list pin in `agent-routes.test.ts`: append `{ method: 'POST', path: '/settings/slack/:agentId/dm-agent', bypassCsrf: undefined, maxBodyBytes: ADMIN_BODY_MAX_BYTES }`.
  - In `plugin.test.ts`, rename `init registers the twenty-nine routes…` to `…thirty routes…`. Add `{ method: 'POST', path: '/settings/slack/:agentId/dm-agent', bypassCsrf: false, maxBodyBytes: ADMIN_BODY_MAX_BYTES }` right after the `/bot-request/cancel` entry.
- [ ] **Step 2: Run and see them fail:** `pnpm --filter @ax/channel-slack test src/__tests__/agent-routes.test.ts src/__tests__/plugin.test.ts`
- [ ] **Step 3: Implement** `chooseDmAgent` and widen the deps.
- [ ] **Step 4: Run and see them pass:** the full `pnpm --filter @ax/channel-slack test`, then `pnpm --filter @ax/channel-slack build`.
- [ ] **Step 5: Commit** `[TASK-1238] channel-slack: owner-only route to choose which personal agent answers Slack DMs`
- [ ] **Step 6: Run the `security-checklist` skill over Tasks 2 and 3**, and append its note as a row in `.claude/memory/decisions/2026-11-24-TASK-1238.md` for the PR's `## Security review`. Expected answers; challenge each one, don't copy it:
  - **Sandbox:** N/A. Nothing a runner or sandbox can reach changes. The route is host-side behind `auth:require-user`, with no process, network, file or env reach.
  - **Prompt injection:** handled. The only text out is the DM agent's display name. Its owner wrote it, and it is shown only to that owner as a React text node, never posted to Slack or put into a prompt. Message text never picks an agent.
  - **Supply chain:** N/A. No new dependency.
  - **Authz:**
    - The path id is shape-checked.
    - Rights come before anything else: 404 to anyone who can't see the agent, 403 for a team agent.
    - The DM router's own predicate runs before the write, and the body is unread.
    - CSRF is http-server's.
    - Every DM checks the row again, and `conversations:find-or-create` re-asserts reachability. A turn still runs as its sender.
  - **Residuals:**
    - A delete racing the write can orphan a row. It's inert and overwritten by the next choice.
    - Whoever holds a person's Slack session already reaches their agents (design §8 Q4, unchanged).
    - After a switch, a reply in an old thread starts fresh on the new agent (decision 10).
  - Commit the shard row: `[TASK-1238] memory: security note for the DM agent choice`.

---

### Task 4: Prove it through the real plugins [tier: integration]

**Files:**
- Modify: `presets/k8s/src/__tests__/channel-slack-composition.test.ts`

**Interfaces:**
- Consumes: the route (Task 3), the status field (Task 2), the table (Task 1), and the existing helpers `personalAgent`, `connectWorkspace`, `callRoute`, `deliver`, `dm`, `dmTurnCalls`, `query`, `invokes` and `actor`.

- [ ] **Step 1: Write the test.**
  - Add `DANA: SlackPerson = { slackId: 'U07DANA0001', name: 'Dana', email: 'dana@canopyworks.com' }` to `PEOPLE`, and `[DANA.email]: 'usr_dana'` to `AX_USERS`. Dana is used by no other test, so "oldest" is decided in this test alone.
  - Add `it("a person picks which personal agent answers their Slack DMs; deleting it sends them back to the oldest (TASK-1238)")`:
    1. Create `danaOld` with `personalAgent('usr_dana')`. Wait 5 ms, then create `danaNew`. Both are named `'usr_dana agent'`, which also exercises the same-name case on the wire.
    2. `installId = await connectWorkspace()`, then `actor = { id: 'usr_dana', isAdmin: false }`. `callRoute` matches the registered pattern and takes the id in `params`, as the TASK-1167 test does (`:1137`).
    3. `callRoute('GET', '/settings/slack/:agentId', { params: { agentId: danaNew } })` matches `{ status: 200, body: { state: 'personal-agent', answersDms: false, dmAgentName: 'usr_dana agent' } }`.
    4. `callRoute('POST', '/settings/slack/:agentId/dm-agent', { params: { agentId: danaNew }, body: jsonBody({}) })` gives `{ status: 200 }`. The same GET now gives `answersDms: true, dmAgentName: null`. `SELECT agent_id FROM channel_slack_v1_dm_agents WHERE user_id = 'usr_dana'` returns `[{ agent_id: danaNew }]`.
    5. Deliver a DM from DANA and wait for `dmTurnCalls`. The newest invoke's ctx matches `{ userId: 'usr_dana', agentId: danaNew }`.
    6. Call `agents:delete` for `danaNew` with `actor: { userId: 'usr_dana', isAdmin: false }`. `vi.waitFor` until the `channel_slack_v1_dm_agents` query for usr_dana returns `[]`.
    7. Deliver a DM in a new thread. The newest invoke has `agentId: danaOld`.
    8. Read rule, end to end: `INSERT INTO channel_slack_v1_dm_agents (user_id, agent_id) VALUES ('usr_dana', $1)` with the deleted `danaNew`. Deliver one more DM in a new thread. It still goes to `danaOld`.
  - Put the cleanup in `finally`: `actor = null`, `DELETE FROM channel_slack_v1_dm_agents WHERE user_id = 'usr_dana'`, and delete `danaOld`. A failure must not cascade into later tests (mistakes shard TASK-1095).
  - In the first test, change step 1's comment from "Alice's second, newer agent is never picked" to "with no choice made, a DM goes to the oldest".
- [ ] **Step 2: Run it:** `pnpm --filter @ax/preset-k8s test src/__tests__/channel-slack-composition.test.ts` (Docker). It must PASS. If it fails, the real services disagree with Tasks 1–3's fakes: fix the product code, not the test.
- [ ] **Step 3: Commit** `[TASK-1238] preset-k8s: composition test for choosing the Slack DM agent`

---

### Task 5: The button on a personal agent's Slack settings [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/agent-slack.ts`. Change the header route list, the `personal-agent` type and its doc at `:101-104`, `parseStatus`, and add `chooseSlackDmAgent` and `AGENT_SLACK_DM_COPY`.
- Create: `packages/channel-web/src/components/workspace/AgentSlackDms.tsx`
- Modify: `packages/channel-web/src/components/workspace/AgentSlack.tsx`. The `personal-agent` case renders `AgentSlackDms`. Add a `switched` state, reset with `leftOver` when the agent changes. Update the header comment.
- Test: `packages/channel-web/src/lib/__tests__/agent-slack.test.ts`, `packages/channel-web/src/components/workspace/__tests__/AgentSlack.test.tsx` (add `chooseSlackDmAgent: vi.fn()` to its `vi.mock` list), and `packages/channel-web/src/components/workspace/__tests__/AgentSettings.test.tsx` (its mock gains `dmAgentName: null`).

**Interfaces:**
- Consumes: the status shape (Task 2) and the route (Task 3), by shape, never by import.
- Produces:
```ts
// lib/agent-slack.ts
// AgentSlackStatus: | { state: 'personal-agent'; botName: string; answersDms: boolean; dmAgentName: string | null }
export async function chooseSlackDmAgent(agentId: string): Promise<void>; // post(agentId, '/dm-agent', {})
export const AGENT_SLACK_DM_COPY: Readonly<{
  answersHere(agent: string, bot: string): string;   // today's sentence, byte-for-byte
  goesTo(bot: string, other: string): string;
  goesElsewhere(agent: string, bot: string): string; // no name from the server
  useInstead(self: string): string;
  switching: string;
  switched(bot: string, self: string, from: string): string;
  notSwitched: string;
  yourOther(name: string): string;
  thisOne(name: string): string;
}>;
// components/workspace/AgentSlackDms.tsx
export interface AgentSlackDmsProps {
  agentId: string;
  agentName: string;
  botName: string;
  answersDms: boolean;
  dmAgentName: string | null;
  /** Labels from a switch this page just made, for the confirmation; null otherwise. */
  switched: { self: string; from: string } | null;
  /** The switch was stored: the parent keeps the labels and reads the status again. */
  onSwitched: (labels: { self: string; from: string }) => void;
  /** The page is out of date (agentSlackBotStale): the parent reads the status again. */
  onStale: () => void;
}
export function AgentSlackDms(props: AgentSlackDmsProps): JSX.Element;
```
- Parsing: `dmAgentName` that is absent (an older host), `null` or `''` becomes `null`. Any other non-string makes the response `bad-response`. The component also treats anything that isn't a non-empty string as "no name", because a test mock can bypass the parser.
- Copy drafts. These go through the ux pass in Step 3, and tests reference the constants rather than literal text, except `answersHere`, whose existing regex test stays:
  - `answersHere`: `` `${agent} is a personal agent, so it answers in a direct message with ${bot} in Slack. Channels are for team agents.` ``
  - `goesTo`: `` `Direct messages to ${bot} go to ${other}.` ``
  - `goesElsewhere`: `` `${agent} is a personal agent, so it can't join channels. A direct message to ${bot} in Slack goes to another of your personal agents.` ``
  - `useInstead`: `` `Use ${self} instead` ``
  - `switching`: `'Switching…'`
  - `switched`: `` `Done. New direct messages to ${bot} go to ${self}. Anything ${from} is already working on, it finishes.` ``
  - `notSwitched`: `"We couldn't switch your direct messages. Nothing changed. Try again in a minute."`
  - `yourOther`: `` `your other ${name}` ``
  - `thisOne`: `` `this ${name}` ``
- Same name means `a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()`. Then `other = yourOther(dmAgentName.trim())` and `self = thisOne(agentName)`. Otherwise `other = dmAgentName` and `self = agentName`.
- State 2 renders a `<p className="text-[13px] text-muted-foreground">` line, then `<Button variant="outline" size="sm">`. The button is disabled while in flight and shows `switching`.
  - On success: `onSwitched({ self, from: other })`.
  - On `agentSlackBotStale(err)`: `onStale()`.
  - Otherwise: `<Alert variant="destructive">` with `notSwitched`, and the button is enabled again.
- The confirmation appears only when `answersDms` is true and `switched` is not null. It is an `Alert` with `ref`, `tabIndex={-1}` and `cn('rounded-sm', RESOLUTION_FOCUS_RING)`, focused once it mounts. Copy the pattern from `AgentSlackBot.tsx:687-697` and `:751`.

- [ ] **Step 1: Write the failing wire tests** in `agent-slack.test.ts`.
  - `a personal-agent answer carries the agent that answers DMs`: `'Sprout'` is kept, `null` stays null, absent becomes null, `''` becomes null, and `7` throws `AgentSlackError` `bad-response`.
  - `chooseSlackDmAgent posts to the agent's dm-agent route with the write headers`. The URL is `/settings/slack/a1/dm-agent`, the method is `POST`, `x-requested-with` is `ax-admin`, and the body is `'{}'`.
  - A 403 `forbidden` answer becomes an `AgentSlackError` for which `agentSlackBotStale` is true. A 500 `internal` one is not stale.
- [ ] **Step 2: Write the failing component tests** in `AgentSlack.test.tsx`. Use `agentName="Quill"` and `botName: 'canopy'`. Every state also asserts `slackCardWordsFound(slackCardText())` is `[]`.
  - Keep `a personal agent that answers direct messages: one line…, no button`, with `dmAgentName: null` added.
  - Replace the "…without naming another agent" test with `names the agent that answers, and offers this one`. The text is `goesTo('canopy', 'Sprout')`, and there is one button named `useInstead('Quill')`.
  - `two agents with one name read as "your other" and "this"`. With `dmAgentName: ' quill '`, the text is `goesTo('canopy', yourOther('quill'))` and the button is `useInstead(thisOne('Quill'))`.
  - `a server that names no agent shows the old kind of line and no button`. With `dmAgentName: null` and `answersDms: false`, the text is `goesElsewhere('Quill', 'canopy')` and there is no button.
  - `Use Quill instead switches, reads again, and says new messages go to Quill`. `chooseSlackDmAgent` is called once with `'a1'`. The second `fetchAgentSlack` returns `answersDms: true`. The confirmation `switched('canopy', 'Quill', 'Sprout')` is shown, `document.activeElement` is inside it, and there is no button.
  - `while it switches, the button is disabled and a second click sends nothing`. Use a deferred promise, click twice, and assert one call.
  - `a failed switch says nothing changed and keeps the button`. With `AgentSlackError(500, 'internal')`: the text is `notSwitched`, the button is enabled, and `fetchAgentSlack` was called once.
  - `an out-of-date page reads again instead`. With `AgentSlackError(404, 'not-found')`: `fetchAgentSlack` was called twice, and `notSwitched` is absent.
  - `another agent's page doesn't show the confirmation`. After a switch, rerender with `agentId="a2"`: no `switched` text.
- [ ] **Step 3: Copy pass.** Dispatch the `ux-designer` agent with the three states, the confirmation, the failure line and the same-name case. Ask it to decide one thing explicitly: should the confirmation say that a reply in an older thread now goes to the new agent without that thread's history (decision 10)? Apply its rewrites to `AGENT_SLACK_DM_COPY` only, and keep `answersHere` unchanged (the card says to keep it).
- [ ] **Step 4: Run and see the tests fail, implement, then run and see them pass:** `pnpm --filter @ax/channel-web test src/lib/__tests__/agent-slack.test.ts src/components/workspace/__tests__/AgentSlack.test.tsx src/components/workspace/__tests__/AgentSettings.test.tsx`, then `pnpm --filter @ax/channel-web build`.
- [ ] **Step 5: Commit** `[TASK-1238] channel-web: name the agent that answers Slack DMs, and a button to use this one`

---

### Task 6: Mark design §8 Q2 decided, and add the changeset [tier: mechanical]

This is the stale-line fix: §8 Q2 still recommends a slash command.

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md:74` (§2 table, "Sender's personal agent" cell) and `:1785-1788` (§8 Q2)
- Create: `.changeset/slack-dm-agent-choice.md`

- [ ] **Step 1: Edit the design doc.**
  - In the §2 cell, write: `Sender's personal agent: the one they chose in its Slack settings, else their oldest`.
  - Replace §8 Q2 with: `2. ~~**Choosing a personal agent.**~~ **Decided 2026-11-24 (Vinay; TASK-1238):** a button in a personal agent's Slack settings ("Use Juniper instead"), not a slash command. One choice per person, kept by channel-slack and checked on every DM: a chosen agent that is gone, or is no longer the person's own personal agent, falls back to the oldest. It applies to the messages after it; a turn already running or waiting finishes on its agent, and a reply in an older thread starts a new conversation with the chosen agent.`
- [ ] **Step 2: Write the changeset** with frontmatter `'@ax/channel-slack': minor` and `'@ax/channel-web': minor`. The body is one short paragraph in the CLAUDE.md voice:
  - a personal agent's Slack settings now say which of your personal agents answers your Slack DMs;
  - "Use … instead" moves them;
  - it applies to new messages, and a reply already underway finishes where it started;
  - deleting the chosen agent sends DMs back to your oldest.
- [ ] **Step 3: Check:** `git diff --stat` touches only these two files, and `pnpm test:scripts` passes (memory and doc guards).
- [ ] **Step 4: Commit** `[TASK-1238] docs: design §8 Q2 decided (settings button); changeset`

---

## Final gate (before the PR)

```bash
pnpm build
pnpm lint
pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
```
`@ax/auth-better`'s Docker teardown timeout (64/64 passing) is a known local flake. Read the per-package results, not the exit code alone.

The PR description needs the security note from Task 3, Step 6. It also states "Boundary review: not required — no hook added or changed".

## Not in this PR

- **Keeping an older DM thread on the agent it started with after a switch** (decision 10). If Vinay wants it, it needs a DM-thread record, which can't go in `channel_slack_v1_threads` because the capture veto reads that table, or a conversations lookup hook.
- **Switching from inside Slack** (a slash command, or a picker in the DM).
- **Reset cleanup of `channel_slack_v1_dm_agents`.** The rows are inert.
- **A kind walk.** Task 4 drives the real route, store, router and `agents:deleted`. Vinay can check his two Junipers on prod after a deploy.
