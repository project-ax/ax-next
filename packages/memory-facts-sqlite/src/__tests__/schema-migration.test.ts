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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqliteDb } from 'better-sqlite3';
import { HookBus, makeAgentContext } from '@ax/core';
import type { RecordInput, RecordOutput } from '@ax/memory-facts-contract';
import { openDatabase, TABLE, INFINITY_SENTINEL } from '../schema.js';
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
