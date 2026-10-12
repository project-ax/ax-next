import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createLocalDispatcher,
  readRunnerEnv,
  runnerHomeDir,
  type LoopContext,
  type RunnerDeps,
} from '@ax/agent-runner-core';
import type { IpcClient } from '@ax/ipc-protocol';
import { createClaudeSdkLoop } from '../main.js';

// ---------------------------------------------------------------------------
// W2 (shared folders, spec §3.6) — do Claude's OWN Read and Edit tools actually
// work on a shared path? Checked against the REAL `claude` binary, driven by
// the runner's REAL loop (`createClaudeSdkLoop`) — same harness shape as
// shared-folders-real-sdk.e2e.test.ts / fold-replay-real-sdk.e2e.test.ts: a
// scripted local Anthropic-compatible server, no network, no key.
//
// main.test.ts pins the OPTION LIST (`additionalDirectories` carries the shared
// path) against a mocked `query()`. That says nothing about whether the CLI's
// built-in file tools then honour it, so this suite closes the gap end to end:
//
//   env (AX_SHARED_FOLDERS, parsed by the real `readRunnerEnv`)
//     -> createClaudeSdkLoop's real `query()` options (default permission mode,
//        the real PreToolUse/PostToolUse hooks and canUseTool; only the IPC
//        client behind them is a stub that allows every `tool.pre-call`)
//     -> the real bundled binary
//     -> a scripted model that calls `Read` and then `Edit` on
//        `<sharedFolder>/note.md`.
//
// cwd and HOME are the agent's own files dir, exactly as in production
// (`runnerHomeDir`): the shared folder is a file-tool root ONLY.
//
// The `query()` wrapper below only RECORDS the options the loop built and then
// calls the real SDK — it changes nothing.
//
// WHAT THE CONTROL IS (and is not). The obvious control — "without the folder in
// `additionalDirectories` the tool is blocked" — does NOT hold in the runner's
// real configuration, so it is not here. Measured against the pinned CLI
// (2026-10-12) with a direct `query()` matrix (default permission mode,
// canUseTool, a PreToolUse hook): the CLI's own permission check does honour
// `additionalDirectories` (no hook: Read of a path inside is auto-allowed, outside
// it goes to canUseTool and is blocked when that denies) — but the runner's
// PreToolUse hook answers every host-allowed call with `permissionDecision:
// 'allow'`, and with that the CLI skips the directory check entirely: Read and
// Edit succeed on the shared path with or without the grant, whatever canUseTool
// says. So in production the grant is not what lets these tools through; the
// host's `tool.pre-call` verdict is the gate, and the file tools are bounded by
// the sandbox's mounts, not by the SDK. That is why the test asserts the option
// (what the runner builds) AND the outcome (what the tools do) separately, and
// why the control below flips the one thing that DOES decide the outcome: the
// host's verdict.
//
// Skips itself when the platform's native binary is not installed.
// ---------------------------------------------------------------------------

const { queryOptions } = vi.hoisted(() => ({
  queryOptions: [] as Array<Record<string, unknown>>,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: (params: Parameters<typeof actual.query>[0]) => {
      queryOptions.push((params.options ?? {}) as Record<string, unknown>);
      return actual.query(params);
    },
  };
});

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

const MARKER = 'AXW2NOTEMARKER5d2c';
const REPLACEMENT = 'AXW2EDITEDMARKER8e41';
const READ_ID = 'toolu_read_shared';
const EDIT_ID = 'toolu_edit_shared';
const FOLDER_ID = 'sf_e2e';

type Sse = (event: string, data: unknown) => void;
type Step = (sse: Sse) => void;

let server: http.Server;
let baseUrl: string;
let tmp: string;
let files: string;
let shared: string;
let notePath: string;
let keychainStubDir: string | undefined;
/** Agent-loop model calls (requests that carry a tool list), parsed, in order. */
let agentRequests: Array<{ messages?: Array<{ role?: string; content?: unknown }> }>;
let script: Step[];
/** What the runner's PreToolUse hook sent to the (stub) host as `tool.pre-call`. */
let preCalls: Array<{ name: string; input: Record<string, unknown> }>;

