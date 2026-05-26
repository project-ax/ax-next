# Runner-owned sessions — Phase F implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Ship `@ax/conversation-titles` — a small subscriber plugin that auto-generates a short title for a conversation after the first assistant turn lands, using a cheap LLM call, and persists it via a new `conversations:set-title` service hook on `@ax/conversations`. After this PR, conversations get human-readable sidebar labels instead of `null`.

**Architecture:** Two-piece, both shippable in one PR:

1. **`@ax/conversations`** gains one new service hook, `conversations:set-title`, that updates the existing `title` column. The column, validator, and migration already exist (Phase B). No schema change.
2. **`@ax/conversation-titles`** (new plugin) subscribes to `chat:turn-end`. On the first turn-end where `role === 'assistant'` AND the conversation's `title` is still `null`, it reads the transcript via `conversations:get`, sends a 1-2-message LLM call to a cheap model with a "summarize in ≤8 words" prompt, validates the result, and calls `conversations:set-title`. Failures are logged and swallowed (subscriber posture).

**Tech stack:** TypeScript (Node 20+), Vitest, `zod` for prompt-output sanity, `@anthropic-ai/sdk` for the title LLM call (or `llm:call` hook — see Q1).

**Refs:**
- `docs/plans/2026-04-29-runner-owned-sessions-design.md` §D6 (deferred title plugin) and §"Component responsibilities" (`@ax/conversation-titles`)
- `docs/plans/2026-05-02-runner-owned-sessions-remaining.md` §Phase F
- `docs/plans/2026-05-02-runner-owned-sessions-phase-d-impl.md` (Phase D introduces `conversations:get` reading from workspace jsonl — Phase F leans on it)

**Sequencing:** Phase F is gated on **Phase D** being live. Without D, `conversations:get` reads the (about-to-be-deleted) `conversation_turns` table, and on a fresh-conversation path during the cutover the assistant turn might not be persisted there yet — F could see an empty transcript and skip titling. After D, the assistant turn is in jsonl by the time `chat:turn-end` fires. Phase E (mechanical deletes) can ship before, after, or alongside F; F doesn't depend on the deletion.

---

## Open questions (need user decision before code)

### Q1. How does the titles plugin call an LLM?

There is **no host-side `llm:call` registrar** in the live codebase today. `packages/llm-anthropic/` exists as dist-only (no `package.json`, no `src/`) — a stale carcass from an earlier shape. The runner subprocess calls Anthropic via the SDK directly through the credential proxy; the host has no LLM hook.

Three paths:

- (a) **Resurrect `@ax/llm-anthropic` as a real plugin**, registering `llm:call`. Titles plugin calls `llm:call`. Future host-side LLM consumers (summary, search, classifiers) reuse it.
- (b) **Titles plugin imports `@anthropic-ai/sdk` directly**, reads `ANTHROPIC_API_KEY` from env, calls `messages.create` itself. Self-contained; no new shared abstraction.
- (c) **Route through the credential proxy bridge.** Heavyweight; the bridge is designed for the runner subprocess, not host plugins.

**Recommend (a).** Scaffolding `@ax/llm-anthropic` is small (~80 lines, the dist file shows the shape), and the second consumer (search/classification, eventually) is foreseeable. The dist code is a starting reference but should be rewritten cleanly. Phase F is then **two new packages plus one hook addition** — bigger than (b) but the abstraction is a real one we'll keep.

If you want F to ship faster and prefer (b), say so — the plan changes only Tasks 1-2 (drop the llm-anthropic scaffold, inline the SDK call inside `@ax/conversation-titles`).

### Q2. When does the titler fire?

The design (§D6) says "after first user message (or message-count threshold)." Concretely:

- (a) **First assistant turn-end, title is null** — strictly the first model response. Cheapest possible. Title may be a bit thin (only one user + one assistant turn of context) but for a chat sidebar, that's usually enough.
- (b) **After N turns (e.g., N=2 user-turns)** — better signal but delays the title appearing in the sidebar.
- (c) **First assistant turn-end + a "retitle on turn 5" pass** — two LLM calls; iffy ROI.

**Recommend (a).** Sidebar UX cares about "labeled vs. unlabeled" more than "perfect label." Re-titling can be a manual user action later. Idempotency is enforced by the `title === null` guard — at-least-once delivery is safe.

### Q3. Which model + prompt?

