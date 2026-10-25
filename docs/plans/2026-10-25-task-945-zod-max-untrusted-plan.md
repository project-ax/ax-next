# TASK-945 "Add .max() to untrusted zod arrays and records" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every untrusted list on the sandbox→host IPC, connector-write and chat-body paths gets a `.max()` sized so real traffic never reaches it. An oversized list then fails with one size issue, before zod parses a single element, on any zod version.

**Architecture:** Each limit is a named constant declared beside the schema it bounds, in the package that already owns that schema. `@ax/ipc-protocol` holds the runner↔host wire limits: turn-end blocks, chat-end messages and message blocks, and the `skill.propose` capability hint. `@ax/connectors` adds a write-only twin of its capability schema; `CapabilitiesSchema` also parses every stored row, so it stays unbounded. `@ax/channel-web` bounds the chat `shown.*` lists. One deliberate non-change is pinned by a test: `tool_result.content` stays unbounded, because stored transcripts re-parse it. `.strict()` messages were measured (Appendix B) and need no change. Stale comments and the zod patch notes that made parts of the card look true get corrected.

**Tech Stack:** zod 3.25.76 (patched: an array over `.max()` returns right after its `too_big`), vitest, TypeScript, pnpm 10.33.2.

**Spec:** The card is TASK-945 (dispatch file `/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/386b12a8-02d6-45fd-a50d-1e78eb04cac6/scratchpad/dispatch/prompt-945.txt`, lines 4-21). Read it with `.claude/memory/decisions/2026-10-25-TASK-945.md` (this plan's decisions), `.claude/memory/decisions/2026-10-23-TASK-938.md` (the "Where untrusted input meets…" and "Review minors" rows) and `patches/zod@3.25.76.md`. Numbers marked MEASURED were measured by the planner at 4718946da (darwin, node 24.19.0). The scratchpad scripts only imported the built packages and the installed patched zod, and edited nothing.

## Global Constraints

- **Worktree:** run every command in `/Users/vpulim/dev/ai/ax-next/.claude/worktrees/agent-a653aa37298839075`.
- **First commit:** this plan and `.claude/memory/decisions/2026-10-25-TASK-945.md` go in together. The shard cites the plan, so `pnpm test:scripts memory-cited-paths-exist` stays red until the plan is tracked. MEASURED: that citation is its only finding right now.
- **Single-file test runs:** `pnpm --filter @ax/<pkg> test <path-inside-package>`. The `--filter` goes before the script name, or pnpm silently runs the whole repo (CLAUDE.md).
- **Docker:** two of Task 3's tests boot Postgres (`admin-routes.test.ts`, `authored-hooks.test.ts`). Prefix those runs, and the final recursive gate, with `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`. Every other task test is Docker-free.
- **TDD:** each task writes its tests first and sees the red stated in its Step 2 before touching the schema.
- **Where limits live:** a limit is an exported constant next to its schema. There is no central limits file and no cross-plugin import: channel-web and connectors keep their own numbers, and tests import only from their own package. All runner↔host wire schemas already live in `@ax/ipc-protocol`, the as-built rule in `docs/plans/2026-05-24-current-architecture.md`.
- **Don't bound a schema that also parses stored data** (the conversations read projection, the connectors read path). Don't bound a host→runner response unless every producer sits far below the limit. Task 1's `AgentMessageSchema` is the one such case: its producers send at most 20 blocks.
- **Out of bounds:** no DB schema or version change; no `package.json`, lockfile or `patches/*.patch` change. Leave `packages/routines-contract` alone (TASK-957), and `packages/mcp-oauth`, `packages/llm-openrouter` and `packages/agent-aisdk-runner/src/tools` too (TASK-944).
- **Memory:** shards only (`scripts/memory-write-target.sh --shard <kind> TASK-945`). Never touch a root `.claude/memory/*.md` or add a `Memory-Rewrite:` trailer.
- **Voice:** these comments are about a security boundary, so keep them plain and direct, with no jokes.
- **Type-check:** `tsc` skips test files everywhere except channel-web. After Task 4, `pnpm --filter @ax/channel-web build` also type-checks the new test.

## Review Focus

These are the inputs a wrong limit would hurt, most likely first. Each one is pinned in its owning task.

1. **A real long turn must never be refused.** A refused `event.turn-end` loses that turn's whole display frame, because the runner swallows the 400. One turn-end carries a whole multi-step turn, plus one chip per file the turn created (up to 10,000). Pinned by T1 `event.turn-end takes CONTENT_BLOCKS_MAX blocks`. The value's derivation is in the constant's comment.
2. **Data stored before the limits stays readable.** A connector row over a limit must still open and list, and its owner must be able to trim it. A stored transcript with a large tool result must still load. Pinned by T3 `a connector stored over a list limit stays readable, and its owner can trim it`, T3's `the read schema still parses…` cases, and T1 `leaves tool_result.content unbounded…`.
3. **Host→runner responses keep parsing.** `AgentMessageSchema` is also the `session.next-message` payload and the `session.get-display-history` message, which the runner parses on the way in. Pinned by T1 `AgentMessageSchema … takes CONTENT_BLOCKS_MAX blocks`. The real producers send at most 20 blocks, or none.
4. **An oversized list reports exactly one size issue even inside `.strict()` objects, discriminated unions and nested lists.** Pinned by T2 (strict `SkillProposeRequestSchema`, an MCP server's own lists), T3 (OAuth `scopes` inside a strict union arm) and T4 (strict `PermissionDecisionRequest`).
5. **Connector limits apply only on the write funnels.** Pinned by T3's mutation checks: reading through the write schema reddens the legacy-row test, and writing through the read schema reddens both funnel tests.

## Card premises, checked (at 4718946da)

- **True:**
  - The patched zod caps each issue list at 100.
  - An array over `.max()` fails with only its size issue. Verified in `v3/types.js` and pinned by `scripts/__tests__/zod-issue-bound.test.js:205`. MEASURED on the real schemas: one `too_big`, at the array's path with `maximum` set, whether the elements are junk or valid, whether the list is nested, and inside a `.strict()` parent.
  - The listed paths parse unbounded arrays today: `event.turn-end` (`packages/ipc-protocol/src/events.ts:140`), `event.chat-end` (`:187`, plus `actions.ts:29`), `skill.propose` (`actions.ts:1056-1074`), the connectors `CapabilitiesSchema` (`packages/connectors/src/types.ts:142-226`) and chat `shown.*` (`packages/channel-web/src/wire/chat.ts:110-115`).
  - No DB change is needed. Routines stay at schema version 13, untouched.
- **Refuted:**
  - "Each IPC schema lives in its own plugin directory." Every runner↔host wire schema lives in `@ax/ipc-protocol`. The card's wording comes from `CLAUDE.md:163` and `.claude/skills/ax-conventions/SKILL.md:216`, which describe the founding design. Its instruction still holds: no central limits file. The wording is not edited here; it is a convention decision for a human (decisions shard).
  - "A plain union nested in a plain union … ~30,000 issues at two levels" and "nothing we parse today nests that way". MEASURED: two levels with 100 elements per list retain 1,020,200 issues, and the message is 372 MB. 30,200 holds only when the innermost list has one element. One level does reach untrusted input: `tool_result.content` (`content-blocks.ts:96`). Task 6 corrects the notes.
- **Refined:**
  - The `skill.propose` capability arrays are a deprecated hint. The host has ignored them since TASK-100 (`packages/skills/src/types.ts:570-575`), and the runner always sends empty lists (`packages/agent-runner-core/src/skill-propose-executor.ts:111-116`). They are still bounded.
  - `shown.*` is parsed but nothing on the server reads it. #978 removed the last read, so a limit there can only ever refuse.
  - The "`event.chat-end` content blocks" never come from a real runner: `chatEndHistory` is text-only. The list real use grows is `outcome.messages`, the runner's whole-life history. Both are bounded.
  - Connectors `CapabilitiesSchema` also parses every stored row. A stored row that fails it can't be opened, edited or deleted, and the agent loses every connector. So connector limits are write-only.
  - `tool_result.content` (from the dispatch inventory) stays unbounded, pinned by a test. `.strict()` stays as is. Records need nothing. Each is a decisions-shard row.

## The limits

| Constant | Value | Bounds | Declared in | Why this number |
|---|---|---|---|---|
| `CONTENT_BLOCKS_MAX` | 50,000 | `event.turn-end` `contentBlocks`; `AgentMessageSchema.contentBlocks` (so also each chat-end message) | `packages/ipc-protocol/src/content-blocks.ts` | Real traffic can't reach it. Turns have no step limit (claude-sdk), and the file chips go up to 10,000. Real blocks average well over 84 bytes, so 50,000 don't fit the 4 MiB frame. |
| `CHAT_END_MESSAGES_MAX` | 50,000 | `event.chat-end` `outcome.messages` | `packages/ipc-protocol/src/events.ts` | The whole-life history, at most one entry a second over a 6 h pod life, is far below it. |
| `SKILL_PROPOSE_CAPABILITY_LIMITS` | hosts 64, credentials 32, mcpServers 8, packages 64 per list | every `capabilityProposal` list, an MCP server's own lists included | `packages/ipc-protocol/src/actions.ts` | The same numbers as the connector write limits (the same Capabilities shape). The hint is always empty. |
| `CAPABILITY_WRITE_LIMITS` | allowedHosts 64, credentials 32, mcpServers 8, packages 64 per list, scopes 128 per OAuth slot | `CapabilitiesWriteSchema`: `connectors:upsert`, `connectors:install-authored` | `packages/connectors/src/types.ts` | 64/32/8 are the sandbox wire's per-entry limits (`packages/sandbox-protocol/src/schemas.ts:151,159,178`), so more could never reach a sandbox. Real connectors carry 1-5 packages and up to about 50 scopes. |
| `SHOWN_LIST_MAX` | 4,096 | `shown.hosts/slots/npm/pypi` on both chat routes | `packages/channel-web/src/wire/chat.ts` | The one producer unions up to 64 connectors' lists: 64 × 64. |

Unchanged on purpose: `POST /api/chat/messages` `contentBlocks` (already 20), `foldedReqIds` (64), connector-auth-failure `servers` (32), `skill.propose` `files` (16), connector `services` (8, with its own inner limits), `tool_result.content`, and records. Appendix A is the full inventory.

## Order and file ownership

| # | Task | Tier | `security-checklist` | Touches |
|---|---|---|---|---|
| 1 | Runner→host event lists | sensitive | yes (IPC) | `packages/ipc-protocol/src/{content-blocks,events,actions}.ts`, new `src/__tests__/list-limits.test.ts` |
| 2 | `skill.propose` capability hint lists | sensitive | yes (IPC) | `packages/ipc-protocol/src/actions.ts:1053-1094`, `src/__tests__/skill-propose-action.test.ts` |
| 3 | Connector capability lists, write-only | sensitive | yes (model-authored input) | `packages/connectors/src/{types,store,plugin}.ts`, new `src/__tests__/capability-limits.test.ts`, `src/__tests__/admin-routes.test.ts`, `src/__tests__/authored-hooks.test.ts` |
| 4 | Chat `shown.*` lists | sensitive | yes (browser input) | `packages/channel-web/src/wire/chat.ts`, new `src/__tests__/wire-chat-shown-limits.test.ts` |
| 5 | Stale comments | mechanical | no (comments only) | `packages/channel-web/src/server/routes-chat.ts`, `packages/chat-orchestrator/src/orchestrator.ts`, `packages/ipc-core/src/handlers/event-chat-end.ts` |
| 6 | zod patch notes | mechanical | no (docs only) | `patches/zod@3.25.76.md` |

Tasks 1 and 2 both edit `actions.ts`, so run 1 before 2. Tasks 3-6 touch disjoint files and can run in any order. One commit per task.

---

### Task 1: Runner→host event lists [tier: sensitive]

**Files:**
- Modify: `packages/ipc-protocol/src/content-blocks.ts`: add `CONTENT_BLOCKS_MAX` above `ContentBlockSchema` (`:277`)
- Modify: `packages/ipc-protocol/src/events.ts`: import (`:3`), `contentBlocks` (`:140`), `CHAT_END_MESSAGES_MAX` above `AgentOutcomeSchema` (`:184`), `messages` (`:187`)
- Modify: `packages/ipc-protocol/src/actions.ts`: import (`:3`), `AgentMessageSchema.contentBlocks` (`:29`)
- Create: `packages/ipc-protocol/src/__tests__/list-limits.test.ts`

**Interfaces:**
- Produces: `export const CONTENT_BLOCKS_MAX = 50_000` and `export const CHAT_END_MESSAGES_MAX = 50_000`, re-exported by `src/index.ts`'s `export *`.

- [ ] **Step 1: Write the failing test** `packages/ipc-protocol/src/__tests__/list-limits.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  AgentMessageSchema,
  CHAT_END_MESSAGES_MAX,
  CONTENT_BLOCKS_MAX,
  ContentBlockSchema,
  EventChatEndSchema,
  EventTurnEndSchema,
} from '../index.js';

// TASK-945. Junk elements (`0`) would each fail on their own, so a result
// holding ONLY the size issue shows the list was refused before any element
// was parsed.
const junk = (n: number): unknown[] => Array.from({ length: n }, () => 0);
const texts = (n: number): unknown[] => Array.from({ length: n }, () => ({ type: 'text', text: 'x' }));
const messages = (n: number): unknown[] => Array.from({ length: n }, () => ({ role: 'user', content: 'x' }));

function expectOnlySizeIssue(
  r: { success: boolean; error?: { issues: unknown[] } },
  path: (string | number)[],
  maximum: number,
): void {
  expect(r.success).toBe(false);
  expect(r.error?.issues).toEqual([expect.objectContaining({ code: 'too_big', type: 'array', path, maximum })]);
}
```

Test cases (`describe('runner→host list limits (TASK-945)')`):

| Test name | Input | Assertion |
|---|---|---|
| `event.turn-end takes CONTENT_BLOCKS_MAX blocks` | `EventTurnEndSchema`, `{ reason: 'complete', role: 'tool', contentBlocks: texts(CONTENT_BLOCKS_MAX) }` | `success === true` |
| `event.turn-end with one block over fails with only the size issue` | `{ reason: 'complete', contentBlocks: junk(CONTENT_BLOCKS_MAX + 1) }` | `expectOnlySizeIssue(r, ['contentBlocks'], CONTENT_BLOCKS_MAX)` |
| `event.chat-end takes CHAT_END_MESSAGES_MAX messages` | `EventChatEndSchema`, `{ outcome: { kind: 'complete', messages: messages(CHAT_END_MESSAGES_MAX) } }` | `success === true` |
| `event.chat-end with one message over fails with only the size issue` | `messages: junk(CHAT_END_MESSAGES_MAX + 1)` | `expectOnlySizeIssue(r, ['outcome', 'messages'], CHAT_END_MESSAGES_MAX)` |
| `event.chat-end takes a message with CONTENT_BLOCKS_MAX blocks and refuses one more with only the size issue` | a single message `{ role: 'assistant', content: '', contentBlocks: texts(CONTENT_BLOCKS_MAX) }`, then the same message with `junk(CONTENT_BLOCKS_MAX + 1)` | first `success === true`; second `expectOnlySizeIssue(r, ['outcome', 'messages', 0, 'contentBlocks'], CONTENT_BLOCKS_MAX)` |
| `AgentMessageSchema (also the session.next-message and session.get-display-history payloads) takes CONTENT_BLOCKS_MAX blocks and refuses one more` | `AgentMessageSchema`, `{ role: 'user', content: '', contentBlocks: texts(n) }` with `n = CONTENT_BLOCKS_MAX`, then `junk(CONTENT_BLOCKS_MAX + 1)` | `success === true`, then `expectOnlySizeIssue(r, ['contentBlocks'], CONTENT_BLOCKS_MAX)` |
| `leaves tool_result.content unbounded: stored turns re-parse with ContentBlockSchema, and the read path drops a turn that fails` | `ContentBlockSchema`, `{ type: 'tool_result', tool_use_id: 't', content: texts(CONTENT_BLOCKS_MAX + 1) }` | `success === true` |

- [ ] **Step 2: Run it and see the red**

Run: `pnpm --filter @ax/ipc-protocol test src/__tests__/list-limits.test.ts`
Expected: `Test Files 1 failed`. The four "fails with only the size issue" or "refuses one more" cases fail with `expected true to be false`: nothing refuses yet, because the constants are `undefined` until Step 3, so every array is empty. The other three pass.

- [ ] **Step 3: Add the two constants and the three `.max()` calls**

In `content-blocks.ts`, directly above `ContentBlockSchema`:

```ts
/**
 * The most content blocks one `event.turn-end`, or one `AgentMessage`, may
 * carry on the IPC wire (TASK-945). Runner data is untrusted. An array over
 * its `.max()` is refused right after its size issue, before any element is
 * parsed.
 *
 * Sized so real traffic never reaches it: a refused turn-end loses that
 * turn's whole display frame. One turn-end carries a whole multi-step turn:
 * every assistant block, or every tool result plus one chip per file the
 * turn created (up to 10,000). Real blocks average well over 84 bytes, so
 * 50,000 of them do not fit the 4 MiB frame anyway.
 *
 * Not applied to `tool_result.content`: this schema also re-parses stored
 * transcripts, and the conversations read path drops a turn that fails it.
 */
export const CONTENT_BLOCKS_MAX = 50_000;
```

In `events.ts`, directly above `AgentOutcomeSchema`:

```ts
/**
 * The most messages one `event.chat-end` outcome may carry (TASK-945). The
 * runner sends its whole life's text-only history here: every user message
 * and every recorded assistant text, up to the pod's 6 h deadline. The limit
 * sits where that history cannot reach it, because a refused chat-end loses
 * `chat:end`.
 */
export const CHAT_END_MESSAGES_MAX = 50_000;
```

Then:
- `events.ts:140` becomes `z.array(ContentBlockSchema).max(CONTENT_BLOCKS_MAX).optional()`.
- `events.ts:187` becomes `z.array(AgentMessageSchema).max(CHAT_END_MESSAGES_MAX)`.
- `actions.ts:29` becomes `z.array(ContentBlockSchema).max(CONTENT_BLOCKS_MAX).optional()`.
- Add `CONTENT_BLOCKS_MAX` to the existing `./content-blocks.js` imports in `events.ts` and `actions.ts`.
- Leave `ToolResultBlockSchema` untouched.

- [ ] **Step 4: Run it and the downstream suites**

Run: `pnpm --filter @ax/ipc-protocol test src/__tests__/list-limits.test.ts`. Expected: `7 passed`.
Then run, all Docker-free: `pnpm --filter @ax/ipc-protocol build && pnpm --filter @ax/ipc-protocol test && pnpm --filter @ax/ipc-core test && pnpm --filter @ax/agent-runner-core test`. Expected: all pass. `run-runner.test.ts` parses real runner `event.turn-end` and `event.chat-end` payloads with these schemas.

- [ ] **Step 5: Mutation check.** Delete `.max(CONTENT_BLOCKS_MAX)` at `events.ts:140`, re-run the file, and see `event.turn-end with one block over…` fail. Restore it. Do the same for `:187` and `actions.ts:29`.

- [ ] **Step 6: Commit**

```bash
git add packages/ipc-protocol/src/content-blocks.ts packages/ipc-protocol/src/events.ts packages/ipc-protocol/src/actions.ts packages/ipc-protocol/src/__tests__/list-limits.test.ts
git commit -m "[TASK-945] Bound turn-end blocks, chat-end messages and message blocks on the IPC wire"
```

### Task 2: `skill.propose` capability hint lists [tier: sensitive]

**Files:**
- Modify: `packages/ipc-protocol/src/actions.ts:1053-1094`
- Test: `packages/ipc-protocol/src/__tests__/skill-propose-action.test.ts` (it already defines `emptyCaps` and `validReq`)

**Interfaces:**
- Produces: `export const SKILL_PROPOSE_CAPABILITY_LIMITS = { allowedHosts: 64, credentials: 32, mcpServers: 8, packages: 64 } as const`.

- [ ] **Step 1: Write the failing test.** Add `describe('capabilityProposal list limits (TASK-945)')` with a local `expectOnlySizeIssue` (Task 1's shape) and this case table. Each row is `[label, path, limit, valid element, build(items) → capabilityProposal]`. `mcp` is `{ name: 'srv', transport: 'http', url: 'https://mcp.example.com', allowedHosts: [], credentials: [] }` and `slot` is `{ slot: 'API_KEY', kind: 'api-key' }`.

| Label | Path | Limit | Valid element | `capabilityProposal` |
|---|---|---|---|---|
| `allowedHosts` | `['capabilityProposal', 'allowedHosts']` | `allowedHosts` | `'api.example.com'` | `{ ...emptyCaps, allowedHosts: items }` |
| `credentials` | `['capabilityProposal', 'credentials']` | `credentials` | `slot` | `{ ...emptyCaps, credentials: items }` |
| `mcpServers` | `['capabilityProposal', 'mcpServers']` | `mcpServers` | `mcp` | `{ ...emptyCaps, mcpServers: items }` |
| `an MCP server's allowedHosts` | `['capabilityProposal', 'mcpServers', 0, 'allowedHosts']` | `allowedHosts` | `'mcp.example.com'` | `{ ...emptyCaps, mcpServers: [{ ...mcp, allowedHosts: items }] }` |
| `an MCP server's credentials` | `['capabilityProposal', 'mcpServers', 0, 'credentials']` | `credentials` | `slot` | `{ ...emptyCaps, mcpServers: [{ ...mcp, credentials: items }] }` |
| `packages.npm` | `['capabilityProposal', 'packages', 'npm']` | `packages` | `'left-pad'` | `{ ...emptyCaps, packages: { npm: items, pypi: [] } }` |
| `packages.pypi` | `['capabilityProposal', 'packages', 'pypi']` | `packages` | `'requests'` | `{ ...emptyCaps, packages: { npm: [], pypi: items } }` |

  - `it.each(CASES)('%s: takes the limit')`: `SkillProposeRequestSchema.safeParse({ ...validReq, capabilityProposal: build(limit copies of valid) }).success === true`.
  - `it.each(CASES)('%s: one over fails with only the size issue')`: `build(limit + 1 junk 0s)`, then `expectOnlySizeIssue(r, path, limit)`. The request object is `.strict()`; the result must still hold exactly one issue.

- [ ] **Step 2: Run it.** `pnpm --filter @ax/ipc-protocol test src/__tests__/skill-propose-action.test.ts`. Expected: the file fails at collection with `TypeError: Cannot read properties of undefined (reading 'allowedHosts')`. The constant doesn't exist until Step 3, so the case table can't build. That is the red.

- [ ] **Step 3: Add the limits.** Above `SkillProposeSlotSchema` (`:1053`):

```ts
/**
 * Per-list limits on the `capabilityProposal` hint (TASK-945). The host has
 * ignored the hint since TASK-100 and the runner sends empty lists, so these
 * only refuse garbage. They match @ax/connectors' write limits for the same
 * Capabilities shape: 64 hosts, 32 credential slots and 8 MCP servers (the
 * sandbox wire's per-skill limits), and 64 packages per npm/pypi list. An MCP
 * server's own hosts and slots use the same numbers.
 */
export const SKILL_PROPOSE_CAPABILITY_LIMITS = { allowedHosts: 64, credentials: 32, mcpServers: 8, packages: 64 } as const;
```

  Add `.max(…)` to all seven arrays: `SkillProposeMcpSchema.allowedHosts`/`.credentials` and `SkillProposeCapabilitiesSchema.allowedHosts`/`.credentials`/`.mcpServers`/`packages.npm`/`packages.pypi`. Then replace the stale comment at `:1088-1089` ("The gate classifies on this …"); the gate keys only on origin and scan (`packages/skills/src/propose-gate.ts`):

```ts
    // A DEPRECATED, ignored hint (TASK-100): a skill declares no capabilities,
    // the runner sends empty lists, and the host gate keys only on origin and
    // the safety scan. Kept on the wire for schema stability, and bounded.
```

- [ ] **Step 4: Run.** `pnpm --filter @ax/ipc-protocol test && pnpm --filter @ax/ipc-core test` (Docker-free; includes `skill-propose-handler.test.ts`). Expected: all pass.
- [ ] **Step 5: Mutation check.** Remove the `mcpServers` `.max()`. `mcpServers: one over…` fails. Restore it.
- [ ] **Step 6: Commit.** `git add packages/ipc-protocol/src/actions.ts packages/ipc-protocol/src/__tests__/skill-propose-action.test.ts` then `git commit -m "[TASK-945] Bound the skill.propose capability hint lists"`.

### Task 3: Connector capability lists, write-only [tier: sensitive]

**Files:**
- Modify: `packages/connectors/src/types.ts:122-226`, where the capability schemas become one factory
- Modify: `packages/connectors/src/store.ts:4` (import) and `:127-166` (`validateCapabilities`)
- Modify: `packages/connectors/src/plugin.ts:20` (import), `:662` (upsert) and `:1146-1148` (`assembleProposal`)
- Create: `packages/connectors/src/__tests__/capability-limits.test.ts` (Docker-free)
- Modify: `packages/connectors/src/__tests__/admin-routes.test.ts` and `packages/connectors/src/__tests__/authored-hooks.test.ts` (Postgres)

**Interfaces:**
- Produces, in `types.ts`:
  - `export const CAPABILITY_WRITE_LIMITS = { allowedHosts: 64, credentials: 32, mcpServers: 8, packages: 64, scopes: 128 } as const`
  - `export const CapabilitiesWriteSchema: ZodType<Capabilities>`
  - `CapabilitiesSchema` keeps its name, export and exact behaviour.
- Produces, in `store.ts`: `export function validateCapabilitiesForWrite(value: unknown): Capabilities`. `validateCapabilities` keeps its signature and stays the read path's check.

- [ ] **Step 1: Write the failing Docker-free test** `capability-limits.test.ts`. Import `CAPABILITY_WRITE_LIMITS as L`, `CapabilitiesSchema` and `CapabilitiesWriteSchema` from `../types.js`, `validateCapabilities` and `validateCapabilitiesForWrite` from `../store.js`, and `PluginError` from `@ax/core`. Use the same `expectOnlySizeIssue` helper. `base()` returns `{ allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } }`, and `server` is `{ name: 'srv', transport: 'http', url: 'https://mcp.example.com', allowedHosts: [], credentials: [] }`.

| Label | Path | Limit | Valid element | Spec |
|---|---|---|---|---|
| `allowedHosts` | `['allowedHosts']` | `L.allowedHosts` | `'api.example.com'` | `{ ...base(), allowedHosts: items }` |
| `credentials` | `['credentials']` | `L.credentials` | `{ slot: 'API_KEY', kind: 'api-key' }` | `{ ...base(), credentials: items }` |
| `mcpServers` | `['mcpServers']` | `L.mcpServers` | `server` | `{ ...base(), mcpServers: items }` |
| `an MCP server's allowedHosts` | `['mcpServers', 0, 'allowedHosts']` | `L.allowedHosts` | `'mcp.example.com'` | `{ ...base(), mcpServers: [{ ...server, allowedHosts: items }] }` |
| `an MCP server's credentials` | `['mcpServers', 0, 'credentials']` | `L.credentials` | `{ slot: 'API_KEY', kind: 'api-key' }` | `{ ...base(), mcpServers: [{ ...server, credentials: items }] }` |
| `packages.npm` | `['packages', 'npm']` | `L.packages` | `'left-pad'` | `{ ...base(), packages: { npm: items, pypi: [] } }` |
| `packages.pypi` | `['packages', 'pypi']` | `L.packages` | `'requests'` | `{ ...base(), packages: { npm: [], pypi: items } }` |
| `an OAuth slot's scopes` | `['credentials', 0, 'scopes']` | `L.scopes` | `'read'` | `{ ...base(), mcpServers: [server], credentials: [{ slot: 'TOKEN', kind: 'oauth', server: 'srv', scopes: items }] }` |

  - `it.each(CASES)('%s: the write schema takes the limit')`: `CapabilitiesWriteSchema.safeParse(spec of limit valid elements).success === true`.
  - `it.each(CASES)('%s: one over fails the write schema with only the size issue')`: `limit + 1` junk `0`s, then `expectOnlySizeIssue(r, path, limit)`. The scopes row proves a strict object inside a discriminated-union arm adds nothing.
  - `it.each(CASES)('%s: the read schema still parses a stored spec over the limit')`: `CapabilitiesSchema.safeParse(spec of limit + 1 valid elements).success === true`. This is the pair that keeps stored rows readable (TASK-712's rule).
  - `it('validateCapabilitiesForWrite refuses an over-limit spec with invalid-payload, and validateCapabilities (read) returns it')`: with `spec = { ...base(), allowedHosts: L.allowedHosts + 1 copies of 'api.example.com' }`, the write call throws a `PluginError` whose `code` is `'invalid-payload'`, and `validateCapabilities(spec).allowedHosts` has length `L.allowedHosts + 1`.

- [ ] **Step 2: Write the failing funnel tests** (Postgres). Size every list from `CAPABILITY_WRITE_LIMITS.allowedHosts` (imported from `../types.js`), using distinct hosts `h${i}.example.com`:
  - In `authored-hooks.test.ts`, next to `rejects a malformed credential slot (untrusted-input defense, I5)`, add `refuses a proposal over a list limit, and files one at the limit (TASK-945)`. `installInput({ hosts: limit + 1 hosts })` `.rejects.toThrow(PluginError)`. Then `installInput({ hosts: limit hosts })` resolves `{ connectorId: 'linear', status: 'pending' }`.
  - In `admin-routes.test.ts`, after the TASK-712 describe, add `describe('capability list limits apply on write only (TASK-945)')` with `it('a connector stored over a list limit stays readable, and its owner can trim it')`. Mirror `a row stored BEFORE this check stays readable, and its owner can fix it` (`:2119`; same harness, `createConnectorStore(db).upsert` seed, `currentActor`). Seed `allowedHosts` of `limit + 1` hosts under owner `legacy-945`. Then:
    - `show` → 200 and `list` → 200;
    - `update` with `{ name: 'renamed' }` → 400 (a re-save would re-store the over-limit list);
    - `update` with `{ capabilities: { allowedHosts: limit hosts, credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } } }` → 200.

- [ ] **Step 3: Run both and see the red.**
  - `pnpm --filter @ax/connectors test src/__tests__/capability-limits.test.ts`. Expected: the file fails to load (`CapabilitiesWriteSchema`/`CAPABILITY_WRITE_LIMITS` don't exist yet).
  - `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/connectors test src/__tests__/authored-hooks.test.ts src/__tests__/admin-routes.test.ts -t "TASK-945"`. Expected: the two new cases fail (`Cannot read properties of undefined (reading 'allowedHosts')`).
  - After Step 4 only, they fail on behaviour instead: the 400 comes back as a 200, and the over-limit install files a draft. That is the gap Step 6 closes.

- [ ] **Step 4: One factory, two schemas** (`types.ts`). Keep `ApiKeySlotSchema`, `HealthcheckSchema` and `ServiceDescriptorSchema` where they are; they carry no list to bound. Move `OAuthSlotSchema`, `CapabilitySlotSchema`, `McpServerSpecSchema` and `PackagesSpecSchema` into the factory, unchanged except that each list goes through `list()`. Keep their comments.

```ts
/**
 * TASK-945: the most entries each capability list may carry on WRITE
 * (`connectors:upsert`, `connectors:install-authored`). Never applied on
 * read: CapabilitiesSchema also parses every stored row, and a row that fails
 * it can't be opened, edited or deleted (the TASK-712 rule).
 *
 * 64 hosts, 32 credential slots and 8 MCP servers are the sandbox wire's own
 * per-entry limits (@ax/sandbox-protocol InstalledSkillSchema). A connector
 * becomes one entry, so a bigger list could never reach a sandbox. An MCP
 * server's own hosts and slots use the same numbers. Packages (per npm/pypi
 * list) and OAuth scopes (per slot) have no downstream limit; real connectors
 * carry 1-5 packages and request up to about 50 scopes.
 */
export const CAPABILITY_WRITE_LIMITS = { allowedHosts: 64, credentials: 32, mcpServers: 8, packages: 64, scopes: 128 } as const;

/** `z.array(item)`, bounded by `max` when a write limit applies. */
function list<T extends z.ZodTypeAny>(item: T, max: number | undefined): z.ZodArray<T> {
  return max === undefined ? z.array(item) : z.array(item).max(max);
}

function makeCapabilitiesSchema(limits: Partial<typeof CAPABILITY_WRITE_LIMITS>): ZodType<Capabilities> {
  // OAuthSlotSchema (scopes: list(z.string(), limits.scopes).optional()),
  // CapabilitySlotSchema, McpServerSpecSchema (allowedHosts, credentials) and
  // PackagesSpecSchema (npm, pypi) live here, each list through list().
  // `services` keeps its existing `.max(8).default([])`.
}

/** Reads and return schemas: never bounded, so every stored row parses. */
export const CapabilitiesSchema = makeCapabilitiesSchema({});
/** The write funnels only: the same shape, every untrusted list bounded. */
export const CapabilitiesWriteSchema = makeCapabilitiesSchema(CAPABILITY_WRITE_LIMITS);
```

  Keep the existing `as unknown as ZodType<Capabilities>` cast inside the factory. In the doc block above it (`:122-134`), replace the stale "`capabilities-schema.test.ts` is the drift guard" (that file is gone) with "`oauth-slot.test.ts` round-trips real specs through it, and `capability-limits.test.ts` pins the read/write pair". Add one sentence pointing at `CAPABILITY_WRITE_LIMITS` for the write-only limits.

- [ ] **Step 5: Split the check** (`store.ts`). Move the body of `validateCapabilities` into `function checkCapabilities(schema: ZodType<Capabilities>, value: unknown): Capabilities`, changing only `CapabilitiesSchema.safeParse` to `schema.safeParse`. Then:
  - `validateCapabilities(value)` returns `checkCapabilities(CapabilitiesSchema, value)`.
  - Add `validateCapabilitiesForWrite(value)`, which returns `checkCapabilities(CapabilitiesWriteSchema, value)`.
  - Rewrite the doc comment: `validateCapabilities` is the read path's check (rows, the boot sweeps) and is never bounded; the write funnels call `validateCapabilitiesForWrite`.

- [ ] **Step 6: Use it on both write funnels** (`plugin.ts`). `:662` becomes `const capabilities = validateCapabilitiesForWrite(input.capabilities);`. In `assembleProposal`, `:1148` becomes `return validateCapabilitiesForWrite({…})`; update its comment (`:1146-1147`) to say "bounded". Swap the import at `:20`. `validateCapabilities` has no other use in `plugin.ts`; `non-admin-sweep.ts:149` and `store.ts` rows keep it.

- [ ] **Step 7: Run all three files.**
  - `pnpm --filter @ax/connectors test src/__tests__/capability-limits.test.ts`. Expected: `25 passed` (3 × 8 + 1).
  - `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/connectors test src/__tests__/authored-hooks.test.ts src/__tests__/admin-routes.test.ts`. Expected: all pass.

- [ ] **Step 8: Mutation checks**, each reverted after:
  - `:662` back to `validateCapabilities` → the admin `renamed` case returns 200 and fails.
  - `:1148` back → the authored over-limit case files a draft and fails.
  - `validateCapabilities` pointed at `CapabilitiesWriteSchema` → `show`/`list` 400 and the read-schema pair cases fail.

- [ ] **Step 9: Full package + build.** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/connectors test && pnpm --filter @ax/connectors build`. Expected: pass.
- [ ] **Step 10: Commit.** `git add packages/connectors/src/types.ts packages/connectors/src/store.ts packages/connectors/src/plugin.ts packages/connectors/src/__tests__/capability-limits.test.ts packages/connectors/src/__tests__/admin-routes.test.ts packages/connectors/src/__tests__/authored-hooks.test.ts` then `git commit -m "[TASK-945] Bound connector capability lists on write; stored rows stay readable"`.

### Task 4: Chat `shown.*` lists [tier: sensitive]

**Files:**
- Modify: `packages/channel-web/src/wire/chat.ts:103-115` (comment and `ShownCapsSchema`), `:126`, `:141-149`, `:154` (stale comments)
- Create: `packages/channel-web/src/__tests__/wire-chat-shown-limits.test.ts`

**Interfaces:**
- Produces: `export const SHOWN_LIST_MAX = 4_096` in `wire/chat.ts`.

- [ ] **Step 1: Write the failing test.** Import `ApproveAuthoredSkillRequest`, `PermissionDecisionRequest` and `SHOWN_LIST_MAX` from `../wire/chat.js`, and use the same `expectOnlySizeIssue`. Loop over `[['permission-decision', PermissionDecisionRequest, { conversationId: 'c1', skillId: 's1' }], ['approve-authored-skill', ApproveAuthoredSkillRequest, { agentId: 'a1', skillId: 's1' }]]` × `['hosts', 'slots', 'npm', 'pypi']`, with `empty = { hosts: [], slots: [], npm: [], pypi: [] }`:
  - `'%s: shown.%s takes SHOWN_LIST_MAX entries'`: `{ ...base, shown: { ...empty, [list]: SHOWN_LIST_MAX × 'x' } }` gives `success === true`.
  - `'%s: shown.%s one over fails with only the size issue'`: `SHOWN_LIST_MAX + 1` junk `0`s, then `expectOnlySizeIssue(r, ['shown', list], SHOWN_LIST_MAX)`. `PermissionDecisionRequest` is `.strict()`; the result must still be one issue.
- [ ] **Step 2: Run.** `pnpm --filter @ax/channel-web test src/__tests__/wire-chat-shown-limits.test.ts`. Expected: the 8 "one over" cases fail (`SHOWN_LIST_MAX` is `undefined`, so the arrays are empty and parse).
- [ ] **Step 3: Add the limit and fix the comments.** Above `ShownCapsSchema`, replacing the stale "FIX 1 (TOCTOU guard) … intersects …" block (`:103-109`):

```ts
// `shown` carries what the card displayed. It stays on the wire for older
// clients, but no server code reads it: since TASK-100 a skill declares no
// capabilities, so the authored grant only flips the draft to active. Each
// list is bounded so an oversized body fails on its size alone.

/**
 * The most entries each `shown` list may carry (TASK-945). Its one producer
 * (GrantRow) sends the de-duplicated union of up to 64 referenced
 * connectors' lists, and connectors store at most 64 hosts, 32 slots and 64
 * packages per list, so 4,096 is the most a real card shows.
 */
export const SHOWN_LIST_MAX = 4_096;
```

  - `ShownCapsSchema`'s four fields become `z.array(z.string()).max(SHOWN_LIST_MAX)`.
  - `:126` field doc becomes `/** What the card displayed. Forwarded unread (see ShownCapsSchema). */`.
  - In the approve-authored-skill block, "it writes the approval rows + flips the skill active" (`:143`) becomes "it flips the skill active".
  - `:148-149` becomes "`shown` is the same optional, unread field as on permission-decision."
  - `:154` field doc becomes `/** What the panel displayed. Forwarded unread (see ShownCapsSchema). */`.
- [ ] **Step 4: Run.** The file gives `16 passed`. Then `pnpm --filter @ax/channel-web build`; expected clean, since channel-web's `tsc` includes tests.
- [ ] **Step 5: Mutation check.** Drop `.max` on `hosts`. Both `shown.hosts one over…` cases fail. Restore it.
- [ ] **Step 6: Commit.** `git add packages/channel-web/src/wire/chat.ts packages/channel-web/src/__tests__/wire-chat-shown-limits.test.ts` then `git commit -m "[TASK-945] Bound the chat shown.* lists; say that the server does not read them"`.

### Task 5: Stale comments that misdescribe these paths [tier: mechanical]

Comment-only. Each line below says something the code no longer does, and would mislead the reviewer of this card.

**Files and exact replacements:**
- `packages/channel-web/src/server/routes-chat.ts`
  - `:222-224` becomes: "`shown?` mirrors what the client card displayed. It is forwarded unread: since TASK-100 a skill declares no capabilities, so the grant only flips the authored draft to active and has nothing to intersect."
  - `:813` "`shown` is optional; present on authored-skill cards (FIX 1)." becomes "`shown` is optional and forwarded unread (see ApplyAuthoredGrantInput)."
  - `:888-889` becomes: "Forward `shown` (optional) for wire compatibility; the grant does not read it (see ApplyAuthoredGrantInput)."
  - `:954` "`shown` is the same TOCTOU guard as the card." becomes "`shown` is forwarded unread, as on the card route."
  - `:587-590` becomes: "5) Mint reqId (J9 — server-side only). The schema doesn't carry a reqId field on the request body, and `PostMessageRequest` is not `.strict()`, so zod drops an injected one before we see it (we never read reqId from the body regardless)."
- `packages/chat-orchestrator/src/orchestrator.ts`
  - `:293-303` (the "FIX 1 (TOCTOU guard)" paragraph) becomes: "`shown?` is what the card displayed. Since TASK-100 a skill declares no capabilities, so this grant only flips the authored draft to active and never reads `shown`. The field stays on the input so the channel-web routes keep their wire shape."
  - `:318` becomes `/** What the card displayed. Unread: see the note above. */`.
- `packages/ipc-core/src/handlers/event-chat-end.ts:11-14` becomes: "Fire-and-forget. `chat:end` subscribers read this payload: the orchestrator hands `outcome` to a waiting `agent:invoke`, memory extracts facts from `outcome.messages`, and usage-limits reads `outcome.kind`. Nothing persists `outcome.messages` (audit-log subscribes only to `event.http-egress`). The wire shape is `{ outcome: AgentOutcome }` and the hook fires with the same key name, matching chat-loop.ts."

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** `git diff --stat` shows only these three files. `git diff` shows only comment lines.
- [ ] **Step 3:** `pnpm --filter @ax/channel-web build && pnpm --filter @ax/chat-orchestrator build && pnpm --filter @ax/ipc-core build`. Expected: clean.
- [ ] **Step 4: Commit.** `git add packages/channel-web/src/server/routes-chat.ts packages/chat-orchestrator/src/orchestrator.ts packages/ipc-core/src/handlers/event-chat-end.ts` then `git commit -m "[TASK-945] Correct comments: shown is unread, PostMessageRequest strips, audit-log does not read chat:end"`.

### Task 6: zod patch notes [tier: mechanical]

**File:** `patches/zod@3.25.76.md`. Exact replacement text follows; the numbers are MEASURED (decisions shard).

- [ ] **Step 1:** Replace lines 69-73 (the "When to remove it" paragraph) with:

```markdown
Remove the patch once no package uses zod 3 and nothing resolves `zod/v4` from
it. Remove its `patchedDependencies` entry, the audit exception and the
exception-specific assertions with it. Moving to zod 4 alone does not bring the
cap with it. The explicit `.max()` limits on our untrusted lists (TASK-945)
replace the cap only for the lists they sit on. A list nested inside another
list's elements, like `tool_result.content` inside a turn's content blocks, is
then bounded only by the 4 MiB frame. Bound those another way before removing
the patch, or carry an equivalent one.
```

- [ ] **Step 2:** Replace the bullet at lines 80-86 with:

```markdown
- The cap is per issue list, not per parse. A plain `z.union` gives each option
  its own list and keeps every option's list when they all fail, so unions
  nested inside collections multiply the bound. One level of that reaches
  untrusted input: `tool_result.content` (a string or an array) inside every
  content-block list (`event.turn-end`, `event.chat-end`,
  `POST /api/chat/messages`). At that one level we measured 10,200 retained
  issues and a 3.2 MB `error.message` for a 25 KB turn-end (ipc-core echoes
  that message to the runner that sent it), and about 0.5 s of CPU for a
  4 MiB frame whose junk is spread over 16,000 blocks. A second level
  multiplies it again: about 1,000,000 issues and a 370 MB message from 2 MB
  of input, with 100 elements per list. Don't add a second level of
  plain-union nesting on untrusted input.
```

- [ ] **Step 3: Commit.** `git add patches/zod@3.25.76.md` then `git commit -m "[TASK-945] zod patch notes: the one nested union we parse, measured; .max() does not bound nested lists"`.

---

## Card acceptance → tests

| Card acceptance | Evidence |
|---|---|
| A `.max()` on each listed untrusted array, sized for real use, each value recorded | T1-T4; "The limits" table; decisions shard |
| For each changed schema, one over the limit fails with the size issue only | T1 (4 cases), T2 (7), T3 (8), T4 (8): `expectOnlySizeIssue`, junk elements, exactly one `too_big` |
| …and one at the limit passes | T1 (4 cases), T2 (7), T3 (8 + the read-schema pair), T4 (8) |
| The `.strict()` question checked; capped or summarised if it matters | Measured and left as is (decisions shard; Appendix B). Strict parents covered by T2 and T4's one-issue assertions |
| `security-checklist` | T1-T4; note drafted under Before the PR |
| IPC schemas not centralised | Each constant beside its schema; no new shared file (Global Constraints) |
| Gate, then lint | Before the PR |

## Before the PR

- **Gates (CLAUDE.md):** `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm build && DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
  - Expected: no existing test changes outcome.
  - If one does, it was sending more than a limit. Read it before touching the limit. A real producer above a limit means the limit is wrong: stop and report, don't raise it blindly.
  - Docker start-slot timeouts are not this change. Re-run those packages one at a time and report both runs.
- **Boundary review** (for the PR body; this tightens existing contracts and adds no field):
  - *Surface change:* `event.turn-end`, `event.chat-end` and the `skill.propose` request refuse oversized lists. So do the `session.next-message` and `session.get-display-history` responses, through the shared `AgentMessageSchema`. `connectors:upsert` and `connectors:install-authored` refuse oversized capability lists. Return schemas are unchanged.
  - *Alternate impl:* any runner (claude-sdk, aisdk, a later one) emits these events under the same limits. A second connectors backend would apply the same write limits.
  - *Leaky field names:* none. No field is added or renamed, and the constant names are domain words.
  - *Subscriber risk:* `chat:turn-end` and `chat:end` subscribers now receive at most 50,000 blocks or messages. None relies on more.
  - *Wire surface:* the schemas stay where they live. Runner↔host shapes are in `@ax/ipc-protocol` (where every IPC action lives), chat bodies in channel-web's `wire/chat.ts`, connector capabilities in `@ax/connectors`' `types.ts`.
- **Security note** (from `security-checklist`, run on T1-T4):
  - Sandbox: no capability is added or widened. The change narrows what a sandbox (`event.turn-end`, `event.chat-end`, `skill.propose`), a model (`connector_propose`), a connector writer (`connectors:upsert`) or a signed-in browser (`shown.*`) can make the host parse. No filesystem, network, process, env or handle reach changes.
  - Injection: the untrusted strings still flow to the same places. An oversized list is now refused before its elements are parsed. What reaches a client is unchanged in kind: ipc-core echoes zod's message to the sending runner only and does not log it; channel-web returns a fixed `invalid-payload`; `connector_propose` returns fixed text.
  - Supply chain: N/A. No `package.json`, lockfile or patch change.
- **Version skew:**
  - An old runner and a new host is the supported direction. It is safe: real runners stay far below every limit and always send an empty capability hint.
  - A new runner and an old host is looser on the host. The runner's inbound parse of `AgentMessageSchema` is tighter, but the host sends at most 20 blocks.
  - A connector stored over a limit stays readable, and its next save must trim it. The same goes for a pending authored draft over a limit, which an admin approves through `connectors:upsert`. Such a connector could never reach a sandbox anyway.
- **Residuals** (measured; the decisions shard has the numbers):
  - `tool_result.content`'s nested union, at most per 4 MiB frame: 10,200 retained issues, a 3.2 MB echoed message, and about 0.5 s of CPU when the junk is spread over 16,000 blocks.
  - `.strict()` messages grow 2.3-2.8× the extra keys' bytes, within the byte caps.
  - The admin-only agents `credentialBindings` record is out of this card's scope (64 KiB body; Appendix A).
- **Follow-up cards to file:**
  1. ipc-core: echo a bounded zod summary (first issue plus a count) instead of the full `error.message`.
  2. zod patch: skip `unionErrors` construction once a list is full (the 0.5 s case).
  3. `@ax/decisions`: cap a held call's stored `call_json` (stored verbatim, up to 4 MiB).
  4. Reconcile `CLAUDE.md:163` and the ax-conventions wire-surface sentence with the as-built `@ax/ipc-protocol` (a human call).
- **PR body:**
  - what changed;
  - the limits table and Appendix A;
  - premises refuted and refined;
  - boundary review and security note;
  - residuals and follow-ups;
  - test evidence: each task's red, then green, and the mutation checks.

---

## Appendix A: inventory (untrusted input meeting a zod collection, at 4718946da)

| Path | Collection | Schema | Before | After |
|---|---|---|---|---|
| IPC `event.turn-end` (sandbox→host, 4 MiB) | `contentBlocks` | `ipc-protocol/src/events.ts:140` | none | 50,000 |
| | `contentBlocks[].tool_result.content` (array arm of a plain union) | `content-blocks.ts:96-99` | none | none (stored-read path; pinned) |
| | `contentBlocks[].tool_use.input` (record of `unknown`) | `content-blocks.ts:63` | — | none (no entry can fail) |
| | `foldedReqIds` | `events.ts:176` | 64 | unchanged |
| IPC `event.chat-end` | `outcome.messages` | `events.ts:187` | none | 50,000 |
| | `outcome.messages[].contentBlocks` | `actions.ts:29` (shared `AgentMessageSchema`) | none | 50,000 |
| IPC `skill.propose` | `capabilityProposal` `allowedHosts`, `credentials`, `mcpServers`, `mcpServers[].allowedHosts`, `mcpServers[].credentials`, `packages.npm`, `packages.pypi` | `actions.ts:1056-1074` | none | 64, 32, 8, 64, 32, 64, 64 |
| | `files` | `actions.ts:1085-1087` | 16 | unchanged |
| IPC `event.connector-auth-failure` | `servers` | `events.ts` | 32 | unchanged |
| IPC `event.stream-chunk` | tool-use `input` (record of `unknown`) | `events.ts:48` | — | none |
| IPC `tool.execute-host` → `connector_propose` → `connectors:install-authored` (model) | capability lists, OAuth `scopes` | `connectors/src/types.ts:142-226` via `assembleProposal` | none | write-only 64 / 32 / 8 / 64 / 32 / 64 / 64 / 128 |
| `connectors:upsert` (admin and owner routes, 64 KiB; the authored approve path) | the same | the same | none | the same, write-only; reads unbounded |
| | `services` (admin only; never sent by `connector_propose`) | `types.ts:203-228` | 8 (ports 16, env 32 by refine, writablePaths 16, healthcheck command 16) | unchanged |
| `POST /api/chat/messages` (browser, 1 MiB) | `contentBlocks` | `channel-web/src/wire/chat.ts:69-75` | 20 | unchanged |
| | nested `tool_result.content`, `tool_use.input` | shared `ContentBlockSchema` | none | none (as above) |
| `POST /api/chat/permission-decision` (`.strict()`) | `shown.hosts/slots/npm/pypi` | `wire/chat.ts:110-115` | none | 4,096 each |
| `POST /api/chat/approve-authored-skill` (no UI caller) | the same `shown` | the same | none | 4,096 each |
| Out of scope | agents `credentialBindings` record (`/admin/agents/:id/skill-attachments`, 64 KiB, keys and values checked per entry); remote MCP / OAuth / OpenRouter / AI-SDK `callTool` responses (TASK-944); better-auth (zod 4.6.7); webhooks (`JSON.parse` only) | | | |

## Appendix B: measurements (MEASURED at 4718946da, patched zod 3.25.76, node 24.19.0)

| Input | Result |
|---|---|
| `event.turn-end`, 2,000,000 junk blocks (4 MB), unbounded | 100 issues, 19 KB message, 117 ms |
| the same with `.max(50_000)` | 1 issue (`too_big`), 0.2 ms |
| 50,000 valid text blocks / 50,000 junk at the limit | success in 21 ms / 100 issues in 7 ms |
| `event.chat-end`, 50,000 valid messages / 2,000,000 junk with the limit | success in 23 ms / 1 issue in 0.0 ms |
| One `tool_result` with 1,600,000 junk content items | 1 issue (`invalid_union`, 101 nested), 32 KB message, 104 ms |
| Junk spread: 16,000 `tool_result` × 100 junk items (4 MB) | 100 issues holding 10,100 nested (10,200 retained), 489 ms (valid frame of similar size: 36 ms) |
| 100 `tool_result` × 100 junk (25 KB) | 3.2 MB `error.message` (126× the input) |
| Plain unions in collections, 100 per list: one level / two levels | 10,200 retained issues, 2.6 MB message / 1,020,200 issues, 372 MB message, 385 ms |
| `.strict()` `skill.propose` + 1,000 / 100,000 / 500,000 extra keys | 22 KB / 2.58 MB / 13.8 MB message (2.3-2.4× the input) |
| `.strict()` connector-auth-failure, 32 entries × 10,000 extra keys | 7.6 MB message from 3.2 MB (2.4×) |
| `tool_use.input` record with 600,000 keys (7 MB) | success, 230 ms |
