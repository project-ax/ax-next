# Phase 4 Implementation Plan — `chat:run` → `agent:invoke` rename (kernel + IPC + all consumers)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish the `Chat*` → `Agent*` mechanical rename across the kernel, the IPC wire schema, the chat-orchestrator, the test-harness, and every consumer. The hook string itself (`agent:invoke`) and the kernel context types (`AgentContext`, `AgentOutcome`, `makeAgentContext`) are already in place from earlier phases — what's left is the message type (`ChatMessage` → `AgentMessage`), the IPC Zod constants (`ChatMessageSchema` → `AgentMessageSchema`, `ChatOutcomeSchema` → `AgentOutcomeSchema`), the orchestrator's input type (`ChatRunInput` → `AgentInvokeInput`), and a handful of internal method/variable names plus the README.

**Architecture:**

- Hard-cut rename, no aliasing layer. (Phase 3 lesson I12 carries over: "Don't reshape speculatively. When you DO reshape, do it cleanly.") `ChatMessage` does not become `type ChatMessage = AgentMessage` — it's deleted; every consumer updates in the same PR.
- `AgentMessage` lives in `@ax/core` as the canonical message type. Per design Section 5: `{ role: 'user' | 'assistant', content: string }` — narrowed from today's `ChatMessageText` 3-role shape (open question §1, resolved below: keep 3 roles for Phase 4; narrow in Phase 7 when `LlmRequest`/`LlmResponse` die).
- `@ax/ipc-protocol` renames the Zod schema constants in lockstep. The on-wire JSON shape doesn't change (still `{ role, content }`), only the TypeScript symbols. Both sides of the IPC bridge (host + sandbox) are in this monorepo, so the rename is atomic across the wire.
- `@ax/chat-orchestrator` keeps its package name and `PLUGIN_NAME` (design Section 6 lists it under "Shrinks", not "Renames"). The internal `ChatRunInput` interface and `runChat()` method rename for symmetry with the registered `agent:invoke` hook. `chat:end`, `chat:turn-end`, `chat:start` hooks are NOT renamed — they're emitted by the runner / subscribed by audit-log + conversations and are out of scope per design Section 5.
- `@ax/agent-native-runner` is slated for Phase 6 deletion but still ships and is exercised by `pnpm test`. We rename inside it to keep the build green; Phase 6 deletes it whole.
- README example code currently shows `chat:run`, `makeChatContext`, `ChatContext`, `ChatOutcome` — all stale. Updated in lockstep.

**Tech Stack:**

- TypeScript / Node 20+
- Vitest (`.test.ts` per package)
- Zod (IPC schemas in `@ax/ipc-protocol`)
- pnpm workspace + `pnpm build` / `pnpm test --filter` for per-package verification

**Out-of-scope (deferred):**

- `ChatMessage` shape narrowing to 2 roles (drop `'system'`). Design Section 5 says `AgentMessage = { role: 'user' | 'assistant', content: string }`. Today's `ChatMessageText` is `'user' | 'assistant' | 'system'`. The `'system'` role is used by `LlmRequest.messages` (a `system` prompt prepended before user turns) and shows up in `packages/ipc-core/src/__tests__/dispatcher.test.ts:204`. **Phase 4 keeps the 3-role union** to keep this purely mechanical. Phase 7 (kernel cleanup) deletes `LlmRequest`/`LlmResponse` and the `system`-role test along with them — narrow `AgentMessage` to 2 roles in that PR. Open question §1 below.
- Renaming hooks other than the registered service. `chat:end`, `chat:turn-end`, `chat:start` are NOT renamed. They are emitted by the runner / subscribed by orchestrator + audit-log + conversations. Design Section 5 only lists `chat:run` for renaming.
- Renaming the package `@ax/chat-orchestrator` → `@ax/agent-orchestrator`. Design Section 6 puts the plugin under "Shrinks" not "Renames"; package-rename churn (changesets, lockfile, every internal import path) isn't earned by Phase 4. Defer until Phase 5 shrinks the orchestrator to ~80 LOC if it earns weight then.
- Phase 5's actual orchestrator shrink. Phase 4 is rename-only — the ~250-line `runChat` body stays as-is, only its surface symbols rename.
- Web-chat / `channel-web` HTTP route shape changes. The local `interface ChatRunInput` redeclaration in `routes-chat.ts:188` renames in lockstep but the HTTP request/response JSON over the WebSocket doesn't change.

---

## Reality check — what's already done vs. what remains

A pre-execution `rg` survey confirmed the rename is partially complete. Phase 4 is smaller than the design doc implies because earlier phases shipped pieces of the rename incidentally:

| Identifier | Target | State today | Phase 4 work |
|---|---|---|---|
| `chat:run` (hook string) | `agent:invoke` | ✅ Already registered as `agent:invoke` (`packages/chat-orchestrator/src/plugin.ts:83`) | README references only |
| `ChatContext` (type) | `AgentContext` | ✅ Already `AgentContext` in `@ax/core` (`packages/core/src/context.ts:87`) | README references only |
| `ChatOutcome` (type) | `AgentOutcome` | ✅ Already `AgentOutcome` in `@ax/core` (`packages/core/src/types.ts:49`) | README references only |
| `makeChatContext` (fn) | `makeAgentContext` | ✅ Already `makeAgentContext` (`packages/core/src/context.ts:118`) | README references only |
| `registerChatLoop` (fn) | (deleted) | ✅ Already deleted from kernel | README + a stale comment in `cli/main.ts` only |
| **`ChatMessage` (type, kernel)** | **`AgentMessage`** | ❌ Live, ~65 occurrences across 22 files | **PRIMARY rename target** |
| **`ChatMessageText` (interface)** | (folded into `AgentMessage`) | ❌ Live, only in `packages/core/src/types.ts` | **Delete; replace with `AgentMessage` interface** |
| **`ChatMessageSchema` (Zod)** | **`AgentMessageSchema`** | ❌ Live, in `@ax/ipc-protocol` + tests + 4 internal references | **PRIMARY rename target (IPC wire surface)** |
| **`ChatMessage` (type, ipc-protocol)** | **`AgentMessage`** | ❌ Live, `z.infer` from the schema | **PRIMARY rename target** |
| **`ChatOutcomeSchema` (Zod)** | **`AgentOutcomeSchema`** | ❌ Live, in `@ax/ipc-protocol` (3 internal references) | **PRIMARY rename target (IPC wire surface)** |
| **`ChatRunInput` (interface)** | **`AgentInvokeInput`** | ❌ Live in `@ax/chat-orchestrator` + a redeclaration in `@ax/channel-web` | **Rename for symmetry with `agent:invoke`** |
| `runChat()` (method) | `runAgentInvoke()` | ❌ Live in orchestrator (5 internal refs) + plugin.ts:85 | Rename for symmetry |
| `chat:end` / `chat:turn-end` / `chat:start` (hooks) | (kept) | ✅ Kept as-is | NOT renamed — design Section 5 only lists `chat:run` |
| `@ax/chat-orchestrator` (package name) | (kept) | ✅ Kept as-is | NOT renamed — see out-of-scope above |
| `onChatEnd()` / `onTurnEnd()` (orchestrator methods) | (kept) | ✅ Kept as-is — they correspond to the kept `chat:end` / `chat:turn-end` hooks | NOT renamed |

