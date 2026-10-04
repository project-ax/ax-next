# aisdk runner: connector (HTTP MCP) support — design

**Card:** TASK-826 · **Date:** 2026-10-04 · **Status:** approved in chat, spec under review
**Prereq:** PR #916 / TASK-816 (stdio removed everywhere) — merged d238e71c.

## Goal

An agent on the aisdk runner (`packages/agent-aisdk-runner`) can call the tools of
its attached connectors exactly as a claude-sdk agent can: same model-facing tool
names, same policy keys, same UI labels, same credential path. Remote
streamable-HTTP MCP servers only.

**Success:** an aisdk agent with a connector attached sees `mcp__<ns>__<tool>` in
its tool list, a call goes through `tool.pre-call` as `mcp.<ns>.<tool>`, reaches
the connector through the credential proxy, and the result renders in chat with
the same connector label as on claude-sdk. channel-web offers Add for aisdk
agents.

## Fixed decisions (from the request — not revisited)

- Transport: streamable HTTP only. stdio entries are skipped by name.
- Client: `@modelcontextprotocol/sdk@1.30.0` `Client` + `StreamableHTTPClientTransport`.
  Not `@ai-sdk/mcp`.
- Model-facing name `mcp__<ns>__<tool>`; canonical/policy name `mcp.<ns>.<tool>`.
- Every call through `wrapWithPolicy` → `tool.pre-call`; `assertAllToolsWrapped` holds.
- A connector that fails to connect or list loses only its own tools (stderr line),
  never the session boot.

## Verified context

- The host writes each connector's `.mcp.json` into
  `$CLAUDE_CONFIG_DIR/skills/<id>/` regardless of runner. The only runner gate
  is channel-web's `runnerLoadsConnectors` allow-list.
- The aisdk `Loop.run(ctx)` is **session-scoped**: tools are built once, then a
  `for (;;)` turn loop runs until `nextMessage()` returns null (or a model error
  throws).
- Connector labels (TASK-744) are computed in channel-web from the tool name
  alone (`connectorToolLabel` accepts both spellings) and the aisdk runner
  already emits `part.toolName` verbatim in chunks and persisted blocks. Naming
  the tool `mcp__<ns>__<tool>` is sufficient; no label work in the runner.
- `mergeToolSets` throws at boot on a duplicate name across groups.
- `parity.e2e.test.ts` drives the real `main()` with a scripted model; its test
  "loads a skill declaring mcpServers but tells the model its servers are
  unavailable" pins today's behaviour and is replaced here.

## Approach

Runner-side MCP client, eager connect at session start (mirrors claude-sdk,
which hands the servers to `query()` at boot). Rejected: lazy connect (still
needs `listTools` at boot to offer the tools; adds a reconnect state machine for
nothing) and host-side proxying via `@ax/mcp-client` over IPC (different
credential/egress path from claude-sdk; changes the IPC surface).

## Components

### 1. Shared projection loader — `@ax/agent-runner-core`

Move `packages/agent-claude-sdk-runner/src/projected-mcp-servers.ts` to
`packages/agent-runner-core/src/projected-mcp-servers.ts`, and
`CONNECTOR_TOOL_NAMESPACE_RE` with it. Behaviour is unchanged:

- reads only `$CLAUDE_CONFIG_DIR/skills/*/.mcp.json`; never `.claude/` or the
  agent-writable workspace (I3);
- real directories and regular files only (`lstat`, no symlink follow);
- 256 KB per file;
- only keys matching `/^c[0-9a-f]{10}$/`;
- each entry re-validated with `validateMcpEntry` (stdio refused by name;
  header values must be `ax-cred:` placeholders);
- first namespace wins across bundles;
- never throws.

Output becomes runner-neutral:

```ts
interface ProjectedMcpServer { url: string; headers?: Record<string, string>; bundle: string }
interface ProjectedMcpServers {
  servers: Record<string /* toolNamespace */, ProjectedMcpServer>;
  skipped: string[];
}
```

