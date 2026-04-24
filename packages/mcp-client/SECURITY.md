# Security — `@ax/mcp-client`

This package is how AX talks to the [Model Context Protocol](https://modelcontextprotocol.io) ecosystem. It reads per-server configs from storage, spawns stdio MCP subprocesses (or opens streamable-HTTP / SSE connections), resolves any secrets via `credentials:get`, asks each server for its tools, and registers them with the host's tool dispatcher under a `mcp.<server>.<tool>` namespace. Every tool call from the model then round-trips out over MCP and back. This note is the `security-checklist` walk for the Week 6.5e landing — it touches all three threat models (sandbox, injection, supply chain) meaningfully, so it runs longer than the `@ax/credentials` note.

## Why host-side, not sandbox-side

Per invariant I5, plugins get the smallest capability set they need. MCP subprocesses spawn on the **host** side of the trust boundary for three reasons:

- The sandbox doesn't need network egress to whatever third-party endpoint an MCP server wants to reach. Putting the subprocess host-side means the sandbox's egress rules stay tight.
- The host already has credential plumbing (`credentials:get`) — re-implementing that inside the sandbox would mean handing the sandbox a decryption capability it doesn't otherwise need.
- Tool reach is already mediated. `tool:pre-call` / `event.tool-post-call` fire for MCP tools on the exact same path they fire for `Bash` — host subscribers get MCP traffic for free.

The tradeoff: an MCP subprocess runs with the same uid, filesystem, and network stack as the host CLI. Resource isolation beyond "process" is future work (see Known limits).

## Security review

- **Sandbox:** Stdio MCP subprocesses spawn with a deliberately short env allowlist — `PATH`, `HOME`, `LANG`, `LC_ALL` — plus whatever the user puts in `config.env` and whatever we resolve from `credentialRefs`. We explicitly pass `env` to the SDK's `StdioClientTransport` so it does NOT fall back to `getDefaultEnvironment()`, which would have inherited `LOGNAME`, `SHELL`, `USER`, and `TERM` on top. Argv is a fixed shape (`command: string`, `args: string[]`) with no `shell: true`, no shell interpolation, and no `process.env[userInput]` lookup anywhere in the plugin. Subprocess stdout/stderr is consumed by the SDK's framing layer — we never `eval` it or pipe it to a shell. HTTP / SSE transports default to HTTPS; a plain `http://` URL is accepted for dev loops but logs a `mcp_plain_http_transport` warning at startup. The plugin does NOT expose new IPC actions — it's a consumer of existing `storage:*` / `credentials:get` / `tool:register` hooks, not a new wire surface.

- **Injection:** Every byte from an MCP server is third-party model-fed input. Tool descriptions flow into `tool:list` and are surfaced to the model verbatim. Tool call results flow back up through `tool:execute:${name}` and the dispatcher into the model's context. Inside this plugin we treat all of it as opaque `unknown` — we never interpolate MCP output into a shell command, file path, SQL query, or URL. Scrubbing of tool descriptions (for prompt injection in the description itself) is a job for `llm:pre-call` subscribers landing in Week 10–12; we intentionally don't editorialize. Errors never echo credential values — `credential-resolution-failed` names the ref and the ID, not the secret; `mcp-connect-failed` carries the underlying transport message but the transport only sees ciphertext-in-transit via HTTPS or opaque env vars via stdio. `tool:pre-call` and `event.tool-post-call` fire identically for MCP tools and built-in tools, so host observers see MCP traffic on the same path they already watch for `Bash`.

- **Supply chain:** One new runtime dependency: `@modelcontextprotocol/sdk`, exact-pinned to `1.29.0`. That version was chosen deliberately to align with the transitive resolution already pulled in by `@anthropic-ai/claude-agent-sdk@0.2.119` — a caret range would let the two plugins pin to different SDK copies and double our audit surface. `npm view @modelcontextprotocol/sdk@1.29.0 scripts` shows no `preinstall` / `postinstall` / `install` / `prepare` hooks — nothing runs at `pnpm install` time. Maintainers are the MCP / Anthropic org npm accounts. Community MCP servers (filesystem, GitHub, Slack, etc.) are user-provided: users configure them through `ax-next mcp add`, and we never auto-install or auto-update them. Known surface-area cost: the SDK ships client + server halves together and pulls `express` and `hono` transitively even though we only use the client. Flagged by the Task 7 reviewer; listed below in Known limits.

## Subprocess posture

Stdio transports land on `StdioClientTransport` with a shape we control fully:

- Argv is `{ command, args }` — no `shell: true`, no shell metacharacter interpretation, no string concatenation that the shell would then re-parse.
- Env is built in order `allowlist → config.env → resolvedCredentialRefs`. Credentials win last so an accidentally-hardcoded `env.API_KEY` doesn't shadow the real secret.
- Stdout / stderr are consumed by the MCP framing layer. We never read them ourselves, never eval them, never pipe them to another shell.

What we don't do yet: enforce stdout/stderr/memory limits on the subprocess. A poorly-written community MCP server can theoretically OOM the host by streaming gigabytes or forking. Resource caps (ulimits / cgroups) are Week 13+.

## HTTP / SSE posture

For `streamable-http` and `sse` transports:

- URLs must match `^https?://` at config-parse time. Other schemes are rejected before they reach any transport code.
- Plain `http://` works but logs a warning at connection time (`mcp_plain_http_transport`) so operators can see in their logs that secrets are traversing cleartext. We prefer HTTPS.
- Auth headers come from `headerCredentialRefs` only — the config parser refuses any key whose name looks like a secret (`password`, `secret`, `token`, `apikey`, `api_key`) at any depth in the config object, so inline secrets in a URL query string or header value land as a `inline-secret-rejected` error at parse time, not a leak on the wire.
- TLS certificate pinning is Week 13+. Today we trust the system CA bundle.

## Connection lifecycle and failure mode

Each server has one `McpConnection`. The state machine is `disconnected → connecting → ready`, with `unhealthy` as a recoverable side branch and `closed` as a one-way terminus. Relevant behaviors:

- A failed `connect()` at init logs `mcp_init_connect_failed` and skips the server. The plugin comes up with the servers that worked; the failed one's tools simply don't appear in the catalog. Reconnect continues in the background.
- A failed `callTool` returns `{ ok: false, code: 'MCP_SERVER_UNAVAILABLE' }` which the plugin wraps as a tool-error result (`isError: true` + text content). The model sees a tool failure it can reason about; the chat keeps going.
- Server crash mid-call lands on the same `MCP_SERVER_UNAVAILABLE` path. No chat-terminating exception.
- Reconnect backoff is `1s, 2s, 4s, 8s, 16s`, capped at 16s. A successful `connect()` resets the counter. `disconnect()` clears the pending timer so background retries stop.

The connection class is bus-free on purpose — failures become observable to the rest of the system through the plugin layer, not through a hook this class emits.

## Tool name namespacing

Every MCP tool is re-keyed as `mcp.<serverId>.<sanitized>`:

- Lowercase the whole thing; replace any character outside `[a-z0-9_.-]` with `_`.
- If two of a single server's tools sanitize to the same string, hash-suffix BOTH. Hashing both (rather than "first wins") makes the result independent of `listTools()`'s discovery order, which the spec doesn't guarantee.
- Truncate if the total exceeds 64 chars (the dispatcher's tool-name limit). Pathological serverIds throw.
- A spec-violating MCP server that advertises two tools with identical remote names is rejected at namespacing time with `duplicate-remote-tool` — it would otherwise produce two descriptors that map back to the same namespaced name, losing one of them silently.

Every descriptor is marked `executesIn: 'host'`. MCP tools never execute in the sandbox.

## Boundary review

- **Alternate impl this hook could have:** any other dynamic-tool-source plugin. An OpenAPI-to-tool bridge, an LLM-as-tool plugin, or a Home-Assistant-to-tool adapter would all implement the same producer shape — call `tool:register` per discovered tool at init, then service `tool:execute:${name}` at call time. We're not adding new hook signatures; we're adding a new producer to existing ones.
- **Payload field names that might leak:** `transport` can be `'stdio' | 'streamable-http' | 'sse'`, which is closed MCP vocabulary rather than backend-specific — any MCP-speaking implementation uses the same three names. `credentialRefs` / `headerCredentialRefs` values are opaque credential IDs (shape `^[a-z0-9][a-z0-9_.-]{0,127}$`); they say nothing about whether the backend is env-var, KMS, or Vault.
- **Subscriber risk:** none new. This slice only adds producers to `tool:register` and `tool:execute:${name}`. Existing subscribers (dispatcher catalog, observers) already handle the `executesIn: 'host'` path.
- **Wire surface:** no new IPC actions. The plugin runs host-side; sandboxes invoke MCP tools the same way they invoke any other host tool, through the existing `tool.execute-host` IPC handler.

## Known limits

- **No subprocess sandboxing beyond process isolation.** Stdio MCP servers run with the host's uid, filesystem, and network. A malicious community MCP server could read your home directory. Choose the ones you run carefully. Per-process sandboxing (bubblewrap, seatbelt, or container-per-server) is future work.
- **No resource caps on stdio subprocesses.** A badly-written MCP server can OOM the host or spin CPU. ulimits / cgroups are Week 13+.
- **No TLS cert pinning** for HTTP / SSE transports. We trust the system CA bundle.
- **No OAuth flows** for MCP servers that require them. Bearer tokens via `headerCredentialRefs` work today; OAuth device / auth-code flows are Week 13+.
- **No dynamic config reload.** Adding an MCP server via `ax-next mcp add` today requires a CLI restart to pick it up. Lazy registration of post-init-connected servers is also future work.
- **Per-agent scoping deferred to Week 9.5.** Every configured MCP server is reachable from every agent in the current CLI process. When the auth slice lands, MCP servers will become scopable to specific agents / tenants.
- **SDK transitive-dep surface.** `@modelcontextprotocol/sdk` ships both client and server halves in one package — so `pnpm install` pulls `express` and `hono` even though we only ever construct `Client`. Flagged by the Task 7 reviewer. We accept the cost because forking the SDK to strip the server half would make every future bump a merge conflict, but the audit surface is wider than it needs to be.

## What we don't know yet

- Whether the env allowlist (`PATH`, `HOME`, `LANG`, `LC_ALL`) is the right shape long-term. Some MCP servers will probably break without `USER` or `TMPDIR` and we'll find out which ones by having them fail. We'd rather expand the list deliberately than preemptively.
- Whether the right abstraction for per-agent scoping is "one MCP connection shared across agents with ACL at `tool:execute`" or "one connection per agent." The former is cheaper, the latter is cleaner. Week 9.5 will decide.
- Whether the 16s backoff cap is the right ceiling. For a dev loop it's fast; for an overnight unattended session it might hammer a down server more than we want. We haven't felt the pain yet.
- Whether tool-description scrubbing (for prompt injection embedded in a tool's description) belongs in this plugin or in a dedicated `llm:pre-call` subscriber. Leaning toward the subscriber — this plugin shouldn't editorialize what MCP servers advertise — but we haven't built it yet.
- The exact supply-chain posture of every transitive dep the MCP SDK pulls in. We reviewed direct deps and maintainer set; we have not walked every node_modules entry. The lockfile is committed; re-audit on every SDK bump.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
