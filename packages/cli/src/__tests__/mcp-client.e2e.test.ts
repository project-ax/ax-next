import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type LlmRequest,
  type LlmResponse,
  type Plugin,
  type ToolCall,
} from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsPlugin } from '@ax/credentials';
import { saveConfig, type McpServerConfig } from '@ax/mcp-client';
import { mcpServerStubPath } from '@ax/test-harness';

import { main } from '../main.js';

// ---------------------------------------------------------------------------
// Week 6.5e acceptance test — @ax/mcp-client end-to-end.
//
// Exercises the full MCP slice against a real stdio subprocess (the
// `@ax/test-harness` stub spawned via `node <path>`):
//
//   host (this test process)
//     ├── @ax/mcp-client plugin on init
//     │     ├── loadConfigs() from @ax/storage-sqlite
//     │     └── StdioClientTransport → node <mcpServerStubPath> (real spawn)
//     ├── @ax/sandbox-subprocess spawns
//     │     └── @ax/agent-native-runner
//     │           └── HTTP POST /llm.call → @ax/llm-proxy-anthropic-format
//     │                 └── bus.call('llm:call') → stub LLM plugin (below)
//     └── runner sees `mcp.echo.echo` in the tool catalog, emits a tool_use,
//         which loops back as POST /tool.execute-host → `tool:execute:mcp.echo.echo`
//         → `McpConnection.callTool('echo', ...)` → subprocess stdout → MCP reply
//
// What we verify:
//   1. Round-trip: tool:pre-call + tool:post-call fire on the host with the
//      namespaced name (`mcp.echo.echo`), chat ends cleanly (rc === 0), and
//      the echoed payload literally round-trips the 'acceptance' substring.
//   2. Dead-server: invoking `mcp.echo.crash` kills the stub mid-call. A
//      follow-up call to `mcp.echo.echo` must return a
//      MCP_SERVER_UNAVAILABLE-wrapped tool-error result (shape matches what
//      the plugin returns at plugin.ts:202), and the chat still ends cleanly
//      (rc === 0) — a dead MCP server is a tool-level failure, not a chat
//      terminator.
//
// No CI skip: the stub runs on plain Node + the MCP SDK (pure JS), no
// platform-specific binaries. Contrast with `claude-sdk-runner.e2e.test.ts`,
// which gates on a native `claude` binary that only ships on darwin in CI.
// ---------------------------------------------------------------------------

const TEST_KEY_HEX = '42'.repeat(32);

/**
 * Seed one MCP config into storage via a scratch HookBus + bootstrap cycle
 * that runs ONLY storage + credentials. The main() under test later opens
 * its own bus and reads the config back through @ax/mcp-client's loadConfigs.
 *
 * Why a separate bootstrap: loadConfigs / saveConfig take a BusLike, so we
 * need the storage:set / storage:get hooks registered. Spinning the full
 * chat-path plugin set here (sandbox + orchestrator + ipc-server) would be
 * overkill and racy — those would all try to boot against the same sqlite
 * file the test's real main() then opens.
 */
async function seedMcpConfig(dbPath: string, config: McpServerConfig): Promise<void> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [
      createStorageSqlitePlugin({ databasePath: dbPath }),
      createCredentialsPlugin(),
    ],
    config: {},
  });
  const ctx = makeAgentContext({
    sessionId: 'seed',
    agentId: 'seed',
    userId: 'seed',
  });
  await saveConfig(bus, ctx, config);
}

interface PreCallEvent {
  name: string;
  input: unknown;
}
interface PostCallEvent {
  name: string;
  output: unknown;
}

