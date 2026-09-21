import { PluginError } from '@ax/core';

/**
 * The failure-event vocabulary for `@ax/memory`'s write path — design §6.4.
 *
 * ## Why every failure has to be an event
 *
 * The observer is fire-and-forget: it returns to `chat:end` immediately and
 * the extraction runs detached. `HookBus.fire` already swallows a subscriber
 * throw as a clean pass, and a detached promise's rejection is swallowed by
 * construction. So a failure inside this path is INVISIBLE unless it emits an
 * event — no turn fails, no caller notices, and the deployment quietly stops
 * remembering anything. The event is the only evidence.
 *
 * ## Why a missing credential is its own event
 *
 * Every `llm:call:<provider>` registrar throws `no-<provider>-credential`
 * when nothing resolves a key, and it throws PER CALL rather than at boot
 * (keys resolve per user, so a key stored in the credentials UI has to start
 * working without a redeploy). The cost of that design is that a host with no
 * key at all looks, to this catch block, exactly like a host whose provider
 * just 504'd.
 *
 * They are not the same. A 504 fixes itself; a missing credential does not,
 * and every turn until someone stores a key silently loses its memory. Hence
 * one distinct, greppable, alertable event — the "memory paused" state — at
 * `error` volume, while everything else stays a `warn`.
 *
 * ## Why this is a copy of `@ax/memory-strata`'s `llm-failure.ts`
 *
 * Invariant 2: no cross-plugin imports. `@ax/memory` and `@ax/memory-strata`
 * are two plugins, and the hook bus is the only thing between them — there is
 * no hook here to call, because this is a local decision about a local log
 * line. Invariant 4 ("one source of truth per concept") is about STATE, and
 * these two plugins never both own a row: design §10.4 puts them in separate
 * presets, one memory plugin per preset. So the duplication is the boundary
 * working, not drifting.
 *
 * The event NAMES are deliberately distinct (`memory_*`, not
 * `memory_strata_*`) so an operator reading a log can tell which plugin
 * produced the line.
 */

/** The event every `@ax/memory` path emits when the cause is an absent credential. */
export const NO_CREDENTIAL_EVENT = 'memory_no_llm_credential';

/** The observer's own failure event, for every other cause. */
export const OBSERVER_FAILED_EVENT = 'memory_observer_failed';

/** The observer's audit line for a run that completed, successfully or not. */
export const OBSERVER_RUN_EVENT = 'memory_observer_run';

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
 * Pick the event name for a failure on the memory write path.
 *
 * `fallbackEvent` is the path's own event, kept for every other cause, so
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
      'until then memory extraction is paused and every turn loses its memory',
  };
}
