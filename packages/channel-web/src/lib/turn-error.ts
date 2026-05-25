/**
 * Turn the AI-SDK `onError` (raised by the transport's `error` UIMessageChunk)
 * into either an automatic whole-turn retry (when the turn is provably dead) or
 * a user-visible error+retry banner (when auto-recovery isn't safe). The runtime
 * (`runtime.tsx`) decides which based on the error's shape; these are the two
 * pure helpers it calls.
 *
 * The transport raises an `error` chunk in two cases:
 *   - Fault A — an orchestrator-terminated turn (server `error` SSE frame),
 *     with a mapped friendly label. The runner is PROVABLY DEAD (the
 *     orchestrator fired chat:turn-error → active_session_id cleared), so an
 *     auto-`regenerate()` routes to a FRESH sandbox: safe to auto-retry. The
 *     runtime calls `autoRetryTurn` (once per turn) with `RETRYING_STATUS`.
 *   - CONNECTION_LOST — a bare mid-turn SSE drop (host bounce / network blip).
 *     The runner may still be alive (TASK-24's IPC retry deadline keeps it
 *     running across a host restart), so neither auto-`regenerate()` (could
 *     duplicate a live turn) nor a silent same-reqId resume (could truncate —
 *     the host chunk-buffer + per-reqId seq cursor are in-memory and reset on a
 *     host restart) is loss-free AND duplicate-free. The runtime calls
 *     `applyTurnError` → the manual-retry banner. The turn itself is durable
 *     (TASK-24 commit-notify deadline), so it hydrates on reload.
 *
 * Kept as pure helpers (no React) so they're unit-testable without rendering
 * `useChat`.
 *
 * `regenerate()` re-runs the last user turn: history is persisted server-side
 * and the dead session's `active_session_id` was cleared by
 * `session:terminate`'s conversations subscriber, so the retry routes to a
 * fresh sandbox and re-answers.
 */
import { agentStatusActions } from './agent-status-store';
import { CONNECTION_LOST, DEFAULT_TURN_ERROR } from './transport';

/**
 * Status shown while an interrupted turn is being automatically re-run
 * (TASK-24 #2 — "auto-retry the whole turn, and show the user a message so they
 * know it's retrying"). Honest: this fires only when the turn is provably dead
 * and a fresh `regenerate()` is in flight.
 */
export const RETRYING_STATUS = 'Session interrupted — retrying…';

/**
 * Decide whether a turn-error is safe to AUTO-RETRY (re-run the whole turn) vs.
 * surface the manual banner. Pure so the runtime stays thin and this is unit-
 * testable. Auto-retry iff BOTH:
 *   - the error is NOT the CONNECTION_LOST sentinel — a CONNECTION_LOST drop
 *     means the runner may still be alive, so a re-`regenerate()` could
 *     duplicate the turn; only an orchestrator `error` frame (any other
 *     message) means the turn is provably dead → a fresh regenerate is safe;
 *   - we haven't ALREADY auto-retried this turn (`alreadyRetried` false) — the
 *     retry is bounded to once so a persistently-dead backend can't loop.
 */
export function shouldAutoRetry(error: unknown, alreadyRetried: boolean): boolean {
  if (alreadyRetried) return false;
  const text = error instanceof Error ? error.message : '';
  return text !== CONNECTION_LOST;
}

/**
 * Auto-retry the whole turn (provably-dead path). Invokes `retry`
 * (`chat.regenerate()`) immediately; the caller has already shown
 * `RETRYING_STATUS` and bounded this to once per turn. If the retry itself
 * fails, the runtime's onError fires again and falls through to
 * `applyTurnError` (the manual banner).
 */
export function autoRetryTurn(retry: () => void): void {
  retry();
}

/**
 * Surface the turn error as a manual-retry banner on the agent-status row.
 * Used for CONNECTION_LOST (auto-recovery unsafe) and as the fallback when an
 * auto-retry also fails.
 */
export function applyTurnError(error: unknown, retry: () => void): void {
  const text =
    error instanceof Error && error.message ? error.message : DEFAULT_TURN_ERROR;
  agentStatusActions.error(text, { retry });
}
