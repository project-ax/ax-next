/**
 * GET  /api/features                   — public feature-flag echo
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
 * PUT  /api/workspace/agents/:agentId/memory/rules
 *                                      — save the human-owned memory tier
 * GET  /api/workspace/decisions        — THE Today queue (one collection)
 * POST /api/workspace/decisions/:decisionId/approve
 * POST /api/workspace/decisions/:decisionId/dismiss
 * POST /api/workspace/decisions/:decisionId/undo
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
 * Agent `state` is likewise derived, never guessed: `working` iff one of the
 * agent's conversations holds a live session (`session:is-alive` says so),
 * otherwise `resting`. Without the liveness probe everything reads `resting`,
 * because "we don't know" must never render as "it's busy".
 *
 * Security posture (matches routes-connections.ts):
 *   - identity is ALWAYS the authenticated user (auth:require-user → 401).
 *     `userId` is never read from the body, query, or params.
 *   - every per-agent read is gated by `agents:resolve`; any PluginError → 404
 *     (not 403 — we don't tell a foreign caller whether an id exists).
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
 * The Today queue is the same story and the same rule: `GET
 * /api/workspace/decisions` is its one producer. The in-thread approval card
 * on `GET /api/workspace/agents/:agentId` is a POINTER — a `decisionId` and
 * nothing else — so the row a person reads in the thread is the row the queue
 * shows rather than a second copy of it that can disagree.
 *
 * The `/api/workspace/*` routes only mount when the preview flag is on
 * (capability minimization, invariant #5). `/api/features` always mounts and
 * needs no auth — it echoes a build-time flag and nothing else, exactly like
 * `GET /api/branding`.
 */
