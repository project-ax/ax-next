import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runDecisionsMigration, type DecisionsDatabase } from '../migrations.js';
import { createDecisionsStore, type DecisionStore } from '../store.js';
import { createFakeStore } from './fake-store.js';
import type { Decision } from '../types.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<DecisionsDatabase>[] = [];

function makeKysely(): Kysely<DecisionsDatabase> {
  const k = new Kysely<DecisionsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 4 }) }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('decisions_v1_decisions').ifExists().execute();
    } catch {
      /* */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

async function freshStore(): Promise<DecisionStore> {
  const db = makeKysely();
  await runDecisionsMigration(db);
  return createDecisionsStore(db);
}

const T0 = '2026-08-20T09:00:00.000Z';
const T_SOON = '2026-08-20T09:00:05.000Z';
const T_LATE = '2026-08-20T13:00:00.000Z';
const EXPIRES = '2026-08-22T09:00:00.000Z';

function base(over: Partial<Decision> = {}): Decision {
  return {
    id: 'dec_1',
    agentId: 'a1',
    ownerUserId: 'u1',
    conversationId: 'c1',
    kind: 'action',
    attendance: 'attended',
    status: 'pending',
    call: {
      id: 'call-1',
      name: 'request_capability',
      // Model-authored, stored verbatim. The round-trip test below is what
      // makes "the replay is byte-faithful" more than an intention.
      input: { reason: 'I need the Linear key', nested: { b: 2, a: [1, 2] } },
    },
    callFingerprint: 'fp-1',
    ruleId: 'skills.request-capability',
    // Captured at hold time. A reversible call replays as soon as it is
    // approved; an irreversible one waits out the undo window first.
    irreversible: false,
    freshness: null,
    summary: 'Wants to gain access to a new service or key',
    detail: 'It stopped before running request_capability.',
    preview: null,
    primaryLabel: 'Yes, go ahead',
    secondaryLabel: 'Show me the details',
    ghostLabel: "No — I'll handle it",
    approvedText: 'You said yes, so it may gain access to a new service or key.',
    dismissedText: 'You turned this down. Nothing ran.',
    createdAt: T0,
    expiresAt: EXPIRES,
    resolvedAt: null,
    staleReason: null,
    consumedAt: null,
    replayDueAt: null,
    replayClaimedAt: null,
    // Stamped when the HOST actually made the call — the other half of
    // `consumedAt`, which records the agent making it.
    replayedAt: null,
    replayError: null,
    ...over,
  };
}

describe('decisions store — round-trip', () => {
  it('round-trips a decision including the verbatim call', async () => {
    const s = await freshStore();
    const created = await s.create(base());
    const read = await s.get(created.id);
    expect(read).toEqual(base());
    // Byte-faithful, nested structure and array order intact.
    expect(read!.call.input).toEqual(base().call.input);
  });

  it('round-trips the nullable columns as null, not undefined', async () => {
    const s = await freshStore();
    await s.create(base());
    const read = await s.get('dec_1');
    expect(read!.freshness).toBeNull();
    expect(read!.preview).toBeNull();
    expect(read!.resolvedAt).toBeNull();
    expect(read!.staleReason).toBeNull();
    expect(read!.consumedAt).toBeNull();
  });

  it('round-trips a freshness predicate and a preview when they are set', async () => {
    const s = await freshStore();
    await s.create(
      base({
        freshness: { kind: 'thread-head', value: 'msg-8841', label: 'last message 8:41 AM' },
        preview: { meta: 'To: a@b.c', body: 'Friday works.' },
      }),
    );
    const read = await s.get('dec_1');
    expect(read!.freshness).toEqual({
      kind: 'thread-head',
      value: 'msg-8841',
      label: 'last message 8:41 AM',
    });
    expect(read!.preview).toEqual({ meta: 'To: a@b.c', body: 'Friday works.' });
  });

  it('hands back ISO strings, never Dates — a Date in a hook payload is a storage detail', async () => {
    const s = await freshStore();
    await s.create(base());
    const read = await s.get('dec_1');
    expect(typeof read!.createdAt).toBe('string');
    expect(typeof read!.expiresAt).toBe('string');
    expect(read!.createdAt).toBe(T0);
  });
});

describe('decisions store — scoping', () => {
  it('lists only open decisions for the owning user', async () => {
    const s = await freshStore();
    await s.create(base({ id: 'dec_open' }));
    await s.create(base({ id: 'dec_stale', status: 'stale' }));
    await s.create(base({ id: 'dec_done', status: 'dismissed' }));
    const open = await s.list({ ownerUserId: 'u1' });
    expect(open.map((d) => d.id).sort()).toEqual(['dec_open', 'dec_stale']);
  });

  it("never returns another user's decisions", async () => {
    const s = await freshStore();
    await s.create(base({ id: 'dec_mine', ownerUserId: 'u1' }));
    await s.create(base({ id: 'dec_theirs', ownerUserId: 'u2' }));

    expect((await s.list({ ownerUserId: 'u1' })).map((d) => d.id)).toEqual(['dec_mine']);
    // A direct get with the wrong owner is `null`, not the row.
    expect(await s.get('dec_theirs', 'u1')).toBeNull();
    expect((await s.get('dec_theirs', 'u2'))!.id).toBe('dec_theirs');
  });

  it('filters by agent and by exact status when asked', async () => {
    const s = await freshStore();
    await s.create(base({ id: 'dec_a1' }));
    await s.create(base({ id: 'dec_a2', agentId: 'a2' }));
    await s.create(base({ id: 'dec_a1_done', status: 'executed' }));

    expect((await s.list({ ownerUserId: 'u1', agentId: 'a1' })).map((d) => d.id)).toEqual([
      'dec_a1',
    ]);
    expect(
      (await s.list({ ownerUserId: 'u1', status: 'executed' })).map((d) => d.id),
    ).toEqual(['dec_a1_done']);
  });
});

describe('decisions store — the standing authorisation', () => {
  it('refuses a second unconsumed approval for the same (agent, fingerprint)', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    await s.create(base({ id: 'dec_2' }));
    // The partial unique index is the guarantee: two approvals of the same
    // call shape cannot both leave an authorisation standing.
    await expect(s.claimForApproval('dec_2', { nowIso: T_SOON, status: 'executed' })).rejects.toThrow();
  });

  it('allows a new approval once the first is consumed', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    expect((await s.takeApproval('a1', 'fp-1', T_SOON))!.id).toBe('dec_1');

    await s.create(base({ id: 'dec_2' }));
    const second = await s.claimForApproval('dec_2', { nowIso: T_LATE, status: 'executed' });
    expect(second!.status).toBe('executed');
  });

  it('scopes the authorisation to the agent — another agent gets nothing', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    expect(await s.takeApproval('a2', 'fp-1', T_SOON)).toBeNull();
  });

  it('takeApproval is one-shot', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    expect(await s.takeApproval('a1', 'fp-1', T_SOON)).not.toBeNull();
    expect(await s.takeApproval('a1', 'fp-1', T_SOON)).toBeNull();
  });

  it('never hands an authorisation to a decision that was not approved', async () => {
    const s = await freshStore();
    await s.create(base());
    expect(await s.takeApproval('a1', 'fp-1', T_SOON)).toBeNull();
    await s.markDismissed('dec_1', T_SOON);
    expect(await s.takeApproval('a1', 'fp-1', T_SOON)).toBeNull();
  });

  it('exactly one of two concurrent takeApproval calls wins', async () => {
    // Not theoretical: an attended agent retrying its tool call and (from
    // AW-5) a host replay race here.
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });

    const [a, b] = await Promise.all([
      s.takeApproval('a1', 'fp-1', T_SOON),
      s.takeApproval('a1', 'fp-1', T_SOON),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
  });

  it('exactly one of many concurrent takeApproval calls wins', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => s.takeApproval('a1', 'fp-1', T_SOON)),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe('decisions store — transitions are conditional', () => {
  it('approving twice transitions once', async () => {
    const s = await freshStore();
    await s.create(base());
    expect((await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' }))!.status).toBe('executed');
    // Second call finds nothing open to change.
    expect(await s.claimForApproval('dec_1', { nowIso: T_LATE, status: 'executed' })).toBeNull();
    expect((await s.get('dec_1'))!.resolvedAt).toBe(T_SOON);
  });

  it('cannot dismiss something already approved', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    expect(await s.markDismissed('dec_1', T_LATE)).toBeNull();
  });

  it('markStale re-opens without resolving — no undo window on a non-event', async () => {
    const s = await freshStore();
    await s.create(base({ freshness: { kind: 'thread-head', value: 'old', label: 'l' } }));
    const staled = await s.markStale('dec_1', {
      staleReason: 'Priya replied again',
      freshness: { kind: 'thread-head', value: 'new', label: 'l' },
    });
    expect(staled!.status).toBe('stale');
    expect(staled!.resolvedAt).toBeNull();
    expect(staled!.freshness!.value).toBe('new');
    // Still open, so it is still approvable.
    expect((await s.claimForApproval('dec_1', { nowIso: T_LATE, status: 'executed' }))!.status).toBe('executed');
  });

  it('claimForApproval clears a stale reason that is no longer true', async () => {
    const s = await freshStore();
    await s.create(base({ status: 'stale', staleReason: 'the world moved' }));
    expect((await s.claimForApproval('dec_1', { nowIso: T_LATE, status: 'executed' }))!.staleReason).toBeNull();
  });
});

describe('decisions store — undo', () => {
  it('restores an approved decision to pending, dropping the authorisation', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    const restored = await s.restore('dec_1');
    expect(restored!.status).toBe('pending');
    expect(restored!.resolvedAt).toBeNull();
    // The standing authorisation is gone with it.
    expect(await s.takeApproval('a1', 'fp-1', T_LATE)).toBeNull();
  });

  it('refuses to restore an authorisation that has already been consumed', async () => {
    // That bell cannot be un-rung: re-approving would authorise a SECOND
    // execution of a call that already ran.
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    await s.takeApproval('a1', 'fp-1', T_SOON);
    expect(await s.restore('dec_1')).toBeNull();
  });

  it('refuses to restore something that was never resolved', async () => {
    const s = await freshStore();
    await s.create(base());
    expect(await s.restore('dec_1')).toBeNull();
  });
});

