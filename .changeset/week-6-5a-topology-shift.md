---
"@ax/core": minor
"@ax/cli": minor
"@ax/sandbox-subprocess": minor
"@ax/test-harness": patch
"@ax/ipc-protocol": minor
"@ax/ipc-server": minor
"@ax/session-inmemory": minor
"@ax/chat-orchestrator": minor
---

Week 6.5a — topology shift.

The agent turn-loop moves from in-process (`@ax/core`'s `chat-loop.ts`) to a subprocess sandbox driven via HTTP+JSON IPC over a per-session unix socket. Host-side chat observable behavior is unchanged; `@ax/llm-anthropic`, `@ax/audit-log`, and `@ax/storage-sqlite` are untouched. The new acceptance test asserts bash runs as a grandchild of the host (via PPID inspection), proving the topology shift took.

- `@ax/ipc-protocol` (new) — Zod schemas for every sandbox↔host wire action + event + error code, plus per-action timeout defaults. Types-only, no runtime. `WorkspaceVersion` branded via TypeScript + wire-time `.transform` so parsed responses carry the opaque-token contract without consumer casts.
- `@ax/session-inmemory` (new) — registers `session:create` / `session:resolve-token` / `session:queue-work` / `session:claim-work` / `session:terminate`. Opaque base64url tokens (32 bytes of `crypto.randomBytes`), terminate-as-flag-not-delete, per-session long-poll inbox with advance-on-delivery / echo-on-timeout cursor semantics. Postgres impl (Week 7–9) lands against the identical contract.
- `@ax/ipc-server` (new) — unix-socket HTTP listener with bearer-token auth, per-session tempdir (mode 0700 via `fs.mkdtemp`), 4 MiB body cap (matches `@ax/core`'s `MAX_FRAME`), 60 s idle timeout so 30 s long-polls aren't killed. Per-action dispatcher routes to `llm.call` / `tool.pre-call` / `tool.execute-host` (404 until a host-side tool registers) / `tool.list` / `workspace.commit-notify` (6.5a stub: always `{accepted:true, version:'stub', delta:null}`) / `session.next-message` (GET long-poll). Event ingest for `event.tool-post-call` / `event.turn-end` / `event.chat-end` returns 202 and fires subscribers asynchronously. `event.stream-chunk` returns 501 with a message naming 6.5b. SECURITY.md walks the three threat models.
- `@ax/sandbox-subprocess` — extended: registers `sandbox:open-session` (new), deletes `sandbox:spawn` (no more host-side one-shot spawns — tools live in the runner). Per-session tempdir socket, env allowlist preserved, session minted + terminated around the child process, `handle.kill()` SIGTERM → SIGKILL after 5 s. SECURITY.md adds a new review section for the extension.
- `@ax/agent-runner-core` (new, sandbox-side) — IPC client over `http.Agent({ keepAlive: true })` + unix socket, per-action timeout via `AbortController`, exponential backoff retries on connection/5xx errors, 401 is terminal (`SessionInvalidError`). Inbox loop handles `timeout` as a retry and returns on `user-message`/`cancel`. Local tool dispatcher with `has(name)` + `execute(call)`.
- `@ax/chat-orchestrator` (new) — registers `chat:run`. Flow: fire `chat:start` → `sandbox:open-session` (which internally mints the session + token) → `session:queue-work` → await `chat:end` (fired by the IPC server when the runner emits `event.chat-end`). One-shot mode (default): subscribes to `chat:turn-end` and queues a `{type:'cancel'}` entry after the first turn so the persistent runner exits cleanly for single-message chats.
- `@ax/tool-dispatcher` — refactored: registers `tool:register` + `tool:list` (catalog state), drops the `tool:execute` umbrella. Catalog seals after first `tool:list`. Namespaced tool names allowed (`memory.recall`).
- `@ax/core` — opens `PluginErrorCode` with `| (string & {})` so plugins can supply domain-specific codes without casts. Adds `executesIn: 'sandbox' | 'host'` to `ToolDescriptor`. Removes `chat-loop.ts`, `registerChatLoop`, `SandboxSpawn*` types (all superseded). `@ax/test-harness` drops the `withChatLoop` option — consumers register `@ax/chat-orchestrator` explicitly.
- `@ax/cli` — wires `@ax/session-inmemory`, `@ax/ipc-server`, `@ax/chat-orchestrator`. Resolves the runner binary via `createRequire(import.meta.url).resolve('@ax/agent-native-runner')`. No change to the config file format; existing `ax.config.ts` files still work.
- ESLint allowlist grows by two documented shared-imports (`@ax/ipc-protocol`, `@ax/agent-runner-core`) plus two file-scoped exceptions (`packages/agent-*-runner/**` for runner binaries, `packages/*/src/__tests__/**` for integration-style test files).

Full repo: 19 packages, 311 tests, all green.
