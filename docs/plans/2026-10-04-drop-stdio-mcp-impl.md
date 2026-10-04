# Drop stdio MCP servers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `stdio` MCP transport from every AX surface and hard-delete existing stdio rows, leaving HTTP (and mcp-client's `streamable-http`/`sse`) as the only MCP transports.

**Architecture:** Two boot-time sweeps run first — one in `@ax/connectors`, one in `@ax/mcp-client` — and remove stored stdio rows by reading the raw JSON. Sweeping first keeps every intermediate commit safe. After that, each transport union is narrowed. Narrowing `@ax/connectors`' `McpServerSpecSchema` alone closes the admin, `connector_propose` and approve paths. The wire schema and runner validator move together under the shared golden-vector fixture. The stdio end-to-end test is rebuilt on a streamable-HTTP stub before mcp-client loses stdio.

**Tech Stack:** TypeScript, zod 3, kysely/postgres (connectors), `@modelcontextprotocol/sdk@1.30.0` (already pinned), vitest, React + shadcn (channel-web).

**Spec:** `docs/plans/2026-10-04-drop-stdio-mcp-design.md`

**Worktree:** `/Users/vpulim/dev/ai/ax-next-drop-stdio`, branch `drop-stdio-mcp`. Run every command from the worktree root unless a step says otherwise.

## Global Constraints

- **The user-facing rejection message for connectors is exactly:** `Local (stdio) MCP servers are no longer supported. Use a remote MCP server URL.`
- **Transports that remain:**
  - connectors, sandbox wire, runner, skills-parser, ipc-protocol, chat-orchestrator, channel-web: `'http'`
  - mcp-client: `'streamable-http' | 'sse'`
