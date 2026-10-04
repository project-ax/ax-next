import { makeAgentContext, PluginError, type HookBus, type Logger } from '@ax/core';
import { teamConnectorRole } from './connector-manage.js';
import { validateConnectorId, type AgentStore } from './store.js';
import type { Agent } from './types.js';

// ---------------------------------------------------------------------------
// TASK-808 — convert legacy connector defaults into explicit attachments.
//
// A connector "default" (`default_attached` on the @ax/connectors row) used to
// reach every session its OWNER ran, on any agent that owner could chat with.
// The flag is gone from the product; this one-shot conversion, run at the end
// of agents init, turns each remaining flagged row into attachments on the
// agents where the owner could have attached it themselves:
//
//   - the owner's personal agents;
//   - team agents where the owner is a team admin (TASK-798's rule — an
//     attachment there reaches every member's runs, so we only do what the
//     owner could have done by hand). A plain-member team agent is skipped
//     with a log line; a team the owner is not in is not a target at all.
//
// Per connector: attach (row-locked, idempotent) → snapshot its per-tool
// defaults with `onlyIfNotCopied` (an agent that already got verdict rows from
// the orchestrator's first-session copy keeps them) → clear the flag. The clear
// happens only when nothing TRANSIENT went wrong; deterministic skips (excluded,
// 50-cap, not team admin) are logged and do not block it. So a crash or a
// thrown hook leaves the flag set and the next boot retries — the attach is a
// no-op the second time and the snapshot copies nothing new.
//
// Never throws: a failure here is logged and boot continues.
//
// The connectors side is reached only through two transitional hooks
// (`connectors:list-legacy-defaults`, `connectors:clear-legacy-default`) —
// structural mirrors below, no @ax/connectors import (Invariant I2).
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/agents';
const EVENT = 'agents_legacy_default_';

interface LegacyDefault {
  ownerUserId: string;
  connectorId: string;
}

interface ResolveOutputLike {
  toolNamespaces?: Array<{ server: string; toolNamespace: string }>;
}

