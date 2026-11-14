# TASK-1091: `ctx.source: 'external'` + `ctx.audience` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every turn two host-stamped facts. `source` says who is present, and now includes `'external'`: someone without access to the agent. `audience` (`'private' | 'shared'`) says who sees the reply. Make every consumer act on both explicitly, so a Slack channel (TASK-1094) can switch them on safely.

**Architecture:** Both fields live on `AgentContext` in `@ax/core`, beside two fail-closed helpers. They cross the runner boundary only through the session record, using the same chain `source` already uses (TASK-181). Memory stamps every statement with its audience. Every memory read and every memory write goes through one wrapper each, and a shared turn reads only shared rows. Approvals, identity edits and skill authoring are refused or held for external turns. A warm runner session never serves a turn of a different `(source, audience)`.

**Tech Stack:** TypeScript (exactOptionalPropertyTypes), zod, vitest, SQLite (better-sqlite3 + FTS5 + sqlite-vec), Postgres via Kysely + Testcontainers, React + shadcn (channel-web).

**Spec:** `docs/plans/2026-11-09-channel-slack-design.md` §2, §2a, §6 (binding, decided by Vinay 2026-11-12). Card body: TASK-1091. Spike decisions: `.claude/memory/decisions/2026-11-12-TASK-1090.md`. Planner decisions: `.claude/memory/decisions/2026-11-12-TASK-1091.md`.

## Stacking and the half-wired window

This card is the base of the stack TASK-1091 → TASK-1092 → TASK-1093. Following Vinay's 2026-10-12 rule ("naming a window does NOT close it"), nothing merges on its own: the stack merges as one squash with its first production caller. No temporary caller is added here. Every task below is still complete, tested and reviewable on its own.

**Flag for the builder:** TASK-1093 is DMs only (`source: 'user'`, private). Per design §9 and card TASK-1094, the **first card that produces `'external'` or `'shared'` is TASK-1094**. A squash at 1093 would merge this card's external and shared branches with nothing reaching them. Either extend the stack through TASK-1094, or have Vinay accept that window explicitly. See the decisions shard.

## Global Constraints

- Absent `source` means `'user'`. Absent `audience` means `'private'`. A turn with both absent behaves exactly as today. The one visible difference: new memory rows are stored with `audience: 'private'`.
- `source` and `audience` are **host-stamped only**. They never appear in `@ax/ipc-protocol` and are never read off a request or frame body. The runner's bearer token only selects which session record to read.
- Fail closed. A `source` value this build doesn't know is treated like `'external'` (least privilege). An `audience` value it doesn't know is treated as `'shared'` (least recall).
- Do **not** touch `packages/memory/src/extraction-prompt.ts`. It is fingerprint-pinned (`e7466bf4`). The speaker rule is a deterministic post-filter.
- "Never post-filter a widened pool." The audience filter is pushed into the engine's own predicate, never applied to rows after they come back.
- No cross-plugin imports. Shared helpers live in `@ax/core`.
- UI uses channel-web shadcn primitives and semantic tokens. Invoke the `shadcn` skill (Task 12).
- Put `--filter` before the script: `pnpm --filter @ax/<pkg> test`. Postgres tests (session-postgres, memory-facts-postgres) need an explicit `DOCKER_HOST`. Locally, memory records `unix:///Users/vpulim/.orbstack/run/docker.sock`.
- Gate before the PR: `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint`.
- The PR needs the boundary review (bottom of this file) and a `security-checklist` note.

## The consumer audit

"Attended" (orchestrator, identity) means someone with access to the agent is present: `isAttendedTurn(ctx)`. Decisions' *attendance* is a different question: will anyone answer while the agent is still warm. Today it is answered from the conversation's `origin`.

| Consumer | Today | `'external'` means | Change | Task |
|---|---|---|---|---|
| core `AgentContext` | `'routine' \| 'user'` | new value + `audience` | types + `isAttendedTurn`, `audienceOf` | 1 |
| sandbox-protocol / sandbox-k8s / sandbox-subprocess / session-inmemory / session-postgres / ipc-core / ipc-server / ipc-http | carry `source`; z.enums **reject** `'external'`; `z.object` returns schemas would **strip** `audience` | must carry both | mirror the TASK-181 chain | 2 |
| agents `identity/tools.ts:241,335` | refuses `=== 'routine'` | refused | `!isAttendedTurn(ctx)` | 3 |
| decisions `attendance.ts` (`pre-call.ts`, `plugin.ts` only mention `source` in comments) | origin `web` → attended | **unattended** in any conversation: held for the turn's user (the owner), approved in Today | `=== 'external'` → `'unattended'` before the origin lookup | 3 |
| orchestrator `attended` (:3138: bootstrap + identity scope) | `!== 'routine'` | not attended: no bootstrap, no identity tools | `isAttendedTurn(ctx)` | 4 |
| orchestrator slice 6 (:3768: skip needs-reconnect connectors) | routine only | skip too (nobody present can sign in) | `!isAttendedTurn(ctx)` | 4 |
| orchestrator `routineRun` / `routineRetire` / `spawnSkips` (:2651, :2783, :3017) | routine-only features | none of them | no change (`=== 'routine'` is correct) | 4 (test) |
| orchestrator warm-session reuse (:2765-2905) | ignores `source` | must never inherit another mode's session | spawn-mode guard | 5 |
| ipc-core `skill.propose` (authored + clean scan → **active**, no human) | no source check | refused (a permanent change to the agent, like identity) | refuse `=== 'external'` | 6 |
| memory `conversation.ts` | routine → no conversation | a real thread: attributed | explicit switch | 9 |
| memory `plugin.ts` chat:end note | doesn't skip routine | doesn't skip external; `audience` governs capture | comment | 9 |
| routines `tools.ts:66,113`, `services.ts:451,492`, `brief.ts:200` | refuse `!== 'routine'` | refused (correct already) | tests only | 11 |
| conversations `types.ts:116` | comment only; `origin` is per channel | no code meaning | fix the stale comment | 13 |
| channel-web | never sets either field; ignores forged body fields | n/a | none | — |