- **The sweeps hard-delete.** They log one count line per kind (`connectors_stdio_swept`, `connectors_authored_stdio_swept`, `mcp_stdio_configs_swept`) and never log row contents.
- **No new dependencies.** `@modelcontextprotocol/sdk` stays at `1.30.0`.
- **Leave `skill-broker/src/tools/capability-freshness.ts` alone.** It hashes `command`/`args`/`env` into a digest that is compared against stored digests. Changing the shape would mark every approved skill stale. This overrides spec › C's "drop `command`/`args`/`env` from the digest"; the spec is updated to match.
- **`pnpm --filter` goes BEFORE the script name:** `pnpm --filter @ax/connectors test`.
- **Commits:** end every message with
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019Uma98cxgVqkLaEPFwKUXE
  ```
- **Docker:** connectors tests use a postgres testcontainer and need `DOCKER_HOST` set (see `CLAUDE.md` › Docker-backed tests).

## Review Focus

1. **A user who has both an http and a stdio connector.** After boot the http one must still resolve, and `connectors:list-effective` must not throw. Today one stdio row makes the whole list throw, and the orchestrator silently gives the agent zero connectors. Pinned in Task 2.
2. **A shared stdio connector with a workspace (global) key.** The sweep must purge the global credential ref, but only refs that belong to that connector. Pinned in Task 2.
3. **Booting twice.** The second boot must sweep nothing and log a count of 0. Pinned in Tasks 2 and 5.
4. **A garbage capabilities JSON** (not even the sweep's shape) that has `transport: 'stdio'` somewhere. The row is still deleted, the credential purge is skipped, and nothing throws. Pinned in Task 2.
5. **An admin editing an existing Direct-API or CLI connector.** It must still open in `LegacyConnectorEditDialog`. Every MCP-backed connector must open in `RemoteMcpConnectorForm`. Pinned in Task 6.

---

### Task 1: Wire schema, runner validator, projection — http only

**Files:**
- Modify: `packages/sandbox-protocol/src/schemas.ts:30-38, 72-137`
- Modify: `packages/sandbox-protocol/src/__tests__/fixtures/mcp-server-golden-vectors.json`
- Modify: `packages/agent-runner-core/src/installed-skills.ts:55-264`
- Modify: `packages/sandbox-subprocess/src/open-session.ts:118-138`
- Modify: `packages/agent-claude-sdk-runner/src/projected-mcp-servers.ts:63-84`
- Modify: `packages/skills-parser/src/capabilities.ts:27-35, 106-116`
- Modify: `packages/ipc-protocol/src/actions.ts:1041-1050`
- Test: `packages/sandbox-protocol/src/__tests__/mcp-server-drift.test.ts`, `packages/agent-claude-sdk-runner/src/__tests__/mcp-server-drift.test.ts` (both driven by the fixture)
- Test: `packages/agent-claude-sdk-runner/src/__tests__/projected-mcp-servers.test.ts`
- Fixture fallout: `packages/sandbox-k8s/src/__tests__/open-session-schema.test.ts`, `packages/sandbox-subprocess/src/__tests__/open-session.test.ts`, `packages/sandbox-protocol/src/__tests__/schemas.test.ts`, `packages/agent-runner-core/src/__tests__/installed-skills.test.ts`, `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`, `packages/skills-parser/src/__tests__/capabilities-type.test.ts`

**Interfaces:**
- Produces: `validateMcpEntry(value: unknown): { name: string; transport: 'http'; url: string; headers?: Record<string,string> }`. It throws `mcpServers entry '<name>' uses stdio, which is no longer supported` for `transport: 'stdio'`.
- Produces: `McpServerSchema` with `transport: z.literal('http')`, `url` required, and no `command`/`args`/`env` keys. Since `.strict()` is not used today, add an explicit refine that rejects those three keys when present.

- [ ] **Step 1: Rewrite the golden vectors (the failing test).**

  Edit `mcp-server-golden-vectors.json` → `vectors`. All edits are by `desc`:
  - `"valid stdio entry"` → rename `desc` to `"stdio entry is rejected (transport removed)"`. Set `"schema": "reject"` and `"runner": "reject"`, and keep `core: true` and the value.
  - The three name-regex vectors (`"name with uppercase…"`, `"name with leading digit…"`, `"name over 64 chars…"`): replace each value's `"transport":"stdio","command":"npx"` (and any `args`/`env`) with `"transport":"http","url":"https://mcp.example.com"`. The expectations stay reject/reject.
  - `"transport neither stdio nor http"` → rename `desc` to `"transport other than http"`. No other change.
  - **Delete** these vectors: `"stdio entry missing command"`, `"stdio entry with empty command"`, `"stdio entry that also sets url (cross-contamination)"`, `"args array with more than 32 entries"`, `"individual arg longer than 256 chars"`, `"env is an array, not a record"`, `"env value is not a string"`, `"env with more than 32 entries (TASK-18: now symmetric — both reject)"`, `"env key over 256 chars (TASK-18: now symmetric — both reject)"`, `"env value over 256 chars (TASK-18: now symmetric — both reject)"`.
  - `"ASYMMETRY (a): malformed allowedHosts…"` → change its value to `{"name":"remote","transport":"http","url":"https://mcp.example.com","allowedHosts":[1],"credentials":[]}`. The expectations stay schema reject / runner accept, `core: false`.
  - `"stdio may not carry headers"` → rename `desc` to `"stdio entry with headers is rejected"`. It stays reject/reject.
  - Add a vector: `{"desc":"stdio entry with url is rejected","core":true,"schema":"reject","runner":"reject","value":{"name":"local","transport":"stdio","url":"https://mcp.example.com","allowedHosts":[],"credentials":[]}}`

- [ ] **Step 2: Run the drift tests and confirm they fail.**

  Run: `pnpm --filter @ax/sandbox-protocol test -- mcp-server-drift && pnpm --filter @ax/agent-claude-sdk-runner test -- mcp-server-drift`
  Expected: FAIL. `"stdio entry is rejected"` and `"stdio entry with url is rejected"` are accepted by both sides.

- [ ] **Step 3: Narrow `McpServerSchema`.** In `packages/sandbox-protocol/src/schemas.ts`:
  - Delete the `MCP_ENV_MAX` / `MCP_ENV_LEN_MAX` constants and their comment block (lines 30-38). Check first with `grep -n MCP_ENV schemas.ts` that nothing else uses them.
  - Replace the schema definition with the code below. zod 3's `z.object` strips unknown keys before any refine sees them, so the stdio-only keys are rejected in a `preprocess` over the raw input:

  ```ts
  // A single MCP server spec (http only — stdio was removed 2026-10-04, see
  // docs/plans/2026-10-04-drop-stdio-mcp-design.md). This is the trust-boundary
  // re-validation: the host built it, the sandbox re-checks it so a drifted or
  // compromised host cannot smuggle a malformed spec into the runner's `.mcp.json`.
  const McpServerObject = z.object({
    name: z.string().regex(ID_RE),
    transport: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/), z.string().regex(/^(Bearer )?ax-cred:[a-f0-9]{32}$/))
      .refine((headers) => Object.keys(headers).length <= 5, 'At most five credential headers')
      .refine((headers) => {
        const names = Object.keys(headers).map(name => name.toLowerCase());
        return new Set(names).size === names.length && names.every(name => !['host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'set-cookie', 'proxy-authorization', 'proxy-connection', 'upgrade', 'trailer', 'te', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'].includes(name));
      }, 'Headers must be unique and must not override the transport').optional(),
    allowedHosts: z.array(z.string()).default([]),
    credentials: z
      .array(z.object({ slot: z.string(), kind: z.literal('api-key') }))
      .default([]),
  });

  // The removed stdio-only fields must not ride along on an http entry: a host
  // that still sends them is drifted, and the runner must never see them.
  export const McpServerSchema = z.preprocess((raw, ctx) => {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const key of ['command', 'args', 'env'] as const) {
        if (key in raw) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `mcpServers entry must not set '${key}' (stdio MCP servers are not supported)`,
          });
        }
      }
    }
    return raw;
  }, McpServerObject);
  export type McpServerSpec = z.infer<typeof McpServerObject>;
  ```

  If a consumer calls `McpServerSchema.shape` or `.extend` (check with `git grep -n "McpServerSchema\." packages`), point it at `McpServerObject` and export that too.

- [ ] **Step 4: Narrow `validateMcpEntry` and `toMcpJsonShape` in `packages/agent-runner-core/src/installed-skills.ts`.**
  - Delete `MCP_ARGS_MAX`, `MCP_ARG_LEN_MAX`, `MCP_ENV_MAX`, `MCP_ENV_LEN_MAX` and the stdio paragraph of the header comment (lines ~55-59: "stdio: { command, args, env }").
  - Replace `toMcpJsonShape` with:

  ```ts
  function toMcpJsonShape(s: { url: string; headers?: Record<string, string> }): unknown {
    return { url: s.url, type: 'http', ...(s.headers ? { headers: s.headers } : {}) };
  }
  ```

  - Replace `validateMcpEntry`'s signature and body down to (but not including) the `headers` block with:

  ```ts
  export function validateMcpEntry(value: unknown): {
    name: string;
    transport: 'http';
    url: string;
    headers?: Record<string, string>;
  } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('mcpServers entries must be objects');
    }
    const v = value as Record<string, unknown>;
    if (typeof v['name'] !== 'string' || !SKILL_ID_RE.test(v['name'])) {
      throw new Error(`mcpServers entry has invalid name '${String(v['name'])}'`);
    }
    if (v['transport'] === 'stdio') {
      throw new Error(`mcpServers entry '${v['name']}' uses stdio, which is no longer supported`);
    }
    if (v['transport'] !== 'http') {
      throw new Error(`mcpServers entry '${v['name']}' has invalid transport`);
    }
    for (const key of ['command', 'args', 'env'] as const) {
      if (v[key] !== undefined) {
        throw new Error(`mcpServers entry '${v['name']}' (http) must not set '${key}'`);
      }
    }
    if (typeof v['url'] !== 'string') {
      throw new Error(`mcpServers entry '${v['name']}' (http) is missing required 'url'`);
    }
    try {
      new URL(v['url']);
    } catch {
      throw new Error(`mcpServers entry '${v['name']}' url is not a valid URL`);
    }
    const out: { name: string; transport: 'http'; url: string; headers?: Record<string, string> } = {
      name: v['name'],
      transport: 'http',
      url: v['url'],
    };
  ```

  - Keep the existing `if (v['headers'] !== undefined) { … }` block unchanged. Delete the trailing "Transport-specific invariants" block, then `return out;`.
  - Fix the header-comment divergence note: delete divergence "2." about env caps, which is now moot.
  - Run `pnpm --filter @ax/agent-runner-core build` and fix the type errors at the `toMcpJsonShape(...)` call site. It now receives the validated entry, which always has `url`.

- [ ] **Step 5: Narrow the sandbox-subprocess twin.** In `packages/sandbox-subprocess/src/open-session.ts:118-138`, replace the comment's "stdio: { command, args, env }." sentence and the function with:

  ```ts
  function toMcpJsonShape(s: {
    url?: string | undefined;
    headers?: Record<string, string> | undefined;
  }): unknown {
    return { url: s.url, type: 'http', ...(s.headers ? { headers: s.headers } : {}) };
  }
  ```

- [ ] **Step 6: Narrow the claude-sdk loader.** In `packages/agent-claude-sdk-runner/src/projected-mcp-servers.ts`, replace `toEntry` and `toSdkConfig` with:

  ```ts
  function toEntry(name: string, value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const v = value as Record<string, unknown>;
    const { type, ...rest } = v;
    if (type === 'http') return { name, transport: 'http', ...rest };
    // A missing type is the SDK's stdio default; stdio is not supported, so
    // hand validateMcpEntry the stdio transport and let it refuse by name.
    if (type === undefined || type === 'stdio') return { name, transport: 'stdio', ...rest };
    return { name, transport: String(type) };
  }

  function toSdkConfig(e: ReturnType<typeof validateMcpEntry>): McpServerConfig {
    return { type: 'http', url: e.url, ...(e.headers ? { headers: e.headers } : {}) };
  }
  ```

  In the header comment, change "no command/url cross-contamination" to "http only — a stdio entry is skipped by name".

- [ ] **Step 7: Add the loader test.** Append to `packages/agent-claude-sdk-runner/src/__tests__/projected-mcp-servers.test.ts`, using the file's existing tmpdir helper (`grep -n "mkdtemp\|function write" projected-mcp-servers.test.ts` to find its name; below it is called `writeBundle(configDir, dir, json)`):

  ```ts
  it('skips a stdio server with a log line naming stdio, and still loads its http sibling', async () => {
    const configDir = await makeConfigDir();
    await writeBundle(configDir, 'conn', {
      mcpServers: {
        c0123456789: { command: 'npx', args: ['-y', 'pkg'] },
        c9876543210: { type: 'http', url: 'https://mcp.example.com' },
      },
    });
    const lines: string[] = [];
    const out = await loadProjectedMcpServers(configDir, (l) => lines.push(l));
    expect(Object.keys(out.servers)).toEqual(['c9876543210']);
    expect(out.servers['c9876543210']).toEqual({ type: 'http', url: 'https://mcp.example.com' });
    expect(lines.join('\n')).toMatch(/c0123456789.*stdio, which is no longer supported/);
  });
  ```

  If the file has no `writeBundle`/`makeConfigDir` helpers, write them inline with `fs.mkdtemp` + `fs.mkdir(path.join(dir,'skills','conn'),{recursive:true})` + `fs.writeFile(path.join(…,'.mcp.json'), JSON.stringify(json))`, the same way the existing tests in that file set up a bundle.

- [ ] **Step 8: Narrow the dead skills-side unions.**
  - `packages/skills-parser/src/capabilities.ts`: in `McpServerSpec`, set `transport: 'http';` and delete `command?`, `args?`, `env?`. In `McpServerSpecSchema`, set `transport: z.literal('http')` and delete `command`/`args`/`env`.
  - `packages/ipc-protocol/src/actions.ts` `SkillProposeMcpSchema`: set `transport: z.literal('http')` and delete `command`/`args`/`env`.

- [ ] **Step 9: Fix fixture fallout.**

  Run: `pnpm --filter @ax/sandbox-protocol --filter @ax/agent-runner-core --filter @ax/sandbox-subprocess --filter @ax/sandbox-k8s --filter @ax/agent-claude-sdk-runner --filter @ax/skills-parser --filter @ax/ipc-protocol build`

  For each failing test listed under Fixture fallout, find stdio cases with `grep -n "stdio" <file>`, then:
  - A test that asserts stdio is **accepted** or **projected**: convert it to the http equivalent (`transport: 'http', url: 'https://mcp.example.com'`, no `command`/`args`/`env`). If an http version of the same assertion already exists, delete it instead.
  - A test of a stdio-only rule (missing command, env caps, args caps): delete it. The golden vectors from Step 1 now cover "stdio rejected".
  - Add one test per schema test file asserting a stdio entry is rejected, e.g. in `sandbox-protocol/src/__tests__/schemas.test.ts`:

  ```ts
  it('rejects a stdio MCP server', () => {
    const r = McpServerSchema.safeParse({ name: 'local', transport: 'stdio', command: 'npx', allowedHosts: [], credentials: [] });
    expect(r.success).toBe(false);
  });
  it('rejects an http server that still carries command', () => {
    const r = McpServerSchema.safeParse({ name: 'remote', transport: 'http', url: 'https://mcp.example.com', command: 'x' });
    expect(r.success).toBe(false);
  });
  ```

- [ ] **Step 10: Run the affected packages.**

  Run: `pnpm --filter @ax/sandbox-protocol --filter @ax/agent-runner-core --filter @ax/sandbox-subprocess --filter @ax/sandbox-k8s --filter @ax/agent-claude-sdk-runner --filter @ax/skills-parser --filter @ax/ipc-protocol test`
  Expected: PASS. The two `*.e2e.test.ts` files in the claude-sdk runner need the real SDK binary and may be skipped locally. `interrupt-real-sdk.e2e.test.ts` deliberately keeps its direct stdio probe (spec › Testing).

- [ ] **Step 11: Commit.**

  ```bash
  git add -A packages/sandbox-protocol packages/agent-runner-core packages/sandbox-subprocess packages/sandbox-k8s packages/agent-claude-sdk-runner packages/skills-parser packages/ipc-protocol
  git commit -m "Drop stdio from the MCP wire schema, runner validator and projection"
  ```

---

### Task 2: `@ax/connectors` boot sweep — hard-delete stdio connectors and drafts

**Files:**
- Create: `packages/connectors/src/stdio-sweep.ts`
- Create: `packages/connectors/src/purge.ts` (the cleanup extracted from `deleteConnector`)
- Modify: `packages/connectors/src/plugin.ts:263-280` (call the sweep) and `:876-972` (use `purge.ts`)
- Modify: `packages/connectors/src/credential-plan.ts:132` (widen the parameter type)
- Test: `packages/connectors/src/__tests__/stdio-sweep.test.ts`

**Interfaces:**
- Produces, in `purge.ts`:
  `purgeConnectorState(bus: HookBus, ctx: AgentContext, ownerUserId: string, connector: PurgeableConnector, opts: { purgeGlobal: boolean }): Promise<void>`
  - It runs the credential purge, then fires `connectors:deleted`.
  - `PurgeableConnector = Pick<Connector, 'id' | 'keyMode' | 'visibility'> & { capabilities: Pick<Capabilities, 'credentials' | 'mcpServers'> }`
- Produces, in `stdio-sweep.ts`: `sweepStdioConnectors(db: Kysely<ConnectorDatabase>, bus: HookBus, ctx: AgentContext): Promise<{ connectors: number; drafts: number }>`
- Consumes: `deriveCredentialPlan` (widened to `Pick<Connector,'id'|'keyMode'> & { capabilities: Pick<Capabilities,'credentials'> }`) and `deriveToolNamespaces` (already takes a narrow shape).

- [ ] **Step 1: Write the failing test.** Create `packages/connectors/src/__tests__/stdio-sweep.test.ts`:

  ```ts
  import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
  import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
  import type { Plugin } from '@ax/core';
  import {
    createTestHarness,
    type TestHarness,
    stopPostgresContainer,
    startTestContainer,
  } from '@ax/test-harness';
  import { createDatabasePostgresPlugin } from '@ax/database-postgres';
  import { createConnectorsPlugin } from '../plugin.js';
  import { deriveToolNamespaces } from '../tool-namespace.js';
  import type { ConnectorDeletedEvent, ListOutput } from '../types.js';

  // The sweep runs inside connectors' init, so the capture plugin must init
  // BEFORE it. Registering `credentials:delete` (an optionalCall of
  // @ax/connectors) puts this plugin ahead of it in topological order.
  function capturePlugin(events: ConnectorDeletedEvent[], purged: Array<{ scope: string; ownerId: string | null; ref: string }>): Plugin {
    return {
      manifest: { name: 'test/capture', version: '0.0.0', registers: ['credentials:delete'], calls: [], subscribes: ['connectors:deleted'] },
      init({ bus }) {
        bus.registerService('credentials:delete', 'test/capture', async (_ctx, input) => {
          purged.push(input as { scope: string; ownerId: string | null; ref: string });
          return undefined;
        });
        bus.subscribe<ConnectorDeletedEvent>('connectors:deleted', 'test/capture', async (_ctx, e) => {
          events.push(e);
          return undefined;
        });
      },
    };
  }

  let container: StartedPostgreSqlContainer;
  let connectionString: string;
  const harnesses: TestHarness[] = [];

  async function boot(extra: Plugin[] = []): Promise<TestHarness> {
    const h = await createTestHarness({
      plugins: [createDatabasePostgresPlugin({ connectionString }), ...extra, createConnectorsPlugin()],
    });
    harnesses.push(h);
    return h;
  }

  async function sql(text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
    const c = new (await import('pg')).default.Client({ connectionString });
    await c.connect();
    try {
      return (await c.query(text, params)).rows;
    } finally {
      await c.end().catch(() => {});
    }
  }

  const httpServer = { name: 'remote', transport: 'http', url: 'https://mcp.example.com', allowedHosts: [], credentials: [] };
  const stdioServer = { name: 'local', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], allowedHosts: [], credentials: [] };
  const caps = (servers: unknown[], credentials: unknown[] = []) =>
    JSON.stringify({ allowedHosts: [], credentials, mcpServers: servers, packages: { npm: [], pypi: [] } });

  async function insertConnector(owner: string, id: string, capsJson: string, opts: { keyMode?: string; visibility?: string; deleted?: boolean } = {}) {
    await sql(
      `INSERT INTO connectors_v1_connectors (owner_user_id, connector_id, name, key_mode, visibility, capabilities, deleted_at)
       VALUES ($1, $2, $2, $3, $4, $5::jsonb, $6)`,
      [owner, id, opts.keyMode ?? 'personal', opts.visibility ?? 'private', capsJson, opts.deleted ? new Date() : null],
    );
  }

  beforeAll(async () => {
    container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
    connectionString = container.getConnectionUri();
  }, 120_000);

  afterEach(async () => {
    while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
    await sql('DROP TABLE IF EXISTS connectors_v1_connectors');
    await sql('DROP TABLE IF EXISTS connectors_v1_authored');
  });

  afterAll(async () => {
    if (container) await stopPostgresContainer(container);
  });

  describe('@ax/connectors stdio sweep', () => {
    it('deletes live + tombstoned stdio connectors, keeps http ones, and list-effective works afterwards', async () => {
      await (await boot()).close({ onError: () => {} }); // create tables
      harnesses.pop();
      await insertConnector('userA', 'gdrive', caps([httpServer]));
      await insertConnector('userA', 'localtool', caps([stdioServer], [{ slot: 'TOKEN', kind: 'api-key' }]));
      await insertConnector('userA', 'oldtool', caps([stdioServer]), { deleted: true });

      const events: ConnectorDeletedEvent[] = [];
      const purged: Array<{ scope: string; ownerId: string | null; ref: string }> = [];
      const h = await boot([capturePlugin(events, purged)]);

      const rows = await sql('SELECT connector_id FROM connectors_v1_connectors ORDER BY connector_id');
      expect(rows.map((r) => r['connector_id'])).toEqual(['gdrive']);

      // Cleanup ran for the LIVE stdio row only (the tombstone was purged at its soft delete).
      expect(events).toEqual([
        { connectorId: 'localtool', toolNamespaces: deriveToolNamespaces('userA', { id: 'localtool', capabilities: { mcpServers: [stdioServer as never] } }) },
      ]);
      expect(purged).toEqual([{ scope: 'user', ownerId: 'userA', ref: 'account:localtool' }]);

      // Regression: one stdio row used to make the whole list throw.
      const list = await h.bus.call<{ userId: string }, ListOutput>('connectors:list', h.ctx({ userId: 'userA' }), { userId: 'userA' });
      expect(list.connectors.map((c) => c.id)).toEqual(['gdrive']);
    });

    it('purges a shared workspace connector\'s GLOBAL key (system cleanup)', async () => {
      await (await boot()).close({ onError: () => {} });
      harnesses.pop();
      await insertConnector('admin1', 'teamtool', caps([stdioServer], [{ slot: 'TOKEN', kind: 'api-key' }]), { keyMode: 'workspace', visibility: 'shared' });
      const purged: Array<{ scope: string; ownerId: string | null; ref: string }> = [];
      await boot([capturePlugin([], purged)]);
      expect(purged).toEqual([{ scope: 'global', ownerId: null, ref: 'account:teamtool' }]);
    });

    it('deletes a row whose capabilities are garbage but mention stdio, without purging and without throwing', async () => {
      await (await boot()).close({ onError: () => {} });
      harnesses.pop();
      await insertConnector('userA', 'weird', JSON.stringify({ mcpServers: [{ transport: 'stdio' }], credentials: 'nope' }));
      const purged: Array<{ scope: string; ownerId: string | null; ref: string }> = [];
      await boot([capturePlugin([], purged)]);
      expect(await sql('SELECT 1 FROM connectors_v1_connectors')).toHaveLength(0);
      expect(purged).toEqual([]);
    });

    it('deletes authored drafts that propose a stdio server, keeps http drafts', async () => {
      await (await boot()).close({ onError: () => {} });
      harnesses.pop();
      await sql(
        `INSERT INTO connectors_v1_authored (owner_user_id, agent_id, connector_id, name, key_mode, capability_proposal, status)
         VALUES ('userA','agent1','localtool','Local','personal',$1::jsonb,'pending'),
                ('userA','agent1','gdrive','Drive','personal',$2::jsonb,'pending')`,
        [caps([stdioServer]), caps([httpServer])],
      );
      await boot();
      const rows = await sql('SELECT connector_id FROM connectors_v1_authored');
      expect(rows.map((r) => r['connector_id'])).toEqual(['gdrive']);
    });

    it('is idempotent: a second boot sweeps nothing', async () => {
      await (await boot()).close({ onError: () => {} });
      harnesses.pop();
      await insertConnector('userA', 'localtool', caps([stdioServer]));
      await (await boot()).close({ onError: () => {} });
      harnesses.pop();
      const events: ConnectorDeletedEvent[] = [];
      await boot([capturePlugin(events, [])]);
      expect(events).toEqual([]);
    });
  });
  ```

  Before running, check the `connectors:list` input/output names against `types.ts` (`grep -n "ListInput\|ListOutput" types.ts`) and the single-slot ref format (`accountRef(service)` = `account:<connectorId>` for a slot without an `account` tag; confirm via `serviceTagForSlot` in `credential-plan.ts`). Adjust the expected refs to match. Also check the harness's `ctx` signature in `hooks.test.ts`.

- [ ] **Step 2: Run it and confirm it fails.**

  Run: `pnpm --filter @ax/connectors test -- stdio-sweep`
  Expected: FAIL. The stdio rows are still present, and `connectors:list` throws `invalid-payload` only once Task 3 narrows the schema; today it passes that part. The first assertion (`['gdrive']`) is what fails.

- [ ] **Step 3: Extract the cleanup into `purge.ts`.**
  - Create `packages/connectors/src/purge.ts`. Move the body of `deleteConnector` from `if (connector !== null && bus.hasService('credentials:delete')) {` through the end of the `connectors:deleted` fire block into the function below, keeping each comment where it was.
  - Carry over the imports that block uses: `deriveCredentialPlan`, `deriveToolNamespaces`, `oauthClientSecretRefFor`, `namesOAuthClientSecretRef`, the `Connector` / `Capabilities` / `ConnectorDeletedEvent` types, and `HookBus` / `AgentContext`.
  - `plugin.ts` imports `purgeConnectorState` from `./purge.js`.

  ```ts
  /** What `purgeConnectorState` reads from a connector — no more. */
  export type PurgeableConnector = Pick<Connector, 'id' | 'keyMode' | 'visibility'> & {
    capabilities: Pick<Capabilities, 'credentials' | 'mcpServers'>;
  };

  /**
   * Everything a connector delete reclaims OUTSIDE its own row: its stored
   * key(s) and the `connectors:deleted` announcement. Shared by the
   * `connectors:delete` hook and the boot-time stdio sweep (stdio-sweep.ts).
   */
  export async function purgeConnectorState(
    bus: HookBus,
    ctx: AgentContext,
    ownerUserId: string,
    connector: PurgeableConnector,
    opts: { purgeGlobal: boolean },
  ): Promise<void> {
    const connectorId = connector.id;
    if (bus.hasService('credentials:delete')) {
      // … the existing purge loop, with `input.purgeGlobal === true` replaced by
      // `opts.purgeGlobal` and `userId` replaced by `ownerUserId` …
    }
    const event: ConnectorDeletedEvent = {
      connectorId,
      toolNamespaces: deriveToolNamespaces(ownerUserId, connector),
    };
    try {
      await bus.fire('connectors:deleted', ctx, event);
    } catch (err) {
      ctx.logger.warn('connectors_deleted_event_failed', {
        connectorId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  ```

  - In `plugin.ts`, `deleteConnector` becomes:

  ```ts
    const connector = await store.getByIdNotDeleted(userId, connectorId);
    const deleted = await store.softDelete(userId, connectorId);
    if (deleted && connector !== null) {
      await purgeConnectorState(bus, ctx, userId, connector, { purgeGlobal: input.purgeGlobal === true });
    }
    return { deleted };
  ```

  - **Behavior check:** today the credential purge runs when `connector !== null` even if `deleted` is false. That can only happen in a race between the read and the soft delete. Gating both on `deleted && connector !== null` is the intended semantics (the event already used it). The existing `hooks.test.ts` delete tests pin this. Run them in Step 6.
  - In `credential-plan.ts:132`, widen the parameter: `export function deriveCredentialPlan(connector: Pick<Connector, 'id' | 'keyMode'> & { capabilities: Pick<Capabilities, 'credentials'> }): CredentialPlanEntry[]`. Import `Capabilities` if needed.

- [ ] **Step 4: Write the sweep.** Create `packages/connectors/src/stdio-sweep.ts`:

  ```ts
  // ---------------------------------------------------------------------------
  // Boot-time sweep: hard-delete every stored connector or draft that uses a
  // stdio MCP server (removed 2026-10-04 — docs/plans/2026-10-04-drop-stdio-mcp-design.md).
  //
  // Reads the RAW JSONB, never `rowToConnector`: the narrowed schema refuses
  // these rows, which is the whole reason they must go before anything lists.
  // Live rows get the same cleanup as `connectors:delete` (key purge + the
  // `connectors:deleted` announcement); a tombstone was already cleaned when it
  // was soft-deleted. The purge includes GLOBAL refs: this is system cleanup,
  // not a caller acting, and it is limited to refs the connector itself derives.
  //
  // Idempotent — a second boot finds nothing. Logs counts only, never contents.
  // ---------------------------------------------------------------------------

  import { sql, type Kysely } from 'kysely';
  import { z } from 'zod';
  import type { AgentContext, HookBus } from '@ax/core';
  import type { ConnectorDatabase } from './migrations.js';
  import { purgeConnectorState, type PurgeableConnector } from './purge.js';

  // Just enough shape to derive the key refs + tool namespaces to clean up.
  const PurgeShapeSchema = z.object({
    credentials: z.array(z.object({ slot: z.string(), kind: z.string() }).passthrough()),
    mcpServers: z.array(z.object({ name: z.string() }).passthrough()),
  });

  // jsonb_path_exists over the opaque spec: any mcpServers entry with transport stdio.
  const HAS_STDIO = (column: string) =>
    sql<boolean>`jsonb_path_exists(${sql.ref(column)}, '$.mcpServers[*] ? (@.transport == "stdio")')`;

  export async function sweepStdioConnectors(
    db: Kysely<ConnectorDatabase>,
    bus: HookBus,
    ctx: AgentContext,
  ): Promise<{ connectors: number; drafts: number }> {
    const rows = await db
      .selectFrom('connectors_v1_connectors')
      .select(['owner_user_id', 'connector_id', 'key_mode', 'visibility', 'capabilities', 'deleted_at'])
      .where(HAS_STDIO('capabilities'))
      .execute();

    for (const row of rows) {
      if (row.deleted_at === null) {
        const shape = PurgeShapeSchema.safeParse(row.capabilities);
        if (shape.success) {
          const connector = {
            id: row.connector_id,
            keyMode: row.key_mode,
            visibility: row.visibility,
            capabilities: shape.data,
          } as unknown as PurgeableConnector;
          await purgeConnectorState(bus, ctx, row.owner_user_id, connector, { purgeGlobal: true });
        } else {
          ctx.logger.warn('connectors_stdio_sweep_unparseable', { connectorId: row.connector_id });
        }
      }
      await db
        .deleteFrom('connectors_v1_connectors')
        .where('owner_user_id', '=', row.owner_user_id)
        .where('connector_id', '=', row.connector_id)
        .execute();
    }

    const drafts = await db
      .deleteFrom('connectors_v1_authored')
      .where(HAS_STDIO('capability_proposal'))
      .executeTakeFirst();
    const draftCount = Number(drafts.numDeletedRows ?? 0n);

    ctx.logger.info('connectors_stdio_swept', { count: rows.length });
    ctx.logger.info('connectors_authored_stdio_swept', { count: draftCount });
    return { connectors: rows.length, drafts: draftCount };
  }
  ```

  Check the row column names against `ConnectorsRow` in `migrations.ts` (`grep -n "interface ConnectorsRow" -A16 migrations.ts`). `plugin.ts` imports `sweepStdioConnectors` from `./stdio-sweep.js`; `stdio-sweep.ts` and `plugin.ts` both import from `purge.ts`, so there is no module cycle.

- [ ] **Step 5: Call it from init.** In `plugin.ts` `init`, directly after `await runConnectorsMigration(db);`:

  ```ts
      // stdio MCP servers were removed (2026-10-04). Sweep stored ones BEFORE any
      // service is registered: the narrowed schema refuses them, and one such
      // row would make every list over its owner throw.
      await sweepStdioConnectors(db, bus, initCtx);
  ```

- [ ] **Step 6: Run the connectors suite.**

  Run: `pnpm --filter @ax/connectors test`
  Expected: PASS, including `stdio-sweep.test.ts` and the existing `hooks.test.ts` "delete fires connectors:deleted" cases.

- [ ] **Step 7: Commit.**

  ```bash
  git add packages/connectors
  git commit -m "Sweep stdio connectors and drafts at connectors boot"
  ```

---

### Task 3: `@ax/connectors` + orchestrator + model copy — http only

**Files:**
- Modify: `packages/connectors/src/types.ts:22-25, 124-133`
- Modify: `packages/connectors/src/store.ts:126-153` (rejection message)
- Modify: `packages/connectors/src/tool-namespace.ts:112-129`
- Modify: `packages/connectors/src/admin-routes.ts:215-217, 284-295`
- Modify: `packages/chat-orchestrator/src/connector-union.ts:54-66`, `packages/chat-orchestrator/src/orchestrator.ts:466-479`
- Modify: `packages/mcp-client/src/connector-inventory/describe-tools.ts:85, 229`
- Modify: `packages/tool-connector-propose/src/descriptor.ts:32, 45`
- Modify: `presets/k8s/src/builtin-skills/ax-connector-creator/SKILL.md:59-60`
- Test: `packages/connectors/src/__tests__/store.test.ts` (new case); fixture fallout in `tool-namespace.test.ts`, `leak-guard.test.ts`, `admin-routes.test.ts`, `chat-orchestrator/src/__tests__/orchestrator.test.ts`, `connector-card.test.ts`, `connector-union.test.ts`, `mcp-client/src/__tests__/connector-inventory-describe-tools.test.ts`

**Interfaces:**
- Produces: `validateCapabilities` throws `invalid-payload` with the exact Global-Constraints message when any `mcpServers[].transport` is `'stdio'`.

- [ ] **Step 1: Write the failing test.** Append to `packages/connectors/src/__tests__/store.test.ts`, at top level and outside any DB `describe`, because `validateCapabilities` is pure:

  ```ts
  import { validateCapabilities } from '../store.js';

  describe('validateCapabilities — stdio removed', () => {
    const base = { allowedHosts: [], credentials: [], packages: { npm: [], pypi: [] } };
    it('rejects a stdio MCP server with the remote-URL hint', () => {
      expect(() =>
        validateCapabilities({ ...base, mcpServers: [{ name: 'local', transport: 'stdio', command: 'npx', allowedHosts: [], credentials: [] }] }),
      ).toThrow('Local (stdio) MCP servers are no longer supported. Use a remote MCP server URL.');
    });
    it('still accepts an http MCP server', () => {
      expect(() =>
        validateCapabilities({ ...base, mcpServers: [{ name: 'remote', transport: 'http', url: 'https://mcp.example.com', allowedHosts: [], credentials: [] }] }),
      ).not.toThrow();
    });
  });
  ```

- [ ] **Step 2: Run it and confirm it fails.**

  Run: `pnpm --filter @ax/connectors test -- store.test`
  Expected: the first case FAILS (stdio is accepted).

- [ ] **Step 3: Narrow the schema and add the message.**
  - In `types.ts`, `McpServerSpecSchema` becomes:

  ```ts
  const McpServerSpecSchema = z.object({
    name: z.string(),
    transport: z.literal('http'),
    url: z.string().optional(),
    allowedHosts: z.array(z.string()),
    credentials: z.array(CapabilitySlotSchema),
  });
  ```

    Also fix the comment at `types.ts:22-25` to read "(MCP over http, a CLI package, a direct API)".
  - In `store.ts` `validateCapabilities`, before `CapabilitiesSchema.safeParse`:

  ```ts
    const servers = (value as { mcpServers?: unknown } | null)?.mcpServers;
    if (Array.isArray(servers) && servers.some((s) => (s as { transport?: unknown } | null)?.transport === 'stdio')) {
      throw invalid('Local (stdio) MCP servers are no longer supported. Use a remote MCP server URL.');
    }
  ```

  - Since every server is now http, simplify the header check `server.name === slot.server && server.transport === 'http'` to `server.name === slot.server`.

- [ ] **Step 4: Narrow the remaining connector code.**
  - `tool-namespace.ts` `endpointOf`: `return JSON.stringify([spec.transport, spec.url ?? null]);`. Delete the TASK-758 args comment, and drop `command`/`args` from the `ServerSpec` type if it declares them.
  - `admin-routes.ts` `probeConnector` (284-295):

  ```ts
    // Config sanity: an MCP-backed connector's leading server must have a url.
    // A connector with no mcpServers is CLI/package/direct-API backed and passes
    // (its reach is the allowedHosts + the now-verified slots).
    const leadServer = connector.capabilities.mcpServers[0];
    if (leadServer !== undefined) {
      if (typeof leadServer.url !== 'string' || leadServer.url.trim().length === 0) {
        return { status: 'unreachable', detail: 'MCP server has no url' };
      }
    }
  ```

    Update the comment at 215-217 to match.
  - `chat-orchestrator/src/connector-union.ts:56-66` and `orchestrator.ts:469-479`: set `transport: 'http';` and delete `command?`, `args?`, `env?`.
  - `mcp-client/src/connector-inventory/describe-tools.ts:85`: `transport: 'http';`. At line 229, delete `if (server.transport !== 'http') continue; // stdio: not listable host-side` and the stdio sentence in the header comment at line 16.

- [ ] **Step 5: Update the model-facing copy.**
  - `tool-connector-propose/src/descriptor.ts:32`: `'be backed by a remote MCP server (an http URL), a CLI tool fetched from a package',`. At line 45: `'  mcpServers:  remote MCP backing — [{ name, transport: "http", url, allowedHosts, credentials }]. Optional.',`
  - `ax-connector-creator/SKILL.md:59-60`: `  - **MCP server** — a service speaking MCP over \`http\` (a URL). Fill: \`mcpServers\`. Local (stdio) MCP servers are not supported.`

- [ ] **Step 6: Fix fixture fallout and run.**

  Run: `pnpm --filter @ax/connectors --filter @ax/chat-orchestrator --filter @ax/mcp-client --filter @ax/tool-connector-propose --filter @ax/preset-k8s build`
  (Confirm the preset's package name with `grep '"name"' presets/k8s/package.json`.)

  Then fix each file listed under Test using the rules in Task 1 Step 9:
  - convert stdio fixtures that test generic behavior to http;
  - delete stdio-only assertions;
  - in `tool-namespace.test.ts`, delete the TASK-758 "args undefined vs []" case.

  `connector-union.test.ts:1036` uses an id string `'stdio-only'`. Rename the id to `'cli-only'` only if the fixture's capabilities use stdio; otherwise leave it.

  Run: `pnpm --filter @ax/connectors --filter @ax/chat-orchestrator --filter @ax/mcp-client --filter @ax/tool-connector-propose test`
  Expected: PASS.

- [ ] **Step 7: Commit.**

  ```bash
  git add -A packages/connectors packages/chat-orchestrator packages/mcp-client/src/connector-inventory packages/mcp-client/src/__tests__ packages/tool-connector-propose presets/k8s
  git commit -m "Refuse stdio MCP servers in connectors, drafts and the propose tool"
  ```

---

### Task 4: Streamable-HTTP MCP test stub; port the host mcp-client e2e

**Files:**
- Create: `packages/test-harness/src/mcp-http-server-stub.ts`
- Modify: `packages/test-harness/src/index.ts:30-46` (export `startMcpHttpServerStub`, remove `mcpServerStubPath`)
- Delete: `packages/test-harness/src/mcp-server-stub.ts`, `packages/test-harness/src/__tests__/mcp-server-stub.test.ts`
- Create: `packages/test-harness/src/__tests__/mcp-http-server-stub.test.ts`
- Delete: `packages/cli/src/__tests__/mcp-stdio.e2e.test.ts`
- Create: `packages/cli/src/__tests__/mcp-http.e2e.test.ts`
- Modify: `packages/test-harness/vitest.config.ts:22-42` (comment), `scripts/__tests__/out-of-process-test-timeouts.test.js`, `scripts/__tests__/no-workspace-build-in-tests.test.js` (if they name the stub file)

**Interfaces:**
- Produces: `startMcpHttpServerStub(): Promise<{ url: string; close(): Promise<void> }>`. It spawns `dist/mcp-http-server-stub.js` as a child process, waits for the stdout line `LISTENING <port>`, and returns `http://127.0.0.1:<port>/mcp`.
- The stub has the same tools as before: `echo` returns `text`; `crash` calls `process.exit(1)` mid-request, so the listener dies and the client's next call fails.

- [ ] **Step 1: Write the stub's failing test.** Create `packages/test-harness/src/__tests__/mcp-http-server-stub.test.ts`:

  ```ts
  import { afterEach, describe, expect, it } from 'vitest';
  import { Client } from '@modelcontextprotocol/sdk/client/index.js';
  import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
  import { startMcpHttpServerStub } from '../index.js';

  const stubs: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    while (stubs.length > 0) await stubs.pop()!.close();
  });

  async function connect(url: string): Promise<Client> {
    const client = new Client({ name: 'stub-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  }

  describe('mcp-http-server-stub', () => {
    it('lists echo + crash and echoes text', async () => {
      const stub = await startMcpHttpServerStub();
      stubs.push(stub);
      const client = await connect(stub.url);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['crash', 'echo']);
      const r = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
      expect(r.content).toEqual([{ type: 'text', text: 'hi' }]);
      await client.close();
    });

    it('crash kills the server so the call fails', async () => {
      const stub = await startMcpHttpServerStub();
      stubs.push(stub);
      const client = await connect(stub.url);
      await expect(client.callTool({ name: 'crash', arguments: {} })).rejects.toThrow();
      await client.close().catch(() => {});
    });
  });
  ```

- [ ] **Step 2: Run it and confirm it fails.**

  Run: `pnpm --filter @ax/test-harness build; pnpm --filter @ax/test-harness test -- mcp-http-server-stub`
  Expected: FAIL. `startMcpHttpServerStub` is not exported.

- [ ] **Step 3: Write the stub.** Create `packages/test-harness/src/mcp-http-server-stub.ts`:

  ```ts
  #!/usr/bin/env node
  /**
   * Minimal streamable-HTTP MCP server stub, run as a CHILD PROCESS so tests
   * exercise a real socket + a real process death. Listens on 127.0.0.1:0 and
   * prints `LISTENING <port>` on stdout once ready.
   *
   * Tools: `echo` (returns `text`), `crash` (process.exit(1) mid-request — the
   * listener dies with it, which is the dead-server case).
   *
   * Stateless: a fresh Server + transport per POST, so no session bookkeeping.
   * Keep it tiny; write a second stub rather than growing this one.
   */
  import { createServer } from 'node:http';
  import { Server } from '@modelcontextprotocol/sdk/server/index.js';
  import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
  import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

  const TOOLS = [
    {
      name: 'echo',
      description: 'echo the input text verbatim',
      inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'crash',
      description: 'exit the server process with code 1 (dead-server test)',
      inputSchema: { type: 'object' as const },
    },
  ];

  function makeServer(): Server {
    const server = new Server({ name: 'ax-test-mcp-http-stub', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      if (req.params.name === 'echo') {
        const text = typeof args['text'] === 'string' ? args['text'] : String(args['text'] ?? '');
        return { content: [{ type: 'text', text }] };
      }
      if (req.params.name === 'crash') {
        process.stderr.write('mcp-http-server-stub: crash tool invoked, exiting with code 1\n');
        process.exit(1);
      }
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
    });
    return server;
  }

  const http = createServer((req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : undefined;
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = makeServer();
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      })().catch((err: unknown) => {
        process.stderr.write(`mcp-http-server-stub: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });

  http.listen(0, '127.0.0.1', () => {
    const addr = http.address();
    if (addr === null || typeof addr === 'string') process.exit(2);
    process.stdout.write(`LISTENING ${addr.port}\n`);
  });
  ```

- [ ] **Step 4: Export the launcher.** In `packages/test-harness/src/index.ts`, replace the `mcpServerStubPath` block (lines 30-46) with:

  ```ts
  /**
   * Start the streamable-HTTP MCP server stub (`dist/mcp-http-server-stub.js`)
   * as a child process and resolve once it is listening. `close()` kills it.
   * Consumers must `pnpm --filter @ax/test-harness build` first.
   */
  export async function startMcpHttpServerStub(): Promise<{ url: string; close(): Promise<void> }> {
    const stubPath = fileURLToPath(new URL('../dist/mcp-http-server-stub.js', import.meta.url));
    const child = spawn(process.execPath, [stubPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise<number>((resolve, reject) => {
      let buf = '';
      child.stdout!.on('data', (c: Buffer) => {
        buf += c.toString('utf-8');
        const m = /LISTENING (\d+)/.exec(buf);
        if (m) resolve(Number(m[1]));
      });
      child.once('exit', (code) => reject(new Error(`mcp-http-server-stub exited before listening (code ${code})`)));
      child.once('error', reject);
    });
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      close: () =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
        }),
    };
  }
  ```

  Add `import { spawn } from 'node:child_process';` at the top. `fileURLToPath` is already imported. Delete `src/mcp-server-stub.ts` and `src/__tests__/mcp-server-stub.test.ts`.

- [ ] **Step 5: Run the stub test.**

  Run: `pnpm --filter @ax/test-harness build && pnpm --filter @ax/test-harness test -- mcp-http-server-stub`
  Expected: PASS.

- [ ] **Step 6: Port the e2e.** Run `git mv packages/cli/src/__tests__/mcp-stdio.e2e.test.ts packages/cli/src/__tests__/mcp-http.e2e.test.ts`, then edit:
  - Imports: replace `mcpServerStubPath` with `startMcpHttpServerStub`.
  - Header comment: "mcp-stdio e2e" → "mcp-http e2e (real child-process streamable-HTTP MCP server)". Replace "real subprocess + framing + StdioClientTransport" with "real socket + StreamableHTTPClientTransport + process death".
  - Recorder plugin name: `@ax/test-mcp-http-recorder`.
  - `seedMcpStubConfig(sqlitePath, url)`: the config becomes `{ id: 'stub', enabled: true, transport: 'streamable-http' as const, url }`.
  - In `describe`, add `let stub: { url: string; close(): Promise<void> };`. In `beforeEach`, add `stub = await startMcpHttpServerStub();`. In `afterEach`, add `await stub.close();`. Pass `stub.url` to both `seedMcpStubConfig` calls.
  - Rename the tmp prefixes to `ax-mcp-http-` and the sqlite filenames to `mcp-http-*.sqlite`. Rename `describe` to `'@ax/cli mcp-http e2e (real child-process server + stub runner)'`. Rename the first `it` to `'round-trips a tool call to a real HTTP MCP server (echo)'`.
  - Every assertion stays the same.
  - In `packages/test-harness/vitest.config.ts` and the two `scripts/__tests__` files, run `grep -n "mcp-server-stub\|mcp-stdio"` and rename the references to the new file names.

- [ ] **Step 7: Run the e2e and the scripts suite.**

  Run: `pnpm --filter @ax/test-harness build && pnpm --filter @ax/cli test -- mcp-http && pnpm test:scripts`
  Expected: PASS. If the crash case gives `isError` but the text doesn't match `/unavailable/i`, read the mcp-client wrap at `packages/mcp-client/src/plugin.ts:352-362`. It says `MCP server '<id>' unavailable: <reason>`, so it should match. Debug; don't loosen the assertion.

- [ ] **Step 8: Commit.**

  ```bash
  git add -A packages/test-harness packages/cli/src/__tests__ scripts/__tests__
  git commit -m "Replace the stdio MCP test stub with a streamable-HTTP one; port the mcp e2e"
  ```

---

### Task 5: `@ax/mcp-client` + CLI — drop the stdio transport, sweep stdio configs

**Files:**
- Create: `packages/mcp-client/src/stdio-sweep.ts`
- Create: `packages/mcp-client/src/credential-purge.ts` (moved `purgeMcpCredentials`)
- Modify: `packages/mcp-client/src/config.ts:60-93`
- Modify: `packages/mcp-client/src/transports.ts` (stdio removal)
- Modify: `packages/mcp-client/src/admin-routes.ts:36-80` and every `envNamesOf` call
- Modify: `packages/mcp-client/src/plugin.ts:78, ~226` (comment; call the sweep before `loadConfigs`)
- Modify: `packages/cli/src/commands/mcp.ts:132`
- Test: `packages/mcp-client/src/__tests__/stdio-sweep.test.ts`; fixture fallout in `connection.test.ts`, `transports.test.ts`, `plugin.test.ts`, `connection-recovery.test.ts`, `admin-routes.test.ts`, `config.test.ts`, `packages/cli/src/__tests__/mcp-cli.test.ts`

**Interfaces:**
- Produces: `sweepStdioConfigs(bus: HookBus, ctx: AgentContext): Promise<number>`. It returns the number of rows deleted.
- Produces: `purgeMcpCredentials(bus, ctx, serverId, envNames, headerNames)` (same signature, new module).

- [ ] **Step 1: Write the failing test.** Create `packages/mcp-client/src/__tests__/stdio-sweep.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import { makeAgentContext, type HookBus } from '@ax/core';
  import { sweepStdioConfigs } from '../stdio-sweep.js';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function fakeBus(initial: Record<string, unknown>, creds: Array<{ scope: 'global' | 'user' | 'agent'; ownerId: string | null; ref: string }>) {
    const store = new Map<string, Uint8Array>(
      Object.entries(initial).map(([k, v]) => [k, enc.encode(typeof v === 'string' ? v : JSON.stringify(v))]),
    );
    const deleted: string[] = [];
    const bus = {
      hasService: (h: string) => h === 'credentials:list' || h === 'credentials:delete',
      call: async (hook: string, _ctx: unknown, input: any) => {
        if (hook === 'storage:get') return { value: store.get(input.key) };
        if (hook === 'storage:set') { store.set(input.key, input.value); return undefined; }
        if (hook === 'credentials:list') return { credentials: creds };
        if (hook === 'credentials:delete') { deleted.push(input.ref); return undefined; }
        throw new Error(`unexpected hook ${hook}`);
      },
    } as unknown as HookBus;
    return { bus, store, deleted };
  }

  const ctx = makeAgentContext({ sessionId: 'init', agentId: 'a', userId: 'init' });

  describe('sweepStdioConfigs', () => {
    it('deletes stdio rows, rewrites the index, purges their env slots, keeps http rows', async () => {
      const { bus, store, deleted } = fakeBus(
        {
          'mcp-server-index': ['local', 'remote'],
          'mcp-server:local': { id: 'local', enabled: true, transport: 'stdio', command: 'npx', args: [], env: { GH_TOKEN: '' }, credentialRefs: { GH_TOKEN: 'x' } },
          'mcp-server:remote': { id: 'remote', enabled: true, transport: 'streamable-http', url: 'https://mcp.example.com' },
        },
        [
          { scope: 'global', ownerId: null, ref: 'mcp:local:env:GH_TOKEN' },
          { scope: 'global', ownerId: null, ref: 'mcp:remote:header:Authorization' },
        ],
      );
      expect(await sweepStdioConfigs(bus, ctx)).toBe(1);
      expect(JSON.parse(dec.decode(store.get('mcp-server-index')!))).toEqual(['remote']);
      expect(store.get('mcp-server:local')!.length).toBe(0);
      expect(deleted).toEqual(['mcp:local:env:GH_TOKEN']);
    });

    it('is a no-op the second time and with no index', async () => {
      const { bus } = fakeBus({ 'mcp-server-index': ['remote'], 'mcp-server:remote': { id: 'remote', enabled: true, transport: 'sse', url: 'https://x.example' } }, []);
      expect(await sweepStdioConfigs(bus, ctx)).toBe(0);
      expect(await sweepStdioConfigs(fakeBus({}, []).bus, ctx)).toBe(0);
    });

    it('leaves a non-JSON row alone (loadConfigs already skips it)', async () => {
      const { bus, store } = fakeBus({ 'mcp-server-index': ['bad'], 'mcp-server:bad': 'not json' }, []);
      expect(await sweepStdioConfigs(bus, ctx)).toBe(0);
      expect(dec.decode(store.get('mcp-server:bad')!)).toBe('not json');
    });
  });
  ```

- [ ] **Step 2: Run it and confirm it fails.**

  Run: `pnpm --filter @ax/mcp-client test -- stdio-sweep`
  Expected: FAIL (module not found).

- [ ] **Step 3: Move the purge helper.** Cut `CredentialRow` and `purgeMcpCredentials` from `admin-routes.ts` into `credential-purge.ts`, keeping the comment block above them and adding `export`. Import it back into `admin-routes.ts`.

- [ ] **Step 4: Write the sweep.** Create `packages/mcp-client/src/stdio-sweep.ts`:

  ```ts
  // Boot-time sweep: hard-delete every stored stdio MCP server config (stdio was
  // removed 2026-10-04 — docs/plans/2026-10-04-drop-stdio-mcp-design.md). Reads
  // RAW JSON because parseConfig no longer accepts these rows. Purges the env
  // credential slots the row declared, tombstones the row (the same empty-buffer
  // delete `deleteConfig` uses — there is no storage:delete), and drops it from
  // the index. Idempotent; logs a count only.
  import type { AgentContext, HookBus } from '@ax/core';
  import { deleteConfig } from './config.js';
  import { purgeMcpCredentials } from './credential-purge.js';

  const dec = new TextDecoder();

  export async function sweepStdioConfigs(bus: HookBus, ctx: AgentContext): Promise<number> {
    const idx = await bus.call<{ key: string }, { value: Uint8Array | undefined }>('storage:get', ctx, { key: 'mcp-server-index' });
    if (idx.value === undefined || idx.value.length === 0) {
      ctx.logger.info('mcp_stdio_configs_swept', { count: 0 });
      return 0;
    }
    let ids: unknown;
    try {
      ids = JSON.parse(dec.decode(idx.value));
    } catch {
      return 0; // loadConfigs reports a corrupt index; not ours to fix here
    }
    if (!Array.isArray(ids)) return 0;

    let count = 0;
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const got = await bus.call<{ key: string }, { value: Uint8Array | undefined }>('storage:get', ctx, { key: `mcp-server:${id}` });
      if (got.value === undefined || got.value.length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(dec.decode(got.value));
      } catch {
        continue;
      }
      const r = raw as { transport?: unknown; env?: unknown; credentialRefs?: unknown };
      if (r?.transport !== 'stdio') continue;
      const envNames = [
        ...Object.keys(typeof r.env === 'object' && r.env !== null ? r.env : {}),
        ...Object.keys(typeof r.credentialRefs === 'object' && r.credentialRefs !== null ? r.credentialRefs : {}),
      ];
      try {
        await purgeMcpCredentials(bus, ctx, id, [...new Set(envNames)], []);
      } catch (err) {
        ctx.logger.warn('mcp_stdio_sweep_purge_failed', { serverId: id, err: err instanceof Error ? err.message : String(err) });
      }
      await deleteConfig(bus, ctx, id);
      count += 1;
    }
    ctx.logger.info('mcp_stdio_configs_swept', { count });
    return count;
  }
  ```

  - `deleteConfig` validates the id against `ID_RE`. If a stored id fails that check, it throws. Wrap the call in `try/catch`, log `mcp_stdio_sweep_delete_failed`, and keep going.
  - Check the purge test expectation against what `purgeMcpCredentials` builds (`mcp:${serverId}:env:${n}`).

- [ ] **Step 5: Run the sweep test.**

  Run: `pnpm --filter @ax/mcp-client test -- stdio-sweep`
  Expected: PASS.

- [ ] **Step 6: Remove stdio from config, transports, routes and plugin.**
  - `config.ts`: delete `StdioConfig`. The schema becomes `z.discriminatedUnion('transport', [StreamableHttpConfig, SseConfig])`. Before `McpServerConfigSchema.parse` in `parseConfig`, add:

  ```ts
    if ((input as { transport?: unknown } | null)?.transport === 'stdio') {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        message: 'stdio MCP servers are no longer supported — configure a streamable-http or sse server URL',
      });
    }
  ```

  - `transports.ts`:
    - Delete the `StdioClientTransport` import, `BASE_STDIO_ENV_KEYS` and its doc comment, `StdioParams`, `baseStdioEnv`, `buildStdioParams`, the `case 'stdio'`, and `StdioClientTransport` from the `McpClientTransport` union.
    - Delete the "For stdio, we explicitly pass `env`…" design note in the header.
    - If `resolveCredentials` was shared with stdio, keep it, since http uses it too.
  - `admin-routes.ts`: delete `envNamesOf`. Replace each `envNamesOf(x)` argument with `[]`, then simplify `purgeMcpCredentials` call sites that now pass `[]`.
  - `plugin.ts`:
    - Line 78 comment: `(streamable-http / sse)`.
    - In `init`, directly before `const configs = (await loadConfigs(bus, initCtx))…`, add:

    ```ts
      // stdio MCP servers were removed (2026-10-04); retire stored ones before
      // loading so none is ever spawned on the host.
      await sweepStdioConfigs(bus, initCtx);
    ```

    - Confirm `credentials:list` and `credentials:delete` are reachable at init. `credentials:get` is already in `calls`, so `@ax/credentials` inits first, and `purgeMcpCredentials` is `hasService`-guarded either way.
  - `packages/cli/src/commands/mcp.ts:132`: `out(\`${c.id}\t${status}\t${c.transport}\t${c.url}\`);`

- [ ] **Step 7: Fix fixture fallout and run.**

  Run: `pnpm --filter @ax/mcp-client --filter @ax/cli build`

  In each test file listed under Test:
  - Delete stdio-only tests: `buildStdioParams`, env allowlist, stdio spawn.
  - Convert generic tests (connect, recovery, admin CRUD, `parseConfig` round-trip) to `{ transport: 'streamable-http', url: 'https://mcp.example.com' }`. These use `InMemoryTransport` through `transportFactory`, so the transport label in the config is the only thing that changes.
  - Add to `config.test.ts`:

  ```ts
  it('rejects a stdio config with the migration hint', () => {
    expect(() => parseConfig({ id: 'x', enabled: true, transport: 'stdio', command: 'npx', args: [] })).toThrow(/no longer supported/);
  });
  ```

  Run: `pnpm --filter @ax/mcp-client --filter @ax/cli test`
  Expected: PASS.

- [ ] **Step 8: Commit.**

  ```bash
  git add -A packages/mcp-client packages/cli
  git commit -m "Remove stdio from @ax/mcp-client and ax mcp; sweep stored stdio configs at boot"
  ```

---

### Task 6: channel-web — stdio-free connector editor

**Files:**
- Modify: `packages/channel-web/src/lib/connector-form.ts:53, 140-160, 225-240, 295-340, 375-390`
- Modify: `packages/channel-web/src/components/settings/LegacyConnectorEditDialog.tsx:10-20, 131-138, 496, 570-580, 870-935, 989`
- Modify: `packages/channel-web/src/components/settings/ConnectorEditDialog.tsx:51-55`
- Modify: `packages/channel-web/src/lib/connectors.ts:61, 515-535`
- Modify: `packages/channel-web/mock/admin/connectors.ts:60-61`, `packages/channel-web/mock/admin/mcp-servers.ts`, `packages/channel-web/mock/__tests__/admin-mcp.test.ts`
- Test: `packages/channel-web/src/components/settings/__tests__/RemoteMcpConnectorForm.test.tsx:667-702` (the routing pin). Fallout: `ConnectorEditDialog.test.tsx` renders the LEGACY dialog. Its `FULL` fixture (lines 22-38) is stdio and becomes `mcpServers: []` plus a Direct-API host. Its transport-combobox cases (~73, ~265-276, ~299-302) are deleted or turned into URL-field cases. Also `connector-form.test.ts`, `LegacyConnectorEditDialog.endpoint-reset.test.tsx`, `connectors-credential-plan.test.ts`, `remote-mcp-form.test.ts`

**Interfaces:**
- Produces: `ConnectorFormState` without `transport`, `command` or `args`. An MCP mechanism means an http `url`.
- `ConnectorEditDialog` routing: `mcpServers.length > 0` → `RemoteMcpConnectorForm`; otherwise → `LegacyConnectorEditDialog`.

- [ ] **Step 1: Invoke the `shadcn` skill.** CLAUDE.md invariant 6 requires it for any UI change. This task only removes controls and adds no components.

- [ ] **Step 2: Update the routing pin (the failing test).** The wrapper's routing is pinned by `src/components/settings/__tests__/RemoteMcpConnectorForm.test.tsx:667-702`, `it.each(['api', 'cli', 'stdio'])`, "keeps the %s connector editor reachable without converting it to remote MCP". Change it to:

  ```tsx
    it.each(['api', 'cli'] as const)(
      'keeps the %s connector editor reachable without converting it to remote MCP',
      async (mechanism) => {
        // A redundant fetch must not leave Save operating on summary-only data.
        stallRepeatedConnectorLoad = true;
        fixture.capabilities.credentials = [];
        fixture.capabilities.mcpServers = [];
        fixture.capabilities.packages = {
          npm: mechanism === 'cli' ? ['example-cli'] : [],
          pypi: [],
        };
        // … the rest of the body is unchanged …
      },
    );

    it('opens a connector whose lead MCP server is NOT first-listed http in the remote form', async () => {
      // Routing keys on "has any MCP server", not on mcpServers[0].transport.
      fixture.capabilities.mcpServers = [
        { name: 'remote', transport: 'http', url: 'https://mcp.example.com/a', allowedHosts: [], credentials: [] },
        { name: 'second', transport: 'http', url: 'https://mcp.example.com/b', allowedHosts: [], credentials: [] },
      ];
      render(<ConnectorEditDialog {...props()} />);
      expect(await screen.findByLabelText('Server URL')).toBeInTheDocument();
    });
  ```

  The second case already passes today (both servers are http). It pins the new routing condition so a future regression to `transport === 'http'` can't slip back in. If the fixture variable or URL label differs, use the names the neighboring cases in this file use (`fixture`, `props()`, `'Server URL'` are what lines 150-702 use).

- [ ] **Step 3: Run it.**

  Run: `pnpm --filter @ax/channel-web test -- RemoteMcpConnectorForm.test`
  Expected: it FAILS to compile under `pnpm --filter @ax/channel-web build` once Step 5 removes stdio from the types, and passes after Steps 4-5. Run it again at Step 9.

- [ ] **Step 4: Change the routing.** In `ConnectorEditDialog.tsx`:

  ```tsx
    if (loaded?.id === id) {
      if (loaded.connector.capabilities.mcpServers.length > 0)
        return <RemoteMcpConnectorForm {...props} connector={loaded.connector} />;
      return <LegacyConnectorEditDialog {...props} connector={loaded.connector} />;
    }
  ```

- [ ] **Step 5: Strip stdio from the form model.** In `lib/connector-form.ts`:
  - Delete `export type Transport = 'stdio' | 'http';` and the `transport`, `command`, `args` fields from `ConnectorFormState` and its initial state (lines ~148-150) and from `formFromConnector` (lines ~233-235).
  - `buildLeadingMcpServer` returns:

  ```ts
    return {
      name: existing?.name || form.connectorId || connectorIdFromName(form.name),
      allowedHosts: existing?.allowedHosts ?? [],
      credentials: existing?.credentials ?? [],
      transport: 'http',
      url: form.url.trim(),
    };
  ```

  - `endpointOf`: `return JSON.stringify([spec.transport, spec.url ?? null]);`, and update its doc comment to "transport, url".
  - `hasMcp`: `const hasMcp = form.url.trim().length > 0;`
  - Fix the header comment (lines 18-19): "MCP server → builds the leading `mcpServers[0]` (an http url); credential slots are its secrets (headers)".
  - Then `grep -rn "Transport\b\|form.transport\|form.command\|form.args" packages/channel-web/src` and fix every hit.

- [ ] **Step 6: Strip stdio from the legacy dialog.** In `LegacyConnectorEditDialog.tsx`:
  - Header comment, line 14: `MCP server → an http url + secrets (headers).`
  - `secretsLabel`: the `mcp` arm returns `'Secrets (headers)'`.
  - Line 496: `const discoveryUrl = open && form.mechanism === 'mcp'` (drop the `&& form.transport === 'http'`).
  - The endpoint-change comment (~570): "a new URL".
  - Lines ~873-920: delete the Transport `Select` block and the stdio Command/Args branch, leaving only the URL `Input` block, unwrapped from the ternary.
  - Line 989: the condition `(form.mechanism !== 'mcp' || form.transport === 'http')` was always true once stdio is gone. Delete the wrapping `{… && (` / `)}` and render the `FieldGroup` unconditionally.
  - Remove `Transport` from the imports.

- [ ] **Step 7: `lib/connectors.ts`.**
  - Line 61: `transport: 'http';`. Delete `command?`, `args?`, `env?` if they are declared on `ConnectorMcpServerSpec`.
  - `mechanismHint`: delete `if (transport === 'stdio') return 'env var';`. If the `MechanismHint` type union includes `'env var'` only for stdio, check `grep -n "env var" src` first. CLI connectors may also use it; if so, keep it in the type.
  - Update the doc comment above it to drop the stdio bullet.

- [ ] **Step 8: Mocks.** Convert the stdio entries in `mock/admin/connectors.ts:60-61` and `mock/admin/mcp-servers.ts` (lines 10, 18, 36, 97, 129-130) to http/streamable-http with `url: 'https://mcp.example.com/<name>'`, and update `mock/__tests__/admin-mcp.test.ts` to match.

- [ ] **Step 9: Fix test fallout and run.**
  - Fix each listed test with the rules from Task 1 Step 9.
  - In `connector-form.test.ts` (22 hits), the default-transport and stdio build cases go, and the http cases stay.
  - In `connectors-credential-plan.test.ts`, delete the `'env var'` for stdio case. Per the comment it's security copy, so make sure the `'header'` and `'request auth'` cases still pass.

  Run: `pnpm --filter @ax/channel-web build && pnpm --filter @ax/channel-web test`
  Expected: PASS. channel-web's tsc includes test files, so the build catches stale test types.

- [ ] **Step 10: Commit.**

  ```bash
  git add -A packages/channel-web
  git commit -m "Remove the stdio option from the connector editor"
  ```

---

### Task 7: Docs, memory, full gate, PR

**Files:**
- Modify: `packages/mcp-client/SECURITY.md` (lines 17, 19, 25+, 67), `deploy/MANUAL-ACCEPTANCE.md:1220-1240`, `packages/agent-aisdk-runner/README.md:93`
- Create: `.changeset/drop-stdio-mcp.md`
- Create: a memory shard via `scripts/memory-write-target.sh --shard decisions <TASK-ID>`

- [ ] **Step 1: Docs.**
  - `mcp-client/SECURITY.md`: replace the stdio subprocess and env-allowlist sections with one paragraph: "stdio MCP servers were removed (2026-10-04). This plugin connects only to remote servers over streamable-http or sse; it spawns no processes. Stored stdio configs are deleted at boot."
  - `MANUAL-ACCEPTANCE.md:1220-1240`: change the example server to `transport: http` with `url: https://mcp.example.com`.
  - `agent-aisdk-runner/README.md:93`: drop the stdio mention.
  - Use the CLAUDE.md voice rules: plain and direct, no jokes in the security text.

- [ ] **Step 2: Changeset.** Create `.changeset/drop-stdio-mcp.md`. Use the frontmatter style of an existing file in `.changeset/` and list each touched package as `patch`. The body: "Remove stdio MCP servers everywhere; stored stdio connectors, drafts and mcp-client configs are deleted at boot."

- [ ] **Step 3: Full gate.**

  Run: `pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`
  Expected: all green. A failure in `@ax/auth-better`'s Docker teardown with all assertions passing is the known local flake (CLAUDE.md). Note it, and don't count it as green or as caused by this change.

- [ ] **Step 4: Leftover sweep.**

  Run: `git grep -n -i "'stdio'\|\"stdio\"\|transport: stdio" -- packages presets ':!**/node_modules/**'`
  - Expected hits:
    - `child_process` `stdio:` options;
    - the golden-vector rejection fixtures;
    - the rejection checks (connectors store, mcp-client `parseConfig`, `validateMcpEntry`, both sweeps);
    - `interrupt-real-sdk.e2e.test.ts` and `interrupt-processes.ts`;
    - `capability-freshness.ts`.
  - Any other hit is a miss. Fix it in the task that owns it.

- [ ] **Step 5: Memory shard.**

  ```bash
  path=$(scripts/memory-write-target.sh --shard decisions <TASK-ID>)
  mkdir -p "$(dirname "$path")"
  ```

  Write rows covering:
  - stdio removed everywhere;
  - hard-delete sweeps in connectors and mcp-client init;
  - `capability-freshness` deliberately unchanged (stored digests);
  - the aisdk-connector card is now http-only and unblocked.

  Commit it with the docs.

- [ ] **Step 6: Commit and open the PR.**
  - Commit docs + changeset + shard.
  - `git push -u origin drop-stdio-mcp`.
  - Open the PR with `gh pr create`. The body needs:
    - a summary;
    - the **Boundary review** (copy from the spec: payloads only narrow, no new field names, alternate implementations unchanged);
    - the **Security note** from the `security-checklist` skill (invoke it);
    - a warning that **the sweep hard-deletes stored stdio connectors, drafts and mcp-client configs on first boot**;
    - the test plan.

  End the body with the attribution line.
