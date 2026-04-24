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
}

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly plugin: string;
  readonly hookName?: string;

  constructor(opts: PluginErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'PluginError';
    this.code = opts.code;
    this.plugin = opts.plugin;
    if (opts.hookName !== undefined) this.hookName = opts.hookName;
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
}

export function reject(opts: { reason: string; source?: string }): Rejection {
  const r: Rejection = opts.source !== undefined
    ? { rejected: true, reason: opts.reason, source: opts.source }
    : { rejected: true, reason: opts.reason };
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
