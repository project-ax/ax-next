import { PluginError } from './errors.js';
import { SafeToolError } from './safe-tool-error.js';

/** An identifier, not prose: a PluginError code, a SQLSTATE, a Node errno, a hook or plugin name. */
const CODE_RE = /^[A-Za-z0-9@][A-Za-z0-9_.:/@-]{0,99}$/;

/** What a log line may say about a failure without writing its message. */
// A type alias, not an interface, so it spreads into a logger's bindings
// (`Record<string, unknown>`) without a cast.
export type FaultLogFields = {
  code?: string;
  causeCode?: string;
  /** The error's class name (`TypeError`, `PluginError`, `ZodError`). */
  name?: string;
  /** The cause's class name. */
  causeName?: string;
  /** A PluginError's own hook and plugin: which bus call failed. */
  hookName?: string;
  plugin?: string;
};

/**
 * The codes of a failure, for a log line that must not carry its message.
 *
 * A message can quote the request, stored data or a provider's reply, and the
 * core logger writes an Error field's message whole. So a route that answers
 * a 5xx it can't explain to the caller logs THIS instead of `err`.
 *
 * - `code` is the error's own: a SafeToolError's `toolCode` (its PluginError
 *   code is always `invalid-payload`, which says nothing; a mutated one reads
 *   `unavailable`, as the routes render it), a PluginError's
 *   `code`, or an identifier-shaped `code` on any other error (SQLSTATE,
 *   errno).
 * - `causeCode` is the same, one level down. `HookBus.call` wraps whatever a
 *   service throws as `PluginError{ code: 'unknown', cause }`, so the outer
 *   code alone usually reads `unknown`.
 *
 * - `name` / `causeName` are the class names, and `hookName` / `plugin` a
 *   PluginError's own identifiers: a raw `TypeError` behind the bus has no
 *   code at all, and these still say what failed and where.
 *
 * Every field must be identifier-shaped, or it is dropped, not truncated.
 * Never throws.
 */
export function faultLogFields(err: unknown): FaultLogFields {
  const out: FaultLogFields = {};
  const cause = causeOf(err);
  const fields: Array<[keyof FaultLogFields, () => unknown]> = [
    ['code', () => codeOf(err)],
    ['causeCode', () => codeOf(cause)],
    ['name', () => (err instanceof Error ? err.name : undefined)],
    ['causeName', () => (cause instanceof Error ? cause.name : undefined)],
    ['hookName', () => (err instanceof PluginError ? err.hookName : undefined)],
    ['plugin', () => (err instanceof PluginError ? err.plugin : undefined)],
  ];
  for (const [key, read] of fields) {
    let value: string | undefined;
    try {
      value = checked(read());
    } catch {
      value = undefined;
    }
    if (value !== undefined) out[key] = value;
  }
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
    // Re-checked against the closed set: plugin code can mutate Error objects.
    if (err instanceof SafeToolError) return new SafeToolError(err.toolCode, 'input').toolCode;
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
