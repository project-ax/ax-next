// The three postgres-only traps, each of which a careless port passes.
//
// `runFactsContract` is the real gate for behaviour, and it catches a lot.
// These are the things it either cannot see (how many round trips a replay
// costs) or that it would only catch by accident (a `pending` that is the
// string `"0"` happens to fail a `toEqual`, but nothing there says the field's
// TYPE is load-bearing). Each case below was written by asking what it would
// do against the WRONG implementation, which is spelled out in each comment.
//
// It builds its own bus and its own Kysely rather than going through
// `@ax/database-postgres`, because two of the three questions — how many
// queries ran, and what exactly a destroyed instance throws — need a handle on
// the driver that the db plugin does not expose.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import type {
  FactStatementInput,
  RecordInput,
  RecordOutput,
  RecallInput,
  RecallOutput,
  ReindexInput,
  ReindexOutput,
} from '@ax/memory-facts-contract';
import { createMemoryFactsPostgresPlugin } from '../plugin.js';
import { runFactsMigration } from '../schema.js';

const JAN = '2023-01-01T00:00:00.000Z';

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  await stopPostgresContainer(container);
});

/** Every `query`-level statement Kysely sent, newest last. */
let sqlLog: string[] = [];
let db: Kysely<unknown>;
let bus: HookBus;

const ctx = makeAgentContext({
  sessionId: 's',
  agentId: 'a',
  userId: 'u',
  workspace: { rootPath: '/tmp' },
});

beforeEach(async () => {
  sqlLog = [];
  db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
    log: (event) => {
      if (event.level === 'query') sqlLog.push(event.query.sql);
    },
  });
  await runFactsMigration(db);
  await sql`TRUNCATE memory_facts_v1`.execute(db);

  bus = new HookBus();
  // Stand in for @ax/database-postgres: the facts plugin only knows the hook.
  bus.registerService<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    '@ax/test-database',
    async () => ({ db }),
  );
  await createMemoryFactsPostgresPlugin().init({ bus, config: {} });
});

afterEach(async () => {
  await db.destroy().catch(() => {});
});

function record(input: RecordInput): Promise<RecordOutput> {
  return bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, input);
}
function recall(input: RecallInput): Promise<RecallOutput> {
  return bus.call<RecallInput, RecallOutput>('memory:facts:recall', ctx, input);
}
function reindex(input: ReindexInput = {}): Promise<ReindexOutput> {
  return bus.call<ReindexInput, ReindexOutput>('memory:facts:reindex', ctx, input);
}

