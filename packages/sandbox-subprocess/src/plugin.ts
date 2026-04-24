import {
  SandboxSpawnInputSchema,
  type Plugin,
  type SandboxSpawnInput,
  type SandboxSpawnResult,
} from '@ax/core';
import { spawnImpl } from './spawn.js';

const PLUGIN_NAME = '@ax/sandbox-subprocess';

export function createSandboxSubprocessPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['sandbox:spawn'],
      calls: [],
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
    },
  };
}