describe('decisions store — expiry', () => {
  it('expire() moves every open decision past its expiry and touches nothing else', async () => {
    const s = await freshStore();
    await s.create(base({ id: 'dec_due', expiresAt: T0 }));
    await s.create(base({ id: 'dec_due_stale', status: 'stale', expiresAt: T0 }));
    await s.create(base({ id: 'dec_fresh', expiresAt: '2027-01-01T00:00:00.000Z' }));
    await s.create(base({ id: 'dec_done', status: 'dismissed', expiresAt: T0 }));

    expect(await s.expireDue(T_LATE)).toBe(2);
    expect((await s.get('dec_due'))!.status).toBe('expired');
    expect((await s.get('dec_due_stale'))!.status).toBe('expired');
    expect((await s.get('dec_fresh'))!.status).toBe('pending');
    // A finished decision keeps its outcome; expiry is not a rewrite of history.
    expect((await s.get('dec_done'))!.status).toBe('dismissed');
  });

  it('is idempotent — a second sweep moves nothing', async () => {
    const s = await freshStore();
    await s.create(base({ expiresAt: T0 }));
    expect(await s.expireDue(T_LATE)).toBe(1);
    expect(await s.expireDue(T_LATE)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AW-5. Claiming, deferred replays, failure — everything the approve path
// leans on to make "approving twice does it once" true across two tabs.
// ---------------------------------------------------------------------------

/** T_SOON + the undo window: when a deferred replay comes due. */
const T_REPLAY_DUE = '2026-08-20T09:00:15.000Z';
/** Inside the window — the replay is not due yet. */
const T_REPLAY_EARLY = '2026-08-20T09:00:10.000Z';

describe('decisions store — claimForApproval', () => {
  it('is one-shot: the second claim returns null because SOMEONE ELSE RESOLVED IT', async () => {
    const s = await freshStore();
    await s.create(base());

    const first = await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    expect(first!.status).toBe('executed');

    // Null here does NOT mean "no such row" — the row is right there, and a
    // caller that reports "decision not found" is lying about state we have.
    // It means the conditional UPDATE matched nothing because the row is no
    // longer open: another tab, a retried POST, a concurrent replica got it.
    expect(
      await s.claimForApproval('dec_1', { nowIso: T_LATE, status: 'executed' }),
    ).toBeNull();
    expect((await s.get('dec_1'))!.status).toBe('executed');
    expect((await s.get('dec_1'))!.resolvedAt).toBe(T_SOON);
  });

  it('refuses to leave two authorising rows standing for the same (agent, call)', async () => {
    // The partial unique index covers BOTH authorising statuses since AW-5.
    // `executed` and `approved-pending-agent` are equally a standing "yes" at
    // the pre-call gate, so they cannot coexist unconsumed for one call shape
    // — otherwise one call would carry two authorisations and run twice.
    const s = await freshStore();
    await s.create(base());
    await s.create(base({ id: 'dec_2' }));

    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    await expect(
      s.claimForApproval('dec_2', { nowIso: T_SOON, status: 'approved-pending-agent' }),
    ).rejects.toThrow();
  });

  it('round-trips a deferred replay and clears it on re-claim after an undo', async () => {
    const s = await freshStore();
    await s.create(base({ irreversible: true }));
    const claimed = await s.claimForApproval('dec_1', {
      nowIso: T_SOON,
      status: 'executed',
      replayDueAt: T_REPLAY_DUE,
    });
    expect(claimed!.replayDueAt).toBe(T_REPLAY_DUE);

    // Undo, then approve again without a deferral: the stale due-time must not
    // survive, or the sweep would replay a call the second approval already ran.
    await s.restore('dec_1');
    const again = await s.claimForApproval('dec_1', { nowIso: T_LATE, status: 'executed' });
    expect(again!.replayDueAt).toBeNull();
  });
});

describe('decisions store — the authorisation the agent takes up', () => {
  it("takeApproval honours 'approved-pending-agent' — that is the whole point of the status", async () => {
    // The host could not replay this one (sandbox-only tool). The approval is
    // real and waits at the gate for the agent's next run; refusing it here
    // would make the status a dead end and its receipt a lie.
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'approved-pending-agent' });

    const taken = await s.takeApproval('a1', 'fp-1', T_LATE);
    expect(taken!.id).toBe('dec_1');
    expect(taken!.status).toBe('approved-pending-agent');
    // Still one-shot.
    expect(await s.takeApproval('a1', 'fp-1', T_LATE)).toBeNull();
  });

  it('takeApproval REFUSES a row whose deferred replay has not run yet', async () => {
    // The host still intends to run this call. Letting the agent consume the
    // authorisation underneath it is exactly how one approval becomes two sends.
    const s = await freshStore();
    await s.create(base({ irreversible: true }));
    await s.claimForApproval('dec_1', {
      nowIso: T_SOON,
      status: 'executed',
      replayDueAt: T_REPLAY_DUE,
    });

    expect(await s.takeApproval('a1', 'fp-1', T_REPLAY_EARLY)).toBeNull();

    // …and it stays refused once the sweep has TAKEN the replay. The claim
    // clears `replay_due_at`, so an earlier version of this predicate re-opened
    // the row to the agent for exactly as long as the call was in flight — one
    // approval, two sends. `replay_claimed_at` is what holds the door shut
    // across that window.
    const claimed = await s.claimDueReplays(T_LATE, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.replayDueAt).toBeNull();
    expect(claimed[0]!.replayClaimedAt).toBe(T_LATE);
    expect(await s.takeApproval('a1', 'fp-1', T_LATE)).toBeNull();

    // And it is still refused after the call has actually gone out.
    await s.markReplayed('dec_1', T_LATE);
    expect(await s.takeApproval('a1', 'fp-1', T_LATE)).toBeNull();
  });

  it('takeApproval REFUSES a row whose IMMEDIATE replay is in flight', async () => {
    // The reversible path claims and replays in one breath, but "one breath"
    // is still milliseconds of network. A byte-identical agent call landing in
    // that window must not be able to spend the same yes.
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', {
      nowIso: T_SOON,
      status: 'executed',
      replayClaimedAt: T_SOON,
    });

    expect(await s.takeApproval('a1', 'fp-1', T_SOON)).toBeNull();
    // Undo is refused in that window too: the call is already on its way out.
    expect(await s.restore('dec_1')).toBeNull();
  });

  it('takeApproval HONOURS an attended approval, which the host never replays', async () => {
    // The counter-control: without it the two tests above could pass simply
    // because `takeApproval` had stopped working.
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    expect((await s.takeApproval('a1', 'fp-1', T_SOON))!.id).toBe('dec_1');
  });
});

/**
 * TASK-277's fallback takes the flight AFTER the row was already claimed,
 * because the attended path claims expecting the warm agent to make the call
 * and only then finds out the delivery failed. That makes this the fourth guard
 * over the same three columns, and the one most likely to drift from the other
 * three — so its predicates get pinned here rather than only through the canary.
 */
describe('decisions store — claimReplayFlight', () => {
  /** The real store and the fake, asked the identical question. */
  async function bothStores(over: Partial<Decision> = {}): Promise<DecisionStore[]> {
    const real = await freshStore();
    const fake = createFakeStore();
    for (const s of [real, fake]) {
      await s.create(base());
      // The attended claim: `executed`, and deliberately NO flight — the host
      // did not know it would be the one calling.
      await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
      if (Object.keys(over).length > 0) {
        // The one column each case is about, set the way the real path sets it.
        if (over.consumedAt !== undefined) await s.takeApproval('a1', 'fp-1', T_SOON);
        if (over.replayedAt !== undefined) await s.markReplayed('dec_1', T_SOON);
      }
    }
    return [real, fake];
  }

  it('takes the flight on an attended-claimed row nothing has touched', async () => {
    // The counter-control. Without it every refusal below could pass simply
    // because the method had stopped working.
    for (const s of await bothStores()) {
      const taken = await s.claimReplayFlight('dec_1', T_SOON);
      expect(taken).not.toBeNull();
      expect(taken!.replayClaimedAt).toBe(T_SOON);
      // And the row is now closed to undo and to the agent, which is the whole
      // reason the flight is taken before the call rather than after it.
      expect(await s.restore('dec_1')).toBeNull();
      expect(await s.takeApproval('a1', 'fp-1', T_SOON)).toBeNull();
    }
  });

  it('REFUSES a row the agent has already consumed', async () => {
    // The window between the claim and this write: the row is `executed` with
    // every marker null, and `takeApproval` needs only `replay_claimed_at IS
    // NULL` to spend it. A byte-identical agent call landing there consumes the
    // yes — and a flight taken on top would send the same call a SECOND time.
    for (const s of await bothStores({ consumedAt: T_SOON })) {
      expect((await s.get('dec_1'))!.consumedAt).not.toBeNull();
      expect(await s.claimReplayFlight('dec_1', T_LATE)).toBeNull();
      // Refusing left the row alone: no half-written flight on a consumed row.
      expect((await s.get('dec_1'))!.replayClaimedAt).toBeNull();
    }
  });

  it('REFUSES a row the host has already replayed', async () => {
    for (const s of await bothStores({ replayedAt: T_SOON })) {
      expect(await s.claimReplayFlight('dec_1', T_LATE)).toBeNull();
    }
  });

  it('REFUSES a row an undo re-opened, and a row already parked for the agent', async () => {
    // The two statuses the fallback can find underneath it. `pending` is undo
    // winning the race; `approved-pending-agent` is a row that is the AGENT's
    // to perform — a flight stamped there would never be cleared, and
    // `takeApproval` would refuse the agent forever.
    for (const s of [await freshStore(), createFakeStore()]) {
      await s.create(base());
      await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
      await s.restore('dec_1');
      expect((await s.get('dec_1'))!.status).toBe('pending');
      expect(await s.claimReplayFlight('dec_1', T_LATE)).toBeNull();

      await s.claimForApproval('dec_1', { nowIso: T_LATE, status: 'approved-pending-agent' });
      expect(await s.claimReplayFlight('dec_1', T_LATE)).toBeNull();
    }
  });

  it('is one-shot — a second flight on the same row returns null', async () => {
    for (const s of await bothStores()) {
      expect(await s.claimReplayFlight('dec_1', T_SOON)).not.toBeNull();
      expect(await s.claimReplayFlight('dec_1', T_LATE)).toBeNull();
    }
  });
});

describe('decisions store — deferred replays', () => {
  it('claims a due replay exactly once', async () => {
    const s = await freshStore();
    await s.create(base({ irreversible: true }));
    await s.claimForApproval('dec_1', {
      nowIso: T_SOON,
      status: 'executed',
      replayDueAt: T_REPLAY_DUE,
    });

    const first = await s.claimDueReplays(T_LATE, 10);
    expect(first.map((d) => d.id)).toEqual(['dec_1']);
    // The claim cleared `replay_due_at` in the same statement, so a second
    // sweep — in this process or another replica — gets nothing rather than
    // sending twice.
    expect(await s.claimDueReplays(T_LATE, 10)).toEqual([]);
    expect((await s.get('dec_1'))!.replayDueAt).toBeNull();
  });

  it('leaves a replay whose undo window has not closed alone', async () => {
    const s = await freshStore();
    await s.create(base({ irreversible: true }));
    await s.claimForApproval('dec_1', {
      nowIso: T_SOON,
      status: 'executed',
      replayDueAt: T_REPLAY_DUE,
    });
    expect(await s.claimDueReplays(T_REPLAY_EARLY, 10)).toEqual([]);
    expect((await s.get('dec_1'))!.replayDueAt).toBe(T_REPLAY_DUE);
  });

  it('honours the batch limit and leaves the rest for the next pass', async () => {
    const s = await freshStore();
    // Distinct fingerprints: three unconsumed authorisations for ONE call
    // shape is precisely what the unique index forbids.
    for (const n of [1, 2, 3]) {
      await s.create(base({ id: `dec_${n}`, callFingerprint: `fp-${n}`, irreversible: true }));
      await s.claimForApproval(`dec_${n}`, {
        nowIso: T_SOON,
        status: 'executed',
        replayDueAt: T_REPLAY_DUE,
      });
    }

    expect(await s.claimDueReplays(T_LATE, 2)).toHaveLength(2);
    expect(await s.claimDueReplays(T_LATE, 2)).toHaveLength(1);
    expect(await s.claimDueReplays(T_LATE, 2)).toEqual([]);
  });
});

describe('decisions store — a replay that failed', () => {
  it('markFailed records the error and DROPS the standing authorisation', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });

    const failed = await s.markFailed('dec_1', { error: 'upstream 503' });
    expect(failed!.status).toBe('failed');
    expect(failed!.replayError).toBe('upstream 503');
    expect(failed!.replayDueAt).toBeNull();

    // An action that did not happen must not leave behind a yes the agent can
    // quietly cash in later: the partial index does not cover `failed`, and
    // neither does `takeApproval`.
    expect(await s.takeApproval('a1', 'fp-1', T_LATE)).toBeNull();
  });

  it('parkForAgent moves an executed claim to the agent without touching the yes', async () => {
    // The executor went away between the approval and the deferred replay.
    const s = await freshStore();
    await s.create(base({ irreversible: true }));
    await s.claimForApproval('dec_1', {
      nowIso: T_SOON,
      status: 'executed',
      replayDueAt: T_REPLAY_DUE,
    });

    const parked = await s.parkForAgent('dec_1');
    expect(parked!.status).toBe('approved-pending-agent');
    expect(parked!.replayDueAt).toBeNull();
    expect((await s.takeApproval('a1', 'fp-1', T_LATE))!.id).toBe('dec_1');
  });
});

