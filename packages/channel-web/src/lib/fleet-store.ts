/**
 * Fleet store — process-local singleton for the Fleet surface.
 *
 * Mirrors `agent-store`'s `useSyncExternalStore` shape (no state-management dep).
 * Holds the agent list, the UI filter/search, and which agent's detail sheet is
 * open. A small "live tick" nudges working agents' progress and rotates their
 * phase label so the prototype visibly breathes — standing in for the real
 * `GET /api/fleet/stream` SSE feed (status transitions + coarse phase, never
 * token deltas). The tick only runs while a component is subscribed.
 */
import { useSyncExternalStore } from 'react';
import { seedFleet, STATUS_ORDER, type FleetAgent, type FleetStatus } from './fleet-data';

export type FleetFilter = 'all' | 'interactive' | 'worker' | 'mine';

export interface FleetState {
  agents: FleetAgent[];
  filter: FleetFilter;
  query: string;
  /** Agent whose detail sheet is open, or null. */
  detailAgentId: string | null;
}

const initialState: FleetState = {
  agents: seedFleet(),
  filter: 'all',
  query: '',
  detailAgentId: null,
};

const listeners = new Set<() => void>();
let state: FleetState = initialState;

const getSnapshot = (): FleetState => state;
const set = (next: Partial<FleetState>): void => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

// ── live tick ──────────────────────────────────────────────────────────────
// Stand-in for the SSE status feed. Refcounted to the subscriber set so it
// idles when the Fleet surface is closed.
const PHASES = ['thinking', 'reading files', 'editing files', 'writing tests', 'running tests'];
let timer: ReturnType<typeof setInterval> | null = null;

const tick = (): void => {
  let changed = false;
  const agents = state.agents.map((a) => {
    if (a.status !== 'working') return a;
    changed = true;
    const next = { ...a };
    // Nudge any determinate progress bar forward; loop near the top so it
    // never visually "completes" (a real turn ends on chat:end, not at 100%).
    if (typeof a.progress === 'number') {
      next.progress =
        a.progress >= 92
          ? 30 + Math.floor(Math.random() * 10)
          : a.progress + 2 + Math.floor(Math.random() * 4);
    }
    // Occasionally advance the phase label.
    if (a.phase && Math.random() < 0.25) {
      next.phase = PHASES[(PHASES.indexOf(a.phase) + 1) % PHASES.length] ?? a.phase;
    }
    return next;
  });
  if (changed) set({ agents });
};

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  if (!timer) timer = setInterval(tick, 1500);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
};

export const useFleetStore = (): FleetState =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

export const fleetStoreActions = {
  setFilter: (filter: FleetFilter): void => set({ filter }),
  setQuery: (query: string): void => set({ query }),
  openDetail: (id: string): void => set({ detailAgentId: id }),
  closeDetail: (): void => set({ detailAgentId: null }),
  /** Test-only: restore the singleton. */
  resetForTest: (): void => {
    state = { ...initialState, agents: seedFleet() };
    for (const l of listeners) l();
  },
};

/** Apply the active filter + search to the agent list (pure, for components/tests). */
export function selectVisibleAgents(s: FleetState): FleetAgent[] {
  const q = s.query.trim().toLowerCase();
  return s.agents.filter((a) => {
    if (s.filter === 'interactive' && a.kind !== 'interactive') return false;
    if (s.filter === 'worker' && a.kind !== 'worker') return false;
    if (s.filter === 'mine' && a.owner !== 'mine') return false;
    if (q && !`${a.name} ${a.activity} ${a.taskId ?? ''}`.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
}

/** Group visible agents by status in wall order (waiting → working → error → idle). */
export function groupByStatus(agents: FleetAgent[]): Array<[FleetStatus, FleetAgent[]]> {
  return STATUS_ORDER.map((status) => [status, agents.filter((a) => a.status === status)] as [
    FleetStatus,
    FleetAgent[],
  ]).filter(([, list]) => list.length > 0);
}
