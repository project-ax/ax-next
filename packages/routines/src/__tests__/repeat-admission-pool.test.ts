import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { createRepeatDeliveryStore } from '../repeat-deliveries.js';

// The production blob facade uses the same database pool as admissions.
const f = fixture({ max: 2, connectionTimeoutMillis: 2000 });
async function row(index: number, owner = 'owner') {
  return f.store.createAuthored({
    ...createInput(`create-${index}`), agentId: `agent-${index}`, ownerUserId: owner,
    definition: RoutineDefinitionSchema.parse({
      name: `Repeat ${index}`, promptBody: 'Review this update.',
      webhook: { kind: 'webhook', path: `/repeat-${index}` },
    }),
  });
}
async function persist(bytes: Uint8Array) {
  await sql`SELECT 1`.execute(f.db);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}
describe('repeat admission with shared database-backed payload storage', () => {
  it.each(['same', 'different'])('completes a burst across %s owners without starving storage', async owners => {
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push(await row(i, owners === 'same' ? 'owner' : `owner-${i}`));
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      createRepeatDeliveryStore(f.db, `executor-${i}`).admit({
        row: rows[i % rows.length]!, payload: { i }, deliveryId: `delivery-${i}`, now,
      }, persist)));
    expect(results).toEqual(Array.from({ length: 12 }, () => ({ status: 'fulfilled', value: 'accepted' })));
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM routines_v1_deliveries`.execute(f.db)).rows[0]!.n).toBe(12);
  });
  it('releases admission after storage refusal so a queued retry can succeed', async () => {
    const r = await row(0);
    const first = createRepeatDeliveryStore(f.db, 'first').admit({ row: r, payload: {}, deliveryId: 'retry', now }, async () => {
      await sql`SELECT 1`.execute(f.db);
      throw new Error('storage refused');
    });
    const second = createRepeatDeliveryStore(f.db, 'second').admit({ row: r, payload: {}, deliveryId: 'retry', now }, persist);
    const results = await Promise.allSettled([first, second]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: new Error('storage refused') });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'accepted' });
    expect((await sql<{ n: number }>`SELECT count(*)::int AS n FROM routines_v1_deliveries`.execute(f.db)).rows[0]!.n).toBe(1);
  });
});
