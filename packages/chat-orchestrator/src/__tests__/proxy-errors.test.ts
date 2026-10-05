import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import {
  credentialResolveFailures,
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

  // TASK-828 — the proxy reports EVERY failed credential; each is read alone.
  describe('credentialResolveFailures', () => {
    /** The proxy's several-failures shape: outer named error → AggregateError. */
    function several(failures: PluginError[]): PluginError {
      return new PluginError({
        code: 'credential-resolve-failed',
        plugin: '@ax/credential-proxy',
        message: 'some session credentials could not be resolved',
        cause: new AggregateError(failures, 'several', { cause: failures[0]?.cause }),
        diagnosis: { ...failures[0]?.diagnosis },
      });
    }

    it('one failure (or a pre-TASK-828 proxy) is the error itself', () => {
      const one = proxyFailure('E', reconnect());
      expect(credentialResolveFailures(one)).toEqual([one]);
      const plain = new Error('x');
      expect(credentialResolveFailures(plain)).toEqual([plain]);
    });

    it('several failures come back one per credential, in order, under a bus wrapper too', () => {
      const a = proxyFailure('connector:gmail:GMAIL', reconnect());
      const b = proxyFailure('connector:linear:LINEAR', reconnect());
      const err = several([a, b]);
      expect(credentialResolveFailures(err)).toEqual([a, b]);
      const wrapped = new PluginError({ code: 'unknown', plugin: 'bus', message: 'w', cause: err });
      const got = credentialResolveFailures(wrapped);
      expect(got.map(failedCredentialEnvName)).toEqual(['connector:gmail:GMAIL', 'connector:linear:LINEAR']);
    });

    it("ignores an AggregateError inside ONE resolver's own failure (a dialer's), keeping its classification", () => {
      const dialer = new AggregateError([new Error('ECONNREFUSED a'), new Error('ECONNREFUSED b')], 'connect');
      const r = reconnect();
      (r as { cause?: unknown }).cause = dialer;
      const one = proxyFailure('connector:gmail:GMAIL', r);
      const got = credentialResolveFailures(one);
      expect(got).toEqual([one]);
      expect(isNeedsReconnect(got[0])).toBe(true);
    });

    it('bounds a huge errors array', () => {
      const many = Array.from({ length: 500 }, (_, i) => proxyFailure(`E${i}`, reconnect()));
      expect(credentialResolveFailures(several(many))).toHaveLength(64);
    });
  });
});
