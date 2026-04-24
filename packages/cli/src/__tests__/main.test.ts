import { describe, it, expect } from 'vitest';
import { resolveRunnerBinary } from '../main.js';

describe('resolveRunnerBinary', () => {
  it('resolves the native runner for runner="native"', () => {
    expect(resolveRunnerBinary('native')).toMatch(/agent-native-runner/);
  });

  it('resolves the claude-sdk runner for runner="claude-sdk"', () => {
    expect(resolveRunnerBinary('claude-sdk')).toMatch(/agent-claude-sdk-runner/);
  });
});
