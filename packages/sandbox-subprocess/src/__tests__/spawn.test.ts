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

  it('env allowlist wins: caller cannot override PATH, ANTHROPIC_API_KEY never reaches child (I2)', async () => {
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'secret-parent';
    try {
      const input = SandboxSpawnInputSchema.parse({
        argv: [
          'node',
          '-e',
          'console.log(JSON.stringify({key:process.env.ANTHROPIC_API_KEY ?? "GONE", path:process.env.PATH}))',
        ],
        cwd: '/tmp',
        env: { ANTHROPIC_API_KEY: 'caller-supplied', PATH: '/evil:only' },
      });
      const result = await spawnImpl(undefined, input);
      const parsed = JSON.parse(result.stdout) as { key: string; path: string };
      expect(parsed.key).toBe('GONE');
      expect(parsed.path).not.toBe('/evil:only');
      expect(parsed.path).toContain(process.env.PATH ?? '');
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prior;
    }
  });

  it('rejects argv[0] containing shell metacharacters', async () => {
    const input = SandboxSpawnInputSchema.parse({
      argv: ['/bin/bash; rm -rf /', 'noop'],
      cwd: '/tmp',
      env: {},
    });
    await expect(spawnImpl(undefined, input)).rejects.toThrow(/invalid-argv/);
  });

  it('does not perform shell expansion on argv (shell:false contract)', async () => {
    const input = SandboxSpawnInputSchema.parse({
      argv: ['/bin/echo', '$HOME'],
      cwd: '/tmp',
      env: {},
    });
    const result = await spawnImpl(undefined, input);
    expect(result.stdout.trim()).toBe('$HOME');
  });
});
