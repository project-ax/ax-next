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
import { DEFAULT_TURN_ERROR, isOrchestratorTurnError } from './transport';

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
 *   - the error is a PROVABLY-DEAD orchestrator terminal `error` frame
 *     (`isOrchestratorTurnError`) — a NARROW allow-list, NOT merely "not
 *     CONNECTION_LOST". The orchestrator cleared active_session_id, so a fresh
 *     regenerate routes to a new sandbox (no duplicate). A `sendMessages`
 *     REJECTION (e.g. "chat-flow SSE open failed" after the POST minted a
 *     reqId, or a POST/network failure of unknown server state) and
 *     CONNECTION_LOST are both EXCLUDED — auto-retrying them could duplicate a
 *     turn that may already be running (Codex);
 *   - we haven't ALREADY auto-retried this turn (`alreadyRetried` false) — the
 *     retry is bounded to once so a persistently-dead backend can't loop.
 */
export function shouldAutoRetry(error: unknown, alreadyRetried: boolean): boolean {
  if (alreadyRetried) return false;
  const text = error instanceof Error ? error.message : '';
  return isOrchestratorTurnError(text);
}

/**
 * The id of the last `user` message in a chat message list, or null if there
 * is none. The runtime uses this to bound the auto-retry to once PER TURN: a
 * `regenerate()` re-runs the SAME last user message (id unchanged → already-
 * retried), while a genuinely new turn appends a new user message (id changes →
 * fresh retry budget). Keyed off message identity rather than `chat.status`
 * because the auto-`regenerate()` itself churns status (Codex).
 */
export function lastUserMessageId(
  messages: ReadonlyArray<{ role: string; id: string }> | undefined,
): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') return m.id;
  }
  return null;
}

/**
 * Auto-retry the whole turn (provably-dead path). The caller has already shown
 * `RETRYING_STATUS` and bounded this to once per turn. If the retry itself
 * fails, the runtime's onError fires again and falls through to
 * `applyTurnError` (the manual banner).
 *
 * DEFERRED, not inline (Codex): this runs from `useChat`'s `onError`, which the
 * AI SDK fires BEFORE the failed request's `setStatus('error')` + the `finally`
 * that clears `activeResponse`. Calling `regenerate()` synchronously here lets
 * the OLD request's teardown overwrite the retry's status/activeResponse — the
 * retry shows the error state or loses its active response. Scheduling on a
 * macrotask (default `setTimeout(…, 0)`) lets the current error callback fully
 * unwind first. `schedule` is an injectable seam for tests.
 */
export function autoRetryTurn(
  retry: () => void,
  schedule: (fn: () => void) => void = (fn) => {
    setTimeout(fn, 0);
  },
): void {
  schedule(retry);
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
