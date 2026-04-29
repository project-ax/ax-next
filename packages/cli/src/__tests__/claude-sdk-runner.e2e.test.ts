import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import { createRequire } from 'node:module';

import { main } from '../main.js';
import { createTestHostToolPlugin } from '@ax/test-harness';
import {
  type LlmRequest,
  type LlmResponse,
  type Plugin,
  type ToolCall,
} from '@ax/core';

// The claude-agent-sdk ships precompiled native `claude` binaries as
// platform-specific optional deps (~150MB each). pnpm installs the variant
// pnpm thinks matches the host, but the SDK's runtime libc detection on
// Linux can pick a different variant (e.g., it tries linux-x64-musl on
// glibc Ubuntu) — so even when *some* binary is installed, the SDK looks
// at a path that isn't there. Until CI installs the SDK-detected variant
// explicitly, run this test only on darwin (where the dev loop happens).
// Unit-level coverage in @ax/agent-claude-sdk-runner's main.test.ts still
// runs on every platform.
function detectClaudeBinary(): boolean {
  if (process.platform !== 'darwin') return false;
  const requireFromHere = createRequire(import.meta.url);
  const variant = `darwin-${process.arch}`;
  try {
    const pkg = requireFromHere.resolve(
      `@anthropic-ai/claude-agent-sdk-${variant}/package.json`,
    );
    return existsSync(path.join(path.dirname(pkg), 'claude'));
  } catch {
    return false;
  }
}
const claudeBinaryAvailable = detectClaudeBinary();

// ---------------------------------------------------------------------------
// Week 6.5d acceptance test — runner: 'claude-sdk' end-to-end.
//
// This is the core acceptance artifact for the entire 6.5d slice. It
// exercises the full topology:
//
//   host (this test process)
//     └── @ax/sandbox-subprocess spawns
//         └── @ax/agent-claude-sdk-runner (node subprocess)
//             ├── @ax/agent-runner-core   — IPC client to host
//             ├── in-process MCP server   — for executesIn:'host' tools
//             └── @anthropic-ai/claude-agent-sdk spawns
//                 └── `claude` (native grandchild)
//                     └── HTTPS_PROXY → @ax/credential-proxy
//                         └── api.anthropic.com (with stub LLM in tests)
//
// What we verify:
//   1. rc === 0 (chat outcome is `complete`).
//   2. Both the built-in `Bash` tool AND the host-mediated MCP tool
//      `test-host-echo` fire `tool:pre-call` and `tool:post-call` on
//      the host, in the order the stub LLM drove them.
//
// Tool names in observers: the runner's classifier strips the
// `mcp__ax-host-tools__` prefix before forwarding to host subscribers —
// that's by design (subscribers see the ax-native tool name they
// registered). So the host observes `test-host-echo`, not
// `mcp__ax-host-tools__test-host-echo`.
// ---------------------------------------------------------------------------

async function mkTmp(): Promise<string> {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-e2e-sdk-')));
}

interface PreCallEvent {
  name: string;
  input: unknown;
}
interface PostCallEvent {
  name: string;
  output: unknown;
}

