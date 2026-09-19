import { createHash } from 'node:crypto';

/**
 * Per-agent scope key for the memory-facts engine (TASK-421).
 *
 * The `memory:facts:*` store is a SINGLE shared store across every agent in a
 * deployment (one sqlite db). Keying rows only by id would pool every agent's
 * facts together — agent A's `memory:facts:recall` could return agent B's.
 * We scope every row by this key, derived from the calling agent's context,
 * so the store is partitioned per `agentId`.
 *
 * The partition is `agentId` ALONE — deliberately not `userId`, `ownerId` or
 * `teamId`. One agent, one memory. Every user authorized to reach an agent
 * reads and writes the same memory, which is what makes a team agent's memory
 * useful to the team.
 *
 * ⚠ This key is NOT an access control — the barrier is the `agents:resolve`
 * ACL that runs before every per-agent read.
 *
 * ⚠ LOCKSTEP — this is BYTE-FOR-BYTE the same derivation as
 * `@ax/memory-strata-index-sqlite`'s `agent-scope-key.ts` (and its postgres
 * sibling, and `@ax/workspace-git-server`'s `workspaceIdFor`): same
 * `sha256(JSON.stringify([agentId]))`, same 16-hex truncation, so this
 * engine's partition lines up with the index tier and the file tier.
 * Invariant 2 (no cross-plugin imports) forbids importing that helper, so
 * this package carries its own copy.
 *
 * How the lockstep is ENFORCED: pinned vectors in `__tests__/
 * agent-scope-key.test.ts`, using the SAME literal inputs and digests as the
 * sibling packages' pins (per the TASK-257 lesson: the isolation-only cases
 * in the shared contract vary userId AND agentId together and so pass under
 * any partition containing either field — they don't catch derivation
 * drift; only these pinned vectors do).
 *
 * We never store the raw agentId — only this opaque digest — so no tenant
 * identity leaks into the storage layer.
 */
export function agentScopeKey(ctx: { agentId: string }): string {
  const keyMaterial = JSON.stringify([ctx.agentId]);
  return createHash('sha256').update(keyMaterial).digest('hex').slice(0, 16);
}
