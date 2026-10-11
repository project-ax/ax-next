import { makeAgentContext, type HookBus } from '@ax/core';
import type { RoutinesStore } from './store.js';

/** Discovery never authorizes deletion: the store rechecks each job under its lock. */
export async function drainRoutineCleanup({ bus, store, limit = 50 }: {
  bus: HookBus; store: RoutinesStore; limit?: number;
}): Promise<void> {
  for (const key of await store.pendingCleanup({ limit })) {
    const ctx = makeAgentContext({ sessionId: 'routine-cleanup', agentId: key.agentId, userId: key.ownerUserId });
    try {
      await store.runCredentialCleanup(key, async job => {
        await bus.callJoined('credentials:delete', ctx, { scope: 'agent', ownerId: job.agentId, ref: job.credentialRef });
      });
    } catch {
      ctx.logger.warn('routines_credential_cleanup_pending', { agentId: key.agentId, routineId: key.routineId });
    }
  }
}

export async function purgeRoutineAgent({ bus, store, pending, agentId }: {
  bus: HookBus; store: RoutinesStore; pending: Map<string, { row: { agentId: string } }>; agentId: string;
}): Promise<void> {
  await store.purgeAgent(agentId);
  for (const [id, fire] of pending) if (fire.row.agentId === agentId) pending.delete(id);
  await drainRoutineCleanup({ bus, store });
}
