import type { AgentContext, HookBus, WorkspaceApplyInput, WorkspaceApplyOutput } from '@ax/core';
import { HEARTBEAT_TEMPLATE, HEARTBEAT_PATH } from './heartbeat-template.js';

const ENC = new TextEncoder();

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
 * into the new agent's workspace via `workspace:apply`.
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
    try {
      await deps.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply', ctx, {
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
      ctx.logger.warn('routines_heartbeat_seed_failed', {
        agentId: payload.agentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  };
}
