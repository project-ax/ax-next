# Agent-owned sign-ins — Slice 6 (routine skip warning) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- When a routine run goes without a connector, the routine says so. The connector might not be signed in on the agent, or its sign-in might need doing again.
- Example: "Gmail isn't signed in on Bob, so this run went without it."
- The warning shows on the routine row in the Routines list and on that run in its history.

**Architecture:**
- **chat-orchestrator** already partitions connectors into kept and skipped (TASK-806). It now:
  - (a) for **routine** turns only, also skips connectors whose sign-in needs doing again, instead of failing the whole run;
  - (b) fires a new observation event, `chat:connectors-skipped`, with the turn's `reqId` and the skipped connectors.
- **routines** subscribes, keeps the skips with the in-flight fire, and records a warning when the fire is recorded. It goes on the fire row (`warning`) and on the definition (`last_warning`).
- **channel-web** shows both.

**Tech Stack:** TypeScript, vitest, Postgres via testcontainers, React + shadcn.

**Spec:** `docs/plans/2026-10-07-agent-owned-connector-sign-ins-design.md` §6 "Routines" and Testing › "Routines: a skipped connector writes the warning". **Prereqs:** none functionally. It's stacked on `feat/agent-owned-sign-ins-5` to keep one linear stack.

## Global Constraints

- **Hook surface is transport- and storage-agnostic (invariant 1).** The event payload carries connector ids, display names and a reason word only. It never carries `account:` refs, env names or vault vocabulary.
- **No cross-plugin imports.** Every event fired and subscribed is declared in the manifests. Subscriber timeouts are bounded, the way `fireChatEvent` already does it.
- **One source of truth (invariant 4).** Routines does NOT repeat the presence check. It only learns what the orchestrator actually skipped.
- **Connector names are untrusted.** Reuse the orchestrator's `connectorLabel()` (strips control and format characters, clamps to 64) on the producer side. Routines re-sanitizes when building text: strip control, format and bidi characters, and cap the whole warning at 300 characters. The UI renders it as text.
- **Interactive chats keep today's behaviour.** A non-routine turn whose connector needs reconnect still ends with `connector-needs-reconnect` (the test at `orchestrator.test.ts:~2752` stays green).
- `export DOCKER_HOST=unix:///var/run/docker.sock AX_TESTCONTAINER_START_SLOT_WAIT_MS=120000`. The host is loaded: re-run a timing-out file alone. Use `pnpm --filter <pkg> test` (filter first), tsc per package, and eslint.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings carried in

- **Needs-reconnect becomes a skip for routine turns only** (`ctx.source === 'routine'`).
  - Before the proxy open, the orchestrator asks `mcp-oauth:status-batch {userId, agentId, connectorIds}`. This is an optional call, `hasService`-guarded, with a bounded timeout. It drops connectors in `needsReconnect` with reason `needs-reconnect`.
  - On a missing hook, a throw or a timeout, it keeps them all, which is today's behaviour.
  - Interactive chats keep failing the turn, because that error is what tells a person to sign in again.
  - Cost if wrong: an interactive chat still fails on an expired sign-in, as today.
- **The event:** `chat:connectors-skipped`, payload `{ reqId: string, connectors: Array<{ connectorId: string, name: string, reason: 'not-signed-in' | 'needs-reconnect' }> }`.
  - It's fired once per turn assembly, only when at least one connector is skipped.
  - It's fired for every turn (chat and routine), with the turn's `ctx.reqId`.
  - It's an observation event: subscribers can't veto it.
- **The warning text** is built in routines when the fire is recorded:
  - **One connector:** "{Name} isn't signed in on {Agent}, so this run went without it." For needs-reconnect: "{Name} needs to be signed in again on {Agent}, so this run went without it."
  - **Several, same reason:** "{A} and {B} aren't signed in on {Agent}, so this run went without them." Three or more read "A, B and C". Needs-reconnect uses "need to be signed in again".
  - **Mixed reasons:** two sentences, the not-signed-in one first.
  - **{Agent}** is the agent's display name from `agents:resolve` (already called in `fire.ts`). If it's missing, use "this agent".
- **Where it's stored:**
  - a new `warning TEXT NULL` on the fires table;
  - a new `last_warning TEXT NULL` on the definitions table, written whenever a fire is recorded, for **every fire kind** (tick, manual, webhook).
  - `null` is written when nothing was skipped, so an old warning clears on the next clean run.
  - `store.advance` (which runs right after dispatch) never touches `last_warning`.
