import { PluginError, type ServiceHandler } from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import pg from 'pg';
import { createDiskQuotaPlugin, type DiskQuotaPlugin, type DiskQuotaPluginConfig } from '../plugin.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

export const MB = 1_048_576;

export interface CapturedRoute {
  method: string;
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  maxBodyBytes?: number;
}

export interface Booted {
  harness: TestHarness;
  plugin: DiskQuotaPlugin;
  routes: CapturedRoute[];
  unregistered: string[];
  storage: Map<string, Uint8Array>;
  clock: { now: Date; set(d: Date): void; advance(ms: number): void };
  setAuth(a: { id: string; isAdmin: boolean } | 'throw'): void;
  request(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      rawBody?: Buffer;
      params?: Record<string, string>;
      query?: Record<string, string>;
    },
  ): Promise<{ status: number; json: unknown }>;
}

export async function bootDiskQuota(opts: {
  connectionString: string;
  services?: Record<string, ServiceHandler>;
  config?: DiskQuotaPluginConfig;
}): Promise<Booted> {
  const routes: CapturedRoute[] = [];
  const unregistered: string[] = [];
  const storage = new Map<string, Uint8Array>();
  let auth: { id: string; isAdmin: boolean } | 'throw' = { id: 'admin-1', isAdmin: true };
  let now = new Date('2026-09-29T12:00:00.000Z');
  const clock = {
    get now() {
      return now;
    },
    set(d: Date) {
      now = d;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };

  const services: Record<string, ServiceHandler> = {
    'storage:get': (async (_ctx: unknown, input: { key: string }) => ({
      value: storage.get(input.key),
    })) as ServiceHandler,
    'storage:set': (async (_ctx: unknown, input: { key: string; value: Uint8Array }) => {
      storage.set(input.key, input.value);
      return {};
    }) as ServiceHandler,
    'http:register-route': (async (_ctx: unknown, input: CapturedRoute) => {
      routes.push(input);
      return {
        unregister: () => {
          unregistered.push(`${input.method} ${input.path}`);
        },
      };
    }) as ServiceHandler,
    'auth:require-user': (async () => {
      if (auth === 'throw') {
        throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'no cookie' });
      }
      return { user: auth };
    }) as ServiceHandler,
    ...(opts.services ?? {}),
  };

  // The sweep is off unless a test asks for it: a timer must never make an
  // unrelated test flaky.
  const plugin = createDiskQuotaPlugin({
    now: () => now,
    sweepIntervalMs: 0,
    ...(opts.config ?? {}),
  });
  const harness = await createTestHarness({
    services,
    plugins: [createDatabasePostgresPlugin({ connectionString: opts.connectionString }), plugin],
  });

  return {
    harness,
    plugin,
    routes,
    unregistered,
    storage,
    clock,
    setAuth(a) {
      auth = a;
    },
    async request(method, path, o = {}) {
      const route = routes.find((r) => r.method === method && r.path === path);
      if (route === undefined) throw new Error(`no route ${method} ${path}`);
      let status = 200;
      let json: unknown;
      const res: RouteResponse = {
        status(n) {
          status = n;
          return res;
        },
        header() {
          return res;
        },
        json(v) {
          json = v;
        },
        text() {},
        end() {},
      };
      const req: RouteRequest = {
        headers: {},
        body:
          o.rawBody ??
          (o.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(o.body))),
        cookies: {},
        query: o.query ?? {},
        params: o.params ?? {},
        signedCookie: () => null,
      };
      await route.handler(req, res);
      return { status, json };
    },
  };
}

/** Wipe the plugin's rows between tests (one container per file). */
export async function truncateDiskQuotaTables(connectionString: string): Promise<void> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    await c.query('TRUNCATE disk_quota_v1_usage');
  } catch {
    /* table not created yet */
  } finally {
    await c.end().catch(() => {});
  }
}
