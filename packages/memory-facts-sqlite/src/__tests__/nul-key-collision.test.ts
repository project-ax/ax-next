// Legacy NUL group keys (TASK-448) remain possible in SQLite rows written before
// TASK-459. New record/reindex payloads reject those controls; fixture-only updates
// below seed historical rows without weakening the public write boundary.
//
// Supersede still has to distinguish the legacy NUL-key pairs after reopening.
// Reindex must reject a newly supplied NUL slot before resolving any pending row.
// Escape sequences only: a raw NUL byte would make git treat this file as binary.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HookBus, makeAgentContext, type Plugin } from '@ax/core';
import type {
  RecordInput,
  RecordOutput,
  RecallInput,
  RecallOutput,
  SupersedeInput,
  SupersedeOutput,
  ReindexInput,
  ReindexOutput,
  RecordedStatement,
} from '@ax/memory-facts-contract';
import { createMemoryFactsSqlitePlugin } from '../plugin.js';
import { openDatabase, TABLE } from '../schema.js';

const JAN = '2023-01-01T00:00:00.000Z';
const JUN = '2023-06-01T00:00:00.000Z';

/** The delimiter present in these legacy stored fields. */
const NUL = '\u0000';

describe('@ax/memory-facts-sqlite — NUL-joined group-key collision (TASK-448, sqlite-local since TASK-423)', () => {
  let dir: string;
  let bus: HookBus;
  let plugin: Plugin;
  let databasePath: string;
  let observer: ReturnType<typeof openDatabase>['driver'];

  const ctx = makeAgentContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    workspace: { rootPath: '/tmp' },
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-nul-'));
    databasePath = join(dir, 'facts.db');
    bus = new HookBus();
    plugin = createMemoryFactsSqlitePlugin({ databasePath });
    await plugin.init({ bus, config: {} });
    observer = openDatabase(databasePath).driver;
  });

  afterEach(async () => {
    if (observer.open) observer.close();
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

  async function recordLegacy(input: RecordInput): Promise<RecordOutput> {
    const encode = (value: string) => value.replaceAll(NUL, '|legacy-nul|');
    const seeded = await record({
      ...input,
      statements: input.statements.map((statement) => ({
        ...statement,
        about: encode(statement.about),
        ...(statement.slot !== undefined ? { slot: encode(statement.slot) } : {}),
      })),
    });
    const update = observer.prepare(`UPDATE ${TABLE} SET about = ?, slot = ? WHERE id = ?`);
    return {
      records: seeded.records.map((row, index) => {
        const statement = input.statements[index]!;
        update.run(statement.about, statement.slot ?? null, row.id);
        return {
          ...row,
          about: statement.about,
          ...(statement.slot !== undefined ? { slot: statement.slot } : {}),
        };
      }),
    };
  }

  async function recall(): Promise<RecallOutput> {
    return bus.call<RecallInput, RecallOutput>('memory:facts:recall', ctx, {
      activeOnly: false, limit: 200,
    });
  }

  // Two groups whose NUL-joined `(about, slot)` keys collide:
  //   about = "x\u0000y", slot = "z"      -> "x\u0000y\u0000z"
  //   about = "x",         slot = "y\u0000z" -> "x\u0000y\u0000z"
  // Only a STRUCTURAL key (JSON.stringify([about, slot])) tells them apart.
  const ABOUT1 = `x${NUL}y`;
  const SLOT1 = 'z';
  const ABOUT2 = 'x';
  const SLOT2 = `y${NUL}z`;

  it('compatibility: supersede re-settles both legacy NUL-key groups after reopening', async () => {
    const [older1, newer1] = (
      await recordLegacy({
        statements: [
          { about: ABOUT1, relation: 'r', value: 'old1', when: JAN, slot: SLOT1 },
          { about: ABOUT1, relation: 'r', value: 'new1', when: JUN, slot: SLOT1 },
        ],
      })
    ).records as [RecordedStatement, RecordedStatement];
    expect(newer1.closes).toEqual([older1.id]);

    const [older2, newer2] = (
      await recordLegacy({
        statements: [
          { about: ABOUT2, relation: 'r', value: 'old2', when: JAN, slot: SLOT2 },
          { about: ABOUT2, relation: 'r', value: 'new2', when: JUN, slot: SLOT2 },
        ],
      })
    ).records as [RecordedStatement, RecordedStatement];
    expect(newer2.closes).toEqual([older2.id]);

    await plugin.shutdown?.();
    bus = new HookBus();
    plugin = createMemoryFactsSqlitePlugin({ databasePath });
    await plugin.init({ bus, config: {} });
    const legacy = (await recall()).statements;
    expect(legacy).toHaveLength(4);
    expect(legacy.find((row) => row.id === older1.id)?.about).toBe(ABOUT1);
    expect(legacy.find((row) => row.id === older2.id)?.slot).toBe(SLOT2);

    const result = await supersede([newer1.id, newer2.id]);
    expect(result.closed.slice().sort()).toEqual([newer1.id, newer2.id].sort());
    // Against a NUL-joined key, only ONE of these two groups survives in the
    // Map, so exactly one of these ids would be missing here.
    expect(result.resettled.slice().sort()).toEqual([older1.id, older2.id].sort());
  });

  it('reindex refuses a new NUL slot atomically without changing legacy rows', async () => {
    const PENDING = 'pending';

    const [older1, pending1] = (
      await recordLegacy({
        statements: [
          { about: ABOUT1, relation: 'r', value: 'old1', when: JAN, slot: SLOT1 },
          { about: ABOUT1, relation: 'r', value: 'new1', when: JUN, slot: PENDING },
        ],
      })
    ).records as [RecordedStatement, RecordedStatement];
    expect(pending1.closes).toEqual([]);

    const [older2, pending2] = (
      await recordLegacy({
        statements: [
          { about: ABOUT2, relation: 'r', value: 'old2', when: JAN, slot: SLOT2 },
          { about: ABOUT2, relation: 'r', value: 'new2', when: JUN, slot: PENDING },
        ],
      })
    ).records as [RecordedStatement, RecordedStatement];
    expect(pending2.closes).toEqual([]);

    const before = (await recall()).statements;
    await expect(reindex({
      slots: [
        { id: pending1.id, slot: SLOT1 },
        { id: pending2.id, slot: SLOT2 },
      ],
    })).rejects.toMatchObject({ code: 'invalid-payload' });
    const rows = (await recall()).statements;
    expect(rows).toEqual(before);
    expect(rows.find((row) => row.id === pending1.id)?.slot).toBe(PENDING);
    expect(rows.find((row) => row.id === pending2.id)?.slot).toBe(PENDING);
    expect(rows.find((row) => row.id === older2.id)?.slot).toBe(SLOT2);
    expect(rows.find((row) => row.id === older1.id)?.until).toBeUndefined();
  });
});
