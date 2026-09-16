/**
 * Open capability grants on the agent workspace (TASK-350).
 *
 * WHY A SECOND STORE AND NOT `permission-card-store`. Chat's store is a single
 * slot, because chat shows one card at a time above the composer. Today is a
 * queue: the grant lands next to the decisions, and two grants can legitimately
 * be open at once. A single slot in a queue is a dropped question.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It holds no answer state and no history. A
 * grant is either open or gone — answering removes the row, and nothing here
 * persists it. That matches what the wire gives us: the `permissionRequest`
 * frame is transient, and this store's contents live exactly as long as the
 * page does.
 *
 * TWO PRODUCERS, ONE ENTRY POINT. The per-turn SSE stream (`AgentView`) raises
 * a grant that arrives on a live turn; the mount read-back (TASK-373, `GET
 * /api/workspace/grants`) raises one that was waiting while the workspace was
 * closed. Both go through `raise`, which replaces on the subject key — a
 * second, hydrate-flavoured entry point is exactly how two rows for one grant
 * would happen. (TASK-350's header said the stream was the only producer; it
 * stopped being true when TASK-373 landed.)
 *
 * TWO READERS, ONE ROW (TASK-351). The Today queue renders every open grant;
 * an agent's thread additionally renders the ones presence routes to it — see
 * `workspace-grant-presence.ts`. Both read THIS array, so the card in the
 * thread and the row in the queue are the same object and answering either
 * resolves both. Neither reader keeps a copy.
 *
 * Same `useSyncExternalStore` shape as `decision-raised-store.ts` /
 * `permission-card-store.ts`.
 */
import { useSyncExternalStore } from 'react';
import type { PermissionRequest } from '../server/types';

/**
 * Where a grant came from — recorded by whichever producer raised it.
 *
 * Both fields are REQUIRED, and neither is optional-with-a-default, because
 * the two producers (the turn stream and the mount read-back) both genuinely
 * hold both. An optional `agentId` would default to "route it nowhere", which
 * is the safe direction but also the silent one: a third producer added later
 * would render grants that never reach a thread and nothing would say why.
 */
export interface GrantOrigin {
  /** The conversation the grant was raised on. See `WorkspaceGrant`. */
  conversationId: string | null;
  /** The agent that asked. See `WorkspaceGrant`. */
  agentId: string;
}

/** One open grant, plus the identity that makes it one row. */
export interface WorkspaceGrant {
  key: string;
  request: PermissionRequest;
  /**
   * The agent that asked.
   *
   * Recorded so PRESENCE can route the row (TASK-351): the same grant renders
   * in that agent's thread when the person is there reading it, and in the
   * Today queue always. It is compared for equality against the open route's
   * agent id and used for nothing else — in particular it never reaches the
   * answer POST, which targets `conversationId`. Where we DRAW a grant is
   * therefore not an input to what we GRANT.
   *
   * Not part of `grantKey`, deliberately: identity is the subject. Two agents
   * blocked on one connector is still one question, and keying on the pair is
   * exactly how one grant would become two rows.
   */
  agentId: string;
  /**
   * The conversation the grant was raised on.
   *
   * `PermissionRequest` does not carry one — on chat the card reads the active
   * conversation out of a store, because there is only ever one. Today can hold
   * grants from several agents at once, so the row cannot ask "which
   * conversation am I in?" and get a useful answer. It has to be recorded when
   * the frame arrives, by the only code that knows: the view streaming the turn.
   *
   * `/api/chat/permission-decision` requires it, so a `skill` or `connector`
   * grant with none cannot be answered — the row disables Connect and renders
   * `GRANT_NO_CONVERSATION` beside it, rather than posting something the server
   * must reject or leaving a dead button unexplained. A `host` grant does not
   * need it (`/api/chat/allow-host` routes on the session id).
   */
  conversationId: string | null;
}

export interface WorkspaceGrantState {
  grants: readonly WorkspaceGrant[];
}

/**
 * A grant's identity is its SUBJECT — the thing the person is being asked
 * about — not the frame that carried it. The same question arriving twice (the
 * TASK-82 buffer replays a pending card on reconnect) is one row.
 *
 * A host's key deliberately omits `sessionId`. The person is answering a
 * question about a SITE; two sessions blocked on the same host is still one
 * question. The session id still matters for the POST, which is why `raise`
 * replaces in place rather than ignoring the repeat — the newer session wins.
 *
 * The `kind` prefix keeps a skill and a connector that share a slug apart.
 */
export function grantKey(request: PermissionRequest): string {
  switch (request.kind) {
    case 'skill':
      return `skill:${request.skillId}`;
    case 'connector':
      return `connector:${request.connectorId}`;
    case 'host':
      return `host:${request.host}`;
  }
}

/** The reach a `skill` and a `connector` both declare — and both ITERATE. */
function hasIterableReach(r: Record<string, unknown>): boolean {
  return (
    Array.isArray(r.hosts) &&
    r.hosts.every((h) => typeof h === 'string') &&
    Array.isArray(r.slots) &&
    r.slots.every(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as { slot?: unknown }).slot === 'string',
    )
  );
}

