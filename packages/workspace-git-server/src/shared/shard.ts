import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Workspace -> shard routing.
//
// Hashing primitive: SHA-256, take the first 4 bytes (uint32 BE), `mod N`.
// Why SHA-256-truncated and not CRC32 / MurmurHash / xxHash:
//   - Already in the Node stdlib (`node:crypto`); no new runtime dep.
//   - Uniform distribution at our scale (single-digit % deviation across 10k
//     ids, well within the slice spec's tolerance).
//   - Deterministic across host replicas, OS versions, Node versions —
//     `crypto.createHash('sha256')` is OpenSSL-backed and stable.
//   - Workspace IDs are first-party (regex-validated, see workspace-id.ts);
//     adversarial collision crafting is not in the threat model. Even if it
//     were, SHA-256 truncation is collision-resistant enough for routing.
//
// Modulo bias: trivial at our shard counts. With a 32-bit input space and
// shard counts up to ~256, the bias is < 2^-24 — undetectable.
// ---------------------------------------------------------------------------

export function shardForWorkspace(
  workspaceId: string,
  shards: number,
): number {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error('shards must be a positive integer');
  }
  const hash = createHash('sha256').update(workspaceId).digest();
  const top4 = hash.readUInt32BE(0);
  return top4 % shards;
}

export interface ShardUrlOptions {
  /** Headless service name, e.g. "ax-next-git-server-headless". */
  serviceName: string;
  /** Kubernetes namespace the StatefulSet lives in. */
  namespace: string;
  /** Port the git-server listens on. */
  port: number;
  /** StatefulSet ordinal — the result of shardForWorkspace(). */
  shardIndex: number;
}

/**
 * Build the per-shard pod URL using the StatefulSet stable-DNS pattern:
 *
 *   <pod>.<headless-svc>.<ns>.svc.cluster.local
 *
 * `pod` is `<sts-name>-<ordinal>` and `sts-name` mirrors the headless
 * service name with the `-headless` suffix stripped. If the service name
 * doesn't end in `-headless` the strip is a no-op (so callers passing a
 * raw service name still get a sane result).
 */
export function shardUrl(opts: ShardUrlOptions): string {
  const stsName = opts.serviceName.replace(/-headless$/, '');
  return `http://${stsName}-${opts.shardIndex}.${opts.serviceName}.${opts.namespace}.svc.cluster.local:${opts.port}`;
}