import {
  PluginError,
  isRejection,
  makeAgentContext,
  type AgentContext,
  type HookBus,
} from '@ax/core';
import type {
  ActivityEvent,
  AgentRunState,
  Decision,
  DecisionStatus,
  ExecutionPath,
  MemoryDoc,
  PastConversation,
  PermissionRow,
  ThreadMessage,
  WorkspaceAgent,
} from '../lib/workspace-types.js';
import { isOpenDecision } from '../lib/workspace-types.js';
import { listTeamIdsForUser, type RouteRequest, type RouteResponse } from './routes-chat.js';
import { workspaceFilePath } from './safe-path.js';

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
interface AgentsResolveOutput {
  agent: { id: string; displayName: string };
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

/** Content blocks, narrowed to the two things this surface cares about. */
type TurnBlock = { type: string; text?: string };
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
interface ConversationsGetOutput {
  conversation: ConversationRow;
  turns: TurnRow[];
}

interface SessionIsAliveInput {
  sessionId: string;
}
interface SessionIsAliveOutput {
  alive: boolean;
}

/**
 * The subset of @ax/routines' `FireRow` this surface reads.
 *
 * `firedAt` is typed `Date | string` on purpose. In-process the hook hands back
 * real `Date` instances; anything that carries this over a wire hands back an
 * ISO string. Accepting both here is cheaper than making every future
 * transport pretend to be the in-process one.
 *
 * `id` is present in the payload and is DELIBERATELY not read: it is a
 * `BIGSERIAL`, storage vocabulary that leaked into a hook payload before this
 * task existed. It is not rendered, and it is not the pagination cursor.
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
 * @ax/memory-strata's Memory-tab hooks (AW-13). Duck-typed like every other
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
interface MemoryLearnedReadOutput {
  docs: Array<{ name: string; body: string }>;
}

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
}

interface DecisionsListInput {
  userId: string;
  agentId?: string;
  status?: DecisionStatus;
}
interface DecisionsListOutput {
  decisions: StoredDecision[];
}

interface DecisionsGetInput {
  decisionId: string;
  userId: string;
}
interface DecisionsGetOutput {
  decision: StoredDecision | null;
}

interface DecisionsResolveInput {
  decisionId: string;
  userId: string;
}
interface DecisionsApproveOutput {
  decision: StoredDecision | null;
  executed: boolean;
  path: ExecutionPath | null;
  error: string | null;
  pendingUntil: string | null;
}
interface DecisionsDismissOutput {
  decision: StoredDecision | null;
}
interface DecisionsUndoOutput {
  decision: StoredDecision | null;
  undone: boolean;
}

// --- wire shapes ----------------------------------------------------------

/** `GET /api/features` — the flag echo the SPA reads before it renders. */
export interface FeaturesResponse {
  agentWorkspacePreview: boolean;
}

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
 * `POST /api/workspace/decisions/:decisionId/approve`.
 *
 * Everything past `decision` is the plugin's answer about what actually
 * happened, passed straight through: `executed` is only ever true when a host
 * executor returned, and `pendingUntil` is non-null only for an irreversible
 * call whose execution was deferred until the undo window closes.
 */
export interface ApproveResponse {
  decision: Decision;
  executed: boolean;
  path: ExecutionPath | null;
  /**
   * The host executor's sanitised failure detail — AUDIT-TRAIL data, not a
   * receipt. The renderer shows the AUTHORED failure line and this decision's
   * id; it never shows this string, because a host tool's message can quote
   * model-authored input back at us.
   */
  error: string | null;
  pendingUntil: string | null;
}

export interface DismissResponse {
  decision: Decision;
}

export interface UndoResponse {
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
  /** Empty until the policy rail is real (AW-14). The UI renders its own empty state. */
  permissions: PermissionRow[];
  /**
   * The conversation `thread` was read from: the agent's current one, or the
   * one named by `?conversationId=`. `null` when the agent has never had a
   * conversation, or when the current one vanished between the list and the
   * read (a benign race — see `agentDetail`).
   */
  conversationId: string | null;
  /** Reconstructed from that conversation's turns. */
  thread: ThreadMessage[];
  /** Older conversations, newest first, excluding the current one. */
  past: PastConversation[];
  /**
   * The Memory tab, split by WHO OWNS IT (AW-13).
   *
   * The `rules` doc is ALWAYS present, even when the user has written nothing:
   * it is the editor, and an editor that only appears once you have already
   * typed in it is not an editor. The `learned` docs are whatever the agent
   * has actually written — an absent one is omitted rather than shipped as an
   * empty heading.
   */
  memory: MemoryDoc[];
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
 * The subject line is a LABEL — one truncating row in the DOM — so it gets the
 * same 60 the rest of the workspace gives a label. The second line is a
 * recorded error, which is a sentence and legitimately longer, so it gets more
 * room; it is still bounded, because "however long the agent felt like" is not
 * a size.
 */
export const ACTIVITY_LABEL_MAX_CHARS = 60;
export const ACTIVITY_DETAIL_MAX_CHARS = 200;

/**
 * Characters that rewrite the surface rather than appear on it: C0/C1 controls,
 * the zero-width family, and the bidi marks, embeddings, overrides and isolates.
 *
 * The bidi half is the Trojan-source problem (CVE-2021-42574) pointed at a feed
 * row. A lone U+202E reverses the visual order of everything after it, so a
 * routine name authored with one in front of `"gnp.dorp-eteled"` renders as a
 * completely different filename; an unterminated isolate leaks that reordering
 * into whatever the renderer draws next, which here is the row's own timestamp
 * and the row below it. React escapes markup, so this was never XSS — it is the
 * quieter failure where the feed says, in our voice, something other than what
 * is on the wire.
 *
 * They become spaces rather than vanishing, so a name that leaned on one to
 * separate two words still reads as two words.
 */
const REWRITES_THE_SURFACE =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/g;

/**
 * One line, plain text, bounded — or `null` when nothing legible survives.
 *
 * A routine's `name` is authored in a file in the agent's own workspace and
 * validated only for non-emptiness, so it is untrusted text arriving from
 * across a trust boundary; the recorded `error` on a fire is the same. This is
 * the trust boundary — fencing here bounds what goes on the wire, not just what
 * a particular renderer happens to do with it.
 *
 * Deliberately a local twin of `@ax/agent-activity`'s `fencePhrase` rather than
 * an import: plugins talk through the hook bus, never through each other's
 * modules (invariant 2).
 *
 * The cap counts CODE POINTS, not UTF-16 units, so truncation can never split a
 * surrogate pair and leave a lone half behind — ill-formed UTF-16 out of a
 * function whose whole job is "plain text" would be a poor joke.
 */
function fenceLine(value: string | null | undefined, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const flattened = value.replace(REWRITES_THE_SURFACE, ' ').replace(/\s+/g, ' ').trim();
  if (flattened.length === 0) return null;
  const points = [...flattened];
  if (points.length <= maxChars) return flattened;
  return `${points.slice(0, maxChars - 1).join('').trimEnd()}\u2026`;
}

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
 * `replayedAt` would be a second copy of the decision machine built by
 * accident, and those two fields would have to cross the wire to make it
 * possible.
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
    // `replayDueAt` renamed. The plugin's replay queue is the plugin's
    // business; what a reader needs to know is when the thing they approved
    // will actually happen (invariant 1).
    pendingUntil: stored.replayDueAt,
    /*
      Can this still be taken back?

      Only while the call has NOT been made. `consumedAt` records the agent
      taking the standing authorisation up at the pre-call gate; `replayedAt`
      records the host performing the call itself. Either one means something
      went out, and undo does not un-send an email — so the affordance is not
      offered at all rather than offered and refused.

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
      stored.replayedAt === null,
  };
}

/**
 * How much of a filename this surface will carry as a LABEL. Longer than a
 * feed row's 60 because a path is legitimately `notes/2026/q3-summary.md` and
 * chopping it at 60 turns two distinct files into the same row.
 */
export const FILE_LABEL_MAX_CHARS = 120;

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
const REWRITES_A_BODY =
  /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function fenceBody(text: string): string {
  return text.replace(REWRITES_A_BODY, '');
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

/** One workspace path → one row. The key raw, the label fenced. */
export function toFileSummary(path: string): WorkspaceFileSummary {
  return {
    path,
    name: fenceLine(path, FILE_LABEL_MAX_CHARS) ?? UNREADABLE_FILE_NAME,
  };
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
 * `nameByPath` supplies the routine's AUTHORED name. When a routine has been
 * deleted its fires survive it, so the path is the fallback: it is the truest
 * thing still known about that row, and it is not a guess at what the routine
 * used to be called.
 */
export function fireToActivityEvent(
  fire: FireRow,
  nameByPath: ReadonlyMap<string, string>,
): ActivityEvent | null {
  if (fire.status === 'silenced') return null;
  const stamp = fireStamp(fire.firedAt);
  if (Number.isNaN(stamp)) return null; // An undateable row cannot be filed.
  const at = new Date(stamp).toISOString();
  // Both the authored name and the path are the agent's own words, so both go
  // through the fence. A name fenced down to nothing falls through to the path
  // exactly as an absent one does, and a row whose every candidate label is
  // unprintable still gets a row — dropping it would claim the agent did
  // nothing, which is the bigger lie.
  const text =
    fenceLine(nameByPath.get(fire.path), ACTIVITY_LABEL_MAX_CHARS) ??
    fenceLine(fire.path, ACTIVITY_LABEL_MAX_CHARS) ??
    'A routine with no readable name';
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
    // Decision receipts join this collection with `decisions:executed`, which
    // has not shipped. Nothing here comes from a decision yet.
    decisionId: null,
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
 * A short, plain relative date — "today", "3 days ago". Deliberately coarse:
 * the past-conversation rows are for orientation, not for forensics, and an
 * exact timestamp there reads like it means something it doesn't.
 */
export function relativeDay(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'a while ago';
  const startOfDay = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return 'over a year ago';
}

/**
 * A short wall-clock time for a message bubble. Formatted by hand rather than
 * via `toLocaleTimeString` so the output is the same shape everywhere the host
 * runs (the ICU data available to Node varies by build).
 */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h24 = d.getHours();
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, '0')} ${suffix}`;
}

/**
 * The renderable text of a turn: its `text` blocks and nothing else.
 *
 * Thinking blocks are the model's scratchpad and never cross this wire. Tool
 * blocks belong to the tool view AW-10 owns; surfacing a raw tool_use here
 * would be a second, worse rendering of the same thing.
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

/** Turns → thread messages. Turns with nothing to show are dropped, not blanked. */
function buildThread(turns: TurnRow[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const turn of turns) {
    if (turn.role === 'tool') continue; // AW-10 owns the tool view.
    const text = renderableText(turn.contentBlocks ?? []);
    if (text.length === 0) continue; // An empty bubble is worse than no bubble.
    if (turn.role === 'user') {
      out.push({ kind: 'user', id: turn.turnId, text });
    } else {
      out.push({
        kind: 'agent',
        id: turn.turnId,
        text,
        time: shortTime(turn.createdAt),
      });
    }
  }
  return out;
}

export interface WorkspaceHandlerDeps {
  bus: HookBus;
  initCtx: AgentContext;
  /**
   * Echoed by `GET /api/features`. The route-mounting decision lives in
   * `registerWorkspaceRoutes`; the handler only needs it to tell the truth.
   */
  agentWorkspacePreview?: boolean;
}

export function makeWorkspaceHandlers(deps: WorkspaceHandlerDeps) {
  const { bus, initCtx } = deps;
  const agentWorkspacePreview = deps.agentWorkspacePreview === true;

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
   * `working` iff one of these conversations holds a session the session
   * backend still calls alive. Absence of the probe means we don't know, and
   * "don't know" renders as `resting` — never as a guess that it's busy.
   */
  async function deriveState(rows: ConversationRow[]): Promise<AgentRunState> {
    if (!bus.hasService('session:is-alive')) return 'resting';
    const candidates = rows
      .map((c) => c.activeSessionId)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (candidates.length === 0) return 'resting';
    try {
      const probes = await Promise.all(
        candidates.map((sessionId) =>
          bus.call<SessionIsAliveInput, SessionIsAliveOutput>(
            'session:is-alive',
            initCtx,
            { sessionId },
          ),
        ),
      );
      return probes.some((p) => p.alive) ? 'working' : 'resting';
    } catch (err) {
      initCtx.logger.warn('workspace_session_liveness_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 'resting';
    }
  }

  /**
   * The roster row. Everything past `state` is null because nothing produces
   * it yet — see the file header. A null renders as the state word alone.
   */
  function toWorkspaceAgent(
    agent: { id: string; displayName: string },
    state: AgentRunState,
  ): WorkspaceAgent {
    return {
      id: agent.id,
      name: agent.displayName,
      state,
      now: null,
      counter: null,
      startedAt: null,
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
   * `memory:rules:write` reaches `workspace:apply`, which routes by
   * `(userId, agentId)` — hand it the wrong ctx and the write lands in another
   * agent's workspace. Constructing it HERE, from the authenticated caller and
   * the agent they just passed the ACL for, is what keeps that honest; reusing
   * `initCtx` (agentId `@ax/channel-web`, userId `system`) would not.
   *
   * The workspace root is inherited from `initCtx` so the CLI preset — which
   * has no workspace backend and writes memory to the host filesystem — lands
   * in the same root everything else in that preset uses.
   */
  function agentWorkspaceCtx(agentId: string, ownerUserId: string): AgentContext {
    return makeAgentContext({
      sessionId: 'workspace-surface',
      agentId,
      userId: ownerUserId,
      workspace: initCtx.workspace,
    });
  }

  /**
   * The Memory tab's rows.
   *
   * A FAILED rules read omits the rules row entirely rather than shipping an
   * empty one. This is the difference between "you have written no rules" and
   * "we could not read your rules", and getting it wrong is destructive: an
   * empty editor over unreadable storage invites the user to type something,
   * press Save, and overwrite rules they still have. The UI renders the
   * missing row as "we are not showing the editor right now", not as a blank
   * box. Same discipline the rest of this surface uses — a zero is a claim.
   *
   * A failed LEARNED read is different: it drops those rows, because the worst
   * it can cost is a section that says the agent has written nothing yet.
   */
  async function readMemory(agentId: string, userId: string): Promise<MemoryDoc[]> {
    if (!bus.hasService('memory:rules:read')) return [];
    const ctx = agentWorkspaceCtx(agentId, userId);
    let rules: string | null = null;
    try {
      const out = await bus.call<MemoryAgentInput, MemoryRulesReadOutput>(
        'memory:rules:read',
        ctx,
        { agentId },
      );
      rules = out.body;
    } catch (err) {
      initCtx.logger.warn('workspace_memory_rules_read_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    let learned: MemoryLearnedReadOutput['docs'] = [];
    if (bus.hasService('memory:learned:read')) {
      try {
        learned = (
          await bus.call<MemoryAgentInput, MemoryLearnedReadOutput>(
            'memory:learned:read',
            ctx,
            { agentId },
          )
        ).docs;
      } catch (err) {
        initCtx.logger.warn('workspace_memory_learned_read_failed', {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return [
      { name: RULES_DOC_NAME, scope: 'rules', body: rules },
      // Model output. It rides as a plain string and React renders it as text.
      ...learned.map((d): MemoryDoc => ({ name: d.name, scope: 'learned', body: d.body })),
    ];
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
   */
  async function approvalMessages(
    userId: string,
    agentId: string,
    conversationId: string,
  ): Promise<ThreadMessage[]> {
    if (!bus.hasService('decisions:list')) return [];
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
      return (out.decisions ?? [])
        .filter((d) => d.conversationId === conversationId && isOpenDecision(d))
        .sort((a, b) => stamp(a.createdAt) - stamp(b.createdAt))
        .map((d) => ({ kind: 'approval', id: `decision-${d.id}`, decisionId: d.id }));
    } catch (err) {
      initCtx.logger.warn('workspace_thread_decisions_failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  return {
    /**
     * GET /api/features — a public echo of a build-time flag.
     *
     * No auth: it discloses nothing about the caller or the workspace, and the
     * SPA needs it before it knows whether anyone is signed in. Same posture as
     * `GET /api/branding`.
     */
    async features(_req: RouteRequest, res: RouteResponse): Promise<void> {
      res.status(200).json({ agentWorkspacePreview } satisfies FeaturesResponse);
    },

    /** GET /api/workspace/state */
    async state(req: RouteRequest, res: RouteResponse): Promise<void> {
      const userId = await authOr401(bus, initCtx, req, res);
      if (userId === null) return;

      const agents = await listAgents(userId);
      // Without the liveness probe every answer is `resting` anyway, so don't
      // pay for N conversation listings to arrive at a foregone conclusion.
      const canProbe = bus.hasService('session:is-alive');
      const rows = await Promise.all(
        agents.map(async (a) => {
          if (!canProbe) return toWorkspaceAgent(a, 'resting');
          const convs = await listConversations(userId, a.id);
          return toWorkspaceAgent(a, await deriveState(convs));
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

      const out = await bus.call<DecisionsResolveInput, DecisionsApproveOutput>(
        'decisions:approve',
        initCtx,
        { decisionId: stored.id, userId },
      );
      const decision = resolvedOrGone(out.decision, res);
      if (decision === null) return;
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
      res.status(200).json({ decision, undone: out.undone } satisfies UndoResponse);
    },

    /**
     * GET /api/workspace/activity — the one event feed.
     *
     * `?agentid=` scopes it to a single agent (the "What it did" tab);
     * unscoped it merges the whole roster (the Activity page). `?before=` is
     * the pagination cursor and it is an INSTANT, never a row id.
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

      const slices = await Promise.all(
        targets.map(async (a) => {
          const fires = await firesForAgent(a.id, limit, before, strict);
          if (fires.length === 0) return { fires, names: new Map<string, string>() };
          return { fires, names: await routineNames(a.id) };
        }),
      );

      // Merge, newest first. Undateable rows sort last and are dropped by the
      // mapper; they are not silently filed under "now".
      const merged = slices
        .flatMap((s) => s.fires.map((f) => ({ fire: f, names: s.names })))
        .sort((x, y) => sortableStamp(y.fire.firedAt) - sortableStamp(x.fire.firedAt))
        .slice(0, limit);

      const events: ActivityEvent[] = [];
      for (const m of merged) {
        const ev = fireToActivityEvent(m.fire, m.names);
        if (ev !== null) events.push(ev);
      }

      /*
        The cursor is the last fire we CONSIDERED. See `ActivityResponse`: a
        page of all-silenced fires renders nothing, and a cursor taken from the
        last visible row would strand the reader on it.

        `null` when this page did not fill: every agent handed back everything
        it had, so there is nothing older to ask for.

        The cursor is EXCLUSIVE (`fired_at < before`), so two fires sharing a
        millisecond exactly across a page boundary would cost the second one.
        Fires are seconds-apart events written by a tick loop; a shared
        millisecond is not a case we have, and the alternative — an inclusive
        cursor — repeats a row on every single page turn, which a reader
        actually notices.
      */
      const filled = merged.length === limit;
      const last = merged.at(-1);
      const lastStamp = last === undefined ? NaN : fireStamp(last.fire.firedAt);
      const nextBefore =
        filled && !Number.isNaN(lastStamp) ? new Date(lastStamp).toISOString() : null;

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
        title: c.title ?? 'Untitled conversation',
        meta: relativeDay(c.lastActivityAt ?? c.createdAt),
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
          thread = buildThread(got.turns ?? []);
          threadConversationId = got.conversation.conversationId;
        }
      }

      /*
        The still-open decisions raised in THIS conversation, as cards at the
        end of the thread. They go last because that is where they happened:
        the agent got as far as an outward action and stopped to ask.

        There is deliberately no decision payload on this response. The client
        already has every row from GET /api/workspace/decisions, and a second
        copy travelling on a second route is precisely the two-producers bug
        this task exists to avoid.
      */
      if (threadConversationId !== null) {
        thread = [
          ...thread,
          ...(await approvalMessages(userId, agentId, threadConversationId)),
        ];
      }

      res.status(200).json({
        agent: toWorkspaceAgent(agent, await deriveState(convs)),
        // Empty until the policy rail can GENERATE these sentences from the
        // enforced rules (AW-14). A hand-written permission sentence that
        // drifts from what the agent may actually do is the worst bug this
        // surface could ship, so we ship none.
        permissions: [],
        conversationId: threadConversationId,
        thread,
        past,
        memory: await readMemory(agentId, userId),
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
     * NOTE ON ISOLATION. The `git-protocol` workspace backend shards by
     * (userId, agentId), so this listing is genuinely one agent's tree. The
     * `local` single-repo backend — the CLI and the chart's default — ignores
     * ctx entirely and keeps ONE tree for the whole deployment; there, this
     * lists that shared tree, exactly as the identity editor and the routines
     * list already read it. That is a property of the backend, not something
     * this route can filter its way out of: a shared tree has no per-agent
     * prefix to scope by. It is called out here rather than left for someone
     * to discover, and a per-agent `local` backend is the fix.
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
        throw err;
      }

      res.status(200).json({ saved: true, body: stored } satisfies SaveRulesResult);
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
 * `/api/features` always mounts — it is how the SPA learns whether the rest of
 * this surface exists. Every `/api/workspace/*` route mounts ONLY when the
 * preview flag is on: an unmounted route is the cheapest possible capability
 * minimization (invariant #5), and a 404 is an honest answer for a surface the
 * deployment hasn't enabled.
 */
export async function registerWorkspaceRoutes(
  bus: HookBus,
  initCtx: AgentContext,
  opts: { agentWorkspacePreview: boolean },
): Promise<Array<() => void>> {
  const handlers = makeWorkspaceHandlers({
    bus,
    initCtx,
    agentWorkspacePreview: opts.agentWorkspacePreview,
  });
  // Same duck-typed cast as routes-attachments.ts — http-server's HttpRequest /
  // HttpResponse are a structural superset of our adapter.
  type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;
  const routes: Array<{
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    handler: RouteHandler;
  }> = [
    {
      method: 'GET',
      path: '/api/features',
      handler: handlers.features as unknown as RouteHandler,
    },
  ];
  if (opts.agentWorkspacePreview) {
    routes.push(
      {
        method: 'GET',
        path: '/api/workspace/state',
        handler: handlers.state as unknown as RouteHandler,
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
        method: 'PUT',
        path: '/api/workspace/agents/:agentId/memory/rules',
        handler: handlers.saveRules as unknown as RouteHandler,
      },
      {
        method: 'GET',
        path: '/api/workspace/decisions',
        handler: handlers.decisions as unknown as RouteHandler,
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
        method: 'POST',
        path: '/api/workspace/route',
        handler: handlers.route as unknown as RouteHandler,
      },
    );
  }

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
