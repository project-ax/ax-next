import { CONNECTOR_ID_RE } from '@ax/apps-bridge-contract';
import { faultLogFields, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import type { AppsBridgeStore } from './store.js';

/**
 * Codes, links, grants and approvals have no foreign key to the agents or
 * connectors that own them (invariant 2: a plugin owns its own rows), so they
 * go when those plugins announce a deletion:
 *
 * - `agents:deleted { agentId }`: the agent's open link codes, the links to it
 *   (their grants and approvals cascade), and other people's approvals that
 *   borrow it. A deleted agent lends nothing. The repo guard
 *   scripts/__tests__/agent-keyed-tables-are-cleaned.test.js checks that every
 *   table here with an `agent_id` is deleted from.
 * - `connectors:deleted { connectorId, idStillLive }`: only when no connector
 *   with that id is left anywhere (`idStillLive === false`), its grants on
 *   every app (their approvals cascade). A connector re-created under the same
 *   id must not inherit an app's access. `true`, or no boolean at all, keeps
 *   everything: we fail toward keeping data, as @ax/agents does.
 *
 * Each payload is validated first. Each handler logs one line: counts on
 * success, a code alone otherwise (never the payload, never an error
 * message). Neither ever throws: the deletion already happened, and a throw
 * would only become the bus's own error line. Re-running one is harmless.
 */

export const CLEANUP_SUBSCRIBER_KEY = '@ax/apps-bridge/cleanup';

export const CLEANUP_HOOKS = ['agents:deleted', 'connectors:deleted'] as const;

const AgentsDeletedSchema = z.object({ agentId: z.string().min(1).max(256) });
const ConnectorsDeletedSchema = z.object({ connectorId: z.string().regex(CONNECTOR_ID_RE), idStillLive: z.boolean() });

type CleanupStore = Pick<AppsBridgeStore, 'deleteForAgent' | 'deleteGrantsForConnector'>;

/** A log line never fails the cleanup it reports on. */
function quietly(log: () => void): void {
  try {
    log();
  } catch {
    // Nothing left to report it with.
  }
}

function failureCode(err: unknown): string {
  const f = faultLogFields(err);
  if (f.code !== undefined && f.code !== 'unknown') return f.code;
  return f.causeCode ?? f.name ?? 'unknown';
}

async function run(ctx: AgentContext, hook: string, work: () => Promise<void>): Promise<undefined> {
  try {
    await work();
  } catch (err) {
    quietly(() => ctx.logger.warn('apps_bridge_cleanup_failed', { hook, code: failureCode(err) }));
  }
  return undefined;
}

function ignored(ctx: AgentContext, hook: string): undefined {
  quietly(() => ctx.logger.warn('apps_bridge_cleanup_ignored', { hook, code: 'invalid-payload' }));
  return undefined;
}

export function subscribeCleanup(bus: Pick<HookBus, 'subscribe'>, store: CleanupStore): void {
  bus.subscribe<unknown>('agents:deleted', CLEANUP_SUBSCRIBER_KEY, async (ctx, payload) => {
    const p = AgentsDeletedSchema.safeParse(payload);
    if (!p.success) return ignored(ctx, 'agents:deleted');
    return run(ctx, 'agents:deleted', async () => {
      const removed = await store.deleteForAgent(p.data.agentId);
      quietly(() => ctx.logger.info('apps_bridge_agent_cleaned', removed));
    });
  });

  bus.subscribe<unknown>('connectors:deleted', CLEANUP_SUBSCRIBER_KEY, async (ctx, payload) => {
    const p = ConnectorsDeletedSchema.safeParse(payload);
    if (!p.success) return ignored(ctx, 'connectors:deleted');
    if (p.data.idStillLive) return undefined;
    return run(ctx, 'connectors:deleted', async () => {
      const grants = await store.deleteGrantsForConnector(p.data.connectorId);
      quietly(() => ctx.logger.info('apps_bridge_connector_cleaned', { grants }));
    });
  });
}
