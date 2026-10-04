# Drop stdio MCP servers everywhere

**Status:** design, 2026-10-04 (Vinay). Prerequisite for aisdk-runner connector support (HTTP-only).

## Why

An stdio MCP server is code we fetch and run (usually `npx some-mcp-server`, unpinned) on every
session start — in the sandbox for connectors, and **on the host** for `@ax/mcp-client`. HTTP MCP
runs no third-party code on our side and reaches exactly one URL through the credential proxy.

Stdio also costs us visibility: the host cannot list an stdio server's tools, so the connectors rail
shows `unknown` for per-tool verdicts and read-only hints. And it doubles every MCP code path
(materializer, `validateMcpEntry`, both runners, the legacy editor, mcp-client transports).

The product already moved to admin-defined remote connectors. The aisdk runner is about to gain
connector support and should only ever need HTTP.

## Decisions

1. **stdio is removed from every surface**: connectors, connector drafts (`connector_propose`), the
   sandbox projection, both runners, host-side `@ax/mcp-client`, the `ax mcp` CLI, the admin UI.
   mcp-client keeps `streamable-http` and `sse`; everything else keeps `http`.
2. **Existing stdio rows are hard-deleted** by a one-time, idempotent sweep. No lenient-read schema,
   no "legacy" UI state. Not reversible — accepted.
3. **Reads stay strict.** After the sweep there is one schema per surface, and it has no stdio arm.

## Design

### A. Schemas (the single change that closes write paths)

Narrow each transport union to HTTP and delete the stdio-only fields (`command`, `args`, `env`):

| Schema | File |
| --- | --- |
| `McpServerSpecSchema` (connectors + drafts) | `connectors/src/types.ts:124-133` |
| `McpServerSchema` (sandbox wire) | `sandbox-protocol/src/schemas.ts:77-137` |
| `SkillProposeMcpSchema` (deprecated, ignored) | `ipc-protocol/src/actions.ts:1041-1050` |
| skills-parser `CapabilitiesSchema` / interface | `skills-parser/src/capabilities.ts:27-35, 106-128` |
| `McpServerConfigSchema` (`StdioConfig` arm) | `mcp-client/src/config.ts:60-93` |
| structural mirrors | `chat-orchestrator/src/connector-union.ts:56-66`, `orchestrator.ts:469-479`, `channel-web/src/lib/connectors.ts:61`, `mcp-client/src/connector-inventory/describe-tools.ts:85` |
| runner validator | `agent-runner-core/src/installed-skills.ts` `validateMcpEntry` + golden vectors `sandbox-protocol/src/__tests__/fixtures/mcp-server-golden-vectors.json` |

Narrowing `McpServerSpecSchema` alone closes the admin create/update routes, `connector_propose`
(`assembleProposal` → `validateCapabilities`) and the approve-promote path
(`orchestrator.ts:4029-4046`), because all three go through `validateCapabilities`. The rejection
message names the fix: *"Local (stdio) MCP servers are no longer supported. Use a remote MCP
server URL."*

### B. Sweep existing data (hard delete)

Runs once per boot in each owning plugin's `init`, after its migration, before it serves hooks.
Idempotent: a second boot finds nothing. Each step logs a count (`*_stdio_swept`), never row
contents.

- **`@ax/connectors` — live connectors** (`connectors_v1_connectors`, including tombstones). The
  sweep looks for rows whose `capabilities.mcpServers` has any entry with `transport = 'stdio'`. It
  reads raw JSONB, not through `rowToConnector`, which would throw. For each live row it runs the
  same cleanup `deleteConnector` does:
  - purge the connector's credential refs, global ones included, because this is system cleanup
    rather than a user action;
  - fire `connectors:deleted`, so `@ax/tool-policy` purges its per-tool verdict rows.

  Then it `DELETE`s the row. That cleanup is factored out of `deleteConnector` so the sweep can
  call it without the caller-auth wrapper. The function signature and hook surface don't change.