- **Fires that end in `settleWithoutTurn`** (terminated) record the warning too, if skips were seen.
- **No new card or notification.** It's display only, in the Routines UI.

## Review Focus

- **A routine whose Gmail sign-in expired:** the run completes without Gmail, records "Gmail needs to be signed in again on Bob…", and doesn't end as `error: terminated: connector-needs-reconnect`.
- **An interactive chat with the same expired Gmail:** still fails with `connector-needs-reconnect`, exactly as today.
- **A connector name with a newline and `‮`, 500 characters long:** the warning is sanitized and capped, and renders as text.
- **Two routines fire at once on one agent:** each warning lands on its own fire, keyed by `reqId`, never crossed.
- **The next run is clean:** `lastWarning` clears to null.

---

### Task 1: chat-orchestrator — routine runs skip expired sign-ins; announce what was skipped

**Files:**
- Modify:
  - `packages/chat-orchestrator/src/connector-union.ts`: `partitionConnectorsBySignIn` :544-604; `connectorLabel` ~:628-640;
  - `packages/chat-orchestrator/src/orchestrator.ts`: the call site :3088-3101; the warm re-check :1687-1700, :2269-2326; the classified failure :3349-3373 (unchanged for chats);
  - `packages/chat-orchestrator/src/plugin.ts`: the manifest's fired events and `optionalCalls` (`mcp-oauth:status-batch`), and the degradation notes ~:84-91.
- Tests:
  - `orchestrator.test.ts` (the TASK-806 block :2527-2830, the warm re-check :6913-7140);
  - `connector-union.test.ts:1081-1230`;
  - `chat-event-subscriber-timeout.test.ts`.

**Interfaces:**
- **Produces:**
  - the event `chat:connectors-skipped` with the payload above;
  - the exported type `ConnectorsSkippedPayload` in the orchestrator's types. Routines mirrors it; it doesn't import it.

**Requirements:**
1. `partitionConnectorsBySignIn` returns its skips as `{connector, refs, reason:'not-signed-in'}`. Keep `refs` internal: the warm re-check needs them, but they never go into the event.
2. **For `ctx.source === 'routine'`:**
   - after the presence partition, call `mcp-oauth:status-batch` (optional, guarded, with a 2 s timeout) for the kept OAuth connectors;
   - move any in `needsReconnect` to skipped with `reason:'needs-reconnect'`;
   - add them to the system-prompt skip line too (the existing `skippedConnectorsPromptLine` wording is fine for both reasons).
3. **Fire `chat:connectors-skipped`** with `{reqId: ctx.reqId, connectors:[{connectorId, name: connectorLabel(...), reason}]}` whenever anything was skipped. Use the existing bounded `fireChatEvent` path, and never block or fail the turn on a subscriber.
4. **The warm path.** If a warm turn re-assembles connectors (the re-check paths), fire the event with that turn's `reqId` too. Chats can be warm; keep it consistent. Routines always spawn fresh *by construction*: a turn with `ctx.source === 'routine'` is never routed to a warm session — routing retires any live one (`stale_session_respawn` reason `routine-turn`) and spawns, so a shared routine re-fired inside the keepAlive window still assembles, skips and announces (final-review fix; before it, a warm re-fire fired nothing and cleared the warning).
5. Add the event to the manifest's fired list and `mcp-oauth:status-batch` to `optionalCalls`. Check the k8s preset boot graph for a cycle: does mcp-oauth call chat-orchestrator? Expect not.

**Tests (write first):**
- A routine turn with an expired-sign-in connector:
  - it's skipped;
  - the turn completes;
  - the event has `reason:'needs-reconnect'`;
  - status-batch was called with the agent's ids.
- A chat turn with the same: still ends `connector-needs-reconnect` (the existing test stays green).
- status-batch missing, throwing or hanging: the connector is kept, which is today's routine behaviour.
- A not-signed-in skip fires the event with `reason:'not-signed-in'`.
- Nothing skipped: no event.
- The payload has no `refs` and no `account:` strings. Assert it with JSON-stringify.
- A hostile name is sanitized in the payload.
- A throwing or slow subscriber doesn't fail the turn.

Commit: `chat: routine runs go without an expired connector instead of failing, and say what they skipped`.

### Task 2: routines — remember skipped connectors per fire; record the warning

