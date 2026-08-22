import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stopPostgresContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runDecisionsMigration, type DecisionsDatabase } from '../migrations.js';
import { createDecisionsStore, type DecisionStore } from '../store.js';
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
    await s.markExecuted('dec_1', T_SOON);
    await s.create(base({ id: 'dec_2' }));
    // The partial unique index is the guarantee: two approvals of the same
    // call shape cannot both leave an authorisation standing.
    await expect(s.markExecuted('dec_2', T_SOON)).rejects.toThrow();
  });

  it('allows a new approval once the first is consumed', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.markExecuted('dec_1', T_SOON);
    expect((await s.takeApproval('a1', 'fp-1', T_SOON))!.id).toBe('dec_1');

    await s.create(base({ id: 'dec_2' }));
    const second = await s.markExecuted('dec_2', T_LATE);
    expect(second!.status).toBe('executed');
  });

  it('scopes the authorisation to the agent — another agent gets nothing', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.markExecuted('dec_1', T_SOON);
    expect(await s.takeApproval('a2', 'fp-1', T_SOON)).toBeNull();
  });

  it('takeApproval is one-shot', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.markExecuted('dec_1', T_SOON);
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
    await s.markExecuted('dec_1', T_SOON);

    const [a, b] = await Promise.all([
      s.takeApproval('a1', 'fp-1', T_SOON),
      s.takeApproval('a1', 'fp-1', T_SOON),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
  });

  it('exactly one of many concurrent takeApproval calls wins', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.markExecuted('dec_1', T_SOON);

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
    expect((await s.markExecuted('dec_1', T_SOON))!.status).toBe('executed');
    // Second call finds nothing open to change.
    expect(await s.markExecuted('dec_1', T_LATE)).toBeNull();
    expect((await s.get('dec_1'))!.resolvedAt).toBe(T_SOON);
  });

  it('cannot dismiss something already approved', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.markExecuted('dec_1', T_SOON);
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
    expect((await s.markExecuted('dec_1', T_LATE))!.status).toBe('executed');
  });

  it('markExecuted clears a stale reason that is no longer true', async () => {
    const s = await freshStore();
    await s.create(base({ status: 'stale', staleReason: 'the world moved' }));
    expect((await s.markExecuted('dec_1', T_LATE))!.staleReason).toBeNull();
  });
});

describe('decisions store — undo', () => {
  it('restores an approved decision to pending, dropping the authorisation', async () => {
    const s = await freshStore();
    await s.create(base());
    await s.markExecuted('dec_1', T_SOON);
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
    await s.markExecuted('dec_1', T_SOON);
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
