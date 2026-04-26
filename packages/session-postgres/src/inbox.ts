import pg from 'pg';
import type { Kysely } from 'kysely';
import type { ChatMessage } from '@ax/core';
import type { SessionDatabase } from './migrations.js';

// ---------------------------------------------------------------------------
// Per-session long-poll inbox (postgres-backed)
//
// Same surface as @ax/session-inmemory's Inbox: queue, claim, terminate.
// Differences:
//
//  - Persistence: entries live in `session_postgres_v1_inbox`, ordered by
//    a per-session BIGINT cursor (0-based to match the in-memory plugin).
//
//  - Cross-replica wakeup: `claim` blocks on LISTEN of a per-session
//    channel; `queue` does INSERT then `pg_notify(...)`. So a queue on
//    instance A wakes a claim on instance B against the same DB.
//
//  - Channel naming: the channel is `session_inbox_<session_id>` after
//    sanitizing session_id to `[a-zA-Z0-9_]+`. Sessions whose IDs would
//    collide after sanitization (e.g., `s-1` and `s_1`) MUST have already
//    been rejected at session creation time — but session-postgres doesn't
//    validate session_id shape today, mirroring session-inmemory. The
//    sanitization here is defense-in-depth: even if a colliding ID gets
//    in, we'd cross-deliver wakeups (a spurious wake) but never deliver
//    the WRONG entry (the SQL fetch keys on the real session_id).
//
//  - Terminate: we set the session's terminated flag (in store), then
//    notify the inbox channel with a sentinel `{__terminate: true}` so
//    blocked claims wake. The `claim` re-fetches from SQL and either
//    finds a real entry (a queue raced ahead) or sees no entry + checks
//    the terminated flag and resolves as `timeout`.
// ---------------------------------------------------------------------------

// `reqId` on `user-message` is the host-minted request id (J9). Producers
// that enqueue a user message (today: chat-orchestrator; later: the chat
// HTTP API in Task 9) MUST attach the reqId of the originating host
// request. The runner reads it back through `session:claim-work` and
// stamps it onto every `event.stream-chunk` so the host can route the
// chunk back to the waiting client (Task 5/7). REQUIRED — never optional.
//
// Persistence: stored alongside the ChatMessage in the JSONB `payload`
// column rather than a dedicated SQL column, so this slice doesn't need
// a forward-only migration. The wrapping shape is opaque at the SQL
// layer; the inbox layer is the single producer + consumer.
export type InboxEntry =
  | { type: 'user-message'; payload: ChatMessage; reqId: string }
  | { type: 'cancel' };

export type ClaimResult =
  | { type: 'user-message'; payload: ChatMessage; reqId: string; cursor: number }
  | { type: 'cancel'; cursor: number }
  | { type: 'timeout'; cursor: number };

export interface Inbox {
  queue(sessionId: string, entry: InboxEntry): Promise<{ cursor: number }>;
  claim(sessionId: string, cursor: number, timeoutMs: number): Promise<ClaimResult>;
  terminate(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
}

const CHANNEL_SAFE_RE = /^[a-zA-Z0-9_]+$/;

function channelFor(sessionId: string): string {
  // Sanitize: replace anything that's not [a-zA-Z0-9_] with `_`. Postgres
  // identifiers also have a 63-char NAMEDATALEN cap; we keep the prefix
  // (15 chars) plus up to 48 of the sanitized session id, which is more
  // than enough for typical UUIDs (32-36 chars).
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48);
  const channel = `session_inbox_${sanitized}`;
  // Defense-in-depth: the regex on top of `escapeIdentifier` should never
  // fail by construction here, but if it did we'd get a thrown error from
  // pg.escapeIdentifier downstream rather than a silent skip — so we
  // assert the shape explicitly to fail fast in dev.
  if (!CHANNEL_SAFE_RE.test(channel)) {
    throw new Error(`session-postgres: derived channel name not safe: ${channel}`);
  }
  return channel;
}

