# aisdk Runner Connector (HTTP MCP) Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent on the aisdk runner can call its attached connectors' tools (remote streamable-HTTP MCP servers), with the same names, policy keys, labels, and credential path as a claude-sdk agent.

**Architecture:**
- Move the claude-sdk runner's projection loader (`$CLAUDE_CONFIG_DIR/skills/*/.mcp.json`) into `@ax/agent-runner-core` so both runners share it.
- The aisdk runner gets a new `tools/connector-tools.ts`. At session start it connects one `@modelcontextprotocol/sdk` `Client` per connector, through the runner's credential-proxy fetch.
- It exposes each tool to the model as `mcp__<ns>__<tool>` and gates every call through `wrapWithPolicy` under the canonical `mcp.<ns>.<tool>`.
- channel-web's runner allow-list adds `aisdk`.

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes`), `ai@7.0.70`, `@modelcontextprotocol/sdk@1.30.0`, undici `ProxyAgent`, vitest 5, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-04-aisdk-connectors-design.md`

**Worktree:** `/Users/vpulim/dev/ai/ax-next-task-826`, branch `task-826-aisdk-connectors`. Every command below runs from that directory. Never work in `/Users/vpulim/dev/ai/ax-next` (the shared checkout).

## Global Constraints

- Transport: streamable HTTP only. stdio entries are skipped by name (already done by `validateMcpEntry`).
- MCP client: `@modelcontextprotocol/sdk` **exact** `1.30.0`, `Client` + `StreamableHTTPClientTransport`. Never `@ai-sdk/mcp`.
- Model-facing tool name: `mcp__<ns>__<tool>`. Policy/canonical name: `mcp.<ns>.<tool>`.
- Namespace shape: `/^c[0-9a-f]{10}$/` (`CONNECTOR_TOOL_NAMESPACE_RE`).
- Model tool-name gate: `/^[a-zA-Z0-9_-]{1,64}$/`. Skip with a log line; never rename.
- Connect + list bound: `10_000` ms per connector, all connectors in parallel.
- Call timeout: `300_000` ms with `resetTimeoutOnProgress: true`, plus the tool's `abortSignal`.
- Max `256` tools per connector. Max `16` `tools/list` pages. Output cap `100 * 1024` bytes. `close()` bound `5_000` ms.
- `isError: true` results **throw** (ai@7 turns that into `tool-error`; the turn continues).
- A connector failure never fails the session boot. It writes one stderr line: `runner: connector-mcp: <ns>: <reason>`.
- Read only `$CLAUDE_CONFIG_DIR/skills/`. Never `.claude/` or the workspace (I3).
- No hook-surface change, and no cross-plugin imports (runner-core is a library, not a plugin).
- Bash tool runs zsh: write `"${x}:foo"`, never `"$x:foo"`. Never name a shell variable `path`.
- `pnpm --filter <pkg> test`: the filter goes BEFORE the script. Always run `tsc` too (`pnpm --filter <pkg> build`), because vitest tolerates type errors.
- Commit message trailer (every commit):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01S2P8ACKYLoikhyBo5ZXrko
  ```

## Review Focus

1. **Pressing Stop during a slow connector call.** The call must reject promptly via `abortSignal`, not hang for 5 minutes. (Task 3: "aborts an in-flight call on Stop".)
2. **A connector whose token expired, where the proxy or server answers 401.** Only that connector's tools go missing, with a log line, and the session still boots. (Task 3: "drops a connector that answers 401".)
3. **A server that paginates `tools/list`.** All pages load, up to the 16-page bound. (Task 3: "follows nextCursor".)
4. **A huge tool result**, such as a multi-MB search dump. It is truncated at 100 KB with a visible marker, not passed whole to the model. (Task 2: "caps output".)
5. **A connector bundle whose Skill is loaded but whose server failed.** The model is told plainly that the tools are missing; skills that loaded get no false warning. (Task 4.)

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/agent-runner-core/src/projected-mcp-servers.ts` (moved from claude-sdk) | Read + validate the host projection → `{ servers: Record<ns, {url, headers?, bundle}>, skipped }`. Owns `CONNECTOR_TOOL_NAMESPACE_RE`. |
| `packages/agent-runner-core/src/__tests__/projected-mcp-servers.test.ts` (moved) | Loader trust-shape tests. |
| `packages/agent-claude-sdk-runner/src/projected-mcp-servers.ts` (rewritten, tiny) | Adapter: core loader → SDK `McpServerConfig`. Same export name, so `main.ts` and the e2e test are unchanged. |
| `packages/agent-claude-sdk-runner/src/__tests__/projected-mcp-servers.test.ts` (rewritten, tiny) | Adapter test. |
| `packages/agent-claude-sdk-runner/src/tool-names.ts` | Re-export `CONNECTOR_TOOL_NAMESPACE_RE` from runner-core. |
| `packages/agent-aisdk-runner/src/tools/mcp-result.ts` | `renderMcpResult` — untrusted MCP result → capped string. |
| `packages/agent-aisdk-runner/src/tools/connector-tools.ts` | `connectConnectorTools` — connect, list, filter, wrap, close. |
| `packages/agent-aisdk-runner/src/__tests__/helpers/mcp-test-server.ts` | Inline streamable-HTTP MCP server for tests (configurable tools, header capture, pagination, forced status). |
| `packages/agent-aisdk-runner/src/tools/skill-tool.ts` / `skills-index.ts` | Accurate `MCP_NOT_LOADED_NOTE`, replacing `MCP_UNAVAILABLE_NOTE`. |
| `packages/agent-aisdk-runner/src/main.ts` | Wire the loader + connector tools into the session; close them in `finally`. |
| `packages/agent-aisdk-runner/src/__tests__/parity.e2e.test.ts` | Acceptance: real `main()` calls a connector tool. |
| `packages/channel-web/src/server/routes-workspace.ts` | `runnerLoadsConnectors` += `'aisdk'`. |

---

### Task 1: Move the projection loader into `@ax/agent-runner-core`

**Files:**
- Move: `packages/agent-claude-sdk-runner/src/projected-mcp-servers.ts` → `packages/agent-runner-core/src/projected-mcp-servers.ts`
- Move: `packages/agent-claude-sdk-runner/src/__tests__/projected-mcp-servers.test.ts` → `packages/agent-runner-core/src/__tests__/projected-mcp-servers.test.ts`
- Modify: `packages/agent-runner-core/src/index.ts` (exports)
- Create (new content at old path): `packages/agent-claude-sdk-runner/src/projected-mcp-servers.ts`, `packages/agent-claude-sdk-runner/src/__tests__/projected-mcp-servers.test.ts`
- Modify: `packages/agent-claude-sdk-runner/src/tool-names.ts:146-152`

**Interfaces:**
- Produces (runner-core, exported from the package root):
  ```ts
  export const CONNECTOR_TOOL_NAMESPACE_RE: RegExp; // /^c[0-9a-f]{10}$/
  export interface ProjectedMcpServer { url: string; headers?: Record<string, string>; bundle: string }
  export interface ProjectedMcpServers { servers: Record<string, ProjectedMcpServer>; skipped: string[] }
  export function loadProjectedMcpServers(configDir: string | undefined, log?: (line: string) => void): Promise<ProjectedMcpServers>;
  ```
- Produces (claude-sdk, unchanged name and shape for its callers):
  `loadProjectedMcpServers(configDir, log?) → Promise<{ servers: Record<string, McpServerConfig>; skipped: string[] }>`

- [ ] **Step 1: Move the files with git**

```bash
git mv packages/agent-claude-sdk-runner/src/projected-mcp-servers.ts packages/agent-runner-core/src/projected-mcp-servers.ts
git mv packages/agent-claude-sdk-runner/src/__tests__/projected-mcp-servers.test.ts packages/agent-runner-core/src/__tests__/projected-mcp-servers.test.ts
```

- [ ] **Step 2: Update the moved test to the runner-neutral shape (failing first)**

In `packages/agent-runner-core/src/__tests__/projected-mcp-servers.test.ts`:
- The import stays `from '../projected-mcp-servers.js'`.
- Change the header comment's "query()'s `mcpServers`" to "either runner's connector wiring".
- Replace every expected server value: `{ type: 'http', url: X }` → `{ url: X, bundle: '<dir>' }`, and `{ type: 'http', url: X, headers: H }` → `{ url: X, headers: H, bundle: '<dir>' }`.

Concretely:
- in "loads http connector servers…", rename the test to `'loads http connector servers, recording the bundle each came from'` and expect:
  ```ts
  expect(r.servers).toEqual({
    c0123456789: { url: 'https://plain.example.com/', bundle: 'connector-a' },
    cabcdef0123: { url: 'https://mcp.example.com/', headers: { Authorization: `Bearer ${PH}` }, bundle: 'connector-b' },
  });
  ```
- in the stdio test: `expect(out.servers['c9876543210']).toEqual({ url: 'https://mcp.example.com', bundle: 'conn' });`
- in the duplicate test, add: `expect(r.servers['c0123456789']).toMatchObject({ bundle: 'a-first' });`

