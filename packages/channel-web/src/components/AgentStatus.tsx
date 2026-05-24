/**
 * AgentStatus — slim status row above the composer.
 *
 * A breathing dot, a label, and a hover-revealed action button
 * (stop/retry/dismiss). Sits OUTSIDE the timeline so it isn't
 * persisted to chat history — it reflects only the live state of the
 * agent for the current turn.
 *
 * Behavior matrix (driven by `agent-status-store`):
 *   - mode='hidden'  → row collapsed (opacity-0, pointer-events-none).
 *   - mode='working' → primary dot, breathing; "stop" button shows on
 *                      hover iff a cancel handler is registered.
 *   - mode='error'   → destructive dot, no breathing, persistent;
 *                      primary button says "retry" (when a retry
 *                      handler is set) or "dismiss" otherwise.
 *
 * Crossfade: when the label changes while visible, we briefly set
 * `data-swapping=true` (140ms opacity-0), update the text, and clear
 * it. Avoids the "Thinking…" → "Starting sandbox…" jump.
 *
 * Auto-pump: a `running` boolean is forwarded by `<RunningHook />` so
 * the row shows "Thinking…" while a turn is in flight and hides on
 * finish. Test triggers (/status, /error …) override this.
 */
import { useEffect, useRef } from 'react';
import { ThreadPrimitive } from '@assistant-ui/react';
import {
  agentStatusActions,
  getAgentStatusSnapshot,
  useAgentStatusStore,
} from '../lib/agent-status-store';
import { cn } from '@/lib/utils';

export const AgentStatus = () => {
  const { mode, text, cancel, retry, dismiss } = useAgentStatusStore();

  const textRef = useRef<HTMLSpanElement>(null);
  const lastText = useRef(text);
  useEffect(() => {
    if (lastText.current === text) return;
    const el = textRef.current;
    if (!el) {
      lastText.current = text;
      return;
    }
    el.setAttribute('data-swapping', 'true');
    const t = window.setTimeout(() => {
      el.removeAttribute('data-swapping');
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
      if (retry) {
        retry();
        return;
      }
      if (dismiss) dismiss();
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
        className={cn(
          'agent-status group relative flex items-center gap-2 h-[22px] mb-2 px-1',
          'text-[12.5px] tracking-[-0.005em] text-muted-foreground',
          'transition-[opacity,transform] duration-200 pointer-events-none opacity-0 translate-y-0.5',
          'before:content-[""] before:w-1.5 before:h-1.5 before:rounded-full before:shrink-0',
          'before:bg-primary before:animate-[breathe_1.6s_ease-in-out_infinite]',
          isVisible && 'visible opacity-100 translate-y-0 pointer-events-auto',
          isError &&
            'error text-destructive before:bg-destructive before:animate-none before:opacity-100',
        )}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span
          ref={textRef}
          className="
            agent-status-text min-w-0 whitespace-nowrap overflow-hidden text-ellipsis
            transition-opacity duration-150 data-[swapping=true]:opacity-0
          "
        >
          {text}
        </span>
        {showButton && (
          <button
            type="button"
            className={cn(
              'agent-status-cancel ml-1 px-1.5 py-px rounded-sm',
              'text-[11px] tracking-[0.02em] text-ink-ghost',
              'transition-[opacity,color,background-color] duration-150',
              'hover:text-foreground hover:bg-muted',
              'focus-visible:opacity-100 focus-visible:text-foreground focus-visible:bg-muted',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
              isError
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
            )}
            onClick={onAction}
          >
            {buttonLabel}
          </button>
        )}
      </div>
    </>
  );
};

const RunningHook = () => (
  <ThreadPrimitive.If running>
    <RunningEffect />
  </ThreadPrimitive.If>
);

/**
 * Exported for direct mount/unmount testing — in the app it only mounts
 * inside `<ThreadPrimitive.If running>`, so a unit test can't easily force
 * the "a turn is running" state without it.
 */
export const RunningEffect = () => {
  useEffect(() => {
    // A new turn is starting. Show "Thinking…" unless we're already in the
    // working state (idempotent re-mount). Crucially this ALSO resets a
    // STALE 'error' row back to working — an error set by a prior turn
    // (#137's turn-error → agentStatusActions.error) must not stick across
    // the next turn. Without this the error row persists through every
    // later turn / new session until a full page reload.
    if (getAgentStatusSnapshot().mode !== 'working') {
      agentStatusActions.show('Thinking…');
    }
    return () => {
      // Hide only if still working. An error set DURING this turn must
      // persist after the turn ends (red dot + retry) — that persistence is
      // the whole point of #137, so we never clear 'error' on unmount.
      const snap = getAgentStatusSnapshot();
      if (snap.mode === 'working') {
        agentStatusActions.hide();
      }
    };
  }, []);
  return null;
};
