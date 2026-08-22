/**
 * Agent-workspace — HTTP client.
 *
 * This layer used to talk to a mock backend that lived in `mock/workspace.ts`.
 * That mock is gone and `/api/workspace/*` is now served by the real host, so
 * what is left here is exactly the set of calls something actually answers:
 * `board()`, `agent(id)`, `route()`, plus the two shipped chat calls.
 *
 * WHAT WAS DELETED, AND WHY IT IS NOT COMING BACK AS A STUB
 *
 * `approve` / `dismiss` / `undo` / `pause` / `restart` /
 * `stopAll` / `setScenario` / `createAgent` (and the `ApproveResponse` shape,
 * and `DemoScenario` with `BoardState.scenario` / `BoardState.stoppedAll`) all
 * pointed at mock routes that no longer exist. A client method calling a route
 * nobody serves is the half-wired trap the repo's Half-Wired Code Policy
 * forbids: it reads as a working feature and fails at runtime. They come back
 * with the substrate that serves them:
 *
 *   - AW-14 — the rail: `rail()` and `revokeGrant()` below are served by
 *     `GET /api/workspace/agents/:id/rail` and its sibling POST.
 *   - AW-11 — the decisions queue: BACK, and real. `decisions()`,
 *     `approveDecision`, `dismissDecision`, `undoDecision` below are served by
 *     `@ax/decisions` through the four `/api/workspace/decisions*` routes.
 *   - AW-12 — the halted/paused agent state and its files: `pause`, `restart`.
 *
 * `saveMemory` came back with AW-13, as `saveRules` — a narrower name, because
 * only ONE of the two things the Memory tab shows is writable by a person. The
 * agent's own working notes are not, and a method that could write either would
 * be the first step back toward the editor that promised more than the storage
 * keeps.
 *
 * `stopAll` / `setScenario` / `createAgent` were demo-strip and prototype
 * plumbing. They are not planned; the create flow already ships elsewhere.
 *
 * SENDING A MESSAGE IS NOT A WORKSPACE ROUTE. It goes to the shipped
 * `POST /api/chat/messages` + `GET /api/chat/stream/:reqId`, because a second
 * route in front of the chat POST would be a second source of truth for
 * starting a turn (invariant 4).
 */
import type { PostMessageResponse } from '@/wire/chat';
import type {
  ActivityEvent,
  AgentRailData,
  CounterRow,
  RailReadStatus,
  Decision,
  GrantRef,
  GrantRow,
  MemoryDoc,
  PastConversation,
  PermissionRow,
  RailActivity,
  ThreadMessage,
  WorkspaceAgent,
  WorkspaceFileBody,
  WorkspaceFileSummary,
} from '@/lib/workspace-types';

export type {
  ActivityEvent,
  AgentRailData,
  CounterRow,
  RailReadStatus,
  Decision,
  GrantRef,
  GrantRow,
  MemoryDoc,
  PastConversation,
  PermissionRow,
  RailActivity,
  ThreadMessage,
  WorkspaceAgent,
  WorkspaceFileBody,
  WorkspaceFileSummary,
};

/**
 * `GET /api/workspace/state` — the roster, and only the roster.
 *
 * There is no `decisions` here. The queue has exactly ONE producer,
 * `GET /api/workspace/decisions`, for the same reason the activity feed got its
 * own route in AW-10: two fields over one collection is invariant 4 violated in
 * the BFF, and they drift the moment one of them grows a filter.
 */
export interface BoardState {
  agents: WorkspaceAgent[];
}

/** `GET /api/workspace/decisions` — everything still waiting on this person. */
export interface DecisionsPage {
  decisions: Decision[];
}

/**
 * `POST /api/workspace/decisions/:id/approve`.
 *
 * `decision` is the row as the server now has it, and it is the ONLY thing the
 * client applies — the machine that produced it lives in `@ax/decisions` and has
 * no second copy here.
 */
export interface ApproveResult {
  decision: Decision | null;
  /**
   * Whether the HOST actually ran the call as part of this approval. `false`
   * whenever something else will run it, or nothing will: an attended agent
   * re-issuing its own call, a sandbox-only tool the host cannot reach, an
   * irreversible call deferred behind the undo window, or a click on a row that
   * was already resolved. Never `true` unless a host executor returned.
   */
  executed: boolean;
  /** Which side runs it, or `null` when nothing runs at all. */
  path: 'agent-executes' | 'host-replays' | null;
  /**
   * The host executor's failure detail, sanitised. AUDIT DATA, NOT A RECEIPT —
   * the row shows an authored failure line, never this string, because a host
   * tool's error message can quote model-authored input straight back at us.
   */
  error: string | null;
  /** When a deferred action will actually happen. Non-null only on that path. */
  pendingUntil: string | null;
}

