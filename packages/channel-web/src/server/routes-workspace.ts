/**
 * GET  /api/features                   — public feature-flag echo
 * GET  /api/workspace/state            — the roster + (eventually) the queue
 * GET  /api/workspace/agents/:agentId  — one agent's detail panel
 *        ?conversationId=<id> reads that conversation instead of the current
 *        one (the rail's read-only past-conversation view)
 * GET  /api/workspace/activity         — THE event feed (one collection)
 *        ?agentId=<id> scopes it to one agent; ?before=<ISO>&limit=<n> page it
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
 *   - `decisions`              — empty until @ax/decisions (AW-11).
 *   - `permissions`            — empty until the policy rail is real (AW-14).
 *   - `files` / `memory`       — empty until AW-12 / AW-13.
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
 * The four `/api/workspace/*` routes only mount when the preview flag is on
 * (capability minimization, invariant #5). `/api/features` always mounts and
 * needs no auth — it echoes a build-time flag and nothing else, exactly like
 * `GET /api/branding`.
 */
import { PluginError, isRejection, type AgentContext, type HookBus } from '@ax/core';
import type {
  ActivityEvent,
  AgentRunState,
  MemoryDoc,
  PastConversation,
  PermissionRow,
  ThreadMessage,
  WorkspaceAgent,
  WorkspaceFile,
} from '../lib/workspace-types.js';
import { listTeamIdsForUser, type RouteRequest, type RouteResponse } from './routes-chat.js';

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

// --- wire shapes ----------------------------------------------------------

/** `GET /api/features` — the flag echo the SPA reads before it renders. */
export interface FeaturesResponse {
  agentWorkspacePreview: boolean;
}

/**
 * `GET /api/workspace/state` — the roster plus one honest empty.
 *
 * There is no `activity` here. The feed has exactly ONE producer,
 * `GET /api/workspace/activity`, because two fields over one collection is the
 * invariant-4 violation this task exists to remove — and because a sub-array of
 * a state blob cannot be paginated, which the feed has to be.
 */
export interface WorkspaceStateResponse {
  agents: WorkspaceAgent[];
  /** Empty until @ax/decisions lands (AW-11). */
  decisions: never[];
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
  /** Empty until AW-12. */
  files: WorkspaceFile[];
  /** Empty until AW-13. */
  memory: MemoryDoc[];
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
  const text = nameByPath.get(fire.path) ?? fire.path;
  return {
    // Composite, and stable across pages. Never the fire's BIGSERIAL id.
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
          // something went wrong with nothing at all underneath it.
          (fire.error !== null && fire.error.trim().length > 0
            ? fire.error
            : 'It failed, and no reason was recorded.')
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

      res.status(200).json({
        agents: rows,
        // An honest empty. @ax/decisions (AW-11) fills the queue; a fixture
        // here would be indistinguishable from a real decision, which is the
        // one thing this surface can never afford. The activity feed used to
        // sit beside this as a second empty array — it now has a real producer
        // of its own at GET /api/workspace/activity, and one collection gets
        // one producer.
        decisions: [],
      } satisfies WorkspaceStateResponse);
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
        files: [], // AW-12
        memory: [], // AW-13
      } satisfies AgentDetail);
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
 * this surface exists. The `/api/workspace/*` routes mount ONLY when the
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
  const routes: Array<{ method: 'GET' | 'POST'; path: string; handler: RouteHandler }> = [
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
