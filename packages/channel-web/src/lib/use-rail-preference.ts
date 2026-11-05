import { useEffect, useState } from 'react';

/** The sidebar's collapsed state. (The side panel's open view is `use-panel-preference`.) */
export function useRailPreference(rail: 'sidebar') {
  const key = `ax-workspace-${rail}-collapsed`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(collapsed));
    } catch {
      /* A blocked storage area must not stop navigation. */
    }
  }, [key, collapsed]);
  return [collapsed, setCollapsed] as const;
}
