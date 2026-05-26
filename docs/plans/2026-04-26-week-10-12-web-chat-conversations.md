# Week 10–12 — Web chat + conversation persistence (MVP) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement task-by-task, OR `superpowers:subagent-driven-development` if dispatching a fresh subagent per task in the same session. Invoke `ax-conventions` and `security-checklist` whenever a task touches a hook surface, IPC boundary, sandbox capability, or new dependency. Tasks marked **[boundary]** require a boundary-review note in the commit message; tasks marked **[security]** require the structured security note. Iₙ markers carry forward from Weeks 6.5d / 7-9 / 9.5; new ones for this slice are J1–J9.

**Goal:** Land the browser chat surface on top of Week 9.5's tenant primitives, with durable conversation history. Users sign in, pick an agent, chat from a browser, and reload the page without losing context. Slack, audit, canary, and memory are deferred to Week 13+.

**Architecture:** One new plugin (`@ax/conversations`) plus extensions to `@ax/channel-web` (chat-flow HTTP routes + SSE), `@ax/ipc-server` (wire `event.stream-chunk` → `chat:stream-chunk` subscriber), `@ax/agent-claude-sdk-runner` (emit stream chunks + replay history on session resume), and `@ax/chat-orchestrator` (resolve conversation → session route). Conversations are postgres-backed, tenant-scoped per (`user_id`, `agent_id`), and subscribe to `chat:turn-end` to append completed turns automatically. Streaming is end-to-end: SDK message iteration → IPC `event.stream-chunk` → bus subscriber filtered by `reqId` → SSE → assistant-ui transport. Conversation:session relationship: each conversation tracks an `active_session_id`; reload reattaches to the live sandbox if alive, else opens a new session and the runner replays history at boot.

**Tech Stack:**
- TypeScript + pnpm workspace (existing).
- Postgres via `@ax/database-postgres` for the conversations table.
- Server-Sent Events (SSE) over `node:http` via `@ax/http-server` (no new dep).
- assistant-ui adapter (already shipped in 9.5) — `@assistant-ui/react`, `@ai-sdk/react`, `ai`.
- Vitest for unit/integration; Playwright (already a dev-dep on `@ax/channel-web`) for e2e where useful.

