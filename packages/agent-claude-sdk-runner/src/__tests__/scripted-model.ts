import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { IpcClient } from '@ax/ipc-protocol';
import { buildBackgroundTasksEnv } from '../background-tasks-env.js';
import { buildBundledSkillsEnv } from '../bundled-skills-env.js';
import { buildInstructionFilesEnv } from '../instruction-files-env.js';
import { createInterruptProcesses } from '../interrupt-processes.js';
import { buildTelemetryEnv } from '../telemetry-env.js';
import { ALLOWED_SDK_BUILTINS, DENIED_SDK_BUILTINS } from '../tool-names.js';

// ---------------------------------------------------------------------------
// TASK-1217 test helper (not a test): a scripted fake `/v1/messages` server
// plus a session runner that drives the REAL `claude` binary the way main.ts
// does. Used only by the TASK-1217 real-binary e2e files
// (config-dir-*, background-tasks-, slash-text-real-sdk.e2e.test.ts).
//
// Why a helper: those files all need the same four things the planner's probe
// needed, and each is easy to get subtly wrong.
//
//   - The model is scripted per AGENT-LOOP call (a request that carries
//     `tools`); the CLI's own side calls (token counts, compaction summaries
//     without tools) get no step and are recorded but never consume one.
//   - Turns are sent ONE AT A TIME: `send()` resolves on that turn's `result`.
//     Yielding two prompts together makes the CLI fold or coalesce them.
//   - The prompt stream stays open (pending on a gate) between turns and after
//     the last one, like main.ts's `userMessages()`, so the CLI keeps running
//     its watchers and background tasks while a test watches for unprompted
//     calls.
//   - The CLI's env is built by the CALLER (`env: { ...stripClaudeCodeEnv(), ... }`,
//     which real-sdk-env.test.ts scans for), then HOME / CLAUDE_CONFIG_DIR /
//     the fake endpoint are laid over it here.
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
/** False when the platform's native `claude` binary is not installed; the e2e files skip then. */
export const HAVE_BINARY = nativeBinaryInstalled();

/** One scripted agent-loop answer. Anything else (or no step left) is the text `ok`. */
export type Step = { tool: string; input: Record<string, unknown> } | { text: string } | Record<string, never>;

export type Call = {
  /** `Date.now()` when the request arrived. */
  t: number;
  body: string;
  /** The request carries `tools`, so it is the agent loop and not a side call. */
  agentLoop: boolean;
};

export type ScriptedServer = {
  baseUrl: string;
  /** Replace the script. Only agent-loop calls consume steps. */
  setScript(steps: Step[]): void;
  /** Every model call, in order. */
  calls: Call[];
  agentCalls(): Call[];
  close(): Promise<void>;
};

