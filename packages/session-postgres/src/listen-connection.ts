import pg from 'pg';
import { faultLogFields, type Logger } from '@ax/core';

// ---------------------------------------------------------------------------
// ListenConnection: session-postgres's one LISTEN connection. When Postgres
// ends it, it reconnects with backoff and LISTENs again (TASK-1061).
//
// It copies @ax/eventbus-postgres's `Listener` (src/listener.ts) instead of
// importing it, because plugins don't import each other (invariant 2). Same
// backoff, same timer `unref()`. Deliberate differences:
//   1. A new client goes live only after it has LISTENed every bound channel.
//      Until then every caller waits on the connect, so nobody can pg_notify
//      a channel the new backend isn't LISTENing on yet. A claim parked on
//      that channel would miss its wake.
//   2. An 'error' drops the live client only if the client that errored IS
//      the live one. A terminated backend emits twice (the server's error,
//      then the socket closing), and the second event must neither schedule
//      a second reconnect nor drop a newer client.
//   3. A connect, or a LISTEN replay, that lands after shutdown() ends its own
//      client and refuses its caller.
//   4. queryIfConnected() (the inbox's UNLISTEN) never opens a connection.
//   5. Log lines carry codes only (faultLogFields): a driver's message can
//      carry a host, a user or a query value.
//
// Why LISTEN can't use the pool: a LISTEN binds to one backend session. A
// pooled connection goes back to the idle set, or is closed once idle, while
// the LISTEN is still wanted, and the binding goes with it.
//
// TASK-1056: no statement_timeout here, on purpose. This connection only runs
// LISTEN, UNLISTEN and pg_notify, and waiting for notifications isn't a
// statement. Its connects are bounded (`connectTimeoutMs`), so a database that
// never answers can't hang a caller.
// ---------------------------------------------------------------------------

/** What every caller gets once shutdown() has run. */
export const LISTEN_CONNECTION_SHUT_DOWN = 'session-postgres LISTEN connection is shut down';

/** Waits between reconnect attempts, in ms: eventbus-postgres's, exactly. The last one repeats. */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

export interface ListenConnectionOptions {
  connectionString: string;
  /** Bound on one connect attempt, in ms (pg's `connectionTimeoutMillis`). */
  connectTimeoutMs: number;
  /** pg's `keepAliveInitialDelayMillis`. TCP keepalive itself is always on. */
  keepAliveInitialDelayMs: number;
  /**
   * Receives `session_postgres_listen_client_error` (error) for every 'error'
   * event of a client this connection made, and
   * `session_postgres_listen_connect_failed` (warn) for each failed connect
   * that shutdown() didn't cause. Both carry codes only.
   */
  logger: Logger;
}

export interface ListenHooks {
  onNotification(msg: pg.Notification): void;
  /** Channels to LISTEN on a new client before it goes live. Iterated live, not snapshotted. */
  channels(): Iterable<string>;
}

export class ListenConnection {
  /** The live client: connected AND LISTENing on every bound channel. */
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private hooks: ListenHooks | null = null;
  private backoffStep = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shutdownRequested = false;

  constructor(private readonly opts: ListenConnectionOptions) {}

  /**
   * Hands over the notification handler and the channel set. Separate from the
   * constructor because the inbox that owns both needs this connection first.
   */
  bind(hooks: ListenHooks): void {
    if (this.hooks !== null) throw new Error('ListenConnection.bind called twice');
    this.hooks = hooks;
  }

  /**
   * Resolves once a live client exists. Concurrent callers share one connect.
   * Rejects with LISTEN_CONNECTION_SHUT_DOWN after shutdown(), or with the
   * failed connect's own error, in which case the next attempt is already
   * scheduled (only shutdown() cancels it).
   */
  async ensureConnected(): Promise<void> {
    if (this.shutdownRequested) throw new Error(LISTEN_CONNECTION_SHUT_DOWN);
    if (this.client !== null) return;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const c = new pg.Client({
      connectionString: this.opts.connectionString,
      connectionTimeoutMillis: this.opts.connectTimeoutMs,
      keepAlive: true,
      keepAliveInitialDelayMillis: this.opts.keepAliveInitialDelayMs,
    });
    // Stays attached for the client's whole life: pg can emit a second 'error'
    // after we've dropped it, and an 'error' with no listener crashes the host.
    c.on('error', (err) => this.onClientError(c, err));
    c.on('notification', (msg) => this.hooks?.onNotification(msg));
    try {
      await c.connect();
      // Live iteration: a channel the inbox drops mid-loop is skipped.
      for (const channel of this.hooks?.channels() ?? []) {
        if (this.shutdownRequested) break;
        await c.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      }
      if (this.shutdownRequested) throw new Error(LISTEN_CONNECTION_SHUT_DOWN);
    } catch (err) {
      // Not awaited: end() can wait forever on a server that stopped answering.
      void c.end().catch(() => {});
      if (!this.shutdownRequested) {
        this.opts.logger.warn('session_postgres_listen_connect_failed', faultLogFields(err));
        // pg emits no client 'error' for a failed connect (ECONNREFUSED, a
        // timeout), so nothing else would schedule the next attempt.
        this.scheduleReconnect();
      }
      throw err;
    }
    // Live only now, after the replay: until here every caller waited on this
    // connect, so no pg_notify could go out ahead of a LISTEN.
    this.client = c;
    this.backoffStep = 0;
  }

  private onClientError(c: pg.Client, err: Error): void {
    if (this.shutdownRequested) return;
    // Every event: a terminated backend writes two lines.
    this.opts.logger.error('session_postgres_listen_client_error', faultLogFields(err));
    // The second event of a dead client, or an event from a client that never
    // went live, drops nothing.
    if (this.client === c) {
      this.client = null;
      this.scheduleReconnect();
    }
    // Don't end() c here: pg is already closing it, and end() would set
    // `_ending` and swallow pg's second event.
  }

  private scheduleReconnect(): void {
    if (this.shutdownRequested) return;
    if (this.reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.backoffStep, RECONNECT_DELAYS_MS.length - 1)]!;
    this.backoffStep++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // A failed attempt has already logged and scheduled the next one.
      this.ensureConnected().catch(() => {});
    }, delay);
    // A pending reconnect doesn't keep the process alive.
    this.reconnectTimer.unref();
  }

  /**
   * Runs a statement on the live client, connecting (and LISTENing again)
   * first if there is none. Rejects with LISTEN_CONNECTION_SHUT_DOWN once
   * shutdown() has run.
   */
  async query(text: string, values?: unknown[]): Promise<pg.QueryResult> {
    await this.ensureConnected();
    const c = this.client;
    if (c === null) throw new Error(LISTEN_CONNECTION_SHUT_DOWN); // shutdown() ran while we waited
    return c.query(text, values);
  }

  /**
   * Best effort, for UNLISTEN: runs only on a live client and never opens a
   * connection. Swallows errors. With no live client there is little to undo:
   * a replay LISTENs a channel only if it is still bound when the loop reaches
   * it. One it already passed keeps its LISTEN, and that channel's
   * notifications find no waiter.
   */
  async queryIfConnected(text: string): Promise<void> {
    const c = this.client;
    if (c === null) return;
    await c.query(text).catch(() => {});
  }

  /**
   * Stops reconnecting and ends the live client. Doesn't wait for a connect in
   * flight: that one ends its own client when it lands.
   */
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const c = this.client;
    this.client = null;
    if (c !== null) await c.end().catch(() => {});
  }
}
