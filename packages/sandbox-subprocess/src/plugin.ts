import type { Plugin } from '@ax/core';
import { openSessionImpl, type OpenSessionResult } from './open-session.js';

const PLUGIN_NAME = '@ax/sandbox-subprocess';

export function createSandboxSubprocessPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      // `sandbox:spawn` was deleted in Task 6 — the host no longer spawns
      // one-shot processes directly; every tool execution runs inside the
      // runner-side sandbox via `sandbox:open-session`.
      registers: ['sandbox:open-session'],
      // open-session mints a session + token, starts the IPC listener, then
      // spawns the runner. Declaring these calls lets bootstrap's verifyCalls
      // catch a missing producer at boot instead of first-call time.
      calls: ['session:create', 'session:terminate', 'ipc:start', 'ipc:stop'],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<unknown, OpenSessionResult>(
        'sandbox:open-session',
        PLUGIN_NAME,
        async (ctx, raw) => openSessionImpl(ctx, raw, bus),
      );
    },
  };
}
