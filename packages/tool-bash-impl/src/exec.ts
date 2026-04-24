import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// ---------------------------------------------------------------------------
// Sandbox-side bash executor.
//
// Ports the hardened spawn shape from Week 4-6's (now-deleted)
// `@ax/sandbox-subprocess` spawnImpl — same env allowlist, shell:false,
// argv0 allowlist, timeout, output caps, EPIPE swallow, resolve-on-'close'.
//
// Differences from the old spawn:sandbox hook:
//   - No zod validation of the outer shape. The IPC server validated the
//     envelope; `registerWithDispatcher` does a two-field narrow on the
//     `ToolCall.input: unknown` before calling us. We still validate our
//     own inputs below (length, timeout bounds) as defense-in-depth.
//   - argv is fixed: ['/bin/bash', '-c', command]. The old hook accepted
//     arbitrary argv; this one is bash-only by name, so we lock it.
//   - No `stdin` input — bash inherits an already-closed stdin.
// ---------------------------------------------------------------------------

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: { stdout: boolean; stderr: boolean };
}

export interface BashInput {
  command: string;
  timeoutMs?: number;
}

export interface BashConfig {
  cwd: string;
  maxStdoutBytes?: number; // default 1 MiB
  maxStderrBytes?: number; // default 1 MiB
}

const MAX_COMMAND_BYTES = 16_384;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT = 1_048_576;

// Defense-in-depth: shell:false already prevents metachar interpretation,
// but this check catches mistakes earlier and makes intent explicit. argv0
// is always `/bin/bash` below; the regex exists so a future port that makes
// argv0 configurable inherits the guard automatically.
const ARGV0_RE = /^[A-Za-z0-9_./-]+$/;

function allowlistFromParent(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/',
    LANG: process.env.LANG ?? 'C',
    LC_ALL: process.env.LC_ALL ?? 'C',
    TZ: process.env.TZ ?? 'UTC',
    // NODE_OPTIONS='' blocks caller from injecting --require / --import
    // into any Node child bash might exec. Explicit empty string beats
    // "unset" because the parent's own NODE_OPTIONS is also scrubbed.
    NODE_OPTIONS: '',
  };
}

export async function executeBash(
  input: BashInput,
  config: BashConfig,
): Promise<BashResult> {
  if (typeof input.command !== 'string' || input.command.length === 0) {
    throw new Error(`bash: command must be a non-empty string`);
  }
  if (Buffer.byteLength(input.command, 'utf8') > MAX_COMMAND_BYTES) {
    throw new Error(`bash: command exceeds ${MAX_COMMAND_BYTES} bytes`);
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `bash: timeoutMs must be a positive integer <= ${MAX_TIMEOUT_MS}`,
    );
  }
  const maxStdoutBytes = config.maxStdoutBytes ?? DEFAULT_MAX_OUTPUT;
  const maxStderrBytes = config.maxStderrBytes ?? DEFAULT_MAX_OUTPUT;

  const argv0 = '/bin/bash';
  if (!ARGV0_RE.test(argv0)) {
    // Unreachable with the current hardcoded argv0; kept so the regex
    // guard is actually exercised and a future edit can't silently skip it.
    throw new Error(`bash: invalid argv0`);
  }

  const env = allowlistFromParent();

  return new Promise<BashResult>((resolve, reject) => {
    // Explicit ChildProcessWithoutNullStreams annotation: with
    // @types/node's overloaded spawn() signature, TS sometimes can't
    // narrow from the stdio option alone. ['pipe','pipe','pipe']
    // guarantees non-nullable stdin/stdout/stderr.
    const child: ChildProcessWithoutNullStreams = spawn(
      argv0,
      ['-c', input.command],
      {
        shell: false,
        cwd: config.cwd,
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
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated.stdout) return;
      const remaining = maxStdoutBytes - stdout.length;
      if (chunk.length > remaining) {
        stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
        truncated.stdout = true;
      } else {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (truncated.stderr) return;
      const remaining = maxStderrBytes - stderr.length;
      if (chunk.length > remaining) {
        stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
        truncated.stderr = true;
      } else {
        stderr = Buffer.concat([stderr, chunk]);
      }
    });

    // Swallow EPIPE on stdin; we close stdin immediately and bash may
    // not even touch it. Handler must be attached before the end() call
    // so a synchronous EPIPE doesn't bubble up as unhandled.
    child.stdin.on('error', () => {
      /* swallowed; expected on early-close races */
    });
    child.stdin.end();

    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });

    // Resolve on 'close', not 'exit': 'exit' fires when the child
    // terminates, but stdio pipes may still have buffered data. 'close'
    // fires AFTER all stdio streams are drained, guaranteeing we've
    // captured every byte. Small outputs survive the race by luck;
    // larger outputs truncate non-deterministically on busy systems.
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
