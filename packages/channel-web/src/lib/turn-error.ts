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
 * THIS ROW IS A PUBLISHING SURFACE, SO IT HAS AN ALLOW-LIST (TASK-288).
 * It renders directly above the composer, and it used to print `error.message`
 * whatever that message was — which is how `chat-flow POST failed: 401
 * Unauthorized` ended up in front of readers. An error only gets to speak here
 * if we can point at where its words came from:
 *
 *   - an `HttpError`, whose message is authored copy by construction; or
 *   - one of the transport's own sentences (`CONNECTION_LOST`,
 *     `DEFAULT_TURN_ERROR`, an `ERROR_LABELS` value). Fault A appends an
 *     untrusted-but-clamped `detail` line under the label, so the match is on
 *     the FIRST LINE and the rest rides along.
 *
 * Anything else — a bug in our own code, a stray SDK message, a future module
 * that throws a raw string — gets `DEFAULT_TURN_ERROR` on screen and its real
 * message in the console, where it is useful and harmless.
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
import { HttpError } from './http';
import {
  CONNECTION_LOST,
  DEFAULT_TURN_ERROR,
  ERROR_LABELS,
} from './transport';

/**
 * Built once, from the same constants the transport emits, so adding a turn
 * error reason to `ERROR_LABELS` cannot forget to update this.
 */
const AUTHORED_HEADLINES: ReadonlySet<string> = new Set<string>([
  CONNECTION_LOST,
  DEFAULT_TURN_ERROR,
  ...Object.values(ERROR_LABELS),
]);

/** The message if we can vouch for it, otherwise `null`. */
function authoredMessage(error: unknown): string | null {
  if (error instanceof HttpError) return error.message;
  if (!(error instanceof Error) || error.message === '') return null;
  // Fault A sends `${label}\n${detail}`; the label is what we recognise.
  const headline = error.message.split('\n', 1)[0] ?? '';
  return AUTHORED_HEADLINES.has(headline) ? error.message : null;
}

export function applyTurnError(error: unknown, retry: () => void): void {
  const text = authoredMessage(error);
  if (text === null) {
    // Quiet on screen is not silent anywhere else: whatever this was, an
    // operator still wants it.
    console.warn('[chat] the turn ended with an error we do not publish', error);
  }
  agentStatusActions.error(text ?? DEFAULT_TURN_ERROR, { retry });
}
