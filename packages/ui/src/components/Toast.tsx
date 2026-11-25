import { useSyncExternalStore } from 'react';
import { NoticeView } from '../internal/NoticeView.js';
import type { NoticeTone } from './Notice.js';

export type ToastTone = NoticeTone;

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms before auto-dismiss (info and success only; default 5000). Warning and danger stay until dismissed. */
  duration?: number;
}

interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
}

const DEFAULT_DURATION_MS = 5000;
const EMPTY: readonly ToastItem[] = [];

// Module singleton: any code (not just React) can toast, and every mounted ToastRegion shows the same list.
let items: readonly ToastItem[] = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const getSnapshot = (): readonly ToastItem[] => items;
const getServerSnapshot = (): readonly ToastItem[] => EMPTY;

const set = (next: readonly ToastItem[]): void => {
  items = next;
  for (const l of listeners) l();
};

function dismiss(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (items.some((t) => t.id === id)) set(items.filter((t) => t.id !== id));
}

function show({ title, description, tone = 'info', duration }: ToastInput): string {
  const id = `toast-${nextId++}`;
  const item: ToastItem = { id, title, tone, ...(description !== undefined ? { description } : {}) };
  set([...items, item]);
  if (tone === 'info' || tone === 'success') {
    timers.set(
      id,
      setTimeout(() => dismiss(id), duration ?? DEFAULT_DURATION_MS),
    );
  }
  return id;
}

/** Clears every toast and its timer. Lets tests start each case from an empty stack. */
function dismissAll(): void {
  for (const item of items) dismiss(item.id);
}

export const toast = { show, dismiss, dismissAll };

/** Mount once near the app root. One polite live region holds every toast, so each is announced once. */
export function ToastRegion() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      className="ax-pointer-events-none ax-fixed ax-right-lg ax-top-lg ax-z-50 ax-flex ax-w-full ax-max-w-narrow ax-flex-col ax-gap-md"
    >
      {list.map((t) => (
        <div key={t.id} className="ax-pointer-events-auto ax-rounded-md ax-bg-canvas ax-shadow-overlay">
          <NoticeView tone={t.tone} title={t.title} onDismiss={() => dismiss(t.id)}>
            {t.description}
          </NoticeView>
        </div>
      ))}
    </div>
  );
}
