import { describe, it, expect } from 'vitest';
import { SandboxSpawnInputSchema } from '@ax/core';
import { spawnImpl } from '../spawn.js';

describe('spawnImpl', () => {
  it('runs a happy-path child and captures stdout', async () => {
    const input = SandboxSpawnInputSchema.parse({
      argv: ['node', '-e', 'process.stdout.write("hi")'],
      cwd: '/tmp',
      env: {},
    });
    const result = await spawnImpl(undefined, input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toEqual({ stdout: false, stderr: false });
  });

  it('surfaces a nonzero exit code', async () => {
    const input = SandboxSpawnInputSchema.parse({
      argv: ['node', '-e', 'process.exit(3)'],
      cwd: '/tmp',
      env: {},
    });
    const result = await spawnImpl(undefined, input);
    expect(result.exitCode).toBe(3);
  });
});
