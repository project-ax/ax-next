# Security — `@ax/mcp-client`

This package does four things now. None of them hands the model a host-side MCP connection. Two of them do have the host itself talk to a connector's MCP server: to list its tools, and to make one call a person approved.

- **The tool catalog** (`createToolDispatcherPlugin`). Owns `tool:register` / `tool:list` and filters the catalog per agent at list time (`scope.ts`). Pure bookkeeping: no network, no processes, no secrets.
- **The connector tool inventory** (`connectorToolInventory: true`, k8s preset only). The host lists a connector server's tools so the UI can show and permission them.
- **Approved connector calls** (the same flag). When a person approves a connector call held during a task run, so no live agent will make it, the host makes that one call itself.
- **A boot sweep** that deletes retired host MCP server config (next section).

The inventory and approved calls are the only places this package opens network connections. Each gets its own section below.

## Host MCP servers retired

Host MCP servers (the `mcp-server:<id>` rows behind `/admin/mcp-servers` and `ax-next mcp`, connected from the host at boot and exposed as `mcp.<serverId>.<tool>` tools) were retired 2026-10-04 (TASK-792), following stdio servers out the door the same day. Connectors cover the need, with per-agent attachment, per-user credentials, OAuth and tool ceilings. At boot the plugin hard-deletes every stored `mcp-server:<id>` row (indexed or orphaned, tombstones included) and `mcp-server-index`, and first deletes every credential whose ref starts with that server's `mcp:<id>:` namespace. An id containing `:` is deleted without a purge, so it can never reach into another server's namespace. If a purge fails, that row (and the index) is kept so the next boot retries, since the row is the only record that those credentials still need cleaning up. The sweep logs only a count, never a row value or a ref. Nothing in this package connects to one of those servers, registers a dynamic `tool:execute:*` hook, or mounts an HTTP route any more.

## Security review

- **Sandbox:** No processes spawned, no process environment read, no IPC actions added. The sweep touches only `storage:list-prefix` / `storage:delete` on the `mcp-server:` prefix plus the index key, and `credentials:list` / `credentials:delete` (optional; skipped when absent) on refs in the `mcp:<id>:` namespace. Network reach is limited to the connector inventory and approved connector calls, both described below.
- **Injection:** Tool descriptors in the catalog come from other plugins and are stored as-is; the scope filter drops malformed `mcp.*` names rather than treating them as native tools. Connector server output is handled in the two connector sections below.
- **Supply chain:** Runtime dependencies are `@modelcontextprotocol/sdk` (exact-pinned to `1.32.1`; no install scripts), `undici` and `ipaddr.js` (the inventory's guarded fetch), `kysely` and `zod`. The SDK ships its client and server halves together, so `pnpm install` pulls `express` and `hono` even though we only construct `Client`. We accept that rather than fork the SDK. The lockfile is committed; re-audit on every SDK bump. Other host plugins can call `connectors:call-tool` too; that residual is named at the end of its section.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.

## Connector tool inventory (`connectors:describe-tools`, TASK-735)

The k8s preset turns on `connectorToolInventory`, which makes the host itself list a connector's tools. A connector's MCP traffic from a chat session goes through the sandbox and the credential-proxy, but this listing starts on the host. Connector URLs are written by workspace admins (only admins create connectors, and every connector is shared). We still treat the URL as hostile: an admin can mistype it, a server can change hands, and a compromised admin account is in the threat model.

- **Sandbox / reach:** The only network destination is the connector server's own origin.
  - The URL must be https, carry no userinfo, and not be `localhost` or a non-public IP literal.
  - Every request must stay on that origin. Any 3xx is refused.
  - The destination IP is checked when the socket connects. A custom `lookup` on a dedicated undici `Agent` refuses the connection if *any* resolved address is private, loopback, link-local (including `169.254.169.254`), CGNAT, ULA, multicast, reserved, NAT64/6to4/teredo, or Azure's `168.63.0.0/16`. It hands the socket exactly the addresses it checked, so DNS rebinding gets no second lookup to race.
  - Limits: a 10 s deadline per request, a 20 s budget per server, 2 MiB per response (counted while streaming, not trusted from `Content-Length`), at most 10 pages and 500 tools.
  - The shared core response cap aborts the listing immediately when a read exceeds its budget, including event-stream responses the SDK would otherwise leave pending. Refusals use a fixed size reason, and unsupported HTTP reason-phrase characters are omitted.
  - Nothing is spawned for this. Each listing has an initialization exchange and bounded pagination; stdio servers no longer exist.
- **Credentials:** Header values come from `credentials:get`, using the refs in the connector's own `credentialPlan`. These are the same refs the session's proxy spends, run as the requesting user and agent.
  - When an agent is named, `agents:resolve` must pass first, so a caller cannot borrow another agent's credential scope.
  - Secrets live only in the transport's header map for one listing. They are never logged, stored, or returned.
  - Access is checked through `connectors:resolve` on every call, cache hits included.
- **Injection:** Tool names, titles, descriptions, and the `readOnlyHint` / `destructiveHint` / `openWorldHint` annotations are untrusted descriptions the server writes about itself.
  - Names must be printable ASCII with no whitespace, at most 128 characters. Titles are capped at 200 and descriptions at 2,000. Control characters and bidi-override characters are stripped.
  - `inputSchema` and `outputSchema` are dropped. We call `tools/list` directly instead of `client.listTools()`, so the host never compiles a JSON Schema the server supplied.
  - Hints only choose UI defaults and grouping. They are not a security claim, and nothing enforces policy from them. Renderers must still fence descriptions.
  - Errors are reduced to a short reason code. The server's response text is never echoed.

## Approved connector calls (`connectors:call-tool`, TASK-1046)

Sometimes an agent in a task run asks to use a connector tool, we hold the call for a person, and by the time they say yes the run is over. Someone still has to make the call they approved. Since TASK-1046, that's the host. It makes that one call itself, as the person and agent the call belonged to. The same `connectorToolInventory` flag turns it on, so only the k8s preset has it.

- **Intended caller:** `@ax/decisions`, after a decision's owner approves a call held during a task run. (A call held in a chat stays the agent's: its next turn makes it.) That is a convention, not a check. See the residual at the end of this section.
  - What is enforced: `connectors:call-tool` is a named service hook. It is not an IPC action, not a `tool:execute:*` hook (the sandbox reaches every one of those through `tool.execute-host`), and not in the tool catalog. The sandbox has no way to call it.
  - The caller's context must name the same user and agent as the request, and an owner-less user or agent gets nothing. That catches a confused caller, not a hostile one: host code can build any context it likes.
