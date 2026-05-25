/**
 * Turn the AI-SDK `onError` (raised by the transport's `error` UIMessageChunk)
 * into a user-visible error+retry on the agent-status row.
 *
 * The transport raises an `error` chunk in two cases:
 *   - Fault A — an orchestrator-terminated turn (server `error` SSE frame),
 *     with a mapped friendly label.
 *   - Faults B/D (FAULTA-5) — a CONNECTION_LOST sentinel, emitted ONLY after
 *     the transport exhausted its transparent same-reqId reconnect attempts
 *     (host bounce / sustained network drop). Silent recovery already happened
 *     transport-side (idempotent GET reconnects), so the right move here is
 *     the error banner.
 *
 * Kept as a pure helper (no React) so it's unit-testable without rendering
 * `useChat`. The runtime wires it: `onError: (e) => applyTurnError(e, () =>
 * chat.regenerate())`.
 *
 * `regenerate()` (the manual banner retry — a deliberate user action) re-runs
 * the last user turn: history is persisted server-side and the dead session's
 * `active_session_id` was cleared by `session:terminate`'s conversations
 * subscriber, so retry routes to a fresh sandbox and re-answers.
 */
import { agentStatusActions } from './agent-status-store';
import { DEFAULT_TURN_ERROR } from './transport';

export function applyTurnError(error: unknown, retry: () => void): void {
  const text =
    error instanceof Error && error.message ? error.message : DEFAULT_TURN_ERROR;
  agentStatusActions.error(text, { retry });
}
