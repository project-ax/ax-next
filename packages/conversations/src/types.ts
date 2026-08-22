import type { ContentBlock } from '@ax/ipc-protocol';
import { ContentBlockSchema } from '@ax/ipc-protocol';
import { z, type ZodType } from 'zod';

/**
 * @ax/conversations public types.
 *
 * Per Invariant I1, no field name in this file should ever encode a
 * particular backend (no `pg_`, `bucket_`, `sha`, `pod_name`, etc.). The
 * canonical alternate impl we keep in mind is `@ax/conversations-sqlite`
 * for single-replica dev.
 *
 * Hook payload shapes are the inter-plugin API. A future
 * `@ax/conversations-sqlite` would register the same `conversations:*`
 * service hooks with these exact shapes.
 */

// ---------------------------------------------------------------------------
// ContentBlock — single source of truth lives in @ax/ipc-protocol (I4).
//
// Both the IPC wire (event.turn-end) and our JSONB column carry the same
// shape, so the canonical zod schema lives in the one place both plugins
// already share. We re-export here so existing `@ax/conversations`
// consumers don't have to reach across packages for the type.
// ---------------------------------------------------------------------------
export { ContentBlockSchema };
export type { ContentBlock };

// ---------------------------------------------------------------------------
// Domain types — exposed on hook payloads.
// ---------------------------------------------------------------------------

export type TurnRole = 'user' | 'assistant' | 'tool';

/**
 * The channel that opened a conversation. See `Conversation.origin`.
 *
 * Two values because `packages/` contains exactly two producers of
 * conversations: channel-web and the routines tick. A third channel adds a
 * third value.
 */
export type ConversationOrigin = 'web' | 'routine';

/** The values a stored `origin` may take. Exported so the store can validate against one list. */
export const CONVERSATION_ORIGINS: readonly ConversationOrigin[] = ['web', 'routine'];

export interface Turn {
  turnId: string;
  turnIndex: number;
  role: TurnRole;
  /**
   * Content blocks. Strongly typed at the package boundary; the store still
   * runtime-parses against `ContentBlockSchema` on read AND write so we
   * don't trust the DB blindly (Invariant I5 — capabilities-minimized,
   * untrusted-content-stays-untrusted).
   */
  contentBlocks: ContentBlock[];
  /** ISO-8601 string. */
  createdAt: string;
}