Model: **`claude-haiku-4-5-20251001`** (cheapest current Claude). Max tokens: 32 (titles are short). Temperature: 0.3 (some variety, mostly deterministic).

Prompt sketch:

```
System: You generate short, descriptive titles for conversations between a
user and an AI assistant. Output ONLY the title — no quotes, no preamble,
no trailing period. Maximum 8 words. Use Title Case. If the conversation
content is empty or unclear, output exactly: Untitled

User: Summarize this conversation in ≤8 words:
<transcript flattened to text>
```

Validation post-call:
- Strip leading/trailing whitespace + outer quotes.
- Truncate at 80 chars (matches `validateTitle`'s likely upper bound — verify against `TITLE_MAX` in `packages/conversations/src/store.ts`).
- Reject if empty after stripping.
- If validation rejects, log + skip (don't write garbage).

**Recommend the above.** If you have strong opinions on prompt or model, change before coding.

### Q4. How does the titles plugin discover the conversation's transcript?

It receives `chat:turn-end` with `ctx.conversationId` and `ctx.userId` populated. Then:

- (a) Call `conversations:get` to get `{ conversation, turns }`. Title from `turns`.
- (b) Use the payload's `contentBlocks` (just the assistant turn that just ended) plus a separate fetch of the user prompt.

**Recommend (a).** One hook call; full context. After Phase D, `conversations:get` is the canonical "read this conversation" path. We're consistent.

If any of these recommendations are wrong, flag before coding starts.

---

## File layout after this PR

```
packages/
├── llm-anthropic/                          # NEW (assuming Q1=(a)) — replaces stale dist-only carcass
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── SECURITY.md                          # NEW — capability budget: env (ANTHROPIC_API_KEY), network (api.anthropic.com)
│   └── src/
│       ├── index.ts                         # exports createLlmAnthropicPlugin
│       ├── plugin.ts                        # registers llm:call
│       ├── translate.ts                     # core ↔ Anthropic SDK shape
│       └── __tests__/
│           ├── plugin.test.ts               # boots plugin, hits llm:call with mocked SDK
│           └── translate.test.ts            # shape conversions
├── conversation-titles/                    # NEW
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── SECURITY.md                          # NEW — capability budget: calls llm:call + conversations:* only
│   └── src/
│       ├── index.ts                         # exports createConversationTitlesPlugin
│       ├── plugin.ts                        # subscribes chat:turn-end, calls llm:call + set-title
│       ├── prompt.ts                        # buildPrompt(transcript) → { system, user }
│       ├── validate.ts                      # validateGeneratedTitle()
│       └── __tests__/
│           ├── plugin.test.ts               # subscriber e2e with mocked llm:call
│           ├── prompt.test.ts               # prompt construction
│           └── validate.test.ts             # output sanitization
├── conversations/
│   ├── src/
│   │   ├── plugin.ts                        # MODIFIED — add conversations:set-title registrar + handler
│   │   ├── store.ts                         # MODIFIED — add ConversationStore.setTitle()
│   │   ├── types.ts                         # MODIFIED — SetTitleInput / SetTitleOutput
│   │   └── __tests__/
│   │       └── set-title.test.ts            # NEW — store + hook tests
│   └── (manifest, types.ts updated)
└── core/
    └── src/
        └── (no source change — llm:call types may already exist; verify)
```

Plus:
- `tsconfig.json` (root): add references for the two new packages.
- `pnpm-workspace.yaml`: typically picks up `packages/*` automatically — verify the new dirs aren't excluded.
- `presets/k8s/src/preset.ts`: load `@ax/llm-anthropic` and `@ax/conversation-titles` so the canary boots them.

---

## Bite-sized TDD tasks

Order: F-1 set-title hook (foundation, no deps) → F-2 llm-anthropic scaffold → F-3 llm-anthropic translate + plugin → F-4 conversation-titles prompt+validate (pure) → F-5 conversation-titles subscriber → F-6 preset wiring → F-7 canary.

This order keeps the tree green at every commit. Each task is one logical commit.

### Task 1: Add `conversations:set-title` service hook

**Files:**
- Modify: `packages/conversations/src/types.ts` (add `SetTitleInput` / `SetTitleOutput`)
- Modify: `packages/conversations/src/store.ts` (add `setTitle()` method to the store)
- Modify: `packages/conversations/src/plugin.ts` (register the hook, add `conversations:set-title` to manifest `registers`)
- Create: `packages/conversations/src/__tests__/set-title.test.ts`

**Step 1: Write failing tests** (`set-title.test.ts`)

Cases:
- `setTitle({ conversationId, userId, title })` updates the row when the conversation exists and is owned by `userId`.
- `setTitle` calls `agents:resolve` (ACL gate, J1) before touching the store. If `agents:resolve` throws `forbidden`, the hook propagates `forbidden` and does NOT touch the store.
- `setTitle` is idempotent: setting the same title twice is fine.
- `setTitle` with a 0-length string throws `invalid-payload` (via `validateTitle`).
- `setTitle` with a 65-char string (over `TITLE_MAX`) throws `invalid-payload`.
- `setTitle` with an `if-null` semantic — see Step 2 — only updates if `title IS NULL`.
- `setTitle` for a missing conversation throws `not-found`.
- `setTitle` for a soft-deleted conversation throws `not-found`.

Run: `pnpm --filter @ax/conversations test` → FAIL.

**Step 2: Decide `if-null` semantics**

The titles plugin needs an "only set if null" semantic so re-deliveries of `chat:turn-end` (at-least-once bus, retried subscribers) don't overwrite a title later edited by the user. Options:

- (a) **`set-title` always overwrites.** Titles plugin reads the row first via `conversations:get-metadata` and skips if non-null. Race: between the read and the write, a user could rename. Window is small but real.
- (b) **`set-title` accepts `{ ifNull: true }` flag.** Atomic `UPDATE … WHERE title IS NULL`. Returns `{ updated: boolean }`. No race.

**Recommend (b).** One round-trip, atomic. `ifNull` defaults to `false` so manual user re-titling (future feature) uses unconditional overwrite.

`SetTitleInput`:
```ts
export interface SetTitleInput {
  conversationId: string;
  userId: string;
  title: string;
  ifNull?: boolean; // default false
}
export interface SetTitleOutput {
  updated: boolean; // false if ifNull=true and title was already non-null
}
```

**Step 3: Implement**

`store.ts`:
```ts
async setTitle(input: SetTitleInput): Promise<{ updated: boolean }> {
  const validated = validateTitle(input.title);
  if (validated === null) throw invalid('title cannot be null');
  let q = this.db
    .updateTable('conversations_v2_conversations')
    .set({ title: validated })
    .where('conversation_id', '=', input.conversationId)
    .where('user_id', '=', input.userId)
    .where('deleted_at', 'is', null);
  if (input.ifNull === true) q = q.where('title', 'is', null);
  const result = await q.executeTakeFirst();
  // numUpdatedRows is bigint — coerce.
  const updated = Number(result.numUpdatedRows ?? 0) > 0;
  return { updated };
}
```

Note: when `ifNull=true` and the row exists but title is already non-null, `updated=false`. When `ifNull=false` and the row doesn't exist (or is soft-deleted), `updated=false` and the caller should infer "not found." The hook handler distinguishes by checking row existence first via `getConversation()` — same posture as other hooks.

`plugin.ts`: add to manifest:
```ts
registers: [
  // ...existing...,
  'conversations:set-title',  // Phase F (2026-05-03)
]
```

In the schema-validation block (~line 200-220):
```ts
'conversations:set-title': SetTitleInputSchema, // adds zod schema
```

Register a handler that:
1. ACL-gates via `agents:resolve` (look up `agentId` from the conversation row).
2. Calls `store.setTitle(input)`.
3. Returns `{ updated }`.

Run: `pnpm --filter @ax/conversations test` → PASS.

**Commit:** `feat(conversations): add conversations:set-title hook`

### Task 2: Scaffold `@ax/llm-anthropic` (assuming Q1=(a))

**Files:**
- Create: `packages/llm-anthropic/package.json`
- Create: `packages/llm-anthropic/tsconfig.json`
- Create: `packages/llm-anthropic/vitest.config.ts`
- Create: `packages/llm-anthropic/SECURITY.md`
- Create: `packages/llm-anthropic/src/index.ts` (placeholder)
- Modify: root `tsconfig.json` (add reference)

**Steps:**

1. Mirror `packages/agent-claude-sdk-runner-host/` shape — copy `tsconfig.json`, `vitest.config.ts`, prune `src/`.
2. `package.json`:
   ```json
   {
     "name": "@ax/llm-anthropic",
     "version": "0.0.0",
     "type": "module",
     "main": "./dist/index.js",
     "types": "./dist/index.d.ts",
     "scripts": { "build": "tsc -b", "test": "vitest run" },
     "peerDependencies": { "@ax/core": "workspace:*" },
     "dependencies": { "@anthropic-ai/sdk": "^0.30.0", "zod": "^3" }
   }
   ```
   Verify `@anthropic-ai/sdk` version against the runner's pinned version (consistency); both should depend on the same major.
3. `SECURITY.md`: walk the three-threat-model checklist (use the `security-checklist` skill). Capability budget:
   - `env`: reads `ANTHROPIC_API_KEY` (required at init).
   - `network`: outbound HTTPS to `api.anthropic.com` only.
   - `filesystem`: none.
   - `process`: none.
   - Untrusted input: caller-provided `messages` content. Treated opaquely — passed to Anthropic as-is. No injection-risk surface here.
4. `index.ts`: empty `export {}` placeholder.
5. `pnpm install`.
6. `pnpm build --filter @ax/llm-anthropic` → succeeds (empty package compiles).

**Commit:** `feat(llm-anthropic): scaffold package`

### Task 3: Implement `llm:call` registrar

**Files:**
- Create: `packages/llm-anthropic/src/translate.ts`
- Create: `packages/llm-anthropic/src/plugin.ts`
- Create: `packages/llm-anthropic/src/__tests__/translate.test.ts`
- Create: `packages/llm-anthropic/src/__tests__/plugin.test.ts`
- Modify: `packages/llm-anthropic/src/index.ts` (export `createLlmAnthropicPlugin`)
- Modify: `packages/core/src/types.ts` or wherever `LlmCallInput`/`LlmCallOutput` live — verify these types exist (the dist-only old plugin assumed they did). If not, add them to `@ax/core`.

**Step 1: Verify `LlmCallInput`/`LlmCallOutput` shape in `@ax/core`**

```bash
grep -rn "LlmCallInput\|LlmCallOutput\|llm:call" packages/core/src/ --include="*.ts"
```

If the types exist, use them. If not, add minimal shape:
```ts
export interface LlmCallInput {
  model?: string;
  maxTokens?: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
}
export interface LlmCallOutput {
  text: string;
  stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'unknown';
  usage: { inputTokens: number; outputTokens: number };
}
```

This is a v1 shape — text-only, no streaming, no tool-use. Phase F doesn't need more. Future host-side LLM consumers can extend.

**Step 2: Write failing tests**

`translate.test.ts`:
- `toAnthropicRequest({ model: 'claude-haiku-4-5-20251001', messages: [...], maxTokens: 32 })` produces the right Anthropic request shape.
- `fromAnthropicResponse({ content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn', usage: {...} })` produces the canonical `LlmCallOutput`.
- Edge: response with no text block returns `{ text: '' }`.
- Edge: response with multiple text blocks concatenates.

`plugin.test.ts`:
- Booting the plugin without `ANTHROPIC_API_KEY` throws `init-failed`.
- After init, `bus.call('llm:call', ctx, input)` invokes the SDK client and returns the translated output (use a `clientFactory` config option that returns a stub).
- A 5xx from the SDK retries once after a delay (use `retryDelayMs: 0` in test config).
- A 4xx from the SDK throws `PluginError({ code: 'unknown', plugin: '@ax/llm-anthropic', hookName: 'llm:call' })` immediately (no retry).

Run: `pnpm --filter @ax/llm-anthropic test` → FAIL.

**Step 3: Implement**

Reference the dist-only carcass at `packages/llm-anthropic/dist/plugin.js` for the *shape*, but rewrite cleanly. Key points:

- `createLlmAnthropicPlugin(cfg = {})` returns a `Plugin` with `manifest.registers: ['llm:call']`.
- `init({ bus })`: read `ANTHROPIC_API_KEY` (via `cfg.apiKey ?? process.env.ANTHROPIC_API_KEY`), construct `Anthropic` client (`cfg.clientFactory` for tests), register `llm:call` via `bus.registerService`.
- `callWithRetry(client, input, cfg)`: one retry on `429/500/502/503/504`, configurable delay (`cfg.retryDelayMs`, default 1000). Other errors throw immediately as `PluginError`.
- Defaults: `model: 'claude-haiku-4-5-20251001'`, `maxTokens: 4096`. Caller can override.

`index.ts`:
```ts
export { createLlmAnthropicPlugin } from './plugin.js';
export type { LlmAnthropicConfig } from './plugin.js';
```

Run: `pnpm --filter @ax/llm-anthropic test` → PASS.

**Commit:** `feat(llm-anthropic): register llm:call hook`

### Task 4: Scaffold `@ax/conversation-titles` + pure helpers

**Files:**
- Create: `packages/conversation-titles/package.json`
- Create: `packages/conversation-titles/tsconfig.json`
- Create: `packages/conversation-titles/vitest.config.ts`
- Create: `packages/conversation-titles/SECURITY.md`
- Create: `packages/conversation-titles/src/prompt.ts`
- Create: `packages/conversation-titles/src/validate.ts`
- Create: `packages/conversation-titles/src/__tests__/prompt.test.ts`
- Create: `packages/conversation-titles/src/__tests__/validate.test.ts`
- Create: `packages/conversation-titles/src/index.ts` (placeholder)
- Modify: root `tsconfig.json` (add reference)

**Step 1: Scaffold** (same posture as Task 2 but for `conversation-titles`).

`package.json` deps:
```json
{
  "peerDependencies": { "@ax/core": "workspace:*" },
  "dependencies": { "@ax/conversations": "workspace:*", "zod": "^3" }
}
```

Note: `@ax/conversation-titles` MUST NOT import `@ax/llm-anthropic`. It calls `llm:call` through the bus. (Cross-plugin imports are I2.)
It DOES import `@ax/conversations` for the **types** of `conversations:get` / `conversations:set-title` payloads — types-only imports are not the I2 violation, but verify by reading the sibling rule. If types-only is also forbidden, mirror the types locally per `validateRunnerType` precedent.

`SECURITY.md`: capability budget — `calls: ['llm:call', 'conversations:get', 'conversations:set-title']`, `subscribes: ['chat:turn-end']`. No env, no network, no filesystem.

**Step 2: Failing tests for `prompt.ts`**

`buildPrompt(turns: Turn[])` → `{ system: string; user: string }`. Tests:
- Flattens text blocks across turns into a labeled transcript: "User: foo\nAssistant: bar\n…"
- Caps total transcript length at ~4000 chars (head-only, drop trailing turns if over budget).
- Drops thinking/redacted_thinking blocks (signal noise).
- Includes tool_use as `[tool: <name>]` shorthand and tool_result as `[result]`.
- Returns the canonical system prompt verbatim.

**Step 3: Implement `prompt.ts`**

```ts
const SYSTEM_PROMPT = `You generate short, descriptive titles for conversations between a user and an AI assistant. Output ONLY the title — no quotes, no preamble, no trailing period. Maximum 8 words. Use Title Case. If the conversation is empty or unclear, output exactly: Untitled`;

const TRANSCRIPT_BUDGET = 4000;

export function buildPrompt(turns: Turn[]): { system: string; user: string } {
  const lines: string[] = [];
  let used = 0;
  for (const turn of turns) {
    const text = flattenBlocks(turn.contentBlocks);
    if (text.length === 0) continue;
    const label = turn.role === 'user' ? 'User' : turn.role === 'assistant' ? 'Assistant' : 'Tool';
    const line = `${label}: ${text}`;
    if (used + line.length > TRANSCRIPT_BUDGET) break;
    lines.push(line);
    used += line.length;
  }
  return {
    system: SYSTEM_PROMPT,
    user: `Summarize this conversation in ≤8 words:\n\n${lines.join('\n')}`,
  };
}

function flattenBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map(b => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[tool: ${b.name}]`;
      if (b.type === 'tool_result') return '[result]';
      return ''; // thinking, redacted_thinking dropped
    })
    .filter(s => s.length > 0)
    .join(' ');
}
```

Run: `pnpm --filter @ax/conversation-titles test` → prompt tests PASS.

**Step 4: Failing tests for `validate.ts`**

`validateGeneratedTitle(raw: string): string | null` — returns sanitized title or `null` on rejection. Tests:
- `'  Hello World  '` → `'Hello World'` (trim).
- `'"Hello World"'` → `'Hello World'` (strip outer quotes — both `"` and `'`).
- `''` → `null`.
- `'Untitled'` → `null` (the model's signal for "no signal" — we'd rather leave the row null than set "Untitled").
- A 100-char string → truncated to 80 chars (or whatever `TITLE_MAX` is — verify).
- A string containing a newline → first line only, then trim.

