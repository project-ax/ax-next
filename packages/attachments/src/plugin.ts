import { randomBytes } from 'node:crypto';
import {
  BLOB_COLLECT_REFS_HOOK,
  PluginError,
  answerBlobCollectRefs,
  makeAgentContext,
  type AgentContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import type { Kysely } from 'kysely';
import { runAttachmentsMigration, type AttachmentsDatabase } from './migrations.js';
import { createAttachmentsStore, type AttachmentsStore } from './store.js';
import { backfillArtifactAgents, finishArtifactsMigration } from './artifacts/migrations.js';
import { createArtifactStore } from './artifacts/store.js';
import {
  AGENT_DISPLAY_NAME_DEGRADATION,
  AGENT_DISPLAY_NAME_HOOK,
  ARTIFACT_HOOKS,
  MINT_VIEW_TOKEN_HOOK,
  createArtifactsMintViewTokenHandler,
  registerArtifactHooks,
} from './artifacts/handlers.js';
import { createArtifactServe, startContentOrigin, type ContentOriginHandle } from './artifacts/content-origin.js';
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
  ArtifactsMintViewTokenOutputSchema,
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

/** An agent id longer than this is not one. */
const MAX_AGENT_ID = 256;

/**
 * The deleted agent's id from an `agents:deleted` payload (untrusted, from
 * another plugin), or undefined when malformed.
 */
function parseDeletedAgentId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const id = (payload as { agentId?: unknown }).agentId;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_AGENT_ID) return undefined;
  return id;
}

const AGENT_IDS_HOOK = 'conversations:agent-ids';
const AGENT_IDS_DEGRADATION =
  'legacy artifacts cannot be mapped; init refuses to start while any are pending';

/**
 * `mapAgents` for the legacy-artifact backfill: conversation id -> agent id,
 * through the host-only `conversations:agent-ids` (soft-deleted chats
 * included). Absent service + pending rows = refuse to start, rather than
 * guess or drop a person's artifacts.
 */
function agentIdsVia(bus: HookBus, ctx: AgentContext) {
  return async (conversationIds: string[]): Promise<Map<string, string>> => {
    if (!bus.hasService(AGENT_IDS_HOOK)) {
      throw new PluginError({
        code: 'init-failed',
        plugin: PLUGIN_NAME,
        message: `legacy artifacts are waiting to be mapped to their agents, and ${AGENT_IDS_HOOK} is not available`,
      });
    }
    const out = await bus.call<
      { conversationIds: string[] },
      { conversations: Array<{ conversationId: string; agentId: string }> }
    >(AGENT_IDS_HOOK, ctx, { conversationIds });
    return new Map(out.conversations.map((c) => [c.conversationId, c.agentId]));
  };
}