export interface Conversation {
  conversationId: string;
  userId: string;
  /** Frozen at create (Invariant I10). Never updated. */
  agentId: string;
  /** Nullable; MVP doesn't auto-generate. */
  title: string | null;
  /** Nullable; cleared in Task 14. */
  activeSessionId: string | null;
  /** Nullable; the in-flight reqId, if any (Invariant J7). */
  activeReqId: string | null;
  /**
   * Which runner LAST served this conversation — equivalently, whose format
   * the stored transcript is in. Written on every `conversations:bind-session`.
   *
   * NOT frozen, despite what this field's original Phase-B contract said. It
   * used to be frozen at create from a host-wide
   * `ConversationsConfig.defaultRunnerType`, which was correct while one host
   * meant one runner. PR #399 made the runner a per-AGENT choice, and an
   * agent's runner can be switched at any time; that switch demotes the next
   * turn to a fresh session and REPLACES the stored transcript with the new
   * runner's format. So a value frozen at create is wrong in precisely the
   * case that would make anyone look at it.
   *
   * `null` = no runner has served this conversation yet (freshly created, or
   * a pre-Phase-B row).
   */
  runnerType: string | null;
  /**
   * Phase B. The runner's native session id (e.g. SDK sessionId for
   * `@ax/agent-claude-sdk-runner`). Bound on the first turn via
   * `conversations:store-runner-session`. Null until then.
   */
  runnerSessionId: string | null;
  /**
   * Phase B. Frozen copy of `agent.workspaceRef` at conversation create.
   * Mirrors I10. Nullable when the agent had no workspaceRef OR the row
   * predates Phase B.
   */
  workspaceRef: string | null;
  /**
   * Phase B. ISO-8601 string. Bumped by the `chat:turn-end` subscriber
   * on every non-heartbeat turn. Opaque to correctness; sidebar ordering
   * only. Null for pre-Phase-B rows or rows that haven't seen a turn.
   */
  lastActivityAt: string | null;
  /** Phase A (2026-05-14). True for routine fire-log conversations that are not user-visible. */
  hidden: boolean;
  /**
   * AW-6 (2026-08-21). Which CHANNEL opened this conversation.
   *
   * It exists so a held tool call can be classified as ATTENDED (a person is
   * watching and can answer while the agent is still warm) or UNATTENDED (the
   * turn will end before anyone sees it). That is a property of the channel,
   * not of the turn — `ctx.source === 'routine'` answers "was this a scheduled
   * fire", which is a different question that happens to have the same answer
   * today.
   *
   * `'web'` on every row that predates the column and on every caller that
   * does not pass one: an existing conversation is by definition one a human
   * opened. Adding Slack later adds a VALUE here, not a schema change — and
   * deliberately not an `attendance` field, because attendance is derived and
   * a headless deployment would want "always unattended" regardless of channel.
   */
  origin: ConversationOrigin;
  /**
   * Phase A (routines foundation, 2026-05-14). Stable per-(user, agent,
   * key) lookup handle for `conversations:find-or-create`. The routines
   * plugin passes external_key = routine_path for `conversation: shared`
   * routines; non-routine callers leave it null. Indexed via a partial
   * unique index — see migrations.ts.
   */
  externalKey: string | null;
  /** ISO-8601 string. */
  createdAt: string;
  /** ISO-8601 string. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Service hook payloads.
//
// Every hook is gated by a `agents:resolve(agentId, userId)` call BEFORE
// touching the store (Invariant J1). On `forbidden` / `not-found` from
// `agents:resolve` we propagate the matching `PluginError` code.
// ---------------------------------------------------------------------------

export interface CreateInput {
  userId: string;
  agentId: string;
  /** Optional title — MVP leaves it null. */
  title?: string | null;
  /**
   * Phase D (2026-05-17). Routine per-fire conversations create with
   * `hidden: true` so they don't appear in the chat sidebar. Defaults
   * to `false`.
   */
  hidden?: boolean;
  /**
   * AW-6 (2026-08-21). Which channel is opening this. Defaults to `'web'` —
   * the overwhelming majority of conversations, and the safe default for a
   * caller that has not been taught about the field: `'web'` means attended,
   * and a misclassified-as-attended decision is the failure mode this design
   * is willing to have (the agent parks, the idle floor expires, the row stays
   * in Today). The opposite mistake strands a decision waiting for a warm
   * agent, which is why the ATTENDANCE read fails the other way.
   */
  origin?: ConversationOrigin;
}
export type CreateOutput = Conversation;

export interface GetInput {
  conversationId: string;
  userId: string;
  /**
   * Reserved for Task 21 thinking-block UI toggle (Invariant J4). The
   * store unconditionally returns whatever blocks were appended; this
   * flag is forwarded to consumers but does NOT filter at the hook
   * boundary.
   */
  includeThinking?: boolean;
}
export interface GetOutput {
  conversation: Conversation;
  turns: Turn[];
  /**
   * TASK-66 (out-of-git Part B / B1). Host-generated display events the SDK
   * jsonl never sees — approval/permission cards and surfaced provider/sandbox
   * errors. Empty for legacy conversations whose redisplay still comes from
   * the jsonl (the event log had no rows). These are the redisplay SoT for
   * host-only UI: a live chat folds the same `chat:permission-request` /
   * `chat:turn-error` frames; replaying the persisted ones reproduces them.
   *
   * Each event's payload is the LAST persisted state for its `key` — a card
   * later approved/resolved folds to its terminal state on replay with no
   * special final-state bookkeeping (a later append wins).
   */
  displayEvents: ConversationDisplayEvent[];
}

