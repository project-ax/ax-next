import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';

import { createMemoryPlugin } from '../plugin.js';
import { AGENTS_RESOLVE_HOOK } from '../access.js';
import { MEMORY_RECALL_TOOL_HOOK } from '../recall-tool.js';
import type { MemoryRecallOutput } from '../types.js';
import {
  ALICE,
  BOB,
  engineRecall,
  engineRecord,
  makeMemoryHarness,
  type MemoryHarness,
} from './harness.js';

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

const JAN = '2026-01-01T00:00:00Z';
const MAR = '2026-03-01T00:00:00Z';

function teamHarness(): Promise<MemoryHarness> {
  return makeMemoryHarness({}, { agent: { visibility: 'team' } }).then((h) => {
    harness = h;
    return h;
  });
}

describe('@ax/memory — a team agent shares its memory across members', () => {
  it("one member's write is every member's read, and a teammate's correction closes it", async () => {
    const h = await teamHarness();
    const alice = h.ctx({ userId: ALICE });
    const bob = h.ctx({ userId: BOB });

    const first = await h.remember(
      { about: 'priya', relation: 'works_at', value: 'Acme', when: JAN },
      alice,
    );

    const bobListing = await h.recall({ limit: 10 }, bob);
    expect(bobListing.statements.map((s) => s.id)).toEqual([first.id]);
    expect(bobListing.visibility).toBe('team');
    const bobRanked = await h.recall({ query: 'Acme' }, bob);
    expect(bobRanked.statements.map((s) => s.value)).toEqual(['Acme']);

    const second = await h.remember(
      { about: 'priya', relation: 'works_at', value: 'Beta', when: MAR },
      bob,
    );

    const aliceActive = await h.recall({ limit: 10 }, alice);
    expect(aliceActive.statements.map((s) => s.value)).toEqual(['Beta']);

    const history = await h.recall({ limit: 10, activeOnly: false }, alice);
    const acme = history.statements.find((s) => s.id === first.id);
    expect(acme?.closure).toBe('replaced');
    expect(acme?.closedBy).toBe(second.id);
  });

  it('a member can forget a teammate\'s row — but never another agent\'s', async () => {
    const h = await teamHarness();
    const alice = h.ctx({ userId: ALICE });
    const bob = h.ctx({ userId: BOB });
    const { id } = await h.remember(
      { about: 'priya', relation: 'works_at', value: 'Acme', when: JAN },
      alice,
    );
    const otherAgentRow = await h.remember(
      { about: 'priya', relation: 'works_at', value: 'Otherco', when: JAN },
      h.ctx({ agentId: 'agent-2', userId: ALICE }),
    );

    await h.forget({ ids: [id, otherAgentRow.id] }, bob);

    expect((await h.recall({ limit: 10 }, alice)).statements).toEqual([]);
    expect((await h.recall({ limit: 10 }, bob)).statements).toEqual([]);
    const history = await h.recall({ limit: 10, activeOnly: false }, alice);
    expect(history.statements.find((s) => s.id === id)?.closure).toBe('forgotten');

    const other = await engineRecall(h.bus, h.ctx({ agentId: 'agent-2' }), { limit: 10 });
    expect(other.statements.map((s) => s.id)).toEqual([otherAgentRow.id]);
    expect(other.statements[0]!.until).toBeUndefined();
  });

  it('keeps each member\'s speaker subject distinct, and `profile` is the caller\'s', async () => {
    const h = await teamHarness();
    await h.remember(
      { about: 'user', relation: 'lives_in', value: 'Berlin', when: JAN },
      h.ctx({ userId: ALICE }),
    );
    await h.remember(
      { about: 'user', relation: 'lives_in', value: 'Lisbon', when: JAN },
      h.ctx({ userId: BOB }),
    );

    const shared = await h.recall({ limit: 10 }, h.ctx({ userId: BOB }));
    expect(new Set(shared.statements.map((s) => s.about))).toEqual(
      new Set([`user:${ALICE}`, `user:${BOB}`]),
    );

    const bobProfile = await h.recall({ profile: true, limit: 100 }, h.ctx({ userId: BOB }));
    expect(bobProfile.statements.map((s) => s.about)).toEqual([`user:${BOB}`]);
  });
});

