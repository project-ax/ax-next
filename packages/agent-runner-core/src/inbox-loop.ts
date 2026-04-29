import type { AgentMessage } from '@ax/ipc-protocol';
import type { IpcClient } from './ipc-client.js';

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
// ---------------------------------------------------------------------------

export interface InboxLoopOptions {
  client: IpcClient;
  initialCursor?: number;
}

export interface InboxLoopEntry {
  type: 'user-message' | 'cancel';
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

  const next = async (): Promise<InboxLoopEntry> => {
    // Loop until we get a real entry. Timeouts are invisible to the caller.
    // Each iteration blocks on one long-poll; the client already handles
    // retry policy for transient failures, so any error that reaches us
    // here is terminal and must propagate.
    for (;;) {
      const raw = (await opts.client.callGet('session.next-message', {
        cursor: String(cursor),
      })) as WireResponse;
      if (raw.type === 'timeout') {
        // Host echoed our cursor; no advancement. Re-poll immediately.
        // The client's per-action timeout covers the actual network wait,
        // so busy-looping here is not a concern — each iteration blocks on
        // an in-flight GET.
        continue;
      }
      if (raw.type === 'user-message') {
        cursor = raw.cursor;
        return {
          type: 'user-message',
          payload: raw.payload,
          reqId: raw.reqId,
        };
      }
      if (raw.type === 'cancel') {
        cursor = raw.cursor;
        return { type: 'cancel' };
      }
      // Reject anything outside the three discriminated-union arms loudly —
      // a silent fall-through to 'cancel' would mask protocol drift or a
      // forward-compatible variant that arrives before the runner knows how
      // to handle it. The ipc-client's schema validation should catch this
      // upstream, but defense-in-depth at the loop boundary too.
      throw new Error(
        `inbox-loop: unexpected session.next-message response type: ${String((raw as { type?: unknown }).type)}`,
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