// ---------------------------------------------------------------------------
// TASK-66 — display event log (out-of-git Part B, B1).
//
// The redisplay source of truth: the exact ordered stream of display frames
// the host already emits to the browser over SSE, persisted append-only and
// keyed (conversationId, seq). `turn` frames carry the model/tool content
// (the folded terminal `ContentBlock[]` the runner sends at the result
// boundary — the same content the live stream-chunk deltas fold into);
// `permission-card` / `turn-error` are HOST-only display events absent from
// the SDK jsonl.
//
// Storage-agnostic (I1): `kind` is a display-semantic enum, `seq` is a
// per-conversation monotonic int (minted by the store, not a git oid /
// commit), `payload` is the opaque UI frame body. No backend vocabulary.
// ---------------------------------------------------------------------------

/** Display-semantic event kinds persisted in the redisplay log. */
export type ConversationEventKind = 'turn' | 'permission-card' | 'turn-error';

/**
 * One host-only display event (a `permission-card` or a `turn-error`),
 * projected from the redisplay log for `conversations:get`. `turn` events are
 * projected to `Turn[]` instead (the existing renderer path); this type carries
 * only the events that have no `ContentBlock` representation.
 *
 * `payload` is the opaque UI frame body (untrusted host/model output — the
 * renderer sanitizes, per the unchanged J2 hardening). It is NOT interpreted
 * by the store or the read projection beyond taking the terminal state per
 * `key`.
 */
export interface ConversationDisplayEvent {
  kind: Exclude<ConversationEventKind, 'turn'>;
  /**
   * Stable per-card / per-turn key used to fold a later resolution frame onto
   * an earlier card (the read keeps the LAST event per key). For a
   * `permission-card` this is the card's identity (e.g. its `skillId` or
   * `host`); for a `turn-error` it's the originating `reqId`. Opaque string.
   */
  key: string;
  /** The opaque display frame body. Re-emitted to the renderer verbatim. */
  payload: Record<string, unknown>;
  /** ISO-8601 string — when this event was persisted. */
  createdAt: string;
}

/**
 * Input to `conversations:append-event` — the host-internal persist hook fed
 * by `@ax/conversations`' own `chat:turn-end` / `chat:turn-error` /
 * `chat:permission-request` subscribers. Host-internal (the untrusted runner
 * cannot reach it over IPC — it only reaches the `event.*` IPC events, which
 * the host's subscribers translate). The `seq` is minted by the store, never
 * supplied by the caller. ACL: ctx-scoped (no agents:resolve round-trip —
 * same posture as bind-session; the orchestrator already gated the user).
 */
export interface AppendEventInput {
  conversationId: string;
  kind: ConversationEventKind;
  /** Turn role — present only for `kind: 'turn'`. */
  role?: TurnRole;
  /**
   * Fold key (see ConversationDisplayEvent.key). For `turn` events the store
   * does not fold on it (every turn is its own row); for host-only events the
   * read keeps the last event per key. Optional — defaults to the empty string
   * (single-slot fold) when absent.
   */
  key?: string;
  /** The opaque display frame body. */
  payload: Record<string, unknown>;
}
export type AppendEventOutput = void;

// ---------------------------------------------------------------------------
// TASK-67 (out-of-git Part B / B2) — resume transcript hooks.
//
// Host-internal, ctx-scoped (same posture as append-event): the untrusted
// runner reaches these ONLY via the host's session.* IPC handlers, which stamp
// `ctx` from the bearer token — a runner can't aim a transcript at a foreign
// conversation. The lines are OPAQUE verbatim SDK jsonl bytes: stored as-is,
// never executed/interpreted, only re-emitted to the SDK on resume. All field
// names are storage-neutral (I1): no git/jsonl/sqlite vocabulary.
// ---------------------------------------------------------------------------

/**
 * Append the delta of new jsonl lines. `fromSeq` is the seq the runner believes
 * the store is at; `prefixHash` is sha256 of the verbatim bytes it has already
 * shipped (`[0..sentOffset)`). The host appends ONLY when both match its state
 * (append path); otherwise the SDK rewrote earlier bytes → `resync-required`
 * and the runner re-ships the whole file via `conversations:replace-transcript`.
 */