export interface DismissResult {
  decision: Decision | null;
}

export interface UndoResult {
  decision: Decision | null;
  /**
   * `false` with a row attached is a REFUSAL, not a failure: the call had
   * already been made and there is nothing left to take back. The surface says
   * so rather than leaving a button that looks broken.
   */
  undone: boolean;
}

/**
 * `GET /api/workspace/decisions/:decisionId` — one row, read back.
 *
 * The queue still has exactly ONE producer — `decisions()` above, the list —
 * and this is not a second one. It exists because that list answers with
 * still-OPEN rows only: a decision that just resolved (approved, dismissed)
 * drops out of it immediately. A resolved row can stay on screen for a few
 * seconds afterward — the undo affordance's countdown lives there — and while
 * it does, the only way to find out the SERVER's current answer for that one
 * row (has the call since been consumed or replayed, closing the undo window
 * early) is to ask for it by id. Same projection (`toWireDecision`) as every
 * other decision response; this is a re-read of one row already in the queue,
 * not a new view onto it.
 */
export interface DecisionRead {
  decision: Decision;
}

/** One page of the activity collection — see `workspaceApi.activity`. */
export interface ActivityPage {
  events: ActivityEvent[];
  /** Pass back as `before` to fetch the next page. `null` = nothing older. */
  nextBefore: string | null;
}

/** One listing of an agent's files — see `workspaceApi.files`. */
export interface AgentFilesPage {
  files: WorkspaceFileSummary[];
  /** `true` when the agent has more files than one response will carry. */
  truncated: boolean;
}

export interface ActivityQuery {
  /** Scope to one agent's rows. Omitted = every agent. */
  agentId?: string;
  /** ISO instant — fetch rows older than this. Omitted = the newest page. */
  before?: string;
  limit?: number;
}

export interface AgentDetail {
  agent: WorkspaceAgent;
  /**
   * The conversation `thread` was read from — the agent's current one, or the
   * past one asked for by `agent(id, conversationId)`. `null` when the agent
   * has never had a conversation, or when the current one was deleted between
   * the list and the read.
   */
  conversationId: string | null;
  /** Reconstructed from the real turns of that conversation. */
  thread: ThreadMessage[];
  /** Older conversations, newest first. Pointers only — see `PastConversation`. */
  past: PastConversation[];
  /**
   * The Memory tab, split by owner. The `rules` doc is always present — it is
   * the editor — and the `learned` docs are whatever the agent actually wrote.
   */
  memory: MemoryDoc[];
}

/** CSRF: the host's guard accepts the literal `ax-admin` (see @ax/http-server). */
const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
};

/**
 * A failed workspace call, carrying the status.
 *
 * The Files tab is why this exists. "We could not read this agent's
 * workspace" and "no workspace backend is running in this deployment" are
 * different sentences to a reader, and only the status tells them apart — a
 * surface that renders both as one generic blip is a surface that sends
 * someone hunting for a file that was never going to be there.
 *
 * `message` keeps the old text verbatim, so every existing `e.message` call
 * site reads exactly as it did before.
 */
export class WorkspaceApiError extends Error {
  readonly status: number;
  constructor(path: string, status: number) {
    super(`workspace ${path} → ${status}`);
    this.name = 'WorkspaceApiError';
    this.status = status;
  }
}

/**
 * A 200 whose BODY is not the shape we asked for.
 *
 * Separate from `WorkspaceApiError` because it means something different to
 * whoever is debugging it: the route answered, so this is a shape problem — a
 * proxy in front of it, a host at a different version, a body we cannot parse —
 * rather than an unreachable server. Callers treat it as a failed READ either
 * way, which is the point: what must never happen is a malformed body being
 * mistaken for an empty collection.
 */
export class WorkspaceShapeError extends Error {
  constructor(path: string) {
    super(`workspace ${path} → 200 with a body we could not read`);
    this.name = 'WorkspaceShapeError';
  }
}