- **Authorization:** re-derived from the decision's user and agent on every call, never from whoever approved it. Nothing is sent until every check passes:
  - the agent must still resolve for that user (`agents:resolve`);
  - the tool's namespace must belong to a connector in the agent's effective set (`connectors:list-effective`, with the agent's own attachments and exclusions). A detached connector fails here. So does one a skill brought in, because that set does not carry it;
  - `connectors:resolve` must still resolve that connector and still carry the namespace;
  - the server URL must pass the inventory's URL rules and carry no fragment, and its host must be in the connector's `allowedHosts` (an exact match, the session proxy's rule). So the host never reaches anywhere the sandbox couldn't.
- **Reach:** the inventory's guarded fetch and origin rules, unchanged. One `tools/call`, never retried: no 401 renewal, no resumed stream.
  - Limits: 30 s per request, 45 s in all, 2 MiB per response.
  - The 45 s count from when the hook starts, its own reads included. With less than 15 s left, it sends nothing.
- **Credentials:** the refs in the connector's own `credentialPlan`, read through `credentials:get` as the user and agent. Those are the refs, and the scope walk, that a session's credential-proxy spends. They live in one transport's header map for one call. They are never logged, stored, or returned.
- **Injection:** the arguments are the approved call's recorded input, sent unchanged. That's the promise: the person approved exactly those bytes. `@ax/decisions` keeps it by asking for the call only when the person was shown the whole request: a long one the approval card cut short parks for the agent instead.
  - The reply is read only for `isError`, through a minimal local schema. We never call `client.callTool()`, so the host never compiles a schema the server supplied. The reply's content is dropped unread.
  - Failures are short codes (`not-connected`, `needs-auth`, `rejected`, …), never the server's text. The bus holds the hook's answer to those shapes.
  - One `connector_call_tool` line per call: the connector id and the code. A credential read failure also logs the shared header builder's `connector_inventory_credential_unavailable` line, with the connector id and an error code. Neither ever carries the input, a header, the URL, or the reply.
- **Exactly-once:** `@ax/decisions` claims the decision row before it calls, and nothing here retries. A call that went out and got no reliable answer (a timeout, a reset, a 5xx, a redirect, an oversize reply) comes back `unknown`, and the person is told we can't say whether it finished. We'd rather admit that than have them approve it twice.
- **Residual (supply chain: third-party host plugin code):** nothing stops another host plugin from calling this hook.
  - Every plugin gets the same bus. A manifest's `calls` list orders boot; it does not gate calls.
  - A context is one `makeAgentContext` away, and the request carries no proof that anyone approved anything.
  - The hook runs no tool-policy check. That's its caller's job: `@ax/decisions` re-checks the policy just before it calls.

  So a buggy or hostile host plugin could make a connector call nobody approved. Everything above still bounds it: the call can only go where a session of that agent could go, with that agent's own credentials, once, and nothing the server says comes back. We accept the residual because host plugins already run in the host with this much reach (any of them can call `credentials:get` as well). The guard here is which plugins we load, not this hook.
