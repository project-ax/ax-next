import { PluginError } from './errors.js';
import { SafeToolError } from './safe-tool-error.js';

/** An identifier, not prose: a PluginError code, a SQLSTATE, a Node errno. */
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** What a log line may say about a failure without writing its message. */
export interface FaultLogFields {
  code?: string;
  causeCode?: string;
}

/**
 * The codes of a failure, for a log line that must not carry its message.
 *
 * A message can quote the request, stored data or a provider's reply, and the
 * core logger writes an Error field's message whole. So a route that answers
 * a 5xx it can't explain to the caller logs THIS instead of `err`.
 *
 * - `code` is the error's own: a SafeToolError's `toolCode` (its PluginError
 *   code is always `invalid-payload`, which says nothing), a PluginError's
 *   `code`, or an identifier-shaped `code` on any other error (SQLSTATE,
 *   errno).
 * - `causeCode` is the same, one level down. `HookBus.call` wraps whatever a
 *   service throws as `PluginError{ code: 'unknown', cause }`, so the outer
 *   code alone usually reads `unknown`.
 *
 * A code that isn't identifier-shaped is dropped, not truncated. Never throws.
 */
export function faultLogFields(err: unknown): FaultLogFields {
  const out: FaultLogFields = {};
  const code = codeOf(err);
  if (code !== undefined) out.code = code;
  const causeCode = codeOf(causeOf(err));
  if (causeCode !== undefined) out.causeCode = causeCode;
  return out;
}

function causeOf(err: unknown): unknown {
  try {
    return err instanceof Error ? err.cause : undefined;
  } catch {
    return undefined;
  }
}

function codeOf(err: unknown): string | undefined {
  try {
    if (err instanceof SafeToolError) return checked(err.toolCode);
    if (err instanceof PluginError) return checked(err.code);
    if (err instanceof Error) return checked((err as { code?: unknown }).code);
    return undefined;
  } catch {
    return undefined;
  }
}

function checked(code: unknown): string | undefined {
  return typeof code === 'string' && CODE_RE.test(code) ? code : undefined;
}
