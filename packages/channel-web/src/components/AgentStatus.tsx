/**
 * AgentStatus — slim status row above the composer.
 *
 * Mirrors the design in `design_handoff_tide/Tide Sessions.html`
 * (.agent-status markup + CSS): a breathing dot, a label, and a
 * hover-revealed action button (stop/retry/dismiss). Sits OUTSIDE the
 * timeline so it isn't persisted to chat history — it reflects only
 * the live state of the agent for the current turn.
 *
 * Behavior matrix (driven by `agent-status-store`):
 *   - mode='hidden'  → row is `opacity: 0`, `pointer-events: none`.
 *   - mode='working' → blue dot, breathing; "stop" button shows on hover
 *                      iff a cancel handler is registered.
 *   - mode='error'   → red dot, no breathing, persistent; primary button
 *                      says "retry" (when a retry handler is set) or
 *                      "dismiss" otherwise.
 *
 * Crossfade: when the label changes while visible, we briefly add
 * `swapping` (140ms `opacity: 0`), update the text, and remove it. This
 * avoids the "Thinking…" → "Starting sandbox…" jump.
 *
 * Auto-pump: a `running` boolean is forwarded by `<RunningHook />` from
 * `ThreadPrimitive.If running` so the row shows "Thinking…" while a turn
 * is in flight and hides on finish. Test triggers (/status, /error …)
 * override this for manual UI checks.
 */
import { useEffect, useRef } from 'react';
import { ThreadPrimitive } from '@assistant-ui/react';
import {
  agentStatusActions,
  getAgentStatusSnapshot,
  useAgentStatusStore,
} from '../lib/agent-status-store';

export const AgentStatus = () => {
  const { mode, text, cancel, retry, dismiss } = useAgentStatusStore();

  // Crossfade label swaps. Track displayed text in a ref so we can
  // briefly flip the `swapping` class, then commit the new text.
  const textRef = useRef<HTMLSpanElement>(null);
  const lastText = useRef(text);
  useEffect(() => {
    if (lastText.current === text) return;
    const el = textRef.current;
    if (!el) {
      lastText.current = text;
      return;
    }
    el.classList.add('swapping');
    const t = window.setTimeout(() => {
      el.classList.remove('swapping');
      lastText.current = text;
    }, 140);
    return () => window.clearTimeout(t);
  }, [text]);

  const isVisible = mode !== 'hidden';
  const isError = mode === 'error';
  const buttonLabel = isError ? (retry ? 'retry' : 'dismiss') : 'stop';
  const showButton = isError ? true : !!cancel;

  const onAction = () => {
    if (isError) {
      if (retry) retry();
      else if (dismiss) dismiss();
      agentStatusActions.hide();
      return;
    }
    if (cancel) cancel();
    agentStatusActions.hide();
  };

  return (
    <>
      <RunningHook />
      <div
        className={
          'agent-status' +
          (isVisible ? ' visible' : '') +
          (isError ? ' error' : '')
        }
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span ref={textRef} className="agent-status-text">
          {text}
        </span>
        {showButton && (
          <button
            type="button"
            className="agent-status-cancel"
            onClick={onAction}
          >
            {buttonLabel}
          </button>
        )}
      </div>
    </>
  );
};

/**
 * RunningHook — bridge assistant-ui's `running` state to the agent-status
 * store. Renders nothing; uses `ThreadPrimitive.If` as a free reactivity
 * hook (the primitive is the project's existing pattern — see Composer's
 * Send/Cancel swap — and avoids reaching into runtime-state hooks that
 * haven't been stable across assistant-ui versions).
 */
const RunningHook = () => (
  <ThreadPrimitive.If running>
    <RunningEffect />
  </ThreadPrimitive.If>
);

const RunningEffect = () => {
  useEffect(() => {
    // Only auto-show "Thinking…" if nothing else is occupying the row.
    if (getAgentStatusSnapshot().mode === 'hidden') {
      agentStatusActions.show('Thinking…');
    }
    return () => {
      // On unmount (running flipped to false): hide any working state.
      // Error mode is sticky by design — the user must dismiss/retry.
      // Manual /status fires already self-hide via their own timers,
      // so this cleanup also closes those if they overlap a run end —
      // which is the right call: /status was a dev tool, not a state
      // the row should keep across the next user turn.
      const snap = getAgentStatusSnapshot();
      if (snap.mode === 'working') {
        agentStatusActions.hide();
      }
    };
  }, []);
  return null;
};
