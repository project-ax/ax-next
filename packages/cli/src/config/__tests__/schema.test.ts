import { describe, it, expect } from 'vitest';
import { AxConfigSchema } from '../schema.js';

describe('AxConfigSchema', () => {
  it('applies defaults when given an empty object', () => {
    const parsed = AxConfigSchema.parse({});
    expect(parsed).toEqual({
      llm: 'mock',
      sandbox: 'subprocess',
      tools: ['bash', 'file-io'],
      storage: 'sqlite',
    });
  });

  it('rejects unknown llm providers', () => {
    const result = AxConfigSchema.safeParse({ llm: 'openai' });
    expect(result.success).toBe(false);
  });

  it('merges partial config with defaults', () => {
    const parsed = AxConfigSchema.parse({ llm: 'anthropic' });
    expect(parsed.llm).toBe('anthropic');
    expect(parsed.sandbox).toBe('subprocess');
    expect(parsed.tools).toEqual(['bash', 'file-io']);
    expect(parsed.storage).toBe('sqlite');
  });

  it('rejects non-positive anthropic.maxTokens', () => {
    const result = AxConfigSchema.safeParse({
      llm: 'anthropic',
      anthropic: { maxTokens: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict mode)', () => {
    const result = AxConfigSchema.safeParse({
      llm: 'mock',
      bogus: 'hello',
    });
    expect(result.success).toBe(false);
  });
});
