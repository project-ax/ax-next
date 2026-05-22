import type { AgentMessage, IpcClient } from '@ax/ipc-protocol';

// ---------------------------------------------------------------------------
// Inbox long-poll loop.
//
// The sandbox-side runner never "receives" data unsolicited — the host is
// the listener, the sandbox is always the client. To hear about new user
// messages or cancel signals, the runner long-polls `session.next-message`
// with its current cursor. The host blocks for up to 30 s waiting for a
// new entry (see @ax/ipc-protocol IPC_TIMEOUTS_MS). When the host times out
// with no entry, it returns `{ type: 'timeout', cursor: <echo> }` — the
// runner then re-polls with the same cursor. Cursor advances only on
// delivery (`user-message` / `cancel`), never on timeout.
//
// `next()` transparently swallows timeouts. Callers see only real entries.
//
// Terminal errors from the client (SessionInvalidError, exhausted-retry
// HostUnavailableError) propagate out — the runner decides what to do.
//
// `idleTimeoutMs` adds a cumulative idle FLOOR per `next()` call: if no
// real entry arrives within the window, `next()` returns
// `{ type: 'idle-timeout' }`. This is the host-crash fallback reaper —
// intentionally longer than the host's own idle window so the host normally
// reaps first.
// ---------------------------------------------------------------------------

/** Default inbox idle floor — 15 min. Longer than the host idle window so the
 *  host-side reaper normally wins; this is the host-crash fallback only. */
const DEFAULT_INBOX_IDLE_MS = 15 * 60 * 1000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const IDLE_SENTINEL = Symbol('inbox-idle');

export interface InboxLoopOptions {
  client: IpcClient;
  initialCursor?: number;
  /** Cumulative idle floor per next() call (ms). If no real entry arrives
   *  within this window, next() returns { type: 'idle-timeout' }. */
  idleTimeoutMs?: number;
  /** Testable seam — defaults to Date.now. */
  now?: () => number;
  /** Testable seam — defaults to setTimeout-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface InboxLoopEntry {
  type: 'user-message' | 'cancel' | 'idle-timeout';
  payload?: AgentMessage;
  /**
   * Host-minted request id (J9). Present iff `type === 'user-message'`.
   * The runner caches it locally and stamps it onto every
   * `event.stream-chunk` it emits while processing this user message —
   * the host's chat:stream-chunk subscriber routes chunks back to the
   * waiting client by this id.
   */
  reqId?: string;
}

export interface InboxLoop {
  /**
   * Resolves when the next non-timeout entry arrives. On `user-message`,
   * the entry carries the decoded payload. On `cancel`, no payload.
   *
   * Rejects on terminal errors from the underlying client (e.g.
   * SessionInvalidError, or HostUnavailableError after maxRetries).
   */
  next(): Promise<InboxLoopEntry>;
  /** Current cursor — the next value we'll send on the wire. */
  readonly cursor: number;
}

// Discriminated-union shape echoed from @ax/ipc-protocol's
// SessionNextMessageResponseSchema. We re-declare the type inline rather
// than pulling the schema type because `client.callGet` returns `unknown`.
type WireResponse =
  | { type: 'user-message'; payload: AgentMessage; reqId: string; cursor: number }
  | { type: 'cancel'; cursor: number }
  | { type: 'timeout'; cursor: number };

export function createInboxLoop(opts: InboxLoopOptions): InboxLoop {
  let cursor = opts.initialCursor ?? 0;

  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_INBOX_IDLE_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  const next = async (): Promise<InboxLoopEntry> => {
    const deadline = now() + idleTimeoutMs;
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) return { type: 'idle-timeout' };

      const pollP = opts.client.callGet('session.next-message', {
        cursor: String(cursor),
      }) as Promise<WireResponse>;
      // When the idle floor wins the race below, pollP is abandoned in-flight.
      // `Promise.race` already attaches a rejection handler to it (so a late
      // reject doesn't go unhandled), but we make that explicit — matching the
      // same belt-and-suspenders pattern in channel-web's thread-list-adapter —
      // so a future refactor away from Promise.race can't reintroduce a
      // dangling rejection. A real terminal error still propagates: when pollP
      // WINS, its rejection flows out through `await Promise.race` below.
      pollP.catch(() => undefined);
      const idleP = sleep(remaining).then(() => IDLE_SENTINEL);

      const raw = await Promise.race([pollP, idleP]);
      // The floor won the race — the in-flight GET is abandoned (the runner
      // exits right after this, so a dangling poll is moot).
      if (raw === IDLE_SENTINEL) return { type: 'idle-timeout' };

      const resp = raw as WireResponse;
      if (resp.type === 'timeout') {
        // Host echoed our cursor; no advancement. Re-poll immediately.
        // The client's per-action timeout covers the actual network wait,
        // so busy-looping here is not a concern — each iteration blocks on
        // an in-flight GET.
        continue;
      }
      if (resp.type === 'user-message') {
        cursor = resp.cursor;
        return {
          type: 'user-message',
          payload: resp.payload,
          reqId: resp.reqId,
        };
      }
      if (resp.type === 'cancel') {
        cursor = resp.cursor;
        return { type: 'cancel' };
      }
      // Reject anything outside the three discriminated-union arms loudly —
      // a silent fall-through to 'cancel' would mask protocol drift or a
      // forward-compatible variant that arrives before the runner knows how
      // to handle it. The ipc-client's schema validation should catch this
      // upstream, but defense-in-depth at the loop boundary too.
      throw new Error(
        `inbox-loop: unexpected session.next-message response type: ${String((resp as { type?: unknown }).type)}`,
      );
    }
  };

  return {
    next,
    get cursor() {
      return cursor;
    },
  };
}
