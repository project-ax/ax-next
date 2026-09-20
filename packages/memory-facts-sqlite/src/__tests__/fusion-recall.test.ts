// The half of TASK-434 the shared contract cannot see: the CHANNELS, and the
// embedder/reranker seam that feeds them.
//
// `@ax/memory-facts-contract` deliberately asserts only the answer — which
// rows, in what order, under which filters — because that is all two engines
// built on different machinery can be held to identically (Invariant 1). So
// FTS5 tokenizing, `vec0` neighbour order, the 24-token cap, the producer
// timeouts and the backfill live here, in the engine's own suite, where
// naming them is allowed.
//
// Nothing in this file reaches the network. The embedder is `hash-embedder.ts`
// (FNV-1a, deterministic, ported from `dem-memory`), which is a real embedder
// in every way the store cares about.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database as BetterSqliteDb } from 'better-sqlite3';
import { HookBus, makeAgentContext } from '@ax/core';
import type { AgentContext } from '@ax/core';
import type {
  RecordInput,
  RecordOutput,
  RecallInput,
  RecallOutput,
  ReindexInput,
  ReindexOutput,
  ClearInput,
  SupersedeInput,
  SupersedeOutput,
} from '@ax/memory-facts-contract';
import { createMemoryFactsSqlitePlugin } from '../plugin.js';
import {
  openDatabase,
  TABLE,
  FTS_TABLE,
  VEC_TABLE,
  INFINITY_SENTINEL,
  EMBEDDING_DIMENSIONS,
} from '../schema.js';
import {
  buildFtsMatchQuery,
  denseChannel,
  factStatementText,
  sparseChannel,
  temporalChannel,
  MAX_MATCH_TOKENS,
  CHANNEL_LIMIT,
} from '../recall.js';
import { agentScopeKey } from '../agent-scope-key.js';
import { EMBED_HOOK, RERANK_HOOK, hashVector, registerHashEmbedder } from './hash-embedder.js';
import type { EmbedInput, EmbedOutput, RerankInput, RerankOutput } from '../producers.js';

const JAN = '2023-01-01T00:00:00.000Z';
const JUN = '2023-06-01T00:00:00.000Z';
const SEP = '2023-09-01T00:00:00.000Z';

// Rows are partitioned by an OPAQUE digest of the agentId, never by the
// agentId itself (`agent-scope-key.ts`), so a test that drives a channel
// directly has to derive the same key rather than inventing a readable one.
const AGENT_A = agentScopeKey({ agentId: 'a' });
// Wide enough that presence/absence is about the CHANNELS, not about a
// dense-only row losing a top-5 race to rows that two channels both proposed.
const MAX_ANSWER = 50;

const KHALID = { about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN };
const BOSTON = { about: 'user', relation: 'lives_in', value: 'Boston', when: JUN };
const ACME = { about: 'user', relation: 'works_at', value: 'Acme', when: SEP };

