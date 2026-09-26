// The OpenRouter embed driver, driven through the bus exactly as
// `@ax/memory-facts-sqlite` drives it — a stub `fetch` is the only thing that
// is not real.
//
// Two things every failure case here asserts, and they are different claims:
// `resolves` (we did not throw — the consumer's `callProducer` degrades on a
// nullish answer but a throw is a blunter instrument) and `toBeUndefined` (we
// did not invent an answer).

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
import type { EmbedInput, EmbedOutput } from '../wire.js';
import type { EmbeddingsConfig } from '../plugin.js';

const TOKEN = 'sk-or-test-token';
const DIMENSIONS = 4;

const EXPECTED_URL = 'https://openrouter.ai/api/v1/embeddings';
const DEFAULT_MODEL = 'google/gemini-embedding-001:nitro';

interface OpenRouterEmbedRequest {
  model: string;
  input: string[];
  dimensions: number;
  encoding_format: string;
}

function requestOf(call: RecordedCall): OpenRouterEmbedRequest {
  return call.body as OpenRouterEmbedRequest;
}

/** `t7` ⇒ `[7, 0, 0, 0]`: a vector that names the text it belongs to. */
function vectorFor(content: string): number[] {
  const n = Number(content.slice(1));
  return [n, 0, 0, 0];
}

/** `data[]` entries IN INPUT ORDER, each carrying its own `index`. */
function dataFor(call: RecordedCall): unknown {
  return {
    data: requestOf(call).input.map((content, index) => ({
      embedding: vectorFor(content),
      index,
      object: 'embedding',
    })),
    model: requestOf(call).model,
  };
}

function texts(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `t${i}`);
}

function configWith(stub: FetchStub, extra: Partial<EmbeddingsConfig> = {}): EmbeddingsConfig {
  return {
    dimensions: DIMENSIONS,
    embed: { provider: 'openrouter', credentialRef: 'provider:openrouter' },
    fetchImpl: stub.impl,
    ...extra,
  };
}

function embed(bus: HookBus, input: EmbedInput, who = ctx): Promise<EmbedOutput | undefined> {
  return bus.call<EmbedInput, EmbedOutput | undefined>('embeddings:embed', who, input);
}

