import { spawn } from 'node:child_process';
import type { SandboxSpawnInput, SandboxSpawnResult } from '@ax/core';

function allowlistFromParent(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/',
    LANG: process.env.LANG ?? 'C',
    LC_ALL: process.env.LC_ALL ?? 'C',
    TZ: process.env.TZ ?? 'UTC',
    NODE_OPTIONS: '',
  };
}

export async function spawnImpl(
  _ctx: unknown,
  input: SandboxSpawnInput,
): Promise<SandboxSpawnResult> {
  const env = { ...input.env, ...allowlistFromParent() };

  return new Promise<SandboxSpawnResult>((resolve, reject) => {
    const child = spawn(input.argv[0], input.argv.slice(1), {
      shell: false,
      cwd: input.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
    });

    child.stdin.end();

    child.on('error', (err) => {
      reject(err);
    });

    child.on('exit', (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        truncated: { stdout: false, stderr: false },
        timedOut: false,
      });
    });
  });
}
