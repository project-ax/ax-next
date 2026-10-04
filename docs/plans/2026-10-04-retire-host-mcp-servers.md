# Retire host MCP servers (TASK-792)

Owner decision 2026-10-04, option (b): host MCP servers (`@ax/mcp-client`'s
`mcp-server:<id>` rows, `/admin/mcp-servers`, `ax-next mcp`) are retired the
same way TASK-816 (#916) retired stdio MCP servers. Connectors cover the need
(attach-per-agent, per-user credentials, OAuth, tool ceilings).

## Verified before starting

- No preset, test fixture, skill or the CLI dev loop registers a host MCP server
  programmatically. The only writers are `POST /admin/mcp-servers` (no UI since
  the `lib/admin.ts` wrappers were removed) and the user-driven `ax-next mcp add`
  CLI subcommand, both of which this card removes.
- Connector tools never touch `config.ts` / `connection.ts` / `transports.ts`:
  the inventory lists through `connector-inventory/list-tools.ts` (its own
  guarded fetch), and connector tool calls run in the sandbox from the projected
  `.mcp.json`.

## What stays in `@ax/mcp-client`

- `createToolDispatcherPlugin` (`tool:register` / `tool:list`, `catalog.ts`,
  `scope.ts`).
- `connector-inventory/*` (`connectors:describe-tools`,
  `connectors:inventory-status-batch`, `connectors:inventory-tool-titles`,
  `agents:deleted` purge).
- A boot sweep, so the plugin is not half-wired in the CLI preset.

## Tasks

1. **mcp-client core.** New `host-server-sweep.ts`: `storage:list-prefix`
   `mcp-server:` finds every stored row (indexed or orphaned, tombstones
   included); for each id, purge every credential whose ref starts with
   `mcp:<id>:`; hard-delete the row with `storage:delete`; delete
   `mcp-server-index` once every row is gone. A failed purge keeps that row
   (and the index) for the next boot. Logs only when it removed something.
   Delete `admin-routes.ts`, `config.ts`, `connection.ts`, `transports.ts`,
   `tool-names.ts`, `stdio-sweep.ts` and their tests. `plugin.ts` drops the
   loader, the admin routes and their options; manifest drops `tool:register`,
   `storage:get`, `storage:set`, `credentials:get`, `http:register-route`,
   `auth:require-user`; adds `storage:list-prefix`, `storage:delete` (calls)
   and `credentials:list` / `credentials:delete` (optionalCalls, for init order).
2. **CLI.** Remove `ax-next mcp` (`commands/mcp.ts`, `mcp-cli.test.ts`,
   `mcp-http.e2e.test.ts`, the argv branch, help text). Keep
   `createMcpClientPlugin()` so a local sqlite store gets swept.
3. **k8s preset.** `createMcpClientPlugin({ connectorToolInventory: true })`;
   preset/acceptance pins and comments.
4. **`mcp-header` credential destination kind removed** (credentials refs,
   credentials-admin-routes, channel-web), mirroring #916's `mcp-env` removal.
5. **channel-web mock.** Delete `mock/admin/mcp-servers.ts`, its test, seed
   collection and server wiring.
6. **Docs + memory + changeset.** mcp-client SECURITY.md, current-architecture,
   tool-policy comments that cite host MCP servers, changeset, memory shards.

## Not in scope (follow-up)

- `agents.mcpConfigIds` (and the `mcpConfigIds` arm of the empty-scope
  wildcard) is now dead vocabulary threaded through agents, sessions, sandbox
  protocol and channel-web. Removing it is a schema migration on its own card.
- `implicitMcpCeiling` keeps holding any non-connector `mcp.`/`mcp__` name.
