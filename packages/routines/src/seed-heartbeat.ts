import {
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceDelta,
} from '@ax/core';
import { HEARTBEAT_TEMPLATE, HEARTBEAT_PATH } from './heartbeat-template.js';

const ENC = new TextEncoder();
const PLUGIN_NAME = '@ax/routines/seed-heartbeat';

export interface SeedHeartbeatDeps {
  bus: HookBus;
}

/**
 * Payload shape for `agents:created`. Defined locally (mirrors what
 * `@ax/agents` exports) to honor L2: no runtime cross-plugin imports.
 */
export interface AgentsCreatedPayload {
  agentId: string;
  ownerId: string;
  ownerType: 'user' | 'team';
}

/**
 * Subscriber for `agents:created`. Writes the bundled heartbeat template
 * into the new agent's workspace via `workspace:apply`, then fires
 * `workspace:applied` so downstream indexers (notably this same plugin's
 * routine syncer) pick up the new `.ax/routines/heartbeat.md` file.
 *
 * Two ctx wrinkles to get right:
 *
 *  1. The subscriber receives `ctx` from the firing site (the agents
 *     plugin's admin route), whose `agentId` points at `@ax/agents`,
 *     not the newly-created agent. We MUST construct a fresh ctx
 *     scoped to the new agent before calling `workspace:apply` — the
 *     workspace backend (workspace-git-server's client plugin) derives
 *     workspaceId from `(userId, agentId)`, so passing the firing ctx
 *     would either land in the wrong workspace or fail to resolve one.
 *
 *  2. `workspace:apply` does NOT fire `workspace:applied` — that hook
 *     is only fired by the runner→host IPC `workspace.commit-notify`
 *     handler. When the host itself calls `workspace:apply` directly
 *     (this code path), downstream indexers never see the new file
 *     unless we fire the event ourselves with the returned delta. We
 *     mirror the commit-notify handler's pattern: fire-and-log, never
 *     reject (apply already landed).
 *
 * Team-owned agents are skipped at MVP: `ownerId` is a teamId in that
 * case, and there is no per-team userId to plug into workspace routing
 * yet. The operator can re-seed manually once the team-workspace story
 * lands.
 *
 * L6: any failure is caught + logged; the seed must NOT block agent
 * creation. If the workspace already has content (parent !== null),
 * `workspace:apply` throws `parent-mismatch` — that's also caught and
 * logged. The operator can re-seed manually if needed.
 */
export function createSeedHeartbeatSubscriber(deps: SeedHeartbeatDeps) {
  return async (
    ctx: AgentContext,
    payload: AgentsCreatedPayload,
  ): Promise<undefined> => {
    if (payload.ownerType !== 'user') {
      ctx.logger.warn('routines_heartbeat_seed_skipped_non_user_owner', {
        agentId: payload.agentId,
        ownerType: payload.ownerType,
      });
      return undefined;
    }
    const seedCtx = makeAgentContext({
      sessionId: `seed-heartbeat-${payload.agentId}-${Date.now()}`,
      agentId: payload.agentId,
      userId: payload.ownerId,
    });
    let applied: WorkspaceApplyOutput | null = null;
    try {
      applied = await deps.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', seedCtx, {
          changes: [{
            path: HEARTBEAT_PATH,
            kind: 'put',
            content: ENC.encode(HEARTBEAT_TEMPLATE),
          }],
          parent: null,
          reason: 'seed heartbeat',
        },
      );
    } catch (err) {
      seedCtx.logger.warn('routines_heartbeat_seed_failed', {
        agentId: payload.agentId,
        plugin: PLUGIN_NAME,
        err: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
    // Fire workspace:applied so the routine syncer + any other indexer
    // sees the new file. Apply already landed; rejections here are
    // post-fact misuse → log and continue (mirrors the commit-notify
    // handler).
    try {
      const fireRes = await deps.bus.fire<WorkspaceDelta>(
        'workspace:applied', seedCtx, applied.delta,
      );
      if (fireRes.rejected) {
        seedCtx.logger.warn('routines_heartbeat_seed_applied_rejected', {
          agentId: payload.agentId,
          reason: fireRes.reason,
        });
      }
    } catch (err) {
      seedCtx.logger.warn('routines_heartbeat_seed_applied_fire_failed', {
        agentId: payload.agentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  };
}
