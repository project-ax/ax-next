import { makeAgentContext, type HookBus } from '@ax/core';
import { repeatConfigurationHash, parseStoredRoutine } from './definition.js';
import type { RoutinesStore } from './store.js';
import type { RepeatDeliveryStore } from './repeat-deliveries.js';
import type { FireRoutineFn } from './tick.js';
import { RUN_INTERRUPTED } from './store.js';
import { REPEAT_DELIVERY_LIMITS as LIMIT } from './repeat-limits.js';

export function createRepeatDeliveryPump(deps: { bus: HookBus; deliveries: RepeatDeliveryStore; store: RoutinesStore; fire: FireRoutineFn & ((accepted: Parameters<FireRoutineFn>[0], payload?: unknown) => ReturnType<FireRoutineFn>); now: () => Date }) {
  let running: Promise<void> | undefined;
  return () => {
    if (running) return running;
    running = (async () => {
      await deps.deliveries.settle(deps.now());
      for (const expired of await deps.deliveries.expired()) {
        let terminal = expired.executor_released || expired.conversation_id === null;
        if (!terminal && expired.run_as_user_id !== null) {
          try {
            const ctx = makeAgentContext({ sessionId:'repeat-recovery',agentId:expired.agent_id,userId:expired.run_as_user_id });
            const metadata = await deps.bus.callJoined<{conversationId:string;userId:string},{activeSessionId:string|null}>('conversations:get-metadata',ctx,{conversationId:expired.conversation_id!,userId:expired.run_as_user_id});
            terminal = metadata.activeSessionId === null;
            if (!terminal && deps.bus.hasService('sandbox:session-status') && deps.bus.hasService('session:terminate')) {
              const observed = await deps.bus.callJoined<{sessionId:string},{state:'running'|'stopped'|'unknown'}>('sandbox:session-status',ctx,{sessionId:metadata.activeSessionId!});
              if (observed.state === 'stopped') {
                // Revoke the old session before releasing capacity. A late resource creation or runner retry
                // cannot use its stale credential to start work after another delivery takes this slot.
                await deps.bus.callJoined('session:terminate',ctx,{sessionId:metadata.activeSessionId!});
                terminal = true;
              }
            }
          } catch {
            // Unknown execution still occupies capacity. Provider messages may contain private data.
            makeAgentContext({sessionId:'repeat-recovery',agentId:expired.agent_id,userId:expired.run_as_user_id}).logger.warn('repeat_recovery_status_unavailable',{dispatchId:expired.dispatch_id});
          }
        }
        if (!terminal) await deps.deliveries.deferRecovery(expired.dispatch_id);
        if (terminal) await deps.store.finishDispatch({dispatchId:expired.dispatch_id,onlyIfExpired:{conversationId:expired.conversation_id},outcome:{status:'error',error:RUN_INTERRUPTED,conversationId:null,renderedPrompt:null,warning:null}});
      }
      await deps.deliveries.settle(deps.now());
      for (let i=0;i<LIMIT.waitingPerRoutine;i++) {
        const claim = await deps.deliveries.claim(deps.now()); if (!claim) break;
        const ctx = makeAgentContext({sessionId:'repeat-delivery',agentId:claim.accepted.row.agentId,userId:claim.accepted.row.ownerUserId});
        try {
          const blob = await deps.bus.callJoined<{sha256:string},{bytes:Uint8Array}|{found:false}>('blob:get',ctx,{sha256:claim.blobRef});
          if (!('bytes' in blob) || !(blob.bytes instanceof Uint8Array) || blob.bytes.length>LIMIT.bytesPerOwner) throw new Error('Unavailable app update.');
          const envelope: unknown = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
          if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).some(key=>key!=='row' && key!=='payload')) throw new Error('Invalid app update.');
          const saved = parseStoredRoutine((envelope as {row?:unknown}).row);
          const current = claim.accepted.row;
          if (saved.agentId!==current.agentId || saved.routineId!==current.routineId || saved.ownerUserId!==current.ownerUserId || repeatConfigurationHash(saved)!==repeatConfigurationHash(current)) throw new Error('App update configuration changed.');
          await deps.fire(claim.accepted,(envelope as {payload?:unknown}).payload);
        } catch {
          // Provider errors can contain payload bytes; never persist or log their messages here.
          await deps.store.finishDispatch({dispatchId:claim.accepted.dispatchId,outcome:{status:'error',error:'This app update could not run. Try a new delivery.',conversationId:null,renderedPrompt:null,warning:null}});
        }
        await deps.deliveries.settle(deps.now());
      }
    })().finally(()=>{ running=undefined; });
    return running;
  };
}