describe('remote embed — the happy path', () => {
  it('returns one vector per text, in input order', async () => {
    const stub = fetchStub((call) => jsonResponse(dataFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    const out = await embed(bus, { texts: texts(3), task: 'document' });

    expect(out?.vectors).toEqual([
      [0, 0, 0, 0],
      [1, 0, 0, 0],
      [2, 0, 0, 0],
    ]);
    expect(out?.vectors.every((v) => v.length === DIMENSIONS)).toBe(true);
    expect(out?.vectors.flat().every((n) => Number.isFinite(n))).toBe(true);
  });

  it('posts to exactly the endpoint table URL', async () => {
    const stub = fetchStub((call) => jsonResponse(dataFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await embed(bus, { texts: texts(1), task: 'document' });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(EXPECTED_URL);
    expect(stub.calls[0]?.method).toBe('POST');
  });

  it('sends the credential as a Bearer header and NOWHERE else', async () => {
    const stub = fetchStub((call) => jsonResponse(dataFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await embed(bus, { texts: texts(1), task: 'document' });

    const call = stub.calls[0];
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers['content-type']).toBe('application/json');
    // A token in a URL is a token in every proxy log, every access log and
    // every error report along the way. It belongs in the header only.
    expect(call?.url).not.toContain(TOKEN);
    expect(call?.rawBody).not.toContain(TOKEN);
  });

  it.each(['document' as const, 'query' as const])(
    'sends EXACTLY {model, input, dimensions, encoding_format} for task %s — no input_type, no task field',
    async (task) => {
      const stub = fetchStub((call) => jsonResponse(dataFor(call)));
      const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

      await embed(bus, { texts: texts(2), task });

      const body = stub.calls[0]?.body as Record<string, unknown>;
      // A deep-equal key-set pin: a driver that added `input_type` or
      // `task_type` here risks a 400 that would take the whole dense channel
      // dark on a field OpenRouter's Google route may not map. See the
      // comment on `openrouterEmbed` in `remote.ts`.
      expect(body).toEqual({
        model: DEFAULT_MODEL,
        input: texts(2),
        dimensions: DIMENSIONS,
        encoding_format: 'float',
      });
    },
  );

  it('asks for the configured dimensions', async () => {
    const stub = fetchStub((call) => jsonResponse(dataFor(call)));
    const bus = await busWithPlugin(configWith(stub, { dimensions: 4 }), { credential: TOKEN });

    await embed(bus, { texts: texts(1), task: 'document' });

    expect(requestOf(stub.calls[0] as RecordedCall).dimensions).toBe(4);
  });

  it('uses the default model when none is configured or supplied', async () => {
    const stub = fetchStub((call) => jsonResponse(dataFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await embed(bus, { texts: texts(1), task: 'document' });

    expect(requestOf(stub.calls[0] as RecordedCall).model).toBe(DEFAULT_MODEL);
  });

  it('uses a payload model over the endpoint default', async () => {
    const stub = fetchStub((call) => jsonResponse(dataFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await embed(bus, {
      texts: texts(1),
      task: 'document',
      model: 'openai/text-embedding-3-small',
    });

    expect(requestOf(stub.calls[0] as RecordedCall).model).toBe('openai/text-embedding-3-small');
  });

  it('accepts a vendor/model:variant id', async () => {
    const stub = fetchStub((call) => jsonResponse(dataFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await embed(bus, { texts: texts(1), task: 'document', model: 'voyageai/rerank-2.5:nitro' });

    expect(requestOf(stub.calls[0] as RecordedCall).model).toBe('voyageai/rerank-2.5:nitro');
  });
});

describe('remote embed — out-of-order and malformed index placement', () => {
  it('places a shuffled response by index, not by iteration order', async () => {
    const stub = fetchStub(() =>
      jsonResponse({
        data: [
          { index: 2, embedding: [2, 0, 0, 0], object: 'embedding' },
          { index: 0, embedding: [0, 0, 0, 0], object: 'embedding' },
          { index: 1, embedding: [1, 0, 0, 0], object: 'embedding' },
        ],
      }),
    );
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    const out = await embed(bus, { texts: texts(3), task: 'document' });

    expect(out?.vectors).toEqual([
      [0, 0, 0, 0],
      [1, 0, 0, 0],
      [2, 0, 0, 0],
    ]);
  });

  it('resolves to undefined for a duplicated index', async () => {
    const stub = fetchStub(() =>
      jsonResponse({
        data: [
          { index: 0, embedding: [0, 0, 0, 0] },
          { index: 0, embedding: [9, 0, 0, 0] },
        ],
      }),
    );
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toBeUndefined();
  });

  it('resolves to undefined for a missing index (a hole)', async () => {
    const stub = fetchStub(() =>
      jsonResponse({
        data: [{ index: 0, embedding: [0, 0, 0, 0] }],
      }),
    );
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toBeUndefined();
  });

  it('resolves to undefined for a base64-string embedding instead of an array', async () => {
    const stub = fetchStub(() =>
      jsonResponse({
        data: [
          { index: 0, embedding: 'AACAPwAAAEA=' },
          { index: 1, embedding: [1, 0, 0, 0] },
        ],
      }),
    );
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toBeUndefined();
  });
});

describe('remote embed — chunking', () => {
  it('splits 130 texts into 64/64/2 and concatenates in the original order', async () => {
    const stub = fetchStub((call) => jsonResponse(dataFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    const out = await embed(bus, { texts: texts(130), task: 'document' });

    expect(stub.calls).toHaveLength(3);
    expect(stub.calls.map((c) => requestOf(c).input.length)).toEqual([64, 64, 2]);
    // Each vector names its own text, so this is an ORDER assertion, not just
    // a count one: a driver that awaited the chunks concurrently and pushed
    // them as they landed would fail here and nowhere else.
    expect(out?.vectors.map((v) => v[0])).toEqual(
      Array.from({ length: 130 }, (_, i) => i),
    );
  });

  it('answers undefined when ONE chunk fails — never a partial batch', async () => {
    const stub = fetchStub((call, index) =>
      index === 1 ? jsonResponse({ error: 'nope' }, 500) : jsonResponse(dataFor(call)),
    );
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(embed(bus, { texts: texts(130), task: 'document' })).resolves.toBeUndefined();
  });
});

describe('remote embed — every way the provider can fail to answer', () => {
  const badResponses: [string, () => Response][] = [
    ['a null body', () => jsonResponse(null)],
    ['an empty object body', () => jsonResponse({})],
    ['data short by one', () => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] })],
    [
      'more data entries than inputs',
      () =>
        jsonResponse({
          data: Array.from({ length: 3 }, (_, i) => ({ index: i, embedding: [1, 2, 3, 4] })),
        }),
    ],
    [
      'a vector of the wrong width',
      () =>
        jsonResponse({
          data: [0, 1].map((i) => ({ index: i, embedding: [1, 2, 3] })),
        }),
    ],
    [
      'a vector holding null (what a NaN becomes on the wire)',
      () =>
        jsonResponse({
          data: [0, 1].map((i) => ({ index: i, embedding: [1, 2, 3, null] })),
        }),
    ],
    [
      'a vector holding NaN',
      () =>
        rawJsonResponse({
          data: [0, 1].map((i) => ({ index: i, embedding: [1, 2, 3, Number.NaN] })),
        }),
    ],
    [
      'a vector holding Infinity',
      () =>
        rawJsonResponse({
          data: [0, 1].map((i) => ({
            index: i,
            embedding: [1, 2, 3, Number.POSITIVE_INFINITY],
          })),
        }),
    ],
    [
      'a vector holding a string',
      () =>
        jsonResponse({
          data: [0, 1].map((i) => ({ index: i, embedding: [1, 2, 3, '4'] })),
        }),
    ],
    ['data that is not an array', () => jsonResponse({ data: { 0: [1, 2, 3, 4] } })],
    ['a data entry missing embedding', () => jsonResponse({ data: [{ index: 0 }, { index: 1 }] })],
    ['an out-of-range index', () => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3, 4] }, { index: 9, embedding: [1, 2, 3, 4] }] })],
    ['a negative index', () => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3, 4] }, { index: -1, embedding: [1, 2, 3, 4] }] })],
    ['HTTP 500', () => jsonResponse({ error: 'boom' }, 500)],
    ['HTTP 403', () => jsonResponse({ error: 'denied' }, 403)],
    ['a body that is not JSON', () => new Response('<html>gateway</html>', { status: 200 })],
  ];

  it.each(badResponses)('resolves to undefined for %s', async (_label, make) => {
    const stub = fetchStub(() => make());
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toBeUndefined();
  });

  it('resolves to undefined when fetch itself rejects', async () => {
    const stub = fetchStub(() => Promise.reject(new Error('ECONNRESET')));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toBeUndefined();
  });

  it('resolves to undefined when the request outlives timeoutMs', async () => {
    const stub = fetchStub((call) => neverResponds(call.signal));
    const bus = await busWithPlugin(configWith(stub, { timeoutMs: 20 }), { credential: TOKEN });

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toBeUndefined();
    // The abort has to reach the request, not just the driver's own bookkeeping.
    expect(stub.calls[0]?.signal?.aborted).toBe(true);
  });
});

