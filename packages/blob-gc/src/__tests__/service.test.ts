import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  answerBlobCollectRefs,
  BLOB_COLLECT_REFS_HOOK,
  HookBus,
  makeAgentContext,
  reject,
  type BlobRef,
  type Logger,
} from '@ax/core';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createSettingsStore, SETTINGS_STORAGE_KEY } from '../config.js';
import { runBlobGcMigration, type BlobGcDatabase } from '../migrations.js';
import { createBlobGcService, LAST_REPORT_STORAGE_KEY, type BlobGcService } from '../service.js';
import { createBlobGcStore, type BlobGcStore } from '../store.js';

const HOUR = 3_600_000;
const SEC = 1000;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Kysely<BlobGcDatabase>;
let realStore: BlobGcStore;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 5 });
  db = new Kysely<BlobGcDatabase>({ dialect: new PostgresDialect({ pool }) });
  await runBlobGcMigration(db);
  // Idempotent: a second boot runs the migration again.
  await runBlobGcMigration(db);
  realStore = createBlobGcStore(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE blob_gc_v1_blobs, blob_gc_v1_roster`.execute(db);
});

afterAll(async () => {
  await db?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

/** A sha made of one repeated hex char, or a numbered one for bulk tests. */
const S = 'a'.repeat(64);
const T = 'b'.repeat(64);
const U = 'c'.repeat(64);
const shaN = (n: number) => n.toString(16).padStart(64, '0');

interface Line {
  level: string;
  msg: string;
  bindings?: Record<string, unknown>;
}

interface World {
  bus: HookBus;
  svc: BlobGcService;
  storage: Map<string, Uint8Array>;
  /** The blobs the fake backend lists, by sha. */
  backend: Map<string, number>;
  /** Every service hook the GC called, in order. */
  called: string[];
  lines: Line[];
  clock: { now: () => Date; advance(ms: number): void };
  put(sha: string, size?: number): Promise<void>;
}

function world(opts: { store?: BlobGcStore } = {}): World {
  const bus = new HookBus();
  const storage = new Map<string, Uint8Array>();
  const backend = new Map<string, number>();
  const called: string[] = [];
  const track =
    <I, O>(hook: string, fn: (input: I) => Promise<O>) =>
    async (_ctx: unknown, input: I): Promise<O> => {
      called.push(hook);
      return fn(input);
    };

  bus.registerService(
    'storage:get',
    'test',
    track('storage:get', async ({ key }: { key: string }) => ({ value: storage.get(key) })),
  );
  bus.registerService(
    'storage:set',
    'test',
    track('storage:set', async ({ key, value }: { key: string; value: Uint8Array }) => {
      storage.set(key, value);
      return {};
    }),
  );
  bus.registerService(
    'blob:list',
    'test',
    track(
      'blob:list',
      async ({ after, limit, state }: { after?: string; limit: number; state: string }) => {
        if (state !== 'live') return { items: [] };
        const items = [...backend]
          .filter(([sha]) => after === undefined || sha > after)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .slice(0, limit)
          .map(([sha256, size]) => ({ sha256, size }));
        return items.length === limit ? { items, next: items[items.length - 1]!.sha256 } : { items };
      },
    ),
  );
  // Every hook that could free a byte. Report mode must never reach any.
  for (const hook of ['blob:delete', 'blob:retire', 'blob:purge', 'blob:put', 'blob:put-internal']) {
    bus.registerService(hook, 'test', track(hook, async () => ({})));
  }

  const lines: Line[] = [];
  const mk = (level: string) => (msg: string, bindings?: Record<string, unknown>) => {
    lines.push({ level, msg, ...(bindings === undefined ? {} : { bindings }) });
  };
  const logger: Logger = {
    debug: mk('debug'),
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    child: () => logger,
  };
  let t = Date.parse('2026-10-04T00:00:00.000Z');
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'system', logger });
  const settings = createSettingsStore({ bus, ctx });
  const svc = createBlobGcService({
    bus,
    store: opts.store ?? realStore,
    settings,
    now: clock.now,
    logger,
  });
  return {
    bus,
    svc,
    storage,
    backend,
    called,
    lines,
    clock,
    async put(sha, size = 100) {
      backend.set(sha, size);
      await svc.recordStored(ctx, { sha256: sha, size });
    },
  };
}

/** A holder answering from a function the test controls. */
function holder(w: World, name: string, refs: (candidates: string[]) => BlobRef[] | 'throw' | 'not-ok') {
  w.bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, name, async (_ctx, payload) => {
    const cands = ((payload as { candidates: string[] }).candidates ?? []).slice();
    const r = refs(cands);
    if (r === 'throw') throw new Error(`${name} crashed`);
    return answerBlobCollectRefs(payload, name, async () => {
      if (r === 'not-ok') throw new Error('could not check');
      return r;
    });
  });
}

async function row(sha: string) {
  return db.selectFrom('blob_gc_v1_blobs').selectAll().where('sha256', '=', sha).executeTakeFirst();
}

const aborted = (w: World) => w.lines.find((l) => l.msg === 'blob_gc_sweep_aborted');
const reportLine = (w: World) => w.lines.find((l) => l.msg === 'blob_gc_report');
const FREEING = ['blob:delete', 'blob:retire', 'blob:purge', 'blob:put', 'blob:put-internal'];

describe('blob:stored', () => {
  it('records last_put_at = now on every put, and a re-put moves it forward', async () => {
    const w = world();
    await w.put(S, 500);
    const first = await row(S);
    expect(first).toMatchObject({ state: 'live', retired_at: null });
    expect(Number(first!.size)).toBe(500);
    expect(first!.last_put_at.toISOString()).toBe(w.clock.now().toISOString());

    w.clock.advance(3 * HOUR);
    await w.put(S, 500);
    expect((await row(S))!.last_put_at.toISOString()).toBe(w.clock.now().toISOString());
  });

  it('a put whose clock lags never moves last_put_at backward', async () => {
    const w = world();
    w.clock.advance(HOUR);
    await w.put(S);
    const later = (await row(S))!.last_put_at.toISOString();
    w.clock.advance(-2 * HOUR);
    await w.put(S);
    expect((await row(S))!.last_put_at.toISOString()).toBe(later);
  });

  it('a put of a retired sha makes it live again (design D4)', async () => {
    const w = world();
    await w.put(S);
    await sql`UPDATE blob_gc_v1_blobs SET state = 'retired', retired_at = now()`.execute(db);
    await w.put(S);
    expect(await row(S)).toMatchObject({ state: 'live', retired_at: null });
  });

  it('ignores a malformed payload and never throws, even when the store is down', async () => {
    const broken: BlobGcStore = {
      ...realStore,
      recordPut: async () => {
        throw new Error('db down');
      },
    };
    const w = world({ store: broken });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    for (const bad of [null, {}, { sha256: 'XYZ', size: 1 }, { sha256: S, size: -1 }, { sha256: S, size: 1.5 }]) {
      await expect(w.svc.recordStored(ctx, bad)).resolves.toBeUndefined();
    }
    await expect(w.svc.recordStored(ctx, { sha256: S, size: 1 })).resolves.toBeUndefined();
    expect(await row(S)).toBeUndefined();
  });
});

describe('sweep (report mode)', () => {
  it('DISCOVERY: a blob the table never saw gets last_put_at = now when first listed, never earlier', async () => {
    const w = world();
    holder(w, '@ax/attachments', () => []);
    w.backend.set(S, 4096); // stored long before this plugin shipped; no blob:stored ever
    w.clock.advance(1000 * HOUR);
    const res = await w.svc.sweep();
    expect(res).toMatchObject({ outcome: 'reported', report: { discovered: 1, candidates: 0 } });
    const r = await row(S);
    expect(r!.last_put_at.toISOString()).toBe(w.clock.now().toISOString());
    expect(r).toMatchObject({ state: 'live' });

    // Its grace starts at discovery: an hour later it is still not a candidate...
    w.clock.advance(HOUR);
    expect(await w.svc.sweep()).toMatchObject({ report: { discovered: 0, candidates: 0 } });
    // ...a day after discovery it is, and nobody holds it.
    w.clock.advance(24 * HOUR);
    expect(await w.svc.sweep()).toMatchObject({
      report: { candidates: 1, held: 0, wouldRetire: 1, wouldRetireBytes: 4096 },
    });
  });

  it('DISCOVERY leaves a row it already has alone', async () => {
    const w = world();
    holder(w, '@ax/attachments', () => []);
    await w.put(S);
    const before = (await row(S))!.last_put_at.toISOString();
    w.clock.advance(2 * HOUR);
    expect(await w.svc.sweep()).toMatchObject({ report: { discovered: 0 } });
    expect((await row(S))!.last_put_at.toISOString()).toBe(before);
  });

  it('DISCOVERY pages through a large listing (2,500 blobs)', async () => {
    const w = world();
    holder(w, '@ax/attachments', () => []);
    for (let i = 1; i <= 2500; i++) w.backend.set(shaN(i), 1);
    expect(await w.svc.sweep()).toMatchObject({ report: { discovered: 2500 } });
    expect(w.called.filter((h) => h === 'blob:list')).toHaveLength(3);
    const n = await sql<{ n: string }>`SELECT count(*)::text AS n FROM blob_gc_v1_blobs`.execute(db);
    expect(n.rows[0]!.n).toBe('2500');
  });

  it('GRACE: a blob put 10 s before its referencing row lands is never a candidate', async () => {
    const w = world();
    let rowLanded = false;
    holder(w, '@ax/attachments', (c) =>
      rowLanded ? c.filter((s) => s === S).map((sha256) => ({ sha256, userIds: ['alice'] })) : [],
    );
    await w.put(S, 777);
    // A sweep in the 10 s between the put and the row: not old enough to ask about.
    w.clock.advance(5 * SEC);
    expect(await w.svc.sweep()).toMatchObject({ report: { candidates: 0, wouldRetire: 0 } });
    w.clock.advance(5 * SEC);
    rowLanded = true;
    // Past the grace window the row is there, so it is held.
    w.clock.advance(25 * HOUR);
    expect(await w.svc.sweep()).toMatchObject({
      report: { candidates: 1, held: 1, wouldRetire: 0, wouldRetireBytes: 0 },
    });
  });

  it('reports would-retire counts, bytes and per-holder answers, and deletes NOTHING', async () => {
    const w = world();
    holder(w, '@ax/attachments', (c) => c.filter((s) => s === S).map((sha256) => ({ sha256, userIds: ['alice'] })));
    holder(w, '@ax/branding', (c) => c.filter((s) => s === S || s === T).map((sha256) => ({ sha256, userIds: [] })));
    holder(w, '@ax/skills', () => []);
    await w.put(S, 100);
    await w.put(T, 200);
    await w.put(U, 300);
    w.clock.advance(25 * HOUR);
    const res = await w.svc.sweep();
    const expected = {
      mode: 'report',
      discovered: 0,
      candidates: 3,
      held: 2,
      wouldRetire: 1,
      wouldRetireBytes: 300,
      perHolder: { '@ax/attachments': 1, '@ax/branding': 2, '@ax/skills': 0 },
    };
    expect(res).toEqual({
      outcome: 'reported',
      report: { at: w.clock.now().toISOString(), ...expected },
    });
    expect(reportLine(w)).toEqual({ level: 'info', msg: 'blob_gc_report', bindings: expected });
    // The report is kept for the admin route.
    expect(JSON.parse(new TextDecoder().decode(w.storage.get(LAST_REPORT_STORAGE_KEY)))).toEqual(
      (res as { report: unknown }).report,
    );
    expect(await w.svc.lastReport()).toEqual((res as { report: unknown }).report);
    // Report mode: the backend saw zero retire/purge/delete (or write) calls,
    // and every row is still live.
    expect(w.called.filter((h) => FREEING.includes(h))).toEqual([]);
    const states = await sql<{ state: string }>`SELECT DISTINCT state FROM blob_gc_v1_blobs`.execute(db);
    expect(states.rows).toEqual([{ state: 'live' }]);
  });

  it('honours an admin-set grace window', async () => {
    const w = world();
    holder(w, '@ax/attachments', () => []);
    w.storage.set(SETTINGS_STORAGE_KEY, new TextEncoder().encode(JSON.stringify({ graceMs: 2 * HOUR })));
    await w.put(S);
    w.clock.advance(3 * HOUR);
    expect(await w.svc.sweep()).toMatchObject({ report: { candidates: 1, wouldRetire: 1 } });
  });

  it('asks in batches of at most 1000 candidates', async () => {
    const w = world();
    const asked: number[] = [];
    holder(w, '@ax/attachments', (c) => {
      asked.push(c.length);
      return [];
    });
    for (let i = 1; i <= 1500; i++) await realStore.recordPut(shaN(i), 2, w.clock.now());
    w.clock.advance(25 * HOUR);
    expect(await w.svc.sweep()).toMatchObject({
      report: { candidates: 1500, wouldRetire: 1500, wouldRetireBytes: 3000 },
    });
    expect(asked).toEqual([1000, 500]);
  });

  it('asks even with no candidates, so the roster fills before anything is old enough', async () => {
    const w = world();
    holder(w, '@ax/attachments', () => []);
    holder(w, '@ax/skills', () => []);
    expect(await w.svc.sweep()).toMatchObject({ outcome: 'reported', report: { candidates: 0 } });
    expect(await realStore.listRoster()).toEqual(['@ax/attachments', '@ax/skills']);
  });
});

describe('sweep FAILS CLOSED', () => {
  async function primed() {
    let mode: 'answer' | 'throw' | 'not-ok' = 'answer';
    const w = world();
    holder(w, '@ax/attachments', () => []);
    holder(w, '@ax/skills', () => (mode === 'answer' ? [] : mode));
    await w.put(S);
    // A first sweep inside the grace window puts both holders on the roster.
    expect(await w.svc.sweep()).toMatchObject({ outcome: 'reported' });
    w.storage.delete(LAST_REPORT_STORAGE_KEY);
    w.lines.length = 0;
    w.clock.advance(25 * HOUR);
    return { w, setMode: (m: typeof mode) => (mode = m) };
  }

  it('a holder that THROWS aborts the sweep: logged, no report', async () => {
    const { w, setMode } = await primed();
    setMode('throw');
    expect(await w.svc.sweep()).toEqual({ outcome: 'aborted' });
    expect(aborted(w)).toMatchObject({ level: 'error', bindings: { missing: ['@ax/skills'], failed: [] } });
    expect(reportLine(w)).toBeUndefined();
    expect(w.storage.has(LAST_REPORT_STORAGE_KEY)).toBe(false);
    expect(w.called.filter((h) => FREEING.includes(h))).toEqual([]);
  });

  it('a holder answering ok:false aborts the sweep', async () => {
    const { w, setMode } = await primed();
    setMode('not-ok');
    expect(await w.svc.sweep()).toEqual({ outcome: 'aborted' });
    expect(aborted(w)).toMatchObject({ bindings: { failed: ['@ax/skills'], missing: [] } });
    expect(w.storage.has(LAST_REPORT_STORAGE_KEY)).toBe(false);
  });

  it('a roster member that is no longer loaded aborts the sweep', async () => {
    const { w } = await primed();
    w.bus.unsubscribe(BLOB_COLLECT_REFS_HOOK, '@ax/skills');
    expect(await w.svc.sweep()).toEqual({ outcome: 'aborted' });
    expect(aborted(w)).toMatchObject({ bindings: { missing: ['@ax/skills'] } });
  });

  it('a holder that rewrites another answer into junk aborts the sweep', async () => {
    const { w } = await primed();
    w.bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, '@ax/vandal', async (_ctx, payload) => ({
      ...(payload as object),
      answers: [...(payload as { answers: unknown[] }).answers, { nope: true }],
    }));
    expect(await w.svc.sweep()).toEqual({ outcome: 'aborted' });
    expect(aborted(w)).toMatchObject({ bindings: { malformed: 1 } });
  });

  it('a vetoed collect-refs fire aborts the sweep', async () => {
    const { w } = await primed();
    w.bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, '@ax/veto', async () => reject({ reason: 'no' }));
    expect(await w.svc.sweep()).toEqual({ outcome: 'aborted' });
    expect(aborted(w)).toMatchObject({ bindings: { rejected: true } });
  });

  it('a malformed or backward blob:list page fails the sweep without a report', async () => {
    for (const page of [
      { items: 'nope' },
      { items: [{ sha256: 'XYZ', size: 1 }] },
      { items: [{ sha256: T, size: 1 }, { sha256: S, size: 1 }] },
      { items: [{ sha256: S, size: 1 }], next: S.slice(1) },
    ]) {
      const bus = new HookBus();
      const storage = new Map<string, Uint8Array>();
      bus.registerService('storage:get', 'test', async (_c, { key }: { key: string }) => ({ value: storage.get(key) }));
      bus.registerService('storage:set', 'test', async (_c, { key, value }: { key: string; value: Uint8Array }) => {
        storage.set(key, value);
        return {};
      });
      bus.registerService('blob:list', 'test', async () => page);
      const lines: Line[] = [];
      const logger: Logger = {
        debug() {},
        info() {},
        warn() {},
        error: (msg, bindings) => lines.push({ level: 'error', msg, ...(bindings ? { bindings } : {}) }),
        child: () => logger,
      };
      const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'system', logger });
      const svc = createBlobGcService({
        bus,
        store: realStore,
        settings: createSettingsStore({ bus, ctx }),
        now: () => new Date(),
        logger,
      });
      expect(await svc.sweep()).toEqual({ outcome: 'failed' });
      expect(lines.map((l) => l.msg)).toEqual(['blob_gc_sweep_failed']);
      expect(storage.has(LAST_REPORT_STORAGE_KEY)).toBe(false);
    }
  });
});

describe('sweep lock', () => {
  it('skips the sweep while another replica holds the advisory lock', async () => {
    const w = world();
    holder(w, '@ax/attachments', () => []);
    const other = await pool.connect();
    try {
      await other.query(`SELECT pg_advisory_lock(hashtext('ax:blob-gc:sweep'))`);
      expect(await w.svc.sweep()).toEqual({ outcome: 'skipped' });
      expect(w.called).not.toContain('blob:list');
      await other.query(`SELECT pg_advisory_unlock(hashtext('ax:blob-gc:sweep'))`);
      expect(await w.svc.sweep()).toMatchObject({ outcome: 'reported' });
    } finally {
      other.release();
    }
  });

  it('releases the lock after a sweep, even one that failed', async () => {
    const w = world();
    holder(w, '@ax/attachments', () => []);
    w.backend.set('not-a-sha', 1);
    expect(await w.svc.sweep()).toEqual({ outcome: 'failed' });
    w.backend.clear();
    expect(await w.svc.sweep()).toMatchObject({ outcome: 'reported' });
    // And nobody still holds it.
    const c = await pool.connect();
    try {
      const r = await c.query(`SELECT pg_try_advisory_lock(hashtext('ax:blob-gc:sweep')) AS locked`);
      expect(r.rows[0].locked).toBe(true);
      await c.query(`SELECT pg_advisory_unlock(hashtext('ax:blob-gc:sweep'))`);
    } finally {
      c.release();
    }
  });
});
