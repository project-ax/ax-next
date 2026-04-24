import type { LocalDispatcher } from '@ax/agent-runner-core';
import type { ToolCall } from '@ax/ipc-protocol';
import { executeBash, type BashResult } from './exec.js';

// ---------------------------------------------------------------------------
// Sandbox-side registration.
//
// Attaches `bash` to the runner's LocalDispatcher. The outer IPC envelope
// was already validated by the server, so we only need to narrow the
// tool-specific `input: unknown` to its two fields. zod is overkill for a
// 2-field shape (and would pull in a dependency this package otherwise
// doesn't need), so we inline the checks.
// ---------------------------------------------------------------------------

export interface RegisterOptions {
  /**
   * Absolute path to the sandbox workspace root. Every bash invocation
   * runs with this as its cwd. The runner binary is responsible for
   * making sure this is actually the session's workspace, not some
   * other directory.
   */
  workspaceRoot: string;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export function registerWithDispatcher(
  dispatcher: LocalDispatcher,
  options: RegisterOptions,
): void {
  dispatcher.register('bash', async (call: ToolCall) => {
    const raw = call.input;
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('bash: input must be an object');
    }
    const input = raw as { command?: unknown; timeoutMs?: unknown };
    const command = input.command;
    if (typeof command !== 'string') {
      throw new Error('bash: input.command must be a string');
    }
    const timeoutMs =
      typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined;
    const result: BashResult = await executeBash(
      {
        command,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      {
        cwd: options.workspaceRoot,
        ...(options.maxStdoutBytes !== undefined
          ? { maxStdoutBytes: options.maxStdoutBytes }
          : {}),
        ...(options.maxStderrBytes !== undefined
          ? { maxStderrBytes: options.maxStderrBytes }
          : {}),
      },
    );
    return result;
  });
}
