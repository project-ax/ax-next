import { describe, expect, it } from 'vitest';
import { runnerForModel, validateCreateInput, validateUpdatePatch } from '../store.js';
import type { AgentInput } from '../types.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const KIMI = 'openrouter/moonshotai/kimi-k3';
const vctx = { allowedModels: [SONNET, KIMI] };

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    displayName: 'Agent',
    allowedTools: [],
    mcpConfigIds: [],
    model: SONNET,
    visibility: 'personal',
    ...overrides,
  };
}

describe('runnerForModel', () => {
  it('runs Anthropic models on claude-sdk and everything else on aisdk', () => {
    expect(runnerForModel(SONNET)).toBe('claude-sdk');
    expect(runnerForModel(KIMI)).toBe('aisdk');
    expect(runnerForModel('openrouter/anthropic/claude-sonnet-4-6')).toBe('aisdk');
  });
});

describe('validateCreateInput — runner', () => {
  it('derives claude-sdk for an Anthropic model and aisdk for an OpenRouter model when runner is omitted', () => {
    expect(validateCreateInput(makeInput(), vctx).runner).toBe('claude-sdk');
    expect(validateCreateInput(makeInput({ model: KIMI }), vctx).runner).toBe('aisdk');
  });

  it('rejects claude-sdk with a non-Anthropic model, in plain words', () => {
    expect(() => validateCreateInput(makeInput({ model: KIMI, runner: 'claude-sdk' }), vctx)).toThrow(
      /claude-sdk.*only run Anthropic models.*aisdk/,
    );
  });

  it('allows aisdk with an Anthropic model', () => {
    expect(validateCreateInput(makeInput({ runner: 'aisdk' }), vctx).runner).toBe('aisdk');
  });

  it('still rejects an unknown runner id', () => {
    expect(() => validateCreateInput(makeInput({ runner: 'nope' as never }), vctx)).toThrow(/not in the allow-list/);
  });
});

describe('validateUpdatePatch — runner', () => {
  it('re-derives the runner when the model changes and no runner is supplied', () => {
    expect(validateUpdatePatch({ model: KIMI }, { ...vctx, currentModel: SONNET })).toMatchObject({
      model: KIMI,
      runner: 'aisdk',
    });
    expect(validateUpdatePatch({ model: SONNET }, { ...vctx, currentModel: KIMI })).toMatchObject({
      model: SONNET,
      runner: 'claude-sdk',
    });
  });

  it('does not touch the runner when neither model nor runner is in the patch', () => {
    expect(validateUpdatePatch({ displayName: 'New' }, { ...vctx, currentModel: KIMI })).toEqual({
      displayName: 'New',
    });
  });

  it('rejects a model+runner patch that cannot work together', () => {
    expect(() => validateUpdatePatch({ model: KIMI, runner: 'claude-sdk' }, vctx)).toThrow(/only run Anthropic models/);
  });

  it('validates a runner-only patch against the current model', () => {
    expect(() => validateUpdatePatch({ runner: 'claude-sdk' }, { ...vctx, currentModel: KIMI })).toThrow(
      /only run Anthropic models/,
    );
    expect(validateUpdatePatch({ runner: 'aisdk' }, { ...vctx, currentModel: SONNET })).toEqual({ runner: 'aisdk' });
  });

  it('accepts a runner-only patch when the current model is unknown (nothing to contradict)', () => {
    expect(validateUpdatePatch({ runner: 'claude-sdk' }, vctx)).toEqual({ runner: 'claude-sdk' });
  });
});
