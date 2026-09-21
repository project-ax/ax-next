import { describe, it, expect, afterEach } from 'vitest';
import { HookBus } from '@ax/core';

import { createMemoryPlugin } from '../plugin.js';
import { makeMemoryHarness, type MemoryHarness } from './harness.js';

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

describe('@ax/memory — manifest', () => {
  it('registers EXACTLY the three caller-facing hooks', () => {
    const { manifest } = createMemoryPlugin();
    expect(manifest.registers).toEqual(['memory:recall', 'memory:remember', 'memory:forget']);
  });

  it('declares the engine hooks it calls, and nothing else', () => {
    const { manifest } = createMemoryPlugin();
    expect(manifest.calls).toEqual([
      'memory:facts:recall',
      'memory:facts:record',
      'memory:facts:supersede',
    ]);
    // Nothing yet. The observer (`chat:end`) is a separate card, and an
    // unused subscription would be exactly the half-wired surface invariant 3
    // forbids.
    expect(manifest.subscribes).toEqual([]);
  });

  it('actually puts those three on the bus and no fourth', async () => {
    const bus = new HookBus();
    await createMemoryPlugin().init({ bus, config: {} });
    expect(bus.listServices()).toEqual(['memory:recall', 'memory:remember', 'memory:forget']);
  });

  it('names the engine as a HARD dependency — there is no honest fallback', () => {
    const { manifest } = createMemoryPlugin();
    // A memory surface with no store behind it can only answer "no memories"
    // to a question it never asked anyone. If this ever moves to
    // `optionalCalls`, that answer ships.
    expect(manifest.optionalCalls ?? []).toEqual([]);
  });
});

describe('@ax/memory — memory:remember', () => {
  it('stores a statement and returns its id', async () => {
    harness = await makeMemoryHarness();
    const { id } = await harness.remember({
      about: 'acme_corp',
      relation: 'headquartered_in',
      value: 'Berlin',
      when: '2026-01-01T00:00:00Z',
    });
    expect(id).toMatch(/\S/);

    const { statements } = await harness.recall({ about: 'acme_corp' });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      id,
      about: 'acme_corp',
      relation: 'headquartered_in',
      value: 'Berlin',
      // The engine NORMALIZES the instant it stores, so `...00Z` reads back
      // as `...00.000Z`. `@ax/memory` forwards `when` untouched and neither
      // re-validates nor re-formats it: the engine is the single authority on
      // what a valid instant is, and a second formatter here is exactly the
      // drift invariant 4 is about.
      when: '2026-01-01T00:00:00.000Z',
    });
  });

  it('defaults `when` to now rather than rejecting a caller who omits it', async () => {
    harness = await makeMemoryHarness();
    const before = Date.now();
    await harness.remember({ about: 'acme_corp', relation: 'stage', value: 'series B' });
    const { statements } = await harness.recall({ about: 'acme_corp' });
    const when = Date.parse(statements[0]!.when);
    expect(when).toBeGreaterThanOrEqual(before - 1000);
    expect(when).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it.each([
    ['about', { about: '', relation: 'r', value: 'v' }],
    ['relation', { about: 'a', relation: '', value: 'v' }],
    ['value', { about: 'a', relation: 'r', value: '' }],
  ])('rejects an empty %s', async (_field, input) => {
    harness = await makeMemoryHarness();
    await expect(harness.remember(input)).rejects.toThrow(/non-empty string/);
  });
});

