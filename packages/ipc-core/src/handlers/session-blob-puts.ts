import type { AgentContext } from '@ax/core';

// ---------------------------------------------------------------------------
// Which shas has THIS session's own `blob.put` returned? (TASK-1010)
//
// `artifact.publish` records a row that lets the conversation's owner download
// a blob through `/api/files`. The blob store is shared and content-addressed,
// so a sha alone is not a capability: a runner that learned someone else's hash
// (a prompt-injected agent, say) must not be able to publish that blob into its
// own conversation, nor probe whether a hash is stored at all. So the host
// remembers each sha a session's `blob.put` handed back, and `artifact.publish`
// accepts only those. The runner never supplies this set.
//
// The key is the session, its user and its bound conversation, all stamped by
// the listener from the bearer token, never from a request body.
//
// In memory, and bounded. The host runs as a single replica (the chart refuses
// more), and the runner's artifact path is `blob.put` immediately followed by
// `artifact.publish` inside one tool call, so a host restart between the two
// costs one failed publish that a retry (put + publish again) clears. The
// bounds stop a looping runner from growing host memory without limit; the
// per-session cap means one session's puts can only evict its own entries.
// ---------------------------------------------------------------------------

/**
 * Most recent shas remembered per session. A publish follows its put at once,
 * so only a handful are ever outstanding; 64 keeps the whole map near 25 MiB
 * worst case (4096 x 64 entries) even if a runner floods puts.
 */
export const MAX_SHAS_PER_SESSION = 64;
/** Most recently active sessions remembered. */
export const MAX_SESSIONS = 4096;

// Map/Set iteration is insertion order, so the first entry is the oldest.
const putsBySession = new Map<string, Set<string>>();

function sessionKey(ctx: AgentContext): string {
  return JSON.stringify([ctx.sessionId, ctx.userId, ctx.conversationId ?? null]);
}

/** Remember that this session's `blob.put` returned `sha256`. */
export function recordSessionBlobPut(ctx: AgentContext, sha256: string): void {
  const key = sessionKey(ctx);
  const shas = putsBySession.get(key) ?? new Set<string>();
  // Refresh recency for both the session and the sha.
  putsBySession.delete(key);
  putsBySession.set(key, shas);
  shas.delete(sha256);
  shas.add(sha256);
  if (shas.size > MAX_SHAS_PER_SESSION) {
    const oldest = shas.values().next().value;
    if (oldest !== undefined) shas.delete(oldest);
  }
  if (putsBySession.size > MAX_SESSIONS) {
    const oldestSession = putsBySession.keys().next().value;
    if (oldestSession !== undefined) putsBySession.delete(oldestSession);
  }
}

/** Did this session's own `blob.put` return `sha256`? */
export function sessionPutBlob(ctx: AgentContext, sha256: string): boolean {
  return putsBySession.get(sessionKey(ctx))?.has(sha256) ?? false;
}

/** Test-only: forget every session. */
export function resetSessionBlobPutsForTests(): void {
  putsBySession.clear();
}