**Step 5: Implement `validate.ts`**

```ts
const TITLE_MAX = 80; // mirror packages/conversations/src/store.ts
export function validateGeneratedTitle(raw: string): string | null {
  let s = raw.split('\n')[0] ?? '';
  s = s.trim();
  // Strip matched outer quotes.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.length === 0) return null;
  if (s === 'Untitled') return null;
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX).trim();
  return s.length > 0 ? s : null;
}
```

Run: `pnpm --filter @ax/conversation-titles test` → all PASS.

**Commit:** `feat(conversation-titles): scaffold + prompt + validate`

### Task 5: `chat:turn-end` subscriber

**Files:**
- Create: `packages/conversation-titles/src/plugin.ts`
- Modify: `packages/conversation-titles/src/index.ts` (export `createConversationTitlesPlugin`)
- Create: `packages/conversation-titles/src/__tests__/plugin.test.ts`

**Step 1: Failing test** (`plugin.test.ts`)

Use `@ax/test-harness` (or whatever the canonical test bus is — check sibling plugin tests). Cases:

- Plugin loads cleanly with manifest:
  ```ts
  { name: '@ax/conversation-titles', registers: [], calls: ['llm:call', 'conversations:get', 'conversations:set-title'], subscribes: ['chat:turn-end'] }
  ```
