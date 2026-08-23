// Core-emitted codes are the documented set; plugins may extend with their
// own domain codes (e.g. 'duplicate-session', 'unknown-session'). The
// `(string & {})` branch preserves autocomplete on the known literals while
// keeping the union open — see TS FAQ "string literal union with autocomplete."
// Plugins should still prefer reusing an existing code when it fits (e.g.
// 'invalid-payload' for malformed input).
export type PluginErrorCode =
  | 'no-service'
  | 'duplicate-service'
  | 'duplicate-plugin'
  | 'timeout'
  | 'invalid-payload'
  | 'invalid-return'
  | 'invalid-manifest'
  | 'cycle'
  | 'missing-service'
  | 'init-failed'
  | 'subscriber-failed'
  | 'unknown'
  | (string & {});

export interface PluginErrorOptions {
  code: PluginErrorCode;
  plugin: string;
  message: string;
  hookName?: string;
  cause?: unknown;
  /**
   * Optional structured, AUTHOR-FACING diagnosis carried alongside the error.
   * Generic on purpose so `@ax/core` stays dependency-free: a plugin attaches a
   * small, neutral object (e.g. the dev-service-sidecar diagnosis from TASK-160
   * — `{ service, path?, reason }`) that a downstream catch surfaces to the
   * user. It MUST be a plain, already-bounded/sanitized, transport-neutral
   * value (no backend vocab, no secrets, no unbounded text) — the consumer
   * renders it as untrusted text. Omitted for ordinary errors.
   */
  diagnosis?: Record<string, unknown>;
}

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly plugin: string;
  readonly hookName?: string;
  /** See {@link PluginErrorOptions.diagnosis}. */
  readonly diagnosis?: Record<string, unknown>;

  constructor(opts: PluginErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'PluginError';
    this.code = opts.code;
    this.plugin = opts.plugin;
    if (opts.hookName !== undefined) this.hookName = opts.hookName;
    if (opts.diagnosis !== undefined) this.diagnosis = opts.diagnosis;
  }

  // `cause` is intentionally omitted from toJSON() to keep stack traces out of
  // structured logs; callers that need the cause can still read err.cause.
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      plugin: this.plugin,
      message: this.message,
    };
    if (this.hookName !== undefined) out.hookName = this.hookName;
    return out;
  }
}

export interface Rejection {
  readonly rejected: true;
  readonly reason: string;
  readonly source?: string;
  /**
   * The specific inputs this rejection is ABOUT — for a payload carrying a set
   * of items, the subset that actually offended. Purely a statement of fact:
   * "these, not the rest." It grants nothing and relaxes nothing; the veto is
   * exactly as strict either way.
   *
   * Why it exists: a veto over a batch used to be indistinguishable from a veto
   * over the whole batch, so the only safe response was to throw the batch
   * away. On `workspace:pre-apply` that meant one refused `CLAUDE.md` write
   * discarded every unrelated file the agent had written — see the handler in
   * `@ax/ipc-core`, which narrows the runner's rollback to exactly these paths.
   *
   * Advisory and OPTIONAL. A consumer that doesn't understand it must fall back
   * to its existing whole-batch behaviour (fail-closed), and every consumer is
   * free to ignore it — a subscriber naming paths is not authorising anything.
   * Consumers that act on it MUST validate the entries against the payload they
   * actually sent; nothing here is trusted input.
   */
  readonly offendingPaths?: readonly string[];
}

export function reject(opts: {
  reason: string;
  source?: string;
  offendingPaths?: readonly string[];
}): Rejection {
  // Build only the keys that are actually present. An explicit `undefined`
  // property is NOT the same as an absent one once this crosses a zod parse or
  // a `toEqual`, and every existing caller passes neither optional field.
  const r: { rejected: true; reason: string; source?: string; offendingPaths?: readonly string[] } =
    { rejected: true, reason: opts.reason };
  if (opts.source !== undefined) r.source = opts.source;
  // An empty array carries no information and would read as "some paths, none
  // of them" downstream. Drop it so absent and empty are the same thing.
  if (opts.offendingPaths !== undefined && opts.offendingPaths.length > 0) {
    r.offendingPaths = opts.offendingPaths;
  }
  return r;
}

export function isRejection(value: unknown): value is Rejection {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { rejected?: unknown }).rejected === true &&
    typeof (value as { reason?: unknown }).reason === 'string'
  );
}

/**
 * A `hold` is a rejection that carries a durable decision id — "a human must
 * see this first", not "no". Deliberately a SUBTYPE of `Rejection` rather than
 * a third `FireResult` arm: `FireResult` has 67 consumers and the correct
 * behaviour for every one of them that does not know about holds is to treat
 * it as a veto. Fail-closed by construction. Only the `tool.pre-call` handler
 * looks for `.hold` and upgrades it to the wire's `hold` verdict.
 */
export interface Hold extends Rejection {
  readonly hold: { readonly decisionId: string; readonly note: string };
}

/**
 * The wire schema (`ToolPreCallResponseSchema`) caps `note` at 2000 characters.
 * We clamp HERE, at the producer, rather than letting an over-long note fail
 * `safeParse` in the host handler — that failure path returns a 500, which the
 * runner's fail-closed catch turns into a generic deny, and a deny is exactly
 * the outcome `hold` exists to avoid. A truncated sentence is a far better
 * failure than a hold that quietly becomes "no".
 */
export const HOLD_NOTE_MAX = 2000;

export function hold(opts: {
  decisionId: string;
  note: string;
  source?: string;
}): Hold {
  const note =
    opts.note.length > HOLD_NOTE_MAX ? opts.note.slice(0, HOLD_NOTE_MAX) : opts.note;
  const base = { rejected: true as const, reason: note };
  const withSource = opts.source !== undefined ? { ...base, source: opts.source } : base;
  return { ...withSource, hold: { decisionId: opts.decisionId, note } };
}

/**
 * Deliberately requires NON-EMPTY `decisionId` and `note`, matching the wire
 * schema's `.min(1)`. A structurally-broken hold therefore reads as a plain
 * `Rejection` and degrades to a deny carrying its own reason — instead of
 * being recognised as a hold, failing the response-schema parse, and coming
 * back as an opaque 500. Both outcomes are fail-closed; only one tells the
 * model anything useful.
 */
export function isHold(value: unknown): value is Hold {
  if (!isRejection(value)) return false;
  const h = (value as { hold?: unknown }).hold;
  if (typeof h !== 'object' || h === null) return false;
  const { decisionId, note } = h as { decisionId?: unknown; note?: unknown };
  return (
    typeof decisionId === 'string' &&
    decisionId.length > 0 &&
    typeof note === 'string' &&
    note.length > 0 &&
    note.length <= HOLD_NOTE_MAX
  );
}
