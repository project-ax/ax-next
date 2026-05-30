import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type HookBus,
  type Plugin,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
import { parseJsonlToTurns } from '@ax/agent-claude-sdk-runner-host';
import {
  AttachmentBlockSchema,
  parseAttachmentMention,
  type ContentBlock,
} from '@ax/ipc-protocol';
import { type Kysely } from 'kysely';
import {
  runConversationsMigration,
  type ConversationDatabase,
} from './migrations.js';
import {
  createConversationStore,
  dropTurnFromJsonl,
  validateContentBlocks,
  validateOptionalBoolean,
  validateRunnerType,
  validateTitle,
  validateWorkspaceRefForFreeze,
  type ConversationStore,
  type StoredEvent,
} from './store.js';
import {
  GetMetadataOutputSchema,
  StoreRunnerSessionOutputSchema,
} from './types.js';
import type {
  AppendEventInput,
  AppendEventOutput,
  BindSessionInput,
  BindSessionOutput,
  ConversationDisplayEvent,
  ConversationsConfig,
  CreateInput,
  CreateOutput,
  DeleteInput,
  DeleteOutput,
  DropTurnInput,
  DropTurnOutput,
  FindOrCreateInput,
  FindOrCreateOutput,
  GetByReqIdInput,
  GetByReqIdOutput,
  GetInput,
  GetMetadataInput,
  GetMetadataOutput,
  GetOutput,
  HideInput,
  HideOutput,
  ListInput,
  ListOutput,
  SetTitleInput,
  SetTitleOutput,
  StoreRunnerSessionInput,
  StoreRunnerSessionOutput,
  TitleUpdatedEvent,
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
        // Phase A (routines foundation, 2026-05-14): mark a conversation
        // hidden so it disappears from list queries but remains readable
        // by id. Half-wired window OPEN: caller lands in Phase B
        // (@ax/routines plugin).
        'conversations:hide',
        // Phase B (2026-05-14): runner-native jsonl rewrite shipped here;
        // first caller is @ax/routines silence-token logic. Half-wired
        // window CLOSED.
        'conversations:drop-turn',
        // Phase A (routines foundation, 2026-05-14): stable per-(user,
        // agent, key) conversation lookup for `conversation: shared`
        // routines. Returns { conversation, created } so callers know
        // which path ran. ACL gate (J1) runs BEFORE the SELECT to
        // prevent foreign callers from probing for a routine's
        // externalKey. Half-wired window OPEN: caller lands in Phase B.
        'conversations:find-or-create',
        // TASK-66 (out-of-git Part B / B1, 2026-05-30): host-internal
        // append to the display event log (the redisplay SoT). Fed by this
        // plugin's own chat:turn-end / chat:turn-error /
        // chat:permission-request subscribers below — NOT reachable by the
        // untrusted runner over IPC (it only reaches the event.* IPC
        // events, which those subscribers translate). Half-wired window
        // CLOSED: the caller (the subscribers) AND the consumer
        // (conversations:get reading the log) ship in this same PR.
        'conversations:append-event',
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
        // Phase B (routines, 2026-05-14): conversations:drop-turn rewrites
        // the jsonl file in-place via workspace:apply. Added alongside the
        // full drop-turn implementation (I7 closure).
        'workspace:apply',
      ],
      // Task 14 (Week 10–12): subscribe to session:terminate so a sandbox
      // teardown clears active_session_id on every bound conversation row.
      // TASK-66 (2026-05-30): also subscribe to the HOST-only display events
      // the SDK jsonl never sees — chat:turn-error (surfaced provider/sandbox
      // errors) and chat:permission-request (approval cards) — and persist
      // them into the display event log so redisplay includes them.
      subscribes: [
        'chat:turn-end',
        'session:terminate',
        'chat:turn-error',
        'chat:permission-request',
      ],
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
        { returns: GetMetadataOutputSchema },
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
        { returns: StoreRunnerSessionOutputSchema },
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

      // Phase A (routines foundation, 2026-05-14). Same ACL posture as
      // conversations:get — user_id pre-filter, then agents:resolve. Half-
      // wired window OPEN: caller lands in Phase B (the @ax/routines plugin).
      bus.registerService<HideInput, HideOutput>(
        'conversations:hide',
        PLUGIN_NAME,
        async (ctx, input) => hideConversation(localStore, bus, ctx, input),
      );

      // Phase B (2026-05-14): runner-native jsonl rewrite. Drops the line
      // whose uuid matches turnId (or the most recent turn if turnId is
      // empty), then workspace:apply's the rewritten bytes. Half-wired
      // window CLOSED — first caller is @ax/routines silence-token logic
      // (Task 13).
      bus.registerService<DropTurnInput, DropTurnOutput>(
        'conversations:drop-turn',
        PLUGIN_NAME,
        async (ctx, input) => dropTurn(localStore, bus, ctx, input),
      );

      // Phase A (routines foundation, 2026-05-14). Stable per-(user, agent,
      // key) conversation lookup for `conversation: shared` routines. ACL
      // gate (J1) runs BEFORE the SELECT to prevent foreign callers from
      // probing for the existence of a routine's externalKey. Half-wired
      // window OPEN: caller lands in Phase B.
      bus.registerService<FindOrCreateInput, FindOrCreateOutput>(
        'conversations:find-or-create',
        PLUGIN_NAME,
        async (ctx, input) => findOrCreateConversation(localStore, bus, ctx, input, resolvedConfig),
      );

      // TASK-66 (out-of-git Part B / B1): host-internal append to the display
      // event log. ctx-scoped only (no agents:resolve round-trip — same
      // posture as bind-session; the orchestrator already gated the user at
      // agent:invoke entry, and the untrusted runner can't reach this hook
      // over IPC). The conversationId comes from the input; the seq is minted
      // by the store. Used only by this plugin's own subscribers below
      // (closing the half-wired window in one PR), but registered as a hook so
      // the persist stays storage-agnostic (an alternate display-log backend
      // could register it).
      bus.registerService<AppendEventInput, AppendEventOutput>(
        'conversations:append-event',
        PLUGIN_NAME,
        async (_ctx, input) => appendEvent(localStore, input),
      );

      // chat:turn-end subscriber.
      //
      // Phase D (2026-05-02): the runner's native jsonl is the source of
      // truth for transcripts. The subscriber bumps `last_activity_at`
      // so sidebar ordering keeps tracking user-visible activity (I8).
      // Heartbeats stay heartbeats (no bump). Phase E Task 3 deleted the
      // `conversations:append-turn` service hook entirely.
      //
      // TASK-66 (2026-05-30): the turn's display frame is persisted into the
      // display event log via `conversations:append-event` — but NOT from this
      // broadcast subscriber. The @ax/ipc-core event.turn-end handler calls
      // `conversations:append-event` AWAITED + isolated, BEFORE this broadcast
      // fires, so persist-before-ack (B3) holds without blocking the turn-end
      // ack on this chain's other (potentially slow, e.g. title-LLM)
      // subscribers. This subscriber stays display-persist-free.
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

      // TASK-66: host-only display events the SDK jsonl never sees. Persist
      // them into the display event log so reload shows the same cards /
      // surfaced errors a live chat folds. Subscribers MUST NOT throw
      // (observation-only fire-and-forget) — failures are logged + swallowed.
      bus.subscribe<TurnErrorPayload>(
        'chat:turn-error',
        PLUGIN_NAME,
        async (ctx, payload) => {
          await persistTurnError(bus, ctx, payload);
          return undefined;
        },
      );
      bus.subscribe<PermissionRequestPayload>(
        'chat:permission-request',
        PLUGIN_NAME,
        async (ctx, payload) => {
          await persistPermissionCard(bus, ctx, payload);
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

// ---------------------------------------------------------------------------
// TASK-66 — host-only display-event subscriber payloads.
//
// chat:turn-error (Fault A) and chat:permission-request (the JIT approval
// card / reactive egress wall). Both are fired by the orchestrator with the
// conversation ctx; we duck-type only the fields we persist. These are
// UNTRUSTED host/model output — stored opaque, re-emitted to the renderer
// verbatim (J2 hardening lives at render).
// ---------------------------------------------------------------------------
interface TurnErrorPayload {
  reqId?: string;
  reason?: string;
}

// The fired card shape is a discriminated union ('skill' | 'host'); the
// orchestrator strips routing fields (reqId) before the browser sees it but
// they may still be on the fired payload. We persist the whole frame opaquely
// and derive a stable fold key from the card identity so a later resolution
// frame for the same card folds onto the earlier one.
interface PermissionRequestPayload {
  kind?: 'skill' | 'host';
  skillId?: string;
  host?: string;
  [k: string]: unknown;
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

// ---------------------------------------------------------------------------
// TASK-66 — display-event persist (out-of-git Part B / B1).
// ---------------------------------------------------------------------------

/**
 * conversations:append-event hook handler. Validates the conversationId at the
 * boundary, then mints + appends a row. ctx-scoped only (no agents:resolve —
 * host-internal; see the registration comment). `appendEvent` is the persist
 * primitive both the subscribers and any alternate display-log backend use.
 */
async function appendEvent(
  store: ConversationStore,
  input: AppendEventInput,
): Promise<AppendEventOutput> {
  const hookName = 'conversations:append-event';
  const conversationId = requireBoundedString(
    input.conversationId,
    'conversationId',
    hookName,
  );
  await store.appendEvent({
    conversationId,
    kind: input.kind,
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.key !== undefined ? { foldKey: input.key } : {}),
    payload: input.payload,
  });
}

/**
 * Persist a surfaced turn-error display event. Folds on the originating reqId
 * so a re-fire for the same turn replaces the earlier one. ctx-less fires are
 * skipped. MUST NOT throw.
 */
async function persistTurnError(
  bus: HookBus,
  ctx: AgentContext,
  payload: TurnErrorPayload,
): Promise<void> {
  const conversationId = ctx.conversationId;
  if (conversationId === undefined) return;
  const reqId = payload.reqId;
  const reason = payload.reason;
  if (typeof reason !== 'string' || reason.length === 0) return;
  try {
    await bus.call<AppendEventInput, AppendEventOutput>(
      'conversations:append-event',
      ctx,
      {
        conversationId,
        kind: 'turn-error',
        // Fold per originating reqId so a duplicate turn-error for the same
        // turn (the bounded-timeout path re-fires after session:terminate)
        // collapses to one card on replay.
        key: typeof reqId === 'string' && reqId.length > 0 ? reqId : '',
        payload: { ...(reqId !== undefined ? { reqId } : {}), error: reason },
      },
    );
  } catch (err) {
    ctx.logger.warn('conversations_persist_turn_error_failed', {
      conversationId,
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Persist a permission-request (approval card) display event. Folds on the
 * card identity (skillId for the skill variant, host for the reactive-wall
 * variant) so a later resolution frame for the same card folds onto it on
 * replay — no special final-state bookkeeping. ctx-less fires are skipped.
 * MUST NOT throw.
 */
async function persistPermissionCard(
  bus: HookBus,
  ctx: AgentContext,
  payload: PermissionRequestPayload,
): Promise<void> {
  const conversationId = ctx.conversationId;
  if (conversationId === undefined) return;
  // Derive a stable fold key from the card identity. Unknown shapes get the
  // empty key (single-slot) rather than being dropped — better to over-fold a
  // malformed card than to lose it.
  const foldKey =
    payload.kind === 'skill' && typeof payload.skillId === 'string'
      ? `skill:${payload.skillId}`
      : payload.kind === 'host' && typeof payload.host === 'string'
        ? `host:${payload.host}`
        : '';
  try {
    await bus.call<AppendEventInput, AppendEventOutput>(
      'conversations:append-event',
      ctx,
      {
        conversationId,
        kind: 'permission-card',
        key: foldKey,
        // Persist the whole frame opaquely. The renderer re-validates; we
        // never interpret it beyond the fold key derived above.
        payload: { ...payload },
      },
    );
  } catch (err) {
    ctx.logger.warn('conversations_persist_permission_card_failed', {
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
  // Phase D (2026-05-17): routines call with `hidden: true` for per-fire
  // conversations. Default false matches the store contract. validate
  // boolean-ness at the boundary so an external caller passing a truthy
  // non-boolean (e.g. "true") gets a structured invalid-payload error
  // instead of a postgres "invalid input syntax" at INSERT time.
  const hidden = validateOptionalBoolean(input.hidden, 'hidden') ?? false;
  const conv = await store.create({
    userId: input.userId,
    agentId: input.agentId,
    title,
    runnerType: cfg.defaultRunnerType,
    workspaceRef,
    hidden,
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

  // Live-title push (invariant #4 — single source of truth): the only
  // place a title is written is also the only place the change signal is
  // emitted, so every caller (auto-title pipeline today, rename UI later)
  // surfaces in connected sidebars with no reload. Payload is domain-level;
  // channel-web's title-events SSE duck-types it (no cross-plugin import).
  //
  // Guard on `conv.title !== title`, not just `updated`: `updated` reflects
  // that the row matched (rowCount), which is true even for an idempotent
  // rewrite of the same value (a future rename to the current title). Only
  // a genuine change should publish — never on the ifNull no-op or the
  // not-found path below, and never on a same-title rewrite.
  if (updated && conv.title !== title) {
    await bus.fire('conversations:title-updated', ctx, {
      conversationId: input.conversationId,
      userId: input.userId,
      title,
    } satisfies TitleUpdatedEvent);
  }
  if (updated) {
    return { updated: true };
  }

  // updated=false has two possible causes:
  //   (a) ifNull=true and the row was already titled — legitimate no-op.
  //   (b) the row was deleted (or moved cross-tenant) between the
  //       existence check above and the UPDATE — should surface as
  //       not-found so the caller sees the real failure rather than
  //       silently treating a vanished row as "no update needed".
  // Re-check existence to disambiguate. The contract on
  // SetTitleOutput.updated documents only meaning (a); leaking (b) as
  // updated=false would let callers ignore a real not-found.
  const current = await store.getByIdNotDeleted(input.conversationId);
  if (current === null || current.userId !== input.userId) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `conversation '${input.conversationId}' not found`,
    });
  }

  return { updated: false };
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

  // TASK-66 (out-of-git Part B / B1): redisplay reads the display event log
  // (the redisplay SoT), NOT the SDK jsonl. The persisted `turn` events are
  // the exact ordered display frames the host already emitted over SSE — the
  // model/tool content folded to its terminal state at the result boundary —
  // so a reloaded chat renders identically to a live one (same renderer path,
  // by construction). Host-only display events the SDK jsonl never sees
  // (approval cards, surfaced provider/sandbox errors) come back on
  // `displayEvents`, folded to their terminal state per key.
  const events = await store.listEvents(conv.conversationId);
  if (events.length > 0) {
    const turns = projectEventTurns(events);
    return {
      conversation: conv,
      turns: reconstructAttachmentBlocks(turns, conv.conversationId),
      displayEvents: projectDisplayEvents(events),
    };
  }

  // Legacy co-existence (scope boundary): a conversation whose turns predate
  // TASK-66 has no event-log rows. Fall back to the runner's native jsonl so
  // old chats still redisplay. Retiring the jsonl read entirely is
  // TASK-67/70. (Phase D, 2026-05-02): skip the workspace round-trip when
  // runnerSessionId is null (pre-Phase-C rows or fresh rows whose first turn
  // hasn't landed yet).
  //
  // Build a synthetic ctx scoped to the conversation's owner before the
  // workspace round-trip. The host-side workspace plugins (workspace-git,
  // workspace-git-server-client) derive their workspaceId from
  // (ctx.userId, ctx.agentId); the runner pod's commit-notify wrote the
  // jsonl into ws-<hash([conv.userId, conv.agentId])>. Channel-web calls
  // us with `initCtx` (userId='system', agentId='@ax/channel-web') —
  // forwarding that ctx into workspace:list looks up a different (empty)
  // workspaceId and returns no matches. The auth gate (input.userId ===
  // conv.userId, plus assertAgentReachable above) already proved the
  // caller owns this conversation, so it's safe to lift conv.userId /
  // conv.agentId into the synthetic ctx for the read.
  const turns =
    conv.runnerSessionId === null
      ? []
      : await readTranscriptFromWorkspace(
          bus,
          makeAgentContext({
            reqId: ctx.reqId,
            sessionId: ctx.sessionId,
            userId: conv.userId,
            agentId: conv.agentId,
            logger: ctx.logger,
            workspace: ctx.workspace,
          }),
          conv.runnerSessionId,
        );
  return {
    conversation: conv,
    turns: reconstructAttachmentBlocks(turns, conv.conversationId),
    displayEvents: [],
  };
}

// ---------------------------------------------------------------------------
// TASK-66 — read-side projection from the display event log.
//
// `turn` events project to the existing `Turn[]` wire shape (unchanged
// renderer path); host-only events (`permission-card` / `turn-error`) project
// to `displayEvents`, folded to their terminal state per (kind, foldKey).
// ---------------------------------------------------------------------------

/**
 * Project `turn` events to `Turn[]`. The stored event order IS the display
 * order (the runner emits role-tagged turn-ends in chronological order: a
 * `tool` turn before the `assistant` turn that produced it). turnIndex is the
 * 0-based position among rendered turns; turnId/createdAt come from the row.
 *
 * Each event's `payload` is `{ blocks: ContentBlock[] }` (see the persist
 * subscriber). `validateContentBlocks` re-validates against the canonical
 * schema on read — we never trust the JSONB column blindly (I5 / J2).
 */
function projectEventTurns(events: StoredEvent[]): Turn[] {
  const turns: Turn[] = [];
  let turnIndex = 0;
  for (const ev of events) {
    if (ev.kind !== 'turn' || ev.role === null) continue;
    const rawBlocks = (ev.payload as { blocks?: unknown }).blocks;
    let contentBlocks: ContentBlock[];
    try {
      contentBlocks = validateContentBlocks(rawBlocks ?? []);
    } catch {
      // A corrupt / hand-edited row must not crash redisplay; skip it.
      continue;
    }
    turns.push({
      turnId: `${turnIndex}`,
      turnIndex,
      role: ev.role,
      contentBlocks,
      createdAt: ev.createdAt,
    });
    turnIndex++;
  }
  return turns;
}

/**
 * Project host-only events to `displayEvents`, keeping the LAST event per
 * (kind, foldKey) so a later card-resolution frame folds an earlier card to
 * its terminal state on replay (append-only; a later append wins — no special
 * final-state bookkeeping). Order is by the terminal event's seq.
 */
function projectDisplayEvents(events: StoredEvent[]): ConversationDisplayEvent[] {
  // Map from "kind foldKey" → the latest event (events arrive in seq
  // order, so a later one overwrites an earlier one with the same key).
  const folded = new Map<string, ConversationDisplayEvent>();
  for (const ev of events) {
    if (ev.kind === 'turn') continue;
    const mapKey = `${ev.kind} ${ev.foldKey}`;
    folded.set(mapKey, {
      kind: ev.kind,
      key: ev.foldKey,
      payload: ev.payload,
      createdAt: ev.createdAt,
    });
  }
  return [...folded.values()];
}

/**
 * Restore user-facing `attachment` chips that runner translation strips out.
 *
 * Under runner-owned-sessions the jsonl persists the runner's MODEL-facing
 * translation of an attachment — a one-line text mention (`User attached '…'
 * at <path> (<mime>)`, see `formatAttachmentMention`) — not the original
 * `attachment` block. The chat UI renders an `attachment` block as a download
 * chip but a `text` block as raw text, so a reopened chat would otherwise show
 * the mention verbatim. We rebuild the block from the mention here, on read,
 * which also retroactively fixes chats stored before this landed (no
 * migration — the read derives the chip every time).
 *
 * Safety — the jsonl is untrusted (I5; the SDK is third-party and the model
 * output it transcribes is adversarial):
 *   - only `role: 'user'` turns are touched. The model authors assistant /
 *     tool lines, so it cannot inject a chip into a user turn.
 *   - the parsed path must sit under THIS conversation's own upload prefix
 *     (`.ax/uploads/<conversationId>/`), so a crafted mention can't aim the
 *     download chip at another conversation or an arbitrary file.
 *   - the rebuilt block must round-trip `AttachmentBlockSchema` (which rejects
 *     absolute paths, `..`, drive roots, NUL) or the original text is kept.
 *
 * `sizeBytes` is unrecoverable from the mention (and unused by the render
 * path), so it's set to 0. A single `text` block may carry the user's typed
 * prompt and the mention on separate lines (the SDK concatenates the runner's
 * separate text blocks), so we split per line, convert only matching lines,
 * and keep the rest as text — preserving order.
 *
 * TASK-21 — inlined-attachment blocks. For a small text/json/yaml/csv file the
 * runner doesn't emit the bare mention; it INLINES the file: the canonical
 * mention on the first line, a BLANK line, then the file content (see
 * `formatAttachmentInline`). On reload the whole thing would otherwise render
 * as raw text — both a missing download chip AND the runner's model-view
 * content (preamble + bytes) leaking into the user-visible transcript.
 *
 * Why per-block (and not per-array-element-of-the-whole-turn) is enough:
 * the runner emits the typed prompt and EACH attachment as SEPARATE elements
 * of the user message's content array (main.ts), and the host jsonl parser
 * (`parseJsonlToTurns` / `normalizeContent`) keeps each array element as its
 * OWN ContentBlock — it only ever coalesces *assistant* lines sharing a
 * `message.id`, never user content. So two attachments arrive as two separate
 * text blocks here, each handled independently; the only fusion we must
 * tolerate within ONE text block is the SDK joining a typed prompt with a
 * trailing line (the `prompt\nmention` case).
 *
 * We discriminate by the line *after* a converted mention:
 *   - mention followed by a BLANK line ⇒ inlined-attachment preamble. The
 *     blank + the file content after it is the runner's model-view text, which
 *     must NOT reach the user. `formatAttachmentInline` always emits exactly
 *     `mention\n\n<content>`, so the blank-line follow is the reliable signal.
 *     Because the content is OPAQUE (it can contain anything, including lines
 *     that themselves look like in-prefix mentions), we STOP processing this
 *     block entirely — everything from the blank line on is dropped. We do not
 *     try to re-parse a "next attachment" out of opaque bytes: that would let
 *     crafted file content terminate the suppression and leak the rest of the
 *     bytes (a real prompt-injection-flavored leak). A genuine second
 *     attachment lands in its own separate block, so dropping the tail here
 *     loses nothing real.
 *   - mention NOT followed by a blank line (it's the last line, or the next
 *     line is itself another mention / user text) ⇒ a bare mention. We convert
 *     just that line and keep scanning. This preserves the pre-TASK-21 per-line
 *     behavior for the bare-mention and `prompt\nmention` cases and reconstructs
 *     every chip when several bare mentions land in one block.
 */
function reconstructAttachmentBlocks(
  turns: Turn[],
  conversationId: string,
): Turn[] {
  const prefix = `.ax/uploads/${conversationId}/`;
  return turns.map((t) => {
    if (t.role !== 'user') return t;
    let changed = false;
    const rebuilt: ContentBlock[] = [];
    for (const block of t.contentBlocks) {
      if (block.type !== 'text') {
        rebuilt.push(block);
        continue;
      }
      const out: ContentBlock[] = [];
      let textBuf: string[] = [];
      const flushText = (): void => {
        const joined = textBuf.join('\n');
        if (joined.length > 0) out.push({ type: 'text', text: joined });
        textBuf = [];
      };
      const lines = block.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const mention = parseAttachmentMention(line);
        if (mention !== null && mention.path.startsWith(prefix)) {
          const parsed = AttachmentBlockSchema.safeParse({
            type: 'attachment',
            path: mention.path,
            displayName: mention.displayName,
            mediaType: mention.mediaType,
            sizeBytes: 0,
          });
          if (parsed.success) {
            flushText();
            out.push(parsed.data);
            changed = true;
            // Inlined-attachment shape: the mention is immediately followed by
            // a blank line (the `\n\n` separator `formatAttachmentInline`
            // always emits). The rest of the block is the runner's opaque
            // model-view file content — STOP here and drop it so it never
            // reaches the user. We deliberately do NOT scan back into the
            // content for a "next" mention: crafted bytes could spoof one and
            // resume surfacing the remaining content. A real second attachment
            // is its own block, so nothing is lost. A bare mention has no
            // blank-line follow, so we continue scanning this block.
            if (lines[i + 1] === '') break;
            continue;
          }
        }
        textBuf.push(line);
      }
      flushText();
      for (const b of out) rebuilt.push(b);
    }
    return changed ? { ...t, contentBlocks: rebuilt } : t;
  });
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

async function findOrCreateConversation(
  store: ConversationStore,
  bus: HookBus,
  ctx: AgentContext,
  input: FindOrCreateInput,
  cfg: ResolvedConversationsConfig,
): Promise<FindOrCreateOutput> {
  const hookName = 'conversations:find-or-create';
  // J1: ACL gate BEFORE any SELECT. Existence-leak prevention —
  // a foreign caller cannot probe for a routine's externalKey.
  const agent = await assertAgentReachable(
    bus, ctx, input.agentId, input.userId, hookName,
  );
  const title = validateTitle(input.fallback.title ?? null);
  const workspaceRef = validateWorkspaceRefForFreeze(agent.workspaceRef);
  // Phase D (2026-05-17): see createConversation for rationale.
  const hidden = validateOptionalBoolean(input.fallback.hidden, 'hidden') ?? false;
  const result = await store.findOrCreate({
    userId: input.userId,
    agentId: input.agentId,
    externalKey: input.externalKey,
    fallback: {
      userId: input.userId,
      agentId: input.agentId,
      title,
      runnerType: cfg.defaultRunnerType,
      workspaceRef,
      hidden,
    },
  });
  return result;
}

async function dropTurn(
  store: ConversationStore,
  bus: HookBus,
  ctx: AgentContext,
  input: DropTurnInput,
): Promise<DropTurnOutput> {
  const hookName = 'conversations:drop-turn';
  const conv = await store.getByIdNotDeleted(input.conversationId);
  if (conv === null || conv.userId !== input.userId) {
    throw new PluginError({
      code: 'not-found', plugin: PLUGIN_NAME, hookName,
      message: `conversation '${input.conversationId}' not found`,
    });
  }
  await assertAgentReachable(bus, ctx, conv.agentId, input.userId, hookName);

  if (conv.runnerSessionId === null) {
    return;
  }

  const workspaceCtx = makeAgentContext({
    reqId: ctx.reqId, sessionId: ctx.sessionId,
    userId: conv.userId, agentId: conv.agentId,
    logger: ctx.logger, workspace: ctx.workspace,
  });

  const list = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
    'workspace:list', workspaceCtx,
    { pathGlob: `.claude/projects/**/${conv.runnerSessionId}.jsonl` },
  );
  if (list.paths.length === 0) return;
  const path = list.paths[0]!;
  const read = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
    'workspace:read', workspaceCtx, { path },
  );
  if (!read.found) return;

  const rewritten = dropTurnFromJsonl(read.bytes, input.turnId);
  if (rewritten === null) return;

  // Use the version we just read from as the parent. Backends that don't
  // surface read.version fall back to null and get today's behavior
  // (parent-mismatch propagates; conversation hide is authoritative).
  await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
    'workspace:apply', workspaceCtx,
    {
      changes: [{ path, kind: 'put', content: rewritten }],
      parent: read.version ?? null,
      reason: `routines:drop-turn ${input.conversationId} ${input.turnId}`,
    },
  );
}

async function hideConversation(
  store: ConversationStore,
  bus: HookBus,
  ctx: AgentContext,
  input: HideInput,
): Promise<void> {
  const hookName = 'conversations:hide';
  const conv = await store.getByIdNotDeleted(input.conversationId);
  if (conv === null || conv.userId !== input.userId) {
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `conversation '${input.conversationId}' not found`,
    });
  }
  await assertAgentReachable(bus, ctx, conv.agentId, input.userId, hookName);
  const ok = await store.hide(input.conversationId);
  if (!ok) {
    // Row vanished between the existence check and the UPDATE (race with
    // a concurrent soft-delete). Surface as not-found rather than silently
    // succeeding.
    throw new PluginError({
      code: 'not-found',
      plugin: PLUGIN_NAME,
      hookName,
      message: `conversation '${input.conversationId}' not found`,
    });
  }
}

