import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { retrieve, type RetrievalResult } from '../retriever.js';

describe('retriever', () => {
  it('happy path: returns results from the indexer', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({
      sessionId: 'test-session',
      agentId: 'test-agent',
      userId: 'test-user',
    });

    const expected: RetrievalResult[] = [
      {
        docId: 'doc-1',
        category: 'preference',
        slug: 'react',
        summary: 'User prefers React',
        score: 0.95,
      },
    ];

    bus.registerService(
      'memory:index:search',
      'test-indexer',
      async () => ({ results: expected }),
    );

    const result = await retrieve(bus, ctx, { query: 'react' });
    expect(result).toEqual(expected);
  });

  it('default topK = 5', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({
      sessionId: 'test-session',
      agentId: 'test-agent',
      userId: 'test-user',
    });

    let capturedInput: unknown;
    bus.registerService(
      'memory:index:search',
      'test-indexer',
      async (_ctx, input) => {
        capturedInput = input;
        return { results: [] };
      },
    );

    await retrieve(bus, ctx, { query: 'foo' });
    expect(capturedInput).toEqual({ query: 'foo', topK: 5 });
  });

  it('explicit topK', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({
      sessionId: 'test-session',
      agentId: 'test-agent',
      userId: 'test-user',
    });

    let capturedInput: unknown;
    bus.registerService(
      'memory:index:search',
      'test-indexer',
      async (_ctx, input) => {
        capturedInput = input;
        return { results: [] };
      },
    );

    await retrieve(bus, ctx, { query: 'foo', topK: 10 });
    expect(capturedInput).toEqual({ query: 'foo', topK: 10 });
  });

  it('categoryFilter pass-through', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({
      sessionId: 'test-session',
      agentId: 'test-agent',
      userId: 'test-user',
    });

    let capturedInput: unknown;
    bus.registerService(
      'memory:index:search',
      'test-indexer',
      async (_ctx, input) => {
        capturedInput = input;
        return { results: [] };
      },
    );

    await retrieve(bus, ctx, { query: 'foo', categoryFilter: 'preference' });
    expect(capturedInput).toEqual({
      query: 'foo',
      topK: 5,
      categoryFilter: 'preference',
    });
  });

  it('categoryFilter omitted when undefined', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({
      sessionId: 'test-session',
      agentId: 'test-agent',
      userId: 'test-user',
    });

    let capturedInput: unknown;
    bus.registerService(
      'memory:index:search',
      'test-indexer',
      async (_ctx, input) => {
        capturedInput = input;
        return { results: [] };
      },
    );

    await retrieve(bus, ctx, { query: 'foo' });
    expect(capturedInput).toEqual({ query: 'foo', topK: 5 });
    expect('categoryFilter' in (capturedInput as Record<string, unknown>)).toBe(
      false,
    );
  });

  it('indexer not registered: returns empty array', async () => {
    const bus = new HookBus();
    const ctx = makeAgentContext({
      sessionId: 'test-session',
      agentId: 'test-agent',
      userId: 'test-user',
    });

    const result = await retrieve(bus, ctx, { query: 'foo' });
    expect(result).toEqual([]);
  });
});
