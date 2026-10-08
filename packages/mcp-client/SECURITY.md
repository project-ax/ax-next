# Security — `@ax/mcp-client`

This package does three things now, and none of them hand the model a host-side MCP connection:

- **The tool catalog** (`createToolDispatcherPlugin`). Owns `tool:register` / `tool:list` and filters the catalog per agent at list time (`scope.ts`). Pure bookkeeping: no network, no processes, no secrets.
- **The connector tool inventory** (`connectorToolInventory: true`, k8s preset only). The host sends one MCP `tools/list` to a connector's server so the UI can show and permission its tools. This is the one place this package opens network connections, and it gets its own section below.
- **A boot sweep** that deletes retired host MCP server config (next section).

## Host MCP servers retired

Host MCP servers (the `mcp-server:<id>` rows behind `/admin/mcp-servers` and `ax-next mcp`, connected from the host at boot and exposed as `mcp.<serverId>.<tool>` tools) were retired 2026-10-04 (TASK-792), following stdio servers out the door the same day. Connectors cover the need, with per-agent attachment, per-user credentials, OAuth and tool ceilings. At boot the plugin hard-deletes every stored `mcp-server:<id>` row (indexed or orphaned, tombstones included) and `mcp-server-index`, and first deletes every credential whose ref starts with that server's `mcp:<id>:` namespace. An id containing `:` is deleted without a purge, so it can never reach into another server's namespace. If a purge fails, that row (and the index) is kept so the next boot retries, since the row is the only record that those credentials still need cleaning up. The sweep logs only a count, never a row value or a ref. Nothing in this package connects to a configured MCP server, registers a dynamic `tool:execute:*` hook, or mounts an HTTP route any more.

## Security review

- **Sandbox:** No processes spawned, no process environment read, no IPC actions added. The sweep touches only `storage:list-prefix` / `storage:delete` on the `mcp-server:` prefix plus the index key, and `credentials:list` / `credentials:delete` (optional; skipped when absent) on refs in the `mcp:<id>:` namespace. Network reach is limited to the connector inventory, described below.
- **Injection:** Tool descriptors in the catalog come from other plugins and are stored as-is; the scope filter drops malformed `mcp.*` names rather than treating them as native tools. Connector server output is handled in the inventory section below.
- **Supply chain:** Runtime dependencies are `@modelcontextprotocol/sdk` (exact-pinned to `1.30.0`, aligned with the copy `@anthropic-ai/claude-agent-sdk` resolves; no install scripts), `undici` and `ipaddr.js` (the inventory's guarded fetch), `kysely` and `zod`. The SDK ships its client and server halves together, so `pnpm install` pulls `express` and `hono` even though we only construct `Client`. We accept that rather than fork the SDK. The lockfile is committed; re-audit on every SDK bump.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.

## Connector tool inventory (`connectors:describe-tools`, TASK-735)

The k8s preset turns on `connectorToolInventory`, which makes the host itself send one MCP `tools/list` to a connector's http server. This is new: a connector's MCP traffic from a chat session goes through the sandbox and the credential-proxy, but this request starts on the host. Connector URLs are written by workspace admins (only admins create connectors, and every connector is shared). We still treat the URL as hostile: an admin can mistype it, a server can change hands, and a compromised admin account is in the threat model.

- **Sandbox / reach:** The only network destination is the connector server's own origin.
  - The URL must be https, carry no userinfo, and not be `localhost` or a non-public IP literal.
  - Every request must stay on that origin. Any 3xx is refused.
  - The destination IP is checked when the socket connects. A custom `lookup` on a dedicated undici `Agent` refuses the connection if *any* resolved address is private, loopback, link-local (including `169.254.169.254`), CGNAT, ULA, multicast, reserved, NAT64/6to4/teredo, or Azure's `168.63.0.0/16`. It hands the socket exactly the addresses it checked, so DNS rebinding gets no second lookup to race.
  - Limits: a 10 s deadline per request, a 20 s budget per server, 2 MiB per response (counted while streaming, not trusted from `Content-Length`), at most 10 pages and 500 tools.
  - Nothing is spawned for this. It is one HTTP request per server, and stdio servers no longer exist.
- **Credentials:** Header values come from `credentials:get`, using the refs in the connector's own `credentialPlan`. These are the same refs the session's proxy spends, run as the requesting user and agent.
  - When an agent is named, `agents:resolve` must pass first, so a caller cannot borrow another agent's credential scope.
  - Secrets live only in the transport's header map for one listing. They are never logged, stored, or returned.
  - Access is checked through `connectors:resolve` on every call, cache hits included.
- **Injection:** Tool names, titles, descriptions, and the `readOnlyHint` / `destructiveHint` / `openWorldHint` annotations are untrusted descriptions the server writes about itself.
  - Names must be printable ASCII with no whitespace, at most 128 characters. Titles are capped at 200 and descriptions at 2,000. Control characters and bidi-override characters are stripped.
  - `inputSchema` and `outputSchema` are dropped. We call `tools/list` directly instead of `client.listTools()`, so the host never compiles a JSON Schema the server supplied.
  - Hints only choose UI defaults and grouping. They are not a security claim, and nothing enforces policy from them. Renderers must still fence descriptions.
  - Errors are reduced to a short reason code. The server's response text is never echoed.
