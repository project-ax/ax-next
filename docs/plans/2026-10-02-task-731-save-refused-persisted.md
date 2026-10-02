# TASK-731 — a refused save survives a reload, and the final/idle refusal has a channel

Follow-up to TASK-720 (PR #827). Decisions: `.claude/memory/decisions/2026-10-02-TASK-731.md`.

## Problem

A refused end-of-turn save reaches the person only on the live SSE `done` frame.
That frame is not buffered, so a reload (or a browser that connects late) shows no
sign that the reply's files were not kept. The final/idle commit after the last
turn-end has no turn-end to ride, so a refusal there goes to stderr and nowhere else.
The final flush bundles `baseline..main`, so it can carry files from earlier replies
whose save came back `kept` (host unreachable). Those are files the person saw being
made, which means this case does happen.

## Shape (the contract every task builds to)

- **Display-event kind `save-refused`** in `conversations_v1_events`.
  - `payload: { code }`, where `code` is one of `'storage-full' | 'too-large' | 'refused'`
    (`SaveRefusedCode` from `@ax/ipc-protocol`). Nothing else is in the payload.
  - `key` (fold key):
    - per-turn: the turn-end payload's `reqId` when it is a non-empty string, else `''`;
    - final/idle: `final:<crypto.randomUUID()>`, minted on the host.
  - `role`: none.
- **Per-turn writer.** ipc-core `persistEventTurnEnd`:
  - When `payload.saveRefused` is one of the three codes and `ctx.conversationId` is
    set, append the row AFTER the `turn` row.
  - Best-effort: on error, log and swallow.
  - Both turn-ends of one turn carry the code (the tool one, then the assistant one),
    so they fold to one row. The row keeps the later `seq`/`createdAt` and sits after
    the assistant turn.
- **Final writer.**
  - `EventChatEndSchema` gains an optional `saveRefused` (same enum).
  - The runner sets it on `event.chat-end` when the final commit was refused. The
    stderr line stays as a log.
  - ipc-core persists a `save-refused` row from chat-end before firing `chat:end`
    (the dispatcher's `persist` slot), best-effort.
- **Read.**
  - conversations `listEvents` skips an unknown `event_kind` (logs it) instead of
    throwing.
  - `projectDisplayEvents` carries `save-refused` through as is.
- **channel-web.**
  - `DisplayEventRow.kind` gains `'save-refused'`.
  - `buildThread` projects each row as `{ kind:'save-refused', id: saveRefusedRowId(key), code }`
    and interleaves it by `createdAt` the way `errorMessages` does, with turns winning
    ties.
  - The `ThreadMessage` `save-refused` variant carries `code: SaveRefusedCode`
    instead of `text`, and the renderer words it with `SAVE_REFUSED_COPY`. The wire
    carries a closed code, never a sentence.
  - `saveRefusedRowId(key)` lives in `lib/save-refused.ts`, which both the server and
    the client import.
  - The live notice in `AgentView` remembers the turn's `reqId`. It is not drawn once
    `detail.thread` holds a row whose id is `saveRefusedRowId(reqId)`.

## Tasks

1. **conversations: the `save-refused` kind.** Load-bearing.
   - Add it to `ConversationEventKind` and `VALID_EVENT_KINDS`.
   - Migration: widen the `event_kind` CHECK (idempotent, safe when two replicas
     migrate at once).
   - `listEvents` becomes tolerant of unknown kinds.
   - Tests: append and read back a `save-refused` row; an unknown kind is skipped,
     not thrown; the migration runs twice cleanly.
2. **ipc-protocol + ipc-core: the writers.** Load-bearing.
   - `EventChatEndSchema.saveRefused`.
   - Persist in `persistEventTurnEnd`, and add a chat-end persist slot.
   - Tests:
     - a turn-end with `saveRefused` appends the turn row, then the save-refused row
       (key = reqId);
     - an invalid code is rejected by the schema;
     - an append failure of the notice row is swallowed and the ack stays 2xx;
     - chat-end with `saveRefused` appends a `final:`-keyed row;
     - neither path writes a row without a conversationId or without a code.
3. **runner: the final refusal rides `event.chat-end`.** Load-bearing.
   - A run-runner test: a refused final commit puts `saveRefused` on chat-end; an
     accepted one does not.
4. **channel-web: show it on reload, no double.** Load-bearing.
   - `buildThread` projection test: the row is placed after the assistant turn, and a
     bad code or a missing createdAt is dropped.
   - An AgentView test: the live notice is not duplicated once the re-read carries
     the row, and the persisted row renders after a reload.
   - Update the copy and comments that say "not persisted".
5. **Docs and memory.**
   - Arch doc line ~449 ("Live only").
   - `workspace-types.ts` producer list.
   - The `run-runner.ts` comments.
   - A context shard that supersedes TASK-720's "live only" line.

YAGNI cut: no new IPC event, and no buffered done frame. The durable row covers the
late browser, because a browser that connects after turn-end re-reads the thread.

Security: this touches an IPC payload (`event.chat-end`), so the security checklist
applies.
- Only a closed enum crosses the boundary.
- `conversationId` comes from the host-stamped ctx.
- The host mints the row key.
- A lying runner can add at most one notice row per event, and it can already append
  `turn` rows without limit.
