import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@ax/core';
import { startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { runConnectorDirectoryMigration, type ConnectorDirectoryDatabase } from '../migrations.js';
import type { DirectoryRow } from '../normalize.js';
import { fetchRegistryPage, parseRegistryUrl } from '../registry-client.js';
import { searchDirectory } from '../search.js';
import { createDirectoryStore, type DirectoryStore, type SyncState } from '../store.js';
import { runSync, type SyncResult } from '../sync.js';
import { createFakeRegistry, page, type FakeRegistry } from './support/fake-registry.js';
import { listing, npmPackage, remote } from './support/listing.js';

const SOURCE = 'https://registry.test';
const HOUR = 3_600_000;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Kysely<ConnectorDirectoryDatabase>;
let store: DirectoryStore;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 5 });
  db = new Kysely<ConnectorDirectoryDatabase>({ dialect: new PostgresDialect({ pool }) });
  await runConnectorDirectoryMigration(db);
  store = createDirectoryStore(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE connector_directory_v1_entries, connector_directory_v1_sync_state`.execute(db);
});

afterAll(async () => {
  await db?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

interface Line {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

/**
 * One sync's surroundings: a clock whose every call returns the next second
 * (so a run's start and end differ), a recording logger, and `run`, which
 * syncs from `source` through the real registry client and a fake fetch.
 */
function world() {
  let t = Date.parse('2026-11-09T12:00:00.000Z');
  const calls: Date[] = [];
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, ...(fields === undefined ? {} : { fields }) });
  };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  const clock = {
    calls,
    now(): Date {
      const d = new Date(t);
      calls.push(d);
      t += 1_000;
      return d;
    },
    advance(ms: number): void {
      t += ms;
    },
  };
  const run = (
    fake: FakeRegistry,
    o: { source?: string; maxRows?: number; maxPages?: number; store?: DirectoryStore } = {},
  ): Promise<SyncResult> => {
    const base = parseRegistryUrl(o.source ?? SOURCE);
    return runSync({
      store: o.store ?? store,
      source: base.href,
      fetchPage: (q) => fetchRegistryPage(fake.fetchImpl, base, q),
      now: () => clock.now(),
      logger,
      ...(o.maxRows === undefined ? {} : { maxRows: o.maxRows }),
      ...(o.maxPages === undefined ? {} : { maxPages: o.maxPages }),
    });
  };
  return { clock, lines, run };
}

/** A fake registry answering each request with the next response, in order. */
function serve(...answers: Response[]): FakeRegistry {
  return createFakeRegistry(() => {
    const next = answers.shift();
    if (next === undefined) throw new Error('the sync asked for one page too many');
    return next;
  });
}

async function ids(): Promise<string[]> {
  const rows = await db
    .selectFrom('connector_directory_v1_entries')
    .select('id')
    .orderBy('id')
    .execute();
  return rows.map((r) => r.id);
}

async function rowById(id: string) {
  return db
    .selectFrom('connector_directory_v1_entries')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
}

function directoryRow(id: string, o: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    id,
    title: id,
    description: '',
    publisher: 'example.com',
    publisherProof: 'domain',
    url: 'https://mcp.example.com/mcp',
    auth: 'none',
    keyHeader: null,
    version: '1.0.0',
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    deprecated: false,
    ...o,
  };
}

describe('runSync', () => {
  it('first sync crawls every page with no updated_since and keeps only https remotes', async () => {
    const w = world();
    const fake = serve(
      page(
        [
          listing({ name: 'com.example/remote' }),
          listing({ name: 'com.example/pkg', remotes: [], packages: [npmPackage()] }),
          listing({
            name: 'com.example/sse',
            remotes: [remote('https://sse.example.com/sse', 'sse')],
          }),
        ],
        'c1',
      ),
      page([
        listing({
          name: 'com.example/templated',
          remotes: [remote('https://{tenant}.example.com/mcp')],
        }),
      ]),
    );

    expect(await w.run(fake)).toEqual({
      outcome: 'ok',
      full: true,
      pages: 2,
      upserted: 2,
      deleted: 0,
      skipped: 0,
      capped: 0,
    });
    expect(await ids()).toEqual(['com.example/remote', 'com.example/sse']);

    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]!.searchParams.has('updated_since')).toBe(false);
    expect(fake.requests[0]!.searchParams.has('cursor')).toBe(false);
    expect(fake.requests[1]!.searchParams.get('cursor')).toBe('c1');
    expect(fake.requests[1]!.searchParams.has('updated_since')).toBe(false);

    expect(await rowById('com.example/remote')).toEqual({
      id: 'com.example/remote',
      title: 'com.example/remote',
      description: 'A test server',
      publisher: 'example.com',
      publisher_proof: 'domain',
      url: 'https://mcp.example.com/mcp',
      auth: 'none',
      key_header: null,
      version: '1.0.0',
      updated_at: new Date('2026-11-01T00:00:00Z'),
      deprecated: false,
    });

    // The checkpoint is this run's START (our clock, never the registry's);
    // the sync time is its end.
    const startedAt = w.clock.calls[0]!;
    const endedAt = w.clock.calls.at(-1)!;
    expect(startedAt).not.toEqual(endedAt);
    expect(await store.readState()).toEqual({
      source: 'https://registry.test/',
      watermark: startedAt,
      syncedAt: endedAt,
      lastAttemptAt: endedAt,
      lastAttemptFailed: false,
    });
    expect(w.lines).toEqual([
      {
        level: 'info',
        msg: 'connector_directory_sync_ok',
        fields: { full: true, pages: 2, upserted: 2, deleted: 0, skipped: 0, capped: 0 },
      },
    ]);
  });

  it('the next sync asks for updated_since = last start − 10 min and applies changes', async () => {
    const w = world();
    const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `com.example/${n}`);
    await w.run(serve(page(names.map((name) => listing({ name, title: `Old ${name}` })))));
    const t0 = w.clock.calls[0]!;

    w.clock.advance(HOUR);
    const fake = serve(
      page(
        [
          listing({ name: 'com.example/a', status: 'deleted' }),
          listing({ name: 'com.example/b', title: 'Old com.example/b', status: 'deprecated' }),
          // Its newest version dropped the remote: the stored row must go.
          listing({ name: 'com.example/c', remotes: [], packages: [npmPackage()] }),
        ],
        'n1',
      ),
      page([
        listing({ name: 'com.example/d', title: 'New title' }),
        listing({ name: 'com.example/e', title: 'Superseded', isLatest: false }),
      ]),
    );

    expect(await w.run(fake)).toEqual({
      outcome: 'ok',
      full: false,
      pages: 2,
      upserted: 2,
      deleted: 2,
      skipped: 1,
      capped: 0,
    });
    const since = new Date(t0.getTime() - 600_000).toISOString();
    expect(fake.requests.map((u) => u.searchParams.get('updated_since'))).toEqual([since, since]);
    expect(fake.requests[1]!.searchParams.get('cursor')).toBe('n1');

    expect(await ids()).toEqual(['com.example/b', 'com.example/d', 'com.example/e']);
    expect((await rowById('com.example/b'))?.deprecated).toBe(true);
    expect((await rowById('com.example/d'))?.title).toBe('New title');
    expect((await rowById('com.example/e'))?.title).toBe('Old com.example/e');
  });

  it('a failed page keeps the copy, records the failure and leaves the checkpoint', async () => {
    const w = world();
    await w.run(serve(page([listing({ name: 'com.example/a' }), listing({ name: 'com.example/b' })])));
    const before = await store.readState();
    expect(before?.syncedAt).toBeInstanceOf(Date);

    w.clock.advance(HOUR);
    const fake = serve(
      page([listing({ name: 'com.example/new' })], 'c1'),
      new Response('busy', { status: 503 }),
    );
    expect(await w.run(fake)).toEqual({ outcome: 'failed', reason: 'http-503' });
    // Pages already applied stay applied (the next run asks for them again,
    // from the unchanged checkpoint); nothing that was there is lost.
    expect(await ids()).toEqual(['com.example/a', 'com.example/b', 'com.example/new']);
    expect(await store.readState()).toEqual({
      ...before,
      lastAttemptAt: w.clock.calls.at(-1),
      lastAttemptFailed: true,
    });
    expect(w.lines.at(-1)).toEqual({
      level: 'warn',
      msg: 'connector_directory_sync_failed',
      fields: { reason: 'http-503' },
    });

    expect(await w.run(serve(page([])))).toMatchObject({ outcome: 'ok', full: false });
    expect(await store.readState()).toMatchObject({ lastAttemptFailed: false });
  });

  it('a NUL or bidi character in a listing never fails the page', async () => {
    const w = world();
    const fake = serve(
      page([
        listing({
          name: 'com.example/bad',
          title: 'Bad\u0000Title‮',
          description: 'Line\u0000one​ two',
        }),
        listing({ name: 'com.example/good' }),
      ]),
    );
    expect(await w.run(fake)).toMatchObject({ outcome: 'ok', upserted: 2 });
    const bad = await rowById('com.example/bad');
    expect(bad?.title).toBe('Bad Title');
    expect(bad?.description).toBe('Line one two');
  });

  it('the row cap skips new names but still applies updates and deletes', async () => {
    const w = world();
    const seeded = ['r1', 'r2', 'r3'].map((n) => listing({ name: `com.example/${n}` }));
    await w.run(serve(page(seeded)));

    const fake = serve(
      page([
        listing({ name: 'com.example/n1' }),
        listing({ name: 'com.example/n2' }),
        // An update and a delete AFTER the new names: neither waits on room.
        listing({ name: 'com.example/r1', title: 'Updated' }),
        listing({ name: 'com.example/r2', status: 'deleted' }),
      ]),
    );
    expect(await w.run(fake, { maxRows: 3 })).toEqual({
      outcome: 'ok',
      full: false,
      pages: 1,
      upserted: 2,
      deleted: 1,
      skipped: 0,
      capped: 1,
    });
    expect(await ids()).toEqual(['com.example/n1', 'com.example/r1', 'com.example/r3']);
    expect((await rowById('com.example/r1'))?.title).toBe('Updated');
    expect(w.lines).toContainEqual({
      level: 'warn',
      msg: 'connector_directory_row_cap_reached',
      fields: { cap: 3, skipped: 1 },
    });
  });

  it('a repeated cursor and the page cap end the run as failures', async () => {
    const w = world();
    await w.run(serve(page([listing({ name: 'com.example/kept' })])));

    const loop = serve(page([], 'c1'), page([], 'c1'));
    expect(await w.run(loop)).toEqual({ outcome: 'failed', reason: 'cursor-loop' });
    expect(loop.requests).toHaveLength(2);
    expect(await store.readState()).toMatchObject({ lastAttemptFailed: true });
    expect(await ids()).toEqual(['com.example/kept']);

    const endless = serve(page([], 'c1'), page([], 'c2'), page([]));
    expect(await w.run(endless, { maxPages: 2 })).toEqual({
      outcome: 'failed',
      reason: 'too-many-pages',
    });
    expect(endless.requests).toHaveLength(2);
    expect(await store.readState()).toMatchObject({ lastAttemptFailed: true });
    expect(await ids()).toEqual(['com.example/kept']);

    // Exactly maxPages pages is a complete crawl.
    expect(await w.run(serve(page([], 'c1'), page([])), { maxPages: 2 })).toMatchObject({
      outcome: 'ok',
      pages: 2,
    });
  });

  it('a different registry URL clears the old copy and crawls in full', async () => {
    const w = world();
    await w.run(serve(page([listing({ name: 'com.example/a' })])));
    expect(await ids()).toEqual(['com.example/a']);

    const fake = serve(new Response(null, { status: 503 }));
    expect(await w.run(fake, { source: 'https://sub.test/registry/' })).toEqual({
      outcome: 'failed',
      reason: 'http-503',
    });
    // Never served a mix: the old source's rows are gone even though the new
    // source has not answered once.
    expect(await ids()).toEqual([]);
    expect(await store.readState()).toEqual({
      source: 'https://sub.test/registry',
      watermark: null,
      syncedAt: null,
      lastAttemptAt: w.clock.calls.at(-1),
      lastAttemptFailed: true,
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.searchParams.has('updated_since')).toBe(false);
    expect(fake.requests[0]!.origin).toBe('https://sub.test');
    expect(fake.requests[0]!.pathname).toBe('/registry/v0.1/servers');
    expect(w.lines.map((l) => l.msg)).toContain('connector_directory_source_changed');
  });

  it('the migration runs twice without error, and the tables keep their checks', async () => {
    await runConnectorDirectoryMigration(db);
    await runConnectorDirectoryMigration(db);

    await expect(
      sql`INSERT INTO connector_directory_v1_sync_state (id, source) VALUES (2, 'x')`.execute(db),
    ).rejects.toThrow();
    const insertEntry = (proof: string, auth: string) =>
      sql`INSERT INTO connector_directory_v1_entries
            (id, title, description, publisher, publisher_proof, url, auth, version, updated_at)
          VALUES ('com.example/x', 't', 'd', 'p', ${proof}, 'https://x.example/', ${auth}, '1', now())`.execute(
        db,
      );
    await expect(insertEntry('github', 'none')).rejects.toThrow();
    await expect(insertEntry('domain', 'oauth')).rejects.toThrow();
    await insertEntry('account', 'signin');
    expect(await ids()).toEqual(['com.example/x']);
  });

  it('logs failure reasons as short codes, never response text', async () => {
    const SECRET = 'UPSTREAM-SECRET';
    const w = world();
    const fake = serve(
      page([listing({ name: 'com.example/a', title: SECRET, description: SECRET })], 'c1'),
      new Response(SECRET, { status: 500 }),
    );
    expect(await w.run(fake)).toEqual({ outcome: 'failed', reason: 'http-500' });
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'connector_directory_sync_failed', fields: { reason: 'http-500' } },
    ]);
    expect(JSON.stringify(w.lines)).not.toContain(SECRET);
  });

  it('a later entry with the same name wins within a page', async () => {
    const w = world();
    const fake = serve(
      page([
        listing({ name: 'com.example/twice', title: 'First' }),
        listing({ name: 'com.example/twice', title: 'Second' }),
        listing({ name: 'com.example/gone', title: 'Kept for a moment' }),
        listing({ name: 'com.example/gone', status: 'deleted' }),
        listing({ name: 'com.example/back', status: 'deleted' }),
        listing({ name: 'com.example/back', title: 'Back again' }),
      ]),
    );
    expect(await w.run(fake)).toMatchObject({ outcome: 'ok', upserted: 2 });
    expect(await ids()).toEqual(['com.example/back', 'com.example/twice']);
    expect((await rowById('com.example/twice'))?.title).toBe('Second');
  });

  it('a store failure is reported as store, with codes and never the message', async () => {
    const w = world();
    const failing: DirectoryStore = {
      ...store,
      async applyPage() {
        throw Object.assign(new Error('value "SECRET-ROW" violates check'), { code: '23514' });
      },
    };
    const fake = serve(page([listing({ name: 'com.example/a' })]));
    expect(await w.run(fake, { store: failing })).toEqual({ outcome: 'failed', reason: 'store' });
    const failed = w.lines.find((l) => l.msg === 'connector_directory_sync_failed');
    expect(failed?.fields).toMatchObject({ reason: 'store', code: '23514' });
    expect(JSON.stringify(w.lines)).not.toContain('SECRET-ROW');
    expect(await store.readState()).toMatchObject({ lastAttemptFailed: true });
  });

  it('never throws, even when recording the failure fails too', async () => {
    const w = world();
    const broken: DirectoryStore = {
      ...store,
      async useSource() {
        throw new Error('database down');
      },
      async recordFailure() {
        throw new Error('database still down');
      },
    };
    const fake = serve(page([]));
    expect(await w.run(fake, { store: broken })).toEqual({ outcome: 'failed', reason: 'store' });
    expect(fake.requests).toHaveLength(0);
  });

  it('a checkpoint later than this run started (our clock went back) crawls in full', async () => {
    const w = world();
    await store.useSource('https://registry.test/');
    await store.recordSuccess({
      watermark: new Date('2027-01-01T00:00:00Z'),
      syncedAt: new Date('2027-01-01T00:00:00Z'),
    });
    const fake = serve(page([listing({ name: 'com.example/a' })]));
    expect(await w.run(fake)).toMatchObject({ outcome: 'ok', full: true });
    expect(fake.requests[0]!.searchParams.has('updated_since')).toBe(false);
    expect(await store.readState()).toMatchObject({ watermark: w.clock.calls[0] });
  });

  // A list with no `updated_since` leaves deleted servers out altogether, so a
  // full crawl can never remove a row it finds already there. Both tests
  // below fail if a full crawl keeps what was stored before it.
  it('a full crawl after a first crawl failed partway drops what the registry deleted since', async () => {
    const w = world();
    const first = serve(
      page([listing({ name: 'com.evil/a' }), listing({ name: 'com.example/b' })], 'c1'),
      new Response(null, { status: 503 }),
    );
    expect(await w.run(first)).toEqual({ outcome: 'failed', reason: 'http-503' });
    // The partial copy stays behind, never served: nothing has synced yet.
    expect(await ids()).toEqual(['com.evil/a', 'com.example/b']);

    // Meanwhile the registry deleted com.evil/a.
    w.clock.advance(HOUR);
    const fake = serve(page([listing({ name: 'com.example/b' })]));
    expect(await w.run(fake)).toMatchObject({ outcome: 'ok', full: true });
    expect(fake.requests[0]!.searchParams.has('updated_since')).toBe(false);
    expect(await ids()).toEqual(['com.example/b']);
    const found = await searchDirectory(db, { query: 'evil' }, { verifiedOnly: false });
    expect(found.syncedAt).not.toBeNull();
    expect(found.entries).toEqual([]);
  });

  it('a full crawl after our clock went back starts over, as a source change does', async () => {
    const w = world();
    await w.run(serve(page([listing({ name: 'com.evil/a' }), listing({ name: 'com.example/b' })])));

    // Our clock goes back past the checkpoint, so the next run cannot ask
    // from it and crawls in full. Meanwhile the registry deleted com.evil/a.
    w.clock.advance(-2 * HOUR);
    let atFirstRequest: { ids: string[]; state: SyncState | null } | undefined;
    const fake = createFakeRegistry(async () => {
      atFirstRequest ??= { ids: await ids(), state: await store.readState() };
      return page([listing({ name: 'com.example/b' })]);
    });
    expect(await w.run(fake)).toMatchObject({ outcome: 'ok', full: true });
    expect(fake.requests[0]!.searchParams.has('updated_since')).toBe(false);

    // Before its first request the crawl had emptied the copy and reset the
    // state: nothing kept can outlive a deletion, and a crawl that fails
    // part way serves nothing rather than half a list.
    expect(atFirstRequest).toEqual({
      ids: [],
      state: {
        source: 'https://registry.test/',
        watermark: null,
        syncedAt: null,
        lastAttemptAt: null,
        lastAttemptFailed: false,
      },
    });
    expect(await ids()).toEqual(['com.example/b']);
    const found = await searchDirectory(db, { query: 'evil' }, { verifiedOnly: false });
    expect(found.syncedAt).not.toBeNull();
    expect(found.entries).toEqual([]);
  });
});

describe('DirectoryStore', () => {
  it('useSource: a first call creates the state; the same source again clears nothing', async () => {
    expect(await store.readState()).toBeNull();
    expect(await store.useSource('https://registry.test/')).toBe(false);
    expect(await store.readState()).toEqual({
      source: 'https://registry.test/',
      watermark: null,
      syncedAt: null,
      lastAttemptAt: null,
      lastAttemptFailed: false,
    });
    await store.applyPage({ upserts: [directoryRow('com.example/a')], deletes: [] }, 10);
    expect(await store.useSource('https://registry.test/')).toBe(false);
    expect(await ids()).toEqual(['com.example/a']);
  });

  it('useSource: rows with no state row behind them are from an unknown source and go', async () => {
    await store.applyPage({ upserts: [directoryRow('com.example/orphan')], deletes: [] }, 10);
    expect(await store.useSource('https://registry.test/')).toBe(true);
    expect(await ids()).toEqual([]);
  });

  it('reset: empties the mirror and the state back to never synced, keeping the source', async () => {
    await store.useSource('https://registry.test/');
    await store.applyPage({ upserts: [directoryRow('com.example/a')], deletes: [] }, 10);
    await store.recordSuccess({
      watermark: new Date('2026-11-09T10:00:00Z'),
      syncedAt: new Date('2026-11-09T10:05:00Z'),
    });
    await store.recordFailure(new Date('2026-11-09T11:00:00Z'));

    await store.reset();
    expect(await ids()).toEqual([]);
    expect(await store.readState()).toEqual({
      source: 'https://registry.test/',
      watermark: null,
      syncedAt: null,
      lastAttemptAt: null,
      lastAttemptFailed: false,
    });
  });

  it('recordFailure keeps the checkpoint; recordSuccess clears the failure', async () => {
    await store.useSource('https://registry.test/');
    const w1 = new Date('2026-11-09T10:00:00Z');
    const s1 = new Date('2026-11-09T10:05:00Z');
    await store.recordSuccess({ watermark: w1, syncedAt: s1 });
    const failedAt = new Date('2026-11-09T11:00:00Z');
    await store.recordFailure(failedAt);
    expect(await store.readState()).toEqual({
      source: 'https://registry.test/',
      watermark: w1,
      syncedAt: s1,
      lastAttemptAt: failedAt,
      lastAttemptFailed: true,
    });
  });

  it('applies a page far larger than one statement can bind, updates and deletes included', async () => {
    // 6,000 rows x 11 columns is past Postgres' 65,535 bind parameters: a
    // registry page that size must still apply, not fail every sync.
    const many = Array.from({ length: 6_000 }, (_, i) =>
      directoryRow(`com.example/s${String(i).padStart(5, '0')}`),
    );
    expect(await store.applyPage({ upserts: many, deletes: [] }, 100_000)).toEqual({
      upserted: 6_000,
      deleted: 0,
      capped: 0,
    });
    const renamed = many.map((r) => ({ ...r, title: 'Renamed' }));
    expect(await store.applyPage({ upserts: renamed, deletes: [] }, 6_000)).toEqual({
      upserted: 6_000,
      deleted: 0,
      capped: 0,
    });
    const { n } = await db
      .selectFrom('connector_directory_v1_entries')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('title', '=', 'Renamed')
      .executeTakeFirstOrThrow();
    expect(Number(n)).toBe(6_000);
    expect(
      await store.applyPage({ upserts: [], deletes: many.map((r) => r.id) }, 100_000),
    ).toEqual({ upserted: 0, deleted: 6_000, capped: 0 });
    expect(await ids()).toEqual([]);
  });
});