**Branch base:** `main` at commit `3da6710` (tip of Week 9.5, PR #17 merged). Create the feature branch with `git switch -c feat/week-10-12-web-chat` from a clean `main`. If `main` has advanced, rebase onto the latest tip and re-confirm 9.5 prerequisites are present.

---

## Invariants for this slice (carry forward + new)

**Carried from Week 9.5 (must still hold):**
- **I1** — Hook surface is transport-agnostic. No `sse_`, `cookie_`, `pg_` field names.
- **I2** — No cross-plugin imports. `@ax/conversations` does NOT import `@ax/agents`, `@ax/auth-oidc`, or `@ax/channel-web`. Coordinates via the bus.
- **I4** — One source of truth per concept. The chat transcript lives in `@ax/conversations`. The runner's in-process `history` array (claude-sdk-runner main.ts) is its OWN bookkeeping and MUST NOT be queried by other plugins.
- **I7** — Tenant queries are scoped. Every Kysely query against `conversations_v1_*` MUST include `where('user_id', '=', actor.userId)` (or team-equivalent via `agents:resolve`). Bare `SELECT * FROM conversations_v1_conversations` MUST fail review.
- **I9** — Tokens never leak through hook return values. SSE responses MUST NOT echo bearer tokens, session cookies, or IdP fields. Conversations payloads carry `userId`/`agentId` only — no auth subject IDs.
- **I10** — Session ↔ agent immutability. A conversation's `agent_id` is fixed at create time; switching agents = new conversation.

**New for Week 10–12 (J-series):**
- **J1 — Conversation ACL gate is `agents:resolve`.** Every `conversations:*` service hook calls `agents:resolve(agentId, userId)` first; on `forbidden`/`not-found` the conversation hook rejects with the same code. No conversation-side ACL table.
- **J2 — `chat:stream-chunk` is observation-only.** Subscribers MUST NOT mutate the chunk. The chunk's `text` field is UNTRUSTED model output (not interpolated into shell/path/HTML — only rendered through markdown sanitization client-side).
- **J3 — Tool-result block shape is the Anthropic content-block tuple.** Conversations store `{ role, content_blocks: ContentBlock[] }` per turn where `ContentBlock` is `text | thinking | tool_use | tool_result | image`, mirroring Anthropic's shape so the runner can replay turns into claude-sdk without re-translation. Locked in Task 4; downstream consumers never invent their own shape.
- **J4 — Thinking blocks are stored, hidden by default in UI.** The transcript stores `thinking` blocks (so SDK replay is faithful). The UI hides them behind a per-message toggle (default off). Storing without showing is fine; showing without storing would be lossy on resume.
- **J5 — Soft delete only.** `conversations:delete` sets `deleted_at`; `conversations:list` filters them out. Hard-delete is a Week 13+ admin task. Soft-deleted conversations are NOT resumable.
- **J6 — One sandbox session per conversation at a time.** A conversation has at most one `active_session_id` at any moment. New incoming messages route into that session's inbox if alive; else a fresh session is opened and the runner replays. Two browser tabs = same active session, both observe via filtered `chat:stream-chunk` subscribers.
- **J7 — Reload mid-stream reattaches by `reqId`, not by replay.** When the browser reconnects, it asks for the SSE stream of the conversation's current `active_req_id` (if any); the bus subscriber replays buffered chunks from a small ring buffer (last N chunks per reqId) and then tails live. Exact buffer size locked in Task 7.
- **J8 — Origin allow-list for chat-flow routes.** `POST /api/chat/messages`, `DELETE /api/chat/conversations/:id` are state-changing and inherit the Week 9.5 CSRF middleware (`Origin` allow-list OR `X-Requested-With: ax-admin`). The browser sends Origin natively when same-origin; the static-file mount means same-origin is the common case.
- **J9 — Stream-chunk reqId is server-minted.** The host generates `reqId` when the user message is accepted (`POST /api/chat/messages`), passes it through `chat:run` via `ChatContext`, and returns it to the client in the response body. Client-supplied `reqId` is rejected. Eliminates a class of cross-conversation stream-poisoning bugs.

---

## Scope decisions (locked before plan execution)

These match the handoff doc §"Scope decisions to make while writing the plan". Confirm with the user before starting Task 1 if any need to change:

1. **`chat:stream-chunk` hook plumbing** — Task 5–8 of this plan. Wire from `event.stream-chunk` IPC (schema lives, runtime is 501) → bus subscriber → SSE endpoint. Token-level streaming from the SDK is iterated message-by-message; each text chunk fires one stream-chunk event (small) so multiple browser tabs can subscribe.
2. **Chat UI agent picker** — Per-URL: `/chat/<agentSlug>` (handoff recommendation). The `AgentMenu` component (already shipped) becomes a switcher that updates the URL. Sharing a link is unambiguous.
3. **Conversation ↔ session relationship** — Option (a). Each conversation has an `active_session_id` (nullable). On a new message: if `active_session_id` is set + the session is alive (verified via a `session:is-alive(sessionId)` service hook on `@ax/session-postgres`) → route message into that session's inbox. Else → open a fresh session, set `active_session_id`, the runner pulls history via a new `conversation.fetch-history` IPC RPC and replays into claude-sdk's prompt iterator. (Invariant J6.)
4. **Conversation message shape** — Anthropic content-block tuple (J3). Stored as JSONB; round-trips into the SDK without translation. Thinking blocks stored, hidden by default in UI (J4).
5. **Conversation deletion / archival** — Soft delete only (J5). Hard-delete is a Week 13+ admin task. Re-enabled conversations are out of scope.
6. **Resumable workspace state** — A reloaded conversation reattaches to a live sandbox if `active_session_id` is alive; otherwise it creates a new sandbox and the runner replays the conversation's content-block history. The sandbox's idle-timeout (existing in `@ax/sandbox-subprocess` / `@ax/sandbox-k8s`) defines when `active_session_id` is cleared. **Mid-tool-call reload behavior:** the tool keeps running; reload reattaches via SSE and tails the live stream from the chunk ring buffer + live tail.
7. **Canary scanner deferral risk (handoff §65)** — Acknowledged. MVP ships without `@ax/scanner-canary`, so there is no secret-leak veto on workspace writes and no LLM-output redaction. **Decision:** ship to internal users only; the README and admin dashboard MUST display a "Canary scanner not yet enabled" banner (Task 22). Public exposure is blocked until Week 13+ ships canary.
8. **Multi-replica readiness** — Out of scope for MVP. The SSE chunk ring buffer + active-session routing assume single-replica. Multi-replica fan-out goes through `@ax/eventbus-postgres` in Week 13+; this slice's `chat:stream-chunk` subscriber registration is in-process only.

---

## Acceptance test (from handoff §80, restated for the e2e in Task 25)

End-to-end on a k8s deployment:
1. User A signs in, picks their personal agent (URL `/chat/<agent-slug>`), sends a chat message, sees a streamed response in real time.
2. User A reloads mid-conversation; conversation history reappears AND a new message continues the same thread (same active sandbox if alive; replay if not).
3. User A opens a second tab with the same agent URL; both tabs see the same conversation. A message sent from tab 1 streams into tab 2 in real time.
4. User A shares a team agent's conversation URL with User B (member of the same team); User B loads it, sees the history, posts a continuation.
5. User C (not in the team) loading the same URL → 403 with no history leak in the response body.
6. User A soft-deletes a conversation; it disappears from the sidebar; trying to load by URL → 404.
7. User A's mid-tool-call reload: open a long-running tool, reload during execution → tool keeps running, reload reattaches and observes the tool's completion + the assistant's continued response.

---

## Task ordering rationale

Phase **A (Tasks 1–4)** lands the conversation primitive — schema + hooks + auto-append subscription + content-block shape. No HTTP yet. Phase **B (5–8)** wires the streaming spine: `event.stream-chunk` → bus → SSE. Phase **C (9–13)** mounts the chat-flow HTTP routes on `@ax/http-server`. Phase **D (14–16)** handles conversation:session resume — the gnarliest piece, intentionally late so streaming + persistence are stable first. Phase **E (17–21)** wires the React surface (replaces the mock OpenAI transport, hooks AgentMenu/Sidebar/Thread to the new routes). Phase **F (22–25)** is the canary banner, security rollup, e2e acceptance, and PR.

Each task ends with: tests pass, commit. Most tasks are 30–90 minutes for a fresh subagent.

---

## Task dependency overview

```
A. Foundations               B. Streaming             C. HTTP routes
  1. scaffold                 5. event.stream-chunk    9. POST /messages
  2. service hooks            6. runner emits chunks  10. GET /conversations
  3. chat:turn-end sub        7. SSE + ring buffer    11. GET /conversations/:id
  4. content-block shape (J3) 8. e2e stream test      12. DELETE /conversations/:id
                                                      13. GET /agents
                                                            ↓
D. Resume                    E. Frontend wiring        F. Wrap
 14. active_session_id        17. AX transport          22. canary banner
 15. runner replays history   18. AgentMenu wire        23. security rollup
 16. session-routing in chat  19. Sidebar wire          24. multi-tab e2e
                              20. Thread history load   25. PR
                              21. SSE consumer
```

Phases B and C can run partially in parallel after Phase A lands; Phase D depends on both. Phase E depends on C+D. Subagent dispatch should respect this order.

---

## Task 1: `@ax/conversations` plugin scaffold [boundary]

**Goal:** Empty plugin shell that builds and registers a manifest. No hooks wired yet.

**Files:**
- Create: `packages/conversations/package.json`
- Create: `packages/conversations/tsconfig.json`
- Create: `packages/conversations/src/index.ts`
- Create: `packages/conversations/src/plugin.ts`
- Create: `packages/conversations/src/types.ts`
- Create: `packages/conversations/src/__tests__/plugin.test.ts`
- Modify: `tsconfig.json` (add reference)

**`package.json` shape:** mirror `@ax/agents` exactly — `type: module`, `tsc` build, vitest test, `dependencies: { "@ax/core": "workspace:*", "@ax/database-postgres": "workspace:*", "kysely": "<pin already in repo>", "zod": "<pin already in repo>" }`. NO dependency on `@ax/agents`, `@ax/auth-oidc`, `@ax/channel-web` (I2).

**Step 1: Write failing test.**

```ts
// packages/conversations/src/__tests__/plugin.test.ts
import { describe, expect, it } from 'vitest';
import { createTestHarness, MockServices } from '@ax/test-harness';
import { createConversationsPlugin } from '../plugin.js';

describe('@ax/conversations plugin', () => {
  it('loads with manifest declaring conversations:* hooks', async () => {
    const harness = createTestHarness({ services: { ...MockServices.basics() } });
    await harness.load(createConversationsPlugin({}));
    const manifest = harness.getManifest('@ax/conversations');
    expect(manifest.registers).toContain('conversations:create');
    expect(manifest.registers).toContain('conversations:append-turn');
    expect(manifest.registers).toContain('conversations:get');
    expect(manifest.registers).toContain('conversations:list');
    expect(manifest.registers).toContain('conversations:delete');
    expect(manifest.subscribes).toContain('chat:turn-end');
    expect(manifest.calls).toContain('agents:resolve');
  });
});
```

**Step 2: Run test → fail.**

```bash
pnpm test --filter @ax/conversations
# Expected: cannot resolve module '../plugin.js'
```

**Step 3: Implement minimal plugin.**

```ts
// packages/conversations/src/plugin.ts
import type { Plugin } from '@ax/core';

export interface ConversationsConfig {
  // no config knobs in MVP — postgres + kysely come from @ax/database-postgres service
}

export function createConversationsPlugin(_config: ConversationsConfig): Plugin {
  return {
    name: '@ax/conversations',
    manifest: {
      registers: [
        'conversations:create',
        'conversations:append-turn',
        'conversations:get',
        'conversations:list',
        'conversations:delete',
      ],
      calls: ['agents:resolve'],
      subscribes: ['chat:turn-end'],
    },
    async init({ bus: _bus }) {
      // Hooks wired in Task 2 / 3.
    },
  };
}
```

**Step 4: Run test → pass.**

**Step 5: Commit.**

```bash
git add packages/conversations tsconfig.json
git commit -m "scaffold(conversations): @ax/conversations plugin shell

Empty manifest declaring the five conversations:* service hooks plus
chat:turn-end subscription and agents:resolve calls (J1). Hook impls
wired in Task 2-3.

Boundary review:
- Alternate impl: future @ax/conversations-sqlite (single-replica dev)
  registers same hooks.
- Field names: conversations:* names — generic store vocabulary, no pg/kysely leakage.
- Subscriber risk: none yet; payloads land in Task 2.
- Wire surface: not an IPC action."
```

---

## Task 2: `conversations:*` service hooks + schema [boundary] [security]

**Goal:** Implement the five service hooks against a postgres-backed store, with ACL gating via `agents:resolve` (J1).

**Files:**
- Create: `packages/conversations/src/migrations.ts`
- Create: `packages/conversations/src/store.ts`
- Create: `packages/conversations/src/scope.ts`
- Modify: `packages/conversations/src/plugin.ts`
- Modify: `packages/conversations/src/types.ts`
- Create: `packages/conversations/src/__tests__/store.test.ts`
- Create: `packages/conversations/src/__tests__/acl.test.ts`

**Tables:**

```sql
CREATE TABLE conversations_v1_conversations (
  conversation_id TEXT PRIMARY KEY,        -- ULID
  user_id TEXT NOT NULL,                   -- creator (no FK across plugins)
  agent_id TEXT NOT NULL,                  -- frozen at create (I10)
  title TEXT,                              -- nullable; MVP doesn't auto-generate
  active_session_id TEXT,                  -- nullable; cleared when sandbox dies (Task 14)
  active_req_id TEXT,                      -- nullable; the in-flight reqId, if any (J7)
  deleted_at TIMESTAMPTZ,                  -- soft delete (J5)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX conversations_v1_conversations_owner ON
  conversations_v1_conversations (user_id, agent_id) WHERE deleted_at IS NULL;

CREATE TABLE conversations_v1_turns (
  turn_id TEXT PRIMARY KEY,                -- ULID
  conversation_id TEXT NOT NULL,           -- no FK across rows; we manage cascade in code
  turn_index INTEGER NOT NULL,             -- 0-based ordering within conversation
  role TEXT NOT NULL,                      -- 'user' | 'assistant' | 'tool'
  content_blocks JSONB NOT NULL,           -- ContentBlock[] — shape locked in Task 4
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, turn_index)
);

CREATE INDEX conversations_v1_turns_lookup ON
  conversations_v1_turns (conversation_id, turn_index);
```

**Why a side-table for turns vs JSONB-on-conversations:** size cap on JSONB (1 GiB postgres limit, but practical cap is ~1 MiB before performance bites); per-turn rows let us paginate `conversations:get` without rehydrating an entire 200-turn JSON blob.

**Hook signatures:**

```ts
// types.ts
export interface ContentBlock {  // shape locked in Task 4
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image';
  // discriminated union — full shape in Task 4
}

export interface Turn {
  turnId: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'tool';
  contentBlocks: ContentBlock[];
  createdAt: string;  // ISO-8601
}

export interface Conversation {
  conversationId: string;
  userId: string;
  agentId: string;
  title: string | null;
  activeSessionId: string | null;
  activeReqId: string | null;
  createdAt: string;
  updatedAt: string;
}

// Service hooks
'conversations:create' (ctx, { userId, agentId, title? }) → Conversation
'conversations:append-turn' (ctx, { conversationId, role, contentBlocks }) → Turn
'conversations:get' (ctx, { conversationId, userId, includeThinking? }) → { conversation, turns }
'conversations:list' (ctx, { userId, agentId? }) → Conversation[]
'conversations:delete' (ctx, { conversationId, userId }) → void  // soft (J5)
```

**ACL pattern (J1):**

Every hook that takes `userId` calls `agents:resolve(agentId, userId)` BEFORE touching the store. `:create` and `:list` resolve to ensure the agent is reachable; `:get`, `:append-turn`, `:delete` look up the conversation's `agent_id` first (filtered by `user_id` in the bare-rows-allowed `store.ts`), then resolve. On `forbidden`/`not-found` from `agents:resolve`, the hook rejects with `PluginError('forbidden')` or `PluginError('not-found')` — same code semantics as `agents:resolve`. NO conversation-side ACL logic; the only thing the conversations plugin enforces is "you can read conversations whose conversation row matches your userId". The agent ACL is the gate.

**Tenant query helper (I7):**

`scopedConversations(db, scope: { userId })` returns a Kysely query builder pre-filtered to `where('user_id', '=', scope.userId).where('deleted_at', 'is', null)`. All store reads go through this. The ESLint `no-bare-tenant-tables` rule from Week 9.5 must be extended to cover `conversations_v1_conversations` and `conversations_v1_turns` (Task 8 in 9.5's plan; we extend it inline here).

**Boundary-review answers (paste into commit):**
- **Alternate impl:** `@ax/conversations-sqlite` for single-process dev — same hook signatures, same content-block shape.
- **Field names:** `conversation_id`, `agent_id`, `user_id`, `turn_index`, `content_blocks` — generic. No `pg_*` / `jsonb_*` / `kysely_*` leakage.
- **Subscriber risk:** there are no `conversations:*` subscriber hooks in this slice (audit + canary will subscribe in Week 13+). The shape is forward-compatible.
- **Wire surface:** indirect — the chat-flow HTTP routes (Task 9–13) consume the hooks and serialize subsets to the client. JSON shape lives in `packages/channel-web/src/wire/chat.ts` (Task 9), NOT here.

**Step 1: Write failing tests** (in order — TDD layer by layer):
- `store.test.ts`: insert + read round-trip; soft-delete filters out; turn ordering preserved.
- `acl.test.ts`: User A creates conversation under their agent; User B with no agent access calling `conversations:get(conversationId, userId=B)` → rejects `forbidden`. User C calling `conversations:list({userId: C})` does NOT see User A's rows.

**Step 2: Implement migrations + store + scope helper.**

**Step 3: Implement plugin hooks** — register all five against the bus, using `agents:resolve` as the gate.

**Step 4: Run all tests → pass.**

```bash
pnpm test --filter @ax/conversations
```

**Step 5: Commit.**

```
feat(conversations): postgres-backed store + ACL-gated service hooks

Five hooks: create / append-turn / get / list / delete (soft).
Every hook calls agents:resolve first (J1); soft-delete via deleted_at
column with index excluding tombstones (J5). Tenant queries scoped
through scopedConversations() helper (I7).

Boundary review:
- Alternate impl: @ax/conversations-sqlite for dev shells
- Field names: conversation_id / user_id / agent_id / turn_index / content_blocks — generic
- Subscriber risk: no conversations:* subscriber hooks yet; turn-end auto-append lands in Task 3
- Wire surface: chat-flow routes serialize a subset (Task 9-13)

Security review:
- Sandbox: N/A — adds postgres tables only; no FS / process / network capability widened.
- Injection: contentBlocks is JSONB validated by zod schema (Task 4 lock); roles are an enum.
  conversation_id / user_id / agent_id are passed through Kysely with parameter binding —
  no string interpolation.
- Supply chain: N/A — uses kysely + zod + @ax/database-postgres already in workspace.
```

---

## Task 3: Subscribe to `chat:turn-end` to auto-append turns [boundary]

**Goal:** When the runner emits `chat:turn-end`, `@ax/conversations` automatically appends the completed turn(s) to the conversation. The channel plugin never has to call `conversations:append-turn` manually.

**The catch:** `chat:turn-end` (current shape, see `packages/ipc-protocol/src/events.ts:43`) carries `{ reqId?, reason, usage? }` — NOT the content blocks. The runner's transcript lives in its own in-process `history` array (Section I4). We need to either:
- (a) Extend `chat:turn-end` to carry the per-turn content blocks (best — single source of truth at turn boundary), OR
- (b) Have the runner POST the turn to a new IPC action `conversations.append-turn` (worse — duplicates the bus surface).

**Decision (lock):** Option (a). Extend `EventTurnEndSchema` in `@ax/ipc-protocol` to optionally include `contentBlocks: ContentBlock[]`. The runner populates it at the turn-end SDK message; `@ax/ipc-server` forwards verbatim into the bus payload of `chat:turn-end`. The conversations plugin subscribes and appends.

**Files:**
- Modify: `packages/ipc-protocol/src/events.ts` (extend `EventTurnEndSchema`)
- Modify: `packages/agent-claude-sdk-runner/src/main.ts` (build `contentBlocks` at the SDK `result` message)
- Modify: `packages/ipc-server/src/listener.ts` (forward `contentBlocks` into bus fire payload — verify it's already pass-through)
- Modify: `packages/conversations/src/plugin.ts` (subscriber wiring)
- Modify: `packages/conversations/src/__tests__/plugin.test.ts` (add subscriber test)

**Boundary risk:** `contentBlocks` is now in `chat:turn-end`. Two subscribers (`@ax/conversations`, future `@ax/audit`) will key off it. The shape MUST be exactly the locked `ContentBlock` discriminated union from Task 4 — bake that into the zod schema in `events.ts`. Subscribers that ignore the field continue to work (additive).

**Step 1: Lock the content-block shape (move forward from Task 4).** This task and Task 4 must agree on the shape; recommend doing Task 4 first if you're sequencing strictly. The plan as written assumes the shape is defined in Task 4 and imported here.

**Step 2: Write failing test.**

```ts
// packages/conversations/src/__tests__/plugin.test.ts (add)
it('appends a turn to the matching conversation when chat:turn-end fires', async () => {
  const harness = createTestHarness({ services: { ...MockServices.basics(), agents: MockAgents.allowAll() } });
  await harness.load(createConversationsPlugin({}));
  const ctx = harness.makeCtx({ userId: 'u1', agentId: 'a1', conversationId: 'c1' });
  await harness.bus.call('conversations:create', ctx, { userId: 'u1', agentId: 'a1' });
  await harness.bus.fire('chat:turn-end', ctx, {
    reason: 'complete',
    contentBlocks: [{ type: 'text', text: 'hello' }],
    role: 'assistant',
  });
  const { turns } = await harness.bus.call('conversations:get', ctx, { conversationId: 'c1', userId: 'u1' });
  expect(turns).toHaveLength(1);
  expect(turns[0].contentBlocks).toEqual([{ type: 'text', text: 'hello' }]);
});
```

**Step 3: Implement the subscriber inside `init({ bus })`.**

The subscriber needs the conversation id. It comes from `ctx.conversationId` — the orchestrator (Task 16) stamps `conversationId` onto the `ChatContext` when `chat:run` resolves the conversation. If absent (system-driven chat outside a conversation), the subscriber no-ops (e.g. canary work in Week 13+ that drives chats without persisting them).

**Step 4: Run tests → pass.**

**Step 5: Commit.**

```
feat(conversations): auto-append turns on chat:turn-end

Adds contentBlocks + role to EventTurnEndSchema; runner populates
at SDK result message; conversations subscriber appends to the
conversation matching ctx.conversationId. No-ops if conversationId
unset.

Boundary review:
- Alternate impl: extending chat:turn-end keeps the additive shape across runners.
- Field names: contentBlocks / role — generic LLM transcript vocab.
- Subscriber risk: future @ax/audit will subscribe; both must agree on the ContentBlock shape (locked in Task 4).
- Wire surface: event.turn-end IPC schema gains optional fields; verified backward-compat (existing senders continue to validate).
```

---

## Task 4: Lock the `ContentBlock` shape (Anthropic-compatible) [boundary]

**Goal:** Define the discriminated union one place; reuse in `@ax/conversations`, `@ax/ipc-protocol`, and the runner. (J3.)

**Files:**
- Create: `packages/ipc-protocol/src/content-blocks.ts`
- Modify: `packages/ipc-protocol/src/index.ts` (re-export)
- Modify: `packages/ipc-protocol/src/events.ts` (use the new schema in `EventTurnEndSchema`)
- Modify: `packages/conversations/src/types.ts` (re-export, do NOT duplicate)
- Create: `packages/ipc-protocol/src/__tests__/content-blocks.test.ts`

**Why `@ax/ipc-protocol` and not `@ax/core`:** content-blocks travel over the IPC wire (runner → host → bus) AND across plugin boundaries. `@ax/ipc-protocol` is the package both the runner and host depend on. `@ax/core` would be wrong because the runner's IPC client must not depend on kernel internals.

**The shape (Anthropic-compatible):**

```ts
// packages/ipc-protocol/src/content-blocks.ts
import { z } from 'zod';

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),  // Anthropic's signed thinking-block tag, when present
});

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),                    // tool_use_id — round-trips with tool_result
  name: z.string(),                  // tool name as the model emitted it
  input: z.record(z.unknown()),      // arbitrary JSON; structure depends on the tool
});

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),           // matches ToolUseBlock.id
  content: z.union([
    z.string(),                      // most tools return a string
    z.array(z.discriminatedUnion('type', [TextBlockSchema, /* ImageBlockSchema */])),
  ]),
  is_error: z.boolean().optional(),
});

export const ImageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }),
    z.object({ type: z.literal('url'), url: z.string() }),
  ]),
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ImageBlockSchema,
]);

export type ContentBlock = z.infer<typeof ContentBlockSchema>;
```

**Step 1: Write failing schema tests.**

```ts
// packages/ipc-protocol/src/__tests__/content-blocks.test.ts
import { describe, expect, it } from 'vitest';
import { ContentBlockSchema } from '../content-blocks.js';

describe('ContentBlock schema', () => {
  it('parses a text block', () => {
    expect(ContentBlockSchema.parse({ type: 'text', text: 'hi' })).toEqual({ type: 'text', text: 'hi' });
  });
  it('parses a tool_use → tool_result roundtrip', () => {
    const use = ContentBlockSchema.parse({ type: 'tool_use', id: 'abc', name: 'Bash', input: { command: 'ls' } });
    const result = ContentBlockSchema.parse({ type: 'tool_result', tool_use_id: 'abc', content: 'file1\nfile2' });
    expect(use.type).toBe('tool_use');
    expect((result as any).tool_use_id).toBe(use.id);
  });
  it('rejects an unknown discriminant', () => {
    expect(() => ContentBlockSchema.parse({ type: 'banana' })).toThrow();
  });
  it('parses thinking blocks (J4 — stored)', () => {
    expect(ContentBlockSchema.parse({ type: 'thinking', thinking: 'reasoning...' })).toMatchObject({ type: 'thinking' });
  });
});
```

**Step 2: Implement the schema, re-export from `index.ts` and `events.ts`.**

**Step 3: Run tests → pass.**

**Step 4: Update `@ax/conversations/types.ts` to re-export `ContentBlock` from `@ax/ipc-protocol`.** Do NOT redefine it locally (J4 — single source of truth).

**Step 5: Commit.**

```
feat(ipc-protocol): lock ContentBlock shape (Anthropic-compatible)

text / thinking / tool_use / tool_result / image discriminated union.
Used by EventTurnEndSchema, @ax/conversations storage, and
@ax/agent-claude-sdk-runner replay (Task 15). Single source of truth (I4).

Boundary review:
- Alternate impl: any future runner (pi-session, openrouter) emits the same shape.
- Field names: type / text / tool_use_id / content — Anthropic's vocab, but
  Anthropic's content-block tuple IS the alternate-impl set across LLM
  providers; OpenAI / Gemini wrappers translate on their side.
- Subscriber risk: any subscriber to chat:turn-end MUST validate via the
  schema, not by ad-hoc shape probing.
- Wire surface: this IS the IPC wire schema for event.turn-end — schema
  lives in @ax/ipc-protocol (correct location).
```

---

## Task 5: Wire `event.stream-chunk` IPC handler → `chat:stream-chunk` subscriber [boundary]

**Goal:** Replace the 501 stub in `@ax/ipc-core/src/handlers/event-stream-chunk.ts` with a real handler that fires the bus subscriber `chat:stream-chunk`.

**Files:**
- Modify: `packages/ipc-core/src/handlers/event-stream-chunk.ts`
- Modify: `packages/ipc-core/src/dispatcher.ts`
- Modify: `packages/ipc-core/src/__tests__/dispatcher.test.ts` (replace 501 test with happy-path)
- Modify: `packages/ipc-server/src/listener.ts` (verify the new handler reaches the bus)
- Modify: `packages/ipc-server/src/__tests__/` (integration test)
- Modify: `packages/core/src/hooks.ts` or wherever the global hook registry is declared (add `chat:stream-chunk` to the type union, no need for a runtime change)

**`chat:stream-chunk` payload (J2):**

```ts
{
  reqId: string;
  text: string;
  kind: 'text' | 'thinking';
}
```

This matches `EventStreamChunkSchema` exactly — the IPC handler doesn't reshape, it forwards. Subscribers filter by `reqId` themselves.

**Boundary review:**
- **Alternate impl:** any future runner that emits incremental output (pi-session, gemini-cli) fires the same event. Schema unchanged.
- **Field names:** `reqId` / `text` / `kind` — generic. `kind: 'thinking'` is borrowed from Anthropic vocab but matches the content-block shape (J3) — same word for the same concept.
- **Subscriber risk:** subscribers MUST treat `text` as untrusted model output (J2) — never interpolate into shell, file paths, HTML. The SSE consumer in Task 7 sends it through React markdown sanitization.
- **Wire surface:** schema is `EventStreamChunkSchema` in `@ax/ipc-protocol` (already exists from 6.5a).

**Step 1: Write failing test.**

```ts
// packages/ipc-server/src/__tests__/stream-chunk.test.ts
it('event.stream-chunk → fires chat:stream-chunk on bus with same reqId/text/kind', async () => {
  const harness = createTestHarness({ services: { ...MockServices.basics() } });
  await harness.load(createIpcServerPlugin({ /* ... */ }));
  const seen: Array<{ reqId: string; text: string; kind: string }> = [];
  harness.bus.subscribe('chat:stream-chunk', async (_ctx, payload) => {
    seen.push(payload);
  });
  // Simulate runner POST.
  const port = harness.getPlugin(createIpcServerPlugin).boundPort();
  await fetch(`http://127.0.0.1:${port}/event.stream-chunk`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${harness.testToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reqId: 'r1', text: 'hello', kind: 'text' }),
  });
  expect(seen).toEqual([{ reqId: 'r1', text: 'hello', kind: 'text' }]);
});
```

**Step 2: Replace 501 in `event-stream-chunk.ts`** with a handler that takes `{ bus, ctx, payload }` and `await bus.fire('chat:stream-chunk', ctx, payload)`. No transformation.

**Step 3: Update dispatcher.ts to route through the new handler.**

**Step 4: Replace the old 501 test** in `dispatcher.test.ts` with a happy-path test confirming the bus-fire happens.

**Step 5: Run all `@ax/ipc-*` tests → pass.**

**Step 6: Commit.**

```
feat(ipc): wire event.stream-chunk → chat:stream-chunk bus subscriber

