import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IpcClient, IpcClientOptions } from '@ax/ipc-protocol';
import type { InboxLoopEntry } from '@ax/agent-runner-core';

// ---------------------------------------------------------------------------
// Runner-side parity suite (design §8).
//
// The canary in @ax/cli proves the HOST-side half — that an agent's runner id
// resolves to a binary and reaches `sandbox:open-session` — but it swaps in a
// stub runner, so it says nothing about what this runner actually does. This
// suite drives the REAL `runRunner` shell and the REAL loop against a scripted
// `MockLanguageModelV4` and a fake IPC client, one assertion per parity row.
//
// Deliberately NOT mocked, so the test exercises them for real: the shell's
// whole boot sequence, `setupProxy`, the prompt engine, the skills projection
// walk, the tool policy, the transcript delta-ship, and the turn-end events.
// Mocked only where the test would otherwise need a real git repo, a real
// venv, a real socket, or a real provider: git-workspace, python-venv,
// inbox-loop, `createIpcClient`, and `resolveModel`.
// ---------------------------------------------------------------------------

type FakeClient = {
  call: Mock;
  callGet: Mock;
  callBinary: Mock;
  callBinaryUpload: Mock;
  event: Mock;
  close: Mock;
} & IpcClient;

let fakeClient: FakeClient;
let inboxEntries: InboxLoopEntry[];
/** Every `client.event(...)` the run produced, in order. */
let events: Array<{ name: string; payload: Record<string, unknown> }>;
/** Every `client.call(...)`, in order. */
let calls: Array<{ action: string; payload: unknown }>;
/** Transcript bytes the runner shipped via `session.append-transcript`. */
let shippedTranscript: Buffer[];
/** What `session.get-transcript` hands back on a resume. */
let storedTranscript: Buffer;
/** The `session.get-config` response the shell reads at boot. */
let sessionConfig: Record<string, unknown>;
/** The `tool.list` catalog. */
let toolCatalog: unknown[];
/** Verdicts keyed by tool name for `tool.pre-call`. */
let preCallVerdicts: Record<string, { verdict: 'allow' | 'reject'; reason?: string }>;
/** Hosts `proxy.drain-egress-blocks` reports. */
let egressBlockedHosts: string[];
/** What `attachments.list` reports, and the bytes `blob.get` serves for each. */
let uploadedFiles: Array<{
  path: string;
  sha256: string;
  mediaType: string;
  displayName: string;
  sizeBytes: number;
}>;
let blobBytes: Map<string, Buffer>;

vi.mock('@ax/ipc-protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ax/ipc-protocol')>();
  return {
    ...actual,
    createIpcClient: (_opts: IpcClientOptions): IpcClient => fakeClient,
  };
});

vi.mock('@ax/agent-runner-core/internal/git-workspace.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@ax/agent-runner-core/internal/git-workspace.js')>();
  return {
    ...actual,
    materializeWorkspace: vi.fn().mockResolvedValue({ baselineCommit: 'oid-0' }),
    scaffoldWorkspaceGitignore: vi.fn().mockResolvedValue(undefined),
    commitTurnAndBundle: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('@ax/agent-runner-core/internal/python-venv.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@ax/agent-runner-core/internal/python-venv.js')>();
  return { ...actual, scaffoldPythonVenv: vi.fn().mockResolvedValue(false) };
});

vi.mock('@ax/agent-runner-core/internal/inbox-loop.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@ax/agent-runner-core/internal/inbox-loop.js')>();
  return {
    ...actual,
    createInboxLoop: () => ({
      cursor: 0,
      next: async (): Promise<InboxLoopEntry> =>
        inboxEntries.shift() ?? { type: 'cancel' },
    }),
  };
});

// The provider is the ONE thing a unit test cannot have for real (it would
// need a network and a credential). `resolveModel` has its own suite; here we
// script the model so the loop's behaviour is deterministic.
const scriptedModel = vi.fn();
vi.mock('../provider.js', () => ({
  resolveModel: () => scriptedModel(),
  createProxyFetch: () => undefined,
}));

const { main } = await import('../main.js');
const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test');
const { decodeTranscript } = await import('../transcript-codec.js');

// ---------------------------------------------------------------------------
// Scripting the model
// ---------------------------------------------------------------------------

type Chunk = Record<string, unknown>;

const textStep = (text: string): Chunk[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r', modelId: 'm', timestamp: new Date(0) },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  },
];

