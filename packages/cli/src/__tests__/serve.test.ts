import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  type Plugin,
  type AgentOutcome,
  type AgentMessage,
} from '@ax/core';
import {
  createHttpServerPlugin,
  type HttpServerPlugin,
} from '@ax/http-server';
import { runServeCommand } from '../commands/serve.js';

// ---------------------------------------------------------------------------
// Tests for the `serve` subcommand. After issue #39, `serve` no longer owns
// its own listener — it registers `/chat` + `/health` against @ax/http-server
// via http:register-route. So tests boot a real http-server plugin alongside
// a tiny stub that registers `session:create` + `agent:invoke`, and read the
// bound port off the http-server.
//
// CSRF: the http-server's built-in subscriber rejects state-changing methods
// without an allow-listed Origin OR `X-Requested-With: ax-admin`. Tests
// supply the latter on every POST /chat call, mirroring how headless callers
// (the kind goldenpath, channel-web's UI) authenticate themselves.
// ---------------------------------------------------------------------------

// Capture + restore so a parallel test file in the same vitest worker
// doesn't see our override leak in (or out — restoring the original keeps
// future runs deterministic).
let originalAllowNoOrigins: string | undefined;
beforeAll(() => {
  originalAllowNoOrigins = process.env.AX_HTTP_ALLOW_NO_ORIGINS;
  // Silence the http-server's empty-allow-list warning. We test with
  // X-Requested-With: ax-admin instead of an Origin allow-list.
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
});
afterAll(() => {
  if (originalAllowNoOrigins === undefined) {
    delete process.env.AX_HTTP_ALLOW_NO_ORIGINS;
  } else {
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = originalAllowNoOrigins;
  }
});

interface ServeHandle {
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
      bus.registerService<{ message: AgentMessage }, AgentOutcome>(
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
  const httpServer: HttpServerPlugin = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: randomBytes(32),
    allowedOrigins: [],
  });

  return new Promise((resolve, reject) => {
    const argv = opts.argv ?? [];
    void runServeCommand({
      argv,
      env: opts.env ?? {},
      stdout: () => undefined,
      stderr: () => undefined,
      pluginsFactory: () => [httpServer, opts.plugin ?? stubPlugin()],
      onReady: ({ close }) => {
        resolve({
          port: httpServer.boundPort(),
          close,
        });
      },
    }).catch(reject);
  });
}

const CSRF_HEADER = { 'x-requested-with': 'ax-admin' };

describe('serve command — argument parsing', () => {
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
      argv: [],
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
      headers: { 'content-type': 'application/json', ...CSRF_HEADER },
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
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer wrong',
        ...CSRF_HEADER,
      },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(401);
  });

  it('POST /chat works with correct bearer token', async () => {
    handle = await bootServe({ env: { AX_SERVE_TOKEN: 'secret' } });
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer secret',
        ...CSRF_HEADER,
      },
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
    const httpServer = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: randomBytes(32),
      allowedOrigins: [],
    });
    handle = await new Promise<ServeHandle>((resolve, reject) => {
      void runServeCommand({
        argv: [],
        env: {},
        stdout: () => undefined,
        stderr: (line) => {
          if (line.includes('AX_SERVE_TOKEN')) warned = true;
        },
        pluginsFactory: () => [httpServer, stubPlugin()],
        onReady: ({ close }) => {
          resolve({ port: httpServer.boundPort(), close });
        },
      }).catch(reject);
    });
    expect(warned).toBe(true);
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CSRF_HEADER },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(200);
  });

  it('POST /chat returns 403 without X-Requested-With (CSRF gate)', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(403);
  });

  it('POST /chat returns 415 on wrong content-type', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...CSRF_HEADER },
      body: '{}',
    });
    expect(r.status).toBe(415);
  });

  it('POST /chat returns 400 on bad JSON', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CSRF_HEADER },
      body: 'not-json',
    });
    expect(r.status).toBe(400);
  });

  it('POST /chat returns 400 on missing message field', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CSRF_HEADER },
      body: JSON.stringify({ noMessageHere: true }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /chat returns 400 on empty message', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CSRF_HEADER },
      body: JSON.stringify({ message: '' }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /chat returns 413 on oversize body (Content-Length fail-fast)', async () => {
    handle = await bootServe();
    const big = 'x'.repeat(2 * 1024 * 1024); // 2 MiB > 1 MiB cap
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CSRF_HEADER },
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
    // CSRF gate fires before the router on state-changing methods, so a
    // bare DELETE (no Origin / no X-Requested-With) returns 403 — that's
    // http-server contract, not /health's. Adding the CSRF bypass header
    // lets the request reach the router, which is what we're actually
    // testing here: only GET is registered for /health.
    const r = await fetch(`http://127.0.0.1:${handle.port}/health`, {
      method: 'DELETE',
      headers: CSRF_HEADER,
    });
    expect(r.status).toBe(405);
  });

  it('honors caller-provided sessionId', async () => {
    handle = await bootServe();
    const r = await fetch(`http://127.0.0.1:${handle.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CSRF_HEADER },
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
      headers: { 'content-type': 'application/json', ...CSRF_HEADER },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error.code).toBe('chat-busted');
  });
});
