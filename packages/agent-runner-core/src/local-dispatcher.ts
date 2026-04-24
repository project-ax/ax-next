import type { ToolCall } from '@ax/ipc-protocol';

// ---------------------------------------------------------------------------
// Sandbox-side tool registry.
//
// Not to be confused with the HOST-side `@ax/tool-dispatcher` plugin (which
// lives in the kernel-facing codebase and routes through the hook bus).
// This is the thing the native runner uses to decide whether a tool call
// can be served locally ("dispatch inside the sandbox") or must hit the
// host over IPC (via `client.call('tool.execute-host', ...)`).
//
// Surface is intentionally tiny:
//
//   register(name, executor)   — add a local impl. Duplicate name throws,
//                                because the runner registers tools once
//                                at startup; a duplicate is a bug.
//
//   has(name)                  — runner checks before dispatching.
//
//   execute(call)              — runs the registered executor; throws
//                                with the tool name in the message if the
//                                tool isn't registered OR the executor
//                                throws (original error preserved as
//                                `cause`).
// ---------------------------------------------------------------------------

export type LocalToolExecutor = (call: ToolCall) => Promise<unknown>;

export interface LocalDispatcher {
  register(name: string, executor: LocalToolExecutor): void;
  has(name: string): boolean;
  execute(call: ToolCall): Promise<unknown>;
}

export function createLocalDispatcher(): LocalDispatcher {
  const tools = new Map<string, LocalToolExecutor>();

  const register = (name: string, executor: LocalToolExecutor): void => {
    if (tools.has(name)) {
      throw new Error(
        `local dispatcher: duplicate tool registration for '${name}'`,
      );
    }
    tools.set(name, executor);
  };

  const has = (name: string): boolean => tools.has(name);

  const execute = async (call: ToolCall): Promise<unknown> => {
    const executor = tools.get(call.name);
    if (executor === undefined) {
      throw new Error(
        `local dispatcher: no local impl registered for tool '${call.name}'`,
      );
    }
    try {
      return await executor(call);
    } catch (err) {
      // Wrap with the tool name for easier debugging. Original error
      // preserved as `cause` so callers can drill down. Using Error's
      // options-bag signature (cause) keeps stack traces intact.
      const wrapped = new Error(
        `local dispatcher: tool '${call.name}' failed: ${(err as Error).message ?? String(err)}`,
        { cause: err },
      );
      throw wrapped;
    }
  };

  return { register, has, execute };
}
