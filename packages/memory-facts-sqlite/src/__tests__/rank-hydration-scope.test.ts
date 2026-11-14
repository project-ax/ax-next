// `rowsInRankOrder` is the fusion path's LAST step: the channels rank ids,
// this hydrates them back into rows. Its `WHERE` is therefore the last place
// a scope can be dropped, and dropping it there is silent — the rows still
// come back and still look like a perfectly good answer.
//
// This file exists because a mutation pass on TASK-488 found that removing the
// owner predicate from this function reddened NOTHING: all 178 engine tests
// and all 70 `@ax/memory` tests stayed green, because every id reaching here
// already came out of an owner-filtered channel. That is exactly the shape of
// an untested guard — correct today, and quietly load-bearing the moment
// someone adds a fourth channel or edits `scopeFilter`.
//
// So the predicate is asserted directly, by handing the function ids it should
// refuse rather than ids it will never be given.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as BetterSqliteDb } from 'better-sqlite3';

import { openDatabase, TABLE, INFINITY_SENTINEL } from '../schema.js';
import { rowsInRankOrder } from '../recall.js';

const AGENT = 'agent-1';
const OTHER_AGENT = 'agent-2';
const ALICE = 'user-alice';
const BOB = 'user-bob';

let dir: string;
let driver: BetterSqliteDb;

function insert(
  id: string,
  agentKey: string,
  ownerUserId: string | null,
  audience: string | null = null,
): void {
  driver
    .prepare(
      `INSERT INTO ${TABLE}
         (id, agent_key, about, relation, value,
          valid_start, valid_end, transaction_time, provenance, owner_user_id, audience)
       VALUES (?, ?, 'user', 'lives_in', ?,
               '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z', 'human', ?, ?)`,
    )
    .run(id, agentKey, `city-${id}`, INFINITY_SENTINEL, ownerUserId, audience);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ax-rank-scope-'));
  driver = openDatabase(join(dir, 'facts.db')).driver;
  insert('alice-1', AGENT, ALICE);
  insert('bob-1', AGENT, BOB);
  insert('unowned-1', AGENT, null);
  insert('other-tenant-1', OTHER_AGENT, ALICE);
});

afterEach(async () => {
  driver.close();
  await rm(dir, { recursive: true, force: true });
});

describe('rowsInRankOrder — the owner predicate is in the SQL', () => {
  it('hydrates every owner in the tenant when no owner is named', () => {
    const rows = rowsInRankOrder<{ id: string }>(driver, AGENT, [
      'alice-1',
      'bob-1',
      'unowned-1',
    ]);
    // Unscoped is still the default and still means "the whole tenant" —
    // this is the behaviour every pre-TASK-488 caller has.
    expect(rows.map((r) => r.id)).toEqual(['alice-1', 'bob-1', 'unowned-1']);
  });

  it("drops another OWNER's id rather than hydrating it", () => {
    const rows = rowsInRankOrder<{ id: string }>(driver, AGENT, ['alice-1', 'bob-1'], {
      ownerUserId: ALICE,
    });
    expect(rows.map((r) => r.id)).toEqual(['alice-1']);
  });

  it('drops an UNOWNED row — unowned is not provably yours', () => {
    // Strict `=`, so SQL's three-valued logic makes `owner_user_id IS NULL`
    // simply not match. Fail-closed is the only direction a scope may be
    // wrong in (Invariant 5).
    const rows = rowsInRankOrder<{ id: string }>(driver, AGENT, ['alice-1', 'unowned-1'], {
      ownerUserId: ALICE,
    });
    expect(rows.map((r) => r.id)).toEqual(['alice-1']);
  });

  it('still drops another TENANT\'s id when the owner matches — owner NARROWS, never widens', () => {
    const rows = rowsInRankOrder<{ id: string }>(
      driver,
      AGENT,
      ['alice-1', 'other-tenant-1'],
      { ownerUserId: ALICE },
    );
    expect(rows.map((r) => r.id)).toEqual(['alice-1']);
  });

  it('preserves the ranked order it was given, scoped or not', () => {
    const rows = rowsInRankOrder<{ id: string }>(driver, AGENT, ['unowned-1', 'bob-1', 'alice-1']);
    expect(rows.map((r) => r.id)).toEqual(['unowned-1', 'bob-1', 'alice-1']);
  });

  it('scopes past the 500-id chunk boundary, not just the first chunk', () => {
    // The hydration batches ids in chunks of 500 and the owner parameter is
    // bound per chunk. A predicate spliced into only the first prepared
    // statement would pass every test above and leak on the 501st id.
    const ids: string[] = [];
    for (let i = 0; i < 600; i += 1) {
      const id = `bulk-${i}`;
      insert(id, AGENT, i === 550 ? BOB : ALICE);
      ids.push(id);
    }
    const rows = rowsInRankOrder<{ id: string }>(driver, AGENT, ids, { ownerUserId: ALICE });
    expect(rows).toHaveLength(599);
    expect(rows.some((r) => r.id === 'bulk-550')).toBe(false);
  });
});

// TASK-1091. The audience clause is a second scope on the same last step, and
// for the same reason it is asserted here directly: every id a shared recall
// hands this function already came out of an audience-filtered channel, so
// dropping the clause from the hydration would redden nothing else.
describe('rowsInRankOrder — the audience predicate is in the SQL', () => {
  beforeEach(() => {
    insert('shared-1', AGENT, ALICE, 'shared');
    insert('private-1', AGENT, ALICE, 'private');
    insert('other-tenant-shared-1', OTHER_AGENT, ALICE, 'shared');
  });

  it('drops a private row AND an unstamped one from a shared hydration', () => {
    // `alice-1` was inserted with no audience at all — the shape of every row
    // stored before the stamp existed. Strict `=` means NULL never matches.
    const rows = rowsInRankOrder<{ id: string }>(
      driver,
      AGENT,
      ['private-1', 'shared-1', 'alice-1'],
      { audience: 'shared' },
    );
    expect(rows.map((r) => r.id)).toEqual(['shared-1']);
  });

  it('composes with the owner and tenant predicates — each one only narrows', () => {
    insert('bob-shared-1', AGENT, BOB, 'shared');
    const rows = rowsInRankOrder<{ id: string }>(
      driver,
      AGENT,
      ['bob-shared-1', 'other-tenant-shared-1', 'shared-1', 'private-1'],
      { ownerUserId: ALICE, audience: 'shared' },
    );
    expect(rows.map((r) => r.id)).toEqual(['shared-1']);
  });

  it('rank hydration applies the audience clause across the 500-id chunk boundary', () => {
    // Same trap as the owner case above: the clause is bound per chunk, and a
    // predicate spliced into only the first prepared statement would leak on
    // the 501st id.
    const ids: string[] = [];
    for (let i = 0; i < 600; i += 1) {
      const id = `aud-bulk-${i}`;
      insert(id, AGENT, ALICE, i === 550 ? 'private' : i === 575 ? null : 'shared');
      ids.push(id);
    }
    const rows = rowsInRankOrder<{ id: string }>(driver, AGENT, ids, { audience: 'shared' });
    expect(rows).toHaveLength(598);
    expect(rows.some((r) => r.id === 'aud-bulk-550' || r.id === 'aud-bulk-575')).toBe(false);
    // Order is still the ranking's, not the planner's.
    expect(rows[0]!.id).toBe('aud-bulk-0');
    expect(rows[597]!.id).toBe('aud-bulk-599');
  });
});
