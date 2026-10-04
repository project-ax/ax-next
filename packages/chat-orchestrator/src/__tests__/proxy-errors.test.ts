import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import {
  errorLogFields,
  failedCredentialEnvName,
  isCredentialNotFound,
  isNeedsReconnect,
} from '../proxy-errors.js';

// TASK-783 — reading a credential-proxy failure by name/code only.

function reconnect(): Error {
  const e = new Error('refresh rejected: error_description=provider text');
  e.name = 'NeedsReconnectError';
  return e;
}

/** The production shape: proxy wrapper → bus wrapper → resolver error. */
function proxyFailure(envName: string, inner: unknown): PluginError {
  return new PluginError({
    code: 'credential-resolve-failed',
    plugin: '@ax/credential-proxy',
    message: 'a session credential could not be resolved',
    cause: new PluginError({ code: 'unknown', plugin: '@ax/mcp-oauth', message: 'wrapped', cause: inner }),
    diagnosis: { envName },
  });
}

describe('proxy-errors', () => {
  it('finds NeedsReconnectError and credential-not-found at any depth', () => {
    expect(isNeedsReconnect(proxyFailure('E', reconnect()))).toBe(true);
    expect(isNeedsReconnect(reconnect())).toBe(true);
    expect(isNeedsReconnect(new Error('x'))).toBe(false);
    const notFound = new PluginError({ code: 'credential-not-found', plugin: 'c', message: 'm' });
    expect(isCredentialNotFound(proxyFailure('E', notFound))).toBe(true);
    expect(isCredentialNotFound(proxyFailure('E', reconnect()))).toBe(false);
  });

  it('reads the failing env key only from a credential-resolve-failed diagnosis', () => {
    expect(failedCredentialEnvName(proxyFailure('connector:gmail:GMAIL', reconnect()))).toBe(
      'connector:gmail:GMAIL',
    );
    // A diagnosis on some OTHER code is not an attribution.
    const other = new PluginError({ code: 'x', plugin: 'p', message: 'm', diagnosis: { envName: 'E' } });
    expect(failedCredentialEnvName(other)).toBeUndefined();
    expect(failedCredentialEnvName(reconnect())).toBeUndefined();
  });

  it('a cyclic cause chain terminates', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isNeedsReconnect(a)).toBe(false);
    expect(errorLogFields(a)).toEqual({ name: 'Error', causeName: 'Error' });
  });

  it('errorLogFields never carries a message, and clamps name/code', () => {
    const fields = errorLogFields(proxyFailure('E', reconnect()));
    expect(fields).toEqual({
      name: 'PluginError',
      code: 'credential-resolve-failed',
      causeName: 'NeedsReconnectError',
    });
    expect(JSON.stringify(fields)).not.toContain('provider text');

    const long = new Error('m') as Error & { code?: string };
    long.name = 'N'.repeat(500);
    long.code = 'C'.repeat(500);
    const clamped = errorLogFields(long);
    expect(clamped.name.length).toBeLessThanOrEqual(64);
    expect((clamped.code ?? '').length).toBeLessThanOrEqual(64);
    expect(errorLogFields('a string')).toEqual({ name: 'string' });
  });
});
