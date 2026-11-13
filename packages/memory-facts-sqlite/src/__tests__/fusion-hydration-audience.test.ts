// `fusionRecall` hands its rank hydration (`rowsInRankOrder`) the very scope
// object its channels ran with: owner AND audience. The hydration's audience
// predicate itself is pinned in `rank-hydration-scope.test.ts`, by calling it
// directly. Its CALL SITE was not pinned: the TASK-1091 review reverted it to
// pass only the owner, and nothing reddened, because every id a shared recall
// hydrates already came out of an audience-filtered channel.
//
// So this file makes every channel forget the audience. `vi.mock` wraps all
// three to drop it from their scope before they run (owner, tenant and the
// rest stay), which is a channel written without its scope: the case the
// hydration's predicate exists for. Only the hydration can filter now, so a
// shared recall answers with shared rows only if `fusionRecall` handed it the
// audience.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import type {
  RecallInput,
  RecallOutput,
  RecordInput,
  RecordOutput,
} from '@ax/memory-facts-contract';
import { createMemoryFactsSqlitePlugin } from '../plugin.js';
import { openDatabase } from '../schema.js';
import { temporalChannel } from '../recall.js';
import { agentScopeKey } from '../agent-scope-key.js';

vi.mock('../recall.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../recall.js')>();
  const forget = <S extends { audience?: 'shared' }>(scope: S): S => {
    const { audience: _forgotten, ...rest } = scope;
    return rest as S;
  };
  return {
    ...actual,
    sparseChannel: ((driver, scope) =>
      actual.sparseChannel(driver, forget(scope))) as typeof actual.sparseChannel,
    denseChannel: ((driver, scope, vector) =>
      actual.denseChannel(driver, forget(scope), vector)) as typeof actual.denseChannel,
    temporalChannel: ((driver, scope) =>
      actual.temporalChannel(driver, forget(scope))) as typeof actual.temporalChannel,
  };
});

const JAN = '2023-01-01T00:00:00.000Z';
const OWNER = 'user-1';

describe('fusionRecall hands its rank hydration the audience scope (TASK-1091)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-hydration-audience-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a shared recall answers with shared rows only, even when every channel forgets the audience', async () => {
    const databasePath = join(dir, 'facts.db');
    const bus = new HookBus();
    const plugin = createMemoryFactsSqlitePlugin({ databasePath });
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'a',
      userId: OWNER,
      workspace: { rootPath: '/tmp' },
    });

    let sharedId: string;
    let otherIds: string[];
    try {
      const shared = await bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, {
        statements: [
          { about: 'project:atlas', relation: 'uses_tool', value: 'Jira', when: JAN, ownerUserId: OWNER, audience: 'shared' },
        ],
      });
      // Same owner, so the owner predicate can't remove them: only the
      // audience one can. The last is unstamped (stored before the stamp
      // existed), which is not provably shared either.
      const others = await bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, {
        statements: [
          { about: 'project:atlas', relation: 'stated', value: 'Jira board for the private launch', when: JAN, ownerUserId: OWNER, audience: 'private' },
          { about: 'project:atlas', relation: 'stated', value: 'Jira login lives in the vault', when: JAN, ownerUserId: OWNER, audience: 'private' },
          { about: 'project:atlas', relation: 'stated', value: 'Jira export from last year', when: JAN, ownerUserId: OWNER },
        ],
      });
      sharedId = shared.records[0]!.id;
      otherIds = others.records.map((r) => r.id);

      // @ax/memory's shape for a shared turn's recall: owner and audience.
      const out = await bus.call<RecallInput, RecallOutput>('memory:facts:recall', ctx, {
        query: 'Jira',
        limit: 10,
        ownerUserId: OWNER,
        audience: 'shared',
      });
      expect(out.statements.map((s) => s.id)).toEqual([sharedId]);
      expect(out.statements.every((s) => s.audience === 'shared')).toBe(true);
    } finally {
      await plugin.shutdown?.();
    }

    // The premise: with the audience forgotten, a channel DOES propose the
    // other rows, so the answer above was the hydration's doing.
    const db = openDatabase(databasePath).driver;
    try {
      const proposed = temporalChannel(db, {
        agentKey: agentScopeKey({ agentId: 'a' }),
        activeOnly: true,
        limit: 40,
        ownerUserId: OWNER,
        audience: 'shared',
      });
      expect(new Set(proposed)).toEqual(new Set([sharedId, ...otherIds]));
    } finally {
      db.close();
    }
  });
});
