/**
 * Turn the AI-SDK `onError` (raised by the transport's `error` UIMessageChunk)
 * into a user-visible error+retry on the agent-status row.
 *
 * The transport raises an `error` chunk in two cases, BOTH of which surface the
 * manual-retry banner (TASK-24):
 *   - Fault A — an orchestrator-terminated turn (server `error` SSE frame),
 *     with a mapped friendly label.
 *   - CONNECTION_LOST — a bare mid-turn SSE drop (host bounce / network blip).
 *
 * We deliberately do NOT auto-retry. With the current non-idempotent /
 * non-transactional turn model, no client-side auto-retry is both loss-free AND
 * duplicate-free: a same-reqId silent resume truncates across a host restart
 * (the host chunk-buffer + per-reqId seq cursor are in-memory and reset), and an
 * auto-`regenerate()` can duplicate a turn whose runner is still alive and re-run
 * non-idempotent host-tool side effects. The user's explicit retry (the banner
 * button) is the consent that makes a re-run acceptable. (The reported
 * "silently lost turn" is fixed regardless by TASK-24's commit-notify retry
 * deadline — the turn commits and hydrates on reload. A true auto-retry is a
 * follow-up gated on turn-level idempotency + durable runner→host events.)
 *
 * Kept as a pure helper (no React) so it's unit-testable without rendering
 * `useChat`. The runtime wires it: `onError: (e) => applyTurnError(e, () =>
 * chat.regenerate())`.
 *
 * `regenerate()` (the manual banner retry — a deliberate user action) re-runs
 * the last user turn: history is persisted server-side and the dead session's
 * `active_session_id` was cleared by `session:terminate`'s conversations
 * subscriber, so the retry routes to a fresh sandbox and re-answers.
 */
import { agentStatusActions } from './agent-status-store';
import { DEFAULT_TURN_ERROR } from './transport';

export function applyTurnError(error: unknown, retry: () => void): void {
  const text =
    error instanceof Error && error.message ? error.message : DEFAULT_TURN_ERROR;
  agentStatusActions.error(text, { retry });
}