// ---------------------------------------------------------------------------
// Trap 2 — `count(*)` is a bigint, and node-postgres renders a bigint as a
// STRING. `ReindexOutput.pending` is typed `number`.
//
// Against the wrong implementation (`count(*)` with no `::int`): `pending`
// comes back as `"0"`, which is a string, and `"0" > 0` is TRUE — so a clean
// tenant reports `degraded: ['pending']` forever. The VALUE assertions alone
// would not say why; the `typeof` is the assertion that names the bug.
// ---------------------------------------------------------------------------
describe('the pending count is a JS number, not a bigint-as-string', () => {
  it('reports pending: 0 (number) and degraded: [] on a clean tenant', async () => {
    const out = await reindex();
    expect(typeof out.pending).toBe('number');
    expect(out.pending).toBe(0);
    // The derived half: a string `"0"` is truthy AND `> 0`, so this flips.
    expect(out.degraded).toEqual([]);
  });

  it('counts real pending rows as a number, and clears back to a number', async () => {
    const pending = await record({
      statements: [
        { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: 'pending' },
      ],
    });
    const during = await reindex();
    expect(typeof during.pending).toBe('number');
    expect(during.pending).toBe(1);
    expect(during.degraded).toEqual(['pending']);

    const drained = await reindex({
      slots: [{ id: pending.records[0]!.id, slot: 'lives_in' }],
    });
    // `resolved` is derived from what the resolving UPDATE actually matched —
    // see the RETURNING trap below — and is also a `number` on the contract.
    expect(typeof drained.resolved).toBe('number');
    expect(drained.resolved).toBe(1);
    expect(typeof drained.pending).toBe('number');
    expect(drained.pending).toBe(0);
    expect(drained.degraded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Trap 1 — `.changes === 0` has no postgres equivalent that is a `number`.
// Kysely's `numUpdatedRows` is a **bigint**, so `numUpdatedRows === 0` is
// false even when nothing matched.
//
// Against the wrong implementation, every id handed to `supersede` looks
// closed and every entry handed to `reindex` looks resolved. The contract
// catches the `supersede` half (its foreign-tenant case asserts `closed: []`);
// the `reindex` half is pinned here, where a wrong impl would report
// `resolved: 3` for three ids that resolve nothing.
// ---------------------------------------------------------------------------
describe('RETURNING, not a row count, decides what a write touched', () => {
  it('reports resolved: 0 for ids that are missing, foreign or no longer pending', async () => {
    // One genuinely pending row, drained once so a SECOND drain of the same id
    // must resolve nothing.
    const pending = await record({
      statements: [
        { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: 'pending' },
      ],
    });
    const id = pending.records[0]!.id;
    expect((await reindex({ slots: [{ id, slot: 'lives_in' }] })).resolved).toBe(1);

    const again = await reindex({
      slots: [
        { id, slot: 'lives_in' }, // already resolved
        { id: 'no-such-row', slot: 'lives_in' }, // missing
        { id, slot: 'works_at' }, // still already resolved, different slot
      ],
    });
    expect(again.resolved).toBe(0);
    // And nothing was re-settled on the strength of a write that never
    // happened — the second half of what the bigint bug would corrupt.
    expect(again.resettled).toEqual([]);

    // The row kept the slot the FIRST drain gave it.
    const rows = await recall({ about: 'user', limit: 10 });
    expect(rows.statements.map((s) => s.value)).toEqual(['Boston']);
    const slots = await sql<{
      slot: string | null;
    }>`SELECT slot FROM memory_facts_v1 WHERE id = ${id}`.execute(db);
    expect(slots.rows[0]!.slot).toBe('lives_in');
  });
});

// ---------------------------------------------------------------------------
// Trap 3 — the batch replay must not run a query per row.
//
// `rebuildBatch` re-derives each row's `closes` list, which is the inverse of
// `closed_by`. The sqlite twin executes a prepared statement once per row
// inside a `.map()`: free in-process, one NETWORK ROUND TRIP per row here,
// inside an open transaction against the shared production database.
//
// Against that wrong implementation this test sees 1 + 6 = 7 selects instead
// of 2. The assertion is on the count, not on a duration, so it fails the same
// way on a fast machine as on a slow one.
// ---------------------------------------------------------------------------
describe('a batch replay costs a fixed number of queries, not one per row', () => {
  it('rebuilds a 6-row batch with two SELECTs', async () => {
    const statements: FactStatementInput[] = Array.from({ length: 6 }, (_, i) => ({
      about: 'user',
      relation: `relation_${i}`,
      value: `value_${i}`,
      when: JAN,
    }));
    const first = await record({ batchKey: 'turn-1', statements });
    expect(first.records).toHaveLength(6);

    // Count only the replay.
    sqlLog = [];
    const replay = await record({ batchKey: 'turn-1', statements });

    // Same rows, rebuilt — nothing written.
    expect(replay.records.map((r) => r.id)).toEqual(first.records.map((r) => r.id));
    expect(sqlLog.some((s) => /insert into/i.test(s))).toBe(false);

    const selects = sqlLog.filter((s) => /^\s*select/i.test(s) && s.includes('memory_facts_v1'));
    expect(selects).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// What a destroyed Kysely actually throws, and why `inStore` can translate it.
//
// The plugin has no `shutdown()` — it borrows the pool. So the only way the
// store goes away under it is someone else destroying the shared instance,
// which is exactly what the contract's §4.4 cases do. `inStore` re-throws a
// `PluginError` UNTOUCHED, so if Kysely threw one of those (it does not, but
// nothing in the type system says so) every store outage would surface under
// whatever code that error carried instead of `store-unavailable`.
//
// Against a wrong implementation — say one that caught the error and returned
// an empty result — `recall` would RESOLVE to `{statements: []}`, which is the
// §4.4 lie this whole family of cases exists to prevent.
// ---------------------------------------------------------------------------
describe('a destroyed shared Kysely reads as store-unavailable', () => {
  it('throws a plain Error from Kysely, which inStore relabels rather than passes through', async () => {
    await record({
      statements: [{ about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN }],
    });
    await db.destroy();

    let caught: unknown;
    let resolvedTo: RecallOutput | undefined;
    try {
      resolvedTo = await recall({ about: 'user', limit: 10 });
    } catch (err) {
      caught = err;
    }

    expect(resolvedTo).toBeUndefined();
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('store-unavailable');

    // The part that had to be VERIFIED rather than assumed: Kysely's
    // RuntimeDriver rejects with a bare `Error`, so `inStore`'s
    // pass-PluginError-through branch does not swallow the relabelling.
    const cause = (caught as PluginError).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBeInstanceOf(PluginError);
    expect((cause as Error).message).toBe('driver has already been destroyed');
  });
});
