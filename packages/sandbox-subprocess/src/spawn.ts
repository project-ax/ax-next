import { spawn as nodeSpawn } from 'node:child_process';
import { PluginError, type ChatContext } from '@ax/core';
import {
  SandboxSpawnInputSchema,
  type SandboxSpawnInput,
  type SandboxSpawnResult,
} from './types.js';

export const PLUGIN_NAME = '@ax/sandbox-subprocess';
export const HOOK_NAME = 'sandbox:spawn';

// Parent env keys allowed through to children. Anything else (including
// ANTHROPIC_API_KEY and any credential-bearing variable) is dropped.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'] as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB

export async function spawnImpl(
  _ctx: ChatContext,
  input: SandboxSpawnInput,
): Promise<SandboxSpawnResult> {
  const parsed = SandboxSpawnInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: HOOK_NAME,
      message: `sandbox:spawn payload invalid: ${parsed.error.message}`,
      cause: parsed.error,
    });
  }

  const {
    argv,
    cwd,
    env: callerEnv,
    stdin,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxStdoutBytes = DEFAULT_MAX_BYTES,
    maxStderrBytes = DEFAULT_MAX_BYTES,
  } = parsed.data;

  // Build the child env from scratch. Start with {} — never { ...process.env }.
  const childEnv: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === 'string') childEnv[key] = v;
  }
  // Explicitly blank NODE_OPTIONS so a parent-set --require can't ride along.
  childEnv.NODE_OPTIONS = '';
  // Caller-provided env wins — declared by the tool plugin, not by the model.
  for (const [k, v] of Object.entries(callerEnv)) childEnv[k] = v;

  const [bin, ...args] = argv;

  return await new Promise<SandboxSpawnResult>((resolve, reject) => {
    let child;
    try {
      child = nodeSpawn(bin!, args, {
        cwd,
        env: childEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout!.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxStdoutBytes) {
        stdoutTruncated = true;
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) stdoutTruncated = true;
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxStderrBytes) {
        stderrTruncated = true;
        return;
      }
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) stderrTruncated = true;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks)
        .subarray(0, maxStdoutBytes)
        .toString('utf8');
      const stderr = Buffer.concat(stderrChunks)
        .subarray(0, maxStderrBytes)
        .toString('utf8');
      resolve({
        exitCode: code,
        signal: signal ?? null,
        stdout,
        stderr,
        truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
        timedOut,
      });
    });

    // Feed stdin (if any) then close the pipe so the child doesn't block.
    if (stdin !== undefined && stdin.length > 0) {
      child.stdin!.end(stdin);
    } else {
      child.stdin!.end();
    }
  });
}
