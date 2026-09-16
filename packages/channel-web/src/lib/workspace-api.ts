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
import { attachmentRefBlock } from './attachment-upload';
import { HttpError, httpErrorMessage, httpFetch } from './http';
/*
  The Fault A reason-code → authored-label table, read rather than re-declared.
  `transport.ts` has owned it since Fault A and `turn-error.ts` already derives
  from it; a second copy here would be invariant 4 violated in the one place the
  drift is invisible, because a missing code silently becomes a raw identifier
  on screen instead of a type error.
*/
import {
  DEFAULT_TURN_ERROR,
  ERROR_LABELS,
  MAX_DETAIL_CHARS,
} from './transport';
import { readSseFrames } from './sse-frames';
// The store owns "can this build draw it?", because `grantKey` is the function
// that breaks without it. Read, not re-declared: a second copy of the same
// three kinds is a drift waiting to happen.
import { isRenderableGrant } from './workspace-grant-store';
import type { PermissionRequest, SseFrame } from '../server/types';
import type { PostMessageResponse } from '@/wire/chat';
import type {
  ActivityEvent,
  AgentRailData,
  CounterRow,
  Decision,
  GrantRef,
  GrantRow,
  MemoryDoc,
  PastConversation,
  PermissionRow,
  RailActivity,
  ThreadMessage,
  UserFileEntry,
  UserFilesAnswer,
  WorkspaceAgent,
  WorkspaceFileBody,
  WorkspaceFileSummary,
  WorkspaceReadStatus,
} from '@/lib/workspace-types';