## Review Focus

1. **A shared session's runner-side tool call loses `audience` at the IPC boundary.** A `z.object` returns schema strips the field and a `z.enum` rejects `'external'`, so `memory_recall` would read private rows. Pinned end to end through the real session plugin (Task 2, tests 1–2).
2. **Two modes on one conversation reuse a warm session.** An external turn would inherit the owner's identity tools, and a private turn's words would be captured as shared. Pinned in Task 5.
3. **An engine that ignores the filter.** Both engines silently drop unknown recall fields today. Memory's read wrapper throws rather than returning a row not stamped shared (Task 8, backstop test).
4. **Model-written variants of the speaker subject in a shared turn** (`User`, ` user `, `user:<someone>`): all dropped or refused (Task 9 `it.each`).
5. **Rows stored before this card (`audience` NULL) in a shared recall:** never returned (Task 7 contract case "unstamped rows never match").

---

### Task 1: `@ax/core`: `'external'`, `audience`, and two helpers [tier: mechanical]

**Files:**
- Modify: `packages/core/src/context.ts:208-226` (doc + type for `source`), add `audience` after it; `:253-254` (`MakeAgentContextOptions`); `:275` (`makeAgentContext` conditional spread)
- Test: `packages/core/src/__tests__/context.test.ts`

**Interfaces:**
- Produces: `export type AgentContextSource = 'routine' | 'user' | 'external';`
- Produces: `export type AgentContextAudience = 'private' | 'shared';`
- Produces: `AgentContext.source?: AgentContextSource`, `AgentContext.audience?: AgentContextAudience`, and the same two keys on `MakeAgentContextOptions`. The key stays absent, never `undefined`, when omitted.
- Produces: `export function isAttendedTurn(ctx: Pick<AgentContext, 'source'>): boolean`: true for an absent source or `'user'`; false for `'routine'`, `'external'` and any unknown value. Write it as an exhaustive `switch` with a `never` check.
- Produces: `export function audienceOf(ctx: Pick<AgentContext, 'audience'>): AgentContextAudience`: `'private'` when absent or `'private'`, otherwise `'shared'`.

The doc for `'external'` must say: a person is present with no access to the agent; the turn runs as a real user who answers for it (for a channel agent, whoever connected the channel); it is unattended; no identity or skill edits. The doc for `audience` must say: host-stamped only, never from an IPC payload; decides memory, not approvals; instructions and files are not governed by it; **must stay constant for a conversation**, because memory extracts a conversation in batches under the latest turn's audience.

- [ ] **Step 1: Write the failing tests:** `makeAgentContext round-trips source "external" and audience "shared"`; `omitting audience leaves the key absent` (`'audience' in ctx === false`); `isAttendedTurn` table: `{}`→true, `user`→true, `routine`→false, `external`→false, `'bogus' as never`→false; `audienceOf` table: `{}`→private, `private`→private, `shared`→shared, `'public' as never`→shared.
- [ ] **Step 2:** `pnpm --filter @ax/core test`. Expected: FAIL (`isAttendedTurn` is not exported).
- [ ] **Step 3:** Implement the types, field docs and both helpers in `context.ts`. `index.ts` already re-exports the module.
- [ ] **Step 4:** `pnpm --filter @ax/core test && pnpm --filter @ax/core build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): ctx.source 'external' + ctx.audience with fail-closed helpers (TASK-1091)`.

### Task 2: Carry `'external'` and `audience` across the session/IPC boundary [tier: sensitive]

Needs `security-checklist` (IPC transport, sandbox boundary, migration). Template: `.claude/memory/patterns.md` §"AgentContext.source across the IPC boundary (TASK-181)". Mirror every `source` touchpoint with `audience` and widen every `source` union to `'external'`.