export interface AppendTranscriptInput {
  conversationId: string;
  fromSeq: number;
  prefixHash: string;
  /** New jsonl lines, in order, verbatim (no trailing `\n`). */
  lines: string[];
}
export interface AppendTranscriptOutput {
  outcome: 'appended' | 'resync-required';
  /** The store's max seq after the call (unchanged on resync-required). */
  maxSeq: number;
}

/** Resync path: replace the whole transcript with `lines`. Returns the new max seq. */
export interface ReplaceTranscriptInput {
  conversationId: string;
  lines: string[];
}
export interface ReplaceTranscriptOutput {
  maxSeq: number;
}

/** Resume read: the reconstructed jsonl bytes + the max seq. */
export interface GetTranscriptInput {
  conversationId: string;
}
export interface GetTranscriptOutput {
  /** Rows ORDER BY seq joined with `\n`; '' when there is no transcript. */
  bytes: string;
  maxSeq: number;
}

/**
 * Runtime `returns` contracts (ARCH-6). IPC-reachable — the session.* IPC
 * handlers forward through these hooks. Each is a per-registration shape
 * assertion paired with the drift-guard test in `return-schemas.test.ts`.
 */
export const AppendTranscriptOutputSchema = z.object({
  outcome: z.enum(['appended', 'resync-required']),
  maxSeq: z.number(),
}) as unknown as ZodType<AppendTranscriptOutput>;

export const ReplaceTranscriptOutputSchema = z.object({
  maxSeq: z.number(),
}) as unknown as ZodType<ReplaceTranscriptOutput>;

export const GetTranscriptOutputSchema = z.object({
  bytes: z.string(),
  maxSeq: z.number(),
}) as unknown as ZodType<GetTranscriptOutput>;

export interface ListInput {
  userId: string;
  /**
   * Optional filter — when set, only conversations under this agent are
   * returned. When absent, list returns every conversation the user
   * owns; ACL is implicit via `user_id` filter.
   */
  agentId?: string;
}
export type ListOutput = Conversation[];

export interface DeleteInput {
  conversationId: string;
  userId: string;
}
/** Soft delete (Invariant J5). No payload — caller sees void on success. */
export type DeleteOutput = void;

/**
 * Lookup a conversation by its in-flight `active_req_id`. Used by
 * channel-web's SSE handler (Week 10–12 Task 7, Invariant J9) so a
 * browser-supplied `:reqId` URL param can be authorized — callers MUST
 * own the row (filtered by `user_id`), and tombstones (`deleted_at IS
 * NULL`) are excluded.
 *
 * Throws `PluginError({ code: 'not-found' })` when no matching row
 * exists. The route layer maps that to 404 (NOT 403) — guessing a
 * foreign reqId leaks no signal beyond "no such stream."
 *
 * NOTE: this hook does NOT call `agents:resolve` (J1 gate). The caller
 * is expected to chain a follow-up `agents:resolve(agentId, userId)`
 * with the returned `agentId`. Two reasons:
 *
 *   1. The user already passes the `user_id` filter, so existence-leak
 *      is already prevented at this hook's boundary.
 *   2. Some callers (audit, debug probes) want the lookup without
 *      forcing the gate; making it explicit at the call site keeps
 *      the policy decision visible.
 */
export interface GetByReqIdInput {
  reqId: string;
  userId: string;
}
export type GetByReqIdOutput = Conversation;

/**
 * Bind a sandbox session + in-flight reqId to a conversation row. Sets
 * BOTH `active_session_id` AND `active_req_id` atomically (J6: one
 * sandbox session per conversation at a time).
 *
 * Caller is the chat-orchestrator (Task 16) which has already validated
 * the user via `agents:resolve` at `agent:invoke` entry. This hook does NOT
 * call `agents:resolve`, but it DOES scope the row by `(conversation_id,
 * user_id)` derived from `ctx.userId` — a misbehaving caller cannot bind
 * a cross-tenant row.
 *
 * On a row not matching `(conversation_id, ctx.userId)` (and not
 * tombstoned), throws `PluginError({ code: 'not-found' })`.
 */
