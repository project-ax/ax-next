import { basename } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRunnerBinaries } from '../main.js';

describe('resolveRunnerBinaries', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.AX_TEST_RUNNER_BINARY_OVERRIDE;
    delete process.env.AX_TEST_RUNNER_BINARY_OVERRIDE;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AX_TEST_RUNNER_BINARY_OVERRIDE;
    else process.env.AX_TEST_RUNNER_BINARY_OVERRIDE = savedEnv;
  });

  it('uses opts.runnerBinaryOverride for the claude-sdk key when set', () => {
    expect(
      resolveRunnerBinaries({ runnerBinaryOverride: '/tmp/fake-runner.js' }),
    ).toEqual({ 'claude-sdk': '/tmp/fake-runner.js' });
  });

  it('falls back to AX_TEST_RUNNER_BINARY_OVERRIDE env var when opts override is absent', () => {
    process.env.AX_TEST_RUNNER_BINARY_OVERRIDE = '/tmp/env-runner.js';
    expect(resolveRunnerBinaries({})).toEqual({ 'claude-sdk': '/tmp/env-runner.js' });
  });

  it('opts.runnerBinaryOverride takes precedence over env var', () => {
    process.env.AX_TEST_RUNNER_BINARY_OVERRIDE = '/tmp/env-runner.js';
    expect(
      resolveRunnerBinaries({ runnerBinaryOverride: '/tmp/opts-runner.js' }),
    ).toEqual({ 'claude-sdk': '/tmp/opts-runner.js' });
  });

  it('defaults the claude-sdk key to resolved @ax/agent-claude-sdk-runner when neither override is set', () => {
    const result = resolveRunnerBinaries({});
    expect(Object.keys(result)).toEqual(['claude-sdk']);
    expect(result['claude-sdk']).toContain('agent-claude-sdk-runner');
    expect(basename(result['claude-sdk'])).toBe('main.js');
  });
});
