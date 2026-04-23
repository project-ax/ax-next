import { describe, it, expect } from 'vitest';
import { PluginError, reject, isRejection } from '../errors.js';

describe('PluginError', () => {
  it('captures code, plugin, and cause', () => {
    const cause = new Error('underlying');
    const err = new PluginError({
      code: 'no-service',
      plugin: 'core',
      message: 'no plugin registered for llm:call',
      cause,
    });
    expect(err.code).toBe('no-service');
    expect(err.plugin).toBe('core');
    expect(err.message).toBe('no plugin registered for llm:call');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it('serializes for logging', () => {
    const err = new PluginError({
      code: 'timeout',
      plugin: 'llm-anthropic',
      message: 'llm:call timed out after 60s',
    });
    expect(err.toJSON()).toMatchObject({
      name: 'PluginError',
      code: 'timeout',
      plugin: 'llm-anthropic',
      message: 'llm:call timed out after 60s',
    });
  });
});

describe('reject', () => {
  it('returns a rejection sentinel', () => {
    const r = reject({ reason: 'secret detected' });
    expect(isRejection(r)).toBe(true);
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe('secret detected');
  });

  it('isRejection returns false for ordinary objects', () => {
    expect(isRejection({ foo: 'bar' })).toBe(false);
    expect(isRejection(null)).toBe(false);
    expect(isRejection(undefined)).toBe(false);
  });
});