beforeEach(async () => {
  // realpath: on macOS os.tmpdir() sits behind the /var -> /private/var link,
  // and production paths are real ones.
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-shared-tools-')));
  files = path.join(tmp, 'files');
  shared = path.join(tmp, 'shared', FOLDER_ID);
  notePath = path.join(shared, 'note.md');
  await fs.mkdir(files, { recursive: true });
  await fs.mkdir(path.join(tmp, 'agent'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'ephemeral'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'cfg'), { recursive: true });
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(notePath, `# note\nthe secret is ${MARKER}\n`);
  keychainStubDir = undefined;
  if (process.platform === 'darwin') {
    // See connector-mcp-real-sdk.e2e.test.ts: a sandbox has no login keychain,
    // and `security` can block on a prompt. A stub that says "not found" is the
    // faithful setup.
    keychainStubDir = path.join(tmp, 'bin');
    await fs.mkdir(keychainStubDir);
    await fs.writeFile(path.join(keychainStubDir, 'security'), '#!/bin/sh\nexit 44\n', { mode: 0o755 });
  }

  agentRequests = [];
  script = [];
  preCalls = [];
  queryOptions.length = 0;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      let parsed: { tools?: unknown[]; messages?: Array<{ role?: string; content?: unknown }>; model?: string } = {};
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
      const sse: Sse = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      sse('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: parsed.model ?? 'claude-sonnet-4-5',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
        },
      });
      // Side calls (title generation and the like) carry no tool list.
      const isAgentLoop = (parsed.tools ?? []).length > 0;
      let step: Step = textStep('ok');
      if (isAgentLoop) {
        agentRequests.push({ messages: parsed.messages });
        step = script[agentRequests.length - 1] ?? textStep('done');
      }
      step(sse);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

function textStep(text: string): Step {
  return (sse) => {
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    sse('message_stop', { type: 'message_stop' });
  };
}

function toolStep(id: string, name: string, input: Record<string, unknown>): Step {
  return (sse) => {
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } });
    sse('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    });
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
    sse('message_stop', { type: 'message_stop' });
  };
}

/** Everything the CLI handed back to the model as a tool_result, by tool_use id. */
function toolResults(): Map<string, { text: string; isError: boolean }> {
  const out = new Map<string, { text: string; isError: boolean }>();
  for (const req of agentRequests) {
    for (const msg of req.messages ?? []) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const c = block.content;
        const text = typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? (c as Array<{ type?: string; text?: string }>).map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('\n')
            : '';
        out.set(block.tool_use_id, { text, isError: block.is_error === true });
      }
    }
  }
  return out;
}

/**
 * One turn through the runner's real claude-sdk loop. `rejectToolCalls` makes the
 * stub host answer every `tool.pre-call` with a reject instead of an allow — the
 * one thing that differs in the control below.
 */