Replaces the 6.5a 501 stub with a real handler that fires the bus
subscriber. Payload pass-through (no reshape). Subscribers filter
by reqId.

Boundary review:
- Alternate impl: pi-session-runner / openrouter-runner fire the same event.
- Field names: reqId / text / kind — generic; kind matches J3 content-block vocab.
- Subscriber risk: text is UNTRUSTED model output (J2) — never interpolate.
- Wire surface: EventStreamChunkSchema unchanged from @ax/ipc-protocol 6.5a.
```

---

## Task 6: Emit stream chunks from `@ax/agent-claude-sdk-runner` [security]

**Goal:** During `for await (const msg of queryIter)` in `main.ts`, emit `event.stream-chunk` for each text/thinking block as the SDK delivers them. (Currently the runner only updates its in-process `history` array on `assistant` messages.)

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts` (at the SDKAssistantMessage branch)
- Modify: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`

**The reqId problem:** The runner doesn't currently know the `reqId`. We need to thread it from the host. Options:
- (a) Extend `session.get-config` to include `currentReqId` (bad — reqId is per-message, not per-session).
- (b) Add a new IPC inbox-pull return field carrying the `reqId` of the user message being delivered. The runner echoes it on stream-chunk emissions until the next inbox pull.
- **(c) Pass reqId via the user message envelope.** The host already wraps user messages in `{ payload: { content, ... } }`; add `reqId` to that envelope. The runner caches the most-recent reqId in a local variable.

**Decision:** (c). Cleanest — reqId is correlated to a specific user message, so it belongs in the inbox payload.

This requires:
- Extending the inbox payload schema in `@ax/ipc-protocol` (likely `tool.inbox-pull` response).
- The host-side inbox writer (`@ax/sandbox-subprocess`?) populating reqId when the channel-web POST handler enqueues the message.
- The runner echoing it on each `event.stream-chunk` until the next pull.

**Where the host enqueues messages with reqId:** `POST /api/chat/messages` (Task 9) mints the reqId and calls a new service hook `chat:enqueue-user-message` (or extends an existing one). For MVP keep it simple: extend `chat:run` (the orchestrator's existing service hook) to accept `reqId` as a field.

**Step 1: Trace the inbox path.** `@ax/agent-claude-sdk-runner/src/main.ts` calls `inbox.next()` which calls `client.call('tool.inbox-pull', {...})`. Find where `tool.inbox-pull` returns and confirm we control the response shape. (Likely `packages/sandbox-subprocess/src/inbox.ts` or similar.) Update the response schema to include `reqId`.

**Step 2: Write failing runner test.** A user message is enqueued with `reqId: 'r42'`; the runner emits the SDK's text deltas; assert the runner makes IPC calls to `event.stream-chunk` with `reqId: 'r42'` for each text delta.

**Step 3: Implement.** In `main.ts`, on `SDKAssistantMessage` branch:

```ts
if (msg.type === 'assistant') {
  for (const block of assistant.message.content) {
    if (block.type === 'text' && block.text.length > 0) {
      await client.event('event.stream-chunk', {
        reqId: currentReqId,  // captured from the most recent inbox pull
        text: block.text,
        kind: 'text',
      }).catch(() => { /* host tearing down, non-fatal */ });
    } else if (block.type === 'thinking' && block.thinking.length > 0) {
      await client.event('event.stream-chunk', {
        reqId: currentReqId,
        text: block.thinking,
        kind: 'thinking',
      }).catch(() => {});
    }
  }
  // existing history-push logic stays put
}
```

**Step 4: Update the inbox response schema in `@ax/ipc-protocol`** to include `reqId: string` (required). If absent, the host generates one — but the host SHOULD always generate it at message-accept time (J9). Tests should fail loudly if a message reaches the runner without a reqId.

**Step 5: Run tests → pass.**

**Step 6: Commit.**

```
feat(claude-sdk-runner): emit event.stream-chunk for text + thinking blocks