export async function startScriptedServer(): Promise<ScriptedServer> {
  let script: Step[] = [];
  const calls: Call[] = [];
  let toolSeq = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      let parsed: { tools?: unknown[]; model?: string } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        /* no body */
      }
      const agentLoop = (parsed.tools ?? []).length > 0;
      calls.push({ t: Date.now(), body, agentLoop });
      const step = agentLoop ? script.shift() : undefined;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const sse = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      sse('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${Date.now()}`, type: 'message', role: 'assistant',
          model: parsed.model ?? 'claude-sonnet-4-5', content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
      if (step !== undefined && 'tool' in step) {
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_t1217_${(toolSeq += 1)}`, name: step.tool, input: {} } });
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } });
        sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
      } else {
        const text = step !== undefined && 'text' in step ? step.text : 'ok';
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
        sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      }
      sse('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    setScript: (steps) => {
      script = [...steps];
    },
    calls,
    agentCalls: () => calls.filter((c) => c.agentLoop),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The env pieces main.ts adds on top of the stripped parent env, each floor toggleable. */
export function mainFloors(
  toggles: { instructionFiles?: boolean; backgroundTasks?: boolean } = {},
): Record<string, string> {
  const { instructionFiles = true, backgroundTasks = true } = toggles;
  return {
    ...buildTelemetryEnv(),
    ...buildBundledSkillsEnv(),
    ...(instructionFiles ? buildInstructionFilesEnv() : {}),
    ...(backgroundTasks ? buildBackgroundTasksEnv() : {}),
  };
}

type QueryOptions = NonNullable<Parameters<typeof query>[0]['options']>;

export type SessionOptions = {
  server: ScriptedServer;
  /** `$CLAUDE_CONFIG_DIR`. */
  cfg: string;
  /** The agent home: HOME and the CLI's cwd. */
  files: string;
  /** The caller's base env: `{ ...stripClaudeCodeEnv(), ...mainFloors(...) }`. */
  env: Record<string, string | undefined>;
  hooks?: QueryOptions['hooks'];
};

export type TurnResult = {
  result: Extract<SDKMessage, { type: 'result' }>;
  /** `Date.now()` when the result reached us. */
  at: number;
};

export type Session = {
  /** Every message the CLI emitted, with arrival times. */
  messages: Array<{ t: number; m: SDKMessage }>;
  /** Send one turn and resolve on its `result` (hard cap `timeoutMs`). */
  send(content: unknown, timeoutMs?: number): Promise<TurnResult>;
  /** The `system/init` messages seen so far. */
  inits(): Array<Record<string, unknown>>;
  close(): Promise<void>;
};

/**
 * Open a session like main.ts does (`settingSources: ['user']`, the tool
 * lists, `Skill` allowed, replayed user messages, HOME = cwd = the agent
 * home) and wait for the CLI to answer `initialize`.
 */
export async function openSession(opts: SessionOptions): Promise<Session> {
  const messages: Session['messages'] = [];
  const pending: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      if (pending.length === 0) await new Promise<void>((r) => (wake = r));
      if (closed) return;
      const content = pending.shift();
      yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } } as SDKUserMessage;
    }
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
      cwd: opts.files,
      env: {
        ...opts.env,
        HOME: opts.files,
        CLAUDE_CONFIG_DIR: opts.cfg,
        ANTHROPIC_BASE_URL: opts.server.baseUrl,
        ANTHROPIC_API_KEY: 'sk-ant-fake-for-a-local-scripted-server',
        DISABLE_AUTOUPDATER: '1',
      },
      tools: [...ALLOWED_SDK_BUILTINS],
      disallowedTools: [...DENIED_SDK_BUILTINS],
      allowedTools: ['Skill'],
      canUseTool: async (_name: string, input: Record<string, unknown>) =>
        ({ behavior: 'allow' as const, updatedInput: input }),
      systemPrompt: 'You are an AX agent.',
      extraArgs: { 'replay-user-messages': null },
      model: 'claude-sonnet-4-5',
      ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
    },
  });
  let waiter: ((r: TurnResult) => void) | undefined;
  const pump = (async () => {
    try {
      for await (const m of q) {
        messages.push({ t: Date.now(), m });
        if (m.type === 'result') {
          const w = waiter;
          waiter = undefined;
          w?.({ result: m, at: Date.now() });
        }
      }
    } catch {
      /* closed */
    }
  })();
  await q.initializationResult();
  return {
    messages,
    send: (content, timeoutMs = 30_000) =>
      new Promise<TurnResult>((resolve, reject) => {
        if (waiter !== undefined) {
          reject(new Error('a turn is already in flight; turns are sent one at a time'));
          return;
        }
        const timer = setTimeout(() => {
          waiter = undefined;
          reject(new Error(`no result for the turn within ${timeoutMs}ms`));
        }, timeoutMs);
        waiter = (r) => {
          clearTimeout(timer);
          resolve(r);
        };
        pending.push(content);
        wake?.();
      }),
    inits: () =>
      messages
        .map(({ m }) => m)
        .filter((m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'init') as unknown as Array<Record<string, unknown>>,
    close: async () => {
      closed = true;
      wake?.();
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

/** Resolves true as soon as `cond()` holds, false after `ms` (poll 50 ms). */
export async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Block = Record<string, unknown>;
type Body = { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ name?: string; input_schema?: { properties?: Record<string, unknown> } }> };

/** The text of the last block of the request's last message (a tool_result's own text for one). */
export function lastUserBlockText(body: string): string {
  const parsed = JSON.parse(body) as Body;
  const content = parsed.messages?.at(-1)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const last = content.at(-1) as Block | undefined;
  if (last === undefined) return '';
  if (typeof last['text'] === 'string') return last['text'];
  return JSON.stringify(last);
}

/** Every `tool_result` in the request, in order. */
export function toolResultsIn(body: string): Array<{ isError: boolean; text: string }> {
  const parsed = JSON.parse(body) as Body;
  const out: Array<{ isError: boolean; text: string }> = [];
  for (const m of parsed.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content as Block[]) {
      if (c['type'] !== 'tool_result') continue;
      const content = c['content'];
      out.push({
        isError: c['is_error'] === true,
        text: typeof content === 'string' ? content : JSON.stringify(content),
      });
    }
  }
  return out;
}

/** The property names of the `Bash` tool's input schema in this request. */
export function bashSchemaProps(body: string): string[] {
  const bash = (JSON.parse(body) as Body).tools?.find((t) => t.name === 'Bash');
  return Object.keys(bash?.input_schema?.properties ?? {});
}

/** An IPC client that allows every `tool.pre-call` and records the calls. */
export function stubIpcClient(): { client: IpcClient; calls: Array<{ action: string; payload: unknown }> } {
  const calls: Array<{ action: string; payload: unknown }> = [];
  const client: IpcClient = {
    async call(action, payload) {
      calls.push({ action, payload });
      return { verdict: 'allow' } as never;
    },
    callGet: async () => {
      throw new Error('callGet not expected');
    },
    callBinary: async () => {
      throw new Error('callBinary not expected');
    },
    callBinaryUpload: async () => {
      throw new Error('callBinaryUpload not expected');
    },
    event: async () => {
      throw new Error('event not expected');
    },
    close: async () => {
      /* no-op */
    },
  };
  return { client, calls };
}

/**
 * The Bash command an injected agent would run to plant a settings file in its
 * own `$CLAUDE_CONFIG_DIR`: an env var plus `SessionStart`, `UserPromptSubmit`
 * and `PreToolUse` command hooks that append `ss` / `ups` / `pre` to `marker`.
 */
export function plantSettingsCommand(marker: string): string {
  const hook = (tag: string): { hooks: Array<{ type: string; command: string }> } =>
    ({ hooks: [{ type: 'command', command: `echo ${tag} >> ${marker}` }] });
  const settings = {
    env: { PLANTED_T1217: 'yes' },
    hooks: {
      SessionStart: [hook('ss')],
      UserPromptSubmit: [hook('ups')],
      PreToolUse: [{ matcher: '.*', ...hook('pre') }],
    },
  };
  return `printf '%s' '${JSON.stringify(settings)}' > "$CLAUDE_CONFIG_DIR/settings.json"`;
}

/** A Bash `printf` that writes `PLANTED-<word>-T1217` built from parts (the literal never sits in the tool_use input). */
export function printfMarker(word: string, redirect: string): string {
  return `printf 'PLANTED-%s-T1217\\n' ${word} ${redirect}`;
}

export const ENV_PROBE_COMMAND = 'echo "ENV=[$PLANTED_T1217]"';

/** A temp tree: `<tmp>/files` (agent home) and `<tmp>/cfg` with an empty `skills/`. */
export async function makeSandboxDirs(prefix: string): Promise<{ tmp: string; files: string; cfg: string }> {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const files = path.join(tmp, 'files');
  const cfg = path.join(tmp, 'cfg');
  await fs.mkdir(files, { recursive: true });
  await fs.mkdir(path.join(cfg, 'skills'), { recursive: true });
  return { tmp, files, cfg };
}

/** A fresh config dir under `tmp` holding only `skills/`. */
export async function makeFreshConfigDir(tmp: string, name: string): Promise<string> {
  const dir = path.join(tmp, name);
  await fs.mkdir(path.join(dir, 'skills'), { recursive: true });
  return dir;
}

/** Restore write bits (a locked 0555 skills projection blocks `rm`), then remove. */
export async function removeTree(dir: string): Promise<void> {
  try {
    execFileSync('chmod', ['-R', 'u+w', dir]);
  } catch {
    /* already gone */
  }
  await fs.rm(dir, { recursive: true, force: true });
}

/** Project one skill like the sandbox does: dirs 0555, file 0444. */
export async function projectLockedSkill(cfg: string, name: string, body: string, description: string): Promise<void> {
  const dir = path.join(cfg, 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    { mode: 0o444 },
  );
  await fs.chmod(dir, 0o555);
  await fs.chmod(path.join(cfg, 'skills'), 0o555);
}
