import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { Readable } from 'node:stream';

import {
  createTestProxyPlugin,
  mcpServerStubPath,
  stubRunnerPath,
  type StubRunnerScript,
} from '@ax/test-harness';
import { main } from '../main.js';
import { runMcpCommand } from '../commands/mcp.js';
import type { Plugin, ToolCall } from '@ax/core';

// ---------------------------------------------------------------------------
// Phase 6.6 Task 8 — mcp-stdio e2e (I_R3).
//
// Restores the MCP-stdio coverage that retired with the original
// `mcp-client.e2e.test.ts` (deleted in Phase 6 PR-A). Drives a real
// stdio MCP subprocess via the @ax/mcp-client plugin while the chat
// pipeline runs against the stub agent runner from @ax/test-harness —
// so we exercise the real subprocess + framing + StdioClientTransport
// codepath without needing a live LLM.
//
// Two cases:
//   1. Round-trip — the stub runner calls `mcp.stub.echo`, the host
//      bus's tool:execute:mcp.stub.echo dispatches to the live MCP
//      server's `echo` tool, and the response is observed in the
//      tool:post-call payload.
//   2. Dead server — the stub runner calls `mcp.stub.crash`, which
//      makes the server `process.exit(1)` mid-call. mcp-client wraps
//      the transport failure as a tool-error result (`isError:true`),
//      the chat continues, and rc is still 0.
//
// Platform-neutral (Node + the test-harness build artifacts), so no
// darwin gate.
// ---------------------------------------------------------------------------

interface PreCallRecord {
  kind: 'pre';
  name: string;
  toolCallId: string;
}

interface PostCallRecord {
  kind: 'post';
  name: string;
  toolCallId: string;
  output: unknown;
}

type Record_ = PreCallRecord | PostCallRecord;

function makeRecorderPlugin(records: Record_[]): Plugin {
  return {
    manifest: {
      name: '@ax/test-mcp-stdio-recorder',
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: ['tool:pre-call', 'tool:post-call'],
    },
    init({ bus }) {
      bus.subscribe<ToolCall>(
        'tool:pre-call',
        '@ax/test-mcp-stdio-recorder',
        async (_ctx, call) => {
          records.push({ kind: 'pre', name: call.name, toolCallId: call.id });
          return undefined;
        },
      );
      bus.subscribe<{ toolCall: ToolCall; output: unknown }>(
        'tool:post-call',
        '@ax/test-mcp-stdio-recorder',
        async (_ctx, payload) => {
          records.push({
            kind: 'post',
            name: payload.toolCall.name,
            toolCallId: payload.toolCall.id,
            output: payload.output,
          });
          return undefined;
        },
      );
    },
  };
}

async function seedMcpStubConfig(sqlitePath: string): Promise<void> {
  // The MCP server stub is platform-neutral — `process.execPath` (the
  // active Node binary) plus the built `mcp-server-stub.js` artifact.
  // saveConfig validates this through parseConfig, which scans for
  // inline-secret-shaped fields; we have none.
  const config = {
    id: 'stub',
    enabled: true,
    transport: 'stdio' as const,
    command: process.execPath,
    args: [mcpServerStubPath],
  };
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const code = await runMcpCommand({
    argv: ['add'],
    stdin: Readable.from([JSON.stringify(config)]),
    stdout: (l) => stdoutLines.push(l),
    stderr: (l) => stderrLines.push(l),
    sqlitePath,
  });
  if (code !== 0) {
    throw new Error(
      `mcp add failed (rc=${code}); stderr:\n${stderrLines.join('\n')}\nstdout:\n${stdoutLines.join('\n')}`,
    );
  }
}

