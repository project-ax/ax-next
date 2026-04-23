import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeChatContext, type ChatContext } from '@ax/core';
import { spawnImpl } from '../spawn.js';
import type { SandboxSpawnInput } from '../types.js';

function ctx(): ChatContext {
  return makeChatContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId: 'test-user',
    workspaceRoot: process.cwd(),
  });
}

describe('@ax/sandbox-subprocess spawnImpl', () => {
  it('echoes stdout from a node -e invocation', async () => {
    const r = await spawnImpl(ctx(), {
      argv: ['node', '-e', 'process.stdout.write("hi")'],
      cwd: process.cwd(),
      env: {},
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hi');
    expect(r.truncated.stdout).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it('propagates non-zero exit codes', async () => {
    const r = await spawnImpl(ctx(), {
      argv: ['node', '-e', 'process.exit(3)'],
      cwd: process.cwd(),
      env: {},
    });
    expect(r.exitCode).toBe(3);
  });

  it('SIGKILLs on timeout and reports timedOut', async () => {
    const r = await spawnImpl(ctx(), {
      argv: ['node', '-e', 'setInterval(()=>{},1000)'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 100,
    });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    expect(r.exitCode).toBe(null);
  });

  it('truncates stdout at maxStdoutBytes and lets child finish', async () => {
    const r = await spawnImpl(ctx(), {
      argv: ['node', '-e', 'process.stdout.write("x".repeat(2*1024*1024))'],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 1024,
    });
    expect(r.stdout.length).toBe(1024);
    expect(r.truncated.stdout).toBe(true);
  });

  it('scrubs ANTHROPIC_API_KEY (and other parent secrets) from child env', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'SHOULDNOTLEAK';
    try {
      const r = await spawnImpl(ctx(), {
        argv: [
          'node',
          '-e',
          'process.stdout.write(process.env.ANTHROPIC_API_KEY ?? "GONE")',
        ],
        cwd: process.cwd(),
        env: {},
      });
      expect(r.stdout).toBe('GONE');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('does not shell-expand argv (passes $HOME literally)', async () => {
    const r = await spawnImpl(ctx(), {
      argv: ['node', '-e', 'process.stdout.write(process.argv[1])', '$HOME'],
      cwd: process.cwd(),
      env: {},
    });
    expect(r.stdout).toBe('$HOME');
  });

  it('honors cwd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-sandbox-cwd-'));
    try {
      const r = await spawnImpl(ctx(), {
        argv: ['node', '-e', 'process.stdout.write(process.cwd())'],
        cwd: dir,
        env: {},
      });
      expect(r.stdout).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pipes stdin to the child', async () => {
    const r = await spawnImpl(ctx(), {
      argv: [
        'node',
        '-e',
        'process.stdin.on("data",d=>process.stdout.write(d))',
      ],
      cwd: process.cwd(),
      env: {},
      stdin: 'piped',
    });
    expect(r.stdout).toContain('piped');
  });

  it('throws PluginError invalid-payload on empty argv', async () => {
    await expect(
      spawnImpl(ctx(), {
        argv: [] as unknown as [string, ...string[]],
        cwd: process.cwd(),
        env: {},
      } as SandboxSpawnInput),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'invalid-payload' });
  });
});