Every other assertion (`toMatchObject({ url })`, `Object.keys`, `skipped`) is unchanged.

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ax/agent-runner-core exec vitest run src/__tests__/projected-mcp-servers.test.ts`

Expected: FAIL. The import of `@anthropic-ai/claude-agent-sdk` (not a runner-core dep) and `./tool-names.js` cannot resolve, and/or the shapes mismatch.

- [ ] **Step 4: Make the moved loader runner-neutral**

In `packages/agent-runner-core/src/projected-mcp-servers.ts`:

1. Replace the three imports after `node:path` with:
   ```ts
   import { validateMcpEntry } from './installed-skills.js';
   ```
2. Add, right after the imports:
   ```ts
   /**
    * Shape of a host-minted connector `toolNamespace`: `c` + 10 lowercase hex.
    * Mirrors `@ax/connectors`' `TOOL_NAMESPACE_RE` (no cross-plugin import, I2).
    * Anchored and case-sensitive on purpose — `C0123456789`, 9/11 hex chars and
    * non-hex characters are all NOT host-minted and are not loaded or lifted.
    * The one place both runners read the namespace shape from.
    */
   export const CONNECTOR_TOOL_NAMESPACE_RE = /^c[0-9a-f]{10}$/;
   ```
3. Replace the `ProjectedMcpServers` interface with:
   ```ts
   /** One connector server, runner-neutral. Each runner adapts it to its own client. */
   export interface ProjectedMcpServer {
     url: string;
     /** Header values are `ax-cred:` placeholders — the credential proxy swaps them. */
     headers?: Record<string, string>;
     /** The skills-projection directory (bundle id) the server came from. */
     bundle: string;
   }

   export interface ProjectedMcpServers {
     /** Keyed by the host-minted toolNamespace. */
     servers: Record<string, ProjectedMcpServer>;
     /** One human-readable reason per skipped file or server (also logged). */
     skipped: string[];
   }
   ```
4. Replace `toSdkConfig` with:
   ```ts
   function toServer(e: ReturnType<typeof validateMcpEntry>, bundle: string): ProjectedMcpServer {
     return { url: e.url, ...(e.headers ? { headers: e.headers } : {}), bundle };
   }
   ```
5. In the loop, set `const servers: Record<string, ProjectedMcpServer> = {};`, and use `servers[key] = toServer(validateMcpEntry(toEntry(key, value)), dir);`.
6. In the file-header comment:
   - change the paragraph beginning "So the runner reads the projection itself and hands the servers to `query()` explicitly." to "So each runner reads the projection itself through this one loader (the claude-sdk runner hands the servers to `query()`; the aisdk runner connects its own MCP clients — `tools/connector-tools.ts`).";
   - add the line "Moved here from the claude-sdk runner in TASK-826 so both runners share it."

- [ ] **Step 5: Export from runner-core's root**

In `packages/agent-runner-core/src/index.ts`, after the `installed-skills.js` export line, add:

```ts
export {
  CONNECTOR_TOOL_NAMESPACE_RE,
  loadProjectedMcpServers,
} from './projected-mcp-servers.js';
export type { ProjectedMcpServer, ProjectedMcpServers } from './projected-mcp-servers.js';
```

- [ ] **Step 6: Run the runner-core test to verify it passes**

Run: `pnpm --filter @ax/agent-runner-core exec vitest run src/__tests__/projected-mcp-servers.test.ts`

Expected: PASS (9 tests).

- [ ] **Step 7: Write the claude-sdk adapter test (failing)**

Create `packages/agent-claude-sdk-runner/src/__tests__/projected-mcp-servers.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectedMcpServers } from '../projected-mcp-servers.js';

// The loader itself lives in @ax/agent-runner-core (TASK-826) and its
// trust-shape suite moved with it. This pins only the claude-sdk adapter: the
// runner-neutral server becomes the SDK's `McpServerConfig` (`type: 'http'`,
// no `bundle`), which `query({ mcpServers })` is handed verbatim.

const PH = 'ax-cred:' + '0'.repeat(32);
let cfg: string;

beforeEach(async () => {
  cfg = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-t826-'));
});
afterEach(async () => {
  await fs.rm(cfg, { recursive: true, force: true });
});

