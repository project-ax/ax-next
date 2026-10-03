import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createInterruptProcesses } from '../interrupt-processes.js';
import { loadProjectedMcpServers } from '../projected-mcp-servers.js';
import { classifySdkToolName } from '../tool-names.js';

// ---------------------------------------------------------------------------
// TASK-760 — does a connector's MCP tool actually reach the MODEL on the
// claude-sdk runner? Checked against the REAL `claude` binary (no network, no
// key: a scripted local Anthropic-compatible server records the tool list the
// CLI sends with each model call).
//
// The setup is exactly what the runner sees in a session with a connector
// attached: `$CLAUDE_CONFIG_DIR/skills/<id>/` holding the synthetic SKILL.md
// and the `.mcp.json` the installed-skills materializer writes, keyed by the
// connector's toolNamespace, with `settingSources: ['user']`.
//
// Case 1 is the root cause, pinned: with the projection alone, the CLI offers
// NO `mcp__<ns>__…` tool — it never reads a skill dir's `.mcp.json`. If a
// future SDK starts doing so this case fails, and the explicit loading in
// main.ts becomes a duplicate worth revisiting (not a silent double-load: the
// same key would simply be defined twice).
//
// Case 2 is the fix: the same projection fed through `loadProjectedMcpServers`
// into `mcpServers` offers `mcp__<ns>__ping`, the model can call it, and the
// name lifts to the canonical `mcp.<ns>.ping` tool.pre-call sees.
//
// Skips itself when the platform's native binary is not installed.
// ---------------------------------------------------------------------------

const requireFromHere = createRequire(import.meta.url);
function nativeBinaryInstalled(): boolean {
  try {
    requireFromHere.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    return true;
  } catch {
    return false;
  }
}
const HAVE_BINARY = nativeBinaryInstalled();

const NS = 'c0123456789';
const SDK_TOOL = `mcp__${NS}__ping`;

type Sse = (event: string, data: unknown) => void;

let server: http.Server;
let baseUrl: string;
let tmp: string;
let cfg: string;
/** Tool names the CLI offered on each agent-loop model call, in order. */
let offered: string[][];
/** Raw bodies of agent-loop model calls (to read tool_result content back). */
let bodies: string[];
let callTool: string | null;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-t760-sdk-'));
  cfg = path.join(tmp, 'cfg');
  offered = [];
  bodies = [];
  callTool = null;

  // The probe connector server: one tool, `ping` → `pong-from-connector`.
  await fs.writeFile(path.join(tmp, 'probe-mcp.mjs'), `
    import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', line => {
      const req = JSON.parse(line);
      if (req.id === undefined) return;
      const result = req.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
        : req.method === 'tools/list'
        ? { tools: [{ name: 'ping', description: 'Return pong', inputSchema: { type: 'object', properties: {} } }] }
        : req.method === 'tools/call'
        ? { content: [{ type: 'text', text: 'pong-from-connector' }] }
        : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
    });
  `);
  // What materializeInstalledSkillsFromEnv writes for a connector entry.
  const bundle = path.join(cfg, 'skills', 'connector-probe');
  await fs.mkdir(bundle, { recursive: true });
  await fs.writeFile(
    path.join(bundle, 'SKILL.md'),
    '---\nname: connector-probe\ndescription: Probe connector\n---\nUse the probe tools.',
  );
  await fs.writeFile(
    path.join(bundle, '.mcp.json'),
    JSON.stringify({
      mcpServers: { [NS]: { command: process.execPath, args: [path.join(tmp, 'probe-mcp.mjs')], env: {} } },
    }),
  );

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      let parsed: { tools?: Array<{ name?: string }>; model?: string } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        /* no body */
      }
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const sse: Sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      sse('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${Date.now()}`, type: 'message', role: 'assistant',
          model: parsed.model ?? 'claude-sonnet-4-5', content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
      const tools = parsed.tools ?? [];
      const agentLoop = tools.length > 0;
      if (agentLoop) {
        offered.push(tools.map((t) => t.name ?? ''));
        bodies.push(body);
      }
      // First agent-loop call may ask for the connector tool; everything else ends the turn.
      if (agentLoop && offered.length === 1 && callTool !== null) {
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_t760', name: callTool, input: {} } });
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } });
        sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
      } else {
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } });
        sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      }
      sse('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(tmp, { recursive: true, force: true });
});

/** One turn through the real CLI, configured the way main.ts configures it. */
async function runOneTurn(mcpServers: Record<string, unknown> | undefined): Promise<SDKMessage[]> {
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'ping the probe' } } as SDKUserMessage;
  }
  // The CLI outlives `q.close()` while it flushes session files under cfg/;
  // wait for its exit so teardown's rm does not race it (as in TASK-746).
  const processes = createInterruptProcesses();
  let exited: Promise<void> = Promise.resolve();
  const q = query({
    prompt: prompt(),
    options: {
      spawnClaudeCodeProcess: (options) => {
        const child = processes.spawn(options);
        exited = new Promise<void>((r) => child.on('exit', () => r()));
        return child;
      },
      ...(mcpServers !== undefined ? { mcpServers: mcpServers as never } : {}),
      settingSources: ['user'],
      cwd: tmp,
      env: {
        ...process.env,
        HOME: tmp,
        CLAUDE_CONFIG_DIR: cfg,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'sk-ant-fake-for-a-local-scripted-server',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
      },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      model: 'claude-sonnet-4-5',
    },
  });
  const seen: SDKMessage[] = [];
  try {
    for await (const m of q) {
      seen.push(m);
      if (m.type === 'result') break;
    }
  } finally {
    q.close();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([exited, new Promise<void>((r) => { timer = setTimeout(r, 15_000); })]);
    clearTimeout(timer);
  }
  return seen;
}

describe.skipIf(!HAVE_BINARY)('connector MCP tools on the real claude-sdk binary (TASK-760)', () => {
  it('ROOT CAUSE: the SDK does not load a skill dir .mcp.json on its own — no connector tool is offered', async () => {
    await runOneTurn(undefined);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered[0]?.some((n) => n.startsWith(`mcp__${NS}__`))).toBe(false);
  }, 60_000);

  it('FIX: the projection loaded into mcpServers offers mcp__<ns>__ping, and the model can call it', async () => {
    const { servers, skipped } = await loadProjectedMcpServers(cfg, () => {});
    expect(skipped).toEqual([]);
    callTool = SDK_TOOL;
    const seen = await runOneTurn(servers);
    expect(offered[0]).toContain(SDK_TOOL);
    // The tool ran: its result went back to the model on the next call.
    expect(bodies[1] ?? '').toContain('pong-from-connector');
    expect(seen.some((m) => m.type === 'result')).toBe(true);
    // And it reaches tool.pre-call / tool-policy under the canonical name.
    expect(classifySdkToolName(SDK_TOOL)).toMatchObject({ axName: `mcp.${NS}.ping` });
  }, 60_000);
});
