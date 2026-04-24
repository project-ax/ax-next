import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PluginError, type SandboxSpawnParsed, type SandboxSpawnResult } from '@ax/core';
import { allowlistFromParent } from './env.js';

const ARGV0_RE = /^[A-Za-z0-9_./-]+$/;

export async function spawnImpl(
  _ctx: unknown,
  input: SandboxSpawnParsed,
): Promise<SandboxSpawnResult> {
  // Defense-in-depth: shell:false already prevents metachar interpretation,
  // but this fail-fast check catches mistakes earlier and makes intent
  // explicit. Truncate the reflected value in the error message so a caller
  // can't exfiltrate unbounded data into logs via argv[0].
  //
  // Zod already guarantees argv.length >= 1 (see SandboxSpawnInputSchema),
  // but with noUncheckedIndexedAccess TS still narrows the tuple access to
  // `string | undefined`, so we assert the invariant here.
  const argv0 = input.argv[0];
  if (argv0 === undefined || !ARGV0_RE.test(argv0)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: '@ax/sandbox-subprocess',
      hookName: 'sandbox:spawn',
      message: `invalid-argv: ${JSON.stringify(argv0 ?? '').slice(0, 80)}`,
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
    // Annotate the return type explicitly: with @types/node's overloaded
    // spawn() signature, TS sometimes can't narrow from the stdio option
    // alone. ['pipe','pipe','pipe'] gives us a ChildProcessWithoutNullStreams,
    // which has non-nullable stdin/stdout/stderr.
    const child: ChildProcessWithoutNullStreams = spawn(
      argv0,
      input.argv.slice(1),
      {
        shell: false,
        cwd: input.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

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

    // I7: attach the error handler BEFORE writing so EPIPE / ECONNRESET
    // from a child that closes stdin early is swallowed here instead of
    // crashing the host with an unhandled 'error' event.
    child.stdin.on('error', () => {
      /* swallowed; expected on early-close races */
    });
    if (input.stdin !== undefined) {
      child.stdin.end(input.stdin);
    } else {
      child.stdin.end();
    }

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(
        new PluginError({
          code: 'invalid-payload',
          plugin: '@ax/sandbox-subprocess',
          hookName: 'sandbox:spawn',
          message: `spawn failed: ${err.message}`,
          cause: err,
        }),
      );
    });

    // Resolve on 'close', not 'exit': Node's 'exit' event fires when the child
    // process terminates, but stdio pipes may still have buffered data that
    // hasn't been emitted as 'data' events yet. 'close' fires AFTER all stdio
    // streams are closed and drained, guaranteeing we've captured every byte
    // the child wrote. Small outputs often survive the race by luck; larger
    // outputs can truncate non-deterministically on busy systems.
    child.on('close', (exitCode, signal) => {
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
