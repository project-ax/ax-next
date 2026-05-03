import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type Plugin,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
import { parseJsonlToTurns } from '@ax/agent-claude-sdk-runner-host';
import type { ContentBlock } from '@ax/ipc-protocol';
import { type Kysely } from 'kysely';
import {
  runConversationsMigration,
  type ConversationDatabase,
} from './migrations.js';
import {
  createConversationStore,
  validateRunnerType,
  validateTitle,
  validateWorkspaceRefForFreeze,
  type ConversationStore,
} from './store.js';
import type {
  BindSessionInput,
  BindSessionOutput,
  ConversationsConfig,
  CreateInput,
  CreateOutput,
  DeleteInput,
  DeleteOutput,
  GetByReqIdInput,
  GetByReqIdOutput,
  GetInput,
  GetMetadataInput,
  GetMetadataOutput,
  GetOutput,
  ListInput,
  ListOutput,
  SetTitleInput,
  SetTitleOutput,
  StoreRunnerSessionInput,
  StoreRunnerSessionOutput,
  Turn,
  UnbindSessionInput,
  UnbindSessionOutput,
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

/**
 * Phase B (2026-04-29). Resolved config — narrows
 * `defaultRunnerType?: string` to a non-empty validated string. Defaults
 * to 'claude-sdk' (the single-runner-per-host MVP, design D5).
 */
interface ResolvedConversationsConfig {
  defaultRunnerType: string;
}

function resolveConfig(
  input: ConversationsConfig,
): ResolvedConversationsConfig {
  const raw = input.defaultRunnerType ?? 'claude-sdk';
  const validated = validateRunnerType(raw);
  if (validated === null) {
    // Validator returns null for null/undefined input; the `?? 'claude-sdk'`
    // above means the only path here is an explicitly-null user override.
    throw new Error(
      "ConversationsConfig.defaultRunnerType must be a non-empty string (matches /^[a-z0-9-]+$/, ≤ 64 chars)",
    );
  }
  return { defaultRunnerType: validated };
}

export function createConversationsPlugin(
  config: ConversationsConfig = {},
): Plugin {
  const resolvedConfig = resolveConfig(config);
  let db: Kysely<ConversationDatabase> | undefined;
  let _store: ConversationStore | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'conversations:create',
        'conversations:get',
        'conversations:list',
        'conversations:delete',
        'conversations:get-by-req-id',
        // Task 14 (Week 10–12): active_session_id lifecycle (J6).
        'conversations:bind-session',
        'conversations:unbind-session',
        // Phase B (2026-04-29): runner-owned-sessions metadata reads.
        // Sidebar / runner-plugin call site lands in Phase C — half-
        // wired window OPEN (closed by Phase C, see PR notes).
        'conversations:get-metadata',
        // Phase B (2026-04-29): idempotent first-bind for the runner's
        // native session id. Caller (Phase C) is the runner-plugin's
        // host-side IPC handler.
        'conversations:store-runner-session',
        // Phase F (2026-05-03): post-creation title update for the
        // auto-title pipeline (caller is @ax/conversation-titles' Phase
        // F chat:turn-end subscriber) plus future user-driven rename UI.
        'conversations:set-title',
      ],
      calls: [
        'agents:resolve',
        'database:get-instance',
        // Phase D (2026-05-02): conversations:get reads the runner's
        // native jsonl transcript via workspace:list + workspace:read
        // instead of the conversation_turns rows. The hook's wire
        // shape is unchanged; only the source-of-truth shifted.
        'workspace:list',
        'workspace:read',
      ],
      // Task 14 (Week 10–12): subscribe to session:terminate so a sandbox
      // teardown clears active_session_id on every bound conversation row.
      subscribes: ['chat:turn-end', 'session:terminate'],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
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
        async (ctx, input) =>
          createConversation(localStore, bus, ctx, input, resolvedConfig),
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

      // Task 14 (Week 10–12): active_session_id lifecycle (J6).
      //
      // bind-session sets BOTH active_session_id AND active_req_id atomically
      // on `(conversationId, ctx.userId)`. unbind-session clears both. Both
      // hooks scope by ctx.userId — a misbehaving caller can't bind/unbind a
      // cross-tenant row. Neither hook calls `agents:resolve`: the
      // chat-orchestrator (Task 16) has already gated the user at agent:invoke
      // entry; re-running the gate here would only add latency.
      bus.registerService<BindSessionInput, BindSessionOutput>(
        'conversations:bind-session',
        PLUGIN_NAME,
        async (ctx, input) => bindSession(localStore, ctx, input),
      );

      bus.registerService<UnbindSessionInput, UnbindSessionOutput>(
        'conversations:unbind-session',
        PLUGIN_NAME,
        async (ctx, input) => unbindSession(localStore, ctx, input),
      );

      // Phase B (2026-04-29). Metadata-only read. Same ACL posture as
      // conversations:get — user_id pre-filter, then agents:resolve.
      // Half-wired window: no in-process caller until Phase C wires
      // the runner plugin's host-side surface.
      bus.registerService<GetMetadataInput, GetMetadataOutput>(
        'conversations:get-metadata',
        PLUGIN_NAME,
        async (ctx, input) =>
          getConversationMetadata(localStore, bus, ctx, input),
      );

      // Phase B (2026-04-29). Idempotent first-bind. Mirrors the
      // bind-session ACL posture: ctx.userId-scoped UPDATE only, no
      // agents:resolve round-trip (the orchestrator has already gated
      // the user at agent:invoke entry). Half-wired window: closed by
      // Phase C.
      bus.registerService<StoreRunnerSessionInput, StoreRunnerSessionOutput>(
        'conversations:store-runner-session',
        PLUGIN_NAME,
        async (ctx, input) => storeRunnerSession(localStore, ctx, input),
      );

      // Phase F (2026-05-03). Post-creation title update. Same ACL
      // posture as `conversations:get` — load the row first (user_id
      // pre-filter), then call agents:resolve. A foreign / missing /
      // tombstoned row surfaces as 'not-found' BEFORE the gate fires,
      // so the agents:resolve denial path doesn't leak existence.
      bus.registerService<SetTitleInput, SetTitleOutput>(
        'conversations:set-title',
        PLUGIN_NAME,
        async (ctx, input) =>
          setConversationTitle(localStore, bus, ctx, input),
      );

      // chat:turn-end subscriber.
      //
      // Phase D (2026-05-02): the runner's native jsonl is the source of
      // truth for transcripts. The subscriber only bumps `last_activity_at`
      // so sidebar ordering keeps tracking user-visible activity (I8).
      // Heartbeats stay heartbeats (no bump). Phase E Task 3 deleted the
      // `conversations:append-turn` service hook entirely — no callers
      // remain in the monorepo.
      bus.subscribe<TurnEndPayload>(
        'chat:turn-end',
        PLUGIN_NAME,
        async (ctx, payload) => {
          await handleTurnEnd(localStore, ctx, payload);
          // Task 14 (J6): once the turn ends, clear active_req_id while
          // KEEPING active_session_id. The sandbox stays alive for the next
          // user message; only the in-flight reqId is dead. Compare-and-
          // clear on reqId so a stale callback can't clobber a newer
          // in-flight reqId.
          await handleTurnEndClearReqId(localStore, ctx, payload);
          // Return undefined: pass-through (don't mutate the payload, don't
          // reject). HookBus treats undefined as "no change" so other
          // subscribers see the same payload we did.
          return undefined;
        },
      );

      // Task 14 (J6): session:terminate observation. Same hookName is used
      // by both the session-backend service hook AND this subscriber lane;
      // HookBus keeps them separate. We clear ALL conversations bound to
      // this sessionId — the typical case is one row, but a defensive
      // multi-row clear is correct (host-internal, no userId scope).
      // Subscriber MUST NOT throw — fire-and-forget.
      bus.subscribe<SessionTerminatePayload>(
        'session:terminate',
        PLUGIN_NAME,
        async (ctx, payload) => {
          await handleSessionTerminate(localStore, ctx, payload);
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

// session:terminate fire payload — host-internal observation. The session
// backend (session-postgres / session-inmemory) fires this AFTER the
// service work completes. We only care about sessionId; any other fields
// are forward-compat and we ignore them.
interface SessionTerminatePayload {
  sessionId?: string;
}

async function handleTurnEnd(
  store: ConversationStore,
  ctx: AgentContext,
  payload: TurnEndPayload,
): Promise<void> {
  // No conversation context → nothing to do (canary acceptance tests,
  // ephemeral admin probes).
  const conversationId = ctx.conversationId;
  if (conversationId === undefined) return;

  // Heartbeat turn-end (no content). The runner emits these every turn
  // so the host knows the SDK is awaiting input. I8: we DO NOT bump
  // last_activity_at on heartbeats — the timestamp must reflect
  // persisted user-visible activity, not the SDK's internal cadence.
  const blocks = payload.contentBlocks;
  if (blocks === undefined || blocks.length === 0) return;

  // Phase D (2026-05-02): we no longer write a conversation_turns row
  // here. Transcripts are sourced from the runner's native jsonl via
  // conversations:get → workspace:read. The bump remains because
  // sidebar ordering keys off last_activity_at (I8). Subscriber-must-
  // not-throw posture: log + swallow on bump failure.
  try {
    await store.bumpLastActivity(conversationId, new Date());
  } catch (err) {
    ctx.logger.warn('conversations_bump_last_activity_failed', {
      conversationId,
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

// Task 14 (J6): turn-end → clear active_req_id (compare-and-clear on
// reqId) while leaving active_session_id alone. We need ctx.conversationId
// AND payload.reqId — without both, we can't safely target the row.
//
// Compare-and-clear uses an `AND active_req_id = ?` predicate so a stale
// turn-end (reqId=r1 arriving after a fresh r2 has been bound) is a no-op.
// Subscriber MUST NOT throw — failures are logged.
async function handleTurnEndClearReqId(
  store: ConversationStore,
  ctx: AgentContext,
  payload: TurnEndPayload,
): Promise<void> {
  const conversationId = ctx.conversationId;
  if (conversationId === undefined) return;
  const reqId = payload.reqId;
  if (typeof reqId !== 'string' || reqId.length === 0) return;
  try {
    await store.clearActiveReqId(conversationId, reqId);
  } catch (err) {
    ctx.logger.warn('conversations_clear_active_req_id_failed', {
      conversationId,
      reqId,
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

// Task 14 (J6): session:terminate observation. Host-fired event with no
// userId scope — we clear ALL conversations bound to the terminated
// sessionId. By J6 this is typically a single row, but defensive multi-
// row clear is correct: if the session is gone, no row may keep an
// active_req_id pointing at it.
async function handleSessionTerminate(
  store: ConversationStore,
  ctx: AgentContext,
  payload: SessionTerminatePayload,
): Promise<void> {
  const sessionId = payload.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;
  try {
    await store.clearBySessionId(sessionId);
  } catch (err) {
    ctx.logger.warn('conversations_clear_by_session_failed', {
      sessionId,
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

/**
 * Narrow shape of what conversations needs from `agents:resolve`. The
 * upstream type publishes more — we deliberately read only what we
 * use, so a future field change in @ax/agents doesn't ripple.
 *
 * `workspaceRef` is read defensively: if the resolved agent omits it (a
 * test mock returning a stub) we treat it as null. Frozen-as-of-create
 * includes "frozen as null" — Phase C tolerates NULL on read.
 */
interface ResolvedAgentShape {
  agent: {
    id?: string;
    workspaceRef?: string | null;
  };
}

async function assertAgentReachable(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
  userId: string,
  hookName: string,
): Promise<ResolvedAgentShape['agent']> {
  try {
    const result = await bus.call<ResolveInput, ResolvedAgentShape>(
      'agents:resolve',
      ctx,
      { agentId, userId },
    );
    return result.agent;
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
  ctx: AgentContext,
  input: CreateInput,
  cfg: ResolvedConversationsConfig,
): Promise<CreateOutput> {
  const title = validateTitle(input.title ?? null);
  // J1: ACL gate BEFORE persisting. The agent must be reachable to the
  // creator; otherwise no conversation should ever exist for it. Phase B
  // (I5): we capture the resolved agent here — its workspaceRef gets
  // frozen onto the new row, mirroring I10. One bus call total; no
  // separate agents:get round-trip.
  const agent = await assertAgentReachable(
    bus,
    ctx,
    input.agentId,
    input.userId,
    'conversations:create',
  );
  const workspaceRef = validateWorkspaceRefForFreeze(agent.workspaceRef);
  const conv = await store.create({
    userId: input.userId,
    agentId: input.agentId,
    title,
    runnerType: cfg.defaultRunnerType,
    workspaceRef,
  });
  return conv;
}

async function setConversationTitle(
  store: ConversationStore,
  bus: HookBus,
  ctx: AgentContext,
  input: SetTitleInput,
): Promise<SetTitleOutput> {
  const hookName = 'conversations:set-title';
  // Validate the title BEFORE any I/O. validateTitle() throws
  // PluginError({ code: 'invalid-payload' }) on empty / oversize /
  // wrong type. Null is rejected here (the hook contract requires a
  // string) — validateTitle returns null on null input, which the
  // contract treats as invalid.
  const title = validateTitle(input.title);
  if (title === null) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: 'title must be a non-empty string',
    });
  }
  // Load the row first with the user_id pre-filter. A foreign or
  // tombstoned row collapses to 'not-found' identically — the
  // agents:resolve gate runs ONLY after we've confirmed the row
  // exists for this user, so the denial path never leaks existence.
  const conv = await store.getByIdNotDeleted(input.conversationId);
  if (conv === null || conv.userId !== input.userId) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `conversation '${input.conversationId}' not found`,
    });
  }
  // J1: ACL gate AFTER existence check, BEFORE the store write. If
  // resolve forbids/not-founds the agent, propagate verbatim and
  // leave the row untouched.
  await assertAgentReachable(bus, ctx, conv.agentId, input.userId, hookName);
  const updated = await store.setTitle({
    conversationId: input.conversationId,
    userId: input.userId,
    title,
    // exactOptionalPropertyTypes: only pass `ifNull` when the caller
    // explicitly set it. Spreading the property absent-when-undefined
    // matches the store's optional-property contract.
    ...(input.ifNull === undefined ? {} : { ifNull: input.ifNull }),
  });
  return { updated };
}

async function getConversationMetadata(
  store: ConversationStore,
  bus: HookBus,
  ctx: AgentContext,
  input: GetMetadataInput,
): Promise<GetMetadataOutput> {
  const hookName = 'conversations:get-metadata';
  // Same ACL posture as conversations:get — user_id pre-filter so a
  // foreign row surfaces as 'not-found' (no existence-leak via the
  // agents:resolve denial path).
  const md = await store.getMetadata(input.conversationId);
  if (md === null || md.userId !== input.userId) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `conversation '${input.conversationId}' not found`,
    });
  }
  await assertAgentReachable(bus, ctx, md.agentId, input.userId, hookName);
  return md;
}

async function getConversation(
  store: ConversationStore,
  bus: HookBus,
  ctx: AgentContext,
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
  // Phase D (2026-05-02): the transcript lives in the runner's native
  // jsonl file inside the workspace, NOT in conversation_turns. We
  // skip the workspace round-trip entirely when runnerSessionId is
  // null (pre-Phase-C rows or fresh rows whose first turn hasn't
  // landed yet — see Q3=(a)). The wire shape on
  // `conversations:get` is unchanged.
  const turns =
    conv.runnerSessionId === null
      ? []
      : await readTranscriptFromWorkspace(bus, ctx, conv.runnerSessionId);
  return { conversation: conv, turns };
}

/**
 * Phase D. Locate the runner's jsonl transcript by sessionId and parse it
 * into the canonical Turn[] shape. We glob via `workspace:list` instead of
 * hardcoding the SDK's cwd-encoding rule (which depends on
 * `AX_WORKSPACE_ROOT` and isn't a stable contract).
 *
 * Two graceful-empty paths preserve subscriber expectations:
 *   - `workspace:list` returns no matches → file hasn't been written
 *     yet OR a pre-Phase-C row that bound a runner session before the
 *     workspace plugin started persisting them.
 *   - `workspace:read` returns `{found:false}` → race between list and
 *     read (the file existed when listed, then vanished).
 */
async function readTranscriptFromWorkspace(
  bus: HookBus,
  ctx: AgentContext,
  runnerSessionId: string,
): Promise<Turn[]> {
  const list = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
    'workspace:list',
    ctx,
    { pathGlob: `.claude/projects/**/${runnerSessionId}.jsonl` },
  );
  if (list.paths.length === 0) return [];
  // Multiple matches are not expected — sessionIds are UUIDs and the
  // workspace stores at most one jsonl per session — but if it
  // happens, the list is sorted ascending by the workspace plugin so
  // picking the first entry is deterministic.
  const path = list.paths[0]!;
  const read = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read',
    ctx,
    { path },
  );
  if (!read.found) return [];
  return parseJsonlToTurns(read.bytes);
}

async function listConversations(
  store: ConversationStore,
  bus: HookBus,
  ctx: AgentContext,
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

// Bound conversationId / sessionId / reqId at the boundary. These come from
// the chat-orchestrator (host-internal), but the same defensive shape check
// we apply to every other hook input applies here — empty / oversized values
// mustn't sneak past.
function requireBoundedString(
  value: unknown,
  field: string,
  hookName: string,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName,
      message: `'${field}' must be a non-empty string (≤ 256 chars)`,
    });
  }
  return value;
}

async function bindSession(
  store: ConversationStore,
  ctx: AgentContext,
  input: BindSessionInput,
): Promise<BindSessionOutput> {
  const hookName = 'conversations:bind-session';
  const conversationId = requireBoundedString(
    input.conversationId,
    'conversationId',
    hookName,
  );
  const sessionId = requireBoundedString(input.sessionId, 'sessionId', hookName);
  const reqId = requireBoundedString(input.reqId, 'reqId', hookName);
  const userId = requireBoundedString(ctx.userId, 'ctx.userId', hookName);
  const updated = await store.setActiveSession({
    conversationId,
    userId,
    sessionId,
    reqId,
  });
  if (!updated) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `conversation '${conversationId}' not found`,
    });
  }
}