const toolStep = (
  toolName: string,
  input: Record<string, unknown>,
  id = 'c1',
): Chunk[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r', modelId: 'm', timestamp: new Date(0) },
  { type: 'tool-input-start', id, toolName },
  { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  {
    type: 'finish',
    // The V4 finish part carries `{unified, raw}`, not a bare string. A bare
    // string makes the SDK skip tool execution entirely and silently end the
    // turn — worth stating, because it is a 20-minute debugging hole.
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  },
];

/** Every prompt the model was handed, so a test can assert what it saw. */
let sentPrompts: unknown[];

/** Build a model that replays `steps` in order, one per provider call. */
function modelReplaying(steps: Chunk[][]): unknown {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      sentPrompts.push(prompt);
      const chunks = steps[i++];
      if (chunks === undefined) throw new Error('model script exhausted');
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  });
}

/** A model whose very first call fails — the provider-error parity row. */
function modelThatFails(message: string): unknown {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw new Error(message);
    },
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmp: string;
let workspaceRoot: string;
let configDir: string;
const ORIGINAL_ENV = process.env;

function userMessage(content: string): InboxLoopEntry {
  return {
    type: 'user-message',
    reqId: 'req-1',
    payload: { content, contentBlocks: [] },
  } as InboxLoopEntry;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-aisdk-parity-'));
  workspaceRoot = path.join(tmp, 'agent');
  configDir = path.join(tmp, 'config');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });

  events = [];
  calls = [];
  shippedTranscript = [];
  storedTranscript = Buffer.alloc(0);
  inboxEntries = [];
  toolCatalog = [];
  preCallVerdicts = {};
  egressBlockedHosts = [];
  uploadedFiles = [];
  blobBytes = new Map();
  sentPrompts = [];
  sessionConfig = {
    userId: 'u-1',
    agentId: 'a-1',
    agentConfig: {
      displayName: 'Parity Agent',
      systemPromptAugment: '',
      allowedTools: [],
      mcpConfigIds: [],
      model: 'anthropic/claude-sonnet-4-6',
      runner: 'aisdk',
    },
    conversationId: 'conv-1',
    runnerSessionId: null,
  };

  process.env = {
    ...ORIGINAL_ENV,
    AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
    AX_SESSION_ID: 'sess-1',
    AX_AUTH_TOKEN: 'tok-123',
    AX_WORKSPACE_ROOT: workspaceRoot,
    AX_PROXY_ENDPOINT: 'http://127.0.0.1:8443',
    ANTHROPIC_API_KEY: 'ax-cred:0123456789abcdef0123456789abcdef',
    CLAUDE_CONFIG_DIR: configDir,
    AX_VENV_READY_WAIT_MS: '0',
  };
  delete process.env.AX_INSTALLED_SKILLS_JSON;
  delete process.env.AX_USERFILES_ROOT;
  delete process.env.AX_EPHEMERAL_ROOT;

  fakeClient = {
    call: vi.fn(async (action: string, payload: unknown) => {
      calls.push({ action, payload });
      switch (action) {
        case 'session.get-config':
          return sessionConfig;
        case 'tool.list':
          return { tools: toolCatalog };
        case 'attachments.list':
          // Shape matters: `AttachmentsListResponseSchema` is `{ files: [...] }`.
          // An `{ attachments: [] }` fake parses as a FAILURE, and
          // materializeUploads swallows it — so the whole upload path silently
          // never ran and every row logged "attachments.list failed". Caught in
          // review; the row below now depends on this being right.
          return { files: uploadedFiles };
        case 'tool.pre-call': {
          const name = (payload as { call: { name: string } }).call.name;
          const v = preCallVerdicts[name];
          if (v?.verdict === 'reject') {
            return { verdict: 'reject', reason: v.reason ?? 'denied' };
          }
          return { verdict: 'allow' };
        }
        case 'tool.execute-host':
          return { output: 'host tool output' };
        case 'proxy.drain-egress-blocks':
          return { hosts: egressBlockedHosts };
        case 'conversation.store-runner-session':
          return {};
        default:
          throw new Error(`unexpected call: ${action}`);
      }
    }),
    callGet: vi.fn(),
    callBinary: vi.fn(async (action: string, payload: unknown) => {
      calls.push({ action, payload });
      if (action === 'blob.get') {
        const sha = (payload as { sha256: string }).sha256;
        const bytes = blobBytes.get(sha);
        if (bytes === undefined) throw new Error(`no blob for ${sha}`);
        const p = path.join(tmp, `blob-${sha}.bin`);
        await fs.writeFile(p, bytes);
        return { path: p, bytes: bytes.length };
      }
      if (action === 'session.get-transcript') {
        const p = path.join(tmp, `restore-${shippedTranscript.length}.bin`);
        await fs.writeFile(p, storedTranscript);
        return { path: p, bytes: storedTranscript.length };
      }
      // workspace.materialize
      const p = path.join(tmp, 'bundle.bin');
      await fs.writeFile(p, '');
      return { path: p, bytes: 0 };
    }),
    callBinaryUpload: vi.fn(async (action: string, body: Buffer) => {
      calls.push({ action, payload: undefined });
      shippedTranscript.push(Buffer.from(body));
      return { outcome: 'appended', maxSeq: 1 };
    }),
    event: vi.fn(async (name: string, payload: Record<string, unknown>) => {
      events.push({ name, payload });
    }),
    close: vi.fn(async () => undefined),
  } as unknown as FakeClient;
});

