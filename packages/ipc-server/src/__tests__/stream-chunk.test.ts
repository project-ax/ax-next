import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  SessionCreateInput,
  SessionCreateOutput,
} from '@ax/session-inmemory';
import { createListener, type Listener } from '../listener.js';

// ---------------------------------------------------------------------------
// Integration test: POST /event.stream-chunk through the full @ax/ipc-server
// listener pipeline (auth gate + dispatcher + handler + bus subscriber).
//
// Mirrors the dispatcher-level happy-path test but exercises the real listener
// surface (unix socket, all five inbound gates, real authenticate() call) so
// we have a regression guard if the listener ever short-circuits or rewrites
// /event.stream-chunk before reaching the dispatcher.
// ---------------------------------------------------------------------------

interface Harness {
  listener: Listener;
  token: string;
  socketPath: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(
  subscribers: Array<{
    hook: string;
    plugin?: string;
    handler: (ctx: unknown, payload: unknown) => Promise<unknown>;
  }> = [],
): Promise<Harness> {
  const sessionId = 's-stream-chunk';
  const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
  for (const sub of subscribers) {
    h.bus.subscribe(sub.hook, sub.plugin ?? 'mock', sub.handler as never);
  }
  const ctx = h.ctx();
  const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
    'session:create',
    ctx,
    { sessionId, workspaceRoot: '/tmp/ws' },
  );
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-stream-chunk-'));
  const socketPath = path.join(tempDir, 'ipc.sock');
  const listener = await createListener({ socketPath, sessionId, bus: h.bus });
  return {
    listener,
    token,
    socketPath,
    cleanup: async () => {
      await listener.close();
      try {
        await fsp.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

interface Response {
  status: number;
  body: string;
}

function postJson(
  socketPath: string,
  reqPath: string,
  token: string,
  body: string,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const buf = Buffer.from(body, 'utf8');
    const req = http.request(
      {
        socketPath,
        path: reqPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(buf.length),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

describe('@ax/ipc-server: POST /event.stream-chunk integration', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const h of harnesses) await h.cleanup();
    harnesses.length = 0;
  });

  it('routes /event.stream-chunk through dispatcher and fires chat:stream-chunk', async () => {
    let received: unknown = null;
    let resolved: (v: unknown) => void;
    const firePromise = new Promise<unknown>((resolve) => {
      resolved = resolve;
    });
    const h = await makeHarness([
      {
        hook: 'chat:stream-chunk',
        handler: async (_ctx, payload) => {
          received = payload;
          resolved(payload);
          return undefined;
        },
      },
    ]);
    harnesses.push(h);

    const body = { reqId: 'req-int-1', text: 'streaming-piece', kind: 'text' as const };
    const res = await postJson(
      h.socketPath,
      '/event.stream-chunk',
      h.token,
      JSON.stringify(body),
    );
    expect(res.status).toBe(202);
    await firePromise;
    expect(received).toEqual(body);
  });

  it('rejects malformed payload (missing kind) with 400 VALIDATION', async () => {
    const h = await makeHarness();
    harnesses.push(h);
    const res = await postJson(
      h.socketPath,
      '/event.stream-chunk',
      h.token,
      JSON.stringify({ reqId: 'r1', text: 'hi' }),
    );
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('VALIDATION');
  });
});
