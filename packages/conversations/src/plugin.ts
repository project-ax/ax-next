import type { Plugin } from '@ax/core';
import type { ConversationsConfig } from './types.js';

const PLUGIN_NAME = '@ax/conversations';

// ---------------------------------------------------------------------------
// @ax/conversations plugin (Task 1 scaffold)
//
// Empty shell. The manifest declares the five `conversations:*` service
// hooks plus the `chat:turn-end` subscription and `agents:resolve` call
// the plugin will need once wired. Hook impls land in Task 2 (CRUD +
// schema) and Task 3 (turn-end auto-append).
//
// Manifest decisions:
//   - `calls: ['agents:resolve']` is hard. Conversations are scoped to an
//     agent; the auto-append subscriber needs to look up the agent that
//     produced a turn so it can authorize the write. No `database:
//     get-instance` yet — the migration runs in Task 2.
//   - `subscribes: ['chat:turn-end']` is the auto-append trigger. We
//     don't FIRE any subscriber events of our own in MVP.
//   - No `http:register-route` — the REST surface lives in @ax/channel-web
//     and calls back into us via the bus, mirroring how @ax/agents'
//     /admin/agents routes call `agents:*` (I2: no cross-plugin imports).
//
// This plugin would NOT merge on its own (I3: no half-wired plugins). It
// merges with Task 2's hook implementations in the same PR.
// ---------------------------------------------------------------------------

export function createConversationsPlugin(_config: ConversationsConfig = {}): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'conversations:create',
        'conversations:append-turn',
        'conversations:get',
        'conversations:list',
        'conversations:delete',
      ],
      calls: ['agents:resolve'],
      subscribes: ['chat:turn-end'],
    },

    async init({ bus: _bus }) {
      // Hooks wired in Task 2 (CRUD + schema) / Task 3 (turn-end
      // auto-append subscriber). Intentionally empty here so the manifest
      // is inspectable without a live postgres.
    },
  };
}
