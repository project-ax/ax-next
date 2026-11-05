import { useEffect, useState } from 'react';

const KEY = 'ax-workspace-side-panel';

/**
 * Which side-panel view was last open beside a chat, `null` for none.
 *
 * Remembered across agents and reloads on desktop, where the panel is a
 * column beside the thread. Not used below `lg`: there the panel is a sheet
 * over the thread, and one that reopens itself on every visit would be in the
 * way, not remembered.
 */
export function usePanelPreference<T extends string>(isPanel: (v: unknown) => v is T) {
  const [panel, setPanel] = useState<T | null>(() => {
    try {
      const stored = localStorage.getItem(KEY);
      return isPanel(stored) ? stored : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, panel ?? 'none');
    } catch {
      /* A blocked storage area must not stop the panel opening. */
    }
  }, [panel]);
  return [panel, setPanel] as const;
}
