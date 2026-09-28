import { afterEach, describe, expect, it } from 'vitest';
import { PluginError, type AgentContext } from '@ax/core';

import { MEMORY_RECALL_TOOL_HOOK } from '../recall-tool.js';
import {
  MEMORY_RECALL_RECEIPTS_HOOK,
  RECALL_RECEIPT_FAILED_EVENT,
  RECALL_RECEIPTS_CAP,
  recallReceiptsKey,
  recordRecallReceipt,
} from '../recall-receipts.js';
import type {
  MemoryRecallReceiptsInput,
  MemoryRecallReceiptsOutput,
  MemoryStatement,
} from '../types.js';
import {
  ALICE,
  BOB,
  eventsNamed,
  makeMemoryHarness,
  type MemoryHarness,
  type MemoryHarnessOptions,
} from './harness.js';

/**
 * TASK-628 — recall receipts: what `memory_recall` handed the model inside a
 * conversation, read back per conversation with each row's since-state.
 *
 * Over the REAL sqlite engine (the closure states are the engine's), with a
 * fake `storage:*` like `incremental.test.ts`.
 */

const CONV = 'conv-628';

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

interface Env {
  h: MemoryHarness;
  storage: Map<string, Uint8Array>;
  failWrites: (n: number) => void;
  ctx: (opts?: { userId?: string; agentId?: string; source?: 'routine' | 'user'; conversationId?: string }) => AgentContext;
  tool: (query: string, c?: AgentContext) => Promise<string>;
  receipts: (c?: AgentContext, conversationId?: string) => Promise<MemoryRecallReceiptsOutput>;
}

async function setup(
  opts: { storage?: boolean; agent?: MemoryHarnessOptions['agent'] } = {},
): Promise<Env> {
  const h = await makeMemoryHarness({}, opts.agent !== undefined ? { agent: opts.agent } : {});
  harness = h;
  const storage = new Map<string, Uint8Array>();
  let writeFailures = 0;
  if (opts.storage !== false) {
    // Deliberately async with a real delay on the read: two unserialized
    // read-modify-writes would both read the empty key (the value is taken
    // BEFORE the delay) and one would be lost.
    h.bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      'fake-storage',
      async (_c, { key }) => {
        const value = storage.get(key);
        await new Promise((r) => setTimeout(r, 5));
        return { value };
      },
    );
    h.bus.registerService<{ key: string; value: Uint8Array }, void>(
      'storage:set',
      'fake-storage',
      async (_c, { key, value }) => {
        if (writeFailures > 0) {
          writeFailures -= 1;
          throw new Error('storage unavailable');
        }
        storage.set(key, value);
      },
    );
  }
  const ctx: Env['ctx'] = (o = {}) =>
    h.ctx({
      conversationId: o.conversationId ?? CONV,
      ...(o.userId !== undefined ? { userId: o.userId } : {}),
      ...(o.agentId !== undefined ? { agentId: o.agentId } : {}),
      ...(o.source !== undefined ? { source: o.source } : {}),
    });
  return {
    h,
    storage,
    failWrites: (n) => {
      writeFailures = n;
    },
    ctx,
    tool: (query, c = ctx()) =>
      h.bus.call<{ input?: unknown }, string>(MEMORY_RECALL_TOOL_HOOK, c, { input: { query } }),
    receipts: (c = ctx(), conversationId = CONV) =>
      h.bus.call<MemoryRecallReceiptsInput, MemoryRecallReceiptsOutput>(
        MEMORY_RECALL_RECEIPTS_HOOK,
        c,
        { conversationId },
      ),
  };
}

async function seedBoston(env: Env): Promise<string> {
  const { id } = await env.h.remember({
    about: 'user',
    relation: 'lives_in',
    value: 'Boston',
    when: '2025-01-01T00:00:00Z',
  });
  return id;
}

