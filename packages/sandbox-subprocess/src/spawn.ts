import { spawn } from 'node:child_process';
import { PluginError, type SandboxSpawnInput, type SandboxSpawnResult } from '@ax/core';

const ARGV0_RE = /^[A-Za-z0-9_./-]+$/;

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
  // Defense-in-depth: shell:false already prevents metachar interpretation,
  // but this fail-fast check catches mistakes earlier and makes intent
  // explicit. Truncate the reflected value in the error message so a caller
  // can't exfiltrate unbounded data into logs via argv[0].
  if (!ARGV0_RE.test(input.argv[0])) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: '@ax/sandbox-subprocess',
      hookName: 'sandbox:spawn',
      message: `invalid-argv: ${JSON.stringify(input.argv[0]).slice(0, 80)}`,
    });
  }

  // I2: caller env is filtered down to allowlist keys, then the parent's
  // allowlist values are merged LAST so the parent always wins on keys
  // both sides set (e.g. PATH). Caller keys NOT in the allowlist (e.g.
  // ANTHROPIC_API_KEY) are dropped entirely before reaching the child.
  const allowlist = allowlistFromParent();
  const filteredCallerEnv: Record<string, string> = {};
  for (const key of Object.keys(allowlist)) {
    const v = input.env[key];
    if (v !== undefined) filteredCallerEnv[key] = v;
  }
  const env = { ...filteredCallerEnv, ...allowlist };

  return new Promise<SandboxSpawnResult>((resolve, reject) => {
    const child = spawn(input.argv[0], input.argv.slice(1), {
      shell: false,
      cwd: input.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const truncated = { stdout: false, stderr: false };
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated.stdout) return;
      const remaining = input.maxStdoutBytes - stdout.length;
      if (chunk.length > remaining) {
        stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
        truncated.stdout = true;
      } else {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (truncated.stderr) return;
      const remaining = input.maxStderrBytes - stderr.length;
      if (chunk.length > remaining) {
        stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
        truncated.stderr = true;
      } else {
        stderr = Buffer.concat([stderr, chunk]);
      }
    });

    child.stdin.end();

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });

    child.on('exit', (exitCode, signal) => {
      clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        truncated,
        timedOut,
      });
    });
  });
}
