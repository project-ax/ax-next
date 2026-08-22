/**
 * GET  /api/features                   — public feature-flag echo
 * GET  /api/workspace/state            — the roster + (eventually) the queue
 * GET  /api/workspace/agents/:agentId  — one agent's detail panel
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
 *   - `decisions` / `activity` — empty until @ax/decisions (AW-10 / AW-11).
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
 * The three `/api/workspace/*` routes only mount when the preview flag is on
 * (capability minimization, invariant #5). `/api/features` always mounts and
 * needs no auth — it echoes a build-time flag and nothing else, exactly like
 * `GET /api/branding`.
 */
import { PluginError, isRejection, type AgentContext, type HookBus } from '@ax/core';
import type {
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

// --- wire shapes ----------------------------------------------------------

/** `GET /api/features` — the flag echo the SPA reads before it renders. */
export interface FeaturesResponse {
  agentWorkspacePreview: boolean;
}

/** `GET /api/workspace/state` — the roster plus two honest empties. */
export interface WorkspaceStateResponse {
  agents: WorkspaceAgent[];
  /** Empty until @ax/decisions lands (AW-10 / AW-11). */
  decisions: never[];
  /** Empty until the receipts feed lands (AW-11). */
  activity: never[];
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
  /** The agent's current conversation, or null when it has none yet. */
  conversationId: string | null;
  /** Reconstructed from the current conversation's turns. */
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

  /** Every conversation the caller owns under one agent, newest first. */
  async function listConversations(
    userId: string,
    agentId: string,
  ): Promise<ConversationRow[]> {
    if (!bus.hasService('conversations:list')) return [];
    try {
      const rows = await bus.call<ConversationsListInput, ConversationsListOutput>(
        'conversations:list',
        initCtx,
        { userId, agentId },
      );
      return [...rows].sort(byRecencyDesc);
    } catch (err) {
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
        // Honest empties. @ax/decisions (AW-10) fills the queue; the receipts
        // feed (AW-11) fills the activity rail. A fixture here would be
        // indistinguishable from a real decision, which is the one thing this
        // surface can never afford.
        decisions: [],
        activity: [],
      } satisfies WorkspaceStateResponse);
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

      const convs = await listConversations(userId, agentId);
      const current = convs[0] ?? null;
      const past: PastConversation[] = convs.slice(1).map((c) => ({
        id: c.conversationId,
        title: c.title ?? 'Untitled conversation',
        meta: relativeDay(c.lastActivityAt ?? c.createdAt),
        // Compaction's fold count has no reader-facing source yet — the rung-3
        // summarizer rewrites the transcript rather than recording how many
        // turns it swallowed. 0 is the truth we can defend today.
        folded: 0,
        // The excerpt is loaded on demand when a row is expanded; shipping
        // every past transcript in the roster response would be a big payload
        // nobody asked for.
        msgs: [],
      }));

      let thread: ThreadMessage[] = [];
      if (current !== null) {
        const got = await bus.call<ConversationsGetInput, ConversationsGetOutput>(
          'conversations:get',
          initCtx,
          { conversationId: current.conversationId, userId },
        );
        // conversations:get is the authority on ownership. If it disagrees with
        // the list we just read, something drifted — refuse rather than render
        // one agent's transcript under another agent's name.
        if (got.conversation.agentId !== agentId || got.conversation.userId !== userId) {
          res.status(404).json({ error: 'agent-not-found' });
          return;
        }
        thread = buildThread(got.turns ?? []);
      }

      res.status(200).json({
        agent: toWorkspaceAgent(agent, await deriveState(convs)),
        // Empty until the policy rail can GENERATE these sentences from the
        // enforced rules (AW-14). A hand-written permission sentence that
        // drifts from what the agent may actually do is the worst bug this
        // surface could ship, so we ship none.
        permissions: [],
        conversationId: current === null ? null : current.conversationId,
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

      // Most recently active wins. An agent with no conversations sorts last
      // (stamp 0), and ties break on displayName so the same input always
      // produces the same answer.
      const scored = await Promise.all(
        agents.map(async (a) => {
          const convs = await listConversations(userId, a.id);
          const latest = convs.reduce(
            (max, c) => Math.max(max, activityStamp(c)),
            0,
          );
          return { agent: a, latest };
        }),
      );
      scored.sort(
        (x, y) =>
          y.latest - x.latest || x.agent.displayName.localeCompare(y.agent.displayName),
      );
      const pick = scored[0]!.agent;
      res.status(200).json({
        agentId: pick.id,
        agentName: pick.displayName,
        why: 'it is the agent you used most recently',
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
