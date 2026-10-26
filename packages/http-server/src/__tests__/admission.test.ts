import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type KernelHandle,
  type Plugin,
} from '@ax/core';
import { createHttpServerPlugin } from '../plugin.js';
import type { HttpRegisterRouteInput, HttpRegisterRouteOutput } from '../types.js';

// ---------------------------------------------------------------------------
// TASK-942: the public listener answers only a fully wired host.
//
// Each test boots a kernel shaped like production: http-server, then a
// routines stand-in (joined shutdown, like @ax/routines), then a channel-web
// stand-in that owns the task route. The kernel inits in that order and shuts
// down in reverse, so the task route exists only between the last init() and
// the first shutdown(). The listener used to be open on both sides of that
// window, and its router answered 404 for a task that exists.
// ---------------------------------------------------------------------------

process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
const COOKIE_KEY = randomBytes(32);
const TASK_PATH = '/api/workspace/tasks/a1/r1';
// Each awaited step takes milliseconds. The bound only turns a regression that
// blocks into a named failure instead of a hung test.
const STEP_MS = 3_000;
const TEST_MS = 15_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => {
        if (typeof addr === 'object' && addr !== null) resolve(addr.port);
        else reject(new Error('failed to pick free port'));
      });
    });
  });
}

/** What a client sees: the status of a complete answer, or no answer at all. */
async function outcome(url: string): Promise<number | 'no-response'> {
  try {
    const res = await fetch(url);
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 'no-response';
  }
}

function routinesStub(gates: { initGate?: Promise<void>; drainGate?: Promise<void> } = {}) {
  const entered = deferred();
  const draining = deferred();
  const plugin: Plugin = {
    manifest: {
      name: 'test/routines',
      version: '0.0.0',
      registers: ['routines:get'],
      calls: [],
      subscribes: [],
    },
    shutdownMode: 'joined',
    async init({ bus }) {
      entered.resolve();
      await gates.initGate;
      bus.registerService('routines:get', 'test/routines', async () => ({}));
    },
    async shutdown() {
      draining.resolve();
      await gates.drainGate;
    },
  };
  return { plugin, entered: entered.promise, draining: draining.promise };
}

function taskRoutesStub() {
  const slowEntered = deferred();
  const slowGate = deferred();
  const holdEntered = deferred();
  const holdGate = deferred();
  const unregisters: Array<() => void> = [];
  const routes: HttpRegisterRouteInput[] = [
    {
      method: 'GET',
      path: '/api/workspace/tasks/:agentId/:routineId',
      handler: async (_req, res) => {
        res.status(200).json({ ok: true });
      },
    },
    {
      method: 'GET',
      path: '/slow',
      handler: async (_req, res) => {
        slowEntered.resolve();
        await slowGate.promise;
        res.status(200).text('slow-done');
      },
    },
    {
      // A response that stays open, like the chat or memory-events stream.
      method: 'GET',
      path: '/hold',
      handler: async (_req, res) => {
        holdEntered.resolve();
        await holdGate.promise;
        res.status(200).text('hold-done');
      },
    },
  ];
  const plugin: Plugin = {
    manifest: {
      name: 'test/task-routes',
      version: '0.0.0',
      registers: [],
      calls: ['http:register-route'],
      optionalCalls: [{ hook: 'routines:get', degradation: 'test' }],
      subscribes: [],
    },
    async init({ bus }) {
      const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
      for (const route of routes) {
        const out = await bus.call<HttpRegisterRouteInput, HttpRegisterRouteOutput>(
          'http:register-route',
          ctx,
          route,
        );
        unregisters.push(out.unregister);
      }
    },
    // Like channel-web: its routes go when it shuts down.
    shutdown() {
      for (const unregister of unregisters.splice(0)) unregister();
    },
  };
  return {
    plugin,
    slowEntered: slowEntered.promise,
    releaseSlow: () => slowGate.resolve(),
    holdEntered: holdEntered.promise,
    releaseHold: () => holdGate.resolve(),
  };
}

function productionShapedKernel(
  port: number,
  gates: { initGate?: Promise<void>; drainGate?: Promise<void> } = {},
  shutdownTimeoutMs?: number,
) {
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port,
    cookieKey: COOKIE_KEY,
    allowedOrigins: [],
  });
  const routines = routinesStub(gates);
  const routes = taskRoutesStub();
  const shutdownErrors: string[] = [];
  const boot = (): Promise<KernelHandle> =>
    bootstrap({
      bus: new HookBus(),
      plugins: [http, routines.plugin, routes.plugin],
      config: {},
      ...(shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs } : {}),
      onShutdownError: (name, err) => {
        shutdownErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      },
    });
  return { http, routines, routes, boot, shutdownErrors };
}

