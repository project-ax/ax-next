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
 * True iff this error is a recoverable connection loss that is SAFE to retry
 * silently (Faults B/D).
 *
 * We match ONLY the transport's `CONNECTION_LOST` sentinel. The transport is
 * the single authority for "this drop is safe to silently retry": it raises
 * the sentinel both on a graceful `done`-less close (host bounce; SSE body
 * ended with no terminal frame) AND on a hard mid-stream body error (network
 * drop while consuming the established stream). Crucially, both happen only
 * AFTER the SSE stream exists, so a silent `regenerate()` just re-runs an
 * already-started turn.
 *
 * We deliberately do NOT treat a raw fetch/network `TypeError` as
 * connection-lost: that can surface from the non-idempotent
 * `POST /api/chat/messages` or the initial `GET` (which run BEFORE the stream
 * exists). If the POST already reached the host, a silent re-POST would
 * create a DUPLICATE conversation/turn/agent invocation. Those failures fall
 * through to the error banner (manual retry), not a silent replay.
 */
function isConnectionLost(error: unknown): boolean {
  return error instanceof Error && error.message === CONNECTION_LOST;
}

/**
 * Per-TURN silent-retry budget. The one-retry cap must be scoped to a single
 * user turn, NOT leaked across later turns: after a connection-lost turn
 * spends its silent retry and that retry ALSO fails, the budget must reset
 * when the user starts a fresh turn — otherwise that fresh turn's first drop
 * would skip its own silent retry and go straight to the banner.
 *
 * We key the budget to the failing turn's identity (`turnKey`) — the runtime
 * passes the last user message id. A silent `regenerate()` re-runs the SAME
 * last user turn, so the key is unchanged and the budget correctly persists
 * across the retry; a new submission appends a new user message (new id), so
 * the key changes and the budget resets. Pure + framework-free so it's
 * unit-testable without rendering `useChat`.
 */
export interface RetryBudget {
  /**
   * Returns true iff a silent retry is still available for `turnKey`, and —
   * when it returns true — spends it (so the next call for the same key
   * returns false). A new `turnKey` resets the budget. A `null`/`undefined`
   * key (no user turn to attribute) is treated as a single shared turn.
   */
  consume(turnKey: string | null | undefined): boolean;
}

export function createRetryBudget(): RetryBudget {
  let currentKey: string | null = null;
  let spent = false;
  return {
    consume(turnKey) {
      const key = turnKey ?? null;
      if (key !== currentKey) {
        // Fresh turn — reset the budget to this turn.
        currentKey = key;
        spent = false;
      }
      if (spent) return false;
      spent = true;
      return true;
    },
  };
}

export interface HandleTurnErrorArgs {
  /**
   * The error raised to useChat's onError. The AI SDK reconstructs a plain
   * `Error` from the transport's `error` chunk `errorText`, so we match on
   * `error.message` rather than an Error subclass (which wouldn't survive).
   */
  error: unknown;
  /**
   * Identity of the failing user turn (the runtime passes the last user
   * message id). Used to scope the silent-retry budget per-turn.
   */
  turnKey: string | null | undefined;
  /** Per-turn silent-retry budget (see `createRetryBudget`). */
  budget: RetryBudget;
  /** Re-run the last user turn silently (the runtime's `regenerate()`). */
  silentRetry: () => void;
  /** Surface the error banner with a (manual) retry affordance. */
  showError: (error: unknown) => void;
}

/**
 * Decide between a silent retry and the error banner for a failed turn.
 *
 *   - connection-lost (Faults B/D) AND a silent retry is still available for
 *     this turn → SILENT retry: set a transient working-mode "Connection
 *     lost. Retrying…" label (no banner) and call `silentRetry()`.
 *   - connection-lost AND the turn's silent retry was already spent → banner.
 *   - any other error (Fault A / orchestrator-terminated) → error banner
 *     immediately; does NOT spend the connection-lost budget.
 *
 * The budget is consumed ONLY on the connection-lost path, so a Fault A
 * error never burns a later genuine drop's silent retry.
 */
export function handleTurnError(args: HandleTurnErrorArgs): void {
  const { error, turnKey, budget, silentRetry, showError } = args;
  if (isConnectionLost(error) && budget.consume(turnKey)) {
    // FORCE working mode with the transient "Connection lost. Retrying…"
    // label — NOT the persistent red error banner. We use `show()` (not the
    // label-only `set()`): if a PRIOR error row is still visible when this
    // silent retry begins (e.g. the fetch failed before RunningEffect cleared
    // the previous turn's error), `set()` would only swap the text and leave
    // `mode: 'error'` + the old retry/dismiss handlers — so the "silent" path
    // would still show the red banner. `show()` flips to working mode and
    // clears those handlers, keeping the automatic retry genuinely silent.
    agentStatusActions.show(CONNECTION_LOST);
    silentRetry();
    return;
  }
  showError(error);
}
