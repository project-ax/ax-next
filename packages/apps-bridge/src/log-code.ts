// A thrown error's code, when it is safe to put on a log line. Copied (I2:
// no cross-plugin runtime import) from @ax/mcp-client's
// src/connector-inventory/loggable-code.ts, which says why: only a
// `PluginError`'s `code`, and only as a short lower-case slug. The MESSAGE is
// never read (a handler's or a server's own words go there). Never throws.

import { PluginError } from '@ax/core';

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