describe('decisions store — undo, with a replay pending', () => {
  it('cancels a deferred replay outright', async () => {
    // This is the entire reason an irreversible call waits: an undo inside the
    // window has to STOP the outward action, not apologise for it afterwards.
    const s = await freshStore();
    await s.create(base({ irreversible: true }));
    await s.claimForApproval('dec_1', {
      nowIso: T_SOON,
      status: 'executed',
      replayDueAt: T_REPLAY_DUE,
    });

    const restored = await s.restore('dec_1');
    expect(restored!.status).toBe('pending');
    expect(restored!.replayDueAt).toBeNull();
    // And the sweep finds nothing to run.
    expect(await s.claimDueReplays(T_LATE, 10)).toEqual([]);
  });

  it("restores an 'approved-pending-agent' row too", async () => {
    // A host that physically cannot replay still parked a real "yes", and a
    // human who said yes by mistake needs the same undo as any other approval.
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'approved-pending-agent' });

    const restored = await s.restore('dec_1');
    expect(restored!.status).toBe('pending');
    expect(restored!.resolvedAt).toBeNull();
    expect(await s.takeApproval('a1', 'fp-1', T_LATE)).toBeNull();
  });
});

describe('decisions store — the AW-5 columns', () => {
  it('round-trips irreversible, replayDueAt and replayError through create/get', async () => {
    const s = await freshStore();
    const written = base({
      irreversible: true,
      replayDueAt: T_REPLAY_DUE,
      replayError: 'upstream 503',
    });
    await s.create(written);

    const read = await s.get('dec_1');
    expect(read).toEqual(written);
    // Spelled out: a boolean that round-trips as a string, or as `undefined`
    // for a row written before the column existed, would defer nothing.
    expect(read!.irreversible).toBe(true);
    expect(read!.replayDueAt).toBe(T_REPLAY_DUE);
    expect(read!.replayError).toBe('upstream 503');
  });

  it('defaults an untouched decision to reversible with nothing pending', async () => {
    const s = await freshStore();
    await s.create(base());
    const read = await s.get('dec_1');
    expect(read!.irreversible).toBe(false);
    expect(read!.replayDueAt).toBeNull();
    expect(read!.replayError).toBeNull();
  });
});