Per-block emission during SDK iteration. reqId is server-minted (J9)
and threaded through the inbox response envelope. Failure to send a
chunk is non-fatal — host may be tearing down.

Security review:
- Sandbox: N/A — runner already has IPC client; new event uses existing transport.
- Injection: text comes from the LLM (UNTRUSTED — J2). Runner forwards verbatim;
  host-side subscribers (Task 7) sanitize at render time. Runner does NOT
  interpolate into shell, file paths, or any other interpreter.
- Supply chain: N/A — no new deps.
```

---

## Task 7: SSE endpoint `/api/chat/stream/:reqId` with chunk ring buffer (J7) [security]

**Goal:** Browser-facing SSE endpoint that subscribes to `chat:stream-chunk` filtered by `reqId`, emits chunks as `data: {...}` SSE frames. A small in-memory ring buffer per reqId lets a reconnecting client tail recent chunks (J7).

**Files:**
- Create: `packages/channel-web/src/server/sse.ts`
- Create: `packages/channel-web/src/server/chunk-buffer.ts`
- Create: `packages/channel-web/src/__tests__/sse.test.ts`
- Modify: `packages/channel-web/src/server/plugin.ts` (or wherever the channel plugin's `init` lives — channel-web likely has a host-side surface; if not, create one)
- Modify: `packages/channel-web/package.json` (add `@ax/http-server`, `@ax/auth-oidc` workspace deps if not yet there)

**Note on channel-web's host-side surface:** As shipped in 9.5, `@ax/channel-web` is primarily a static-bundle package mounted via `@ax/static-files`. For Week 10–12 it grows a host-side plugin shell that registers HTTP routes against `@ax/http-server`. If `packages/channel-web/src/server/` doesn't exist yet, create it; the channel plugin manifest now includes `calls: ['http:register-route', 'auth:require-user', 'agents:resolve', 'agents:list-for-user', 'conversations:create', 'conversations:append-turn', 'conversations:get', 'conversations:list', 'conversations:delete', 'chat:run']` and `subscribes: ['chat:stream-chunk']`.

**Ring buffer:** keyed by `reqId`, holds last N chunks (`N = 256`, ~256 KiB worst case at 1 KiB/chunk). Evicted on `chat:turn-end` matching the reqId, OR after 60s idle. Simple Map with periodic sweep. Single-replica only (J8 / Scope decision 8).

**SSE protocol:** `text/event-stream`, one frame per chunk:

```
data: {"reqId":"r42","text":"hello","kind":"text"}

