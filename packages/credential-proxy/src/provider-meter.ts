// ---------------------------------------------------------------------------
// The per-user side of the provider meter (TASK-715).
//
// The listener asks a synchronous question ("may this request carry the key?")
// and reports a synchronous fact ("that request finished, here is what it used").
// The answer lives in the usage ledger, which is async and in another plugin. This
// class is the bridge: a small in-memory cache of the ledger's verdict per USER
// (not per session, so many sessions multiply nothing), refreshed in the
// background, plus a count of calls in flight.
//
// The ledger is the source of truth; this is a cache of one bit and a counter.
//
//   - `blocked` is set by the verdict every recorded call gets back, and by a
//     status check at session open and again every REFRESH_MS while the user is
//     active (PROBE_MS while blocked, so a lifted block clears quickly).
//   - A check or record that FAILS blocks (fail closed, like `chat:start`). The
//     refusal is a 429, which both SDKs retry, so a database blip heals itself.
//   - `inFlight` bounds the overshoot: the block lands after a response
//     completes, so without a cap a burst could spend on many requests before the
//     first one is counted.
//
// State is per host process. With several replicas the in-flight cap and the
// cached bit are per replica; the ledger they read and write is shared.
// ---------------------------------------------------------------------------

import { makeAgentContext, type AgentContext } from '@ax/core';
import type { MeasuredUsage, ProviderAdmit, ProviderCallSettlement, ProviderMeter } from './provider-usage.js';

/** What the usage ledger says about one user. */
export type UsageVerdict = { blocked: false } | { blocked: true; reason: string };

/** The record call's payload: what one billable call turned out to be. */
export interface UsageRecordPayload {
  model?: string;
  usage: MeasuredUsage | null;
  requestBytes: number | null;
  /** Only when the response ended early; see ProviderCallSettlement.partial. */
  partial?: { bytes: number; streamed: boolean };
}

/**
 * The two calls the meter makes on the usage ledger. The plugin adapts them to
 * `usage:provider-status` / `usage:provider-record`; tests pass fakes.
 */
export interface UsageLedgerPort {
  status(ctx: AgentContext): Promise<UsageVerdict>;
  record(ctx: AgentContext, payload: UsageRecordPayload): Promise<UsageVerdict>;
}

export const DEFAULT_MAX_IN_FLIGHT_PER_USER = 8;
export const DEFAULT_REFRESH_MS = 15_000;
export const DEFAULT_PROBE_MS = 5_000;

export interface ProviderMeterHubOptions {
  /**
   * The usage ledger, or a function that finds it (asked each time a session
   * opens, because the plugin that provides it may finish loading after this
   * one). Absent or undefined when no usage plugin is loaded: the endpoint
   * allowlist still applies, nothing is counted or limited.
   */
  ledger?: UsageLedgerPort | (() => UsageLedgerPort | undefined);
  now?: () => number;
  maxInFlightPerUser?: number;
  refreshMs?: number;
  probeMs?: number;
  /** Diagnostics only. Never receives a secret. */
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface SessionMeterInput {
  sessionId: string;
  userId: string;
  agentId: string;
  /** Hosts the metered credential is bound to. */
  hosts: readonly string[];
  /** `"METHOD /path"` entries the key may be spliced into. */
  requests: readonly string[];
}

interface UserState {
  userId: string;
  ctx: AgentContext;
  sessions: Set<string>;
  inFlight: number;
  ledger: UsageLedgerPort | undefined;
  blocked: { reason: string } | undefined;
  checkedAt: number;
  checking: boolean;
  /** Increments per ledger call; only the newest answer is applied. */
  seq: number;
  appliedSeq: number;
}

/** A sentence a person can act on for each reason the ledger (or this class) gives. */
export function refusalMessage(reason: string): string {
  switch (reason) {
    case 'usage-suspended':
      return "This account's model access is paused. Ask an admin to resume it.";
    case 'usage-limit-daily':
      return (
        'This account has used up its model allowance for now. It frees up as earlier ' +
        'usage ages out of the last 24 hours, or an admin can raise the limit.'
      );
    case 'busy':
      return 'Too many model calls are running at once for this account. Wait for some to finish.';
    case 'session-closed':
      return 'This session has ended, so its model access has too.';
    default:
      return (
        'The usage check is not available right now, so model calls are paused for a moment. ' +
        'Try again in a few seconds.'
      );
  }
}

export class ProviderMeterHub {
  private readonly users = new Map<string, UserState>();
  private readonly now: () => number;
  private readonly maxInFlight: number;
  private readonly refreshMs: number;
  private readonly probeMs: number;

  private readonly resolveLedger: () => UsageLedgerPort | undefined;

  constructor(private readonly opts: ProviderMeterHubOptions = {}) {
    const ledger = opts.ledger;
    this.resolveLedger = typeof ledger === 'function' ? ledger : () => ledger;
    this.now = opts.now ?? Date.now;
    this.maxInFlight = opts.maxInFlightPerUser ?? DEFAULT_MAX_IN_FLIGHT_PER_USER;
    this.refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
    this.probeMs = opts.probeMs ?? DEFAULT_PROBE_MS;
  }

