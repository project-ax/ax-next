// @vitest-environment node
/**
 * Unit tests for the durable "Not now" marker (TASK-444).
 *
 * Two things are under test and they pull in opposite directions:
 *
 *  - the KEY has to be unambiguous. `agentId`, `kind` and `subjectId` all come
 *    from a manifest an agent authored, and `userId` decides whose namespace we
 *    are in — so an id carrying a `:` must not be able to spell itself into a
 *    different segment (invariant 5, untrusted at every hop).
 *  - the VALUE has to be read defensively. It is bytes out of a store that
 *    other code, other versions and a corrupted row can all reach; a value we
 *    cannot parse means "we don't know", which is NOT "declined" and is
 *    certainly not a crash that takes the grants list down with it.
 */
import { describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, type AgentContext } from '@ax/core';
import {
  filterDeclinedGrants,
  grantDeclineKey,
  grantDeclineUserPrefix,
  parseGrantDeclineKey,
  readGrantDeclines,
  recordGrantDecline,
  withoutDeclinedGrants,
} from '../../server/grant-declines.js';
import type { PermissionRequest } from '../../server/types.js';

function makeCtx(warn: (event: string, fields?: unknown) => void): AgentContext {
  const ctx = makeAgentContext({
    sessionId: 'init',
    agentId: '@ax/channel-web',
    userId: 'system',
  });
  return {
    ...ctx,
    logger: { ...ctx.logger, warn: warn as AgentContext['logger']['warn'] },
  } as AgentContext;
}

/** A bus with a KV store backed by `store`. */
function busWith(store: Map<string, Uint8Array>): HookBus {
  const bus = new HookBus();
  bus.registerService<{ key: string; value: Uint8Array }, void>(
    'storage:set',
    'storage',
    async (_ctx, { key, value }) => {
      store.set(key, value);
    },
  );
  bus.registerService<
    { prefix: string },
    { entries: Array<{ key: string; value: Uint8Array }> }
  >('storage:list-prefix', 'storage', async (_ctx, { prefix }) => ({
    entries: [...store.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, value]) => ({ key, value })),
  }));
  return bus;
}

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

describe('grant-decline keys', () => {
  it('round-trips every segment back out, verbatim', () => {
    const key = grantDeclineKey('u-ann', 'a-quill', 'skill', 'linear');
    expect(parseGrantDeclineKey(key)).toEqual({
      userId: 'u-ann',
      agentId: 'a-quill',
      kind: 'skill',
      subjectId: 'linear',
    });
  });

  it('a subjectId full of separators survives the round-trip', () => {
    const subjectId = 'evil:skill:/../s';
    const key = grantDeclineKey('u-ann', 'a-quill', 'skill', subjectId);
    // The raw separators are gone from the key itself...
    expect(key).not.toContain('evil:skill');
    // ...and the id comes back whole.
    expect(parseGrantDeclineKey(key)?.subjectId).toBe(subjectId);
  });

  it('two different grants can never build the same key', () => {
    /*
      The collision an unencoded key would have, and the reason encoding is
      load-bearing rather than cosmetic. Unencoded, both of these spell
      `grant-decline:u-ann:a:skill:evil:skill:s` — so declining the first
      would silently suppress the second, on a different agent, forever.
      Both ids come from an agent-authored manifest.
    */
    const a = grantDeclineKey('u-ann', 'a:skill:evil', 'skill', 's');
    const b = grantDeclineKey('u-ann', 'a', 'skill', 'evil:skill:s');
    expect(a).not.toBe(b);
    expect(parseGrantDeclineKey(a)?.agentId).toBe('a:skill:evil');
    expect(parseGrantDeclineKey(b)?.subjectId).toBe('evil:skill:s');
  });

  it('a userId cannot spell its way into somebody else’s prefix', () => {
    // `grant-decline:u-mallory:…` must not be reachable by a user whose id
    // merely CONTAINS that text plus a colon.
    const forged = grantDeclineUserPrefix('u-mallory:a:skill');
    expect(forged.startsWith(grantDeclineUserPrefix('u-mallory'))).toBe(false);
  });

  it('the user prefix is a prefix of that user’s keys and of nobody else’s', () => {
    const key = grantDeclineKey('u-ann', 'a-quill', 'connector', 'github');
    expect(key.startsWith(grantDeclineUserPrefix('u-ann'))).toBe(true);
    expect(key.startsWith(grantDeclineUserPrefix('u-annette'))).toBe(false);
  });

  it('rejects a key that is not four segments, or not ours at all', () => {
    expect(parseGrantDeclineKey('grant-decline:u-ann:a-quill:skill')).toBeNull();
    expect(
      parseGrantDeclineKey('grant-decline:u-ann:a-quill:skill:linear:extra'),
    ).toBeNull();
    expect(parseGrantDeclineKey('settings:branding')).toBeNull();
    // A segment that is not decodable is a malformed row, not a crash.
    expect(parseGrantDeclineKey('grant-decline:u-ann:a-quill:skill:%E0%A4%A')).toBeNull();
  });
});

