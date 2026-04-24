import * as http from 'node:http';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { PluginError } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  SessionCreateInput,
  SessionCreateOutput,
} from '@ax/session-inmemory';
import { createIpcServerPlugin } from '../plugin.js';
import { createListener, type Listener } from '../listener.js';

// ---------------------------------------------------------------------------
// Listener tests
//
// Drives the listener over a real unix-socket HTTP client. Each test opens
// a fresh per-session tempdir (mode 0700 via fs.mkdtemp) so we exercise
// invariant I10 as side effect on every run.
//
// The dispatcher placeholder returns 501 for every authenticated POST —
// tests that pass all five gates expect 501 as a sign that "the request
// reached the placeholder" (not 500, not silent success).
// ---------------------------------------------------------------------------

interface Harness {
  listener: Listener;
  token: string;
  tempDir: string;
  socketPath: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(sessionId = 's-list'): Promise<Harness> {
  const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
  const ctx = h.ctx();
  const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
    'session:create',
    ctx,
    { sessionId, workspaceRoot: '/tmp/ws' },
  );
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-test-'));
  const socketPath = path.join(tempDir, 'ipc.sock');
  const listener = await createListener({ socketPath, sessionId, bus: h.bus });
  return {
    listener,
    token,
    tempDir,
    socketPath,
    cleanup: async () => {
      await listener.close();
      // Best-effort tempdir cleanup — the listener removes the socket file.
      try {
        await fsp.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

interface RequestOptions {
  method: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function requestOverSocket(
  socketPath: string,
  opts: RequestOptions,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const body = opts.body === undefined
      ? undefined
      : Buffer.isBuffer(opts.body)
        ? opts.body
        : Buffer.from(opts.body, 'utf8');
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (body !== undefined && headers['Content-Length'] === undefined) {
      headers['Content-Length'] = String(body.length);
    }
    const req = http.request(
      {
        socketPath,
        path: opts.path ?? '/dispatch-placeholder',
        method: opts.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('createListener', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const h of harnesses) await h.cleanup();
    harnesses.length = 0;
  });

  it('binds to a per-session tempdir socket (tempdir mode 0700)', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    // The socket file exists on disk.
    expect(fs.existsSync(h.socketPath)).toBe(true);
    // The parent tempdir is mode 0700 (mkdtemp default on POSIX).
    const stat = await fsp.stat(h.tempDir);
    // Low 9 bits: owner rwx only.
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('rejects PUT with 405 method not allowed', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await requestOverSocket(h.socketPath, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(405);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: 'VALIDATION', message: 'method not allowed' },
    });
  });

  it('rejects POST with Content-Type: text/plain with 415', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await requestOverSocket(h.socketPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Authorization: `Bearer ${h.token}`,
      },
      body: 'hello',
    });
    expect(res.status).toBe(415);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION');
  });

  it('rejects POST without Authorization with 401 SESSION_INVALID', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await requestOverSocket(h.socketPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('SESSION_INVALID');
    expect(parsed.error.message).toBe('missing authorization');
  });

