import { describe, expect, it } from 'vitest';
import {
  SYSTEM_PROMPT_AUGMENT_MAX_BODY_CHARS,
  SYSTEM_PROMPT_AUGMENT_OPTIONAL_PREFIX,
  SYSTEM_PROMPT_AUGMENT_REQUIRED_PREFIX,
  SystemPromptAugmentOutputSchema,
} from '../index.js';

describe('system-prompt augment contract (W1)', () => {
  it('names the two provider classes by prefix', () => {
    expect(SYSTEM_PROMPT_AUGMENT_REQUIRED_PREFIX).toBe('system-prompt:augment:required:');
    expect(SYSTEM_PROMPT_AUGMENT_OPTIONAL_PREFIX).toBe('system-prompt:augment:optional:');
    expect(SYSTEM_PROMPT_AUGMENT_MAX_BODY_CHARS).toBe(32_000);
  });

  it.each([
    ['nothing', {}],
    ['rules', { rules: 'r' }],
    ['brief', { brief: 'b' }],
    ['context', { context: 'c' }],
    ['recall', { recall: 'm' }],
    ['every section, empty bodies included', { rules: '', brief: '', context: 'c', recall: '' }],
  ])('accepts %s', (_label, value) => {
    expect(SystemPromptAugmentOutputSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'rules'],
    ['an array', [{ rules: 'r' }]],
    ['a null body', { recall: null }],
    ['a number body', { context: 7 }],
    ['a null brief', { brief: null }],
    ['an unknown key', { recall: 'm', extra: 'x' }],
    ['the retired list shape', { contributions: [{ source: 'memory', body: 'b' }] }],
  ])('rejects %s', (_label, value) => {
    expect(SystemPromptAugmentOutputSchema.safeParse(value).success).toBe(false);
  });

  it('carries no length limit of its own (the orchestrator reports size separately)', () => {
    const big = 'x'.repeat(SYSTEM_PROMPT_AUGMENT_MAX_BODY_CHARS + 1);
    expect(SystemPromptAugmentOutputSchema.safeParse({ recall: big }).success).toBe(true);
  });
});