// ---------------------------------------------------------------------------
// buildFtsMatchQuery — the untrusted-text sanitizer, on its own
// ---------------------------------------------------------------------------
//
// The contract pins the BEHAVIOUR (a `-`-prefixed token is literal). These
// pin the MECHANISM, which the contract may not mention: an engine that
// stopped quoting but still happened to rank the contract's fixture correctly
// would pass there and fail here.
describe('@ax/memory-facts-sqlite — buildFtsMatchQuery', () => {
  it('quotes every token, so no FTS5 operator can survive as an operator', () => {
    // Against an unsanitized `query` passed straight to MATCH, this string is
    // a boolean expression: `NOT`, `-`, `*` and `^` all change what matches.
    expect(buildFtsMatchQuery('graduated NOT pasta -honors near* ^start')).toBe(
      '"graduated" OR "not" OR "pasta" OR "honors" OR "near" OR "start"',
    );
  });

  it('dedupes, so a repeated word cannot weight itself', () => {
    expect(buildFtsMatchQuery('Khalid khalid KHALID')).toBe('"khalid"');
  });

  it(`caps at ${MAX_MATCH_TOKENS} tokens`, () => {
    const query = Array.from({ length: 50 }, (_, i) => `t${i}`).join(' ');
    expect(buildFtsMatchQuery(query)?.split(' OR ')).toHaveLength(MAX_MATCH_TOKENS);
  });

  it('returns null when nothing survives tokenizing, rather than an empty MATCH', () => {
    // `MATCH ''` is a syntax error in FTS5, so "null means skip the channel" is
    // load-bearing, not tidiness.
    expect(buildFtsMatchQuery('--- *** ^^^')).toBeNull();
    expect(buildFtsMatchQuery('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The sparse channel's ORDER BY orientation
// ---------------------------------------------------------------------------
//
// SQLite's `bm25()` returns a more-NEGATIVE value for a better match, so
// `ORDER BY bm25(...)` ascending is best-first and a reflexive `DESC` would
// invert the channel. No contract case can see this: the fusion fixtures have
// at most one row matching the query, so the channel's internal order never
// shows. This is the test that would catch the inversion.
describe('@ax/memory-facts-sqlite — sparse channel', () => {
  let dir: string;
  const toClose: BetterSqliteDb[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-sparse-'));
  });

  afterEach(async () => {
    for (const db of toClose.splice(0)) if (db.open) db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('orders by bm25 ascending — the better match first, not last', async () => {
    const databasePath = join(dir, 'facts.db');
    const bus = new HookBus();
    const plugin = createMemoryFactsSqlitePlugin({ databasePath });
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'u',
      workspace: { rootPath: '/tmp' },
    });
    // Same term, very different documents: bm25 rewards the short one, where
    // the term carries most of the row, over the long one where it is a
    // passing mention.
    const out = await bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, {
      statements: [
        { about: 'user', relation: 'likes_artist', value: 'Khalid', when: JAN },
        {
          about: 'user',
          relation: 'stated',
          value:
            'a rambling note about many unrelated things and places and people and Khalid and yet more words besides',
          when: JUN,
        },
      ],
    });
    await plugin.shutdown?.();

    const db = openDatabase(databasePath).driver;
    toClose.push(db);
    const ids = sparseChannel(db, {
      agentKey: AGENT_A,
      match: buildFtsMatchQuery('Khalid')!,
      activeOnly: true,
      limit: 40,
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(out.records[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// The temporal channel's ordering key
// ---------------------------------------------------------------------------
describe('@ax/memory-facts-sqlite — temporal channel', () => {
  let dir: string;
  const toClose: BetterSqliteDb[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-temporal-'));
  });

  afterEach(async () => {
    for (const db of toClose.splice(0)) if (db.open) db.close();
    await rm(dir, { recursive: true, force: true });
  });

  // `dem-memory`'s no-anchor temporal branch orders by `transaction_time DESC,
  // valid_start DESC` — "what did I learn most recently" — while this package's
  // FILTERED LISTING orders by `valid_start DESC, id DESC` ("what is true, newest
  // first"). Those are two different questions and the channel wants the first
  // one, so the divergence is not cosmetic: the channel ADMITS its rows as
  // candidates (see the decisions shard), which means this ORDER BY decides their
  // RRF ranks and therefore the fused answer.
  //
  // The two keys agree on ~93% of rows, because `when` equals the extraction date
  // on that share (design §4.1). This test is built from the other ~7%: the row
  // recorded LATER carries the EARLIER `when`, so the two orderings are exact
  // opposites and no assertion can pass under both.
  it('orders by transaction_time, not valid_start — the most recently LEARNED row first', async () => {
    const databasePath = join(dir, 'facts.db');
    const bus = new HookBus();
    const plugin = createMemoryFactsSqlitePlugin({ databasePath });
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'u',
      workspace: { rootPath: '/tmp' },
    });
    const out = await bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, {
      statements: [ACME, KHALID],
    });
    await plugin.shutdown?.();
    const acme = out.records[0]!.id;
    const khalid = out.records[1]!.id;

    const db = openDatabase(databasePath).driver;
    toClose.push(db);
    // Pin both clocks rather than racing the wall clock: one `record` call can
    // stamp every row in the same millisecond, which would make this tie and
    // pass on whichever order the planner happened to emit.
    db.prepare(`UPDATE ${TABLE} SET transaction_time = ? WHERE id = ?`).run(SEP, khalid);
    db.prepare(`UPDATE ${TABLE} SET transaction_time = ? WHERE id = ?`).run(JAN, acme);

    const ids = temporalChannel(db, { agentKey: AGENT_A, activeOnly: true, limit: 40 });

    // Khalid has the OLDER `when` (JAN vs SEP) and the NEWER transaction_time.
    // Under `valid_start DESC` Acme leads; under `transaction_time DESC` Khalid
    // does. Asserting the full array pins the whole order, not just the head.
    expect(ids).toEqual([khalid, acme]);
  });
});

// ---------------------------------------------------------------------------
// The dense channel, against real vec0 rows
// ---------------------------------------------------------------------------
describe('@ax/memory-facts-sqlite — dense channel', () => {
  let dir: string;
  let databasePath: string;
  let bus: HookBus;
  let plugin: ReturnType<typeof createMemoryFactsSqlitePlugin>;
  let reader: BetterSqliteDb;

  function ctxOf(agentId = 'a', userId = 'u'): AgentContext {
    return makeAgentContext({
      sessionId: 's',
      agentId,
      userId,
      workspace: { rootPath: '/tmp' },
    });
  }

  async function record(input: RecordInput, ctx = ctxOf()): Promise<RecordOutput> {
    return bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, input);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-dense-'));
    databasePath = join(dir, 'facts.db');
    bus = new HookBus();
    registerHashEmbedder(bus);
    plugin = createMemoryFactsSqlitePlugin({
      databasePath,
      embedder: { hook: EMBED_HOOK },
    });
    await plugin.init({ bus, config: {} });
  });

  afterEach(async () => {
    if (reader as BetterSqliteDb | undefined) {
      if (reader.open) reader.close();
    }
    await plugin.shutdown?.();
    await rm(dir, { recursive: true, force: true });
  });

  /** A second connection to the same file, so the channel can be driven directly. */
  function openReader(): BetterSqliteDb {
    reader = openDatabase(databasePath).driver;
    return reader;
  }

  // Against an implementation that never wrote vectors (T2's state, or a
  // `record` that forgot to call `indexFactRow`): the table is empty and this
  // is 0. Against one that wrote them under the wrong id: the join in the next
  // test returns nothing.
  it('writes one vec0 row per recorded fact', async () => {
    await record({ statements: [KHALID, BOSTON, ACME] });
    const db = openReader();
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${VEC_TABLE}`).get() as { n: number };
    expect(n.n).toBe(3);
  });

  // The ordering assertion the RRF-level cases cannot make cleanly: with an
  // admitting temporal channel, fusion is flat enough that a single channel's
  // #1 does not always lead the fused list. Driving the channel directly says
  // exactly what it claims — nearest neighbour first.
  //
  // Against a plausible wrong implementation (returning `vec0`'s rows in
  // insertion order, or dropping the `ORDER BY distance`), Khalid is not first.
  it('ranks by vector distance — the nearest statement first', async () => {
    const out = await record({ statements: [KHALID, BOSTON, ACME] });
    const [khalid] = out.records;
    const db = openReader();

    const ids = denseChannel(
      db,
      { agentKey: AGENT_A, activeOnly: true, limit: 40 },
      hashVector('Khalid'),
    );
    expect(ids[0]).toBe(khalid!.id);
    expect(ids).toHaveLength(3);
  });

  // `vec0` takes `MATCH` and `k` and NOTHING else, so tenant scope, `about`
  // and `activeOnly` are all applied afterwards in application code — the step
  // that gets forgotten, and the reason the contract has a case for it too.
  it('applies tenant scope in application code, since vec0 cannot take the predicate', async () => {
    await record({ statements: [KHALID] }, ctxOf('agent-a'));
    const b = await record({ statements: [KHALID] }, ctxOf('agent-b'));
    const db = openReader();

    // Both rows are in the same vec0 table and BOTH are perfect neighbours —
    // identical text — so an unfiltered channel returns two ids here.
    const ids = denseChannel(
      db,
      { agentKey: agentScopeKey({ agentId: 'agent-b' }), activeOnly: true, limit: 40 },
      hashVector('Khalid'),
    );
    expect(ids).toEqual([b.records[0]!.id]);
  });

  it('applies the activeOnly filter after the neighbour search', async () => {
    const out = await record({ statements: [KHALID] });
    const id = out.records[0]!.id;
    await bus.call<SupersedeInput, SupersedeOutput>('memory:facts:supersede', ctxOf(), {
      ids: [id],
    });
    const db = openReader();

    expect(
      denseChannel(db, { agentKey: AGENT_A, activeOnly: true, limit: 40 }, hashVector('Khalid')),
    ).toEqual([]);
    expect(
      denseChannel(db, { agentKey: AGENT_A, activeOnly: false, limit: 40 }, hashVector('Khalid')),
    ).toEqual([id]);
  });
});

// ---------------------------------------------------------------------------
// The seam: flags, timeouts, malformed producers, rerank
// ---------------------------------------------------------------------------
describe('@ax/memory-facts-sqlite — embedder/reranker seam', () => {
  let dir: string;
  let databasePath: string;
  let bus: HookBus;
  const plugins: Array<ReturnType<typeof createMemoryFactsSqlitePlugin>> = [];

  function ctxOf(agentId = 'a', userId = 'u'): AgentContext {
    return makeAgentContext({
      sessionId: 's',
      agentId,
      userId,
      workspace: { rootPath: '/tmp' },
    });
  }

  async function start(
    config: Parameters<typeof createMemoryFactsSqlitePlugin>[0],
  ): Promise<ReturnType<typeof createMemoryFactsSqlitePlugin>> {
    const plugin = createMemoryFactsSqlitePlugin(config);
    plugins.push(plugin);
    await plugin.init({ bus, config: {} });
    return plugin;
  }

  async function record(input: RecordInput, ctx = ctxOf()): Promise<RecordOutput> {
    return bus.call<RecordInput, RecordOutput>('memory:facts:record', ctx, input);
  }
  async function recall(input: RecallInput, ctx = ctxOf()): Promise<RecallOutput> {
    return bus.call<RecallInput, RecallOutput>('memory:facts:recall', ctx, input);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-seam-'));
    databasePath = join(dir, 'facts.db');
    bus = new HookBus();
  });

  afterEach(async () => {
    for (const plugin of plugins.splice(0)) await plugin.shutdown?.();
    await rm(dir, { recursive: true, force: true });
  });

  // Against an implementation that hard-codes the flag (or never calls the
  // embedder at all), this still says 'semantic' — which is precisely the
  // failure the contract's no-producer case CANNOT distinguish, because there
  // the honest answer and the hard-coded one agree.
  it("drops 'semantic' once an embedder producer exists", async () => {
    registerHashEmbedder(bus);
    await start({ databasePath, embedder: { hook: EMBED_HOOK } });
    await record({ statements: [KHALID] });

    const out = await recall({ query: 'Khalid', limit: 10 });
    expect(out.degraded).not.toContain('semantic');
    // ...and still says 'ranking', because no reranker was registered. Both
    // halves, so the test cannot pass by reporting an empty array.
    expect(out.degraded).toEqual(['ranking']);
  });

  // THE CARD'S CENTRAL ACCEPTANCE CRITERION: "a term that only matches via the
  // dense channel". This is the entire reason a dense channel exists — if every
  // row it surfaces was already reachable lexically, the embedder, the native
  // dependency and the egress it will eventually need all buy nothing.
  //
  // It is NOT a semantic-paraphrase test, and saying so matters: the hash
  // embedder has no semantics, and a real paraphrase assertion would need a real
  // model and a network call in a unit test. What this pins is the MECHANISM —
  // a row sharing no token with the query is still reachable, via the dense
  // channel and only via it.
  //
  // The 45 distractors are load-bearing, and the number is not arbitrary: the
  // temporal channel ADMITS the `CHANNEL_LIMIT` (40) most recent rows whatever
  // the query, so with a smaller store the target arrives on the temporal
  // channel by itself and the test would pass against an engine with no dense
  // channel at all. Pushing it past 40 makes the dense channel the only route.
  it('reaches a row via the dense channel that the sparse channel cannot', async () => {
    // A controlled stand-in for an embedding model: it collapses two
    // lexically-disjoint spellings onto one vector and leaves everything else
    // where the hash puts it. Exactly the property a real embedder has and FTS5
    // structurally cannot.
    const SYNONYMS = /\b(car|automobile)\b/i;
    bus.registerService<EmbedInput, EmbedOutput>(
      EMBED_HOOK,
      'test:synonym-embedder',
      async (_ctx, input) => ({
        vectors: input.texts.map((text) =>
          hashVector(SYNONYMS.test(text) ? 'SYNONYM_CLUSTER' : text),
        ),
      }),
    );
    await start({ databasePath, embedder: { hook: EMBED_HOOK } });

    const target = await record({
      statements: [{ about: 'user', relation: 'drives', value: 'a red automobile', when: JAN }],
    });
    const targetId = target.records[0]!.id;
    for (let i = 0; i < 45; i += 1) {
      await record({
        statements: [
          { about: 'user', relation: 'stated', value: `unrelated note number ${i}`, when: JUN },
        ],
      });
    }

    const db = openDatabase(databasePath).driver;
    const scope = { agentKey: AGENT_A, activeOnly: true, limit: CHANNEL_LIMIT };
    const sparse = sparseChannel(db, { ...scope, match: buildFtsMatchQuery('car')! });
    const temporal = temporalChannel(db, scope);
    const dense = denseChannel(db, scope, hashVector('SYNONYM_CLUSTER'));
    db.close();

    // Not reachable lexically: no row contains the token.
    expect(sparse).toEqual([]);
    // Not reachable by recency either: 45 newer rows fill the temporal channel.
    expect(temporal).not.toContain(targetId);
    expect(temporal).toHaveLength(CHANNEL_LIMIT);
    // Reachable densely, and first — it is the only row on the synonym vector.
    expect(dense[0]).toBe(targetId);

    const out = await recall({ query: 'car', limit: MAX_ANSWER });
    expect(out.statements.map((s) => s.id)).toContain(targetId);
    expect(out.degraded).not.toContain('semantic');
  });

  // The other half of the pair, and what makes the one above mean something:
  // the SAME store and the SAME query, with no embedder, must NOT reach the
  // target — it is in no channel at all. Without this, the test above could
  // pass against an engine whose "dense channel" simply returned everything.
  it('cannot reach that row at all when no embedder is configured', async () => {
    await start({ databasePath });

    const target = await record({
      statements: [{ about: 'user', relation: 'drives', value: 'a red automobile', when: JAN }],
    });
    const targetId = target.records[0]!.id;
    for (let i = 0; i < 45; i += 1) {
      await record({
        statements: [
          { about: 'user', relation: 'stated', value: `unrelated note number ${i}`, when: JUN },
        ],
      });
    }

    const out = await recall({ query: 'car', limit: MAX_ANSWER });
    expect(out.statements.map((s) => s.id)).not.toContain(targetId);
    expect(out.degraded).toContain('semantic');
  });

  // The ordinary production sequence, not an edge case: a deployment runs for
  // a while with no provider, the provider card lands, and the next recall
  // queries a vec0 table that is still empty. A `MATCH ... k = 160` over zero
  // rows must be an empty channel, not an error — otherwise the first recall
  // after the provider ships fails with `store-unavailable` until someone
  // runs `reindex`.
  it('queries an empty vector table without failing, when the embedder arrives after the facts', async () => {
    await start({ databasePath, embedder: { hook: EMBED_HOOK } });
    await record({ statements: [KHALID, BOSTON] });
    registerHashEmbedder(bus);

    const out = await recall({ query: 'Khalid', limit: 10 });
    // The embed call succeeded, so the dense channel DID run — it just had
    // nothing to find. That is not a degradation.
    expect(out.degraded).toEqual(['ranking']);
    expect(out.statements[0]?.value).toBe('Khalid');
  });

  it('asks the embedder for `document` at record and `query` at recall, with no vendor vocabulary', async () => {
    const { calls } = registerHashEmbedder(bus);
    await start({ databasePath, embedder: { hook: EMBED_HOOK, model: 'some-model-v1' } });
    await record({ statements: [KHALID] });
    await recall({ query: 'Khalid', limit: 10 });

    expect(calls.map((c) => c.task)).toEqual(['document', 'query']);
    expect(calls[0]!.texts).toEqual([factStatementText('user', 'likes_artist', 'Khalid')]);
    expect(calls[1]!.texts).toEqual(['Khalid']);
    // The configured model is forwarded; nothing else is. Appendix B: no
    // `cosine`, no dimension count, no `vec0`, no provider name on the wire.
    for (const call of calls) {
      expect(Object.keys(call).sort()).toEqual(['model', 'task', 'texts']);
      expect(call.model).toBe('some-model-v1');
    }
  });

  // A timeout DEGRADES; it never fails the call. Against an implementation
  // that awaited the producer unconditionally, this test hangs until vitest
  // kills it — which is the failure mode worth pinning, because in production
  // it is a recall that never returns.
  it('degrades when the embedder never answers, instead of hanging the recall', async () => {
    bus.registerService<EmbedInput, EmbedOutput>(
      EMBED_HOOK,
      'test:hanging-embedder',
      () => new Promise<EmbedOutput>(() => {}),
    );
    await start({ databasePath, embedder: { hook: EMBED_HOOK } });
    // Even `record` must survive it — a store write may not be held hostage by
    // an optional enrichment.
    await record({ statements: [KHALID, BOSTON] });

    const started = Date.now();
    const out = await recall({ query: 'Khalid', limit: 10 });
    expect(out.degraded).toContain('semantic');
    // The answer is still real: sparse + temporal ran, and the relevant row
    // still leads.
    expect(out.statements[0]?.value).toBe('Khalid');
    // Two budgeted calls at most (record's embed, recall's embed), so this is
    // comfortably inside a per-call budget of 1.5s and nowhere near a hang.
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 20_000);

  it("degrades when the embedder throws, and doesn't lose the fact write", async () => {
    bus.registerService<EmbedInput, EmbedOutput>(EMBED_HOOK, 'test:angry-embedder', async () => {
      throw new Error('provider said no');
    });
    await start({ databasePath, embedder: { hook: EMBED_HOOK } });
    await record({ statements: [KHALID] });

    const out = await recall({ query: 'Khalid', limit: 10 });
    expect(out.degraded).toContain('semantic');
    expect(out.statements.map((s) => s.value)).toEqual(['Khalid']);
  });

  // A producer that RESOLVES TO `null` — the one nullish value the guard did
  // not check for. `HookBus.call` returns a handler's raw value when the hook
  // declares no `returns` schema (`hook-bus.ts`, `return result as O`), and no
  // realistic provider will declare one, so `null` arrives here intact. The
  // guard read `out === undefined`, which is `false` for `null`, so control
  // fell through to `out.vectors` — a property access on `null`.
  //
  // That TypeError is thrown from OUTSIDE `inStore` (record awaits the embed
  // before opening the store region), so it escapes the handler and `HookBus`
  // wraps it as `code: 'unknown'`: the fact is never written. One misconfigured
  // provider becomes a deployment-wide WRITE OUTAGE — the precise failure the
  // dimensionality check below exists to prevent, reachable through a different
  // door. The throwing-embedder test above does not catch it, because a handler
  // that throws and a handler that returns `null` take different paths.
  //
  // Latent until a provider ships (nothing registers these hooks yet), but the
  // guard is in this card, so the fix is too.
  it('degrades when a producer resolves to null, rather than failing the write', async () => {
    bus.registerService<EmbedInput, EmbedOutput>(
      EMBED_HOOK,
      'test:null-embedder',
      async () => null as unknown as EmbedOutput,
    );
    bus.registerService<RerankInput, RerankOutput>(
      RERANK_HOOK,
      'test:null-reranker',
      async () => null as unknown as RerankOutput,
    );
    await start({
      databasePath,
      embedder: { hook: EMBED_HOOK },
      reranker: { hook: RERANK_HOOK },
    });

    // The write survives: no vector, but the fact is stored.
    await record({ statements: [KHALID] });

    const out = await recall({ query: 'Khalid', limit: 10 });
    expect(out.statements.map((s) => s.value)).toEqual(['Khalid']);
    expect(out.degraded).toContain('semantic');
    expect(out.degraded).toContain('ranking');
  });

  // A provider configured for the wrong model returns the RIGHT NUMBER of
  // vectors at the wrong dimensionality, which is the shape an arity check
  // waves through. Against an implementation that only counted vectors, the
  // 3-float array reaches `vectorToBlob`, throws inside the write
  // transaction, and every `record` in the deployment starts failing with
  // `store-unavailable` — one misconfigured provider taking down the store.
  it('degrades on a wrong-dimensionality answer instead of failing the write', async () => {
    bus.registerService<EmbedInput, EmbedOutput>(EMBED_HOOK, 'test:wrong-dimensions', async () => ({
      vectors: [[1, 2, 3]],
    }));
    await start({ databasePath, embedder: { hook: EMBED_HOOK } });

    await record({ statements: [KHALID] });
    const out = await recall({ query: 'Khalid', limit: 10 });
    expect(out.degraded).toContain('semantic');
    expect(out.statements.map((s) => s.value)).toEqual(['Khalid']);
  });

  it('degrades when the embedder returns fewer vectors than texts', async () => {
    bus.registerService<EmbedInput, EmbedOutput>(EMBED_HOOK, 'test:short-answer', async () => ({
      vectors: [],
    }));
    await start({ databasePath, embedder: { hook: EMBED_HOOK } });
    await record({ statements: [KHALID] });
    const out = await recall({ query: 'Khalid', limit: 10 });
    expect(out.degraded).toContain('semantic');
  });

  // The rerank is the one producer whose effect is directly visible in the
  // answer, so this is the strongest available end-to-end assertion about it:
  // a reranker that prefers the row RRF ranked last must move it to the front.
  // DAY ONE, and therefore not an edge case: an empty store, a query, and a
  // healthy configured reranker. With nothing to rank the reranker is never
  // called, so a naive `scores !== undefined` reports it as DEGRADED on every
  // recall until the first fact lands — design §5's first walk step is exactly
  // this state. A flag that fires when nothing is wrong is the opposite of
  // §4.4's "degraded mode is a signal, not a quieter answer".
  //
  // The `calls` counter is what makes this more than an assertion about a
  // string: it proves the reranker really was not invoked, so the absent flag
  // is honest rather than hard-coded.
  it('does not claim degraded ranking when there was nothing to rank', async () => {
    let calls = 0;
    bus.registerService<RerankInput, RerankOutput>(
      RERANK_HOOK,
      'test:healthy-reranker',
      async (_ctx, input) => {
        calls += 1;
        return { scores: input.documents.map(() => 1) };
      },
    );
    await start({ databasePath, reranker: { hook: RERANK_HOOK } });

    const empty = await recall({ query: 'Khalid', limit: 10 });
    expect(empty.statements).toEqual([]);
    expect(calls).toBe(0);
    expect(empty.degraded).not.toContain('ranking');

    // ...and it still reports honestly once there IS something to rank, so the
    // fix cannot be "never raise the flag".
    await record({ statements: [KHALID] });
    const found = await recall({ query: 'Khalid', limit: 10 });
    expect(found.statements).toHaveLength(1);
    expect(calls).toBe(1);
    expect(found.degraded).not.toContain('ranking');
  });

  it('lets the reranker reorder the fused answer, and drops the ranking flag', async () => {
    const seen: RerankInput[] = [];
    bus.registerService<RerankInput, RerankOutput>(
      RERANK_HOOK,
      'test:reverser',
      async (_ctx, input) => {
        seen.push(input);
        // Score by fused POSITION ascending, i.e. the reranker prefers
        // whatever RRF liked least. The assertion below therefore cannot be
        // satisfied by the fused order it is meant to override.
        return { scores: input.documents.map((_doc, index) => index) };
      },
    );
    await start({ databasePath, reranker: { hook: RERANK_HOOK } });
    await record({ statements: [KHALID, BOSTON, ACME] });

    const fused = await recall({ query: 'Khalid', limit: 10 });
    expect(fused.degraded).toEqual(['semantic']);
    // The fused order puts Khalid first (the contract pins this); the
    // reranker's reverse scoring must therefore put it LAST.
    expect(fused.statements[0]?.value).not.toBe('Khalid');
    expect(fused.statements.at(-1)?.value).toBe('Khalid');
    // The pool it was handed is statement text, not JSON and not raw columns.
    expect(seen[0]!.query).toBe('Khalid');
    expect(seen[0]!.documents[0]).toBe(factStatementText('user', 'likes_artist', 'Khalid'));
  });

  it('keeps fused order and raises ranking when the reranker times out', async () => {
    bus.registerService<RerankInput, RerankOutput>(
      RERANK_HOOK,
      'test:hanging-reranker',
      () => new Promise<RerankOutput>(() => {}),
    );
    await start({ databasePath, reranker: { hook: RERANK_HOOK } });
    await record({ statements: [KHALID, BOSTON, ACME] });

    const out = await recall({ query: 'Khalid', limit: 10 });
    expect(out.degraded).toContain('ranking');
    expect(out.statements[0]?.value).toBe('Khalid');
  }, 20_000);

  it('ignores a reranker that scores only some of the pool, rather than reordering on invented zeros', async () => {
    bus.registerService<RerankInput, RerankOutput>(
      RERANK_HOOK,
      'test:partial',
      async () => ({ scores: [1] }),
    );
    await start({ databasePath, reranker: { hook: RERANK_HOOK } });
    await record({ statements: [KHALID, BOSTON, ACME] });

    const out = await recall({ query: 'Khalid', limit: 10 });
    expect(out.degraded).toContain('ranking');
    expect(out.statements[0]?.value).toBe('Khalid');
  });

  // `bootstrap.ts`'s `verifyCalls` skips `optionalCalls`, which is the whole
  // reason this seam can ship with no provider — but only if the hooks are
  // actually declared there and not in `calls`.
  it('declares each configured producer under optionalCalls, with a real degradation note', async () => {
    const plugin = createMemoryFactsSqlitePlugin({
      databasePath,
      embedder: { hook: EMBED_HOOK },
      reranker: { hook: RERANK_HOOK },
    });
    expect(plugin.manifest.calls).toEqual([]);
    expect(plugin.manifest.optionalCalls?.map((c) => c.hook)).toEqual([EMBED_HOOK, RERANK_HOOK]);
    for (const entry of plugin.manifest.optionalCalls ?? []) {
      // "a real, specific degradation string" — it has to name what the caller
      // actually loses, which is the degraded flag.
      expect(entry.degradation).toMatch(/degraded: \['(semantic|ranking)'\]/);
    }
  });

  it('declares nothing optional when no producer is configured', async () => {
    const plugin = createMemoryFactsSqlitePlugin({ databasePath });
    expect(plugin.manifest.optionalCalls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reindex — the backfill half
// ---------------------------------------------------------------------------
describe('@ax/memory-facts-sqlite — reindex backfill', () => {
  let dir: string;
  let databasePath: string;
  let bus: HookBus;
  const plugins: Array<ReturnType<typeof createMemoryFactsSqlitePlugin>> = [];
  const toClose: BetterSqliteDb[] = [];

  function ctxOf(agentId = 'a'): AgentContext {
    return makeAgentContext({
      sessionId: 's',
      agentId,
      userId: 'u',
      workspace: { rootPath: '/tmp' },
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-backfill-'));
    databasePath = join(dir, 'facts.db');
    bus = new HookBus();
  });

  afterEach(async () => {
    for (const plugin of plugins.splice(0)) await plugin.shutdown?.();
    for (const db of toClose.splice(0)) if (db.open) db.close();
    await rm(dir, { recursive: true, force: true });
  });

  // The pre-TASK-434 store: rows exist, no shadow tables ever existed, so no
  // row is reachable by the sparse channel. Without backfill they stay
  // invisible to `query` forever — present in the store, unfindable by search.
  it('indexes facts recorded before the shadow tables existed', async () => {
    const legacy = new BetterSqlite3(databasePath);
    legacy.exec(`
      CREATE TABLE ${TABLE} (
        id TEXT PRIMARY KEY, agent_key TEXT NOT NULL, about TEXT NOT NULL,
        relation TEXT NOT NULL, value TEXT NOT NULL, slot TEXT,
        provenance TEXT NOT NULL CHECK(provenance IN ('extracted','agent','human')),
        owner_user_id TEXT, conversation_id TEXT, valid_start TEXT NOT NULL,
        valid_end TEXT NOT NULL DEFAULT '${INFINITY_SENTINEL}',
        transaction_time TEXT NOT NULL, closed_by TEXT
      );`);
    legacy
      .prepare(
        `INSERT INTO ${TABLE} (id, agent_key, about, relation, value, provenance,
           valid_start, valid_end, transaction_time)
         VALUES (?, ?, 'user', 'likes_artist', 'Khalid', 'extracted', ?, ?, ?)`,
      )
      .run('legacy-khalid', AGENT_A, JAN, INFINITY_SENTINEL, JAN);
    legacy.close();

    const plugin = createMemoryFactsSqlitePlugin({ databasePath });
    plugins.push(plugin);
    await plugin.init({ bus, config: {} });

    // Before the drain, the sparse channel has nothing to find: the row is
    // only reachable through the temporal channel, which admits everything —
    // so `statements` is non-empty either way and ORDER is not the tell here.
    const before = openDatabase(databasePath);
    toClose.push(before.driver);
    expect(
      (before.driver.prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE}`).get() as { n: number }).n,
    ).toBe(0);
    before.driver.close();

    await bus.call<ReindexInput, ReindexOutput>('memory:facts:reindex', ctxOf(), {});

    const after = openDatabase(databasePath);
    toClose.push(after.driver);
    const row = after.driver
      .prepare(`SELECT id FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH 'khalid'`)
      .get() as { id: string } | undefined;
    expect(row?.id).toBe('legacy-khalid');
  });

  // The other half of the same gap: a store that ran without an embedder has
  // rows with no vector, and nothing else will ever go back for them.
  it('backfills missing vectors once an embedder producer appears', async () => {
    // Configured with an embedder hook from the start, but nothing registered
    // at it yet — exactly what a deployment looks like before the provider
    // card lands.
    const plugin = createMemoryFactsSqlitePlugin({
      databasePath,
      embedder: { hook: EMBED_HOOK },
    });
    plugins.push(plugin);
    await plugin.init({ bus, config: {} });
    await bus.call<RecordInput, RecordOutput>('memory:facts:record', ctxOf(), {
      statements: [KHALID, BOSTON],
    });

    const mid = openDatabase(databasePath);
    toClose.push(mid.driver);
    expect(
      (mid.driver.prepare(`SELECT COUNT(*) AS n FROM ${VEC_TABLE}`).get() as { n: number }).n,
    ).toBe(0);
    mid.driver.close();

    registerHashEmbedder(bus);
    await bus.call<ReindexInput, ReindexOutput>('memory:facts:reindex', ctxOf(), {});

    const after = openDatabase(databasePath);
    toClose.push(after.driver);
    expect(
      (after.driver.prepare(`SELECT COUNT(*) AS n FROM ${VEC_TABLE}`).get() as { n: number }).n,
    ).toBe(2);
    // And the backfilled vectors are the right ones — 384 floats keyed to the
    // fact's statement text, not zeros or a shared placeholder.
    const ids = denseChannel(
      after.driver,
      { agentKey: AGENT_A, activeOnly: true, limit: 40 },
      hashVector('Khalid'),
    );
    const khalidRow = after.driver
      .prepare(`SELECT id FROM ${TABLE} WHERE value = 'Khalid'`)
      .get() as { id: string };
    expect(ids[0]).toBe(khalidRow.id);
  });

  // Backfill must be idempotent for the same reason `indexFactRow` is: it runs
  // on every `reindex`, and the second run must not double-index anything.
  it('is idempotent — a second reindex changes nothing', async () => {
    registerHashEmbedder(bus);
    const plugin = createMemoryFactsSqlitePlugin({
      databasePath,
      embedder: { hook: EMBED_HOOK },
    });
    plugins.push(plugin);
    await plugin.init({ bus, config: {} });
    await bus.call<RecordInput, RecordOutput>('memory:facts:record', ctxOf(), {
      statements: [KHALID, BOSTON, ACME],
    });

    await bus.call<ReindexInput, ReindexOutput>('memory:facts:reindex', ctxOf(), {});
    await bus.call<ReindexInput, ReindexOutput>('memory:facts:reindex', ctxOf(), {});

    const after = openDatabase(databasePath);
    toClose.push(after.driver);
    expect(
      (after.driver.prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE}`).get() as { n: number }).n,
    ).toBe(3);
    expect(
      (after.driver.prepare(`SELECT COUNT(*) AS n FROM ${VEC_TABLE}`).get() as { n: number }).n,
    ).toBe(3);
  });

  // `clear` is a "forget this", and a shadow table is still storage.
  it('leaves no searchable text behind after memory:facts:clear', async () => {
    registerHashEmbedder(bus);
    const plugin = createMemoryFactsSqlitePlugin({
      databasePath,
      embedder: { hook: EMBED_HOOK },
    });
    plugins.push(plugin);
    await plugin.init({ bus, config: {} });
    await bus.call<RecordInput, RecordOutput>('memory:facts:record', ctxOf(), {
      statements: [KHALID],
    });
    // A second tenant, to prove `clear` is still scoped: forgetting agent A
    // must not scrub agent B's index rows.
    await bus.call<RecordInput, RecordOutput>('memory:facts:record', ctxOf('b'), {
      statements: [BOSTON],
    });

    await bus.call<ClearInput, void>('memory:facts:clear', ctxOf(), {});

    const after = openDatabase(databasePath);
    toClose.push(after.driver);
    expect(
      (
        after.driver.prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE} WHERE value = 'Khalid'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(
      (after.driver.prepare(`SELECT COUNT(*) AS n FROM ${VEC_TABLE}`).get() as { n: number }).n,
    ).toBe(1);
    expect(
      (
        after.driver.prepare(`SELECT COUNT(*) AS n FROM ${FTS_TABLE} WHERE value = 'Boston'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });
});

// A sanity check on the fixture itself: the hash embedder really does produce
// what the store requires, so a failure above is about the store and not about
// the test double.
describe('@ax/memory-facts-sqlite — hash embedder fixture', () => {
  it('produces normalized vectors of exactly EMBEDDING_DIMENSIONS floats', () => {
    const vector = hashVector('user likes artist: Khalid');
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vector.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
  });
});