export interface BindSessionInput {
  conversationId: string;
  sessionId: string;
  reqId: string;
  /**
   * The runner about to serve this turn (`agents.runner` — `'aisdk'`,
   * `'claude-sdk'`). Recorded onto `runner_type` so the row says whose
   * format the stored transcript is in.
   *
   * A runner ID, deliberately: it is domain vocabulary the hook surface
   * already speaks (`agents.runner`), not storage or transport vocabulary,
   * so it carries no backend assumption for a subscriber to key off.
   *
   * Optional. Omitted leaves the column untouched — a caller that does not
   * know which runner is about to run must not overwrite a value that was
   * correct.
   */
  runnerType?: string;
}
export type BindSessionOutput = void;

/**
 * Clear `active_session_id` AND `active_req_id` on the conversation row.
 * Same `(conversation_id, ctx.userId)` scoping as `bind-session`. Throws
 * `PluginError({ code: 'not-found' })` on a row mismatch.
 *
 * The host-internal `session:terminate` subscriber takes a different
 * path (`store.clearBySessionId`) since it must clear ALL conversations
 * bound to a sessionId regardless of owner.
 */
export interface UnbindSessionInput {
  conversationId: string;
}
export type UnbindSessionOutput = void;

/**
 * Phase B (2026-04-29). Sidebar / runner-plugin metadata read. Returns
 * the projection only — `runner:read-transcript` ships separately
 * (Phase C) and returns the runner's native transcript bytes. Combining
 * both into one hook would re-create the lossy projection problem the
 * design solves (I6).
 *
 * ACL: same as `conversations:get` — `(conversation_id, user_id)`
 * pre-filter, then `agents:resolve(agent_id, user_id)`. A foreign row
 * looks identical to "no such row" from the caller's perspective.
 */
export interface GetMetadataInput {
  conversationId: string;
  userId: string;
}
export interface GetMetadataOutput {
  conversationId: string;
  userId: string;
  agentId: string;
  runnerType: string | null;
  runnerSessionId: string | null;
  workspaceRef: string | null;
  title: string | null;
  /** ISO-8601, or null if no turns yet / pre-Phase-B row. */
  lastActivityAt: string | null;
  /** ISO-8601. */
  createdAt: string;
  /**
   * AW-6 (2026-08-21). The channel that opened this conversation. Present here
   * as well as on `conversations:get` because the ATTENDANCE read rides the
   * `tool:pre-call` 10 s ceiling, and `conversations:get` projects the whole
   * display-event log on its way to the same field. This hook is the single
   * indexed row read that question deserves.
   */
  origin: ConversationOrigin;
  /**
   * AW-6 (2026-08-21). The live session serving this conversation, or null when
   * there is none. Already on `Conversation`; surfaced here so the delivery of
   * a resolved decision to a still-warm agent is the SAME single row read as
   * the attendance lookup, rather than a second, heavier one.
   *
   * Storage-agnostic: an opaque session handle, not a pod name or a socket path.
   */
  activeSessionId: string | null;
}

// ---------------------------------------------------------------------------
// Runtime `returns` contract for `conversations:get-metadata` (ARCH-6).
//
// This hook is IPC-reachable — the host's `session.get-config` IPC handler
// (@ax/ipc-core) enriches its wire response with `runnerSessionId` via a
// `conversations:get-metadata` round-trip, so the runner reads this shape
// indirectly. Validating the handler's return at the bus boundary catches a
// malformed projection before it crosses to the runner.
//
// All fields are storage-agnostic (I1): the nullable strings are opaque ids
// / ISO-8601 timestamps, never backend identifiers. `runnerSessionId` is the
// opaque runner-native id (no `sdk_session_id` leak). Cast to
// `ZodType<GetMetadataOutput>` because `.nullable()` infers `| null` shapes
// the interface's exact `| null` fields won't directly absorb; the drift-guard
// test enforces field-for-field agreement.
// ---------------------------------------------------------------------------
export const GetMetadataOutputSchema = z.object({
  conversationId: z.string(),
  userId: z.string(),
  agentId: z.string(),
  runnerType: z.string().nullable(),
  runnerSessionId: z.string().nullable(),
  workspaceRef: z.string().nullable(),
  title: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  createdAt: z.string(),
  // AW-6. A `z.object` STRIPS keys it does not declare, so a field missing
  // here vanishes silently on the way out of the bus — the attendance read
  // would see `undefined` and fall to its unattended fail-safe for every
  // conversation, forever, with nothing failing loudly.
  origin: z.enum(['web', 'routine']),
  activeSessionId: z.string().nullable(),
}) as unknown as ZodType<GetMetadataOutput>;

