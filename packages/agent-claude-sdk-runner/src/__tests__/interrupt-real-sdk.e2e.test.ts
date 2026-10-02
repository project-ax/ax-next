import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { promises as fs, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterruptProcesses } from '../interrupt-processes.js';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// TASK-688 — the claim the claude-sdk loop stands on, checked against the REAL
// `claude` binary rather than a fake.
//
// main.test.ts fakes `query()`, which proves the loop ASKS for an interrupt. It
// cannot prove the SDK DOES anything when asked — and "Stop kills the running
// command, ends the turn with an aborted result, and leaves the session usable"
// is exactly the behaviour the loop leans on and the pinned SDK version could
// change. This suite drives the real binary against a scripted local
// Anthropic-compatible server (no network, no key), interrupts mid-turn, and
// checks the OS and the message stream — the same probe that was run by hand
// while designing the card (2026-09-29, 0.2.119).
//
// Linux needs runner-owned descendant cleanup in addition to Query.interrupt;
// the delayed-write and MCP cases below exercise that production helper.
//
// It skips itself when the native binary is not installed (an unsupported
// platform, or an install that skipped optional dependencies).
// ---------------------------------------------------------------------------

const requireFromHere = createRequire(import.meta.url);

/** Is the platform-specific binary the SDK spawns actually there? */
function nativeBinaryInstalled(): boolean {
  const platform = `${process.platform}-${process.arch}`;
  const pkg = `@anthropic-ai/claude-agent-sdk-${platform}`;
  try {
    // The package is an optionalDependency; resolving it is the presence check.
    // (The SDK resolves the same package to find its binary.)
    requireFromHere.resolve(`${pkg}/package.json`);
    return true;
  } catch {
    return false;
  }
}

const HAVE_BINARY = nativeBinaryInstalled();

type Sse = (event: string, data: unknown) => void;

let server: http.Server;
let baseUrl: string;
let tmp: string;
/** Bodies of the model calls the CLI made, in order. */
let modelCalls: Array<{ messages: unknown[] }>;
/** What the scripted "model" does on each call; index = call number - 1. */
let script: Array<(sse: Sse, res: http.ServerResponse) => Promise<void>>;
/** Words the scripted model has streamed so far — progress to wait on, instead of a sleep. */
let wordsSent: number;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-real-sdk-'));
  modelCalls = [];
  script = [];
  wordsSent = 0;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      void (async () => {
        let parsed: { tools?: unknown[]; messages?: unknown[]; model?: string } = {};
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          /* HEAD / and friends carry no body */
        }
        if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: 10 }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const sse: Sse = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        sse('message_start', {
          type: 'message_start',
          message: {
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model: parsed.model ?? 'claude-sonnet-4-5',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        });
        // The CLI also makes small side calls (titles, etc.) with NO tools; only
        // the agent loop's calls carry the tool list.
        if ((parsed.tools ?? []).length === 0) {
          sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
          sse('content_block_stop', { type: 'content_block_stop', index: 0 });
          sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
          sse('message_stop', { type: 'message_stop' });
          res.end();
          return;
        }
        modelCalls.push({ messages: parsed.messages ?? [] });
        const step = script[modelCalls.length - 1];
        if (step === undefined) {
          res.end();
          return;
        }
        await step(sse, res);
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A model step that emits some text, then a Bash tool call, then stops for tool results. */
function bashStep(command: string, preamble = 'Running it now. ', toolName = 'Bash'): (sse: Sse, res: http.ServerResponse) => Promise<void> {
  return async (sse, res) => {
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: preamble } });
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_probe', name: toolName, input: {} } });
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolName === 'Bash' ? { command, description: 'slow' } : {}) },
    });
    sse('content_block_stop', { type: 'content_block_stop', index: 1 });
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } });
    sse('message_stop', { type: 'message_stop' });
    res.end();
  };
}

