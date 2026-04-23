import { describe, it, expect } from 'vitest';
import { AxConfigSchema } from '../schema.js';

describe('AxConfigSchema', () => {
  it('parses empty input to defaults', () => {
    const result = AxConfigSchema.parse({});
    expect(result).toEqual({
      llm: 'mock',
      sandbox: 'subprocess',
      tools: ['bash', 'file-io'],
      storage: 'sqlite',
    });
  });

  it('rejects unknown llm value', () => {
    expect(() => AxConfigSchema.parse({ llm: 'openai' })).toThrow();
  });

  it('merges partial config over defaults', () => {
    const result = AxConfigSchema.parse({ llm: 'anthropic' });
    expect(result.llm).toBe('anthropic');
    expect(result.sandbox).toBe('subprocess');
    expect(result.tools).toEqual(['bash', 'file-io']);
    expect(result.storage).toBe('sqlite');
  });

  it('requires anthropic.maxTokens to be a positive int', () => {
    expect(() =>
      AxConfigSchema.parse({ anthropic: { maxTokens: 0 } }),
    ).toThrow();
    expect(() =>
      AxConfigSchema.parse({ anthropic: { maxTokens: -5 } }),
    ).toThrow();
    expect(() =>
      AxConfigSchema.parse({ anthropic: { maxTokens: 1.5 } }),
    ).toThrow();
    expect(
      AxConfigSchema.parse({ anthropic: { maxTokens: 100 } }).anthropic
        ?.maxTokens,
    ).toBe(100);
  });
});
