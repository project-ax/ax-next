import { describe, it, expect } from 'vitest';
import { SandboxSpawnInputSchema, SandboxSpawnResultSchema } from '../sandbox.js';

describe('SandboxSpawn schemas', () => {
  it('accepts a minimal well-formed input', () => {
    const r = SandboxSpawnInputSchema.safeParse({
      argv: ['/bin/echo', 'hi'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.timeoutMs).toBe(30_000);
      expect(r.data.maxStdoutBytes).toBe(1_048_576);
    }
  });

  it('rejects empty argv', () => {
    expect(SandboxSpawnInputSchema.safeParse({ argv: [], cwd: '/tmp', env: {} }).success).toBe(false);
  });

  it('rejects lowercase env key', () => {
    expect(SandboxSpawnInputSchema.safeParse({
      argv: ['/bin/echo'], cwd: '/tmp', env: { path: '/usr/bin' },
    }).success).toBe(false);
  });

  it('rejects env key containing a semicolon', () => {
    expect(SandboxSpawnInputSchema.safeParse({
      argv: ['/bin/echo'], cwd: '/tmp', env: { 'A;B': 'x' },
    }).success).toBe(false);
  });

  it('rejects timeoutMs over 300_000', () => {
    expect(SandboxSpawnInputSchema.safeParse({
      argv: ['/bin/echo'], cwd: '/tmp', env: {}, timeoutMs: 300_001,
    }).success).toBe(false);
  });

  it('rejects non-absolute cwd', () => {
    expect(SandboxSpawnInputSchema.safeParse({
      argv: ['/bin/echo'], cwd: 'tmp', env: {},
    }).success).toBe(false);
  });

  it('accepts a well-formed result', () => {
    expect(SandboxSpawnResultSchema.safeParse({
      exitCode: 0, signal: null, stdout: 'hi', stderr: '',
      truncated: { stdout: false, stderr: false }, timedOut: false,
    }).success).toBe(true);
  });
});