interface PerSessionWaiter {
  /** Real sessionId (NOT the sanitized channel suffix) — used for SQL lookups. */
  sessionId: string;
  resolve: (r: ClaimResult) => void;
  cursor: number;
  timer: ReturnType<typeof setTimeout>;
  /** Removes the LISTEN binding when this waiter is the last one on the channel. */
  unlistenIfLast: () => Promise<void>;
}

interface InboxOptions {
  db: Kysely<SessionDatabase>;
  /**
   * Independent pg.Client used solely for LISTEN. Its lifecycle is owned
   * by the plugin (init opens, shutdown ends).
   */
  listenClient: pg.Client;
  /**
   * Function returning whether a session has been terminated. Lives in
   * the store layer; we accept a callback so the inbox doesn't need its
   * own table-level join on every claim.
   */
  isTerminated: (sessionId: string) => Promise<boolean>;
}

export function createInbox(opts: InboxOptions): Inbox {
  const { db, listenClient, isTerminated } = opts;

  // channel -> set of waiters. The channel name is derived from
  // sessionId via channelFor(); we key by channel (not sessionId) so the
  // notification handler can fan out without inverting the sanitization
  // (which is lossy — `s-1` and `s_1` both sanitize to `session_inbox_s_1`).
  const waitersByChannel = new Map<string, Set<PerSessionWaiter>>();
  // channel -> count of LISTEN refs (for UNLISTEN bookkeeping)
  const listenedChannels = new Map<string, number>();

  // Single notification handler — fans out to every waiter on the
  // notified channel. Each waiter carries its own real sessionId.
  listenClient.on('notification', (msg) => {
    const waiters = waitersByChannel.get(msg.channel);
    if (waiters === undefined || waiters.size === 0) return;
    // Snapshot — wake() can mutate the set.
    for (const w of [...waiters]) {
      void wakeWaiter(w);
    }
  });

  async function wakeWaiter(w: PerSessionWaiter): Promise<void> {
    // Re-check SQL: did the awaited entry land?
    const row = await fetchEntry(db, w.sessionId, w.cursor);
    if (row !== null) {
      finishWaiter(w, deliver(row, w.cursor));
      return;
    }
    // No entry — check if the session was terminated. If so, resolve as
    // timeout with echo cursor (matches session-inmemory semantics on a
    // terminate during a blocked claim).
    if (await isTerminated(w.sessionId)) {
      finishWaiter(w, { type: 'timeout', cursor: w.cursor });
    }
    // Otherwise: spurious wake. Stay parked until the timer or another
    // notification fires.
  }

  function finishWaiter(w: PerSessionWaiter, result: ClaimResult): void {
    const channel = channelFor(w.sessionId);
    const set = waitersByChannel.get(channel);
    if (set === undefined || !set.has(w)) return; // already finished
    clearTimeout(w.timer);
    set.delete(w);
    if (set.size === 0) waitersByChannel.delete(channel);
    w.resolve(result);
    // Best-effort UNLISTEN cleanup; failures don't affect the resolved
    // claim. We let unlistenIfLast handle the ref-count.
    void w.unlistenIfLast();
  }

  async function ensureListen(sessionId: string): Promise<() => Promise<void>> {
    const channel = channelFor(sessionId);
    const cur = listenedChannels.get(channel) ?? 0;
    // Bump the refcount SYNCHRONOUSLY before any await — otherwise two
    // concurrent ensureListen calls both read `cur = 0`, both await LISTEN,
    // and both set the count to 1 (clobbering one increment). When the
    // first releaser fires, count goes 1 → 0 and we UNLISTEN, even though
    // the second waiter is still parked on the channel — silent timeout
    // instead of receiving the entry.
    listenedChannels.set(channel, cur + 1);
    if (cur === 0) {
      // First subscriber on this channel — issue LISTEN.
      // pg.escapeIdentifier wraps in double-quotes and escapes any embedded
      // quotes; even though our channel passed the regex, escapeIdentifier
      // is the documented-correct way to embed an identifier into SQL.
      try {
        await listenClient.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      } catch (err) {
        // LISTEN failed — roll back the increment so the bookkeeping doesn't
        // leak. Use the live value (other concurrent ensureListen calls may
        // have bumped it further) and decrement, deleting on the way to 0.
        const after = listenedChannels.get(channel) ?? 1;
        if (after <= 1) listenedChannels.delete(channel);
        else listenedChannels.set(channel, after - 1);
        throw err;
      }
    }
    return async () => {
      const next = (listenedChannels.get(channel) ?? 1) - 1;
      if (next <= 0) {
        listenedChannels.delete(channel);
        // Best-effort: if the client is dead, the next reconnect simply
        // won't re-LISTEN.
        await listenClient.query(`UNLISTEN ${pg.escapeIdentifier(channel)}`).catch(() => {});
      } else {
        listenedChannels.set(channel, next);
      }
    };
  }

  return {
    async queue(sessionId, entry) {
      // Insert with `cursor = (SELECT COALESCE(MAX(cursor), -1) + 1 ...)`
      // — atomic per-session sequence. The UNIQUE(session_id, cursor)
      // constraint catches concurrent inserters: one wins, the loser
      // retries up to a small bound.
      const channel = channelFor(sessionId);
      let assigned: number | null = null;

      // Up to 5 retries on unique-violation; in practice contention is
      // low (one runner per session) but tests can race.
      for (let attempt = 0; attempt < 5; attempt++) {
        // BIGINT comes back as string from pg by default; we coerce.
        const maxRow = await db
          .selectFrom('session_postgres_v1_inbox')
          .select((eb) => eb.fn.max('cursor').as('maxCursor'))
          .where('session_id', '=', sessionId)
          .executeTakeFirst();
        const maxCursor =
          maxRow?.maxCursor === undefined || maxRow.maxCursor === null
            ? -1
            : Number(maxRow.maxCursor);
        const next = maxCursor + 1;

        try {
          await db
            .insertInto('session_postgres_v1_inbox')
            .values({
              session_id: sessionId,
              cursor: next as unknown as string, // BIGINT column; pg accepts number
              type: entry.type,
              // For user-message we wrap `{ message, reqId }` so the JSONB
              // column carries both without a schema migration. cancel
              // entries store null. The wrapping is internal — `claim`
              // unwraps before returning to the caller. (See `fetchEntry`.)
              payload:
                entry.type === 'user-message'
                  ? ({ message: entry.payload, reqId: entry.reqId } as unknown as never)
                  : null,
            } as never)
            .execute();
          assigned = next;
          break;
        } catch (err) {
          if (
            err !== null &&
            typeof err === 'object' &&
            'code' in err &&
            (err as { code?: unknown }).code === '23505'
          ) {
            // Race — someone else took this cursor. Retry.
            continue;
          }
          throw err;
        }
      }

      if (assigned === null) {
        throw new Error(
          `session-postgres: failed to allocate cursor for session ${sessionId} after retries`,
        );
      }

      // Fan out to listeners. pg_notify takes both args as parameters.
      await listenClient.query(`SELECT pg_notify($1, $2)`, [channel, '']);
      return { cursor: assigned };
    },

    async claim(sessionId, cursor, timeoutMs) {
      // Fast path: row already there.
      const present = await fetchEntry(db, sessionId, cursor);
      if (present !== null) {
        return deliver(present, cursor);
      }
      // Already terminated? Fast-path timeout.
      if (await isTerminated(sessionId)) {
        return { type: 'timeout', cursor };
      }

      // Slow path: install a LISTEN + waiter.
      const channel = channelFor(sessionId);
      const unlistenIfLast = await ensureListen(sessionId);

      return new Promise<ClaimResult>((resolve) => {
        // Single source of truth for "did this waiter already resolve" lives
        // in the waiter's set membership: finishWaiter checks `set.has(w)`
        // before resolving. The waiter's `resolve` is the underlying Promise
        // callback — it MUST be called exactly once, and finishWaiter is
        // the only path that calls it.
        const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
          finishWaiter(waiter, { type: 'timeout', cursor });
        }, timeoutMs);

        const waiter: PerSessionWaiter = {
          sessionId,
          resolve,
          cursor,
          timer,
          unlistenIfLast,
        };

        let set = waitersByChannel.get(channel);
        if (set === undefined) {
          set = new Set();
          waitersByChannel.set(channel, set);
        }
        set.add(waiter);

        // Race: an entry/terminate could have landed between our fast-path
        // checks and adding the waiter. Force a re-check now to close the
        // gap. (No-op if nothing to deliver.)
        void wakeWaiter(waiter);
      });
    },

    async terminate(sessionId) {
      // Wake any blocked claims for this session. We don't write a row;
      // the caller's plugin layer has already flipped the `terminated`
      // flag in the store before calling us, and `wakeWaiter` re-reads
      // that flag to resolve as timeout.
      const channel = channelFor(sessionId);
      // pg_notify is parameter-bound; the channel was sanitized above.
      // Even if the listenClient is mid-reconnect, this notify is best-
      // effort — the local waiters will hit their timeout if we miss them.
      await listenClient
        .query(`SELECT pg_notify($1, $2)`, [channel, ''])
        .catch(() => {
          // Mirror eventbus-postgres: terminate is best-effort.
        });
    },

    async shutdown() {
      // Resolve every outstanding waiter as timeout so callers don't hang.
      for (const [, set] of waitersByChannel) {
        for (const w of [...set]) {
          clearTimeout(w.timer);
          w.resolve({ type: 'timeout', cursor: w.cursor });
        }
      }
      waitersByChannel.clear();
      listenedChannels.clear();
    },
  };
}