describe('@ax/memory — memory:recall', () => {
  it('passes the engine `degraded` through VERBATIM, asymmetry included', async () => {
    harness = await makeMemoryHarness();
    // No embedder and no reranker are registered here, which is the default
    // deployment. The engine raises `'semantic'` (the QUERY would have been
    // embedded — store-independent) but not `'ranking'` (there is no pool to
    // reorder — pool-dependent). That asymmetry is pinned by an engine
    // contract case and this asserts the product layer does not "fix" it.
    const { degraded, statements } = await harness.recall({ query: 'where do I live' });
    expect(statements).toEqual([]);
    expect(degraded).toContain('semantic');
    expect(degraded).not.toContain('ranking');
  });

  it('never leaks engine-side columns into a caller-facing statement', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({ about: 'acme_corp', relation: 'stage', value: 'series B' });
    const { statements } = await harness.recall({ about: 'acme_corp' });
    // `provenance` would start the argument about writing it back IN;
    // `closedBy` leaks another statement's id into a payload.
    expect(statements[0]).not.toHaveProperty('provenance');
    expect(statements[0]).not.toHaveProperty('closedBy');
    expect(Object.keys(statements[0]!).sort()).toEqual([
      'about',
      'id',
      'relation',
      'value',
      'when',
    ]);
  });

  it('does not populate `kind` — no engine stores one yet', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({ about: 'acme_corp', relation: 'stage', value: 'series B' });
    const { statements } = await harness.recall({ about: 'acme_corp' });
    // Pinning the ABSENCE so nobody reads it as a bug. `kind` is declared on
    // `MemoryStatement` for the observer card's benefit, but neither
    // `FactStatementInput` nor `FactRecord` carries it, so there is nothing
    // to forward. When the observer card adds the column, this test is the
    // one that should change.
    expect(statements[0]).not.toHaveProperty('kind');
  });

  it('clamps `limit` to the configured ceiling', async () => {
    harness = await makeMemoryHarness({ maxRecallLimit: 2 });
    for (const v of ['a', 'b', 'c', 'd']) {
      await harness.remember({ about: 'acme_corp', relation: `r_${v}`, value: v });
    }
    const { statements } = await harness.recall({ about: 'acme_corp', limit: 1000 });
    expect(statements).toHaveLength(2);
  });

  it.each([
    ['query', { query: '' }],
    ['about', { about: '  ' }],
  ])('rejects an empty %s rather than silently listing everything', async (_f, input) => {
    harness = await makeMemoryHarness();
    await expect(harness.recall(input)).rejects.toThrow(/non-empty string/);
  });

  it('rejects a non-positive limit', async () => {
    harness = await makeMemoryHarness();
    await expect(harness.recall({ limit: 0 })).rejects.toThrow(/positive number/);
  });
});

describe('@ax/memory — memory:forget', () => {
  it('retracts a statement the caller owns', async () => {
    harness = await makeMemoryHarness();
    const { id } = await harness.remember({
      about: 'acme_corp',
      relation: 'stage',
      value: 'series B',
    });
    expect((await harness.recall({ about: 'acme_corp' })).statements).toHaveLength(1);

    await harness.forget({ ids: [id] });
    expect((await harness.recall({ about: 'acme_corp' })).statements).toEqual([]);
  });

  it('is retrievable as history after a forget — retraction closes, it does not delete', async () => {
    harness = await makeMemoryHarness();
    const { id } = await harness.remember({
      about: 'acme_corp',
      relation: 'stage',
      value: 'series B',
    });
    await harness.forget({ ids: [id] });
    const { statements } = await harness.recall({ about: 'acme_corp', activeOnly: false });
    expect(statements.map((s) => s.id)).toEqual([id]);
    expect(statements[0]!.until).toMatch(/\S/);
  });

  it.each([
    ['a non-array', { ids: 'nope' } as unknown as { ids: string[] }],
    ['an empty array', { ids: [] }],
    ['a blank id', { ids: [''] }],
  ])('rejects %s', async (_label, input) => {
    harness = await makeMemoryHarness();
    await expect(harness.forget(input)).rejects.toThrow(/ids/);
  });
});

describe('@ax/memory — an absent payload', () => {
  // `memory:recall` has no required field, so a caller sending nothing means
  // the same thing as one sending `{}`. Before this test, `{}` worked and
  // `undefined` produced a bare `TypeError` — no plugin, no hook name, no
  // `code` — while `memory:remember` and `memory:forget` both raised a proper
  // `PluginError` for the identical mistake. `HookBus` types `input` as
  // required, so the caller who can actually reach this is one crossing a
  // boundary that erases types (an IPC action, a tool argument), which is the
  // caller least equipped to do anything with a `TypeError`.
  it('reads as `{}` on memory:recall rather than throwing a TypeError', async () => {
    harness = await makeMemoryHarness();
    await harness.remember({ about: 'acme_corp', relation: 'stage', value: 'series B' });
    const result = await harness.bus.call<undefined, { statements: unknown[] }>(
      'memory:recall',
      harness.ctx(),
      undefined,
    );
    expect(result.statements).toHaveLength(1);
  });

  it.each([
    ['memory:remember', /non-empty string/],
    ['memory:forget', /ids must be an array/],
  ])('is still refused on %s, which DOES have required fields', async (hook, message) => {
    harness = await makeMemoryHarness();
    await expect(
      harness.bus.call(hook, harness.ctx(), undefined as unknown as Record<string, unknown>),
    ).rejects.toThrow(message);
  });
});
