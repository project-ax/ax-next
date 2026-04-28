import { describe, it, expect, afterEach } from 'vitest';
import {
  type Plugin,
  type AgentOutcome,
  type ChatMessage,
} from '@ax/core';
import { runServeCommand } from '../commands/serve.js';

// ---------------------------------------------------------------------------
// Tests for the `serve` subcommand. Avoids the real k8s preset by injecting
// a `pluginsFactory` that registers a tiny stub plugin with `session:create`
// + `agent:invoke` — enough surface for the HTTP handler to exercise. Real
// preset boot requires Postgres + k8s API, which we don't want to drag into
// a unit test.
// ---------------------------------------------------------------------------

interface ServeHandle {
  host: string;
  port: number;
  close: () => Promise<void>;
}

function stubPlugin(opts: {
  chatOutcome?: AgentOutcome | (() => AgentOutcome);
} = {}): Plugin {
  return {
    manifest: {
      name: '@ax/serve-test-stub',
      version: '0.0.0',
      registers: ['session:create', 'agent:invoke'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<{ sessionId: string; workspaceRoot: string }, { sessionId: string; token: string }>(
        'session:create',
        '@ax/serve-test-stub',
        async (_ctx, input) => ({ sessionId: input.sessionId, token: 'stub-token' }),
      );
      bus.registerService<{ message: ChatMessage }, AgentOutcome>(
        'agent:invoke',
        '@ax/serve-test-stub',
        async (_ctx, input) => {
          const o = opts.chatOutcome;
          if (typeof o === 'function') return o();
          if (o !== undefined) return o;
          // default: echo the user message back as assistant
          return {
            kind: 'complete',
            messages: [
              input.message,
              { role: 'assistant', content: `echo: ${input.message.content}` },
            ],
          };
        },
      );
    },
  };
}

async function bootServe(opts: {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  plugin?: Plugin;
} = {}): Promise<ServeHandle> {
  return new Promise((resolve, reject) => {
    const argv = opts.argv ?? ['--port', '0', '--host', '127.0.0.1'];
    void runServeCommand({
      argv,
      env: opts.env ?? {},
      stdout: () => undefined,
      stderr: () => undefined,
      pluginsFactory: () => [opts.plugin ?? stubPlugin()],
      onListening: (h) => resolve(h),
    }).catch(reject);
  });
}

describe('serve command — argument parsing', () => {
  it('rejects --port without a value', async () => {
    const code = await runServeCommand({
      argv: ['--port'],
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code).toBe(2);
  });

  it('rejects out-of-range --port', async () => {
    const code = await runServeCommand({
      argv: ['--port', '99999'],
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code).toBe(2);
  });

  it('rejects negative --port', async () => {
    const code = await runServeCommand({
      argv: ['--port', '-1'],
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code).toBe(2);
  });

  it('rejects non-integer --port', async () => {
    const code = await runServeCommand({
      argv: ['--port', '8080.5'],
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code).toBe(2);
  });

  it('rejects unknown argument', async () => {
    const code = await runServeCommand({
      argv: ['--bogus'],
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code).toBe(2);
  });

  it('--help returns 0', async () => {
    const code = await runServeCommand({
      argv: ['--help'],
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code).toBe(0);
  });

  it('without pluginsFactory, env-driven preset config is required (DATABASE_URL etc.)', async () => {
    const code = await runServeCommand({
      argv: ['--port', '0'],
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
    });
    // Missing DATABASE_URL → 2
    expect(code).toBe(2);
  });
});

describe('serve command — HTTP surface', () => {
  let handle: ServeHandle | null = null;
  afterEach(async () => {
    if (handle !== null) await handle.close();
    handle = null;
  });

  it('GET /health returns 200 without auth even when AX_SERVE_TOKEN is set', async () => {
    handle = await bootServe({ env: { AX_SERVE_TOKEN: 'secret' } });
    const r = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
  });

  it('POST /chat returns 401 when AX_SERVE_TOKEN is set and no auth header', async () => {
    handle = await bootServe({ env: { AX_SERVE_TOKEN: 'secret' } });
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error.message).not.toContain('secret');
  });

  it('POST /chat returns 401 with wrong bearer token', async () => {
    handle = await bootServe({ env: { AX_SERVE_TOKEN: 'secret' } });
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer wrong' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(401);
  });

  it('POST /chat works with correct bearer token', async () => {
    handle = await bootServe({ env: { AX_SERVE_TOKEN: 'secret' } });
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId).toMatch(/^serve-/);
    expect(body.outcome.kind).toBe('complete');
    expect(body.outcome.messages[1].content).toBe('echo: hello');
  });

  it('POST /chat works without AX_SERVE_TOKEN (warning logged at boot)', async () => {
    let warned = false;
    handle = await new Promise<ServeHandle>((resolve, reject) => {
      void runServeCommand({
        argv: ['--port', '0', '--host', '127.0.0.1'],
        env: {},
        stdout: () => undefined,
        stderr: (line) => {
          if (line.includes('AX_SERVE_TOKEN')) warned = true;
        },
        pluginsFactory: () => [stubPlugin()],
        onListening: (h) => resolve(h),
      }).catch(reject);
    });
    expect(warned).toBe(true);
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(200);
  });

  it('POST /chat returns 415 on wrong content-type', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(r.status).toBe(415);
  });

  it('POST /chat returns 400 on bad JSON', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(r.status).toBe(400);
  });

  it('POST /chat returns 400 on missing message field', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noMessageHere: true }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /chat returns 400 on empty message', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /chat returns 413 on oversize body (Content-Length fail-fast)', async () => {
    handle = await bootServe();
    const big = 'x'.repeat(2 * 1024 * 1024); // 2 MiB > 1 MiB cap
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
    });
    expect(r.status).toBe(413);
  });

  it('returns 404 for unknown paths', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/nonsense`);
    expect(r.status).toBe(404);
  });

  it('returns 405 for unsupported methods', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/health`, { method: 'DELETE' });
    expect(r.status).toBe(405);
  });

  it('honors caller-provided sessionId', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', sessionId: 'my-session-abc' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.sessionId).toBe('my-session-abc');
  });

  it('returns 500 with PluginError code when agent:invoke throws', async () => {
    const { PluginError } = await import('@ax/core');
    handle = await bootServe({
      plugin: stubPlugin({
        chatOutcome: () => {
          throw new PluginError({
            code: 'chat-busted',
            plugin: 'test',
            hookName: 'agent:invoke',
            message: 'chat went sideways',
          });
        },
      }),
    });
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error.code).toBe('chat-busted');
  });
});