/** A raw keep-alive connection. Unlike fetch, it never closes on its own. */
function rawConnection(port: number) {
  const sock = net.connect(port, '127.0.0.1');
  // The server may reset this socket; an unhandled 'error' would crash the worker.
  sock.on('error', () => {});
  let received = '';
  const slowAnswered = deferred();
  sock.on('data', (chunk: Buffer) => {
    received += chunk.toString('latin1');
    if (received.includes('slow-done')) slowAnswered.resolve();
  });
  const closed = new Promise<true>((resolve) => sock.once('close', () => resolve(true)));
  return {
    sock,
    received: () => received,
    slowAnswered: slowAnswered.promise,
    closed,
  };
}

describe('@ax/http-server admission (TASK-942)', () => {
  it(
    'while routines is still in init(), the task route gets no answer at all, never a 404, then 200 once bootstrap resolves',
    async () => {
      const port = await pickFreePort();
      const url = `http://127.0.0.1:${port}${TASK_PATH}`;
      const initGate = deferred();
      const k = productionShapedKernel(port, { initGate: initGate.promise });
      const booting = k.boot();
      try {
        await within(k.routines.entered, STEP_MS, "routines' init()");
        expect(await outcome(url)).toBe('no-response');
        expect(() => k.http.boundPort()).toThrow(PluginError);

        initGate.resolve();
        await within(booting, STEP_MS, 'bootstrap()');
        expect(k.http.boundPort()).toBe(port);
        expect(await outcome(url)).toBe(200);
      } finally {
        initGate.resolve();
        await booting.then((handle) => handle.shutdown(), () => {});
      }
      expect(k.shutdownErrors).toEqual([]);
    },
    TEST_MS,
  );

  it(
    'once shutdown begins, the task route gets no answer while routines drains, never a 404',
    async () => {
      const drainGate = deferred();
      const k = productionShapedKernel(0, { drainGate: drainGate.promise });
      const handle = await k.boot();
      try {
        const url = `http://127.0.0.1:${k.http.boundPort()}${TASK_PATH}`;
        expect(await outcome(url)).toBe(200);

        void handle.shutdown();
        await within(k.routines.draining, STEP_MS, "routines' drain");
        // The task route is unregistered by now, as channel-web's is in production.
        expect(await outcome(url)).toBe('no-response');
      } finally {
        drainGate.resolve();
        await handle.shutdown();
      }
      expect(k.shutdownErrors).toEqual([]);
    },
    TEST_MS,
  );

  it(
    'a request on a kept-alive connection that was busy when shutdown began is dropped, not routed',
    async () => {
      const drainGate = deferred();
      const k = productionShapedKernel(0, { drainGate: drainGate.promise });
      const handle = await k.boot();
      const conn = rawConnection(k.http.boundPort());
      const stderr = vi.spyOn(process.stderr, 'write');
      let lines: string[] = [];
      try {
        conn.sock.write('GET /slow HTTP/1.1\r\nHost: t\r\nConnection: keep-alive\r\n\r\n');
        await within(k.routes.slowEntered, STEP_MS, '/slow to be admitted');

        void handle.shutdown();
        // Reached only if stopAdmission() does not wait for the busy connection.
        await within(
          k.routines.draining,
          STEP_MS,
          "routines' drain (stopAdmission() must not wait for open connections)",
        );
        k.routes.releaseSlow();
        await within(conn.slowAnswered, STEP_MS, 'the /slow answer');

        // Node keeps this socket after close(), so the next request reaches the server.
        conn.sock.write(`GET ${TASK_PATH} HTTP/1.1\r\nHost: t\r\n\r\n`);
        const closed = await within(conn.closed, 2_000, 'the socket to close').catch(() => false);
        expect(conn.received().match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200']);
        expect(closed).toBe(true);
      } finally {
        conn.sock.destroy();
        k.routes.releaseSlow();
        drainGate.resolve();
        await handle.shutdown();
        lines = stderr.mock.calls.map((c) => String(c[0]));
        stderr.mockRestore();
      }
      expect(k.shutdownErrors).toEqual([]);
      // The drop is not silent: the stop and the refused request are both logged.
      expect(lines.filter((l) => l.includes('[ax/http-server] stopped accepting requests'))).toHaveLength(1);
      expect(
        lines.filter((l) => l.includes('[ax/http-server] dropped 1 request that arrived after it stopped accepting')),
      ).toHaveLength(1);
    },
    TEST_MS,
  );

  it(
    'a port already in use still fails the boot',
    async () => {
      const blocker = net.createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(0, '127.0.0.1', () => resolve());
      });
      const port = (blocker.address() as net.AddressInfo).port;
      const shutdownErrors: unknown[] = [];
      try {
        await expect(
          bootstrap({
            bus: new HookBus(),
            plugins: [createHttpServerPlugin({ host: '127.0.0.1', port, cookieKey: COOKIE_KEY })],
            config: {},
            onShutdownError: (_name, err) => {
              shutdownErrors.push(err);
            },
          }),
        ).rejects.toMatchObject({
          name: 'PluginError',
          code: 'init-failed',
          plugin: '@ax/http-server',
          message: expect.stringMatching(/EADDRINUSE/),
        });
        // No shutdown reported an error (the kernel tests check that the rollback ran).
        expect(shutdownErrors).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    },
    TEST_MS,
  );

  it(
    'shutdown() closes a connection that went idle after the stop, instead of waiting out keep-alive',
    async () => {
      const drainGate = deferred();
      const k = productionShapedKernel(0, { drainGate: drainGate.promise });
      const handle = await k.boot();
      const conn = rawConnection(k.http.boundPort());
      try {
        conn.sock.write('GET /slow HTTP/1.1\r\nHost: t\r\nConnection: keep-alive\r\n\r\n');
        await within(k.routes.slowEntered, STEP_MS, '/slow to be admitted');

        const stopping = handle.shutdown();
        await within(k.routines.draining, STEP_MS, "routines' drain");
        k.routes.releaseSlow();
        await within(conn.slowAnswered, STEP_MS, 'the /slow answer');

        // The connection is idle and kept alive, and this client never closes
        // it. Left to keep-alive, the server would hold it about 6 s.
        drainGate.resolve();
        await within(stopping, STEP_MS, 'shutdown() (it must not wait out keep-alive)');
        await within(conn.closed, STEP_MS, 'the server to close the idle connection');
      } finally {
        conn.sock.destroy();
        k.routes.releaseSlow();
        drainGate.resolve();
        await handle.shutdown();
      }
      expect(k.shutdownErrors).toEqual([]);
    },
    TEST_MS,
  );

  it(
    'the dropped-request count is logged even while an open stream holds the close past its timeout',
    async () => {
      const drainGate = deferred();
      const k = productionShapedKernel(0, { drainGate: drainGate.promise }, 300);
      const handle = await k.boot();
      const stream = rawConnection(k.http.boundPort());
      const conn = rawConnection(k.http.boundPort());
      const stderr = vi.spyOn(process.stderr, 'write');
      let lines: string[] = [];
      try {
        // A response that never ends while shutdown runs, so the close never settles.
        stream.sock.write('GET /hold HTTP/1.1\r\nHost: t\r\nConnection: keep-alive\r\n\r\n');
        await within(k.routes.holdEntered, STEP_MS, '/hold to be admitted');
        conn.sock.write('GET /slow HTTP/1.1\r\nHost: t\r\nConnection: keep-alive\r\n\r\n');
        await within(k.routes.slowEntered, STEP_MS, '/slow to be admitted');

        const stopping = handle.shutdown();
        await within(k.routines.draining, STEP_MS, "routines' drain");
        k.routes.releaseSlow();
        await within(conn.slowAnswered, STEP_MS, 'the /slow answer');
        conn.sock.write(`GET ${TASK_PATH} HTTP/1.1\r\nHost: t\r\n\r\n`);
        await within(conn.closed, STEP_MS, 'the dropped request to close its socket');

        drainGate.resolve();
        // http-server's shutdown() times out on the held close, and the kernel moves on.
        await within(stopping, STEP_MS, 'shutdown()');
        lines = stderr.mock.calls.map((c) => String(c[0]));
      } finally {
        stderr.mockRestore();
        k.routes.releaseHold();
        stream.sock.destroy();
        conn.sock.destroy();
        k.routes.releaseSlow();
        drainGate.resolve();
        await handle.shutdown();
      }
      expect(
        lines.filter((l) => l.includes('[ax/http-server] dropped 1 request that arrived after it stopped accepting')),
      ).toHaveLength(1);
      expect(k.shutdownErrors).toEqual([expect.stringMatching(/^@ax\/http-server: .*shutdown exceeded 300ms/)]);
    },
    TEST_MS,
  );
});
