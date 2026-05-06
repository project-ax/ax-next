/**
 * Toast store — session-level notifications that aren't tied to a
 * specific message. Used for things like "Disconnected", "Save failed",
 * or quota errors.
 *
 * Each toast has a unique numeric id so React can key the list across
 * mounts. Errors are sticky by default (duration: 0); info toasts
 * auto-dismiss after 5s. The `<Toast />` component starts the
 * auto-dismiss timer in a render-time effect — keeping it in the
 * component (not the store) avoids strafing the store with unrelated
 * timer churn and means SSR / non-React callers stay decoupled.
 */
import { useSyncExternalStore } from 'react';

export type ToastKind = 'info' | 'error';

export interface Toast {
  id: number;
  title: string;
  detail?: string;
  kind: ToastKind;
  /** ms before auto-dismiss; 0 = sticky. */
  duration: number;
}

interface ToastState {
  toasts: readonly Toast[];
}

const initial: ToastState = { toasts: [] };

let state: ToastState = initial;
let nextId = 1;
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = (): ToastState => state;

const notify = (): void => {
  for (const l of listeners) l();
};

const set = (next: ToastState): void => {
  state = next;
  notify();
};

export function useToastStore(): ToastState {
  return useSyncExternalStore(subscribe, getSnapshot, () => initial);
}

interface ShowOpts {
  title: string;
  detail?: string;
  kind?: ToastKind;
  /** ms before auto-dismiss; 0 = sticky. Defaults: info=5000, error=0. */
  duration?: number;
}

export const toastActions = {
  show(opts: ShowOpts): number {
    const kind = opts.kind ?? 'info';
    const duration =
      opts.duration ?? (kind === 'error' ? 0 : 5000);
    const id = nextId++;
    const toast: Toast = {
      id,
      title: opts.title,
      kind,
      duration,
      ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
    };
    set({ toasts: [...state.toasts, toast] });
    return id;
  },
  error(title: string, detail?: string): number {
    return toastActions.show(
      detail !== undefined
        ? { title, detail, kind: 'error' }
        : { title, kind: 'error' },
    );
  },
  dismiss(id: number): void {
    set({ toasts: state.toasts.filter((t) => t.id !== id) });
  },
  /** Test seam — reset between tests. */
  reset(): void {
    state = initial;
    nextId = 1;
    notify();
  },
};