export type {
  ActivityEvent,
  AgentRailData,
  CounterRow,
  Decision,
  GrantRef,
  GrantRow,
  MemoryDoc,
  PastConversation,
  PermissionRow,
  RailActivity,
  ThreadMessage,
  UserFileEntry,
  UserFilesAnswer,
  WorkspaceAgent,
  WorkspaceFileBody,
  WorkspaceFileSummary,
  WorkspaceReadStatus,
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
  /**
   * TASK-278 — the continuation turn's reqId, bound as the conversation's
   * live turn when the approval woke a warm agent. The open thread attaches
   * its stream consumer to it; null means no turn runs to watch (or the bind
   * did not land) and the client must open nothing. Absent on responses from
   * a host predating TASK-278 — read as null, never as an id.
   */
  streamReqId?: string | null;
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

/**
 * One pending grant as `GET /api/workspace/grants` carries it (TASK-373).
 *
 * `request` is the same `PermissionRequest` the SSE `permissionRequest` frame
 * carries — the server sends the buffered card verbatim — and
 * `conversationId` is what makes it answerable: Today can hold grants from
 * several agents, so the row records the conversation the POST will target.
 */
export interface PendingGrant {
  conversationId: string;
  /**
   * The agent that asked. Read since TASK-351: presence routes a grant back
   * into that agent's thread, which needs to know whose grant it is. Compared
   * against the open route's agent id and nothing else — never interpolated
   * into a path, and never part of the answer POST.
   */
  agentId: string;
  request: PermissionRequest;
}

/** `GET /api/workspace/grants` — everything still waiting on this person. */
export interface GrantsPage {
  grants: PendingGrant[];
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
  /**
   * How the server's approval read for this thread went.
   *
   * `failed` means the thread's approval cards are MISSING, not absent — the
   * panel must not let a shorter thread pass for "nothing is waiting on you".
   * `unavailable` means this deployment has no decisions producer, so nothing
   * could ever be waiting and the thread is complete as it stands.
   *
   * No rows here on purpose: `workspaceApi.decisions()` is the one producer,
   * and the cards in the thread render off that same array.
   */
  decisions: { status: WorkspaceReadStatus };
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
 * It is now an `HttpError` (TASK-288), which changes one thing and keeps the
 * rest: `status` is still here and every `instanceof WorkspaceApiError` still
 * narrows, but `message` is authored copy instead of `workspace /board → 401`.
 * That string was not a description of anything — it was a request path and a
 * number — and six surfaces were printing it at readers in a mono span. The
 * raw form survives as `detail`, for `console` only.
 *
 * Still its own class rather than a bare `HttpError` so `workspace-files.ts`
 * can keep saying "a 503 from THIS api means no workspace backend" without
 * that claim leaking to every other route in the app.
 */
export class WorkspaceApiError extends HttpError {
  constructor(path: string, status: number) {
    super(`workspace ${path}`, status);
    this.name = 'WorkspaceApiError';
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
  /** The request that answered badly. For LOGS — never for the message. */
  readonly path: string;
  constructor(path: string) {
    // NO PATH IN THE MESSAGE. The path for a single-row re-read is
    // `/decisions/dec_…`, i.e. an internal identifier — and `TodayView` used to
    // print this message on screen verbatim, which is how one would have got
    // there. TASK-276 replaced that with authored copy, so today this message
    // only reaches a `console.warn`; the rule stands because the decisions
    // surfaces have already demonstrated they will render a thrown message at a
    // reader, and TASK-260 spent a whole card taking `dec_` ids off the
    // surfaces people read.
    //
    // Not an injection concern — the id is server-issued, not user input. It is
    // hygiene: a person cannot act on a decision id, so it is noise at best.
    super('the server sent an answer we could not read');
    this.name = 'WorkspaceShapeError';
    this.path = path;
  }
}

/**
 * Guard the two decision READS at the boundary they share.
 *
 * Both of them feed `useDecisionQueue`, and both feed it code that dereferences
 * the result during React's RENDER phase — `watchedKey` calls `.filter` on the
 * list, `applyPolledRow` reads `row.id` inside a `setDecisions` updater. So a
 * malformed body did not degrade, it threw out of a hook — and before
 * TASK-273 there was no ErrorBoundary in this SPA, so the whole chat surface
 * unmounted. That was survivable while only the flag-gated `/workspace`
 * mounted this. TASK-261 puts it on the default `/` chat surface, for every
 * user, on every page load. (The per-surface boundaries are the backstop for
 * what this guard misses; this guard stays the primary defence.)
 *
 * Checked HERE rather than in each caller so the list read and the single-row
 * re-read cannot drift — the first version of this guard covered only the list,
 * and the poll went on crashing for anyone mid-undo-window.
 */
function checkedRead<T>(path: string, body: unknown, ok: (b: unknown) => boolean): T {
  if (!ok(body)) {
    // The path goes HERE and not into the message: this is the developer's
    // half of the split. Whoever is debugging a proxy or a version skew needs
    // to know which route answered badly; the person looking at the screen
    // does not, and their copy is an authored constant either way.
    console.warn(`[workspace] ${path} answered 200 with a body we could not read`);
    throw new WorkspaceShapeError(path);
  }
  return body as T;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

async function req<T>(
  path: string,
  init?: { method: string; body?: unknown },
): Promise<T> {
  const res = await httpFetch(`/api/workspace${path}`, {
    method: init?.method ?? 'GET',
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
  /**
   * Server-minted attachment ids from `POST /api/attachments`, in the order the
   * user picked them. Each becomes one `attachment_ref` block alongside the
   * text block — the SAME block chat's transport produces from
   * `ax://attachment/<id>`, built through the one shared `attachmentRefBlock`
   * so the two surfaces cannot drift into two spellings of one wire shape.
   * Omitted / empty = a plain text-only send, byte-identical to before.
   */
  attachmentIds?: readonly string[];
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
  /**
   * The agent hit a capability it does not have and is asking for it (TASK-350).
   *
   * NON-TERMINAL FOR THIS READER: more frames follow, and one of them is the
   * `done` that ends the turn. That is the whole of the claim, and it used to
   * say more — that the turn "is parked" and the rest of it follows once the
   * person answers, like a decision. For a `skill` or `connector` that is not
   * what happens: `request_capability` returns to the model, the model says it
   * has asked, the turn ENDS, and answering the grant retires the warm session
   * so the capability is there for the NEXT turn. Somebody has to start that
   * turn — `lib/workspace-resume.ts` (TASK-374) is who, and chat's own
   * `resumeActions` → `regenerate()` is the same admission one surface over.
   *
   * Before this existed the frame was parsed and then dropped on the floor: the
   * reader handled `done`, `error`, text and `decisionRaised`, and a
   * `permissionRequest` fell through to `continue`. The wall still held — this
   * failed CLOSED, not open — but the person was never asked, so the turn
   * dead-ended with no path forward.
   *
   * Carries the request verbatim. It is public manifest data by construction —
   * hostnames, slot NAMES, an opaque sessionId — and never a secret: a key the
   * person types posts straight to the host credential store and reaches
   * neither the model nor the transcript.
   */
  onPermissionRequest?: (request: PermissionRequest) => void;
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

  /**
   * Every pending capability grant waiting on this person (TASK-373) — the
   * read-back that lets a grant survive the stream it arrived on. The server
   * answers only the caller's own rows (scoping ran when the card was
   * buffered), so there are no parameters to pass and none to get wrong.
   *
   * Deliberately unpaginated, like `decisions()`: the set is bounded by the
   * per-conversation card cap and holds only PENDING grants.
   */
  grants: async () => {
    const body = await req<unknown>('/grants');
    // Same shape guard as the queue read, at the boundary the two share: what
    // must never happen is a malformed body being mistaken for an empty list.
    // `request`, `conversationId` and `agentId` are checked because the merge
    // in WorkspaceShell dereferences exactly those three — one wrong row there
    // throws inside the mount effect, and a throw a person cannot see or fix
    // is worse than a read that fails loudly. `agentId` joined the list when
    // TASK-351 started READING it: an `undefined` there would be typed as a
    // `string`, match no route, and silently cost the grant its thread.
    //
    // `request` is checked for its DISCRIMINANT and not merely for being an
    // object: `{}`, or a kind this build has never heard of, gets no key out of
    // `grantKey` and no fields out of `GrantRow`, and the resulting throw lands
    // in the workspace's `ErrorBoundary` — which takes every legible grant and
    // decision down with the one unreadable row. `isRenderableGrant` is the
    // store's own answer to "can we draw this?" — the discriminant, the id that
    // becomes the key, and the two collections the row ITERATES — borrowed
    // rather than copied so the wire and the store cannot drift about it.
    //
    // (The store refuses an unknown kind as well, which is what covers the SSE
    // stream — that path has no shape guard at all. Here it is a WHOLE-page
    // failure on purpose: a server answering `/grants` with a row we cannot
    // read is news about the server, and the mount path already knows how to
    // say "I could not check" without pretending the day is empty.)
    return checkedRead<GrantsPage>(
      '/grants',
      body,
      (b) =>
        isRecord(b) &&
        Array.isArray(b.grants) &&
        b.grants.every(
          (g) =>
            isRecord(g) &&
            typeof (g as { conversationId?: unknown }).conversationId === 'string' &&
            typeof (g as { agentId?: unknown }).agentId === 'string' &&
            isRenderableGrant((g as { request?: unknown }).request),
        ),
    );
  },

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
      `setDecisions` updater. A null there throws during render — before
      TASK-273's per-surface boundaries that unmounted the whole chat surface:
      exactly the failure this guard exists to stop, just moved one route over.
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
   * One path in the agent's DURABLE user-files tier — its cwd and HOME.
   *
   * A different backend from `files`/`file` above, not a different view of the
   * same one: those read the git-backed tier AX manages, this reads the tier
   * the agent actually works in. One call for both a directory listing and a
   * file body, because the server is the one that knows which a path is.
   *
   * `relPath` is encoded WHOLE — slashes included — for the same reason `file`
   * does it: the server receives one splat and decodes it exactly once.
   * Encoding per-segment would leave real slashes on the wire and let
   * `a/../b` and `a%2F..%2Fb` reach the same read down two different paths.
   */
  userFiles: (agentId: string, relPath: string) =>
    req<UserFilesAnswer>(
      `/agents/${encodeURIComponent(agentId)}/user-files` +
        (relPath === '' ? '' : `/${encodeURIComponent(relPath)}`),
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
    attachmentIds = [],
  }: SendMessageInput): Promise<PostMessageResponse> {
    const res = await httpFetch('/api/chat/messages', {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({
        conversationId,
        agentId,
        contentBlocks: [
          { type: 'text', text },
          ...attachmentIds.map((id) => attachmentRefBlock(id)),
        ],
      }),
    });
    if (!res.ok) {
      // Was `send message → ${res.status}`, which `AgentView` rendered.
      throw new HttpError('/api/chat/messages', res.status);
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
 * WHY THIS IS STILL A SEPARATE READER. It no longer parses anything. The wire
 * — `data: ` framing, the carry buffer, malformed JSON, `:` comments, and the
 * TASK-23 seq dedup + gap detection — belongs to `./sse-frames`, shared with
 * chat's `lib/transport.ts`. What is different between the two surfaces is what
 * a frame BECOMES, and that difference is deliberate: chat emits AI-SDK
 * `UIMessageChunk`s into the assistant-ui runtime, and the workspace does not
 * mount that runtime at all. So this reader turns frames into plain callbacks.
 *
 * It still renders text only, and ignores `thinking`, `tool-use`, `tool-result`
 * and `phase` — TASK-352 grows those renderers. What it no longer does is
 * ignore them because it could not see them.
 *
 * WHAT IT GAINED WITH THE SHARED READER (TASK-349): seq dedup and gap
 * detection, which this surface never had. A replayed buffer used to render its
 * tail twice here, and a bounded-buffer gap used to render a truncated answer
 * as if it were the whole thing. Both now behave the way chat has since
 * TASK-23 — a duplicate is dropped, and a gap is a visible lost-stream line
 * rather than a silently short reply.
 *
 * Frame shapes: `src/server/types.ts` (`SseFrame`).
 */
async function streamReply(
  reqId: string,
  {
    onText,
    onDone,
    onError,
    onDecisionRaised,
    onPermissionRequest,
    signal,
  }: StreamHandlers,
): Promise<void> {
  let res: Response;
  try {
    const init: RequestInit = {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    };
    if (signal) init.signal = signal;
    res = await httpFetch(`/api/chat/stream/${encodeURIComponent(reqId)}`, init);
  } catch (e) {
    if (signal?.aborted) return;
    // A network-level throw carries a browser string (`Failed to fetch`), not
    // a sentence. It goes to the console; the reader gets the authored line.
    console.warn('[workspace] reply stream could not be opened', e);
    onError(WORKSPACE_STREAM_LOST);
    return;
  }
  if (!res.ok || !res.body) {
    // The status used to be glued into this sentence — an authored line with a
    // raw number inside it, which is the shape a grep for `statusText` never
    // finds. It is a console line now, and the reader gets a whole sentence.
    console.warn(`[workspace] reply stream would not open → ${res.status}`);
    onError(httpErrorMessage(res.status));
    return;
  }

  /**
   * Set by the two terminal branches. `stopped` tells us the caller-facing
   * callback has already fired, so the end-of-read handling below must not
   * fire a second one.
   */
  let terminated = false;

  const end = await readSseFrames(res.body, (frame: SseFrame) => {
    if ('done' in frame && frame.done === true) {
      terminated = true;
      onDone();
      return 'stop';
    }
    if ('error' in frame && typeof frame.error === 'string') {
      /*
        MAP THE REASON CODE, DO NOT PRINT IT. `frame.error` is a STABLE
        REASON CODE — `dev-service-failed`, `chat-run-timeout` — and this
        used to hand it to the caller verbatim, which put an internal
        identifier on screen in the same breath as the rest of this epic
        was taking them off. `lib/transport.ts` has mapped these to authored
        labels since Fault A; reading its table rather than growing a second
        one is the difference between one source of truth and two that drift
        (invariant 4). An unknown code falls back to `DEFAULT_TURN_ERROR`,
        so a reason code can never reach a reader again.

        TASK-160 — `detail` is the OPTIONAL author-facing line beneath the
        label (a dev-service sidecar naming the service and path). Per
        `server/types.ts` it is bounded and sanitized server-side and is
        meant to be rendered; we clamp it once more and keep it as plain
        text. It is NOT plumbing and NOT the reason code — dropping it
        costs the reader the only actionable specifics they get.
      */
      const label = ERROR_LABELS[frame.error] ?? DEFAULT_TURN_ERROR;
      const detail =
        'detail' in frame && typeof frame.detail === 'string'
          ? frame.detail.slice(0, MAX_DETAIL_CHARS).trim()
          : '';
      terminated = true;
      onError(detail.length > 0 ? `${label}\n${detail}` : label);
      return 'stop';
    }
    if ('kind' in frame && frame.kind === 'text' && typeof frame.text === 'string') {
      onText(frame.text);
      return 'continue';
    }
    /*
      The agent is asking for a capability. Non-terminal in the sense that
      matters HERE — keep reading, there are more frames — and NOT for the
      reason a decision is. A decision genuinely parks the turn and the rest of
      it follows once the person answers; a `skill` or `connector` grant does
      not, and the very next frames are the agent saying it has asked and the
      `done` that ends the turn. Re-issuing it is `lib/workspace-resume.ts`
      (TASK-374). See `StreamHandlers.onPermissionRequest` above.

      Forwarded verbatim rather than reshaped — the row renders every kind
      (`skill`, `connector`, `host`), and a reader that understood one of them
      would leave the other two dead-ending, which is the bug.
    */
    if (onPermissionRequest && 'permissionRequest' in frame && frame.permissionRequest) {
      onPermissionRequest(frame.permissionRequest);
      return 'continue';
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
    if (onDecisionRaised && 'decisionRaised' in frame && frame.decisionRaised) {
      const { decisionId, summary } = frame.decisionRaised;
      if (typeof decisionId === 'string' && typeof summary === 'string') {
        onDecisionRaised({ decisionId, summary });
      }
    }
    return 'continue';
  });

  if (terminated) return;

  // Every remaining end is a stream that stopped without saying so. An abort is
  // the one that is not a failure: the caller asked for it, and firing an error
  // line at someone who navigated away is noise.
  if (signal?.aborted) return;
  if (end.reason === 'body-error') {
    console.warn('[workspace] reply stream ended badly', end.error);
  } else if (end.reason === 'gap') {
    // TASK-23 territory, newly reachable on this surface. The rest of the turn
    // is unrecoverable from here — frames this client never saw are already
    // gone from the host's bounded buffer — so the honest outcome is the
    // lost-stream line, not a short answer that looks complete.
    console.warn(`[workspace] reply stream lost frames (${end.kind})`);
  }
  onError(WORKSPACE_STREAM_LOST);
}
