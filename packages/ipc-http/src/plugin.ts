import type { Plugin } from '@ax/core';
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
// scoped. (A future kernel-shutdown lifecycle will close the listener
// cleanly on SIGTERM; until then, it dies with the process. The
// closeListener() handle below is the test/future-kernel seam.)
//
// `calls` declares the hooks the dispatcher transitively invokes — the same
// set @ax/ipc-server lists, since both plugins share @ax/ipc-core's
// dispatcher. Subscriber hooks the dispatcher fires (`llm:pre-call`,
// `llm:post-call`, `tool:pre-call`, `tool:post-call`, etc.) are NOT
// declared — subscriber hooks don't need a registered service and `bus.fire`
// with no subscribers is a safe no-op. `tool:execute:<name>` is dynamically
// resolved at dispatch time (same exception @ax/ipc-server documents).
// ---------------------------------------------------------------------------

export interface CreateIpcHttpPluginOptions {
  host: string;
  /** Pass 0 to let the OS assign a free port. */
  port: number;
}

export interface IpcHttpPlugin extends Plugin {
  /** Test-only handle for explicit teardown. Production lifecycle is
   *  process-scoped; the planned kernel-shutdown lifecycle will call this
   *  from the kernel side on SIGTERM. */
  closeListener(): Promise<void>;
}

export function createIpcHttpPlugin(
  opts: CreateIpcHttpPluginOptions,
): IpcHttpPlugin {
  let listener: HttpListener | null = null;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [
        'session:resolve-token',
        'session:claim-work',
        'llm:call',
        'tool:list',
      ],
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
      // have a ready logger at init() time (ChatContext is per-request).
      process.stderr.write(
        `[ax/ipc-http] listening on http://${listener.host}:${listener.port}\n`,
      );
    },
    async closeListener() {
      if (listener !== null) {
        const l = listener;
        listener = null;
        await l.close();
      }
    },
  };
}
