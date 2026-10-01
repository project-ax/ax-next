import { useEffect, useState } from 'react';

/** Rail preferences are independent of the selected agent and of each other. */
export function useRailPreference(rail: 'sidebar' | 'details') {
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
