import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';

// ---------------------------------------------------------------------------
// Snapshot-on-attach (TASK-737, connectors rail slice 4; design decision 2).
//
// When a connector is newly attached to an agent, the agent COPIES the
// per-tool defaults the connector's editor set (`tool-policy:snapshot-
// connector-for-agent`). The copy is what makes a later admin LOOSENING not
// silently loosen agents already using the connector; a later TIGHTENING still
// applies, because the default stays a live ceiling inside tool-policy.
// tool-policy also records the namespace as copied (TASK-754), so a tool that
// had NO default at attach stays Ask first instead of following the live one.
// (A connector that reaches the agent WITHOUT an attachment — skill-referenced
// or legacy-owned — is copied by the orchestrator on the agent's first session
// instead. The retired connector "default" is converted into real attachments
// at boot — legacy-default-conversion.ts, TASK-808 — which snapshots with
// `onlyIfNotCopied` so a first-session copy it already got is kept.)
//
// Only NEWLY added ids snapshot. Re-snapshotting an id that was already
// attached would re-copy today's (possibly looser) default over the copy taken
// at attach time — exactly the loosening decision 2 forbids.
//
// OAuth connectors (TASK-809): there is NO admin per-tool ceiling for them.
// The person who signs in decides, so the attach is also where each tool's
// STARTING per-agent verdict is seeded from the MCP server's own hints
// (`connectors:describe-tools`, which lists the tools as the person who just
// attached): `readOnly === true` -> 'allow', anything else (false / unstated)
// -> 'hold' (Ask first). The seeds ride on the same snapshot call as
// `startingVerdicts`; tool-policy honours them only for a namespace whose
// ceiling source is the agent, and only where the agent has no row yet.
//
// Trust note: those hints are the server's UNTRUSTED self-description. The
// owner accepted that for OAuth connectors — the person who signs in is the
// one who decides what the server may do unasked — and tool-policy still
// applies its static rules through `strictest`, so a hint can loosen the
// starting point but never lift a static deny/hold. Only an `ok` inventory is
// used (a stale or failed read seeds nothing), only keys inside the OAuth
// server's own namespace are kept, and the list is capped. A failed or
// missing inventory costs the seeds, never the snapshot: every tool then
// starts at Ask first, the fail-safe direction.
//
// Structural mirrors of the other plugins' hook shapes (Invariant I2).
// ---------------------------------------------------------------------------

interface ResolveOutputLike {
  capabilities?: {
    credentials?: Array<{ kind?: string; server?: string }>;
  };
  toolNamespaces?: Array<{ server: string; toolNamespace: string }>;
}

/** `connectors:describe-tools` (@ax/mcp-client), the slice we read. */
interface DescribeToolsOutputLike {
  status?: string;
  tools?: Array<{ toolKey?: unknown; readOnly?: unknown }>;
}

type StartingVerdict = { toolKey: string; verdict: 'allow' | 'hold' };

const PLUGIN_NAME = '@ax/agents';

/** Same ceiling as the per-agent override list; a hostile server cannot grow the payload past it. */
const MAX_STARTING_VERDICTS = 500;

/**
 * A tool's starting verdict from the server's hint. Mirrors channel-web's
 * `prefillVerdict` (packages/channel-web/src/lib/connector-tool-permissions.ts)
 * so the editor's prefill and the attach-time seed agree — mirrored, not
 * imported (Invariant I2).
 */
function startingVerdictFor(readOnly: unknown): 'allow' | 'hold' {
  return readOnly === true ? 'allow' : 'hold';
}

/**
 * Seed the OAuth servers' tools from `connectors:describe-tools`. Returns []
 * when there is nothing to seed — never throws.
 *
 * `connectors:describe-tools` is registered by @ax/mcp-client and is
 * deliberately NOT declared in this plugin's manifest, neither in `calls` nor
 * in `optionalCalls`: @ax/mcp-client already calls `agents:resolve`, so a
 * declared edge from here would close a plugin call-graph cycle (agents ->
 * mcp-client -> agents) and bootstrap would refuse every preset that loads
 * both. It is `bus.hasService`-guarded at call time instead (same precedent as
 * @ax/connectors' `connectors:describe-tools` call).
 */
async function oauthStartingVerdicts(
  bus: HookBus,
  ctx: AgentContext,
  input: { agentId: string; actorId: string; connectorId: string },
  resolved: ResolveOutputLike,
): Promise<StartingVerdict[]> {
  const oauthServers = new Set<string>();
  for (const slot of resolved.capabilities?.credentials ?? []) {
    if (slot.kind === 'oauth' && typeof slot.server === 'string') oauthServers.add(slot.server);
  }
  if (oauthServers.size === 0) return [];
  const prefixes = (resolved.toolNamespaces ?? [])
    .filter((e) => oauthServers.has(e.server))
    .map((e) => `mcp.${e.toolNamespace}.`);
  if (prefixes.length === 0) return [];
  if (!bus.hasService('connectors:describe-tools')) return [];
  try {
    const out = await bus.call<
      { userId: string; agentId: string; connectorId: string },
      DescribeToolsOutputLike
    >('connectors:describe-tools', ctx, {
      userId: input.actorId,
      agentId: input.agentId,
      connectorId: input.connectorId,
    });
    if (out.status !== 'ok') return [];
    const seeds: StartingVerdict[] = [];
    for (const tool of out.tools ?? []) {
      if (seeds.length >= MAX_STARTING_VERDICTS) break;
      const key = tool.toolKey;
      if (typeof key !== 'string' || !prefixes.some((p) => key.startsWith(p))) continue;
      seeds.push({ toolKey: key, verdict: startingVerdictFor(tool.readOnly) });
    }
    return seeds;
  } catch (err) {
    ctx.logger.warn('agents_connector_hint_seed_failed', {
      agentId: input.agentId,
      connectorId: input.connectorId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

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
      const startingVerdicts = await oauthStartingVerdicts(
        bus,
        ctx,
        { agentId: input.agentId, actorId: input.actorId, connectorId },
        resolved,
      );
      await bus.call('tool-policy:snapshot-connector-for-agent', writeCtx, {
        agentId: input.agentId,
        connectorId,
        toolNamespaces,
        ...(startingVerdicts.length > 0 ? { startingVerdicts } : {}),
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