data: {"reqId":"r42","done":true}
```

Connection closes on `done: true` OR client disconnect OR turn-end-with-error. Server-side keepalive comment `:\n\n` every 25s to prevent intermediary timeouts.

**Auth:** the SSE endpoint requires `auth:require-user`. Then ACL: load the conversation by `reqId` (look up `active_req_id` in `conversations_v1_conversations`), call `agents:resolve` for the conversation's agentId — if forbidden, return 403 BEFORE opening the stream. (J1.)

**`reqId` injection-resistance (J9):** `reqId` is a route param. We accept it only if the matching conversation's `active_req_id` equals it. Random-guessing a foreign reqId fails because no conversation owns it.

**Step 1: Write failing tests.**
- Happy path: SSE connects, a chunk fires on the bus with matching reqId, the stream emits the JSON frame.
- Filter: chunk fires with non-matching reqId → not emitted on this connection.
- Buffer replay: client connects AFTER 3 chunks already fired → receives those 3 chunks then tails live.
- ACL: User B's auth cookie + User A's reqId → 403, no body leak.
- Unauthenticated → 401.

**Step 2: Implement chunk-buffer.ts** — ring buffer with TTL eviction.

**Step 3: Implement sse.ts** — handler that:
1. Validates auth.
2. Resolves the conversation by reqId, ACL-gates via agents:resolve.
3. Writes SSE headers + flushes initial buffered chunks for this reqId.
4. Subscribes to `chat:stream-chunk` filtered by reqId; writes each chunk as a frame.
5. Subscribes to `chat:turn-end` filtered by ctx.conversationId; writes `done: true` + closes.
6. On client disconnect (`req.on('close')`), unsubscribes both.

**Step 4: Register the route in `init({ bus })`** of the channel-web host plugin against `http:register-route`.

**Step 5: Run tests → pass.**

**Step 6: Commit.**

```
feat(channel-web): SSE /api/chat/stream/:reqId + chunk ring buffer (J7)

Per-reqId SSE feed; auth + agents:resolve gated; in-memory ring buffer
(256 chunks, 60s TTL) for reconnect tailing. Single-replica only;
multi-replica is Week 13+.

Security review:
- Sandbox: N/A — SSE handler reads from bus subscriber, no FS/process/network widening beyond
  what http-server already grants.
- Injection: chunk.text is UNTRUSTED model output (J2); JSON-encoded into SSE frames;
  client sanitizes at render. reqId from URL is matched against conversations.active_req_id —
  no cross-conversation poisoning (J9).
- Supply chain: N/A — uses node:http via @ax/http-server, no new deps.
```

---

## Task 8: End-to-end stream test (orchestrator → SSE)

**Goal:** A single integration test proves the chain: chat:run → runner emits stream-chunk → bus → SSE → consumer sees frames.

**Files:**
- Create: `packages/channel-web/src/__tests__/stream-e2e.test.ts`

**Test flow:**
1. Spin up an in-process kernel with `@ax/conversations`, `@ax/channel-web` server, `@ax/auth-oidc` (dev-bootstrap), `@ax/agents`, a mock runner that emits two stream-chunks then turn-end.
2. Sign in via dev-bootstrap.
3. Create an agent + conversation.
4. POST `/api/chat/messages` → returns `reqId`.
5. GET `/api/chat/stream/:reqId` (SSE) → assert two text frames + a `done` frame.

(Task 9 is what makes step 4 work. If you sequence Task 8 before Task 9, stub the message-post step using `bus.call('chat:run', ...)` directly with a mock reqId — but real value comes from the full chain, so the recommended sequence is 5 → 6 → 7 → 9 → 8.)

**Step 1–5:** TDD pattern as above. Skip if tests above already cover.

**Step 6: Commit.**

```
test(channel-web): end-to-end chat:stream-chunk → SSE
```

---

## Task 9: `POST /api/chat/messages` — accept user message [security]

**Goal:** The chat-flow message endpoint. Auth + ACL + conversation upsert + `chat:run` dispatch + return `{ conversationId, reqId }` to the client.

**Files:**
- Create: `packages/channel-web/src/server/routes-chat.ts`
- Create: `packages/channel-web/src/wire/chat.ts` (wire schema, zod)
- Create: `packages/channel-web/src/__tests__/routes-chat.test.ts`
- Modify: `packages/channel-web/src/server/plugin.ts` (register the route)

**Wire schema (zod, lives in `wire/chat.ts`):**

```ts
export const PostMessageRequest = z.object({
  conversationId: z.string().nullable(),    // null = create new
  agentId: z.string(),                      // required for new conversations; verified-equal for existing
  contentBlocks: z.array(ContentBlockSchema).max(20),  // user message, usually 1 text block
});
export const PostMessageResponse = z.object({
  conversationId: z.string(),
  reqId: z.string(),                        // server-minted (J9)
});
```

**Handler logic:**

```ts
async (req, res) => {
  const auth = await bus.call('auth:require-user', ctx, { req });
  if (auth.rejected) return res.status(401).json({ error: 'unauthenticated' });

  const body = PostMessageRequest.parse(await req.json());
  const userId = auth.user.id;

  // Resolve agent (gate)
  let agent;
  try {
    agent = await bus.call('agents:resolve', ctx, { agentId: body.agentId, userId });
  } catch (err) {
    if (isPluginError(err, 'forbidden')) return res.status(403).json({ error: 'forbidden' });
    if (isPluginError(err, 'not-found')) return res.status(404).json({ error: 'agent-not-found' });
    throw err;
  }

  // Get or create conversation
  let conversation;
  if (body.conversationId === null) {
    conversation = await bus.call('conversations:create', ctx, { userId, agentId: body.agentId });
  } else {
    const got = await bus.call('conversations:get', ctx, {
      conversationId: body.conversationId, userId,
    }).catch((err) => null);
    if (!got) return res.status(404).json({ error: 'conversation-not-found' });
    if (got.conversation.agentId !== body.agentId) {
      return res.status(400).json({ error: 'agent-mismatch' });  // I10
    }
    conversation = got.conversation;
  }

  // Append the user turn FIRST (so SDK history replay picks it up if a fresh session opens)
  await bus.call('conversations:append-turn', ctx, {
    conversationId: conversation.conversationId,
    role: 'user',
    contentBlocks: body.contentBlocks,
  });

  // Mint reqId (J9), dispatch chat:run async
  const reqId = ulid();
  // Don't await chat:run — it returns when chat:end fires. The client streams via SSE.
  void bus.call('chat:run', { ...ctx, userId, agentId: body.agentId, conversationId: conversation.conversationId, reqId }, {
    message: extractText(body.contentBlocks),  // chat:run still takes a flat string today; keep it
  });

  res.status(202).json({ conversationId: conversation.conversationId, reqId });
}
```

**Note on `chat:run` signature drift:** `chat:run` currently takes `{ message: string }`. Keeping it that way avoids cascading refactors. The full content-block tuple is preserved in `conversations` (and replayed at session boot, Task 15); `chat:run`'s `message` becomes the convenience flat string for the orchestrator. If a user message has non-text blocks (image attachments), Task 9 stitches a flat description (e.g. "[image attached: agent.png]") into `message` for the SDK's first turn; the runner's history replay (Task 15) will get the full content blocks via `conversation.fetch-history` IPC and replace them.

**CSRF (J8):** state-changing route → CSRF middleware applies (allowed Origin OR `X-Requested-With`).

**Tests:**
- Anonymous → 401.
- Foreign agent → 403.
- Mismatched agentId on existing conversation → 400.
- Non-existent conversation → 404.
- Body too large (> 1 MiB) → 413 (http-server cap).
- Happy path: returns conversationId + reqId; conversation now contains the user turn.

**Step 1–5:** TDD per endpoint, commit.

```
feat(channel-web): POST /api/chat/messages

