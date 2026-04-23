import type { Plugin } from '@ax/core';
import { HOOK_NAME, PLUGIN_NAME, spawnImpl } from './spawn.js';
import type { SandboxSpawnInput, SandboxSpawnResult } from './types.js';

export function sandboxSubprocessPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [HOOK_NAME],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<SandboxSpawnInput, SandboxSpawnResult>(
        HOOK_NAME,
        PLUGIN_NAME,
        spawnImpl,
      );
    },
  };
}
