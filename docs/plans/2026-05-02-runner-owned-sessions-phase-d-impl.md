# Runner-owned sessions — Phase D implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Cut channel-web over to reading transcripts from the workspace's runner-native session jsonl (via `workspace:read`) instead of the postgres `conversation_turns` table. Stop appending turns to postgres on `chat:turn-end`. After this PR, conversation_turns is dead weight (Phase E deletes it) and channel-web's transcript view is sourced from the runner's native format.

**Architecture:** Add a host-side parser (`@ax/runner-claude-sdk-format` or fold into an existing package) that reads jsonl bytes from `workspace:read` and produces canonical `UITurn[]`. Pivot `conversations:get` (or add a new `conversations:get-transcript` hook — see Q1) to use this path. Drop the `appendTurn` call from the conversations plugin's `chat:turn-end` subscriber (keep `last_activity_at` bump). channel-web's `history-adapter` consumes the same wire shape it already does.

**Tech stack:** TypeScript (Node 20+), Vitest, `zod` for jsonl line schemas. No new runtime deps.

**Refs:**
- `docs/plans/2026-05-02-runner-owned-sessions-remaining.md` (summary)
- `docs/plans/2026-05-02-runner-owned-sessions-phase-c-impl.md` (the prior PR — Phase D depends on C-1 having shipped so jsonl actually exists in `/permanent`)
- `docs/plans/2026-04-29-runner-owned-sessions-design.md` (original design — Phase D wired the cutover)

---

## Open questions (need user decision before code)

### Q1. New `conversations:get-transcript` hook OR pivot the existing `conversations:get`?

