/**
 * TASK-715 — the per-user cache between the byte path and the usage ledger.
 *
 * The listener needs a SYNCHRONOUS yes/no per request; the ledger is async and in
 * another plugin. ProviderMeterHub keeps one bit (blocked) and one counter
 * (in flight) per USER, refreshed from the ledger. These tests use a fake ledger
 * and a fake clock, so every timing rule is exact.
 */
import { describe, it, expect } from 'vitest';
import {
  ProviderMeterHub,
  refusalMessage,
  type UsageLedgerPort,
  type UsageRecordPayload,
  type UsageVerdict,
} from '../provider-meter.js';
import type { ProviderCallSettlement } from '../provider-usage.js';

const OK: UsageVerdict = { blocked: false };
const USAGE = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
const BILLABLE: ProviderCallSettlement = { billable: true, model: 'm', usage: USAGE, requestBytes: 10 };

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** A ledger whose answers the test scripts; resolves on the next microtask unless told to hold. */
function fakeLedger() {
  const calls: Array<{ kind: 'status' | 'record'; userId: string; payload?: UsageRecordPayload }> = [];
  let statusAnswer: UsageVerdict | Error = OK;
  let recordAnswer: UsageVerdict | Error = OK;
  const held: Array<{ release: () => void }> = [];
  let hold = false;
  const wait = async (): Promise<void> => {
    if (!hold) return;
    await new Promise<void>((resolve) => held.push({ release: resolve }));
  };
  const ledger: UsageLedgerPort = {
    status: async (ctx) => {
      calls.push({ kind: 'status', userId: ctx.userId });
      const a = statusAnswer;
      await wait();
      if (a instanceof Error) throw a;
      return a;
    },
    record: async (ctx, payload) => {
      calls.push({ kind: 'record', userId: ctx.userId, payload });
      const a = recordAnswer;
      await wait();
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return {
    ledger,
    calls,
    setStatus: (a: UsageVerdict | Error) => (statusAnswer = a),
    setRecord: (a: UsageVerdict | Error) => (recordAnswer = a),
    hold: () => (hold = true),
    releaseAll: () => {
      hold = false;
      for (const h of held.splice(0)) h.release();
    },
    of: (kind: 'status' | 'record') => calls.filter((c) => c.kind === kind),
  };
}

const SESSION = (sessionId: string, userId = 'u1') => ({
  sessionId,
  userId,
  agentId: 'a1',
  hosts: ['API.Provider.Test'],
  requests: ['POST /v1/messages'],
});

/** Let fire-and-forget promises settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('ProviderMeterHub — seeding at session open', () => {
  it('carries the hosts (folded to lower case) and the allowed requests', async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger });
    const { meter } = await hub.forSession(SESSION('s1'));
    expect([...meter.hosts]).toEqual(['api.provider.test']);
    expect(meter.requests).toEqual(['POST /v1/messages']);
  });

  it('awaits the first status check, so a user who is already blocked starts blocked', async () => {
    const l = fakeLedger();
    l.setStatus({ blocked: true, reason: 'usage-limit-daily' });
    const hub = new ProviderMeterHub({ ledger: l.ledger });
    const { meter } = await hub.forSession(SESSION('s1'));
    expect(l.of('status')).toHaveLength(1);
    const a = meter.admit();
    expect(a).toMatchObject({ ok: false, reason: 'usage-limit-daily' });
    expect(a.ok === false && a.message).toBe(refusalMessage('usage-limit-daily'));
  });

  it('a status check that throws at open blocks (fail closed)', async () => {
    const l = fakeLedger();
    l.setStatus(new Error('db down'));
    const hub = new ProviderMeterHub({ ledger: l.ledger });
    const { meter } = await hub.forSession(SESSION('s1'));
    expect(meter.admit()).toMatchObject({ ok: false, reason: 'usage-check-unavailable' });
  });

  it('without a ledger the request allowlist still applies but nothing is gated or counted', async () => {
    const hub = new ProviderMeterHub();
    const { meter } = await hub.forSession(SESSION('s1'));
    expect(meter.requests).toEqual(['POST /v1/messages']);
    for (let i = 0; i < 100; i++) expect(meter.admit()).toEqual({ ok: true });
    meter.settle(BILLABLE); // a no-op, not a throw
  });
});

describe('ProviderMeterHub — the in-flight cap', () => {
  it('admits up to the cap, refuses the next as busy, and admits again after a settle', async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger, maxInFlightPerUser: 3 });
    const { meter } = await hub.forSession(SESSION('s1'));
    for (let i = 0; i < 3; i++) expect(meter.admit()).toEqual({ ok: true });
    expect(meter.admit()).toMatchObject({ ok: false, reason: 'busy' });
    meter.settle({ billable: false, usage: null, requestBytes: null });
    expect(meter.admit()).toEqual({ ok: true });
  });

  it('is per USER: two sessions of one user share it, another user has their own', async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger, maxInFlightPerUser: 2 });
    const a1 = (await hub.forSession(SESSION('s1', 'alice'))).meter;
    const a2 = (await hub.forSession(SESSION('s2', 'alice'))).meter;
    const b1 = (await hub.forSession(SESSION('s3', 'bob'))).meter;
    expect(a1.admit().ok).toBe(true);
    expect(a2.admit().ok).toBe(true);
    // alice, via EITHER session, is now at her cap…
    expect(a1.admit()).toMatchObject({ ok: false, reason: 'busy' });
    expect(a2.admit()).toMatchObject({ ok: false, reason: 'busy' });
    // …and bob is unaffected.
    expect(b1.admit().ok).toBe(true);
  });

  it('a refused admit takes no slot', async () => {
    const l = fakeLedger();
    l.setStatus({ blocked: true, reason: 'usage-suspended' });
    const hub = new ProviderMeterHub({ ledger: l.ledger, maxInFlightPerUser: 1 });
    const { meter } = await hub.forSession(SESSION('s1'));
    for (let i = 0; i < 5; i++) expect(meter.admit().ok).toBe(false);
    expect(hub.peek('u1')?.inFlight).toBe(0);
  });

  it('settle never drives the count below zero', async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger });
    const { meter } = await hub.forSession(SESSION('s1'));
    meter.settle({ billable: false, usage: null, requestBytes: null });
    expect(hub.peek('u1')?.inFlight).toBe(0);
  });
});

describe('ProviderMeterHub — recording and the verdict that comes back', () => {
  it('records a billable settlement with its payload, and not a non-billable one', async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger });
    const { meter } = await hub.forSession(SESSION('s1'));
    meter.admit();
    meter.settle(BILLABLE);
    meter.admit();
    meter.settle({ billable: false, usage: null, requestBytes: 5 });
    await flush();
    expect(l.of('record')).toHaveLength(1);
    expect(l.of('record')[0]).toMatchObject({
      userId: 'u1',
      payload: { model: 'm', usage: USAGE, requestBytes: 10 },
    });
  });

  it('omits model when the settlement has none (the payload never carries an undefined key)', async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger });
    const { meter } = await hub.forSession(SESSION('s1'));
    meter.admit();
    meter.settle({ billable: true, usage: null, requestBytes: null });
    await flush();
    expect('model' in l.of('record')[0]!.payload!).toBe(false);
  });

  it('a blocked verdict on a record refuses the next admit, for the whole user', async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger });
    const s1 = (await hub.forSession(SESSION('s1'))).meter;
    const s2 = (await hub.forSession(SESSION('s2'))).meter;
    l.setRecord({ blocked: true, reason: 'usage-limit-daily' });
    s1.admit();
    s1.settle(BILLABLE);
    await flush();
    expect(s1.admit()).toMatchObject({ ok: false, reason: 'usage-limit-daily' });
    expect(s2.admit()).toMatchObject({ ok: false, reason: 'usage-limit-daily' });
  });

  it('a record that throws blocks (fail closed) with the unavailable reason', async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger });
    const { meter } = await hub.forSession(SESSION('s1'));
    l.setRecord(new Error('write failed'));
    meter.admit();
    meter.settle(BILLABLE);
    await flush();
    expect(meter.admit()).toMatchObject({ ok: false, reason: 'usage-check-unavailable' });
  });

  it('only the NEWEST answer is applied: a slow older verdict cannot re-block a user a later one cleared', async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger });
    const { meter } = await hub.forSession(SESSION('s1'));

    l.hold();
    l.setRecord({ blocked: true, reason: 'usage-limit-daily' }); // the OLD, slow answer
    meter.admit();
    meter.settle(BILLABLE); // seq n, held
    await flush();
    l.setRecord(OK); // the NEWER answer
    meter.admit();
    meter.settle(BILLABLE); // seq n+1, held
    await flush();
    // Release in order: old first, then new.
    const oldFirst = async (): Promise<void> => {
      l.releaseAll();
      await flush();
    };
    await oldFirst();
    expect(meter.admit().ok).toBe(true);
  });
});

describe('ProviderMeterHub — refreshing the cached bit', () => {
  it('re-checks an active, unblocked user every refreshMs, in the background (the admit that triggers it is not held up)', async () => {
    const c = clock();
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger, now: c.now, refreshMs: 15_000 });
    const { meter } = await hub.forSession(SESSION('s1'));
    expect(l.of('status')).toHaveLength(1);

    c.advance(14_000);
    expect(meter.admit().ok).toBe(true);
    await flush();
    expect(l.of('status')).toHaveLength(1); // not yet

    c.advance(2_000);
    l.setStatus({ blocked: true, reason: 'usage-suspended' });
    expect(meter.admit().ok).toBe(true); // stale-while-revalidate: this one passes…
    await flush();
    expect(l.of('status')).toHaveLength(2);
    expect(meter.admit()).toMatchObject({ ok: false, reason: 'usage-suspended' }); // …the next does not
  });

  it('a blocked user is probed every probeMs, and a lifted block clears', async () => {
    const c = clock();
    const l = fakeLedger();
    l.setStatus({ blocked: true, reason: 'usage-limit-daily' });
    const hub = new ProviderMeterHub({ ledger: l.ledger, now: c.now, probeMs: 5_000 });
    const { meter } = await hub.forSession(SESSION('s1'));

    c.advance(3_000);
    expect(meter.admit().ok).toBe(false);
    await flush();
    expect(l.of('status')).toHaveLength(1); // too soon to probe again

    c.advance(3_000); // 6s since the last check
    l.setStatus(OK);
    expect(meter.admit().ok).toBe(false); // still refused: the probe has not landed
    await flush();
    expect(l.of('status')).toHaveLength(2);
    expect(meter.admit()).toEqual({ ok: true });
  });

  it('never runs two status checks at once', async () => {
    const c = clock();
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger, now: c.now, refreshMs: 1_000 });
    const { meter } = await hub.forSession(SESSION('s1'));
    c.advance(5_000);
    l.hold();
    meter.admit();
    meter.admit();
    meter.admit();
    await flush();
    expect(l.of('status')).toHaveLength(2); // the open check + exactly one refresh
    l.releaseAll();
    await flush();
  });

  it('a refresh that throws blocks; a later good one clears it', async () => {
    const c = clock();
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger, now: c.now, refreshMs: 1_000, probeMs: 1_000 });
    const { meter } = await hub.forSession(SESSION('s1'));
    c.advance(2_000);
    l.setStatus(new Error('timeout'));
    meter.admit();
    await flush();
    expect(meter.admit()).toMatchObject({ ok: false, reason: 'usage-check-unavailable' });
    c.advance(2_000);
    l.setStatus(OK);
    meter.admit();
    await flush();
    expect(meter.admit().ok).toBe(true);
  });
});

describe('ProviderMeterHub — closing a session', () => {
  it("a closed session's meter refuses (a tunnel that outlived it cannot keep spending)", async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger });
    const { meter, close } = await hub.forSession(SESSION('s1'));
    expect(meter.admit().ok).toBe(true);
    close();
    expect(meter.admit()).toMatchObject({ ok: false, reason: 'session-closed' });
  });

  it("closing one of a user's sessions leaves the other working and keeps the shared state", async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger, maxInFlightPerUser: 2 });
    const one = await hub.forSession(SESSION('s1'));
    const two = await hub.forSession(SESSION('s2'));
    expect(one.meter.admit().ok).toBe(true);
    one.close();
    expect(hub.peek('u1')?.inFlight).toBe(1);
    expect(two.meter.admit().ok).toBe(true);
    expect(two.meter.admit()).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('forgets a user once their last session is closed and nothing is in flight', async () => {
    const l = fakeLedger();
    const hub = new ProviderMeterHub({ ledger: l.ledger });
    const { meter, close } = await hub.forSession(SESSION('s1'));
    meter.admit();
    close();
    expect(hub.peek('u1')).toBeDefined(); // a call is still in flight
    meter.settle({ billable: false, usage: null, requestBytes: null });
    expect(hub.peek('u1')).toBeUndefined();
  });
});