`bundle` is the skill directory name the server came from. The aisdk Skill note
needs it (§4); claude-sdk ignores it.

- claude-sdk keeps a tiny adapter (`toSdkMcpServers`) mapping to its
  `McpServerConfig` (`{ type: 'http', url, headers? }`), and imports the regex
  from runner-core in `tool-names.ts`.
- `projected-mcp-servers.test.ts` moves to runner-core. claude-sdk keeps a test
  of its adapter, and its `connector-mcp-real-sdk.e2e.test.ts` keeps passing
  unchanged.

### 2. `packages/agent-aisdk-runner/src/tools/connector-tools.ts`

```ts
connectConnectorTools(opts: {
  servers: Record<string, ProjectedMcpServer>;
  fetch: typeof fetch | undefined;     // createProxyFetch(providerEnv)
  policy: ToolPolicy; holdLatch: HoldLatch;
  onHold: (id: string) => void; onToolFailure: (id: string) => void;
  disallowed: readonly string[];       // agentConfig.disallowedTools (canonical)
  log?: (line: string) => void;
  connectTimeoutMs?: number;           // default 10_000
}): Promise<{ tools: Record<string, Tool>; loadedBundles: Set<string>; close(): Promise<void> }>
```

**Connect.**
- For every server, in parallel: create a `new Client({ name: 'ax-aisdk-runner', version })`.
- Use `StreamableHTTPClientTransport(new URL(url), { fetch, requestInit: { headers } })`.
  When `fetch` is undefined (no proxy configured: tests only), the SDK's default
  fetch is used, the same fallback `resolveModel` has.
- Run `connect()` and paginated `listTools()` under one `connectTimeoutMs` bound
  per server, with an AbortSignal on the requests and a race on the whole.
- On failure, timeout or a throw: write one stderr line
  (`runner: connector-mcp: <ns>: <reason>`), `close()` that client
  (best-effort), and contribute no tools.
- Boot latency is bounded by one timeout, not N.

**Per listed tool**, skip with a log line (never rename or mangle) when any of
these holds:
- `mcp__<ns>__<tool>` fails `^[a-zA-Z0-9_-]{1,64}$`. That's the Anthropic
  limit, and OpenAI-compatible providers use the same pattern.
- `inputSchema.type !== 'object'`.
- The name is a duplicate within the same server's list. Otherwise
  `mergeToolSets` would kill the boot.
- The canonical `mcp.<ns>.<tool>` is in `disallowed`. This is TASK-736's F4,
  now reachable. It's hygiene only; enforcement stays at `tool.pre-call`.
- The connector already has 256 tools. Anything beyond the cap is skipped with a
  single summary line.

A server counts as *loaded* (its `bundle` goes into `loadedBundles`) when it
connected and listed successfully, even if every tool was skipped by policy.

**Tool entry:**

```ts
tools[`mcp__${ns}__${t.name}`] = tool({
  description: t.description ?? '',
  inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
  execute: wrapWithPolicy(
    { policy, name: `mcp.${ns}.${t.name}`, isBuiltin: false, holdLatch, onHold, onToolFailure },
    async (input, { abortSignal }) => {
      const res = await client.callTool({ name: t.name, arguments: input }, undefined,
        { signal: abortSignal, timeout: 300_000, resetTimeoutOnProgress: true });
      const text = renderMcpResult(res);
      if (res.isError === true) throw new Error(text);   // parity: tool-error, turn continues
      return text;
    }),
});
```

- `WrapWithPolicyOptions.name`'s doc comment is updated: connector tools are the
  one case where the record key and the policy name differ.
- `renderMcpResult` treats the result as untrusted output. It returns a string
  and only a string:
  - text parts are joined with `\n`;
  - an embedded resource contributes its `text`, or `[resource <uri> omitted]`;
  - image, audio or other parts become `[<type>: <mimeType> omitted]`;
  - when there's no content, `structuredContent` is JSON-stringified;
  - output is capped at 100 KB with a `[output truncated at 100 KB]` suffix.