describe('memory_recall records a receipt', () => {
  it('records exactly the rows the tool rendered, as the used-statement projection', async () => {
    const env = await setup();
    await seedBoston(env);
    await env.h.remember({ about: 'acme_corp', relation: 'stage', value: 'series B' });

    const before = Date.now();
    const rendered = await env.tool('Boston');
    const direct = await env.h.recall({ query: 'Boston', limit: 15 }, env.ctx());
    expect(direct.statements.length).toBeGreaterThan(0);

    const out = await env.receipts();
    expect(out.receipts).toHaveLength(1);
    const [receipt] = out.receipts;
    expect(Date.parse(receipt!.at)).toBeGreaterThanOrEqual(before - 1000);
    expect(receipt!.statements.map((s) => s.id)).toEqual(direct.statements.map((s) => s.id));
    for (const s of receipt!.statements) expect(rendered).toContain(s.value);

    const expected = direct.statements.map((s: MemoryStatement) => {
      const row: Record<string, unknown> = {
        id: s.id,
        about: s.about,
        relation: s.relation,
        value: s.value,
        when: s.when,
      };
      for (const f of ['until', 'kind', 'slot', 'savedBy', 'aboutText'] as const) {
        if (s[f] !== undefined) row[f] = s[f];
      }
      return row;
    });
    expect(receipt!.statements).toEqual(expected);
    // Per-answer fields never ride along.
    for (const s of receipt!.statements) {
      for (const f of ['whenText', 'conversation', 'sourceTurnId', 'closure', 'closedBy']) {
        expect(f in s).toBe(false);
      }
    }
    expect(out.visibility).toBe('personal');
  });

  it('stamps the stored receipt list with the agent and the user', async () => {
    const env = await setup();
    await seedBoston(env);
    await env.tool('Boston');
    const raw = env.storage.get(recallReceiptsKey(CONV));
    expect(raw).toBeDefined();
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    expect(parsed).toMatchObject({ v: 1, agentId: 'agent-1', userId: ALICE });
    expect(parsed.receipts).toHaveLength(1);
  });

  it('records nothing for a routine turn', async () => {
    const env = await setup();
    await seedBoston(env);
    const out = await env.tool('Boston', env.ctx({ source: 'routine' }));
    expect(out).toContain('Boston');
    expect(env.storage.size).toBe(0);
  });

  it('records nothing when the recall found nothing', async () => {
    const env = await setup();
    await env.tool('Boston');
    expect(env.storage.size).toBe(0);
  });

  it('two parallel recalls in one turn both land', async () => {
    const env = await setup();
    await seedBoston(env);
    await Promise.all([env.tool('Boston'), env.tool('Boston')]);
    expect((await env.receipts()).receipts).toHaveLength(2);
  });

  it('writes to one conversation are serialized: overlapping records both land', async () => {
    const env = await setup();
    await seedBoston(env);
    const { statements } = await env.h.recall({ about: 'user' }, env.ctx());
    await Promise.all([
      recordRecallReceipt(env.h.bus, env.ctx(), statements, '2026-09-27T00:00:00.000Z'),
      recordRecallReceipt(env.h.bus, env.ctx(), statements, '2026-09-27T00:00:01.000Z'),
      recordRecallReceipt(env.h.bus, env.ctx(), statements, '2026-09-27T00:00:02.000Z'),
    ]);
    expect((await env.receipts()).receipts.map((r) => r.at)).toEqual([
      '2026-09-27T00:00:00.000Z',
      '2026-09-27T00:00:01.000Z',
      '2026-09-27T00:00:02.000Z',
    ]);
  });

  it('a failed write does not wedge the writes queued behind it', async () => {
    const env = await setup();
    await seedBoston(env);
    const { statements } = await env.h.recall({ about: 'user' }, env.ctx());
    env.failWrites(1);
    await Promise.all([
      recordRecallReceipt(env.h.bus, env.ctx(), statements, '2026-09-27T00:00:00.000Z'),
      recordRecallReceipt(env.h.bus, env.ctx(), statements, '2026-09-27T00:00:01.000Z'),
    ]);
    expect((await env.receipts()).receipts.map((r) => r.at)).toEqual(['2026-09-27T00:00:01.000Z']);
  });

  it('keeps the newest receipts, capped', async () => {
    const env = await setup();
    const id = await seedBoston(env);
    const { statements } = await env.h.recall({ about: 'user' }, env.ctx());
    expect(statements.map((s) => s.id)).toEqual([id]);
    const total = RECALL_RECEIPTS_CAP + 5;
    for (let i = 0; i < total; i++) {
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      await recordRecallReceipt(env.h.bus, env.ctx(), statements, at);
    }
    const { receipts } = await env.receipts();
    expect(RECALL_RECEIPTS_CAP).toBe(50);
    expect(receipts).toHaveLength(50);
    expect(receipts[0]!.at).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 5)).toISOString());
    expect(receipts[49]!.at).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, total - 1)).toISOString());
  });

  it('a failed receipt write does not fail the tool, and logs no statement text', async () => {
    const env = await setup();
    await seedBoston(env);
    env.failWrites(1);
    const out = await env.tool('Boston');
    expect(out).toContain('Boston');
    const warns = eventsNamed(env.h.logs, RECALL_RECEIPT_FAILED_EVENT);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.level).toBe('warn');
    expect(JSON.stringify(warns[0]!.bindings)).not.toContain('Boston');
    expect((await env.receipts()).receipts).toEqual([]);
  });

  it('with no storage hooks the tool still answers and the hook reads empty', async () => {
    const env = await setup({ storage: false });
    await seedBoston(env);
    expect(await env.tool('Boston')).toContain('Boston');
    expect(await env.receipts()).toMatchObject({ receipts: [] });
  });

  it('an unreadable stored value starts a fresh list instead of failing', async () => {
    const env = await setup();
    await seedBoston(env);
    env.storage.set(recallReceiptsKey(CONV), new TextEncoder().encode('not json'));
    expect((await env.receipts()).receipts).toEqual([]);
    await env.tool('Boston');
    expect((await env.receipts()).receipts).toHaveLength(1);
  });
});

