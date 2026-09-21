import { afterEach, describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, type AgentContext } from '@ax/core';

import { createMemoryPlugin } from '../plugin.js';
import type { MemoryRememberOutput } from '../types.js';
import { ALICE, BOB, engineRecall, makeMemoryHarness, type MemoryHarness } from './harness.js';

// ---------------------------------------------------------------------------
// The normalizer's WIRING, not the normalizer.
//
// `slots.test.ts` calls `deriveSlot` directly, and a lookup table is exactly
// the shape where every test does that and nothing covers how the answer
// reaches the store — so a mutation to the wiring reddens nothing. These cases
// watch the `memory:facts:record` payload and then watch the row it produced.
// ---------------------------------------------------------------------------

function ctx(): AgentContext {
  return makeAgentContext({
    sessionId: 's',
    agentId: 'agent-1',
    userId: 'user-alice',
    workspace: { rootPath: '/tmp' },
  });
}

interface RecordedStatement {
  about: string;
  relation: string;
  value: string;
  when: string;
  provenance: string;
  ownerUserId: string;
  slot?: unknown;
}

/** A stub engine that keeps the statements it was handed, verbatim. */
async function busWatchingRecord(): Promise<{
  remember: (relation: string) => Promise<MemoryRememberOutput>;
  recorded: RecordedStatement[];
}> {
  const bus = new HookBus();
  const recorded: RecordedStatement[] = [];
  bus.registerService('memory:facts:recall', 'stub', async () => ({ statements: [], degraded: [] }));
  bus.registerService(
    'memory:facts:record',
    'stub',
    async (_c: AgentContext, input: unknown) => {
      recorded.push(...((input as { statements: RecordedStatement[] }).statements ?? []));
      return { records: [{ id: 'row-1' }] };
    },
  );
  bus.registerService('memory:facts:supersede', 'stub', async () => ({ closed: [], resettled: [] }));
  await createMemoryPlugin().init({ bus, config: {} });
  return {
    recorded,
    remember: (relation) =>
      bus.call<unknown, MemoryRememberOutput>('memory:remember', ctx(), {
        about: 'user',
        relation,
        value: 'somewhere',
        when: '2026-01-01T00:00:00Z',
      }),
  };
}

describe('memory:remember carries the derived slot to the engine', () => {
  it('sends the slot for a relation the table maps', async () => {
    const { remember, recorded } = await busWatchingRecord();
    await remember('lives_in');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.slot).toBe('lives_in');
  });

  it('normalizes spelling on the way — the wire carries the canonical slot', async () => {
    const { remember, recorded } = await busWatchingRecord();
    await remember('Lives   In');
    expect(recorded[0]?.slot).toBe('lives_in');
    // …and the free-text relation is untouched. `relation` is what retrieval
    // reads; `slot` is what supersession matches on. Collapsing them is the
    // whole reason supersession could not work on `relation` alone.
    expect(recorded[0]?.relation).toBe('Lives   In');
  });

  it('OMITS the field entirely for a relation with no slot', async () => {
    const { remember, recorded } = await busWatchingRecord();
    await remember('visited');
    // Absent, not `undefined` and not `null`: `FactStatementInput.slot` is
    // optional and absent means "no slot — stored, retrievable, inert".
    // `slot: null` is a different and unsupported claim, and `'slot' in row`
    // is the only assertion that tells the two apart.
    expect(Object.hasOwn(recorded[0] ?? {}, 'slot')).toBe(false);
  });

  it('omits the field for a prototype-key relation, and never sends a function', async () => {
    // Model output reaching a supersession key. See the prototype-pollution
    // guard in `slots.test.ts`.
    const { remember, recorded } = await busWatchingRecord();
    await remember('constructor');
    expect(Object.hasOwn(recorded[0] ?? {}, 'slot')).toBe(false);
    expect(typeof recorded[0]?.slot).not.toBe('function');
  });

  it('never sends the reserved pending sentinel', async () => {
    const { remember, recorded } = await busWatchingRecord();
    for (const relation of ['pending', 'lives_in', 'recommended']) {
      await remember(relation);
    }
    for (const row of recorded) {
      expect(row.slot).not.toBe('pending');
    }
  });
});

// ---------------------------------------------------------------------------
// End to end, over the real sqlite engine: does the derived slot actually
// close a row, and does a no-slot row actually close nothing?
// ---------------------------------------------------------------------------