Auth + agents:resolve + conversations:create-or-get + chat:run dispatch.
Server-minted reqId (J9) returned to client for SSE subscription.
Single user turn appended before chat:run so a fresh-session replay sees it.

Security review:
- Sandbox: N/A — handler reads bounded JSON body, dispatches to existing hooks.
- Injection: contentBlocks validated by zod schema (max 20 blocks); agentId / conversationId
  passed through hooks with parameter binding. message string fed to chat:run is the user's
  text (intended for the LLM); flow into the LLM is the whole point.
- Supply chain: N/A — uses ulid (already a workspace dep) + zod + @ax/http-server.
```

---

## Task 10: `GET /api/chat/conversations` — list user's conversations

**Goal:** List endpoint, optionally filtered by `agentId`. Powers the sidebar.

**Files:**
- Modify: `packages/channel-web/src/server/routes-chat.ts`
- Modify: `packages/channel-web/src/__tests__/routes-chat.test.ts`

**Behavior:** auth → `conversations:list({ userId, agentId? })` → JSON. Soft-deleted are filtered (J5).

**Tests:** anonymous → 401; cross-tenant → returns user's only; agentId filter narrows.

**Step 1–5:** TDD.

```
feat(channel-web): GET /api/chat/conversations
```

---

## Task 11: `GET /api/chat/conversations/:id` — load conversation [security]

**Goal:** Return `{ conversation, turns }` for a conversation the user has access to. Powers the Thread component on page-load.

**Files:**
- Modify: `packages/channel-web/src/server/routes-chat.ts`
- Modify: `packages/channel-web/src/__tests__/routes-chat.test.ts`

**Behavior:**

```ts
GET /api/chat/conversations/:id?includeThinking=false
→ auth + conversations:get(id, userId) → { conversation, turns }
```

`includeThinking` defaults to `false` (J4 — UI hides by default). When false, `turns[].contentBlocks` is filtered to remove `thinking` blocks. The runner's replay (Task 15) calls a different code path with the full set.

**Tests:**
- Anonymous → 401.
- User B accessing User A's conversation → 404 (NOT 403 — don't leak existence; agents:resolve already returned 'forbidden' meaning "I won't tell you why, just that it's not yours").

  **Decision:** return 404 for forbidden conversations. Information leakage minimized; identical to "doesn't exist". Document in the security note.

- Soft-deleted → 404.
- Happy path: returns turns in order, no thinking blocks by default.
- `?includeThinking=true` from authorized owner: returns thinking blocks.

**Step 1–5:** TDD.

```
feat(channel-web): GET /api/chat/conversations/:id

Returns conversation + turns; thinking blocks hidden by default (J4),
opt-in via ?includeThinking=true. Forbidden = 404 to minimize
existence-leak.

Security review:
- Sandbox: N/A — read-only GET against postgres.
- Injection: conversationId from URL passed to conversations:get with parameter binding.
  Response is JSON; turns.contentBlocks is opaque to the server (UI sanitizes at render).
- Supply chain: N/A.
```

---

## Task 12: `DELETE /api/chat/conversations/:id` — soft delete [security]

**Goal:** Soft-delete (J5).

**Files:** routes-chat.ts + tests.

**Behavior:** auth + `conversations:delete(id, userId)` → 204. CSRF guarded (J8).

**Tests:**
- Anonymous → 401, foreign-user → 404, happy path → 204 then GET → 404.
- Already-deleted → 204 (idempotent).

**Step 1–5: TDD, commit.**

```
feat(channel-web): DELETE /api/chat/conversations/:id (soft delete)
```

---

## Task 13: `GET /api/chat/agents` — list user's agents

**Goal:** Powers the AgentMenu. Wraps `agents:list-for-user`.

**Files:** routes-chat.ts + tests.

**Behavior:** auth → `agents:list-for-user({ userId })` → JSON. Filter to display-relevant fields (`id`, `displayName`, `visibility`, optionally a slug).

**Slug derivation (for J3 / agent-per-URL):** for MVP use the first 8 chars of the agentId; URL is `/chat/<slug>` → server resolves the slug to the full agentId on the channel-web router. Cleaner approaches (a `slug` column on agents) defer to Week 13+.

**Tests:** anonymous → 401; lists user's only.

**Step 1–5: TDD, commit.**

```
feat(channel-web): GET /api/chat/agents
```

---

## Task 14: Add `active_session_id` lifecycle to conversations [boundary]

**Goal:** Implement J6's "one sandbox session per conversation at a time" model.

**Files:**
- Modify: `packages/conversations/src/store.ts` (add `setActiveSession`, `clearActiveSession`)
- Modify: `packages/conversations/src/plugin.ts` (subscriber to `session:terminate` to clear)
- Modify: `packages/conversations/src/migrations.ts` (no schema change — column already in Task 2)
- Modify: `packages/conversations/src/__tests__/plugin.test.ts`

**Hook surface delta:**

```ts
// New service hooks (small, internal to conversation lifecycle)
'conversations:bind-session' (ctx, { conversationId, sessionId, reqId })
  → void  // sets active_session_id + active_req_id
'conversations:unbind-session' (ctx, { conversationId })
  → void  // clears both
```

**Subscriber wiring:**

```ts
// in init({ bus })
bus.subscribe('session:terminate', async (ctx, { sessionId }) => {
  // Find any conversation with this session bound; clear it.
  await store.clearBySessionId(sessionId);
});
bus.subscribe('chat:turn-end', async (ctx, _payload) => {
  if (ctx.conversationId && ctx.reqId) {
    await store.clearActiveReqId(ctx.conversationId, ctx.reqId);  // keeps active_session_id; clears active_req_id only
  }
});
```

`session:terminate` is fired by `@ax/sandbox-subprocess` / `@ax/sandbox-k8s` already (verify). If not, this slice adds the fire there — flag in the commit and add a `subscribes` declaration on the conversations manifest.

**Boundary review:**
- **Alternate impl:** future @ax/conversations-sqlite registers same hooks.
- **Field names:** sessionId / reqId — wire-vocab, but already used in IPC protocol (not new).
- **Subscriber risk:** session:terminate carries sessionId only — no leak.
- **Wire surface:** none — host-internal.

**Step 1: Write failing test.** A conversation, bind session s1+r1, fire `session:terminate(s1)` → assert active_session_id is null.

**Step 2: Implement.** Update store, register subscribers in init.

**Step 3: Run tests → pass.**

**Step 4: Manifest update.**

```ts
manifest: {
  registers: [..., 'conversations:bind-session', 'conversations:unbind-session'],
  subscribes: ['chat:turn-end', 'session:terminate'],
  calls: ['agents:resolve'],
}
```

**Step 5: Commit.**

```
feat(conversations): active_session_id lifecycle (J6)

bind-session / unbind-session service hooks; subscribers to
session:terminate (auto-clear) and chat:turn-end (clear req).

Boundary review:
- Alternate impl: same hook shape across postgres / sqlite stores.
- Field names: sessionId / reqId — wire-vocab matching IPC protocol.
- Subscriber risk: session:terminate is host-fired with no payload leak.
- Wire surface: none — host-internal.
```

---

## Task 15: Runner replays conversation history at session boot [security]

**Goal:** When a fresh sandbox opens for an existing conversation, the runner pulls the full content-block history and seeds it into claude-sdk before the user's new message. (Implements J3 + J6 resume.)

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts`
- Modify: `packages/ipc-protocol/src/actions.ts` (add `conversation.fetch-history` action)
- Create: a host-side handler — likely `packages/channel-web/src/server/ipc-handlers.ts` OR `packages/conversations/src/wire/fetch-history.ts` (the latter keeps schema co-located with the data — preferred)
- Modify: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`

**Where the host-side handler lives:** This is an IPC action the runner calls into the host. The host wires it through `@ax/ipc-server`. The handler implementation is small — it calls `conversations:get` on the bus and returns the turns. **Location decision:** put it in `@ax/conversations` (`src/wire/fetch-history.ts` — schema + handler factory) and have `@ax/ipc-server` register it via a service hook from the conversations plugin. Keeps the schema co-located with the storage. Alternative: put it in `@ax/channel-web/src/server/` since channel-web already owns the chat-flow surface — but then `@ax/conversations` would have to expose a tighter internal API. **Decision:** keep it in `@ax/conversations` to honor I4.

**IPC action schema:**

```ts
// packages/ipc-protocol/src/actions.ts (add)
export const ConversationFetchHistoryRequest = z.object({
  conversationId: z.string(),
});
export const ConversationFetchHistoryResponse = z.object({
  turns: z.array(z.object({
    role: z.enum(['user', 'assistant', 'tool']),
    contentBlocks: z.array(ContentBlockSchema),
  })),
});
```

**Authz on the IPC action:** the runner authenticates via its session bearer token (existing pattern). The host-side handler resolves the session → ctx.userId, ctx.agentId, ctx.conversationId, then calls `conversations:get(conversationId, userId)`. The runner cannot pass a different conversationId — it gets exactly the one associated with its session.

**Decision lock:** the IPC payload's `conversationId` is REQUIRED but VALIDATED against `ctx.conversationId` (derived from session lookup). Mismatch → 403. Eliminates "runner asks for User B's conversation history" attacks.

**Replay logic in main.ts:**

```ts
// After session.get-config, before query():
const history = await client.call('conversation.fetch-history', { conversationId: env.conversationId });

