import { describe, it, expect, afterEach } from 'vitest';
import { ownerlessIdFor } from '@ax/core';

import { rewriteSpeaker, SPEAKER_SUBJECT } from '../subject.js';
import { ALICE, BOB, DEFAULT_AGENT, engineRecall, makeMemoryHarness, type MemoryHarness } from './harness.js';

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

// ---------------------------------------------------------------------------
// Speaker rewrite — design §3.2
// ---------------------------------------------------------------------------

describe('rewriteSpeaker', () => {
  it('rewrites the bare speaker subject to the per-person one', () => {
    expect(rewriteSpeaker(SPEAKER_SUBJECT, 'u1')).toBe('user:u1');
  });

  it.each([
    'user:u1',
    'User',
    ' user',
    'user ',
    'users',
    'user_research',
    'acme_corp',
    '',
  ])('leaves %j alone — only the exact literal is rewritten', (about) => {
    expect(rewriteSpeaker(about, 'u1')).toBe(about);
  });
});

describe('@ax/memory — speaker rewrite and the ownership stamp', () => {
  it('records `about: user` as `about: user:<ctx.userId>`', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({
      about: 'user',
      relation: 'lives_in',
      value: 'Berlin',
      when: '2026-01-01T00:00:00Z',
    });

    // Read it back through the ENGINE, unfiltered, so the assertion is about
    // what was stored and not about what recall chooses to show.
    const { statements } = await engineRecall(harness.bus, harness.ctx(), { limit: 10 });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ about: `user:${ALICE}` });
  });

  it('applies the SAME rewrite on the read side, so a write is findable', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({ about: 'user', relation: 'lives_in', value: 'Berlin' });

    // The caller says `user`; the store holds `user:<id>`. If the rewrite ran
    // on only one side this would be empty, which is the bug that makes the
    // whole speaker rewrite worse than not having it.
    const { statements } = await harness.recall({ about: 'user' });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.about).toBe(`user:${ALICE}`);
  });

  it('gives two people on ONE agent two different speaker subjects', async () => {
    harness = await makeMemoryHarness();
    await harness.remember(
      { about: 'user', relation: 'lives_in', value: 'Berlin' },
      harness.ctx({ userId: ALICE }),
    );
    await harness.remember(
      { about: 'user', relation: 'lives_in', value: 'Lisbon' },
      harness.ctx({ userId: BOB }),
    );

    // The point of §3.2: without the rewrite these are one subject, one slot
    // chain, and Bob's arrival CLOSES Alice's `lives_in`.
    const all = await engineRecall(harness.bus, harness.ctx(), { limit: 10 });
    expect(all.statements).toHaveLength(2);
    expect(all.statements.every((s) => (s as { until?: string }).until === undefined)).toBe(true);
  });

  it('records a ROUTINE turn under the routine owner\'s real userId', async () => {
    harness = await makeMemoryHarness();
    // A routine fire mints its ctx with `source: 'routine'` and the routine
    // OWNER's real userId — there is no live person, and no synthetic actor
    // is invented for one either. `@ax/memory` must not branch on `source`.
    const routineCtx = harness.ctx({
      userId: BOB,
      source: 'routine',
      sessionId: 'routine-agent-1-morning-pass',
    });
    const { id } = await harness.remember(
      { about: 'user', relation: 'lives_in', value: 'Lisbon' },
      routineCtx,
    );

    const { statements } = await engineRecall(harness.bus, harness.ctx(), { limit: 10 });
    expect(statements.map((s) => s.id)).toEqual([id]);
    // Stored under BOB, and reachable by BOB — which is the whole test: a
    // synthetic owner would store it somewhere nobody can read.
    expect((await harness.recall({}, harness.ctx({ userId: BOB }))).statements).toHaveLength(1);
    expect((await harness.recall({}, harness.ctx({ userId: ALICE }))).statements).toEqual([]);
  });

  it('REFUSES an owner-less session rather than minting a private partition', async () => {
    harness = await makeMemoryHarness();
    const ownerless = harness.ctx({ userId: ownerlessIdFor('session-1') });
    // `ownerless:session-1` is a perfectly good non-empty string that simply
    // isn't anybody's, so a null check does not catch it. Memory joins the
    // REFUSE side (workspace-git-core, workspace-git-server, skill.propose,
    // connector_propose) rather than the merely-partition side.
    await expect(
      harness.remember({ about: 'user', relation: 'lives_in', value: 'Berlin' }, ownerless),
    ).rejects.toThrow(/no owner/);
    await expect(harness.recall({}, ownerless)).rejects.toThrow(/no owner/);
    await expect(harness.forget({ ids: ['x'] }, ownerless)).rejects.toThrow(/no owner/);
  });

  it('REFUSES a context with no usable userId rather than substituting one', async () => {
    harness = await makeMemoryHarness();
    const blank = { ...harness.ctx(), userId: '   ' };
    await expect(
      harness.remember({ about: 'user', relation: 'lives_in', value: 'Berlin' }, blank),
    ).rejects.toThrow(/ctx.userId is required/);
  });
});

// ---------------------------------------------------------------------------
// Tenancy — design §6.1
// ---------------------------------------------------------------------------

