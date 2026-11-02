import * as http from 'node:http';
import * as net from 'node:net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  SessionCreateInput,
  SessionCreateOutput,
} from '@ax/session-inmemory';
import { createHttpListener, type HttpListener } from '../listener.js';

// ---------------------------------------------------------------------------
// HTTP listener tests
//
// Drives the listener over a real TCP HTTP client. Each test binds on
// 127.0.0.1:0 (OS-assigned port) and tears the listener down on cleanup.
//
// Mirrors @ax/ipc-server/listener.test.ts modulo the cross-session gate —
// the HTTP listener is process-wide and identifies sessions per-request via
// the bearer token, so there's no listener-owning sessionId to compare
// against.
// ---------------------------------------------------------------------------

interface Harness {
  listener: HttpListener;
  port: number;
  token: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
  const ctx = h.ctx();
  const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
    'session:create',
    ctx,
    { sessionId: 'sess-http', workspaceRoot: '/tmp/ws' },
  );
  // Bind on port 0 so the OS assigns a free port; the listener returns it.
  const listener = await createHttpListener({
    host: '127.0.0.1',
    port: 0,
    bus: h.bus,
  });
  return {
    listener,
    port: listener.port,
    token,
    cleanup: async () => {
      await listener.close();
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

function requestTo(port: number, opts: RequestOptions): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path ?? '/',
        method: opts.method,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe('createHttpListener', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  it('rejects unsupported methods with 405', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, { method: 'PUT' });
    expect(r.status).toBe(405);
  });

  it('rejects POST with non-json content-type as 415', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/tool.list',
      headers: {
        'content-type': 'text/plain',
        authorization: `Bearer ${harness.token}`,
      },
      body: 'hello',
    });
    expect(r.status).toBe(415);
  });

  it('rejects missing Authorization with 401', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/tool.list',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    // I9: token-no-echo — body must not contain the literal "Bearer".
    expect(r.body).not.toContain('Bearer');
  });

  it('rejects bad bearer scheme with 401', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/tool.list',
      headers: {
        'content-type': 'application/json',
        // The whole point of this test is asserting the listener rejects
        // any non-Bearer scheme with 401. The base64 payload is the
        // canonical RFC 7617 example string ("user:pass") — not a real
        // credential, just the correct shape for "Basic" auth so the
        // scheme check is the only thing that fires.
        authorization: 'Basic dXNlcjpwYXNz', // nosemgrep: javascript.lang.hardcoded.headers.hardcoded-basic-token.hardcoded-basic-token
      },
      body: '{}',
    });
    expect(r.status).toBe(401);
  });

  it('rejects unknown token with 401 and does not echo the token', async () => {
    harness = await makeHarness();
    const bogus = 'not-a-real-token-xyz';
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/tool.list',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bogus}`,
      },
      body: '{}',
    });
    expect(r.status).toBe(401);
    // I9: token MUST NOT appear in response body.
    expect(r.body).not.toContain(bogus);
  });

  it('returns 404 for unknown paths after auth', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/no-such-action',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${harness.token}`,
      },
      body: '{}',
    });
    expect(r.status).toBe(404);
  });

  it('returns 200 from /healthz without auth', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'GET',
      path: '/healthz',
    });
    expect(r.status).toBe(200);
  });

  it('returns 413 on oversized body (over MAX_FRAME)', async () => {
    harness = await makeHarness();
    // 5 MiB > MAX_FRAME (4 MiB). Claim 5 MiB via Content-Length and send an
    // empty body — fail-fast path. (Sending the actual 5 MiB races against
    // the server's `Connection: close` + 413 write and ECONNRESETs the
    // writer; the unix-socket listener test uses the same trick.) Any routed
    // JSON action works: the body is read before its handler runs, so no
    // tool:list producer is needed.
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/tool.list',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${harness.token}`,
        'content-length': String(5 * 1024 * 1024),
      },
      // body deliberately omitted
    });
    expect(r.status).toBe(413);
  });

  it('returns 400 on malformed JSON', async () => {
    harness = await makeHarness();
    const r = await requestTo(harness.port, {
      method: 'POST',
      path: '/tool.list',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${harness.token}`,
      },
      body: '{not json',
    });
    expect(r.status).toBe(400);
  });

  // TASK-995: the git workspace tier's actions are gone. The previous
  // release's runner streamed its end-of-turn save to `/workspace.commit-bundle`
  // as octet-stream; over this transport it must get the dispatcher's 404 for
  // an unknown path (after auth), not a 415 from the rule of a route that no
  // longer exists, and without a token it is still a 401.
  it('answers a removed action sent as octet-stream with 404 after auth, and 401 without a token', async () => {
    harness = await makeHarness();
    const withToken = await requestTo(harness.port, {
      method: 'POST',
      path: '/workspace.commit-bundle?reason=turn',
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${harness.token}`,
      },
      body: Buffer.from('PACK-bundle-bytes', 'utf8'),
    });
    expect(withToken.status).toBe(404);
    expect(JSON.parse(withToken.body)).toEqual({
      error: { code: 'NOT_FOUND', message: 'unknown path: /workspace.commit-bundle' },
    });

    const noToken = await requestTo(harness.port, {
      method: 'POST',
      path: '/workspace.commit-bundle',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    expect(noToken.status).toBe(401);
  });
});

// TASK-1018: a body read that fails mid-stream (the client hangs up after the
// headers) used to escape `dispatch` to the listener's per-connection catch,
// which has no ctx: one unstructured `ipc-http: unhandled handler error` line
// on stderr, no reqId. It is now logged by the dispatcher on the per-request
// ctx's structured logger — exactly one line, carrying the reqId.
describe('createHttpListener body-read failure (TASK-1018)', () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (harness) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  function captureWrites(stream: NodeJS.WriteStream): string[] {
    const lines: string[] = [];
    const original = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
    return lines;
  }

  it.each([
    ['/tool.list', 'application/json', '{"partial'],
    ['/blob.put', 'application/octet-stream', 'partial-bytes'],
  ])('%s: a client hang-up mid-body logs one structured line with the reqId', async (path, ct, partial) => {
    harness = await makeHarness();
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    const sock = net.connect(harness.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
    });
    sock.on('error', () => {});
    sock.write(
      `POST ${path} HTTP/1.1\r\nHost: ipc.local\r\nContent-Type: ${ct}\r\n` +
        `Authorization: Bearer ${harness.token}\r\nContent-Length: 1000\r\n\r\n${partial}`,
    );
    // Let auth finish and the dispatcher start reading the body, then hang up.
    await new Promise((r) => setTimeout(r, 150));
    sock.destroy();

    const failures = (): Array<Record<string, unknown>> =>
      stdout
        .filter((l) => l.includes('ipc_body_read_failed'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    const deadline = Date.now() + 3000;
    while (failures().length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Give a second (wrong) line a chance to show up before asserting "one".
    await new Promise((r) => setTimeout(r, 100));

    const lines = failures();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', msg: 'ipc_body_read_failed', action: path });
    expect(typeof lines[0]!.reqId).toBe('string');
    expect((lines[0]!.reqId as string).length).toBeGreaterThan(0);
    expect(stderr.filter((l) => l.includes('ipc-http:'))).toEqual([]);
    // "One line" means one error line in total, not one under this name: a
    // regression that also logged the failure under another name (say
    // ipc_dispatch_internal_error) must still fail here.
    const errorLines = stdout.filter((l) => l.includes('"level":"error"'));
    expect(errorLines).toHaveLength(1);
  });
});