**Net Phase 4 scope:** 4 type/symbol renames + ~5 internal method/variable renames + README updates. ~22 files touched, mostly mechanical.

---

## Reference material

ax-next files this plan touches (read before editing):

| File | Lines | Why |
|---|---|---|
| `packages/core/src/types.ts` | 3-7, 22, 27, 50 | `ChatMessageText` interface + `ChatMessage` alias + uses in `LlmRequest.messages`, `LlmResponse.assistantMessage`, `AgentOutcome.messages`. Replaces the alias-of-an-interface with a single `AgentMessage` interface. |
| `packages/ipc-protocol/src/actions.ts` | 20, 24, 67, 76, 340 | `ChatMessageSchema` definition + `ChatMessage` type alias + 3 references inside `LlmCallRequest`/`LlmCallResponse` + the inbox `user-message` payload schema. |
| `packages/ipc-protocol/src/events.ts` | 2, 70, 73, 81, 84 | `ChatOutcomeSchema` definition + `AgentOutcome` re-export from the schema + use in the `chat:end` event payload. |
| `packages/ipc-protocol/src/__tests__/schemas.test.ts` | 19, 567-568 | Test imports `ChatMessageSchema` + a "rejects unknown role" assertion. |
| `packages/chat-orchestrator/src/orchestrator.ts` | 1, 71-72, 91, 333, 387, 390, 1046, 1049 | `ChatRunInput` interface, `runChat` method, internal references. |
| `packages/chat-orchestrator/src/index.ts` | 2 | Re-exports `ChatRunInput`. |
| `packages/chat-orchestrator/src/plugin.ts` | 6, 82, 85 | Imports + `bus.registerService<ChatRunInput, AgentOutcome>(...)` + `orch.runChat(...)`. |
| `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` | 8, 65, 85, 99, 169, 392, 449 | Tests reference `ChatMessage`. |
| `packages/chat-orchestrator/src/__tests__/route-by-conversation.test.ts` | 6, 53, 89 | Tests reference `ChatMessage`. |
| `packages/channel-web/src/server/routes-chat.ts` | 7, 188-189, 340-368 | Local `interface ChatRunInput` redeclaration + variable name `runChatCtx`. |
| `packages/agent-claude-sdk-runner/src/main.ts` | 16, 199-202 | `ChatMessage` import + `chatEndHistory: ChatMessage[]`. |
| `packages/agent-runner-core/src/inbox-loop.ts` | 1, 29, 57 | `ChatMessage` from `@ax/ipc-protocol`. |
| `packages/agent-native-runner/src/turn-loop.ts` | 9, 94-95, 102, 117, 199, 225 | Heavy use of `ChatMessage`. (Slated for Phase 6 deletion; rename to keep build green.) |
| `packages/agent-native-runner/src/main.ts` | 10, 120 | Same. |
| `packages/agent-native-runner/src/__tests__/turn-loop.test.ts` | 11, 165, 198, 221, 286, 355, 383 | Tests; same. |
| `packages/llm-anthropic/src/plugin.ts` | 7, 193 | `ChatMessage` import + assistantMessage construction. (Phase 6 deletion target.) |
| `packages/llm-proxy-anthropic-format/src/translate-request.ts` | 1, 34, 37, 81 | `ChatMessage` from `@ax/ipc-protocol`. (Phase 6 deletion target — rename keeps build green.) |
| `packages/session-inmemory/src/types.ts` | 1, 52, 56 | `ChatMessage` in inbox types. |
| `packages/session-inmemory/src/plugin.ts` | 191, 194 | Error message + comment. |
| `packages/session-inmemory/src/__tests__/inbox.test.ts` | 2, 8 | Test helper. |
| `packages/session-postgres/src/inbox.ts` | 3, 44, 58, 62, 403, 441 | `ChatMessage` in inbox types + JSONB payload comments. |
| `packages/session-postgres/src/plugin.ts` | 307 | Error message. |
| `packages/session-postgres/src/migrations.ts` | 131 | Comment only. |
| `packages/session-postgres/src/__tests__/inbox-corruption.test.ts` | 12, 83 | Comments only. |
| `packages/cli/src/commands/serve.ts` | 28, 367 | `ChatMessage` import + construction. |
| `packages/cli/src/__tests__/serve.test.ts` | 5, 40 | `bus.registerService<{ message: ChatMessage }, AgentOutcome>(...)`. |
| `packages/cli/src/main.ts` | 199 (comment) | Stale `registerChatLoop` comment. |
| `packages/ipc-core/src/__tests__/dispatcher.test.ts` | 8, 204 | Imports `ChatMessage` + uses `'system'` role (the role we are NOT narrowing in Phase 4 — out-of-scope §1). |
| `packages/test-harness/src/harness.ts` | 56 | One stale comment ("Week 1-2 `withChatLoop` option is GONE"). The file's actual code already uses `makeAgentContext`/`AgentContext`. |
| `README.md` | 11, 67-68, 78-92 | Stale references to `chat:run`, `makeChatContext`, `ChatContext`, `ChatOutcome`, `registerChatLoop`. |

**Reference patterns already in the codebase:**

- Hard-cut rename precedent: Phase 3 reshape of `credentials:get` (atomic across `@ax/credentials`, `@ax/credentials-store-db`, `@ax/credential-proxy`, `@ax/mcp-client` in one PR — see `docs/plans/2026-04-29-phase-3-pr-notes.md` Task 2-5).
- Boundary-review template: `docs/plans/2026-04-29-phase-3-pr-notes.md` § "Boundary review — `credentials:get/set/delete` reshape".
- Per-package test invocation: `pnpm test --filter @ax/<package>`.

