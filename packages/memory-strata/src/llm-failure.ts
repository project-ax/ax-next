// Telling a DEPLOYMENT fault apart from a transient one, on the memory paths
// that swallow both.
//
// Every `llm:call:<provider>` provider throws `no-<provider>-credential` when
// nothing resolves a key. It throws PER CALL rather than at boot, deliberately:
// keys resolve per user, so a key stored in the credentials UI has to start
// working without a redeploy. The cost of that design is that a host with no
// key at all looks, to each of these catch blocks, exactly like a host whose
// provider just 504'd.
//
// They are not the same. A 504 fixes itself; a missing credential does not, and
// every turn until someone stores a key silently loses its memory work. The
// memory paths all degrade rather than throw — extraction skipped, map left
// un-densified, rollup left unnamed, retrieval fallen back to BM25 — so the log
// line is the ONLY evidence a deployment is quietly not doing half its job.
//
// Hence one event name, `memory_strata_no_llm_credential`, across every path:
// greppable, alertable, and distinct from the operational noise it used to be
// buried in.

import { PluginError } from '@ax/core';

/** The event every memory path emits when the cause is an absent credential. */
export const NO_CREDENTIAL_EVENT = 'memory_strata_no_llm_credential';

/**
 * True when `err` is a provider's "no credential resolved" error.
 *
 * Matches on the error CODE shape (`no-<provider>-credential`) rather than a
 * list of providers, so a provider plugin added later is covered without
 * editing this file — the code shape is the providers' shared convention.
 */
export function isMissingCredential(err: unknown): boolean {
  return err instanceof PluginError && /^no-.+-credential$/.test(err.code);
}

/**
 * Pick the event name for a failure on a memory path.
 *
 * `fallbackEvent` is the path's existing event, kept for every other cause so
 * this changes volume for exactly one class of failure.
 */
export function memoryFailureEvent(err: unknown, fallbackEvent: string): string {
  return isMissingCredential(err) ? NO_CREDENTIAL_EVENT : fallbackEvent;
}

/**
 * Extra fields worth carrying on the credential event: what broke and what to
 * do about it. An operator reading this line should not need the source.
 */
export function noCredentialFields(): Record<string, unknown> {
  return {
    remedy:
      'store a credential for this provider (credentials UI, or the provider env var) — ' +
      'until then this memory path is skipped on every turn',
  };
}
