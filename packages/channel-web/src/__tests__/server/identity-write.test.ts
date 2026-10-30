// @vitest-environment node
/**
 * TASK-989 — the one place channel-web reads and writes an agent's identity,
 * soul and Instructions: `@ax/agents`' `agents:identity:get|set`, with a
 * server-side read-then-write that retries a lost compare-and-set (people get
 * last-writer-wins, as before; no revision ever reaches the browser).
 */
import { describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import {
  IDENTITY_WRITE_ATTEMPTS,
  readAgentIdentity,
  writeAgentIdentity,
} from '../../server/identity-write.js';
import { registerIdentityStoreFake } from './identity-store-fake.js';

const ctx = makeAgentContext({ sessionId: 'workspace-surface', agentId: 'a1', userId: 'u1' });

function harness() {
  const bus = new HookBus();
  const fake = registerIdentityStoreFake(bus, 'mock-agents');
  return { bus, fake };
}

describe('readAgentIdentity', () => {
  it('reads identity, soul, Instructions and revision on the caller ctx', async () => {
    const { bus, fake } = harness();
    fake.seed('a1', {
      identity: 'I am Ada.',
      soul: 'Calm.',
      instructions: 'Be brief.',
      bootstrap: 'pending',
      revision: 4,
    });

    expect(await readAgentIdentity(bus, ctx, 'a1')).toEqual({
      identity: 'I am Ada.',
      soul: 'Calm.',
      instructions: 'Be brief.',
      revision: 4,
    });
    expect(fake.calls).toEqual([
      { hook: 'get', ctxAgentId: 'a1', ctxUserId: 'u1', input: { agentId: 'a1' } },
    ]);
  });

  it('answers unavailable without the hook', async () => {
    expect(await readAgentIdentity(new HookBus(), ctx, 'a1')).toBe('unavailable');
  });

  it('throws what the hook throws, rather than answering blanks', async () => {
    const { bus, fake } = harness();
    const down = new PluginError({ code: 'unknown', plugin: 'mock-agents', message: 'db down' });
    fake.getThrows = down;
    await expect(readAgentIdentity(bus, ctx, 'a1')).rejects.toBe(down);
  });

  it('refuses a malformed reply instead of reading it as an empty record', async () => {
    // A reply that crossed the bus without Instructions or a revision must not
    // turn into "the person wrote nothing" — that is a blank editor one Save
    // away from overwriting what is really stored.
    const bus = new HookBus();
    bus.registerService('agents:identity:get', 'odd-agents', async () => ({
      identity: 'I am Ada.',
      soul: 'Calm.',
    }));
    await expect(readAgentIdentity(bus, ctx, 'a1')).rejects.toMatchObject({
      name: 'PluginError',
      code: 'invalid-return',
    });

    const fractional = new HookBus();
    fractional.registerService('agents:identity:get', 'odd-agents', async () => ({
      identity: '',
      soul: '',
      instructions: '',
      bootstrap: 'none',
      revision: 1.5,
    }));
    await expect(readAgentIdentity(fractional, ctx, 'a1')).rejects.toMatchObject({
      code: 'invalid-return',
    });
  });
});

describe('writeAgentIdentity', () => {
  it('writes with the revision it just read', async () => {
    const { bus, fake } = harness();
    fake.seed('a1', { soul: 'Calm.', revision: 5 });

    const result = await writeAgentIdentity(bus, ctx, 'a1', { instructions: 'Be brief.' });

    expect(result).toEqual({
      kind: 'saved',
      record: { identity: '', soul: 'Calm.', instructions: 'Be brief.', revision: 6 },
    });
    expect(fake.calls.map((c) => [c.hook, c.input])).toEqual([
      ['get', { agentId: 'a1' }],
      ['set', { agentId: 'a1', patch: { instructions: 'Be brief.' }, expectedRevision: 5 }],
    ]);
    // Both on the caller's own ctx — the hooks authorize on it.
    expect(fake.calls.every((c) => c.ctxAgentId === 'a1' && c.ctxUserId === 'u1')).toBe(true);
  });

  it('reads an unchanged write as saved, carrying what is stored', async () => {
    const { bus, fake } = harness();
    fake.seed('a1', { instructions: 'Be brief.', revision: 2 });

    expect(await writeAgentIdentity(bus, ctx, 'a1', { instructions: 'Be brief.\n\n' })).toEqual({
      kind: 'saved',
      record: { identity: '', soul: '', instructions: 'Be brief.', revision: 2 },
    });
  });

  it('retries a conflict and saves, keeping the change that won the race', async () => {
    // The agent rewrites its soul between this read and this write. The set
    // loses the compare-and-set, the retry re-reads and lands — and the
    // agent's soul edit is still there: two writers, two sections, both kept.
    const { bus, fake } = harness();
    fake.racingWrites = 1;

    const result = await writeAgentIdentity(bus, ctx, 'a1', { instructions: 'Be brief.' });

    expect(result).toEqual({
      kind: 'saved',
      record: { identity: '', soul: 'agent edit 1', instructions: 'Be brief.', revision: 2 },
    });
    expect(fake.calls.map((c) => c.hook)).toEqual(['get', 'set', 'get', 'set']);
    expect(fake.calls[3]!.input).toMatchObject({ expectedRevision: 1 });
  });

  it(`gives up after ${IDENTITY_WRITE_ATTEMPTS} conflicts and saves nothing`, async () => {
    const { bus, fake } = harness();
    fake.racingWrites = IDENTITY_WRITE_ATTEMPTS + 1;

    expect(await writeAgentIdentity(bus, ctx, 'a1', { instructions: 'Be brief.' })).toEqual({
      kind: 'conflict',
    });
    expect(fake.calls.filter((c) => c.hook === 'set')).toHaveLength(IDENTITY_WRITE_ATTEMPTS);
    // It stopped: one more racing writer was still waiting for a fourth try.
    expect(fake.racingWrites).toBe(1);
    expect(fake.record('a1').instructions).toBe('');
  });

  it('passes a refusal through and saves nothing', async () => {
    const { bus, fake } = harness();
    fake.refuse = { section: 'soul', code: 'content', reason: 'possible prompt-injection' };

    expect(await writeAgentIdentity(bus, ctx, 'a1', { identity: 'I am Ada.', soul: 'x' })).toEqual({
      kind: 'refused',
      code: 'content',
      reason: 'possible prompt-injection',
    });
    // A refusal is final: no second attempt.
    expect(fake.calls.filter((c) => c.hook === 'set')).toHaveLength(1);
    expect(fake.record('a1')).toMatchObject({ identity: '', soul: '', revision: 0 });
  });

  it('answers unavailable without the hooks, and never calls half of them', async () => {
    expect(await writeAgentIdentity(new HookBus(), ctx, 'a1', { soul: 'x' })).toEqual({
      kind: 'unavailable',
    });

    // A read with nothing to write through is not a write.
    const readOnly = new HookBus();
    let gets = 0;
    readOnly.registerService('agents:identity:get', 'mock-agents', async () => {
      gets += 1;
      return { identity: '', soul: '', instructions: '', bootstrap: 'none', revision: 0 };
    });
    expect(await writeAgentIdentity(readOnly, ctx, 'a1', { soul: 'x' })).toEqual({
      kind: 'unavailable',
    });
    expect(gets).toBe(0);
  });

  it('throws a store fault rather than calling it saved', async () => {
    const { bus, fake } = harness();
    const down = new PluginError({ code: 'unknown', plugin: 'mock-agents', message: 'db down' });
    fake.setThrows = down;
    await expect(writeAgentIdentity(bus, ctx, 'a1', { soul: 'x' })).rejects.toBe(down);
  });

  it('refuses a malformed set reply instead of calling it saved', async () => {
    const bus = new HookBus();
    bus.registerService('agents:identity:get', 'odd-agents', async () => ({
      identity: '',
      soul: '',
      instructions: '',
      bootstrap: 'none',
      revision: 0,
    }));
    bus.registerService('agents:identity:set', 'odd-agents', async () => ({ outcome: 'saved' }));
    await expect(writeAgentIdentity(bus, ctx, 'a1', { soul: 'x' })).rejects.toMatchObject({
      code: 'invalid-return',
    });

    const oddRefusal = new HookBus();
    oddRefusal.registerService('agents:identity:get', 'odd-agents', async () => ({
      identity: '',
      soul: '',
      instructions: '',
      bootstrap: 'none',
      revision: 0,
    }));
    oddRefusal.registerService('agents:identity:set', 'odd-agents', async () => ({
      outcome: 'refused',
      section: 'soul',
      code: 'quota',
      reason: 'x',
    }));
    await expect(writeAgentIdentity(oddRefusal, ctx, 'a1', { soul: 'x' })).rejects.toMatchObject({
      code: 'invalid-return',
    });
  });
});