---

## Invariants (verified per task)

These reflect Phase 3's atomic-reshape lesson + Phase 1b's "defer reshapes until consumers force them" + Phase 4's rename-specific pitfalls.

- **I1 — Hard cut, no aliasing layer.** [Phase 3 I12 carry-over.] `ChatMessage` does NOT become `type ChatMessage = AgentMessage`. Every consumer updates in the same PR. *Prevents:* the "soft migration" anti-pattern where the alias persists for "just one more PR" and ends up the canonical name forever. Phase 1b (memory: `project_phase_1b_shipped.md`) already paid this lesson once with `credentials:get`'s deferred reshape — don't pay it again.
- **I2 — All consumers update atomically.** [Phase 3 I12.] `pnpm build` must pass at the end of a single commit. No partial-rename commits that leave the workspace in a build-broken state for more than one task boundary. *Prevents:* mid-rename breakage that wedges other developers' branches and costs review time tracking down which symbol broke where. Use a feature branch + commit per logical group of files (kernel, ipc-protocol, orchestrator, runners, sessions, cli, tests, README).
- **I3 — IPC wire schema rename gets a boundary review.** [Phase 3 I3-I4 carry-over.] `ChatMessageSchema` and `ChatOutcomeSchema` are on the IPC wire (host ↔ sandbox dispatch). Even though both sides are monorepo-internal, the schema is a structural seam. The PR description records: alternate impl this schema could have, payload field names that might leak, subscriber risk, wire surface. (Spoiler: the on-wire JSON `{role, content}` doesn't change; only the TypeScript symbol does. So the boundary review is short — but it has to exist.) *Prevents:* the "we renamed it because we could" trap where a Zod symbol rename quietly broadens the schema or drops a field.
- **I4 — `AgentMessage` keeps the existing on-wire JSON shape.** Same `{ role, content }` keys, same role union (`'user' | 'assistant' | 'system'` for Phase 4 — see open question §1 below). Zero on-wire changes. *Prevents:* a "rename + redesign" mash-up that smuggles a payload-shape change into a mechanical rename.
- **I5 — Hooks not in the design's rename list stay.** `chat:end`, `chat:turn-end`, `chat:start` keep their names. Their orchestrator-side handler methods (`onChatEnd`, `onTurnEnd`) keep their names. *Prevents:* over-zealous rename — design Section 5 explicitly lists `chat:run` and only `chat:run`; renaming `chat:end` would force every audit-log/conversations subscriber to update for zero design-stated benefit.
- **I6 — Test-harness public API doesn't break.** `@ax/test-harness`'s entry already uses `makeAgentContext`/`AgentContext` (verified by survey). Its `harness.ts:56` comment about the "Week 1-2 `withChatLoop` option is GONE" updates for accuracy but no exported symbol changes. *Prevents:* breaking downstream test files (the test harness is the most-imported module across the workspace's test suites).
- **I7 — `agent-native-runner` and `llm-*` packages still build.** [Phase 6 deletion target preview.] These three packages are scheduled for deletion in Phase 6 but are alive and tested today. Phase 4 renames inside them so `pnpm build` + `pnpm test` stay green. *Prevents:* the temptation to "leave them broken since they're getting deleted soon" — half-built packages mask real regressions in the trunk.
- **I8 — `@ax/chat-orchestrator` package name and `PLUGIN_NAME` stay.** The package directory, `package.json` `"name"`, `PLUGIN_NAME` constant, and every cross-package import path stay untouched. *Prevents:* a Phase 4 → Phase 5 churn cascade where every preset's plugin-load list gets touched twice (once for the package rename, once for the Phase 5 shrink). Defer the package rename to Phase 5 if it earns weight there.
- **I9 — README and docs match the new names.** Stale code blocks in `README.md` (showing `chat:run`, `makeChatContext`) and the dead `registerChatLoop` reference get updated in the same PR. *Prevents:* the "code says X, README says Y" drift Phase 3 PR notes flagged for credentials operator docs (kept fresh in the PR notes, not the README — but README is now visibly stale).
- **I10 — `runChat()` and `ChatRunInput` rename is internal-only.** Renaming an in-process method/interface inside `@ax/chat-orchestrator` doesn't change any hook surface, IPC schema, or external API. The boundary-review fields are: alternate impl (none — internal only), leaky names (none — already provider-neutral), subscriber risk (none — these aren't on the bus), wire surface (none — internal type). *Prevents:* a misclassification that adds boundary-review weight to what's actually a local refactor.
- **I11 — No half-wired window opens.** [Phase 3 half-wired pattern.] Phase 4 introduces no new plugin, no new hook, no new bus surface. Either the rename lands clean across all consumers (build + test green) or the PR doesn't merge. *Prevents:* "we renamed half the consumers, the rest in a follow-up" — there's no follow-up that ships before this lands.

---

## Open questions resolved before execution

1. **Does `AgentMessage` narrow to 2 roles (`'user' | 'assistant'`) per design Section 5, or keep the 3 roles `ChatMessageText` has today?** **Keep 3 roles for Phase 4.** Today's `'system'` role is used by `LlmRequest.messages` (system prompts prepended before user turns) and by `packages/ipc-core/src/__tests__/dispatcher.test.ts:204`. `LlmRequest`/`LlmResponse` are scheduled for Phase 7 deletion — narrow `AgentMessage` to 2 roles in that PR. Phase 4 stays purely mechanical: replace the symbol, don't touch the union. (I4: same on-wire shape.)
2. **Does `ChatRunInput` rename to `AgentInvokeInput`?** **Yes.** The registered hook is `agent:invoke`; its input type should match. The interface is internal to `@ax/chat-orchestrator` (re-exported, but only consumed by the plugin's own `init()` and the channel-web local redeclaration), so the cost is small. Same atomic-rename discipline applies (I2).
3. **Does `runChat()` (the method) rename to `runAgentInvoke()`?** **Yes.** The method body implements the `agent:invoke` hook; the symmetry helps readers. Five internal references in `orchestrator.ts` + one in `plugin.ts:85`. Local refactor only (I10).
4. **What about `@ax/chat-orchestrator`'s package name?** **Stays.** Renaming the package would touch every preset's plugin-load list, every test that imports from `@ax/chat-orchestrator`, the changesets entry, and the lockfile — all for a cosmetic change. Defer to Phase 5 if the orchestrator-shrink earns it.
5. **Do `chat:end` / `chat:turn-end` / `chat:start` hooks rename?** **No.** Design Section 5 lists only `chat:run`. The `chat:end` subscribers (`@ax/chat-orchestrator`, `@ax/audit-log`, `@ax/conversations`) and `chat:turn-end` subscribers (`@ax/chat-orchestrator`'s OAuth rotation seam from Phase 3) all stay. (I5.)
6. **Does the IPC wire JSON shape change?** **No.** `{ role, content }` over the wire is unchanged. Only TypeScript symbols rename. (I4.)
7. **Does `agent-native-runner` get renamed inside even though Phase 6 deletes it?** **Yes — rename inside.** Otherwise `pnpm build` breaks; a half-broken package masks real regressions. Phase 6 deletes it whole. (I7.)
8. **Do we delete `ChatMessageText` (the interface, not the alias)?** **Yes — fold into `AgentMessage`.** Today it's `interface ChatMessageText { role; content }` + `type ChatMessage = ChatMessageText`. Replace the pair with a single `interface AgentMessage { role; content }`. No external consumer references `ChatMessageText` directly (only the `ChatMessage` alias is imported), so the indirection earns nothing.
9. **Do we update the stale comment in `packages/cli/src/main.ts:199`?** **Yes.** It references `'registerChatLoop'` (a function that no longer exists) — update or delete the comment in the same commit that touches CLI.
10. **What's the commit cadence?** One commit per logical group: (a) `@ax/core`, (b) `@ax/ipc-protocol`, (c) `@ax/chat-orchestrator` (interface + method), (d) sessions (`session-inmemory` + `session-postgres`), (e) runners (`agent-runner-core` + `agent-native-runner` + `agent-claude-sdk-runner`), (f) `llm-*` (Phase 6 deletion targets), (g) `@ax/cli` + `@ax/channel-web`, (h) `@ax/test-harness` comment + README. Each commit must leave `pnpm build` green where possible; if a commit must temporarily red-build (e.g., kernel rename before consumers update), the next commit closes the gap and verification runs at task boundaries that bracket the gap.

---

## Tasks

### Task 1: Survey + commit pre-state (no code)

**Goal:** Baseline confirmation that the survey in this plan matches reality at execution time. (Phase 1b memory: `feedback_check_plan_vs_reality.md` — when a plan's stated assumption is out of date, flag the deviation, don't blindly follow.)

**Files:**
- Read-only: `packages/core/src/types.ts`, `packages/ipc-protocol/src/actions.ts`, `packages/ipc-protocol/src/events.ts`, `packages/chat-orchestrator/src/orchestrator.ts`

**Step 1.1: Run the survey**

```bash
pnpm build  # confirm clean baseline
rg -n 'ChatMessage\b' --no-heading -g '!node_modules' -g '!dist' -g '!.git' | wc -l
rg -n "'chat:run'|\"chat:run\"" --no-heading -g '!node_modules' -g '!dist' -g '!.git'
rg -n 'ChatMessageSchema|ChatOutcomeSchema|ChatRunInput|runChat\b' --no-heading -g '!node_modules' -g '!dist' -g '!.git' | wc -l
```

**Step 1.2: Confirm baseline matches plan**

Expected: `ChatMessage` count ≈ 65 (the plan's number). `chat:run` literal: only README.md. `ChatMessageSchema`/`ChatOutcomeSchema`/`ChatRunInput`/`runChat`: ~25 hits across orchestrator + ipc-protocol + plugin + tests + channel-web.

If the counts have drifted significantly (e.g., another phase landed a partial rename), STOP and flag the deviation before continuing — adjust the plan rather than executing against stale assumptions.

**Step 1.3: No commit** — this is a read-only verification step.

---

### Task 2: Add `AgentMessage` interface to `@ax/core` (red commit)

**Goal:** Introduce the new symbol; remove the old symbol; downstream builds break. Tasks 3–10 fix them.

**Files:**
- Modify: `packages/core/src/types.ts`

**Step 2.1: Write the failing test**

Test file: `packages/core/src/__tests__/types.test.ts` (create if absent — there may not be a kernel-types test today; if so, add one for this rename).

```ts
import type { AgentMessage, AgentOutcome } from '../index.js';

it('AgentMessage has the expected shape', () => {
  const m: AgentMessage = { role: 'user', content: 'hi' };
  expect(m.role).toBe('user');
});

it('AgentOutcome.complete carries AgentMessage[]', () => {
  const o: AgentOutcome = {
    kind: 'complete',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
  };
  expect(o.kind).toBe('complete');
});
```

Run: `pnpm --filter @ax/core test`
Expected: FAIL — `AgentMessage` not exported.

**Step 2.2: Replace the type definitions**

In `packages/core/src/types.ts`, replace lines 3-7:

```ts
export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
```

(Keeps the 3-role union per open question §1. Delete `ChatMessageText` and `ChatMessage` entirely — no alias.)

In the same file, update the references on lines 22, 27, 50: replace each `ChatMessage` → `AgentMessage`.

**Step 2.3: Run kernel tests**

```bash
pnpm --filter @ax/core build
pnpm --filter @ax/core test
```

Expected: `@ax/core` is clean. Downstream packages will fail their build at later tasks; that's intentional.

**Step 2.4: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/__tests__/types.test.ts
git commit -m "refactor(core): rename ChatMessage → AgentMessage [Phase 4]"
```

---

### Task 3: Rename `ChatMessageSchema` → `AgentMessageSchema` and `ChatOutcomeSchema` → `AgentOutcomeSchema` in `@ax/ipc-protocol`

**Goal:** Update the IPC wire schemas + their inferred types in lockstep. The on-wire JSON shape doesn't change — only TypeScript symbols.

**Files:**
- Modify: `packages/ipc-protocol/src/actions.ts:20, 24, 67, 76, 340`
- Modify: `packages/ipc-protocol/src/events.ts:2, 70, 73, 81, 84`
- Modify: `packages/ipc-protocol/src/__tests__/schemas.test.ts:19, 567-568`

**Step 3.1: Write the failing test**

In `packages/ipc-protocol/src/__tests__/schemas.test.ts`, add an assertion that `AgentMessageSchema` exports under the new name:

```ts
import { AgentMessageSchema, AgentOutcomeSchema } from '../index.js';

it('AgentMessageSchema parses a valid message', () => {
  expect(AgentMessageSchema.safeParse({ role: 'user', content: 'hi' }).success).toBe(true);
});

it('AgentOutcomeSchema parses a complete outcome', () => {
  expect(
    AgentOutcomeSchema.safeParse({
      kind: 'complete',
      messages: [{ role: 'user', content: 'hi' }],
    }).success,
  ).toBe(true);
});
```

Run: `pnpm --filter @ax/ipc-protocol test`
Expected: FAIL — symbols not exported.

**Step 3.2: Rename in `actions.ts`**

- Line 20: `export const ChatMessageSchema = z.object({...})` → `export const AgentMessageSchema = z.object({...})`
- Line 24: `export type ChatMessage = z.infer<typeof ChatMessageSchema>` → `export type AgentMessage = z.infer<typeof AgentMessageSchema>`
- Lines 67, 76, 340: replace each `ChatMessageSchema` → `AgentMessageSchema`

**Step 3.3: Rename in `events.ts`**

- Line 2: `import { ChatMessageSchema, ToolCallSchema } from './actions.js';` → `import { AgentMessageSchema, ToolCallSchema } from './actions.js';`
- Line 70: `export const ChatOutcomeSchema = z.discriminatedUnion(...)` → `export const AgentOutcomeSchema = z.discriminatedUnion(...)`
- Line 73: `messages: z.array(ChatMessageSchema)` → `messages: z.array(AgentMessageSchema)`
- Line 81: `export type AgentOutcome = z.infer<typeof ChatOutcomeSchema>` → `export type AgentOutcome = z.infer<typeof AgentOutcomeSchema>`
- Line 84: `outcome: ChatOutcomeSchema,` → `outcome: AgentOutcomeSchema,`

**Step 3.4: Update existing tests in `schemas.test.ts`**

- Line 19: `import { ChatMessageSchema, ... }` → `import { AgentMessageSchema, ... }`
- Lines 567-568: `it('ChatMessageSchema rejects unknown role', () => { const r = ChatMessageSchema.safeParse(...)` → `AgentMessageSchema`

**Step 3.5: Run + commit**

```bash
pnpm --filter @ax/ipc-protocol build
pnpm --filter @ax/ipc-protocol test
git add packages/ipc-protocol
git commit -m "refactor(ipc-protocol): rename ChatMessageSchema/ChatOutcomeSchema → Agent* [Phase 4]"
```

Expected: `@ax/ipc-protocol` is clean. Build will still be red across consumers — Tasks 4–10 fix.

---

### Task 4: Rename in `@ax/chat-orchestrator` (`ChatRunInput` → `AgentInvokeInput`, `runChat` → `runAgentInvoke`, plus `ChatMessage` references)

**Goal:** Internal symbol updates in the orchestrator package. `PLUGIN_NAME` and the registered hook string `agent:invoke` are unchanged.

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts:1, 71-72, 91, 333, 387, 390, 1046, 1049`
- Modify: `packages/chat-orchestrator/src/index.ts:2`
- Modify: `packages/chat-orchestrator/src/plugin.ts:6, 82, 85`
- Modify: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`
- Modify: `packages/chat-orchestrator/src/__tests__/route-by-conversation.test.ts`

**Step 4.1: `orchestrator.ts` edits**

- Line 1: `import { PluginError, type AgentContext, type ChatMessage, type AgentOutcome, type HookBus } from '@ax/core';` → `... type AgentMessage ...`
- Line 71-72: `export interface ChatRunInput { message: ChatMessage; ... }` → `export interface AgentInvokeInput { message: AgentMessage; ... }`
- Line 91: `| { type: 'user-message'; payload: ChatMessage; reqId: string }` → `... payload: AgentMessage ...`
- Line 333: `runChat(ctx: AgentContext, input: ChatRunInput): Promise<AgentOutcome>;` → `runAgentInvoke(ctx: AgentContext, input: AgentInvokeInput): Promise<AgentOutcome>;`
- Line 387: comment `// the runChat finally that fires proxy:close-session.` → `// the runAgentInvoke finally that fires proxy:close-session.`
- Line 390: `async function runChat(` → `async function runAgentInvoke(`
- Line 1046: `return { runChat, onChatEnd, onTurnEnd };` → `return { runAgentInvoke, onChatEnd, onTurnEnd };` (note: `onChatEnd` / `onTurnEnd` stay — they correspond to the kept `chat:end` / `chat:turn-end` hooks per I5.)
- Line 1049: comment `// the runChat finally block` → `// the runAgentInvoke finally block`

**Step 4.2: `index.ts` edit**

- Line 2: `export type { ChatOrchestratorConfig, ChatRunInput } from './orchestrator.js';` → `export type { ChatOrchestratorConfig, AgentInvokeInput } from './orchestrator.js';`

**Step 4.3: `plugin.ts` edits**

- Line 6: `type ChatRunInput,` → `type AgentInvokeInput,`
- Line 82: `bus.registerService<ChatRunInput, AgentOutcome>(` → `bus.registerService<AgentInvokeInput, AgentOutcome>(`
- Line 85: `async (ctx, input) => orch.runChat(ctx, input),` → `async (ctx, input) => orch.runAgentInvoke(ctx, input),`

**Step 4.4: Test file updates**

- `orchestrator.test.ts` lines 8, 65, 85, 99, 392: replace `ChatMessage` → `AgentMessage`. Line 169 / 449: leave `chat:start` / `chat:end` references as-is (I5).
- `route-by-conversation.test.ts` lines 6, 53, 89: replace `ChatMessage` → `AgentMessage`.

**Step 4.5: Run + commit**

```bash
pnpm --filter @ax/chat-orchestrator build
pnpm --filter @ax/chat-orchestrator test
git add packages/chat-orchestrator
git commit -m "refactor(chat-orchestrator): rename ChatRunInput→AgentInvokeInput, runChat→runAgentInvoke [Phase 4]"
```

Expected: orchestrator package green; build still red across runners + sessions.

---

### Task 5: Update session plugins (`@ax/session-inmemory`, `@ax/session-postgres`)

**Goal:** Replace `ChatMessage` references in the inbox types + comments + error strings.

**Files:**
- Modify: `packages/session-inmemory/src/types.ts:1, 52, 56`
- Modify: `packages/session-inmemory/src/plugin.ts:191, 194`
- Modify: `packages/session-inmemory/src/__tests__/inbox.test.ts:2, 8`
- Modify: `packages/session-postgres/src/inbox.ts:3, 44, 58, 62, 403, 441`
- Modify: `packages/session-postgres/src/plugin.ts:307`
- Modify: `packages/session-postgres/src/migrations.ts:131`
- Modify: `packages/session-postgres/src/__tests__/inbox-corruption.test.ts:12, 83`

**Step 5.1: `session-inmemory/types.ts`**

- Line 1: `import type { ChatMessage } from '@ax/core';` → `import type { AgentMessage } from '@ax/core';`
- Lines 52, 56: replace `ChatMessage` → `AgentMessage` in the inbox payload union.

**Step 5.2: `session-inmemory/plugin.ts`**

- Line 191: error string `'entry.payload' must be a ChatMessage` → `'entry.payload' must be an AgentMessage`
- Line 194: comment `// Enforce the ChatMessage role enum at runtime` → `// Enforce the AgentMessage role enum at runtime`

**Step 5.3: `session-inmemory/__tests__/inbox.test.ts`**

- Line 2: `import type { ChatMessage } from '@ax/core';` → `import type { AgentMessage } from '@ax/core';`
- Line 8: helper signature `payload: ChatMessage` → `payload: AgentMessage`

**Step 5.4: `session-postgres/inbox.ts`**

- Line 3: `import { PluginError, type ChatMessage } from '@ax/core';` → `import { PluginError, type AgentMessage } from '@ax/core';`
- Lines 44, 58, 62, 403, 441: replace each `ChatMessage` → `AgentMessage` in payload types + comments.

**Step 5.5: `session-postgres/plugin.ts`**

- Line 307: error string `'entry.payload' must be a ChatMessage` → `'entry.payload' must be an AgentMessage`

**Step 5.6: `session-postgres/migrations.ts`**

- Line 131: comment-only update.

**Step 5.7: `session-postgres/__tests__/inbox-corruption.test.ts`**

- Lines 12, 83: comment-only updates referencing the historical `ChatMessage` shape. (These document the pre-Task-6 schema — keep the historical reference accurate by saying "the pre-Task-6 ChatMessage shape, now AgentMessage" or similar.) Plan author's call: simplest is to rename the in-comment symbol to `AgentMessage` since the runtime shape didn't change.

**Step 5.8: Run + commit**

```bash
pnpm --filter @ax/session-inmemory build && pnpm --filter @ax/session-inmemory test
pnpm --filter @ax/session-postgres build && pnpm --filter @ax/session-postgres test
git add packages/session-inmemory packages/session-postgres
git commit -m "refactor(sessions): rename ChatMessage → AgentMessage [Phase 4]"
```

---

### Task 6: Update runner packages (`@ax/agent-runner-core`, `@ax/agent-native-runner`, `@ax/agent-claude-sdk-runner`)

**Goal:** Same rename across the three runner packages. `agent-native-runner` is a Phase 6 deletion target but still in the build (I7).

**Files:**
- Modify: `packages/agent-runner-core/src/inbox-loop.ts:1, 29, 57`
- Modify: `packages/agent-native-runner/src/turn-loop.ts:9, 94-95, 102, 117, 199, 225`
- Modify: `packages/agent-native-runner/src/main.ts:10, 120`
- Modify: `packages/agent-native-runner/src/__tests__/turn-loop.test.ts:11, 165, 198, 221, 286, 355, 383`
- Modify: `packages/agent-claude-sdk-runner/src/main.ts:16, 199-202`

**Step 6.1: Mechanical rename across each file**

Replace every `ChatMessage` → `AgentMessage`. Update import statements, type annotations, and (in `agent-claude-sdk-runner/src/main.ts:199`) the comment that mentions `ChatMessage`.

**Step 6.2: Run + commit**

```bash
pnpm --filter @ax/agent-runner-core build && pnpm --filter @ax/agent-runner-core test
pnpm --filter @ax/agent-native-runner build && pnpm --filter @ax/agent-native-runner test
pnpm --filter @ax/agent-claude-sdk-runner build && pnpm --filter @ax/agent-claude-sdk-runner test
git add packages/agent-runner-core packages/agent-native-runner packages/agent-claude-sdk-runner
git commit -m "refactor(runners): rename ChatMessage → AgentMessage [Phase 4]"
```

---

### Task 7: Update LLM packages (`@ax/llm-anthropic`, `@ax/llm-proxy-anthropic-format`)

**Goal:** Phase 6 deletion targets. Rename inside to keep build green per I7.

**Files:**
- Modify: `packages/llm-anthropic/src/plugin.ts:7, 193`
- Modify: `packages/llm-proxy-anthropic-format/src/translate-request.ts:1, 34, 37, 81`

**Step 7.1: Mechanical rename**

Each `ChatMessage` → `AgentMessage`. `translate-request.ts:37` has a comment ("Flatten to a single `system` ChatMessage") — update to `AgentMessage`.

**Step 7.2: Run + commit**

```bash
pnpm --filter @ax/llm-anthropic build && pnpm --filter @ax/llm-anthropic test
pnpm --filter @ax/llm-proxy-anthropic-format build && pnpm --filter @ax/llm-proxy-anthropic-format test
git add packages/llm-anthropic packages/llm-proxy-anthropic-format
git commit -m "refactor(llm-*): rename ChatMessage → AgentMessage [Phase 4]"
```

---

### Task 8: Update CLI + channel-web

**Goal:** CLI commands + channel-web HTTP routes. `channel-web` has a local `interface ChatRunInput` redeclaration that renames in lockstep.

**Files:**
- Modify: `packages/cli/src/commands/serve.ts:28, 367`
- Modify: `packages/cli/src/__tests__/serve.test.ts:5, 40`
- Modify: `packages/cli/src/main.ts:199` (stale comment about `registerChatLoop`)
- Modify: `packages/channel-web/src/server/routes-chat.ts:7, 188-189, 340, 357, 366-368`

**Step 8.1: `cli/commands/serve.ts`**

- Line 28: `type ChatMessage,` → `type AgentMessage,`
- Line 367: `const chatMessage: ChatMessage = { role: 'user', content: message };` → `const chatMessage: AgentMessage = { role: 'user', content: message };` (the local variable name `chatMessage` can stay — it's not a renamed identifier in this scope, just a value-name)

**Step 8.2: `cli/__tests__/serve.test.ts`**

- Line 5: `type ChatMessage,` → `type AgentMessage,`
- Line 40: `bus.registerService<{ message: ChatMessage }, AgentOutcome>(` → `bus.registerService<{ message: AgentMessage }, AgentOutcome>(`

**Step 8.3: `cli/main.ts:199` comment cleanup**

The current comment says `// in-process 'registerChatLoop' — 'agent:invoke' is now registered by @ax/chat-orchestrator`. This is stale — `registerChatLoop` no longer exists in the kernel. Delete or shorten to `// 'agent:invoke' is registered by @ax/chat-orchestrator`.

**Step 8.4: `channel-web/server/routes-chat.ts`**

- Line 7: `type ChatMessage,` → `type AgentMessage,`
- Line 188-189: `interface ChatRunInput { message: ChatMessage; ... }` → `interface AgentInvokeInput { message: AgentMessage; ... }` (this is a local redeclaration; the canonical interface is in `@ax/chat-orchestrator`. Plan author may consider importing from there instead — but that adds a cross-plugin import which I2-of-the-architecture (no cross-plugin imports) might frown on. Keep it as a local redeclaration; just rename.)
- Line 340: variable `runChatCtx` → can stay (local scope) or rename to `agentInvokeCtx` for symmetry. Plan author preference. Default: rename for consistency with the rest of the rename.
- Line 357, 366-368: `runChatCtx.logger.warn(...)` etc. update if line 340's variable was renamed; otherwise leave.
- Line 366: `.call<ChatRunInput, unknown>('agent:invoke', runChatCtx, { message })` → `.call<AgentInvokeInput, unknown>('agent:invoke', runChatCtx, { message })`

**Step 8.5: Run + commit**

```bash
pnpm --filter @ax/cli build && pnpm --filter @ax/cli test
pnpm --filter @ax/channel-web build && pnpm --filter @ax/channel-web test
git add packages/cli packages/channel-web
git commit -m "refactor(cli, channel-web): rename ChatMessage→AgentMessage, ChatRunInput→AgentInvokeInput [Phase 4]"
```

---

### Task 9: Update `@ax/ipc-core` test (the `'system'`-role usage)

**Goal:** Last `ChatMessage` reference in the workspace.

**Files:**
- Modify: `packages/ipc-core/src/__tests__/dispatcher.test.ts:8, 204`

**Step 9.1: Rename**

- Line 8: `ChatMessage,` import → `AgentMessage,`
- Line 204: `{ role: 'system', content: 'be brief' } as ChatMessage` → `{ role: 'system', content: 'be brief' } as AgentMessage`

(The `'system'` role usage is preserved — open question §1: we keep 3 roles in Phase 4. Phase 7 will narrow.)

**Step 9.2: Run + commit**

```bash
pnpm --filter @ax/ipc-core build && pnpm --filter @ax/ipc-core test
git add packages/ipc-core
git commit -m "refactor(ipc-core): rename ChatMessage → AgentMessage in tests [Phase 4]"
```

---

### Task 10: Update `@ax/test-harness` comment

**Goal:** The harness already uses `AgentContext`/`makeAgentContext`. Only stale-comment cleanup.

**Files:**
- Modify: `packages/test-harness/src/harness.ts:56`

**Step 10.1: Comment cleanup**

Current line 56: `// The Week 1-2 \`withChatLoop\` option is GONE — agent:invoke is no longer a`

Update to reflect Phase 4 reality (the option was already gone before Phase 4, but the comment can drop the "is no longer a" hanging fragment if appropriate). Plan author judgment — minimal change is to leave the historical context intact since it's accurate.

**Step 10.2: Verify no other `Chat*` references remain in test-harness**

```bash
rg -n 'Chat[A-Z]' packages/test-harness/
```

Expected: zero or only the comment on line 56.

**Step 10.3: Run + commit**

```bash
pnpm --filter @ax/test-harness build && pnpm --filter @ax/test-harness test
git add packages/test-harness
git commit -m "docs(test-harness): refresh stale Chat→Agent comment [Phase 4]"
```

(If only a comment changes, this commit may be skipped; collapse into Task 11.)

---

### Task 11: README + top-level docs

**Goal:** Bring documentation in line with code (I9).

**Files:**
- Modify: `README.md:11, 67-68, 78-92`

**Step 11.1: Identify stale snippets**

Lines 11 (kernel description mentions `ChatContext`), 67-68 (imports `makeChatContext`, `ChatOutcome`, `registerChatLoop`), 78 (`makeChatContext(...)` call), 80 (hook string `'chat:run'`), 92 (`bus.call('chat:run', ...)` example).

**Step 11.2: Rewrite the example block**

Replace:
- `chat:run` → `agent:invoke` (lines 80, 92)
- `makeChatContext` → `makeAgentContext` (lines 67, 78)
- `ChatContext` → `AgentContext` (line 11)
- `ChatOutcome` → `AgentOutcome` (line 68)
- `registerChatLoop` → drop the import; the kernel no longer exports it. The example code that used to call `registerChatLoop` (if any persists) gets replaced with the agent-centric pattern: load the chat-orchestrator plugin, dispatch via `bus.call('agent:invoke', ctx, { message })`.

Plan author: if the README example is structurally outdated (still implies the old turn-loop architecture), opt for either (a) a minimal symbol-level rename keeping the example shape, or (b) a fuller rewrite reflecting the agent-centric design. Default: (a) — Phase 4 is rename-only; structural rewrite earns weight in Phase 5.

**Step 11.3: Verify there are no other stale references in `docs/` or `README.md`**

```bash
rg -n 'chat:run|makeChatContext|ChatContext|ChatOutcome|registerChatLoop' --no-heading -g '!node_modules' -g '!dist' -g '!.git' README.md docs/
```

Expected: zero matches outside of historical doc plans (`docs/plans/2026-04-XX-*.md`) — those are point-in-time records and stay as-is. Only README and any "current state" docs update.

**Step 11.4: Commit**

```bash
git add README.md
git commit -m "docs(readme): chat:run → agent:invoke, makeChatContext → makeAgentContext [Phase 4]"
```

---

### Task 12: Final verification + boundary review note

**Goal:** Confirm full workspace builds clean. Compose the boundary-review section for the PR description.

**Step 12.1: Full workspace build + test**

```bash
pnpm build
pnpm test
```

Expected: ALL packages green. No `Chat*` symbols remaining outside `docs/plans/`. Zero `chat:run` literal in code (only in historical plan docs).

**Step 12.2: Verify no stragglers**

```bash
rg -n 'ChatMessage\b|ChatMessageSchema\b|ChatOutcomeSchema\b|ChatRunInput\b|runChat\b' --no-heading -g '!node_modules' -g '!dist' -g '!.git' -g '!docs/plans/'
rg -n "'chat:run'|\"chat:run\"" --no-heading -g '!node_modules' -g '!dist' -g '!.git' -g '!docs/plans/'
```

Expected: zero matches across both commands. Any straggler is a missed file from Tasks 2–11; fix it and amend the relevant commit (or add a small follow-up commit per memory `feedback_targeted_followup_commits.md`).

**Step 12.3: Compose boundary review for PR description**

Per I3, the IPC schema rename gets a boundary review. Template (drop into PR description):

```markdown
## Boundary review — `ChatMessageSchema` / `ChatOutcomeSchema` rename

- **Alternate impl this schema could have:** none — these are concrete Zod schemas used directly by `@ax/ipc-server`'s dispatcher and by every plugin that constructs an inbox payload or chat-end event. The rename is a pure-symbol change; the on-wire JSON shape is unchanged.
- **Payload field names that might leak:** none. `role`, `content`, `kind`, `messages` are all generic. The rename does not introduce new fields or rename existing ones.
- **Subscriber risk:** none — `chat:end` (the event payload that uses `AgentOutcomeSchema`) is subscribed by the orchestrator + audit-log + conversations. All three update in lockstep.
- **Wire surface:** the host↔sandbox IPC bridge (Unix socket / HTTP). Both sides of the bridge are in this monorepo; the rename is atomic across the wire because both peers ship together.
```

**Step 12.4: Compose Phase 4 PR notes**

Mirror the structure of `docs/plans/2026-04-29-phase-3-pr-notes.md`: What lands, Boundary review, Invariants verified, Stats, Follow-ups, Operator notes (none — pure rename, no operator-visible behavior change).

Save as `docs/plans/2026-04-30-phase-4-pr-notes.md` after the PR opens (not before — keep PR notes a faithful record, not a forecast).

**Step 12.5: No commit for this task** — verification + PR-description prep only.

---

## Acceptance criteria (verified before merge)

| | Criterion | How verified |
|---|---|---|
| I1 | No `ChatMessage`/`ChatMessageSchema`/`ChatOutcomeSchema`/`ChatRunInput`/`runChat` in code | Task 12.2 `rg` |
| I2 | `pnpm build` + `pnpm test` clean across all packages | Task 12.1 |
| I3 | Boundary review recorded in PR description | Task 12.3 |
| I4 | On-wire JSON shape unchanged | Visual inspection of `actions.ts` and `events.ts` diffs — only symbol names change, no key/role/value changes |
| I5 | `chat:end`, `chat:turn-end`, `chat:start` hooks intact | `rg "'chat:end'\|'chat:turn-end'\|'chat:start'"` shows them registered/subscribed in their original locations |
| I6 | `@ax/test-harness` exports unchanged (or comment-only diff) | `git diff` on `packages/test-harness/src/index.ts` is empty |
| I7 | `agent-native-runner`, `llm-anthropic`, `llm-proxy-anthropic-format` still build | Tasks 6, 7 verification |
| I8 | `@ax/chat-orchestrator` package name + `PLUGIN_NAME` unchanged | `git diff packages/chat-orchestrator/package.json` empty; `PLUGIN_NAME` constant unchanged |
| I9 | README references match code | Task 11.3 `rg` clean |
| I10 | `runChat`/`ChatRunInput` rename is internal-only | No external package depends on these symbols (verified by Task 4 build success) |
| I11 | No new half-wired plugin / hook / bus surface | Phase 4 introduces nothing new — all renames are like-for-like |

---

## Phase 3 lessons feeding into this plan

| Phase 3 lesson | How it shapes Phase 4 |
|---|---|
| **I12 — Hard cut, not soft migration** (memory: `project_phase_3_shipped.md`, `feedback_targeted_followup_commits.md`) | Phase 4 invariants I1 + I2: no aliasing layer, all consumers update atomically. |
| **I3 — Reshape field names don't leak backend** | Phase 4 I4: `AgentMessage` keeps `{ role, content }` — the rename does not introduce backend-coupled fields. |
| **I4 — Boundary review recorded for wire-surface changes** | Phase 4 I3 + Task 12.3: IPC schema rename gets a boundary-review section in the PR despite being a pure-symbol change. |
| **Phase 1b — defer reshapes until consumers force them** (memory: `project_phase_1b_shipped.md`) | Phase 4 captures the rename now that earlier phases have settled. Open question §1 (role narrowing) defers to Phase 7 by the same discipline — don't reshape on speculation. |
| **Half-wired window pattern** (memory: `feedback_half_wired_window_pattern.md`) | Phase 4 I11: explicit "no half-wired window opens" — pure rename, no new plugin to load, no new hook to wire. |
| **`feedback_check_plan_vs_reality.md`** | Task 1 + the "Reality check" table at the top of this plan: most of the rename was already done in earlier phases. Don't blindly execute the design doc's Phase 4 description — verify first, then scope to what's left. |
| **`feedback_targeted_followup_commits.md`** | Task 12.2: if a straggler surfaces during final verification, prefer a small follow-up commit to a reflexive amend. |
| **Phase 3 `pnpm build` clean across 47 packages** | Phase 4 I2: same standard. The rename is pure; there is no excuse for any package to fail build at PR time. |

---

## Estimated landing

- **Tasks:** 12 (including 1 read-only survey + 1 final verification).
- **Commits:** ~9 (one per logical group: core, ipc-protocol, chat-orchestrator, sessions, runners, llm-*, cli+channel-web, ipc-core, README).
- **Files touched:** ~28.
- **Risk:** Low. The rename is mechanical; tests catch breakage at task boundaries; no new behavior, no new wire shape, no new plugins.
- **Predecessors:** Phase 3 (PR #21, merged). No phase-4-specific prerequisites — Phase 4 is independent of Phase 3 per design Section 7 ("Phase 4: independent of 1–3").
- **Successors:** Phase 5 (orchestrator shrink, ~80 LOC `agent:invoke`) depends on Phase 4. Phase 7 (kernel cleanup, deletes `LlmRequest`/`LlmResponse`/etc., narrows `AgentMessage` to 2 roles) depends on Phase 6, which depends on Phase 5.
