import { createHash } from 'node:crypto';

/**
 * Per-agent scope key for the memory index (TASK-186, repartitioned TASK-257).
 *
 * The `memory:index:*` store is a SINGLE shared store across every agent in a
 * deployment (one sqlite db / one postgres table). Keying rows only by docId
 * pooled every agent's facts together — agent A's `memory_search` could return
 * agent B's. We scope every row by this key, derived from the calling agent's
 * context, so the store is partitioned per `agentId`.
 *
 * The partition is `agentId` ALONE — deliberately not `userId`, `ownerId` or
 * `teamId`. One agent, one memory. Every user authorized to reach an agent
 * reads and writes the same memory, which is what makes a team agent's memory
 * useful to the team. `agent_id` is a `TEXT PRIMARY KEY`, so it is globally
 * unique and sufficient on its own. Until 2026-09-17 the key was
 * `sha256(JSON.stringify([userId, agentId]))`; TASK-257 changed it and
 * **knowingly abandoned** the existing partitions rather than migrate them.
 *
 * ⚠ This key is NOT an access control — it never was one at the surface, and
 * after TASK-257 it does not even isolate per caller. The barrier is the
 * `agents:resolve` ACL that `routes-workspace.ts` runs before every per-agent
 * read.
 *
 * ⚠ LOCKSTEP — the derivation mirrors `@ax/workspace-git-server`'s
 * `workspaceIdFor` (same `sha256(JSON.stringify([agentId]))`, same 16-hex
 * truncation) so the index partition lines up with the file-tier partition.
 * Invariant 2 (no cross-plugin imports) forbids importing that helper, so each
 * index backend carries its own copy (like `MAX_TOP_K`), byte-for-byte
 * identical to `@ax/memory-strata-index-postgres`'s.
 *
 * How the lockstep is ENFORCED: pinned vectors in `__tests__/
 * agent-scope-key.test.ts`, over the same inputs and with the same literal
 * digests as the sibling copies' pins. Editing one copy fails that copy's pins.
 * This docstring previously claimed drift was "caught by the shared
 * `runIndexContract` isolation case" — it was not, and that was measured
 * (TASK-257): replacing this derivation wholesale left all 35 tests green,
 * because the isolation case varies userId AND agentId together and so passes
 * under any partition containing either field. It proves rows are not pooled;
 * it says nothing about how the key is computed.
 *
 * We never store the raw agentId — only this opaque digest — so no tenant
 * identity leaks into the storage layer.
 */
export function agentScopeKey(ctx: { agentId: string }): string {
  const keyMaterial = JSON.stringify([ctx.agentId]);
  return createHash('sha256').update(keyMaterial).digest('hex').slice(0, 16);
}