- A transport error, a server crash or a timeout throws. ai@7 turns that into a
  `tool-error` and the turn continues.

**`close()`** closes every connected client concurrently, bounded at 5s total,
and never throws.

### 3. `main.ts` wiring

- Build `const proxyFetch = createProxyFetch(proxyStartup.providerEnv)` once.
  Hand it to `resolveModel` through its existing `fetchImpl` option (so one dispatcher serves
  both) and to `connectConnectorTools`.
- In `run(ctx)`:
  1. after skill discovery, call `loadProjectedMcpServers(process.env.CLAUDE_CONFIG_DIR)`;
  2. call `connectConnectorTools(...)`;
  3. add a fifth `mergeToolSets` group, `'connector tools'`;
  4. `assertAllToolsWrapped(tools, holdLatch)` runs unchanged over the merged set.
- Wrap the `for (;;)` turn loop in `try { … } finally { await connectors.close() }`.
  That covers cancel and idle (`nextMessage()` → null), a thrown model error,
  and a thrown boot step after connect.

### 4. Skill tool note

`MCP_UNAVAILABLE_NOTE` and the discovery log ("this runner has no MCP client")
become false and are replaced:

- `skills-index.ts` keeps `hasMcpServers` and drops the "no MCP client" log line.
- `buildSkillTool` takes `loadedBundles: ReadonlySet<string>`. A skill with
  `hasMcpServers && !loadedBundles.has(skill.id)` gets the new exported
  `MCP_NOT_LOADED_NOTE`, roughly: "this skill's connector tools could not be
  loaded this session (the connection failed or was refused). Don't call tools
  it names that aren't in your tool list; say which steps you couldn't do."
- Skills whose servers loaded get no note.

### 5. channel-web

- `runnerLoadsConnectors` returns `runner === undefined || runner === 'claude-sdk' || runner === 'aisdk'`.
  It stays an allow-list, per TASK-761.
- Update its comment and the doc comments at `lib/workspace-types.ts` (~1134)
  and `lib/agent-connectors.ts` (~59).
- `routes-workspace-connectors.test.ts` "says whether the agent's runner can use
  connectors at all": aisdk becomes `true`, and `'something-new'` stays `false`.
- The UI tests for the unsupported state are driven by mocks and stay as they
  are; that state still exists for unknown runners.

### 6. Dependencies

- `@ax/agent-aisdk-runner` adds `"@modelcontextprotocol/sdk": "1.30.0"` (exact
  pin; already in the lockfile via `@ax/mcp-client`, `@ax/mcp-oauth` and
  `@ax/test-harness`).
- It also adds `@ax/test-harness` as a devDependency for the stub.
- No new transitive packages. The lockfile diff will be checked to confirm that.

## Error handling summary

| Failure | Effect |
|---|---|
| Malformed / symlinked / oversized `.mcp.json`, bad key, invalid entry | loader skips + logs; other connectors unaffected |
| Connect / list throws or exceeds 10s | that connector's tools absent; stderr line; Skill note for its bundle |
| Illegal/over-long name, non-object schema, duplicate, denied, over cap | that tool skipped + logged |
| `callTool` `isError: true` | thrown → `tool-error`, `is_error` on persisted result, turn continues |
| Transport error / server crash / 5-min timeout / Stop | thrown → failed tool call, turn continues |
| Policy deny / hold | unchanged `wrapWithPolicy` behaviour (text result / latch) |
| Session end (cancel, idle, model error) | `finally` closes all clients, bounded |

## Testing (TDD)

1. **Shared loader (runner-core):** the moved tests, plus:
   - a stdio entry is skipped by name;
   - a symlinked bundle dir and `.mcp.json` are refused;
   - a non-namespace key is ignored;
   - the first duplicate namespace wins;
   - a decoy `.claude/skills/x/.mcp.json` in cwd is never read;
   - `bundle` is reported.
