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
      runner: 'native',
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

  it('defaults runner to "native" when omitted', () => {
    const parsed = AxConfigSchema.parse({});
    expect(parsed.runner).toBe('native');
  });

  it('accepts explicit runner "native"', () => {
    const parsed = AxConfigSchema.parse({ runner: 'native' });
    expect(parsed.runner).toBe('native');
  });

  it('accepts explicit runner "claude-sdk"', () => {
    const parsed = AxConfigSchema.parse({ runner: 'claude-sdk' });
    expect(parsed.runner).toBe('claude-sdk');
  });

  it('rejects unknown runner values', () => {
    for (const bad of ['pi-session', 'foo', '']) {
      const result = AxConfigSchema.safeParse({ runner: bad });
      expect(result.success, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
    }
  });

  it('rejects non-string runner values', () => {
    for (const bad of [null, 42]) {
      const result = AxConfigSchema.safeParse({ runner: bad });
      expect(result.success, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
    }
  });
});
