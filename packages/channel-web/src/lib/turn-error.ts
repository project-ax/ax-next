/**
 * Fault A — turn the AI-SDK `onError` (raised by the transport's `error`
 * UIMessageChunk when the host emits an SSE `error` frame) into a
 * user-visible error+retry on the agent-status row.
 *
 * Kept as a pure helper (no React) so it's unit-testable without rendering
 * `useChat`. The runtime wires it: `onError: (e) => applyTurnError(e, () =>
 * chat.regenerate())`.
 *
 * `regenerate()` re-runs the last user turn — history is persisted
 * server-side and the dead session's `active_session_id` was cleared by
 * `session:terminate`'s conversations subscriber, so retry routes to a
 * fresh sandbox and re-answers.
 */
import { agentStatusActions } from './agent-status-store';
import { DEFAULT_TURN_ERROR } from './transport';

export function applyTurnError(error: unknown, retry: () => void): void {
  const text =
    error instanceof Error && error.message ? error.message : DEFAULT_TURN_ERROR;
  agentStatusActions.error(text, { retry });
}
