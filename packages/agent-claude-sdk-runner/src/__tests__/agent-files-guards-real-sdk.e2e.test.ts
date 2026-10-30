import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createSdkMcpServer,
  query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { buildToolCacheEnv, buildTtyHintEnv } from '@ax/agent-runner-core';
import { createInterruptProcesses } from '../interrupt-processes.js';
import { createJsonlTranscriptSource, locateJsonl } from '../jsonl-transcript-source.js';
import { buildTelemetryEnv } from '../telemetry-env.js';
import {
  DISABLED_BUILTINS,
  MCP_HOST_SERVER_NAME,
  MCP_SANDBOX_SERVER_NAME,
} from '../tool-names.js';
import { prepareTranscriptDir } from '../transcript-dir.js';
import {
  hasResumableTranscript,
  readLastTurnUuid,
  waitForTranscriptUuid,
} from '../turn-end-uuid.js';

// ---------------------------------------------------------------------------
// TASK-994 — the agent-files guards (design §11), checked against the REAL
// `claude` binary. No network and no key: a scripted local Anthropic-compatible
// server answers the CLI and records every request body it sends.
//
// The layout is production's. The agent's home (`files/`, which is `/files` in
// production) is the CLI's HOME and cwd. CLAUDE_CONFIG_DIR is a runner-private
// directory outside it (k8s: /home/runner/.ax/session). The transcripts root is
// `AX_TRANSCRIPTS_ROOT` (k8s: /tmp/transcripts), laid down by the same
// `prepareTranscriptDir` the runner calls. The env is built in main.ts's order,
// from the same helpers.
//
// What this pins:
//   1. A fresh session writes nothing into the agent's home. The SDK's own state
//      (`.claude.json`, backups, sessions, transcripts) follows
//      CLAUDE_CONFIG_DIR, and the transcript lands in the transcripts root.
//   2. A session resumes in a fresh pod from the transcript the runner restored.
//   3. Files the agent plants in its home (CLAUDE.md, settings hooks, `.mcp.json`
//      and `.claude.json` MCP servers, skills) have no effect.
//   4. Two controls, which make the same plants live by removing one protection
//      each: the 'project' setting source, and an unset CLAUDE_CONFIG_DIR (the
//      startup guard refuses that one). They show the canary is not vacuous.
//
// Skips itself when the platform's native binary is not installed. CI (Linux)
// is the authoritative run for the strict empty-home assertion.
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

/** The one Bash call the scripted model makes in the Bash turn. */
const BASH_TOOL_USE_ID = 'toolu_t994';
const BASH_ECHO = 't994-bash-ran';

const CANARY = {
  soul: 'CANARY-SOUL-7f3a',
  claudeMd: 'CANARY-CLAUDEMD-91bc',
  dotClaudeMd: 'CANARY-DOTCLAUDE-55aa',
  skill: 'CANARY-SKILL-3c1d',
} as const;

/**
 * macOS only. The one write the CLI makes into HOME there (measured 2026-10-30,
 * SDK 0.2.119) is its env-paths cache: MCP logs under
 * `HOME/Library/Caches/claude-cli-nodejs/<cwd-slug>/mcp-logs-<server>/`, written
 * whenever any MCP server is configured (main.ts always configures two). On
 * Linux the same cache follows XDG_CACHE_HOME, which `buildToolCacheEnv` points
 * at the scratch tier. So Linux gets NO allowance: a new Linux entry in the
 * agent's home is a production finding. Redirect it the way XDG_CACHE_HOME is
 * redirected; never add it here.
 */
const DARWIN_ENV_PATHS_CACHE = 'Library/Caches/claude-cli-nodejs/';
function withoutDarwinEnvPathsCache(entries: string[]): string[] {
  if (process.platform !== 'darwin') return entries;
  return entries.filter(
    (e) => e !== 'Library/' && e !== 'Library/Caches/' && !e.startsWith(DARWIN_ENV_PATHS_CACHE),
  );
}

type Sse = (event: string, data: unknown) => void;

