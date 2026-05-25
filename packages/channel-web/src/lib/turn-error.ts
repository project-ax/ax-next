/**
 * Fault A — turn the AI-SDK `onError` (raised by the transport's `error`
 * UIMessageChunk when the host emits an SSE `error` frame) into a
 * user-visible error+retry on the agent-status row.
 *
 * Faults B/D (FAULTA-5) — a `done`-less stream close (host bounce / network
 * drop mid-turn) surfaces as an `error` chunk carrying the CONNECTION_LOST
 * sentinel. `handleTurnError` routes that case through a SILENT retry on the
 * first failure, then the same error banner on the second.
 *
 * Kept as pure helpers (no React) so they're unit-testable without rendering
 * `useChat`. The runtime wires them.
 *
 * `regenerate()` re-runs the last user turn — history is persisted
 * server-side and the dead session's `active_session_id` was cleared by
 * `session:terminate`'s conversations subscriber, so retry routes to a
 * fresh sandbox and re-answers.
 */
import { agentStatusActions } from './agent-status-store';
import { CONNECTION_LOST, DEFAULT_TURN_ERROR } from './transport';

export function applyTurnError(error: unknown, retry: () => void): void {
  const text =
    error instanceof Error && error.message ? error.message : DEFAULT_TURN_ERROR;
  agentStatusActions.error(text, { retry });
}

/**
 * True iff this error is a recoverable connection loss (Faults B/D):
 *
 *   - The transport's `done`-less-close sentinel (CONNECTION_LOST) — a
 *     GRACEFUL stream close with no terminal frame (host bounce; SSE body
 *     ended cleanly). Our transport flush() raises this.
 *   - A HARD fetch/network failure `TypeError` — a mid-turn network drop
 *     errors the fetch body ReadableStream, so the transport's flush() is
 *     SKIPPED and the AI SDK surfaces the raw fetch error to onError
 *     ("Failed to fetch", "NetworkError when attempting to fetch the
 *     resource", etc.). This mirrors the AI SDK's own disconnect heuristic
 *     (`chat.ts`: a TypeError whose message includes "fetch"/"network" is
 *     flagged `isDisconnect`). We retry these silently too.
 */
function isConnectionLost(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === CONNECTION_LOST) return true;
  if (error instanceof TypeError) {
    const m = error.message.toLowerCase();
    return m.includes('fetch') || m.includes('network');
  }
  return false;
}

export interface HandleTurnErrorArgs {
  /**
   * The error raised to useChat's onError. The AI SDK reconstructs a plain
   * `Error` from the transport's `error` chunk `errorText`, so we match on
   * `error.message` rather than an Error subclass (which wouldn't survive).
   */
  error: unknown;
  /** True if no silent retry has been spent for the current turn yet. */
  isFirstFailure: boolean;
  /** Re-run the last user turn silently (the runtime's `regenerate()`). */
  silentRetry: () => void;
  /** Surface the error banner with a (manual) retry affordance. */
  showError: (error: unknown) => void;
}

/**
 * Decide between a silent retry and the error banner for a failed turn.
 *
 *   - connection-lost (Faults B/D) AND first failure → SILENT retry: set a
 *     transient working-mode "Connection lost. Retrying…" label (no banner)
 *     and call `silentRetry()`.
 *   - connection-lost AND already retried once → error banner.
 *   - any other error (Fault A / orchestrator-terminated) → error banner
 *     immediately, regardless of attempt count.
 */
export function handleTurnError(args: HandleTurnErrorArgs): void {
  const { error, isFirstFailure, silentRetry, showError } = args;
  if (isConnectionLost(error) && isFirstFailure) {
    // Transient working-mode label — NOT the persistent red error banner.
    // The row stays in working mode so the next turn's RunningEffect hides
    // it cleanly on success (and the AgentStatus error-persistence rule for
    // #137 doesn't latch it open).
    agentStatusActions.set(CONNECTION_LOST);
    silentRetry();
    return;
  }
  showError(error);
}
