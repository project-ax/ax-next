import { PluginError, type Plugin } from '@ax/core';
import { createListener, type Listener } from './listener.js';

const PLUGIN_NAME = '@ax/ipc-server';

// ---------------------------------------------------------------------------
// @ax/ipc-server plugin
//
// Registers two service hooks:
//
//   - `ipc:start` — bind a unix-socket listener for a given sessionId.
//                   Caller (sandbox-subprocess, Task 5) supplies the socket
//                   path; we assume the parent directory is a per-session
//                   private tempdir (mode 0700, created via fs.mkdtemp).
//                   The socket file inherits those perms (I10).
//   - `ipc:stop`  — close the listener for a sessionId. Idempotent;
//                   no-op on unknown sessionId. Unlinks the socket file
//                   best-effort (ENOENT is fine — Node's http close()
//                   already unlinks, but we belt-and-suspender it).
//
// One listener per sessionId. Registering a second listener for an already-
// running session is a PluginError('already-running'); the caller must
// explicitly ipc:stop before re-starting.
// ---------------------------------------------------------------------------

interface IpcStartInput {
  socketPath: string;
  sessionId: string;
}

interface IpcStartOutput {
  running: true;
}

interface IpcStopInput {
  sessionId: string;
}

type IpcStopOutput = Record<string, never>;

function requireString(
  value: unknown,
  field: string,
  hookName: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'${field}' must be a non-empty string`,
    });
  }
}

export function createIpcServerPlugin(): Plugin {
  const listeners = new Map<string, Listener>();

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['ipc:start', 'ipc:stop'],
      // The dispatcher (Task 4) calls these synchronous service hooks.
      // Subscriber hooks fired by the dispatcher (`llm:pre-call`,
      // `llm:post-call`, `tool:pre-call`, `tool:post-call`, `chat:turn-end`,
      // `chat:end`) are NOT declared here — subscriber hooks don't require
      // a registered service and `bus.fire` with no subscribers is a safe
      // no-op.
      //
      // `tool:execute:<name>` service hooks are looked up *dynamically* via
      // `bus.hasService(...)` at dispatch time. They are deliberately NOT
      // listed in `calls` — we can't enumerate every tool name at manifest
      // time, and the verifyCalls startup check only enforces named hooks.
      // This is the same "dynamic service hook" exception that
      // @ax/tool-dispatcher uses for per-tool `tool:execute:<name>` routes.
      calls: [
        'session:resolve-token',
        'session:claim-work',
        'tool:list',
      ],
      subscribes: [],
    },
    init({ bus }) {
      // ----- ipc:start -----
      bus.registerService<IpcStartInput, IpcStartOutput>(
        'ipc:start',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'ipc:start';
          const socketPath = (input as { socketPath?: unknown })?.socketPath;
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          requireString(socketPath, 'socketPath', hookName);
          requireString(sessionId, 'sessionId', hookName);

          if (listeners.has(sessionId)) {
            throw new PluginError({
              code: 'already-running',
              plugin: PLUGIN_NAME,
              hookName,
              message: `listener already running for session '${sessionId}'`,
            });
          }

          let listener: Listener;
          try {
            listener = await createListener({ socketPath, sessionId, bus });
          } catch (cause) {
            throw new PluginError({
              code: 'bind-failed',
              plugin: PLUGIN_NAME,
              hookName,
              message: `failed to bind listener for session '${sessionId}': ${(cause as Error).message}`,
              cause,
            });
          }
          listeners.set(sessionId, listener);
          return { running: true };
        },
      );

      // ----- ipc:stop -----
      bus.registerService<IpcStopInput, IpcStopOutput>(
        'ipc:stop',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const hookName = 'ipc:stop';
          const sessionId = (input as { sessionId?: unknown })?.sessionId;
          requireString(sessionId, 'sessionId', hookName);

          const listener = listeners.get(sessionId);
          if (listener === undefined) {
            // Idempotent — unknown sessionId is a no-op, matching session:terminate.
            return {};
          }
          listeners.delete(sessionId);
          await listener.close();
          return {};
        },
      );
    },
  };
}