  /**
   * The meter for one session, and the `close` that ends it. Awaits the first
   * status check, so a user who is already blocked starts blocked rather than
   * getting one free round trip.
   */
  async forSession(input: SessionMeterInput): Promise<{ meter: ProviderMeter; close: () => void }> {
    const st = this.stateFor(input);
    st.sessions.add(input.sessionId);
    st.ledger = this.resolveLedger();
    if (st.ledger !== undefined) await this.check(st);

    let closed = false;
    const hosts = new Set(input.hosts.map((h) => h.trim().replace(/[A-Z]/g, (c) => c.toLowerCase())));
    const meter: ProviderMeter = {
      hosts,
      requests: [...input.requests],
      admit: (): ProviderAdmit => {
        if (st.ledger === undefined) return { ok: true };
        if (closed) return refuse('session-closed');
        this.refreshIfStale(st);
        if (st.blocked !== undefined) return refuse(st.blocked.reason);
        if (st.inFlight >= this.maxInFlight) return refuse('busy');
        st.inFlight++;
        return { ok: true };
      },
      settle: (s: ProviderCallSettlement): void => {
        if (st.ledger === undefined) return;
        st.inFlight = Math.max(0, st.inFlight - 1);
        if (s.billable) void this.record(st, s);
        else this.maybeEvict(st);
      },
    };
    // A session ended: its meter refuses from now on, and the user's state goes
    // once nothing of theirs is in flight or being checked.
    const close = (): void => {
      closed = true;
      st.sessions.delete(input.sessionId);
      this.maybeEvict(st);
    };
    return { meter, close };
  }

  /** Test seam: the cached view of one user. */
  peek(userId: string): { inFlight: number; blocked: string | undefined } | undefined {
    const st = this.users.get(userId);
    return st === undefined ? undefined : { inFlight: st.inFlight, blocked: st.blocked?.reason };
  }

  private stateFor(input: SessionMeterInput): UserState {
    const existing = this.users.get(input.userId);
    if (existing !== undefined) return existing;
    const st: UserState = {
      userId: input.userId,
      ctx: makeAgentContext({
        sessionId: input.sessionId,
        agentId: input.agentId,
        userId: input.userId,
      }),
      sessions: new Set(),
      inFlight: 0,
      ledger: undefined,
      blocked: undefined,
      checkedAt: 0,
      checking: false,
      seq: 0,
      appliedSeq: 0,
    };
    this.users.set(input.userId, st);
    return st;
  }

  private maybeEvict(st: UserState): void {
    if (st.sessions.size === 0 && st.inFlight === 0 && !st.checking) {
      if (this.users.get(st.userId) === st) this.users.delete(st.userId);
    }
  }

  private refreshIfStale(st: UserState): void {
    const limit = st.blocked !== undefined ? this.probeMs : this.refreshMs;
    if (st.checking || this.now() - st.checkedAt < limit) return;
    void this.check(st);
  }

  /** Ask the ledger for the user's status and apply it (the newest answer wins). */
  private async check(st: UserState): Promise<void> {
    const ledger = st.ledger;
    if (ledger === undefined) return;
    const seq = ++st.seq;
    st.checking = true;
    try {
      this.apply(st, seq, await ledger.status(st.ctx));
    } catch (err) {
      this.opts.log?.('provider_meter_status_failed', { err: describe(err) });
      this.apply(st, seq, { blocked: true, reason: 'usage-check-unavailable' });
    } finally {
      st.checking = false;
      this.maybeEvict(st);
    }
  }

  /** Charge one billable call and apply the verdict that comes back with it. */
  private async record(st: UserState, s: ProviderCallSettlement): Promise<void> {
    const ledger = st.ledger;
    if (ledger === undefined) return;
    const seq = ++st.seq;
    const payload: UsageRecordPayload = {
      ...(s.model !== undefined ? { model: s.model } : {}),
      usage: s.usage,
      requestBytes: s.requestBytes,
      ...(s.partial !== undefined ? { partial: s.partial } : {}),
    };
    try {
      this.apply(st, seq, await ledger.record(st.ctx, payload));
    } catch (err) {
      this.opts.log?.('provider_meter_record_failed', { err: describe(err) });
      this.apply(st, seq, { blocked: true, reason: 'usage-check-unavailable' });
    } finally {
      this.maybeEvict(st);
    }
  }

  private apply(st: UserState, seq: number, verdict: UsageVerdict): void {
    if (seq < st.appliedSeq) return; // a newer answer already landed
    st.appliedSeq = seq;
    st.checkedAt = this.now();
    st.blocked = verdict.blocked ? { reason: verdict.reason } : undefined;
  }
}

function refuse(reason: string): ProviderAdmit {
  return { ok: false, reason, message: refusalMessage(reason) };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
