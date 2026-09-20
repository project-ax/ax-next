// The `batch_key` / `batch_seq` migration (TASK-422, plan §5 task 3).
//
// This is the one part of the batch work that CANNOT live in
// `@ax/memory-facts-contract`: it is about what happens to an existing SQLite
// FILE, which is exactly the storage vocabulary the contract must not know
// (Invariant 1). A postgres backend will need its own equivalent.
//
// Why it needs a test at all: the table is created with
// `CREATE TABLE IF NOT EXISTS`, which is a NO-OP against a db that TASK-421
// already created. Without an explicit `ALTER TABLE`, such a db would keep the
// 13-column shape forever and every batch read would die on "no such column:
// batch_key" — in production only, never in a test that starts from an empty
// directory.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqliteDb } from 'better-sqlite3';
import { HookBus, makeAgentContext } from '@ax/core';
import type { RecordInput, RecordOutput } from '@ax/memory-facts-contract';
import {
  openDatabase,
  TABLE,
  INFINITY_SENTINEL,
  FTS_TABLE,
  VEC_TABLE,
  EMBEDDING_DIMENSIONS,
  vectorToBlob,
  indexFactRow,
} from '../schema.js';
import { createMemoryFactsSqlitePlugin } from '../plugin.js';

// The TASK-421 table, verbatim and frozen: 13 columns, no batch_key, no
// batch_seq, no idx_facts_batch. Copied here on purpose rather than imported —
// it has to keep describing the OLD shape even as `schema.ts` moves on.
const LEGACY_SCHEMA = `
  CREATE TABLE ${TABLE} (
    id TEXT PRIMARY KEY,
    agent_key TEXT NOT NULL,
    about TEXT NOT NULL,
    relation TEXT NOT NULL,
    value TEXT NOT NULL,
    slot TEXT,
    provenance TEXT NOT NULL CHECK(provenance IN ('extracted','agent','human')),
    owner_user_id TEXT,
    conversation_id TEXT,
    valid_start TEXT NOT NULL,
    valid_end TEXT NOT NULL DEFAULT '${INFINITY_SENTINEL}',
    transaction_time TEXT NOT NULL,
    closed_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_facts_slot ON ${TABLE}(agent_key, about, slot, valid_end);
`;

