import type { Plugin } from '@ax/core';

const PLUGIN_NAME = '@ax/sandbox-subprocess';

export function sandboxSubprocessPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: [],
      subscribes: [],
    },
    init() {
      // sandbox:spawn service is registered in Task 2.2/2.3.
    },
  };
}
