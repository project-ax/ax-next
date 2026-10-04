import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
  /** Backend write/stat calls the GC made, as `hook sha`. */
  blobCalls: string[];
  clock: { advance(ms: number): void };
  setAuth(a: { id: string; isAdmin: boolean } | 'throw'): void;
  request(
    method: string,
    opts?: { body?: unknown; rawBody?: Buffer; path?: string },
  ): Promise<{ status: number; json: unknown }>;
}

const booted: Booted[] = [];

async function boot(services: Record<string, ServiceHandler> = {}): Promise<Booted> {
  const routes: Route[] = [];
  const unregistered: string[] = [];
  const storage = new Map<string, Uint8Array>();
  const listed = new Map<string, number>();
  const blobCalls: string[] = [];
  const recordBlobCall = (hook: string) =>
    (async (_c: unknown, { sha256 }: { sha256: string }) => {
      blobCalls.push(`${hook} ${sha256}`);
      return hook === 'blob:stat' ? { size: 1 } : {};
    }) as ServiceHandler;
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
      'blob:list': (async (_c: unknown, { after, state }: { after?: string; state: string }) => ({
        items: [...(state === 'live' ? listed : new Map<string, number>())]
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
      'blob:retire': recordBlobCall('blob:retire'),
      'blob:purge': recordBlobCall('blob:purge'),
      'blob:stat': recordBlobCall('blob:stat'),
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
    blobCalls,
    clock: {
      advance(ms) {
        t += ms;
      },
    },
    setAuth(a) {
      auth = a;
    },
    async request(method, o = {}) {
      const path = o.path ?? '/admin/storage/cleanup';
      const route = routes.find((r) => r.method === method && r.path === path);
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
  it('manifest: the backend hooks enforce mode needs, and no raw delete or put', () => {
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
        'blob:stat',
        'blob:retire',
        'blob:purge',
      ],
      subscribes: ['blob:stored'],
    });
    const reach = [...p.manifest.calls, ...(p.manifest.optionalCalls ?? []).map((c) => c.hook)];
    for (const hook of ['blob:delete', 'blob:put', 'blob:put-internal']) {
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
    expect(b.blobCalls).toEqual([]);
  });

  it('an admin switching to enforce through the route makes the next sweep retire', async () => {
    const b = await boot();
    b.harness.bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, '@ax/attachments', async (_c, payload) =>
      answerBlobCollectRefs(payload, '@ax/attachments', async () => []),
    );
    b.listed.set(S, 9000);
    await b.plugin.sweep();
    b.clock.advance(25 * HOUR);
    expect((await b.request('PUT', { body: { mode: 'enforce' } })).status).toBe(200);
    expect(await b.plugin.sweep()).toMatchObject({
      outcome: 'reported',
      report: { mode: 'enforce', wouldRetire: 1, retired: 1 },
    });
    expect(b.blobCalls).toEqual([`blob:retire ${S}`]);
  });

  it('shutdown unregisters every route', async () => {
    const b = await boot();
    const all = [
      'GET /admin/storage/cleanup',
      'PUT /admin/storage/cleanup',
      'POST /admin/storage/blob-gc/roster/forget',
    ];
    expect(b.routes.map((r) => `${r.method} ${r.path}`)).toEqual(all);
    await b.harness.close({ onError: () => {} });
    booted.pop();
    expect(b.unregistered.sort()).toEqual([...all].sort());
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

  it('PUT accepts mode enforce, and back to report', async () => {
    const b = await boot();
    expect(await b.request('PUT', { body: { mode: 'enforce' } })).toEqual({
      status: 200,
      json: { settings: { ...DEFAULT_SETTINGS, mode: 'enforce' } },
    });
    expect((await b.request('GET')).json).toMatchObject({ settings: { mode: 'enforce' } });
    expect(await b.request('PUT', { body: { mode: 'report' } })).toMatchObject({
      status: 200,
      json: { settings: { mode: 'report' } },
    });
  });

  it('PUT refuses other modes, unknown fields, out-of-bounds values and junk', async () => {
    const b = await boot();
    for (const body of [
      { mode: 'delete-everything' },
      { mode: 'Enforce' },
      { mode: '' },
      { mode: true },
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
      new TextEncoder().encode(JSON.stringify({ mode: 'purge-all', graceMs: 2 * HOUR, retentionMs: -1 })),
    );
    expect((await b.request('GET')).json).toMatchObject({
      settings: { mode: 'report', graceMs: 2 * HOUR, retentionMs: DEFAULT_SETTINGS.retentionMs },
    });
  });
});

describe('POST /admin/storage/blob-gc/roster/forget', () => {
  const FORGET = '/admin/storage/blob-gc/roster/forget';

  async function roster(): Promise<string[]> {
    const c = new pg.Client({ connectionString });
    await c.connect();
    try {
      const r = await c.query('SELECT holder FROM blob_gc_v1_roster ORDER BY holder');
      return r.rows.map((x: { holder: string }) => x.holder);
    } finally {
      await c.end();
    }
  }

  async function bootWithRoster(): Promise<Booted> {
    const b = await boot();
    for (const name of ['@ax/attachments', '@ax/old-plugin']) {
      b.harness.bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, name, async (_c, payload) =>
        answerBlobCollectRefs(payload, name, async () => []),
      );
    }
    expect(await b.plugin.sweep()).toMatchObject({ outcome: 'reported' });
    expect(await roster()).toEqual(['@ax/attachments', '@ax/old-plugin']);
    return b;
  }

  it('401 when signed out, 403 for a non-admin; the roster is untouched', async () => {
    const b = await bootWithRoster();
    b.setAuth('throw');
    expect(await b.request('POST', { path: FORGET, body: { holder: '@ax/old-plugin' } })).toEqual({
      status: 401,
      json: { error: 'unauthenticated' },
    });
    b.setAuth({ id: 'bob', isAdmin: false });
    expect(await b.request('POST', { path: FORGET, body: { holder: '@ax/old-plugin' } })).toEqual({
      status: 403,
      json: { error: 'forbidden' },
    });
    expect(await roster()).toEqual(['@ax/attachments', '@ax/old-plugin']);
  });

  it('400 for a bad body, 413 for a huge one', async () => {
    const b = await bootWithRoster();
    for (const body of [{}, { holder: '' }, { holder: 'x'.repeat(201) }, { holder: 7 }, { holder: 'a', extra: 1 }, []]) {
      expect(await b.request('POST', { path: FORGET, body }), JSON.stringify(body)).toEqual({
        status: 400,
        json: { error: 'invalid-holder' },
      });
    }
    expect(await b.request('POST', { path: FORGET, rawBody: Buffer.from('{nope') })).toEqual({
      status: 400,
      json: { error: 'invalid-json' },
    });
    expect(await b.request('POST', { path: FORGET, rawBody: Buffer.alloc(5000, 32) })).toEqual({
      status: 413,
      json: { error: 'body-too-large' },
    });
    expect(await roster()).toEqual(['@ax/attachments', '@ax/old-plugin']);
  });

  it('200 forgotten:true for a present holder (gone from the roster), false for an unknown one; logged', async () => {
    const b = await bootWithRoster();
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    try {
      expect(await b.request('POST', { path: FORGET, body: { holder: '@ax/old-plugin' } })).toEqual({
        status: 200,
        json: { forgotten: true },
      });
      expect(await roster()).toEqual(['@ax/attachments']);
      expect(await b.request('POST', { path: FORGET, body: { holder: '@ax/never-was' } })).toEqual({
        status: 200,
        json: { forgotten: false },
      });
    } finally {
      spy.mockRestore();
    }
    const lines = out
      .flatMap((l) => l.split('\n'))
      .filter((l) => l.includes('blob_gc_roster_forgotten'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toMatchObject([
      { level: 'info', msg: 'blob_gc_roster_forgotten', by: 'admin-1', holder: '@ax/old-plugin', forgotten: true },
      { level: 'info', msg: 'blob_gc_roster_forgotten', by: 'admin-1', holder: '@ax/never-was', forgotten: false },
    ]);
    // A forgotten holder that is still loaded just rejoins at the next sweep.
    b.harness.bus.unsubscribe(BLOB_COLLECT_REFS_HOOK, '@ax/old-plugin');
    expect(await b.plugin.sweep()).toMatchObject({ outcome: 'reported' });
  });
});
