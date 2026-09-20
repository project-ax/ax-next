import { describe, expect, it } from 'vitest';
import { PluginError } from '@ax/core';
import { busWithPlugin, ctx } from './harness.js';

// Every case here asserts the CODE, not merely that something threw, and that
// is load-bearing. Four of these payloads (`texts` not an array, a non-string
// element, `documents` not an array, a non-string `query`) blow up on their
// own against an implementation with no validation at all — `.map` /
// `.toLowerCase` of the wrong type — and `HookBus.call` re-wraps that
// TypeError as `code: 'unknown'`. A bare `.rejects.toThrow()` would therefore
// pass against a completely unvalidated handler; only the code tells the two
// apart. The other six (over-count, over-length, bad `task`, missing `task`,
// bad `model`) would simply SUCCEED unvalidated, because the local mode
// ignores `task`/`model` and has no size opinion — the bounds exist to size an
// outbound network payload carrying user memory once T2 lands.
async function expectInvalidPayload(hook: string, input: unknown): Promise<void> {
  const bus = await busWithPlugin();
  let thrown: unknown;
  try {
    await bus.call(hook, ctx, input);
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `${hook} accepted a malformed payload`).toBeInstanceOf(PluginError);
  expect((thrown as PluginError).code).toBe('invalid-payload');
  expect((thrown as PluginError).plugin).toBe('@ax/embeddings');
}

const LONG = 'x'.repeat(8193);

describe('embeddings:embed — payload rejection', () => {
  it('rejects a non-object payload', async () => {
    await expectInvalidPayload('embeddings:embed', null);
    await expectInvalidPayload('embeddings:embed', 'texts');
  });

  it('rejects texts that is not an array', async () => {
    await expectInvalidPayload('embeddings:embed', { texts: 'hello', task: 'document' });
  });

  it('rejects a non-string element inside texts', async () => {
    await expectInvalidPayload('embeddings:embed', { texts: ['ok', 42], task: 'document' });
  });

  it('rejects 257 texts', async () => {
    await expectInvalidPayload('embeddings:embed', {
      texts: Array.from({ length: 257 }, (_, i) => `t${i}`),
      task: 'document',
    });
  });

  it('accepts exactly 256 texts (the bound is inclusive)', async () => {
    const bus = await busWithPlugin();
    const out = await bus.call<unknown, { vectors: number[][] }>('embeddings:embed', ctx, {
      texts: Array.from({ length: 256 }, (_, i) => `t${i}`),
      task: 'document',
    });
    expect(out.vectors).toHaveLength(256);
  });

  it('rejects a text of 8193 characters', async () => {
    await expectInvalidPayload('embeddings:embed', { texts: [LONG], task: 'document' });
  });

  it('rejects an unknown task', async () => {
    await expectInvalidPayload('embeddings:embed', { texts: ['a'], task: 'retrieval' });
  });

  it('rejects a missing task', async () => {
    await expectInvalidPayload('embeddings:embed', { texts: ['a'] });
  });

  it('rejects a non-string model', async () => {
    await expectInvalidPayload('embeddings:embed', { texts: ['a'], task: 'query', model: 42 });
  });
});

describe('embeddings:rerank — payload rejection', () => {
  it('rejects a non-object payload', async () => {
    await expectInvalidPayload('embeddings:rerank', null);
  });

  it('rejects documents that is not an array', async () => {
    await expectInvalidPayload('embeddings:rerank', { query: 'q', documents: 'doc' });
  });

  it('rejects a non-string element inside documents', async () => {
    await expectInvalidPayload('embeddings:rerank', { query: 'q', documents: ['ok', 42] });
  });

  it('rejects 257 documents', async () => {
    await expectInvalidPayload('embeddings:rerank', {
      query: 'q',
      documents: Array.from({ length: 257 }, (_, i) => `d${i}`),
    });
  });

  it('rejects a document of 8193 characters', async () => {
    await expectInvalidPayload('embeddings:rerank', { query: 'q', documents: [LONG] });
  });

  it('rejects a query that is not a string', async () => {
    await expectInvalidPayload('embeddings:rerank', { query: 42, documents: ['a'] });
  });

  it('rejects a query of 8193 characters', async () => {
    await expectInvalidPayload('embeddings:rerank', { query: LONG, documents: ['a'] });
  });

  it('rejects a non-string model', async () => {
    await expectInvalidPayload('embeddings:rerank', { query: 'q', documents: ['a'], model: 42 });
  });

  it('accepts an empty query string (empty is not the same as absent)', async () => {
    const bus = await busWithPlugin();
    const out = await bus.call<unknown, { scores: number[] }>('embeddings:rerank', ctx, {
      query: '',
      documents: ['a'],
    });
    expect(out.scores).toEqual([0]);
  });
});
