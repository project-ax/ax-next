import { describe, it, expect } from 'vitest';
import { parseModelRef, isModelRef } from '../model-ref.js';
import { PluginError } from '../errors.js';

describe('parseModelRef', () => {
  it('splits a simple ref on the first slash', () => {
    expect(parseModelRef('anthropic/claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
  });

  it('keeps a nested vendor slug in modelId — splits on the FIRST slash only', () => {
    expect(parseModelRef('openrouter/x-ai/grok-4.6')).toEqual({
      provider: 'openrouter',
      modelId: 'x-ai/grok-4.6',
    });
  });

  it('keeps a colon-variant suffix intact (the reason `/` beat `:`)', () => {
    expect(
      parseModelRef('openrouter/google/gemini-3.7-flash:batch'),
    ).toEqual({
      provider: 'openrouter',
      modelId: 'google/gemini-3.7-flash:batch',
    });
  });

  it.each([
    ['empty string', ''],
    ['whitespace-only', '   '],
    ['no slash', 'claude-sonnet-4-6'],
    ['empty provider', '/model'],
    ['empty model id', 'provider/'],
  ])('throws PluginError(invalid-payload) on %s', (_label, ref) => {
    expect(() => parseModelRef(ref)).toThrowError(PluginError);
    try {
      parseModelRef(ref);
      throw new Error('expected parseModelRef to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).code).toBe('invalid-payload');
      expect((err as PluginError).plugin).toBe('core');
    }
  });
});

describe('isModelRef', () => {
  it.each([
    ['anthropic/claude-sonnet-4-6', true],
    ['openrouter/x-ai/grok-4.6', true],
    ['openrouter/google/gemini-3.7-flash:batch', true],
    ['', false],
    ['   ', false],
    ['claude-sonnet-4-6', false],
    ['/model', false],
    ['provider/', false],
  ])('isModelRef(%j) === %s', (ref, expected) => {
    expect(isModelRef(ref)).toBe(expected);
  });

  it('never throws', () => {
    expect(() => isModelRef('')).not.toThrow();
    expect(() => isModelRef('/model')).not.toThrow();
  });
});