describe('a derived slot closes the previous statement — and a no-slot one does not', () => {
  let harness: MemoryHarness | undefined;

  afterEach(async () => {
    await harness?.teardown();
    harness = undefined;
  });

  const JAN = '2026-01-01T00:00:00Z';
  const JUN = '2026-06-01T00:00:00Z';

  it('supersedes the older lives_in, and says when it stopped being true', async () => {
    harness = await makeMemoryHarness();
    const first = await harness.remember({ about: 'user', relation: 'lives_in', value: 'Seattle', when: JAN });
    const second = await harness.remember({ about: 'user', relation: 'lives_in', value: 'Austin', when: JUN });

    const active = await harness.recall({ limit: 10 });
    expect(active.statements.map((s) => s.value)).toEqual(['Austin']);

    const all = await harness.recall({ limit: 10, activeOnly: false });
    const seattle = all.statements.find((s) => s.id === first.id);
    const austin = all.statements.find((s) => s.id === second.id);
    // The engine stores instants canonically (`…00:00:00.000Z`), so compare
    // the instants rather than the spellings.
    expect(seattle?.until).toBeDefined();
    expect(new Date(seattle!.until!).toISOString()).toBe(new Date(JUN).toISOString());
    expect(austin?.until).toBeUndefined();
  });

  it('leaves two `visited` statements both active — closure would delete a true fact', async () => {
    // `visited` is in the known-bad fixture for this reason: it is
    // multi-valued and the single most common travel relation in the corpus.
    // Somebody who has been to Paris AND Tokyo has been to both.
    harness = await makeMemoryHarness();
    await harness.remember({ about: 'user', relation: 'visited', value: 'Paris', when: JAN });
    await harness.remember({ about: 'user', relation: 'visited', value: 'Tokyo', when: JUN });

    const active = await harness.recall({ limit: 10 });
    expect(active.statements.map((s) => s.value).sort()).toEqual(['Paris', 'Tokyo']);
    expect(active.statements.every((s) => s.until === undefined)).toBe(true);
  });

  it('does not let one slot close another — lives_in and works_at are separate chains', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({ about: 'user', relation: 'lives_in', value: 'Seattle', when: JAN });
    await harness.remember({ about: 'user', relation: 'works_at', value: 'Acme', when: JUN });

    const active = await harness.recall({ limit: 10 });
    expect(active.statements.map((s) => s.value).sort()).toEqual(['Acme', 'Seattle']);
  });

  it('does not let one PERSON close another person\'s lives_in', async () => {
    // Design §3.2's whole reason for the speaker rewrite, and this card is the
    // first time it has consequences: before slot derivation nothing closed
    // anything, so `about: 'user'` collapsing every person into one subject was
    // invisible. Now it would delete Bob's home the moment Alice mentions hers.
    harness = await makeMemoryHarness();
    await harness.remember(
      { about: 'user', relation: 'lives_in', value: 'Seattle', when: JAN },
      harness.ctx({ userId: ALICE }),
    );
    await harness.remember(
      { about: 'user', relation: 'lives_in', value: 'Austin', when: JUN },
      harness.ctx({ userId: BOB }),
    );

    // Read straight out of the engine, bypassing owner scoping: "Bob cannot
    // see it" and "the row was closed" are otherwise the same observation.
    const rows = await engineRecall(harness.bus, harness.ctx(), {
      limit: 10,
      activeOnly: false,
    });
    expect(rows.statements).toHaveLength(2);
    expect(rows.statements.every((r) => r.until === undefined)).toBe(true);
    expect(new Set(rows.statements.map((r) => r.about))).toEqual(
      new Set([`user:${ALICE}`, `user:${BOB}`]),
    );
  });

  it('does not raise the pending degraded flag — nothing here records a pending row', async () => {
    // A `degraded: ['pending']` would mean the store holds rows whose slot was
    // never derived. Derivation is synchronous and has no producer to be
    // unavailable, so that state is unreachable from this path.
    harness = await makeMemoryHarness();
    await harness.remember({ about: 'user', relation: 'lives_in', value: 'Seattle', when: JAN });
    await harness.remember({ about: 'user', relation: 'enjoys_hiking', value: 'yes', when: JAN });

    const out = await harness.recall({ limit: 10 });
    expect(out.degraded).not.toContain('pending');
  });
});
