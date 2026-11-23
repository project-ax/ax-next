import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildBackgroundTasksEnv } from '../background-tasks-env.js';
import { buildBundledSkillsEnv } from '../bundled-skills-env.js';
import { buildInstructionFilesEnv } from '../instruction-files-env.js';
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
//            ~1.7s after query(), the recurring catch-up ~1s later; ~0.1s after
//            CLI readiness). CONTROL records that readiness-to-first-fire time.
//   FIX      configured like main.ts, the model sees nothing while the session
//            sits idle for max(5s, 3x CONTROL's time-to-first-fire; capped, and
//            CONTROL_WAIT_MS if CONTROL did not pass), counted
//            from CLI readiness, with stdin held open the way main.ts holds it.
//
// The FIX clock starts when the CLI answers `initialize`
// (`initializationResult()`), which it does after starting the scheduler, so a
// slow spawn cannot eat the window. The prompt stream sits on a gate through
// the idle window, so stdin is open while we watch; after the one liveness
// turn it stays pending until close, mirroring main.ts's `userMessages()`.
// The window is capped at CONTROL_WAIT_MS so a slow CONTROL cannot push FIX
// past its timeout.
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
 * The FIX run's minimum idle window, counted from CLI readiness. The first
 * planted turn arrived at ~1.7s after `query()` on a cold start (~0.5s warm).
 * FIX waits the larger of this and 3x what CONTROL measured on this machine.
 */
const MIN_IDLE_WINDOW_MS = 5_000;
/**
 * CONTROL's measured readiness-to-first-planted-call time, shared with FIX.
 * Undefined when CONTROL did not run (e.g. `-t FIX`) or failed; FIX then waits
 * CONTROL_WAIT_MS, the budget CONTROL itself allows the scheduler.
 */
let controlFirstFireMs: number | undefined;
const CONTROL_WAIT_MS = 20_000;

let server: http.Server;
let baseUrl: string;
let tmp: string;
let cfg: string;
/** Every model call body the CLI sent, in order. */
let bodies: string[];
/** When the first model call carrying a planted prompt arrived (ms epoch). */
let firstPlantedAt: number | undefined;

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
  firstPlantedAt = undefined;

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
      if (firstPlantedAt === undefined && (body.includes(PLANTED_RECURRING) || body.includes(PLANTED_ONESHOT))) {
        firstPlantedAt = Date.now();
      }
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
 * `sendUserTurn()` is called, and after that one message it stays pending
 * until `close()`, so stdin stays open the whole time (main.ts's
 * `userMessages()` likewise never returns until the session ends). `ready` resolves with the time
 * the CLI answered `initialize`, which it sends after starting its scheduler.
 * `likeMain` adds main.ts's env floor (`buildBundledSkillsEnv()` and the
 * instruction-files and background-tasks switches after it); without it the
 * CLI runs with its defaults.
 */
function openIdleSession(likeMain: boolean): {
  ready: Promise<number>;
  results: () => number;
  sendUserTurn: () => void;
  close: () => Promise<void>;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    await gate;
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'hello' } } as SDKUserMessage;
    // Returning here would let the SDK end stdin and the CLI stop its scheduler.
    await done;
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
        ...(likeMain
          ? { ...buildBundledSkillsEnv(), ...buildInstructionFilesEnv(), ...buildBackgroundTasksEnv() }
          : {}),
      },
      tools: [...ALLOWED_SDK_BUILTINS],
      disallowedTools: [...DENIED_SDK_BUILTINS],
      model: 'claude-sonnet-4-5',
    },
  });
  const ready = q.initializationResult().then(() => Date.now());
  let resultCount = 0;
  const pump = (async () => {
    try {
      for await (const m of q) if (m.type === 'result') resultCount += 1;
    } catch {
      /* closed */
    }
  })();
  return {
    ready,
    results: () => resultCount,
    sendUserTurn: () => release(),
    close: async () => {
      release();
      finish();
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
    let readyAt: number | undefined;
    try {
      readyAt = await s.ready;
      await waitFor(sawPlanted, CONTROL_WAIT_MS);
    } finally {
      await s.close();
    }
    expect(sawPlanted(), 'the CLI never fired the planted schedule; the FIX case would prove nothing').toBe(true);
    // A fire that beat readiness counts as 0: the FIX floor still applies.
    controlFirstFireMs = Math.max(0, (firstPlantedAt ?? Date.now()) - (readyAt ?? Date.now()));
  }, 60_000);

  it('FIX: configured like main.ts, the idle session makes no model call and a later turn carries no planted prompt', async () => {
    const idleWindowMs =
      controlFirstFireMs === undefined
        ? CONTROL_WAIT_MS
        : Math.min(CONTROL_WAIT_MS, Math.max(MIN_IDLE_WINDOW_MS, 3 * controlFirstFireMs));
    const s = openIdleSession(true);
    try {
      await s.ready;
      await new Promise((r) => setTimeout(r, idleWindowMs));
      expect(bodies, `the CLI called the model with no user message (idle ${idleWindowMs}ms)`).toEqual([]);
      // Session-is-alive check: the CLI is still up and answering, so the quiet
      // window above was a live session with nothing scheduled, not a dead one.
      s.sendUserTurn();
      await waitFor(() => s.results() > 0, 30_000);
      expect(s.results(), 'the session was not alive after the idle window').toBeGreaterThan(0);
    } finally {
      await s.close();
    }
    expect(bodies.length).toBeGreaterThan(0);
    expect(sawPlanted()).toBe(false);
  }, 120_000);
});