async function runLoopTurn(opts: { rejectToolCalls?: boolean } = {}): Promise<void> {
  // The real env parser, so the AX_SHARED_FOLDERS -> env.sharedFolders step is
  // the production one rather than a hand-built object.
  const env = readRunnerEnv({
    AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
    AX_SESSION_ID: 'sess-shared-tools',
    AX_AUTH_TOKEN: 'tok-123',
    AX_WORKSPACE_ROOT: path.join(tmp, 'agent'),
    AX_EPHEMERAL_ROOT: path.join(tmp, 'ephemeral'),
    AX_USERFILES_ROOT: files,
    AX_PROXY_ENDPOINT: 'http://127.0.0.1:8443',
    AX_PROXY_TOKEN: 'feedfacefeedfacefeedfacefeedface',
    AX_SHARED_FOLDERS: JSON.stringify([{ id: FOLDER_ID, path: shared, readOnly: false }]),
  });

  // Every `tool.pre-call` is recorded and, by default, allowed (this suite is
  // about the CLI's file tools, not host policy).
  const client = {
    call: async (action: string, payload: unknown): Promise<unknown> => {
      if (action === 'tool.pre-call') {
        const call = (payload as { call: { name: string; input: Record<string, unknown> } }).call;
        preCalls.push({ name: call.name, input: call.input });
        return opts.rejectToolCalls === true
          ? { verdict: 'reject', reason: 'blocked by the control' }
          : { verdict: 'allow' };
      }
      throw new Error(`unexpected IPC call in this test: ${action}`);
    },
    event: async (): Promise<void> => undefined,
    close: async (): Promise<void> => undefined,
  } as unknown as IpcClient;

  const deps = {
    client,
    env,
    agentConfig: {
      displayName: 'A',
      systemPromptAugment: '',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'anthropic/claude-sonnet-4-5',
      runner: 'claude-sdk',
    },
    tools: [],
    localDispatcher: createLocalDispatcher(),
    flushWorkspaceForHostTool: async () => ({ outcome: 'noop' }),
    proxyStartup: {
      providerEnv: {
        // The shape the runner asserts, pointed at the scripted server.
        ANTHROPIC_API_KEY: 'ax-cred:0123456789abcdef0123456789abcdef',
        ANTHROPIC_BASE_URL: baseUrl,
        CLAUDE_CONFIG_DIR: path.join(tmp, 'cfg'),
        PATH: `${keychainStubDir !== undefined ? `${keychainStubDir}:` : ''}${process.env.PATH ?? ''}`,
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
    pythonVenvReady: false,
    homeDir: runnerHomeDir(env),
    systemPrompt: 'You are a test agent.',
    resumeSessionId: null,
  } as unknown as RunnerDeps;

  // One user message; the loop's inbox then blocks until the turn has ended,
  // after which it reports "cancelled" so the SDK drains and `run` returns.
  let turnEnded: () => void = () => undefined;
  const turnDone = new Promise<void>((r) => (turnEnded = r));
  let pulled = 0;
  let sessionId: string | null = null;
  const ctx: LoopContext = {
    nextMessage: async () => {
      pulled += 1;
      if (pulled === 1) return { id: randomUUID(), content: 'read note.md, then edit it' };
      await turnDone;
      return null;
    },
    onInterrupt: () => () => undefined,
    emitChunk: async () => undefined,
    endTurn: async () => {
      turnEnded();
    },
    replaceTranscript: async () => undefined,
    recordAssistantText: () => undefined,
    getTranscriptSessionId: () => sessionId,
    setTranscriptSessionId: (id) => {
      sessionId = id;
    },
    markMessageConsumed: () => undefined,
  };

  const code = await createClaudeSdkLoop(deps).run(ctx);
  expect(code).toBe(0);
}

describe.skipIf(!HAVE_BINARY)("Claude's own Read and Edit tools on a shared folder — real SDK binary, real runner loop (W2)", () => {
  it('Read returns the file and Edit rewrites it, with the folder granted only as an additional directory', async () => {
    script = [
      toolStep(READ_ID, 'Read', { file_path: notePath }),
      toolStep(EDIT_ID, 'Edit', { file_path: notePath, old_string: MARKER, new_string: REPLACEMENT }),
      textStep('done'),
    ];
    await runLoopTurn();

    // The options the runner's real code built: the shared folder is a file-tool
    // root and nothing more.
    expect(queryOptions).toHaveLength(1);
    const options = queryOptions[0] as {
      cwd: string;
      additionalDirectories?: string[];
      settingSources?: string[];
      env: Record<string, string | undefined>;
    };
    expect(options.additionalDirectories).toContain(shared);
    expect(options.cwd).toBe(files);
    expect(options.env.HOME).toBe(files);
    expect(options.cwd).not.toBe(shared);
    expect(options.env.HOME).not.toBe(shared);
    expect(options.settingSources).toEqual(['user']);

    // The model's three calls all happened (Read, Edit, then the closing text)...
    expect(agentRequests).toHaveLength(3);
    // ...and the real PreToolUse hook saw both tools with the shared path intact
    // (the governed-path re-rooter must leave it alone).
    expect(preCalls.map((c) => [c.name, c.input.file_path])).toEqual([
      ['Read', notePath],
      ['Edit', notePath],
    ]);

    const results = toolResults();
    // Read worked: the file's real content came back to the model.
    const read = results.get(READ_ID);
    expect(read, 'the model received a tool_result for Read').toBeDefined();
    expect(read!.isError).toBe(false);
    expect(read!.text).toContain(MARKER);
    // Edit worked: the CLI reported success and the bytes on disk changed.
    const edit = results.get(EDIT_ID);
    expect(edit, 'the model received a tool_result for Edit').toBeDefined();
    expect(edit!.isError).toBe(false);
    const onDisk = await fs.readFile(notePath, 'utf8');
    expect(onDisk).toContain(REPLACEMENT);
    expect(onDisk).not.toContain(MARKER);
  }, 90_000);

  // The control: it can fail. The same session, the same scripted model, the
  // same shared folder — but the host rejects the tool calls. The CLI then
  // never runs the tools, so no marker reaches the model and the file is
  // untouched; the assertions in the test above would catch that.
  it('control: when the host rejects the calls, Read returns nothing and Edit changes nothing', async () => {
    script = [
      toolStep(READ_ID, 'Read', { file_path: notePath }),
      toolStep(EDIT_ID, 'Edit', { file_path: notePath, old_string: MARKER, new_string: REPLACEMENT }),
      textStep('done'),
    ];
    await runLoopTurn({ rejectToolCalls: true });

    // The host saw (and rejected) the Read. The CLI refuses the Edit on its own,
    // before any hook, because the file was never read — so no second pre-call.
    expect(preCalls.map((c) => c.name)).toEqual(['Read']);
    const results = toolResults();
    const read = results.get(READ_ID);
    expect(read).toBeDefined();
    expect(read!.isError).toBe(true);
    expect(read!.text).toContain('blocked by the control');
    expect(read!.text).not.toContain(MARKER);
    const edit = results.get(EDIT_ID);
    expect(edit).toBeDefined();
    expect(edit!.isError).toBe(true);
    expect(await fs.readFile(notePath, 'utf8')).toBe(`# note\nthe secret is ${MARKER}\n`);
  }, 90_000);
});
