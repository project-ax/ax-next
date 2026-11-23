import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
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
import { createPreToolUseHook } from '../pre-tool-use.js';
import { CLI_COMMAND_NAMES, readProjectedSkills } from '../projected-skills.js';
import { buildTelemetryEnv } from '../telemetry-env.js';
import { ALLOWED_SDK_BUILTINS, DENIED_SDK_BUILTINS } from '../tool-names.js';
import { stripClaudeCodeEnv } from './real-sdk-env.js';

// ---------------------------------------------------------------------------
// TASK-1207 — which skills can the agent actually invoke? Checked against the
// REAL `claude` binary (no network, no key: a scripted local
// Anthropic-compatible server records what the CLI sends to the model).
//
// The CLI ships skills inside the binary (`loop`, `update-config`, `claude-api`,
// ...) next to the ones AX installs under $CLAUDE_CONFIG_DIR/skills/. `loop`
// says "Call CronCreate"; `update-config` writes a settings file nothing loads.
// Two layers keep them out, and this file pins both on the real binary:
//
//   1. `buildBundledSkillsEnv()` removes `loop` and `claude-api` (the CLI then
//      says "Unknown skill" before any hook runs).
//   2. `createPreToolUseHook({ projectedSkills })` refuses every other `Skill`
//      call whose name is not a folder AX installed.
//
// TASK-1217 adds two things (item 2): the CLI also answers to 16 command names
// of its own (`CLI_COMMAND_NAMES`), not only the ones in the model's listing.
// DRIFT pins that list on this binary; the collision cases show what happens to
// an AX skill with one of those names (the CLI's bundled body runs instead)
// and that the PreToolUse hook refuses it with a rename message.
//
// Probe recipe for the next CLI bump: copy this file's setup, change the
// `skillCall`, and read the `system/init` `skills` list and the tool_result.
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

type Sse = (event: string, data: unknown) => void;

let server: http.Server;
let baseUrl: string;
let tmp: string;
let cfg: string;
/** Agent-loop model calls seen so far (a call with tools is the agent loop). */
let agentCalls: number;
/** Raw bodies of agent-loop model calls (to read the tool_result back). */
let bodies: string[];
/** When set, the first agent-loop call answers with a `Skill` call for this name. */
let skillCall: string | null;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-t1207-sdk-'));
  cfg = path.join(tmp, 'cfg');
  await fs.mkdir(path.join(cfg, 'skills', 'weekly-report'), { recursive: true });
  await fs.writeFile(
    path.join(cfg, 'skills', 'weekly-report', 'SKILL.md'),
    '---\nname: weekly-report\ndescription: Write the weekly status report from notes.\n---\n\nWrite the report.\n',
  );
  agentCalls = 0;
  bodies = [];
  skillCall = null;

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
      const agentLoop = (parsed.tools ?? []).length > 0;
      if (agentLoop) {
        agentCalls += 1;
        bodies.push(body);
      }
      if (agentLoop && agentCalls === 1 && skillCall !== null) {
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_t1207', name: 'Skill', input: {} } });
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ skill: skillCall }) } });
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

/** An IPC client that allows every `tool.pre-call` and records the calls. */
function stubClient(): { client: IpcClient; calls: Array<{ action: string; payload: unknown }> } {
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
 * One turn through the real CLI. `likeMain` applies main.ts's bundled-skill
 * configuration: the `buildBundledSkillsEnv()` floor (plus the rest of
 * main.ts's CLI env floor, so the CLI's listing is the one production sees)
 * and the PreToolUse hook that refuses any `Skill` call outside AX's
 * projection. Without it the CLI runs with its defaults (the control).
 * `withHook: false` keeps the likeMain env but leaves the hook out (the
 * collision CONTROL: the TASK-1207 known hole, re-pinned).
 */
async function runOneTurn(likeMain: boolean, { withHook = likeMain }: { withHook?: boolean } = {}): Promise<{
  seen: SDKMessage[];
  preCalls: Array<{ action: string; payload: unknown }>;
}> {
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'post good morning here every weekday at 9am' } } as SDKUserMessage;
  }
  const { client, calls } = stubClient();
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
      allowedTools: ['Skill'],
      canUseTool: async (_name: string, input: Record<string, unknown>) =>
        ({ behavior: 'allow' as const, updatedInput: input }),
      ...(withHook
        ? {
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    createPreToolUseHook({
                      client,
                      projectedSkills: await readProjectedSkills(cfg),
                    }),
                  ],
                },
              ],
            },
          }
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
  return { seen, preCalls: calls.filter((c) => c.action === 'tool.pre-call') };
}

function initSkills(seen: SDKMessage[]): string[] {
  const init = seen.find(
    (m): m is Extract<SDKMessage, { type: 'system'; subtype: 'init' }> =>
      m.type === 'system' && (m as { subtype?: string }).subtype === 'init',
  );
  expect(init, 'the CLI sent no system/init message').toBeDefined();
  return init!.skills ?? [];
}

function initMessage(seen: SDKMessage[]): { skills: string[]; slash_commands: string[] } {
  const init = seen.find(
    (m): m is Extract<SDKMessage, { type: 'system'; subtype: 'init' }> =>
      m.type === 'system' && (m as { subtype?: string }).subtype === 'init',
  );
  expect(init, 'the CLI sent no system/init message').toBeDefined();
  return { skills: init!.skills ?? [], slash_commands: init!.slash_commands ?? [] };
}

/** Every string in a parsed request body (system prompt and message blocks alike). */
function allStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const n of node) allStrings(n, out);
  else if (typeof node === 'object' && node !== null) for (const n of Object.values(node)) allStrings(n, out);
  return out;
}