describe('mcp-client e2e (subprocess stdio round-trip)', () => {
  let tmp: string;
  let originalCredKey: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ax-mcp-e2e-'));
    originalCredKey = process.env.AX_CREDENTIALS_KEY;
    // @ax/credentials requires a 32-byte key. The test doesn't exercise
    // credential storage, but bootstrap still runs every plugin's init().
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
  });

  afterEach(() => {
    if (originalCredKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = originalCredKey;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it(
    'round-trips a tool call through MCP and fires host pre/post subscribers',
    // Real subprocess spawn (sandbox) + another real subprocess spawn (MCP
    // stub) + HTTP-mediated LLM proxy. 60s matches the claude-sdk e2e budget.
    { timeout: 60_000 },
    async () => {
      const sqlitePath = join(tmp, 'e2e.sqlite');

      // 1. Seed config pointing at the stub.
      await seedMcpConfig(sqlitePath, {
        id: 'echo',
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [mcpServerStubPath],
      });

      // 2. Observer plugin records every pre/post-call event on the host bus.
      const preCallEvents: PreCallEvent[] = [];
      const postCallEvents: PostCallEvent[] = [];
      const observerPlugin: Plugin = {
        manifest: {
          name: '@ax/test-mcp-observer',
          version: '0.0.0',
          registers: [],
          calls: [],
          subscribes: ['tool:pre-call', 'tool:post-call'],
        },
        init({ bus }) {
          bus.subscribe<ToolCall>(
            'tool:pre-call',
            '@ax/test-mcp-observer',
            async (_ctx: AgentContext, call) => {
              preCallEvents.push({ name: call.name, input: call.input });
              return undefined;
            },
          );
          bus.subscribe<{ toolCall: ToolCall; output: unknown }>(
            'tool:post-call',
            '@ax/test-mcp-observer',
            async (_ctx: AgentContext, payload) => {
              postCallEvents.push({
                name: payload.toolCall.name,
                output: payload.output,
              });
              return undefined;
            },
          );
        },
      };

      // 3. Stub LLM plugin: two main turns.
      //    Turn 1 — tool_use: call `mcp.echo.echo` with {text: 'acceptance'}.
      //    Turn 2 — terminal text response (empty tool list).
      //
      // The native runner loops until toolCalls is empty; the chat-orchestrator
      // is one-shot (cancels after the first chat:turn-end), so a single
      // user message that ends with an empty-toolCalls response completes
      // the chat.
      let turnCount = 0;
      const stubLlmPlugin: Plugin = {
        manifest: {
          name: '@ax/test-mcp-llm-stub',
          version: '0.0.0',
          registers: ['llm:call'],
          calls: [],
          subscribes: [],
        },
        init({ bus }) {
          bus.registerService<LlmRequest, LlmResponse>(
            'llm:call',
            '@ax/test-mcp-llm-stub',
            async (_ctx, _req) => {
              turnCount += 1;
              if (turnCount === 1) {
                return {
                  assistantMessage: {
                    role: 'assistant',
                    content: 'calling echo',
                  },
                  toolCalls: [
                    {
                      id: 'tu_1',
                      name: 'mcp.echo.echo',
                      input: { text: 'acceptance' },
                    },
                  ],
                };
              }
              return {
                assistantMessage: {
                  role: 'assistant',
                  content: 'all done',
                },
                toolCalls: [],
              };
            },
          );
        },
      };

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const rc = await main({
        message: 'please echo acceptance',
        configOverride: {
          // `llm: 'mock'` satisfies the schema; `skipDefaultLlm: true`
          // replaces the default with our stub below.
          llm: 'mock',
          // Runner is 'native' by default per schema; we don't need bash or
          // file-io — the MCP tool is the only one in the catalog.
          tools: [],
          sandbox: 'subprocess',
          storage: 'sqlite',
        },
        workspaceRoot: tmp,
        sqlitePath,
        stdout: (line) => stdoutLines.push(line),
        stderr: (line) => stderrLines.push(line),
        skipDefaultLlm: true,
        extraPlugins: [observerPlugin, stubLlmPlugin],
      });

      expect(stderrLines).toEqual([]);
      expect(rc).toBe(0);
      expect(stdoutLines).not.toEqual([]);

      // Observers saw exactly one pre + one post, both for the namespaced
      // MCP tool name.
      expect(preCallEvents.map((e) => e.name)).toEqual(['mcp.echo.echo']);
      expect(postCallEvents.map((e) => e.name)).toEqual(['mcp.echo.echo']);

      // Input preserved through pre-call.
      expect(preCallEvents[0]?.input).toEqual({ text: 'acceptance' });

      // The stub server echoes `text` back as an MCP content block. The
      // literal 'acceptance' string survives the round-trip:
      //   stub -> McpConnection.callTool (ok: true) -> plugin returns
      //   {output: <raw MCP result>} -> tool.execute-host handler wraps
      //   {output: {output: <raw>}} -> runner picks resp.output -> fires
      //   event.tool-post-call with `output = {output: <raw>}`.
      // JSON.stringify over the full payload catches the substring without
      // pinning to a specific wrapper shape.
      const post = postCallEvents[0];
      expect(post).toBeDefined();
      expect(JSON.stringify(post?.output)).toContain('acceptance');
    },
  );

  it(
    'surfaces MCP_SERVER_UNAVAILABLE without terminating the chat when the server dies',
    { timeout: 60_000 },
    async () => {
      const sqlitePath = join(tmp, 'crash.sqlite');

      await seedMcpConfig(sqlitePath, {
        id: 'echo',
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [mcpServerStubPath],
      });

      const postCallEvents: PostCallEvent[] = [];
      const observerPlugin: Plugin = {
        manifest: {
          name: '@ax/test-mcp-observer',
          version: '0.0.0',
          registers: [],
          calls: [],
          subscribes: ['tool:post-call'],
        },
        init({ bus }) {
          bus.subscribe<{ toolCall: ToolCall; output: unknown }>(
            'tool:post-call',
            '@ax/test-mcp-observer',
            async (_ctx: AgentContext, payload) => {
              postCallEvents.push({
                name: payload.toolCall.name,
                output: payload.output,
              });
              return undefined;
            },
          );
        },
      };

      // Stub LLM: three main turns.
      //   1. Call `mcp.echo.crash` — stub exits(1), connection moves to
      //      unhealthy. The post-call output here is already the unavailable
      //      wrapper (the crash happens during the call itself — the SDK's
      //      transport close races with the response, and the McpConnection
      //      layer surfaces it as MCP_SERVER_UNAVAILABLE).
      //   2. Call `mcp.echo.echo` — connection is unhealthy, returns the
      //      MCP_SERVER_UNAVAILABLE wrapper immediately (this is the
      //      assertion: a dead server doesn't blow up the chat).
      //   3. Terminal text, empty toolCalls — chat ends cleanly.
      let turnCount = 0;
      const stubLlmPlugin: Plugin = {
        manifest: {
          name: '@ax/test-mcp-llm-stub',
          version: '0.0.0',
          registers: ['llm:call'],
          calls: [],
          subscribes: [],
        },
        init({ bus }) {
          bus.registerService<LlmRequest, LlmResponse>(
            'llm:call',
            '@ax/test-mcp-llm-stub',
            async (_ctx, _req) => {
              turnCount += 1;
              if (turnCount === 1) {
                return {
                  assistantMessage: {
                    role: 'assistant',
                    content: 'triggering crash',
                  },
                  toolCalls: [
                    { id: 'tu_crash', name: 'mcp.echo.crash', input: {} },
                  ],
                };
              }
              if (turnCount === 2) {
                return {
                  assistantMessage: {
                    role: 'assistant',
                    content: 'retrying echo',
                  },
                  toolCalls: [
                    {
                      id: 'tu_echo',
                      name: 'mcp.echo.echo',
                      input: { text: 'should-fail' },
                    },
                  ],
                };
              }
              return {
                assistantMessage: {
                  role: 'assistant',
                  content: 'done',
                },
                toolCalls: [],
              };
            },
          );
        },
      };

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const rc = await main({
        message: 'crash then echo',
        configOverride: {
          llm: 'mock',
          tools: [],
          sandbox: 'subprocess',
          storage: 'sqlite',
        },
        workspaceRoot: tmp,
        sqlitePath,
        stdout: (line) => stdoutLines.push(line),
        stderr: (line) => stderrLines.push(line),
        skipDefaultLlm: true,
        extraPlugins: [observerPlugin, stubLlmPlugin],
      });

      // The chat MUST complete cleanly — a dead MCP server is a tool-level
      // failure, not a chat-terminating event.
      expect(rc).toBe(0);

      // Both tool calls went through and fired their post-call subscribers.
      // The specific names: crash, then echo.
      expect(postCallEvents.map((e) => e.name)).toEqual([
        'mcp.echo.crash',
        'mcp.echo.echo',
      ]);

      // Both post-calls must carry the MCP_SERVER_UNAVAILABLE wrapper. The
      // crash call's connection-close races with the SDK response and the
      // connection layer's try/catch trips, so the crash itself comes back
      // as unavailable too — this is the intended shape (the alternative
      // would be to leak the SDK exception to the model).
      //
      // Shape on the wire (pinned to plugin.ts:203 + the host handler's
      // extra `output` wrap):
      //   { output: { isError: true, content: [{type:'text', text: "...unavailable..."}] } }
      // The outer `output` key is added by the `tool.execute-host` IPC
      // handler wrapping the service-hook return value before shipping to
      // the runner. Using JSON.stringify + substring assertions keeps us
      // robust to that wrap vs. future unwrap changes — what we care about
      // is that the unavailable-reason text made it to the subscriber.
      for (const post of postCallEvents) {
        const serialized = JSON.stringify(post.output);
        expect(serialized).toMatch(/isError":\s*true/);
        expect(serialized).toMatch(/unavailable/i);
        // Server id is embedded in the user-visible reason.
        expect(serialized).toContain("'echo'");
      }

      // Final transcript line from the stub's turn-3 terminal response.
      expect(stdoutLines.join('\n')).toContain('done');
    },
  );
});