let server: http.Server;
let baseUrl: string;
/** Every request body the CLI sent in this case, to any path, in order. */
let bodies: string[];
/** Agent-loop model calls (those carrying `tools`) in the current run. */
let agentCalls: number;
/** The current run's first agent-loop call answers with one Bash tool call. */
let bashOnFirstCall: boolean;

let root: string;
/** The agent's home: the CLI's HOME and cwd (`/files` in production). */
let files: string;
/** Where planted hooks and MCP servers leave evidence. Outside `files`. */
let markers: string;
/** darwin only: holds a `security` stub (see `productionEnv`). */
let stubBin: string | undefined;

/** One pod's runner-private directories. Only `files` is shared between pods. */
interface Pod {
  /** CLAUDE_CONFIG_DIR (k8s: /home/runner/.ax/session). */
  cfg: string;
  /** AX_TRANSCRIPTS_ROOT (k8s: /tmp/transcripts). */
  transcripts: string;
  /** AX_EPHEMERAL_ROOT: the scratch tier the tool caches go to. */
  scratch: string;
  /** The sandbox's own temp dir. */
  tmp: string;
}

async function newPod(name: string): Promise<Pod> {
  const base = path.join(root, name);
  const pod: Pod = {
    cfg: path.join(base, 'runner-home', '.ax', 'session'),
    transcripts: path.join(base, 'transcripts'),
    scratch: path.join(base, 'scratch'),
    tmp: path.join(base, 'tmp'),
  };
  // The installed-skills projection lives here in production; empty in this test.
  await fs.mkdir(path.join(pod.cfg, 'skills'), { recursive: true });
  await fs.mkdir(pod.scratch, { recursive: true });
  await fs.mkdir(pod.tmp, { recursive: true });
  // What the runner's afterMaterialize does before the SDK starts.
  await prepareTranscriptDir({ claudeConfigDir: pod.cfg, transcriptsRoot: pod.transcripts });
  return pod;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-t994-sdk-'));
  files = path.join(root, 'files');
  markers = path.join(root, 'markers');
  await fs.mkdir(files);
  await fs.mkdir(markers);
  stubBin = undefined;
  if (process.platform === 'darwin') {
    stubBin = path.join(root, 'stub-bin');
    await fs.mkdir(stubBin);
    await fs.writeFile(path.join(stubBin, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o755 });
  }
  bodies = [];
  agentCalls = 0;
  bashOnFirstCall = false;

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      bodies.push(body);
      let parsed: { tools?: unknown[]; model?: string } = {};
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
      if (agentLoop) agentCalls += 1;
      if (agentLoop && agentCalls === 1 && bashOnFirstCall) {
        sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: BASH_TOOL_USE_ID, name: 'Bash', input: {} } });
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `echo ${BASH_ECHO}` }) } });
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
  await fs.rm(root, { recursive: true, force: true });
});

/** The SDK subprocess env, layered in main.ts's order from the same helpers. */
function productionEnv(pod: Pod): Record<string, string> {
  return {
    ...buildTtyHintEnv(),
    // macOS only: the CLI may ask `security` for a stored sign-in, and the real
    // one reads the login keychain under HOME (and can block on a prompt). A
    // sandbox has no keychain, so a stub that answers "not found" is faithful.
    PATH: stubBin !== undefined ? `${stubBin}:${process.env.PATH ?? ''}` : process.env.PATH ?? '',
    // The sandbox's temp dir, outside the agent's home (a forwarded TMPDIR in
    // production). Keeps the CLI's temp files inside this case's directory.
    TMPDIR: pod.tmp,
    ...buildTelemetryEnv(),
    HOME: files,
    CLAUDE_CONFIG_DIR: pod.cfg,
    ...buildToolCacheEnv(pod.scratch),
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: 'sk-ant-fake-for-a-local-scripted-server',
  };
}