/**
 * Phase B (2026-04-29). Bind the runner's native session id to a
 * conversation row exactly once. Called by the runner-plugin's host-side
 * IPC handler (Phase C) after the runner subprocess captures its
 * native session identifier on the first turn.
 *
 * Idempotent for re-binds to the same value (no-op success). Throws
 * `conflict` on a re-bind to a different value (I7) — that signals a
 * runner-side bug (two first-turn IPCs fired) AND prevents an orphan
 * native-session artifact on disk.
 *
 * ACL: `(conversation_id, ctx.userId)` UPDATE-scope only. No
 * `agents:resolve` round-trip — the host has already gated the user at
 * `agent:invoke` entry. A misbehaving caller cannot bind a cross-tenant
 * row because the UPDATE filter rejects mismatched user_id with the
 * uniform `not-found` shape.
 *
 * `runnerSessionId` is opaque at this layer — no field name leaks the
 * specific runner shape (no `sdk_session_id`, no `jsonl_path`). I9.
 */
export interface StoreRunnerSessionInput {
  conversationId: string;
  runnerSessionId: string;
}
export type StoreRunnerSessionOutput = void;

/**
 * Runtime `returns` contract for `conversations:store-runner-session` (ARCH-6).
 * IPC-reachable — the host's `conversation.store-runner-session` IPC handler
 * forwards the runner's first-turn session-id bind through this hook. The
 * handler resolves to `undefined` (void); `z.void()` accepts `undefined` and
 * rejects an accidental non-empty return (which would signal a handler bug).
 */
export const StoreRunnerSessionOutputSchema =
  z.void() as unknown as ZodType<StoreRunnerSessionOutput>;

/**
 * Phase F (2026-05-03). Update an existing conversation row's title
 * post-creation. Used by the auto-title pipeline (after the first
 * user/assistant exchange the conversation-titles plugin proposes a
 * short summary) and any future user-driven rename UI.
 *
 * ACL: same posture as `conversations:get` — `(conversation_id,
 * user_id)` pre-filter, then `agents:resolve(agent_id, user_id)`. A
 * foreign row looks identical to "no such row" from the caller's
 * perspective; the agents:resolve gate runs ONLY after the row's
 * existence + ownership are confirmed.
 *
 * Validation: title must be 1–256 chars (matches the column's CHECK
 * + the existing `validateTitle()` shape). Empty / null / oversized
 * titles throw `PluginError({ code: 'invalid-payload' })`.
 *
 * `ifNull = true` makes the UPDATE atomic on `title IS NULL` — if a
 * concurrent caller (or a user-driven rename) has already set a
 * title, this hook is a no-op and returns `{ updated: false }`. This
 * is the auto-title pipeline's safety: a slow LLM-derived title can
 * never clobber a user's rename.
 *
 * `ifNull = false` (default) overwrites unconditionally. The same
 * `(conversation_id, user_id, deleted_at IS NULL)` filter still
 * applies — soft-deleted rows are not reachable.
 */
export interface SetTitleInput {
  conversationId: string;
  userId: string;
  title: string;
  /**
   * When true, only writes if the existing title is NULL (atomic
   * single-statement compare-and-set). Defaults to false.
   */
  ifNull?: boolean;
}
export interface SetTitleOutput {
  /**
   * True iff a row was updated. False when:
   *   - `ifNull=true` and the row already had a title, OR
   *   - the row didn't match the (id, userId, alive) filter (the
   *     plugin layer turns the latter into `not-found` before we
   *     reach the store, so in practice `updated=false` only
   *     surfaces from the ifNull=true / already-titled case).
   */
  updated: boolean;
}

