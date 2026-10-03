import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';

// ---------------------------------------------------------------------------
// Snapshot-on-attach (TASK-737, connectors rail slice 4; design decision 2).
//
// When a connector is newly attached to an agent, the agent COPIES the
// per-tool defaults the connector's editor set (`tool-policy:snapshot-
// connector-for-agent`). The copy is what makes a later admin LOOSENING not
// silently loosen agents already using the connector; a later TIGHTENING still
// applies, because the default stays a live ceiling inside tool-policy.
//
// Only NEWLY added ids snapshot. Re-snapshotting an id that was already
// attached would re-copy today's (possibly looser) default over the copy taken
// at attach time — exactly the loosening decision 2 forbids.
//
// Structural mirrors of the other plugins' hook shapes (Invariant I2).
// ---------------------------------------------------------------------------

interface ResolveOutputLike {
  toolNamespaces?: Array<{ server: string; toolNamespace: string }>;
}

const PLUGIN_NAME = '@ax/agents';

/**
 * Copy the connector defaults for every connector in `after` that was not in
 * `before`. Never throws: an attach that already committed must not fail on
 * the copy. A failed or skipped copy leaves NO per-agent row, so the agent is
 * held to the live connector default — the copy is lost, never widened.
 *
 * `resolveAs` is the user `connectors:resolve` looks the connector up as. The
 * namespace depends only on the connector record (its row owner), so any user
 * who can see the record gets the same answer; the caller picks the one most
 * likely to see it (the agent's owner, who is who sessions resolve as).
 */
export async function snapshotNewlyAttachedConnectors(
  bus: HookBus,
  ctx: AgentContext,
  input: {
    agentId: string;
    before: readonly string[];
    after: readonly string[];
    resolveAs: string;
    actorId: string;
  },
): Promise<void> {
  const prior = new Set(input.before);
  const added = [...new Set(input.after)].filter((id) => !prior.has(id));
  if (added.length === 0) return;
  if (
    !bus.hasService('connectors:resolve') ||
    !bus.hasService('tool-policy:snapshot-connector-for-agent')
  ) {
    return;
  }
  // Attribute the copied rows to the person who attached (`updated_by`).
  const writeCtx = makeAgentContext({
    sessionId: ctx.sessionId,
    agentId: PLUGIN_NAME,
    userId: input.actorId,
  });
  for (const connectorId of added) {
    try {
      const resolved = await bus.call<{ userId: string; connectorId: string }, ResolveOutputLike>(
        'connectors:resolve',
        ctx,
        { userId: input.resolveAs, connectorId },
      );
      const toolNamespaces = (resolved.toolNamespaces ?? []).map((e) => e.toolNamespace);
      if (toolNamespaces.length === 0) continue;
      await bus.call('tool-policy:snapshot-connector-for-agent', writeCtx, {
        agentId: input.agentId,
        connectorId,
        toolNamespaces,
      });
    } catch (err) {
      // A dangling id (never resolves) is tolerated on attach, so it lands
      // here too. Logged, not thrown — see the function comment.
      ctx.logger.warn('agents_connector_snapshot_failed', {
        agentId: input.agentId,
        connectorId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
