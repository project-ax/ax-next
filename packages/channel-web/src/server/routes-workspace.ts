/**
 * GET  /api/workspace/state            — the agent roster
 * GET  /api/workspace/agents/:agentId  — one agent's detail panel
 *        ?conversationId=<id> reads that conversation instead of the current
 *        one (the rail's read-only past-conversation view)
 * GET  /api/workspace/activity         — THE event feed (one collection)
 *        ?agentId=<id> scopes it to one agent; ?before=<ISO>&limit=<n> page it
 * GET  /api/workspace/agents/:agentId/files
 *                                      — what the agent has written
 * GET  /api/workspace/agents/:agentId/files/*
 *                                      — one of those files, as text
 * GET  /api/workspace/agents/:agentId/download/files/*
 * GET  /api/workspace/agents/:agentId/download/user-files/*
 *                                      — one of those files, as BYTES
 * PUT  /api/workspace/agents/:agentId/memory/rules
 *                                      — save the human-owned memory tier
 * GET  /api/workspace/decisions        — THE Today queue (one collection)
 * POST /api/workspace/decisions/:decisionId/approve
 * POST /api/workspace/decisions/:decisionId/dismiss
 * POST /api/workspace/decisions/:decisionId/undo
 * GET  /api/workspace/grants           — pending capability grants for the
 *                                        caller (TASK-373)
 * POST /api/workspace/route            — "which agent should hear this?"
 *
 * The agent-centric workspace surface (TASK-230 / plan task AW-9). This is the
 * BFF that turns the host's existing reads — the agent roster, the conversation
 * list, the stored turns — into the shapes `src/lib/workspace-types.ts`
 * declares.
 *
 * The governing rule here is: every byte we return is DERIVED from something
 * that already exists. Where a panel has no producer yet, the route returns an
 * honest empty array and the UI renders its own empty state. It does NOT return
 * a plausible-looking fixture, and it does not return a zero — a zero is a
 * claim, and we are not counting anything yet. Concretely:
 *
 *   - `permissions`            — empty until the policy rail is real (AW-14).
 *   - `now` / `counter` / `startedAt` — null; nothing reports them yet (AW-8).
 *   - there is no `stats` field at all.
 *
 * Agent `state` is likewise derived, never guessed: `working` iff the agent
 * has a live activity record (`agent-activity:get` — a turn started and has
 * not ended), otherwise `resting`. Without that producer everything reads
 * `resting`, because "we don't know" must never render as "it's busy". It
 * used to probe sandbox liveness instead, which answered a different question
 * and is why a warm idle agent read "Working" — see `deriveState`.
 *
 * Security posture (matches routes-connections.ts):
 *   - identity is ALWAYS the authenticated user (auth:require-user → 401).
 *     `userId` is never read from the body, query, or params.
 *   - every read of an agent's WORKSPACE or MEMORY is gated by
 *     `agents:resolve`, STRICTLY BEFORE the read; any PluginError → 404 (not
 *     403 — we don't tell a foreign caller whether an id exists). Concretely,
 *     that is every `/api/workspace/agents/:agentId…` route — the detail
 *     panel, `files`, `files/*`, `user-files`, `user-files/*`,
 *     `download/files/*`, `download/user-files/*`, `rail`, `grants/revoke`
 *     and `memory/rules` — plus the agent-scoped branch of `/activity`. The
 *     order on each is: `authOr401` → empty-id 400 → `resolveAgentOr404` →
 *     (path validation) → read. Nothing reads before the resolve.
 *
 *     ⚠ Since TASK-257 (2026-09-17) this gate is the ONLY barrier on those
 *     routes. The workspace tier used to hash the CALLER's userId into the
 *     repo id, so a non-owner who slipped past the ACL still landed in their
 *     own empty shard; the partition is now `agentId` alone, because shared
 *     team files and per-caller isolation are contradictory requirements. Do
 *     not bypass this gate, do not make it best-effort, and do not move it
 *     after a read. `routes-workspace-team-agent.test.ts` pins it from the
 *     outside: a caller `agents:resolve` rejects gets a 404 AND the read hook
 *     records zero calls.
 *
 *     Everything NOT in that list is gated DIFFERENTLY on purpose, and none
 *     of it reads workspace files or memory. `/state`, `/route` and the
 *     UNSCOPED branch of `/activity` fan out over `agents:list-for-user` —
 *     there the roster IS the ACL, and it is a different predicate
 *     (server-derived teamIds vs. a live `teams:is-member` call), one that is
 *     strictly narrower in practice. `/grants` filters the in-memory
 *     card-owner map on the authenticated userId. The `/decisions` LIST route
 *     reads the caller's OWN decisions first and then drops rows whose agent
 *     it cannot reach, so a resolve failure there is a filtered row rather
 *     than a 404 — note that is the list route only; `/decisions/:decisionId`
 *     and its approve/dismiss/undo siblings DO 404, through
 *     `loadOwnedDecision`.
 *
 *     Spelled out because the blanket claim this comment used to make —
 *     "every per-agent read is gated by `agents:resolve`" — was not true, and
 *     a security note nobody can check against the code is worse than none.
 *   - transcript text is UNTRUSTED model output. It rides as a plain string and
 *     React renders it as text; we never build markup from it here.
 *   - I2 — no cross-plugin imports. Every hook is a duck-typed `bus.call`, and
 *     the request/response shapes come from routes-chat.js.
 *
 * The activity feed is one collection with ONE producer — the route above, not
 * a field on `/state`. Two producers over one collection is invariant 4
 * violated in the BFF, and a sub-array of a state blob cannot be paginated.
 * `/state`'s per-agent liveness probe is already an N+1; the feed's fan-out
 * lives on its own route rather than making that worse.
 *
 * It has one producer and TWO SOURCES, which is a different thing: routine
 * fires (`routines:recent-fires-for-agent`) and decision receipts
 * (`decisions:recent-receipts-for-agent`), merged here by instant. A reader
 * does not care whether their agent did something on a schedule or because
 * they said yes to it, so both belong in one time-ordered list. Both sources
 * are asked the same paged question so the merge cannot lose a row at the
 * seam, and neither owns the collection — this route does.
 *
 * The Today queue is the same story and the same rule: `GET
 * /api/workspace/decisions` is its one producer. The in-thread approval card
 * on `GET /api/workspace/agents/:agentId` is a POINTER — a `decisionId` and
 * nothing else — so the row a person reads in the thread is the row the queue
 * shows rather than a second copy of it that can disagree.
 *
 * Every route here always mounts. The workspace is the only web interface,
 * so there is no flag to hide it behind (TASK-360 retired `agentWorkspace`).
 * Each handler is authenticated and owner-scoped on its own.
 */