// ---------------------------------------------------------------------------
// @ax/attachments plugin — the host-side home of uploads and published
// artifacts: their metadata rows (bytes live in the content-addressed blob
// store, TASK-68) and the download ACL. Everything is addressed by id; no hook
// takes or returns a path.
//
// Service hooks:
//   - attachments:store-temp   (caller: POST /api/attachments route)
//   - attachments:commit       (caller: POST /api/chat/messages handler)
//   - attachments:download     (callers: GET /api/files; future Slack plugin)
//   - attachments:list-for-conversation (caller: ipc-core `attachments.list`)
//   - artifacts:publish-blob   (caller: ipc-core `artifact.publish`)
//   - artifacts:publish / list / get / read / rename / restore / delete: the
//     artifact owner hooks. Every one runs the single access rule
//     (artifacts/access.ts: agents:resolve membership -> role -> can), and
//     every refusal is the same not-found.
//   - artifacts:set-link (owner: Copy link / Get new link / turn off) and
//     artifacts:resolve-share-code (a signed-in link holder: the current
//     version's metadata). artifacts:read also takes a share code. Codes go
//     through the same access rule; a bad code is the same not-found.
//   - system-prompt:augment:optional:artifacts: the agent's own artifact list.
//   - artifacts:mint-view-token: a short-lived URL on the content origin for
//     one version (§6.5). The content origin is this plugin's second listener
//     (artifacts/content-origin.ts), started in init when `contentOrigin` is
//     configured and closed in shutdown. Its signing key is random per process
//     and never leaves memory.
//
// Manifest decisions (the authoritative list is the `calls:` array below —
// this prose is a summary):
//   - calls: database:get-instance (own table + migration), blob:put (for
//     attachments:commit), blob:get (for attachments:download),
//     conversations:get (owner gate in attachments:download and publish, and
//     the conversation's agent), agents:resolve (a published version's quota
//     owner: the user, or `team:<id>` for a team agent, C4).
//   - optionalCalls: conversations:agent-ids, only to map legacy
//     conversation-scoped artifacts to their agent at init;
//     agents:get-display-name, the agent's name on the share page (without
//     it the page says "an agent").
//   - subscribes: `conversations:purged` (TASK-718). A hard-deleted
//     conversation takes its uploads' rows with it; artifacts outlive their
//     chat (D12), so their versions only lose the chat id. The blob bytes are
//     left in place (content-addressed + shared).
//   - subscribes: `agents:deleted`. Deleting the agent deletes its artifacts.
//   - subscribes: `blob:collect-refs` (TASK-776). We store blob shas in our own
//     rows, so we answer "which of these do you still reference, and for
//     whom?" from uploads and artifact versions. Reclaiming bytes is the
//     sweeper's job, and it only deletes what every holder agrees nobody
//     references.
//   - calls `blob:stat` (TASK-776): artifacts:publish-blob refuses a sha the
//     blob store does not hold, so no row ever points at missing bytes.
// ---------------------------------------------------------------------------

/** The plugin, plus where its content origin listens once init has run. */
export type AttachmentsPlugin = Plugin & {
  /** The content origin's public URL, or undefined when none is configured or running. */
  contentOriginUrl(): string | undefined;
};