  it('rejects POST with a wrong token with 401 SESSION_INVALID (token not echoed)', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const bogus = 'nope-nope-nope';
    const res = await requestOverSocket(h.socketPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bogus}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('SESSION_INVALID');
    expect(parsed.error.message).toBe('unknown token');
    // I9: bogus token MUST NOT appear in the response body.
    expect(res.body).not.toContain(bogus);
  });

  it('accepts a valid POST to an unknown path and returns 404 VALIDATION', async () => {
    // After all five inbound gates pass, the dispatcher routes on req.url.
    // The test client hits `/dispatch-placeholder`, which is not a protocol
    // path — so the dispatcher returns 404 VALIDATION. This replaces the
    // Task-3 placeholder 501 now that the dispatcher is wired (Task 4).
    const h = await makeHarness();
    harnesses.push(h);
    const res = await requestOverSocket(h.socketPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${h.token}`,
      },
      body: '{"hello":"world"}',
    });
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.error.message).toMatch(/unknown path/);
  });

  it('rejects POST with a 5 MiB body (Content-Length) with 413', async () => {
    // Body-size fail-fast happens inside the dispatcher's body reader —
    // route at a real protocol path so we reach it. Any known-action path
    // works; /workspace.commit-notify is a stub and needs no services.
    const h = await makeHarness();
    harnesses.push(h);
    // Claim 5 MiB via Content-Length, send the empty body — fail-fast path.
    const res = await requestOverSocket(h.socketPath, {
      method: 'POST',
      path: '/workspace.commit-notify',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${h.token}`,
        'Content-Length': String(5 * 1024 * 1024),
      },
      // body omitted deliberately
    });
    expect(res.status).toBe(413);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('VALIDATION');
    expect(parsed.error.message).toBe('body too large');
  });

  it('rejects POST with invalid JSON with 400 VALIDATION', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await requestOverSocket(h.socketPath, {
      method: 'POST',
      path: '/workspace.commit-notify',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${h.token}`,
      },
      body: '{"a":',
    });
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('VALIDATION');
    expect(parsed.error.message).toMatch(/^invalid json:/);
  });

  it('ipc:stop removes the socket file', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-test-'));
    const socketPath = path.join(tempDir, 'ipc.sock');
    const h = await createTestHarness({
      // @ax/ipc-server declares calls on `llm:call` and `tool:list` — stub
      // them to satisfy bootstrap's verifyCalls. No request path hits them
      // in this test.
      services: {
        'llm:call': async () => ({ assistantMessage: { role: 'assistant', content: '' }, toolCalls: [] }),
        'tool:list': async () => ({ tools: [] }),
      },
      plugins: [createSessionInmemoryPlugin(), createIpcServerPlugin()],
    });
    const ctx = h.ctx();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-stop', workspaceRoot: '/tmp/ws' },
    );
    await h.bus.call('ipc:start', ctx, { socketPath, sessionId: 's-stop' });
    expect(fs.existsSync(socketPath)).toBe(true);
    await h.bus.call('ipc:stop', ctx, { sessionId: 's-stop' });
    expect(fs.existsSync(socketPath)).toBe(false);
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('ipc:start on an already-running sessionId throws PluginError already-running', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-test-'));
    const socketPath = path.join(tempDir, 'ipc.sock');
    const secondSocketPath = path.join(tempDir, 'ipc-2.sock');
    const h = await createTestHarness({
      services: {
        'llm:call': async () => ({ assistantMessage: { role: 'assistant', content: '' }, toolCalls: [] }),
        'tool:list': async () => ({ tools: [] }),
      },
      plugins: [createSessionInmemoryPlugin(), createIpcServerPlugin()],
    });
    const ctx = h.ctx();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 's-dup', workspaceRoot: '/tmp/ws' },
    );
    await h.bus.call('ipc:start', ctx, { socketPath, sessionId: 's-dup' });

    let caught: unknown;
    try {
      await h.bus.call('ipc:start', ctx, {
        socketPath: secondSocketPath,
        sessionId: 's-dup',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('already-running');

    // cleanup
    await h.bus.call('ipc:stop', ctx, { sessionId: 's-dup' });
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects a valid token bound to a DIFFERENT session with 403', async () => {
    // Two sessions exist. Listener is bound to session A. We authenticate
    // using session B's token — auth succeeds but cross-session gate fails.
    const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
    const ctx = h.ctx();
    await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 'A', workspaceRoot: '/tmp/A' },
    );
    const { token: tokenB } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
      'session:create',
      ctx,
      { sessionId: 'B', workspaceRoot: '/tmp/B' },
    );
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-test-'));
    const socketPath = path.join(tempDir, 'ipc.sock');
    const listener = await createListener({ socketPath, sessionId: 'A', bus: h.bus });

    const res = await requestOverSocket(socketPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenB}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('SESSION_INVALID');
    expect(parsed.error.message).toBe('token bound to a different session');
    expect(res.body).not.toContain(tokenB);

    await listener.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
});
