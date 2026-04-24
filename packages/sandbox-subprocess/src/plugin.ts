import {
  SandboxSpawnInputSchema,
  type Plugin,
  type SandboxSpawnInput,
  type SandboxSpawnResult,
} from '@ax/core';
import { spawnImpl } from './spawn.js';
import { openSessionImpl, type OpenSessionResult } from './open-session.js';

const PLUGIN_NAME = '@ax/sandbox-subprocess';

export function createSandboxSubprocessPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      // `sandbox:spawn` remains registered through Task 5 — Task 6 is the one
      // that removes it once Task 7 drops the last caller.
      registers: ['sandbox:spawn', 'sandbox:open-session'],
      // `sandbox:open-session` calls out to the session and IPC-server
      // plugins. Declaring them here lets bootstrap's verifyCalls catch a
      // missing producer at boot instead of first-call time.
      calls: ['session:create', 'session:terminate', 'ipc:start', 'ipc:stop'],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<SandboxSpawnInput, SandboxSpawnResult>(
        'sandbox:spawn',
        PLUGIN_NAME,
        async (ctx, raw) => {
          const parsed = SandboxSpawnInputSchema.parse(raw);
          return spawnImpl(ctx, parsed);
        },
      );

      bus.registerService<unknown, OpenSessionResult>(
        'sandbox:open-session',
        PLUGIN_NAME,
        async (ctx, raw) => openSessionImpl(ctx, raw, bus),
      );
    },
  };
}