**Files:**
- Modify: `packages/sandbox-protocol/src/schemas.ts:311-322`: `source: z.enum(['routine','user','external']).optional()`, `audience: z.enum(['private','shared']).optional()`, plus a SECURITY comment (host-internal hook only).
- Modify: `packages/sandbox-k8s/src/open-session.ts:133-136,207-212` and `packages/sandbox-subprocess/src/open-session.ts:196-199,486-491`: local owner type, and a conditional-spread forward of `audience` into `session:create`.
- Modify: `packages/session-inmemory/src/types.ts:158-166,201-206,329`, `plugin.ts:107-135,218-235,255`, `store.ts:47-63,88,132,151`.
- Modify: `packages/session-postgres/src/migrations.ts:118-137` (add `ALTER TABLE session_postgres_v2_session_agent ADD COLUMN IF NOT EXISTS audience TEXT` after the `source` ALTER; no CHECK), `:179-184` (`SessionAgentRow.audience: string | null`); `plugin.ts:164-199,283,433-460,544-580`; `store.ts:93-135,208-210,254,266,303-348`.
- Modify: `packages/ipc-core/src/auth.ts:38-47,60-68,128`; `packages/ipc-server/src/listener.ts:201`; `packages/ipc-http/src/listener.ts:200`.
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:1003-1014` (owner type) and `:4132-4137` (forward).
- Test: `packages/ipc-server/src/__tests__/source-propagation.test.ts`, `packages/ipc-http/src/__tests__/auth-ctx-propagation.test.ts`, `packages/session-inmemory/src/__tests__/{plugin,store,return-schemas}.test.ts`, `packages/session-postgres/src/__tests__/{plugin,return-schemas}.test.ts`, `packages/sandbox-protocol/src/__tests__/schemas.test.ts`, `packages/sandbox-subprocess/src/__tests__/open-session.test.ts` and `packages/sandbox-k8s/src/__tests__/open-session.test.ts`, `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`.

**Interfaces:**
- Consumes: `AgentContextSource`, `AgentContextAudience`, `audienceOf` (Task 1).
- Produces: `sandbox:open-session` input `owner.audience?: 'private' | 'shared'`. `ResolveMountsInput.owner` carries it automatically (Task 10 reads it).
- Produces: `session:resolve-token` output `audience: 'private' | 'shared' | null` (required in **both** stores' returns schemas) and `source: 'routine' | 'user' | 'external' | null`.
- Produces: `AuthResult.audience: 'private' | 'shared' | null` (`resolved.audience ?? null`). Both listeners add `...(auth.audience !== null ? { audience: auth.audience } : {})`.
- Produces (session-postgres `store.ts`): `normalizeSource(raw): 'routine' | 'user' | 'external' | null` maps NULL → null, a known value → itself, **any other value → `'external'`**. `normalizeAudience(raw): 'private' | 'shared' | null` maps NULL → null, a known value → itself, **any other value → `'shared'`**.
- Produces: both `validateOwner`s accept `source ∈ {'routine','user','external'}` and `audience ∈ {'private','shared'}` (each may be null or undefined) and throw `invalid-payload` for anything else.
- Orchestrator forward: `...(ctx.audience !== undefined ? { audience: audienceOf(ctx) } : {})`. `source` already forwards once the type is widened.

Traps (both silent): today a stored `'external'` fails the `z.enum` in `SessionResolveTokenOutputSchema`, so every IPC call of that session fails. A missing `audience` key in that `z.object` is stripped, so the IPC ctx looks private. Every exact `resolveToken()…toEqual({...})` in both stores' tests needs the new `audience:` key.

- [ ] **Step 1: Write the failing tests.**
  - ipc-server and ipc-http, each through the real bus and the real `@ax/session-inmemory`: `stamps source "external" and audience "shared" onto ctx for the happy-path runner-completed chat:end`; `leaves ctx.audience absent for a session created without one`; `SECURITY: a runner cannot forge source or audience via the chat-end frame`. For the last: session `{source:'external', audience:'shared'}`, frame body adds `{source:'user', audience:'private'}` → ctx keeps `'external'` and `'shared'`.
  - session-inmemory: validateOwner rejects `source:'admin'` and `audience:'public'` (`invalid-payload`).
  - session-postgres (Testcontainers): create `{external, shared}` → resolve-token returns both; legacy row (NULL) → both null; a row whose stored `source` and `audience` are `'weird'` (raw SQL) → resolves `'external'` and `'shared'`; running the migration twice is a no-op.
  - sandbox-protocol: `OpenSessionInputSchema` keeps `owner.audience` after parse (deep-equal) and rejects `audience: 'public'`.
  - sandbox-subprocess and sandbox-k8s: the `session:create` spy sees `owner.source === 'external'` and `owner.audience === 'shared'`; both keys are absent when the input omits them.
  - orchestrator: `agent:invoke` with `{source:'external', audience:'shared'}` → the recorded `sandbox:open-session` owner carries both; a default ctx → neither key.
- [ ] **Step 2:** Run each package's tests (`pnpm --filter @ax/<pkg> test`). Expected: FAIL.
- [ ] **Step 3:** Implement the chain listed under Files. Update the `return-schemas.test.ts` fixtures in both stores.
- [ ] **Step 4:** Re-run all nine packages' tests plus `pnpm build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(session,ipc,sandbox): carry 'external' + audience host-side only (TASK-1091)`.

### Task 3: The card's two gates: no identity edits, and connector calls held for the owner [tier: sensitive]

**Files:**
- Modify: `packages/agents/src/identity/tools.ts:15-30` (comment), `:241`, `:335`: `if (!isAttendedTurn(ctx))` returns `not-available`.
- Modify: `packages/decisions/src/attendance.ts:1-26` (header; this is a stale-line fix: Slack adds a per-turn `'external'`, not only a channel) and `:105-114`. The first statement of `attendanceFor` becomes `if (ctx.source === 'external') return 'unattended';`.
- Test: `packages/agents/src/__tests__/identity-tools.test.ts` (next to `:327`, `:641`, `:730`), `packages/decisions/src/__tests__/attendance.test.ts` (describe `attendanceFor`, `:122`), `packages/decisions/src/__tests__/pre-call.test.ts`.

**Interfaces:** Consumes `isAttendedTurn` (Task 1). Decisions deliberately uses `=== 'external'`, **not** `!isAttendedTurn`. Routine attendance stays with the conversation's origin, per the AW-6 decision of 2026-08-21.

- [ ] **Step 1: Write the failing tests:**
  - `update_identity from an external turn is not available and changes nothing` (`{ ok:false, error:'not-available' }`; record unchanged).
  - `complete_bootstrap from an external turn is not available`.
  - `an external turn is unattended even in a web conversation`: the get-metadata stub answers `origin:'web'`, result is `'unattended'`.
  - pre-call, the card's acceptance: `an external turn's connector call is held for the turn's user, unattended`. Use the real `createAttendanceResolver(bus)`, metadata `origin:'web'`, policy `hold` for `mcp__gmail__send`, `ctx.userId = 'connector-user'`. The subscriber returns a hold; the stored Decision has `ownerUserId: 'connector-user'`, `attendance: 'unattended'`, `status: 'pending'`.
- [ ] **Step 2:** `pnpm --filter @ax/agents test` and `pnpm --filter @ax/decisions test`. Expected: FAIL.
- [ ] **Step 3:** Implement the three code lines and both comments.
- [ ] **Step 4:** Re-run both. Expected: PASS.
- [ ] **Step 5:** Commit `feat(agents,decisions): external turns can't edit identity; their holds are unattended (TASK-1091)`.

