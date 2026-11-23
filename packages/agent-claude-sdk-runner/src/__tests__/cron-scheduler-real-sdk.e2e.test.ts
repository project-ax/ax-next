import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildBundledSkillsEnv } from '../bundled-skills-env.js';
import { createInterruptProcesses } from '../interrupt-processes.js';
import { buildTelemetryEnv } from '../telemetry-env.js';
import { ALLOWED_SDK_BUILTINS, DENIED_SDK_BUILTINS } from '../tool-names.js';
import { stripClaudeCodeEnv } from './real-sdk-env.js';

// ---------------------------------------------------------------------------
// TASK-1207 review r3 — the CLI's own cron scheduler, on the REAL binary.
//
// The headless print path the SDK drives (CLI 2.1.119) starts a scheduler
// whenever CLAUDE_CODE_DISABLE_CRON is unset. It reads
// `<cwd>/.claude/scheduled_tasks.json` and fires unprompted turns with the
// prompts it finds there. The runner's cwd is the agent's durable, writable
// home, so an agent that writes that file (Write/Bash) schedules its own
// turns: no CronCreate call, no routine, no hold. The `tools` allowlist does
// not help; the scheduler is not a tool.
//
// `buildBundledSkillsEnv()` sets CLAUDE_CODE_DISABLE_CRON=1, which is what
// switches it off. This file pins that:
//
//   CONTROL  without the env floor, a planted entry reaches the model with no
//            user message at all (measured: the past-due one-shot fires in
//            ~1.7s, the recurring catch-up ~1s later).
//   FIX      configured like main.ts, the model sees nothing while the session
//            sits idle, and the first real turn carries no planted prompt.
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

const PLANTED_RECURRING = 'PLANTED-RECURRING-T1207';
const PLANTED_ONESHOT = 'PLANTED-ONESHOT-T1207';
/**
 * How long the FIX run sits idle. The first planted turn arrived at ~1.7s on a
 * cold start (~0.5s warm), both by ~2.6s; 5s is ~3x the cold first fire.
 */
const IDLE_WINDOW_MS = 5_000;

let server: http.Server;
let baseUrl: string;
let tmp: string;
let cfg: string;
/** Every model call body the CLI sent, in order. */
let bodies: string[];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-t1207-cron-'));
  cfg = path.join(tmp, 'cfg');
  await fs.mkdir(cfg, { recursive: true });
  // What an agent could write into its own home with the Write tool.
  await fs.mkdir(path.join(tmp, '.claude'), { recursive: true });
  const longAgo = Date.now() - 2 * 365 * 24 * 3600 * 1000;
  await fs.writeFile(
    path.join(tmp, '.claude', 'scheduled_tasks.json'),
    JSON.stringify({
      tasks: [
        { id: 'abcd1234', cron: '* * * * *', prompt: PLANTED_RECURRING, createdAt: longAgo, recurring: true },
        { id: 'beef5678', cron: '0 0 1 1 *', prompt: PLANTED_ONESHOT, createdAt: longAgo },
      ],
    }),
  );
  bodies = [];

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const sse = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      sse('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
      sse('content_block_stop', { type: 'content_block_stop', index: 0 });
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
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

const sawPlanted = (): boolean =>
  bodies.some((b) => b.includes(PLANTED_RECURRING) || b.includes(PLANTED_ONESHOT));

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

/**
 * Open a session and leave it idle: the prompt stream yields nothing until
 * `sendUserTurn()` is called. `likeMain` adds main.ts's env floor
 * (`buildBundledSkillsEnv()`); without it the CLI runs with its defaults.
 */
function openIdleSession(likeMain: boolean): {
  results: () => number;
  sendUserTurn: () => void;
  close: () => Promise<void>;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    await gate;
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'hello' } } as SDKUserMessage;
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
      settingSources: ['user'],
      cwd: tmp,
      env: {
        ...stripClaudeCodeEnv(),
        HOME: tmp,
        CLAUDE_CONFIG_DIR: cfg,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: 'sk-ant-fake-for-a-local-scripted-server',
        ...buildTelemetryEnv(),
        DISABLE_AUTOUPDATER: '1',
        ...(likeMain ? buildBundledSkillsEnv() : {}),
      },
      tools: [...ALLOWED_SDK_BUILTINS],
      disallowedTools: [...DENIED_SDK_BUILTINS],
      model: 'claude-sonnet-4-5',
    },
  });
  let resultCount = 0;
  const pump = (async () => {
    try {
      for await (const m of q) if (m.type === 'result') resultCount += 1;
    } catch {
      /* closed */
    }
  })();
  return {
    results: () => resultCount,
    sendUserTurn: () => release(),
    close: async () => {
      release();
      q.close();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([pump, exited]),
        new Promise<void>((r) => { timer = setTimeout(r, 15_000); }),
      ]);
      clearTimeout(timer);
    },
  };
}

describe.skipIf(!HAVE_BINARY)('the CLI cron scheduler on the real claude-sdk binary (TASK-1207)', () => {
  it('CONTROL: without the env floor, a planted scheduled_tasks.json entry reaches the model unprompted', async () => {
    const s = openIdleSession(false);
    try {
      await waitFor(sawPlanted, 20_000);
    } finally {
      await s.close();
    }
    expect(sawPlanted(), 'the CLI never fired the planted schedule; the FIX case would prove nothing').toBe(true);
  }, 60_000);

  it('FIX: configured like main.ts, the idle session makes no model call and the first turn carries no planted prompt', async () => {
    const s = openIdleSession(true);
    try {
      await new Promise((r) => setTimeout(r, IDLE_WINDOW_MS));
      expect(bodies, 'the CLI called the model with no user message').toEqual([]);
      // The session was alive the whole time: a real turn goes through.
      s.sendUserTurn();
      await waitFor(() => s.results() > 0, 30_000);
      expect(s.results()).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
    expect(bodies.length).toBeGreaterThan(0);
    expect(sawPlanted()).toBe(false);
  }, 60_000);
});