// The runner reaches Anthropic only via the credential-proxy. This test's
// stub-LLM topology routed `claude` → in-sandbox llm-proxy → host
// `llm:call`, which no longer exists. Phase 6 also deleted @ax/llm-mock /
// @ax/llm-anthropic and the `skipDefaultLlm` test seam. PR-B (Phase 6.6)
// will rebuild this against the credential-proxy + a stub Anthropic
// backend; until then the body is left in place for reference but the
// suite is fully skipped.
// TODO(Phase 6.6 / PR-B): rewrite this test against the credential-proxy
// pointed at a stub Anthropic upstream.
void claudeBinaryAvailable;
describe.skip('claude-sdk runner e2e', () => {
  let tmp: string;
  let originalCredKey: string | undefined;

  beforeEach(async () => {
    tmp = await mkTmp();
    originalCredKey = process.env.AX_CREDENTIALS_KEY;
    // @ax/credentials is wired into the chat path; its init() needs a
    // 32-byte key. This test doesn't touch credentials, but bootstrap
    // still calls init() on every plugin.
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  });

  afterEach(async () => {
    if (originalCredKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = originalCredKey;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it(
    'built-in Bash + host MCP test-host-echo both fire pre/post subscribers',
    // Real subprocess + real claude CLI grandchild + real HTTP proxy —
    // the full loop is I/O-bound. 60s is generous for local runs; CI may
    // need more if this ever turns flaky.
    { timeout: 60_000 },
    async () => {
      const preCallEvents: PreCallEvent[] = [];
      const postCallEvents: PostCallEvent[] = [];

      // Observer plugin: records every tool:pre-call and tool:post-call.
      // Returning `undefined` from a subscriber is pass-through (no veto,
      // no transform) so neither Bash nor the MCP tool is affected.
      const observerPlugin: Plugin = {
        manifest: {
          name: '@ax/test-observer',
          version: '0.0.0',
          registers: [],
          calls: [],
          subscribes: ['tool:pre-call', 'tool:post-call'],
        },
        init({ bus }) {
          bus.subscribe<ToolCall>(
            'tool:pre-call',
            '@ax/test-observer',
            async (_ctx, call) => {
              preCallEvents.push({ name: call.name, input: call.input });
              return undefined;
            },
          );
          bus.subscribe<{ toolCall: ToolCall; output: unknown }>(
            'tool:post-call',
            '@ax/test-observer',
            async (_ctx, payload) => {
              postCallEvents.push({
                name: payload.toolCall.name,
                output: payload.output,
              });
              return undefined;
            },
          );
        },
      };

      // Stub LLM plugin: three-phase response chain driven by a turn counter
      // that ONLY advances for main-turn requests. The `claude` CLI issues a
      // short auxiliary request (session-title generation) before the first
      // real user turn — we detect it by its system-prompt preamble and
      // short-circuit with a harmless text-only response so it doesn't
      // consume a slot in the canned sequence.
      let mainTurnCount = 0;
      const stubLlmPlugin: Plugin = {
        manifest: {
          name: '@ax/test-llm-stub',
          version: '0.0.0',
          registers: ['llm:call'],
          calls: [],
          subscribes: [],
        },
        init({ bus }) {
          bus.registerService<LlmRequest, LlmResponse>(
            'llm:call',
            '@ax/test-llm-stub',
            async (_ctx, req) => {
              // Structural discriminator: the `claude` CLI emits an
              // auxiliary title-summary request with NO tools declared.
              // Every main-turn request comes from a session that
              // advertised the tool catalog, so `tools` is non-empty. This
              // survives SDK system-prompt wording changes that broke the
              // earlier substring check.
              const hasTools = Array.isArray(req.tools) && req.tools.length > 0;
              if (!hasTools) {
                return {
                  assistantMessage: {
                    role: 'assistant',
                    content: '{"title":"Acceptance test"}',
                  },
                  toolCalls: [],
                };
              }

              mainTurnCount += 1;
              if (mainTurnCount > 3) {
                // Loud failure if title-detection ever silently drifts —
                // better to crash the test than to pass with the wrong
                // turn sequence. The canned script has three main turns
                // (bash tool_use → mcp tool_use → terminal); anything
                // beyond that means a turn was miscategorized.
                throw new Error(
                  'unexpected mainTurnCount > 3 — title-detection likely drifted',
                );
              }
              if (mainTurnCount === 1) {
                // Main turn 1: ask the SDK to run the built-in Bash tool.
                return {
                  assistantMessage: {
                    role: 'assistant',
                    content: 'running bash',
                  },
                  toolCalls: [
                    {
                      id: 'tu_1',
                      name: 'Bash',
                      input: { command: 'echo hi' },
                    },
                  ],
                };
              }
              if (mainTurnCount === 2) {
                // Main turn 2: ask to invoke the host-side MCP tool. The
                // SDK routes MCP tool calls by their prefixed name.
                return {
                  assistantMessage: {
                    role: 'assistant',
                    content: 'now echo',
                  },
                  toolCalls: [
                    {
                      id: 'tu_2',
                      name: 'mcp__ax-host-tools__test-host-echo',
                      input: { text: 'acceptance' },
                    },
                  ],
                };
              }
              // Main turn 3+: terminal — no tool calls, stop_reason becomes
              // end_turn on the proxy's translate-response path.
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

      const sqlitePath = path.join(tmp, 'e2e.sqlite');
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const rc = await main({
        message: 'please run echo then call test-host-echo',
        configOverride: {
          // llm: 'mock' satisfies the schema; we're skipping the default
          // LLM plugin anyway, so the concrete value doesn't matter.
          llm: 'mock',
          sandbox: 'subprocess',
          storage: 'sqlite',
        },
        workspaceRoot: tmp,
        sqlitePath,
        stdout: (line) => stdoutLines.push(line),
        stderr: (line) => stderrLines.push(line),
        // Test-only seams (see main.ts MainOptions JSDoc).
        skipDefaultLlm: true,
        extraPlugins: [
          observerPlugin,
          createTestHostToolPlugin(),
          stubLlmPlugin,
        ],
      });

      expect(stderrLines).toEqual([]);
      expect(rc).toBe(0);
      // `stdoutLines` is only captured for symmetry with stderr; the final
      // assistant text 'all done' goes here but we don't assert on the body
      // — the observer-event arrays are the acceptance contract.
      expect(stdoutLines).not.toEqual([]);

      // Both subscriber arrays should carry the same two names, in order:
      // Bash (built-in, handled inside claude) then test-host-echo (routed
      // through our in-process MCP server).
      expect(preCallEvents.map((e) => e.name)).toEqual([
        'Bash',
        'test-host-echo',
      ]);
      expect(postCallEvents.map((e) => e.name)).toEqual([
        'Bash',
        'test-host-echo',
      ]);

      // The stub LLM's echo call carries `text: 'acceptance'`. The host-side
      // `tool:execute:test-host-echo` hook returns `{output: 'acceptance'}`,
      // the host MCP wrapper renders that as an MCP content-block list
      // `[{type:'text', text:'{"output":"acceptance"}'}]`, and that's what
      // the SDK's PostToolUse hook passes back as `tool_response`. We
      // assert the payload round-trips the literal 'acceptance' substring
      // through the whole chain so any future change in wire formatting
      // gets a loud test failure instead of silent data loss.
      const echoPost = postCallEvents.find((e) => e.name === 'test-host-echo');
      expect(JSON.stringify(echoPost?.output)).toContain('acceptance');
    },
  );
});
