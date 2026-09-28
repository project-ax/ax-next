# TASK-625 — Memory extraction during a conversation, not only at chat:end

## Problem

`@ax/memory` extracts only on `chat:end`. In the k8s preset the runner is kept
warm (`keepAlive: true`), so `chat:end` fires when the idle reaper collects it
(~5 min after the last turn), once per runner session. Memories land late and
can't be shown while the person is still in the chat (TASK-626/627 need that).

## Approach

All inside `@ax/memory`, plus one optional provenance field on the facts
contract.

- **Trigger.** Subscribe to `chat:turn-end` (fired per turn, host-side, after
  the turn is persisted to the display log). On an `assistant` turn-end with a
  `conversationId`, count completed user turns (a new `reqId` = a new user
  message) and (re)arm an idle timer. A pass runs when either happens first:
  the idle timer fires (default 2 min) or the count reaches N (default 4).
  `chat:end` runs a final pass over the remainder. Every pass is detached.
- **Source of turns.** `conversations:get` — the display log, which is
  append-only and holds user + assistant turns with the `turnId` the chat UI
  keys messages on. Only `text` blocks of `user`/`assistant` turns are read;
  tool turns, attachments, tool_use and thinking blocks never reach the
  extractor.
- **Cursor.** Per conversation, the index after the last turn a pass covered,
  kept durably in `storage:*` (so a host restart doesn't re-extract turns) and
  serialized per conversation in-process (single-replica host).
- **Context.** Each pass includes up to 2 preceding dialogue turns as
  read-only context. The pinned prompt can't be told "don't extract from
  these", so context-only facts are dropped deterministically after
  extraction: a fact with no lexical support in any new turn but support in a
  context turn is dropped (it was already extracted by the pass that covered
  that turn).
- **Source turn.** Each fact is attributed to the new turn with the largest
  token overlap (role matching the fact's speaker breaks ties). Stored as
  `sourceTurnId` — provenance only, never a retrieval key.
- **Idempotency.** `batchKey` = hash(conversation, owner, first/last new
  turnId). Re-running a pass over the same range is an engine no-op.
- **Unchanged.** Pinned prompt, user/assistant text only, fire-and-forget with
  a failure event on every failure path, TASK-616 routine attribution, and the
  legacy `outcome.messages` path when `conversations:get` or `storage:*` is
  absent (CLI).
- **Paused.** Incremental passes skip a paused user (no LLM call). The
  `chat:end` pass always attempts, since only a resolved call clears the pause.

## Tasks

1. Facts contract + sqlite + postgres engines: optional `sourceTurnId` on
   `FactStatementInput` / `FactRecord`, stored and echoed, validated like
   `conversationId`. Conformance cases.
2. `@ax/memory`: canonical-turn filter, attribution, range batch key,
   `runTurnObserver`, per-conversation scheduler (idle + N), cursor, chat:end
   final pass, manifest + config. Integration tests through the bus.
3. Docs/memory rows.
