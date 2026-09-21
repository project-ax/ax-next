// The Cohere rerank driver, driven through the bus.
//
// The two tests that carry this file are the SHUFFLE one (Cohere answers
// sorted by score, so scores must be placed by `index` and never by iteration
// order) and the SHORT-ANSWER one (a short answer is refused outright, not
// padded with zeros). Everything else is the failure table.

import { describe, expect, it } from 'vitest';
import type { HookBus } from '@ax/core';
import {
  busWithPlugin,
  ctx,
  ctxForUser,
  fetchStub,
  jsonResponse,
  neverResponds,
  rawJsonResponse,
  type FetchStub,
  type RecordedCall,
} from './harness.js';
import type { RerankInput, RerankOutput } from '../wire.js';
import type { EmbeddingsConfig } from '../plugin.js';

const TOKEN = 'cohere-test-key';
const DOCS = ['d0', 'd1', 'd2', 'd3'];

interface CohereRequest {
  model: string;
  query: string;
  documents: string[];
  top_n: number;
}

function requestOf(call: RecordedCall): CohereRequest {
  return call.body as CohereRequest;
}

function configWith(stub: FetchStub, extra: Partial<EmbeddingsConfig> = {}): EmbeddingsConfig {
  return {
    rerank: { provider: 'cohere', credentialRef: 'provider:cohere' },
    fetchImpl: stub.impl,
    ...extra,
  };
}

function rerank(bus: HookBus, input: RerankInput, who = ctx): Promise<RerankOutput | undefined> {
  return bus.call<RerankInput, RerankOutput | undefined>('embeddings:rerank', who, input);
}

/** What Cohere actually sends: results sorted by score, each carrying its original index. */
const SHUFFLED_RESULTS = [
  { index: 2, relevance_score: 0.9 },
  { index: 0, relevance_score: 0.7 },
  { index: 3, relevance_score: 0.4 },
  { index: 1, relevance_score: 0.1 },
];

describe('remote rerank — the happy path', () => {
  it('places scores in DOCUMENT order, not the order the provider returned them', async () => {
    const stub = fetchStub(() => jsonResponse({ results: SHUFFLED_RESULTS }));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    const out = await rerank(bus, { query: 'q', documents: DOCS });

    // The provider's own order is [0.9, 0.7, 0.4, 0.1]. A driver that mapped
    // over `results` instead of indexing by `result.index` would return that,
    // and every downstream rank would be silently wrong.
    expect(out?.scores).toEqual([0.7, 0.1, 0.9, 0.4]);
    expect(out?.scores).not.toEqual(SHUFFLED_RESULTS.map((r) => r.relevance_score));
  });

  it('posts to the endpoint table URL with top_n, the default model and the Bearer header', async () => {
    const stub = fetchStub(() => jsonResponse({ results: SHUFFLED_RESULTS }));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await rerank(bus, { query: 'hello', documents: DOCS });

    const call = stub.calls[0];
    expect(stub.calls).toHaveLength(1);
    expect(call?.url).toBe('https://api.cohere.com/v2/rerank');
    expect(call?.method).toBe('POST');
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.url).not.toContain(TOKEN);
    // `top_n` is sent explicitly: the default is provider-side and has changed
    // before, and a truncated result set is exactly the short answer we refuse.
    expect(requestOf(call as RecordedCall).top_n).toBe(DOCS.length);
    expect(requestOf(call as RecordedCall).model).toBe('rerank-v4.0-pro');
    expect(requestOf(call as RecordedCall).query).toBe('hello');
    expect(requestOf(call as RecordedCall).documents).toEqual(DOCS);
  });

  it('uses the configured model over the endpoint default, and a payload model over both', async () => {
    const stub = fetchStub(() => jsonResponse({ results: SHUFFLED_RESULTS }));
    const bus = await busWithPlugin(
      configWith(stub, {
        rerank: { provider: 'cohere', credentialRef: 'provider:cohere', model: 'rerank-v3.5' },
      }),
      { credential: TOKEN },
    );

    await rerank(bus, { query: 'q', documents: DOCS });
    expect(requestOf(stub.calls[0] as RecordedCall).model).toBe('rerank-v3.5');

    await rerank(bus, { query: 'q', documents: DOCS, model: 'rerank-v4.0-lite' });
    expect(requestOf(stub.calls[1] as RecordedCall).model).toBe('rerank-v4.0-lite');
  });

  it('short-circuits an empty document list with no fetch at all', async () => {
    const stub = fetchStub(() => jsonResponse({ results: [] }));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(rerank(bus, { query: 'q', documents: [] })).resolves.toEqual({ scores: [] });
    expect(stub.calls).toHaveLength(0);
  });
});

