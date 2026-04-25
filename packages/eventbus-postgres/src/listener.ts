import pg from 'pg';
import type { Logger } from '@ax/core';

/**
 * Holds the single dedicated pg.Client for LISTEN/NOTIFY. We don't pool —
 * pool clients can be returned mid-listen, breaking subscriptions.
 *
 * Reconnect strategy: on Client.on('error'), schedule a reconnect with
 * exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 30s). On reconnect,
 * re-issue LISTEN for every channel the local instance currently has at
 * least one subscriber for. Subscribers don't see the disconnect — they
 * keep their handlers, and emissions delivered while we were down are
 * lost (LISTEN/NOTIFY is best-effort, not durable).
 */

export type ListenerHandler = (rawJson: string) => void;

export interface ListenerOptions {
  connectionString: string;
  logger?: Logger;
}

interface ChannelState {
  // identifier escaped for use in LISTEN/UNLISTEN statements
  escapedIdentifier: string;
  handlers: Set<ListenerHandler>;
}

export class Listener {
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private channels = new Map<string, ChannelState>();
  private backoffStep = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shutdownRequested = false;
  private readonly logger: Logger | undefined;

  constructor(private readonly opts: ListenerOptions) {
    this.logger = opts.logger;
  }

  // Idempotent: connects on first call, returns the in-flight connect on
  // subsequent calls until it's settled.
  async ensureConnected(): Promise<void> {
    if (this.shutdownRequested) {
      throw new Error('eventbus-postgres listener is shut down');
    }
    if (this.client !== null && !(this.client as unknown as { _ending: boolean })._ending) {
      return;
    }
    if (this.connecting !== null) return this.connecting;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.opts.connectionString });
    client.on('error', (err) => this.onClientError(err));
    client.on('notification', (msg) => this.onNotification(msg));
    await client.connect();
    this.client = client;
    this.backoffStep = 0;
    // Re-LISTEN for every channel that still has subscribers.
    for (const [, state] of this.channels) {
      await client.query(`LISTEN ${state.escapedIdentifier}`);
    }
  }

  private onClientError(err: Error): void {
    if (this.shutdownRequested) return;
    this.logger?.warn?.('eventbus_postgres_listener_error', {
      err,
    });
    // Drop the dead client and schedule reconnect.
    this.client = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.shutdownRequested) return;
    if (this.reconnectTimer !== null) return;
    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    const delay = delays[Math.min(this.backoffStep, delays.length - 1)]!;
    this.backoffStep++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch(() => {
        // ensureConnected logs via onClientError; we already scheduled the
        // next attempt from the error handler, so swallow here.
      });
    }, delay);
    // Don't keep the process alive for the reconnect — Node should be
    // free to exit if the rest of the program is done.
    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  private onNotification(msg: pg.Notification): void {
    const state = this.channels.get(msg.channel);
    if (state === undefined) return;
    const payload = msg.payload ?? '';
    // Snapshot — handlers may unsubscribe during delivery.
    for (const h of [...state.handlers]) {
      try {
        h(payload);
      } catch (err) {
        this.logger?.error?.('eventbus_postgres_handler_threw', {
          channel: msg.channel,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }

  async addSubscriber(channel: string, handler: ListenerHandler): Promise<() => void> {
    await this.ensureConnected();
    let state = this.channels.get(channel);
    if (state === undefined) {
      state = {
        escapedIdentifier: pg.escapeIdentifier(channel),
        handlers: new Set(),
      };
      this.channels.set(channel, state);
      await this.client!.query(`LISTEN ${state.escapedIdentifier}`);
    }
    state.handlers.add(handler);
    return () => {
      const cur = this.channels.get(channel);
      if (cur === undefined) return;
      cur.handlers.delete(handler);
      if (cur.handlers.size === 0) {
        this.channels.delete(channel);
        // Best-effort UNLISTEN; if the client is dead the next reconnect
        // simply won't re-listen on this channel.
        const c = this.client;
        if (c !== null) {
          c.query(`UNLISTEN ${cur.escapedIdentifier}`).catch(() => {});
        }
      }
    };
  }

  async notify(channel: string, payloadJson: string): Promise<void> {
    await this.ensureConnected();
    // pg_notify(text, text) accepts BOTH args as parameters — channel and
    // payload are bound, never interpolated. Belt-and-braces: we already
    // validated the channel against /^[a-zA-Z0-9_]+$/ at the surface, but
    // parameter binding makes injection impossible regardless.
    await this.client!.query(`SELECT pg_notify($1, $2)`, [channel, payloadJson]);
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const c = this.client;
    this.client = null;
    if (c !== null) {
      await c.end().catch(() => {});
    }
    this.channels.clear();
  }
}
