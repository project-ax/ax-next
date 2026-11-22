import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createInterruptProcesses } from '../interrupt-processes.js';
import {
  ALLOWED_SDK_BUILTINS,
  DENIED_SDK_BUILTINS,
  KNOWN_SDK_BUILTINS,
  MCP_HOST_SERVER_NAME,
} from '../tool-names.js';

// ---------------------------------------------------------------------------
// TASK-1200 — which SDK built-ins can the agent actually reach? Checked against
// the REAL `claude` binary (no network, no key: a scripted local
// Anthropic-compatible server records what the CLI sends to the model).
//
// The walk for TASK-1192 caught an agent loading the SDK's `CronCreate` through
// `ToolSearch` and scheduling a sandbox-local job that skipped AX's
// `routine_create` hold. `disallowedTools` then named only four built-ins, and
// most of the others are DEFERRED: not in the model's first tool list, but
// loadable by name. So this file asks the binary, not the option typings:
//
//   1. DRIFT: the installed CLI's default built-in set is a subset of
//      `KNOWN_SDK_BUILTINS`. An SDK upgrade that adds a built-in fails here,
//      so someone decides which side of the allowlist it belongs on.
//   2. THE FIX: configured the way main.ts configures it, a model that asks
//      `ToolSearch` for `CronCreate` and AX's `routine_create` gets back only
//      `routine_create`, and no request ever offers a denied built-in.
//
// Case 2 is the one that was red before the fix: with the old four-name
// `disallowedTools`, the same ToolSearch call returned a reference to
// `CronCreate` and the next request offered it to the model.
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

const ROUTINE_TOOL = `mcp__${MCP_HOST_SERVER_NAME}__routine_create`;
const SEARCH_QUERY = `select:CronCreate,ScheduleWakeup,${ROUTINE_TOOL}`;

type Sse = (event: string, data: unknown) => void;

let server: http.Server;
let baseUrl: string;
let tmp: string;
let cfg: string;
/** Tool names the CLI offered on each agent-loop model call, in order. */
let offered: string[][];
/** Raw bodies of agent-loop model calls (to read tool_result content back). */
let bodies: string[];
/** When set, the first agent-loop call answers with this ToolSearch query. */
let searchFor: string | null;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-t1200-sdk-'));
  cfg = path.join(tmp, 'cfg');
  await fs.mkdir(cfg, { recursive: true });
  offered = [];
  bodies = [];
  searchFor = null;

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
      if (agentLoop && offered.length === 1 && searchFor !== null) {
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_t1200', name: 'ToolSearch', input: {} } });
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: searchFor, max_results: 5 }) } });
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

/**
 * The test process's env minus anything that steers a Claude Code CLI. Run from
 * inside a Claude Code session (as builders do), the parent's `CLAUDECODE` /
 * `CLAUDE_CODE_*` flags reach the spawned CLI and change its built-in set
 * (measured: an agent-teams flag drops Monitor/PushNotification/RemoteTrigger
 * and lists ToolSearch at init), so DRIFT would measure the caller, not the SDK.
 */
function cleanEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_')) continue;
    out[k] = v;
  }
  return out;
}

/** A stand-in for the runner's in-process host MCP server: one AX tool. */
function hostTools() {
  return createSdkMcpServer({
    name: MCP_HOST_SERVER_NAME,
    version: '1',
    tools: [
      tool('routine_create', 'Create a routine that runs on a schedule', { schedule: z.string() }, async () => ({
        content: [{ type: 'text', text: 'held' }],
      })),
    ],
  });
}

/**
 * One turn through the real CLI. `runner` applies main.ts's tool options
 * (the `tools` allowlist and the denied built-ins); without it the CLI loads
 * its default built-in set.
 */
async function runOneTurn(runner: boolean | 'tools-only'): Promise<SDKMessage[]> {
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'post good morning every weekday at 9' } } as SDKUserMessage;
  }
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
      mcpServers: { [MCP_HOST_SERVER_NAME]: hostTools() },
      settingSources: ['user'],
      cwd: tmp,
      env: {
        ...cleanEnv(),
        HOME: tmp,
        CLAUDE_CONFIG_DIR: cfg,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'sk-ant-fake-for-a-local-scripted-server',
        // The CLI turns tool search off for a non-Anthropic base URL; force it
        // on, as it is in production (the proxy keeps api.anthropic.com).
        ENABLE_TOOL_SEARCH: 'true',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
      },
      allowedTools: ['Skill'],
      canUseTool: async (_name: string, input: Record<string, unknown>) =>
        ({ behavior: 'allow' as const, updatedInput: input }),
      ...(runner === 'tools-only'
        ? { tools: [...ALLOWED_SDK_BUILTINS] }
        : runner
          ? { tools: [...ALLOWED_SDK_BUILTINS], disallowedTools: [...DENIED_SDK_BUILTINS] }
          : {}),
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