/** The skill names in the model-facing listing of one request body. */
function listedSkillNames(body: string): string[] {
  const marker = 'The following skills are available for use with the Skill tool';
  const text = allStrings(JSON.parse(body)).find((t) => t.includes(marker));
  expect(text, 'the request carried no skill listing').toBeDefined();
  const listing = text!.slice(text!.indexOf(marker)).split('</system-reminder>')[0] ?? '';
  return [...listing.matchAll(/^- ([a-z0-9:-]+):/gm)].map((m) => m[1] as string);
}

/** The `Skill` tool_result the CLI sent back to the model, read from the follow-up call. */
function skillResult(): { isError: boolean; text: string } {
  const body = JSON.parse(bodies[1] ?? '{}') as {
    messages?: Array<{ content?: unknown }>;
  };
  for (const m of body.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content as Array<Record<string, unknown>>) {
      if (c['type'] !== 'tool_result') continue;
      const content = c['content'];
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      return { isError: c['is_error'] === true, text };
    }
  }
  throw new Error('the follow-up model call carried no tool_result');
}

describe.skipIf(!HAVE_BINARY)('bundled skills on the real claude-sdk binary (TASK-1207)', () => {
  it('CONTROL: the CLI ships loop and update-config by default', async () => {
    const { seen } = await runOneTurn(false);
    const skills = initSkills(seen);
    expect(skills).toContain('loop');
    expect(skills).toContain('update-config');
    expect(skills).toContain('weekly-report');
  }, 60_000);

  it('FIX: configured like main.ts, the session has the installed skill and neither loop nor claude-api', async () => {
    const { seen } = await runOneTurn(true);
    const skills = initSkills(seen);
    expect(skills).toContain('weekly-report');
    expect(skills).not.toContain('loop');
    expect(skills).not.toContain('claude-api');

    // DRIFT (TASK-1217 item 2): every name the CLI answers to in this
    // configuration, minus the AX skill we installed, is exactly
    // CLI_COMMAND_NAMES. `simplify` etc. are NOT projected here: subtracting
    // them would hide the name from the union.
    const init = initMessage(seen);
    const union = new Set([...listedSkillNames(bodies[0] ?? '{}'), ...init.skills, ...init.slash_commands]);
    union.delete('weekly-report');
    expect(
      [...union].sort(),
      "the CLI's command names changed — update CLI_COMMAND_NAMES and re-check Task 5's refusal (projected-skills.ts)",
    ).toEqual([...CLI_COMMAND_NAMES].sort());
  }, 60_000);

  it('FIX: update-config is refused by the runner', async () => {
    skillCall = 'update-config';
    const { preCalls } = await runOneTurn(true);
    const r = skillResult();
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not one of this agent's skills");
    // Refused before the host is asked.
    expect(preCalls).toEqual([]);
  }, 60_000);

  it('FIX: /init is refused by the runner', async () => {
    skillCall = '/init';
    const { preCalls } = await runOneTurn(true);
    const r = skillResult();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"init"');
    expect(r.text).toContain("not one of this agent's skills");
    // Refused before the host is asked (SECURITY.md says so for /init too).
    expect(preCalls).toEqual([]);
  }, 60_000);

  it('FIX: the installed skill launches', async () => {
    skillCall = 'weekly-report';
    const { preCalls } = await runOneTurn(true);
    const r = skillResult();
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Launching skill: weekly-report');
    expect(preCalls).toHaveLength(1);
  }, 60_000);

  it('FIX: loop is unknown to the CLI', async () => {
    skillCall = 'loop';
    await runOneTurn(true);
    const r = skillResult();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Unknown skill: loop');
  }, 60_000);
  // -- TASK-1217 item 2: an AX skill the CLI shadows --------------------------

  /** A separate config dir whose only skill is an AX `simplify`, named like a CLI command. */
  async function projectShadowedSimplify(): Promise<void> {
    cfg = path.join(tmp, 'cfg-collision');
    await fs.mkdir(path.join(cfg, 'skills', 'simplify'), { recursive: true });
    await fs.writeFile(
      path.join(cfg, 'skills', 'simplify', 'SKILL.md'),
      '---\nname: simplify\ndescription: Simplify things the AX way.\n---\n\nAX-SIMPLIFY-T1217\n',
    );
  }

  it('collision CONTROL: without the hook the CLI launches ITS simplify, not the AX one (the TASK-1207 hole, re-pinned)', async () => {
    await projectShadowedSimplify();
    skillCall = 'simplify';
    await runOneTurn(true, { withHook: false });
    const r = skillResult();
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Launching skill: simplify');
    const next = bodies[1] ?? '';
    expect(next, "the CLI's bundled simplify body did not run").toContain('Launch Three Review Agents in Parallel');
    expect(next, 'the AX simplify body ran, so the name is not shadowed after all').not.toContain('AX-SIMPLIFY-T1217');
  }, 60_000);

  it('collision FIX: the production hook refuses the shadowed name with a rename message', async () => {
    await projectShadowedSimplify();
    skillCall = 'simplify';
    const { preCalls } = await runOneTurn(true);
    const r = skillResult();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('give the skill a different name');
    expect(r.text).toContain('"simplify"');
    // Refused before the host is asked, and neither body reaches the model.
    expect(preCalls).toEqual([]);
    expect(bodies[1] ?? '').not.toContain('AX-SIMPLIFY-T1217');
    expect(bodies[1] ?? '').not.toContain('Launch Three Review Agents in Parallel');
  }, 60_000);
});
