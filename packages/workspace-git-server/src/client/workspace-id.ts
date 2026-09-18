/**
 * Derives a stable workspaceId from the agentId.
 *
 * Output shape: `ws-` + first 16 hex chars of
 * sha256(JSON.stringify([agentId])).
 * Length 19, lowercase hex, always satisfies WORKSPACE_ID_REGEX
 * (`^[a-z0-9][a-z0-9_-]{0,62}$`) — starts with `w`, only `[a-z0-9-]`.
 *
 * ONE AGENT, ONE WORKSPACE. The partition is `agentId` alone — deliberately
 * not `userId`, `ownerId`, or `teamId`. An agent's workspace belongs to the
 * agent, and every user authorized to reach that agent sees the same files.
 * `agent_id` is a `TEXT PRIMARY KEY`, so it is globally unique and sufficient
 * on its own. (A team agent's `owner_id` is a TEAM id, not a user id, so
 * "the owner's shard" was never a coherent target; ax consumes team
 * membership, it does not administrate teams.)
 *
 * ⚠ SECURITY — this hash is NOT an access control. It used to be
 * defense-in-depth: the derivation included the caller's `userId`, so if the
 * ACL ever failed open a non-owner still landed in their own empty shard. That
 * property is gone on purpose, because it contradicts the feature — files
 * shared across a team and per-caller hash isolation cannot both be true. The
 * ONLY barrier is now the `agents:resolve` ACL that `routes-workspace.ts` runs
 * before every per-agent read (any PluginError → 404). That gate is
 * load-bearing: it must not be bypassed, made best-effort, or moved after the
 * read.
 *
 * ⚠ HISTORY — this derivation WAS `sha256(JSON.stringify([userId, agentId]))`,
 * and this docstring used to warn that changing it would orphan every existing
 * workspace's bare repo. It did, and that was **accepted deliberately on
 * 2026-09-17** (TASK-257): the workspace is becoming the shared surface for
 * team agents, and the requester chose to abandon the existing per-(user,
 * agent) repos rather than migrate them. So the orphaning is not a regression
 * — but stability is load-bearing again from here on, for exactly the old
 * reason (a workspace's shard is computed from its workspaceId, so a different
 * workspaceId points at a different shard with no repo there). The
 * pinned-output tests in `__tests__/workspace-id.test.ts` exist to catch
 * unintentional drift across SHA-256 implementation or formatting changes.
 *
 * ⚠ LOCKSTEP — `@ax/memory-strata-index-postgres` and
 * `@ax/memory-strata-index-sqlite` each carry an `agent-scope-key.ts` that
 * mirrors this derivation, so the memory-index partition lines up with the
 * file-tier partition. Invariant 2 (no cross-plugin imports) forbids sharing
 * the code, so the three copies must change together. Each carries pinned
 * vectors over the same inputs; editing one copy fails that copy's pins, which
 * is what makes the lockstep enforceable rather than aspirational.
 *
 * `JSON.stringify([agentId])` — rather than the bare `agentId` — keeps the
 * encoding self-describing and leaves the single-element array as the obvious
 * place to look when someone next wonders what is in the key. With one field
 * there is nothing for a separator-shaped character to bleed into, so the
 * pair-collision hazard the two-field encoding was defending against no longer
 * exists.
 */
import { createHash } from 'node:crypto';

export function workspaceIdFor(ctx: { agentId: string }): string {
  const keyMaterial = JSON.stringify([ctx.agentId]);
  const h = createHash('sha256').update(keyMaterial).digest('hex');
  return `ws-${h.slice(0, 16)}`;
}
