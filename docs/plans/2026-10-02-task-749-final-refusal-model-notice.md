# TASK-749 — tell the model about a final/idle (or orphaned) refused save

TASK-732 tells the model next turn, in-process. Uncovered: the final/idle
refusal (the process exits after it) and a per-turn refusal on a runner that
exits before its next message. Both are delivered to the first turn(s) of a
NEW runner process, so the state must live on the host.

## Tasks

1. **conversations**: migration adds `save_refused_drained_seq BIGINT` to
   `conversations_v1_conversations`; store `drainSaveRefusals({conversationId,
   userId})` (CAS watermark, fold by key, closed codes only); hook
   `conversations:drain-save-refusals` → `{ refusals: [{ code, turnReqId|null }] }`.
   Tests: store (pg container) + plugin.
2. **ipc-protocol + ipc-core**: action `conversation.drain-save-refusals`
   (strict `{}` body, conversationId from ctx), timeout, client schema,
   handler with hasService guard, optional dependency entry. Tests.
3. **agent-runner-core**: `saveRefusedNoticeFromCodes`; run-runner drains on
   each turn build (conversation-bound runs only), drops keys this process
   refused, prefers the in-process notice. Tests: final refusal told on a
   fresh runner's first turn exactly once; in-process duplicate dropped.
4. Docs/memory/comments: current-architecture, run-runner comments, memory
   shard superseding TASK-732's "still NOT told" line.

YAGNI: all four are load-bearing. Security: prompt-injection surface — only
closed codes cross; the runner is untrusted but can only drain its own
ctx-bound conversation (self-harm only).