/** A model step that streams `words` words, one every 300 ms, then finishes. */
function slowTextStep(words: number): (sse: Sse, res: http.ServerResponse) => Promise<void> {
  return async (sse, res) => {
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (let i = 0; i < words; i++) {
      if (res.destroyed || res.writableEnded) return;
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `word${i} ` } });
      wordsSent += 1;
      await delay(300);
    }
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: words } });
    sse('message_stop', { type: 'message_stop' });
    res.end();
  };
}

/**
 * Open a streaming-input query the way the runner does (an async generator that
 * stays open), and hand back pull-style access to its messages.
 */
function openQuery(withMcp = false) {
  const inputs: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = inputs.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  }
  const processes = createInterruptProcesses();
  let stopped = false;
  const q = query({
    prompt: prompt(),
    options: {
      spawnClaudeCodeProcess: (options) => processes.spawn(options),
      hooks: { UserPromptSubmit: [{ hooks: [async () => {
        processes.preserveStartupProcesses();
        return stopped ? { continue: false, stopReason: 'Request interrupted by user' } : {};
      }] }] },
      ...(withMcp ? { mcpServers: { probe: {
        type: 'stdio' as const, command: process.execPath, args: [path.join(tmp, 'probe-mcp.mjs')],
      } } } : {}),
      cwd: tmp,
      env: {
        ...process.env,
        HOME: tmp,
        CLAUDE_CONFIG_DIR: path.join(tmp, 'cfg'),
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
  const iterator = q[Symbol.asyncIterator]();
  return {
    q,
    async interrupt(): Promise<void> {
      stopped = true;
      processes.killTools();
      await q.interrupt();
    },
    send(text: string): void {
      stopped = false;
      inputs.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } } as SDKUserMessage);
      wake?.();
    },
    /** Read messages until one satisfies `until` (returned), keeping everything seen. */
    async readUntil(until: (m: SDKMessage) => boolean, seen: SDKMessage[] = []): Promise<SDKMessage[]> {
      for (;;) {
        const n = await iterator.next();
        if (n.done === true) return seen;
        seen.push(n.value);
        if (until(n.value)) return seen;
      }
    },
    close(): void {
      closed = true;
      wake?.();
      try {
        q.close();
      } catch {
        /* already closed */
      }
    },
  };
}

const isResult = (m: SDKMessage): boolean => m.type === 'result';
const terminalReason = (m: SDKMessage): unknown => (m as { terminal_reason?: unknown }).terminal_reason;

async function processGone(pid: number, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(50);
  }
  return false;
}

