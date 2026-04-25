import type { LocalDispatcher } from '@ax/agent-runner-core';
import type { ToolCall } from '@ax/ipc-protocol';
import { readFile, writeFile } from './exec.js';

/**
 * Observed file change emitted to the runner-level per-turn diff
 * accumulator. Mirrors `@ax/core.FileChange` but redeclared here to keep
 * `@ax/tool-file-io-impl` from depending on the kernel package directly
 * (sandbox-side packages must not pull in `@ax/core`).
 */
export type ObservedFileChange =
  | { path: string; kind: 'put'; content: Uint8Array }
  | { path: string; kind: 'delete' };

export interface RegisterOptions {
  workspaceRoot: string;
  /**
   * Optional observer fired after a successful workspace-mutating tool
   * call. The runner subscribes to feed its per-turn diff accumulator
   * (Task 7c). The path is the caller-supplied (workspace-relative) path,
   * matching what landed on disk via safePath. Failures inside the
   * observer must not break the tool call — exceptions are swallowed.
   */
  onFileChange?: (change: ObservedFileChange) => void;
}

/**
 * Register read_file and write_file executors with the sandbox-side
 * LocalDispatcher. Called once at runner startup (Task 11 binary).
 *
 * The two closures capture `options.workspaceRoot` so that every
 * tool call is constrained to the workspace the runner was launched
 * against. safePath enforces the boundary on every call.
 *
 * Non-string `path` / `content` are rejected explicitly rather than
 * coerced via `String(...)`. Coercion would turn `{ foo: 1 }` into
 * `"[object Object]"` and push the resulting garbage string all the
 * way into `fs.writeFile` — a silent data-corruption path. The model
 * should see a clear input-shape error it can recover from.
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
    const { path } = input as { path?: unknown };
    if (typeof path !== 'string') {
      throw new Error('read_file: input.path must be a string');
    }
    return readFile({ path }, { workspaceRoot: options.workspaceRoot });
  });
  dispatcher.register('write_file', async (call: ToolCall) => {
    const input = call.input;
    if (typeof input !== 'object' || input === null) {
      throw new Error('write_file: input must be an object');
    }
    const { path, content } = input as { path?: unknown; content?: unknown };
    if (typeof path !== 'string') {
      throw new Error('write_file: input.path must be a string');
    }
    if (typeof content !== 'string') {
      throw new Error('write_file: input.content must be a string');
    }
    const result = await writeFile(
      { path, content },
      { workspaceRoot: options.workspaceRoot },
    );
    if (options.onFileChange !== undefined) {
      try {
        options.onFileChange({
          path,
          kind: 'put',
          content: Buffer.from(content, 'utf8'),
        });
      } catch {
        // Observer failure must not poison the tool result. The accumulator
        // is best-effort telemetry, not a transaction the model depends on.
      }
    }
    return result;
  });
}