/** The `query()` options main.ts builds, minus the runner's IPC-backed hooks. */
function productionOptions(pod: Pod): Options {
  return {
    settingSources: ['user'],
    cwd: files,
    additionalDirectories: [pod.scratch],
    model: 'claude-sonnet-4-5',
    allowedTools: ['Skill'],
    disallowedTools: [...DISABLED_BUILTINS],
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    mcpServers: {
      [MCP_HOST_SERVER_NAME]: createSdkMcpServer({ name: MCP_HOST_SERVER_NAME, version: '0', tools: [] }),
      [MCP_SANDBOX_SERVER_NAME]: createSdkMcpServer({ name: MCP_SANDBOX_SERVER_NAME, version: '0', tools: [] }),
    },
    // main.ts passes the composed prompt as a plain string.
    systemPrompt: 'You are an AX agent.',
    env: productionEnv(pod),
  };
}

/**
 * The canary and both controls run with every permission check bypassed: "no
 * effect even under bypass" is the stronger claim, and it is the mode in which
 * the controls were measured to go live (a prompt-based mode may hold a project
 * `.mcp.json` server back for approval, which would make a control vacuous).
 */
function underBypass(options: Options): Options {
  const { allowedTools: _allowed, canUseTool: _canUse, ...rest } = options;
  return { ...rest, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true };
}

interface Run {
  messages: SDKMessage[];
  /** Request bodies the CLI sent during this run only. */
  bodies: string[];
}

/** One turn through the real CLI. Returns only after the CLI has exited. */
async function runTurn(options: Options, prompt: string, opts: { bash?: boolean } = {}): Promise<Run> {
  bashOnFirstCall = opts.bash === true;
  agentCalls = 0;
  const from = bodies.length;
  async function* userMessages(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: prompt } } as SDKUserMessage;
  }
  const processes = createInterruptProcesses();
  const cli: { exited?: Promise<void> } = {};
  const q = query({
    prompt: userMessages(),
    options: {
      ...options,
      spawnClaudeCodeProcess: (spawnOptions) => {
        const child = processes.spawn(spawnOptions);
        cli.exited = new Promise<void>((r) => child.once('exit', () => r()));
        return child;
      },
    },
  });
  const messages: SDKMessage[] = [];
  let exitedInTime = false;
  try {
    for await (const m of q) {
      messages.push(m);
      if (m.type === 'result') break;
    }
  } finally {
    // close() ends the CLI's stdin; it then flushes its session files and
    // exits on its own (the SDK sends SIGTERM after 2 s, SIGKILL 5 s later).
    // Every assertion after this reads what the CLI wrote, so wait for it.
    q.close();
    let timer: NodeJS.Timeout | undefined;
    exitedInTime = await Promise.race([
      (cli.exited ?? Promise.resolve()).then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), 15_000);
      }),
    ]);
    clearTimeout(timer);
  }
  if (cli.exited === undefined) throw new Error('the SDK never spawned the claude CLI');
  if (!exitedInTime) {
    throw new Error('the claude CLI was still running 15 s after close(); not asserting on files it may still be writing');
  }
  return { messages, bodies: bodies.slice(from) };
}

function initOf(run: Run): SDKSystemMessage {
  const init = run.messages.find(
    (m): m is SDKSystemMessage => m.type === 'system' && m.subtype === 'init',
  );
  if (init === undefined) throw new Error('the CLI sent no system/init message');
  return init;
}

function resultOf(run: Run): SDKResultMessage {
  const result = run.messages.find((m): m is SDKResultMessage => m.type === 'result');
  if (result === undefined) throw new Error('the CLI sent no result message');
  return result;
}

/** The uuid of the turn's last assistant message: the line the runner waits for. */
function lastAssistantUuid(run: Run): string {
  const assistants = run.messages.filter((m) => m.type === 'assistant');
  const last = assistants[assistants.length - 1];
  if (last === undefined) throw new Error('the CLI sent no assistant message');
  return last.uuid;
}

