import { describe, it, expect } from 'vitest';
import { AxConfigSchema } from '../schema.js';

describe('AxConfigSchema', () => {
  it('applies defaults when given an empty object', () => {
    const parsed = AxConfigSchema.parse({});
    expect(parsed).toEqual({
      llm: 'mock',
      sandbox: 'subprocess',
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
    expect(parsed.storage).toBe('sqlite');
  });

  it('rejects unknown top-level keys (strict mode)', () => {
    const result = AxConfigSchema.safeParse({
      llm: 'mock',
      bogus: 'hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects the now-removed runner field (strict mode)', () => {
    const result = AxConfigSchema.safeParse({ runner: 'claude-sdk' });
    expect(result.success).toBe(false);
  });

  it('rejects the now-removed tools field (strict mode)', () => {
    const result = AxConfigSchema.safeParse({ tools: ['bash'] });
    expect(result.success).toBe(false);
  });

  it('rejects the now-removed anthropic field (strict mode)', () => {
    const result = AxConfigSchema.safeParse({
      llm: 'anthropic',
      anthropic: { model: 'claude-sonnet-4-6' },
    });
    expect(result.success).toBe(false);
  });
});
