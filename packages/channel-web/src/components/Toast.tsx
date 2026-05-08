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
 *      button. We flip a local `leaving` flag — the Tailwind animation
 *      (toast-out keyframes in index.css) runs the slide-out.
 *   2. After 180 ms (matching the keyframe), we actually remove the
 *      toast from the store, which unmounts the node.
 *
 * Accessibility:
 *
 *   - Stack region uses `aria-live="polite"` for ambient info toasts.
 *   - Error items also carry `role="alert"` (which implies
 *     `aria-live="assertive"`) so screen readers announce errors
 *     immediately.
 */
import { useCallback, useEffect, useState } from 'react';
import { type Toast as ToastModel, toastActions, useToastStore } from '../lib/toast-store';
import { cn } from '@/lib/utils';

/** Must match the duration of the `toast-out` keyframe in `index.css`. */
const TOAST_LEAVE_MS = 180;

export const ToastStack = () => {
  const { toasts } = useToastStore();
  return (
    <div
      className="fixed top-5 right-5 z-[200] flex flex-col gap-2 pointer-events-none"
      role="region"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
};

const ToastItem = ({ toast }: { toast: ToastModel }) => {
  const [leaving, setLeaving] = useState(false);
  const startLeave = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = window.setTimeout(startLeave, toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.duration, startLeave]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(
      () => toastActions.dismiss(toast.id),
      TOAST_LEAVE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [leaving, toast.id]);

  const isError = toast.kind === 'error';

  return (
    <div
      className={cn(
        'toast pointer-events-auto flex items-start gap-2.5',
        'min-w-[240px] max-w-[360px] py-2.5 pl-3.5 pr-3',
        'bg-card border border-border rounded-lg shadow-md',
        'text-[12.5px] tracking-[-0.005em] text-foreground',
        leaving
          ? 'leaving animate-[toast-out_180ms_ease_forwards]'
          : 'animate-[toast-in_220ms_cubic-bezier(0.2,0.8,0.2,1)_both]',
        isError && 'error',
      )}
      role={isError ? 'alert' : undefined}
    >
      <span
        className={cn(
          'toast-dot mt-1.5 h-2 w-2 rounded-full shrink-0',
          isError ? 'bg-destructive' : 'bg-muted-foreground',
        )}
      />
      <div className="flex-1 min-w-0 leading-[1.4]">
        <div className="font-medium mb-px">{toast.title}</div>
        {toast.detail && (
          <div className="text-muted-foreground text-[11.5px]">{toast.detail}</div>
        )}
      </div>
      <button
        type="button"
        className="
          inline-flex items-center justify-center shrink-0
          h-[18px] w-[18px] rounded text-ink-ghost transition-colors
          hover:text-foreground hover:bg-muted
          focus-visible:text-foreground focus-visible:bg-muted
          focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2
        "
        aria-label="Dismiss"
        onClick={startLeave}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true" className="h-2.5 w-2.5">
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
