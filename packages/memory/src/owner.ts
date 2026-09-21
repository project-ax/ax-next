import { PluginError, isOwnerlessId, type AgentContext } from '@ax/core';

import { PLUGIN_NAME } from './plugin-name.js';

/**
 * Resolve the owner of the statements this call reads or writes — design
 * §3.2 and §6.1.
 *
 * Ownership is **always** `ctx.userId`, and that is the whole rule. It is a
 * SCOPE, not a hint (the `@ax/decisions` phrasing): every row `@ax/memory`
 * writes is stamped with it and every read is filtered by it, so a person
 * sees the statements they own and nobody else's — behaviourally identical to
 * what Strata's per-(caller, agent) keying gives today, now that the store
 * itself is keyed by `agentId` alone.
 *
 * It is taken from `ctx` and never from a payload, which is the security
 * property: a caller that could name an owner could read or retract another
 * person's memory. The tenant (`ctx.agentId`) is ambient for the same reason,
 * and is the engine's business, not ours.
 *
 * **A conversation with no live person is not an exception.** A routine fire
 * mints its context with `source: 'routine'` and the ROUTINE OWNER's real
 * userId (`@ax/routines`' fire path stamps `row.ownerUserId`, which
 * `agents:resolve` then gates), and the orchestrator passes that context
 * through unchanged. So this function does not branch on `source`, and
 * deliberately so: a branch here is exactly where a
 * `'system'`/`'anonymous'`/`''` owner would get invented, and a synthetic
 * owner is a bucket every unattributed statement falls into and every user of
 * a shared agent can then read.
 *
 * ## The two refusals
 *
 * `AgentContext.userId` is typed as a required non-empty string, so neither
 * check can fire on a well-formed turn. Both exist because the failure they
 * prevent is silent and permanent: a row written under a non-owner is
 * invisible to every owner-scoped read afterwards (the engine matches
 * `ownerUserId` by strict equality), so it is not "stored badly", it is
 * stored nowhere anyone will look.
 *
 * 1. **No usable string.** Only reachable via a hand-built context — which is
 *    precisely the path that would otherwise write an unattributed row.
 *
 * 2. **An owner-LESS id.** `ownerlessIdFor(sessionId)` is what the kernel
 *    stamps when a session resolves with no (user, agent) pair at all — the
 *    canary and `ax serve` mint them. It is a perfectly good non-empty string
 *    that simply isn't anybody's, so a null check does not catch it; that is
 *    the whole reason `isOwnerlessId` lives in the kernel. Memory joins the
 *    REFUSE side of that split (`@ax/workspace-git-core`,
 *    `@ax/workspace-git-server`, `skill.propose`, `connector_propose`) rather
 *    than the merely-partition side the memory-strata index backends are on:
 *    a private per-session partition of a person's *memory* is a store that
 *    accumulates rows nobody will ever read back, and "remembered" is a
 *    promise we would be breaking quietly.
 */
export function resolveOwnerUserId(ctx: AgentContext): string {
  const userId: unknown = ctx.userId;
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message:
        'ctx.userId is required: a memory statement is owned by a real user, and no synthetic owner is ever substituted',
    });
  }
  if (isOwnerlessId(userId)) {
    throw new PluginError({
      code: 'forbidden',
      plugin: PLUGIN_NAME,
      message:
        'this session has no owner, and memory is owner-scoped: a statement stored under an owner-less id could never be read back by anyone',
    });
  }
  return userId;
}