describe('decisions store — expiry does not rewrite history', () => {
  it('leaves an already-resolved decision alone', async () => {
    const s = await freshStore();
    await s.create(base({ id: 'dec_approved', expiresAt: T0 }));
    await s.create(base({ id: 'dec_parked', callFingerprint: 'fp-2', expiresAt: T0 }));
    await s.claimForApproval('dec_approved', { nowIso: T_SOON, status: 'executed' });
    await s.claimForApproval('dec_parked', {
      nowIso: T_SOON,
      status: 'approved-pending-agent',
    });

    // Both are long past their expiry, and neither is open any more.
    expect(await s.expireDue(T_LATE)).toBe(0);
    expect((await s.get('dec_approved'))!.status).toBe('executed');
    expect((await s.get('dec_parked'))!.status).toBe('approved-pending-agent');
    // And the standing authorisation survived the sweep.
    expect((await s.takeApproval('a1', 'fp-2', T_LATE))!.id).toBe('dec_parked');
  });
});

describe('decisions store — a replay that actually ran', () => {
  it('markReplayed stamps the column, keeps the status, and consumes nothing', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });

    const replayed = await s.markReplayed('dec_1', T_SOON);
    // `executed` is still the true statement about this row — the host ran it.
    expect(replayed!.status).toBe('executed');
    expect(replayed!.replayedAt).toBe(T_SOON);
    expect(replayed!.replayDueAt).toBeNull();
    expect(replayed!.replayError).toBeNull();
    // The consume belongs to the AGENT's side of the authorisation. Replay is
    // the execution, so there was never an agent retry to consume.
    expect(replayed!.consumedAt).toBeNull();
  });

  it('leaves nothing for the agent to cash in', async () => {
    // Without `replayed_at`, an agent making the identical call on its next
    // run would sail through the gate on a yes the host already spent.
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    await s.markReplayed('dec_1', T_SOON);

    expect(await s.takeApproval('a1', 'fp-1', T_LATE)).toBeNull();
  });

  it('refuses the undo — the host already made the call', async () => {
    // Undo cannot un-send an email. Putting the row back on the queue would
    // let a second approval do the whole thing AGAIN.
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    await s.markReplayed('dec_1', T_SOON);

    expect(await s.restore('dec_1')).toBeNull();
    expect((await s.get('dec_1'))!.status).toBe('executed');
  });

  it('frees the index slot so the same call can be held and approved again', async () => {
    // The regression this column exists to prevent: a replayed row is HISTORY,
    // not a standing authorisation. If it kept occupying the partial unique
    // index, the next hold of the same call could never be approved — the
    // second claim would die on a unique violation and the human would be
    // stuck looking at a button that always errors.
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    await s.markReplayed('dec_1', T_SOON);

    await s.create(base({ id: 'dec_2' }));
    const second = await s.claimForApproval('dec_2', { nowIso: T_LATE, status: 'executed' });
    expect(second!.status).toBe('executed');
    expect(second!.replayedAt).toBeNull();
  });

  it('round-trips replayedAt through create/get', async () => {
    const s = await freshStore();
    await s.create(base({ replayedAt: T_SOON }));
    expect((await s.get('dec_1'))!.replayedAt).toBe(T_SOON);
  });

  it('stamps even when an undo won the race, and keeps the ORIGINAL resolution instant', async () => {
    // `markReplayed` is the one write in this file that is NOT conditional on
    // status. An undo landing between the executor returning and this stamp
    // would otherwise silently no-op, leaving a `pending` row behind a receipt
    // that says the call went out. The send happened; the row agrees.
    //
    // `resolved_at` must stay the APPROVAL instant, not the replay instant —
    // overwriting it would restart the 10-second undo window after the outward
    // action, which is the one thing the deferral exists to prevent.
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' });
    const undone = await s.restore('dec_1');
    expect(undone!.status).toBe('pending');

    const replayed = await s.markReplayed('dec_1', T_LATE);
    expect(replayed!.status).toBe('executed');
    expect(replayed!.replayedAt).toBe(T_LATE);
    // `restore` cleared it, so this row's first resolution instant is the replay.
    expect(replayed!.resolvedAt).toBe(T_LATE);
    // And it is now beyond undo either way.
    expect(await s.restore('dec_1')).toBeNull();
  });

  it('does not move the resolution instant of a deferred replay', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.claimForApproval('dec_1', {
      nowIso: T_SOON,
      status: 'executed',
      replayDueAt: T_LATE,
    });
    const replayed = await s.markReplayed('dec_1', T_LATE);
    // Approved at T_SOON, sent at T_LATE. The undo window ran from T_SOON.
    expect(replayed!.resolvedAt).toBe(T_SOON);
    expect(replayed!.replayedAt).toBe(T_LATE);
  });

  it('returns null only when the row is gone', async () => {
    const s = await freshStore();
    expect(await s.markReplayed('dec_nope', T_SOON)).toBeNull();
  });

  it('parking a claimed flight hands the authorisation back to the agent', async () => {
    // `parkForAgent` is only ever reached from INSIDE the replay, i.e. on a row
    // the host had already claimed — its executor went away between the
    // approval and the send. Earlier tests parked a row with no in-flight
    // marker, a precondition that never occurs in production, and so missed
    // this: leaving `replay_claimed_at` set parks a decision the agent is then
    // forbidden to pick up, and the call runs ZERO times. Silent inaction is
    // still the failure this package exists to prevent.
    const s = await freshStore();
    await s.create(base({ irreversible: true }));
    await s.claimForApproval('dec_1', {
      nowIso: T_SOON,
      status: 'executed',
      replayDueAt: T_REPLAY_DUE,
    });
    const claimed = await s.claimDueReplays(T_LATE, 10);
    expect(claimed[0]!.replayClaimedAt).toBe(T_LATE);

    const parked = await s.parkForAgent('dec_1');
    expect(parked!.status).toBe('approved-pending-agent');
    expect(parked!.replayClaimedAt).toBeNull();
    expect(parked!.replayedAt).toBeNull();

    // The whole point of the status: the agent performs it on its next run.
    expect((await s.takeApproval('a1', 'fp-1', T_LATE))!.id).toBe('dec_1');
  });
});
