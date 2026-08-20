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

  it('applies opts.runnerBinaryOverride to EVERY runner id, not just claude-sdk', () => {
    // PR 3: the override has to cover both ids or the acceptance canary
    // (chat-pipeline.e2e.test.ts) can't run the stub runner under 'aisdk' —
    // selecting that id would spawn the REAL aisdk binary and try to reach a
    // provider. A regression that narrowed this back to the 'claude-sdk' key
    // would make the canary's second iteration fail confusingly (a real
    // runner, no credentials) rather than obviously.
    expect(
      resolveRunnerBinaries({ runnerBinaryOverride: '/tmp/fake-runner.js' }),
    ).toEqual({
      'claude-sdk': '/tmp/fake-runner.js',
      aisdk: '/tmp/fake-runner.js',
    });
  });

  it('falls back to AX_TEST_RUNNER_BINARY_OVERRIDE env var when opts override is absent', () => {
    process.env.AX_TEST_RUNNER_BINARY_OVERRIDE = '/tmp/env-runner.js';
    expect(resolveRunnerBinaries({})).toEqual({
      'claude-sdk': '/tmp/env-runner.js',
      aisdk: '/tmp/env-runner.js',
    });
  });

  it('opts.runnerBinaryOverride takes precedence over env var', () => {
    process.env.AX_TEST_RUNNER_BINARY_OVERRIDE = '/tmp/env-runner.js';
    expect(
      resolveRunnerBinaries({ runnerBinaryOverride: '/tmp/opts-runner.js' }),
    ).toEqual({
      'claude-sdk': '/tmp/opts-runner.js',
      aisdk: '/tmp/opts-runner.js',
    });
  });

  it('defaults each key to its own resolved runner package when neither override is set', () => {
    const result = resolveRunnerBinaries({});
    expect(Object.keys(result).sort()).toEqual(['aisdk', 'claude-sdk']);
    // Each id resolves its OWN package — asserting both paths are non-empty
    // would still pass if the two keys pointed at the same binary, which is
    // precisely the mis-keyed map the runner's boot self-check exists to catch.
    expect(result['claude-sdk']).toContain('agent-claude-sdk-runner');
    expect(result['aisdk']).toContain('agent-aisdk-runner');
    expect(result['claude-sdk']).not.toBe(result['aisdk']);
    expect(basename(result['claude-sdk'])).toBe('main.js');
    expect(basename(result['aisdk'])).toBe('main.js');
  });
});
