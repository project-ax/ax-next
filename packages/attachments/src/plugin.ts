import type { Plugin } from '@ax/core';
import type { AttachmentsConfig } from './types.js';

const PLUGIN_NAME = '@ax/attachments';

/**
 * @ax/attachments plugin (Phase 1 — host-side temp store + commit + download).
 *
 * Registers three service hooks:
 *   - attachments:store-temp   (caller: POST /api/attachments route, Phase 3)
 *   - attachments:commit       (caller: POST /api/chat/messages handler, Phase 3)
 *   - attachments:download     (callers: GET /api/files, Phase 3; future Slack plugin)
 *
 * Half-wired window OPEN through Phase 3 — no callers in Phase 1.
 *
 * Scaffolding only: handlers + migration + janitor wire in Tasks 3–9.
 */
export function createAttachmentsPlugin(
  _config: AttachmentsConfig = {},
): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'attachments:store-temp',
        'attachments:commit',
        'attachments:download',
      ],
      // database:get-instance is hard — the plugin owns a Postgres table
      // for the temp store and runs its own migration on init.
      // workspace:apply is hard — `attachments:commit` writes via it.
      // workspace:read is hard — `attachments:download` reads via it.
      // conversations:get is hard — `attachments:download`'s owner gate.
      calls: [
        'database:get-instance',
        'workspace:apply',
        'workspace:read',
        'conversations:get',
      ],
      subscribes: [],
    },

    async init(_ctx) {
      // Handlers + migration + janitor land in Tasks 3–9.
    },
  };
}
