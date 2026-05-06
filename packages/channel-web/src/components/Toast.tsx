/**
 * Toast — top-right slide-in stack for session-level notifications.
 *
 * Used for errors that aren't tied to a specific message ("Disconnected",
 * "Save failed", quota errors). Errors are sticky by default; info
 * toasts auto-dismiss after their `duration` elapses.
 *
 * Auto-dismiss runs in a per-toast effect rather than a store-side
 * timer, so the timer's lifetime is tied to the rendered DOM node —
 * unmount cancels the timeout, keeping the store free of timer churn.
 *
 * **Two-phase dismiss** (auto + manual):
 *
 *   1. The duration timeout fires (info) OR the user clicks the close
 *      button. We flip a local `leaving` flag — the CSS rule
 *      `.toast.leaving` runs the 180 ms `toast-out` slide-out animation.
 *   2. After 180 ms (matching the CSS keyframe), we actually remove the
 *      toast from the store, which unmounts the node.
 *
 *   Without phase 1 the React unmount races ahead of the CSS animation
 *   and the slide-out is invisible — `.toast.leaving` was dead CSS
 *   before this split.
 *
 * Accessibility:
 *
 *   - Stack region uses `aria-live="polite"` for ambient info toasts.
 *   - Error items also carry `role="alert"` (which implies
 *     `aria-live="assertive"`) so screen readers announce errors
 *     immediately rather than waiting for the current utterance.
 *
 * Mirrors `.toast-stack` / `.toast` markup from the the design.
 */
import { useCallback, useEffect, useState } from 'react';
import { type Toast as ToastModel, toastActions, useToastStore } from '../lib/toast-store';

/** Must match the duration of the `toast-out` keyframe in `index.css`. */
const TOAST_LEAVE_MS = 180;

export const ToastStack = () => {
  const { toasts } = useToastStore();
  return (
    <div className="toast-stack" role="region" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
};

const ToastItem = ({ toast }: { toast: ToastModel }) => {
  const [leaving, setLeaving] = useState(false);
  const startLeave = useCallback(() => setLeaving(true), []);

  // Phase 1: auto-dismiss timer flips the leaving flag.
  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = window.setTimeout(startLeave, toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.duration, startLeave]);

  // Phase 2: once leaving, wait for the CSS animation to finish, then
  // remove from the store so React unmounts the node.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(
      () => toastActions.dismiss(toast.id),
      TOAST_LEAVE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [leaving, toast.id]);

  const isError = toast.kind === 'error';
  const className =
    'toast' + (isError ? ' error' : '') + (leaving ? ' leaving' : '');

  return (
    <div className={className} role={isError ? 'alert' : undefined}>
      <span className="toast-dot" />
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.detail && <div className="toast-detail">{toast.detail}</div>}
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        onClick={startLeave}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M2 2 L8 8 M8 2 L2 8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
};
