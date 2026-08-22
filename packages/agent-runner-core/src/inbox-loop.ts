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
// It also transparently swallows delivery variants it does not recognise
// (AW-6): the union is open now — a host newer than this runner may deliver
// something this build predates — so an unknown type is reported and re-polled
// rather than thrown. See the branch at the end of `next()`.
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
  /**
   * Where the loop reports a delivery variant it does not understand.
   * Defaults to a stderr line, matching the rest of the runner. Injected so a
   * test can assert the report happened — a silent skip and a reported skip
   * look identical from `next()`'s return value, and the whole point of the
   * log-and-re-poll below is that the gap is VISIBLE.
   */
  onUnknownDelivery?: (type: string) => void;
}

export interface InboxLoopEntry {
  type: 'user-message' | 'cancel' | 'idle-timeout' | 'decision-resolved';
  payload?: AgentMessage;
  /**
   * AW-6. Present iff `type === 'decision-resolved'` — a call this agent held
   * earlier, answered by a person while this session was still warm.
   *
   * `note` is HOST-AUTHORED prose the shell turns into the opening message of
   * a new turn. It is NOT an authorisation: the standing approval lives on the
   * host, keyed on the held call's fingerprint, so the re-issued call passes
   * the gate only if it is byte-identical to the one the person read.
   */
  decisionId?: string;
  outcome?: 'approved' | 'dismissed';
  note?: string;
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
  | { type: 'timeout'; cursor: number }
  | {
      type: 'decision-resolved';
      decisionId: string;
      outcome: 'approved' | 'dismissed';
      note: string;
      cursor: number;
    };

export function createInboxLoop(opts: InboxLoopOptions): InboxLoop {
  let cursor = opts.initialCursor ?? 0;

  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_INBOX_IDLE_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const onUnknownDelivery =
    opts.onUnknownDelivery ??
    ((type: string): void => {
      process.stderr.write(`runner: inbox_unknown_delivery type=${type}; re-polling\n`);
    });

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
      if (resp.type === 'decision-resolved') {
        cursor = resp.cursor;
        return {
          type: 'decision-resolved',
          decisionId: resp.decisionId,
          outcome: resp.outcome,
          note: resp.note,
        };
      }
      // BEHAVIOUR CHANGE (AW-6). This used to `throw`, which killed the turn.
      //
      // The throw was defensible while the union was closed: an unrecognised
      // type meant protocol drift and drift should be loud. It stopped being
      // defensible the moment the union started GROWING — a host newer than
      // this runner now legitimately delivers variants this build has never
      // heard of, and the old behaviour turned a forward-compatible addition
      // into a crashed turn on every runner in the fleet that had not been
      // rebuilt yet.
      //
      // Advancing the cursor and re-polling loses nothing this runner could
      // have acted on. It is reported, not swallowed: the operator sees the
      // variant name and the version gap it implies. (The ipc-client's schema
      // validation would reject a genuinely malformed response upstream and
      // that error still propagates — this branch is reached only by a
      // well-formed variant we do not know.)
      onUnknownDelivery(String((resp as { type?: unknown }).type));
      const advanced = (resp as { cursor?: unknown }).cursor;
      if (typeof advanced === 'number' && Number.isInteger(advanced) && advanced > cursor) {
        // Only ever FORWARD. A variant carrying a bogus or absent cursor must
        // not rewind us onto entries we already delivered — replaying a
        // user-message is worse than skipping an unknown one.
        cursor = advanced;
      }
      continue;
    }
  };

  return {
    next,
    get cursor() {
      return cursor;
    },
  };
}
