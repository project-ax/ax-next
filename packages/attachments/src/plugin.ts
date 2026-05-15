import { makeAgentContext, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import { runAttachmentsMigration, type AttachmentsDatabase } from './migrations.js';
import { createAttachmentsStore, type AttachmentsStore } from './store.js';
import {
  createStoreTempHandler,
  createCommitHandler,
  createDownloadHandler,
} from './handlers.js';
import { startJanitor, type JanitorHandle } from './janitor.js';
import {
  type AttachmentsConfig,
  DEFAULT_JANITOR_INTERVAL_SECONDS,
} from './types.js';

const PLUGIN_NAME = '@ax/attachments';

// ---------------------------------------------------------------------------
// @ax/attachments plugin (Phase 1 — host-side temp store + commit + download).
//
// Three service hooks:
//   - attachments:store-temp   (caller: POST /api/attachments route, Phase 3)
//   - attachments:commit       (caller: POST /api/chat/messages handler, Phase 3)
//   - attachments:download     (callers: GET /api/files, Phase 3; future Slack plugin)
//
// Half-wired window OPEN through Phase 3 — no callers in Phase 1. The hooks
// are reachable via the bus (and exercised by the contract test in Task 11),
// but no production code path invokes them yet.
//
// Manifest decisions:
//   - calls: database:get-instance (own table + migration), workspace:apply
//     (for attachments:commit), workspace:read (for attachments:download),
//     conversations:get (owner gate in attachments:download).
//   - subscribes: none. Phase 1 is service-hook-only.
// ---------------------------------------------------------------------------

export function createAttachmentsPlugin(
  config: AttachmentsConfig = {},
): Plugin {
  let janitor: JanitorHandle | undefined;
  let _store: AttachmentsStore | undefined;
  let _db: Kysely<AttachmentsDatabase> | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'attachments:store-temp',
        'attachments:commit',
        'attachments:download',
      ],
      calls: [
        'database:get-instance',
        'workspace:apply',
        'workspace:read',
        'conversations:get',
      ],
      subscribes: [],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });

      // 1) Fetch the shared Kysely handle from @ax/database-postgres.
      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      const db = shared as Kysely<AttachmentsDatabase>;
      _db = db;

      // 2) Run the migration. Idempotent: safe on every boot.
      await runAttachmentsMigration(db);

      // 3) Store + handlers.
      const store = createAttachmentsStore(db);
      _store = store;
      const storeTempHandler = createStoreTempHandler({ store, config });
      const commitHandler = createCommitHandler({ store, bus });
      const downloadHandler = createDownloadHandler({ bus });

      // 4) Register the hooks. `bus.registerService` is generic in I/O;
      //    each handler factory above returned a correctly-typed closure,
      //    so inference picks up the right shape per call.
      bus.registerService(
        'attachments:store-temp',
        PLUGIN_NAME,
        storeTempHandler,
      );
      bus.registerService('attachments:commit', PLUGIN_NAME, commitHandler);
      bus.registerService('attachments:download', PLUGIN_NAME, downloadHandler);

      // 5) Start the janitor. The interval defaults to 5 minutes; tests
      //    can override via `janitorIntervalSeconds`.
      janitor = startJanitor({
        store,
        intervalSeconds:
          config.janitorIntervalSeconds ?? DEFAULT_JANITOR_INTERVAL_SECONDS,
        ctx: initCtx,
      });
    },

    async shutdown() {
      // Stop the periodic sweep so the test harness / kernel can drain.
      // The bus's service-handler registrations don't need explicit unregister
      // — the bus is single-use per process and tests recreate it fresh.
      if (janitor !== undefined) {
        await janitor.stop();
        janitor = undefined;
      }
      // Drop references so a re-init doesn't pick up a stale store.
      _store = undefined;
      _db = undefined;
    },
  };
}

