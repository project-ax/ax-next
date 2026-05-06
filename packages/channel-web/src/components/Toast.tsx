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
 * Mirrors `.toast-stack` / `.toast` markup from the Tide Sessions design.
 */
import { useEffect } from 'react';
import { type Toast as ToastModel, toastActions, useToastStore } from '../lib/toast-store';

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
  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = window.setTimeout(() => {
      toastActions.dismiss(toast.id);
    }, toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.duration]);

  const onClose = () => toastActions.dismiss(toast.id);

  return (
    <div className={'toast' + (toast.kind === 'error' ? ' error' : '')}>
      <span className="toast-dot" />
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.detail && <div className="toast-detail">{toast.detail}</div>}
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        onClick={onClose}
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
