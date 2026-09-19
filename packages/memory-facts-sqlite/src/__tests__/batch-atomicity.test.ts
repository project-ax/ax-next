// All-or-nothing batches under a REAL store fault (TASK-422, design §3.5).
//
// The contract suite pins the validation half — a bad statement at position 2
// means position 1 is never written. That half passes even if every statement
// still gets its own transaction, because validation runs up front. The half
// that actually needs the outer `driver.transaction(...)` is a batch that dies
// PART-WAY THROUGH THE WRITE, and reaching that takes a forced store fault:
// hence a backend-local test rather than a contract case.
//
// The fault is a SQLite trigger that aborts the insert of one specific value.
// It is the least invasive way to make the store itself throw mid-batch — no
// mocks, no monkey-patching of the plugin, and the failure lands exactly where
// a real constraint violation or disk error would.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as BetterSqliteDb } from 'better-sqlite3';
import { HookBus, makeAgentContext, type Plugin } from '@ax/core';
import type { RecordInput, RecordOutput, RecallInput, RecallOutput } from '@ax/memory-facts-contract';
import { openDatabase, TABLE } from '../schema.js';
import { createMemoryFactsSqlitePlugin } from '../plugin.js';

const JAN = '2023-01-01T00:00:00.000Z';

describe('@ax/memory-facts-sqlite — a batch that fails mid-write leaves nothing', () => {
  let dir: string;
  let databasePath: string;
  let bus: HookBus;
  let plugin: Plugin;
  let observer: BetterSqliteDb;

  const ctx = makeAgentContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    workspace: { rootPath: '/tmp' },
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-atomicity-'));
    databasePath = join(dir, 'facts.db');
    bus = new HookBus();
    plugin = createMemoryFactsSqlitePlugin({ databasePath });
    await plugin.init({ bus, config: {} });

    // A SECOND connection to the same file: it installs the fault and, more
    // importantly, counts rows without going through the plugin. Counting via
    // `recall` would only see ACTIVE rows, and "did the batch roll back" is a
    // question about every row, closed ones included.
    observer = openDatabase(databasePath).driver;
    observer.exec(`
      CREATE TRIGGER fail_on_boom BEFORE INSERT ON ${TABLE}
      WHEN NEW.value = 'BOOM'
      BEGIN SELECT RAISE(ABORT, 'forced store fault'); END;
    `);
  });

  afterEach(async () => {
    if (observer.open) observer.close();
    await plugin.shutdown?.();
    await rm(dir, { recursive: true, force: true });
  });

  function rowCount(): number {
    return (observer.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get() as { n: number }).n;
  }

  async function record(input: RecordInput): Promise<RecordOutput> {
    return bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, input);
  }

  it('rolls back the statements that already succeeded', async () => {
    let caught: unknown;
    try {
      await record({
        batchKey: 'turn-1',
        statements: [
          // Settles fine...
          { about: 'user', relation: 'lives_in', value: 'Boston', when: JAN, slot: 'lives_in' },
          // ...and this one aborts inside the store, after the first row is
          // already inserted. With a transaction per statement, Boston would
          // survive; with one transaction per batch, it does not.
          { about: 'user', relation: 'likes_food', value: 'BOOM', when: JAN },
        ],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('store-unavailable');
    // The raw SQLite error is preserved for whoever has to debug this, rather
    // than being flattened into the message.
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(Error);

    expect(rowCount()).toBe(0);
  });

  it('leaves the batchKey clean, so the corrected retry records for real', async () => {
    await expect(
      record({
        batchKey: 'turn-2',
        statements: [
          { about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN },
          { about: 'user', relation: 'likes_food', value: 'BOOM', when: JAN },
        ],
      }),
    ).rejects.toThrow();
    expect(rowCount()).toBe(0);

    // A half-written batch would poison the key forever: the retry would find
    // rows for it and replay a partial result as though it were complete.
    const retry = await record({
      batchKey: 'turn-2',
      statements: [
        { about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN },
        { about: 'user', relation: 'likes_food', value: 'ramen', when: JAN },
      ],
    });
    expect(retry.records).toHaveLength(2);
    expect(rowCount()).toBe(2);

    const out = await bus.call<RecallInput, RecallOutput>('memory:facts:recall', ctx, {
      about: 'user',
      limit: 200,
    });
    expect(out.statements.map((s) => s.value).sort()).toEqual(['Khalid', 'ramen']);
  });

  it('does not damage a batch that was already committed before the fault', async () => {
    const good = await record({
      batchKey: 'turn-ok',
      statements: [{ about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN }],
    });
    expect(rowCount()).toBe(1);

    await expect(
      record({
        batchKey: 'turn-bad',
        statements: [{ about: 'user', relation: 'likes_food', value: 'BOOM', when: JAN }],
      }),
    ).rejects.toThrow();

    // Rollback is scoped to the failing batch's transaction, not the file.
    expect(rowCount()).toBe(1);
    const replay = await record({
      batchKey: 'turn-ok',
      statements: [{ about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN }],
    });
    expect(replay.records.map((r) => r.id)).toEqual(good.records.map((r) => r.id));
  });
});
