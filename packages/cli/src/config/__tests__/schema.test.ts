import { describe, it, expect } from 'vitest';
import { AxConfigSchema } from '../schema.js';

describe('AxConfigSchema', () => {
  it('applies defaults when given an empty object', () => {
    const parsed = AxConfigSchema.parse({});
    expect(parsed).toEqual({
      sandbox: 'subprocess',
      storage: 'sqlite',
    });
  });

  it('rejects unknown sandbox providers', () => {
    const result = AxConfigSchema.safeParse({ sandbox: 'docker' });
    expect(result.success).toBe(false);
  });

  it('merges partial config with defaults', () => {
    const parsed = AxConfigSchema.parse({ sandbox: 'subprocess' });
    expect(parsed.sandbox).toBe('subprocess');
    expect(parsed.storage).toBe('sqlite');
  });

  it('rejects unknown top-level keys (strict mode)', () => {
    const result = AxConfigSchema.safeParse({
      sandbox: 'subprocess',
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
      anthropic: { model: 'claude-sonnet-4-6' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects the now-removed llm field (strict mode)', () => {
    const result = AxConfigSchema.safeParse({ llm: 'anthropic' });
    expect(result.success).toBe(false);
  });
});
