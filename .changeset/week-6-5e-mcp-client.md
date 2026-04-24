---
"@ax/credentials": minor
"@ax/mcp-client": minor
"@ax/cli": patch
"@ax/test-harness": patch
---

Week 6.5e — `@ax/credentials` (at-rest encrypted secrets) + `@ax/mcp-client` (host-side MCP server hosting). Configure remote MCP servers via `ax-next mcp add`, store their credentials via `ax-next credentials set`, and the CLI surfaces their tools to the model under a `mcp.<server>.<tool>` namespace. All MCP tool calls fire `tool:pre-call` / `tool:post-call` on the same path as built-in tools.

- `@ax/credentials` (new) — AES-256-GCM at-rest encryption for opaque secret blobs. Registers three service hooks (`credentials:set`, `credentials:get`, `credentials:delete`) that round-trip plaintext at the call site and ciphertext at the storage layer. Key is 32 bytes, read once from `AX_CREDENTIALS_KEY` (hex or base64) at plugin init; rotating means restart + re-set (no in-place rotate yet). Delete is a tombstone write (encrypted empty string) until `storage:delete` lands. IDs are namespaced under a `credential:` storage prefix and validated against `^[a-z0-9][a-z0-9_.-]{0,127}$`. Host-side only — not exposed on the IPC bridge to sandboxes.
- `@ax/mcp-client` (new) — per-server `McpConnection` (`disconnected → connecting → ready`, with `unhealthy` as a recoverable side branch and `closed` as a one-way terminus) backed by `@modelcontextprotocol/sdk@1.29.0` (exact-pinned to match `@anthropic-ai/claude-agent-sdk@0.2.119`'s transitive resolution). Supports stdio, streamable-http, and sse transports; warns on plain `http://` URLs. Stdio subprocesses spawn with a short env allowlist (`PATH`, `HOME`, `LANG`, `LC_ALL`) plus `config.env` plus resolved `credentialRefs`. Secrets in the config object are rejected at parse time by key-name sniff (`password`, `secret`, `token`, `apikey`, `api_key`). Tool names are re-keyed as `mcp.<serverId>.<sanitized>`; duplicate remote tool names fail with `duplicate-remote-tool`. Failed `connect()` at init skips the server; failed `callTool` returns `{ok: false, code: 'MCP_SERVER_UNAVAILABLE'}`, wrapped by the plugin into a tool-error result so the model can reason about it. Reconnect backoff is 1s, 2s, 4s, 8s, 16s.
- `@ax/cli` — new `ax-next credentials set <id>` (stdin-only, no argv value) and `ax-next mcp add|list|rm|test` subcommands. Both plugins are registered conditionally on the chat path when the user configures them.
- `@ax/test-harness` — minimal stdio MCP server stub (`mcp-server-stub`) exposing `echo` and `crash` tools for acceptance coverage.
- Acceptance: `packages/cli/src/__tests__/mcp-client.e2e.test.ts` spawns the real `@ax/mcp-client` plugin against the stdio stub, calls `mcp.echo.echo` successfully, then triggers `crash` and verifies the recovery path surfaces `MCP_SERVER_UNAVAILABLE` without terminating chat. Runs in ~854ms.
- Security: `packages/credentials/SECURITY.md` + `packages/mcp-client/SECURITY.md` — both walk the three-threat-model (sandbox, injection, supply chain) shape prescribed by the `security-checklist` skill.

Full repo: 23 packages, all green (580 tests).
