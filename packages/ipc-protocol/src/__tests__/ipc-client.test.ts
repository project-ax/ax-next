import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createIpcClient } from '../ipc-client.js';
import {
  HostUnavailableError,
  IpcRequestError,
  SessionInvalidError,
} from '../errors.js';

// ---------------------------------------------------------------------------
// ipc-client tests
//
// We spin up a real http.createServer bound to a unix socket in an mkdtemp
// dir per test so we exercise the full wire path. The server's responses
// are canned via per-test handlers. Timing-sensitive assertions use small
// (≤ 200 ms) configurable values.
// ---------------------------------------------------------------------------

interface FakeServer {
  socketPath: string;
  /** Set the handler for incoming requests. */
  setHandler(h: (req: http.IncomingMessage, res: http.ServerResponse) => void): void;
  /** Call counter — incremented on every connection that reaches the handler. */
  callCount(): number;
  close(): Promise<void>;
}

async function startFakeServer(): Promise<FakeServer> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-arc-'));
  const socketPath = path.join(tempDir, 'ipc.sock');
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void =
    (_req, res) => {
      res.writeHead(500);
      res.end();
    };
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    handler(req, res);
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
    setHandler: (h) => {
      handler = h;
    },
    callCount: () => count,
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

/** Read a full request body into a string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

describe('createIpcClient', () => {
  const servers: FakeServer[] = [];

  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  it('throws SessionInvalidError on 401', async () => {
    const server = await startFakeServer();
    servers.push(server);
    server.setHandler((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 'SESSION_INVALID', message: 'bad token' } }),
      );
    });
    const client = createIpcClient({
      runnerEndpoint: `unix://${server.socketPath}`,
      token: 'tok-abc',
      maxRetries: 0,
    });
    await expect(client.call('tool.list', {})).rejects.toBeInstanceOf(
      SessionInvalidError,
    );
  });

  it('throws IpcRequestError with code=VALIDATION on 400', async () => {
    const server = await startFakeServer();
    servers.push(server);
    server.setHandler((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 'VALIDATION', message: 'bad body' } }),
      );
    });
    const client = createIpcClient({
      runnerEndpoint: `unix://${server.socketPath}`,
      token: 'tok-abc',
      maxRetries: 0,
    });
    try {
      await client.call('tool.list', {});
      expect.fail('expected IpcRequestError');
    } catch (err) {
      expect(err).toBeInstanceOf(IpcRequestError);
      expect((err as IpcRequestError).code).toBe('VALIDATION');
      expect((err as IpcRequestError).status).toBe(400);
      expect((err as IpcRequestError).message).toBe('bad body');
    }
  });

  it('retries 5xx up to maxRetries then throws IpcRequestError', async () => {
    const server = await startFakeServer();
    servers.push(server);
    server.setHandler((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }),
      );
    });
    const client = createIpcClient({
      runnerEndpoint: `unix://${server.socketPath}`,
      token: 'tok-abc',
      maxRetries: 2,
      retryBackoff: () => 5,
    });
    try {
      await client.call('tool.list', {});
      expect.fail('expected IpcRequestError');
    } catch (err) {
      expect(err).toBeInstanceOf(IpcRequestError);
      expect((err as IpcRequestError).status).toBe(500);
    }
    // Initial + 2 retries = 3 attempts.
    expect(server.callCount()).toBe(3);
  });

  it('retries on ECONNREFUSED then throws HostUnavailableError', async () => {
    // No server here — pick a path in a nonexistent directory so connect
    // fails synchronously with ENOENT (which we classify as transient) or
    // ECONNREFUSED. Either way HostUnavailableError is the outcome.
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-arc-dead-'));
    const deadSocketPath = path.join(tempDir, 'nope.sock');
    try {
      const client = createIpcClient({
        runnerEndpoint: `unix://${deadSocketPath}`,
        token: 'tok-abc',
        maxRetries: 2,
        retryBackoff: () => 5,
      });
      await expect(client.call('tool.list', {})).rejects.toBeInstanceOf(
        HostUnavailableError,
      );
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('aborts on per-action timeout and throws HostUnavailableError("timeout")', async () => {
    const server = await startFakeServer();
    servers.push(server);
    // Handler never responds — the request must time out.
    server.setHandler(() => {
      // hang intentionally
    });
    const client = createIpcClient({
      runnerEndpoint: `unix://${server.socketPath}`,
      token: 'tok-abc',
      maxRetries: 0,
      timeouts: { 'tool.list': 100 },
    });
    try {
      await client.call('tool.list', {});
      expect.fail('expected HostUnavailableError');
    } catch (err) {
      expect(err).toBeInstanceOf(HostUnavailableError);
      expect((err as Error).message).toMatch(/timeout/);
    }
  });

  it('callGet(session.next-message): serializes cursor into query string', async () => {
    const server = await startFakeServer();
    servers.push(server);
    let seenMethod: string | undefined;
    let seenUrl: string | undefined;
    server.setHandler((req, res) => {
      seenMethod = req.method;
      seenUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'timeout', cursor: 0 }));
    });
    const client = createIpcClient({
      runnerEndpoint: `unix://${server.socketPath}`,
      token: 'tok-abc',
    });
    const result = await client.callGet('session.next-message', { cursor: '0' });
    expect(seenMethod).toBe('GET');
    expect(seenUrl).toBe('/session.next-message?cursor=0');
    expect(result).toEqual({ type: 'timeout', cursor: 0 });
  });

  describe('http:// transport round-trip', () => {
    let server: http.Server;
    let port: number;
    const TOKEN = 'test-bearer-token';

    beforeEach(async () => {
      server = http.createServer((req, res) => {
        // Auth check: require the expected bearer token.
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { code: 'SESSION_INVALID', message: 'unknown token' },
            }),
          );
          return;
        }

        // Drain body, then respond. Only POST /tool.list is wired here — any
        // other route returns 404 so a misrouted call surfaces clearly.
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (req.url === '/tool.list' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                tools: [
                  {
                    name: 'echo',
                    description: 'echo',
                    inputSchema: { type: 'object' },
                    executesIn: 'sandbox',
                  },
                ],
              }),
            );
            return;
          }
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { code: 'NOT_FOUND', message: 'unknown path' },
            }),
          );
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (typeof addr === 'object' && addr !== null) port = addr.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('round-trips tool.list with valid bearer auth', async () => {
      const client = createIpcClient({
        runnerEndpoint: `http://127.0.0.1:${port}`,
        token: TOKEN,
      });
      const result = (await client.call('tool.list', {})) as {
        tools: unknown[];
      };
      expect(result.tools).toHaveLength(1);
      expect((result.tools[0] as { name: string }).name).toBe('echo');
    });

    it('surfaces 401 as SessionInvalidError', async () => {
      const client = createIpcClient({
        runnerEndpoint: `http://127.0.0.1:${port}`,
        token: 'wrong-token',
        maxRetries: 0,
      });
      await expect(client.call('tool.list', {})).rejects.toThrow(
        SessionInvalidError,
      );
    });
  });

  it('rejects unsupported runnerEndpoint scheme', () => {
    expect(() =>
      createIpcClient({
        runnerEndpoint: 'ftp://nope/file',
        token: 'tok-abc',
      }),
    ).toThrow(HostUnavailableError);
  });

  it('rejects malformed runnerEndpoint URI', () => {
    expect(() =>
      createIpcClient({
        runnerEndpoint: 'not a valid uri',
        token: 'tok-abc',
      }),
    ).toThrow(HostUnavailableError);
  });

  it('event(): resolves on 202 even with empty body', async () => {
    const server = await startFakeServer();
    servers.push(server);
    server.setHandler(async (req, res) => {
      // Drain the body so the socket cleanly closes, then 202 no content.
      await readBody(req);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end();
    });
    const client = createIpcClient({
      runnerEndpoint: `unix://${server.socketPath}`,
      token: 'tok-abc',
    });
    await expect(
      client.event('event.turn-end', { reason: 'complete' }),
    ).resolves.toBeUndefined();
  });

  // ── maxElapsedMs wall-clock retry deadline (TASK-24) ──
  //
  // A host OOMKill + pod reschedule + boot takes longer than the old
  // ~3 s / 6-attempt retry budget, so the client used to give up and the
  // runner either dropped the turn (commit-notify → `kept`) or crashed
  // (session.next-message poll threw → exit 1). The default `maxElapsedMs`
  // (2 min) keeps the transient-error retry loop going long enough to ride
  // out the restart. We drive a FAKE clock via `now` + zero-wait backoff so
  // these run instantly without real timers.
  describe('maxElapsedMs deadline', () => {
    it('default retries an ECONNREFUSED far past the old 6-attempt budget (~2 min wall-clock)', async () => {
      // Dead unix socket → connect fails transiently every attempt. With the
      // default maxElapsedMs (120_000) and no explicit maxRetries, the client
      // keeps retrying until the fake clock crosses the deadline.
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-arc-dl-'));
      const deadSocketPath = path.join(tempDir, 'nope.sock');
      try {
        let clock = 0;
        let attempts = 0;
        const client = createIpcClient({
          runnerEndpoint: `unix://${deadSocketPath}`,
          token: 'tok-abc',
          now: () => clock,
          // Advance the fake clock by the would-be backoff; return 0 so the
          // real setTimeout is instant. Count attempts via the backoff calls
          // (one per retry decision).
          retryBackoff: (attempt) => {
            attempts = attempt + 1; // attempt is 0-indexed retry number
            clock += Math.min(100 * 2 ** attempt, 30_000);
            return 0;
          },
        });
        await expect(client.call('workspace.commit-notify', {})).rejects.toBeInstanceOf(
          HostUnavailableError,
        );
        // Old hard cap was 6 total tries; the deadline lets it go much further.
        expect(attempts).toBeGreaterThan(8);
        // The accumulated backoff must have reached the 2-min ballpark before
        // giving up (within one 30 s backoff step of the cap).
        expect(clock).toBeGreaterThanOrEqual(120_000 - 30_000);
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('tool.execute-host does NOT get the 2-min budget (non-idempotent → short, avoids replaying a side effect)', async () => {
      // A host tool may have completed its external side effect before the
      // response was lost; replaying it across a 2-min window would duplicate
      // the action (Codex). tool.execute-host keeps a SHORT connection budget.
      let attempts = 0;
      let clock = 0;
      const client = createIpcClient({
        runnerEndpoint: 'unix:///tmp/unused.sock',
        token: 'tok-abc',
        maxElapsedMs: 120_000, // default long — the per-action short budget must still bind
        now: () => clock,
        retryBackoff: (a) => {
          attempts = a + 1;
          clock += Math.min(100 * 2 ** a, 30_000);
          return 0;
        },
        __requestOnce: async () => {
          throw new HostUnavailableError('connect failed: ECONNREFUSED');
        },
      });
      await expect(client.call('tool.execute-host', {})).rejects.toBeInstanceOf(
        HostUnavailableError,
      );
      // Short 3s budget: 100+200+400+800+1600 = 3100 > 3000 → gives up around
      // the 4th–5th attempt, NOT the dozens a 2-min budget would allow.
      expect(attempts).toBeLessThanOrEqual(5);
      expect(clock).toBeLessThan(10_000);
    });

    it('workspace.commit-notify DOES get the long budget (idempotent → safe to ride out a restart)', async () => {
      let attempts = 0;
      let clock = 0;
      const client = createIpcClient({
        runnerEndpoint: 'unix:///tmp/unused.sock',
        token: 'tok-abc',
        maxElapsedMs: 120_000,
        now: () => clock,
        retryBackoff: (a) => {
          attempts = a + 1;
          clock += Math.min(100 * 2 ** a, 30_000);
          return 0;
        },
        __requestOnce: async () => {
          throw new HostUnavailableError('connect failed: ECONNREFUSED');
        },
      });
      await expect(
        client.call('workspace.commit-notify', {}),
      ).rejects.toBeInstanceOf(HostUnavailableError);
      expect(attempts).toBeGreaterThan(8); // rides out the full ~2 min
      expect(clock).toBeGreaterThanOrEqual(120_000 - 30_000);
    });

    it('a short maxElapsedMs gives up quickly', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-arc-dl2-'));
      const deadSocketPath = path.join(tempDir, 'nope.sock');
      try {
        let clock = 0;
        const client = createIpcClient({
          runnerEndpoint: `unix://${deadSocketPath}`,
          token: 'tok-abc',
          maxElapsedMs: 500,
          now: () => clock,
          retryBackoff: (attempt) => {
            clock += Math.min(100 * 2 ** attempt, 30_000);
            return 0;
          },
        });
        await expect(client.call('workspace.commit-notify', {})).rejects.toBeInstanceOf(
          HostUnavailableError,
        );
        // 100 + 200 = 300 < 500 <= 100+200+400 → stops at ~3 attempts.
        expect(clock).toBeLessThan(1000);
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('an explicit maxRetries still caps attempts even under a generous deadline', async () => {
      // Existing callers (and tests) pass maxRetries as a hard cap; that must
      // keep working — the loop exits on whichever of {count, deadline} comes
      // first.
      const server = await startFakeServer();
      servers.push(server);
      server.setHandler((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }));
      });
      const client = createIpcClient({
        runnerEndpoint: `unix://${server.socketPath}`,
        token: 'tok-abc',
        maxRetries: 2,
        maxElapsedMs: 120_000,
        retryBackoff: () => 5,
      });
      await expect(client.call('tool.list', {})).rejects.toBeInstanceOf(
        IpcRequestError,
      );
      // Initial + 2 retries = 3 attempts — maxRetries still bounds it.
      expect(server.callCount()).toBe(3);
    });

    it('does not wait out the deadline on a non-transient 4xx', async () => {
      const server = await startFakeServer();
      servers.push(server);
      server.setHandler((_req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'x' } }));
      });
      const client = createIpcClient({
        runnerEndpoint: `unix://${server.socketPath}`,
        token: 'tok-abc',
        maxElapsedMs: 120_000,
      });
      await expect(client.call('tool.list', {})).rejects.toBeInstanceOf(
        IpcRequestError,
      );
      expect(server.callCount()).toBe(1); // 4xx is never retried
    });

    it('a HostUnavailableError flagged non-retryable is NOT retried under the generous deadline', async () => {
      // The DETERMINISTIC over-cap response path (requestOnce) surfaces a
      // HostUnavailableError with `retryable: false`; the retry loop must fail
      // it fast instead of re-transferring the same too-large bytes for the
      // whole 2-min deadline (Codex round-4 P2). We drive the loop directly via
      // a `__requestOnce` test seam that rejects with such an error and assert
      // it is attempted exactly once.
      let attempts = 0;
      const client = createIpcClient({
        runnerEndpoint: 'unix:///tmp/unused.sock',
        token: 'tok-abc',
        maxElapsedMs: 120_000,
        retryBackoff: () => 0,
        __requestOnce: async () => {
          attempts += 1;
          throw new HostUnavailableError('response body exceeded cap', undefined, {
            retryable: false,
          });
        },
      });
      const err = await client.call('tool.list', {}).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HostUnavailableError);
      expect((err as HostUnavailableError).message).toContain('cap');
      expect(attempts).toBe(1); // non-retryable → exactly one attempt
    });

    it('a HostUnavailableError that IS retryable still retries (connection-level default)', async () => {
      let attempts = 0;
      let clock = 0;
      const client = createIpcClient({
        runnerEndpoint: 'unix:///tmp/unused.sock',
        token: 'tok-abc',
        maxRetries: 3,
        now: () => clock,
        retryBackoff: () => {
          clock += 10;
          return 0;
        },
        __requestOnce: async () => {
          attempts += 1;
          throw new HostUnavailableError('connect failed: ECONNREFUSED'); // retryable default
        },
      });
      await expect(client.call('tool.list', {})).rejects.toBeInstanceOf(
        HostUnavailableError,
      );
      expect(attempts).toBe(4); // initial + 3 retries
    });

    it('a persistent HTTP 5xx is capped at a SMALL count, not stretched to the 2-min deadline', async () => {
      // A deterministic application 5xx (tool internal error, schema drift)
      // won't heal by waiting, so it gets a small finite cap (MAX_5XX_RETRIES)
      // even under the generous default deadline — otherwise the runner stalls
      // for minutes re-issuing the same failing call (Codex round-5 P2).
      let attempts = 0;
      let clock = 0;
      const client = createIpcClient({
        runnerEndpoint: 'unix:///tmp/unused.sock',
        token: 'tok-abc',
        // No maxRetries → default unbounded; the 5xx CAP must bind, not the
        // 2-min wall-clock.
        maxElapsedMs: 120_000,
        now: () => clock,
        retryBackoff: () => {
          clock += 10; // tiny — nowhere near the 120_000 deadline
          return 0;
        },
        __requestOnce: async () => {
          attempts += 1;
          return {
            status: 500,
            body: Buffer.from(
              JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }),
            ),
          };
        },
      });
      await expect(client.call('tool.list', {})).rejects.toBeInstanceOf(
        IpcRequestError,
      );
      // initial + MAX_5XX_RETRIES (3) = 4 attempts — bounded by the 5xx cap,
      // NOT the (never-reached) wall-clock deadline.
      expect(attempts).toBe(4);
      expect(clock).toBeLessThan(1_000); // gave up promptly, didn't burn ~2 min
    });
  });
});