**Files:**
- Modify in `packages/routines/src/`:
  - `plugin.ts`: `subscribes` :105-110, the turn-end subscriber :185-265;
  - `fire.ts`: the `pending` entries :174, `settleWithoutTurn` :188-206, the agent display name from `agents:resolve` :75;
  - `store.ts`: `rowToRoutine` :212-243, the `claimDue` returning type :364, `recordFire` :432-450, `RecordFireInput` :31-39, plus a new `setLastWarning`;
  - `migrations.ts`: guarded `ALTER`s for `last_warning` and fires `warning`, following :160-170 / :236-256;
  - `types.ts`: `RoutineRow` :42-43 and `RoutineRowSchema` :288-289, plus the fire row type and schema.
- Create `packages/routines/src/skip-warning.ts`, exporting `buildSkipWarning(agentName: string | null, skips: Array<{name: string, reason: 'not-signed-in' | 'needs-reconnect'}>): string | null`.
- Tests:
  - `skip-warning.test.ts` (new);
  - `fire.test.ts`, `service-hooks.test.ts`, `canary.test.ts`, `store.test.ts`, `migrations.test.ts`, `return-schemas.test.ts:48-49`;
  - `ownership.test.ts:289` (hand-built DDL);
  - `skills/src/__tests__/crystallization-canary.test.ts:165` if its fixture needs the field.

**Requirements:**
1. **Subscribe to `chat:connectors-skipped`.**
   - If `pending.get(payload.reqId)` exists, stash the skips on it (merge on repeat).
   - Ignore unknown `reqId`s.
   - Validate the payload defensively: array, string fields, the reason in the set. Drop bad entries.
2. **On `chat:turn-end` and in `settleWithoutTurn`:**
   - compute `warning = buildSkipWarning(agentName, skips)`;
   - pass it to `recordFire` (the fires `warning` column);
   - call `store.setLastWarning(agentId, path, warning)`, writing `null` when there's no warning.
3. **`buildSkipWarning`:** the exact copy in "Rulings carried in". Sanitize names (strip control, format and bidi characters; collapse whitespace), and cap the result at 300 characters.
4. **The wire.** `RoutineRow.lastWarning: string | null` goes in the `routines:list` returns schema (otherwise zod strips it), and the fire row gets `warning`.
5. `advance` is unchanged and doesn't touch `last_warning`.

**Tests (write first):**
- `buildSkipWarning`:
  - one connector, either reason;
  - two;
  - three ("A, B and C");
  - mixed reasons;
  - a null agent name gives "this agent";
  - a hostile name;
  - the cap.
- A fire with a skipped-event, then turn-end: the fire row has the warning and the definition has `lastWarning`.
- The next clean fire clears `lastWarning`.
- Two concurrent fires with different `reqId`s each get their own warning.
- A terminated fire with skips records the warning.
- An event for an unknown `reqId` is ignored.
- The migration is idempotent.
- The returns schema carries `lastWarning`.

Commit: `routines: a run that went without a connector says so`.

### Task 3: channel-web — show the warning

**Files:**
- Modify:
  - `packages/channel-web/src/lib/routines.ts:36-52` (`Routine.lastWarning`), plus the fire type;
  - `components/routines/RoutinesList.tsx` (the name cell ~:274-281);
  - `components/routines/FireRowsTable.tsx:79-88`;
  - the dev mock for routines if one exists (`grep -rn "lastStatus" packages/channel-web/mock`).
- Tests: `src/__tests__/routines-list.test.tsx`, `routines-client.test.ts`, `components/routines/__tests__/FireRowsTable.test.tsx`.

**Requirements:**
1. In the RoutinesList row, under the name, when `lastWarning` is set: a small muted line with a warning icon (lucide `TriangleAlert` or the project's existing warning icon) and the text. Use semantic tokens only (`text-muted-foreground`, or the token the project uses for warnings; check `Alert` variants and existing warning styles). Truncate it, with the full text in `title`.
2. In FireRowsTable, show the fire's `warning` (if any) under its status, in the same style, not as `text-destructive`. A warning isn't an error.
3. Render it as text only.
4. Use the `shadcn` skill.

**Tests:**
- A row with `lastWarning` shows the text.
- A row without it shows nothing.
- A fire row shows its warning, and it isn't styled as destructive.
- A hostile string renders literally.

Commit: `channel-web: routines show when a run went without a connector`.

### Task 4: Gate + memory

- [ ] Run the full gate (the Docker-dependent parts once Docker answers). Re-run Docker-timeout packages alone.
- [ ] Write the decisions shard with `scripts/memory-write-target.sh --shard decisions SIGNINS-8`. Record:
  - routine-only reconnect skip;
  - the event shape and why it carries no refs;
  - the warning written for every fire kind;
  - the null clear.
