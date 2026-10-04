import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  answerBlobCollectRefs,
  BLOB_COLLECT_REFS_HOOK,
  makeAgentContext,
  PluginError,
  type ServiceHandler,
} from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  createTestHarness,
  startTestContainer,
  stopPostgresContainer,
  type TestHarness,
} from '@ax/test-harness';
import pg from 'pg';
import { DEFAULT_SETTINGS, SETTINGS_BOUNDS, SETTINGS_STORAGE_KEY } from '../config.js';
import { createBlobGcPlugin, type BlobGcPlugin } from '../plugin.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

const HOUR = 3_600_000;
const S = 'a'.repeat(64);

let container: StartedPostgreSqlContainer;
let connectionString: string;

interface Route {
  method: string;
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  maxBodyBytes?: number;
}

interface Booted {
  harness: TestHarness;
  plugin: BlobGcPlugin;
  routes: Route[];
  unregistered: string[];
  storage: Map<string, Uint8Array>;
  listed: Map<string, number>;
  clock: { advance(ms: number): void };
  setAuth(a: { id: string; isAdmin: boolean } | 'throw'): void;
  request(method: string, opts?: { body?: unknown; rawBody?: Buffer }): Promise<{ status: number; json: unknown }>;
}

const booted: Booted[] = [];

async function boot(services: Record<string, ServiceHandler> = {}): Promise<Booted> {
  const routes: Route[] = [];
  const unregistered: string[] = [];
  const storage = new Map<string, Uint8Array>();
  const listed = new Map<string, number>();
  let auth: { id: string; isAdmin: boolean } | 'throw' = { id: 'admin-1', isAdmin: true };
  let t = Date.parse('2026-10-04T00:00:00.000Z');

  const plugin = createBlobGcPlugin({ now: () => new Date(t), sweepIntervalMs: 0 });
  const harness = await createTestHarness({
    services: {
      'storage:get': (async (_c: unknown, { key }: { key: string }) => ({
        value: storage.get(key),
      })) as ServiceHandler,
      'storage:set': (async (_c: unknown, { key, value }: { key: string; value: Uint8Array }) => {
        storage.set(key, value);
        return {};
      }) as ServiceHandler,
      'blob:list': (async (_c: unknown, { after }: { after?: string }) => ({
        items: [...listed]
          .filter(([s]) => after === undefined || s > after)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([sha256, size]) => ({ sha256, size })),
      })) as ServiceHandler,
      'http:register-route': (async (_c: unknown, route: Route) => {
        routes.push(route);
        return { unregister: () => unregistered.push(`${route.method} ${route.path}`) };
      }) as ServiceHandler,
      'auth:require-user': (async () => {
        if (auth === 'throw') {
          throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'no cookie' });
        }
        return { user: auth };
      }) as ServiceHandler,
      ...services,
    },
    plugins: [createDatabasePostgresPlugin({ connectionString }), plugin],
  });

  const b: Booted = {
    harness,
    plugin,
    routes,
    unregistered,
    storage,
    listed,
    clock: {
      advance(ms) {
        t += ms;
      },
    },
    setAuth(a) {
      auth = a;
    },
    async request(method, o = {}) {
      const route = routes.find((r) => r.method === method && r.path === '/admin/storage/cleanup');
      if (route === undefined) throw new Error(`no route ${method}`);
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
        body: o.rawBody ?? (o.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(o.body))),
        cookies: {},
        query: {},
        params: {},
        signedCookie: () => null,
      };
      await route.handler(req, res);
      return { status, json };
    },
  };
  booted.push(b);
  return b;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (booted.length > 0) await booted.pop()!.harness.close({ onError: () => {} });
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    await c.query('TRUNCATE blob_gc_v1_blobs, blob_gc_v1_roster');
  } catch {
    /* not created yet */
  } finally {
    await c.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/blob-gc plugin', () => {
  it('manifest: report mode only, with no hook that could free a byte', () => {
    const p = createBlobGcPlugin();
    expect(p.manifest).toEqual({
      name: '@ax/blob-gc',
      version: '0.0.0',
      registers: [],
      calls: [
        'database:get-instance',
        'blob:list',
        'storage:get',
        'storage:set',
        'http:register-route',
        'auth:require-user',
      ],
      subscribes: ['blob:stored'],
    });
    const reach = [...p.manifest.calls, ...(p.manifest.optionalCalls ?? []).map((c) => c.hook)];
    for (const hook of ['blob:delete', 'blob:retire', 'blob:purge', 'blob:put']) {
      expect(reach).not.toContain(hook);
    }
  });

  it('sweep() before init is a skip, not a throw', async () => {
    expect(await createBlobGcPlugin().sweep()).toEqual({ outcome: 'skipped' });
  });

  it('records every blob:stored notice in its own table', async () => {
    const b = await boot();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    await b.harness.bus.fire('blob:stored', ctx, { sha256: S, size: 42 });
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      const r = await c.query('SELECT sha256, size::int AS size, state FROM blob_gc_v1_blobs');
      expect(r.rows).toEqual([{ sha256: S, size: 42, state: 'live' }]);
    } finally {
      await c.end();
    }
  });

  it('a sweep through the plugin reports what nobody holds', async () => {
    const b = await boot();
    b.harness.bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, '@ax/attachments', async (_c, payload) =>
      answerBlobCollectRefs(payload, '@ax/attachments', async () => []),
    );
    b.listed.set(S, 9000);
    expect(await b.plugin.sweep()).toMatchObject({ report: { discovered: 1, candidates: 0 } });
    b.clock.advance(25 * HOUR);
    expect(await b.plugin.sweep()).toMatchObject({
      outcome: 'reported',
      report: { mode: 'report', candidates: 1, wouldRetire: 1, wouldRetireBytes: 9000 },
    });
  });

  it('shutdown unregisters both routes', async () => {
    const b = await boot();
    expect(b.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /admin/storage/cleanup',
      'PUT /admin/storage/cleanup',
    ]);
    await b.harness.close({ onError: () => {} });
    booted.pop();
    expect(b.unregistered.sort()).toEqual(['GET /admin/storage/cleanup', 'PUT /admin/storage/cleanup']);
  });
});

