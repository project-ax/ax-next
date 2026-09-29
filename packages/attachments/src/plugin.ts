import { makeAgentContext, type Plugin } from '@ax/core';
import type { Kysely } from 'kysely';
import { runAttachmentsMigration, type AttachmentsDatabase } from './migrations.js';
import { createAttachmentsStore, type AttachmentsStore } from './store.js';
import {
  createStoreTempHandler,
  createCommitHandler,
  createDownloadHandler,
  createListForConversationHandler,
  createPublishArtifactBlobHandler,
} from './handlers.js';
import { startJanitor, type JanitorHandle } from './janitor.js';
import {
  type AttachmentsConfig,
  ArtifactsPublishBlobOutputSchema,
  AttachmentsListForConversationOutputSchema,
  CommitOutputSchema,
  DEFAULT_JANITOR_INTERVAL_SECONDS,
  DownloadOutputSchema,
  StoreTempOutputSchema,
} from './types.js';

const PLUGIN_NAME = '@ax/attachments';

// `conversations:purged` (fired by @ax/conversations after it commits a hard
// delete) carries at most 500 ids per fire. Allow twice that before treating the
// payload as malformed, so a future bump on the producer side does not silently
// turn every purge into a warning.
const MAX_PURGED_IDS = 1000;

/**
 * Validate a `conversations:purged` payload. It arrives over the hook bus from
 * another plugin, so its shape is untrusted: anything other than
 * `{ conversationIds: string[] }` (non-empty strings, at most MAX_PURGED_IDS)
 * is rejected WHOLE. We never delete "the valid part" of a payload we do not
 * recognise. Returns undefined when malformed.
 */
function parsePurgedIds(payload: unknown): string[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const ids = (payload as { conversationIds?: unknown }).conversationIds;
  if (!Array.isArray(ids) || ids.length > MAX_PURGED_IDS) return undefined;
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) return undefined;
  }
  return ids as string[];
}

// ---------------------------------------------------------------------------
// @ax/attachments plugin (Phase 1 — host-side temp store + commit + download).
//
// Three service hooks:
//   - attachments:store-temp   (caller: POST /api/attachments route, Phase 3)
//   - attachments:commit       (caller: POST /api/chat/messages handler, Phase 3)
//   - attachments:download     (callers: GET /api/files, Phase 3; future Slack plugin)
//
// Half-wired window CLOSED by Phase 3 (PR #97). `channel-web` drives all
// three: `routes-attachments.ts` calls store-temp and download,
// `routes-chat.ts` calls attachments:commit.
//
// Manifest decisions (the authoritative list is the `calls:` array below —
// this prose is a summary and has already drifted once):
//   - calls: database:get-instance (own table + migration), blob:put (for
//     attachments:commit), blob:get (for attachments:download),
//     conversations:get (owner gate in attachments:download).
//   - This used to name `workspace:apply` and `workspace:read` instead of the
//     blob hooks. TASK-68 moved attachment bytes out of git and into the
//     content-addressed blob store; the `calls:` array was updated, this
//     paragraph was not.
//   - subscribes: `conversations:purged` (TASK-718). A hard-deleted
//     conversation (agent delete) takes its files/artifacts metadata rows with
//     it. The blob bytes are left in place (content-addressed + shared).
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
        // TASK-68 (out-of-git Part C): the host-side metadata hooks the IPC
        // artifact.publish / attachments.list actions drive.
        'attachments:list-for-conversation',
        'artifacts:publish-blob',
      ],
      calls: [
        'database:get-instance',
        // TASK-68: bytes move from git (workspace:apply/read) to the
        // content-addressed blob store. attachments:commit stores via blob:put;
        // attachments:download fetches via blob:get. The git path is dropped.
        'blob:put',
        'blob:get',
        'conversations:get',
      ],
      subscribes: ['conversations:purged'],
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
      const downloadHandler = createDownloadHandler({ bus, store });
      const listForConversationHandler = createListForConversationHandler({ store });
      const publishArtifactBlobHandler = createPublishArtifactBlobHandler({ store });

      // 4) Register the hooks. `bus.registerService` is generic in I/O;
      //    each handler factory above returned a correctly-typed closure,
      //    so inference picks up the right shape per call.
      bus.registerService(
        'attachments:store-temp',
        PLUGIN_NAME,
        storeTempHandler,
        { returns: StoreTempOutputSchema },
      );
      bus.registerService('attachments:commit', PLUGIN_NAME, commitHandler, {
        returns: CommitOutputSchema,
      });
      bus.registerService('attachments:download', PLUGIN_NAME, downloadHandler, {
        returns: DownloadOutputSchema,
      });
      // TASK-68: host-side metadata hooks driven by the IPC dispatcher.
      bus.registerService(
        'attachments:list-for-conversation',
        PLUGIN_NAME,
        listForConversationHandler,
        { returns: AttachmentsListForConversationOutputSchema },
      );
      bus.registerService(
        'artifacts:publish-blob',
        PLUGIN_NAME,
        publishArtifactBlobHandler,
        { returns: ArtifactsPublishBlobOutputSchema },
      );

      // 5) TASK-718: a purged conversation's files/artifacts rows go with it.
      //    Rows only — see the comment in `store.purgeForConversations` for why
      //    the blob bytes stay. K10: a subscriber must never propagate, so every
      //    failure is logged and swallowed; a missed purge leaves dead rows,
      //    not readable ones (attachments:download's owner gate calls
      //    `conversations:get`, which answers not-found once the conversation
      //    row is gone).
      bus.subscribe<{ conversationIds: unknown }>(
        'conversations:purged',
        PLUGIN_NAME,
        async (ctx, payload) => {
          const ids = parsePurgedIds(payload);
          if (ids === undefined) {
            ctx.logger.warn('attachments_purge_ignored_malformed_payload', {
              max: MAX_PURGED_IDS,
            });
            return undefined;
          }
          if (ids.length === 0) return undefined;
          try {
            const counts = await store.purgeForConversations(ids);
            ctx.logger.info('attachments_purged_for_conversations', {
              conversations: ids.length,
              ...counts,
            });
          } catch (err) {
            ctx.logger.error('attachments_purge_for_purged_conversations_failed', {
              count: ids.length,
              err,
            });
          }
          return undefined;
        },
      );

      // 6) Start the janitor. The interval defaults to 5 minutes; tests
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

