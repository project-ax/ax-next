// The NUL-delimiter group-key collision (TASK-448), pinned SQLITE-LOCALLY.
//
// This used to be a `@ax/memory-facts-contract` case, with the colliding
// character U+0000. TASK-423 moved it here when the postgres backend
// arrived: postgres `TEXT` rejects an embedded NUL at the INSERT itself
// (SQLSTATE 22021), so the contract fixture had to switch to U+0001 to keep
// testing something both backends can store — see
// `packages/memory-facts-contract/src/index.ts`'s `COLLIDING_CHAR` doc
// comment for the full story.
//
// But U+0001 cannot pin the NUL case specifically: a revert of the group key
// in `closure.ts` (`supersedeIds`) or `plugin.ts` (`reindex`) from
// `JSON.stringify([about, slot])` back to a NUL-joined template string
// (`` `${about}\u0000${slot}` ``) would now pass the contract, because the
// contract's fixture no longer contains a NUL to collide on. That is the
// exact bug TASK-448 fixed, silently unpinned.
//
// It cannot be pinned portably — a delimiter collision needs the delimiter
// INSIDE a field, and no postgres field can hold U+0000 — so it belongs where
// it is reachable: a package-local test against the backend that CAN store
// it. Mirrors `batch-atomicity.test.ts`'s pattern (construct the plugin
// directly, drive it over a real `HookBus`) rather than `runFactsContract`.
//
// Escape sequence only (`\u0000`), never a raw NUL byte — a literal NUL in
// this source file makes git treat it as binary.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HookBus, makeAgentContext, type Plugin } from '@ax/core';
import type {
  RecordInput,
  RecordOutput,
  SupersedeInput,
  SupersedeOutput,
  ReindexInput,
  ReindexOutput,
  RecordedStatement,
} from '@ax/memory-facts-contract';
import { createMemoryFactsSqlitePlugin } from '../plugin.js';

const JAN = '2023-01-01T00:00:00.000Z';
const JUN = '2023-06-01T00:00:00.000Z';

/** The delimiter a NUL-joined group key would use. Never appears in real data. */
const NUL = '\u0000';

describe('@ax/memory-facts-sqlite — NUL-joined group-key collision (TASK-448, sqlite-local since TASK-423)', () => {
  let dir: string;
  let bus: HookBus;
  let plugin: Plugin;

  const ctx = makeAgentContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    workspace: { rootPath: '/tmp' },
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-nul-'));
    const databasePath = join(dir, 'facts.db');
    bus = new HookBus();
    plugin = createMemoryFactsSqlitePlugin({ databasePath });
    await plugin.init({ bus, config: {} });
  });

  afterEach(async () => {
    await plugin.shutdown?.();
    await rm(dir, { recursive: true, force: true });
  });

  async function record(input: RecordInput): Promise<RecordOutput> {
    return bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, input);
  }
  async function supersede(ids: string[]): Promise<SupersedeOutput> {
    return bus.call<SupersedeInput, SupersedeOutput>('memory:facts:supersede', ctx, { ids });
  }
  async function reindex(input: ReindexInput): Promise<ReindexOutput> {
    return bus.call<ReindexInput, ReindexOutput>('memory:facts:reindex', ctx, input);
  }

  // Two groups whose NUL-joined `(about, slot)` keys collide:
  //   about = "x\u0000y", slot = "z"      -> "x\u0000y\u0000z"
  //   about = "x",         slot = "y\u0000z" -> "x\u0000y\u0000z"
  // Only a STRUCTURAL key (JSON.stringify([about, slot])) tells them apart.
  const ABOUT1 = `x${NUL}y`;
  const SLOT1 = 'z';
  const ABOUT2 = 'x';
  const SLOT2 = `y${NUL}z`;

  it('memory:facts:supersede re-settles BOTH groups when their NUL-joined keys would collide', async () => {
    const [older1, newer1] = (
      await record({
        statements: [
          { about: ABOUT1, relation: 'r', value: 'old1', when: JAN, slot: SLOT1 },
          { about: ABOUT1, relation: 'r', value: 'new1', when: JUN, slot: SLOT1 },
        ],
      })
    ).records as [RecordedStatement, RecordedStatement];
    expect(newer1.closes).toEqual([older1.id]);

    const [older2, newer2] = (
      await record({
        statements: [
          { about: ABOUT2, relation: 'r', value: 'old2', when: JAN, slot: SLOT2 },
          { about: ABOUT2, relation: 'r', value: 'new2', when: JUN, slot: SLOT2 },
        ],
      })
    ).records as [RecordedStatement, RecordedStatement];
    expect(newer2.closes).toEqual([older2.id]);

    const result = await supersede([newer1.id, newer2.id]);
    expect(result.closed.slice().sort()).toEqual([newer1.id, newer2.id].sort());
    // Against a NUL-joined key, only ONE of these two groups survives in the
    // Map, so exactly one of these ids would be missing here.
    expect(result.resettled.slice().sort()).toEqual([older1.id, older2.id].sort());
  });

  it('memory:facts:reindex settles BOTH groups when their NUL-joined keys would collide', async () => {
    const PENDING = 'pending';

    const [older1, pending1] = (
      await record({
        statements: [
          { about: ABOUT1, relation: 'r', value: 'old1', when: JAN, slot: SLOT1 },
          { about: ABOUT1, relation: 'r', value: 'new1', when: JUN, slot: PENDING },
        ],
      })
    ).records as [RecordedStatement, RecordedStatement];
    expect(pending1.closes).toEqual([]);

    const [older2, pending2] = (
      await record({
        statements: [
          { about: ABOUT2, relation: 'r', value: 'old2', when: JAN, slot: SLOT2 },
          { about: ABOUT2, relation: 'r', value: 'new2', when: JUN, slot: PENDING },
        ],
      })
    ).records as [RecordedStatement, RecordedStatement];
    expect(pending2.closes).toEqual([]);

    const out = await reindex({
      slots: [
        { id: pending1.id, slot: SLOT1 },
        { id: pending2.id, slot: SLOT2 },
      ],
    });
    expect(out.resolved).toBe(2);
    // Against a NUL-joined key, only ONE of these two groups survives in the
    // Map, so exactly one of these ids would be missing here.
    expect(out.resettled.slice().sort()).toEqual([older1.id, older2.id].sort());
    expect(out.pending).toBe(0);
    expect(out.degraded).toEqual([]);
  });
});