describe.skipIf(!HAVE_BINARY)('Claude Stop — the real SDK binary (TASK-688 / Linux regression)', () => {
  it('kills the command that is running, ends the turn with an aborted result, and the query serves the next message', async () => {
    const pidFile = path.join(tmp, 'child.pid');
    const marker = path.join(tmp, 'cancel-probe.txt');
    script = [
      // The card's own probe, scaled down: record our pid, sleep, THEN touch the marker.
      bashStep(`echo $$ > ${pidFile}; sleep 5; touch ${marker}`),
      slowTextStep(2),
    ];
    const s = openQuery();
    try {
      s.send('run the slow command');
      // Wait until the command is really running (its pid file exists).
      const seen: SDKMessage[] = [];
      const reader = s.readUntil(isResult, seen);
      const start = Date.now();
      while (!existsSync(pidFile)) {
        if (Date.now() - start > 20_000) throw new Error('the command never started');
        await delay(50);
      }
      const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      expect(Number.isInteger(pid)).toBe(true);

      await s.interrupt();
      const messages = await reader;

      // (1) The turn ended through an ordinary `result`, flagged as aborted in
      //     the tool phase — the message the loop's existing branch closes on.
      const result = messages.find(isResult)!;
      expect(result.type).toBe('result');
      expect(terminalReason(result)).toBe('aborted_tools');
      // (2) The running command is dead and never got to touch the marker.
      expect(await processGone(pid, 5000)).toBe(true);
      // Check past the original deadline: SDK exit 137 and a dead wrapper
      // alone missed the orphan shell that kept running on Linux/GKE.
      await delay(6000);
      expect(existsSync(marker)).toBe(false);
      // (3) The tool_result the durable turn will carry says why, flagged as an error.
      const toolResult = JSON.stringify(messages.filter((m) => m.type === 'user'));
      expect(toolResult).toContain('Request interrupted by user');
      // (4) The words already written are in the stream (they become the turn's text).
      expect(JSON.stringify(messages.filter((m) => m.type === 'assistant'))).toContain('Running it now.');

      // (5) The SAME query serves the next message: Stop did not end the session.
      s.send('say hi');
      const next = await s.readUntil(isResult);
      expect(next.find(isResult)).toMatchObject({ subtype: 'success' });
      expect(modelCalls).toHaveLength(2);
    } finally {
      s.close();
    }
  }, 60_000);

  it('Stop during startup prevents a queued Bash command and leaves the query reusable', async () => {
    const marker = path.join(tmp, 'early-stop.txt');
    script = [bashStep(`touch ${marker}`), slowTextStep(2)];
    const s = openQuery();
    try {
      s.send('run the command');
      const reader = s.readUntil(isResult);
      await s.interrupt();
      const messages = await reader;
      // The pinned CLI returns an empty success for UserPromptSubmit continue:false.
      expect(messages.find(isResult)).toMatchObject({ subtype: 'success', result: '' });
      expect(modelCalls).toHaveLength(0);
      expect(existsSync(marker)).toBe(false);
      script = [slowTextStep(2)];
      s.send('say hi');
      const next = await s.readUntil(isResult);
      expect(next.find(isResult)).toMatchObject({ subtype: 'success' });
      expect(modelCalls).toHaveLength(1);
    } finally { s.close(); }
  }, 60_000);

  it('keeps a startup MCP server usable after stopping Bash', async () => {
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
          ? { content: [{ type: 'text', text: 'pong-from-preserved-mcp' }] }
          : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
      });
    `);
    const started = path.join(tmp, 'mcp-bash-started');
    script = [bashStep(`touch ${started}; sleep 20`),
      bashStep('', 'Checking MCP. ', 'mcp__probe__ping'), slowTextStep(2)];
    const s = openQuery(true);
    try {
      s.send('run the slow command');
      const reader = s.readUntil(isResult);
      const deadline = Date.now() + 30_000;
      while (!existsSync(started)) {
        if (Date.now() > deadline) throw new Error('Bash never started with MCP configured');
        await delay(50);
      }
      await s.interrupt(); await reader;
      s.send('call ping');
      const next = await s.readUntil(isResult);
      expect(next.find(isResult)).toMatchObject({ subtype: 'success' });
      expect(JSON.stringify(next.filter(m => m.type === 'user'))).toContain('pong-from-preserved-mcp');
    } finally { s.close(); }
  }, 60_000);

  it('keeps the words written so far when a reply is stopped mid-stream', async () => {
    script = [slowTextStep(40)];
    const s = openQuery();
    try {
      s.send('write a long story');
      const seen: SDKMessage[] = [];
      const reader = s.readUntil(isResult, seen);
      // Let a few words arrive (300 ms apiece — the first ones have long since
      // reached the CLI by the time the fourth is sent), then stop. Waiting on
      // progress rather than a fixed sleep: CLI start-up time varies by seconds.
      const start = Date.now();
      while (wordsSent < 4) {
        if (Date.now() - start > 30_000) throw new Error('the reply never started streaming');
        await delay(25);
      }
      await s.interrupt();
      const messages = await reader;
      const result = messages.find(isResult)!;
      expect(terminalReason(result)).toBe('aborted_streaming');
      const assistant = JSON.stringify(messages.filter((m) => m.type === 'assistant'));
      expect(assistant).toContain('word0');
      expect(assistant).not.toContain('word39');
    } finally {
      s.close();
    }
  }, 60_000);
});