afterEach(async () => {
  process.env = ORIGINAL_ENV;
  vi.clearAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Install a skill into the read-only projection the runner discovers. */
async function installSkill(
  id: string,
  frontmatter: string,
  body: string,
  opts: { mcp?: boolean } = {},
): Promise<void> {
  const dir = path.join(configDir, 'skills', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\n${frontmatter}\n---\n\n${body}\n`,
  );
  if (opts.mcp === true) {
    await fs.writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { demo: { command: 'demo', args: [] } } }),
    );
  }
}

const turnEnds = (): Array<Record<string, unknown>> =>
  events.filter((e) => e.name === 'event.turn-end').map((e) => e.payload);
const chunks = (): Array<Record<string, unknown>> =>
  events.filter((e) => e.name === 'event.stream-chunk').map((e) => e.payload);
const chatEnd = (): Record<string, unknown> | undefined =>
  events.find((e) => e.name === 'event.chat-end')?.payload;
const shippedEntries = (): Array<{ role: string; message: unknown }> => {
  // The host's stored transcript is the CONCATENATION of every append body:
  // the first ship carries the whole file, later ships carry only the bytes
  // past `sentOffset`, and the final flush is usually an empty
  // prefix-integrity probe. Reassembling here is what the real store does.
  if (shippedTranscript.length === 0) return [];
  const decoded = decodeTranscript(Buffer.concat(shippedTranscript));
  if (!decoded.ok) throw new Error(`shipped transcript did not decode: ${decoded.reason}`);
  return decoded.entries.map((e) => ({ role: e.role, message: e.message }));
};

// ---------------------------------------------------------------------------
// The parity rows
// ---------------------------------------------------------------------------

describe('aisdk runner — parity', () => {
  it('runs a plain turn: streams, ships the transcript, emits turn-end and chat-end', async () => {
    scriptedModel.mockReturnValue(modelReplaying([textStep('hello there')]));
    inboxEntries = [userMessage('hi')];

    await expect(main()).resolves.toBe(0);

    // Live streaming reached the host.
    expect(chunks()).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'hello there', reqId: 'req-1' }),
    );

    // One assistant turn-end, carrying the turn's blocks and a turnId that
    // came from the in-memory transcript (no disk read, no flush wait).
    const assistantEnd = turnEnds().find((t) => t.role === 'assistant');
    expect(assistantEnd).toBeDefined();
    expect(assistantEnd!.contentBlocks).toEqual([
      { type: 'text', text: 'hello there' },
    ]);
    expect(assistantEnd!.turnId).toEqual(expect.any(String));
    expect(assistantEnd!.reqId).toBe('req-1');

    // The transcript shipped to the host holds the user turn and the reply.
    expect(shippedEntries().map((e) => e.role)).toEqual(['user', 'assistant']);

    expect(chatEnd()).toEqual({
      outcome: { kind: 'complete', messages: expect.any(Array) },
    });
  });

  it('routes a model tool call through tool.pre-call and back as a tool result', async () => {
    scriptedModel.mockReturnValue(
      modelReplaying([
        toolStep('Write', { file_path: path.join(workspaceRoot, 'a.txt'), content: 'x' }),
        textStep('wrote it'),
      ]),
    );
    inboxEntries = [userMessage('write a file')];

    await expect(main()).resolves.toBe(0);

    // The gate fired for the model's call, with the real tool name + input.
    const preCall = calls.find((c) => c.action === 'tool.pre-call');
    expect(preCall).toBeDefined();
    expect((preCall!.payload as { call: { name: string } }).call.name).toBe('Write');

    // The tool actually ran.
    await expect(
      fs.readFile(path.join(workspaceRoot, 'a.txt'), 'utf8'),
    ).resolves.toBe('x');

    // Both the tool turn-end and the assistant turn-end were emitted, tool first.
    const roles = turnEnds().map((t) => t.role);
    expect(roles).toEqual(['tool', 'assistant']);

    // The transcript holds the full multi-step turn — assistant(tool-call),
    // tool(result), assistant(text). `result.response.messages` alone would
    // have dropped the first two.
    expect(shippedEntries().map((e) => e.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('returns a policy veto as a tool result and keeps the turn alive', async () => {
    preCallVerdicts['Bash'] = {
      verdict: 'reject',
      reason: 'npm is not on the egress allowlist; use pnpm',
    };
    scriptedModel.mockReturnValue(
      modelReplaying([
        toolStep('Bash', { command: 'npm install' }),
        textStep('switching to pnpm'),
      ]),
    );
    inboxEntries = [userMessage('install deps')];

    // The turn does NOT abort — that is the whole point of returning a veto as
    // a result rather than throwing.
    await expect(main()).resolves.toBe(0);

    const toolResult = shippedEntries().find((e) => e.role === 'tool');
    expect(JSON.stringify(toolResult)).toContain('egress allowlist');
    // And the model got to respond after the denial.
    expect(chunks()).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'switching to pnpm' }),
    );
  });

  it('appends the egress-block remediation note after a Bash call', async () => {
    egressBlockedHosts = ['registry.npmjs.org'];
    scriptedModel.mockReturnValue(
      modelReplaying([toolStep('Bash', { command: 'echo hi' }), textStep('done')]),
    );
    inboxEntries = [userMessage('run something')];

    await expect(main()).resolves.toBe(0);

    const toolResult = shippedEntries().find((e) => e.role === 'tool');
    expect(JSON.stringify(toolResult)).toContain('registry.npmjs.org');
  });

  it('dispatches a catalog host tool over tool.execute-host', async () => {
    // Connector-backed MCP tools reach this runner exactly this way — they are
    // host-side in @ax/mcp-client and arrive as ordinary host descriptors.
    toolCatalog = [
      {
        name: 'linear_search',
        description: 'search linear',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        executesIn: 'host',
      },
    ];
    scriptedModel.mockReturnValue(
      modelReplaying([toolStep('linear_search', { q: 'bug' }), textStep('found it')]),
    );
    inboxEntries = [userMessage('search')];

    await expect(main()).resolves.toBe(0);

    const exec = calls.find((c) => c.action === 'tool.execute-host');
    expect(exec).toBeDefined();
    expect((exec!.payload as { call: { name: string; input: unknown } }).call).toMatchObject(
      { name: 'linear_search', input: { q: 'bug' } },
    );
  });

  // The upload + attachment-translation row. This one exercises the whole
  // chain for real: attachments.list -> blob.get -> materialize under
  // .ax/uploads/ -> the shell's translate pass (Anthropic-shaped blocks) ->
  // this runner's toUserModelMessage adapter -> an AI SDK image part in the
  // prompt the provider actually receives.
  //
  // It is also the row that a wrong-shaped `attachments.list` fake silently
  // disabled for the whole suite until review caught it.
  it('materializes an upload and hands the model a real image part', async () => {
    const png = Buffer.from('\u0089PNG\r\n\u001a\nfake-image-bytes', 'binary');
    const sha256 = createHash('sha256').update(png).digest('hex');
    const relPath = '.ax/uploads/conv-1/turn-1/shot.png';
    uploadedFiles = [
      {
        path: relPath,
        sha256,
        mediaType: 'image/png',
        displayName: 'shot.png',
        sizeBytes: png.length,
      },
    ];
    blobBytes.set(sha256, png);

    scriptedModel.mockReturnValue(modelReplaying([textStep('I see a screenshot')]));
    inboxEntries = [
      {
        type: 'user-message',
        reqId: 'req-1',
        payload: {
          content: 'what is this?',
          contentBlocks: [
            {
              type: 'attachment',
              path: relPath,
              displayName: 'shot.png',
              mediaType: 'image/png',
              sizeBytes: png.length,
            },
          ],
        },
      } as InboxLoopEntry,
    ];

    await expect(main()).resolves.toBe(0);

    // The bytes really landed on disk where the prompt says they are.
    const onDisk = await fs.readFile(path.join(workspaceRoot, relPath));
    expect(onDisk.equals(png)).toBe(true);

    // And the model was handed an AI SDK image part, not a text mention.
    const first = JSON.parse(JSON.stringify(sentPrompts[0]));
    const user = (first as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === 'user',
    );
    const parts = user?.content as Array<{ type: string; mediaType?: string }>;
    expect(parts.map((p) => p.type)).toContain('text');
    const image = parts.find((p) => p.type === 'file' || p.type === 'image');
    expect(image, JSON.stringify(parts)).toBeDefined();
    expect(image!.mediaType).toBe('image/png');
  });

  it('dispatches a catalog sandbox tool through the local dispatcher', async () => {
    // `artifact_publish` and `skill_propose` reach the agent this way: the shell
    // registers their executors on the local dispatcher, and the loop must turn
    // every `executesIn: 'sandbox'` descriptor into a tool that dispatches
    // there rather than over IPC. Asserted end-to-end because the wiring lives
    // in main.ts, not in buildSandboxTools.
    toolCatalog = [
      {
        name: 'artifact_publish',
        description: 'publish an artifact',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        executesIn: 'sandbox',
      },
    ];
    scriptedModel.mockReturnValue(
      modelReplaying([
        toolStep('artifact_publish', { path: 'out.txt' }),
        textStep('published'),
      ]),
    );
    inboxEntries = [userMessage('publish it')];

    await expect(main()).resolves.toBe(0);

    // It went through the gate...
    const preCall = calls.find(
      (c) =>
        c.action === 'tool.pre-call' &&
        (c.payload as { call: { name: string } }).call.name === 'artifact_publish',
    );
    expect(preCall).toBeDefined();
    // ...and NOT over the host IPC path.
    expect(calls.find((c) => c.action === 'tool.execute-host')).toBeUndefined();
    // The real executor isn't registered in this harness (no conversation blob
    // store), so the dispatcher reports the tool as unregistered — which is
    // itself the proof that dispatch went to the LOCAL dispatcher.
    const toolResult = JSON.stringify(shippedEntries().find((e) => e.role === 'tool'));
    expect(toolResult).toContain('artifact_publish');
  });

  it('discovers an installed skill, indexes it, and serves its body through Skill', async () => {
    await installSkill(
      'note-taker',
      'name: note-taker\ndescription: Takes notes when the user asks for notes.',
      'Step 1. Write the note.',
    );
    scriptedModel.mockReturnValue(
      modelReplaying([toolStep('Skill', { name: 'note-taker' }), textStep('ok')]),
    );
    inboxEntries = [userMessage('take a note')];

    await expect(main()).resolves.toBe(0);

    const toolResult = shippedEntries().find((e) => e.role === 'tool');
    expect(JSON.stringify(toolResult)).toContain('Step 1. Write the note.');
  });

  // Design §8: "The acceptance suite asserts the DEGRADATION, not the
  // capability." A skill declaring MCP servers must still load, and must warn.
  it('loads a skill declaring mcpServers but tells the model its servers are unavailable', async () => {
    await installSkill(
      'mcp-skill',
      'name: mcp-skill\ndescription: A skill that ships its own MCP server.',
      'Call the demo server.',
      { mcp: true },
    );
    scriptedModel.mockReturnValue(
      modelReplaying([toolStep('Skill', { name: 'mcp-skill' }), textStep('ok')]),
    );
    inboxEntries = [userMessage('use the mcp skill')];

    await expect(main()).resolves.toBe(0);

    const toolResult = JSON.stringify(shippedEntries().find((e) => e.role === 'tool'));
    // It loaded...
    expect(toolResult).toContain('Call the demo server.');
    // ...and it warned.
    expect(toolResult).toMatch(/not available on this runner/i);
  });

  // The agent-writable `.claude/skills/` in the workspace is NOT a discovery
  // path — that is why `settingSources` dropped 'project' in Phase 3.
  it('never discovers a skill planted in the agent-writable workspace', async () => {
    const decoy = path.join(workspaceRoot, '.claude', 'skills', 'evil');
    await fs.mkdir(decoy, { recursive: true });
    await fs.writeFile(
      path.join(decoy, 'SKILL.md'),
      '---\nname: evil\ndescription: Should never be discovered by the runner.\n---\n\npwn\n',
    );
    scriptedModel.mockReturnValue(modelReplaying([textStep('nothing to do')]));
    inboxEntries = [userMessage('hi')];

    await expect(main()).resolves.toBe(0);

    // With zero installed skills the Skill tool is not registered at all, so a
    // model that tried to call it would get a no-such-tool error. The decoy
    // never reaches the prompt either.
    expect(JSON.stringify(events)).not.toContain('pwn');
  });

  it('resumes from the host transcript across a runner restart', async () => {
    // Turn 1 on a fresh session.
    scriptedModel.mockReturnValue(modelReplaying([textStep('first reply')]));
    inboxEntries = [userMessage('first question')];
    await expect(main()).resolves.toBe(0);

    // What the HOST now holds: every append body concatenated, not the last
    // one (which is the final flush's empty prefix-integrity probe).
    const afterTurnOne = Buffer.concat(shippedTranscript);
    expect(shippedEntries().map((e) => e.role)).toEqual(['user', 'assistant']);

    // Turn 2 in a NEW runner process, bound to the same session.
    storedTranscript = afterTurnOne;
    sessionConfig.runnerSessionId = 'sess-resume';
    // Run 2 ships only the DELTA past what the host already has, so the test's
    // view of the store is "what run 1 left" plus "what run 2 appends".
    shippedTranscript = [afterTurnOne];
    events = [];
    calls = [];
    scriptedModel.mockReturnValue(modelReplaying([textStep('second reply')]));
    inboxEntries = [userMessage('second question')];

    await expect(main()).resolves.toBe(0);

    // The restored history is still there, with the new turn appended.
    expect(shippedEntries().map((e) => e.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  // Design §5: cross-runner translation is explicitly out of scope, so a
  // transcript the other runner wrote demotes to a fresh session rather than
  // being handed to a provider that cannot read it.
  it("demotes to a fresh session when the stored transcript is the other runner's", async () => {
    storedTranscript = Buffer.from(
      '{"type":"user","uuid":"x","message":{"role":"user","content":"older history"}}\n',
      'utf8',
    );
    sessionConfig.runnerSessionId = 'sess-from-claude-sdk';
    scriptedModel.mockReturnValue(modelReplaying([textStep('starting over')]));
    inboxEntries = [userMessage('continue please')];

    await expect(main()).resolves.toBe(0);

    // Fresh: only this turn, none of the foreign history.
    expect(shippedEntries().map((e) => e.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(shippedEntries())).not.toContain('older history');
  });

  // The sandbox-death / provider-error row: the run must terminate with a
  // reason so the host fires chat:turn-error and the UI offers a retry,
  // rather than exiting 0 and looking like a successful empty turn.
  it('terminates with a reason when the provider call fails', async () => {
    scriptedModel.mockReturnValue(modelThatFails('provider exploded'));
    inboxEntries = [userMessage('hi')];

    await expect(main()).resolves.toBe(1);

    const outcome = chatEnd()?.outcome as { kind: string; reason: string };
    expect(outcome.kind).toBe('terminated');
    expect(outcome.reason).toContain('provider exploded');
  });

  // The runner is spawned by id out of `ChatOrchestratorConfig.runnerBinaries`.
  // A mis-keyed map would otherwise run the agent on the wrong harness in
  // silence, with a transcript in the wrong format.
  it('refuses to run a session configured for a different runner', async () => {
    (sessionConfig.agentConfig as { runner: string }).runner = 'claude-sdk';
    scriptedModel.mockReturnValue(modelReplaying([textStep('should not happen')]));
    inboxEntries = [userMessage('hi')];

    // Building the loop is the tail of bootstrap, and `runRunner` constructs
    // it OUTSIDE its try on purpose: a throw here propagates so the entry
    // guard exits 2 without firing chat-end (the orchestrator's handle.exited
    // watcher synthesizes the terminated outcome instead).
    await expect(main()).rejects.toThrow(/configured for runner "claude-sdk"/);
    expect(chatEnd()).toBeUndefined();
  });
});
