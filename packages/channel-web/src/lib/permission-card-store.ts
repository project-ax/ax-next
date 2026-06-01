/**
 * Permission-card store — holds the single pending JIT approval card.
 *
 * The transport routes a `permissionRequest` SSE frame here (design §11.3);
 * `<PermissionCard>` reads it. Lives outside the chat timeline — nothing here
 * is persisted to history, and it never holds a secret (the key the user types
 * stays in the card component's local state and posts straight to the
 * credential store). Same `useSyncExternalStore` shape as agent-status-store.
 */
import { useSyncExternalStore } from 'react';

/**
 * Discriminated union on `kind` — mirrors the server `PermissionRequest`
 * (src/server/types.ts) and the SSE frame's inner object:
 *
 * - `kind: 'skill'` — the JIT bundled approval card (TASK-35): skill id, hosts,
 *   credential slot names; `authored` flags an agent-written skill (TASK-39).
 *   Never a secret.
 * - `kind: 'host'` — the reactive egress-wall card (TASK-37): the single host a
 *   blocked egress tried to reach + the opaque sessionId the browser echoes on
 *   grant. Never a secret.
 * - `kind: 'connector'` — the upfront authored-CONNECTOR approval card (TASK-94
 *   host / TASK-112 UI): a connectorId + display name + the reach (hosts / slots /
 *   packages) the connector declares. NO `description` — a connector carries a
 *   `name`, not a skill description. Approving it grants the connector under the
 *   TASK-93 wall with a connectorId subject. Never a secret.
 */
export type PermissionRequest =
  | {
      kind: 'skill';
      skillId: string;
      description: string;
      hosts: string[];
      slots: {
        slot: string;
        kind: 'api-key';
        /** JIT P2 — service slug; when set, the key binds the shared vault entry. */
        account?: string;
        /** TASK-124 — resolved vault-key tags the write path uses (service = account
         *  else connector id; slotTag present only for a multi-slot per-slot ref). */
        service?: string;
        slotTag?: string;
        /** JIT P2 — the user already has the matching ref; card shows "use existing". */
        haveExisting?: boolean;
      }[];
      /** TASK-39: open-mode banner — the agent just wrote this skill. */
      authored?: boolean;
      /** npm/pypi packages the skill declares; shown as an informational registry line. */
      packages?: { npm: string[]; pypi: string[] };
    }
  | { kind: 'host'; host: string; sessionId: string }
  | {
      kind: 'connector';
      connectorId: string;
      name: string;
      hosts: string[];
      slots: {
        slot: string;
        kind: 'api-key';
        /** service slug; when set, the key binds the shared `account:<service>` vault. */
        account?: string;
        /** TASK-124 — resolved vault-key tags the write path uses (service = account
         *  else connector id; slotTag present only for a multi-slot per-slot ref). */
        service?: string;
        slotTag?: string;
        /** the user already has the matching ref; card shows "use existing". */
        haveExisting?: boolean;
      }[];
      /** Open-mode banner — the agent just authored this connector (TASK-94 fires true). */
      authored?: boolean;
      /** npm/pypi packages the connector declares; shown as an informational line. */
      packages?: { npm: string[]; pypi: string[] };
    };

export interface PermissionCardState {
  request: PermissionRequest | null;
}

const initial: PermissionCardState = { request: null };

let state: PermissionCardState = initial;
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = (): PermissionCardState => state;

const notify = (): void => {
  for (const l of listeners) l();
};

const set = (next: PermissionCardState): void => {
  state = next;
  notify();
};

export function usePermissionCardStore(): PermissionCardState {
  return useSyncExternalStore(subscribe, getSnapshot, () => initial);
}

/** Read the current state without subscribing. Use inside effects/tests. */
export const getPermissionCardSnapshot = (): PermissionCardState => state;

export const permissionCardActions = {
  /**
   * Surface a pending card. A new request replaces any prior one — EXCEPT a
   * reactive `host` egress-wall must not clobber a showing upfront `connector`
   * connect card (TASK-113).
   *
   * On a warm turn the upfront connector card and a same-turn reactive egress
   * wall both fire; this single-slot store's blind last-write-wins showed the
   * wall ("npm 403") instead of the actionable "Connect <service>" card. The
   * connector card is the root cause (the wall is downstream of the same
   * missing connector), so the connector card WINS: a `host` frame arriving
   * while a `connector` card is up is dropped. A `connector` frame still
   * replaces anything (connector wins both directions), and every other
   * transition replaces as before.
   */
  show(request: PermissionRequest): void {
    if (request.kind === 'host' && state.request?.kind === 'connector') {
      return; // keep the upfront connector connect card; ignore the reactive wall
    }
    set({ request });
  },
  /** Clear the card (Connect-complete or Not-now). */
  dismiss(): void {
    set({ request: null });
  },
  /** Test seam — reset between tests. */
  reset(): void {
    set(initial);
  },
  /** Test seam — subscribe without React. */
  subscribeForTest(cb: () => void): () => void {
    return subscribe(cb);
  },
};