describe('memory:recall-receipts — owner scoped', () => {
  it('another person on the same (team) agent reads nothing', async () => {
    const env = await setup({ agent: { visibility: 'team' } });
    await seedBoston(env);
    await env.tool('Boston');
    expect((await env.receipts()).receipts).toHaveLength(1);
    expect((await env.receipts(env.ctx({ userId: BOB }))).receipts).toEqual([]);
  });

  it("a person who may not read a personal agent's memory is refused, as on every other read", async () => {
    const env = await setup();
    await seedBoston(env);
    await env.tool('Boston');
    await expect(env.receipts(env.ctx({ userId: BOB }))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('another agent reads nothing for the same conversation id', async () => {
    const env = await setup();
    await seedBoston(env);
    await env.tool('Boston');
    expect((await env.receipts(env.ctx({ agentId: 'agent-2' }))).receipts).toEqual([]);
  });

  it('a list recorded for someone else is replaced, never appended to', async () => {
    const env = await setup({ agent: { visibility: 'team' } });
    await seedBoston(env);
    await env.tool('Boston');
    await env.tool('Boston', env.ctx({ userId: BOB }));
    expect((await env.receipts(env.ctx({ userId: BOB }))).receipts).toHaveLength(1);
    expect((await env.receipts()).receipts).toEqual([]);
  });

  it('refuses an empty or oversized conversationId, and privilege fields', async () => {
    const env = await setup();
    await expect(env.receipts(env.ctx(), '')).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(env.receipts(env.ctx(), 'x'.repeat(257))).rejects.toMatchObject({
      code: 'invalid-payload',
    });
    await expect(
      env.h.bus.call(MEMORY_RECALL_RECEIPTS_HOOK, env.ctx(), { conversationId: CONV, agentId: 'agent-2' }),
    ).rejects.toBeInstanceOf(PluginError);
  });
});

describe('memory:recall-receipts — closedSince', () => {
  it('says forgotten, retracted and replaced for rows closed after the answer, nothing for the rest', async () => {
    const env = await setup();
    const seattle = (
      await env.h.remember({ about: 'user', relation: 'lives_in', value: 'Seattle', when: '2025-06-01T00:00:00Z' })
    ).id;
    const acme = (
      await env.h.remember({ about: 'user', relation: 'works_at', value: 'Acme', when: '2025-06-01T00:00:00Z' })
    ).id;
    const deadline = (await env.h.remember({ about: 'project_x', relation: 'deadline', value: 'Friday' })).id;
    const owner = (await env.h.remember({ about: 'project_x', relation: 'owner', value: 'Dana' })).id;

    const user = await env.h.recall({ about: 'user' }, env.ctx());
    const project = await env.h.recall({ about: 'project_x' }, env.ctx());
    await recordRecallReceipt(env.h.bus, env.ctx(), user.statements, '2026-09-27T00:00:00.000Z');
    await recordRecallReceipt(env.h.bus, env.ctx(), project.statements, '2026-09-27T00:00:01.000Z');

    // Before anything changes, nothing is closed.
    for (const r of (await env.receipts()).receipts) {
      for (const s of r.statements) expect('closedSince' in s).toBe(false);
    }

    await env.h.forget({ ids: [deadline] }, env.ctx());
    await env.h.correct(
      { id: acme, about: 'user', relation: 'works_at', value: 'Initech', reason: 'never-right' },
      env.ctx(),
    );
    await env.h.correct(
      { id: seattle, about: 'user', relation: 'lives_in', value: 'Denver', reason: 'changed' },
      env.ctx(),
    );

    const byId = new Map(
      (await env.receipts()).receipts.flatMap((r) => r.statements).map((s) => [s.id, s]),
    );
    expect(byId.get(deadline)!.closedSince).toBe('forgotten');
    expect(byId.get(acme)!.closedSince).toBe('retracted');
    expect(byId.get(seattle)!.closedSince).toBe('replaced');
    expect('closedSince' in byId.get(owner)!).toBe(false);
    // The snapshot itself is what the model saw — the value is not rewritten.
    expect(byId.get(seattle)!.value).toBe('Seattle');
  });

  it('a failed status read degrades to no closedSince, never to an error', async () => {
    const env = await setup();
    const id = await seedBoston(env);
    await env.tool('Boston');
    await env.h.forget({ ids: [id] }, env.ctx());
    // Break the engine read the status pass goes through, after the fact.
    const real = env.h.bus.call.bind(env.h.bus);
    let broken = false;
    (env.h.bus as { call: typeof real }).call = (async (hook: string, c: AgentContext, input: unknown) => {
      if (broken && hook === 'memory:recall') throw new Error('engine down');
      return real(hook, c, input);
    }) as typeof real;
    broken = true;
    const out = await env.receipts();
    expect(out.receipts).toHaveLength(1);
    expect('closedSince' in out.receipts[0]!.statements[0]!).toBe(false);
    expect(eventsNamed(env.h.logs, RECALL_RECEIPT_FAILED_EVENT).length).toBeGreaterThan(0);
  });
});
