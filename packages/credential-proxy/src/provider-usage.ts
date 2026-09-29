// ---------------------------------------------------------------------------
// The seam between the proxy's byte path and whatever counts model usage
// (TASK-715).
//
// The listener knows bytes and HTTP framing; it knows nothing about who pays or
// what a "limit" is. The plugin knows the user and the usage ledger. This file
// is the whole contract between them, so the listener stays bus-free (the same
// posture as `onAudit`): the plugin hands the listener a `ProviderMeter` on the
// session, and the listener calls it.
//
// The meter is about ONE thing: the operator's model-provider key. A session
// gets one only when `proxy:open-session` marked a credential `metered`.
// ---------------------------------------------------------------------------

/** Token counts read off a provider response. Whole, non-negative numbers. */
export interface MeasuredUsage {
  /** Input tokens NOT served from cache (Anthropic's `input_tokens`). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** What one admitted request turned out to be, handed back exactly once. */
export interface ProviderCallSettlement {
  /**
   * False when nothing chargeable happened: an error status, a token-count
   * call, a read-only call, or a request the tunnel never got an answer for
   * AND that carried no body. `settle` must still be called so the in-flight
   * slot is released.
   */
  billable: boolean;
  model?: string;
  /**
   * What the response reported. Null when the call was billable but nothing
   * could be read (an aborted stream, an encoded body, a framing failure): the
   * meter then charges an estimate from `requestBytes`. Unknown is never free.
   */
  usage: MeasuredUsage | null;
  /** Size of the request body, or null when it was not length-delimited. */
  requestBytes: number | null;
}

/** The gate's answer for a request about to be sent with the key spliced in. */
export type ProviderAdmit =
  | { ok: true }
  | {
      ok: false;
      /** Stable code, e.g. `usage-limit-daily`, `usage-suspended`, `busy`. */
      reason: string;
      /** One sentence a person (or the agent) can act on. No secrets. */
      message: string;
    };

/**
 * The per-session handle the listener calls. Everything here is synchronous or
 * fire-and-forget: the byte path never awaits the usage ledger.
 */
export interface ProviderMeter {
  /** Lower-case exact hostnames whose tunnels are metered (the credential's binding). */
  readonly hosts: ReadonlySet<string>;
  /**
   * `"METHOD /path"` entries the key may be spliced into (exact path, query
   * ignored, a trailing `/*` = one more path segment). Empty = never.
   */
  readonly requests: readonly string[];
  /**
   * Ask to send ONE request with the key spliced in. Synchronous. `{ ok: true }`
   * reserves an in-flight slot that `settle` releases; a refusal reserves
   * nothing.
   */
  admit(): ProviderAdmit;
  /** Report the outcome of one admitted request. Exactly once per `ok` admit. Must not throw. */
  settle(settlement: ProviderCallSettlement): void;
}
