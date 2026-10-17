/**
 * The person's projects, read once for the whole shell (W3a, W3 spec §4.8).
 *
 * One read, two consumers: the sidebar's recent list and the `/workspace/
 * projects` grid draw the SAME array, so creating, renaming or deleting a
 * project refreshes both at once instead of leaving one of them stale.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { userFacingMessage } from '@/lib/http';
import { workspaceApi } from '@/lib/workspace-api';
import type { ProjectSummary } from '@/wire/projects';

/** How many projects the sidebar lists before "All projects". */
export const SIDEBAR_RECENT_PROJECTS = 5;

export interface ProjectsState {
  /** `null` until the first read lands (or while it has never succeeded). */
  projects: ProjectSummary[] | null;
  /** The sentence for a failed read, or null. */
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useProjects(): ProjectsState {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Only the newest read may write: a slow first read must not land over a
  // refresh that followed a create.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await workspaceApi.listProjects();
      if (mine !== seq.current) return;
      setProjects(res.projects);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(userFacingMessage(e, 'workspace-projects'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { projects, error, loading, refresh };
}

/** Most recently updated first — the order the grid and the sidebar share. */
export function byRecent(projects: readonly ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** The description's first non-blank line, for a card. */
export function firstLine(description: string | null): string | null {
  if (description === null) return null;
  const line = description.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : line.trim();
}