function initBuiltins(seen: SDKMessage[]): string[] {
  const init = seen.find(
    (m): m is Extract<SDKMessage, { type: 'system'; subtype: 'init' }> =>
      m.type === 'system' && (m as { subtype?: string }).subtype === 'init',
  );
  expect(init, 'the CLI sent no system/init message').toBeDefined();
  return (init!.tools ?? []).filter((n) => !n.startsWith('mcp__'));
}

/** Tool names a ToolSearch tool_result referenced, read from the follow-up model call. */
function searchedToolNames(): string[] {
  const body = bodies[1] ?? '';
  return [...body.matchAll(/"tool_reference","tool_name":"([^"]+)"/g)].map((m) => m[1]!);
}

describe.skipIf(!HAVE_BINARY)('SDK built-in allowlist on the real claude-sdk binary (TASK-1200)', () => {
  it('DRIFT: every built-in the installed CLI loads by default is in KNOWN_SDK_BUILTINS', async () => {
    const seen = await runOneTurn(false);
    // Both spellings: init names (`Task`) and the names on the wire in the
    // first model request (`Agent`), which is what the model actually calls.
    expect(offered.length).toBeGreaterThan(0);
    const wire = (offered[0] ?? []).filter((n) => !n.startsWith('mcp__'));
    expect(wire).toContain('Agent');
    const builtins = [...new Set([...initBuiltins(seen), ...wire])];
    // Floor: a parse that finds nothing would pass the subset check vacuously.
    expect(builtins).toContain('Bash');
    expect(builtins).toContain('CronCreate');
    const known = new Set<string>(KNOWN_SDK_BUILTINS);
    const unknown = builtins.filter((n) => !known.has(n));
    expect(
      unknown,
      'The installed claude-agent-sdk ships built-ins tool-names.ts does not know. ' +
        'Add each to KNOWN_SDK_BUILTINS, and to ALLOWED_SDK_BUILTINS only if the agent ' +
        'should have it (anything that schedules, spawns, sends or holds state outside AX stays out).',
    ).toEqual([]);
  }, 60_000);

  it('CONTROL: with the CLI defaults, ToolSearch hands the model CronCreate (the walk bug)', async () => {
    searchFor = SEARCH_QUERY;
    await runOneTurn(false);
    expect(searchedToolNames()).toContain('CronCreate');
  }, 60_000);

  it('FIX: configured like main.ts, the session loads only allowlisted built-ins', async () => {
    const seen = await runOneTurn(true);
    const allowed = new Set<string>(ALLOWED_SDK_BUILTINS);
    expect(initBuiltins(seen).filter((n) => !allowed.has(n))).toEqual([]);
  }, 60_000);

  it('FIX: ToolSearch finds routine_create but not CronCreate, and only allowlisted built-ins are ever offered', async () => {
    searchFor = SEARCH_QUERY;
    await runOneTurn(true);
    const found = searchedToolNames();
    expect(found).toContain(ROUTINE_TOOL);
    expect(found).not.toContain('CronCreate');
    expect(found).not.toContain('ScheduleWakeup');
    expect(offered.length).toBeGreaterThanOrEqual(2);
    const allowed = new Set<string>(ALLOWED_SDK_BUILTINS);
    for (const call of offered) {
      expect(call.filter((n) => !n.startsWith('mcp__') && !allowed.has(n))).toEqual([]);
    }
  }, 60_000);

  // The `tools` allowlist on its own is what keeps out a built-in nobody has
  // listed yet (a denylist cannot name it), so pin that it alone filters the
  // deferred pool ToolSearch draws from.
  it('FIX, tools allowlist alone: ToolSearch cannot load CronCreate and the wire carries only allowlisted built-ins', async () => {
    searchFor = SEARCH_QUERY;
    await runOneTurn('tools-only');
    const found = searchedToolNames();
    expect(found).toContain(ROUTINE_TOOL);
    expect(found).not.toContain('CronCreate');
    expect(found).not.toContain('ScheduleWakeup');
    expect(offered.length).toBeGreaterThanOrEqual(2);
    const allowed = new Set<string>(ALLOWED_SDK_BUILTINS);
    for (const call of offered) {
      expect(call.filter((n) => !n.startsWith('mcp__') && !allowed.has(n))).toEqual([]);
    }
  }, 60_000);
});