describe('@ax/memory — reads are owner-scoped by default', () => {
  it("a second owner's rows are invisible", async () => {
    harness = await makeMemoryHarness();
    await harness.remember(
      { about: 'acme_corp', relation: 'stage', value: 'series B' },
      harness.ctx({ userId: ALICE }),
    );

    const bobSees = await harness.recall({ about: 'acme_corp' }, harness.ctx({ userId: BOB }));
    expect(bobSees.statements).toEqual([]);

    // ...and it is genuinely still there, which is what makes this an
    // ISOLATION test rather than a "nothing was stored" test.
    const aliceSees = await harness.recall({ about: 'acme_corp' }, harness.ctx({ userId: ALICE }));
    expect(aliceSees.statements).toHaveLength(1);
  });

  it('scopes the ranked-retrieval path too, not just the listing', async () => {
    harness = await makeMemoryHarness();
    await harness.remember(
      { about: 'acme_corp', relation: 'headquartered_in', value: 'Berlin' },
      harness.ctx({ userId: ALICE }),
    );
    // The `query` path runs through fusion channels rather than the filtered
    // listing, so it is a different SQL path and a separate hole.
    const bobSees = await harness.recall({ query: 'Berlin' }, harness.ctx({ userId: BOB }));
    expect(bobSees.statements).toEqual([]);
    const aliceSees = await harness.recall({ query: 'Berlin' }, harness.ctx({ userId: ALICE }));
    expect(aliceSees.statements.map((s) => s.value)).toEqual(['Berlin']);
  });

  it('still separates two AGENTS for one owner (tenant scope survives)', async () => {
    harness = await makeMemoryHarness();
    await harness.remember(
      { about: 'acme_corp', relation: 'stage', value: 'series B' },
      harness.ctx({ agentId: 'agent-A', userId: ALICE }),
    );
    const other = await harness.recall({}, harness.ctx({ agentId: 'agent-B', userId: ALICE }));
    expect(other.statements).toEqual([]);
  });
});

describe('@ax/memory — memory:forget refuses a foreign id', () => {
  it("does not retract another OWNER's statement", async () => {
    harness = await makeMemoryHarness();
    const { id } = await harness.remember(
      { about: 'acme_corp', relation: 'stage', value: 'series B' },
      harness.ctx({ userId: ALICE }),
    );

    // Returns `{}` and takes no effect. Refusal is enforcement, not a signal:
    // reporting which ids were refused would hand a caller an existence
    // oracle over other people's statements, and an honest caller can never
    // hold a foreign id because recall is owner-scoped.
    await expect(harness.forget({ ids: [id] }, harness.ctx({ userId: BOB }))).resolves.toEqual({});

    const aliceSees = await harness.recall({ about: 'acme_corp' }, harness.ctx({ userId: ALICE }));
    expect(aliceSees.statements.map((s) => s.id)).toEqual([id]);
    expect(aliceSees.statements[0]!.until).toBeUndefined();
  });

  it("does not retract another TENANT's statement", async () => {
    harness = await makeMemoryHarness();
    const { id } = await harness.remember(
      { about: 'acme_corp', relation: 'stage', value: 'series B' },
      harness.ctx({ agentId: 'agent-A', userId: ALICE }),
    );

    await expect(
      harness.forget({ ids: [id] }, harness.ctx({ agentId: 'agent-B', userId: ALICE })),
    ).resolves.toEqual({});

    const still = await harness.recall({ about: 'acme_corp' }, harness.ctx({ agentId: 'agent-A', userId: ALICE }));
    expect(still.statements.map((s) => s.id)).toEqual([id]);
    expect(still.statements[0]!.until).toBeUndefined();
  });

  it('a mixed batch retracts only the ids this owner owns', async () => {
    harness = await makeMemoryHarness();
    const mine = await harness.remember(
      { about: 'acme_corp', relation: 'stage', value: 'series B' },
      harness.ctx({ userId: BOB }),
    );
    const theirs = await harness.remember(
      { about: 'acme_corp', relation: 'stage', value: 'seed' },
      harness.ctx({ userId: ALICE }),
    );

    await harness.forget({ ids: [mine.id, theirs.id] }, harness.ctx({ userId: BOB }));

    expect((await harness.recall({}, harness.ctx({ userId: BOB }))).statements).toEqual([]);
    expect(
      (await harness.recall({}, harness.ctx({ userId: ALICE }))).statements.map((s) => s.id),
    ).toEqual([theirs.id]);
  });
});

describe('@ax/memory — the tenant is ambient', () => {
  it('ignores an agentId a caller tries to smuggle in a payload', async () => {
    harness = await makeMemoryHarness();
    await harness.remember(
      { about: 'acme_corp', relation: 'stage', value: 'series B' },
      harness.ctx({ agentId: DEFAULT_AGENT, userId: ALICE }),
    );

    const smuggled = { about: 'acme_corp', agentId: DEFAULT_AGENT } as unknown as {
      about: string;
    };
    const seen = await harness.recall(smuggled, harness.ctx({ agentId: 'agent-other', userId: ALICE }));
    expect(seen.statements).toEqual([]);
  });
});