- On `chat:turn-end` with `role === 'user'`: subscriber is a no-op. No `llm:call`, no `set-title`.
- On `chat:turn-end` with `role === 'assistant'` and `ctx.conversationId === undefined`: no-op.
- On `chat:turn-end` with `role === 'assistant'`, `conversationId` set, `conversations:get` returns `{ conversation: { title: 'X' }, turns: [...] }`: skip `llm:call` (already titled). Subscriber returns without calling either.
- On `chat:turn-end` with `role === 'assistant'`, conversation has `title: null`, transcript has 2+ turns: calls `llm:call` once, then `conversations:set-title` with the validated output and `ifNull: true`.
- On `llm:call` failure: log + swallow, no `set-title`. Subscriber does NOT throw.
- On `conversations:set-title` returning `{ updated: false }`: log a debug line ("title already set by another instance"), don't retry.
- On `validateGeneratedTitle` returning `null`: skip `set-title`, log + swallow.

Run: `pnpm --filter @ax/conversation-titles test` → FAIL.

**Step 2: Implement `plugin.ts`**

```ts
import {
  PluginError,
  type AgentContext,
  type Plugin,
} from '@ax/core';
import type {
  GetInput,
  GetOutput,
  SetTitleInput,
  SetTitleOutput,
} from '@ax/conversations';
import { buildPrompt } from './prompt.js';
import { validateGeneratedTitle } from './validate.js';

const PLUGIN_NAME = '@ax/conversation-titles';
const TITLE_MODEL = 'claude-haiku-4-5-20251001';
const TITLE_MAX_TOKENS = 32;

interface TurnEndPayload {
  role?: 'user' | 'assistant' | 'tool';
  contentBlocks?: unknown[];
  reqId?: string;
}

export function createConversationTitlesPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['llm:call', 'conversations:get', 'conversations:set-title'],
      subscribes: ['chat:turn-end'],
    },
    async init({ bus }) {
      bus.subscribe('chat:turn-end', PLUGIN_NAME, async (ctx, payload: TurnEndPayload) => {
        try {
          await handle(bus, ctx, payload);
        } catch (err) {
          ctx.logger.warn('conversation_titles_subscriber_failed', {
            err: err instanceof Error ? err : new Error(String(err)),
            conversationId: ctx.conversationId,
          });
        }
      });
    },
  };
}

async function handle(bus: HookBus, ctx: AgentContext, payload: TurnEndPayload): Promise<void> {
  if (payload.role !== 'assistant') return;
  if (ctx.conversationId === undefined) return;
  if (ctx.userId === undefined) return; // defensive

  // Read transcript + check existing title.
  const conv = await bus.call<GetInput, GetOutput>('conversations:get', ctx, {
    conversationId: ctx.conversationId,
    userId: ctx.userId,
  });
  if (conv.conversation.title !== null) return;
  if (conv.turns.length === 0) return;

  const prompt = buildPrompt(conv.turns);
  const llmOut = await bus.call('llm:call', ctx, {
    model: TITLE_MODEL,
    maxTokens: TITLE_MAX_TOKENS,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    temperature: 0.3,
  });

  const title = validateGeneratedTitle(llmOut.text);
  if (title === null) {
    ctx.logger.debug('conversation_titles_validation_skipped', {
      conversationId: ctx.conversationId,
      raw: llmOut.text,
    });
    return;
  }

  const result = await bus.call<SetTitleInput, SetTitleOutput>('conversations:set-title', ctx, {
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    title,
    ifNull: true,
  });
  if (!result.updated) {
    ctx.logger.debug('conversation_titles_already_set', {
      conversationId: ctx.conversationId,
    });
  }
}
```