describe('/admin/storage/cleanup', () => {
  it('401 when signed out, 403 for a non-admin, on both verbs', async () => {
    const b = await boot();
    b.setAuth('throw');
    expect((await b.request('GET')).status).toBe(401);
    expect((await b.request('PUT', { body: { graceMs: 2 * HOUR } })).status).toBe(401);
    b.setAuth({ id: 'bob', isAdmin: false });
    expect((await b.request('GET')).status).toBe(403);
    expect((await b.request('PUT', { body: { graceMs: 2 * HOUR } })).status).toBe(403);
    expect(b.storage.has(SETTINGS_STORAGE_KEY)).toBe(false);
  });

  it('GET answers the settings and report: null before any sweep, then the last report', async () => {
    const b = await boot();
    expect(await b.request('GET')).toEqual({
      status: 200,
      json: {
        settings: { ...DEFAULT_SETTINGS },
        defaults: { ...DEFAULT_SETTINGS },
        bounds: { graceMs: { ...SETTINGS_BOUNDS.graceMs }, retentionMs: { ...SETTINGS_BOUNDS.retentionMs } },
        report: null,
      },
    });
    b.listed.set(S, 1);
    const swept = await b.plugin.sweep();
    expect(swept.outcome).toBe('reported');
    const got = await b.request('GET');
    expect((got.json as { report: unknown }).report).toEqual((swept as { report: unknown }).report);
  });

  it('PUT changes only the fields sent, and the sweep uses them', async () => {
    const b = await boot();
    const put = await b.request('PUT', { body: { graceMs: 2 * HOUR } });
    expect(put).toEqual({ status: 200, json: { settings: { ...DEFAULT_SETTINGS, graceMs: 2 * HOUR } } });
    expect(await b.request('PUT', { body: { retentionMs: 3 * 24 * HOUR } })).toMatchObject({
      json: { settings: { graceMs: 2 * HOUR, retentionMs: 3 * 24 * HOUR, mode: 'report' } },
    });
  });

  it('PUT refuses enforce (not in this card), unknown fields, out-of-bounds values and junk', async () => {
    const b = await boot();
    for (const body of [
      { mode: 'enforce' },
      { mode: 'delete-everything' },
      { graceMs: SETTINGS_BOUNDS.graceMs.min - 1 },
      { retentionMs: SETTINGS_BOUNDS.retentionMs.max + 1 },
      { graceMs: 1.5 * HOUR + 0.5 },
      { surprise: 1 },
    ]) {
      expect(await b.request('PUT', { body }), JSON.stringify(body)).toEqual({
        status: 400,
        json: { error: 'invalid-settings' },
      });
    }
    expect(await b.request('PUT', { rawBody: Buffer.from('{nope') })).toEqual({
      status: 400,
      json: { error: 'invalid-json' },
    });
    expect(await b.request('PUT', { rawBody: Buffer.alloc(5000, 32) })).toEqual({
      status: 413,
      json: { error: 'body-too-large' },
    });
    expect(b.storage.has(SETTINGS_STORAGE_KEY)).toBe(false);
  });

  it('a corrupt or out-of-bounds stored setting falls back to the defaults per field', async () => {
    const b = await boot();
    b.storage.set(SETTINGS_STORAGE_KEY, new TextEncoder().encode('not json'));
    expect((await b.request('GET')).json).toMatchObject({ settings: { ...DEFAULT_SETTINGS } });
    b.storage.set(
      SETTINGS_STORAGE_KEY,
      new TextEncoder().encode(JSON.stringify({ mode: 'enforce', graceMs: 2 * HOUR, retentionMs: -1 })),
    );
    expect((await b.request('GET')).json).toMatchObject({
      settings: { mode: 'report', graceMs: 2 * HOUR, retentionMs: DEFAULT_SETTINGS.retentionMs },
    });
  });
});
