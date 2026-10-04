import { PluginError } from '@ax/core';

const PLUGIN_NAME = '@ax/connectors';

/** A hook's user id: a non-empty string of at most 256 chars, else `invalid-payload`. */
export function requireUserId(value: unknown, hookName: string, field = 'userId'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `${field} must be a non-empty string`,
    });
  }
  return value;
}