- **`@ax/connectors` — drafts** (`connectors_v1_authored`): `DELETE` rows whose
  `capability_proposal.mcpServers` has a stdio entry. A pending draft grants no reach, so nothing
  else needs cleaning.
- **`@ax/mcp-client` — key/value configs.** On init, the plugin deletes every `mcp-server:<id>`
  row whose raw JSON has `transport: 'stdio'`, purges its env credential slots (the existing
  `purgeMcpCredentials`), and rewrites `mcp-server-index`. `loadConfigs` already skips rows that
  don't parse, so the sweep runs before it.

**Left untouched:**
- Agent `connector_attachments` / `connector_exclusions` ids. They dangle exactly as they do after
  a normal delete, and resolution already ignores unknown ids.
- mcp-oauth tokens. A stdio server has no OAuth, so there are none.

### C. Projection and runners

- `agent-runner-core/src/installed-skills.ts`: drop the stdio branch of `toMcpJsonShape` and the
  stdio checks in `validateMcpEntry`.
- `sandbox-subprocess/src/open-session.ts:125-138`: drop the stdio branch of its `toMcpJsonShape`.
- `agent-claude-sdk-runner/src/projected-mcp-servers.ts`: `toEntry` maps only `type: 'http'`. A
  missing or stdio `type` is now skipped and logged, not run. `toSdkConfig` becomes http-only.
- `agent-claude-sdk-runner/src/interrupt-processes.ts` keeps its startup-process protection. It
  also guards SDK-internal children, so removing it is a separate question (out of scope).
- `mcp-client/src/transports.ts`: remove `StdioClientTransport`, `StdioParams`, `baseStdioEnv`,
  `buildStdioParams`, `BASE_STDIO_ENV_KEYS` and the `case 'stdio'`. `admin-routes.ts`:
  `envNamesOf` goes, and credential purge runs on header slots only.
- `connectors/src/admin-routes.ts:256-298` (`probeConnector`): a lead MCP server needs a `url`.
- `connectors/src/tool-namespace.ts` `endpointOf` and the channel-web mirror
  (`lib/connector-form.ts:318-330`): drop `command`/`args`. The namespace hash never included the
  transport, so existing namespaces and verdicts are unchanged.
- `skill-broker/src/tools/capability-freshness.ts:389-396`: drop `command`/`args`/`env` from the
  digest.

### D. CLI

`cli/src/commands/mcp.ts`: `add` rejects stdio through `parseConfig` (no special case needed), and
`list` prints only the `url`.

### E. UI (channel-web)

- `LegacyConnectorEditDialog.tsx` stays: it still edits Direct-API and CLI connectors. Remove its
  stdio transport option, the Command/Args fields, the "env vars" secrets wording and the command
  endpoint-change copy.
- `ConnectorEditDialog.tsx:53-55`: send any MCP-backed connector to `RemoteMcpConnectorForm`. The
  legacy dialog only handles connectors with no `mcpServers`.
- `lib/connector-form.ts`: the `Transport` type and the stdio branch go. The default transport (now
  `'stdio'`, lines 148 and 233) becomes `'http'`.
- `lib/connectors.ts:533` `mechanismHint`: the `'env var'` arm goes.
- Mocks: `mock/admin/connectors.ts`, `mock/admin/mcp-servers.ts`.

### F. Model-facing copy

- `tool-connector-propose/src/descriptor.ts:32,45`: "backed by a remote MCP server (http URL)".
- `presets/k8s/src/builtin-skills/ax-connector-creator/SKILL.md:59-60`: stop offering stdio.
- `agent-aisdk-runner/src/skills-index.ts` and `tools/skill-tool.ts` comments: left as they are
  until the aisdk-connector card replaces them.

### G. Docs

Update `packages/mcp-client/SECURITY.md`, `deploy/MANUAL-ACCEPTANCE.md:1220-1240`,
`packages/agent-aisdk-runner/README.md:93`, and the code comments at `connectors/src/types.ts:22-25`
and `test-harness/src/index.ts:30-46`. Historical `docs/plans/*`, memory shards and the
`deploy/gke/*acceptance*.json` records are left as they are, because they describe what was true
then.

