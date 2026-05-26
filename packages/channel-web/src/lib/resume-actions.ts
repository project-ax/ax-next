/**
 * Resume seam for the JIT permission card (design §7). After the user approves
 * a capability (POST /api/chat/permission-decision attaches the skill + retires
 * the warm session), the conversation must RE-ISSUE the original turn so it
 * re-spawns + resumes and the agent answers. We reuse the runtime's existing
 * `regenerate()` — the exact "terminated session -> fresh re-spawn -> resume ->
 * re-run last user turn" path the retry banner uses (runtime.tsx). The runtime
 * registers its `regenerate` here; the card calls `continueAfterGrant()`.
 *
 * No secret, no transcript, no SSE here — purely a client-side trigger. The
 * answer turn streams over the normal POST -> /api/chat/stream/:reqId flow, so
 * no new client stream machinery ships.
 */
let regenerate: (() => void) | null = null;

export const resumeActions = {
  /** Runtime wires its `chat.regenerate` here on mount. Latest wins. */
  registerRegenerate(fn: () => void): void {
    regenerate = fn;
  },
  /** Re-issue the pending original turn after a grant lands. No-op if unwired. */
  continueAfterGrant(): void {
    regenerate?.();
  },
  /** Test seam. */
  reset(): void {
    regenerate = null;
  },
};
