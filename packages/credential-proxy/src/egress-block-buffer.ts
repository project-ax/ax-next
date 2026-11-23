// ---------------------------------------------------------------------------
// SessionEgressBlockBuffer — per-session, capped, surface-once set of hosts.
//
// The plugin keeps two instances, one per agent-visible note:
//
//   1. Blocked hosts (`egressBlocks`). When the proxy denies an egress on an
//      allowlist miss, the agent's tool (e.g. `npx` downloading a prebuilt
//      binary from a GitHub release) sees only a cryptic `statusCode=403` and
//      flails. The plugin records the blocked host against the attributed
//      session so the runner can drain it at PostToolUse and inject an
//      actionable remediation note into the agent's context. The caller
//      (plugin onAudit) decides WHAT to record — only `blockedReason ===
//      'allowlist'` blocks, never `private-ip` / `canary` (those are security
//      blocks we must NOT coach the agent around).
//
//   2. Hosts allowed since the last drain (`allowedSinceDrain`, TASK-1199).
//      `proxy:add-host` (a person's own Allow click) records a host it newly
//      put on a live session's allowlist, and the runner drains it at the
//      start of the person's next turn to tell the agent the host is now
//      allowed. `proxy:open-session` also records the sites kept for the agent
//      while it wasn't running (TASK-1212, `newlyAllowedHosts`), each one only
//      if it is on the new session's allowlist.
//
// Deliberately mechanism-free and tiny: it stores (sessionId → set of hosts)
// and nothing else. `drain` is surface-once: it returns and clears, so each
// host is injected at most once per accumulation window.
//
// NOT a source of egress truth and NOT an allow/deny input — the live session
// allowlist is the only gate. This is purely a best-effort, capped read-back
// of hosts the agent already knows about or can learn by retrying: ones it
// tried to reach, or ones a person allowed for its session. See the IPC
// handlers' security notes.
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
   * Record a host for a session (a blocked host, or one a person allowed —
   * each use has its own instance). No-op when either argument
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
   * Return the session's accumulated hosts (insertion order) AND clear
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
