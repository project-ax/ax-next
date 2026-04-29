import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { stubRunnerPath, encodeScript, type StubRunnerScript } from '../index.js';

const TOKEN = 'tok-stub-test';

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

interface FakeServer {
  socketPath: string;
  /** Every request the stub-runner made, in arrival order. */
  calls: RecordedCall[];
  /** Wire a per-action handler. Defaults give 200 + minimal valid responses. */
  setHandler(action: string, h: (body: unknown, res: http.ServerResponse) => void): void;
  close(): Promise<void>;
}

async function startFakeServer(): Promise<FakeServer> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-stub-runner-'));
  const socketPath = path.join(tempDir, 'ipc.sock');
  const calls: RecordedCall[] = [];
  const handlers = new Map<
    string,
    (body: unknown, res: http.ServerResponse) => void
  >();

  const defaultHandler = (action: string, body: unknown, res: http.ServerResponse): void => {
    if (action === 'tool.list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tools: [] }));
      return;
    }
    if (action === 'tool.pre-call') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ verdict: 'allow' }));
      return;
    }
    if (action === 'tool.execute-host') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: { ok: true, source: 'host' } }));
      return;
    }
    if (action.startsWith('event.')) {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  };

  const server = http.createServer((req, res) => {
    const action = (req.url ?? '').replace(/^\//, '').split('?')[0] ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      calls.push({ method: req.method ?? '', url: req.url ?? '', body });
      const handler = handlers.get(action);
      if (handler !== undefined) {
        handler(body, res);
        return;
      }
      defaultHandler(action, body, res);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });

  return {
    socketPath,
    calls,
    setHandler: (action, h) => {
      handlers.set(action, h);
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await fsp.rm(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

interface SpawnedStub {
  child: ChildProcess;
  exit: Promise<{ code: number | null; stderr: string }>;
}

function spawnStub(
  server: FakeServer | undefined,
  envOverrides: Record<string, string | undefined>,
): SpawnedStub {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
  };
  if (server !== undefined) {
    env.AX_RUNNER_ENDPOINT = `unix://${server.socketPath}`;
  }
  env.AX_SESSION_ID = 'sess-stub-test';
  env.AX_AUTH_TOKEN = TOKEN;
  env.AX_WORKSPACE_ROOT = '/tmp/stub-workspace';
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }

  const child = spawn(process.execPath, [stubRunnerPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  child.stdout?.resume();

  const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on('exit', (code) => {
      resolve({ code, stderr: Buffer.concat(stderrChunks).toString('utf8') });
    });
  });

  return { child, exit };
}

describe('stub-runner', () => {
  const servers: FakeServer[] = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const c of children) {
      if (c.exitCode == null && c.signalCode == null) c.kill('SIGKILL');
    }
    children.length = 0;
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  it('exits 0 on a finish-only script and fires event.chat-end exactly once', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const script: StubRunnerScript = {
      entries: [{ kind: 'finish', reason: 'end_turn' }],
    };
    const stub = spawnStub(server, { AX_TEST_STUB_SCRIPT: encodeScript(script) });
    children.push(stub.child);
    const { code, stderr } = await stub.exit;
    expect(code, `stderr: ${stderr}`).toBe(0);
    const chatEnd = server.calls.filter((c) => c.url === '/event.chat-end');
    expect(chatEnd).toHaveLength(1);
    expect(chatEnd[0]?.method).toBe('POST');
    expect(chatEnd[0]?.body).toEqual({
      outcome: { kind: 'complete', messages: [] },
    });
  });

  it('fires tool.list at startup before any tool-call entry', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const script: StubRunnerScript = {
      entries: [
        {
          kind: 'tool-call',
          name: 'shell.exec',
          input: { cmd: 'ls' },
          executesIn: 'sandbox',
          expectPostCall: false,
        },
        { kind: 'finish', reason: 'end_turn' },
      ],
    };
    const stub = spawnStub(server, { AX_TEST_STUB_SCRIPT: encodeScript(script) });
    children.push(stub.child);
    const { code, stderr } = await stub.exit;
    expect(code, `stderr: ${stderr}`).toBe(0);

    const toolListIdx = server.calls.findIndex((c) => c.url === '/tool.list');
    const preCallIdx = server.calls.findIndex((c) => c.url === '/tool.pre-call');
    expect(toolListIdx).toBeGreaterThanOrEqual(0);
    expect(preCallIdx).toBeGreaterThanOrEqual(0);
    expect(toolListIdx).toBeLessThan(preCallIdx);
  });

  it('fires tool.execute-host for executesIn:host entries and synthesizes the post-call event', async () => {
    const server = await startFakeServer();
    servers.push(server);
    server.setHandler('tool.execute-host', (_body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: { greeting: 'hi from host' } }));
    });
    const script: StubRunnerScript = {
      entries: [
        {
          kind: 'tool-call',
          name: 'fs.read',
          input: { path: '/etc/hostname' },
          executesIn: 'host',
          expectPostCall: true,
        },
        { kind: 'finish', reason: 'tool_use' },
      ],
    };
    const stub = spawnStub(server, { AX_TEST_STUB_SCRIPT: encodeScript(script) });
    children.push(stub.child);
    const { code, stderr } = await stub.exit;
    expect(code, `stderr: ${stderr}`).toBe(0);

    const preCalls = server.calls.filter((c) => c.url === '/tool.pre-call');
    const execHosts = server.calls.filter((c) => c.url === '/tool.execute-host');
    const postCalls = server.calls.filter((c) => c.url === '/event.tool-post-call');
    expect(preCalls).toHaveLength(1);
    expect(execHosts).toHaveLength(1);
    expect(postCalls).toHaveLength(1);

    const post = postCalls[0]?.body as { call: { name: string }; output: unknown };
    expect(post.call.name).toBe('fs.read');
    expect(post.output).toEqual({ greeting: 'hi from host' });

    const preIdx = server.calls.findIndex((c) => c.url === '/tool.pre-call');
    const execIdx = server.calls.findIndex((c) => c.url === '/tool.execute-host');
    const postIdx = server.calls.findIndex((c) => c.url === '/event.tool-post-call');
    expect(preIdx).toBeLessThan(execIdx);
    expect(execIdx).toBeLessThan(postIdx);
  });

  it('does NOT fire tool.execute-host for executesIn:sandbox entries but DOES fire post-call when expected', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const script: StubRunnerScript = {
      entries: [
        {
          kind: 'tool-call',
          name: 'shell.exec',
          input: { cmd: 'echo hi' },
          executesIn: 'sandbox',
          expectPostCall: true,
        },
        { kind: 'finish', reason: 'end_turn' },
      ],
    };
    const stub = spawnStub(server, { AX_TEST_STUB_SCRIPT: encodeScript(script) });
    children.push(stub.child);
    const { code, stderr } = await stub.exit;
    expect(code, `stderr: ${stderr}`).toBe(0);

    expect(server.calls.filter((c) => c.url === '/tool.execute-host')).toHaveLength(0);
    const postCalls = server.calls.filter((c) => c.url === '/event.tool-post-call');
    expect(postCalls).toHaveLength(1);
    const post = postCalls[0]?.body as { call: { name: string }; output: unknown };
    expect(post.call.name).toBe('shell.exec');
    expect(post.output).toEqual({ ok: true, simulated: true });
  });

  it('fires tool.pre-call before each tool-call entry', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const script: StubRunnerScript = {
      entries: [
        {
          kind: 'tool-call',
          name: 'a',
          input: {},
          executesIn: 'sandbox',
          expectPostCall: false,
        },
        {
          kind: 'tool-call',
          name: 'b',
          input: {},
          executesIn: 'sandbox',
          expectPostCall: false,
        },
        { kind: 'finish', reason: 'end_turn' },
      ],
    };
    const stub = spawnStub(server, { AX_TEST_STUB_SCRIPT: encodeScript(script) });
    children.push(stub.child);
    const { code, stderr } = await stub.exit;
    expect(code, `stderr: ${stderr}`).toBe(0);

    const preCalls = server.calls.filter((c) => c.url === '/tool.pre-call');
    expect(preCalls).toHaveLength(2);
    expect((preCalls[0]?.body as { call: { name: string } }).call.name).toBe('a');
    expect((preCalls[1]?.body as { call: { name: string } }).call.name).toBe('b');
  });

  it('exits non-zero on a malformed script (unparseable JSON in env)', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const stub = spawnStub(server, {
      AX_TEST_STUB_SCRIPT: '!!! not valid base64 json !!!',
    });
    children.push(stub.child);
    const { code, stderr } = await stub.exit;
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/AX_TEST_STUB_SCRIPT|decode/i);
  });

  it('exits non-zero when AX_TEST_STUB_SCRIPT env var is missing', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const stub = spawnStub(server, { AX_TEST_STUB_SCRIPT: undefined });
    children.push(stub.child);
    const { code, stderr } = await stub.exit;
    expect(code).toBe(2);
    expect(stderr).toMatch(/AX_TEST_STUB_SCRIPT/);
  });

  it('fires event.chat-end with the assistant-text content when present', async () => {
    const server = await startFakeServer();
    servers.push(server);
    const script: StubRunnerScript = {
      entries: [
        { kind: 'assistant-text', content: 'first reply' },
        { kind: 'assistant-text', content: 'second reply' },
        { kind: 'finish', reason: 'end_turn' },
      ],
    };
    const stub = spawnStub(server, { AX_TEST_STUB_SCRIPT: encodeScript(script) });
    children.push(stub.child);
    const { code, stderr } = await stub.exit;
    expect(code, `stderr: ${stderr}`).toBe(0);

    const chatEnd = server.calls.find((c) => c.url === '/event.chat-end');
    expect(chatEnd).toBeDefined();
    const body = chatEnd?.body as {
      outcome: { kind: string; messages: Array<{ role: string; content: string }> };
    };
    expect(body.outcome.kind).toBe('complete');
    expect(body.outcome.messages).toEqual([
      { role: 'assistant', content: 'first reply' },
      { role: 'assistant', content: 'second reply' },
    ]);
  });
});