describe('remote embed — no credential means no call', () => {
  it('resolves to undefined when nothing registers credentials:get', async () => {
    const stub = fetchStub(() => jsonResponse({}));
    const bus = await busWithPlugin(configWith(stub));

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });

  it('resolves to undefined when credentials:get throws', async () => {
    const stub = fetchStub(() => jsonResponse({}));
    const bus = await busWithPlugin(configWith(stub), {
      credential: () => {
        throw new Error('credential not found for provider:openrouter (owner u)');
      },
    });

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });

  it('resolves to undefined when credentials:get returns an empty string', async () => {
    const stub = fetchStub(() => jsonResponse({}));
    const bus = await busWithPlugin(configWith(stub), { credential: '' });

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });

  it('resolves to undefined when credentials:get returns a non-string', async () => {
    const stub = fetchStub(() => jsonResponse({}));
    const bus = await busWithPlugin(configWith(stub), { credential: () => ({ token: TOKEN }) });

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });

  it('never dials out for a ctx with no userId', async () => {
    // The one that proves we do not make an UNAUTHENTICATED request. Without
    // the userId guard the credential lookup is skipped, `token` is the empty
    // string, and a batch of somebody's memory leaves the building behind an
    // `Authorization: Bearer ` header.
    const stub = fetchStub((call) => jsonResponse(dataFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(
      embed(bus, { texts: texts(2), task: 'document' }, ctxForUser('')),
    ).resolves.toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });
});

describe('remote embed — the payload model is not trusted', () => {
  it.each([
    ['path traversal', '../../../x'],
    ['no slash', 'x'],
    ['too many slashes', 'a/b/c'],
    ['uppercase', 'Google/Gemini'],
    ['a query string', 'a/b?c'],
    ['a fragment', 'a/b#x'],
    ['whitespace', 'a/b c'],
    ['an empty variant', 'a/b:'],
    ['an over-length id', `a/${'b'.repeat(200)}`],
    ['an empty string', ''],
  ])('refuses %s without dialing out', async (_label, model) => {
    const stub = fetchStub((call) => jsonResponse(dataFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(
      embed(bus, { texts: texts(2), task: 'document', model }),
    ).resolves.toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });
});

describe('remote embed — the input payload is still loud', () => {
  it('throws invalid-payload for a malformed payload rather than degrading', async () => {
    const stub = fetchStub(() => jsonResponse({}));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    // A bad payload is the CALLER's bug and must stay loud; a failed provider
    // is the nullish "no answer" the consumer degrades on. The split is the
    // whole contract, so it gets an assertion on the remote path too.
    await expect(
      bus.call('embeddings:embed', ctx, { texts: ['a'], task: 'sideways' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    expect(stub.calls).toHaveLength(0);
  });

  it('answers an empty batch without a credential or a round trip', async () => {
    const stub = fetchStub(() => jsonResponse({}));
    const bus = await busWithPlugin(configWith(stub));

    await expect(embed(bus, { texts: [], task: 'document' })).resolves.toEqual({ vectors: [] });
    expect(stub.calls).toHaveLength(0);
  });
});

describe('remote embed — a non-2xx is not an answer, however well-formed its body', () => {
  // ADDED BY THE TASK-487 MUTATION PASS. Deleting `if (!response.ok) return
  // undefined` from `postJson` left the whole suite GREEN, because every
  // non-2xx fixture in the failure table above also happens to carry a body
  // that fails the shape check a moment later. So the status check was being
  // credited for work the shape check was doing, and it could have been
  // refactored away with 137 tests still passing.
  //
  // The case that separates them is a non-2xx carrying a PERFECTLY VALID body,
  // which is not hypothetical: an authenticating proxy answering 403 with a
  // cached payload, a gateway's 503 echoing the last good response, or a
  // provider returning 429 alongside a partial result. Accepting any of those
  // would write a rate-limiter's leftovers into the vector column as though
  // the model had produced them.
  it.each([
    ['403', 403],
    ['429', 429],
    ['500', 500],
    ['503', 503],
  ])('resolves to undefined for HTTP %s with a valid data body', async (_label, status) => {
    const stub = fetchStub((call) => jsonResponse(dataFor(call), status));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toBeUndefined();
    // We still dialed — the point is that we refused what came back, not that
    // we never asked.
    expect(stub.calls).toHaveLength(1);
  });

  it('accepts that same body at 200, so the fixture itself is not the reason', async () => {
    // The control. Without it, the four cases above would also pass against a
    // driver that refuses this body at EVERY status.
    const stub = fetchStub((call) => jsonResponse(dataFor(call), 200));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(embed(bus, { texts: texts(2), task: 'document' })).resolves.toEqual({
      vectors: [
        [0, 0, 0, 0],
        [1, 0, 0, 0],
      ],
    });
  });
});
