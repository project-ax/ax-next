// TASK-990 — `agents:identity:self-changes-for-user`: the recent changes a
// person's own (personal) agents made to their own identity or soul. The marks
// are seeded with raw SQL here; the writer (an `author: 'agent'` save) is
// covered in identity.test.ts and identity-tools.test.ts.
import { describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { PluginError } from '@ax/core';
import type { AgentsDatabase } from '../migrations.js';
import { createIdentityStore } from '../identity/store.js';
import {
  AGENTS_IDENTITY_SELF_CHANGES_FOR_USER_HOOK,
  AGENTS_IDENTITY_SET_HOOK,
  type IdentitySelfChangesForUserOutput,
  type IdentitySetOutput,
} from '../types.js';
import { useIdentityEnv, type IdentityHarness } from './identity-harness.js';

const env = useIdentityEnv();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Set one section's "changed by the agent" mark to `ago` before the DB's now(). */
async function mark(agentId: string, section: 'identity' | 'soul', ago: string): Promise<void> {
  await env.query(
    'INSERT INTO agents_v1_identity (agent_id) VALUES ($1) ON CONFLICT (agent_id) DO NOTHING',
    [agentId],
  );
  await env.query(
    `UPDATE agents_v1_identity SET ${section}_changed_by_agent_at = now() - $2::interval WHERE agent_id = $1`,
    [agentId, ago],
  );
}

/** The database clock, in ms (the window is judged on it, not on ours). */
async function dbNow(): Promise<number> {
  const rows = await env.query<{ t: Date }>('SELECT now() AS t');
  return rows[0]!.t.getTime();
}

const list = (ih: IdentityHarness, userId: string): Promise<IdentitySelfChangesForUserOutput> =>
  ih.h.bus.call<unknown, IdentitySelfChangesForUserOutput>(
    AGENTS_IDENTITY_SELF_CHANGES_FOR_USER_HOOK,
    ih.ctx('any', userId),
    { userId },
  );

const pairs = (out: IdentitySelfChangesForUserOutput): Array<[string, string]> =>
  out.changes.map((c) => [c.agentId, c.section]);

async function rejection(p: Promise<unknown>): Promise<PluginError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(PluginError);
    return err as PluginError;
  }
  throw new Error('expected the call to reject');
}

describe('agents:identity:self-changes-for-user', () => {
  it("lists the owner's own agents' changes, newest first, three fields each", async () => {
    const ih = await env.makeHarness();
    const a1 = await ih.createAgent('alice');
    const a2 = await ih.createAgent('alice');
    const before = await dbNow();
    await mark(a1, 'soul', '1 day');
    await mark(a2, 'identity', '2 hours');
    const after = await dbNow();

    const out = await list(ih, 'alice');
    expect(pairs(out)).toEqual([
      [a2, 'identity'],
      [a1, 'soul'],
    ]);
    // (Through the hook's `returns` schema, which strips extra keys; the store
    // itself is checked in the next case.)
    for (const change of out.changes) {
      expect(Object.keys(change).sort()).toEqual(['agentId', 'changedAt', 'section']);
    }
    const [identity, soul] = out.changes as [
      IdentitySelfChangesForUserOutput['changes'][number],
      IdentitySelfChangesForUserOutput['changes'][number],
    ];
    const identityAt = Date.parse(identity.changedAt);
    expect(identityAt).toBeGreaterThanOrEqual(before - 2 * HOUR_MS);
    expect(identityAt).toBeLessThanOrEqual(after - 2 * HOUR_MS);
    const soulAt = Date.parse(soul.changedAt);
    expect(soulAt).toBeGreaterThanOrEqual(before - DAY_MS);
    expect(soulAt).toBeLessThanOrEqual(after - DAY_MS);
  });

  it('the store itself returns exactly three keys per change', async () => {
    const ih = await env.makeHarness();
    const a1 = await ih.createAgent('alice');
    await mark(a1, 'soul', '1 hour');
    const db = new Kysely<AgentsDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: env.connectionString(), max: 1 }),
      }),
    });
    try {
      const changes = await createIdentityStore(db).listSelfChanges('alice');
      expect(changes).toHaveLength(1);
      for (const change of changes) {
        expect(Object.keys(change).sort()).toEqual(['agentId', 'changedAt', 'section']);
      }
    } finally {
      await db.destroy();
    }
  });

  it('an agent with no identity row, or no mark, lists nothing', async () => {
    const ih = await env.makeHarness();
    await ih.createAgent('alice');
    // A person's save creates the row and changes the text, and marks nothing.
    const saved = await ih.createAgent('alice');
    const out = await ih.h.bus.call<unknown, IdentitySetOutput>(
      AGENTS_IDENTITY_SET_HOOK,
      ih.ctx(saved, 'alice'),
      { agentId: saved, patch: { identity: 'I am Pip', soul: 'Kind' }, expectedRevision: 0 },
    );
    expect(out.outcome).toBe('saved');
    expect(await list(ih, 'alice')).toEqual({ changes: [] });
  });

  it('each section has its own window', async () => {
    const ih = await env.makeHarness();
    const a1 = await ih.createAgent('alice');
    await mark(a1, 'soul', '8 days');
    await mark(a1, 'identity', '6 days');
    expect(pairs(await list(ih, 'alice'))).toEqual([[a1, 'identity']]);
  });

  it('another person never sees them', async () => {
    const ih = await env.makeHarness();
    const a1 = await ih.createAgent('alice');
    await mark(a1, 'soul', '1 hour');
    expect(pairs(await list(ih, 'alice'))).toEqual([[a1, 'soul']]);
    expect(await list(ih, 'bob')).toEqual({ changes: [] });
  });

  it('team agents are left out, for every member', async () => {
    const ih = await env.makeHarness({ teamMembers: ['alice', 'bob'] });
    const team = await ih.createAgent('alice', { input: { visibility: 'team', teamId: 't1' } });
    const own = await ih.createAgent('alice');
    await mark(team, 'soul', '1 hour');
    await mark(own, 'identity', '1 hour');
    // Alice still sees her personal agent's change, so the list itself works.
    expect(pairs(await list(ih, 'alice'))).toEqual([[own, 'identity']]);
    expect(await list(ih, 'bob')).toEqual({ changes: [] });
  });

  it("a deleted agent's changes go with it", async () => {
    const ih = await env.makeHarness();
    const a1 = await ih.createAgent('alice');
    await mark(a1, 'soul', '1 hour');
    expect(pairs(await list(ih, 'alice'))).toEqual([[a1, 'soul']]);
    await ih.h.bus.call('agents:delete', ih.h.ctx({ userId: 'alice' }), {
      actor: { userId: 'alice', isAdmin: false },
      agentId: a1,
    });
    expect(await list(ih, 'alice')).toEqual({ changes: [] });
  });

  it('refuses malformed input', async () => {
    const ih = await env.makeHarness();
    const a1 = await ih.createAgent('alice');
    await mark(a1, 'soul', '1 hour');
    for (const input of [
      undefined,
      null,
      'alice',
      {},
      { userId: '' },
      { userId: 7 },
      { userId: 'alice', teamIds: [] },
    ]) {
      const err = await rejection(
        ih.h.bus.call(AGENTS_IDENTITY_SELF_CHANGES_FOR_USER_HOOK, ih.ctx('any', 'alice'), input),
      );
      expect(err.code, JSON.stringify(input) ?? 'undefined').toBe('invalid-payload');
    }
  });
});