export function createAttachmentsPlugin(
  config: AttachmentsConfig = {},
): AttachmentsPlugin {
  let janitor: JanitorHandle | undefined;
  let contentOrigin: { handle: ContentOriginHandle; key: Uint8Array } | undefined;
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
        ...ARTIFACT_HOOKS,
        MINT_VIEW_TOKEN_HOOK,
      ],
      calls: [
        'database:get-instance',
        // TASK-68: bytes live in the content-addressed blob store.
        // attachments:commit stores via blob:put; attachments:download fetches
        // via blob:get.
        'blob:put',
        'blob:get',
        // TASK-776 (D10): artifacts:publish-blob refuses a sha the store lacks.
        'blob:stat',
        'conversations:get',
        // A published version is charged to the agent's owner (C4).
        'agents:resolve',
      ],
      optionalCalls: [
        { hook: AGENT_IDS_HOOK, degradation: AGENT_IDS_DEGRADATION },
        // The agent's name on the share page.
        { hook: AGENT_DISPLAY_NAME_HOOK, degradation: AGENT_DISPLAY_NAME_DEGRADATION },
      ],
      // `blob:collect-refs`: this plugin stores blob shas in its own rows, so it
      // is a holder (TASK-776, D2/D7). It must answer, or a sweep would read the
      // absence as "no one holds these bytes".
      subscribes: ['conversations:purged', BLOB_COLLECT_REFS_HOOK, 'agents:deleted'],
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

      // 2) Run the migration. Idempotent: safe on every boot. In this order:
      //    DDL + legacy upgrade, then each legacy artifact's agent (a failure
      //    rejects init and leaves the rows for the next boot), then NOT NULL +
      //    indexes. Nothing is registered until all three are done.
      await runAttachmentsMigration(db);
      const backfill = await backfillArtifactAgents(db, agentIdsVia(bus, initCtx));
      if (backfill.mapped + backfill.dropped > 0) {
        initCtx.logger.info('attachments_artifacts_backfilled', backfill);
      }
      await finishArtifactsMigration(db);

      // 3) Store + handlers.
      const store = createAttachmentsStore(db);
      _store = store;
      const artifacts = createArtifactStore(db);
      const storeTempHandler = createStoreTempHandler({ store, config });
      const commitHandler = createCommitHandler({ store, bus });
      const downloadHandler = createDownloadHandler({ bus, store, artifacts });
      const listForConversationHandler = createListForConversationHandler({ store });
      const publishArtifactBlobHandler = createPublishArtifactBlobHandler({ artifacts, bus });

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
      registerArtifactHooks(bus, PLUGIN_NAME, { artifacts, bus });

      // The content origin (§6.5). The key is made here and held only in
      // memory: a restart retires every token in flight.
      if (config.contentOrigin !== undefined) {
        const key = randomBytes(32);
        const handle = await startContentOrigin({
          ...config.contentOrigin,
          key,
          logger: initCtx.logger,
          serve: createArtifactServe({ artifacts, bus }),
        });
        contentOrigin = { handle, key };
      }
      bus.registerService(
        MINT_VIEW_TOKEN_HOOK,
        PLUGIN_NAME,
        createArtifactsMintViewTokenHandler({ artifacts, bus }, () =>
          contentOrigin === undefined ? undefined : { key: contentOrigin.key, publicOrigin: contentOrigin.handle.url },
        ),
        { returns: ArtifactsMintViewTokenOutputSchema },
      );

      // 5) TASK-718: a purged conversation's upload rows go with it; its
      //    artifacts stay (they are the agent's, D12) and their versions just
      //    lose the chat id. Rows only — see `store.purgeForConversations` for
      //    why the blob bytes stay. K10: a subscriber must never propagate, so
      //    every failure is logged and swallowed; a missed purge leaves dead
      //    rows, not readable ones (attachments:download's owner gate calls
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
            const { files } = await store.purgeForConversations(ids);
            const clearedVersions = await artifacts.clearConversations(ids);
            ctx.logger.info('attachments_purged_for_conversations', {
              conversations: ids.length,
              files,
              clearedVersions,
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

      // Deleting an agent deletes its artifacts, every version (D12). Fired by
      // @ax/agents after the agent row is gone; the payload is untrusted.
      // Observation-only: logged and swallowed, never thrown into the bus.
      bus.subscribe<unknown>('agents:deleted', PLUGIN_NAME, async (ctx, payload) => {
        const agentId = parseDeletedAgentId(payload);
        if (agentId === undefined) {
          ctx.logger.warn('attachments_agents_deleted_ignored_malformed_payload', {});
          return undefined;
        }
        try {
          const counts = await artifacts.deleteForAgent(agentId);
          ctx.logger.info('attachments_artifacts_deleted_for_agent', { agentId, ...counts });
        } catch (err) {
          ctx.logger.error('attachments_artifacts_delete_for_agent_failed', { agentId, err });
        }
        return undefined;
      });

      // 6) TASK-776: answer "which of these blobs do you still reference, and
      //    for whom?" from our own rows (D7). `answerBlobCollectRefs` validates
      //    the (untrusted) payload and turns any failure into `ok: false`
      //    instead of throwing: HookBus.fire swallows a throw, which the caller
      //    would read as "nothing here references these bytes".
      bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, PLUGIN_NAME, async (_ctx, payload) =>
        answerBlobCollectRefs(payload, PLUGIN_NAME, async (shas) => [
          ...(await store.blobRefs(shas)),
          ...(await artifacts.blobRefs(shas)),
        ]),
      );

      // 7) Start the janitor. The interval defaults to 5 minutes; tests
      //    can override via `janitorIntervalSeconds`.
      janitor = startJanitor({
        store,
        intervalSeconds:
          config.janitorIntervalSeconds ?? DEFAULT_JANITOR_INTERVAL_SECONDS,
        ctx: initCtx,
      });
    },

    contentOriginUrl() {
      return contentOrigin?.handle.url;
    },

    async shutdown() {
      // Stop the periodic sweep so the test harness / kernel can drain.
      // The bus's service-handler registrations don't need explicit unregister
      // — the bus is single-use per process and tests recreate it fresh.
      if (janitor !== undefined) {
        await janitor.stop();
        janitor = undefined;
      }
      if (contentOrigin !== undefined) {
        const { handle } = contentOrigin;
        contentOrigin = undefined;
        await handle.close();
      }
      // Drop references so a re-init doesn't pick up a stale store.
      _store = undefined;
      _db = undefined;
    },
  };
}

