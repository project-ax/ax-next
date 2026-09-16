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
 * KNOWN LIMIT, on purpose (TASK-350's scope decision). The only producer is the
 * per-turn SSE stream, and `streamReply` is opened only by `AgentView` when a
 * turn is sent. On an idle Today no stream is open, so a grant raised by an
 * agent working unattended has nothing to arrive on. Closing that needs durable
 * server-side pending-grant state and a read route; it is filed separately.
 * Until then, what this delivers is: a grant raised WHILE a turn is streaming
 * becomes answerable from Today instead of dead-ending the turn.
 *
 * Same `useSyncExternalStore` shape as `decision-raised-store.ts` /
 * `permission-card-store.ts`.
 */
import { useSyncExternalStore } from 'react';
import type { PermissionRequest } from '../server/types';

/** One open grant, plus the identity that makes it one row. */
export interface WorkspaceGrant {
  key: string;
  request: PermissionRequest;
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
  raise(request: PermissionRequest, conversationId: string | null): void {
    if (
      request.kind === 'host' &&
      state.grants.some((g) => g.request.kind === 'connector')
    ) {
      return;
    }
    const key = grantKey(request);
    const at = state.grants.findIndex((g) => g.key === key);
    if (at === -1) {
      set({ grants: [...state.grants, { key, request, conversationId }] });
      return;
    }
    // Replace in place: same row, same position, newer payload.
    const grants = state.grants.slice();
    grants[at] = { key, request, conversationId };
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