// Build prompt iterator that yields historical messages first, then live inbox.
async function* userMessagesWithReplay(): AsyncGenerator<SDKUserMessage> {
  for (const turn of history.turns) {
    if (turn.role === 'user') {
      yield {
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: turn.contentBlocks },  // full content blocks
      };
    } else if (turn.role === 'assistant') {
      // Inject as a synthetic assistant turn — claude-sdk supports this via the `prompt`
      // iterator returning previously-issued assistant messages, OR by using the SDK's
      // `resume`/`continue` option keyed on a session id.
      // VERIFY DURING IMPLEMENTATION which path the SDK supports cleanly. If neither,
      // fall back to flattening the assistant turn into a user-side preamble (lossy
      // but functional). Document the choice in the commit.
    }
  }
  // Live inbox after replay
  for (;;) {
    const entry = await inbox.next();
    if (entry.type === 'cancel') return;
    if (entry.payload === undefined) continue;
    history.push({ role: 'user', content: entry.payload.content });  // local bookkeeping
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: entry.payload.content },
    };
  }
}
```

**Open subtask during implementation:** use `mcp__plugin_context7_context7` to fetch current `@anthropic-ai/claude-agent-sdk` docs for the cleanest replay path. The SDK has evolved; the canonical "seed transcript into a fresh `query()`" pattern may be `resume(sessionId)` (preferred — server preserves SDK state) or feeding the prompt iterator with prior turns (works but recomputes). **The plan does not lock this** — it's an implementation detail. The contract that DOES lock: the runner replays the conversation's full content-block history before processing live inbox.

**Step 1: Write failing test** with mock IPC server returning a 3-turn history; assert the SDK sees those turns before the live message.

**Step 2: Implement** — the IPC action handler in `@ax/conversations/src/wire/fetch-history.ts`, the runner replay logic.

**Step 3: Run tests → pass.**

**Step 4: Commit.**

```
feat(claude-sdk-runner): replay conversation history on session boot (J6)

New IPC action conversation.fetch-history (host-side handler in
@ax/conversations); runner pulls turns and seeds claude-sdk's prompt
iterator before live inbox messages.

Security review:
- Sandbox: capability widened — runner gains a new IPC action. Argument is
  bounded by ctx.conversationId (server-derived from session token); runner
  cannot fetch foreign conversations.
- Injection: contentBlocks flow into the LLM (intended). Schema-validated via
  ContentBlockSchema; no shell / file path interpolation in the runner.
- Supply chain: N/A — no new deps.
```

---

## Task 16: Orchestrator routes by `conversationId` → active session [boundary]

**Goal:** When `chat:run` fires for an existing conversation with a live `active_session_id`, route the user message into THAT session's inbox instead of opening a new one.

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`
- Modify: `packages/chat-orchestrator/src/plugin.ts` (manifest: add `calls: ['conversations:bind-session', 'session:is-alive']`)
- Modify: `packages/session-postgres/src/plugin.ts` and `session-inmemory` (register `session:is-alive` if not already there)

**`session:is-alive` service hook:**

```ts
'session:is-alive' (ctx, { sessionId }) → boolean
```

If not already registered by `@ax/session-postgres`, add it (small change, additive).

**Orchestrator logic:**

```ts
// inside runChat, after agents:resolve, before sandbox.open-session:
let sessionId: string;
if (ctx.conversationId) {
  const conv = await bus.call('conversations:get', ctx, { conversationId: ctx.conversationId, userId: ctx.userId });
  if (conv.conversation.activeSessionId) {
    const alive = await bus.call('session:is-alive', ctx, { sessionId: conv.conversation.activeSessionId });
    if (alive) {
      // Route: enqueue user message into existing session's inbox + bind reqId
      sessionId = conv.conversation.activeSessionId;
      await bus.call('conversations:bind-session', ctx, {
        conversationId: ctx.conversationId,
        sessionId, reqId: ctx.reqId,
      });
      await bus.call('chat:enqueue-message', ctx, { sessionId, message: input.message, reqId: ctx.reqId });
      // No sandbox:open-session; await chat:turn-end as usual.
      return awaitTurnEnd(sessionId);
    }
  }
}
// Else: open a fresh sandbox (existing path), bind once it returns.
sessionId = await bus.call('sandbox:open-session', ctx, { /* ... */ });
await bus.call('conversations:bind-session', ctx, { conversationId: ctx.conversationId, sessionId, reqId: ctx.reqId });
// rest unchanged
```

**`chat:enqueue-message` service hook:** new, minimal — fires the IPC inbox-write into a live session. Implementation lives in `@ax/sandbox-subprocess` / `@ax/sandbox-k8s` (whichever holds the inbox handle). For MVP: register on `@ax/sandbox-subprocess` (k8s already has equivalent through the workspace-git-http channel; mirror).

**Boundary review:**
- **Alternate impl:** sandbox-k8s registers the same hook.
- **Field names:** sessionId, reqId — wire-vocab, used everywhere already.
- **Subscriber risk:** none (chat:enqueue-message is service-only).
- **Wire surface:** chat:enqueue-message goes over IPC — schema in `@ax/sandbox-protocol` (or co-located with the sandbox impl).

**Step 1: Write failing test.** A conversation has a live session; second user message routes into existing inbox; sandbox.open-session NOT called.

**Step 2: Implement.**

**Step 3: Run tests → pass.**

**Step 4: Commit.**

```
feat(orchestrator): route messages to active conversation session (J6)

When ctx.conversationId has a live active_session_id, enqueue into the
existing inbox instead of opening a new sandbox. New service hooks:
session:is-alive, chat:enqueue-message.

Boundary review:
- Alternate impl: sandbox-k8s registers chat:enqueue-message identically.
- Field names: sessionId / reqId — wire-vocab.
- Subscriber risk: none.
- Wire surface: chat:enqueue-message has IPC schema in @ax/sandbox-protocol.
```

---

## Task 17: Replace mock OpenAI transport with AX transport (channel-web frontend)

**Goal:** `packages/channel-web/src/lib/transport.ts` currently speaks OpenAI SSE format (`data: {"choices":[{"delta":{...}}]}`). Replace with the AX-native shape (`data: {"reqId":"...","text":"...","kind":"text"}` from Task 7).

**Files:**
- Modify: `packages/channel-web/src/lib/transport.ts`
- Create: `packages/channel-web/src/lib/chat-api.ts` (POST /api/chat/messages helper)
- Modify: `packages/channel-web/src/__tests__/transport.test.ts`

**New transport flow:**

```ts
// On user submit:
// 1. POST /api/chat/messages → { conversationId, reqId }
// 2. Open EventSource('/api/chat/stream/' + reqId)
// 3. For each frame, push UIMessageChunk into the AI SDK runtime.
// 4. On `done: true` or close, end the run.
```

**Step 1: Write failing tests.** Replace the OpenAI-shape parser tests with AX-shape parser tests.

**Step 2: Implement.** `processResponseStream` parses the AX SSE shape; emit `text-start` / `text-delta` / `text-end` UIMessageChunks. Tool-result rendering (J3) uses `tool-input-available` / `tool-output-available` UIMessageChunks; map from `chat:stream-chunk` of `kind: 'thinking'` to a hidden text part (CSS visibility off by default — toggle in Task 21).

**Note:** the existing transport.ts contains an OpenAI-SSE parser plus image / file inline rendering (lines 209–235). Keep the file/image rendering paths but feed them from the new AX shape — adapt the named-event handling (`event: content_block`) so the server emits the same named events for inline file embeddings if needed. For MVP, stream only `text` chunks; tool-result rendering uses the persisted turn-end content blocks fetched via `GET /api/chat/conversations/:id` after the stream closes (no need to invent a streaming tool-result frame).

**Step 3: Run tests → pass.**

**Step 4: Commit.**

```
refactor(channel-web): AX-native SSE transport (replace OpenAI-shape stub)

Transport now POSTs /api/chat/messages, opens SSE on /api/chat/stream/:reqId,
parses AX-shape frames into AI SDK UIMessageChunks. Streams text + thinking
(thinking hidden by default, J4). Tool-result rendering happens via the
post-stream conversation reload, NOT via streaming.
```

---

## Task 18: Wire `AgentMenu` to `/api/chat/agents`

**Goal:** Replace the mock data feeding `AgentMenu` with the real list. Selection updates the URL to `/chat/<slug>`.

**Files:**
- Modify: `packages/channel-web/src/lib/agent-store.ts`
- Modify: `packages/channel-web/src/components/AgentMenu.tsx` (only if it currently reads from the store; else no change)
- Modify: `packages/channel-web/src/__tests__/agent-store.test.ts`

**Step 1–5:** TDD. Mock `fetch` for the store test.

**Step 6: Commit.**

```
feat(channel-web): AgentMenu reads /api/chat/agents
```

---

## Task 19: Wire `Sidebar` + `SessionList` to `/api/chat/conversations`

**Goal:** Replace the mock sidebar entries with real conversations. Click → URL `/chat/<agentSlug>?c=<conversationId>` (or similar). Soft-delete UI calls `DELETE /api/chat/conversations/:id`.

**Files:**
- Modify: `packages/channel-web/src/lib/session-store.ts`
- Modify: `packages/channel-web/src/lib/thread-list-adapter.ts`
- Modify: relevant tests.

**Step 1–5:** TDD.

