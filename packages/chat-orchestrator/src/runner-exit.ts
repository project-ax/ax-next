/**
 * Map a runner's exit (before chat:end) to a turn-error reason (TASK-784).
 *
 * Both sandbox backends resolve `handle.exited` with `{ code, signal }`; the k8s
 * backend adds a backend `reason` (the pod/container termination reason, e.g.
 * `OOMKilled`). The orchestrator only reads the shape — it never imports a
 * sandbox plugin (I2) — and treats every field as possibly absent, because a
 * pathological provider (or a test stub) may resolve with nothing at all.
 */
import { clampCodeUnits } from '@ax/core';

export interface RunnerExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Backend termination reason, when the backend has one (k8s). */
  reason?: string;
}

/**
 * The runner shell's fatal exit code: `main()` threw (a bad env, a refused IPC
 * connect, …) and the shell printed `runner: fatal: …` and exited 2. Both
 * runners (`agent-claude-sdk-runner`, `agent-aisdk-runner`) use it.
 */
export const RUNNER_FATAL_EXIT_CODE = 2;

/** Turn-error reason: the runner exited with its fatal code before chat:end. */
export const RUNNER_BOOT_FAILED = 'runner-boot-failed';

/** Turn-error reason: the runner exited for any other cause before chat:end. */
export const SANDBOX_EXIT_BEFORE_CHAT_END = 'sandbox-exit-before-chat-end';

/** Cap for the backend reason string on the host log line. */
const EXIT_REASON_LOG_MAX = 128;

export function classifyRunnerExit(info: unknown): string {
  const code = (info as { code?: unknown } | null | undefined)?.code;
  return code === RUNNER_FATAL_EXIT_CODE ? RUNNER_BOOT_FAILED : SANDBOX_EXIT_BEFORE_CHAT_END;
}

/** Host-log fields for an exit: code, signal, backend reason — all bounded. */
export function runnerExitLogFields(info: unknown): Record<string, unknown> {
  const i = (typeof info === 'object' && info !== null ? info : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {
    exitCode: typeof i.code === 'number' ? i.code : null,
    exitSignal: typeof i.signal === 'string' ? clampCodeUnits(i.signal, 32) : null,
  };
  if (typeof i.reason === 'string') out.exitReason = clampCodeUnits(i.reason, EXIT_REASON_LOG_MAX);
  return out;
}