2. **claude-sdk:**
   - an adapter test;
   - the existing `projected-mcp-servers`, `tool-names` and real-SDK e2e tests
     stay green after the import move.
3. **`connector-tools.test.ts`.** Most cases run against `startMcpHttpServerStub()`
   (echo/crash). A small inline streamable-HTTP server (built with the SDK's
   `McpServer`) covers `isError`, header capture, a 70-char tool name, a
   duplicate name and a non-object schema. Cases:
   - tools are keyed `mcp__<ns>__<tool>`;
   - a fake `ToolPolicy` sees `mcp.<ns>.echo`;
   - echo round-trips;
   - crash gives a thrown failure, and the other connector still works;
   - `isError` throws with the server's text;
   - a denied `mcp.<ns>.echo` is not offered;
   - an unreachable URL plus a hanging server (accepts, never responds) drop only
     their tools within the bound, and their bundles are not in `loadedBundles`;
   - the over-long name is skipped with a log;
   - `close()` resolves;
   - **credential:** the injected `fetch` sees the `ax-cred:<32hex>` header value
     verbatim, and the server receives the placeholder. Real secrets exist only
     past the proxy, which isn't present here; the test asserts that the runner
     process only ever holds the placeholder.
4. **`skill-tool.test.ts`:** the note is present for a skill whose bundle didn't
   load and absent for one that did. `MCP_UNAVAILABLE_NOTE` is removed.
5. **Acceptance (invariant 3), `parity.e2e.test.ts`:**
   - Replace the "servers are unavailable" test with a real `main()` run.
   - Install a connector bundle whose `.mcp.json` points at an inline MCP HTTP
     stub (`c<10hex>` key).
   - The scripted model calls `mcp__<ns>__ping`.
   - Assert that the IPC `tool.pre-call` saw `mcp.<ns>.ping`, the tool result
     carries `pong`, the `tool-use` chunk and persisted `tool_use` block carry
     `mcp__<ns>__ping`, and `assertAllToolsWrapped` passed (boot succeeded).
   - A second case: the connector URL is dead, and the session still boots and
     answers.
6. **channel-web:** the flipped server test; aisdk reports `connectorsSupported: true`.
7. **Gate:**

   ```
   pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
   ```

   Run with `DOCKER_HOST=unix:///var/run/docker.sock`, plus `tsc` for the touched
   packages.

## Boundary review

No hook-surface change. `tool.pre-call` payloads, IPC actions and
`AgentConfig` are untouched. The connector names `mcp.<ns>.<tool>` and
`mcp__<ns>__<tool>` already flow from claude-sdk. The loader moves within
runner-core, a shared library rather than a plugin, so invariant 2 isn't
touched.

## Security notes (for the PR's security-checklist block)

- **Sandbox / capability:**
  - **New egress:** runner → the URLs in the host-written projection, only
    through `createProxyFetch`'s undici `ProxyAgent`. The credential proxy
    enforces its allowlist and does the placeholder substitution.
  - **Filesystem:** reads only the 0555/0444 projection, with no symlink
    following and a size cap.
  - No process spawn and no env reads by caller-supplied name.
- **Injection:**
  - Untrusted inputs are the server's tool names, descriptions, schemas and
    results.
  - Names are regex-gated, and are never used in a path, command or URL.
  - Descriptions and schemas go only into the provider's tool list, which is the
    same exposure as claude-sdk.
  - Results become a size-capped string tool result, never a system
    instruction. Policy (`tool.pre-call`) gates every call.
- **Supply chain:** exact-pinned `@modelcontextprotocol/sdk@1.30.0`, already
  resolved in the lockfile; no new transitive packages (verified in the
  lockfile diff).

## Out of scope

- stdio, SSE and OAuth client flows in the runner. Tokens arrive as proxy
  placeholders.
- MCP resources, prompts and sampling.
- Image tool results passed to the model as images. They become text
  placeholders for now.
- A kind walk (optional per the request).
