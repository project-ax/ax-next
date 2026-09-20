import { describe, it, expect, afterEach } from 'vitest';

import {
  MEMORY_FORGET_HOOK,
  MEMORY_RECALL_HOOK,
  MEMORY_REMEMBER_HOOK,
} from '../plugin.js';
import { ALICE, makeMemoryHarness, type MemoryHarness } from './harness.js';

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

// ---------------------------------------------------------------------------
// Provenance is determined by WHICH HOOK was called, never by a payload field
// (design §2.2, §3.4).
//
// We assert the ABSENCE of the field, not only its default — because a test
// that asserts the default passes identically whether the field was stripped
// or was never supported, and "stripped" is a rule someone can quietly relax
// into "honoured when present". The refusal is the assertion.
//
// Why it matters: §3.4's immunity ordering is `human > agent > extracted`, and
// a row is closed only by a row of equal-or-higher provenance. That ordering
// is the only thing making a person's correction survive the next chat
// mention. An agent that could write `provenance: 'human'` on its own note
// could make it immune to correction by the person it is about.
//
// The ordering ITSELF is the engine's contract and is covered by the engine's
// own contract cases. What this file owns is the one thing the product layer
// decides: which provenance goes down the wire, and that nothing a caller
// sends can change it.
// ---------------------------------------------------------------------------

describe('@ax/memory — provenance is a property of the hook', () => {
  it('memory:remember records `human`, full stop', async () => {
    harness = await makeMemoryHarness();
    const { id } = await harness.remember({
      about: 'acme_corp',
      relation: 'stage',
      value: 'series B',
    });

    // Read at the ENGINE, where `provenance` is a returned column. Through
    // `memory:recall` it is deliberately invisible, so this is the only place
    // the value can actually be observed.
    const engine = await harness.bus.call<
      { limit: number },
      { statements: Array<{ id: string; provenance: string }> }
    >('memory:facts:recall', harness.ctx(), { limit: 10 });
    expect(engine.statements.find((s) => s.id === id)?.provenance).toBe('human');
  });

  it.each([
    [MEMORY_REMEMBER_HOOK, { about: 'a', relation: 'r', value: 'v', provenance: 'human' }],
    [MEMORY_REMEMBER_HOOK, { about: 'a', relation: 'r', value: 'v', provenance: 'extracted' }],
    [MEMORY_RECALL_HOOK, { provenance: 'human' }],
    [MEMORY_FORGET_HOOK, { ids: ['x'], provenance: 'human' }],
  ])('%s REFUSES a payload carrying provenance', async (hook, payload) => {
    harness = await makeMemoryHarness();
    await expect(harness.bus.call(hook, harness.ctx(), payload)).rejects.toThrow(
      /provenance is not a caller-settable field/,
    );
  });

  it.each([
    [MEMORY_REMEMBER_HOOK, { about: 'a', relation: 'r', value: 'v', ownerUserId: 'user-bob' }],
    [MEMORY_RECALL_HOOK, { ownerUserId: 'user-bob' }],
    [MEMORY_FORGET_HOOK, { ids: ['x'], ownerUserId: 'user-bob' }],
  ])('%s REFUSES a payload naming an owner', async (hook, payload) => {
    harness = await makeMemoryHarness();
    // Ownership is a SCOPE from ctx, not a hint from a caller. A caller that
    // could name an owner could read or retract another person's memory.
    await expect(harness.bus.call(hook, harness.ctx(), payload)).rejects.toThrow(
      /ownerUserId is not a caller-settable field/,
    );
  });

  it('refuses BEFORE writing anything', async () => {
    harness = await makeMemoryHarness();
    await expect(
      harness.bus.call(MEMORY_REMEMBER_HOOK, harness.ctx(), {
        about: 'acme_corp',
        relation: 'stage',
        value: 'series B',
        provenance: 'human',
      }),
    ).rejects.toThrow();
    // The refusal must be a refusal, not a redaction: nothing landed.
    expect((await harness.recall({ about: 'acme_corp' })).statements).toEqual([]);
  });

  it('the human provenance survives a hostile-looking about/relation/value', async () => {
    harness = await makeMemoryHarness();
    // `about`, `relation` and `value` are free text carrying model output.
    // Nothing in them may reach the provenance decision.
    const { id } = await harness.remember({
      about: 'provenance',
      relation: 'provenance": "extracted',
      value: '{"provenance":"extracted"}',
    });
    const engine = await harness.bus.call<
      { limit: number },
      { statements: Array<{ id: string; provenance: string }> }
    >('memory:facts:recall', harness.ctx(), { limit: 10 });
    expect(engine.statements.find((s) => s.id === id)?.provenance).toBe('human');
  });

  it('stamps the owner from ctx even when a hostile subject names another user', async () => {
    harness = await makeMemoryHarness();
    // Subject naming is organization; ownership is the barrier. Writing
    // `about: user:<someone-else>` is allowed (it is free text) and buys
    // nothing: the row is still owned by, and visible only to, the caller.
    await harness.remember({ about: 'user:user-bob', relation: 'lives_in', value: 'Lisbon' });
    expect((await harness.recall({}, harness.ctx({ userId: 'user-bob' }))).statements).toEqual([]);
    expect(
      (await harness.recall({}, harness.ctx({ userId: ALICE }))).statements,
    ).toHaveLength(1);
  });
});