The existing `conversations:get` hook (`packages/conversations/src/plugin.ts:163-167`) returns `{ conversation, turns }`. Subscribers (channel-web's `routes-chat.ts:444`) consume `out.turns`. Two paths:

- (a) **Pivot in place.** `getConversation()` reads jsonl via `workspace:read`, parses, returns the same wire shape. channel-web doesn't need to change. Risk: any other caller of `conversations:get` that depended on DB-shaped turns silently shifts behavior.
- (b) **Add a new hook.** Keep `conversations:get` returning DB turns (it'll go away in Phase E anyway); add `conversations:get-transcript` returning workspace-sourced turns. channel-web migrates to the new hook. Two hooks coexist briefly.

**Recommend (a).** Single caller (channel-web). The wire shape is identical (parser maps to the same `Turn[]` interface). Simpler migration; Phase E becomes "delete conversation_turns + appendTurn" without an extra "delete the old conversations:get" step. Verify by `grep -rn "conversations:get'" packages/` first to confirm channel-web is the only caller.

### Q2. Where does the parser live?

The parser converts `claude-agent-sdk` jsonl format → canonical `Turn[]`. The parked branch put it in `packages/agent-claude-sdk-runner-host/`. Options:

- (a) Resurrect that package name, scaffold from scratch (the parked branch's scaffold is salvageable per the parked-branch memory).
- (b) Put it in `packages/conversations/` since that's the only consumer. Smaller package surface.
- (c) Put it in `@ax/agent-claude-sdk-runner` (the runner package) since the format is the runner's native format. But `conversations` would then import from the runner — possible I2 violation depending on whether they're both plugins.

Check whether `@ax/agent-claude-sdk-runner` is a plugin (registers bus hooks) or just a binary. If it's a binary (which I think it is — it runs as a subprocess), then importing from it into a plugin package is fine.

**Recommend (a).** Resurrect `@ax/agent-claude-sdk-runner-host`. The parked branch's scaffolding (`cfc942d`) is the right shape. Cherry-pick that single commit (NOT the IPC ones — those are obsolete). Add the parser. Phase 5 of the workspace redesign or a future cleanup may merge it back if the package shape stays minimal.

### Q3. How to handle conversations created BEFORE Phase D?

Conversations that were active before Phase D ships have:
- `runner_session_id` populated by Phase C (or NULL if they predate C).
- `conversation_turns` rows from pre-Phase-D `appendTurn` writes.
- A jsonl file in the workspace ONLY if the conversation has been touched since Phase 3 of the workspace redesign + Phase C-1 (HOME redirect).

The new `getConversation` reads jsonl. If jsonl doesn't exist (old conversation), it returns empty. UX: user opens an old conversation, sees zero turns.

Migration options:
- (a) **Drop history for conversations without jsonl.** Show "history unavailable for conversations created before YYYY-MM-DD." Acceptable for MVP — we have no production users yet.
- (b) **Backfill jsonl from postgres.** A one-shot migration script that reads `conversation_turns`, synthesizes a jsonl in the SDK's format, writes it to the workspace. Heavy.
- (c) **Dual-source fallback.** If jsonl exists, use it; else fall back to `conversation_turns` until Phase E ships. Simple but the fallback path keeps appendTurn alive.

**Recommend (a).** No production users. If production users existed, recommend (c) until Phase E.

If the answer changes my recommendation, the plan needs adjustment for (b) or (c) — flag before code.

If any of these recommendations are wrong, flag before coding starts.

---

## File layout after this PR

```
packages/
├── agent-claude-sdk-runner-host/                 # NEW (or resurrected from parked branch's cfc942d)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── SECURITY.md                                # NEW — minimal capability budget
│   └── src/
│       ├── index.ts                               # exports parseJsonlToTurns
│       ├── parse.ts                               # parser impl
│       └── __tests__/
│           ├── parse.test.ts                      # unit tests for parser
│           └── fixtures/                          # canonical jsonl samples
├── conversations/
│   └── src/
│       ├── plugin.ts                              # MODIFIED — chat:turn-end no longer calls appendTurn (keep last_activity_at)
│       └── __tests__/                             # MODIFIED — assertions on the new path
└── channel-web/
    └── (no source changes if Q1=(a); shape-compatible)
```

Plus: package.json deps in `conversations` add `@ax/agent-claude-sdk-runner-host` workspace dep.

---

## Bite-sized TDD tasks

Order: D-2 parser first (no other deps) → D-3 conversations:get pivot → D-1 drop appendTurn → D-4 channel-web verify (no-op if shapes match) → D-5 canary.

D-2 first because the parser is a pure function; can be unit-tested in isolation. D-3 next because it's the integration point. D-1 next so the write path stops adding to a now-unused table. D-4 verifies channel-web doesn't break. D-5 is the end-to-end canary.

### Task 1: Scaffold `@ax/agent-claude-sdk-runner-host`

**Files:**
- Create: `packages/agent-claude-sdk-runner-host/package.json`
- Create: `packages/agent-claude-sdk-runner-host/tsconfig.json`
- Create: `packages/agent-claude-sdk-runner-host/vitest.config.ts`
- Create: `packages/agent-claude-sdk-runner-host/src/index.ts` (placeholder export)
- Create: `packages/agent-claude-sdk-runner-host/SECURITY.md`
- Modify: `tsconfig.json` (add references entry)

**Steps:**

1. Mirror `packages/workspace-git-server/` shape — copy `tsconfig.json`, `vitest.config.ts`, prune `src/`.
2. `package.json`: `name: "@ax/agent-claude-sdk-runner-host"`, `peerDependencies: { "@ax/core": "*" }`, `dependencies: { zod: "^3" }`.
3. `SECURITY.md`: minimal — package is pure JSON parsing, no spawn, no network, no filesystem (caller passes bytes). Capability budget: zero.
4. `pnpm install` to wire workspace.
5. `pnpm build --filter @ax/agent-claude-sdk-runner-host` succeeds (empty package compiles).

**Commit:** `feat(agent-claude-sdk-runner-host): scaffold package`

### Task 2: Failing test for `parseJsonlToTurns`

**File:** `packages/agent-claude-sdk-runner-host/src/__tests__/parse.test.ts`

The parser converts a jsonl file (the SDK's native format) to canonical `Turn[]`. Each line is a JSON object representing one SDK message. The parser:
- Skips blank lines.
- Parses each line as JSON.
- Filters out non-turn-bearing message types (system/init, system/result, etc. — keep only user-input and assistant turns).
- Maps each turn to `{ role: 'user' | 'assistant', contentBlocks: ContentBlock[] }`.
- Preserves order (file order = turn order).

Read `packages/conversations/src/types.ts` for the canonical `Turn` and `ContentBlock` shapes. The parser must produce the SAME shape that `appendTurn` would have produced, so channel-web's existing renderer works unchanged.

Write fixtures in `__tests__/fixtures/`:
- `simple.jsonl` — one user turn, one assistant turn (text only).
- `with-thinking.jsonl` — assistant turn with thinking + redacted_thinking + text blocks.
- `with-tool-use.jsonl` — assistant turn with tool_use block + tool_result follow-up.
- `truncated.jsonl` — last line is incomplete JSON (parser must skip gracefully).
- `empty.jsonl` — zero lines (returns `[]`).
- `system-only.jsonl` — only system/init + system/result, no user/assistant turns (returns `[]`).

To get realistic fixture content: spin up the runner manually for one turn and copy the actual jsonl file. (Or hand-construct from the SDK's published types.)

Test cases (one per fixture + edge):
- Each fixture's expected `Turn[]` is hardcoded in the test.
- Order is preserved.
- Truncated last line is skipped without throwing.
- Empty file returns `[]`.
- Invalid JSON in mid-file: skipped with a warning to stderr (test asserts the rest of the file still parses).

Run: `pnpm --filter @ax/agent-claude-sdk-runner-host test` → FAIL.

**Commit:** `test(agent-claude-sdk-runner-host): jsonl parser spec`

### Task 3: Implement `parseJsonlToTurns`

**File:** `packages/agent-claude-sdk-runner-host/src/parse.ts`

```ts
import { z } from 'zod';

const SDKMessageSchema = z.discriminatedUnion('type', [
  // Mirror the SDK's native message types. Verify against
  // node_modules/@anthropic-ai/claude-agent-sdk/dist/.../types.d.ts before
  // committing — the schema below is a starting sketch.
  z.object({ type: z.literal('user'), message: z.object({ content: z.unknown() }) }),
  z.object({ type: z.literal('assistant'), message: z.object({ content: z.unknown() }) }),
  z.object({ type: z.literal('system'), subtype: z.string() }).passthrough(),
  z.object({ type: z.literal('result'), subtype: z.string() }).passthrough(),
]);

export interface ParsedTurn {
  role: 'user' | 'assistant';
  contentBlocks: ContentBlock[]; // canonical shape from @ax/core or similar
}

export function parseJsonlToTurns(jsonlBytes: Uint8Array): ParsedTurn[] {
  const text = new TextDecoder('utf-8').decode(jsonlBytes);
  const lines = text.split('\n');
  const turns: ParsedTurn[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue; // truncated or corrupt — skip
    }
    const parsed = SDKMessageSchema.safeParse(json);
    if (!parsed.success) continue;
    const msg = parsed.data;
    if (msg.type === 'user' || msg.type === 'assistant') {
      turns.push(messageToTurn(msg));
    }
    // system / result messages are not turns; skip.
  }

  return turns;
}

function messageToTurn(msg: { type: 'user' | 'assistant'; message: { content: unknown } }): ParsedTurn {
  // Extract content blocks. The SDK stores content as either a string or
  // a ContentBlock[] array. Normalize.
  const content = msg.message.content;
  let contentBlocks: ContentBlock[];
  if (typeof content === 'string') {
    contentBlocks = [{ type: 'text', text: content }];
  } else if (Array.isArray(content)) {
    contentBlocks = content.filter(isCanonicalBlock);
  } else {
    contentBlocks = [];
  }
  return { role: msg.type, contentBlocks };
}

function isCanonicalBlock(b: unknown): b is ContentBlock {
  // Filter to the block kinds canonical Turn supports: text, thinking,
  // redacted_thinking, tool_use, tool_result.
  if (typeof b !== 'object' || b === null) return false;
  const t = (b as { type?: unknown }).type;
  return t === 'text' || t === 'thinking' || t === 'redacted_thinking' || t === 'tool_use' || t === 'tool_result';
}
```

**Important caveat:** the SDK's exact jsonl shape needs to be verified empirically. Run the runner once, capture a real jsonl, validate the schema against it before committing. The schema above is a starting sketch.

Export from `index.ts`:
```ts
export { parseJsonlToTurns, type ParsedTurn } from './parse.js';
```

Run: `pnpm --filter @ax/agent-claude-sdk-runner-host test` → PASS.

**Commit:** `feat(agent-claude-sdk-runner-host): jsonl-to-Turn[] parser`

### Task 4: Pivot `conversations:get` to read from workspace

**Files:**
- Modify: `packages/conversations/src/plugin.ts` (the `getConversation` function)
- Modify: `packages/conversations/package.json` (add `@ax/agent-claude-sdk-runner-host` dep)
- Modify: `packages/conversations/tsconfig.json` (add reference)
- Modify: `packages/conversations/src/__tests__/` (existing tests need updating)

**Step 1: Write failing tests**

Update existing `getConversation` tests to expect:
- The function calls `bus.call('workspace:read', ctx, { path: '.claude/projects/<sessionId>.jsonl' })` (NOT a DB read).
- Where `<sessionId>` comes from the conversation row's `runner_session_id`.
- For a row with `runner_session_id === null`, returns `{ conversation, turns: [] }` (per Q3 recommendation (a)).
- For a row WITH `runner_session_id` but `workspace:read` returns 404 / empty, returns `{ conversation, turns: [] }` (graceful).
- For a row WITH a valid jsonl, returns `{ conversation, turns: <parsed> }` matching the parser's output.

New test cases for the workspace-read path:
- `workspace:read` failure (e.g. plugin not registered, network error) → throws PluginError up the stack so the caller knows.
- jsonl parser produces 0 turns (system-only file) → returns empty turns.

Tests fail because `getConversation` still reads from DB.

**Step 2: Modify `getConversation`**

In `plugin.ts`, find the `getConversation` function (likely around line 800+). Replace the DB-read of turns with:

```ts
async function getConversation(store, bus, ctx, input) {
  const conversation = await store.getConversation({ conversationId: input.conversationId, userId: input.userId });
  if (conversation === null) {
    throw new PluginError({ code: 'not-found', plugin: PLUGIN_NAME, hookName: 'conversations:get', message: 'conversation not found' });
  }
  // ACL gate (existing).
  await bus.call('agents:resolve', ctx, { agentId: conversation.agentId, userId: ctx.userId });

  // Phase D: read transcript from the workspace's runner-native jsonl.
  // Fall back to empty turns if no runner_session_id (pre-Phase-C
  // conversations) or if the workspace doesn't have the file yet.
  let turns: Turn[] = [];
  if (conversation.runnerSessionId !== null) {
    const path = `.claude/projects/${conversation.runnerSessionId}.jsonl`;
    try {
      const result = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        ctx,
        { path },
      );
      if (result.found) {
        turns = parseJsonlToTurns(result.bytes);
      }
    } catch (err) {
      // Distinguish "transcript missing" (acceptable) from "workspace unavailable" (fatal).
      // workspace:read returns { found: false } for missing; throws for transport errors.
      throw err;
    }
  }

  return { conversation, turns };
}
```

Verify the SDK's actual on-disk path layout — `claude-agent-sdk` may write jsonl to a path like `.claude/projects/-Users-foo-bar/<sessionId>.jsonl` (with the cwd encoded). Check empirically before committing; the path computation may need to mirror SDK's encoding.

If the SDK encodes the cwd in the jsonl path, derive that encoding here. Read the SDK's source or run it once and inspect.

Run: `pnpm --filter @ax/conversations test` → PASS.

**Step 3: Commit**

```bash
git add packages/conversations/src/plugin.ts packages/conversations/package.json packages/conversations/tsconfig.json packages/conversations/src/__tests__/
git commit -m "feat(conversations): get transcript from workspace jsonl"
```

### Task 5: Drop `appendTurn` from `chat:turn-end` subscriber

**Files:**
- Modify: `packages/conversations/src/plugin.ts` (the `chat:turn-end` subscriber, around line 260-280)
- Modify: `packages/conversations/src/__tests__/`

**Step 1: Write failing test**

The existing `chat:turn-end` subscriber test asserts `appendTurn` is called when a turn ends with content. Update it: the subscriber should NO LONGER call `appendTurn`, but it SHOULD still bump `last_activity_at` on the conversation row (sidebar ordering depends on this).

New behavior:
- `chat:turn-end` with content blocks → `last_activity_at` bumped on the conversation row; NO insert into `conversation_turns`.
- `chat:turn-end` for a heartbeat (no content) → still no-op.

**Step 2: Modify the subscriber**

In `plugin.ts:260-285` (the `bus.subscribe('chat:turn-end', ...)` block), replace the `appendTurn`-calling path with a direct call to `store.bumpLastActivity({ conversationId, userId })` (or whatever the existing helper is — check `store.ts`).

Keep:
- The `session:terminate` subscriber that clears `active_session_id` (line 270+).
- The compare-and-clear-on-reqId logic.

Drop:
- The call to `:append-turn` service hook (or the `handleTurnEnd` helper that wraps it).
- Remove `'conversations:append-turn'` from the manifest's `calls` array.

Run: `pnpm --filter @ax/conversations test` → PASS.

**Step 3: Commit**

```bash
git add packages/conversations/src/plugin.ts packages/conversations/src/__tests__/
git commit -m "feat(conversations): chat:turn-end stops writing conversation_turns"
```

### Task 6: Verify channel-web history-adapter unchanged

**Files:**
- Read-only: `packages/channel-web/src/lib/history-adapter.ts`, `packages/channel-web/src/server/routes-chat.ts`

Read both. If `conversations:get` returned the same wire shape (Q1=(a) recommendation), channel-web's adapter doesn't need changes. Verify by:

```bash
pnpm --filter @ax/channel-web test
```

If a test fails, the wire shape diverged and either:
- The parser needs tweaking to match, OR
- `history-adapter.ts` needs updating.

If everything passes, no commit on this task.

If a small adjustment is needed:
**Commit:** `fix(channel-web): adapt to workspace-sourced transcript shape`

### Task 7: Canary acceptance test

**File:** Modify `presets/k8s/src/__tests__/acceptance.test.ts`

Extend the existing `git-protocol backend` acceptance test (or add a new sibling `it()`) to:
1. Boot through preset → bootstrap → agent:invoke (existing).
2. After the chat completes, call `bus.call('conversations:get', ctx, { conversationId, userId })`.
3. Assert `out.turns.length > 0` AND `out.turns[0].role === 'user'` (or 'assistant', depending on stub-runner script shape).
4. Assert the turn shape matches what the stub-runner emitted.

This proves end-to-end: stub-runner writes jsonl to /permanent (via Phase C's HOME redirect) → workspace plugin commits it → host's `conversations:get` reads it via `workspace:read` → parser produces turns.

If the stub-runner doesn't write a real jsonl (it's a stub!), one of:
- (a) Make the stub-runner write a hand-constructed jsonl to its workspace cwd as part of the script.
- (b) Use the real claude-agent-sdk-runner instead of the stub for this acceptance case (heavier; needs a working credential path).
- (c) Mock `workspace:read` in the test to return a known jsonl, bypassing the runner-write side. Tests the read+parse path only.

**Recommend (a).** Cheap, exercises the full read path end-to-end. The stub-runner is allowed to do additional filesystem writes; just add a small hook that emits a jsonl alongside its IPC events.

Run: `pnpm --filter @ax/preset-k8s test` → PASS.

**Commit:** `test(preset-k8s): acceptance — transcript reads from workspace jsonl`

### Task 8: PR description

**File to create (gitignored):** `docs/plans/2026-05-02-runner-owned-sessions-phase-d-pr-body.md`

Compose:
- Summary: drop `conversation_turns` writes, read transcripts from workspace jsonl, parser package shipped, channel-web unchanged.
- Migration: pre-Phase-D conversations have empty transcripts (Q3=(a)); acceptable for MVP. Phase E will drop the now-dead conversation_turns table.
- Boundary review: `conversations:get` wire shape unchanged (Turn[] is preserved); the new internal mechanism (workspace:read + parse) is invisible to channel-web. New package `@ax/agent-claude-sdk-runner-host` is pure-parser, no caps.
- Test plan: parser unit tests, conversations integration tests, preset acceptance test.
- Half-wired window: N/A — no new bus hooks, no new IPC actions.

**Commit:** None.

---

## Test plan

After all tasks land:

- [ ] `pnpm build` — clean.
- [ ] `pnpm --filter @ax/agent-claude-sdk-runner-host test` — parser tests pass.
- [ ] `pnpm --filter @ax/conversations test` — get-from-workspace path works; turn-end no longer writes conversation_turns.
- [ ] `pnpm --filter @ax/channel-web test` — passes unchanged (or with minor adapter tweaks).
- [ ] `pnpm --filter @ax/preset-k8s test` — acceptance test reads jsonl end-to-end.
- [ ] Manual canary in kind: deploy with workspace.backend=git-protocol, send a chat turn, reload the conversation in browser, see the turn rendered from jsonl.

---

## Boundary review (per CLAUDE.md)

- **`conversations:get` wire shape:** unchanged. Subscribers (channel-web) see the same `{ conversation, turns }` shape. No leak.
- **`conversations:get` internal impl:** now reads `workspace:read` instead of DB. Documented in source comment. Alternate impl could be DB-read fallback (for pre-Phase-D rows); we chose Q3=(a) instead.
- **`@ax/agent-claude-sdk-runner-host`:** new package, pure-function parser. Imports from `@ax/core` (types only) and `zod`. No cross-plugin imports.
- **`chat:turn-end` subscriber:** behavior change (no longer writes turns). Subscribers that depended on `conversation_turns` rows being written... there are none other than the soon-to-be-deleted `conversations:fetch-history`. Phase E cleans that up.

---

## Migration & rollback

**Migration strategy:** Q3=(a) — pre-Phase-D conversations show empty transcripts. No data migration. Acceptable because no production users exist yet.

**Rollback:** revert the conversations PR. The `chat:turn-end` subscriber starts writing `conversation_turns` again; `getConversation` reads from DB. New conversations created post-revert won't have jsonl readback (they will have it on disk, just not surfaced) — that's acceptable for a rollback window.

If the rollback is needed AFTER Phase E ships (which deletes `conversation_turns`), rollback is harder — Phase E is a destructive migration. Document this dependency in Phase E's PR description.

---

## Sequencing implication for Phase E

Phase E (delete replay code, drop `conversation_turns` table) is gated on Phase D being live and soaked. After D ships, monitor for:
- Errors in `getConversation` — would indicate the parser or workspace:read path has a bug.
- Empty transcripts on conversations that should have content — indicates a path-encoding bug in `runner_session_id → jsonl path`.

After ~1 week of clean canary, ship Phase E.

---

## What I want from you before I start

Three sign-offs:

1. **Q1 (hook shape).** Pivot existing `conversations:get` in place — recommended. OK?
2. **Q2 (parser package).** Resurrect `@ax/agent-claude-sdk-runner-host` — recommended. OK?
3. **Q3 (pre-Phase-D conversations).** Show empty transcripts; no backfill — recommended for MVP. OK?

After those, I'll start at Task 1.