/** The scripted Bash call's result, as the CLI handed it back to the model. */
function bashToolResult(run: Run): { is_error?: boolean; content?: unknown } | undefined {
  for (const m of run.messages) {
    if (m.type !== 'user' || !Array.isArray(m.message.content)) continue;
    for (const block of m.message.content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
      if (block.type === 'tool_result' && block.tool_use_id === BASH_TOOL_USE_ID) return block;
    }
  }
  return undefined;
}

/** Every path under `dir`, relative and sorted. Directories end in '/', symlinks in '@'. */
async function listTree(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      out.push(`${p}/`, ...(await listTree(dir, p)));
    } else {
      out.push(e.isSymbolicLink() ? `${p}@` : p);
    }
  }
  return out.sort();
}

/**
 * What an agent could leave in its own home, aimed at every config loader the
 * SDK has. Returns relative path → content.
 */
async function plantCanaries(): Promise<Map<string, string>> {
  const hook = (event: string) => ({
    hooks: [{ type: 'command', command: `touch '${path.join(markers, `settings-${event}`)}'` }],
  });
  // Not a real MCP server: it leaves a marker the moment it is spawned, then
  // exits so the CLI is not left waiting on a handshake.
  const stdioServer = (marker: string) => ({
    type: 'stdio',
    command: '/bin/sh',
    args: ['-c', `touch '${path.join(markers, marker)}'; sleep 1`],
  });
  const plants = new Map<string, string>([
    ['.ax/SOUL.md', `${CANARY.soul}\n`],
    ['CLAUDE.md', `${CANARY.claudeMd}\n`],
    ['.claude/CLAUDE.md', `${CANARY.dotClaudeMd}\n`],
    ['.claude/settings.json', JSON.stringify({
      hooks: {
        SessionStart: [hook('SessionStart')],
        UserPromptSubmit: [hook('UserPromptSubmit')],
        Stop: [hook('Stop')],
      },
    })],
    ['.mcp.json', JSON.stringify({ mcpServers: { canaryproj: stdioServer('mcp-json-spawned') } })],
    ['.claude.json', JSON.stringify({ mcpServers: { canaryhome: stdioServer('claude-json-spawned') } })],
    ['.claude/skills/canary-skill/SKILL.md', `---\nname: canary-skill\ndescription: ${CANARY.skill}\n---\nPlanted by the agent.\n`],
  ]);
  for (const [rel, content] of plants) {
    await fs.mkdir(path.dirname(path.join(files, rel)), { recursive: true });
    await fs.writeFile(path.join(files, rel), content);
  }
  return plants;
}

/** The listing `listTree` gives for exactly these files and their parent dirs. */
function treeOf(relFiles: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const rel of relFiles) {
    out.add(rel);
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) out.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [...out].sort();
}

/** A marker the CLI's children leave. Polls briefly: an MCP child runs on its own clock. */
async function markerExists(name: string): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await fs.stat(path.join(markers, name));
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

