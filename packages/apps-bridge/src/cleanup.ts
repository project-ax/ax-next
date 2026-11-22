import { CONNECTOR_ID_RE } from '@ax/apps-bridge-contract';
import { faultLogFields, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import { TOOL_NAMESPACE_RE, type AppsBridgeStore } from './store.js';

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
 * - `connectors:deleted { connectorId, toolNamespaces, idStillLive }`, on
 *   every event: each grant whose tool keys name one of the deleted
 *   connector's tool namespaces, and each approval whose tool snapshot does.
 *   Connector ids aren't unique across owners, so deleting a common id like
 *   `github` usually still reports `idStillLive: true`; but a namespace hashes
 *   (owner, id, server), so it is the deleted connector's alone. Without this,
 *   the same owner re-creating it with the same servers would derive the same
 *   namespaces and the app would silently regain access. Another owner's
 *   same-id connector has different namespaces and is left alone.
 *   Then, only when no connector with that id is left anywhere
 *   (`idStillLive === false`), every grant under the id too (their approvals
 *   cascade). A payload without a boolean `idStillLive` or a namespace list
 *   is malformed and keeps everything. Namespace entries that aren't
 *   namespace-shaped are skipped, as @ax/tool-policy does.
 *
 * Each payload is validated first. Each handler logs exactly one line: counts
 * on success (also when nothing matched), a code alone otherwise (never the
 * payload, never an error message). Neither ever throws: the deletion already happened, and a throw
 * would only become the bus's own error line. Re-running one is harmless.
 */

export const CLEANUP_SUBSCRIBER_KEY = '@ax/apps-bridge/cleanup';

export const CLEANUP_HOOKS = ['agents:deleted', 'connectors:deleted'] as const;

const AgentsDeletedSchema = z.object({ agentId: z.string().min(1).max(256) });
/** Far above a connector's own server cap (8); a longer list is not a real event. */
const MAX_EVENT_NAMESPACES = 64;
const ConnectorsDeletedSchema = z.object({
  connectorId: z.string().regex(CONNECTOR_ID_RE),
  toolNamespaces: z.array(z.unknown()).max(MAX_EVENT_NAMESPACES),
  idStillLive: z.boolean(),
});

type CleanupStore = Pick<AppsBridgeStore, 'deleteForAgent' | 'deleteGrantsForConnector' | 'deleteForToolNamespaces'>;

/** The namespace-shaped `toolNamespace` of each `{ server, toolNamespace }` entry. */
function namespacesOf(entries: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const ns = typeof e === 'object' && e !== null ? (e as { toolNamespace?: unknown }).toolNamespace : undefined;
    if (typeof ns === 'string' && TOOL_NAMESPACE_RE.test(ns)) out.push(ns);
  }
  return out;
}

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
    return run(ctx, 'connectors:deleted', async () => {
      const byNamespace = await store.deleteForToolNamespaces(namespacesOf(p.data.toolNamespaces));
      const byId = p.data.idStillLive ? 0 : await store.deleteGrantsForConnector(p.data.connectorId);
      quietly(() =>
        ctx.logger.info('apps_bridge_connector_cleaned', { grants: byNamespace.grants + byId, approvals: byNamespace.approvals }),
      );
    });
  });
}
