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

  it('enforces timeoutMs by killing the child with SIGKILL', async () => {
    const input = SandboxSpawnInputSchema.parse({
      argv: ['node', '-e', 'setInterval(()=>{},1000)'],
      cwd: '/tmp',
      env: {},
      timeoutMs: 200,
    });
    const result = await spawnImpl(undefined, input);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  it('caps stdout and marks truncated.stdout', async () => {
    const input = SandboxSpawnInputSchema.parse({
      argv: ['node', '-e', 'process.stdout.write("x".repeat(2_000_000))'],
      cwd: '/tmp',
      env: {},
      maxStdoutBytes: 1024,
    });
    const result = await spawnImpl(undefined, input);
    expect(result.stdout.length).toBe(1024);
    expect(result.truncated.stdout).toBe(true);
  });
});
