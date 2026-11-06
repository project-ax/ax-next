import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, now } from './store-fixture.js';
import { createRepeatDeliveryStore } from '../repeat-deliveries.js';
const f = fixture();
const blobs = new Map<string, Uint8Array>();
const persist = async (bytes: Uint8Array) => { const sha256 = createHash('sha256').update(bytes).digest('hex'); blobs.set(sha256, bytes); return { sha256, size: bytes.length }; };
const queue = () => createRepeatDeliveryStore(f.db, 'test-executor');

/** A webhook-only repeat job with two app updates, each claimed into a run bound to its own conversation. */
async function twoOpenRuns() {
  const row = await f.store.createAuthored({ ...createInput('new-issues'), definition: RoutineDefinitionSchema.parse({ name: 'New issues', promptBody: 'Summarize the new issue.', schedule: null, webhook: { kind: 'webhook', path: '/issues' } }) });
  for (const id of ['first', 'second']) expect(await queue().admit({ row, payload: { id }, deliveryId: id, now, signature: null }, persist)).toBe('accepted');
  const a = (await queue().claim(now))!;
  const b = (await queue().claim(now))!;
  await f.store.bindDispatchConversation({ dispatchId: a.accepted.dispatchId, conversationId: 'conv-a' });
  await f.store.bindDispatchConversation({ dispatchId: b.accepted.dispatchId, conversationId: 'conv-b' });
  return { row, a, b, scope: { agentId: row.agentId, conversationId: 'conv-a', actorUserId: 'owner', eventId: a.deliveryId } };
}

describe('the app update a repeat run reads, against real Postgres (TASK-1050)', () => {
  it('finds the open run’s own update and nothing else', async () => {
    const { a, b, scope } = await twoOpenRuns();
    expect(a.deliveryId).not.toBe(b.deliveryId);
    const found = await f.store.readRepeatUpdate(scope);
    expect(found).toEqual({ eventId: a.deliveryId, receivedAt: now, blobRef: a.blobRef, byteLength: blobs.get(a.blobRef)!.byteLength });
    // routines_v1_deliveries.byte_length is a bigint, which node-postgres answers as a string.
    expect(typeof found!.byteLength).toBe('number');
    for (const other of [{ conversationId: 'conv-b' }, { eventId: b.deliveryId }, { agentId: 'other' }, { actorUserId: 'editor' }, { eventId: 'delivery_unknown' }])
      expect(await f.store.readRepeatUpdate({ ...scope, ...other })).toBeNull();
    expect(await f.store.readRepeatUpdate({ ...scope, conversationId: 'conv-b', eventId: b.deliveryId })).toMatchObject({ eventId: b.deliveryId, blobRef: b.blobRef });
  });

  it('stops answering when the routine changes owner or the run ends', async () => {
    const { row, a, scope } = await twoOpenRuns();
    const setOwner = (owner: string) => f.db.updateTable('routines_v1_definitions').set({ owner_user_id: owner }).where('agent_id', '=', row.agentId).where('routine_id', '=', row.routineId).execute();
    await setOwner('peer');
    expect(await f.store.readRepeatUpdate(scope)).toBeNull();
    await setOwner('owner');
    expect(await f.store.readRepeatUpdate(scope)).not.toBeNull();
    expect(await f.store.finishDispatch({ dispatchId: a.accepted.dispatchId, outcome: { status: 'ok', conversationId: 'conv-a', error: null, renderedPrompt: null, warning: null } })).toBe(true);
    expect(await f.store.readRepeatUpdate(scope)).toBeNull();
    await queue().settle(now);
    expect(await f.store.readRepeatUpdate(scope)).toBeNull();
  });
});
