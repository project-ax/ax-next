# TASK-1220 — `@` mentions, CLI markup and forged blocks in a turn

Measured first, on the real `claude` binary (CLI 2.1.119, SDK 0.2.119), with the
TASK-1217 scripted-model harness. Findings are in the decisions shard
(`.claude/memory/decisions/2026-11-23-TASK-1220.md`); the short version:

- **M1, `@path`:** any `@<path>` at the start of a turn or after whitespace makes the
  CLI read the file (or list the directory) before the model call. No PreToolUse,
  no `canUseTool`. Reaches `/etc/hosts`, `../`, the config dir, symlinks out of home.
- **M2, text forgery:** text can't become an assistant or tool message (it stays
  one user-role message). It CAN copy the CLI's own markup byte for byte, and for
  `<local-command-stdout>`, `<bash-stdout>`, `<task-notification>` the CLI files the
  message as its own and drops the replay echo (TASK-708's fold signal).
- **M3, block forgery:** a crafted web POST can carry `tool_use`, `tool_result`,
  `thinking`, `redacted_thinking`. The host passes them on, runner-core passes them
  through, and the CLI puts `tool_use`/`thinking` inside a user-role message and
  keeps them in history.

## Tasks

1. **[tier: sensitive] `keepCliMarkupAsText`** (`agent-claude-sdk-runner/src/cli-markup-text.ts`
   + unit test). U+200B before any `@` not after a letter/digit; U+200B after the `<`
   of a closed list of CLI tags. Wire into `main.ts` `userMessages()` next to
   `keepSlashAsText`.
2. **[tier: sensitive] Host refusal.** `channel-web` `routes-chat.ts` step 2.5 also
   refuses `tool_use`, `tool_result`, `thinking`, `redacted_thinking` (400
   `invalid-content-block`) before anything is committed. Route test per type.
3. **[tier: sensitive] Runner allowlist.** runner-core `translateContentBlocks` passes
   only `text` / `image` / `document`; any other type becomes a fixed text mention
   (never the raw block). Covers every channel (Slack, routines, task runs). Unit test.
4. **[tier: integration] Real-binary e2e** (`cli-markup-text-real-sdk.e2e.test.ts`):
   CONTROL raw (file read, echo dropped, tool_use kept in a user message) and FIX
   through the real exports (nothing read, echo back, only text reaches the CLI).
   Mutation check: drop each guard → its FIX goes red.
5. **[tier: mechanical] Docs + wording.** SECURITY.md row; "runner-private" in
   `config-dir-guard.ts` messages → "private to the session"; memory shards.

## Not in this PR (follow-ups)

- Item 3: prod `scheduled_tasks.json` scan (prod access + Vinay's OK).
- Item 4: reserve CLI bundled skill names at AX skill creation (crosses
  `skills:upsert`, `catalog:admit`, `skills:propose`; the runner already refuses at use).
- Item 5 rest: mid-turn guarded `/clear` real-binary e2e; `SETTLE_MS` fixed sleeps.