```
feat(channel-web): Sidebar lists real conversations
```

---

## Task 20: `Thread` loads conversation history on mount

**Goal:** When the URL specifies `c=<conversationId>`, `Thread` calls `GET /api/chat/conversations/:id` and seeds the AI SDK runtime's history. Toggling thinking-block visibility re-fetches with `?includeThinking=true`.

**Files:**
- Modify: `packages/channel-web/src/lib/history-adapter.ts`
- Modify: `packages/channel-web/src/components/Thread.tsx` (if needed — most logic is in the adapter)
- Modify: tests.

**Step 1–5:** TDD.

```
feat(channel-web): Thread hydrates from /api/chat/conversations/:id
```

---

## Task 21: Thinking-block UI toggle (J4)

**Goal:** A small per-message toggle that reveals stored thinking blocks. Default off.

**Files:**
- Modify: `packages/channel-web/src/components/Thread.tsx` or `MarkdownText.tsx`
- Modify: tests.

**Step 1–5: TDD. Commit.**

```
feat(channel-web): per-message thinking-block toggle (default off, J4)
```

---

## Task 22: Canary-deferred banner (Scope decision 7)

**Goal:** A persistent banner / admin-panel notice acknowledging that secret-leak veto + LLM redaction are not yet enabled. The handoff doc (§65) is explicit: do NOT open to wider access without canary.

**Files:**
- Modify: `packages/channel-web/src/components/admin/AdminPanel.tsx` (top-of-page warning)
- Modify: `packages/channel-web/README.md`
- Optionally modify: top-level `README.md` if user-visible

**Banner copy (voice — "self-deprecating but competent" per CLAUDE.md):**

> ⚠ Heads up: the canary scanner isn't wired in yet. Until it is, this deployment has no automated secret-leak veto and no LLM-output redaction. We trust ourselves with our internal data, but we wouldn't ship this to outside users yet — and neither should you. Tracked for Week 13+.

**Tests:** snapshot the banner; assert it renders on AdminPanel.

**Step 1–5: Commit.**

```
docs(channel-web): canary-not-enabled banner + README

Per Week 10-12 scope decision 7: MVP ships without @ax/scanner-canary.
Banner is the operator-visible reminder until Week 13+ wires it in.
```

---

## Task 23: Security checklist rollup [security]

**Goal:** One consolidated structured note for the PR description.

**Files:**
- Create: `docs/plans/2026-04-26-week-10-12-pr-notes.md`

Run the `security-checklist` skill again. The rollup MUST cover:

- **Sandbox:** new IPC action `conversation.fetch-history` (capability widening — runner can now fetch a bounded conversation transcript scoped to its own session; cross-conversation reach blocked at server).
- **Injection:** every untrusted-input flow:
  - User-typed message → `conversations:append-turn` (storage as-is) → runner replay → LLM (intended).
  - LLM response chunks → bus subscriber → SSE → React markdown sanitization (verify the markdown renderer used in `MarkdownText.tsx` does NOT execute scripts; if it's `react-markdown` with default config, it's safe; flag if not).
  - SSE `reqId` from URL → matched against `conversations.active_req_id` (J9).
  - `chat:run`'s `message` param remains the convenience flat string for the orchestrator; does not interpolate.
- **Supply chain:** any new deps? List them (likely none — uses existing `kysely`, `zod`, `ulid`, `@ax/http-server`, `@ax/database-postgres`).
- **Cross-tenant query audit:** every Kysely query against `conversations_v1_*`. Each MUST be `where('user_id', ...)` (or via `scopedConversations`) OR documented as system-only. Number them and link to file:line.
- **CSRF posture:** confirm `POST /api/chat/messages` and `DELETE /api/chat/conversations/:id` go through the 9.5 CSRF middleware.
- **Cookie posture:** unchanged from 9.5; chat-flow routes inherit.

This file is part of the PR description (paste contents into PR body).

---

## Task 24: Multi-tab + reload acceptance test [security]

**Goal:** End-to-end test covering acceptance scenarios 1–7.

**Files:**
- Create: `packages/channel-web/src/__tests__/acceptance-e2e.test.ts` (or use Playwright if Playwright is wired into the channel-web test command).

Each scenario from §"Acceptance test" gets a labeled test:

```ts
it('[1] User A signs in, picks agent, sends message, gets streamed response', ...);
it('[2] Reload mid-conversation: history reappears, continuation works', ...);
it('[3] Two tabs see same conversation; messages cross-stream', ...);
it('[4] Team-mate User B joins via shared URL, continues', ...);
it('[5] Non-member User C → 403 with no body leak', ...);
it('[6] Soft-delete: disappears from sidebar, URL load → 404', ...);
it('[7] Mid-tool-call reload: tool keeps running, reload reattaches', ...);
```

Plus 3 hardening checks (mirror Week 9.5):

- `[H1] Reqid spoofing: GET /api/chat/stream/<random> → 404 / 403, no chunk leak.`
- `[H2] Origin spoofing: POST /api/chat/messages from foreign Origin without X-Requested-With → 403.`
- `[H3] Cookie tamper on /api/chat/messages → 401.`

**Step 1–5:** Implement, run, commit.

```
test(channel-web): 7 acceptance + 3 hardening scenarios
```

---

## Task 25: Open the PR

**Files:**
- Confirm `docs/plans/2026-04-26-week-10-12-pr-notes.md` (Task 23) is complete.

**Command:**

```bash
gh pr create --title "feat(week-10-12): web chat + conversation persistence (MVP)" \
  --body "$(cat docs/plans/2026-04-26-week-10-12-pr-notes.md)"
```

**PR body MUST include:**
- Summary linking to this plan + the handoff doc.
- Checklist of invariants J1–J9, each with a short evidence link (test file + line, or commit hash).
- Boundary review (rollup of per-task notes).
- Security review (rollup from Task 23).
- Acceptance scenarios run (Task 24 file path).
- "What's deferred" — restate from handoff §"Deferred from this slice":
  - `@ax/channel-slack` → Week 13+
  - `@ax/audit` → Week 13+
  - `@ax/scanner-canary` → Week 13+ (banner is in Task 22)
  - Memory / Strata → Week 13+
  - Multi-replica streaming fan-out → Week 13+
  - Hard-delete admin path → Week 13+

---

## Execution checkpoints (review gates)

When run via `superpowers:subagent-driven-development`, hold review at the end of each block:

| Block | Tasks | Review focus |
|-------|-------|--------------|
| **A. Foundations** | 1–4 | conversations schema, ACL gate, ContentBlock shape stability |
| **B. Streaming spine** | 5–8 | event.stream-chunk wiring; SSE filter + ring buffer correctness |
| **C. Chat-flow HTTP** | 9–13 | route auth + ACL on every endpoint; CSRF posture; J9 reqId minting |
| **D. Resume** | 14–16 | active_session_id lifecycle, session:is-alive, runner replay correctness |
| **E. Frontend** | 17–21 | transport shape, AgentMenu / Sidebar / Thread wiring, thinking toggle |
| **F. Wrap** | 22–25 | canary banner present, security rollup, acceptance scenarios pass |

If any block's review reveals an invariant violation (J1–J9 or carried I-series), stop and pull the offending task out for redesign before continuing.

---

## Out of scope (re-statement from handoff)

- `@ax/channel-slack` — Week 13+.
- `@ax/audit` — Week 13+.
- `@ax/scanner-canary` — Week 13+. (Banner per Task 22.)
- Memory / Strata — Week 13+.
- Hard-delete admin endpoint — Week 13+.
- Multi-replica SSE fan-out via `@ax/eventbus-postgres` — Week 13+. MVP is single-replica.
- Conversation title auto-generation — manual title only in MVP.
- Conversation search — Week 13+.
- File attachments wire-protocol redesign — keeps existing 9.5 file-upload plumbing.
- Public agents — out of MVP per Week 9.5 scope decision 2.
- Open-to-wider-access deployment — gated on Week 13+ canary scanner per Scope decision 7.

---

## Dependencies on earlier slices (verified before plan execution)

- ✅ `@ax/http-server` from 9.5 (PR #16 / commit `6609852`).
- ✅ `@ax/auth-oidc` from 9.5 (renamed from `@ax/auth`, commit `ec228e1`).
- ✅ `@ax/agents` from 9.5 — `agents:resolve`, `agents:list-for-user`.
- ✅ `@ax/teams` from 9.5 — `teams:is-member` (transitive via `agents:resolve` for team agents).
- ✅ `@ax/static-files` from 9.5 — channel-web bundle mount.
- ✅ `@ax/channel-web` partial from 9.5 — `LoginPage`, `Thread`, `Sidebar`, `AgentMenu`, `UserMenu`, `MarkdownText`, `admin/` scaffold; `LoginPage` already wired to `@ax/auth-oidc`.
- ✅ `@ax/storage-postgres`, `@ax/session-postgres`, `@ax/database-postgres` from Week 7-9.
- ✅ `@ax/agent-claude-sdk-runner` from 6.5d — extending here for stream-chunk emission + history replay.
- ✅ `@ax/ipc-protocol` `EventStreamChunkSchema` from 6.5a — runtime wiring lands here (Task 5–6).
- ✅ `@ax/chat-orchestrator` `chat:run` + `chat:turn-end` plumbing.

If any of the above is unexpectedly missing on the chosen base branch, stop and re-confirm the branching point with the user. The handoff says "branch off the tip of Week 9.5"; on `main` everything required has merged at commit `3da6710`.
