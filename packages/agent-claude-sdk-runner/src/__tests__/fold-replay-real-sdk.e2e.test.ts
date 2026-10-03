import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// TASK-708 — the claim the fold fix stands on, checked against the REAL
// `claude` binary (same harness shape as interrupt-real-sdk.e2e.test.ts: a
// scripted local Anthropic-compatible server, no network, no key).
//
// A user message that reaches the CLI while a turn runs is either FOLDED into
// that turn (the CLI's `queued_command` attachment, drained at a tool
// boundary — one `result` answers both) or queued for a turn of its own. The
// runner must know which, because a folded message's reqId never gets a
// turn-end. With `--replay-user-messages` (main.ts passes it) the CLI echoes
// each message as it consumes it: a fold echoes BEFORE the running turn's
// `result`, a queued message echoes AFTER it. Without the flag a fold emits
// nothing. If a CLI bump changes any of that, this suite is what says so.
//
// It skips itself when the native binary is not installed.
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

type Sse = (event: string, data: unknown) => void;
type Step = (sse: Sse) => Promise<void>;

let server: http.Server;
let baseUrl: string;
let tmp: string;
/** The last user-turn content of each agent-loop model call, as JSON. */
let modelCalls: string[];
let script: Step[];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-fold-sdk-'));
  modelCalls = [];
  script = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      void (async () => {
        let parsed: { tools?: unknown[]; messages?: Array<{ content?: unknown }>; model?: string } = {};
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
            id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: parsed.model ?? 'claude-sonnet-4-5',
            content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
          },
        });
        const step = (parsed.tools ?? []).length === 0 ? textStep('ok') : script[modelCalls.length];
        if ((parsed.tools ?? []).length > 0) {
          const msgs = parsed.messages ?? [];
          modelCalls.push(JSON.stringify(msgs[msgs.length - 1]?.content ?? ''));
        }
        if (step !== undefined) await step(sse);
        res.end();
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

function textStep(text: string, delayMs = 0): Step {
  return async (sse) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    sse('message_stop', { type: 'message_stop' });
  };
}

function bashStep(command: string): Step {
  return async (sse) => {
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fold', name: 'Bash', input: {} } });
    sse('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'slow' }) },
    });
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
    sse('message_stop', { type: 'message_stop' });
  };
}

/** A streaming-input query shaped like the runner's, optionally with the replay flag. */
function openQuery(replay: boolean) {
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
  const q = query({
    prompt: prompt(),
    options: {
      ...(replay ? { extraArgs: { 'replay-user-messages': null } } : {}),
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
      stderr: () => {},
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      model: 'claude-sonnet-4-5',
    },
  });
  const iterator = q[Symbol.asyncIterator]();
  return {
    send(text: string): string {
      const uuid = randomUUID();
      inputs.push({ type: 'user', parent_tool_use_id: null, uuid, message: { role: 'user', content: text } } as SDKUserMessage);
      wake?.();
      return uuid;
    },
    async readUntil(until: (m: SDKMessage) => boolean, seen: SDKMessage[]): Promise<SDKMessage[]> {
      for (;;) {
        const n = await iterator.next();
        if (n.done === true) return seen;
        seen.push(n.value);
        if (until(n.value)) return seen;
      }
    },
    async close(): Promise<void> {
      closed = true;
      wake?.();
      try {
        q.close();
      } catch {
        /* already closed */
      }
      // The CLI outlives close() briefly while it flushes its session files;
      // teardown's rm retries rather than racing that last write.
    },
  };
}

const isResult = (m: SDKMessage): boolean => m.type === 'result';
const isToolResult = (m: SDKMessage): boolean =>
  m.type === 'user' && JSON.stringify((m as { message?: unknown }).message ?? '').includes('tool_result');
/** The uuids the CLI echoed back as consumed, in order, tagged by position relative to results. */
function replayTimeline(seen: SDKMessage[]): string[] {
  const out: string[] = [];
  for (const m of seen) {
    if (m.type === 'result') out.push('result');
    else if (m.type === 'user' && (m as { isReplay?: boolean }).isReplay === true) out.push(`replay:${m.uuid}`);
  }
  return out;
}

describe.skipIf(!HAVE_BINARY)('Claude CLI message folding — the real SDK binary (TASK-708)', () => {
  it('echoes a message folded into the running turn BEFORE that turn\'s result', async () => {
    script = [bashStep('sleep 2; echo slow'), textStep('both answered')];
    const s = openQuery(true);
    try {
      const a = s.send('first: run the slow command');
      const seen: SDKMessage[] = [];
      // The tool call is out; the command is running. A second message now.
      await s.readUntil((m) => m.type === 'assistant', seen);
      const b = s.send('also, what is 2+2?');
      await s.readUntil(isResult, seen);
      expect(replayTimeline(seen)).toEqual([`replay:${a}`, `replay:${b}`, 'result']);
      // It really was a fold: the second model call carried b with the tool result.
      expect(modelCalls).toHaveLength(2);
      expect(modelCalls[1]).toContain('also, what is 2+2?');
      expect(modelCalls[1]).toContain('tool_result');
    } finally {
      await s.close();
    }
  }, 60_000);

  it('echoes a message that gets its own turn AFTER the running turn\'s result', async () => {
    // The second message lands while the final reply is being written — past
    // the last tool boundary — so the CLI queues it for a turn of its own.
    script = [bashStep('sleep 1; echo slow'), textStep('first answered', 1500), textStep('second answered')];
    const s = openQuery(true);
    try {
      const a = s.send('first: run the slow command');
      const seen: SDKMessage[] = [];
      await s.readUntil(isToolResult, seen);
      await new Promise((r) => setTimeout(r, 500));
      const b = s.send('also, what is 2+2?');
      await s.readUntil(isResult, seen);
      await s.readUntil(isResult, seen);
      expect(replayTimeline(seen)).toEqual([`replay:${a}`, 'result', `replay:${b}`, 'result']);
      expect(modelCalls).toHaveLength(3);
    } finally {
      await s.close();
    }
  }, 60_000);

  it('without the flag, a fold is silent — which is why main.ts passes it', async () => {
    script = [bashStep('sleep 2; echo slow'), textStep('both answered')];
    const s = openQuery(false);
    try {
      s.send('first: run the slow command');
      const seen: SDKMessage[] = [];
      await s.readUntil((m) => m.type === 'assistant', seen);
      s.send('also, what is 2+2?');
      await s.readUntil(isResult, seen);
      expect(modelCalls[1]).toContain('also, what is 2+2?');
      expect(replayTimeline(seen)).toEqual(['result']);
    } finally {
      await s.close();
    }
  }, 60_000);
});
