import { useEffect } from 'react';
import {
  hydrateSidebarCollapsed,
  setSidebarCollapsed,
} from './lib/sidebar-collapse';

export const App = () => {
  useEffect(() => {
    // Apply persisted sidebar state before first paint of any subscriber.
    hydrateSidebarCollapsed();

    // ⌘\ (or Ctrl+\) toggles the sidebar. Read the current snapshot from
    // the body class so we don't need a parallel React-state copy.
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        const collapsed = document.body.classList.contains('sidebar-collapsed');
        setSidebarCollapsed(!collapsed);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return <div>boot</div>;
};
