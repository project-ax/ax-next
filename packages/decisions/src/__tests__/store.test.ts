import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runDecisionsMigration, type DecisionsDatabase } from '../migrations.js';
import {
  createDecisionsStore,
  DuplicateAuthorisationError,
  type DecisionStore,
} from '../store.js';
import { receiptFor } from '../receipts.js';
import { createFakeStore } from './fake-store.js';
import { DecisionStatusSchema, type Decision, type DecisionStatus } from '../types.js';

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
    replayAbandonedAt: null,
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
    //
    // And it refuses with a TYPED error, not just any error. `decisions:approve`
    // reports this refusal to a person as a sentence and every other write
    // failure to an operator as a fault, so the two have to be distinguishable
    // at the seam rather than guessed at from a driver code the caller sniffs.
    await expect(
      s.claimForApproval('dec_2', { nowIso: T_SOON, status: 'executed' }),
    ).rejects.toThrow(DuplicateAuthorisationError);
  });

  it('lets a NON-unique write failure through as itself', async () => {
    // The other half, and the one that matters more. A deadlock, a lock
    // timeout or a statement timeout under load is a fault; translating it
    // into "already approved" is what stops a person retrying.
    //
    // Simulated against real Postgres with a trigger that raises a real
    // `40P01`, so the store sees exactly the driver error a deadlock produces —
    // no mocking of the layer under test.
    const db = makeKysely();
    await runDecisionsMigration(db);
    const s = createDecisionsStore(db);
    await s.create(base());
    await sql`
      CREATE OR REPLACE FUNCTION decisions_v1_test_boom() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END;
      $$ LANGUAGE plpgsql
    `.execute(db);
    await sql`
      CREATE TRIGGER decisions_v1_test_boom_trg
        BEFORE UPDATE ON decisions_v1_decisions
        FOR EACH ROW WHEN (NEW.status = 'executed')
        EXECUTE FUNCTION decisions_v1_test_boom()
    `.execute(db);

    const err = await s
      .claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DuplicateAuthorisationError);
    expect((err as Error).message).toContain('deadlock detected');
    // Nothing was written, so a retry is the right recovery.
    expect((await s.get('dec_1'))!.status).toBe('pending');
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

describe('decisions store — the rows a receipt is derived from', () => {
  /**
   * ONE RULE, TWO LANGUAGES, and this is the seam where they meet.
   *
   * `receiptFor` decides in TypeScript whether a row says anything happened;
   * `listReceiptCandidates` asks the same question in SQL so that a page is
   * exactly a page. Neither can see the other, and the failure when they drift
   * is silent — a row that never reaches a reader is indistinguishable from a
   * row that never happened. So the fixture below walks every status and every
   * marker combination and pins the two against each other, against REAL
   * Postgres rather than the fake.
   *
   * KEYED BY STATUS, not a flat list, and the key set is the point. A flat
   * array — which this was — covers whatever somebody remembered to add, so a
   * new `DecisionStatus` wired into `receiptFor` and omitted here escapes the
   * very guard that claims to catch it. Two things stop that now:
   *
   *   * `satisfies Record<DecisionStatus, …>` — every union member must appear
   *     as a key or this stops compiling. Note what that is NOT worth on its
   *     own: `pnpm build` does not type-check `__tests__`, so it bites in an
   *     editor and in a `tsc` run that includes tests, and nowhere else. It is
   *     documentation with teeth, not the gate.
   *   * the coverage assertion below, against `DecisionStatusSchema.options` —
   *     the enum itself, which cannot fall behind the union. THAT is the gate,
   *     because it fails in `pnpm test` where anyone will actually see it.
   */
  const CASES = {
    pending: [{ name: 'pending', over: { status: 'pending', resolvedAt: null } }],
    stale: [{ name: 'stale', over: { status: 'stale', resolvedAt: null } }],
    dismissed: [{ name: 'dismissed', over: { status: 'dismissed', resolvedAt: T_SOON } }],
    expired: [{ name: 'expired', over: { status: 'expired', resolvedAt: T_SOON } }],
    executed: [
      // Approved, but the call has NOT gone out: the deferred window, and the
      // attended row still waiting for its warm agent. Both are still undoable.
      { name: 'executed, nothing spent', over: { status: 'executed', resolvedAt: T_SOON } },
      {
        name: 'executed, host replayed it',
        over: { status: 'executed', resolvedAt: T_SOON, replayedAt: T_LATE },
      },
      {
        name: 'executed, agent consumed it',
        over: { status: 'executed', resolvedAt: T_SOON, consumedAt: T_LATE },
      },
    ],
    'approved-pending-agent': [
      {
        name: 'parked for the agent',
        over: { status: 'approved-pending-agent', resolvedAt: T_SOON },
      },
      {
        name: 'parked and since performed',
        over: {
          status: 'approved-pending-agent',
          resolvedAt: T_SOON,
          consumedAt: T_LATE,
        },
      },
    ],
    failed: [
      {
        name: 'failed',
        over: { status: 'failed', resolvedAt: T_SOON, replayError: 'upstream 503' },
      },
      {
        // TASK-253's reclaim. Same status, same selection — only the SENTENCE
        // differs, because a crashed flight cannot honestly report that
        // nothing was completed. It is listed here so the SQL/receiptFor pair
        // is pinned across the shape, not only the status.
        name: 'failed after a stranded flight was reclaimed',
        over: {
          status: 'failed',
          resolvedAt: T_SOON,
          replayClaimedAt: T_SOON,
          replayAbandonedAt: T_LATE,
        },
      },
    ],
  } satisfies Record<DecisionStatus, ReadonlyArray<{ name: string; over: Partial<Decision> }>>;

  const FLAT = Object.values(CASES).flat();

  it('covers every status the union declares', () => {
    // The gate the `satisfies` above cannot be, because `pnpm build` does not
    // type-check this file. A status added to `DecisionStatus` — and therefore
    // to the enum, which the `returns` schema forces to stay complete — with
    // no fixture here fails HERE, before it can quietly escape the drift check
    // below.
    expect(Object.keys(CASES).sort()).toEqual([...DecisionStatusSchema.options].sort());
  });

  it('selects exactly the rows receiptFor answers for', async () => {
    const s = await freshStore();
    for (const [i, c] of FLAT.entries()) {
      await s.create(
        base({ id: `dec_${i}`, callFingerprint: `fp-${i}`, ...c.over }),
      );
    }

    const selected = await s.listReceiptCandidates({
      ownerUserId: 'u1',
      agentId: 'a1',
      limit: 100,
    });
    const selectedIds = new Set(selected.map((d) => d.id));

    for (const [i, c] of FLAT.entries()) {
      const row = base({ id: `dec_${i}`, callFingerprint: `fp-${i}`, ...c.over });
      expect(
        { case: c.name, selected: selectedIds.has(row.id) },
        `SQL and receiptFor disagree about "${c.name}"`,
      ).toEqual({ case: c.name, selected: receiptFor(row) !== null });
    }
  });

  it('scopes to one owner and one agent — a shared agent is not a shared queue', async () => {
    const s = await freshStore();
    const resolved: Partial<Decision> = { status: 'failed', resolvedAt: T_SOON };
    await s.create(base({ id: 'mine', callFingerprint: 'fp-a', ...resolved }));
    await s.create(
      base({
        id: 'theirs',
        callFingerprint: 'fp-b',
        ownerUserId: 'u2',
        ...resolved,
      }),
    );
    await s.create(
      base({ id: 'other-agent', callFingerprint: 'fp-c', agentId: 'a2', ...resolved }),
    );

    const rows = await s.listReceiptCandidates({
      ownerUserId: 'u1',
      agentId: 'a1',
      limit: 100,
    });
    expect(rows.map((d) => d.id)).toEqual(['mine']);
  });

  it('pages newest-first on an EXCLUSIVE instant cursor', async () => {
    const s = await freshStore();
    const at = ['09:00', '10:00', '11:00'].map((t) => `2026-08-20T${t}:00.000Z`);
    for (const [i, resolvedAt] of at.entries()) {
      await s.create(
        base({
          id: `dec_${i}`,
          callFingerprint: `fp-${i}`,
          status: 'failed',
          resolvedAt,
        }),
      );
    }

    const page1 = await s.listReceiptCandidates({
      ownerUserId: 'u1',
      agentId: 'a1',
      limit: 2,
    });
    expect(page1.map((d) => d.resolvedAt)).toEqual([at[2], at[1]]);

    const page2 = await s.listReceiptCandidates({
      ownerUserId: 'u1',
      agentId: 'a1',
      limit: 2,
      before: page1.at(-1)!.resolvedAt!,
    });
    // EXCLUSIVE: the cursor row is not served twice.
    expect(page2.map((d) => d.resolvedAt)).toEqual([at[0]]);
  });

  it('orders two decisions answered in the same millisecond stably', async () => {
    // Without the id tie-break the two could swap between the page that hands
    // out the cursor and the page that uses it, which loses one and repeats
    // the other.
    const s = await freshStore();
    for (const id of ['dec_a', 'dec_b', 'dec_c']) {
      await s.create(
        base({ id, callFingerprint: `fp-${id}`, status: 'failed', resolvedAt: T_SOON }),
      );
    }
    const first = await s.listReceiptCandidates({
      ownerUserId: 'u1',
      agentId: 'a1',
      limit: 3,
    });
    const again = await s.listReceiptCandidates({
      ownerUserId: 'u1',
      agentId: 'a1',
      limit: 3,
    });
    expect(again.map((d) => d.id)).toEqual(first.map((d) => d.id));
  });
});

/**
 * TASK-253 — the rows a crashed host leaves behind, and the one write that
 * gets them out of the way.
 *
 * A stranded flight is a row that is `executed`, claimed, un-replayed and
 * unconsumed with nothing left running behind it. THREE paths can produce one,
 * and each is built here the way the plugin builds it rather than by writing
 * the columns out by hand — a fixture that sets `replay_claimed_at` directly
 * would keep passing after the path that sets it stopped existing.
 *
 * The reclaim FAILS the row. It does not retry it. That is the whole safety
 * argument: reclaiming early cannot re-run anything, because nothing here runs
 * anything — the worst it can do is drop an authorisation nobody could cash in
 * anyway, and even that is guarded by the age cutoff the caller passes.
 */
describe('decisions store — reclaiming a stranded flight', () => {
  /** The flight is taken at `T_SOON` (09:00:05) on every path below. */
  const T_INSIDE = '2026-08-20T09:00:04.000Z';
  const T_OUTSIDE = '2026-08-20T09:20:00.000Z';
  const T_RECLAIMED = '2026-08-20T09:20:01.000Z';

  /** The three ways a row ends up `executed` with a flight nobody is flying. */
  const PATHS = {
    /** Unattended, reversible, host executor present: claimed WITH the flight. */
    async immediate(s: DecisionStore): Promise<void> {
      await s.create(base());
      await s.claimForApproval('dec_1', {
        nowIso: T_SOON,
        status: 'executed',
        replayClaimedAt: T_SOON,
      });
    },
    /** Unattended, irreversible: the sweep claims it when the window closes. */
    async deferred(s: DecisionStore): Promise<void> {
      await s.create(base({ irreversible: true }));
      await s.claimForApproval('dec_1', {
        nowIso: T0,
        status: 'executed',
        replayDueAt: T0,
      });
      const claimed = await s.claimDueReplays(T_SOON, 10);
      expect(claimed).toHaveLength(1);
    },
    /** Attended, delivery failed: TASK-277 takes the flight after the claim. */
    async fallback(s: DecisionStore): Promise<void> {
      await s.create(base());
      await s.claimForApproval('dec_1', { nowIso: T0, status: 'executed' });
      expect(await s.claimReplayFlight('dec_1', T_SOON)).not.toBeNull();
    },
  };

  /** Both stores, driven into the stranded state by one of the three paths. */
  async function stranded(path: keyof typeof PATHS): Promise<DecisionStore[]> {
    const stores = [await freshStore(), createFakeStore()];
    for (const s of stores) {
      await PATHS[path](s);
      const row = (await s.get('dec_1'))!;
      expect(row).toMatchObject({
        status: 'executed',
        replayClaimedAt: T_SOON,
        replayedAt: null,
        consumedAt: null,
      });
    }
    return stores;
  }

  const reclaim = (s: DecisionStore, claimedBeforeIso: string): Promise<Decision[]> =>
    s.reclaimStrandedFlights({ nowIso: T_RECLAIMED, claimedBeforeIso, limit: 10 });

  for (const path of Object.keys(PATHS) as Array<keyof typeof PATHS>) {
    it(`recovers a flight stranded on the ${path} path, and frees its index slot`, async () => {
      for (const s of await stranded(path)) {
        const [row] = await reclaim(s, T_OUTSIDE);
        expect(row!.status).toBe('failed');
        expect(row!.replayAbandonedAt).toBe(T_RECLAIMED);
        // The call was never made and this write does not pretend otherwise.
        expect(row!.replayedAt).toBeNull();

        // The point of the whole exercise: the slot is free, so the same call
        // can be held and approved again.
        await s.create(base({ id: 'dec_2' }));
        expect(
          await s.claimForApproval('dec_2', { nowIso: T_RECLAIMED, status: 'executed' }),
        ).not.toBeNull();

        // And the abandoned row authorises NOTHING. A reclaim that left a
        // cashable yes behind would be the double-send it exists to avoid.
        expect((await s.get('dec_1'))!.status).toBe('failed');
      }
    });
  }

  it('leaves a flight younger than the cutoff alone — it may still be running', async () => {
    for (const s of await stranded('immediate')) {
      expect(await reclaim(s, T_INSIDE)).toEqual([]);
      expect((await s.get('dec_1'))!.status).toBe('executed');
    }
  });

  it('refuses an executed row with NO flight, however old it is', async () => {
    // An attended approval waiting for its warm agent. It is a live standing
    // authorisation with no clock on it, and failing it would cancel a yes
    // nobody withdrew.
    for (const s of [await freshStore(), createFakeStore()]) {
      await s.create(base());
      await s.claimForApproval('dec_1', { nowIso: T0, status: 'executed' });
      expect(await reclaim(s, T_OUTSIDE)).toEqual([]);
      expect((await s.get('dec_1'))!.status).toBe('executed');
    }
  });

  it('refuses a row parked for the agent, and one that is still open', async () => {
    for (const s of [await freshStore(), createFakeStore()]) {
      await s.create(base({ id: 'dec_parked' }));
      await s.claimForApproval('dec_parked', {
        nowIso: T0,
        status: 'approved-pending-agent',
      });
      await s.create(base({ id: 'dec_open', callFingerprint: 'fp-open' }));

      expect(await reclaim(s, T_OUTSIDE)).toEqual([]);
      expect((await s.get('dec_parked'))!.status).toBe('approved-pending-agent');
      expect((await s.get('dec_open'))!.status).toBe('pending');
    }
  });

  it('refuses a PARKED row that is somehow carrying an old flight', async () => {
    // The two above are refused because a parked or open row has no flight at
    // all, so the age comparison never reaches them — which means neither of
    // them exercises the STATUS predicate. This one does.
    //
    // The shape is written directly because nothing produces it: `parkForAgent`
    // clears `replay_claimed_at` precisely so a parked row cannot carry one.
    // If it ever did, reclaiming it would drop an authorisation the agent was
    // still going to perform — a call that runs zero times, which is the same
    // failure `claimReplayFlight` refuses `approved-pending-agent` to avoid.
    for (const s of [await freshStore(), createFakeStore()]) {
      await s.create(
        base({
          status: 'approved-pending-agent',
          resolvedAt: T0,
          replayClaimedAt: T_SOON,
        }),
      );
      expect(await reclaim(s, T_OUTSIDE)).toEqual([]);
      expect((await s.get('dec_1'))!.status).toBe('approved-pending-agent');
    }
  });

  it('refuses a row whose call ALREADY went out', async () => {
    // The row the host replayed and then crashed before anything else. There
    // is nothing to abandon, and rewriting it to `failed` would replace a true
    // receipt with a false one.
    for (const s of await stranded('immediate')) {
      await s.markReplayed('dec_1', T_SOON);
      expect(await reclaim(s, T_OUTSIDE)).toEqual([]);
      expect((await s.get('dec_1'))!.status).toBe('executed');
    }
  });

  it('refuses a row the AGENT consumed', async () => {
    // Unreachable through the store's own writes today — `claimReplayFlight`
    // and `takeApproval` each refuse what the other has taken — so the row is
    // written directly. The predicate is here so that if a fourth path ever
    // produces the shape, the reclaim cannot cancel an authorisation that has
    // already been spent.
    for (const s of [await freshStore(), createFakeStore()]) {
      await s.create(
        base({
          status: 'executed',
          resolvedAt: T0,
          replayClaimedAt: T_SOON,
          consumedAt: T_SOON,
        }),
      );
      expect(await reclaim(s, T_OUTSIDE)).toEqual([]);
      expect((await s.get('dec_1'))!.status).toBe('executed');
    }
  });

  it('a FROZEN host that thaws writes the truth back, stamp and all', async () => {
    // The sweep gave up; the host had not. `markReplayed` is unconditional on
    // status precisely so the world wins over the row, and this pins that what
    // it leaves behind is coherent: an `executed` row that went out, with no
    // "we gave up on this" marker still attached to it.
    for (const s of await stranded('immediate')) {
      expect(await reclaim(s, T_OUTSIDE)).toHaveLength(1);
      const back = await s.markReplayed('dec_1', T_LATE);
      expect(back!.status).toBe('executed');
      expect(back!.replayedAt).toBe(T_LATE);
      expect(back!.replayAbandonedAt).toBeNull();
      // And the receipt is the success one, with no trace of the abandonment.
      const receipt = receiptFor((await s.get('dec_1'))!)!;
      expect(receipt.outcome).toBe('executed');
      expect(receipt.receipt).toBe((await s.get('dec_1'))!.approvedText);
    }
  });

  it('is one-shot — a second pass over the same row finds nothing', async () => {
    for (const s of await stranded('immediate')) {
      expect(await reclaim(s, T_OUTSIDE)).toHaveLength(1);
      expect(await reclaim(s, T_OUTSIDE)).toEqual([]);
    }
  });

  it('honours the batch limit and leaves the rest for the next pass', async () => {
    for (const s of [await freshStore(), createFakeStore()]) {
      for (const i of [1, 2, 3]) {
        await s.create(base({ id: `dec_${i}`, callFingerprint: `fp-${i}` }));
        await s.claimForApproval(`dec_${i}`, {
          nowIso: T_SOON,
          status: 'executed',
          replayClaimedAt: T_SOON,
        });
      }
      expect(
        await s.reclaimStrandedFlights({
          nowIso: T_RECLAIMED,
          claimedBeforeIso: T_OUTSIDE,
          limit: 2,
        }),
      ).toHaveLength(2);
      expect(
        await s.reclaimStrandedFlights({
          nowIso: T_RECLAIMED,
          claimedBeforeIso: T_OUTSIDE,
          limit: 2,
        }),
      ).toHaveLength(1);
    }
  });
});

describe('decisions store — one OPEN question per (agent, call shape)', () => {
  // TASK-254. The gate's collapse lives here because a read-then-create in the
  // caller is a TOCTOU, and two identical `tool:pre-call` events genuinely
  // race. Every case below runs against real Postgres AND the fake, because
  // the fake is what the gate's own unit tests are proved against — a fake
  // answering a different question would let those pass over a store that
  // does not do this.
  const both = async (): Promise<DecisionStore[]> => [await freshStore(), createFakeStore()];

  it('creates when nothing is open for this (agent, call shape)', async () => {
    for (const s of await both()) {
      const out = await s.createOrReuseOpen(base());
      expect(out.created).toBe(true);
      expect(out.decision.id).toBe('dec_1');
      expect((await s.get('dec_1'))!.status).toBe('pending');
    }
  });

  it('hands back the standing OPEN row instead of writing a second', async () => {
    for (const s of await both()) {
      await s.createOrReuseOpen(base());
      const out = await s.createOrReuseOpen(base({ id: 'dec_2' }));
      expect(out.created).toBe(false);
      expect(out.decision.id).toBe('dec_1');
      // The second row was never written — not written and then hidden.
      expect(await s.get('dec_2')).toBeNull();
    }
  });

  it('reuses a STALE row — the freshness guard re-opened it, it is still open', async () => {
    for (const s of await both()) {
      await s.createOrReuseOpen(base());
      await s.markStale('dec_1', { staleReason: 'the draft moved', freshness: null });
      const out = await s.createOrReuseOpen(base({ id: 'dec_2' }));
      expect(out.created).toBe(false);
      expect(out.decision.id).toBe('dec_1');
    }
  });

  for (const [name, close] of [
    ['dismissed', async (s: DecisionStore) => void (await s.markDismissed('dec_1', T_SOON))],
    ['expired', async (s: DecisionStore) => void (await s.markExpired('dec_1', T_SOON))],
    [
      'approved',
      async (s: DecisionStore) =>
        void (await s.claimForApproval('dec_1', { nowIso: T_SOON, status: 'executed' })),
    ],
  ] as const) {
    it(`does NOT reuse a ${name} row — that question has an answer`, async () => {
      for (const s of await both()) {
        await s.createOrReuseOpen(base());
        await close(s);
        const out = await s.createOrReuseOpen(base({ id: 'dec_2' }));
        expect(out.created).toBe(true);
        expect(out.decision.id).toBe('dec_2');
      }
    });
  }

  it('scopes to the AGENT — one agent’s question never stands in for another’s', async () => {
    for (const s of await both()) {
      await s.createOrReuseOpen(base());
      const out = await s.createOrReuseOpen(base({ id: 'dec_2', agentId: 'a2' }));
      expect(out.created).toBe(true);
      expect(out.decision.id).toBe('dec_2');
    }
  });

  it('scopes to the CALL SHAPE — a different call is a different question', async () => {
    for (const s of await both()) {
      await s.createOrReuseOpen(base());
      const out = await s.createOrReuseOpen(base({ id: 'dec_2', callFingerprint: 'fp-2' }));
      expect(out.created).toBe(true);
      expect(out.decision.id).toBe('dec_2');
    }
  });

  it('scopes to the OWNER — a shared agent is not a shared queue', async () => {
    // Reads are owner-scoped, so handing u2 the id of u1's row would give u2 a
    // question they cannot see or answer. Two rows that collide at approval
    // time (loudly, since TASK-253) beat one row that is invisible to the
    // person being asked.
    for (const s of await both()) {
      await s.createOrReuseOpen(base());
      const out = await s.createOrReuseOpen(base({ id: 'dec_2', ownerUserId: 'u2' }));
      expect(out.created).toBe(true);
      expect(out.decision.id).toBe('dec_2');
    }
  });

  it('reuses across the same person’s CONVERSATIONS', async () => {
    // Deliberately wider than the thread: the authorisation this leads to is
    // keyed (agent, fingerprint) with no conversation in it, so two open rows
    // in two threads are two cards for one authorisation.
    for (const s of await both()) {
      await s.createOrReuseOpen(base());
      const out = await s.createOrReuseOpen(base({ id: 'dec_2', conversationId: 'c2' }));
      expect(out.created).toBe(false);
      expect(out.decision.id).toBe('dec_1');
      expect(out.decision.conversationId).toBe('c1');
    }
  });

  it('lets an UNDO put a dismissal back even though the agent has since asked again', async () => {
    // The reachable state that rules out the other design — a second partial
    // unique index over the open statuses, letting the database refuse the
    // duplicate. Dismiss, the agent tries the identical call, undo: two open
    // rows for one (agent, call shape), which such an index would have turned
    // into a THROWN undo. It leaves two cards instead, and the second approval
    // of them is refused out loud by `claimForApproval` — the residue this
    // collapse knowingly leaves, and much the cheaper of the two.
    for (const s of await both()) {
      await s.createOrReuseOpen(base());
      await s.markDismissed('dec_1', T_SOON);
      expect((await s.createOrReuseOpen(base({ id: 'dec_2' }))).created).toBe(true);

      const restored = await s.restore('dec_1');
      expect(restored).not.toBeNull();
      expect(restored!.status).toBe('pending');
      expect(await s.list({ ownerUserId: 'u1' })).toHaveLength(2);
    }
  });

  it('is ATOMIC — eight racing holds of the same call leave exactly one row', async () => {
    // The TOCTOU the caller cannot close on its own: two identical
    // `tool:pre-call` events, each reading "nothing open" before either writes.
    // Real Postgres only — the fake is single-threaded, so it cannot fail this
    // and must not be allowed to claim it passes it.
    const db = new Kysely<DecisionsDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 8 }) }),
    });
    opened.push(db);
    await runDecisionsMigration(db);
    const s = createDecisionsStore(db);
    // Warm every connection first. Postgres opens them lazily, and a pool that
    // is still connecting serialises the callers by accident — which would
    // make this test pass with no guard at all.
    await Promise.all(Array.from({ length: 8 }, () => sql`SELECT 1`.execute(db)));
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        s.createOrReuseOpen(base({ id: `dec_race_${i}` })),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const ids = new Set(results.map((r) => r.decision.id));
    expect(ids.size).toBe(1);
    expect(await s.list({ ownerUserId: 'u1' })).toHaveLength(1);
  });
});
