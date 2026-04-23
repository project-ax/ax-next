export type PluginErrorCode =
  | 'no-service'
  | 'duplicate-service'
  | 'timeout'
  | 'invalid-payload'
  | 'invalid-manifest'
  | 'cycle'
  | 'missing-service'
  | 'init-failed'
  | 'subscriber-failed'
  | 'unknown';

export interface PluginErrorOptions {
  code: PluginErrorCode;
  plugin: string;
  message: string;
  cause?: unknown;
}

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly plugin: string;

  constructor(opts: PluginErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'PluginError';
    this.code = opts.code;
    this.plugin = opts.plugin;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      plugin: this.plugin,
      message: this.message,
    };
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