describe('loadProjectedMcpServers (claude-sdk adapter)', () => {
  it('maps projected servers to the SDK http McpServerConfig shape', async () => {
    const dir = path.join(cfg, 'skills', 'conn');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          c0123456789: { type: 'http', url: 'https://plain.example.com/' },
          cabcdef0123: { type: 'http', url: 'https://mcp.example.com/', headers: { Authorization: `Bearer ${PH}` } },
          c0000000001: { command: 'npx' },
        },
      }),
    );
    const skippedLines: string[] = [];
    const r = await loadProjectedMcpServers(cfg, (l) => skippedLines.push(l));
    expect(r.servers).toEqual({
      c0123456789: { type: 'http', url: 'https://plain.example.com/' },
      cabcdef0123: { type: 'http', url: 'https://mcp.example.com/', headers: { Authorization: `Bearer ${PH}` } },
    });
    expect(r.skipped).toEqual([expect.stringMatching(/c0000000001.*stdio/)]);
    expect(skippedLines).toEqual(r.skipped);
  });

  it('returns nothing with no config dir', async () => {
    expect(await loadProjectedMcpServers(undefined, () => {})).toEqual({ servers: {}, skipped: [] });
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm --filter @ax/agent-claude-sdk-runner exec vitest run src/__tests__/projected-mcp-servers.test.ts`

Expected: FAIL, "Failed to load url ../projected-mcp-servers.js" (the file was moved).

- [ ] **Step 9: Write the claude-sdk adapter**

Create `packages/agent-claude-sdk-runner/src/projected-mcp-servers.ts`:

```ts
// ---------------------------------------------------------------------------
// Connector MCP servers → the SDK's `mcpServers` option (TASK-760).
//
// The loader (trust shape, validation, never-throws) lives in
// `@ax/agent-runner-core` since TASK-826, shared with the aisdk runner. This
// is only the last-mile adapter: the runner-neutral server becomes the SDK's
// http `McpServerConfig`. See runner-core's `projected-mcp-servers.ts` for
// why the runner reads the projection itself at all — the CLI never reads a
// skill directory's `.mcp.json` (pinned by connector-mcp-real-sdk.e2e.test.ts).
// ---------------------------------------------------------------------------

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { loadProjectedMcpServers as loadProjection } from '@ax/agent-runner-core';

export interface ProjectedMcpServers {
  /** Ready for `query({ options: { mcpServers } })`, keyed by toolNamespace. */
  servers: Record<string, McpServerConfig>;
  /** One human-readable reason per skipped file or server (also logged). */
  skipped: string[];
}

export async function loadProjectedMcpServers(
  configDir: string | undefined,
  log?: (line: string) => void,
): Promise<ProjectedMcpServers> {
  const { servers, skipped } = await loadProjection(configDir, log);
  const out: Record<string, McpServerConfig> = {};
  for (const [ns, s] of Object.entries(servers)) {
    out[ns] = { type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
  }
  return { servers: out, skipped };
}
```

- [ ] **Step 10: Point `tool-names.ts` at the shared regex**

In `packages/agent-claude-sdk-runner/src/tool-names.ts`, replace the doc comment + `export const CONNECTOR_TOOL_NAMESPACE_RE = /^c[0-9a-f]{10}$/;` (lines ~146-152) with:

```ts
// The namespace shape lives in @ax/agent-runner-core (TASK-826) so the aisdk
// runner reads the same one. Re-exported for this runner's existing callers.
import { CONNECTOR_TOOL_NAMESPACE_RE } from '@ax/agent-runner-core';
export { CONNECTOR_TOOL_NAMESPACE_RE };
```

Move the `import` line to the top of the file with the other imports, and keep the `export { … }` where the const was. In the file's comment at line ~62, change "(`projected-mcp-servers.ts`, TASK-760 —" to "(`projected-mcp-servers.ts` → runner-core's loader, TASK-760/826 —".

- [ ] **Step 11: Run both packages' suites and type-checks**

```bash
pnpm --filter @ax/agent-runner-core build && pnpm --filter @ax/agent-runner-core test
pnpm --filter @ax/agent-claude-sdk-runner build && pnpm --filter @ax/agent-claude-sdk-runner test
```

Expected: all PASS. `tool-names.test.ts` still passes (it imports `CONNECTOR_TOOL_NAMESPACE_RE` from `../tool-names.js`). `connector-mcp-real-sdk.e2e.test.ts` passes, or is skipped if the SDK binary is absent, exactly as before; check that its status did not change versus `origin/main`.

- [ ] **Step 12: Commit**

```bash
git add -A packages/agent-runner-core packages/agent-claude-sdk-runner
git commit -m "[TASK-826] Move connector .mcp.json loader into @ax/agent-runner-core

Both runners now share one projection loader; the claude-sdk runner keeps a
thin adapter to the SDK's McpServerConfig. The loader records each server's
bundle dir for the aisdk Skill note.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S2P8ACKYLoikhyBo5ZXrko"
```

---

### Task 2: aisdk dependencies, the MCP test server, and `renderMcpResult`

**Files:**
- Modify: `packages/agent-aisdk-runner/package.json`, `pnpm-lock.yaml`
- Create: `packages/agent-aisdk-runner/src/tools/mcp-result.ts`
- Create: `packages/agent-aisdk-runner/src/__tests__/helpers/mcp-test-server.ts`
- Test: `packages/agent-aisdk-runner/src/__tests__/mcp-result.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // tools/mcp-result.ts
  export const MAX_MCP_OUTPUT_BYTES: number; // 100 * 1024
  export function renderMcpResult(res: { content?: unknown; structuredContent?: unknown }): string;
  // __tests__/helpers/mcp-test-server.ts
  export interface TestTool { name: string; description?: string; inputSchema?: Record<string, unknown>;
    handler?: (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult }
  export interface McpTestServer { url: string; seenHeaders: IncomingHttpHeaders[]; close(): Promise<void> }
  export function startMcpTestServer(opts: { tools: TestTool[]; pageSize?: number; status?: number }): Promise<McpTestServer>;
  export function startHangingServer(): Promise<{ url: string; close(): Promise<void> }>;
  ```

- [ ] **Step 1: Add the dependencies**

In `packages/agent-aisdk-runner/package.json`:
- add to `dependencies` (alphabetical, exact pin, no caret): `"@modelcontextprotocol/sdk": "1.30.0",`
- add to `devDependencies`: `"@ax/test-harness": "workspace:*",`

Then:

```bash
pnpm install --prefer-offline
git diff --stat pnpm-lock.yaml
git diff pnpm-lock.yaml | grep '^+' | grep -E "^\+  /|^\+  '@|resolution" | head
```

Expected: the lockfile diff only adds the two importer entries under `packages/agent-aisdk-runner`. There are **no** new package resolution blocks, because `@modelcontextprotocol/sdk@1.30.0` is already resolved. If a new resolution block appears, STOP and report it; that is new supply-chain surface the spec says doesn't exist.

- [ ] **Step 2: Write the test server helper**

Create `packages/agent-aisdk-runner/src/__tests__/helpers/mcp-test-server.ts`:

```ts
// In-process streamable-HTTP MCP server for the connector tests. Stateless
// mode (fresh Server + transport per request), same shape as
// @ax/test-harness's mcp-http-server-stub — but in-process and configurable,
// so a test can capture request headers, page `tools/list`, force an HTTP
// status, or hand back `isError` results.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

export interface TestTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler?: (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult;
}

export interface McpTestServer {
  url: string;
  /** Headers of every HTTP request the server received, in order. */
  seenHeaders: IncomingHttpHeaders[];
  close(): Promise<void>;
}

export async function startMcpTestServer(opts: {
  tools: TestTool[];
  /** Page `tools/list` this many tools at a time (cursor = start index). */
  pageSize?: number;
  /** Answer EVERY request with this bare status instead of speaking MCP. */
  status?: number;
}): Promise<McpTestServer> {
  const seenHeaders: IncomingHttpHeaders[] = [];
  const listed = opts.tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    inputSchema: t.inputSchema ?? { type: 'object' },
  }));

  const makeServer = (): Server => {
    const server = new Server({ name: 'ax-aisdk-test-mcp', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      if (opts.pageSize === undefined) return { tools: listed as never };
      const start = Number(req.params?.cursor ?? '0');
      const end = start + opts.pageSize;
      return {
        tools: listed.slice(start, end) as never,
        ...(end < listed.length ? { nextCursor: String(end) } : {}),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const t = opts.tools.find((x) => x.name === req.params.name);
      if (t?.handler === undefined) {
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
      }
      return t.handler((req.params.arguments ?? {}) as Record<string, unknown>);
    });
    return server;
  };

  const http = createServer((req, res) => {
    seenHeaders.push(req.headers);
    if (opts.status !== undefined) {
      res.writeHead(opts.status).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : undefined;
        const transport = new StreamableHTTPServerTransport({});
        const server = makeServer();
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res, body);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenHeaders,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

/** Accepts TCP connections and never answers — a wedged server. */
export async function startHangingServer(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const srv = createNetServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        srv.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 3: Write the failing `renderMcpResult` test**

Create `packages/agent-aisdk-runner/src/__tests__/mcp-result.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_MCP_OUTPUT_BYTES, renderMcpResult } from '../tools/mcp-result.js';

describe('renderMcpResult', () => {
  it('joins text parts with newlines', () => {
    expect(
      renderMcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    ).toBe('a\nb');
  });

  it('inlines an embedded text resource and placeholders a binary one', () => {
    expect(
      renderMcpResult({
        content: [
          { type: 'resource', resource: { uri: 'file:///a.md', text: 'doc body' } },
          { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAAA' } },
          { type: 'resource_link', uri: 'https://x.example/r', name: 'r' },
        ],
      }),
    ).toBe('doc body\n[resource file:///b.bin omitted]\n[resource https://x.example/r omitted]');
  });

  it('placeholders image and audio parts by mime type', () => {
    expect(
      renderMcpResult({
        content: [
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        ],
      }),
    ).toBe('[image: image/png omitted]\n[audio: audio/wav omitted]');
  });

  it('falls back to structuredContent when there is no content', () => {
    expect(renderMcpResult({ content: [], structuredContent: { n: 1 } })).toBe('{"n":1}');
    expect(renderMcpResult({})).toBe('');
  });

  it('caps output at 100 KB with a visible marker', () => {
    const big = 'x'.repeat(MAX_MCP_OUTPUT_BYTES + 5000);
    const out = renderMcpResult({ content: [{ type: 'text', text: big }] });
    expect(MAX_MCP_OUTPUT_BYTES).toBe(100 * 1024);
    expect(out.endsWith('\n\n[output truncated at 100 KB]')).toBe(true);
    expect(Buffer.byteLength(out)).toBeLessThan(MAX_MCP_OUTPUT_BYTES + 100);
  });

  it('ignores junk content entries instead of throwing', () => {
    expect(renderMcpResult({ content: [null, 7, 'str', { type: 'text', text: 'ok' }] })).toBe('ok');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @ax/agent-aisdk-runner exec vitest run src/__tests__/mcp-result.test.ts`

Expected: FAIL, "Failed to load url ../tools/mcp-result.js".

- [ ] **Step 5: Implement `renderMcpResult`**

Create `packages/agent-aisdk-runner/src/tools/mcp-result.ts`:

```ts
// ---------------------------------------------------------------------------
// Render a connector's MCP `tools/call` result as the string `ai@7`'s execute
// returns (TASK-826).
//
// The result is UNTRUSTED third-party output. It only ever becomes the text of
// a tool result — never a path, a command, a URL or a system instruction — and
// it is size-capped so one chatty connector cannot flood the context window.
// Non-text parts (images, audio, binary resources) become short placeholders:
// this runner passes tool output to the model as text only, for now.
// ---------------------------------------------------------------------------

export const MAX_MCP_OUTPUT_BYTES = 100 * 1024;
const TRUNCATED_MARKER = '\n\n[output truncated at 100 KB]';

function renderPart(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  const p = part as Record<string, unknown>;
  const type = p['type'];
  if (type === 'text') return typeof p['text'] === 'string' ? p['text'] : undefined;
  if (type === 'resource') {
    const r = p['resource'];
    if (typeof r === 'object' && r !== null) {
      const res = r as Record<string, unknown>;
      if (typeof res['text'] === 'string') return res['text'];
      return `[resource ${String(res['uri'] ?? '')} omitted]`;
    }
    return '[resource omitted]';
  }
  if (type === 'resource_link') return `[resource ${String(p['uri'] ?? '')} omitted]`;
  const mime = typeof p['mimeType'] === 'string' ? `: ${p['mimeType']}` : '';
  return `[${String(type)}${mime} omitted]`;
}

function cap(text: string): string {
  if (Buffer.byteLength(text) <= MAX_MCP_OUTPUT_BYTES) return text;
  return Buffer.from(text).subarray(0, MAX_MCP_OUTPUT_BYTES).toString('utf8') + TRUNCATED_MARKER;
}

export function renderMcpResult(res: { content?: unknown; structuredContent?: unknown }): string {
  const content = Array.isArray(res.content) ? res.content : [];
  const parts = content.map(renderPart).filter((s): s is string => s !== undefined);
  if (parts.length > 0) return cap(parts.join('\n'));
  if (res.structuredContent !== undefined) return cap(JSON.stringify(res.structuredContent));
  return '';
}
```

- [ ] **Step 6: Run the test to verify it passes, then type-check**

```bash
pnpm --filter @ax/agent-aisdk-runner exec vitest run src/__tests__/mcp-result.test.ts
pnpm --filter @ax/agent-aisdk-runner build
```

Expected: 6 PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-aisdk-runner/package.json pnpm-lock.yaml packages/agent-aisdk-runner/src/tools/mcp-result.ts packages/agent-aisdk-runner/src/__tests__/mcp-result.test.ts packages/agent-aisdk-runner/src/__tests__/helpers/mcp-test-server.ts
git commit -m "[TASK-826] aisdk: MCP SDK dep, MCP result renderer, test MCP server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S2P8ACKYLoikhyBo5ZXrko"
```

---

### Task 3: `connectConnectorTools`

**Files:**
- Create: `packages/agent-aisdk-runner/src/tools/connector-tools.ts`
- Modify: `packages/agent-aisdk-runner/src/tools/policy-wrap.ts` (doc comment on `WrapWithPolicyOptions.name`, and the `mergeToolSets` error text)
- Test: `packages/agent-aisdk-runner/src/__tests__/connector-tools.test.ts`

**Interfaces:**
- Consumes: `ProjectedMcpServer` (Task 1), `renderMcpResult` (Task 2), `wrapWithPolicy` / `POLICY_WRAPPED` / `HOLD_LATCH` (`./policy-wrap.js`), `ToolPolicy` / `HoldLatch` / `createHoldLatch` (`@ax/agent-runner-core`).
- Produces:
  ```ts
  export const CONNECT_TIMEOUT_MS = 10_000;
  export const CALL_TIMEOUT_MS = 300_000;
  export const MAX_TOOLS_PER_CONNECTOR = 256;
  export const MODEL_TOOL_NAME_RE: RegExp; // /^[a-zA-Z0-9_-]{1,64}$/
  export interface ConnectorTools {
    tools: Record<string, Tool>;
    /** Bundle dirs whose server connected + listed (even if every tool was then skipped). */
    loadedBundles: Set<string>;
    close(): Promise<void>;
  }
  export function connectConnectorTools(opts: {
    servers: Record<string, ProjectedMcpServer>;
    fetch: typeof fetch | undefined;
    policy: ToolPolicy; holdLatch: HoldLatch;
    onHold: (toolCallId: string) => void; onToolFailure: (toolCallId: string) => void;
    disallowed: readonly string[];
    log?: (line: string) => void;
    connectTimeoutMs?: number;
  }): Promise<ConnectorTools>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/agent-aisdk-runner/src/__tests__/connector-tools.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMcpHttpServerStub } from '@ax/test-harness';
import { createHoldLatch, type PreToolVerdict, type ToolPolicy } from '@ax/agent-runner-core';
import {
  connectConnectorTools,
  MAX_TOOLS_PER_CONNECTOR,
  type ConnectorTools,
} from '../tools/connector-tools.js';
import { HOLD_LATCH, POLICY_WRAPPED, type WrappedExecute } from '../tools/policy-wrap.js';
import { startHangingServer, startMcpTestServer, type TestTool } from './helpers/mcp-test-server.js';

const NS = 'c0123456789';
const NS2 = 'cabcdef0123';
const PH = 'ax-cred:' + 'a'.repeat(32);

function fakePolicy(over: Partial<ToolPolicy> = {}): ToolPolicy & {
  preToolUse: ReturnType<typeof vi.fn>;
  postToolUse: ReturnType<typeof vi.fn>;
} {
  return {
    preToolUse: vi.fn(async (): Promise<PreToolVerdict> => ({ decision: 'allow' })),
    postToolUse: vi.fn(async () => ({})),
    ...over,
  } as never;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function connect(
  servers: Record<string, { url: string; headers?: Record<string, string>; bundle: string }>,
  over: Partial<Parameters<typeof connectConnectorTools>[0]> = {},
): Promise<ConnectorTools & { logs: string[]; policy: ReturnType<typeof fakePolicy> }> {
  const logs: string[] = [];
  const policy = fakePolicy();
  const ct = await connectConnectorTools({
    servers,
    fetch: undefined,
    policy,
    holdLatch: createHoldLatch(),
    onHold: () => {},
    onToolFailure: () => {},
    disallowed: [],
    log: (l) => logs.push(l),
    ...over,
  });
  cleanups.push(() => ct.close());
  return { ...ct, logs, policy: (over.policy as ReturnType<typeof fakePolicy>) ?? policy };
}

const exec = (ct: ConnectorTools, name: string, input: unknown, signal?: AbortSignal) =>
  (ct.tools[name]!.execute as WrappedExecute)(input, {
    toolCallId: 'call-1',
    ...(signal ? { abortSignal: signal } : {}),
  });

async function testServer(tools: TestTool[], extra: { pageSize?: number; status?: number } = {}) {
  const s = await startMcpTestServer({ tools, ...extra });
  cleanups.push(() => s.close());
  return s;
}

describe('connectConnectorTools', () => {
  it('offers tools as mcp__<ns>__<tool>, gates them as mcp.<ns>.<tool>, and round-trips a call', async () => {
    const stub = await startMcpHttpServerStub();
    cleanups.push(() => stub.close());
    const ct = await connect({ [NS]: { url: stub.url, bundle: 'conn-a' } });

    expect(Object.keys(ct.tools).sort()).toEqual([`mcp__${NS}__crash`, `mcp__${NS}__echo`]);
    expect(ct.loadedBundles).toEqual(new Set(['conn-a']));
    await expect(exec(ct, `mcp__${NS}__echo`, { text: 'hi there' })).resolves.toBe('hi there');
    expect(ct.policy.preToolUse).toHaveBeenCalledWith(`mcp.${NS}.echo`, { text: 'hi there' }, 'call-1');
    expect(ct.policy.postToolUse).toHaveBeenCalledWith(
      `mcp.${NS}.echo`, 'call-1', { text: 'hi there' }, 'hi there', false,
    );
  });

  it('wraps every tool with the policy and the ONE shared latch', async () => {
    const stub = await startMcpHttpServerStub();
    cleanups.push(() => stub.close());
    const holdLatch = createHoldLatch();
    const ct = await connect({ [NS]: { url: stub.url, bundle: 'b' } }, { holdLatch });
    for (const t of Object.values(ct.tools)) {
      const ex = t.execute as WrappedExecute;
      expect(ex[POLICY_WRAPPED]).toBe(true);
      expect(ex[HOLD_LATCH]).toBe(holdLatch);
    }
  });

  it('a server crash mid-call is a failed tool call; another connector keeps working', async () => {
    const crashy = await startMcpHttpServerStub();
    cleanups.push(() => crashy.close());
    const healthy = await testServer([
      { name: 'ping', handler: () => ({ content: [{ type: 'text', text: 'pong' }] }) },
    ]);
    const ct = await connect({
      [NS]: { url: crashy.url, bundle: 'a' },
      [NS2]: { url: healthy.url, bundle: 'b' },
    });
    await expect(exec(ct, `mcp__${NS}__crash`, {})).rejects.toThrow();
    await expect(exec(ct, `mcp__${NS2}__ping`, {})).resolves.toBe('pong');
  });

  it('an isError result throws with the server text (parity: tool-error, turn continues)', async () => {
    const s = await testServer([
      { name: 'boom', handler: () => ({ content: [{ type: 'text', text: 'quota exceeded' }], isError: true }) },
    ]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    await expect(exec(ct, `mcp__${NS}__boom`, {})).rejects.toThrow('quota exceeded');
  });

  it('a denied connector tool is not offered; its siblings are', async () => {
    const stub = await startMcpHttpServerStub();
    cleanups.push(() => stub.close());
    const ct = await connect({ [NS]: { url: stub.url, bundle: 'b' } }, { disallowed: [`mcp.${NS}.crash`, 'Bash'] });
    expect(Object.keys(ct.tools)).toEqual([`mcp__${NS}__echo`]);
    expect(ct.logs.join('\n')).toMatch(/crash.*denied/);
  });

  it('an unreachable or wedged server loses only its own tools, within the bound, in parallel', async () => {
    const hang1 = await startHangingServer();
    const hang2 = await startHangingServer();
    cleanups.push(() => hang1.close(), () => hang2.close());
    const ok = await testServer([{ name: 'ping', handler: () => ({ content: [{ type: 'text', text: 'pong' }] }) }]);
    const started = Date.now();
    const ct = await connect(
      {
        c0000000001: { url: hang1.url, bundle: 'h1' },
        c0000000002: { url: hang2.url, bundle: 'h2' },
        c0000000003: { url: 'http://127.0.0.1:1/mcp', bundle: 'dead' },
        [NS]: { url: ok.url, bundle: 'ok' },
      },
      { connectTimeoutMs: 300 },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(Object.keys(ct.tools)).toEqual([`mcp__${NS}__ping`]);
    expect(ct.loadedBundles).toEqual(new Set(['ok']));
    expect(ct.logs.filter((l) => /^c000000000[123]: /.test(l))).toHaveLength(3);
  });

  it('drops a connector that answers 401 (e.g. an expired token) without failing', async () => {
    const s = await testServer([{ name: 'ping' }], { status: 401 });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } }, { connectTimeoutMs: 2_000 });
    expect(ct.tools).toEqual({});
    expect(ct.loadedBundles.size).toBe(0);
    expect(ct.logs.join('\n')).toMatch(new RegExp(`^${NS}: `, 'm'));
  });

  it('drops the whole connector when a listed tool has a non-object inputSchema (SDK list validation)', async () => {
    const s = await testServer([
      { name: 'good' },
      { name: 'bad', inputSchema: { type: 'string' } },
    ]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    expect(ct.tools).toEqual({});
    expect(ct.loadedBundles.size).toBe(0);
  });

  it('skips over-long / illegal names and duplicates with a log line, never renaming', async () => {
    const s = await testServer([
      { name: 'x'.repeat(60) },          // mcp__c0123456789__ + 60 = 78 chars > 64
      { name: 'has.dot' },
      { name: 'fine' },
      { name: 'fine' },
    ]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    expect(Object.keys(ct.tools)).toEqual([`mcp__${NS}__fine`]);
    const log = ct.logs.join('\n');
    expect(log).toMatch(/not a valid model tool name/);
    expect(log).toMatch(/has\.dot/);
    expect(log).toMatch(/duplicate/);
    expect(ct.loadedBundles).toEqual(new Set(['b']));
  });

  it(`follows nextCursor and caps at ${MAX_TOOLS_PER_CONNECTOR} tools per connector`, async () => {
    const tools = Array.from({ length: 300 }, (_, i) => ({ name: `t${i}` }));
    const s = await testServer(tools, { pageSize: 25 });
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    expect(Object.keys(ct.tools)).toHaveLength(MAX_TOOLS_PER_CONNECTOR);
    expect(ct.tools[`mcp__${NS}__t255`]).toBeDefined();
    expect(ct.tools[`mcp__${NS}__t256`]).toBeUndefined();
    expect(ct.logs.join('\n')).toMatch(/256/);
  });

  it('aborts an in-flight call on Stop instead of waiting out the call timeout', async () => {
    const s = await testServer([{ name: 'slow', handler: () => new Promise(() => {}) }]);
    const ct = await connect({ [NS]: { url: s.url, bundle: 'b' } });
    const stop = new AbortController();
    const started = Date.now();
    const p = exec(ct, `mcp__${NS}__slow`, {}, stop.signal);
    setTimeout(() => stop.abort(), 50);
    await expect(p).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('sends the ax-cred placeholder through the injected fetch — the runner never holds a real secret', async () => {
    const s = await testServer([{ name: 'ping', handler: () => ({ content: [{ type: 'text', text: 'pong' }] }) }]);
    const seenByFetch: string[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      seenByFetch.push(new Headers(init?.headers).get('authorization') ?? '<none>');
      return fetch(input, init);
    };
    const ct = await connect(
      { [NS]: { url: s.url, headers: { Authorization: `Bearer ${PH}` }, bundle: 'b' } },
      { fetch: recordingFetch },
    );
    await expect(exec(ct, `mcp__${NS}__ping`, {})).resolves.toBe('pong');
    // Every request — initialize, list, call — went through OUR fetch (the
    // proxy dispatcher in production) and carried only the placeholder.
    expect(seenByFetch.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seenByFetch)).toEqual(new Set([`Bearer ${PH}`]));
    expect(s.seenHeaders.every((h) => h.authorization === `Bearer ${PH}`)).toBe(true);
  });

  it('close() resolves and is safe to call twice', async () => {
    const stub = await startMcpHttpServerStub();
    cleanups.push(() => stub.close());
    const ct = await connect({ [NS]: { url: stub.url, bundle: 'b' } });
    await ct.close();
    await ct.close();
  });

  it('no servers → no tools, no logs', async () => {
    const ct = await connect({});
    expect(ct.tools).toEqual({});
    expect(ct.logs).toEqual([]);
  });
});
```

- [ ] **Step 2: Build the test harness and run the tests to verify they fail**

```bash
pnpm --filter @ax/test-harness build
pnpm --filter @ax/agent-aisdk-runner exec vitest run src/__tests__/connector-tools.test.ts
```

Expected: FAIL, "Failed to load url ../tools/connector-tools.js".

- [ ] **Step 3: Implement `connector-tools.ts`**

Create `packages/agent-aisdk-runner/src/tools/connector-tools.ts`:

```ts
// ---------------------------------------------------------------------------
// Connector tools (TASK-826): the aisdk runner's MCP client for the agent's
// attached connectors — remote streamable-HTTP MCP servers only.
//
// The claude-sdk runner hands the projected servers to `query({ mcpServers })`
// and the SDK subprocess speaks MCP. This runner has no subprocess, so it
// connects its own `@modelcontextprotocol/sdk` Client per connector, at session
// start, and exposes each tool as an ordinary `ai@7` tool. Parity points:
//
//   - Model-facing name `mcp__<ns>__<tool>` — the same string the SDK puts on
//     the wire, so transcripts, live chunks and channel-web's connector labels
//     (TASK-744) are identical across runners.
//   - Policy name `mcp.<ns>.<tool>` — what `classifySdkToolName` lifts the
//     SDK name to, and what `tool.pre-call` / @ax/tool-policy key on. So the
//     record KEY and the policy NAME differ here, and only here.
//   - Every execute goes through `wrapWithPolicy` (I₁). Denied tools
//     (`agentConfig.disallowedTools`) are not offered at all — catalog
//     hygiene; enforcement stays at tool.pre-call (TASK-736 F4).
//   - Network: every request goes through `opts.fetch`, the runner's
//     credential-proxy dispatcher (`createProxyFetch`). Header values are
//     `ax-cred:` placeholders the proxy swaps on allowlisted hosts; this
//     process never holds a real secret.
//
// Failure isolation: a connector that fails to connect or list (dead,
// wedged, 401, malformed list) loses only its own tools, with one stderr
// line. It never fails the session boot. A tool name the provider would
// reject is SKIPPED with a log line, never mangled — a renamed tool would
// silently miss its policy key and its UI label.
// ---------------------------------------------------------------------------

import { jsonSchema, tool, type JSONSchema7, type Tool } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { HoldLatch, ProjectedMcpServer, ToolPolicy } from '@ax/agent-runner-core';
import { renderMcpResult } from './mcp-result.js';
import { wrapWithPolicy } from './policy-wrap.js';

export const CONNECT_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 300_000;
export const MAX_TOOLS_PER_CONNECTOR = 256;
const MAX_LIST_PAGES = 16;
const CLOSE_TIMEOUT_MS = 5_000;
/**
 * The strictest tool-name rule across the providers this runner drives:
 * Anthropic `^[a-zA-Z0-9_-]{1,64}$`; OpenAI-compatible endpoints use the same.
 */
export const MODEL_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ConnectConnectorToolsOptions {
  /** From `loadProjectedMcpServers`, keyed by host-minted toolNamespace. */
  servers: Record<string, ProjectedMcpServer>;
  /** `createProxyFetch(providerEnv)`; undefined only when no proxy is configured (tests). */
  fetch: typeof fetch | undefined;
  policy: ToolPolicy;
  holdLatch: HoldLatch;
  onHold: (toolCallId: string) => void;
  onToolFailure: (toolCallId: string) => void;
  /** `agentConfig.disallowedTools` — canonical names (`mcp.<ns>.<tool>` among them). */
  disallowed: readonly string[];
  log?: (line: string) => void;
  connectTimeoutMs?: number;
}

export interface ConnectorTools {
  tools: Record<string, Tool>;
  /** Bundle dirs whose server connected + listed (even if every tool was then skipped). */
  loadedBundles: Set<string>;
  close(): Promise<void>;
}

interface ListedTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reject with the signal's reason the moment it aborts, whatever `p` does. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function connectAndList(
  server: ProjectedMcpServer,
  fetchImpl: typeof fetch | undefined,
  timeoutMs: number,
): Promise<{ client: Client; tools: ListedTool[]; truncated: boolean }> {
  const client = new Client({ name: 'ax-aisdk-runner', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
    ...(server.headers !== undefined ? { requestInit: { headers: server.headers } } : {}),
  });
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error(`no answer within ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    const work = (async () => {
      const reqOpts = { signal: ac.signal, timeout: timeoutMs };
      await client.connect(transport, reqOpts);
      const tools: ListedTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = await client.listTools(cursor === undefined ? undefined : { cursor }, reqOpts);
        tools.push(...(res.tools as ListedTool[]));
        cursor = res.nextCursor;
        if (cursor === undefined || tools.length > MAX_TOOLS_PER_CONNECTOR) break;
      }
      return tools;
    })();
    const tools = await raceAbort(work, ac.signal);
    const truncated = tools.length > MAX_TOOLS_PER_CONNECTOR;
    return { client, tools: tools.slice(0, MAX_TOOLS_PER_CONNECTOR), truncated };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function connectConnectorTools(
  opts: ConnectConnectorToolsOptions,
): Promise<ConnectorTools> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`runner: connector-mcp: ${line}\n`));
  const timeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const denied = new Set(opts.disallowed);
  const tools: Record<string, Tool> = {};
  const loadedBundles = new Set<string>();
  const clients: Client[] = [];

  const results = await Promise.allSettled(
    Object.entries(opts.servers).map(async ([ns, server]) => ({
      ns,
      server,
      ...(await connectAndList(server, opts.fetch, timeoutMs)),
    })),
  );

  const entries = Object.keys(opts.servers);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      log(`${entries[i]}: could not load this connector's tools: ${errText(r.reason)}`);
      return;
    }
    const { ns, server, client, tools: listed, truncated } = r.value;
    clients.push(client);
    loadedBundles.add(server.bundle);
    if (truncated) {
      log(`${ns}: lists more than ${MAX_TOOLS_PER_CONNECTOR} tools; only the first ${MAX_TOOLS_PER_CONNECTOR} are offered`);
    }
    const seen = new Set<string>();
    for (const t of listed) {
      const modelName = `mcp__${ns}__${t.name}`;
      const policyName = `mcp.${ns}.${t.name}`;
      if (!MODEL_TOOL_NAME_RE.test(modelName)) {
        log(`${ns}: tool '${t.name}' skipped — '${modelName}' is not a valid model tool name (^[a-zA-Z0-9_-]{1,64}$)`);
        continue;
      }
      if (seen.has(t.name)) {
        log(`${ns}: tool '${t.name}' skipped — duplicate name in this connector's list`);
        continue;
      }
      seen.add(t.name);
      if (denied.has(policyName)) {
        log(`${ns}: tool '${t.name}' not offered — denied for this agent`);
        continue;
      }
      const toolName = t.name;
      tools[modelName] = tool({
        description: t.description ?? '',
        inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
        execute: wrapWithPolicy(
          {
            policy: opts.policy,
            name: policyName,
            isBuiltin: false,
            holdLatch: opts.holdLatch,
            onHold: opts.onHold,
            onToolFailure: opts.onToolFailure,
          },
          async (input, ctx) => {
            const res = await client.callTool({ name: toolName, arguments: input }, undefined, {
              ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}),
              timeout: CALL_TIMEOUT_MS,
              resetTimeoutOnProgress: true,
            });
            const text = renderMcpResult(res as { content?: unknown; structuredContent?: unknown });
            // Parity with host-tools / the claude-sdk runner: a tool that
            // reported its own failure is a FAILED tool call (is_error on the
            // persisted result), not a success whose text complains. ai@7 turns
            // the throw into a tool-error and the turn continues.
            if ((res as { isError?: unknown }).isError === true) throw new Error(text);
            return text;
          },
        ),
      });
    }
  });

  let closed = false;
  return {
    tools,
    loadedBundles,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(clients.map((c) => c.close())),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
```

Note on the test's log regexes: failures log as `<ns>: could not load…`. The test's `log` option receives lines **without** the `runner: connector-mcp: ` prefix; only the default stderr writer adds it.

- [ ] **Step 4: Update `policy-wrap.ts` comments that are no longer true**

In `packages/agent-aisdk-runner/src/tools/policy-wrap.ts`:
- Replace the `name` doc comment in `WrapWithPolicyOptions` with:
  ```ts
  /**
   * The ax-native tool name host subscribers registered — `Bash`, `Read`, a
   * catalog tool's `name`, `Skill`, or a connector tool's canonical
   * `mcp.<toolNamespace>.<tool>`. Connector tools are the one place the
   * record key (`mcp__<ns>__<tool>`, what the model sees) and this name
   * differ — pass the canonical form here, never the model-facing one.
   */
  ```
- In `mergeToolSets`'s thrown message, change `(no mcp__ prefixes)` to `(only connector tools carry an mcp__ prefix)`.

- [ ] **Step 5: Run the tests and type-check**

```bash
pnpm --filter @ax/agent-aisdk-runner exec vitest run src/__tests__/connector-tools.test.ts src/__tests__/policy-wrap.test.ts
pnpm --filter @ax/agent-aisdk-runner build
```

Expected: all PASS; tsc clean. If the "follows nextCursor" test fails on the log regex, check the truncation log: it must contain `256`. If `client.connect`'s options type rejects `{ signal, timeout }`, check `Client.connect(transport, options?: RequestOptions)` in `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts`; the `raceAbort` bound still holds either way.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-aisdk-runner/src/tools/connector-tools.ts packages/agent-aisdk-runner/src/tools/policy-wrap.ts packages/agent-aisdk-runner/src/__tests__/connector-tools.test.ts
git commit -m "[TASK-826] aisdk: connector tools over streamable-HTTP MCP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S2P8ACKYLoikhyBo5ZXrko"
```

---

### Task 4: Accurate Skill note for connector bundles

**Files:**
- Modify: `packages/agent-aisdk-runner/src/tools/skill-tool.ts`
- Modify: `packages/agent-aisdk-runner/src/skills-index.ts:174-186` (log line + `hasMcpServers` doc)
- Test: `packages/agent-aisdk-runner/src/__tests__/skill-tool.test.ts`

**Interfaces:**
- Consumes: `ConnectorTools.loadedBundles: Set<string>` (Task 3). It is matched against `DiscoveredSkill.id`, which is the bundle dir name, the same value the loader records as `bundle`.
- Produces: `export const MCP_NOT_LOADED_NOTE: string`, and `BuildSkillToolOptions.loadedMcpBundles: ReadonlySet<string>` (required).

- [ ] **Step 1: Read the current skill-tool test's MCP case**

Run: `grep -n "MCP_UNAVAILABLE_NOTE\|hasMcpServers\|buildSkillTool(" packages/agent-aisdk-runner/src/__tests__/skill-tool.test.ts`

Note every call site of `buildSkillTool(` and the test(s) asserting `MCP_UNAVAILABLE_NOTE`.

- [ ] **Step 2: Update the tests (failing)**

In `skill-tool.test.ts`:
- Change the import of `MCP_UNAVAILABLE_NOTE` to `MCP_NOT_LOADED_NOTE`.
- Add `loadedMcpBundles: new Set()` to every existing `buildSkillTool({...})` call.
- Replace the test(s) asserting `MCP_UNAVAILABLE_NOTE` with these two. Use the file's existing skill-fixture helper and the way it invokes `execute`, matching what Step 1 showed; the shape below assumes a `skill(overrides)` factory and an `run(tools, name)` helper, so rename to the real ones:

```ts
it('notes plainly when a skill’s connector tools did not load this session', async () => {
  const tools = buildSkillTool({
    ...baseOpts(),
    skills: [skill({ id: 'conn-a', name: 'conn-a', hasMcpServers: true })],
    loadedMcpBundles: new Set(),
  });
  const out = await run(tools, 'conn-a');
  expect(out).toContain(MCP_NOT_LOADED_NOTE);
});

it('adds no note when the skill’s connector tools loaded', async () => {
  const tools = buildSkillTool({
    ...baseOpts(),
    skills: [skill({ id: 'conn-a', name: 'conn-a', hasMcpServers: true })],
    loadedMcpBundles: new Set(['conn-a']),
  });
  const out = await run(tools, 'conn-a');
  expect(out).not.toContain(MCP_NOT_LOADED_NOTE);
  expect(out).not.toMatch(/not available on this runner/i);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @ax/agent-aisdk-runner exec vitest run src/__tests__/skill-tool.test.ts`

Expected: FAIL (no export `MCP_NOT_LOADED_NOTE`).

- [ ] **Step 4: Implement**

In `skill-tool.ts`, replace the `MCP_UNAVAILABLE_NOTE` block with:

```ts
/**
 * Appended to the response of a skill whose bundle ships MCP servers that did
 * NOT load this session (connect/list failed, or the entry was refused) —
 * TASK-826. Skills whose servers loaded get no note: their tools are simply in
 * the tool list. Exported so tests assert by identity, not by substring.
 */
export const MCP_NOT_LOADED_NOTE =
  "Note: this skill's connector tools could not be loaded this session (the " +
  'connection failed or was refused). Do not call tools it names that are not in ' +
  'your tool list. Follow the rest of the skill with the tools you have, and say ' +
  'plainly which steps you could not do rather than pretending a missing tool ran.';
```

Add to `BuildSkillToolOptions`:

```ts
  /**
   * Bundle ids whose connector MCP servers connected this session
   * (`ConnectorTools.loadedBundles`). A skill with `hasMcpServers` whose id is
   * absent gets `MCP_NOT_LOADED_NOTE`.
   */
  loadedMcpBundles: ReadonlySet<string>;
```

and change the note line to:

```ts
      if (found.hasMcpServers && !opts.loadedMcpBundles.has(found.id)) {
        parts.push('', MCP_NOT_LOADED_NOTE);
      }
```

In `skills-index.ts`:
- delete the `if (hasMcpServers) { log(...) }` block (lines ~178-186), because its claim "this runner has no MCP client" is now false. Connector load failures are logged by `connector-tools.ts`.
- update the `hasMcpServers` field's doc comment to: "True when the bundle ships MCP servers (a `.mcp.json`, or `mcpServers` in its manifest). The Skill tool warns only when those servers did not load this session (TASK-826)."
- update line ~65's reference accordingly.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @ax/agent-aisdk-runner exec vitest run src/__tests__/skill-tool.test.ts src/__tests__/skills-index.test.ts src/__tests__/policy-wrap.test.ts
```

Expected: PASS. If `skills-index.test.ts` asserted the removed log line, update it to assert that no "no MCP client" line is logged. `main.ts` won't type-check yet (missing `loadedMcpBundles`); Task 5 fixes that, so don't run `build` here.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-aisdk-runner/src/tools/skill-tool.ts packages/agent-aisdk-runner/src/skills-index.ts packages/agent-aisdk-runner/src/__tests__/skill-tool.test.ts packages/agent-aisdk-runner/src/__tests__/skills-index.test.ts
git commit -m "[TASK-826] aisdk Skill tool: warn only when a skill's connector tools did not load

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S2P8ACKYLoikhyBo5ZXrko"
```

---

### Task 5: Wire connectors into the session + acceptance (parity e2e)

**Files:**
- Modify: `packages/agent-aisdk-runner/src/main.ts` (imports, `run(ctx)` body ~L176-460, `resolveModel` call ~L330)
- Test: `packages/agent-aisdk-runner/src/__tests__/parity.e2e.test.ts` (replace the test at ~L848-871; extend `installSkill`)

**Interfaces:**
- Consumes: `loadProjectedMcpServers` (Task 1), `connectConnectorTools` / `ConnectorTools` (Task 3), `buildSkillTool({ …, loadedMcpBundles })` (Task 4), `createProxyFetch` (existing, `./provider.js`).

- [ ] **Step 1: Write the failing acceptance tests**

In `parity.e2e.test.ts`:

1. Add the import at the top: `import { startMcpTestServer, type McpTestServer } from './helpers/mcp-test-server.js';`
2. Extend `installSkill`'s `opts` to `{ mcp?: boolean; mcpJson?: unknown }`. When `opts.mcpJson !== undefined`, write `JSON.stringify(opts.mcpJson)` to `.mcp.json` instead of the stdio tombstone.
3. Replace the whole test `'loads a skill declaring mcpServers but tells the model its servers are unavailable'` (and its two-line comment above) with:

```ts
  // TASK-826 — connectors on this runner. The real main(): projection →
  // MCP client → tool set → tool.pre-call → the connector → tool result.
  describe('connectors (TASK-826)', () => {
    const NS = 'c0123456789';
    let mcp: McpTestServer;
    beforeEach(async () => {
      mcp = await startMcpTestServer({
        tools: [{ name: 'ping', handler: () => ({ content: [{ type: 'text', text: 'pong-from-connector' }] }) }],
      });
    });
    afterEach(async () => {
      await mcp.close();
    });

    it('offers mcp__<ns>__<tool>, gates it as mcp.<ns>.<tool>, and returns the connector result', async () => {
      await installSkill(
        'connector-probe',
        'name: connector-probe\ndescription: A connector bundle.',
        'Use the ping tool.',
        { mcpJson: { mcpServers: { [NS]: { type: 'http', url: mcp.url } } } },
      );
      scriptedModel.mockReturnValue(
        modelReplaying([toolStep(`mcp__${NS}__ping`, {}), textStep('done')]),
      );
      inboxEntries = [userMessage('ping it')];

      await expect(main()).resolves.toBe(0);

      // Offered to the model under the SDK-parity name.
      const offered = (sentTools[0] as Array<{ name: string }>).map((t) => t.name);
      expect(offered).toContain(`mcp__${NS}__ping`);
      // Gated under the canonical policy name.
      const preCall = calls.find(
        (c) => c.action === 'tool.pre-call' &&
          (c.payload as { call: { name: string } }).call.name === `mcp.${NS}.ping`,
      );
      expect(preCall).toBeDefined();
      // The connector actually answered, and the model saw it.
      const toolResult = JSON.stringify(shippedEntries().find((e) => e.role === 'tool'));
      expect(toolResult).toContain('pong-from-connector');
      // The live chunk and the persisted block carry the model-facing name —
      // the string channel-web's connectorToolLabel keys on.
      expect(JSON.stringify(chunks())).toContain(`mcp__${NS}__ping`);
      expect(JSON.stringify(turnEnds())).toContain(`mcp__${NS}__ping`);
    });

    it('a dead connector costs only its tools: the session still boots and answers', async () => {
      await installSkill(
        'connector-dead',
        'name: connector-dead\ndescription: A connector bundle whose server is down.',
        'Use the ping tool.',
        { mcpJson: { mcpServers: { [NS]: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } } },
      );
      scriptedModel.mockReturnValue(
        modelReplaying([toolStep('Skill', { name: 'connector-dead' }), textStep('could not ping')]),
      );
      inboxEntries = [userMessage('ping it')];

      await expect(main()).resolves.toBe(0);

      const toolResult = JSON.stringify(shippedEntries().find((e) => e.role === 'tool'));
      expect(toolResult).toContain('Use the ping tool.');
      expect(toolResult).toMatch(/could not be loaded this session/);
    });
  });
```

4. Capture the tools the model is offered, since `MockLanguageModelV4`'s `doStream` receives `tools` alongside `prompt`:
   - add `let sentTools: unknown[];` next to `let sentPrompts: unknown[];`;
   - in `modelReplaying` (and the compaction variant below it, if it has its own `doStream`), change `doStream: async ({ prompt }) =>` to `doStream: async ({ prompt, tools }) =>` and add `sentTools.push(tools);` beside `sentPrompts.push(prompt);`;
   - add `sentTools = [];` wherever `beforeEach` resets `sentPrompts = [];`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ax/agent-aisdk-runner exec vitest run src/__tests__/parity.e2e.test.ts -t "TASK-826"`

Expected: FAIL. The first test fails because `mcp__c0123456789__ping` is not offered (the model's tool call is an unknown tool, so there's no pre-call for `mcp.c0123456789.ping`). The second fails because there's no note (and today's `buildSkillTool` is missing `loadedMcpBundles`).

- [ ] **Step 3: Wire it in `main.ts`**

1. Imports:
   - add `loadProjectedMcpServers` to the existing `@ax/agent-runner-core` import list;
   - add `createProxyFetch` to the existing `./provider.js` import list;
   - add `import { connectConnectorTools } from './tools/connector-tools.js';`.
2. Inside `run(ctx)`, after `const skills = await discoverInstalledSkills();`, insert:

```ts
      // Connectors (TASK-826). The same host-written projection the Skill
      // index walks, read through the loader the claude-sdk runner uses
      // (@ax/agent-runner-core). Connected eagerly, in parallel, each bounded:
      // a dead or wedged connector costs its own tools and one stderr line,
      // never the session. ONE proxy fetch serves the model and every
      // connector — the credential proxy is the only way out of the sandbox,
      // and it is what swaps the ax-cred placeholders on allowlisted hosts.
      const proxyFetch = createProxyFetch(proxyStartup.providerEnv);
      const projectedMcp = await loadProjectedMcpServers(
        proxyStartup.providerEnv['CLAUDE_CONFIG_DIR'] ?? process.env['CLAUDE_CONFIG_DIR'],
      );
      const connectors = await connectConnectorTools({
        servers: projectedMcp.servers,
        fetch: proxyFetch,
        policy,
        holdLatch,
        onHold,
        onToolFailure,
        disallowed: agentConfig.disallowedTools ?? [],
      });
```

   Check the type of `agentConfig.disallowedTools` first (`grep -n "disallowedTools" packages/ipc-protocol/src/*.ts`). If it is non-optional `string[]`, drop the `?? []`.

3. Wrap everything from this point to the end of `run`'s body in `try { … } finally { await connectors.close(); }`, so that every exit closes the clients: `return 0` on `next === null`, any thrown model error, or a throw in `mergeToolSets` or `assertAllToolsWrapped`. Indent the moved body by two spaces. Don't restructure anything inside it.
4. In the `buildSkillTool({ … })` call, add `loadedMcpBundles: connectors.loadedBundles`.
5. Add a fifth group to `mergeToolSets([...])`, after the Skill group:

```ts
        {
          label: 'connector tools',
          tools: connectors.tools,
        },
```

6. Change the `resolveModel({ … })` call to pass the shared dispatcher:

```ts
      const model = resolveModel({
        modelRef: agentConfig.model,
        providerEnv: proxyStartup.providerEnv,
        fetchImpl: proxyFetch,
      });
```

   `ResolveModelOptions.fetchImpl` is `typeof fetch | undefined`, and `resolveModel` already falls back to `createProxyFetch` when it's undefined, so passing `undefined` (no proxy) preserves today's behaviour.
7. Update the comment above `assertAllToolsWrapped`. Connector tools are covered too: they're the fifth group and are built through `wrapWithPolicy` in `connector-tools.ts`.

- [ ] **Step 4: Run the acceptance tests, the whole package, and tsc**

```bash
pnpm --filter @ax/agent-aisdk-runner build
pnpm --filter @ax/agent-aisdk-runner test
```

Expected: all PASS, including both TASK-826 cases and every pre-existing parity, compaction and interrupt e2e (unchanged behaviour with no connectors). The `assertAllToolsWrapped` call in `main.ts` now runs over a set containing `mcp__c0123456789__ping`, so the first acceptance test is also the "main.ts-level `assertAllToolsWrapped` holds with connector tools merged in" check. If it threw, `main()` would exit non-zero and the test would fail.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-aisdk-runner/src/main.ts packages/agent-aisdk-runner/src/__tests__/parity.e2e.test.ts
git commit -m "[TASK-826] aisdk: load and call attached connectors in the session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S2P8ACKYLoikhyBo5ZXrko"
```

---

### Task 6: channel-web — aisdk agents can add connectors

**Files:**
- Modify: `packages/channel-web/src/server/routes-workspace.ts:~1446-1456`
- Modify (comments only): `packages/channel-web/src/lib/workspace-types.ts:~1134`, `packages/channel-web/src/lib/agent-connectors.ts:~59`
- Test: `packages/channel-web/src/__tests__/server/routes-workspace-connectors.test.ts:~1128-1139`

- [ ] **Step 1: Flip the test (failing)**

In the test "says whether the agent's runner can use connectors at all (TASK-761)", change:

```ts
      agentRow.runner = 'aisdk';
      expect((await list()).body).toMatchObject({ connectorsSupported: false });
```

to:

```ts
      // TASK-826 — the aisdk runner loads connectors too.
      agentRow.runner = 'aisdk';
      expect((await list()).body).toMatchObject({ connectorsSupported: true });
```

Leave the `'something-new'` → `false` assertion as it is.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-workspace-connectors.test.ts -t "TASK-761"`

Expected: FAIL (`connectorsSupported: false`).

- [ ] **Step 3: Implement**

Replace `runnerLoadsConnectors` and its doc comment with:

```ts
/**
 * TASK-761 — does this agent's runner give the model connector tools at all?
 * An allow-list on purpose: a runner nobody has wired for connectors yet says
 * "can't use connectors" rather than offering setup that silently does
 * nothing. Both shipped runners load the connectors' `.mcp.json` — claude-sdk
 * hands them to the SDK, aisdk connects its own MCP clients (TASK-826). An
 * agent row with no runner predates the field and runs on claude-sdk.
 */
function runnerLoadsConnectors(runner: string | undefined): boolean {
  return runner === undefined || runner === 'claude-sdk' || runner === 'aisdk';
}
```

Then read the doc comments at `lib/workspace-types.ts` ~1134 and `lib/agent-connectors.ts` ~59. If they say the aisdk runner can't use connectors, reword them to "a runner that doesn't load connectors (an allow-list in `runnerLoadsConnectors`)". Comments only, no behaviour change.

- [ ] **Step 4: Run channel-web tests + tsc (channel-web type-checks its test files)**

```bash
pnpm --filter @ax/channel-web exec vitest run src/__tests__/server/routes-workspace-connectors.test.ts src/components/workspace/__tests__/AgentConnectors.test.tsx src/components/workspace/__tests__/ConnectorDetails.test.tsx src/components/workspace/__tests__/SkippedConnectorsNotice.test.tsx
pnpm --filter @ax/channel-web build
```

Expected: PASS. The UI tests for the unsupported state are mock-driven and stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src
git commit -m "[TASK-826] channel-web: aisdk agents can add connectors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S2P8ACKYLoikhyBo5ZXrko"
```

---

### Task 7: Full gate, memory shard, PR, board

**Files:**
- Create: `.claude/memory/decisions/2026-10-04-TASK-826.md` (via the helper)

- [ ] **Step 1: Full gate**

```bash
export DOCKER_HOST=unix:///var/run/docker.sock
pnpm build && pnpm lint && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
```

Expected: all green. If a Docker-backed package (e.g. `@ax/auth-better`) fails with zero assertion failures and only a container-start or teardown timeout, that's the machine. Re-run that package alone (`pnpm --filter @ax/auth-better test`) and record both outputs. Any assertion failure is real: fix it before continuing.

- [ ] **Step 2: Write the decision shard**

```bash
shard=$(scripts/memory-write-target.sh --shard decisions TASK-826)
mkdir -p "$(dirname "$shard")"
echo "$shard"
```

Write to `$shard` (append-only; one file for this task):

```markdown
# TASK-826 — aisdk runner connector (HTTP MCP) support (2026-10-04)

- Connector `.mcp.json` loader moved claude-sdk → `@ax/agent-runner-core` (`loadProjectedMcpServers`, `CONNECTOR_TOOL_NAMESPACE_RE`); output is runner-neutral `{url, headers?, bundle}`; claude-sdk keeps a thin `McpServerConfig` adapter under the old name.
- aisdk connects one `@modelcontextprotocol/sdk@1.30.0` Client per connector at session start (eager, parallel, 10s bound each), through `createProxyFetch` — the same dispatcher as the model. Closed in a `finally` around the turn loop.
- Names: record key `mcp__<ns>__<tool>` (labels/transcript parity), `wrapWithPolicy` name `mcp.<ns>.<tool>` (policy parity). Over-long/illegal names are SKIPPED, never mangled.
- TASK-736 F4 is now live and fixed: denied `mcp.<ns>.<tool>` are not offered on aisdk.
- `isError` MCP results throw (failed tool call), matching host-tools.
- Gotcha: the MCP SDK's `listTools` zod-validates every tool (`inputSchema.type` literal `'object'`) — one malformed tool fails the WHOLE list, so the connector is dropped, not just that tool.
- TASK-761's `runnerLoadsConnectors` allow-list now includes `'aisdk'`.
- Skill tool: `MCP_UNAVAILABLE_NOTE` → `MCP_NOT_LOADED_NOTE`, shown only for a bundle whose servers didn't connect.
```

```bash
git add "$shard"
git commit -m "[TASK-826] memory: decisions shard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01S2P8ACKYLoikhyBo5ZXrko"
scripts/memory-append-check.sh
```

Expected: the append check passes (shard only; no root archive touched).

- [ ] **Step 3: Whole-branch review before the PR**

Dispatch the `ax-code-reviewer` agent on `git diff origin/main...HEAD`. Fix every Critical/Important finding in a separate commit per finding, then re-run the affected package's tests and `build`.

- [ ] **Step 4: Push and open the PR**

```bash
git fetch origin main && git rebase origin/main
git push -u origin task-826-aisdk-connectors
```

If the push fails with `Permission denied (publickey)`, retry via `bash -c 'git push -u origin task-826-aisdk-connectors'`.

Then run `gh pr create --base main --title "[TASK-826] aisdk runner: connector (HTTP MCP) support"`, with a body (`--body-file`) containing:
- **Summary:** 3–5 bullets.
- **Boundary review:** "No hook-surface change. `tool.pre-call` payloads, IPC actions, and `AgentConfig` are unchanged; the connector names `mcp.<ns>.<tool>` / `mcp__<ns>__<tool>` already flow from the claude-sdk runner. The loader moved within `@ax/agent-runner-core`, a shared library, not a plugin."
- **Security review:** the three lines below, in the security-checklist format.

  ```
  ## Security review
  - Sandbox: New egress runner → connector URLs from the host-written 0555 projection, only via createProxyFetch's undici ProxyAgent (credential proxy allowlist + ax-cred placeholder substitution); header values validated as placeholders; FS reads limited to $CLAUDE_CONFIG_DIR/skills/*/.mcp.json (lstat, no symlinks, 256 KB cap); no process spawn, no caller-named env reads.
  - Injection: Untrusted = connector tool names/descriptions/schemas/results. Names regex-gated (^[a-zA-Z0-9_-]{1,64}$) and never used as a path/command/URL; descriptions+schemas go only into the provider tool list (same exposure as claude-sdk); results become a 100 KB-capped string tool result, never a system instruction; every call gated by tool.pre-call; denied tools not offered.
  - Supply chain: @modelcontextprotocol/sdk pinned exact 1.30.0 as a direct dep of @ax/agent-aisdk-runner — already resolved in pnpm-lock via @ax/mcp-client/@ax/mcp-oauth/@ax/test-harness; lockfile diff adds importer entries only, no new packages; no install scripts added.
  ```
- **Test plan:** the gate command and its result, plus the new test files.
- The trailer line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`, a blank line, then `https://claude.ai/code/session_01S2P8ACKYLoikhyBo5ZXrko`.

- [ ] **Step 5: Move the card to In Review**

```bash
gh project item-edit --id PVTI_lADOD4dXMc4BYpfZzg-cX1I --project-id PVT_kwDOD4dXMc4BYpfZ \
  --field-id PVTSSF_lADOD4dXMc4BYpfZzhTtzE0 --single-select-option-id d00030a4
```

Expected: exit 0. Then confirm with `gh project item-list 1 --owner project-ax --format json --limit 1000 --jq '.items[] | select(.title|startswith("[TASK-826]")) | .status'`, which should print `In Review`.