### Task 4: Orchestrator: what `'external'` means at spawn [tier: integration]

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:3138` (`const attended = isAttendedTurn(ctx);`), `:3768` (`if (!isAttendedTurn(ctx))`), and the comments at `:1459-1461`, `:1512`, `:1553`, `:2647`, `:3124-3126`, `:3758-3766` (where they now say "routine or external"). Leave `:2651`, `:2783` and `:3017` as `=== 'routine'`, with a one-line note that these are routine-only features.
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`. Widen `sourcedCtx` at `:1632` to `AgentContextSource`. Extend near `:1690`, `:3022` and `:8258`/`:8280`.

**Interfaces:** Consumes `isAttendedTurn`, `AgentContextSource` (Task 1).

- [ ] **Step 1: Write the failing tests:**
  - `an external turn of a non-wildcard agent does not see routine_report` (same list as the user case).
  - `an external turn never bootstraps and is offered neither identity tool`, plus its wildcard twin (mirroring `:8258` and `:8280`).
  - Turn `:3022` into `it.each(['routine','external'])`: an expired Gmail is skipped and the turn completes. `:3075` (interactive) still fails with `connector-needs-reconnect`.
- [ ] **Step 2:** `pnpm --filter @ax/chat-orchestrator test`. Expected: the external cases FAIL.
- [ ] **Step 3:** Implement the two code lines and the comments.
- [ ] **Step 4:** Re-run. Expected: PASS. Then check the card's grep criterion: `grep -rn "source !== 'routine'" packages/*/src --include='*.ts' | grep -v __tests__` should list only the routines gates in `tools.ts`, `services.ts` and `brief.ts`, which are refusals, not "not routine means attended".
- [ ] **Step 5:** Commit `feat(chat-orchestrator): external turns spawn unattended (TASK-1091)`.

### Task 5: Orchestrator: a warm session serves only turns of its own mode [tier: sensitive]

Why: an IPC-rebuilt ctx reads `source` and `audience` from the session record, which is written once at spawn. Without this guard, an external turn queued into a session spawned for the owner runs with the owner's identity tools and attended approvals. A private turn queued into a shared session has its words captured as shared.

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`:
  - New map beside `augmentGenBySession` (`:2133`).
  - Set after `sandbox:open-session` succeeds (`:4156`).
  - Delete at every `augmentGenBySession.delete` (`:1874`, `:2898`, `:4201`, `:4460`).
  - Routing decision `:2765-2905`.
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` (keepalive section near `:7704`) and `route-by-conversation.test.ts`.

