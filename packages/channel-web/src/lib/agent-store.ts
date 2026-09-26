/**
 * Agent store — process-local singleton for agent-list state.
 *
 * Lives outside React because more than one subtree needs to read the same
 * agent list and react to its changes. `useSyncExternalStore` keeps the React
 * subscription model honest without pulling in a state-management dep.
 *
 * `selectedAgentId` and `pendingAgentId` are read here but no longer written
 * by anything but `setSelectedAgent` (which always clears `pendingAgentId`).
 * The deferred-switch flow that used to set `pendingAgentId` directly
 * (`pickAgent`, keyed off an active chat session's message count) belonged to
 * the deleted chat UI and went with it — TASK-360.
 */
import { useSyncExternalStore } from 'react';
import type { Agent } from '../../mock/agents';

export type AgentsStatus = 'loading' | 'ready' | 'error';

export interface AgentStoreState {
  agents: Agent[];
  /** Tri-state load signal for the agent list (drives the first-run gate). */
  agentsStatus: AgentsStatus;
  /** The agent the user explicitly picked (rendered in the chip). */
  selectedAgentId: string | null;
  /**
   * Left over from the deleted chat UI's deferred-agent-switch flow
   * (TASK-360 removed the only code that ever set this to non-null).
   * Nothing writes it any more; `App.tsx` still reads it. See the module
   * docblock.
   */
  pendingAgentId: string | null;
}

const initialState: AgentStoreState = {
  agents: [],
  agentsStatus: 'loading',
  selectedAgentId: null,
  pendingAgentId: null,
};

const listeners = new Set<() => void>();
let state: AgentStoreState = initialState;

const getSnapshot = (): AgentStoreState => state;

/** Test-only snapshot getter for the module singleton. */
export const getAgentStoreSnapshot = (): AgentStoreState => state;

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
    set({ agents, agentsStatus: 'ready' });
  },

  /** Mark the agent-list load as failed (transient fetch/parse error). */
  setAgentsError: (): void => {
    set({ agentsStatus: 'error' });
  },

  /** Test-only: restore the module singleton to its initial state. */
  resetForTest: (): void => {
    set({ ...initialState });
  },

  /** Explicit user pick (also clears any stale pending switch). */
  setSelectedAgent: (id: string | null): void => {
    set({ selectedAgentId: id, pendingAgentId: null });
  },
};