/**
 * Guard the two decision READS at the boundary they share.
 *
 * Both of them feed `useDecisionQueue`, and both feed it code that dereferences
 * the result during React's RENDER phase — `watchedKey` calls `.filter` on the
 * list, `applyPolledRow` reads `row.id` inside a `setDecisions` updater. So a
 * malformed body did not degrade, it threw out of a hook, and there is no
 * ErrorBoundary in this SPA: the whole chat surface unmounts. That was
 * survivable while only the flag-gated `/workspace` mounted this. TASK-261 puts
 * it on the default `/` chat surface, for every user, on every page load.
 *
 * Checked HERE rather than in each caller so the list read and the single-row
 * re-read cannot drift — the first version of this guard covered only the list,
 * and the poll went on crashing for anyone mid-undo-window.
 */
function checkedRead<T>(path: string, body: unknown, ok: (b: unknown) => boolean): T {
  if (!ok(body)) throw new WorkspaceShapeError(path);
  return body as T;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

async function req<T>(
  path: string,
  init?: { method: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`/api/workspace${path}`, {
    method: init?.method ?? 'GET',
    credentials: 'include',
    ...(init?.method !== undefined && init.method !== 'GET'
      ? { headers: writeHeaders }
      : {}),
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!res.ok) {
    throw new WorkspaceApiError(path, res.status);
  }
  return (await res.json()) as T;
}

export interface RouteProposal {
  agentId: string;
  agentName: string;
  why: string;
  confident: boolean;
}

export interface SendMessageInput {
  agentId: string;
  /** `null` starts a new conversation — the server mints the row and the id. */
  conversationId: string | null;
  text: string;
}

export interface StreamHandlers {
  /** One text delta. Called many times; concatenate in order. */
  onText: (chunk: string) => void;
  /** The turn ended normally. */
  onDone: () => void;
  /** The turn ended badly, or the stream dropped without a terminator. */
  onError: (message: string) => void;
  /**
   * The agent stopped mid-turn to ask for something. NON-TERMINAL — the stream
   * stays open and the turn carries on parking for an answer.
   *
   * Carries the decision's id and its one-line summary, and nothing else: the
   * recorded call is model-authored and never rides this wire. The caller reads
   * the row back through `decisions()` and renders it from there, so the card in
   * the thread and the row in the queue are the same row rather than two
   * descriptions of it.
   */
  onDecisionRaised?: (raised: { decisionId: string; summary: string }) => void;
  signal?: AbortSignal;
}

/**
 * Shown when the stream ends with no `done` and no `error` — the host bounced
 * or the network dropped mid-turn. Saying nothing would leave a spinner up
 * forever, which is the one outcome worse than an error line.
 *
 * Phrased as a DETAIL, not as a sentence. The surface writes its own one-line
 * prose ("That reply didn't finish…") and renders this underneath it. It used
 * to be a full instruction — "Send it again to pick up where we left off" —
 * which the caller then concatenated into its own instruction, producing three
 * sentences about one event that told the reader twice to do a thing the UI
 * now does with a Resend button.
 */
export const WORKSPACE_STREAM_LOST =
  'the reply stream ended without finishing';

/** `POST` to a decision, with no body — the id in the path is the whole request. */
function decisionPost<T>(id: string, action: string): Promise<T> {
  return req<T>(`/decisions/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
  });
}

export const workspaceApi = {
  board: () => req<BoardState>('/state'),

  /**
   * Everything still waiting on this person, across every agent they can reach.
   *
   * Deliberately unscoped and unpaginated. The queue is a list of things a human
   * has to answer; if it is ever long enough to need a page break, the product
   * has a much bigger problem than a missing cursor.
   */
  decisions: async () => {
    const body = await req<unknown>('/decisions');
    // Every ELEMENT too, not just the array. `undoSecondsLeft(d)` and
    // `d.conversationId` are read during render, so one null row in an
    // otherwise valid page crashes the same way a missing array does.
    return checkedRead<DecisionsPage>(
      '/decisions',
      body,
      (b) => isRecord(b) && Array.isArray(b.decisions) && b.decisions.every(isRecord),
    );
  },

  approveDecision: (id: string) => decisionPost<ApproveResult>(id, 'approve'),
  dismissDecision: (id: string) => decisionPost<DismissResult>(id, 'dismiss'),
  undoDecision: (id: string) => decisionPost<UndoResult>(id, 'undo'),

  /** One row, re-read by id. See `DecisionRead` for why this exists. */
  decision: async (id: string) => {
    const path = `/decisions/${encodeURIComponent(id)}`;
    const body = await req<unknown>(path);
    /*
      The ROW has to be there, not merely the key.

      An earlier version of this let `{decision: null}` through, on the theory
      that a null row means "it's gone, which is news". It is not: `resolvedOrGone`
      on the server 404s for a missing row and says so in its own comment —
      "404, never a 200 carrying `decision: null` … the client would apply it
      over the row the person is looking at". `DecisionRead.decision` is
      non-nullable to match, so TypeScript could not have caught the null either.

      The only consumer is the undo-window poll, which hands the result straight
      to `applyPolledRow` — typed `(row: Decision)`, reading `row.id` inside a
      `setDecisions` updater. A null there throws during render, and with no
      ErrorBoundary in this SPA that unmounts the whole chat surface: exactly
      the failure this guard exists to stop, just moved one route over.
    */
    return checkedRead<DecisionRead>(
      path,
      body,
      (b) => isRecord(b) && isRecord(b.decision),
    );
  },

  /**
   * One agent's panel. `conversationId` reads one of the agent's PAST
   * conversations instead of its current one — the rail's read-only excerpt.
   * The server re-checks ownership of that id and 404s a conversation that is
   * not this agent's, so a stale id in the rail can never render someone
   * else's transcript.
   */
  agent: (id: string, conversationId?: string) =>
    req<AgentDetail>(
      `/agents/${encodeURIComponent(id)}` +
        (conversationId === undefined
          ? ''
          : `?conversationId=${encodeURIComponent(conversationId)}`),
    ),

  /**
   * What this agent has written, in the workspace it owns (AW-12).
   *
   * Its OWN request, not a field on `agent(id)`. A `files: []` inside the
   * detail response could not distinguish "has written nothing" from "we
   * could not read the workspace", and the tab has to say which.
   */
  files: (agentId: string) =>
    req<AgentFilesPage>(`/agents/${encodeURIComponent(agentId)}/files`),

  /**
   * One of those files.
   *
   * `path` is encoded WHOLE — slashes included — so the server receives one
   * splat segment and decodes it exactly once. Encoding per-segment would
   * leave real slashes on the wire, and then `a/../b` and `a%2F..%2Fb` would
   * take different code paths to the same read. One shape, one decode.
   */
  file: (agentId: string, path: string) =>
    req<WorkspaceFileBody>(
      `/agents/${encodeURIComponent(agentId)}/files/${encodeURIComponent(path)}`,
    ),

  /**
   * The right-hand rail: what it is doing, what it may do alone, what you
   * granted it, and this week's numbers (AW-14).
   *
   * A read of its own rather than a field on `agent()`, for the reason the feed
   * and the queue got their own routes: one collection, one producer. It also
   * means the security claim can be refreshed on demand — after a revoke, say —
   * without re-reading a whole conversation transcript to do it.
   */
  rail: (agentId: string) =>
    req<AgentRailData>(`/agents/${encodeURIComponent(agentId)}/rail`),

  /**
   * Take back one grant.
   *
   * `ref` is the object the rail handed out, echoed back unchanged. The client
   * never builds one and never parses a row's display text to find its target.
   *
   * `revoked: false` means the grant was already gone — a refusal, not a
   * failure, and the caller reports it as one.
   */
  revokeGrant: (agentId: string, ref: GrantRef) =>
    req<{ revoked: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/grants/revoke`,
      { method: 'POST', body: { ref } },
    ),

  /**
   * Save the human-owned memory tier (AW-13).
   *
   * Named for what it can write. The server hands the text to
   * `memory:rules:write`, the one writer of the one memory file the rollup and
   * the GC are forbidden to touch — which is what makes "your rules are kept
   * word for word" something we are allowed to say.
   */
  saveRules: (agentId: string, body: string) =>
    req<{ saved: true; body: string }>(
      `/agents/${encodeURIComponent(agentId)}/memory/rules`,
      { method: 'PUT', body: { body } },
    ),

  /**
   * Auto-routing: proposes an agent for a free-text request. Never dispatches.
   *
   * The pick is made from STRUCTURE — how many agents there are, which one was
   * used last — so this request carries no body at all: `req()` sends none for
   * `POST /route`, and `_text` is dropped on the floor. It stays in the
   * signature to keep the call site honest about what is being asked about;
   * putting the user's words on the wire for a route that would ignore them
   * buys nothing.
   */
  route: (_text: string) => req<RouteProposal>('/route', { method: 'POST' }),

  /**
   * One page of the activity collection (design §7). `agentId` scopes to one
   * agent's rows; `before` pages backward through older ones; `nextBefore` in
   * the response is `null` exactly when there is nothing older to page into.
   */
  activity: (q: ActivityQuery = {}) => {
    const params = new URLSearchParams();
    if (q.agentId !== undefined) params.set('agentId', q.agentId);
    if (q.before !== undefined) params.set('before', q.before);
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    const qs = params.toString();
    return req<ActivityPage>(`/activity${qs ? `?${qs}` : ''}`);
  },

  /**
   * Start a turn on the SHIPPED chat wire. Returns the conversation the turn
   * landed in (the server mints one when `conversationId` is null) and the
   * `reqId` to stream from.
   */
  async sendMessage({
    agentId,
    conversationId,
    text,
  }: SendMessageInput): Promise<PostMessageResponse> {
    const res = await fetch('/api/chat/messages', {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify({
        conversationId,
        agentId,
        contentBlocks: [{ type: 'text', text }],
      }),
    });
    if (!res.ok) {
      throw new Error(`send message → ${res.status}`);
    }
    const body = (await res.json()) as PostMessageResponse;
    if (!body.reqId || !body.conversationId) {
      throw new Error('send message returned a reply we could not read');
    }
    return body;
  },

  streamReply,
};

/**
 * Read one turn's SSE stream and hand the caller plain text.
 *
 * WHY A SECOND READER EXISTS. `lib/transport.ts` already parses this exact
 * wire, but every path through it emits AI-SDK `UIMessageChunk`s into a
 * `ReadableStream` controller, and the parser itself (`consumeSseAttempt`) is
 * module-private and inseparable from that emission. There is nothing to reuse
 * without either exporting a chunk-shaped API the workspace cannot consume, or
 * pulling the whole assistant-ui runtime into a surface that deliberately does
 * not mount it. So this is a small, deliberately dumb reader over the same
 * frames: text chunks, a `done` terminator, an `error` terminator, and it
 * ignores every other frame kind (thinking, tool-use, tool-result, phase,
 * permissionRequest) because this surface renders none of them yet.
 *
 * Frame shapes: `src/server/types.ts` (`SseFrame`).
 */
async function streamReply(
  reqId: string,
  { onText, onDone, onError, onDecisionRaised, signal }: StreamHandlers,
): Promise<void> {
  let res: Response;
  try {
    const init: RequestInit = {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      credentials: 'include',
    };
    if (signal) init.signal = signal;
    res = await fetch(`/api/chat/stream/${encodeURIComponent(reqId)}`, init);
  } catch (e) {
    if (signal?.aborted) return;
    onError(e instanceof Error ? e.message : WORKSPACE_STREAM_LOST);
    return;
  }
  if (!res.ok || !res.body) {
    onError(`the reply stream would not open (${res.status})`);
    return;
  }

  const reader = res.body
    .pipeThrough(
      new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>,
    )
    .getReader();
  let carry = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        // No terminator arrived — the stream dropped. Never silently finish.
        onError(WORKSPACE_STREAM_LOST);
        return;
      }
      const lines = (carry + value).split('\n');
      carry = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
        } catch {
          continue; // Malformed line — the server is the source of truth.
        }
        if (frame.done === true) {
          onDone();
          return;
        }
        if (typeof frame.error === 'string') {
          const detail =
            typeof frame.detail === 'string' ? ` ${frame.detail}` : '';
          onError(`${frame.error}${detail}`.trim());
          return;
        }
        if (frame.kind === 'text' && typeof frame.text === 'string') {
          onText(frame.text);
          continue;
        }
        /*
          A decision was raised mid-turn. Non-terminal: we keep reading, because
          on an attended conversation the agent is still parked waiting for the
          answer and the rest of the turn follows once it gets one.

          We read only the two fields the frame is documented to carry and
          ignore anything else on it. A frame missing either one is dropped
          rather than forwarded — a card with no id is a card whose buttons
          cannot do anything, which is worse than no card.
        */
        const raised = frame.decisionRaised;
        if (onDecisionRaised && raised !== null && typeof raised === 'object') {
          const { decisionId, summary } = raised as Record<string, unknown>;
          if (typeof decisionId === 'string' && typeof summary === 'string') {
            onDecisionRaised({ decisionId, summary });
          }
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    onError(e instanceof Error ? e.message : WORKSPACE_STREAM_LOST);
  } finally {
    reader.releaseLock();
  }
}