/**
 * Phase A (routines foundation, 2026-05-14). Mark a conversation hidden
 * so it disappears from list-style queries but remains readable by id.
 * Used by the routines plugin to suppress silenced routine fires without
 * losing the fire-log row. Idempotent — hiding an already-hidden row is
 * a no-op success. ACL: same posture as `conversations:get` (user_id
 * pre-filter, then agents:resolve).
 */
export interface HideInput {
  conversationId: string;
  userId: string;
}
export type HideOutput = void;

/**
 * Phase A (routines foundation, 2026-05-14). Drop a single turn from a
 * conversation's runner-native transcript. Used by the routines plugin's
 * silence-token logic in Phase B to remove the agent's HEARTBEAT_OK
 * reply before it lands in the user-visible conversation.
 *
 * Phase A SHIPS THE HOOK SURFACE ONLY — calling it throws
 * `PluginError({ code: 'not-implemented' })`. The runner-native jsonl
 * rewrite path lands in Phase B alongside its first caller; the
 * half-wired window for this one hook stays OPEN through Phase B.
 *
 * ACL posture (when Phase B implements it): same as `conversations:get`
 * — user_id pre-filter, then agents:resolve. `userId` is included in
 * the input shape now (rather than the simpler `{ conversationId,
 * turnId }`) because the eventual Phase B impl needs it for the ACL
 * gate (J1). Locking the type now avoids reshaping it later (which
 * would be a wire break for any caller landed in between).
 */
export interface DropTurnInput {
  conversationId: string;
  userId: string;
  turnId: string;
}
export type DropTurnOutput = void;

/**
 * Phase A (routines foundation, 2026-05-14). Find a conversation by
 * stable `(userId, agentId, externalKey)` or create one if none exists.
 * Used by the routines plugin for `conversation: shared` routines —
 * every fire of the same routine reuses the same conversation row.
 *
 * Race-safe under concurrent callers via the partial unique index
 * (user_id, agent_id, external_key) WHERE external_key IS NOT NULL
 * AND deleted_at IS NULL.
 *
 * ACL posture: caller passes `userId` AND `agentId` directly. The hook
 * runs `agents:resolve(agentId, userId)` (J1 gate) BEFORE the SELECT —
 * a foreign caller can't probe for a routine's externalKey.
 *
 * `fallback` carries the fields used when creating a new row. Reuses
 * `CreateInput`'s optional shape, minus `externalKey` (which is the
 * lookup key, supplied at the top level).
 */
export interface FindOrCreateInput {
  userId: string;
  agentId: string;
  externalKey: string;
  fallback: {
    title?: string | null;
    /** Phase D: see CreateInput.hidden. */
    hidden?: boolean;
    /** AW-6: see CreateInput.origin. */
    origin?: ConversationOrigin;
  };
}
export interface FindOrCreateOutput {
  conversation: Conversation;
  created: boolean;
}

/**
 * Emitted on the in-process bus by the title write path
 * (`conversations:set-title`) whenever a title actually changes. Consumed
 * by channel-web's `/api/chat/title-events` SSE to push live titles to the
 * sidebar. Domain-level only — no storage/transport fields (invariant #1).
 * Subscribers in other plugins duck-type this shape (no cross-plugin import).
 */
export interface TitleUpdatedEvent {
  conversationId: string;
  userId: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

/**
 * Plugin config knobs. Postgres + kysely come from the
 * @ax/database-postgres service via the bus, not from this config.
 */
// `ConversationsConfig` is gone. It held exactly one knob, `defaultRunnerType`
// — a host-wide constant frozen onto every conversation's `runner_type` at
// create, from the era when one host meant one runner (design D5). PR #399 made
// the runner a per-AGENT choice, so the honest value comes from the agent:
// seeded at create, refreshed on every `conversations:bind-session`. A host-wide
// default could only ever disagree with that, so the knob is deleted rather than
// deprecated — `createConversationsPlugin()` now takes no arguments.
