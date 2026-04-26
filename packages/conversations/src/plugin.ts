import {
  makeChatContext,
  PluginError,
  type ChatContext,
  type HookBus,
  type Plugin,
} from '@ax/core';
import type { ContentBlock } from '@ax/ipc-protocol';
import type { Kysely } from 'kysely';
import {
  runConversationsMigration,
  type ConversationDatabase,
} from './migrations.js';
import {
  createConversationStore,
  validateContentBlocks,
  validateRole,
  validateTitle,
  type ConversationStore,
} from './store.js';
import type {
  AppendTurnInput,
  AppendTurnOutput,
  ConversationsConfig,
  CreateInput,
  CreateOutput,
  DeleteInput,
  DeleteOutput,
  GetByReqIdInput,
  GetByReqIdOutput,
  GetInput,
  GetOutput,
  ListInput,
  ListOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/conversations';

// ---------------------------------------------------------------------------
// @ax/conversations plugin
//
// Registers the five `conversations:*` service hooks. Every hook calls
// `agents:resolve(agentId, userId)` BEFORE touching the store
// (Invariant J1). On `forbidden` / `not-found` from `agents:resolve` we
// propagate the matching `PluginError` code; the store is not consulted.
//
// Manifest decisions:
//   - `calls: ['agents:resolve', 'database:get-instance']` — both hard.
//     The plugin can't function without an agent ACL gate or a postgres
//     instance.
//   - `subscribes: ['chat:turn-end']` is declared in the manifest. Task 3
//     wires the subscriber. Task 2 (this slice) only ships service hooks;
//     a plugin that subscribes-but-handles is allowed because
//     `chat:turn-end` is a fire-and-forget event with no required
//     observers, so the missing subscriber is not a half-wired plugin
//     in the I3 sense.
//   - We DO NOT add `bind-session` / `unbind-session` hooks here — Task 14.
// ---------------------------------------------------------------------------

export function createConversationsPlugin(
  _config: ConversationsConfig = {},
): Plugin {
  let db: Kysely<ConversationDatabase> | undefined;
  let _store: ConversationStore | undefined;

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
        'conversations:get-by-req-id',
      ],
      calls: ['agents:resolve', 'database:get-instance'],
      subscribes: ['chat:turn-end'],
    },

    async init({ bus }) {
      const initCtx = makeChatContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      const { db: shared } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      db = shared as Kysely<ConversationDatabase>;
      await runConversationsMigration(db);
      const localStore = createConversationStore(db);
      _store = localStore;

      bus.registerService<CreateInput, CreateOutput>(
        'conversations:create',
        PLUGIN_NAME,
        async (ctx, input) => createConversation(localStore, bus, ctx, input),
      );

      bus.registerService<AppendTurnInput, AppendTurnOutput>(
        'conversations:append-turn',
        PLUGIN_NAME,
        async (ctx, input) => appendTurn(localStore, bus, ctx, input),
      );

      bus.registerService<GetInput, GetOutput>(
        'conversations:get',
        PLUGIN_NAME,
        async (ctx, input) => getConversation(localStore, bus, ctx, input),
      );

      bus.registerService<ListInput, ListOutput>(
        'conversations:list',
        PLUGIN_NAME,
        async (ctx, input) => listConversations(localStore, bus, ctx, input),
      );

      bus.registerService<DeleteInput, DeleteOutput>(
        'conversations:delete',
        PLUGIN_NAME,
        async (ctx, input) => deleteConversation(localStore, bus, ctx, input),
      );

      bus.registerService<GetByReqIdInput, GetByReqIdOutput>(
        'conversations:get-by-req-id',
        PLUGIN_NAME,
        async (_ctx, input) => getByReqId(localStore, input),
      );

      // chat:turn-end auto-append (Task 3 of Week 10–12).
      //
      // The runner emits event.turn-end with `contentBlocks` + `role` after
      // every turn; the IPC handler validates against EventTurnEndSchema
      // and fires this subscriber. We append to ctx.conversationId via the
      // existing :append-turn service hook so the same agents:resolve gate
      // (Invariant J1) runs on the auto-append as on any explicit one.
      //
      // Contract:
      //   - No-op when ctx.conversationId is unset (Task 16 wires it; until
      //     then, canary chats run without a conversation).
      //   - No-op when payload.contentBlocks is missing/empty (heartbeat
      //     turn-ends MUST stay heartbeats — never write empty rows).
      //   - Failures from :append-turn are caught and logged; chat flow
      //     MUST NOT abort if storage hiccups (subscriber-must-not-throw).
      bus.subscribe<TurnEndPayload>(
        'chat:turn-end',
        PLUGIN_NAME,
        async (ctx, payload) => {
          await handleTurnEnd(bus, ctx, payload);
          // Return undefined: pass-through (don't mutate the payload, don't
          // reject). HookBus treats undefined as "no change" so other
          // subscribers see the same payload we did.
          return undefined;
        },
      );
    },

    async shutdown() {
      // The shared db handle is owned by @ax/database-postgres; don't close
      // it here. Drop our references so a re-init doesn't read a stale
      // store.
      db = undefined;
      _store = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// chat:turn-end subscriber payload. Mirrors the optional fields on
// EventTurnEndSchema (locked in Task 4): the runner attaches contentBlocks
// + role for turns we want to persist; older / non-conversation runners
// can still fire turn-ends without them and we just skip.
// ---------------------------------------------------------------------------
interface TurnEndPayload {
  reqId?: string;
  reason?: string;
  contentBlocks?: ContentBlock[];
  role?: 'user' | 'assistant' | 'tool';
}

async function handleTurnEnd(
  bus: HookBus,
  ctx: ChatContext,
  payload: TurnEndPayload,
): Promise<void> {
  // No conversation context → nothing to persist (canary acceptance
  // tests, ephemeral admin probes). Task 16 wires the orchestrator to
  // populate conversationId on chat:run; until then this is the common
  // path.
  const conversationId = ctx.conversationId;
  if (conversationId === undefined) return;

  // Heartbeat turn-end (no content). The runner emits these every turn
  // so the host knows the SDK is awaiting input — we deliberately don't
  // write empty rows.
  const blocks = payload.contentBlocks;
  if (blocks === undefined || blocks.length === 0) return;

  const role = payload.role ?? 'assistant';

  try {
    await bus.call<AppendTurnInput, AppendTurnOutput>(
      'conversations:append-turn',
      ctx,
      {
        conversationId,
        userId: ctx.userId,
        role,
        contentBlocks: blocks,
      },
    );
  } catch (err) {
    // Subscriber MUST NOT throw — a storage hiccup, ACL change, or
    // validation reject in :append-turn would otherwise tear down the
    // chat. Log at warn so the operator can spot it without breaking
    // the live conversation.
    ctx.logger.warn('conversations_auto_append_failed', {
      conversationId,
      role,
      ...(payload.reqId !== undefined ? { reqId: payload.reqId } : {}),
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

// ---------------------------------------------------------------------------
// agents:resolve gate. Wraps the bus call so every conversations hook can
// call `await assertAgentReachable(...)` and get a uniform PluginError
// surface back. Forbidden / not-found bubble through; everything else
// (network blips, validation failures, etc.) propagates verbatim.
// ---------------------------------------------------------------------------

interface ResolveInput {
  agentId: string;
  userId: string;
}

async function assertAgentReachable(
  bus: HookBus,
  ctx: ChatContext,
  agentId: string,
  userId: string,
  hookName: string,
): Promise<void> {
  try {
    await bus.call<ResolveInput, unknown>('agents:resolve', ctx, {
      agentId,
      userId,
    });
  } catch (err) {
    if (err instanceof PluginError) {
      // Re-throw with our plugin name attached so audit can attribute the
      // denial to conversations, not agents — but preserve the underlying
      // code so callers can branch on 'forbidden' vs 'not-found'.
      if (err.code === 'forbidden' || err.code === 'not-found') {
        throw new PluginError({
          code: err.code,
          plugin: PLUGIN_NAME,
          hookName,
          message: err.message,
          cause: err,
        });
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Hook handlers.
// ---------------------------------------------------------------------------

async function createConversation(
  store: ConversationStore,
  bus: HookBus,
  ctx: ChatContext,
  input: CreateInput,
): Promise<CreateOutput> {
  const title = validateTitle(input.title ?? null);
  // J1: ACL gate BEFORE persisting. The agent must be reachable to the
  // creator; otherwise no conversation should ever exist for it.
  await assertAgentReachable(
    bus,
    ctx,
    input.agentId,
    input.userId,
    'conversations:create',
  );
  const conv = await store.create({
    userId: input.userId,
    agentId: input.agentId,
    title,
  });
  return conv;
}

async function appendTurn(
  store: ConversationStore,
  bus: HookBus,
  ctx: ChatContext,
  input: AppendTurnInput,
): Promise<AppendTurnOutput> {
  const role = validateRole(input.role);
  const blocks = validateContentBlocks(input.contentBlocks);
  // Look up the conversation row to discover its frozen agent_id, then
  // re-check ACL via agents:resolve. We deliberately filter by user_id
  // first so that a row owned by someone else returns 'not-found' rather
  // than leaking existence via the agents:resolve denial.
  const conv = await store.getByIdNotDeleted(input.conversationId);
  if (conv === null || conv.userId !== input.userId) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName: 'conversations:append-turn',
      message: `conversation '${input.conversationId}' not found`,
    });
  }
  await assertAgentReachable(
    bus,
    ctx,
    conv.agentId,
    input.userId,
    'conversations:append-turn',
  );
  return store.appendTurn({
    conversationId: input.conversationId,
    role,
    contentBlocks: blocks,
  });
}

async function getConversation(
  store: ConversationStore,
  bus: HookBus,
  ctx: ChatContext,
  input: GetInput,
): Promise<GetOutput> {
  const conv = await store.getByIdNotDeleted(input.conversationId);
  if (conv === null || conv.userId !== input.userId) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName: 'conversations:get',
      message: `conversation '${input.conversationId}' not found`,
    });
  }
  await assertAgentReachable(
    bus,
    ctx,
    conv.agentId,
    input.userId,
    'conversations:get',
  );
  const turns = await store.listTurns(input.conversationId);
  return { conversation: conv, turns };
}

async function listConversations(
  store: ConversationStore,
  bus: HookBus,
  ctx: ChatContext,
  input: ListInput,
): Promise<ListOutput> {
  // J1: when agentId is supplied, gate via agents:resolve. When absent,
  // ACL is implicit (filter by user_id only) — the user's own
  // conversations are always reachable to them.
  if (input.agentId !== undefined) {
    await assertAgentReachable(
      bus,
      ctx,
      input.agentId,
      input.userId,
      'conversations:list',
    );
  }
  const rows = await store.listForUser(input.userId, input.agentId);
  return rows;
}

async function getByReqId(
  store: ConversationStore,
  input: GetByReqIdInput,
): Promise<GetByReqIdOutput> {
  // Bound the inputs at the boundary. `reqId` is route-data — a tampered
  // empty string would otherwise collapse to "any conversation with a
  // null active_req_id," which is wrong. We don't bound to the
  // `req-XXXXXX` shape because the producer (chat-orchestrator) hasn't
  // locked it yet — Task 14 may widen the scheme.
  if (
    typeof input.reqId !== 'string' ||
    input.reqId.length === 0 ||
    input.reqId.length > 256
  ) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName: 'conversations:get-by-req-id',
      message: 'reqId not found',
    });
  }
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName: 'conversations:get-by-req-id',
      message: 'reqId not found',
    });
  }
  const conv = await store.getByReqIdForUser(input.userId, input.reqId);
  if (conv === null) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName: 'conversations:get-by-req-id',
      message: 'reqId not found',
    });
  }
  return conv;
}

async function deleteConversation(
  store: ConversationStore,
  bus: HookBus,
  ctx: ChatContext,
  input: DeleteInput,
): Promise<DeleteOutput> {
  const conv = await store.getByIdNotDeleted(input.conversationId);
  if (conv === null || conv.userId !== input.userId) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName: 'conversations:delete',
      message: `conversation '${input.conversationId}' not found`,
    });
  }
  await assertAgentReachable(
    bus,
    ctx,
    conv.agentId,
    input.userId,
    'conversations:delete',
  );
  await store.softDelete(input.conversationId);
}