describe.skipIf(!HAVE_BINARY)('agent files §11 guards on the real claude-sdk binary (TASK-994)', () => {
  it('a fresh session leaves the agent home empty and writes its transcript into the transcripts root', async () => {
    const pod = await newPod('pod');
    const run = await runTurn(productionOptions(pod), 'say hi from the shell', { bash: true });

    expect(resultOf(run).subtype).toBe('success');
    // The Bash tool really ran, so this measures a turn that used the shell.
    const bash = bashToolResult(run);
    expect(bash?.is_error ?? false).toBe(false);
    expect(JSON.stringify(bash?.content)).toContain(BASH_ECHO);

    const sid = initOf(run).session_id;
    const uuid = lastAssistantUuid(run);
    expect(await waitForTranscriptUuid(pod.transcripts, sid, uuid, { timeoutMs: 10_000, intervalMs: 50 })).toBe(true);
    expect(await readLastTurnUuid(pod.transcripts, sid, 'assistant')).toBe(uuid);
    expect((await locateJsonl(pod.transcripts, sid))!.startsWith(pod.transcripts + path.sep)).toBe(true);
    // The CLI wrote THROUGH the link; it did not replace it with a directory.
    expect(await fs.readlink(path.join(pod.cfg, 'projects'))).toBe(pod.transcripts);

    expect(withoutDarwinEnvPathsCache(await listTree(files))).toEqual([]);
  }, 60_000);

  it('a resumed session in a fresh pod finds the transcript the runner restored', async () => {
    const podA = await newPod('pod-a');
    const first = await runTurn(productionOptions(podA), 'remember PINEAPPLE-42');
    expect(resultOf(first).subtype).toBe('success');
    const sid = initOf(first).session_id;
    const bytes = await createJsonlTranscriptSource(podA.transcripts, files).read(sid);
    expect(bytes).not.toBeNull();

    // Pod B starts with empty runner-private dirs; only the agent's home is
    // shared. The runner restores the transcript from the host store into B's
    // transcripts root, then resumes.
    const podB = await newPod('pod-b');
    expect(await createJsonlTranscriptSource(podB.transcripts, files).write(sid, bytes!)).toBe('accepted');
    expect(await hasResumableTranscript(podB.transcripts, sid)).toBe(true);

    const second = await runTurn({ ...productionOptions(podB), resume: sid }, 'what did I ask you to remember?');
    expect(resultOf(second).subtype).toBe('success');
    // B's own prompt does not carry the token; only the restored transcript does.
    expect(second.bodies.some((b) => b.includes('PINEAPPLE-42'))).toBe(true);
  }, 60_000);

  it('files the agent planted in its home reach neither the prompt nor settings, hooks or MCP servers', async () => {
    const pod = await newPod('pod');
    const planted = await plantCanaries();
    const run = await runTurn(underBypass(productionOptions(pod)), 'hello');

    expect(resultOf(run).subtype).toBe('success');
    const leaked = Object.values(CANARY).filter((c) => run.bodies.some((b) => b.includes(c)));
    expect(leaked).toEqual([]);
    expect(await fs.readdir(markers)).toEqual([]);
    const init = initOf(run);
    const servers = init.mcp_servers.map((s) => s.name);
    expect(servers).not.toContain('canaryproj');
    expect(servers).not.toContain('canaryhome');
    expect(init.skills).not.toContain('canary-skill');

    // The CLI wrote nothing into the home and changed nothing it found there.
    expect(withoutDarwinEnvPathsCache(await listTree(files))).toEqual(treeOf(planted.keys()));
    for (const [rel, content] of planted) {
      expect(await fs.readFile(path.join(files, rel), 'utf8')).toBe(content);
    }
  }, 60_000);

  it("control: the 'project' setting source makes the same plants live", async () => {
    const pod = await newPod('pod');
    await plantCanaries();
    const run = await runTurn({ ...underBypass(productionOptions(pod)), settingSources: ['user', 'project'] }, 'hello');

    expect(run.bodies.some((b) => b.includes(CANARY.claudeMd))).toBe(true);
    expect(await markerExists('settings-UserPromptSubmit')).toBe(true);
    expect(await markerExists('mcp-json-spawned')).toBe(true);
  }, 60_000);

  // This control is why the runner refuses to start without CLAUDE_CONFIG_DIR
  // (config-dir-guard.ts in @ax/agent-runner-core).
  it('control: without CLAUDE_CONFIG_DIR the SDK reads and writes the agent home', async () => {
    const pod = await newPod('pod');
    await plantCanaries();
    const options = underBypass(productionOptions(pod));
    const { CLAUDE_CONFIG_DIR: _configDir, ...env } = options.env ?? {};
    const run = await runTurn({ ...options, env }, 'hello');

    expect(await markerExists('claude-json-spawned')).toBe(true);
    expect(await markerExists('settings-UserPromptSubmit')).toBe(true);
    expect(run.bodies.some((b) => b.includes(CANARY.dotClaudeMd))).toBe(true);
    expect(initOf(run).skills).toContain('canary-skill');
    expect(await listTree(files)).toContain('.claude/projects/');
  }, 60_000);
});