## Testing

- **Rejection, per write path:**
  - connectors admin create and update;
  - `connector_propose`;
  - approve-promote of a draft that was stored with stdio before narrowing (sweep-first makes this
    unreachable, so the test asserts the sweep removed it);
  - mcp-client admin create and patch;
  - `ax mcp add`;
  - `OpenSessionInputSchema`;
  - `validateMcpEntry`.
- **Sweep tests:**
  - **connectors:** a seeded live stdio row and a tombstoned one are deleted. Credential purge and
    `connectors:deleted` (carrying the right `toolNamespaces`) fire for the live row only. A mixed
    owner's http connector survives. `connectors:list-effective` works afterwards. That last point
    is the regression this guards: one stdio row used to make the whole list throw and silently
    zero the agent's connectors.
  - **drafts:** a pending stdio draft is deleted; `list-authored-pending` works.
  - **mcp-client:** a stdio key/value row is deleted, the index is rewritten, and the slots are
    purged.
  - **Idempotent:** running a second time is a no-op.
- **Replace the coverage we lose.** `cli/src/__tests__/mcp-stdio.e2e.test.ts` is the only
  end-to-end test of host mcp-client call / crash / recovery (`MCP_SERVER_UNAVAILABLE`).
  - Port `test-harness/src/mcp-server-stub.ts` to a streamable-HTTP stub on an ephemeral port, with
    the same `echo` and `crash` tools. `crash` kills the listener, so recovery is still exercised.
  - Rewrite the e2e as `mcp-http.e2e.test.ts`.
- **Golden vectors:** delete the stdio vectors, and add "transport stdio → rejected" vectors so
  the sandbox-protocol and runner validators stay in lockstep.
- **Untouched:** `agent-claude-sdk-runner/src/__tests__/interrupt-real-sdk.e2e.test.ts` hands a
  stdio probe directly to the SDK's `query()` without going through AX config. It tests the
  interrupt machinery, not a product path, so it stays.
- **Gate:** `pnpm build`, `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`,
  and `pnpm lint`.

## Boundary review

- **Hook payloads change.** `connectors:*` capabilities, `connectors:install-authored`, the
  `connectors:resolve` output and the sandbox `OpenSessionInput` all narrow `transport` to
  `'http'` and lose `command`/`args`/`env`. Narrowing removes vocabulary and adds none, so no new
  field names can leak.
- **Alternate implementation:** unchanged. The connectors abstraction is mechanism-agnostic (MCP
  over http, CLI package, direct API).
- **Subscriber risk:** a subscriber that branched on `transport === 'stdio'` loses a dead arm. None
  depend on stdio for correctness; the fold already binds headers and OAuth only to http servers.
- **Wire surface:** `SkillProposeMcpSchema` stays in `ipc-protocol` (deprecated and ignored), and
  only narrows.

## Security note (summary — the full security-checklist goes in the PR)

- **Sandbox escape:** risk goes down. The host no longer spawns processes for MCP (mcp-client), and
  the sandbox no longer runs unpinned MCP packages at session start.
- **Prompt injection:** unchanged. MCP tool output is still treated as untrusted.
- **Supply chain:** risk goes down. `npx` fetches at session start are gone, and no dependencies
  are added. `StdioClientTransport` becomes an unused export of the already-pinned
  `@modelcontextprotocol/sdk`.
- **Sweep:** it purges global credentials without an admin actor. That is deliberate system cleanup,
  limited to the refs that belong to stdio connectors (the same derivation `deleteConnector` uses).

## Out of scope

- Adding connector support to the aisdk runner. That's the next card, HTTP-only, and it depends on
  this one.
- Simplifying `interrupt-processes.ts`.
- Pruning dangling attachment ids from agents (that's existing behavior for any delete).
