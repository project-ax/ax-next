// ---------------------------------------------------------------------------
// Reading a credential-proxy failure without trusting its text (TASK-713,
// TASK-783).
//
// `proxy:open-session` / `proxy:rotate-session` resolve the agent's WHOLE
// merged credential set — the model-provider key and every connector slot.
// When one resolve fails, the proxy rethrows a `credential-resolve-failed`
// PluginError whose `diagnosis.envName` is OUR key for that credential (the
// key we handed it in `credentials`), with the resolver's error on `.cause`.
// Between here and the resolver the error is wrapped up to twice more
// (HookBus wraps a non-PluginError once per `bus.call`), so every check below
// walks the `.cause` chain — bounded, so a cyclic chain cannot hang a turn.
//
// Everything is matched by NAME / CODE, never by importing the thrower's class
// (invariant 2 — no cross-plugin imports), the same duck typing
// `@ax/mcp-client`'s describe-tools `noUsableCredential` uses.
//
// No message text is ever read here. A resolver's message can carry an OAuth
// server's `error_description` — provider-authored and unbounded — and the
// HookBus wrapper copies it into its own message (`service hook '…' threw:
// <inner>`), so a log line built from `err` or `err.message` can echo it.
// `errorLogFields` is the code-only projection the log sites use instead.
// ---------------------------------------------------------------------------

import { clampCodeUnits } from '@ax/core';

/** How many `.cause` links we follow. Real chains are ≤ 4 deep. */
const MAX_CAUSE_DEPTH = 8;

/** The error and its causes, outermost first, bounded and cycle-safe. */
function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && chain.length < MAX_CAUSE_DEPTH) {
    if (chain.includes(cur)) break;
    chain.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return chain;
}

function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Longest name/code a log line carries. Both are identifiers in practice, but
 * an SDK error's `code` can be lifted from a provider's response, so it is
 * clamped like any other field that crossed a trust boundary.
 */
const LOG_FIELD_MAX = 64;

function nameOf(e: unknown): string {
  return clampCodeUnits(e instanceof Error ? e.name : typeof e, LOG_FIELD_MAX);
}

/**
 * A connector's sign-in is dead: the credential resolver threw an error NAMED
 * `NeedsReconnectError` (the OAuth refresh token was rejected, or there is
 * none). The person fixes it by reconnecting that connector.
 *
 * On a SEVERAL-failures open-session error (TASK-828) this answers for the
 * FIRST failure only — the cause chain never visits the aggregate's `errors`.
 * To ask about any failure, map over {@link credentialResolveFailures} first.
 */
export function isNeedsReconnect(err: unknown): boolean {
  return causeChain(err).some((e) => e instanceof Error && e.name === 'NeedsReconnectError');
}

/**
 * The vault had no row for the ref (`@ax/credentials`' `credential-not-found`).
 *
 * On a SEVERAL-failures open-session error (TASK-828) this answers for the
 * FIRST failure only — the cause chain never visits the aggregate's `errors`.
 * To ask about any failure, map over {@link credentialResolveFailures} first.
 */
export function isCredentialNotFound(err: unknown): boolean {
  return causeChain(err).some((e) => codeOf(e) === 'credential-not-found');
}

/**
 * The env key of the credential the proxy failed to resolve, from the
 * outermost `credential-resolve-failed` error's `diagnosis.envName`. Undefined
 * when the failure was not a per-credential resolve (a malformed binding, the
 * proxy not loaded, a listener fault) or the proxy predates TASK-783.
 */
export function failedCredentialEnvName(err: unknown): string | undefined {
  for (const e of causeChain(err)) {
    if (codeOf(e) !== 'credential-resolve-failed') continue;
    const envName = (e as { diagnosis?: { envName?: unknown } }).diagnosis?.envName;
    if (typeof envName === 'string') return envName;
  }
  return undefined;
}

/**
 * Most per-credential failures we read out of one aggregate. An agent's merged
 * credential set is a handful of slots; this only bounds a hostile/buggy array.
 */
const MAX_FAILURES = 64;

/**
 * The individual credential failures inside a failed `proxy:open-session`
 * (TASK-828). Since TASK-828 the proxy tries EVERY ref and, when more than one
 * fails, puts each per-credential `credential-resolve-failed` error in the
 * `errors` of an `AggregateError` on the outer error's cause chain. Each
 * returned element can be read with {@link failedCredentialEnvName},
 * {@link isNeedsReconnect} and {@link isCredentialNotFound} on its own.
 *
 * Anything else — a single failure, or an error from a proxy that predates
 * TASK-828 — is returned as the one failure it is: `[err]`.
 */
export function credentialResolveFailures(err: unknown): unknown[] {
  // Only the proxy's own aggregate counts: the DIRECT cause of the OUTERMOST
  // `credential-resolve-failed`. An AggregateError deeper down belongs to the
  // resolver (Node's dialer throws one for a multi-address connect failure),
  // and reading ITS errors as credential failures would drop the real
  // classification — e.g. a NeedsReconnectError sitting above it.
  const outer = causeChain(err).find((e) => codeOf(e) === 'credential-resolve-failed');
  const agg = (outer as { cause?: unknown } | undefined)?.cause;
  if (agg instanceof Error && agg.name === 'AggregateError') {
    const errors = (agg as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) return errors.slice(0, MAX_FAILURES);
  }
  return [err];
}

/**
 * What a log line may say about an error: its NAME and CODE, and its cause's —
 * never its message (see the module comment). `causeName`/`causeCode` are the
 * INNERMOST cause's, which is where the resolver's own `NeedsReconnectError`
 * or `credential-not-found` lives under the wrappers.
 */
export interface ErrorLogFields {
  name: string;
  code?: string;
  causeName?: string;
  causeCode?: string;
}

export function errorLogFields(err: unknown): ErrorLogFields {
  const out: ErrorLogFields = { name: nameOf(err) };
  const code = codeOf(err);
  if (code !== undefined) out.code = clampCodeUnits(code, LOG_FIELD_MAX);
  const chain = causeChain(err);
  if (chain.length > 1) {
    const inner = chain[chain.length - 1];
    out.causeName = nameOf(inner);
    const innerCode = codeOf(inner);
    if (innerCode !== undefined) out.causeCode = clampCodeUnits(innerCode, LOG_FIELD_MAX);
  }
  return out;
}
