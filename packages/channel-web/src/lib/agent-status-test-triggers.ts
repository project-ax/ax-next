/**
 * Test triggers for the status / error UI surfaces.
 *
 * Recognized prefixes:
 *   /status              — cycle "Thinking…" → "Starting sandbox…"
 *                          → "Installing dependencies…" → hide.
 *   /status <text>       — show "<text>" for 3s then hide.
 *   /error transient     — recoverable error in the status row (red), with retry.
 *   /error inline        — terminal error attached to the last user message.
 *   /error toast         — session-level toast notification.
 *   /error all           — fire all three for comparison.
 *
 * Returns true when the input matched a trigger and was handled (the
 * caller should NOT pass it on to the runtime as a real chat message).
 *
 * These are dev-only — the composer hint deliberately doesn't advertise
 * them. The chat transcripts (chat2.md) are the canonical source: the
 * user asked for "/error toast"-style triggers as a way to verify the
 * error surfaces without polluting real chat history.
 */
import { agentStatusActions } from './agent-status-store';
import { toastActions } from './toast-store';

/** Handle to a deferred run cancellation, used by /status timers. */
let pendingTimers: number[] = [];
const armTimer = (fn: () => void, ms: number): void => {
  const id = window.setTimeout(() => {
    pendingTimers = pendingTimers.filter((t) => t !== id);
    fn();
  }, ms);
  pendingTimers.push(id);
};
const cancelPendingTimers = (): void => {
  for (const id of pendingTimers) window.clearTimeout(id);
  pendingTimers = [];
};

export interface TestTriggerEnv {
  /**
   * Find the most recent rendered user-message DOM element. Defaults
   * to `document.querySelector('.msg.you:last-of-type')`. Tests may
   * inject a fake locator.
   */
  findLastUserMessage?: () => HTMLElement | null;
}

const defaultFindLastUserMessage = (): HTMLElement | null => {
  if (typeof document === 'undefined') return null;
  const all = document.querySelectorAll<HTMLElement>('.msg.you');
  return all.length > 0 ? all[all.length - 1]! : null;
};

/**
 * Attach an inline error row to a user-message DOM node. Lives in the
 * DOM only — not persisted. Mirrors the `.msg-error` markup from the
 * Tide Sessions design.
 */
function attachMessageError(
  msgEl: HTMLElement,
  opts: { label?: string; onRetry?: () => void; onDismiss?: () => void } = {},
): void {
  // Idempotent: clear any existing error rows on this message first.
  msgEl.querySelectorAll('.msg-error').forEach((e) => e.remove());

  const label = opts.label ?? "Couldn't send";
  const row = document.createElement('div');
  row.className = 'msg-error';
  row.setAttribute('role', 'alert');

  const icon = document.createElement('span');
  icon.className = 'msg-error-icon';
  icon.textContent = '!';
  icon.setAttribute('aria-hidden', 'true');
  row.appendChild(icon);

  const labelEl = document.createElement('span');
  labelEl.className = 'msg-error-label';
  labelEl.textContent = label;
  row.appendChild(labelEl);

  const actions = document.createElement('span');
  actions.className = 'msg-error-actions';

  if (opts.onRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'msg-error-action retry';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => {
      row.remove();
      opts.onRetry?.();
    });
    actions.appendChild(retryBtn);
  }

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'msg-error-action dismiss';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', () => {
    row.remove();
    opts.onDismiss?.();
  });
  actions.appendChild(dismissBtn);

  row.appendChild(actions);
  msgEl.appendChild(row);
}

export function handleTestTrigger(
  raw: string,
  env: TestTriggerEnv = {},
): boolean {
  const parts = raw.trim().split(/\s+/);
  const cmd = parts[0];
  const arg = parts.slice(1).join(' ').trim();

  if (cmd === '/status') {
    cancelPendingTimers();
    if (arg) {
      agentStatusActions.show(arg);
      armTimer(() => agentStatusActions.hide(), 3000);
    } else {
      agentStatusActions.show('Thinking…');
      armTimer(() => agentStatusActions.set('Starting sandbox…'), 1200);
      armTimer(() => agentStatusActions.set('Installing dependencies…'), 2400);
      armTimer(() => agentStatusActions.hide(), 4200);
    }
    return true;
  }

  if (cmd === '/error') {
    const kind = arg || 'all';
    const findLastUser = env.findLastUserMessage ?? defaultFindLastUserMessage;

    const fireTransient = (): void => {
      agentStatusActions.error('Connection lost — retrying in 5s', {
        retry: () => {
          agentStatusActions.show('Reconnecting…');
          armTimer(() => agentStatusActions.hide(), 1500);
        },
      });
    };

    const fireInline = (): void => {
      const lastUser = findLastUser();
      if (!lastUser) {
        toastActions.error(
          'No user message yet',
          'Send something first, then try /error inline.',
        );
        return;
      }
      attachMessageError(lastUser, {
        label: "Couldn't send · network error",
        onRetry: () => {
          toastActions.show({ title: 'Retrying…', duration: 1500 });
        },
      });
    };

    const fireToast = (): void => {
      toastActions.error(
        'Sandbox quota exceeded',
        'Upgrade or wait until tomorrow to run more tools.',
      );
    };

    if (kind === 'transient') fireTransient();
    else if (kind === 'inline') fireInline();
    else if (kind === 'toast') fireToast();
    else if (kind === 'all') {
      fireTransient();
      fireInline();
      fireToast();
    } else {
      toastActions.show({
        title: 'Unknown /error variant',
        detail: 'Try: /error transient | inline | toast | all',
        kind: 'error',
        duration: 4000,
      });
    }
    return true;
  }

  return false;
}

/** Test seam — clear any pending timers between tests. */
export const testTriggersInternals = {
  cancelPendingTimers,
};