async function storeRunnerSession(
  store: ConversationStore,
  ctx: AgentContext,
  input: StoreRunnerSessionInput,
): Promise<StoreRunnerSessionOutput> {
  const hookName = 'conversations:store-runner-session';
  const conversationId = requireBoundedString(
    input.conversationId,
    'conversationId',
    hookName,
  );
  const runnerSessionId = requireBoundedString(
    input.runnerSessionId,
    'runnerSessionId',
    hookName,
  );
  const userId = requireBoundedString(ctx.userId, 'ctx.userId', hookName);
  const result = await store.storeRunnerSession({
    conversationId,
    userId,
    runnerSessionId,
  });
  switch (result) {
    case 'bound':
    case 'already-bound-same':
      return;
    case 'conflict':
      throw new PluginError({
        code: 'conflict',
        plugin: PLUGIN_NAME,
        hookName,
        message: `runner_session_id already bound to a different value for conversation '${conversationId}'`,
      });
    case 'not-found':
      throw new PluginError({
        code: 'not-found',
        plugin: PLUGIN_NAME,
        hookName,
        message: `conversation '${conversationId}' not found`,
      });
  }
}

async function unbindSession(
  store: ConversationStore,
  ctx: AgentContext,
  input: UnbindSessionInput,
): Promise<UnbindSessionOutput> {
  const hookName = 'conversations:unbind-session';
  const conversationId = requireBoundedString(
    input.conversationId,
    'conversationId',
    hookName,
  );
  const userId = requireBoundedString(ctx.userId, 'ctx.userId', hookName);
  const updated = await store.clearActiveSession({ conversationId, userId });
  if (!updated) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `conversation '${conversationId}' not found`,
    });
  }
}

async function deleteConversation(
  store: ConversationStore,
  bus: HookBus,
  ctx: AgentContext,
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

