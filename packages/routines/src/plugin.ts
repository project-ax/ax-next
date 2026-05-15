import type { Plugin } from '@ax/core';
import type { RoutinesConfig } from './types.js';

const PLUGIN_NAME = '@ax/routines';

export function createRoutinesPlugin(_config: RoutinesConfig = {}): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['routines:fire-now', 'routines:list'],
      calls: [
        'database:get-instance',
        'agents:resolve',
        'conversations:find-or-create',
        'conversations:create',
        'conversations:drop-turn',
        'conversations:hide',
        'agent:invoke',
      ],
      subscribes: ['workspace:applied', 'chat:turn-end'],
    },
    init() {
    },
  };
}
