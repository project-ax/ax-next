import type { Kysely } from 'kysely';
import type { RoutinesDatabase } from './migrations.js';

/**
 * TASK-1050. The app update that started a repeat run, as the run reads it: the
 * delivery's host-minted id (`delivery_<hex>`) is its eventId, and its bytes stay
 * in the blob store, named only by `blobRef`.
 */
export type RepeatUpdate = { eventId: string; receivedAt: Date; blobRef: string; byteLength: number };

/**
 * A stored delivery, `{ row, payload }` as admission wrote it, parsed for the full
 * read. It decodes the way the delivery pump does, requires the payload key
 * admission always writes, and refuses with this one fixed message, never the
 * parser's: JSON.parse's can quote the bytes, and those are another app's.
 */
export function parseDeliveryEnvelope(bytes: Uint8Array): { row: unknown; payload: unknown } {
  let envelope: unknown;
  try { envelope = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error('Invalid app update.'); }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).some(key => key !== 'row' && key !== 'payload') || !Object.hasOwn(envelope, 'payload'))
    throw new Error('Invalid app update.');
  const { row, payload } = envelope as { row?: unknown; payload: unknown };
  return { row, payload };
}

/**
 * TASK-1050. Imports no store.ts, so the store can spread this in without a cycle.
 * Nothing here writes: admission and claims stay in repeat-deliveries.ts.
 */
export function createRepeatUpdateStore(db: Kysely<RoutinesDatabase>) {
  return {
    /**
     * The update that started the caller's open repeat run, or null. Only while
     * that run is open, in its conversation, run as the caller, for the routine's
     * current owner, and while the delivery still holds its bytes. One query, so
     * every condition holds at once; the caller checks it again after the blob read.
     */
    async readRepeatUpdate(input: { agentId: string; conversationId: string; actorUserId: string; eventId: string }): Promise<RepeatUpdate | null> {
      const row = await db.selectFrom('routines_v1_deliveries as q')
        .innerJoin('routines_v1_dispatches as d', 'd.dispatch_id', 'q.dispatch_id')
        .innerJoin('routines_v1_definitions as r', join => join.onRef('r.agent_id', '=', 'q.agent_id').onRef('r.routine_id', '=', 'q.routine_id'))
        .select(['q.delivery_id', 'q.accepted_at', 'q.blob_ref', 'q.byte_length'])
        .where('q.delivery_id', '=', input.eventId).where('q.agent_id', '=', input.agentId).where('q.owner_user_id', '=', input.actorUserId)
        .where('q.completed_at', 'is', null).where('q.blob_ref', 'is not', null)
        .where('d.delivery_id', '=', input.eventId).where('d.agent_id', '=', input.agentId).where('d.conversation_id', '=', input.conversationId)
        .where('d.run_as_user_id', '=', input.actorUserId).where('d.completed_at', 'is', null).where('d.kind', '=', 'repeat')
        .where('r.owner_user_id', '=', input.actorUserId)
        .executeTakeFirst();
      if (row === undefined || row.blob_ref === null) return null;
      // byte_length is a bigint column, which node-postgres answers as a string.
      return { eventId: row.delivery_id, receivedAt: row.accepted_at, blobRef: row.blob_ref, byteLength: Number(row.byte_length) };
    },
  };
}
