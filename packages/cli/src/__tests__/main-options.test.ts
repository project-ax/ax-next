import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRunnerBinary } from '../main.js';

describe('resolveRunnerBinary', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.AX_TEST_RUNNER_BINARY_OVERRIDE;
    delete process.env.AX_TEST_RUNNER_BINARY_OVERRIDE;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AX_TEST_RUNNER_BINARY_OVERRIDE;
    else process.env.AX_TEST_RUNNER_BINARY_OVERRIDE = savedEnv;
  });

  it('uses opts.runnerBinaryOverride when set', () => {
    expect(resolveRunnerBinary({ runnerBinaryOverride: '/tmp/fake-runner.js' })).toBe(
      '/tmp/fake-runner.js',
    );
  });

  it('falls back to AX_TEST_RUNNER_BINARY_OVERRIDE env var when opts override is absent', () => {
    process.env.AX_TEST_RUNNER_BINARY_OVERRIDE = '/tmp/env-runner.js';
    expect(resolveRunnerBinary({})).toBe('/tmp/env-runner.js');
  });

  it('opts.runnerBinaryOverride takes precedence over env var', () => {
    process.env.AX_TEST_RUNNER_BINARY_OVERRIDE = '/tmp/env-runner.js';
    expect(resolveRunnerBinary({ runnerBinaryOverride: '/tmp/opts-runner.js' })).toBe(
      '/tmp/opts-runner.js',
    );
  });

  it('defaults to resolved @ax/agent-claude-sdk-runner when neither override is set', () => {
    const result = resolveRunnerBinary({});
    expect(result).toMatch(/agent-claude-sdk-runner.*main\.js$/);
  });
});
