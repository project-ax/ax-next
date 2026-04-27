/**
 * Agent store — process-local singleton for agent + active-session state.
 *
 * Lives outside React because two unrelated subtrees (sidebar chip, future
 * composer + thread view) need to read the same `pendingAgentId` flag and
 * react to its changes. `useSyncExternalStore` keeps the React subscription
 * model honest without pulling in a state-management dep.
 *
 * The deferred-switch logic (the only non-trivial bit) lives in `pickAgent`:
 *
 *   - Active session has messages → set `pendingAgentId` only. The chat
 *     view goes blank, the previous session stays in the sidebar, no
 *     network call. The next user message creates a NEW conversation
 *     under the pending agent (server-side, on POST /api/chat/messages
 *     with `conversationId: null`), then `clearPending` runs.
 *
 *   - Otherwise → just record the explicit pick. Agent immutability
 *     (Invariant I10) means we never retag an existing conversation;
 *     a fresh conversation row is born on the next POST that carries
 *     a different agentId.
 *
 * `setActiveSession` always clears `pendingAgentId` because navigating
 * away from the slot where the deferred switch was queued means the
 * intent no longer applies.
 */
import { useSyncExternalStore } from 'react';
import type { Agent } from '../../mock/agents';

export interface AgentStoreState {
  agents: Agent[];
  /** The agent the user explicitly picked (rendered in the chip). */
  selectedAgentId: string | null;
  /** Set when the user picked a new agent on a non-empty session. */
  pendingAgentId: string | null;
  activeSessionId: string | null;
  activeSessionHasMessages: boolean;
}

const initialState: AgentStoreState = {
  agents: [],
  selectedAgentId: null,
  pendingAgentId: null,
  activeSessionId: null,
  activeSessionHasMessages: false,
};

const listeners = new Set<() => void>();
let state: AgentStoreState = initialState;

const getSnapshot = (): AgentStoreState => state;

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const set = (next: Partial<AgentStoreState>): void => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

export const useAgentStore = (): AgentStoreState =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

export const agentStoreActions = {
  setAgents: (agents: Agent[]): void => {
    set({ agents });
  },

  /** Explicit user pick (also clears any stale pending switch). */
  setSelectedAgent: (id: string | null): void => {
    set({ selectedAgentId: id, pendingAgentId: null });
  },

  /**
   * Pick an agent from the menu. Three branches:
   *
   *   - Active conversation has messages → defer (set `pendingAgentId`
   *     only). The chip reflects the new agent immediately; the next
   *     user message creates a fresh conversation under it server-side.
   *
   *   - Empty active conversation OR no active conversation → just
   *     record the pick. Agent immutability (Invariant I10) means we
   *     never retag an existing conversation; the AX wire creates a new
   *     conversation row whenever the next POST carries a different
   *     agentId for a `null` conversationId.
   *
   * @param id    the agent the user clicked
   * @param opts  caller-supplied snapshot of the active session — passed
   *              in (not read off `state`) so the caller controls whether
   *              an in-flight session counts as "active" for this pick.
   */
  pickAgent: async (
    id: string,
    opts: { activeSessionId: string | null; hasMessages: boolean },
  ): Promise<void> => {
    if (opts.hasMessages) {
      // Defer — chip + thread go blank but no new session yet.
      // Note: we do NOT update `selectedAgentId` here. The chip displays
      // `pendingAgentId ?? selectedAgentId`, so the new agent shows up
      // immediately, and if the user navigates away (clearing pending)
      // the chip falls back to their last *committed* pick.
      set({ pendingAgentId: id });
      return;
    }
    // No active session: just record the pick.
    set({ selectedAgentId: id, pendingAgentId: null });
  },

  clearPending: (): void => {
    set({ pendingAgentId: null });
  },

  /**
   * Update which session is active. Always clears `pendingAgentId` —
   * navigating to a different session means the deferred switch from
   * the previous session no longer applies.
   */
  setActiveSession: (id: string | null, hasMessages: boolean): void => {
    set({
      activeSessionId: id,
      activeSessionHasMessages: hasMessages,
      pendingAgentId: null,
    });
  },
};
