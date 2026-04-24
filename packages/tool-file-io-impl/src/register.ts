import type { LocalDispatcher } from '@ax/agent-runner-core';
import type { ToolCall } from '@ax/ipc-protocol';
import { readFile, writeFile } from './exec.js';

export interface RegisterOptions {
  workspaceRoot: string;
}

/**
 * Register read_file and write_file executors with the sandbox-side
 * LocalDispatcher. Called once at runner startup (Task 11 binary).
 *
 * The two closures capture `options.workspaceRoot` so that every
 * tool call is constrained to the workspace the runner was launched
 * against. safePath enforces the boundary on every call.
 */
export function registerWithDispatcher(
  dispatcher: LocalDispatcher,
  options: RegisterOptions,
): void {
  dispatcher.register('read_file', async (call: ToolCall) => {
    const input = call.input;
    if (typeof input !== 'object' || input === null) {
      throw new Error('read_file: input must be an object');
    }
    const record = input as { path?: unknown };
    return readFile(
      { path: String(record.path ?? '') },
      { workspaceRoot: options.workspaceRoot },
    );
  });
  dispatcher.register('write_file', async (call: ToolCall) => {
    const input = call.input;
    if (typeof input !== 'object' || input === null) {
      throw new Error('write_file: input must be an object');
    }
    const record = input as { path?: unknown; content?: unknown };
    return writeFile(
      {
        path: String(record.path ?? ''),
        content: String(record.content ?? ''),
      },
      { workspaceRoot: options.workspaceRoot },
    );
  });
}
