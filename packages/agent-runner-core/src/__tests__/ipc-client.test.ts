import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
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

  it('call(llm.call): round-trips request and parses LlmCallResponse', async () => {
    const server = await startFakeServer();
    servers.push(server);
    let seenPath: string | undefined;
    let seenAuth: string | undefined;
    let seenBody: string | undefined;
    server.setHandler(async (req, res) => {
      seenPath = req.url;
      seenAuth = req.headers.authorization;
      seenBody = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          assistantMessage: { role: 'assistant', content: 'hi back' },
          toolCalls: [],
          stopReason: 'end_turn',
        }),
      );
    });
    const client = createIpcClient({
      socketPath: server.socketPath,
      token: 'tok-abc',
    });
    const result = await client.call('llm.call', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(seenPath).toBe('/llm.call');
    expect(seenAuth).toBe('Bearer tok-abc');
    expect(seenBody).toBeDefined();
    expect(JSON.parse(seenBody!)).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toMatchObject({
      assistantMessage: { role: 'assistant', content: 'hi back' },
      toolCalls: [],
    });
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
      socketPath: server.socketPath,
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
      socketPath: server.socketPath,
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
      socketPath: server.socketPath,
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
        socketPath: deadSocketPath,
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
      socketPath: server.socketPath,
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
      socketPath: server.socketPath,
      token: 'tok-abc',
    });
    const result = await client.callGet('session.next-message', { cursor: '0' });
    expect(seenMethod).toBe('GET');
    expect(seenUrl).toBe('/session.next-message?cursor=0');
    expect(result).toEqual({ type: 'timeout', cursor: 0 });
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
      socketPath: server.socketPath,
      token: 'tok-abc',
    });
    await expect(
      client.event('event.turn-end', { reason: 'complete' }),
    ).resolves.toBeUndefined();
  });
});