describe('@ax/cli mcp-stdio e2e (real subprocess + stub runner)', () => {
  let tmp: string;
  let originalCredKey: string | undefined;

  beforeEach(async () => {
    tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ax-mcp-stdio-')),
    );
    originalCredKey = process.env.AX_CREDENTIALS_KEY;
    // @ax/credentials init() requires this even when skipCredentialProxy
    // is true; the credentials facade is loaded unconditionally.
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  });

  afterEach(async () => {
    if (originalCredKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = originalCredKey;
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it(
    'round-trips a tool call to a real stdio MCP server (echo)',
    { timeout: 20_000 },
    async () => {
      const sqlitePath = path.join(tmp, 'mcp-stdio-echo.sqlite');
      await seedMcpStubConfig(sqlitePath);

      const script: StubRunnerScript = {
        entries: [
          {
            kind: 'tool-call',
            name: 'mcp.stub.echo',
            input: { text: 'hi from mcp' },
            executesIn: 'host',
            expectPostCall: true,
          },
          { kind: 'assistant-text', content: 'done' },
          { kind: 'finish', reason: 'end_turn' },
        ],
      };

      const records: Record_[] = [];
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const rc = await main({
        message: 'go',
        configOverride: { sandbox: 'subprocess', storage: 'sqlite' },
        workspaceRoot: tmp,
        sqlitePath,
        stdout: (line) => stdoutLines.push(line),
        stderr: (line) => stderrLines.push(line),
        runnerBinaryOverride: stubRunnerPath,
        skipCredentialProxy: true,
        extraPlugins: [
          createTestProxyPlugin({ script }),
          makeRecorderPlugin(records),
        ],
      });

      if (rc !== 0) {
        throw new Error(
          `main exited ${rc}; stderr:\n${stderrLines.join('\n')}`,
        );
      }
      expect(rc).toBe(0);
      expect(stdoutLines.join('\n')).toContain('done');

      // Pre/post pair fires on the host bus for the namespaced tool
      // name. mcp-client's dynamic tool:execute:mcp.stub.echo hook is
      // what dispatches the host-side execute, so observing the bus
      // pair confirms the round-trip went all the way to the server
      // and back.
      const order = records.map((r) => `${r.kind}[${r.name}]`);
      expect(order).toEqual([
        'pre[mcp.stub.echo]',
        'post[mcp.stub.echo]',
      ]);
      expect(records[0]!.toolCallId).toBe(records[1]!.toolCallId);

      // The MCP SDK wraps the server's response as a result object; the
      // stub server returns `{ content: [{ type: 'text', text }] }` from
      // its echo handler (see packages/test-harness/src/mcp-server-stub.ts).
      // mcp-client's tool:execute hook returns `{ output: result.result }`,
      // and the IPC tool.execute-host handler wraps that whole thing as the
      // protocol's `{ output }` response — so post-call's `output` is the
      // `{ output: <SDK result> }` envelope from the hook return, not the
      // raw SDK result. Same convention as test-host-echo (which returns
      // `{ output: text }` from its hook). Drill in one level.
      const post = records[1] as PostCallRecord;
      const envelope = post.output as { output: unknown };
      const result = envelope.output as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      expect(result.isError).not.toBe(true);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]?.type).toBe('text');
      expect(result.content[0]?.text).toBe('hi from mcp');
    },
  );

  it(
    'survives an MCP server crashing mid-call (dead-server tool error)',
    { timeout: 20_000 },
    async () => {
      const sqlitePath = path.join(tmp, 'mcp-stdio-crash.sqlite');
      await seedMcpStubConfig(sqlitePath);

      const script: StubRunnerScript = {
        entries: [
          {
            kind: 'tool-call',
            name: 'mcp.stub.crash',
            input: {},
            executesIn: 'host',
            expectPostCall: true,
          },
          { kind: 'assistant-text', content: 'survived' },
          { kind: 'finish', reason: 'end_turn' },
        ],
      };

      const records: Record_[] = [];
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const rc = await main({
        message: 'go',
        configOverride: { sandbox: 'subprocess', storage: 'sqlite' },
        workspaceRoot: tmp,
        sqlitePath,
        stdout: (line) => stdoutLines.push(line),
        stderr: (line) => stderrLines.push(line),
        runnerBinaryOverride: stubRunnerPath,
        skipCredentialProxy: true,
        extraPlugins: [
          createTestProxyPlugin({ script }),
          makeRecorderPlugin(records),
        ],
      });

      if (rc !== 0) {
        throw new Error(
          `main exited ${rc}; stderr:\n${stderrLines.join('\n')}`,
        );
      }
      // The chat completes despite the dead server: mcp-client wraps
      // MCP_SERVER_UNAVAILABLE as a model-visible tool-error result
      // rather than throwing, so the orchestrator sees a normal
      // tool.execute-host response and the runner's script keeps
      // playing.
      expect(rc).toBe(0);
      expect(stdoutLines.join('\n')).toContain('survived');

      const order = records.map((r) => `${r.kind}[${r.name}]`);
      expect(order).toEqual([
        'pre[mcp.stub.crash]',
        'post[mcp.stub.crash]',
      ]);
      expect(records[0]!.toolCallId).toBe(records[1]!.toolCallId);

      // mcp-client's dead-server fallback shape (see
      // packages/mcp-client/src/plugin.ts:260): `isError: true` plus a
      // text content that names the server and includes the failure
      // reason. The post-call payload's `output` is the
      // `{ output: <hookReturn> }` envelope (see echo case for the
      // double-wrap rationale); drill in one level.
      const post = records[1] as PostCallRecord;
      const envelope = post.output as { output: unknown };
      const result = envelope.output as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      expect(result.isError).toBe(true);
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]?.type).toBe('text');
      expect(result.content[0]?.text ?? '').toMatch(/stub/);
      expect(result.content[0]?.text ?? '').toMatch(/unavailable/i);
    },
  );
});