export interface LegacyDefaultConversionDeps {
  bus: HookBus;
  store: Pick<AgentStore, 'listAll' | 'attachConnector'>;
  logger: Logger;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function convertLegacyConnectorDefaults(
  deps: LegacyDefaultConversionDeps,
): Promise<void> {
  const { bus, logger } = deps;
  if (!bus.hasService('connectors:list-legacy-defaults')) return;
  try {
    const listCtx = makeAgentContext({
      sessionId: 'init',
      agentId: PLUGIN_NAME,
      userId: 'system',
      logger,
    });
    let legacy: LegacyDefault[];
    try {
      const out = await bus.call<Record<string, never>, { connectors: LegacyDefault[] }>(
        'connectors:list-legacy-defaults',
        listCtx,
        {},
      );
      legacy = out.connectors;
    } catch (err) {
      logger.warn(`${EVENT}list_failed`, { err: errMessage(err) });
      return;
    }
    if (legacy.length === 0) return;

    const agents = await deps.store.listAll();
    for (const entry of legacy) {
      await convertOne(deps, agents, entry);
    }
  } catch (err) {
    logger.warn(`${EVENT}conversion_failed`, { err: errMessage(err) });
  }
}

async function convertOne(
  deps: LegacyDefaultConversionDeps,
  agents: Agent[],
  entry: LegacyDefault,
): Promise<void> {
  const { bus, logger, store } = deps;
  const { ownerUserId } = entry;
  let connectorId: string;
  try {
    connectorId = validateConnectorId(entry.connectorId);
    if (typeof ownerUserId !== 'string' || ownerUserId.length === 0) {
      throw new Error('ownerUserId must be a non-empty string');
    }
  } catch (err) {
    // Left flagged: nothing to attach, and a clear would be refused the same way.
    logger.warn(`${EVENT}invalid_row`, {
      ownerUserId,
      connectorId: entry.connectorId,
      err: errMessage(err),
    });
    return;
  }

  // Everything below acts AS the connector's owner — a real user — never a
  // synthetic actor (no agents:resolve here; we read our own store).
  const ctx = makeAgentContext({
    sessionId: 'init',
    agentId: PLUGIN_NAME,
    userId: ownerUserId,
    logger,
  });
  let failed = false;
  let attached = 0;
  let skipped = 0;
  const skip = (agentId: string, reason: string): void => {
    skipped += 1;
    logger.warn(`${EVENT}skipped`, { ownerUserId, connectorId, agentId, reason });
  };

  // 1. Targets: the owner's personal agents + team agents the owner administers.
  const targets: Agent[] = [];
  const roleByTeam = new Map<string, 'admin' | 'member' | 'none'>();
  for (const agent of agents) {
    if (agent.visibility === 'personal') {
      if (agent.ownerType === 'user' && agent.ownerId === ownerUserId) targets.push(agent);
      continue;
    }
    if (agent.ownerType !== 'team') continue;
    let role = roleByTeam.get(agent.ownerId);
    if (role === undefined) {
      try {
        // `teams:is-member` is a runtime-only peer (not a declared call), so
        // @ax/teams may simply not be initialized yet. teamConnectorRole reads
        // `no-service` as "not a member", which here would silently drop the
        // team agent AND clear the flag. Treat it as transient instead: keep
        // the flag so the next boot finishes the job.
        if (!bus.hasService('teams:is-member')) {
          throw new Error('teams:is-member is not registered');
        }
        role = await teamConnectorRole(bus, ctx, agent.ownerId, ownerUserId);
      } catch (err) {
        failed = true;
        logger.warn(`${EVENT}team_lookup_failed`, {
          ownerUserId,
          connectorId,
          agentId: agent.id,
          err: errMessage(err),
        });
        continue;
      }
      roleByTeam.set(agent.ownerId, role);
    }
    if (role === 'admin') targets.push(agent);
    else if (role === 'member') skip(agent.id, 'not-team-admin');
  }

  // Namespaces depend only on the connector record — resolve once, lazily.
  let namespaces: string[] | undefined;
  const snapshotReady =
    bus.hasService('connectors:resolve') &&
    bus.hasService('tool-policy:snapshot-connector-for-agent');

  for (const agent of targets) {
    // 2. An exclusion means the default was not effective on this agent.
    if (agent.connectorExclusions.includes(connectorId)) {
      skip(agent.id, 'excluded');
      continue;
    }
    // 3. Attach (idempotent; a re-run finds it already there).
    try {
      const out = await store.attachConnector(agent.id, connectorId);
      if (out.changed) attached += 1;
    } catch (err) {
      if (err instanceof PluginError && err.code === 'invalid-payload') {
        skip(agent.id, 'attachment-cap');
        continue;
      }
      if (err instanceof PluginError && err.code === 'not-found') {
        skip(agent.id, 'agent-gone');
        continue;
      }
      failed = true;
      logger.warn(`${EVENT}attach_failed`, {
        ownerUserId,
        connectorId,
        agentId: agent.id,
        err: errMessage(err),
      });
      continue;
    }
    // 4. Snapshot — even when the attach was a no-op, so a crash between
    // attach and snapshot heals. onlyIfNotCopied keeps rows the agent already
    // has (from the orchestrator's first-session copy or an earlier run).
    if (!snapshotReady) continue;
    try {
      if (namespaces === undefined) {
        const resolved = await bus.call<{ userId: string; connectorId: string }, ResolveOutputLike>(
          'connectors:resolve',
          ctx,
          { userId: ownerUserId, connectorId },
        );
        namespaces = (resolved.toolNamespaces ?? []).map((e) => e.toolNamespace);
      }
      if (namespaces.length === 0) continue;
      await bus.call('tool-policy:snapshot-connector-for-agent', ctx, {
        agentId: agent.id,
        connectorId,
        toolNamespaces: namespaces,
        onlyIfNotCopied: true,
      });
    } catch (err) {
      failed = true;
      logger.warn(`${EVENT}snapshot_failed`, {
        ownerUserId,
        connectorId,
        agentId: agent.id,
        err: errMessage(err),
      });
    }
  }

  // 5. Clear the flag only when nothing transient went wrong.
  let cleared = false;
  if (!failed && bus.hasService('connectors:clear-legacy-default')) {
    try {
      await bus.call<LegacyDefault, { cleared: boolean }>(
        'connectors:clear-legacy-default',
        ctx,
        { ownerUserId, connectorId },
      );
      cleared = true;
    } catch (err) {
      logger.warn(`${EVENT}clear_failed`, { ownerUserId, connectorId, err: errMessage(err) });
    }
  }
  logger.info(`${EVENT}converted`, {
    ownerUserId,
    connectorId,
    targets: targets.length,
    attached,
    skipped,
    cleared,
    retryNextBoot: !cleared,
  });
}