import { AttachmentBlockSchema } from '@ax/ipc-protocol';
import {
  PluginError,
  isRejection,
  makeAgentContext,
  makeReqId,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import { stripSurfaceRewritersFromDocument } from '@ax/core/surface-text';
import type {
  ActivityEvent,
  AgentAbilities,
  AgentAbilitiesRead,
  AgentAbility,
  AgentConnectorHealth,
  AgentConnectorRemoved,
  AgentConnectorRetried,
  AgentConnectorRow,
  AgentConnectorSource,
  AgentConnectorTool,
  AgentConnectorToolsRead,
  AgentConnectorsRead,
  AgentToolVerdict,
  AgentToolVerdictSaved,
  AgentMemoryRead,
  FactMemoryPage,
  AgentRailData,
  AgentRunState,
  CapabilityEffect,
  CapabilityProvenance,
  CapabilityVerdict,
  Decision,
  DecisionStatus,
  ExecutionPath,
  GrantRef,
  GrantRow,
  PastConversation,
  PermissionRow,
  RailActivity,
  ThreadAttachment,
  ThreadMessage,
  WorkspaceAgent,
  WorkspaceReadStatus,
} from '../lib/workspace-types.js';
import { AGENT_ABILITIES, isOpenDecision } from '../lib/workspace-types.js';
import { byVerdict } from '../lib/permission-frames.js';
import { fenceLine } from '../lib/fence-line.js';
import { KICKOFF_TEXT } from '../lib/bootstrap-kickoff.js';
// The sentence a full storage limit answers a Rules Save with (TASK-719), and
// the one test for "this refusal is the storage limit". The sentence is shared
// with the browser's fallback so there is one copy of the words.
import { STORAGE_FULL_RULES } from '../lib/storage-full-copy.js';
import { isStorageFullRefusal } from './storage-full-refusal.js';
// The renderer's own ceiling for the untrusted `detail` line. Imported rather
// than restated so the host and the browser cannot drift about where that
// sentence ends (invariant 4) — the module is pure constants and one pure
// function, with no DOM or React in it.
import { MAX_DETAIL_CHARS } from '../lib/turn-error-labels.js';
// TASK-761 — the attach route's "signed in / keyed first" gate derives the
// vault refs a connector spends with the SAME function the browser's connect
// flow writes them with (pure, no DOM), so the two cannot disagree about
// which row "has a key" means.
import { deriveCredentialPlan, type Connector } from '../lib/connectors.js';
// The closed-code check and the one builder of a save-refused row's id
// (TASK-731), shared with the browser, which matches its live copy against
// that same id.
import { asSaveRefusedCode, saveRefusedRowId } from '../lib/save-refused.js';
import {
  CONNECTOR_TOOL_NAMESPACE_RE,
  connectorNamesFromRows,
  connectorNamesToRows,
  type ConnectorNames,
  type ConnectorToolsRow,
} from '../lib/connector-tool-label.js';
import {
  settleHolds,
  shapeSteps,
  stepDetail,
  type LiveHolds,
  type WorkspaceStepStatus,
  type WorkspaceToolCall,
} from '../lib/workspace-steps.js';
// Type-only: the pending-card store is this plugin's own module (same package,
// not a cross-plugin import), and the route reads it rather than re-deriving
// what is pending from anything else.
import type { ChunkBuffer } from './chunk-buffer.js';
// The durable "Not now" marker (TASK-444). Same package, this plugin's own
// module: the route owns the wire shape and this owns the storage shape, so
// the key spelling never leaks onto the wire (invariant 1).
import {
  grantSubjectId,
  recordGrantDecline,
  withoutDeclinedGrants,
  type DeclinableGrantKind,
} from './grant-declines.js';
import type { PermissionRequest } from './types.js';
import { listTeamIdsForUser, type RouteRequest, type RouteResponse } from './routes-chat.js';
import { sanitizeContentDispositionFilename } from './content-disposition.js';
import { workspaceFilePath } from './safe-path.js';
import { attachMemoryUsed, parseRecallReceiptsReply } from './memory-used.js';
// Type-only: the `sandbox:read-user-files` hook-bus contract. The DURABLE
// user-files tier is read through this hook rather than through `workspace:*`,
// which is the git-backed governed tier. Types only, so no runtime coupling
// (invariant I2) — the bus is still the API.
import type {
  ReadUserFilesInput,
  ReadUserFilesOutput,
} from '@ax/sandbox-mount-protocol';

// --- duck-typed hook payloads (I2 — no cross-plugin imports) --------------

interface AuthRequireUserInput {
  req: RouteRequest;
}
interface AuthRequireUserOutput {
  user: { id: string; isAdmin: boolean };
}

interface AgentsResolveInput {
  agentId: string;
  userId: string;
}
/**
 * The agent record as `agents:resolve` hands it back.
 *
 * Everything past `displayName` is OPTIONAL here on purpose. `@ax/agents`
 * always sets them, but this is a duck-typed read of somebody else's hook and
 * the rail must degrade rather than crash if an alternate impl carries less.
 * Where one is missing the rail says its reach is unknown — never that it is
 * empty.
 */
interface ResolvedAgent {
  id: string;
  displayName: string;
  /** The agent's tool allow-list. EMPTY (with `mcpConfigIds`) is the wildcard. */
  allowedTools?: string[];
  /** The MCP server ids this agent may reach. Empty + empty = unrestricted. */
  mcpConfigIds?: string[];
  skillAttachments?: Array<{ skillId?: string }>;
  connectorAttachments?: string[];
  /** TASK-739 — connectors removed from THIS agent (defaults / legacy-owned). */
  connectorExclusions?: string[];
  visibility?: 'personal' | 'team';
  /** Which runner the host spawns for this agent (an id, e.g. `claude-sdk`). */
  runner?: string;
}
interface AgentsResolveOutput {
  agent: ResolvedAgent;
}

// --- the rail's reads (design §4.2/§4.3/§4.4) ------------------------------

/** @ax/tool-policy's `CapabilityRow`, duck-typed (I2). */
interface PolicyCapabilityRow {
  verdict: CapabilityVerdict;
  capability: string;
  source: string;
  provenance: CapabilityProvenance;
  described: boolean;
  /** The rule applies to some calls and not others. Absent is read as `false`. */
  conditional?: boolean;
  theirDescription?: string;
  mechanicalLabel?: string;
  /**
   * The hook's unvalidated answer for the rule's declared effects — a SET of
   * them since TASK-330, because a call can be more than one true thing at
   * once.
   *
   * Typed `unknown`, NOT `CapabilityEffect[]` and not even `string[]`,
   * because that is exactly what it is at this point: an unvalidated answer
   * from a duck-typed hook (I2), crossing a trust boundary. An impl can
   * answer a bare string, a number, an object, or an array with junk in it,
   * and TypeScript here is describing the wire, not policing it. Declaring
   * it as the union's array would assert the guarantee that
   * `toWirePermission`'s allow-list exists to provide — anything that
   * survives to `PermissionRow.effect` has to earn that narrower type by
   * passing through the check, not by being cast into it. `unknown` is what
   * forces that check to exist: nothing can read this field without first
   * establishing what it is.
   */
  effect?: unknown;
}
interface ToolPolicyListCapabilitiesInput {
  agentId: string;
  /** Tool names we have ESTABLISHED this agent cannot reach. See `readPermissions`. */
  outOfReach?: string[];
}
interface ToolPolicyListCapabilitiesOutput {
  rows: PolicyCapabilityRow[];
  /**
   * Tools the rule table describes for EVERY call — @ax/tool-policy's
   * `fullyDescribedTools`, whose doc carries the reasoning.
   *
   * `unknown` rather than `string[]` because this is a duck-typed hook and this
   * is the trust boundary. The registrar's `returns` schema declares it
   * required, so a conforming impl cannot omit it and a non-conforming one
   * fails the call outright; an impl registered with no schema at all could
   * still answer without it, and `catalogPermissions` checks rather than
   * assuming. Reading a missing field as "nothing is described" would put a
   * second, mechanical row beside every rule the table does describe.
   */
  fullyDescribedTools?: unknown;
  /**
   * Tools the rule table names that a HOST PLUGIN registers — @ax/tool-policy's
   * `hostProvidedTools`, whose doc carries the reasoning.
   *
   * `unknown` for the same reason as the field above, and checked in the same
   * place. The direction of the mistake is the opposite one: reading a missing
   * field as "no host-provided tools" would leave every row for an uninstalled
   * plugin's tool standing as a live ALLOW, which is TASK-416.
   */
  hostProvidedTools?: unknown;
}

/**
 * `tool-policy:evaluate`, asked here about the call no rule's predicate catches.
 * TWO facts come back that this surface renders: the verdict such a call gets,
 * and what it DOES in the world. The rail's verdict is the enforced verdict or
 * it is decoration, and since TASK-383 the same is true of its disclosure — both
 * now come from the thing that enforces them rather than from a local guess. See
 * `catalogPermissions` for what this hook is NOT asked — coverage — and why that
 * mattered (TASK-267).
 */
interface ToolPolicyEvaluateInput {
  call: { name: string; input: unknown };
  agentId: string;
}
interface ToolPolicyEvaluateOutput {
  verdict: CapabilityVerdict;
  ruleId: string | null;
  capability: string | null;
  irreversible: boolean;
  /**
   * The hook's unvalidated answer for what this call does in the world —
   * `EvaluateResult.effect`, a SET since TASK-383: the matched rule's declared
   * effects, or, when no rule matched, the union over every rule naming this
   * tool. The base-row builder in `catalogPermissions` is the only reader, and
   * its comment carries why a fall-through union is the honest thing to render
   * there rather than silence.
   *
   * Typed `unknown`, NOT `CapabilityEffect[]` and emphatically not `string` —
   * same reasoning as `PolicyCapabilityRow.effect` above, and the same scar
   * behind it. #574's regression was a duck-typed mirror on this very surface
   * typed `string`: `tsc` stayed green end to end while every array-valued
   * answer failed the `=== 'spends'` test, fell into the null branch, and the
   * rail quietly stopped disclosing that `web_extract` spends money. A mirror
   * that names a shape it cannot enforce buys nothing and costs exactly that.
   * Invariant 2 forbids importing the union from `@ax/tool-policy` anyway, so
   * the real choice is between an unchecked assertion and an honest `unknown`,
   * and only the honest one makes `toWireEffects` mandatory rather than
   * decorative: nothing can read this field without first establishing what it
   * is.
   *
   * OPTIONAL, unlike the plugin-side field it mirrors, which is required and
   * pinned by the registrar's `returns` schema. The `?` is not a hedge about
   * the shipped impl — it is this surface admitting an impl registered with no
   * schema at all can answer without the key, and `undefined` is a shape
   * `toWireEffects` already maps to `[]`. Deliberately NOT the
   * `fullyDescribedTools` treatment two interfaces up, which throws on a
   * missing field: there, reading silence as an answer adds a second row
   * asserting reach, so failing loud is the cheaper mistake; here, throwing
   * costs the whole row (see the `catch` below it), and a row that discloses no
   * effect still discloses more than a row that is not there.
   */
  effect?: unknown;
}

/** @ax/agent-activity's `AgentActivity`, duck-typed (I2). */
interface AgentActivityGetInput {
  agentId: string;
}
interface AgentActivityGetOutput {
  activity: {
    phrase?: unknown;
    counter?: unknown;
    startedAt?: unknown;
    source?: unknown;
    stale?: unknown;
  } | null;
}

/** The tool catalog. Only the three fields the rail reads. */
interface ToolCatalogEntry {
  name: string;
  description?: string;
  executesIn?: string;
}
interface ToolListOutput {
  tools: ToolCatalogEntry[];
}

/**
 * What the catalog half of "What it may do alone" produced.
 *
 * `outOfReach` is the interesting one: everything we have PROVED this agent
 * cannot call. It is not rendered — it is subtracted from the GLOBAL rule table
 * so a rule cannot assert reach this particular agent does not have.
 *
 * Two proofs feed it, and they answer different questions:
 *   - the tool is in the catalog and this agent's SCOPE excludes it;
 *   - the tool is host-provided and the catalog does not hold it AT ALL, so the
 *     plugin that would provide it never loaded (TASK-416).
 * Both need a catalog read that SUCCEEDED; neither is guessed when it did not.
 */
interface CatalogPermissions {
  rows: PermissionRow[];
  /**
   * A producer of this half THREW. Set inside each catch, never from a success
   * path — a success flag has to be set somewhere, and every place it is set is
   * a chance to set it for the wrong producer (TASK-264's bug, one function
   * over). The caller turns this into `status: 'failed'`, which is a different
   * answer from `incomplete`: "we could not look" versus "we looked and one
   * named thing is missing".
   */
  failed: boolean;
  incomplete: boolean;
  outOfReach: string[];
}

interface HostGrantsListInput {
  ownerUserId: string;
  agentId: string;
}
interface HostGrantsListOutput {
  hosts: Array<{ host: string; grantedAt: string }>;
}
interface HostGrantsRevokeInput {
  ownerUserId: string;
  agentId: string;
  host: string;
}
interface HostGrantsRevokeOutput {
  revoked: boolean;
}

/**
 * @ax/skills' approved-capability wall, per (owner, agent, ONE subject). There
 * is deliberately no "everything this agent was granted" hook — the store is
 * keyed by subject — so the rail enumerates the agent's own skills and
 * connections and asks once per subject.
 */
type ApprovedCapKind = 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';
interface ApprovedCapsListInput {
  ownerUserId: string;
  agentId: string;
  skillId?: string;
  connectorId?: string;
}
interface ApprovedCapsListOutput {
  capabilities: Array<{ kind: ApprovedCapKind; value: string }>;
}
interface ApprovedCapsRevokeInput {
  ownerUserId: string;
  agentId: string;
  kind: ApprovedCapKind;
  value: string;
  skillId?: string;
  connectorId?: string;
}
interface ApprovedCapsRevokeOutput {
  cleared: boolean;
}

interface AgentsListForUserInput {
  userId: string;
  teamIds?: string[];
}
interface AgentsListForUserOutput {
  agents: Array<{ id: string; displayName: string }>;
}

/**
 * `workspace:list` / `workspace:read`, duck-typed like every other hook on
 * this surface (I2 — no cross-plugin imports; the shapes are @ax/core's).
 *
 * Note what is NOT here: no `version`, no glob. This surface reads the CURRENT
 * snapshot and does its own filtering, because the exclusion rule below has to
 * be the SAME predicate for the listing and the read (invariant 4). Pushing it
 * into a `pathGlob` would mean two spellings of "what we serve" — one in a
 * glob string the backend interprets, one in the read path's guard — and the
 * two backends in this repo do not even agree on glob syntax.
 */
interface WorkspaceListInput {
  pathGlob?: string;
}
interface WorkspaceListOutput {
  paths: string[];
}
interface WorkspaceReadInput {
  path: string;
}
type WorkspaceReadResult = { found: true; bytes: Uint8Array } | { found: false };

/** The subset of @ax/conversations' `Conversation` this surface reads. */
interface ConversationRow {
  conversationId: string;
  userId: string;
  agentId: string;
  title: string | null;
  activeSessionId: string | null;
  lastActivityAt?: string | null;
  createdAt: string;
}
interface ConversationsListInput {
  userId: string;
  agentId?: string;
}
type ConversationsListOutput = ConversationRow[];

/**
 * Content blocks, narrowed to the things this surface reads.
 *
 * `text` is the bubble. The `tool_use` / `tool_result` fields behind it are the
 * step panel (TASK-352) — the persisted twins of the live `tool-use` /
 * `tool-result` SSE frames. The spellings do NOT line up field for field: the
 * transcript says `id` / `tool_use_id` / `is_error` where the wire says
 * `toolCallId` / `isError`, while `activityPhrase` and `held` are the same word
 * in both. Normalizing that difference away is what `turnToolCalls` below is
 * for, and why the shared shaper takes neither shape directly.
 *
 * WHAT IS NOT LISTED, on purpose: `thinking`. It is not narrowed away by
 * accident — nothing on this surface reads it, and `renderableText` below is
 * the filter that keeps it off the wire entirely.
 */
type TurnBlock = {
  type: string;
  text?: string;
  /** `tool_use`: the call id, the tool's wire name, the host-authored phrase. */
  id?: string;
  name?: string;
  activityPhrase?: string;
  /**
   * `tool_use`: the model-authored arguments. READ, never forwarded —
   * `stepDetail` reduces it to one fenced line so two calls to the same tool
   * can be told apart (TASK-419), and the blob itself goes no further than
   * `turnToolCalls`. The live path applies the same function to the same
   * field on its own frame.
   */
  input?: unknown;
  /** `tool_result`: which call it answers, and how that call ended. */
  tool_use_id?: string;
  is_error?: boolean;
  held?: boolean;
  content?: unknown;
  /**
   * `attachment`: a file the person sent, as `routes-chat.ts` writes it after
   * `attachments:commit` (TASK-424). `path` is workspace-relative and is what
   * `GET /api/files` takes; `displayName` is the person's own filename and is
   * therefore untrusted text, rendered as a React child and never as markup.
   */
  path?: string;
  displayName?: string;
  mediaType?: string;
  sizeBytes?: number;
};
interface TurnRow {
  turnId: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'tool';
  contentBlocks: TurnBlock[];
  createdAt: string;
}
interface ConversationsGetInput {
  conversationId: string;
  userId: string;
}
/**
 * One host-only display event off `conversations:get` (TASK-66's redisplay
 * log, folded to its terminal state per key by the projection).
 *
 * Narrowed to what this surface draws: `turn-error` (TASK-498) and
 * `save-refused` (TASK-731). `permission-card` rides the same array and is deliberately
 * NOT read here — the in-thread approval card is already built from the
 * decisions queue (`approvalMessages` below), and a second producer for one
 * row is exactly the drift invariant 4 forbids.
 *
 * `payload` is opaque and UNTRUSTED (it is the host's own frame body, which
 * for a turn-error carries model/provider vocabulary). Every field is checked
 * before it leaves here, never spread.
 */
interface DisplayEventRow {
  kind: 'permission-card' | 'turn-error' | 'save-refused';
  key: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
interface ConversationsGetOutput {
  conversation: ConversationRow;
  turns: TurnRow[];
  /**
   * Optional on THIS side on purpose: a `conversations:get` implementation
   * predating TASK-66 answers no such field at all, and absence must read as
   * "no host-only events to replay" rather than as a crash in the thread
   * build. (The shipped producer always sets it.)
   */
  displayEvents?: DisplayEventRow[];
}

/**
 * The subset of @ax/routines' `FireRow` this surface reads.
 *
 * `firedAt` is typed `Date | string` on purpose. In-process the hook hands back
 * real `Date` instances; anything that carries this over a wire hands back an
 * ISO string. Accepting both here is cheaper than making every future
 * transport pretend to be the in-process one.
 *
 * There is no `id` here, and there is none on the hook payload either any more
 * (TASK-251, then TASK-312 for the sibling `routines:recent-fires`): it was a
 * `BIGSERIAL`, storage vocabulary that had leaked into the payload, and neither
 * fires hook declares the row with it now. Nothing on this surface is keyed off
 * a row id — the pagination cursor is the `firedAt` instant, and the React key
 * is the composite.
 */
interface FireRow {
  agentId: string;
  path: string;
  firedAt: Date | string;
  triggerSource: 'tick' | 'webhook' | 'manual';
  conversationId: string | null;
  status: 'ok' | 'silenced' | 'error';
  error: string | null;
}
interface RecentFiresForAgentInput {
  agentId: string;
  limit?: number;
  before?: Date;
}
interface RecentFiresForAgentOutput {
  fires: FireRow[];
}

/** Just enough of a routine to put its AUTHORED name on the row. */
interface RoutineRow {
  path: string;
  name: string;
}
interface RoutinesListInput {
  agentId?: string;
}
interface RoutinesListOutput {
  routines: RoutineRow[];
}

/**
 * `connectors:tool-labels` (TASK-744), duck-typed (I2): which connector each
 * opaque tool namespace belongs to, for one user.
 */
interface ConnectorToolLabelsInput {
  userId: string;
}
interface ConnectorToolLabelsOutput {
  // TASK-753: `tools` carries the server's cached tool titles when known.
  connectors: Array<{ toolNamespace: string; name: string; tools?: Array<{ name: string; title: string }> }>;
}

/**
 * The Memory tab's human-tier hooks (AW-13), registered today by @ax/memory
 * when its `rules` option is on. Duck-typed like every other
 * hook on this surface (I2). Note what these payloads do NOT carry: no path,
 * no revision, no tier vocabulary — the human tier could be a database row
 * tomorrow and this file would not change.
 */
interface MemoryAgentInput {
  agentId: string;
}
interface MemoryRulesReadOutput {
  body: string;
}
interface MemoryRulesWriteInput {
  agentId: string;
  body: string;
}
interface MemoryRulesWriteOutput {
  written: boolean;
  /** What is stored now, normalized by the writer. See `SaveRulesResult`. */
  body: string;
}
/**
 * The memory engine's `memory:status` — ctx-only (it answers for the caller
 * ctx's user), so the input is empty. Its reply is declared here for the
 * reader but validated as `unknown` at the call site, because it crossed the
 * bus: `{ extraction: 'paused'; reason: 'missing-credential' } |
 * { extraction: 'ok' }`.
 */
type MemoryStatusInput = Record<string, never>;

/**
 * The decision row as @ax/decisions stores it — the FULL one, `call` and all.
 *
 * Named `StoredDecision` so it can never be confused with the wire `Decision`
 * imported above: they are different shapes on purpose, and the difference is
 * the whole job of `toWireDecision`. Duck-typed rather than imported, because
 * plugins talk through the hook bus and never through each other's modules
 * (invariant 2).
 *
 * `call.input` is MODEL-AUTHORED. It is read by exactly nothing in this file,
 * and it is on this interface only so that dropping it is a visible decision
 * rather than an omission nobody notices.
 */
interface StoredDecision {
  id: string;
  agentId: string;
  ownerUserId: string;
  conversationId: string;
  kind: 'action' | 'grant';
  attendance: 'attended' | 'unattended';
  status: DecisionStatus;
  call: { id: string; name: string; input: unknown };
  callFingerprint: string;
  ruleId: string | null;
  irreversible: boolean;
  // `label` is NULLABLE on the stored row, and this mirror has to say so or
  // it quietly stops being a mirror: `@ax/decisions` STRIPS the label as it
  // moves a row to `stale` (AW-7), because the "checked against…" clause
  // describes hold-time and is false the instant the guard trips.
  freshness: { kind: string; value: string; label: string | null } | null;
  summary: string;
  detail: string;
  preview: { meta: string; body: string } | null;
  primaryLabel: string;
  secondaryLabel: string;
  ghostLabel: string;
  approvedText: string;
  dismissedText: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  staleReason: string | null;
  consumedAt: string | null;
  replayDueAt: string | null;
  replayClaimedAt: string | null;
  replayedAt: string | null;
  replayError: string | null;
  // TASK-574 — the attended path's deferred delivery. `deliveryDueAt` is when
  // the resolution is due to reach the warm agent (the undo window closing;
  // the sweep clears it as it delivers), `deliveredAt` is when it did. Both
  // OPTIONAL: the plugin is duck-typed across the bus and an older producer
  // sends neither, so every read here is `?? null`.
  deliveryDueAt?: string | null;
  deliveredAt?: string | null;
}

interface DecisionsListInput {
  userId: string;
  agentId?: string;
  status?: DecisionStatus;
}
interface DecisionsListOutput {
  decisions: StoredDecision[];
}

/**
 * `decisions:count` — how many decisions an agent raised for this person in a
 * window, duck-typed like every other hook on this surface (I2).
 *
 * NO STATUS FIELD, and its absence is the contract rather than an omission.
 * The counter's question spans every status ("whatever you decided"), and the
 * plugin answers it by naming none — which is also what lets that read skip
 * the expiry sweep. A `status` added here would be a different question with a
 * different cost.
 */
interface DecisionsCountInput {
  userId: string;
  agentId?: string;
  /** ISO instant, INCLUSIVE — decisions raised at or after it. */
  since: string;
}
interface DecisionsCountOutput {
  count: number;
}

interface DecisionsGetInput {
  decisionId: string;
  userId: string;
}
interface DecisionsGetOutput {
  decision: StoredDecision | null;
}

/**
 * `decisions:recent-receipts-for-agent` — the second source behind the Activity
 * feed, duck-typed like every other hook on this surface (I2).
 *
 * Shaped to page exactly like `routines:recent-fires-for-agent` above, because
 * the two are merged into one time-ordered collection and two sources that page
 * differently cannot be merged without losing rows at the seam. The one
 * difference is deliberate: `before` is an ISO STRING here where the fires hook
 * takes a `Date`. @ax/decisions keeps every instant on its hook surface as an
 * ISO string ("no `Date` ever leaves the store"), and the feed's own cursor is
 * a string too, so this is the shape that needs no conversion at either end.
 *
 * `userId` is a SCOPE, not a hint, and dropping it would be a real leak rather
 * than an inefficiency: a team agent can carry decisions belonging to several
 * people, so passing the ACL on the AGENT is not the same as being entitled to
 * read every decision attached to it.
 *
 * Note what is NOT here: no `call`, no `callFingerprint`, no `status`. The
 * receipt is the sentence and the outcome, already derived by the plugin that
 * authored the sentence — this surface renders it and does not re-derive it,
 * which is what stops a second copy of the decision machine growing here by
 * accident.
 */
interface DecisionReceiptRow {
  decisionId: string;
  agentId: string;
  /**
   * Five outcomes, and only ONE of them claims the action happened. The other
   * four are the question being settled — turned down, run out of time, tried
   * and failed, approved but not yet performed — and every one of them is an
   * event in the person's history (TASK-447).
   */
  outcome: 'executed' | 'failed' | 'pending-agent' | 'declined' | 'expired';
  /** HOST-AUTHORED prose. Fenced here anyway — see `receiptToActivityEvent`. */
  receipt: string;
  /** ISO instant. Orders the feed, cuts the page, prints on the row. */
  at: string;
  /** The host executor's sanitised failure detail, on a `failed` row only. */
  error: string | null;
}
interface DecisionsRecentReceiptsInput {
  userId: string;
  agentId: string;
  limit?: number;
  before?: string;
}
interface DecisionsRecentReceiptsOutput {
  receipts: DecisionReceiptRow[];
}

interface DecisionsResolveInput {
  decisionId: string;
  userId: string;
}
interface DecisionsApproveInput extends DecisionsResolveInput {
  /**
   * TASK-278 — the continuation turn's chat correlation, minted HERE (this
   * route owns chat-flow reqIds). Duck-typed like everything else in this
   * file (I2): `@ax/decisions` declares the contract, we just speak it.
   */
  continuationReqId: string;
}
interface DecisionsApproveOutput {
  decision: StoredDecision | null;
  executed: boolean;
  path: ExecutionPath | null;
  error: string | null;
  pendingUntil: string | null;
  streamReqId: string | null;
}
interface DecisionsDismissOutput {
  decision: StoredDecision | null;
}
interface DecisionsUndoOutput {
  decision: StoredDecision | null;
  undone: boolean;
}

// --- wire shapes ----------------------------------------------------------

/**
 * `GET /api/workspace/state` — the roster, and only the roster.
 *
 * There is no `activity` here and no `decisions` here. Each of those is one
 * collection with exactly one producer of its own — `GET
 * /api/workspace/activity` and `GET /api/workspace/decisions` — because two
 * fields over one collection is invariant 4 violated in the BFF, and because a
 * sub-array of a state blob cannot be paginated or re-fetched on its own after
 * someone approves something.
 *
 * The queue's field lived here for one slice as an honest `[]` while
 * @ax/decisions was being built. It moves out for the same reason the activity
 * feed did, not because the empty was wrong.
 */
export interface WorkspaceStateResponse {
  agents: WorkspaceAgent[];
}

/** `GET /api/workspace/decisions` — the Today queue, still-open rows only. */
export interface DecisionsResponse {
  decisions: Decision[];
}

/**
 * `GET /api/workspace/grants` — capability grants still waiting on this person
 * (TASK-373).
 *
 * The rows come straight out of the pending-card buffer the SSE stream fills:
 * the same `PermissionRequest` the live stream would have carried, read back
 * with the conversation and agent it was raised on, so a grant raised while
 * the workspace was closed is waiting on an idle Today instead of lost.
 *
 * There is no scoping parameter, and there cannot be one: scoping is the owner
 * the PRODUCER recorded at append time (`ChunkBuffer.appendPermissionCard`),
 * and nothing the caller sent took any part in it. "No such conversation" and
 * "not yours" are therefore the same empty list — no existence leak is
 * possible by construction.
 *
 * Host cards are deliberately absent (they are turn-scoped; answering a stale
 * one offers a control that cannot do what it says — TASK-375), and so are
 * cards buffered with no owner: an unattributable card is never shown to
 * whoever happened to ask.
 */
export interface GrantsResponse {
  grants: Array<{
    /** The conversation the grant was raised on. The answer POST needs it. */
    conversationId: string;
    /** The agent that asked — recorded with the card by the producer. */
    agentId: string;
    /**
     * The card verbatim. Public manifest data by construction (hostnames, slot
     * names), and byte-identical to what the SSE `permissionRequest` frame
     * writes to the same browser — fencing one copy and not the other would
     * make the fetched grant and the streamed grant of one subject disagree.
     */
    request: PermissionRequest;
  }>;
}

/**
 * `POST /api/workspace/grants/decline` — "Not now", written down (TASK-444).
 *
 * Product vocabulary only, and that is the test that this payload is
 * storage-agnostic (invariant 1): no key, no prefix, no timestamp. The
 * alternate implementation — a `@ax/grant-declines` plugin behind a
 * `grant-declines:record|list` hook with its own table — consumes exactly this
 * body without one field changing.
 *
 * The client's `agentId` is a CLAIM, not an authority. The handler requires an
 * exact match in the caller's OWN pending grants before it writes anything, so
 * the only thing this body can ever decline is a question the deployment is
 * genuinely asking this person right now. A triple that matches nothing —
 * whether it never existed or belongs to somebody else — is one 404.
 */
export interface DeclineGrantRequest {
  /** The agent that asked. Validated against the pending card, never trusted. */
  agentId: string;
  /** `skill` or `connector`. Host cards are turn-scoped and not declinable. */
  kind: DeclinableGrantKind;
  /** The skill id or connector id the card named. */
  subjectId: string;
}

/** `200` from the decline route. A refusal we could not record is a 503, not
 *  this with `declined: false` — see the handler. */
export interface DeclineGrantResponse {
  declined: true;
}

/**
 * Validate a decline body. Nothing here is trusted beyond its shape — the
 * handler still requires the triple to match a grant genuinely pending for the
 * caller before it writes. `kind` is checked against the two literals rather
 * than cast, so a third value (`host`, or anything invented) is a 400 and not
 * a key in a namespace nobody meant to create.
 */
function readDeclineBody(parsed: unknown): DeclineGrantRequest | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { agentId, kind, subjectId } = parsed as Record<string, unknown>;
  if (typeof agentId !== 'string' || agentId.length === 0) return null;
  if (typeof subjectId !== 'string' || subjectId.length === 0) return null;
  if (kind !== 'skill' && kind !== 'connector') return null;
  return { agentId, kind, subjectId };
}

/**
 * `GET /api/workspace/decisions/:decisionId` — ONE row, read back.
 *
 * The list route above answers with the still-open rows only: once a
 * decision resolves it drops out of `decisions:list`'s default status set, so
 * a resolved row the client is still showing can never come back through a
 * re-fetch of the queue. And a resolved row is exactly the case that needs
 * re-reading — it is the one carrying the Undo affordance, and `undoable`
 * goes false the moment `decisions:approve` (or the replay it schedules)
 * marks the row `consumedAt`. The approve response itself cannot carry that:
 * it is captured a moment after `resolvedAt`, before anything has consumed
 * the authorisation, so it is always `undoable: true` and stays that way in
 * the client's hands until something re-reads the row. This route is that
 * re-read — the one way `undoable` reaching false ever reaches the browser.
 */
export interface DecisionResponse {
  decision: Decision;
}

/**
 * `POST /api/workspace/decisions/:decisionId/approve`.
 *
 * Everything past `decision` is the plugin's answer about what actually
 * happened, passed straight through: `executed` is only ever true when a host
 * executor returned, and `pendingUntil` is non-null when what was approved
 * waits for the undo window to close — an irreversible call's deferred host
 * execution, or (TASK-574) the attended path's deferred delivery to the warm
 * agent. The one exception is `streamReqId` (TASK-278): the plugin reports
 * whether it scheduled delivery to a warm agent, but the BIND that makes the
 * id streamable is this route's — so the route answers null whenever the bind
 * did not land.
 */
export interface ApproveResponse {
  decision: Decision;
  executed: boolean;
  path: ExecutionPath | null;
  /**
   * The host executor's sanitised failure detail — AUDIT-TRAIL data, not a
   * receipt. The approval card never shows it: `toWireDecision` drops
   * `replayError` from the wire `Decision` outright, and the card renders the
   * AUTHORED failure line and this decision's id instead, because a host
   * tool's message can quote model-authored input back at us.
   *
   * ONE SURFACE DOES SHOW IT, and this comment used to deny that in general
   * terms. Since TASK-279 the Activity feed carries the same string as a
   * receipt row's SECOND line (`receiptToActivityEvent`), fenced, beside the
   * authored sentence and never as it — the same slot a failed routine fire's
   * own error already occupies. "Never the receipt" is the rule and it still
   * holds everywhere; "never rendered" was never the rule, and stating it that
   * broadly would have the next reader filing the feed as a bug.
   */
  error: string | null;
  pendingUntil: string | null;
  /**
   * TASK-278 — the continuation turn's reqId, bound as the conversation's
   * `active_req_id` when the approval is scheduled for delivery to a warm
   * agent. The open thread attaches its stream consumer to
   * `GET /api/chat/stream/<streamReqId>` for the live continuation — at
   * `pendingUntil` when one is set (TASK-574: the host tells the agent only
   * once the undo window closes). Null on
   * every path where no turn runs to watch (parked, host replay, deferred,
   * already resolved) and whenever the bind could not be established — in
   * which case the client opens nothing and the receipts stand as they did
   * before. A renderer must never promise a live continuation off anything
   * but a non-null value here.
   */
  streamReqId: string | null;
}

export interface DismissResponse {
  decision: Decision;
}

export interface UndoResponse {
  /**
   * The row as it stands. On a refusal (`undone: false`) it carries
   * `undoable: false` — see `undoDecision` below for why the projection alone
   * would not say so, and why saying so here is not a second copy of the rule.
   */
  decision: Decision;
  /** False when there was nothing left to take back. */
  undone: boolean;
}

/**
 * `GET /api/workspace/activity` — the one event collection, newest first.
 *
 * The global Activity page is this unfiltered; the per-agent "What it did" tab
 * is this with `agentid` set. One route, one shape, one renderer.
 */
export interface ActivityResponse {
  events: ActivityEvent[];
  /**
   * The cursor for the next page: the instant of the last fire CONSIDERED, not
   * of the last event rendered.
   *
   * Those differ, and the difference is load-bearing. A `silenced` fire renders
   * as nothing, so a page can legitimately come back with zero events and more
   * history behind it. A client paginating on its last visible row would have
   * no cursor at all and the feed would dead-end on a quiet stretch. `null`
   * means we reached the end of what this agent has.
   */
  nextBefore: string | null;
}

/**
 * `GET /api/workspace/agents/:agentId` — everything the detail panel renders.
 *
 * Deliberately has NO `stats` field: the "This week" panel is not rendered in
 * this slice, because a counter with nothing behind it is a claim we can't
 * back. Same reasoning for the absent `suggestions`.
 *
 * And no `files` (AW-12). The Files tab is its own read for the same reason
 * the activity feed is: a sub-array of a detail blob cannot carry the
 * difference between "this agent has written nothing" and "we could not read
 * its workspace". Shipping `files: []` inside a 200 meant the tab rendered
 * "has not written anything yet" over a failed listing, and there was nowhere
 * on the wire to say otherwise. `GET .../files` is that somewhere.
 */
export interface AgentDetail {
  agent: WorkspaceAgent;
  /**
   * The conversation `thread` was read from: the agent's current one, or the
   * one named by `?conversationId=`. `null` when the agent has never had a
   * conversation, or when the current one vanished between the list and the
   * read (a benign race — see `agentDetail`).
   */
  conversationId: string | null;
  /** Reconstructed from that conversation's turns. */
  thread: ThreadMessage[];
  /**
   * How the approval read behind `thread` went — the read that decides whether
   * the thread carries approval cards at all.
   *
   * There is a `status` here and NO rows, and both halves are deliberate. The
   * rows come from `GET /api/workspace/decisions`, the one producer, and a
   * second copy riding along here is the two-producers bug (see the splice in
   * `agentDetail`). But without the status a failed read left the thread simply
   * shorter, and a thread with no approval card is read as "nothing is waiting
   * on you" — which is the one thing this surface must never say when it does
   * not know.
   */
  decisions: { status: WorkspaceReadStatus };
  /** Older conversations, newest first, excluding the current one. */
  past: PastConversation[];
  /**
   * The Memory tab, split by WHO OWNS IT (AW-13), each half carrying how its
   * read went.
   *
   * The `rules` doc is present whenever we READ the tier, even when the user
   * has written nothing: it is the editor, and an editor that only appears
   * once you have already typed in it is not an editor. It is absent only when
   * we could not read, or when this deployment keeps no rules at all — and
   * `status` says which, because the two need different sentences (TASK-417).
   */
  memory: AgentMemoryRead;
  /**
   * TASK-744 — which connector each tool namespace belongs to, for THIS
   * reader, so the LIVE step panel can name a connector tool the way the
   * reloaded `thread` already does ("Linear · Create issue"). `toolNamespace`
   * is a lookup key, never rendered; `name` is fenced. Connectors the reader
   * cannot resolve are absent, and their tools read as the tool name alone.
   * TASK-753: `tools`, when present, is the MCP server's own cached title for
   * each tool that has one (fenced), preferred over the humanized name.
   */
  connectorTools: ConnectorToolsRow[];
}

/**
 * `GET /api/workspace/agents/:agentId/files` — one row per file the agent has
 * in its workspace, minus the machinery.
 *
 * Two fields, and they are not the same field twice:
 *
 *   - `path` is the KEY. It is the RAW workspace path, echoed back verbatim,
 *     and it is what the client puts back on the wire to open the file. It is
 *     never rendered. Same call as `ActivityEvent.id`: fencing a key can
 *     collapse two distinct paths onto one, and a label that cannot be used to
 *     fetch anything is not a key.
 *   - `name` is the LABEL, and it is fenced (see `fenceLine`). A filename is
 *     authored by the agent, in the agent's own workspace, with no validation
 *     beyond "git accepted it" — which is exactly the Trojan-source surface
 *     (CVE-2021-42574) that a file listing is famous for. `report.md` written
 *     with a U+202E in front of it renders as something else entirely.
 *
 * There is no size and no timestamp, because `workspace:list` reports neither
 * and a made-up "2 KB" is a claim.
 */
export interface WorkspaceFileSummary {
  path: string;
  name: string;
}

export interface AgentFilesResponse {
  files: WorkspaceFileSummary[];
  /**
   * `true` when the agent has more files than we are willing to put in one
   * response. The tab says so out loud — a silently short list is a list that
   * lies about what the agent has written.
   */
  truncated: boolean;
}

/**
 * `GET /api/workspace/agents/:agentId/files/*` — one file's text.
 *
 * `body` is `null` only when there is nothing text-shaped to show, and
 * `clipped` always says which of the two reasons applies. `clipped: null` with
 * a `body` means "this is the whole file", and that is a promise we keep.
 */
export interface AgentFileResponse {
  /** The raw key again, so the client can tell which request this answers. */
  path: string;
  /** The fenced label. */
  name: string;
  body: string | null;
  clipped: 'binary' | 'too-large' | null;
}

/**
 * `GET /api/workspace/agents/:agentId/user-files[/*]` — the DURABLE tier.
 *
 * A different tier from `/files` above, and the distinction is the whole
 * reason this exists. `/files` reads `workspace:*`, which is the git-backed
 * `/agent` tier — AX's own machinery plus whatever the agent committed. THIS
 * reads the agent's durable user-files tier, which since TASK-164 is the
 * agent's cwd and HOME: it is where a deliverable lands when nobody said
 * otherwise, and until now it was invisible in the UI.
 *
 * It is a TREE, not a list, because that is what the backing hook answers:
 * `sandbox:read-user-files` returns one directory's immediate children, not a
 * recursive walk. So one shape covers both answers and the client navigates.
 *
 * `path` / `name` keep the same split as `WorkspaceFileSummary`, for the same
 * reason: `path` is the raw key the client puts back on the wire and is never
 * rendered; `name` is the fenced label. On this tier the filenames are, if
 * anything, MORE agent-authored than on the other one — nothing here has been
 * through a git commit — so the Trojan-source fence (CVE-2021-42574) is not
 * optional.
 */
export interface UserFileEntry {
  /** RAW key, relative to the tier root. `docs/note.md`. Never rendered. */
  path: string;
  /** The fenced label — one path segment. */
  name: string;
  kind: 'file' | 'dir';
}

export type AgentUserFilesResponse =
  | {
      kind: 'dir';
      /** The raw key this answers for. `''` is the tier root. */
      path: string;
      /** The fenced label — the last segment, or `''` at the root. */
      name: string;
      entries: UserFileEntry[];
      /**
       * `true` when the directory holds more children than one response
       * carries. Said out loud for the same reason the other listing says it:
       * a list that silently stops is a list that claims the agent has that
       * many files and no more.
       */
      truncated: boolean;
    }
  | {
      kind: 'file';
      path: string;
      name: string;
      body: string | null;
      clipped: 'binary' | 'too-large' | null;
    };

/**
 * The one human-owned doc's display name. Lives here rather than in the
 * component because the server decides what a row IS; the component decides
 * how it looks.
 */
export const RULES_DOC_NAME = 'Your rules';

/** `PUT /api/workspace/agents/:agentId/memory/rules` — the human tier saved. */
export interface SaveRulesResult {
  saved: true;
  /**
   * What is stored now. The editor adopts THIS rather than the text it sent,
   * because the writer normalizes (trailing whitespace → one newline) and an
   * editor comparing its own text against a normalized store shows "unsaved
   * changes" forever. Returning it keeps one source of truth for the stored
   * form instead of asking the client to reimplement the rule.
   */
  body: string;
}

/** `POST /api/workspace/route` — which agent should hear this. */
export interface RouteResult {
  agentId: string;
  agentName: string;
  /** One plain-language line the UI shows so the pick is never a black box. */
  why: string;
  /**
   * `false` means "this is a guess, offer the user a way to change it". We only
   * claim confidence when there is literally no other agent to choose.
   */
  confident: boolean;
}

// --- shared helpers -------------------------------------------------------

/** Resolve the authenticated caller, or write 401 and return null. */
async function authOr401(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<string | null> {
  try {
    const r = await bus.call<AuthRequireUserInput, AuthRequireUserOutput>(
      'auth:require-user',
      ctx,
      { req },
    );
    return r.user.id;
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// "Other abilities" (TASK-738). Structural mirrors of @ax/tool-policy's
// override hooks — no import (invariant 2); the hook bus is the API.
// ---------------------------------------------------------------------------

type AbilityVerdict = 'allow' | 'hold' | 'deny';

interface ToolPolicySetAgentOverrideInput {
  agentId: string;
  toolKey: string;
  verdict: AbilityVerdict | null;
}
type ToolPolicySetAgentOverrideOutput =
  | { ok: true }
  | { ok: false; reason: string; ceiling?: AbilityVerdict | undefined };
interface ToolPolicyListAgentOverridesOutput {
  /** `ceiling` is the loosest verdict the store would accept for that key
   *  right now (TASK-742 reads it; the abilities switches do not need it). */
  overrides: Array<{ toolKey: string; verdict: AbilityVerdict; ceiling?: AbilityVerdict }>;
  /** TASK-754 — namespaces whose defaults the agent copied. A tool under one
   *  with no override is held (Ask first) whatever its live default says. */
  copiedNamespaces?: string[];
}

/**
 * The ONLY tool keys this surface can write. A closed table, server-side: the
 * browser names a product word and never a tool key, so nothing on the wire
 * can reach a key outside these three (tool-policy refuses others too — this
 * is the second lock, not the only one).
 */
export const ABILITY_TOOL_KEYS: Readonly<Record<AgentAbility, string>> = Object.freeze({
  webSearch: 'web_search',
  readPages: 'web_extract',
  runCode: 'Bash',
});

function isAgentAbility(v: unknown): v is AgentAbility {
  return typeof v === 'string' && (AGENT_ABILITIES as readonly string[]).includes(v);
}

/**
 * Off = an override of `deny`. Anything else — no override, or a `hold` that
 * a person did not set here — reads as on, because the switch only ever
 * writes `deny` or clears.
 */
function abilitiesFrom(out: ToolPolicyListAgentOverridesOutput): AgentAbilities {
  const denied = new Set(
    (Array.isArray(out?.overrides) ? out.overrides : [])
      .filter((o) => o?.verdict === 'deny')
      .map((o) => o.toolKey),
  );
  return {
    webSearch: !denied.has(ABILITY_TOOL_KEYS.webSearch),
    readPages: !denied.has(ABILITY_TOOL_KEYS.readPages),
    runCode: !denied.has(ABILITY_TOOL_KEYS.runCode),
  };
}

// ---------------------------------------------------------------------------
// The agent's connector list (TASK-739, connectors-rail slice 6). Structural
// mirrors of @ax/connectors' `connectors:list-effective` and @ax/agents'
// attach / detach hooks — no import (invariant 2).
// ---------------------------------------------------------------------------

interface ConnectorsListEffectiveInput {
  userId: string;
  attachmentIds: string[];
  exclusions: string[];
}
interface ConnectorsListEffectiveOutput {
  connectors: Array<{
    summary: {
      id: string;
      name: string;
      canEdit?: boolean;
      /** Whose key the connector spends (TASK-742 shows it as "access"). */
      keyMode?: 'personal' | 'workspace';
    };
    source: AgentConnectorSource;
    toolNamespaces?: Array<{ server: string; toolNamespace: string }>;
    /** Only the server names are read here (TASK-745). */
    capabilities?: { mcpServers?: Array<{ name: string }> };
  }>;
}
interface AgentsAttachConnectorInput {
  actor: { userId: string; isAdmin: boolean };
  agentId: string;
  connectorId: string;
}
interface AgentsDetachConnectorInput extends AgentsAttachConnectorInput {
  exclude: boolean;
}
interface AgentsConnectorChangeOutput {
  changed: boolean;
}
/**
 * Structural mirror of @ax/agents' `agents:can-exclude-connector` (TASK-765)
 * — no import (invariant 2). Answers whether the actor may take a connector
 * every member reaches (a workspace default, a legacy-owned one) off this
 * agent. The same rule guards `agents:detach-connector {exclude: true}`.
 */
interface AgentsCanExcludeConnectorInput {
  actor: { userId: string; isAdmin: boolean };
  agentId: string;
}
interface AgentsCanExcludeConnectorOutput {
  allowed: boolean;
}

const AGENT_CONNECTOR_SOURCES: readonly AgentConnectorSource[] = [
  'default',
  'attached',
  'legacy-owned',
];

/** Same slug rule @ax/connectors and @ax/agents enforce; checked here so a
 *  malformed id is a 400 before any hook runs. */
const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
function isConnectorId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 && CONNECTOR_ID_RE.test(v);
}

/**
 * TASK-761 — does this agent's runner give the model connector tools at all?
 * An allow-list on purpose: only the claude-sdk runner loads the connectors'
 * `.mcp.json` (the aisdk runner does not, by design), so a runner nobody has
 * wired for connectors yet says "can't use connectors" rather than offering
 * setup that silently does nothing. An agent row with no runner predates the
 * field and runs on claude-sdk.
 */
function runnerLoadsConnectors(runner: string | undefined): boolean {
  return runner === undefined || runner === 'claude-sdk';
}

/**
 * TASK-761 — what stands between a connector and being attached.
 *
 * Product rule (owner, 2026-10-02): a connector is attached to an agent ONLY
 * after its sign-in / key has succeeded. The Add subview already waits; this
 * is the server holding the same line, so a hand-rolled POST cannot attach an
 * OAuth connector nobody signed in to (measured on the TASK-743 walk).
 *
 * Every credential slot must RESOLVE through `credentials:get` under
 * (caller, agent) — the same lookup a chat turn and the OAuth status route
 * make, so "signed in" here means what it means at run time (an agent-scope
 * sign-in on a team agent counts; a company key counts for a workspace
 * connector, subject to the vault's own global-read authorization). The value
 * is read host-side and DROPPED: it never leaves this function.
 *
 * Fails CLOSED: a missing service or an unexpected error refuses the attach.
 */
type AttachGate =
  | { ok: true }
  | { ok: false; status: number; error: string; message?: string };

async function attachCredentialGate(
  bus: HookBus,
  ctx: AgentContext,
  logger: AgentContext['logger'],
  actor: { id: string; isAdmin: boolean },
  connectorId: string,
): Promise<AttachGate> {
  // A refusal for a reason that is not "nobody signed in" leaves an operator
  // a trace of why (the error's NAME only — never its message, which could
  // carry vault detail).
  const failed = (step: string, err: unknown): AttachGate => {
    logger.warn('workspace_connector_attach_check_failed', {
      connectorId,
      step,
      name: err instanceof Error ? err.name : 'unknown',
    });
    return { ok: false, status: 503, error: 'connector-check-failed' };
  };
  const userId = actor.id;
  if (!bus.hasService('connectors:get')) {
    return { ok: false, status: 503, error: 'connectors-unavailable' };
  }
  let connector: Connector;
  try {
    const out = await bus.call<{ userId: string; connectorId: string }, { connector: Connector }>(
      'connectors:get',
      ctx,
      { userId, connectorId },
    );
    connector = out.connector;
  } catch (err) {
    if (err instanceof PluginError && err.code === 'not-found') {
      return { ok: false, status: 404, error: 'connector-not-found' };
    }
    return failed('connector', err);
  }
  // A connector that spends the company key is admin-only to attach, and
  // `agents:attach-connector` refuses it for anyone else. Refuse it HERE
  // first, the same 403, so a non-admin's request never makes the host read
  // the company key's presence on their behalf.
  if (!actor.isAdmin && connector?.keyMode === 'workspace') {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const slots = Array.isArray(connector?.capabilities?.credentials)
    ? connector.capabilities.credentials
    : [];
  if (slots.length === 0) return { ok: true };
  if (!bus.hasService('credentials:get')) {
    return failed('vault-missing', undefined);
  }
  const plan = deriveCredentialPlan(connector);
  for (const entry of plan) {
    const slot = slots.find((s) => s.slot === entry.slot);
    const signIn = slot?.kind === 'oauth';
    try {
      await bus.call<{ ref: string; userId: string }, unknown>('credentials:get', ctx, {
        ref: entry.ref,
        userId,
      });
    } catch (err) {
      if (credentialMissing(err)) {
        return signIn
          ? {
              ok: false,
              status: 409,
              error: 'connector-needs-sign-in',
              message: 'Sign in to this connector first, then add it.',
            }
          : {
              ok: false,
              status: 409,
              error: 'connector-needs-key',
              message: 'Add the key this connector needs first, then add it.',
            };
      }
      return failed('credential', err);
    }
  }
  return { ok: true };
}

/**
 * "There is no usable credential" — absent, or an OAuth sign-in whose refresh
 * was rejected. The reconnect error crosses the bus twice (resolver →
 * credentials:get → here) and is wrapped on the way, so it is recognised by
 * name on the error or its cause, never by importing @ax/mcp-oauth (I2).
 */
function credentialMissing(err: unknown): boolean {
  if ((err as { code?: unknown })?.code === 'credential-not-found') return true;
  const named = (e: unknown): boolean =>
    e instanceof Error && e.name === 'NeedsReconnectError';
  return named(err) || named((err as { cause?: unknown })?.cause);
}

/**
 * The wire rows. Names are author-chosen text, so they are fenced like every
 * other label on this surface; a row whose name fences to nothing is shown
 * by its id rather than dropped — dropping it would hide reach.
 */
/**
 * Rows start `ok` and non-attached rows start not-removable; the GET overlays
 * stored health (TASK-741) and the exclusion answer (TASK-765) afterwards.
 */
function toConnectorRows(out: ConnectorsListEffectiveOutput): AgentConnectorRow[] {
  const rows: AgentConnectorRow[] = [];
  for (const entry of Array.isArray(out?.connectors) ? out.connectors : []) {
    const id = entry?.summary?.id;
    if (!isConnectorId(id)) continue;
    const source = AGENT_CONNECTOR_SOURCES.includes(entry.source) ? entry.source : 'attached';
    rows.push({
      id,
      name: fenceLine(entry.summary.name, RAIL_LABEL_MAX_CHARS) ?? id,
      source,
      editable: entry.summary.canEdit === true,
      health: 'ok',
      // Detaching an attachment is always the caller's to ask for; the GET
      // overlays the exclusion answer onto the rest (TASK-765).
      removable: source === 'attached',
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Connector health (TASK-741, connectors-rail slice 8). Structural mirrors of
// @ax/mcp-oauth's `mcp-oauth:status-batch` and @ax/mcp-client's
// `connectors:inventory-status-batch` / `connectors:describe-tools` — no
// import (invariant 2). Both batch reads answer from STORED state: drawing the
// list never refreshes a token or reaches a server.
// ---------------------------------------------------------------------------

interface McpOAuthStatusBatchOutput {
  needsReconnect: string[];
  /** TASK-756 — the subset whose rejected sign-in is the agent's shared one. */
  shared?: string[];
}

/**
 * TASK-756 — how long one Retry's answer stands for the same person and
 * connector. A held-down Retry must not turn into a stream of forced checks
 * against someone else's server; inside the window the route answers what the
 * last check found (with a fresh sign-in read) instead of checking again.
 * Per process: with several replicas it bounds each one, which is the point —
 * the per-key in-flight collapse in describe-tools only covers concurrency.
 */
export const CONNECTOR_RETRY_COOLDOWN_MS = 30_000;
/** Bound on remembered Retry keys, so the cooldown map cannot grow unbounded. */
export const CONNECTOR_RETRY_COOLDOWN_MAX_KEYS = 1_000;

/**
 * TASK-756 — insert `entry` under `key`, keeping `map` at most `maxKeys`.
 * When full: first drop every entry outside the window (or stamped in the
 * future — a clock step must not pin an entry forever), then, if it is
 * still full of live entries, the oldest (Map order is insertion; `key` is
 * re-inserted so a refresh moves to the back).
 */
export function rememberBounded<V extends { at: number }>(
  map: Map<string, V>,
  key: string,
  entry: V,
  windowMs: number,
  maxKeys: number,
): void {
  map.delete(key);
  if (map.size >= maxKeys) {
    for (const [k, v] of map) {
      if (entry.at - v.at >= windowMs || entry.at < v.at) map.delete(k);
    }
    while (map.size >= maxKeys) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
  map.set(key, entry);
}
type ConnectorInventoryStatus = 'ok' | 'unreachable' | 'needs-auth' | 'unknown';
interface InventoryStatusBatchOutput {
  statuses: Array<{ connectorId: string; status: ConnectorInventoryStatus; checkedAt: string }>;
}
interface DescribeToolsOutput {
  status: ConnectorInventoryStatus;
}

/**
 * TASK-745 — the connectors a session on this agent would open WITHOUT one
 * or more of their servers.
 *
 * When a session opens, the orchestrator's `foldConnectorCaps` keys each
 * connector server by its tool namespace and DROPS (fail closed, log only) a
 * server whose namespace is missing, malformed, or already taken by an earlier
 * server in the session. Today the only realistic way to get there is a
 * connector that declares two servers under one name. The person never saw
 * it: the connector just quietly had fewer tools.
 *
 * This replays THAT rule over the SAME input — `connectors:list-effective`,
 * read under the caller, in the order the session folds it — so the rail can
 * say so before a session even starts. It is a mirror, not a second decision:
 * the orchestrator's fold stays the enforcement, and keeping this in step is
 * pinned on both sides (connector-union.ts names this function). Skill-referenced
 * connectors fold AFTER this list, so they can never take a namespace from a
 * connector on it.
 */
function connectorsNotLoaded(out: ConnectorsListEffectiveOutput): Set<string> {
  const notLoaded = new Set<string>();
  const used = new Set<string>();
  for (const entry of Array.isArray(out?.connectors) ? out.connectors : []) {
    const id = entry?.summary?.id;
    const nsByServer = new Map<string, string>();
    for (const t of Array.isArray(entry?.toolNamespaces) ? entry.toolNamespaces : []) {
      if (!nsByServer.has(t?.server)) nsByServer.set(t?.server, t?.toolNamespace);
    }
    const servers = entry?.capabilities?.mcpServers;
    for (const s of Array.isArray(servers) ? servers : []) {
      const ns = nsByServer.get(s?.name);
      if (typeof ns !== 'string' || !CONNECTOR_TOOL_NAMESPACE_RE.test(ns) || used.has(ns)) {
        if (typeof id === 'string') notLoaded.add(id);
        continue;
      }
      used.add(ns);
    }
  }
  return notLoaded;
}

/**
 * One health word per connector. A connector that cannot load first: neither
 * Reconnect nor Retry can fix it (only editing it can), and it is certain,
 * where the other two come from cached checks. Then a rejected sign-in
 * outranks an unreachable
 * server: Reconnect is the fix a person can act on, and a server that refuses
 * a dead token often looks unreachable too. `needs-auth` from the inventory is
 * NOT read as "sign-in expired" — it is also what a connector nobody has signed
 * in to yet reports, and telling that person their sign-in expired would be
 * wrong; only the marker the token resolver writes on a rejected refresh says so.
 */
function healthOf(
  notLoaded: ReadonlySet<string>,
  needsReconnect: ReadonlySet<string>,
  inventory: ReadonlyMap<string, ConnectorInventoryStatus>,
  connectorId: string,
): AgentConnectorHealth {
  if (notLoaded.has(connectorId)) return 'not-loaded';
  if (needsReconnect.has(connectorId)) return 'needs-reconnect';
  if (inventory.get(connectorId) === 'unreachable') return 'unreachable';
  return 'ok';
}

// ---------------------------------------------------------------------------
// One connector's tools, per agent (TASK-742, connectors-rail slice 9).
// Structural mirrors of @ax/mcp-client's `connectors:describe-tools` and
// @ax/tool-policy's `get-connector-defaults` — no import (invariant 2). The
// key parse and inventory filter are twins of @ax/connectors'
// `tool-permissions.ts`, for the same reason.
// ---------------------------------------------------------------------------

interface DescribeToolsInput {
  userId: string;
  agentId: string;
  connectorId: string;
  force?: boolean;
}
interface DescribeToolsInventoryOutput {
  status: AgentConnectorToolsRead['status'];
  tools: Array<{
    name: string;
    title: string;
    description: string;
    readOnly: boolean | null;
    outward: boolean | null;
    toolKey: string;
  }>;
  checkedAt: string;
}
interface GetConnectorDefaultsInput {
  connectorId: string;
  toolNamespaces: string[];
}
interface GetConnectorDefaultsOutput {
  defaults: Array<{ toolKey: string; verdict: AbilityVerdict }>;
}

/** Rows one details view carries — tool-policy's own per-write cap. */
export const CONNECTOR_TOOLS_MAX_ROWS = 500;
/** A tool key longer than this is not one anything here wrote. */
const CONNECTOR_TOOL_KEY_MAX_CHARS = 300;
/** A vendor's tool description: a few paragraphs, and no more. */
export const CONNECTOR_TOOL_DESCRIPTION_MAX_CHARS = 1000;

const INVENTORY_STATUSES: ReadonlySet<string> = new Set([
  'ok',
  'unreachable',
  'needs-auth',
  'unknown',
]);

function isToolVerdict(v: unknown): v is AgentToolVerdict {
  return v === 'allow' || v === 'hold' || v === 'deny';
}

const VERDICT_STRICTNESS: Readonly<Record<AgentToolVerdict, number>> = {
  allow: 0,
  hold: 1,
  deny: 2,
};

/**
 * What a call gets is the strictest of the agent's own choice and the admin's
 * ceiling — the rule @ax/tool-policy enforces (`strictest`). Showing anything
 * looser would be a control that says one thing while the gate does another.
 */
function strictestVerdict(
  a: AgentToolVerdict | undefined,
  b: AgentToolVerdict,
): AgentToolVerdict {
  if (a === undefined) return b;
  return VERDICT_STRICTNESS[a] >= VERDICT_STRICTNESS[b] ? a : b;
}

/** `mcp.<ns>.<tool>` → `<ns>`, else null. The tool part must be non-empty. */
function connectorToolNamespace(toolKey: string): string | null {
  if (!toolKey.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = toolKey.slice(MCP_TOOL_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  return rest.slice(0, dot);
}

/** The namespaces this connector's tools live under, from the effective list. */
function ownToolNamespaces(
  entry: ConnectorsListEffectiveOutput['connectors'][number],
): string[] {
  return (Array.isArray(entry.toolNamespaces) ? entry.toolNamespaces : [])
    .map((n) => n?.toolNamespace)
    .filter((ns): ns is string => typeof ns === 'string' && CONNECTOR_TOOL_NAMESPACE_RE.test(ns));
}

/**
 * A vendor's tool description is a document, not a label: its newlines
 * survive (`fenceBody`) while the characters that rewrite a surface do not.
 * It is clamped because nobody else bounds it — in code points, like
 * `fenceLine`, so a cut never strands half a surrogate pair.
 */
function fenceToolDescription(value: unknown): string {
  if (typeof value !== 'string') return '';
  const body = fenceBody(value).trim();
  const points = [...body];
  if (points.length <= CONNECTOR_TOOL_DESCRIPTION_MAX_CHARS) return body;
  return `${points.slice(0, CONNECTOR_TOOL_DESCRIPTION_MAX_CHARS - 1).join('').trimEnd()}…`;
}

/** A row's label: the server's title, else its name, else the key's own tool part. */
function connectorToolTitle(
  toolKey: string,
  ns: string,
  title?: unknown,
  name?: unknown,
): string {
  const part = toolKey.slice(`${MCP_TOOL_PREFIX}${ns}.`.length);
  return (
    fenceLine(typeof title === 'string' ? title : null, RAIL_LABEL_MAX_CHARS) ??
    fenceLine(typeof name === 'string' ? name : null, RAIL_LABEL_MAX_CHARS) ??
    fenceLine(part, RAIL_LABEL_MAX_CHARS) ??
    // A key always starts `mcp.`, so this never fences to nothing.
    fenceLine(toolKey, RAIL_LABEL_MAX_CHARS) ??
    toolKey
  );
}

/**
 * Resolve the authenticated caller WITH the admin bit, or write 401 and
 * return null. Only the routes that hand an `actor` to a write hook need it
 * (TASK-739): the hook, not the route, decides what an admin may do.
 */
async function authActorOr401(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<{ id: string; isAdmin: boolean } | null> {
  try {
    const r = await bus.call<AuthRequireUserInput, AuthRequireUserOutput>(
      'auth:require-user',
      ctx,
      { req },
    );
    return { id: r.user.id, isAdmin: r.user.isAdmin === true };
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
}

/**
 * Map an `@ax/agents` connector-write refusal onto a status. `forbidden`
 * (not allowed to edit this agent, or a non-admin attaching a workspace
 * connector) is a 403 — the caller already passed `agents:resolve`, so the
 * agent's existence is not a secret from them. Anything else is not ours.
 */
function connectorWriteRefused(res: RouteResponse, err: unknown): boolean {
  if (!(err instanceof PluginError)) return false;
  // TASK-766 — @ax/agents tags one `forbidden` with a reason: this connector
  // was removed from this agent and the caller may not bring it back (only the
  // agent's owner or an admin may; TASK-765). Say THAT, with a stable code,
  // so the add view can explain it. Nothing about who removed it or when —
  // the hook does not carry that and neither do we. Matched by string, not by
  // importing @ax/agents (I2). Every other `forbidden` stays opaque.
  if (err.code === 'forbidden' && err.diagnosis?.['reason'] === 'connector-excluded') {
    res.status(403).json({
      error: 'connector-excluded',
      message: 'This connector was removed from this agent. Only its owner or a workspace admin can add it back.',
    });
    return true;
  }
  if (err.code === 'forbidden') {
    res.status(403).json({ error: 'forbidden' });
    return true;
  }
  if (err.code === 'not-found') {
    res.status(404).json({ error: 'agent-not-found' });
    return true;
  }
  if (err.code === 'invalid-payload') {
    res.status(400).json({ error: 'invalid-connector' });
    return true;
  }
  return false;
}

/** Resolve the agent for ACL. Any PluginError → 404 (do not leak existence). */
async function resolveAgentOr404(
  bus: HookBus,
  ctx: AgentContext,
  agentId: string,
  userId: string,
  res: RouteResponse,
): Promise<AgentsResolveOutput['agent'] | null> {
  try {
    const r = await bus.call<AgentsResolveInput, AgentsResolveOutput>(
      'agents:resolve',
      ctx,
      { agentId, userId },
    );
    return r.agent;
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(404).json({ error: 'agent-not-found' });
      return null;
    }
    throw err;
  }
}

/** The instant a conversation was last touched, as a sortable epoch ms. */
function activityStamp(c: ConversationRow): number {
  const raw = c.lastActivityAt ?? c.createdAt;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

/** Newest first. */
function byRecencyDesc(a: ConversationRow, b: ConversationRow): number {
  return activityStamp(b) - activityStamp(a);
}

/**
 * `?conversationId=` as it actually arrives. `http-server` lowercases every
 * query key on the way in, so this is the only spelling a handler ever sees.
 */
export const CONVERSATION_ID_QUERY_KEY = 'conversationid';

/**
 * `GET /api/workspace/activity`'s query keys, in the ONLY spelling a handler
 * ever sees. Same trap as `CONVERSATION_ID_QUERY_KEY`: the browser sends
 * `?agentId=`, `http-server` projects it as `agentid`, and a handler reading
 * `req.query.agentId` gets `undefined` forever — which here would silently
 * serve the WHOLE workspace's feed under one agent's "What it did" tab.
 */
export const ACTIVITY_AGENT_ID_QUERY_KEY = 'agentid';
export const ACTIVITY_BEFORE_QUERY_KEY = 'before';
export const ACTIVITY_LIMIT_QUERY_KEY = 'limit';

/** Page size. The client asks; we decide. */
const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 100;

/** Plain-language trigger labels. The wire word is vocabulary, not a sentence. */
const TRIGGER_LABEL: Record<FireRow['triggerSource'], string> = {
  tick: 'Scheduled',
  webhook: 'Webhook',
  manual: 'Run by hand',
};

/** `Date | string` → epoch ms. `NaN` for anything unreadable. */
function fireStamp(firedAt: Date | string): number {
  return firedAt instanceof Date ? firedAt.getTime() : Date.parse(firedAt);
}

/**
 * The same instant, but sortable: an unreadable one goes to the BOTTOM instead
 * of wherever `NaN` comparisons happen to leave it. A row we cannot date is
 * dropped by the mapper anyway; it must not take a datable row's place on the
 * page on its way out.
 */
function sortableStamp(firedAt: Date | string): number {
  const t = fireStamp(firedAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * How much of an authored line this feed will carry.
 *
 * On a ROUTINE row the subject line is a LABEL — a routine's name, one
 * truncating row in the DOM — so it gets the same 60 the rest of the workspace
 * gives a label. The second line is a recorded error, which is a sentence and
 * legitimately longer, so it gets more room; it is still bounded, because
 * "however long the agent felt like" is not a size.
 *
 * A DECISION row's subject is not a label at all — it is the authored receipt,
 * a whole sentence — so it is carried at `DECISION_RECEIPT_MAX_CHARS` below,
 * the same cap the queue and the in-thread card already use for the same
 * strings. Chopping it at 60 would truncate mid-clause on the one row whose
 * whole job is to say what happened. The DOM truncates either way; this is
 * about what goes on the wire.
 */
export const ACTIVITY_LABEL_MAX_CHARS = 60;
export const ACTIVITY_DETAIL_MAX_CHARS = 200;

/*
  The fence itself lives in `lib/fence-line.ts`. It used to be a private copy
  here, until TASK-352 needed the SAME fence in the browser: the live thread is
  built from SSE frames that never pass through this route, so a fence only
  this file applied would leave a live row and a reloaded row saying different
  things about the same tool call. A fence one of two paths applies is not a
  fence.
*/

/**
 * How much of a decision's authored prose reaches the browser.
 *
 * These are host-authored strings, but they are BUILT from tool names and
 * capability sentences that arrive from MCP servers and agent-authored skills.
 * That makes this the trust boundary, and it is fenced here rather than in a
 * renderer: fencing bounds what goes on the WIRE, so a second renderer — the
 * in-thread card, and later Slack — cannot forget to do it.
 *
 * The sizes follow what each string is. A summary is a queue row, a detail is a
 * paragraph, a label is a button, a receipt is a sentence, and a preview body
 * is a quoted artifact — the actual email — so it gets real room while still
 * being bounded, because "however long the model felt like" is not a size.
 */
export const DECISION_SUMMARY_MAX_CHARS = 120;
export const DECISION_DETAIL_MAX_CHARS = 400;
export const DECISION_LABEL_MAX_CHARS = 40;
export const DECISION_RECEIPT_MAX_CHARS = 200;
export const DECISION_PREVIEW_META_MAX_CHARS = 120;
export const DECISION_PREVIEW_BODY_MAX_CHARS = 2000;

/**
 * What a control says when its authored label fences down to nothing.
 *
 * A prose field may legitimately come back null — a paragraph nobody wrote
 * renders as no paragraph. A BUTTON may not: an unlabelled button on a surface
 * whose entire job is "do you want this to happen" is a control a person
 * cannot read before they press it. So the button always says something, and
 * what it says is the plainest true thing we have.
 */
export const DECISION_FALLBACK_PRIMARY = 'Approve';
export const DECISION_FALLBACK_SECONDARY = 'Open the conversation';
export const DECISION_FALLBACK_GHOST = 'Dismiss';

/** Same rule for the row's own headline — see the activity feed's twin. */
export const DECISION_FALLBACK_SUMMARY = 'A decision with no readable summary';

/**
 * And for the two receipts. A resolved row whose line fenced to nothing would
 * be a receipt that says nothing at all, which reads as "we are not sure what
 * you did" — so each outcome keeps its own plain sentence. They stay separate
 * strings for the reason the plugin keeps them separate: deriving one from the
 * other by string surgery once shipped "sent your reply" for a reply that was
 * never sent.
 */
export const DECISION_FALLBACK_APPROVED = 'You approved this.';
export const DECISION_FALLBACK_DISMISSED = 'You turned this down. Nothing ran.';
/** The feed's fallback for an expired row. See `RECEIPT_RENDERING`. */
export const DECISION_FALLBACK_EXPIRED = 'This one ran out of time.';
/**
 * …and for a failed one, which cannot borrow either of the lines above.
 *
 * It is NOT "you approved this" — true, but the wrong fact to lead a failure
 * with — and it is NOT "it did not work", because one kind of `failed` is the
 * host dying mid-flight, where the call may well have gone out and the only
 * honest receipt is that we cannot say. So the fallback claims nothing about
 * the action at all: our own sentence was the thing that could not be printed,
 * and saying so is the one statement that is true either way.
 */
export const DECISION_FALLBACK_FAILED = 'We could not show what happened here.';

/**
 * What a decision receipt is badged as in the feed.
 *
 * Plain language, like the trigger labels above: the reader is being told where
 * this row came from, and "it came from something you approved" is the whole
 * message. Deliberately not the outcome — that is what the row's own sentence
 * and icon say, and a badge repeating it would be the same fact three times.
 */
export const DECISION_RECEIPT_TAG = 'Approval';

/**
 * …and what the OTHER half is badged as.
 *
 * "Approval" is the right word for a row that follows a yes — including a
 * failed one, where the person did approve and the attempt is what went wrong.
 * It is the wrong word over "You turned this down" and over "This one ran out
 * of time", where nothing was approved at all, and a badge that says otherwise
 * is the surface contradicting the sentence directly beneath it.
 *
 * Both are still one vocabulary answering one question — where did this row
 * come from — and the answer for these two is the neutral one: a decision was
 * put to you. The outcome is the row's own sentence and icon to tell.
 */
export const DECISION_UNRESOLVED_TAG = 'Decision';

// --- the rail ------------------------------------------------------------

/**
 * How much of a rail string reaches the browser.
 *
 * A capability clause is CI-linted to 60 already; a tool name and an MCP server
 * id are ours; a vendor's description is not bounded by anybody, so it gets a
 * paragraph's worth and no more. All four go through `fenceLine` regardless —
 * fencing bounds what goes on the WIRE, which is the only place a second
 * renderer cannot forget to do it.
 */
export const RAIL_LABEL_MAX_CHARS = 60;
export const RAIL_DESCRIPTION_MAX_CHARS = 400;

/** How far back "This week" looks. */
export const COUNTER_WINDOW_DAYS = 7;

/**
 * The host-side namespace every MCP tool's name carries — `mcp.<serverId>.<tool>`.
 *
 * A local twin of @ax/mcp-client's `MCP_NAMESPACE_PREFIX` and the parse in its
 * `filterByAgentScope`, mirrored rather than imported for the reason `fenceLine`
 * is: plugins talk through the hook bus, never through each other's modules
 * (invariant 2). The parse rule is copied exactly, INCLUDING its safe default —
 * a name in the `mcp.` namespace that does not parse is treated as an MCP tool
 * with no readable server, not as a native tool.
 */
const MCP_TOOL_PREFIX = 'mcp.';

/** `mcp.<serverId>.<tool>` split in two, or `null` for a native tool name. */
export function parseMcpToolName(
  name: string,
): { serverId: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const after = name.slice(MCP_TOOL_PREFIX.length);
  const dot = after.indexOf('.');
  if (dot <= 0) return null;
  const tool = after.slice(dot + 1);
  if (tool.length === 0) return null;
  return { serverId: after.slice(0, dot), tool };
}

/**
 * The agent's tool scope, as `@ax/mcp-client` reads it.
 *
 * BOTH lists empty is the WILDCARD sentinel — it means "no per-agent
 * restriction", which is what a bootstrapped personal agent gets. It does not
 * mean "no tools", and a rail that read it that way would tell a user their
 * agent can do nothing at the exact moment it can do everything.
 */
interface AgentToolScope {
  allowedTools: string[];
  mcpConfigIds: string[];
  unrestricted: boolean;
}

export function toolScopeOf(agent: ResolvedAgent): AgentToolScope {
  const allowedTools = Array.isArray(agent.allowedTools) ? agent.allowedTools : [];
  const mcpConfigIds = Array.isArray(agent.mcpConfigIds) ? agent.mcpConfigIds : [];
  return {
    allowedTools,
    mcpConfigIds,
    unrestricted: allowedTools.length === 0 && mcpConfigIds.length === 0,
  };
}

/** Would this agent see this catalog tool? Same rule as `filterByAgentScope`. */
export function inAgentScope(name: string, scope: AgentToolScope): boolean {
  if (scope.unrestricted) return true;
  if (name.startsWith(MCP_TOOL_PREFIX)) {
    const parsed = parseMcpToolName(name);
    // Unparseable inside the namespace: invisible to every agent, exactly as
    // the dispatcher decides it. Never fall back to the native allow-list.
    return parsed !== null && scope.mcpConfigIds.includes(parsed.serverId);
  }
  return scope.allowedTools.includes(name);
}

/**
 * Our authored verb phrase for each kind of thing a person can grant.
 *
 * Authored, closed, and NEVER derived from the granted value: the value is a
 * hostname or a package name that arrived from a skill manifest, and folding it
 * into a sentence would put somebody else's string in our voice. It is carried
 * beside the phrase as `label` and rendered as data.
 */
const GRANT_ACTION: Record<ApprovedCapKind, string> = {
  host: 'reach',
  slot: 'use the saved key called',
  npm: 'install the npm package',
  pypi: 'install the Python package',
  mcp: 'connect to the tool server',
};

/** The grant kinds `skills:approved-caps-list` can return. */
const APPROVED_CAP_KINDS: readonly ApprovedCapKind[] = [
  'host',
  'slot',
  'npm',
  'pypi',
  'mcp',
];

/**
 * The stored row → the row a browser sees.
 *
 * Two jobs, and nothing else. It DROPS the fields a renderer has no use for —
 * `call` above all, which is model-authored and would put untrusted text on a
 * trust surface for no reader's benefit — and it FENCES every string that
 * survives. See `Decision` in `../lib/workspace-types.ts` for the full account
 * of what goes and why.
 *
 * The one derived field is `undoable`, and it is derived HERE so there is only
 * one copy of the rule. A client re-deriving it from `consumedAt` /
 * `replayedAt` / `replayClaimedAt` would be a second copy of the decision
 * machine built by accident, and those three fields would have to cross the
 * wire to make it possible.
 */
export function toWireDecision(stored: StoredDecision): Decision {
  const freshnessLabel = fenceLine(stored.freshness?.label, DECISION_LABEL_MAX_CHARS);
  const previewBody = fenceLine(stored.preview?.body, DECISION_PREVIEW_BODY_MAX_CHARS);
  return {
    // Identifiers, not prose: they are keys the client hands back to us, they
    // are never rendered, and fencing them could collapse two distinct ids
    // onto one.
    id: stored.id,
    agentId: stored.agentId,
    conversationId: stored.conversationId,
    kind: stored.kind,
    attendance: stored.attendance,
    status: stored.status,
    irreversible: stored.irreversible,
    // A predicate with no readable label is not a claim we can put in front of
    // anyone, so the whole predicate goes rather than half of it. `kind` and
    // `value` are opaque tokens the UI never parses or prints — see
    // `FreshnessPredicate`.
    //
    // This is ALSO the stale row's path since AW-7: the plugin strips `label`
    // when the guard trips, so `fenceLine` answers null and the whole predicate
    // drops here rather than in the renderer. The client type still declares
    // `label` nullable — it mirrors the ROW's optionality, so the two
    // `FreshnessPredicate` declarations stay one shape — and `DecisionRow`
    // handles the null anyway. The narrowing is this route's decision to make,
    // not something the type should pretend cannot happen.
    freshness:
      stored.freshness !== null && freshnessLabel !== null
        ? {
            kind: stored.freshness.kind,
            value: stored.freshness.value,
            label: freshnessLabel,
          }
        : null,
    summary:
      fenceLine(stored.summary, DECISION_SUMMARY_MAX_CHARS) ?? DECISION_FALLBACK_SUMMARY,
    // A paragraph is not a control. One that fences to nothing is simply not
    // there, and the renderer draws no paragraph.
    detail: fenceLine(stored.detail, DECISION_DETAIL_MAX_CHARS) ?? '',
    // The quoted artifact. No readable body means there is nothing to quote,
    // so the block goes. A readable body with an unreadable header keeps the
    // body — the header is orientation, the body is the thing being approved.
    preview:
      previewBody !== null
        ? {
            meta: fenceLine(stored.preview?.meta, DECISION_PREVIEW_META_MAX_CHARS) ?? '',
            body: previewBody,
          }
        : null,
    primaryLabel:
      fenceLine(stored.primaryLabel, DECISION_LABEL_MAX_CHARS) ??
      DECISION_FALLBACK_PRIMARY,
    secondaryLabel:
      fenceLine(stored.secondaryLabel, DECISION_LABEL_MAX_CHARS) ??
      DECISION_FALLBACK_SECONDARY,
    ghostLabel:
      fenceLine(stored.ghostLabel, DECISION_LABEL_MAX_CHARS) ?? DECISION_FALLBACK_GHOST,
    approvedText:
      fenceLine(stored.approvedText, DECISION_RECEIPT_MAX_CHARS) ??
      DECISION_FALLBACK_APPROVED,
    dismissedText:
      fenceLine(stored.dismissedText, DECISION_RECEIPT_MAX_CHARS) ??
      DECISION_FALLBACK_DISMISSED,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    resolvedAt: stored.resolvedAt,
    staleReason: fenceLine(stored.staleReason, DECISION_DETAIL_MAX_CHARS),
    // The plugin's queues are the plugin's business (invariant 1); what a
    // reader needs to know is when the thing they approved will actually
    // happen. On the unattended path that is the host's deferred replay
    // (`replayDueAt`). On the attended path (TASK-574) it is when the warm
    // agent is TOLD — the plugin holds the continuation until the undo window
    // closes (`deliveryDueAt`). The two never overlap on one row; replay wins
    // if a producer ever sent both, since that is the call itself going out.
    pendingUntil: stored.replayDueAt ?? stored.deliveryDueAt ?? null,
    /*
      Can this still be taken back?

      Only while the call has NOT been made. `consumedAt` records the agent
      taking the standing authorisation up at the pre-call gate; `replayedAt`
      records the host performing the call itself; `replayClaimedAt` records
      the host STARTING to perform it — the flight between claim and replay
      during which the call is already going out. Any of the three means
      something went out, and undo does not un-send an email — so the
      affordance is not offered at all rather than offered and refused.

      `deliveredAt` (TASK-574) is the attended path's version of the same
      line: the deferred resolution has reached the warm agent, which may
      already be re-issuing its call, and `store.restore` refuses the row.
      Offering Undo there would be the TASK-280 lie. Absent on an older
      producer, which reads as not-yet-delivered, exactly as before.

      A button that cannot do what it names is the worst control this surface
      could ship: it teaches people that the safety net is there when it is
      not, which is exactly the belief that makes an approval queue dangerous.

      The TIME window is not part of this. That is `UNDO_WINDOW_MS` measured
      from `resolvedAt`, counted down by the client so the button disappears on
      a clock rather than on the next poll.
    */
    undoable:
      (stored.status === 'executed' ||
        stored.status === 'approved-pending-agent' ||
        stored.status === 'dismissed') &&
      stored.resolvedAt !== null &&
      stored.consumedAt === null &&
      stored.replayedAt === null &&
      stored.replayClaimedAt === null &&
      (stored.deliveredAt ?? null) === null,
  };
}

/**
 * How much of a filename this surface will carry as a LABEL. Longer than a
 * feed row's 60 because a path is legitimately `notes/2026/q3-summary.md` and
 * chopping it at 60 turns two distinct files into the same row.
 */
export const FILE_LABEL_MAX_CHARS = 120;

/**
 * How much of a past conversation's title this surface will carry.
 *
 * TASK-436 review finding. The labels leaving this file mostly go through
 * `fenceLine` — summaries, details, button labels, file names, activity lines
 * — and this one did not, although a conversation title is GENERATED (the
 * title plugin asks a model for it) and is therefore exactly the kind of
 * string the fence exists for. It rendered in the read-only banner, and that
 * card was about to give it a `title` attribute as well, which is one more
 * sink for a value that had never been bounded or stripped of bidi overrides.
 *
 * NOT THE LAST ONE, and the honest version of that sentence matters. A second
 * review pass found the learned-memory doc `name` was the same shape of thing
 * — a one-line label that crossed a boundary unfenced — and TASK-480 fenced
 * it. (That read, `memory:learned:read`, was removed in TASK-608.) The
 * owner-authored `displayName` on the rail is not fenced here, on purpose:
 * `@ax/agents` owns it, and since TASK-558 its store refuses the same
 * character class at the write (`DISPLAY_NAME_FORBIDDEN`) and fences rows
 * written before that on every read (`fenceStoredDisplayName`). So it arrives
 * here already clean, from the one place that stores it, rather than being
 * fixed in one of its several readers. The first draft of this comment
 * claimed every other label was fenced; a grep said otherwise at the time.
 *
 * 120 is `FILE_LABEL_MAX_CHARS` — a banner and a rail row are the same size
 * of thing — and the fallback below is unchanged, so a title that fences to
 * nothing still reads as "Untitled conversation" rather than as a blank. That
 * is a small improvement on its own: a title of nothing but invisibles used to
 * draw an empty banner.
 */
export const CONVERSATION_TITLE_MAX_CHARS = 120;

/**
 * How many rows one listing will carry, and how much of one file we will send.
 *
 * Both are bounds on somebody else's output. An agent can write a hundred
 * thousand files and a gigabyte into one of them; neither number is a reason
 * for this process to build a hundred-megabyte JSON string. When either bound
 * bites, the response SAYS SO rather than quietly serving less than it claims.
 */
export const WORKSPACE_FILES_MAX = 500;
export const FILE_BODY_MAX_BYTES = 128 * 1024;

/** How far in we look for a NUL before calling a file "not text". */
const BINARY_PROBE_BYTES = 8000;

/** What a row says when the agent's filename fences down to nothing legible. */
export const UNREADABLE_FILE_NAME = 'A file with no readable name';

/**
 * The one predicate for "is this the agent's work, or is it our machinery?".
 *
 * Used by BOTH the listing and the read. One predicate, deliberately: an
 * exclusion only the listing enforces is not an exclusion, it is a cosmetic
 * filter with a direct-URL bypass sitting behind it.
 *
 *   - `.ax/**`     — identity, routines, uploads. Ours, and edited elsewhere.
 *   - `.claude/**` — runner machinery.
 *   - `memory/**`  — the Memory tab owns this, and it has DIFFERENT editing
 *                    rules (AW-13: one tier is human-owned and kept word for
 *                    word, the rest is the agent's own notes). Two tabs making
 *                    two different promises about one file is how a
 *                    hand-written rule gets eaten.
 *
 * `permanent/memory/**` is listed alongside `memory/**` because the memory
 * package has TWO layouts for the same tier: `memory/**` in the workspace tree
 * the agent actually reads, and `permanent/memory/**` in the host-local
 * scratch the CLI preset writes when there is no workspace backend. The plan
 * for this task named only the second, which never appears in a
 * `workspace:list` from a real backend — so naming only it would have excluded
 * nothing at all where it matters. Both are here.
 */
export const WORKSPACE_FILES_HIDDEN_PREFIXES: readonly string[] = [
  '.ax/',
  '.claude/',
  'memory/',
  'permanent/memory/',
];

export function isServableWorkspaceFile(path: string): boolean {
  if (path.length === 0) return false;
  return !WORKSPACE_FILES_HIDDEN_PREFIXES.some(
    (prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
  );
}

/**
 * A file's text, with the characters that rewrite a surface removed.
 *
 * The sibling of `fenceLine`, and different from it on purpose. `fenceLine`
 * flattens all whitespace because it is producing a LABEL — one row, one line.
 * A body is a document: newlines and tabs are its structure, and collapsing
 * them would turn a markdown file into one long paragraph. So this strips the
 * same bidi / zero-width / control family MINUS tab, newline and carriage
 * return.
 *
 * They are removed rather than replaced with a space, because in a document
 * the separators that do real work are the ones we are keeping anyway.
 */
export function fenceBody(text: string): string {
  return stripSurfaceRewritersFromDocument(text);
}

/** Shared so a clipped read and a whole read decode identically. */
const FILE_DECODER = new TextDecoder('utf-8');

/**
 * Bytes → what the Files tab can honestly show.
 *
 * A workspace holds whatever the agent put in it, which includes PNGs, PDFs
 * and sqlite files. Decoding one of those as UTF-8 produces a page of
 * replacement characters that LOOKS like a corrupted document — so we say
 * "this is not a text file" instead, and let the tab render that.
 */
export function decodeFileBody(bytes: Uint8Array): {
  body: string | null;
  clipped: AgentFileResponse['clipped'];
} {
  const probe = bytes.subarray(0, Math.min(bytes.length, BINARY_PROBE_BYTES));
  if (probe.includes(0)) return { body: null, clipped: 'binary' };
  if (bytes.length > FILE_BODY_MAX_BYTES) {
    return {
      body: fenceBody(FILE_DECODER.decode(bytes.subarray(0, FILE_BODY_MAX_BYTES))),
      clipped: 'too-large',
    };
  }
  return { body: fenceBody(FILE_DECODER.decode(bytes)), clipped: null };
}

/**
 * The response adapter a DOWNLOAD needs, on top of the one every other route
 * on this surface uses.
 *
 * `RouteResponse` (routes-chat.ts) is deliberately tiny — status, json, text,
 * end — because that is all a JSON surface needs, and every test in this
 * package builds one by hand. Widening it would make every one of those fakes
 * a compile error for the benefit of two routes. So the two routes declare the
 * extra shape they use, and it is still the same duck-typed mirror of
 * `@ax/http-server`'s `HttpResponse` (invariant I2 — no cross-plugin import).
 */
export interface DownloadRouteResponse extends RouteResponse {
  status(n: number): DownloadRouteResponse;
  header(name: string, value: string): DownloadRouteResponse;
  /** Raw bytes. Single-shot, like every other terminator on this adapter. */
  body(buf: Buffer, contentType?: string): void;
}

/**
 * THE content type of every download this surface serves.
 *
 * Not derived from the bytes, not read off the file's extension, and — most of
 * all — never taken from anything the caller sent. Every one of those is a way
 * for the file's own content to decide how a browser treats it, and the file
 * was written by an agent. `text/html` on an agent-authored file is stored XSS
 * on our origin; `image/svg+xml` is the same thing wearing a picture.
 *
 * `application/octet-stream` plus `nosniff` plus `Content-Disposition:
 * attachment` is the boring combination that means "save this, do not run it".
 * The cost is that a PNG will not preview in a tab. That is the intended
 * trade: this is a download affordance, and previewing is what the Files tab
 * already does, in a renderer we control.
 */
const DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';

/**
 * One file's bytes, as a download, with the headers that keep it one.
 *
 * `path` is the RAW workspace key. Only its last segment reaches the header,
 * and only after `sanitizeContentDispositionFilename` — the name is
 * agent-authored, and `Content-Disposition` is a header a newline can end.
 */
function sendFileDownload(
  res: DownloadRouteResponse,
  path: string,
  bytes: Uint8Array,
): void {
  // A view over the same memory, not a copy: these files are already as big as
  // this process is willing to hold, and doubling that to add a header would
  // be a strange way to spend a megabyte.
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const filename = sanitizeContentDispositionFilename(basenameOf(path));
  res.status(200);
  // Stated, not defaulted. `body()` would fall back to the same value, but a
  // route that serves somebody else's bytes should say what it is serving them
  // as rather than inherit it — and the day the framework's default changes,
  // this one does not.
  res.header('content-type', DOWNLOAD_CONTENT_TYPE);
  res.header('content-disposition', `attachment; filename="${filename}"`);
  res.header('x-content-type-options', 'nosniff');
  // No `content-length` here: `@ax/http-server` pins it from the buffer it is
  // about to write. A second copy computed here could only ever agree with it
  // or be wrong, and the framework's would win either way (invariant 4).
  res.body(buf);
}

/**
 * How many children of one durable-tier directory a response will carry.
 *
 * Smaller than the reader's own cap on purpose: the reader bounds what this
 * PROCESS reads off an NFS mount, this bounds what one HTTP response carries.
 * Two different resources, two different numbers, and the response says when
 * this one bites.
 */
export const USER_FILES_ENTRIES_MAX = 500;

/** The last segment of a raw key — the label the viewer heads a file with. */
export function basenameOf(rawPath: string): string {
  const cut = rawPath.lastIndexOf('/');
  return cut === -1 ? rawPath : rawPath.slice(cut + 1);
}

/** One durable-tier child → one row. The key raw and joined, the label fenced. */
export function toUserFileEntry(
  parentPath: string,
  entry: { name: string; kind: 'file' | 'dir' },
): UserFileEntry {
  return {
    path: parentPath === '' ? entry.name : `${parentPath}/${entry.name}`,
    name: fenceLine(entry.name, FILE_LABEL_MAX_CHARS) ?? UNREADABLE_FILE_NAME,
    kind: entry.kind,
  };
}

/** One workspace path → one row. The key raw, the label fenced. */
export function toFileSummary(path: string): WorkspaceFileSummary {
  return {
    path,
    name: fenceLine(path, FILE_LABEL_MAX_CHARS) ?? UNREADABLE_FILE_NAME,
  };
}

/**
 * What we say under "What it did" when we cannot say what it did.
 *
 * A routine fire records THAT it ran, when, how it was triggered and whether
 * it failed. It does not record a summary of what it produced — the agent's
 * output goes to the conversation the fire opened, and nothing copies a
 * sentence of it back onto the fire row.
 *
 * Until TASK-419 this surface papered over that by printing the routine's NAME
 * as the whole row. On the default self-improvement routine that reads, in
 * full, `heartbeat` — a bare identifier sitting where a sentence about the
 * agent's work belongs, which tells the reader nothing and looks like machinery
 * leaking through. Naming the routine is fine; presenting the name AS the
 * answer is not.
 *
 * So the row says both halves out loud: what ran, and that we do not have a
 * summary of what it did. Stating the gap is the honest move and it keeps the
 * gap visible — a row that silently reads like a label is one nobody ever
 * fixes. (Same rule as the "It failed, and no reason was recorded." sentence
 * below: we would rather admit a blank than dress one up.)
 */
export const FIRE_NO_SUMMARY = "We don't have a summary of what it did.";

/** The same admission when even the routine's name is unreadable. */
export const FIRE_UNNAMED_SENTENCE =
  "A routine ran. We don't have a readable name for it, or a summary of what it did.";

/**
 * The routine a fire belongs to, as a reader should see it named — or `null`
 * when nothing legible is left.
 *
 * Both the authored name and the path are the agent's own words, so both go
 * through the fence. A name fenced down to nothing falls through to the path
 * exactly as an absent one does, and a row whose every candidate label is
 * unprintable still gets a row — dropping it would claim the agent did
 * nothing, which is the bigger lie.
 *
 * `nameByPath` supplies the routine's AUTHORED name. When a routine has been
 * deleted its fires survive it, so the path is the fallback: it is the truest
 * thing still known about that row, and it is not a guess at what the routine
 * used to be called.
 */
export function fireLabel(
  fire: FireRow,
  nameByPath: ReadonlyMap<string, string>,
): string | null {
  return (
    fenceLine(nameByPath.get(fire.path), ACTIVITY_LABEL_MAX_CHARS) ??
    fenceLine(fire.path, ACTIVITY_LABEL_MAX_CHARS)
  );
}

/**
 * One fire → one feed row, or `null` for a fire that produced nothing.
 *
 * `silenced` maps to `null` and that is the whole point of this function. A
 * silenced fire ran the trigger, decided there was nothing to say, and stopped.
 * Rendering "Inbox digest — done" over it would be a receipt for an outcome
 * nobody observed, which is honesty rule H1 — the exact failure this surface
 * cannot afford. It is not rendered dimmed, or collapsed, or as "no change".
 * It is not rendered.
 *
 * The headline is a SENTENCE, not a label — see {@link FIRE_NO_SUMMARY} for
 * why, and {@link fireLabel} for how the routine in it gets named.
 */
export function fireToActivityEvent(
  fire: FireRow,
  nameByPath: ReadonlyMap<string, string>,
): ActivityEvent | null {
  if (fire.status === 'silenced') return null;
  const stamp = fireStamp(fire.firedAt);
  if (Number.isNaN(stamp)) return null; // An undateable row cannot be filed.
  const at = new Date(stamp).toISOString();
  const label = fireLabel(fire, nameByPath);
  const text =
    label === null ? FIRE_UNNAMED_SENTENCE : `Ran ${label}. ${FIRE_NO_SUMMARY}`;
  return {
    // Composite, and stable across pages. Never the fire's BIGSERIAL id.
    // Deliberately the RAW path: this is a key, not a label — it is never
    // rendered, and fencing it could collapse two distinct paths onto one id.
    id: `${fire.agentId}|${fire.path}|${at}`,
    agentId: fire.agentId,
    at,
    text,
    kind: fire.status === 'error' ? 'stopped' : 'done',
    detail:
      fire.status === 'error'
        ? // Never an empty string, and never an invented cause. "We don't know
          // why" is a true sentence; a plausible reason would not be. A
          // recorded error that is blank or all whitespace is the same absence
          // as a null one — passing it through would render a row that says
          // something went wrong with nothing at all underneath it. An error
          // made only of control or bidi characters is that same absence
          // wearing a costume, so the fence runs FIRST and its `null` lands on
          // the same sentence.
          (fenceLine(fire.error, ACTIVITY_DETAIL_MAX_CHARS) ??
          'It failed, and no reason was recorded.')
        : null,
    tag: TRIGGER_LABEL[fire.triggerSource] ?? null,
    // A routine fire has no decision behind it. Decision receipts are the
    // feed's OTHER source and carry their own id — see
    // `receiptToActivityEvent` below.
    decisionId: null,
  };
}

/**
 * One decision receipt → one feed row, or `null` for a receipt we cannot place
 * in time.
 *
 * The receipt is DERIVED by @ax/decisions from the decision row on every read.
 * That is what makes this surface's job small: there is no receipt store to
 * reconcile with, no removal path, and an undone execution's row simply stops
 * being returned — which is how "an undone execution's receipt disappears"
 * became true without a line of code here doing anything about it.
 *
 * The prose is HOST-AUTHORED, and it is fenced anyway. `approvedText` is built
 * from a capability clause and a tool name that arrive from MCP servers and
 * agent-authored skills, so this is the trust boundary; fencing here bounds
 * what goes on the WIRE, which is the only place a second renderer cannot
 * forget to do it. Same reasoning as `toWireDecision`, a few hundred lines up.
 *
 * `text` is the RECEIPT and `detail` is the executor's own message, never the
 * other way round. A host tool's failure text can quote model-authored input
 * back at us, so it rides beside our claim as audit-trail detail and is never
 * mistaken for our voice. Unlike a failed routine fire, a missing detail needs
 * no stand-in sentence: the subject line already says it did not work, and
 * "no reason was recorded" underneath that would be noise under a sentence
 * that is already complete.
 */
/**
 * How each outcome draws — TOTAL over the union, on purpose (TASK-447).
 *
 * This was three ternaries reading `r.outcome === 'failed'`, which meant every
 * outcome that was not `failed` rendered as an approval: the right answer for
 * the three that existed, and a silent lie the moment a fourth arrived. A
 * `Record` keyed on the union cannot do that — adding an outcome and not
 * deciding how it looks is a build error.
 *
 * `fallback` is per-outcome for the same reason and it is the load-bearing one.
 * A receipt that fenced away entirely must still say something, but WHAT it
 * says is not interchangeable: "You approved this." printed over a decision the
 * person turned down is precisely the derived-from-the-wrong-outcome lie that
 * `approvedText` and `dismissedText` are kept as separate authored strings to
 * prevent. Three of the five sentences are host constants that cannot fence
 * away today; the map is total anyway, because "cannot happen" is not a thing
 * this file is willing to encode about a string it did not write.
 */
const RECEIPT_RENDERING: Record<
  DecisionReceiptRow['outcome'],
  { kind: ActivityEvent['kind']; tag: string; fallback: string }
> = {
  executed: {
    kind: 'approved',
    tag: DECISION_RECEIPT_TAG,
    fallback: DECISION_FALLBACK_APPROVED,
  },
  'pending-agent': {
    kind: 'approved',
    tag: DECISION_RECEIPT_TAG,
    fallback: DECISION_FALLBACK_APPROVED,
  },
  failed: {
    kind: 'stopped',
    tag: DECISION_RECEIPT_TAG,
    fallback: DECISION_FALLBACK_FAILED,
  },
  declined: {
    kind: 'dismissed',
    tag: DECISION_UNRESOLVED_TAG,
    fallback: DECISION_FALLBACK_DISMISSED,
  },
  expired: {
    kind: 'expired',
    tag: DECISION_UNRESOLVED_TAG,
    fallback: DECISION_FALLBACK_EXPIRED,
  },
};

export function receiptToActivityEvent(
  r: DecisionReceiptRow,
  /**
   * Called instead of silence when a row is dropped for an outcome this build
   * cannot name. The drop itself is right — see below — but a row vanishing
   * with nothing said is the shape this whole change exists to remove, so the
   * route passes its logger through rather than letting the last one go quiet.
   * Optional because the mapping is otherwise pure and every other caller (and
   * every test) wants it that way.
   */
  onUnknownOutcome?: (outcome: string) => void,
): ActivityEvent | null {
  const stamp = Date.parse(r.at);
  if (Number.isNaN(stamp)) return null; // An undateable row cannot be filed.
  // An outcome this build has never heard of is DROPPED, not guessed at. The
  // plugin is duck-typed across the bus (I2), so a newer @ax/decisions can send
  // one; rendering it as an approval because that is what the old ternary did
  // is how a decline became a "You approved this." row in the first place.
  //
  // Unreachable in a single-commit deployment — `DecisionReceiptSchema`'s
  // `returns` validation refuses an unknown outcome before it gets here — and
  // kept anyway, because "the layer above catches it" is exactly the reasoning
  // that left the old ternary looking safe.
  const style = RECEIPT_RENDERING[r.outcome];
  if (style === undefined) {
    onUnknownOutcome?.(r.outcome);
    return null;
  }
  return {
    // Composite and stable, in the same shape a fire's id takes. The decision
    // id is a KEY — never rendered — so it goes in raw; fencing it could
    // collapse two distinct decisions onto one row.
    id: `${r.agentId}|decision|${r.decisionId}`,
    agentId: r.agentId,
    at: new Date(stamp).toISOString(),
    // A receipt that fenced away entirely would say nothing at all, which
    // reads as "we are not sure what you did". Every outcome keeps a plain
    // sentence rather than an empty row — its OWN sentence.
    text: fenceLine(r.receipt, DECISION_RECEIPT_MAX_CHARS) ?? style.fallback,
    kind: style.kind,
    detail:
      r.outcome === 'failed' ? fenceLine(r.error, ACTIVITY_DETAIL_MAX_CHARS) : null,
    tag: style.tag,
    decisionId: r.decisionId,
  };
}

/**
 * Is this a "the row isn't yours / isn't there" answer, or a real failure?
 *
 * Only the first kind may be degraded into an empty thread or a 404. A generic
 * throw means we don't know what happened, and "we don't know" must never
 * render as "there is nothing here" (design H7).
 */
function isBenignConversationRead(err: unknown): boolean {
  if (!(err instanceof PluginError)) return false;
  return err.code === 'not-found' || err.code === 'forbidden';
}

/**
 * The renderable text of a turn: its `text` blocks and nothing else.
 *
 * THIS FILTER IS LOAD-BEARING, not a formatting choice. The workspace calls
 * `conversations:get` UNFILTERED — chat gates reasoning behind
 * `?includeThinking=true` and this surface has no such gate — so keeping
 * `type === 'text'` and only that is the ONE thing keeping the model's
 * scratchpad off the workspace wire (invariant J4). Loosening it breaches J4
 * silently, with nothing failing.
 *
 * Tool blocks are not text either, and they do not become text here. TASK-352
 * renders them as their own thing — a step panel, built by `turnToolCalls` +
 * `shapeSteps` below and carried in separate fields — which is additive to
 * this filter rather than a relaxation of it.
 */
function renderableText(blocks: TurnBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
      parts.push(b.text);
    }
  }
  return parts.join('\n\n').trim();
}

/**
 * How each tool call ended, keyed by the call it answers.
 *
 * Built across ALL turns before any of them is shaped, because a `tool_result`
 * lives in a tool-role turn of its own — the turn AFTER the assistant turn
 * that called it. Pairing them one turn at a time would find nothing.
 */
function toolOutcomes(
  turns: TurnRow[],
): Map<string, { isError: boolean; held: boolean }> {
  const out = new Map<string, { isError: boolean; held: boolean }>();
  for (const turn of turns) {
    for (const block of turn.contentBlocks ?? []) {
      if (block.type !== 'tool_result') continue;
      if (typeof block.tool_use_id !== 'string') continue;
      out.set(block.tool_use_id, {
        isError: block.is_error === true,
        held: block.held === true,
      });
    }
  }
  return out;
}

/**
 * One turn's `tool_use` blocks, paired with their outcomes.
 *
 * A call with NO result row is `running`, not `done`: the transcript records
 * what happened, and "we called it and nothing came back" is a different fact
 * from "it finished". That is the same reading `lib/tool-step-status.ts` gives
 * chat, and the ordering below is its ordering — held above failed, because a
 * call waiting on a person has not failed, and the runners publish held
 * results with `is_error` omitted.
 */
function turnToolCalls(
  blocks: TurnBlock[],
  outcomes: ReadonlyMap<string, { isError: boolean; held: boolean }>,
  live: LiveHolds | null,
): WorkspaceToolCall[] {
  const calls: WorkspaceToolCall[] = [];
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue;
    if (typeof block.id !== 'string' || typeof block.name !== 'string') continue;
    const outcome = outcomes.get(block.id);
    const status: WorkspaceStepStatus =
      outcome === undefined
        ? 'running'
        : outcome.held
          ? 'waiting'
          : outcome.isError
            ? 'failed'
            : 'done';
    calls.push({
      id: block.id,
      name: block.name,
      phrase: block.activityPhrase,
      detail: stepDetail(block.input),
      status,
    });
  }
  // `held` is what was true at turn end; whether the question is STILL open
  // is the decision store's to say (TASK-517). See `settleHolds`.
  return settleHolds(calls, live);
}

/**
 * Turns → thread messages. Turns with nothing to show are dropped, not blanked.
 *
 * "Nothing to show" now means no text AND no tool calls (TASK-352). An
 * assistant turn that only ran tools used to vanish here, which is how a turn
 * that did six things could render as if the agent had said nothing at all.
 */
/**
 * The files a user turn carried, as the transcript stored them (TASK-424).
 *
 * The transcript is the person's own record of their conversation, and it was
 * silently omitting something they did: the model received the image and
 * described it while the thread showed no trace of it at all. This is the read
 * that puts it back.
 *
 * EVERY FIELD IS CHECKED rather than spread. These blocks are persisted turn
 * content — the same wire that carries model output — so a block missing a
 * `path` or carrying a non-string `displayName` is dropped here rather than
 * reaching the client as a half-shaped row that the renderer then has to guess
 * about. `sizeBytes` is the one optional: it is a nicety on the chip, and a
 * chip without it still names the file.
 */
function turnAttachments(blocks: TurnBlock[]): ThreadAttachment[] {
  const out: ThreadAttachment[] = [];
  for (const block of blocks) {
    if (block.type !== 'attachment') continue;
    if (typeof block.path !== 'string' || block.path.length === 0) continue;
    if (typeof block.displayName !== 'string' || block.displayName.length === 0) {
      continue;
    }
    if (typeof block.mediaType !== 'string' || block.mediaType.length === 0) {
      continue;
    }
    out.push({
      path: block.path,
      displayName: block.displayName,
      mediaType: block.mediaType,
      ...(typeof block.sizeBytes === 'number' && Number.isFinite(block.sizeBytes)
        ? { sizeBytes: block.sizeBytes }
        : {}),
    });
  }
  return out;
}

/**
 * How long a replayed failure's `reason` code may be.
 *
 * There is no twin for this one — it is this route's own judgement that a
 * stable code is short, and anything longer is not one (the renderer falls
 * back to the generic label for it either way). The `detail` ceiling
 * deliberately has NO local constant: it is imported from the renderer's own
 * `MAX_DETAIL_CHARS`, because two numbers for one boundary is how the ends
 * come to disagree about where a sentence stops (invariant 4).
 */
const TURN_ERROR_REASON_MAX_CHARS = 120;

/**
 * The failures this conversation recorded, as thread rows (TASK-498).
 *
 * WHAT WAS BROKEN. `chat:turn-error` has been persisted since TASK-66 and
 * projected onto `conversations:get`'s `displayEvents` ever since — and a
 * repo-wide grep for that field found NO reader at all. The live surfaces
 * flip out of "Thinking…" off the SSE frame and then forget; the durable
 * record was write-only. So a turn that died left the person's message
 * sitting alone on the next read, as if they had never asked for a reply.
 *
 * WHAT TRAVELS: the stable `reason` code and the optional bounded `detail`
 * line, exactly the two fields the live SSE `error` frame carries. NOT a
 * sentence — the wording is `lib/turn-error-labels.ts`' job on both paths, so
 * a reloaded failure cannot word itself differently from the live one it
 * replaces, and a raw reason code can never reach a reader (TASK-296).
 *
 * `reqId` DOES NOT TRAVEL AS A FIELD, and that is the honest version of the
 * claim: the event's `key` IS the originating reqId (`@ax/conversations`'
 * `persistTurnError` folds on it), so it is inside the row id
 * `turn-error:<key>` and this row is not free of it. What it is free of is a
 * reqId the client could READ — there is no such field, the id is opaque, and
 * nothing on the other side parses it. That is the property worth having:
 * the id is stable across re-reads, so a re-fired turn-error replaces its
 * earlier row instead of stacking a second one, and the client gets that for
 * free without ever learning what host routing vocabulary is.
 */
function errorMessages(
  events: readonly DisplayEventRow[],
): Array<{ at: string; msg: ThreadMessage }> {
  const out: Array<{ at: string; msg: ThreadMessage }> = [];
  for (const ev of events) {
    if (ev.kind !== 'turn-error') continue;
    /*
      Every field checked, never spread: this payload is an opaque JSONB blob
      and a half-shaped row reaching the client is a renderer guessing.

      `createdAt` is checked for the same reason: it is what the merge below
      sorts on, so a missing one would silently park the failure at the end of
      the thread rather than beside the message it answers.

      AN EMPTY `key` IS KEPT, and that is a correction rather than laxity. The
      persist side folds a turn-error on its originating reqId and writes the
      EMPTY STRING when there isn't one (`@ax/conversations`' persistTurnError),
      so dropping empty keys here meant the store recorded a failure that this
      read then refused to show — the two halves disagreeing about the same
      row, which is the bug this card exists to end. The fold makes it safe:
      one empty-key turn-error per conversation, so `turn-error:` is as stable
      and as unique an id as any other.
    */
    if (typeof ev.key !== 'string') continue;
    if (typeof ev.createdAt !== 'string' || ev.createdAt.length === 0) continue;
    const reason = ev.payload.error;
    if (typeof reason !== 'string' || reason.length === 0) continue;
    /*
      BOUNDED HERE TOO, not only at the renderer. The live SSE `detail` is
      bounded where it is produced and clamped again in the client; this copy
      comes back out of a JSONB column that outlives both and can be reached by
      anything with database access. An unbounded string would ship whatever it
      found straight down the wire before the client's clamp ever saw it, which
      is a size problem, not a wording one. Same rule as every other string
      this file emits.
    */
    const raw = ev.payload.detail;
    const detail = typeof raw === 'string' ? raw.slice(0, MAX_DETAIL_CHARS) : '';
    out.push({
      at: ev.createdAt,
      msg: {
        kind: 'error',
        id: `turn-error:${ev.key}`,
        reason: reason.slice(0, TURN_ERROR_REASON_MAX_CHARS),
        ...(detail.length > 0 ? { detail } : {}),
        at: ev.createdAt,
      },
    });
  }
  return out;
}

/**
 * The refused saves this conversation recorded, as thread rows (TASK-731).
 *
 * The host refused a reply's end-of-turn save (or the runner's last flush,
 * which has no turn) and the runner undid those files. TASK-720 told the
 * person on the live `done` frame only; the host now persists the refusal as
 * a `save-refused` display event so a reload still shows it.
 *
 * WHAT TRAVELS: the closed `code`, and nothing else from the payload. The
 * sentence is the renderer's job (`save-refused-copy.ts`), so no stored string
 * can ever reach a reader. Same posture as `errorMessages`: every field
 * checked, never spread; a row with no instant to sort on, a key that cannot
 * make a stable id, or a code that is not exactly one of the three is dropped
 * rather than half-drawn. An EMPTY key is kept, for the turn-error reason: the
 * persist side writes `''` for a turn with no reqId and folds on it.
 *
 * The id is `saveRefusedRowId(key)` — the per-turn key is the reqId, which
 * `AgentView` uses to stop drawing its live copy once this row lands. Like the
 * turn-error id it is opaque to the client beyond that one equality check.
 */
function saveRefusedMessages(
  events: readonly DisplayEventRow[],
): Array<{ at: string; msg: ThreadMessage }> {
  const out: Array<{ at: string; msg: ThreadMessage }> = [];
  for (const ev of events) {
    if (ev.kind !== 'save-refused') continue;
    if (typeof ev.key !== 'string') continue;
    if (typeof ev.createdAt !== 'string' || ev.createdAt.length === 0) continue;
    const payload: unknown = ev.payload;
    if (payload === null || typeof payload !== 'object') continue;
    const code = asSaveRefusedCode((payload as Record<string, unknown>).code);
    if (code === undefined) continue;
    out.push({
      at: ev.createdAt,
      msg: { kind: 'save-refused', id: saveRefusedRowId(ev.key), code },
    });
  }
  return out;
}

/**
 * Interleave the turns with the host-only rows (turn failures, refused
 * saves), by instant.
 *
 * TURNS WIN A TIE. A turn-error is the thing that ENDED a turn, so when its
 * timestamp collides with a turn's it belongs after it, never before — an
 * error drawn above the message it answers reads as a failure that happened
 * first. A refused save is written after the reply it is about, so the same
 * rule puts it under that reply.
 */
function buildThread(
  turns: TurnRow[],
  displayEvents: readonly DisplayEventRow[] = [],
  // The holds still being asked about in this conversation, or `null` when
  // that is not known — which leaves every held step reading as waiting.
  live: LiveHolds | null = null,
  // TASK-744 — namespace → connector name for the reader, so a connector
  // tool's step names its connector instead of an opaque hash.
  connectors: ConnectorNames = new Map(),
): ThreadMessage[] {
  const dated: Array<{ at: string; msg: ThreadMessage }> = [];
  const out: ThreadMessage[] = [];
  const outcomes = toolOutcomes(turns);
  const publishIds = new Set(turns.flatMap(turn => (turn.contentBlocks ?? []).flatMap(block =>
    block.type === 'tool_use' && typeof block.id === 'string' &&
    (block.name === 'artifact_publish' || block.name === 'mcp__ax-sandbox-tools__artifact_publish')
      ? [block.id] : [],
  )));
  for (const turn of turns) {
    // Tool outcomes hang off the assistant's step panel. Published files are
    // also drawn here, outside that collapsible panel, so a closed step list
    // cannot hide the deliverable.
    const blocks = turn.contentBlocks ?? [];
    if (turn.role === 'tool') {
      // Runner-authored output references and successful explicit publications.
      // Arbitrary assistant attachment blocks are still ignored. The download
      // endpoint independently checks conversation access and a durable row.
      const files = turnAttachments(blocks.filter(block => AttachmentBlockSchema.safeParse(block).success));
      for (const block of blocks) {
        if (block.type !== 'tool_result' || block.is_error || block.held ||
          !publishIds.has(block.tool_use_id ?? '')) continue;
        const texts = typeof block.content === 'string' ? [block.content]
          : Array.isArray(block.content) ? block.content.flatMap((c: unknown) =>
            c !== null && typeof c === 'object' && 'type' in c && c.type === 'text' &&
            'text' in c && typeof c.text === 'string' ? [c.text] : []) : [];
        for (const text of texts) {
          try {
            const value: unknown = JSON.parse(text);
            if (value === null || typeof value !== 'object') continue;
            const file = AttachmentBlockSchema.safeParse({ ...value, type: 'attachment' });
            if (file.success) files.push(...turnAttachments([file.data]));
          } catch { /* A failed/non-JSON publication has no download. */ }
        }
      }
      const attachments = [...new Map(files.map(file => [file.path, file])).values()];
      const text = renderableText(blocks);
      if (attachments.length > 0 || text.length > 0) dated.push({
        at: turn.createdAt,
        msg: { kind: 'agent', id: turn.turnId, text, at: turn.createdAt, attachments },
      });
      continue;
    }
    const text = renderableText(blocks);
    if (turn.role === 'user') {
      const attachments = turnAttachments(blocks);
      /*
        An empty bubble is worse than no bubble — but a turn carrying a FILE is
        not empty, and dropping it was how a caption-less attachment vanished
        from the person's own transcript entirely (TASK-424). The rule now
        reads "nothing to show", the same way the assistant branch below
        already does since TASK-352.
      */
      if (text.length === 0 && attachments.length === 0) continue;
      /*
        TASK-689 — the kickoff is the agent's opening, not something the person
        said. A new agent is woken with `KICKOFF_TEXT` because the runner can
        only start a turn from a user message; drawn here it reads as a message
        they never typed, so the agent's own greeting opens the thread instead.

        TURN 0 ONLY, only the exact sentence, and only with no file: the same
        words later in a conversation are somebody pasting them, and a turn that
        also carries a file is theirs — the kickoff never has one, and skipping
        it would take their file chip down with the words. (Titles are
        unaffected either way — they read the raw transcript.)
      */
      if (
        turn.turnIndex === 0 &&
        attachments.length === 0 &&
        text === KICKOFF_TEXT
      ) {
        continue;
      }
      dated.push({
        at: turn.createdAt,
        msg: {
          kind: 'user',
          id: turn.turnId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      });
      continue;
    }
    const panel = shapeSteps(turnToolCalls(blocks, outcomes, live), connectors);
    if (text.length === 0 && panel === null) continue;
    dated.push({
      at: turn.createdAt,
      msg:
        panel === null
          ? { kind: 'agent', id: turn.turnId, text, at: turn.createdAt }
          : {
              kind: 'steps',
              id: turn.turnId,
              text,
              at: turn.createdAt,
              stepsLabel: panel.label,
              steps: panel.steps,
            },
    });
  }
  /*
    A STABLE merge, not a re-sort of everything. The turn order comes out of
    the event log and is authoritative — several turns legitimately share one
    instant, and a comparator over the whole list could reorder them. So the
    turns keep their order and the failures are slotted in around them.
    (Refused saves ride the same merge. The sort is stable, so at one instant
    a turn-error comes before a refused save.)
  */
  const failures = [
    ...errorMessages(displayEvents),
    ...saveRefusedMessages(displayEvents),
  ].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  );
  let f = 0;
  for (const row of dated) {
    while (f < failures.length && failures[f]!.at < row.at) {
      out.push(failures[f]!.msg);
      f++;
    }
    out.push(row.msg);
  }
  for (; f < failures.length; f++) out.push(failures[f]!.msg);
  return out;
}

export interface WorkspaceHandlerDeps {
  bus: HookBus;
  initCtx: AgentContext;
  /**
   * The per-reqId chunk buffer, which also owns the durable pending-card
   * stores (TASK-373). `plugin.ts` always passes the SAME instance the SSE
   * handler and the card-fill subscriber write into — a second instance would
   * answer from a different world than the streams create. Optional only so
   * handler tests that never touch grants can omit it; with no buffer there
   * are no cards in this process to answer with, so the route answers an empty
   * list rather than failing (a configuration of the caller, not a fault —
   * the same posture the queue route takes without a decisions producer).
   */
  buffer?: ChunkBuffer;
  /**
   * Time seam for the "This week" window, and for the `declinedAt` a "Not now"
   * is recorded with (TASK-444). Injected so the counter's boundary is
   * testable — a counter whose definition cannot be tested at its edge is a
   * counter whose definition will drift.
   *
   * IT HAS A TWIN: `ChunkBufferOptions.now` in chunk-buffer.ts stamps the
   * `raisedAt` this `declinedAt` is compared against (`withoutDeclinedGrants`).
   * Production injects NEITHER — both are the system clock, which is the only
   * reason the comparison means anything. Nothing structurally forces that, so
   * a test that stubs one and not the other is comparing two unrelated clocks:
   * stub both or stub neither.
   */
  now?: () => Date;
}

export function makeWorkspaceHandlers(deps: WorkspaceHandlerDeps) {
  const { bus, initCtx } = deps;
  const buffer = deps.buffer;
  const now = deps.now ?? ((): Date => new Date());

  /**
   * The shared shape of the two `{ ids }` memory routes — Forget and its Undo
   * (TASK-630): auth, reachable agent, the service present, a body that is
   * exactly `{ ids: string[] }` of 1..100 non-empty ids. `run` does the call
   * and returns the 200 body; an `invalid-payload` from the hook is a 400.
   */
  async function idsFactsRoute(
    req: RouteRequest,
    res: RouteResponse,
    hook: string,
    run: (ctx: AgentContext, ids: string[]) => Promise<unknown>,
  ): Promise<void> {
    const userId = await authOr401(bus, initCtx, req, res);
    if (userId === null) return;
    const agentId = req.params.agentId ?? '';
    if (agentId.length === 0) {
      res.status(400).json({ error: 'missing-agent-id' });
      return;
    }
    const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
    if (agent === null) return;

    if (!bus.hasService(hook)) {
      res.status(503).json({ error: 'memory-unavailable' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body.toString('utf-8'));
    } catch {
      res.status(400).json({ error: 'invalid-json' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      res.status(400).json({ error: 'invalid-memory-request' });
      return;
    }
    const body = parsed as Record<string, unknown>;
    if (
      Object.keys(body).some((k) => k !== 'ids') ||
      !Array.isArray(body.ids) ||
      body.ids.length === 0 ||
      body.ids.length > 100 ||
      body.ids.some((id) => typeof id !== 'string' || id === '')
    ) {
      res.status(400).json({ error: 'invalid-memory-request' });
      return;
    }

    try {
      // Awaited BEFORE `res.status` is touched: a failed call must not have
      // already stamped a 200 on the response.
      const out = await run(agentWorkspaceCtx(agentId, userId), body.ids as string[]);
      res.status(200).json(out);
    } catch (err) {
      if (err instanceof PluginError && err.code === 'invalid-payload') {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }
      throw err;
    }
  }

  /**
   * Every conversation the caller owns under one agent, newest first.
   *
   * `strict` decides what a failure means. On the agent detail panel this list
   * IS the content — "no past conversations" is a claim — so a fault has to
   * surface. On the board it is one cell of a roster, and failing the whole
   * page because one agent's list hiccuped trades a small wrong for a big one;
   * there the agent simply reads `resting`, which is what "we don't know"
   * renders as everywhere else on this surface.
   */
  async function listConversations(
    userId: string,
    agentId: string,
    opts: { strict?: boolean; onUnreadable?: () => void } = {},
  ): Promise<ConversationRow[]> {
    if (!bus.hasService('conversations:list')) {
      opts.onUnreadable?.();
      return [];
    }
    try {
      const rows = await bus.call<ConversationsListInput, ConversationsListOutput>(
        'conversations:list',
        initCtx,
        { userId, agentId },
      );
      return [...rows].sort(byRecencyDesc);
    } catch (err) {
      if (opts.strict === true && !isBenignConversationRead(err)) throw err;
      // A non-strict caller degrades to "no conversations" — but it is TOLD,
      // so it can tell an empty list from an unreadable one before it builds a
      // sentence on top of the difference.
      opts.onUnreadable?.();
      initCtx.logger.warn('workspace_conversations_list_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * `working` iff a TURN IS RUNNING — which is what the word means to the
   * person reading it, and is not what this used to measure (TASK-498).
   *
   * IT USED TO PROBE `session:is-alive` over the agent's conversations, and
   * that answers a different question: whether a SANDBOX is up. Sandboxes are
   * deliberately kept warm between turns (TASK-124's idle keepalive) and
   * `chat:turn-end` explicitly clears `active_req_id` while KEEPING
   * `active_session_id`, so the probe stayed true long after the work stopped.
   * The walk on TASK-357 found the consequence: an agent whose turn had failed
   * read "Working" through a reload AND a host restart, with nothing running.
   * It was not a stuck turn — it was a warm sandbox being reported as busy,
   * and every agent that had ever answered anything read the same way until
   * the reaper got round to it.
   *
   * THE ACTIVITY LINE IS THE HONEST SIGNAL, and the route already reads it for
   * "Right now". `@ax/agent-activity` records on `chat:start` and forgets on
   * `chat:end` AND on `chat:turn-error` — so a turn that fails closes this out
   * on the same frame that puts the failure on screen, which is the coupling
   * this card needed and the probe could never have.
   *
   * AND ON THE TURN'S OWN `chat:turn-end` (TASK-686). Forgetting on `chat:end`
   * alone was the warm-sandbox bug over again, one layer down: under keepAlive
   * (the k8s preset) a turn completes on `chat:turn-end` and `chat:end` waits
   * for the idle reaper, so an agent that had already replied read "Working"
   * for up to the whole idle window. The record now tracks each turn by its
   * reqId and goes when the last one's turn-end arrives — before the SSE done
   * frame is written, since the per-connection subscriber is registered long
   * after the plugin's.
   *
   * ABSENCE STILL READS `resting`, on every branch: no activity producer
   * wired, a failed read, or a host that restarted and lost its in-memory
   * record. That is the route's standing rule — "we don't know" must never
   * render as "it's busy" — and a restart is the case that proves it, because
   * nothing survives one still running.
   *
   * THE LINE IS THE WHOLE TEST, and `status` is deliberately not re-checked
   * beside it: `readActivity` is the one producer of this value and carries a
   * null line on every branch that is not `ok` (its own tests pin that, and so
   * does "reports resting when the activity read FAILS"). A second condition
   * that no input can falsify reads as a guard and is really dead code — the
   * kind a mutant battery cannot kill, which is how it was found.
   *
   * WHAT THIS SIGNAL IS NOT, said here rather than left to be discovered.
   * `@ax/agent-activity` keys ONE record per agent and deletes it on the FIRST
   * `chat:end` it sees for that agent. Its per-turn ids (TASK-686) only govern
   * `chat:turn-end`, which ends just its own turn; they never hold the record
   * past an end, so this is still no refcount. So an agent
   * running two turns at once (a routine fire beside a chat, two open threads)
   * reads `resting` from the moment the first of them ends until the other's
   * next tool call re-creates the record.
   *
   * IT IS PINNED, BUT NOT HERE, and the reason is worth a line. This route
   * cannot tell the two-turns case apart from a single turn that simply
   * ended — both arrive as one absent activity record — so an assertion
   * written here would be indistinguishable from the `resting` tests beside
   * it and would pin nothing. The characterization lives with the PRODUCER
   * instead: "forgets the whole agent on the FIRST end, even with a second
   * turn still running" and "recovers the running turn on its next step",
   * both in `@ax/agent-activity`'s `plugin.test.ts`. A future refcount has to
   * change those, which is exactly where that decision belongs.
   *
   * IT IS LEFT THAT WAY ON PURPOSE, and the direction is the argument. This
   * route's standing rule is that "we don't know" renders as `resting`, and an
   * under-report obeys it: the reader sees a quiet chip above a conversation
   * that is visibly streaming, and the next step corrects it. A refcount would
   * be more precise and fails the OTHER way — one `chat:start` whose end never
   * arrives pins the agent on "Working" with nothing running, which is the bug
   * this card exists to end. Getting that right belongs in the activity
   * plugin, with its own card and its own leak story; it is not something to
   * bolt onto the reader of the signal.
   */
  function deriveState(activity: AgentRailData['activity']): AgentRunState {
    return activity.activity !== null ? 'working' : 'resting';
  }

  /**
   * The roster row.
   *
   * `now` / `counter` / `startedAt` come from the SAME read the rail uses, so
   * the Today strip and the rail cannot disagree about what an agent is doing.
   * All three stay null when there is no activity to report — a null renders as
   * the state word alone, and never as a placeholder phrase, because a
   * placeholder is indistinguishable from a claim.
   *
   * `stoppedReason` is still null: nothing stops an agent yet (AW-12).
   */
  function toWorkspaceAgent(
    agent: { id: string; displayName: string },
    state: AgentRunState,
    activity?: AgentRailData['activity'],
  ): WorkspaceAgent {
    const line = activity?.activity ?? null;
    return {
      id: agent.id,
      name: agent.displayName,
      state,
      now: line?.phrase ?? null,
      counter: line?.counter ?? null,
      startedAt: line?.startedAt ?? null,
      stoppedReason: null,
    };
  }

  /**
   * One agent's slice of the feed: its fires, plus the routine names to label
   * them with.
   *
   * `strict` splits the two callers the same way `listConversations` does. On
   * the per-agent tab this list IS the content, so a fault has to surface —
   * "nothing recorded" over a failed read is a claim we cannot back (H7). In
   * the roster-wide fan-out one agent's hiccup must not take the page down, so
   * it degrades to nothing and says so in the log.
   */
  async function firesForAgent(
    agentId: string,
    limit: number,
    before: Date | null,
    strict: boolean,
  ): Promise<FireRow[]> {
    if (!bus.hasService('routines:recent-fires-for-agent')) return [];
    try {
      const out = await bus.call<RecentFiresForAgentInput, RecentFiresForAgentOutput>(
        'routines:recent-fires-for-agent',
        initCtx,
        { agentId, limit, ...(before !== null ? { before } : {}) },
      );
      return out.fires ?? [];
    } catch (err) {
      if (strict) throw err;
      initCtx.logger.warn('workspace_activity_fires_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * One agent's slice of the OTHER half of the feed: its decision receipts.
   *
   * The same strict/non-strict split `firesForAgent` makes, for the same reason
   * and with one extra edge on it. A failed receipts read must never degrade
   * into rows-we-do-have, because that page looks COMPLETE: the routine fires
   * render, the feed has content, and every approval this agent ever acted on
   * is silently missing with nothing on the surface to say so. "We don't know"
   * rendering as "there is nothing here" is design H7, and it is the defect
   * family TASK-238 / TASK-264 / TASK-272 all sit in. So on the per-agent tab —
   * where this agent's history IS the page — the throw propagates and the route
   * fails loudly.
   *
   * In the roster-wide fan-out it degrades, exactly as the fires read does: one
   * agent's hiccup must not take the whole page down, and it is logged.
   *
   * `userId` is passed because the hook is owner-scoped. Reaching an agent is
   * not the same as being entitled to read every decision attached to it — a
   * team agent can carry several people's.
   */
  async function receiptsForAgent(
    agentId: string,
    userId: string,
    limit: number,
    before: Date | null,
    strict: boolean,
  ): Promise<DecisionReceiptRow[]> {
    // No @ax/decisions in this deployment means there are genuinely no
    // receipts. That is a configuration, not a fault, and it must not cost the
    // routine history that IS there.
    if (!bus.hasService('decisions:recent-receipts-for-agent')) return [];
    try {
      const out = await bus.call<
        DecisionsRecentReceiptsInput,
        DecisionsRecentReceiptsOutput
      >('decisions:recent-receipts-for-agent', initCtx, {
        userId,
        agentId,
        limit,
        ...(before !== null ? { before: before.toISOString() } : {}),
      });
      return out.receipts ?? [];
    } catch (err) {
      if (strict) throw err;
      initCtx.logger.warn('workspace_activity_receipts_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * TASK-744 — toolNamespace → connector display name (and, since TASK-753,
   * the server's cached tool titles), for ONE reader.
   *
   * Scoped to `userId` by `connectors:tool-labels` itself: it answers only for
   * connectors that person can resolve, so another owner's private connector
   * is never named here. The name is author-written and the titles come from
   * a third-party server, so both are fenced HERE (`connectorNamesFromRows`)
   * — they ride the wire (`AgentDetail.connectorTools`) as well as the shaped
   * rows. A namespace that is not the documented shape is dropped: it is a
   * lookup key the client matches against tool names, and a key that cannot
   * match anything is noise. A cache read end to end: no server is reached.
   *
   * A failed or missing read degrades to an empty map: connector tools are
   * then named by their tool name alone — a worse label, not a wrong one.
   */
  async function connectorNames(userId: string): Promise<ConnectorNames> {
    if (!bus.hasService('connectors:tool-labels')) return new Map();
    try {
      const out = await bus.call<ConnectorToolLabelsInput, ConnectorToolLabelsOutput>(
        'connectors:tool-labels',
        initCtx,
        { userId },
      );
      return connectorNamesFromRows(out.connectors);
    } catch (err) {
      initCtx.logger.warn('workspace_connector_tool_labels_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Map();
    }
  }

  /**
   * path → the routine's authored name, for one agent.
   *
   * ALWAYS scoped to one agent. `routines:list` with no `agentId` returns every
   * routine in the deployment, including other people's; asking it broadly to
   * save a round trip would hand one user another user's routine names.
   *
   * A failed read degrades to an empty map, which labels the rows with their
   * paths. That is a worse label, not a wrong one — unlike dropping the rows,
   * which would claim the agent did nothing.
   */
  async function routineNames(agentId: string): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (!bus.hasService('routines:list')) return names;
    try {
      const out = await bus.call<RoutinesListInput, RoutinesListOutput>(
        'routines:list',
        initCtx,
        { agentId },
      );
      for (const r of out.routines ?? []) names.set(r.path, r.name);
    } catch (err) {
      initCtx.logger.warn('workspace_activity_routine_names_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return names;
  }

  /**
   * The owner-routed context for one agent's workspace.
   *
   * Used by the memory tier AND the Files tab, because they are two views of
   * ONE store: build them separately and the day someone changes how a
   * workspace is addressed, one tab follows and the other quietly reads a
   * different agent's tree.
   *
   * `memory:rules:write` reaches `workspace:apply`, which routes on
   * `agentId` — hand it the wrong ctx and the write lands in another agent's
   * workspace. Constructing it HERE, from the authenticated caller and the
   * agent they just passed the ACL for, is what keeps that honest; reusing
   * `initCtx` (agentId `@ax/channel-web`, userId `system`) would not.
   *
   * The `userId` on this ctx no longer picks the repo — since TASK-257 the
   * workspace partition is `agentId` alone, so every user authorized to reach
   * an agent reads and writes the same tree. It still matters, for two
   * reasons, which is why it stays the AUTHENTICATED caller and never a
   * lookup of some notional owner: `workspace:apply` stamps it into
   * `delta.author`, making it the only record of WHO changed a shared file;
   * and the memory hooks carry it through to their own ctx checks.
   *
   * The workspace root is inherited from `initCtx` so the CLI preset — which
   * has no workspace backend and writes memory to the host filesystem — lands
   * in the same root everything else in that preset uses.
   */
  function agentWorkspaceCtx(agentId: string, callerUserId: string): AgentContext {
    return makeAgentContext({
      sessionId: 'workspace-surface',
      agentId,
      userId: callerUserId,
      workspace: initCtx.workspace,
    });
  }

  /** TASK-739 — this agent's effective connector set, read under the caller. */
  async function listEffectiveConnectors(
    agent: ResolvedAgent,
    callerUserId: string,
  ): Promise<ConnectorsListEffectiveOutput> {
    return bus.call<ConnectorsListEffectiveInput, ConnectorsListEffectiveOutput>(
      'connectors:list-effective',
      agentWorkspaceCtx(agent.id, callerUserId),
      {
        userId: callerUserId,
        attachmentIds: (agent.connectorAttachments ?? []).filter(isConnectorId),
        exclusions: (agent.connectorExclusions ?? []).filter(isConnectorId),
      },
    );
  }

  /**
   * TASK-741 — each connector's health for this caller on this agent, from
   * stored state only. Either source failing (or absent) degrades to `ok` for
   * what it would have said, logged: a missing error icon is the cheaper way
   * to be wrong than a list that will not load. `notLoaded` (TASK-745) comes
   * from the list itself, not a stored read, so it never degrades.
   */
  async function connectorHealth(
    agentId: string,
    callerUserId: string,
    connectorIds: string[],
    notLoaded: ReadonlySet<string>,
  ): Promise<{ health: Map<string, AgentConnectorHealth>; sharedSignIn: Set<string> }> {
    const out = new Map<string, AgentConnectorHealth>();
    const sharedSignIn = new Set<string>();
    if (connectorIds.length === 0) return { health: out, sharedSignIn };
    const ctx = agentWorkspaceCtx(agentId, callerUserId);
    const [signIn, inventory] = await Promise.all([
      (async (): Promise<{ marked: Set<string>; shared: Set<string> }> => {
        const none = { marked: new Set<string>(), shared: new Set<string>() };
        if (!bus.hasService('mcp-oauth:status-batch')) return none;
        try {
          // TASK-756 — name the agent so a team agent's SHARED sign-in counts
          // (marked once per agent, for every member), not only the caller's own.
          const r = await bus.call<
            { userId: string; agentId: string; connectorIds: string[] },
            McpOAuthStatusBatchOutput
          >('mcp-oauth:status-batch', ctx, { userId: callerUserId, agentId, connectorIds });
          return {
            marked: new Set(Array.isArray(r?.needsReconnect) ? r.needsReconnect : []),
            shared: new Set(Array.isArray(r?.shared) ? r.shared : []),
          };
        } catch (err) {
          initCtx.logger.warn('workspace_connector_health_signin_read_failed', {
            agentId,
            name: err instanceof Error ? err.name : 'unknown',
          });
          return none;
        }
      })(),
      (async (): Promise<Map<string, ConnectorInventoryStatus>> => {
        if (!bus.hasService('connectors:inventory-status-batch')) return new Map();
        try {
          const r = await bus.call<
            { userId: string; agentId: string; connectorIds: string[] },
            InventoryStatusBatchOutput
          >('connectors:inventory-status-batch', ctx, { userId: callerUserId, agentId, connectorIds });
          return new Map(
            (Array.isArray(r?.statuses) ? r.statuses : []).map((x) => [x.connectorId, x.status]),
          );
        } catch (err) {
          initCtx.logger.warn('workspace_connector_health_inventory_read_failed', {
            agentId,
            name: err instanceof Error ? err.name : 'unknown',
          });
          return new Map();
        }
      })(),
    ]);
    for (const id of connectorIds) {
      const h = healthOf(notLoaded, signIn.marked, inventory, id);
      out.set(id, h);
      if (h === 'needs-reconnect' && signIn.shared.has(id)) sharedSignIn.add(id);
    }
    return { health: out, sharedSignIn };
  }

  /**
   * TASK-756 — the last Retry per (person, connector): when it ran, under
   * which agent, and what its check found (`failed` = the check itself could
   * not run; `unavailable` = the sign-in could not be READ just now, so the
   * server was never asked). Shared by concurrent Retries, so a burst is one
   * check.
   */
  type RetryCheck = ConnectorInventoryStatus | 'failed' | 'unavailable';
  type RetryEntry = { at: number; agentId: string; checked: Promise<RetryCheck> };
  const retryCooldown = new Map<string, RetryEntry>();

  /**
   * TASK-765 — may this caller take a connector every member reaches off this
   * agent? Asked once per list. Absent or failing → false, logged by error
   * name only: a Remove item greyed out by mistake is the cheaper way to be
   * wrong, and the DELETE asks @ax/agents again regardless.
   */
  async function connectorExclusionAllowed(
    agentId: string,
    actor: { id: string; isAdmin: boolean },
  ): Promise<boolean> {
    if (!bus.hasService('agents:can-exclude-connector')) return false;
    try {
      const r = await bus.call<AgentsCanExcludeConnectorInput, AgentsCanExcludeConnectorOutput>(
        'agents:can-exclude-connector',
        agentWorkspaceCtx(agentId, actor.id),
        { actor: { userId: actor.id, isAdmin: actor.isAdmin }, agentId },
      );
      return r?.allowed === true;
    } catch (err) {
      initCtx.logger.warn('workspace_connector_can_exclude_failed', {
        agentId,
        name: err instanceof Error ? err.name : 'unknown',
      });
      return false;
    }
  }

  /**
   * TASK-739 — after a connector leaves an agent, clear what the agent held
   * for it: per-tool overrides under its tool namespaces, and the access the
   * caller approved for it. Resolves `true` only when every step answered.
   * Never throws: the detach already landed, and a leftover row is inert
   * (nothing reaches a connector that is not in the effective set).
   */
  async function clearConnectorLeftovers(
    ctx: AgentContext,
    ownerUserId: string,
    agentId: string,
    connectorId: string,
    toolNamespaces: ReadonlyArray<{ toolNamespace?: unknown }>,
  ): Promise<boolean> {
    let complete = true;
    const prefixes = toolNamespaces
      .map((n) => n?.toolNamespace)
      .filter((ns): ns is string => typeof ns === 'string' && CONNECTOR_TOOL_NAMESPACE_RE.test(ns))
      .map((ns) => `mcp.${ns}.`);
    if (
      prefixes.length > 0 &&
      bus.hasService('tool-policy:list-agent-overrides') &&
      bus.hasService('tool-policy:set-agent-override')
    ) {
      try {
        const out = await bus.call<{ agentId: string }, ToolPolicyListAgentOverridesOutput>(
          'tool-policy:list-agent-overrides',
          ctx,
          { agentId },
        );
        for (const o of Array.isArray(out?.overrides) ? out.overrides : []) {
          const key = o?.toolKey;
          if (typeof key !== 'string' || !prefixes.some((p) => key.startsWith(p))) continue;
          const wrote = await bus.call<
            ToolPolicySetAgentOverrideInput,
            ToolPolicySetAgentOverrideOutput
          >('tool-policy:set-agent-override', ctx, { agentId, toolKey: key, verdict: null });
          if (wrote?.ok !== true) complete = false;
        }
      } catch (err) {
        complete = false;
        initCtx.logger.warn('workspace_connector_remove_overrides_failed', {
          agentId,
          connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (
      bus.hasService('skills:approved-caps-list') &&
      bus.hasService('skills:approved-caps-revoke')
    ) {
      try {
        const out = await bus.call<ApprovedCapsListInput, ApprovedCapsListOutput>(
          'skills:approved-caps-list',
          ctx,
          { ownerUserId, agentId, connectorId },
        );
        for (const cap of Array.isArray(out?.capabilities) ? out.capabilities : []) {
          if (typeof cap?.value !== 'string' || !APPROVED_CAP_KINDS.includes(cap.kind)) {
            complete = false;
            continue;
          }
          const revoked = await bus.call<ApprovedCapsRevokeInput, ApprovedCapsRevokeOutput>(
            'skills:approved-caps-revoke',
            ctx,
            { ownerUserId, agentId, kind: cap.kind, value: cap.value, connectorId },
          );
          // A grant listed a moment ago that did not clear is a miss, not
          // success — the same rule the override step above follows.
          if (revoked?.cleared !== true) complete = false;
        }
      } catch (err) {
        complete = false;
        initCtx.logger.warn('workspace_connector_remove_grants_failed', {
          agentId,
          connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return complete;
  }

  /**
   * TASK-628 — mark each answer with the memories `memory_recall` handed the
   * model for it (see `memory-used.ts`). Strictly additive: with no receipts
   * producer, a failed read, or a reply of the wrong shape, the thread comes
   * back exactly as built. A chip is a nicety; the transcript is the page.
   */
  async function withMemoryUsed(
    agentId: string,
    userId: string,
    conversationId: string,
    thread: ThreadMessage[],
    turns: readonly TurnRow[],
  ): Promise<ThreadMessage[]> {
    if (!bus.hasService('memory:recall-receipts')) return thread;
    try {
      const reply = parseRecallReceiptsReply(
        await bus.call<{ conversationId: string }, unknown>(
          'memory:recall-receipts',
          agentWorkspaceCtx(agentId, userId),
          { conversationId },
        ),
      );
      if (reply === null) {
        initCtx.logger.warn('workspace_memory_used_reply_malformed', { agentId });
        return thread;
      }
      return attachMemoryUsed(thread, turns, reply.receipts, reply.visibility);
    } catch (err) {
      initCtx.logger.warn('workspace_memory_used_read_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return thread;
    }
  }

  /**
   * The `owner` triple `sandbox:read-user-files` keys the per-agent mount off.
   *
   * The mount resolvers read ONLY `agentId`; the rest of the triple is
   * required by the shared `OpenSessionInput['owner']` type and unused on this
   * path, so it is filled from the resolved agent where a field exists and left
   * empty where it does not. It is NOT a synthetic session: this is called
   * only AFTER `agents:resolve` said this user may see this agent, and the
   * agentId that goes in is the one that came back.
   */
  function userFilesOwner(
    agent: ResolvedAgent,
    userId: string,
  ): ReadUserFilesInput['owner'] {
    return {
      userId,
      agentId: agent.id,
      agentConfig: {
        displayName: agent.displayName,
        systemPromptAugment: '',
        allowedTools: agent.allowedTools ?? [],
        mcpConfigIds: agent.mcpConfigIds ?? [],
        model: '',
        runner: '',
      },
    };
  }

  /**
   * The body behind both durable-tier routes: authenticate, ACL, validate the
   * path, read, answer.
   *
   * ONE function for the root and the splat because they are one answer with
   * one security order, and the surest way to get a second copy of an ordering
   * wrong is to write it twice.
   *
   * `rawSplat` arrives from `@ax/http-server` VERBATIM — undecoded, slashes
   * intact — so `workspaceFilePath` owns the single decode. `''` means the tier
   * root and skips the decode entirely: there is nothing to decode, and running
   * a validator over the empty string to get `null` back would turn the root
   * listing into a 400.
   */
  async function readUserFilesPath(
    req: RouteRequest,
    res: RouteResponse,
    rawSplat: string,
  ): Promise<void> {
    const userId = await authOr401(bus, initCtx, req, res);
    if (userId === null) return;
    const agentId = req.params.agentId ?? '';
    if (agentId.length === 0) {
      res.status(400).json({ error: 'missing-agent-id' });
      return;
    }
    // ACL FIRST — see the note on `agentUserFile`. A 400-vs-404 split below
    // this line would be an oracle over an export that holds every tenant.
    const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
    if (agent === null) return;

    let relPath = '';
    if (rawSplat.length > 0) {
      const decoded = workspaceFilePath(rawSplat);
      if (decoded === null) {
        res.status(400).json({ error: 'invalid-path' });
        return;
      }
      relPath = decoded;
    }

    if (!bus.hasService('sandbox:read-user-files')) {
      // No sandbox provider that can read the tier. An empty listing here
      // would say "this agent has written nothing", which is a claim about the
      // agent when the truth is a fact about the deployment (H7).
      res.status(503).json({ error: 'user-files-unavailable' });
      return;
    }

    const out = await bus.call<ReadUserFilesInput, ReadUserFilesOutput>(
      'sandbox:read-user-files',
      agentWorkspaceCtx(agentId, userId),
      { owner: userFilesOwner(agent, userId), ...(relPath === '' ? {} : { relPath }) },
    );

    if (out.kind === 'unavailable') {
      // There is no durable tier for this agent ANYWHERE in this deployment —
      // decided before any path was looked at, so it is the same answer for
      // every path and reports nothing about which ones exist. It used to
      // arrive as `absent` and leave the tab hedging "either your agent wrote
      // nothing or this server keeps nothing, we can't tell which" (TASK-403);
      // now it is the same 503 the missing-service check above returns, which
      // the tab already has an honest sentence for.
      res.status(503).json({ error: 'user-files-unavailable' });
      return;
    }

    if (out.kind === 'absent') {
      // The tier exists and this path is not in it. Still ONE answer for
      // "never written", "since deleted" and "resolved outside your subtree" —
      // that collapse is deliberate, and it is what stops the response code
      // from reporting on paths in someone else's subtree.
      res.status(404).json({ error: 'file-not-found' });
      return;
    }

    const name =
      relPath === ''
        ? ''
        : (fenceLine(basenameOf(relPath), FILE_LABEL_MAX_CHARS) ??
          UNREADABLE_FILE_NAME);

    if (out.kind === 'dir') {
      res.status(200).json({
        kind: 'dir',
        path: relPath,
        name,
        entries: out.entries
          .slice(0, USER_FILES_ENTRIES_MAX)
          .map((e) => toUserFileEntry(relPath, e)),
        truncated: out.entries.length > USER_FILES_ENTRIES_MAX,
      } satisfies AgentUserFilesResponse);
      return;
    }

    res.status(200).json({
      kind: 'file',
      path: relPath,
      name,
      ...decodeFileBody(out.contents),
    } satisfies AgentUserFilesResponse);
  }

  /**
   * The Memory tab's two reads, each carrying HOW IT WENT.
   *
   * A FAILED rules read ships no rules doc rather than an empty one. This is
   * the difference between "you have written no rules" and "we could not read
   * your rules", and getting it wrong is destructive: an empty editor over
   * unreadable storage invites the user to type something, press Save, and
   * overwrite rules they still have. The UI renders the absent doc as "we are
   * not showing the editor right now", not as a blank box. Same discipline the
   * rest of this surface uses — a zero is a claim.
   *
   * IT USED TO RETURN A BARE `MemoryDoc[]`, and that shape could not say which
   * of three things had happened (TASK-417). `return []` covered both "no
   * memory plugin is loaded on this deployment" and "the read broke", and the
   * tab drew the same two sentences over either — "Nothing yet" about the
   * agent's half, which is a claim, and "try again in a moment" about the
   * human's, which on a deployment with no memory plugin is a promise nothing
   * can keep. `unavailable` and `failed` are now different answers on the wire,
   * so the UI can stop guessing.
   *
   * There used to be a second tier here — the agent's own consolidated docs,
   * read through `memory:learned:read`. Its only provider, @ax/memory-strata,
   * was deleted in TASK-608 and @ax/memory never registered it, so the read
   * went too rather than linger as a branch nothing can reach. The agent's
   * facts have their own surface (`factsAvailable` below).
   *
   * ⚠ Takes the RESOLVED agent, not a bare `agentId`, and that is the whole
   * point of the signature. Since TASK-257 an agent's memory is shared by
   * everyone authorized to reach it, so `agents:resolve` is the only thing
   * standing between a caller and these bytes. A `string` parameter would let
   * a future second caller pass an unvetted id from the URL and never notice;
   * a `ResolvedAgent` can only be obtained from `resolveAgentOr404`, so the
   * gate is enforced by the type rather than by this comment. (Contrast
   * `readActivity`, which still takes a string because `/state` legitimately
   * fans out over an already-ACL'd roster — see its own warning.)
   */
  async function readMemory(agent: ResolvedAgent, userId: string): Promise<AgentMemoryRead> {
    const agentId = agent.id;
    const ctx = agentWorkspaceCtx(agentId, userId);

    let rules: AgentMemoryRead['rules'] = { status: 'unavailable', doc: null };
    if (bus.hasService('memory:rules:read')) {
      try {
        const out = await bus.call<MemoryAgentInput, MemoryRulesReadOutput>(
          'memory:rules:read',
          ctx,
          { agentId },
        );
        rules = {
          status: 'ok',
          doc: { name: RULES_DOC_NAME, scope: 'rules', body: out.body },
        };
      } catch (err) {
        initCtx.logger.warn('workspace_memory_rules_read_failed', {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
        rules = { status: 'failed', doc: null };
      }
    }

    const factsAvailable = bus.hasService('memory:recall');

    // Is the memory engine still learning for THIS user? `memory:status` is
    // optional (gated like every memory hook here), and its reply crossed the
    // bus, so only an exact `'paused'` sets the flag. A failed read omits it —
    // "not known to be paused" — rather than failing the whole workspace read.
    let factsExtractionPaused = false;
    if (factsAvailable && bus.hasService('memory:status')) {
      try {
        const out = await bus.call<MemoryStatusInput, unknown>('memory:status', ctx, {});
        factsExtractionPaused =
          typeof out === 'object' &&
          out !== null &&
          (out as { extraction?: unknown }).extraction === 'paused';
      } catch (err) {
        initCtx.logger.warn('workspace_memory_status_read_failed', {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      rules,
      ...(factsAvailable
        ? {
            factsAvailable: true,
            ...(agent.visibility === 'personal' || agent.visibility === 'team'
              ? { factsVisibility: agent.visibility }
              : {}),
            ...(factsExtractionPaused ? { factsExtraction: 'paused' as const } : {}),
          }
        : {}),
    };
  }

  async function listAgents(userId: string): Promise<AgentsListForUserOutput['agents']> {
    // Team agents surface only when we pass the user's teamIds — same read the
    // chat agent picker does, so the workspace roster and the picker agree.
    const teamIds = await listTeamIdsForUser(bus, initCtx, userId);
    const out = await bus.call<AgentsListForUserInput, AgentsListForUserOutput>(
      'agents:list-for-user',
      initCtx,
      { userId, teamIds },
    );
    return out.agents;
  }

  /**
   * Can this caller still reach this agent?
   *
   * `false` means the ACL said no — the agent was deleted, or unshared, or was
   * never theirs. Anything else RETHROWS: "we could not check" is not a no,
   * and rendering it as one would quietly empty someone's queue on the day the
   * agent store hiccups. A queue that says "nothing needs you" when four
   * things do is the failure this surface cannot afford (design H7).
   *
   * The discrimination is on the ERROR CODE, not on the error class, and that
   * detail is load-bearing here. `HookBus.call` wraps every throw a service
   * hook makes in a `PluginError` — code `unknown` — so `instanceof` alone
   * cannot tell a verdict from an outage. `agents:resolve` says `not-found`
   * for an agent that is gone and `forbidden` for one that was never theirs;
   * everything else is a fault. Same test `isBenignConversationRead` makes a
   * few lines up, for the same reason.
   *
   * A per-row read on the DETAIL panel can afford to be blunter — 404 either
   * way, one agent, no list to quietly shorten — which is why
   * `resolveAgentOr404` is not this function.
   */
  async function canReachAgent(agentId: string, userId: string): Promise<boolean> {
    try {
      await bus.call<AgentsResolveInput, AgentsResolveOutput>('agents:resolve', initCtx, {
        agentId,
        userId,
      });
      return true;
    } catch (err) {
      const denied =
        (err instanceof PluginError &&
          (err.code === 'not-found' || err.code === 'forbidden')) ||
        isRejection(err);
      if (!denied) throw err;
      initCtx.logger.warn('workspace_decision_agent_unreachable', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * The read every resolution route starts with: the caller's own decision,
   * with its agent checked, or `null` after the response has been written.
   *
   * `decisions:get` is owner-scoped and answers `null` for a decision that
   * belongs to someone else, which is the same answer it gives for one that
   * does not exist — and that is the point. A 404 rather than a 403 keeps us
   * from telling a foreign caller whether an id is real, which is the house
   * posture everywhere else on this surface.
   *
   * A THROW from the hook is deliberately not caught. It means the read
   * failed, not that the row is missing, and answering 404 would turn "we
   * don't know" into "it isn't there".
   */
  async function loadOwnedDecision(
    req: RouteRequest,
    res: RouteResponse,
    userId: string,
  ): Promise<StoredDecision | null> {
    const decisionId = (req.params.decisionId ?? '').trim();
    if (decisionId.length === 0) {
      res.status(400).json({ error: 'missing-decision-id' });
      return null;
    }
    if (!bus.hasService('decisions:get')) {
      // No decisions plugin means no decisions to resolve. Not an error on our
      // side, and not a 500 — there is simply no such row.
      res.status(404).json({ error: 'decision-not-found' });
      return null;
    }
    const got = await bus.call<DecisionsGetInput, DecisionsGetOutput>(
      'decisions:get',
      initCtx,
      { decisionId, userId },
    );
    if (got.decision === null) {
      res.status(404).json({ error: 'decision-not-found' });
      return null;
    }
    // Owning the decision is not the same as still being able to reach the
    // agent it belongs to, so both gates run.
    const agent = await resolveAgentOr404(
      bus,
      initCtx,
      got.decision.agentId,
      userId,
      res,
    );
    if (agent === null) return null;
    return got.decision;
  }

  /**
   * TASK-278 — bind the scheduled continuation turn as the conversation's
   * live reqId, so the open thread's `GET /api/chat/stream/<id>` resolves.
   *
   * Read-then-bind, both best-effort. A missing producer, a dead session
   * (`activeSessionId` null — the agent went away between delivery and this
   * read), or a failed bind answers null: the approval stands either way and
   * the turn runs dark exactly as before. Single attempt, no retry budget —
   * this runs inside the approve POST and the receipt must not wait on it.
   *
   * The ctx is owner-scoped like `agentWorkspaceCtx` below: `bind-session`
   * scopes on `(conversationId, ctx.userId)`, and `initCtx` is the `system`
   * user, which would bind nobody's row. `get-metadata` takes its userId in
   * the input for the same reason `decisions:approve` does.
   */
  async function bindContinuationTurn(
    stored: StoredDecision,
    userId: string,
    streamReqId: string,
  ): Promise<string | null> {
    if (
      !bus.hasService('conversations:get-metadata') ||
      !bus.hasService('conversations:bind-session')
    ) {
      return null;
    }
    try {
      const ownerCtx = makeAgentContext({
        sessionId: 'workspace-approve',
        agentId: stored.agentId,
        userId,
        conversationId: stored.conversationId,
        workspace: initCtx.workspace,
      });
      const md = await bus.call<
        { conversationId: string; userId: string },
        { activeSessionId: string | null }
      >('conversations:get-metadata', ownerCtx, {
        conversationId: stored.conversationId,
        userId,
      });
      if (md.activeSessionId === null) return null;
      await bus.call(
        'conversations:bind-session',
        ownerCtx,
        {
          conversationId: stored.conversationId,
          sessionId: md.activeSessionId,
          reqId: streamReqId,
        },
      );
      return streamReqId;
    } catch (err) {
      initCtx.logger.warn('workspace_continuation_bind_failed', {
        decisionId: stored.id,
        conversationId: stored.conversationId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return null;
    }
  }

  /**
   * A resolution hook that came back with no row: the decision was there a
   * moment ago and is not now. 404, never a 200 carrying `decision: null` — a
   * 200 that says nothing still looks like an answer, and the client would
   * apply it over the row the person is looking at.
   */
  function resolvedOrGone(
    decision: StoredDecision | null,
    res: RouteResponse,
  ): Decision | null {
    if (decision === null) {
      res.status(404).json({ error: 'decision-not-found' });
      return null;
    }
    return toWireDecision(decision);
  }

  /**
   * The in-thread approval cards for one conversation, oldest first.
   *
   * Each card is a POINTER — a `decisionId` and nothing else. The row itself
   * comes from `GET /api/workspace/decisions`, which the client has already
   * read, so there is exactly one copy of every decision on the page and the
   * thread cannot disagree with the queue about what is still open.
   *
   * A failed read costs the CARDS, not the panel. The decision is still in the
   * queue on its own route, so the person still sees it and can still act;
   * taking the whole detail panel down over this would cost them the
   * transcript as well, to save a card they have another way to reach.
   *
   * But it costs the cards OUT LOUD. The `status` rides back with the messages
   * because a thread that is merely shorter is indistinguishable from a thread
   * with nothing waiting in it, and on this surface those are opposite facts.
   * The two non-`ok` answers are different facts too, so they stay apart:
   *
   *   - `failed` — there is a producer and we could not read it. The panel does
   *     not know whether anything is waiting, and says so.
   *   - `unavailable` — this deployment has no decisions producer, so a
   *     decision cannot exist and an approval-free thread is TRUE. Same
   *     reasoning the queue route already applies when it answers `[]` for a
   *     deployment without the plugin; the panel renders nothing extra.
   */
  async function approvalMessages(
    userId: string,
    agentId: string,
    conversationId: string,
  ): Promise<{
    status: WorkspaceReadStatus;
    messages: ThreadMessage[];
    /** Open holds in this conversation; `null` unless the read was `ok`. */
    live: LiveHolds | null;
  }> {
    if (!bus.hasService('decisions:list')) {
      return { status: 'unavailable', messages: [], live: null };
    }
    try {
      const out = await bus.call<DecisionsListInput, DecisionsListOutput>(
        'decisions:list',
        initCtx,
        { userId, agentId },
      );
      const stamp = (iso: string): number => {
        const t = Date.parse(iso);
        return Number.isNaN(t) ? 0 : t;
      };
      const open = (out.decisions ?? []).filter(
        (d) => d.conversationId === conversationId && isOpenDecision(d),
      );
      return {
        status: 'ok',
        messages: [...open]
          .sort((a, b) => stamp(a.createdAt) - stamp(b.createdAt))
          .map((d) => ({ kind: 'approval', id: `decision-${d.id}`, decisionId: d.id })),
        live: {
          callIds: new Set(open.map((d) => d.call.id)),
          toolNames: new Set(open.map((d) => d.call.name)),
        },
      };
    } catch (err) {
      initCtx.logger.warn('workspace_thread_decisions_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'failed', messages: [], live: null };
    }
  }

  // --- the rail (design §4, AW-14) ---------------------------------------

  /**
   * "Right now" — one short phrase, a real counter, and a start time.
   *
   * `agent-activity:get` HAS NO ACL: it answers for whatever `agentId` it is
   * handed, and says so on its own registration. Every caller of this function
   * has already been through `agents:resolve`, which is the check — see the
   * two call sites.
   *
   * The phrase is fenced again here even though @ax/agent-activity already
   * fences it. It is a duck-typed hook: an alternate impl (a runner-step
   * stream, a headless deployment answering null) is not bound by the current
   * one's care, and this is the trust boundary.
   */
  async function readActivity(agentId: string): Promise<AgentRailData['activity']> {
    if (!bus.hasService('agent-activity:get')) {
      return { status: 'unavailable', activity: null };
    }
    try {
      const out = await bus.call<AgentActivityGetInput, AgentActivityGetOutput>(
        'agent-activity:get',
        initCtx,
        { agentId },
      );
      return { status: 'ok', activity: toRailActivity(out.activity) };
    } catch (err) {
      initCtx.logger.warn('workspace_rail_activity_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'failed', activity: null };
    }
  }

  /**
   * "What it may do alone" — the security claim, from three producers.
   *
   *   1. `tool-policy:list-capabilities` — the described rows. Each one's
   *      sentence is authored ON the rule that enforces it, so the two cannot
   *      drift.
   *   2. the tool catalog, for everything a rule does NOT describe: an MCP
   *      tool becomes a mechanical row, anything else an unmapped one. Omitting
   *      them would be the H4 failure — a row that is not there reads as "it
   *      cannot do that".
   *   3. the agent's own tool scope, which decides which catalog entries the
   *      agent can actually see, and whether it is restricted at all.
   */
  async function readPermissions(
    agent: ResolvedAgent,
  ): Promise<AgentRailData['permissions']> {
    const scope = toolScopeOf(agent);
    if (!bus.hasService('tool-policy:list-capabilities')) {
      return {
        status: 'unavailable',
        rows: [],
        incomplete: true,
        unrestrictedTools: scope.unrestricted,
      };
    }

    // THE CATALOG IS READ FIRST, and the order is load-bearing. The rule table
    // is GLOBAL — it describes what the product enforces, not what this agent
    // is wired to reach — so an agent scoped to `['Read']` would otherwise be
    // told "Can search the web — on its own", a false ALLOW claim on the
    // blast-radius surface. Only the catalog can say which tools exist, and
    // only the agent's scope can say which of them it sees; subtracting the two
    // here is what lets the policy plugin drop the reach claims that are not
    // this agent's. See `outOfReach`.
    const catalog = await catalogPermissions(agent, scope);

    // THE SECOND ASK of `tool-policy:list-capabilities` in one render, and it
    // is deliberate rather than an oversight, so here is the trade.
    //
    // The two asks are different questions: this one wants the display ROWS,
    // filtered by `outOfReach`; the catalog half's wants COVERAGE — which tools
    // some rule speaks for on EVERY call — which it needs before it can decide
    // which catalog entries still want a row of their own. The catalog half computes
    // `outOfReach` before it asks, so it COULD have passed it, taken these rows
    // too, and saved a call. It does not, because that would move the
    // described-rows read inside the catalog half and merge two failure states
    // this pair keeps separable — "the tool catalog half broke" and "the rule
    // table would not answer" become one catch, on the surface where telling
    // one unreadable thing from another is the entire job. The hook is a pure
    // read over an immutable in-memory table, so the second ask costs a map
    // over a few dozen rules.
    let described: PermissionRow[];
    try {
      const out = await bus.call<
        ToolPolicyListCapabilitiesInput,
        ToolPolicyListCapabilitiesOutput
      >('tool-policy:list-capabilities', initCtx, {
        agentId: agent.id,
        outOfReach: catalog.outOfReach,
      });
      described = (out.rows ?? []).map(toWirePermission);
    } catch (err) {
      initCtx.logger.warn('workspace_rail_policy_failed', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        status: 'failed',
        rows: [],
        incomplete: true,
        unrestrictedTools: scope.unrestricted,
      };
    }

    return {
      // A producer of the catalog half that THREW makes this `failed`, not an
      // `ok` list with a footnote — TASK-284, the same shape TASK-264 fixed in
      // `readGrants`. `incomplete` renders under the headline and the headline
      // is the claim. It matters less here than it did there, because this
      // section's empty state already refuses to make one ("we can't tell you —
      // not that there isn't any"), but the status was still wrong and a copy
      // change would re-arm it.
      //
      // The described rows go with it even though each is individually true,
      // for the same reason `readGrants` drops its partial rows: the rail gates
      // on `status`, so this costs nothing today, and a next consumer that read
      // `rows` without reading `status` would render a short list under a
      // failure and turn it back into a claim.
      status: catalog.failed ? 'failed' : 'ok',
      rows: catalog.failed ? [] : byVerdict([...described, ...catalog.rows]),
      incomplete: catalog.incomplete,
      unrestrictedTools: scope.unrestricted,
    };
  }

  /**
   * The catalog half: every tool this agent can see that no rule describes.
   *
   * Three producers, and each one's failure is tracked separately (`failed` on
   * `CatalogPermissions`) rather than folded into one flag between them.
   *
   *   1. `tool:list` — which tools exist. Also the only thing that can prove a
   *      tool is out of this agent's reach.
   *   2. `tool-policy:list-capabilities` — which of them the rule table already
   *      describes COMPLETELY, so this half never has to invent a call to find
   *      out.
   *   3. `tool-policy:evaluate` — the base verdict for the ones it does not,
   *      which is the policy plugin's to state and not ours to assume.
   *
   * WHY COVERAGE IS ASKED FOR RATHER THAN DERIVED, because this is the security
   * bug this function had (TASK-267). It used to call `evaluate` with
   * `{ name, input: {} }` and read `ruleId !== null` to mean "a rule already
   * describes this tool". An empty input is not a neutral default — it is a
   * fabricated argument set, and reading a rule's IDENTITY off an answer about
   * a call nobody is making is reading the wrong thing. A rule whose predicate
   * reads the call's arguments could never match it, so its tool came back
   * "unruled" and got a second, mechanical row asserting the unconditional
   * verdict — "Can use `delete_file` — on its own" standing beside the
   * described row that says it sometimes asks first. Two rows, one tool, and
   * the louder of the two was the invented one.
   *
   * THE MIRROR-IMAGE MISTAKE, which the first cut of this fix made and review
   * caught. Skipping every tool the table merely NAMES silences a tool named
   * only by conditional rules: the rail then says "asks you first, in some
   * cases" and never states what the other calls do, which is run on their own.
   * A reader completes an unstated complement with the safer guess, so silence
   * there understates reach — the direction design H4 says never to be wrong
   * in. Hence `fullyDescribedTools`, which counts a tool as accounted for only
   * when some rule speaks for EVERY call; a `when`-only tool gets both truths,
   * its conditional described row and a base row of its own.
   *
   * `evaluate`'s empty input is honest for exactly the tools that reach it, and
   * the reason is structural rather than a convention: a `PredicateSpec`
   * matches only an own property holding a primitive, so an input with no own
   * properties matches no predicate that exists or could be written. The answer
   * is the table's fall-through verdict — what happens to every call the
   * predicates miss — which is the claim the base row makes.
   */
  async function catalogPermissions(
    agent: ResolvedAgent,
    scope: AgentToolScope,
  ): Promise<CatalogPermissions> {
    // Without the evaluator we can neither name a verdict nor tell which tools
    // a rule already covers. Guessing either would put a made-up security claim
    // on the surface, so we say the list is incomplete instead.
    //
    // NOT `failed`: no producer here was asked and none broke. This deployment
    // does not load one, which is a different fact and the caller's `status`
    // has one slot — spending it here would hide the described rows, which were
    // read and are true. `incomplete` is what says the rest is unknown.
    //
    // `outOfReach` is EMPTY on every early return here, which is the
    // overstating direction on purpose: with no catalog we have proved nothing
    // about what this agent cannot reach, so we drop no reach claim and the
    // caller says the list may be incomplete.
    if (!bus.hasService('tool:list') || !bus.hasService('tool-policy:evaluate')) {
      return { rows: [], failed: false, incomplete: true, outOfReach: [] };
    }

    let tools: ToolCatalogEntry[];
    try {
      const out = await bus.call<Record<string, never>, ToolListOutput>(
        'tool:list',
        initCtx,
        {},
      );
      tools = out.tools ?? [];
    } catch (err) {
      initCtx.logger.warn('workspace_rail_catalog_failed', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { rows: [], failed: true, incomplete: true, outOfReach: [] };
    }

    /*
      PASS 1 — the scope subtraction, and nothing else. Pure: no bus, no policy.
      Which tools exist and which of them this agent can see are both catalog
      facts, and keeping them in their own pass means the policy reads below
      face a settled list, rather than one loop deciding scope, coverage and
      verdicts at once.
    */
    const inScope: Array<{ tool: ToolCatalogEntry; name: string }> = [];
    const outOfReach: string[] = [];
    /*
      Every name the catalog holds, in or out of this agent's scope. The
      not-installed subtraction below needs "does this deployment have that tool
      AT ALL", which is a different question from `inScope` and has a different
      answer for a host tool the agent is not allowed to call.
    */
    const registered = new Set<string>();
    for (const tool of tools) {
      const name = typeof tool?.name === 'string' ? tool.name : '';
      if (name.length === 0) continue;
      registered.add(name);
      if (!inAgentScope(name, scope)) {
        /*
          PROVED unreachable: the host registers this tool and this agent's
          scope excludes it, by the same rule the dispatcher applies. A rule
          describing it must not claim this agent can do it.

          Only a HOST-CATALOG tool lands here, and that limit is deliberate. A
          sandbox built-in (`Bash`, `Read`, …) is registered by the RUNNER, not
          by this catalog — the aisdk runner ships its six regardless of
          `allowedTools` — so its absence from the catalog proves nothing and it
          is never subtracted. Overstating is the survivable direction; guessing
          a sandbox tool away is not.
        */
        outOfReach.push(name);
        continue;
      }
      inScope.push({ tool, name });
    }

    // The coverage read. `tool-policy:list-capabilities` is registered — the
    // caller's own guard above returned `unavailable` otherwise — so a throw
    // here is a real failure of a producer that answers for the whole half, not
    // an absent one. We cannot bound what we would be missing, so the section
    // fails rather than shipping a list that re-describes every ruled tool as
    // an undescribed one.
    //
    // `outOfReach` still rides out: the catalog read succeeded, so those tools
    // ARE proved unreachable, and it is the caller's business what it does with
    // a proof from a half that failed elsewhere.
    let fullyDescribed: Set<string>;
    let hostProvided: string[];
    try {
      const out = await bus.call<
        ToolPolicyListCapabilitiesInput,
        ToolPolicyListCapabilitiesOutput
      >('tool-policy:list-capabilities', initCtx, { agentId: agent.id });
      // Re-checked rather than trusted, like every other duck-typed answer on
      // this surface. An impl registered without a `returns` schema can answer
      // without the field, and reading that as "nothing is described" is the
      // exact overstatement this read exists to prevent — so it is a failed
      // read instead.
      if (!Array.isArray(out.fullyDescribedTools)) {
        throw new Error(
          'tool-policy:list-capabilities answered without fullyDescribedTools',
        );
      }
      // Same posture, pointing the other way. A missing `hostProvidedTools`
      // reads as "no rule in this table names a tool a plugin provides", which
      // makes the subtraction below a no-op and puts the TASK-416 false ALLOW
      // back on the surface — quietly, and under a green test suite. Fail the
      // read instead.
      if (!Array.isArray(out.hostProvidedTools)) {
        throw new Error(
          'tool-policy:list-capabilities answered without hostProvidedTools',
        );
      }
      fullyDescribed = new Set(
        out.fullyDescribedTools.filter((name): name is string => typeof name === 'string'),
      );
      hostProvided = out.hostProvidedTools.filter(
        (name): name is string => typeof name === 'string',
      );
    } catch (err) {
      initCtx.logger.warn('workspace_rail_coverage_failed', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { rows: [], failed: true, incomplete: true, outOfReach };
    }

    /*
      THE NOT-INSTALLED SUBTRACTION — the second half of `outOfReach`, and it
      sits between the two passes because it needs both halves: the catalog
      (which tools exist here) and the table (which of the tools it names come
      from a host plugin).

      THE BUG THIS CLOSES (TASK-416, off the TASK-357 walk). PASS 1 can only
      ever name tools it WALKED, and it walks the catalog — so a rule naming a
      tool whose plugin never loaded had nothing to be subtracted from. Its row
      sailed through and rendered as a live ALLOW under a heading that promises
      to describe what is installed today. The walk found the rail advertising
      `memory_search`, `memory_note`, `web_search` and `web_extract` on a
      deployment that loads neither a memory plugin nor @ax/web-tools, with
      the agent contradicting its own rail in conversation.

      WHY THE TABLE HAS TO SAY WHICH TOOLS ARE HOST-PROVIDED, rather than this
      pass simply subtracting every ruled tool the catalog lacks. That would
      silence the SANDBOX SIX — `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`
      are registered by the RUNNER and never appear in this catalog, so their
      absence proves nothing. A row that is not there reads as "it cannot do
      that", and saying that about `Bash` understates reach on the blast-radius
      surface, which is the one direction design H4 forbids. `hostProvidedTools`
      names only the tools whose absence is decisive, so the mistake is not
      expressible here.

      OMIT, NOT "SHOW AS UNAVAILABLE" — the presentation decision, recorded
      where it is enforced. Both are honest; they say different things. This
      list's own rule is that a missing row reads as "it cannot do that", which
      for an uninstalled tool is exactly TRUE — so omission cannot mislead in
      the forbidden direction, and it is what the identical scope subtraction
      above already does with a proof of the same strength. A greyed
      "not installed here" row would instead seat a NON-capability inside the
      capability list, where a skim-reader collects it as reach, and it would
      cut across the verdict grouping the list is read by. The section still
      cannot render as a bare empty list: `status` separates "no producer" from
      "the read failed", and a zero-row `ok` says "we can't tell you — not that
      there isn't any" rather than "there is nothing".

      A DENY ROW SURVIVES THIS, because the drop happens in @ax/tool-policy's
      `applyReach`, which subtracts only `allow` and `hold`. "Cannot start a
      hidden helper agent" stays true for a tool nobody installed, and it is
      reassurance rather than reach.

      THIS SUBTRACTION NEEDS THE UNFILTERED CATALOG, and that is a real
      dependency rather than a stylistic note — it is the one place on this
      surface where a SHORT `tool:list` would cost the reader a true row.
      Everything else here treats a short catalog as "we proved less", the
      overstating direction; this reads a missing name as "not installed" and
      DROPS the row, so a narrowed list would understate reach.

      It holds because of who is asking. `tool:list` narrows per session (see
      @ax/mcp-client's dispatcher), and the caller here is `initCtx` — a system
      context whose `sessionId` is `'init'` and belongs to no session, so
      `session:get-config` rejects `unknown-session` and the dispatcher passes
      the whole catalog through. That pass-through is pinned by
      `@ax/mcp-client`'s `list-with-agent-scope.test.ts` ("passes everything
      through on unknown-session reject"), not by this file. If the rail ever
      asks `tool:list` from a real session's context, this loop has to be
      re-examined before that change lands.
    */
    for (const name of hostProvided) {
      if (!registered.has(name)) outOfReach.push(name);
    }

    /*
      PASS 2 — a row for every in-scope tool no described row fully accounts
      for. A tool with an unconditional rule is skipped: that rule's row is
      authored on the thing that enforces it, it speaks for every call, and a
      mechanical row beside it would be two claims about one tool.

      A tool named ONLY by conditional rules is NOT skipped, and that is the
      point of `fullyDescribedTools`. Its described rows cover the calls their
      predicates catch; this row covers the rest, which is the reach a reader
      would otherwise have to infer from silence.
    */
    const rows: PermissionRow[] = [];
    let incomplete = false;
    for (const { tool, name } of inScope) {
      if (fullyDescribed.has(name)) continue;

      let verdict: CapabilityVerdict;
      // Hoisted out of the `try` for the same reason `verdict` is: `ev` dies
      // with the block, and the `catch` below abandons the row rather than
      // falling through, so there is no path that reads either one unassigned.
      // Held RAW — it earns its type at the row, where the allow-list runs.
      let rawEffect: unknown;
      try {
        const ev = await bus.call<ToolPolicyEvaluateInput, ToolPolicyEvaluateOutput>(
          'tool-policy:evaluate',
          initCtx,
          // The empty input is not a stand-in for a real call's arguments —
          // it is the one input that no predicate can match, because a
          // `PredicateSpec` needs an own property holding a primitive and this
          // has none. So the answer is precisely the table's fall-through
          // verdict: what this tool does on every call the predicates miss,
          // which is the claim this row is about to make.
          { call: { name, input: {} }, agentId: agent.id },
        );
        verdict = ev.verdict;
        rawEffect = ev.effect;
      } catch (err) {
        // One unreadable tool costs us that row, and the list says so. It never
        // costs us the other rows, and it is never quietly dropped.
        //
        // Deliberately not `failed`, unlike the two producers above, and the
        // difference is what the reader can do with it. A wholesale producer
        // failure leaves us unable to bound what is missing; this is one named
        // tool out of a list we otherwise read completely, and `incomplete`
        // already tells the reader in so many words that the list may be short.
        // Failing the section over it would replace a mostly-true list with
        // nothing, which costs them more than it protects them.
        incomplete = true;
        initCtx.logger.warn('workspace_rail_evaluate_failed', {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const mcp = parseMcpToolName(name);
      const label = fenceLine(name, RAIL_LABEL_MAX_CHARS);
      if (label === null) {
        incomplete = true;
        continue;
      }
      rows.push({
        verdict,
        // Never our words for a row we cannot describe. The empty string is
        // the contract, not an oversight. It holds for a `when`-only tool too:
        // its authored clause describes the CONDITIONAL case and would be a
        // false label on the base row beside it.

        capability: '',
        source: mcp === null ? `tool:${name}` : `mcp:${name}`,
        provenance: mcp === null ? 'unmapped' : 'mcp',
        described: false,
        // Always false, including for a `when`-only tool. This row is the
        // UNCONDITIONAL half — the fall-through verdict that applies whenever
        // the predicates miss — and marking it "in some cases" would qualify
        // the one claim here that has no condition on it.
        conditional: false,
        // WHAT THE TABLE SAYS THIS CALL DOES IN THE WORLD — the evaluator's
        // answer for the fall-through call, filtered per member. Read off the
        // hook since TASK-383; it was hardcoded `[]` before, and that hardcode
        // was a claim this site had no standing to make.
        //
        // The row covers two kinds of tool and the field means a different
        // thing for each, which is why it cannot be a constant:
        //
        //   - A TOOL NO RULE NAMES (unmapped, MCP, a third party's). Nobody has
        //     classified its effects, so there is nothing to union and this
        //     stays `[]` — the unclassified spelling, and the honest one: the
        //     row's mechanical shape already says we cannot tell the reader
        //     what this tool does. We never invent a member from the tool's
        //     name. `send_email` is a string, not evidence.
        //   - A TOOL NAMED ONLY BY `when`-PREDICATED RULES. This is its base
        //     row — the unconditional half, covering every call the predicates
        //     miss — and it is where the hardcode lied. `evaluate` is asked
        //     with `{}`, which by construction no `PredicateSpec` matches, so
        //     no rule answers and the fall-through hands back the UNION, in
        //     table order, of the effects every rule naming this tool declared.
        //
        // The union is the right thing to render because a predicate gates the
        // VERDICT, not what the call does in the world: a call that slips past
        // `when: { field: 'url', equals: … }` still spends the money and still
        // hands the URL to somebody else. Rendering silence beside it would
        // UNDERSTATE reach, the one direction design H4 forbids — which is
        // precisely the failure the old comment here described as a live gap.
        //
        // It cannot over-claim either, because the union branch only fires
        // where a rule exists and none spoke. A tool with a broad rule is
        // matched by it, is therefore fully described, and never reaches this
        // loop at all — so `Bash` cannot be marked outward on the strength of a
        // `curl`-predicated sibling.
        //
        // `described: false` beside a NON-EMPTY set is not a contradiction. We
        // cannot say what this tool does in OUR words; the table can still say
        // it costs money. `PermissionLine` draws the badges outside both of its
        // `described` branches for exactly that reason.
        //
        // Still filtered, because this is still the trust boundary: the answer
        // arrives as a duck-typed `unknown`, and `toWireEffects` is what turns
        // it into claims this surface can render — a non-array lands as `[]`
        // rather than being coerced (a bare `'spends'` is iterable, and
        // spreading it would put six invented members on the wire), an unknown
        // member falls on the floor while its true siblings survive, and the
        // rule's declared order is preserved.
        effect: toWireEffects(rawEffect),
        mechanicalLabel: label,
        // The vendor's own prose, for MCP tools only, and only as attributed
        // evidence. A native tool's `description` is written to steer an LLM
        // and is not a description of reach, so it is dropped rather than
        // promoted into a claim.
        theirDescription:
          mcp === null ? null : fenceLine(tool.description, RAIL_DESCRIPTION_MAX_CHARS),
        theirName: mcp === null ? null : fenceLine(mcp.serverId, RAIL_LABEL_MAX_CHARS),
      });
    }
    return { rows, failed: false, incomplete, outOfReach };
  }

  /**
   * "Granted by you" — design §4.3.4.
   *
   * Two records, one group. `@ax/host-grants` holds the sites a person let this
   * agent reach; `@ax/skills`' approved-capability wall holds everything a
   * person approved at a skill's or a connection's install gate. Both are
   * things the reader did on purpose and has probably forgotten, which is the
   * whole reason they are separated from the built-in rules.
   *
   * The wall's store is keyed by SUBJECT and has no "list them all" read, so we
   * ask once per skill and once per connection this agent carries.
   */
  async function readGrants(
    userId: string,
    agent: ResolvedAgent,
  ): Promise<AgentRailData['grants']> {
    const hasSites = bus.hasService('host-grants:list');
    const hasWall = bus.hasService('skills:approved-caps-list');
    if (!hasSites && !hasWall) {
      return { status: 'unavailable', rows: [], incomplete: false };
    }

    const rows: GrantRow[] = [];
    let incomplete = false;
    // Set by any producer that THREW. It is deliberately not "did anything
    // read": a section with two producers had one flag between them, so a
    // vacuous success on one half could speak for a failure on the other.
    let failed = false;

    if (hasSites) {
      const revocable = bus.hasService('host-grants:revoke');
      try {
        const out = await bus.call<HostGrantsListInput, HostGrantsListOutput>(
          'host-grants:list',
          initCtx,
          { ownerUserId: userId, agentId: agent.id },
        );
        for (const row of out.hosts ?? []) {
          const label = fenceLine(row?.host, RAIL_LABEL_MAX_CHARS);
          if (label === null) {
            incomplete = true;
            continue;
          }
          rows.push({
            ref: { grant: 'site', host: row.host },
            verdict: 'allow',
            action: GRANT_ACTION.host,
            label,
            source: `grant:${label}`,
            provenance: 'grant',
            grantedAt: isoOrNull(row?.grantedAt),
            grantedFor: null,
            revocable,
          });
        }
      } catch (err) {
        failed = true;
        incomplete = true;
        initCtx.logger.warn('workspace_rail_site_grants_failed', {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (hasWall) {
      const revocable = bus.hasService('skills:approved-caps-revoke');
      const subjects: Array<{ kind: 'skill' | 'connection'; id: string }> = [
        ...(agent.skillAttachments ?? [])
          .map((a) => a?.skillId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
          .map((id) => ({ kind: 'skill' as const, id })),
        ...(agent.connectorAttachments ?? [])
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
          .map((id) => ({ kind: 'connection' as const, id })),
      ];
      // Zero subjects means the loop below never runs, and that is the end of
      // it: nothing asked, nothing thrown, nothing claimed. It used to mark the
      // whole SECTION successfully read, which is the defect TASK-264 fixes —
      // the wall's vacuous success spoke for the site read above it.
      for (const subject of subjects) {
        try {
          const out = await bus.call<ApprovedCapsListInput, ApprovedCapsListOutput>(
            'skills:approved-caps-list',
            initCtx,
            {
              ownerUserId: userId,
              agentId: agent.id,
              ...(subject.kind === 'skill'
                ? { skillId: subject.id }
                : { connectorId: subject.id }),
            },
          );
          for (const cap of out.capabilities ?? []) {
            if (!APPROVED_CAP_KINDS.includes(cap?.kind)) {
              // A kind we have no authored phrase for. Counting it as a gap is
              // the honest move: we know reach was granted and cannot name it.
              incomplete = true;
              continue;
            }
            const label = fenceLine(cap.value, RAIL_LABEL_MAX_CHARS);
            const forId = fenceLine(subject.id, RAIL_LABEL_MAX_CHARS);
            if (label === null) {
              incomplete = true;
              continue;
            }
            rows.push({
              ref: {
                grant: 'approved-capability',
                capKind: cap.kind,
                value: cap.value,
                skillId: subject.kind === 'skill' ? subject.id : null,
                connectorId: subject.kind === 'connection' ? subject.id : null,
              },
              verdict: 'allow',
              action: GRANT_ACTION[cap.kind],
              label,
              source: `grant:${cap.kind}:${label}`,
              provenance: 'grant',
              grantedAt: null,
              grantedFor: forId === null ? null : { kind: subject.kind, id: forId },
              revocable,
            });
          }
        } catch (err) {
          failed = true;
          incomplete = true;
          initCtx.logger.warn('workspace_rail_wall_grants_failed', {
            agentId: agent.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      // ANY producer that threw makes this `failed`, not an empty-or-short
      // list: "you have granted this agent nothing" (or "…only these") is a
      // claim we cannot make from a read that broke. H7 — "we don't know" must
      // never render as "there is nothing here".
      //
      // The partial rows go with it, even though each one is individually
      // true. The rail already gates on `status`, so this costs nothing today;
      // it is here so that the NEXT consumer — a second surface, a snapshot,
      // anything reading `rows` without reading `status` — cannot render a
      // short list under a failure and turn it back into a claim. Same
      // discipline as `readPermissions`, which drops its catalog rows when the
      // policy read fails.
      status: failed ? 'failed' : 'ok',
      rows: failed ? [] : dedupeGrants(rows),
      incomplete,
    };
  }

  /**
   * "This week" — design §4.4.
   *
   * ONE row ships. The other two in the design's table have no source, and the
   * plan is explicit that a missing row is honest while a fabricated number is
   * not:
   *
   *   - *Handled on its own* — "tool calls with verdict `allow`, in window".
   *     Nothing in the system counts tool calls. There is no event store behind
   *     `tool:pre-call`, and inventing one is not this card.
   *   - *You overruled it* — "Decisions dismissed + executions undone". The
   *     dismissals are countable. The UNDOs are not: `decisions:undo` restores
   *     the row to `pending` and clears `resolved_at`, so an undone decision is
   *     indistinguishable from one that was never resolved. Shipping the
   *     dismissal half under a label whose written definition includes undos is
   *     precisely the drift §4.4's table exists to prevent, so the row waits
   *     for a real source.
   *
   * Building either producer was considered and declined — TASK-265. Both
   * rows stay hidden until something real counts them; the undo trace the
   * second would have needed was rejected outright.
   *
   * `windowDays` rides the wire beside the rows and NOTHING RENDERS IT — the
   * period is baked into the surviving row's `definition` sentence, which is
   * where §4.4 wants it. It is kept anyway, and since TASK-266 it is no longer
   * decorative: it is the parameter this function turns into the `since` it
   * asks `decisions:count` for, so the field and the number now provably
   * describe the same window. A second reader of this payload gets the period
   * in a form it does not have to parse out of English.
   */
  async function readCounters(
    userId: string,
    agentId: string,
  ): Promise<AgentRailData['counters']> {
    if (!bus.hasService('decisions:count')) {
      return {
        status: 'unavailable',
        rows: [],
        windowDays: COUNTER_WINDOW_DAYS,
      };
    }
    const since = new Date(
      now().getTime() - COUNTER_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    let value: number;
    try {
      // ONE question (TASK-266). This used to be a walk of all seven decision
      // statuses, because `decisions:list` takes one exact status at a time —
      // seven round trips per render of one agent's rail, each of which ran an
      // expiry sweep before answering. `decisions:count` names no status, so
      // "whatever you decided" is asked once and swept zero times; the plugin's
      // own registration explains why skipping the sweep costs this number
      // nothing.
      //
      // It also closes a small hole the walk had: a decision raised WHILE the
      // seven reads were in flight, into a status already walked, was missed.
      // One statement cannot miss it — there is no "already walked" any more.
      const out = await bus.call<DecisionsCountInput, DecisionsCountOutput>(
        'decisions:count',
        initCtx,
        { userId, agentId, since },
      );
      if (typeof out?.count !== 'number' || !Number.isFinite(out.count)) {
        // A producer that answered with something that is not a number has
        // told us nothing, and `Number(undefined) || 0` would turn that into a
        // confident zero — "this agent has not bothered you all week" is a
        // claim, and we are not entitled to make it from a broken answer.
        // Design H7, and the same shape as the coverage read above, which
        // refuses an answer that arrived "without fullyDescribedTools" rather
        // than reading the missing field as an empty one.
        throw new Error('decisions:count answered without a numeric count');
      }
      value = out.count;
    } catch (err) {
      initCtx.logger.warn('workspace_rail_counters_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'failed', rows: [], windowDays: COUNTER_WINDOW_DAYS };
    }

    return {
      status: 'ok',
      rows: [
        {
          id: 'brought-to-you',
          label: 'Brought to you',
          value,
          // THE written definition, shipped with the number. §4.4's whole point
          // is that this sentence and that integer travel together.
          definition:
            'Decisions this agent raised for you in the last 7 days, whatever you decided — including the ones that expired.',
        },
      ],
      windowDays: COUNTER_WINDOW_DAYS,
    };
  }

  return {
    /** GET /api/workspace/state */
    async state(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      const agents = await listAgents(userId);
      const rows = await Promise.all(
        agents.map(async (a) => {
          // The roster is already inside `agents:list-for-user`, which is the
          // ACL — `readActivity` is safe here for the same reason it is safe on
          // the rail, and for no other.
          //
          // ONE READ ANSWERS BOTH HALVES since TASK-498: the state word and the
          // "Right now" line come off the same activity record, so the roster
          // can no longer say "Working" over a blank phrase. The N conversation
          // listings this used to pay for — one per agent, to probe sandbox
          // liveness — are gone with the probe.
          const line = await readActivity(a.id);
          return toWorkspaceAgent(a, deriveState(line), line);
        }),
      );

      // The roster and nothing else. Both of the collections that used to sit
      // beside it as empty arrays now have a producer of their own — the feed
      // at GET /api/workspace/activity, the queue at GET
      // /api/workspace/decisions — and one collection gets one producer.
      res.status(200).json({ agents: rows } satisfies WorkspaceStateResponse);
    },

    /**
     * GET /api/workspace/decisions — the Today queue.
     *
     * Thin on purpose. The machine that decides what is still open, what has
     * expired, and what the freshness guard has to say about it lives in
     * @ax/decisions and there is exactly one copy of it (invariant 4). This
     * route reads, checks the ACL, and projects.
     */
    async decisions(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      if (!bus.hasService('decisions:list')) {
        // In a deployment without the plugin a decision cannot exist, so `[]`
        // is TRUE rather than a claim laid over a failed read — the same
        // distinction the activity route draws when @ax/routines is absent.
        res.status(200).json({ decisions: [] } satisfies DecisionsResponse);
        return;
      }

      // No status filter: the hook's own default is "everything still
      // actionable by a human", and re-stating that here would be a second
      // copy of the open-status list waiting to disagree with the first.
      const out = await bus.call<DecisionsListInput, DecisionsListOutput>(
        'decisions:list',
        initCtx,
        { userId },
      );
      const rows = out.decisions ?? [];

      // One ACL check per DISTINCT agent. A queue is one row per outward
      // action, so several rows routinely share an agent and resolving each
      // one separately would multiply the check by the queue's length for no
      // extra safety.
      const agentIds = [...new Set(rows.map((d) => d.agentId))];
      const verdicts = await Promise.all(
        agentIds.map(async (id) => [id, await canReachAgent(id, userId)] as const),
      );
      const reachable = new Map(verdicts);

      res.status(200).json({
        decisions: rows
          .filter((d) => reachable.get(d.agentId) === true)
          .map(toWireDecision),
      } satisfies DecisionsResponse);
    },

    /**
     * GET /api/workspace/grants — pending capability grants waiting on this
     * person (TASK-373).
     *
     * Thin on purpose, like the queue route above: the buffer owns the rules —
     * dedupe, the per-conversation bound, eviction on resolve — and its tests
     * hold them (invariant 4, one store per concept). This route
     * authenticates, reads, and puts the caller's own rows on the wire.
     *
     * NO PARAMETERS, and that is the whole security posture. The filter inside
     * `pendingGrantsForUser` compares the authenticated caller against the
     * owner the producer recorded when the card was buffered — two values
     * neither of which the request supplied, so there is nothing to forge and
     * nothing to guess. A cross-tenant read and a genuinely empty store are
     * the same 200 with `[]`: never a 403-vs-404 oracle over other people's
     * pending grants, whose skill ids, connector names and hostnames all
     * belong to somebody.
     */
    async grants(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      const rows = buffer?.pendingGrantsForUser(userId) ?? [];
      res.status(200).json({
        // The filter is SHARED with the SSE replay (grant-declines.ts) — two
        // copies of the comparison is how the two paths drift apart.
        grants: (
          await withoutDeclinedGrants(bus, initCtx, userId, rows, {
            // AND THIS READ IS THE ONE THAT PRUNES (TASK-482).
            // `pendingGrantsForUser` is every pending grant this person has
            // across every conversation — the only set against which "this
            // marker is not suppressing anything" means "this marker is
            // dead". The SSE replay sees ONE conversation and so must never
            // do this.
            //
            // Handed over as a FUNCTION so the sample is taken after the
            // marker read rather than at the top of this handler: the two
            // have to be judged against each other, and `rows` above is a
            // storage round trip older than the markers will be. It is
            // omitted entirely when there is no buffer — sampling would then
            // yield `[]`, a statement about this handler's wiring and not
            // about what is pending, and reclaiming against it would take
            // every marker the person owns.
            reclaimAgainstCompleteSet:
              buffer === undefined
                ? undefined
                : () => buffer.pendingGrantsForUser(userId),
          })
        ).map((g) => ({
          conversationId: g.conversationId,
          agentId: g.agentId,
          request: g.card,
        })),
      } satisfies GrantsResponse);
    },

    /**
     * POST /api/workspace/grants/decline — "Not now", written down (TASK-444).
     *
     * A deferral, and a need-triggered one. The marker says WHEN the person
     * refused; the pending card says when it was last asked; the read above
     * drops the row only while the refusal is the newer of the two. So there
     * is no timer here and no expiry to get wrong — the question returns when
     * the agent genuinely asks again, and never merely because time passed.
     *
     * The body is a claim about what to decline, and it is checked against the
     * caller's own pending grants before anything is written. "Not yours" and
     * "not pending" are therefore the same 404: a 403 would confirm that a
     * grant exists and belongs to someone, which is the oracle the GET above
     * goes out of its way not to be either.
     */
    async declineGrant(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.toString('utf-8')) as unknown;
      } catch {
        res.status(400).json({ error: 'invalid-json' });
        return;
      }
      const body = readDeclineBody(parsed);
      if (body === null) {
        res.status(400).json({ error: 'invalid-grant' });
        return;
      }

      // AUTHORITATIVE STATE, not the request. A pending card the caller owns
      // is the only thing that can be declined, and the card — not the body —
      // is where `kind` and `subjectId` are read back from.
      const pending = (buffer?.pendingGrantsForUser(userId) ?? []).find(
        (g) =>
          g.agentId === body.agentId &&
          g.card.kind === body.kind &&
          grantSubjectId(g.card) === body.subjectId,
      );
      if (pending === undefined) {
        res.status(404).json({ error: 'grant-not-pending' });
        return;
      }

      if (!bus.hasService('storage:set')) {
        // Never a silent success. A refusal we failed to record is a refusal
        // that comes back on the next mount, and saying so now is the honest
        // ending — the row stays on screen with the error.
        res.status(503).json({ error: 'declines-unavailable' });
        return;
      }

      // Every segment of the marker is authoritative by now: `userId` is the
      // authenticated caller, `agentId` comes off the matched card, and the
      // match above required `kind` and `subjectId` to EQUAL that card's own
      // (`card.kind`, `card.skillId` / `card.connectorId`) — so the body's
      // copies are the card's values, checked rather than taken on trust.
      await recordGrantDecline(bus, initCtx, {
        userId,
        agentId: pending.agentId,
        kind: body.kind,
        subjectId: body.subjectId,
        declinedAt: now().getTime(),
      });
      res.status(200).json({ declined: true } satisfies DeclineGrantResponse);
    },

    /**
     * GET /api/workspace/decisions/:decisionId — ONE row, read back.
     *
     * The list route above answers with the still-open rows only, so a
     * resolved decision cannot be found there again. This is the re-read a
     * client makes to learn that a row it is still showing has since been
     * consumed — see `DecisionResponse`. Thin on purpose, same as the list
     * route: `loadOwnedDecision` is the one ACL check every resolution route
     * already shares, so this reuses it rather than writing a second one.
     */
    async decision(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const stored = await loadOwnedDecision(req, res, userId);
      if (stored === null) return;
      res.status(200).json({ decision: toWireDecision(stored) } satisfies DecisionResponse);
    },

    /**
     * POST /api/workspace/decisions/:decisionId/approve
     *
     * A pass-through, and it has to stay one. @ax/decisions owns the single
     * claim that makes an approval happen exactly once — the route never
     * dedupes, never re-checks freshness, and never decides on its own that a
     * second click is a no-op. Two tabs both posting is a case the plugin
     * already handles; a route that tried to help would be a second, divergent
     * copy of the rule.
     */
    async approveDecision(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const stored = await loadOwnedDecision(req, res, userId);
      if (stored === null) return;

      // TASK-278 — mint the continuation turn's correlation BEFORE the
      // approve runs, so the woken runner emits under an id this response
      // can hand the open thread. `makeReqId` mints chat-flow ids; this
      // route owns that flow the same way POST /api/chat/messages does.
      const continuationReqId = makeReqId();
      const out = await bus.call<DecisionsApproveInput, DecisionsApproveOutput>(
        'decisions:approve',
        initCtx,
        { decisionId: stored.id, userId, continuationReqId },
      );
      const decision = resolvedOrGone(out.decision, res);
      if (decision === null) return;
      // The plugin echoes the id only when the resolution is SCHEDULED for
      // delivery to a warm agent: since TASK-574 the attended path holds the
      // delivery until the undo window closes (`pendingUntil`), so an Undo
      // inside the window cancels a continuation nothing has seen yet. The
      // bind still happens HERE, at approve time — the client attaches later
      // (at `pendingUntil`), and `GET /api/chat/stream/<id>` must resolve
      // when it does (the handler ACLs on `active_req_id`); without the bind
      // it 404s and the client attaches to nothing. Best-effort: any failure
      // answers null, and the approval itself still stands — the turn runs
      // dark exactly as before.
      //
      // `?? null`: a producer predating TASK-278 answers no `streamReqId`
      // at all. That is absence, not a stream — and it must read as null,
      // never as an id to attach to.
      const deliveredId = out.streamReqId ?? null;
      const streamReqId =
        out.path === 'agent-executes' && deliveredId !== null
          ? await bindContinuationTurn(stored, userId, deliveredId)
          : null;
      res.status(200).json({
        decision,
        executed: out.executed,
        path: out.path,
        // Bounded and flattened like every other string that leaves here, and
        // still not a receipt: the renderer shows an AUTHORED failure line,
        // never this. It rides along because an operator looking at a failed
        // approval needs the detail, and null is a fine answer.
        error: fenceLine(out.error, DECISION_RECEIPT_MAX_CHARS),
        pendingUntil: out.pendingUntil,
        streamReqId,
      } satisfies ApproveResponse);
    },

    /** POST /api/workspace/decisions/:decisionId/dismiss */
    async dismissDecision(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const stored = await loadOwnedDecision(req, res, userId);
      if (stored === null) return;

      const out = await bus.call<DecisionsResolveInput, DecisionsDismissOutput>(
        'decisions:dismiss',
        initCtx,
        { decisionId: stored.id, userId },
      );
      const decision = resolvedOrGone(out.decision, res);
      if (decision === null) return;
      res.status(200).json({ decision } satisfies DismissResponse);
    },

    /**
     * POST /api/workspace/decisions/:decisionId/undo
     *
     * `undone` is the plugin's answer, not ours. A late undo — one the window
     * has closed on, or one whose call has already been made — comes back with
     * the row and `undone: false`, and that is a 200: the click was absorbed
     * and the honest thing to show is what the row actually says now.
     *
     * AND A REFUSAL RETIRES THE AFFORDANCE (TASK-441). `undone: false` with a
     * row attached is the server saying this can no longer be taken back, so
     * the row it answers with must not go on claiming it can. It would: the
     * plugin refuses a late undo by returning the stored row UNCHANGED — which
     * is right, a refusal must not write anything — and `toWireDecision`
     * derives `undoable` from `consumedAt` / `replayedAt` / `replayClaimedAt`
     * alone, all three of which are still null when the refusal is the TIME
     * window closing. So the projection would answer `undoable: true` about a
     * row the very same response has just refused, and every control that keys
     * off it — `undoSecondsLeft`, and therefore the Undo button in both
     * renderers — would keep offering a button that cannot work. Measured on
     * the TASK-358 walk: the button came back pressable after the refusal and
     * could be pressed again, and again.
     *
     * The override is NOT a second copy of the undo rule. It re-derives
     * nothing; it records the verdict this very response is carrying, which is
     * the only place that verdict exists. `toWireDecision` stays the one
     * derivation, and it stays clock-free.
     *
     * Which direction it fails in: CLOSED. The narrowing only ever turns
     * `undoable` from true to false, only on a response that already says
     * `undone: false`, and nothing here can turn it back on.
     */
    async undoDecision(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const stored = await loadOwnedDecision(req, res, userId);
      if (stored === null) return;

      const out = await bus.call<DecisionsResolveInput, DecisionsUndoOutput>(
        'decisions:undo',
        initCtx,
        { decisionId: stored.id, userId },
      );
      const decision = resolvedOrGone(out.decision, res);
      if (decision === null) return;
      res.status(200).json({
        decision: out.undone ? decision : { ...decision, undoable: false },
        undone: out.undone,
      } satisfies UndoResponse);
    },

    /**
     * GET /api/workspace/activity — the one event feed.
     *
     * `?agentid=` scopes it to a single agent (the "What it did" tab);
     * unscoped it merges the whole roster (the Activity page). `?before=` is
     * the pagination cursor and it is an INSTANT, never a row id — which is
     * also what lets two sources with completely different storage share it.
     */
    async activity(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      const rawLimit = Number.parseInt(
        (req.query[ACTIVITY_LIMIT_QUERY_KEY] ?? '').trim(),
        10,
      );
      const limit = Number.isNaN(rawLimit)
        ? ACTIVITY_DEFAULT_LIMIT
        : Math.min(ACTIVITY_MAX_LIMIT, Math.max(1, rawLimit));

      /*
        An unparseable `before` is REFUSED, not ignored. Dropping it would
        silently rewind the reader to page one — the same rows again, under a
        "load more" they just clicked, with no sign anything went wrong.
      */
      const rawBefore = (req.query[ACTIVITY_BEFORE_QUERY_KEY] ?? '').trim();
      let before: Date | null = null;
      if (rawBefore.length > 0) {
        const parsed = Date.parse(rawBefore);
        if (Number.isNaN(parsed)) {
          res.status(400).json({ error: 'invalid-before' });
          return;
        }
        before = new Date(parsed);
      }

      const scopedId = (req.query[ACTIVITY_AGENT_ID_QUERY_KEY] ?? '').trim();

      // Which agents to read, and how loudly a failure counts. Scoped: ACL
      // first, then strict — that agent's history IS the page. Unscoped: the
      // roster, non-strict.
      let targets: Array<{ id: string }>;
      let strict: boolean;
      if (scopedId.length > 0) {
        const agent = await resolveAgentOr404(bus, initCtx, scopedId, userId, res);
        if (agent === null) return;
        targets = [{ id: agent.id }];
        strict = true;
      } else {
        targets = await listAgents(userId);
        strict = false;
      }

      /*
        TWO SOURCES, ONE COLLECTION. Routine fires say what an agent did on its
        own; decision receipts say what it did because a person said yes. They
        are one story to a reader, so they are one feed — and both are asked the
        SAME question (`limit`, `before`) so a merge cannot lose a row at the
        seam. Each source hands back its newest `limit`; the merge sorts and
        cuts, so a page is right however lopsided the mix happens to be.
      */
      const slices = await Promise.all(
        targets.map(async (a) => {
          const [fires, receipts] = await Promise.all([
            firesForAgent(a.id, limit, before, strict),
            receiptsForAgent(a.id, userId, limit, before, strict),
          ]);
          if (fires.length === 0) {
            return { fires, receipts, names: new Map<string, string>() };
          }
          return { fires, receipts, names: await routineNames(a.id) };
        }),
      );

      /*
        Mapped BEFORE the merge, so the two sources are comparable as one list
        and the cursor below can be taken off whatever actually landed last.

        `event: null` is a row that renders as nothing — a silenced fire, or
        anything undateable. It still occupies its place in the page, which is
        what keeps `nextBefore` honest: see `ActivityResponse`, a page can
        legitimately come back with zero events and more history behind it.

        Undateable rows sort LAST (`sortableStamp` floors them at -Infinity)
        rather than landing wherever `NaN` comparisons leave them. They are
        dropped by the mappers; they must not take a datable row's place on the
        page on their way out.
      */
      const merged = slices
        .flatMap((s) => [
          ...s.fires.map((f) => ({
            stamp: sortableStamp(f.firedAt),
            event: fireToActivityEvent(f, s.names),
          })),
          ...s.receipts.map((r) => ({
            stamp: sortableStamp(r.at),
            event: receiptToActivityEvent(r, (outcome) =>
              initCtx.logger.warn('workspace_activity_receipt_outcome_unknown', {
                agentId: r.agentId,
                outcome,
              }),
            ),
          })),
        ])
        .sort((x, y) => y.stamp - x.stamp)
        .slice(0, limit);

      const events: ActivityEvent[] = [];
      for (const m of merged) {
        if (m.event !== null) events.push(m.event);
      }

      /*
        The cursor is the last row we CONSIDERED, not the last one rendered.
        See `ActivityResponse`: a page of all-silenced fires renders nothing,
        and a cursor taken from the last visible row would strand the reader on
        it.

        `null` when this page did not fill: every source handed back everything
        it had, so there is nothing older to ask for.

        The cursor is EXCLUSIVE on both sources (`fired_at < before`,
        `resolved_at < before`), and that carries a real cost: two rows sharing
        an instant to the millisecond, straddling a page boundary, LOSE the
        second one. It is not on this page, and `< before` excludes it from the
        next — permanently, and with nothing on the surface to say a row went
        missing.

        THE OLD JUSTIFICATION FOR ACCEPTING THAT NO LONGER APPLIES, and it is
        worth saying so rather than quietly editing it out. This comment used
        to argue the collision was "not a case we have" because fires are
        seconds-apart events written by a tick loop. That reasoned about ONE
        stream. There are now two independent ones, and a tick-loop fire
        colliding to the millisecond with the instant a human pressed Approve
        is materially more plausible than two fires colliding with each other:
        nothing co-ordinates those two clocks, and neither knows the other
        exists.

        The store's `decision_id` tie-break does NOT rescue it. That makes the
        ORDER deterministic — which is what keeps a page boundary from
        shuffling — but the cursor carries an instant and only an instant, so
        both same-millisecond rows fall on the same side of `<` regardless of
        how they were ordered.

        Still exclusive, and now that is a judgement rather than a claim about
        frequency. The fix that would actually close it is a COMPOSITE
        `(instant, id)` cursor — "older than this instant, or at this instant
        with a smaller id" — which means a signature change on both hooks and a
        matching predicate in both backends, to buy a collision we have never
        observed. An inclusive cursor is not the alternative: it repeats a row
        on every single page turn, which a reader does notice. If this is ever
        seen in the wild, the composite cursor is the answer.

        `Number.isFinite`, not `!Number.isNaN`: `sortableStamp` floors an
        unreadable instant at -Infinity so it sorts last, and `new
        Date(-Infinity).toISOString()` THROWS rather than producing a bad
        cursor.
      */
      const filled = merged.length === limit;
      const lastStamp = merged.at(-1)?.stamp ?? NaN;
      const nextBefore =
        filled && Number.isFinite(lastStamp) ? new Date(lastStamp).toISOString() : null;

      res.status(200).json({ events, nextBefore } satisfies ActivityResponse);
    },

    /** GET /api/workspace/agents/:agentId */
    async agentDetail(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      // ACL first: a not-accessible agent → 404, no existence leak.
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      const convs = await listConversations(userId, agentId, { strict: true });
      const current = convs[0] ?? null;
      // A pointer per row, nothing more: the transcript arrives from a second
      // read through `?conversationId=`, and there is no fold count to ship.
      // See `PastConversation` for why both fields are gone.
      const past: PastConversation[] = convs.slice(1).map((c) => ({
        id: c.conversationId,
        // Fenced like every other label out of this file — see
        // CONVERSATION_TITLE_MAX_CHARS. A model wrote this string.
        title:
          fenceLine(c.title, CONVERSATION_TITLE_MAX_CHARS) ??
          'Untitled conversation',
        lastActivityAt: c.lastActivityAt ?? c.createdAt,
      }));

      /*
        Which conversation the caller is asking to READ. `?conversationId=`
        opens one of the `past` rows read-only; without it we serve the
        current one. Either way the ownership check below is the same, and it
        is `conversations:get` — not the list we just read — that decides.

        Read the key LOWERCASED. `http-server` projects the query string with
        `query[k.toLowerCase()] = v` (plugin.ts), so a camelCase key never
        arrives camelCase — a handler that reads `req.query.conversationId`
        gets `undefined` forever and silently serves the CURRENT conversation
        under a past row's title. The sibling `GetConversationQuery`
        (`wire/chat.ts`) reads `includethinking` for exactly this reason.
      */
      const requestedId = (req.query[CONVERSATION_ID_QUERY_KEY] ?? '').trim();
      const targetId =
        requestedId.length > 0 ? requestedId : (current?.conversationId ?? null);

      let thread: ThreadMessage[] = [];
      let threadConversationId: string | null = null;
      let decisionsRead: WorkspaceReadStatus = 'ok';
      // Read whether or not there is a thread yet: the live panel needs it for
      // the first turn too (TASK-744).
      const connectors = await connectorNames(userId);
      if (targetId !== null) {
        let got: ConversationsGetOutput | null = null;
        try {
          got = await bus.call<ConversationsGetInput, ConversationsGetOutput>(
            'conversations:get',
            initCtx,
            { conversationId: targetId, userId },
          );
        } catch (err) {
          // Only the two ACL verdicts are benign here. Anything else — a DB
          // outage, a throw inside the projection — is a real fault, and
          // rendering it as "this agent has no history" would be a claim we
          // cannot back on top of a failure nobody was told about. Same
          // discrimination `routes-chat.ts` does on this hook.
          if (!isBenignConversationRead(err)) throw err;
          if (requestedId.length > 0) {
            // The caller named a conversation we cannot read. Answering 200
            // with an empty thread would render "this conversation is empty"
            // over a conversation that exists and is simply not theirs.
            res.status(404).json({ error: 'conversation-not-found' });
            return;
          }
          // The current conversation was deleted between the list and this
          // read. That is a benign race, not a server fault: degrade to "no
          // current conversation" rather than throwing a 500 at a user whose
          // only crime was refreshing at the wrong moment.
          initCtx.logger.warn('workspace_current_conversation_unreadable', {
            agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (got !== null) {
          // conversations:get is the authority on ownership. If it disagrees
          // with the list we just read, something drifted — refuse rather than
          // render one agent's transcript under another agent's name.
          if (
            got.conversation.agentId !== agentId ||
            got.conversation.userId !== userId
          ) {
            res.status(404).json({
              error: requestedId.length > 0 ? 'conversation-not-found' : 'agent-not-found',
            });
            return;
          }
          threadConversationId = got.conversation.conversationId;
          /*
            The still-open decisions raised in THIS conversation, as cards at
            the end of the thread. They go last because that is where they
            happened: the agent got as far as an outward action and stopped to
            ask.

            There is deliberately no decision payload on this response. The
            client already has every row from GET /api/workspace/decisions, and
            a second copy travelling on a second route is precisely the
            two-producers bug this task exists to avoid.

            What DOES travel is how that read went. `decisionsRead` starts at
            `ok` for the no-conversation case and that is not a shrug: with no
            conversation there is no conversationId for a decision to belong
            to, so "nothing is waiting in this conversation" is true rather
            than unread.

            Read BEFORE the thread is shaped (TASK-517): the same open rows say
            which held steps are still being asked about, so a hold the person
            has since answered stops reading "waiting for you". Only an `ok`
            read may settle one — a failed read is unknown, and `unavailable`
            leaves them as the transcript recorded them.
          */
          const approvals = await approvalMessages(userId, agentId, threadConversationId);
          decisionsRead = approvals.status;
          thread = [
            ...buildThread(got.turns ?? [], got.displayEvents ?? [], approvals.live, connectors),
            ...approvals.messages,
          ];
          thread = await withMemoryUsed(
            agentId,
            userId,
            threadConversationId,
            thread,
            got.turns ?? [],
          );
        }
      }

      // One read, both halves (TASK-498) — see `deriveState`. The state word
      // and the "Right now" line are two readings of the same record, and
      // taking them from two different sources is how the header came to say
      // "Working" over a phrase that was not there.
      const activityLine = await readActivity(agentId);

      res.status(200).json({
        agent: toWorkspaceAgent(agent, deriveState(activityLine), activityLine),
        // There is no `permissions` here any more. The rail's three blocks have
        // their own producer — `GET /api/workspace/agents/:agentId/rail` — for
        // the reason the feed and the queue got theirs: one collection, one
        // producer, and a security claim that cannot be paginated or refreshed
        // separately from the panel it hangs off is a claim nobody can reload
        // when it looks wrong.
        conversationId: threadConversationId,
        thread,
        decisions: { status: decisionsRead },
        past,
        memory: await readMemory(agent, userId),
        connectorTools: connectorNamesToRows(connectors),
      } satisfies AgentDetail);
    },

    /**
     * GET /api/workspace/agents/:agentId/files — what this agent has written.
     *
     * STRICT, like the scoped activity read and unlike the roster fan-out: on
     * this tab the listing IS the page. A swallowed failure would render
     * "{agent} has not written anything yet" over a workspace we simply could
     * not read, and the reader would have no way to tell the difference (H7).
     * So a throw propagates and the tab shows an error.
     *
     * NOTE ON ISOLATION. BOTH workspace backends now partition by `agentId`
     * — `git-protocol` by shard (TASK-257), `local` by one bare repo per
     * agent (TASK-396) — so this listing is genuinely one agent's tree on
     * either, shared by every user authorized to reach that agent.
     *
     * This comment used to say the opposite about `local`, and it was right:
     * that backend kept ONE tree for the whole deployment and this route
     * served it to whoever asked. It took a user being shown another user's
     * agent's file on a live deployment before anyone fixed the thing the
     * comment had been describing.
     *
     * The isolation is the BACKEND's partition plus the `agents:resolve` ACL
     * above — not this route's filtering, of which there is none: a tree has
     * no per-user prefix to scope by, and deliberately so. What this route
     * owes them is an honest ctx: `agentWorkspaceCtx(agentId, userId)`, built
     * from the session's identity and the agent `agents:resolve` just
     * approved, never from anything the request supplied.
     */
    async agentFiles(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      // ACL first: a not-accessible agent → 404, before we touch any storage.
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      if (!bus.hasService('workspace:list')) {
        // No workspace backend is loaded. An empty list here would say "this
        // agent has written nothing", which is a claim about the agent when
        // the truth is a fact about the deployment.
        res.status(503).json({ error: 'workspace-unavailable' });
        return;
      }

      const out = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        agentWorkspaceCtx(agentId, userId),
        {},
      );
      const servable = (out.paths ?? []).filter(isServableWorkspaceFile);
      res.status(200).json({
        files: servable.slice(0, WORKSPACE_FILES_MAX).map(toFileSummary),
        truncated: servable.length > WORKSPACE_FILES_MAX,
      } satisfies AgentFilesResponse);
    },

    /**
     * GET /api/workspace/agents/:agentId/files/* — one file's text.
     *
     * The only route on this surface that takes a PATH from the caller, which
     * makes it the one worth reading twice. The order below is the security
     * property, not a style choice:
     *
     *   1. authenticate    — identity is the session's, never the request's.
     *   2. ACL             — `agents:resolve`, and a failure is 404.
     *   3. validate path   — `workspaceFilePath`, which decodes exactly once.
     *   4. apply the same exclusion the listing uses.
     *   5. only now, read.
     *
     * Steps 2 and 3 are in that order deliberately. Validating first means a
     * caller poking at someone else's agent learns which of their paths are
     * well-formed — a 400 for one path and a 404 for another is an oracle,
     * and building one out of an error code is free for the attacker.
     *
     * The splat arrives from `@ax/http-server` VERBATIM: undecoded, slashes
     * intact (router.ts says so, and `@ax/static-files` depends on it). That
     * is why `workspaceFilePath` owns the single decode.
     */
    async agentFile(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      const path = workspaceFilePath(req.params['*'] ?? '');
      if (path === null) {
        res.status(400).json({ error: 'invalid-path' });
        return;
      }
      if (!isServableWorkspaceFile(path)) {
        // Not 403: from the caller's side this is simply not a file this
        // surface has, and the listing agrees — it never offered one.
        res.status(404).json({ error: 'file-not-found' });
        return;
      }

      if (!bus.hasService('workspace:read')) {
        res.status(503).json({ error: 'workspace-unavailable' });
        return;
      }

      const out = await bus.call<WorkspaceReadInput, WorkspaceReadResult>(
        'workspace:read',
        agentWorkspaceCtx(agentId, userId),
        { path },
      );
      if (!out.found) {
        res.status(404).json({ error: 'file-not-found' });
        return;
      }

      res.status(200).json({
        path,
        name: fenceLine(path, FILE_LABEL_MAX_CHARS) ?? UNREADABLE_FILE_NAME,
        ...decodeFileBody(out.bytes),
      } satisfies AgentFileResponse);
    },

    /**
     * GET /api/workspace/agents/:agentId/user-files — the DURABLE tier root.
     *
     * The other half of the Files tab, and the half that holds the agent's
     * actual deliverables: this tier is the agent's cwd and HOME, so a file it
     * writes without saying where lands here, not in the git-backed tier the
     * `/files` routes above read.
     *
     * A thin wrapper over the splat handler with an empty path — the tier root
     * is just the directory whose key is `''`, and giving it its own body would
     * be two code paths for one answer.
     */
    async agentUserFiles(req: RouteRequest, res: RouteResponse): Promise<void> {
      await readUserFilesPath(req, res, '');
    },

    /**
     * GET /api/workspace/agents/:agentId/user-files/* — one path in the tier.
     *
     * Answers a DIRECTORY listing or a FILE body depending on what the path
     * turns out to be, because the caller navigating a tree does not know
     * which it clicked until we tell it.
     *
     * The step order is the security property, copied deliberately from
     * `agentFile` above:
     *
     *   1. authenticate    — identity is the session's, never the request's.
     *   2. ACL             — `agents:resolve`, and a failure is 404.
     *   3. validate path   — `workspaceFilePath`, which decodes exactly once.
     *   4. only now, read.
     *
     * 2 before 3 matters more here than anywhere else on this surface. The
     * backing mount is ONE export holding EVERY agent's subtree, so a caller
     * poking at another tenant's agent must not be able to tell a malformed
     * path (400) from a well-formed one (404) — that difference is a free
     * oracle for mapping someone else's files, and this is the route where
     * there is something on the other side of it worth mapping.
     *
     * Below the ACL, the confinement is the sandbox provider's: it joins the
     * validated agentId itself and realpath-confines every component under it
     * (@ax/user-files-read), so an agent-planted symlink cannot walk out of its
     * own subtree. This route does not get to decide which subtree it reads —
     * it hands over an `owner` and the provider resolves the mount. That is
     * deliberate: one place decides, and it is the place that already owns the
     * per-agent mount for the live session.
     *
     * Note what is NOT filtered here: `isServableWorkspaceFile`'s `.ax/`,
     * `.claude/`, `memory/` exclusions are about the OTHER tier's machinery,
     * which the runner's PreToolUse re-rooter keeps off this one anyway.
     * Applying them here would hide a directory the user themselves named
     * `memory/`, which on their own file area is just a lie about their files.
     */
    async agentUserFile(req: RouteRequest, res: RouteResponse): Promise<void> {
      await readUserFilesPath(req, res, req.params['*'] ?? '');
    },

    /**
     * GET /api/workspace/agents/:agentId/download/files/* — the BYTES of one
     * governed-tier file.
     *
     * The read route above answers with TEXT and says so when it could not:
     * `clipped: 'binary'` for a PDF, `clipped: 'too-large'` for a long log. An
     * agent that made you a spreadsheet therefore showed up on this surface as
     * the word "binary", with no way to get the thing itself. This is that way.
     *
     * It is a SIBLING of the read, not a mode of it: the same auth, the same
     * ACL, the same single decode, the same exclusion — and a different
     * response, because bytes and a JSON envelope are different answers. The
     * five steps are copied from `agentFile` deliberately, ordering included:
     *
     *   1. authenticate    — identity is the session's, never the request's.
     *   2. ACL             — `agents:resolve`, and a failure is 404.
     *   3. validate path   — `workspaceFilePath`, which decodes exactly once.
     *   4. apply the same exclusion the listing uses.
     *   5. only now, read.
     *
     * Steps 2-before-3 is the oracle argument from `agentFile`, and it is not
     * weaker here: a 400-vs-404 split on somebody else's agent would still say
     * which of their paths are well-formed.
     */
    async agentFileDownload(
      req: RouteRequest,
      res: DownloadRouteResponse,
    ): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      const path = workspaceFilePath(req.params['*'] ?? '');
      if (path === null) {
        res.status(400).json({ error: 'invalid-path' });
        return;
      }
      if (!isServableWorkspaceFile(path)) {
        // Same answer the read route gives, for the same reason: the listing
        // never offered this file, so from the caller's side it is not here.
        // A download route that served `.ax/IDENTITY.md` would be a bypass of
        // an exclusion the other route enforces, which is how a cosmetic
        // filter is born.
        res.status(404).json({ error: 'file-not-found' });
        return;
      }

      if (!bus.hasService('workspace:read')) {
        res.status(503).json({ error: 'workspace-unavailable' });
        return;
      }

      const out = await bus.call<WorkspaceReadInput, WorkspaceReadResult>(
        'workspace:read',
        agentWorkspaceCtx(agentId, userId),
        { path },
      );
      if (!out.found) {
        res.status(404).json({ error: 'file-not-found' });
        return;
      }

      /*
        No truncation question on this tier: `workspace:read` answers with the
        WHOLE blob (the 128 KiB `clipped` bound is the READ route's JSON
        envelope, not the backend's), so nothing here can be a prefix. The
        durable tier below is the one that has to check.

        Said plainly, because it is the other side of that coin: this tier has
        no read cap at all, so a huge committed file is a huge buffer in this
        process. That is NOT new — the read route above already pulls the same
        whole blob into memory and only clips on the way out — and it is not
        something this route can fix without breaking the one promise it makes,
        which is that what you get is the file. A bound belongs on the backend
        or on a streaming read, not here.
      */
      sendFileDownload(res, path, out.bytes);
    },

    /**
     * GET /api/workspace/agents/:agentId/download/user-files/* — the BYTES of
     * one durable-tier file.
     *
     * The other tier's download, and a separate route for the same reason the
     * reads are separate: a different backend behind it, failing
     * independently. Folding both into one route with a `?tier=` would put a
     * caller-supplied string in charge of which backend we read, which is a
     * choice we would then have to validate; two registered paths make it a
     * fact about the route table instead.
     *
     * TWO THINGS THIS ROUTE DOES THAT ITS GOVERNED SIBLING DOES NOT:
     *
     *   - It refuses a DIRECTORY. The read route answers a listing there,
     *     because a caller walking a tree does not know which it clicked. A
     *     download does know — it is only ever offered on a file — so a folder
     *     arriving here is a malformed request, not a listing request.
     *   - It refuses a TRUNCATED file. `sandbox:read-user-files` bounds one
     *     read (an unbounded read of an NFS file into the host process is a
     *     denial of service against the host) and answers with a PREFIX. A
     *     prefix is fine for a preview that SAYS it is showing the beginning.
     *     It is not fine here: a truncated PDF is a corrupt PDF that looks
     *     exactly like a whole one, and the person would find out when they
     *     opened it, not when they clicked. So we say no, out loud, and say
     *     why — which is the honest half of not being able to serve it.
     *
     * `truncated !== false` rather than `=== true`: a realization that has not
     * been taught the field yet answers `undefined`, and "we do not know
     * whether this is the whole file" is not a promise we can pass on to
     * somebody as a file.
     */
    async agentUserFileDownload(
      req: RouteRequest,
      res: DownloadRouteResponse,
    ): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      // ACL FIRST — see `agentUserFile`. This tier is ONE export holding every
      // tenant's subtree, so a 400-vs-404 split below this line would be an
      // oracle over somebody else's files.
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      // No root download: the tier root is a directory, and `workspaceFilePath`
      // rejects the empty string, so this is the same 400 a malformed path gets.
      const relPath = workspaceFilePath(req.params['*'] ?? '');
      if (relPath === null) {
        res.status(400).json({ error: 'invalid-path' });
        return;
      }

      if (!bus.hasService('sandbox:read-user-files')) {
        res.status(503).json({ error: 'user-files-unavailable' });
        return;
      }

      const out = await bus.call<ReadUserFilesInput, ReadUserFilesOutput>(
        'sandbox:read-user-files',
        agentWorkspaceCtx(agentId, userId),
        { owner: userFilesOwner(agent, userId), relPath },
      );

      if (out.kind === 'unavailable') {
        // Same split as the listing route: no durable tier in this deployment
        // is a 503, not a 404. Path-independent, so it is not an oracle.
        res.status(503).json({ error: 'user-files-unavailable' });
        return;
      }
      if (out.kind === 'absent') {
        res.status(404).json({ error: 'file-not-found' });
        return;
      }
      if (out.kind === 'dir') {
        res.status(400).json({ error: 'not-a-file' });
        return;
      }
      if (out.truncated !== false) {
        res.status(413).json({ error: 'file-too-large' });
        return;
      }

      sendFileDownload(res, relPath, out.contents);
    },

    /**
     * GET /api/workspace/agents/:agentId/rail — the right-hand rail.
     *
     * THE ACL FOR `agent-activity:get` LIVES HERE. That hook has none of its
     * own — it answers for whatever agentId it is handed, and documents that
     * whoever mounts it owes the route a check. `resolveAgentOr404` is that
     * check: without it, any signed-in user could read any other user's agent's
     * activity line by guessing an id.
     *
     * Four independent reads, four independent statuses. A section that has no
     * producer in this deployment and a section whose producer we could not
     * read are DIFFERENT answers, and neither of them is an empty array — on
     * this surface an empty array is a claim about the agent's reach.
     */
    async rail(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      const [activity, permissions, grants, counters] = await Promise.all([
        readActivity(agentId),
        readPermissions(agent),
        readGrants(userId, agent),
        readCounters(userId, agentId),
      ]);
      res
        .status(200)
        .json({ activity, permissions, grants, counters } satisfies AgentRailData);
    },

    /**
     * POST /api/workspace/agents/:agentId/grants/revoke — take one back.
     *
     * The body carries the `ref` the rail handed out, verbatim. Nothing here
     * parses a display string to find its target: a revoke that re-derived what
     * to remove from what a row happened to say is a revoke that can remove the
     * wrong thing.
     *
     * `revoked: false` is a real answer — the grant was already gone — and it
     * is reported as one rather than dressed up as success.
     */
    async revokeGrant(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.toString('utf-8')) as unknown;
      } catch {
        res.status(400).json({ error: 'invalid-json' });
        return;
      }
      const ref = readGrantRef((parsed as { ref?: unknown } | null)?.ref);
      if (ref === null) {
        res.status(400).json({ error: 'invalid-grant' });
        return;
      }

      // Ownership is the (userId, agentId) pair on every write below. A ref
      // naming somebody else's skill simply matches no row — the store's key
      // includes the owner and the agent, so there is nothing to widen.
      if (ref.grant === 'site') {
        if (!bus.hasService('host-grants:revoke')) {
          res.status(503).json({ error: 'grants-unavailable' });
          return;
        }
        const out = await bus.call<HostGrantsRevokeInput, HostGrantsRevokeOutput>(
          'host-grants:revoke',
          initCtx,
          { ownerUserId: userId, agentId, host: ref.host },
        );
        res.status(200).json({ revoked: out.revoked === true });
        return;
      }

      if (!bus.hasService('skills:approved-caps-revoke')) {
        res.status(503).json({ error: 'grants-unavailable' });
        return;
      }
      const out = await bus.call<ApprovedCapsRevokeInput, ApprovedCapsRevokeOutput>(
        'skills:approved-caps-revoke',
        initCtx,
        {
          ownerUserId: userId,
          agentId,
          kind: ref.capKind,
          value: ref.value,
          ...(ref.skillId !== null
            ? { skillId: ref.skillId }
            : { connectorId: ref.connectorId ?? '' }),
        },
      );
      res.status(200).json({ revoked: out.cleared === true });
    },

    /**
     * GET /api/workspace/agents/:agentId/abilities — the three "Other
     * abilities" switches (TASK-738).
     *
     * ACL is `agents:resolve`, and a refusal is a 404 like every per-agent
     * route here. Read and write share that gate on purpose: the people
     * `agents:resolve` lets in (the owner of a personal agent, a member of a
     * team agent's team) are exactly the people `@ax/agents`' write rule lets
     * edit it, so a separate 403 branch would be unreachable.
     */
    async abilities(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;
      if (!bus.hasService('tool-policy:list-agent-overrides')) {
        // No verdict store: there is nothing a switch could change, and three
        // "on" switches would claim a control that does not exist.
        res.status(503).json({ error: 'abilities-unavailable' });
        return;
      }
      const out = await bus.call<{ agentId: string }, ToolPolicyListAgentOverridesOutput>(
        'tool-policy:list-agent-overrides',
        agentWorkspaceCtx(agentId, userId),
        { agentId },
      );
      res.status(200).json({ abilities: abilitiesFrom(out) } satisfies AgentAbilitiesRead);
    },

    /**
     * PUT /api/workspace/agents/:agentId/abilities — flip ONE switch.
     *
     * Off writes a `deny` override; on CLEARS the override (never writes
     * `allow`), so turning a switch back on returns the tool to whatever the
     * deployment's own rules say — it can never loosen past them. The answer
     * is the re-read state, so the browser shows what the store holds rather
     * than what it asked for.
     */
    async setAbility(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;
      if (
        !bus.hasService('tool-policy:set-agent-override') ||
        !bus.hasService('tool-policy:list-agent-overrides')
      ) {
        res.status(503).json({ error: 'abilities-unavailable' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.toString('utf-8')) as unknown;
      } catch {
        res.status(400).json({ error: 'invalid-json' });
        return;
      }
      const body = parsed as { ability?: unknown; enabled?: unknown } | null;
      if (!isAgentAbility(body?.ability) || typeof body?.enabled !== 'boolean') {
        res.status(400).json({ error: 'invalid-ability' });
        return;
      }

      const ctx = agentWorkspaceCtx(agentId, userId);
      const wrote = await bus.call<
        ToolPolicySetAgentOverrideInput,
        ToolPolicySetAgentOverrideOutput
      >('tool-policy:set-agent-override', ctx, {
        agentId,
        toolKey: ABILITY_TOOL_KEYS[body.ability],
        verdict: body.enabled ? null : 'deny',
      });
      if (wrote.ok !== true) {
        // Neither `deny` nor a clear can be looser than a ceiling, so this is
        // the store refusing for a reason of its own. Say so; never "saved".
        res.status(409).json({ error: 'ability-not-saved', reason: wrote.reason });
        return;
      }
      const out = await bus.call<{ agentId: string }, ToolPolicyListAgentOverridesOutput>(
        'tool-policy:list-agent-overrides',
        ctx,
        { agentId },
      );
      res.status(200).json({ abilities: abilitiesFrom(out) } satisfies AgentAbilitiesRead);
    },

    /**
     * GET /api/workspace/agents/:agentId/connectors — the Connectors tab's
     * list (TASK-739, connectors-rail slice 6).
     *
     * The list is `connectors:list-effective` — the SAME union a session opens
     * with (workspace defaults ∪ this agent's attachments ∪ the caller's own
     * legacy connectors, minus this agent's exclusions) — so the rail cannot
     * show a different set than the agent actually gets. Read under the
     * caller, as a session opened by the caller would be.
     */
    async connectors(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authActorOr401(bus, initCtx, req, res);
      if (actor === null) return;
      const userId = actor.id;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;
      if (!bus.hasService('connectors:list-effective')) {
        res.status(503).json({ error: 'connectors-unavailable' });
        return;
      }
      const out = await listEffectiveConnectors(agent, userId);
      const rows = toConnectorRows(out);
      const [health, canExclude] = await Promise.all([
        connectorHealth(agentId, userId, rows.map((r) => r.id), connectorsNotLoaded(out)),
        rows.some((r) => r.source !== 'attached')
          ? connectorExclusionAllowed(agentId, actor)
          : Promise.resolve(false),
      ]);
      res.status(200).json({
        connectors: rows.map((r) => ({
          ...r,
          health: health.health.get(r.id) ?? 'ok',
          ...(health.sharedSignIn.has(r.id) ? { sharedSignIn: true as const } : {}),
          removable: r.source === 'attached' ? true : canExclude,
        })),
        shared: agent.visibility === 'team',
        connectorsSupported: runnerLoadsConnectors(agent.runner),
      } satisfies AgentConnectorsRead);
    },

    /**
     * POST /api/workspace/agents/:agentId/connectors/:connectorId/retry —
     * the row menu's "Retry" (TASK-741).
     *
     * The ONE place the rail checks a connector afresh: exactly one forced
     * `connectors:describe-tools` for one connector the caller can already see
     * on this agent (a connector outside the agent's list is a 404, so this
     * cannot be used to make the host reach arbitrary connectors). Answers the
     * connector's health afterwards, from the same stored state the list reads
     * — a check that hit a rejected sign-in comes back `needs-reconnect`.
     */
    async retryConnector(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const connectorId = req.params.connectorId ?? '';
      if (!isConnectorId(connectorId)) {
        res.status(400).json({ error: 'invalid-connector' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;
      if (
        !bus.hasService('connectors:list-effective') ||
        !bus.hasService('connectors:describe-tools')
      ) {
        res.status(503).json({ error: 'connectors-unavailable' });
        return;
      }
      const out = await listEffectiveConnectors(agent, userId);
      const listed = (Array.isArray(out?.connectors) ? out.connectors : []).some(
        (c) => c?.summary?.id === connectorId,
      );
      if (!listed) {
        res.status(404).json({ error: 'connector-not-found' });
        return;
      }
      // TASK-756 — cooldown per (person, connector). Inside the window no new
      // check runs: the same agent gets what the last check found (a burst
      // shares the one in flight); another agent gets its stored health.
      const cooldownKey = JSON.stringify([userId, connectorId]);
      const at = now().getTime();
      const recent = retryCooldown.get(cooldownKey);
      let checked: RetryCheck | 'stored';
      if (recent !== undefined && at >= recent.at && at - recent.at < CONNECTOR_RETRY_COOLDOWN_MS) {
        initCtx.logger.info('workspace_connector_retry_cooled_down', { agentId, connectorId });
        checked = recent.agentId === agentId ? await recent.checked : 'stored';
      } else {
        const run = (async (): Promise<RetryCheck> => {
          try {
            const r = await bus.call<
              { userId: string; agentId: string; connectorId: string; force: true },
              DescribeToolsOutput
            >('connectors:describe-tools', agentWorkspaceCtx(agentId, userId), {
              userId,
              agentId,
              connectorId,
              force: true,
            });
            return r?.status ?? 'unknown';
          } catch (err) {
            const transient = (err as { code?: unknown } | null)?.code === 'credential-unavailable';
            initCtx.logger.warn('workspace_connector_retry_failed', {
              agentId,
              connectorId,
              name: err instanceof Error ? err.name : 'unknown',
              transient,
            });
            // `credential-unavailable` (TASK-756): the sign-in could not be
            // read just now — which says nothing about whether it works.
            return transient ? 'unavailable' : 'failed';
          }
        })();
        const entry: RetryEntry = { at, agentId, checked: run };
        rememberBounded(retryCooldown, cooldownKey, entry, CONNECTOR_RETRY_COOLDOWN_MS, CONNECTOR_RETRY_COOLDOWN_MAX_KEYS);
        checked = await run;
        // A credential blip never reached the server, so it is nothing the
        // cooldown protects against — and "try again" must mean it. Forget it
        // (only if nothing newer has replaced it), so the next Retry checks.
        if (checked === 'unavailable' && retryCooldown.get(cooldownKey) === entry) {
          retryCooldown.delete(cooldownKey);
        }
      }
      if (checked === 'failed' || checked === 'unavailable') {
        res.status(502).json({ error: 'retry-failed' });
        return;
      }
      // Reachability comes from the check just made; whether its sign-in was
      // rejected comes from the marker that check's token resolve would have
      // written — the same rule the list applies.
      const notLoaded = connectorsNotLoaded(out);
      const stored = await connectorHealth(agentId, userId, [connectorId], notLoaded);
      const storedHealth = stored.health.get(connectorId) ?? 'ok';
      const health =
        checked === 'stored'
          ? storedHealth
          : healthOf(
              notLoaded,
              new Set(storedHealth === 'needs-reconnect' ? [connectorId] : []),
              new Map([[connectorId, checked]]),
              connectorId,
            );
      res.status(200).json({
        health,
        ...(health === 'needs-reconnect' && stored.sharedSignIn.has(connectorId)
          ? { sharedSignIn: true as const }
          : {}),
      } satisfies AgentConnectorRetried);
    },

    /**
     * POST /api/workspace/agents/:agentId/connectors — attach one connector.
     *
     * One id per call, through `agents:attach-connector`, which is atomic
     * (two people attaching at once never lose either write) and which owns
     * the workspace-connector rule: only an admin may attach a connector that
     * spends the company's key. This route does not re-decide that; it passes
     * the caller's identity and reports the hook's refusal as a 403.
     */
    async attachConnector(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authActorOr401(bus, initCtx, req, res);
      if (actor === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, actor.id, res);
      if (agent === null) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.toString('utf-8')) as unknown;
      } catch {
        res.status(400).json({ error: 'invalid-json' });
        return;
      }
      const connectorId = (parsed as { connectorId?: unknown } | null)?.connectorId;
      if (!isConnectorId(connectorId)) {
        res.status(400).json({ error: 'invalid-connector' });
        return;
      }
      if (!bus.hasService('agents:attach-connector')) {
        res.status(503).json({ error: 'connectors-unavailable' });
        return;
      }
      // TASK-761 — signed in / keyed FIRST, attached second (see the gate).
      const gate = await attachCredentialGate(
        bus,
        agentWorkspaceCtx(agentId, actor.id),
        initCtx.logger,
        { id: actor.id, isAdmin: actor.isAdmin },
        connectorId,
      );
      if (!gate.ok) {
        res
          .status(gate.status)
          .json(gate.message === undefined ? { error: gate.error } : { error: gate.error, message: gate.message });
        return;
      }
      try {
        const out = await bus.call<AgentsAttachConnectorInput, AgentsConnectorChangeOutput>(
          'agents:attach-connector',
          agentWorkspaceCtx(agentId, actor.id),
          { actor: { userId: actor.id, isAdmin: actor.isAdmin }, agentId, connectorId },
        );
        res.status(200).json({ attached: true, changed: out.changed === true });
      } catch (err) {
        if (connectorWriteRefused(res, err)) return;
        throw err;
      }
    },

    /**
     * DELETE /api/workspace/agents/:agentId/connectors/:connectorId —
     * "Remove from <agent>".
     *
     * What removing means depends on where the connector came from, and the
     * server works that out from the same effective list the tab drew:
     * an `attached` one is detached; a workspace `default` or the caller's own
     * `legacy-owned` one is EXCLUDED from this agent (the connector, and every
     * other agent using it, are untouched — product decision 4). A connector
     * that is not in this agent's list is a 404, never a silent exclusion.
     *
     * Excluding a `default` or `legacy-owned` connector from a TEAM agent
     * takes it away from every member, so it is the agent's owner (a team
     * admin) or a workspace admin only (TASK-765). @ax/agents enforces that
     * inside `agents:detach-connector`; its `forbidden` is a 403 here, and
     * nothing is cleaned up. The GET's `removable` is only the same answer
     * shown ahead of time.
     *
     * After the detach lands, what this agent held for the connector goes
     * too: its per-tool choices (tool-policy overrides under the connector's
     * tool namespaces) and the access the caller approved for it. Those are
     * best-effort — the agent can no longer reach the connector, so a leftover
     * row is inert — and a miss is reported as `cleanup: 'partial'` rather
     * than dressed up as complete.
     */
    async removeConnector(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await authActorOr401(bus, initCtx, req, res);
      if (actor === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const connectorId = req.params.connectorId ?? '';
      if (!isConnectorId(connectorId)) {
        res.status(400).json({ error: 'invalid-connector' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, actor.id, res);
      if (agent === null) return;
      if (
        !bus.hasService('connectors:list-effective') ||
        !bus.hasService('agents:detach-connector')
      ) {
        res.status(503).json({ error: 'connectors-unavailable' });
        return;
      }
      const out = await listEffectiveConnectors(agent, actor.id);
      const entry = (Array.isArray(out?.connectors) ? out.connectors : []).find(
        (c) => c?.summary?.id === connectorId,
      );
      if (entry === undefined) {
        res.status(404).json({ error: 'connector-not-found' });
        return;
      }
      const ctx = agentWorkspaceCtx(agentId, actor.id);
      try {
        await bus.call<AgentsDetachConnectorInput, AgentsConnectorChangeOutput>(
          'agents:detach-connector',
          ctx,
          {
            actor: { userId: actor.id, isAdmin: actor.isAdmin },
            agentId,
            connectorId,
            exclude: entry.source !== 'attached',
          },
        );
      } catch (err) {
        if (connectorWriteRefused(res, err)) return;
        throw err;
      }
      const complete = await clearConnectorLeftovers(
        ctx,
        actor.id,
        agentId,
        connectorId,
        Array.isArray(entry.toolNamespaces) ? entry.toolNamespaces : [],
      );
      res.status(200).json({
        removed: true,
        cleanup: complete ? 'complete' : 'partial',
      } satisfies AgentConnectorRemoved);
    },

    /**
     * GET /api/workspace/agents/:agentId/connectors/:connectorId/tools
     * [?refresh=1] — one connector's tools, with what THIS agent gets for
     * each (TASK-742, connectors-rail slice 9).
     *
     * The connector must be in the agent's effective list — the set a session
     * actually opens with — or it is a 404: a details view for a connector the
     * agent does not have would offer choices that govern nothing.
     *
     * The tool list is best-effort (an unreachable server, or a preset without
     * `connectors:describe-tools`, answers `status` and no inventory rows), but
     * a choice the agent already HOLDS is always shown, as a row of its own,
     * even when the server cannot be asked right now — a deny that vanished
     * from the screen whenever the vendor was down would be a control that
     * hides its own state.
     *
     * Each row's `ceiling` is the admin's limit and `verdict` is the strictest
     * of that and the agent's own choice: what the gate does, not what was
     * asked for. A ceiling the store does not report reads as `hold`, the
     * gate's own default for a connector tool nobody has decided on.
     *
     * Titles and descriptions are the connector server's words — untrusted,
     * fenced and clamped here, at the boundary, so no renderer has to remember.
     */
    async connectorTools(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const connectorId = req.params.connectorId ?? '';
      if (!isConnectorId(connectorId)) {
        res.status(400).json({ error: 'invalid-connector' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;
      if (!bus.hasService('connectors:list-effective')) {
        res.status(503).json({ error: 'connectors-unavailable' });
        return;
      }
      if (
        !bus.hasService('tool-policy:list-agent-overrides') ||
        !bus.hasService('tool-policy:get-connector-defaults')
      ) {
        // No verdict store: every choice on this screen would be a control
        // that changes nothing.
        res.status(503).json({ error: 'tool-permissions-unavailable' });
        return;
      }
      const effective = await listEffectiveConnectors(agent, userId);
      const entry = (Array.isArray(effective?.connectors) ? effective.connectors : []).find(
        (c) => c?.summary?.id === connectorId,
      );
      if (entry === undefined) {
        res.status(404).json({ error: 'connector-not-found' });
        return;
      }
      const namespaces = ownToolNamespaces(entry);
      const own = new Set(namespaces);
      const ctx = agentWorkspaceCtx(agentId, userId);

      let status: AgentConnectorToolsRead['status'] = 'unknown';
      let checkedAt: string | null = null;
      let inventory: DescribeToolsInventoryOutput['tools'] = [];
      if (namespaces.length > 0 && bus.hasService('connectors:describe-tools')) {
        try {
          const out = await bus.call<DescribeToolsInput, DescribeToolsInventoryOutput>(
            'connectors:describe-tools',
            ctx,
            {
              userId,
              agentId,
              connectorId,
              ...(req.query.refresh === '1' && { force: true }),
            },
          );
          status = INVENTORY_STATUSES.has(out?.status) ? out.status : 'unknown';
          checkedAt = typeof out?.checkedAt === 'string' ? out.checkedAt : null;
          inventory = Array.isArray(out?.tools) ? out.tools : [];
        } catch (err) {
          // The list is a convenience, never a gate: a failed lookup reads as
          // "we can't list them right now", and held choices still show.
          initCtx.logger.warn('workspace_connector_tools_inventory_failed', {
            agentId,
            connectorId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const defaults = new Map<string, AgentToolVerdict>();
      if (namespaces.length > 0) {
        const out = await bus.call<GetConnectorDefaultsInput, GetConnectorDefaultsOutput>(
          'tool-policy:get-connector-defaults',
          ctx,
          { connectorId, toolNamespaces: namespaces },
        );
        for (const d of Array.isArray(out?.defaults) ? out.defaults : []) {
          if (typeof d?.toolKey !== 'string') continue;
          // An unreadable verdict fails closed: Ask first, never Allow.
          defaults.set(d.toolKey, isToolVerdict(d.verdict) ? d.verdict : 'hold');
        }
      }
      const overrides = new Map<string, { verdict: AgentToolVerdict; ceiling?: AgentToolVerdict }>();
      const listed = await bus.call<{ agentId: string }, ToolPolicyListAgentOverridesOutput>(
        'tool-policy:list-agent-overrides',
        ctx,
        { agentId },
      );
      for (const o of Array.isArray(listed?.overrides) ? listed.overrides : []) {
        const key = o?.toolKey;
        if (typeof key !== 'string') continue;
        const ns = connectorToolNamespace(key);
        if (ns === null || !own.has(ns)) continue;
        overrides.set(key, {
          verdict: isToolVerdict(o.verdict) ? o.verdict : 'hold',
          ...(o.ceiling !== undefined && { ceiling: isToolVerdict(o.ceiling) ? o.ceiling : 'hold' }),
        });
      }
      // TASK-754 — the agent copied these namespaces' defaults, so a tool with
      // no row of its own is Ask first for it, even if the default is looser
      // now. Show what the gate enforces, not the live default.
      const copied = new Set(
        (Array.isArray(listed?.copiedNamespaces) ? listed.copiedNamespaces : []).filter(
          (ns): ns is string => typeof ns === 'string' && own.has(ns),
        ),
      );

      const row = (
        toolKey: string,
        ns: string,
        fields: Partial<DescribeToolsInventoryOutput['tools'][number]>,
      ): AgentConnectorTool => {
        const override = overrides.get(toolKey);
        const ceiling = override?.ceiling ?? defaults.get(toolKey) ?? 'hold';
        const held: AgentToolVerdict | undefined =
          override === undefined && copied.has(ns) ? 'hold' : undefined;
        return {
          toolKey,
          title: connectorToolTitle(toolKey, ns, fields.title, fields.name),
          description: fenceToolDescription(fields.description),
          readOnly: typeof fields.readOnly === 'boolean' ? fields.readOnly : null,
          outward: typeof fields.outward === 'boolean' ? fields.outward : null,
          verdict: strictestVerdict(override?.verdict ?? held, ceiling),
          ceiling,
        };
      };

      const tools: AgentConnectorTool[] = [];
      const seen = new Set<string>();
      const listedNamespaces = new Set<string>();
      for (const t of inventory) {
        if (tools.length >= CONNECTOR_TOOLS_MAX_ROWS) break;
        const key = t?.toolKey;
        if (typeof key !== 'string' || key.length > CONNECTOR_TOOL_KEY_MAX_CHARS) continue;
        if (seen.has(key)) continue;
        const ns = connectorToolNamespace(key);
        // Only this connector's own tools: a server that answers with
        // another namespace's keys must not get a row it could be set from.
        if (ns === null || !own.has(ns)) continue;
        seen.add(key);
        listedNamespaces.add(ns);
        tools.push(row(key, ns, t));
      }
      for (const key of overrides.keys()) {
        if (tools.length >= CONNECTOR_TOOLS_MAX_ROWS) break;
        if (seen.has(key) || key.length > CONNECTOR_TOOL_KEY_MAX_CHARS) continue;
        const ns = connectorToolNamespace(key);
        if (ns === null) continue;
        seen.add(key);
        tools.push(row(key, ns, {}));
      }

      res.status(200).json({
        connector: {
          id: connectorId,
          name: fenceLine(entry.summary.name, RAIL_LABEL_MAX_CHARS) ?? connectorId,
          access: entry.summary.keyMode === 'workspace' ? 'workspace' : 'personal',
        },
        status,
        checkedAt,
        // A server that cannot be listed from the host (stdio) answers with
        // none of its tools; saying "this is all of them" would be a lie.
        possiblyIncomplete: status === 'ok' && namespaces.some((ns) => !listedNamespaces.has(ns)),
        tools,
      } satisfies AgentConnectorToolsRead);
    },

    /**
     * PUT /api/workspace/agents/:agentId/connectors/:connectorId/tool-verdicts
     * — set ONE tool's Allow / Ask first / Deny for this agent (TASK-742).
     *
     * The key must be a tool of THIS connector, in THIS agent's effective
     * list. That binding is the security-relevant check: `set-agent-override`
     * trusts its caller about which keys a person may touch, so without it a
     * person could write a verdict for a connector the agent does not have,
     * or for a non-connector key like `Bash` — and loosening `Bash` is
     * exactly what "Other abilities" never offers.
     *
     * `null` (clear) is not accepted: every choice on this screen is a real
     * verdict, and a clear would silently fall back to whatever the admin
     * says. The store refuses anything looser than the admin's ceiling, and
     * that refusal is a 409 carrying the ceiling — never "saved". The answer
     * is the store's re-read state, not an echo of the request.
     */
    async setConnectorToolVerdict(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const connectorId = req.params.connectorId ?? '';
      if (!isConnectorId(connectorId)) {
        res.status(400).json({ error: 'invalid-connector' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;
      if (!bus.hasService('connectors:list-effective')) {
        res.status(503).json({ error: 'connectors-unavailable' });
        return;
      }
      if (
        !bus.hasService('tool-policy:set-agent-override') ||
        !bus.hasService('tool-policy:list-agent-overrides')
      ) {
        res.status(503).json({ error: 'tool-permissions-unavailable' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.toString('utf-8')) as unknown;
      } catch {
        res.status(400).json({ error: 'invalid-json' });
        return;
      }
      const body = parsed as { toolKey?: unknown; verdict?: unknown } | null;
      if (!isToolVerdict(body?.verdict)) {
        res.status(400).json({ error: 'invalid-verdict' });
        return;
      }
      const verdict = body.verdict;
      const toolKey = body.toolKey;
      const keyNamespace =
        typeof toolKey === 'string' && toolKey.length <= CONNECTOR_TOOL_KEY_MAX_CHARS
          ? connectorToolNamespace(toolKey)
          : null;
      if (typeof toolKey !== 'string' || keyNamespace === null) {
        res.status(400).json({ error: 'not-this-connectors-tool' });
        return;
      }

      const effective = await listEffectiveConnectors(agent, userId);
      const entry = (Array.isArray(effective?.connectors) ? effective.connectors : []).find(
        (c) => c?.summary?.id === connectorId,
      );
      if (entry === undefined) {
        res.status(404).json({ error: 'connector-not-found' });
        return;
      }
      if (!ownToolNamespaces(entry).includes(keyNamespace)) {
        res.status(400).json({ error: 'not-this-connectors-tool' });
        return;
      }

      const ctx = agentWorkspaceCtx(agentId, userId);
      const wrote = await bus.call<
        ToolPolicySetAgentOverrideInput,
        ToolPolicySetAgentOverrideOutput
      >('tool-policy:set-agent-override', ctx, { agentId, toolKey, verdict });
      if (wrote?.ok !== true) {
        const refusal = wrote as { reason?: unknown; ceiling?: unknown } | undefined;
        if (refusal?.reason === 'ceiling-violation') {
          res.status(409).json({
            error: 'ceiling-violation',
            ceiling: isToolVerdict(refusal.ceiling) ? refusal.ceiling : 'hold',
          });
          return;
        }
        res.status(409).json({
          error: 'verdict-not-saved',
          reason: typeof refusal?.reason === 'string' ? refusal.reason : 'unknown',
        });
        return;
      }
      let out: ToolPolicyListAgentOverridesOutput;
      try {
        out = await bus.call<{ agentId: string }, ToolPolicyListAgentOverridesOutput>(
          'tool-policy:list-agent-overrides',
          ctx,
          { agentId },
        );
      } catch (err) {
        // TASK-757 — the store already said yes (and it refuses anything
        // looser than the ceiling), so the write landed; only the read-back
        // failed. Answering 500 here made the screen say "Nothing changed"
        // about a change that HAD been made. Say what was written and that
        // we could not confirm it, rather than either lie.
        initCtx.logger.warn('workspace_tool_verdict_reread_failed', {
          agentId,
          connectorId,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(200).json({
          tool: { toolKey, verdict },
          unconfirmed: true,
        } satisfies AgentToolVerdictSaved);
        return;
      }
      const stored = (Array.isArray(out?.overrides) ? out.overrides : []).find(
        (o) => o?.toolKey === toolKey,
      );
      if (stored === undefined) {
        // The write said yes and the read says nothing is there. Say so
        // rather than report a choice the gate is not holding.
        res.status(409).json({ error: 'verdict-not-saved', reason: 'not-found-on-reread' });
        return;
      }
      const ceiling = isToolVerdict(stored.ceiling) ? stored.ceiling : 'hold';
      res.status(200).json({
        tool: {
          toolKey,
          verdict: strictestVerdict(isToolVerdict(stored.verdict) ? stored.verdict : 'hold', ceiling),
          ceiling,
        },
      } satisfies AgentToolVerdictSaved);
    },

    /**
     * PUT /api/workspace/agents/:agentId/memory/rules — save the human tier.
     *
     * This route does not write a file. It calls `memory:rules:write`, which
     * owns the one path in the memory tree no automatic writer may touch
     * (AW-13). Two sources of truth for "where the user's rules live" is
     * exactly the bug the tier exists to prevent.
     *
     * `body` is the user's own text. It is stored verbatim and rendered as
     * text; nothing here parses it, and nothing builds markup from it.
     */
    async saveRules(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      // ACL first: a not-accessible agent → 404, no existence leak. Same
      // posture as the read, and it runs BEFORE we touch any storage.
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      if (!bus.hasService('memory:rules:write')) {
        // No memory plugin is loaded. Saying "saved" would be the exact lie
        // this whole task exists to stop telling.
        res.status(503).json({ error: 'memory-unavailable' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.toString('utf-8'));
      } catch {
        res.status(400).json({ error: 'invalid-json' });
        return;
      }
      const body = (parsed as { body?: unknown } | null)?.body;
      if (typeof body !== 'string') {
        res.status(400).json({ error: 'invalid-body' });
        return;
      }

      let stored: string;
      try {
        stored = (
          await bus.call<MemoryRulesWriteInput, MemoryRulesWriteOutput>(
            'memory:rules:write',
            agentWorkspaceCtx(agentId, userId),
            { agentId, body },
          )
        ).body;
      } catch (err) {
        // A rejected payload is the caller's fault (too long, malformed);
        // anything else is ours. Either way the user is TOLD — a Save that
        // silently failed is how a hand-written rule goes missing.
        if (err instanceof PluginError && err.code === 'invalid-payload') {
          res.status(400).json({ error: 'invalid-body', detail: err.message });
          return;
        }
        // The storage limit said no (TASK-719). The write goes through
        // `workspace:apply`, whose pre-apply veto disk-quota answers with
        // `code: 'storage-full'`. This used to rethrow like any other veto and
        // surface as a 500, which the editor read as "the server ran into a
        // problem, try again" — a false hope: nothing changes until an admin
        // makes room. So it is its own answer, with ONE fixed sentence. The
        // veto's message is worded for the agent and is never sent.
        if (isStorageFullRefusal(err)) {
          res.status(413).json({ error: 'storage-full', message: STORAGE_FULL_RULES });
          return;
        }
        throw err;
      }

      res.status(200).json({ saved: true, body: stored } satisfies SaveRulesResult);
    },

    async recallFacts(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      if (!bus.hasService('memory:recall')) {
        res.status(503).json({ error: 'memory-unavailable' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.toString('utf-8'));
      } catch {
        res.status(400).json({ error: 'invalid-json' });
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }
      const body = parsed as Record<string, unknown>;
      if (
        Object.keys(body).some(
          (k) => k !== 'query' && k !== 'profile' && k !== 'history' && k !== 'conversationId',
        )
      ) {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }
      // TASK-626 — "what did this conversation teach it". A conversation id is
      // a lookup key, not a search, so it stands alone: combined with a query
      // or the profile view the question stops meaning one thing.
      if (body.conversationId !== undefined) {
        if (
          typeof body.conversationId !== 'string' ||
          body.conversationId.length === 0 ||
          body.conversationId.length > 256 ||
          body.query !== undefined ||
          body.profile !== undefined
        ) {
          res.status(400).json({ error: 'invalid-memory-request' });
          return;
        }
      }
      if (body.query !== undefined && (typeof body.query !== 'string' || body.query.trim() === '')) {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }
      if (body.profile !== undefined && typeof body.profile !== 'boolean') {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }
      if (body.history !== undefined && typeof body.history !== 'boolean') {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }

      try {
        const out = await bus.call<unknown, FactMemoryPage>(
          'memory:recall',
          agentWorkspaceCtx(agentId, userId),
          typeof body.conversationId === 'string'
            ? {
                conversationId: body.conversationId,
                activeOnly: body.history !== true,
                limit: 100,
              }
            : {
                ...(body.query !== undefined ? { query: body.query } : {}),
                ...(body.profile === true ? { profile: true } : {}),
                activeOnly: body.history !== true,
                limit: body.profile === true ? 100 : 40,
              },
        );
        res.status(200).json(out);
      } catch (err) {
        if (err instanceof PluginError && err.code === 'invalid-payload') {
          res.status(400).json({ error: 'invalid-memory-request' });
          return;
        }
        throw err;
      }
    },

    async rememberFact(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      if (!bus.hasService('memory:remember')) {
        res.status(503).json({ error: 'memory-unavailable' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.toString('utf-8'));
      } catch {
        res.status(400).json({ error: 'invalid-json' });
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }
      const body = parsed as Record<string, unknown>;
      if (
        Object.keys(body).some((k) => k !== 'about' && k !== 'relation' && k !== 'value' && k !== 'when') ||
        typeof body.about !== 'string' ||
        body.about.trim() === '' ||
        typeof body.relation !== 'string' ||
        body.relation.trim() === '' ||
        typeof body.value !== 'string' ||
        body.value.trim() === '' ||
        (body.when !== undefined && typeof body.when !== 'string')
      ) {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }

      try {
        const out = await bus.call<unknown, { id: string }>(
          'memory:remember',
          agentWorkspaceCtx(agentId, userId),
          {
            about: body.about,
            relation: body.relation,
            value: body.value,
            ...(body.when !== undefined ? { when: body.when } : {}),
          },
        );
        res.status(200).json({ id: out.id });
      } catch (err) {
        if (err instanceof PluginError && err.code === 'invalid-payload') {
          res.status(400).json({ error: 'invalid-memory-request' });
          return;
        }
        throw err;
      }
    },

    /**
     * POST /api/workspace/agents/:agentId/memory/correct — the Fix dialog's
     * save. Carries WHICH row is being corrected (`id`) and the person's
     * answer to "did it change, or was it never right?" (`reason`), which
     * plain `remember` has no room for. `@ax/memory` owns what each reason
     * does to the old row; this route only checks the shape and the caller.
     */
    async correctFact(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      if (!bus.hasService('memory:correct')) {
        res.status(503).json({ error: 'memory-unavailable' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.toString('utf-8'));
      } catch {
        res.status(400).json({ error: 'invalid-json' });
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }
      const body = parsed as Record<string, unknown>;
      if (
        Object.keys(body).some(
          (k) => k !== 'id' && k !== 'about' && k !== 'relation' && k !== 'value' && k !== 'reason',
        ) ||
        typeof body.id !== 'string' ||
        body.id.trim() === '' ||
        typeof body.about !== 'string' ||
        body.about.trim() === '' ||
        typeof body.relation !== 'string' ||
        body.relation.trim() === '' ||
        typeof body.value !== 'string' ||
        body.value.trim() === '' ||
        (body.reason !== 'changed' && body.reason !== 'never-right')
      ) {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }

      try {
        const out = await bus.call<unknown, { id: string }>(
          'memory:correct',
          agentWorkspaceCtx(agentId, userId),
          {
            id: body.id,
            about: body.about,
            relation: body.relation,
            value: body.value,
            reason: body.reason,
          },
        );
        res.status(200).json({ id: out.id });
      } catch (err) {
        if (err instanceof PluginError && err.code === 'invalid-payload') {
          res.status(400).json({ error: 'invalid-memory-request' });
          return;
        }
        throw err;
      }
    },

    async forgetFacts(req: RouteRequest, res: RouteResponse): Promise<void> {
      await idsFactsRoute(req, res, 'memory:forget', async (ctx, ids) => {
        await bus.call<unknown, unknown>('memory:forget', ctx, { ids });
        return { forgotten: true };
      });
    },

    /**
     * POST /api/workspace/agents/:agentId/memory/unforget — the Forget
     * receipt's Undo (TASK-630). Puts the forgotten rows back as they were,
     * with the provenance they had: `memory:unforget` re-opens the SAME row
     * rather than re-saving it as the person who pressed Undo. The body shape
     * and the scope are `forget`'s, so whoever could forget a memory here can
     * bring it back and nobody else.
     */
    async unforgetFacts(req: RouteRequest, res: RouteResponse): Promise<void> {
      await idsFactsRoute(req, res, 'memory:unforget', async (ctx, ids) => {
        const out = await bus.call<unknown, { restored?: unknown } | null>(
          'memory:unforget',
          ctx,
          { ids },
        );
        const restored = out?.restored;
        if (!Array.isArray(restored) || restored.some((id) => typeof id !== 'string')) {
          throw new Error('memory:unforget returned no restored list');
        }
        return { restored: restored as string[] };
      });
    },

    /**
     * POST /api/workspace/agents/:agentId/memory/uncorrect — the Fix
     * receipt's Undo (TASK-634). `id` is the row the Fix wrote and `restore`
     * the row it fixed; `memory:uncorrect` retracts the first and re-opens
     * the second as it was. `undone: false` means there was nothing left to
     * undo (a retry after a lost response) — the fix is already gone. Scope
     * and auth are `unforget`'s: whoever could fix a memory here can take the
     * fix back, and nobody else.
     */
    async uncorrectFact(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;
      const agentId = req.params.agentId ?? '';
      if (agentId.length === 0) {
        res.status(400).json({ error: 'missing-agent-id' });
        return;
      }
      const agent = await resolveAgentOr404(bus, initCtx, agentId, userId, res);
      if (agent === null) return;

      if (!bus.hasService('memory:uncorrect')) {
        res.status(503).json({ error: 'memory-unavailable' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.toString('utf-8'));
      } catch {
        res.status(400).json({ error: 'invalid-json' });
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }
      const body = parsed as Record<string, unknown>;
      if (
        Object.keys(body).some((k) => k !== 'id' && k !== 'restore') ||
        typeof body.id !== 'string' ||
        body.id.trim() === '' ||
        typeof body.restore !== 'string' ||
        body.restore.trim() === ''
      ) {
        res.status(400).json({ error: 'invalid-memory-request' });
        return;
      }

      try {
        // Awaited BEFORE `res.status` is touched: a failed call must not have
        // already stamped a 200 on the response.
        const out = await bus.call<unknown, { undone?: unknown } | null>(
          'memory:uncorrect',
          agentWorkspaceCtx(agentId, userId),
          { id: body.id, restore: body.restore },
        );
        const undone = out?.undone;
        if (typeof undone !== 'boolean') {
          throw new Error('memory:uncorrect returned no undone flag');
        }
        res.status(200).json({ undone });
      } catch (err) {
        if (err instanceof PluginError && err.code === 'invalid-payload') {
          res.status(400).json({ error: 'invalid-memory-request' });
          return;
        }
        throw err;
      }
    },

    /**
     * POST /api/workspace/route — "I typed something; who should hear it?"
     *
     * The body is accepted and discarded. The pick is derived from STRUCTURE
     * (how many agents there are, which one was used last), never from reading
     * the message: keyword matching would be a fixture wearing a trench coat,
     * and asking a model would make an unpredictable, slow, billable thing out
     * of a click.
     */
    async route(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      const agents = await listAgents(userId);
      if (agents.length === 0) {
        res.status(404).json({ error: 'no-agents' });
        return;
      }
      if (agents.length === 1) {
        const only = agents[0]!;
        res.status(200).json({
          agentId: only.id,
          agentName: only.displayName,
          why: "it's your only agent",
          confident: true,
        } satisfies RouteResult);
        return;
      }

      /*
        Most recently active wins. An agent with no conversations sorts last
        (stamp 0), and ties break on displayName so the same input always
        produces the same answer.

        `ranked` is what makes the REASON honest. The list read here is
        non-strict — one agent's hiccup must not 404 the whole picker — but a
        swallowed read makes that agent look brand new, and if every read fails
        the pick collapses to alphabetical order. Saying "you used it most
        recently" then would be a claim built on a failure nobody was told
        about. So the sentence follows what we actually managed to read.
      */
      const scored = await Promise.all(
        agents.map(async (a) => {
          let readable = true;
          const convs = await listConversations(userId, a.id, {
            onUnreadable: () => {
              readable = false;
            },
          });
          const latest = convs.reduce(
            (max, c) => Math.max(max, activityStamp(c)),
            0,
          );
          return { agent: a, latest, readable };
        }),
      );
      scored.sort(
        (x, y) =>
          y.latest - x.latest || x.agent.displayName.localeCompare(y.agent.displayName),
      );
      const top = scored[0]!;
      const ranked = top.readable && top.latest > 0;
      res.status(200).json({
        agentId: top.agent.id,
        agentName: top.agent.displayName,
        why: ranked
          ? 'it is the agent you used most recently'
          : "we couldn't tell which you used last, so this is just the first one",
        confident: false,
      } satisfies RouteResult);
    },
  };
}

/**
 * Register the workspace routes against @ax/http-server.
 *
 * Every route mounts, always. There used to be an `agentWorkspace` flag that
 * kept most of them unmounted (and a `GET /api/features` echo so the SPA could
 * ask); TASK-360 retired both, because the workspace is now the only web
 * interface and a deployment without it has no UI at all. Reachability is not
 * authority: `authOr401` and the owner-scoped checks inside each handler
 * (`decisions:get`, `resolveAgentOr404`, …) still decide who sees what.
 */
export async function registerWorkspaceRoutes(
  bus: HookBus,
  initCtx: AgentContext,
  opts: { buffer?: ChunkBuffer } = {},
): Promise<Array<() => void>> {
  // TWO CLOCKS THAT HAVE TO BE ONE. `makeWorkspaceHandlers`'s `now` stamps the
  // `declinedAt` of a "Not now"; `createChunkBuffer`'s `now` (plugin.ts, the
  // same `opts.buffer` passed in here) stamps each pending card's `raisedAt`.
  // `withoutDeclinedGrants` compares those two instants, which is only sound
  // while they come from the same clock. Neither seam is injected on this
  // path — both fall through to the system clock — and that is exactly why
  // this call passes no `now`. If one ever gains an injected clock, the other
  // has to gain the same one.
  const handlers = makeWorkspaceHandlers({
    bus,
    initCtx,
    // Spread, not a plain property: with exactOptionalPropertyTypes an
    // explicit `buffer: undefined` is not assignable to `buffer?: ChunkBuffer`
    // (the same shape the rest of this file uses for optional inputs).
    ...(opts.buffer !== undefined ? { buffer: opts.buffer } : {}),
  });
  // Same duck-typed cast as routes-attachments.ts — http-server's HttpRequest /
  // HttpResponse are a structural superset of our adapter.
  type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;
  const routes: Array<{
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handler: RouteHandler;
  }> = [
    {
      /*
        The decisions collection. The single-decision re-read below is the
        one way `undoable: false` ever reaches a browser (TASK-259): if IT
        404s, every Undo lingers the full ten seconds on a call that has
        already gone out, and a failed poll says nothing by design.
      */
      method: 'GET',
      path: '/api/workspace/decisions',
      handler: handlers.decisions as unknown as RouteHandler,
    },
    {
      method: 'GET',
      path: '/api/workspace/decisions/:decisionId',
      handler: handlers.decision as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/decisions/:decisionId/approve',
      handler: handlers.approveDecision as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/decisions/:decisionId/dismiss',
      handler: handlers.dismissDecision as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/decisions/:decisionId/undo',
      handler: handlers.undoDecision as unknown as RouteHandler,
    },
    {
      method: 'GET',
      path: '/api/workspace/state',
      handler: handlers.state as unknown as RouteHandler,
    },
    {
      // TASK-373 — the read-back for grants raised while the workspace was
      // closed. Its only consumer is the workspace surface itself (the
      // Today queue's mount fetch).
      method: 'GET',
      path: '/api/workspace/grants',
      handler: handlers.grants as unknown as RouteHandler,
    },
    {
      // TASK-444 — "Not now", recorded. It can only ever decline something
      // the read above is offering.
      method: 'POST',
      path: '/api/workspace/grants/decline',
      handler: handlers.declineGrant as unknown as RouteHandler,
    },
    {
      method: 'GET',
      path: '/api/workspace/agents/:agentId',
      handler: handlers.agentDetail as unknown as RouteHandler,
    },
    {
      method: 'GET',
      path: '/api/workspace/activity',
      handler: handlers.activity as unknown as RouteHandler,
    },
    {
      method: 'GET',
      path: '/api/workspace/agents/:agentId/files',
      handler: handlers.agentFiles as unknown as RouteHandler,
    },
    {
      /*
        The splat is a bare `*`, and it MUST be the final segment —
        `@ax/http-server`'s router only recognises that spelling (a
        `/*path` segment compiles to a LITERAL and the route then matches
        nothing but the URL `/files/*path`). The captured remainder lands
        under `req.params['*']`, undecoded.

        Registered after the exact `/files` route above only for
        readability: the router tries every non-splat pattern before any
        splat, so `/files` can never be swallowed by this one.
      */
      method: 'GET',
      path: '/api/workspace/agents/:agentId/files/*',
      handler: handlers.agentFile as unknown as RouteHandler,
    },
    {
      /*
        The DURABLE tier's root. Sibling of `/files` above and a different
        backend: `/files` reads `workspace:*` (the git-backed governed tier),
        this reads `sandbox:read-user-files` (the agent's cwd and HOME).
      */
      method: 'GET',
      path: '/api/workspace/agents/:agentId/user-files',
      handler: handlers.agentUserFiles as unknown as RouteHandler,
    },
    {
      /*
        Same splat rules as `/files/*`: a bare `*` as the FINAL segment is
        the only spelling `@ax/http-server`'s router recognises, and the
        captured remainder lands under `req.params['*']` undecoded. The
        router tries every non-splat pattern before any splat, so the exact
        `/user-files` route above can never be swallowed by this one.
      */
      method: 'GET',
      path: '/api/workspace/agents/:agentId/user-files/*',
      handler: handlers.agentUserFile as unknown as RouteHandler,
    },
    {
      /*
        THE BYTES, for each tier. Two routes, because they are two backends
        — the same reason `/files` and `/user-files` are two routes.

        `download` sits where `files`/`user-files` sit, not after them, and
        that placement is load-bearing: `/files/download/*` would be
        ambiguous with a file the agent actually named `download/…`, and the
        splat would hand both to the same handler. Here the segment is part
        of the ROUTE, so no path an agent can write can collide with it.

        Same splat rules as every other route on this surface: a bare `*` as
        the FINAL segment is the only spelling `@ax/http-server`'s router
        recognises, and the remainder arrives under `req.params['*']`
        undecoded.
      */
      method: 'GET',
      path: '/api/workspace/agents/:agentId/download/files/*',
      handler: handlers.agentFileDownload as unknown as RouteHandler,
    },
    {
      method: 'GET',
      path: '/api/workspace/agents/:agentId/download/user-files/*',
      handler: handlers.agentUserFileDownload as unknown as RouteHandler,
    },
    {
      method: 'GET',
      path: '/api/workspace/agents/:agentId/rail',
      handler: handlers.rail as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/agents/:agentId/grants/revoke',
      handler: handlers.revokeGrant as unknown as RouteHandler,
    },
    {
      // TASK-738 — the Connectors tab's "Other abilities" switches.
      method: 'GET',
      path: '/api/workspace/agents/:agentId/abilities',
      handler: handlers.abilities as unknown as RouteHandler,
    },
    {
      method: 'PUT',
      path: '/api/workspace/agents/:agentId/abilities',
      handler: handlers.setAbility as unknown as RouteHandler,
    },
    {
      // TASK-739 — the Connectors tab's list, attach, and "Remove from <agent>".
      method: 'GET',
      path: '/api/workspace/agents/:agentId/connectors',
      handler: handlers.connectors as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/agents/:agentId/connectors',
      handler: handlers.attachConnector as unknown as RouteHandler,
    },
    {
      method: 'DELETE',
      path: '/api/workspace/agents/:agentId/connectors/:connectorId',
      handler: handlers.removeConnector as unknown as RouteHandler,
    },
    {
      // TASK-741 — the row menu's "Retry": one forced check of one connector.
      method: 'POST',
      path: '/api/workspace/agents/:agentId/connectors/:connectorId/retry',
      handler: handlers.retryConnector as unknown as RouteHandler,
    },
    {
      // TASK-742 — one connector's details: its tools and this agent's
      // Allow / Ask first / Deny for each.
      method: 'GET',
      path: '/api/workspace/agents/:agentId/connectors/:connectorId/tools',
      handler: handlers.connectorTools as unknown as RouteHandler,
    },
    {
      method: 'PUT',
      path: '/api/workspace/agents/:agentId/connectors/:connectorId/tool-verdicts',
      handler: handlers.setConnectorToolVerdict as unknown as RouteHandler,
    },
    {
      method: 'PUT',
      path: '/api/workspace/agents/:agentId/memory/rules',
      handler: handlers.saveRules as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/agents/:agentId/memory/recall',
      handler: handlers.recallFacts as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/agents/:agentId/memory/remember',
      handler: handlers.rememberFact as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/agents/:agentId/memory/forget',
      handler: handlers.forgetFacts as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/agents/:agentId/memory/unforget',
      handler: handlers.unforgetFacts as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/agents/:agentId/memory/correct',
      handler: handlers.correctFact as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/agents/:agentId/memory/uncorrect',
      handler: handlers.uncorrectFact as unknown as RouteHandler,
    },
    {
      method: 'POST',
      path: '/api/workspace/route',
      handler: handlers.route as unknown as RouteHandler,
    },
  ];

  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>(
      'http:register-route',
      initCtx,
      route,
    );
    unregisters.push(result.unregister);
  }
  return unregisters;
}

// --- rail projections (module-level: pure, and unit-testable on their own) ---

/**
 * The two members this surface has authored copy for. A `Set`, so the check
 * below is a membership test against a list that exists in one place rather
 * than a chain of `===` somebody has to remember to extend.
 *
 * ONE PLACE ON THIS SIDE, FOUR ACROSS THE MIRROR (TASK-408), and this is the
 * copy that does the DROPPING: a member `@ax/tool-policy` can declare but that
 * is missing here is filtered out by `toWireEffects` without a word, and the
 * rail then claims less reach than the tool has — the understating direction
 * design H4 forbids. Nothing in the type system notices, because the hop is
 * duck-typed (invariant 2). `__tests__/server/effect-mirror-drift.test.ts`
 * does: it reads `ToolEffect` and `ToolEffectSchema` out of
 * `packages/tool-policy/src/types.ts` as text and runs every member they allow
 * through `toWirePermission`.
 */
const KNOWN_EFFECTS: ReadonlySet<string> = new Set<CapabilityEffect>([
  'outward',
  'spends',
]);

/**
 * A duck-typed hook's `effect` answer → the wire row's declared effects.
 *
 * The allow-list half of `toWirePermission`, pulled out because it is the one
 * piece of that function that has to be reasoned about on its own: it is where
 * an unvalidated `unknown` earns the type `CapabilityEffect[]`.
 *
 * Three refusals, all deliberate:
 *
 *   - NOT AN ARRAY → `[]`. A bare `'spends'`, a number, `null`, `undefined`,
 *     an object: none of them is a set of claims we can read, and guessing at
 *     one (wrapping a lone string, say) would invent a claim the impl did not
 *     make in the shape we asked for.
 *   - AN UNKNOWN MEMBER → dropped, and only that member. `['spends',
 *     'harmless']` becomes `['spends']`: the true half survives, because
 *     dropping the whole set over one invented member would understate a real
 *     effect (design H4), and copying the invented member through would put a
 *     claim on the wire that no authored copy can render.
 *   - A DUPLICATE → collapsed to its first appearance. The field is a set of
 *     claims, not a tally; nothing downstream counts them, and two identical
 *     badges on one row read as a rendering bug rather than as emphasis.
 *
 * Order is the RULE'S order, preserved. It is the only ordering information we
 * have, and re-sorting it here would be this module deciding which of a rule's
 * disclosures a reader sees first.
 */
function toWireEffects(raw: unknown): CapabilityEffect[] {
  if (!Array.isArray(raw)) return [];
  const out: CapabilityEffect[] = [];
  for (const member of raw) {
    if (typeof member !== 'string' || !KNOWN_EFFECTS.has(member)) continue;
    const known = member as CapabilityEffect;
    if (!out.includes(known)) out.push(known);
  }
  return out;
}

/**
 * `@ax/tool-policy`'s row → the wire row.
 *
 * Two jobs. It FENCES every string that survives — a capability clause is
 * in-repo and CI-linted, but `theirDescription` is a third party's prose and
 * this is the trust boundary. And it NORMALISES the optionals to `null`, so a
 * renderer never has to tell `undefined` from "not applicable".
 *
 * A described row whose clause fences to nothing DEMOTES to a mechanical one
 * rather than rendering an empty sentence: "Can  — on its own" is a security
 * claim with a hole in it.
 */
export function toWirePermission(row: PolicyCapabilityRow): PermissionRow {
  const capability = row.described
    ? fenceLine(row.capability, RAIL_LABEL_MAX_CHARS)
    : null;
  const mechanicalLabel = fenceLine(row.mechanicalLabel, RAIL_LABEL_MAX_CHARS);
  const described = row.described && capability !== null;
  return {
    verdict: row.verdict,
    capability: described ? (capability ?? '') : '',
    source: fenceLine(row.source, RAIL_LABEL_MAX_CHARS) ?? 'unknown',
    provenance: described ? row.provenance : row.provenance === 'mcp' ? 'mcp' : 'unmapped',
    described,
    // Survives the demotion above. Losing the clause loses OUR SENTENCE, not
    // the rule behind it — a row that dropped its conditionality on the way
    // down would render "Can use `x` — on its own" for a tool the table only
    // sometimes allows. `=== true` because the field is optional on a
    // duck-typed row and `undefined` must not render as a claim either way.
    conditional: row.conditional === true,
    // An ALLOW-LIST FILTER, not a cast, and the filter is per MEMBER. The
    // renderer picks authored copy KEYED on each value, so an impl answering
    // `effect: ['spends', 'harmless']` must land as `['spends']` — the true
    // half kept, the invented half dropped — rather than as a value that is
    // present on the wire and silently unrendered because the renderer's
    // `Record` doesn't have an entry for it. Known members in, known members
    // out, in the order the rule declared them; everything else falls on the
    // floor. An answer that is not an array at all (a bare `'spends'`, a
    // number, `null`) is not a set of claims we can read, so it lands as `[]`
    // — unclassified — rather than being coerced into one.
    //
    // WHY A FILTER AND NOT A CAST, spelled out because a cast would compile
    // and look tidier: `row.effect as CapabilityEffect[]` would put whatever
    // an alternate policy impl invented straight onto a security surface,
    // where the renderer would skip it silently and the row would understate
    // its own reach. The type has to be EARNED here, once, at the boundary.
    //
    // Survives the clause-fence demotion above for the same reason
    // `conditional` does: losing OUR SENTENCE when `capability` fences to
    // nothing does not unspend the money or un-happen the outward action —
    // the row still describes a real call with real declared effects, it has
    // just lost the words we had for it. Not gated on `described`.
    effect: toWireEffects(row.effect),
    mechanicalLabel: described ? null : mechanicalLabel,
    theirDescription: described
      ? null
      : fenceLine(row.theirDescription, RAIL_DESCRIPTION_MAX_CHARS),
    theirName: null,
  };
}

/**
 * The activity hook's answer → the wire line, or `null`.
 *
 * Everything is re-checked. `phrase` is fenced; a counter is kept only when it
 * describes a real position in a real set (two integers, a positive total, and
 * `done` inside it), because a counter is the one thing on this surface a
 * reader will take as arithmetic; and `startedAt` must parse, since the UI
 * renders elapsed time from it and `Invalid Date` renders as "NaN min ago".
 */
export function toRailActivity(raw: AgentActivityGetOutput['activity']): RailActivity | null {
  if (raw === null || typeof raw !== 'object') return null;
  const phrase = fenceLine(
    typeof raw.phrase === 'string' ? raw.phrase : null,
    RAIL_LABEL_MAX_CHARS,
  );
  const startedAt = isoOrNull(raw.startedAt);
  if (phrase === null || startedAt === null) return null;
  const stale = raw.stale === true;
  return {
    phrase,
    // Staleness drops the counter. @ax/agent-activity already does this; we do
    // it again because "the phrase is no longer a claim about the present" and
    // "29 of 41 is still true" cannot both hold, and this is the last chance.
    counter: stale ? null : toRailCounter(raw.counter),
    startedAt,
    stale,
    source:
      raw.source === 'declared' || raw.source === 'tool' || raw.source === 'trigger'
        ? raw.source
        : 'trigger',
  };
}

function toRailCounter(raw: unknown): RailActivity['counter'] {
  if (raw === null || typeof raw !== 'object') return null;
  const { done, total, unit } = raw as Record<string, unknown>;
  if (!Number.isInteger(done) || !Number.isInteger(total)) return null;
  const d = done as number;
  const t = total as number;
  if (t <= 0 || d < 0 || d > t) return null;
  const fenced = fenceLine(typeof unit === 'string' ? unit : null, RAIL_LABEL_MAX_CHARS);
  if (fenced === null) return null;
  return { done: d, total: t, unit: fenced };
}

/** A parseable instant as ISO, or `null`. Never `Invalid Date` on the wire. */
function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/**
 * One row per thing granted.
 *
 * A host can legitimately appear twice — once as a site grant, once as a
 * skill's approved `host` capability — and two identical-looking rows with two
 * different Revoke buttons is a surface that cannot be acted on. First wins,
 * and site grants are collected first because that is the record the Settings
 * "Allowed sites" panel already lets a person manage.
 */
function dedupeGrants(rows: readonly GrantRow[]): GrantRow[] {
  const seen = new Set<string>();
  const out: GrantRow[] = [];
  for (const row of rows) {
    const key = `${row.action}\u0000${row.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * A `GrantRef` off the wire, or `null`.
 *
 * Strict on purpose: this object decides what gets deleted. Every field is
 * checked, the kind is checked against the closed list, and "exactly one
 * subject" is enforced rather than assumed — a ref carrying both a skill and a
 * connection would revoke against whichever branch happened to be read first.
 */
export function readGrantRef(raw: unknown): GrantRef | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.grant === 'site') {
    return typeof r.host === 'string' && r.host.length > 0
      ? { grant: 'site', host: r.host }
      : null;
  }
  if (r.grant !== 'approved-capability') return null;
  const kind = r.capKind;
  if (typeof kind !== 'string' || !APPROVED_CAP_KINDS.includes(kind as ApprovedCapKind)) {
    return null;
  }
  if (typeof r.value !== 'string' || r.value.length === 0) return null;
  const skillId = typeof r.skillId === 'string' && r.skillId.length > 0 ? r.skillId : null;
  const connectorId =
    typeof r.connectorId === 'string' && r.connectorId.length > 0 ? r.connectorId : null;
  if ((skillId === null) === (connectorId === null)) return null;
  return {
    grant: 'approved-capability',
    capKind: kind as ApprovedCapKind,
    value: r.value,
    skillId,
    connectorId,
  };
}