/**
 * Is this something we can actually put on screen?
 *
 * `grantKey`'s switch is exhaustive over the union, which makes TypeScript
 * happy and does nothing at runtime: a request whose `kind` is none of the
 * three falls off the end and the key comes back `undefined`. That row lands in
 * the store keyed `undefined`, `GrantRow` reaches straight for fields the shape
 * has not got, and the throw lands in the workspace `ErrorBoundary` — which
 * bounds it to the whole surface, so ONE unreadable row takes every legible
 * grant and decision down with it.
 *
 * The case is not hypothetical and not only a malformed-server case: a server
 * that adds a FOURTH `PermissionRequest` kind does exactly this to every client
 * built before it. Refusing is the forward-compatible answer — this build skips
 * what it cannot render and the rest of the queue survives. The grant is not
 * lost, either: it is still open server-side, and a build that knows the kind
 * will draw it.
 *
 * WHERE THE LINE IS DRAWN, and why it is not "validate the whole type". This
 * checks the discriminant, the id that BECOMES THE KEY, and the two collections
 * `GrantRow` ITERATES (`hosts`, `slots`) — the fields whose absence throws
 * rather than merely reads oddly. `description`, `name` and `sessionId` are
 * required by the type and are NOT checked here: a missing one renders a
 * shabby row, and dropping an answerable grant over a cosmetic field would be a
 * worse trade than showing it. Being stricter than the crash surface turns a
 * blemish into a silently missing question.
 *
 * Deliberately returns `boolean` and not `request is PermissionRequest`: it
 * does not check every field of that type, and a predicate that says it did
 * would hand the next reader a guarantee this does not make.
 *
 * Both producers go through `raise`, so this one check covers the SSE stream —
 * which has no shape guard of its own — and the mount read-back alike.
 * `workspace-api.ts` ALSO calls it at the wire, where a bad row is news about
 * the server rather than about the future.
 */
export function isRenderableGrant(request: unknown): boolean {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as Record<string, unknown>;
  switch (r.kind) {
    case 'skill':
      return typeof r.skillId === 'string' && hasIterableReach(r);
    case 'connector':
      return typeof r.connectorId === 'string' && hasIterableReach(r);
    case 'host':
      return typeof r.host === 'string';
    default:
      return false;
  }
}

const initial: WorkspaceGrantState = { grants: [] };

let state: WorkspaceGrantState = initial;
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = (): WorkspaceGrantState => state;

const notify = (): void => {
  for (const l of listeners) l();
};

const set = (next: WorkspaceGrantState): void => {
  state = next;
  notify();
};

export function useWorkspaceGrants(): WorkspaceGrantState {
  return useSyncExternalStore(subscribe, getSnapshot, () => initial);
}

/** Read the current state without subscribing. Use inside effects/tests. */
export const getWorkspaceGrantSnapshot = (): WorkspaceGrantState => state;

export const workspaceGrantActions = {
  /**
   * A `permissionRequest` frame landed.
   *
   * TASK-113 — a reactive `host` egress wall is DROPPED while a `connector`
   * grant is open. On a warm turn the upfront connector card and a same-turn
   * wall both fire, and the connector card is the root cause: the wall is
   * downstream of the same missing connector. In chat's single slot the wall
   * literally hid the actionable card; in a list it would merely add a second
   * row, but a second row pointing at a cause the first row already names is
   * noise on a surface where every row is a question. Chat drops it, so this
   * drops it — one product, one answer. Connector still wins both directions,
   * and every other transition goes through.
   */
  raise(request: PermissionRequest, origin: GrantOrigin): void {
    // A kind this build cannot key or draw. Dropped, loudly enough for whoever
    // is debugging a version skew — see `isRenderableGrant`. The person sees
    // one fewer row rather than a workspace that will not render.
    if (!isRenderableGrant(request)) {
      console.warn('[workspace] a grant arrived in a kind this build cannot draw');
      return;
    }
    if (
      request.kind === 'host' &&
      state.grants.some((g) => g.request.kind === 'connector')
    ) {
      return;
    }
    const key = grantKey(request);
    const row: WorkspaceGrant = { key, request, ...origin };
    const at = state.grants.findIndex((g) => g.key === key);
    if (at === -1) {
      set({ grants: [...state.grants, row] });
      return;
    }
    // Replace in place: same row, same position, newer payload — including a
    // newer origin. The subject is the identity, so the same connector asked
    // for by a second agent updates this row rather than adding one.
    //
    // A NOTE FOR THE NEXT PRODUCER (TASK-351 review). Replacing the origin is
    // what lets presence re-route a row, and it has a cost: a re-raise by agent
    // B while the person is reading agent A's thread takes the card OUT of that
    // thread, and `GrantRow` keeps its half-typed key in local state, so the
    // typing goes with it. Unreachable today — the only live producer is the
    // stream of the agent you are looking at, and the read-back runs once at
    // mount — so this is written down rather than guarded, because the guard
    // would mean lifting per-row input state somewhere both render sites can
    // reach, which is the shared-state tangle invariant 4 is about. A producer
    // that raises grants GLOBALLY (a workspace-wide SSE feed, a poll) makes it
    // reachable and owes it a real answer. That answer is NOT keying the agent
    // into `grantKey`: identity is the subject, and keying the pair turns one
    // question into two rows on two surfaces.
    const grants = state.grants.slice();
    grants[at] = row;
    set({ grants });
  },

  /** The grant was answered (or turned down). Drop the row. */
  resolve(key: string): void {
    const next = state.grants.filter((g) => g.key !== key);
    // Skip the notify when nothing changed. This is an optimisation, not a
    // correctness guard: React keeps each row's state across a parent re-render
    // because the rows are keyed by `g.key`, so a spurious notify would NOT
    // lose a half-typed key. (An earlier version of this comment claimed it
    // would, which was wrong and would have justified the wrong fix later.)
    if (next.length === state.grants.length) return;
    set({ grants: next });
  },

  /** Back to empty. Evidence that something is waiting cannot outlive its context. */
  reset(): void {
    set(initial);
  },

  /** Test seam — reset between tests. */
  resetForTest(): void {
    state = initial;
  },

  /** Test seam — subscribe without React. */
  subscribeForTest(cb: () => void): () => void {
    return subscribe(cb);
  },
};