describe('@ax/memory-facts-sqlite — additive batch-column migration', () => {
  let dir: string;
  let databasePath: string;
  const toClose: BetterSqliteDb[] = [];

  function columnsOf(driver: BetterSqliteDb): Set<string> {
    return new Set(
      (driver.pragma(`table_info(${TABLE})`) as Array<{ name: string }>).map((c) => c.name),
    );
  }

  function seedLegacyDatabase(): void {
    const legacy = new BetterSqlite3(databasePath);
    toClose.push(legacy);
    legacy.exec(LEGACY_SCHEMA);
    legacy
      .prepare(
        `INSERT INTO ${TABLE}
           (id, agent_key, about, relation, value, slot, provenance, owner_user_id,
            conversation_id, valid_start, valid_end, transaction_time, closed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-1',
        'agent:old',
        'user',
        'likes_artist',
        'Khalid',
        null,
        'extracted',
        null,
        null,
        '2023-01-01T00:00:00.000Z',
        INFINITY_SENTINEL,
        '2023-01-01T00:00:00.000Z',
        null,
      );
    expect(columnsOf(legacy).has('batch_key')).toBe(false);
    legacy.close();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-migration-'));
    databasePath = join(dir, 'facts.db');
  });

  afterEach(async () => {
    for (const driver of toClose.splice(0)) {
      if (driver.open) driver.close();
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('adds batch_key and batch_seq to a db created before they existed', () => {
    seedLegacyDatabase();

    const { driver } = openDatabase(databasePath);
    toClose.push(driver);

    const columns = columnsOf(driver);
    expect(columns.has('batch_key')).toBe(true);
    expect(columns.has('batch_seq')).toBe(true);

    // The index over the added column exists too — it is created AFTER the
    // ALTER for exactly this reason.
    const indexes = (
      driver.pragma(`index_list(${TABLE})`) as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain('idx_facts_batch');

    // Additive means additive: the pre-existing row survives, with NULL for
    // the columns it never had. A NULL batch_key can never match a dedup
    // lookup, which always binds a non-empty string.
    const row = driver
      .prepare(`SELECT id, value, batch_key, batch_seq FROM ${TABLE} WHERE id = ?`)
      .get('legacy-1') as { id: string; value: string; batch_key: null; batch_seq: null };
    expect(row.value).toBe('Khalid');
    expect(row.batch_key).toBeNull();
    expect(row.batch_seq).toBeNull();
  });

  it('is idempotent — a second open does not throw "duplicate column name"', () => {
    seedLegacyDatabase();

    const first = openDatabase(databasePath);
    toClose.push(first.driver);
    first.driver.close();

    // SQLite has no `ADD COLUMN IF NOT EXISTS`; re-running the ALTER blind
    // would throw here and take the whole plugin's `init` down with it.
    expect(() => {
      const second = openDatabase(databasePath);
      toClose.push(second.driver);
    }).not.toThrow();
  });

  it('leaves a freshly-created db alone — the CREATE TABLE already has both columns', () => {
    const { driver } = openDatabase(databasePath);
    toClose.push(driver);
    const columns = columnsOf(driver);
    expect(columns.has('batch_key')).toBe(true);
    expect(columns.has('batch_seq')).toBe(true);
  });

  // The migration is only worth anything if the migrated column is USABLE —
  // an ALTER that lands but leaves batch dedup broken is the same outage with
  // extra steps.
  it('lets a migrated db dedup a batchKey like a fresh one', async () => {
    seedLegacyDatabase();

    const bus = new HookBus();
    const plugin = createMemoryFactsSqlitePlugin({ databasePath });
    await plugin.init({ bus, config: {} });
    try {
      const ctx = makeAgentContext({
        sessionId: 's',
        agentId: 'a',
        userId: 'u',
        workspace: { rootPath: '/tmp' },
      });
      const input: RecordInput = {
        batchKey: 'turn-1',
        statements: [
          {
            about: 'user',
            relation: 'likes_food',
            value: 'ramen',
            when: '2023-01-01T00:00:00.000Z',
          },
        ],
      };
      const first = await bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, input);
      const second = await bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, input);
      expect(second.records.map((r) => r.id)).toEqual(first.records.map((r) => r.id));
    } finally {
      await plugin.shutdown?.();
    }
  });
});

// The FTS5 shadow table + `vec0` shadow table (TASK-434, plan §3 task 2).
//
// Same shape of gap as the batch-column migration above, one level up: a db
// that TASK-421/422 already created has NEITHER virtual table, because
// `LEGACY_SCHEMA` (and the unmigrated 15-column shape it upgrades to) predate
// both. `CREATE VIRTUAL TABLE IF NOT EXISTS` is its own idempotence guard —
// unlike `batch_key`/`batch_seq` there is no `PRAGMA table_info` check to
// forget — but a fresh-vs-reopen distinction still matters for `vec0`,
// because issuing that DDL when the extension failed to load throws "no such
// module: vec0" and would take `openDatabase` down with it (T2's "guarded"
// requirement) rather than degrading the dense channel.
//
// `sqlite-vec` is mocked (not the real load) for exactly one test — the whole
// point of the guard is behaviour on a platform where the prebuilt binary
// doesn't exist, which is not the platform running this suite.
vi.mock('sqlite-vec', async (importOriginal) => {
  const real = await importOriginal<typeof import('sqlite-vec')>();
  return { ...real, load: vi.fn(real.load) };
});

describe('@ax/memory-facts-sqlite — FTS5/vec0 shadow-table migration', () => {
  let dir: string;
  let databasePath: string;
  const toClose: BetterSqliteDb[] = [];

  function tableExists(driver: BetterSqliteDb, name: string): boolean {
    return Boolean(
      driver.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(name),
    );
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-fts-vec-'));
    databasePath = join(dir, 'facts.db');
  });

  afterEach(async () => {
    for (const driver of toClose.splice(0)) {
      if (driver.open) driver.close();
    }
    await rm(dir, { recursive: true, force: true });
  });

  // Against unfixed code (no FTS5/vec0 in `schema.ts` at all): `FTS_TABLE` and
  // `VEC_TABLE` wouldn't even exist as exports, so this fails at the type/
  // import level before it fails at the assertion — the strongest possible
  // "would have caught it" signal.
  it('adds the FTS5 and vec0 shadow tables to a db created before TASK-434', () => {
    // Seed a pre-TASK-434 db: the OLD 13-column CREATE, same as the batch
    // migration's LEGACY_SCHEMA above — no FTS5, no vec0, nothing derived.
    const legacy = new BetterSqlite3(databasePath);
    legacy.exec(`
      CREATE TABLE ${TABLE} (
        id TEXT PRIMARY KEY,
        agent_key TEXT NOT NULL,
        about TEXT NOT NULL,
        relation TEXT NOT NULL,
        value TEXT NOT NULL,
        slot TEXT,
        provenance TEXT NOT NULL CHECK(provenance IN ('extracted','agent','human')),
        owner_user_id TEXT,
        conversation_id TEXT,
        valid_start TEXT NOT NULL,
        valid_end TEXT NOT NULL DEFAULT '${INFINITY_SENTINEL}',
        transaction_time TEXT NOT NULL,
        closed_by TEXT
      );
    `);
    legacy.close();

    const { driver, vectorExtensionLoaded } = openDatabase(databasePath);
    toClose.push(driver);

    expect(tableExists(driver, FTS_TABLE)).toBe(true);
    // This machine has a prebuilt `sqlite-vec` binary (it's one of the
    // package's five supported platform targets), so the honest assertion is
    // "the flag and the table agree" rather than hard-coding `true` and
    // making the test platform-fragile.
    expect(tableExists(driver, VEC_TABLE)).toBe(vectorExtensionLoaded);
    expect(vectorExtensionLoaded).toBe(true);
  });

  // Against unfixed code: no virtual-table DDL exists to re-run, so there is
  // nothing to throw — this test would pass trivially. It earns its place
  // only paired with the previous one (it's the "no crash on the SECOND
  // open" half of what that test already exercises once).
  it('is a no-op on a second open — no "table already exists" throw', () => {
    const first = openDatabase(databasePath);
    first.driver.close();

    expect(() => {
      const second = openDatabase(databasePath);
      toClose.push(second.driver);
    }).not.toThrow();
  });

  // The one test that exercises the guard the T2 plan calls out by name:
  // "a load failure here must degrade to sparse+temporal, never fail
  // `openDatabase`." Against unfixed code this test doesn't compile (no
  // `vectorExtensionLoaded` field, no `VEC_TABLE` export) — the second-
  // strongest failure mode after a straight assertion failure.
  it('still opens and works when the vector extension is unavailable', async () => {
    const sqliteVecMock = await import('sqlite-vec');
    vi.mocked(sqliteVecMock.load).mockImplementationOnce(() => {
      throw new Error('no prebuilt binary for this platform');
    });

    const { driver, vectorExtensionLoaded } = openDatabase(databasePath);
    toClose.push(driver);

    expect(vectorExtensionLoaded).toBe(false);
    // The degraded contract: no vec0 table, but everything else is a normal,
    // working sqlite database — base table, FTS5, inserts, reads.
    expect(tableExists(driver, VEC_TABLE)).toBe(false);
    expect(tableExists(driver, FTS_TABLE)).toBe(true);

    driver
      .prepare(
        `INSERT INTO ${TABLE}
           (id, agent_key, about, relation, value, provenance, valid_start, transaction_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('f1', 'agent:a', 'user', 'likes_food', 'ramen', 'extracted', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');

    // `indexFactRow` with a vector must degrade when the extension never
    // loaded — and SAY so, rather than throwing or shrugging. See
    // `__tests__/fact-index.test.ts` for the rest of that contract.
    expect(
      indexFactRow(
        driver,
        { id: 'f1', about: 'user', relation: 'likes_food', value: 'ramen' },
        { vector: new Array(EMBEDDING_DIMENSIONS).fill(0.1), vectorExtensionLoaded },
      ),
    ).toEqual({ vectorStored: false });

    const ftsRow = driver
      .prepare(`SELECT value FROM ${FTS_TABLE} WHERE value MATCH 'ramen'`)
      .get() as { value: string } | undefined;
    expect(ftsRow?.value).toBe('ramen');
  });
});

// `vectorToBlob` (TASK-434, ported from `dem-memory/src/db/memory-repository.ts`).
//
// Against unfixed code: `vectorToBlob` and `EMBEDDING_DIMENSIONS` don't exist
// as exports, so both tests fail to compile/import — they cannot pass
// against the pre-T2 file by construction.
describe('@ax/memory-facts-sqlite — vectorToBlob', () => {
  it('round-trips a 384-dimension vector through the Float32Array blob', () => {
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.fround(i / 1000));
    const blob = vectorToBlob(vector);
    expect(blob).toBeInstanceOf(Buffer);
    expect(blob.byteLength).toBe(EMBEDDING_DIMENSIONS * 4);

    const roundTripped = Array.from(
      new Float32Array(blob.buffer, blob.byteOffset, EMBEDDING_DIMENSIONS),
    );
    expect(roundTripped).toEqual(vector);
  });

  it('rejects a vector whose length does not match EMBEDDING_DIMENSIONS', () => {
    expect(() => vectorToBlob(new Array(EMBEDDING_DIMENSIONS - 1).fill(0))).toThrow(
      /dimension mismatch/i,
    );
    expect(() => vectorToBlob([])).toThrow(/dimension mismatch/i);
  });
});
