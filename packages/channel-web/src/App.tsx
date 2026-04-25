import { useEffect } from 'react';
import { useAgentStore } from './lib/agent-store';
import { sessionStoreActions } from './lib/session-store';
import {
  hydrateSidebarCollapsed,
  setSidebarCollapsed,
} from './lib/sidebar-collapse';

export const App = () => {
  // Subscribe so the ⌘N handler picks up agent changes without remounting
  // the listener on every keystroke. The component re-renders, the listener
  // is re-bound, and the closed-over snapshot stays current.
  const { agents, selectedAgentId, pendingAgentId } = useAgentStore();

  useEffect(() => {
    // Apply persisted sidebar state before first paint of any subscriber.
    hydrateSidebarCollapsed();

    // Global keyboard shortcuts:
    //  - ⌘\ (or Ctrl+\) toggles the sidebar.
    //  - ⌘N (or Ctrl+N) creates a new session for the active agent.
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        const collapsed = document.body.classList.contains('sidebar-collapsed');
        setSidebarCollapsed(!collapsed);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
        const activeAgentId =
          pendingAgentId ?? selectedAgentId ?? agents[0]?.id ?? null;
        if (!activeAgentId) return;
        e.preventDefault();
        void sessionStoreActions.createAndActivate(activeAgentId).catch((err) => {
          console.warn('[app] ⌘N create failed', err);
        });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [agents, selectedAgentId, pendingAgentId]);

  return <div>boot</div>;
};