**Interfaces:**
- Consumes: `audienceOf`, `AgentContextSource`, `AgentContextAudience` (Task 1).
- Internal: `interface SpawnMode { source: AgentContextSource; audience: AgentContextAudience }`; `function spawnModeOf(ctx: AgentContext): SpawnMode` returns `{ source: ctx.source ?? 'user', audience: audienceOf(ctx) }`; `const spawnModeBySession = new Map<string, SpawnMode>()`.
- Rule:
  - **Known** mode: `modeChanged = known.source !== turn.source || known.audience !== turn.audience`.
  - **Unknown** mode (a session this process didn't open): `modeChanged = !(turn.source === 'user' && turn.audience === 'private')`. A default turn keeps today's routing; anything else fails closed. This keeps `route-by-conversation` test 3 green unchanged.
  - `modeChanged` on a **busy** session (`sessionBusy`): end the turn `{ kind: 'terminated', reason: 'conversation:busy' }` with the same three steps as `conversation:message-not-saved` (`:2714-2722`). Nothing is queued, spawned or terminated.
  - `modeChanged` on an **idle** session: retire it like `routineRetire`. Add it to all four retire disjunctions so the costlier checks are skipped, and log `stale_session_respawn` with reason `'turn-mode-changed'`.

- [ ] **Step 1: Write the failing tests:**
  - `an external turn on a conversation whose warm session was spawned for its owner retires it and spawns fresh`: two opens; the second `session:create` owner has `source:'external'`; reason `turn-mode-changed`.
  - `a shared turn on a conversation whose warm session is private retires it` (audience only).
  - `a second external turn routes into the external warm session`: one open, `queue-work` to it.
  - `a different-mode turn while the session is busy ends terminated conversation:busy and queues nothing`: hold the first turn open with a deferred.
  - route-by-conversation: `an external turn never routes into a live session this host did not open` (mirror test 3 with an external ctx): `sandboxOpen === 1`, and `session:terminate` is called for `s-existing`.
- [ ] **Step 2:** `pnpm --filter @ax/chat-orchestrator test`. Expected: FAIL.
- [ ] **Step 3:** Implement the map, the rule, the refusal and the retire reason.
- [ ] **Step 4:** Re-run the whole package, since routing is shared by every test file. Expected: PASS.
- [ ] **Step 5:** Commit `fix(chat-orchestrator): a warm session never serves another turn mode (TASK-1091)`.

### Task 6: Skill authoring is refused from external turns [tier: sensitive]

Planner decision, which Vinay can veto. Design §2 forbids identity edits for external turns because people without access must not change the agent. An authored skill with a clean scan goes **active with no human** (`skills/src/propose-gate.ts:34-35`), the same class of permanent change. If vetoed, drop this task and its line in Task 13. Routine sessions are untouched, because the skill-reflection routine depends on them.

**Files:**
- Modify: `packages/ipc-core/src/handlers/skill-propose.ts:113-120` (after the owner-less check, before `bus.call`).
- Test: `packages/ipc-core/src/__tests__/skill-propose-handler.test.ts`.

**Interfaces:** `if (ctx.source === 'external') return hookRejected('skill.propose: skills can\'t be saved from a conversation with people who don\'t have access to this agent. Nothing was saved.')`. The text is fixed and model-safe.

- [ ] **Step 1: Write the failing tests:** `refuses an external session's proposal without calling skills:propose` (spy: zero calls; response equals `hookRejected`'s shape); `still forwards a routine session's proposal`.
- [ ] **Step 2:** `pnpm --filter @ax/ipc-core test`. Expected: FAIL.
- [ ] **Step 3:** Implement the guard.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ipc-core): external turns can't author skills (TASK-1091)`.

### Task 7: Facts engines: an `audience` stamp and a shared-only recall filter [tier: sensitive]

Needs `security-checklist` (a migration plus a security filter). The template is TASK-648 `source_role` (commit `252deaea7`). Postgres has no ranked `query` path; SQLite (the live engine, `presets/memory`) does.

**Files:**
- Modify: `packages/memory-facts-contract/src/index.ts`: `FactStatementInput` (`:80-143`), `FactRecord` (`:162-265`), `RecallInput` (`:282-414`). Add a new describe after `'conversationId filter'` (`:2323-2428`).
- Modify (sqlite):
  - `schema.ts:54-99` (`FactRow`) and `:272-349` (`migrateAddColumns`: `if (!present.has('audience')) ALTER TABLE memory_facts_v1 ADD COLUMN audience TEXT`).
  - `plugin.ts`: `:207-222` `validateStatement`, `:352-442` `validateRecallInput`, `:558-584` `rowToFactRecord`, `:797-932` `fusionRecall` (args and `ChannelScope`), `:1292-1314` and `:1335-1350` record, `:1380-1393` forward, `:1413-1455` listing condition.
  - `recall.ts:134-184` (`ChannelScope`, `scopeFilter`) and `:338-364` (`rowsInRankOrder`).
  - `closure.ts:18-36,150-177` (insert).
- Modify (postgres): `schema.ts:9-62,153-164` (`ADD COLUMN IF NOT EXISTS audience TEXT`); `plugin.ts:200-215,324-402,518-548,808-847,882-927`; `closure.ts:22-40,169-192`.
- Test: contract cases; `packages/memory-facts-sqlite/src/__tests__/{schema-migration,fusion-recall,rank-hydration-scope}.test.ts`; `packages/memory-facts-postgres/src/__tests__/postgres-edges.test.ts`.

**Interfaces (produces):**
- `FactStatementInput.audience?: 'private' | 'shared'`. A provenance stamp the product layer decides. `record` rejects any other value (including `''`, `null`, non-strings) with `invalid-payload`.
- `FactRecord.audience?: 'private' | 'shared'`, echoed exactly as stored on the record response, recall, `batchKey` replay and `scan`. Absent on a row stored without one.
- `RecallInput.audience?: 'shared'`. Only `'shared'` is accepted (`'private'`, `''`, `'SHARED'` and non-strings are rejected with `invalid-payload`). Strict equality, so NULL never matches. It is pushed into the listing predicate and, in SQLite, into every channel (sparse, dense base-table filter, temporal) and the rank hydration.
- Column: nullable `audience TEXT` on `memory_facts_v1`, no CHECK. The FTS5 and vec0 shadow tables don't change. Slot closure stays tenant-wide by design (a residual; see the shard).

- [ ] **Step 1: Write the failing contract cases** (new describe `'audience stamp + shared-only recall'`):
  - `echoes audience %s on the record response, a recalled row, a replay and scan` (`it.each` private and shared); `omits audience when absent`.
  - `record rejects audience %j` (`'public'`, `''`, `1`, `null`).
  - `a shared recall returns only rows stamped shared`: seed shared, private and unstamped rows; only shared comes back. This is the "unstamped rows never match" case.
  - `limit counts shared rows, not a widened pool`: 2 older shared + 10 newer private, `limit 2` returns both shared.
  - `composes with ownerUserId`.
  - `needsFusion: a shared query recall returns only shared rows`, even when a private row matches the query better.
  - `recall rejects audience %j` (`'private'`, `''`, `'SHARED'`, `1`).
  - `omitting audience recalls every row as before`.
- [ ] **Step 2: Write the failing engine tests:**
  - sqlite: `a legacy database gains the audience column on open, and a second open is a no-op` (`LEGACY_SCHEMA`); `the dense channel never surfaces a private row to a shared query` (with an embedder, `hashVector` setup); `rank hydration applies the audience clause across the 500-id chunk boundary`.
  - postgres: `re-running the migration after DROP COLUMN audience restores it`.
- [ ] **Step 3:** `pnpm --filter @ax/memory-facts-contract build && pnpm --filter @ax/memory-facts-sqlite test && DOCKER_HOST=… pnpm --filter @ax/memory-facts-postgres test`. Expected: FAIL.
- [ ] **Step 4:** Implement both engines.
- [ ] **Step 5:** Re-run Step 3. Expected: PASS. Postgres's `needsFusion` cases report skipped, as today.
- [ ] **Step 6:** Commit `feat(memory-facts): audience stamp + shared-only recall in both engines (TASK-1091)`.

### Task 8: Memory read side: a shared turn recalls shared statements only [tier: sensitive]

**Files:**
- Create: `packages/memory/src/audience.ts`.
- Modify: `packages/memory/src/plugin.ts`:
  - `:246-257` (`FORBIDDEN_PAYLOAD_FIELDS` gains `'audience'`) and `:273-300` (`EngineFactRecord.audience?: string`).
  - Every `FACTS_RECALL_HOOK` call goes through `recallFacts`: `:740`, `:861`, `:925`, `:2037`, `:2075`, `:2105`.
  - Output mapping `:995-1030`, and `toMemoryStatement` `:2346+`. A present `audience` must be `'private'` or `'shared'`, otherwise the row is malformed. Set `audience: 'shared'` only for shared rows.
- Modify: `packages/memory/src/augment.ts:163` (`EngineFactRecord`) and `:586-605` (the `recall` closure calls `recallFacts(bus, ctx, factsRecallHook, …)`).
- Modify: `packages/memory/src/types.ts:45-114`: `MemoryStatement.audience?: 'shared'`, a read-only display field that is absent for private and unstamped rows.
- Modify: `packages/memory/src/__tests__/harness.ts:64,172-181`: `ctx()` accepts `audience` and an `AgentContextSource`.
- Test: create `packages/memory/src/__tests__/audience.test.ts` (`makeMemoryHarness`, real SQLite).

**Interfaces:**
- Consumes: `audienceOf` (Task 1); engine `RecallInput.audience` and `FactRecord.audience` (Task 7).
- Produces: `recallAudienceScope(ctx: Pick<AgentContext,'audience'>): { audience?: 'shared' }`.
- Produces: `recallFacts<TOut>(bus: HookBus, ctx: AgentContext, hookName: string, input: Record<string, unknown>): Promise<TOut | null>`. It spreads the scope **last**, so a caller can't override it. In a shared ctx, if the reply's `statements` array holds any row whose `audience !== 'shared'`, it throws `PluginError { code: 'invalid-return', hookName }`. The message says the engine ignored the audience scope and never carries row text.

- [ ] **Step 1: Write the failing tests:**
  - `a private statement is never recalled in a shared turn`. `memory:remember` X in a private ctx. In a shared ctx, the listing and a `query` recall don't return X, and the `system-prompt:augment:optional:memory` text doesn't contain X.
  - `a shared statement IS recalled in a private turn`. Seed with `engineRecord(…audience:'shared')`. A private recall returns it with `audience: 'shared'`.
  - `absent audience behaves exactly as today`. A spy shows no `audience` key on any engine recall from a private ctx, and private rows' `MemoryStatement` has no `audience` key.
  - `every engine recall under a shared ctx carries audience "shared"`. Spy across `memory:recall` (listing, `query`, `profile`, `activeOnly:false`, `conversationId`), the augment, and `tool:execute:memory_recall`.
  - `a shared read that gets a non-shared row back fails instead of returning it`. Stub the engine recall so it ignores `audience`. `memory:recall` rejects `invalid-return`, and the `memory_recall` tool reports failure.
  - `audience is not a caller-settable field`: `audience` in a `memory:recall` or `memory:remember` payload is `invalid-payload`.
- [ ] **Step 2:** `pnpm --filter @ax/memory test`. Expected: FAIL.
- [ ] **Step 3:** Implement `audience.ts`, route the seven call sites, then do the mapping and the type.
- [ ] **Step 4:** Re-run, and check `pnpm --filter @ax/memory build`, since `tsc` excludes test files. Expected: PASS.
- [ ] **Step 5:** Commit `feat(memory): a shared turn recalls only shared statements (TASK-1091)`.

### Task 9: Memory write side: stamp every statement; shared turns store no speaker facts [tier: sensitive]

Needs `security-checklist` (model output becomes stored memory).

**Files:**
- Modify: `packages/memory/src/audience.ts` (add the two functions below) and `subject.ts` (cross-reference: rewrite narrow, drop broad).
- Modify: `packages/memory/src/observer.ts`:
  - `:231-250` (`RunObserverInput.audience: AgentContextAudience`) and `:374-377`.
  - `:701-769` (`toStatements` takes `audience` and returns `speakerFacts`).
  - Result kinds `:80-160`: a new skipped reason `'only-speaker-facts'` with `speakerFacts: number`; the recorded result gains `speakerFacts`.
- Modify: `packages/memory/src/plugin.ts`:
  - `:1087` (`recordHumanStatement` writes through `recordFacts`).
  - `:1648-1730` (`observe` passes `audience: audienceOf(ctx)`; the `record` callback uses `recordFacts`).
  - `:1440-1470` (the chat:end note covers external).
- Modify: `packages/memory/src/note-tool.ts:200-245` (refusal, then `recordFacts`); `conversation.ts:41-45`; `owner.ts:22-28` (comment).
- Test: `packages/memory/src/__tests__/{audience,observer,note-tool}.test.ts`.

**Interfaces:**
- Produces: `isPersonSubject(about: string): boolean`: `about.trim().toLowerCase()` is `'user'` or starts with `'user:'`.
- Produces: `recordFacts<TOut>(bus, ctx, hookName, input: { batchKey?: string; statements: ReadonlyArray<Record<string, unknown>> }): Promise<TOut | null>`. It sets `audience: audienceOf(ctx)` on every statement, overwriting any value. Backstop: in a shared ctx, it throws `PluginError { code: 'forbidden' }` if any `about` is a person subject.
- `toStatements(facts, { ownerUserId, conversationId, audience }) → { statements, unusable, selfReports, speakerFacts }`. In a shared turn, person-subject facts are dropped and counted before any rewrite.
- Note tool, shared ctx with a person-subject `about`: `{ ok: false, error: 'forbidden', message: \`${NOT_SAVED} Notes about a person aren't saved in a shared conversation.\` }`, with no engine call.
- `conversationOf`: `'routine'` → undefined; `'external'`, `'user'` or absent → `ctx.conversationId`; an unknown value → undefined.

- [ ] **Step 1: Write the failing tests:**
  - `a shared turn stores no speaker facts`. Observer pass in a shared ctx; the stubbed LLM returns `user|lives_in|Paris`, `User|prefers|tea`, `user:abc|works_at|X`, `billing_service|owner|Dana`. Only the billing row is stored, stamped `'shared'`, and the log shows `speakerFacts: 3`.
  - `a private turn still rewrites the speaker`. Same facts in a private ctx: a `user:<id>` row is stored, stamped `'private'`.
  - `every write is stamped with its turn's audience`: `remember` (private) gives an engine row with `'private'`; `memory_note` in a shared ctx gives `'shared'`.
  - `memory_note about a person in a shared turn saves nothing` (`it.each` `'user'`, `'User'`, `'user:someone'`).
  - `the observer's twin reads in a shared turn carry the scope` (spy).
  - `an external turn's statements keep their conversation; a routine's stay unattributed`.
- [ ] **Step 2:** `pnpm --filter @ax/memory test`. Expected: FAIL. Existing tests that assert exact `memory:facts:record` payloads now need `audience: 'private'`. That is expected churn, not a behavior change.
- [ ] **Step 3:** Implement the changes listed under Files.
- [ ] **Step 4:** Re-run and `pnpm --filter @ax/memory build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(memory): stamp audience on every write; shared turns keep no speaker facts (TASK-1091)`.

### Task 10: A shared session gets no `/memory` file view [tier: sensitive]

Production provisions the export (deploy/GKE.md "Provision the NFS export"). The mount holds every fact the agent has and bypasses any recall filter.

**Files:**
- Modify: `packages/memory/src/plugin.ts:634-657` (the `sandbox:memory-mounts` handler).
- Modify: `packages/sandbox-k8s/src/open-session.ts:291-330`.
- Test: `packages/memory/src/__tests__/export.test.ts` (next to `:224`); `packages/sandbox-k8s/src/__tests__/open-session.test.ts` (`:1121+`; remove the `['zero mounts', []]` row from the malformed table at `:1244-1256`).

**Interfaces:**
- Consumes: `ResolveMountsInput.owner.audience` (Task 2).
- Memory: when `owner.audience` is present and not `'private'`, log `memory_mount_withheld` (`agentId`, reason `'shared-audience'`) and return `{ mounts: [] }`. This happens before the flush and the access check, since nothing is granted.
- sandbox-k8s: zero mounts means no memory volume. Exactly one well-formed mount is realized as today. More than one, or a malformed reply, is still `invalid-return`.

- [ ] **Step 1: Write the failing tests:** `a shared session gets no memory mount and nothing is flushed`; `a resolver returning zero mounts opens the pod without a /memory volume`.
- [ ] **Step 2:** `pnpm --filter @ax/memory test` and `pnpm --filter @ax/sandbox-k8s test`. Expected: FAIL.
- [ ] **Step 3:** Implement both changes.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(memory,sandbox-k8s): shared sessions get no /memory view (TASK-1091)`.

### Task 11: Routines: pin that an external turn can't use routine-only gates [tier: mechanical]

No production change: `ctx.source !== 'routine'` already refuses `'external'`. These tests stop anyone from narrowing it to `=== 'user'`.

**Files:** tests only.
- `packages/routines/src/__tests__/report-hook.test.ts:123-124`: add an `'external'` row expecting `no-source`.
- `report-tool.test.ts:393`.
- `brief.test.ts:203`: an external run gets no brief.
- `task-update-read.test.ts`: `routine_read_update` from an external turn is refused.

- [ ] **Step 1:** Add the four cases.
- [ ] **Step 2:** `pnpm --filter @ax/routines test`. Expected: PASS straight away. If any FAILS, that is a real bug; stop and report it.
- [ ] **Step 3:** Commit `test(routines): external turns can't use routine-only tools (TASK-1091)`.

### Task 12: Memory view: label shared memories [tier: mechanical]

Invoke the `shadcn` skill. This card adds a generic "Shared" label. Naming the channel ("learned in #support") waits for TASK-1094: memory never sees a channel name, and `MemoryStatement` deliberately hides conversation ids.

**Files:**
- Modify: `packages/channel-web/src/components/workspace/memory-copy.ts` (near `:345`): `MEMORY_SHARED_BADGE = 'Shared'` and `MEMORY_SHARED_BADGE_HINT = 'Learned in a shared conversation. Anyone there could see it.'`
- Modify: `FactsMemory.tsx`. Add a `SharedBadge` beside `KindBadge` (`:109-111`), rendered next to it at `:456` (card layout) and `:478` (table). Use `<Badge variant="outline" size="compact" title={MEMORY_SHARED_BADGE_HINT}>`.
- Modify: `packages/channel-web/src/lib/workspace-types.ts:880-905` (`audience?: 'shared'`) and `workspace-api.ts:862-884` (`isFactMemoryStatement` rejects any `audience` other than `'shared'`).
- Test: `packages/channel-web/src/components/workspace/__tests__/FactsMemory.test.tsx` and the `workspace-api` tests.

- [ ] **Step 1: Write the failing tests:** `a shared memory shows the Shared badge beside its kind, in the table and the card layout`; `a private memory shows no Shared badge`; `a statement with audience "private" or "x" fails validation`.
- [ ] **Step 2:** `pnpm --filter @ax/channel-web test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run, then `pnpm --filter @ax/channel-web build`. That runs `tsc`, which type-checks channel-web's tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(channel-web): label shared memories in the memory view (TASK-1091)`.

### Task 13: Correct the docs that made the card look complete [tier: mechanical]

**Files:**
- Modify: `docs/plans/2026-11-09-channel-slack-design.md`:
  - `:259-270`: the stale line. The "8 packages that test `source === 'routine'`" list. decisions and conversations only mention `source` in comments (decisions has used conversation origin since 2026-08-21). The real surface includes the session/IPC/sandbox chain that rejected `'external'` and would have dropped `audience`, the routines gates, slice 6, warm-session reuse and `skill.propose`. Point to this plan's audit table.
  - `:359-361`: §9 item 1, same correction.
  - `:68`: "No identity edits or skill authoring are allowed" (if Task 6 stands).
  - `:101-111`: §2a: the label is "Shared" now and names the channel in TASK-1094; a shared session gets no `/memory` file view; the speaker rule drops `user` and `user:*` subjects; the residuals listed in the shard.
  - `:279-292`: §6 `audience` bullets: the read wrapper's backstop, and that audience must be constant per conversation.
- Modify: `packages/conversations/src/types.ts:111-122`. Attendance is the channel's default, and an external turn is unattended in any channel.

- [ ] **Step 1:** Make the edits. Prose only: plain words, short sentences.
- [ ] **Step 2:** `grep -n "8 packages\|all 8" docs/plans/2026-11-09-channel-slack-design.md`. Expected: no matches.
- [ ] **Step 3:** Commit `docs: correct the external/audience consumer list and memory rules (TASK-1091)`.

---

## PR description requirements (not a task)

**Boundary review.** One entry per changed surface.
- `AgentContext.source: 'external'`. Alternate implementation: any channel where the person present lacks access (email-in, a public web widget). Leaky names: none. Subscriber risk: a reader branching on `=== 'routine'` treats external as attended; the audit table lists every one.
- `AgentContext.audience`. Alternate implementation: a mailing list or a shared web room. Leaky names: none. Subscriber risk: a reader that ignores it leaks, so memory reads through one wrapper, and a test pins it.
- `memory:facts:record` / `recall` / `scan` gain `audience` (engine contract). Alternate implementation: the Postgres engine (listing only). Leaky names: none. Subscriber risk: an engine that ignores the filter, which the backstop catches.
- `sandbox:open-session` `owner.audience`, `session:create` `owner.audience`, `session:resolve-token` `audience`. Host-internal only, not IPC actions. No translation.
- `sandbox:memory-mounts` may return zero mounts. Alternate implementation: none needed (same resolver). Risk: a buggy resolver returning `[]` for a private session only loses the file view, which is the safe direction.
- `memory:recall` output `MemoryStatement.audience`. Display only, and refused as an input field.

**Security note.** Run `security-checklist`. It must cover prompt injection (external text → memory, identity, skills), the sandbox (the mount is withheld), and IPC (host-stamped only). List these residuals:
- A speaker named by the sender label (`alice|lives_in|…`) is kept.
- Slot closure is tenant-wide: a private statement can close a shared one, so the shared turn just stops asserting it.
- The engine's `pending` degraded flag counts the whole tenant (1 bit).
- Audience must be constant per conversation. TASK-1094 keys conversations so.
- External turns use the owner's standing approvals, by design.
- Shared-turn notes keep agent provenance.
- A Fix on a shared memory saves the correction as private.
