import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import type { ToolDescriptor } from '@ax/core';
import { registerMemorySearch, MEMORY_SEARCH_DESCRIPTOR } from '../tools/memory-search.js';
import type { RetrievalResult } from '../retriever.js';

/** Minimal fixture result for happy-path tests. */
const FIXTURE_RESULTS: RetrievalResult[] = [
  {
    docId: 'doc-1',
    category: 'preference',
    slug: 'react',
    summary: 'User prefers React',
    score: 0.9,
  },
];

function makeCtx() {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId: 'test-user',
  });
}

/**
 * Wrap a bare tool input in the host-execution `ToolCall` envelope
 * `{ id, name, input }` — the exact shape the `tool.execute-host` IPC handler
 * forwards to the `tool:execute:<name>` service hook (see ipc-core
 * `tool-execute-host.ts`). Calling the hook with bare input would mask the
 * `call.input` extraction bug this suite is meant to catch.
 */
function asToolCall(input: Record<string, unknown>) {
  return { id: 'call-1', name: 'memory_search', input };
}

/**
 * Build a bus wired with:
 *  - a stub `tool:register` that records the last registered descriptor
 *  - a stub `memory:index:search` that records captured inputs and returns
 *    the provided results array (default: FIXTURE_RESULTS)
 */
function makeWiredBus(opts: {
  searchResults?: RetrievalResult[];
} = {}) {
  const bus = new HookBus();
  const searchResults = opts.searchResults ?? FIXTURE_RESULTS;

  let registeredDescriptor: ToolDescriptor | undefined;
  const capturedSearchInputs: unknown[] = [];

  bus.registerService<ToolDescriptor, { ok: true }>(
    'tool:register',
    'test-tool-dispatcher',
    async (_ctx, input) => {
      registeredDescriptor = input;
      return { ok: true };
    },
  );

  bus.registerService(
    'memory:index:search',
    'test-indexer',
    async (_ctx, input) => {
      capturedSearchInputs.push(input);
      return { results: searchResults };
    },
  );

  return { bus, getRegisteredDescriptor: () => registeredDescriptor, capturedSearchInputs };
}

describe('tools/memory-search', () => {
  describe('descriptor registration', () => {
    it('registers the MEMORY_SEARCH_DESCRIPTOR via tool:register', async () => {
      const { bus, getRegisteredDescriptor } = makeWiredBus();
      await registerMemorySearch(bus);

      const desc = getRegisteredDescriptor();
      expect(desc).toBeDefined();
      expect(desc?.name).toBe('memory_search');
      expect(desc?.executesIn).toBe('host');
      expect(desc?.inputSchema).toMatchObject({
        type: 'object',
        required: ['query'],
      });
    });

    it('registered descriptor matches MEMORY_SEARCH_DESCRIPTOR exactly', async () => {
      const { bus, getRegisteredDescriptor } = makeWiredBus();
      await registerMemorySearch(bus);

      expect(getRegisteredDescriptor()).toEqual(MEMORY_SEARCH_DESCRIPTOR);
    });
  });

  describe('tool:execute:memory_search', () => {
    it('happy path: returns {results: [...]} shape', async () => {
      const { bus } = makeWiredBus();
      await registerMemorySearch(bus);

      const ctx = makeCtx();
      const out = await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'react' }));

      expect(out).toEqual({ results: FIXTURE_RESULTS });
    });

    it('default topK = 5 when not supplied', async () => {
      const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
      await registerMemorySearch(bus);

      const ctx = makeCtx();
      await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'foo' }));

      expect(capturedSearchInputs).toHaveLength(1);
      expect((capturedSearchInputs[0] as Record<string, unknown>).topK).toBe(5);
    });

    it('explicit topK passes through', async () => {
      const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
      await registerMemorySearch(bus);

      const ctx = makeCtx();
      await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'foo', topK: 10 }));

      expect(capturedSearchInputs).toHaveLength(1);
      expect((capturedSearchInputs[0] as Record<string, unknown>).topK).toBe(10);
    });

    describe('topK clamping', () => {
      it.each([
        { input: 0, expected: 1, label: 'topK: 0 → 1' },
        { input: -5, expected: 1, label: 'topK: -5 → 1' },
        { input: 100, expected: 20, label: 'topK: 100 → 20' },
      ])('$label', async ({ input, expected }) => {
        const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
        await registerMemorySearch(bus);

        const ctx = makeCtx();
        await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'foo', topK: input }));

        expect((capturedSearchInputs[0] as Record<string, unknown>).topK).toBe(expected);
      });

      it('topK: non-numeric string → default 5', async () => {
        const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
        await registerMemorySearch(bus);

        const ctx = makeCtx();
        await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'foo', topK: 'banana' }));

        expect((capturedSearchInputs[0] as Record<string, unknown>).topK).toBe(5);
      });
    });

    it('categoryFilter passes through when provided', async () => {
      const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
      await registerMemorySearch(bus);

      const ctx = makeCtx();
      await bus.call('tool:execute:memory_search', ctx, asToolCall({
        query: 'foo',
        categoryFilter: 'preference',
      }));

      expect(capturedSearchInputs).toHaveLength(1);
      expect((capturedSearchInputs[0] as Record<string, unknown>).categoryFilter).toBe(
        'preference',
      );
    });

    it('categoryFilter is omitted when not provided', async () => {
      const { bus, capturedSearchInputs } = makeWiredBus({ searchResults: [] });
      await registerMemorySearch(bus);

      const ctx = makeCtx();
      await bus.call('tool:execute:memory_search', ctx, asToolCall({ query: 'foo' }));

      expect(capturedSearchInputs).toHaveLength(1);
      expect(
        'categoryFilter' in (capturedSearchInputs[0] as Record<string, unknown>),
      ).toBe(false);
    });
  });
});
