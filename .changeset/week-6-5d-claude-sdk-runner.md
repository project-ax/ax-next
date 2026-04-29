---
"@ax/agent-claude-sdk-runner": minor
"@ax/cli": minor
"@ax/sandbox-subprocess": minor
"@ax/test-harness": minor
"@ax/audit-log": patch
"@ax/chat-orchestrator": patch
"@ax/core": patch
"@ax/ipc-protocol": patch
"@ax/ipc-server": patch
"@ax/session-inmemory": patch
"@ax/storage-sqlite": patch
"@ax/tool-dispatcher": patch
---

Week 6.5d — claude-sdk runner + Anthropic-format proxy. Swap `runner: 'claude-sdk'` in `ax.config` to route the sandbox through `@anthropic-ai/claude-agent-sdk`; LLM traffic flows via a host-side Anthropic-format proxy → `llm:call`, keeping API keys host-side and firing existing `tool:pre-call` / `tool:post-call` subscribers for both built-in and MCP host tools.

- `@ax/agent-claude-sdk-runner` (new) — sandbox-side binary wrapping `@anthropic-ai/claude-agent-sdk`'s `query()`. Built-in tools (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `TodoWrite`) stay enabled and run inside the sandbox process tree; `WebFetch`, `WebSearch`, `Skill`, `Task` are disabled via `disallowedTools` as a capability minimization. `canUseTool` → `tool.pre-call` IPC (verdict + rewrite honored); `hooks.PostToolUse` → `event.tool-post-call` IPC (observation-only). `executesIn: 'host'` entries from `tool.list` are surfaced through an in-process `createSdkMcpServer({ name: 'ax-host-tools' })` whose handlers forward to `tool.execute-host`. `settingSources: []` + `systemPrompt: { preset: 'claude_code' }` pinned by test. Exact-pinned `@anthropic-ai/claude-agent-sdk@0.2.119`.
- `@ax/llm-proxy-anthropic-format` (new) — host-side HTTP proxy translating `POST /v1/messages` into `llm:call`. Registers `llm-proxy:start` / `llm-proxy:stop` service hooks (per-session ephemeral port on `127.0.0.1`). Bearer-token check via `session:resolve-token` BEFORE body parse; 4 MiB body cap (matches `@ax/ipc-server`); auth token never echoed in error responses. Supports streaming (`stream: true` synthesizes Anthropic SSE frames from one bulk `llm:call`) and non-streaming. Image content blocks dropped with a warn (Week 13+).
- `@ax/cli` — `runner: z.enum(['native', 'claude-sdk']).default('native')` config discriminator. When `claude-sdk` is selected, resolves `@ax/agent-claude-sdk-runner` via `createRequire` and registers the proxy plugin. Adds `MainOptions.extraPlugins` + `skipDefaultLlm` test-only seams for acceptance coverage.
- `@ax/sandbox-subprocess` — calls `llm-proxy:start` after `ipc:start`, injects `AX_LLM_PROXY_URL=<url>` into the runner's `sessionEnv` (alongside existing `AX_IPC_SOCKET` / `AX_SESSION_ID` / `AX_AUTH_TOKEN` / `AX_WORKSPACE_ROOT`), and calls `llm-proxy:stop` on child close. Env allowlist unchanged.
- `@ax/test-harness` — `createTestHostToolPlugin()` registers a `test-host-echo` stub (`executesIn: 'host'`) used by the acceptance test to exercise the MCP host-tool path.
- Acceptance: `packages/cli/src/__tests__/claude-sdk-runner.e2e.test.ts` spawns a real subprocess sandbox running the real claude-sdk-runner binary and asserts that both `Bash` (built-in) and `mcp__ax-host-tools__test-host-echo` (host-mediated) fire `tool:pre-call` and `tool:post-call` subscribers in order.
- Security: `packages/llm-proxy-anthropic-format/SECURITY.md` (loopback-only HTTP surface, session-bound auth, body cap) + `packages/agent-claude-sdk-runner/SECURITY.md` (exact-pinned SDK, disabled built-ins, `settingSources: []` contract).

Full repo: 21 packages, all green.