Run: `pnpm --filter @ax/conversation-titles test` → PASS.

**Commit:** `feat(conversation-titles): chat:turn-end subscriber + llm:call`

### Task 6: Wire into k8s preset

**Files:**
- Modify: `presets/k8s/src/preset.ts` (or wherever the canary preset lives — confirm path with `find presets -name 'preset.ts'`)
- Modify: `presets/k8s/package.json` (add deps on `@ax/llm-anthropic` and `@ax/conversation-titles`)
- Modify: `presets/k8s/tsconfig.json` (add references)

**Steps:**

1. Find the preset's plugin-loading function and add:
   ```ts
   import { createLlmAnthropicPlugin } from '@ax/llm-anthropic';
   import { createConversationTitlesPlugin } from '@ax/conversation-titles';
   // ...
   plugins.push(createLlmAnthropicPlugin());
   plugins.push(createConversationTitlesPlugin());
   ```
2. Both plugins are gated on `ANTHROPIC_API_KEY` being present at boot. If the canary doesn't have one, `llm:call` plugin's init throws and the preset fails fast. Check the canary harness — does it set `ANTHROPIC_API_KEY`?
   - If yes: load both unconditionally.
   - If no: load both behind a config flag like `cfg.titlesEnabled === true`. Document in preset.
3. `pnpm build` succeeds. `pnpm --filter @ax/preset-k8s test` passes (existing tests don't exercise titling, so this is a "doesn't regress" check).

**Commit:** `feat(preset-k8s): load llm-anthropic + conversation-titles plugins`

### Task 7: Canary acceptance test

**File:** Modify `presets/k8s/src/__tests__/acceptance.test.ts`

Add a sibling `it()` to the existing "git-protocol backend" acceptance test:

1. Boot through preset → bootstrap → `agent:invoke` (existing flow).
2. After the chat completes, poll `bus.call('conversations:get-metadata', ctx, { conversationId })` for up to 30 seconds, asserting `out.title !== null`.
3. The `llm:call` plugin in the test should be **stubbed** — replace the real Anthropic client with a deterministic factory that returns a fixed string ("Test Conversation Title"). Use the plugin's `clientFactory` config option.
4. Assert the persisted title equals `'Test Conversation Title'` (post-validation).

This proves end-to-end: assistant turn ends → titles plugin reads transcript → calls `llm:call` (stubbed) → `set-title` writes → metadata read returns the title.

**Why poll instead of awaiting the subscriber:** subscribers are fire-and-forget on the bus; `agent:invoke` returns when the runner emits `chat:end`, but the title-setting subscriber runs concurrently. A short poll loop is the canonical way (search `acceptance.test.ts` for prior `waitFor` / `pollUntil` helpers).

Run: `pnpm --filter @ax/preset-k8s test` → PASS.

**Commit:** `test(preset-k8s): acceptance — conversation gets auto-titled`

### Task 8: PR description

**File to create (gitignored):** `docs/plans/2026-05-03-runner-owned-sessions-phase-f-pr-body.md`

Compose:
- **Summary:** Ships `@ax/llm-anthropic` (host-side `llm:call` registrar) and `@ax/conversation-titles` (subscriber that titles a conversation on first assistant turn). Adds `conversations:set-title` hook with `ifNull` semantics. Closes Phase F of the runner-owned-sessions design (2026-04-29).
- **Why now:** Phase D shipped; conversations are readable via `workspace:read` jsonl. Sidebar UX wants labels.
- **Boundary review:**
  - `conversations:set-title` — alternate impls: any metadata store. Payload (`conversationId`, `userId`, `title`, `ifNull`) — none leak. Subscriber risk: none (service hook).
  - `llm:call` — alternate impls: OpenAI, local model, etc. Shape is provider-neutral (`model`, `messages`, etc.). v1 is text-only by design; tool-use can extend later.
  - `chat:turn-end` subscriber — observation only; never throws.
- **Half-wired window:** **N/A.** `@ax/llm-anthropic` registers `llm:call` and is consumed by `@ax/conversation-titles` in the same PR. `@ax/conversation-titles`' `set-title` consumer of `conversations:set-title` lands in the same PR as the registrar. No half-wired window.
- **Capability minimization (I5):** `llm-anthropic` reads `ANTHROPIC_API_KEY`, opens TLS to `api.anthropic.com`, no FS, no spawn. `conversation-titles` no env, no network, no FS — calls bus only.
- **Test plan:**
  - parser: `pnpm --filter @ax/llm-anthropic test` (translate, plugin)
  - subscriber: `pnpm --filter @ax/conversation-titles test` (prompt, validate, plugin)
  - hook: `pnpm --filter @ax/conversations test` (set-title acl + ifNull semantics)
  - preset: `pnpm --filter @ax/preset-k8s test` (acceptance — auto-titling via stub)

**Commit:** None.

---

## Test plan

After all tasks land:

- [ ] `pnpm build` — clean across workspace.
- [ ] `pnpm --filter @ax/conversations test` — set-title hook + ifNull semantics pass.
- [ ] `pnpm --filter @ax/llm-anthropic test` — `llm:call` registrar, retry logic, translate.
- [ ] `pnpm --filter @ax/conversation-titles test` — subscriber runs the user/assistant/notitle/llmfail/validatefail paths.
- [ ] `pnpm --filter @ax/preset-k8s test` — acceptance test sees a non-null title after a stubbed-LLM canary chat.
- [ ] Manual canary in kind with a real `ANTHROPIC_API_KEY`: send a chat turn, reload the conversation list, see a real title in the sidebar.
- [ ] `pnpm test` — full sweep is green.

---

## Boundary review (per CLAUDE.md)

### `conversations:set-title`

- **Alternate impl:** sqlite-backed conversations store, GCS-backed metadata, etc. The hook is store-agnostic.
- **Payload field names that might leak:** none. `conversationId`, `userId`, `title`, `ifNull` are all generic.
- **Subscriber risk:** service hook with one registrar — no subscriber risk.
- **Wire surface:** internal to host. No IPC.

### `llm:call`

- **Alternate impl:** OpenAI, local Ollama, any provider. The shape is provider-neutral — `messages`, `model`, `maxTokens`, `temperature` are universal. `stop_reason` is the one Anthropic-shaped field; the canonical `LlmCallOutput` enum maps its values to a neutral set.
- **Payload field names that might leak:** check `system` vs. `system_prompt` (we use `system` — Anthropic-style but also fine in OpenAI). `usage.inputTokens` / `outputTokens` is universal. None leak.
- **Subscriber risk:** service hook with one registrar.
- **Wire surface:** internal to host.

### `@ax/conversation-titles` plugin

- Pure subscriber + bus consumer. No new bus hooks. No IPC. No filesystem. Capability budget: minimal.

---

## Migration & rollback

**Migration:** No data migration. Existing conversations have `title: null` until they receive an assistant turn-end with the plugin loaded; then they auto-title. Nothing to backfill.

**Rollback:** Unload the two plugins from the preset. New conversations stop auto-titling; existing titles stay. Drop `conversations:set-title` from `@ax/conversations` only if no other consumer has appeared (likely; this is the only one).

The `conversations.title` column was added in Phase B and used by `conversations:create`; nothing in this PR touches schema, so rollback is plugin-load-only.

---

## What I want from you before I start

Four sign-offs (Q1 is the load-bearing one):

1. **Q1 (LLM access).** Resurrect `@ax/llm-anthropic` as a real plugin with `llm:call` registrar — recommended. Path (b) — inline SDK call inside `@ax/conversation-titles` — is faster but skips a likely-needed abstraction. OK with (a)?
2. **Q2 (trigger).** Fire on first assistant turn-end with `title === null`. Skip retitling. OK?
3. **Q3 (model + prompt).** Haiku 4.5, 32 tokens, the prompt sketched above. OK?
4. **Q4 (transcript source).** Read via `conversations:get` — recommended. OK?

After those, I'll start at Task 1.
