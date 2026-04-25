/**
 * Session store — process-local singleton for session list + active id.
 *
 * Why a parallel store (not folded into agent-store)? Two concerns that
 * happen to share the "active session" pointer otherwise tangle: the
 * agent chip's deferred-switch logic cares about *which* session is
 * active and whether it has messages; the sidebar list cares about the
 * full row collection plus a version counter that bumps on external
 * mutations (new session, rename, delete). Splitting keeps the bus
 * surface for each clean — there is exactly one reason to import
 * `agent-store.ts` (chip / agent-pick) and exactly one reason to import
 * `session-store.ts` (list / new-session / row mutations).
 *
 * `setActiveSession` mirrors the id + hasMessages pair into the
 * agent-store too, because the chip's deferred-switch decision needs
 * both. Both stores agreeing on `activeSessionId` is fine — the
 * "one source of truth per concept" invariant is about *persistent*
 * state, not about a local UI mirror that's always re-derived from
 * the same caller. Calling `agentStoreActions.setActiveSession` here
 * is the bridge so callers don't have to remember to update both.
 *
 * `version` is a monotonic counter bumped by `bumpVersion()` whenever
 * external state (a fresh POST, a rename, a delete) means the next
 * mount/effect should re-fetch `/api/chat/sessions`. Listeners that
 * watch the list re-run on bumps.
 */
import { useSyncExternalStore } from 'react';
import { agentStoreActions } from './agent-store';

export interface SessionRow {
  id: string;
  title: string;
  agent_id: string;
  updated_at: number;
  created_at: number;
  user_id: string;
}

export interface SessionStoreState {
  sessions: SessionRow[];
  activeSessionId: string | null;
  version: number;
}

const initialState: SessionStoreState = {
  sessions: [],
  activeSessionId: null,
  version: 0,
};

const listeners = new Set<() => void>();
let state: SessionStoreState = initialState;

const getSnapshot = (): SessionStoreState => state;

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const set = (next: Partial<SessionStoreState>): void => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

export const useSessionStore = (): SessionStoreState =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

export const sessionStoreActions = {
  setSessions: (rows: SessionRow[]): void => {
    set({ sessions: rows });
  },

  /**
   * Mark a session active. Mirrors into agent-store so the chip's
   * deferred-switch logic stays in sync.
   *
   * `hasMessages` is hard to compute from the client (the mock store
   * isn't reachable from the browser), so callers pass it explicitly.
   * Defaults to `true` because that's the *more conservative* branch:
   * picking a different agent on a non-empty session defers, which is
   * always safe; the empty-session retag path is a perf optimization.
   * If we got it wrong, the worst outcome is a stray defer.
   */
  setActiveSession: (id: string | null, hasMessages = true): void => {
    set({ activeSessionId: id });
    agentStoreActions.setActiveSession(id, hasMessages);
  },

  /** Bump version so list-watchers re-fetch on next render. */
  bumpVersion: (): void => {
    set({ version: state.version + 1 });
  },

  /**
   * POST /api/chat/sessions, then re-fetch the list, then activate the
   * new id. Returns the new session id.
   */
  createAndActivate: async (agentId: string): Promise<string> => {
    const res = await fetch('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ agentId }),
    });
    if (!res.ok) throw new Error(`session-create failed: ${res.status}`);
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new Error('session-create returned no id');
    // Fresh session: no messages yet, so retag-on-agent-switch is safe.
    sessionStoreActions.setActiveSession(body.id, false);
    sessionStoreActions.bumpVersion();
    return body.id;
  },
};
