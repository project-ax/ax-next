// `indexFactRow` — the two defects T2 shipped, and the behaviour that
// replaces them (TASK-434 part A,
// `.claude/memory/decisions/2026-09-19-TASK-434.md`, last row).
//
// Both are about information, not crashes, which is why neither was caught by
// T2's own tests: the duplicate FTS row makes every ranking slightly wrong
// without failing anything, and the bare `catch {}` made "the vector store
// rejected this" indistinguishable from "there is no vector store here".

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as BetterSqliteDb } from 'better-sqlite3';
import { reciprocalRankFusion } from '@ax/memory-facts-contract';
import {
  openDatabase,
  indexFactRow,
  TABLE,
  FTS_TABLE,
  VEC_TABLE,
  EMBEDDING_DIMENSIONS,
  INFINITY_SENTINEL,
} from '../schema.js';
import { buildFtsMatchQuery, sparseChannel } from '../recall.js';

const AGENT = 'agent:a';
const FACT = { id: 'f1', about: 'user', relation: 'likes_artist', value: 'Khalid' };

describe('@ax/memory-facts-sqlite — indexFactRow', () => {
  let dir: string;
  let driver: BetterSqliteDb;
  let vectorExtensionLoaded: boolean;

  function insertBaseRow(id: string, value: string, when: string): void {
    driver
      .prepare(
        `INSERT INTO ${TABLE}
           (id, agent_key, about, relation, value, provenance, valid_start, valid_end,
            transaction_time, batch_seq)
         VALUES (?, ?, ?, ?, ?, 'extracted', ?, ?, ?, 0)`,
      )
      .run(id, AGENT, 'user', 'likes_artist', value, when, INFINITY_SENTINEL, when);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-index-'));
    const opened = openDatabase(join(dir, 'facts.db'));
    driver = opened.driver;
    vectorExtensionLoaded = opened.vectorExtensionLoaded;
  });

  afterEach(async () => {
    if (driver.open) driver.close();
    await rm(dir, { recursive: true, force: true });
  });

  // Against the UNFIXED code (unconditional INSERT): the count is 2, the
  // sparse channel returns the id twice, and RRF sums 1/(k+rank+1) twice for
  // one row — so all three assertions fail. This is the whole reason the
  // second index call has to be idempotent: `reindex`'s backfill calls
  // `indexFactRow` for facts that may already be indexed.
  it('is idempotent per id — a second index leaves ONE sparse row, not two', () => {
    insertBaseRow(FACT.id, 'Khalid', '2023-01-01T00:00:00.000Z');

    indexFactRow(driver, FACT, { vectorExtensionLoaded });
    const single = sparseChannel(driver, {
      agentKey: AGENT,
      match: buildFtsMatchQuery('Khalid')!,
      activeOnly: true,
      limit: 40,
    });
    const singleScore = reciprocalRankFusion([single])[0]!.score;

    indexFactRow(driver, FACT, { vectorExtensionLoaded });

    const rows = driver
      .prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE} WHERE id = ?`)
      .get(FACT.id) as { n: number };
    expect(rows.n).toBe(1);

    const twice = sparseChannel(driver, {
      agentKey: AGENT,
      match: buildFtsMatchQuery('Khalid')!,
      activeOnly: true,
      limit: 40,
    });
    expect(twice).toEqual([FACT.id]);
    // The assertion that actually names the damage: a double-indexed row
    // outranks a once-indexed one purely by being indexed twice.
    expect(reciprocalRankFusion([twice])[0]!.score).toBe(singleScore);
  });

  // The same defect seen end-to-end through the ranking, because "the count is
  // 1" is a structural assertion a future implementation could satisfy while
  // still double-counting some other way (two FTS tables, say).
  it('does not let a re-indexed row outrank an equally-relevant single-indexed one', () => {
    insertBaseRow('dup', 'Khalid', '2023-01-01T00:00:00.000Z');
    insertBaseRow('once', 'Khalid', '2023-01-02T00:00:00.000Z');
    indexFactRow(driver, { ...FACT, id: 'dup' }, { vectorExtensionLoaded });
    indexFactRow(driver, { ...FACT, id: 'dup' }, { vectorExtensionLoaded });
    indexFactRow(driver, { ...FACT, id: 'once' }, { vectorExtensionLoaded });

    const fused = reciprocalRankFusion([
      sparseChannel(driver, {
        agentKey: AGENT,
        match: buildFtsMatchQuery('Khalid')!,
        activeOnly: true,
        limit: 40,
      }),
    ]);
    // Two equally-relevant rows: whatever order bm25 puts them in, their
    // scores must not differ by "one of them was indexed twice".
    const byId = new Map(fused.map((c) => [c.id, c.score]));
    expect(byId.get('dup')).toBeDefined();
    expect(byId.get('once')).toBeDefined();
    expect(fused).toHaveLength(2);
  });

  // Against the UNFIXED code: the bare `catch {}` swallows the throw from
  // `vectorToBlob`, so this expectation of a throw fails. A 383-dimension
  // vector is a PROGRAMMING error (a mis-shaped embedder response), not a
  // platform capability gap, and the two must not look the same.
  it('surfaces a dimension mismatch instead of silently skipping the vector', () => {
    insertBaseRow(FACT.id, 'Khalid', '2023-01-01T00:00:00.000Z');
    expect(() =>
      indexFactRow(driver, FACT, {
        vector: new Array(EMBEDDING_DIMENSIONS - 1).fill(0.1),
        vectorExtensionLoaded,
      }),
    ).toThrow(/dimension mismatch/i);
  });

  // Against the UNFIXED code: there is no return value at all, so the caller
  // cannot tell a stored vector from a skipped one — which is the information
  // `recall` needs to raise `degraded: ['semantic']` honestly (§4.4).
  it('reports whether the dense vector was actually stored', () => {
    insertBaseRow(FACT.id, 'Khalid', '2023-01-01T00:00:00.000Z');

    expect(indexFactRow(driver, FACT, { vectorExtensionLoaded })).toEqual({
      vectorStored: false,
    });

    const stored = indexFactRow(driver, FACT, {
      vector: new Array(EMBEDDING_DIMENSIONS).fill(0.1),
      vectorExtensionLoaded,
    });
    expect(stored).toEqual({ vectorStored: vectorExtensionLoaded });
    if (vectorExtensionLoaded) {
      const n = driver
        .prepare(`SELECT COUNT(*) AS n FROM ${VEC_TABLE} WHERE id = ?`)
        .get(FACT.id) as { n: number };
      expect(n.n).toBe(1);
    }
  });

  // The one case the old `catch {}` was legitimately written for, now decided
  // by ASKING (the caller's `vectorExtensionLoaded`) rather than by failing.
  // Against the unfixed code this passed for the wrong reason — it took the
  // exception path — and passed identically for a genuine store failure.
  it('skips the vector write, without throwing, when the extension is unavailable', () => {
    insertBaseRow(FACT.id, 'Khalid', '2023-01-01T00:00:00.000Z');
    const result = indexFactRow(driver, FACT, {
      vector: new Array(EMBEDDING_DIMENSIONS).fill(0.1),
      vectorExtensionLoaded: false,
    });
    expect(result).toEqual({ vectorStored: false });
    // The sparse half still landed: losing the dense channel never costs the
    // lexical one.
    const n = driver
      .prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE} WHERE id = ?`)
      .get(FACT.id) as { n: number };
    expect(n.n).toBe(1);
  });
});