describe('remote rerank — full coverage or nothing', () => {
  // NOTE ON WHAT THIS ACTUALLY PINS (TASK-487 mutation pass). It pins the
  // OUTCOME — a short answer is refused, never padded — and that outcome is
  // worth pinning, because `dem-memory` padded and we deliberately do not.
  // What it does NOT pin is WHICH of `cohereRerank`'s three guards refuses it:
  // deleting the arity check leaves this test green, because the missing slot
  // then survives as a hole and `validateScores` catches it instead. Same for
  // the `seen` check and the duplicated-index case below. See the comment at
  // the end of `cohereRerank`.
  it('refuses a short answer instead of padding the missing slot with zero', async () => {
    const stub = fetchStub(() =>
      jsonResponse({ results: SHUFFLED_RESULTS.filter((r) => r.index !== 1) }),
    );
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    const out = await rerank(bus, { query: 'q', documents: DOCS });

    // `dem-memory`'s reranker would have answered `[0.7, 0, 0.9, 0.4]` here —
    // document 1 sinks to the bottom on a zero the provider never assigned it.
    // We answer nothing, and the caller keeps its fused order.
    expect(out).toBeUndefined();
  });

  const badResponses: [string, () => Response][] = [
    ['a null body', () => jsonResponse(null)],
    ['a body with no results', () => jsonResponse({})],
    ['results that is not an array', () => jsonResponse({ results: { 0: 0.5 } })],
    [
      'a duplicated index',
      () =>
        jsonResponse({
          results: [
            { index: 0, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.8 },
            { index: 2, relevance_score: 0.7 },
            { index: 3, relevance_score: 0.6 },
          ],
        }),
    ],
    [
      'an out-of-range index',
      () =>
        jsonResponse({
          results: SHUFFLED_RESULTS.map((r) => (r.index === 3 ? { ...r, index: 9 } : r)),
        }),
    ],
    [
      'a negative index',
      () =>
        jsonResponse({
          results: SHUFFLED_RESULTS.map((r) => (r.index === 3 ? { ...r, index: -1 } : r)),
        }),
    ],
    [
      'a fractional index',
      () =>
        jsonResponse({
          results: SHUFFLED_RESULTS.map((r) => (r.index === 3 ? { ...r, index: 1.5 } : r)),
        }),
    ],
    [
      'a non-number relevance_score',
      () =>
        jsonResponse({
          results: SHUFFLED_RESULTS.map((r) =>
            r.index === 3 ? { ...r, relevance_score: '0.4' } : r,
          ),
        }),
    ],
    [
      'a null relevance_score',
      () =>
        jsonResponse({
          results: SHUFFLED_RESULTS.map((r) =>
            r.index === 3 ? { ...r, relevance_score: null } : r,
          ),
        }),
    ],
    [
      'a non-finite relevance_score',
      () =>
        rawJsonResponse({
          results: SHUFFLED_RESULTS.map((r) =>
            r.index === 3 ? { ...r, relevance_score: Number.NaN } : r,
          ),
        }),
    ],
    ['more results than documents', () => jsonResponse({ results: [...SHUFFLED_RESULTS, { index: 0, relevance_score: 0.2 }] })],
    ['HTTP 429', () => jsonResponse({ message: 'slow down' }, 429)],
    ['HTTP 500', () => jsonResponse({ message: 'boom' }, 500)],
    ['a body that is not JSON', () => new Response('<html>gateway</html>', { status: 200 })],
  ];

  it.each(badResponses)('resolves to undefined for %s', async (_label, make) => {
    const stub = fetchStub(() => make());
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(rerank(bus, { query: 'q', documents: DOCS })).resolves.toBeUndefined();
  });

  it('resolves to undefined when fetch itself rejects', async () => {
    const stub = fetchStub(() => Promise.reject(new Error('ECONNRESET')));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(rerank(bus, { query: 'q', documents: DOCS })).resolves.toBeUndefined();
  });

  it('resolves to undefined when the request outlives timeoutMs', async () => {
    const stub = fetchStub((call) => neverResponds(call.signal));
    const bus = await busWithPlugin(configWith(stub, { timeoutMs: 20 }), { credential: TOKEN });

    await expect(rerank(bus, { query: 'q', documents: DOCS })).resolves.toBeUndefined();
    expect(stub.calls[0]?.signal?.aborted).toBe(true);
  });
});

describe('remote rerank — no credential means no call', () => {
  it.each([
    ['credentials:get is unregistered', undefined],
    ['credentials:get returns an empty string', ''],
  ])('resolves to undefined when %s', async (_label, credential) => {
    const stub = fetchStub(() => jsonResponse({ results: SHUFFLED_RESULTS }));
    const bus = await busWithPlugin(
      configWith(stub),
      credential === undefined ? {} : { credential },
    );

    await expect(rerank(bus, { query: 'q', documents: DOCS })).resolves.toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });

  it('never dials out for a ctx with no userId', async () => {
    const stub = fetchStub(() => jsonResponse({ results: SHUFFLED_RESULTS }));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(
      rerank(bus, { query: 'q', documents: DOCS }, ctxForUser('')),
    ).resolves.toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses a path-traversing payload model without dialing out', async () => {
    const stub = fetchStub(() => jsonResponse({ results: SHUFFLED_RESULTS }));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(
      rerank(bus, { query: 'q', documents: DOCS, model: '../../../x' }),
    ).resolves.toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });
});

describe('remote rerank — a non-2xx is not an answer, however well-formed its body', () => {
  // The rerank half of the same TASK-487 mutation finding — see the matching
  // block in `remote-embed.test.ts`. Every non-2xx fixture in the failure
  // table above carries a body that ALSO fails the shape check, so deleting
  // `if (!response.ok)` left the suite green. A 429 from Cohere that still
  // carries a usable `results` array is the case that tells the two guards
  // apart, and accepting it would let a throttled response silently reorder
  // somebody's recall.
  it.each([
    ['403', 403],
    ['429', 429],
    ['500', 500],
    ['503', 503],
  ])('resolves to undefined for HTTP %s with a valid results body', async (_label, status) => {
    const stub = fetchStub(() => jsonResponse({ results: SHUFFLED_RESULTS }, status));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(rerank(bus, { query: 'q', documents: DOCS })).resolves.toBeUndefined();
    expect(stub.calls).toHaveLength(1);
  });

  it('accepts that same body at 200, so the fixture itself is not the reason', async () => {
    const stub = fetchStub(() => jsonResponse({ results: SHUFFLED_RESULTS }, 200));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(rerank(bus, { query: 'q', documents: DOCS })).resolves.toEqual({
      scores: [0.7, 0.1, 0.9, 0.4],
    });
  });
});
