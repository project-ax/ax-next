/**
 * Session store — process-local singleton for the conversation list +
 * active conversation pointer (Task 19 retargeted this from the legacy
 * `/api/chat/sessions` mock to the new `/api/chat/conversations` wire).
 *
 * The internal field name `sessions` (and the `SessionRow` interface) is
 * kept for backward-compat with sidebar component code; the data here is
 * the chat-flow `Conversation` row from `/api/chat/conversations`. We
 * map snake_case → camelCase on fetch so the rest of the UI stays on the
 * same shape it had with the mock.
 *
 * `version` is a monotonic counter bumped by `bumpVersion()` whenever
 * external state (a fresh POST, a delete) means the next mount/effect
 * should re-fetch the list. Listeners that watch the list re-run on
 * bumps.
 */
import { useSyncExternalStore } from 'react';
import { agentStoreActions } from './agent-store';

/** UI-facing row shape — derived from a server `Conversation` record. */
export interface SessionRow {
  /** conversationId from the wire — but kept named `id` for sidebar code. */
  id: string;
  title: string;
  /** agentId from the wire — kept named `agent_id` for sidebar code. */
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

/**
 * Map a wire `Conversation` row (camelCase) to the internal SessionRow
 * shape (snake_case). Exported for the SessionList component which
 * does the fetch + setSessions.
 */
export interface WireConversation {
  conversationId: string;
  userId: string;
  agentId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export const conversationToSessionRow = (
  c: WireConversation,
): SessionRow => ({
  id: c.conversationId,
  title: c.title ?? 'New Chat',
  agent_id: c.agentId,
  user_id: c.userId,
  created_at: Date.parse(c.createdAt),
  updated_at: Date.parse(c.updatedAt),
});

export const sessionStoreActions = {
  setSessions: (rows: SessionRow[]): void => {
    set({ sessions: rows });
  },

  /**
   * Mark a conversation active. Mirrors into agent-store so the chip's
   * deferred-switch logic stays in sync.
   *
   * `hasMessages` is hard to compute from the client without a fetch;
   * defaults to `true` because that's the more conservative branch.
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
   * Mint a new local conversation row. With the AX wire, the server
   * mints the conversationId on first POST /api/chat/messages — so a
   * "new chat" click doesn't issue a network call here. We just clear
   * the active id; the next user message creates the row server-side
   * and our fetcher (the version-watcher in SessionList) will pick it
   * up on the next bump.
   */
  newLocalConversation: (): void => {
    set({ activeSessionId: null });
    agentStoreActions.setActiveSession(null, false);
    sessionStoreActions.bumpVersion();
  },

  /**
   * Legacy alias retained so callers ported from the mock-store wiring
   * (e.g. NewSessionButton) can still call createAndActivate. Today this
   * is just an alias for `newLocalConversation` — the server creates
   * the row on first message, not on a fresh-thread click.
   *
   * The agentId argument is informational; it's read off the agent-store
   * at send time.
   */
  createAndActivate: async (_agentId: string): Promise<string | null> => {
    sessionStoreActions.newLocalConversation();
    return null;
  },
};
