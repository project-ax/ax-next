// The Vertex embed driver, driven through the bus exactly as
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

const TOKEN = 'ya29.test-access-token';
const PROJECT = 'ax-next-dev';
const DIMENSIONS = 4;

const EXPECTED_URL =
  'https://us-central1-aiplatform.googleapis.com/v1/projects/ax-next-dev' +
  '/locations/us-central1/publishers/google/models/text-embedding-005:predict';

interface VertexInstance {
  content: string;
  task_type: string;
}
interface VertexRequest {
  instances: VertexInstance[];
  parameters: { outputDimensionality: number };
}

function requestOf(call: RecordedCall): VertexRequest {
  return call.body as VertexRequest;
}

/** `t7` ⇒ `[7, 0, 0, 0]`: a vector that names the text it belongs to. */
function vectorFor(content: string): number[] {
  const n = Number(content.slice(1));
  return [n, 0, 0, 0];
}

function predictionsFor(call: RecordedCall): unknown {
  return {
    predictions: requestOf(call).instances.map((instance) => ({
      embeddings: { values: vectorFor(instance.content) },
    })),
  };
}

function texts(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `t${i}`);
}

function configWith(stub: FetchStub, extra: Partial<EmbeddingsConfig> = {}): EmbeddingsConfig {
  return {
    dimensions: DIMENSIONS,
    embed: { provider: 'vertex', credentialRef: 'provider:vertex', projectId: PROJECT },
    fetchImpl: stub.impl,
    ...extra,
  };
}

function embed(bus: HookBus, input: EmbedInput, who = ctx): Promise<EmbedOutput | undefined> {
  return bus.call<EmbedInput, EmbedOutput | undefined>('embeddings:embed', who, input);
}

describe('remote embed — the happy path', () => {
  it('returns one vector per text, in input order', async () => {
    const stub = fetchStub((call) => jsonResponse(predictionsFor(call)));
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
    const stub = fetchStub((call) => jsonResponse(predictionsFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await embed(bus, { texts: texts(1), task: 'document' });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(EXPECTED_URL);
    expect(stub.calls[0]?.method).toBe('POST');
  });

  it('sends the credential as a Bearer header and NOWHERE else', async () => {
    const stub = fetchStub((call) => jsonResponse(predictionsFor(call)));
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

  it.each([
    ['document' as const, 'RETRIEVAL_DOCUMENT'],
    ['query' as const, 'RETRIEVAL_QUERY'],
  ])('maps task %s to task_type %s', async (task, taskType) => {
    const stub = fetchStub((call) => jsonResponse(predictionsFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await embed(bus, { texts: texts(2), task });

    expect(requestOf(stub.calls[0] as RecordedCall).instances.map((i) => i.task_type)).toEqual([
      taskType,
      taskType,
    ]);
  });

  it('asks for the configured dimensions', async () => {
    const stub = fetchStub((call) => jsonResponse(predictionsFor(call)));
    const bus = await busWithPlugin(configWith(stub, { dimensions: 4 }), { credential: TOKEN });

    await embed(bus, { texts: texts(1), task: 'document' });

    expect(requestOf(stub.calls[0] as RecordedCall).parameters.outputDimensionality).toBe(4);
  });

  it('uses a payload model over the endpoint default', async () => {
    const stub = fetchStub((call) => jsonResponse(predictionsFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await embed(bus, { texts: texts(1), task: 'document', model: 'text-embedding-004' });

    expect(stub.calls[0]?.url).toContain('/models/text-embedding-004:predict');
  });

  it('accepts an @-pinned model version', async () => {
    // `@` is in the grammar on purpose — Vertex pins model versions with it,
    // and inside a path segment it cannot open an authority. See `endpoints.ts`.
    const stub = fetchStub((call) => jsonResponse(predictionsFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await embed(bus, { texts: texts(1), task: 'document', model: 'text-embedding-005@002' });

    expect(stub.calls[0]?.url).toContain('/models/text-embedding-005@002:predict');
  });
});

describe('remote embed — chunking', () => {
  it('splits 12 texts into 5/5/2 and concatenates in the original order', async () => {
    const stub = fetchStub((call) => jsonResponse(predictionsFor(call)));
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    const out = await embed(bus, { texts: texts(12), task: 'document' });

    expect(stub.calls).toHaveLength(3);
    expect(stub.calls.map((c) => requestOf(c).instances.length)).toEqual([5, 5, 2]);
    // Each vector names its own text, so this is an ORDER assertion, not just
    // a count one: a driver that awaited the chunks concurrently and pushed
    // them as they landed would fail here and nowhere else.
    expect(out?.vectors.map((v) => v[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('answers undefined when ONE chunk fails — never a partial batch', async () => {
    const stub = fetchStub((call, index) =>
      index === 1 ? jsonResponse({ error: 'nope' }, 500) : jsonResponse(predictionsFor(call)),
    );
    const bus = await busWithPlugin(configWith(stub), { credential: TOKEN });

    await expect(embed(bus, { texts: texts(12), task: 'document' })).resolves.toBeUndefined();
  });
});

describe('remote embed — every way the provider can fail to answer', () => {
  const badResponses: [string, () => Response][] = [
    ['a null body', () => jsonResponse(null)],
    ['an empty object body', () => jsonResponse({})],
    [
      'predictions short by one',
      () => jsonResponse({ predictions: [{ embeddings: { values: [1, 2, 3, 4] } }] }),
    ],
    [
      'more predictions than instances',
      () =>
        jsonResponse({
          predictions: Array.from({ length: 3 }, () => ({ embeddings: { values: [1, 2, 3, 4] } })),
        }),
    ],
    [
      'a vector of the wrong width',
      () =>
        jsonResponse({
          predictions: Array.from({ length: 2 }, () => ({ embeddings: { values: [1, 2, 3] } })),
        }),
    ],
    [
      'a vector holding null (what a NaN becomes on the wire)',
      () =>
        jsonResponse({
          predictions: Array.from({ length: 2 }, () => ({
            embeddings: { values: [1, 2, 3, null] },
          })),
        }),
    ],
    [
      'a vector holding NaN',
      () =>
        rawJsonResponse({
          predictions: Array.from({ length: 2 }, () => ({
            embeddings: { values: [1, 2, 3, Number.NaN] },
          })),
        }),
    ],
    [
      'a vector holding Infinity',
      () =>
        rawJsonResponse({
          predictions: Array.from({ length: 2 }, () => ({
            embeddings: { values: [1, 2, 3, Number.POSITIVE_INFINITY] },
          })),
        }),
    ],
    [
      'a vector holding a string',
      () =>
        jsonResponse({
          predictions: Array.from({ length: 2 }, () => ({ embeddings: { values: [1, 2, 3, '4'] } })),
        }),
    ],
    ['predictions that is not an array', () => jsonResponse({ predictions: { 0: [1, 2, 3, 4] } })],
    ['a prediction missing embeddings', () => jsonResponse({ predictions: [{}, {}] })],
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
        throw new Error('credential not found for provider:vertex (owner u)');
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
    const stub = fetchStub((call) => jsonResponse(predictionsFor(call)));
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
    ['an absolute path', '/etc/passwd'],
    ['a query string', 'text-embedding-005?key=leak'],
    ['a fragment', 'text-embedding-005#x'],
    ['a percent-escape', 'text-embedding-005%2f..%2fx'],
    ['a leading dot', '.hidden'],
    ['an empty string', ''],
  ])('refuses %s without dialing out', async (_label, model) => {
    const stub = fetchStub((call) => jsonResponse(predictionsFor(call)));
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