describe('recordGrantDecline / readGrantDeclines', () => {
  it('a recorded decline reads back at the instant it was written', async () => {
    const store = new Map<string, Uint8Array>();
    const bus = busWith(store);
    const ctx = makeCtx(() => {});

    await recordGrantDecline(bus, ctx, {
      userId: 'u-ann',
      agentId: 'a-quill',
      kind: 'skill',
      subjectId: 'linear',
      declinedAt: 1234,
    });

    const declines = await readGrantDeclines(bus, ctx, 'u-ann');
    expect(declines.get(grantDeclineKey('u-ann', 'a-quill', 'skill', 'linear'))).toBe(
      1234,
    );
  });

  it('reads only the caller’s own rows', async () => {
    const store = new Map<string, Uint8Array>();
    const bus = busWith(store);
    const ctx = makeCtx(() => {});
    await recordGrantDecline(bus, ctx, {
      userId: 'u-ann',
      agentId: 'a-quill',
      kind: 'skill',
      subjectId: 'linear',
      declinedAt: 1,
    });
    await recordGrantDecline(bus, ctx, {
      userId: 'u-bob',
      agentId: 'a-scout',
      kind: 'skill',
      subjectId: 'github',
      declinedAt: 2,
    });

    const declines = await readGrantDeclines(bus, ctx, 'u-ann');
    expect([...declines.values()]).toEqual([1]);
  });

  it('skips a value that does not decode to {declinedAt: number}, and says so', async () => {
    const store = new Map<string, Uint8Array>();
    const bus = busWith(store);
    const warn = vi.fn();
    const ctx = makeCtx(warn);

    const good = grantDeclineKey('u-ann', 'a-quill', 'skill', 'good');
    store.set(good, enc({ declinedAt: 99 }));
    store.set(
      grantDeclineKey('u-ann', 'a-quill', 'skill', 'not-json'),
      new TextEncoder().encode('}{'),
    );
    store.set(
      grantDeclineKey('u-ann', 'a-quill', 'skill', 'wrong-shape'),
      enc({ declinedAt: 'yesterday' }),
    );
    store.set(grantDeclineKey('u-ann', 'a-quill', 'skill', 'nan'), enc({ declinedAt: NaN }));

    const declines = await readGrantDeclines(bus, ctx, 'u-ann');

    // The unreadable rows are absent — NOT present with some default, because
    // a row we cannot read must never read as "the person said no".
    expect([...declines.keys()]).toEqual([good]);
    expect(warn).toHaveBeenCalled();
  });

  it('ignores a row under our prefix whose key is not one of ours', async () => {
    const store = new Map<string, Uint8Array>();
    const bus = busWith(store);
    const ctx = makeCtx(() => {});
    store.set(`${grantDeclineUserPrefix('u-ann')}only-two:segments`, enc({ declinedAt: 5 }));

    expect((await readGrantDeclines(bus, ctx, 'u-ann')).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The comparison itself, on its own.
//
// It was split out of `withoutDeclinedGrants` because the SSE replay has to run
// it with the response already streaming and its live subscribers not yet
// attached (see the step-3a/4a comments in sse.ts). That makes two properties
// load-bearing rather than merely nice: it is SYNCHRONOUS, and it is TOTAL. The
// second one is what these tests are mostly about.
describe('filterDeclinedGrants', () => {
  const skill = (skillId: string): PermissionRequest => ({
    kind: 'skill',
    skillId,
    description: 'd',
    hosts: ['api.example.com'],
    slots: [{ slot: 'KEY', kind: 'api-key' as const }],
  });

  const row = (agentId: string, card: PermissionRequest, raisedAt: number) => ({
    agentId,
    card,
    raisedAt,
  });

  const declines = (
    entries: Array<[[string, string, 'skill' | 'connector', string], number]>,
  ): Map<string, number> =>
    new Map(
      entries.map(([[u, a, k, s], at]) => [grantDeclineKey(u, a, k, s), at]),
    );

  it('drops a grant declined at or after it was raised, keeps one raised since', () => {
    const ctx = makeCtx(() => {});
    const kept = filterDeclinedGrants(
      ctx,
      declines([
        [['u-ann', 'a-quill', 'skill', 'declined-same'], 1_000],
        [['u-ann', 'a-quill', 'skill', 'declined-after'], 2_000],
        [['u-ann', 'a-quill', 'skill', 're-raised'], 1_000],
      ]),
      'u-ann',
      [
        row('a-quill', skill('declined-same'), 1_000),
        row('a-quill', skill('declined-after'), 1_000),
        row('a-quill', skill('re-raised'), 1_500),
        row('a-quill', skill('never-declined'), 1_000),
      ],
    );

    expect(
      kept.map((r) => (r.card.kind === 'skill' ? r.card.skillId : '')),
    ).toEqual(['re-raised', 'never-declined']);
  });

  it('never suppresses another agent’s or another user’s grant', () => {
    const ctx = makeCtx(() => {});
    const marker = declines([
      [['u-ann', 'a-quill', 'skill', 'linear'], 2_000],
    ]);

    // Same subject, different agent → different key → not answered.
    expect(
      filterDeclinedGrants(ctx, marker, 'u-ann', [
        row('a-other', skill('linear'), 1_000),
      ]),
    ).toHaveLength(1);
    // Same subject and agent, different reader → different key → not answered.
    expect(
      filterDeclinedGrants(ctx, marker, 'u-bob', [
        row('a-quill', skill('linear'), 1_000),
      ]),
    ).toHaveLength(1);
  });

  it('passes a host card straight through — it has no durable subject', () => {
    const ctx = makeCtx(() => {});
    const host: PermissionRequest = {
      kind: 'host',
      host: 'example.org',
      sessionId: 's-1',
    };
    expect(
      filterDeclinedGrants(ctx, declines([]), 'u-ann', [
        row('a-quill', host, 1_000),
      ]),
    ).toHaveLength(1);
  });

  // THE TOTALITY PROPERTY. `grantDeclineKey` runs `encodeURIComponent`, which
  // throws `URIError` on a lone surrogate — and every id it encodes comes out of
  // an agent-authored manifest. The caller that matters runs this with the SSE
  // stream already open and its subscribers not yet attached, so a throw here
  // does not fail a request, it abandons a connection half-built.
  //
  // Per-ROW, and that is the part that is new: the old shape wrapped the whole
  // filter in one try/catch, so one unencodable id meant the entire list went
  // through unfiltered and every genuine refusal in it was forgotten for that
  // read. Now the row we cannot key is kept and its neighbours are still judged.
  it('keeps a row whose key cannot be built, and still judges its neighbours', () => {
    const warn = vi.fn();
    const ctx = makeCtx(warn);
    // IN THE subjectId, because that is the segment that is actually
    // untrusted: `userId` is the authenticated caller and `agentId` is
    // server-derived on both call paths (the conversation lookup on the SSE
    // side, the card's recorded owner on the workspace side), while the
    // skill/connector id comes out of a manifest an agent authored.
    const loneSurrogate = 'linear-\uD800';
    // Guard the premise: if this ever stops throwing, the test below is vacuous.
    expect(() => encodeURIComponent(loneSurrogate)).toThrow(URIError);

    const kept = filterDeclinedGrants(
      ctx,
      declines([[['u-ann', 'a-quill', 'skill', 'linear'], 2_000]]),
      'u-ann',
      [
        row('a-quill', skill(loneSurrogate), 1_000),
        row('a-quill', skill('linear'), 1_000),
      ],
    );

    // Fail open on the one we could not evaluate; still drop the one we could.
    expect(kept.map((r) => (r.card as { skillId: string }).skillId)).toEqual([
      loneSurrogate,
    ]);
    expect(warn).toHaveBeenCalledWith(
      'workspace_grant_decline_key_failed',
      expect.objectContaining({ kind: 'skill' }),
    );
    // Neither id is logged: one of them is the thing that failed to encode.
    const [, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(fields).sort()).toEqual(['error', 'kind']);
  });
});

// ---------------------------------------------------------------------------
// Reclaiming the markers (TASK-482).
//
// A "Not now" stops meaning anything the moment the card it answered is gone
// or has been asked again — `raisedAt` is re-stamped on every raise and the
// pending-card buffer is in this one process's memory, so a marker that is not
// winning its comparison NOW can never win one again. These tests are about
// the three ways that can go wrong: reclaiming a refusal that is still doing
// work, reclaiming the wrong row because one key is a prefix of another, and
// buying a store round trip for the privilege.
// ---------------------------------------------------------------------------
describe('reclaimGrantDeclines', () => {
  const skill = (skillId: string): PermissionRequest => ({
    kind: 'skill',
    skillId,
    description: 'd',
    hosts: [],
    slots: [],
  });
  const row = (agentId: string, card: PermissionRequest, raisedAt: number) => ({
    agentId,
    card,
    raisedAt,
  });

  interface Kv {
    bus: HookBus;
    store: Map<string, Uint8Array>;
    /** Every key `storage:delete` was asked for, in order. */
    deleted: string[];
    /** Every prefix `storage:delete-prefix` was asked for. Must stay empty. */
    deletedPrefixes: string[];
    listCalls: { n: number };
    /** Rows handed back by the last `storage:list-prefix`. The scan cost. */
    lastScanSize: number;
  }

  /**
   * A KV bus with BOTH delete hooks registered, and `storage:delete-prefix`
   * wired to REAL prefix semantics. That second one is the whole point: if the
   * reclaim path ever reaches for it with an exact key, the sibling row really
   * does disappear and the collision test below really does go red. A stub
   * that merely recorded the call would pass a broken implementation.
   */
  function kvBus(opts: { noDelete?: boolean } = {}): Kv {
    const bus = new HookBus();
    const store = new Map<string, Uint8Array>();
    const kv: Kv = {
      bus,
      store,
      deleted: [],
      deletedPrefixes: [],
      listCalls: { n: 0 },
      lastScanSize: 0,
    };
    bus.registerService<{ key: string; value: Uint8Array }, void>(
      'storage:set',
      'storage',
      async (_ctx, { key: k, value }) => {
        store.set(k, value);
      },
    );
    bus.registerService<
      { prefix: string },
      { entries: Array<{ key: string; value: Uint8Array }> }
    >('storage:list-prefix', 'storage', async (_ctx, { prefix }) => {
      kv.listCalls.n += 1;
      const entries = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, value]) => ({ key: k, value }));
      kv.lastScanSize = entries.length;
      return { entries };
    });
    bus.registerService<{ prefix: string }, { deleted: number }>(
      'storage:delete-prefix',
      'storage',
      async (_ctx, { prefix }) => {
        kv.deletedPrefixes.push(prefix);
        let n = 0;
        for (const k of [...store.keys()]) {
          if (k.startsWith(prefix)) {
            store.delete(k);
            n += 1;
          }
        }
        return { deleted: n };
      },
    );
    if (opts.noDelete !== true) {
      bus.registerService<{ key: string }, { deleted: number }>(
        'storage:delete',
        'storage',
        async (_ctx, { key: k }) => {
          kv.deleted.push(k);
          return { deleted: store.delete(k) ? 1 : 0 };
        },
      );
    }
    return kv;
  }

  async function seed(
    kv: Kv,
    ctx: AgentContext,
    marks: Array<[agentId: string, subjectId: string, declinedAt: number]>,
  ): Promise<void> {
    for (const [agentId, subjectId, declinedAt] of marks) {
      await recordGrantDecline(kv.bus, ctx, {
        userId: 'u-ann',
        agentId,
        kind: 'skill',
        subjectId,
        declinedAt,
      });
    }
  }

  const key = (agentId: string, subjectId: string): string =>
    grantDeclineKey('u-ann', agentId, 'skill', subjectId);

  /*
    THE TRAP, PINNED. `…:abc` is a prefix of `…:abcd`, so the obvious
    implementation of "clean up this one marker" — a prefix delete of the exact
    key — takes a second, unrelated grant's refusal with it, and the person
    finds themselves asked about a skill they already turned down. The two
    subject ids here differ by one trailing character on purpose, and the bus
    above implements prefix-delete for real, so a regression to it is a red
    test rather than a code review someone has to remember to do.
  */
  it('reclaiming one marker leaves a prefix-colliding sibling untouched', async () => {
    const ctx = makeCtx(() => {});
    const kv = kvBus();
    await seed(kv, ctx, [
      ['a-quill', 'abc', 2_000],
      ['a-quill', 'abcd', 2_000],
    ]);

    // `abcd` is still answering a pending card; `abc` answers nothing.
    const kept = await withoutDeclinedGrants(
      kv.bus,
      ctx,
      'u-ann',
      [row('a-quill', skill('abcd'), 1_000)],
      { reclaimAgainstCompleteSet: true },
    );

    expect(kept).toHaveLength(0);
    expect(kv.deleted).toEqual([key('a-quill', 'abc')]);
    expect(kv.deletedPrefixes).toEqual([]);
    expect([...kv.store.keys()]).toEqual([key('a-quill', 'abcd')]);
  });

  it('never reclaims a refusal that is still suppressing a pending card', async () => {
    const ctx = makeCtx(() => {});
    const kv = kvBus();
    await seed(kv, ctx, [['a-quill', 'linear', 2_000]]);

    const kept = await withoutDeclinedGrants(
      kv.bus,
      ctx,
      'u-ann',
      [row('a-quill', skill('linear'), 1_000)],
      { reclaimAgainstCompleteSet: true },
    );

    expect(kept).toHaveLength(0);
    expect(kv.deleted).toEqual([]);
    expect(kv.store.has(key('a-quill', 'linear'))).toBe(true);
  });

  /*
    The other half of "still suppressing". A card the agent RE-RAISED after the
    refusal is pending, and its key matches the marker exactly — but `raisedAt`
    is the newer instant, so the marker already lost and can never win again
    (every future raise is newer still). Keeping it would be keeping a row that
    is guaranteed inert, which is the growth this card is about.
  */
  it('reclaims the marker for a grant that has since been re-raised', async () => {
    const ctx = makeCtx(() => {});
    const kv = kvBus();
    await seed(kv, ctx, [['a-quill', 'linear', 2_000]]);

    const kept = await withoutDeclinedGrants(
      kv.bus,
      ctx,
      'u-ann',
      [row('a-quill', skill('linear'), 3_000)],
      { reclaimAgainstCompleteSet: true },
    );

    // The card comes back — that is the need-trigger, unchanged...
    expect(kept).toHaveLength(1);
    // ...and the spent marker does not survive it.
    expect(kv.deleted).toEqual([key('a-quill', 'linear')]);
    expect(kv.store.size).toBe(0);
  });

  /*
    THE COST THIS CARD IS ABOUT. Not "the row went away" — the scan that reads
    the rows getting smaller. `lastScanSize` is what `storage:list-prefix`
    actually handed back, so this measures the read the person pays for rather
    than a proxy for it.
  */
  it('shrinks the scan the next read pays for', async () => {
    const ctx = makeCtx(() => {});
    const kv = kvBus();
    const marks: Array<[string, string, number]> = [];
    for (let i = 0; i < 20; i += 1) marks.push([`a-gone-${i}`, 'linear', 2_000]);
    marks.push(['a-quill', 'linear', 2_000]);
    await seed(kv, ctx, marks);

    const rows = [row('a-quill', skill('linear'), 1_000)];
    await withoutDeclinedGrants(kv.bus, ctx, 'u-ann', rows, {
      reclaimAgainstCompleteSet: true,
    });
    expect(kv.lastScanSize).toBe(21);

    await withoutDeclinedGrants(kv.bus, ctx, 'u-ann', rows, {
      reclaimAgainstCompleteSet: true,
    });
    // One row: the only refusal still doing any work.
    expect(kv.lastScanSize).toBe(1);
    expect(kv.listCalls.n).toBe(2);
  });

  /*
    THE GUARD TASK-444 LOST ONCE, and the reason reclamation is not allowed to
    look like a good reason to lose it again. Nothing pending means nothing to
    filter, and pruning must not be what buys a store round trip on a mount
    that had no question to answer. The markers survive, which is fine: they
    are unread, so they cost this read nothing at all.
  */
  it('does not scan, and does not prune, when nothing is pending', async () => {
    const ctx = makeCtx(() => {});
    const kv = kvBus();
    await seed(kv, ctx, [['a-gone', 'linear', 2_000]]);

    const kept = await withoutDeclinedGrants(kv.bus, ctx, 'u-ann', [], {
      reclaimAgainstCompleteSet: true,
    });

    expect(kept).toEqual([]);
    expect(kv.listCalls.n).toBe(0);
    expect(kv.deleted).toEqual([]);
    expect(kv.store.size).toBe(1);
  });

  it('prunes nothing unless the caller says its row set is the complete one', async () => {
    const ctx = makeCtx(() => {});
    const kv = kvBus();
    await seed(kv, ctx, [['a-gone', 'linear', 2_000]]);

    // The default. A caller holding a PARTIAL view of what is pending — the
    // SSE replay's one conversation, say — must not be able to prune by
    // forgetting to think about it.
    await withoutDeclinedGrants(kv.bus, ctx, 'u-ann', [
      row('a-quill', skill('github'), 1_000),
    ]);

    expect(kv.listCalls.n).toBe(1);
    expect(kv.deleted).toEqual([]);
    expect(kv.store.size).toBe(1);
  });

  it('degrades to answering the read when the store cannot delete one key', async () => {
    const ctx = makeCtx(() => {});
    const kv = kvBus({ noDelete: true });
    await seed(kv, ctx, [['a-gone', 'linear', 2_000]]);

    const kept = await withoutDeclinedGrants(
      kv.bus,
      ctx,
      'u-ann',
      [row('a-quill', skill('github'), 1_000)],
      { reclaimAgainstCompleteSet: true },
    );

    // The answer is right; only the housekeeping is missing. And it did NOT
    // fall back to the prefix delete, which is the unsafe hook this whole
    // path exists to avoid.
    expect(kept).toHaveLength(1);
    expect(kv.deletedPrefixes).toEqual([]);
    expect(kv.store.size).toBe(1);
  });

  it('a delete that throws is logged and never fails the grants read', async () => {
    const warn = vi.fn();
    const ctx = makeCtx(warn);
    const bus = new HookBus();
    const store = new Map<string, Uint8Array>();
    bus.registerService<{ key: string; value: Uint8Array }, void>(
      'storage:set',
      'storage',
      async (_ctx, { key: k, value }) => {
        store.set(k, value);
      },
    );
    bus.registerService<
      { prefix: string },
      { entries: Array<{ key: string; value: Uint8Array }> }
    >('storage:list-prefix', 'storage', async (_ctx, { prefix }) => ({
      entries: [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, value]) => ({ key: k, value })),
    }));
    bus.registerService<{ key: string }, { deleted: number }>(
      'storage:delete',
      'storage',
      async () => {
        throw new Error('kv is having a day');
      },
    );
    await recordGrantDecline(bus, ctx, {
      userId: 'u-ann',
      agentId: 'a-gone',
      kind: 'skill',
      subjectId: 'linear',
      declinedAt: 2_000,
    });

    const kept = await withoutDeclinedGrants(
      bus,
      ctx,
      'u-ann',
      [row('a-quill', skill('github'), 1_000)],
      { reclaimAgainstCompleteSet: true },
    );

    expect(kept).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'workspace_grant_declines_reclaim_failed',
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  /*
    A BOUND, not a batch size. The first prune on a store that grew before this
    shipped must not stall a workspace mount behind thousands of sequential
    deletes, so one read reclaims at most `RECLAIM_MAX_PER_READ` (64) and the
    next read picks up where it left off. Nothing is wrong in the meantime — an
    unreclaimed marker is inert, not incorrect.
  */
  it('reclaims at most a bounded number per read, and converges over reads', async () => {
    const ctx = makeCtx(() => {});
    const kv = kvBus();
    const marks: Array<[string, string, number]> = [];
    for (let i = 0; i < 70; i += 1) marks.push([`a-gone-${i}`, 'linear', 2_000]);
    await seed(kv, ctx, marks);

    const rows = [row('a-quill', skill('github'), 1_000)];
    await withoutDeclinedGrants(kv.bus, ctx, 'u-ann', rows, {
      reclaimAgainstCompleteSet: true,
    });
    expect(kv.deleted).toHaveLength(64);
    expect(kv.store.size).toBe(6);

    await withoutDeclinedGrants(kv.bus, ctx, 'u-ann', rows, {
      reclaimAgainstCompleteSet: true,
    });
    expect(kv.store.size).toBe(0);
  });

  /*
    FAIL-SAFE ON SPELLING. Every key this path deletes was rebuilt by
    `grantDeclineKey` from the AUTHENTICATED user id — it never echoes a
    spelling back out of the store. So a row written under some other encoding
    of the same triple (another version of this code, a hand-written row) is
    left where it is rather than guessed at: the delete names the canonical
    spelling, misses, and changes nothing. It costs one no-op delete per read
    for a row that cannot arise from this codebase; it buys the property that
    no value in the store can steer a delete at a key we could not ourselves
    have written.
  */
  it('never asks the store to delete a spelling it did not itself build', async () => {
    const ctx = makeCtx(() => {});
    const kv = kvBus();
    // `~` needs no escaping, so `%7E` is a DIFFERENT spelling of the same id.
    const foreign = `${grantDeclineUserPrefix('u-ann')}a-quill:skill:lin%7Eear`;
    kv.store.set(foreign, enc({ declinedAt: 2_000 }));
    expect(grantDeclineKey('u-ann', 'a-quill', 'skill', 'lin~ear')).not.toBe(
      foreign,
    );

    await withoutDeclinedGrants(
      kv.bus,
      ctx,
      'u-ann',
      [row('a-quill', skill('github'), 1_000)],
      { reclaimAgainstCompleteSet: true },
    );

    // The canonical spelling was attempted and missed; the stored row is
    // untouched, and the foreign spelling never appears in a delete.
    expect(kv.deleted).toEqual([
      grantDeclineKey('u-ann', 'a-quill', 'skill', 'lin~ear'),
    ]);
    expect(kv.deleted).not.toContain(foreign);
    expect(kv.store.has(foreign)).toBe(true);
  });
});
