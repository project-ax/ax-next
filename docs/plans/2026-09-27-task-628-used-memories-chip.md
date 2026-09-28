# TASK-628 — "Used N memories" chip under answers

## Problem

Under an assistant answer, show which memories the model was handed for that
answer, and let the person Fix one on the spot. What the model saw must come
from the turn itself (never a re-query), and a statement fixed or forgotten
since must say so instead of vanishing.

## What counts (decided)

**Statements returned by `memory_recall` tool calls in that answer's
exchange.** Not the injected memory block: `system-prompt:augment` runs once
at chat start (see `augment.ts` header, "no per-turn refresh"), so every
answer in the chat "used" it equally and attributing it to one answer would
be a claim we cannot back. Distinct statements are counted once per answer.

## Why a receipt (measured, not assumed)

- The persisted tool result is model-visible TEXT only
  (`ToolResultBlock.content`); the evidence table carries no statement ids,
  and adding ids would change the tuned model-facing format.
- The browser never gets tool outputs (`toolOutcomes` keeps only isError/held).
- `call.id` on the host path is `idGen()` in the claude-sdk runner's MCP shim,
  NOT the SDK tool_use id, so a decisions-style join on tool_use id is
  unavailable. `ctx.reqId` on the IPC path is a fresh per-request id, not the
  chat reqId.

So `@ax/memory` records, when `memory_recall` answers inside a conversation, a
**recall receipt**: `{ at, statements }` — the exact rows `renderRecallResult`
rendered for the model. Receipts live in `storage:*` (the same kv the
incremental-extraction cursor uses), one key per conversation, stamped with
the agent and the user, capped.

The thread route attaches each receipt to the answer by TIME: the receipt's
`at` falls after the exchange's user turn (`createdAt`) and the chip goes on
the LAST assistant message (`agent` | `steps`) of that exchange. A receipt with
no committed answer yet (live turn) attaches to nothing until the next read.

## Hook (boundary review)

`memory:recall-receipts` (service, `@ax/memory`)
- input `{ conversationId: string }`
- output `{ receipts: Array<{ at: string; statements: MemoryUsedStatement[] }>, visibility?: 'personal' | 'team' }`
- `MemoryUsedStatement` = the recall-surface statement fields (id, about,
  relation, value, when, until?, kind?, slot?, savedBy?, aboutText?) plus
  `closedSince?: 'replaced' | 'forgotten' | 'retracted'` — the row's CURRENT
  closure when it has been closed since the answer (absent = still in effect,
  or not determinable).
- Owner-scoped: a receipt is returned only when its stored agent AND user equal
  `ctx.agentId`/`ctx.userId`. Routine turns record none (`conversationOf`).
- Alternate impl: a receipts table inside the facts engine, or the transcript
  itself once tool results can carry non-model metadata.
- Leaky names: none (`at`, `statements`, `conversationId`).

## Tasks

1. **@ax/memory — receipts** (`recall-receipts.ts`, `recall-tool.ts`, `plugin.ts`)
   - record after a successful `memory:recall` in the tool handler; never
     throws into the tool; serialized per conversation key in-process; cap 50
     receipts per conversation (drop oldest); skip when no conversation
     (routine), no user, or no `storage:get`/`storage:set`.
   - `memory:recall-receipts` service: read, owner check, then resolve
     `closedSince` with at most 10 history reads (`memory:recall` with
     `about`, `activeOnly: false`) over the distinct subjects; a row not
     found stays without `closedSince`. A failed status read degrades to no
     `closedSince`, never to an error.
   - manifest `registers` gains the hook.
   - Tests: recorded rows == rendered rows; routine not recorded; foreign
     user/agent reads nothing; cap; status annotation; recording failure does
     not fail the tool; parallel calls both land.
2. **channel-web server — attach** (`routes-workspace.ts`, `workspace-types.ts`)
   - `ThreadMessage` agent/steps gain `memoryUsed?: { statements: MemoryUsedStatement[]; visibility?: 'personal'|'team' }`.
   - Pure `attachMemoryUsed(thread, turns, receipts, visibility)`; fields
     copied one at a time. Called in the agent-detail route when
     `memory:recall-receipts` is registered and a conversation is read; a
     throw is logged and yields no chips.
   - Tests: time-window attribution (two exchanges, multi-turn answer, live
     turn with no answer, dedupe by id).
3. **channel-web client — chip** (`MemoryUsedChip.tsx`, `AgentConversation.tsx`, `memory-copy.ts`, `MemoryCorrection.tsx` additively)
   - Collapsible, closed by default, styled like `Steps`; rows: statement,
     source · date, Fix (shared `MemoryFixDialog`) or the since-state.
   - All strings in `memory-copy.ts` (additive block).
   - Tests: only renders with statements; count; closed by default +
     aria-expanded; Fix saves via `correctMemory` and the row flips state.

## YAGNI

- No Forget on the chip (card: Fix only).
- No live-stream push of receipts; the thread re-read at turn end is enough.
- No engine by-id read; per-subject history reads are bounded and fail soft.
