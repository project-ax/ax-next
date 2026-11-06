// ---------------------------------------------------------------------------
// A thrown error's code, when it is safe to put on a log line (TASK-1046,
// review r2 R4 and r3 S5).
//
// Only a `PluginError`'s `code`, and only as a short lower-case slug: the
// bus's own codes (`timeout`, `invalid-return`, `unknown`) and a plugin's
// (`credential-not-found`, `decrypt-failed`) are a closed vocabulary. Anything
// else is dropped, never truncated. This is narrower than `@ax/core`'s
// `faultLogFields`, whose identifier shape also admits digits and capitals
// (`sk-live-123` passes it).
//
// The MESSAGE is never read: the SDK and `HookBus.call` both put a server's or
// a handler's own words in it. Never throws: plugin code can mutate an Error.
// ---------------------------------------------------------------------------

import { PluginError } from '@ax/core';

/** A code is vocabulary only as a short lower-case slug. */
const LOGGABLE_CODE = /^[a-z][a-z-]{0,39}$/;

export function loggableCode(err: unknown): string | undefined {
  try {
    if (!(err instanceof PluginError)) return undefined;
    const code: unknown = err.code;
    return typeof code === 'string' && LOGGABLE_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}
