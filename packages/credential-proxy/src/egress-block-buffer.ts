// ---------------------------------------------------------------------------
// SessionEgressBlockBuffer — per-session accumulator of allowlist-blocked hosts.
//
// When the proxy denies an egress on an allowlist miss, the agent's tool (e.g.
// `npx` downloading a prebuilt binary from a GitHub release) sees only a
// cryptic `statusCode=403` and flails. The buffer records the blocked host
// against the attributed session so the runner can drain it at PostToolUse and
// inject an actionable remediation note into the agent's context.
//
// Deliberately mechanism-free and tiny: it stores (sessionId → set of hosts)
// and nothing else. The caller (plugin onAudit) decides WHAT to record — only
// `blockedReason === 'allowlist'` blocks, never `private-ip` / `canary` (those
// are security blocks we must NOT coach the agent around). `drain` is
// surface-once: it returns and clears, so each blocked host is injected at most
// once per accumulation window.
//
// NOT a source of egress truth and NOT an allow/deny input — purely a
// best-effort, capped, read-back of the agent's OWN already-attempted
// destinations. A drained host reveals nothing the agent didn't already know
// (it issued the request); see the IPC handler's security note.
// ---------------------------------------------------------------------------

/** Default per-session host cap — bounds memory against a looping agent that
 *  hammers thousands of distinct blocked hosts. The first N blocked hosts are
 *  the useful ones; extras are dropped. */
const DEFAULT_MAX_HOSTS_PER_SESSION = 32;

export class SessionEgressBlockBuffer {
  private readonly bySession = new Map<string, Set<string>>();

  constructor(
    private readonly maxHostsPerSession: number = DEFAULT_MAX_HOSTS_PER_SESSION,
  ) {}

  /**
   * Record an allowlist-blocked host for a session. No-op when either argument
   * is empty (an unattributed block — no session token resolved — has no owner
   * to surface it to) or when the session is already at its host cap.
   */
  record(sessionId: string, host: string): void {
    if (sessionId.length === 0 || host.length === 0) return;
    let set = this.bySession.get(sessionId);
    if (set === undefined) {
      set = new Set<string>();
      this.bySession.set(sessionId, set);
    }
    if (set.has(host)) return;
    if (set.size >= this.maxHostsPerSession) return;
    set.add(host);
  }

  /**
   * Return the session's accumulated blocked hosts (insertion order) AND clear
   * them. An unknown session yields `[]`.
   */
  drain(sessionId: string): string[] {
    const set = this.bySession.get(sessionId);
    if (set === undefined) return [];
    this.bySession.delete(sessionId);
    return [...set];
  }

  /** Drop a session's accumulator without surfacing it (close-session). */
  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