async function fetchEntry(
  db: Kysely<SessionDatabase>,
  sessionId: string,
  cursor: number,
): Promise<InboxEntry | null> {
  const row = await db
    .selectFrom('session_postgres_v1_inbox')
    .select(['type', 'payload'])
    // BIGINT comparison; passing a JS number is fine within Number.MAX_SAFE_INTEGER.
    .where('session_id', '=', sessionId)
    .where('cursor', '=', cursor as unknown as string)
    .executeTakeFirst();
  if (row === undefined) return null;
  if (row.type === 'user-message') {
    // The JSONB payload wraps the ChatMessage and the host-minted reqId;
    // see the `queue` insert above. Be defensive about row shape — pg's
    // JSONB returns whatever bytes were stored, and a malformed row from
    // an old runner would surface here as a missing reqId.
    const wrapped = row.payload as
      | { message?: unknown; reqId?: unknown }
      | null
      | undefined;
    if (
      wrapped === null ||
      wrapped === undefined ||
      typeof wrapped !== 'object' ||
      typeof (wrapped as { reqId?: unknown }).reqId !== 'string' ||
      typeof (wrapped as { message?: unknown }).message !== 'object' ||
      (wrapped as { message?: unknown }).message === null
    ) {
      // Treat malformed rows as "no entry" — claim will fall through to
      // its waiter / timeout path. Better than throwing inside a
      // long-poll path and rejecting downstream consumers.
      return null;
    }
    return {
      type: 'user-message',
      payload: wrapped.message as ChatMessage,
      reqId: wrapped.reqId as string,
    };
  }
  if (row.type === 'cancel') {
    return { type: 'cancel' };
  }
  return null;
}

function deliver(entry: InboxEntry, cursor: number): ClaimResult {
  if (entry.type === 'user-message') {
    return {
      type: 'user-message',
      payload: entry.payload,
      reqId: entry.reqId,
      cursor: cursor + 1,
    };
  }
  return { type: 'cancel', cursor: cursor + 1 };
}
