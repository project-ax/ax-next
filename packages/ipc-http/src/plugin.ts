import type { Plugin } from '@ax/core';
import { DISPATCHER_DEPENDENCIES } from '@ax/ipc-core';
import { createHttpListener, type HttpListener } from './listener.js';

const PLUGIN_NAME = '@ax/ipc-http';

// ---------------------------------------------------------------------------
// @ax/ipc-http plugin
//
// Process-wide TCP HTTP listener for runner→host IPC. Bound at init(); lives
// for the process lifetime. Replaces @ax/ipc-server in k8s-mode presets.
//
// Registers NO service hooks. The k8s sandbox provider does not call
// ipc:start/ipc:stop — listener lifecycle is process-scoped, not session-
// scoped. The kernel-shutdown lifecycle calls Plugin.shutdown() on SIGTERM
// to close the listener cleanly.
//
// `calls` / `optionalCalls` are spread from @ax/ipc-core's
// `DISPATCHER_DEPENDENCIES` — the single source of truth for the hooks the
// shared dispatcher transitively invokes (the same set @ax/ipc-server stamps,
// since both wrap the same dispatcher). We don't hand-maintain a per-transport
// list: that's exactly how the two manifests drifted from the dispatcher.
// Subscriber hooks the dispatcher fires (`tool:pre-call`, `tool:post-call`,
// `chat:turn-end`, `chat:end`, `chat:stream-chunk`, `workspace:applied`) are
// NOT declared — subscriber hooks don't need a registered service and
// `bus.fire` with no subscribers is a safe no-op. `tool:execute:<name>` is
// resolved dynamically at dispatch time (DISPATCHER_DEPENDENCIES.
// dynamicCallPatterns) and is deliberately not in `calls`.
// ---------------------------------------------------------------------------

export interface CreateIpcHttpPluginOptions {
  host: string;
  /** Pass 0 to let the OS assign a free port. */
  port: number;
}

export function createIpcHttpPlugin(
  opts: CreateIpcHttpPluginOptions,
): Plugin {
  let listener: HttpListener | null = null;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [...DISPATCHER_DEPENDENCIES.requiredCalls],
      optionalCalls: [...DISPATCHER_DEPENDENCIES.optionalCalls],
      subscribes: [],
    },
    async init({ bus }) {
      listener = await createHttpListener({
        host: opts.host,
        port: opts.port,
        bus,
      });
      // Boot-time observability: print the bound address so the chart's
      // manual-acceptance step can grep for this line. The kernel doesn't
      // have a ready logger at init() time (AgentContext is per-request).
      process.stderr.write(
        `[ax/ipc-http] listening on http://${listener.host}:${listener.port}\n`,
      );
    },
    async shutdown() {
      if (listener !== null) {
        const l = listener;
        listener = null;
        await l.close();
      }
    },
  };
}