describe('@ax/memory — access resolves on every operation, and fails closed', () => {
  it.each([
    ['recall', (h: MemoryHarness, ctx: AgentContext) => h.recall({ limit: 10 }, ctx)],
    [
      'remember',
      (h: MemoryHarness, ctx: AgentContext) =>
        h.remember({ about: 'a', relation: 'r', value: 'v' }, ctx),
    ],
    ['forget', (h: MemoryHarness, ctx: AgentContext) => h.forget({ ids: ['x'] }, ctx)],
    [
      'the memory_recall tool',
      (h: MemoryHarness, ctx: AgentContext) =>
        h.bus.call(MEMORY_RECALL_TOOL_HOOK, ctx, { input: { query: 'q' } }),
    ],
    [
      'the injected block',
      (h: MemoryHarness, ctx: AgentContext) =>
        h.bus.call('system-prompt:augment', ctx, {}),
    ],
  ])('denies a non-member on %s before any engine call', async (_label, op) => {
    const h = await teamHarness();
    const spy = vi.spyOn(h.bus, 'call');
    const outsider = h.ctx({ userId: 'user-mallory' });
    await expect(op(h, outsider)).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      spy.mock.calls.filter(([hook]) => (hook as string).startsWith('memory:facts:')),
    ).toHaveLength(0);
  });

  it('denies a member the moment membership is revoked — no cached grant', async () => {
    const h = await teamHarness();
    const bob = h.ctx({ userId: BOB });
    await h.remember({ about: 'priya', relation: 'works_at', value: 'Acme', when: JAN }, bob);

    h.teamMembers.delete(BOB);

    await expect(h.recall({ limit: 10 }, bob)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      h.remember({ about: 'a', relation: 'r', value: 'v' }, bob),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.forget({ ids: ['x'] }, bob)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await h.recall({ limit: 10 }, h.ctx({ userId: ALICE }))).statements).toHaveLength(1);
  });

  it.each([
    ['a resolver that throws', async () => {
      throw new PluginError({ code: 'store-unavailable', plugin: '@ax/test', message: 'outage' });
    }],
    ['a resolver that answers null', async () => null],
    ['a resolver that names a different agent', async () => ({
      agent: { id: 'agent-elsewhere', ownerId: ALICE, ownerType: 'user', visibility: 'personal' },
    })],
    ['a resolver with a malformed visibility', async () => ({
      agent: { id: 'agent-1', ownerId: ALICE, ownerType: 'user', visibility: 'world-readable' },
    })],
    ['a resolver naming another owner on a personal agent', async () => ({
      agent: { id: 'agent-1', ownerId: BOB, ownerType: 'user', visibility: 'personal' },
    })],
  ])('fails closed on %s', async (_label, handler) => {
    const bus = new HookBus();
    const engineCalls: string[] = [];
    for (const hook of ['memory:facts:recall', 'memory:facts:record', 'memory:facts:supersede']) {
      bus.registerService(hook, 'stub', async () => {
        engineCalls.push(hook);
        return { statements: [], records: [{ id: 'x' }], degraded: [] };
      });
    }
    bus.registerService('tool:register', 'stub-catalog', async () => ({}));
    bus.registerService(AGENTS_RESOLVE_HOOK, '@ax/test-agents', handler as never);
    await createMemoryPlugin().init({ bus, config: {} });

    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      workspace: { rootPath: '/tmp' },
    });
    await expect(
      bus.call<Record<string, never>, MemoryRecallOutput>('memory:recall', ctx, {}),
    ).rejects.toBeInstanceOf(PluginError);
    expect(engineCalls).toEqual([]);
  });

  it('fails closed when no agents:resolve service exists at all', async () => {
    const bus = new HookBus();
    bus.registerService('memory:facts:recall', 'stub', async () => ({ statements: [], degraded: [] }));
    bus.registerService('memory:facts:record', 'stub', async () => ({ records: [{ id: 'x' }] }));
    bus.registerService('memory:facts:supersede', 'stub', async () => ({}));
    bus.registerService('tool:register', 'stub-catalog', async () => ({}));
    await createMemoryPlugin().init({ bus, config: {} });

    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      workspace: { rootPath: '/tmp' },
    });
    await expect(bus.call('memory:recall', ctx, {})).rejects.toThrow(/no plugin registered/);
  });

  it('refuses a caller-provided `scope: team` on a personal agent', async () => {
    const h = await makeMemoryHarness();
    harness = h;
    await expect(
      h.recall({ scope: 'team' } as unknown as Parameters<typeof h.recall>[0]),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(
      h.recall({ visibility: 'team' } as unknown as Parameters<typeof h.recall>[0]),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(
      h.forget({ ids: ['x'], teamId: 'team-1' } as unknown as Parameters<typeof h.forget>[0]),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('personal recall stays owner-scoped even for rows a foreign writer somehow stored', async () => {
    const h = await makeMemoryHarness();
    harness = h;
    await engineRecord(h.bus, h.ctx(), [
      {
        about: 'acme_corp',
        relation: 'stage',
        value: 'series B',
        when: JAN,
        ownerUserId: BOB,
      },
    ]);
    expect((await h.recall({ limit: 10 }, h.ctx({ userId: ALICE }))).statements).toEqual([]);
  });
});
